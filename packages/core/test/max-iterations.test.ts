import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionFromConfig } from "../src/session/from-config";
import {
  MAX_ITERATIONS_UNLIMITED,
  MockProvider,
  loadMohConfig,
  resolveMaxIterations,
} from "../src/index";

function tempProject(): { cwd: string; home: string; cleanup: () => void } {
  const dir = join(
    tmpdir(),
    `moh-maxit-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  const cwd = join(dir, "project");
  const home = join(dir, "home");
  mkdirSync(join(cwd), { recursive: true });
  mkdirSync(join(home, ".moh"), { recursive: true });
  return { cwd, home, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("#498 maxIterations unlimited sentinel", () => {
  test("resolveMaxIterations: absent → 50, 0 → Infinity, finite → itself", () => {
    expect(resolveMaxIterations(undefined)).toBe(50);
    expect(resolveMaxIterations(0)).toBe(Infinity);
    expect(resolveMaxIterations(1)).toBe(1);
    expect(resolveMaxIterations(500)).toBe(500);
    expect(MAX_ITERATIONS_UNLIMITED).toBe(0);
  });

  test("moh.json validation accepts 0 (sentinel) and 1–500, rejects negatives and >500", () => {
    const { cwd, cleanup } = tempProject();
    try {
      for (const value of [0, 1, 50, 500]) {
        writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock", maxIterations: value }));
        expect(loadMohConfig(join(cwd, "moh.json")).maxIterations).toBe(value);
      }
      for (const value of [-1, 501, 2.5]) {
        writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock", maxIterations: value }));
        expect(() => loadMohConfig(join(cwd, "moh.json"))).toThrow();
      }
    } finally {
      cleanup();
    }
  });

  test("unlimited sentinel runs a looping script well past a finite cap, no wrap-up call", async () => {
    const { cwd, home, cleanup } = tempProject();
    try {
      writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock", maxIterations: 0 }));
      const loopTurn = { deltas: ["working "], finish: "tool_calls" as const, toolCalls: [{ name: "bash", args: { command: "true" } }] };
      // Six looping calls then a stop: the guard never fires under the
      // sentinel, so all six tool iterations complete without any
      // wrap-up call being inserted.
      const provider = MockProvider.scripted([
        loopTurn, loopTurn, loopTurn, loopTurn, loopTurn, loopTurn,
        { deltas: ["DONE"], finish: "stop" as const },
      ]);
      const result = sessionFromConfig({ cwd, home, provider, overrides: { permissions: { unrestrictedTools: true } } });
      expect("error" in result).toBe(false);
      if ("error" in result) return;
      const done = await result.session.send("go");
      expect(done.status).toBe("done");
      const calls = result.session.history().filter((e) => e.type === "model_call");
      // 6 loop iterations + final call: no extra wrap-up call inserted.
      expect(calls.length).toBe(7);
      expect(result.session.history().filter((e) => e.type === "error")).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
