/**
 * #1068: the release artifact is a single-file binary, and only a compiled
 * binary exercises the module resolution the shipped product uses. An
 * enabled browser passed every source-run test — the full suite included —
 * while every released binary died at session assembly, because a module
 * was reached through a `require` the bundler cannot rewrite into its
 * internal registry: source runs answer that specifier from the real
 * filesystem, so no amount of source testing could see it.
 *
 * This gate compiles what the release pipeline compiles (one shared build
 * recipe) and runs real mock sessions against the artifact: the enabled,
 * absent and disabled browser paths. It runs in the `scripts` CI job — no
 * network, no credentials, no Chromium. On a host with no matching release
 * target there is no artifact to run, so it skips.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBinary, TARGETS, type Platform } from "./build";

/** The release target for this host, or undefined where there is none. */
const hostPlatform: Platform | undefined = TARGETS.find(
  (t) => t.platform === `${process.platform}-${process.arch}`,
)?.platform;

describe.skipIf(!hostPlatform)(`a compiled binary starts a session (${hostPlatform})`, () => {
  let dir = "";
  let binary = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "moh-compiled-"));
    binary = buildBinary({
      platform: hostPlatform!,
      version: "0.0.0-compiled-gate",
      outfile: join(dir, "moh"),
      buildDir: join(dir, "build"),
    });
  }, 180_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** One real session against the compiled binary: isolated project + home. */
  const runSession = (config: Record<string, unknown>) => {
    const cwd = mkdtempSync(join(dir, "project-"));
    const home = mkdtempSync(join(dir, "home-"));
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock", ...config }));
    const proc = spawnSync(binary, ["run", "say hi"], {
      cwd,
      env: { ...process.env, HOME: home, MOH_ENDPOINT_TEST_API_KEY: "" },
      encoding: "utf8",
      // node:child_process, not Bun.spawnSync: a binary that hangs is one of
      // the failures this gate exists for, so the timeout is load-bearing
      // and the node API carries it unchanged across bun versions.
      timeout: 60_000,
    });
    const stdout = proc.stdout ?? "";
    return {
      code: proc.status ?? -1,
      stdout,
      stderr: proc.stderr ?? "",
      events: stdout.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as { type: string }),
    };
  };

  // What this gate can and cannot see: `session_start` carries no tool list,
  // so whether the browser tool was *registered* is asserted where it is
  // directly observable — in-process, on the assembled session's tools
  // (from-config's own tests). Here the observable is the documented
  // behaviour of the shipped artifact: an enabled browser without a
  // toolchain says so once and the session still runs.

  test("enabled browser, missing toolchain: the session runs and the diagnostic is the only complaint", () => {
    const { code, stdout, stderr, events } = runSession({ browser: { enabled: true, headless: true } });
    // The regression itself, at the level the user saw it: an enabled
    // browser aborted assembly before the first turn.
    expect(`${stderr}${stdout}`).not.toContain("Cannot find module");
    expect(code).toBe(0);
    expect(events[0]!.type).toBe("session_start");
    // The diagnostic is emitted exactly on the enabled-and-unavailable
    // branch — the branch in which no browser tool is registered (#935).
    expect(events.filter((e) => e.type === "browser_unavailable")).toHaveLength(1);
    // And it stays a diagnostic: visible and actionable on the client's own
    // surface, never a session failure (#936).
    expect(stderr).toContain("moh browser install");
    expect(events.at(-1)!.type).toBe("done");
  });

  test("absent or disabled browser: no probe, no diagnostic", () => {
    for (const config of [{}, { browser: { enabled: false } }]) {
      const { code, stdout, stderr, events } = runSession(config);
      expect(code).toBe(0);
      expect(stdout).not.toContain("browser_unavailable");
      expect(stderr).not.toContain("browser");
      expect(events.at(-1)!.type).toBe("done");
    }
  });
});
