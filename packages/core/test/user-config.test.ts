import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

// #1431 (expand phase of S4.1): twins of the injected-I/O tests above, driven
// by a real temporary file. Each "(real file)" test pins the same output as its
// injected sibling on the current implementation; the migration tickets
// (#1432-#1436) delete the injected tests and keep these.
describe("user config guardian (real file) — twins of the injected-I/O tests", () => {
  const mode = (f: string) => statSync(f).mode & 0o777;

  test("corrupt, non-object and blank files read as {} (real file)", () => {
    const file = tmpFile();
    writeFileSync(file, "NOT JSON {");
    expect(readUserConfigFile(file)).toEqual({});
    writeFileSync(file, "[1,2]");
    expect(readUserConfigFile(file)).toEqual({});
    writeFileSync(file, "  ");
    expect(readUserConfigFile(file)).toEqual({});
  });

  test("a path that cannot be read as a file reads as {} (real file: a directory)", () => {
    expect(readUserConfigFile(mkdtempSync(join(tmpdir(), "moh-ucore-")))).toEqual({});
  });

  test("reads unknown sections verbatim (real file)", () => {
    const data = { mode: "dev", mcpServers: { a: { type: "http", url: "u" } }, futureSection: { x: 1 } };
    const file = tmpFile();
    writeFileSync(file, JSON.stringify(data));
    expect(readUserConfigFile(file)).toEqual(data);
  });

  test("mutating an existing corrupt file starts from {} and leaves a 0600 file (real file)", () => {
    const file = tmpFile();
    writeFileSync(file, "garbage");
    updateUserConfigFile(file, () => {});
    expect(readUserConfigFile(file)).toEqual({});
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
    expect(mode(file)).toBe(0o600);
  });

  test("read-modify-write keeps every unknown section and key of the whole file (real file)", () => {
    const file = tmpFile();
    const seed = { theme: "gruvbox", futureSection: { nested: [1, { a: true }] }, mcpServers: { s: { type: "stdio", command: "bun" } } };
    writeFileSync(file, JSON.stringify(seed));
    updateUserConfigFile(file, (d) => void (d.mode = "dev"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ...seed, mode: "dev" });
  });

  test("final mode is 0600 even over a pre-existing 0644 file (real file)", () => {
    const file = tmpFile();
    writeFileSync(file, "{}");
    chmodSync(file, 0o644);
    updateUserConfigFile(file, (d) => void (d.mode = "dev"));
    expect(mode(file)).toBe(0o600);
  });
});
