import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { proposeRetroApplication, applyRetroApplication } from "../src/retro-apply";
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
    // A check is wired in YAML, not a markdown bullet: the proposal names
    // the change and carries no automatic target.
    expect(proposeRetroApplication(finding("missing-guardrail"))).toMatchObject({ kind: "automated-check", target: "" });
    expect(proposeRetroApplication(finding("navigation"))).toEqual(proposeRetroApplication(finding("navigation")));
  });

  test("an unknown category gets a review-only shape, never an invented target", () => {
    expect(proposeRetroApplication(finding("something-new")).target).toBe("");
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
});
