import { appendFileSync } from "node:fs";

/**
 * #1679 diagnostic, off unless `MOH_SESSION_PROBE=<file>` is set: one JSON
 * line per stage of session construction, with the time since the previous
 * stage of the same process. A stage that took seconds shows as a large
 * `sincePrevMs` on the line that ends it, so a stall is localized to the
 * code between two named stages. Counts constructions (`n`; the
 * `createSession` line carries the number of the construction it starts) so
 * interleaved sessions can be told apart. Never changes behaviour and never throws.
 */
let last = performance.now();
let constructions = 0;

export function probeStage(stage: string): void {
  const file = process.env.MOH_SESSION_PROBE;
  if (!file) return;
  try {
    const now = performance.now();
    if (stage === "ctor:start") constructions += 1;
    appendFileSync(
      file,
      `${JSON.stringify({ at: new Date().toISOString(), n: stage === "createSession" ? constructions + 1 : constructions, stage, sincePrevMs: Math.round((now - last) * 10) / 10 })}\n`,
    );
    last = performance.now();
  } catch {
    // diagnostic only
  }
}
