import { MockProvider } from "./mock-provider";
import { AgentSession } from "./session";
import { builtinTools } from "./builtin-tools";
import {
  PromptComposer,
  SECTION_ORDER,
  BASE_PROMPT,
  DEFAULT_INSTRUCTIONS_BUDGET,
  hashPrompt,
  type AssembledPrompt,
  type BeforeModelCallContext,
  type BeforeModelCallHook,
  type PromptContext,
  type SectionName,
  type SectionRenderer,
  type SkillIndexEntry,
} from "./prompt-composer";
import {
  MIN_SUPPORTED_SCHEMA_VERSION,
  SessionStore,
  newSessionId,
  projectSessionsDir,
  projectSlug,
  replayMessages,
} from "./session-store";
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
import type { AgentEvent, EndpointCapabilities, Message, PermissionGrantReason, Provider, ProviderErrorKind, StreamEvent, Tool, ToolCall, ToolContext, TurnResult } from "./types";
import { ProviderError } from "./types";
import { normalizeProviderError, disambiguate429, classifyStatus } from "./provider-errors";
import { Endpoint, envApiKey, createRoute, type EndpointConfig, type ProviderKind, type Route, type RouteConfig, type RouteTarget } from "./route";

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
  /** Persistence seam: invoked for every appended event (e.g. `SessionStore.append`). */
  sink?: (event: AgentEvent) => void;
  /** System-prompt assembly (#27). Default: PromptComposer over the session cwd. */
  promptComposer?: PromptComposer;
}

export function createSession(config: SessionConfig): AgentSession {
  return new AgentSession(config);
}

export {
  AgentSession,
  MockProvider,
  builtinTools,
  Endpoint,
  createRoute,
  envApiKey,
  ProviderError,
  normalizeProviderError,
  disambiguate429,
  classifyStatus,
  PromptComposer,
  SECTION_ORDER,
  BASE_PROMPT,
  DEFAULT_INSTRUCTIONS_BUDGET,
  hashPrompt,
  DEFAULT_TOOL_PERMISSIONS,
  PermissionResolver,
  runtimeRulesFromEvents,
  splitCommandSegments,
  type AgentEvent,
  type Message,
  type PermissionDecision,
  type PermissionGrantReason,
  type AssembledPrompt,
  type BeforeModelCallContext,
  type BeforeModelCallHook,
  type PromptContext,
  type SectionName,
  type SectionRenderer,
  type SkillIndexEntry,
  type PermissionOverrides,
  type PermissionRule,
  type PermissionTier,
  type EndpointCapabilities,
  type EndpointConfig,
  type ProviderErrorKind,
  type ProviderKind,
  type Route,
  type RouteConfig,
  type RouteTarget,
  type Provider,
  type SessionMode,
  type StreamEvent,
  type Tool,
  type ToolCall,
  type ToolContext,
  type TurnResult,
  MIN_SUPPORTED_SCHEMA_VERSION,
  SessionStore,
  newSessionId,
  projectSessionsDir,
  projectSlug,
  replayMessages,
};
