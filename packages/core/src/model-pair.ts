/**
 * ADR-0050 (#974): the selected/serving pair.
 *
 * A session whose provider is a `Route` carries two model references: the
 * **selected** one (the user's standing choice, from configuration,
 * `/model`, `--provider`, or a `beforeTurn` extension) and the **serving**
 * one (the stop that actually serves its calls — a fallback moves it).
 *
 * Two rules live here, so they have exactly one definition:
 *
 * 1. **One formatter.** Wherever a session *states* which model it is
 *    working with, the pair renders as `<selected> → <serving>` when the
 *    two differ and as the single reference when they agree. Clients call
 *    it; they never reimplement the string.
 * 2. **One accessor pair.** A reader that means "the model in use" reads
 *    `servingModelOf`; a reader that means "the user's choice" reads
 *    `selectedModelOf`. Both abstain from route-ness: a provider that is
 *    not a `Route` (a registered id, a pre-built instance, "mock") has one
 *    reference and reports it from either accessor, so no caller needs its
 *    own `"serving" in provider` dance.
 *
 * The surface list this governs: the prompt's `Environment` block, the TUI
 * footer, the `/model` header, and the fallback notices.
 */
import type { Provider } from "./types";

/** A `Provider` that is in fact a route: it knows its chain, its selection
 * and what currently serves. Structural on purpose (`Route` lives in
 * `route.ts`, whose transport imports this module must not need). */
interface ServingAware {
  readonly selected?: unknown;
  readonly serving?: unknown;
}

/** The user's standing choice for this provider: the route's selected
 * reference, or the provider's own name when it is not a route. */
export function selectedModelOf(provider: Provider): string {
  const { selected } = provider as Provider & ServingAware;
  return typeof selected === "string" ? selected : provider.name;
}

/** The model that actually serves this provider's calls: the route's
 * serving reference (moved by a fallback), or the provider's own name when
 * it is not a route. Every behaviour that depends on the model in use
 * (image capability, the compaction window) reads this one. */
export function servingModelOf(provider: Provider): string {
  const { serving } = provider as Provider & ServingAware;
  return typeof serving === "string" ? serving : provider.name;
}

/** The one rendering of a (selected, serving) pair: `<selected> →
 * <serving>` while the two differ, the single reference when they agree
 * (so a session with nothing in fallback reads exactly as it always did). */
export function formatModelPair(selected: string, serving: string): string {
  return selected === serving ? selected : `${selected} → ${serving}`;
}
