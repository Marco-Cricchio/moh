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
import { type ConfirmTurnRequest, type PermissionsConfig, type PermissionAskContext, type SessionConfig } from "./session/config";
import { builtinTools } from "./builtin-tools";
import { ExtensionRuntime, type ExtensionConsentRequest, type RuntimeExtension } from "./extensions";
import { PromptComposer, type SkillIndexEntry } from "./prompt-composer";
import type {
  AgentEvent,
  ExtensionControlPayload,
  ExtensionStatus,
  ReasoningStreamEvent,
  AskUserAnswer,
  AskUserQuestion,
  AskUserQuestionSet,
  AskUserSetResult,
  Provider,
  SendOptions,
  SkillPrompt,
  StreamOptions,
  ThinkingLevel,
  Tool,
} from "./types";
import { SCHEMA_VERSION } from "./types";
// #575: event identity — the ADR-0004 reopening that lets clients read
// and resolve event ids and the read-only `line:N` bridge.
import { type EventIdentity } from "./types";
import {
  SessionStore,
  listSessionSummaries,
  // #477: session rename — the ADR-0004 reopening that lets clients (TUI
  // Home picker, `moh sessions rename`) append the `session_renamed` event.
  renameSession,
  // Home pin: appends the `session_pinned` chrome event (TUI Home ctrl+p).
  setSessionPinned,
  // #478: session trash — the ADR-0004 reopening that lets clients (TUI Home
  // delete chip, `moh sessions delete` / `moh trash`) delete and restore.
  deleteSession,
  isSessionOpen,
  restoreSession,
  listTrashedSessions,
  type TrashedSessionSummary,
  type SessionSummary,
  // #467: session-notes path primitives — the ADR-0004 reopening that lets
  // clients resolve the canonical project directory without recomputing the slug.
  projectSlug,
  projectSessionsDir,
  // #576: branch switching + head resolution — the ADR-0004 reopening
  // that lets clients (TUI /tree, `moh` CLI) move the head, adopt a local
  // tail after divergence and resolve references. Session-level:
  // `session.switchBranch(to)`.
  switchBranch,
  // #579: bookmarks — the ADR-0004 reopening that lets clients (TUI /tree
  // `b`/`B`, `moh sessions bookmark`) set/rename/clear a node bookmark by
  // appending the `tree_bookmarked` event. Live-writer path:
  // `session.bookmarkNode(to, name?)`.
  bookmarkNode,
  localTipAt,
  resolveEventRef,
  lineRef,
  parseLineRef,
  // #576: head resolution (branch-aware) lives in session/event-log.
  resolveHead,
  // #577: the active-path projection (root→head linearization) — the
  // ADR-0004 reopening that lets clients (TUI /tree, CLI renderers,
  // tooling) read the same linear path the model context sees.
  activePath,
  // #578: on-path marker resolution + the dangling-pointer warning —
  // clients projecting their own replay need the same compaction
  // semantics the core applies (ADR-0004 reopening; to be recorded in
  // the session-tree ADR, #571).
  compactionProjection,
  replayWarnings,
  // #580: the client-facing tree projection (spec §1) — the single seam
  // the TUI /tree panel and the CLI renderer both consume. Returns the
  // TreeView or { error }; never throws.
  sessionTree,
  // #672: the text of the last completed assistant turn (cleared by any
  // later user message) — the /copy command's source. ADR-0004 export.
  lastAssistantText,
  type TreeView,
  type TreeNode,
} from "./session-store";
import {
  formatRule,
  overridesFromFlags,
  parseRule,
  RuleError,
  splitCommandSegments,
  urlGlobMatches,
  type PermissionOverrides,
  type PermissionRule,
} from "./permissions";
// #849: the session mode rides the setSessionMode/sessionMode doors — a
// client rotating the mode needs the same union the core judges with.
export type { SessionMode } from "./permissions";
import { type ProviderRegistry, defaultRegistry, resolveProvider, resolveProviderRef, isFallbackEligible, fallbackIneligibleReason } from "./provider-registry";
import { contextFitFor, CONTEXT_FIT_RESERVE, type ContextFitVerdict } from "./context-fit";
import { type MemoryOptions } from "./memory";
import { CompactionRunner, type CompactionOptions, type CompactionSummarizer, type CompactionSummarizerInput } from "./compaction";
// #488: file mentions — the ADR-0004 reopening that lets clients expand
// `@path` tokens (TUI popup plumbing, `moh run` headless sends).
export {
  assembleMentions,
  expandMentions,
  parseMentions,
  mimeForPath,
  renderMentionAttachment,
  imageDimensions,
  IMAGE_MENTION_CAP,
  IMAGE_MENTION_MIMES,
  MENTION_TEXT_CAP,
  MENTION_DIR_ENTRY_CAP,
  type ExpandedMention,
  type ExpandMentionsResult,
  type MentionAttachment,
  type MentionCanRead,
  type MentionWarning,
  type ParsedMention,
  type AssembleMentionsOptions,
  type AssembleMentionsResult,
} from "./mentions";
import { type SubagentOptions } from "./subagents";
// #497: child-log tail seam — the ADR-0004 reopening that lets clients
// (TUI subagent chips + live panel) tail a running child session's log
// without full replay and without holding the child AgentSession.
export {
  tailChildLog,
  childTailLine,
  CHILD_TAIL_MAX_LINES,
  type ChildTailLine,
  type ChildActivity,
  type ChildTailResult,
} from "./child-tail";
// #499: quota seam — the ADR-0004 reopening that lets clients (TUI usage
// quota modal, CLI) probe an endpoint's usage quota without knowing the
// per-provider endpoints; any failure degrades to `null` (local row).
export {
  getQuota,
  aggregateLocalUsage,
  type QuotaReport,
  type QuotaSource,
  type QuotaWindow,
  type QuotaOptions,
  type QuotaFetch,
  type LocalUsageRow,
  type BillingPlanResolver,
} from "./quota";
// #714: the multi-session telemetry aggregator — the deep module the CLI/TUI
// usage surfaces project. Read-only metadata projection over session event
// logs (ADR-0004 reopening: a client-facing config surface, `moh usage`).
export {
  aggregateTelemetry,
  type TelemetryReport,
  type TelemetryModelRow,
  type TelemetryToolRow,
  type TelemetryRouteHealth,
  type TelemetryFallbackRow,
  type TelemetryRouteServingRow,
  type TelemetrySessionRow,
  type TelemetrySubagentRow,
} from "./telemetry";

// #767: the single-session analysis report — `moh sessions analyze` and the
// TUI `/session` modal project it. Read-only metadata projection (ADR-0004).
export {
  analyzeSession,
  type SessionAnalysisReport,
  type SessionModelRow,
  type SessionToolRow,
  type SessionPermissionStats,
  type SessionShapeStats,
  type SessionTreeStats,
} from "./session-analyze";

import { skillRecommendations, formatSkillCommand, type SkillRecommendation, type SkillRoutingConfig, type SkillRouteOverride } from "./skill-routing";
// #765: prompt snippets — skill argument parsing and placeholder
// substitution. Pure and client-reusable (the TUI detects
// placeholder-bearing skill bodies and pre-fills unresolved args).
export {
  parseSkillArgs,
  substituteSkillArgs,
  hasSkillPlaceholders,
  type SkillArgs,
} from "./skill-args";
// #498: the unlimited sentinel for `maxIterations` is a user-facing config
// surface (TUI settings row, CLI `--max-iterations`), so clients need the
// sentinel constant and the shared resolver.
export { MAX_ITERATIONS_UNLIMITED, resolveMaxIterations, DEFAULT_MAX_ITERATIONS } from "./session/agent-loop";
// ADR-0033 §4: the outcome vocabulary a client's confirmation seam answers
// with ("send" | "cancel" | "refuse") — the extension contract's type,
// re-exported so a client needs one import for the whole seam.
export type { TurnConfirmOutcome } from "@moh/extension";
import { McpRuntime, mcpServerEntrySchema, declaredUserMcpServers, isProjectServerTrusted, persistProjectMcpTrust, type DeclaredMcpServer, type McpServerEntry, type McpRuntimeOptions } from "./mcp";
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
  addProviderToFile,
  runProviderAdd,
  BUILTIN_PROVIDER_TYPES,
  KNOWN_COMPAT_ENDPOINTS,
  OPENCODE_AUTH_URL,
  OPENCODE_ENDPOINTS,
  OnboardingAborted,
  type BuiltinProviderType,
  type KnownCompatEndpoint,
  type ConnectionTestResult,
  type ConnectionTester,
  type OnboardingIo,
  type ProviderAddOptions,
} from "./provider-onboarding";
export { PROVIDER_PROFILES, providerProfile, providerEndpointChoices, providerRequiresBaseUrlInput, isProviderProfile, type ProviderProfile, type ProviderProfileId } from "./provider-profiles";
export { catalogEntryFor, pricingForModel, pricingForPlan, modelSupportsImages, endpointModelCatalog, knownCompatEndpointMetadata, subscriptionModelCatalog, type BillingPlan, type CatalogModel, type ModelPricing, type ModelPricingTier, type KnownCompatEndpointMetadata } from "./model-catalog";
export { billingPlanResolver, estimateModelCost, PRICING_SNAPSHOT, type ModelCostEstimate } from "./pricing";
export {
  fetchLiveCatalogs,
  liveListings,
  summarizeLiveCatalogReport,
  liveCatalogFailureReasons,
  reportNeedsNotice,
  type LiveModelListing,
  type LiveCatalogReport,
  type LiveCatalogResult,
  type LiveCatalogStatus,
} from "./live-model-catalog";
export { allTosCards, renderTosCard, tosCardFor, type TosCard, type TosLink } from "./tos-cards";
// #614: MPM — the ADR-0004 reopening that lets clients (TUI status row #619,
// CLI diagnostics #618) read MPM status and run read-only structural
// queries. The service owns the projection; clients never touch storage.
export {
  MpmService,
  MPM_DEFAULT_MAX_FILES,
  MPM_DEFAULT_MAX_TOTAL_BYTES,
  projectMapDir,
  type MpmQueryResult,
  type MpmStatus,
  type MpmQuota,
} from "./mpm/service";
export { MpmLifecycle, type MpmLifecycleOptions } from "./mpm/lifecycle";
// MPM handoff warm-up (#620): validated, non-blocking local warm-up
// priorities derived from a received handoff — never MPM data transport.
export {
  validatedWarmupPaths,
  requestWarmup,
  pathsFromTestCommands,
  staysInsideRoot,
  type HandoffWarmupHints,
} from "./mpm/handoff-warmup";
export { mpmDiagnostics, type MpmDiagnostics, type MpmLanguageCoverage } from "./mpm/diagnostics";
export {
  resolveMpmConfig,
  readMpmUserConfig,
  type MpmUserConfig,
  type MpmProjectConfig,
  type MpmEffectiveConfig,
} from "./mpm/config";
export {
  MPM_FORMAT_VERSION,
  type MpmFileRecord,
  type MpmProvenance,
  type MpmSymbol,
  type MpmRelation,
  type MpmFallbackReason,
} from "./mpm/types";
// #790: the rerank seam types — the config surface (`SessionConfig.mpm.rerank`)
// references them, so they are public by the ADR-0004 criterion.
export { type RerankCandidate, type RerankRequest, type RerankResponse } from "./mpm/orientation";
export { allManualPages, manualIndex, manualPage, manualSubsetViolations, type ManualPage } from "./manual";
export {
  clearThinkingPreference,
  defaultThinkingLevel,
  effectiveThinkingLevel,
  endpointThinkingStatus,
  readThinkingPreference,
  readThinkingPreferences,
  resolveEndpointThinking,
  setThinkingPreference,
  thinkingLevelStates,
  thinkingStatesForRef,
  THINKING_LEVELS,
  FORMAT_EXPRESSIBLE_LEVELS,
  type ThinkingDeclaration,
  type ThinkingEndpoint,
  type ThinkingLevelState,
  type ThinkingModelDeclaration,
  type ThinkingPreferences,
} from "./thinking-preferences";
export { isThinkingLevel, type ThinkingFormat } from "./types";
export { listOpenAiCompatModels } from "./endpoint-models";
// #935: the browser-toolchain seam (ADR-0004 amendment) — status probing
// and the guided installer for the optional browser tool, shared by the
// TUI (Settings / warning action) and the CLI. Resolution, the lock, the
// staging swap and the Playwright registry access stay internal.
export {
  browserToolchainRoot,
  probeBrowserToolchain,
  installBrowserToolchain,
  BROWSER_SETUP_HINT,
  BROWSER_WITH_DEPS_NOTE,
  HEADLESS_SHELL_DOWNLOAD_SIZE,
  FULL_CHROMIUM_DOWNLOAD_SIZE,
  type BrowserBuildStatus,
  type BrowserToolchainInstallOptions,
  type BrowserToolchainInstallResult,
  type BrowserToolchainOptions,
  type BrowserToolchainStatus,
  type BrowserToolchainProgress,
} from "./browser-toolchain";
import {
  isSubscriptionKind,
  providerLogin,
  providerLogout,
  providerStatus,
  runSubscriptionLogin,
  ANTHROPIC_USAGE_URL,
  SUBSCRIPTION_KINDS,
  type EndpointAuthStatus,
  type LoginOptions,
  type SubscriptionKind,
  type SubscriptionLogin,
  type SubscriptionStatus,
  type UsageFetch,
  type AuthEndpointFetch,
} from "./auth/lifecycle";
import {
  MOH_VERSION,
  installFirstPartySkills,
  embeddedSkillSources,
  bundledSkillSources,
  checkUpstreamUpdates,
  applyUpstreamUpdates,
  validateSkillEntry,
  loadFirstPartyManifest,
  diffSkillFiles,
  readBundledSkill,
  type UpstreamUpdate,
  type UpstreamCheckResult,
} from "./workflow";
import {
  checkForUpdate,
  isDevRun,
  readUpdateCache,
  updateDue,
  updateNoticeFor,
  UPDATE_CHECK_INTERVAL_MS,
  type UpdateNotice,
} from "./update-check";
export {
  UPDATE_PLATFORMS,
  assetUrl,
  checksumFor,
  detectUpdatePlatform,
  isPrerelease,
  performSelfUpdate,
  releasesUrl,
  type SelfUpdateIo,
  type SelfUpdateProgress,
  type SelfUpdateResult,
  type SelfUpdateStatus,
  type UpdatePlatform,
} from "./self-update";
import {
  trackerTools,
  projectFrontier,
  resolveTracker,
  resolveTrackerSync,
  // #939: fills the sync twin's memo from a promise continuation, so the TUI
  // boot (or renderTui's warm-up) leaves a spawn-free startup path behind it.
  prepareTrackerRemote,
  type TrackerIssue,
  type TrackerBackend,
} from "./tracker";
// #939: the identity boot seam. A client resolves the project identity
// before the first React window (renderTui, which runs outside the render)
// and App's own gate awaits it when nothing did; afterwards every resolution
// is memory-served, so no synchronous `git` spawn is reachable from a render.
import {
  prepareProjectIdentity,
  prepareProjectIdentityNow,
  isProjectIdentityPrepared,
} from "./project-identity";
import { readUserConfigFile, updateUserConfigFile, userConfigFile, type UserConfigData, type UserConfigIo } from "./user-config";
// #826: the bundled-extension seam. The core knows how to host first-party
// code that ships inside the binary; it does not know which extension that
// is — the client mounts the sources (the first-party one lives in its own
// workspace package, which the core does not depend on).
import {
  resolveBundledExtensions,
  type BundledActivationContext,
  type BundledExtensionSource,
  type BundledInstanceReader,
  type BundledResolution,
  type BundledWiring,
  type MountedBundledExtension,
} from "./bundled-extensions";
import {
  publishHandoffAtExit,
  readRawHandoff,
  handoffAlreadyPublished,
  handoffPublishedMarkerFile,
  type HandoffPayload,
  type HandoffTransport,
  type HandoffTransportError,
  type PublishHandoffOptions,
  type PublishHandoffResult,
} from "./handoff-transport";
import { createGistHandoffTransport, discoverGistHandoffs, ghUsername, spawnGh, type GistHandoffOffer, type DiscoverGistHandoffsOptions } from "./handoff-gist";
import { cloneHandoffRepo, isColdDirectory, pullHandoffTo, type CloneHandoffRepoOptions, type CloneHandoffRepoResult, type GitCall, type GitRunner, type PullHandoffOptions, type PullHandoffResult } from "./handoff-coldstart";
import {
  discoverHandoff,
  isHandoffStale,
  handoffSeedPrompt,
  handoffSeedMessage,
  type HandoffOffer,
  type DiscoverHandoffOptions,
} from "./handoff-reception";
import { handoffDebug, handoffDebugEnabled, type HandoffDebugStage } from "./handoff-debug";
import { HandoffRunner, transportActive, type RawHandoff, type HandoffGitAnchor } from "./handoff";
import { enrichHandoffWithWayfinder, notifyClaimedWayfinderTickets } from "./handoff-wayfinder";
import {
  exportHandoffFile,
  importHandoffFile,
  readImportedHandoff,
  importedHandoffFile,
  type ExportHandoffOptions,
  type ExportHandoffResult,
  type ImportHandoffOptions,
  type ImportHandoffResult,
} from "./handoff-file";
import {
  loadMergedConfig,
  readUserProviderConfig,
  upsertUserEndpoint,
  removeUserEndpoint,
  saveUserProviderRef,
  setUserEndpointModel,
  setUserEndpointFallbackEligible,
  type MergedConfigOptions,
  type UserProviderConfig,
} from "./provider-config";
import {
  authMethodKindSchema,
  anthropicAuthOverridesSchema,
  googleAuthOverridesSchema,
  openaiAuthOverridesSchema,
  openrouterAuthOverridesSchema,
  kimiCodingAuthOverridesSchema,
  xaiAuthOverridesSchema,
  githubCopilotAuthOverridesSchema,
  type AnthropicAuthOverrides,
  type GoogleAuthOverrides,
  type OpenAiAuthOverrides,
  type OpenrouterAuthOverrides,
  type KimiCodingAuthOverrides,
  type XaiAuthOverrides,
  type GithubCopilotAuthOverrides,
  type AuthAccount,
  type AuthMethodKind,
  type AuthSection,
  type AuthToken,
} from "./auth/types";
import {
  clearTokens,
  clearStoredApiKey,
  getStoredApiKey,
  getStoredToken,
  readAuthSection,
  readStoredTokens,
  saveStoredApiKey,
  saveTokens,
} from "./auth/store";
import {
  CODE_RECEIVED_MSG,
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
  CHATGPT_CODEX_BASE_URL,
  CHATGPT_CODEX_ORIGINATOR,
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
import {
  OPENROUTER_API_BASE_URL,
  OPENROUTER_OAUTH_DEFAULTS,
  OpenrouterLoginAborted,
  exchangeOpenrouterCode,
  loginOpenRouter,
  parseOpenrouterAuthorizationInput,
  resolveOpenrouterOAuthConfig,
  type OpenrouterEndpointFetch,
  type OpenrouterOAuthConfig,
} from "./auth/openrouter";
import {
  XAI_API_BASE_URL,
  XAI_OAUTH_DEFAULTS,
  XAI_SCOPES,
  XaiLoginAborted,
  loginXai,
  refreshXaiToken,
  resolveXaiOAuthConfig,
  type XaiEndpointFetch,
  type XaiOAuthConfig,
} from "./auth/xai";
import {
  KIMI_CODE_API_BASE_URL,
  KIMI_CODE_OAUTH_DEFAULTS,
  KimiCodingLoginAborted,
  loginKimiCoding,
  refreshKimiCodingToken,
  resolveKimiCodingOAuthConfig,
  type KimiCodingEndpointFetch,
  type KimiCodingOAuthConfig,
} from "./auth/kimi-coding";
import {
  COPILOT_CLIENT_ID,
  COPILOT_DEFAULT_BASE_URL,
  COPILOT_EDITOR_HEADERS,
  COPILOT_OAUTH_DEFAULTS,
  COPILOT_DEVICE_SCOPE,
  CopilotLoginAborted,
  copilotAuthContext,
  copilotBaseUrl,
  copilotBaseUrlFromToken,
  exchangeCopilotToken,
  loginGitHubCopilot,
  normalizeGithubDomain,
  refreshCopilotToken,
  type CopilotEndpointFetch,
} from "./auth/github-copilot";

export function createSession(config: SessionConfig): AgentSession {
  return new AgentSession(config);
}

export {
  AgentSession,
  authMethodKindSchema,
  type AuthAccount,
  type AuthMethodKind,
  type AuthSection,
  type AuthToken,
  clearTokens,
  clearStoredApiKey,
  getStoredApiKey,
  getStoredToken,
  readAuthSection,
  readStoredTokens,
  saveStoredApiKey,
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
  openrouterAuthOverridesSchema,
  kimiCodingAuthOverridesSchema,
  xaiAuthOverridesSchema,
  githubCopilotAuthOverridesSchema,
  buildAnthropicAuthorizeUrl,
  exchangeAnthropicCode,
  loginAnthropic,
  refreshAnthropicToken,
  resolveAnthropicOAuthConfig,
  type AnthropicAuthOverrides,
  type AnthropicOAuthConfig,
  type OpenrouterAuthOverrides,
  type KimiCodingAuthOverrides,
  type XaiAuthOverrides,
  type GithubCopilotAuthOverrides,
  type TokenEndpointFetch,
  CHATGPT_CODEX_BASE_URL,
  CHATGPT_CODEX_ORIGINATOR,
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
  OPENROUTER_API_BASE_URL,
  OPENROUTER_OAUTH_DEFAULTS,
  OpenrouterLoginAborted,
  exchangeOpenrouterCode,
  loginOpenRouter,
  parseOpenrouterAuthorizationInput,
  resolveOpenrouterOAuthConfig,
  type OpenrouterEndpointFetch,
  type OpenrouterOAuthConfig,
  XAI_API_BASE_URL,
  XAI_OAUTH_DEFAULTS,
  XAI_SCOPES,
  XaiLoginAborted,
  loginXai,
  refreshXaiToken,
  resolveXaiOAuthConfig,
  type XaiEndpointFetch,
  type XaiOAuthConfig,
  KIMI_CODE_API_BASE_URL,
  KIMI_CODE_OAUTH_DEFAULTS,
  KimiCodingLoginAborted,
  loginKimiCoding,
  refreshKimiCodingToken,
  resolveKimiCodingOAuthConfig,
  type KimiCodingEndpointFetch,
  type KimiCodingOAuthConfig,
  COPILOT_CLIENT_ID,
  COPILOT_DEFAULT_BASE_URL,
  COPILOT_EDITOR_HEADERS,
  COPILOT_OAUTH_DEFAULTS,
  COPILOT_DEVICE_SCOPE,
  CopilotLoginAborted,
  copilotAuthContext,
  copilotBaseUrl,
  copilotBaseUrlFromToken,
  exchangeCopilotToken,
  loginGitHubCopilot,
  normalizeGithubDomain,
  refreshCopilotToken,
  type CopilotEndpointFetch,
  MockProvider,
  builtinTools,
  ExtensionRuntime,
  type RuntimeExtension,
  PromptComposer,
  type SendOptions,
  type SkillPrompt,
  SessionStore,
  listSessionSummaries,
  // #672: the text of the last completed assistant turn (cleared by any
  // later user message) — the /copy command's source. ADR-0004 export.
  lastAssistantText,
  renameSession,
  setSessionPinned,
  // #478: session trash — the ADR-0004 reopening that lets clients (TUI Home
  // delete chip, `moh sessions delete` / `moh trash`) delete and restore.
  deleteSession,
  isSessionOpen, // #582: refuse switch on an open session (TUI-only switch)
  restoreSession,
  listTrashedSessions,
  type TrashedSessionSummary,
  type SessionSummary,
  // #467: session-notes path primitives — the ADR-0004 reopening that lets
  // clients resolve the canonical project directory without recomputing the slug.
  projectSlug,
  projectSessionsDir,
  // #939: the identity boot seam — the client resolves the identity
  // before the first React window, so nothing spawns on a render path.
  prepareProjectIdentity,
  prepareProjectIdentityNow,
  isProjectIdentityPrepared,
  splitCommandSegments,
  formatRule,
  parseRule,
  overridesFromFlags,
  urlGlobMatches,
  RuleError,
  McpRuntime,
  mcpServerEntrySchema,
  loadMohConfig,
  writeMohConfig,
  upsertEndpoint,
  upsertMcpServer,
  declaredMcpServers,
  declaredUserMcpServers,
  isProjectServerTrusted,
  persistProjectMcpTrust,
  minimalConnectionTest,
  addProviderToFile,
  runProviderAdd,
  OnboardingAborted,
  BUILTIN_PROVIDER_TYPES,
  KNOWN_COMPAT_ENDPOINTS,
  OPENCODE_AUTH_URL,
  OPENCODE_ENDPOINTS,
  installFirstPartySkills,
  checkUpstreamUpdates,
  applyUpstreamUpdates,
  validateSkillEntry,
  loadFirstPartyManifest,
  diffSkillFiles,
  readBundledSkill,
  MOH_VERSION,
  checkForUpdate,
  isDevRun,
  readUpdateCache,
  updateDue,
  updateNoticeFor,
  UPDATE_CHECK_INTERVAL_MS,
  UpdateNotice,
  trackerTools,
  projectFrontier,
  resolveTracker,
  resolveTrackerSync,
  // #939: fills the sync twin's memo from a promise continuation.
  prepareTrackerRemote,
  readUserConfigFile,
  updateUserConfigFile,
  userConfigFile,
  type UserConfigIo,
  // #826: hosting a bundled first-party extension (a client mounts it from
  // its own package). The vendor config surface moved with its owner.
  resolveBundledExtensions,
  type BundledActivationContext,
  type BundledExtensionSource,
  type BundledInstanceReader,
  type BundledResolution,
  type BundledWiring,
  type MountedBundledExtension,
  loadMergedConfig,
  readUserProviderConfig,
  upsertUserEndpoint,
  removeUserEndpoint,
  saveUserProviderRef,
  setUserEndpointModel,
  setUserEndpointFallbackEligible,
  type MergedConfigOptions,
  type UserProviderConfig,
  defaultRegistry,
  resolveProvider,
  resolveProviderRef,
  isFallbackEligible,
  fallbackIneligibleReason,
  sessionFromConfig,
  // Session handoff (#433, T2 #435): the transport seam and gist impl
  // are client surfaces (exit wiring, TUI/CLI) — not agent-loop API.
  type HandoffTransport,
  type HandoffPayload,
  type HandoffTransportError,
  type PublishHandoffOptions,
  type PublishHandoffResult,
  publishHandoffAtExit,
  readRawHandoff,
  handoffAlreadyPublished,
  handoffPublishedMarkerFile,
  HandoffRunner,
  type RawHandoff,
  type HandoffGitAnchor,
  transportActive,
  createGistHandoffTransport,
  discoverGistHandoffs,
  ghUsername,
  spawnGh,
  // Cold-directory wizard (#595): the gate, clone and pull steps.
  isColdDirectory,
  cloneHandoffRepo,
  pullHandoffTo,
  type GistHandoffOffer,
  type DiscoverGistHandoffsOptions,
  type GitCall,
  type GitRunner,
  type CloneHandoffRepoOptions,
  type CloneHandoffRepoResult,
  type PullHandoffOptions,
  type PullHandoffResult,
  // Reception (T3 #436) and Wayfinder read/cite (T6 #439) client surfaces.
  discoverHandoff,
  isHandoffStale,
  handoffSeedPrompt,
  handoffSeedMessage,
  handoffDebug,
  handoffDebugEnabled,
  enrichHandoffWithWayfinder,
  notifyClaimedWayfinderTickets,
  type HandoffOffer,
  type DiscoverHandoffOptions,
  type HandoffDebugStage,
  // Manual file fallback (T7 #440): export/import via file.
  exportHandoffFile,
  importHandoffFile,
  readImportedHandoff,
  importedHandoffFile,
  type ExportHandoffOptions,
  type ExportHandoffResult,
  type ImportHandoffOptions,
  type ImportHandoffResult,
  type SessionConfig,
  // #784/ADR-0031: the extension-ask context a client's consent seam
  // receives (the TUI renders yes/no only, labelled with the reason).
  type PermissionAskContext,
  // ADR-0033 §4 (#791): the pre-send confirmation a client's consent seam
  // answers — one request per confirmed turn, and the outcome vocabulary
  // it answers with (the extension contract's own type, re-exported so a
  // client needs one import).
  type ConfirmTurnRequest,
  type AssemblyError,
  type AssemblyErrorKind,
  type SessionConsent,
  type SessionFromConfigOptions,
  type SessionFromConfigResult,
  type SessionOverrides,
  type ExtensionConsentRequest,
  type PermissionsConfig,
  type SkillIndexEntry,
  type DeclaredMcpServer,
  type PermissionOverrides,
  type PermissionRule,
  type ProviderRegistry,
  type MemoryOptions,
  CompactionRunner,
  type CompactionOptions,
  type CompactionSummarizer,
  type CompactionSummarizerInput,
  type SubagentOptions,
  type McpServerEntry,
  type McpRuntimeOptions,
  type EndpointProfile,
  type MohConfig,
  skillRecommendations,
  formatSkillCommand,
  type SkillRecommendation,
  type SkillRoutingConfig,
  type SkillRouteOverride,
  type BuiltinProviderType,
  type KnownCompatEndpoint,
  type ConnectionTestResult,
  type ConnectionTester,
  type OnboardingIo,
  type ProviderAddOptions,
  isSubscriptionKind,
  providerLogin,
  providerLogout,
  providerStatus,
  runSubscriptionLogin,
  ANTHROPIC_USAGE_URL,
  SUBSCRIPTION_KINDS,
  type EndpointAuthStatus,
  type LoginOptions,
  type SubscriptionKind,
  type SubscriptionLogin,
  type SubscriptionStatus,
  type UsageFetch,
  type AuthEndpointFetch,
  type UpstreamUpdate,
  type UpstreamCheckResult,
  type UserConfigData,
  type TrackerIssue,
  type TrackerBackend,
  type AgentEvent,
  type EventIdentity,
  type ExtensionStatus,
  SCHEMA_VERSION,
  type ReasoningStreamEvent,
  type StreamOptions,
  type ThinkingLevel,
  type AskUserAnswer,
  type AskUserQuestion,
  type AskUserQuestionSet,
  type AskUserSetResult,
  type Provider,
  type Tool,
  // #576: session-tree surface — head resolution + reference helpers.
  resolveHead,
  // #577: active-path projection (root→head linearization).
  activePath,
  resolveEventRef,
  lineRef,
  parseLineRef,
  switchBranch,
  // #579: bookmark writer seam (see the import comment above).
  bookmarkNode,
  localTipAt,
  sessionTree,
  type TreeView,
  type TreeNode,
};
