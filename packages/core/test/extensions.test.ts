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
    expect(parseApiVersion(MOH_EXTENSION_API_VERSION)).toEqual({ major: 1, minor: 0 });
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
