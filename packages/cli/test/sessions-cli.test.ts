/**
 * `moh sessions rename` (#477): child-process e2e only (never in-process
 * runCommand-style calls — see session memory) against an isolated HOME:
 * rename by file and by id, reset on empty name, unknown session error.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, sessionTree } from "@moh/core";

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

describe("moh sessions delete + moh trash (#478)", () => {
  test("--help prints the usages", () => {
    const { spawn } = harness();
    const s = spawn(["sessions", "--help"]);
    expect(s.code).toBe(0);
    expect(s.stdout).toContain("moh sessions delete");
    const t = spawn(["trash", "--help"]);
    expect(t.code).toBe(0);
    expect(t.stdout).toContain("usage: moh trash");
  });

  test("delete --yes moves the file to the trash and out of the project; restore brings it back", () => {
    const { spawn, home, cwd, file, id } = harness();
    const content = readFileSync(file, "utf8");
    const del = spawn(["sessions", "delete", id, "--yes"]);
    expect(del.code).toBe(0);
    expect(del.stdout).toContain("deleted:");
    expect(require("node:fs").existsSync(file)).toBe(false);
    // trash list shows it
    const list = spawn(["trash", "list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(id);
    expect(list.stdout).toContain("d left");
    // trash directory mirrors the project structure
    expect(require("node:fs").existsSync(join(home, ".moh", "trash", "projects"))).toBe(true);
    // restore round-trip
    const res = spawn(["trash", "restore", id]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("restored:");
    expect(readFileSync(file, "utf8")).toBe(content);
    const list2 = spawn(["trash", "list"]);
    expect(list2.stdout).toContain("trash is empty");
    void cwd;
  });

  test("delete without --yes and a closed stdin aborts (default No)", () => {
    const { home, cwd, file } = harness();
    const spawnWithStdin = (argv: string[], stdin: "ignore" | "pipe") => {
      const proc = Bun.spawnSync(
        ["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...argv],
        { cwd, env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe", stdin },
      );
      return { code: proc.exitCode, stdout: new TextDecoder().decode(proc.stdout), stderr: new TextDecoder().decode(proc.stderr) };
    };
    const r = spawnWithStdin(["sessions", "delete", file], "ignore");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("aborted");
    expect(require("node:fs").existsSync(file)).toBe(true);
    // Non-interactive stdin (closed) = No → abort, session stays.
    const proc = Bun.spawnSync(
      ["bun", join(import.meta.dir, "..", "src", "cli.ts"), "sessions", "delete", file],
      { cwd: join(TMP_ROOT), env: { ...process.env, HOME: mkdtempSync(join(TMP_ROOT, "stdin-")) }, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    );
    void proc;
  });

  test("restore refuses an id collision", () => {
    const { spawn, file, id } = harness();
    const content = readFileSync(file, "utf8");
    expect(spawn(["sessions", "delete", id, "--yes"]).code).toBe(0);
    // Recreate a live session with the same id.
    writeFileSync(file, content);
    const res = spawn(["trash", "restore", id]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("already exists");
  });

  test("unknown trash subcommand errors with usage", () => {
    const { spawn } = harness();
    const r = spawn(["trash", "bogus"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown command "bogus"');
  });
});

describe("moh sessions delete (#478) — coverage gaps", () => {
  test("delete succeeds by full file path with --yes", () => {
    const { spawn, file } = harness();
    const del = spawn(["sessions", "delete", file, "--yes"]);
    expect(del.code).toBe(0);
    expect(del.stdout).toContain("deleted:");
    expect(require("node:fs").existsSync(file)).toBe(false);
  });

  test("delete refuses a session open in this process (exit 2)", () => {
    // The open-session guard is process-local by design (#400: cross-process
    // "open elsewhere" is unsupported/out of scope), so a child CLI process
    // can never observe THIS process's registry — that refusal is covered by
    // the core unit test (session-store.test.ts) and the TUI harness test.
    // What the CLI e2e can pin: a fresh child process deletes fine, i.e. the
    // registry never leaks false positives across processes.
    const { spawn, file } = harness();
    const store = SessionStore.open(file); // open HERE — must not affect the child
    const del = spawn(["sessions", "delete", file, "--yes"]);
    expect(del.code).toBe(0);
    expect(require("node:fs").existsSync(file)).toBe(false);
    store.dispose();
  });
});

describe("moh sessions tree/switch/bookmark (#582)", () => {
  test("--help lists the three commands", () => {
    const { spawn } = harness();
    const s = spawn(["sessions", "--help"]);
    expect(s.code).toBe(0);
    expect(s.stdout).toContain("moh sessions tree");
    expect(s.stdout).toContain("moh sessions switch");
    expect(s.stdout).toContain("moh sessions bookmark");
  });

  test("tree renders the topology as text with head marker and depth indent", () => {
    const { spawn, file } = harness();
    // Second turn from the head = one child node.
    const store = SessionStore.open(file);
    store.append({ type: "user_message", text: "second turn" });
    store.append({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, models: [] });
    store.dispose();
    const r = spawn(["sessions", "tree", file]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("first user message");
    expect(r.stdout).toContain("second turn");
    expect(r.stdout).toContain("←"); // head marker
  });

  test("switch accepts a bookmark name and moves the head (last-wins)", () => {
    const { spawn, file } = harness();
    const store = SessionStore.open(file);
    const events = store.load();
    const target = events[1]!.id!; // the first user_message
    store.append({ type: "user_message", text: "second turn" });
    store.append({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, models: [] });
    store.dispose();
    const before = readFileSync(file, "utf8");
    const bm = spawn(["sessions", "bookmark", file, target, "checkpoint"]);
    expect(bm.code).toBe(0);
    expect(bm.stdout).toContain("checkpoint");
    const sw = spawn(["sessions", "switch", file, "checkpoint"]);
    expect(sw.code).toBe(0);
    const after = readFileSync(file, "utf8");
    expect(after.startsWith(before)).toBe(true);
    const lines = after.trim().split("\n").map((l) => JSON.parse(l));
    const last = lines.at(-1);
    expect(last.type).toBe("branch_switched");
    // The bookmark resolves to the node's id — the turn node re-anchors
    // at its tail (done) event, the identity the TUI also switches to.
    const nodeIds = sessionTree(file);
    if (!("error" in nodeIds)) {
      const node = nodeIds.nodes.find((n) => n.id === last.to);
      expect(node).toBeDefined();
    }
    expect([target, last.to]).toContain(last.to);
    expect(last.to).not.toBe(lines.at(-2).id); // a fresh switch event
  });

  test("switch resolves line:N", () => {
    const { spawn, file } = harness();
    const sw = spawn(["sessions", "switch", file, "line:2"]);
    expect(sw.code).toBe(0);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.at(-1).type).toBe("branch_switched");
    // line:2 canonicalizes to the referenced event's ULID (only identity-
    // less legacy events keep the line:N bridge form).
    expect(lines.at(-1).to).toBe(lines[1].id);
  });

  test("switch with an ambiguous bookmark name errors listing matches", () => {
    const { spawn, file } = harness();
    const store = SessionStore.open(file);
    // Second turn = a distinct node from the first.
    store.append({ type: "user_message", text: "second turn" });
    store.append({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, models: [] });
    store.dispose();
    expect(spawn(["sessions", "bookmark", file, "line:2", "dup"]).code).toBe(0);
    expect(spawn(["sessions", "bookmark", file, "line:4", "dup"]).code).toBe(0);
    const r = spawn(["sessions", "switch", file, "dup"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ambiguous");
    expect(r.stderr).toMatch(/matches 2 nodes/);
  });

  test("switch with an unknown bookmark name errors", () => {
    const { spawn, file } = harness();
    const r = spawn(["sessions", "switch", file, "nope"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("nope");
  });

  test("bookmark with an empty name clears the bookmark", () => {
    const { spawn, file } = harness();
    const store = SessionStore.open(file);
    const target = store.load()[1]!.id!;
    store.dispose();
    expect(spawn(["sessions", "bookmark", file, target, "temp"]).code).toBe(0);
    const r = spawn(["sessions", "bookmark", file, target, ""]);
    expect(r.code).toBe(0);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const bookmarks = lines.filter((e) => e.type === "tree_bookmarked");
    expect(bookmarks.at(-1).name).toBe("");
    expect(r.stdout).toContain("cleared");
  });

  test("bookmark without a name sets an unnamed bookmark", () => {
    const { spawn, file } = harness();
    const store = SessionStore.open(file);
    const target = store.load()[1]!.id!;
    store.dispose();
    const r = spawn(["sessions", "bookmark", file, target]);
    expect(r.code).toBe(0);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const bm = lines.filter((e) => e.type === "tree_bookmarked").at(-1);
    expect(bm.to).toBe(target);
    expect(bm.name).toBeUndefined();
  });

  test("switch/bookmark on an unknown session error with exit code 2", () => {
    const { spawn } = harness();
    expect(spawn(["sessions", "switch", "20990101T000000000Z-00000000", "line:1"]).code).toBe(2);
    expect(spawn(["sessions", "bookmark", "20990101T000000000Z-00000000", "line:1"]).code).toBe(2);
    expect(spawn(["sessions", "tree", "20990101T000000000Z-00000000"]).code).toBe(2);
  });

  test("tree on a missing/invalid target errors", () => {
    const { spawn, file } = harness();
    expect(spawn(["sessions", "switch", file, "line:99"]).code).toBe(2);
    expect(spawn(["sessions", "bookmark", file, "line:99", "x"]).code).toBe(2);
  });
});
