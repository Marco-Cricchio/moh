import { writeFileSync } from "node:fs";
import { PARITY } from "../parity-scenario";

/** Clock boundary shared by the in-process renderer and the PTY preload.
 * Scheduling/deadlines use real monotonic time; the displayed tool duration
 * is scenario data, independent of how long either process was descheduled. */
export function freezeParityClock(): () => void {
  const original = Date.now;
  Date.now = () => PARITY.clockMs;
  return () => { Date.now = original; };
}

if (process.env.MOH_PARITY_CLOCK === "1") {
  freezeParityClock();
  // The parent asserts this receipt, so a silently ignored preload cannot
  // pass just because a quiet machine happened to display zero seconds.
  if (process.env.MOH_PARITY_CLOCK_RECEIPT) {
    writeFileSync(process.env.MOH_PARITY_CLOCK_RECEIPT, JSON.stringify({ now: Date.now() }));
  }
}
