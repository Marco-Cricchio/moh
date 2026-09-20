/**
 * Rubric discovery tests (#789): fixture projects — a repo with
 * instruction files, one without, one with only a nested document —
 * asserting the caps, the precedence and the inert behavior.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { discoverRubrics, RUBRIC_MAX_BYTES, RUBRIC_MAX_FILES, RUBRIC_TRUNCATION_MARKER } from "../src/rubrics";

const fakeFs = (files: Record<string, string>) => ({
  exists: (p: string) => files[p] !== undefined,
  read: (p: string) => files[p]!,
});

describe("rubric discovery (#789)", () => {
  test("collects every matching document across the name list", () => {
    const docs = discoverRubrics(
      "/proj",
      fakeFs({
        "/proj/AGENTS.md": "be terse",
        "/proj/.github/CONTRIBUTING.md": "small PRs",
        "/proj/docs/STYLE.md": "no default exports",
      }),
    );
    expect(new Set(docs.map((d) => d.path))).toEqual(new Set(["AGENTS.md", ".github/CONTRIBUTING.md", "docs/STYLE.md"]));
    expect(docs[0]!.text).toBe("be terse");
  });

  test("no convention documents → inert (empty list), never invented criteria", () => {
    expect(discoverRubrics("/proj", fakeFs({ "/proj/README.md": "just a readme" }))).toEqual([]);
    expect(discoverRubrics("/proj", fakeFs({}))).toEqual([]);
  });

  test("empty file counts as absent", () => {
    const docs = discoverRubrics("/proj", fakeFs({ "/proj/AGENTS.md": "   \n  " }));
    expect(docs).toEqual([]);
  });

  test("unreadable document is skipped, not a crash", () => {
    const docs = discoverRubrics("/proj", {
      exists: () => true,
      read: (p: string) => {
        if (p.endsWith("AGENTS.md")) throw new Error("EACCES");
        if (p.endsWith(".cursorrules")) return "";
        return "conventions here";
      },
    });
    expect(docs[0]!.path).toBe("CLAUDE.md");
    expect(docs).toHaveLength(RUBRIC_MAX_FILES);
  });

  test("file cap: at most 6 documents are collected", () => {
    const files: Record<string, string> = {};
    for (const name of ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "STYLE.md", "CONVENTIONS.md", ".cursorrules", ".github/AGENTS.md"]) {
      files[`/proj/${name}`] = `${name} rules`;
    }
    const docs = discoverRubrics("/proj", fakeFs(files));
    expect(docs).toHaveLength(RUBRIC_MAX_FILES);
  });

  test("byte cap: the combined text is truncated with a visible marker", () => {
    const big = "x".repeat(RUBRIC_MAX_BYTES + 500);
    const docs = discoverRubrics(
      "/proj",
      fakeFs({ "/proj/AGENTS.md": big, "/proj/STYLE.md": "y".repeat(4000) }),
    );
    const total = docs.reduce((n, d) => n + Buffer.byteLength(d.text, "utf8"), 0);
    expect(total).toBeLessThanOrEqual(RUBRIC_MAX_BYTES);
    expect(docs[0]!.text.endsWith(RUBRIC_TRUNCATION_MARKER)).toBe(true);
    // Multi-byte safety: no replacement characters at the cut.
    expect(docs[0]!.text).not.toContain("\uFFFD");
  });
});

describe("rubric discovery: .cursor/rules (#789)", () => {
  test("any .mdc/.md file under .cursor/rules/ is collected, after the fixed names", () => {
    const docs = discoverRubrics("/proj", {
      exists: (p) => p === "/proj/AGENTS.md" || p === "/proj/.cursor/rules/typing.mdc",
      read: (p) => (p.endsWith("AGENTS.md") ? "root rules" : "cursor rule"),
      listCursorRules: () => ["typing.mdc", "layout.md"],
    });
    // layout.md was reported by the listing but not present on disk: skipped.
    expect(docs.map((d) => d.path)).toEqual(["AGENTS.md", join(".cursor", "rules", "typing.mdc")]);
  });
});
