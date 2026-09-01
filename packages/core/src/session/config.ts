/**
 * Session configuration types (#98, ADR-0004).
 *
 * `SessionConfig`/`PermissionsConfig` are the user-facing configuration
 * surface of `createSession`; they live here — next to the session they
 * configure — and are re-exported from the package index.
 */
import type { ExtensionRuntime } from "../extensions";
import type { MemoryOptions } from "../memory";
import type { McpRuntimeOptions } from "../mcp";
import type { PermissionOverrides, PermissionRule } from "../permissions";
import type { PromptComposer, SkillIndexEntry } from "../prompt-composer";
import type { ProviderRegistry } from "../provider-registry";
import type { EndpointProfile } from "../config";
import type { SubagentOptions } from "../subagents";
import type { AgentEvent, AskUserQuestion, AskUserResult, Provider, Tool } from "../types";

/** Permission configuration for a session. */
export interface PermissionsConfig {
  /** moh.json `permissions.overrides` (tier 2). */
  overrides?: PermissionOverrides;
  /** "normal" (default) or "auto-accept". "yolo" is only reachable via the explicit flag. */
  mode?: "normal" | "auto-accept";
  /** Explicit opt-in for yolo mode (#377: no prompts, unrestricted filesystem
   * for built-in tools); overrides `mode`. Launch-only — never settable from
   * moh.json, Settings, or in-session. */
  unrestrictedTools?: boolean;
  /** Runtime rules restored from a replayed session log. */
  runtimeRules?: PermissionRule[];
}

export interface SessionConfig {
  /**
   * A Provider instance (e.g. `MockProvider.scripted([...])`), or a
   * reference string: "mock", a registered custom provider id, or
   * "endpoint/model-id" resolved against moh.json profiles + registry.
   * Each session owns its loop state; instances are never shared globally.
   */
  provider: Provider | string;
  /** Registry used to resolve string provider refs; frozen at creation. */
  registry?: ProviderRegistry;
  /** Endpoint profiles (#166): what `switchModel` resolves new refs
   * against — the same merged profile list the initial provider came
   * from (passed by sessionFromConfig). */
  endpoints?: EndpointProfile[];
  /** Per-turn iteration cap. Default 50. */
  maxIterations?: number;
  /** Tools available to the model, keyed by tool name. */
  tools?: Record<string, Tool>;
  /** Working root for tool executions. Default process.cwd(). */
  cwd?: string;
  /** 3-tier permission gate for tool executions. */
  permissions?: PermissionsConfig;
  /** Consent callback for "ask" decisions. Without it (headless) unpermitted calls fail fast. */
  onPermissionRequest?: (
    tool: string,
    args: unknown,
  ) => Promise<"yes" | "always" | "no"> | "yes" | "always" | "no";
  /** Interactive question channel for the ask_user tool. Without it (headless) the tool fails fast. */
  onAskUser?: (question: AskUserQuestion) => Promise<AskUserResult> | AskUserResult;
  /** Persistence seam: invoked for every appended event (e.g. `SessionStore.append`). */
  sink?: (event: AgentEvent) => void;
  /** Path of the JSONL file the sink appends to (from `sessionFromConfig`).
   * Informational only for sessions without a growth probe; sessions with
   * `externalGrowth` set report it in `session_file_growth` events. */
  sessionFile?: string;
  /**
   * #400 single-writer guard: probed at every append boundary to detect
   * that the session JSONL grew from elsewhere (another machine over a
   * sync channel, a second process) between this writer's appends. A
   * non-null result is appended as a `session_file_growth` chrome event
   * (visible warning in every surface) *before* the pending event; the
   * local append then proceeds on the tail. Concurrent same-file use is
   * unsupported — forking is the recovery path.
   */
  externalGrowth?: () => { expectedBytes: number; actualBytes: number } | null;
  /** User-level moh dir for skill discovery. Default: `~/.moh`. */
  mohHome?: string;
  /**
   * First-party skills (#36): "include" (default) or "exclude" — with
   * workflow mode off, moh-owned skills stay out of the index so base
   * behavior is untouched even if they are installed.
   */
  firstParty?: "include" | "exclude";
  /** Skill index entries (#30). Default: discovered from ~/.moh/skills + .moh/skills. */
  skills?: SkillIndexEntry[];
  /**
   * Resume (#31): continue a persisted session (default: same file).
   * The events seed the in-memory log and conversation; runtime permission
   * rules from the history are restored. Only new events are appended/sunk.
   */
  resume?: { events: ReadonlyArray<AgentEvent> };
  /**
   * Extensions (#34): the runtime owning loaded extension instances.
   * Load results land in the event log; hooks observe the loop; vetoes
   * outrank user permission rules. Failed loads are warnings only.
   */
  extensions?: ExtensionRuntime;
  /**
   * MCP tool sources (#15): merged project + user server declarations.
   * Servers start lazily on the first turn and shut down at dispose;
   * duplicate server names throw at creation (startup validation).
   * Lifecycle events are appended to the session log automatically.
   */
  mcp?: Omit<McpRuntimeOptions, "onEvent" | "cwd" | "onTrustedTools">;
  /**
   * Subagents (#13): registers the `spawn` tool. Children are in-process
   * AgentSessions with their own JSONL logs, a strict subset of this
   * session's non-MCP tools, and depth 1 (they cannot spawn).
   * `null` = explicitly off (how SubagentHost keeps children depth-1 now
   * that the tool is registered by default, #339).
   */
  subagents?: SubagentOptions | null;
  /**
   * Cross-session memory (#38): post-turn extraction via the maintenance
   * subagent, injected as a system-prompt section. `enabled: false`
   * disables everything (no writes, no section, no subagent runs).
   */
  memory?: MemoryOptions;
  /** #240: neutral thinking-level request for every model call of this
   * session. A static level, a per-call getter (#242: dynamic overrides),
   * or absent — in which case the session resolves endpoint-scoped
   * preferences from `~/.moh/config` when the active ref is a catalog
   * model (#241/#242). Absent resolution = no thinking request at all. */
  thinking?: { level: import("../types").ThinkingLevel } | (() => { level: import("../types").ThinkingLevel } | undefined);
}
