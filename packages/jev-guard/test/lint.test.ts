/**
 * Quality gate tests (#789): the judge (questions, threshold boundary,
 * record shape), the gate runner (inertness, deterministic correction
 * text, the two-cycle cap that never re-gates a correction turn, and the
 * pass path) — all against a fake client, no network in CI.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JevAnswer, JevJudgeInput } from "../src/client";
import { correctionText, containsCodeChanges, LINT_THRESHOLDS } from "../src/lint";
import { scopePaths } from "../src/lint-gate";
import { createLintJudge, type LintState } from "../src/lint-judge";
import { createLintGate, createLintTaskState, LINT_MAX_CYCLES } from "../src/lint-gate";
import { discoverRubrics } from "../src/rubrics";

const noul = (p: number): JevAnswer => ({ type: "noul", noul: p });

/** A fake client that answers all three questions from a script. */
function fakeClient(script: (input: JevJudgeInput) => Record<string, JevAnswer>) {
  const calls: JevJudgeInput[] = [];
  return {
    calls,
    client: {
      async judge(input: JevJudgeInput) {
        calls.push(input);
        const answers = script(input);
        // The real client invokes `record` with the answers; the judge
        // relies on that to see them.
        input.record(answers, { model: "jev-latest", latencyMs: 12, usage: { inputTokens: 100, outputTokens: 10 } });
        return {
          ok: true as const,
          answers,
          model: "jev-latest",
          latencyMs: 12,
          usage: { inputTokens: 100, outputTokens: 10 },
        };
      },
    },
  };
}

const RUBRICS = [{ path: "AGENTS.md", text: "handle every error" }];
const STATE: LintState = {
  rules: "# AGENTS.md\nhandle every error",
  rulesFiles: ["AGENTS.md"],
  changes: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
  diffBytes: 60,
};

const PASS_ANSWERS = {
  conventions_respected: noul(0.9),
  error_handling: noul(0.9),
  completeness: noul(0.9),
};

describe("lint judge (#789)", () => {
  test("pass: all three above threshold → one event, decision pass", async () => {
    const records: Record<string, unknown>[] = [];
    const { client, calls } = fakeClient(() => PASS_ANSWERS);
    const judge = createLintJudge({ client, append: (p) => records.push(p) });
    const verdict = await judge.evaluate(STATE, 0);
    expect(verdict?.decision).toBe("pass");
    expect(verdict?.findings).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ useCase: "lint", cycle: 0, decision: "pass", diffBytes: 60 });
    expect((records[0] as any).model).toBe("jev-latest");
    // The judged state is exactly rules + changes.
    expect(calls[0]!.state).toMatchObject({ rules: STATE.rules, changes: STATE.changes });
    expect(Object.keys(calls[0]!.questions).sort()).toEqual(["completeness", "conventions_respected", "error_handling"]);
  });

  test("threshold boundary: 0.39 is a finding, 0.40 is not", async () => {
    const records: Record<string, unknown>[] = [];
    const { client } = fakeClient(() => ({ ...PASS_ANSWERS, error_handling: noul(0.39) }));
    const judge = createLintJudge({ client, append: (p) => records.push(p) });
    const verdict = await judge.evaluate(STATE, 0);
    expect(verdict?.findings).toEqual(["error_handling"]);
    expect(verdict?.decision).toBe("correct");
    expect(LINT_THRESHOLDS.LINT_ALERT).toBe(0.4);

    const records2: Record<string, unknown>[] = [];
    const { client: client2 } = fakeClient(() => ({ ...PASS_ANSWERS, error_handling: noul(0.4) }));
    const judge2 = createLintJudge({ client: client2, append: (p) => records2.push(p) });
    const verdict2 = await judge2.evaluate(STATE, 0);
    expect(verdict2?.findings).toEqual([]);
  });

  test("fail-open: a failed call appends nothing and yields no verdict", async () => {
    const records: Record<string, unknown>[] = [];
    const judge = createLintJudge({
      client: { judge: async () => ({ ok: false as const, kind: "network", message: "down" }) },
      append: (p) => records.push(p),
    });
    expect(await judge.evaluate(STATE, 0)).toBeNull();
    expect(records).toEqual([]);
  });
});

describe("correction copy (#789)", () => {
  test("deterministic, names the failing dimensions, never model-generated", () => {
    const a = correctionText(["error_handling", "completeness"], 0, ["src/a.ts"]);
    const b = correctionText(["error_handling", "completeness"], 0, ["src/a.ts"]);
    expect(a).toBe(b);
    expect(a).toContain("error handling");
    expect(a).toContain("completeness");
    expect(a).toContain("fix");
    expect(a).toContain("src/a.ts");
    expect(correctionText(["conventions_respected"], 0, ["src/a.ts"])).toContain("conventions");
    expect(correctionText(["completeness"], 1, ["src/a.ts"])).toContain("final");
  });

  test("#851: names what was judged (the paths), whatever the count", () => {
    const one = correctionText(["completeness"], 0, ["src/one.ts"]);
    expect(one).toContain("Judged files: src/one.ts");
    const many = correctionText(["completeness"], 0, ["src/a.ts", "src/b.ts"]);
    expect(many).toContain("Judged files: src/a.ts, src/b.ts");
  });
});

describe("#851: judged-set scoping", () => {
  // scopePaths checks existence on the real fs, so the fixture root is
  // materialized in /tmp per test.
  const root = mkdtempSync(join(tmpdir(), "jev-scope-root-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "x\n");

  test("a relative in-root path is kept", () => {
    expect(scopePaths(root, ["src/a.ts"])).toEqual(["src/a.ts"]);
  });

  test("an absolute path inside the root is kept, repo-relative", () => {
    expect(scopePaths(root, [join(root, "src/a.ts")])).toEqual(["src/a.ts"]);
  });

  test("a path outside the root is dropped (refused writes contribute nothing)", () => {
    expect(scopePaths(root, ["/tmp/moh-triage/draft.md"])).toEqual([]);
  });

  test("a path that does not exist is dropped (a refused call never created it)", () => {
    expect(scopePaths(root, ["src/never-created.ts"])).toEqual([]);
  });

  test("an existing outside-root file is dropped even though it is on disk", () => {
    const existing = mkdtempSync(join(tmpdir(), "jev-scope-"));
    try {
      const outside = join(existing, "draft.md");
      writeFileSync(outside, "text\n");
      expect(scopePaths(root, [outside])).toEqual([]);
    } finally {
      rmSync(existing, { recursive: true, force: true });
    }
  });

  test("deduplicated, repo-relative", () => {
    expect(scopePaths(root, ["src/a.ts", join(root, "src/a.ts")])).toEqual(["src/a.ts"]);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
});

describe("#851: code-rubric gate", () => {
  test("a diff touching only non-code text is not judged with the code questions", () => {
    const docs = "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old prose\n+new prose\n";
    expect(containsCodeChanges(docs)).toBe(false);
  });

  test("a diff touching repository code is judged", () => {
    const code = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    expect(containsCodeChanges(code)).toBe(true);
  });
});

describe("lint gate runner (#789)", () => {
  function fakeFsRoot(files: Record<string, string>) {
    return files;
  }
  // The gate reads the real filesystem through `discoverRubrics(deps.root)`:
  // a fixture directory is materialized in /tmp per test.
  function fixtureRoot(files: Record<string, string> = { "AGENTS.md": "handle every error\n" }): string {
    const dir = mkdtempSync(join(tmpdir(), "jev-lint-"));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    // A real repo with one initial commit: the gate diffs against HEAD.
    const git = (args: string) => execFileSync("git", args.split(" "), { cwd: dir });
    git("init -q");
    git("config user.email t@t");
    git("config user.name t");
    git("add .");
    git("commit -qm init");
    return dir;
  }

  test("golden set: a convention-violating diff produces a correction turn; a clean one does not", async () => {
    const root = fixtureRoot();
    try {
      // The task's change: a new file whose content ignores error handling.
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "a.ts"), "export function risky(): number { return (null as any).x; }\n");
      const { client } = fakeClient(() => ({
        ...PASS_ANSWERS,
        error_handling: noul(0.2), // a diff that ignores error handling
      }));
      const requests: string[] = [];
      const stops: { reason: string; findings?: string[] }[] = [];
      const gate = createLintGate(
        {
          judge: createLintJudge({ client, append: () => {} }),
          root,
          requestTurn: async (text) => {
            requests.push(text);
            return true;
          },
          reportStop: (reason, findings) => stops.push({ reason, findings: [...findings] }),
        },
        createLintTaskState(),
      );
      gate.observeToolCall("write", { path: "src/a.ts" });
      const evaluations = await gate.onTaskEnd();
      // Cycle 1 corrects; the fake requestTurn does not change the diff,
      // so cycle 2 finds again and corrects once more; then the cap holds.
      expect(evaluations).toBe(2);
      expect(requests).toHaveLength(2);
      expect(requests[0]).toContain("error handling");
      expect(requests[1]).toContain("final");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("pass: one event, no correction turn", async () => {
    const root = fixtureRoot();
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "b.ts"), "export const ok = 1;\n");
      const { client } = fakeClient(() => PASS_ANSWERS);
      const requests: string[] = [];
      const stops: { reason: string; findings?: string[] }[] = [];
      const gate = createLintGate(
        {
          judge: createLintJudge({ client, append: () => {} }),
          root,
          requestTurn: async (text) => {
            requests.push(text);
            return true;
          },
          reportStop: (reason, findings) => stops.push({ reason, findings: [...findings] }),
        },
        createLintTaskState(),
      );
      gate.observeToolCall("edit", { path: "src/b.ts" });
      const evaluations = await gate.onTaskEnd();
      expect(evaluations).toBe(1);
      expect(requests).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("inert: no rubric docs → no request, no event", async () => {
    const root = fixtureRoot({ "README.md": "not a rubric" });
    try {
      let calls = 0;
      const { client } = fakeClient(() => {
        calls += 1;
        return PASS_ANSWERS;
      });
      const stops: { reason: string }[] = [];
      const gate = createLintGate(
        { judge: createLintJudge({ client, append: () => {} }), root, requestTurn: async () => true, reportStop: (reason) => stops.push({ reason }) },
        createLintTaskState(),
      );
      gate.observeToolCall("write", { path: "src/a.ts" });
      expect(await gate.onTaskEnd()).toBe(0);
      expect(calls).toBe(0);
      expect(discoverRubrics(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("inert: no changed files", async () => {
    const root = fixtureRoot();
    try {
      let calls = 0;
      const { client } = fakeClient(() => {
        calls += 1;
        return PASS_ANSWERS;
      });
      const stops: { reason: string }[] = [];
      const gate = createLintGate(
        { judge: createLintJudge({ client, append: () => {} }), root, requestTurn: async () => true, reportStop: (reason) => stops.push({ reason }) },
        createLintTaskState(),
      );
      expect(await gate.onTaskEnd()).toBe(0);
      expect(calls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a fake client that always finds problems never exceeds two correction cycles and never re-gates a correction turn", async () => {
    const root = fixtureRoot();
    try {
      const { client } = fakeClient(() => ({
        conventions_respected: noul(0.01),
        error_handling: noul(0.01),
        completeness: noul(0.01),
      }));
      const requests: string[] = [];
      const stops: { reason: string; findings?: string[] }[] = [];
      const taskState = createLintTaskState();
      const gate = createLintGate(
        {
          judge: createLintJudge({ client, append: () => {} }),
          root,
          requestTurn: async (text) => {
            requests.push(text);
            return true;
          },
          reportStop: (reason, findings) => stops.push({ reason, findings: [...findings] }),
        },
        taskState,
      );
      // The correction turn's "work": the gate diffs against the task's
      // starting head, so the changed file must actually exist.
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "a.ts"), "export function broken(): number { return (null as any).x; }\n");
      gate.observeToolCall("write", { path: "src/a.ts" });
      const evaluations = await gate.onTaskEnd();
      // Two evaluate→correct cycles ran; the cap held.
      expect(evaluations).toBe(LINT_MAX_CYCLES);
      expect(requests).toHaveLength(LINT_MAX_CYCLES);
      // The correction turn the gate requested is marked: its own settle
      // is skipped even though it "changed files" again.
      expect(await gate.onTaskEnd()).toBe(0);
      expect(requests).toHaveLength(LINT_MAX_CYCLES);
      // The cycle-cap stop is recorded on the final record (spec §2).
      expect(stops).toEqual([{ reason: "cycle-cap", findings: ["conventions_respected", "error_handling", "completeness"] }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("#851: a write refused outside the project root contributes no path — a task with no repository change performs zero evaluations", async () => {
    const root = fixtureRoot();
    try {
      let calls = 0;
      const { client } = fakeClient(() => {
        calls += 1;
        return PASS_ANSWERS;
      });
      const requests: string[] = [];
      const gate = createLintGate(
        { judge: createLintJudge({ client, append: () => {} }), root, requestTurn: async (t) => { requests.push(t); return true; }, reportStop: () => {} },
        createLintTaskState(),
      );
      // The reproduction: writes at absolute outside-root paths that the
      // tool refused (nothing was created by them).
      gate.observeToolCall("write", { path: "/tmp/moh-triage/draft.md" });
      gate.observeToolCall("write", { path: "/tmp/moh-triage/other.md" });
      expect(await gate.onTaskEnd()).toBe(0);
      expect(calls).toBe(0);
      expect(requests).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("#851: a file outside the work tree is never diffed even when it exists and the call succeeded", async () => {
    const root = fixtureRoot();
    const outside = mkdtempSync(join(tmpdir(), "jev-lint-outside-"));
    try {
      const draft = join(outside, "brief.md");
      writeFileSync(draft, "a triage brief, later materialized by an mv\n");
      let calls = 0;
      const { client } = fakeClient(() => {
        calls += 1;
        return PASS_ANSWERS;
      });
      const gate = createLintGate(
        { judge: createLintJudge({ client, append: () => {} }), root, requestTurn: async () => true, reportStop: () => {} },
        createLintTaskState(),
      );
      gate.observeToolCall("write", { path: draft });
      expect(await gate.onTaskEnd()).toBe(0);
      expect(calls).toBe(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("#851: a judged diff with no repository code produces no correction round", async () => {
    const root = fixtureRoot();
    try {
      // Only a tracked markdown document changed — no code in the diff.
      appendFileSync(join(root, "README.md"), "more prose\n");
      let calls = 0;
      const { client } = fakeClient(() => {
        calls += 1;
        return PASS_ANSWERS;
      });
      const requests: string[] = [];
      const gate = createLintGate(
        { judge: createLintJudge({ client, append: () => {} }), root, requestTurn: async (t) => { requests.push(t); return true; }, reportStop: () => {} },
        createLintTaskState(),
      );
      gate.observeToolCall("edit", { path: "README.md" });
      expect(await gate.onTaskEnd()).toBe(0);
      expect(calls).toBe(0);
      expect(requests).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("#851: the recorded reproduction stays covered — refused write, materialized by a later command, judged at task end", async () => {
    // The exact #851 shape: the task named `/tmp/.../draft.md` in refused
    // writes, a later command created a file there, and an in-root code
    // edit also landed. The judged set is the in-root edit only.
    const root = fixtureRoot();
    const stage = mkdtempSync(join(tmpdir(), "jev-lint-repro-"));
    try {
      const draft = join(stage, "draft.md");
      writeFileSync(draft, "materialized outside the repo\n");
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "a.ts"), "export function risky(): number { return (null as any).x; }\n");
      const { client } = fakeClient(() => ({ ...PASS_ANSWERS, error_handling: noul(0.2) }));
      const requests: string[] = [];
      const gate = createLintGate(
        { judge: createLintJudge({ client, append: () => {} }), root, requestTurn: async (t) => { requests.push(t); return true; }, reportStop: () => {} },
        createLintTaskState(),
      );
      gate.observeToolCall("write", { path: draft }); // refused in the real session
      gate.observeToolCall("write", { path: "src/a.ts" });
      await gate.onTaskEnd();
      // Two cycles (the fake requestTurn never changes the tree), and
      // the corrections name the in-root file only.
      expect(requests).toHaveLength(2);
      expect(requests[0]).toContain("src/a.ts");
      expect(requests[0]).not.toContain(draft);
      expect(requests[1]).toContain("src/a.ts");
      expect(requests[1]).not.toContain(draft);
    } finally {
      rmSync(stage, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("inert outside a git repo (captureHead/git return null via the gate's seams)", async () => {
    // A directory that exists but is not a repo: `inGitRepo` walks the real
    // git binary, so assert through the gate on a tmp dir outside any repo.
    const root = mkdtempSync(join(tmpdir(), "jev-lint-norepo-"));
    try {
      writeFileSync(join(root, "AGENTS.md"), "rules\n");
      let calls = 0;
      const { client } = fakeClient(() => {
        calls += 1;
        return PASS_ANSWERS;
      });
      const stops: { reason: string }[] = [];
      const gate = createLintGate(
        { judge: createLintJudge({ client, append: () => {} }), root, requestTurn: async () => true, reportStop: (reason) => stops.push({ reason }) },
        createLintTaskState(),
      );
      gate.observeToolCall("write", { path: "src/a.ts" });
      expect(await gate.onTaskEnd()).toBe(0);
      expect(calls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
