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
import type {
  CompactionHook,
  CompactionHookContext,
  CompactionHookResult,
  CompactionSection,
} from "@moh/extension";
import { createJevClient, type JevClientOptions } from "./client";
import { createGuardrailJudge, GUARDRAIL_TOOL } from "./guardrail-judge";
import { createCompactionJudge } from "./compaction-judge";
import { createRoutingJudge, type RoutingPool } from "./routing-judge";
import { createInjectionJudge } from "./injection-judge";
import { INJECTION_TOOLS } from "./injection";
import { createLintGate } from "./lint-gate";
import { createLintJudge } from "./lint-judge";
import { createClassificationJudge, classificationQuestions } from "./classification-judge";

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
   * whole use case is unavailable (a caller that never wants it).
   * `enabled` is the *config* opt-in: false means the router starts paused,
   * and `/routing on` can still enable it for the session (ratified).
   */
  routing?: JevRoutingOptions;
  /** The config opt-in (`typesafe.routing`). Default false. */
  enabled?: boolean;
  /**
   * #791: the anti-injection opt-in (`typesafe.injection`). Off by
   * default, and it is the only anti-injection switch: the check sends the
   * user's message text (≤ 4 KiB) to TypeSafe on every turn and the text
   * of every `fetch`/`browser` result (≤ 8 KiB), which is a bigger privacy
   * step than the guardrail's command + cwd + git state.
   */
  injection?: boolean;
  /**
   * #789: the end-of-task quality gate (off by default — it sends the
   * changed code's diff to TypeSafe, the strongest privacy step in the
   * pack). Needs the project root for rubric discovery and the git diff;
   * absent = the use case is unavailable (a caller that never wants it).
   */
  lint?: { root: string };
  /**
   * #788: prompt classification. On by default (`typesafe.classification`,
   * an explicit `false` in the config turns it off): Jev classifies the
   * last user message (≤ 2 KiB) each turn into a task type plus a
   * codebase-oriented probability. Outputs: a per-turn task-type hint in
   * the subordinate `turn_notes` section (ADR-0036), and the MPM gate
   * opinion this extension exposes through `state.mpmGate` — the session
   * assembly wires it into `SessionConfig.mpm.turnGate`. The projection,
   * the `mpm_query` tool and the manual commands are never gated.
   */
  classification?: boolean;
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

      // ---- #792 compaction cut guide: one noul per section ------------
      // ADR-0035: at compaction time (auto and forced paths alike), Jev
      // answers "can this section be safely dropped?" per turn body; the
      // highs are handed back as drops. The core applies its own 60%
      // survival floor afterwards — the judge cannot talk itself past it —
      // and reports the floor application back so the aggregate
      // `compact-cut` record carries it. No opt-in beyond the key: the
      // judged state is section previews only (shape, never bodies), and
      // compaction itself is automatic.
      const compactionJudge = createCompactionJudge({
        client,
        append: (payload) => ctx.appendEvent({ name: "jev_judgment", payload }),
      });
      ctx.onCompaction(async (ctxHook) => {
        const verdict = await compactionJudge.judge(ctxHook.sections);
        return {
          drop: verdict.drop,
          onApplied: (applied) => {
            // One aggregate record per compaction (spec §5 §9): sections,
            // drops, floor and the byte sizes the core actually applied.
            ctx.appendEvent({
              name: "jev_judgment",
              payload: {
                ...verdict.summary,
                keptByFloor: applied.keptByFloor,
                bytesAfter: applied.bytesAfter,
              },
            });
          },
        };
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
      // ---- #791 anti-injection: two halves, two seams -------------------
      // Opt-in and off by default (`typesafe.injection`): the check sends
      // the user's own message text to TypeSafe, which is a choice, not a
      // side effect of having a key. Both halves ask the same two
      // questions; `sensitive` never blocks, only `injection` above 0.95
      // does — a confirmation before a turn, a withheld result after a
      // fetch.
      if (options.injection === true) {
        const injection = createInjectionJudge({
          client,
          append: (payload) => ctx.appendEvent({ name: "jev_judgment", payload }),
        });
        // Half 1: the user's turn input, through the pre-send confirmation
        // of ADR-0033. The band's `confirm` is the only one that reports
        // back: the record waits for the answer, so a cancelled turn leaves
        // exactly one entry in the log and no `user_message`.
        ctx.beforeTurn(async ({ text }) => {
          const verdict = await injection.judgeInput(text);
          if (!verdict || verdict.band !== "confirm" || verdict.reason === undefined) return;
          return {
            confirm: {
              reason: verdict.reason,
              ...(verdict.resolve ? { onResolved: verdict.resolve } : {}),
            },
          };
        });
        // Half 2: external content, through the post-tool seam of ADR-0034,
        // registered for the two tools whose output a third party controls.
        ctx.onToolResult(INJECTION_TOOLS, async ({ name, output }) => {
          const verdict = await injection.judgeToolResult(name, output);
          if (!verdict?.withhold) return;
          return { withhold: { reason: verdict.withhold } };
        });
      }

      // ---- #789 quality gate: the end-of-task semantic lint -----------
      // Opt-in and off by default (`typesafe.lint`): the one use case that
      // sends the changed code's diff to TypeSafe — the strongest privacy
      // step in the pack, disclosed in the Settings entry. On a "done"
      // turn that changed files (never a cancelled or errored one), the
      // discovered convention documents plus the task's unified diff are
      // judged with three fixed questions; a finding asks the core for a
      // synthetic correction turn (ADR-0037), re-judges, and hard-stops
      // after two cycles.
      if (options.lint) {
        const gate = createLintGate({
          judge: createLintJudge({
            client,
            append: (payload) => ctx.appendEvent({ name: "jev_judgment", payload }),
          }),
          root: options.lint.root,
          // ADR-0037: the core-mediated synthetic turn. Absent on a 1.5-
          // or-older runtime — the gate degrades to judgment-only (the
          // record still lands, no correction turn is requested).
          requestTurn:
            typeof ctx.requestTurn === "function"
              ? (text) => ctx.requestTurn(text)
              : async () => false,
          // The stop is one event, not a judgment: the probabilities were
          // never re-measured, so a fake `jev_judgment` would lie.
          reportStop: (reason, findings) =>
            ctx.appendEvent({ name: "jev_lint_stopped", payload: { reason, findings: [...findings] } }),
        });
        ctx.onToolCall(async (call) => {
          // Observation only: record the paths the task writes/edits for
          // the diff; never a decision, so nothing is returned.
          gate.observeToolCall(call.name, call.args);
        });
        ctx.afterTurn(async ({ result, synthetic }) => {
          // Ratified trigger: the end of a *done* turn only. A cancelled
          // or errored turn is never judged (its work may be partial by
          // interruption, not by omission), and a synthetic turn the gate
          // itself requested is never re-gated — that is the no-recursion
          // rule, enforced by skipping here.
          if (synthetic === true || result.status !== "done") return;
          // `requestTurn` resolves when the correction turn settles (the
          // queue runs it like any turn), so cycle 2 re-diffs the
          // corrected tree — no polling (ADR-0037 §5).
          await gate.onTaskEnd();
        });
        ctx.onSessionEnd(() => gate.reset());
      }

      // ---- #788 prompt classification: task type + MPM gate -----------
      // On unless the config opted out (`typesafe.classification: false`).
      // Jev classifies the last user message each turn; the hint rides the
      // ADR-0036 `turn_notes` section (subordinate to the project's own
      // instructions, replaced — never accumulated) and the MPM gate
      // opinion is published through `state.mpmGate` for the assembly to
      // wire into `SessionConfig.mpm.turnGate`.
      const classificationJudge =
        options.classification !== false
          ? createClassificationJudge({
              client,
              append: (payload) => ctx.appendEvent({ name: "jev_judgment", payload }),
            })
          : undefined;
      if (classificationJudge) {
        // The assembly reads this (the `routingState` pattern): the
        // current turn's MPM gate opinion — `null` = no opinion. The
        // note itself needs no cleanup hook: the core clears every turn
        // note at the next turn's start (ADR-0036 §2).
        ctx.state.mpmGate = null;
      }

      // ---- #787 routing: one tier per turn -----------------------------
      // Opt-in and off by default (`typesafe.routing`). Jev judges the last
      // user message only, answers with a tier, and the session switches to
      // that tier's model through the same resolution as a manual `/model`
      // — never to a model the user has not configured. Inert when there is
      // nothing to choose (fewer than two reachable tiers).
      if (options.routing) {
        const routing = options.routing;
        const enabled = options.enabled === true;
        const judge = createRoutingJudge(
          { client, state: ctx.state ?? {} },
          {
            pool: routing.pool,
            labels: routing.labels ?? {},
            // #788: when the router makes its per-turn call, the
            // classification rides it — one state, one round trip, both
            // consumers reading their own answers.
            ...(classificationJudge
              ? {
                  rider: {
                    questions: classificationQuestions,
                    onSharedCall: () => {
                      // The routing call covers this turn (success or
                      // failure): never a second request for it.
                      ctx.state.classificationShared = true;
                    },
                    onAnswers: (answers, meta, text) => {
                      ctx.state.classificationShared = true;
                      const verdict = classificationJudge.judgeShared(answers, meta, text);
                      if (verdict?.hint !== undefined) ctx.setPromptNote(verdict.hint);
                    },
                  },
                }
              : {}),
            // The serving model is not the one the router picked: say so
            // once per episode and stay out of the way (no call, no switch).
            onMismatch: (currentModel, expected) => {
              ctx.appendEvent({
                name: "jev_routing",
                payload: { kind: "mismatch", current: currentModel, expected },
              });
            },
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
          if (event.type === "model_switched" && typeof event.to === "string") {
            if (!judge.noteModelSwitched(event.to)) return;
            // The user picked a model by hand: the router steps aside and
            // says so. `/routing auto` (or `/model auto`) hands it back.
            ctx.appendEvent({ name: "jev_routing", payload: { kind: "override", model: event.to } });
            return;
          }
          // ADR-0038: the client talks to the router through commands. The
          // extension answers with the resolved state, so the client never
          // has to guess what the router thinks (a status only reaches the
          // TUI footer, and outputs are not a channel).
          if (event.type !== "extension_control") return;
          const payload = (event.payload ?? {}) as Record<string, unknown>;
          const cmd = typeof payload.cmd === "string" ? payload.cmd : "";
          const applied = judge.control(cmd);
          if (!applied) {
            ctx.appendEvent({ name: "jev_routing", payload: { kind: "unknown-command", cmd } });
            return;
          }
          ctx.appendEvent({
            name: "jev_routing",
            payload: { kind: "control", cmd, paused: applied.paused, override: applied.override },
          });
        });
        // The config opt-in is the *starting* state, not a gate: the router
        // exists either way, so `/routing on` can enable it for a session
        // that never opted in (ratified) — and while it is off it still
        // costs nothing, because `decide` returns before any call.
        if (!enabled) judge.control("off");
        // Resolve the assignment at session start only when it can matter:
        // an off router must not fetch a listing either.
        ctx.onSessionStart(() => {
          if (ctx.state.routingState && !(ctx.state.routing as { paused?: boolean } | undefined)?.paused) void judge.resolution();
        });
        // The client asks for the resolved state on demand (`/routing`).
        // `state` is the one channel that answers *synchronously*: the
        // status is ephemeral and `appendEvent` is a transcript line, not a
        // return value — and the request may well arrive before the pool
        // resolved, in which case the answer says so instead of waiting.
        ctx.state.routingState = (): Record<string, unknown> | null => {
          const resolution = judge.peekResolution();
          const snapshot = judge.snapshot();
          if (!resolution) return { ...snapshot, assignment: null };
          const assignment = resolution.assignment;
          const tierTargets = assignment ? assignment.targets : undefined;
          return {
            ...snapshot,
            assignment: assignment
              ? {
                  targets: { ...tierTargets },
                  members: assignment.members,
                  ignoredLabels: [...assignment.ignoredLabels],
                  unpriced: [...assignment.unpriced],
                }
              : null,
            warnings: [...resolution.warnings],
          };
        };
      }

      // ---- #788 classification: the own-call turn-start hook ----------
      // Registered after the routing hook on purpose: hooks run in
      // registration order, so the routing hook decides first whether it
      // will make the shared call (and the rider has consumed the turn);
      // only when routing did nothing does the classification spend its
      // own request. Either way the hint lands in this turn's
      // `turn_notes` and the gate opinion is published.
      if (classificationJudge) {
        ctx.beforeTurn(async ({ text }) => {
          if (ctx.state.classificationShared === true) {
            // The routing call judged this turn already; consume the flag.
            ctx.state.classificationShared = false;
          } else {
            const verdict = await classificationJudge.judge(text);
            if (verdict?.hint !== undefined) ctx.setPromptNote(verdict.hint);
          }
          const gate = classificationJudge.mpmAllowed();
          ctx.state.mpmGate = gate === undefined ? null : gate;
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
  COMPACTION_CUT_QUESTION,
  COMPACTION_CUT_QUESTIONS,
  COMPACTION_CUT_THRESHOLDS,
  type CompactionCutSectionVerdict,
} from "./compaction";
export {
  createCompactionJudge,
  type CompactionCutVerdict,
  type CompactionJudge,
  type JudgedSection,
} from "./compaction-judge";
export {
  INJECTION_INPUT_MAX_BYTES,
  INJECTION_QUESTIONS,
  INJECTION_THRESHOLDS,
  INJECTION_TOOL_MAX_BYTES,
  INJECTION_TOOLS,
  SENSITIVE_ADVICE,
  injectionBand,
  injectionConfirmReason,
  injectionWithholdReason,
  sliceForJudgment,
  type InjectionBand,
  type InjectionDecision,
  type InjectionSignals,
  type InjectionSource,
} from "./injection";
export {
  createInjectionJudge,
  type InjectionInputVerdict,
  type InjectionJudge,
  type InjectionToolVerdict,
} from "./injection-judge";
export {
  CLASSIFICATION_MESSAGE_MAX_BYTES,
  CLASSIFICATION_QUESTIONS,
  CLASSIFICATION_THRESHOLDS,
  TASK_TYPES,
  TASK_TYPE_HINTS,
  classificationSignals,
  hintFor,
  mpmGate,
  taskTypeFromAnswer,
  type ClassificationSignals,
  type TaskType,
} from "./classification";
export {
  classificationQuestions,
  createClassificationJudge,
  type ClassificationJudge,
  type ClassificationVerdict,
} from "./classification-judge";
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
export {
  LINT_COMPLETENESS_QUESTION,
  LINT_CONVENTIONS_QUESTION,
  LINT_DIMENSION_LABELS,
  LINT_DIFF_MAX_BYTES,
  LINT_DIFF_TRUNCATION_MARKER,
  LINT_ERROR_HANDLING_QUESTION,
  LINT_QUESTIONS,
  LINT_THRESHOLDS,
  correctionText,
  type LintQuestionId,
} from "./lint";
export {
  LINT_MAX_CYCLES,
  createLintGate,
  createLintTaskState,
  type LintGate,
  type LintTaskState,
} from "./lint-gate";
export { createLintJudge, lintFindings, type LintJudge, type LintState, type LintVerdict } from "./lint-judge";
export {
  discoverRubrics,
  RUBRIC_MAX_BYTES,
  RUBRIC_MAX_FILES,
  RUBRIC_NAMES,
  RUBRIC_TRUNCATION_MARKER,
  type RubricDoc,
} from "./rubrics";
export { captureHead, inGitRepo, taskDiff } from "./diff";
