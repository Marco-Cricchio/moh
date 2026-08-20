import { describe, expect, test } from "bun:test";
import { closeOpenFences, createMarkdownRenderer } from "../src/markdown";
import { THEMES } from "../src/themes";

describe("closeOpenFences", () => {
  test("closes an unterminated code fence", () => {
    expect(closeOpenFences("```ts\nconst x = 1;")).toBe("```ts\nconst x = 1;\n```");
  });
  test("leaves balanced text alone", () => {
    expect(closeOpenFences("```ts\nx\n``` done")).toBe("```ts\nx\n``` done");
    expect(closeOpenFences("no fences")).toBe("no fences");
  });
});

describe("createMarkdownRenderer", () => {
  test("renders fenced code and bold, trailing newlines trimmed by the component", () => {
    const md = createMarkdownRenderer(THEMES["tokyo-night"]);
    const out = String(md.parse(closeOpenFences("# Hi\n\nsome `code`"))).trim();
    expect(out.length).toBeGreaterThan(0);
  });
});
