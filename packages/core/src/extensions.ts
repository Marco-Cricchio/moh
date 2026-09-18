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
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import {
  MOH_EXTENSION_API_VERSION,
  parseApiVersion,
  type ExtensionDefinition,
  type ExtensionDependencies,
  type ExtensionSetupContext,
  type BeforeModelCallHook,
  type EventHook,
  type ExtensionEvent,
  type ExtensionEventInput,
  type AfterTurnHook,
  type SessionEndHook,
  type SessionStartHook,
  type ToolCallHook,
  type ToolCallHookResult,
} from "@moh/extension";
import type { AgentEvent } from "./types";

export interface ExtensionRuntimeOptions {
  /** User-level moh dir. Consent + dependency approvals persist in `<mohHome>/extensions.json`. Default `~/.moh`. */
  mohHome?: string;
  /**
   * One-time enable consent. Called only when no stored consent matches
   * loaded module content identity. A `true` answer is persisted; `false`
   * refuses the load. When absent and nothing is stored, the load is refused.
   */
  consent?: (name: string, version: string) => Promise<boolean> | boolean;
  /**
   * Per-change npm dependency authorization. Called whenever the
   * extension's dependency list differs from the remembered approved list.
   * `true` persists the new list; `false` refuses the load. When absent
   * and the list is non-empty and not approved, the load is refused.
   */
  authorizeDependencies?: (name: string, deps: ExtensionDependencies) => Promise<boolean> | boolean;
  /** Non-event-log diagnostics (e.g. hot-reload outcomes mid-session). */
  onWarning?: (message: string) => void;
  /**
   * Trust the registered definitions because the host shipped them
   * (bundled first-party code, ADR-0005/ADR-0031): the one-time enable
   * consent and the dependency authorization are skipped — the shipped
   * bytes never came from the user's disk. Never set this for definitions
   * loaded from a path.
   */
  bundledTrust?: boolean;
}

interface HookSet {
  sessionStart: SessionStartHook[];
  sessionEnd: SessionEndHook[];
  beforeModelCall: BeforeModelCallHook[];
  onToolCall: ToolCallHook[];
  onEvent: EventHook[];
  afterTurn: AfterTurnHook[];
}

/** One live extension instance inside the runtime. */
export interface RuntimeExtension {
  readonly def: ExtensionDefinition;
  /** Per-extension state, preserved across hot-reloads. */
  state: Record<string, unknown>;
  /** Prompt notes appended via `ctx.appendToPrompt`, in call order. */
  readonly notes: string[];
  readonly hooks: HookSet;
  /** Source file when loaded via `registerFile` (hot-reloadable). */
  readonly file?: string;
  /** ADR-0032: the extension's published footer status; null = none. Ephemeral. */
  status: string | null;
  /** ADR-0032: `extension_event`s appended in the current turn (50/turn cap). */
  eventsThisTurn: number;
  /** ADR-0032: the per-turn cap warning was already emitted (one per turn). */
  capWarned: boolean;
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
  beforeModelCall: [],
  onToolCall: [],
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

/** ADR-0032 cap: extension events per extension, per turn. */
const MAX_EVENTS_PER_TURN = 50;

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

/** File modules are consented by location and exact bytes, never self-claimed metadata. */
function contentIdentity(file: string | undefined): string | null {
  if (!file) return null;
  try {
    const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
    return `${resolve(file)}:${hash}`;
  } catch {
    return null;
  }
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
  /** ADR-0032: subscribers of status publishes (extension name + text|null). */
  readonly #statusListeners = new Set<(extension: string, text: string | null) => void>();
  readonly #watchers = new Map<string, FSWatcher>();
  readonly #reloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** In-flight registrations (the setup of a bundled definition is async). */
  readonly #registering: Promise<unknown>[] = [];

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

  /** Drain load events (extension_loaded / extension_failed) recorded so far. */
  consumeLoadEvents(): AgentEvent[] {
    return this.#pending.splice(0, this.#pending.length);
  }

  /** Subscribe to runtime events (load results, hot-reload outcomes). */
  onLoadEvent(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** ADR-0032: subscribe to status publishes; returns an unsubscribe fn. */
  onStatusChange(listener: (extension: string, text: string | null) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  /** ADR-0032: the currently published statuses, in registration order. */
  statuses(): { extension: string; text: string }[] {
    return this.#instances
      .filter((i) => i.status !== null)
      .map((i) => ({ extension: i.def.name, text: i.status! }));
  }

  /** Clears every published status (session end, extension reload). */
  clearStatuses(): void {
    for (const instance of this.#instances) {
      if (instance.status === null) continue;
      instance.status = null;
      for (const listener of this.#statusListeners) listener(instance.def.name, null);
    }
  }

  /**
   * ADR-0032: starts a new turn — the per-extension `extension_event` cap
   * counts per turn, so the session calls this when a turn begins.
   */
  beginTurn(): void {
    for (const instance of this.#instances) {
      instance.eventsThisTurn = 0;
      instance.capWarned = false;
    }
  }

  /** True while a registration started earlier has not settled yet. */
  hasPendingRegistrations(): boolean {
    return this.#registering.length > 0;
  }

  /**
   * Resolves when every registration started so far has settled (the
   * bundled-definition path registers fire-and-forget from the assembly;
   * the first turn waits on this so a hook is never missing).
   */
  async ready(): Promise<void> {
    while (this.#registering.length > 0) await Promise.all(this.#registering.splice(0));
  }

  /** Registers an in-memory extension definition. */
  async register(def: unknown): Promise<boolean> {
    const load = this.#load(def, undefined);
    this.#registering.push(load);
    return load;
  }

  /**
   * Loads an extension from a file (dynamic import, cache-busted). The
   * module's default export must be a `defineExtension(...)` result.
   */
  async registerFile(file: string): Promise<boolean> {
    const abs = isAbsolute(file) ? file : resolve(process.cwd(), file);
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
    let def: unknown;
    try {
      def = await importDefinition(file);
    } catch (err) {
      this.#options.onWarning?.(`extension ${previous.def.name}: reload failed (${errMessage(err)}); previous instance kept`);
      return;
    }
    // Seed the fresh instance with the previous state so setup() sees it.
    const fresh = await this.#instantiate(def, file, previous.state);
    if (!fresh.ok) {
      this.#options.onWarning?.(
        `extension ${previous.def.name}: reload refused (${fresh.reason}); previous instance kept`,
      );
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

  async #load(def: unknown, file: string | undefined): Promise<boolean> {
    const result = await this.#instantiate(def, file);
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
    // Bundled first-party definitions skip both consent and dependency
    // authorization: the host shipped the bytes, the user never chose them.
    const identity = contentIdentity(file) ?? `memory:${name}`;
    if (!this.#options.bundledTrust && !store.consents[identity]) {
      if (!this.#options.consent) {
        return { ok: false, name, reason: "consent", message: "extension not previously enabled and no consent flow is available" };
      }
      let granted: boolean;
      try {
        granted = await this.#options.consent(name, d.version);
      } catch (err) {
        return { ok: false, name, reason: "consent", message: errMessage(err) };
      }
      if (!granted) return { ok: false, name, reason: "consent", message: "user declined to enable the extension" };
      store.consents[identity] = true;
      this.#writeStore(store);
    }
    // Per-change dependency authorization, bound to the same content identity.
    const deps = d.dependencies ?? [];
    const approved = store.dependencies[identity] ?? [];
    if (!this.#options.bundledTrust && !sameDeps(deps, approved)) {
      if (deps.length > 0 && !this.#options.authorizeDependencies) {
        return { ok: false, name, reason: "deps_unauthorized", message: `dependency list changed (${deps.join(", ")}) and no authorization flow is available` };
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
      hooks: EMPTY_HOOKS(),
      file,
      status: null,
      eventsThisTurn: 0,
      capWarned: false,
    };
    const ctx: ExtensionSetupContext = {
      state: instance.state,
      appendToPrompt: (note) => instance.notes.push(note),
      appendEvent: (event) => this.#appendExtensionEvent(instance, event),
      setStatus: (text) => this.#setStatus(instance, text),
      onSessionStart: (h) => instance.hooks.sessionStart.push(h),
      onSessionEnd: (h) => instance.hooks.sessionEnd.push(h),
      beforeModelCall: (h) => instance.hooks.beforeModelCall.push(h),
      onToolCall: (h) => instance.hooks.onToolCall.push(h),
      onEvent: (h) => instance.hooks.onEvent.push(h),
      afterTurn: (h) => instance.hooks.afterTurn.push(h),
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
        const serialized = JSON.stringify(redactPayload(event.payload));
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
        if (serialized !== undefined) payload = redactPayload(event.payload);
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
    instance.eventsThisTurn += 1;
    if (instance.eventsThisTurn > MAX_EVENTS_PER_TURN) {
      // One warning per extension per turn: a runaway loop cannot bury the
      // log, and the extension is never silently speechless.
      if (!instance.capWarned) {
        instance.capWarned = true;
        this.#emit({
          type: "extension_failed",
          name,
          reason: "event_cap",
          message: `more than ${MAX_EVENTS_PER_TURN} events in one turn; further events were dropped`,
        });
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
    if (instance.status === next) return;
    instance.status = next;
    for (const listener of this.#statusListeners) listener(instance.def.name, next);
  }

  #emit(event: AgentEvent): void {
    // Delivered live when a session listens; buffered otherwise (pre-session
    // loads, tests) so exactly one channel ever delivers each event.
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

  /** Errors from one dispatch round, as extension_failed events to append. */
  readonly #hookErrors: AgentEvent[] = [];

  async dispatchSessionStart(): Promise<AgentEvent[]> {
    await this.#each("sessionStart", (h) => h({ startedAt: new Date() }));
    return this.#drainErrors();
  }

  async dispatchSessionEnd(reason: string): Promise<AgentEvent[]> {
    await this.#each("sessionEnd", (h) => h({ reason }));
    return this.#drainErrors();
  }

  async dispatchBeforeModelCall(ctx: Parameters<BeforeModelCallHook>[0]): Promise<AgentEvent[]> {
    await this.#each("beforeModelCall", (h) => h(ctx));
    return this.#drainErrors();
  }

  async dispatchEvent(event: AgentEvent): Promise<AgentEvent[]> {
    await this.#each("onEvent", (h) => h({ event: event as unknown as ExtensionEvent }));
    return this.#drainErrors();
  }

  async dispatchAfterTurn(result: { status: string; reason?: string; message?: string }): Promise<AgentEvent[]> {
    await this.#each("afterTurn", (h) => h({ result }));
    return this.#drainErrors();
  }

  /**
   * First decision wins, in registration order. Veto outranks user rules
   * and defaults (and applies even in yolo mode): extensions only restrict.
   * ADR-0031: a hook may instead `ask` — hand the call to the human
   * consent flow. `veto` wins when a hook returns both.
   */
  async checkToolVeto(
    call: { callId: string; name: string; args: unknown },
  ): Promise<{ veto: boolean; ask: boolean; reason?: string; by?: string; errors: AgentEvent[] }> {
    for (const instance of this.#instances) {
      for (const hook of instance.hooks.onToolCall) {
        let out: ToolCallHookResult | void;
        try {
          out = await hook(call);
        } catch (err) {
          this.#hookErrors.push({
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

  async #each<K extends keyof HookSet>(key: K, invoke: (hook: HookSet[K][number]) => Promise<void> | void): Promise<void> {
    for (const instance of this.#instances) {
      for (const hook of instance.hooks[key]) {
        try {
          await (invoke(hook) as Promise<void> | void);
        } catch (err) {
          this.#hookErrors.push({
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
    return this.#hookErrors.splice(0, this.#hookErrors.length);
  }
}
