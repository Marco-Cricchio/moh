import { describe, expect, test } from "bun:test";
import { parseArgs, ArgError } from "../src/args";

describe("parseArgs", () => {
  test("flags with values, =-form, lists and positionals", () => {
    const parsed = parseArgs(
      ["--provider", "mock", "--session=/tmp/s.jsonl", "--allow", "bash", "--allow", "write:src/**", "hello", "world"],
      { strings: ["provider", "session"], lists: ["allow"] },
    );
    expect(parsed.strings["provider"]).toBe("mock");
    expect(parsed.strings["session"]).toBe("/tmp/s.jsonl");
    expect(parsed.lists["allow"]).toEqual(["bash", "write:src/**"]);
    expect(parsed.positionals).toEqual(["hello", "world"]);
  });

  test("boolean flags and unknown flags", () => {
    expect(parseArgs(["--fork"], { booleans: ["fork"] }).booleans["fork"]).toBe(true);
    expect(() => parseArgs(["--nope"], { booleans: ["fork"] })).toThrow(ArgError);
    expect(() => parseArgs(["--provider"], { strings: ["provider"] })).toThrow(/missing value/);
  });

  test("-- stops flag parsing", () => {
    const parsed = parseArgs(["--", "--not-a-flag"], {});
    expect(parsed.positionals).toEqual(["--not-a-flag"]);
  });
});
