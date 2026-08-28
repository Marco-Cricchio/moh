import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assetKey, resolveVersion, sha256File, skillFiles, TARGETS } from "./build";

const ROOT = join(import.meta.dir, "..");

describe("TARGETS", () => {
  test("covers the three 0.1.0 platforms (ADR-0013)", () => {
    expect(TARGETS.map((t) => t.platform)).toEqual(["darwin-arm64", "darwin-x64", "linux-x64"]);
  });
});

describe("resolveVersion", () => {
  test("strips the v prefix from an exact git tag", () => {
    expect(resolveVersion(ROOT, "v1.2.3")).toBe("1.2.3");
  });

  test("falls back to the CLI package version without a tag", () => {
    expect(resolveVersion(ROOT, null)).toBe("0.1.0");
  });

  test("ignores non-v tags", () => {
    expect(resolveVersion(ROOT, "nightly-42")).toBe("0.1.0");
  });
});

describe("skillFiles", () => {
  test("lists the real bundle recursively, sorted, relative to the skills dir", () => {
    const files = skillFiles(join(ROOT, "packages/core/assets/skills"));
    expect(files.length).toBeGreaterThan(10);
    expect(files.map((f) => f.rel)).toContain("ask-moh/SKILL.md");
    const rels = files.map((f) => f.rel);
    expect([...rels].sort((a, b) => a.localeCompare(b))).toEqual(rels);
  });

  test("walks nested subdirectories", () => {
    const dir = join(process.cwd(), "dist/.tmp-skillwalk");
    const nested = join(dir, "demo", "refs");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(dir, "demo/SKILL.md"), "# demo\n");
    writeFileSync(join(nested, "guide.md"), "# guide\n");
    const rels = skillFiles(dir).map((f) => f.rel);
    expect([...rels].sort()).toEqual(["demo/SKILL.md", "demo/refs/guide.md"].sort());
  });
});

describe("sha256File", () => {
  test("produces the known sha256 of fixed content", () => {
    const path = join(process.cwd(), "dist/.tmp-sha");
    writeFileSync(path, "moh");
    expect(sha256File(path)).toBe("828be15ed1f81219cc67dbd37022d29e9f51b7845aa856a3f3de1bd5a69815a4");
  });
});

describe("assetKey", () => {
  test("is a valid identifier per index", () => {
    expect(assetKey(0)).toBe("f0");
    expect(assetKey(12)).toBe("f12");
  });
});
