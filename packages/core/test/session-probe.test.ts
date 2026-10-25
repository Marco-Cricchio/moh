/**
 * #1679: the session probe is off by default and, with
 * `MOH_SESSION_PROBE=<file>`, records the construction stages in order.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, MockProvider } from "../src/index";

const dirs: string[] = [];
afterEach(() => {
  delete process.env.MOH_SESSION_PROBE;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "moh-session-probe-"));
  dirs.push(d);
  return d;
};

const build = (cwd: string) => createSession({ provider: MockProvider.demo(), cwd, mohHome: join(cwd, ".moh-home") });

describe("MOH_SESSION_PROBE (#1679)", () => {
  test("off by default: no file", () => {
    const dir = tmp();
    const file = join(dir, "probe.jsonl");
    build(dir);
    expect(existsSync(file)).toBe(false);
  });

  test("on: the construction stages are recorded in order, each with its elapsed time", () => {
    const dir = tmp();
    const file = join(dir, "probe.jsonl");
    process.env.MOH_SESSION_PROBE = file;
    build(dir);
    const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const stages = rows.map((r) => r.stage);
    expect(stages[0]).toBe("createSession");
    expect(stages[1]).toBe("ctor:start");
    expect(stages.at(-1)).toBe("ctor:end");
    for (const s of ["ctor:before-prompt-composer", "composer:before-slug", "composer:after-slug", "ctor:after-prompt-composer", "ctor:before-loop"]) {
      expect(stages).toContain(s);
    }
    expect(stages.indexOf("composer:after-slug")).toBeLessThan(stages.indexOf("ctor:after-prompt-composer"));
    expect(rows.every((r) => r.n === 1 && typeof r.sincePrevMs === "number")).toBe(true);
  });

  test("an unwritable probe file never changes the construction", () => {
    const dir = tmp();
    process.env.MOH_SESSION_PROBE = join(dir, "no-such-dir", "probe.jsonl");
    expect(() => build(dir)).not.toThrow();
  });
});

describe("MOH_SESSION_PROBE heartbeat (#1679)", () => {
  test("ticks on its own thread while the main thread is blocked", async () => {
    const dir = tmp();
    const file = join(dir, "probe.jsonl");
    process.env.MOH_SESSION_PROBE = file;
    build(dir); // first stage: starts the worker
    // The worker boots on its own thread; give it its first tick, then block
    // the main thread for a while without yielding to the event loop.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const before = existsSync(`${file}.heartbeat`) ? readFileSync(`${file}.heartbeat`, "utf8").trim().split("\n").length : 0;
    const until = Date.now() + 1000;
    while (Date.now() < until) {
      // blocked: no timers, no I/O callbacks on this thread
    }
    const beats = readFileSync(`${file}.heartbeat`, "utf8").trim().split("\n").map(Number);
    expect(beats.length - before).toBeGreaterThanOrEqual(5);
    expect(beats.every((t) => Number.isFinite(t))).toBe(true);
  });
});
