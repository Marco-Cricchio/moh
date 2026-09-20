/**
 * Jev model routing — tiers and the decision table (#787).
 *
 * Pure logic, no I/O: the pool the core resolved, the user's labels, the
 * judgment answers and the session streak in; a tier assignment and a
 * switch/stay decision out. The classifier call lives in `routing-judge`.
 *
 * Ratified shape (vision note 35, #787):
 * - three canonical tiers, `economico` / `bilanciato` / `potente`;
 * - an explicit label wins, otherwise a price heuristic over the pool;
 * - a switch needs confidence ≥ 0.60 and two consecutive turns naming the
 *   same target tier;
 * - an answer naming a tier this session cannot reach (or a malformed one)
 *   is not a judgment at all: no tier, no streak, no switch.
 */
import type { JevChoiceQuestion, JevNoulQuestion, JevQuestion } from "./client";

/** The canonical tiers; the names themselves are the contract. */
export const ROUTING_TIERS = ["economico", "bilanciato", "potente"] as const;
export type RoutingTier = (typeof ROUTING_TIERS)[number];

/** Confidence below this stays on the current model. */
export const ROUTING_CONFIDENCE_MIN = 0.6;

/** Consecutive turns that must name the same target tier before switching. */
export const ROUTING_STREAK_REQUIRED = 2;

/** The maximum message size sent to Jev: 2 KiB of the last user message. */
export const ROUTING_MESSAGE_MAX_BYTES = 2048;

/** One model the session can route to (resolved by the core, as data). */
export interface RoutingModel {
  /** `<endpoint>/<model-id>` — the ref `switchModel` resolves. */
  readonly ref: string;
  /** Blended USD price per Mtok; absent = unknown (never guessed). */
  readonly price?: number;
}

/**
 * What a host that labels `<endpoint>/<model-id>` keys with: a tier name.
 * Anything else in the config is ignored by the schema, not here.
 */
export type TierLabels = Readonly<Record<string, string>>;

export interface TierAssignment {
  /** tier → the model that serves it (first assigned, in pool order). */
  readonly targets: Partial<Record<RoutingTier, string>>;
  /** tier → every model assigned to it, in pool order. */
  readonly members: Readonly<Record<RoutingTier, readonly string[]>>;
  /** Labels naming a model outside the pool: ignored (reported once). */
  readonly ignoredLabels: readonly string[];
  /** Pool models with no known price (they fall back to `bilanciato`). */
  readonly unpriced: readonly string[];
}

const isTier = (value: string): value is RoutingTier => (ROUTING_TIERS as readonly string[]).includes(value);

/** The tier a price belongs to when the pool is split into terciles. */
function splitPriced(priced: readonly RoutingModel[]): Record<RoutingTier, string[]> {
  const cheap: string[] = [];
  const balanced: string[] = [];
  const powerful: string[] = [];
  const n = priced.length;
  if (n === 1) {
    // A single priced model says nothing about cheap or expensive: it stays
    // routable as the middle tier (the pool is inert at that size anyway).
    balanced.push(priced[0]!.ref);
  } else {
    // One model cannot be split into a "two-model pool" rule: cheapest and
    // dearest take the ends (ratified), the rest split into thirds.
    const edge = n === 2 ? 1 : Math.floor(n / 3);
    priced.slice(0, edge).forEach((m) => cheap.push(m.ref));
    priced.slice(edge, n - edge).forEach((m) => balanced.push(m.ref));
    priced.slice(n - edge).forEach((m) => powerful.push(m.ref));
  }
  return { economico: cheap, bilanciato: balanced, potente: powerful };
}

/**
 * Assigns every pool model to a tier. An explicit label wins and removes
 * the model from the price heuristic; the remaining models are ranked by
 * blended price and split into terciles (a two-model pool: cheapest and
 * dearest); a model with no known price falls back to `bilanciato` — it
 * stays routable, and the ambiguity is reported, never guessed away. A
 * label naming a model outside the pool is ignored and reported.
 */
export function assignTiers(pool: readonly RoutingModel[], labels: TierLabels = {}): TierAssignment {
  const inPool = new Set(pool.map((m) => m.ref));
  const members: Record<RoutingTier, string[]> = { economico: [], bilanciato: [], potente: [] };
  const ignoredLabels: string[] = [];
  const labeled = new Map<string, RoutingTier>();
  for (const [ref, tier] of Object.entries(labels)) {
    if (!inPool.has(ref) || !isTier(tier)) {
      ignoredLabels.push(ref);
      continue;
    }
    labeled.set(ref, tier);
  }
  // Labels keep pool order within their tier.
  for (const model of pool) {
    const tier = labeled.get(model.ref);
    if (tier) members[tier].push(model.ref);
  }
  const heuristic = pool.filter((m) => !labeled.has(m.ref));
  const priced = heuristic
    .filter((m) => m.price !== undefined)
    .slice()
    .sort((a, b) => a.price! - b.price! || a.ref.localeCompare(b.ref));
  const unpriced = heuristic.filter((m) => m.price === undefined).map((m) => m.ref);
  const split = splitPriced(priced);
  for (const tier of ROUTING_TIERS) {
    for (const ref of split[tier]) members[tier].push(ref);
  }
  // Unknown price: balanced, in pool order (never a guessed cheap/powerful).
  members.bilanciato.push(...unpriced);
  const targets: Partial<Record<RoutingTier, string>> = {};
  for (const tier of ROUTING_TIERS) {
    const first = members[tier][0];
    if (first !== undefined) targets[tier] = first;
  }
  return { targets, members, ignoredLabels, unpriced };
}

/**
 * How many distinct tiers the assignment can actually reach. Below two
 * there is nothing to choose: the router stays inert (no call, no cost).
 */
export function routableTierCount(assignment: TierAssignment): number {
  return ROUTING_TIERS.filter((tier) => assignment.targets[tier] !== undefined).length;
}

/** The tier a model ref belongs to; undefined when it is outside the pool. */
export function tierOfModel(assignment: TierAssignment, ref: string): RoutingTier | undefined {
  for (const tier of ROUTING_TIERS) {
    if (assignment.members[tier].includes(ref)) return tier;
  }
  return undefined;
}

export interface RoutingSignals {
  /** The tier the judgment named. */
  readonly tier: RoutingTier;
  /** The judgment's confidence, 0–1. */
  readonly confidence: number;
  /** The active model's tier; undefined when it is outside the pool. */
  readonly currentTier?: RoutingTier;
  /** The streak *including* this turn (see `nextStreak`). */
  readonly streak: number;
  /** Routing is paused for the session. */
  readonly paused: boolean;
  /** The user switched the model by hand: their choice wins. */
  readonly override: boolean;
  /**
   * The serving model is not the model of the tier the router decided (the
   * config changed, or `/model` named an id outside the tier map). The
   * router does not spend a call to overrule it: it waits, visibly.
   */
  readonly mismatch?: boolean;
}

/** Why the router stayed: the vocabulary the judgment event carries. */
export type RoutingStayReason =
  | "paused"
  | "override"
  | "mismatch"
  | "low-confidence"
  | "same-tier"
  | "streak"
  /** #852: the judged message carried no task signal (a bare
   * continuation). No streak accrual, no switch. */
  | "continuation";

/** #852: a bare continuation carries no task signal. Matched as a whole
 * trimmed, lowercased, punctuation-stripped message — never a substring,
 * so "procediamo con il refactor" still judges normally. */
const CONTINUATIONS = new Set([
  // English
  "continue", "go on", "go ahead", "proceed", "keep going", "yes", "y", "ok",
  "okay", "sure", "next", "done?", "and?", "again", "retry", "resume",
  // Italian (the owner's language)
  "procedi", "prosegui", "continua", "continui", "vai", "avanti", "dai",
  "ok prosegui", "va bene", "ok vai", "ancora", "riprova", "ripeti",
]);

/** #852: true when the message carries no task signal a router can act
 * on — empty, or a bare continuation word. A router cannot judge a task
 * that is not stated, and must not move the serving model on one. */
export function isContinuationMessage(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!…,:;?]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (normalized === "") return true;
  return CONTINUATIONS.has(normalized);
}

export type RoutingDecision =
  | { readonly switch: true; readonly reason: "hysteresis" }
  | { readonly switch: false; readonly reason: RoutingStayReason };

/**
 * The decision table. Checked in this order: no judgment is acted on while
 * routing is paused, the user has taken over, or the serving model is not
 * the one the router picked; an unconfident answer stays; being on the
 * target tier already stays; and a move needs the hysteresis (two
 * consecutive turns naming the same tier).
 */
export function decideRouting(signals: RoutingSignals): RoutingDecision {
  if (signals.paused) return { switch: false, reason: "paused" };
  if (signals.override) return { switch: false, reason: "override" };
  if (signals.mismatch) return { switch: false, reason: "mismatch" };
  if (signals.confidence < ROUTING_CONFIDENCE_MIN) return { switch: false, reason: "low-confidence" };
  if (signals.currentTier !== undefined && signals.currentTier === signals.tier) {
    return { switch: false, reason: "same-tier" };
  }
  if (signals.streak >= ROUTING_STREAK_REQUIRED) return { switch: true, reason: "hysteresis" };
  return { switch: false, reason: "streak" };
}

/** The streak after this turn's answer: 1, or +1 for the same target. */
export function nextStreak(previousTier: RoutingTier | null, previous: number, tier: RoutingTier): number {
  return previousTier === tier ? previous + 1 : 1;
}

/**
 * Truncates to a byte budget without splitting a character. Encodes once,
 * cuts on a code-point boundary: the message can be arbitrarily long (a
 * pasted file is normal), and this runs before every judged turn.
 */
export function truncateToBytes(text: string, maxBytes = ROUTING_MESSAGE_MAX_BYTES): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  // Walk back over continuation bytes (0b10xxxxxx) so a multi-byte
  // character never becomes U+FFFD.
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

const TIER_RUBRIC: Record<RoutingTier, string> = {
  economico:
    "a light request a cheap model handles well: a short factual answer, a quick lookup, a small mechanical edit",
  bilanciato:
    "an ordinary engineering request: a focused code change, a design question, a contained debugging session",
  potente:
    "a demanding request: cross-file design, hard or subtle debugging, long reasoning, or work whose mistakes are expensive",
};

const DIFFICULTY_INSTRUCTIONS =
  "Judge how demanding this single user message is, ignoring any earlier conversation you cannot see. " +
  "Pick the tier of model that is appropriate to answer it well, not the most capable one available.";

const CONTEXT_INSTRUCTIONS =
  "Would answering this message well require the earlier conversation rather than the last message alone?";

/**
 * The routing questions: one Choice over the tiers the pool can actually
 * reach (its criteria carry the tier-to-model mapping — that is all Jev
 * learns about the session), plus one yes/no question recorded for tuning
 * that is never a routing signal.
 */
export function routingQuestions(assignment: TierAssignment): Record<string, JevQuestion> {
  const criteria: Record<string, string | null> = {};
  for (const tier of ROUTING_TIERS) {
    const target = assignment.targets[tier];
    if (!target) continue;
    criteria[tier] = `${TIER_RUBRIC[tier]} (served by ${target})`;
  }
  const difficulty: JevChoiceQuestion = { type: "choice", instructions: DIFFICULTY_INSTRUCTIONS, criteria };
  const needsContext: JevNoulQuestion = {
    type: "noul",
    instructions: CONTEXT_INSTRUCTIONS,
    criteria: { true: "the answer needs the earlier conversation", false: "the last message is enough" },
  };
  return { difficulty, needs_context: needsContext };
}

/** The tier a Choice answer named, or undefined when it is not a tier. */
export function tierFromAnswer(choice: string | undefined): RoutingTier | undefined {
  return choice !== undefined && isTier(choice) ? choice : undefined;
}
