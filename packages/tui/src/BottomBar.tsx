import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { useTheme, type Theme } from "./themes";
import { CONTEXT_WINDOW_DEFAULT, contextFraction, type SidebarTokens } from "./sidebar";
import { fitRow } from "./viewport";

export type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh";
export type ChipAction = "send" | "stop" | "model" | "mode" | "theme" | "commands" | "settings" | "workflow" | "frontier";
export interface ChipSpec { key: string; label: ChipAction; color?: "purple" }

const ALL_CHIPS: ChipSpec[] = [
  { key: "⏎", label: "send" }, { key: "esc", label: "stop" },
  { key: "^m", label: "model" }, { key: "^o", label: "mode" },
  { key: "^t", label: "theme" }, { key: "^k", label: "commands" },
  { key: "^s", label: "settings" }, { key: "^w", label: "workflow", color: "purple" },
  { key: "^f", label: "frontier", color: "purple" },
];

export const widthClass183 = (columns: number): "compact" | "regular" | "wide" => columns < 70 ? "compact" : columns < 110 ? "regular" : "wide";

const compactChipWidth = (chip: ChipSpec) => 5 + chip.key.length + chip.label.length;
const graphicChipWidth = (chip: ChipSpec) => 5 + chip.key.length + chip.label.length;
export function visibleChips(columns: number): { chips: ChipSpec[]; graphic: boolean } {
  const budget = Math.max(1, columns - 4);
  const initial = widthClass183(columns) === "compact" ? ALL_CHIPS.slice(0, 4) : [...ALL_CHIPS];
  const graphicWidth = initial.reduce((sum, chip) => sum + graphicChipWidth(chip) + 2, -2);
  if (graphicWidth <= budget) return { chips: initial, graphic: true };
  const chips = [...initial];
  while (chips.length > 1 && chips.reduce((sum, chip) => sum + compactChipWidth(chip) + 1, -1) > budget) chips.pop();
  return { chips, graphic: false };
}

const RAINBOW = ["#ff0055", "#ff9500", "#ffd500", "#5dff5d", "#00c8ff", "#7a5cff", "#d94fff"];
export function ThinkingSeparator({ level, width }: { level: ThinkingLevel; width: number }) {
  const theme = useTheme();
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (level !== "xhigh") return;
    const timer = setInterval(() => setPhase((value) => value + 1), 120);
    return () => clearInterval(timer);
  }, [level]);
  const count = Math.max(1, width - 1);
  if (level === "xhigh") return <Text bold>{Array.from({ length: count }, (_, i) => <Text key={i} color={RAINBOW[(i + phase) % RAINBOW.length]}>═</Text>)}</Text>;
  const single = level === "off" || level === "low";
  const color = single ? theme.dim : level === "medium" ? theme.accent : theme.purple;
  return <Text color={color} bold={!single}>{(single ? "─" : "═").repeat(count)}</Text>;
}

export function thinkingEmoji(level: ThinkingLevel): string {
  return ({ off: "·", low: "🌱", medium: "⚙️", high: "🧠✨", xhigh: "🧠🔥" } as const)[level];
}

interface StatusProps {
  width: number;
  pending: boolean;
  spinner: string;
  mode: "vibe" | "dev";
  model: string;
  turns: number;
  tokens: SidebarTokens;
  level: ThinkingLevel;
  workflowOn?: boolean;
  memoryFresh?: boolean;
  phase?: string;
  notice?: string;
}

function ContextBar({ tokens, width, theme }: { tokens: number; width: number; theme: Theme }) {
  const fraction = contextFraction(tokens);
  const cells = widthClass183(width) === "compact" ? 8 : widthClass183(width) === "wide" ? 16 : 12;
  const filled = Math.round(fraction * cells);
  const color = fraction > 0.8 ? theme.err : fraction > 0.6 ? theme.warn : theme.ok;
  return <Text><Text color={theme.border}>[</Text><Text color={color}>{"█".repeat(filled)}</Text><Text color={theme.border}>{"·".repeat(cells - filled)}]</Text></Text>;
}

/** Prototype-compatible segment fitting: optional segments drop from the
 * end; if required content still overflows, the longest segment truncates. */
export const fitStatusSegments = fitRow;

function StatusRow(props: StatusProps) {
  const theme = useTheme();
  const cls = widthClass183(props.width);
  const fraction = contextFraction(props.tokens.contextIn);
  const tokenColor = fraction > 0.8 ? theme.err : fraction > 0.6 ? theme.warn : theme.dim;
  const rawLeft = props.pending
    ? `${props.spinner}${cls === "compact" ? "" : ` ${props.phase ?? (props.mode === "vibe" ? "thinking" : "streaming")}`}`
    : props.notice ? `· ${props.notice}` : props.turns ? "✓ done" : "· ready";
  const left = fitRow([{ text: rawLeft }], Math.max(3, Math.floor((props.width - 4) / 3)))[0] ?? "";
  const model = cls === "compact" ? `◆ ${props.model}` : `◆ ${props.model} ${thinkingEmoji(props.level)}${props.level === "off" ? "" : ` ${props.level}`}`;
  const right = fitStatusSegments([
    { text: props.tokens.contextIn > 0 ? `⊣ ${(props.tokens.contextIn / 1000).toFixed(1)}k` : "", optional: true },
    { text: `↻ ${props.turns}`, optional: true },
    { text: model },
    { text: props.workflowOn ? "◈ wf" : "", optional: true },
    { text: props.mode === "dev" ? "◉ dev" : "○ vibe", optional: true },
  ].filter((item) => item.text), Math.max(1, props.width - left.length - (props.tokens.contextIn ? (cls === "compact" ? 12 : cls === "wide" ? 20 : 16) : 0) - 5));
  const statusColor = (text: string): string => {
    if (text.startsWith("⊣")) return tokenColor;
    if (text === "◈ wf" || (text.startsWith("◆") && (props.level === "high" || props.level === "xhigh"))) return theme.purple;
    if (text.startsWith("◆")) return theme.fg;
    if (text === "◉ dev") return theme.accent;
    return theme.dim;
  };
  return <Box width={Math.max(1, props.width - 1)} justifyContent="space-between" flexWrap="nowrap" paddingX={1}>
    <Box gap={1}><Text color={props.pending ? theme.accent : theme.dim}>{left}</Text>{props.memoryFresh && <Text color={theme.purple}>{cls === "wide" ? "◍ memory" : "◍"}</Text>}</Box>
    <Box gap={1} flexWrap="nowrap">{props.tokens.contextIn > 0 && <ContextBar tokens={props.tokens.contextIn} width={props.width} theme={theme} />}{right.map((text, index) => <Text key={index} color={statusColor(text)}>{text}</Text>)}</Box>
  </Box>;
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
