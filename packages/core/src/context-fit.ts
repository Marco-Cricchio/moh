/**
 * Context fit (#948): whether a model's catalog window can hold the
 * session's measured context. One shared predicate — the switch guard
 * (`AgentSession.switchModel`), the exported preventive check clients
 * ask before applying, and the fallback chain's eligibility rule all
 * give one answer (the settings screen can never disagree with the
 * route). Glossary: "Context fit".
 *
 * The window is the existing `contextWindowFor` lookup — moh never
 * invents a window the catalog does not declare. The predicate
 * **abstains** (treated as fits) when it cannot verify: an unknown
 * window (`0`) or a log with no usable measurement. Abstention never
 * blocks; the provider's own `context_length` error remains the hard
 * wall for the unresolvable cases (the broader unknown-window policy
 * stays with the core `context_length` ticket, tracked with #948).
 */

/** Fixed reserve (tokens) subtracted from the window: headroom for the
 * next turn's growth and the reply. Not configurable by decision. */
export const CONTEXT_FIT_RESERVE = 8192;

export interface ContextFitVerdict {
  /** Whether the measured context fits `window − reserve`. Abstention
   * (unknown window, no measurement) reads as fits. */
  fits: boolean;
  /** The session's last measured model-call input tokens (undefined
   * when the log holds no usable measurement). */
  measured?: number;
  /** The target model's catalog window (0 = unknown). */
  window: number;
}

export function contextFitFor(input: { measured?: number; window: number }): ContextFitVerdict {
  const { measured, window } = input;
  // Abstain when either side of the comparison is unknown: an unknown
  // window cannot be held against the target, and a session without any
  // measurement has nothing to compare.
  if (window <= 0 || measured === undefined) return { fits: true, measured, window };
  return { fits: measured <= window - CONTEXT_FIT_RESERVE, measured, window };
}
