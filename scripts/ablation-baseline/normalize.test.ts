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
