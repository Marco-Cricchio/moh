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
import { AskUserBlock, askUserBlockRows } from "./AskUserBlock";
import type { AskUserGate } from "./ask-user-gate";
import { useGitBranch } from "./git-branch";
import type { SidebarTokens } from "./sidebar";

export type Mode = "vibe" | "dev";
const ESC_WINDOW_MS = 1500;
/** #329: debounce for the width-change transcript rebuild. */
const RESIZE_REBUILD_DELAY_MS = 150;
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
  /** #328: active update notice, rendered left-aligned on status-bar row 2
   * (the cwd/branch/mode tail stays right-aligned on the same row). */
  updateMessage?: string;
  /** Git branch label override (tests); default: read from the session cwd. */
  branch?: string | null;
  /** #377: yolo session (launch-only) — persistent ⚠ YOLO status indicator. */
  yolo?: boolean;
  submitSignal?: number;
  /** Unsent external composer draft. */
  prefill?: string;
  /** Repaint settled history in the alternate-screen modal buffer. */
  replaySettled?: boolean;
  /** ADR-0019 / #412: the pending ask_user question set — rendered as an
   * inline block between the text area and bottom-bar row 1, no modal. */
  askGate?: AskUserGate;
  /** #330: an alternate→main buffer flip is in flight (modal just closed,
  * flip timer pending). A deferred whole-transcript repaint must wait it
  * out — firing concurrently lands its Static re-emission in the dying
  * alternate buffer and blanks the chat. */
  bufferFlipPending?: boolean;
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
  updateMessage,
  submitSignal = 0,
  prefill,
  replaySettled = false,
  askGate,
  bufferFlipPending = false,
  branch,
  yolo = false,
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
  // #329: incremental Static promotion state for the live-reasoning head
  // (see the state machine further down and nextReasoningHead).
  const reasoningChainRef = useRef<ReasoningHeadChain | null>(null);
  const reasoningHeadsRef = useRef(new Map<string, SealedReasoningHead>());
  const assembledCountRef = useRef(0);
  const sessionRef = useRef(session);
  const segmentsRef = useRef<Segment[]>([{ base: 0, mode, show: showReasoning }]);
  if (sessionRef.current !== session) {
    sessionRef.current = session;
    segmentsRef.current = [{ base: 0, mode, show: showReasoning }];
    // #329: head chains belong to the previous session's event log; their
    // `${index}-reasoning` keys would collide with the new projection.
    reasoningChainRef.current = null;
    reasoningHeadsRef.current.clear();
  }
  // #326: the hold shrinks settledEnd while paragraphs already promoted
  // under display-off would sit before the reasoning group — safe because a
  // showReasoning toggle always forces the whole-transcript repaint below
  // (clear + remount), which reprints everything in the new order.
  const settledEnd = useMemo((): number => settledBoundary(state.events, state.pending, { holdReplyForReasoning: showReasoning }), [state.events, state.pending, showReasoning]);
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
  // A pending repaint waits while a modal owns the alternate screen; on
  // close it also waits out the buffer flip (#330) so the re-emission
  // lands in the main buffer, before anything else settles into
  // scrollback.
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
  // #329: incremental Static promotion of the live-reasoning head — the
  // chain state machine further down promotes everything except the last
  // REASONING_TAIL_LINES lines of the streaming thinking block into Static
  // as immutable chunks (pi-style: lines past the screen scroll into
  // scrollback once), so the volatile region ink fully rewrites each frame
  // stays tiny. Promotion is render-side chunking of the same live text —
  // the projection stays a pure function of the log (#194): when the
  // settled, model-labelled block seals, its promoted lines are deduplicated
  // (`reasoningHeadsRef`, declared above) so Static prints only the remainder.
  const [widthTick, setWidthTick] = useState(0);
  const colsRef = useRef<number | null>(null);
  // Only real terminal resizes (SIGWINCH → stdout "resize") trigger the
  // rebuild: hosts that poke `columns` without an event (test stubs) keep
  // the old behavior.
  const sawResizeRef = useRef(false);
  const [resizeTick, setResizeTick] = useState(0);
  useEffect(() => {
    const onResize = () => {
      sawResizeRef.current = true;
      setResizeTick((value) => value + 1);
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  useEffect(() => {
    if (colsRef.current === null) {
      colsRef.current = cols;
      return;
    }
    if (colsRef.current === cols || !sawResizeRef.current) return;
    // #329: a width change re-wraps every printed row, so the transcript
    // is rebuilt rather than patched: debounced (height-only resizes never
    // pass the columns check), the screen + scrollback are cleared and the
    // chat tree remounts so Static reprints the whole transcript at the new
    // width. Accepted cost: the scroll position resets (rare,
    // user-initiated; no content loss — everything is reprinted from the
    // projection).
    const timer = setTimeout(() => {
      sawResizeRef.current = false;
      colsRef.current = cols;
      repaintRef.current = true;
      setWidthTick((value) => value + 1);
    }, RESIZE_REBUILD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [cols, resizeTick]);
  useEffect(() => {
    if (!repaintRef.current || replaySettled || blocked || bufferFlipPending) return;
    repaintRef.current = false;
    segmentsRef.current = [{ base: 0, mode, show: showReasoning }];
    reasoningChainRef.current = null;
    reasoningHeadsRef.current.clear();
    // Clear screen + scrollback, cursor home: the whole visible transcript
    // (including anything printed before moh) goes away by owner decision.
    stdout.write("\x1b[H\x1b[2J\x1b[3J");
    setRepaint((value) => value + 1);
  }, [mode, showReasoning, replaySettled, blocked, bufferFlipPending, stdout, widthTick]);

  useEffect(() => {
    // While a modal owns the input (ask/permission), the turn is parked
    // on the user — no spinner, so ticks stop re-rendering behind the
    // overlay (large-turn regression, session 20260825T062108113Z).
    if (blocked || !state.pending) return;
    const timer = setInterval(() => setTick((value) => value + 1), 90);
    return () => clearInterval(timer);
  }, [blocked, state.pending]);

  // ── Settled + live projection with #329 head promotion ────────────────
  // The raw live projection comes first (untrimmed): the head chain state
  // machine below must see the full thinking block before anything trims
  // it, and the settled memo must observe the chain's seal decisions made
  // in this same render.
  const rawLiveBlocks = useMemo((): readonly TranscriptBlock[] => {
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
    return [...liveReasoningBlock, ...projectTranscript(live, { filePreview, mode, keyBase: settledEnd, proseContinuation, showReasoning, toolTimings })];
  }, [state.events, settledEnd, filePreview, mode, showReasoning, liveReasoning, toolTimings]);
  // Head chain state machine (#329): track the leading thinking block —
  // the chain follows it across the live→log handover (same text, new
  // key) and promotes its head line-by-line into Static chunks. Promotion
  // pauses while a modal owns the alternate screen (frozen Static cannot
  // print the chunks; the viewport tail cap bounds the region meanwhile).
  {
    const thinkingBlocks = rawLiveBlocks.filter((block) => block.kind === "thinking" && block.lines.length > 0);
    const chain = reasoningChainRef.current;
    const tracked = chain ? thinkingBlocks.find((block) => block.key === chain.key) : undefined;
    const thinking = tracked ?? thinkingBlocks.at(-1) ?? null;
    if (thinking) {
      const previous = reasoningChainRef.current;
      const advanced = nextReasoningHead(previous, thinking.key, thinking.lines);
      // The chunks' Static insertion index is captured when the FIRST chunk
      // is promoted, at the settled length of the previous render: every
      // already-printed block stays before the chunks and later-settling
      // blocks append after them, so chunk indices never shift (ink's
      // Static counter only moves forward — an item pushed past it would
      // be reprinted, one duplication per seal).
      if (advanced.chunks.length > 0 && (previous?.chunks.length ?? 0) === 0) {
        advanced.startIndex = assembledCountRef.current;
      }
      reasoningChainRef.current = replaySettled
        ? (previous ?? advanced)
        : advanced;
    } else if (chain) {
      // The tracked thinking block left the volatile area. A log-keyed
      // chain seals against its settled block (dedup). A live channel
      // chain maps onto the newest persisted reasoning event so the
      // settled block still dedups the printed chunks — but the bridge
      // state can lag the live channel (the live block clears before the
      // `reasoning` event reaches state.events), so while the turn is
      // still pending the chain is HELD until the log catches up: the
      // handover or this seal then sees the event. If the turn ends
      // without persisting (abort), the chunks simply stay printed.
      let sealedKey: string | null = null;
      if (chain.key !== "live-reasoning") {
        sealedKey = chain.key;
      } else {
        for (let i = Math.min(settledEnd, state.events.length) - 1; i >= 0; i--) {
          if (state.events[i]!.type !== "reasoning") continue;
          const key = `${i}-reasoning`;
          if (!reasoningHeadsRef.current.has(key)) sealedKey = key;
          break;
        }
      }
      if (sealedKey !== null) {
        reasoningHeadsRef.current.set(sealedKey, { chunks: chain.chunks, lines: chain.lines, startIndex: chain.startIndex });
      }
      if (sealedKey !== null || !state.pending) reasoningChainRef.current = null;
    }
  }
  const activeChain = reasoningChainRef.current;
  const liveBlocks: readonly TranscriptBlock[] = activeChain && activeChain.lines > 0
    ? rawLiveBlocks.map((block) => block.key === activeChain.key
      ? { ...block, lines: block.lines.slice(activeChain.lines), continuation: true }
      : block)
    : rawLiveBlocks;
  const settledBlocks = useMemo((): readonly TranscriptBlock[] => {
    const segments = segmentsRef.current.filter((segment, index) =>
      segment.base < (segmentsRef.current[index + 1]?.base ?? settledEnd));
    return embedReasoningHeads(segments.flatMap((segment, index) => projectTranscript(
      state.events.slice(segment.base, segmentsRef.current[index + 1]?.base ?? settledEnd),
      { filePreview, mode: segment.mode, keyBase: segment.base, showReasoning: segment.show, toolTimings },
    )), reasoningHeadsRef.current);
  }, [state.events, settledEnd, filePreview, mode, showReasoning, repaint, toolTimings]);
  const replayBlocks = useMemo(
    () => replaySettled ? transcriptTail(settledBlocks, cols, Math.max(1, viewport.rows - 9)) : settledBlocks,
    [replaySettled, settledBlocks, cols, viewport.rows],
  );
  // The volatile area is tail-capped to the viewport: ink rewrites the whole
  // interactive region every frame (no row diffing — that is what Static is
  // for), so an uncapped open turn rewrites hundreds of rows per frame —
  // O(n²) output that froze keypress handling and ballooned memory until the
  // OS killed the process (session 20260825T062108113Z).
  // #413: while the inline ask_user block is open, the volatile ask_user
  // tool_call projects compactly (one row per question, no answers yet)
  // instead of being suppressed: the block below grows dynamically and can
  // compress this tail, but the pending call itself stays visible (its
  // ◌→✓ mutation is what settledBoundary keeps volatile). Once resolved,
  // the settled projection carries the answer rows into Static.
  const askOpen = askGate !== undefined && askGate.current !== null;
  // #413: the block's row height shrinks the volatile transcript budget so
  // the block can grow to compress the transcript (frameless, #183). A
  // 1-row floor keeps a scrolling tail visible at any size.
  const askBudget = askOpen
    ? Math.max(1, viewport.rows - 9 - askUserBlockRows(askGate!.current!.questions))
    : undefined;
  const liveTail = useMemo(
    () => transcriptTail(liveBlocks, cols, askBudget ?? Math.max(1, viewport.rows - 9)),
    [liveBlocks, cols, viewport.rows, askBudget],
  );
  // #329: the head chunks (open chain and sealed chains) ride the Static
  // items at their recorded insertion indices — never through the settled
  // projection — so their positions never shift and ink's forward-only
  // Static counter sees only genuinely new items at the end. Whole-
  // transcript reprints still read chronologically: each chunk group sits
  // right after the blocks that were settled when it started streaming.
  const assembledSettled: readonly TranscriptBlock[] = spliceReasoningChunks(
    settledBlocks,
    [...reasoningHeadsRef.current.values(), ...(activeChain ? [activeChain] : [])],
  );
  assembledCountRef.current = assembledSettled.length;
  // Static must stay MOUNTED across modal cycles: unmounting it (the old
  // alternate-screen swap) reset ink's internal printed-items counter, so
  // every remount reprinted the whole settled transcript into the main
  // buffer — one duplicate per opened modal. While replaySettled, freeze
  // the items so Static emits nothing into the alternate buffer; on close
  // it resumes and prints only items settled in the meantime.
  const frozenRef = useRef<readonly TranscriptBlock[] | null>(null);
  let staticItems: readonly TranscriptBlock[];
  if (replaySettled) {
    if (frozenRef.current === null) frozenRef.current = assembledSettled;
    staticItems = frozenRef.current;
  } else {
    frozenRef.current = null;
    staticItems = assembledSettled;
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
        prefill={prefill}
        onSubmit={(text) => {
          if (onCommand?.(text)) return;
          void session.send(text);
        }}
      />
      {/* #412: inline ask_user block — one blank line of padding above and
          below (inside AskUserBlock), between the text area and row 1. */}
      {askGate && askGate.current && <AskUserBlock gate={askGate} width={cols} />}
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
        updateMessage={updateMessage}
        branch={branch ?? gitBranch}
        cwd={cwd}
        yolo={yolo}
        focusedChip={focusedChip}
      />
    </Box>
  );
}

/** Lines of live reasoning kept volatile below the promoted head (#329). */
export const REASONING_TAIL_LINES = 5;

/** One open live-reasoning promotion chain (#329): the volatile
 * thinking-block key being tracked ("live-reasoning" while the live
 * channel streams, the log key after the handover), how many of its lines
 * are already promoted into Static, and the immutable chunks printed so
 * far. */
export interface ReasoningHeadChain {
  key: string;
  lines: number;
  chunks: TranscriptBlock[];
  /** #329: settledBlocks length when the chain opened — the stable Static
   * insertion index for the chunks (see Chat). Set by the caller. */
  startIndex: number;
}

/** A sealed chain (#329): the chunks printed for a settled reasoning block,
 * how many of its lines they cover, and where they sit in the Static items —
 * the settled block prints only the remainder, so a long reasoning stream
 * lands in scrollback exactly once. */
export type SealedReasoningHead = Omit<ReasoningHeadChain, "key">;

/** One #329 promotion step. Pure: takes the current chain and the leading
 * thinking block (key + lines), returns the advanced chain. Only lines past
 * the tail budget are promoted, each as a never-mutating Static chunk — the
 * first chunk carries the block head ("⋯ thinking …"), later ones render as
 * continuations. A key change from "live-reasoning" is the handover to the
 * settled, model-labelled block (same text, new key): the promoted prefix is
 * kept. Any other key change starts a fresh chain. */
export function nextReasoningHead(
  chain: ReasoningHeadChain | null,
  key: string,
  lines: readonly string[],
  tailLines = REASONING_TAIL_LINES,
): ReasoningHeadChain {
  let next: ReasoningHeadChain;
  if (!chain) next = { key, lines: 0, chunks: [], startIndex: 0 };
  else if (chain.key === key) next = chain;
  else if (chain.key === "live-reasoning") next = { ...chain, key, chunks: [...chain.chunks] };
  else next = { key, lines: 0, chunks: [], startIndex: 0 };
  // The block may shrink (multi-part reasoning resets the live buffer,
  // #240): clamp so promotion resumes from the new content.
  if (lines.length < next.lines) next = { ...next, lines: lines.length };
  const promotable = lines.length - tailLines - next.lines;
  if (promotable <= 0) return next;
  const slice = lines.slice(next.lines, next.lines + promotable);
  return {
    ...next,
    lines: next.lines + slice.length,
    chunks: [...next.chunks, {
      key: `${key}-head-${next.chunks.length}`,
      kind: "thinking",
      glyph: "⋯",
      type: "thinking",
      ...(next.chunks.length === 0 ? { detail: "…" } : { continuation: true }),
      lines: [...slice],
    }],
  };
}

/** Dedups sealed #329 chains against the settled projection: each block
 * with a head keeps only its un-promoted lines, so Static never reprints
 * lines already in scrollback. The chunks themselves are NOT spliced here —
 * they ride the Static items at their stable index (spliceReasoningChunks):
 * moving them through the projection would shift already-printed items
 * around ink's forward-only Static counter, reprinting or losing rows. */
export function embedReasoningHeads(
  blocks: readonly TranscriptBlock[],
  heads: ReadonlyMap<string, SealedReasoningHead>,
): TranscriptBlock[] {
  if (heads.size === 0) return [...blocks];
  const deduped: TranscriptBlock[] = [];
  for (const block of blocks) {
    const head = heads.get(block.key);
    deduped.push(head ? { ...block, lines: block.lines.slice(head.lines) } : block);
  }
  return deduped;
}

/** Splices #329 head chunks into the Static items at their recorded indices.
 * Inserts run in ascending index order: each chunk group was recorded in
 * assembled coordinates that already include every earlier group, so the
 * positions line up as the array grows. */
export function spliceReasoningChunks(
  blocks: readonly TranscriptBlock[],
  inserts: ReadonlyArray<{ startIndex: number; chunks: readonly TranscriptBlock[] }>,
): TranscriptBlock[] {
  const active = inserts.filter((insert) => insert.chunks.length > 0);
  if (active.length === 0) return [...blocks];
  const spliced = [...blocks];
  for (const insert of [...active].sort((a, b) => a.startIndex - b.startIndex)) {
    spliced.splice(Math.min(insert.startIndex, spliced.length), 0, ...insert.chunks);
  }
  return spliced;
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
export function settledBoundary(
  events: readonly AgentEvent[],
  pending: boolean,
  options: { /** #326: hold an open assistant reply volatile until its call's
   * reasoning/model_call group seals. Required when reasoning display is on:
   * the projection renders the group ABOVE the reply, so the reply's
   * paragraphs must not promote into Static before the group exists —
   * otherwise the thinking block would be inserted before already-printed
   * items, which ink's forward-only Static would silently skip. With the
   * hold, run + group settle together (append-only), and the reply promotes
   * at call end (or at the tool call that follows) instead of
   * paragraph-by-paragraph. */ holdReplyForReasoning?: boolean } = {},
): number {
  if (!pending) return events.length;
  const hold = options.holdReplyForReasoning === true;
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
      // #326: with the hold, a streaming reply never promotes mid-run —
      // only whole, at the event that seals its call's group (see above).
      if (!hold && closedPrefixLength(deltaRun) === deltaRun.length) boundary = i + 1;
      continue;
    }
    deltaRun = "";
    if (event.type === "tool_call" || event.type === "subagent_spawn") {
      // The call-level fallback/reasoning/model_call prefix immediately
      // before a tool is immutable now; promote it without the unresolved
      // tool_call whose ◌ state still mutates. A pending subagent_spawn
      // mutates the same way (running → final, #320).
      if (pendingCalls === 0) boundary = i;
      pendingCalls++;
      continue;
    }
    // Clamp: a stray result without its call must not under-count and
    // over-promote a prefix.
    if ((event.type === "tool_result" || event.type === "subagent_result") && pendingCalls > 0) pendingCalls--;
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
