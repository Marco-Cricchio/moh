/**
 * `moh-extension-jev-guard`: the bundled first-party Jev (TypeSafe)
 * extension (#784).
 *
 * Scope of this layer: the *infrastructure* only. It owns the HTTP client,
 * the offline signal and one home for use-case questions; the judgments
 * themselves belong to their own issues (#786 guardrail, #787 routing,
 * #788–#793), which call the same client.
 *
 * Boundaries (ratified, vision note 35 + #784):
 * - `@moh/core` never learns about Jev: it knows only the generic
 *   `appendEvent` / `setStatus` / `ask` contract additions this layer needs.
 * - The endpoint and the model are hardcoded (no override, no env var).
 * - No npm dependency: one `fetch`, so no dependency-authorization friction.
 * - The key lives in the user config; present = active. No toggle.
 *
 * The default export is the factory below: a definition needs the resolved
 * `apiKey`/`timeoutMs`, which only the assembly (the owner of the user
 * config) has — so the module exports a producer of definitions rather
 * than one ready-made definition.
 */
import { defineExtension, MOH_EXTENSION_API_VERSION, type ExtensionDefinition, type ExtensionSetupContext } from "@moh/extension";
import { createJevClient, type JevClientOptions } from "./client";
import { createGuardrailJudge, GUARDRAIL_TOOL } from "./guardrail-judge";
import { createRoutingJudge, type RoutingPool } from "./routing-judge";

/** The extension's name, as stamped in the log and shown in the footer. */
export const JEV_GUARD_NAME = "jev-guard";

/** The definition's version, reported by the `extension_loaded` event. */
export const JEV_GUARD_VERSION = "0.1.0";

/** #787: the model-routing use case's inputs, resolved by the core. */
export interface JevRoutingOptions {
  /** The models this session can actually reach (core-resolved pool). */
  pool: () => Promise<RoutingPool>;
  /** Explicit tier labels (`typesafe.tiers`): `<endpoint>/<model-id>` → tier. */
  labels?: Record<string, string>;
}

export interface JevGuardOptions {
  /** TypeSafe API key (from the user config's `typesafe.apiKey`). */
  apiKey: string;
  /** Hook timeout for one Jev call, ms. Default `JEV_TIMEOUT_MS_DEFAULT`. */
  timeoutMs?: number;
  /** Test seam: the fetch implementation handed to the client. */
  fetchImpl?: typeof fetch;
  /**
   * #787: model routing. Present = the router is registered; absent = the
   * extension is active but routes nothing (the zero-cost case).
   */
  routing?: JevRoutingOptions;
}

/**
 * Builds the bundled extension definition. `setup` constructs the client
 * and wires its two observation seams to the generic contract (ADR-0032):
 * every judgment rides `appendEvent` (stamped, redacted, per-turn capped)
 * and the connectivity signal rides `setStatus` (ephemeral, one per
 * transition). No hook is registered here — an active extension with no use
 * case enabled costs exactly zero calls.
 */
export function createJevGuardExtension(options: JevGuardOptions): ExtensionDefinition {
  const clientOptions: JevClientOptions = {
    apiKey: options.apiKey,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  };
  return defineExtension({
    name: JEV_GUARD_NAME,
    version: JEV_GUARD_VERSION,
    apiVersion: MOH_EXTENSION_API_VERSION,
    setup(ctx: ExtensionSetupContext) {
      const client = createJevClient({
        ...clientOptions,
        onJudgment: (record) => ctx.appendEvent({ name: "jev_judgment", payload: record }),
        onStatus: (text) => ctx.setStatus(text),
      });

      // ---- #786 guardrail: the first use case --------------------------
      // Jev judges EVERY bash call (before rules, ADR-0031 gate order):
      // deny → veto, ask → the human consent flow (never auto-accepted,
      // never "always"), pass → nothing. Yolo gets lethal checks only.
      /** Session mode, tracked from the log's `session_mode` chrome. */
      let mode: "normal" | "auto-accept" | "yolo" = "normal";
      const judge = createGuardrailJudge(
        { client, state: ctx.state ?? {} },
        {
          mode: () => mode,
          cwd: (args) => {
            const a = (args ?? {}) as Record<string, unknown>;
            return typeof a.cwd === "string" ? a.cwd : process.cwd();
          },
        },
      );

      ctx.onSessionStart(() => {
        judge.invalidateOnGitChange();
      });
      ctx.onEvent(({ event }) => {
        if (event.type === "session_mode" && (event.mode === "normal" || event.mode === "auto-accept" || event.mode === "yolo")) {
          mode = event.mode;
        }
      });
      ctx.afterTurn(() => {
        judge.invalidateOnGitChange();
      });
      ctx.onSessionEnd(() => judge.reset());
      ctx.onToolCall(async (call) => {
        if (call.name !== GUARDRAIL_TOOL) return;
        const result = await judge.judge(call.callId, call.args);
        const v = result.verdict.verdict;
        if (v === "deny") {
          return { veto: true, reason: result.verdict.reason };
        }
        if (v === "ask") {
          // ask = human confirmation, not a grant: auto-accept evaluates it
          // before its allow branch (ADR-0031), yolo ignores it, headless
          // denies it — all core behaviour, nothing to do here but ask.
          return { ask: true, reason: result.verdict.badge };
        }
        return;
      });
      // ---- #787 routing: one tier per turn -----------------------------
      // Opt-in and off by default (`typesafe.routing`). Jev judges the last
      // user message only, answers with a tier, and the session switches to
      // that tier's model through the same resolution as a manual `/model`
      // — never to a model the user has not configured. Inert when there is
      // nothing to choose (fewer than two reachable tiers).
      if (options.routing) {
        const routing = options.routing;
        const judge = createRoutingJudge(
          { client, state: ctx.state ?? {} },
          {
            pool: routing.pool,
            labels: routing.labels ?? {},
            // One visible line per resolved problem, once per session —
            // never a turn error, never silence about a misconfiguration.
            onResolved: (resolution) => {
              for (const warning of resolution.warnings) {
                ctx.appendEvent({ name: "jev_routing", payload: { kind: "listing-failed", message: warning } });
              }
              if (!resolution.assignment) {
                ctx.appendEvent({ name: "jev_routing", payload: { kind: "inert" } });
                return;
              }
              for (const ref of resolution.assignment.ignoredLabels) {
                ctx.appendEvent({ name: "jev_routing", payload: { kind: "ignored-label", ref } });
              }
              const unpriced = resolution.assignment.unpriced;
              if (unpriced.length > 0) {
                ctx.appendEvent({
                  name: "jev_routing",
                  payload: { kind: "unpriced", count: unpriced.length, models: unpriced.slice(0, 5) },
                });
              }
            },
          },
        );
        ctx.beforeTurn(async (call) => {
          const verdict = await judge.decide(call.text, call.model);
          if (!verdict || verdict.decision !== "switch" || verdict.ref === undefined) return;
          // Arm the switch before returning: the `model_switched` it causes
          // is the router's, not the user taking the wheel.
          judge.noteSwitch(verdict.ref);
          return { model: verdict.ref };
        });
        ctx.onEvent(({ event }) => {
          if (event.type !== "model_switched" || typeof event.to !== "string") return;
          if (!judge.noteModelSwitched(event.to)) return;
          // The user switched by hand: routing is suspended for the rest of
          // the session. Releasing it needs the client→extension control
          // seam that `/routing` and `/model auto` will bring (their issue).
          ctx.appendEvent({ name: "jev_routing", payload: { kind: "override", model: event.to } });
        });
        // Resolve the assignment (and its diagnostics) at session start:
        // the pool listing overlaps the first turn instead of delaying it.
        ctx.onSessionStart(() => {
          void judge.resolution();
        });
      }
    },
  });
}

export default createJevGuardExtension;

export {
  createJevClient,
  validateJevKey,
  JEV_ENDPOINT,
  JEV_MODEL,
  JEV_OFFLINE_STATUS,
  JEV_RETRY_AFTER_MAX_MS,
  JEV_RETRY_DELAY_MS,
  JEV_TIMEOUT_MS_DEFAULT,
} from "./client";
export type {
  JevAnswer,
  JevChoiceAnswer,
  JevChoiceQuestion,
  JevClient,
  JevClientOptions,
  JevFailureKind,
  JevKeyValidation,
  JevJudgeInput,
  JevJudgmentMeta,
  JevNoulAnswer,
  JevNoulQuestion,
  JevOutcome,
  JevQuestion,
  JevScoreAnswer,
  JevScoreQuestion,
} from "./client";
export { questions } from "./questions-core";
export {
  decideGuardrail,
  GUARDRAIL_QUESTIONS,
  GUARDRAIL_THRESHOLDS,
  type GuardrailDecision,
  type GuardrailSignals,
  type GuardrailVerdict as GuardrailRuleVerdict,
} from "./guardrail";
export {
  assignTiers,
  decideRouting,
  nextStreak,
  routableTierCount,
  routingQuestions,
  tierOfModel,
  truncateToBytes,
  ROUTING_CONFIDENCE_MIN,
  ROUTING_MESSAGE_MAX_BYTES,
  ROUTING_STREAK_REQUIRED,
  ROUTING_TIERS,
  type RoutingDecision,
  type RoutingModel,
  type RoutingSignals,
  type RoutingStayReason,
  type RoutingTier,
  type TierAssignment,
  type TierLabels,
} from "./routing";
export {
  createRoutingJudge,
  type RoutingJudge,
  type RoutingJudgeState,
  type RoutingPool,
  type RoutingResolution,
  type RoutingVerdict,
} from "./routing-judge";
export {
  askBadge,
  createGuardrailJudge,
  GUARDRAIL_TOOL,
  type GuardrailJudgeResult,
} from "./guardrail-judge";
export {
  createGuardrailCache,
  gitSnapshot,
  guardrailStateKey,
  type GuardrailCache,
  type GuardrailState,
  type GuardrailVerdict,
} from "./session-state";
