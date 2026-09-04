import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PromptComposer, SECTION_ORDER, type PromptContext } from "../src/prompt-composer";

/**
 * Deterministic snapshot-style tests: fixed date, fixed platform, tmp dirs
 * for every file the composer reads. No reliance on the real home dir.
 */

const NOW = new Date("2026-02-14T12:00:00Z");

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(import.meta.dir, ".tmp-prompt-"));
  tmpDirs.push(d);
  return d;
}

function baseCtx(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    cwd: "/proj",
    platform: "darwin",
    now: NOW,
    model: "claude-sonnet",
    route: "main/claude-sonnet",
    tools: [
      { name: "bash", description: "Run a shell command" },
      { name: "read", description: "Read a file" },
    ],
    skills: [{ name: "tdd", description: "Test-driven development" }],
    ...overrides,
  };
}

describe("PromptComposer", () => {
  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  test("section order is fixed and stable; every section is a TS function", () => {
    expect(SECTION_ORDER).toEqual([
      "base",
      "environment",
      "tools",
      "skills",
      "memory",
      "session_state",
      "extension_notes",
    ]);
    const composer = new PromptComposer({ projectDir: tmp(), mohHome: tmp() });
    for (const name of SECTION_ORDER) {
      expect(typeof composer.sections[name]).toBe("function");
    }
  });

  test("environment section always has cwd, platform, date, route and model", () => {
    const composer = new PromptComposer({ projectDir: tmp(), mohHome: tmp() });
    const env = composer.sections.environment(baseCtx());
    expect(env).toContain("/proj");
    expect(env).toContain("darwin");
    expect(env).toContain("2026-02-14");
    expect(env).toContain("main/claude-sonnet");
    expect(env).toContain("claude-sonnet");
  });

  test("base section contains the shipped base prompt plus AGENTS.md and CONTEXT.md in full", () => {
    const project = tmp();
    writeFileSync(join(project, "AGENTS.md"), "Project rules here.");
    writeFileSync(join(project, "CONTEXT.md"), "Domain glossary here.");
    const composer = new PromptComposer({ projectDir: project, mohHome: tmp() });
    const base = composer.sections.base(baseCtx());
    expect(base).toContain("Project rules here.");
    expect(base).toContain("Domain glossary here.");
    expect(base).toContain("coding agent"); // shipped identity line
    expect(base).toContain("Reply in the user's language");
  });

  test("CLAUDE.md is a silent fallback when AGENTS.md is absent", () => {
    const project = tmp();
    writeFileSync(join(project, "CLAUDE.md"), "Claude-only rules.");
    const composer = new PromptComposer({ projectDir: project, mohHome: tmp() });
    const base = composer.sections.base(baseCtx());
    expect(base).toContain("Claude-only rules.");
    expect(base).not.toContain("AGENTS.md"); // no dangling reference
  });

  test("AGENTS.md wins over CLAUDE.md when both exist", () => {
    const project = tmp();
    writeFileSync(join(project, "AGENTS.md"), "Use AGENTS.");
    writeFileSync(join(project, "CLAUDE.md"), "Use CLAUDE.");
    const composer = new PromptComposer({ projectDir: project, mohHome: tmp() });
    expect(composer.sections.base(baseCtx())).toContain("Use AGENTS.");
    expect(composer.sections.base(baseCtx())).not.toContain("Use CLAUDE.");
  });

  test("instruction files over budget are truncated with a notice", () => {
    const project = tmp();
    writeFileSync(join(project, "AGENTS.md"), "x".repeat(500));
    const composer = new PromptComposer({ projectDir: project, mohHome: tmp(), budget: 100 });
    const base = composer.sections.base(baseCtx());
    expect(base).toContain("x".repeat(100));
    expect(base).not.toContain("x".repeat(101));
    expect(base).toMatch(/truncated/i);
    expect(base).toMatch(/budget/i);
  });

  test("base-prompt file override works at user level and project level wins", () => {
    const project = tmp();
    const home = tmp();
    mkdirSync(join(home, "prompts"), { recursive: true });
    writeFileSync(join(home, "prompts", "system.md"), "USER OVERRIDE BASE");

    const userOnly = new PromptComposer({ projectDir: project, mohHome: home });
    expect(userOnly.sections.base(baseCtx())).toContain("USER OVERRIDE BASE");
    expect(userOnly.sections.base(baseCtx())).not.toContain("coding agent");

    mkdirSync(join(project, ".moh", "prompts"), { recursive: true });
    writeFileSync(join(project, ".moh", "prompts", "system.md"), "PROJECT OVERRIDE BASE");
    const both = new PromptComposer({ projectDir: project, mohHome: home });
    const base = both.sections.base(baseCtx());
    expect(base).toContain("PROJECT OVERRIDE BASE");
    expect(base).not.toContain("USER OVERRIDE BASE");
  });

  test("tools section lists name and description; skills section is a name—description index", () => {
    const composer = new PromptComposer({ projectDir: tmp(), mohHome: tmp() });
    const ctx = baseCtx();
    expect(composer.sections.tools(ctx)).toContain("- bash: Run a shell command");
    expect(composer.sections.skills(ctx)).toContain("- tdd — Test-driven development");
  });

  test("empty optional sections are omitted; provided ones are included in order", () => {
    const composer = new PromptComposer({ projectDir: tmp(), mohHome: tmp() });
    const assembled = composer.compose(baseCtx());
    expect(assembled.sections.memory).toBeUndefined();
    expect(assembled.sections.session_state).toBeUndefined();

    const withExtras = composer.compose(
      baseCtx({ memory: "Prefers tabs.", sessionState: "Turn 3 of 10.", extensionNotes: ["note-a"] }),
    );
    expect(withExtras.system).toContain("Prefers tabs.");
    expect(withExtras.system).toContain("Turn 3 of 10.");
    expect(withExtras.system).toContain("note-a");
    const names = Object.keys(withExtras.sections);
    expect(names).toEqual([...SECTION_ORDER].filter((n) => n in withExtras.sections));
    // fixed relative order even for the optional ones
    const idx = names.indexOf.bind(names);
    if (names.includes("memory") && names.includes("session_state")) {
      expect(idx("memory")).toBeLessThan(idx("session_state"));
    }
  });

  test("promptVersion is a stable hash of the assembled prompt and changes when sections change", () => {
    const composer = new PromptComposer({ projectDir: tmp(), mohHome: tmp() });
    const a = composer.compose(baseCtx());
    const b = composer.compose(baseCtx()); // same ctx, same version
    expect(a.version).toBe(b.version);
    expect(a.version).toMatch(/^[0-9a-f]{16}$/);

    const c = composer.compose(baseCtx({ memory: "new fact" }));
    expect(c.version).not.toBe(a.version);

    const d = composer.compose(baseCtx({ now: new Date("2026-02-15T00:00:00Z") }));
    expect(d.version).not.toBe(a.version); // date is part of the prompt
  });

  test("environment section renders the session-notes path under the resolved project slug (#467)", () => {
    const projectDir = tmp();
    // Declare the identity explicitly so the slug is deterministic.
    mkdirSync(join(projectDir, ".moh"), { recursive: true });
    writeFileSync(join(projectDir, ".moh", "project.json"), `${JSON.stringify({ id: "467-identity" })}\n`);
    const composer = new PromptComposer({ projectDir, mohHome: tmp() });
    const env = composer.sections.environment(baseCtx({ cwd: projectDir }));
    expect(env).toMatch(/- Session notes: .+\/projects\/project-[0-9a-f]{16}\/session\.md$/m);
    // No path re-computation hint for the skill: the Core renders the path.
    expect(env).not.toContain("<project-slug>");
  });

  test("two projects with different declared identities get different session-notes paths", () => {
    const dirA = tmp();
    const dirB = tmp();
    mkdirSync(join(dirA, ".moh"), { recursive: true });
    mkdirSync(join(dirB, ".moh"), { recursive: true });
    writeFileSync(join(dirA, ".moh", "project.json"), `${JSON.stringify({ id: "shared-id" })}\n`);
    writeFileSync(join(dirB, ".moh", "project.json"), `${JSON.stringify({ id: "other-id" })}\n`);
    const composerA = new PromptComposer({ projectDir: dirA, mohHome: tmp() });
    const composerB = new PromptComposer({ projectDir: dirB, mohHome: tmp() });
    const pathA = composerA.sections.environment(baseCtx({ cwd: dirA })).match(/Session notes: (.+)$/m)?.[1];
    const pathB = composerB.sections.environment(baseCtx({ cwd: dirB })).match(/Session notes: (.+)$/m)?.[1];
    expect(pathA).toBeTruthy();
    expect(pathB).toBeTruthy();
    expect(pathA).not.toBe(pathB);
  });
});
