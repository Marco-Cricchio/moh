/**
 * Session Handoff T3 (#436): the receiving side — discovery, newest-wins
 * comparison, stale marking, and the seeded-session opening context.
 *
 * Reception (#433 implementation decisions): the receiving machine never
 * replays the handoff as an event log. It creates a **new session**
 * seeded with the handoff rendered as a turn-scoped skill prompt
 * (PromptComposer pattern, ADR-0011 — the same seam `/ask-moh` uses),
 * so the handoff context lives exactly one turn as opening context.
 *
 * Newest-wins: at startup the fetched gist handoff is compared with the
 * newest local session; only a handoff that is genuinely newer is
 * offered (story 3), warning when it supersedes local work. A handoff
 * whose anchor SHA is not HEAD is marked **stale** and its seed prompt
 * says so, instructing reconciliation via git instead of silent trust
 * (story 5). Discovery failures are silent `{ status: "none" }` results:
 * an offline or gh-less machine just sees today's home screen (story 15).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HandoffGitAnchor, RawHandoff } from "./handoff";
import { gitAnchor, HandoffRunner } from "./handoff";
import { git } from "./git";
import { listSessionSummaries, SessionStore, type SessionSummary } from "./session-store";
import {
  importHandoffFile,
  readImportedHandoff,
  readRawHandoff,
  readRawHandoffText,
  type GistHandoffOffer,
  type HandoffPayload,
  type HandoffTransport,
  type HandoffTransportError,
} from "./handoff-transport";
import type { SkillPrompt } from "./types";

export interface DiscoverHandoffOptions {
  cwd: string;
  /** OS home (`~`); defaults to the real one. Derived paths use `<home>/.moh`. */
  home?: string;
  transport: HandoffTransport;
  /** Budget for the whole fetch. Default: 3000ms (startup must not hang). */
  timeoutMs?: number;
  /** Git anchor override (tests). Absent = live `gitAnchor(cwd)`. */
  git?: HandoffGitAnchor;
  /** Local session listing override (tests). */
  listLocal?: () => SessionSummary[];
  /** Local raw-artifact reader override (tests). Default: the project's
   * `<home>/.moh/projects/<slug>/handoff.json`. */
  readLocalArtifact?: () => RawHandoff | undefined;
  /** Parked manual import reader override (tests, T7 #440). Default:
   * the project's `<home>/.moh/projects/<slug>/imported-handoff.json`. */
  readImported?: () => RawHandoff | undefined;
}

/** The startup discovery outcome. Everything but `offer` means: nothing
 * to surface — the ordinary home flow stands. */
export type HandoffOffer =
  | { status: "none" }
  /** The newest local session is at least as new as the handoff. */
  | { status: "local-current" }
  /** The handoff is this machine's own publish (same session id). */
  | { status: "own-session" }
  | {
      status: "offer";
      payload: HandoffPayload;
      url: string;
      /** True when the anchor SHA is not HEAD (story 5). */
      stale: boolean;
    };

/** Runs a promise under a deadline (mirrors handoff-transport's). */
function deadline<T>(p: Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  return Promise.race([
    p,
    new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), timeoutMs).unref?.();
    }),
  ]);
}

/**
 * Startup discovery: fetches the newest published handoff and compares
 * it with the newest local session. Ordering key is the handoff's
 * `updatedAt` (last completed turn on the origin machine) against the
 * local session file's mtime. Own-session detection compares the
 * payload's internal sessionId against the **local raw artifact** (same
 * internal id, `session-xxxxxxxx`) — file basenames are a different id
 * space and never match. Never throws and never hangs: any failure
 * (offline, gh missing, timeout, unparsable gist) is `{ status: "none" }`.
 */
/**
 * Bounded startup discovery (story 15). The deadline must cover the
 * WHOLE fetch chain — 2–3 sequential `gh` child processes (user
 * lookup, gist list, gist view), each paying CLI startup + keyring
 * cost. Field evidence (#680 follow-up, PC B): 3s cut the chain after
 * the first call, so every machine with a slightly slow gh saw no
 * offer row, ever; the e2e simulation measured `gh api user` alone at
 * ~0.5s and full chains past 3s on a healthy network. 10s keeps the
 * discovery bounded (it runs once at Home mount, never blocking
 * render) while actually accommodating the real chain.
 */
export const DISCOVERY_DEADLINE_MS = 10_000;

export async function discoverHandoff(options: DiscoverHandoffOptions): Promise<HandoffOffer> {
  const raced = await deadline(
    options.transport.fetch().catch(() => null),
    options.timeoutMs ?? DISCOVERY_DEADLINE_MS,
  );
  if (raced === "timeout" || raced === null || !raced.ok) {
    // No reachable gist handoff — a parked manual import (T7 #440) can
    // still be newer than the local session; offer it when so.
    handoffDebug(raced === "timeout" ? "fetch-timeout" : "fetch-error", {
      outcome: raced === "timeout" ? "timeout" : raced === null ? "thrown" : raced.error,
    });
    return offerFromImport(options);
  }
  handoffDebug("fetch-ok", { sessionId: raced.payload.sessionId, updatedAt: raced.payload.updatedAt, url: raced.url });
  const imported = (options.readImported ?? (() => readImportedHandoff(options.cwd, options.home)))();
  const home = options.home ?? homedir();
  const local = (options.listLocal ?? (() => listSessionSummaries(options.cwd, home)))();
  const localArtifact =
    options.readLocalArtifact?.() ?? readRawHandoff(HandoffRunner.artifactFile(options.cwd, join(home, ".moh")));
  // Rediscovering your own publish (gist or re-imported export) is a no-op.
  if (localArtifact?.sessionId === raced.payload.sessionId) {
    handoffDebug("decision", { status: "own-session", artifactSessionId: localArtifact.sessionId });
    return { status: "own-session" };
  }
  // Newest handoff candidate wins (story 21: newest state wins regardless
  // of producing machine): fetched gist vs parked manual import.
  let candidate: { payload: HandoffPayload; url: string } = { payload: raced.payload, url: raced.url };
  if (imported && Date.parse(imported.updatedAt) > Date.parse(candidate.payload.updatedAt)) {
    if (localArtifact?.sessionId === imported.sessionId) {
      handoffDebug("decision", { status: "own-session", source: "imported", artifactSessionId: localArtifact.sessionId });
      return { status: "own-session" };
    }
    candidate = { payload: imported, url: "imported file" };
  }
  const newest = local[0];
  if (newest && Date.parse(candidate.payload.updatedAt) <= newest.mtimeMs) {
    handoffDebug("decision", {
      status: "local-current",
      candidateUpdatedAt: candidate.payload.updatedAt,
      newestLocalMtimeMs: newest.mtimeMs,
      newestLocalFile: newest.file,
    });
    return { status: "local-current" };
  }
  const offer = {
    status: "offer",
    payload: candidate.payload,
    url: candidate.url,
    stale: isHandoffStale(candidate.payload, options.cwd, options.git),
  } as const;
  handoffDebug("decision", { status: "offer", url: offer.url, stale: offer.stale });
  return offer;
}

/** T7 (#440) import fallback path: reached when no gist handoff was
 * reachable at all. A parked manual import that is genuinely newer than
 * the newest local session is offered; own-session imports are silently
 * dropped — importing your own export back is a no-op, exactly like
 * rediscovering your own gist publish. */
function offerFromImport(options: DiscoverHandoffOptions): HandoffOffer {
  const imported = (options.readImported ?? (() => readImportedHandoff(options.cwd, options.home)))();
  if (!imported) return { status: "none" };
  const home = options.home ?? homedir();
  const local = (options.listLocal ?? (() => listSessionSummaries(options.cwd, home)))();
  const localArtifact =
    options.readLocalArtifact?.() ?? readRawHandoff(HandoffRunner.artifactFile(options.cwd, join(home, ".moh")));
  if (localArtifact?.sessionId === imported.sessionId) return { status: "own-session" };
  const newest = local[0];
  if (newest && Date.parse(imported.updatedAt) <= newest.mtimeMs) return { status: "local-current" };
  return {
    status: "offer",
    payload: imported,
    url: "imported file",
    stale: isHandoffStale(imported, options.cwd, options.git),
  };
}

/**
 * Stale marking (story 5): a handoff is current only when its anchor
 * SHA equals HEAD. Anything else — a different SHA, a missing anchor,
 * an unresolvable HEAD — is stale: never silently trusted, always
 * reconciled (the seed prompt carries the instruction).
 */
export function isHandoffStale(payload: RawHandoff, cwd: string, git?: HandoffGitAnchor): boolean {
  if (!payload.git?.head) return true;
  const current = git ?? gitAnchor(cwd);
  return current.head !== payload.git.head;
}

/** Short human timestamp for chrome ("2026-09-02 16:04"). */
function shortStamp(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Date(parsed).toISOString().slice(0, 16).replace("T", " ");
}

function section(title: string, lines: string[]): string {
  if (lines.length === 0) return "";
  return `\n## ${title}\n${lines.map((l) => `- ${l}`).join("\n")}\n`;
}

/** The seed skill prompt (ADR-0011 turn-scoped): the handoff rendered
 * as the opening context of exactly one turn. English like every
 * composed prompt section. */
export function handoffSeedPrompt(offer: Extract<HandoffOffer, { status: "offer" }>): SkillPrompt {
  const p = offer.payload;
  const anchorLines = [`branch: ${p.git?.branch ?? "unknown"}`, `SHA: ${p.git?.head ?? "unknown"}`];
  if (offer.stale) {
    anchorLines.push(
      "STALE: this SHA is not the current HEAD — before trusting the file list below, reconcile with git (`git log <sha>..HEAD`, `git diff <sha> <paths>`); the origin machine's state may predate local changes.",
    );
  }
  const text =
    `# Session handoff received\n` +
    `You are resuming work transferred from another machine via a moh session handoff (published ${shortStamp(p.updatedAt)} UTC). Treat the state below as the prior working context; verify against the repository before acting on it.` +
    section(
      "Working state",
      [
        `last user message: ${p.lastUserMessage || "(none)"}`,
        `last assistant reply: ${p.lastAssistantMessage || "(none)"}`,
        `turns completed: ${p.turns} (tool calls ${p.counts.toolCalls}, errors ${p.counts.errors}, cancelled ${p.counts.cancelled})`,
      ],
    ) +
    section("Git anchor", anchorLines) +
    section(
      "Wayfinder",
      p.wayfinder
        ? [
            ...p.wayfinder.tickets.map((ticket) =>
              `${ticket.relations.join(" + ")}: ${ticket.url ? `[${ticket.title}](${ticket.url})` : `#${ticket.id} ${ticket.title}`}`,
            ),
            `frontier: ${p.wayfinder.frontier.ready} ready · ${p.wayfinder.frontier.inProgress} in progress · ${p.wayfinder.frontier.blocked} blocked`,
          ]
        : [],
    ) +
    section("Files touched (first-seen order)", p.files) +
    section("Test commands run", p.tests);
  return { name: "handoff-context", text };
}

/** The user-visible seed message sent with the prompt: one line, with
 * the stale warning when it applies (story 3/5). */
export function handoffSeedMessage(offer: Extract<HandoffOffer, { status: "offer" }>): string {
  const base = `Continuing from the session handoff published ${shortStamp(offer.payload.updatedAt)} UTC (branch ${offer.payload.git?.branch ?? "unknown"}).`;
  return offer.stale
    ? `${base}\n\nWarning: this handoff is stale (its git anchor is not the current HEAD) — reconcile via git diff before trusting it.`
    : base;
}

/*
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

/** One async `git` invocation, mirroring the gh runner's contract. */
export interface GitCall {
  args: string[];
  cwd?: string;
}

export type GitRunner = (call: GitCall) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** The real runner: async `git` child process. */
const spawnGit: GitRunner = async (call) => {
  try {
    return await git(call.cwd, call.args, { dir: "cwd", stderr: "pipe", stdin: "ignore" });
  } catch (e) {
    return { exitCode: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
};

/**
 * Truly cold (#595 trigger): no `.git` at or above `cwd` AND no local
 * sessions for the project. Deliberately a **filesystem-only** probe: the
 * git-origin part of the identity is decided by `existsSync(<cwd>/.git)`
 * (or an ancestor), never by resolving the slug — a slug resolution spawns
 * `git remote get-url` synchronously, and this gate runs in a mount-time
 * passive effect where a spawn runs the event loop inside the call and
 * re-enters React's reconciler ("Should not already be working.", the #595
 * flake; why the fix is the boot rather than the gate: #939, ADR-0024). A
 * project with `.git` is never cold regardless of sessions, so the origin
 * detail cannot change the answer here. A `moh.json` in the directory does
 * NOT count against coldness (a cloned-repo-but-zero-sessions directory
 * with one is still offered the flow through the explicit Home action
 * anyway).
 */
export function isColdDirectory(cwd: string, home?: string): boolean {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return false;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  // No `.git` anywhere above ⇒ the slug cannot be remote-derived; list the
  // sessions under the identity the *directory contents* imply. The
  // declared `.moh/project.json` (uuid identity) decides, falling back to
  // the legacy path slug — both pure filesystem reads, no spawn.
  try {
    return SessionStore.listSpawnFree(cwd, home ?? homedir()).length === 0;
  } catch {
    return true;
  }
}

interface CloneHandoffRepoOptions {
  repoUrl: string;
  /** Destination directory (parent). The repo clones into `<dest>/<name>`. */
  dest: string;
  /** Injectable for tests; production defaults to the async git runner. */
  git?: GitRunner;
  /** Directory-name override (tests); default: the URL's last path segment, `.git` stripped. */
  name?: string;
}

type CloneHandoffRepoResult =
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

interface PullHandoffOptions {
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

type PullHandoffResult =
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

/*
 * #680 follow-up: discovery debug logging. Home handoff discovery is
 * deliberately fail-silent (story 15), which makes "why is there no
 * offer row?" undiagnosable in the field — #680's cold scan hid behind
 * the same silence for releases. Behind MOH_DEBUG=handoff the whole
 * decision chain writes one line per gate to stderr; production
 * behavior (no env var) is byte-for-byte unchanged.
 */

type HandoffDebugStage =
  | "transport-off"
  | "transport-active"
  | "fetch-start"
  | "fetch-error"
  | "fetch-timeout"
  | "fetch-ok"
  | "decision";

let enabledCache: boolean | undefined;

/** Enabled only when MOH_DEBUG contains "handoff" (comma list friendly).
 * Memoized per process (read once); tests reset via `resetDebugCache`. */
export function handoffDebugEnabled(): boolean {
  if (enabledCache === undefined) {
    const spec = process.env.MOH_DEBUG ?? "";
    enabledCache = spec.split(",").map((s) => s.trim()).includes("handoff");
  }
  return enabledCache;
}

/** Test seam: forget the memoized MOH_DEBUG read. */
export function resetDebugCache(): void {
  enabledCache = undefined;
}

/** One stderr line: `moh[handoff] <stage> <detail-json>`. Never throws.
 * Writer injectable for tests. */
let debugWrite: (line: string) => void = (line) => {
  process.stderr.write(line);
};
export function setDebugWriter(write: (line: string) => void): void {
  debugWrite = write;
}

export function handoffDebug(stage: HandoffDebugStage, detail: Record<string, unknown>): void {
  try {
    if (!handoffDebugEnabled()) return;
    debugWrite(`moh[handoff] ${stage} ${JSON.stringify(detail)}\n`);
  } catch {
    // Logging must never break discovery.
  }
}
