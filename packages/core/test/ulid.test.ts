import { describe, expect, test } from "bun:test";
import { isUlid, newUlid, ULID_RE } from "../src/session/ulid";

describe("ULID (#575)", () => {
  test("generates canonical 26-char Crockford base32 ids", () => {
    const id = newUlid();
    expect(id.length).toBe(26);
    expect(ULID_RE.test(id)).toBe(true);
    expect(isUlid(id)).toBe(true);
    expect(isUlid("line:12")).toBe(false);
  });

  test("same-millisecond ids are unique and monotonic", () => {
    const t = new Date(1700000000000);
    const ids = Array.from({ length: 100 }, () => newUlid(t));
    expect(new Set(ids).size).toBe(100);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  test("lexicographic order equals chronological order", () => {
    const a = newUlid(new Date(1000000000000));
    const b = newUlid(new Date(1000000000001));
    expect(a < b).toBe(true);
  });

  test("clock step backwards stays monotonic within the process", () => {
    const later = newUlid(new Date(2000000000000));
    const earlier = newUlid(new Date(1000000000000));
    expect(earlier > later).toBe(true);
  });
});
