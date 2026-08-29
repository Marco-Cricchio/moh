import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useApp, useInput, useStdout } from "ink";
import { Box } from "ink";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadMohConfig } from "@moh/core";
import {
  installFirstPartySkills,
  checkUpstreamUpdates,
  checkForUpdate,
  isDevRun,
  readUpdateCache,
  updateDue,
  updateNoticeFor,
  MOH_VERSION,
  resolveTrackerSync,
  readUserProviderConfig,
  type AgentSession,
  type AssemblyError,
  type Provider,
  type TrackerBackend,
  type UpdateNotice,
} from "@moh/core";
import { SessionStore } from "@moh/core";
import { THEMES, THEME_ORDER, DEFAULT_THEME, ThemeProvider, type ThemeName } from "./themes";
import { setIcons } from "./icons";
import { Home, updateNoticeText } from "./Home";
import { visibleChips, type ChipAction } from "./BottomBar";
import { Chat, type Mode } from "./Chat";
import { makeSession, providerLabel } from "./factory";
import type { SessionSummary } from "./sessions";
import { loadUserConfig, saveUserConfig, userConfigFile, type UserConfig } from "./user-config";
import { PermissionGate } from "./permission-gate";
import { AskUserGate } from "./ask-user-gate";
import { useViewport } from "./viewport";
import { useSidebarState } from "./session-bridge";
import { PermissionModal } from "./PermissionModal";
import { AskUserModal } from "./AskUserModal";
import { Onboarding } from "./OnboardingOverlay";
import { SettingsPanel } from "./SettingsPanel";
import { CommandsPanel } from "./CommandsPanel";
import { ModelPickerModal } from "./ModelPickerModal";
import { endpointModelCatalog } from "@moh/core";
import { contextWindowForLabel } from "./model-picker";
import { Frontier } from "./Frontier";
import { WorkflowOffer } from "./WorkflowOffer";
import { runSlashCommand, commandEntries } from "./commands";
import { Toasts, useToasts } from "./Toasts";
import { createFallbackWatcher } from "./fallback-notice";
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
  /** Version shown on the home screen (default: MOH_VERSION; the binary
   * stamps the build's git tag via cli → renderTui → Home, #292). */
  version?: string;
}

type Overlay = null | "settings" | "commands" | "onboarding" | "workflow-offer" | "frontier" | "model";

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
  version,
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
    startInChat ? makeSession({ cwd, home, provider }) : null,
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
  // Icon preference applies once at mount; the settings panel keeps it live.
  useEffect(() => {
    setIcons(config.icons);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [overlay, setOverlay] = useState<Overlay>(needsOnboarding ? "onboarding" : null);
  const [alternateScreen, setAlternateScreen] = useState(false);
  // First-run workflow offer (#36): right after onboarding, once ever.
  const [offerWorkflow] = useState(
    () => !skipOnboarding && !needsOnboarding && !loadUserConfig(cfgFile).workflowOffered,
  );
  useEffect(() => {
    if (offerWorkflow) setOverlay("workflow-offer");
  }, [offerWorkflow]);
  const [wizardFromSettings, setWizardFromSettings] = useState(false);
  // #242: temporary session-level reasoning display override (`/thinking
  // show|hide`); null = use the persisted global preference.
  const [reasoningOverride, setReasoningOverride] = useState<boolean | null>(null);
  const [thinkingPreferenceRevision, setThinkingPreferenceRevision] = useState(0);

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
  // `~/.moh` — computed once; the single spelling inside App (the core
  // guardian owns the config-file path constant itself).
  const mohHome = join(home ?? homedir(), ".moh");

  // Right-sidebar feed (#118): a coalesced event subscription (separate from
  // Chat's) serves the header token label and the Activity/Tokens sections.
  const sidebar = useSidebarState(session);
  // Native-scrollback focus model (#183): null = textarea, otherwise the
  // index of the visible bottom-bar chip.
  const [focusedChip, setFocusedChip] = useState<number | null>(null);
  // The input's completion popup owns Tab while open (a slash draft with
  // candidates): the chip-cycle Tab handler defers to it, so completing a
  // command never moves focus to the send chip.
  const [completionOpen, setCompletionOpen] = useState(false);
  const completionOpenRef = useRef(completionOpen);
  completionOpenRef.current = completionOpen;
  const handleSuggestionsOpen = useCallback((open: boolean) => setCompletionOpen(open), []);
  const [submitSignal, setSubmitSignal] = useState(0);
  useEffect(() => {
    const count = visibleChips(viewport.columns).chips.length;
    setFocusedChip((focused) => focused !== null && focused >= count ? null : focused);
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

  // Update check (#273 / ADR-0014): notice from the 24h cache (works
  // offline once checked once) + one-shot toast; a stale cache triggers a
  // silent background refresh that never delays startup. Opt-out via the
  // `updateCheck` user-config flag; skipped entirely in dev runs.
  const [updateNotice, setUpdateNotice] = useState<UpdateNotice | null>(null);
  useEffect(() => {
    if (!configRef.current.updateCheck || isDevRun()) return;
    let live = true;
    const shown = new Set<string>(); // one-shot toast: never repeat a notice
    const show = (notice: UpdateNotice | null) => {
      if (!live || !notice) return;
      const key = `${notice.kind}:${notice.latestVersion}`;
      if (shown.has(key)) {
        setUpdateNotice(notice);
        return;
      }
      shown.add(key);
      setUpdateNotice(notice);
      push(updateNoticeText(notice));
    };
    const cache = readUpdateCache(mohHome);
    show(updateNoticeFor(version ?? MOH_VERSION, cache?.latestVersion));
    if (updateDue(cache)) {
      void checkForUpdate({ mohHome }).then((latest) => {
        if (latest) show(updateNoticeFor(version ?? MOH_VERSION, latest));
      });
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // `/thinking show|hide` is session-temporary: replacing/resuming a
  // session returns display control to the persisted global preference.
  useEffect(() => { setReasoningOverride(null); }, [session]);

  // Workflow mode (#36): the frontier tracker and the background
  // upstream check exist only while enabled (and opted in).
  const workflowOn = config.workflow.enabled;
  const [tracker, setTracker] = useState<TrackerBackend | null>(() =>
    workflowOn ? resolveTrackerSync({ cwd }) : null,
  );
  useEffect(() => {
    if (!workflowOn || !config.workflow.upstreamCheck) return;
    let live = true;
    void checkUpstreamUpdates({ mohHome }).then((updates) => {
      if (live && updates.length > 0) {
        push(`${updates.length} skill update${updates.length > 1 ? "s" : ""} available (/skills update)`);
      }
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowOn]);

  const showReasoningPersistenceNotice = (candidate: AgentSession) => {
    if (configRef.current.reasoningNoticeShown) return;
    if (!modelReasoningCapable(candidate.activeModel, candidate.activeEndpointType)) return;
    // updateConfig updates configRef synchronously before the durable write,
    // preventing the session effect from duplicating this notice.
    updateConfig({ reasoningNoticeShown: true });
    push(REASONING_PERSISTENCE_NOTICE, "warn");
  };

  const open = (resume: SessionSummary | null, initialPrompt?: string) => {
    const base = {
      cwd,
      home,
      provider,
      workflow: configRef.current.workflow.enabled,
      onPermissionRequest: gate.ask as NonNullable<Parameters<typeof makeSession>[0]["onPermissionRequest"]>,
      onAskUser: askGate.ask,
      permissionMode: config.permissionMode,
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
    if (initialPrompt) void made.session.send(initialPrompt);
  };

  // MCP servers and other session-scoped resources shut down at session
  // end: when the active session is replaced or the app unmounts (#15).
  useEffect(() => {
    return () => {
      void session?.dispose({ timeoutMs: 2000 });
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
      store: SessionStore.open(file),
    });
    if ("error" in result) {
      return push(assemblyErrorToast(result.error) + " — keeping the current session");
    }
    setModelLabel(result.session.activeModel);
    setSession(result.session);
    push(`✓ config reloaded · model ${result.session.activeModel} · history preserved`);
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
      // While the input's completion popup owns the Tab key (a slash draft
      // with candidates), the textarea keeps focus: Tab completes the
      // command instead of cycling the chips.
      if (key.tab && !completionOpenRef.current) {
        setFocusedChip((current) => key.shift
          ? current === null ? chips.length - 1 : current === 0 ? null : current - 1
          : current === null ? 0 : current + 1 >= chips.length ? null : current + 1);
        return;
      }
      if (focusedChip !== null) {
        if (key.escape) return setFocusedChip(null);
        if (key.leftArrow || key.rightArrow) {
          const delta = key.leftArrow ? -1 : 1;
          return setFocusedChip((focusedChip + delta + chips.length) % chips.length);
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
    if (overlay === null && key.ctrl && input === "f" && workflowOn) return setOverlay("frontier");
    if (overlay !== null && overlay !== "onboarding" && key.escape) return setOverlay(null);
  });

  const showChat = session !== null;
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
      tokens={sidebar.tokens}
      contextLimit={contextLimit}
      workflowOn={workflowOn}
      thinkingLevel={thinkingLevel}
      unsupportedThinkingLevel={thinkingStatus.unsupported}
      showReasoning={reasoningOverride ?? config.showReasoning}
      memoryFresh={memoryFresh}
      notice={toasts.at(-1)?.text}
      submitSignal={submitSignal}
      replaySettled={alternateScreen}
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
        onOpenSettings: () => setOverlay("settings"),
        onCycleMode: cycleMode,
        onCycleTheme: cycleTheme,
        onWorkflowToggle: (enabled) => setTracker(enabled ? resolveTrackerSync({ cwd }) : null),
        onThinkingDisplay: (show) => setReasoningOverride(show),
        thinkingDisplay: () => reasoningOverride ?? configRef.current.showReasoning,
        onThinkingLevelChanged: () => setThinkingPreferenceRevision((value) => value + 1),
        activeProviderType: () => session?.activeEndpointType,
        onModelSwitched: (model) => setModelLabel(model),
        onReload: () => void reload(),
      })}
    />
  ) : null;

  const overlayOpen = overlay !== null || pending !== null || asking !== null;
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
    flipTimerRef.current = setTimeout(() => {
      flipTimerRef.current = null;
      stdout.write("\x1b[?1049l");
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
        height={alternateScreen ? Math.max(1, viewport.rows - 1) : undefined}
        overflow={alternateScreen ? "hidden" : undefined}
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
            version={version ?? MOH_VERSION}
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
              } else if (!configRef.current.workflowOffered) {
                // First-run workflow offer (#36): right after onboarding.
                setOverlay("workflow-offer");
              } else {
                setOverlay(null);
              }
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
            onToast={push}
            onClose={() => setOverlay(null)}
          />
        )}
        {overlay === "commands" && <CommandsPanel onClose={() => setOverlay(null)} />}
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
          />
        )}
        {pending && <PermissionModal gate={gate} mode={mode} editor={config.editor} />}
        {asking && (
          <AskUserModal key={`${asking.question}|${asking.options.map((o) => o.label).join(",")}`} gate={askGate} />
        )}
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
