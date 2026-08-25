import React, { useEffect, useMemo, useRef, useState } from "react";
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
  // A projection switch (vibe ↔ dev) cannot retro-filter scrollback: what
  // ink already printed keeps its form — exactly how a theme switch
  // behaves. Removing printed blocks would corrupt Static's index (ink
  // skips misaligned items and new blocks fall below the old counter).
  // So the settled history is segmented: each mode switch starts a new
  // segment at the current seal boundary; segments keep their grammar
  // forever and concatenate into one stable `items` array (#193).
  interface Segment { base: number; mode: Mode }
  const sessionRef = useRef(session);
  const segmentsRef = useRef<Segment[]>([{ base: 0, mode }]);
  if (sessionRef.current !== session) {
    sessionRef.current = session;
    segmentsRef.current = [{ base: 0, mode }];
  }
  const settledEnd = useMemo((): number => {
    if (!state.pending) return state.events.length;
    for (let i = state.events.length - 1; i >= 0; i--) {
      if (state.events[i]!.type === "user_message") return i;
    }
    return state.events.length;
  }, [state.events, state.pending]);
  const modeRef = useRef(mode);
  if (mode !== modeRef.current) {
    modeRef.current = mode;
    const last = segmentsRef.current[segmentsRef.current.length - 1]!;
    if (last.mode !== mode) segmentsRef.current.push({ base: settledEnd, mode });
  }

  useEffect(() => {
    // While a modal owns the input (ask/permission), the turn is parked
    // on the user — no spinner, so ticks stop re-rendering behind the
    // overlay (large-turn regression, session 20260825T062108113Z).
    if (blocked || !state.pending) return;
    const timer = setInterval(() => setTick((value) => value + 1), 90);
    return () => clearInterval(timer);
  }, [blocked, state.pending]);

  const { settledBlocks, liveBlocks } = useMemo((): { settledBlocks: readonly TranscriptBlock[]; liveBlocks: readonly TranscriptBlock[] } => {
    const segments = segmentsRef.current.filter((segment, index) =>
      segment.base < (segmentsRef.current[index + 1]?.base ?? settledEnd));
    const settledBlocks = segments.flatMap((segment, index) => projectTranscript(
      state.events.slice(segment.base, segmentsRef.current[index + 1]?.base ?? settledEnd),
      { filePreview, mode: segment.mode, keyBase: segment.base },
    ));
    const live = settledEnd < state.events.length ? state.events.slice(settledEnd) : [];
    return {
      settledBlocks,
      liveBlocks: projectTranscript(live, { filePreview, mode, keyBase: settledEnd }),
    };
  }, [state.events, settledEnd, filePreview, mode]);
  const replayBlocks = useMemo(
    () => replaySettled ? transcriptTail(settledBlocks, cols, Math.max(1, viewport.rows - 9)) : settledBlocks,
    [replaySettled, settledBlocks, cols, viewport.rows],
  );
  // The volatile area is tail-capped to the viewport: ink rewrites the whole
  // interactive region every frame (no row diffing — that is what Static is
  // for), so an uncapped open turn rewrites hundreds of rows per frame —
  // O(n²) output that froze keypress handling and ballooned memory until the
  // OS killed the process (session 20260825T062108113Z).
  const liveTail = useMemo(
    () => transcriptTail(liveBlocks, cols, Math.max(1, viewport.rows - 9)),
    [liveBlocks, cols, viewport.rows],
  );
  // Static must stay MOUNTED across modal cycles: unmounting it (the old
  // alternate-screen swap) reset ink's internal printed-items counter, so
  // every remount reprinted the whole settled transcript into the main
  // buffer — one duplicate per opened modal. While replaySettled, freeze
  // the items so Static emits nothing into the alternate buffer; on close
  // it resumes and prints only items settled in the meantime.
  const frozenRef = useRef<readonly TranscriptBlock[] | null>(null);
  let staticItems: readonly TranscriptBlock[];
  if (replaySettled) {
    if (frozenRef.current === null) frozenRef.current = settledBlocks;
    staticItems = frozenRef.current;
  } else {
    frozenRef.current = null;
    staticItems = settledBlocks;
  }
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
        <Static items={staticItems as TranscriptBlock[]}>
          {(block) => <TranscriptBlockView key={block.key} block={block} width={cols} />}
        </Static>
      {replaySettled && replayBlocks.map((block) => (
        <TranscriptBlockView key={`replay-${block.key}`} block={block} width={cols} />
      ))}
      {state.pending && <Box flexDirection="column">{liveTail.map((block) => <TranscriptBlockView key={`live-${block.key}`} block={block} width={cols} />)}</Box>}

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
