/**
 * @moh/core public surface (ADR-0004).
 *
 * Keep-criterion: a symbol is exported only if a client (@moh/tui,
 * @moh/cli, @moh/extension) or a user-facing config surface touches it
 * today. Everything else is internal — tests and internal code import
 * directly from the defining module. Re-opening a closed door is an
 * explicit, recorded decision (ADR). The reasoned keep-list lives in
 * `docs/adr/0004-public-surface-criterion.md`.
 */
import { MockProvider } from "./mock-provider";
import { AgentSession } from "./session/session";
import { type PermissionsConfig, type SessionConfig } from "./session/config";
import { builtinTools } from "./builtin-tools";
import { ExtensionRuntime } from "./extensions";
import { PromptComposer, type SkillIndexEntry } from "./prompt-composer";
import { SessionStore } from "./session-store";
import { splitCommandSegments, type PermissionOverrides, type PermissionRule } from "./permissions";
import { type ProviderRegistry, defaultRegistry, resolveProvider, resolveProviderRef } from "./provider-registry";
import { type MemoryOptions } from "./memory";
import { type SubagentOptions } from "./subagents";
import { McpRuntime, mcpServerEntrySchema, declaredUserMcpServers, type DeclaredMcpServer, type McpServerEntry, type McpRuntimeOptions } from "./mcp";
import type { AgentEvent, AskUserQuestion, AskUserResult, Provider, Tool } from "./types";
import {
  loadMohConfig,
  writeMohConfig,
  upsertEndpoint,
  upsertMcpServer,
  declaredMcpServers,
  type EndpointProfile,
  type MohConfig,
} from "./config";
import {
  minimalConnectionTest,
  BUILTIN_PROVIDER_TYPES,
  type BuiltinProviderType,
  type ConnectionTestResult,
  type ConnectionTester,
} from "./provider-onboarding";
import {
  installFirstPartySkills,
  checkUpstreamUpdates,
  applyUpstreamUpdates,
  loadFirstPartyManifest,
  diffSkillFiles,
  type UpstreamUpdate,
} from "./workflow";
import {
  trackerTools,
  projectFrontier,
  resolveTrackerSync,
  type TrackerIssue,
  type TrackerBackend,
} from "./tracker";

export function createSession(config: SessionConfig): AgentSession {
  return new AgentSession(config);
}

export {
  AgentSession,
  MockProvider,
  builtinTools,
  ExtensionRuntime,
  PromptComposer,
  SessionStore,
  splitCommandSegments,
  McpRuntime,
  mcpServerEntrySchema,
  loadMohConfig,
  writeMohConfig,
  upsertEndpoint,
  upsertMcpServer,
  declaredMcpServers,
  declaredUserMcpServers,
  minimalConnectionTest,
  BUILTIN_PROVIDER_TYPES,
  installFirstPartySkills,
  checkUpstreamUpdates,
  applyUpstreamUpdates,
  loadFirstPartyManifest,
  diffSkillFiles,
  trackerTools,
  projectFrontier,
  resolveTrackerSync,
  defaultRegistry,
  resolveProvider,
  resolveProviderRef,
  type SessionConfig,
  type PermissionsConfig,
  type SkillIndexEntry,
  type DeclaredMcpServer,
  type PermissionOverrides,
  type PermissionRule,
  type ProviderRegistry,
  type MemoryOptions,
  type SubagentOptions,
  type McpServerEntry,
  type McpRuntimeOptions,
  type EndpointProfile,
  type MohConfig,
  type BuiltinProviderType,
  type ConnectionTestResult,
  type ConnectionTester,
  type UpstreamUpdate,
  type TrackerIssue,
  type TrackerBackend,
  type AgentEvent,
  type AskUserQuestion,
  type AskUserResult,
  type Provider,
  type Tool,
};
