import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, useInput, useStdout } from "ink";
import type { AgentEvent, AgentSession, ThinkingLevel } from "@moh/core";
import { useSessionState } from "./session-bridge";
import { useLiveReasoning } from "./live-reasoning";
import { SPINNER_FRAMES } from "./icons";
import { widthClass, useViewport } from "./viewport";
import { MultilineInput } from "./Input";
import { BASE_COMMANDS, type CommandEntry } from "./commands";
import { projectTranscript, closedPrefixLength, TranscriptBlockView, type TranscriptBlock } from "./transcript";
import { updateToolTimings, type ToolTimings } from "./tool-timing";
import { BottomBar, ThinkingSeparator, type DisplayThinkingLevel } from "./BottomBar";
import { useGitBranch } from "./git-branch";
import type { SidebarTokens } from "./sidebar";

export type Mode = "vibe" | "dev";
const ESC_WINDOW_MS = 1500;
const EMPTY_TOKENS: SidebarTokens = { contextIn: 0, totalOut: 0, calls: 0 };

export interface ChatProps {
  session: AgentSession;
  /** Working root (branch label + filesystem chrome read from here). */
  cwd: string;
  mode: Mode;
  modelLabel: string;
  blocked?: boolean;
  filePreview?: "always" | "on-demand" | "none";
  onOpenCommands?: () => void;
  /** Popup-open signal from the input (#: Tab defers to the completion
   * popup instead of cycling the footer chips). */
  onSuggestionsOpen?: (open: boolean) => void;
  onCommand?: (text: string) => boolean;
  width?: number;
  inputFocused?: boolean;
  focusedChip?: number | null;
  tokens?: SidebarTokens;
  /** Context-bar denominator (note 11): the active model's catalog window,
   * already defaulting to CONTEXT_WINDOW_DEFAULT at the caller. */
  contextLimit?: number;
  workflowOn?: boolean;
  memoryFresh?: boolean;
  thinkingLevel?: DisplayThinkingLevel;
  /** #256: an unsupported stored preference — surfaced as a small dim
   * marker next to the model ("✗⚙ <level>"), never a prompt. */
  unsupportedThinkingLevel?: ThinkingLevel;
  /** #242: render provider reasoning blocks (projection-only toggle; a
   * change repaints the transcript so historical reasoning appears). */
  showReasoning?: boolean;
  livePhase?: string;
  notice?: string;
  /** Git branch label override (tests); default: read from the session cwd. */
  branch?: string | null;
  submitSignal?: number;
  /** Repaint settled history in the alternate-screen modal buffer. */
  replaySettled?: boolean;
  /** Slash commands active for this context (workflow-aware completion)
   * with popup-facing descriptions and provenance markers. Standalone
   * mounts default to the base list from the registry. */
  commands?: readonly CommandEntry[];
}

/** Native-scrollback session screen (#183). Settled event blocks are emitted
 * exactly once through Static; only the open turn remains volatile above the
 * frameless input. */
export function Chat({
  session,
  cwd,
  mode,
  modelLabel,
  blocked = false,
  filePreview = "on-demand",
  onOpenCommands,
  onSuggestionsOpen,
  onCommand,
  width,
  inputFocused = true,
  focusedChip = null,
  tokens = EMPTY_TOKENS,
  contextLimit,
  workflowOn = false,
  memoryFresh = false,
  thinkingLevel = "medium",
  unsupportedThinkingLevel,
  showReasoning = false,
  livePhase,
  notice,
  submitSignal = 0,
  replaySettled = false,
  branch,
  commands = BASE_COMMANDS.map((command) => ({ name: `/${command.name}`, description: command.description, custom: false })),
}: ChatProps) {
  const state = useSessionState(session);
  // #253: live provider reasoning in the volatile area (display-gated in
  // the projection below: head-only indicator when reasoning display is
  // off — the text itself is never rendered then).
  const liveReasoning = useLiveReasoning(session, state.pending);
  const gitBranch = useGitBranch(cwd);
  const viewport = useViewport();
  const cols = width ?? viewport.columns;
  const compact = widthClass(viewport) === "compact";
  const [tick, setTick] = useState(0);
  const [lastEsc, setLastEsc] = useState(0);
  const [armed, setArmed] = useState(false);
  // Settled-history projection state (#193, superseded by #201): the
  // segments list now exists only for the repaint reset — every mode
  // switch rebuilds it from zero in the new grammar and remounts Static,
  // so stale print indices cannot survive a switch.
  interface Segment { base: number; mode: Mode; show: boolean }
  const sessionRef = useRef(session);
  const segmentsRef = useRef<Segment[]>([{ base: 0, mode, show: showReasoning }]);
  if (sessionRef.current !== session) {
    sessionRef.current = session;
    segmentsRef.current = [{ base: 0, mode, show: showReasoning }];
  }
  const settledEnd = useMemo((): number => settledBoundary(state.events, state.pending), [state.events, state.pending]);
  // #300: wall-clock ledger for tool calls — arrival time per live call,
  // final call→result duration once the result lands. Presentation-only
  // (never merged into the log); advanced incrementally from the cursor
  // so an open call keeps its original arrival and durations measure the
  // real batch gap.
  const toolTimingsRef = useRef<ToolTimings>(new Map());
  const toolTimingsCursor = useRef(0);
  if (state.events.length > toolTimingsCursor.current) {
    const advanced = updateToolTimings(toolTimingsRef.current, state.events, toolTimingsCursor.current);
    toolTimingsRef.current = advanced.timings;
    toolTimingsCursor.current = advanced.scanned;
  }
  const toolTimings = toolTimingsRef.current;
  // Mode switch repaints (#201): the printed grammar is no longer sealed —
  // the visible transcript is cleared and reprinted whole in the new mode.
  // A pending repaint waits while a modal owns the alternate screen; it
  // fires on close, before anything else settles into scrollback.
  const { stdout } = useStdout();
  const [repaint, setRepaint] = useState(0);
  const modeRef = useRef(mode);
  const repaintRef = useRef(false);
  if (mode !== modeRef.current) {
    modeRef.current = mode;
    repaintRef.current = true;
  }
  // #242: display toggling is an immediate whole-transcript reprojection —
  // already-promoted (Static) blocks were printed under the old setting,
  // so enabling display repaints to surface historical reasoning.
  const showRef = useRef(showReasoning);
  if (showReasoning !== showRef.current) {
    showRef.current = showReasoning;
    repaintRef.current = true;
  }
  useEffect(() => {
    if (!repaintRef.current || replaySettled || blocked) return;
    repaintRef.current = false;
    segmentsRef.current = [{ base: 0, mode, show: showReasoning }];
    // Clear screen + scrollback, cursor home: the whole visible transcript
    // (including anything printed before moh) goes away by owner decision.
    stdout.write("\x1b[H\x1b[2J\x1b[3J");
    setRepaint((value) => value + 1);
  }, [mode, showReasoning, replaySettled, blocked, stdout]);

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
      { filePreview, mode: segment.mode, keyBase: segment.base, showReasoning: segment.show, toolTimings },
    ));
    const live = settledEnd < state.events.length ? state.events.slice(settledEnd) : [];
    // The live tail often begins mid-reply (the boundary closed a paragraph
    // inside a delta run): its first paragraph is a continuation of the
    // reply already printed above, not a new headed block (#205).
    const proseContinuation = settledEnd > 0 && state.events[settledEnd - 1]?.type === "assistant_delta";
    // #253: the live reasoning block leads the volatile area while (or
    // just after) the model thinks — frozen at reasoning_end until the
    // settled, model-labelled block takes over from the log.
    const liveReasoningBlock: TranscriptBlock[] = liveReasoning
      ? [{
          key: "live-reasoning",
          kind: "thinking",
          glyph: "⋯",
          type: "thinking",
          ...(liveReasoning.active ? { detail: "…", state: "run" as const } : {}),
          lines: showReasoning ? liveReasoning.text.split("\n") : [],
        }]
      : [];
    return {
      settledBlocks,
      liveBlocks: [...liveReasoningBlock, ...projectTranscript(live, { filePreview, mode, keyBase: settledEnd, proseContinuation, showReasoning, toolTimings })],
    };
  }, [state.events, settledEnd, filePreview, mode, showReasoning, repaint, liveReasoning, toolTimings]);
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
        <Static key={repaint} items={staticItems as TranscriptBlock[]}>
          {(block) => <TranscriptBlockView key={block.key} block={block} width={cols} />}
        </Static>
      {replaySettled && replayBlocks.map((block) => (
        <TranscriptBlockView key={`replay-${block.key}`} block={block} width={cols} />
      ))}
      {state.pending && <Box flexDirection="column">{liveTail.map((block) => (
        <TranscriptBlockView
          key={`live-${block.key}`}
          block={block}
          width={cols}
          {...(block.callId !== undefined && block.durationMs === undefined && toolTimings.get(block.callId)?.at !== undefined
            ? { liveMeta: { elapsedMs: Date.now() - toolTimings.get(block.callId)!.at, timeoutMs: block.timeoutMs } }
            : {})}
        />
      ))}</Box>}

      <ThinkingSeparator level={thinkingLevel} width={cols} />
      <MultilineInput
        placeholder={compact ? "type…" : "type… (shift+enter newline · ctrl+a/e line start/end)"}
        disabled={blocked}
        focused={inputFocused}
        onAskCommands={onOpenCommands}
        commands={commands}
        onSuggestionsOpen={onSuggestionsOpen}
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
        contextLimit={contextLimit}
        level={thinkingLevel}
        unsupportedLevel={unsupportedThinkingLevel}
        workflowOn={workflowOn}
        memoryFresh={memoryFresh}
        phase={armed ? "esc again to stop" : livePhase}
        notice={notice}
        branch={branch ?? gitBranch}
        cwd={cwd}
        focusedChip={focusedChip}
      />
    </Box>
  );
}

/** Incremental promotion boundary (#194): while a turn is pending, the
 * settled/live split is not the turn start (the user_message) but the end
 * of the last *closed* prefix of the open turn — every tool_call in it has
 * its tool_result, streaming prose closes paragraph-by-paragraph, and no
 * volatile-tail event crosses it. Blocks that mutate in place (pending
 * tool_call ◌→✓, ask_user awaiting its answer, a still-growing code fence)
 * stay volatile until complete; each closed block scrolls into native
 * scrollback as soon as it closes, keeping the volatile region
 * viewport-small (#188 stays flat). Monotonic while pending: appended
 * events can only close prefixes, never reopen one. */
export function settledBoundary(events: readonly AgentEvent[], pending: boolean): number {
  if (!pending) return events.length;
  let turnStart = events.length;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === "user_message") { turnStart = i; break; }
  }
  let pendingCalls = 0;
  let boundary = turnStart + 1;
  // Streaming prose promotes segment-by-segment using the same closing rules
  // as the transcript projection (#205): a blank line outside any code fence
  // (loose-list blank lines do not close), or a closing fence. The shared
  // `closedPrefixLength` guarantees a promoted prefix never mutates after
  // ink prints it.
  let deltaRun = "";
  for (let i = turnStart + 1; i < events.length; i++) {
    const event = events[i]!;
    if (event.type === "assistant_delta") {
      deltaRun += event.text;
      if (closedPrefixLength(deltaRun) === deltaRun.length) boundary = i + 1;
      continue;
    }
    deltaRun = "";
    if (event.type === "tool_call") {
      // The call-level fallback/reasoning/model_call prefix immediately
      // before a tool is immutable now; promote it without the unresolved
      // tool_call whose ◌ state still mutates.
      if (pendingCalls === 0) boundary = i;
      pendingCalls++;
      continue;
    }
    // Clamp: a stray result without its call must not under-count and
    // over-promote a prefix.
    if (event.type === "tool_result" && pendingCalls > 0) pendingCalls--;
    if (pendingCalls > 0) continue;
    // #242: these events form one projection unit. Do not seal a reasoning
    // block before its model label arrives, or a model_call before the next
    // event proves whether it failed. Fallback also stays beside the failed
    // call it announces instead of being sliced away from its error state.
    if (event.type === "fallback" || event.type === "reasoning" || event.type === "model_call") continue;
    boundary = i + 1;
  }
  return boundary;
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
    // A streaming response is commonly one giant prose block (GLM-5.6
    // emitted 220+ deltas without a paragraph break, #201). Keeping that
    // one block whole bypasses the block-level budget and makes Ink rewrite
    // hundreds of rows every frame — text flashes/disappears in Terminal.
    // Clip its tail at line/character granularity instead.
    if (selected.length === 0 && blockRows > rowBudget) return [clipBlockTail(block, bodyWidth, rowBudget)];
    if (selected.length > 0 && rows + blockRows > rowBudget) break;
    selected.unshift(block);
    rows += blockRows;
  }
  return selected;
}

/** Makes one too-tall block fit its transcript-tail budget. The header and
 * trailing gap cost two rows; the body retains its newest lines (or the tail
 * of one wrapped line) so an active stream remains bounded even before it
 * reaches a semantic paragraph boundary. */
function clipBlockTail(block: TranscriptBlock, bodyWidth: number, rowBudget: number): TranscriptBlock {
  let remaining = Math.max(0, rowBudget - 2);
  const picked: Array<{ line: string; kind?: NonNullable<TranscriptBlock["lineKinds"]>[number] }> = [];
  let clipped = false;
  for (let i = block.lines.length - 1; i >= 0 && remaining > 0; i--) {
    const line = block.lines[i]!;
    const lineRows = Math.max(1, Math.ceil(line.length / bodyWidth));
    const kind = block.lineKinds?.[i];
    if (lineRows <= remaining) {
      picked.unshift({ line, kind });
      remaining -= lineRows;
      continue;
    }
    const chars = Math.max(1, remaining * bodyWidth);
    const tail = line.length > chars
      ? chars === 1 ? "…" : `…${line.slice(-(chars - 1))}`
      : line;
    picked.unshift({ line: tail, kind });
    remaining = 0;
    clipped = true;
  }
  if (picked.length < block.lines.length) clipped = true;
  if (clipped && remaining > 0) picked.unshift({ line: "…", kind: "body" });
  const lines = picked.map((entry) => entry.line);
  return {
    ...block,
    lines,
    // prose blocks may render through the terminal Markdown path; keep that
    // source in lockstep with the clipped lines or it bypasses this cap.
    ...(block.markdown ? { markdown: lines.join("\n") } : {}),
    ...(block.lineKinds ? { lineKinds: picked.map((entry) => entry.kind ?? "body") } : {}),
  };
}
