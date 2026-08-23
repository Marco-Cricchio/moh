import { Marked, type Tokens } from "marked";
// marked-terminal ships no type declarations (documented subset used).
// @ts-expect-error untyped module
import { markedTerminal } from "marked-terminal";
import { useMemo } from "react";
import { Text } from "ink";
import Table from "cli-table3";
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
export function createMarkdownRenderer(theme: Theme, width: number): Marked {
  const marked = new Marked(
    markedTerminal({
      code: (code: string) => `\x1b[38;2;${hexToRgb(theme.accent)}m${code}\x1b[0m`,
      width,
      reflowText: true,
    }) as never,
  );
  // Tables: marked-terminal builds cli-table3 without column widths, so long
  // cells overflow the width and get visually truncated by the chat window
  // (Text wrap="truncate-end"). Re-render tables with an even column budget
  // and wordWrap, so cli-table3 wraps cell text itself instead.
  marked.use({
    renderer: {
      // Text tokens (e.g. inside loose list items) fall back to the raw
      // source in marked-terminal (`token.text`), leaking **bold** markers.
      // Parse the inline tokens instead, keeping span styling.
      text(this: { parser: { parseInline(t: unknown): string } }, token: Tokens.Text | Tokens.Escape): string {
        if (typeof token !== "object") return String(token);
        return "tokens" in token && token.tokens ? this.parser.parseInline(token.tokens) : token.text;
      },
      table(this: { parser: { parseInline(t: unknown): string } }, token: Tokens.Table): string {
        const nCols = Math.max(1, token.header.length);
        // Row budget: width minus the chat line's leading space and the nCols+1
        // border characters; each column gets an equal share (min 3).
        const colW = Math.max(3, Math.floor((width - 1 - (nCols + 1)) / nCols));
        const cell = (c: Tokens.TableCell) => this.parser.parseInline(c.tokens ?? []);
        const t = new Table({
          head: token.header.map(cell),
          colWidths: Array.from({ length: nCols }, () => colW),
          wordWrap: true,
        });
        for (const row of token.rows) t.push(row.map(cell));
        return `\n${t.toString()}\n`;
      },
    },
  });
  return marked;
}

/**
 * Word-wraps already-rendered (ANSI-colored) markdown lines at `width`.
 * marked-terminal only reflows paragraphs: list items, blockquotes and any
 * other overflowing block would otherwise be truncated by the chat window.
 * Continuation lines align under the leading bullet/indent; words (with
 * their escape codes kept intact) are never split.
 */
export function wrapRenderedLines(text: string, width: number): string[] {
  const visible = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const lead = line.match(/^(\s*(?:[*+-]|\d+[.)])\s+)?/)?.[0] ?? "";
    if (visible(line).length <= width) {
      out.push(line);
      continue;
    }
    const budget = Math.max(8, width - lead.length);
    const pad = " ".repeat(lead.length);
    let cur = "";
    let wrapped = false;
    for (const word of line.slice(lead.length).split(/\s+/).filter(Boolean)) {
      const v = visible(word).length;
      if (!cur) cur = word;
      else if (visible(cur).length + 1 + v <= budget) cur += ` ${word}`;
      else {
        out.push((wrapped ? pad : lead) + cur);
        cur = word;
        wrapped = true;
      }
    }
    out.push((wrapped ? pad : lead) + cur);
  }
  return out;
}

/** Streaming-safe markdown text, rendered with the current theme. */
export function Markdown({ text, md }: { text: string; md: Marked }) {
  const out = useMemo(
    () => String(md.parse(closeOpenFences(text))).replace(/\n+$/, ""),
    [text, md],
  );
  return <Text>{out}</Text>;
}
