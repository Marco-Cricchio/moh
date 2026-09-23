import React from "react";
import { selectionStyle } from "./color";
import { Box, Text } from "ink";
import { useTheme, type PaintableTheme } from "./themes";
import { CONTEXT_WINDOW_DEFAULT, contextFraction, type SidebarTokens } from "./sidebar";
import { fitRow, type WidthClass } from "./viewport";
import type { ExtensionStatus, SessionMode, ThinkingLevel } from "@moh/core";
import type { JevStatusSummary } from "./jev-control";
import { scannerPaint, scannerStripSplit } from "./scanner";

/** TUI chrome also names the absence of an explicit canonical request. */
export type DisplayThinkingLevel = ThinkingLevel | "default";
export type ChipAction = "send" | "stop" | "model" | "mode" | "commands" | "settings" | "workflow" | "frontier" | "keep";
export interface ChipSpec { key: string; label: ChipAction; color?: "purple" }

const ALL_CHIPS: ChipSpec[] = [
  { key: "⏎", label: "send" }, { key: "esc", label: "stop" },
  { key: "^m", label: "model" }, { key: "^o", label: "mode" },
  { key: "^k", label: "commands" },
  { key: "^s", label: "settings" }, { key: "^w", label: "workflow", color: "purple" },
  { key: "^f", label: "frontier", color: "purple" },
];

/** #581: the growth warning's primary chip — prepended only while the
 * external-growth warning is up (spec §6: keep my branch primary, fork
 * secondary). Enter on the chip appends `branch_switched { to: localTip }`. */
const KEEP_CHIP: ChipSpec = { key: "^g", label: "keep" };

export const widthClass183 = (columns: number): "compact" | "regular" | "wide" => columns < 70 ? "compact" : columns < 110 ? "regular" : "wide";

const compactChipWidth = (chip: ChipSpec) => 5 + chip.key.length + chip.label.length;
const graphicChipWidth = (chip: ChipSpec) => 5 + chip.key.length + chip.label.length;
export function visibleChips(columns: number, keepMyBranch = false): { chips: ChipSpec[]; graphic: boolean } {
  const budget = Math.max(1, columns - 4);
  const cls = widthClass183(columns);
  const all = keepMyBranch ? [KEEP_CHIP, ...ALL_CHIPS] : ALL_CHIPS;
  const initial = cls === "compact" ? all.slice(0, 4) : [...all];
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
  /** #619: live MPM projection state for the first status row — null when
   * MPM never activated (nothing renders, never a placeholder). */
  mpmStatus?: "ready" | "updating" | "unavailable" | null;
  /** ADR-0032 (#784): statuses extensions currently publish, in
   * registration order (empty when none) — one dim chip each. */
  extensionStatuses?: ExtensionStatus[];
  /** #876: what the Jev extension is doing for this session (null = no
   * chip: not registered, or nothing read yet). Polled by the client off
   * the extension's own snapshot — never published through the status
   * seam, whose single writer is the outage text. */
  jevStatus?: JevStatusSummary | null;
  /** #466/ADR-0022: sticky compaction-failure indicator — set by
   * `compaction_failed`, cleared by the next successful marker. */
  compactionFailed?: boolean;
  /** #468/ADR-0020: sticky external-growth warning with the fork hint —
   * set by `session_file_growth`, cleared by the explicit fork. */
  growthWarning?: number | null;
  /** #936: the browser tool is enabled but its toolchain is missing (this
   * open observed it) — the row-1 alarm carries the setup key, and the
   * guided setup modal is one ctrl+b away. Chrome only: the session runs
   * without the optional tool. */
  browserSetup?: boolean;
  /** #581: keep-my-branch primary chip (⏎ activates while growth warns):
   * appends `branch_switched { to: localTip }` through the session seam.
   * Fork (/fork) stays the secondary recovery chip. */
  onKeepMyBranch?: () => void;
  phase?: string;
  notice?: string;
  /** #377/#849/#876: the session's live permission mode, read from
   * `AgentSession.sessionMode` (the launch flag seeds it, the in-session
   * shift+tab rotation moves it). One value drives both the left banner
   * (`yolo`) and the tail chip. Absent = the client has no mode to show:
   * nothing renders, never a guessed default. */
  permissionMode?: SessionMode;
  /** Current git branch, when the cwd is a repository (both modes). */
  branch?: string | null;
  /** Session working directory: shown in both modes, middle-elided when it
   * exceeds the class-aware budget so the start and — above all — the end
   * (the project dir) stay visible. */
  cwd?: string;
  /** #918/ADR-0044: the session's project root resolves under `/mnt/` (a
   * Windows drive mounted into WSL), read from `session.rootOnWindowsMount`.
   * The footer then carries one persistent, never-blocking hint line above
   * the status rows; absent = nothing renders (the distro-filesystem case).
   * Never a warning icon on the status row itself: the fact is environment
   * information, and the footer's own rows keep their width. */
  rootOnWindowsMount?: boolean;
  /** #328: active update notice — left-aligned on row 2; the right-aligned
   * cwd/branch/mode tail is never displaced or dropped (the notice elides). */
  updateMessage?: string;
}

/** #619: the MPM status chip on the first status row, next to memory.
 * Silent and inspectable (owner decision): ✓ ready / ↻ updating / —
 * unavailable, with the word only when the terminal is wide. */
export function MpmStatusChip({ status, wide, theme }: { status: "ready" | "updating" | "unavailable"; wide: boolean; theme: PaintableTheme }) {
  const spec = status === "ready"
    ? { glyph: "✓", color: theme.ok }
    : status === "updating"
      ? { glyph: "↻", color: theme.accent }
      : { glyph: "—", color: theme.dim };
  const label = status === "ready" ? "map" : status === "updating" ? "mapping" : "no map";
  return <Text color={spec.color}>{wide ? `${spec.glyph} ${label}` : spec.glyph}</Text>;
}

/** #876: the Jev chip — one glyph and one word for the whole extension, at
 * the end of row 1's left cluster. The seven use cases are independent, so
 * the chip summarizes (does it judge, is it switched off, can it act at
 * all) and `/jev` keeps the detail. Compact terminals keep the glyph; no
 * chip at all when the client has no snapshot to read — the bar never makes
 * a claim it cannot back. The outage text (`∅ jev offline`) is a different
 * thing on a different seam (ADR-0032's status), and stays there. */
export function JevStatusChip({ status, labelled, theme }: { status: JevStatusSummary; labelled: boolean; theme: PaintableTheme }) {
  const spec = status === "active"
    ? { word: "active", color: theme.ok }
    : status === "off"
      ? { word: "off", color: theme.dim }
      : { word: "inert", color: theme.warn };
  return <Text color={spec.color}>{labelled ? `◈ jev ${spec.word}` : "◈"}</Text>;
}

/** ADR-0032 (#784): one dim chip per status an extension currently
 * publishes, next to the MPM chip. The text is the extension's own string;
 * the extension's name leads it so two extensions' statuses never read as
 * one. Compact terminals drop the name — the texts carry their own marker
 * (e.g. `∅ jev offline`) and the row must stay a row. */
export function ExtensionStatusChip({ status, wide, theme }: { status: ExtensionStatus; wide: boolean; theme: PaintableTheme }) {
  return <Text color={theme.dim} wrap="truncate">{wide ? `${status.extension} ${status.text}` : status.text}</Text>;
}

function ContextBar({ tokens, limit, width, theme }: { tokens: number; limit: number; width: number; theme: PaintableTheme }) {
  const fraction = contextFraction(tokens, limit);
  const cells = widthClass183(width) === "compact" ? 8 : widthClass183(width) === "wide" ? 16 : 12;
  const filled = Math.round(fraction * cells);
  const color = fraction > 0.8 ? theme.err : fraction > 0.6 ? theme.warn : theme.ok;
  return <Text><Text color={theme.border}>[</Text><Text color={color}>{"█".repeat(filled)}</Text><Text color={theme.border}>{"·".repeat(cells - filled)}]</Text></Text>;
}

/** Prototype-compatible segment fitting: optional segments drop from the
 * end; if required content still overflows, the longest segment truncates. */
export const fitStatusSegments = fitRow;

/** #876/ADR-0042: the pending left slot — the liveness scanner strip rendered
 * cell by cell, so the light leads in the theme's true red, the trail recedes
 * behind it and the unlit track stays `dim`. Whatever the module does not
 * claim as a cell (the phase word, or a caller passing the older braille
 * frame) keeps the slot's own colour. */
function ScannerText({ text, theme }: { text: string; theme: PaintableTheme }) {
  const { strip, rest } = scannerStripSplit(text);
  return (
    <Text color={theme.accent}>
      {strip.map((cell, index) => {
        const paint = scannerPaint(cell.level);
        return <Text key={index} color={theme[paint.token]} bold={paint.bold} dimColor={paint.dim}>{cell.glyph}</Text>;
      })}
      {rest}
    </Text>
  );
}

/** #876: the permission-mode indicator — the mode in force, spoken on the
 * **left** of row 2, where the yolo banner has always been (owner decision:
 * the mode is a statement about the session, not a property of where you
 * are, so it does not belong beside the projection chip on the right).
 *
 * Copy is capitalized (unlike the rest of the bar) and each value owns one
 * token: `normal` is dim, `auto-accept` warns — it grants every prompt
 * without asking — and `yolo` keeps the true-red alarm, back to its full
 * wording now that the tail no longer competes for the row. The text is the
 * first thing to go when the width class is tight; the glyph stays, and
 * `◌ ◐ ⚠` stay unambiguous against the glyphs already in use
 * (`▣ ⎇ ◉ ○ ◍ ✓ ∅ ↻ ⚠`). */
function permissionModeLead(mode: SessionMode, cls: WidthClass): { text: string; color: "dim" | "warn" | "err" } {
  if (mode === "yolo") {
    return { text: cls === "wide" ? "⚠ YOLO — unrestricted tools" : cls === "regular" ? "⚠ YOLO" : "⚠", color: "err" };
  }
  const spec = mode === "auto-accept" ? { glyph: "◐", label: "Auto-Accept" } : { glyph: "◌", label: "Normal" };
  return { text: cls === "compact" ? spec.glyph : `${spec.glyph} ${spec.label}`, color: mode === "auto-accept" ? "warn" : "dim" };
}

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
  const row1Color = (text: string): string | undefined => {
    if (text.startsWith("⊣")) return tokenColor;
    if (text === "◈ wf" || (text.startsWith("◆") && (props.level === "high" || props.level === "xhigh"))) return theme.purple;
    if (text.startsWith("◆")) return theme.fg;
    if (text.startsWith("default·✗⚙")) return theme.warn;
    return theme.dim;
  };
  // ── Row 2: where you are — the permission mode on the left (the slot the
  // yolo banner has always used), then the right-aligned tail: cwd, branch,
  // projection chip (`◉ dev` / `○ vibe`). Segments are space-joined
  // explicitly: ink's `gap` is unreliable on a right-aligned nested row
  // (segments render glued).
  const projectionChip = props.mode === "dev" ? "◉ dev" : "○ vibe";
  const modeLead = props.permissionMode ? permissionModeLead(props.permissionMode, cls) : null;
  // #876: the mode lead is never dropped, so it reserves its space first and
  // the cwd — the only middle-elidable segment — is fitted to what remains:
  // its head and (above all) the project directory stay readable instead of
  // being truncated from the end. The branch keeps truncating in the rare
  // overflow that is left over.
  const tailBudget = Math.max(1, props.width - 4 - (modeLead ? modeLead.text.length + 1 : 0));
  const fixedTail = [
    props.branch ? `⎇ ${props.branch}` : "",
    projectionChip,
  ].filter((text) => text !== "");
  const fixedTailWidth = fixedTail.reduce((sum, text) => sum + text.length + 1, 0);
  // The floor keeps the cwd's elision marker alive ("▣ he…ail"); when the
  // residual is under it the longest remaining segment is the branch, so the
  // overflow costs the branch characters, never the cwd's shape.
  const cwdBudget = Math.min(cls === "compact" ? 18 : cls === "wide" ? 44 : 30, Math.max(4, tailBudget - fixedTailWidth - 2));
  const row2 = fitStatusSegments([
    { text: props.cwd ? `▣ ${middleElide(props.cwd, cwdBudget)}` : "" },
    ...fixedTail.map((text) => ({ text })),
  ].filter((item) => item.text), tailBudget);
  const row2Color = (text: string): string | undefined => {
    if (text.startsWith("▣")) return theme.dim;
    if (text.startsWith("⎇")) return theme.ok;
    if (text === "◉ dev") return theme.accent;
    return theme.dim;
  };
  // #328: an active update notice follows the mode lead in the same left
  // slot, elided to whatever budget remains — a session still learns about
  // updates instead of losing the notice entirely.
  const row2Text = row2.join(" ");
  const noticeLead = modeLead !== null ? `${modeLead.text} · ` : "";
  const noticeBudget = Math.max(0, props.width - 4 - row2Text.length - 1 - noticeLead.length);
  const noticeText = props.updateMessage && noticeBudget >= 4
    ? props.updateMessage.length <= noticeBudget
      ? props.updateMessage
      : `${props.updateMessage.slice(0, noticeBudget - 1)}…`
    : null;
  return (
    <Box flexDirection="column" width={Math.max(1, props.width - 1)}>
      <Box justifyContent="space-between" flexWrap="nowrap" paddingX={1}>
        <Box gap={1}>{props.pending ? <ScannerText text={left} theme={theme} /> : <Text color={theme.dim}>{left}</Text>}{props.memoryFresh && <Text color={theme.purple}>{cls === "wide" ? "◍ memory" : "◍"}</Text>}{props.mpmStatus != null && <MpmStatusChip status={props.mpmStatus} wide={cls === "wide"} theme={theme} />}{(props.extensionStatuses ?? []).map((status) => <ExtensionStatusChip key={status.extension} status={status} wide={cls === "wide"} theme={theme} />)}{props.jevStatus != null && <JevStatusChip status={props.jevStatus} labelled={cls !== "compact"} theme={theme} />}{props.compactionFailed && <Text color={theme.err}>{cls === "wide" ? "⚠ compaction failed — retrying" : "⚠"}</Text>}{props.growthWarning != null && <Text color={theme.err}>{cls === "wide" ? `⚡ file grew externally ×${props.growthWarning} — ^g keep my branch · /fork` : "⚡ keep my branch"}</Text>}{props.browserSetup && <Text color={theme.warn}>{cls === "wide" ? "⚠ browser tool unavailable — ^b install" : "⚠ browser"}</Text>}</Box>
        <Box gap={1} flexWrap="nowrap">{props.tokens.contextIn > 0 && <ContextBar tokens={props.tokens.contextIn} limit={contextLimit} width={props.width} theme={theme} />}{row1.map((text, index) => <Text key={index} color={row1Color(text)}>{text}</Text>)}</Box>
      </Box>
      {row2 && (
        <Box justifyContent={modeLead !== null || noticeText !== null ? "space-between" : "flex-end"} flexWrap="nowrap" paddingX={1}>
          {modeLead !== null && <Text color={theme[modeLead.color]} wrap="truncate">{modeLead.text}</Text>}
          {modeLead !== null && noticeText !== null && <Text color={theme.dim}> · </Text>}
          {noticeText !== null && <Text color={theme.warn} wrap="truncate">{noticeText}</Text>}
          <Box justifyContent="flex-end" flexWrap="nowrap">
            <Text>{row2.map((text, index) => <React.Fragment key={index}>{index > 0 ? " " : ""}<Text color={row2Color(text)}>{text}</Text></React.Fragment>)}</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

/**
 * #918/ADR-0044: the `/mnt` hint — one persistent, never-blocking line above
 * the status rows, rendered only while the session's project root resolves
 * under `/mnt/` (a Windows drive mounted into WSL, where every file
 * operation is dramatically slower). It gets its own row on purpose: it is
 * a standing fact about the project, not a chip competing with the live
 * status for the width of row 1, and it leaves the status rows byte-for-byte
 * unchanged for everyone else.
 *
 * The copy is self-sufficient at every width — what `/mnt` is, why it costs,
 * and what to do, never a pointer to the manual — and it degrades by
 * dropping the explanation, never the advice. Every tier fits the style
 * guide's 35-column floor untruncated (the compact one is the tightest: 31
 * of the 32 usable columns), because a truncated hint would cut exactly the
 * advice that earns it a row.
 */
const WINDOWS_MOUNT_HINT: Record<WidthClass, string> = {
  wide: "⚠ /mnt — a Windows drive in WSL: file I/O is dramatically slower; keep projects in Linux (~/projects)",
  regular: "⚠ /mnt — slow I/O (a Windows drive in WSL); keep projects in Linux",
  compact: "⚠ /mnt is slow — use ~/projects",
};

function WindowsMountHint({ width }: { width: number }) {
  const theme = useTheme();
  return <Box width={Math.max(1, width - 1)} paddingX={1} flexShrink={0}>
    <Text color={theme.warn} wrap="truncate">{WINDOWS_MOUNT_HINT[widthClass183(width)]}</Text>
  </Box>;
}

/** #497: the subagent chips row (footer row 0, above the action chips).
 * Owner spec: subagent chips live on their OWN row, not the action chips'
 * row. They degrade to a bare count (⊙N) when the terminal narrows and
 * disappear entirely when there are no subagents. */
function SubagentChipRow({ width, focusedSubagent, subagentChips }: { width: number; focusedSubagent?: number | null; subagentChips?: { label: string; glyph: string; active: boolean }[] }) {
  const theme = useTheme();
  const subs = subagentChips ?? [];
  if (subs.length === 0) return null;
  const compact = widthClass183(width) === "compact";
  const overCap = subs.filter((sub) => sub.label.startsWith("+")).length;
  const core = subs.filter((sub) => !sub.label.startsWith("+"));
  if (compact) {
    return <Box width={Math.max(1, width - 1)} justifyContent="center" flexShrink={0}>
      <Box borderStyle="round" borderColor={theme.border} paddingX={1} flexShrink={0}>
        <Text color={theme.dim}>⊙{core.length + overCap}</Text>
      </Box>
    </Box>;
  }
  return <Box width={Math.max(1, width - 1)} justifyContent="center" gap={2} flexWrap="nowrap" flexShrink={0}>
    {subs.map((sub, index) => (
      <Box key={`${index}-${sub.label}`} borderStyle="round" borderColor={focusedSubagent === index ? theme.accent : sub.active ? theme.accent : theme.border} paddingX={1} flexShrink={0}>
        <Text color={sub.active ? theme.accent : theme.dim}>{sub.glyph} </Text><Text color={focusedSubagent === index ? theme.accent : theme.fg} bold>{sub.label}</Text>
      </Box>
    ))}
  </Box>;
}

function KeyRow({ width, focused, keepMyBranch }: { width: number; focused: number | null; keepMyBranch?: boolean }) {
  const theme = useTheme();
  const { chips, graphic } = visibleChips(width, keepMyBranch);
  return <Box width={Math.max(1, width - 1)} justifyContent="center" gap={graphic ? 2 : 1} flexWrap="nowrap" marginTop={1}>
    {chips.map((chip, index) => graphic ? (
      <Box key={chip.label} borderStyle="round" borderColor={focused === index ? theme.accent : theme.border} paddingX={1} flexShrink={0}>
        <Text color={focused === index ? theme.accent : theme.fg} bold>{chip.key} </Text><Text color={chip.color === "purple" ? theme.purple : focused === index ? theme.accent : theme.dim}>{chip.label}</Text>
      </Box>
    ) : (
      <Text key={chip.label} {...(focused === index ? selectionStyle(theme) : { color: theme.fg })}>( <Text color={focused === index ? theme.bg : theme.accent}>{chip.key} </Text>{chip.label} )</Text>
    ))}
  </Box>;
}

export function BottomBar(props: StatusProps & { focusedChip: number | null; focusedSubagent?: number | null; subagentChips?: { label: string; glyph: string; active: boolean }[]; keepMyBranch?: boolean }) {
  return <Box flexDirection="column">
    <SubagentChipRow width={props.width} focusedSubagent={props.focusedSubagent} subagentChips={props.subagentChips} />
    {props.rootOnWindowsMount && <WindowsMountHint width={props.width} />}
    <StatusRow {...props} />
    <KeyRow width={props.width} focused={props.focusedChip} keepMyBranch={props.keepMyBranch} />
  </Box>;
}
