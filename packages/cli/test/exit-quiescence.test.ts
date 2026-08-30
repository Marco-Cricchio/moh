import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";

const child = join(import.meta.dir, "fixtures", "exit-quiescence.child.ts");

/** Spawns the fixture and reports { code, ms, stdout }. */
function runChild(): Promise<{ code: number | null; ms: number; stdout: string }> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const p = spawn("bun", [child], { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, ms: Date.now() - start, stdout }));
    // Hard safety: if the fix regresses and the child hangs, fail fast
    // instead of stalling the suite (Bun keep-alive sockets otherwise idle
    // for several seconds — that is the bug under test).
    setTimeout(() => p.kill("SIGKILL"), 4000);
  });
}

describe("TUI exit is bounded (#341)", () => {
  test("process quits within the finishExit budget despite an open keep-alive socket and pending work", async () => {
    const { code, ms, stdout } = await runChild();
    expect(stdout).not.toContain("EXIT-BOUNDS-FAILED");
    expect(code).toBe(0);
    // finishExit budget is 200ms; allow generous scheduling slack but stay
    // far below the ~3s pre-fix shutdown tail.
    expect(ms).toBeLessThan(2000);
  }, 10_000);
});
