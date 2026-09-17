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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RawHandoff } from "./handoff";
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
    mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ sessionId: payload.sessionId, updatedAt: payload.updatedAt }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
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
