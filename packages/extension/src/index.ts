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
 *
 * Also under 1.4 (ADR-0035): `onCompaction` — a compaction-time section
 * filter the runner consults before rendering the summarized transcript.
 * It can only *remove* material from a summary's input, never add,
 * rewrite or reorder; user messages and chrome are structurally absent
 * from what it sees, and the core enforces a survival floor. An older
 * runtime never calls it — compaction proceeds exactly as before.
 *
 * 1.5 (ADR-0036): `setPromptNote` — one per-turn prompt note per
 * extension, replacing, auto-cleared at each turn start; rendered in the
 * `turn_notes` section after the durable extension notes. An older
 * runtime never surfaces it (the note is silently absent), which is a
 * no-op for the extension.
 *
 * 1.6 (ADR-0037): `requestTurn` — a core-mediated synthetic turn. The
 * extension supplies text only; the core runs the turn through the normal
 * path, marks it `synthetic` in the log, skips the `beforeTurn` hooks and
 * enforces a hard cap of 2 consecutive synthetic turns. An older runtime
 * leaves the method absent: a caller that checks resolves `false` (the
 * same answer as a refusal), never an error.
 *
 * 1.7 (#852): `endpointCooldowns` on the `beforeTurn` context — the route
 * chain stops the serving provider knows it cannot use right now. An
 * older runtime simply does not send it (an empty list, the safe default).
 *
 * 1.8 (#944, ADR-0047): `session` on the `beforeTurn` context — the
 * identity of the session whose turn this is. A subagent child runs its
 * turns through its parent's runtime, so an extension that keeps
 * per-session state (a streak, an expectation, a manual override) MUST
 * key it by this identity: a single shared bag would let a child's turns
 * advance the parent's state. An older runtime does not send it, which
 * reads as "one session" — the pre-#944 behavior.
 *
 * 1.9 (#979, ADR-0035 amendment): `hookTimeoutMs` and `signal` on the
 * `onCompaction` context, and the `applied: false` outcome on the
 * `onApplied` callback. The window and the signal are the hook's own
 * budget: work that scales with the covered span (one call per section,
 * for instance) must fit inside the window, and the signal fires when the
 * runtime gives up waiting so the hook can stop working instead of
 * burning calls nobody will read. `onApplied` is then still called — with
 * `applied: false` — so the extension can record the honest outcome
 * ("the cut was never applied") instead of staying silent about a
 * judgment it made. An older runtime neither sends the window nor the
 * signal, and only ever calls `onApplied` for a cut it really applied.
 *
 * 1.10 (#1109, ADR-0059): the `onModelError` hook — the retry-on-error
 * decision point. Fired once per failed provider call whose error kind is
 * not Route-handled (quota, rate limit, network, overload): a hook may
 * propose an alternative model ref, which the core validates through the
 * same guards as any switch and retries the call on within the same turn.
 * No answer keeps the historical behavior (the turn ends with the error).
 *
 * 1.11 (#1130, ADR-0062): `registerCommand` — the `contribute-commands`
 * capability slot. The method exists on the setup context ONLY when the
 * grant covers the slot (manifest authority, or the code's own declared
 * capabilities when no manifest exists): enforcement by absence, so a
 * caller that checks finds `undefined` and never an error. A registration
 * that collides with a reserved or already-taken command name is refused
 * visibly and reported; commands return their own text output, which is
 * the same output the headless door prints — never a second behavior.
 *
 * 1.12 (#1132, ADR-0062): `registerPanel` and `registerOverlay` — the
 * `contribute-panels` / `contribute-overlays` capability slots. The
 * methods exist on the setup context ONLY when the grant covers the slot.
 * One panel per extension, at most 4 visible across all extensions: the
 * fifth registration is refused visibly at load and there is no automatic
 * eviction — collapsing and reopening is manual from `/extensions`. The
 * render returns arbitrary Ink elements the client draws in the rail
 * zone (panels) or full-screen (overlays, opened by the extension's
 * command and closed with `Esc`); the core carries them opaquely, and a
 * headless client contributes nothing — visible absence, never a mock.
 */

/**
 * The apiVersion this build of moh speaks. Format: "major.minor".
 * Minor bumps are additive (new optional hooks/fields); major bumps are
 * breaking and refuse to load older/newer extensions.
 */
export const MOH_EXTENSION_API_VERSION = "1.14";

/** One spawn an orchestration extension requests (ADR-0055, apiVersion 1.13).
 * `preset` resolves against the host's subagent presets (built-ins and
 * moh.json `agents`); the other fields override the preset exactly like the
 * model-facing spawn tool. */
export interface ExtensionSpawnSpec {
  /** Preset name; inline fields override it. */
  readonly preset?: string;
  /** Display name when no preset is used. */
  readonly name?: string;
  /** The task — the child's first user message. */
  readonly task: string;
  /** Role prompt (no preset). */
  readonly systemPrompt?: string;
  /** Strict subset of the host session's tools; MCP tools are never
   * inherited and a name the session does not have refuses the spawn. */
  readonly allowedTools?: readonly string[];
  /** Per-turn iteration cap for the child; above the envelope's ceiling
   * the spawn is refused, never silently narrowed. */
  readonly maxIterations?: number;
}

/** The settled outcome of one extension spawn (apiVersion 1.13). */
export interface ExtensionSpawnResult {
  /** The child's callId — the same id `subagent_spawn` recorded. */
  readonly callId: string;
  readonly status: "done" | "error" | "cancelled";
  /** The child's final assistant text (empty unless done). */
  readonly output: string;
  /** Present when status is "error". */
  readonly error?: string;
}

/** Bounded activity of one child this extension spawned (apiVersion 1.13):
 * the child-tail shape's activity — never the provider reasoning. */
export interface ExtensionSubagentActivity {
  /** The tool currently in flight, when one is. */
  readonly currentTool: string | null;
  /** Monotonic ms timestamp of the child log's last appended event. */
  readonly lastActivityAt: number | null;
}

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
  /**
   * #852: the route chain stops currently in a failure cooldown (quota
   * exhausted, rate limit, empty completion, ...) — endpoint refs the
   * serving provider already knows it cannot use. Absent when the session
   * runs a non-route provider or an older runtime. A hook that switches
   * models must never name one of these.
   */
  readonly endpointCooldowns?: readonly { ref: string; kind: string }[];
  /**
   * #944: which session this turn belongs to. Opaque and stable for the
   * lifetime of the session instance; `owner` is true for the session
   * that registered these hooks, false for a session that borrowed the
   * runtime — a subagent child, whose turns run through its parent's
   * runtime.
   *
   * **Key per-session state by `id`.** The runtime is one object shared
   * by the parent and every child it spawns, so state parked in the
   * extension's own `ctx.state` bag (or in a closure created at setup) is
   * shared too: a child's turns would advance the parent's streak, set
   * the parent's expectation and announce switches the parent never made
   * (#944). Absent on a runtime older than apiVersion 1.8: read that as
   * "one session" — the behavior before #944.
   */
  readonly session?: {
    readonly id: string;
    readonly owner: boolean;
  };
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

/**
 * The model-error context (ADR-0059, apiVersion 1.10): what an
 * `onModelError` hook sees when a provider call failed with an error the
 * Route does not already handle. The facts of the failure only — the
 * sanitized message, never raw transport detail.
 */
export interface ModelErrorContext {
  /** The model ref that was serving the failed call. */
  readonly model: string;
  /** The normalized ProviderError kind (e.g. `context_length`, `auth`, `content_filtered`). */
  readonly errorKind: string;
  /** The sanitized failure message. */
  readonly message: string;
  /**
   * #852/#1110: the route chain stops currently in a failure cooldown —
   * the same list `beforeTurn` carries, read at the moment of the failure.
   * A hook that proposes an alternative must never name one of these.
   * Absent when the session runs a non-route provider or an older runtime.
   */
  readonly endpointCooldowns?: readonly { ref: string; kind: string }[];
  /**
   * #944: which session owns the failed call (same shape and contract as
   * on `beforeTurn` — key per-session state by `id`).
   */
  readonly session?: {
    readonly id: string;
    readonly owner: boolean;
  };
}

/**
 * What an `onModelError` hook may return (ADR-0059). Proposal only, per
 * the restrict-only precedent: `model` is an *alternative existing* model
 * ref the core should retry the failed call on. The core validates it
 * through the same guards as any manual switch (resolution, context fit —
 * a fit refusal records `switch_refused` and no retry happens on that
 * ref); it can never grant anything or invent a model. No answer (void)
 * keeps the historical behavior: the turn ends with the error.
 */
export interface ModelErrorResult {
  /** Alternative model ref to retry the failed call on (resolved like `/model`). */
  readonly model?: string;
}

export type ModelErrorHook = (
  ctx: ModelErrorContext,
) => ModelErrorResult | void | Promise<ModelErrorResult | void>;

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

/**
 * ADR-0035: one droppable section of the covered compaction span — one
 * user turn's **body** (the assistant work and tool traffic that followed
 * the message). The user's own message is never a section, and neither is
 * any chrome event: the extension cannot name what it is never offered.
 */
export interface CompactionSection {
  /** Opaque id, core-assigned; the only handle a drop may name. */
  readonly id: string;
  /** Dominant content of this turn's body. */
  readonly kind: "assistant" | "tool_result" | "tool_call";
  /** Serialized size of the section. */
  readonly bytes: number;
  /** Short preview, capped by the core (~200 chars). */
  readonly preview: string;
}

/** ADR-0035: what the `onCompaction` hook sees. */
export interface CompactionHookContext {
  /** The droppable sections, in transcript order. */
  readonly sections: readonly CompactionSection[];
  /** Token estimate of the covered span, when known. */
  readonly approxTokens?: number;
  /**
   * #979, apiVersion 1.9: the millisecond window the runtime waits for this
   * hook's answer, starting at the call. A hook whose work scales with the
   * span (one call per section, say) must fit its own deadline inside it:
   * a hook still running when the window closes is abandoned — its drops
   * are discarded and its `signal` is aborted. Absent on a runtime older
   * than 1.9: budget yourself conservatively (the runtime's default is
   * 5 s).
   */
  readonly hookTimeoutMs?: number;
  /**
   * #979, apiVersion 1.9: aborted when the runtime stops waiting for this
   * hook — the same instant, one event later, as the abandoned dispatch.
   * Pass it to whatever you call per section so an abandoned hook *stops
   * working* instead of spending calls nobody will read; sections it never
   * got to are simply unjudged. Absent on a runtime older than 1.9 (the
   * hook cannot be cancelled: keep the work inside `hookTimeoutMs`).
   */
  readonly signal?: AbortSignal;
}

/** ADR-0035: how the core reports a hook's cut back to its author. */
export interface AppliedCut {
  /** True when the survival floor reduced the requested drops. */
  readonly keptByFloor: boolean;
  /** Serialized bytes of the offered text that survive the cut. */
  readonly bytesAfter: number;
  /**
   * The ids actually left out of the transcript, after the floor — the
   * truth to record, as opposed to the `drop` the hook requested (the floor
   * restores the smallest claims, so the two differ whenever it bites).
   * Empty when the dispatch was abandoned: nothing was dropped at all.
   * apiVersion 1.9 (#979); absent on a runtime older than 1.9, where `drop`
   * is the only answer available.
   */
  readonly droppedIds?: readonly string[];
  /**
   * #979, apiVersion 1.9: `false` when the core did not apply this cut at
   * all — the hook answered too late and the dispatch had already given up.
   * Absent (and `true`) mean the core did apply the cut; only the fields
   * above describe how.
   */
  readonly applied?: boolean;
}

/**
 * ADR-0035: what an `onCompaction` hook may return. `drop` names ids of
 * sections to exclude from the summarized transcript. Ids the core did
 * not offer are ignored with a visible `extension_failed
 * { reason: "unknown_section" }`; the core enforces a survival floor of
 * at least 60% of the droppable text regardless of what is returned.
 * `onApplied`, when present, is called back exactly once with the cut as
 * actually applied — after the floor, before the transcript renders — so
 * the extension can record what really happened, not just what it asked
 * for. apiVersion 1.9 (#979): it is *also* called when the dispatch was
 * abandoned (the hook answered after the window closed), with
 * `applied: false` — the cut reached nothing, and the honest record says
 * so. A throwing `onApplied` is swallowed: observability never breaks the
 * compaction it describes.
 */
export interface CompactionHookResult {
  readonly drop: readonly string[];
  readonly onApplied?: (applied: AppliedCut) => void;
}

export type CompactionHook = (
  ctx: CompactionHookContext,
) => CompactionHookResult | void | Promise<CompactionHookResult | void>;

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
 * The context of one extension-command invocation (ADR-0062,
 * apiVersion 1.11): the arguments the user typed after the command name,
 * verbatim. Commands return their output text — the same text every
 * client shows, TUI toast or headless JSONL — so there is exactly one
 * behavior per command.
 */
export interface ExtensionCommandContext {
  readonly args: string;
}

/** One slash command an extension contributes (ADR-0062). */
export interface ExtensionCommand {
  /** The slash name, without the leading `/`: lowercase letters, digits
   * and hyphens (`/deploy-status`). */
  readonly name: string;
  /** One line shown in the command completion and `/extensions`. */
  readonly description?: string;
  /** Runs the command; the returned text is the command's whole output. */
  run(ctx: ExtensionCommandContext): string | Promise<string>;
}

/**
 * One panel in the extensions rail (ADR-0062, apiVersion 1.12). The
 * render returns arbitrary Ink elements — the client renders them inside
 * the rail zone untouched, never wrapping native components.
 */
export interface ExtensionPanel {
  /** The panel name, letters/digits/hyphens; shown in `/extensions`. */
  readonly name: string;
  /** One line shown in `/extensions`. */
  readonly description?: string;
  /** Maximum height in terminal rows the rail allots this panel; the
   * client clamps to it and to the rail's own budget. */
  readonly maxHeight?: number;
  /** Renders the panel content. Pure per call: the client may call it
   * every frame. Callbacks inside the returned elements reach the session
   * only through the existing gated seams — never a second path. */
  render(): unknown;
}

/** One full-screen overlay (ADR-0062, apiVersion 1.12): opened by the
 * extension's own command, closed by the user with `Esc`. */
export interface ExtensionOverlay {
  readonly name: string;
  readonly description?: string;
  /** Renders the overlay content full-screen; pure per call. */
  render(): unknown;
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
  /**
   * ADR-0037, apiVersion 1.6: true when this settle is a synthetic turn
   * the extension itself requested through `requestTurn`. Skip your own
   * end-of-turn logic for it — re-entering on your own correction turn
   * is how correction chains are born.
   */
  readonly synthetic?: boolean;
}

export type SessionStartHook = (ctx: SessionStartContext) => void | Promise<void>;
export type SessionEndHook = (ctx: SessionEndContext) => void | Promise<void>;
export type BeforeTurnHook = (ctx: BeforeTurnContext) => BeforeTurnResult | void | Promise<BeforeTurnResult | void>;
/**
 * ADR-0054: what a `beforeModelCall` hook may return — prompt-section
 * replacements, `null` meaning hidden. The return is judged against the
 * 5 s replacement window (ADR-0056 owns the deadline composition); the
 * core applies only sections the extension's declared capability covers —
 * one capability slot per section, `replace-prompt-section:<name>`, and
 * only the six data sections (`environment`, `tools`, `skills`, `memory`,
 * `session_state`, `mpm`) are replaceable at all; `base` and the note
 * sections never are. A replacement outside the grant is refused at
 * runtime, visibly, and the core's text stands for that call (ADR-0054).
 */
export interface BeforeModelCallResult {
  sections?: Partial<Record<string, string | null>>;
}

export type BeforeModelCallHook = (
  ctx: BeforeModelCallContext,
) => BeforeModelCallResult | void | Promise<BeforeModelCallResult | void>;
export type ToolCallHook = (ctx: ToolCallContext) => ToolCallHookResult | void | Promise<ToolCallHookResult | void>;
export type ToolResultHook = (ctx: ToolResultContext) => ToolResultHookResult | void | Promise<ToolResultHookResult | void>;
export type EventHook = (ctx: EventContext) => void | Promise<void>;
export type AfterTurnHook = (ctx: AfterTurnContext) => void | Promise<void>;

/** npm dependencies the extension wants installed by moh (not bundled). */
export type ExtensionDependencies = string[];

/**
 * ADR-0064: the typed result of one host-performed operation. A policy
 * refusal is a normal outcome — `{ ok: false, reason: "outside_scope" }`
 * — never an exception and never an `extension_failed` (refusals are
 * recorded as their own `host_refused` log event by the host).
 */
export interface HostOpSuccess {
  ok: true;
  /** The resolved (real) path the host actually touched. */
  resolved: string;
  /** Content bytes touched, present when the operation wrote content. */
  bytes?: number;
}

export type HostOpResult =
  | HostOpSuccess
  | { ok: false; reason: "outside_scope" | "invalid_path" | "denied" | "failed"; resolved?: string; message?: string };

export type HostReadResult = HostOpResult & { content?: string };

export type HostReadLinkResult = HostOpResult & { target?: string };

/**
 * ADR-0066: the typed result of one `host.fetch`. A response is fully
 * buffered bytes — never streamed — with a fixed size limit; oversize is
 * `{ ok: false, reason: "too_large" }`. A redirect hop outside the
 * allowlist is `{ ok: false, reason: "outside_scope", target }` where
 * `target` names the host the redirect pointed at.
 */
export interface HostFetchSuccess {
  ok: true;
  /** The final response status after any same-allowlist redirects. */
  status: number;
  /** The fully buffered response body. */
  bytes: Uint8Array;
  /** The host:port the response actually came from (redirects may stay in scope). */
  finalHost: string;
}

export type HostFetchResult =
  | HostFetchSuccess
  | { ok: false; reason: "outside_scope" | "invalid_url" | "unknown_credential" | "denied" | "too_large" | "failed"; target?: string; message?: string };

/**
 * ADR-0067: the typed result of one `ctx.host.runTool`. The tool ran (or
 * was refused) through moh's normal runner and gate — a gate refusal
 * (user rule, denied ask, headless) is `{ ok: false, reason: "denied" }`,
 * never an exception; a tool the session does not register is
 * `{ ok: false, reason: "unknown_tool" }`.
 */
export interface HostRunToolSuccess {
  ok: true;
  /** The tool's textual output, exactly what a model-initiated call returns. */
  output: string;
}

export type HostRunToolResult =
  | HostRunToolSuccess
  | { ok: false; reason: "outside_scope" | "unknown_tool" | "denied" | "failed"; message?: string };

/**
 * #1162: what one `ctx.host.fetch` may ask for. The seam's first consumer
 * with a request body (Jev's TypeSafe POST) grew the request side from the
 * anonymous GET ADR-0066 shipped — same scope rules, same buffered
 * response, same log event. `method` is GET (default) or POST; a `body` is
 * allowed only with POST and is capped by the same fixed byte limit the
 * response is; `contentType` defaults to `application/json` when a body is
 * present. `signal` aborts the request host-side (the extension composes
 * its own deadline into it).
 */
export interface HostFetchOptions {
  /** ADR-0069: resolve this ref and inject it as the request's bearer. */
  credential?: string;
  /** GET (default) or POST. */
  method?: "GET" | "POST";
  /** The request body — POST only, byte-capped like the response. */
  body?: string | Uint8Array;
  /** Request content type; default `application/json` when a body is set. */
  contentType?: string;
  /** Aborts the in-flight request host-side. */
  signal?: AbortSignal;
}


/**
 * ADR-0064 + ADR-0065: the host-performs seam. **Present only when the
 * enable consent covers at least one scope** (enforcement by absence;
 * check with `typeof ctx.host === "object"`). Every method is one ask the
 * host performs itself under the granted `path:<glob>` scopes — one grant
 * covers the whole file family; there is no read/write split. The user's
 * deny rules beat the grant per call. No OS sandbox: consent is the whole
 * boundary, and the scope constrains requests to the seam, not extension
 * code. Every performed operation lands in the log as `host_op` with the
 * resolved path; every refusal as `host_refused`.
 */
export interface ExtensionHost {
  readFile(path: string): Promise<HostReadResult>;
  writeFile(path: string, content: string): Promise<HostOpResult>;
  appendFile(path: string, content: string): Promise<HostOpResult>;
  rename(from: string, to: string): Promise<HostOpResult>;
  /** Deletes one file or one empty directory. */
  delete(path: string): Promise<HostOpResult>;
  /** Reads the target of one symlink (the target itself must be in scope). */
  readlink(path: string): Promise<HostReadLinkResult>;
  /**
   * ADR-0066: asks the host to make one https (https-implicit) request to
   * a host covered by a granted `host:<domain>` scope. Every redirect hop
   * is re-checked against the allowlist; the response is fully buffered
   * bytes with a fixed size limit; no streaming. An authenticated request
   * passes `credential: "<ref>"` and needs the matching `credential:<ref>`
   * scope granted too; the host resolves the ref and injects the value
   * itself — the value never crosses the seam, and no read-the-value API
   * exists (ADR-0069).
   *
   * #1162: the request side — `method` (GET default, POST), `body`
   * (POST-only, capped like the response), `contentType` (default
   * `application/json` with a body) and `signal` (host-side abort).
   */
  fetch(url: string, options?: HostFetchOptions): Promise<HostFetchResult>;
  /**
   * ADR-0067: asks the host to run one registered session tool through
   * the normal ToolRunner and PermissionGate — the model's exact gate
   * path (veto > user rules > mode); an ask names this extension as the
   * requester. Whole-tool grant: a `tool:<name>` capability authorizes
   * the tool entire, no argv sub-scoping; the user's rules decide each
   * call. `tool:*` covers every session tool, built-in and MCP.
   */
  runTool(name: string, args: unknown): Promise<HostRunToolResult>;
}

/**
 * The setup context injected into `setup(ctx)`. `state` is a per-extension
 * key/value store preserved across hot-reloads.
 */
export interface ExtensionSetupContext {
  /** Per-extension durable state; carried over hot-reloads. */
  readonly state: Record<string, unknown>;
  /**
   * ADR-0064 + ADR-0065 (apiVersion 1.13): the host-performs seam.
   * **Present only when the enable consent covers at least one scope**
   * (enforcement by absence, like `registerCommand`) — check with
   * `typeof ctx.host === "object"`. See `ExtensionHost`.
   */
  readonly host?: ExtensionHost;
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
   * Set this extension's prompt note for the current turn (ADR-0036,
   * apiVersion 1.5); `null` removes it. One note per extension, replacing:
   * a second call overwrites the first. The note is ephemeral — the core
   * clears every turn note at the start of the next turn, so an extension
   * that wants a note writes it every turn. It renders in the dedicated
   * `turn_notes` section, after the project's instruction documents and
   * before the conversation context; oversized notes are truncated by the
   * core with a marker. Observation and suggestion only — never a
   * permission, never a way to touch the system prompt, the project
   * instructions, or another extension's note.
   */
  setPromptNote(text: string | null): void;
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
  /** ADR-0059: propose an alternative model ref after a non-Route provider failure. */
  onModelError(hook: ModelErrorHook): void;
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
  /**
   * Compaction-time section filter (ADR-0035, apiVersion 1.4): consulted
   * by the compaction runner before the summarized transcript is rendered.
   * The hook may only name sections to drop; a failure or a timeout
   * contributes no drops (compaction proceeds exactly as today) and the
   * core enforces the survival floor. Scope: compaction only — the hook
   * never sees or touches the live conversation.
   */
  onCompaction(hook: CompactionHook): void;
  /**
   * Contribute a slash command (ADR-0062, apiVersion 1.11). **Present only
   * when the `contribute-commands` capability is granted** — without the
   * grant the property does not exist on the context (enforcement by
   * absence; check with `typeof ctx.registerCommand === "function"`).
   * Collisions are resolved native > skills > extension: a command whose
   * name is reserved by the client's native commands or skills, or taken
   * by another extension, is refused visibly and reported in `/extensions`
   * — the extension itself is not failed. The command's returned text is
   * its output in every client; nothing else is invented around it.
   */
  registerCommand?(command: ExtensionCommand): void;
  /**
   * Contribute one panel to the extensions rail (ADR-0062, apiVersion
   * 1.12). **Present only when the `contribute-panels` capability is
   * granted** (enforcement by absence). One panel per extension: a second
   * registration from the same extension is refused visibly. At most 4
   * panels are visible across all extensions — the fifth is refused at
   * load (`panel slot exhausted (4/4)`); there is no automatic eviction,
   * collapsing and reopening is manual from `/extensions`. The `render`
   * returns arbitrary Ink elements the client renders inside the rail —
   * opaque to the core; a callback inside them reaches the session only
   * through the existing gated seams (`requestTurn`, control events), so
   * a permission-gated action always flows through the normal gate.
   */
  registerPanel?(panel: ExtensionPanel): void;
  /**
   * Contribute a full-screen overlay (ADR-0062, apiVersion 1.12).
   * **Present only when the `contribute-overlays` capability is granted**
   * (enforcement by absence). The returned `open()` asks the client to
   * show the overlay full-screen; the user closes it with `Esc`. In a
   * client with no surface (headless), `open()` contributes nothing —
   * visible absence, never a simulated rendering.
   */
  registerOverlay?(overlay: ExtensionOverlay): { open(): void };
  onEvent(hook: EventHook): void;
  afterTurn(hook: AfterTurnHook): void;
  /**
   * Spawn one subagent child session (ADR-0053 + ADR-0055, apiVersion
   * 1.13). **Present only when the `spawn-subagent` capability is
   * granted** (enforcement by absence; check with
   * `typeof ctx.spawnSubagent === "function"`).
   *
   * The enable consent granted an **envelope** — at most ten children per
   * extension per session, each within the session's own iteration
   * ceiling. Every request is intersected with that envelope at spawn
   * time: a request outside it is refused loudly (a visible
   * `extension_failed`, and the promise resolves with an error result —
   * the child is not created), never silently narrowed. What the task did
   * not name does not exist for the child, and a child can never hold
   * more than the session that spawned it.
   *
   * No grandchildren: called from inside a child's dispatch (a hook that
   * runs on a borrowed session), the spawn is refused. `subagentActivity`
   * reads only sessions this extension spawned, in the child-tail shape.
   * One stop — the owner's — aborts every child this extension started.
   */
  spawnSubagent?(spec: ExtensionSpawnSpec): Promise<ExtensionSpawnResult>;
  /**
   * Bounded turn-activity read (apiVersion 1.13) of one child this
   * extension spawned — messages, tool calls and outcomes, the turn's
   * outcome, status, usage-derived activity. **Present only when the
   * `spawn-subagent` capability is granted.** A callId this extension did
   * not spawn resolves to `null`: a session the extension did not create
   * does not exist for it, and there is no API that reads or resumes one.
   */
  subagentActivity?(callId: string): Promise<ExtensionSubagentActivity | null>;
  /**
   * Ask the core to run one turn with a synthetic user-side message
   * (ADR-0037, apiVersion 1.6). You supply the text — deterministic,
   * never model-generated; the core runs everything else through the
   * normal turn path (queue, provider call, streaming, tools, usage) and
   * marks the `user_message` `synthetic` so replay and the transcript can
   * tell it from a human-typed turn. The synthetic turn does not fire
   * `beforeTurn` (machine-composed text is never re-routed or re-checked)
   * and its tool calls are gated exactly like any other.
   *
   * The promise resolves when the requested turn settles — `true` when it
   * ran, `false` when the core refused it (the consecutive-synthetic-turn
   * cap of 2 is reached, a turn is already in flight, or the session is
   * disposed/closed). Refusals are also recorded as a visible
   * `extension_failed`-style event, never silently dropped. On a runtime
   * older than 1.6 the method is absent and calling it throws: check with
   * `typeof ctx.requestTurn === "function"` if you support older hosts.
   */
  requestTurn(text: string): Promise<boolean>;
}

export interface ExtensionDefinition {
  /** Unique extension name. */
  readonly name: string;
  /** Extension version (semver-ish string; free-form in v1). */
  readonly version: string;
  /** moh extension apiVersion ("major.minor"); major must match. */
  readonly apiVersion: string;
  /**
   * The capability slots this code uses (ADR-0053, as amended by ADR-0061).
   * The manifest is the authority the consent signs; at import the runtime
   * verifies every capability here is declared in `moh.extension.json` —
   * a superset is a loud refusal naming the offending slot, never a crash.
   */
  readonly capabilities?: readonly string[];
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
