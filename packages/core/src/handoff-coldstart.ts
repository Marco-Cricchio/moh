/**
 * Cold-directory wizard core (#595): the pieces the TUI flow composes —
 * the truly-cold gate, the clone step, and the post-clone pull.
 *
 * The flow reuses the existing reception path end-to-end: after the
 * clone, the fetched handoff is parked with `importHandoffFile` and the
 * seeded session opens through the ordinary `discoverHandoff` offer
 * (newest-wins and staleness rules unchanged) — no new replay path.
 *
 * Everything is async and injectable: none of this ever runs a sync
 * child process (the Ink-effect freeze class of bug, 3b40b5e).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { importHandoffFile } from "./handoff-file";
import { readRawHandoffText, type HandoffPayload, type HandoffTransportError } from "./handoff-transport";
import { listSessionSummaries } from "./session-store";
import type { GistHandoffOffer } from "./handoff-gist";
import type { RawHandoff } from "./handoff";

/** One async `git` invocation, mirroring the gh runner's contract. */
export interface GitCall {
  args: string[];
  cwd?: string;
}

export type GitRunner = (call: GitCall) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** The real runner: async `git` child process. */
export const spawnGit: GitRunner = async (call) => {
  try {
    const proc = Bun.spawn(["git", ...call.args], {
      cwd: call.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } catch (e) {
    return { exitCode: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
};

/**
 * Truly cold (#595 trigger): no `.git` at or above `cwd` AND no local
 * sessions for the project. Pure filesystem reads — safe at startup,
 * never a process spawn. A `moh.json` in the directory does NOT count
 * against coldness (a cloned-repo-but-zero-sessions directory with one
 * is still offered the flow through the explicit Home action anyway).
 */
export function isColdDirectory(cwd: string, home?: string): boolean {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return false;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  try {
    return listSessionSummaries(cwd, home ?? homedir()).length === 0;
  } catch {
    return true;
  }
}

export interface CloneHandoffRepoOptions {
  repoUrl: string;
  /** Destination directory (parent). The repo clones into `<dest>/<name>`. */
  dest: string;
  /** Injectable for tests; production defaults to the async git runner. */
  git?: GitRunner;
  /** Directory-name override (tests); default: the URL's last path segment, `.git` stripped. */
  name?: string;
}

export type CloneHandoffRepoResult =
  | { ok: true; path: string }
  | { ok: false; reason: "failed"; message: string }
  | { ok: false; reason: "exists"; path: string };

/**
 * Clones `repoUrl` into `dest/<name>`. Refuses to touch an existing
 * directory (cancel/ownership contract: the clone is a plain git clone
 * the user owns, and nothing is half-done by moh).
 */
export async function cloneHandoffRepo(options: CloneHandoffRepoOptions): Promise<CloneHandoffRepoResult> {
  const raw = options.name ?? options.repoUrl.replace(/\/+$/, "").split("/").pop() ?? "repo";
  const name = raw.replace(/\.git$/, "");
  const path = join(options.dest, name);
  if (existsSync(path)) return { ok: false, reason: "exists", path };
  const git = options.git ?? spawnGit;
  const proc = await git({ args: ["clone", options.repoUrl, path] });
  if (proc.exitCode !== 0) {
    return { ok: false, reason: "failed", message: proc.stderr.trim() || `git clone exited ${proc.exitCode}` };
  }
  return { ok: true, path };
}

export interface PullHandoffOptions {
  /** The directory the repo was cloned into (or the user-declared path). */
  cwd: string;
  /** The offer (or full payload) accepted in the wizard. */
  offer: Pick<GistHandoffOffer, "url" | "updatedAt">;
  /** The full payload from the scan, when already fetched (skips a second gist view). */
  payload?: HandoffPayload;
  /** Fetches the payload from the offer's gist URL when `payload` is absent. */
  fetchByUrl?: (url: string) => Promise<{ ok: true; payload: HandoffPayload } | { ok: false; error: HandoffTransportError }>;
  /** The logged-in gh user (author check, as in the manual pull path). */
  expectedAuthor?: string;
  home?: string;
}

export type PullHandoffResult =
  | { ok: true; payload: RawHandoff }
  | { ok: false; message: string };

/**
 * The pull step: parks the fetched payload as the project's imported
 * handoff under the CLONE's project slug, so the existing reception
 * path (newest-wins, staleness, seeded session) picks it up on open.
 * Never throws.
 */
export async function pullHandoffTo(options: PullHandoffOptions): Promise<PullHandoffResult> {
  let payload: HandoffPayload | undefined = options.payload;
  if (!payload && options.fetchByUrl) {
    const fetched = await options.fetchByUrl(options.offer.url);
    if (fetched.ok) payload = fetched.payload;
    else return { ok: false, message: handoffErrorMessage(fetched.error) };
  }
  if (!payload) return { ok: false, message: "handoff could not be fetched" };
  const imported = await importHandoffFile({
    cwd: options.cwd,
    home: options.home,
    payload,
    ...(options.expectedAuthor ? { expectedAuthor: options.expectedAuthor } : {}),
  });
  if (!imported.ok) {
    const error = imported.error;
    const message =
      error.reason === "foreign-author"
        ? `handoff authored by ${error.author ?? "someone else"}`
        : error.reason === "missing" || error.reason === "invalid"
          ? "invalid handoff payload"
          : handoffErrorMessage(error);
    return { ok: false, message };
  }
  return { ok: true, payload: readRawHandoffText(payload) ?? (payload as RawHandoff) };
}

function handoffErrorMessage(error: HandoffTransportError): string {
  switch (error.reason) {
    case "gh-missing": return "gh is not installed";
    case "not-logged-in": return "gh is not logged in";
    case "timeout": return "gist fetch timed out";
    default: return `gist fetch failed${"message" in error && error.message ? ` (${error.message})` : ""}`;
  }
}
