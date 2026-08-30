/**
 * AI SDK warning routing (#347): `ai@7` ships a warning system whose
 * default sink is `process.emitWarning`/`console.warn` — raw output that
 * lands between chat turns and corrupts the interactive TUI transcript.
 * The SDK's supported opt-out is the `globalThis.AI_SDK_LOG_WARNINGS`
 * global: `false` silences entirely, a function becomes the sink. moh
 * installs a sink here (TUI only — the non-interactive CLI keeps the
 * default linear route, where interleaved warnings are harmless) so
 * every warning is reformatted into a concise one-line, moh-owned
 * notice. `--trace-warnings` is untouched: this global only covers SDK
 * warnings, not process warnings in general.
 */

/** The SDK's documented sink global (`logWarnings` in `ai@7`). */
const AI_SDK_LOG_WARNINGS_KEY = "AI_SDK_LOG_WARNINGS";

/** What the SDK passes its sink: one entry per accumulated warning plus
 * the call's provider/model context. Kept structurally loose on
 * purpose — the SDK's exact warning shapes are version-internal; only
 * `type`-style discriminants and the array itself are contractual. */
export interface AiSdkWarningOptions {
  warnings: Array<Record<string, unknown>>;
  provider?: string;
  model?: string;
}

/** Truncation budget for a warning's detail payload (row-2/toast sized). */
const MAX_DETAIL = 120;

function describeWarning(warning: Record<string, unknown>): string {
  for (const key of ["message", "detail", "reason", "feature", "setting"]) {
    const v = warning[key];
    if (typeof v === "string" && v.trim() !== "") {
      return v.length > MAX_DETAIL ? `${v.slice(0, MAX_DETAIL)}…` : v;
    }
  }
  const json = JSON.stringify(warning) ?? "";
  return json.length > MAX_DETAIL ? `${json.slice(0, MAX_DETAIL)}…` : json;
}

/** One line, moh-owned: context + type + elided detail. */
export function formatAiSdkWarning(
  warning: Record<string, unknown>,
  provider?: string,
): string {
  const type = typeof warning.type === "string" ? warning.type : "warning";
  const scope = provider ? ` (${provider})` : "";
  const detail = describeWarning(warning);
  return `AI SDK warning${scope}: ${type} — ${detail}`.replace(/\s+/g, " ").replace(/\n/g, " ");
}

type WarningListener = (message: string) => void;
const listeners = new Set<WarningListener>();

/**
 * Subscribes to reformatted SDK warnings; returns the unsubscribe
 * function. The App's toast channel subscribes on mount and detaches on
 * unmount.
 */
export function subscribeAiSdkWarnings(listener: WarningListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Installs moh's sink on the SDK global (idempotent). Must run before
 * the first provider call — the TUI entrypoint does it at render time.
 */
export function installAiSdkWarningSink(): void {
  const g = globalThis as Record<string, unknown>;
  // An explicit `false` remains an opt-out; an existing function is
  // replaced so interactive TUI warnings always use moh's diagnostic route.
  if (g[AI_SDK_LOG_WARNINGS_KEY] !== undefined && typeof g[AI_SDK_LOG_WARNINGS_KEY] !== "function") return;
  g[AI_SDK_LOG_WARNINGS_KEY] = (options: AiSdkWarningOptions) => {
    if (!options || !Array.isArray(options.warnings)) return;
    for (const warning of options.warnings) {
      if (!warning || typeof warning !== "object") continue;
      const message = formatAiSdkWarning(warning as Record<string, unknown>, options.provider);
      for (const listener of listeners) listener(message);
    }
  };
}
