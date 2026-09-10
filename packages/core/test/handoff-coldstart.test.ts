import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneHandoffRepo, isColdDirectory, pullHandoffTo, type GitCall, type GitRunner } from "../src/handoff-coldstart";
import { legacyProjectSlug } from "../src/project-identity";
import { resolve as pathResolve } from "node:path";
import type { GhCall, GhRunner } from "../src/handoff-gist";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    version: 2 as const, kind: "raw" as const, sessionId: "session", updatedAt: "2026-09-03T00:00:00.000Z",
    git: { branch: "develop", head: "abc", dirty: false }, turns: 2,
    lastUserMessage: "Continue the migration", lastAssistantMessage: "Done",
    files: [], tests: [], counts: { toolCalls: 0, errors: 0, cancelled: 0 },
    ...overrides,
  };
}

function fakeGit(responses: Array<{ match: (args: string[]) => boolean; exitCode?: number; stderr?: string }>): GitRunner & { calls: GitCall[] } {
  const calls: GitCall[] = [];
  const runner: GitRunner = async (call) => {
    calls.push(call);
    const response = responses.find((candidate) => candidate.match(call.args));
    return response
      ? { exitCode: response.exitCode ?? 0, stdout: "", stderr: response.stderr ?? "" }
      : { exitCode: 1, stdout: "", stderr: `unexpected: ${call.args.join(" ")}` };
  };
  return Object.assign(runner, { calls });
}

describe("isColdDirectory", () => {
  test("a directory with no .git anywhere above and no sessions is cold", () => {
    const root = mkdtempSync(join(tmpdir(), "moh-cold-"));
    const home = join(root, "home");
    mkdirSync(join(home, ".moh"), { recursive: true });
    try {
      expect(isColdDirectory(root, home)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a .git above the cwd makes it not cold, even with zero sessions", () => {
    const root = mkdtempSync(join(tmpdir(), "moh-cold-"));
    const home = join(root, "home");
    mkdirSync(join(home, ".moh"), { recursive: true });
    mkdirSync(join(root, "repo", "sub"), { recursive: true });
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    try {
      expect(isColdDirectory(join(root, "repo", "sub"), home)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("local sessions make it not cold", () => {
    const root = mkdtempSync(join(tmpdir(), "moh-cold-"));
    const home = join(root, "home");
    // Same slug derivation as the store: no git → the legacy path slug
    // (resolved, like project-identity does).
    const projectDir = join(home, ".moh", "projects", legacyProjectSlug(pathResolve(root)));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "20260901T000000000Z-0123abcd.jsonl"), "\n");
    try {
      expect(isColdDirectory(root, home)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("cloneHandoffRepo", () => {
  test("clones the canonical https URL into dest/<name> with .git stripped", async () => {
    const dest = mkdtempSync(join(tmpdir(), "moh-clone-"));
    try {
      const git = fakeGit([{ match: (args) => args[0] === "clone" }]);
      const result = await cloneHandoffRepo({ repoUrl: "https://github.com/acme/project.git", dest, git });
      expect(result).toEqual({ ok: true, path: join(dest, "project") });
      expect(git.calls[0]!.args).toEqual(["clone", "https://github.com/acme/project.git", join(dest, "project")]);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  test("refuses to touch an existing directory", async () => {
    const dest = mkdtempSync(join(tmpdir(), "moh-clone-"));
    mkdirSync(join(dest, "project"));
    try {
      const git = fakeGit([{ match: () => true }]);
      const result = await cloneHandoffRepo({ repoUrl: "https://github.com/acme/project.git", dest, git });
      expect(result.ok).toBe(false);
      if (!result.ok && result.reason === "exists") expect(result.path).toBe(join(dest, "project"));
      expect(git.calls).toHaveLength(0);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  test("a failed clone is a typed failure with git's message", async () => {
    const dest = mkdtempSync(join(tmpdir(), "moh-clone-"));
    try {
      const git = fakeGit([{ match: (args) => args[0] === "clone", exitCode: 128, stderr: "fatal: repository not found\n" }]);
      const result = await cloneHandoffRepo({ repoUrl: "https://github.com/acme/missing.git", dest, git });
      expect(result).toEqual({ ok: false, reason: "failed", message: "fatal: repository not found" });
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });
});

describe("pullHandoffTo", () => {
  const root = mkdtempSync(join(tmpdir(), "moh-pull-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".moh"), { recursive: true });

  test("parks the given payload as the clone's imported handoff", async () => {
    const clone = join(root, "clone-a");
    mkdirSync(clone, { recursive: true });
    const result = await pullHandoffTo({ cwd: clone, home, offer: { url: "https://gist.github.com/one", updatedAt: "2026-09-03T00:00:00.000Z" }, payload: payload() });
    expect(result.ok).toBe(true);
    rmSync(clone, { recursive: true, force: true });
  });

  test("fetches via the injected fetchByUrl when no payload is given", async () => {
    const clone = join(root, "clone-b");
    mkdirSync(clone, { recursive: true });
    const result = await pullHandoffTo({
      cwd: clone, home,
      offer: { url: "https://gist.github.com/two", updatedAt: "2026-09-03T00:00:00.000Z" },
      fetchByUrl: async (url) => (url.endsWith("two") ? { ok: true as const, payload: payload() } : { ok: false as const, error: { reason: "failed" as const, message: "no" } }),
    });
    expect(result.ok).toBe(true);
    rmSync(clone, { recursive: true, force: true });
  });

  test("a foreign-author payload is declined with a visible message", async () => {
    const clone = join(root, "clone-c");
    mkdirSync(clone, { recursive: true });
    const result = await pullHandoffTo({
      cwd: clone, home, expectedAuthor: "marco",
      offer: { url: "https://gist.github.com/three", updatedAt: "2026-09-03T00:00:00.000Z" },
      payload: payload({ author: "someone-else" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("someone-else");
    rmSync(clone, { recursive: true, force: true });
  });

  test("a fetch failure surfaces as a typed message, never a throw", async () => {
    const clone = join(root, "clone-d");
    mkdirSync(clone, { recursive: true });
    const result = await pullHandoffTo({
      cwd: clone, home,
      offer: { url: "https://gist.github.com/four", updatedAt: "2026-09-03T00:00:00.000Z" },
      fetchByUrl: async () => ({ ok: false as const, error: { reason: "gh-missing" as const } }),
    });
    expect(result).toEqual({ ok: false, message: "gh is not installed" });
    rmSync(clone, { recursive: true, force: true });
  });

  rmSync(root, { recursive: true, force: true });
});

describe("gh integration contract", () => {
  test("the scan's fetched payload satisfies pullHandoffTo directly", async () => {
    // Pins the seam between #594 discovery and the #595 pull: one payload
    // object flows from scan → wizard → import without reshaping.
    const gh: GhRunner = async (call: GhCall) => ({ exitCode: 0, stdout: JSON.stringify(payload({ author: "marco" })), stderr: "" });
    const clone = mkdtempSync(join(tmpdir(), "moh-seam-"));
    const home = join(clone, "home");
    mkdirSync(join(home, ".moh"), { recursive: true });
    try {
      const result = await pullHandoffTo({
        cwd: clone, home, expectedAuthor: "marco",
        offer: { url: "https://gist.github.com/one", updatedAt: "2026-09-03T00:00:00.000Z" },
        fetchByUrl: async () => (await gh({ args: [] })).exitCode === 0 ? { ok: true as const, payload: payload({ author: "marco" }) } : { ok: false as const, error: { reason: "failed" as const, message: "gh failed" } },
      });
      expect(result.ok).toBe(true);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });
});
