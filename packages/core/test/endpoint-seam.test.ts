/**
 * Issue #1164 — T6, F3b (ADR-0068): the endpoint scope, end to end. A
 * probe extension calls a user-configured endpoint through the Route via
 * `ctx.host.modelCall`, lists its models via `ctx.host.listModels`, and
 * the log records an ordinary `model_call` marked with the extension as
 * the requester. A real OpenAI-compatible server runs locally so the
 * Route path (wire, credentials, usage) is exercised for real.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionDefinition, ExtensionHost, ExtensionSetupContext } from "@moh/extension";
import { ExtensionRuntime } from "../src/extensions";
import { scopeEffectSentence } from "../src/scope-effect";
import { isEndpointScope, checkEndpointScope, endpointEffectSentence } from "../src/endpoint-scope";
import type { AgentEvent } from "../src/types";
import { sessionFromConfig, MockProvider } from "../src";
import type { AgentSession } from "../src/session/session";

const roots: string[] = [];
const homes: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "moh-endpoint-scope-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  return root;
}

function runtime(root: string): ExtensionRuntime {
  const home = mkdtempSync(join(tmpdir(), "moh-endpoint-home-"));
  homes.push(home);
  return new ExtensionRuntime({
    mohHome: home,
    projectRoot: root,
    consent: () => true,
  });
}

// ── the local OpenAI-compatible endpoint ─────────────────────────────────

/** Streaming chat-completions + model listing over one local server. */
function startCompatServer(): { url: string; requests: { path: string; auth?: string; body?: unknown }[]; stop: () => void } {
  const requests: { path: string; auth?: string; body?: unknown }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization") ?? undefined;
      if (url.pathname.endsWith("/models")) {
        requests.push({ path: url.pathname, auth });
        return Response.json({ object: "list", data: [{ id: "m1", display_name: "Model One" }, { id: "m2" }] });
      }
      if (url.pathname.endsWith("/chat/completions")) {
        const body = (await req.json()) as { model?: string; reasoning_effort?: string; stream?: boolean };
        requests.push({ path: url.pathname, auth, body });
        const encoder = new TextEncoder();
        const chunk = (obj: unknown) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              chunk({ id: "c1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }),
            );
            controller.enqueue(
              chunk({ id: "c1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { content: `answer:${body.model}${body.reasoning_effort ? `@${body.reasoning_effort}` : ""}` }, finish_reason: null }] }),
            );
            controller.enqueue(
              chunk({ id: "c1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 7 } }),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://localhost:${server.port}/v1`, requests, stop: () => server.stop(true) };
}

/** Endpoint profiles the "moh.json" declares: two endpoints, one granted. */
function endpoints(baseUrl: string): import("../src/config").EndpointProfile[] {
  return [
    {
      name: "zen",
      type: "openai-compat",
      baseUrl,
      apiKey: "sk-test-secret",
      defaultModel: "m1",
      capabilities: { caching: false, parallelToolCalls: true, multimodal: false, thinking: { format: "openai-effort" as const, levels: ["low", "medium", "high"] as const } },
    },
    { name: "go", type: "openai-compat", baseUrl, apiKey: "sk-other-secret", defaultModel: "m2" },
  ];
}

/** A probe extension whose captured host the test drives. */
async function probe(root: string, capabilities: readonly string[]) {
  const rt = runtime(root);
  const box: { ctx: ExtensionSetupContext | null } = { ctx: null };
  await rt.register({
    name: "probe",
    version: "1",
    apiVersion: "1.15",
    capabilities: [...capabilities],
    setup: (ctx) => {
      box.ctx = ctx;
    },
  } as ExtensionDefinition);
  await rt.ready();
  return { rt, host: box.ctx!.host as ExtensionHost };
}

async function sessionWith(options: { host: ExtensionHost; rt: ExtensionRuntime; endpoints: ReturnType<typeof endpoints>; events: AgentEvent[] }) {
  const root = project();
  const assembled = sessionFromConfig({
    cwd: root,
    home: root,
    config: { endpoints: options.endpoints },
    // Turn 1: the model calls echo, whose execute drives the seam — the
    // extension's usage must land in this turn's `done` rollup.
    provider: MockProvider.scripted([
      { deltas: [], finish: "tool_calls", toolCalls: [{ callId: "c1", name: "echo", args: {} }] },
      { deltas: ["ok"], finish: "stop" },
    ]),
    overrides: {
      tools: {
        // The in-turn consumer: a tool the model calls that exercises the
        // seam mid-turn, so the `done` rollup carries the extension's usage.
        echo: {
          name: "echo",
          description: "calls the endpoint through the seam",
          inputSchema: undefined,
          execute: async () => {
            const result = await (options.host as Required<ExtensionHost>).modelCall!({
              endpoint: "zen",
              model: "m1",
              messages: [{ role: "user", content: "hi" }],
            });
            return result.ok ? `seam:${result.text}` : `seam-refused:${result.reason}`;
          },
        },
      },
      permissions: { unrestrictedTools: true },
      extensions: options.rt,
      sink: (e) => options.events.push(e),
    },
  });
  if (!("session" in assembled)) throw new Error(assembled.error.message);
  return assembled.session as unknown as AgentSession;
}

describe("endpoint scope: enforcement by absence (ADR-0068)", () => {
  test("modelCall/listModels absent without an endpoint scope; present with one", async () => {
    const plain = await probe(project(), []);
    expect((plain.host as ExtensionHost | undefined)?.modelCall).toBeUndefined();
    expect((plain.host as ExtensionHost | undefined)?.listModels).toBeUndefined();

    const granted = await probe(project(), ["endpoint:zen"]);
    expect(typeof (granted.host as Required<ExtensionHost>).modelCall).toBe("function");
    expect(typeof (granted.host as Required<ExtensionHost>).listModels).toBe("function");
  });

  test("the consent sentence names both powers and the bounded override", () => {
    expect(scopeEffectSentence("endpoint:zen")).toBe(endpointEffectSentence("zen"));
    expect(isEndpointScope("endpoint:zen")).toBe(true);
    expect(checkEndpointScope("go", ["endpoint:zen"]).ok).toBe(false);
  });

  test("a malformed endpoint scope fails loudly at load", async () => {
    const root = project();
    const events: AgentEvent[] = [];
    const rt = runtime(root);
    rt.onLoadEvent((event) => events.push(event));
    await rt.register({
      name: "bad",
      version: "1",
      apiVersion: "1.15",
      capabilities: ["endpoint:zen/m1"],
      setup: () => {},
    } as ExtensionDefinition);
    await rt.ready();
    expect(events.some((e) => e.type === "extension_failed" && (e as { reason: string }).reason === "invalid_endpoint_scope")).toBe(true);
  });
});

describe("endpoint scope: a granted endpoint end to end", () => {
  test("modelCall returns text + usage; credentials never cross the seam; the log marks the requester", async () => {
    const server = startCompatServer();
    try {
      const events: AgentEvent[] = [];
      const { rt, host } = await probe(project(), ["endpoint:zen"]);
      const session = await sessionWith({ host, rt, endpoints: endpoints(server.url), events });
      try {
        const result = await (host as Required<ExtensionHost>).modelCall!({
          endpoint: "zen",
          model: "m1",
          messages: [{ role: "user", content: "say hi" }],
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.text).toBe("answer:m1@medium");
          expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
          expect(result.model).toContain("m1");
          expect(JSON.stringify(result)).not.toContain("sk-test-secret");
        }
        // The route used the endpoint's own key, host-side.
        expect(server.requests.some((r) => r.auth === "Bearer sk-test-secret")).toBe(true);

        // The record: an ordinary model_call, requester-marked.
        const calls = events.filter((e) => e.type === "model_call" && (e as { requester?: unknown }).requester !== undefined);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
          model: expect.stringContaining("m1"),
          usage: { inputTokens: 11, outputTokens: 7 },
          requester: { kind: "extension", extension: "probe" },
        });
        const ops = events.filter((e) => e.type === "host_op" && e.op === "model_call");
        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({ extension: "probe", outcome: "ok" });
      } finally {
        await session.dispose();
      }
    } finally {
      server.stop();
    }
  });

  test("a second endpoint is outside_scope with one host_refused; no request leaves", async () => {
    const server = startCompatServer();
    try {
      const events: AgentEvent[] = [];
      const { rt, host } = await probe(project(), ["endpoint:zen"]);
      const session = await sessionWith({ host, rt, endpoints: endpoints(server.url), events });
      try {
        const result = await (host as Required<ExtensionHost>).modelCall!({
          endpoint: "go",
          model: "m2",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(result).toEqual({ ok: false, reason: "outside_scope" });
        const refused = events.filter((e) => e.type === "host_refused" && e.op === "model_call");
        expect(refused).toHaveLength(1);
        expect(refused[0]).toMatchObject({ extension: "probe", reason: "outside_scope" });
        // The ungranted endpoint never saw a chat request.
        expect(server.requests.some((r) => r.path.endsWith("/chat/completions"))).toBe(false);
      } finally {
        await session.dispose();
      }
    } finally {
      server.stop();
    }
  });

  test("the model listing works only for the granted ref", async () => {
    const server = startCompatServer();
    try {
      const events: AgentEvent[] = [];
      const { rt, host } = await probe(project(), ["endpoint:zen"]);
      const session = await sessionWith({ host, rt, endpoints: endpoints(server.url), events });
      try {
        const granted = await (host as Required<ExtensionHost>).listModels!("zen");
        expect(granted).toEqual({ ok: true, models: ["m1", "m2"] });
        const outside = await (host as Required<ExtensionHost>).listModels!("go");
        expect(outside).toEqual({ ok: false, reason: "outside_scope" });
        const refused = events.filter((e) => e.type === "host_refused" && e.op === "list_models");
        expect(refused).toHaveLength(1);
        const ops = events.filter((e) => e.type === "host_op" && e.op === "list_models");
        expect(ops).toHaveLength(1);
      } finally {
        await session.dispose();
      }
    } finally {
      server.stop();
    }
  });

  test("a thinking override within capability rides the call and lands in model_call; an unsupported level refuses typed", async () => {
    const server = startCompatServer();
    try {
      const events: AgentEvent[] = [];
      const { rt, host } = await probe(project(), ["endpoint:zen"]);
      const session = await sessionWith({ host, rt, endpoints: endpoints(server.url), events });
      try {
        const ok = await (host as Required<ExtensionHost>).modelCall!({
          endpoint: "zen",
          model: "m1",
          messages: [{ role: "user", content: "hi" }],
          thinkingLevel: "high",
        });
        expect(ok.ok).toBe(true);
        const sent = server.requests.find((r) => r.path.endsWith("/chat/completions"));
        expect((sent?.body as { reasoning_effort?: string })?.reasoning_effort).toBe("high");
        const call = events.find((e) => e.type === "model_call" && (e as { requester?: unknown }).requester !== undefined) as { thinkingLevel?: string } | undefined;
        expect(call?.thinkingLevel).toBe("high");

        const refused = await (host as Required<ExtensionHost>).modelCall!({
          endpoint: "zen",
          model: "m1",
          messages: [{ role: "user", content: "hi" }],
          thinkingLevel: "xhigh",
        });
        expect(refused).toMatchObject({ ok: false, reason: "unsupported_level" });
        expect(events.filter((e) => e.type === "host_refused" && (e as { reason?: string }).reason === "unsupported_level")).toHaveLength(1);
      } finally {
        await session.dispose();
      }
    } finally {
      server.stop();
    }
  });

  test("a mid-turn seam call lands in done's extensionUsage, separated from the session's own usage", async () => {
    const server = startCompatServer();
    try {
      const events: AgentEvent[] = [];
      const { rt, host } = await probe(project(), ["endpoint:zen"]);
      const session = await sessionWith({ host, rt, endpoints: endpoints(server.url), events });
      try {
        const turn = await (session as unknown as { send(text: string): Promise<{ status: string }> }).send("run the echo tool");
        expect(turn.status).toBe("done");
        const done = events.find((e) => e.type === "done") as { usage?: { inputTokens: number }; extensionUsage?: Record<string, { inputTokens: number; outputTokens: number }> } | undefined;
        expect(done?.extensionUsage?.probe).toEqual({ inputTokens: 11, outputTokens: 7 });
        // The extension's consumption is separate from the session's own
        // model usage (mock provider reports none) — never folded in.
        expect(done?.usage?.inputTokens ?? 0).toBe(0);
      } finally {
        await session.dispose();
      }
    } finally {
      server.stop();
    }
  });

  test("an unknown endpoint name refuses typed, even under a valid grant shape", async () => {
    const server = startCompatServer();
    try {
      const events: AgentEvent[] = [];
      const { rt, host } = await probe(project(), ["endpoint:zen"]);
      const session = await sessionWith({ host, rt, endpoints: endpoints(server.url), events });
      try {
        const result = await (host as Required<ExtensionHost>).modelCall!({
          endpoint: "nowhere",
          model: "m1",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(result).toMatchObject({ ok: false, reason: "outside_scope" });
      } finally {
        await session.dispose();
      }
    } finally {
      server.stop();
    }
  });
});
