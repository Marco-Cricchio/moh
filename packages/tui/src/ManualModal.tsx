import React, { useMemo, useState } from "react";
import { Text, useInput } from "ink";
import { manualIndex, manualPage } from "@moh/core";
import { createMarkdownRenderer, parseAnsiSegments, renderMarkdownRows } from "./markdown";
import { useTheme } from "./themes";
import { Dialog, Dim, truncate } from "./ui";
import { dialogWidth, useViewport, windowing } from "./viewport";

/**
 * The user manual modal (#457): a filterable index of the bundled pages
 * (incremental filter over titles and body text, in the style of the
 * Home session list) opening a scrollable page. `esc` from a page goes
 * back to the index; `esc esc` (a second esc at the index) closes the
 * modal. The breadcrumb lives in the page head. Pages use the same
 * terminal Markdown renderer as the transcript, so the documented subset
 * (headings, lists, fenced code and tables) is rendered rather than shown
 * as source Markdown.
 */

interface IndexEntry {
  id: string;
  title: string;
  summary: string;
}

export function ManualModal({ onClose }: { onClose: () => void }) {
  const theme = useTheme();
  const viewport = useViewport();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [pageCursor, setPageCursor] = useState(0);

  const matches = useMemo<IndexEntry[]>(() => {
    const index = manualIndex() as IndexEntry[];
    const q = query.trim().toLowerCase();
    if (!q) return index;
    // Titles and body text: a page matches when any word of the query
    // appears in the title, the summary, or the page body.
    const words = q.split(/\s+/).filter(Boolean);
    return index.filter((entry) => {
      const body = (manualPage(entry.id)?.body ?? "").toLowerCase();
      return words.every((w) => entry.title.toLowerCase().includes(w) || entry.summary.toLowerCase().includes(w) || body.includes(w));
    });
  }, [query]);

  // Dialog chrome ≈ 7 rows (title, breadcrumb/filter, blank, footer).
  const budget = Math.max(4, viewport.rows - 8);
  const win = windowing(matches.length, cursor, budget);

  const page = openId ? manualPage(openId) : null;
  const pageWidth = Math.max(20, dialogWidth(viewport) - 6);
  const pageMarkdown = useMemo(() => createMarkdownRenderer(theme, pageWidth), [theme, pageWidth]);
  const pageLines = useMemo(
    () => page ? renderMarkdownRows(page.body, pageMarkdown, pageWidth) : [],
    [page, pageMarkdown, pageWidth],
  );
  // Reserve the dialog title, its spacer, breadcrumb, page spacer, footer,
  // and both scroll indicators. This keeps a long page inside the viewport
  // even when it has content above and below the current window.
  const pageWin = windowing(pageLines.length, pageCursor, Math.max(4, viewport.rows - 10));

  useInput((input, key) => {
    if (key.escape) {
      // Page → back to the index (first esc). Index → close (which is
      // the second esc of the "esc esc" gesture from a page).
      if (page) {
        setOpenId(null);
        setPageCursor(0);
      } else {
        onClose();
      }
      return;
    }
    if (page) {
      if (key.upArrow) setPageCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) setPageCursor((c) => Math.min(pageLines.length - 1, c + 1));
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      setCursor(0);
      return;
    }
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) setCursor((c) => Math.min(Math.max(0, matches.length - 1), c + 1));
    if ((key.return || input === "\n") && matches[cursor]) {
      setOpenId(matches[cursor]!.id);
      setPageCursor(0);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setQuery((q) => q + input);
      setCursor(0);
    }
  });

  if (page) {
    return (
      <Dialog title=" manual " color={theme.purple} center={false}>
        <Text bold color={theme.accent}>{`Manual → ${page.title}`}</Text>
        <Text> </Text>
        {pageWin.above > 0 && <Dim>{` ↑ ${pageWin.above} more`}</Dim>}
        {pageLines.slice(pageWin.start, pageWin.start + pageWin.count).map((line, i) => (
          <Text key={`${pageWin.start + i}`} wrap="wrap">
            {line.trim() === ""
              ? " "
              : parseAnsiSegments(line).map((segment, s) => (
                <Text key={s} color={segment.color} bold={segment.bold} italic={segment.italic} strikethrough={segment.strikethrough}>{segment.text}</Text>
              ))}
          </Text>
        ))}
        {pageWin.below > 0 && <Dim>{` ↓ ${pageWin.below} more (↑↓ scroll)`}</Dim>}
        <Dim>↑↓ scroll · esc back (esc esc close)</Dim>
      </Dialog>
    );
  }

  return (
    <Dialog title=" manual " color={theme.purple} center={false}>
      <Text bold>filter: {query || "…"}</Text>
      <Text> </Text>
      {win.above > 0 && <Dim>{` ↑ ${win.above} more`}</Dim>}
      {matches.slice(win.start, win.start + win.count).map((entry, i) => {
        const index = win.start + i;
        const selected = index === cursor;
        const line = ` ${selected ? "›" : " "} ${entry.id.padEnd(22)} ${entry.title}`;
        return (
          <Text
            key={entry.id}
            color={selected ? theme.bg : undefined}
            backgroundColor={selected ? theme.accent : undefined}
            wrap="truncate-end"
          >
            {truncate(line, viewport.columns - 6)}
          </Text>
        );
      })}
      {matches.length === 0 && <Dim> no page matches this filter</Dim>}
      {win.below > 0 && <Dim>{` ↓ ${win.below} more (↑↓ scroll)`}</Dim>}
      <Dim>type to filter · enter read · esc close</Dim>
    </Dialog>
  );
}
