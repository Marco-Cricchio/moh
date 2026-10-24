import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { loadMohConfig } from "../../core/src/config";
import { initCommand } from "../src/init";

const quiet = () => new Writable({ write: (_c, _e, done) => done() });

const AGENT_FILES = [
  "docs/agents/issue-tracker.md",
  "docs/agents/triage-labels.md",
  "docs/agents/domain.md",
  "docs/agents/code-quality.md",
];

describe("moh init", () => {
  test("scaffolds docs/agents/* and AGENTS.md in a bare project", () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-init-"));
    const report = initCommand({ cwd });
    for (const rel of AGENT_FILES) expect(existsSync(join(cwd, rel))).toBe(true);
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toContain("## moh");
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toContain("docs/agents/code-quality.md");
    expect(readFileSync(join(cwd, "docs/agents/code-quality.md"), "utf8")).toContain("deletes it in the same change");
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

  test("a bare project gets a moh.json with the pinned default checks (ADR-0080)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-init-"));
    initCommand({ cwd, stdout: quiet() });
    const checks = loadMohConfig(join(cwd, "moh.json")).checks ?? [];
    expect(checks.map((c) => c.name)).toEqual(["duplication", "complexity"]);
    expect(checks.every((c) => c.block === undefined)).toBe(true); // report only until the repo says otherwise
  });

  test("the repo's own tools win over the defaults", () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-init-"));
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ devDependencies: { knip: "^5.0.0" } }));
    writeFileSync(join(cwd, "pyproject.toml"), '[tool.ruff]\nline-length = 100\n');
    initCommand({ cwd, stdout: quiet() });
    expect(loadMohConfig(join(cwd, "moh.json")).checks).toEqual([
      { name: "knip", run: "npx knip" },
      { name: "ruff", run: "ruff check ." },
    ]);
  });

  test("an existing moh.json is never edited; the proposal is printed", () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-init-"));
    writeFileSync(join(cwd, "moh.json"), '{ "maxIterations": 100 }\n');
    let printed = "";
    const report = initCommand({ cwd, stdout: new Writable({ write: (chunk, _e, done) => ((printed += String(chunk)), done()) }) });
    expect(readFileSync(join(cwd, "moh.json"), "utf8")).toBe('{ "maxIterations": 100 }\n');
    expect(report.kept).toContain("moh.json");
    expect(printed).toContain('"name": "duplication"');
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
