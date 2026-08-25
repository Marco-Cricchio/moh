import { Marked, type Tokens } from "marked";
// marked-terminal ships no type declarations (documented subset used).
// @ts-expect-error untyped module
import { markedTerminal } from "marked-terminal";
import { useMemo } from "react";
import { Box, Text } from "ink";
import Table from "cli-table3";
import type { Theme } from "./themes";

/** Closes an unterminated standard code fence so mid-stream Markdown stays
 * renderable. Both backtick and tilde fences are valid GFM; preserve the
 * opener's delimiter length so a four-backtick fence may contain ``` safely. */
export function closeOpenFences(text: string): string {
  let open: { char: "`" | "~"; length: number } | null = null;
  for (const line of text.split("\n")) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!match) continue;
    const marker = match[1]!;
    const char = marker[0]! as "`" | "~";
    // GFM closing fences may only be followed by spaces/tabs. A streamed
    // line such as ``` explanation is code content, not a close marker.
    const trailing = line.slice(match[0].length);
    if (open && open.char === char && marker.length >= open.length && /^[ \t]*$/.test(trailing)) open = null;
    else if (!open) open = { char, length: marker.length };
  }
  return open ? `${text}\n${open.char.repeat(open.length)}` : text;
}

const hexToRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";");

const fg = (hex: string) => `\x1b[38;2;${hexToRgb(hex)}m`;
const RESET = "\x1b[0m";

/**
 * The markdown renderer captures theme colors at construction, so it must be
 * regenerated per theme (docs/tui-style-guide.md §5, implementation lessons).
 */
export function createMarkdownRenderer(theme: Theme, width: number): Marked {
  const marked = new Marked(
    { gfm: true },
    markedTerminal({
      // marked-terminal styles through chalk, which disables itself when
      // stdout is not a TTY (or NO_COLOR is set) — under the TUI the whole
      // reply rendered flat, with no theme colors in any theme (#205).
      // Explicit ANSI strings keyed to the theme instead.
      code: (code: string) => `${fg(theme.accent)}${code}${RESET}`,
      firstHeading: (t: string) => `${fg(theme.accent)}\x1b[1m${t}${RESET}`,
      heading: (t: string) => `${fg(theme.accent)}\x1b[1m${t}${RESET}`,
      strong: (t: string) => `\x1b[1m${t}\x1b[22m`,
      em: (t: string) => `\x1b[3m${t}\x1b[23m`,
      del: (t: string) => `\x1b[9m${t}\x1b[29m`,
      codespan: (t: string) => `${fg(theme.accent)}${t}${RESET}`,
      blockquote: (t: string) => `${fg(theme.dim)}\x1b[3m${t}${RESET}`,
      html: (t: string) => `${fg(theme.dim)}${t}${RESET}`,
      link: (t: string) => `${fg(theme.accent)}${t}${RESET}`,
      href: (t: string) => `${fg(theme.dim)}${t}${RESET}`,
      width,
      reflowText: true,
      // Terminal headings are styled; source `#` prefixes add noise and
      // make an otherwise rendered chat line look like plain Markdown.
      showSectionPrefix: false,
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
      image(token: Tokens.Image): string {
        // A terminal cannot embed an image; preserve its accessible label and
        // destination rather than leaking Markdown source syntax.
        return token.text ? `${token.text} (${token.href})` : token.href;
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
        return `${t.toString()}\n`;
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

/** Streaming-safe markdown, rendered with the current theme. Each terminal
 * row is its own full-width Box so the tint paints blank lines and padding
 * too: a single multiline Text leaves gaps and the text sits on the
 * terminal's default bg instead of the theme tint (#205 follow-up). */
export function Markdown({ text, md, width, rowWidth, bg }: { text: string; md: Marked; width: number; rowWidth: number; bg?: string }) {
  const lines = useMemo(
    () => wrapRenderedLines(String(md.parse(closeOpenFences(text))).replace(/\n+$/, ""), width),
    [text, md, width],
  );
  return <>{lines.map((line, index) => <Box key={index} width={Math.max(1, rowWidth - 1)} backgroundColor={bg} paddingLeft={2} flexShrink={0}><Text>{line || " "}</Text></Box>)}</>;
}
