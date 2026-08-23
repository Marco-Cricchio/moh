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
import {
  sessionFromConfig,
  type AssemblyError,
  type AssemblyErrorKind,
  type SessionConsent,
  type SessionFromConfigOptions,
  type SessionFromConfigResult,
  type SessionOverrides,
} from "./session/from-config";
import { type PermissionsConfig, type SessionConfig } from "./session/config";
import { builtinTools } from "./builtin-tools";
import { ExtensionRuntime } from "./extensions";
import { PromptComposer, type SkillIndexEntry } from "./prompt-composer";
import { SessionStore } from "./session-store";
import {
  formatRule,
  overridesFromFlags,
  parseRule,
  RuleError,
  splitCommandSegments,
  type PermissionOverrides,
  type PermissionRule,
} from "./permissions";
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
import { readUserConfigFile, updateUserConfigFile, userConfigFile, type UserConfigData } from "./user-config";
import {
  loadMergedConfig,
  readUserProviderConfig,
  upsertUserEndpoint,
  saveUserProviderRef,
  type MergedConfigOptions,
  type UserProviderConfig,
} from "./provider-config";
import {
  authMethodKindSchema,
  anthropicAuthOverridesSchema,
  googleAuthOverridesSchema,
  openaiAuthOverridesSchema,
  type AnthropicAuthOverrides,
  type GoogleAuthOverrides,
  type OpenAiAuthOverrides,
  type AuthAccount,
  type AuthMethodKind,
  type AuthSection,
  type AuthToken,
} from "./auth/types";
import {
  clearTokens,
  getStoredToken,
  readAuthSection,
  readStoredTokens,
  saveTokens,
} from "./auth/store";
import { REFRESH_WINDOW_MS, resolveEndpointCredential, type CredentialResolveOptions } from "./auth/resolve";
import {
  TOS_WARNING,
  base64url,
  buildAuthorizeUrl,
  confirmToSWarning,
  generatePkce,
  generateState,
  raceForCode,
  startLoopbackCallback,
  type AuthorizationIo,
  type CallbackServer,
  type LoopbackOptions,
  type PkcePair,
  type RaceOptions,
} from "./auth/oauth";
import {
  ANTHROPIC_INFERENCE_SCOPE,
  ANTHROPIC_OAUTH_BETA,
  ANTHROPIC_OAUTH_DEFAULTS,
  ANTHROPIC_SUBSCRIPTION_SCOPES,
  AnthropicLoginAborted,
  buildAnthropicAuthorizeUrl,
  exchangeAnthropicCode,
  loginAnthropic,
  refreshAnthropicToken,
  resolveAnthropicOAuthConfig,
  type AnthropicOAuthConfig,
  type TokenEndpointFetch,
} from "./auth/anthropic";
import {
  OPENAI_OAUTH_DEFAULTS,
  OPENAI_SCOPES,
  OpenAiLoginAborted,
  loginOpenAI,
  refreshOpenaiToken,
  resolveOpenAiOAuthConfig,
  type OpenAiEndpointFetch,
  type OpenAiOAuthConfig,
} from "./auth/openai";
import {
  GOOGLE_API_BASE_URL,
  GOOGLE_OAUTH_DEFAULTS,
  GOOGLE_SCOPES,
  GoogleLoginAborted,
  buildGoogleAuthorizeUrl,
  exchangeGoogleCode,
  loginGoogle,
  refreshGoogleToken,
  resolveGoogleOAuthConfig,
  type GoogleEndpointFetch,
  type GoogleOAuthConfig,
} from "./auth/google";

export function createSession(config: SessionConfig): AgentSession {
  return new AgentSession(config);
}

export {
  AgentSession,
  REFRESH_WINDOW_MS,
  readAuthSection,
  resolveEndpointCredential,
  type CredentialResolveOptions,
  authMethodKindSchema,
  type AuthAccount,
  type AuthMethodKind,
  type AuthSection,
  type AuthToken,
  clearTokens,
  getStoredToken,
  readStoredTokens,
  saveTokens,
  TOS_WARNING,
  base64url,
  buildAuthorizeUrl,
  confirmToSWarning,
  generatePkce,
  generateState,
  raceForCode,
  startLoopbackCallback,
  type AuthorizationIo,
  type CallbackServer,
  type LoopbackOptions,
  type PkcePair,
  type RaceOptions,
  ANTHROPIC_INFERENCE_SCOPE,
  ANTHROPIC_OAUTH_BETA,
  ANTHROPIC_OAUTH_DEFAULTS,
  ANTHROPIC_SUBSCRIPTION_SCOPES,
  AnthropicLoginAborted,
  anthropicAuthOverridesSchema,
  buildAnthropicAuthorizeUrl,
  exchangeAnthropicCode,
  loginAnthropic,
  refreshAnthropicToken,
  resolveAnthropicOAuthConfig,
  type AnthropicAuthOverrides,
  type AnthropicOAuthConfig,
  type TokenEndpointFetch,
  OPENAI_OAUTH_DEFAULTS,
  OPENAI_SCOPES,
  OpenAiLoginAborted,
  openaiAuthOverridesSchema,
  loginOpenAI,
  refreshOpenaiToken,
  resolveOpenAiOAuthConfig,
  type OpenAiAuthOverrides,
  type OpenAiEndpointFetch,
  type OpenAiOAuthConfig,
  MockProvider,
  builtinTools,
  ExtensionRuntime,
  PromptComposer,
  SessionStore,
  splitCommandSegments,
  formatRule,
  parseRule,
  overridesFromFlags,
  RuleError,
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
  readUserConfigFile,
  updateUserConfigFile,
  userConfigFile,
  loadMergedConfig,
  readUserProviderConfig,
  upsertUserEndpoint,
  saveUserProviderRef,
  type MergedConfigOptions,
  type UserProviderConfig,
  defaultRegistry,
  resolveProvider,
  resolveProviderRef,
  sessionFromConfig,
  type SessionConfig,
  type AssemblyError,
  type AssemblyErrorKind,
  type SessionConsent,
  type SessionFromConfigOptions,
  type SessionFromConfigResult,
  type SessionOverrides,
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
  type UserConfigData,
  type TrackerIssue,
  type TrackerBackend,
  type AgentEvent,
  type AskUserQuestion,
  type AskUserResult,
  type Provider,
  type Tool,
};
