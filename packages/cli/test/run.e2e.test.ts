import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
    const proc = Bun.spawnSync(
      ["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...argv],
      {
        cwd,
        env: { ...process.env, HOME: home, MOH_ENDPOINT_TEST_API_KEY: "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
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
    for (const f of readdirSync(slugDir))
      if (f.endsWith(".jsonl")) out.push(join(slugDir, f));
  }
  return out;
}

describe("moh run (e2e)", () => {
  test("--yolo: session_mode yolo, out-of-root write allowed, no prompts (#377)", () => {
    const { cwd, spawn } = harness();
    const outside = `/tmp/moh-cli-e2e-outside-${process.pid}-${Date.now()}`;
    writeFileSync(
      join(cwd, "cassette.json"),
      JSON.stringify([
        {
          deltas: [],
          finish: "tool_calls",
          toolCalls: [
            {
              name: "write",
              args: { path: `${outside}/f.txt`, content: "yolo" },
            },
          ],
        },
        { deltas: ["done"], finish: "stop" },
      ]),
    );
    const res = spawn([
      "run",
      "--cassette",
      "cassette.json",
      "--yolo",
      "write outside",
    ]);
    expect(res.code).toBe(0);
    const events = readEvents(res.stdout);
    expect(events.find((e) => e.type === "session_mode")?.mode).toBe("yolo");
    const result = events.find((e) => e.type === "tool_result")!;
    expect(result.ok).toBe(true);
    const grant = events.find((e) => e.type === "permission_granted");
    expect(grant?.reason).toBe("yolo");
    expect(readFileSync(`${outside}/f.txt`, "utf8")).toBe("yolo");
  });

  test("--dangerously-bypass-permissions is rejected, not aliased (#377)", () => {
    const { spawn } = harness();
    const res = spawn(["run", "--dangerously-bypass-permissions", "hi"]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("use --yolo");
    const bare = spawn(["--dangerously-bypass-permissions"]);
    expect(bare.code).toBe(2);
  });

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
        {
          deltas: [],
          finish: "tool_calls",
          toolCalls: [{ name: "bash", args: { command: "echo moh-ran" } }],
        },
        { deltas: ["bash worked"], finish: "stop" },
      ]),
    );
    const res = spawn([
      "run",
      "--cassette",
      "cassette.json",
      "--allow",
      "bash:echo",
      "do it",
    ]);
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
        {
          deltas: [],
          finish: "tool_calls",
          toolCalls: [
            { name: "write", args: { path: "evil.txt", content: "x" } },
          ],
        },
        { deltas: ["denied, fine"], finish: "stop" },
      ]),
    );
    const res = spawn([
      "run",
      "--cassette",
      "cassette.json",
      "--deny",
      "write",
      "write something",
    ]);
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
        {
          deltas: [],
          finish: "tool_calls",
          toolCalls: [{ name: "bash", args: { command: "echo nope" } }],
        },
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
    expect(
      events.filter((e) => e.type === "user_message").map((e) => e.text),
    ).toEqual(["second message"]);
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
    expect(base.messages.at(-1)).toEqual({
      role: "user",
      sha256: sha256("ctx-probe"),
    });
    expect(base.tools).toContain("bash");
    expect(base.tools).toContain("read");
    // Injecting AGENTS.md must change the system prompt the provider receives.
    // If the digest stays the same, instructions injection has regressed.
    writeFileSync(
      join(cwd, "AGENTS.md"),
      "MARKER-e2e-7c31 never guess file contents",
    );
    const withFile = run();
    expect(withFile.systemSha256).not.toBe(base.systemSha256);
    expect(withFile.messages.at(-1)).toEqual({
      role: "user",
      sha256: sha256("ctx-probe"),
    });
  });

  test("usage errors: no prompt, unknown flag", () => {
    const { spawn } = harness();
    expect(spawn(["run"]).code).toBe(2);
    expect(spawn(["run", "--nope", "x"]).code).toBe(2);
  });

  test("broken provider reference is a visible error (no silent demo fallback, #100)", () => {
    const { cwd, spawn } = harness();
    writeFileSync(
      join(cwd, "moh.json"),
      JSON.stringify({ provider: "no-such-endpoint/model" }),
    );
    const res = spawn(["run", "hello"]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("unknown provider");
    expect(res.stdout.trim()).toBe(""); // nothing ran, no session events
  });

  test("invalid moh.json is a visible config error", () => {
    const { cwd, spawn } = harness();
    writeFileSync(join(cwd, "moh.json"), "{ not json");
    const res = spawn(["run", "hello"]);
    expect(res.code).toBe(2);
    expect(res.stderr).toBeTruthy();
  });

  // #401: headless session discovery via --resume.
  describe("--resume (#401)", () => {
    test("no query lists the project's sessions newest first with ids and titles", () => {
      const { spawn, home } = harness();
      // Nothing yet: graceful empty behavior.
      const empty = spawn(["run", "--resume"]);
      expect(empty.code).toBe(1);
      expect(empty.stderr).toContain("no previous session");

      expect(spawn(["run", "first session message"]).code).toBe(0);
      expect(spawn(["run", "second session message"]).code).toBe(0);
      const res = spawn(["run", "--resume"]);
      expect(res.code).toBe(0);
      const lines = res.stdout.trim().split("\n");
      expect(lines).toHaveLength(2);
      // Newest first: the second message's session is on top.
      expect(lines[0]).toMatch(/second session message/);
      expect(lines[1]).toMatch(/first session message/);
      for (const line of lines)
        expect(line).toMatch(/^\d{8}T\d{6}\d{3}Z-[0-9a-f]{8}  /);
      // Both ids resolve to real session files under this project's slug.
      for (const line of lines) {
        const id = line.split("  ")[0]!;
        expect(sessionFiles(home).some((f) => f.endsWith(`${id}.jsonl`))).toBe(
          true,
        );
      }
    });

    test("a query prints the best-matching session; no match is a graceful error with hints", () => {
      const { spawn } = harness();
      expect(spawn(["run", "fix the login bug"]).code).toBe(0);
      expect(spawn(["run", "refactor the parser"]).code).toBe(0);

      const hit = spawn(["run", "--resume", "login"]);
      expect(hit.code).toBe(0);
      expect(hit.stdout).toContain("fix the login bug");

      const miss = spawn(["run", "--resume", "no-such-thing"]);
      expect(miss.code).toBe(1);
      expect(miss.stderr).toContain('no session matches "no-such-thing"');
      // Hints list the project's sessions so the user can refine.
      expect(miss.stderr).toContain("fix the login bug");
      expect(miss.stderr).toContain("refactor the parser");
    });

    test("exact session id wins over title matches", () => {
      const { spawn, home } = harness();
      expect(spawn(["run", "alpha topic"]).code).toBe(0);
      expect(spawn(["run", "beta topic"]).code).toBe(0);
      const files = sessionFiles(home);
      const newestId = files
        .map((f) => basename(f, ".jsonl"))
        .sort()
        .at(-1)!;
      const res = spawn(["run", "--resume", newestId]);
      expect(res.code).toBe(0);
      // The id is unique: exactly the session it names, not a title tie.
      expect(res.stdout.trim().split("\n")).toHaveLength(1);
    });

    test("with --prompt the best match is resumed and appended to", () => {
      const { spawn, home } = harness();
      expect(spawn(["run", "unique-marker-one hello"]).code).toBe(0);
      expect(spawn(["run", "other session"]).code).toBe(0);
      const file = sessionFiles(home).find((f) => {
        const raw = readFileSync(f, "utf8");
        return raw.includes("unique-marker-one");
      })!;
      const before = readEvents(readFileSync(file, "utf8")).length;

      const res = spawn([
        "run",
        "--resume",
        "unique-marker-one",
        "--prompt",
        "continue that",
      ]);
      expect(res.code).toBe(0);
      const events = readEvents(res.stdout);
      expect(
        events.filter((e) => e.type === "user_message").map((e) => e.text),
      ).toEqual(["continue that"]);
      const after = readEvents(readFileSync(file, "utf8"));
      expect(after.length).toBe(before + events.length);
    });

    test("cross-machine: discovery works from a clone at a different path (declared identity slug, #398/#401)", () => {
      const { cwd, home } = harness();
      const spawnIn = (dir: string, argv: string[]) => {
        const proc = Bun.spawnSync(
          ["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...argv],
          {
            cwd: dir,
            env: { ...process.env, HOME: home, MOH_ENDPOINT_TEST_API_KEY: "" },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        return {
          code: proc.exitCode,
          stdout: new TextDecoder().decode(proc.stdout),
          stderr: new TextDecoder().decode(proc.stderr),
        };
      };
      expect(spawnIn(cwd, ["run", "portable session topic"]).code).toBe(0);

      // Same declared identity, different checkout path: the identity slug
      // resolves to the same projects dir, so discovery finds the session.
      const clone = join(dirname(cwd), "clone-elsewhere");
      mkdirSync(clone, { recursive: true });
      mkdirSync(join(clone, ".moh"), { recursive: true });
      copyFileSync(
        join(cwd, ".moh", "project.json"),
        join(clone, ".moh", "project.json"),
      );
      const listed = spawnIn(clone, ["run", "--resume", "portable"]);
      expect(listed.code).toBe(0);
      expect(listed.stdout).toContain("portable session topic");
    });

    test("usage: --resume is exclusive with --session and with a positional prompt", () => {
      const { spawn, home } = harness();
      expect(spawn(["run", "seed"]).code).toBe(0);
      const file = sessionFiles(home)[0]!;
      expect(spawn(["run", "--resume", "seed", "--session", file]).code).toBe(
        2,
      );
      expect(spawn(["run", "--resume", "seed", "and a positional"]).code).toBe(
        2,
      );
    });
  });
});
