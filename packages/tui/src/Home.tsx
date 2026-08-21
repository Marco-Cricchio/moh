import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "./themes";
import { ic } from "./icons";
import { Accent, Dim, Footer, Logo, useCompact } from "./ui";
import { listSessionSummaries, type SessionSummary } from "./sessions";
import type { Mode } from "./Chat";

export interface HomeProps {
  cwd: string;
  home?: string;
  mode: Mode;
  /** Opens a session: resume when a summary is given, fresh when null. */
  onOpen: (resume: SessionSummary | null, initialPrompt?: string) => void;
  onExit: () => void;
  onOpenSettings?: () => void;
  onOpenCommands?: () => void;
}

/**
 * Filter-first home (#14 Q6): one search/new-session prompt; the recent
 * sessions list filters live; enter resumes the selection (or starts the
 * typed prompt as a new session); `n` starts fresh.
 */
export function Home({ cwd, home, mode, onOpen, onExit, onOpenSettings, onOpenCommands }: HomeProps) {
  const theme = useTheme();
  const compact = useCompact();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const sessions = useMemo(() => listSessionSummaries(cwd, home), [cwd, home]);
  const hits = sessions.filter((s) => s.title.toLowerCase().includes(query.toLowerCase()));
  const newOption = query.trim().length > 0;
  const rows = newOption ? hits.length + 1 : hits.length;
  const hitIndex = cursor - (newOption ? 1 : 0); // -1 = the "start new" row

  useInput((input, key) => {
    if (input === "q" && query === "") return onExit(); // else "q" is just a search char
    if (key.upArrow) return setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) return setCursor((c) => Math.min(rows - 1, c + 1));
    if (key.return || input === "\n") {
      if (newOption && cursor === 0) return onOpen(null, query.trim());
      const hit = hits[hitIndex];
      if (hit) return onOpen(hit);
      return;
    }
    if (input === "n" && query === "") return onOpen(null);
    if (input === "s" && query === "" && onOpenSettings) return onOpenSettings();
    if (input === "?" && query === "" && onOpenCommands) return onOpenCommands();
    if (key.backspace || key.delete) return setQuery((q) => q.slice(0, -1));
    if (key.escape) return setQuery("");
    if (input && !key.ctrl && !key.meta) {
      setQuery((q) => q + input);
      setCursor(0);
    }
  });

  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} paddingY={2}>
      <Logo />
      <Text> </Text>
      <Text> </Text>
      <Box borderStyle="round" borderColor={theme.border} width={50} paddingX={1}>
        <Text>{query || <Dim>search or start something new…</Dim>}</Text>
        <Text color={theme.dim}>▊</Text>
      </Box>
      <Text> </Text>
      <Box flexDirection="column" width={50}>
        {newOption && (
          <Text color={cursor === 0 ? theme.bg : theme.accent} backgroundColor={cursor === 0 ? theme.accent : undefined}>
            {` ${cursor === 0 ? ic("›", ">") : " "} start “${query.trim()}”` + (cursor === 0 ? " " : "")}
          </Text>
        )}
        {hits.map((s, i) => {
          const selected = i === hitIndex;
          return (
            <Text key={s.id} color={selected ? theme.bg : undefined} backgroundColor={selected ? theme.dim : undefined}>
              {` ${selected ? ic("›", ">") : " "} ${s.title}`}
            </Text>
          );
        })}
        {!newOption && hits.length === 0 ? <Dim>{` (no sessions yet — type to start one)`}</Dim> : null}
        <Text> </Text>
        <Dim>{query ? "enter open · esc clear · ↑↓ select" : "type to filter or start new · n new session · s settings · ? keys"}</Dim>
      </Box>
      <Text> </Text>
      <Footer
        keys={
          compact
            ? `${theme.label} · ctrl+t theme · ctrl+m mode · q quit`
            : `${theme.label} · ctrl+t theme · ctrl+m mode · s settings · ? keys · q quit`
        }
      />
    </Box>
  );
}
