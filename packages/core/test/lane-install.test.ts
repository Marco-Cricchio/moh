/**
 * ADR-0060 amendment 5: the install a directory declares, and whether it
 * owns its store. Detection is pure over the directory's own files, so
 * every row of the table is pinned here — the service tests cover *when*
 * the install runs, not what it resolves to.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectLaneSetup,
  foreignStore,
  foreignWorkspaceLinks,
  installLaneDependencies,
  laneInstallLine,
  laneOwnsInstall,
  removeForeignStore,
} from "../src/lane-install";

function dir(files: Record<string, string> = {}): string {
  const path = mkdtempSync(join(tmpdir(), "moh-lane-install-"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(path, name, ".."), { recursive: true });
    writeFileSync(join(path, name), body);
  }
  return path;
}

describe("detectLaneSetup (ADR-0060 amendment 5)", () => {
  test("lanes.setup is the last word: a string wins, false means nothing", () => {
    const path = dir({ "package.json": JSON.stringify({ packageManager: "bun@1.2.19" }) });
    expect(detectLaneSetup(path, "make deps")).toEqual({ kind: "install", command: "make deps", fingerprint: "" });
    expect(detectLaneSetup(path, false)).toEqual({ kind: "nothing" });
  });

  test("package.json's packageManager comes before the lockfiles", () => {
    const path = dir({
      "package.json": JSON.stringify({ packageManager: "pnpm@9.1.0" }),
      "yarn.lock": "",
    });
    const detection = detectLaneSetup(path);
    expect(detection.kind).toBe("install");
    if (detection.kind === "install") {
      expect(detection.command).toBe("pnpm install");
      expect(detection.fingerprint).toHaveLength(12);
    }
  });

  test("an unknown packageManager falls through to the lockfile table", () => {
    const path = dir({ "package.json": JSON.stringify({ packageManager: "some-manager@1" }), "pnpm-lock.yaml": "" });
    expect(detectLaneSetup(path)).toMatchObject({ kind: "install", command: "pnpm install" });
  });

  test("the lockfile table covers the project-store ecosystems", () => {
    const rows: ReadonlyArray<[string, string]> = [
      ["bun.lock", "bun install"],
      ["bun.lockb", "bun install"],
      ["package-lock.json", "npm install"],
      ["yarn.lock", "yarn install"],
      ["pnpm-lock.yaml", "pnpm install"],
      ["uv.lock", "uv sync"],
      ["composer.lock", "composer install"],
      ["mix.lock", "mix deps.get"],
      ["poetry.lock", "poetry install"],
      ["Gemfile.lock", "bundle install"],
    ];
    for (const [lockfile, command] of rows) {
      expect(detectLaneSetup(dir({ [lockfile]: "x" }))).toMatchObject({ kind: "install", command });
    }
  });

  test("a user-level store runs nothing and reports nothing", () => {
    expect(detectLaneSetup(dir({ "Cargo.toml": "[package]", "Cargo.lock": "x" }))).toEqual({ kind: "nothing" });
    expect(detectLaneSetup(dir({ "go.mod": "module x", "go.sum": "x" }))).toEqual({ kind: "nothing" });
    expect(detectLaneSetup(dir({ "build.gradle.kts": "" }))).toEqual({ kind: "nothing" });
  });

  test("a manifest with no recognized install is a visible nothing; no manifest is silent", () => {
    const unrecognized = detectLaneSetup(dir({ "pyproject.toml": "[project]" }));
    expect(unrecognized.kind).toBe("nothing");
    if (unrecognized.kind === "nothing") expect(unrecognized.reason).toContain("lanes.setup");
    expect(detectLaneSetup(dir({ "README.md": "hi" }))).toEqual({ kind: "nothing" });
  });
});

describe("laneOwnsInstall (ADR-0060 amendment 5)", () => {
  test("a real store with links inside the worktree is owned", () => {
    const path = dir();
    mkdirSync(join(path, "packages", "core"), { recursive: true });
    mkdirSync(join(path, "node_modules", "@moh"), { recursive: true });
    symlinkSync(join(path, "packages", "core"), join(path, "node_modules", "@moh", "core"));
    expect(laneOwnsInstall(path)).toBe(true);
    expect(foreignWorkspaceLinks(path)).toEqual([]);
    expect(foreignStore(path)).toBe(false);
  });

  test("a link into the worktree's own hoisted store is owned, not foreign", () => {
    // bun keeps every workspace's link in node_modules/.bun and points the
    // package at it: an entirely correct layout for a lane's own install.
    const path = dir();
    const hoisted = join(path, "node_modules", ".bun", "core@1.0.0", "node_modules", "core");
    mkdirSync(hoisted, { recursive: true });
    mkdirSync(join(path, "node_modules", "@moh"), { recursive: true });
    symlinkSync(hoisted, join(path, "node_modules", "@moh", "core"));
    expect(laneOwnsInstall(path)).toBe(true);
    expect(foreignWorkspaceLinks(path)).toEqual([]);
  });

  test("a symlinked store, a missing store, and a foreign link are not owned", () => {
    const shared = dir({ "node_modules/.keep": "" });
    const linked = dir();
    symlinkSync(join(shared, "node_modules"), join(linked, "node_modules"));
    expect(laneOwnsInstall(linked)).toBe(false);
    expect(foreignStore(linked)).toBe(true);

    expect(laneOwnsInstall(dir())).toBe(false);

    const foreign = dir();
    mkdirSync(join(foreign, "node_modules", "@moh"), { recursive: true });
    symlinkSync(join(shared, "node_modules"), join(foreign, "node_modules", "@moh", "core"));
    expect(laneOwnsInstall(foreign)).toBe(false);
    expect(foreignStore(foreign)).toBe(true);
    expect(foreignWorkspaceLinks(foreign)[0]).toContain("core →");
  });

  test("removeForeignStore discards a foreign store — and a store that is gone is no-op", () => {
    const shared = dir({ "node_modules/.keep": "" });
    const linked = dir({ "keep.txt": "mine" });
    symlinkSync(join(shared, "node_modules"), join(linked, "node_modules"));
    removeForeignStore(linked);
    expect(existsSync(join(linked, "node_modules"))).toBe(false);
    expect(existsSync(join(linked, "keep.txt"))).toBe(true); // only the store
    // An absent store, and an owned one, are both left alone.
    removeForeignStore(linked);
    const owned = dir();
    mkdirSync(join(owned, "node_modules"), { recursive: true });
    removeForeignStore(owned);
    expect(existsSync(join(owned, "node_modules"))).toBe(true);
  });
});

describe("installLaneDependencies (ADR-0060 amendment 5)", () => {
  test("runs the detected command in the worktree and records the outcome", async () => {
    const path = dir({ "bun.lock": "lock-body" });
    const runs: { command: string; cwd: string }[] = [];
    const outcome = await installLaneDependencies({
      worktreePath: path,
      runner: async (input) => {
        runs.push(input);
        return { ok: true, output: "" };
      },
    });
    expect(runs).toEqual([{ command: "bun install", cwd: path }]);
    expect(outcome.kind).toBe("installed");
    if (outcome.kind === "installed") expect(outcome.fingerprint).toHaveLength(12);
  });

  test("a failure carries the first non-empty output line, and never spawns for nothing", async () => {
    const failing = await installLaneDependencies({
      worktreePath: dir({ "bun.lock": "" }),
      runner: async () => ({ ok: false, output: "\nerror: nope\nmore" }),
    });
    expect(failing).toEqual({ kind: "failed", command: "bun install", reason: "error: nope", at: expect.any(String) });

    let spawned = 0;
    const nothing = await installLaneDependencies({
      worktreePath: dir({ "Cargo.lock": "" }),
      runner: async () => {
        spawned += 1;
        return { ok: true, output: "" };
      },
    });
    expect(spawned).toBe(0);
    expect(nothing.kind).toBe("nothing");
  });
});

describe("laneInstallLine (ADR-0060 amendment 5)", () => {
  test("one sentence per outcome, or null when there is nothing to state", () => {
    expect(laneInstallLine(undefined)).toBeNull();
    expect(laneInstallLine({ kind: "installed", command: "bun install", fingerprint: "abc", at: "x" })).toBe("install bun install");
    // A silent nothing (a user-level store, no manifest) states nothing.
    expect(laneInstallLine({ kind: "nothing", at: "x" })).toBeNull();
    expect(laneInstallLine({ kind: "nothing", at: "x", reason: "no recognized install command" })).toBe("install nothing (no recognized install command)");
    expect(laneInstallLine({ kind: "failed", command: "npm install", reason: "boom", at: "x" })).toBe("install FAILED (npm install): boom — retried on the next open");
  });
});
