/**
 * #936: the headless half of the browser diagnostic. An enabled browser
 * tool whose toolchain is missing must be visible in `moh run` without
 * ever becoming a failure: exactly one actionable stderr line, stdout
 * still pure JSONL, the turn still normal and the exit code unchanged.
 * Disabled or zero-config sessions say nothing at all.
 *
 * e2e through the real CLI with an isolated HOME (no toolchain anywhere,
 * mock provider): the whole point is the assembled-session behaviour, not
 * a unit seam.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harness, readEvents } from "./run.e2e.test";

describe("moh run browser diagnostic (#936)", () => {
  test("an enabled browser without a toolchain: one actionable stderr line, stdout pure JSONL, exit 0", () => {
    const { cwd, spawn } = harness();
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock", browser: { enabled: true } }));

    const { code, stdout, stderr } = spawn(["run", "hello"]);

    expect(code).toBe(0);
    const lines = stderr.split("\n").filter((line) => line.includes("browser"));
    expect(lines).toHaveLength(1);
    // The missing component and the setup command, both actionable.
    expect(lines[0]).toContain("playwright-core is not installed");
    expect(lines[0]).toContain("moh browser install");
    // stdout stays pure JSONL: every line parses and the optional tool is
    // never a session or turn error.
    const events = readEvents(stdout);
    expect(events[0]!.type).toBe("session_start");
    expect(events.filter((e) => e.type === "browser_unavailable")).toHaveLength(1);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)!.type).toBe("done");
  });

  test("a disabled (or absent) browser says nothing on stderr", () => {
    const { cwd, spawn } = harness();
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock", browser: { enabled: false } }));
    const off = spawn(["run", "hello"]);
    expect(off.code).toBe(0);
    expect(off.stderr).not.toContain("browser");

    const { cwd: bareCwd, spawn: bareSpawn } = harness();
    mkdirSync(bareCwd, { recursive: true });
    const zero = bareSpawn(["run", "hello"]);
    expect(zero.code).toBe(0);
    expect(zero.stderr).not.toContain("browser");
  });

  test("a project-local package without a Chromium build names the missing build, not the package", () => {
    const { cwd, spawn } = harness();
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock", browser: { enabled: true } }));
    // A resolvable but build-less project-local playwright-core: the
    // diagnostic must name what is actually missing (the headless shell),
    // never send the user to reinstall a package that is already there.
    const pkg = join(cwd, "node_modules", "playwright-core");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "playwright-core", version: "9.9.9", main: "index.js" }));
    writeFileSync(join(pkg, "index.js"), "module.exports = { chromium: { launchPersistentContext: async () => ({}), executablePath: () => '' } };\n");

    const { code, stdout, stderr } = spawn(["run", "hello"]);
    expect(code).toBe(0);
    expect(stderr).toContain("Chromium headless shell is not installed");
    expect(stderr).not.toContain("playwright-core is not installed");
    expect(readEvents(stdout).filter((e) => e.type === "browser_unavailable")).toHaveLength(1);
  });
});
