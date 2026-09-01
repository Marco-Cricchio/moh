import { useMemo } from "react";
import { Box, Text } from "ink";
import type { Marked } from "marked";
import { createMarkdownRenderer, parseAnsiSegments, wrapRenderedLines } from "./markdown";
import { useTheme } from "./themes";

/**
 * The side-by-side preview box for ask_user options carrying `preview`
 * (#414 / ADR-0019): a bordered monospace panel rendering the focused
 * option's content — markdown with highlighted code blocks via the same
 * renderer the transcript uses — truncating beyond `maxLines` with an
 * explicit "N lines hidden" indicator. Modeled on Claude Code's
 * PreviewBox, rebuilt on moh's own ANSI-segment rendering (#205).
 */
const BOX = { topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘", horizontal: "─", vertical: "│", teeLeft: "├", teeRight: "┤" } as const;

/** Visible width of a rendered (possibly ANSI-colored) line. */
const visibleWidth = (line: string): number => line.replace(/\u001b\[[0-9;]*m/g, "").length;

/** Truncates a rendered line to `width` visible columns, keeping ANSI
 * codes: slicing the plain spans and re-emitting the running style. */
export function truncateAnsiLine(line: string, width: number): string {
  const segments = parseAnsiSegments(line);
  let used = 0;
  const out: string[] = [];
  for (const segment of segments) {
    const remaining = width - used;
    if (remaining <= 0) break;
    const text = visibleWidth(segment.text) > remaining ? segment.text.slice(0, remaining) : segment.text;
    out.push(
      (segment.color ? `\x1b[38;2;${[1, 3, 5].map((i) => parseInt(segment.color!.slice(i, i + 2), 16)).join(";")}m` : "") +
        (segment.bold ? "\x1b[1m" : "") +
        (segment.italic ? "\x1b[3m" : "") +
        (segment.strikethrough ? "\x1b[9m" : "") +
        text +
        "\x1b[0m",
    );
    used += visibleWidth(text);
  }
  return out.join("");
}

export interface PreviewBoxProps {
  /** Preview content: markdown (code fences highlighted) or plain text. */
  content: string;
  /** Max content rows before truncation (the caller's height budget). */
  maxLines: number;
  /** Minimum inner width; the box never renders narrower. */
  minWidth: number;
  /** Maximum outer width (the panel's available columns). */
  maxWidth: number;
}

export function PreviewBox({ content, maxLines, minWidth, maxWidth }: PreviewBoxProps) {
  const theme = useTheme();
  const md: Marked = useMemo(() => createMarkdownRenderer(theme, Math.max(8, minWidth)), [theme, minWidth]);
  const rendered = useMemo(
    () => wrapRenderedLines(String(md.parse(content)).replace(/\n+$/, ""), Math.max(8, minWidth)),
    [md, content, minWidth],
  );

  const isTruncated = rendered.length > maxLines;
  const truncated = isTruncated ? rendered.slice(0, maxLines) : rendered;
  // Content width: the widest visible line, clamped to [minWidth, maxWidth-4].
  const contentWidth = Math.min(
    Math.max(minWidth, ...truncated.map(visibleWidth)),
    Math.max(8, maxWidth - 4),
  );
  const innerWidth = contentWidth;

  return (
    <Box flexDirection="column">
      <Text color={theme.dim}>{`${BOX.topLeft}${BOX.horizontal.repeat(contentWidth + 2)}${BOX.topRight}`}</Text>
      {truncated.map((line, index) => (
        <Box key={index} flexDirection="row" flexShrink={0}>
          <Text color={theme.dim}>{`${BOX.vertical} `}</Text>
          <Text>
            {parseAnsiSegments(visibleWidth(line) > innerWidth ? truncateAnsiLine(line, innerWidth) : line).map((segment, s) => (
              <Text key={s} color={segment.color} bold={segment.bold} italic={segment.italic} strikethrough={segment.strikethrough}>{segment.text}</Text>
            ))}
          </Text>
          <Text color={theme.dim}>{`${" ".repeat(Math.max(0, innerWidth - visibleWidth(line)))} ${BOX.vertical}`}</Text>
        </Box>
      ))}
      {isTruncated && (() => {
        const hidden = rendered.length - maxLines;
        const label = ` ${BOX.horizontal.repeat(3)} ✂ ${BOX.horizontal.repeat(3)} ${hidden} line${hidden === 1 ? "" : "s"} hidden `;
        const fill = contentWidth + 2 - label.length;
        return <Text color={theme.warn}>{`${BOX.teeLeft}${label}${BOX.horizontal.repeat(Math.max(0, fill))}${BOX.teeRight}`}</Text>;
      })()}
      <Text color={theme.dim}>{`${BOX.bottomLeft}${BOX.horizontal.repeat(contentWidth + 2)}${BOX.bottomRight}`}</Text>
    </Box>
  );
}
