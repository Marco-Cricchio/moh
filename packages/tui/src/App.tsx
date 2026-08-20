import React, { useState } from "react";
import { useApp, useInput } from "ink";
import { Box } from "ink";
import type { AgentSession, Provider } from "@moh/core";
import { SessionStore } from "@moh/core";
import { THEMES, THEME_ORDER, DEFAULT_THEME, ThemeProvider, type ThemeName } from "./themes";
import { Home } from "./Home";
import { Chat, type Mode } from "./Chat";
import { makeSession, providerLabel } from "./factory";
import type { SessionSummary } from "./sessions";

export interface AppProps {
  cwd: string;
  home?: string;
  /** Skip the home screen (bare resume / tests). */
  startInChat?: boolean;
  /** Pre-configured provider (tests, `--provider`). */
  provider?: Provider;
  initialMode?: Mode;
  initialTheme?: ThemeName;
}

/**
 * The moh TUI (#14): vibe/dev views over the same event log, filter-first
 * home, 9 themes in React state (a switch remounts the tree via `key`).
 */
export function App({ cwd, home, startInChat, provider, initialMode = "vibe", initialTheme = DEFAULT_THEME }: AppProps) {
  const { exit } = useApp();
  const [themeName, setThemeName] = useState<ThemeName>(initialTheme);
  const [themeTick, setThemeTick] = useState(0);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [session, setSession] = useState<AgentSession | null>(() =>
    startInChat ? makeSession({ cwd, home, provider }).session : null,
  );

  const open = (resume: SessionSummary | null, initialPrompt?: string) => {
    let made: ReturnType<typeof makeSession>;
    if (resume) {
      const store = SessionStore.open(resume.file);
      made = makeSession({ cwd, home, provider, store, resumeEvents: store.load() });
    } else {
      made = makeSession({ cwd, home, provider });
    }
    setSession(made.session);
    if (initialPrompt) void made.session.send(initialPrompt);
  };

  useInput((input, key) => {
    // Non-text keys only: bare letters/digits would collide with typing
    // both in the chat input and the home search box.
    if (key.ctrl && input === "m") return setMode((m) => (m === "vibe" ? "dev" : "vibe"));
    if (key.ctrl && input === "t") {
      const i = THEME_ORDER.indexOf(themeName);
      setThemeName(THEME_ORDER[(i + 1) % THEME_ORDER.length]!);
      setThemeTick((t) => t + 1);
    }
  });

  const showChat = session !== null;

  return (
    <ThemeProvider value={THEMES[themeName]}>
      <Box flexDirection="column" height="100%" key={themeTick}>
        {showChat ? (
          <Chat session={session} mode={mode} modelLabel={providerLabel(provider, cwd)} />
        ) : (
          <Home cwd={cwd} home={home} mode={mode} onOpen={open} onExit={exit} />
        )}
      </Box>
    </ThemeProvider>
  );
}
