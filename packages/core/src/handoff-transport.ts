/**
 * Session Handoff T2 (#435): the `HandoffTransport` seam and the
 * exit-time publish helper.
 *
 * The seam (#433 implementation decision): a core interface with
 * `publish`/`fetch` — injected by clients like the sessionFromConfig
 * consent seams. The core never knows `gh`; tests use a fake transport.
 * The gist implementation (via `gh`, in this module but standalone —
 * never reachable from the agent loop) is `createGistHandoffTransport`.
 *
 * Publishing happens at session exit through the exit-work budget
 * (ADR-0015): `publishHandoffAtExit` reads the local raw artifact
 * (#434), bounded by `timeoutMs`, and never rejects — on failure the
 * caller surfaces a warning while the artifact stays local (#433 story
 * 15: silent fail, nothing lost). Synthesis (a `kind: "synthesized"`
 * payload produced by an LLM at exit) arrives with later tickets; today
 * the raw artifact is published as `kind: "raw"` — a receiver may
 * synthesize locally at import.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HandoffRunner, type RawHandoff } from "./handoff";
import { writeFileAtomic, tempPidInfix } from "./fs-atomic";
import { canonicalRemoteSlug } from "./project-identity";
import { projectSlug } from "./session-store";

/** The published handoff payload. T2 publishes the raw artifact as-is;
 * the chain fields (supersedes + anchor + timestamp, already present in
 * `RawHandoff`) are the append-only ordering keys T3/T4 consume. */
export type HandoffPayload = RawHandoff;

/** Why a publish/fetch failed — clients turn this into a warning. */
export type HandoffTransportError =
  | { reason: "no-artifact" }
  | { reason: "gh-missing" }
  | { reason: "not-logged-in" }
  | { reason: "timeout" }
  | { reason: "newer-remote"; remoteUpdatedAt: string; localUpdatedAt: string }
  | { reason: "failed"; message: string };

/** The one transport seam (#433): publish/fetch, injected by clients.
 * Implementations talk to some channel (secret gist today); the core
 * only sees this interface and never `gh`. */
export interface HandoffTransport {
  /** Publishes the payload under the deterministic handoff identity.
   * Resolves with the channel's handle (gist id/url) or a typed error;
   * never throws. */
  publish(payload: HandoffPayload): Promise<{ ok: true; url: string } | { ok: false; error: HandoffTransportError }>;
  /** Fetches the newest published handoff for this identity. T3. */
  fetch(): Promise<{ ok: true; payload: HandoffPayload; url: string } | { ok: false; error: HandoffTransportError }>;
  /** Fetches a specific handoff by channel handle (story 17: `pull <url>`
   * fallback when the deterministic-tag discovery misses). Optional —
   * only channels with addressable items implement it. */
  fetchByUrl?(url: string): Promise<{ ok: true; payload: HandoffPayload; url: string } | { ok: false; error: HandoffTransportError }>;
}

/** Runs a promise under a deadline. */
function deadline<T>(p: Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  return Promise.race([
    p,
    new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), timeoutMs).unref?.();
    }),
  ]);
}

export interface PublishHandoffOptions {
  artifactFile: string;
  transport: HandoffTransport;
  /** Best-effort read-only payload enrichment (T6). A failure leaves the
   * raw payload publishable; automatic handoff never depends on it. */
  enrich?: (payload: RawHandoff) => Promise<RawHandoff>;
  /** Exit budget share for the whole publish. Default: 2000ms. */
  timeoutMs?: number;
  /** Artifact read override (tests). */
  read?: () => RawHandoff | undefined;
}

export type PublishHandoffResult =
  | { ok: true; url: string }
  | { ok: false; error: HandoffTransportError };

/** Exit-time publish (#433 story 7/15): reads the local raw artifact and
 * publishes it through the transport, all within `timeoutMs`. Never
 * rejects and never holds the caller beyond the budget — on any failure
 * (missing artifact, gh absent/offline, timeout) the artifact stays
 * local and the caller surfaces a warning. */
export async function publishHandoffAtExit(options: PublishHandoffOptions): Promise<PublishHandoffResult> {
  let payload: RawHandoff | undefined;
  try {
    payload = options.read ? options.read() : readRawHandoff(options.artifactFile);
  } catch {
    payload = undefined;
  }
  if (!payload) return { ok: false, error: { reason: "no-artifact" } };
  // Publish retry: this exact artifact already reached the remote on an
  // earlier attempt (exit or startup retry) — never re-publish.
  if (handoffAlreadyPublished(options.artifactFile, payload)) return { ok: true, url: "already-published" };
  // Enrichment is optional but must share the exit budget with transport:
  // a slow tracker can never hold the bounded interactive exit path.
  const budget = options.timeoutMs ?? 2_000;
  const started = Date.now();
  if (options.enrich) {
    try {
      // Reserve most of the budget for the actual transport so a slow
      // tracker degrades to the raw payload instead of suppressing publish.
      const enriched = await deadline(options.enrich(payload), Math.min(500, Math.floor(budget / 4)));
      if (enriched !== "timeout") payload = enriched;
    } catch { /* raw fallback */ }
  }
  const remaining = budget - (Date.now() - started);
  if (remaining <= 0) return { ok: false, error: { reason: "timeout" } };
  const raced = await deadline(
    options.transport.publish(payload).catch((e: unknown): { ok: false; error: HandoffTransportError } => ({
      ok: false,
      error: { reason: "failed", message: e instanceof Error ? e.message : String(e) },
    })),
    remaining,
  );
  if (raced === "timeout") return { ok: false, error: { reason: "timeout" } };
  if (raced.ok) writePublishedMarker(options.artifactFile, payload);
  return raced;
}

/** Reads and validates the raw artifact. `undefined` when absent or not
 * a raw handoff (never throws — the file is best-effort local state). */
export function readRawHandoff(file: string): RawHandoff | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  return readRawHandoffText(text);
}

/** The local record of "this exact artifact already reached the remote"
 * (publish retry): `handoff-published.json` beside the raw artifact,
 * holding the `sessionId` + `updatedAt` of the last successful publish.
 * Written after a successful publish, consulted before one — an artifact
 * whose keys match is already safe on the remote, so exit-time and
 * startup-retry publish are no-ops for it. */
export function handoffPublishedMarkerFile(artifactFile: string): string {
  return join(artifactFile, "..", "handoff-published.json");
}

function readPublishedMarker(artifactFile: string): { sessionId: string; updatedAt: string } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(handoffPublishedMarkerFile(artifactFile), "utf8")) as
      | { sessionId?: unknown; updatedAt?: unknown }
      | null;
    if (typeof parsed?.sessionId === "string" && typeof parsed?.updatedAt === "string")
      return { sessionId: parsed.sessionId, updatedAt: parsed.updatedAt };
  } catch {
    // absent or corrupt → treated as never published
  }
  return undefined;
}

function writePublishedMarker(artifactFile: string, payload: RawHandoff): void {
  try {
    const file = handoffPublishedMarkerFile(artifactFile);
    writeFileAtomic(file, `${JSON.stringify({ sessionId: payload.sessionId, updatedAt: payload.updatedAt }, null, 2)}\n`, {
      mode: 0o600,
      mkdir: { mode: 0o700 },
      temp: tempPidInfix,
    });
  } catch {
    // a marker write failure never fails a publish that already succeeded
  }
}

/** True when the artifact's identity keys match the last successful
 * publish record — nothing new to send. */
export function handoffAlreadyPublished(artifactFile: string, payload: RawHandoff): boolean {
  const marker = readPublishedMarker(artifactFile);
  return marker?.sessionId === payload.sessionId && marker?.updatedAt === payload.updatedAt;
}


/** Validates an already-parsed/raw JSON text payload. */
export function readRawHandoffText(text: string | RawHandoff): RawHandoff | undefined {
  try {
    const parsed = typeof text === "string" ? (JSON.parse(text) as RawHandoff) : text;
    // v2 carries `author` (#451); v1 payloads stay readable (back-compat:
    // gist-sourced v1 handoffs are per-author via the deterministic tag).
    if ((parsed.version !== 1 && parsed.version !== 2) || parsed.kind !== "raw" || typeof parsed.sessionId !== "string")
      return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/*
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

/** One gh invocation: argv after the binary, optional stdin payload. */
export interface GhCall {
  args: string[];
  /** Written to the child's stdin (gist create reads content from `-`). */
  stdin?: string;
}

interface GhResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Injected for tests: one `gh` invocation. Async so the real runner can
 * await the child process — a sync spawn inside an Ink effect froze the
 * reconciler (the 3b40b5e class of bug: never block the event loop from
 * React effects). */
export type GhRunner = (call: GhCall) => Promise<GhResult>;

/** The real runner: async `gh` child process. Awaited by the transport's
 * async methods, so the TUI's event loop stays free while gh runs. */
export const spawnGh: GhRunner = async (call) => {
  try {
    const proc = Bun.spawn(["gh", ...call.args], {
      stdout: "pipe",
      stderr: "pipe",
      // stdin is bytes handed over at spawn time (gh gist create reads
      // content from `-`); the pipe closes on exit.
      stdin: call.stdin === undefined ? "ignore" : new Blob([call.stdin]),
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } catch (e) {
    // ENOENT (no gh in PATH) surfaces as a thrown Bun error, not an exit
    // code — normalize so classification sees gh-missing, not a crash.
    const message = e instanceof Error ? e.message : String(e);
    return { exitCode: 127, stdout: "", stderr: message };
  }
};

interface GistHandoffTransportOptions {
  cwd: string;
  /** Home dir for slug derivation; the artifact layout lives under `<home>/.moh`. */
  home?: string;
  gh?: GhRunner;
  /** Canonical origin remote override (tests). Default: the https URL
   * derived from `canonicalRemoteSlug(cwd)`; undefined = no origin =
   * the payload carries no `repoUrl` at all. */
  repoUrl?: string;
  /** Publish guard seam (#593): asked before replacing a tagged gist
   * whose payload is strictly newer than the one being published.
   * Resolves true = overwrite anyway; false/absent seam = decline and
   * publish nothing. Production wires the client's consent UI; tests
   * script the answer. */
  confirmOverwrite?: (info: { remoteUpdatedAt: string; localUpdatedAt: string }) => Promise<boolean>;
}

/** The deterministic gist description: `moh:handoff:<slug>:<gh-user>`. */
export function handoffGistTag(cwd: string, ghUser: string, home?: string): string {
  const slug = projectSlug(cwd, home ?? homedir());
  return `moh:handoff:${slug}:${ghUser}`;
}

/** #593: canonical public https clone URL from the origin's canonical
 * slug, e.g. `github.com/owner/repo` → `https://github.com/owner/repo.git`.
 * Null when the project has no parsable origin. */
function canonicalRemoteUrl(cwd: string): string | undefined {
  const slug = canonicalRemoteSlug(cwd);
  return slug ? `https://${slug}.git` : undefined;
}

/** Resolves the logged-in gh username, or why it cannot. */export async function ghUsername(gh: GhRunner): Promise<{ ok: true; user: string } | { ok: false; error: HandoffTransportError }> {
  const proc = await gh({ args: ["api", "user", "--jq", ".login"] });
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
interface GistApiRow {
  id?: string;
  description?: string | null;
  updated_at?: string;
  public?: boolean;
}

/** A handoff available to a cold-start client. This intentionally exposes
 * only the offer-list headline — the full artifact is fetched again only
 * when the user accepts it. */
export interface GistHandoffOffer {
  projectSlug: string;
  updatedAt: string;
  git: HandoffPayload["git"];
  lastUserMessage: string;
  repoUrl?: string;
  url: string;
}

export interface DiscoverGistHandoffsOptions {
  /** Injectable for tests; production defaults to the asynchronous gh runner. */
  gh?: GhRunner;
}

interface GistListCandidate {
  id: string;
  projectSlug: string;
  gistUpdatedAt: string;
}

/** Lists handoffs published by the authenticated user across projects.
 * Listing is metadata-only; candidate content is fetched only after its
 * tag has matched, and every remote failure deliberately degrades to no
 * offers so cold start never becomes dependent on GitHub availability. */
export async function discoverGistHandoffs(options: DiscoverGistHandoffsOptions = {}): Promise<GistHandoffOffer[]> {
  const gh = options.gh ?? spawnGh;
  const user = await ghUsername(gh);
  if (!user.ok) return [];

  try {
    // The REST endpoint is paginated by gh until exhausted, unlike `gh gist
    // list --limit`, so discovery cannot silently miss an older handoff.
    // `GET /gists` is the authenticated user's gist listing (#680): the
    // previous `user/gists` path is a nonexistent REST endpoint (always
    // 404) and the scan degraded to "no published handoffs" on every
    // machine, invisibly.
    const listed = await gh({ args: ["api", "--paginate", "--slurp", "gists?per_page=100"] });
    if (listed.exitCode !== 0) return [];
    const rows = JSON.parse(listed.stdout) as GistApiRow[][];
    const tag = new RegExp(`^moh:handoff:([^:]+):${escapeRegExp(user.user)}(?:\s|$)`);
    const newestByTag = new Map<string, GistListCandidate>();
    for (const row of rows.flat()) {
      const match = row.description?.match(tag);
      if (!row.id || !match?.[1] || row.public) continue;
      const candidate = { id: row.id, projectSlug: match[1], gistUpdatedAt: row.updated_at ?? "" };
      const key = `moh:handoff:${candidate.projectSlug}:${user.user}`;
      const prior = newestByTag.get(key);
      if (!prior || newerGist(candidate.gistUpdatedAt, prior.gistUpdatedAt)) newestByTag.set(key, candidate);
    }
    const offers = await Promise.all([...newestByTag.values()].map(async (candidate) => {
      const payload = await viewGistPayload(gh, candidate.id);
      if (!payload || typeof payload.updatedAt !== "string" || !payload.git || typeof payload.lastUserMessage !== "string") return undefined;
      return {
        projectSlug: candidate.projectSlug, updatedAt: payload.updatedAt, git: payload.git,
        lastUserMessage: payload.lastUserMessage,
        ...(typeof payload.repoUrl === "string" ? { repoUrl: payload.repoUrl } : {}),
        url: `https://gist.github.com/${candidate.id}`,
      };
    }));
    return offers.filter((offer): offer is GistHandoffOffer => offer !== undefined)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  } catch {
    return [];
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function newerGist(left: string, right: string): boolean {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) ? leftMs > rightMs : left > right;
}

async function viewGistPayload(gh: GhRunner, id: string): Promise<HandoffPayload | undefined> {
  const proc = await gh({ args: ["gist", "view", id, "--filename", "handoff.json", "--raw"] });
  if (proc.exitCode !== 0) return undefined;
  try { return JSON.parse(proc.stdout) as HandoffPayload; } catch { return undefined; }
}

/**
 * Builds the secret-gist transport. The gh user and tag are resolved
 * lazily per operation (login state may change between publish and
 * fetch). `publish` replaces any existing tagged gist so the tag always
 * resolves to the newest handoff; `fetch` returns it for T3 discovery.
 */
export function createGistHandoffTransport(options: GistHandoffTransportOptions): HandoffTransport {
  const gh = options.gh ?? spawnGh;
  const confirmOverwrite = options.confirmOverwrite;
  // #593: repoUrl is resolved lazily at publish time, never at construction:
  // the canonical-slug probe shells out synchronously, and construction runs
  // inside Ink effects (discoverHandoffForHome) where a sync child process
  // freezes the reconciler (the 3b40b5e class of bug). publish() runs in the
  // bounded exit path instead. `host/owner/repo` → `https://host/owner/repo.git`.
  const resolveRepoUrl = () => (options.repoUrl !== undefined ? options.repoUrl : canonicalRemoteUrl(options.cwd));
  const findTaggedGist = async (user: string): Promise<{ ok: true; id: string | undefined } | { ok: false; error: HandoffTransportError }> => {
    const tag = handoffGistTag(options.cwd, user, options.home);
    const list = await gh({ args: ["gist", "list", "--limit", GIST_LIST_LIMIT] });
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
  const viewGist = async (id: string) => {
    const proc = await gh({ args: ["gist", "view", id, "--filename", "handoff.json", "--raw"] });
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
      const user = await ghUsername(gh);
      if (!user.ok) return { ok: false, error: user.error };
      // Stamp the author (#451) at the seam that knows it: the payload
      // leaving the machine always records the publishing gh user.
      // repoUrl (#593) rides the same seam: the canonical public https
      // clone URL of origin, absent when the project has no origin.
      const repoUrl = resolveRepoUrl();
      const authored: HandoffPayload = {
        ...payload,
        author: user.user,
        version: 2,
        ...(repoUrl ? { repoUrl } : {}),
      };
      const tagged = await findTaggedGist(user.user);
      if (!tagged.ok) return { ok: false, error: tagged.error };
      // Publish guard (#593): when the tagged gist holds a strictly
      // newer handoff (another machine published after this session's
      // last turn), ask before destroying it. Declining (or no consent
      // seam wired) publishes nothing; local artifacts are never touched.
      if (tagged.id) {
        const remote = await viewGist(tagged.id);
        if (remote.ok) {
          const remoteUpdatedAt = typeof remote.payload.updatedAt === "string" ? remote.payload.updatedAt : "";
          const localUpdatedAt = authored.updatedAt;
          // Strictly newer only (equal = normal republish). Compared as
          // instants when both parse, so non-canonical ISO spellings
          // (+02:00 offsets, missing millis) cannot misorder; a remote
          // stamp that does not parse at all is never treated as newer.
          const remoteMs = Date.parse(remoteUpdatedAt);
          const localMs = Date.parse(localUpdatedAt);
          const newer = Number.isFinite(remoteMs) && Number.isFinite(localMs) ? remoteMs > localMs : remoteUpdatedAt > localUpdatedAt;
          if (newer) {
            const confirmed = confirmOverwrite ? await confirmOverwrite({ remoteUpdatedAt, localUpdatedAt }) : false;
            if (!confirmed) {
              return { ok: false, error: { reason: "newer-remote", remoteUpdatedAt, localUpdatedAt } };
            }
          }
        }
        // A view failure here (race: gist deleted between list and view)
        // falls through to the plain replace — nothing newer to protect.
      }
      // Non-destructive replace (#451): create first, delete the old
      // tagged gist only after the create succeeded. A failed delete
      // leaves a duplicate tag the receiver resolves by newest-updated;
      // a failed create leaves the remote copy intact.
      // gh gist create reads content from stdin (`-`) with `-f` naming
      // the gist file; gists are secret by default (there is no --secret
      // flag — only --public, which we never pass).
      const proc = await gh({
        args: ["gist", "create", "-d", handoffGistTag(options.cwd, user.user, options.home), "-f", "handoff.json", "-"],
        stdin: `${JSON.stringify(authored, null, 2)}\n`,
      });
      if (proc.exitCode !== 0) return { ok: false, error: classifyGhFailure(proc).error };
      if (tagged.id) await gh({ args: ["gist", "delete", tagged.id, "--yes"] });
      return { ok: true, url: proc.stdout.trim() };
    },
    async fetch() {
      const user = await ghUsername(gh);
      if (!user.ok) return { ok: false, error: user.error };
      const tagged = await findTaggedGist(user.user);
      if (!tagged.ok) return { ok: false, error: tagged.error };
      if (!tagged.id) return { ok: false, error: { reason: "failed", message: "no handoff gist found" } };
      return viewGist(tagged.id);
    },
    async fetchByUrl(url) {
      // Accept the bare gist id as well as the full URL.
      const id = url.trim().replace(/^https?:\/\/gist\.github\.com\//, "");
      if (!/^[\w-]+$/.test(id)) return { ok: false, error: { reason: "failed", message: `not a gist url: ${url}` } };
      return await viewGist(id);
    },
  };
}
  

/*
 * Session Handoff T7 (#440): the manual file fallback.
 *
 * `moh handoff export <file>` serializes the local raw artifact (with
 * the same read-only Wayfinder enrichment as a gist publish) to a file
 * the developer carries on removable media; `moh handoff import <file>`
 * validates a received export and parks it as the project's imported
 * handoff. Discovery (#436) merges the parked import with the fetched
 * gist: the genuinely newer of the two wins, so a machine with no gh at
 * all still receives a handoff and an A→B→A chain never regresses.
 *
 * The parked import lives under the project's local state directory
 * (`imported-handoff.json` beside the raw artifact): user data, never
 * inside the project's `.moh/`.
 */

/** Where the imported handoff is parked per project. */
export function importedHandoffFile(cwd: string, home = homedir()): string {
  return join(home, ".moh", "projects", projectSlug(cwd, home), "imported-handoff.json");
}

interface ExportHandoffOptions {
  cwd: string;
  home?: string;
  /** Destination file (removable media, network drop, anything). */
  out: string;
  /** Best-effort enrichment, same contract as a gist publish. */
  enrich?: (payload: RawHandoff) => Promise<RawHandoff>;
  /** Artifact read override (tests). */
  read?: () => RawHandoff | undefined;
}

type ExportHandoffResult =
  | { ok: true; path: string }
  | { ok: false; error: HandoffTransportError };

/** Serializes the local raw artifact to `out`. The payload is exactly
 * what a gist publish would carry (no tool output ever; the session
 * JSONL never leaves the machine). Failures are typed, never thrown. */
export async function exportHandoffFile(options: ExportHandoffOptions): Promise<ExportHandoffResult> {
  let payload: RawHandoff | undefined;
  try {
    payload = options.read
      ? options.read()
      : readRawHandoff(HandoffRunner.artifactFile(options.cwd, join(options.home ?? homedir(), ".moh")));
  } catch {
    payload = undefined;
  }
  if (!payload) return { ok: false, error: { reason: "no-artifact" } };
  if (options.enrich) {
    try {
      payload = await options.enrich(payload);
    } catch {
      // raw fallback — enrichment is best-effort, never a blocker
    }
  }
  try {
    writeFileAtomic(options.out, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, temp: tempPidInfix });
    return { ok: true, path: options.out };
  } catch (e) {
    return { ok: false, error: { reason: "failed", message: e instanceof Error ? e.message : String(e) } };
  }
}

interface ImportHandoffOptions {
  cwd: string;
  home?: string;
  /** The received export file. */
  file?: string;
  /** An already-fetched payload (e.g. `moh handoff pull <url>`), skipping
   * the file read. Takes precedence over `file`. */
  payload?: RawHandoff;
  /** The logged-in gh user. A payload authored by someone else is
   * declined (#451: handoffs are per-persona, #433 Q6). */
  expectedAuthor?: string;
  /** Read override for the source file (tests). */
  read?: (file: string) => RawHandoff | undefined;
}

type ImportHandoffResult =
  | { ok: true; path: string }
  | { ok: false; error: { reason: "missing" } | { reason: "invalid" } | { reason: "foreign-author"; author?: string } | HandoffTransportError };

/** Validates the received export and parks it as the project's imported
 * handoff (atomic write, 0600). A later import of a newer export simply
 * overwrites it — newest wins by `updatedAt` at discovery time. */
export async function importHandoffFile(options: ImportHandoffOptions): Promise<ImportHandoffResult> {
  let payload: RawHandoff | undefined;
  if (options.payload) {
    payload = readRawHandoffText(options.payload);
  } else {
    const read = options.read ?? readRawHandoff;
    try {
      payload = options.file === undefined ? undefined : read(options.file);
    } catch {
      payload = undefined;
    }
  }
  if (!payload) {
    let exists = false;
    try {
      readFileSync(options.file ?? "");
      exists = true;
    } catch {
      // genuinely absent
    }
    return { ok: false, error: exists ? { reason: "invalid" } : { reason: "missing" } };
  }
  // Author isolation (#451, fail-closed per #700): a file-carried handoff
  // from another gh user is declined, and so is an authorless payload — it
  // cannot be proven to be per-persona, so it is never silently imported.
  // Gist-sourced handoffs don't need this check — the deterministic tag
  // `moh:handoff:<slug>:<gh-user>` already enforces it.
  if (options.expectedAuthor && payload.author !== options.expectedAuthor) {
    return { ok: false, error: { reason: "foreign-author", ...(payload.author ? { author: payload.author } : {}) } };
  }
  const dest = importedHandoffFile(options.cwd, options.home);
  try {
    writeFileAtomic(dest, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, mkdir: { mode: 0o700 }, temp: tempPidInfix });
    return { ok: true, path: dest };
  } catch (e) {
    return { ok: false, error: { reason: "failed", message: e instanceof Error ? e.message : String(e) } };
  }
}

/** Reads the parked import. `undefined` when absent or invalid. */
export function readImportedHandoff(cwd: string, home = homedir()): RawHandoff | undefined {
  return readRawHandoff(importedHandoffFile(cwd, home));
}
