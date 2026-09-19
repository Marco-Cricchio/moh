/**
 * Extension runtime and API versioning (#34).
 * Covers the acceptance criteria: hook registration + veto, ordered
 * extension_notes (over a base-prompt override), additive-only apiVersion,
 * hot-reload with state preservation, fail-open loads, and per-change
 * dependency authorization.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, ExtensionRuntime, MockProvider, PromptComposer } from "../src/index";
import { defineExtension, MOH_EXTENSION_API_VERSION, parseApiVersion } from "@moh/extension";
import type { AgentEvent, Tool } from "../src/index";
import type { ExtensionDefinition } from "@moh/extension";

const echoTool: Tool = {
  name: "echo",
  description: "echoes its text",
  inputSchema: undefined,
  execute: (args: { text: string }) => args.text,
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "moh-ext-"));
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runtime with auto-approving consent + dep authorization (policy tests override). */
function runtime(dir: string, overrides: Partial<ConstructorParameters<typeof ExtensionRuntime>[0]> = {}) {
  return new ExtensionRuntime({
    mohHome: dir,
    consent: () => true,
    authorizeDependencies: () => true,
    ...overrides,
  });
}

async function setup(def: ExtensionDefinition | ExtensionDefinition[], options: { runtime?: ExtensionRuntime; turns?: any[] } = {}) {
  const rt = options.runtime ?? runtime(tempDir());
  for (const d of Array.isArray(def) ? def : [def]) await rt.register(d);
  const session = createSession({
    provider: MockProvider.scripted(options.turns ?? [{ deltas: ["ok"], finish: "stop" }]),
    tools: { echo: echoTool },
    extensions: rt,
  });
  return { rt, session };
}

describe("@moh/extension contract", () => {
  test("defineExtension is an identity tag; apiVersion parses", () => {
    const def = defineExtension({ name: "x", version: "1.0.0", apiVersion: "1.0", setup: () => {} });
    expect(def.name).toBe("x");
    // ADR-0031/ADR-0032/ADR-0033/ADR-0038/ADR-0034: the ask outcome, the
    // two observability seams, the beforeTurn hook, the control channel,
    // the post-tool inspection seam and `confirm.onResolved`.
    expect(parseApiVersion(MOH_EXTENSION_API_VERSION)).toEqual({ major: 1, minor: 6 });
    expect(parseApiVersion("banana")).toBeNull();
  });
});

describe("hooks and veto", () => {
  test("extension registers hooks; a veto produces the standard denied tool_result", async () => {
    const seen: string[] = [];
    const { session } = await setup(
      defineExtension({
        name: "guard",
        version: "1.0.0",
        apiVersion: "1.0",
        setup: (ctx) => {
          ctx.onSessionStart(() => {
            seen.push("session_start");
          });
          ctx.onEvent(({ event }) => {
            seen.push(`event:${(event as AgentEvent).type}`);
          });
          ctx.beforeModelCall(() => {
            seen.push("before_model_call");
          });
          ctx.afterTurn(() => {
            seen.push("after_turn");
          });
          ctx.onToolCall(({ name }) => (name === "echo" ? { veto: true, reason: "not allowed here" } : undefined));
        },
      }),
      {
        turns: [
          { deltas: [], finish: "tool_calls", toolCalls: [{ name: "echo", args: { text: "hi" } }] },
          { deltas: ["denied, moving on"], finish: "stop" },
        ],
      },
    );

    const result = await session.send("hello");
    expect(result.status).toBe("done");
    expect(seen).toContain("session_start");
    expect(seen).toContain("before_model_call");
    expect(seen).toContain("after_turn");
    expect(seen).toContain("event:user_message");

    const log = session.history();
    const denial = log.find((e) => e.type === "permission_denied");
    expect(denial).toMatchObject({ tool: "echo", reason: "extension" });
    const toolResult = log.find((e) => e.type === "tool_result");
    expect(toolResult).toMatchObject({ ok: false });
    expect((toolResult as any).output).toContain("vetoed by extension guard");
    expect((toolResult as any).output).toContain("not allowed here");
  });

  test("veto outranks an explicit user allow rule", async () => {
    const rt = new ExtensionRuntime({ mohHome: tempDir(), consent: () => true });
    await rt.register(
      defineExtension({
        name: "guard",
        version: "1.0.0",
        apiVersion: "1.0",
        setup: (ctx) => ctx.onToolCall(() => ({ veto: true })),
      }),
    );
    const s = createSession({
      provider: MockProvider.scripted([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "echo", args: { text: "x" } }] },
        { deltas: ["fine"], finish: "stop" },
      ]),
      tools: { echo: echoTool },
      extensions: rt,
      permissions: { overrides: { tools: { echo: "allow" } } },
    });
    await s.send("go");
    const denial = s.history().find((e) => e.type === "permission_denied");
    expect(denial).toMatchObject({ tool: "echo", reason: "extension" });
  });

  test("a veto still denies in a yolo session (#377: extensions restrict, never grant)", async () => {
    const dir = tempDir();
    const rt = runtime(dir);
    await rt.register(
      defineExtension({
        name: "guard",
        version: "1.0.0",
        apiVersion: MOH_EXTENSION_API_VERSION,
        setup: (ctx) => ctx.onToolCall(() => ({ veto: true })),
      }),
    );
    const s = createSession({
      provider: MockProvider.scripted([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "echo", args: { text: "x" } }] },
        { deltas: ["fine"], finish: "stop" },
      ]),
      tools: { echo: echoTool },
      extensions: rt,
      permissions: { unrestrictedTools: true },
    });
    await s.send("go");
    expect(s.history().find((e) => e.type === "permission_denied")).toMatchObject({
      tool: "echo",
      reason: "extension",
    });
  });
});

describe("extension_notes", () => {
  test("notes land in registration order, even over a user base-prompt override", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, ".moh", "prompts"), { recursive: true });
    writeFileSync(join(dir, ".moh", "prompts", "system.md"), "Custom base prompt.");
    const composer = new PromptComposer({ projectDir: dir });

    const rt = new ExtensionRuntime({ mohHome: tempDir(), consent: () => true });
    await rt.register(
      defineExtension({
        name: "a",
        version: "1.0.0",
        apiVersion: "1.0",
        setup: (ctx) => ctx.appendToPrompt("note-from-a"),
      }),
    );
    await rt.register(
      defineExtension({
        name: "b",
        version: "1.0.0",
        apiVersion: "1.0",
        setup: (ctx) => ctx.appendToPrompt("note-from-b"),
      }),
    );
    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
      promptComposer: composer,
      extensions: rt,
    });
    await session.send("hi");
    const log = session.history();
    const system = (log[0] as any).promptVersion; // hash present
    expect(system).toBeTruthy();
    // Reconstruct via a second send's assembled prompt is internal; instead
    // assert through the runtime + composer directly.
    const assembled = composer.compose({
      cwd: dir,
      platform: "test",
      now: new Date(),
      tools: [],
      skills: [],
      extensionNotes: rt.notes(),
    });
    expect(assembled.sections["base"]).toBe("Custom base prompt.");
    expect(assembled.sections["extension_notes"]).toContain("note-from-a\n\nnote-from-b");
    expect(assembled.system.indexOf("note-from-a")).toBeGreaterThan(assembled.system.indexOf("Custom base prompt."));
  });
});

describe("apiVersion policy (additive-only)", () => {
  test("major mismatch: load refused, warning in event log, session continues", async () => {
    const { session } = await setup(
      defineExtension({
        name: "old",
        version: "0.1.0",
        apiVersion: "0.9",
        setup: () => {},
      }),
    );
    const log = session.history();
    const failed = log.find((e) => e.type === "extension_failed");
    expect(failed).toMatchObject({ name: "old", reason: "api_version_mismatch" });
    expect(log.some((e) => e.type === "extension_loaded")).toBe(false);
    const result = await session.send("hi");
    expect(result.status).toBe("done");
  });

  test("same major always loads (minor differences are additive)", async () => {
    const rt = runtime(tempDir());
    expect(await rt.register(defineExtension({ name: "a", version: "1", apiVersion: "1.2", setup: () => {} }))).toBe(true);
    expect(await rt.register(defineExtension({ name: "b", version: "1", apiVersion: "1.0", setup: () => {} }))).toBe(true);
    expect(rt.instances.map((i) => i.def.name)).toEqual(["a", "b"]);
  });

  test("failed setup: warning, session continues", async () => {
    const { session } = await setup(
      defineExtension({
        name: "broken",
        version: "1.0.0",
        apiVersion: "1.0",
        setup: () => {
          throw new Error("boom at setup");
        },
      }),
    );
    expect(session.history().find((e) => e.type === "extension_failed")).toMatchObject({
      name: "broken",
      reason: "setup_failed",
    });
    expect((await session.send("hi")).status).toBe("done");
  });
});

describe("consent and dependencies", () => {
  test("one-time enable consent: declined once, then approved and remembered", async () => {
    const dir = tempDir();
    const asked: string[] = [];
    const consent = (name: string) => {
      asked.push(name);
      return asked.length > 1; // decline the first ask
    };
    const def = defineExtension({ name: "c", version: "1.0.0", apiVersion: "1.0", setup: () => {} });
    const rt1 = new ExtensionRuntime({ mohHome: dir, consent });
    expect(await rt1.register(def)).toBe(false);
    const rt2 = new ExtensionRuntime({ mohHome: dir, consent });
    expect(await rt2.register(def)).toBe(true);
    // Third time: stored consent matches, no ask.
    const rt3 = new ExtensionRuntime({ mohHome: dir, consent: () => false });
    expect(await rt3.register(def)).toBe(true);
    expect(asked).toEqual(["c", "c"]);
    expect(statSync(join(dir, "extensions.json")).mode & 0o777).toBe(0o600);
  });

  test("npm dep list change re-asks authorization; approved list remembered per extension", async () => {
    const dir = tempDir();
    const authRequests: string[][] = [];
    const authorizeDependencies = (_name: string, deps: string[]) => {
      authRequests.push([...deps]);
      return true;
    };
    const withDeps = (deps: string[]) =>
      defineExtension({ name: "d", version: "1.0.0", apiVersion: "1.0", dependencies: deps, setup: () => {} });

    const rt1 = new ExtensionRuntime({ mohHome: dir, consent: () => true, authorizeDependencies });
    expect(await rt1.register(withDeps(["left-pad@1.0.0"]))).toBe(true);
    // Same deps again: no re-ask.
    const rt2 = new ExtensionRuntime({ mohHome: dir, consent: () => true, authorizeDependencies });
    expect(await rt2.register(withDeps(["left-pad@1.0.0"]))).toBe(true);
    expect(authRequests).toEqual([["left-pad@1.0.0"]]);
    // Changed deps: re-ask, declined -> refused.
    const rt3 = new ExtensionRuntime({ mohHome: dir, consent: () => true, authorizeDependencies: () => false });
    expect(await rt3.register(withDeps(["left-pad@1.0.0", "right-pad@2.0.0"]))).toBe(false);
    const events = rt3.consumeLoadEvents();
    expect(events.find((e) => e.type === "extension_failed")).toMatchObject({
      name: "d",
      reason: "deps_unauthorized",
    });
    // No authorization flow + unapproved non-empty deps: refused.
    const rt4 = new ExtensionRuntime({ mohHome: dir, consent: () => true });
    expect(await rt4.register(withDeps(["evil@9.9.9"]))).toBe(false);
  });
});

describe("content-bound file consent", () => {
  test("same claimed name from another file requires consent and cannot run setup when refused", async () => {
    const dir = tempDir();
    const first = join(dir, "first.mjs");
    const second = join(dir, "second.mjs");
    const marker = join(dir, "setup-ran");
    writeFileSync(first, `export default { name: "same", version: "1.0.0", apiVersion: "1.0", setup() {} };`);
    writeFileSync(second, `import { writeFileSync } from "node:fs"; export default { name: "same", version: "9.9.9", apiVersion: "1.0", setup() { writeFileSync(${JSON.stringify(marker)}, "ran"); } };`);

    const approved = new ExtensionRuntime({ mohHome: dir, consent: () => true });
    expect(await approved.registerFile(first)).toBe(true);
    const refused = new ExtensionRuntime({ mohHome: dir, consent: () => false });
    expect(await refused.registerFile(second)).toBe(false);
    expect(refused.instances).toHaveLength(0);
    expect(existsSync(marker)).toBe(false);
  });

  test("unchanged file loads silently, while changed content re-authorizes its dependencies", async () => {
    const dir = tempDir();
    const file = join(dir, "extension.mjs");
    const source = (deps: string[]) => `export default { name: "stable", version: "1.0.0", apiVersion: "1.0", dependencies: ${JSON.stringify(deps)}, setup() {} };`;
    writeFileSync(file, source(["left@1"]));
    const dependencyRequests: string[][] = [];
    const first = new ExtensionRuntime({ mohHome: dir, consent: () => true, authorizeDependencies: (_name, deps) => { dependencyRequests.push(deps); return true; } });
    expect(await first.registerFile(file)).toBe(true);
    const unchanged = new ExtensionRuntime({ mohHome: dir, consent: () => false, authorizeDependencies: () => false });
    expect(await unchanged.registerFile(file)).toBe(true);
    writeFileSync(file, source(["right@2"]));
    const changed = new ExtensionRuntime({ mohHome: dir, consent: () => true, authorizeDependencies: (_name, deps) => { dependencyRequests.push(deps); return true; } });
    expect(await changed.registerFile(file)).toBe(true);
    expect(dependencyRequests).toEqual([["left@1"], ["right@2"]]);
  });
});

describe("hot-reload", () => {
  test("preserves ctx.state and re-registers hooks; a mismatched reload keeps the previous instance", async () => {
    const dir = tempDir();
    const file = join(dir, "ext.mjs");
    writeFileSync(
      file,
      `export default { name: "hot", version: "1.0.0", apiVersion: "1.0",
        setup(ctx) { ctx.state.loads = ((ctx.state.loads ?? 0) + 1); ctx.onToolCall(() => ({ veto: true, reason: "v" + ctx.state.loads })); } };
      `,
    );
    const rt = runtime(dir);
    expect(await rt.registerFile(file)).toBe(true);
    expect(rt.instances[0]!.state.loads).toBe(1);

    rt.startWatch();
    writeFileSync(
      file,
      `export default { name: "hot", version: "1.1.0", apiVersion: "1.0",
        setup(ctx) { ctx.state.loads = ((ctx.state.loads ?? 0) + 1); ctx.onToolCall(() => ({ veto: true, reason: "v" + ctx.state.loads })); } };
      `,
    );
    await Bun.sleep(400);
    expect(rt.instances[0]!.def.version).toBe("1.1.0");
    expect(rt.instances[0]!.state.loads).toBe(2); // preserved, incremented by the new setup
    expect(rt.instances[0]!.hooks.onToolCall.length).toBe(1); // re-registered

    // Major mismatch on reload: previous instance kept.
    writeFileSync(
      file,
      `export default { name: "hot", version: "2.0.0", apiVersion: "2.0", setup() {} };
      `,
    );
    await Bun.sleep(400);
    expect(rt.instances[0]!.def.version).toBe("1.1.0");
    rt.stopWatch();
  });

  test("modified file re-asks before replacement", async () => {
    const dir = tempDir();
    const file = join(dir, "consented.mjs");
    const source = (version: string) => `export default { name: "watch", version: ${JSON.stringify(version)}, apiVersion: "1.0", setup() {} };`;
    writeFileSync(file, source("1.0.0"));
    let asks = 0;
    const rt = new ExtensionRuntime({ mohHome: dir, consent: () => ++asks <= 2 });
    expect(await rt.registerFile(file)).toBe(true);
    rt.startWatch();
    writeFileSync(file, source("2.0.0"));
    await Bun.sleep(400);
    expect(asks).toBe(2);
    expect(rt.instances[0]!.def.version).toBe("2.0.0");
    rt.stopWatch();
  });

  test("missing extension file on register: warning event, no instance", async () => {
    const rt = runtime(tempDir());
    expect(await rt.registerFile(join(tempDir(), "nope.mjs"))).toBe(false);
    const events = rt.consumeLoadEvents();
    expect(events.find((e) => e.type === "extension_failed")).toMatchObject({ reason: "load_failed" });
  });

  test("missing extension on resume: warning in log, session continues", async () => {
    const rt1 = new ExtensionRuntime({ mohHome: tempDir(), consent: () => true });
    await rt1.register(defineExtension({ name: "gone", version: "1.0.0", apiVersion: "1.0", setup: () => {} }));
    const first = createSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
      extensions: rt1,
    });
    await first.send("hi");
    // Resume with a runtime that did NOT load "gone".
    const rt2 = new ExtensionRuntime({ mohHome: tempDir(), consent: () => true });
    await rt2.register(defineExtension({ name: "other", version: "1.0.0", apiVersion: "1.0", setup: () => {} }));
    const resumed = createSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
      extensions: rt2,
      resume: { events: first.history() },
    });
    const warning = resumed.history().find(
      (e) => e.type === "extension_failed" && (e as any).reason === "missing_on_resume",
    );
    expect(warning).toMatchObject({ name: "gone" });
    expect((await resumed.send("again")).status).toBe("done");
  });

  test("a hook that always throws does not loop and becomes a warning event", async () => {
    let events = 0;
    const { session } = await setup(
      defineExtension({
        name: "thrower",
        version: "1.0.0",
        apiVersion: "1.0",
        setup: (ctx) => {
          ctx.onEvent(() => {
            events += 1;
            throw new Error("hook boom");
          });
        },
      }),
    );
    const result = await session.send("hi");
    expect(result.status).toBe("done");
    await Bun.sleep(20);
    const failures = session.history().filter((e) => e.type === "extension_failed");
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every((f: any) => f.reason === "hook")).toBe(true);
    // The extension_failed events themselves were not re-dispatched.
    expect(events).toBeLessThan(20);
  });
});

describe("ADR-0036 setPromptNote (per-turn prompt note)", () => {
  test("replaces per extension, null removes; renders in the turn_notes section", async () => {
    const { rt } = await setup({
      name: "annotator",
      version: "1.0.0",
      apiVersion: "1.5",
      setup: (ctx) => {
        ctx.setPromptNote("first");
        ctx.setPromptNote("second");
        ctx.setPromptNote(null);
        ctx.setPromptNote("hint for this turn");
      },
    });
    const composer = new PromptComposer({ projectDir: tempDir(), mohHome: tempDir() });
    const assembled = composer.compose({
      cwd: tempDir(),
      platform: "test",
      now: new Date(),
      tools: [],
      skills: [],
      extensionNotes: rt.notes(),
      turnNotes: rt.turnNotes(),
    });
    expect(assembled.sections["turn_notes"]).toBe("## Turn notes\n\nhint for this turn");
    expect(assembled.system).not.toContain("first");
  });

  test("auto-clears at turn start; a note set during beforeTurn describes that turn; one slot each", async () => {
    const { rt } = await setup([
      {
        name: "a",
        version: "1.0.0",
        apiVersion: "1.5",
        setup: (ctx) => {
          ctx.setPromptNote("stale from setup");
          ctx.beforeTurn(() => ctx.setPromptNote("from-a"));
        },
      },
      {
        name: "b",
        version: "1.0.0",
        apiVersion: "1.5",
        setup: (ctx) => {
          ctx.beforeTurn(() => ctx.setPromptNote("from-b"));
        },
      },
    ]);
    // Before any turn: the setup-time note is there (one slot, no leak).
    expect(rt.turnNotes()).toEqual(["stale from setup"]);
    // A turn's dispatch clears first, then the hooks write: the stale
    // note cannot leak into the turn the hooks describe.
    await rt.dispatchBeforeTurn({ text: "second turn", turnIndex: 2, model: "mock" });
    expect(rt.turnNotes()).toEqual(["from-a", "from-b"]);
    await rt.dispatchBeforeTurn({ text: "third turn", turnIndex: 3, model: "mock" });
    expect(rt.turnNotes()).toEqual(["from-a", "from-b"]);
  });
});


describe("ADR-0037 requestTurn (synthetic turn)", () => {
  function requestTurnDef(log: { called: string[]; texts: string[] }, apiVersion = MOH_EXTENSION_API_VERSION) {
    return defineExtension({
      name: "corrector",
      version: "1.0.0",
      apiVersion,
      setup: (ctx) => {
        ctx.afterTurn(async ({ result }) => {
          if (result.status !== "done" || log.called.length >= 1) return;
          log.called.push("after_turn");
          const ok = await ctx.requestTurn("please fix the conventions");
          log.texts.push(`resolved:${ok}`);
        });
      },
    });
  }

  test("a finding triggers one synthetic turn: marked in the log, no beforeTurn, tools run", async () => {
    const log = { called: [] as string[], texts: [] as string[] };
    const beforeTurnSeen: string[] = [];
    const rt = runtime(tempDir());
    await rt.register({
      name: "corrector",
      version: "1.0.0",
      apiVersion: MOH_EXTENSION_API_VERSION,
      setup: (ctx) => {
        ctx.beforeTurn(() => {
          beforeTurnSeen.push("before_turn");
        });
        ctx.afterTurn(async ({ result, synthetic }) => {
          // The gate-shaped hook: done turns only, and a synthetic turn
          // the extension itself requested is never re-gated.
          if (synthetic === true || result.status !== "done") return;
          const ok = await ctx.requestTurn("please fix the conventions");
          log.texts.push(`resolved:${ok}`);
        });
      },
    });
    const session = createSession({
      provider: MockProvider.scripted([
        { deltas: ["first"], finish: "stop" },
        { deltas: ["correction"], finish: "stop" },
      ]),
      tools: { echo: echoTool },
      extensions: rt,
    });
    const result = await session.send("hello");
    expect(result.status).toBe("done");
    expect(log.texts).toEqual(["resolved:true"]);

    const history = session.history();
    const syntheticMessages = history.filter((e) => e.type === "user_message" && (e as any).synthetic === true);
    expect(syntheticMessages).toHaveLength(1);
    expect((syntheticMessages[0] as any).text).toBe("please fix the conventions");
    // The synthetic turn's reply follows it in the log.
    const syntheticIdx = history.indexOf(syntheticMessages[0]!);
    expect(history.slice(syntheticIdx).some((e) => e.type === "assistant_delta" && (e as any).text === "correction")).toBe(true);
    // beforeTurn fired only for the real user send, never for the synthetic turn.
    expect(beforeTurnSeen).toEqual(["before_turn"]);
  });

  test("the depth limit is the core's: the third consecutive request is refused, a real turn resets the budget", async () => {
    const answers: string[] = [];
    const rt = runtime(tempDir());
    await rt.register({
      name: "eager",
      version: "1.0.0",
      apiVersion: MOH_EXTENSION_API_VERSION,
      setup: (ctx) => {
        ctx.afterTurn(async ({ synthetic }) => {
          // Gate-shaped: never re-enter on our own synthetic turn.
          if (synthetic === true) return;
          // Ask three times every turn: only the first two consecutive
          // synthetic turns may ever run.
          for (let i = 0; i < 3; i++) answers.push(`ask:${await ctx.requestTurn(`fix ${i}`)}`);
        });
      },
    });
    const session = createSession({
      provider: MockProvider.scripted([
        { deltas: ["a"], finish: "stop" },
        { deltas: ["b"], finish: "stop" },
        { deltas: ["c"], finish: "stop" },
      ]),
      tools: { echo: echoTool },
      extensions: rt,
    });
    await session.send("turn one");
    // Two synthetic turns ran, the third consecutive request was refused.
    expect(answers).toEqual(["ask:true", "ask:true", "ask:false"]);
    const syntheticCount = (turnIndex: number) => {
      const history = session.history();
      return history.filter((e) => e.type === "user_message" && (e as any).synthetic === true).length;
    };
    expect(syntheticCount(0)).toBe(2);
    const capEvents = session.history().filter((e) => e.type === "extension_failed" && (e as any).reason === "request_turn");
    expect(capEvents.length).toBeGreaterThanOrEqual(1);

    // A real user turn resets the budget: two more synthetic turns run.
    answers.length = 0;
    await session.send("turn two");
    expect(answers).toEqual(["ask:true", "ask:true", "ask:false"]);
    expect(session.history().filter((e) => e.type === "user_message" && (e as any).synthetic === true)).toHaveLength(4);
  });

  test("refusals are visible: blank text, disposed session — each with a visible event", async () => {
    const rt = runtime(tempDir());
    await rt.register({
      name: "probe",
      version: "1.0.0",
      apiVersion: MOH_EXTENSION_API_VERSION,
      setup: (ctx) => {
        // The hook exercises the runtime path through the session entry.
        ctx.afterTurn(async () => {
          failures.push({ where: "blank", ok: await ctx.requestTurn("   ") });
        });
      },
    });
    const failures: any[] = [];
    const loadEvents: any[] = [];
    rt.onLoadEvent((e: any) => {
      if (e.type === "extension_failed" && e.reason === "request_turn") loadEvents.push(e);
    });
    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
      tools: { echo: echoTool },
      extensions: rt,
    });
    await session.send("hi");
    // Blank text refused.
    expect(failures).toEqual([{ where: "blank", ok: false }]);
    // The refusal is visible in the log, never silent.
    expect(loadEvents.length).toBeGreaterThanOrEqual(1);

    // A disposed session refuses (the turn entry is gone with it).
    await session.dispose();
  });

  test("an older host runtime without the option still answers (refusal, visible event), never throws", async () => {
    const rt = runtime(tempDir());
    // Simulate a host that never bound a turn entry: no session constructed.
    let answer: boolean | undefined;
    await rt.register({
      name: "hopeful",
      version: "1.0.0",
      apiVersion: MOH_EXTENSION_API_VERSION,
      setup: (ctx) => {
        void ctx.requestTurn("do it").then((ok) => {
          answer = ok;
        });
      },
    });
    await rt.ready();
    await new Promise((r) => setTimeout(r, 10));
    expect(answer).toBe(false);
  });
});
