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
import { createJevClient, validateJevKey, type JevClient, type JevClientOptions } from "./client";

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
  /**
   * Receives the live client once `setup` ran (the use-case layer attaches
   * its hooks to this instance; `undefined` until the runtime loads us).
   */
  onClient?: (client: JevClient) => void;
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
      options.onClient?.(client);
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
export { questions } from "./questions";
