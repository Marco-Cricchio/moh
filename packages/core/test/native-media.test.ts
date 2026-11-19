import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, truncateSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleMentions, MEDIA_MENTION_CAP } from "../src/mentions";
import { inputSupportFor, imageSupportFor } from "../src/model-catalog";
import { loadMohConfig, writeMohConfig, type EndpointProfile } from "../src/config";
import { createSession } from "../src/index";
import { resolveProvider } from "../src/provider-registry";
import { replayMessages, SessionStore } from "../src/session-store";
import { createRoute, Endpoint, type RouteTarget } from "../src/route";
import { ProviderError, type Message, type StreamEvent } from "../src/types";
import { aiSdkStreamFor } from "../src/providers/ai-sdk";
import { builtinTools } from "../src/builtin-tools";

const profile: EndpointProfile = { name: "local", type: "openai-compat", defaultModel: "org/omni", capabilities: {
  inputModels: { "org/omni": { image: true, audio: true, video: true }, text: { audio: false, video: false } },
} };
const bytes = Buffer.from([0, 1, 2, 3, 4, 255]); // Transport fixtures, not inference-quality media.

describe("native media input declarations", () => {
  test("binary base64 survives credential-pattern collisions while text is still redacted", () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-media-redaction-"));
    const store = SessionStore.create(dir, dir);
    const content = `AIza${"A".repeat(35)}=`;
    try {
      store.append({ type: "session_start", schemaVersion: 2, promptVersion: "test" });
      store.append({ type: "user_message", text: content.slice(0, -1), attachments: [
        { kind: "audio", path: "voice.wav", mime: "audio/wav", content },
        { kind: "video", path: "clip.mp4", mime: "video/mp4", content },
      ] });
      const messages = replayMessages(store.load());
      expect(messages[0]?.parts[0]).toMatchObject({ kind: "text" });
      expect(JSON.stringify(messages[0]?.parts[0])).not.toContain("AIza");
      expect(messages[0]?.parts.slice(1)).toEqual([
        { kind: "audio", mime: "audio/wav", base64: content },
        { kind: "video", mime: "video/mp4", base64: content },
      ]);
    } finally { store.dispose(); rmSync(dir, { recursive: true, force: true }); }
  });
  test("persist independently, override legacy images, and do not leak across models/endpoints", () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-media-config-"));
    try {
      const file = join(dir, "moh.json");
      writeMohConfig(file, { provider: "local/org/omni", endpoints: [profile] });
      expect(loadMohConfig(file).endpoints?.[0]).toEqual(profile);
      for (const kind of ["image", "audio", "video"] as const) {
        expect(inputSupportFor(profile, "org/omni", kind)).toEqual({ supported: true, source: "model declaration" });
        expect(inputSupportFor(profile, "other", kind).supported).toBe(false);
        expect(inputSupportFor({ ...profile, capabilities: {} }, "org/omni", kind).supported).toBe(false);
      }
      expect(inputSupportFor({ ...profile, capabilities: { multimodal: true } }, "org/omni", "audio").supported).toBe(false);
      expect(inputSupportFor({ ...profile, capabilities: { imageModels: { "org/omni": true } } }, "org/omni", "video").supported).toBe(false);
      expect(imageSupportFor({ ...profile, capabilities: { imageModels: { text: true }, inputModels: { text: { image: false } } } }, "text").supported).toBe(false);
      expect(imageSupportFor({ ...profile, capabilities: { ...profile.capabilities, multimodal: false } }, "org/omni").supported).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("read permissions, supported formats, and a combined byte budget gate snapshots", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-media-files-"));
    try {
      for (const name of ["a.wav", "b.mp3", "c.mp4", "d.ogg", "e.mov"]) writeFileSync(join(dir, name), bytes);
      const result = await assembleMentions("@a.wav @b.mp3 @c.mp4 @d.ogg @e.mov", { cwd: dir, canRead: (path) => !path.endsWith("a.wav") });
      expect(result.attachments.map((a) => a.kind)).toEqual(["audio", "video"]);
      expect(result.warnings).toHaveLength(3);
      expect(result.attachments[0]).toMatchObject({ mime: "audio/mpeg", content: bytes.toString("base64") });
      truncateSync(join(dir, "c.mp4"), MEDIA_MENTION_CAP);
      const capped = await assembleMentions("@b.mp3 @c.mp4", { cwd: dir });
      expect(capped.attachments).toHaveLength(1);
      expect(capped.warnings[0]?.reason).toContain("20MB combined");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

for (const type of ["openai-compat", "mistral", "infomaniak"]) for (const reasoning of [false, true]) {
  test(`native media reaches HTTP unchanged and survives persisted replay (${type}, reasoning=${reasoning})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-media-http-"));
    const requests: any[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      requests.push(await request.json());
      const chunk = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "org/omni", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response((reasoning ? chunk({ reasoning_content: "Inspect media" }) : "") + chunk({ content: "Received" }, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    } });
    try {
      for (const name of ["voice.wav", "music.mp3", "clip.mp4"]) writeFileSync(join(dir, name), bytes);
      const endpoint: EndpointProfile = { ...profile, type, apiKey: "test", baseUrl: `http://127.0.0.1:${server.port}/v1`, capabilities: {
        ...profile.capabilities, ...(reasoning ? { thinking: { format: "openai-effort" as const, levels: ["off", "high"] } } : {}),
      } };
      const provider = resolveProvider({ provider: "local/org/omni", endpoints: [endpoint] });
      const store = SessionStore.create(dir, dir);
      const session = createSession({ provider, cwd: dir, endpoints: [endpoint], sink: (event) => { store.append(event); } });
      expect((await session.send("Analyze @voice.wav @music.mp3 @clip.mp4")).status).toBe("done");
      const parts = (body: any) => body.messages.filter((m: any) => m.role === "user").flatMap((m: any) => Array.isArray(m.content) ? m.content : []).filter((p: any) => p.type !== "text");
      expect(requests[0].stream_options).toEqual({ include_usage: true });
      expect(parts(requests[0])).toEqual([
        { type: "input_audio", input_audio: { data: bytes.toString("base64"), format: "wav" } },
        { type: "input_audio", input_audio: { data: bytes.toString("base64"), format: "mp3" } },
        { type: "video_url", video_url: { url: `data:video/mp4;base64,${bytes.toString("base64")}` } },
      ]);
      if (reasoning) expect(session.history().some((e) => e.type === "reasoning" && e.text === "Inspect media")).toBe(true);
      const log = store.file;
      store.dispose();
      for (const name of ["voice.wav", "music.mp3", "clip.mp4"]) rmSync(join(dir, name));
      const messages = replayMessages(readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)));
      expect(messages.flatMap((m) => m.parts).filter((p) => p.kind === "audio" || p.kind === "video")).toHaveLength(3);
      const events = SessionStore.open(log, { register: false }).load();
      const resumed = createSession({ provider, cwd: dir, endpoints: [endpoint], resume: { events } });
      expect((await resumed.send("Describe the original attachments again")).status).toBe("done");
      expect(parts(requests[1])).toEqual(parts(requests[0]));
    } finally { await server.stop(true); rmSync(dir, { recursive: true, force: true }); }
  });
}

describe("media-aware fallback", () => {
  const messages: Message[] = [{ role: "user", parts: [{ kind: "video", mime: "video/mp4", base64: bytes.toString("base64") }] }];
  const target = (name: string, video: boolean): RouteTarget => ({ endpoint: new Endpoint({ name, kind: "openai", apiKey: "test" }), modelId: "m", mediaInput: video ? ["video"] : [] });
  test("skips a text-only fallback without losing bytes, and announces the serving model", async () => {
    const calls: string[] = [];
    const route = createRoute({ target: target("primary", true), fallbacks: [target("text", false), target("video", true)], retries: 0,
      createStream: (t) => async function* (input) {
        calls.push(t.endpoint.name);
        expect(input).toEqual(messages);
        if (t.endpoint.name === "primary") throw new ProviderError("quota_exhausted", "empty");
        yield { type: "text_delta", text: "ok" };
        yield { type: "finish", reason: "stop" };
      },
    });
    const events: StreamEvent[] = [];
    for await (const event of route.stream(messages, new AbortController().signal)) events.push(event);
    expect(calls).toEqual(["primary", "video"]);
    expect(events).toContainEqual({ type: "fallback", from: "primary/m", to: "video/m", reason: "quota_exhausted" });
  });
  test("refuses before contacting a provider when no model declares video input", async () => {
    let called = false;
    const route = createRoute({ target: target("text", false), createStream: () => async function* () { called = true; yield { type: "finish", reason: "stop" }; } });
    await expect(async () => { for await (const _event of route.stream(messages, new AbortController().signal)) {} }).toThrow("No available route declares video input");
    expect(called).toBe(false);
  });
});

test("audio-only calls use native chat audio; video continues through tool calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "moh-media-tools-"));
  const requests: any[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as any;
    requests.push(body);
    const tool = requests.length === 2;
    const delta = tool
      ? { tool_calls: [{ index: 0, id: "read", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "note.txt" }) } }] }
      : { content: "done" };
    return new Response(`data: ${JSON.stringify({ id: "r", model: "org/omni", choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    writeFileSync(join(dir, "voice.wav"), bytes);
    writeFileSync(join(dir, "clip.mp4"), bytes);
    writeFileSync(join(dir, "note.txt"), "A short note");
    const endpoint = { ...profile, apiKey: "test", baseUrl: `http://127.0.0.1:${server.port}/v1` };
    const provider = resolveProvider({ provider: "local/org/omni", endpoints: [endpoint] });
    const session = createSession({ provider, cwd: dir, endpoints: [endpoint], tools: builtinTools() });
    expect((await session.send("Listen to @voice.wav")).status).toBe("done");
    expect(requests[0].messages.at(-1).content).toContainEqual({ type: "input_audio", input_audio: { data: bytes.toString("base64"), format: "wav" } });
    expect((await session.send("Analyze @clip.mp4 and read note.txt")).status).toBe("done");
    expect(requests).toHaveLength(3);
    expect(requests[1].tools.some((t: any) => t.function.name === "read")).toBe(true);
    expect(requests[2].messages.some((m: any) => m.role === "tool" && m.tool_call_id === "read" && m.content.includes("A short note"))).toBe(true);
    expect(requests[2].messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).some((p: any) => p.video_url?.url === `data:video/mp4;base64,${bytes.toString("base64")}`)).toBe(true);
  } finally { await server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("Google maps native audio/video to inline data and unsupported transports fail before HTTP", async () => {
  const requests: any[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests.push(await request.json());
    return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const parts: Message["parts"] = [{ kind: "audio", mime: "audio/wav", base64: bytes.toString("base64") }, { kind: "video", mime: "video/mp4", base64: bytes.toString("base64") }];
  try {
    const target: RouteTarget = { endpoint: new Endpoint({ name: "google", kind: "google" }), modelId: "gemini" };
    const stream = aiSdkStreamFor(target, "test", { baseUrl: `http://127.0.0.1:${server.port}` });
    for await (const _event of stream([{ role: "user", parts }], new AbortController().signal)) {}
    expect(requests[0].contents[0].parts).toEqual([
      { inlineData: { mimeType: "audio/wav", data: bytes.toString("base64") } },
      { inlineData: { mimeType: "video/mp4", data: bytes.toString("base64") } },
    ]);
    for (const wire of ["openai-responses", "anthropic-messages"] as const) {
      const unsupported = aiSdkStreamFor({ ...target, wire }, "test", { baseUrl: `http://127.0.0.1:${server.port}` });
      await expect(async () => { for await (const _event of unsupported([{ role: "user", parts }], new AbortController().signal)) {} }).toThrow("Native audio input is not supported");
    }
    expect(requests).toHaveLength(1);
  } finally { await server.stop(true); }
});
