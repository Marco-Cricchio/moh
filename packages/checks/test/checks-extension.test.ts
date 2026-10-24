/**
 * The checks extension (ADR-0080, #1633 slice 4b), end to end: a real
 * session over a real git repository, the real bash and git tools, a
 * scripted model. Report mode — the outcome reaches the footer status and
 * one `checks` event; the model never sees it.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinTools, createSession, ExtensionRuntime, MockProvider, type AgentEvent } from "@moh/core";
import { checksBundledSource, createChecksExtension } from "../src/index";

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "moh-checks-"));
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", ...args], { cwd });
  git("init", "-q");
  writeFileSync(join(cwd, "a.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return cwd;
}

const CHECKS = [
  { name: "ok", run: "true" },
  { name: "dup", run: "echo 'clone found'; exit 3", block: true },
];

async function session(cwd: string, turns: Parameters<typeof MockProvider.scripted>[0]) {
  const runtime = new ExtensionRuntime({ mohHome: mkdtempSync(join(tmpdir(), "moh-checks-home-")), projectRoot: cwd, consent: () => true });
  await runtime.register(createChecksExtension(CHECKS));
  const s = createSession({ provider: MockProvider.scripted(turns), tools: builtinTools(), cwd, extensions: runtime, permissions: { mode: "auto-accept" } });
  return { s, runtime };
}

/** Waits for the run's `checks` event, or fails naming the stuck step. */
async function checksEvent(history: () => readonly AgentEvent[]) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const event = history().find((e) => e.type === "extension_event" && e.name === "checks");
    if (event) return event as Extract<AgentEvent, { type: "extension_event" }>;
    await Bun.sleep(25);
  }
  throw new Error("no checks event within 15 s");
}

describe("checks extension: report mode", () => {
  test("a turn that changes the tree runs every check in order and reports the outcome", async () => {
    const cwd = repo();
    const { s, runtime } = await session(cwd, [
      { deltas: ["editing"], finish: "tool_calls", toolCalls: [{ name: "write", args: { path: "b.ts", content: "export const b = 2;\n" } }] },
      { deltas: ["done"], finish: "stop" },
    ]);
    expect((await s.send("add b")).status).toBe("done");
    const event = await checksEvent(() => s.history());
    const results = (event.payload as { results: { name: string; outcome: string; block: boolean; tail: string }[] }).results;
    expect(results.map((r) => [r.name, r.outcome, r.block])).toEqual([
      ["ok", "pass", false],
      ["dup", "fail", true],
    ]);
    expect(results[1]!.tail).toContain("clone found");
    expect(runtime.statuses().map((st) => st.text)).toContain("checks: dup ✗");
    // Report mode: nothing reached the model — the scripted second turn was its last call.
    expect(s.history().filter((e) => e.type === "user_message")).toHaveLength(1);
    await s.dispose();
  });

  test("a turn that only talks runs nothing", async () => {
    const cwd = repo();
    const { s, runtime } = await session(cwd, [{ deltas: ["just an answer"], finish: "stop" }]);
    await s.send("what is a?");
    await Bun.sleep(500); // a negative assertion over an interval
    expect(s.history().some((e) => e.type === "extension_event" && e.name === "checks")).toBe(false);
    expect(runtime.statuses()).toHaveLength(0);
    await s.dispose();
  });
});

describe("checks bundled descriptor", () => {
  const context = (checks?: typeof CHECKS) => ({ cwd: "/repo", ...(checks ? { checks } : {}) });

  test("declines when the project declares no checks", () => {
    expect(checksBundledSource.activate(context())).toBeNull();
    expect(checksBundledSource.activate(context([]))).toBeNull();
    expect(checksBundledSource.activate(context(CHECKS))).not.toBeNull();
  });

  test("the consent names the exact commands, per project, and changes with them", () => {
    const manifest = checksBundledSource.manifest(context(CHECKS));
    expect(manifest.path).toBe("checks:/repo");
    expect(manifest.reasoning).toContain("- dup: echo 'clone found'; exit 3");
    const edited = checksBundledSource.manifest(context([{ ...CHECKS[0]! }]));
    expect(edited.hash).not.toBe(manifest.hash);
  });
});
