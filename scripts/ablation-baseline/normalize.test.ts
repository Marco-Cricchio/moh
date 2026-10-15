import { expect, test } from "bun:test";
import { Normalizer } from "./normalize";

const normalizer = () => new Normalizer({ home: "/fixture/home", cwd: "/fixture/cwd" });

test("measured durations normalize without hiding configured limits", () => {
  const n = normalizer();
  expect(n.text('{"durationMs":12,"ttfcMs": 9,"waitMs":3}')).toBe('{"durationMs":<ms>,"ttfcMs": <ms>,"waitMs":<ms>}');
  const limits = '{"timeoutMs":30000,"hookTimeoutMs":30000,"retryAfterMs":1000,"resetMs":2000,"budgetMs":100}';
  expect(n.text(limits)).toBe(limits);
});

test("elapsed prose is limited to rendered report rows", () => {
  const n = normalizer();
  const message = 'wall 77ms; default 30s limit; within 30000ms';
  expect(n.text(message)).toBe(message);
  expect(n.text(message, "display")).toBe(message);
  const row = '100 tokens · wall 77ms · model-serving tools 2s';
  expect(n.text(row)).toBe(row);
  expect(n.text('100 tokens · wall 1m 2s · tools 2m 3s', 'display')).toBe('100 tokens · wall <dur> · tools <dur>');
  expect(n.text(row, "display")).toBe('100 tokens · wall <dur> · model-serving tools <dur>');
});

test("pid normalization requires a process context and an entire token", () => {
  const n = normalizer();
  expect(n.text(`/fixture/cwd/file.tmp-${process.pid}`)).toBe('<CWD>/file.tmp-<PID>');
  expect(n.text(`/fixture/cwd/index.json.${process.pid}.tmp`)).toBe('<CWD>/index.json.<PID>.tmp');
  expect(n.text(`value .${process.pid}`)).toBe(`value .${process.pid}`);
  expect(n.text(`pid ${process.pid}`)).toBe('pid <PID>');
  expect(n.text(`{"pid":${process.pid}}`)).toBe('{"pid":<PID>}');
  expect(n.text(`value ${process.pid} ${process.pid}0 x${process.pid}`)).toBe(`value ${process.pid} ${process.pid}0 x${process.pid}`);
});

test("ISO timestamps normalize before the run date, fixed dates survive", () => {
  const n = normalizer();
  const today = new Date().toISOString().slice(0, 10);
  expect(n.text(`${today}T12:34:56.789Z`)).toBe('<iso>');
  expect(n.text(`Date: ${today}`)).toBe('Date: <date>');
  expect(n.text('Date: 2020-01-02')).toBe('Date: 2020-01-02');
  expect(n.text(`${today}9`)).toBe(`${today}9`);
});

test("display rows without an elapsed rendering stay byte-identical, borders and padding included", () => {
  const n = normalizer();
  const rows = [
    "───────────────────│   usage by model                                           │──────────────────",
    "───────────────────│   0 tokens · no pricing for 1      │──────────────────",
    "  tokens · wall 5ms",
    "│   wall 850ms · tools 1.2s      │",
    "x  ",
  ];
  for (const r of rows) expect(n.text(r, "display")).toBe(r);
  const multi = rows.join("\n");
  expect(n.text(multi, "display")).toBe(multi);
});

test("display rows without a border keep their text around the masked durations", () => {
  const n = normalizer();
  expect(n.text("  12 tokens · wall 850ms · tools 1.2s · no pricing for 1  ", "display")).toBe(
    "  12 tokens · wall <dur> · tools <dur> · no pricing for 1  ",
  );
  expect(n.text("  12 tokens · wall 12m 5s · model-serving tools 7s", "display")).toBe("  12 tokens · wall <dur> · model-serving tools <dur>");
});

/** A box row as the renderer pads it: 19 + 1 + 60 + 1 + 18 = 99 columns. */
const boxRow = (inner: string): string => `───────────────────│${inner.padEnd(60)}│──────────────────`;

test("a bordered row keeps its pre-mask width whatever the duration text length", () => {
  const n = normalizer();
  const raws = [
    boxRow("   0 tokens · wall 74ms · tools 0ms · no pricing for 1"),
    boxRow("   0 tokens · wall 1.2s · tools 850ms · no pricing for 1"),
    boxRow("   0 tokens · wall 12.3s · tools 1.2s · no pricing for 1"),
    boxRow("   0 tokens · wall 1m 2s · tools 12.3s · no pricing for 1"),
    boxRow("   0 tokens · wall 12m 30s · tools 1m 2s · no pricing for 1"),
  ];
  const outs = raws.map((r) => {
    expect(r.length).toBe(99);
    return n.text(r, "display");
  });
  for (const o of outs) {
    expect(o).toBe(outs[0]!);
    expect(o.length).toBe(99);
  }
  expect(outs[0]).toBe(boxRow("   0 tokens · wall <dur> · tools <dur> · no pricing for 1"));
});

test("a masked row that no longer fits its width gets a single space before the border", () => {
  const n = normalizer();
  // 54 columns of content + 6 spaces: masking adds 6 columns, so it fits exactly.
  const exact = boxRow("   0 tokens · wall 1s · tools 2s · no pricing for 1 xx");
  expect(n.text(exact, "display")).toBe("───────────────────│   0 tokens · wall <dur> · tools <dur> · no pricing for 1 xx│──────────────────");
  // 58 + 2 spaces: masking adds 6, so it no longer fits, so the border gets one space.
  const tight = boxRow("   0 tokens · wall 1s · tools 2s · no pricing for 1 for xx");
  expect(n.text(tight, "display")).toBe("───────────────────│   0 tokens · wall <dur> · tools <dur> · no pricing for 1 for xx │──────────────────");
  expect(n.text("│0 tokens · wall 1s · tools 2s│", "display")).toBe("│0 tokens · wall <dur> · tools <dur> │");
});

test("only the run before the first border after the masked content is resized", () => {
  const n = normalizer();
  const row = "  a  │  0 tokens · wall 74ms · tools 0ms · x      │   b   │";
  expect(n.text(row, "display")).toBe("  a  │  0 tokens · wall <dur> · tools <dur> · x   │   b   │");
  // The model-serving CLI wording is handled the same way.
  expect(n.text("│ 1 tokens · wall 5ms · model-serving tools 6ms     │", "display")).toBe("│ 1 tokens · wall <dur> · model-serving tools <dur> │");
});

test("rows are processed one by one in a multi-line display text", () => {
  const n = normalizer();
  const plain = boxRow("   usage by model");
  const raw = [plain, boxRow("   0 tokens · wall 74ms · tools 0ms · no pricing for 1"), plain].join("\n");
  expect(n.text(raw, "display")).toBe([plain, boxRow("   0 tokens · wall <dur> · tools <dur> · no pricing for 1"), plain].join("\n"));
});
