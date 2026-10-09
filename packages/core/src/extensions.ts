/**
 * Extension runtime (#34): loads third-party extensions (modules
 * default-exporting `defineExtension(...)` from @moh/extension), enforces
 * the additive-only apiVersion policy, one-time enable consent, per-change
 * npm dependency authorization, and hot-reload with `ctx.state` preserved.
 *
 * Failure model: a failed load is a warning, never a session abort — the
 * runtime records `extension_loaded` / `extension_failed` events and the
 * session continues without the extension.
 */
import { existsSync, watch, type FSWatcher } from "node:fs";
import { appendFileSync, readFileSync, realpathSync, writeFileSync, mkdirSync, renameSync, rmSync, readlinkSync, statSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { rmdirSync } from "node:fs";
import {
  MOH_EXTENSION_API_VERSION,
  parseApiVersion,
  type ExtensionCommand,
  type ExtensionPanel,
  type ExtensionOverlay,
  type ExtensionDefinition,
  type ExtensionDependencies,
  type ExtensionSetupContext,
  type ExtensionHost,
  type HostOpResult,
  type HostReadResult,
  type HostReadLinkResult,
  type HostFetchResult,
  type HostRunToolResult,
  type HostModelCallRequest,
  type HostModelCallResult,
  type HostListModelsResult,
  type HostFetchOptions,
  type ExtensionContributedTool,
  type BeforeTurnHook,
  type BeforeModelCallHook,
  type BeforeModelCallResult,
  type ModelErrorHook,
  type ModelErrorResult,
  type EventHook,
  type ExtensionEvent,
  type ExtensionEventInput,
  type AfterTurnHook,
  type SessionEndHook,
  type SessionStartHook,
  type ToolCallHook,
  type ToolCallHookResult,
  type ToolResultHook,
  type ToolResultHookResult,
  type TurnConfirmOutcome,
  type AppliedCut,
  type CompactionHook,
  type CompactionHookContext,
  type CompactionHookResult,
} from "@moh/extension";
import type { BeforeTurnResult } from "@moh/extension";
import type { AgentEvent, ExtensionStatus, ThinkingLevel, TokenUsage } from "./types";
import type { ExtensionSpawnSpec, PanelKeyEvent } from "@moh/extension";
import type { SubagentHost } from "./subagents";
import { checkScope } from "./check-scope";
import { ExtensionSpawnRefusedError } from "./extension-scope";
import { capabilityDiff, capabilitiesSubset, readExtensionManifest, type ManifestAuthority } from "./extension-manifest";
import { depsTarballCache, extensionDepsDir, installExtensionDeps, linkDepsTree } from "./extension-deps";
import { realRegistryIo, type RegistryIo } from "./extension-registry";
import { hostScopesOf, isHostScope, isPathScope, MAX_FETCH_BYTES, MAX_REDIRECTS, HOST_SCOPE_REASONING_KEY, TOTAL_HOST_WILDCARD, validateHostScope, validatePathScope, pathScopesOf } from "./host-scope";
import { credentialScopesOf, isCredentialScope, validateCredentialScope, type CredentialStore } from "./credential-scope";
import { isToolScope, validateToolScope, toolScopesOf, isContributeToolScope, validateContributeToolScope, contributesTool, toolScopeName, contributeToolScopesOf, contributeToolName, CONTRIBUTE_TOOL_SCOPE_PREFIX } from "./tool-scope";
import { isEndpointScope, validateEndpointScope, endpointScopesOf } from "./endpoint-scope";
import { newUlid } from "./session/ulid";

type HostOpName = "read" | "write" | "append" | "rename" | "delete" | "readlink" | "fetch" | "run_tool" | "model_call" | "list_models";

/**
 * ADR-0067: the tool-execution seam the session binds — the host-side
 * half of `ctx.host.runTool`. The runtime owns scope + logging; the
 * session owns lookup, gate and execution (the normal ToolRunner path).
 */
export interface ToolSeam {
  runTool(request: { extension: string; tool: string; args: unknown }): Promise<
    | { ok: true; output: string }
    | { ok: false; reason: "unknown_tool" | "denied" | "failed"; message?: string }
  >;
}

/**
 * ADR-0068: the model-call seam the session binds — the host-side half
 * of `ctx.host.modelCall` and `ctx.host.listModels`. The runtime owns
 * scope + logging; the session owns endpoint resolution, the single-shot
 * Route execution, the thinking-capability check and usage accounting.
 * Credentials never cross this seam in either direction.
 */
export interface ModelSeam {
  modelCall(request: {
    extension: string;
    endpoint: string;
    model: string;
    messages: ReadonlyArray<{ role: "system" | "user" | "assistant"; content: string }>;
    thinkingLevel?: ThinkingLevel;
    signal?: AbortSignal;
  }): Promise<
    | { ok: true; text: string; usage: TokenUsage; model: string; thinkingLevel?: ThinkingLevel }
    | { ok: false; reason: "unknown_endpoint" | "unsupported_level" | "failed"; message?: string }
  >;
  listModels(request: { endpoint: string }): Promise<
    | { ok: true; models: string[] }
    | { ok: false; reason: "unknown_endpoint" | "failed"; message?: string }
  >;
}
import { redactKeys } from "./redact";
import { assertNoExtensionScope, runInExtensionScope } from "./extension-scope";

/**
 * ADR-0054 + ADR-0056 (#1126): what one `beforeModelCall` dispatch
 * produced. `replacements` are the section returns that beat the 5 s
 * window, in registration order — application (one-author-per-section,
 * capability checks, the provenance line, the `prompt_override` record)
 * belongs to the composer. `timeouts` names the hooks that lost a clock:
 * `"replacement"` (answered past 5 s but inside the ceiling — its other
 * contributions still count) or `"hook"` (never answered inside the
 * ceiling — it contributed nothing). `errors` are the fail-open
 * `extension_failed` records. Section keys are the composer's
 * `SectionName`s, typed loosely here so the runtime stays independent of
 * the composer's internals.
 */
export interface BeforeModelCallDispatch {
  readonly replacements: {
    by: string;
    /** The extension's version — the provenance line and the record name it. */
    version: string;
    /** The capabilities the code declared (#1129): what the applier judges
     * `replace-prompt-section:<section>` against. Already a subset of the
     * manifest (the load refuses otherwise), so a capability here is one
     * the user consented to. */
    capabilities: readonly string[];
    sections: Partial<Record<string, string | null>>;
  }[];
  readonly timeouts: { by: string; window: "replacement" | "hook" }[];
  readonly errors: AgentEvent[];
}

/**
 * ADR-0033: what one `beforeTurn` dispatch produced. `model`/`confirm` are
 * the first hook answers in registration order; `errors` are the
 * fail-open `extension_failed` records the caller appends to the log.
 * `onResolved` (ADR-0033 amendment) is the closure the asking extension
 * handed over: the caller invokes it once with the confirmation's outcome,
 * so the extension can record what happened to a turn that may leave no
 * `user_message` behind.
 */
export interface BeforeTurnDispatch {
  readonly model?: string;
  /** The extension that named the model (for the invalid-ref diagnostic). */
  readonly modelBy?: string;
  readonly confirm?: {
    readonly reason: string;
    readonly by: string;
    readonly onResolved?: (outcome: TurnConfirmOutcome) => void;
  };
  readonly errors: AgentEvent[];
}

/**
 * ADR-0034: what one `onToolResult` dispatch produced. `withheld` is the
 * refusal-shaped text that replaces the result the model sees (always
 * absent, or present with `by` naming the extension that withheld);
 * `errors` are the fail-open `extension_failed` records to append.
 */
export interface ToolResultDispatch {
  readonly withheld?: string;
  readonly by?: string;
  readonly errors: AgentEvent[];
}

/** #834: what a load asks the user about — enough to name the code that
 * wants to run. Its identity is its source bytes, not its claims, so a
 * first-time *file* is asked about BEFORE it is imported: importing is
 * executing, so the module's own name/version do not exist yet — and they
 * are the untrusted part anyway. */
export interface ExtensionConsentRequest {
  /** Absolute path of the module asking to run; absent for an in-memory definition. */
  file?: string;
  /** SHA-256 of the exact bytes about to run (file loads only) — the same
   * hash the stored grant is bound to, so the user can compare them. */
  hash?: string;
  /** The definition's self-declared name/version — present for an in-memory
   * registration and for a re-ask on an edited file (the previous instance
   * knows them); absent on a first-time file, where nothing has run yet. */
  name?: string;
  version?: string;
  /** The manifest's declared capabilities (ADR-0061): what the user is
   * being asked to grant. Present when a `moh.extension.json` was read —
   * which is every file load, since a file without one is refused before
   * this question exists. */
  capabilities?: readonly string[];
  /** The widening of a re-ask (ADR-0061): capabilities the new manifest
   * declares that the previously granted manifest did not. Empty or absent
   * means no new powers. */
  addedCapabilities?: readonly string[];
  /**
   * ADR-0066: the manifest's `reasoning` — the author's justification the
   * consent question displays (required for a total network wildcard
   * (`host:*`), shown for any manifest that declares one). Present only
   * when the manifest declares one.
   */
  reasoning?: string;
  /**
   * ADR-0070 (#1166): the extension's declared npm dependencies, by name
   * and version (`zod@3.23.8`) — present on a dependency authorization
   * ask, so the question shows exactly which new bytes the yes installs.
   */
  dependencies?: readonly string[];
}

export interface ExtensionRuntimeOptions {
  /** User-level moh dir. Consent + dependency approvals persist in `<mohHome>/extensions.json`. Default `~/.moh`. */
  mohHome?: string;
  /**
   * ADR-0065: the project root every `path:<glob>` scope resolves
   * against. Absent = `process.cwd()`. Set by session assembly.
   */
  projectRoot?: string;
  /**
   * ADR-0065: the user's per-call deny answer for a resolved absolute
   * path (the session binds its permission resolver here). A deny beats
   * every path grant per call; absent, no deny check runs.
   */
  isPathDenied?: (resolvedAbsPath: string) => boolean;
  /**
   * ADR-0066: the user's per-call deny answer for a request hostname.
   * A deny beats every `host:` grant per call; absent, no deny check
   * runs. Separate from `isPathDenied`: path rules never match hosts.
   */
  isHostDenied?: (hostname: string) => boolean;
  /**
   * ADR-0069: the credential store behind the `credential:<ref>` scope.
   * Injected by session assembly (OS keychain when available, the bounded
   * 0600-file fallback otherwise). The host resolves refs and injects the
   * values at request time; extension code never sees one. Absent, no
   * `credential:` grant can authenticate a request — every ref resolves
   * as unknown, loudly.
   */
  credentialStore?: CredentialStore;
  /**
   * One-time enable consent. Called only when no stored consent matches the
   * module's content identity, and — for a file — BEFORE the module is
   * imported, because importing it runs it. A `true` answer is persisted;
   * `false` refuses the load. When absent and nothing is stored, the load is
   * refused.
   */
  consent?: (request: ExtensionConsentRequest) => Promise<boolean> | boolean;
  /**
   * Per-change npm dependency authorization. Called whenever the
   * extension's dependency list differs from the remembered approved list.
   * `true` persists the new list; `false` refuses the load. When absent
   * and the list is non-empty and not approved, the load is refused.
   */
  authorizeDependencies?: (name: string, deps: ExtensionDependencies) => Promise<boolean> | boolean;
  /**
   * ADR-0070 (#1166): the IO seam behind the dependency installer
   * (network + tar). Defaults to the real registry IO; tests inject a
   * fake. The install itself is moh's: download + digest verification +
   * layout, never a script.
   */
  depsIo?: RegistryIo;
  /**
   * Non-event-log diagnostics: a load the user has to learn about on a
   * channel other than the log (a headless client's stderr, a hot-reload
   * outcome mid-session).
   */
  onWarning?: (message: string) => void;
  /**
   * ADR-0037: the session-mediated synthetic-turn entry the
   * `requestTurn` setup method delegates to. Present only when the host
   * session can run turns; its `false` answers are the contract's
   * refusals (depth cap, busy, disposed), which the runtime renders as a
   * visible `extension_failed` event.
   */
  requestTurn?: (text: string) => Promise<boolean>;
  /**
   * ADR-0056 (#1126): the wall-clock ceiling for every turn-path hook
   * invocation (`beforeTurn`, `beforeModelCall`, `onToolCall`,
   * `onToolResult`, `afterTurn`). Default 30 s. Expired or thrown, a
   * hook contributes nothing and the turn proceeds with one visible
   * `extension_failed` record. The compaction hook keeps its own shorter
   * window (#979) and is not governed by this ceiling.
   */
  hookTimeoutMs?: number;
  /**
   * ADR-0054: how long a `beforeModelCall` hook has to return its
   * prompt-section replacement before the core's own text wins for that
   * call. Default 5 s. The hook itself keeps running to the ceiling;
   * only the replacement is forfeit. Exposed as an option so tests (and
   * future clients) can shrink the clocks; the policy default never
   * changes silently.
   */
  replacementWindowMs?: number;
  /**
   * ADR-0062 (#1130): the slash names the client's own surfaces own — its
   * native commands plus every skill alias. An extension command colliding
   * with one is refused at registration (precedence: native > skills >
   * extension); the core cannot know these names itself, so the client
   * that assembles the session supplies them.
   */
  reservedCommandNames?: readonly string[];
}

/** `register` options: trust is a property of the code being registered,
 * not of the runtime that hosts it. */
export interface RegisterOptions {
  /** The host shipped these bytes (bundled first-party code): consent and
   * dependency authorization are skipped. Never for a path-loaded module. */
  bundled?: boolean;
  /**
   * ADR-0061: the manifest authority for an in-memory registration (a
   * bundled extension whose package ships `moh.extension.json`). When
   * present, the same subset rule applies: code capabilities not declared
   * here refuse the load. File loads derive their own manifest and never
   * need this.
   */
  manifest?: ManifestAuthority;
}

/**
 * #944 (ADR-0047): one session's hook dispatch through a runtime it does
 * not own — a subagent child running its turns through its parent's
 * runtime. `write` is where the events an extension appends during those
 * dispatches go: the child's own log, never the parent's channel.
 */
export interface SessionScope {
  /** The borrowing session's opaque identity (diagnostics, tests). */
  readonly id: string;
  /** Append one extension-produced event to the borrowing session's log. */
  write: (event: AgentEvent) => void;
  /**
   * Hook failures collected during this session's dispatches. Per dispatch
   * rather than per runtime for the same reason as `write`: two children
   * can be mid-dispatch at once, and a drain must never hand one child the
   * other's `extension_failed`.
   */
  errors: AgentEvent[];
}

interface HookSet {
  sessionStart: SessionStartHook[];
  sessionEnd: SessionEndHook[];
  beforeTurn: BeforeTurnHook[];
  beforeModelCall: BeforeModelCallHook[];
  /** ADR-0059: the retry-on-model-error decision point. */
  onModelError: ModelErrorHook[];
  onToolCall: ToolCallHook[];
  /** ADR-0034: post-tool inspection, scoped to the declared tool names. */
  onToolResult: { tools: readonly string[]; hook: ToolResultHook }[];
  /** ADR-0035: compaction-time section filter. */
  onCompaction: CompactionHook[];
  onEvent: EventHook[];
  afterTurn: AfterTurnHook[];
}

/** ADR-0037: the maximum consecutive synthetic turns one extension gets. */
export const MAX_CONSECUTIVE_SYNTHETIC_TURNS = 2;

/**
 * ADR-0056 (#1126): the default wall-clock ceiling for every turn-path
 * hook invocation. Generous on purpose — a slow-but-legitimate hook
 * (Jev's network round-trips) must fit; an extension that needs more
 * gets a larger ceiling from configuration.
 */
export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

/**
 * ADR-0054: the window a `beforeModelCall` hook has to return its
 * prompt-section replacement. Past it, the core's own text serves that
 * call and one visible record says so — but the hook's other
 * contributions (notes, statuses, side effects) still count, and the
 * hook itself keeps running to the ADR-0056 ceiling.
 */
export const PROMPT_REPLACEMENT_WINDOW_MS = 5_000;

/** One live extension instance inside the runtime. */
export interface RuntimeExtension {
  readonly def: ExtensionDefinition;
  /** Per-extension state, preserved across hot-reloads. */
  state: Record<string, unknown>;
  /** Prompt notes appended via `ctx.appendToPrompt`, in call order. */
  readonly notes: string[];
  /** ADR-0036: this instance's per-turn note; null = none. Ephemeral. */
  turnNote: string | null;
  readonly hooks: HookSet;
  /** Source file when loaded via `registerFile` (hot-reloadable). */
  readonly file?: string;
  /** ADR-0032: the extension's published footer status; null = none. Ephemeral. */
  status: string | null;
  /** ADR-0062 (#1130): slash commands this instance registered, in call order. */
  readonly commands: ExtensionCommand[];
  /** ADR-0062 (#1132): the one panel this instance registered (null = none). */
  panel: ExtensionPanel | null;
  /** ADR-0062 (#1132): overlays this instance registered, in call order. */
  readonly overlays: ExtensionOverlay[];
  /** ADR-0053: the capability slots actually granted to this instance —
   * the manifest when there is one, otherwise the code's own declaration. */
  grantedCapabilities: string[];
}

/** One refused extension-command registration (ADR-0062): reported in
 * `/extensions`, never silently dropped. */
export interface ExtensionCommandRefusal {
  readonly extension: string;
  readonly name: string;
  readonly reason: "reserved" | "taken" | "invalid";
}

/** One refused panel/overlay registration (ADR-0062, #1132): reported in
 * `/extensions`, never silently dropped. */
export interface ExtensionUIRefusal {
  readonly extension: string;
  readonly kind: "panel" | "overlay";
  readonly name: string;
  readonly reason: "exhausted" | "taken" | "invalid";
}

/** ADR-0062 (#1132): the capacity the rail allots panels — explicit, not
 * automatic: no eviction, collapse/reopen is manual from `/extensions`. */
export const MAX_PANELS = 4;

/** The overlay a client currently shows full-screen, when any. */
export interface ActiveExtensionOverlay {
  readonly extension: string;
  readonly name: string;
}

/** The `extension_loaded` payload for one instance: the registration
 * facts (ADR-0062 #1132) ride the load event, so the headless `/extensions`
 * fold reports panels and overlays with no second store. */
function loadedEvent(instance: RuntimeExtension): AgentEvent {
  const base: {
    type: "extension_loaded";
    name: string;
    version: string;
    panels?: string[];
    overlays?: string[];
    capabilities?: string[];
  } = {
    type: "extension_loaded",
    name: instance.def.name,
    version: instance.def.version,
  };
  if (instance.panel !== null) base.panels = [instance.panel.name];
  if (instance.overlays.length > 0) base.overlays = instance.overlays.map((o) => o.name);
  // ADR-0053: the startup announcement — each enabled extension's
  // capabilities ride its load event, so the session's start chrome
  // states what powers are in force.
  if (instance.grantedCapabilities.length > 0) base.capabilities = [...instance.grantedCapabilities];
  return base as AgentEvent;
}

/** The invocation outcome of one extension command (ADR-0062). */
export type ExtensionCommandResult =
  | { ok: true; extension: string; output: string }
  | { ok: false; error: string };

/**
 * #981: one session's ADR-0032 §3 accounting. It is keyed by *session*, not
 * by runtime: the runtime is shared by its owner and every subagent child
 * that borrows it (ADR-0047), and the pre-#981 instance-wide counters made a
 * child's `appendEvent`s spend its parent's turn budget — a flooding child
 * could disarm the parent for the rest of the parent's turn, and the child's
 * own budget was never reset at all (only the owner calls `beginTurn`).
 */
interface EventBudget {
  /** ADR-0032: this session's `extension_event`s in its current turn. */
  eventsThisTurn: number;
  /** ADR-0032: this session's per-turn cap warning was already emitted. */
  capWarned: boolean;
  /**
   * #846: this session's published status at the moment the cap tripped.
   * On cap, the runtime overlays the cap-degraded status; on the next
   * `setStatus` the overlay clears and the extension's own text re-emerges.
   * Null when no overlay is active for this session.
   */
  overlay: string | null;
}

interface ExtensionStore {
  /** `absolute-path:content-hash` -> true (one-time enable consent). */
  consents: Record<string, true>;
  /** `absolute-path:content-hash` -> approved dependency list. */
  dependencies: Record<string, ExtensionDependencies>;
  /** The manifest file's path -> the manifest the grant covers: its own
   * SHA-256 and the capabilities it declared. Keyed by manifest *path*
   * (not content identity): a widening edit usually edits the code too, so
   * the identity changes and only the path is stable across the diff
   * (ADR-0061). */
  manifests: Record<string, { hash: string; capabilities: string[] }>;
}

const EMPTY_HOOKS = (): HookSet => ({
  sessionStart: [],
  sessionEnd: [],
  beforeTurn: [],
  beforeModelCall: [],
  onModelError: [],
  onToolCall: [],
  onToolResult: [],
  onCompaction: [],
  onEvent: [],
  afterTurn: [],
});

function sameDeps(a: string[], b: string[]): boolean {
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.length === sb.length && sa.every((d, i) => d === sb[i]);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * ADR-0034 §5: the refusal-shaped text that replaces a withheld result.
 * The extension's own reason is rendered into it, so the model learns
 * *that* content was withheld, *by whom* and *why in one phrase* — and can
 * tell the user instead of retrying the same fetch. An indistinguishable
 * generic tool error would invite exactly the retry the guardrail exists
 * to prevent.
 */
export function withheldResultText(by: string, reason: string): string {
  return `external content withheld by ${by}: ${reason}`;
}

/**
 * ADR-0033 amendment: hands a confirmation's outcome back to the
 * extension that asked for it — the only channel through which it can
 * record what became of a turn that logs no `user_message`. A throwing
 * callback is swallowed: the extension's own record must never break the
 * turn it describes.
 */
export function resolveTurnConfirm(
  confirm: BeforeTurnDispatch["confirm"],
  outcome: TurnConfirmOutcome,
): void {
  try {
    confirm?.onResolved?.(outcome);
  } catch {
    /* observability only */
  }
}

/** ADR-0032 cap: extension events per extension, per session, per turn. */
const MAX_EVENTS_PER_TURN = 50;

/**
 * #981: the budget key of a runtime owner that has not named itself yet
 * (events appended before its first turn). Never a session id — those come
 * from `SessionScope.id` / `AgentSession`'s own opaque id.
 */
const OWNER_BUDGET = "\u0000owner";

/** ADR-0032 cap: serialized payload size. */
const MAX_PAYLOAD_BYTES = 8 * 1024;

/**
 * ADR-0053 (mask/alter log events): the log's chrome event names. An
 * `appendEvent` naming one is refused with `reserved_event_name` — an
 * extension record is always an `extension_event` naming its extension,
 * never a forged entry of the session's own record.
 */
const RESERVED_EVENT_NAMES: ReadonlySet<string> = new Set([
  "assistant_delta",
  "branch_dangling",
  "branch_switched",
  "browser_unavailable",
  "cancelled",
  "commercial_declaration",
  "compaction_dangling",
  "compaction_failed",
  "compaction_skipped",
  "compaction",
  "declared_window",
  "done",
  "error",
  "extension_control",
  "extension_event",
  "extension_failed",
  "extension_loaded",
  "fallback",
  "finish",
  "lane_created",
  "lane_transitioned",
  "log_integrity_warning",
  "mcp_refused",
  "mcp_server_failed",
  "mcp_server_started",
  "mcp_server_stopped",
  "memory_updated",
  "mention_warnings",
  "model_call_start",
  "model_call",
  "model_switched",
  "orchestration_stopped",
  "permission_denied",
  "permission_granted",
  "permission_requested",
  "permission_rule_added",
  "permission_rules_restored",
  "prompt_override",
  "quota_episode",
  "quota_observation",
  "reasoning_delta",
  "reasoning_end",
  "reasoning_start",
  "reasoning",
  "retro_digest",
  "retro_updated",
  "route_serving",
  "session_file_growth",
  "session_mode",
  "session_note",
  "session_pinned",
  "session_renamed",
  "session_resumed",
  "session_start",
  "skill_invoked",
  "subagent_result",
  "subagent_spawn",
  "switch_refused",
  "task_declared",
  "task_outcome",
  "task_verification",
  "text_delta",
  "tool_call",
  "tool_calls",
  "tool_progress",
  "tool_result",
  "tree_bookmarked",
  "usage",
  "user_message",
]);

/**
 * ADR-0032 redaction heuristic, now the shared module (ADR-0058, #1105):
 * the same key heuristic serves the session log writer — one heuristic,
 * not several. Still keys-only here: an extension payload is serialized
 * and byte-capped below, and the pass stays structural by contract.
 */
const redactPayload = redactKeys;

/**
 * The canonical path of a module: two spellings of one file (a symlink, a
 * symlinked parent directory) are one consent, one content identity and one
 * watcher — a user who approved a file must not be asked again because a
 * different route reached it. Falls back to the path as given when it does
 * not resolve (the load then fails with `load_failed`, as before).
 */
export function canonicalModulePath(file: string): string {
  const abs = isAbsolute(file) ? file : resolve(process.cwd(), file);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** File modules are consented by location and exact bytes, never self-claimed metadata. */
function contentIdentity(file: string | undefined): string | null {
  if (!file) return null;
  try {
    const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
    return `${canonicalModulePath(file)}:${hash}`;
  } catch {
    return null;
  }
}

/** The `sha256` half of a content identity, for display in the consent
 * question (a `memory:<name>` identity has no hash half). */
function identityHash(identity: string): string | undefined {
  const at = identity.lastIndexOf(":");
  if (at === -1) return undefined;
  const hash = identity.slice(at + 1);
  return /^[0-9a-f]{64}$/.test(hash) ? hash : undefined;
}

/** Cache-busted import returning the module's candidate definition. */
async function importDefinition(file: string): Promise<unknown> {
  // Bun busts the ESM cache on the query string (plain path form).
  const mod = (await import(`${file}?t=${Date.now()}-${Math.random()}`)) as { default?: unknown };
  return mod?.default ?? mod;
}

export class ExtensionRuntime {
  readonly #options: ExtensionRuntimeOptions;
  /** ADR-0056: the effective turn-path hook ceiling (ms). */
  readonly #hookTimeoutMs: number;
  /** ADR-0054: the prompt-section replacement window (ms). */
  readonly #replacementWindowMs: number;
  readonly #mohHome: string;
  readonly #instances: RuntimeExtension[] = [];
  /**
   * ADR-0062 (#1130): the slash names the client's own surfaces own — its
   * native commands plus every skill alias. Extension commands colliding
   * with one are refused at registration (precedence: native > skills >
   * extension); the core cannot know these names itself, so the client
   * that assembles the session supplies them.
   */
  readonly #reservedCommandNames: ReadonlySet<string>;
  /** ADR-0062 (#1130): refused command registrations, in refusal order. */
  readonly #commandRefusals: ExtensionCommandRefusal[] = [];
  /** ADR-0062 (#1132): refused panel/overlay registrations, in refusal order. */
  readonly #uiRefusals: ExtensionUIRefusal[] = [];
  /** ADR-0062 (#1132): the overlay a client currently shows, null = none. */
  #activeOverlay: ActiveExtensionOverlay | null = null;
  /** Overlay open() guard: only the extension whose command is currently
   * running may open its overlay; hooks and retained callbacks cannot.
   * #1143: async-context keyed — each `invokeCommand` chains its owner
   * through AsyncLocalStorage, so two interleaved invocations (a command
   * awaiting input while another starts) each keep their own guard,
   * however their promises interleave. */
  readonly #commandOwners = new AsyncLocalStorage<RuntimeExtension>();
  /** ADR-0062 (#1132): subscribers of overlay open requests. */
  readonly #overlayListeners = new Set<(overlay: ActiveExtensionOverlay) => void>();
  readonly #pending: AgentEvent[] = [];
  readonly #listeners = new Set<(event: AgentEvent) => void>();
  /**
   * #944: the session a hook dispatch runs on behalf of, when that session
   * is *not* the one that owns this runtime (a subagent child). Set for the
   * duration of its dispatches; absent everywhere else, which is the
   * owner's channel.
   */
  readonly #borrowedSessions = new AsyncLocalStorage<SessionScope>();
  /**
   * #981: per-instance, per-session turn accounting. Installed lazily for
   * the instances that actually append, dropped with the session that owns
   * the entry (`endBorrowedSession`) — never a per-session counter for an
   * extension that never records anything.
   */
  readonly #budgets = new WeakMap<RuntimeExtension, Map<string, EventBudget>>();
  /**
   * #981: the identity of the session that owns this runtime, learned at its
   * first turn (`beginTurn`). Null until then — the runtime's pre-turn
   * window is the owner's too, so it is counted under `OWNER_BUDGET` and
   * adopted (not duplicated) when the id arrives.
   */
  #ownerSessionId: string | null = null;
  /**
   * ADR-0053 + ADR-0055 (#998 follow-up): the execution seam behind the
   * `spawn-subagent` capability, attached by the session that owns its
   * SubagentHost. Extensions capture the ctx closure at setup (before any
   * session exists), so the seam is resolved lazily at call time; a call
   * with no attached host is refused loudly, never silently dropped.
   */
  #subagentHost: SubagentHost | null = null;
  /** ADR-0032: subscribers of status publishes (extension name + text|null). */
  readonly #statusListeners = new Set<(extension: string, text: string | null) => void>();
  readonly #watchers = new Map<string, FSWatcher>();
  readonly #reloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * ADR-0037: the consecutive-synthetic-turn counters, keyed by extension
   * name (not instance) — a hot-reload replaces the instance but must not
   * refill the correction budget: the depth limit is a core property, not
   * a promise (same principle as the compaction floor).
   */
  readonly #syntheticStreaks = new Map<string, number>();
  /**
   * In-flight registrations, as one chain: `ready()` awaits it and
   * `hasPendingRegistrations()` reads its count. A *counted* chain, not a
   * drained array — a drained queue would report "nothing pending" while an
   * import is still in flight, and a caller that gates on that answer (the
   * first turn) would run before the extension exists.
   */
  #pendingLoads: Promise<void> = Promise.resolve();
  #pendingLoadCount = 0;

  constructor(options: ExtensionRuntimeOptions = {}) {
    this.#options = options;
    this.#mohHome = options.mohHome ?? resolve(homedir(), ".moh");
    this.#hookTimeoutMs = options.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    this.#replacementWindowMs = options.replacementWindowMs ?? PROMPT_REPLACEMENT_WINDOW_MS;
    this.#reservedCommandNames = new Set((options.reservedCommandNames ?? []).map((n) => n.toLowerCase()));
  }

  /**
   * ADR-0062 (#1130): every registered extension command, in extension
   * registration then call order — what `/extensions` and the command
   * completion list.
   */
  extensionCommands(): { extension: string; name: string; description: string }[] {
    return this.#instances.flatMap((i) =>
      i.commands.map((c) => ({
        extension: i.def.name,
        name: c.name,
        description: typeof c.description === "string" && c.description.length > 0 ? c.description : `command by ${i.def.name}`,
      })),
    );
  }

  /** ADR-0062 (#1130): every refused command registration, with its reason. */
  commandRefusals(): readonly ExtensionCommandRefusal[] {
    return this.#commandRefusals;
  }

  /** ADR-0062 (#1132): every registered panel, in extension order — one
   * per extension (a second registration from the same extension is
   * refused). Empty without the grant or without registrations. */
  panels(): {
    extension: string;
    name: string;
    description: string;
    maxHeight?: number;
    render(): unknown;
    onKey?(input: string, key: PanelKeyEvent): boolean;
  }[] {
    return this.#instances
      .filter((i) => i.panel !== null)
      .map((i) => ({
        extension: i.def.name,
        name: i.panel!.name,
        description: typeof i.panel!.description === "string" && i.panel!.description.length > 0 ? i.panel!.description : `panel by ${i.def.name}`,
        ...(typeof i.panel!.maxHeight === "number" && i.panel!.maxHeight > 0 ? { maxHeight: i.panel!.maxHeight } : {}),
        render: () => i.panel!.render(),
        // apiVersion 1.17: the focused-key seam rides only when the panel
        // declared it — absence keeps the panel purely read-only.
        ...(typeof i.panel!.onKey === "function" ? { onKey: (input: string, key: PanelKeyEvent) => i.panel!.onKey!(input, key) } : {}),
      }));
  }

  /** ADR-0062 (#1132): every registered overlay, in extension then call order. */
  overlays(): { extension: string; name: string; description: string; render(): unknown }[] {
    return this.#instances.flatMap((i) =>
      i.overlays.map((o) => ({
        extension: i.def.name,
        name: o.name,
        description: typeof o.description === "string" && o.description.length > 0 ? o.description : `overlay by ${i.def.name}`,
        render: () => o.render(),
      })),
    );
  }

  /** ADR-0062 (#1132): every refused panel/overlay registration, with its reason. */
  uiRefusals(): readonly ExtensionUIRefusal[] {
    return this.#uiRefusals;
  }

  /** ADR-0062 (#1132): the overlay the client currently shows, null = none. */
  activeOverlay(): ActiveExtensionOverlay | null {
    return this.#activeOverlay;
  }

  /** ADR-0062 (#1132): closes the active overlay; a no-op when none. */
  closeOverlay(): void {
    this.#activeOverlay = null;
  }

  /** ADR-0062 (#1132): subscribes to overlay open requests; returns the
   * unsubscribe function. A client with a surface renders the named
   * overlay full-screen; a headless client subscribes to nothing and the
   * open contributes nothing visible. */
  onOverlayOpen(listener: (overlay: ActiveExtensionOverlay) => void): () => void {
    this.#overlayListeners.add(listener);
    return () => this.#overlayListeners.delete(listener);
  }

  /** ADR-0062 (#1132): the registration path behind `ctx.registerPanel`.
   * `replacing` is the outgoing instance during a hot-reload: it still
   * sits in `#instances` while the fresh instance's setup runs, and the
   * slot it holds is the one being handed over — counting it would make
   * an extension lose its panel on an ordinary edit whenever the rail is
   * full (`4 + 1 > 4`). */
  #registerPanel(instance: RuntimeExtension, panel: ExtensionPanel, replacing?: RuntimeExtension): void {
    const extension = instance.def.name;
    const name = typeof (panel as { name?: unknown } | null)?.name === "string" ? panel.name : "";
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || typeof panel?.render !== "function") {
      this.#refuseUI(extension, "panel", typeof name === "string" ? name : "", "invalid");
      return;
    }
    if (instance.panel !== null) {
      this.#refuseUI(extension, "panel", name, "taken");
      return;
    }
    const existing = this.#instances.filter((i) => i.panel !== null && i !== replacing).length;
    if (existing + 1 > MAX_PANELS) {
      this.#refuseUI(extension, "panel", name, "exhausted");
      return;
    }
    instance.panel = panel;
  }

  /** ADR-0062 (#1132): the registration path behind `ctx.registerOverlay`.
   * Returns the `open()` handle the extension's command calls. */
  #registerOverlay(instance: RuntimeExtension, overlay: ExtensionOverlay): { open(): void } {
    const extension = instance.def.name;
    const name = typeof (overlay as { name?: unknown } | null)?.name === "string" ? overlay.name : "";
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || typeof overlay?.render !== "function") {
      this.#refuseUI(extension, "overlay", typeof name === "string" ? name : "", "invalid");
      return { open: () => {} };
    }
    const taken = instance.overlays.some((o) => o.name === name);
    if (taken) {
      this.#refuseUI(extension, "overlay", name, "taken");
      return { open: () => {} };
    }
    instance.overlays.push(overlay);
    return {
      open: () => {
        // #1143: the owner is whoever's invocation this callback runs in —
        // keyed by async context, so an interleaved second command cannot
        // steal or lose the first's overlay open() guard.
        if (this.#commandOwners.getStore() !== instance) {
          this.#emitFailed(extension, "overlay_open_refused", `overlay "${name}" can only be opened by this extension's command`);
          return;
        }
        const active = { extension, name };
        this.#activeOverlay = active;
        for (const listener of this.#overlayListeners) listener(active);
      },
    };
  }

  #refuseUI(extension: string, kind: ExtensionUIRefusal["kind"], name: string, reason: ExtensionUIRefusal["reason"]): void {
    this.#uiRefusals.push({ extension, kind, name, reason });
    const why =
      reason === "exhausted"
        ? `panel slot exhausted (${MAX_PANELS}/${MAX_PANELS}) — disable a panel in /extensions`
        : reason === "taken"
          ? kind === "panel"
            ? "one panel per extension"
            : "the overlay name is already taken by this extension"
          : `the ${kind} needs a valid name (letters, digits, hyphens) and a render()`;
    this.#emitFailed(extension, `${kind}_refused`, `${kind} "${name}" refused: ${why}`);
  }

  /**
   * ADR-0062 (#1130): runs one extension command by slash name. This is
   * the headless door too: a client with no UI invokes here and prints the
   * returned text — the same output the TUI shows, never a mock. A
   * throwing handler refuses the invocation with a visible
   * `extension_failed` record and never throws to the caller.
   */
  async invokeCommand(name: string, args: string): Promise<ExtensionCommandResult> {
    const wanted = name.toLowerCase();
    for (const instance of this.#instances) {
      const command = instance.commands.find((c) => c.name === wanted);
      if (!command) continue;
      // #1143: the owner rides the async context, not a single field —
      // two interleaved invocations (a command awaiting input while
      // another starts) must each keep their own owner, or the first
      // `finally` clears the second's.
      return this.#commandOwners.run(instance, async () => {
        try {
          const output = await command.run({ args });
          return { ok: true, extension: instance.def.name, output: typeof output === "string" ? output : String(output ?? "") };
        } catch (err) {
          const message = errMessage(err);
          this.#emitFailed(instance.def.name, "command_failed", `command "${command.name}" failed: ${message}`);
          return { ok: false, error: message };
        }
      });
    }
    return { ok: false, error: `no extension command "${name}"` };
  }

  /** ADR-0062 (#1130): the registration path behind `ctx.registerCommand`. */
  #registerCommand(instance: RuntimeExtension, command: ExtensionCommand): void {
    const extension = instance.def.name;
    const name = typeof (command as { name?: unknown } | null)?.name === "string" ? command.name : "";
    // Lowercase only (the contract's promise on `ExtensionCommand.name`):
    // a mixed-case name would register under one spelling and never answer
    // to its lowercase slash form — refused instead, never half-registered.
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      this.#refuseCommand(extension, typeof name === "string" ? name : "", "invalid");
      return;
    }
    const key = name.toLowerCase();
    if (this.#reservedCommandNames.has(key)) {
      this.#refuseCommand(extension, name, "reserved");
      return;
    }
    // During setup the instance is not yet in `#instances` (it is pushed
    // after setup settles), so the same-extension check is its own clause.
    const taken = this.#instances.some((i) => i.commands.some((c) => c.name === key)) || instance.commands.some((c) => c.name === key);
    if (taken) {
      this.#refuseCommand(extension, name, "taken");
      return;
    }
    if (typeof command.run !== "function") {
      this.#refuseCommand(extension, name, "invalid");
      return;
    }
    instance.commands.push(command);
  }

  #refuseCommand(extension: string, name: string, reason: ExtensionCommandRefusal["reason"]): void {
    this.#commandRefusals.push({ extension, name, reason });
    const why =
      reason === "reserved"
        ? "collides with a native command or skill (native > skills > extension)"
        : reason === "taken"
          ? "the name is already taken by another extension command"
          : "the name must be letters, digits and hyphens, and the command needs a run()";
    this.#emitFailed(extension, "command_refused", `command "/${name}" refused: ${why}`);
  }

  /** ADR-0056: the effective turn-path hook ceiling (ms). */
  get hookTimeoutMs(): number {
    return this.#hookTimeoutMs;
  }

  /**
   * ADR-0056/#1126: runs one hook invocation under the wall-clock
   * ceiling. Expired or thrown, the hook contributes nothing — the
   * caller sees `undefined` — and one visible `extension_failed` record
   * says so. A hook that answers *after* the ceiling is abandoned: its
   * late rejection is swallowed (already recorded) and its late value is
   * never read. The runtime holds no per-hook timer after the race
   * settles.
   */
  async #runCapped<T>(
    instance: RuntimeExtension,
    hookLabel: string,
    run: () => Promise<T> | T,
    ceilingMs: number = this.#hookTimeoutMs,
  ): Promise<{ out: T | undefined; timedOut: boolean }> {
    let timedOut = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    // The throw is captured INSIDE the racing promise: a rejecting race
    // member and the wall clock settle in either order, and the outcome
    // (one visible record, no contribution) must not depend on which won.
    let failed = false;
    let failure: unknown;
    const pending = (async () => {
      try {
        // ADR-0053: extension code runs marked, so the core's privileged
        // seams can refuse a prohibition attempted from inside a hook.
        return await runInExtensionScope(instance.def.name, run);
      } catch (err) {
        failed = true;
        failure = err;
        return undefined as T;
      }
    })();
    const out = await Promise.race([
      pending,
      new Promise<undefined>((resolve) => {
        deadline = setTimeout(() => {
          timedOut = true;
          resolve(undefined);
        }, ceilingMs);
      }),
    ]);
    if (deadline !== undefined) clearTimeout(deadline);
    if (timedOut) {
      this.#recordHookError({
        type: "extension_failed",
        name: instance.def.name,
        reason: "hook_timeout",
        message: `the ${hookLabel} hook did not answer within ${ceilingMs}ms; it contributed nothing`,
      });
      // #1143: a throw that lands after the timeout won the race would
      // otherwise go unrecorded — `failed`/`failure` in the abandoned
      // promise are never read. One bounded late-error record keeps "a
      // non-answer is absence, never authority" honest. The record rides
      // the same error bucket this dispatch drained into: captured here,
      // because the abandoned promise resumes outside the async scope.
      const bucket = this.#borrowedSessions.getStore()?.errors ?? this.#hookErrors;
      void pending.catch(() => {}).then(() => {
        if (failed) {
          bucket.push({
            type: "extension_failed",
            name: instance.def.name,
            reason: "hook_late_error",
            message: `the ${hookLabel} hook threw after its ${ceilingMs}ms timeout: ${errMessage(failure)}`,
          });
        }
      });
      return { out: undefined, timedOut };
    }
    if (failed) {
      this.#recordHookError({
        type: "extension_failed",
        name: instance.def.name,
        reason: "hook",
        message: errMessage(failure),
      });
      return { out: undefined, timedOut: false };
    }
    return { out: out as T, timedOut: false };
  }

  /** Successfully loaded instances, in registration order. */
  get instances(): readonly RuntimeExtension[] {
    return this.#instances;
  }

  /** Prompt notes from all instances, in registration order. */
  notes(): string[] {
    return this.#instances.flatMap((i) => i.notes);
  }

  /** ADR-0036: the per-turn notes still set, in registration order. */
  turnNotes(): string[] {
    return this.#instances.map((i) => i.turnNote).filter((n): n is string => n !== null);
  }

  /**
   * ADR-0036: clears every instance's per-turn note. Called at the start
   * of each turn, before the `beforeTurn` hooks run — a note an extension
   * writes during the turn-start dispatch belongs to the turn it describes.
   */
  clearTurnNotes(): void {
    for (const instance of this.#instances) instance.turnNote = null;
  }

  /** Drain load events (extension_loaded / extension_failed) recorded so far. */
  consumeLoadEvents(): AgentEvent[] {
    return this.#pending.splice(0, this.#pending.length);
  }

  /** Subscribe to runtime events (load results, hot-reload outcomes). */
  onLoadEvent(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * #944 (ADR-0047): runs `fn` as one *borrowed* session's hook dispatch —
   * a session that does not own this runtime but runs its turns through it
   * (a subagent child). Every event an extension appends inside `fn` lands
   * in that session's log (`scope.write`) instead of the owner's channel,
   * which is what makes a child's `appendEvent` chrome attributable: the
   * child's judgments belong in the child's own transcript, not in the
   * parent's.
   *
   * An async-context store rather than a field, deliberately: a parent turn
   * can run two children at once, so "the current session" cannot be one
   * mutable slot — each dispatch keeps its own writer across every await it
   * makes.
   */
  withSession<T>(scope: SessionScope, fn: () => T): T {
    return this.#borrowedSessions.run(scope, fn);
  }

  /** ADR-0032: subscribe to status publishes; returns an unsubscribe fn. */
  onStatusChange(listener: (extension: string, text: string | null) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  /**
   * ADR-0053/#998: the owning session attaches its SubagentHost so a
   * granted `spawn-subagent` capability has something to execute through.
   * The envelope (session cap, iteration ceiling) lives on the host.
   */
  attachSubagentHost(host: SubagentHost): void {
    this.#subagentHost = host;
  }

  /** ADR-0032: the currently published statuses, in registration order. */
  statuses(): ExtensionStatus[] {
    // #981: the client's status row is the *owner's* — a session borrowing
    // this runtime has no footer of its own, and its degradation names
    // itself in the log and on the status seam instead.
    const ownerKey = this.#ownerKey();
    return this.#instances
      .map((instance) => ({
        extension: instance.def.name,
        text: this.#budgetOf(instance, ownerKey)?.overlay ?? instance.status,
      }))
      .filter((entry): entry is { extension: string; text: string } => entry.text !== null);
  }

  /** Clears every published status (session end, extension reload). */
  clearStatuses(): void {
    for (const instance of this.#instances) {
      const budgets = this.#budgets.get(instance);
      const overlay = budgets ? [...budgets.values()].some((b) => b.overlay !== null) : false;
      if (instance.status === null && !overlay) continue;
      instance.status = null;
      if (budgets) for (const budget of budgets.values()) budget.overlay = null;
      for (const listener of this.#statusListeners) listener(instance.def.name, null);
    }
  }

  /**
   * ADR-0032: starts a new turn for this runtime's **owner** — the
   * per-session `extension_event` cap counts per turn, so the owning session
   * calls this when one of its turns begins. `sessionId` is that session's
   * opaque identity (#981): it keys its budget and names it in the cap
   * warning. Omitted, the owner's budget is still one budget, reported
   * without a name.
   */
  beginTurn(sessionId?: string): void {
    if (sessionId !== undefined && this.#ownerSessionId === null) {
      // The pre-turn window was this same session's: its entry is dropped
      // (a second, unreachable budget for one session is a trap), and an
      // overlay published without a name goes with it. The turn that names
      // the session resets the counter anyway.
      for (const instance of this.#instances) {
        const budget = this.#budgetOf(instance, OWNER_BUDGET);
        if (!budget) continue;
        this.#clearCapOverlay(instance, budget, true);
        this.#dropBudget(instance, OWNER_BUDGET);
      }
      this.#ownerSessionId = sessionId;
    }
    this.#resetTurn(this.#ownerKey());
  }

  /**
   * #981 (ADR-0047): starts a turn for a session that *borrows* this
   * runtime — a subagent child. Each session's budget resets on its own
   * turn start: a child's flood never disarms its parent, and the parent's
   * next turn never refills a child's.
   */
  beginBorrowedTurn(sessionId: string): void {
    this.#resetTurn(sessionId);
  }

  /**
   * #981: a borrowing session is gone (a subagent child disposed) — its
   * budgets and any cap overlay still published for it are dropped with it.
   * The runtime outlives every child it hosts, so nothing else would ever
   * collect them.
   */
  endBorrowedSession(sessionId: string): void {
    for (const instance of this.#instances) {
      const budget = this.#budgetOf(instance, sessionId);
      if (!budget) continue;
      this.#clearCapOverlay(instance, budget, false);
      this.#dropBudget(instance, sessionId);
    }
  }

  /** #981: the budget key of the owner's own dispatches. */
  #ownerKey(): string {
    return this.#ownerSessionId ?? OWNER_BUDGET;
  }

  /**
   * #981: the budget key the current dispatch runs for. An append made
   * outside any dispatch — a load-time record, a timer the extension kept —
   * has no borrowing scope to read, and is the owner's by construction.
   */
  #currentKey(): string {
    return this.#borrowedSessions.getStore()?.id ?? this.#ownerKey();
  }

  /** #981: this instance's budget for one session, if it has one. */
  #budgetOf(instance: RuntimeExtension, key: string): EventBudget | undefined {
    return this.#budgets.get(instance)?.get(key);
  }

  /** #981: drops one session's budget and everything it accounted for. */
  #dropBudget(instance: RuntimeExtension, key: string): void {
    this.#budgets.get(instance)?.delete(key);
  }

  /** #981: this instance's budget for one session, installed lazily. */
  #budget(instance: RuntimeExtension, key: string): EventBudget {
    let budgets = this.#budgets.get(instance);
    if (!budgets) {
      budgets = new Map();
      this.#budgets.set(instance, budgets);
    }
    let budget = budgets.get(key);
    if (!budget) {
      budget = { eventsThisTurn: 0, capWarned: false, overlay: null };
      budgets.set(key, budget);
    }
    return budget;
  }

  /** #981: one session's turn starts — its counter, never anyone else's. */
  #resetTurn(key: string): void {
    for (const instance of this.#instances) {
      const budget = this.#budgetOf(instance, key);
      if (!budget) continue;
      budget.eventsThisTurn = 0;
      budget.capWarned = false;
      this.#clearCapOverlay(instance, budget, key === this.#ownerKey());
    }
  }

  /**
   * #846: overlays this extension's status with the cap-degraded text (TUI
   * footer, one stderr line headless) for the remainder of *that session's*
   * turn. The owner's own degradation keeps the plain text — it belongs to
   * the footer that shows it; another session's names itself, because a
   * runtime-wide chip for a per-session condition is the same confusion one
   * level up (#981). `beginTurn`/`beginBorrowedTurn` clear it; a `setStatus`
   * from the extension drops it.
   */
  #capOverlay(instance: RuntimeExtension, budget: EventBudget, key: string): void {
    if (budget.overlay !== null) return;
    budget.overlay = key === this.#ownerKey()
      ? `event cap reached (${MAX_EVENTS_PER_TURN}/turn) — further events dropped until next turn`
      : `event cap reached (${MAX_EVENTS_PER_TURN}/turn) in ${key} — further events dropped until next turn`;
    for (const listener of this.#statusListeners) listener(instance.def.name, budget.overlay);
  }

  /**
   * #846: removes the cap overlay. The owner's clear restores the
   * extension's own status; a borrowing session's restores nothing — the
   * extension's status is the owner's chrome, and a child's ending says
   * nothing about it.
   */
  #clearCapOverlay(instance: RuntimeExtension, budget: EventBudget, owner: boolean): void {
    if (budget.overlay === null) return;
    budget.overlay = null;
    const restored = owner ? instance.status : null;
    for (const listener of this.#statusListeners) listener(instance.def.name, restored);
  }

  /**
   * ADR-0037: the session reports that a real user turn has begun — the
   * consecutive-synthetic-turn counters reset here, so an extension's
   * correction budget refills only on genuine user activity.
   */
  noteRealTurn(): void {
    this.#syntheticStreaks.clear();
  }

  /**
   * ADR-0037: one extension's `ctx.requestTurn`. The depth limit belongs
   * to the core, not the extension (the same principle as the compaction
   * floor): at most `MAX_CONSECUTIVE_SYNTHETIC_TURNS` consecutive
   * synthetic turns, a refusal is never silent — the log carries an
   * `extension_failed` — and a host without a turn entry (a runtime that
   * cannot run turns) refuses the same way.
   */
  async #requestTurnFor(instance: RuntimeExtension, text: string): Promise<boolean> {
    const name = instance.def.name;
    if (typeof text !== "string" || text.trim() === "") {
      this.#emit({ type: "extension_failed", name, reason: "request_turn", message: "requestTurn requires non-empty text" });
      return false;
    }
    const streak = this.#syntheticStreaks.get(name) ?? 0;
    if (streak >= MAX_CONSECUTIVE_SYNTHETIC_TURNS) {
      this.#emit({
        type: "extension_failed",
        name,
        reason: "request_turn",
        message: `synthetic-turn cap reached (${MAX_CONSECUTIVE_SYNTHETIC_TURNS} consecutive); request refused`,
      });
      return false;
    }
    const entry = this.#options.requestTurn;
    if (!entry) {
      this.#emit({ type: "extension_failed", name, reason: "request_turn", message: "no turn entry on this session" });
      return false;
    }
    // The counter moves at acceptance, not settlement: a hook that (against
    // the contract) requests again from its own synthetic turn finds the
    // budget already spent, and the chain is cut here in the core.
    this.#syntheticStreaks.set(name, streak + 1);
    const ok = await entry(text);
    return ok;
  }

  /** True while a registration started earlier has not settled yet. */
  hasPendingRegistrations(): boolean {
    return this.#pendingLoadCount > 0;
  }

  /**
   * ADR-0037: binds the session's synthetic-turn entry (called by the
   * owning session once, after construction — the runtime is created
   * before the session in the assembly path). Idempotent; the last
   * binding wins.
   */
  bindRequestTurn(entry: (text: string) => Promise<boolean>): void {
    (this.#options as { requestTurn?: (text: string) => Promise<boolean> }).requestTurn = entry;
  }

  /**
 * ADR-0064 + ADR-0065: the session binds its live deny answer for the path
 * scope. A deny rule on a covered path beats every path grant per call —
 * the grant never widens what moh itself may do. Read at call time, so a
 * runtime rule added mid-session applies to the next host operation.
 */
#pathDeny: ((resolvedAbsPath: string) => boolean) | null = null;

bindPathDeny(isDenied: (resolvedAbsPath: string) => boolean): void {
  this.#pathDeny = isDenied;
}

  /**
   * ADR-0067: the session binds its tool-execution seam. The `runTool`
   * host method exists only when a `tool:` scope was granted, but the
   * session (which owns the runner and the gate) may not exist yet at
   * load time — the seam binds later, like the deny answers.
   */
  #toolSeam: ToolSeam | null = null;

  bindToolSeam(seam: ToolSeam): void {
    this.#toolSeam = seam;
  }

  /**
   * ADR-0068: the session binds its model-call seam. Extension setup may
   * run before a session exists — the seam binds later, like the tool
   * seam. A call made with no session bound is refused loudly, never
   * silently dropped.
   */
  #modelSeam: ModelSeam | null = null;

  bindModelSeam(seam: ModelSeam): void {
    this.#modelSeam = seam;
  }

  /**
   * ADR-0067: the session binds its contributed-tool sink. A registration
   * made before a session exists (setup runs during load) is held and
   * applied — and logged — at bind time, so the `tool_contributed` event
   * lands inside the session's log deterministically.
   */
  #toolContributor: ((registration: { extension: string; tool: unknown }) => void) | null = null;
  #pendingContributed: { extension: string; tool: unknown }[] = [];
  /** ADR-0055 (#1222): names of accepted contributed tools — the set the
   * subagent host excludes from every child's toolset. */
  #contributedToolNames = new Set<string>();

  /** ADR-0055 (#1222): the contributed tools this runtime holds. */
  contributedToolNames(): readonly string[] {
    return [...this.#contributedToolNames];
  }

  bindToolContributor(contributor: (registration: { extension: string; tool: unknown }) => void): void {
    this.#toolContributor = contributor;
    const pending = this.#pendingContributed.splice(0);
    for (const registration of pending) {
      contributor(registration);
      // ADR-0067: the registration record lands with the session's log —
      // emitted at bind time, never during setup, so a replay sees it
      // where the tool became callable.
      this.#emit({ type: "tool_contributed", extension: registration.extension, tool: (registration.tool as { name: string }).name });
    }
  }

  /** True when any loaded extension holds a `contribute-tool:<name>` grant. */
  hasContributedToolScopes(): boolean {
    return this.#instances.some((e) => contributeToolScopesOf(e.grantedCapabilities).length > 0);
  }

  /**
   * ADR-0067 `registerTool`: the name must be one the consent named; a
   * mismatch is a loud `extension_failed` and the tool never reaches the
   * model. With a session bound, the tool registers immediately (and the
   * `tool_contributed` record rides the session's log); without one, the
   * registration is held for `bindToolContributor`.
   */
  #registerContributedTool(instance: RuntimeExtension, tool: ExtensionContributedTool, grantedNames: readonly string[]): void {
    const extension = instance.def.name;
    const name = typeof (tool as { name?: unknown } | null)?.name === "string" ? tool.name : "";
    if (name === "" || !contributesTool(name, [...grantedNames.map((n) => `${CONTRIBUTE_TOOL_SCOPE_PREFIX}${n}`)])) {
      this.#emitFailed(extension, "register_tool_refused", `contribute-tool: the registered tool name "${name}" is not one the consent granted (${grantedNames.map((n) => `"${n}"`).join(", ") || "none"})`);
      return;
    }
    if (typeof tool.execute !== "function") {
      this.#emitFailed(extension, "register_tool_refused", `contribute-tool: "${name}" has no execute()`);
      return;
    }
    const registration = { extension, tool };
    this.#contributedToolNames.add(name);
    if (this.#toolContributor) this.#toolContributor(registration);
    else this.#pendingContributed.push(registration);
    // The `tool_contributed` record is emitted by `bindToolContributor`
    // at bind time — the log of the session where the tool became
    // callable, never a setup-time orphan event.
  }

  /** True when any loaded extension holds a `tool:<name|*>` grant. */
  hasToolScopes(): boolean {
    return this.#instances.some((e) => toolScopesOf(e.grantedCapabilities).length > 0);
  }

  /**
   * Resolves when every registration started so far has settled (the
   * bundled-definition path and the client's file source register
   * fire-and-forget from the assembly; the first turn waits on this so a
   * hook is never missing). Safe to call repeatedly and concurrently.
   */
  async ready(): Promise<void> {
    while (this.#pendingLoadCount > 0) await this.#pendingLoads;
  }

  /** Tracks a registration so `ready()` and `hasPendingRegistrations()` see it. */
  #track<T>(load: Promise<T>): Promise<T> {
    this.#pendingLoadCount += 1;
    // The chain swallows rejections: a load never rejects by contract (every
    // failure is a visible `extension_failed`), and one throwing must not
    // reject `ready()` for the callers that gate on it.
    const settled = load.then(
      () => {},
      () => {},
    );
    this.#pendingLoads = Promise.all([this.#pendingLoads, settled]).then(() => {
      this.#pendingLoadCount -= 1;
    });
    return load;
  }

  /**
   * Registers an in-memory definition. `bundled` marks code the host
   * shipped (first-party bundled code, ADR-0005): consent and dependency
   * authorization are skipped, because those bytes never came from the
   * user's disk and nobody consented to them by name. Never set it for a
   * definition loaded from a path.
   */
  async register(def: unknown, options: RegisterOptions = {}): Promise<boolean> {
    return this.#track(this.#load(def, undefined, options));
  }

  /**
   * Loads several files in order (deterministic hook precedence — first
   * decision wins in registration order) as **one** pending registration:
   * `ready()` waits for the whole list, so the first turn never runs with
   * half the extensions loaded.
   */
  registerFiles(files: readonly string[]): Promise<boolean[]> {
    return this.#track(
      (async (): Promise<boolean[]> => {
        const results: boolean[] = [];
        for (const file of files) results.push(await this.#registerFileNow(file));
        return results;
      })(),
    );
  }

  /**
   * Loads an extension from a file (dynamic import, cache-busted). The
   * module's default export must be a `defineExtension(...)` result.
   */
  registerFile(file: string): Promise<boolean> {
    return this.registerFiles([file]).then((results) => results[0] === true);
  }

  /**
   * #834 (security): the enable consent, resolved from a content identity —
   * which is computable from a file *without* running it. Importing a module
   * evaluates it, so the question must be answered first: a declined or
   * never-answered file must not execute a single line, headless included.
   * A granted answer is persisted against the identity (path + bytes), so an
   * unchanged file never asks again and an edited one always does.
   *
   * ADR-0061: for a file load the grant also covers the **manifest** — its
   * own SHA-256 and the capabilities it declared. An unchanged manifest is
   * part of the silent load; a manifest whose hash changed re-asks, and a
   * widening edit shows the capability diff in the question.
   */
  async #ensureConsent(
    identity: string,
    info: {
      file?: string;
      hash?: string;
      name?: string;
      version?: string;
      capabilities?: readonly string[];
    },
    bundled: boolean,
    manifest?: ManifestAuthority,
  ): Promise<{ ok: true } | { ok: false; reason: string; message: string }> {
    if (bundled) return { ok: true };
    const store = this.#readStore();
    // The grant is (code bytes, manifest bytes): either half changing means
    // a new question. The manifest record is keyed by manifest path because
    // the content identity is not stable across a widening edit — the code
    // usually changes with the manifest.
    const stored = manifest ? store.manifests[manifest.path] : undefined;
    const manifestUnchanged = manifest ? stored?.hash === manifest.hash : true;
    if (store.consents[identity] && manifestUnchanged) return { ok: true };
    if (!this.#options.consent) {
      const message = "extension not previously enabled and no consent flow is available";
      // The host's own channel (a headless client's stderr): the log
      // carries the same fact, but nobody reads a log they never saw.
      this.#options.onWarning?.(`extension ${info.name ?? info.file ?? identity}: not loaded — ${message}`);
      return { ok: false, reason: "consent", message };
    }
    // The widening the user must see: what the new manifest declares that
    // the previously granted one did not.
    const added = manifest && stored ? capabilityDiff(stored.capabilities, info.capabilities ?? []).added : [];
    let granted: boolean;
    try {
      granted = await this.#options.consent({
        ...(info.file ? { file: info.file } : {}),
        ...(info.hash ? { hash: info.hash } : {}),
        ...(info.name ? { name: info.name } : {}),
        ...(info.version ? { version: info.version } : {}),
        ...(info.capabilities?.length ? { capabilities: info.capabilities } : {}),
        ...(added.length ? { addedCapabilities: added } : {}),
        // ADR-0066: the total-wildcard justification rides the question.
        ...(manifest?.reasoning !== undefined ? { reasoning: manifest.reasoning } : {}),
      });
    } catch (err) {
      return { ok: false, reason: "consent", message: errMessage(err) };
    }
    if (!granted) return { ok: false, reason: "consent", message: "user declined to enable the extension" };
    store.consents[identity] = true;
    if (manifest && info.capabilities) {
      store.manifests[manifest.path] = { hash: manifest.hash, capabilities: [...info.capabilities] };
    }
    this.#writeStore(store);
    return { ok: true };
  }

  async #registerFileNow(file: string): Promise<boolean> {
    // Canonical from here on: the identity, the consent question, the import
    // and the watcher all speak about one path.
    const abs = canonicalModulePath(file);
    // #834 (security): identity first, import second. `contentIdentity` only
    // reads bytes; asking here means a file the user declined — or was never
    // asked about, which is every headless run — is never evaluated at all.
    // The identity is re-derived inside `#instantiate`, so a file swapped in
    // between is caught rather than trusted.
    const identity = contentIdentity(abs);
    if (!identity) {
      this.#emitFailed(basename(abs), "load_failed", "extension file could not be read");
      return false;
    }
    // ADR-0061: the manifest before everything — it is what consent reads,
    // so a file with no (or a malformed, or a not-its-own) manifest refuses
    // here, asking nothing and importing nothing. Not even top-level code
    // of an unmanifested module runs.
    const manifest = readExtensionManifest(abs);
    if (!manifest.ok) {
      this.#emitFailed(basename(abs), "manifest", manifest.message);
      return false;
    }
    const gate = await this.#ensureConsent(
      identity,
      { file: abs, hash: identityHash(identity), capabilities: manifest.manifest.capabilities },
      false,
      manifest.authority,
    );
    if (!gate.ok) {
      this.#emitFailed(basename(abs), gate.reason, gate.message);
      return false;
    }
    const prepared = await this.#prepareFileDeps(abs);
    if (!prepared) return false;
    let def: unknown;
    try {
      def = await importDefinition(abs);
    } catch (err) {
      this.#emitFailed(basename(abs), "load_failed", errMessage(err));
      return false;
    }
    return this.#load(def, abs, {}, manifest.manifest.capabilities);
  }

  /** Watch registered files and hot-reload on change (state preserved). */
  startWatch(): void {
    for (const instance of this.#instances) {
      if (!instance.file || this.#watchers.has(instance.file)) continue;
      if (!existsSync(instance.file)) continue;
      const watcher = watch(instance.file, () => this.#scheduleReload(instance.file!));
      this.#watchers.set(instance.file, watcher);
    }
  }

  stopWatch(): void {
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
    for (const t of this.#reloadTimers.values()) clearTimeout(t);
    this.#reloadTimers.clear();
  }

  #scheduleReload(file: string): void {
    // ADR-0053 absolute prohibition: disabling or replacing another
    // extension is core-only work. A reload triggered from extension code
    // would do exactly that (swap or retire an instance) — refused.
    assertNoExtensionScope("disable-extension", "trigger an extension reload (disable/replace another extension)");
    clearTimeout(this.#reloadTimers.get(file));
    this.#reloadTimers.set(
      file,
      setTimeout(() => {
        this.#reloadTimers.delete(file);
        void this.#hotReload(file);
      }, 100),
    );
  }

  /** Reload one file: success replaces the instance in place (state kept); failure keeps the previous one. */
  async #hotReload(file: string): Promise<void> {
    const index = this.#instances.findIndex((i) => i.file === file);
    if (index === -1) return;
    const previous = this.#instances[index]!;
    // Everything below speaks about the canonical path, like the load path —
    // the manifest lookup and the consent store key must match it.
    file = canonicalModulePath(file);
    // ADR-0061: the manifest is re-read before anything else — a missing or
    // malformed one keeps the previous instance, exactly like a refused
    // consent would: what serves is the last state the user approved.
    const manifest = readExtensionManifest(file);
    if (!manifest.ok) {
      this.#options.onWarning?.(`extension ${previous.def.name}: reload refused (${manifest.message}); previous instance kept`);
      this.#emitFailed(previous.def.name, "reload_failed", `${manifest.message}; previous instance kept`);
      return;
    }
    // #834 (security): the edited bytes are consented BEFORE they are
    // imported. A reload evaluates the new file, so an edit the user has not
    // answered for must not run: the ask names the extension (the previous
    // instance knows it) and its new hash, and a refusal keeps the previous
    // instance in place. A widening manifest edit shows the capability diff
    // in the question (#1125).
    const identity = contentIdentity(file);
    if (identity) {
      const gate = await this.#ensureConsent(
        identity,
        {
          file,
          hash: identityHash(identity),
          name: previous.def.name,
          version: previous.def.version,
          capabilities: manifest.manifest.capabilities,
        },
        false,
        manifest.authority,
      );
      if (!gate.ok) {
        this.#options.onWarning?.(`extension ${previous.def.name}: reload refused (${gate.reason}); previous instance kept`);
        this.#emitFailed(previous.def.name, "reload_failed", `${gate.reason}: ${gate.message}; previous instance kept`);
        return;
      }
    }
    if (!await this.#prepareFileDeps(file)) return;
    let def: unknown;
    try {
      def = await importDefinition(file);
    } catch (err) {
      // Visible on both channels: the log (replay, the TUI transcript) and
      // the host's own warning line. A reload that silently kept the old
      // instance would let an edited file look applied.
      this.#options.onWarning?.(`extension ${previous.def.name}: reload failed (${errMessage(err)}); previous instance kept`);
      this.#emitFailed(previous.def.name, "reload_failed", `${errMessage(err)}; previous instance kept`);
      return;
    }
    // Seed the fresh instance with the previous state so setup() sees it.
    const fresh = await this.#instantiate(def, file, previous.state, {}, manifest.manifest.capabilities, previous);
    if (!fresh.ok) {
      this.#options.onWarning?.(
        `extension ${previous.def.name}: reload refused (${fresh.reason}); previous instance kept`,
      );
      this.#emitFailed(previous.def.name, "reload_failed", `${fresh.reason}: ${fresh.message}; previous instance kept`);
      return;
    }
    // State was preserved by seeding; hooks are re-registered by setup().
    // ADR-0032: a status is a statement about *now* — a reloaded instance
    // publishes from scratch, so the previous one is cleared first.
    if (previous.status !== null) {
      for (const listener of this.#statusListeners) listener(previous.def.name, null);
    }
    this.#instances[index] = fresh.instance;
    this.#emit(loadedEvent(fresh.instance));
  }

  async #load(
    def: unknown,
    file: string | undefined,
    options: RegisterOptions = {},
    manifestCaps?: readonly string[],
  ): Promise<boolean> {
    const result = await this.#instantiate(def, file, undefined, options, manifestCaps);
    if (!result.ok) {
      this.#emitFailed(result.name ?? basename(file ?? "(unknown)"), result.reason, result.message);
      return false;
    }
    this.#instances.push(result.instance);
    this.#emit(loadedEvent(result.instance));
    return true;
  }

  /** Validation + policy + setup for one candidate definition. No side effects on failure. */
  async #instantiate(
    def: unknown,
    file: string | undefined,
    seedState?: Record<string, unknown>,
    options: RegisterOptions = {},
    manifestCaps?: readonly string[],
    /** The instance this one replaces (a hot-reload): excluded from the
     * rail's capacity count, whose slot is being handed over (#1132). */
    replacing?: RuntimeExtension,
    /** ADR-0066: the manifest authority the consent signed (its
     * `reasoning` travels from the same bytes, never a re-read). */
    manifestAuthority?: ManifestAuthority,
  ): Promise<
    | { ok: true; instance: RuntimeExtension }
    | ({ ok: false; name?: string; reason: string; message: string })
  > {
    const d = def as Partial<ExtensionDefinition> | null;
    const name = typeof d?.name === "string" ? d.name : undefined;
    if (!d || typeof d !== "object" || !name || typeof d.version !== "string" || typeof d.apiVersion !== "string" || typeof d.setup !== "function") {
      return { ok: false, name, reason: "invalid", message: "extension must default-export defineExtension({ name, version, apiVersion, setup })" };
    }
    const host = parseApiVersion(MOH_EXTENSION_API_VERSION);
    const api = parseApiVersion(d.apiVersion);
    if (!host || !api) {
      return { ok: false, name, reason: "invalid", message: `malformed apiVersion: ${String(d.apiVersion)}` };
    }
    // Additive-only policy: same major always loads; major mismatch refuses.
    if (api.major !== host.major) {
      return {
        ok: false,
        name,
        reason: "api_version_mismatch",
        message: `extension apiVersion ${d.apiVersion} does not match host ${MOH_EXTENSION_API_VERSION} (major must match)`,
      };
    }
    const store = this.#readStore();
    // ADR-0053/0062 vocabulary: one name, one instance per runtime. A
    // second registration of an extension already loaded is refused loudly
    // (`taken`) — like a panel or command name — never silently stacked;
    // a hot-reload replaces and is exempt (it hands over its own slot).
    if (!replacing && this.#instances.some((i) => i.def.name === name)) {
      return { ok: false, name, reason: "taken", message: `an extension named "${name}" is already registered in this session` };
    }
    // In-memory definitions have no source bytes: retain their historical
    // name identity. Loaded modules bind consent to resolved path + bytes.
    // Bundled first-party definitions (`register(def, { bundled: true })`)
    // skip both consent and dependency authorization: the host shipped the
    // bytes, the user never chose them.
    const bundled = options.bundled === true;
    const identity = contentIdentity(file) ?? `memory:${name}`;
    const hash = identityHash(identity);
    // #834 (security): the two paths that import a module (`#registerFileNow`
    // and `#hotReload`) resolve this before the import, so by the time a
    // candidate definition exists the grant is already stored and this is a
    // lookup — which also re-checks the bytes, catching a file swapped in
    // between. For an in-memory registration it is the question itself.
    const recheck = file ? readExtensionManifest(file) : undefined;
    // ADR-0061: the grant covers manifest bytes too; re-derived here so a
    // manifest swapped in between ask and import is caught.
    const consentAuthority = file
      ? (recheck?.ok ? recheck.authority : undefined)
      : options.manifest?.hash
        ? {
            hash: options.manifest.hash,
            path: options.manifest.path ?? options.manifest.hash,
            capabilities: options.manifest.capabilities,
            ...(options.manifest.reasoning !== undefined ? { reasoning: options.manifest.reasoning } : {}),
          }
        : undefined;
    const consent = await this.#ensureConsent(
      identity,
      {
        ...(file ? { file } : {}),
        ...(hash ? { hash } : {}),
        name,
        version: d.version,
        // Re-derives the manifest here too: a file swapped in between the
        // pre-import ask and this lookup is caught rather than trusted.
        // An in-memory registration has no recheck — the authority the
        // registration declared (ADR-0061's bundled-with-manifest shape)
        // is what the question must name, or a yes would grant powers it
        // never showed.
        ...(recheck?.ok
          ? { capabilities: recheck.manifest.capabilities }
          : consentAuthority
            ? { capabilities: consentAuthority.capabilities }
            : {}),
      },
      bundled,
      consentAuthority,
    );
    if (!consent.ok) return { ok: false, name, reason: consent.reason, message: consent.message };
    // The subset check itself: only where a manifest exists to check against
    // (every file load; a bundled source that declares one).
    const authority = manifestCaps ?? options.manifest?.capabilities;
    if (authority) {
      const defCaps: unknown = (d as { capabilities?: unknown }).capabilities;
      // A non-string entry is not dropped: it coerces into a slot the
      // manifest will not have declared, so the refusal names it.
      const codeCaps = (Array.isArray(defCaps) ? defCaps : []).map((c) => (typeof c === "string" ? c : String(c)));
      const subset = capabilitiesSubset(codeCaps, authority);
      if (!subset.ok) {
        return {
          ok: false,
          name,
          reason: "capability_undeclared",
          message: `extension uses capabilities not declared in its manifest: ${subset.undeclared.join(", ")}`,
        };
      }
    }
    // Per-change dependency authorization, bound to the same content identity.
    // ADR-0070 (#1166): when the manifest declares `dependencies`, the
    // manifest is the authority — exact pins moh installs into the
    // extension's own dependency directory. The install (like the consent)
    // is per content identity: a changed dep list is a new question whose
    // answer is remembered; a refusal keeps the previously approved tree.
    const manifestDeps: Record<string, string> | undefined =
      recheck?.ok ? recheck.manifest.dependencies : consentAuthority?.dependencies;
    const codeDeps = d.dependencies ?? [];
    // A code-level declaration disagreeing with the manifest is a loud
    // refusal: one source of truth, the manifest the consent signed.
    if (manifestDeps !== undefined && codeDeps.length > 0) {
      const manifestKeys = Object.entries(manifestDeps).map(([pkg, ver]) => `${pkg}@${ver}`).sort();
      if (!sameDeps(manifestKeys, codeDeps)) {
        return {
          ok: false,
          name,
          reason: "deps_undeclared",
          message: `extension code declares dependencies (${codeDeps.join(", ")}) that differ from its manifest's (${manifestKeys.join(", ")}) — the manifest is the authority (ADR-0070)`,
        };
      }
    }
    const deps = manifestDeps
      ? Object.entries(manifestDeps).map(([pkg, ver]) => `${pkg}@${ver}`).sort()
      : codeDeps;
    const approved = store.dependencies[identity] ?? [];
    if (!bundled && !sameDeps(deps, approved)) {
      if (deps.length > 0 && !this.#options.authorizeDependencies) {
        // Honest refusal (v1, #834): no host authorization seam, so an
        // extension that needs dependencies cannot run — never a
        // half-promise.
        return { ok: false, name, reason: "deps_unauthorized", message: `extension declares dependencies (${deps.join(", ")}) and no dependency authorization flow is available` };
      }
      if (deps.length > 0) {
        let granted: boolean;
        try {
          granted = await this.#options.authorizeDependencies!(name, deps);
        } catch (err) {
          return { ok: false, name, reason: "deps_unauthorized", message: errMessage(err) };
        }
        if (!granted) {
          // ADR-0070: a refusal keeps the previously approved tree — the
          // dependency directory is untouched and the load simply fails.
          return { ok: false, name, reason: "deps_unauthorized", message: `user declined dependencies: ${deps.join(", ")}` };
        }
      }
      store.dependencies[identity] = [...deps];
      this.#writeStore(store);
    }
    const instance: RuntimeExtension = {
      def: d as ExtensionDefinition,
      state: { ...seedState },
      notes: [],
      turnNote: null,
      hooks: EMPTY_HOOKS(),
      file,
      status: null,
      commands: [],
      panel: null,
      overlays: [],
      grantedCapabilities: [],
    };
    // ADR-0053 + ADR-0062 (#1130): enforcement by absence. The
    // registration API exists on the context only when the grant covers
    // the slot — the manifest when there is one (the authority consent
    // signed), otherwise the code's own declaration (an in-memory
    // registration has no manifest to exceed).
    const granted = authority ?? (Array.isArray((d as { capabilities?: unknown }).capabilities) ? ((d as { capabilities: string[] }).capabilities).map((c) => String(c)) : []);
    // ADR-0065: an absolute path inside a `path:` capability fails loudly
    // at load — a capability naming outside-the-project targets is exactly
    // what consent must not hide. Checked before setup ever runs.
    for (const capability of granted) {
      if (!isPathScope(capability)) continue;
      const validity = validatePathScope(capability);
      if (!validity.ok) return { ok: false, name, reason: "invalid_path_scope", message: validity.message };
    }
    // ADR-0066: a malformed `host:` scope fails loudly at load; the total
    // wildcard `host:*` exists only with a manifest `reasoning` string —
    // the author's justification the consent question displays. The
    // manifest is the only source: an in-memory registration without one
    // cannot claim the total wildcard at all.
    for (const capability of granted) {
      if (!isHostScope(capability)) continue;
      const validity = validateHostScope(capability);
      if (!validity.ok) return { ok: false, name, reason: "invalid_host_scope", message: validity.message };
      if (capability !== TOTAL_HOST_WILDCARD) continue;
      // One authority only: the manifest object consent signed (or the
      // registration's declared authority) — never a second disk read.
      const declared = consentAuthority?.reasoning;
      if (typeof declared !== "string" || declared.trim() === "") {
        return {
          ok: false,
          name,
          reason: "missing_reasoning",
          message: `"${TOTAL_HOST_WILDCARD}" requires a "${HOST_SCOPE_REASONING_KEY}" string in the extension manifest — the justification the consent question displays`,
        };
      }
    }
    // ADR-0069: a malformed `credential:<ref>` scope fails loudly at load,
    // like its path/host siblings — a ref no `credential:` grammar can
    // name must never reach consent, let alone a fetch.
    for (const capability of granted) {
      if (!isCredentialScope(capability)) continue;
      const validity = validateCredentialScope(capability);
      if (!validity.ok) return { ok: false, name, reason: "invalid_credential_scope", message: validity.message };
    }
    // ADR-0067: the tool scopes validate at load like their scope
    // siblings. An invocation name must be a name a session can look up
    // (the wildcard is its own grammar); a contribution is always named
    // exactly — a wildcard contribution would hide which tools the
    // extension's code actually adds.
    for (const capability of granted) {
      if (isToolScope(capability)) {
        const validity = validateToolScope(capability);
        if (!validity.ok) return { ok: false, name, reason: "invalid_tool_scope", message: validity.message };
      } else if (isContributeToolScope(capability)) {
        const validity = validateContributeToolScope(capability);
        if (!validity.ok) return { ok: false, name, reason: "invalid_tool_scope", message: validity.message };
      }
    }
    // ADR-0068: an `endpoint:<ref>` scope validates at load like its
    // scope siblings — the ref is an endpoint name from moh.json, never
    // an "endpoint/model" pair (the model is a call-time choice).
    for (const capability of granted) {
      if (!isEndpointScope(capability)) continue;
      const validity = validateEndpointScope(capability);
      if (!validity.ok) return { ok: false, name, reason: "invalid_endpoint_scope", message: validity.message };
    }
    instance.grantedCapabilities = [...granted];
    const commandSlot: { registerCommand?: ExtensionSetupContext["registerCommand"] } = granted.includes("contribute-commands")
      ? { registerCommand: (command: ExtensionCommand) => this.#registerCommand(instance, command) }
      : {};
    // ADR-0062 (#1132): same enforcement-by-absence for the UI slots.
    const panelSlot: { registerPanel?: ExtensionSetupContext["registerPanel"] } = granted.includes("contribute-panels")
      ? { registerPanel: (panel: ExtensionPanel) => this.#registerPanel(instance, panel, replacing) }
      : {};
    const overlaySlot: { registerOverlay?: ExtensionSetupContext["registerOverlay"] } = granted.includes("contribute-overlays")
      ? { registerOverlay: (overlay: ExtensionOverlay) => this.#registerOverlay(instance, overlay) }
      : {};
    // ADR-0067: the contributed-tool slot. Present only when the grant
    // covers at least one `contribute-tool:<name>` scope (enforcement by
    // absence); the registered name must be one the consent named, and
    // the tool lands in the session via the bound contributor — the same
    // runner and gate as every session tool.
    const contributedNames = contributeToolScopesOf(granted).map(contributeToolName);
    const toolSlot: { registerTool?: ExtensionSetupContext["registerTool"] } =
      contributedNames.length > 0
        ? { registerTool: (tool) => this.#registerContributedTool(instance, tool, contributedNames) }
        : {};
    // ADR-0053 + ADR-0055 (#998 follow-up): the spawn-subagent slot.
    // Present only when granted (enforcement by absence); the envelope is
    // intersected at every call, and a refusal is a loud
    // `extension_failed` with the child never created.
    const spawnSlot: Pick<ExtensionSetupContext, "spawnSubagent" | "subagentActivity" | "steerSubagent" | "stopSubagents"> = granted.includes("spawn-subagent")
      ? {
          spawnSubagent: (spec) => this.#spawnSubagentFor(instance, spec),
          subagentActivity: (callId) => this.#subagentActivityFor(instance, callId),
          steerSubagent: (callId, message) => this.#steerSubagentFor(instance, callId, message),
          stopSubagents: () => this.#stopSubagentsFor(instance),
        }
      : {};
    // ADR-0064 + ADR-0065: the host-performs seam. Present only when the
    // grant covers at least one `path:<glob>` scope (enforcement by
    // absence); the scope check runs per call, before the host performs.
    const scopes = pathScopesOf(granted);
    const hostScopes = hostScopesOf(granted);
    // ADR-0069: a credential scope is a scope in its own right — the seam
    // exists when one is granted even without a host scope, so an
    // authenticated call is refused on the host check, not by absence.
    const credScopes = credentialScopesOf(granted);
    // ADR-0067: the tool scopes. `runTool` rides the same seam object —
    // present only when a `tool:<name|*>` scope was granted; the per-call
    // check is whole-tool, the execution and gate live in the session.
    const toolScopes = toolScopesOf(granted);
    const toolHost = this.#toolHostFor(instance, toolScopes);
    // ADR-0068: the endpoint scopes. `modelCall`/`listModels` ride the
    // same seam object — present only when at least one `endpoint:<ref>`
    // scope was granted; the per-call check is one-ref-exact.
    const endpointScopes = endpointScopesOf(granted);
    const endpointHost = this.#endpointHostFor(instance, endpointScopes);
    const fileHost = this.#fileHostFor(instance, scopes);
    const netHost = this.#networkHostFor(instance, [...hostScopes, ...credScopes]);
    // Both scopes land on one seam object; a method absent at runtime
    // means no scope of its kind was granted (enforcement by absence).
    const hostObject = { ...fileHost, fetch: netHost.fetch, runTool: toolHost.runTool, modelCall: endpointHost.modelCall, listModels: endpointHost.listModels } as ExtensionHost;
    const hostSlot: Pick<ExtensionSetupContext, "host"> =
      scopes.length > 0 || hostScopes.length > 0 || credScopes.length > 0 || toolScopes.length > 0 || endpointScopes.length > 0
        ? { host: hostObject }
        : {};
    const ctx: ExtensionSetupContext = {
      ...commandSlot,
      ...panelSlot,
      ...overlaySlot,
      ...toolSlot,
      ...spawnSlot,
      ...hostSlot,
      state: instance.state,
      appendToPrompt: (note) => instance.notes.push(note),
      // ADR-0036: one per-turn note per instance, replacing; `null` removes.
      setPromptNote: (text) => {
        instance.turnNote = typeof text === "string" && text.trim() !== "" ? text : null;
      },
      appendEvent: (event) => this.#appendExtensionEvent(instance, event),
      setStatus: (text) => this.#setStatus(instance, text),
      onSessionStart: (h) => instance.hooks.sessionStart.push(h),
      onSessionEnd: (h) => instance.hooks.sessionEnd.push(h),
      beforeTurn: (h) => instance.hooks.beforeTurn.push(h),
      beforeModelCall: (h) => instance.hooks.beforeModelCall.push(h),
      onModelError: (h) => instance.hooks.onModelError.push(h),
      onToolCall: (h) => instance.hooks.onToolCall.push(h),
      onToolResult: (tools, h) => {
        // An empty scope registers nothing: "inspect every result" is
        // never what an extension meant, and the core cannot know which
        // results are external (ADR-0034 §3).
        if (!Array.isArray(tools) || tools.length === 0) return;
        instance.hooks.onToolResult.push({ tools: [...tools], hook: h });
      },
      onCompaction: (h) => instance.hooks.onCompaction.push(h),
      onEvent: (h) => instance.hooks.onEvent.push(h),
      afterTurn: (h) => instance.hooks.afterTurn.push(h),
      requestTurn: (text) => this.#requestTurnFor(instance, text),
    };
    try {
      await instance.def.setup(ctx);
    } catch (err) {
      return { ok: false, name, reason: "setup_failed", message: errMessage(err) };
    }
    return { ok: true, instance };
  }

  #emitFailed(name: string, reason: string, message: string): void {
    this.#emit({ type: "extension_failed", name, reason, message });
  }
  /**
   * ADR-0053 + ADR-0055: the `spawn-subagent` capability's execution path.
   * The envelope is the host's business; here we enforce the structural
   * limits — no grandchildren (extension code running on a borrowed
   * child's dispatch may not spawn), a loud `extension_failed` on every
   * refusal, and attribution of the child to this extension.
   */
  async #spawnSubagentFor(
    instance: RuntimeExtension,
    spec: ExtensionSpawnSpec,
  ): Promise<{ callId: string; status: "done" | "error" | "cancelled"; output: string; error?: string }> {
    const name = instance.def.name;
    const refuse = (reason: string, message: string) => {
      this.#emitFailed(name, reason, message);
      return { callId: "", status: "error" as const, output: "", error: message };
    };
    // ADR-0055 "may not create grandchildren": extension code running
    // inside a borrowed (child) session's dispatch is the child speaking —
    // depth one is what keeps the envelope checkable at every level.
    if (this.#borrowedSessions.getStore() !== undefined) {
      return refuse("no_grandchildren", `extension "${name}" attempted to spawn from inside a subagent — grandchildren are refused`);
    }
    const host = this.#subagentHost;
    if (!host) {
      return refuse("spawn_unavailable", `extension "${name}" holds the spawn-subagent capability but this session exposes no subagent host`);
    }
    try {
      return await host.spawnForExtension(name, spec);
    } catch (err) {
      if (err instanceof ExtensionSpawnRefusedError) {
        return refuse(err.reason, err.message);
      }
      return refuse("spawn_failed", errMessage(err));
    }
  }

  /**
   * ADR-0064 + ADR-0065: the `path:<glob>` scope's execution path. One
   * check-scope module decides every call (`checkPathScope`); a refusal
   * is a typed result plus one `host_refused` event — never an exception,
   * never an `extension_failed`; a performed operation is one `host_op`
   * event with the resolved path. The host acted in the world; the log
   * records it.
   */
  /**
   * ADR-0067: the `runTool` half of the host seam. Scope + logging live
   * here (the runtime stamps the extension and writes `host_op` /
   * `host_refused`); lookup, gate and execution live in the session
   * behind `#toolSeam` — the model's exact gate path, with this
   * extension named as the ask's requester.
   */
  #hostRefused(event: Omit<Extract<AgentEvent, { type: "host_refused" }>, "type">): void {
    this.#emit({ type: "host_refused", ...event });
  }

  #toolHostFor(instance: RuntimeExtension, scopes: readonly string[]): { runTool?: (name: string, args: unknown) => Promise<HostRunToolResult> } {
    if (scopes.length === 0) return {};
    const name = instance.def.name;
    return {
      runTool: async (tool, args): Promise<HostRunToolResult> => {
        const callId = newUlid();
        // Whole-tool grant, per call: the wildcard or an exact name —
        // never argv sub-scoping (ADR-0067).
        const checked = checkScope({ kind: "tool", ref: tool }, scopes);
        if (!checked.ok) {
          this.#hostRefused({ callId, extension: name, op: "run_tool", tool, reason: "outside_scope" });
          return { ok: false, reason: "outside_scope" };
        }
        const seam = this.#toolSeam;
        if (!seam) {
          // No session bound (a bare runtime, a test): the tool cannot
          // run — refused loudly, never silently dropped.
          this.#hostRefused({ callId, extension: name, op: "run_tool", tool, reason: "failed" });
          return { ok: false, reason: "failed", message: "no session is bound to this extension runtime" };
        }
        const result = await seam.runTool({ extension: name, tool, args });
        if (result.ok) {
          this.#emit({ type: "host_op", callId, extension: name, op: "run_tool", tool, outcome: "ok" });
          return { ok: true, output: result.output };
        }
        // An unknown tool is a scope-answer-shaped refusal; a gate refusal
        // ("denied") is a policy answer, not a fault — both log visibly.
        this.#emit(
          result.reason === "unknown_tool"
            ? { type: "host_refused", callId, extension: name, op: "run_tool", tool, reason: "unknown_tool" }
            : { type: "host_op", callId, extension: name, op: "run_tool", tool, outcome: result.reason, ...(result.message !== undefined ? { message: result.message } : {}) },
        );
        return { ok: false, reason: result.reason, ...(result.message !== undefined ? { message: result.message } : {}) };
      },
    };
  }

  /**
   * ADR-0068: the endpoint scope's half of the host seam. Scope + logging
   * live here (the runtime stamps the extension and writes `host_op` /
   * `host_refused`); endpoint resolution, the single-shot Route call, the
   * thinking-capability check and usage accounting live in the session
   * behind `#modelSeam`. One ref per grant, exact match, per call; the
   * model id is never scoped. A refusal is a typed result plus one
   * `host_refused` event — never an exception, never `extension_failed`.
   */
  #endpointHostFor(instance: RuntimeExtension, scopes: readonly string[]): {
    modelCall?: (request: {
      endpoint: string;
      model: string;
      messages: ReadonlyArray<{ role: "system" | "user" | "assistant"; content: string }>;
      thinkingLevel?: ThinkingLevel;
      signal?: AbortSignal;
    }) => Promise<HostModelCallResult>;
    listModels?: (endpoint: string) => Promise<HostListModelsResult>;
  } {
    if (scopes.length === 0) return {};
    const name = instance.def.name;
    const refused = (callId: string, op: HostOpName, reason: Extract<AgentEvent, { type: "host_refused" }>["reason"], model?: string) => {
      this.#hostRefused({ callId, extension: name, op, reason, ...(model !== undefined ? { model } : {}) });
    };
    return {
      modelCall: async (request): Promise<HostModelCallResult> => {
        const callId = newUlid();
        const endpoint = typeof request.endpoint === "string" ? request.endpoint : "";
        const modelRef = `${endpoint}/${typeof request.model === "string" ? request.model : ""}`;
        // One ref per grant, per call: the endpoint name must be one the
        // consent named exactly.
        if (!checkScope({ kind: "endpoint", ref: endpoint }, scopes).ok) {
          refused(callId, "model_call", "outside_scope", modelRef);
          return { ok: false, reason: "outside_scope" };
        }
        const seam = this.#modelSeam;
        if (!seam) {
          refused(callId, "model_call", "failed", modelRef);
          return { ok: false, reason: "failed", message: "no session is bound to this extension runtime" };
        }
        const result = await seam.modelCall({ extension: name, endpoint, model: request.model, messages: request.messages, thinkingLevel: request.thinkingLevel, signal: request.signal });
        if (result.ok) {
          // ADR-0068: no parallel event type — the session's `model_call`
          // record (requester-marked) carries the call; this `host_op` is
          // the seam's own audit line.
          this.#emit({ type: "host_op", callId, extension: name, op: "model_call", outcome: "ok", model: result.model });
          return result;
        }
        if (result.reason === "failed") {
          this.#emit({ type: "host_op", callId, extension: name, op: "model_call", outcome: "failed", model: modelRef, ...(result.message !== undefined ? { message: result.message } : {}) } as AgentEvent);
          return result;
        }
        // unknown_endpoint / unsupported_level: scope-answer-shaped
        // refusals, logged as refusals.
        refused(callId, "model_call", result.reason, modelRef);
        return result;
      },
      listModels: async (endpoint): Promise<HostListModelsResult> => {
        const callId = newUlid();
        if (typeof endpoint !== "string" || !checkScope({ kind: "endpoint", ref: endpoint }, scopes).ok) {
          refused(callId, "list_models", "outside_scope", endpoint);
          return { ok: false, reason: "outside_scope" };
        }
        const seam = this.#modelSeam;
        if (!seam) {
          refused(callId, "list_models", "failed", endpoint);
          return { ok: false, reason: "failed", message: "no session is bound to this extension runtime" };
        }
        const result = await seam.listModels({ endpoint });
        if (result.ok) {
          this.#emit({ type: "host_op", callId, extension: name, op: "list_models", outcome: "ok", model: endpoint });
          return result;
        }
        if (result.reason === "failed") {
          refused(callId, "list_models", "failed", endpoint);
          return result;
        }
        refused(callId, "list_models", result.reason, endpoint);
        return result;
      },
    };
  }

  #fileHostFor(instance: RuntimeExtension, scopes: readonly string[]): Omit<ExtensionHost, "fetch" | "runTool" | "modelCall" | "listModels"> {
    const name = instance.def.name;
    const root = this.#options.projectRoot ?? process.cwd();
    const isDenied = this.#pathDeny ?? this.#options.isPathDenied ?? (() => false);
    const opEvent = (
      op: HostOpName,
      resolved: string,
      extra: { bytes?: number; to?: string } = {},
    ): AgentEvent =>
      ({
        type: "host_op",
        callId: newUlid(),
        extension: name,
        op,
        path: resolved,
        outcome: "ok",
        ...(extra.bytes !== undefined ? { bytes: extra.bytes } : {}),
        ...(extra.to !== undefined ? { to: extra.to } : {}),
      }) as AgentEvent;
    const check = (op: HostOpName, requested: string): { ok: true; resolved: string } | { ok: false; result: HostOpResult } => {
      const checked = checkScope({ kind: "path", path: requested, root, isDenied }, scopes);
      const callId = newUlid();
      if (!checked.ok) {
        this.#hostRefused({
          callId,
          extension: name,
          op,
          path: requested,
          reason: checked.reason,
          ...(checked.resolved !== undefined ? { resolved: checked.resolved } : {}),
        });
        return { ok: false, result: { ok: false, reason: checked.reason, ...(checked.resolved !== undefined ? { resolved: checked.resolved } : {}) } };
      }
      return { ok: true, resolved: checked.resolved };
    };
    const performed = (op: HostOpName, resolved: string, bytes?: number, to?: string): HostOpResult => {
      this.#emit(opEvent(op, resolved, { ...(bytes !== undefined ? { bytes } : {}), ...(to !== undefined ? { to } : {}) }));
      return { ok: true, resolved, ...(bytes !== undefined ? { bytes } : {}) };
    };
    return {
      readFile: (path) => {
        const gate = check("read", path);
        if (!gate.ok) return Promise.resolve(gate.result as HostReadResult);
        try {
          const content = readFileSync(gate.resolved, "utf8");
          this.#emit(opEvent("read", gate.resolved));
          return Promise.resolve({ ok: true, resolved: gate.resolved, content });
        } catch (err) {
          return Promise.resolve({ ok: false as const, reason: "failed", resolved: gate.resolved, message: errMessage(err) });
        }
      },
      writeFile: (path, content) => {
        const gate = check("write", path);
        if (!gate.ok) return Promise.resolve(gate.result);
        try {
          mkdirSync(dirname(gate.resolved), { recursive: true });
          writeFileSync(gate.resolved, content, "utf8");
          return Promise.resolve(performed("write", gate.resolved, Buffer.byteLength(content, "utf8")));
        } catch (err) {
          return Promise.resolve({ ok: false as const, reason: "failed", resolved: gate.resolved, message: errMessage(err) });
        }
      },
      appendFile: (path, content) => {
        const gate = check("append", path);
        if (!gate.ok) return Promise.resolve(gate.result);
        try {
          mkdirSync(dirname(gate.resolved), { recursive: true });
          appendFileSync(gate.resolved, content, "utf8");
          return Promise.resolve(performed("append", gate.resolved, Buffer.byteLength(content, "utf8")));
        } catch (err) {
          return Promise.resolve({ ok: false as const, reason: "failed", resolved: gate.resolved, message: errMessage(err) });
        }
      },
      rename: (from, to) => {
        const fromGate = check("rename", from);
        if (!fromGate.ok) return Promise.resolve(fromGate.result);
        const toGate = check("rename", to);
        if (!toGate.ok) return Promise.resolve(toGate.result);
        try {
          mkdirSync(dirname(toGate.resolved), { recursive: true });
          renameSync(fromGate.resolved, toGate.resolved);
          return Promise.resolve(performed("rename", fromGate.resolved, undefined, toGate.resolved));
        } catch (err) {
          return Promise.resolve({ ok: false as const, reason: "failed", resolved: fromGate.resolved, message: errMessage(err) });
        }
      },
      delete: (path) => {
        const gate = check("delete", path);
        if (!gate.ok) return Promise.resolve(gate.result);
        try {
          const stats = statSync(gate.resolved);
          if (stats.isDirectory()) rmdirSync(gate.resolved);
          else rmSync(gate.resolved);
          return Promise.resolve(performed("delete", gate.resolved));
        } catch (err) {
          return Promise.resolve({ ok: false as const, reason: "failed", resolved: gate.resolved, message: errMessage(err) });
        }
      },
      readlink: (path): Promise<HostReadLinkResult> => {
        const gate = check("readlink", path);
        if (!gate.ok) return Promise.resolve(gate.result);
        try {
          const target = readlinkSync(gate.resolved);
          this.#emit(opEvent("readlink", gate.resolved));
          return Promise.resolve({ ok: true, resolved: gate.resolved, target });
        } catch (err) {
          return Promise.resolve({ ok: false as const, reason: "failed", resolved: gate.resolved, message: errMessage(err) });
        }
      },
    };
  }

  /** ADR-0055: bounded activity of a child this extension spawned. */
  async #subagentActivityFor(instance: RuntimeExtension, callId: string) {
    const host = this.#subagentHost;
    if (!host) return null;
    return host.activityFor(instance.def.name, callId);
  }

  /**
   * ADR-0055 write-into-child (#1222): the steering path. Same ownership
   * rule as `subagentActivity` — only children this extension spawned
   * exist for it, so members can never write into each other — plus the
   * no-grandchildren guard: extension code running on a borrowed (child)
   * session may not steer either.
   */
  async #steerSubagentFor(
    instance: RuntimeExtension,
    callId: string,
    message: string,
  ): Promise<{ callId: string; status: "done" | "error" | "cancelled"; output: string; error?: string } | null> {
    const name = instance.def.name;
    const refuse = (reason: string, message: string) => {
      this.#emitFailed(name, reason, message);
      return { callId, status: "error" as const, output: "", error: message };
    };
    if (this.#borrowedSessions.getStore() !== undefined) {
      return refuse("no_grandchildren", `extension "${name}" attempted to steer from inside a subagent — grandchildren are refused`);
    }
    const host = this.#subagentHost;
    if (!host) {
      return refuse("steer_unavailable", `extension "${name}" holds the spawn-subagent capability but this session exposes no subagent host`);
    }
    try {
      return await host.steerFor(name, callId, message);
    } catch (err) {
      return refuse("steer_failed", errMessage(err));
    }
  }

  /**
   * ADR-0055 "one stop", team-scoped (#1226): the extension stops only
   * the children it spawned. One `orchestration_stopped` chrome event
   * with the `extension` field records the stop; a session-level
   * `stopSubagents()` is unchanged and stays the owner's door.
   */
  #stopSubagentsFor(instance: RuntimeExtension): string[] {
    const name = instance.def.name;
    const host = this.#subagentHost;
    if (!host) {
      this.#emitFailed(name, "stop_unavailable", `extension "${name}" holds the spawn-subagent capability but this session exposes no subagent host`);
      return [];
    }
    const stopped = host.stopForExtension(name);
    if (stopped.length > 0) {
      this.#emit({ type: "orchestration_stopped", callIds: stopped, stoppedAt: new Date().toISOString(), extension: name });
    }
    return stopped;
  }

  /**
   * ADR-0032 `appendEvent`: stamping, validation, size cap, per-turn
   * volume cap, redaction. Every drop is visible — a mutilated or silently
   * swallowed audit entry would be worse than a missing one.
   */
  #appendExtensionEvent(instance: RuntimeExtension, event: ExtensionEventInput): void {
    const name = instance.def.name;
    let rawName = (event ?? ({} as ExtensionEventInput)).name;
    if (typeof rawName !== "string" || rawName.trim() === "") {
      this.#emit({ type: "extension_failed", name, reason: "invalid_event", message: "appendEvent requires a non-empty name" });
      return;
    }
    // ADR-0053 absolute prohibition (mask/alter log events), enforcement
    // point: an extension event is always stamped `extension_event` with
    // its own extension name, and a name that would impersonate the log's
    // chrome is refused outright — the log's record stays the core's.
    if (RESERVED_EVENT_NAMES.has(rawName)) {
      this.#emit({
        type: "extension_failed",
        name,
        reason: "reserved_event_name",
        message: `"${rawName}" is a reserved log event name; extension events are recorded as extension_event`,
      });
      return;
    }
    let payload: unknown;
    if (event.payload !== undefined) {
      try {
        // Redact once: the same value is what gets measured and what gets
        // recorded.
        const redacted = redactPayload(event.payload);
        const serialized = JSON.stringify(redacted);
        // `undefined` back from JSON.stringify: a function/symbol payload —
        // nothing to record, and the event is still well-formed.
        if (serialized !== undefined && Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
          this.#emit({
            type: "extension_failed",
            name,
            reason: "invalid_event",
            message: `payload exceeds the ${MAX_PAYLOAD_BYTES} byte cap`,
          });
          return;
        }
        if (serialized !== undefined) payload = redacted;
      } catch (err) {
        // Cycles, BigInt, throwing getters: dropped, never truncated.
        this.#emit({
          type: "extension_failed",
          name,
          reason: "invalid_event",
          message: `payload is not JSON-serializable (${errMessage(err)})`,
        });
        return;
      }
    }
    // #981: the budget is this dispatch's session's — the owner's, or the
    // borrowing child's that the dispatch runs for.
    const key = this.#currentKey();
    const budget = this.#budget(instance, key);
    budget.eventsThisTurn += 1;
    if (budget.eventsThisTurn > MAX_EVENTS_PER_TURN) {
      // One warning per extension per session per turn: a runaway loop
      // cannot bury the log, and the extension is never silently speechless.
      if (!budget.capWarned) {
        budget.capWarned = true;
        // #981: the warning names the session whose budget it exhausted.
        // Only the pre-session window (a record made before any session
        // owned the runtime, e.g. from `setup`) has no name to give.
        const session = key === OWNER_BUDGET ? "" : ` (${key})`;
        this.#emit({
          type: "extension_failed",
          name,
          reason: "event_cap",
          message: `more than ${MAX_EVENTS_PER_TURN} events in one turn${session}; further events were dropped`,
        });
        // #846: the degraded state is visible, not only logged — the
        // footer status (headless: one stderr line) for the rest of the turn.
        this.#capOverlay(instance, budget, key);
      }
      return;
    }
    this.#emit(
      payload !== undefined
        ? { type: "extension_event", extension: name, name: rawName, payload }
        : { type: "extension_event", extension: name, name: rawName },
    );
  }

  /** ADR-0032 `setStatus`: one ephemeral status per extension, replaced. */
  #setStatus(instance: RuntimeExtension, text: string | null): void {
    const next = typeof text === "string" && text.length > 0 ? text : null;
    // #846: the extension speaks for itself again — the cap overlay of the
    // session that dispatched this drops.
    const key = this.#currentKey();
    const budget = this.#budgetOf(instance, key);
    if (budget) this.#clearCapOverlay(instance, budget, key === this.#ownerKey());
    if (instance.status === next) return;
    instance.status = next;
    for (const listener of this.#statusListeners) listener(instance.def.name, next);
  }

  #emit(event: AgentEvent): void {
    // #944: a dispatch on behalf of a borrowed session writes straight to
    // that session's log — a child's chrome is the child's. Every other
    // emitter is the runtime owner's (load results, reload outcomes, the
    // session's own dispatch): delivered live when that session listens,
    // buffered otherwise (pre-session loads, tests) so exactly one channel
    // ever delivers each event.
    const borrowed = this.#borrowedSessions.getStore();
    if (borrowed) {
      borrowed.write(event);
      return;
    }
    if (this.#listeners.size > 0) {
      for (const listener of this.#listeners) listener(event);
    } else {
      this.#pending.push(event);
    }
  }

  #storeFile(): string {
    return resolve(this.#mohHome, "extensions.json");
  }

  /**
   * ADR-0070: installs (or re-verifies) an extension's declared
   * dependency tree into its own directory under the moh-owned
   * `extension-deps` root, before the extension's setup ever runs. A
   * failure — a scripted dependency, a checksum mismatch, lockfile
   * drift — refuses the load with the reason carried to the user.
   * The moh-owned tarball cache (`extension-deps/.cache/`) is consulted
   * before the network and populated after verification, so a re-install
   * works offline exactly as long as its digests match (AC5).
   */
  async #prepareFileDeps(file: string): Promise<boolean> {
    const manifest = readExtensionManifest(file);
    if (!manifest.ok) return false;
    const deps = manifest.manifest.dependencies;
    if (!deps || Object.keys(deps).length === 0) return true;
    const name = manifest.manifest.name;
    const identity = contentIdentity(file)!;
    const requested = Object.entries(deps).map(([pkg, version]) => `${pkg}@${version}`).sort();
    const store = this.#readStore();
    if (!sameDeps(requested, store.dependencies[identity] ?? [])) {
      if (!await this.#options.authorizeDependencies?.(name, requested)) {
        this.#emitFailed(name, "deps_unauthorized", `user declined dependencies: ${requested.join(", ")}`);
        return false;
      }
    }
    const installed = await this.#installDeps(name, deps);
    const linked = installed.ok ? linkDepsTree(extensionDepsDir(this.#mohHome, name), dirname(file)) : installed;
    if (!linked.ok) {
      this.#emitFailed(name, "deps_install_failed", linked.message);
      return false;
    }
    store.dependencies[identity] = requested;
    this.#writeStore(store);
    return true;
  }

  async #installDeps(name: string, dependencies: Record<string, string>): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      const result = await installExtensionDeps({
        dependencies,
        depsDir: extensionDepsDir(this.#mohHome, name),
        io: this.#options.depsIo ?? realRegistryIo(),
        cache: depsTarballCache(this.#mohHome),
      });
      if (result.ok) return { ok: true };
      return { ok: false, message: `dependency install failed for ${name}: ${result.reason}` };
    } catch (err) {
      return { ok: false, message: `dependency install failed for ${name}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  #readStore(): ExtensionStore {
    const file = this.#storeFile();
    if (!existsSync(file)) return { consents: {}, dependencies: {}, manifests: {} };
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ExtensionStore>;
      return {
        consents: parsed.consents ?? {},
        dependencies: parsed.dependencies ?? {},
        // ADR-0061: stores written before manifests existed simply have none
        // recorded — the next load records the manifest it was asked about.
        manifests: parsed.manifests ?? {},
      };
    } catch {
      return { consents: {}, dependencies: {}, manifests: {} };
    }
  }

  #writeStore(store: ExtensionStore): void {
    // ADR-0053 absolute prohibition: no extension may read or write the
    // consent store — no consent can authorize it. The guard is the
    // enforcement point: entered from extension code, this throws the
    // typed refusal before a byte is written.
    assertNoExtensionScope("consent-files", "read or write the extension consent store (extensions.json)");
    const file = this.#storeFile();
    mkdirSync(this.#mohHome, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(store, null, 2), { mode: 0o600 });
  }

  // ---- Hook dispatch (used by AgentSession) ----

  /**
   * Errors from one dispatch round, as extension_failed events to append.
   * The owner's own bucket: a borrowed session's dispatches collect into
   * its `SessionScope` instead (#944), so two concurrent children never
   * drain each other's failures.
   */
  readonly #hookErrors: AgentEvent[] = [];

  /** #944: one hook failure, into the borrowing session's bucket when there
   * is one, the runtime's otherwise. */
  #recordHookError(event: AgentEvent): void {
    (this.#borrowedSessions.getStore()?.errors ?? this.#hookErrors).push(event);
  }

  async dispatchSessionStart(): Promise<AgentEvent[]> {
    await this.#each("sessionStart", (h) => h({ startedAt: new Date() }));
    return this.#drainErrors();
  }

  async dispatchSessionEnd(reason: string): Promise<AgentEvent[]> {
    await this.#each("sessionEnd", (h) => h({ reason }));
    return this.#drainErrors();
  }

  /**
   * ADR-0033: the turn-start decision point. Fired once per user send,
   * before the provider is read. First hook returning `model` sets it and
   * first returning `confirm` sets it — the two fields are collected
   * independently, in registration order. A throwing hook is fail-open:
   * one `extension_failed { reason: "hook" }` and the turn proceeds.
   */
  async dispatchBeforeTurn(ctx: Parameters<BeforeTurnHook>[0]): Promise<BeforeTurnDispatch> {
    // ADR-0036: the previous turn's notes die here — a stale hint never
    // survives into a context it was not about.
    this.clearTurnNotes();
    let model: string | undefined;
    let modelBy: string | undefined;
    let confirm: BeforeTurnDispatch["confirm"];
    for (const instance of this.#instances) {
      for (const hook of instance.hooks.beforeTurn) {
        // ADR-0056: expired or thrown, the hook contributes nothing.
        const { out, timedOut } = await this.#runCapped(instance, "beforeTurn", () => hook(ctx));
        if (timedOut || !out) continue;
        if (model === undefined && typeof out.model === "string" && out.model.trim() !== "") {
          model = out.model.trim();
          modelBy = instance.def.name;
        }
        if (confirm === undefined && out.confirm && typeof out.confirm.reason === "string") {
          confirm = {
            reason: out.confirm.reason,
            by: instance.def.name,
            ...(typeof out.confirm.onResolved === "function" ? { onResolved: out.confirm.onResolved } : {}),
          };
        }
      }
    }
    return {
      ...(model !== undefined ? { model } : {}),
      ...(modelBy !== undefined ? { modelBy } : {}),
      ...(confirm !== undefined ? { confirm } : {}),
      errors: this.#drainErrors(),
    };
  }

  /**
   * ADR-0034: the post-tool inspection point. Every registered hook whose
   * declared scope names this tool runs, in registration order; the first
   * `withhold` wins and short-circuits the rest. A throwing hook (or a
   * malformed outcome) is fail-open: one `extension_failed` and the
   * original result proceeds to the model — a guardrail that can silently
   * block the agent's work when it misbehaves is worse than one that
   * occasionally misses.
   */
  async checkToolResultHooks(call: {
    callId: string;
    name: string;
    args: unknown;
    output: string;
  }): Promise<ToolResultDispatch> {
    for (const instance of this.#instances) {
      for (const entry of instance.hooks.onToolResult) {
        if (!entry.tools.includes(call.name)) continue;
        // ADR-0056: expired or thrown, the hook contributes nothing —
        // the original result proceeds to the model.
        const { out, timedOut } = await this.#runCapped(instance, "onToolResult", () => entry.hook(call));
        if (timedOut || !out) continue;
        const reason = out.withhold?.reason;
        if (typeof reason !== "string" || reason.trim() === "") {
          // A withhold with no reason would replace the result with an
          // unexplained refusal the model cannot act on: refused, visibly.
          this.#recordHookError({
            type: "extension_failed",
            name: instance.def.name,
            reason: "invalid_withhold",
            message: "withhold requires a non-empty reason; the result was not withheld",
          });
          continue;
        }
        return {
          withheld: withheldResultText(instance.def.name, reason.trim()),
          by: instance.def.name,
          errors: this.#drainErrors(),
        };
      }
    }
    return { errors: this.#drainErrors() };
  }

  /**
   * ADR-0035: the compaction section-filter dispatch. Every registered
   * hook runs (each sees the same offered sections); the union of the
   * returned drops is the requested cut. Fail-open: a throwing hook is
   * one visible `extension_failed { reason: "hook" }` and no drops; an id
   * that was not offered is ignored and recorded as
   * `extension_failed { reason: "unknown_section" }`. The caller (the
   * compaction runner) applies the survival floor and renders — this
   * dispatch only collects.
   *
   * #979: each hook gets its own window (`hookTimeoutMs`, from the call),
   * told to it in the context and materialized as an abort signal, so a
   * hook whose work scales with the span can fit itself inside it and stop
   * when the runtime gives up. A hook that answered *after* the window
   * closed is abandoned — no drops — but its `onApplied` still runs, once,
   * with `applied: false`: a judgment that reached nothing must be able to
   * say so instead of looking like one that found nothing.
   */
  async dispatchCompaction(
    ctx: CompactionHookContext,
    hookTimeoutMs = 5_000,
  ): Promise<{
    drop: string[];
    errors: AgentEvent[];
    /** ADR-0035: the one callback the runner invokes with the applied cut. */
    onApplied: ((applied: AppliedCut) => void)[];
  }> {
    const offered = new Set(ctx.sections.map((s) => s.id));
    const offeredBytes = ctx.sections.reduce((sum, s) => sum + s.bytes, 0);
    const drop: string[] = [];
    const onApplied: ((applied: AppliedCut) => void)[] = [];
    for (const instance of this.#instances) {
      for (const hook of instance.hooks.onCompaction) {
        let timedOut = false;
        let out: CompactionHookResult | void;
        // #979: the hook's own budget — the window it is told about, and
        // the signal that fires when the runtime stops waiting.
        const abandoned = new AbortController();
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const pending = (async () =>
          // ADR-0053: extension code runs marked (see #runCapped).
          runInExtensionScope(instance.def.name, () =>
            hook({
              ...ctx,
              hookTimeoutMs,
              signal: abandoned.signal,
            }),
          ))();
        // A late answer is not worthless: it still tells its own author the
        // cut never landed. Registered before the race so no resolution can
        // slip past it, and only acted on when the window actually won.
        void pending
          .then((late) => {
            if (!timedOut || !late || typeof late.onApplied !== "function") return;
            try {
              late.onApplied({ keptByFloor: false, bytesAfter: offeredBytes, droppedIds: [], applied: false });
            } catch {
              /* observability only */
            }
          })
          .catch(() => {
            /* already recorded as a hook error by the race below */
          });
        try {
          // The one ADR-0035 fail-open leg the throw does not cover: a hook
          // that never answers must not stall a background compaction.
          // (The window is per hook; every section of this hook shares it.)
          out = await Promise.race([
            pending,
            new Promise<undefined>((resolve) => {
              deadline = setTimeout(() => {
                timedOut = true;
                abandoned.abort();
                resolve(undefined);
              }, hookTimeoutMs);
            }),
          ]);
        } catch (err) {
          this.#recordHookError({
            type: "extension_failed",
            name: instance.def.name,
            reason: "hook",
            message: errMessage(err),
          });
          continue;
        } finally {
          // A settled hook leaves no timer behind — and the flag stays
          // false, so the late-answer path above never fires for it.
          if (deadline !== undefined) clearTimeout(deadline);
        }
        if (timedOut) {
          this.#recordHookError({
            type: "extension_failed",
            name: instance.def.name,
            reason: "hook",
            message: `the compaction hook did not answer within ${hookTimeoutMs}ms; no drops were applied`,
          });
        }
        if (!out || !Array.isArray(out.drop)) continue;
        for (const id of out.drop) {
          if (typeof id === "string" && !offered.has(id)) {
            this.#recordHookError({
              type: "extension_failed",
              name: instance.def.name,
              reason: "unknown_section",
              message: `drop named a section that was not offered: ${String(id).slice(0, 64)}`,
            });
          }
        }
        for (const id of out.drop) {
          if (typeof id !== "string" || !offered.has(id) || drop.includes(id)) continue;
          drop.push(id);
        }
        if (typeof out.onApplied === "function") onApplied.push(out.onApplied);
      }
    }
    return { drop, onApplied, errors: this.#drainErrors() };
  }

  /**
   * ADR-0054 + ADR-0056 (#1126): the composed deadline dispatch. The hook
   * itself runs to the turn-path ceiling (default 30 s); only the
   * returned prompt-section replacement is judged against the shorter
   * ADR-0054 window (default 5 s). Outcomes per hook:
   *
   * - answers within the replacement window → its `sections` count, in
   *   registration order;
   * - answers between the window and the ceiling → the replacement is
   *   forfeit (the core's own text serves that call, one visible record
   *   says so) but the hook's other contributions still count;
   * - never answers within the ceiling → it contributes nothing, one
   *   visible record says so, and it is not retried within the turn.
   */
  async dispatchBeforeModelCall(ctx: Parameters<BeforeModelCallHook>[0]): Promise<BeforeModelCallDispatch> {
    const replacements: BeforeModelCallDispatch["replacements"] = [];
    const timeouts: BeforeModelCallDispatch["timeouts"] = [];
    // The sentinel keeps a hook's own `void` return distinguishable from
    // a lost race, and the ceiling from the hook's own answer.
    const WINDOW_LOST = Symbol("replacement_window_lost");
    const CEILING_HIT = Symbol("hook_ceiling_hit");
    for (const instance of this.#instances) {
      for (const hook of instance.hooks.beforeModelCall) {
        // The composed clocks (ADR-0054 + ADR-0056): the hook promise is
        // raced against the replacement window first, then — if the
        // window is lost — against the ceiling for the REST of its own
        // budget. A lost window forfeits only the sections; the hook's
        // other work still counts until the ceiling.
        const started = Date.now();
        let windowTimer: ReturnType<typeof setTimeout> | undefined;
        let ceilingTimer: ReturnType<typeof setTimeout> | undefined;
        let failed = false;
        let failure: unknown;
        const pending = (async () => {
          try {
            // ADR-0053: extension code runs marked (see #runCapped).
            return await runInExtensionScope(instance.def.name, () => hook(ctx));
          } catch (err) {
            failed = true;
            failure = err;
            return undefined;
          }
        })();
        const window = new Promise<symbol>((resolve) => {
          windowTimer = setTimeout(() => resolve(WINDOW_LOST), this.#replacementWindowMs);
        });
        let out = await Promise.race([pending, window]);
        if (windowTimer !== undefined) clearTimeout(windowTimer);
        if (out === WINDOW_LOST) {
          // The replacement is forfeit; the core's own text serves this
          // call. One visible record says so. The hook keeps its
          // remaining budget to the ceiling.
          timeouts.push({ by: instance.def.name, window: "replacement" });
          this.#recordHookError({
            type: "extension_failed",
            name: instance.def.name,
            reason: "replacement_timeout",
            message: `the beforeModelCall hook answered after the ${this.#replacementWindowMs}ms replacement window; the core's own sections serve this call`,
          });
          const elapsed = Date.now() - started;
          const remaining = Math.max(0, this.#hookTimeoutMs - elapsed);
          const ceiling = new Promise<symbol>((resolve) => {
            ceilingTimer = setTimeout(() => resolve(CEILING_HIT), remaining);
          });
          out = await Promise.race([pending, ceiling]);
          if (ceilingTimer !== undefined) clearTimeout(ceilingTimer);
          if (out === CEILING_HIT) {
            timeouts.push({ by: instance.def.name, window: "hook" });
            this.#recordHookError({
              type: "extension_failed",
              name: instance.def.name,
              reason: "hook_timeout",
              message: `the beforeModelCall hook did not answer within ${this.#hookTimeoutMs}ms; it contributed nothing`,
            });
            continue;
          }
          // Answered late: its other contributions counted (they already
          // happened); the forfeited replacement is not revived.
          if (failed) {
            this.#recordHookError({
              type: "extension_failed",
              name: instance.def.name,
              reason: "hook",
              message: errMessage(failure),
            });
          }
          continue;
        }
        if (failed) {
          this.#recordHookError({
            type: "extension_failed",
            name: instance.def.name,
            reason: "hook",
            message: errMessage(failure),
          });
          continue;
        }
        const answered = (out ?? {}) as BeforeModelCallResult;
        if (answered.sections && typeof answered.sections === "object") {
          replacements.push({
            by: instance.def.name,
            version: instance.def.version,
            capabilities: instance.def.capabilities ?? [],
            sections: answered.sections,
          });
        }
      }
    }
    return { replacements, timeouts, errors: this.#drainErrors() };
  }

  /**
   * ADR-0059: the retry-on-model-error decision point. Fired once per
   * failed provider call whose error kind the Route does not already
   * handle. First hook returning `model` wins, in registration order. A
   * throwing hook is fail-open: one `extension_failed { reason: "hook" }`
   * and no proposal is recorded — the caller ends the turn as it always
   * did. A hook that returns no ref contributes nothing.
   */
  async dispatchModelError(ctx: Parameters<ModelErrorHook>[0]): Promise<{ model?: string; by?: string; errors: AgentEvent[] }> {
    for (const instance of this.#instances) {
      for (const hook of instance.hooks.onModelError) {
        let out: ModelErrorResult | void;
        try {
          out = await hook(ctx);
        } catch (err) {
          this.#recordHookError({
            type: "extension_failed",
            name: instance.def.name,
            reason: "hook",
            message: errMessage(err),
          });
          continue;
        }
        if (out && typeof out.model === "string" && out.model !== "") {
          return { model: out.model, by: instance.def.name, errors: this.#drainErrors() };
        }
      }
    }
    return { errors: this.#drainErrors() };
  }

  async dispatchEvent(event: AgentEvent): Promise<AgentEvent[]> {
    // ADR-0038: a client command reaches the extension it names, and only
    // that one — one extension's control payload must never be another's
    // (the guardrail also listens on `onEvent`).
    if (event.type === "extension_control") {
      const target = this.#instances.find((i) => i.def.name === event.extension);
      if (target) {
        await this.#each("onEvent", (h) => h({ event: event as unknown as ExtensionEvent }), [target]);
      }
      return this.#drainErrors();
    }
    await this.#each("onEvent", (h) => h({ event: event as unknown as ExtensionEvent }));
    return this.#drainErrors();
  }

  async dispatchAfterTurn(result: { status: string; reason?: string; message?: string }, synthetic = false): Promise<AgentEvent[]> {
    // ADR-0056: afterTurn is a turn-path hook — each invocation runs
    // under the ceiling.
    await this.#each("afterTurn", (h) => h({ result, ...(synthetic ? { synthetic: true as const } : {}) }), undefined, this.#hookTimeoutMs);
    return this.#drainErrors();
  }

  /**
   * First decision wins, in registration order. Veto outranks user rules
   * and defaults (and applies even in yolo mode): extensions only restrict.
   * ADR-0031: a hook may instead `ask` — hand the call to the human
   * consent flow. `veto` wins when a hook returns both.
   */
  async checkToolHooks(
    call: { callId: string; name: string; args: unknown },
  ): Promise<{ veto: boolean; ask: boolean; reason?: string; by?: string; errors: AgentEvent[] }> {
    for (const instance of this.#instances) {
      for (const hook of instance.hooks.onToolCall) {
        // ADR-0056: expired or thrown, the hook contributes nothing — a
        // silence never vetoes, never asks.
        const { out, timedOut } = await this.#runCapped(instance, "onToolCall", () => hook(call));
        if (timedOut || !out) continue;
        if (out.veto || out.ask) {
          return {
            veto: out.veto === true,
            ask: out.veto !== true && out.ask === true,
            reason: out.reason,
            by: instance.def.name,
            errors: this.#drainErrors(),
          };
        }
      }
    }
    return { veto: false, ask: false, errors: this.#drainErrors() };
  }

  async #each<K extends keyof HookSet>(
    key: K,
    invoke: (hook: HookSet[K][number]) => Promise<void> | void,
    only?: readonly RuntimeExtension[],
    /** ADR-0056: pass a ceiling to run each invocation under the turn-path wall clock. */
    hookTimeoutMs?: number,
  ): Promise<void> {
    for (const instance of only ?? this.#instances) {
      for (const hook of instance.hooks[key]) {
        if (hookTimeoutMs !== undefined) {
          await this.#runCapped(instance, String(key), () => invoke(hook), hookTimeoutMs);
          continue;
        }
        try {
          // ADR-0053: extension code runs marked (see #runCapped).
          await (runInExtensionScope(instance.def.name, () => invoke(hook)) as Promise<void> | void);
        } catch (err) {
          this.#recordHookError({
            type: "extension_failed",
            name: instance.def.name,
            reason: "hook",
            message: errMessage(err),
          });
        }
      }
    }
  }

  #drainErrors(): AgentEvent[] {
    const borrowed = this.#borrowedSessions.getStore();
    if (borrowed) return borrowed.errors.splice(0, borrowed.errors.length);
    return this.#hookErrors.splice(0, this.#hookErrors.length);
  }

  /**
   * ADR-0066: the `host:<domain>` scope's execution path. One check-scope
   * module decides every request and every redirect hop
   * (`checkHostScope`); a refusal is a typed result plus one
   * `host_refused` event — never an exception, never an
   * `extension_failed`; a completed request is one `host_op` event with
   * the final host, path, status and byte count. The response is fully
   * buffered bytes with a fixed size limit (`too_large` past it); no
   * streaming in this phase. Under `host:` alone the request is
   * anonymous — an authenticated request needs the matching
   * `credential:<ref>` scope too (F2b owns custody and injection).
   */
  #networkHostFor(instance: RuntimeExtension, scopes: readonly string[]): { fetch?: (url: string, options?: HostFetchOptions) => Promise<HostFetchResult> } {
    if (scopes.length === 0) return {};
    const name = instance.def.name;
    // ADR-0066: the host deny seam is its own callback — path rules never
    // match hostnames. Absent, no deny check runs.
    const isDenied = this.#options.isHostDenied ?? (() => false);
    return {
      fetch: async (raw: string, options?: HostFetchOptions): Promise<HostFetchResult> => {
        // #1162: the request side. GET (default) or POST; a body is POST-
        // only and capped by the same fixed limit the response is — a
        // mis-sized request is a typed refusal, never a silent truncation.
        const method = options?.method === "POST" ? "POST" : "GET";
        if (options?.body !== undefined && method !== "POST") {
          this.#hostRefused({ callId: newUlid(), extension: name, op: "fetch", path: String(raw), reason: "failed", method });
          return { ok: false, reason: "failed", message: "a request body requires method POST" };
        }
        const bodyBytes: Uint8Array | undefined =
          options?.body === undefined ? undefined
          : typeof options.body === "string" ? new TextEncoder().encode(options.body)
          : options.body;
        if (bodyBytes !== undefined && bodyBytes.byteLength > MAX_FETCH_BYTES) {
          this.#hostRefused({ callId: newUlid(), extension: name, op: "fetch", path: String(raw), reason: "too_large", method });
          return { ok: false, reason: "too_large", message: `request body exceeds the ${MAX_FETCH_BYTES} byte limit` };
        }
        const contentType = options?.contentType ?? (bodyBytes !== undefined ? "application/json" : undefined);
        // ADR-0069: an authenticated request needs the matching
        // `credential:<ref>` scope granted (the intersection of two
        // grants). Under `host:` alone the request stays anonymous.
        let credentialRef: string | undefined;
        let credentialValue: string | undefined;
        if (options?.credential !== undefined) {
          const ref = String(options.credential);
          const granted = checkScope({ kind: "credential", ref }, scopes).ok;
          if (!granted) {
            this.#hostRefused({ callId: newUlid(), extension: name, op: "fetch", path: String(raw), reason: "outside_scope", credential: ref });
            return { ok: false, reason: "outside_scope", message: `no credential:<${ref}> scope granted` };
          }
          // Resolve host-side, just before the request: the value lives
          // only in this closure — never in the seam's return shape.
          credentialValue = this.#options.credentialStore?.get(ref);
          if (credentialValue === undefined) {
            this.#hostRefused({ callId: newUlid(), extension: name, op: "fetch", path: String(raw), reason: "unknown_credential", credential: ref });
            return { ok: false, reason: "unknown_credential" };
          }
          credentialRef = ref;
        }
        const headers: Record<string, string> = {};
        if (credentialValue !== undefined) headers.authorization = `Bearer ${credentialValue}`;
        if (contentType !== undefined) headers["content-type"] = contentType;
        let current: URL;
        try {
          current = new URL(raw);
        } catch {
          this.#hostRefused({ callId: newUlid(), extension: name, op: "fetch", path: String(raw), reason: "invalid_url" });
          return { ok: false, reason: "invalid_url", message: "not a valid URL" };
        }
        let origin = "";
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          const callId = newUlid();
          const checked = checkScope({ kind: "host", url: current, isDenied }, scopes);
          if (!checked.ok) {
            this.#hostRefused({
              callId,
              extension: name,
              op: "fetch",
              path: `${current.pathname}${current.search}`,
              reason: checked.reason,
              ...(checked.target !== undefined ? { target: checked.target } : {}),
            });
            return { ok: false, reason: checked.reason, ...(checked.target !== undefined ? { target: checked.target } : {}) };
          }
          let response: Response;
          try {
            // `redirect: "manual"`: every hop is our own scope decision,
            // never the fetch implementation's. The credential rides
            // every in-scope hop (ADR-0069); a POST replays its body —
            // the request was one operation, the hops are transport.
            response = await fetch(current, {
              redirect: "manual",
              method,
              ...(bodyBytes !== undefined ? { body: bodyBytes as BodyInit } : {}),
              ...(Object.keys(headers).length > 0 ? { headers } : {}),
              ...(options?.signal !== undefined ? { signal: options.signal } : {}),
            });
          } catch (err) {
            this.#hostRefused({ callId, extension: name, op: "fetch", path: `${current.pathname}${current.search}`, reason: "failed", method });
            return { ok: false, reason: "failed", message: errMessage(err) };
          }
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (location === null) {
              // A redirect with no destination: nothing to follow — serve
              // the 3xx body as the answer, like any other status.
              return await this.#consumeFetchResponse(instance, callId, current, response, credentialRef, method);
            }
            let next: URL;
            try {
              next = new URL(location, current);
            } catch {
              this.#hostRefused({ callId, extension: name, op: "fetch", path: `${current.pathname}${current.search}`, reason: "failed" });
              return { ok: false, reason: "failed", message: `redirect target is not a valid URL: ${location}` };
            }
            if (next.origin === origin) {
              // A loop back to an origin already visited: refuse rather
              // than spin to the hop ceiling.
              this.#hostRefused({
                callId,
                extension: name,
                op: "fetch",
                path: `${next.pathname}${next.search}`,
                reason: "outside_scope",
                target: next.host,
              });
              return { ok: false, reason: "outside_scope", target: next.host, message: "redirect loop" };
            }
            origin = current.origin;
            current = next;
            continue;
          }
          return await this.#consumeFetchResponse(instance, callId, current, response, credentialRef, method);
        }
        this.#hostRefused({ callId: newUlid(), extension: name, op: "fetch", path: `${current.pathname}${current.search}`, reason: "outside_scope", target: current.host });
        return { ok: false, reason: "outside_scope", target: current.host, message: `more than ${MAX_REDIRECTS} redirects` };
      },
    };
  }

  /** Buffers one in-scope response within the size limit and logs it.
   * The cap is enforced mid-read: a chunked response that oversizes is
   * aborted while streaming, never fully buffered first. */
  async #consumeFetchResponse(instance: RuntimeExtension, callId: string, url: URL, response: Response, credentialRef?: string, method?: string): Promise<HostFetchResult> {
    const name = instance.def.name;
    const pathAndQuery = `${url.pathname}${url.search}`;
    const tooLarge = (): HostFetchResult => {
      this.#hostRefused({ callId, extension: name, op: "fetch", path: pathAndQuery, reason: "too_large", target: url.host });
      return { ok: false, reason: "too_large", message: `response exceeds the ${MAX_FETCH_BYTES} byte limit` };
    };
    // Enforce the cap on the body as it arrives: consume the stream in
    // chunks and refuse the moment the limit is crossed — a lying or
    // absent content-length cannot make the host swallow 10 GB.
    const reader = response.body?.getReader();
    if (!reader) {
      this.#hostRefused({ callId, extension: name, op: "fetch", path: pathAndQuery, reason: "failed", target: url.host });
      return { ok: false, reason: "failed", message: "response has no readable body" };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FETCH_BYTES) {
        await reader.cancel();
        return tooLarge();
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.#emit({
      type: "host_op",
      callId,
      extension: name,
      op: "fetch",
      path: pathAndQuery,
      outcome: "ok",
      host: url.host,
      status: response.status,
      bytes: total,
      ...(credentialRef !== undefined ? { credential: credentialRef } : {}),
      ...(method !== undefined ? { method } : {}),
    });
    return { ok: true, status: response.status, bytes: merged, finalHost: url.host };
  }
}
