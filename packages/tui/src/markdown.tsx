import { Marked } from "marked";
// marked-terminal ships no type declarations (documented subset used).
// @ts-expect-error untyped module
import { markedTerminal } from "marked-terminal";
import { useMemo } from "react";
import { Text } from "ink";
import type { Theme } from "./themes";

/** Closes unterminated code fences so mid-stream markdown renders safely. */
export function closeOpenFences(text: string): string {
  const fences = (text.match(/```/g) ?? []).length;
  return fences % 2 === 1 ? text + "\n```" : text;
}

const hexToRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";");

/**
 * The markdown renderer captures theme colors at construction, so it must be
 * regenerated per theme (docs/tui-style-guide.md §5, implementation lessons).
 */
export function createMarkdownRenderer(theme: Theme): Marked {
  return new Marked(
    markedTerminal({
      code: (code: string) => `\x1b[38;2;${hexToRgb(theme.accent)}m${code}\x1b[0m`,
    }) as never,
  );
}

/** Streaming-safe markdown text, rendered with the current theme. */
export function Markdown({ text, md }: { text: string; md: Marked }) {
  const out = useMemo(
    () => String(md.parse(closeOpenFences(text))).replace(/\n+$/, ""),
    [text, md],
  );
  return <Text>{out}</Text>;
}
