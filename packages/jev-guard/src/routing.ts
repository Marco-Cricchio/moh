/**
 * Jev model routing — tiers and the decision table (#787).
 *
 * Pure logic, no I/O: the pool the core resolved, the user's labels, the
 * judgment answers and the session streak in; a tier assignment and a
 * switch/stay decision out. The classifier call lives in the judge section of this file.
 *
 * Ratified shape (vision note 35, #787):
 * - three canonical tiers, `economico` / `bilanciato` / `potente`;
 * - an explicit label wins, otherwise a price heuristic over the pool;
 * - a switch needs confidence ≥ 0.60 and two consecutive turns naming the
 *   same target tier;
 * - an answer naming a tier this session cannot reach (or a malformed one)
 *   is not a judgment at all: no tier, no streak, no switch.
 */
import type {
  JevAnswer,
  JevChoiceQuestion,
  JevClient,
  JevJudgmentMeta,
  JevNoulQuestion,
  JevQuestion,
} from "./client";

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
  | "continuation"
  /** #852: the switch's target is in a known failure cooldown. The
   * switch is refused; the streak was already satisfied, so it persists. */
  | "cooled-down"
  /** #868: every rotation candidate (tier members, or the declared pool)
   * is in a known failure cooldown — the switch stays, visibly. */
  | "no-viable-candidate";

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
function tierFromAnswer(choice: string | undefined): RoutingTier | undefined {
  return choice !== undefined && isTier(choice) ? choice : undefined;
}

/**
 * The routing judge (#787): one Jev call per potentially-switching turn,
 * the tier assignment resolved from the core-provided pool, and the
 * per-session state (streak + manual override).
 *
 * Fail-open throughout: routing is never inert-because-broken, only
 * inert-because-there-is-nothing-to-choose (fewer than two tiers) — and a
 * failed call produces no judgment, no switch and no event.
 */

interface RoutingJudgeDeps {
  client: Pick<JevClient, "judge">;
  /** The extension's durable state store (streak + override live here). */
  state: Record<string, unknown>;
}

/** What the core hands over: the models, plus its own degradations. */
export interface RoutingPool {
  readonly models: readonly RoutingModel[];
  /** A listing that did not answer (the consumer reports it once). */
  readonly warnings?: readonly string[];
}

/** The tier assignment, and what went wrong while building it. */
export interface RoutingResolution {
  /** null when fewer than two tiers are reachable: nothing to choose. */
  readonly assignment: TierAssignment | null;
  readonly warnings: readonly string[];
}

interface RoutingJudgeHost {
  /** The core-resolved pool: the models this session can actually reach. */
  pool: () => Promise<RoutingPool>;
  /** The user's `<endpoint>/<model-id>` → tier labels from the config. */
  labels?: TierLabels;
  /**
   * #868 (option B): a moh.json-declared pool of `<endpoint>/<model-id>`
   * refs the router may draw from. Present and non-empty, it *replaces*
   * the tier-members candidate list on an unavailable tier target (the
   * user's explicit consent to rotation beyond the tier bound); absent,
   * rotation stays tier-bounded (option A, the default).
   */
  declaredPool?: readonly string[];
  /** Called once, when the assignment is first resolved (fail-open). */
  onResolved?: (resolution: RoutingResolution) => void;
  /**
   * Called once per mismatch episode: the serving model is not the one the
   * router picked. Routing stays out of the way until the caller stops
   * overruling it — visibly, and without paying for a judgment.
   */
  onMismatch?: (currentModel: string, expected: string) => void;
  /**
   * #788: a co-riding use case. When the router makes its per-turn call it
   * composes the rider's questions into the same request (one state, one
   * round trip) and hands the full answers map to the rider. A rider never
   * changes the routing decision: its answers are read by its own judge.
   */
  rider?: {
    /** The extra questions, composed under these ids. */
    questions: () => Record<string, JevQuestion>;
    /** Called with the full answers map on every completed routing call. */
    onAnswers: (answers: Record<string, JevAnswer>, meta: JevJudgmentMeta, text: string) => void;
    /**
     * Called when the router is about to spend its (shared) request for
     * the turn — success or failure alike. The rider marks the turn as
     * covered so its own-call path never double-judges.
     */
    onSharedCall?: () => void;
  };
}

/** What one judged turn produced. */
export interface RoutingVerdict {
  /** `switch` + `ref`, or `stay` + the reason the decision table gave. */
  readonly decision: "switch" | "stay";
  readonly reason: RoutingDecision["reason"];
  /** The tier the judgment named — present only when it is usable, i.e. a
   * tier this session's pool can actually reach (never a guess). */
  readonly tier?: RoutingTier;
  readonly confidence: number;
  /** The tier of the serving model, when it is in the pool. */
  readonly currentTier?: RoutingTier;
  /** The streak including this turn. */
  readonly streak: number;
  /** The model to serve the turn with — present on `switch` only. */
  readonly ref?: string;
  /** #868: the tier target the judgment named when it was skipped for a
   * viable rotation candidate — the audit trail of the substitution. */
  readonly skipped?: string;
  /** The exact judged state (already truncated), for the record. */
  readonly message: string;
}

export interface RoutingJudgeState {
  streak: number;
  streakTier: RoutingTier | null;
  override: boolean;
  /**
   * `/routing off`: routing is paused for this session. Starts *off* when
   * the configuration did not opt in (`typesafe.routing`) — the session
   * command `/routing on` flips it either way, which is the ratified
   * behaviour.
   */
  paused: boolean;
  /** The model of the tier the router last decided to serve. */
  decidedModel: string | null;
  /** #868: the model serving when the last switch was decided (the
   * "staying <current>" half of a skip event). */
  servingAtDecision: string | null;
  /** A `mismatch` notice was already published for this episode. */
  mismatchAnnounced: boolean;
  expected: string | null;
}

export interface RoutingSession {
  /** Opaque session identity (the hook context's `session.id`). */
  readonly id: string;
  /**
   * True for the session that registered the extension — the one whose
   * model, streak and `/routing` state the client reads. False for a
   * session that borrowed the runtime: a subagent child.
   */
  readonly owner: boolean;
}

/**
 * #944: the identity a dispatch that arrives without one is attributed to —
 * the owner session. An older runtime (apiVersion < 1.8) sends no
 * `session` at all, which reads exactly as "one session": the behavior
 * before this issue.
 */
export const OWNER_SESSION: RoutingSession = { id: "owner", owner: true };

const INITIAL: RoutingJudgeState = {
  streak: 0,
  streakTier: null,
  override: false,
  paused: false,
  decidedModel: null,
  servingAtDecision: null,
  mismatchAnnounced: false,
  expected: null,
};

/**
 * #944: how many borrowed sessions (subagent children) keep their own
 * router state. A session with more live children than this is not a
 * realistic turn shape; drop-all keeps the invariant trivially bounded —
 * the same bound the guardrail's verdict cache uses.
 */
const MAX_BORROWED_SESSIONS = 64;

/**
 * Builds the routing judge. State is **per session**, not per runtime: the
 * owner session's state lives in the extension's durable store so a
 * hot-reload keeps its streak and override; a session that borrows the
 * runtime (a subagent child, whose turns run `beforeTurn` through its
 * parent's runtime) gets its own bucket, so a child's turns can never
 * advance the parent's hysteresis nor set the parent's expectation (#944).
 */
export function createRoutingJudge(deps: RoutingJudgeDeps, host: RoutingJudgeHost) {
  const ownerState = (deps.state.routing as RoutingJudgeState | undefined) ?? { ...INITIAL };
  deps.state.routing = ownerState;
  /** Borrowed sessions' states, in memory: a child's streak dies with it. */
  const borrowedStates = new Map<string, RoutingJudgeState>();
  /** In-session memo of the resolution: one pool look-up, one listing. */
  let resolution: Promise<RoutingResolution> | undefined;
  /** The resolved value, once it landed (see `peekResolution`). */
  let resolved: RoutingResolution | null = null;
  /** #868: the ref of a decided switch awaiting application, if any — per
   * session, like the state it belongs to: a child's pending switch must
   * never be consumed by the owner's next `extension_failed`. */
  const pendingApplies = new WeakMap<RoutingJudgeState, string>();

  /** The state of the session this dispatch belongs to, created on first
   * sight for a borrowed one. */
  const stateFor = (session: RoutingSession): RoutingJudgeState => {
    if (session.owner) return ownerState;
    const known = borrowedStates.get(session.id);
    if (known) return known;
    if (borrowedStates.size >= MAX_BORROWED_SESSIONS) borrowedStates.clear();
    // A child is born from the template plus the pause in force in the
    // owner session right now: `/routing off` is the user's intent for the
    // work at hand, and it covers the subagents that work spawns. A manual
    // override is *not* inherited — that is the user's own model choice in
    // their own session, and a child's switches are its own.
    const seeded: RoutingJudgeState = { ...INITIAL, paused: ownerState.paused };
    borrowedStates.set(session.id, seeded);
    return seeded;
  };

  /** One place owns "a fresh start": five call sites need it, and a missed
   * one is a hysteresis bug that only shows up turns later. */
  const restartStreak = (state: RoutingJudgeState): void => {
    state.streak = 0;
    state.streakTier = null;
  };

  const resolveAssignment = async (): Promise<RoutingResolution> => {
    const pool = await host.pool();
    const resolved = assignTiers(pool.models, host.labels ?? {});
    const warnings = pool.warnings ?? [];
    if (routableTierCount(resolved) < 2) return { assignment: null, warnings };
    return { assignment: resolved, warnings };
  };

  const resolveOnce = (): Promise<RoutingResolution> =>
    (resolution ??= resolveAssignment().then((value) => {
      resolved = value;
      host.onResolved?.(value);
      return value;
    }));

  return {
    /** The resolution (assignment null when fewer than two tiers exist). */
    resolution: resolveOnce,

    /** The resolution *if it is already available* — never starts one. */
    peekResolution(): RoutingResolution | null {
      return resolved;
    },

    /** The tier assignment (null when nothing can be routed). */
    async assignment(): Promise<TierAssignment | null> {
      return (await resolveOnce()).assignment;
    },

    /**
     * Judges one turn. `null` means "do nothing" — routing is inert
     * (fewer than two tiers, or nothing to route yet), or the Jev call
     * failed (fail-open: no judgment, no switch, no event). A manual
     * override is not judged either: the user's pick wins, silently.
     *
     * #852: `cooldowns` names the serving route's chain stops currently
     * in a failure cooldown (from the `beforeTurn` context). A switch
     * targeting a cooled-down endpoint is refused with the
     * `cooled-down` stay reason — the router never moves the session
     * onto a model it already knows cannot serve it.
     *
     * #944: `session` is whose turn this is (the hook context's identity,
     * `OWNER_SESSION` when the host does not send one). Only that
     * session's state is read and written — the streak, the expectation
     * and the mismatch notice are per session.
     */
    async decide(
      text: string,
      currentModel: string,
      cooldowns: readonly { ref: string; kind: string }[] = [],
      session: RoutingSession = OWNER_SESSION,
    ): Promise<RoutingVerdict | null> {
      const state = stateFor(session);
      if (state.override || state.paused) return null;
      // #852: a bare continuation message is not a task to route. Before
      // any judgment is spent: no call, no streak accrual, no switch —
      // and one record explaining the silence.
      if (isContinuationMessage(text)) {
        return {
          decision: "stay",
          reason: "continuation",
          confidence: 0,
          streak: state.streak,
          message: truncateToBytes(text),
        };
      }
      const tiers = await this.assignment();
      if (!tiers) return null;
      // The serving model is not the one the router last picked (the config
      // changed, or the user moved to an id outside the tier map). Judging
      // would only overrule the caller silently: wait, visibly, without
      // spending a call. `null` = the notice was already published.
      //
      // The condition is the *tier*, not the exact ref the router named: a
      // hand-picked model that belongs to that same tier is coherent with
      // the decision, so routing resumes on it (ratified: resuming follows
      // the tier, never the model id).
      const expectedTier = state.decidedModel === null ? undefined : tierOfModel(tiers, state.decidedModel);
      const servingTier = tierOfModel(tiers, currentModel);
      const coherent =
        state.decidedModel === null ||
        currentModel === state.decidedModel ||
        (expectedTier !== undefined && servingTier === expectedTier);
      if (!coherent) {
        if (state.mismatchAnnounced) return null;
        state.mismatchAnnounced = true;
        host.onMismatch?.(currentModel, state.decidedModel!);
        return null;
      }
      state.mismatchAnnounced = false;
      const currentTier = tierOfModel(tiers, currentModel);
      const message = truncateToBytes(text);
      const riderQuestions = host.rider?.questions() ?? {};
      // #788: a rider on this turn means the shared request is *this*
      // call, whatever its outcome — the rider must not spend a second
      // request on a turn that already cost one round trip.
      host.rider?.onSharedCall?.();
      // The decision is taken inside `record` so the recorded payload and
      // the action come from one computation — the client calls it exactly
      // once per completed judgment, and never for a failure. `counts`
      // tells the caller whether the answer was usable at all.
      let decided: (Omit<RoutingVerdict, "message"> & { counts: boolean }) | undefined;
      const outcome = await deps.client.judge({
        state: message,
        questions: { ...routingQuestions(tiers), ...riderQuestions },
        record: (answers: Record<string, JevAnswer>, meta) => {
          // #788: the co-riding consumer reads its own answers from the
          // same call before this record is built — one round trip, two
          // judgments. A rider cannot alter the routing decision.
          host.rider?.onAnswers(answers, meta, text);
          const answer = answers.difficulty;
          const answered = answer?.type === "choice" ? tierFromAnswer(answer.choice) : undefined;
          const confidence = answer?.type === "choice" ? answer.confidence : 0;
          // An answer naming a tier the pool cannot reach (or a malformed
          // one) is not a judgment: it stays, unconfident, and it does not
          // count toward the hysteresis. Never a guess.
          const routable = answered !== undefined && tiers.targets[answered] !== undefined;
          const verdictConfidence = routable ? confidence : 0;
          const streak = routable ? nextStreak(state.streakTier, state.streak, answered) : state.streak;
          const decision = decideRouting({
            // An unusable answer is judged as the middle tier *only* so the
            // table has something to compare; its confidence is zero, so it
            // can never switch.
            tier: routable ? answered : "bilanciato",
            confidence: verdictConfidence,
            ...(currentTier !== undefined ? { currentTier } : {}),
            streak,
            paused: false,
            override: false,
          });
          const rawRef = decision.switch && answered !== undefined ? tiers.targets[answered] : undefined;
          // #852: the health gate. The cooldown list is captured at
          // decision time (the context the hook was handed) — a target the
          // serving route already knows is out of quota / cooling down is
          // never chosen, even on a confident hysteresis.
          // #868: an unavailable primary target no longer ends the switch —
          // the router rotates to the next viable candidate of the same
          // tier (option A, default), or through the declared pool when one
          // was given (option B, it replaces the tier bound). None viable →
          // a visible stay that names why.
          const cooled = rawRef !== undefined && cooldowns.some((c) => c.ref === rawRef);
          // #868: candidates in rotation order — the tier's own members
          // first (option A), then any declared-pool refs outside the tier
          // (option B *widens*, it never drops the tier's own candidates).
          const candidates = [
            ...(answered !== undefined ? tiers.members[answered] ?? [] : []),
            ...(host.declaredPool ?? []).filter(
              (ref) => answered === undefined || !tiers.members[answered]?.includes(ref),
            ),
          ].filter((ref): ref is string => ref !== undefined);
          const viable = cooled ? candidates.find((c) => !cooldowns.some((cd) => cd.ref === c)) : rawRef;
          // #868: the tier target was cooled down but a same-tier (or
          // declared-pool) candidate is viable — a switch to it, with the
          // skip recorded. All candidates cooled → a visible stay.
          const skipped = cooled ? rawRef : undefined;
          const ref = viable;
          decided = {
            decision: decision.switch && ref !== undefined ? "switch" : "stay",
            // #868: the stay keeps #852's "cooled-down" when the tier had
            // only the dead target to offer; with rotation candidates that
            // all failed the health gate, it names the fuller reason.
            reason: cooled
              ? candidates.length > 1
                ? "no-viable-candidate"
                : "cooled-down"
              : decision.reason,
            ...(routable ? { tier: answered } : {}),
            confidence: verdictConfidence,
            ...(currentTier !== undefined ? { currentTier } : {}),
            streak,
            counts: routable,
            ...(ref !== undefined ? { ref } : {}),
            ...(skipped !== undefined ? { skipped } : {}),
          };
          return {
            useCase: "routing",
            decision: decided.decision,
            reason: decided.reason,
            tier: decided.tier ?? null,
            confidence: verdictConfidence,
            currentTier: currentTier ?? null,
            streak,
            ...(ref !== undefined ? { target: ref } : {}),
            ...(skipped !== undefined ? { skipped } : {}),
            message,
            answers,
            model: meta.model,
            latencyMs: meta.latencyMs,
            usage: meta.usage,
          };
        },
      });
      if (!outcome.ok || !decided) return null;
      const { counts, ...verdict } = decided;
      // An unusable answer (a tier the pool cannot reach, or a malformed
      // one) leaves the streak untouched: it is not a judgment.
      if (counts && verdict.tier) state.streakTier = verdict.tier;
      state.streak = verdict.streak;
      if (verdict.decision === "switch" && verdict.ref !== undefined) {
        state.decidedModel = verdict.ref;
        state.mismatchAnnounced = false;
      }
      return { ...verdict, message };
    },

    /**
     * Arms the switch the router is about to make: the `model_switched`
     * event it causes must not count as the user taking over. A switch
     * also resets the streak (ratified) and becomes what the next turn
     * expects to see serving.
     */
    noteSwitch(ref: string, current?: string, session: RoutingSession = OWNER_SESSION): void {
      const state = stateFor(session);
      state.expected = ref;
      state.decidedModel = ref;
      // #868: the model serving when the switch was decided — the skip
      // event's "staying <current>" names it (the attempted target does
      // not: that is the model that failed).
      if (current !== undefined) state.servingAtDecision = current;
      restartStreak(state);
      state.mismatchAnnounced = false;
      pendingApplies.set(state, ref);
    },

    /**
     * #868: true while a decided switch is awaiting its application — the
     * window between `noteSwitch` and the next `model_switched` (applied)
     * or `extension_failed { invalid_model }` (skipped). #948: a
     * `switch_refused` (context fit) drops the mark the same way.
     */
    switchPending(): boolean {
      return pendingApplies.has(ownerState);
    },

    /** #868: the decided switch failed to apply — drop the pending mark;
     * the skip event carries the reason and the attempted target. */
    dropPendingSwitch(): void {
      pendingApplies.delete(ownerState);
    },

    /**
     * #1110: a switch the retry wave proposed did not apply (a context-fit
     * refusal, or an unresolvable ref). The expectation must fall back to
     * the model that actually failed and still serves — otherwise the next
     * consultation is gated out by its own decision — and the pending mark
     * drops with it. Owner-scoped like the handlers that call it.
     */
    releasePendingTo(current: string): void {
      pendingApplies.delete(ownerState);
      if (ownerState.decidedModel !== null && ownerState.decidedModel !== current) {
        ownerState.decidedModel = current;
      }
      ownerState.expected = null;
    },

    /** #868: the decided switch applied — clear the pending mark. */
    clearPendingSwitch(): void {
      pendingApplies.delete(ownerState);
    },

    /**
     * #945: observes a `route_serving` record — the core's own, immediate
     * account of "the selected model could not serve; a fallback did".
     * When the serving ref stops matching the router's decided target the
     * divergence is named *now* (the return says so) and the expectation
     * is released: the router is not frozen for the rest of the session
     * and the serving model is what the next turn judges from. Owner-
     * scoped by construction: `route_serving` reaches these hooks from
     * the log of the session that owns the runtime.
     */
    noteRouteServing(serving: string): { current: string; expected: string } | null {
      const state = ownerState;
      if (state.decidedModel === null || state.decidedModel === serving) return null;
      const divergence = { current: serving, expected: state.decidedModel };
      state.decidedModel = null;
      state.mismatchAnnounced = false;
      restartStreak(state);
      return divergence;
    },

    /**
     * Observes a `model_switched`. Returns true when it was *not* the
     * router's own switch — i.e. the user picked a model by hand, which
     * suspends the router and resets the streak. `/routing auto` (or
     * `/model auto`) releases it (ADR-0038).
     */
    noteModelSwitched(to: string): boolean {
      const state = ownerState;
      // Owner-scoped by construction: `model_switched` reaches these hooks
      // from the log of the session that owns the runtime (a child owns no
      // event dispatch), so this is the owner's own model, never a child's.
      state.expected = null;
      if (state.decidedModel === to) return false; // the router's own pick
      restartStreak(state);
      state.override = true;
      return true;
    },

    /**
     * Applies one client command (`/routing on|off|auto`, `/model auto`,
     * ADR-0038). Returns what changed, or null for an unknown command —
     * the caller decides how visible that is.
     *
     * `off` pauses for the session and drops the streak; `on` resumes and
     * clears the override too (the user asked for routing, explicitly);
     * `auto` releases a manual override only, and restarts the hysteresis
     * from zero (ratified: releasing does not re-route the current model).
     *
     * Owner-scoped by construction: a client command arrives through the
     * `onEvent` dispatch of the session that owns the runtime, so `/routing
     * off` pauses the session the user typed it in — never a subagent's,
     * which was born with that pause already in force (#944).
     */
    control(cmd: string): { paused: boolean; override: boolean } | null {
      const state = ownerState;
      if (cmd === "off") {
        state.paused = true;
        restartStreak(state);
        state.mismatchAnnounced = false;
        return { paused: state.paused, override: state.override };
      }
      if (cmd === "on") {
        state.paused = false;
        state.override = false;
        restartStreak(state);
        state.decidedModel = null;
        state.mismatchAnnounced = false;
        return { paused: state.paused, override: state.override };
      }
      if (cmd === "auto") {
        // Releasing hands routing back whole: the router forgets what it
        // last picked, so the very next turn judges again (it does not
        // re-route the model the user chose — the ratification).
        state.override = false;
        restartStreak(state);
        state.decidedModel = null;
        state.mismatchAnnounced = false;
        return { paused: state.paused, override: state.override };
      }
      return null;
    },

    /** One session's state (diagnostics and tests); the owner's by default. */
    snapshot(session: RoutingSession = OWNER_SESSION): RoutingJudgeState {
      return { ...stateFor(session) };
    },
  };
}

export type RoutingJudge = ReturnType<typeof createRoutingJudge>;
