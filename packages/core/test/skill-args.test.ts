/** #765: skill argument parsing and placeholder substitution (pure). */
import { describe, expect, test } from "bun:test";
import { parseSkillArgs, substituteSkillArgs } from "../src/skill-args";

describe("parseSkillArgs", () => {
  test("positional tokens stay in order", () => {
    expect(parseSkillArgs(["1.2.3", "--dry"])).toEqual({ positional: ["1.2.3", "--dry"], named: {} });
  });

  test("key=value tokens become named args", () => {
    expect(parseSkillArgs(["1.2.3", "draft=yes"])).toEqual({
      positional: ["1.2.3"],
      named: { draft: "yes" },
    });
  });

  test("a value may be empty and contain = in the value", () => {
    expect(parseSkillArgs(["name=", "q=a=b"])).toEqual({
      positional: [],
      named: { name: "", q: "a=b" },
    });
  });

  test("tokens that merely look numeric before = stay positional when the key is invalid", () => {
    expect(parseSkillArgs(["=x", "1=2"])).toEqual({ positional: ["=x", "1=2"], named: {} });
  });
});

describe("substituteSkillArgs", () => {
  test("positional placeholders", () => {
    expect(substituteSkillArgs("release $1 then $2", { positional: ["1.2.3", "main"], named: {} })).toBe(
      "release 1.2.3 then main",
    );
  });

  test("$@ joins all positional args", () => {
    expect(substituteSkillArgs("args: $@", { positional: ["a", "b", "c"], named: {} })).toBe("args: a b c");
  });

  test("named with default used when absent", () => {
    expect(substituteSkillArgs("level ${level:-medium}", { positional: [], named: {} })).toBe("level medium");
  });

  test("named overrides default", () => {
    expect(substituteSkillArgs("level ${level:-medium}", { positional: [], named: { level: "high" } })).toBe(
      "level high",
    );
  });

  test("named without default and absent resolves to empty string", () => {
    expect(substituteSkillArgs("issue ${id}!", { positional: [], named: {} })).toBe("issue !");
  });

  test("unfilled positional resolves to empty string", () => {
    expect(substituteSkillArgs("a $1 b $2", { positional: ["x"], named: {} })).toBe("a x b ");
  });

  test("unknown $ patterns stay literal", () => {
    const text = "costs $x, $, $ARGUMENTS, ${weird style}";
    expect(substituteSkillArgs(text, { positional: [], named: {} })).toBe(text);
  });

  test("$10 reads as $1 followed by a literal 0", () => {
    expect(substituteSkillArgs("$10", { positional: ["a"], named: {} })).toBe("a0");
  });
});
