/**
 * `moh sessions rename` (#477): child-process e2e only (never in-process
 * runCommand-style calls — see session memory) against an isolated HOME:
 * rename by file and by id, reset on empty name, unknown session error.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@moh/core";

const TMP_ROOT = join(tmpdir(), "moh-sessions-cli");

function harness() {
  mkdirSync(TMP_ROOT, { recursive: true });
  const home = mkdtempSync(join(TMP_ROOT, "home-"));
  const cwd = mkdtempSync(join(TMP_ROOT, "proj-"));
  writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock" }));
  const store = SessionStore.create(cwd, home);
  store.append({ type: "session_start", schemaVersion: 1, promptVersion: "p" });
  store.append({ type: "user_message", text: "first user message" });
  store.append({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, models: [] });
  const spawn = (argv: string[]) => {
    const proc = Bun.spawnSync(
      ["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...argv],
      { cwd, env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
    );
    return {
      code: proc.exitCode,
      stdout: new TextDecoder().decode(proc.stdout),
      stderr: new TextDecoder().decode(proc.stderr),
    };
  };
  return { home, cwd, file: store.file, id: store.file.replace(/.*\//, "").replace(/\.jsonl$/, ""), spawn };
}

describe("moh sessions rename (#477)", () => {
  test("--help prints the usage", () => {
    const { spawn } = harness();
    const { code, stdout } = spawn(["sessions", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("usage: moh sessions rename");
  });

  test("renames by session id and the event lands on the file", () => {
    const { spawn, file, id } = harness();
    const before = readFileSync(file, "utf8");
    const renamed = spawn(["sessions", "rename", id, "my name"]);
    expect(renamed.code).toBe(0);
    expect(renamed.stdout).toContain("my name");
    const after = readFileSync(file, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain('"session_renamed"');
    expect(after).toContain("my name");
  });

  test("renames by full file path", () => {
    const { spawn, file } = harness();
    const { code, stdout } = spawn(["sessions", "rename", file, "by path"]);
    expect(code).toBe(0);
    expect(stdout).toContain("by path");
    expect(readFileSync(file, "utf8")).toContain('"name":"by path"');
  });

  test("empty name resets the override", () => {
    const { spawn, file } = harness();
    expect(spawn(["sessions", "rename", file, "temp"]).code).toBe(0);
    const { code } = spawn(["sessions", "rename", file, ""]);
    expect(code).toBe(0);
    const events = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const renames = events.filter((e) => e.type === "session_renamed");
    expect(renames).toHaveLength(2);
    expect(renames.at(-1).name).toBe("");
  });

  test("unknown session id fails with exit code 2", () => {
    const { spawn } = harness();
    const { code, stderr } = spawn(["sessions", "rename", "20990101T000000000Z-00000000", "x"]);
    expect(code).toBe(2);
    expect(stderr).toContain("no session");
  });

  test("unknown subcommand fails", () => {
    const { spawn } = harness();
    const { code, stderr } = spawn(["sessions", "frobnicate"]);
    expect(code).toBe(2);
    expect(stderr).toContain("unknown command");
  });
});
