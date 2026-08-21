import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/run";
import { createHash } from "node:crypto";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * e2e via Bun.spawnSync against the real CLI path with an isolated HOME and
 * cwd: no API keys, no stdin, mock/cassette providers only (#31).
 */
function harness() {
  const dir = `/tmp/moh-cli-e2e-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const cwd = join(dir, "project");
  const home = join(dir, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  const spawn = (argv: string[]) => {
    const proc = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...argv], {
      cwd,
      env: { ...process.env, HOME: home, MOH_ENDPOINT_TEST_API_KEY: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: proc.exitCode,
      stdout: new TextDecoder().decode(proc.stdout),
      stderr: new TextDecoder().decode(proc.stderr),
    };
  };
  return { cwd, home, spawn };
}

function readEvents(raw: string): any[] {
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

function sessionFiles(home: string): string[] {
  const projects = join(home, ".moh", "projects");
  if (!existsSync(projects)) return [];
  const out: string[] = [];
  for (const slug of readdirSync(projects)) {
    const slugDir = join(projects, slug);
    if (!statSync(slugDir).isDirectory()) continue;
    for (const f of readdirSync(slugDir)) if (f.endsWith(".jsonl")) out.push(join(slugDir, f));
  }
  return out;
}

describe("moh run (e2e)", () => {
  test("works out-of-the-box with the mock provider: no API keys, no prompts", () => {
    const { spawn, home } = harness();
    const res = spawn(["run", "hello"]);
    expect(res.code).toBe(0);
    const events = readEvents(res.stdout);
    expect(events[0].type).toBe("session_start");
    expect(events[0].schemaVersion).toBeGreaterThan(0);
    expect(events.at(-1).type).toBe("done");
    expect(events.some((e) => e.type === "assistant_delta")).toBe(true);
    // Session JSONL written with the same events.
    const files = sessionFiles(home);
    expect(files).toHaveLength(1);
    const logged = readEvents(readFileSync(files[0]!, "utf8"));
    expect(logged.length).toBe(events.length);
    expect(logged[0].type).toBe("session_start");
    expect(logged[0].promptVersion).toBeTruthy();
  });

  test("--allow bash lets a scripted bash call run; the log records grant and result", () => {
    const { cwd, spawn } = harness();
    writeFileSync(
      join(cwd, "cassette.json"),
      JSON.stringify([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "bash", args: { command: "echo moh-ran" } }] },
        { deltas: ["bash worked"], finish: "stop" },
      ]),
    );
    const res = spawn(["run", "--cassette", "cassette.json", "--allow", "bash:echo", "do it"]);
    expect(res.code).toBe(0);
    const events = readEvents(res.stdout);
    const result = events.find((e) => e.type === "tool_result")!;
    expect(result.ok).toBe(true);
    expect(result.output).toContain("moh-ran");
  });

  test("--deny write produces a structured denial the model sees; nothing is written", () => {
    const { cwd, spawn } = harness();
    writeFileSync(
      join(cwd, "cassette.json"),
      JSON.stringify([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "write", args: { path: "evil.txt", content: "x" } }] },
        { deltas: ["denied, fine"], finish: "stop" },
      ]),
    );
    const res = spawn(["run", "--cassette", "cassette.json", "--deny", "write", "write something"]);
    expect(res.code).toBe(0);
    const events = readEvents(res.stdout);
    const denial = events.find((e) => e.type === "permission_denied")!;
    expect(denial.tool).toBe("write");
    expect(denial.reason).toBe("rule");
    const result = events.find((e) => e.type === "tool_result")!;
    expect(result.ok).toBe(false);
    expect(result.output).toContain("permission denied");
    expect(existsSync(join(cwd, "evil.txt"))).toBe(false);
  });

  test("unpermitted tools fail fast in headless mode without blocking on stdin", () => {
    const { cwd, spawn } = harness();
    writeFileSync(
      join(cwd, "cassette.json"),
      JSON.stringify([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "bash", args: { command: "echo nope" } }] },
        { deltas: ["ok, skipped"], finish: "stop" },
      ]),
    );
    const res = spawn(["run", "--cassette", "cassette.json", "try bash"]);
    // No --allow: bash defaults to "ask", headless denies it structurally.
    expect(res.code).toBe(0);
    const events = readEvents(res.stdout);
    const denial = events.find((e) => e.type === "permission_denied")!;
    expect(denial.reason).toBe("headless");
    const result = events.find((e) => e.type === "tool_result")!;
    expect(result.ok).toBe(false);
  });

  test("--session resumes a previous session file and appends to it", () => {
    const { spawn, home } = harness();
    const first = spawn(["run", "first message"]);
    expect(first.code).toBe(0);
    const file = sessionFiles(home)[0]!;
    const before = readEvents(readFileSync(file, "utf8"));
    const second = spawn(["run", "--session", file, "second message"]);
    expect(second.code).toBe(0);
    const events = readEvents(second.stdout);
    expect(events.filter((e) => e.type === "user_message").map((e) => e.text)).toEqual(["second message"]);
    const after = readEvents(readFileSync(file, "utf8"));
    expect(after.length).toBe(before.length + events.length);
    expect(after[0]).toEqual(before[0]); // same session_start, appended in place
  });

  test("echo provider e2e: catches a context-engineering regression without API calls (#39)", () => {
    const { cwd, spawn } = harness();
    const run = () => {
      const res = spawn(["run", "--provider", "echo", "ctx-probe"]);
      expect(res.code).toBe(0);
      const events = readEvents(res.stdout);
      const reply = events
        .filter((e) => e.type === "assistant_delta")
        .map((e) => e.text)
        .join("");
      return JSON.parse(reply) as {
        systemSha256: string;
        tools: string[];
        messages: { role: string; sha256: string }[];
      };
    };
    const base = run();
    // The provider saw the user message and the full tool registry.
    expect(base.messages.at(-1)).toEqual({ role: "user", sha256: sha256("ctx-probe") });
    expect(base.tools).toContain("bash");
    expect(base.tools).toContain("read");
    // Injecting AGENTS.md must change the system prompt the provider receives.
    // If the digest stays the same, instructions injection has regressed.
    writeFileSync(join(cwd, "AGENTS.md"), "MARKER-e2e-7c31 never guess file contents");
    const withFile = run();
    expect(withFile.systemSha256).not.toBe(base.systemSha256);
    expect(withFile.messages.at(-1)).toEqual({ role: "user", sha256: sha256("ctx-probe") });
  });

  test("usage errors: no prompt, unknown flag", () => {
    const { spawn } = harness();
    expect(spawn(["run"]).code).toBe(2);
    expect(spawn(["run", "--nope", "x"]).code).toBe(2);
  });
});
