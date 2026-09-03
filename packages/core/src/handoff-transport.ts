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
  /** The raw artifact file (#434): `<mohHome>/projects/<slug>/handoff.json`. */
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
  try {
    const parsed = JSON.parse(text) as RawHandoff;
    if (parsed.version !== 1 || parsed.kind !== "raw" || typeof parsed.sessionId !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
