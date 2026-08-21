import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useApp, useInput } from "ink";
import { Box } from "ink";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadMohConfig, installFirstPartySkills, checkUpstreamUpdates, resolveTrackerSync, type AgentSession, type Provider, type TrackerBackend } from "@moh/core";
import { SessionStore } from "@moh/core";
import { THEMES, THEME_ORDER, DEFAULT_THEME, ThemeProvider, type ThemeName } from "./themes";
import { setIcons } from "./icons";
import { Home } from "./Home";
import { Chat, type Mode } from "./Chat";
import { makeSession, providerLabel } from "./factory";
import type { SessionSummary } from "./sessions";
import { loadUserConfig, saveUserConfig, userConfigFile, type UserConfig } from "./user-config";
import { PermissionGate } from "./permission-gate";
import { useViewport } from "./viewport";
import { PermissionModal } from "./PermissionModal";
import { Onboarding } from "./OnboardingOverlay";
import { SettingsPanel } from "./SettingsPanel";
import { CommandsPanel } from "./CommandsPanel";
import { Frontier } from "./Frontier";
import { WorkflowOffer } from "./WorkflowOffer";
import { runSlashCommand } from "./commands";
import { Toasts, useToasts } from "./Toasts";

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
}

type Overlay = null | "settings" | "commands" | "onboarding" | "workflow-offer" | "frontier";

/**
 * The moh TUI (#14, #33): vibe/dev views over the same event log,
 * filter-first home, 9 themes in React state (a switch remounts the tree
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
}: AppProps) {
  const { exit } = useApp();
  const viewport = useViewport();

  const cfgFile = useMemo(() => userConfigFile(home), [home]);
  const [config, setConfig] = useState<UserConfig>(() => loadUserConfig(cfgFile));
  // Latest-config ref so persistence happens outside React's pure updaters.
  const configRef = useRef(config);
  configRef.current = config;
  const updateConfig = useCallback(
    (patch: Partial<UserConfig>) => {
      const next = { ...configRef.current, ...patch };
      configRef.current = next;
      setConfig(next);
      saveUserConfig(next, cfgFile);
    },
    [cfgFile],
  );

  const [themeName, setThemeName] = useState<ThemeName>(initialTheme ?? config.theme);
  const [themeTick, setThemeTick] = useState(0);
  const [mode, setMode] = useState<Mode>(initialMode ?? config.mode);
  const [modelLabel, setModelLabel] = useState(() => providerLabel(provider, cwd));
  const [session, setSession] = useState<AgentSession | null>(() =>
    startInChat ? makeSession({ cwd, home, provider }).session : null,
  );

  // First-run onboarding (#33): only when nothing is configured — an
  // explicit provider prop or a moh.json provider reference counts as
  // onboarded.
  const [needsOnboarding] = useState(
    () =>
      !skipOnboarding &&
      !loadUserConfig(cfgFile).onboarded &&
      !provider &&
      !projectProviderConfigured(cwd),
  );
  // Icon preference applies once at mount; the settings panel keeps it live.
  useEffect(() => {
    setIcons(config.icons);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [overlay, setOverlay] = useState<Overlay>(needsOnboarding ? "onboarding" : null);
  // First-run workflow offer (#36): right after onboarding, once ever.
  const [offerWorkflow] = useState(
    () => !skipOnboarding && !needsOnboarding && !loadUserConfig(cfgFile).workflowOffered,
  );
  useEffect(() => {
    if (offerWorkflow) setOverlay("workflow-offer");
  }, [offerWorkflow]);
  const [wizardFromSettings, setWizardFromSettings] = useState(false);

  const gateRef = useRef<PermissionGate | null>(null);
  if (gateRef.current === null) gateRef.current = new PermissionGate();
  const gate = gateRef.current;
  useSyncExternalStore(gate.subscribe, gate.getSnapshot);
  const pending = gate.current;

  const { toasts, push } = useToasts();
  const blocked = pending !== null || overlay !== null;

  // Memory (#38): discreet indicator only — a brief toast, never chat noise.
  useEffect(() => {
    if (!session) return;
    let stopped = false;
    const consume = async () => {
      try {
        for await (const event of session.events) {
          if (stopped) return;
          if (event.type === "memory_updated") {
            push(`memory updated · ${event.topics.join(", ")}`);
          }
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

  // Workflow mode (#36): the frontier tracker and the background
  // upstream check exist only while enabled (and opted in).
  const workflowOn = config.workflow.enabled;
  const [tracker, setTracker] = useState<TrackerBackend | null>(() =>
    workflowOn ? resolveTrackerSync({ cwd }) : null,
  );
  useEffect(() => {
    if (!workflowOn || !config.workflow.upstreamCheck) return;
    let live = true;
    void checkUpstreamUpdates({ mohHome: join(home ?? homedir(), ".moh") }).then((updates) => {
      if (live && updates.length > 0) {
        push(`${updates.length} skill update${updates.length > 1 ? "s" : ""} available (/skills update)`);
      }
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowOn]);

  const open = (resume: SessionSummary | null, initialPrompt?: string) => {
    const base = {
      cwd,
      home,
      provider,
      workflow: configRef.current.workflow.enabled,
      onPermissionRequest: gate.ask as NonNullable<Parameters<typeof makeSession>[0]["onPermissionRequest"]>,
      permissionMode: config.permissionMode,
    };
    let made: ReturnType<typeof makeSession>;
    if (resume) {
      const store = SessionStore.open(resume.file);
      made = makeSession({ ...base, store, resumeEvents: store.load() });
    } else {
      made = makeSession(base);
    }
    setSession(made.session);
    if (initialPrompt) void made.session.send(initialPrompt);
  };

  // MCP servers and other session-scoped resources shut down at session
  // end: when the active session is replaced or the app unmounts (#15).
  useEffect(() => {
    return () => {
      void session?.dispose();
    };
  }, [session]);

  useInput((input, key) => {
    if (key.ctrl && input === "m") {
      const next: Mode = mode === "vibe" ? "dev" : "vibe";
      setMode(next);
      updateConfig({ mode: next });
      return;
    }
    if (key.ctrl && input === "t") {
      const i = THEME_ORDER.indexOf(themeName);
      const next = THEME_ORDER[(i + 1) % THEME_ORDER.length]!;
      setThemeName(next);
      setThemeTick((t) => t + 1);
      updateConfig({ theme: next });
      push(`theme: ${THEMES[next].label}`);
      return;
    }
    if (overlay === null && key.ctrl && input === "s") return setOverlay("settings");
    if (overlay === null && key.ctrl && input === "k") return setOverlay("commands");
    if (overlay === null && key.ctrl && input === "f" && workflowOn) return setOverlay("frontier");
    if (overlay !== null && overlay !== "onboarding" && key.escape) return setOverlay(null);
  });

  const showChat = session !== null;

  const overlayOpen = overlay !== null || pending !== null;

  return (
    <ThemeProvider value={THEMES[themeName]}>
      <Box flexDirection="column" width={viewport.columns} position="relative" key={themeTick}>
          <Box position={overlayOpen ? "absolute" : "relative"} width="100%" height="100%" flexDirection="column" alignItems="center">
        {showChat ? (
          <Chat
            session={session}
            mode={mode}
            modelLabel={modelLabel}
            blocked={blocked}
            filePreview={config.filePreview}
            onOpenCommands={() => setOverlay("commands")}
            onCommand={(text) =>
              runSlashCommand(text, {
                cwd,
                mohHome: join(home ?? homedir(), ".moh"),
                config,
                updateConfig,
                session,
                notify: push,
                onOpenFrontier: () => setOverlay("frontier"),
                onWorkflowToggle: (enabled) => setTracker(enabled ? resolveTrackerSync({ cwd }) : null),
              })
            }
          />
        ) : (
          <Home
            cwd={cwd}
            home={home}
            mode={mode}
            onOpen={open}
            onExit={exit}
            onOpenSettings={() => setOverlay("settings")}
            onOpenCommands={() => setOverlay("commands")}
            blocked={overlayOpen}
          />
        )}
        </Box>
        {overlayOpen && <OverlayLayer>
        {overlay === "onboarding" && (
          <Onboarding
            cwd={cwd}
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
        {overlay === "workflow-offer" && (
          <WorkflowOffer
            onDone={(enable) => {
              updateConfig({ workflowOffered: true });
              if (enable) {
                updateConfig({ workflow: { ...configRef.current.workflow, enabled: true } });
                const report = installFirstPartySkills({ mohHome: join(home ?? homedir(), ".moh") });
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
        </OverlayLayer>}
        <Toasts toasts={toasts} />
      </Box>
    </ThemeProvider>
  );
}

/** Transparent full-viewport backdrop behind an open overlay (not a
 * scrim: nothing is dimmed): centers the dialog layer over the visible
 * content (pi-style floating dialog). Height is rows - 1 so Ink never
 * enters its fullscreen repaint path (which would clear the screen and
 * replay the whole transcript behind the dialog). */
function OverlayLayer({ children }: { children: React.ReactNode }) {
  const viewport = useViewport();
  return (
    <Box width={viewport.columns} height={Math.max(1, viewport.rows - 1)} flexDirection="column">
      {children}
    </Box>
  );
}

/** A `provider` reference in the project's moh.json (invalid = not configured). */
function projectProviderConfigured(cwd: string): boolean {
  try {
    return typeof loadMohConfig(join(cwd, "moh.json")).provider === "string";
  } catch {
    return false;
  }
}
