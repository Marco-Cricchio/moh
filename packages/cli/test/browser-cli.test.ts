/**
 * `moh browser` (#936): the CLI door the browser diagnostics point at.
 * The probe and the installer are injected — the real ones are covered by
 * core (`browser-toolchain.test.ts`); what this file pins is the client
 * contract: rendering, the plan flags, exit codes, and the fact that a
 * real child-process run against an isolated home reports "not ready"
 * without touching the user's toolchain.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserToolchainStatus } from "@moh/core";
import { browserCommand } from "../src/browser";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  const w = (buf: string[]) => ({ write: (s: string) => void buf.push(s) } as unknown as NodeJS.WritableStream);
  return { out, err, stdout: w(out), stderr: w(err), text: () => out.join(""), errors: () => err.join("") };
}

const STATUS: BrowserToolchainStatus = {
  root: "/home/u/.moh/browser-toolchain",
  package: { available: true, version: "1.55.0", packageDir: "/home/u/.moh/browser-toolchain/node_modules/playwright-core", source: "moh" },
  chromium: { available: false },
  chromiumHeadlessShell: { available: true, path: "/cache/chromium-headless-shell", version: "140.0.1" },
  ready: true,
  reasons: [],
};

const MISSING: BrowserToolchainStatus = {
  root: "/home/u/.moh/browser-toolchain",
  package: { available: false },
  chromium: { available: false },
  chromiumHeadlessShell: { available: false },
  ready: false,
  reasons: ["playwright-core is not installed — the browser tool needs playwright-core plus a Chromium build; run `moh browser install` (or Settings → Browser → Install)"],
};

describe("moh browser (#936)", () => {
  test("--help prints the usage, exit 0", async () => {
    const { stdout, stderr, text } = io();
    const code = await browserCommand({ argv: ["--help"], stdout, stderr });
    expect(code).toBe(0);
    expect(text()).toContain("usage: moh browser");
    expect(text()).toContain("install   install or refresh playwright-core");
    expect(text()).toContain("--with-chromium");
  });

  test("status is the default subcommand and renders one row per component", async () => {
    const { stdout, stderr, text } = io();
    const code = await browserCommand({ argv: [], stdout, stderr, probe: () => STATUS });
    expect(code).toBe(0);
    expect(text()).toContain("browser toolchain · /home/u/.moh/browser-toolchain");
    expect(text()).toContain("playwright-core");
    expect(text()).toContain("1.55.0 · moh toolchain");
    expect(text()).toContain("chromium headless shell");
    expect(text()).toContain("ready · 140.0.1");
    expect(text()).toContain("chromium (full build)");
    expect(text()).toContain("missing");
    expect(text()).toContain("ready for a headless launch: yes");
    // The full build is a separate, explicit choice — never a silent download.
    expect(text()).toContain("--with-chromium");
  });

  test("status of a missing toolchain: exit 1 and the core's actionable reasons", async () => {
    const { stdout, stderr, text } = io();
    const code = await browserCommand({ argv: ["status"], stdout, stderr, probe: () => MISSING });
    expect(code).toBe(1);
    expect(text()).toContain("ready for a headless launch: no");
    expect(text()).toContain("playwright-core is not installed");
    expect(text()).toContain("moh browser install");
  });

  test("install flags are refused on status, exit 2", async () => {
    const { stdout, stderr, errors } = io();
    const code = await browserCommand({ argv: ["status", "--with-chromium"], stdout, stderr, probe: () => STATUS });
    expect(code).toBe(2);
    expect(errors()).toContain("apply to install");
  });

  test("unknown subcommand and unknown flag → usage on stderr, exit 2", async () => {
    const bad = io();
    expect(await browserCommand({ argv: ["nope"], stdout: bad.stdout, stderr: bad.stderr })).toBe(2);
    expect(bad.errors()).toContain('unknown subcommand "nope"');
    const flag = io();
    expect(await browserCommand({ argv: ["status", "--nope"], stdout: flag.stdout, stderr: flag.stderr })).toBe(2);
    expect(flag.errors()).toContain("unknown flag --nope");
  });

  test("install passes the plan to the core seam and commits one line per phase", async () => {
    const { stdout, stderr, text } = io();
    const seen: { cwd?: string; home?: string; withChromium?: boolean; withDeps?: boolean }[] = [];
    const code = await browserCommand({
      argv: ["install", "--with-chromium", "--with-deps", "--cwd", "/proj"],
      stdout,
      stderr,
      cwd: "/ignored",
      home: "/home/u",
      install: async (options) => {
        seen.push({ cwd: options.cwd, home: options.home, withChromium: options.withChromium, withDeps: options.withDeps });
        options.onProgress?.({ phase: "start", message: "installing playwright-core into /home/u/.moh/browser-toolchain" });
        options.onProgress?.({ phase: "package", message: "installing playwright-core" });
        // A streamed subprocess line inside an open phase adds no row.
        options.onProgress?.({ phase: "package", message: "installing playwright-core", line: "Resolving dependencies" });
        options.onProgress?.({ phase: "done", message: "browser toolchain ready (playwright-core 1.55.0)" });
        return { ok: true, version: "1.55.0", builds: ["chromium-headless-shell", "chromium"], status: STATUS };
      },
    });
    expect(code).toBe(0);
    expect(seen).toEqual([{ cwd: "/proj", home: "/home/u", withChromium: true, withDeps: true }]);
    expect(text()).toContain("✓ installing playwright-core into /home/u/.moh/browser-toolchain");
    expect(text()).toContain("✓ installing playwright-core");
    expect(text()).toContain("✓ browser toolchain ready (playwright-core 1.55.0)");
    expect(text()).not.toContain("Resolving dependencies");
  });

  test("a failed install reports the core's message on stderr, exit 1", async () => {
    const { stdout, stderr, errors } = io();
    const code = await browserCommand({
      argv: ["install"],
      stdout,
      stderr,
      install: async () => ({ ok: false, kind: "busy", message: "another moh process is installing the browser toolchain", status: MISSING }),
    });
    expect(code).toBe(1);
    expect(errors()).toContain("moh browser install: another moh process is installing the browser toolchain");
  });

  test("child process: an isolated home reports the missing toolchain, exit 1", () => {
    const root = mkdtempSync(join(tmpdir(), "moh-browser-cli-"));
    const home = join(root, "home");
    const cwd = join(root, "proj");
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const proc = Bun.spawnSync(
      ["bun", join(import.meta.dir, "..", "src", "cli.ts"), "browser", "status", "--cwd", cwd],
      { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
    );
    const stdout = new TextDecoder().decode(proc.stdout);
    expect(proc.exitCode).toBe(1);
    expect(stdout).toContain("ready for a headless launch: no");
    expect(stdout).toContain("playwright-core is not installed");
  });
});
