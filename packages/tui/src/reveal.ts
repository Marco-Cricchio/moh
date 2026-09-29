/** #1054 (ADR-0057): injectable typewriter-reveal pacing. The reveal cursor's
 * math lives here as a pure function so tests can drive it deterministically
 * and hosts can tune it via the Chat `reveal` prop. */

/** Reveal pacing knobs: tick interval, chars added per tick at base speed,
 * and the max chars the cursor may trail the provider stream by. */
export interface RevealSettings {
  tickMs: number;
  charsPerTick: number;
  catchupChars: number;
}

export const DEFAULT_REVEAL_SETTINGS: RevealSettings = {
  // ~10 chars/50ms ≈ 2 rows/s at 100 cols: word-flow, no per-row lag.
  tickMs: 60,
  charsPerTick: 20,
  catchupChars: 400,
};

/**
 * Advance the reveal cursor (char budget) by `ticks` ticks. Pure: the same
 * sequence of (streamed, ticks) under the same settings always yields the
 * same cursor. Each tick moves the cursor by `charsPerTick * boost`, where
 * the boost accelerates with the cursor's deficit behind the stream (capped
 * at 5x base speed) — that acceleration IS the catch-up, so the cursor keeps
 * readable word-flow while always completing, never stranded short of the
 * stream; it can never overshoot `streamed` nor move backwards.
 */
export function advanceReveal(
  prev: number,
  streamed: number,
  ticks: number,
  settings: RevealSettings = DEFAULT_REVEAL_SETTINGS,
): number {
  if (ticks <= 0) return prev;
  let cursor = prev;
  for (let i = 0; i < ticks; i++) {
    const boost = 1 + Math.min(4, Math.max(0, streamed - cursor) / 500);
    cursor = Math.max(cursor, Math.min(streamed, cursor + settings.charsPerTick * boost));
  }
  return cursor;
}
