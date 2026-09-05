import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useApp, useInput, useStdout } from "ink";
import { pasteAsPath } from "./Input";
import { Box } from "ink";
import { homedir } from "node:os";
import { statSync } from "node:fs";
import { join } from "node:path";
import { loadMohConfig, type TrackerIssue, writeMohConfig } from "@moh/core";
import {
  installFirstPartySkills,
  checkUpstreamUpdates,
  checkForUpdate,
  isDevRun,
  readUpdateCache,
  updateNoticeFor,
  MOH_VERSION,
  resolveTrackerSync,
  readUserProviderConfig,
  type AgentSession,
  type AssemblyError,
  type HandoffOffer,
  type Provider,
  type TrackerBackend,
  type UpdateNotice,
  type UpstreamUpdate,
} from "@moh/core";
import { startUpdatePoll, skillUpdateNoticeText, statusRowUpdateText } from "./update-poll";
import { subscribeAiSdkWarnings } from "./ai-sdk-warnings";
import { SessionStore, handoffSeedMessage, handoffSeedPrompt } from "@moh/core";
import { THEMES, THEME_ORDER, DEFAULT_THEME, ThemeProvider, type ThemeName } from "./themes";
import { setIcons } from "./icons";
import { Home, updateNoticeText } from "./Home";
import { visibleChips, type ChipAction } from "./BottomBar";
import { useSubagentCount } from "./subagent-panel";
import { Chat, type Mode } from "./Chat";
import { handoffPublishWork, discoverHandoffForHome, makeSession, providerLabel } from "./factory";
import { listSessionSummaries, type SessionSummary } from "./sessions";
import { loadUserConfig, saveUserConfig, userConfigFile, type UserConfig } from "./user-config";
import { PermissionGate } from "./permission-gate";
import { AskUserGate } from "./ask-user-gate";
import { useViewport } from "./viewport";
import { listFiles } from "./file-index";
import { detectPreviewMode } from "./image-preview";
import { trackExitWork } from "./exit";
import { useSidebarState } from "./session-bridge";
import { PermissionModal } from "./PermissionModal";

import { Onboarding } from "./OnboardingOverlay";
import { HandoffActivationModal, type GhVerification } from "./HandoffActivationModal";
import { SettingsPanel } from "./SettingsPanel";
import { CommandsPanel } from "./CommandsPanel";
import { ManualModal } from "./ManualModal";
import { ModelPickerModal } from "./ModelPickerModal";
import { sanitizeForDisplay } from "./render-sanitize";
import { endpointModelCatalog } from "@moh/core";
import { contextWindowForLabel } from "./model-picker";
import { Frontier } from "./Frontier";
import { SkillChooser } from "./SkillChooser";
import { WorkflowOffer } from "./WorkflowOffer";
import { applySkillUpdates, readInstalled, runSlashCommand, commandEntries } from "./commands";
import { SkillUpdatesModal } from "./SkillUpdatesModal";
import { Toasts, useToasts } from "./Toasts";
import { createFallbackWatcher } from "./fallback-notice";
import { launchSkillSync } from "./launch-skill-sync";
import {
  catalogEntryFor,
  endpointThinkingStatus,
  resolveEndpointThinking,
  setThinkingPreference,
  type ThinkingLevel,
} from "@moh/core";
import type { DisplayThinkingLevel } from "./BottomBar";
import { thinkingLevelControl } from "./thinking-controls";

export interface AppProps {
  cwd: string;
  home?: string;
  /** Skip the home screen (bare resume / tests). */
  startInChat?: boolean;
  /** Pre-configured provider (tests, `--provider`). */
  provider?: Provider;
  initialMode?: Mode;
  initialTheme?: ThemeName;
  /** Skip first-run onboarding (tests, CLI flags). */
  skipOnboarding?: boolean;
  /** Environment for onboarding env-detection (tests inject a clean map;
   * default is the real process.env — #236: without this seam a machine with
   * provider keys in the environment makes every "first run" test see the
   * detect list, regardless of the injected home dir). */
  env?: Record<string, string | undefined>;
  /** Test seam for the handoff activation preflight; production uses gh. */
  verifyHandoffGh?: GhVerification;
  /** Version shown on the home screen (default: MOH_VERSION; the binary
   * stamps the build's git tag via cli → renderTui → Home, #292). */
  version?: string;
  /** #377: yolo session (launch-only `--yolo` flag) — no permission
   * prompts, unrestricted filesystem for built-in tools. */
  yolo?: boolean;
}

type Overlay = null | "settings" | "commands" | "manual" | "onboarding" | "handoff-onboarding" | "workflow-offer" | "frontier" | "skill-chooser" | "model" | "skill-updates";

/** #242: one-shot, non-blocking informed-consent copy. Exported so focused
 * tests can verify the full message even when narrow status chrome clips it. */
export const REASONING_PERSISTENCE_NOTICE =
  "note: provider-exposed reasoning and continuity metadata are saved in the session log — they travel with resume and fork and are included in session exports and backups";

/**
 * The moh TUI (#14, #33): vibe/dev views over the same event log,
 * filter-first home, 8 curated themes in React state (a switch remounts the tree
 * via `key`), the blocking permission modal, hybrid onboarding, the
 * settings panel, the all-commands panel, and toast notices.
 */
export function App({
  cwd,
  home,
  startInChat,
  provider,
  initialMode,
  initialTheme,
  skipOnboarding,
  env,
  verifyHandoffGh,
  version,
  yolo,
}: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  // Double ctrl+c is the only way out (see useInput; exitOnCtrlC is off in
  // main.tsx): the first press arms, the second within the window exits.
  const exitArmRef = useRef(0);
  const viewport = useViewport();

  const cfgFile = useMemo(() => userConfigFile(home), [home]);
  const [config, setConfig] = useState<UserConfig>(() => loadUserConfig(cfgFile));
  // Latest-config ref so persistence happens outside React's pure updaters.
  const configRef = useRef(config);
  configRef.current = config;
  const [themeName, setThemeName] = useState<ThemeName>(initialTheme ?? config.theme);
  const [themeTick, setThemeTick] = useState(0);
  const [mode, setMode] = useState<Mode>(initialMode ?? config.mode);
  // Settings-panel changes must apply live, not only after a restart:
  // `mode` and `theme` also live in React state (projection grammar and
  // the remount key), so persisting alone leaves the session stale (#196).
  const updateConfig = useCallback(
    (patch: Partial<UserConfig>) => {
      const previous = configRef.current;
      const next = { ...previous, ...patch };
      configRef.current = next;
      setConfig(next);
      if (patch.mode === "vibe" || patch.mode === "dev") setMode(patch.mode);
      if (patch.theme && patch.theme !== previous.theme) {
        setThemeName(patch.theme);
        setThemeTick((value) => value + 1);
      }
      saveUserConfig(next, cfgFile);
    },
    [cfgFile],
  );
  const [modelLabel, setModelLabel] = useState(() => providerLabel(provider, cwd, home));
  // startInChat assembles eagerly (tests, bare resume); a broken config is a
  // visible error now — no silent demo fallback (ADR-0005).
  const [initialSession] = useState(() =>
    startInChat ? makeSession({ cwd, home, provider, ...(yolo ? { yolo } : {}) }) : null,
  );
  const [session, setSession] = useState<AgentSession | null>(() =>
    initialSession && "session" in initialSession ? initialSession.session : null,
  );

  // First-run onboarding (#33): only when nothing is configured — an
  // explicit provider prop or a moh.json provider reference counts as
  // onboarded.
  const [needsOnboarding] = useState(
    () =>
      !skipOnboarding &&
      !loadUserConfig(cfgFile).onboarded &&
      !provider &&
      !providerConfigured(cwd, home),
  );
  // #385: existing workflow users get newly bundled skills on launch —
  // once per process, no-op when workflow mode is off.
  useEffect(() => {
    launchSkillSync({ mohHome, workflowEnabled: configRef.current.workflow.enabled });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Icon preference applies once at mount; the settings panel keeps it live.
  useEffect(() => {
    setIcons(config.icons);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [handoffStartupOffer] = useState(() => {
    // Handoff onboarding is for the project's first local session only.
    // Direct chat/resume paths must remain transparent: they have no Home
    // screen on which to make the first-run choice, and existing history
    // proves this is not a new project on this machine.
    if (skipOnboarding || needsOnboarding || startInChat || listSessionSummaries(cwd, home).length > 0) return false;
    try {
      const handoff = loadMohConfig(join(cwd, "moh.json")).handoff;
      return handoff?.transport === undefined && handoff?.onboarding === undefined;
    } catch {
      return false;
    }
  });
  const [overlay, setOverlay] = useState<Overlay>(needsOnboarding ? "onboarding" : handoffStartupOffer ? "handoff-onboarding" : null);
  const [handoffFromSettings, setHandoffFromSettings] = useState(false);
  const [alternateScreen, setAlternateScreen] = useState(false);
  // First-run workflow offer (#36): right after onboarding, once ever.
  const [offerWorkflow] = useState(
    () => !skipOnboarding && !needsOnboarding && !loadUserConfig(cfgFile).workflowOffered,
  );
  useEffect(() => {
    if (offerWorkflow && !handoffStartupOffer) setOverlay("workflow-offer");
  }, [offerWorkflow, handoffStartupOffer]);
  const [wizardFromSettings, setWizardFromSettings] = useState(false);
  const [claimedIssue, setClaimedIssue] = useState<TrackerIssue | null>(null);
  const [composerPrefill, setComposerPrefill] = useState<string>();
  // #242: temporary session-level reasoning display override (`/thinking
  // show|hide`); null = use the persisted global preference.
  const [reasoningOverride, setReasoningOverride] = useState<boolean | null>(null);
  const [thinkingPreferenceRevision, setThinkingPreferenceRevision] = useState(0);
  const [skillUpdatePlan, setSkillUpdatePlan] = useState<UpstreamUpdate[] | null>(null);

  const gateRef = useRef<PermissionGate | null>(null);
  if (gateRef.current === null) gateRef.current = new PermissionGate();
  const gate = gateRef.current;
  useSyncExternalStore(gate.subscribe, gate.getSnapshot);
  const pending = gate.current;

  const askGateRef = useRef<AskUserGate | null>(null);
  if (askGateRef.current === null) askGateRef.current = new AskUserGate();
  const askGate = askGateRef.current;
  useSyncExternalStore(askGate.subscribe, askGate.getSnapshot);
  const asking = askGate.current;

  const { toasts, push } = useToasts();
  const [memoryFresh, setMemoryFresh] = useState(false);
  /** #466/ADR-0022: sticky compaction-failure flag — set by
   * `compaction_failed`, cleared by a successful `compaction` marker. */
  const [compactionFailed, setCompactionFailed] = useState(false);
  /** #468/ADR-0020: sticky growth-warning state — set by
   * `session_file_growth`; the fork chip projects the explicit recovery
   * action. Counters update on repeat incidents; the banner never stacks. */
  const [growth, setGrowth] = useState<{ count: number } | null>(null);
  // `~/.moh` — computed once; the single spelling inside App (the core
  // guardian owns the config-file path constant itself).
  const mohHome = join(home ?? homedir(), ".moh");

  // Right-sidebar feed (#118): a coalesced event subscription (separate from
  // Chat's) serves the header token label and the Activity/Tokens sections.
  const sidebar = useSidebarState(session);
  // Native-scrollback focus model (#183): null = textarea, otherwise the
  // index of the visible bottom-bar chip.
  const [focusedChip, setFocusedChip] = useState<number | null>(null);
  // #497: focused subagent chip — the head of the chip cycle (index within
  // the subagent list). null = no subagent chip focus. Enter toggles the
  // live panel for the focused child; ←/→ clamp at the edges.
  const [focusedSubagent, setFocusedSubagent] = useState<number | null>(null);
  // #497: the subagent whose live panel is open (index into the tracked
  // list), or null when closed. Derived from the parent log's subagent
  // events; the count follows the parallel spawn cap via the UI slice.
  const [panelSubagent, setPanelSubagent] = useState<number | null>(null);
  const subagentCount = useSubagentCount(session);
  // The input's completion popup owns Tab while open (a slash draft with
  // candidates): the chip-cycle Tab handler defers to it, so completing a
  // command never moves focus to the send chip.
  const [completionOpen, setCompletionOpen] = useState(false);
  const completionOpenRef = useRef(completionOpen);
  completionOpenRef.current = completionOpen;
  const handleSuggestionsOpen = useCallback((open: boolean) => setCompletionOpen(open), []);
  // #488: the @-popup's file index — resolved once per cwd (git ls-files,
  // walk fallback); the popup filters it in-memory while open.
  const [mentionCandidates, setMentionCandidates] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    void listFiles(cwd).then((paths) => { if (alive) setMentionCandidates(paths); });
    return () => { alive = false; };
  }, [cwd]);
  // Vision note 4 (#490): paste-as-path seam — a pasted terminal path
  // (drag-and-drop) becomes an @mention. The index is checked first
  // (async, reconciler-safe); anything unindexed falls back to a sync
  // stat probe done OUTSIDE React effects (this runs in the input's
  // key handler, never inside an effect).
  const mentionCandidatesRef = useRef<string[]>([]);
  mentionCandidatesRef.current = mentionCandidates;
  const handlePastePath = useCallback((paste: string): string | null => {
    return pasteAsPath(paste, (path) => {
      if (mentionCandidatesRef.current.includes(path)) return true;
      try { return statSync(join(cwd, path)).isFile(); } catch { return false; }
    });
  }, [cwd]);
  // Vision note 4 (#490): resolved once per config/environment — the
  // protocol the transcript emits image pixels with (`none` = chip only).
  const imagePreviewMode = useMemo(
    () => detectPreviewMode(process.env, config.images.preview),
    [config.images.preview],
  );
  const [submitSignal, setSubmitSignal] = useState(0);
  useEffect(() => {
    const count = visibleChips(viewport.columns).chips.length;
    setFocusedChip((focused) => focused !== null && focused >= 0 && focused >= count ? null : focused);
  }, [viewport.columns]);
  // A failed eager assembly surfaces as a toast instead of a swapped-in demo provider.
  useEffect(() => {
    if (initialSession && "error" in initialSession) push(assemblyErrorToast(initialSession.error));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const blocked = pending !== null || asking !== null || overlay !== null;

  // Memory (#38): discreet indicator only — a brief toast, never chat noise.
  useEffect(() => {
    if (!session) return;
    let stopped = false;
    // ADR-0012: a fallback stop firing mid-turn is visible, not silent.
    const watchFallback = createFallbackWatcher();
    const consume = async () => {
      try {
        for await (const event of session.events) {
          if (stopped) return;
          if (event.type === "memory_updated") {
            setMemoryFresh(true);
            push(`memory updated · ${event.topics.join(", ")}`, "ok", "side");
          }
          // #466: the compaction producer appended a marker — the live
          // prompt was rebuilt; the summary replaces the covered past.
          if (event.type === "compaction") {
            setCompactionFailed(false);
            push("context compacted — older turns summarized, recent turns kept", "ok", "side");
          }
          // #466/ADR-0022: a failed run (no marker written). Sticky until a
          // retry succeeds or the user compacts — the indicator stays.
          if (event.type === "compaction_failed") {
            setCompactionFailed(true);
          }
          // #400 single-writer guard: the session file grew from elsewhere
          // (another machine / a second process). Loud warning; #468 makes
          // it sticky with an actionable fork chip (ADR-0020: the fork is
          // always the user's explicit action).
          if (event.type === "session_file_growth") {
            setGrowth((g) => ({ count: (g?.count ?? 0) + 1 }));
            push(
              sanitizeForDisplay(
                `session file grew from elsewhere (${event.expectedBytes} → ${event.actualBytes} bytes); concurrent use of one session file is unsupported — fork the session to keep working safely`,
              ),
              "warn",
            );
          }
          if (event.type === "route_serving") setModelLabel(`${event.selected} · ${event.serving}`);          if (event.type === "permission_rules_restored") {
            push(sanitizeForDisplay(`restored ${event.rules.length} permission rule${event.rules.length === 1 ? "" : "s"}: ${event.rules.join(", ")}`), "warn");
          }
          const fallbackNotice = watchFallback(event);
          if (fallbackNotice) push(fallbackNotice, "warn");
        }
      } catch {
        // closed iterator: nothing to do
      }
    };
    void consume();
    return () => {
      stopped = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);
  useEffect(() => { setMemoryFresh(false); }, [session, sidebar.turnCount]);

  // #347: AI SDK warnings are routed through moh's sink (installed at
  // render entry) and surface as one-line warn toasts — never raw
  // `process.emitWarning` output corrupting the transcript.
  useEffect(() => subscribeAiSdkWarnings((message) => push(message, "warn")), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Update polling (#348 / ADR-0014): one 30-minute scheduler drives both
  // the binary-release check and the first-party skill upstream check,
  // both behind the single `updateCheck` opt-out — independent of workflow
  // mode and of the deprecated `workflow.upstreamCheck`. Binary notice from
  // the 24h cache (works offline once checked once) + one-shot toast; the
  // skill notice is persistent state feeding status row 2 and Home. The
  // #328 cache hardening applies to the binary projection; the binary check
  // is still skipped in dev runs, the skill check is not.
  const [updateNotice, setUpdateNotice] = useState<UpdateNotice | null>(null);
  const [skillUpdateCount, setSkillUpdateCount] = useState(0);
  const recheckSkillsRef = useRef<() => void>(() => {});
  useEffect(() => {
    const enabled = config.updateCheck;
    if (!enabled) {
      // The shared opt-out applies immediately in a live TUI too: stop any
      // existing poller and remove discoveries that are no longer refreshed.
      setUpdateNotice(null);
      setSkillUpdateCount(0);
      recheckSkillsRef.current = () => {};
      return;
    }
    let live = true;
    const shown = new Set<string>(); // one-shot toast: never repeat a notice
    const show = (notice: UpdateNotice | null) => {
      if (!live) return;
      setUpdateNotice(notice);
      if (!notice) return;
      const key = `${notice.kind}:${notice.latestVersion}`;
      if (shown.has(key)) return;
      shown.add(key);
      push(updateNoticeText(notice));
    };
    // #328 hardening: a cache whose lastCheckedAt predates the running
    // binary cannot be trusted to call the current version "non-stable"
    // (e.g. a manual binary replacement bypassing the cache) — project
    // nothing in that case rather than a false notice.
    const installedAt = binaryInstalledAt(process.execPath);
    const fromCache = (latest: string | undefined, checkedAt?: number): UpdateNotice | null => {
      const notice = updateNoticeFor(version ?? MOH_VERSION, latest);
      if (notice?.kind === "nonstable" && checkedAt !== undefined && installedAt !== null && checkedAt < installedAt) {
        return null;
      }
      return notice;
    };
    const checkBinary = async () => {
      if (isDevRun()) return; // ADR-0014: no release check from a repo checkout
      const latest = await checkForUpdate({ mohHome });
      if (!live || !latest) return;
      show(fromCache(latest, Date.now()));
    };
    // Skill discovery: persistent state + a toast only on a rising count
    // (every 30-minute re-discovery must not re-toast the same updates).
    let skillInFlight = false;
    let lastCount = -1;
    const checkSkills = async () => {
      if (skillInFlight) return; // #348: never overlap requests
      skillInFlight = true;
      try {
        const result = await checkUpstreamUpdates({ mohHome });
        if (!live || !result.ok) return; // background failure stays silent
        setSkillUpdateCount(result.updates.length);
        if (result.updates.length > 0 && result.updates.length > lastCount) {
          push(skillUpdateNoticeText(result.updates.length));
        }
        lastCount = result.updates.length;
      } catch {
        // background failure stays silent
      } finally {
        skillInFlight = false;
      }
    };
    const checkEverything = () => Promise.all([checkBinary(), checkSkills()]).then(() => {});
    recheckSkillsRef.current = () => { void checkSkills(); };
    const cache = readUpdateCache(mohHome);
    show(fromCache(cache?.latestVersion, cache?.lastCheckedAt));
    void checkEverything(); // per-launch, even when the cache is fresh (#328)
    const stopPoll = startUpdatePoll({ fire: checkEverything });
    return () => {
      live = false;
      stopPoll();
    };
    // `updateCheck` is intentionally a dependency: changing the shared
    // opt-out in Settings starts/stops both call-homes immediately.
  }, [config.updateCheck, mohHome, version]);
  // `/thinking show|hide` is session-temporary: replacing/resuming a
  // session returns display control to the persisted global preference.
  useEffect(() => { setReasoningOverride(null); }, [session]);

  // Workflow mode (#36): the frontier tracker exists only while enabled;
  // the skill upstream check has moved to the shared update poll (#348).
  const workflowOn = config.workflow.enabled;
  const [tracker, setTracker] = useState<TrackerBackend | null>(() =>
    workflowOn ? resolveTrackerSync({ cwd }) : null,
  );

  const showReasoningPersistenceNotice = (candidate: AgentSession) => {
    if (configRef.current.reasoningNoticeShown) return;
    if (!modelReasoningCapable(candidate.activeModel, candidate.activeEndpointType)) return;
    // updateConfig updates configRef synchronously before the durable write,
    // preventing the session effect from duplicating this notice.
    updateConfig({ reasoningNoticeShown: true });
    push(REASONING_PERSISTENCE_NOTICE, "warn");
  };

  const open = (
    resume: SessionSummary | null,
    initialPrompt?: string,
    turnPrompt?: { name: string; text: string },
    handoffOffer?: Extract<HandoffOffer, { status: "offer" }>,
  ) => {
    const base = {
      cwd,
      home,
      provider,
      workflow: configRef.current.workflow.enabled,
      onPermissionRequest: gate.ask as NonNullable<Parameters<typeof makeSession>[0]["onPermissionRequest"]>,
      onAskUser: askGate.ask,
      permissionMode: config.permissionMode,
      ...(yolo ? { yolo } : {}),
      ...(handoffOffer ? { handoffOffer } : {}),
      onHandoffWarning: (message: string) => push(message, "warn"),
    };
    let made: ReturnType<typeof makeSession>;
    if (resume) {
      const store = SessionStore.open(resume.file);
      made = makeSession({ ...base, store, resumeEvents: store.load() });
    } else {
      made = makeSession(base);
    }
    if ("error" in made) {
      push(assemblyErrorToast(made.error));
      return;
    }
    // Informed consent must precede an initial prompt's first provider
    // call, not wait for the post-render session effect.
    showReasoningPersistenceNotice(made.session);
    setSession(made.session);
    // T3 #436: a seeded session opens with the handoff as its first
    // turn — message + turn-scoped skill prompt (ADR-0011 pattern, the
    // same seam /ask-moh uses; never a replayed event log).
    if (turnPrompt) {
      void made.session.send(initialPrompt ?? handoffSeedMessage(lastOffer.current!), { prompt: turnPrompt });
    } else if (initialPrompt) {
      void made.session.send(initialPrompt);
    }
  };

  // T3 #436: startup handoff discovery — runs once when the home screen
  // mounts. Bounded and fail-silent: offline / gh-less / off machines
  // simply see no offer (stories 8 and 15).
  const [handoff, setHandoff] = useState<HandoffOffer | null>(null);
  const lastOffer = useRef<Extract<HandoffOffer, { status: "offer" }> | null>(null);
  useEffect(() => {
    if (!startInChat) return;
    let cancelled = false;
    void discoverHandoffForHome(cwd, home).then((offer) => {
      if (cancelled) return;
      if (offer.status === "offer") lastOffer.current = offer;
      setHandoff(offer);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  // MCP servers and other session-scoped resources shut down at session
  // end: when the active session is replaced or the app unmounts (#15).
  useEffect(() => {
    return () => {
      // Tracked (#341) so the CLI entry point can bound this cleanup and
      // terminate the process even when lingering handles (Bun HTTP
      // keep-alive sockets) would otherwise hold the shell prompt.
      trackExitWork(session?.dispose({ timeoutMs: 2000 }).catch(() => {}) ?? Promise.resolve());
      // Session handoff exit publish (#433, T2 #435): when
      // handoff.transport is "gist", publish the raw artifact through
      // the same exit budget. Returns null (nothing tracked) when the
      // transport is off — single machine stays byte-for-byte unchanged
      // (story 8). Failures surface as one warning toast (story 15).
      const publish = handoffPublishWork(cwd, home, (message) =>
        push(sanitizeForDisplay(message), "warn"),
      );
      if (publish) trackExitWork(publish);
      // #438: a startup dismissal gets exactly one end-of-first-session
      // reminder. Persist before exit so later sessions remain silent.
      try {
        const file = join(cwd, "moh.json");
        const project = loadMohConfig(file);
        if (session && project.handoff?.onboarding === "dismissed") {
          writeMohConfig(file, { ...project, handoff: { ...project.handoff, onboarding: "reminded" } });
          push("session handoff remains Not Set · configure it later in Settings");
        }
      } catch {
        // A reminder is never worth delaying or failing session cleanup.
      }
    };
  }, [session]);

  // `/reload` (#hot-reload): rebuild the session from a fresh moh.json +
  // user-config read, appending to the same JSONL file. The old session
  // is aborted and disposed first (memory flush, MCP shutdown, pending
  // events settled) so nothing appends after the file is re-read; the
  // fresh session resumes the full history from that file. A broken
  // config keeps the old session alive (no silent fallback, ADR-0005).
  const reload = async () => {
    const current = session;
    if (!current) return push("/reload needs an open session");
    const file = current.sessionFile;
    if (!file) return push("/reload: session file unknown — open a session first");
    current.abort();
    await current.dispose();
    const result = makeSession({
      cwd,
      home,
      provider,
      workflow: configRef.current.workflow.enabled,
      onPermissionRequest: gate.ask as NonNullable<Parameters<typeof makeSession>[0]["onPermissionRequest"]>,
      onAskUser: askGate.ask,
      permissionMode: configRef.current.permissionMode,
      ...(yolo ? { yolo } : {}),
      store: SessionStore.open(file),
    });
    if ("error" in result) {
      return push(assemblyErrorToast(result.error) + " — keeping the current session");
    }
    setModelLabel(result.session.activeModel);
    setSession(result.session);
    push(`✓ config reloaded · model ${result.session.activeModel} · history preserved`);
  };

  // #468/ADR-0020 fork-now: the explicit recovery action behind the growth
  // banner. Disposes the current session, forks the file (full-history
  // byte copy; the original stays intact), and activates the forked
  // session — the same assembly path /reload uses.
  const forkNow = async () => {
    const current = session;
    if (!current) return push("fork needs an open session");
    const file = current.sessionFile;
    if (!file) return push("fork: session file unknown — open a session first");
    const forkedStore = SessionStore.open(file).fork();
    current.abort();
    await current.dispose();
    const result = makeSession({
      cwd,
      home,
      provider,
      workflow: configRef.current.workflow.enabled,
      onPermissionRequest: gate.ask as NonNullable<Parameters<typeof makeSession>[0]["onPermissionRequest"]>,
      onAskUser: askGate.ask,
      permissionMode: configRef.current.permissionMode,
      ...(yolo ? { yolo } : {}),
      store: forkedStore,
      resumeEvents: forkedStore.load(),
    });
    if ("error" in result) {
      return push(assemblyErrorToast(result.error) + " — keeping the current session");
    }
    setModelLabel(result.session.activeModel);
    setSession(result.session);
    setGrowth(null);
    push(`forked → ${forkedStore.file.split("/").at(-1)}`);
  };

  const cycleMode = () => {
    const next: Mode = mode === "vibe" ? "dev" : "vibe";
    setMode(next);
    updateConfig({ mode: next });
  };
  // #242/#256: the effective level of the active model for the status
  // bar, plus the unsupported-preference marker ("provider default
  // (preference X unsupported)"). Resolved from the same seam the
  // session uses per call, so the label always matches what was sent.
  const thinkingStatus = useMemo(() => {
    if (!session) return {} as { level?: DisplayThinkingLevel; unsupported?: ThinkingLevel };
    return endpointThinkingStatus(session.activeModel, session.endpointProfiles, cfgFile);
  }, [session, modelLabel, thinkingPreferenceRevision, cfgFile]);
  const thinkingLevel: DisplayThinkingLevel = thinkingStatus.level ?? "default";
  // Note 11: the context bar's denominator is the active model's declared
  // window (vendored catalog via the endpoint profiles), not the fixed
  // 200k default — the default remains the fallback for catalog-less
  // backends (openai-compat) and unknown models.
  const contextLimit = useMemo(() => {
    if (!session) return undefined;
    const picks = session.endpointProfiles.map((e) => ({
      name: e.name,
      type: e.type,
      defaultModel: e.defaultModel,
      baseUrl: e.baseUrl,
      apiKey: e.apiKey,
      catalog: endpointModelCatalog(e.type, e.baseUrl),
    }));
    return contextWindowForLabel(picks, session.activeModel) || undefined;
  }, [session, modelLabel]);

  // #242/#256: cycles among the levels the active model actually offers
  // (config declaration or catalog map) and persists immediately. Never
  // a silent remap: unoffered levels are not part of the cycle, and
  // models without a capability get the explanation.
  const cycleThinkingLevel = () => {
    if (!session) return;
    const ref = session.activeModel;
    const control = thinkingLevelControl(ref, session.endpointProfiles, session.activeEndpointType);
    if (!control || control.offered.length === 0) {
      return push(`thinking levels not offered for ${ref} (no declared capability) — /model to pick a reasoning model or declare one in config`);
    }
    const current = resolveEndpointThinking(ref, session.endpointProfiles, cfgFile)?.level;
    const idx = current ? control.offered.indexOf(current) : -1;
    const next = control.offered[(idx + 1) % control.offered.length]!;
    setThinkingPreference(cfgFile, control.endpointName, next);
    setThinkingPreferenceRevision((value) => value + 1);
    push(`thinking level ${next} · saved for endpoint ${control.endpointName}`);
  };

  // #242: informed consent — one-shot, non-blocking, before the first
  // compatible call of a reasoning-capable model.
  useEffect(() => {
    if (!session) return;
    showReasoningPersistenceNotice(session);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, modelLabel]);

  const cycleTheme = () => {
    const index = THEME_ORDER.indexOf(themeName);
    const next = THEME_ORDER[(index + 1) % THEME_ORDER.length]!;
    setThemeName(next);
    setThemeTick((value) => value + 1);
    updateConfig({ theme: next });
    push(`theme: ${THEMES[next].label}`);
  };
  const activateChip = (action: ChipAction) => {
    setFocusedChip(null);
    if (action === "send") return setSubmitSignal((value) => value + 1);
    if (action === "stop") return session?.abort();
    if (action === "model") return setOverlay("model");
    if (action === "mode") return cycleMode();
    if (action === "commands") return setOverlay("commands");
    if (action === "settings") return setOverlay("settings");
    if (action === "frontier") return workflowOn ? setOverlay("frontier") : push("wayfinder needs workflow on (/workflow on)");
    if (action === "workflow") {
      const enabled = !configRef.current.workflow.enabled;
      updateConfig({ workflow: { ...configRef.current.workflow, enabled } });
      setTracker(enabled ? resolveTrackerSync({ cwd }) : null);
      return push(`workflow ${enabled ? "on" : "off"}`);
    }
  };

  useInput((input, key) => {
    // Exit: two ctrl+c presses within 1.5s (exitOnCtrlC is off in main.tsx,
    // so the keypress reaches us as input "c" + key.ctrl). Runs first so it
    // works over overlays and chip focus alike. A lone ctrl+c only arms.
    if (key.ctrl && input === "c") {
      const now = Date.now();
      if (now - exitArmRef.current < 1500) return exit();
      exitArmRef.current = now;
      return push("press ctrl+c again to exit");
    }
    if (session && !blocked) {
      const chips = visibleChips(viewport.columns).chips;
      const subCount = subagentCount;
      // While the input's completion popup owns the Tab key (a slash draft
      // with candidates), the textarea keeps focus: Tab completes the
      // command instead of cycling the chips.
      if (key.tab && !completionOpenRef.current) {
        // #497: subagent chips sit at the head of the cycle (only when any
        // exist); tab from the composer reaches them first, then the action
        // chips. Entering the zone MUST initialise selection to its first
        // visible chip: leaving a stale ordinal selected focused #6 on the
        // owner's screenshot after a first Tab.
        if (!key.shift && focusedChip === null && subCount > 0) setFocusedSubagent(0);
        setFocusedChip((current) => {
          if (key.shift) {
            if (current === null) return chips.length - 1;
            if (current === 0) return subCount > 0 ? subCount - 1 : null;
            return current - 1;
          }
          if (current === null) return subCount > 0 ? -1 : 0;
          if (current === -1) return 0;
          if (current + 1 >= chips.length) return subCount > 0 ? -1 : null;
          return current + 1;
        });
        return;
      }
      // #497: subagent-chip focus — ←/→ clamp at the edges (never wrap);
      // Enter toggles that child's live panel; Esc returns to the composer
      // leaving the panel as-is.
      if (focusedChip === -1) {
        // #497: Esc leaves chip focus entirely — back to the composer
        // (owner bug report: the composer stayed unreachable otherwise).
        if (key.escape) { setFocusedChip(null); setFocusedSubagent(null); return; }
        if (key.leftArrow) return setFocusedSubagent((current) => Math.max(0, (current ?? 0) - 1));
        if (key.rightArrow) return setFocusedSubagent((current) => Math.min(subCount - 1, (current ?? 0) + 1));
        if (key.return) {
          const index = focusedSubagent ?? 0;
          setFocusedSubagent(index);
          setPanelSubagent((prev) => prev === index ? null : index);
          return;
        }
        // Any other key (typing) also returns to the composer so the
        // textarea is never reachable-stuck behind the chip zone.
        if (input !== undefined && input !== "") { setFocusedChip(null); setFocusedSubagent(null); return; }
        return;
      }
      if (focusedChip !== null) {
        if (key.escape) return setFocusedChip(null);
        if (key.leftArrow || key.rightArrow) {
          const delta = key.leftArrow ? -1 : 1;
          // Edge → step into the subagent chips when any exist.
          const next = focusedChip + delta;
          if (next < 0) {
            if (subCount > 0) { setFocusedChip(-1); setFocusedSubagent(subCount - 1); return; }
            return setFocusedChip(0);
          }
          if (next >= chips.length) {
            if (subCount > 0) { setFocusedChip(-1); setFocusedSubagent(0); return; }
            return setFocusedChip(null);
          }
          return setFocusedChip(next);
        }
        if (key.return) return activateChip(chips[focusedChip]?.label ?? "send");
        return;
      }
    }
    if (key.ctrl && input === "o") return cycleMode();
    if (key.ctrl && input === "t") return cycleTheme();
    if (key.ctrl && input === "y" && session) return cycleThinkingLevel();
    if (key.ctrl && input === "w" && session) return activateChip("workflow");
    if (overlay === null && key.ctrl && input === "s") return setOverlay("settings");
    if (overlay === null && key.ctrl && input === "k") return setOverlay("commands");
    // #457: the user manual, from chat and home alike (slash fallback: /help).
    // ctrl+h spike finding: terminals with extended-key encoding (kitty,
    // CSI-u) deliver this as ctrl+h; legacy terminals send 0x08, which Ink
    // reports as key.backspace with empty input — so they never reach this
    // branch and /help is the documented fallback (never silently remapped;
    // backspace keeps deleting in the composer).
    if (overlay === null && key.ctrl && input === "h") return setOverlay("manual");
    if (overlay === null && key.ctrl && input === "f" && workflowOn) return setOverlay("frontier");
    // The post-claim chooser owns Esc: it returns to Frontier rather than
    // discarding the explicit cancel/Just claim decision. The manual modal
    // owns Esc too (#457): page → index, index → close — the App-level
    // handler must not close it out from under the page view.
    if (overlay !== null && overlay !== "onboarding" && overlay !== "skill-chooser" && overlay !== "manual" && key.escape) return setOverlay(null);
  });

  const showChat = session !== null;
  // #426: the inline ask_user block is NOT an overlay — including `asking`
  // here drove the alternate-screen buffer flip (and the #330 deferred
  // repaint) while the block was open, freezing the screen under arrow
  // stress. The block renders inline in the main buffer; the composer is
  // still blocked (see `blocked` above), so it keeps exclusive keys.
  const overlayOpen = overlay !== null || pending !== null;
  // #330: a flip back to the main buffer is pending from the moment the
  // overlay closes (render-phase: covers the first post-close commit,
  // before the flip effect runs) until the delayed 1049l fires. Chat
  // holds any deferred whole-transcript repaint until then, or its Static
  // re-emission lands in the dying alternate buffer and blanks the chat.
  const [flipPending, setFlipPending] = useState(false);
  const bufferFlipPending = (!overlayOpen && alternateScreen) || flipPending;
  const chat = showChat ? (
    <Chat
      session={session}
      cwd={cwd}
      mode={mode}
      modelLabel={modelLabel}
      blocked={blocked}
      filePreview={config.filePreview}
      inputFocused={focusedChip === null}
      focusedChip={focusedChip}
      focusedSubagent={focusedChip === -1 ? focusedSubagent : null}
      panelSubagent={panelSubagent}
      onToggleSubagentPanel={(index) => setPanelSubagent((prev) => prev === index ? null : index)}
      tokens={sidebar.tokens}
      contextLimit={contextLimit}
      workflowOn={workflowOn}
      thinkingLevel={thinkingLevel}
      unsupportedThinkingLevel={thinkingStatus.unsupported}
      showReasoning={reasoningOverride ?? config.showReasoning}
      memoryFresh={memoryFresh}
      compactionFailed={compactionFailed}
      growthWarning={growth?.count ?? null}
      yolo={yolo}
      notice={toasts.at(-1)?.text}
      updateMessage={statusRowUpdateText(updateNotice ? updateNoticeText(updateNotice) : null, skillUpdateCount)}
      submitSignal={submitSignal}
      prefill={composerPrefill}
      replaySettled={alternateScreen}
      bufferFlipPending={bufferFlipPending}
      askGate={askGate}
      commands={commandEntries({ config })}
      livePhase={(() => {
        const item = sidebar.activity.at(-1);
        if (!item) return undefined;
        if (item.kind === "tool" && item.ok === null) return `running ${item.name}`;
        if (item.kind === "subagent" && item.status === "running") return item.name;
        return undefined;
      })()}
      onOpenCommands={() => setOverlay("commands")}
      onSuggestionsOpen={handleSuggestionsOpen}
      mentionCandidates={mentionCandidates}
      onPastePath={handlePastePath}
      previewMode={imagePreviewMode}
      onCommand={(text) => runSlashCommand(text, {
        cwd,
        mohHome,
        config,
        updateConfig,
        session,
        notify: push,
        onOpenFrontier: () => setOverlay("frontier"),
        onOpenModelPicker: () => setOverlay("model"),
        onOpenCommands: () => setOverlay("commands"),
        onOpenManual: () => setOverlay("manual"),
        onOpenSettings: () => setOverlay("settings"),
        onCycleMode: cycleMode,
        onCycleTheme: cycleTheme,
        onWorkflowToggle: (enabled) => setTracker(enabled ? resolveTrackerSync({ cwd }) : null),
        onSkillUpdatesChanged: (result) => {
          if (result?.ok) setSkillUpdateCount(result.updates.length);
          else if (result === undefined) recheckSkillsRef.current();
        },
        onOpenSkillUpdates: (updates) => {
          setSkillUpdatePlan(updates);
          setOverlay("skill-updates");
        },
        onThinkingDisplay: (show) => setReasoningOverride(show),
        thinkingDisplay: () => reasoningOverride ?? configRef.current.showReasoning,
        onThinkingLevelChanged: () => setThinkingPreferenceRevision((value) => value + 1),
        activeProviderType: () => session?.activeEndpointType,
        onModelSwitched: (model) => setModelLabel(model),
        onReload: () => void reload(),
        onForkNow: () => void forkNow(),
        growthWarning: () => growth !== null,
      })}
    />
  ) : null;

  const alternateRef = useRef(false);
  alternateRef.current = alternateScreen;

  // A centered transparent overlay needs the whole viewport, while the
  // session normally owns only its small native-scrollback live region.
  // Render modals in the terminal's alternate buffer: expanding there cannot
  // push the main buffer's transcript upward, and closing restores it byte-for-byte.
  //
  // The flip must respect ink's diff state: log-update tracks how many lines
  // its current frame occupies *in whichever buffer is active*. A modal frame
  // is fullscreen (~rows lines); if the first post-close paint ran in the
  // main buffer with that stale count, its eraseLines(~rows) would clear the
  // whole screen from the restored cursor and rewrite the short session
  // frame from the top (the "chat jumps up" regression). So on close the
  // native-grammar frame is committed first — ink repaints it into the dying
  // alternate buffer, resyncing the line count to the session frame — and
  // the buffer flip waits out ink's write throttle (maxFps 30 ⇒ ≤34ms) so
  // the resync paint always precedes the flip.
  const ALT_FLIP_DELAY_MS = 40;
  const flipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTty = stdout.isTTY === true;
  useEffect(() => {
    if (overlayOpen === alternateScreen) return;
    // The alternate-screen choreography only applies to real terminals:
    // non-TTY hosts (test harnesses, pipes) see the plain buffer switch,
    // where a blank write would only confuse frame-capture consumers.
    if (overlayOpen) {
      // A close flip may still be pending (rapid close→reopen): cancel it,
      // or it would drop the terminal out of the alternate screen mid-modal.
      if (flipTimerRef.current !== null) {
        clearTimeout(flipTimerRef.current);
        flipTimerRef.current = null;
        setFlipPending(false);
      }
      if (isTty) stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
      setAlternateScreen(true);
      return;
    }
    setAlternateScreen(false);
    if (!isTty) return;
    // Blank the dying modal frame: the resync paint anchors at the top of
    // the erased region, and a brief blank beats a wrongly-anchored flash.
    stdout.write("\x1b[2J\x1b[H");
    setFlipPending(true);
    flipTimerRef.current = setTimeout(() => {
      flipTimerRef.current = null;
      stdout.write("\x1b[?1049l");
      // Flip completed first (same task, before any repaint render fires)
      // so a deferred whole-transcript repaint re-emits into the main
      // buffer, not the dying alternate one (#330).
      setFlipPending(false);
    }, ALT_FLIP_DELAY_MS);
  }, [alternateScreen, overlayOpen, isTty, stdout]);
  // Unmount: a pending flip (close raced with exit) or an open overlay
  // leaves the terminal in the alternate screen — drop it out either way.
  useEffect(() => () => {
    const timer = flipTimerRef.current;
    if (timer !== null) {
      clearTimeout(timer);
      flipTimerRef.current = null;
      stdout.write("\x1b[?1049l");
    } else if (alternateRef.current) {
      stdout.write("\x1b[?1049l");
    }
  }, [stdout]);
  useEffect(() => { if (!showChat) setFocusedChip(null); }, [showChat]);

  return (
    <ThemeProvider value={THEMES[themeName]}>
      <Box
        flexDirection="column"
        width={Math.max(1, viewport.columns - 1)}
        // The session owns a viewport-sized frame even in the main buffer:
        // transcript chrome above may scroll, but composer/footer must stay
        // at the terminal bottom once reached. Overlays keep the same frame.
        height={showChat || alternateScreen ? Math.max(1, viewport.rows - 1) : undefined}
        overflow={showChat || alternateScreen ? "hidden" : undefined}
        position="relative"
        key={themeTick}
      >
        <Box width="100%" flexDirection="column" alignItems="center">
        {showChat ? (
          <Box flexDirection="column" width="100%" alignItems="center">{chat}</Box>
        ) : (
          <Home
            cwd={cwd}
            home={home}
            mode={mode}
            onOpen={open}
            onOpenSettings={() => setOverlay("settings")}
            onOpenCommands={() => setOverlay("commands")}
            blocked={overlayOpen}
            listMax={config.homeListMax}
            updateNotice={updateNotice}
            skillUpdateCount={skillUpdateCount}
            version={version ?? MOH_VERSION}
            handoff={handoff}
            onOpenHandoff={(offer) => {
              lastOffer.current = offer;
              open(null, undefined, handoffSeedPrompt(offer), offer);
            }}
          />
        )}
        </Box>
        {overlayOpen && alternateScreen && <OverlayLayer>
        {overlay === "onboarding" && (
          <Onboarding
            cwd={cwd}
            home={home}
            env={env}
            onDone={(ref) => {
              updateConfig({ onboarded: true });
              if (ref) {
                setModelLabel(ref);
                push(`provider: ${ref}`);
              } else {
                push("using the mock demo provider");
              }
              if (wizardFromSettings) {
                setWizardFromSettings(false);
                setOverlay("settings");
              } else {
                const handoff = loadMohConfig(join(cwd, "moh.json")).handoff;
                if (!startInChat && listSessionSummaries(cwd, home).length === 0 && handoff?.transport === undefined && handoff?.onboarding === undefined) {
                  setOverlay("handoff-onboarding");
                } else if (!configRef.current.workflowOffered) {
                  // First-run workflow offer (#36): right after onboarding.
                  setOverlay("workflow-offer");
                } else {
                  setOverlay(null);
                }
              }
            }}
          />
        )}
        {overlay === "handoff-onboarding" && (
          <HandoffActivationModal
            cwd={cwd}
            startup={!handoffFromSettings}
            verifyGh={verifyHandoffGh}
            onDone={(transport) => {
              if (transport) push(`session handoff: ${transport === "gist" ? "GitHub Gist enabled" : "disabled"}`);
              else push("session handoff not set · one reminder appears when this first session ends");
              if (handoffFromSettings) {
                setHandoffFromSettings(false);
                setOverlay("settings");
              } else if (!configRef.current.workflowOffered) setOverlay("workflow-offer");
              else setOverlay(null);
            }}
            onClose={() => {
              setHandoffFromSettings(false);
              setOverlay("settings");
            }}
          />
        )}
        {overlay === "settings" && (
          <SettingsPanel
            cwd={cwd}
            home={home}
            config={config}
            onChange={updateConfig}
            modelLabel={modelLabel}
            onProviderSwitch={setModelLabel}
            onStartWizard={() => {
              setWizardFromSettings(true);
              setOverlay("onboarding");
            }}
            onConfigureHandoff={() => {
              setHandoffFromSettings(true);
              setOverlay("handoff-onboarding");
            }}
            onToast={push}
            onClose={() => setOverlay(null)}
          />
        )}
        {overlay === "commands" && <CommandsPanel onClose={() => setOverlay(null)} />}
        {overlay === "manual" && <ManualModal onClose={() => setOverlay(null)} />}
        {overlay === "model" && session && (
          <ModelPickerModal
            activeModel={session.activeModel}
            endpoints={session.endpointProfiles.map((e) => ({
              name: e.name,
              type: e.type,
              defaultModel: e.defaultModel,
              baseUrl: e.baseUrl,
              apiKey: e.apiKey,
              catalog: endpointModelCatalog(e.type, e.baseUrl),
            }))}
            onSwitch={(ref) => session.switchModel(ref)}
            onSwitched={(model) => setModelLabel(model)}
            onToast={push}
            onClose={() => setOverlay(null)}
          />
        )}
        {overlay === "skill-updates" && skillUpdatePlan && (
          <SkillUpdatesModal
            updates={skillUpdatePlan}
            readInstalled={(name) => readInstalled(mohHome, name)}
            onApply={() => {
              void applySkillUpdates({
                cwd,
                mohHome,
                config,
                updateConfig,
                session,
                notify: push,
                onSkillUpdatesChanged: () => recheckSkillsRef.current(),
              }, skillUpdatePlan)
                .then(() => {
                  setSkillUpdatePlan(null);
                  setOverlay(null);
                })
                .catch(() => push("skills update apply failed"));
            }}
            onClose={() => {
              setSkillUpdatePlan(null);
              setOverlay(null);
            }}
          />
        )}
        {overlay === "workflow-offer" && (
          <WorkflowOffer
            onDone={(enable) => {
              updateConfig({ workflowOffered: true });
              if (enable) {
                updateConfig({ workflow: { ...configRef.current.workflow, enabled: true } });
                const report = installFirstPartySkills({ mohHome });
                push(`workflow on · ${report.installed.length} first-party skills installed`);
              } else {
                push("workflow off · /workflow on to enable");
              }
              setOverlay(null);
            }}
          />
        )}
        {overlay === "frontier" && workflowOn && (
          <Frontier
            backend={tracker}
            onToast={push}
            onClose={() => setOverlay(null)}
            requestClaim={(issue) =>
              gate.ask("tracker_claim", { id: issue.id }).then((answer) => answer !== "no")
            }
            onClaimed={(issue) => {
              setClaimedIssue(issue);
              setOverlay("skill-chooser");
            }}
          />
        )}
        {overlay === "skill-chooser" && claimedIssue && (
          <SkillChooser
            issue={claimedIssue}
            routing={loadMohConfig(join(cwd, "moh.json")).skillRouting}
            onChoose={(prefill) => {
              setComposerPrefill(prefill);
              setOverlay(null);
            }}
            onBack={() => setOverlay("frontier")}
            onJustClaim={() => setOverlay(null)}
          />
        )}
        {pending && <PermissionModal gate={gate} mode={mode} editor={config.editor} />}
        </OverlayLayer>}
        {/* Toasts remain non-blocking bottom chrome on every screen. */}
        {!showChat && <Toasts toasts={toasts} />}
      </Box>
    </ThemeProvider>
  );
}

/** Full-viewport transparent layer in the terminal's alternate buffer.
 * The dialog surface is opaque; the surrounding session remains visible. */
function OverlayLayer({ children }: { children: React.ReactNode }) {
  const viewport = useViewport();
  return (
    <Box
      position="absolute"
      width={Math.max(1, viewport.columns - 1)}
      height={Math.max(1, viewport.rows - 1)}
      flexDirection="column"
    >
      {children}
    </Box>
  );
}

/** Visible assembly failure (ADR-0005): what the user sees instead of a silent demo swap. */
function assemblyErrorToast(error: AssemblyError): string {
  const hint =
    error.kind === "provider"
      ? " · re-run onboarding (ctrl+k → onboarding) or fix the provider in moh.json"
      : " · fix moh.json and retry";
  return `session error (${error.kind}): ${error.message}${hint}`;
}

/** #242: true when the active ref is a catalog model that can return
 * provider reasoning (declared capability or a level map). */
function modelReasoningCapable(ref: string | undefined, type: string | undefined): boolean {
  if (!ref || ref === "mock") return false;
  const slash = ref.indexOf("/");
  // Custom/registered providers have no catalog contract that can prove
  // they *won't* emit neutral reasoning. Informed consent is conservative:
  // warn before their first call rather than after metadata was persisted.
  if (!type || slash === -1) return true;
  const model = catalogEntryFor(type, ref.slice(slash + 1));
  return model ? model.reasoning || !!model.thinkingLevelMap : true;
}

/** A `provider` reference in the project's moh.json (invalid = not configured). */
/** Onboarded when a provider reference exists anywhere: project moh.json
 * or the user config (#129). A broken user provider section counts as
 * configured — assembly reports that error, the wizard stays out of the way. */
function providerConfigured(cwd: string, home?: string): boolean {
  try {
    if (typeof loadMohConfig(join(cwd, "moh.json")).provider === "string") return true;
  } catch {
    // broken moh.json: assembly reports it; not an onboarding trigger
    return true;
  }
  try {
    return typeof readUserProviderConfig(userConfigFile(home ?? homedir())).provider === "string";
  } catch {
    return true;
  }
}

/** mtime of the running binary, when statable (#328 cache-staleness hardening). */
function binaryInstalledAt(execPath: string): number | null {
  try {
    return statSync(execPath).mtimeMs;
  } catch {
    return null;
  }
}
