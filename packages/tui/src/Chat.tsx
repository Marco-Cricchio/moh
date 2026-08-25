import React, { useEffect, useMemo, useState } from "react";
import { Box, Static, useInput } from "ink";
import type { AgentSession } from "@moh/core";
import { useSessionState } from "./session-bridge";
import { SPINNER_FRAMES } from "./icons";
import { widthClass, useViewport } from "./viewport";
import { MultilineInput } from "./Input";
import { BASE_COMMANDS } from "./commands";
import { projectTranscript, TranscriptBlockView, type TranscriptBlock } from "./transcript";
import { BottomBar, ThinkingSeparator, type ThinkingLevel } from "./BottomBar";
import type { SidebarTokens } from "./sidebar";

export type Mode = "vibe" | "dev";
const ESC_WINDOW_MS = 1500;
const EMPTY_TOKENS: SidebarTokens = { contextIn: 0, totalOut: 0, calls: 0 };

export interface ChatProps {
  session: AgentSession;
  mode: Mode;
  modelLabel: string;
  blocked?: boolean;
  filePreview?: "always" | "on-demand" | "none";
  onOpenCommands?: () => void;
  onCommand?: (text: string) => boolean;
  width?: number;
  inputFocused?: boolean;
  focusedChip?: number | null;
  tokens?: SidebarTokens;
  workflowOn?: boolean;
  memoryFresh?: boolean;
  thinkingLevel?: ThinkingLevel;
  livePhase?: string;
  notice?: string;
  submitSignal?: number;
  /** Repaint settled history in the alternate-screen modal buffer. */
  replaySettled?: boolean;
  /** Slash commands active for this context (workflow-aware completion).
   * Standalone mounts default to the base list from the registry. */
  commands?: readonly string[];
}

/** Native-scrollback session screen (#183). Settled event blocks are emitted
 * exactly once through Static; only the open turn remains volatile above the
 * frameless input. */
export function Chat({
  session,
  mode,
  modelLabel,
  blocked = false,
  filePreview = "on-demand",
  onOpenCommands,
  onCommand,
  width,
  inputFocused = true,
  focusedChip = null,
  tokens = EMPTY_TOKENS,
  workflowOn = false,
  memoryFresh = false,
  thinkingLevel = "medium",
  livePhase,
  notice,
  submitSignal = 0,
  replaySettled = false,
  commands = BASE_COMMANDS.map((command) => `/${command.name}`),
}: ChatProps) {
  const state = useSessionState(session);
  const viewport = useViewport();
  const cols = width ?? viewport.columns;
  const compact = widthClass(viewport) === "compact";
  const [tick, setTick] = useState(0);
  const [lastEsc, setLastEsc] = useState(0);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!state.pending) return;
    const timer = setInterval(() => setTick((value) => value + 1), 90);
    return () => clearInterval(timer);
  }, [state.pending]);

  const { settledBlocks, liveBlocks } = useMemo(() => {
    let openTurnAt = -1;
    if (state.pending) for (let i = state.events.length - 1; i >= 0; i--) {
      if (state.events[i]!.type === "user_message") { openTurnAt = i; break; }
    }
    const settled = openTurnAt >= 0 ? state.events.slice(0, openTurnAt) : state.events;
    const live = openTurnAt >= 0 ? state.events.slice(openTurnAt) : [];
    return {
      settledBlocks: projectTranscript(settled, { filePreview }),
      liveBlocks: projectTranscript(live, { filePreview }),
    };
  }, [state.events, state.pending, filePreview]);
  const replayBlocks = useMemo(
    () => replaySettled ? transcriptTail(settledBlocks, cols, Math.max(1, viewport.rows - 9)) : settledBlocks,
    [replaySettled, settledBlocks, cols, viewport.rows],
  );
  const spinner = SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!;

  useInput((input, key) => {
    if (blocked || !inputFocused) return;
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

  return (
    <Box flexDirection="column" width={Math.max(1, cols - 1)}>
      {replaySettled ? replayBlocks.map((block) => (
        <TranscriptBlockView key={`replay-${block.key}`} block={block} width={cols} />
      )) : (
        <Static items={settledBlocks}>
          {(block) => <TranscriptBlockView key={block.key} block={block} width={cols} />}
        </Static>
      )}
      {state.pending && <Box flexDirection="column">{liveBlocks.map((block) => <TranscriptBlockView key={`live-${block.key}`} block={block} width={cols} />)}</Box>}

      <ThinkingSeparator level={thinkingLevel} width={cols} />
      <MultilineInput
        placeholder={compact ? "type…" : "type… (ctrl+j newline · ctrl+e editor)"}
        disabled={blocked}
        focused={inputFocused}
        onAskCommands={onOpenCommands}
        commands={commands}
        submitSignal={submitSignal}
        onSubmit={(text) => {
          if (onCommand?.(text)) return;
          void session.send(text);
        }}
      />
      <ThinkingSeparator level={thinkingLevel} width={cols} />
      <Box height={1} />
      <BottomBar
        width={cols}
        pending={state.pending}
        spinner={spinner}
        mode={mode}
        model={modelLabel}
        turns={state.turnCount}
        tokens={tokens}
        level={thinkingLevel}
        workflowOn={workflowOn}
        memoryFresh={memoryFresh}
        phase={armed ? "esc again to stop" : livePhase}
        notice={notice}
        focusedChip={focusedChip}
      />
    </Box>
  );
}

/** Tail projection for the alternate-screen modal background. It keeps the
 * newest complete blocks that fit above the live input instead of clipping
 * the current turn/status when a long session is replayed. */
export function transcriptTail(blocks: readonly TranscriptBlock[], width: number, rowBudget: number): TranscriptBlock[] {
  const selected: TranscriptBlock[] = [];
  let rows = 0;
  const bodyWidth = Math.max(1, width - 3);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    const blockRows = 2 + block.lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / bodyWidth)), 0);
    if (selected.length > 0 && rows + blockRows > rowBudget) break;
    selected.unshift(block);
    rows += blockRows;
  }
  return selected;
}
