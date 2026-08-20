import React, { useEffect, useMemo, useState } from "react";
import { Box, Static, Text, useInput, useStdout } from "ink";
import type { AgentSession } from "@moh/core";
import { useSessionState } from "./session-bridge";
import type { TurnView, ToolView } from "./turns";
import { useTheme } from "./themes";
import { ic, SPINNER_FRAMES } from "./icons";
import { createMarkdownRenderer, Markdown } from "./markdown";
import { Accent, Dim, Footer, Logo, MsgBox } from "./ui";
import { MultilineInput } from "./Input";

export type Mode = "vibe" | "dev";

/** Two presses of esc inside this window: first arms steering, second stops. */
const ESC_WINDOW_MS = 1500;

export interface ChatProps {
  session: AgentSession;
  mode: Mode;
  modelLabel: string;
}

export function Chat({ session, mode, modelLabel }: ChatProps) {
  const theme = useTheme();
  const state = useSessionState(session);
  const md = useMemo(() => createMarkdownRenderer(theme), [theme]);
  const [tick, setTick] = useState(0);
  const [lastEsc, setLastEsc] = useState(0);
  const [armed, setArmed] = useState(false);
  const { stdout } = useStdout();
  const compact = (stdout.columns ?? 80) < 60;

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 90);
    return () => clearInterval(t);
  }, []);

  // Settled turns go to <Static> (outside the render loop); only the live
  // turn + chrome re-render while streaming. Render window: the most recent
  // 200 settled turns — older ones stay in the terminal's own scrollback.
  const settled = state.turns.filter((t) => t.phase !== "streaming");
  const windowed = settled.slice(-200);
  const live = state.turns.filter((t) => t.phase === "streaming");

  useInput((input, key) => {
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
    <Box flexDirection="column" height="100%">
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
        <Static items={windowed}>
          {(turn) => (
            <Box key={turn.id} flexDirection="column">
              <TurnBoxes turn={turn} md={md} mode={mode} />
            </Box>
          )}
        </Static>
        {live.map((turn) => (
          <Box key={turn.id} flexDirection="column">
            <TurnBoxes turn={turn} md={md} mode={mode} skipReply />
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
        onSubmit={(text) => void session.send(text)}
      />
      <Text> </Text>
      <Footer
        keys={
          compact
            ? `${theme.label} · ctrl+t theme · ctrl+m mode · q quit`
            : streaming
              ? `${theme.label} · ctrl+t theme · ctrl+m ${mode === "vibe" ? "dev" : "vibe"} mode · esc steer / esc esc stop · q quit`
              : `${theme.label} · ctrl+t theme · ctrl+m ${mode === "vibe" ? "dev" : "vibe"} mode · q quit`
        }
      />
    </Box>
  );
}

/** Renders a turn as labelled boxes: you → tools → moh. */
export function TurnBoxes({ turn, md, mode, skipReply }: { turn: TurnView; md: ReturnType<typeof createMarkdownRenderer>; mode: Mode; skipReply?: boolean }) {
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
          <ToolLine key={call.callId} call={call} mode={mode} />
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

function ToolLine({ call, mode }: { call: ToolView; mode: Mode }) {
  const theme = useTheme();
  const detail = call.output ? (call.output.length > 80 ? call.output.slice(0, 77) + "…" : call.output) : "";
  const mark = call.ok === null ? "…" : call.ok ? ic("✓", "ok") : "✗";
  return (
    <Text>
      <Dim>
        {` ${ic("🔧", "run")} ${call.name} ${call.ok === null ? "running…" : mark}`}
        {mode === "dev" && detail ? ` ${detail}` : ""}
      </Dim>
    </Text>
  );
}
