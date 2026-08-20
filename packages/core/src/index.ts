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
import { discoverSkills, parseSkillFrontmatter, type DiscoveredSkill, type DiscoverSkillsOptions } from "./skills";
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
import {
  ProviderRegistry,
  FrozenProviderRegistry,
  defaultRegistry,
  resolveProvider,
  resolveProviderRef,
  type ProviderFactory,
  type ProviderFactoryOptions,
} from "./provider-registry";
import {
  loadMohConfig,
  writeMohConfig,
  upsertEndpoint,
  mohConfigSchema,
  type EndpointProfile,
  type MohConfig,
} from "./config";
import {
  runProviderAdd,
  addProviderToFile,
  minimalConnectionTest,
  OnboardingAborted,
  BUILTIN_PROVIDER_TYPES,
  type BuiltinProviderType,
  type ConnectionTestResult,
  type ConnectionTester,
  type OnboardingIo,
} from "./provider-onboarding";

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
   * A Provider instance (e.g. `MockProvider.scripted([...])`), or a
   * reference string: "mock", a registered custom provider id, or
   * "endpoint/model-id" resolved against moh.json profiles + registry.
   * Each session owns its loop state; instances are never shared globally.
   */
  provider: Provider | string;
  /** Registry used to resolve string provider refs; frozen at creation. */
  registry?: ProviderRegistry;
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
  /** User-level moh dir for skill discovery. Default: `~/.moh`. */
  mohHome?: string;
  /** Skill index entries (#30). Default: discovered from ~/.moh/skills + .moh/skills. */
  skills?: SkillIndexEntry[];
  /**
   * Resume (#31): continue a persisted session (default: same file).
   * The events seed the in-memory log and conversation; runtime permission
   * rules from the history are restored. Only new events are appended/sunk.
   */
  resume?: { events: ReadonlyArray<AgentEvent> };
}

export function createSession(config: SessionConfig): AgentSession {
  return new AgentSession(config);
}

export {
  AgentSession,
  MockProvider,
  builtinTools,
  ProviderRegistry,
  FrozenProviderRegistry,
  defaultRegistry,
  resolveProvider,
  resolveProviderRef,
  loadMohConfig,
  writeMohConfig,
  upsertEndpoint,
  mohConfigSchema,
  runProviderAdd,
  addProviderToFile,
  minimalConnectionTest,
  OnboardingAborted,
  BUILTIN_PROVIDER_TYPES,
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
  discoverSkills,
  parseSkillFrontmatter,
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
  type DiscoveredSkill,
  type DiscoverSkillsOptions,
  type PermissionOverrides,
  type PermissionRule,
  type PermissionTier,
  type EndpointCapabilities,
  type EndpointConfig,
  type EndpointProfile,
  type MohConfig,
  type ProviderFactory,
  type ProviderFactoryOptions,
  type BuiltinProviderType,
  type ConnectionTestResult,
  type ConnectionTester,
  type OnboardingIo,
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
