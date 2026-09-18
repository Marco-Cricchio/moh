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

/** The extension's name, as stamped in the log and shown in the footer. */
export const JEV_GUARD_NAME = "jev-guard";

/** The definition's version, reported by the `extension_loaded` event. */
export const JEV_GUARD_VERSION = "0.1.0";

export interface JevGuardOptions {
  /** TypeSafe API key (from the user config's `typesafe.apiKey`). */
  apiKey: string;
  /** Hook timeout for one Jev call, ms. Default `JEV_TIMEOUT_MS_DEFAULT`. */
  timeoutMs?: number;
  /** Test seam: the fetch implementation handed to the client. */
  fetchImpl?: typeof fetch;
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
