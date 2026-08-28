import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "./themes";
import { ic } from "./icons";
import { Accent, Dim, Footer, Logo, truncate } from "./ui";
import {
  HOME_LIST_DEFAULT,
  visibleListHeight,
  windowing,
  widthClass,
  useViewport,
} from "./viewport";
import { listSessionSummaries, type SessionSummary } from "./sessions";
import type { Mode } from "./Chat";
import type { UpdateNotice } from "@moh/core";

/** The fixed home line / one-shot toast text (#273 / ADR-0014). */
export function updateNoticeText(notice: UpdateNotice): string {
  return notice.kind === "available"
    ? `moh ${notice.latestVersion} available — run \`moh update\``
    : `non-stable (dev) version — run \`moh update\``;
}

export interface HomeProps {
  cwd: string;
  home?: string;
  mode: Mode;
  /** Opens a session: resume when a summary is given, fresh when null. */
  onOpen: (resume: SessionSummary | null, initialPrompt?: string) => void;
  onOpenSettings?: () => void;
  onOpenCommands?: () => void;
  /** Modal overlays own input while open. */
  blocked?: boolean;
  /** Visible rows of the recent-sessions list (user setting `homeListMax`). */
  listMax?: number;
  /** Update notice driven by the cached check result (#273). */
  updateNotice?: UpdateNotice | null;
}

/**
 * Filter-first home (#14 Q6): one search/new-session prompt; the recent
 * sessions list filters live; enter resumes the selection (or starts the
 * typed prompt as a new session); `n` starts fresh. "New session" is
 * always the first row; the session list is capped at `listMax` visible
 * rows (floor 3 on small screens) and scrolls to follow the cursor.
 */
export function Home({ cwd, home, mode, onOpen, onOpenSettings, onOpenCommands, blocked = false, listMax = HOME_LIST_DEFAULT, updateNotice = null }: HomeProps) {
  const theme = useTheme();
  const viewport = useViewport();
  const compact = widthClass(viewport) === "compact";
  // Search/list column: fixed 50 where it fits, contracting on narrow terminals.
  const boxW = Math.min(50, viewport.columns - 4);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const sessions = useMemo(() => listSessionSummaries(cwd, home), [cwd, home]);
  const hits = sessions.filter((s) => s.title.toLowerCase().includes(query.toLowerCase()));
  // Row 0 is always "New session" (or "start <query>"); rows 1..n are hits.
  const totalRows = 1 + hits.length;
  // A narrower filter can leave the cursor past the end: clamp in render.
  const cursorRow = Math.min(cursor, totalRows - 1);
  const hitIndex = cursorRow - 1; // -1 = the new-session row
  const win = windowing(hits.length, Math.max(hitIndex, 0), visibleListHeight(listMax, viewport.rows));

  useInput((input, key) => {
    if (blocked) return;
    if (input === "q" && query === "") return; // q is just a search char; exit is double ctrl+c (App-level)
    if (key.upArrow) return setCursor((c) => Math.max(0, Math.min(c, totalRows - 1) - 1));
    if (key.downArrow) return setCursor((c) => Math.min(totalRows - 1, Math.max(c, 0) + 1));
    if (key.return || input === "\n") {
      if (cursorRow === 0) return onOpen(null, query.trim() || undefined);
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
      <Box borderStyle="round" borderColor={theme.border} width={boxW} paddingX={1}>
        <Text>{query || <Dim>search or start something new…</Dim>}</Text>
        <Text color={theme.dim}>▊</Text>
      </Box>
      <Text> </Text>
      <Box flexDirection="column" width={boxW}>
        <Text color={cursorRow === 0 ? theme.bg : theme.accent} backgroundColor={cursorRow === 0 ? theme.accent : undefined}>
          {` ${cursorRow === 0 ? ic("›", ">") : " "} ${query.trim() ? `start “${truncate(query.trim(), boxW - 16)}”` : "New session"}` + (cursorRow === 0 ? " " : "")}
        </Text>
        {win.above > 0 ? <Dim>{` ↑ ${win.above} more`}</Dim> : null}
        {hits.slice(win.start, win.start + win.count).map((s, i) => {
          const selected = win.start + i === hitIndex;
          return (
            <Text key={s.id} color={selected ? theme.bg : undefined} backgroundColor={selected ? theme.dim : undefined}>
              {` ${selected ? ic("›", ">") : " "} ${truncate(s.title, boxW - 4)}`}
            </Text>
          );
        })}
        {win.below > 0 ? <Dim>{` ↓ ${win.below} more`}</Dim> : null}
        {hits.length === 0 ? <Dim>{` (no sessions yet — type to start one)`}</Dim> : null}
        <Text> </Text>
      </Box>
      {query ? <Dim>{"enter open · esc clear · ↑↓ select"}</Dim> : null}
      <Text> </Text>
      {updateNotice ? <Text color={theme.warn}>{updateNoticeText(updateNotice)}</Text> : null}
      <Footer
        keys={
          compact
            ? `${theme.label} · ctrl+t theme · ctrl+o mode · ctrl+c ×2 quit`
            : `${theme.label} · ctrl+t theme · ctrl+o mode · new (n) · settings (s) · keys (?) · ctrl+c ×2 quit`
        }
      />
    </Box>
  );
}
