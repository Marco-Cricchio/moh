/**
 * The checks extension (ADR-0080, #1633 slices 4b–4c), end to end: a real
 * session over a real git repository, the real bash and git tools, a
 * scripted model. Report-only failures reach the footer status and one
 * `checks` event; a failing `block: true` check becomes a correction turn.
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

type Check = Parameters<typeof createChecksExtension>[0][number];
type Turns = Parameters<typeof MockProvider.scripted>[0];

const CHECKS: Check[] = [
  { name: "ok", run: "true" },
  { name: "dup", run: "echo 'clone found'; exit 3" },
];

/** One scripted model turn that writes `path`, then stops. */
const writes = (path: string, content: string): Turns => [
  { deltas: ["editing"], finish: "tool_calls", toolCalls: [{ name: "write", args: { path, content } }] },
  { deltas: ["done"], finish: "stop" },
];

async function session(cwd: string, turns: Turns, checks: readonly Check[] = CHECKS) {
  const runtime = new ExtensionRuntime({ mohHome: mkdtempSync(join(tmpdir(), "moh-checks-home-")), projectRoot: cwd, consent: () => true });
  await runtime.register(createChecksExtension(checks));
  const s = createSession({ provider: MockProvider.scripted(turns), tools: builtinTools(), cwd, extensions: runtime, permissions: { mode: "auto-accept" } });
  return { s, runtime };
}

/** Waits for `ready`, or fails naming the stuck step. */
async function until(step: string, ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`stuck: ${step}`);
    await Bun.sleep(25);
  }
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
    const { s, runtime } = await session(cwd, writes("b.ts", "export const b = 2;\n"));
    expect((await s.send("add b")).status).toBe("done");
    const event = await checksEvent(() => s.history());
    const results = (event.payload as { results: { name: string; outcome: string; block: boolean; tail: string }[] }).results;
    expect(results.map((r) => [r.name, r.outcome, r.block])).toEqual([
      ["ok", "pass", false],
      ["dup", "fail", false],
    ]);
    expect(results[1]!.tail).toContain("clone found");
    expect(runtime.statuses().map((st) => st.text)).toContain("checks: dup ✗");
    // Report only: nothing reached the model — the scripted second call was its last.
    expect(s.history().filter((e) => e.type === "user_message")).toHaveLength(1);
    await s.dispose();
  }, 30_000);

  test("a turn that only talks runs nothing", async () => {
    const cwd = repo();
    const { s, runtime } = await session(cwd, [{ deltas: ["just an answer"], finish: "stop" }]);
    await s.send("what is a?");
    await Bun.sleep(500); // a negative assertion over an interval
    expect(s.history().some((e) => e.type === "extension_event" && e.name === "checks")).toBe(false);
    expect(runtime.statuses()).toHaveLength(0);
    await s.dispose();
  }, 30_000);
});

describe("checks extension: resolve-before-done (block: true)", () => {
  const synthetic = (s: { history(): readonly AgentEvent[] }) =>
    s.history().filter((e) => e.type === "user_message" && (e as { synthetic?: boolean }).synthetic === true) as { text: string }[];

  test("a failing blocking check becomes a correction turn; a fix that changes the tree re-runs it to green", async () => {
    const cwd = repo();
    const { s, runtime } = await session(cwd, [...writes("b.ts", "broken\n"), ...writes("b.ts", "fixed\n")], [
      { name: "fixed", run: "cat b.ts; grep -q fixed b.ts", block: true },
    ]);
    await s.send("add b");
    await until("re-run to green", () => runtime.statuses().some((st) => st.text === "checks ✓"));
    const corrections = synthetic(s);
    expect(corrections).toHaveLength(1);
    expect(corrections[0]!.text).toContain("### fixed");
    expect(corrections[0]!.text).toContain("broken"); // the failing output's tail
    await s.dispose();
  }, 30_000);

  test("after two correction turns the core refuses a third and the footer stays unresolved", async () => {
    const cwd = repo();
    const { s, runtime } = await session(cwd, [...writes("b.ts", "1\n"), ...writes("c.ts", "2\n"), ...writes("d.ts", "3\n")], [
      { name: "dup", run: "echo 'clone found'; exit 3", block: true },
    ]);
    await s.send("add b");
    await until("unresolved footer", () => runtime.statuses().some((st) => st.text === "checks: dup ✗ (unresolved)"));
    expect(synthetic(s)).toHaveLength(2);
    expect(s.history().filter((e) => e.type === "extension_event" && e.name === "checks")).toHaveLength(3);
    await s.dispose();
  }, 30_000);

  test("a correction turn that changes nothing leaves the failure unresolved", async () => {
    const cwd = repo();
    const { s, runtime } = await session(cwd, [...writes("b.ts", "1\n"), { deltas: ["I cannot fix it"], finish: "stop" }], [
      { name: "dup", run: "exit 3", block: true },
    ]);
    await s.send("add b");
    await until("unresolved footer", () => runtime.statuses().some((st) => st.text === "checks: dup ✗ (unresolved)"));
    expect(synthetic(s)).toHaveLength(1);
    await s.dispose();
  }, 30_000);
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
