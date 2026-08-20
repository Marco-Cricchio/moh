import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills, parseSkillFrontmatter } from "../src/skills";
import { builtinTools, createSession, MockProvider } from "../src/index";
import type { DiscoveredSkill } from "../src/skills";

/** Pi-format SKILL.md fixture: frontmatter name+description, body with a relative ref. */
function skillMd(name: string, description = `The ${name} skill.`): string {
  return `---
name: ${name}
description: ${description}
---

# ${name}

Read the checklist at references/checklist.md (relative to this skill's directory).
`;
}

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "moh-skills-"));
  tmpDirs.push(d);
  return d;
}

function writeSkill(
  root: string,
  dir: string,
  content?: string,
  extra?: { file: string; content: string },
  base = "skills",
): void {
  const skillDir = join(root, base, dir);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), content ?? skillMd(dir));
  if (extra) {
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(join(skillDir, extra.file), extra.content);
  }
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("parseSkillFrontmatter", () => {
  test("parses name and description from frontmatter, body excluded", () => {
    const parsed = parseSkillFrontmatter(skillMd("code-review", "Review changes along Standards and Spec axes."));
    expect(parsed).toEqual({ name: "code-review", description: "Review changes along Standards and Spec axes." });
  });

  test("returns null without frontmatter or without name+description", () => {
    expect(parseSkillFrontmatter("no frontmatter here")).toBeNull();
    expect(parseSkillFrontmatter("---\nname: x\n---\nbody")).toBeNull();
    expect(parseSkillFrontmatter("---\ndescription: x\n---\nbody")).toBeNull();
  });

  test("keeps multi-word descriptions with colons intact", () => {
    const parsed = parseSkillFrontmatter(
      '---\nname: a\ndescription: Do things: carefully, with: colons\n---\nbody',
    );
    expect(parsed!.description).toBe("Do things: carefully, with: colons");
  });
});

describe("discoverSkills", () => {
  test("discovers user-level and project-level skills; project wins on name clash", () => {
    const userHome = tmp();
    const project = tmp();
    writeSkill(userHome, "code-review");
    writeSkill(userHome, "only-user");
    writeSkill(project, "code-review", skillMd("code-review", "Review changes along Project version axes."), undefined, join(".moh", "skills"));
    writeSkill(project, "only-project", undefined, undefined, join(".moh", "skills"));

    const skills = discoverSkills({ mohHome: userHome, projectDir: project });
    const byName = Object.fromEntries(skills.map((s: DiscoveredSkill) => [s.name, s]));

    expect(skills.map((s: DiscoveredSkill) => s.name).sort()).toEqual(["code-review", "only-project", "only-user"]);
    expect(byName["code-review"]!.description).toContain("Project version");
    expect(byName["code-review"]!.source).toBe("project");
    expect(byName["only-user"]!.source).toBe("user");
    expect(byName["code-review"]!.file).toBe(join(project, ".moh", "skills", "code-review", "SKILL.md"));
  });

  test("ignores dirs without SKILL.md or with invalid frontmatter; missing dirs are fine", () => {
    const userHome = tmp();
    const project = tmp();
    mkdirSync(join(userHome, "skills", "empty"), { recursive: true });
    writeSkill(project, "broken", "no frontmatter", undefined, join(".moh", "skills"));
    writeSkill(project, "good", undefined, undefined, join(".moh", "skills"));

    const skills = discoverSkills({ mohHome: userHome, projectDir: project });
    expect(skills.map((s: DiscoveredSkill) => s.name)).toEqual(["good"]);
  });

  test("defaults to ~/.moh and process.cwd()", () => {
    const skills = discoverSkills();
    // No fixture dirs in this environment; just check the signature works.
    expect(Array.isArray(skills)).toBe(true);
  });
});

describe("skills in a mocked session (progressive disclosure)", () => {
  test("skill index renders name — description only; full body loads via the read tool", async () => {
    const userHome = tmp();
    const project = tmp();
    writeSkill(userHome, "code-review", skillMd("code-review", "Review changes along Standards and Spec axes."), {
      file: join("references", "checklist.md"),
      content: "- Standards\n- Spec\n",
    });

    const skillFile = join(userHome, "skills", "code-review", "SKILL.md");
    const mock = MockProvider.scripted([
      { deltas: [], finish: "tool_calls", toolCalls: [{ name: "read", args: { path: skillFile } }] },
      { deltas: ["reviewed"], finish: "stop" },
    ]);
    // Recording wrapper: captures the system prompt the model actually received.
    const systemPrompts: string[] = [];
    const provider = {
      name: "mock",
      async *stream(messages: any, signal: AbortSignal) {
        const system = messages.find((m: any) => m.role === "system");
        if (system) systemPrompts.push(system.parts[0].text);
        yield* mock.stream(messages, signal);
      },
    };
    const session = createSession({
      provider,
      tools: builtinTools(),
      cwd: project,
      mohHome: userHome,
      permissions: { mode: "auto-accept" },
    });

    const result = await session.send("review my code");
    expect(result.status).toBe("done");

    // Index in the system prompt: name — description + location, never the body.
    const skillsSection = systemPrompts.at(-1)!.split("## Skills")[1]!;
    expect(skillsSection).toContain("code-review — Review changes along Standards and Spec axes.");
    expect(skillsSection).toContain(skillFile);
    expect(skillsSection).not.toContain("# code-review");

    // Full SKILL.md body reached the model via the read tool (user-level dir,
    // outside the project root — resolved against the skill directory).
    const log = session.history();
    const readResult = log.find((e: any) => e.type === "tool_result") as any;
    expect(readResult.ok).toBe(true);
    expect(readResult.output).toContain("# code-review");
    expect(readResult.output).toContain("relative to this skill's directory");
  });
});
