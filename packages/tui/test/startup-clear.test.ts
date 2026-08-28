import { describe, expect, test } from "bun:test";
import { startupClear } from "../src/main";

function fakeStream(isTTY: boolean) {
  const writes: string[] = [];
  return { stream: { isTTY, write: (s: string) => void writes.push(s) }, writes };
}

describe("startup clear (#292)", () => {
  test("clears a real terminal before the first frame", () => {
    const { stream, writes } = fakeStream(true);
    expect(startupClear(stream)).toBe(true);
    expect(writes).toEqual(["\x1b[2J\x1b[H"]);
  });

  test("non-TTY hosts (tests, pipes) are left untouched", () => {
    const { stream, writes } = fakeStream(false);
    expect(startupClear(stream)).toBe(false);
    expect(writes).toEqual([]);
  });
});
