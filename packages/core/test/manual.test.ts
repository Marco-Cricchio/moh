import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { allManualPages, manualIndex, manualPage, manualSubsetViolations } from "../src/manual";

/** #457: the user manual — markdown assets bundled in core (statically
 * imported, ADR-0013), mirrored to docs/manual/ by gen-manual-docs.ts.
 * These tests pin the assets' shape, the markdown subset, and the mirror. */

const ROOT = join(import.meta.dir, "..", "..", "..");
const DOCS = join(ROOT, "docs", "manual");
const GENERATED_IDS = new Set(["cli-reference", "config-reference", "commands-and-keys"]);

describe("manual assets (#457)", () => {
  test("the manual has the 10 agreed sections in order", () => {
    expect(allManualPages().map((p) => p.id)).toEqual([
      "getting-started",
      "sessions",
      "providers-and-models",
      "permissions",
      "mcp",
      "skills-and-workflow",
      "memory-and-compaction",
      "cli-reference",
      "config-reference",
      "commands-and-keys",
    ]);
  });

  test("every page starts with its H1 title and carries a summary", () => {
    for (const page of allManualPages()) {
      expect(page.body).toMatch(new RegExp(`^# ${page.title}$`, "m"));
      expect(page.summary.length).toBeGreaterThan(10);
    }
  });

  test("manualIndex returns id+title+summary only (no bodies)", () => {
    const index = manualIndex();
    expect(index).toHaveLength(allManualPages().length);
    for (const entry of index) {
      expect(Object.keys(entry).sort()).toEqual(["id", "summary", "title"]);
    }
  });

  test("manualPage resolves by id and returns null when unknown", () => {
    expect(manualPage("sessions")?.title).toBe("Sessions");
    expect(manualPage("no-such-page")).toBeNull();
  });

  test("every page stays inside the declared markdown subset", () => {
    for (const page of allManualPages()) {
      expect(manualSubsetViolations(page.body)).toEqual([]);
    }
  });

  test("the subset detector rejects out-of-subset constructs", () => {
    expect(manualSubsetViolations("text <div>html</div> more")).toHaveLength(1);
    expect(manualSubsetViolations("![img](x.png)")).toHaveLength(1);
    expect(manualSubsetViolations("heading\n======")).toHaveLength(1);
    expect(manualSubsetViolations("```\n<div>verbatim is fine</div>\n```")).toEqual([]);
    expect(manualSubsetViolations("plain paragraph with `code` and `<ref>` inside backticks")).toEqual([]);
  });
});

describe("manual docs mirror (#457)", () => {
  test("one docs page per section plus the README, no extras", () => {
    const expected = [...allManualPages().map((p) => `${p.id}.md`), "README.md"].sort();
    const actual = readdirSync(DOCS).filter((f) => f.endsWith(".md")).sort();
    expect(actual).toEqual(expected);
  });

  test("the mirror matches the embedded assets byte for byte", () => {
    for (const page of allManualPages()) {
      const mirrored = readFileSync(join(DOCS, `${page.id}.md`), "utf8");
      expect(mirrored).toBe(page.body);
    }
  });

  test("the README links every page", () => {
    const index = readFileSync(join(DOCS, "README.md"), "utf8");
    for (const page of allManualPages()) {
      expect(index).toContain(`](./${page.id}.md)`);
    }
  });

  test("generated reference pages carry the generated-from-code banner", () => {
    for (const page of allManualPages()) {
      if (!GENERATED_IDS.has(page.id)) continue;
      expect(page.body).toContain("never edit directly");
    }
  });
});

describe("generated pages match their code sources (#457)", () => {
  test("commands-and-keys covers every COMMANDS group and key", () => {
    // Re-run the generator's extractor logic against the TUI source; if
    // this test fails the generator output is stale.
    const raw = readFileSync(join(ROOT, "packages", "tui", "src", "CommandsPanel.tsx"), "utf8");
    const commands: { area: string; keys: [string, string][] }[] = [];
    for (const m of raw.matchAll(/area: "([^"]+)",\s*keys: \[([\s\S]*?)\],\s*\}/g)) {
      commands.push({ area: m[1]!, keys: [...m[2]!.matchAll(/\["([^"]+)",\s*"([^"]+)"\]/g)].map((r) => [r[1]!, r[2]!] as [string, string]) });
    }
    expect(commands.length).toBeGreaterThan(0);
    const page = manualPage("commands-and-keys")!.body;
    for (const group of commands) {
      expect(page).toContain(`## ${group.area}`);
      for (const [key, action] of group.keys) {
        // Table cells escape pipes and backtick bare `<...>`; compare
        // on the same transformation the generator applies.
        const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/(^|[^`])(<[^>`]+>)/g, (_m, a: string, b: string) => (a === "`" ? `${a}${b}` : `${a}\`${b}\``));
        expect(page).toContain(cell(key));
        expect(page).toContain(cell(action));
      }
    }
    // The manual-only entries are documented additions, not drift.
    expect(page).toContain("ctrl+h");
    expect(page).toContain("/help");
    expect(page).toContain("## Manual");
  });

  test("cli-reference covers every CLI usage text", () => {
    const page = manualPage("cli-reference")!.body;
    for (const [file, name] of [
      ["run.ts", "RUN_USAGE"],
      ["mcp.ts", "MCP_USAGE"],
      ["provider.ts", "PROVIDER_USAGE"],
      ["update.ts", "UPDATE_USAGE"],
      ["handoff.ts", "HANDOFF_USAGE"],
    ] as const) {
      const raw = readFileSync(join(ROOT, "packages", "cli", "src", file), "utf8");
      const m = new RegExp(`export const ${name} = \`([\\s\\S]*?)\`;`).exec(raw);
      expect(m, `${name} extracted from ${file}`).not.toBeNull();
      // Every usage block's first line (its invocation synopsis) is pinned.
      const synopsis = m![1]!.trim().split("\n")[0]!;
      expect(page).toContain(synopsis);
    }
    expect(page).toContain("## moh manual");
  });
});
