import { MockProvider } from "./mock-provider";
import { EchoProvider } from "./echo-provider";
import { AgentSession } from "./session/session";
import { builtinTools } from "./builtin-tools";
import { ExtensionRuntime, type ExtensionRuntimeOptions, type RuntimeExtension } from "./extensions";
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
import { discoverSkills, parseSkillFrontmatter, firstPartySkillNames, FIRST_PARTY_MANIFEST, type DiscoveredSkill, type DiscoverSkillsOptions } from "./skills";
import {
  MIN_SUPPORTED_SCHEMA_VERSION,
  SessionStore,
  newSessionId,
  projectSessionsDir,
  projectSlug,
  replayMessages,
  lastAssistantText,
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
import {
  SubagentHost,
  BUILTIN_AGENT_PRESETS,
  DEFAULT_SUBAGENT_CONCURRENCY,
  subagentSpecSchema,
  type SubagentOptions,
  type SubagentResult,
  type SubagentSpec,
} from "./subagents";
import type { AgentEvent, AskUserQuestion, AskUserResult, EndpointCapabilities, Message, PermissionGrantReason, Provider, ProviderErrorKind, StreamEvent, Tool, ToolCall, ToolContext, TurnResult } from "./types";
import { createMaintenanceExtractor } from "./memory";
import {
  CHARS_PER_TOKEN,
  DEFAULT_MEMORY_BUDGET_TOKENS,
  DEFAULT_MEMORY_INTERVAL_TURNS,
  MAINTENANCE_PROMPT,
  MAX_ENTRIES_PER_TOPIC,
  MemoryStore,
  memoryConfigSchema,
  memoryTranscript,
  parseMemoryEntries,
  topicFileName,
  type MemoryEntry,
  type MemoryExtractor,
  type MemoryExtractorInput,
  type MemoryOptions,
} from "./memory";
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
  declaredMcpServers,
  upsertMcpServer,
  persistToolAllow,
  persistMcpTrust,
  mohConfigSchema,
  type EndpointProfile,
  type MohConfig,
} from "./config";
import {
  McpError,
  McpRuntime,
  MCP_HANDSHAKE_TIMEOUT_MS,
  mcpServerEntrySchema,
  mcpToolName,
  loadUserMcpServers,
  declaredUserMcpServers,
  type DeclaredMcpServer,
  type McpConsentAnswer,
  type McpErrorKind,
  type McpRuntimeOptions,
  type McpServerEntry,
  type McpServerState,
} from "./mcp";
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
import {
  MOH_VERSION,
  DEFAULT_UPSTREAM_URL,
  defaultBundleDir,
  firstPartySkillSources,
  hashSkillFiles,
  diffSkillFiles,
  installFirstPartySkills,
  checkUpstreamUpdates,
  applyUpstreamUpdates,
  loadFirstPartyManifest,
  versionSatisfied,
  type FirstPartySkillSource,
  type SkillInstallReport,
  type UpstreamUpdate,
  type UpstreamIndex,
  type ApplyUpstreamReport,
} from "./workflow";
import {
  TRACKER_DIR,
  ghTracker,
  gitlabTracker,
  localMarkdownTracker,
  resolveTracker,
  resolveTrackerSync,
  trackerTools,
  projectFrontier,
  defaultRunner,
  type TrackerIssue,
  type TrackerBackend,
  type ShellRunner,
  type Frontier,
} from "./tracker";

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
  /** Interactive question channel for the ask_user tool. Without it (headless) the tool fails fast. */
  onAskUser?: (question: AskUserQuestion) => Promise<AskUserResult> | AskUserResult;
  /** Persistence seam: invoked for every appended event (e.g. `SessionStore.append`). */
  sink?: (event: AgentEvent) => void;
  /** System-prompt assembly (#27). Default: PromptComposer over the session cwd. */
  promptComposer?: PromptComposer;
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
   */
  subagents?: SubagentOptions;
  /**
   * Cross-session memory (#38): post-turn extraction via the maintenance
   * subagent, injected as a system-prompt section. `enabled: false`
   * disables everything (no writes, no section, no subagent runs).
   */
  memory?: MemoryOptions;
}

export function createSession(config: SessionConfig): AgentSession {
  return new AgentSession(config);
}

export {
  AgentSession,
  createMaintenanceExtractor,
  MemoryStore,
  lastAssistantText,
  memoryConfigSchema,
  memoryTranscript,
  parseMemoryEntries,
  topicFileName,
  MAINTENANCE_PROMPT,
  CHARS_PER_TOKEN,
  DEFAULT_MEMORY_BUDGET_TOKENS,
  DEFAULT_MEMORY_INTERVAL_TURNS,
  MAX_ENTRIES_PER_TOPIC,
  ExtensionRuntime,
  EchoProvider,
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
  declaredMcpServers,
  upsertMcpServer,
  persistToolAllow,
  persistMcpTrust,
  mohConfigSchema,
  McpError,
  McpRuntime,
  MCP_HANDSHAKE_TIMEOUT_MS,
  mcpServerEntrySchema,
  mcpToolName,
  loadUserMcpServers,
  declaredUserMcpServers,
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
  firstPartySkillNames,
  FIRST_PARTY_MANIFEST,
  MOH_VERSION,
  DEFAULT_UPSTREAM_URL,
  defaultBundleDir,
  firstPartySkillSources,
  hashSkillFiles,
  diffSkillFiles,
  installFirstPartySkills,
  checkUpstreamUpdates,
  applyUpstreamUpdates,
  loadFirstPartyManifest,
  versionSatisfied,
  TRACKER_DIR,
  ghTracker,
  gitlabTracker,
  localMarkdownTracker,
  resolveTracker,
  resolveTrackerSync,
  trackerTools,
  projectFrontier,
  defaultRunner,
  PermissionResolver,
  SubagentHost,
  BUILTIN_AGENT_PRESETS,
  DEFAULT_SUBAGENT_CONCURRENCY,
  subagentSpecSchema,
  type SubagentOptions,
  type SubagentResult,
  type SubagentSpec,
  type MemoryEntry,
  type MemoryExtractor,
  type MemoryExtractorInput,
  type MemoryOptions,
  runtimeRulesFromEvents,
  splitCommandSegments,
  type AgentEvent,
  type AskUserQuestion,
  type AskUserResult,
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
  type DeclaredMcpServer,
  type McpConsentAnswer,
  type McpErrorKind,
  type McpRuntimeOptions,
  type McpServerEntry,
  type McpServerState,
  type ProviderFactory,
  type ProviderFactoryOptions,
  type BuiltinProviderType,
  type ExtensionRuntimeOptions,
  type RuntimeExtension,
  type ConnectionTestResult,
  type ConnectionTester,
  type OnboardingIo,
  type FirstPartySkillSource,
  type SkillInstallReport,
  type UpstreamUpdate,
  type UpstreamIndex,
  type ApplyUpstreamReport,
  type TrackerIssue,
  type TrackerBackend,
  type ShellRunner,
  type Frontier,
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
