/**
 * Session Handoff (#433, T1 / #434): the raw, non-LLM handoff artifact
 * updated post-turn under the project's local state directory
 * (`~/.moh/projects/<slug>/handoff.json`). Crash-safe by construction:
 * the write is synchronous and atomic (temp + rename) at the moment the
 * turn settles, so a killed session always leaves the artifact of its
 * last completed turn. Fail-silent: an update failure never fails the
 * turn (MemoryRunner post-turn pattern, #88).
 *
 * The artifact is the local continuity layer only — it never leaves the
 * machine in T1. Publishing (secret gist) is the transport's job (T2+),
 * gated by moh.json `handoff.transport` (absent = Not Set = off).
 */
import { renameSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { projectSlug } from "./session-store";
import type { AgentEvent } from "./types";

/** moh.json `handoff` block. `transport` absent = "Not Set" = off.
 * "gist" activates the secret-gist transport (T2+); "none" is the
 * explicit full-off ("no gist on my account at all"). */
export const handoffConfigSchema = z.object({
  transport: z.enum(["gist", "none"]).optional(),
});

export type HandoffConfig = z.infer<typeof handoffConfigSchema>;

/** True when the transport is configured and active. Absent/none = off. */
export function transportActive(config: HandoffConfig | undefined): boolean {
  return config?.transport === "gist";
}

/** One git anchor: where the session stood when the artifact was written. */
export interface HandoffGitAnchor {
  branch?: string;
  head?: string;
  dirty?: boolean;
}

/** The raw (non-LLM) handoff artifact. Kind stays "raw" until exit-time
 * synthesis (T2+) may replace it with a synthesized payload. */
/** Identifies the preceding handoff in a cross-machine continuity chain. */
export interface HandoffReference {
  sessionId: string;
  updatedAt: string;
}

export interface RawHandoff {
  version: 1;
  kind: "raw";
  sessionId: string;
  /** Immediate predecessor when this session was seeded from a handoff.
   * The singleton gist holds the newest tip; this edge keeps the logical
   * handoff chain append-only across A → B → A transfers. */
  supersedes?: HandoffReference;
  /** ISO timestamp of the last completed turn this artifact reflects. */
  updatedAt: string;
  git: HandoffGitAnchor;
  /** Turn count so far in this session. */
  turns: number;
  /** The last user message of the session (capped). */
  lastUserMessage: string;
  /** The last assistant reply (capped) — the working-state headline. */
  lastAssistantMessage: string;
  /** Paths touched by write/edit tool calls, in first-seen order, capped. */
  files: string[];
  /** Test-looking bash commands run this session, capped. */
  tests: string[];
  /** Totals distilled from the event log. */
  counts: { toolCalls: number; errors: number; cancelled: number };
}

/** Caps: the artifact is a bridge, not a transcript. */
export const MAX_FILES = 200;
export const MAX_TESTS = 50;
export const MAX_MESSAGE_CHARS = 4_000;
export const MAX_USER_CHARS = 500;

/** Tool names whose args declare a touched file path. */
const FILE_TOOLS = new Set(["write", "edit"]);

/** Substrings that make a bash command "a test run" for the artifact. */
const TEST_MARKERS = ["test", "jest", "vitest", "mocha", "pytest"];

function looksLikeTest(command: string): boolean {
  return TEST_MARKERS.some((marker) => new RegExp(`\\b${marker}`).test(command));
}

function firstPathString(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  for (const key of ["path", "file", "filePath", "target"]) {
    const v = (args as Record<string, unknown>)[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function firstCommandString(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const v = (args as Record<string, unknown>).command ?? (args as Record<string, unknown>).cmd;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Reads the git anchor for the artifact. Fail-silent per field. */
export function gitAnchor(cwd: string): HandoffGitAnchor {
  const anchor: HandoffGitAnchor = {};
  try {
    const branch = Bun.spawnSync(["git", "-C", cwd, "branch", "--show-current"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (branch.exitCode === 0) {
      const name = branch.stdout.toString().trim();
      if (name) anchor.branch = name;
    }
  } catch {
    // not a repo / git missing: no branch
  }
  try {
    const head = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "HEAD"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (head.exitCode === 0 && head.stdout.toString().trim()) anchor.head = head.stdout.toString().trim();
  } catch {
    // no HEAD (empty repo): absent, not fake
  }
  try {
    const status = Bun.spawnSync(["git", "-C", cwd, "status", "--porcelain"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (status.exitCode === 0) anchor.dirty = status.stdout.toString().trim().length > 0;
  } catch {
    // dirty stays unknown
  }
  return anchor;
}

/** Builds the raw artifact from the session's event log. `gitInfo`
 * overrides anchor probing (tests); absent = live `gitAnchor(cwd)`. */
export function buildRawHandoff(
  events: ReadonlyArray<AgentEvent>,
  sessionId: string,
  turns: number,
  cwd: string,
  now: Date = new Date(),
  gitInfo?: HandoffGitAnchor,
  supersedes?: HandoffReference,
): RawHandoff {
  let lastUser = "";
  let assistant = "";
  const files: string[] = [];
  const tests: string[] = [];
  const seenFiles = new Set<string>();
  const counts = { toolCalls: 0, errors: 0, cancelled: 0 };
  for (const event of events) {
    switch (event.type) {
      case "user_message":
        lastUser = event.text;
        break;
      case "assistant_delta":
        assistant += event.text;
        if (assistant.length > MAX_MESSAGE_CHARS) assistant = assistant.slice(-MAX_MESSAGE_CHARS);
        break;
      case "tool_call": {
        counts.toolCalls += 1;
        const path = FILE_TOOLS.has(event.name) ? firstPathString(event.args) : undefined;
        if (path && !seenFiles.has(path) && files.length < MAX_FILES) {
          seenFiles.add(path);
          files.push(path);
        }
        if (event.name === "bash") {
          const command = firstCommandString(event.args);
          if (command && looksLikeTest(command) && tests.length < MAX_TESTS) tests.push(command);
        }
        break;
      }
      case "error":
        counts.errors += 1;
        break;
      case "cancelled":
        counts.cancelled += 1;
        break;
      default:
        break;
    }
  }
  return {
    version: 1,
    kind: "raw",
    sessionId,
    ...(supersedes ? { supersedes } : {}),
    updatedAt: now.toISOString(),
    git: gitInfo ?? gitAnchor(cwd),
    turns,
    lastUserMessage: lastUser.slice(0, MAX_USER_CHARS),
    lastAssistantMessage: assistant.trim().slice(0, MAX_MESSAGE_CHARS),
    files,
    tests,
    counts,
  };
}

/**
 * The post-turn handoff trigger (#434), following the MemoryRunner
 * pattern (#88) with one deliberate difference: the write is
 * synchronous. Crash safety is the point — by the time the turn's
 * settle callbacks return, the artifact already reflects the turn, so
 * a killed process cannot lose the last completed turn's state. The
 * whole update is wrapped fail-silent: a failure (unwritable dir, git
 * oddities upstream) never propagates to the session.
 */
export class HandoffRunner {
  readonly #file: string;
  readonly #sessionId: string;
  readonly #cwd: string;
  readonly #supersedes: HandoffReference | undefined;

  constructor(opts: { file: string; sessionId: string; cwd: string; supersedes?: HandoffReference }) {
    this.#file = opts.file;
    this.#sessionId = opts.sessionId;
    this.#cwd = opts.cwd;
    this.#supersedes = opts.supersedes;
  }

  /** Artifact path: <mohHome>/projects/<slug>/handoff.json. */
  static artifactFile(cwd: string, mohHome = join(homedir(), ".moh")): string {
    return join(mohHome, "projects", projectSlug(cwd, join(mohHome, "..")), "handoff.json");
  }

  get file(): string {
    return this.#file;
  }

  /** Called when a turn settles. Fail-silent, synchronous, atomic. */
  turnSettled(turns: number, events: ReadonlyArray<AgentEvent>): void {
    try {
      const dir = join(this.#file, "..");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const handoff = buildRawHandoff(events, this.#sessionId, turns, this.#cwd, new Date(), undefined, this.#supersedes);
      const tmp = `${this.#file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(handoff, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, this.#file);
    } catch {
      // Fail-silent: the artifact is a bridge, never a turn dependency.
    }
  }
}

/** Session-level handoff options (createSession seam, tests). */
export interface HandoffOptions {
  /** Artifact file override (tests). Default: HandoffRunner.artifactFile. */
  file?: string;
  /** Handoff accepted when this new session was created. */
  supersedes?: HandoffReference;
  /** Client-owned best-effort callback after a successful `git push` bash tool call.
   * The core observes the command but never knows the transport or `gh`. */
  onGitPush?: () => void;
}
