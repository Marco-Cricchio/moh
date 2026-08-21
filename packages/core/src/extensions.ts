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
   * `name` at `version`. A `true` answer is persisted; `false` refuses the
   * load. When absent and nothing is stored, the load is refused.
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
}

interface ExtensionStore {
  /** name -> true (one-time enable consent, remembered forever). */
  consents: Record<string, true>;
  /** name -> approved dependency list. */
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
  readonly #watchers = new Map<string, FSWatcher>();
  readonly #reloadTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

  /** Registers an in-memory extension definition. */
  async register(def: unknown): Promise<boolean> {
    return this.#load(def, undefined);
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
    // One-time enable consent: asked once per extension name, ever.
    if (!store.consents[name]) {
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
      store.consents[name] = true;
      this.#writeStore(store);
    }
    // Per-change dependency authorization (approved list remembered per extension).
    const deps = d.dependencies ?? [];
    const approved = store.dependencies[name] ?? [];
    if (!sameDeps(deps, approved)) {
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
      store.dependencies[name] = [...deps];
      this.#writeStore(store);
    }
    const instance: RuntimeExtension = { def: d as ExtensionDefinition, state: { ...seedState }, notes: [], hooks: EMPTY_HOOKS(), file };
    const ctx: ExtensionSetupContext = {
      state: instance.state,
      appendToPrompt: (note) => instance.notes.push(note),
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
    mkdirSync(this.#mohHome, { recursive: true });
    writeFileSync(file, JSON.stringify(store, null, 2));
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
   * First veto wins, in registration order. Veto outranks user rules and
   * defaults (and applies even in bypass mode): extensions only restrict.
   */
  async checkToolVeto(
    call: { callId: string; name: string; args: unknown },
  ): Promise<{ veto: boolean; reason?: string; by?: string; errors: AgentEvent[] }> {
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
        if (out && out.veto) {
          return { veto: true, reason: out.reason, by: instance.def.name, errors: this.#drainErrors() };
        }
      }
    }
    return { veto: false, errors: this.#drainErrors() };
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
