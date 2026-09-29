/**
 * #1068: the release artifact is a single-file binary, and only a compiled
 * binary exercises the module resolution the shipped product actually uses.
 * An enabled browser passed every source-run test — the full suite included —
 * while every released binary died at session assembly, because a module was
 * reached through a `require` the bundler cannot rewrite into its internal
 * registry. Source runs answer that specifier from the real filesystem, so
 * no amount of source testing could see it.
 *
 * This gate compiles what the release pipeline compiles (same build recipe,
 * #1068) and runs one mock session against it. Runs in the always-on
 * `scripts` CI job: no network, no credentials, no Chromium. A host with no
 * matching release target has no binary to run and skips.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBinary, TARGETS } from "./build";

const HOST = `${process.platform}-${process.arch}`;
const PLATFORM = TARGETS.find((t) => t.platform === HOST)?.platform;

describe.skipIf(!PLATFORM)(`a compiled binary starts a session (${HOST})`, () => {
  const dir = mkdtempSync(join(tmpdir(), "moh-compiled-"));
  let binary = "";

  beforeAll(() => {
    binary = buildBinary({
      platform: PLATFORM!,
      version: "0.0.0-compiled-gate",
      outfile: join(dir, "moh"),
      buildDir: join(dir, "build"),
    });
  }, 180_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** One real session against the compiled binary: isolated project + home. */
  const runSession = (config: Record<string, unknown>) => {
    const cwd = mkdtempSync(join(dir, "project-"));
    const home = mkdtempSync(join(dir, "home-"));
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock", ...config }));
    const proc = spawnSync(binary, ["run", "say hi"], {
      cwd,
      env: { ...process.env, HOME: home, MOH_ENDPOINT_TEST_API_KEY: "" },
      encoding: "utf8",
      timeout: 120_000,
    });
    const stdout = proc.stdout ?? "";
    return {
      code: proc.status ?? -1,
      stdout,
      stderr: proc.stderr ?? "",
      events: stdout.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as { type: string }),
    };
  };

  test("enabled browser, missing toolchain: the session runs and the diagnostic is the only complaint", () => {
    const { code, stdout, stderr, events } = runSession({ browser: { enabled: true, headless: true } });
    // The regression itself, at the level the user saw it.
    expect(`${stderr}${stdout}`).not.toContain("Cannot find module");
    expect(code).toBe(0);
    // A missing toolchain stays a diagnostic: visible, actionable, never a
    // session failure (#935/#936 — the promise ADR-0029 makes).
    expect(stderr).toContain("moh browser install");
    expect(events[0]!.type).toBe("session_start");
    expect(events.filter((e) => e.type === "browser_unavailable")).toHaveLength(1);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)!.type).toBe("done");
  });

  test("absent or disabled browser: no tool, no diagnostic, no probe", () => {
    for (const config of [{}, { browser: { enabled: false } }]) {
      const { code, stdout, stderr, events } = runSession(config);
      expect(code).toBe(0);
      expect(stderr).not.toContain("browser");
      expect(stdout).not.toContain("browser_unavailable");
      expect(events.at(-1)!.type).toBe("done");
    }
  });
});
