import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, Static, useInput } from "ink";
import type { AgentSession } from "@moh/core";
import { useSessionState } from "./session-bridge";
import { createMarkdownRenderer } from "./markdown";
import { ChatWindow, CHAT_WINDOW_BUFFER, resolveOffset, scrollAnchor, turnLines, type ScrollAnchor } from "./chat-window";
import { useTheme } from "./themes";
import { SPINNER_FRAMES } from "./icons";
import { Dim, Logo } from "./ui";
import { chatWrapWidth, chatWindowRows, widthClass, useViewport, contentWidth } from "./viewport";
import { MultilineInput } from "./Input";

export type Mode = "vibe" | "dev";

/** Two presses of esc inside this window: first arms steering, second stops. */
const ESC_WINDOW_MS = 1500;

/** Settled turns kept in the line buffer; older history = resume. */
const TURN_BUFFER = 200;

export interface ChatProps {
  session: AgentSession;
  mode: Mode;
  modelLabel: string;
  /** A modal owns the keyboard (permission/settings/commands): chat input and steering pause. */
  blocked?: boolean;
  /** Contextual tool-call viewer: "always" starts expanded, "none" disables the toggle (#33). */
  filePreview?: "always" | "on-demand" | "none";
  onOpenCommands?: () => void;
  /**
   * Slash-command intercept (#36): returns true when the text was a
   * command and must not reach the model.
   */
  onCommand?: (text: string) => boolean;
  /** Column budget override (dashboard center column, #115); defaults to
   * the centered measure of the full viewport. */
  width?: number;
  /** False while the dashboard menu owns the keyboard (#116). */
  inputFocused?: boolean;
  /** Reports the footer-relevant hints upward: the chip footer (dashboard
   * footer or single-column row) renders them, the chat column has no
   * tips row of its own anymore. */
  onHints?: (hints: { streaming: boolean; atBottom: boolean }) => void;
}

/**
 * The session screen chat column (#14, #117): header, the transcript as a
 * fixed-height internal window (bottom-anchored, keyboard scroll — the
 * terminal itself never scrolls during a session), and the input. Settled
 * history no longer goes through <Static>: the window renders the most
 * recent lines and ↑↓/PgUp–PgDn move a scroll offset; streaming re-renders
 * never fight the offset because follow-tail is explicit anchor state.
 */
export function Chat({ session, mode, modelLabel, blocked = false, filePreview = "on-demand", onOpenCommands, onCommand, width, inputFocused = true, onHints }: ChatProps) {
  const theme = useTheme();
  const state = useSessionState(session);
  const viewport = useViewport();
  const cols = width ?? contentWidth(viewport);
  const wrapW = chatWrapWidth(cols);
  // Regenerated per theme+width: marked-terminal captures both at construction
  // (docs/tui-style-guide.md §5).
  const md = useMemo(() => createMarkdownRenderer(theme, wrapW), [theme, wrapW]);
  const compact = widthClass(viewport) === "compact";
  const [tick, setTick] = useState(0);
  const [lastEsc, setLastEsc] = useState(0);
  const [armed, setArmed] = useState(false);
  const [detail, setDetail] = useState(filePreview === "always");
  const [draftLines, setDraftLines] = useState(1);
  const [anchor, setAnchor] = useState<ScrollAnchor>({ follow: true, offset: 0 });

  // The spinner tick runs only while a turn is in flight: an idle session
  // re-renders nothing, so the 200-turn line projection never rebuilds at
  // ~11Hz (streaming flushes already re-render at ~30fps).
  useEffect(() => {
    if (!state.pending) return;
    const t = setInterval(() => setTick((x) => x + 1), 90);
    return () => clearInterval(t);
  }, [state.pending]);

  // The transcript window: flat lines from the buffered turns, live turn
  // included (its streaming status line is part of the tail).
  const windowed = state.turns.slice(-TURN_BUFFER);
  const spinner = SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!;
  const streamingNote = `${mode === "vibe" ? "thinking…" : "streaming…"} · ${armed ? "esc again to stop" : "esc to steer"}`;
  const lines = useMemo(
    () =>
      windowed
        .flatMap((turn) => turnLines(turn, wrapW, { detail, spinner, streamingNote, md }))
        .slice(-CHAT_WINDOW_BUFFER),
    // spinner/tick drive the live status line; windowed identity changes on every event flush
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [windowed, wrapW, detail, spinner, streamingNote, md],
  );

  const height = chatWindowRows(viewport, draftLines);
  const offset = resolveOffset(anchor, lines.length, height);
  const atBottom = anchor.follow || offset >= lines.length - height;

  // Footer hints live in the chip footer now, not under the input.
  useEffect(() => {
    onHints?.({ streaming: state.pending, atBottom });
  }, [onHints, state.pending, atBottom]);

  useInput((input, key) => {
    if (blocked) return;
    if (key.ctrl && input === "d" && filePreview !== "none") return setDetail((d) => !d);
    // Keyboard scroll (#117): PgUp/PgDn always; ↑↓ only while the draft is a
    // single line (multiline editing keeps the cursor keys).
    if (inputFocused && (key.pageUp || key.pageDown || ((key.upArrow || key.downArrow) && draftLines <= 1))) {
      const step = key.pageUp || key.pageDown ? height : 1;
      const delta = (key.pageUp || key.upArrow ? -step : step);
      setAnchor((a) => scrollAnchor(a, delta, lines.length, height));
      return;
    }
    if (key.escape) {
      const now = Date.now();
      if (now - lastEsc < ESC_WINDOW_MS && session.pending()) {
        session.abort();
        setArmed(false);
        setLastEsc(0);
      } else {
        setLastEsc(now);
        setArmed(true);
      }
      return;
    }
    if (armed && (input !== undefined || key.return)) setArmed(false);
  });

  const streaming = state.pending;

  return (
    <Box flexDirection="column" height="100%" width={cols}>
      <Box justifyContent="space-between" paddingX={2}>
        <Logo />
        {mode === "dev" && (
          <Dim>
            {modelLabel} · turn {state.turnCount} · {state.eventCount} events
            {streaming ? " · streaming" : ""}
          </Dim>
        )}
      </Box>
      <Text> </Text>

      {/* transcript window flexes to fill the column: the input is pinned
          to the bottom edge, vertically aligned with the sidebar panels —
          the fixed window height is an upper bound, never a gap. */}
      {/* Settled transcript is emitted into terminal scrollback.  It is
          intentionally not inside a fixed-height box: native scrollback is
          the selection/persistence boundary (#183). */}
      <Static items={lines}>
        {(line, index) => <Text key={`${index}-${line}`}>{line}</Text>}
      </Static>
      {state.pending && (
        <Box flexDirection="column">
          <Text color={theme.accent}>{streamingNote}</Text>
        </Box>
      )}

      <Text color={theme.border}>{"─".repeat(Math.max(1, cols - 1))}</Text>
      <MultilineInput
        placeholder={compact ? "type…" : "type… (ctrl+j newline · ctrl+e editor)"}
        disabled={blocked}
        focused={inputFocused}
        onAskCommands={onOpenCommands}
        onLinesChange={setDraftLines}
        onScrollRequest={(delta) => {
          setAnchor((a) => scrollAnchor(a, delta, lines.length, height));
        }}
        onSubmit={(text) => {
          if (onCommand?.(text)) return;
          void session.send(text);
        }}
      />
      <Text color={theme.border}>{"─".repeat(Math.max(1, cols - 1))}</Text>
      <Box width={cols} justifyContent="space-between">
        <Text color={state.pending ? theme.accent : theme.dim}>{state.pending ? `${spinner} ${mode === "vibe" ? "thinking" : "streaming"}` : "ready"}</Text>
        <Text color={theme.dim}>tab chips · ctrl+k commands · esc stop</Text>
      </Box>
    </Box>
  );
}
