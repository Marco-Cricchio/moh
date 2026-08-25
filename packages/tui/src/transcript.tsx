import React, { useMemo } from "react";
import { Box, Text } from "ink";
import type { AgentEvent } from "@moh/core";
import type { Theme } from "./themes";
import { useTheme } from "./themes";
import { sanitizeLine, truncate } from "./ui";
import { createMarkdownRenderer, Markdown } from "./markdown";
export type BlockKind = "user" | "moh" | "code" | "diff" | "tool" | "error" | "chrome" | "thinking";
export interface TranscriptBlock {
  key: string;
  kind: BlockKind;
  glyph: string;
  type: string;
  detail?: string;
  lines: string[];
  /** Original assistant prose, retained for terminal Markdown rendering. */
  markdown?: string;
  /** True for paragraphs that continue an assistant reply already started
   * above: they render without their own head row so one reply reads as one
   * continuous output (#205). */
  continuation?: boolean;
  lineKinds?: Array<"body" | "heading" | "bullet" | "ask" | "answer">;
  state?: "run" | "ok" | "fail";
  usage?: { inputTokens: number; outputTokens: number };
}

/** Vibe phrasing for a tool call (#193): plain language, no raw command. */
const TOOL_ACTION: Record<string, string> = {
  read: "read a file",
  write: "wrote a file",
  edit: "edited a file",
  glob: "looked for files",
  grep: "searched the code",
  fetch: "fetched a page",
  todo: "updated the plan",
  bash: "ran a command",
};

/** The file-ish detail vibe shows (a path or pattern, not a command line). */
const vibeDetail = (name: string, args: unknown): string => {
  if (!args || typeof args !== "object") return "";
  const rec = args as Record<string, unknown>;
  // Search tools: the pattern says what was looked for, the path is noise.
  if (name === "glob" || name === "grep") {
    if (typeof rec.pattern === "string") return rec.pattern.split("\n")[0]!;
  }
  const path = rec.path ?? rec.file;
  if (typeof path === "string") return path.split("\n")[0]!;
  if (name === "fetch" && typeof rec.url === "string") return rec.url.split("\n")[0]!;
  return "";
};

const detailOf = (args: unknown): string => {
  if (!args || typeof args !== "object") return "";
  const rec = args as Record<string, unknown>;
  for (const key of ["command", "path", "file", "pattern", "query", "url"]) {
    if (typeof rec[key] === "string") return sanitizeLine(String(rec[key])).split("\n")[0]!;
  }
  return truncate(sanitizeLine(JSON.stringify(args)), 100);
};

/** Complete, deterministic projection of the append-only event log. Events
 * may be grouped (assistant deltas, tool call/result), but none disappear
 * without an intentional chrome representation.
 *
 * `mode` (#193): `dev` renders the full technical grammar; `vibe` is the
 * plain-language view over the same log — metric/chrome blocks drop, tool
 * activity collapses to one plain-language line (unresolved calls keep
 * `state: "run"` so the pending marker stays live), failures always show.
 * The log itself is never filtered: this is a projection option only. */
export function projectTranscript(events: ReadonlyArray<AgentEvent>, options: { mode?: "vibe" | "dev"; filePreview?: "always" | "on-demand" | "none"; keyBase?: number; /** True when the slice begins mid-reply (live tail): its first paragraph is a continuation (#205). */ proseContinuation?: boolean } = {}): TranscriptBlock[] {
  const vibe = options.mode === "vibe";
  const keyBase = options.keyBase ?? 0;
  const blocks: TranscriptBlock[] = [];
  const results = new Map<string, Extract<AgentEvent, { type: "tool_result" }>>();
  for (const event of events) if (event.type === "tool_result") results.set(event.callId, event);

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const key = `${keyBase + i}-${event.type}`;
    switch (event.type) {
      case "user_message":
        blocks.push({ key, kind: "user", glyph: "›", type: "you", lines: event.text.split("\n") });
        break;
      case "assistant_delta": {
        let text = event.text;
        while (events[i + 1]?.type === "assistant_delta") text += (events[++i] as Extract<AgentEvent, { type: "assistant_delta" }>).text;
        // One reply, many append-only segments (#205): the terminal Markdown
        // renderer owns fences/tables/headings inline, but a whole reply as
        // ONE block would grow after Static promotion and ink never reprints
        // a promoted item — later paragraphs would vanish. Each closed
        // segment becomes its own never-mutating block; continuation
        // segments render without a head row so the reply still reads as one
        // continuous output.
        for (const segment of assistantSegments(text)) {
          blocks.push(proseBlock(`${key}-p${segment.start}`, segment.text, segment.start > 0 || !!options.proseContinuation));
        }
        break;
      }
      case "tool_call": {
        const result = results.get(event.callId);
        const state = result ? (result.ok ? "ok" : "fail") : "run";
        if (event.name === "ask_user") {
          const question = event.args && typeof event.args === "object" && "question" in event.args ? String((event.args as { question: unknown }).question) : detailOf(event.args);
          const lines = [question, ...(result?.output ? [`↳ you: ${sanitizeLine(result.output)}`] : [])];
          blocks.push({ key, kind: "moh", glyph: "?", type: "ask", lines, lineKinds: lines.map((_, index) => index === 0 ? "ask" : "answer"), state });
          break;
        }
        if (vibe) {
          if (state !== "fail") {
            const action = TOOL_ACTION[event.name] ?? `used ${event.name}`;
            const target = vibeDetail(event.name, event.args);
            blocks.push({ key, kind: "moh", glyph: "◆", type: "moh", lines: [target ? `${action} · ${target}` : action], state });
            break;
          }
          blocks.push({ key, kind: "error", glyph: "✗", type: event.name, detail: detailOf(event.args), lines: result?.ok === false ? result.output.split("\n").slice(0, 5).map(sanitizeLine) : [], state: "fail" });
          break;
        }
        blocks.push({
          key,
          kind: "tool",
          glyph: state === "ok" ? "✓" : state === "fail" ? "✗" : "◌",
          type: event.name,
          detail: detailOf(event.args),
          lines: event.name !== "read" && result?.output ? result.output.split("\n").slice(0, options.filePreview === "always" ? 15 : 5).map(sanitizeLine) : [],
          state,
        });
        if (event.name === "read" && result?.ok && options.filePreview !== "none") {
          const start = event.args && typeof event.args === "object" && typeof (event.args as { offset?: unknown }).offset === "number" ? (event.args as { offset: number }).offset : 1;
          const previewLines = result.output.split("\n").slice(0, options.filePreview === "always" ? 15 : 5);
          blocks.push({ key: `${key}-preview`, kind: "code", glyph: "⌨", type: "preview", detail: `${detailOf(event.args)} · ${start}–${start + Math.max(0, previewLines.length - 1)}`, lines: previewLines.map((line, lineIndex) => `${String(start + lineIndex).padStart(3)} │ ${sanitizeLine(line)}`) });
        }
        break;
      }
      case "tool_result":
        if (!events.some((candidate) => candidate.type === "tool_call" && candidate.callId === event.callId)) {
          blocks.push({ key, kind: "tool", glyph: event.ok ? "✓" : "✗", type: "tool result", detail: event.callId, lines: event.output.split("\n").map(sanitizeLine), state: event.ok ? "ok" : "fail" });
        }
        break;
      case "permission_requested":
        blocks.push({ key, kind: "tool", glyph: "◌", type: "permission", detail: `${event.tool} · requested`, lines: [], state: "run" });
        break;
      case "permission_granted":
        blocks.push({ key, kind: "tool", glyph: "✓", type: "permission", detail: `${event.tool} · allowed (${event.reason})`, lines: [], state: "ok" });
        break;
      case "permission_denied":
        blocks.push({ key, kind: "tool", glyph: "⊘", type: "permission", detail: `${event.tool} · denied`, lines: [event.reason], state: "fail" });
        break;
      case "permission_rule_added":
        blocks.push({ key, kind: "chrome", glyph: "◈", type: "permission rule", detail: JSON.stringify(event.rule), lines: [] });
        break;
      case "model_call": {
        if (vibe) break;
        // Deterministic by construction (#194): the block renders exactly
        // what the event carries and never whether a later `done` will
        // summarize the turn — settled blocks are promoted to Static
        // incrementally mid-turn and a Static item must never change or
        // disappear later (ink would desync its printed-items index). The
        // token totals stay on `done` alone so turns don't show duplicate
        // usage numbers; per-call lines record which model served the call.
        blocks.push({ key, kind: "chrome", glyph: "─", type: "model", detail: event.model, lines: [] });
        break;
      }
      case "done":
        if (vibe) break;
        blocks.push(event.usage
          ? { key, kind: "chrome", glyph: "─", type: "usage", detail: event.models?.join(", "), lines: [], usage: event.usage }
          : { key, kind: "chrome", glyph: "✓", type: "done", detail: event.models?.join(", "), lines: [] });
        break;
      case "error":
        blocks.push({ key, kind: "error", glyph: "✗", type: "error", detail: event.reason, lines: [event.message], state: "fail" });
        break;
      case "cancelled":
        blocks.push({ key, kind: "chrome", glyph: "◌", type: "cancelled", detail: "steering · turn interrupted", lines: [] });
        break;
      case "subagent_spawn":
        blocks.push({ key, kind: "chrome", glyph: "◇", type: event.name, detail: `spawn${event.preset ? ` · ${event.preset}` : ""}`, lines: [] });
        break;
      case "subagent_result":
        blocks.push(vibe
          ? { key, kind: event.status === "error" ? "error" : "chrome", glyph: event.status === "done" ? "✓" : event.status === "error" ? "✗" : "◌", type: event.name, detail: event.status === "error" ? "failed" : event.status, lines: [] }
          : { key, kind: event.status === "error" ? "error" : "chrome", glyph: event.status === "done" ? "✓" : event.status === "error" ? "✗" : "◌", type: event.name, detail: `${event.status} · ${event.usage.inputTokens + event.usage.outputTokens} tok`, lines: [] });
        break;
      case "session_start":
        if (vibe) break;
        blocks.push({ key, kind: "chrome", glyph: "◈", type: "session started", detail: `prompt ${event.promptVersion.slice(0, 8)}`, lines: [] });
        break;
      case "session_mode":
        if (vibe) break;
        blocks.push({ key, kind: "chrome", glyph: "◈", type: "permission mode", detail: event.mode, lines: [] });
        break;
      case "skill_invoked":
        if (vibe) break;
        blocks.push({ key, kind: "chrome", glyph: "◈", type: "skill", detail: event.name, lines: [] });
        break;
      case "model_switched":
        if (vibe) break;
        blocks.push({ key, kind: "chrome", glyph: "◈", type: "model switched", detail: `${event.from} → ${event.to} (next turn)`, lines: [] });
        break;
      case "memory_updated":
        if (vibe) break;
        blocks.push({ key, kind: "chrome", glyph: "◈", type: "memory updated", detail: event.topics.join(", "), lines: [] });
        break;
      case "compaction":
        if (vibe) break;
        blocks.push({ key, kind: "chrome", glyph: "◈", type: "context compacted", detail: `${event.upTo} events`, lines: [event.summary] });
        break;
      case "extension_loaded":
        if (vibe) break;
        blocks.push({ key, kind: "chrome", glyph: "◈", type: "extension loaded", detail: `${event.name} ${event.version}`, lines: [] });
        break;
      case "extension_failed":
        blocks.push({ key, kind: "error", glyph: "✗", type: "extension failed", detail: event.name, lines: [event.message], state: "fail" });
        break;
      case "mcp_server_started":
        if (vibe) break;
        blocks.push({ key, kind: "chrome", glyph: "◈", type: "MCP started", detail: `${event.server} · ${event.tools.length} tools`, lines: [] });
        break;
      case "mcp_server_failed":
        blocks.push({ key, kind: "error", glyph: "✗", type: "MCP failed", detail: event.server, lines: [event.message], state: "fail" });
        break;
      case "mcp_server_stopped":
        blocks.push({ key, kind: "chrome", glyph: "◈", type: "MCP stopped", detail: event.server, lines: [] });
        break;
      case "mcp_refused":
        blocks.push({ key, kind: "chrome", glyph: "⊘", type: "MCP refused", detail: `${event.server} · ${event.capability}`, lines: [] });
        break;
      default: {
        const exhaustive: never = event;
        throw new Error(`unhandled AgentEvent: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  return blocks;
}

function proseBlock(key: string, prose: string, continuation = false): TranscriptBlock {
  const raw = prose.split("\n");
  const lineKinds: Array<"body" | "heading" | "bullet"> = [];
  const lines = raw.map((line) => {
    if (/^#{1,6}\s+/.test(line)) { lineKinds.push("heading"); return line.replace(/^#{1,6}\s+/, ""); }
    if (/^\s*[-*]\s+/.test(line)) { lineKinds.push("bullet"); return line.replace(/^\s*[-*]\s+/, "· "); }
    lineKinds.push("body");
    return line;
  });
  return { key, kind: "moh", glyph: "◆", type: "moh", lines, lineKinds, markdown: prose, ...(continuation ? { continuation: true } : {}) };
}

const LIST_ITEM = /^\s{0,3}(?:[-*+]|\d+[.)])\s+/;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

/** Splits an assistant reply into promotable segments (#205). A segment
 * closes at a blank line outside code fences — but not between the items of
 * a loose list (GFM keeps it one list; splitting would restart numbering) —
 * or right after a closing fence (fence content is final once closed). The
 * final segment stays open while the reply streams. Shared by the
 * transcript projection and the settled/live boundary so a promoted prefix
 * never mutates after ink has printed it. */
export function assistantSegments(text: string): Array<{ start: number; end: number; text: string }> {
  const lines = text.split("\n");
  const offsets: number[] = [];
  let at = 0;
  for (const line of lines) { offsets.push(at); at += line.length + 1; }
  const segments: Array<{ start: number; end: number; text: string }> = [];
  let segStart = 0;
  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = line.match(FENCE_LINE);
    if (fence) {
      const marker = fence[1]!;
      const char = marker[0]! as "`" | "~";
      if (fenceChar === null) { fenceChar = char; fenceLen = marker.length; }
      else if (fenceChar === char && marker.length >= fenceLen && /^\s*$/.test(line.slice(fence[0].length))) {
        // Closed fence: the segment (prose + code) is final.
        fenceChar = null;
        const end = Math.min(text.length, offsets[i + 1] ?? text.length);
        segments.push({ start: segStart, end, text: text.slice(segStart, end) });
        segStart = end;
      }
      continue;
    }
    if (fenceChar !== null) continue;
    if (line.trim() === "") {
      const prev = lines[i - 1] ?? "";
      const next = lines[i + 1] ?? "";
      if (LIST_ITEM.test(prev) && LIST_ITEM.test(next)) continue; // loose list
      if (i + 1 >= lines.length) break; // trailing blank: nothing new opens
      const end = Math.min(text.length, offsets[i + 1] ?? text.length);
      if (next.trim() === "" ) continue;
      segments.push({ start: segStart, end, text: text.slice(segStart, end) });
      segStart = end;
    }
  }
  if (segStart < text.length) segments.push({ start: segStart, end: text.length, text: text.slice(segStart) });
  return segments.filter((segment) => segment.text.trim().length > 0 || segments.length === 1);
}

/** Length of the reply prefix that is semantically final (last closed
 * segment). The settled/live boundary may promote up to here and no
 * further: everything after it can still grow (#205). */
export function closedPrefixLength(text: string): number {
  const lines = text.split("\n");
  let at = 0;
  let segStart = 0;
  let closed = 0;
  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const offset = at;
    at += line.length + 1;
    const fence = line.match(FENCE_LINE);
    if (fence) {
      const marker = fence[1]!;
      const char = marker[0]! as "`" | "~";
      if (fenceChar === null) { fenceChar = char; fenceLen = marker.length; }
      else if (fenceChar === char && marker.length >= fenceLen && /^\s*$/.test(line.slice(fence[0].length))) {
        fenceChar = null;
        closed = Math.min(text.length, at);
        segStart = closed;
      }
      continue;
    }
    if (fenceChar !== null) continue;
    if (line.trim() === "") {
      const prev = lines[i - 1] ?? "";
      const next = lines[i + 1] ?? "";
      if (LIST_ITEM.test(prev) && LIST_ITEM.test(next)) continue;
      // A blank line as the last line closes the paragraph: the next delta
      // will start a new one, so everything so far is final.
      if (next.trim() === "") { closed = Math.min(text.length, at); segStart = closed; continue; }
      closed = Math.min(text.length, at);
      segStart = closed;
    }
  }
  return closed;
}

const mix = (a: string, b: string, amount: number): string => {
  const rgb = (value: string) => [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16));
  const aa = rgb(a), bb = rgb(b);
  return `#${aa.map((value, i) => Math.round(value * amount + bb[i]! * (1 - amount)).toString(16).padStart(2, "0")).join("")}`;
};

function blockColor(block: TranscriptBlock, theme: Theme): string {
  if (block.state === "fail" || block.kind === "error") return theme.err;
  if (block.state === "ok") return theme.ok;
  if (block.kind === "user") return theme.warn;
  if (block.kind === "code" || block.kind === "diff") return theme.purple;
  if (block.kind === "chrome" || block.kind === "thinking") return theme.dim;
  return theme.accent;
}

export function blockTint(block: TranscriptBlock, theme: Theme): string | undefined {
  if (block.kind === "thinking") return undefined;
  const semantic = block.kind === "user" ? theme.warn : block.kind === "moh" ? theme.accent : block.kind === "code" || block.kind === "diff" ? theme.purple : block.kind === "error" ? theme.err : theme.dim;
  return mix(semantic, theme.bg, block.kind === "error" ? 0.2 : block.kind === "chrome" ? 0.07 : 0.14);
}

function Row({ width, bg, indent = 0, children }: { width: number; bg?: string; indent?: number; children: React.ReactNode }) {
  return <Box width={Math.max(1, width - 1)} backgroundColor={bg} paddingLeft={indent} flexShrink={0}><Text>{children}</Text></Box>;
}

const sameKinds = (a: string[] | undefined, b: string[] | undefined): boolean => {
  if (!a || !b) return !a && !b;
  return a.length === b.length && a.every((kind, i) => kind === b[i]);
};

const sameBlock = (a: TranscriptBlock, b: TranscriptBlock): boolean =>
  a.key === b.key && a.kind === b.kind && a.glyph === b.glyph && a.type === b.type && a.continuation === b.continuation
  && a.detail === b.detail && a.markdown === b.markdown && a.state === b.state && a.usage?.inputTokens === b.usage?.inputTokens
  && a.usage?.outputTokens === b.usage?.outputTokens
  && a.lines.length === b.lines.length && a.lines.every((line, i) => line === b.lines[i])
  && sameKinds(a.lineKinds, b.lineKinds);

/**
 * Content-compared memo: projection rebuilds every block object per event
 * (ref equality is useless), but unchanged blocks must not re-render —
 * each re-render repaints its rows, which at streaming rates is O(n²)
 * output and froze the UI (session 20260825T062108113Z regression).
 */
export const TranscriptBlockView = React.memo(function TranscriptBlockView({ block, width }: { block: TranscriptBlock; width: number }) {
  const theme = useTheme();
  const color = blockColor(block, theme);
  const bg = blockTint(block, theme);
  const detail = block.usage ? `${block.usage.inputTokens.toLocaleString()} in · ${block.usage.outputTokens.toLocaleString()} out${block.detail ? ` · ${block.detail}` : ""}` : block.detail;
  const contentWidth = Math.max(20, width - 6);
  const markdown = useMemo(() => block.markdown ? createMarkdownRenderer(theme, contentWidth) : null, [block.markdown, theme, contentWidth]);
  return (
    <Box flexDirection="column">
      {/* One blank row separates blocks (not head from body): a block opens
          with a top margin so the head sits directly above its body (#211). */}
      {block.continuation ? null : <Text> </Text>}
      {block.continuation ? null : <Row width={width} bg={bg}><Text color={color}>{block.glyph} {block.type}</Text>{detail && <Text color={theme.dim}> {detail}</Text>}</Row>}
      {block.markdown && markdown ? (
        <>
          {/* Segments split exactly at blank lines (trimmed per segment),
              so restore the single GFM inter-block blank row here — heading
              and hr paragraphs get their spacing back without doubles. */}
          {block.continuation ? <Box width={Math.max(1, width - 1)} backgroundColor={bg} flexShrink={0}><Text> </Text></Box> : null}
          <Markdown text={block.markdown} md={markdown} width={contentWidth} rowWidth={width} bg={bg} />
        </>
      ) : block.lines.map((line, index) => {
        const lineKind = block.lineKinds?.[index];
        const lineColor = block.kind === "diff" ? (line.startsWith("+") ? theme.ok : line.startsWith("-") ? theme.err : theme.dim) : block.kind === "error" ? theme.err : block.kind === "thinking" || lineKind === "answer" ? theme.dim : block.kind === "tool" ? theme.dim : lineKind === "heading" ? theme.accent : lineKind === "ask" ? theme.purple : theme.fg;
        const stateGlyph = block.kind === "tool" ? line.match(/^(.*?)(\s[✓✗◌])$/) : null;
        const body = stateGlyph
          ? <><Text color={lineColor}>{stateGlyph[1]}</Text><Text color={stateGlyph[2]!.includes("✓") ? theme.ok : stateGlyph[2]!.includes("✗") ? theme.err : theme.accent}>{stateGlyph[2]}</Text></>
          : <Text color={lineColor} bold={lineKind === "heading"} italic={block.kind === "thinking"}>{line || " "}</Text>;
        if (lineKind === "heading") return <React.Fragment key={index}><Row width={width} bg={bg} indent={4}>{body}</Row><Row width={width} bg={bg} indent={4}><Text color={theme.border}>{"─".repeat(Math.min(line.length, 40))}</Text></Row></React.Fragment>;
        return <Row key={index} width={width} bg={bg} indent={lineKind === "bullet" ? 6 : 4}>{body}</Row>;
      })}
    </Box>
  );
}, (prev, next) => prev.width === next.width && sameBlock(prev.block, next.block));
