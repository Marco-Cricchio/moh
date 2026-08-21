import { z } from "zod";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { AgentEvent, Provider, Tool, ToolContext } from "./types";
import type { PermissionsConfig, SessionConfig } from "./index";
import { AgentSession } from "./session";
import { SessionStore } from "./session-store";
import { PromptComposer, BASE_PROMPT } from "./prompt-composer";
import { resolveProviderRef, type FrozenProviderRegistry, type ProviderRegistry } from "./provider-registry";

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
    allowedTools: ["read", "glob", "grep", "fetch"],
  },
  implement: {
    name: "implement",
    description: "Focused implementer: edits code to complete a well-scoped task.",
    systemPrompt:
      "You are an implementation subagent. Complete the assigned task precisely, editing code as needed, then summarize what you changed.",
    allowedTools: ["read", "write", "edit", "bash", "glob", "grep"],
  },
};

export const DEFAULT_SUBAGENT_CONCURRENCY = 3;

/** Options for enabling the spawn tool on a session. */
export interface SubagentOptions {
  /** Presets from moh.json `agents`, merged over the built-ins (user wins). */
  presets?: Record<string, SubagentSpec>;
  /** Max concurrently running children. Default 3; extra spawns queue. */
  maxConcurrency?: number;
  /** Provider used when a spec declares neither `provider` nor `model`. */
  provider?: Provider | string;
  /** Home dir for child session files. Default: the real home (tests use temp). */
  home?: string;
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
  /** Consent seam surfaced through the parent TUI. */
  onPermissionRequest?: SessionConfig["onPermissionRequest"];
  /** Registry used to resolve string provider refs for children. */
  registry?: ProviderRegistry;
  /** Default provider for children without their own ref. */
  defaultProvider: Provider | string;
  presets?: Record<string, SubagentSpec>;
  maxConcurrency?: number;
  /** Home dir for child session files. Default: real home. */
  home?: string;
}

/** Simple counting semaphore: caps parallel children (default 3). */
class Semaphore {
  #active = 0;
  readonly #waiting: { resolve: () => void; aborted: boolean }[] = [];
  constructor(readonly limit: number) {}
  async acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    if (this.#active < this.limit) {
      this.#active += 1;
      return true;
    }
    const entry = { resolve: () => {}, aborted: false };
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
    if (entry.aborted) return false;
    this.#active += 1;
    return true;
  }
  release(): void {
    this.#active = Math.max(0, this.#active - 1);
    this.#waiting.shift()?.resolve();
  }
}

export class SubagentHost {
  readonly #options: SubagentHostOptions;
  readonly #semaphore: Semaphore;

  constructor(options: SubagentHostOptions) {
    this.#options = options;
    this.#semaphore = new Semaphore(options.maxConcurrency ?? DEFAULT_SUBAGENT_CONCURRENCY);
  }

  /** Resolves a preset name against moh.json agents (user) over built-ins. */
  resolvePreset(name: string): SubagentSpec | undefined {
    return this.#options.presets?.[name] ?? BUILTIN_AGENT_PRESETS[name];
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
        `Spawn a subagent that runs the task in its own session and returns its final reply.\n` +
        `Presets:\n${this.#presetDocs()}\n` +
        `Inline spec fields override the preset. Children get a strict subset of this session's tools (MCP tools are never inherited) and cannot spawn further subagents.`,
      inputSchema: spawnInputSchema,
      execute: (args, ctx) => this.#spawn(args, ctx),
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
    const tools: Record<string, Tool> = {};
    for (const [name, tool] of Object.entries(parent)) {
      if (name === "spawn" || name.startsWith("mcp__")) continue;
      if (spec.allowedTools && !allowed.has(name)) continue;
      tools[name] = tool;
    }
    return tools;
  }

  #resolveChildProvider(spec: SubagentSpec): Provider | string {
    if (spec.provider) return spec.provider;
    if (spec.model) return spec.model;
    return this.#options.defaultProvider;
  }

  async #spawn(
    args: z.infer<typeof spawnInputSchema>,
    ctx: ToolContext,
  ): Promise<string> {
    const { preset, task, ...inline } = args;
    const base = preset ? this.resolvePreset(preset) : undefined;
    if (preset && !base) {
      return resultJson({ status: "error", output: "", error: `unknown subagent preset: ${preset}` });
    }
    const spec: SubagentSpec = { name: "subagent", ...(base ?? {}), ...stripUndefined(inline) };
    const spawnId = `subagent-${randomUUID().slice(0, 8)}`;

    const acquired = await this.#semaphore.acquire(ctx.signal);
    if (!acquired) {
      return resultJson({ status: "cancelled", output: "", error: "spawn aborted while waiting for a slot" });
    }
    // Only explicit context is shared: the task (plus the preset's optional
    // context) is the child's entire first user message.
    const firstMessage = spec.context ? `# Context\n\n${spec.context}\n\n# Task\n\n${task}` : task;
    let child: AgentSession | null = null;
    try {
      const store = SessionStore.create(this.#options.cwd, this.#options.home ?? homedir());
      const perms = this.#options.permissions ?? {};
      const childProvider = this.#resolveChildProvider(spec);
      child = new AgentSession({
        provider: childProvider,
        ...(typeof childProvider === "string" && this.#options.registry ? { registry: this.#options.registry } : {}),
        tools: this.#childTools(spec),
        cwd: this.#options.cwd,
        maxIterations: spec.maxIterations,
        permissions: { ...perms, runtimeRules: this.#options.runtimeRules() },
        ...(this.#options.onPermissionRequest ? { onPermissionRequest: this.#options.onPermissionRequest } : {}),
        sink: (event) => store.append(event),
        promptComposer: new PromptComposer({
          projectDir: this.#options.cwd,
          ...(spec.systemPrompt
            ? { basePrompt: `${BASE_PROMPT}\n\n# Subagent role\n\n${spec.systemPrompt}` }
            : {}),
        }),
      });
      this.#options.onEvent({
        type: "subagent_spawn",
        callId: spawnId,
        name: spec.name,
        ...(preset ? { preset } : {}),
        log: store.file,
      });
      // Abort propagation: cancelling the parent's turn aborts the child.
      const abortChild = () => child?.abort();
      ctx.signal.addEventListener("abort", abortChild, { once: true });
      let turn: Awaited<ReturnType<AgentSession["send"]>>;
      try {
        turn = await child.send(firstMessage);
      } finally {
        ctx.signal.removeEventListener("abort", abortChild);
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
      await child?.dispose().catch(() => {});
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

/** The child's final assistant text: deltas after the last user_message. */
function lastAssistantText(events: AgentEvent[]): string {
  let text = "";
  for (const event of events) {
    if (event.type === "user_message") text = "";
    else if (event.type === "assistant_delta") text += event.text;
  }
  return text;
}
