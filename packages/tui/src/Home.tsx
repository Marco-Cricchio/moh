import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "./themes";
import { ic } from "./icons";
import { Accent, Dim, Footer, Logo, truncate } from "./ui";
import {
  HOME_LIST_DEFAULT,
  homeBannerFits,
  visibleListHeight,
  windowing,
  widthClass,
  useViewport,
} from "./viewport";
import { listSessionSummaries, type SessionSummary } from "./sessions";
import { MOH_VERSION, type HandoffOffer } from "@moh/core";
import type { Mode } from "./Chat";
import type { UpdateNotice } from "@moh/core";
import { skillUpdateNoticeText } from "./update-poll";

/** The fixed home line / one-shot toast text (#273 / ADR-0014). */
export function updateNoticeText(notice: UpdateNotice): string {
  return notice.kind === "available"
    ? `moh ${notice.latestVersion} available — run \`moh update\``
    : `non-stable (dev) version — run \`moh update\``;
}

/** The handoff row's timestamp source (T3 #436). */
function offerAt(offer: Extract<HandoffOffer, { status: "offer" }>): number {
  const parsed = Date.parse(offer.payload.updatedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Relative time for the pertinent-session banner (T3 #470). */
export function relativeTime(mtimeMs: number, now = Date.now()): string {
  const diff = now - mtimeMs;
  if (diff < 60_000) return "adesso";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}g`;
  return new Date(mtimeMs).toISOString().slice(0, 10);
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
  /** #348: discovered skill updates — persistent notice line. */
  skillUpdateCount?: number;
  /** T3 #436: a newer handoff discovered from another machine. */
  handoff?: HandoffOffer | null;
  /** Opens the seeded session from the discovered handoff (T3 #436). */
  onOpenHandoff?: (offer: Extract<HandoffOffer, { status: "offer" }>) => void;
  /** Version shown under the logo (#292; defaults to MOH_VERSION). */
  version?: string;
}

/**
 * Filter-first home (#14 Q6): one search/new-session prompt; the recent
 * sessions list filters live; enter resumes the selection (or starts the
 * typed prompt as a new session); `n` starts fresh. "New session" is
 * always the first row; the session list is capped at `listMax` visible
 * rows (floor 3 on small screens) and scrolls to follow the cursor.
 */
export function Home({ cwd, home, mode, onOpen, onOpenSettings, onOpenCommands, blocked = false, listMax = HOME_LIST_DEFAULT, updateNotice = null, skillUpdateCount = 0, version = MOH_VERSION, handoff = null, onOpenHandoff }: HomeProps) {
  const theme = useTheme();
  const viewport = useViewport();
  const compact = widthClass(viewport) === "compact";
  // Big ASCII banner only on tall non-compact terminals (#292); the version
  // moves from under the acronym into the footer in fallback mode.
  const banner = homeBannerFits(viewport);
  // Search/list column: fixed 50 where it fits, contracting on narrow terminals.
  const boxW = Math.min(50, viewport.columns - 4);
  const [query, setQuery] = useState("");
  // Pre-select the pertinent banner row when present (#470): opening it is
  // the suggested action; the first keystroke moves off it as usual. The
  // rows are computed below, so the default rides a lazy state initializer
  // over a ref-free closure: cursor === undefined means "not moved yet".
  const [cursor, setCursor] = useState<number | null>(null);
  const sessions = useMemo(() => listSessionSummaries(cwd, home), [cwd, home]);
  const hits = sessions.filter((s) => s.title.toLowerCase().includes(query.toLowerCase()));
  // Row 0 is always "New session" (or "start <query>"); row 1 is the
  // handoff offer when present (T3 #436); rows after are the hits.
  const handoffRow = handoff?.status === "offer" && onOpenHandoff ? 1 : -1;
  // The pertinent session (T3 #470, ADR-0021): the most recent not-yet-
  // consumed session, suggested as a pre-selected banner row above the
  // list — only when a query isn't filtering and the banner exists.
  const pertinent = useMemo(
    () => sessions.find((s) => !s.consumed && s.title !== "(unreadable session)"),
    [sessions],
  );
  const pertinentRow = pertinent && !query ? (handoffRow >= 0 ? 2 : 1) : -1;
  const effectiveCursor = cursor ?? (pertinentRow >= 0 ? pertinentRow : 0);
  // Row 0 is always "New session" (or "start <query>"); row 1 is the
  // handoff offer when present (T3 #436); row 2 the pertinent banner
  // (#470); rows after are the hits.
  const totalRows = 1 + (handoffRow >= 0 ? 1 : 0) + (pertinentRow >= 0 ? 1 : 0) + hits.length;
  // A narrower filter can leave the cursor past the end: clamp in render.
  const cursorRow = Math.min(effectiveCursor, totalRows - 1);
  const hitIndex = cursorRow - 1 - (handoffRow >= 0 ? 1 : 0) - (pertinentRow >= 0 ? 1 : 0); // < 0 = new-session/handoff/pertinent rows
  const win = windowing(hits.length, Math.max(hitIndex, 0), visibleListHeight(listMax, viewport.rows));

  useInput((input, key) => {
    if (blocked) return;
    if (input === "q" && query === "") return; // q is just a search char; exit is double ctrl+c (App-level)
    if (key.upArrow) return setCursor(Math.max(0, Math.min(effectiveCursor, totalRows - 1) - 1));
    if (key.downArrow) return setCursor(Math.min(totalRows - 1, Math.max(effectiveCursor, 0) + 1));
    if (key.return || input === "\n") {
      if (cursorRow === 0) return onOpen(null, query.trim() || undefined);
      if (cursorRow === handoffRow && handoff?.status === "offer" && onOpenHandoff) {
        if (query) return setQuery(""); // guard: enter while typing selects the query, not the handoff
        return onOpenHandoff(handoff);
      }
      if (cursorRow === pertinentRow && pertinent) return onOpen(pertinent);
      const hit = hits[hitIndex];
      if (hit) return onOpen(hit);
      return;
    }
    if (input === "h" && query === "" && handoffRow >= 0 && handoff?.status === "offer" && onOpenHandoff)
      return onOpenHandoff(handoff);
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
      <Logo banner={banner} version={banner ? version : undefined} />
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
        {handoff?.status === "offer" && onOpenHandoff ? (
          <Text
            color={cursorRow === handoffRow ? theme.bg : theme.warn}
            backgroundColor={cursorRow === handoffRow ? theme.warn : undefined}
          >
            {` ${cursorRow === handoffRow ? ic("›", ">") : " "} ⤴ session handoff from another machine (${new Date(offerAt(handoff)).toISOString().slice(0, 16).replace("T", " ")} UTC)${handoff.stale ? " · stale" : ""}`}
          </Text>
        ) : null}
        {pertinent && pertinentRow >= 0 ? (
          <Text
            color={cursorRow === pertinentRow ? theme.bg : theme.accent}
            backgroundColor={cursorRow === pertinentRow ? theme.accent : undefined}
          >
            {` ${cursorRow === pertinentRow ? ic("›", ">") : " "} ▸ ${relativeTime(pertinent.mtimeMs)} · ${truncate(pertinent.title, boxW - 20)}`}
          </Text>
        ) : null}
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
      {skillUpdateCount > 0 ? <Text color={theme.warn}>{skillUpdateNoticeText(skillUpdateCount)}</Text> : null}
      <Footer
        keys={
          (banner ? "" : `v${version} · `) +
          (compact
            ? `${theme.label} · ctrl+t theme · ctrl+o mode · ctrl+c ×2 quit`
            : `${theme.label} · ctrl+t theme · ctrl+o mode · new (n) · settings (s) · keys (?) · ctrl+c ×2 quit`)
        }
      />
    </Box>
  );
}
