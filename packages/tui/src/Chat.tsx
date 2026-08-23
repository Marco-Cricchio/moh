import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useInput } from "ink";
import type { AgentSession } from "@moh/core";
import { useSessionState } from "./session-bridge";
import type { TurnView, ToolView } from "./turns";
import { useTheme } from "./themes";
import { ic, SPINNER_FRAMES } from "./icons";
import { createMarkdownRenderer, Markdown } from "./markdown";
import { Accent, Dim, Footer, Logo, MsgBox, truncate } from "./ui";
import { contentWidth, useStdoutResize, useViewport, widthClass } from "./viewport";
import { toolArgSummary } from "./permission-gate";
import { MultilineInput } from "./Input";

export type Mode = "vibe" | "dev";

/** Two presses of esc inside this window: first arms steering, second stops. */
const ESC_WINDOW_MS = 1500;

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
}

export function Chat({ session, mode, modelLabel, blocked = false, filePreview = "on-demand", onOpenCommands, onCommand, width }: ChatProps) {
  const theme = useTheme();
  const state = useSessionState(session);
  const viewport = useViewport();
  const cols = width ?? contentWidth(viewport);
  const md = useMemo(() => createMarkdownRenderer(theme, cols - 4), [theme, cols]);
  const compact = widthClass(viewport) === "compact";
  const [tick, setTick] = useState(0);
  const [lastEsc, setLastEsc] = useState(0);
  const [armed, setArmed] = useState(false);
  const [detail, setDetail] = useState(filePreview === "always");

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 90);
    return () => clearInterval(t);
  }, []);

  // Terminal resize (#65): Ink prints <Static> output exactly once at the
  // width of first render, so a resize leaves stale frames on screen
  // (worst on shrink: overlapping boxes). Debounced clear + remount of the
  // Static column reprints the settled turns at the new width. Skipped
  // while a modal owns the keyboard — the reprint happens on the next
  // width change; remounting under an open overlay is unsafe because a
  // taller-than-viewport frame could trip Ink's fullscreen replay path.
  const lastCols = useRef(viewport.columns);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [staticKey, setStaticKey] = useState(0);
  useStdoutResize((stdout) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const cols = stdout.columns ?? 80;
      if (cols === lastCols.current || blocked) return;
      lastCols.current = cols;
      stdout.write("\x1b[2J\x1b[H");
      setStaticKey((k) => k + 1);
    }, 150);
  });

  // Settled turns go to <Static> (outside the render loop); only the live
  // turn + chrome re-render while streaming. Render window: the most recent
  // 200 settled turns — older ones stay in the terminal's own scrollback.
  const settled = state.turns.filter((t) => t.phase !== "streaming");
  const windowed = settled.slice(-200);
  const live = state.turns.filter((t) => t.phase === "streaming");

  useInput((input, key) => {
    if (blocked) return;
    if (key.ctrl && input === "d" && filePreview !== "none") return setDetail((d) => !d);
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
  const spinner = SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!;

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

      <Box flexDirection="column" width="100%">
        <Static key={staticKey} items={windowed}>
          {(turn) => {
            // Static output is hoisted above the frame at column 0 (Ink
            // extracts it into its own Output), so the gutter is padded
            // manually to keep settled turns aligned with the live column.
            const gutter = Math.max(0, (viewport.columns - cols) >> 1);
            return (
              <Box key={turn.id} flexDirection="column" width={cols} marginLeft={gutter}>
                <TurnBoxes turn={turn} md={md} mode={mode} detail={detail} />
              </Box>
            );
          }}
        </Static>
        {live.map((turn) => (
          <Box key={turn.id} flexDirection="column">
            <TurnBoxes turn={turn} md={md} mode={mode} detail={detail} skipReply />
            <MsgBox label=" moh " color={theme.purple}>
              <Markdown text={turn.reply} md={md} />
              <Text>
                <Dim>{`  ${spinner} ${mode === "vibe" ? "thinking…" : "streaming"} · ${
                  armed ? "esc again to stop" : "esc to steer"
                }`}</Dim>
              </Text>
            </MsgBox>
          </Box>
        ))}
      </Box>
      <Text> </Text>
      <MultilineInput
        placeholder={compact ? "type…" : "type… (ctrl+j newline · ctrl+e editor)"}
        disabled={blocked}
        onAskCommands={onOpenCommands}
        onSubmit={(text) => {
          if (onCommand?.(text)) return;
          void session.send(text);
        }}
      />
      <Text> </Text>
      <Footer
        keys={
          compact
            ? `${theme.label} · ctrl+t theme · ctrl+m mode · ctrl+k keys · q quit`
            : `${theme.label} · ctrl+t theme · ctrl+m ${mode === "vibe" ? "dev" : "vibe"}${filePreview === "none" ? "" : " · ctrl+d detail"} · ctrl+s settings · ctrl+k keys${streaming ? " · esc steer / esc esc stop" : ""} · q quit`
        }
      />
    </Box>
  );
}

/** Renders a turn as labelled boxes: you → tools → moh. */
export function TurnBoxes({ turn, md, mode, detail, skipReply }: { turn: TurnView; md: ReturnType<typeof createMarkdownRenderer>; mode: Mode; detail?: boolean; skipReply?: boolean }) {
  const theme = useTheme();
  const items: React.ReactNode[] = [];
  items.push(
    <MsgBox key="you" label=" you " color={theme.accent}>
      <Text>{turn.user}</Text>
    </MsgBox>,
  );
  if (turn.toolCalls.length > 0) {
    items.push(
      <MsgBox key="tools" label={mode === "vibe" ? " what I did " : ` tool · ${turn.toolCalls.length} call${turn.toolCalls.length > 1 ? "s" : ""} `} color={theme.border}>
        {turn.toolCalls.map((call) => (
          <ToolLine key={call.callId} call={call} mode={mode} detail={detail} />
        ))}
      </MsgBox>,
    );
  }
  const reply = turn.reply.trim();
  if (skipReply) return <>{items}</>;
  if (reply || turn.phase === "error") {
    items.push(
      <MsgBox key="moh" label=" moh " color={theme.purple}>
        {reply ? <Markdown text={reply} md={md} /> : null}
        {turn.phase === "error" ? (
          <Text color={theme.warn}>{`⚠ ${turn.error?.reason ?? "error"}: ${turn.error?.message ?? ""}`}</Text>
        ) : null}
        {turn.phase === "cancelled" ? <Dim>· stopped ·</Dim> : null}
      </MsgBox>,
    );
  }
  return <>{items}</>;
}

function ToolLine({ call, mode, detail }: { call: ToolView; mode: Mode; detail?: boolean }) {
  const theme = useTheme();
  const detailText = call.output ? truncate(call.output, 80) : "";
  const mark = call.ok === null ? "…" : call.ok ? ic("✓", "ok") : "✗";
  const argsLine = toolArgSummary(call.args);
  return (
    <Box flexDirection="column">
      <Text>
        <Dim>
          {` ${ic("🔧", "run")} ${call.name} ${call.ok === null ? "running…" : mark}`}
          {argsLine ? ` ${argsLine}` : ""}
          {mode === "dev" && !detail && detailText ? ` ${detailText}` : ""}
        </Dim>
      </Text>
      {detail && call.output ? (
        <Box flexDirection="column" paddingLeft={3}>
          {call.output
            .split("\n")
            .slice(0, 20)
            .map((line, i) => (
              <Dim key={i}>{truncate(line, 200)}</Dim>
            ))}
        </Box>
      ) : null}
    </Box>
  );
}
