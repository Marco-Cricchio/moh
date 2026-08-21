import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCommand } from "../src/init";

const AGENT_FILES = ["docs/agents/issue-tracker.md", "docs/agents/triage-labels.md", "docs/agents/domain.md"];

describe("moh init", () => {
  test("scaffolds docs/agents/* and AGENTS.md in a bare project", () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-init-"));
    const report = initCommand({ cwd });
    for (const rel of AGENT_FILES) expect(existsSync(join(cwd, rel))).toBe(true);
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toContain("## moh");
    expect(report.created).toContain("AGENTS.md");
  });

  test("never overwrites existing files (non-destructive)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-init-"));
    // pre-existing file with user content
    mkdirSync(join(cwd, "docs/agents"), { recursive: true });
    writeFileSync(join(cwd, "docs/agents/domain.md"), "my precious docs\n");
    writeFileSync(join(cwd, "AGENTS.md"), "# My rules\n");
    const report = initCommand({ cwd });
    expect(report.kept).toContain("docs/agents/domain.md");
    expect(readFileSync(join(cwd, "docs/agents/domain.md"), "utf8")).toBe("my precious docs\n");
    // AGENTS.md kept, section appended, original content intact
    const agents = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    expect(agents.startsWith("# My rules")).toBe(true);
    expect(agents).toContain("## moh");
    // second run: no duplicate section
    initCommand({ cwd });
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8").split("## moh")).toHaveLength(2);
  });

  test("pi migration: CLAUDE.md becomes AGENTS.md, original kept", () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-init-"));
    writeFileSync(join(cwd, "CLAUDE.md"), "# Claude rules\n\nbe nice\n");
    const report = initCommand({ cwd });
    expect(report.migratedFromClaude).toBe(true);
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toContain("be nice");
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(true);
  });
});
