import { Marked, type Tokens } from "marked";
// marked-terminal ships no type declarations (documented subset used).
// @ts-expect-error untyped module
import { markedTerminal } from "marked-terminal";
import { useMemo } from "react";
import { Box, Text } from "ink";
import Table from "cli-table3";
import type { Theme } from "./themes";

/** One styled run of a rendered markdown row. */
export interface StyledSegment {
  text: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
}

/** Parses our own escape vocabulary (fg truecolor, bold/italic/strike with
 * specific resets) into styled segments. Raw escapes inside a Text break
 * ink's background painting — the tokenizer closes the Box tint at the
 * first embedded transition — so rows are rendered as ink-native styled
 * Text segments instead (#205). */
export function parseAnsiSegments(line: string): StyledSegment[] {
  const segments: StyledSegment[] = [];
  let color: string | undefined;
  let bold = false;
  let italic = false;
  let strike = false;
  let at = 0;
  const escape = /\x1b\[([0-9;]*)m/g;
  let match: RegExpExecArray | null;
  const push = (text: string) => {
    if (!text) return;
    segments.push({ text, ...(color ? { color } : {}), ...(bold ? { bold: true } : {}), ...(italic ? { italic: true } : {}), ...(strike ? { strikethrough: true } : {}) });
  };
  while ((match = escape.exec(line))) {
    push(line.slice(at, match.index));
    at = match.index + match[0].length;
    const params = match[1]!.split(";").map((p) => Number(p || "0"));
    for (let p = 0; p < params.length; p++) {
      const n = params[p]!;
      if (n === 0) { color = undefined; bold = italic = strike = false; }
      else if (n === 1) bold = true;
      else if (n === 22) bold = false;
      else if (n === 3) italic = true;
      else if (n === 23) italic = false;
      else if (n === 9) strike = true;
      else if (n === 29) strike = false;
      else if (n === 39) color = undefined;
      else if (n === 38 && params[p + 1] === 2) {
        // truecolor fg: 38;2;R;G;B
        const rgb = params.slice(p + 2, p + 5);
        if (rgb.length === 3 && rgb.every((v) => Number.isFinite(v))) {
          color = `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
        }
        p += 4;
      } else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) {
        color = ANSI_16[n >= 90 ? n - 90 + 8 : n - 30]!;
      }
      // 48 (bg) and others: never emitted by our renderer or the table; ignored.
    }
  }
  push(line.slice(at));
  return segments.length ? segments : [{ text: line }];
}

const ANSI_16 = ["#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0", "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff"];

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
      code: (code: string) => `${fg(theme.accent)}${code}\x1b[39m`,
      firstHeading: (t: string) => `${fg(theme.accent)}\x1b[1m${t}\x1b[22m\x1b[39m`,
      heading: (t: string) => `${fg(theme.accent)}\x1b[1m${t}\x1b[22m\x1b[39m`,
      strong: (t: string) => `\x1b[1m${t}\x1b[22m`,
      em: (t: string) => `\x1b[3m${t}\x1b[23m`,
      del: (t: string) => `\x1b[9m${t}\x1b[29m`,
      codespan: (t: string) => `${fg(theme.accent)}${t}\x1b[39m`,
      blockquote: (t: string) => `${fg(theme.dim)}\x1b[3m${t}\x1b[23m\x1b[39m`,
      html: (t: string) => `${fg(theme.dim)}${t}\x1b[39m`,
      link: (t: string) => `${fg(theme.accent)}${t}\x1b[39m`,
      href: (t: string) => `${fg(theme.dim)}${t}\x1b[39m`,
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
      // Terminal lists must keep the source markers (#226): the default
      // renderer renumbers every ordered list from 1, so a list split into
      // per-item segments (streaming promotion) would print wrong numbers.
      list(this: { listitem(item: unknown): string; tab?: number }, token: Tokens.List): string {
        const start = token.ordered ? Number(token.start ?? 1) : 1;
        const tab = " ".repeat(this.tab ?? 4);
        const rows: string[] = [];
        token.items.forEach((item, i) => {
          const raw = this.listitem(item).replace(/^\n/, ""); // "* body"
          const marker = token.ordered ? `${start + i}. ` : "* ";
          const body = raw.startsWith("* ") ? raw.slice(2) : raw;
          body.split("\n").forEach((line, j) => {
            // Nested lists already carry their own tab from the recursive
            // render — indent them one level deeper, don't realign to the marker.
            rows.push(j > 0 && line.startsWith(tab) ? tab + line : tab + (j === 0 ? marker + line : " ".repeat(marker.length) + line));
          });
        });
        // Same nested-list repair the default applies: a sub list glued to
        // its parent item text moves to its own line.
        const joined = rows.join("\n").replace(/(\S(?: |  )?)((?:\x20{4})+)((?:\*|\d+\.)(?:.*)+)$/gm, `$1\n${tab}$2$3`);
        return `${joined}\n\n`;
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
 * too; styled runs render as ink-native Text segments — raw ANSI inside a
 * Text makes ink's tokenizer close the Box tint at the first embedded
 * transition, which dropped the background from the first styled row of
 * every wrapped paragraph (#205). */
export function Markdown({ text, md, width, rowWidth, bg }: { text: string; md: Marked; width: number; rowWidth: number; bg?: string }) {
  const lines = useMemo(
    () => wrapRenderedLines(String(md.parse(closeOpenFences(text))).replace(/\n+$/, ""), width),
    [text, md, width],
  );
  return <>{lines.map((line, index) => (
    <Box key={index} width={Math.max(1, rowWidth - 1)} backgroundColor={bg} paddingLeft={4} flexShrink={0}>
      <Text>{parseAnsiSegments(line).map((segment, s) => (
        <Text key={s} color={segment.color} bold={segment.bold} italic={segment.italic} strikethrough={segment.strikethrough}>{segment.text}</Text>
      ))}{line.trim() === "" ? " " : null}</Text>
    </Box>
  ))}</>;
}
