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
 */

/**
 * The apiVersion this build of moh speaks. Format: "major.minor".
 * Minor bumps are additive (new optional hooks/fields); major bumps are
 * breaking and refuse to load older/newer extensions.
 */
export const MOH_EXTENSION_API_VERSION = "1.0";

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

export interface ToolCallContext {
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
}

/** What a `onToolCall` hook may return. Veto only — never a grant. */
export interface ToolCallHookResult {
  readonly veto: true;
  readonly reason?: string;
}

export interface EventContext {
  readonly event: ExtensionEvent;
}

export interface AfterTurnContext {
  readonly result: { readonly status: string; readonly reason?: string; readonly message?: string };
}

export type SessionStartHook = (ctx: SessionStartContext) => void | Promise<void>;
export type SessionEndHook = (ctx: SessionEndContext) => void | Promise<void>;
export type BeforeModelCallHook = (ctx: BeforeModelCallContext) => void | Promise<void>;
export type ToolCallHook = (ctx: ToolCallContext) => ToolCallHookResult | void | Promise<ToolCallHookResult | void>;
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
  onSessionStart(hook: SessionStartHook): void;
  onSessionEnd(hook: SessionEndHook): void;
  beforeModelCall(hook: BeforeModelCallHook): void;
  onToolCall(hook: ToolCallHook): void;
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
