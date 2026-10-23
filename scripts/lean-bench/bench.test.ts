import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BASE_PROMPT } from "../../packages/core/src/prompt-composer";
import { diffMetrics, parseBasePrompt } from "./bench";

const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", ...args], { cwd });

describe("lean bench", () => {
  test("parses the shipped BASE_PROMPT out of its source", () => {
    const source = readFileSync(resolve(import.meta.dir, "../../packages/core/src/prompt-composer.ts"), "utf8");
    expect(parseBasePrompt(source)).toBe(BASE_PROMPT);
  });

  test("diff metrics count added files and flag symbols with no other occurrence", () => {
    const cwd = mkdtempSync(join(tmpdir(), "lean-bench-test-"));
    git(cwd, "init", "-q");
    writeFileSync(join(cwd, "a.ts"), "export const existing = 1;\n");
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", "base");
    writeFileSync(join(cwd, "a.ts"), "export const existing = 1;\nexport function used() {}\nexport function orphan() {}\n");
    writeFileSync(join(cwd, "b.ts"), "import { used } from './a';\nused();\n");
    git(cwd, "add", "-A");
    const m = diffMetrics(cwd);
    expect(m.filesAdded).toBe(1);
    expect(m.linesAdded).toBe(4);
    expect(m.uncalledSymbols).toEqual(["orphan"]);
  });
});
