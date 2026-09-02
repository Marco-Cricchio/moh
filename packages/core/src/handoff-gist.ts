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
 * content (delete + create — the runner seam has no stdin), so the tag
 * always points at the newest payload. The append-only chain ordering
 * keys (`supersedes`-style anchor + timestamp, T4) travel inside the
 * payload itself.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { projectSlug } from "./session-store";
import type { HandoffPayload, HandoffTransport, HandoffTransportError } from "./handoff-transport";

/** One `gh` invocation: argv after the `gh` binary. Injected for tests. */
export type GhRunner = (args: string[]) => { exitCode: number; stdout: string; stderr: string };

/** The real runner: synchronous `gh` child process. */
export const spawnGh: GhRunner = (args) => {
  const proc = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
};

export interface GistHandoffTransportOptions {
  cwd: string;
  /** Home dir for slug derivation; the artifact layout lives under `<home>/.moh`. */
  home?: string;
  gh?: GhRunner;
}

/** The deterministic gist description: `moh:handoff:<slug>:<gh-user>`. */
export function handoffGistTag(cwd: string, ghUser: string, home?: string): string {
  const slug = projectSlug(cwd, join(home ?? homedir(), ".."));
  return `moh:handoff:${slug}:${ghUser}`;
}

/** Resolves the logged-in gh username, or why it cannot. */
export function ghUsername(gh: GhRunner): { ok: true; user: string } | { ok: false; error: HandoffTransportError } {
  const proc = gh(["api", "user", "--jq", ".login"]);
  if (proc.exitCode !== 0) return classifyGhFailure(proc);
  const user = proc.stdout.trim();
  if (!user) return { ok: false, error: { reason: "not-logged-in" } };
  return { ok: true, user };
}

/** Maps a failed gh exit onto the typed error surface. */
function classifyGhFailure(proc: { exitCode: number; stdout: string; stderr: string }): {
  ok: false;
  error: HandoffTransportError;
} {
  const err = proc.stderr.toLowerCase();
  if (err.includes("executable file not found") || err.includes("command not found") || err.includes("enoent")) {
    return { ok: false, error: { reason: "gh-missing" } };
  }
  if (err.includes("not logged in") || err.includes("authentication required") || err.includes("gh auth login")) {
    return { ok: false, error: { reason: "not-logged-in" } };
  }
  return { ok: false, error: { reason: "failed", message: proc.stderr.trim() || `gh exited ${proc.exitCode}` } };
}

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
    const list = gh(["gist", "list", "--limit", "100"]);
    if (list.exitCode !== 0) return { ok: false, error: classifyGhFailure(list).error };
    for (const line of list.stdout.split("\n").slice(1)) {
      // gh gist list: <id>\t<description>\t<files>\t<visibility>\t<updated>
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
        const del = gh(["gist", "delete", tagged.id, "--yes"]);
        // A failed delete is not fatal: creating a fresh gist still leaves
        // the newest payload discoverable via the newest-updated tagged hit.
        if (del.exitCode !== 0 && del.stderr.toLowerCase().includes("not found")) {
          // already gone — fine
        }
      }
      const proc = gh([
        "gist",
        "create",
        "--secret",
        "-d",
        handoffGistTag(options.cwd, user.user, options.home),
        "-f",
        "handoff.json",
        `${JSON.stringify(payload, null, 2)}\n`,
      ]);
      if (proc.exitCode !== 0) return { ok: false, error: classifyGhFailure(proc).error };
      return { ok: true, url: proc.stdout.trim() };
    },
    async fetch() {
      const user = ghUsername(gh);
      if (!user.ok) return { ok: false, error: user.error };
      const tagged = findTaggedGist(user.user);
      if (!tagged.ok) return { ok: false, error: tagged.error };
      if (!tagged.id) return { ok: false, error: { reason: "failed", message: "no handoff gist found" } };
      const proc = gh(["gist", "view", tagged.id, "--filename", "handoff.json", "--raw"]);
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
