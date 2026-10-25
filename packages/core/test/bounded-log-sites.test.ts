/**
 * Characterization of the three bounded diagnostic logs (#1426, S3.4).
 *
 * Pins, per file, over a pre-seeded file with a torn line, duplicates and an
 * over-cap count: the entries that are read, the exact bytes written back
 * (entry order and field order), the count, the eviction and the unwritable
 * home that never throws. Written against the code as it was before the
 * shared `boundedLog` helper; it must pass unchanged after it.
 *
 * The three modules differ on purpose and the differences are pinned as they
 * are: provider-test keeps appended order and has no dedup; context-refusal
 * rebuilds each entry and evicts by `last` recency only past the cap;
 * the redact miss report keeps raw parsed objects, skips a torn line like the
 * others and has no read-side cap.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextRefusalsFile, noteUnrecognizedContextRefusal } from "../src/context-refusal-trace";
import { noteProviderTestFailure } from "../src/provider-test-trace";
import { noteSecretRedactionMiss, secretRedactionMissesFile } from "../src/redact";

const home = (label: string): string => mkdtempSync(join(tmpdir(), `moh-bounded-${label}-`));
const pad = (n: number): string => String(n).padStart(2, "0");
const stamp = (n: number): string => `2026-01-01T00:00:${pad(n)}.000Z`;
const NOW = new Date("2026-02-01T00:00:00.000Z");
const NOW_ISO = NOW.toISOString();
const lines = (...rows: unknown[]): string[] => rows.map((row) => JSON.stringify(row));
const body = (rows: string[]): string => `${rows.join("\n")}\n`;

/** A path whose parent is a file: every write attempt under it fails. */
function unwritableHome(label: string): string {
  const base = home(label);
  const blocker = join(base, "blocker");
  writeFileSync(blocker, "x");
  return join(blocker, "moh");
}

describe("provider-test trace", () => {
  const profile = { name: "ep", type: "openai-compat", baseUrl: "http://x/v1", apiKey: "k", defaultModel: "m" } as never;
  const result = { ok: false, error: "boom" } as never;
  const entry = (i: number) => ({ at: stamp(i), endpoint: "ep", type: "openai-compat", model: "m", message: `m${i}` });

  test("torn line skipped, extras kept in parsed order, last 50 kept in append order, new entry last", () => {
    const dir = home("ptt");
    const file = join(dir, "provider-test-failures.log");
    const seed: string[] = [];
    for (let i = 0; i < 52; i++) {
      if (i === 10) seed.push(JSON.stringify({ message: "m10", at: stamp(10), endpoint: "ep", extra: 1 }));
      else seed.push(JSON.stringify(entry(i)));
      if (i === 5) seed.push("{torn");
      if (i === 6) seed.push("   ");
      if (i === 7) seed.push(JSON.stringify({ at: stamp(7), message: "no endpoint" }));
    }
    writeFileSync(file, `${seed.join("\n")}\n`);

    noteProviderTestFailure({ home: dir, profile, result, now: NOW });

    const expected: string[] = [];
    for (let i = 3; i < 52; i++) {
      expected.push(i === 10 ? JSON.stringify({ message: "m10", at: stamp(10), endpoint: "ep", extra: 1 }) : JSON.stringify(entry(i)));
    }
    expected.push(JSON.stringify({ at: NOW_ISO, endpoint: "ep", type: "openai-compat", model: "m", message: "boom" }));
    expect(expected).toHaveLength(50);
    expect(readFileSync(file, "utf8")).toBe(body(expected));
  });

  test("identical failures are not deduplicated: each appends one line", () => {
    const dir = home("ptt-dup");
    const file = join(dir, "provider-test-failures.log");
    noteProviderTestFailure({ home: dir, profile, result, now: NOW });
    noteProviderTestFailure({ home: dir, profile, result, now: NOW });
    const line = JSON.stringify({ at: NOW_ISO, endpoint: "ep", type: "openai-compat", model: "m", message: "boom" });
    expect(readFileSync(file, "utf8")).toBe(body([line, line]));
  });

  test("an unwritable home does not throw", () => {
    expect(() => noteProviderTestFailure({ home: unwritableHome("ptt-u"), profile, result, now: NOW })).not.toThrow();
  });
});

describe("context-refusal trace", () => {
  const input = (dir: string, message: string) => ({ home: dir, model: "m", message, now: NOW });
  const row = (i: number) => ({ at: stamp(i), last: stamp(i), endpoint: "openrouter", model: "m", message: `refusal ${i}`, count: 1 });

  test("torn line skipped, window past the cap is evicted by `last` recency and the file is reordered", () => {
    const dir = home("ctx");
    const file = contextRefusalsFile(dir);
    const seed: string[] = [];
    for (let i = 0; i < 51; i++) {
      seed.push(JSON.stringify(row(i)));
      if (i === 5) seed.push("{torn");
    }
    writeFileSync(file, `${seed.join("\n")}\n`);

    noteUnrecognizedContextRefusal(input(dir, "brand new wording"));

    // Read keeps the last 50 (row 1..50); the new entry makes 51 > 50, so the
    // oldest `last` (row 1) goes and the survivors are sorted by `last` desc.
    const expected = [
      JSON.stringify({ at: NOW_ISO, last: NOW_ISO, model: "m", message: "brand new wording", count: 1 }),
    ];
    for (let i = 50; i >= 2; i--) expected.push(JSON.stringify(row(i)));
    expect(expected).toHaveLength(50);
    expect(readFileSync(file, "utf8")).toBe(body(expected));
  });

  test("same wording (digits masked) bumps count and last in place; under the cap the order is kept; entries are rebuilt", () => {
    const dir = home("ctx-merge");
    const file = contextRefusalsFile(dir);
    writeFileSync(
      file,
      `${[
        JSON.stringify({ count: 1, message: "limit 131072 exceeded", model: "m", endpoint: "openrouter", last: stamp(1), at: stamp(1), junk: true }),
        "{torn",
        JSON.stringify({ message: "other", model: "m", count: 4, at: 7 }),
        JSON.stringify({ message: "bad count", model: "m", count: "2" }),
        JSON.stringify({ message: "limit 234666 exceeded", model: "m", count: 1, endpoint: "openrouter", at: stamp(3), last: stamp(3) }),
      ].join("\n")}\n`,
    );

    noteUnrecognizedContextRefusal({ home: dir, endpoint: "openrouter", model: " m ", message: "limit 999999 exceeded", now: NOW });

    expect(readFileSync(file, "utf8")).toBe(
      body(
        lines(
          { at: stamp(1), last: NOW_ISO, endpoint: "openrouter", model: "m", message: "limit 131072 exceeded", count: 2 },
          { at: "", last: "", model: "m", message: "other", count: 4 },
          { at: stamp(3), last: stamp(3), endpoint: "openrouter", model: "m", message: "limit 234666 exceeded", count: 1 },
        ),
      ),
    );
  });

  test("an unwritable home does not throw", () => {
    expect(() => noteUnrecognizedContextRefusal(input(unwritableHome("ctx-u"), "x"))).not.toThrow();
  });
});

describe("redact miss report", () => {
  const row = (i: number) => ({ at: stamp(i), last: stamp(i), shape: `opaque-word:${i}`, count: 1 });

  test("a torn line is skipped and later entries survive (#1615); raw objects kept; no read cap; evicted by `last` past the cap", () => {
    const dir = home("miss");
    const file = secretRedactionMissesFile(dir);
    const seed: string[] = [];
    for (let i = 0; i < 52; i++) {
      seed.push(i === 40 ? JSON.stringify({ shape: "opaque-word:40", foo: "raw", last: stamp(40), count: 1, at: stamp(40) }) : JSON.stringify(row(i)));
    }
    seed.push("{torn");
    seed.push(JSON.stringify(row(60)));
    seed.push(JSON.stringify(row(61)));
    writeFileSync(file, `${seed.join("\n")}\n`);

    noteSecretRedactionMiss({ home: dir, shape: "fresh:1", now: NOW });

    // 52 + 2 entries read (torn line skipped, no cap), 55 with the new one;
    // sorted by `last` desc, the five oldest (rows 0..4) go. Rows 60 and 61 sat
    // after the torn line and now survive.
    const expected = [JSON.stringify({ at: NOW_ISO, last: NOW_ISO, shape: "fresh:1", count: 1 })];
    for (const i of [61, 60]) expected.push(JSON.stringify(row(i)));
    for (let i = 51; i >= 5; i--) {
      expected.push(i === 40 ? JSON.stringify({ shape: "opaque-word:40", foo: "raw", last: stamp(40), count: 1, at: stamp(40) }) : JSON.stringify(row(i)));
    }
    expect(expected).toHaveLength(50);
    const written = readFileSync(file, "utf8");
    expect(written).toBe(body(expected));
    expect(written).toContain("opaque-word:60");
    expect(written).toContain("opaque-word:61");
    expect(written).not.toContain("{torn");
  });

  test("same shape bumps count and last in place; under the cap the order is kept; ends with a newline", () => {
    const dir = home("miss-merge");
    const file = secretRedactionMissesFile(dir);
    writeFileSync(file, body(lines(row(1), row(2), { ...row(1), count: 5 })));

    noteSecretRedactionMiss({ home: dir, shape: "opaque-word:1", now: NOW });

    expect(readFileSync(file, "utf8")).toBe(
      body(lines({ at: stamp(1), last: NOW_ISO, shape: "opaque-word:1", count: 2 }, row(2), { ...row(1), count: 5 })),
    );
  });

  test("an unwritable home does not throw", () => {
    expect(() => noteSecretRedactionMiss({ home: unwritableHome("miss-u"), shape: "x:1", now: NOW })).not.toThrow();
  });
});
