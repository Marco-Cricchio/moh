/**
 * #1427 characterization: every `git` call site the one-runner step routes
 * through `src/git.ts`, pinned on real temp repositories before the change.
 *
 * Shapes: not a repository, a repository without `origin`, an `origin` with
 * credentials, a directory that does not exist (`git -C` answers with a
 * nonzero exit, a spawn `cwd:` throws), and git absent from PATH (a child
 * `bun`, see `fixtures/git-absent-probe.ts`). Git's and Bun's own error texts
 * are never asserted literally — where a message embeds git's stderr, the
 * expectation is computed by running the same argv directly.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinTools } from "../src/builtin-tools";
import { DevelopmentLaneService } from "../src/development-lane-service";
import { gitAnchor } from "../src/handoff";
import { cloneHandoffRepo } from "../src/handoff-reception";
import { canonicalRemoteSlug, prepareProjectIdentity, prepareProjectIdentityNow } from "../src/project-identity";
import { retroSignature, type RetroFinding } from "../src/retro";
import { applyRetroApplication } from "../src/retro-apply";
import { prepareTrackerRemote, resolveTracker, resolveTrackerSync } from "../src/tracker";
import type { ToolContext } from "../src/types";

const CRED_URL = "https://user:token@github.com/owner/repo.git";

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), `moh-1427-${prefix}-`));
const run = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
const ctx = (cwd: string): ToolContext => ({ signal: new AbortController().signal, cwd, onProgress: () => {} });

/** Not a repository — checked, because git searches upward. */
function noRepo(): string {
  const dir = temp("norepo");
  expect(run(dir, "rev-parse", "--git-dir").exitCode).not.toBe(0);
  return dir;
}
function noOrigin(): string {
  const dir = temp("noorigin");
  run(dir, "init", "-q");
  return dir;
}
function withCommit(dir: string): string {
  run(dir, "config", "user.email", "t@t");
  run(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "v1\n");
  run(dir, "add", "-A");
  run(dir, "commit", "-qm", "init");
  return dir;
}
function credOrigin(): string {
  const dir = noOrigin();
  run(dir, "remote", "add", "origin", CRED_URL);
  return dir;
}
const missing = () => join(temp("missing"), "does-not-exist");

const preCommit = (): RetroFinding => ({
  category: "missing-guardrail",
  evidence: "package.json defines `lint` and `test` but no pre-commit hook runs them",
  confidence: 0.8,
  session: "s",
  signature: retroSignature("missing-guardrail", "pre-commit:unwired"),
  appendedAt: "2026-01-01T00:00:00.000Z",
});
const withScripts = (dir: string) => {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { lint: "eslint .", test: "bun test" } }));
  return dir;
};

describe("origin probes (#1427 rows 1–5)", () => {
  test("resolveTracker with the default runner", async () => {
    expect(await resolveTracker({ cwd: noRepo() })).toBeNull();
    expect(await resolveTracker({ cwd: noOrigin() })).toBeNull();
    expect((await resolveTracker({ cwd: credOrigin() }))?.kind).toBe("gh");
    expect(await resolveTracker({ cwd: missing() })).toBeNull();
  });

  test("prepareTrackerRemote fills the sync twin's memo with the boot-time answer", async () => {
    const none = noRepo();
    await prepareTrackerRemote(none);
    run(none, "init", "-q");
    run(none, "remote", "add", "origin", CRED_URL);
    expect(resolveTrackerSync({ cwd: none })).toBeNull();

    const bare = noOrigin();
    await prepareTrackerRemote(bare);
    run(bare, "remote", "add", "origin", CRED_URL);
    expect(resolveTrackerSync({ cwd: bare })).toBeNull();

    const cred = credOrigin();
    await prepareTrackerRemote(cred);
    run(cred, "remote", "remove", "origin");
    expect(resolveTrackerSync({ cwd: cred })?.kind).toBe("gh");

    const gone = missing();
    await prepareTrackerRemote(gone);
    expect(resolveTrackerSync({ cwd: gone })).toBeNull();
  });

  test("resolveTrackerSync on a fresh cwd, then memory-served", () => {
    expect(resolveTrackerSync({ cwd: noRepo() })).toBeNull();
    expect(resolveTrackerSync({ cwd: noOrigin() })).toBeNull();
    expect(resolveTrackerSync({ cwd: missing() })).toBeNull();
    const cred = credOrigin();
    expect(resolveTrackerSync({ cwd: cred })?.kind).toBe("gh");
    run(cred, "remote", "remove", "origin");
    expect(resolveTrackerSync({ cwd: cred })?.kind).toBe("gh");
  });

  test("canonicalRemoteSlug: null without an origin, credentials normalized away", () => {
    expect(canonicalRemoteSlug(noRepo())).toBeNull();
    expect(canonicalRemoteSlug(noOrigin())).toBeNull();
    expect(canonicalRemoteSlug(missing())).toBeNull();
    const slug = canonicalRemoteSlug(credOrigin());
    expect(slug).toBe("github.com/owner/repo");
  });

  test("the async identity probe agrees with the sync one in every shape", async () => {
    for (const cwd of [noRepo(), noOrigin(), credOrigin()]) {
      const awaited = (await prepareProjectIdentity(cwd, temp("home-a"))).slug;
      const now = prepareProjectIdentityNow(cwd, temp("home-b")).slug;
      expect(awaited).toBe(now);
    }
    const cred = credOrigin();
    expect((await prepareProjectIdentity(cred, temp("home-c"))).slug).toBe("github.com/owner/repo");
  });
});

describe("handoff anchor (#1427 rows 6–8)", () => {
  test("fields are present only when git answers", () => {
    expect(gitAnchor(noRepo())).toEqual({});
    expect(gitAnchor(missing())).toEqual({});
    const repo = noOrigin();
    const empty = gitAnchor(repo);
    expect(typeof empty.branch).toBe("string");
    expect(empty.head).toBeUndefined();
    expect(empty.dirty).toBe(false);
    withCommit(repo);
    const clean = gitAnchor(repo);
    expect(clean.head).toMatch(/^[0-9a-f]{40}$/);
    expect(clean.dirty).toBe(false);
    writeFileSync(join(repo, "b.txt"), "new\n");
    expect(gitAnchor(repo).dirty).toBe(true);
  });
});

describe("retro-apply git dir (#1427 row 9)", () => {
  test("the hook lands in the repository's git dir, or <root>/.git outside one", () => {
    const plain = withScripts(noRepo());
    const a = applyRetroApplication({ finding: preCommit(), projectRoot: plain, confirm: true });
    expect(a).toMatchObject({ ok: true, created: true });
    expect(existsSync(join(plain, ".git", "hooks", "pre-commit"))).toBe(true);

    const main = withCommit(noOrigin());
    const lane = join(temp("wt"), "lane");
    run(main, "worktree", "add", "-q", lane);
    withScripts(lane);
    const b = applyRetroApplication({ finding: preCommit(), projectRoot: lane, confirm: true });
    expect(b).toMatchObject({ ok: true, created: true });
    expect(existsSync(join(main, ".git", "hooks", "pre-commit"))).toBe(true);
  });
  // A missing root is unreachable here (no package.json → refused before
  // the probe); the throwing shape is pinned by the git-absent child below.
});

describe("bash re-run guard snapshot (#1427 rows 10–11)", () => {
  test("outside a repository there is no snapshot, so an identical re-run is never intercepted", async () => {
    const dir = noRepo();
    writeFileSync(join(dir, "Makefile"), "\ntest:\n\tsleep 0.2 && echo '(pass) one'\n");
    const tools = builtinTools({ rerunMinMs: 100 });
    await tools.bash!.execute({ command: "make test" }, ctx(dir));
    const again = String(await tools.bash!.execute({ command: "make test" }, ctx(dir)));
    expect(again).toContain("(pass) one");
    expect(again).not.toContain("not re-executed");
  }, 10_000);
});

describe("git tool (#1427 row 12)", () => {
  const tools = builtinTools();
  const runTool = (args: string[], cwd: string) => tools.git!.execute({ args }, ctx(cwd));
  // The tool's execute throws synchronously; wrap it so both shapes land here.
  const message = async (call: () => unknown) => {
    try {
      await call();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("expected a throw");
  };

  test("a nonzero exit carries git's trimmed stderr, byte for byte", async () => {
    const dir = noRepo();
    const direct = run(dir, "status");
    expect(direct.exitCode).not.toBe(0);
    const err = direct.stderr.toString().trim();
    expect(err.length).toBeGreaterThan(0);
    expect(await message(() => runTool(["status"], dir))).toBe(`git exited with code ${direct.exitCode}: ${err}`);
  });

  test("a nonzero exit with an empty stderr has no colon tail", async () => {
    const repo = withCommit(noOrigin());
    writeFileSync(join(repo, "a.txt"), "v2\n");
    expect(await message(() => runTool(["diff", "--exit-code", "--quiet"], repo))).toBe("git exited with code 1");
  });

  test("stdout is returned untrimmed", async () => {
    const repo = withCommit(noOrigin());
    const direct = run(repo, "rev-parse", "HEAD").stdout.toString();
    expect(direct.endsWith("\n")).toBe(true);
    expect(await runTool(["rev-parse", "HEAD"], repo)).toBe(direct);
  });

  test("a missing cwd is a spawn failure, not an exit-code message", async () => {
    const text = await message(() => runTool(["status"], missing()));
    expect(text.startsWith("git exited with code")).toBe(false);
  });
});

describe("cold-start clone (#1427 row 13)", () => {
  test("clones a local repository", async () => {
    const source = withCommit(noOrigin());
    const result = await cloneHandoffRepo({ repoUrl: source, dest: temp("dest"), name: "c" });
    expect(result.ok).toBe(true);
  });

  test("a failed clone reports git's trimmed stderr", async () => {
    const dest = temp("dest");
    const target = join(dest, "c");
    const gone = missing();
    const direct = Bun.spawnSync(["git", "clone", gone, target], { stdout: "pipe", stderr: "pipe" });
    expect(direct.exitCode).not.toBe(0);
    expect(existsSync(target)).toBe(false);
    const result = await cloneHandoffRepo({ repoUrl: gone, dest, name: "c" });
    expect(result).toEqual({ ok: false, reason: "failed", message: direct.stderr.toString().trim() });
  });
});

describe("lane git runner default (#1427 row 14)", () => {
  const lane = (cwd: string) => new DevelopmentLaneService({ cwd, home: temp("lane-home") });
  const create = async (cwd: string, baseRef: string) => {
    const service = lane(cwd);
    const group = await service.ensureFeatureGroup("alpha", "main");
    return service.createWorktreeLane({ featureGroupId: group.id, sessionId: "s1", branchRef: "feature/a-1", baseRef });
  };

  test("an unknown base ref carries git's trimmed stderr", async () => {
    const repo = withCommit(noOrigin());
    const direct = Bun.spawnSync(["git", "-C", repo, "rev-parse", "--verify", "nope^{commit}"], { stdout: "pipe", stderr: "pipe" });
    expect(direct.exitCode).not.toBe(0);
    const result = await create(repo, "nope");
    expect(result).toEqual({ ok: false, error: { kind: "unknown-ref", message: `cannot resolve base ref "nope": ${direct.stderr.toString().trim()}` } });
  });

  test("a broken .git (git -C exits nonzero) is an unknown ref, not a rejection", async () => {
    const dir = temp("broken");
    writeFileSync(join(dir, ".git"), `gitdir: ${missing()}\n`);
    const result = await create(dir, "main");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("unknown-ref");
      expect(result.error.message.startsWith('cannot resolve base ref "main": ')).toBe(true);
    }
  });
});

describe("git absent from PATH (#1427, child process)", () => {
  test("every call site degrades exactly as today", async () => {
    // The child's PATH holds only what the probe needs besides git.
    const bin = temp("bin");
    for (const tool of ["bash", "make", "sleep"]) {
      const real = Bun.which(tool);
      expect(real).not.toBeNull();
      symlinkSync(real!, join(bin, tool));
    }
    const work = temp("absent");
    for (const name of ["repo", "repo2"]) {
      const dir = join(work, name);
      mkdirSync(dir);
      run(dir, "init", "-q");
      run(dir, "remote", "add", "origin", CRED_URL);
      withCommit(dir);
    }
    mkdirSync(join(work, "lane", ".git"), { recursive: true });

    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "git-absent-probe.ts"), work], {
      env: { ...process.env, PATH: bin },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });
    const out = JSON.parse(stdout.trim().split("\n").pop()!);
    expect(out).toEqual({
      resolveTracker: null,
      prepareThenSync: null,
      resolveTrackerSync: null,
      canonicalRemoteSlug: null,
      identityAsync: out.identitySync,
      identitySync: out.identitySync,
      gitAnchor: {},
      retroApply: { threw: true },
      bashRerunIntercepted: false,
      gitTool: { threw: true, exitCodeMessage: false },
      clone: { ok: false, reason: "failed", messageNonEmpty: true },
      lane: { rejected: false, ok: false, kind: "unknown-ref", prefixed: true },
    });
    // Without git the identity falls back to a non-remote slug.
    expect(out.identitySync).not.toBe("github.com/owner/repo");
  }, 30_000);
});
