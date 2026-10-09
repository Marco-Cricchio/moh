import { describe, expect, test } from "bun:test";
import { bangActiveTurnRefusal, parseBangCommand, stripBangEscape } from "../src/bang-command";

describe("parseBangCommand (ADR-0076)", () => {
  test("plain ! executes without auto-send", () => {
    expect(parseBangCommand("!git status")).toEqual({ autoSend: false, command: "git status" });
  });

  test("!! executes and auto-sends", () => {
    expect(parseBangCommand("!!bun test")).toEqual({ autoSend: true, command: "bun test" });
  });

  test("inner ! is literal text", () => {
    expect(parseBangCommand("echo hi!")).toBeNull();
  });

  test("\\! escapes a literal leading bang", () => {
    expect(parseBangCommand("\\!important")).toBeNull();
    expect(stripBangEscape("\\!important")).toBe("!important");
    expect(stripBangEscape("hello")).toBe("hello");
  });

  test("a bare ! or !! is not a command", () => {
    expect(parseBangCommand("!")).toBeNull();
    expect(parseBangCommand("!!")).toBeNull();
  });

  test("non-bang drafts are null", () => {
    expect(parseBangCommand("hello")).toBeNull();
    expect(parseBangCommand("")).toBeNull();
  });

  test("whitespace after the bang is trimmed", () => {
    expect(parseBangCommand("!   git status  ")).toEqual({ autoSend: false, command: "git status" });
  });

  test("active-turn refusal names the escape hatches", () => {
    expect(bangActiveTurnRefusal()).toContain("esc");
  });
});
