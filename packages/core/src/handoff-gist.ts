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
 * One gist per (project, author): `publish` replaces the tagged gist's
 * content — delete + create (the editor-based `gh gist edit` cannot run
 * headless) — so the tag always points at the newest payload. The
 * append-only chain ordering keys (supersedes-style anchor + timestamp,
 * T4) travel inside the payload itself.
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

  return {
    async publish(payload) {
      const user = ghUsername(gh);
      if (!user.ok) return { ok: false, error: user.error };
      const tagged = findTaggedGist(user.user);
      if (!tagged.ok) return { ok: false, error: tagged.error };
      if (tagged.id) {
        // A failed delete is not fatal: a fresh tagged gist still
        // publishes the newest payload (worst case: a duplicate tag the
        // receiver resolves by newest-updated).
        gh({ args: ["gist", "delete", tagged.id, "--yes"] });
      }
      // gh gist create reads content from stdin (`-`) with `-f` naming
      // the gist file; gists are secret by default (there is no --secret
      // flag — only --public, which we never pass).
      const proc = gh({
        args: ["gist", "create", "-d", handoffGistTag(options.cwd, user.user, options.home), "-f", "handoff.json", "-"],
        stdin: `${JSON.stringify(payload, null, 2)}\n`,
      });
      if (proc.exitCode !== 0) return { ok: false, error: classifyGhFailure(proc).error };
      return { ok: true, url: proc.stdout.trim() };
    },
    async fetch() {
      const user = ghUsername(gh);
      if (!user.ok) return { ok: false, error: user.error };
      const tagged = findTaggedGist(user.user);
      if (!tagged.ok) return { ok: false, error: tagged.error };
      if (!tagged.id) return { ok: false, error: { reason: "failed", message: "no handoff gist found" } };
      const proc = gh({ args: ["gist", "view", tagged.id, "--filename", "handoff.json", "--raw"] });
      if (proc.exitCode !== 0) return { ok: false, error: classifyGhFailure(proc).error };
      try {
        return {
          ok: true,
          payload: JSON.parse(proc.stdout) as HandoffPayload,
          url: `https://gist.github.com/${tagged.id}`,
        };
      } catch (e) {
        return { ok: false, error: { reason: "failed", message: e instanceof Error ? e.message : String(e) } };
      }
    },
  };
}
