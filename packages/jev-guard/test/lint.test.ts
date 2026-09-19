/**
 * Quality gate tests (#789): the judge (questions, threshold boundary,
 * record shape), the gate runner (inertness, deterministic correction
 * text, the two-cycle cap that never re-gates a correction turn, and the
 * pass path) — all against a fake client, no network in CI.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JevAnswer, JevJudgeInput } from "../src/client";
import { correctionText, LINT_THRESHOLDS } from "../src/lint";
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
    const a = correctionText(["error_handling", "completeness"], 0);
    const b = correctionText(["error_handling", "completeness"], 0);
    expect(a).toBe(b);
    expect(a).toContain("error handling");
    expect(a).toContain("completeness");
    expect(a).toContain("fix");
    expect(correctionText(["conventions_respected"], 0)).toContain("conventions");
    expect(correctionText(["completeness"], 1)).toContain("final");
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
      const gate = createLintGate(
        {
          judge: createLintJudge({ client, append: () => {} }),
          root,
          requestTurn: async (text) => {
            requests.push(text);
            return true;
          },
        },
        createLintTaskState(),
      );
      gate.observeToolCall("write", { path: "src/a.ts" });
      const evaluations = await gate.onTaskEnd([{ name: "write" }]);
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
      const gate = createLintGate(
        {
          judge: createLintJudge({ client, append: () => {} }),
          root,
          requestTurn: async (text) => {
            requests.push(text);
            return true;
          },
        },
        createLintTaskState(),
      );
      gate.observeToolCall("edit", { path: "src/b.ts" });
      const evaluations = await gate.onTaskEnd([{ name: "edit" }]);
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
      const gate = createLintGate(
        { judge: createLintJudge({ client, append: () => {} }), root, requestTurn: async () => true },
        createLintTaskState(),
      );
      gate.observeToolCall("write", { path: "src/a.ts" });
      expect(await gate.onTaskEnd([{ name: "write" }])).toBe(0);
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
      const gate = createLintGate(
        { judge: createLintJudge({ client, append: () => {} }), root, requestTurn: async () => true },
        createLintTaskState(),
      );
      expect(await gate.onTaskEnd([{ name: "bash" }, { name: "read" }])).toBe(0);
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
      const taskState = createLintTaskState();
      const gate = createLintGate(
        {
          judge: createLintJudge({ client, append: () => {} }),
          root,
          requestTurn: async (text) => {
            requests.push(text);
            return true;
          },
        },
        taskState,
      );
      // The correction turn's "work": the gate diffs against the task's
      // starting head, so the changed file must actually exist.
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "a.ts"), "export function broken(): number { return (null as any).x; }\n");
      gate.observeToolCall("write", { path: "src/a.ts" });
      const evaluations = await gate.onTaskEnd([{ name: "write" }]);
      // Two evaluate→correct cycles ran; the cap held.
      expect(evaluations).toBe(LINT_MAX_CYCLES);
      expect(requests).toHaveLength(LINT_MAX_CYCLES);
      // The correction turn the gate requested is marked: its own settle
      // is skipped even though it "changed files" again.
      expect(await gate.onTaskEnd([{ name: "write" }])).toBe(0);
      expect(requests).toHaveLength(LINT_MAX_CYCLES);
    } finally {
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
      const gate = createLintGate(
        { judge: createLintJudge({ client, append: () => {} }), root, requestTurn: async () => true },
        createLintTaskState(),
      );
      gate.observeToolCall("write", { path: "src/a.ts" });
      expect(await gate.onTaskEnd([{ name: "write" }])).toBe(0);
      expect(calls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
