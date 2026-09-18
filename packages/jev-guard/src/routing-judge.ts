/**
 * The routing judge (#787): one Jev call per potentially-switching turn,
 * the tier assignment resolved from the core-provided pool, and the
 * per-session state (streak + manual override).
 *
 * Fail-open throughout: routing is never inert-because-broken, only
 * inert-because-there-is-nothing-to-choose (fewer than two tiers) — and a
 * failed call produces no judgment, no switch and no event.
 */
import type { JevAnswer, JevClient } from "./client";
import {
  assignTiers,
  decideRouting,
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
  /** Called once, when the assignment is first resolved (fail-open). */
  onResolved?: (resolution: RoutingResolution) => void;
  /**
   * Called once per mismatch episode: the serving model is not the one the
   * router picked. Routing stays out of the way until the caller stops
   * overruling it — visibly, and without paying for a judgment.
   */
  onMismatch?: (currentModel: string, expected: string) => void;
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
  /** The exact judged state (already truncated), for the record. */
  readonly message: string;
}

export interface RoutingJudgeState {
  streak: number;
  streakTier: RoutingTier | null;
  override: boolean;
  /** `/routing off`: routing is paused for this session. */
  paused: boolean;
  /** The model of the tier the router last decided to serve. */
  decidedModel: string | null;
  /** A `mismatch` notice was already published for this episode. */
  mismatchAnnounced: boolean;
  expected: string | null;
}

const INITIAL: RoutingJudgeState = {
  streak: 0,
  streakTier: null,
  override: false,
  paused: false,
  decidedModel: null,
  mismatchAnnounced: false,
  expected: null,
};

/**
 * Builds the per-session routing judge. State lives in the extension's
 * durable store so a hot-reload keeps the streak and the override.
 */
export function createRoutingJudge(deps: RoutingJudgeDeps, host: RoutingJudgeHost) {
  const state = (deps.state.routing as RoutingJudgeState | undefined) ?? { ...INITIAL };
  deps.state.routing = state;
  /** In-session memo of the resolution: one pool look-up, one listing. */
  let resolution: Promise<RoutingResolution> | undefined;
  /** The resolved value, once it landed (see `peekResolution`). */
  let resolved: RoutingResolution | null = null;

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
     */
    async decide(text: string, currentModel: string): Promise<RoutingVerdict | null> {
      if (state.override || state.paused) return null;
      const tiers = await this.assignment();
      if (!tiers) return null;
      // The serving model is not the one the router last picked (the config
      // changed, or `/model` named an id outside the tier map). Judging
      // would only overrule the caller silently: wait, visibly, without
      // spending a call. `null` = the notice was already published.
      const mismatch = state.decidedModel !== null && currentModel !== state.decidedModel;
      if (mismatch) {
        if (state.mismatchAnnounced) return null;
        state.mismatchAnnounced = true;
        host.onMismatch?.(currentModel, state.decidedModel!);
        return null;
      }
      state.mismatchAnnounced = false;
      const currentTier = tierOfModel(tiers, currentModel);
      const message = truncateToBytes(text);
      // The decision is taken inside `record` so the recorded payload and
      // the action come from one computation — the client calls it exactly
      // once per completed judgment, and never for a failure. `counts`
      // tells the caller whether the answer was usable at all.
      let decided: (Omit<RoutingVerdict, "message"> & { counts: boolean }) | undefined;
      const outcome = await deps.client.judge({
        state: message,
        questions: routingQuestions(tiers),
        record: (answers: Record<string, JevAnswer>, meta) => {
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
          const ref = decision.switch && answered !== undefined ? tiers.targets[answered] : undefined;
          decided = {
            decision: decision.switch ? "switch" : "stay",
            reason: decision.reason,
            ...(routable ? { tier: answered } : {}),
            confidence: verdictConfidence,
            ...(currentTier !== undefined ? { currentTier } : {}),
            streak,
            counts: routable,
            ...(ref !== undefined ? { ref } : {}),
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
    noteSwitch(ref: string): void {
      state.expected = ref;
      state.decidedModel = ref;
      state.streak = 0;
      state.streakTier = null;
      state.mismatchAnnounced = false;
    },

    /**
     * Observes a `model_switched`. Returns true when it was *not* the
     * router's own switch — i.e. the user picked a model by hand, which
     * suspends the router and resets the streak. `/routing auto` (or
     * `/model auto`) releases it (ADR-0038).
     */
    noteModelSwitched(to: string): boolean {
      state.expected = null;
      if (state.decidedModel === to) return false; // the router's own pick
      state.streak = 0;
      state.streakTier = null;
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
     */
    control(cmd: string): { paused: boolean; override: boolean } | null {
      if (cmd === "off") {
        state.paused = true;
        state.streak = 0;
        state.streakTier = null;
        state.mismatchAnnounced = false;
        return { paused: state.paused, override: state.override };
      }
      if (cmd === "on") {
        state.paused = false;
        state.override = false;
        state.streak = 0;
        state.streakTier = null;
        state.mismatchAnnounced = false;
        return { paused: state.paused, override: state.override };
      }
      if (cmd === "auto") {
        state.override = false;
        state.streak = 0;
        state.streakTier = null;
        return { paused: state.paused, override: state.override };
      }
      return null;
    },

    /** The session state (diagnostics and tests). */
    snapshot(): RoutingJudgeState {
      return { ...state };
    },
  };
}

export type RoutingJudge = ReturnType<typeof createRoutingJudge>;
