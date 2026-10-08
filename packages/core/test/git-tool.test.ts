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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  test("transient -c config options that can execute commands are refused (#1254)", () => {
    for (const args of [
      ["-c", "diff.external=touch /tmp/pwned", "diff"],
      ["-cdiff.external=touch /tmp/pwned", "diff"],
      ["-c", "core.fsmonitor=touch /tmp/pwned", "status"],
      ["-c", "pager.log=touch /tmp/pwned", "log"],
    ]) {
      expect(() => git.execute({ args }, ctx)).toThrow(/-c/);
    }
    // the transient command never ran
    const marker = join(repo, ".pwned-marker");
    expect(() => git.execute({ args: ["-c", `diff.external=touch ${marker}`, "diff"] }, ctx)).toThrow();
    expect(existsSync(marker)).toBe(false);
  });

  test("--exec-path is refused (#1254)", () => {
    expect(() => git.execute({ args: ["--exec-path", "status"] }, ctx)).toThrow(/--exec-path/);
    expect(() => git.execute({ args: ["--exec-path=/tmp/x", "status"] }, ctx)).toThrow(/--exec-path/);
  });

  test("legitimate reads without transient options still succeed (#1254)", async () => {
    const log = await git.execute({ args: ["log", "--oneline", "-5"] }, ctx);
    expect(log).toContain("init");
    const name = await git.execute({ args: ["config", "--get", "user.name"] }, ctx);
    expect(name.trim()).toBe("t");
  });

  test("an optional per-call cwd works inside the root and refuses outside it (#1165)", async () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    const sub = await git.execute({ args: ["status", "--porcelain"], cwd: "src" }, ctx);
    expect(sub).toBe("");
    expect(() => git.execute({ args: ["status"], cwd: "/etc" }, ctx)).toThrow(/outside project root/i);
  });
});

describe("git tool transient-option and write-path filter (#1261, #1257)", () => {
  const canary = join(tmpdir(), "moh-git-canary");

  test.each([
    ["-c space form", ["-c", "core.fsmonitor=touch " + canary, "status"]],
    ["-c attached form", ["-ccore.fsmonitor=touch " + canary, "status"]],
    ["-c alias vector", ["-c", "alias.status=!touch " + canary, "status"]],
    ["--config-env", ["--config-env", "core.fsmonitor=POC_VAR", "status"]],
    ["--exec-path", ["--exec-path=" + tmpdir(), "status"]],
    ["--super-prefix", ["--super-prefix=" + tmpdir(), "status"]],
  ])("leading %s is refused before any spawn", async (_label, args) => {
    rmSync(canary, { force: true });
    expect(() => git.execute({ args }, ctx)).toThrow(/git: not allowed/);
    expect(() => execFileSync("test", ["-e", canary])).toThrow();
  });

  test("upload-pack-class vectors are refused at the closest reachable seam", async () => {
    // No allow-listed subcommand reaches upload-pack (fetch/pull/clone are
    // refused as subcommands before any option matters), so the closest
    // vectors are: a protocol-weakening transient config (the -c class the
    // RCE rides) and the fetch subcommand itself.
    expect(() => git.execute({ args: ["-c", "protocol.allow=never", "status"] }, ctx)).toThrow(/git: not allowed/);
    expect(() => git.execute({ args: ["fetch", "--upload-pack=touch " + canary, "origin"] }, ctx)).toThrow(
      /is not an allowed subcommand/,
    );
  });

  test("attached relocation forms (-C/tmp, --git-dir=/x, --work-tree=/y) are refused", () => {
    expect(() => git.execute({ args: ["-C/tmp", "status"] }, ctx)).toThrow(/relocates the repository/);
    expect(() => git.execute({ args: ["--git-dir=/tmp", "status"] }, ctx)).toThrow(/relocates the repository/);
    expect(() => git.execute({ args: ["--work-tree=/tmp", "status"] }, ctx)).toThrow(/relocates the repository/);
  });

  test.each([
    ["--output= attached", ["diff", "--output=" + canary]],
    ["--output space form", ["diff", "--output", canary]],
    ["--output on log", ["log", "-1", "--output=" + canary]],
    ["--output-indicator-new", ["diff", "--output-indicator-new=<X>"]],
    ["--output-indicator-old", ["diff", "--output-indicator-old=<X>"]],
    ["--output-indicator-context", ["diff", "--output-indicator-context=<X>"]],
    ["config --file= attached", ["config", "--file=" + canary, "--list"]],
    ["config --file space form", ["config", "--file", canary, "--list"]],
    ["config -f short form", ["config", "-f", canary, "--list"]],
    ["config --blob", ["config", "--blob=HEAD:a.txt", "--list"]],
  ])("post-subcommand %s is refused before any spawn", async (_label, args) => {
    rmSync(canary, { force: true });
    expect(() => git.execute({ args }, ctx)).toThrow(/git: (not allowed|read-only tool)/);
    expect(() => execFileSync("test", ["-e", canary])).toThrow();
  });

  test("plain read-only invocations still pass", async () => {
    await git.execute({ args: ["config", "--list"] }, ctx);
    await git.execute({ args: ["config", "--get", "user.name"] }, ctx);
    await git.execute({ args: ["diff", "--stat"] }, ctx);
    await git.execute({ args: ["log", "-1", "--oneline"] }, ctx);
    await git.execute({ args: ["status", "--short"] }, ctx);
  });
});
