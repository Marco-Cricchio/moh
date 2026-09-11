import React, { useEffect, useMemo, useRef, useState } from "react";
import { deletePlacement, emitImage, type ImagePreviewMode } from "./image-preview";
import { Box, Static, Text, useInput, useStdout } from "ink";
import type { AgentEvent, AgentSession, ThinkingLevel } from "@moh/core";
import { useSessionState } from "./session-bridge";
import { createMarkdownRenderer, renderMarkdownRows } from "./markdown";
import { useTheme } from "./themes";
import { useLiveReasoning } from "./live-reasoning";
import { useToolProgress } from "./tool-progress";
import { SPINNER_FRAMES } from "./icons";
import { widthClass, useViewport } from "./viewport";
import { sanitizeLine, truncate } from "./ui";
import { MultilineInput, pasteAsPath } from "./Input";
import { BASE_COMMANDS, type CommandEntry } from "./commands";
import { projectTranscript, assistantRunOrigin, closedPrefixLength, TranscriptBlockView, type TranscriptBlock } from "./transcript";
import { updateToolTimings, type ToolTimings } from "./tool-timing";
import { BottomBar, ThinkingSeparator, type DisplayThinkingLevel } from "./BottomBar";
import {
  trackSubagents,
  useSubagentTails,
  useVisibleSubagents,
  subagentGlyph,
  type TrackedSubagent,
} from "./subagent-panel";
import { SubagentPanel } from "./SubagentPanel";
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
  /** #488: file paths for the `@` fuzzy popup (relative to cwd). */
  mentionCandidates?: readonly string[];
  /** Vision note 4 (#490): paste seam — an existing path pastes as an
   * `@path` mention (drag-and-drop). Optional; absent disables conversion. */
  onPastePath?: (paste: string) => string | null;
  /** Vision note 4 (#490): the resolved preview protocol (caller computes
   * once from the `images.preview` setting + environment). */
  previewMode?: ImagePreviewMode;
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
  /** #466/ADR-0022: sticky compaction-failure indicator. */
  compactionFailed?: boolean;
  /** #468/ADR-0020: sticky growth-warning incident count (null = none). */
  growthWarning?: number | null;
  /** #581: the keep-my-branch primary chip (recovery action over the
   * core switch seam) — rendered next to the growth warning. */
  onKeepMyBranch?: () => void;
  /** #581: sticky branch-from-here banner label — the next sent message
   * starts a new branch at that node (dismissed by the send). */
  branchFrom?: string | null;
  /** #581: clears the branch-from-here banner (called on submit). */
  onBranchFromDismiss?: () => void;
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
  /** #497: index of the focused subagent chip (head of the chip cycle),
   * or null when no subagent chip holds focus. */
  focusedSubagent?: number | null;
  /** #497: index of the subagent whose live panel is open (null = closed). */
  panelSubagent?: number | null;
  /** #497: toggles the selected subagent's live panel (Enter on a chip). */
  onToggleSubagentPanel?: (index: number) => void;
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
  mentionCandidates,
  onPastePath,
  previewMode = { protocol: "none" },
  onCommand,
  width,
  inputFocused = true,
  focusedChip = null,
  tokens = EMPTY_TOKENS,
  contextLimit,
  workflowOn = false,
  memoryFresh = false,
  compactionFailed = false,
  growthWarning = null,
  onKeepMyBranch,
  branchFrom = null,
  onBranchFromDismiss,
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
  focusedSubagent = null,
  panelSubagent = null,
  onToggleSubagentPanel,
  branch,
  yolo = false,
  commands = BASE_COMMANDS.map((command) => ({ name: `/${command.name}`, description: command.description, custom: false })),
}: ChatProps) {
  const state = useSessionState(session);
  // Typewriter reveal (777.mov owner acceptance, ported from the fork
  // trial to the native-scrollback model): provider deltas arrive in
  // giant chunks; text should form at a human pace. A wall-clock budget
  // truncates the LIVE tail's newest delta run — projection-only. The
  // log, Static promotion and the settled boundary keep consuming the
  // full log, so promotion can never duplicate or lose content (a
  // promoted-but-unrevealed row reaches scrollback at most one promotion
  // batch ahead of the cursor). On settle the budget snaps open: a
  // completed turn never lags its own done (headless tests rely on this).
  const REVEAL_TICK_MS = Number(process.env.MOH_TYPEWRITER_MS ?? 60);
  // Horizontal (word-flow) reveal: the forming line grows rightward — no
  // per-row lag. ~10 chars/50ms ≈ 2 rows/s at 100 cols.
  const REVEAL_CHARS_PER_TICK = Number(process.env.MOH_TYPEWRITER_CHARS ?? 20);
  // Max chars the cursor may trail the provider stream by.
  const REVEAL_CATCHUP_CHARS = 400;
  const [revealTick, setRevealTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      // Pace, with catch-up: the cursor trails the stream by at most
      // REVEAL_CATCHUP_CHARS so long bursts eventually surface (a slow
      // reader cursor must never strand content the provider finished
      // long ago).
      const streamed = streamedCharsRef.current;
      const prev = revealAllowanceRef.current;
      // The cursor always trails the stream by at most REVEAL_CATCHUP
      // chars — including at mount (a remount seeds from the CURRENT
      // stream position, so already-shown content is never re-hidden:
      // the floor reads live streamed chars, not stale state).
      // Behind = how far the cursor trails the provider stream. The cursor
      // keeps its base typing speed and ACCELERATES with the deficit
      // (Codex-style catch-up): word-flow continues to the end of the
      // turn instead of collapsing into row dumps once the buffered
      // prefix is drained. The deficit is measured in ticks-equivalents
      // so the speedup is bounded (2.5x max) — always readable.
      // Accelerate with the deficit: a long buffer drains at visibly-
      // faster word-flow and ALWAYS completes — the cursor is capped only
      // by the stream itself, never stranded short of it. The cap keeps
      // the drain readable (~1600 c/s max) while bounding worst-case
      // reveal time to streamed/1600 s.
      const boost = 1 + Math.min(4, Math.max(0, streamed - prev) / 500);
      revealRef.current.budgetChars = Math.max(prev, Math.min(streamed, prev + REVEAL_CHARS_PER_TICK * boost));
      revealAllowanceRef.current = revealRef.current.budgetChars;
      setRevealTick((v) => v + 1);
    }, REVEAL_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  void revealTick; // re-render on each reveal tick (the pacer's heartbeat)
  // Char-level typewriter state. The cursor lives in revealAllowanceRef;
  // the interval below advances it and bumps revealTick (the re-render
  // trigger React can observe). Reset ONLY on a new user turn: multi-call
  // turns flip pending false between calls, and a pending-edge reset would
  // freeze the next call's reveal at a crawl.
  const revealRef = useRef({ budgetChars: 0, lastTurnStart: -1 });
  const streamedCharsRef = useRef(0);
  const revealAllowanceRef = useRef(0);
  {
    let turnStart = state.events.length;
    for (let i = state.events.length - 1; i >= 0; i--) {
      if (state.events[i]!.type === "user_message") { turnStart = i; break; }
    }
    const info = revealRef.current;
    // Streamed chars since the turn began (the catch-up ceiling).
    let streamed = 0;
    for (let i = turnStart; i < state.events.length; i++) {
      const e = state.events[i]!;
      if (e.type === "assistant_delta") streamed += e.text.length;
    }
    streamedCharsRef.current = streamed;
    if (turnStart < info.lastTurnStart) {
      info.budgetChars = 0;
      revealAllowanceRef.current = 0;
    }
    info.lastTurnStart = turnStart;
    if (!state.pending) {
      info.budgetChars = Number.MAX_SAFE_INTEGER; // settle: drain instantly
      revealAllowanceRef.current = info.budgetChars;
    }
  }
  // #253: live provider reasoning in the volatile area (display-gated in
  // the projection below: head-only indicator when reasoning display is
  // off — the text itself is never rendered then).
  const liveReasoning = useLiveReasoning(session, state.pending);
  // #liveness (prototype alive-proto variant C): scrolling tails of
  // running tools' partial output — volatile only, never persisted.
  const toolTails = useToolProgress(session, state.pending);
  const gitBranch = useGitBranch(cwd);
  const viewport = useViewport();
  const cols = width ?? viewport.columns;
  const compact = widthClass(viewport) === "compact";
  const [tick, setTick] = useState(0);
  // #liveness (variant C): animated glyph frames for running blocks — an
  // independent 120ms clock gated on the turn, never on stream events, so
  // the head keeps beating during event gaps (prototype alive-proto).
  const [animFrame, setAnimFrame] = useState(0);
  useEffect(() => {
    if (!state.pending || blocked) return;
    const timer = setInterval(() => setAnimFrame((f) => f + 1), 120);
    return () => clearInterval(timer);
  }, [state.pending, blocked]);
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
  // Instance-unique prefix for chunk keys: every live chain otherwise
  // names its chunks "live-reasoning-head-N", and a second call's chunks
  // would collide with the first call's already-emitted items inside the
  // append-only Static ledger (duplicate key → first-print-wins → the
  // second call's thinking vanishes).
  const reasoningChainSeq = useRef(0);
  const lastLiveChainRef = useRef<{ source: string; chars: number; chunks: TranscriptBlock[]; startIndex: number } | null>(null);
  const reasoningHeadsRef = useRef(new Map<string, SealedReasoningHead>());
  // Vision note 33: completed visual rows of plain assistant prose move to
  // Static immediately. Only the newest mutable row remains volatile, so
  // streamed output grows native terminal scrollback exactly once.
  const proseChainRef = useRef<ProseHeadChain | null>(null);
  const proseHeadsRef = useRef(new Map<string, SealedProseHead>());
  // Closed structured-Markdown segments have distinct projection keys but
  // must enter Ink Static as one append-only reply chain. Per-block cursors
  // dedup the canonical/live projections; only the chain owns the chunks.
  const markdownChainRef = useRef<MarkdownReplyChain | null>(null);
  const markdownChainsRef = useRef<MarkdownReplyChain[]>([]);
  const markdownHeadsRef = useRef(new Map<string, number>());
  // 777.mov: per-segment count of promoted rendered Markdown rows.
  const markdownRowsRef = useRef(new Map<string, number>());
  const failedCallsRef = useRef(0);
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
    proseChainRef.current = null;
    proseHeadsRef.current.clear();
    markdownChainRef.current = null;
    markdownChainsRef.current = [];
    markdownHeadsRef.current.clear();
    failedCallsRef.current = 0;
  }
  // #326: the hold shrinks settledEnd while paragraphs already promoted
  // under display-off would sit before the reasoning group — safe because a
  // showReasoning toggle always forces the whole-transcript repaint below
  // (clear + remount), which reprints everything in the new order.
  // Live reasoning now seals wholly into Static at reasoning_end, before the
  // first reply token — while reasoning is active. NOTE (#326 correction,
  // owner report 2026-09-06): with GLM the persisted reasoning event lands
  // only at call end, AFTER the reply's deltas; the live buffer goes
  // active=false already at reasoning_end. Holding only on active therefore
  // left a whole reply-stream window where closed Markdown segments
  // promoted BELOW the not-yet-persisted reasoning group — ink's forward-only
  // Static then re-emitted the reordered items at done (duplicated thinking
  // block and duplicated list items). The hold must last as long as the live
  // reasoning block exists at all (active or frozen awaiting its log
  // handover), which is exactly `liveReasoning !== null`.
  const settledEnd = useMemo(
    () => settledBoundary(state.events, state.pending),
    [state.events, state.pending, showReasoning, liveReasoning],
  );
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
  // A failed call is the one case whose canonical projection intentionally
  // keeps reasoning below its partial reply and marks it failed. Success is
  // the streaming fast path; failure rebuilds once its outcome lands.
  const failedCalls = useMemo(
    () => state.events.reduce((count, event) => count + (event.type === "model_call" && event.failed ? 1 : 0), 0),
    [state.events],
  );
  if (failedCalls > failedCallsRef.current) {
    failedCallsRef.current = failedCalls;
    repaintRef.current = true;
  }
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
    // A mode/display change must repaint even when no other condition set
    // the flag: a pure ctrl+o toggle used to be swallowed whenever
    // repaintRef happened to be false (mode prop advanced, transcript kept
    // the previous grammar — the unstable vibe/dev toggle). Detect the
    // divergence directly instead of relying on the flag.
    const segments = segmentsRef.current;
    const grammarStale = segments.length !== 1
      || segments[0]!.base !== 0
      || segments[0]!.mode !== mode
      || segments[0]!.show !== showReasoning;
    if ((!repaintRef.current && !grammarStale) || replaySettled || blocked || bufferFlipPending) return;
    repaintRef.current = false;
    segmentsRef.current = [{ base: 0, mode, show: showReasoning }];
    reasoningChainRef.current = null;
    reasoningHeadsRef.current.clear();
    proseChainRef.current = null;
    proseHeadsRef.current.clear();
    markdownChainRef.current = null;
    markdownChainsRef.current = [];
    markdownHeadsRef.current.clear();
    markdownRowsRef.current.clear();
    // The Static tree REMOUNTS on repaint (`key={repaint}`): ink's
    // forward-only cursor restarts at zero and its layout effect swallows
    // the first frame. Every emission-side ledger must reset with it — a
    // stale emission ledger made the first post-repaint Static see old
    // keys as already-printed (skipped blocks) and let previous-mode
    // (e.g. vibe) blocks survive the wipe into the new scrollback
    // (mixed-grammar transcript, duplicated lists after a mode toggle).
    emittedRef.current = [];
    assembledCountRef.current = 0;
    // Clear screen + scrollback, cursor home: the whole visible transcript
    // (including anything printed before moh) goes away by owner decision.
    stdout.write("\x1b[H\x1b[2J\x1b[3J");
    setRepaint((value) => value + 1);
  }, [mode, showReasoning, replaySettled, blocked, bufferFlipPending, stdout, widthTick, state.events.length]);

  useEffect(() => {
    // While a modal owns the input (ask/permission), the turn is parked
    // on the user — no spinner, so ticks stop re-rendering behind the
    // overlay (large-turn regression, session 20260825T062108113Z).
    if (blocked || !state.pending) return;
    const timer = setInterval(() => setTick((value) => value + 1), 90);
    return () => clearInterval(timer);
  }, [blocked, state.pending]);

  // ── Subagent chips + live panel (#497, vision note 25) ────────────────
  // Chrome-only: projection of the parent's subagent events plus the
  // throttled child-log tails. Never touches the transcript projection
  // (#194/#183). A 1Hz tick keeps elapsed counters and the ⏸ stalled
  // marker honest while a panel is open, even outside a pending turn.
  const allSubagents = useMemo(() => trackSubagents(state.events), [state.events]);
  const subagents = useVisibleSubagents(allSubagents);
  const subagentTails = useSubagentTails(subagents);
  const [panelNow, setPanelNow] = useState(Date.now);
  // #497: the panel is driven by `panelSubagent` (its own open/close state,
  // toggled with Enter on a subagent chip) — NOT by chip focus: Esc from a
  // focused chip returns to the composer and the panel stays put.
  const panelOpen = panelSubagent !== null && panelSubagent >= 0 && panelSubagent < subagents.length;
  const panelSub = panelOpen ? subagents[panelSubagent!] : undefined;
  useEffect(() => {
    if (!panelOpen) return;
    setPanelNow(Date.now());
    const timer = setInterval(() => setPanelNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [panelOpen, panelSub?.callId]);
  // Panel layout: the peek is full-width chrome above the footer (the
  // split layout is gone — see the return below). Rows stay tightly
  // capped: panel header + tail must never crowd the transcript.
  // Five rows make the child’s live work readable; this is chrome budgeted
  // out of the volatile transcript below, never unbounded panel growth.
  const panelRows = 5;
  // The footer is bottom-anchored. Its changing chrome (peek/chips) takes
  // rows from the volatile transcript budget rather than pushing composer,
  // status and action chips down the terminal.
  // Empty composer: separators (2) + composer (1) + spacer (1) + status
  // (2) + bordered action row (3) = 9. The subagent row is itself a
  // bordered three-row chip; the frameless running peek is header + five
  // truncate-only previews (the settled peek is just its summary line).
  // This intentionally over-reserves at tiny sizes: a stable footer takes
  // precedence over one more volatile transcript row.
  const footerRows = 9 + (subagents.length > 0 ? 3 : 0) + (panelOpen ? 1 + panelRows : 0);

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
          lines: showReasoning ? liveReasoning.text.split("\n").map(sanitizeLine) : [],
        }]
      : [];
    const projected = projectTranscript(live, { filePreview, mode, keyBase: settledEnd, initialAssistantRun: assistantRunOrigin(state.events, settledEnd), proseContinuation, showReasoning, toolTimings });
    // Horizontal typewriter: the forming reply reveals its SOURCE up to
    // the char cursor. Truncating at this single seam means promotion,
    // the volatile tail and the settled boundary all share the prefix —
    // a row can promote only once its source is fully revealed, and the
    // open line grows rightward instead of appearing row by row.
    const budgetChars = revealAllowanceRef.current;
    if (state.pending && budgetChars !== Number.MAX_SAFE_INTEGER) {
      // Cumulative source offsets across THIS projection's moh blocks —
      // never key-derived (-pN includes reasoning chars, which would
      // freeze the reply after a long reasoning phase).
      let base = 0;
      const revealed = projected.map((block) => {
        if (block.kind !== "moh" || block.markdown === undefined) return block;
        const limit = budgetChars - base;
        base += block.markdown.length;
        if (limit >= block.markdown.length) return block;
        if (limit <= 0) return { ...block, markdown: "", lines: [], renderedMarkdownRows: [] };
        return { ...block, markdown: block.markdown.slice(0, limit) };
      });
      return [...liveReasoningBlock, ...revealed];
    }
    return [...liveReasoningBlock, ...projected];
  // revealTick in deps: the cursor advances via a ref mutation, which
  // React cannot observe — the tick is the recompute trigger.
  }, [state.events, settledEnd, filePreview, mode, showReasoning, liveReasoning, toolTimings, toolTails, revealTick]);
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
    if (thinking && chain && chain.key === "live-reasoning" && thinking.key !== "live-reasoning") {
      // The live block vanished and the newest volatile thinking block is a
      // SETTLED, log-keyed one from a possibly DIFFERENT call. Handing the
      // chain over here would migrate it across calls and leave the old
      // call's groups unsealed (their settled blocks then print full text —
      // duplicated thinking). Seal what the live text covered and retire
      // the chain; the next call starts fresh.
      const covered: string[] = [];
      const flatSource = chain.source.split("\n").join(" ").replace(/\s+/g, " ").trim();
      for (let i = state.events.length - 1; i >= 0; i--) {
        const event = state.events[i]!;
        if (event.type !== "reasoning") continue;
        const key = `${i}-reasoning`;
        if (reasoningHeadsRef.current.has(key)) break;
        const flatEvent = event.text.replace(/\s+/g, " ").trim();
        if (!flatSource.includes(flatEvent)) continue;
        covered.unshift(key);
      }
      if (covered.length > 0) {
        covered.forEach((sealedKey, groupIndex) => {
          reasoningHeadsRef.current.set(sealedKey, {
            chunks: groupIndex === 0 ? chain.chunks : [],
            chars: chain.chars,
            source: chain.source,
            startIndex: chain.startIndex,
          });
        });
        reasoningChainSeq.current += 1;
        reasoningChainRef.current = null;
      }
    }
    // A live reasoning buffer can be silently REPLACED between provider
    // calls: the volatile block re-opens as "live-reasoning" with the next
    // call's text while the previous call's groups were never sealed (the
    // clear→persist race). Before tracking the replacement, seal the old
    // source's covered groups — otherwise the old call's settled blocks
    // print full text (duplicated thinking) and the old chunks are lost.
    // Snapshot the live chain BEFORE the state machine can reset it: the
    // replacement render wipes chars/source, so the guard below must read
    // the last non-empty snapshot to seal the previous call's groups.
    if (chain && chain.key === "live-reasoning" && chain.chars > 0) {
      lastLiveChainRef.current = { source: chain.source, chars: chain.chars, chunks: chain.chunks, startIndex: chain.startIndex };
    }
    const guardChain = chain && chain.chars > 0
      ? chain
      : (lastLiveChainRef.current ? { key: "live-reasoning", ...lastLiveChainRef.current } : null);
    if (guardChain) {
      const newSource = thinking?.lines.join("\n") ?? "";
      const oldSource = guardChain.source;
      if (oldSource && newSource && !newSource.startsWith(oldSource.slice(0, Math.min(40, oldSource.length)))) {
        const flatOld = oldSource.split("\n").join(" ").replace(/\s+/g, " ").trim();
        const covered: string[] = [];
        for (let i = state.events.length - 1; i >= 0; i--) {
          const event = state.events[i]!;
          if (event.type !== "reasoning") continue;
          const key = `${i}-reasoning`;
          if (reasoningHeadsRef.current.has(key)) break;
          const flatEvent = event.text.replace(/\s+/g, " ").trim();
          if (!flatOld.includes(flatEvent)) continue;
          covered.unshift(key);
        }
        if (covered.length > 0) {
          covered.forEach((sealedKey, groupIndex) => {
            reasoningHeadsRef.current.set(sealedKey, {
              chunks: groupIndex === 0 ? guardChain.chunks : [],
              chars: guardChain.chars,
              source: guardChain.source,
              startIndex: guardChain.startIndex,
            });
          });
          reasoningChainSeq.current += 1;
          reasoningChainRef.current = null;
          lastLiveChainRef.current = null;
        }
      }
    }
    if (thinking) {
      const previous = reasoningChainRef.current;
      // Once reasoning_end arrives the whole block is immutable. Promote its
      // remaining tail before any reply rows, preserving reasoning → reply
      // while allowing the reply itself to grow Static scrollback.
      const advanced = sawResizeRef.current
        ? (previous ?? { key: thinking.key, chars: 0, source: "", chunks: [], startIndex: 0 })
        : nextReasoningHead(
            previous,
            thinking.key,
            thinking.lines,
            Math.max(8, cols - 5),
            liveReasoning?.active === false ? 0 : REASONING_TAIL_LINES,
          );
      if (advanced.reset) {
        repaintRef.current = true;
      }
      // The chunks' Static insertion index is captured when the FIRST chunk
      // is promoted, at the settled length of the previous render: every
      // already-printed block stays before the chunks and later-settling
      // blocks append after them, so chunk indices never shift (ink's
      // Static counter only moves forward — an item pushed past it would
      // be reprinted, one duplication per seal).
      if (advanced.chunks.length > 0 && (previous?.chunks.length ?? 0) === 0) {
        advanced.startIndex = assembledCountRef.current;
      }
      // Live→log handover with the settled block already in this render's
      // projection: seal immediately, otherwise the settled block prints
      // its full text for the renders until the generic seal runs — and
      // printed items are never revised, so that window becomes a
      // permanent duplicate in scrollback.
      if (previous && previous.key === "live-reasoning" && thinking.key !== "live-reasoning" && !reasoningHeadsRef.current.has(thinking.key)) {
        reasoningHeadsRef.current.set(thinking.key, {
          chunks: advanced.chunks,
          chars: advanced.chars,
          source: advanced.source,
          startIndex: advanced.startIndex,
        });
      }
      // Stamp chunk keys with this chain's instance id: chunk keys must be
      // globally unique across calls (see reasoningChainSeq).
      if (advanced !== previous) {
        const uid = reasoningChainSeq.current;
        advanced.chunks = advanced.chunks.map((chunk, index) => ({
          ...chunk,
          key: `live-reasoning-${uid}-head-${index}`,
        }));
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
      const sealAgainst: string[] = [];
      if (chain.key !== "live-reasoning") {
        sealAgainst.push(chain.key);
      } else {
        // GLM interleaves: one call's reasoning persists as MULTIPLE
        // non-contiguous runs (reply deltas between them), each a separate
        // settled thinking block, while the live channel kept ONE
        // cumulative buffer whose chunks Static already printed. Seal
        // against EVERY persisted reasoning event the live text covers —
        // otherwise the unsealed block prints its full text again
        // (duplicated thinking). Dedup-only heads (no chunks) cover the
        // later blocks so they render as placeholders, never re-emit.
        for (let i = state.events.length - 1; i >= 0; i--) {
          const event = state.events[i]!;
          if (event.type !== "reasoning") continue;
          const key = `${i}-reasoning`;
          if (!reasoningHeadsRef.current.has(key)) sealAgainst.unshift(key);
          if (reasoningHeadsRef.current.has(key)) break; // reached an earlier sealed group
        }
      }
      sealAgainst.forEach((sealedKey, groupIndex) => {
        // Rekey sealed chunks: every live chain names its chunks
        // "live-reasoning-head-N", so a second sealed chain would collide
        // with the first inside the Static item keys (React duplicate-key
        // reconciliation → re-created children → ink re-emits them, the
        // v0.23.1 tripled thinking blocks). Sealed chunks are immutable,
        // so renaming them here is safe. Only the FIRST covered group
        // carries the chunks; the others are dedup-only placeholders.
        const sealedChunks = groupIndex === 0 ? chain.chunks : [];
        reasoningHeadsRef.current.set(sealedKey, { chunks: sealedChunks, chars: chain.chars, source: chain.source, startIndex: chain.startIndex });
      });
      if (sealAgainst.length > 0) {
        reasoningChainSeq.current += 1;
        reasoningChainRef.current = null;
      } else if (!state.pending) {
        // Nothing ever persisted to seal against (aborted call): the
        // printed chunks simply stay as the only record.
        reasoningChainRef.current = null;
      }
      // else: keep the chain held — the persisted events may lag one
      // render behind the volatile clear; a later render seals them.
    }
  }
  const activeChain = reasoningChainRef.current;
  const theme = useTheme();
  // 777.mov: one renderer per render; Markdown rows are produced by the
  // same pipeline the settled view uses, so promoted rows and settled rows
  // render identically.
  const markdownRenderer = useMemo(() => createMarkdownRenderer(theme, Math.max(20, cols - 6)), [theme, cols]);
  const renderRows = (source: string) => renderMarkdownRows(source, markdownRenderer, Math.max(20, cols - 6));
  // Prose head promotion (vision note 33). Assistant block keys are stable
  // across live and settled projections, unlike the separate reasoning
  // channel, so sealing can dedup directly against the same key.
  {
    // Provider reasoning that arrives before prose is already rendered above
    // it by log order. Late persisted reasoning stays after emitted prose,
    // so both plain and structured replies keep #526's append-only policy.
    const latestProse = [...rawLiveBlocks].reverse().find((block) => block.kind === "moh" && block.markdown !== undefined) ?? null;
    if (latestProse && proseChainRef.current?.key === latestProse.key && !isPlainStreamingProse(latestProse.markdown)) {
      // A later delta can turn previously plain text into Markdown whose
      // meaning reaches backwards (setext/table/list). No physical head
      // means nothing immutable was emitted: repaint in place instead.
      if (proseChainRef.current.chars > 0) repaintRef.current = true;
      else proseChainRef.current = null;
    }
    // Visual-row promotion of assistant Markdown (777.mov): a streamed
    // reply must scroll like the reasoning block — rows that will not
    // change again leave the volatile area for native scrollback while
    // the reply is still open, and only a small tail stays editable.
    // Coverage is keyed by canonical segment identity; rows are rendered
    // once (same pipeline as the settled view) and never re-parsed.
    // Coverage state: promotedRows per segment key. Retroactive GFM
    // changes (late emphasis/setext) are handled by the plain->Markdown
    // repaint above; promoted rows are frozen by design.
    const markdownBlocks = rawLiveBlocks.filter((block) => block.kind === "moh" && block.markdown !== undefined);
    for (const block of markdownBlocks) {
      const key = block.key;
      const prior = markdownRowsRef.current.get(key) ?? 0;
      const source = block.markdown!;
      const rows = renderRows(source);
      // The source is already truncated to the revealed prefix. The open
      // tail paragraph must stay ENTIRELY volatile: its rows re-wrap as
      // it grows (promoting any of them would freeze a stale wrap). Only
      // paragraphs closed by a blank line are wrap-stable.
      const lastParaStart = state.pending ? source.lastIndexOf("\n\n") + 1 : 0;
      const stablePrefix = state.pending ? source.slice(0, lastParaStart) : source;
      const stableRows = renderRows(stablePrefix);
      const stable = Math.max(0, stableRows.length - (state.pending ? 1 : 0));
      if (stable <= prior) continue;
      const fresh = rows.slice(prior, stable);
      const replyKey = key.replace(/-p\d+$/, "");
      let chain = markdownChainRef.current;
      if (!chain || chain.key !== replyKey) {
        chain = { key: replyKey, startIndex: assembledCountRef.current, chunks: [] };
        markdownChainRef.current = chain;
        markdownChainsRef.current.push(chain);
      }
      const opened = prior === 0 && chain.chunks.length === 0;
      chain.chunks.push({ key: `${key}-rows-${prior}`, kind: "moh", glyph: "◆", type: "moh", lines: [], renderedMarkdownRows: fresh, continuation: opened ? block.continuation : true, tight: opened ? block.tight : true });
      markdownRowsRef.current.set(key, stable);
      // A closed segment (a following segment already exists) promotes its
      // last row too.
      if (markdownBlocks[markdownBlocks.length - 1] !== block) {
        chain.chunks.push({ key: `${key}-rows-${stable}`, kind: "moh", glyph: "◆", type: "moh", lines: [], renderedMarkdownRows: rows.slice(stable), continuation: true, tight: true });
        markdownRowsRef.current.set(key, rows.length);
      }
    }
  }
  const liveBlocks: readonly TranscriptBlock[] = rawLiveBlocks.flatMap((block) => {
    if (activeChain && activeChain.chars > 0 && block.key === activeChain.key) {
      const trimmed = trimReasoningHead(block, activeChain.chars);
      return trimmed.lines.length > 0 ? [trimmed] : [];
    }
    if (block.markdown !== undefined) {
      const rows = renderRows(block.markdown!);
      const promoted = markdownRowsRef.current.get(block.key) ?? 0;
      let tail = rows.slice(promoted);
      const shown = Math.min(rows.length, Math.max(0, revealAllowanceRef.current));
      const visibleTail = Math.max(1, shown - promoted);
      if (state.pending && visibleTail < tail.length) {
        tail = tail.slice(0, visibleTail);
      }
      if (tail.length === 0 && promoted > 0) return [];
      const untouched = promoted === 0;
      return [{ ...block, lines: [], markdown: undefined, renderedMarkdownRows: tail, continuation: untouched ? block.continuation : true, tight: untouched ? block.tight : true }];
    }
    return [block];
  });
  const settledBlocks = useMemo((): readonly TranscriptBlock[] => {
    const segments = segmentsRef.current.filter((segment, index) =>
      segment.base < (segmentsRef.current[index + 1]?.base ?? settledEnd));
    const projected = segments.flatMap((segment, index) => projectTranscript(
      state.events.slice(segment.base, segmentsRef.current[index + 1]?.base ?? settledEnd),
      { filePreview, mode: segment.mode, keyBase: segment.base, initialAssistantRun: assistantRunOrigin(state.events, segment.base), showReasoning: segment.show, toolTimings },
    ));
    const embeded = embedReasoningHeads(projected, reasoningHeadsRef.current);
    // GLM interleave: one call's reasoning persists as multiple separate
    // blocks while the live channel promoted ONE cumulative buffer. A
    // block whose full text is already inside a sealed head's promoted
    // source must not print again (duplicated thinking) — reduce it to a
    // slot-keeping placeholder.
    const coveredSources = [...reasoningHeadsRef.current.values()].filter((h) => h.chunks.length > 0).map((h) => h.source);
    if (activeChain && activeChain.chars > 0) coveredSources.push(activeChain.source);
    if (lastLiveChainRef.current && lastLiveChainRef.current.chars > 0) coveredSources.push(lastLiveChainRef.current.source);
    const deduped = embeded.map((block) => {
      if (block.kind !== "thinking" || block.lines.length === 0) return block;
      const text = block.lines.join(" ");
      if (text.trim().length === 0) return block;
      const covered = coveredSources.some((hSource) => {
        const src = hSource.split("\n").join(" ").replace(/\s+/g, " ").trim();
        const flat = text.replace(/\s+/g, " ").trim();
        const hit = src.includes(flat) || flat.includes(src);
        return hit;
      });
      return covered ? { ...block, lines: [] } : block;
    });
    const result2 = deduped;
    // Structured Markdown chunks promoted by #526 already live in Static.
    // When their call later settles, retain only a source suffix that was
    // not emitted through that chain; never append the same segment again.
    // IMPORTANT: fully-consumed blocks are kept as EMPTY placeholders (a
    // rendered no-op) rather than dropped — dropping shrinks the Static
    // items array below ink's forward-only printed cursor, and every item
    // appended afterwards would land below the cursor and be silently
    // skipped (lost thinking blocks).
    return result2.flatMap((block) => {
      if (block.markdown !== undefined) {
        const rows = renderRows(block.markdown);
        const promoted = markdownRowsRef.current.get(block.key) ?? 0;
        const tail = rows.slice(promoted);
        if (promoted >= rows.length) {
          return [{ ...block, lines: [], markdown: undefined, renderedMarkdownRows: [], kind: "info", glyph: "", type: "placeholder", detail: undefined }];
        }
        return [{ ...block, lines: [], markdown: undefined, renderedMarkdownRows: tail, continuation: promoted > 0 ? true : block.continuation, tight: promoted > 0 ? true : block.tight }];
      }
      const chars = markdownHeadsRef.current.get(block.key) ?? 0;
      if (chars === 0) return [block];
      const remainder = trimProseHead(block, chars);
      return remainder.markdown?.trim()
        ? [remainder]
        : [{ ...block, lines: [], markdown: undefined, kind: "info", glyph: "", type: "placeholder", detail: undefined }];
    });
  }, [state.events, settledEnd, filePreview, mode, showReasoning, repaint, toolTimings]);
  const replayBlocks = useMemo(
    () => replaySettled ? transcriptTail(settledBlocks, cols, Math.max(1, viewport.rows - footerRows)) : settledBlocks,
    [replaySettled, settledBlocks, cols, viewport.rows, footerRows],
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
    ? Math.max(1, viewport.rows - footerRows - askUserBlockRows(askGate!.current!.questions, cols))
    : undefined;
  const liveTail = useMemo(
    () => transcriptTail(liveBlocks, cols, askBudget ?? Math.max(1, viewport.rows - footerRows)),
    [liveBlocks, cols, viewport.rows, askBudget, footerRows],
  );
  // #329: the head chunks (open chain and sealed chains) ride the Static
  // items appended at the current end — never through the settled
  // projection — and never below ink's forward-only Static cursor.
  // Whole-transcript reprints still read chronologically: each chunk
  // group sits after the blocks printed when it streamed.
  const assembledSettled: readonly TranscriptBlock[] = spliceReasoningChunks(
    settledBlocks,
    [
      ...reasoningHeadsRef.current.values(),
      ...(activeChain ? [activeChain] : []),
      ...markdownChainsRef.current,
    ],
  );
  assembledCountRef.current = assembledSettled.length;
  // Static must stay MOUNTED across modal cycles: unmounting it (the old
  // alternate-screen swap) reset ink's internal printed-items counter, so
  // every remount reprinted the whole settled transcript into the main
  // buffer — one duplicate per opened modal. While replaySettled, freeze
  // the items so Static emits nothing into the alternate buffer; on close
  // it resumes and prints only items settled in the meantime.
  const frozenRef = useRef<readonly TranscriptBlock[] | null>(null);
  // Append-only emission ledger (#537): the blocks ink has already been
  // handed via Static, in emission order, content as at print time. Ink's
  // Static prints items.slice(cursor) once and NEVER re-renders printed
  // items, so any assembly that inserts a new block before the cursor
  // loses it (skipped) and shifts printed items (re-emitted) — the
  // v0.23.1 doubled/tripled thinking blocks. New blocks therefore always
  // append: canonical order is kept while the projection itself stays
  // append-only; a late-settling block that canonically belongs before
  // printed history lands after it instead (physical constraint, decided
  // in #537 — the log keeps the true order for replay).
  const emittedRef = useRef<TranscriptBlock[]>([]);
  {
    const emittedKeys = new Set(emittedRef.current.map((b) => b.key));
    const fresh = assembledSettled.filter((b) => !emittedKeys.has(b.key));
    if (fresh.length > 0) {
      emittedRef.current = [...emittedRef.current, ...fresh];
    }
  }
  let staticItems: readonly TranscriptBlock[];
  if (replaySettled) {
    if (frozenRef.current === null) frozenRef.current = emittedRef.current;
    staticItems = frozenRef.current;
  } else {
    frozenRef.current = null;
    staticItems = emittedRef.current;
  }
  const spinner = SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!;

  // Vision note 4 (#490): place-once image emission. After the Static
  // paint of a settled user row that cites an image (the block carries
  // its own `image` payload), the pixels are written straight to stdout
  // (kitty/iTerm2 protocols; `none` = chip only). Each image is emitted
  // exactly once per placement — kitty placements are deleted and
  // re-emitted on a whole-transcript repaint.
  const emittedImagesRef = useRef<Map<string, number>>(new Map());
  const imagePreviewsPlaceRef = useRef(1);
  // The known place-once compromise — on a whole-transcript repaint the
  // already-emitted image would sit duplicated in the scrollback. Where
  // the protocol supports it (kitty), the placement is deleted first and
  // the repaint re-emits at the new position; the chip never re-renders.
  const repaintKeyRef = useRef(repaint);
  useEffect(() => {
    if (repaintKeyRef.current === repaint) return;
    repaintKeyRef.current = repaint;
    if (previewMode.protocol === "kitty" && emittedImagesRef.current.size > 0) {
      for (const placement of emittedImagesRef.current.values()) stdout.write(deletePlacement(placement, previewMode));
      emittedImagesRef.current.clear();
    }
  }, [repaint, previewMode, stdout]);
  useEffect(() => {
    if (previewMode.protocol === "none") return;
    if (replaySettled || bufferFlipPending) return;
    for (const block of staticItems) {
      const image = block.kind === "user" ? block.image : undefined;
      if (!image || emittedImagesRef.current.has(block.key)) continue;
      const placement = imagePreviewsPlaceRef.current++;
      emittedImagesRef.current.set(block.key, placement);
      const seq = emitImage(image, previewMode, {
        columns: cols,
        rows: viewport.rows,
        cellWidth: 0,
        cellHeight: 0,
      }, placement);
      if (seq) stdout.write(seq + "\n");
    }
    // staticItems identity changes on every settled assembly — that is the
    // trigger to look for newly settled citing rows.
  });

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

  // #497 (owner revision): the split right column never worked — ink's
  // forward-only Static plus the row-sibling split made the layout lurch
  // while subagents ran. The Claude-style peek (panel as volatile chrome
  // above the footer, full width) is the ONLY layout, at every terminal
  // size. Row cap stays tight (PANEL_TAIL_LINES) so scrollback never
  // suffers.
  const panel = panelOpen && panelSub ? (
    <SubagentPanel sub={panelSub} tail={subagentTails.get(panelSub.callId)} now={panelNow} width={Math.max(20, cols - 2)} rows={panelRows} />
  ) : null;

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
          block={block.state === "run" && (block.kind === "tool" || block.kind === "moh")
            ? { ...block, glyph: ANIM_GLYPHS[animFrame % ANIM_GLYPHS.length]! }
            : block}
          width={cols}
          {...(block.callId !== undefined && block.durationMs === undefined && toolTimings.get(block.callId)?.at !== undefined
            ? { liveMeta: { elapsedMs: Date.now() - toolTimings.get(block.callId)!.at, timeoutMs: block.timeoutMs } }
            : {})}
        />
      ))}</Box>}

      {/* #497: the subagent peek — the panel content rides the volatile
          region above the footer (the only layout, at every width). */}
      {panel}

      <ThinkingSeparator level={thinkingLevel} width={cols} />
      <MultilineInput
        placeholder={compact ? "type…" : "type… (shift+enter newline · ctrl+a/e line start/end)"}
        disabled={blocked}
        focused={inputFocused}
        onAskCommands={onOpenCommands}
        commands={commands}
        onSuggestionsOpen={onSuggestionsOpen}
        mentionCandidates={mentionCandidates}
        onPastePath={onPastePath}
        submitSignal={submitSignal}
        prefill={prefill}
        onSubmit={(text) => {
          if (onCommand?.(text)) return;
          onBranchFromDismiss?.();
          void session.send(text);
        }}
      />
      {branchFrom && (
        <Box paddingX={1}>
          <Text color={theme.warn} wrap="truncate">
            ⑂ branching from “{truncate(branchFrom, Math.max(12, cols - 56))}” — next message starts a new branch
          </Text>
        </Box>
      )}
      <ThinkingSeparator level={thinkingLevel} width={cols} />
      {/* #412: inline ask_user block — one blank line of padding above and
          below (inside AskUserBlock), between the text area's separator
          and row 1. */}
      {askGate && askGate.current && <AskUserBlock gate={askGate} width={cols} />}
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
        compactionFailed={compactionFailed}
        growthWarning={growthWarning}
        onKeepMyBranch={onKeepMyBranch}
        phase={armed ? "esc again to stop" : livePhase}
        notice={notice}
        updateMessage={updateMessage}
        branch={branch ?? gitBranch}
        cwd={cwd}
        yolo={yolo}
        focusedChip={focusedChip}
        focusedSubagent={focusedSubagent}
        subagentChips={subagents.length > 0 ? subagents.slice(0, 3).map((sub, index) => ({
          label: sub.displayName ?? sub.name,
          glyph: subagentGlyph(sub, subagentTails.get(sub.callId), panelNow),
          active: focusedSubagent === index,
        })).concat(subagents.length > 3 ? [{ label: `+${subagents.length - 3}`, glyph: "", active: false }] : []) : undefined}
      />
    </Box>
  );
}

/** One live plain-prose promotion chain (vision note 33). `chars` is
 * the source prefix already printed through Static; one wrapped row remains
 * volatile so later text can still change its wrapping. */
export interface ProseHeadChain {
  key: string;
  chars: number;
  chunks: TranscriptBlock[];
  startIndex: number;
}

export type SealedProseHead = Omit<ProseHeadChain, "key">;
interface MarkdownReplyChain { key: string; startIndex: number; chunks: TranscriptBlock[] }

/** Conservative gate: Markdown constructs can change the interpretation of
 * preceding lines, so they stay on the existing semantic paragraph/fence
 * promotion path. The fast path is only for ordinary model prose. */
export function isPlainStreamingProse(source: string | undefined): source is string {
  if (!source) return false;
  return !/[`*_[\]<>|&\\]/.test(source)
    && !/ {2}\n/.test(source)
    && !/^\s{0,3}(?:#{1,6}\s|>|[-+=]{3,}\s*$|[-+]\s|\d+[.)]\s|~{3,})/m.test(source);
}

/** Returns complete visual rows and their source boundary, retaining the
 * newest row as the only mutable tail. It wraps at source whitespace, so a
 * promoted prefix never cuts a word and remains valid as text is appended. */
export function promotablePlainPrefix(source: string, width: number): { chars: number; lines: string[] } {
  const rows: Array<{ end: number; text: string }> = [];
  let base = 0;
  for (const sourceLine of source.split("\n")) {
    const tokens = [...sourceLine.matchAll(/\S+\s*/g)];
    let text = "";
    let end = base;
    for (const token of tokens) {
      const word = token[0].trimEnd();
      if (!word) continue;
      if (text && text.length + 1 + word.length > width) {
        rows.push({ end, text });
        text = word;
      } else {
        text = text ? `${text} ${word}` : word;
      }
      end = base + token.index + token[0].length;
    }
    if (text) rows.push({ end, text });
    base += sourceLine.length + 1;
  }
  const stable = rows.slice(0, -1);
  return { chars: stable.at(-1)?.end ?? 0, lines: stable.map((row) => row.text) };
}

/** Advances plain prose promotion in bounded batches. Chunks render as
 * already-wrapped body rows (not independent Markdown documents), while the
 * exact source-character boundary drives live and settled deduplication. */
export function nextProseHead(chain: ProseHeadChain | null, block: TranscriptBlock, width: number): ProseHeadChain {
  const next = chain?.key === block.key ? chain : { key: block.key, chars: 0, chunks: [], startIndex: 0 };
  const source = block.markdown;
  if (!isPlainStreamingProse(source)) return next;
  const promoted = promotablePlainPrefix(source, Math.max(8, width));
  if (promoted.chars <= next.chars) return next;
  const prior = next.chunks.reduce((sum, chunk) => sum + chunk.lines.length, 0);
  const lines = promoted.lines.slice(prior);
  if (lines.length === 0) return next;
  const first = next.chunks.length === 0;
  const chunk: TranscriptBlock = {
    key: `${block.key}-head-${next.chunks.length}`,
    kind: "moh",
    glyph: "◆",
    type: "moh",
    lines,
    continuation: first ? block.continuation : true,
  };
  return { ...next, chars: promoted.chars, chunks: [...next.chunks, chunk] };
}

/** Removes an already-printed source prefix. Once a head exists the
 * remainder always continues it; an empty remainder emits no body row. */
export function trimProseHead(block: TranscriptBlock, chars: number): TranscriptBlock {
  if (chars <= 0 || block.markdown === undefined) return block;
  const markdown = block.markdown.slice(chars).trimStart();
  return {
    ...block,
    lines: markdown ? markdown.split("\n") : [],
    markdown,
    ...(block.lineKinds ? { lineKinds: markdown ? block.lineKinds.slice(-markdown.split("\n").length) : [] } : {}),
    continuation: true,
  };
}

export function embedProseHeads(
  blocks: readonly TranscriptBlock[],
  heads: ReadonlyMap<string, SealedProseHead>,
): TranscriptBlock[] {
  if (heads.size === 0) return [...blocks];
  return blocks.map((block) => {
    const head = heads.get(block.key);
    return head ? trimProseHead(block, head.chars) : block;
  });
}

/** Lines of live reasoning kept volatile below the promoted head (#329). */
export const REASONING_TAIL_LINES = 1;

/** #liveness (variant C): glyph frames cycling on running-block heads. */
const ANIM_GLYPHS = ["◔", "◑", "◕", "●"];

/** One open live-reasoning promotion chain (#329): the volatile
 * thinking-block key being tracked ("live-reasoning" while the live
 * channel streams, the log key after the handover), how many of its lines
 * are already promoted into Static, and the immutable chunks printed so
 * far. */
export interface ReasoningHeadChain {
  key: string;
  /** Sanitized source-character prefix already rendered as immutable rows. */
  chars: number;
  /** Last sanitized source window, used to detect the 64 KiB cap rollover. */
  source: string;
  chunks: TranscriptBlock[];
  /** The source window stopped being append-only; caller rebuilds. */
  reset?: boolean;
  /** #329: settledBlocks length when the chain opened — the stable Static
   * insertion index for the chunks (see Chat). Set by the caller. */
  startIndex: number;
}

/** A sealed chain (#329): the chunks printed for a settled reasoning block,
 * how many of its lines they cover, and where they sit in the Static items —
 * the settled block prints only the remainder, so a long reasoning stream
 * lands in scrollback exactly once. */
export type SealedReasoningHead = Omit<ReasoningHeadChain, "key" | "reset">;

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
  width: number,
  tailLines = REASONING_TAIL_LINES,
): ReasoningHeadChain {
  let next: ReasoningHeadChain;
  if (!chain) next = { key, chars: 0, source: "", chunks: [], startIndex: 0 };
  else if (chain.key === key) next = chain;
  else if (chain.key === "live-reasoning") next = { ...chain, key, chunks: [...chain.chunks] };
  else next = { key, chars: 0, source: "", chunks: [], startIndex: 0 };
  const source = lines.join("\n");
  const windowed = source.startsWith("… reasoning truncated — showing the last ");
  // The 64 KiB display cap replaces the old prefix with a moving window.
  // Remove previously printed chunks once, then keep that window volatile;
  // at reasoning_end it is fixed and can be promoted before the reply.
  if (windowed && tailLines > 0) {
    return next.chunks.length > 0 || next.chars > 0
      ? { key, chars: 0, source, chunks: [], startIndex: 0, reset: true }
      : { ...next, chars: 0, source, chunks: [], reset: next.reset };
  }
  if (windowed) next = { key, chars: 0, source: "", chunks: [], startIndex: 0 };
  else if (next.source && !source.startsWith(next.source)) {
    return { key, chars: 0, source, chunks: [], startIndex: 0, reset: true };
  }
  const wrapped = visualTextRows(source, Math.max(8, width));
  const stable = wrapped.slice(0, Math.max(0, wrapped.length - tailLines));
  const chars = stable.at(-1)?.end ?? 0;
  if (chars <= next.chars) return { ...next, source };
  const priorRows = next.chunks.reduce((sum, chunk) => sum + chunk.lines.length, 0);
  const slice = stable.slice(priorRows).map((row) => row.text);
  if (slice.length === 0) return next;
  return {
    ...next,
    chars,
    source,
    chunks: [...next.chunks, {
      key: `${key}-head-${next.chunks.length}`,
      kind: "thinking",
      glyph: "⋯",
      type: "thinking",
      ...(next.chunks.length === 0 ? { detail: "…" } : { continuation: true }),
      lines: slice,
    }],
  };
}

interface VisualTextRow { end: number; text: string }

/** Plain-text terminal wrapping with source boundaries. Reasoning has no
 * Markdown semantics, so every row except the newest is immutable once the
 * next word starts a later row. Explicit newlines force a row boundary. */
function visualTextRows(source: string, width: number): VisualTextRow[] {
  const rows: VisualTextRow[] = [];
  let base = 0;
  const sourceLines = source.split("\n");
  for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex++) {
    const sourceLine = sourceLines[lineIndex]!;
    const tokens = [...sourceLine.matchAll(/\S+\s*/g)];
    let text = "";
    let end = base;
    for (const token of tokens) {
      const word = token[0].trimEnd();
      if (!word) continue;
      if (word.length > width) {
        if (text) rows.push({ end, text });
        for (let at = 0; at < word.length; at += width) {
          const piece = word.slice(at, at + width);
          rows.push({ end: base + token.index + Math.min(word.length, at + width), text: piece });
        }
        text = "";
      } else if (text && text.length + 1 + word.length > width) {
        rows.push({ end, text });
        text = word;
      } else {
        text = text ? `${text} ${word}` : word;
      }
      end = base + token.index + token[0].length;
    }
    if (text) rows.push({ end, text });
    if (lineIndex < sourceLines.length - 1) {
      // Every explicit newline owns a terminal row, including blank lines.
      if (!text && sourceLine.length === 0) rows.push({ end: base + 1, text: "" });
      else if (rows.length > 0) rows[rows.length - 1]!.end = base + sourceLine.length + 1;
    }
    base += sourceLine.length + 1;
  }
  return rows;
}

export function trimReasoningHead(block: TranscriptBlock, chars: number): TranscriptBlock {
  if (chars <= 0) return block;
  const source = block.lines.join("\n").slice(chars).replace(/^ /, "");
  return { ...block, lines: source ? source.split("\n") : [], continuation: true };
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
    deduped.push(head ? trimReasoningHead(block, head.chars) : block);
  }
  return deduped;
}

/** Splices #329 head chunks into the Static items. Each chunk group is
 * appended at the CURRENT end of the settled list, in group order — never
 * at the recorded `startIndex`. Ink's `<Static>` counter is forward-only
 * and equals the emitted item count: any insertion below that cursor
 * shifts already-printed items forward and makes ink re-emit each of them
 * (one duplicate per shift per item — the v0.23.1 doubled/tripled thinking
 * blocks). With #537's append-only projection, appended-at-end is also the
 * semantically correct position: nothing may retro-insert above printed
 * history. The `startIndex` field remains part of the chain contract
 * (diagnostics) but no longer drives insertion. */
export function spliceReasoningChunks(
  blocks: readonly TranscriptBlock[],
  inserts: ReadonlyArray<{ startIndex: number; chunks: readonly TranscriptBlock[] }>,
): TranscriptBlock[] {
  const active = inserts.filter((insert) => insert.chunks.length > 0);
  if (active.length === 0) return [...blocks];
  const spliced = [...blocks];
  for (const insert of [...active].sort((a, b) => a.startIndex - b.startIndex)) {
    spliced.push(...insert.chunks);
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
