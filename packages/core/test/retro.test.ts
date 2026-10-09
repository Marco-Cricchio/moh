/**
 * Retro findings (ADR-0075, #1274): the accumulation half — store,
 * deterministic extraction, dismissed-signature suppression, 48h digest.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { RetroStore, extractRetroFindings, retroSignature, RETRO_MAX_FINDINGS } from "../src/retro";
import type { AgentEvent } from "../src/types";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "retro-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function candidate(overrides: Partial<{ category: string; evidence: string; session: string; signature: string }> = {}) {
  return {
    category: "missing-guardrail",
    evidence: "package.json defines `test` but no pre-commit hook runs it",
    confidence: 0.8,
    session: "session-a",
    signature: retroSignature("missing-guardrail", "pre-commit:unwired"),
    ...overrides,
  };
}

function toolCall(name: string, args: unknown) {
  return { type: "tool_call" as const, callId: `c-${Math.random().toString(36).slice(2)}`, name, args };
}
function toolResult(callId: string, ok = true, errorKind?: "timeout") {
  return { type: "tool_result" as const, callId, ok, output: "", ...(errorKind ? { errorKind } : {}) };
}

describe("RetroStore", () => {
  test("appends, dedups by signature, and stamps appendedAt", () => {
    const store = new RetroStore(tempDir());
    expect(store.append([candidate()])).toBe(1);
    // same signature again: no second entry
    expect(store.append([candidate({ session: "session-b" })])).toBe(0);
    const findings = store.read();
    expect(findings).toHaveLength(1);
    expect(findings[0]!.appendedAt).toBeTruthy();
    expect(findings[0]!.session).toBe("session-a");
  });

  test("a new signature is a new finding", () => {
    const store = new RetroStore(tempDir());
    store.append([candidate()]);
    expect(store.append([candidate({ signature: retroSignature("missing-guardrail", "ci:unwired") })])).toBe(1);
    expect(store.read()).toHaveLength(2);
  });

  test("dismissed signatures are suppressed; new signatures still append", () => {
    const store = new RetroStore(tempDir());
    const sig = retroSignature("missing-guardrail", "pre-commit:unwired");
    store.append([candidate()]);
    store.dismiss(sig);
    expect(store.dismissed().has(sig)).toBe(true);
    // dismissed: re-append across sessions is suppressed (the no-loop rule)
    expect(store.append([candidate({ session: "session-c" })])).toBe(0);
    // a materially new observation is a new, eligible finding
    expect(store.append([candidate({ signature: retroSignature("missing-guardrail", "ci:unwired") })])).toBe(1);
  });

  test("store is bounded: oldest findings are evicted beyond the cap", () => {
    const store = new RetroStore(tempDir());
    const now = new Date("2026-01-01T00:00:00Z");
    for (let i = 0; i < RETRO_MAX_FINDINGS + 5; i++) {
      store.append([candidate({ signature: `sig-${String(i).padStart(4, "0")}` })], new Date(now.getTime() + i * 1000));
    }
    const findings = store.read();
    expect(findings).toHaveLength(RETRO_MAX_FINDINGS);
    expect(findings[0]!.signature).toBe("sig-0005"); // oldest evicted first
    expect(findings.at(-1)!.signature).toBe(`sig-${String(RETRO_MAX_FINDINGS + 4).padStart(4, "0")}`);
  });

  test("evidence is redacted at persistence (ADR-0058)", () => {
    const store = new RetroStore(tempDir());
    store.append([candidate({ evidence: "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 in output" })]);
    const raw = require("node:fs").readFileSync(store.findingsFile, "utf8") as string;
    expect(raw).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    expect(raw).toContain("[redacted]");
  });

  test("categories are plain strings — no migration, no enum", () => {
    const store = new RetroStore(tempDir());
    store.append([candidate({ category: "navigation", signature: "sig-nav" })]);
    store.append([candidate({ category: "some-future-category", signature: "sig-future" })]);
    expect(store.read().map((f) => f.category)).toEqual(["navigation", "some-future-category"]);
  });

  test("a closed session with no findings writes nothing", () => {
    const dir = tempDir();
    const store = new RetroStore(dir);
    store.append([candidate()]);
    rmSync(dir, { recursive: true, force: true });
    expect(extractRetroFindings([], { cwd: dir, session: "s" })).toEqual([]);
    expect(store.append([])).toBe(0);
    expect(require("node:fs").existsSync(store.findingsFile)).toBe(false);
  });

  test("corrupt store file reads as empty and append recovers", () => {
    const store = new RetroStore(tempDir());
    mkdirSync(store.dir, { recursive: true });
    writeFileSync(store.findingsFile, "{torn line\n", "utf8");
    expect(store.read()).toHaveLength(0);
    expect(store.append([candidate()])).toBe(1);
    expect(store.read()).toHaveLength(1);
  });
});

describe("digest", () => {
  test("fires once, then is rate-limited to 48h", () => {
    const store = new RetroStore(tempDir());
    const t0 = new Date("2026-01-01T00:00:00Z");
    store.append([candidate()], t0);
    const first = store.maybeDigest(t0);
    expect(first?.count).toBe(1);
    expect(first?.line).toContain("moh retro");
    // 1h later: nothing new, nothing shown
    expect(store.maybeDigest(new Date(t0.getTime() + 3600_000))).toBeNull();
    // 24h later, new findings: still rate-limited
    store.append([candidate({ signature: "sig-x" })], new Date(t0.getTime() + 86_400_000));
    expect(store.maybeDigest(new Date(t0.getTime() + 86_400_000))).toBeNull();
    // 48h later: fires again, counting only what accumulated since the last digest
    const second = store.maybeDigest(new Date(t0.getTime() + 2 * 86_400_000));
    expect(second?.count).toBe(1);
  });

  test("no new findings since the last digest: silent", () => {
    const store = new RetroStore(tempDir());
    const t0 = new Date("2026-01-01T00:00:00Z");
    store.append([candidate()], new Date(t0.getTime() - 3 * 86_400_000));
    store.maybeDigest(t0);
    store.append([candidate({ signature: "sig-old" })], new Date(t0.getTime() - 86_400_000)); // predates the digest
    expect(store.maybeDigest(new Date(t0.getTime() + 3 * 86_400_000))).toBeNull();
  });

  test("reportOpen suppresses the line and moves the timestamp", () => {
    const store = new RetroStore(tempDir());
    const t0 = new Date("2026-01-01T00:00:00Z");
    store.append([candidate()]);
    expect(store.maybeDigest(t0, { reportOpen: true })?.count).toBe(0);
    // suppressed, not digested: the reviewed batch is not re-digested later
    expect(store.maybeDigest(new Date(t0.getTime() + 3600_000))).toBeNull();
  });
});

describe("deterministic extraction", () => {
  function repo(cwd: string, opts: { scripts?: boolean; preCommit?: boolean; ci?: string } = {}) {
    if (opts.scripts) {
      writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { lint: "eslint .", test: "bun test" } }));
    }
    if (opts.preCommit) {
      writeFileSync(join(cwd, ".git", "hooks", "pre-commit"), "#!/bin/sh\nbun run lint\n");
      chmodSync(join(cwd, ".git", "hooks", "pre-commit"), 0o755);
    }
    if (opts.ci) {
      mkdirSync(join(cwd, ".github", "workflows"), { recursive: true });
      writeFileSync(join(cwd, ".github", "workflows", "ci.yml"), opts.ci);
    }
  }

  function prepareRepo(opts: Parameters<typeof repo>[1]): string {
    const cwd = tempDir();
    mkdirSync(join(cwd, ".git", "hooks"), { recursive: true });
    repo(cwd, opts);
    return cwd;
  }

  test("missing guardrail: existing-but-unwired checks are the finding", () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, ".git", "hooks"), { recursive: true });
    repo(cwd, { scripts: true });
    const events = [toolCall("edit", { path: "a.ts" }), toolResult("x", true)];
    const findings = extractRetroFindings(events, { cwd, session: "s1" });
    const sigs = findings.map((f) => f.signature);
    expect(sigs).toContain(retroSignature("missing-guardrail", "pre-commit:unwired"));
    expect(sigs).toContain(retroSignature("missing-guardrail", "ci:unwired"));
    expect(findings.every((f) => f.confidence > 0 && f.category === "missing-guardrail")).toBe(true);
  });

  test("wired checks produce no guardrail finding", () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, ".git", "hooks"), { recursive: true });
    repo(cwd, {
      scripts: true,
      preCommit: true,
      ci: "jobs:\n  lint:\n    steps:\n      - run: bun run lint\n  test:\n    - run: bun test\n",
    });
    const findings = extractRetroFindings([toolCall("edit", {})], { cwd, session: "s1" });
    expect(findings.filter((f) => f.category === "missing-guardrail")).toHaveLength(0);
  });

  test("a session that used no tools produces nothing", () => {
    const cwd = tempDir();
    repo(cwd, { scripts: true });
    expect(extractRetroFindings([{ type: "user_message", text: "hi" } as AgentEvent], { cwd, session: "s" })).toEqual([]);
  });

  test("tool economy: repeated identical bash commands and timeout patterns", () => {
    const cwd = tempDir();
    const command = "bun test packages/core/test/big.test.ts";
    const a = toolCall("bash", { command });
    const b = toolCall("bash", { command });
    const c = toolCall("bash", { command: "bun run lint" });
    const log: AgentEvent[] = [a, b, c, toolResult(a.callId, true), toolResult(b.callId, true), toolResult(c.callId, false, "timeout")];
    // two identical calls stay below the threshold; the lint call differs
    expect(extractRetroFindings(log, { cwd, session: "s1" }).filter((f) => f.category === "tool-economy")).toHaveLength(0);
    const d = toolCall("bash", { command });
    const findings = extractRetroFindings([...log, d, toolResult(d.callId, true)], { cwd, session: "s1" });
    const repeatFinding = findings.find((f) => f.signature === retroSignature("tool-economy", `bash-repeat:${command}`));
    expect(repeatFinding?.evidence).toContain("3 times");
    expect(findings.find((f) => f.signature === retroSignature("tool-economy", "timeouts"))).toBeUndefined();
  });

  test("timeout pattern: two or more timeouts are one finding", () => {
    const cwd = tempDir();
    const a = toolCall("bash", { command: "a" });
    const b = toolCall("bash", { command: "b" });
    const c = toolCall("bash", { command: "c" });
    const log = [a, b, c, toolResult(a.callId, false, "timeout"), toolResult(b.callId, false, "timeout"), toolResult(c.callId, true)];
    const findings = extractRetroFindings(log, { cwd, session: "s1" });
    expect(findings.filter((f) => f.signature === retroSignature("tool-economy", "timeouts"))).toHaveLength(1);
  });

  test("the same event log always produces the same findings", () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, ".git", "hooks"), { recursive: true });
    repo(cwd, { scripts: true });
    const log = [
      toolCall("bash", { command: "bun test x.test.ts" }),
      toolCall("bash", { command: "bun test x.test.ts" }),
      toolCall("bash", { command: "bun test x.test.ts" }),
      toolCall("edit", { path: "a.ts" }),
    ];
    const first = extractRetroFindings(log, { cwd, session: "s1" });
    const second = extractRetroFindings(log, { cwd, session: "s1" });
    expect(second).toEqual(first);
    // and the store round-trips them deterministically
    const store = new RetroStore(tempDir());
    store.append(first);
    expect(store.read().map((f) => f.signature)).toEqual(first.map((f) => f.signature));
  });
});

describe("retro report", () => {
  test("orders findings and exposes same-category dismissal lineage", () => {
    const dir = tempDir();
    const store = new RetroStore(dir);
    const first = candidate({ category: "navigation", evidence: "missing pointer", session: "session-1", signature: retroSignature("navigation", "missing pointer") });
    store.append([first], new Date("2026-01-01T00:00:00Z"));
    store.dismiss(first.signature, new Date("2026-01-02T00:00:00Z"));
    const second = candidate({ category: "navigation", evidence: "new pointer", session: "session-2", signature: retroSignature("navigation", "new pointer") });
    store.append([second], new Date("2026-01-03T00:00:00Z"));
    const report = store.report();
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.priorDismissals).toHaveLength(1);
    expect(report.findings[0]?.lineage).toBe("2026-01-02T00:00:00.000Z");
    expect(report.dismissed[0]?.signature).toBe(first.signature);
  });
});
