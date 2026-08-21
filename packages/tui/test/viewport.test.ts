import { describe, expect, test } from "bun:test";
import { COMPACT_COLS, MEASURE, contentWidth, dialogWidth, widthClass, windowing } from "../src/viewport";

describe("viewport width classes (issue #65)", () => {
  test("compact below 60, regular through the measure, wide beyond it", () => {
    expect(widthClass({ columns: 59, rows: 24 })).toBe("compact");
    expect(widthClass({ columns: COMPACT_COLS, rows: 24 })).toBe("regular");
    expect(widthClass({ columns: MEASURE, rows: 24 })).toBe("regular");
    expect(widthClass({ columns: MEASURE + 1, rows: 24 })).toBe("wide");
    expect(widthClass({ columns: 220, rows: 50 })).toBe("wide");
  });

  test("content width is the measure or the terminal, whichever is smaller", () => {
    expect(contentWidth({ columns: 80, rows: 24 })).toBe(80);
    expect(contentWidth({ columns: 100, rows: 24 })).toBe(100);
    expect(contentWidth({ columns: 160, rows: 45 })).toBe(MEASURE);
    expect(contentWidth({ columns: 220, rows: 50 })).toBe(MEASURE);
  });

  test("dialog width: 62% clamped to [40, measure], full width when compact", () => {
    expect(dialogWidth({ columns: 50, rows: 20 })).toBe(50); // compact: full width
    expect(dialogWidth({ columns: 80, rows: 24 })).toBe(50); // round(0.62 · 80)
    expect(dialogWidth({ columns: 100, rows: 30 })).toBe(62);
    expect(dialogWidth({ columns: 160, rows: 45 })).toBe(99);
    expect(dialogWidth({ columns: 220, rows: 50 })).toBe(MEASURE); // clamped to measure
    expect(dialogWidth({ columns: 62, rows: 24 })).toBe(40); // floor
    expect(dialogWidth({ columns: 41, rows: 24 })).toBe(41); // never wider than terminal
  });
});

describe("windowing (issue #64)", () => {
  test("no windowing needed when everything fits", () => {
    expect(windowing(5, 0, 10)).toEqual({ start: 0, count: 5, above: 0, below: 0 });
    expect(windowing(5, 4, 10)).toEqual({ start: 0, count: 5, above: 0, below: 0 });
  });

  test("cursor at the top: window starts at 0", () => {
    expect(windowing(10, 0, 4)).toEqual({ start: 0, count: 4, above: 0, below: 6 });
    expect(windowing(10, 3, 4)).toEqual({ start: 0, count: 4, above: 0, below: 6 });
  });

  test("cursor in the middle: window follows the cursor", () => {
    expect(windowing(10, 5, 4)).toEqual({ start: 2, count: 4, above: 2, below: 4 });
    expect(windowing(10, 6, 4)).toEqual({ start: 3, count: 4, above: 3, below: 3 });
  });

  test("cursor at the bottom: window is pinned to the end", () => {
    expect(windowing(10, 9, 4)).toEqual({ start: 6, count: 4, above: 6, below: 0 });
  });

  test("degenerate budgets still show one row", () => {
    expect(windowing(10, 9, 0)).toEqual({ start: 9, count: 1, above: 9, below: 0 });
    expect(windowing(10, 0, -3)).toEqual({ start: 0, count: 1, above: 0, below: 9 });
    expect(windowing(0, 0, 4)).toEqual({ start: 0, count: 0, above: 0, below: 0 });
  });
});
