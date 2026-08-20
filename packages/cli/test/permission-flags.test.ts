import { describe, expect, test } from "bun:test";
import { parseArgs, ArgError } from "../src/args";
import { mergeOverrides, overridesFromFlags, parseRule, RuleError } from "../src/permission-flags";

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

describe("permission flag rules", () => {
  test("plain tool rules become tool decisions", () => {
    expect(parseRule("bash", "allow")).toEqual({ tools: { bash: "allow" } });
    expect(parseRule("fetch", "deny")).toEqual({ tools: { fetch: "deny" } });
  });

  test("bash rules become token prefixes", () => {
    expect(parseRule("bash:git status", "allow")).toEqual({ bashAllow: [["git", "status"]] });
    expect(parseRule('bash:echo "a && b"', "deny")).toEqual({ bashDeny: [["echo", "a && b"]] });
  });

  test("path rules become globs", () => {
    expect(parseRule("write:src/**", "allow")).toEqual({ pathAllow: ["src/**"] });
    expect(parseRule("edit:docs/*.md", "deny")).toEqual({ pathDeny: ["docs/*.md"] });
  });

  test("invalid rules are rejected", () => {
    expect(() => parseRule("", "allow")).toThrow(RuleError);
    expect(() => parseRule("bash:git status && rm -rf /", "allow")).toThrow(/single command prefix/);
    expect(() => parseRule("write:", "allow")).toThrow(RuleError);
  });

  test("multiple flags accumulate", () => {
    const overrides = overridesFromFlags(["bash", "bash:git status"], ["write:secrets/**"]);
    expect(overrides.tools).toEqual({ bash: "allow" });
    expect(overrides.bashAllow).toEqual([["git", "status"]]);
    expect(overrides.pathDeny).toEqual(["secrets/**"]);
  });

  test("CLI rules merge on top of moh.json overrides", () => {
    const base: import("@moh/core").PermissionOverrides = { tools: { bash: "ask" }, bashAllow: [["ls"]] };
    const merged = mergeOverrides(base, overridesFromFlags(["bash", "bash:git status"], []));
    expect(merged.tools).toEqual({ bash: "allow" });
    expect(merged.bashAllow).toEqual([["git", "status"], ["ls"]]);
  });
});
