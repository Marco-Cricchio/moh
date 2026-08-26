import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { closeOpenFences, createMarkdownRenderer, wrapRenderedLines } from "../src/markdown";
import { THEMES } from "../src/themes";

describe("closeOpenFences", () => {
  test("closes an unterminated code fence", () => {
    expect(closeOpenFences("```ts\nconst x = 1;")).toBe("```ts\nconst x = 1;\n```");
  });
  test("closes tilde and variable-length fences with their original delimiter", () => {
    expect(closeOpenFences("~~~~ts\nconst ticks = ```;")).toBe("~~~~ts\nconst ticks = ```;\n~~~~");
    expect(closeOpenFences("~~~~\ncode\n~~~~")).toBe("~~~~\ncode\n~~~~");
  });
  test("does not mistake a fence-like code line for a closing fence", () => {
    expect(closeOpenFences("```ts\nx\n``` done")).toBe("```ts\nx\n``` done\n```");
    expect(closeOpenFences("```ts\nx\n```   ")).toBe("```ts\nx\n```   ");
    expect(closeOpenFences("no fences")).toBe("no fences");
  });
});

describe("wrapRenderedLines (overflowing blocks that marked-terminal does not reflow)", () => {
  const visible = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

  test("wraps long list items at the width, continuation aligned without bullet", () => {
    const md = createMarkdownRenderer(THEMES["tokyo-night"], 44);
    const out = String(md.parse("- una voce di lista molto lunga che supera di parecchio la larghezza della finestra della chat")).replace(/\n+$/, "");
    const lines = wrapRenderedLines(out, 44);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(visible(l).length).toBeLessThanOrEqual(44);
    expect(visible(lines[1]!)).not.toMatch(/\*/); // continuation: no bullet
    expect(visible(lines.join(" "))).toContain("finestra"); // wrapped, not truncated
  });

  test("short lines and ANSI codes pass through untouched", () => {
    expect(wrapRenderedLines("\u001b[1mbold\u001b[0m rest", 44)).toEqual(["\u001b[1mbold\u001b[0m rest"]);
  });
});

describe("createMarkdownRenderer", () => {
  test("renders fenced code and bold, trailing newlines trimmed by the component", () => {
    const md = createMarkdownRenderer(THEMES["tokyo-night"], 76);
    const out = String(md.parse(closeOpenFences("# Hi\n\nsome `code`"))).trim();
    expect(out.length).toBeGreaterThan(0);
  });

  test("emits theme-colored ANSI regardless of TTY detection (no chalk flattening)", () => {
    // marked-terminal defaults to chalk, which strips styling when stdout is
    // not a TTY — under the TUI every theme rendered flat (#205).
    const rgb = (hex: string) => hex.slice(1).match(/../g)!.map((h) => parseInt(h, 16)).join(";");
    for (const name of ["tokyo-night", "lava", "candy"] as const) {
      const theme = THEMES[name]!;
      const md = createMarkdownRenderer(theme, 60);
      const heading = String(md.parse("# Titolo"));
      expect(heading).toContain(`38;2;${rgb(theme.accent)}`);
      const strong = String(md.parse("**bold**"));
      expect(strong).toContain("\x1b[1m");
      const codespan = String(md.parse("`x`"));
      expect(codespan).toContain(`38;2;${rgb(theme.accent)}`);
    }
  });

  test("renders standard GFM constructs as formatted terminal content", () => {
    const md = createMarkdownRenderer(THEMES["tokyo-night"], 60);
    const source = [
      "# Heading",
      "",
      "**bold** and *emphasis* with ~~deleted~~ and `code`.",
      "",
      "> quoted text",
      "",
      "- unordered",
      "1. ordered",
      "- [x] task",
      "",
      "[link](https://example.test)",
      "",
      "![diagram](https://example.test/diagram.png)",
      "",
      "soft break",
      "continues",
      "hard break  ",
      "continues too",
      "",
      "```ts",
      "const value = 1;",
      "```",
      "",
      "---",
    ].join("\n");
    const visible = String(md.parse(closeOpenFences(source))).replace(/\u001b\[[0-9;]*m/g, "");
    expect(visible).toContain("Heading");
    expect(visible).not.toContain("# Heading");
    expect(visible).toContain("bold");
    expect(visible).not.toContain("**bold**");
    expect(visible).toContain("deleted");
    expect(visible).not.toContain("~~deleted~~");
    expect(visible).toContain("code");
    expect(visible).not.toContain("`code`");
    expect(visible).toContain("quoted text");
    expect(visible).toContain("unordered");
    expect(visible).toContain("ordered");
    expect(visible).toMatch(/\[X\]\s+task/);
    expect(visible).toContain("link (https://example.test)");
    expect(visible).toContain("diagram (https://example.test/diagram.png)");
    expect(visible).not.toContain("![diagram]");
    expect(visible).toContain("const value = 1;");
    expect(visible).toContain("soft break continues"); // Markdown soft break
    expect(visible).toContain("hard break\ncontinues too"); // two-space hard break
    expect(visible).toMatch(/-{20,}/); // thematic break
  });

  test("tables: long cell text wraps inside the column budget, not truncated", () => {
    const md = createMarkdownRenderer(THEMES["tokyo-night"], 40);
    const long = "supercalifragilisticexpialidocious padding text that keeps going";
    const out = String(md.parse(`| name | description |\n| --- | --- |\n| x | ${long} |`));
    const visible = (l: string) => l.replace(/\u001b\[[0-9;]*m/g, "");
    const rows = out.split("\n").filter((l) => /─|│/.test(visible(l)));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(visible(r).length).toBeLessThanOrEqual(40);
    // wrapped, not cut: the tail of the long cell is still rendered
    expect(visible(out)).toContain("keeps");
  });

  test("inline text tokens inside list items: ** markers interpreted, not raw", () => {
    const md = createMarkdownRenderer(THEMES["tokyo-night"], 60);
    const out = String(md.parse("- **Out of scope dichiarati** voce\n- due con **bold** e `code`\n"));
    const visible = out.replace(/\u001b\[[0-9;]*m/g, "");
    expect(visible).not.toContain("**");
    expect(visible).toContain("Out of scope dichiarati");
    expect(visible).not.toContain("`code`");
  });

  test("reflows wrapped text to the content measure, not the terminal width", () => {
    const md = createMarkdownRenderer(THEMES["tokyo-night"], 40);
    const out = String(md.parse("one two three four five six seven eight nine ten eleven twelve"));
    // Measure visible width: ANSI escape codes (e.g. a theme reset, 4 raw
    // chars) are zero-width for the renderer's reflow, but would otherwise
    // count toward the raw string length and break the assertion.
    const visible = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, "");
    const longest = out
      .split("\n")
      .reduce((a, b) => (visible(b).length > visible(a).length ? b : a), "");
    expect(visible(longest).length).toBeLessThanOrEqual(40);
  });

  // #237 Bug 3: a GFM table whose separator row has fewer delimiter groups
  // than the header has columns (a common model emission) must not collapse
  // to a plaintext pipe soup — it renders as a real table.
  test("malformed table (4-col header, 3 delimiters) still renders as a table", () => {
    const md = createMarkdownRenderer(THEMES["tokyo-night"], 80);
    const source = "| # | Bug | Dove | Effetto |\n|---|---|---|\n| 1 | bash | builtin-tools | hang |\n| 2 | resume | session-store | dead |";
    const out = String(md.parse(source));
    const visible = out.replace(/\u001b\[[0-9;]*m/g, "");
    expect(visible).toMatch(/[─│┌├└]/); // rendered border, not raw pipes
    expect(visible).toContain("session-store");
    expect(visible).toContain("Effetto");
  });

  test("table separator rows with extra delimiters are trimmed to the header width", () => {
    const md = createMarkdownRenderer(THEMES["tokyo-night"], 80);
    const source = "| a | b |\n|---|---|---|---|\n| 1 | 2 |";
    const out = String(md.parse(source));
    const visible = out.replace(/\u001b\[[0-9;]*m/g, "");
    expect(visible).toMatch(/[─│┌├└]/);
    expect(visible).toContain("a");
  });

  // #237 Bug 3: unregistered fence languages (jsonl and friends) trigger a
  // highlight.js console.warn on every streaming re-render — one warning per
  // render pass per fence. Rendering must stay warning-free.
  test("code fences with unknown/aliased languages render without console warnings", () => {
    const md = createMarkdownRenderer(THEMES["tokyo-night"], 80);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      const out1 = String(md.parse("```jsonl\n{\"a\": 1}\n```"));
      const out2 = String(md.parse("```totally-not-a-language\nplain text\n```"));
      const visible = (out1 + out2).replace(/\u001b\[[0-9;]*m/g, "");
      expect(visible).toContain('"a": 1');
      expect(visible).toContain("plain text");
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toEqual([]);
  });

  test("common language aliases still highlight: jsonl renders as json", async () => {
    // cli-highlight colors through its own nested chalk copy, whose level
    // is 0 outside a TTY and cached at import time — reachable neither via
    // env set after load nor via the test's chalk instance (a different
    // copy). Run the check in a fresh bun subprocess with color forced.
    const mdPath = join(__dirname, "../src/markdown.tsx");
    const themesPath = join(__dirname, "../src/themes.ts");
    const fence = "\u0060\u0060\u0060";
    const script =
      `Promise.all([import(${JSON.stringify(mdPath)}), import(${JSON.stringify(themesPath)})]).then(([m, t]) => {\n` +
      `  const out = String(m.createMarkdownRenderer(t.THEMES["tokyo-night"], 80).parse("${fence}jsonl\\n{\\\"key\\\": \\\"value\\\"}\\n${fence}"));\n` +
      `  process.stdout.write(out.includes("\\u001b[") ? "colored" : "plain");\n` +
      `});`;
    const proc = Bun.spawnSync(["bun", "-e", script], { env: { ...process.env, FORCE_COLOR: "1" } });
    expect(proc.stderr.toString()).toBe("");
    expect(proc.stdout.toString()).toBe("colored");
  });
});
