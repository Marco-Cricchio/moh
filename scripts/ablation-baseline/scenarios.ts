/**
 * S0.1/B2 scenario definitions (00-safety-net § 2 B2, groups 1–10).
 *
 * One rule of shape: `assemble` runs BEFORE `sessionFromConfig` — every
 * config/consent/override/file setup lives there; `body` only drives the
 * assembled session. Turn scripts must cover every provider call the
 * scenario makes (main turns + any maintenance subagent extraction).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  deleteSession,
  MockProvider,
  overridesFromFlags,
  renameSession,
  restoreSession,
  sessionFromConfig,
  setSessionPinned,
  type AgentSession,
  type Provider,
  type SessionStore,
} from "@moh/core";
import type { Message, TurnResult } from "../../packages/core/src/types";
import type { MohConfig } from "../../packages/core/src/config";
import { createRoute, Endpoint } from "../../packages/core/src/route";
import { projectTrashDir } from "../../packages/core/src/session-store";
import { RecordingProvider, type MockTurnScript } from "./recording-provider";

export interface ScenarioContext {
  home: string;
  cwd: string;
  /** Write a file under cwd (parent dirs auto-created). */
  file(rel: string, content: string): string;
  /** The moh.json the session assembles from (mutate in `assemble`). */
  config: MohConfig;
  /** Consent seams — assigned in `assemble`, answered deterministically. */
  consent: Record<string, unknown>;
  /** Extra SessionOverrides for the assembly call (set in `assemble`). */
  overrides: Record<string, unknown>;
  /** Scratch shared between `assemble` and `body`. */
  vars: Map<string, unknown>;
}

export interface ScenarioRun {
  session: AgentSession;
  store: SessionStore;
  /** Every recorder the assembly saw (script order, not call order). */
  providers: RecordingProvider[];
  /** TurnResults pushed by bodies (serialized into results.json). */
  results: { label: string; result: TurnResult }[];
}

export interface Scenario {
  name: string;
  group: number;
  /** `undefined` = no pre-built provider: assembly resolves the reference
   * in `ctx.config.provider` (openai-compat endpoints, real wire). */
  assemble: (ctx: ScenarioContext) => Provider | undefined;
  body: (ctx: ScenarioContext, run: ScenarioRun) => Promise<void>;
}

const OFF: MohConfig = {
  memory: { enabled: false },
  retro: { enabled: false },
  handoff: { transport: "none" },
};

/** Writes a file-source extension fixture the runtime will actually load:
 * the module plus the `moh.extension.json` consent reads (ADR-0061 — a
 * file without one refuses with `extension_failed: manifest`, which is
 * how every g6 fixture originally slipped through unexercised). */
function writeExtension(
  ctx: ScenarioContext,
  file: string,
  code: string,
  capabilities: readonly string[],
): void {
  const dir = join(ctx.home, ".moh", "extensions");
  mkdirSync(dir, { recursive: true });
  const name = file.replace(/\.[a-z]+$/, "");
  writeFileSync(join(dir, file), code);
  writeFileSync(
    join(dir, "moh.extension.json"),
    JSON.stringify({ name, version: "1.0.0", entry: file, capabilities }, null, 2) + "\n",
  );
}

const text = (s: string): MockTurnScript => ({ deltas: [s], finish: "stop" });
const tool = (name: string, args: unknown): MockTurnScript => ({
  deltas: [],
  finish: "tool_calls",
  toolCalls: [{ name, args }],
});

/** The scripted extraction reply the memory maintenance subagent must
 * return for `memory_updated` to land: a JSON array of entries. */
const MEMORY_JSON = '[{"topic":"ablation","fact":"the golden harness records provider calls"}]';

/** Extension fixture bodies (written under `<home>/.moh/extensions/`). */

/** Fixtures live under the temp home, where a bare "@moh/extension"
 * specifier cannot resolve (no node_modules chain). They import the
 * repo's own package source by absolute path — constant across runs,
 * so the recorded fixture bytes stay deterministic. */
const EXT_IMPORT = `${join(import.meta.dir, "..", "..", "packages/extension/src/index.ts")}`;

const FIXTURE_VETO = `import { defineExtension, MOH_EXTENSION_API_VERSION } from "${EXT_IMPORT}";
export default defineExtension({
  name: "baseline-veto",
  version: "1.0.0",
  apiVersion: MOH_EXTENSION_API_VERSION,
  setup(ctx) {
    ctx.onToolCall(({ name, args }) => {
      if (name === "bash" && String(args?.command ?? "").includes("rm -rf")) {
        return { veto: true, reason: "baseline-veto: refusing recursive force delete" };
      }
      if (name === "bash" && String(args?.command ?? "").includes("ask-me")) {
        return { ask: true, reason: "baseline-veto: this one needs a human" };
      }
    });
    ctx.onToolResult(({ name, output }) => {
      if (name === "bash" && String(output ?? "").includes("withhold-me")) {
        return { withhold: { reason: "baseline-veto: withhold the result" } };
      }
    });
  },
});
`;

const FIXTURE_HOSTOPS = `import { defineExtension, MOH_EXTENSION_API_VERSION } from "${EXT_IMPORT}";
export default defineExtension({
  name: "baseline-hostops",
  version: "1.0.0",
  apiVersion: MOH_EXTENSION_API_VERSION,
  capabilities: ["path:notes.txt", "tool:bash"],
  setup(ctx) {
    ctx.appendEvent({ name: "saw-open", payload: { at: "open" } });
    ctx.onEvent(async ({ event }) => {
      if (event.type !== "user_message" || event.text !== "host ops") return;
      const host = ctx.host!;
      const results = [
        ["read", (await host.readFile("notes.txt")).ok],
        ["write-denied", (await host.writeFile("/etc/baseline-denied.txt", "x")).ok],
        ["run-tool", (await host.runTool("bash", { command: "echo via-host" })).ok],
      ];
      ctx.appendEvent({ name: "host-ops-done", payload: { results } });
    });
  },
});
`;

const FIXTURE_SECTION = `import { defineExtension, MOH_EXTENSION_API_VERSION } from "${EXT_IMPORT}";
export default defineExtension({
  name: "baseline-section",
  version: "1.0.0",
  apiVersion: MOH_EXTENSION_API_VERSION,
  capabilities: ["replace-prompt-section:environment"],
  setup(ctx) {
    ctx.beforeModelCall(() => ({
      sections: { environment: "## Environment\\n\\n(replaced by baseline-section)" },
    }));
  },
});
`;

const FIXTURE_TURN = `import { defineExtension, MOH_EXTENSION_API_VERSION } from "${EXT_IMPORT}";
export default defineExtension({
  name: "baseline-turn",
  version: "1.0.0",
  apiVersion: MOH_EXTENSION_API_VERSION,
  setup(ctx) {
    let seen = 0;
    ctx.beforeTurn(() => {
      seen += 1;
      if (seen === 1) return { confirm: { reason: "baseline-turn: confirm the first turn" } };
      if (seen === 2) return { model: "baseline-ep/other-model" };
      return {};
    });
    ctx.afterTurn(() => {
      if (seen === 2) {
        seen = 3;
        void ctx.requestTurn?.("baseline synthetic turn");
      }
    });
  },
});
`;

const FIXTURE_TIMEOUT = `import { defineExtension, MOH_EXTENSION_API_VERSION } from "${EXT_IMPORT}";
export default defineExtension({
  name: "baseline-timeout",
  version: "1.0.0",
  apiVersion: MOH_EXTENSION_API_VERSION,
  setup(ctx) {
    ctx.beforeModelCall(() => new Promise(() => {}));
    ctx.onToolCall(() => new Promise(() => {}));
  },
});
`;

const FIXTURE_APPEND_OVERFLOW = `import { defineExtension, MOH_EXTENSION_API_VERSION } from "${EXT_IMPORT}";
const LIMIT = 200;
export default defineExtension({
  name: "baseline-append",
  version: "1.0.0",
  apiVersion: MOH_EXTENSION_API_VERSION,
  setup(ctx) {
    ctx.onEvent(({ event }) => {
      if (event.type !== "user_message") return;
      for (let i = 0; i < LIMIT; i++) {
        ctx.appendEvent({ name: "spurious-" + i, payload: { i } });
      }
    });
  },
});
`;

const FIXTURE_STATE = `import { defineExtension, MOH_EXTENSION_API_VERSION } from "${EXT_IMPORT}";
export default defineExtension({
  name: "baseline-state",
  version: "1.0.0",
  apiVersion: MOH_EXTENSION_API_VERSION,
  setup(ctx) {
    ctx.state.marker = "baseline-state-on";
    ctx.appendEvent({ name: "state-set", payload: { marker: ctx.state.marker } });
  },
});
`;

export function buildScenarios(): Scenario[] {
  const list: Scenario[] = [];
  const repoRoot = join(import.meta.dir, "..", "..");

  /* Group 1 — plain text, multi-iteration tools, parallel, ask_user, cap */

  list.push({
    name: "g1-plain",
    group: 1,
    assemble: () => RecordingProvider.scripted([text("hello there")]),
    body: async (_ctx, run) => {
      run.results.push({ label: "send", result: await run.session.send("say hi") });
    },
  });

  list.push({
    name: "g1-tools",
    group: 1,
    assemble: (ctx) => {
      ctx.file("notes.txt", "alpha\nbeta\n");
      ctx.overrides.permissionFlags = overridesFromFlags(["edit", "bash:cat notes.txt"], []);
      return RecordingProvider.scripted([
        tool("read", { path: join(ctx.cwd, "notes.txt") }),
        tool("edit", { path: join(ctx.cwd, "notes.txt"), oldText: "beta", newText: "gamma" }),
        tool("bash", { command: "cat notes.txt" }),
        text("all done"),
      ]);
    },
    body: async (_ctx, run) => {
      run.results.push({ label: "send", result: await run.session.send("inspect and edit notes.txt") });
    },
  });

  list.push({
    name: "g1-parallel",
    group: 1,
    assemble: (ctx) => {
      ctx.file("a.txt", "A\n");
      ctx.file("b.txt", "B\n");
      return RecordingProvider.scripted([
        {
          deltas: [],
          finish: "tool_calls",
          toolCalls: [
            { name: "read", args: { path: join(ctx.cwd, "a.txt") } },
            { name: "read", args: { path: join(ctx.cwd, "b.txt") } },
            { name: "bash", args: { command: "echo ping" } },
          ],
        },
        text("parallel complete"),
      ]);
    },
    body: async (_ctx, run) => {
      run.results.push({ label: "send", result: await run.session.send("read both and ping") });
    },
  });

  list.push({
    name: "g1-reasoning-wire",
    group: 1,
    assemble: (ctx) => {
      // A real openai-compat wire (local SSE server): the reasoning-aware
      // adapter is opted in by the endpoint's declared thinking capability
      // (#262/#895), and `reasoning_content` deltas (DeepSeek/Z.AI shape)
      // must fold into the `reasoning` event like any provider's would.
      const encoder = new TextEncoder();
      let call = 0;
      const server = Bun.serve({
        port: 0,
        fetch() {
          call += 1;
          const chunk = (delta: Record<string, unknown>, finish: string | null = null): Uint8Array =>
            encoder.encode(
              `data: ${JSON.stringify({ id: `t${call}`, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
            );
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(chunk({ role: "assistant" }));
              controller.enqueue(chunk({ reasoning_content: "wire thought one " }));
              controller.enqueue(chunk({ reasoning_content: "wire thought two" }));
              controller.enqueue(chunk({ content: "wire answer" }));
              controller.enqueue(chunk({}, "stop"));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        },
      });
      ctx.vars.set("stop", () => server.stop(true));
      ctx.config.endpoints = [
        {
          name: "wire",
          type: "openai-compat",
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          apiKey: "test-key",
          defaultModel: "wire-model",
          capabilities: { thinking: { format: "openai-effort", levels: ["low", "medium", "high"] } },
        },
      ];
      ctx.config.provider = "wire/wire-model";
      return undefined;
    },
    body: async (ctx, run) => {
      try {
        run.results.push({ label: "send", result: await run.session.send("reason over the wire") });
      } finally {
        (ctx.vars.get("stop") as () => void)();
      }
    },
  });

  list.push({
    name: "g1-reasoning",
    group: 1,
    assemble: () =>
      RecordingProvider.scripted([
        {
          deltas: ["the answer"],
          finish: "stop",
          reasoning: { deltas: ["think one ", "think two"], continuation: { opaque: "sig" } },
        },
      ]),
    body: async (_ctx, run) => {
      run.results.push({ label: "send", result: await run.session.send("reason with me") });
    },
  });

  list.push({
    name: "g1-ask-user",
    group: 1,
    assemble: () =>
      RecordingProvider.scripted([
        tool("ask_user", {
          questions: [{ header: "Flavor", question: "Which?", options: [{ label: "a", description: "first" }, { label: "b", description: "second" }], suggested: "a" }],
        }),
        text("going with the answer"),
      ]),
    body: async (ctx, run) => {
      void ctx;
      run.results.push({ label: "send", result: await run.session.send("decide") });
    },
  });

  list.push({
    name: "g1-cap",
    group: 1,
    assemble: (ctx) => {
      ctx.config.maxIterations = 2;
      return RecordingProvider.scripted(Array.from({ length: 6 }, () => tool("bash", { command: "echo iter" })));
    },
    body: async (_ctx, run) => {
      run.results.push({ label: "send", result: await run.session.send("keep looping") });
    },
  });

  /* Group 2 — permission surfaces */

  list.push({
    name: "g2-allow-deny",
    group: 2,
    assemble: (ctx) => {
      ctx.overrides.permissionFlags = overridesFromFlags(["bash:echo allowed"], ["bash:echo denied"]);
      return RecordingProvider.scripted([
        {
          deltas: [],
          finish: "tool_calls",
          toolCalls: [
            { name: "bash", args: { command: "echo allowed" } },
            { name: "bash", args: { command: "echo denied" } },
          ],
        },
        text("one allowed one denied"),
      ]);
    },
    body: async (_ctx, run) => {
      run.results.push({ label: "send", result: await run.session.send("run both") });
    },
  });

  list.push({
    name: "g2-headless-ask",
    group: 2,
    assemble: () => RecordingProvider.scripted([tool("bash", { command: "echo headless" }), text("denied headlessly")]),
    body: async (_ctx, run) => {
      run.results.push({ label: "send", result: await run.session.send("run unpermitted") });
    },
  });

  list.push({
    name: "g2-consent-always",
    group: 2,
    assemble: (ctx) => {
      ctx.consent.onPermissionRequest = () => "always";
      return RecordingProvider.scripted([
        tool("bash", { command: "echo first" }),
        tool("bash", { command: "echo first" }),
        text("rule added"),
      ]);
    },
    body: async (_ctx, run) => {
      run.results.push({ label: "send", result: await run.session.send("run it twice") });
    },
  });

  list.push({
    name: "g2-consent-yes",
    group: 2,
    assemble: (ctx) => {
      ctx.consent.onPermissionRequest = () => "yes";
      return RecordingProvider.scripted([
        tool("bash", { command: "echo one" }),
        tool("bash", { command: "echo two" }),
        text("asked each time"),
      ]);
    },
    body: async (_ctx, run) => {
      run.results.push({ label: "send", result: await run.session.send("run two asks") });
    },
  });

  list.push({
    name: "g2-yolo",
    group: 2,
    assemble: (ctx) => {
      ctx.overrides.permissions = { unrestrictedTools: true };
      return RecordingProvider.scripted([tool("bash", { command: "echo yolo" }), text("unrestricted")]);
    },
    body: async (_ctx, run) => {
      run.results.push({ label: "send", result: await run.session.send("run it") });
    },
  });

  list.push({
    name: "g2-auto-accept",
    group: 2,
    assemble: (ctx) => {
      ctx.overrides.permissions = { mode: "auto-accept" };
      return RecordingProvider.scripted([tool("bash", { command: "echo auto" }), text("auto-accepted")]);
    },
    body: async (_ctx, run) => {
      run.results.push({ label: "send", result: await run.session.send("run it") });
    },
  });

  list.push({
    name: "g2-out-of-root",
    group: 2,
    assemble: (ctx) => {
      return RecordingProvider.scripted([
        tool("write", { path: join(ctx.home, "outside.txt"), content: "x" }),
        text("attempted"),
      ]);
    },
    body: async (_ctx, run) => {
      run.results.push({ label: "send", result: await run.session.send("write outside the root") });
    },
  });

  list.push({
    name: "g2-mode-rotation",
    group: 2,
    assemble: (ctx) => {
      ctx.consent.onPermissionRequest = () => "yes";
      return RecordingProvider.scripted([
        tool("bash", { command: "echo r1" }),
        tool("bash", { command: "echo r2" }),
        text("rotated"),
      ]);
    },
    body: async (_ctx, run) => {
      await run.session.send("first turn");
      run.session.setSessionMode("auto-accept");
      run.results.push({ label: "second", result: await run.session.send("second turn") });
    },
  });

  /* Group 3 — resume, fork tree/branch, switchBranch, bookmarks, rename,
     pin, delete/restore, v1 legacy log resumed */

  list.push({
    name: "g3-resume-same-file",
    group: 3,
    assemble: () => RecordingProvider.scripted([text("first reply")]),
    body: async (ctx, run) => {
      await run.session.send("first message");
      await run.session.dispose();
      const resumed = sessionFromConfig({
        cwd: ctx.cwd,
        home: ctx.home,
        provider: RecordingProvider.scripted([text("second reply")]),
        config: ctx.config,
        consent: ctx.consent as never,
        overrides: { store: run.store, resumeEvents: run.store.load() },
      });
      if ("error" in resumed) throw new Error(resumed.error.message);
      run.results.push({ label: "resumed", result: await resumed.session.send("second message") });
      await resumed.session.dispose();
    },
  });

  list.push({
    name: "g3-fork-tree",
    group: 3,
    assemble: () => RecordingProvider.scripted([text("r1"), text("r2")]),
    body: async (ctx, run) => {
      await run.session.send("m1");
      await run.session.send("m2");
      await run.session.dispose();
      const forked = run.store.fork("tree");
      const resumed = sessionFromConfig({
        cwd: ctx.cwd,
        home: ctx.home,
        provider: RecordingProvider.scripted([text("after tree fork")]),
        config: ctx.config,
        consent: ctx.consent as never,
        overrides: { store: forked },
      });
      if ("error" in resumed) throw new Error(resumed.error.message);
      resumed.session.rename("forked tree name");
      setSessionPinned(forked.file, true);
      run.results.push({ label: "fork", result: await resumed.session.send("continue the fork") });
      await resumed.session.dispose();
    },
  });

  list.push({
    name: "g3-fork-branch-switch-bookmark",
    group: 3,
    assemble: () => RecordingProvider.scripted([text("r1"), text("r2"), text("r3"), text("after switch")]),
    body: async (ctx, run) => {
      await run.session.send("m1");
      await run.session.send("m2");
      const forked = run.store.fork("branch");
      const events = forked.load();
      const secondUser = [...events].reverse().find((e) => e.type === "user_message");
      if (!secondUser?.id) throw new Error("no user_message id to branch on");
      const bookmark = run.session.bookmarkNode(secondUser.id, "before-m2");
      if (!bookmark.ok) throw new Error(bookmark.error);
      const switched = run.session.switchBranch(secondUser.id);
      if (!switched.ok) throw new Error(switched.error);
      await run.session.dispose();
      const resumed = sessionFromConfig({
        cwd: ctx.cwd,
        home: ctx.home,
        provider: RecordingProvider.scripted([text("after branch fork")]),
        config: ctx.config,
        consent: ctx.consent as never,
        overrides: { store: forked },
      });
      if ("error" in resumed) throw new Error(resumed.error.message);
      run.results.push({ label: "branch", result: await resumed.session.send("continue the branch") });
      await resumed.session.dispose();
    },
  });

  list.push({
    name: "g3-delete-restore",
    group: 3,
    assemble: () => RecordingProvider.scripted([text("disposable")]),
    body: async (ctx, run) => {
      await run.session.send("to be trashed");
      await run.session.dispose();
      run.store.dispose();
      const file = run.store.file;
      renameSession(file, "renamed before delete");
      deleteSession(file, ctx.cwd, ctx.home);
      const name = file.split("/").pop()!;
      const restored = restoreSession(
        join(projectTrashDir(ctx.cwd, ctx.home), name),
        ctx.cwd,
        ctx.home,
      );
      ctx.vars.set("restored", restored);
    },
  });

  list.push({
    name: "g3-legacy-v1",
    group: 3,
    assemble: (ctx) => {
      const dir = join(ctx.home, ".moh", "projects", "legacy-slug");
      mkdirSync(dir, { recursive: true });
      const legacy = [
        { type: "session_start", schemaVersion: 1, promptVersion: "legacy" },
        { type: "user_message", text: "legacy hello" },
        { type: "assistant_delta", text: "legacy reply" },
        { type: "done" },
      ];
      const file = join(dir, "20000101T000000000Z-00000000.jsonl");
      writeFileSync(file, legacy.map((e) => JSON.stringify(e)).join("\n") + "\n");
      ctx.vars.set("legacyFile", file);
      return RecordingProvider.scripted([text("continuing")]);
    },
    body: async (ctx, run) => {
      const { SessionStore } = await import("@moh/core");
      const store = SessionStore.open(ctx.vars.get("legacyFile") as string);
      const resumed = sessionFromConfig({
        cwd: ctx.cwd,
        home: ctx.home,
        provider: RecordingProvider.scripted([text("continuing")]),
        config: ctx.config,
        consent: ctx.consent as never,
        overrides: { store, resumeEvents: store.load() },
      });
      if ("error" in resumed) throw new Error(resumed.error.message);
      run.results.push({ label: "legacy", result: await resumed.session.send("continue the legacy session") });
      await resumed.session.dispose();
    },
  });

  /* Group 4 — compaction: forced compact(), auto threshold, deterministic */

  list.push({
    name: "g4-compact-forced",
    group: 4,
    assemble: () => RecordingProvider.scripted([text("pre-compact reply"), text("post-compact reply")]),
    body: async (_ctx, run) => {
      await run.session.send("filler one");
      const outcome = await run.session.compact();
      run.results.push({
        label: "compact",
        result: { status: outcome.ok ? "done" : "error", ...(outcome.ok ? {} : { reason: outcome.error }) },
      });
      run.results.push({ label: "post", result: await run.session.send("after compaction") });
    },
  });

  list.push({
    name: "g4-compact-auto",
    group: 4,
    assemble: (ctx) => {
      ctx.config.compaction = { summarizer: "deterministic", threshold: 0.1, tailTurns: 1, fallbackWindowTokens: 100_000 };
      return RecordingProvider.scripted([
        { deltas: ["x"], finish: "stop", usage: { inputTokens: 900_000, outputTokens: 10 } },
        { deltas: ["y"], finish: "stop", usage: { inputTokens: 900_000, outputTokens: 10 } },
      ]);
    },
    body: async (_ctx, run) => {
      await run.session.send("turn one");
      await run.session.send("turn two");
    },
  });

  /* Group 5 — provider failures */

  list.push({
    name: "g5-provider-errors",
    group: 5,
    assemble: () =>
      RecordingProvider.scripted([
        { deltas: [], finish: "stop", error: { kind: "rate_limited", message: "scripted rate limit" } },
        text("after rate limit"),
        { deltas: [], finish: "stop", error: { kind: "auth", message: "scripted auth failure" } },
        text("after auth"),
      ]),
    body: async (_ctx, run) => {
      run.results.push({ label: "t1", result: await run.session.send("trigger rate limit") });
      run.results.push({ label: "t2", result: await run.session.send("trigger auth") });
    },
  });

  list.push({
    name: "g5-empty-completion",
    group: 5,
    assemble: () => RecordingProvider.scripted([{ deltas: [], finish: "stop" }, text("eventually content")]),
    body: async (_ctx, run) => {
      run.results.push({ label: "t1", result: await run.session.send("say nothing") });
      run.results.push({ label: "t2", result: await run.session.send("say something") });
    },
  });

  list.push({
    name: "g5-fallback-chain",
    group: 5,
    assemble: () => {
      const primary = RecordingProvider.scripted(
        [{ deltas: [], finish: "stop", error: { kind: "quota_exhausted", message: "scripted quota exhaustion" } }],
        "rec-primary",
      );
      const secondary = RecordingProvider.scripted([{ deltas: ["fallback served"], finish: "stop" }], "rec-secondary");
      const wrap = (p: RecordingProvider) => (messages: Message[], signal: AbortSignal) => p.stream(messages, signal);
      const route = createRoute({
        target: { endpoint: new Endpoint({ name: "primary-ep", kind: "mock" }), modelId: "m1" },
        fallbacks: [{ endpoint: new Endpoint({ name: "secondary-ep", kind: "mock" }), modelId: "m2" }],
        retries: 0,
        retryBackoffMs: 0,
        createStream: (target) =>
          target.endpoint.name === "primary-ep" ? wrap(primary) : wrap(secondary),
      }) as Provider;
      ctx_unused: {
        void route;
      }
      return route;
    },
    body: async (_ctx, run) => {
      run.results.push({ label: "t1", result: await run.session.send("fall back") });
    },
  });

  list.push({
    name: "g5-context-length",
    group: 5,
    assemble: () =>
      RecordingProvider.scripted([
        {
          deltas: [],
          finish: "stop",
          error: { kind: "context_length", message: "scripted: the maximum context length is 131072 tokens" },
        },
        text("after refusal"),
      ]),
    body: async (_ctx, run) => {
      run.results.push({ label: "t1", result: await run.session.send("overflow the context") });
      run.results.push({ label: "t2", result: await run.session.send("recover") });
    },
  });

  /* Group 6 — extensions */

  list.push({
    name: "g6-no-rm-rf",
    group: 6,
    assemble: (ctx) => {
      ctx.config.extensions = [join(repoRoot, "docs/extending/examples/no-rm-rf.mjs")];
      ctx.consent.onExtensionConsent = () => true;
      return RecordingProvider.scripted([
        {
          deltas: [],
          finish: "tool_calls",
          toolCalls: [
            { name: "bash", args: { command: "echo fine" } },
            { name: "bash", args: { command: "rm -rf /tmp/x" } },
          ],
        },
        text("one fine one vetoed"),
      ]);
    },
    body: async (_ctx, run) => {
      run.results.push({ label: "send", result: await run.session.send("run both commands") });
    },
  });

  list.push({
    name: "g6-veto-ask-withhold",
    group: 6,
    assemble: (ctx) => {
      writeExtension(ctx, "baseline-veto.ts", FIXTURE_VETO, []);
      ctx.consent.onExtensionConsent = () => true;
      // In `assemble`, not `body`: the consent seams are captured at
      // assembly time, so a seam assigned later is headless silence.
      // "no" answers the extension's `ask` (the veto's own kills need
      // no answer); the allow rule lets the withheld call actually run.
      ctx.overrides.permissionFlags = overridesFromFlags(["bash:echo withhold-me"], []);
      ctx.consent.onPermissionRequest = () => "no";
      return RecordingProvider.scripted([
        {
          deltas: [],
          finish: "tool_calls",
          toolCalls: [
            { name: "bash", args: { command: "rm -rf /" } },
            { name: "bash", args: { command: "echo withhold-me" } },
            { name: "bash", args: { command: "echo ask-me" } },
          ],
        },
        text("one withheld one asked"),
      ]);
    },
    body: async (_ctx, run) => {
      run.results.push({ label: "send", result: await run.session.send("run all three") });
    },
  });

  list.push({
    name: "g6-host-ops",
    group: 6,
    assemble: (ctx) => {
      ctx.file("notes.txt", "host ops note\n");
      writeExtension(ctx, "baseline-hostops.ts", FIXTURE_HOSTOPS, ["path:notes.txt", "tool:bash"]);
      ctx.consent.onExtensionConsent = () => true;
      ctx.overrides.permissionFlags = overridesFromFlags(["bash:echo via-host"], []);
      return RecordingProvider.scripted([text("host ops observed")]);
    },
    body: async (_ctx, run) => {
      await run.session.extensionsReady();
      run.results.push({ label: "send", result: await run.session.send("host ops") });
    },
  });

  list.push({
    name: "g6-section-replacement",
    group: 6,
    assemble: (ctx) => {
      writeExtension(ctx, "baseline-section.ts", FIXTURE_SECTION, ["replace-prompt-section:environment"]);
      ctx.consent.onExtensionConsent = () => true;
      return RecordingProvider.scripted([text("section replaced")]);
    },
    body: async (_ctx, run) => {
      run.results.push({ label: "send", result: await run.session.send("replace the environment section") });
    },
  });

  list.push({
    name: "g6-turn-model-requestTurn",
    group: 6,
    assemble: (ctx) => {
      writeExtension(ctx, "baseline-turn.ts", FIXTURE_TURN, []);
      ctx.consent.onExtensionConsent = () => true;
      ctx.consent.onConfirmTurn = () => "send" as const;
      ctx.config.endpoints = [{ name: "baseline-ep", type: "mock", defaultModel: "other-model" }];
      return RecordingProvider.scripted([
        text("first confirmed"),
        text("second with model switch"),
        text("synthetic turn served"),
        text("after synthetic"),
      ]);
    },
    body: async (_ctx, run) => {
      run.results.push({ label: "t1", result: await run.session.send("confirm me") });
      run.results.push({ label: "t2", result: await run.session.send("switch and synthesize") });
    },
  });

  list.push({
    name: "g6-hook-timeout",
    group: 6,
    assemble: (ctx) => {
      writeExtension(ctx, "baseline-timeout.ts", FIXTURE_TIMEOUT, []);
      ctx.consent.onExtensionConsent = () => true;
      // No hookTimeoutMs override: the scenario pins the DEFAULT ceiling
      // (DEFAULT_HOOK_TIMEOUT_MS renders verbatim in the hook_timeout
      // message), so a change to that constant must flip the compare.
      ctx.overrides.permissionFlags = overridesFromFlags(["bash:echo after-timeout"], []);
      return RecordingProvider.scripted([tool("bash", { command: "echo after-timeout" }), text("hooks timed out but turn proceeds")]);
    },
    body: async (_ctx, run) => {
      run.results.push({ label: "send", result: await run.session.send("stall the hooks") });
    },
  });

  list.push({
    name: "g6-append-overflow",
    group: 6,
    assemble: (ctx) => {
      writeExtension(ctx, "baseline-append.ts", FIXTURE_APPEND_OVERFLOW, []);
      ctx.consent.onExtensionConsent = () => true;
      return RecordingProvider.scripted([text("append overflow attempted")]);
    },
    body: async (_ctx, run) => {
      run.results.push({ label: "send", result: await run.session.send("flood appendEvent") });
    },
  });

  list.push({
    name: "g6-state",
    group: 6,
    assemble: (ctx) => {
      writeExtension(ctx, "baseline-state.ts", FIXTURE_STATE, []);
      ctx.consent.onExtensionConsent = () => true;
      return RecordingProvider.scripted([text("state set")]);
    },
    body: async (_ctx, run) => {
      run.results.push({ label: "send", result: await run.session.send("set your state") });
    },
  });

  /* Group 7 — subagents: spawn tool + stop */

  list.push({
    name: "g7-subagent-spawn",
    group: 7,
    assemble: (ctx) => {
      ctx.overrides.permissionFlags = overridesFromFlags(["spawn"], []);
      return RecordingProvider.scripted([tool("spawn", { task: "count the files", preset: "research" }), text("spawned and done")]);
    },
    body: async (_ctx, run) => {
      run.results.push({ label: "send", result: await run.session.send("delegate counting") });
      run.session.stopSubagents();
    },
  });

  /* Group 8 — MCP stdio fixture */

  list.push({
    name: "g8-mcp",
    group: 8,
    assemble: (ctx) => {
      const server = join(repoRoot, "packages/core/test/fixtures/mcp-stdio-server.ts");
      ctx.config.mcpServers = { srv: { type: "stdio", command: process.execPath, args: [server, "ok"] } };
      ctx.consent.onMcpTrust = () => "always";
      return RecordingProvider.scripted([tool("mcp__srv__echo", { text: "hello mcp" }), text("mcp done")]);
    },
    body: async (_ctx, run) => {
      run.results.push({ label: "send", result: await run.session.send("echo through mcp") });
    },
  });

  /* Group 9 — memory + retro */

  list.push({
    name: "g9-memory-retro",
    group: 9,
    assemble: (ctx) => {
      ctx.config.memory = { enabled: true, intervalTurns: 1 };
      ctx.config.retro = { enabled: true };
      return RecordingProvider.scripted([text("fact one"), text(MEMORY_JSON)]);
    },
    body: async (_ctx, run) => {
      run.results.push({ label: "t1", result: await run.session.send("remember: the harness records provider calls") });
    },
  });

  /* Group 10 — library reference for the B3/B4 equivalence check */

  list.push({
    name: "g10-reference",
    group: 10,
    assemble: () => RecordingProvider.scripted([text("reference reply")]),
    body: async (_ctx, run) => {
      run.results.push({ label: "send", result: await run.session.send("reference turn") });
    },
  });

  return list;
}

export { OFF };
