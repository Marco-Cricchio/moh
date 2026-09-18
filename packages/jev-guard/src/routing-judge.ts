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
  expected: string | null;
}

const INITIAL: RoutingJudgeState = { streak: 0, streakTier: null, override: false, expected: null };

/**
 * Builds the per-session routing judge. State lives in the extension's
 * durable store so a hot-reload keeps the streak and the override.
 */
export function createRoutingJudge(deps: RoutingJudgeDeps, host: RoutingJudgeHost) {
  const state = (deps.state.routing as RoutingJudgeState | undefined) ?? { ...INITIAL };
  deps.state.routing = state;
  /** In-session memo of the resolution: one pool look-up, one listing. */
  let resolution: Promise<RoutingResolution> | undefined;

  const resolveAssignment = async (): Promise<RoutingResolution> => {
    const pool = await host.pool();
    const resolved = assignTiers(pool.models, host.labels ?? {});
    const warnings = pool.warnings ?? [];
    if (routableTierCount(resolved) < 2) return { assignment: null, warnings };
    return { assignment: resolved, warnings };
  };

  const resolveOnce = (): Promise<RoutingResolution> =>
    (resolution ??= resolveAssignment().then((resolved) => {
      host.onResolved?.(resolved);
      return resolved;
    }));

  return {
    /** The resolution (assignment null when fewer than two tiers exist). */
    resolution: resolveOnce,

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
      if (state.override) return null;
      const tiers = await this.assignment();
      if (!tiers) return null;
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
      return { ...verdict, message };
    },

    /**
     * Arms the switch the router is about to make: the `model_switched`
     * event it causes must not count as the user taking over. A switch
     * also resets the streak (ratified).
     */
    noteSwitch(ref: string): void {
      state.expected = ref;
      state.streak = 0;
      state.streakTier = null;
    },

    /**
     * Observes a `model_switched`. Returns true when it was *not* the
     * router's own switch — i.e. the user picked a model by hand, which
     * suspends the router for the rest of the session and resets the
     * streak. Releasing it needs a client→extension control seam, which
     * the `/routing` and `/model auto` commands will bring (their own
     * issue); today an override lasts the session.
     */
    noteModelSwitched(to: string): boolean {
      if (state.expected === to) {
        state.expected = null;
        return false;
      }
      state.expected = null;
      state.streak = 0;
      state.streakTier = null;
      state.override = true;
      return true;
    },

    /** The session state (diagnostics and tests). */
    snapshot(): RoutingJudgeState {
      return { ...state };
    },
  };
}

export type RoutingJudge = ReturnType<typeof createRoutingJudge>;
