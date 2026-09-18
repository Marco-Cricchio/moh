/**
 * @moh/extension: the types-only contract for moh extensions (#10, #19).
 *
 * An extension is a module whose default export is the result of
 * `defineExtension(...)`. Everything an extension can do goes through the
 * injected setup context: it observes the loop via hooks and can only
 * *restrict* tool calls (veto), never grant permissions.
 *
 * apiVersion policy: additive-only. The runtime loads any extension whose
 * apiVersion shares the same *major* as MOH_EXTENSION_API_VERSION; a major
 * mismatch is refused at load with a warning (the session continues).
 *
 * 1.1 (ADR-0031/ADR-0032): the `ask` outcome on the tool-call hook and the
 * two observation-only setup seams (`appendEvent`, `setStatus`). An older
 * runtime ignores both, which is a no-op (fail-open) — never an error.
 *
 * 1.2 (ADR-0033): the `beforeTurn` hook — one turn-start decision point,
 * fired once per user send before the turn exists. An older runtime never
 * calls it, which is a no-op (fail-open) — never an error.
 *
 * 1.3 (ADR-0038): the client→extension control channel — a client command
 * addressed to one extension arrives as an `extension_control` event on
 * `onEvent`. An older runtime never emits one, which is a no-op: an
 * extension that waits for a command must tolerate never receiving it.
 *
 * 1.4 (ADR-0034, ADR-0033 amendment): `onToolResult` — a scoped
 * post-tool inspection seam — and the optional `onResolved` callback on
 * `beforeTurn`'s `confirm` request. An older runtime never calls either,
 * which is a no-op for the extension (the result proceeds untouched, and
 * a confirmation the extension cannot observe is still asked).
 */

/**
 * The apiVersion this build of moh speaks. Format: "major.minor".
 * Minor bumps are additive (new optional hooks/fields); major bumps are
 * breaking and refuse to load older/newer extensions.
 */
export const MOH_EXTENSION_API_VERSION = "1.4";

/** Structural (core-independent) view of an event-log entry. */
export interface ExtensionEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface SessionStartContext {
  readonly startedAt: Date;
}

export interface SessionEndContext {
  /** Why the session ended; "disposed" when the client closed it. */
  readonly reason: string;
}

/** Read-only view of the assembled prompt + conversation for one model call. */
export interface BeforeModelCallContext {
  readonly prompt: {
    readonly sections: Readonly<Record<string, string>>;
    readonly system: string;
    readonly version: string;
  };
  readonly messages: readonly unknown[];
}

/**
 * The turn-start context (ADR-0033, apiVersion 1.2): what a `beforeTurn`
 * hook sees. The user's message **as typed** (mentions are not expanded
 * yet) — the rest of the conversation is never handed to the hook.
 */
export interface BeforeTurnContext {
  /** The user's message as typed (pre-mention-expansion). */
  readonly text: string;
  /** 1-based count of user turns in this session, including this one. */
  readonly turnIndex: number;
  /** The model ref currently serving the session. */
  readonly model: string;
}

/**
 * What a `beforeTurn` hook may return. Restriction-shaped only: it may
 * name an *existing* model ref and may ask the user a question — it can
 * never grant a permission, widen a tool's scope, or invent a model.
 *
 * - `model` — the ref to serve **this** turn. It resolves exactly like the
 *   manual `/model` switch (same registry and endpoint profiles); a ref
 *   equal to the active model is a silent no-op, an unresolvable ref is
 *   ignored with a visible `extension_failed { reason: "invalid_model" }`
 *   and the turn proceeds on the active model — never a turn error.
 * - `confirm` — ask the user to confirm **before** this turn is sent
 *   (apiVersion 1.2, ADR-0033 §4). Its client behaviour — the TUI modal,
 *   the headless refusal — is wired by the use case that needs it.
 *
 * The hook fires once per user send, before anything is logged: a turn
 * that is cancelled on `confirm` leaves no `user_message` behind.
 */
export interface BeforeTurnResult {
  /** Model ref to serve this turn (resolved like `/model`). */
  readonly model?: string;
  /** Ask the user to confirm before this turn is sent. */
  readonly confirm?: {
    readonly reason: string;
    /**
     * Called once with how the confirmation ended (ADR-0033 amendment,
     * apiVersion 1.4): `send` when the user let the turn through,
     * `cancel` when they cancelled it (nothing is logged, the text
     * returns to the composer), `refuse` when no client could ask — the
     * headless case — and the turn was refused.
     *
     * It exists so the extension that raised the confirmation can record
     * the outcome in its own log entry: a cancelled turn leaves no
     * `user_message`, so that record is the only trace of what happened.
     * Never called before the hook has returned; a throw is swallowed.
     */
    readonly onResolved?: (outcome: TurnConfirmOutcome) => void;
  };
}

/** How a pre-send confirmation ended (ADR-0033 §4). */
export type TurnConfirmOutcome = "send" | "cancel" | "refuse";

export interface ToolCallContext {
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
}

/**
 * The post-tool inspection context (ADR-0034, apiVersion 1.4): what an
 * `onToolResult` hook sees — the tool's textual output as the model would
 * receive it, before anything is logged. Text results only: a result
 * carrying an image (#778) is never offered (an image is not judgeable
 * text, and withholding a screenshot the model asked for would break the
 * calling turn for no security gain).
 */
export interface ToolResultContext {
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
  /** The tool's textual output, as the model would receive it. */
  readonly output: string;
}

/**
 * What an `onToolResult` hook may return. One outcome only, and it is a
 * restriction: `withhold` replaces the result the model sees with a
 * refusal text naming the extension and the reason. An extension cannot
 * rewrite, truncate or redact a result in place (a half-edited result is a
 * corrupted one), cannot turn a failure into a success, and cannot touch
 * permissions.
 *
 * Every registered hook runs; the first `withhold` wins and short-circuits
 * the rest, deterministically by registration order — unlike `onToolCall`
 * and `beforeTurn`, where the *decision* is exclusive. A hook error or
 * timeout is fail-open: one visible `extension_failed` and the original
 * result proceeds to the model.
 */
export interface ToolResultHookResult {
  /** Replace the result the model sees with a refusal-shaped text. */
  readonly withhold: { readonly reason: string };
}

/**
 * What an `onToolCall` hook may return. Restrict only — never a grant.
 *
 * - `veto` kills the call: it outranks user rules, defaults and every
 *   session mode (including yolo), and produces the standard denied
 *   `tool_result`.
 * - `ask` (ADR-0031, apiVersion 1.1) hands the call to the existing human
 *   consent flow. It is not a grant: it never writes a permission rule and
 *   the prompt it raises offers no "always" answer. In auto-accept it still
 *   reaches the user, in yolo it is ignored (yolo is sovereign — use `veto`
 *   for anything lethal), and headless it degrades to a denial.
 * - Both together are contradictory: `veto` wins.
 * - The first hook returning a decision wins, in registration order.
 */
export interface ToolCallHookResult {
  readonly veto?: true;
  readonly ask?: true;
  readonly reason?: string;
}

/** One structured record an extension may append to the session log. */
export interface ExtensionEventInput {
  /** Short machine-readable name (e.g. `jev_judgment`). */
  readonly name: string;
  /** JSON-serializable, ≤ 8 KiB once serialized. */
  readonly payload?: unknown;
}

export interface EventContext {
  readonly event: ExtensionEvent;
}

/**
 * A client command addressed to one extension (ADR-0038, apiVersion 1.3).
 * The core carries it opaquely; the runtime delivers it to the named
 * extension's `onEvent` hooks alone, and only to that extension.
 */
export interface ExtensionControlEvent {
  readonly type: "extension_control";
  /** The addressed extension's own name. */
  readonly extension: string;
  /** JSON-serializable command payload; its meaning is yours. */
  readonly payload: Record<string, unknown>;
}

export interface AfterTurnContext {
  readonly result: { readonly status: string; readonly reason?: string; readonly message?: string };
}

export type SessionStartHook = (ctx: SessionStartContext) => void | Promise<void>;
export type SessionEndHook = (ctx: SessionEndContext) => void | Promise<void>;
export type BeforeTurnHook = (ctx: BeforeTurnContext) => BeforeTurnResult | void | Promise<BeforeTurnResult | void>;
export type BeforeModelCallHook = (ctx: BeforeModelCallContext) => void | Promise<void>;
export type ToolCallHook = (ctx: ToolCallContext) => ToolCallHookResult | void | Promise<ToolCallHookResult | void>;
export type ToolResultHook = (ctx: ToolResultContext) => ToolResultHookResult | void | Promise<ToolResultHookResult | void>;
export type EventHook = (ctx: EventContext) => void | Promise<void>;
export type AfterTurnHook = (ctx: AfterTurnContext) => void | Promise<void>;

/** npm dependencies the extension wants installed by moh (not bundled). */
export type ExtensionDependencies = string[];

/**
 * The setup context injected into `setup(ctx)`. `state` is a per-extension
 * key/value store preserved across hot-reloads.
 */
export interface ExtensionSetupContext {
  /** Per-extension durable state; carried over hot-reloads. */
  readonly state: Record<string, unknown>;
  /** Append a note to the trailing `extension_notes` prompt section. */
  appendToPrompt(note: string): void;
  /**
   * Record a structured chrome event in the session log (ADR-0032). The
   * runtime stamps the emitting extension: an extension never names itself
   * and can never impersonate another. The payload must be JSON-serializable
   * and within 8 KiB — a non-serializable or oversized payload is dropped
   * (never truncated) with a visible `extension_failed`. Volume is capped at
   * 50 events per extension per turn. Observation only: never permissions,
   * never model context.
   */
  appendEvent(event: ExtensionEventInput): void;
  /**
   * Publish this extension's footer status (ADR-0032); `null` clears it.
   * One status per extension, replaced on each call, ephemeral (never
   * logged, cleared at session end and on reload). In headless the first
   * publish writes one stderr line; the exit code is never affected.
   */
  setStatus(text: string | null): void;
  onSessionStart(hook: SessionStartHook): void;
  onSessionEnd(hook: SessionEndHook): void;
  /**
   * Turn-start decision point (ADR-0033, apiVersion 1.2): fires once per
   * user send, before the turn's provider is read and before anything is
   * logged. First hook returning a field wins, in registration order.
   */
  beforeTurn(hook: BeforeTurnHook): void;
  beforeModelCall(hook: BeforeModelCallHook): void;
  onToolCall(hook: ToolCallHook): void;
  /**
   * Inspect a tool result before it reaches the model (ADR-0034, apiVersion
   * 1.4), scoped to the tool names you declare — `ctx.onToolResult(["fetch",
   * "browser"], hook)`. The hook runs after the call settled and before the
   * `tool_result` event is appended, so the withheld text is what the log
   * holds and what the model saw. An empty list registers nothing: the
   * scope is explicit, never "every tool".
   */
  onToolResult(tools: readonly string[], hook: ToolResultHook): void;
  onEvent(hook: EventHook): void;
  afterTurn(hook: AfterTurnHook): void;
}

export interface ExtensionDefinition {
  /** Unique extension name. */
  readonly name: string;
  /** Extension version (semver-ish string; free-form in v1). */
  readonly version: string;
  /** moh extension apiVersion ("major.minor"); major must match. */
  readonly apiVersion: string;
  /** npm specs moh installs for the extension, with per-change authorization. */
  readonly dependencies?: ExtensionDependencies;
  setup(ctx: ExtensionSetupContext): void | Promise<void>;
}

/**
 * Identity function tagging an extension definition. The runtime loads the
 * module's default export and validates it structurally.
 */
export function defineExtension(def: ExtensionDefinition): ExtensionDefinition {
  return def;
}

/** Parse "major.minor" into [major, minor]; null when malformed. */
export function parseApiVersion(v: string): { major: number; minor: number } | null {
  const m = /^(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}
