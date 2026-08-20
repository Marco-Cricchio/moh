import { MockProvider } from "./mock-provider";
import { AgentSession } from "./session";
import { builtinTools } from "./builtin-tools";
import {
  DEFAULT_TOOL_PERMISSIONS,
  PermissionResolver,
  runtimeRulesFromEvents,
  splitCommandSegments,
  type PermissionDecision,
  type PermissionOverrides,
  type PermissionRule,
  type PermissionTier,
  type SessionMode,
} from "./permissions";
import type { AgentEvent, Message, PermissionGrantReason, Provider, StreamEvent, Tool, ToolCall, ToolContext, TurnResult } from "./types";

/** Permission configuration for a session. */
export interface PermissionsConfig {
  /** moh.json `permissions.overrides` (tier 2). */
  overrides?: PermissionOverrides;
  /** "normal" (default) or "auto-accept". "bypass" is only reachable via the explicit flag. */
  mode?: "normal" | "auto-accept";
  /** Explicit opt-in for bypass mode; overrides `mode`. */
  bypassPermissions?: boolean;
  /** Runtime rules restored from a replayed session log. */
  runtimeRules?: PermissionRule[];
}

export interface SessionConfig {
  /**
   * A Provider instance (e.g. `MockProvider.scripted([...])`).
   * Each session owns its loop state; instances are never shared globally.
   */
  provider: Provider;
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
}

export function createSession(config: SessionConfig): AgentSession {
  return new AgentSession(config);
}

export {
  AgentSession,
  MockProvider,
  builtinTools,
  DEFAULT_TOOL_PERMISSIONS,
  PermissionResolver,
  runtimeRulesFromEvents,
  splitCommandSegments,
  type AgentEvent,
  type Message,
  type PermissionDecision,
  type PermissionGrantReason,
  type PermissionOverrides,
  type PermissionRule,
  type PermissionTier,
  type Provider,
  type SessionMode,
  type StreamEvent,
  type Tool,
  type ToolCall,
  type ToolContext,
  type TurnResult,
};
