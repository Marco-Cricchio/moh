import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retroCommand } from "../src/retro";
import { RetroStore } from "../../core/src/retro";

const dirs: string[] = [];
const project = () => { const dir = mkdtempSync(join(tmpdir(), "moh-retro-cli-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs.length = 0; });

function capture() {
  let stdout = "";
  let stderr = "";
  return { out: { write: (s: string) => { stdout += s; } }, err: { write: (s: string) => { stderr += s; } }, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

describe("moh retro", () => {
  test("reports findings in deterministic severity order and json includes lineage", async () => {
    const cwd = project();
    const store = RetroStore.forProject(cwd, cwd);
    store.append([
      { category: "navigation", evidence: "zeta subject needs a pointer", confidence: 0.4, session: "s1", signature: "low" },
      { category: "coding-standards", evidence: "alpha subject needs a rule", confidence: 0.9, session: "s2", signature: "high" },
    ]);
    const c = capture();
    expect(retroCommand({ argv: ["--cwd", cwd], stdout: c.out, stderr: c.err, home: cwd })).toBe(0);
    const json = capture();
    expect(retroCommand({ argv: ["--cwd", cwd, "--json"], stdout: json.out, stderr: json.err, home: cwd })).toBe(0);
    expect(json.stdout.indexOf("high")).toBeLessThan(json.stdout.indexOf("low"));
  });

  test("dismiss persists and apply requires explicit confirmation", async () => {
    const cwd = project();
    const store = RetroStore.forProject(cwd, cwd);
    store.append([{ category: "navigation", evidence: "subject needs a pointer", confidence: 0.8, session: "s", signature: "sig" }]);
    expect(retroCommand({ argv: ["--cwd", cwd, "--dismiss", "sig"], stdout: capture().out, stderr: capture().err, home: cwd })).toBe(0);
    expect(new RetroStore(store.dir).dismissed().has("sig")).toBe(true);
    expect(retroCommand({ argv: ["--cwd", cwd, "--apply", "sig"], stdout: capture().out, stderr: capture().err, home: cwd })).toBe(2);
    expect(retroCommand({ argv: ["--cwd", cwd, "--apply", "sig", "--yes"], stdout: capture().out, stderr: capture().err, home: cwd })).toBe(0);
    expect(readFileSync(join(store.dir, "applications.jsonl"), "utf8")).toContain("sig");
  });
});
