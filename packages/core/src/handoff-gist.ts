/**
 * The secret-gist HandoffTransport (#433, T2 / #435).
 *
 * Channel: a **secret gist** (unlisted, not encrypted — #433 privacy:
 * only the synthesis + filtered extract ever leaves the machine, and in
 * T2 that payload is the raw artifact, which contains no tool output).
 * Discovery tag: `moh:handoff:<project-slug>:<gh-user>` — deterministic
 * per (project, author) so the other machine finds it without URLs (T3
 * consumes `fetch`; T2 only publishes).
 *
 * `gh` is invoked through an injectable runner (`GhRunner`) so tests
 * never shell out or touch the network, mirroring the tracker backend's
 * spawnSync seams. This module is client wiring support: the core agent
 * loop never calls it.
 *
 * One gist per (project, author): `publish` replaces the tagged gist —
 * **non-destructively** (#451): the new gist is created first, and the
 * old one is deleted only afterwards (delete failure = a stale extra
 * gist, never remote data loss). The append-only chain ordering keys
 * (supersedes-style anchor + timestamp, T4) travel inside the payload
 * itself, so a receiver tolerates multiple live gists during the swap.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { projectSlug } from "./session-store";
import type { HandoffPayload, HandoffTransport, HandoffTransportError } from "./handoff-transport";

/** One gh invocation: argv after the binary, optional stdin payload. */
export interface GhCall {
  args: string[];
  /** Written to the child's stdin (gist create reads content from `-`). */
  stdin?: string;
}

export interface GhResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Injected for tests: one `gh` invocation. */
export type GhRunner = (call: GhCall) => GhResult;

/** The real runner: synchronous `gh` child process. */
export const spawnGh: GhRunner = (call) => {
  let proc: ReturnType<typeof Bun.spawnSync> | undefined;
  try {
    proc = Bun.spawnSync(["gh", ...call.args], {
      stdout: "pipe",
      stderr: "pipe",
      // Synchronous stdin is bytes, not a stream: hand the payload over
      // at spawn time (gh gist create reads content from `-`).
      stdin: call.stdin === undefined ? "ignore" : new TextEncoder().encode(call.stdin),
    });
  } catch (e) {
    // ENOENT (no gh in PATH) surfaces as a thrown Bun error, not an exit
    // code — normalize so classification sees gh-missing, not a crash.
    const message = e instanceof Error ? e.message : String(e);
    return { exitCode: 127, stdout: "", stderr: message };
  }
  return { exitCode: proc.exitCode, stdout: proc.stdout?.toString() ?? "", stderr: proc.stderr?.toString() ?? "" };
};

export interface GistHandoffTransportOptions {
  cwd: string;
  /** Home dir for slug derivation; the artifact layout lives under `<home>/.moh`. */
  home?: string;
  gh?: GhRunner;
}

/** The deterministic gist description: `moh:handoff:<slug>:<gh-user>`. */
export function handoffGistTag(cwd: string, ghUser: string, home?: string): string {
  const slug = projectSlug(cwd, home ?? homedir());
  return `moh:handoff:${slug}:${ghUser}`;
}

/** Resolves the logged-in gh username, or why it cannot. */
export function ghUsername(gh: GhRunner): { ok: true; user: string } | { ok: false; error: HandoffTransportError } {
  const proc = gh({ args: ["api", "user", "--jq", ".login"] });
  if (proc.exitCode !== 0) return classifyGhFailure(proc);
  const user = proc.stdout.trim();
  if (!user) return { ok: false, error: { reason: "not-logged-in" } };
  return { ok: true, user };
}

/** Maps a failed gh exit onto the typed error surface. */
function classifyGhFailure(proc: GhResult): { ok: false; error: HandoffTransportError } {
  const err = proc.stderr.toLowerCase();
  if (
    err.includes("executable file not found") ||
    err.includes("command not found") ||
    err.includes("enoent") ||
    err.includes("no such file") ||
    // Bun's thrown ENOENT surfaces as the message above; a raw "$PATH" miss as this:
    err.includes("not found in $path")
  ) {
    return { ok: false, error: { reason: "gh-missing" } };
  }
  if (err.includes("not logged in") || err.includes("authentication required") || err.includes("gh auth login")) {
    return { ok: false, error: { reason: "not-logged-in" } };
  }
  return { ok: false, error: { reason: "failed", message: proc.stderr.trim() || `gh exited ${proc.exitCode}` } };
}

/** How many gists the tag lookup scans. The tagged gist is refreshed on
 * every publish, so it is normally the newest match; the cap bounds the
 * listing cost. Known edge: >LIMIT newer gists make the lookup miss and
 * publish creates a fresh tagged gist (duplicate tag, old one left) —
 * acceptable in v1, T3 discovery tolerates it by taking the newest hit. */
const GIST_LIST_LIMIT = "200";

/**
 * Builds the secret-gist transport. The gh user and tag are resolved
 * lazily per operation (login state may change between publish and
 * fetch). `publish` replaces any existing tagged gist so the tag always
 * resolves to the newest handoff; `fetch` returns it for T3 discovery.
 */
export function createGistHandoffTransport(options: GistHandoffTransportOptions): HandoffTransport {
  const gh = options.gh ?? spawnGh;
  const findTaggedGist = (user: string): { ok: true; id: string | undefined } | { ok: false; error: HandoffTransportError } => {
    const tag = handoffGistTag(options.cwd, user, options.home);
    const list = gh({ args: ["gist", "list", "--limit", GIST_LIST_LIMIT] });
    if (list.exitCode !== 0) return { ok: false, error: classifyGhFailure(list).error };
    // gh gist list prints tab-separated rows; in non-interactive runs
    // there is no header row, so parse every non-empty line and match the
    // description column against the tag.
    for (const line of list.stdout.split("\n")) {
      const [id, description] = line.split("\t");
      if (id && description === tag) return { ok: true, id };
    }
    return { ok: true, id: undefined };
  };

  /** Views one gist by id — the shared path of fetch() and fetchByUrl(). */
  const viewGist = (id: string) => {
    const proc = gh({ args: ["gist", "view", id, "--filename", "handoff.json", "--raw"] });
    if (proc.exitCode !== 0) return { ok: false as const, error: classifyGhFailure(proc).error };
    try {
      return {
        ok: true as const,
        payload: JSON.parse(proc.stdout) as HandoffPayload,
        url: `https://gist.github.com/${id}`,
      };
    } catch (e) {
      return { ok: false as const, error: { reason: "failed" as const, message: e instanceof Error ? e.message : String(e) } };
    }
  };

  return {
    async publish(payload) {
      const user = ghUsername(gh);
      if (!user.ok) return { ok: false, error: user.error };
      // Stamp the author (#451) at the seam that knows it: the payload
      // leaving the machine always records the publishing gh user.
      const authored: HandoffPayload = { ...payload, author: user.user, version: 2 };
      const tagged = findTaggedGist(user.user);
      if (!tagged.ok) return { ok: false, error: tagged.error };
      // Non-destructive replace (#451): create first, delete the old
      // tagged gist only after the create succeeded. A failed delete
      // leaves a duplicate tag the receiver resolves by newest-updated;
      // a failed create leaves the remote copy intact.
      // gh gist create reads content from stdin (`-`) with `-f` naming
      // the gist file; gists are secret by default (there is no --secret
      // flag — only --public, which we never pass).
      const proc = gh({
        args: ["gist", "create", "-d", handoffGistTag(options.cwd, user.user, options.home), "-f", "handoff.json", "-"],
        stdin: `${JSON.stringify(authored, null, 2)}\n`,
      });
      if (proc.exitCode !== 0) return { ok: false, error: classifyGhFailure(proc).error };
      if (tagged.id) gh({ args: ["gist", "delete", tagged.id, "--yes"] });
      return { ok: true, url: proc.stdout.trim() };
    },
    async fetch() {
      const user = ghUsername(gh);
      if (!user.ok) return { ok: false, error: user.error };
      const tagged = findTaggedGist(user.user);
      if (!tagged.ok) return { ok: false, error: tagged.error };
      if (!tagged.id) return { ok: false, error: { reason: "failed", message: "no handoff gist found" } };
      return viewGist(tagged.id);
    },
    async fetchByUrl(url) {
      // Accept the bare gist id as well as the full URL.
      const id = url.trim().replace(/^https?:\/\/gist\.github\.com\//, "");
      if (!/^[\w-]+$/.test(id)) return { ok: false, error: { reason: "failed", message: `not a gist url: ${url}` } };
      return viewGist(id);
    },
  };
}
