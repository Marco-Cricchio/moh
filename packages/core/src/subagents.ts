import { z } from "zod";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { AgentEvent, Provider, Tool, ToolContext } from "./types";
import type { PermissionsConfig, SessionConfig } from "./session/config";
import type { ExtensionRuntime } from "./extensions";
import { AgentSession } from "./session/session";
import { DevelopmentLaneStore } from "./development-lanes";
import { SessionStore, lastAssistantText } from "./session-store";
import { ExtensionSpawnRefusedError } from "./extension-scope";
import { validatePathGlob } from "./host-scope";
import type { PermissionRule } from "./permissions";
import { PromptComposer, BASE_PROMPT } from "./prompt-composer";
import { tailChildLog } from "./child-tail";
import { resolveProviderRef, defaultRegistry, type FrozenProviderRegistry, type ProviderRegistry } from "./provider-registry";
import { DEFAULT_MAX_ITERATIONS } from "./session/agent-loop";
// ADR-0050 (§4): the child's own route, built from the parent's live pair.
import { childRouteOf } from "./route";
import type { EndpointProfile } from "./config";

/**
 * Subagents (#13): the `spawn` tool creates in-process child AgentSessions.
 * Each child has its own event log (a fresh JSONL session file), a strict
 * subset of the parent's non-MCP tools, its own per-turn loop cap, and
 * depth 1 (children never see the spawn tool). Child failure is reported
 * as a SubagentResult error and never fails the parent's turn.
 */

export interface SubagentSpec {
  /** Display/preset name. */
  name: string;
  /** One-line description (shown in the spawn tool docs for presets). */
  description?: string;
  /** The subagent's role prompt, appended to the base prompt. */
  systemPrompt?: string;
  /** Strict subset of the parent's tools (MCP tools are always denied). */
  allowedTools?: string[];
  /** Model override for route-style refs (`endpoint/model-id`). */
  model?: string;
  /** Provider reference override ("mock", a custom id, or a route). */
  provider?: string;
  /** Per-turn iteration cap for the child. Default: the session default (50). */
  maxIterations?: number;
  /** Explicit shared context (e.g. project background) prepended to the task. */
  context?: string;
}


export const subagentSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  systemPrompt: z.string().optional(),
  allowedTools: z.array(z.string().min(1)).optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  maxIterations: z.number().int().positive().optional(),
  context: z.string().optional(),
});

export interface SubagentResult {
  status: "done" | "error" | "cancelled";
  /** The child's final assistant text (empty on error/cancel). */
  output: string;
  /** Present when status is "error". */
  error?: string;
}

/** Built-in presets; moh.json `agents` entries override these by name. */
export const BUILTIN_AGENT_PRESETS: Record<string, SubagentSpec> = {
  research: {
    name: "research",
    description: "Read-only investigator: explores the codebase and reports findings.",
    systemPrompt:
      "You are a research subagent. Investigate the assigned question using read-only tools and report concise, sourced findings. Do not modify anything.",
    allowedTools: ["read", "glob", "grep", "fetch", "mpm_query"],
  },
  implement: {
    name: "implement",
    description: "Focused implementer: edits code to complete a well-scoped task.",
    systemPrompt:
      "You are an implementation subagent. Complete the assigned task precisely, editing code as needed, then summarize what you changed.",
    allowedTools: ["read", "write", "edit", "bash", "glob", "grep", "mpm_query"],
  },
};

export const DEFAULT_SUBAGENT_CONCURRENCY = 5;

/**
 * #1224: the write tools a member's `pathScopes` gate. Present scopes deny
 * every one of these outside the union of the globs (bare runtime deny)
 * and allow inside (a more specific path rule beats the bare deny within
 * the runtime tier); an empty scope list is the read-only reviewer.
 */
const WRITE_PATH_TOOLS = ["write", "edit"] as const;

/** Accepts either the bare glob (`client/**`) or the scope grammar (`path:client/**`). */
function toWriteScopeGlob(scope: string): string {
  return scope.startsWith("path:") ? scope.slice("path:".length) : scope;
}

function pathScopeRules(scopes: readonly string[]): PermissionRule[] {
  const rules: PermissionRule[] = [];
  for (const tool of WRITE_PATH_TOOLS) rules.push({ tier: "runtime", tool, effect: "deny" });
  for (const scope of scopes) {
    for (const tool of WRITE_PATH_TOOLS) rules.push({ tier: "runtime", tool, effect: "allow", path: scope });
  }
  return rules;
}

/** ADR-0055 (#1127): who asked for a spawn. */
export type SubagentSpawnRequester = { kind: "model" } | { kind: "extension"; extension: string };

/** ADR-0055 (#1127): the scopes actually applied to a spawned child. */
export interface SubagentSpawnLimits {
  tools?: string[];
  /** #1224: write-path scopes applied to the child (present = enforced,
   * empty = read-only); recorded so the composition is derivable from the log. */
  pathScopes?: readonly string[];
  mode: "normal" | "auto-accept" | "yolo";
  maxIterations: number;
}

/** A live child the stop control can abort. */
interface LiveChild {
  callId: string;
  name: string;
  requester: SubagentSpawnRequester;
  limits: SubagentSpawnLimits;
  abort: () => void;
}

/** ADR-0053: the extension-spawn envelope, defaulted to the fixed cap. */
export const EXTENSION_MAX_SESSIONS = 10;

/** Options for enabling the spawn tool on a session. */
export interface SubagentOptions {
  /** Presets from moh.json `agents`, merged over the built-ins (user wins). */
  presets?: Record<string, SubagentSpec>;
  /** Max concurrently running children. Default 5; extra spawns queue. */
  maxConcurrency?: number;
  /** Provider used when a spec declares neither `provider` nor `model`. */
  provider?: Provider | string;
  /** Home dir for child session files. Default: the real home (tests use temp). */
  home?: string;
  /**
   * #620: bounded read-only MPM orientation snapshot for children. The
   * parent hands a `snapshotFor(task)` closure; the child's prompt gets
   * the returned plan rendered as its `mpm` section. The child never
   * receives the MpmService, the lifecycle, or any mutation ability —
   * the parent retains all map ownership.
   */
  mpm?: { snapshotFor(task: string): string | null };
  /**
   * ADR-0060: parallel development lanes. When present, a spawn whose task
   * declares `lane: <feature-group-name>` (or the single-lane default when
   * exactly one lane is pending) is executed inside the lane's worktree,
   * with the lane's own cwd, and a `lane_created` chrome event records the
   * binding in the parent's log. The child never receives the lane store
   * or the Git runner: it just runs in the lane's directory.
   */
  lanes?: {
    /** Project root that owns the lane worktrees. Default: the session cwd. */
    cwd?: string;
  };
}

const spawnInputSchema = subagentSpecSchema.extend({
  name: z.string().min(1).optional(),
  /** Preset name (built-in or moh.json); inline fields override it. */
  preset: z.string().min(1).optional(),
  /** The task handed to the child as its first user message. */
  task: z.string().min(1),
});

export interface SubagentHostOptions {
  cwd: string;
  /** Snapshot of the parent's tool registry at each spawn. */
  parentTools: () => Record<string, Tool>;
  /** Appends spawn/result events to the parent's log. */
  onEvent: (event: AgentEvent) => void;
  /** Parent's permission config (children inherit, never more permissively). */
  permissions?: PermissionsConfig;
  /** Runtime rules active in the parent, snapshotted per spawn. */
  runtimeRules: () => import("./permissions").PermissionRule[];
  /** #849: the parent's live permission mode at spawn time — a child
   * spawned after an in-session rotation inherits it (launch config alone
   * would miss a mid-session `--yolo` exit, or a yolo entered in-session). */
  sessionMode?: () => import("./permissions").SessionMode;
  /** Consent seam surfaced through the parent TUI. */
  onPermissionRequest?: SessionConfig["onPermissionRequest"];
  /**
   * ADR-0033 §4: the parent's pre-send confirmation seam, inherited for the
   * same reason the permission seam is — a child's turn is the user's agent
   * working, so a hook that asks (the anti-injection check, judging the
   * task text the parent composed) asks the same human. A child that
   * cannot ask refuses the turn, exactly like a headless parent.
   */
  onConfirmTurn?: SessionConfig["onConfirmTurn"];
  /** The parent's extension runtime (#784 spec §5): children get it as
   * their tool-call hook checker, so the guardrail judges child tool calls
   * through the same gate. Lifecycle hooks and statuses stay the parent's. */
  extensions?: ExtensionRuntime;
  /** Registry used to resolve string provider refs for children. */
  registry?: ProviderRegistry;
  /** Configured endpoint profiles — used to pre-validate string refs (#339). */
  endpoints?: EndpointProfile[];
  /** Default provider for children without their own ref. */
  defaultProvider: Provider | string | (() => Provider | string);
  presets?: Record<string, SubagentSpec>;
  maxConcurrency?: number;
  /** Home dir for child session files. Default: real home. */
  home?: string;
  /** #620: bounded read-only MPM snapshot seam (see SubagentOptions). */
  mpm?: { snapshotFor(task: string): string | null };
  /** ADR-0060: lane-bound spawns (see SubagentOptions). */
  lanes?: {
    /** Project root that owns the lane worktrees. Default: the host cwd. */
    cwd?: string;
  };
  /** ADR-0055 (#1127): who is asking for spawns right now — the model, or
   * an orchestration extension by name. Default: the model. */
  requester?: () => SubagentSpawnRequester;
  /** ADR-0055 (#1127): the session's resolved iteration cap, read live so
   * the recorded `limits.maxIterations` is what the child actually gets. */
  defaultMaxIterations?: () => number;
  /**
   * ADR-0053 + ADR-0055 (#998 follow-up): the envelope extension spawns
   * live in. `maxSessions` caps how many children one extension may spawn
   * per session (ADR-0053 fixes the default at 10); `maxIterations` is the
   * iteration ceiling a spawn may request (default: the session's own
   * cap). A request outside the envelope is refused loudly, never
   * silently narrowed.
   */
  extensionEnvelope?: { maxSessions?: number; maxIterations?: number };
  /** ADR-0055 write-into-child (#1222): the names of the extension-
   * contributed tools, excluded from every child's toolset — members
   * cannot address each other, by construction. */
  contributedTools?: () => readonly string[];
}

/** #1143: counting semaphore with permit transfer — caps parallel children
 * (default 5). Exported for tests. */
export class Semaphore {
  #active = 0;
  readonly #waiting: { resolve: () => void; aborted: boolean; handedOff: boolean }[] = [];
  constructor(readonly limit: number) {}
  async acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    if (this.#active < this.limit) {
      this.#active += 1;
      return true;
    }
    const entry = { resolve: () => {}, aborted: false, handedOff: false };
    this.#waiting.push(entry);
    const onAbort = () => {
      entry.aborted = true;
      // Remove itself so a later release() never wakes a dead waiter.
      const i = this.#waiting.indexOf(entry);
      if (i !== -1) this.#waiting.splice(i, 1);
      entry.resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    await new Promise<void>((resolve) => {
      entry.resolve = resolve;
    });
    signal.removeEventListener("abort", onAbort);
    if (entry.aborted) {
      // An aborted waiter that was already handed a permit (#1143) must
      // pass it on, or the permit leaks and the semaphore under-counts.
      if (entry.handedOff) this.release();
      return false;
    }
    // Permit transfer (#1143): release() never decremented for us, so we
    // must not increment again — an acquire() landing between the wake and
    // this resume would otherwise double-grant past `limit`.
    if (!entry.handedOff) this.#active += 1;
    return true;
  }
  release(): void {
    // Hand the permit to the first live waiter without decrementing
    // (#1143): between this wake and the waiter's resume a fresh acquire()
    // must not see a free slot and grant a second permit for the same one.
    while (this.#waiting.length > 0) {
      const next = this.#waiting.shift()!;
      if (next.aborted) {
        // A dead waiter holds nothing: wake it (acquire returns false) and
        // keep looking for a live one to inherit the permit.
        next.resolve();
        continue;
      }
      next.handedOff = true;
      next.resolve();
      return;
    }
    this.#active = Math.max(0, this.#active - 1);
  }
}

export class SubagentHost {
  readonly #options: SubagentHostOptions;
  readonly #semaphore: Semaphore;
  /** ADR-0055 "one stop" (#1127): the children currently in flight. */
  readonly #live = new Map<string, LiveChild>();
  /**
   * ADR-0053/#998: children an extension spawned, keyed by callId — the
   * set `subagentActivity` reads from; a session the extension did not
   * spawn is not in the map, so it cannot be read. Lives past the child's
   * settle (activity of a settled child is still its own).
   */
  readonly #spawnedByExtension = new Map<string, string>();
  /**
   * ADR-0055 write-into-child (#1222): the sessions behind extension
   * spawns, keyed by callId — `steerFor` writes only into these. A child
   * the extension did not spawn is not in the map, so it cannot be
   * written into; membership is the ownership proof.
   */
  readonly #extensionChildren = new Map<string, AgentSession>();
  /** Children log paths by callId, for the bounded activity read. */
  readonly #logs = new Map<string, string>();
  /** ADR-0053: spawns per extension per session — the envelope counter. */
  readonly #extensionSpawnCounts = new Map<string, number>();

  constructor(options: SubagentHostOptions) {
    this.#options = options;
    this.#semaphore = new Semaphore(options.maxConcurrency ?? DEFAULT_SUBAGENT_CONCURRENCY);
  }

  /** The live children: callId, display name, spawn requester/limits. */
  liveSubagents(): { callId: string; name: string; requester: SubagentSpawnRequester; limits: SubagentSpawnLimits }[] {
    return [...this.#live.values()].map((child) => ({
      callId: child.callId,
      name: child.name,
      requester: child.requester,
      limits: child.limits,
    }));
  }

  /**
   * ADR-0055 "one stop": stop everything this orchestration started —
   * lists the live children, aborts them, and returns their callIds so the
   * session records one `orchestration_stopped` chrome event. Children
   * already settled contribute nothing. A stopped child also loses its
   * steering seat (#1222): the owner's one stop closes the write seam —
   * the lead cannot start a new turn in a member the user just stopped.
   */
  stop(): string[] {
    const stopped: string[] = [];
    for (const child of this.#live.values()) {
      stopped.push(child.callId);
      try {
        child.abort();
      } catch {
        // An abort that throws still counts as stopped: the child's own
        // result event carries the outcome.
      }
      this.#extensionChildren.delete(child.callId);
    }
    this.#live.clear();
    return stopped;
  }

  /** Resolves a preset name against moh.json agents (user) over built-ins. */
  resolvePreset(name: string): SubagentSpec | undefined {
    return this.#options.presets?.[name] ?? BUILTIN_AGENT_PRESETS[name];
  }

  /** ADR-0053: children this extension spawned this session, by callId. */
  spawnedByExtension(extension: string): string[] {
    return [...this.#spawnedByExtension].filter(([, by]) => by === extension).map(([callId]) => callId);
  }

  /**
   * ADR-0053 + ADR-0055 (#998 follow-up): the `spawn-subagent` capability's
   * execution path. The envelope is intersected here — cap, iteration
   * ceiling, tool subset — and every refusal is loud: the caller records
   * `extension_failed` and the child is never created.
   */
  async spawnForExtension(
    extension: string,
    spec: { preset?: string; name?: string; task: string; systemPrompt?: string; allowedTools?: readonly string[]; pathScopes?: readonly string[]; maxIterations?: number },
  ): Promise<{ callId: string } & SubagentResult> {
    const envelope = this.#options.extensionEnvelope;
    const maxSessions = envelope?.maxSessions ?? EXTENSION_MAX_SESSIONS;
    const maxIterationsCeiling = envelope?.maxIterations ?? this.#options.defaultMaxIterations?.() ?? DEFAULT_MAX_ITERATIONS;
    const used = this.#extensionSpawnCounts.get(extension) ?? 0;
    if (used >= maxSessions) {
      throw new ExtensionSpawnRefusedError(
        "spawn_cap",
        `extension "${extension}" reached its envelope of ${maxSessions} children for this session`,
      );
    }
    if (spec.maxIterations !== undefined && spec.maxIterations > maxIterationsCeiling) {
      throw new ExtensionSpawnRefusedError(
        "spawn_refused",
        `maxIterations ${spec.maxIterations} exceeds the envelope ceiling of ${maxIterationsCeiling} — the request is refused, never silently narrowed`,
      );
    }
    // Loud tool validation: an unknown name is a refusal, not a silent
    // narrowing — what the spawn did not name does not exist for the child.
    if (spec.allowedTools) {
      const parent = this.#options.parentTools();
      const unknown = spec.allowedTools.filter((t) => !parent[t] || t.startsWith("mcp__"));
      if (unknown.length > 0) {
        throw new ExtensionSpawnRefusedError(
          "spawn_refused",
          `unknown tools in allowedTools: ${unknown.join(", ")} — the child receives only tools this session has`,
        );
      }
    }
    // #1224: a malformed scope is a loud refusal, like its capability
    // sibling at load (ADR-0065) — a glob that never parses must not
    // silently narrow to "no enforcement".
    const pathScopes = spec.pathScopes !== undefined ? spec.pathScopes.map(toWriteScopeGlob) : undefined;
    if (pathScopes) {
      for (let i = 0; i < pathScopes.length; i++) {
        const validity = validatePathGlob(pathScopes[i]!);
        if (!validity.ok) throw new ExtensionSpawnRefusedError("spawn_refused", validity.message);
      }
    }
    const base = spec.preset ? this.resolvePreset(spec.preset) : undefined;
    if (spec.preset && !base) {
      throw new ExtensionSpawnRefusedError("spawn_refused", `unknown subagent preset: ${spec.preset}`);
    }
    const resolved: SubagentSpec = {
      name: "subagent",
      ...(base ?? {}),
      ...(spec.name ? { name: spec.name } : {}),
      ...(spec.systemPrompt ? { systemPrompt: spec.systemPrompt } : {}),
      ...(spec.allowedTools ? { allowedTools: [...spec.allowedTools] } : {}),
      ...(spec.maxIterations !== undefined ? { maxIterations: spec.maxIterations } : {}),
    };
    // The envelope counts *created* children (ADR-0053 "children one
    // extension may spawn per session"): the counter increments in
    // onSpawned — a spawn refused inside #spawn burns nothing.
    let callId = "";
    const raw = await this.#spawn({ ...resolved, task: spec.task }, new AbortController().signal, {
      extension,
      ...(pathScopes !== undefined ? { pathScopes } : {}),
      onSpawned: (id) => {
        this.#extensionSpawnCounts.set(extension, (this.#extensionSpawnCounts.get(extension) ?? 0) + 1);
        callId = id;
      },
      onSession: (session) => {
        this.#extensionChildren.set(callId, session);
      },
    });
    return { ...(JSON.parse(raw) as SubagentResult), callId };
  }

  /**
   * ADR-0055: bounded turn-activity read of one spawned child — the
   * child-tail shape's activity, never the provider reasoning. `null` for
   * a callId the extension did not spawn: a session it did not create
   * does not exist for it.
   */
  async activityFor(extension: string, callId: string): Promise<{ currentTool: string | null; lastActivityAt: number | null } | null> {
    if (this.#spawnedByExtension.get(callId) !== extension) return null;
    const log = this.#logs.get(callId);
    if (!log) return null;
    const tail = await tailChildLog(log, 0);
    return tail.activity;
  }

  /**
   * ADR-0055 write-into-child (#1222): a follow-up message from the
   * extension becomes the child's next turn — the child keeps its full
   * context and its own route. `null` for a callId the extension did not
   * spawn: a session it did not create does not exist for it. The write
   * is recorded as `subagent_steer` chrome in the parent's log before the
   * turn runs, so replay reconstructs who wrote what into whom.
   */
  async steerFor(extension: string, callId: string, message: string): Promise<({ callId: string } & SubagentResult) | null> {
    if (this.#spawnedByExtension.get(callId) !== extension) return null;
    const child = this.#extensionChildren.get(callId);
    if (!child) return null;
    this.#options.onEvent({ type: "subagent_steer", callId, extension, messageChars: message.length });
    try {
      const turn = await child.send(message);
      const result: SubagentResult = turn.status === "done"
        ? { status: "done", output: lastAssistantText(child.history()) }
        : turn.status === "cancelled"
          ? { status: "cancelled", output: "", error: "subagent was cancelled" }
          : { status: "error", output: "", error: turn.message ?? turn.reason ?? "subagent failed" };
      return { callId, ...result };
    } catch (err) {
      return { callId, status: "error", output: "", error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * ADR-0055 (#1222): disposes the extension-spawned children the host
   * kept alive for steering. Called by the parent session's dispose —
   * a child's steering seat dies with the session that spawned it.
   */
  async disposeSteerableChildren(): Promise<void> {
    const children = [...this.#extensionChildren.values()];
    this.#extensionChildren.clear();
    await Promise.allSettled(children.map((child) => child.dispose()));
  }

  /** Merged preset descriptions, for the spawn tool's docs. */
  #presetDocs(): string {
    const names = [...Object.keys(BUILTIN_AGENT_PRESETS), ...Object.keys(this.#options.presets ?? {})];
    const docs = [...new Set(names)].map((n) => {
      const spec = this.resolvePreset(n)!;
      return `- ${n}: ${spec.description ?? "(no description)"}`;
    });
    return docs.join("\n");
  }

  /** The `spawn` tool registered on the parent session. */
  spawnTool(): Tool {
    return {
      name: "spawn",
      description:
        `Spawn a subagent that runs the task in its own session and returns its final reply.
` +
        `Call with preset + task only; set provider/model only when the user explicitly asks for a different model.
` +
        `Presets:\n${this.#presetDocs()}\n` +
        `Inline spec fields override the preset. Children get a strict subset of this session's tools (MCP tools are never inherited) and cannot spawn further subagents.`,
      inputSchema: spawnInputSchema,
      execute: (args, ctx) => this.#spawn(args, ctx.signal),
    };
  }

  /**
   * Child tools: the parent's registry filtered to the spec's allowedTools
   * (strict subset — unknown names are dropped), with MCP tools and the
   * spawn tool itself always removed (depth 1, MCP denied to children).
   */
  #childTools(spec: SubagentSpec): Record<string, Tool> {
    const parent = this.#options.parentTools();
    const allowed = new Set(spec.allowedTools);
    // ADR-0055 (#1222): extension-contributed tools belong to the lead
    // session only — a member never receives them, so members cannot
    // address each other even through the lead's own door.
    const contributed = new Set(this.#options.contributedTools?.() ?? []);
    const tools: Record<string, Tool> = {};
    for (const [name, tool] of Object.entries(parent)) {
      if (name === "spawn" || name.startsWith("mcp__") || contributed.has(name)) continue;
      if (spec.allowedTools && !allowed.has(name)) continue;
      tools[name] = tool;
    }
    return tools;
  }

  #resolveChildProvider(spec: SubagentSpec): Provider | string {
    if (spec.provider) return spec.provider;
    if (spec.model) return spec.model;
    const fallback = this.#options.defaultProvider;
    // #166: a live accessor follows in-session model switches.
    const resolved = typeof fallback === "function" ? fallback() : fallback;
    // ADR-0050 (§4/§5): a child never borrows the parent's route object —
    // it gets its own, born from the parent's live pair and the cooldown
    // deadlines the parent knows. A string ref and a non-route provider
    // keep today's behaviour (resolution / sharing).
    return typeof resolved === "string" ? resolved : childRouteOf(resolved);
  }

  async #spawn(
    args: z.infer<typeof spawnInputSchema>,
    signal: AbortSignal,
    /** ADR-0053: set when an extension asked for this spawn. */
    from?: { extension: string; /** #1224: write-path scopes enforced on
     * this child through the permission spine (present = enforced, empty =
     * read-only). */ pathScopes?: readonly string[]; /** Called once with
     * the child's callId, as
     * soon as it exists (the extension result needs it, the tool result
     * does not). */ onSpawned?: (callId: string) => void; /** Called with
     * the child session as soon as it exists (#1222): the host keeps it
     * for the extension's write-into-child seam. */ onSession?: (session: AgentSession) => void },
  ): Promise<string> {
    const { preset, task, ...inline } = args;
    const base = preset ? this.resolvePreset(preset) : undefined;
    if (preset && !base) {
      return resultJson({ status: "error", output: "", error: `unknown subagent preset: ${preset}` });
    }
    const overrides = stripUndefined(inline);
    // Tool-calling models frequently serialize omitted optional fields as
    // empty strings/arrays. For a preset those are placeholders, not a
    // request to erase its role or its tool allow-list (#323). Inline-only
    // specs retain an explicit [] as the useful "no tools" declaration.
    if (base) {
      for (const key of ["description", "systemPrompt", "model", "provider", "context"] as const) {
        if (overrides[key] === "") delete overrides[key];
      }
      if (overrides.allowedTools?.length === 0) delete overrides.allowedTools;
    }
    const spec: SubagentSpec = { name: "subagent", ...(base ?? {}), ...overrides };
    const spawnId = `subagent-${randomUUID().slice(0, 8)}`;

    // ADR-0060: an explicit `lane: <branchRef>` line in the task binds the
    // spawn to a registered lane — the child runs inside that lane's
    // worktree. Unknown or ambiguous lane refs fail the spawn with a
    // didactic error and zero side effects.
    const laneMatch = /^lane:\s*(\S+)\s*$/m.exec(task);
    let laneCwd: string | undefined;
    if (this.#options.lanes && laneMatch) {
      const lane = new DevelopmentLaneStore({ cwd: this.#options.lanes.cwd ?? this.#options.cwd, home: this.#options.home })
        .listLanes()
        .find((candidate) => candidate.branchRef === laneMatch[1] && !["landed", "abandoned"].includes(candidate.status));
      if (!lane) {
        return resultJson({ status: "error", output: "", error: `no active lane for branch "${laneMatch[1]}" — create it first with the lane tools` });
      }
      laneCwd = lane.worktreePath;
    }

    const acquired = await this.#semaphore.acquire(signal);
    if (!acquired) {
      return resultJson({ status: "cancelled", output: "", error: "spawn aborted while waiting for a slot" });
    }
    // Only explicit context is shared: the task (plus the preset's optional
    // context) is the child's entire first user message.
    const firstMessage = spec.context ? `# Context\n\n${spec.context}\n\n# Task\n\n${task}` : task;
    // #620: bounded read-only MPM orientation for the child, computed once
    // per spawn from the task text. The child never owns the map: no
    // service, no lifecycle — just the rendered, source-cited plan text.
    const mpmOrientation = this.#options.mpm?.snapshotFor(task) ?? null;
    let child: AgentSession | null = null;
    try {
      // #339: resolve a string ref BEFORE any child setup — a hallucinated
      // provider/model fails fast with a didactic error and zero side
      // effects (no store file, no child session).
      const childProviderRef = this.#resolveChildProvider(spec);
      if (typeof childProviderRef === "string") {
        try {
          resolveProviderRef(
            childProviderRef,
            (this.#options.registry ?? defaultRegistry).freeze(),
            this.#options.endpoints ?? [],
          );
        } catch (err) {
          return resultJson({
            status: "error",
            output: "",
            error: `${err instanceof Error ? err.message : String(err)} — use a preset or omit provider/model`,
          });
        }
      }
      const store = SessionStore.create(this.#options.cwd, this.#options.home ?? homedir());
      // A lane-bound child works inside the lane's worktree (isolation by
      // construction); its log stays with the project's other sessions.
      const childCwd = laneCwd ?? this.#options.cwd;
      const perms = this.#options.permissions ?? {};
      // #849: the parent's live mode overrides the launch-time config so a
      // child mirrors the session it spawned from (a rotation mid-session
      // applies to children too — inherit, never more permissive).
      const liveMode = this.#options.sessionMode?.();
      const permsForChild = liveMode === undefined
        ? perms
        : liveMode === "yolo"
          ? { ...perms, unrestrictedTools: true }
          : { ...perms, unrestrictedTools: false, mode: liveMode };
      child = new AgentSession({
        provider: childProviderRef,
        ...(typeof childProviderRef === "string" && this.#options.registry ? { registry: this.#options.registry } : {}),
        subagents: null, // depth 1 (#339): children never see the spawn tool
        tools: this.#childTools(spec),
        // #787: the parent's endpoint profiles serve the child too — a
        // `beforeTurn` model ref names `endpoint/model-id`, and a child
        // must resolve it against the same profiles the parent routes on.
        ...(this.#options.endpoints?.length ? { endpoints: this.#options.endpoints } : {}),
        cwd: childCwd,
        maxIterations: spec.maxIterations,
        permissions: {
          ...permsForChild,
          // #1224: the member's write-path scopes ride the permission spine
          // — a bare deny with more specific allows, so the denial is a
          // logged `permission_denied`, not prompt discipline.
          runtimeRules: [...this.#options.runtimeRules(), ...(from?.pathScopes ? pathScopeRules(from.pathScopes) : [])],
        },
        ...(this.#options.onPermissionRequest ? { onPermissionRequest: this.#options.onPermissionRequest } : {}),
        ...(this.#options.onConfirmTurn ? { onConfirmTurn: this.#options.onConfirmTurn } : {}),
        ...(this.#options.extensions ? { toolHooks: this.#options.extensions } : {}),
        sink: (event) => store.append(event),
        promptComposer: new PromptComposer({
          projectDir: this.#options.cwd,
          ...(spec.systemPrompt
            ? { basePrompt: `${BASE_PROMPT}\n\n# Subagent role\n\n${spec.systemPrompt}` }
            : {}),
          ...(mpmOrientation ? { sections: { mpm: () => mpmOrientation } } : {}),
        }),
      });
      // A lane-bound spawn records the binding next to the spawn event, so
      // replay reconstructs which worktree served the child (ADR-0060).
      if (laneCwd) {
        this.#options.onEvent({
          type: "lane_created",
          laneId: `lane:${laneMatch![1]}`,
          featureGroupId: "",
          branchRef: laneMatch![1]!,
          worktreePath: laneCwd,
          baseRef: "",
          baseRevision: "",
          targetRef: "",
          relation: "independent",
        });
      }
      // ADR-0055 (#1127): who asked and what was applied — the fields that
      // make an orchestration's children derivable from the log, reused by
      // the live-children registry the stop control reads.
      const requester: SubagentSpawnRequester = from ? { kind: "extension", extension: from.extension } : (this.#options.requester?.() ?? { kind: "model" });
      const limits: SubagentSpawnLimits = {
        ...(spec.allowedTools ? { tools: [...spec.allowedTools] } : {}),
        ...(from?.pathScopes !== undefined ? { pathScopes: from.pathScopes } : {}),
        mode: permsForChild.unrestrictedTools === true ? "yolo" : permsForChild.mode ?? liveMode ?? perms.mode ?? "normal",
        maxIterations: spec.maxIterations ?? this.#options.defaultMaxIterations?.() ?? DEFAULT_MAX_ITERATIONS,
      };
      this.#options.onEvent({
        type: "subagent_spawn",
        callId: spawnId,
        name: spec.name,
        ...(preset ? { preset } : {}),
        log: store.file,
        requester,
        limits,
      });
      // The stop control (ADR-0055 "one stop"): a live child aborts with
      // its parent's turn; this registry adds the door that does not
      // require turning the owner's own turn off.
      this.#spawnedByExtension.set(spawnId, from?.extension ?? "");
      this.#logs.set(spawnId, store.file);
      from?.onSpawned?.(spawnId);
      from?.onSession?.(child);
      const live: LiveChild = { callId: spawnId, name: spec.name, requester, limits, abort: () => child?.abort() };
      this.#live.set(spawnId, live);
      const forget = () => this.#live.delete(spawnId);
      // Abort propagation: cancelling the parent's turn aborts the child.
      const abortChild = () => child?.abort();
      signal.addEventListener("abort", abortChild, { once: true });
      let turn: Awaited<ReturnType<AgentSession["send"]>>;
      try {
        turn = await child.send(firstMessage);
      } finally {
        signal.removeEventListener("abort", abortChild);
        forget();
      }
      const usage = child.usage;
      const result: SubagentResult =
        turn.status === "done"
          ? { status: "done", output: lastAssistantText(child.history()) }
          : turn.status === "cancelled"
            ? { status: "cancelled", output: "", error: "subagent was cancelled" }
            : { status: "error", output: "", error: turn.message ?? turn.reason ?? "subagent failed" };
      this.#options.onEvent({
        type: "subagent_result",
        callId: spawnId,
        name: spec.name,
        status: result.status,
        usage,
        log: store.file,
        ...(subagentPreview(result.output) ? { preview: subagentPreview(result.output) } : {}),
      });
      return resultJson(result);
    } catch (err) {
      // Child failure never fails the parent's turn.
      return resultJson({
        status: "error",
        output: "",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.#semaphore.release();
      // An extension-spawned child stays alive after its first turn: the
      // extension's write-into-child seam (#1222) sends its follow-up
      // turns. Bounded by the spawn envelope (≤10 per extension); model
      // spawns are disposed here as before.
      if (!from) await child?.dispose().catch(() => {});
    }
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function resultJson(result: SubagentResult): string {
  return JSON.stringify(result);
}


/** #320: the transcript preview of a subagent's output — its first lines,
 * bounded, so the chat block and replay hint at what the child produced
 * without re-reading the child log. `undefined` when there is no output. */
export function subagentPreview(output: string, maxLines = 3): string | undefined {
  const lines = output.split("\n").filter((l) => l.trim() !== "").slice(0, maxLines);
  return lines.length ? lines.join("\n") : undefined;
}
