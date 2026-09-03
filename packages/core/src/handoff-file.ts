/**
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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { projectSlug } from "./session-store";
import { HandoffRunner, type RawHandoff } from "./handoff";
import { readRawHandoff, type HandoffTransportError } from "./handoff-transport";

/** Where the imported handoff is parked per project. */
export function importedHandoffFile(cwd: string, home = homedir()): string {
  return join(home, ".moh", "projects", projectSlug(cwd, join(home, "..")), "imported-handoff.json");
}

export interface ExportHandoffOptions {
  cwd: string;
  home?: string;
  /** Destination file (removable media, network drop, anything). */
  out: string;
  /** Best-effort enrichment, same contract as a gist publish. */
  enrich?: (payload: RawHandoff) => Promise<RawHandoff>;
  /** Artifact read override (tests). */
  read?: () => RawHandoff | undefined;
}

export type ExportHandoffResult =
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
    const tmp = `${options.out}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, options.out);
    return { ok: true, path: options.out };
  } catch (e) {
    return { ok: false, error: { reason: "failed", message: e instanceof Error ? e.message : String(e) } };
  }
}

export interface ImportHandoffOptions {
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

export type ImportHandoffResult =
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
  // Author isolation (#451): a file-carried handoff from another gh user
  // is declined. Gist-sourced handoffs don't need this check — the
  // deterministic tag `moh:handoff:<slug>:<gh-user>` already enforces it.
  if (options.expectedAuthor && payload.author && payload.author !== options.expectedAuthor) {
    return { ok: false, error: { reason: "foreign-author", author: payload.author } };
  }
  const dest = importedHandoffFile(options.cwd, options.home);
  try {
    mkdirSync(join(dest, ".."), { recursive: true, mode: 0o700 });
    const tmp = `${dest}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, dest);
    return { ok: true, path: dest };
  } catch (e) {
    return { ok: false, error: { reason: "failed", message: e instanceof Error ? e.message : String(e) } };
  }
}

/** Reads the parked import. `undefined` when absent or invalid. */
export function readImportedHandoff(cwd: string, home = homedir()): RawHandoff | undefined {
  return readRawHandoff(importedHandoffFile(cwd, home));
}
