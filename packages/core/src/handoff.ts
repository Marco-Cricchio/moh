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
  /** First-run handoff offer state. Kept in project config because the
   * transport policy is per-project: dismissed gets exactly one later
   * end-of-first-session reminder, then reminded suppresses all prompts. */
  onboarding: z.enum(["dismissed", "reminded"]).optional(),
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

/** Identifies the preceding handoff in a cross-machine continuity chain. */
export interface HandoffReference {
  sessionId: string;
  updatedAt: string;
}

export type HandoffTicketRelation = "claimed" | "mentioned";

/** A session-linked Wayfinder ticket, distilled from the event log. */
export interface HandoffWayfinderLink {
  id: string;
  relations: HandoffTicketRelation[];
}

/** Read-only Wayfinder context attached at publish time. The raw links are
 * crash-safe local state; citations and frontier are a best-effort snapshot. */
export interface HandoffWayfinderContext {
  tickets: Array<HandoffWayfinderLink & { title: string; url?: string }>;
  frontier: { ready: number; inProgress: number; blocked: number };
}

export interface RawHandoff {
  /** Payload schema version. v2 adds `author` (#451); v1 payloads are
   * still valid on read (back-compat: gist-sourced v1 handoffs are
   * per-author by construction via the deterministic tag). New writes
   * are always v2. */
  version: 1 | 2;
  kind: "raw";
  sessionId: string;
  /** The gh username of the publishing machine (#451). Set at publish
   * time; file imports from a different author are declined — handoffs
   * are per-persona (#433 Q6). Absent only in v1 payloads. */
  author?: string;
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
  /** Crash-safe ticket links inferred from the event log. */
  wayfinderLinks?: HandoffWayfinderLink[];
  /** Best-effort read-only citation/frontier snapshot attached on publish. */
  wayfinder?: HandoffWayfinderContext;
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
const TICKET_REFERENCE = /(?:^|[^\w])#(\d+)\b|https?:\/\/github\.com\/[^\s)]+\/issues\/(\d+)\b/g;

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

function ticketReferences(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(TICKET_REFERENCE)) ids.push(match[1] ?? match[2]!);
  return ids;
}

/** Links come only from model-visible messages and successful tracker claims:
 * tool results remain private and failed claims never become working state. */
export function wayfinderLinksFromEvents(events: ReadonlyArray<AgentEvent>): HandoffWayfinderLink[] {
  const relations = new Map<string, Set<HandoffTicketRelation>>();
  const claims = new Map<string, string>();
  const add = (id: string, relation: HandoffTicketRelation) => {
    if (!relations.has(id)) relations.set(id, new Set());
    relations.get(id)!.add(relation);
  };
  for (const event of events) {
    if (event.type === "user_message" || event.type === "assistant_delta") {
      for (const id of ticketReferences(event.text)) add(id, "mentioned");
    } else if (event.type === "tool_call" && event.name === "tracker_claim") {
      const id = typeof (event.args as { id?: unknown }).id === "string" ? (event.args as { id: string }).id : undefined;
      if (id) claims.set(event.callId, id);
    } else if (event.type === "tool_result" && event.ok) {
      const id = claims.get(event.callId);
      if (id) add(id, "claimed");
    }
  }
  return [...relations.entries()].map(([id, found]) => ({ id, relations: [...found] }));
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
  const wayfinderLinks = wayfinderLinksFromEvents(events);
  return {
    version: 2,
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
    ...(wayfinderLinks.length ? { wayfinderLinks } : {}),
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
