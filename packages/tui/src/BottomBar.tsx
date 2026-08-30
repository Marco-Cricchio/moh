import React from "react";
import { Box, Text } from "ink";
import { useTheme, type Theme } from "./themes";
import { CONTEXT_WINDOW_DEFAULT, contextFraction, type SidebarTokens } from "./sidebar";
import { fitRow } from "./viewport";
import type { ThinkingLevel } from "@moh/core";

/** TUI chrome also names the absence of an explicit canonical request. */
export type DisplayThinkingLevel = ThinkingLevel | "default";
export type ChipAction = "send" | "stop" | "model" | "mode" | "commands" | "settings" | "workflow" | "frontier";
export interface ChipSpec { key: string; label: ChipAction; color?: "purple" }

const ALL_CHIPS: ChipSpec[] = [
  { key: "⏎", label: "send" }, { key: "esc", label: "stop" },
  { key: "^m", label: "model" }, { key: "^o", label: "mode" },
  { key: "^k", label: "commands" },
  { key: "^s", label: "settings" }, { key: "^w", label: "workflow", color: "purple" },
  { key: "^f", label: "frontier", color: "purple" },
];

export const widthClass183 = (columns: number): "compact" | "regular" | "wide" => columns < 70 ? "compact" : columns < 110 ? "regular" : "wide";

const compactChipWidth = (chip: ChipSpec) => 5 + chip.key.length + chip.label.length;
const graphicChipWidth = (chip: ChipSpec) => 5 + chip.key.length + chip.label.length;
export function visibleChips(columns: number): { chips: ChipSpec[]; graphic: boolean } {
  const budget = Math.max(1, columns - 4);
  const cls = widthClass183(columns);
  const initial = cls === "compact" ? ALL_CHIPS.slice(0, 4) : [...ALL_CHIPS];
  const graphicWidth = initial.reduce((sum, chip) => sum + graphicChipWidth(chip) + 2, -2);
  if (graphicWidth <= budget) return { chips: initial, graphic: true };
  // Wide terminals retain the bordered dashboard grammar and drop
  // rightmost optional chips until it fits. This keeps the validated 140-col
  // layout stable as new actions are added; ctrl shortcuts remain available.
  if (cls === "wide") {
    const chips = [...initial];
    while (chips.length > 1 && chips.reduce((sum, chip) => sum + graphicChipWidth(chip) + 2, -2) > budget) chips.pop();
    return { chips, graphic: true };
  }
  const chips = [...initial];
  while (chips.length > 1 && chips.reduce((sum, chip) => sum + compactChipWidth(chip) + 1, -1) > budget) chips.pop();
  return { chips, graphic: false };
}

export function ThinkingSeparator({ level, width }: { level: DisplayThinkingLevel; width: number }) {
  const theme = useTheme();
  const count = Math.max(1, width - 1);
  const single = level === "default" || level === "off" || level === "low";
  const color = single ? theme.dim : level === "medium" ? theme.accent : theme.purple;
  return <Text color={color} bold={!single}>{"─".repeat(count)}</Text>;
}

export function thinkingEmoji(level: DisplayThinkingLevel): string {
  return ({ default: "·", off: "·", low: "🌱", medium: "⚙️", high: "🧠✨", xhigh: "🧠🔥", max: "🧠⚡" } as const)[level];
}

interface StatusProps {
  width: number;
  pending: boolean;
  spinner: string;
  mode: "vibe" | "dev";
  model: string;
  turns: number;
  tokens: SidebarTokens;
  /** Denominator of the context bar: the active model's declared window
   * from the vendored catalog, or CONTEXT_WINDOW_DEFAULT when unknown. */
  contextLimit?: number;
  level: DisplayThinkingLevel;
  /** #256: unsupported stored preference marker (dim ✗⚙ next to the
   * model segment — visible, never a prompt). */
  unsupportedLevel?: ThinkingLevel;
  workflowOn?: boolean;
  memoryFresh?: boolean;
  phase?: string;
  notice?: string;
  /** Current git branch, when the cwd is a repository (both modes). */
  branch?: string | null;
  /** Session working directory: shown in both modes, middle-elided when it
   * exceeds the class-aware budget so the start and — above all — the end
   * (the project dir) stay visible. */
  cwd?: string;
  /** #328: active update notice — left-aligned on row 2; the right-aligned
   * cwd/branch/mode tail is never displaced or dropped (the notice elides). */
  updateMessage?: string;
}

function ContextBar({ tokens, limit, width, theme }: { tokens: number; limit: number; width: number; theme: Theme }) {
  const fraction = contextFraction(tokens, limit);
  const cells = widthClass183(width) === "compact" ? 8 : widthClass183(width) === "wide" ? 16 : 12;
  const filled = Math.round(fraction * cells);
  const color = fraction > 0.8 ? theme.err : fraction > 0.6 ? theme.warn : theme.ok;
  return <Text><Text color={theme.border}>[</Text><Text color={color}>{"█".repeat(filled)}</Text><Text color={theme.border}>{"·".repeat(cells - filled)}]</Text></Text>;
}

/** Prototype-compatible segment fitting: optional segments drop from the
 * end; if required content still overflows, the longest segment truncates. */
export const fitStatusSegments = fitRow;

/** Middle-elision for the cwd label: keeps the head and — more importantly —
 * the tail (the project directory) visible, collapsing the middle to `…`.
 * Only applied once the label exceeds `max`. */
export function middleElide(value: string, max: number): string {
  if (value.length <= max) return value;
  const keep = Math.max(1, max - 1);
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

function StatusRow(props: StatusProps) {
  const theme = useTheme();
  const cls = widthClass183(props.width);
  const contextLimit = props.contextLimit ?? CONTEXT_WINDOW_DEFAULT;
  const fraction = contextFraction(props.tokens.contextIn, contextLimit);
  const tokenColor = fraction > 0.8 ? theme.err : fraction > 0.6 ? theme.warn : theme.dim;
  const rawLeft = props.pending
    ? `${props.spinner}${cls === "compact" ? "" : ` ${props.phase ?? (props.mode === "vibe" ? "thinking" : "streaming")}`}`
    : props.notice ? `· ${props.notice}` : props.turns ? "✓ done" : "· ready";
  const left = fitRow([{ text: rawLeft }], Math.max(3, Math.floor((props.width - 4) / 3)))[0] ?? "";
  const model = cls === "compact" ? `◆ ${props.model}` : `◆ ${props.model} ${thinkingEmoji(props.level)}${props.level === "off" ? "" : ` ${props.level}`}`;
  // Vibe keeps plain language: the token count and turn counter stay dev-only
  // (#193), but the context bar renders in both modes (#229) — a wordless
  // fill gauge needs no numbers to be read.
  const vibe = props.mode === "vibe";
  // ── Row 1: the turn/model state. Spinner or notice on the left, context
  // gauge plus dev-only numbers and the model on the right.
  const row1 = fitStatusSegments([
    { text: !vibe && props.tokens.contextIn > 0 ? `⊣ ${(props.tokens.contextIn / 1000).toFixed(1)}k` : "", optional: true },
    { text: !vibe ? `↻ ${props.turns}` : "", optional: true },
    { text: model },
    // #256: unsupported stored preference — kept intact, resolved to the
    // provider default; shown as a dim marker so the mismatch is visible
    // (the full wording lives in /thinking; segments stay short).
    { text: props.unsupportedLevel ? `default·✗⚙ ${props.unsupportedLevel}` : "", optional: true },
    { text: props.workflowOn ? "◈ wf" : "", optional: true },
  ].filter((item) => item.text), Math.max(1, props.width - left.length - (!vibe && props.tokens.contextIn ? (cls === "compact" ? 12 : cls === "wide" ? 20 : 16) : 0) - 5));
  const row1Color = (text: string): string => {
    if (text.startsWith("⊣")) return tokenColor;
    if (text === "◈ wf" || (text.startsWith("◆") && (props.level === "high" || props.level === "xhigh"))) return theme.purple;
    if (text.startsWith("◆")) return theme.fg;
    if (text.startsWith("default·✗⚙")) return theme.warn;
    return theme.dim;
  };
  // ── Row 2: where you are — cwd, branch, mode. The cwd leads and is
  // middle-elided to its class budget so head and (above all) the tail —
  // the project directory — stay readable; the branch truncates from the
  // end only in the rare overflow; the mode chip is never dropped.
  // Segments are space-joined explicitly: ink's `gap` is unreliable on a
  // right-aligned nested row (segments render glued).
  const cwdBudget = cls === "compact" ? 18 : cls === "wide" ? 44 : 30;
  const row2 = fitStatusSegments([
    { text: props.cwd ? `▣ ${middleElide(props.cwd, cwdBudget)}` : "" },
    { text: props.branch ? `⎇ ${props.branch}` : "" },
    { text: props.mode === "dev" ? "◉ dev" : "○ vibe" },
  ].filter((item) => item.text), Math.max(1, props.width - 4));
  const row2Color = (text: string): string => {
    if (text.startsWith("▣")) return theme.dim;
    if (text.startsWith("⎇")) return theme.ok;
    if (text === "◉ dev") return theme.accent;
    return theme.dim;
  };
  // #328: an active update notice leads row 2, left-aligned; the tail keeps
  // the full row budget and the notice elides to whatever remains.
  const row2Text = row2.join(" ");
  const noticeBudget = Math.max(0, props.width - 4 - row2Text.length - 1);
  const noticeText = props.updateMessage && noticeBudget >= 4
    ? props.updateMessage.length <= noticeBudget
      ? props.updateMessage
      : `${props.updateMessage.slice(0, noticeBudget - 1)}…`
    : null;
  return (
    <Box flexDirection="column" width={Math.max(1, props.width - 1)}>
      <Box justifyContent="space-between" flexWrap="nowrap" paddingX={1}>
        <Box gap={1}><Text color={props.pending ? theme.accent : theme.dim}>{left}</Text>{props.memoryFresh && <Text color={theme.purple}>{cls === "wide" ? "◍ memory" : "◍"}</Text>}</Box>
        <Box gap={1} flexWrap="nowrap">{props.tokens.contextIn > 0 && <ContextBar tokens={props.tokens.contextIn} limit={contextLimit} width={props.width} theme={theme} />}{row1.map((text, index) => <Text key={index} color={row1Color(text)}>{text}</Text>)}</Box>
      </Box>
      {row2 && (
        <Box justifyContent="space-between" flexWrap="nowrap" paddingX={1}>
          {noticeText !== null && <Text color={theme.warn} wrap="truncate">{noticeText}</Text>}
          <Box justifyContent="flex-end" flexWrap="nowrap">
            <Text>{row2.map((text, index) => <React.Fragment key={index}>{index > 0 ? " " : ""}<Text color={row2Color(text)}>{text}</Text></React.Fragment>)}</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

function KeyRow({ width, focused }: { width: number; focused: number | null }) {
  const theme = useTheme();
  const { chips, graphic } = visibleChips(width);
  return <Box width={Math.max(1, width - 1)} justifyContent="center" gap={graphic ? 2 : 1} flexWrap="nowrap" marginTop={1}>
    {chips.map((chip, index) => graphic ? (
      <Box key={chip.label} borderStyle="round" borderColor={focused === index ? theme.accent : theme.border} paddingX={1} flexShrink={0}>
        <Text color={focused === index ? theme.accent : theme.fg} bold>{chip.key} </Text><Text color={chip.color === "purple" ? theme.purple : focused === index ? theme.accent : theme.dim}>{chip.label}</Text>
      </Box>
    ) : (
      <Text key={chip.label} backgroundColor={focused === index ? theme.accent : undefined} color={focused === index ? theme.bg : theme.fg}>( <Text color={focused === index ? theme.bg : theme.accent}>{chip.key} </Text>{chip.label} )</Text>
    ))}
  </Box>;
}

export function BottomBar(props: StatusProps & { focusedChip: number | null }) {
  return <Box flexDirection="column"><StatusRow {...props} /><KeyRow width={props.width} focused={props.focusedChip} /></Box>;
}

export { CONTEXT_WINDOW_DEFAULT };
