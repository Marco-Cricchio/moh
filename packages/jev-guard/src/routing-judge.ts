/**
 * The routing judge (#787): one Jev call per potentially-switching turn,
 * the tier assignment resolved from the core-provided pool, and the
 * per-session state (streak + manual override).
 *
 * Fail-open throughout: routing is never inert-because-broken, only
 * inert-because-there-is-nothing-to-choose (fewer than two tiers) — and a
 * failed call produces no judgment, no switch and no event.
 */
import type { JevAnswer, JevClient, JevJudgmentMeta, JevQuestion } from "./client";
import {
  assignTiers,
  decideRouting,
  isContinuationMessage,
  nextStreak,
  routableTierCount,
  routingQuestions,
  tierFromAnswer,
  tierOfModel,
  truncateToBytes,
  type RoutingDecision,
  type RoutingModel,
  type RoutingTier,
  type TierAssignment,
  type TierLabels,
} from "./routing";

export interface RoutingJudgeDeps {
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

export interface RoutingJudgeHost {
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
     * or `extension_failed { invalid_model }` (skipped).
     */
    switchPending(): boolean {
      return pendingApplies.has(ownerState);
    },

    /** #868: the decided switch failed to apply — drop the pending mark;
     * the skip event carries the reason and the attempted target. */
    dropPendingSwitch(): void {
      pendingApplies.delete(ownerState);
    },

    /** #868: the decided switch applied — clear the pending mark. */
    clearPendingSwitch(): void {
      pendingApplies.delete(ownerState);
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
