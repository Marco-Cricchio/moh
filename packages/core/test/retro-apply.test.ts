import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { preCommitHookContent, proposeRetroApplication, applyRetroApplication } from "../src/retro-apply";
import { retroSignature } from "../src/retro";
import type { RetroFinding } from "../src/retro";

const dirs: string[] = [];
function tempDir(): string {
  const dir = join(tmpdir(), `moh-retro-apply-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function finding(category: string): RetroFinding {
  return { category, evidence: "the agent re-read the same module three times", confidence: 0.7, session: "s", signature: "sig-1", appendedAt: "2026-01-01T00:00:00.000Z" };
}

describe("retro application proposals", () => {
  test("each category maps to a concrete target deterministically", () => {
    expect(proposeRetroApplication(finding("navigation"))).toMatchObject({ kind: "navigation-pointer", target: "AGENTS.md" });
    expect(proposeRetroApplication(finding("coding-standards"))).toMatchObject({ kind: "coding-standards-rule", target: "CODING_STANDARDS.md" });
    // The pre-commit:unwired shape (matched by signature, #1356) has a
    // real target; the CI shape and evidence-only mentions keep none.
    expect(proposeRetroApplication({ ...finding("missing-guardrail"), signature: retroSignature("missing-guardrail", "pre-commit:unwired") })).toMatchObject({ kind: "automated-check", target: ".git/hooks/pre-commit" });
    expect(proposeRetroApplication({ ...finding("missing-guardrail"), signature: retroSignature("missing-guardrail", "ci:unwired") }).target).toBe("");
    expect(proposeRetroApplication(finding("navigation"))).toEqual(proposeRetroApplication(finding("navigation")));
  });

  test("an unknown category gets a review-only shape, never an invented target", () => {
    expect(proposeRetroApplication(finding("something-new")).target).toBe("");
  });

  describe("missing-guardrail pre-commit target (#1356)", () => {
    const preCommit = (): RetroFinding => ({
      category: "missing-guardrail",
      evidence: "package.json defines `lint` and `test` but no pre-commit hook runs them",
      confidence: 0.8,
      session: "s",
      signature: retroSignature("missing-guardrail", "pre-commit:unwired"),
      appendedAt: "2026-01-01T00:00:00.000Z",
    });

    test("the pre-commit shape maps to a .git/hooks/pre-commit target", () => {
      expect(proposeRetroApplication(preCommit())).toMatchObject({
        kind: "automated-check",
        target: ".git/hooks/pre-commit",
      });
    });

    test("the proposal is deterministic", () => {
      expect(proposeRetroApplication(preCommit())).toEqual(proposeRetroApplication(preCommit()));
    });

    test("the ci:unwired shape stays review-only", () => {
      const ci: RetroFinding = {
        ...preCommit(),
        evidence: "package.json defines `test` but no CI workflow job runs it",
        signature: retroSignature("missing-guardrail", "ci:unwired"),
      };
      const application = proposeRetroApplication(ci);
      expect(application.target).toBe("");
    });

    test("a confirmed apply writes an executable hook from repo state", () => {
      const root = tempDir();
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { lint: "eslint .", test: "bash scripts/test.sh" } }));
      writeFileSync(join(root, "bun.lock"), "{}");
      const result = applyRetroApplication({ finding: preCommit(), projectRoot: root, confirm: true });
      expect(result).toMatchObject({ ok: true, created: true });
      const hook = join(root, ".git", "hooks", "pre-commit");
      expect(existsSync(hook)).toBe(true);
      const content = readFileSync(hook, "utf8");
      expect(content).toContain("#!/bin/sh");
      expect(content).toContain("set -e");
      expect(content).toContain("bun run lint");
      expect(content).toContain("bun run test");
      expect((statSync(hook).mode & 0o755) === 0o755).toBe(true);
      // The write stays gated: nothing is appended to markdown.
      expect(result.ok && result.appended).toBe(false);
    });

    test("a confirmed apply writes an executable hook from repo state", () => {
      const root = tempDir();
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { lint: "eslint .", test: "bun test" } }));
      writeFileSync(join(root, "bun.lock"), "{}");
      const result = applyRetroApplication({ finding: preCommit(), projectRoot: root, confirm: true });
      expect(result).toMatchObject({ ok: true, created: true });
      const hook = join(root, ".git", "hooks", "pre-commit");
      expect(existsSync(hook)).toBe(true);
      const content = readFileSync(hook, "utf8");
      expect(content).toContain("#!/bin/sh");
      expect(content).toContain("set -e");
      expect(content).toContain("bun run lint");
      // The bare "bun test" script is excluded (#1363); lint remains.
      expect(content).not.toContain("test");
      expect((statSync(hook).mode & 0o755) === 0o755).toBe(true);
      // The write stays gated: nothing is appended to markdown.
      expect(result.ok && result.appended).toBe(false);
    });

    test("a bare whole-tree test script (#1363) is not emitted: the hook keeps the derivable checks", () => {
      const root = tempDir();
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { lint: "eslint .", test: "bun test" } }));
      writeFileSync(join(root, "bun.lock"), "{}");
      const result = applyRetroApplication({ finding: preCommit(), projectRoot: root, confirm: true });
      expect(result).toMatchObject({ ok: true, created: true });
      const content = readFileSync(join(root, ".git", "hooks", "pre-commit"), "utf8");
      expect(content).toContain("bun run lint");
      expect(content).not.toContain("test");
    });

    test("a bare whole-tree test script as the only check is refused with the wiring hint (#1363)", () => {
      const root = tempDir();
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
      writeFileSync(join(root, "bun.lock"), "{}");
      const result = applyRetroApplication({ finding: preCommit(), projectRoot: root, confirm: true });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toContain("bare whole-tree");
      expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false);
      expect(preCommitHookContent(root)).toBeNull();
    });

    test("a hook that exists but is not executable is made executable, not overwritten", () => {
      const root = tempDir();
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { lint: "eslint ." } }));
      mkdirSync(join(root, ".git", "hooks"), { recursive: true });
      writeFileSync(join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nnpm run lint\n");
      chmodSync(join(root, ".git", "hooks", "pre-commit"), 0o644);
      const result = applyRetroApplication({ finding: preCommit(), projectRoot: root, confirm: true });
      expect(result).toMatchObject({ ok: true, created: false, appended: false });
      expect(readFileSync(join(root, ".git", "hooks", "pre-commit"), "utf8")).toBe("#!/bin/sh\nnpm run lint\n");
      expect((statSync(join(root, ".git", "hooks", "pre-commit")).mode & 0o755) === 0o755).toBe(true);
    });

    test("no derivable check (unreadable or checkless package.json) is refused, never an empty hook", () => {
      const root = tempDir();
      expect(applyRetroApplication({ finding: preCommit(), projectRoot: root, confirm: true })).toMatchObject({ ok: false });
      writeFileSync(join(root, "package.json"), "{ broken");
      expect(applyRetroApplication({ finding: preCommit(), projectRoot: root, confirm: true })).toMatchObject({ ok: false });
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
      expect(applyRetroApplication({ finding: preCommit(), projectRoot: root, confirm: true })).toMatchObject({ ok: false });
      expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false);
    });

    test("the hook runner falls back to npm when no lockfile names one", () => {
      const root = tempDir();
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "bash scripts/test.sh" } }));
      expect(preCommitHookContent(root)).toBe("#!/bin/sh\nset -e\nnpm run test\n");
    });

    test("an existing hook is never overwritten", () => {
      const root = tempDir();
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { lint: "eslint ." } }));
      mkdirSync(join(root, ".git", "hooks"), { recursive: true });
      writeFileSync(join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho custom\n");
      chmodSync(join(root, ".git", "hooks", "pre-commit"), 0o755);
      const result = applyRetroApplication({ finding: preCommit(), projectRoot: root, confirm: true });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toContain("already exists");
      expect(readFileSync(join(root, ".git", "hooks", "pre-commit"), "utf8")).toBe("#!/bin/sh\necho custom\n");
    });
  });
});

describe("retro application gate", () => {
  test("without explicit confirmation nothing is written", () => {
    const root = tempDir();
    writeFileSync(join(root, "AGENTS.md"), "# Agents\n");
    const result = applyRetroApplication({ finding: finding("navigation"), projectRoot: root, confirm: false });
    expect(result.ok).toBe(false);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("# Agents\n");
  });

  test("a confirmed apply appends a marked bullet once (idempotent)", () => {
    const root = tempDir();
    writeFileSync(join(root, "AGENTS.md"), "# Agents\n\nExisting prose.\n");
    const opts = { finding: finding("navigation"), projectRoot: root, confirm: true };
    expect(applyRetroApplication(opts)).toMatchObject({ ok: true, appended: true });
    const after = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(after).toContain("Existing prose.");
    expect(after).toContain("## Retro findings");
    expect(after).toContain("add a navigation pointer");
    expect(applyRetroApplication(opts)).toMatchObject({ ok: true, appended: false });
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(after);
  });

  test("a target outside the project root is refused", () => {
    const root = tempDir();
    const result = applyRetroApplication({
      finding: finding("navigation"),
      projectRoot: root,
      confirm: true,
      application: { kind: "navigation-pointer", target: "../outside.md", proposal: "x", section: "## Retro findings" },
    });
    expect(result.ok).toBe(false);
  });

  test("a missing steering file is refused, not created", () => {
    const root = tempDir();
    const result = applyRetroApplication({ finding: finding("coding-standards"), projectRoot: root, confirm: true });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toContain("does not exist");
  });

  test("createMissing applies to a steering file that does not exist yet, marking created", () => {
    const root = tempDir();
    const result = applyRetroApplication({ finding: finding("coding-standards"), projectRoot: root, confirm: true, createMissing: true });
    expect(result).toMatchObject({ ok: true, appended: true, created: true });
    const after = readFileSync(join(root, "CODING_STANDARDS.md"), "utf8");
    expect(after).toContain("## Retro findings");
    expect(after).toContain("add a rule:");
    // A second apply is still idempotent, and the file is no longer "created".
    expect(applyRetroApplication({ finding: finding("coding-standards"), projectRoot: root, confirm: true, createMissing: true })).toMatchObject({
      ok: true,
      appended: false,
      created: false,
    });
  });

  test("createMissing without confirm still writes nothing", () => {
    const root = tempDir();
    const result = applyRetroApplication({ finding: finding("coding-standards"), projectRoot: root, confirm: false, createMissing: true });
    expect(result.ok).toBe(false);
    expect(existsSync(join(root, "CODING_STANDARDS.md"))).toBe(false);
  });

  test("createMissing on a directory target escapes root is still refused", () => {
    const root = tempDir();
    const result = applyRetroApplication({
      finding: finding("navigation"),
      projectRoot: root,
      confirm: true,
      createMissing: true,
      application: { kind: "navigation-pointer", target: "../outside.md", proposal: "x", section: "## Retro findings" },
    });
    expect(result.ok).toBe(false);
  });
});
