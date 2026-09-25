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
import { readFileSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import {
  MOH_EXTENSION_API_VERSION,
  parseApiVersion,
  type ExtensionDefinition,
  type ExtensionDependencies,
  type ExtensionSetupContext,
  type BeforeTurnHook,
  type BeforeModelCallHook,
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
import type { AgentEvent, ExtensionStatus } from "./types";

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
}

export interface ExtensionRuntimeOptions {
  /** User-level moh dir. Consent + dependency approvals persist in `<mohHome>/extensions.json`. Default `~/.moh`. */
  mohHome?: string;
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
}

/** `register` options: trust is a property of the code being registered,
 * not of the runtime that hosts it. */
export interface RegisterOptions {
  /** The host shipped these bytes (bundled first-party code): consent and
   * dependency authorization are skipped. Never for a path-loaded module. */
  bundled?: boolean;
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
}

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
}

const EMPTY_HOOKS = (): HookSet => ({
  sessionStart: [],
  sessionEnd: [],
  beforeTurn: [],
  beforeModelCall: [],
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

/**
 * ADR-0032 redaction heuristic: keys whose normalized form (lowercased,
 * `_` and `-` stripped) is EXACTLY one of these have their value replaced
 * before the payload reaches the log. Exact match on purpose — `tokens`
 * and `tokenCount` survive. A safety net, not a guarantee: an extension
 * must never put a credential in a payload in the first place.
 */
const REDACTED_KEYS = new Set([
  "apikey",
  "apitoken",
  "accesstoken",
  "refreshtoken",
  "token",
  "secret",
  "clientsecret",
  "password",
  "passwd",
  "authorization",
  "credentials",
  "privatekey",
  "sessionkey",
]);

/** Nesting depth the redaction walks (deeper values pass through). */
const REDACT_DEPTH = 6;

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

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

/** Returns a structurally-redacted copy of the payload (ADR-0032). */
function redactPayload(value: unknown, depth = 0): unknown {
  if (depth > REDACT_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => redactPayload(v, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACTED_KEYS.has(normalizeKey(k)) ? "[redacted]" : redactPayload(v, depth + 1);
    }
    return out;
  }
  return value;
}

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
  readonly #mohHome: string;
  readonly #instances: RuntimeExtension[] = [];
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
   */
  async #ensureConsent(
    identity: string,
    info: { file?: string; hash?: string; name?: string; version?: string },
    bundled: boolean,
  ): Promise<{ ok: true } | { ok: false; reason: string; message: string }> {
    if (bundled) return { ok: true };
    const store = this.#readStore();
    if (store.consents[identity]) return { ok: true };
    if (!this.#options.consent) {
      const message = "extension not previously enabled and no consent flow is available";
      // The host's own channel (a headless client's stderr): the log
      // carries the same fact, but nobody reads a log they never saw.
      this.#options.onWarning?.(`extension ${info.name ?? info.file ?? identity}: not loaded — ${message}`);
      return { ok: false, reason: "consent", message };
    }
    let granted: boolean;
    try {
      granted = await this.#options.consent({
        ...(info.file ? { file: info.file } : {}),
        ...(info.hash ? { hash: info.hash } : {}),
        ...(info.name ? { name: info.name } : {}),
        ...(info.version ? { version: info.version } : {}),
      });
    } catch (err) {
      return { ok: false, reason: "consent", message: errMessage(err) };
    }
    if (!granted) return { ok: false, reason: "consent", message: "user declined to enable the extension" };
    store.consents[identity] = true;
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
    const gate = await this.#ensureConsent(identity, { file: abs, hash: identityHash(identity) }, false);
    if (!gate.ok) {
      this.#emitFailed(basename(abs), gate.reason, gate.message);
      return false;
    }
    let def: unknown;
    try {
      def = await importDefinition(abs);
    } catch (err) {
      this.#emitFailed(basename(abs), "load_failed", errMessage(err));
      return false;
    }
    return this.#load(def, abs);
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
    // #834 (security): the edited bytes are consented BEFORE they are
    // imported. A reload evaluates the new file, so an edit the user has not
    // answered for must not run: the ask names the extension (the previous
    // instance knows it) and its new hash, and a refusal keeps the previous
    // instance in place.
    const identity = contentIdentity(file);
    if (identity) {
      const gate = await this.#ensureConsent(
        identity,
        { file, hash: identityHash(identity), name: previous.def.name, version: previous.def.version },
        false,
      );
      if (!gate.ok) {
        this.#options.onWarning?.(`extension ${previous.def.name}: reload refused (${gate.reason}); previous instance kept`);
        this.#emitFailed(previous.def.name, "reload_failed", `${gate.reason}: ${gate.message}; previous instance kept`);
        return;
      }
    }
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
    const fresh = await this.#instantiate(def, file, previous.state);
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
    this.#emit({ type: "extension_loaded", name: fresh.instance.def.name, version: fresh.instance.def.version });
  }

  async #load(def: unknown, file: string | undefined, options: RegisterOptions = {}): Promise<boolean> {
    const result = await this.#instantiate(def, file, undefined, options);
    if (!result.ok) {
      this.#emitFailed(result.name ?? basename(file ?? "(unknown)"), result.reason, result.message);
      return false;
    }
    this.#instances.push(result.instance);
    this.#emit({ type: "extension_loaded", name: result.instance.def.name, version: result.instance.def.version });
    return true;
  }

  /** Validation + policy + setup for one candidate definition. No side effects on failure. */
  async #instantiate(
    def: unknown,
    file: string | undefined,
    seedState?: Record<string, unknown>,
    options: RegisterOptions = {},
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
    const consent = await this.#ensureConsent(
      identity,
      { ...(file ? { file } : {}), ...(hash ? { hash } : {}), name, version: d.version },
      bundled,
    );
    if (!consent.ok) return { ok: false, name, reason: consent.reason, message: consent.message };
    // Per-change dependency authorization, bound to the same content identity.
    const deps = d.dependencies ?? [];
    const approved = store.dependencies[identity] ?? [];
    if (!bundled && !sameDeps(deps, approved)) {
      if (deps.length > 0 && !this.#options.authorizeDependencies) {
        // Honest refusal (v1, #834): no host installs dependencies yet, so
        // an extension that needs them cannot run — never a half-promise.
        return { ok: false, name, reason: "deps_unauthorized", message: `extension declares dependencies (${deps.join(", ")}) and this host cannot install them` };
      }
      if (deps.length > 0) {
        let granted: boolean;
        try {
          granted = await this.#options.authorizeDependencies!(name, deps);
        } catch (err) {
          return { ok: false, name, reason: "deps_unauthorized", message: errMessage(err) };
        }
        if (!granted) {
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
    };
    const ctx: ExtensionSetupContext = {
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
   * ADR-0032 `appendEvent`: stamping, validation, size cap, per-turn
   * volume cap, redaction. Every drop is visible — a mutilated or silently
   * swallowed audit entry would be worse than a missing one.
   */
  #appendExtensionEvent(instance: RuntimeExtension, event: ExtensionEventInput): void {
    const name = instance.def.name;
    const rawName = (event ?? ({} as ExtensionEventInput)).name;
    if (typeof rawName !== "string" || rawName.trim() === "") {
      this.#emit({ type: "extension_failed", name, reason: "invalid_event", message: "appendEvent requires a non-empty name" });
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

  #readStore(): ExtensionStore {
    const file = this.#storeFile();
    if (!existsSync(file)) return { consents: {}, dependencies: {} };
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ExtensionStore>;
      return { consents: parsed.consents ?? {}, dependencies: parsed.dependencies ?? {} };
    } catch {
      return { consents: {}, dependencies: {} };
    }
  }

  #writeStore(store: ExtensionStore): void {
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
        let out: BeforeTurnResult | void;
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
        if (!out) continue;
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
        let out: ToolResultHookResult | void;
        try {
          out = await entry.hook(call);
        } catch (err) {
          this.#recordHookError({
            type: "extension_failed",
            name: instance.def.name,
            reason: "hook",
            message: errMessage(err),
          });
          continue;
        }
        if (!out) continue;
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
          hook({
            ...ctx,
            hookTimeoutMs,
            signal: abandoned.signal,
          }))();
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

  async dispatchBeforeModelCall(ctx: Parameters<BeforeModelCallHook>[0]): Promise<AgentEvent[]> {
    await this.#each("beforeModelCall", (h) => h(ctx));
    return this.#drainErrors();
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
    await this.#each("afterTurn", (h) => h({ result, ...(synthetic ? { synthetic: true as const } : {}) }));
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
        let out: ToolCallHookResult | void;
        try {
          out = await hook(call);
        } catch (err) {
          this.#recordHookError({
            type: "extension_failed",
            name: instance.def.name,
            reason: "hook",
            message: errMessage(err),
          });
          continue;
        }
        if (out && (out.veto || out.ask)) {
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
  ): Promise<void> {
    for (const instance of only ?? this.#instances) {
      for (const hook of instance.hooks[key]) {
        try {
          await (invoke(hook) as Promise<void> | void);
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
}
