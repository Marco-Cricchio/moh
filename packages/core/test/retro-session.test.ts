import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { AgentSession, MockProvider } from "../src/index";
import type { Tool } from "../src/types";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "retro-session-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function sessionWithRetro(dir: string, retro: Record<string, unknown>) {
  const bash: Tool = {
    name: "bash",
    description: "run a shell command",
    inputSchema: undefined,
    execute: () => "ok",
  };
  return new AgentSession({
    provider: MockProvider.scripted([
      { deltas: [""], finish: "tool_calls" as const, toolCalls: [{ name: "bash", args: { command: "echo hi" } }] },
      { deltas: ["done"], finish: "stop" as const },
    ]),
    cwd: dir,
    tools: { bash },
    permissions: { unrestrictedTools: true },
    retro: { dir: join(dir, "retro"), ...retro } as never,
  });
}

describe("retro report seams (#1275)", () => {
  /** Seeds the store a digest would fire from. */
  function seedFinding(dir: string): void {
    const storeDir = join(dir, "retro");
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(
      join(storeDir, "findings.jsonl"),
      JSON.stringify({
        category: "navigation",
        evidence: "spent 12 calls locating the session store",
        confidence: 0.7,
        session: "earlier",
        signature: "sig-nav",
        appendedAt: new Date().toISOString(),
      }) + "\n",
    );
  }

  test("opening the report suppresses the digest and the reviewed batch is not re-digested", async () => {
    const dir = tempDir();
    seedFinding(dir);
    const first = sessionWithRetro(dir, {});
    expect(first.history().filter((e) => e.type === "retro_digest")).toHaveLength(1);
    expect(first.retroReport()?.findings).toHaveLength(1);
    // The report opens: the digest for the next session is suppressed and
    // the reviewed batch's timestamp moves, so it is not re-reported.
    first.suppressRetroDigest();
    await first.dispose();

    const second = sessionWithRetro(dir, {});
    expect(second.history().filter((e) => e.type === "retro_digest")).toHaveLength(0);
    await second.dispose();
  });

  test("the session owns the report and the dismissal, so the store it configured is the one written", async () => {
    const dir = tempDir();
    seedFinding(dir);
    const session = sessionWithRetro(dir, {});
    const finding = session.retroReport()?.findings[0];
    expect(finding?.category).toBe("navigation");
    session.retroDismiss(finding!.signature, finding!.category);
    expect(session.retroReport()?.findings).toEqual([]);
    expect(readFileSync(join(dir, "retro", "dismissed.json"), "utf8")).toContain(finding!.signature);
    await session.dispose();
  });

  test("retro.enabled: false means no report at all, never an empty one", async () => {
    const dir = tempDir();
    const session = sessionWithRetro(dir, { enabled: false });
    expect(session.retroReport()).toBeNull();
    await session.dispose();
  });
});

describe("retro session integration", () => {
  test("digest on session start after findings accumulated; rate-limited after", async () => {
    const dir = tempDir();
    // Seed the store with a finding so a digest is due.
    const storeDir = join(dir, "retro");
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(
      join(storeDir, "findings.jsonl"),
      JSON.stringify({
        category: "missing-guardrail",
        evidence: "package.json defines `test` but no pre-commit hook runs it",
        confidence: 0.8,
        session: "earlier",
        signature: "sig-1",
        appendedAt: new Date().toISOString(),
      }) + "\n",
    );

    const second = sessionWithRetro(dir, {});
    void second.history();
    expect(second.history().filter((e) => e.type === "retro_digest")).toHaveLength(1);
    await second.send("hello");
    await second.dispose();

    // A later open within 48h: rate-limited, no second digest.
    const third = sessionWithRetro(dir, {});
    expect(third.history().filter((e) => e.type === "retro_digest")).toHaveLength(0);
    await third.dispose();
  });

  test("no digest on a fresh store", async () => {
    const dir = tempDir();
    const session = sessionWithRetro(dir, {});
    expect(session.history().filter((e) => e.type === "retro_digest")).toHaveLength(0);
    await session.dispose();
  });

  test("disabled retro writes nothing and emits nothing", async () => {
    const dir = tempDir();
    const session = sessionWithRetro(dir, { enabled: false });
    await session.send("hello");
    await session.dispose();
    const events = session.history();
    expect(events.some((e) => e.type === "retro_digest")).toBe(false);
    expect(events.some((e) => e.type === "retro_updated")).toBe(false);
    expect(existsSync(join(dir, "retro"))).toBe(false);
  });

  test("dispose extraction appends findings and emits a count-only retro_updated", async () => {
    const dir = tempDir();
    // package.json with a test script but no hook/CI wiring -> missing-guardrail.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
    const session = sessionWithRetro(dir, {});
    await session.send("run the test suite");
    await session.dispose();

    const events = session.history();
    expect(events.some((e) => e.type === "retro_updated")).toBe(true);
    const storeDir = join(dir, "retro");
    expect(existsSync(join(storeDir, "findings.jsonl"))).toBe(true);
    const lines = readFileSync(join(storeDir, "findings.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const finding = JSON.parse(line);
      expect(typeof finding.category).toBe("string");
      expect(typeof finding.signature).toBe("string");
    }
  });
});
