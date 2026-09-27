/**
 * ADR-0049 (door one, #986): the context window a provider declares for
 * the endpoint in use, learned from its own overflow refusal.
 *
 * Every context number in moh resolves through one lookup
 * (`contextWindowFor`): the shipped catalog row (ADR-0046), or 0 =
 * unknown. A wrong window is worse than an unknown one — an unknown
 * window abstains, a wrong one is trusted — and the table the refusal
 * proves moh wrong: the provider states its own window in the message it
 * throws away. This module owns two things: the **recognition** of that
 * number (conservative, on the untruncated text — see provider-errors.ts)
 * and the **session-scoped lookup** every consumer reads.
 *
 * Only a real refusal teaches: no probing, no inference from model names
 * or prices. The learned value is keyed by the model reference that was
 * refused (a refusal names its subject), lives for the session, is
 * persisted as a `declared_window` chrome event in the log (the log is
 * the session — Principle 2), and outranks both the catalog and the 180k
 * fallback. The 8k fit reserve is untouched: it is headroom, not a
 * window.
 */
import type { AgentEvent } from "./types";

/** One shipped recognition formula. Each one is pinned by a test carrying
 * the real provider wording it was derived from; a formula nobody has
 * seen a real refusal for is not shipped (unrecognized refusals leave a
 * trace — `context-refusal-trace.ts` — which is how the next one gets
 * discovered). */
export interface DeclaredWindowFormula {
  /** Stable id, for tests and diagnostics. */
  readonly id: string;
  /** The formula. The window marker must be attributable to its number:
   * the capture group sits immediately after the marker that names it. */
  readonly pattern: RegExp;
  /** Capture group holding the declared window. */
  readonly group: number;
  /** The real wording this formula was derived from, with its source. */
  readonly source: string;
}

export const DECLARED_WINDOW_FORMULAS: readonly DeclaredWindowFormula[] = [
  {
    id: "maximum-context-length-is",
    // "This endpoint's maximum context length is 131072 tokens."
    // "This model's maximum context length is 128000 tokens."
    pattern: /maximum context length is\s+([\d,]+)\s+tokens/i,
    group: 1,
    source:
      "OpenRouter/OpenAI-family refusal, verbatim from the #949 session quoted in #986 and ADR-0049: \"This endpoint's maximum context length is 131072 tokens. However, you requested about 234666 tokens (232641 of text input, 2025 of tool input).\" (openrouter/mistralai/mistral-nemo, 2026-09-23). The \"model's\" spelling is the same sentence from OpenAI's chat-completions 400 — both are matched by other agents' classifiers (e.g. litellm, litellm_core_utils/exception_mapping_utils.py: \"this model's maximum context length is\").",
  },
  {
    id: "prompt-is-too-long",
    // "prompt is too long: 208423 tokens > 200000 maximum": the first
    // number is what was SENT, the one after ">" is the maximum.
    pattern: /prompt is too long:?\s+[\d,]+\s+tokens\s*>\s*([\d,]+)\s+maximum/i,
    group: 1,
    source:
      "Anthropic Messages API 400 refusal: \"prompt is too long: 208423 tokens > 200000 maximum\" (real wording reproduced by the openclaw corpus, src/agents/failover/failover-classification.overflow.cases.ts, row \"billing-context-prompt-token-count\"; litellm's Anthropic branch matches the same \"prompt is too long\" marker).",
  },
  {
    id: "model-token-limit",
    // "Invalid request: Your request exceeded model token limit: 262144 (requested: 291351)"
    pattern: /model token limit:\s*([\d,]+)/i,
    group: 1,
    source:
      "Moonshot/Kimi 400 refusal: \"Invalid request: Your request exceeded model token limit: 262144 (requested: 291351)\" (real wording reproduced by the openclaw corpus, same file, row \"billing-context-kimi-limit\"; kimi-coding is a built-in moh provider).",
  },
  {
    id: "available-context-size",
    // "request (130000 tokens) exceeds available context size (131072 tokens)"
    // "request (66202 tokens) exceeds the available context size (65536 tokens)"
    pattern: /exceeds (?:the )?available context size \(([\d,]+)\s*tokens\)/i,
    group: 1,
    source:
      "llama.cpp / Lemonade server refusal: \"request (130000 tokens) exceeds available context size (131072 tokens)\" and \"... exceeds the available context size (65536 tokens)\" (real wording reproduced by the openclaw corpus, same file, rows \"patterns-context-llamacpp-*\"); reachable through an openai-compat endpoint.",
  },
];

/**
 * The window a refusal declares, or undefined when moh recognizes no
 * formula in it. Recognition is conservative on purpose: only a formula
 * whose number is attributable to its marker matches, never a bare
 * plausible number (a refusal also carries what was requested, request
 * ids and prices — adopting one of those would be worse than adopting
 * nothing).
 */
export function recognizeDeclaredWindow(text: string): number | undefined {
  for (const formula of DECLARED_WINDOW_FORMULAS) {
    const match = formula.pattern.exec(text);
    const raw = match?.[formula.group];
    if (!raw) continue;
    const value = Number(raw.replace(/[,_\s]/g, ""));
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return undefined;
}

/**
 * The window lookup seam: the declared windows of one session, keyed by
 * the model reference (`endpoint/model-id`) that declared them. Every
 * consumer (`CompactionRunner`, `contextFitFor`'s callers, the fallback
 * chain) funnels through `contextWindowFor(model, endpointType, declared)`
 * — one value, one owner, no private override, so the producer and the
 * fit guard can never disagree (the divergence #948 closed).
 */
export interface DeclaredWindowLookup {
  declaredWindowFor(modelRef: string): number | undefined;
}

/**
 * The session's declared windows. Never persisted on its own: the
 * `declared_window` chrome events in the log ARE the store, and
 * `fromEvents` re-derives this map at resume-open, so a reopened session
 * computes the same window with no replay divergence.
 */
export class DeclaredWindows implements DeclaredWindowLookup {
  readonly #windows = new Map<string, number>();

  /** Rebuilds the map from a log's `declared_window` events, in log order:
   * the LAST event for one reference is its window (a different number is
   * a new fact, and the log is append-only). */
  static fromEvents(events: readonly AgentEvent[]): DeclaredWindows {
    const declared = new DeclaredWindows();
    for (const event of events) {
      if (event.type !== "declared_window") continue;
      declared.#windows.set(event.model, event.window);
    }
    return declared;
  }

  declaredWindowFor(modelRef: string): number | undefined {
    const window = this.#windows.get(modelRef.trim());
    return window !== undefined && window > 0 ? window : undefined;
  }

  /**
   * Teaches one declared window. Returns `false` when the reference
   * already carries this number (a re-refusal declaring what moh already
   * used is a confirmation, not a correction — the caller appends no
   * event for it).
   */
  learn(modelRef: string, window: number): boolean {
    if (!(window > 0)) return false;
    const ref = modelRef.trim();
    if (!ref || this.#windows.get(ref) === window) return false;
    this.#windows.set(ref, window);
    return true;
  }

  /** How many model references declared a window this session. */
  get size(): number {
    return this.#windows.size;
  }
}
