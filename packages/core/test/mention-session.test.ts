/**
 * File mentions (#488, vision note 3): `@path` tokens in a sent message
 * become structured attachments on the `user_message` event, gated by
 * read-permission rules; denied files produce a visible warning event.
 * The text stays as typed — contents ride the attachments.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "../src/index";
import type { Message, Provider, StreamEvent } from "../src/types";

function captureProvider(): { users: Message[]; provider: Provider } {
  const users: Message[] = [];
  const provider: Provider = {
    name: "capture",
    async *stream(messages: Message[]): AsyncIterable<StreamEvent> {
      users.push(...messages.filter((m) => m.role === "user"));
      yield { type: "text_delta", text: "ok" } as const;
      yield { type: "finish", reason: "stop" } as const;
    },
  };
  return { users, provider };
}

describe("file mentions (#488)", () => {
  test("send with @file attaches the snapshot; the text stays as typed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-mention-session-"));
    try {
      writeFileSync(join(dir, "note.ts"), "const answer = 42;\n");
      const { users, provider } = captureProvider();
      const session = createSession({ provider, cwd: dir });
      await session.send("explain @note.ts");

      const event = session.history().find((e) => e.type === "user_message") as any;
      expect(event.text).toBe("explain @note.ts");
      expect(event.attachments).toEqual([
        { kind: "file", path: "note.ts", mime: "text/plain", content: "const answer = 42;\n", truncated: false },
      ]);

      // The provider saw the text plus one attachment text part.
      const last = users[users.length - 1]!;
      expect(last.parts).toHaveLength(2);
      expect((last.parts[1] as any).text).toContain('kind="file" path="note.ts"');
      expect((last.parts[1] as any).text).toContain("const answer = 42;");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no mentions: no attachments field, wire unchanged", async () => {
    const { users, provider } = captureProvider();
    const session = createSession({ provider });
    await session.send("plain message");
    const event = session.history().find((e) => e.type === "user_message") as any;
    expect(event.attachments).toBeUndefined();
    const last = users[users.length - 1]!;
    expect(last.parts).toHaveLength(1);
  });

  test("denied file: mention_warnings event, no attachment in the log or on the wire", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-mention-denied-"));
    try {
      writeFileSync(join(dir, "secret.env"), "hunter2");
      const { users, provider } = captureProvider();
      const session = createSession({
        provider,
        cwd: dir,
        permissions: { runtimeRules: [{ tool: "read", path: "secret.env", effect: "deny", tier: "runtime" }] },
      });
      await session.send("peek @secret.env");

      const types = session.history().map((e) => e.type);
      const warnAt = types.indexOf("mention_warnings");
      expect(warnAt).toBeGreaterThanOrEqual(0);
      expect(types[warnAt + 1]).toBe("user_message"); // warning lands right before the message
      const warn = session.history()[warnAt] as any;
      expect(warn.warnings).toEqual([{ path: "secret.env", reason: "denied by permission rule" }]);

      const event = session.history().find((e) => e.type === "user_message") as any;
      expect(event.attachments).toBeUndefined();
      const last = users[users.length - 1]!;
      expect(last.parts).toHaveLength(1);
      expect(JSON.stringify(last)).not.toContain("hunter2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("@dir attaches the listing only; attachments survive replay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-mention-dir-"));
    try {
      mkdirSync(join(dir, "lib"), { recursive: true });
      writeFileSync(join(dir, "lib", "a.ts"), "export {};");
      const { users, provider } = captureProvider();
      const session = createSession({ provider, cwd: dir });
      await session.send("map @lib");

      const event = session.history().find((e) => e.type === "user_message") as any;
      expect(event.attachments[0]).toEqual({ kind: "directory", path: "lib", listing: ["a.ts"], truncated: false });

      // Replay rebuilds the same user message parts (resume/fork inherit).
      const { replayMessages } = await import("../src/session-store");
      const messages = replayMessages(session.history());
      const rebuilt = messages.find((m) => m.role === "user" && m.parts.some((p) => (p as any).text?.includes('kind="directory"')));
      expect(rebuilt).toBeDefined();
      expect((rebuilt!.parts[1] as any).text).toContain('path="lib"');
      expect((rebuilt!.parts[1] as any).text).toContain("a.ts");
      expect(users.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("image mentions (#490, vision note 4)", () => {
  function png(): Buffer {
    const b = Buffer.alloc(40);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(10, 16);
    b.writeUInt32BE(20, 20);
    b[30] = 0x41;
    return b;
  }

  test("image-capable provider: the provider sees a typed image part; log carries base64", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-image-session-"));
    try {
      writeFileSync(join(dir, "pic.png"), png());
      const { users, provider } = captureProvider();
      const session = createSession({ provider, cwd: dir, images: { imageCapable: () => true } });
      await session.send("what is @pic.png");

      const last = users[users.length - 1]!;
      const img = last.parts.find((p) => p.kind === "image") as any;
      expect(img).toBeDefined();
      expect(img.mime).toBe("image/png");
      expect(img.base64).toBe(png().toString("base64"));
      const event = session.history().find((e) => e.type === "user_message") as any;
      expect(event.attachments[0].kind).toBe("image");
      // Replay round-trips the image bytes into the same part.
      const { replayMessages } = await import("../src/session-store");
      const rebuilt = replayMessages(session.history()).find((m) => m.role === "user")!;
      expect(rebuilt.parts.some((p) => p.kind === "image" && p.base64 === img.base64)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("non-image provider: visible warning, chip text part, never a turn error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-image-nocap-"));
    try {
      writeFileSync(join(dir, "pic.png"), png());
      const { users, provider } = captureProvider();
      const session = createSession({ provider, cwd: dir, images: { imageCapable: () => false } });
      const result = await session.send("what is @pic.png");
      expect(result.status).toBe("done");

      const warnAt = session.history().findIndex((e) => e.type === "mention_warnings");
      expect(warnAt).toBeGreaterThanOrEqual(0);
      expect((session.history()[warnAt] as any).warnings[0].reason).toContain("does not support images");

      const last = users[users.length - 1]!;
      expect(last.parts.some((p) => p.kind === "image")).toBe(false);
      expect(JSON.stringify(last)).toContain("[image: pic.png 10x20]");
      // The attachment still rides the log (TUI preview + replay for a
      // capable model), only the wire part was downgraded.
      const event = session.history().find((e) => e.type === "user_message") as any;
      expect(event.attachments[0].kind).toBe("image");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("image reads without mentions (#1727)", () => {
  for (const mode of ["vision", "text-only", "denied"] as const) {
    test(`${mode}: discovered images use tool feedback and survive replay`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "moh-image-read-"));
      try {
        const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=", "base64");
        writeFileSync(join(dir, "pixel.png"), bytes);
        const requests: Message[][] = [];
        let step = 0;
        const provider: Provider = {
          name: "capture",
          async *stream(messages) {
            requests.push(structuredClone(messages));
            if (step < 2) {
              const call = step++ === 0
                ? { callId: "list", name: "glob", args: { pattern: "*.png" } }
                : { callId: "view", name: "read", args: { path: "pixel.png" } };
              yield { type: "tool_calls", calls: [call] };
              yield { type: "finish", reason: "tool_calls" };
            } else {
              yield { type: "text_delta", text: "done" };
              yield { type: "finish", reason: "stop" };
            }
          },
        };
        const { builtinTools } = await import("../src/builtin-tools");
        const { replayMessages } = await import("../src/session-store");
        const session = createSession({
          provider, cwd: dir, tools: builtinTools(), images: { imageCapable: mode !== "text-only" },
          ...(mode === "denied" ? { permissions: { runtimeRules: [{ tool: "read", path: "pixel.png", effect: "deny" as const, tier: "runtime" as const }] } } : {}),
        });
        expect((await session.send("Analyze all images in this folder")).status).toBe("done");
        expect(requests).toHaveLength(3);
        const event = session.history().find(e => e.type === "tool_result" && e.callId === "view");
        if (event?.type !== "tool_result") throw new Error("missing read result");
        const feedback = requests.at(-1)!.flatMap(m => m.parts).find(p => p.kind === "tool_result" && p.callId === "view");
        const replayed = replayMessages(session.history()).flatMap(m => m.parts).find(p => p.kind === "tool_result" && p.callId === "view");
        // Replay currently omits errorKind; compare the image and readable
        // content contract, including denied results.
        if (feedback?.kind !== "tool_result") throw new Error("missing feedback");
        const { errorKind: _errorKind, ...content } = feedback;
        expect(replayed).toEqual(content);
        if (mode === "vision") {
          expect(event.image).toEqual({ mime: "image/png", base64: bytes.toString("base64") });
          expect(feedback).toMatchObject({ image: event.image, ok: true });
        } else {
          expect(event.image).toBeUndefined();
          expect(JSON.stringify(requests)).not.toContain(bytes.toString("base64"));
          if (mode === "denied") expect(event.ok).toBe(false);
          else expect(event.output).toContain("pixels are not visible");
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

test("#1727 generic image request delivers pixels over HTTP to compat, including replay", async () => {
  const { aiSdkStreamFor } = await import("../src/providers/ai-sdk");
  const { Endpoint } = await import("../src/route");
  const { builtinTools } = await import("../src/builtin-tools");
  const { replayMessages } = await import("../src/session-store");
  const dir = mkdtempSync(join(tmpdir(), "moh-image-http-"));
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=";
  writeFileSync(join(dir, "pixel.png"), Buffer.from(base64, "base64"));
  const requests: any[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      requests.push(await request.json());
      const call = requests.length === 1
        ? { id: "list", name: "glob", args: { pattern: "*.png" } }
        : requests.length === 2 ? { id: "view", name: "read", args: { path: "pixel.png" } } : undefined;
      const delta = call
        ? { tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] }
        : { content: "done" };
      return new Response(`data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", created: 1, model: "default", choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    const provider: Provider = {
      name: "compat/default",
      stream: aiSdkStreamFor({ endpoint: new Endpoint({ name: "compat", kind: "openai", apiKey: "test" }), modelId: "default" }, "test", { baseUrl: `http://127.0.0.1:${server.port}/v1` }),
    };
    const session = createSession({
      provider, cwd: dir, tools: builtinTools(),
      endpoints: [{ name: "compat", type: "openai-compat", capabilities: { multimodal: true } }],
    });
    expect((await session.send("Analyze all images in this folder")).status).toBe("done");
    expect(requests).toHaveLength(3);
    const images = (body: any) => body.messages.filter((m: any) => m.role === "user" && Array.isArray(m.content)).flatMap((m: any) => m.content.filter((p: any) => p.type === "image_url"));
    expect(images(requests[2])).toEqual([{ type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } }]);
    expect(requests[2].messages.find((m: any) => m.tool_call_id === "view").content).toBe("[image: pixel.png]");
    const history = session.history();
    expect(history.some(e => e.type === "tool_result" && e.callId === "view" && e.image?.base64 === base64)).toBe(true);
    const replay = replayMessages(history);
    for await (const _event of provider.stream(replay, new AbortController().signal)) { /* inspect the captured HTTP request below */ }
    expect(images(requests[3])).toEqual(images(requests[2]));
    expect(replay.flatMap(m => m.parts).filter(p => p.kind === "image")).toHaveLength(0);
  } finally {
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
