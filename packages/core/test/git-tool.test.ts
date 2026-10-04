/**
 * The read-only `git` built-in tool (T7, #1165): the whole-tool grant
 * `tool:git` (ADR-0067) needed a referent — a tool whose entire surface is
 * repository *reads*, so Jev's diff/status snapshots can cross the host
 * seam without granting the shell. Decisions owned here:
 *
 * - read-only allow-list: the tool executes only the inspection
 *   subcommands Jev's uses need (status, diff, log, show, rev-parse,
 *   ls-files, branch, remote, describe, config --get); anything else —
 *   `commit`, `push`, `clean`, an unknown word — is a typed refusal, never
 *   a spawn;
 * - cwd is the ToolContext's (the project root); no `-C` passthrough — a
 *   read elsewhere is a different question the tool never answers;
 * - non-zero exit is a failed tool_result carrying stderr, the same shape
 *   the model-facing tools use for self-correction;
 * - outside a repository, reads fail with git's own wording (the guardrail
 *   and the gate treat that as "inert", never as a crash).
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinTools } from "../src/builtin-tools";
import type { ToolContext } from "../src/types";

const repo = mkdtempSync(join(tmpdir(), "moh-git-tool-"));
execFileSync("git", ["init", "-q"], { cwd: repo });
execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
writeFileSync(join(repo, "a.txt"), "one\n");
execFileSync("git", ["add", "."], { cwd: repo });
execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });

const ctx: ToolContext = { signal: new AbortController().signal, cwd: repo, onProgress: () => {} };
const git = builtinTools().git;

describe("read-only git tool (#1165)", () => {
  test("runs an allowed read subcommand in the session cwd", async () => {
    const out = await git.execute({ args: ["status", "--porcelain"] }, ctx);
    expect(out).toBe("");
    const head = await git.execute({ args: ["rev-parse", "HEAD"] }, ctx);
    expect(head.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  test("a tracked modification shows in status and diff", async () => {
    writeFileSync(join(repo, "a.txt"), "two\n");
    try {
      const status = await git.execute({ args: ["status", "--porcelain"] }, ctx);
      expect(status).toContain("M a.txt");
      const diff = await git.execute({ args: ["diff", "--no-color"] }, ctx);
      expect(diff).toContain("+two");
    } finally {
      writeFileSync(join(repo, "a.txt"), "one\n");
    }
  });

  test("each write/unknown subcommand is refused without spawning", async () => {
    for (const args of [
      ["commit", "-m", "x"],
      ["push"],
      ["clean", "-fd"],
      ["checkout", "--", "a.txt"],
      ["add", "a.txt"],
      ["reset", "--hard"],
      ["clone", "https://example.invalid/x"],
    ]) {
      expect(() => git.execute({ args }, ctx)).toThrow(/read-only/i);
    }
  });

  test("global flags that relocate the repository are refused (-C, --git-dir)", async () => {
    expect(() => git.execute({ args: ["-C", "/etc", "status"] }, ctx)).toThrow(/not allowed/i);
    expect(() => git.execute({ args: ["--git-dir=/tmp/x", "status"] }, ctx)).toThrow(/not allowed/i);
  });

  test("empty args are refused", async () => {
    expect(() => git.execute({ args: [] }, ctx)).toThrow();
  });

  test("a non-zero exit is a failed result carrying stderr", async () => {
    expect(() => git.execute({ args: ["rev-parse", "--verify", "no-such-ref"] }, ctx)).toThrow(/no-such-ref|Failed|fatal/i);
  });

  test("outside a repository the read fails with git's wording, not a crash", async () => {
    const plain = mkdtempSync(join(tmpdir(), "moh-git-plain-"));
    try {
      expect(() => git.execute({ args: ["status", "--porcelain"] }, { ...ctx, cwd: plain })).toThrow();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  test("allowed read-only config reads pass; config writes do not", async () => {
    const email = await git.execute({ args: ["config", "--get", "user.email"] }, ctx);
    expect(email.trim()).toBe("t@t");
    expect(() => git.execute({ args: ["config", "user.email", "x@x"] }, ctx)).toThrow(/read-only/i);
  });

  test("an optional per-call cwd works inside the root and refuses outside it (#1165)", async () => {
    const sub = await git.execute({ args: ["status", "--porcelain"], cwd: "." }, ctx);
    expect(sub).toBe("");
    expect(() => git.execute({ args: ["status"], cwd: "/etc" }, ctx)).toThrow(/outside the session root/i);
  });
});
