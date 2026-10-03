/**
 * ADR-0054 / #1129: prompt-section replacement via `beforeModelCall`.
 *
 * The dispatch (runtime) decides only who beat the 5 s window; this suite
 * covers the application half: capability enforcement by absence, one
 * author per section, the provenance line, `null` = hidden, the
 * `prompt_override` chrome record on composition change only, and the
 * borrowed-runtime widening (a session with no runtime of its own composes
 * the borrowed dispatch's replacements, its chrome in its own log).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExtensionRuntime,
  createSession,
  type AgentEvent,
  type Provider,
} from "../src/index";

function tmpDir(prefix = "moh-prompt-override-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A provider that records the system text each call actually saw. */
function capture(system: string[]): Provider {
  return {
    name: "capture",
    async *stream(list: any[]) {
      system.push(list[0].parts[0].text);
      yield { type: "text_delta", text: "ok" } as never;
      yield { type: "finish", reason: "stop" } as never;
    },
  };
}

interface ReplacerDef {
  name: string;
  version?: string;
  sections: Record<string, string | null>;
  capabilities?: string[];
}

/** In-memory extension whose `beforeModelCall` returns the given replacements. */
async function runtimeWith(
  defs: ReplacerDef[],
  home = tmpDir(),
): Promise<ExtensionRuntime> {
  const rt = new ExtensionRuntime({ mohHome: home, consent: () => true });
  for (const def of defs) {
    const caps = def.capabilities ?? Object.keys(def.sections).map((s) => `replace-prompt-section:${s}`);
    await rt.register(
      {
        name: def.name,
        version: def.version ?? "1.2.0",
        apiVersion: "1.11",
        capabilities: caps,
        setup: (ctx: { beforeModelCall(h: () => unknown): void }) => {
          ctx.beforeModelCall(() => ({ sections: def.sections }));
        },
      },
      {
        bundled: true,
        manifest: { hash: def.name, path: def.name, capabilities: caps },
      },
    );
  }
  return rt;
}

function systemOf(session: { history(): AgentEvent[] }, _i?: number): never {
  void session;
  throw new Error("helper replaced by capture provider");
}

describe("prompt-section replacement (ADR-0054, #1129)", () => {
  test("a granted extension replaces a section; the provenance line leads the text the model sees", async () => {
    const system: string[] = [];
    const rt = await runtimeWith([{ name: "mem-ext", sections: { memory: "remember this" } }]);
    const session = createSession({ provider: capture(system), cwd: tmpDir(), extensions: rt });
    await session.send("hi");
    await session.dispose();
    expect(system[0]).toContain("[extension: mem-ext v1.2.0 — section replaced]\n\nremember this");
    // The core's own section header is gone: the replacement is the whole section.
    expect(system[0]).not.toContain("## Memory");
  });

  test("without the capability grant the replacement is not honored — visible refusal, core text stands", async () => {
    const system: string[] = [];
    const rt = await runtimeWith([{ name: "sneaky", sections: { memory: "injected" }, capabilities: [] }]);
    const session = createSession({ provider: capture(system), cwd: tmpDir(), extensions: rt });
    await session.send("hi");
    await session.dispose();
    expect(system[0]).not.toContain("injected");
    const failed = session.history().find((e) => e.type === "extension_failed") as Extract<
      AgentEvent,
      { type: "extension_failed" }
    >;
    expect(failed.name).toBe("sneaky");
    expect(failed.reason).toBe("section_not_granted");
  });

  test("base and the extension's own note sections are never replaceable", async () => {
    const system: string[] = [];
    const rt = await runtimeWith([{ name: "bold", sections: { base: "my rules now", extension_notes: "mine" } }]);
    const session = createSession({ provider: capture(system), cwd: tmpDir(), extensions: rt });
    await session.send("hi");
    await session.dispose();
    expect(system[0]).toContain("You are moh");
    const failures = session.history().filter((e) => e.type === "extension_failed") as Extract<
      AgentEvent,
      { type: "extension_failed" }
    >[];
    expect(failures.filter((f) => f.reason === "section_not_replaceable")).toHaveLength(2);
  });

  test("a second author on the same section is refused visibly; the first author's text stands", async () => {
    const system: string[] = [];
    const rt = await runtimeWith([
      { name: "first", sections: { memory: "first text" } },
      { name: "second", sections: { memory: "second text" } },
    ]);
    const session = createSession({ provider: capture(system), cwd: tmpDir(), extensions: rt });
    await session.send("hi");
    await session.dispose();
    expect(system[0]).toContain("first text");
    expect(system[0]).not.toContain("second text");
    const failed = session.history().filter((e) => e.type === "extension_failed") as Extract<
      AgentEvent,
      { type: "extension_failed" }
    >[];
    expect(failed.find((f) => f.name === "second" && f.reason === "section_contested")).toBeTruthy();
  });

  test("`null` hides a section, recorded as hidden — never a silent omission", async () => {
    const system: string[] = [];
    const rt = await runtimeWith([{ name: "hider", sections: { memory: null } }]);
    const session = createSession({ provider: capture(system), cwd: tmpDir(), extensions: rt });
    await session.send("hi");
    await session.dispose();
    expect(system[0]).not.toContain("## Memory");
    const over = session.history().find((e) => e.type === "prompt_override") as Extract<
      AgentEvent,
      { type: "prompt_override" }
    >;
    expect(over).toMatchObject({ section: "memory", extension: "hider", version: "1.2.0", mode: "hidden" });
  });

  test("`prompt_override` lands once per composition change, not once per call", async () => {
    const system: string[] = [];
    const rt = await runtimeWith([{ name: "mem-ext", sections: { memory: "remember this" } }]);
    const session = createSession({ provider: capture(system), cwd: tmpDir(), extensions: rt });
    await session.send("one");
    await session.send("two");
    await session.dispose();
    expect(system.length).toBeGreaterThanOrEqual(2);
    const overrides = session.history().filter((e) => e.type === "prompt_override");
    expect(overrides).toHaveLength(1);
  });

  test("disengagement is recorded: the section restored to core text gets its own record", async () => {
    const system: string[] = [];
    let active = true;
    const rt = new ExtensionRuntime({ mohHome: tmpDir(), consent: () => true });
    await rt.register(
      {
        name: "fleeting",
        version: "1.0.0",
        apiVersion: "1.11",
        capabilities: ["replace-prompt-section:memory"],
        setup: (ctx: { beforeModelCall(h: () => unknown): void }) => {
          ctx.beforeModelCall(() => (active ? { sections: { memory: "temp" } } : {}));
        },
      },
      { bundled: true, manifest: { hash: "f", path: "f", capabilities: ["replace-prompt-section:memory"] } },
    );
    const session = createSession({ provider: capture(system), cwd: tmpDir(), extensions: rt });
    await session.send("one");
    active = false;
    await session.send("two");
    await session.dispose();
    expect(system[1]).not.toContain("temp");
    const restored = session.history().filter((e) => e.type === "prompt_override") as Extract<
      AgentEvent,
      { type: "prompt_override" }
    >[];
    expect(restored.find((e) => e.section === "memory" && e.mode === "restored")).toBeTruthy();
  });

  test("the borrowed surface (toolHooks, no owned runtime) composes replacements with its own chrome", async () => {
    const system: string[] = [];
    const rt = await runtimeWith([{ name: "mem-ext", sections: { memory: "borrowed text" } }]);
    const session = createSession({
      provider: capture(system),
      cwd: tmpDir(),
      // #784 shape: a child owns no runtime; it borrows the dispatch.
      toolHooks: rt as never,
    });
    await session.send("hi");
    await session.dispose();
    expect(system[0]).toContain("borrowed text");
    expect(session.history().some((e) => e.type === "prompt_override")).toBe(true);
  });

  test("replay reconstructs what was in force: the log names section, author, version and mode", async () => {
    const rt = await runtimeWith([{ name: "mem-ext", sections: { memory: "remember this" } }]);
    const session = createSession({ provider: capture([]), cwd: tmpDir(), extensions: rt });
    await session.send("hi");
    const over = session.history().find((e) => e.type === "prompt_override") as Extract<
      AgentEvent,
      { type: "prompt_override" }
    >;
    expect(over).toMatchObject({ section: "memory", extension: "mem-ext", version: "1.2.0", mode: "replaced" });
    // The words never enter the log.
    expect(JSON.stringify(over)).not.toContain("remember this");
    await session.dispose();
    expect(join(".")).toBeTruthy();
  });
});

// Keep the type-level import honest: systemOf is intentionally unused.
void systemOf;
