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
export { MockProvider } from "./mock-provider";
import { AgentSession } from "./session/session";
export {
  sessionFromConfig,
  type AssemblyError,
  type AssemblyErrorKind,
  type SessionConsent,
  type SessionFromConfigOptions,
  type SessionFromConfigResult,
  type SessionOverrides,
} from "./session/from-config";
import { type SessionConfig } from "./session/config";
export {
  // ADR-0033 §4 (#791): the pre-send confirmation a client's consent seam
  // answers — one request per confirmed turn, and the outcome vocabulary
  // it answers with (the extension contract's own type, re-exported so a
  // client needs one import).
  type ConfirmTurnRequest,
  type PermissionsConfig,
  // #784/ADR-0031: the extension-ask context a client's consent seam
  // receives (the TUI renders yes/no only, labelled with the reason).
  type PermissionAskContext,
} from "./session/config";
export { builtinTools } from "./builtin-tools";
export {
  ExtensionRuntime,
  MAX_PANELS,
  type ExtensionConsentRequest,
  type RuntimeExtension,
  type ActiveExtensionOverlay,
} from "./extensions";
export {
  // #1128 (ADR-0061): the extension registry — install from immutable
  // sources with static checks only; package code is never executed.
  installExtension,
  realRegistryIo,
  listInstalledExtensions,
  parseExtensionRef,
  removeInstalledExtension,
  registryRoots,
  verifyIntegrity,
  KNOWN_CAPABILITY_SLOTS,
  isKnownCapability,
  type RegistryIo,
  type ExtensionRef,
  type InstallOptions,
  type InstallResult,
  type InstalledExtension,
  type NpmPackument,
} from "./extension-registry";
export {
  // ADR-0064/0065: the core-owned scope effect-sentence renderer the
  // clients' consent surfaces show instead of the naked scope string.
  scopeEffectSentence,
} from "./scope-effect";
export {
  // ADR-0069 (#1161): the user-mint credential store the CLI's
  // `moh secret` surface and session assembly share.
  defaultCredentialStore,
  validateCredentialScope,
  type CredentialStore,
} from "./credential-scope";
export { PromptComposer, type SkillIndexEntry } from "./prompt-composer";
export type {
  AgentEvent,
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
export { SCHEMA_VERSION } from "./types";
// #575: event identity — the ADR-0004 reopening that lets clients read
// and resolve event ids and the read-only `line:N` bridge.
export { type EventIdentity } from "./types";
export {
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
  isSessionOpen, // #582: refuse switch on an open session (TUI-only switch)
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
  // #579: bookmark writer seam (see the import comment above).
  bookmarkNode,
  localTipAt,
  resolveEventRef,
  lineRef,
  parseLineRef,
  // #576: head resolution (branch-aware) lives in session/event-log.
  // #576: session-tree surface — head resolution + reference helpers.
  resolveHead,
  // #577: the active-path projection (root→head linearization) — the
  // ADR-0004 reopening that lets clients (TUI /tree, CLI renderers,
  // tooling) read the same linear path the model context sees.
  // #577: active-path projection (root→head linearization).
  activePath,
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
export {
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
export {
  type ProviderRegistry,
  defaultRegistry,
  resolveProvider,
  resolveProviderRef,
  isFallbackEligible,
  fallbackIneligibleReason,
} from "./provider-registry";
export { type MemoryOptions } from "./memory";
export {
  CompactionRunner,
  compactionFacts,
  createDeterministicSummarizer,
  renderDeterministicDigest,
  type CompactionFacts,
  type CompactionOptions,
  type CompactionSummarizer,
  type CompactionSummarizerInput,
} from "./compaction";
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
export { type SubagentOptions } from "./subagents";
export { ExtensionSpawnRefusedError } from "./extension-scope";
export {
  DevelopmentLaneStore,
  type CreateFeatureGroupInput,
  type CreateLaneInput,
  type DevelopmentLane,
  type FeatureGroup,
  type LaneRelation,
  type LaneStatus,
  type LaneStoreOptions,
} from "./development-lanes";
export {
  DevelopmentLaneService,
  defaultLaneGitRunner,
  laneWorktreeDirName,
  laneWorktreeRootFor,
  mainCheckoutFor,
  readLaneSetup,
  resolveWorktreePath,
  type CleanupCandidate,
  type CleanupOptions,
  type CleanupReport,
  type CreateWorktreeLaneInput,
  type LaneConflict,
  type LaneGitResult,
  type LaneGitRunner,
  type LaneInstallDrift,
  type LaneInstallRepair,
  type LaneOperationError,
  type LaneOperationResult,
  type LaneServiceOptions,
} from "./development-lane-service";
// ADR-0060 amendment 5: the install outcome rides the lane record, and
// `laneInstallLine` is the one sentence the lane surfaces render for it
// (CLI `moh lanes`, the TUI /lanes detail row and the provisioning
// notice). The detection table, the ownership predicate and the installer
// are internal — tests import them from ./lane-install directly (ADR-0004).
export { laneInstallLine, type LaneInstallOutcome } from "./lane-install";
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
// #1100 (P1 quota telemetry): the observation/episode producers and the
// read-only projections over the recorded quota events (ADR-0004
// reopening: `recordQuota` clients project reports into the log).
export {
  observationsFromQuotaReport,
  quotaEventsFromProviderError,
  quotaRecoveryEvent,
  commercialDeclarationEvent,
  declarationInForce,
  scopeKeyFor,
  quotaEpisodes,
  quotaContradictions,
  summarizeQuota,
  quotaPressure,
  type QuotaEpisode,
  type QuotaContradiction,
  type QuotaSummary,
  type QuotaPressureRow,
  type CommercialDeclarationInput,
} from "./quota/telemetry";
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
// #1101 (P2): the task-outcome producers and the read-only performance /
// task projections. Explicit client seams only — never model-inferred;
// `unknown` is the default outcome state.
export {
  redactSummary,
  taskDeclaredEvent,
  taskVerificationEvent,
  taskOutcomeEvent,
  SUMMARY_MAX_CHARS,
  type VerificationCategory,
  type TaskOutcome,
} from "./task/telemetry";
// #1255: the display-sanitize boundary — extension-controlled text reaching
// raw terminal seams (headless stderr, CLI chrome) must strip controls.
export { sanitizeForDisplay } from "./display-sanitize";
export {
  performanceByModel,
  performanceSamples,
  concurrencyReport,
  taskReport,
  acceptedTaskFixture,
  type PerformanceModelRow,
  type ConcurrencyReport,
  type TaskRow,
  type TaskReport,
  type AcceptedTaskFixtureRow,
} from "./performance/telemetry";
// #1099: the attempt-chain projection stays internal until a client
// surface (the `moh usage` rollups, P1) reads it — ADR-0004 keep-criterion.
// Re-opening it is an explicit decision; tests and internal code import
// from the defining module.

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

// #1131: the read-only `/extensions` state — the TUI overlay and any
// headless reader fold it. Metadata-only projection (ADR-0004).
export {
  extensionsScreenStateFromEvents,
  readExtensionsScreenState,
  mergeExtensionLiveInfo,
  type ExtensionsScreenState,
  type ExtensionsScreenExtension,
  type ExtensionsScreenSection,
  type ExtensionsScreenRefusal,
  type ExtensionLiveInfo,
} from "./extensions-screen";

export {
  skillRecommendations,
  formatSkillCommand,
  type SkillRecommendation,
  type SkillRoutingConfig,
  type SkillRouteOverride,
} from "./skill-routing";
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
// ADR-0050 (#974): the one formatter every surface states the
// selected/serving pair with — the prompt, the TUI status bar, the
// transcript's durable record, the /model header and the fallback
// notices. The accessor pair behind it (`selectedModelOf` /
// `servingModelOf`, "the model in use") stays internal: it is core's own
// reading, reached through `AgentSession.selectedModel` / `servingModel`
// (ADR-0004 — a client states the pair, it does not resolve it).
export { formatModelPair } from "./model-pair";
// ADR-0033 §4: the outcome vocabulary a client's confirmation seam answers
// with ("send" | "cancel" | "refuse") — the extension contract's type,
// re-exported so a client needs one import for the whole seam.
export type { TurnConfirmOutcome } from "@moh/extension";
export type { ExtensionCommand, ExtensionCommandContext } from "@moh/extension";
export {
  McpRuntime,
  mcpServerEntrySchema,
  isHttpMcpUrl,
  declaredUserMcpServers,
  isProjectServerTrusted,
  persistProjectMcpTrust,
  type DeclaredMcpServer,
  type McpServerEntry,
  type McpRuntimeOptions,
} from "./mcp";
export {
  loadMohConfig,
  writeMohConfig,
  upsertEndpoint,
  upsertMcpServer,
  declaredMcpServers,
  type EndpointProfile,
  type MohConfig,
} from "./config";
export {
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
  type ProviderTestFailure,
  type OnboardingIo,
  type ProviderAddOptions,
} from "./provider-onboarding";
export {
  // #1092: the bounded, secret-free failure trail for connection tests —
  // clients pass the user's moh home through `minimalConnectionTest`.
  noteProviderTestFailure,
  providerTestFailuresFile,
  PROVIDER_TEST_FAILURES_FILE,
  PROVIDER_TEST_MAX_ENTRIES,
  type ProviderTestFailureEntry,
} from "./provider-test-trace";
export { PROVIDER_PROFILES, providerProfile, providerEndpointChoices, providerRequiresBaseUrlInput, isProviderProfile, type ProviderProfile, type ProviderProfileId } from "./provider-profiles";
export { catalogEntryFor, pricingForModel, pricingForPlan, modelSupportsImages, endpointModelCatalog, knownCompatEndpointMetadata, subscriptionModelCatalog, type BillingPlan, type CatalogModel, type ModelPricing, type ModelPricingTier, type KnownCompatEndpointMetadata } from "./model-catalog";
export { billingPlanResolver, estimateModelCost, PRICING_SNAPSHOT, type ModelCostEstimate } from "./pricing";
// #993: the live reasoning channel's fold — the one rule shared by the log
// (`session/agent-loop.ts`) and every client that renders reasoning live.
export { EMPTY_REASONING_PARTS, foldReasoningParts, foldReasoningText, reasoningPartsText, type ReasoningParts } from "./reasoning-parts";
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
export { allManualPages, manualIndex, manualPage, type ManualPage } from "./manual";
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
export {
  isSubscriptionKind,
  offersSubscriptionAuth,
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
export {
  MOH_VERSION,
  installFirstPartySkills,
  checkUpstreamUpdates,
  applyUpstreamUpdates,
  validateSkillEntry,
  loadFirstPartyManifest,
  diffSkillFiles,
  readBundledSkill,
  type UpstreamUpdate,
  type UpstreamCheckResult,
} from "./workflow";
export {
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
export {
  trackerTools,
  projectFrontier,
  resolveTracker,
  resolveTrackerSync,
  // #939: fills the sync twin's memo from a promise continuation, so the TUI
  // boot (or renderTui's warm-up) leaves a spawn-free startup path behind it.
  // #939: fills the sync twin's memo from a promise continuation.
  prepareTrackerRemote,
  type TrackerIssue,
  type TrackerBackend,
} from "./tracker";
// #939: the identity boot seam. A client resolves the project identity
// before the first React window (renderTui, which runs outside the render)
// and App's own gate awaits it when nothing did; afterwards every resolution
// is memory-served, so no synchronous `git` spawn is reachable from a render.
export {
  // #939: the identity boot seam — the client resolves the identity
  // before the first React window, so nothing spawns on a render path.
  prepareProjectIdentity,
  prepareProjectIdentityNow,
  isProjectIdentityPrepared,
  // #1217: stranded-data record — clients surface old uuid-directory data
  // that cannot be migrated automatically (both directories hold data).
  // #1243: the resolution seams (see the export block below).
  // #1243: the resolution seams — the record is live-checked, acknowledged,
  // summarized, and resolvable (move logs / delete / keep) from a client.
  acknowledgeStrandedData,
  deleteStrandedData,
  moveStrandedSessions,
  strandedDataSummary,
  type StrandedDataSummary,
  readStrandedDataRecord,
  type StrandedDataRecord,
} from "./project-identity";
export {
  readUserConfigFile,
  updateUserConfigFile,
  userConfigFile,
  type UserConfigData,
  type UserConfigIo,
} from "./user-config";
// #826: the bundled-extension seam. The core knows how to host first-party
// code that ships inside the binary; it does not know which extension that
// is — the client mounts the sources (the first-party one lives in its own
// workspace package, which the core does not depend on).
export {
  // #826: hosting a bundled first-party extension (a client mounts it from
  // its own package). The vendor config surface moved with its owner.
  resolveBundledExtensions,
  type BundledActivationContext,
  type BundledExtensionSource,
  type BundledInstanceReader,
  type BundledResolution,
  type BundledWiring,
  type MountedBundledExtension,
} from "./bundled-extensions";
export {
  publishHandoffAtExit,
  readRawHandoff,
  handoffAlreadyPublished,
  handoffPublishedMarkerFile,
  type HandoffPayload,
  // Session handoff (#433, T2 #435): the transport seam and gist impl
  // are client surfaces (exit wiring, TUI/CLI) — not agent-loop API.
  type HandoffTransport,
  type HandoffTransportError,
  type PublishHandoffOptions,
  type PublishHandoffResult,
} from "./handoff-transport";
export {
  createGistHandoffTransport,
  discoverGistHandoffs,
  ghUsername,
  spawnGh,
  type GhRunner,
  type GistHandoffOffer,
  type DiscoverGistHandoffsOptions,
} from "./handoff-gist";
export {
  cloneHandoffRepo,
  // Cold-directory wizard (#595): the gate, clone and pull steps.
  isColdDirectory,
  pullHandoffTo,
  type CloneHandoffRepoOptions,
  type CloneHandoffRepoResult,
  type GitCall,
  type GitRunner,
  type PullHandoffOptions,
  type PullHandoffResult,
} from "./handoff-coldstart";
export {
  // Reception (T3 #436) and Wayfinder read/cite (T6 #439) client surfaces.
  discoverHandoff,
  isHandoffStale,
  handoffSeedPrompt,
  handoffSeedMessage,
  type HandoffOffer,
  type DiscoverHandoffOptions,
} from "./handoff-reception";
export { handoffDebug, handoffDebugEnabled, type HandoffDebugStage } from "./handoff-debug";
export { HandoffRunner, transportActive, type RawHandoff, type HandoffGitAnchor } from "./handoff";
export { enrichHandoffWithWayfinder, notifyClaimedWayfinderTickets } from "./handoff-wayfinder";
export {
  // Manual file fallback (T7 #440): export/import via file.
  exportHandoffFile,
  importHandoffFile,
  readImportedHandoff,
  importedHandoffFile,
  type ExportHandoffOptions,
  type ExportHandoffResult,
  type ImportHandoffOptions,
  type ImportHandoffResult,
} from "./handoff-file";
export {
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
export {
  authMethodKindSchema,
  anthropicAuthOverridesSchema,
  openaiAuthOverridesSchema,
  openrouterAuthOverridesSchema,
  kimiCodingAuthOverridesSchema,
  xaiAuthOverridesSchema,
  githubCopilotAuthOverridesSchema,
  type AnthropicAuthOverrides,
  type OpenAiAuthOverrides,
  type OpenrouterAuthOverrides,
  type KimiCodingAuthOverrides,
  type XaiAuthOverrides,
  type GithubCopilotAuthOverrides,
  type AuthAccount,
  type AuthMethodKind,
  type AuthSection,
  type AuthToken,
  type StoredApiKeyOrigin,
} from "./auth/types";
export {
  clearTokens,
  clearStoredApiKey,
  bindStoredApiKeyOrigin,
  getStoredApiKey,
  getStoredApiKeyOrigin,
  getStoredToken,
  readAuthSection,
  readStoredTokens,
  saveStoredApiKey,
  saveTokens,
} from "./auth/store";
export {
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
export {
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
export {
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
export {
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
export {
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
export {
  KIMI_CODE_API_BASE_URL,
  KIMI_CODE_OAUTH_DEFAULTS,
  KimiCodingLoginAborted,
  loginKimiCoding,
  refreshKimiCodingToken,
  resolveKimiCodingOAuthConfig,
  type KimiCodingEndpointFetch,
  type KimiCodingOAuthConfig,
} from "./auth/kimi-coding";
export {
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
  type SessionConfig,
};

export {
  RetroStore,
  retroSignature,
  type RetroFinding,
  type RetroReport,
  type RetroReportFinding,
} from "./retro";

export { proposeRetroApplication, applyRetroApplication, preCommitHookContent, PRE_COMMIT_TARGET } from "./retro-apply";

// ADR-0075 (#1275): the judgement pipeline's injectable seam — the type
// `SessionConfig.retroJudgment` references, so clients and tests can name it.
export type { RetroJudgmentExtractor, RetroJudgmentInput } from "./retro-judgment";
