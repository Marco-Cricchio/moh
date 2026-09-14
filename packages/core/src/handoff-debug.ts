/**
 * #680 follow-up: discovery debug logging. Home handoff discovery is
 * deliberately fail-silent (story 15), which makes "why is there no
 * offer row?" undiagnosable in the field — #680's cold scan hid behind
 * the same silence for releases. Behind MOH_DEBUG=handoff the whole
 * decision chain writes one line per gate to stderr; production
 * behavior (no env var) is byte-for-byte unchanged.
 */

export type HandoffDebugStage =
  | "transport-off"
  | "transport-active"
  | "fetch-start"
  | "fetch-error"
  | "fetch-timeout"
  | "fetch-ok"
  | "decision";

let enabledCache: boolean | undefined;

/** Enabled only when MOH_DEBUG contains "handoff" (comma list friendly).
 * Memoized per process (read once); tests reset via `resetDebugCache`. */
export function handoffDebugEnabled(): boolean {
  if (enabledCache === undefined) {
    const spec = process.env.MOH_DEBUG ?? "";
    enabledCache = spec.split(",").map((s) => s.trim()).includes("handoff");
  }
  return enabledCache;
}

/** Test seam: forget the memoized MOH_DEBUG read. */
export function resetDebugCache(): void {
  enabledCache = undefined;
}

/** One stderr line: `moh[handoff] <stage> <detail-json>`. Never throws.
 * Writer injectable for tests. */
export let debugWrite: (line: string) => void = (line) => {
  process.stderr.write(line);
};
export function setDebugWriter(write: (line: string) => void): void {
  debugWrite = write;
}

export function handoffDebug(stage: HandoffDebugStage, detail: Record<string, unknown>): void {
  try {
    if (!handoffDebugEnabled()) return;
    debugWrite(`moh[handoff] ${stage} ${JSON.stringify(detail)}\n`);
  } catch {
    // Logging must never break discovery.
  }
}
