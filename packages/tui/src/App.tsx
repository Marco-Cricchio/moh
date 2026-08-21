import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useApp, useInput } from "ink";
import { Box } from "ink";
import { join } from "node:path";
import { loadMohConfig, type AgentSession, type Provider } from "@moh/core";
import { SessionStore } from "@moh/core";
import { THEMES, THEME_ORDER, DEFAULT_THEME, ThemeProvider, type ThemeName } from "./themes";
import { setIcons } from "./icons";
import { Home } from "./Home";
import { Chat, type Mode } from "./Chat";
import { makeSession, providerLabel } from "./factory";
import type { SessionSummary } from "./sessions";
import { loadUserConfig, saveUserConfig, userConfigFile, type UserConfig } from "./user-config";
import { PermissionGate } from "./permission-gate";
import { useCompact } from "./ui";
import { PermissionModal } from "./PermissionModal";
import { Onboarding } from "./OnboardingOverlay";
import { SettingsPanel } from "./SettingsPanel";
import { CommandsPanel } from "./CommandsPanel";
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

type Overlay = null | "settings" | "commands" | "onboarding";

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
  const compact = useCompact();

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
  const [wizardFromSettings, setWizardFromSettings] = useState(false);

  const gateRef = useRef<PermissionGate | null>(null);
  if (gateRef.current === null) gateRef.current = new PermissionGate();
  const gate = gateRef.current;
  useSyncExternalStore(gate.subscribe, gate.getSnapshot);
  const pending = gate.current;

  const { toasts, push } = useToasts();
  const blocked = pending !== null || overlay !== null;

  const open = (resume: SessionSummary | null, initialPrompt?: string) => {
    const base = {
      cwd,
      home,
      provider,
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
    if (overlay !== null && overlay !== "onboarding" && key.escape) return setOverlay(null);
  });

  const showChat = session !== null;

  return (
    <ThemeProvider value={THEMES[themeName]}>
      <Box flexDirection="column" height="100%" key={themeTick}>
        {showChat ? (
          <Chat
            session={session}
            mode={mode}
            modelLabel={modelLabel}
            blocked={blocked}
            filePreview={config.filePreview}
            onOpenCommands={() => setOverlay("commands")}
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
          />
        )}
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
        {overlay === "commands" && <CommandsPanel compact={compact} onClose={() => setOverlay(null)} />}
        {pending && <PermissionModal gate={gate} mode={mode} compact={compact} editor={config.editor} />}
        <Toasts toasts={toasts} />
      </Box>
    </ThemeProvider>
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
