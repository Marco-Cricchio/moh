import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUserConfigFile, updateUserConfigFile, userConfigFile } from "../src/user-config";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "moh-ucore-")), "config");
}

describe("userConfigFile", () => {
  test("defaults to ~/.moh/config; home override works", () => {
    expect(userConfigFile().endsWith(join(".moh", "config"))).toBe(true);
    expect(userConfigFile("/tmp/h").endsWith(join(".moh", "config"))).toBe(true);
  });
});

describe("readUserConfigFile", () => {
  test("missing file reads as {}", () => {
    expect(readUserConfigFile(join(tmpdir(), `nope-${Date.now()}`, "config"))).toEqual({});
  });

  test("corrupt or non-object JSON reads as {}", () => {
    const read = () => "NOT JSON {";
    expect(readUserConfigFile("x", read)).toEqual({});
    expect(readUserConfigFile("x", () => "[1,2]")).toEqual({});
    expect(readUserConfigFile("x", () => "  ")).toEqual({});
  });

  test("reads unknown sections verbatim", () => {
    const data = { mode: "dev", mcpServers: { a: { type: "http", url: "u" } }, futureSection: { x: 1 } };
    expect(readUserConfigFile("x", () => JSON.stringify(data))).toEqual(data);
  });
});

describe("updateUserConfigFile", () => {
  test("creates the file and parent dirs on first write", () => {
    const file = join(mkdtempSync(join(tmpdir(), "moh-ucore-")), "nested", ".moh", "config");
    updateUserConfigFile(file, (d) => {
      d.mode = "dev";
    });
    expect(readUserConfigFile(file).mode).toBe("dev");
  });

  test("preserves unrelated keys and unknown sections on every write", () => {
    const file = tmpFile();
    updateUserConfigFile(file, (d) => {
      d.theme = "gruvbox";
      d.unknownSection = { keep: true };
    });
    updateUserConfigFile(file, (d) => {
      d.mcpServers = { search: { type: "stdio", command: "bun" } };
    });
    const data = readUserConfigFile(file);
    expect(data.theme).toBe("gruvbox");
    expect(data.unknownSection).toEqual({ keep: true });
    expect(data.mcpServers).toEqual({ search: { type: "stdio", command: "bun" } });
  });

  test("write is temp-file + rename: no temp file remains", () => {
    const file = tmpFile();
    updateUserConfigFile(file, (d) => {
      d.mode = "vibe";
    });
    expect(existsSync(`${file}.tmp-${process.pid}`)).toBe(false);
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
  });

  test("mutating an existing corrupt file starts from {}", () => {
    const file = tmpFile();
    updateUserConfigFile(file, () => {}, { read: () => "garbage" });
    expect(readUserConfigFile(file)).toEqual({});
  });
});
