import React, { useEffect, useMemo, useState } from "react";
import { Box, Static, Text, useInput } from "ink";
import type { AgentSession } from "@moh/core";
import { useSessionState } from "./session-bridge";
import type { TurnView, ToolView } from "./turns";
import { useTheme } from "./themes";
import { ic, SPINNER_FRAMES } from "./icons";
import { createMarkdownRenderer, Markdown } from "./markdown";
import { Accent, Dim, Footer, Logo, MsgBox, truncate, useCompact } from "./ui";
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
}

export function Chat({ session, mode, modelLabel, blocked = false, filePreview = "on-demand", onOpenCommands }: ChatProps) {
  const theme = useTheme();
  const state = useSessionState(session);
  const md = useMemo(() => createMarkdownRenderer(theme), [theme]);
  const [tick, setTick] = useState(0);
  const [lastEsc, setLastEsc] = useState(0);
  const [armed, setArmed] = useState(false);
  const [detail, setDetail] = useState(filePreview === "always");
  const compact = useCompact();

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
              <TurnBoxes turn={turn} md={md} mode={mode} detail={detail} />
            </Box>
          )}
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
        onSubmit={(text) => void session.send(text)}
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
