import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// #467: exported from the @moh/core index (ADR-0004 reopening, cited in
// packages/core/src/index.ts). Imported here from the public surface on purpose.
import { projectSlug, projectSessionsDir } from "../src/index";
import { legacyProjectSlug } from "../src/session-store";

describe("project directory exports (#467)", () => {
  test("projectSlug resolves the identity slug; projectSessionsDir appends it under <home>/.moh/projects", () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-467-"));
    mkdirSync(join(dir, ".moh"), { recursive: true });
    writeFileSync(join(dir, ".moh", "project.json"), `${JSON.stringify({ id: "index-export-test" })}\n`);
    const home = mkdtempSync(join(tmpdir(), "moh-467-home-"));
    const slug = projectSlug(dir, home);
    expect(slug).toMatch(/^project-[0-9a-f]{16}$/);
    expect(projectSessionsDir(dir, home)).toBe(join(home, ".moh", "projects", slug));
  });

  test("an undeclared cwd with no writable identity falls back to the legacy slug", () => {
    // /definitely/not/a/real cannot host .moh/project.json, so identity
    // resolution cannot create one: the legacy path slug is the fallback.
    expect(projectSlug("/definitely/not/a/real/cwd-467", "/definitely/not/a/real/home")).toBe(
      legacyProjectSlug("/definitely/not/a/real/cwd-467"),
    );
  });
});
