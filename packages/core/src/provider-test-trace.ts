/**
 * #1092: the durable trail for failed provider connection tests.
 *
 * Onboarding runs before a session exists by design, so a failed probe
 * used to leave nothing on disk — once the popup was gone, the failure
 * was undiagnosable. The store is one JSON object per line in the user's
 * moh directory (`~/.moh/provider-test-failures.log`), the ADR-0049
 * context-refusals precedent: **bounded** (oldest evicted beyond the
 * cap), **fail-silent** (an unwritable home never blocks the wizard) and
 * **secret-free** — no api key, no authorization header, no credential
 * material ever enters a line.
 *
 *     {"at":"...","endpoint":"openai","model":"gpt-6-astra",
 *      "status":400,"param":"max_tokens","message":"..."}
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EndpointProfile } from "./config";
import type { ConnectionTestResult, ProviderTestFailure } from "./provider-onboarding";

/** File name inside the user's moh home. */
export const PROVIDER_TEST_FAILURES_FILE = "provider-test-failures.log";
/** Failed attempts kept; beyond this the oldest (`at`) goes. */
export const PROVIDER_TEST_MAX_ENTRIES = 50;

export interface ProviderTestFailureEntry {
  /** ISO date of the attempt. */
  at: string;
  /** Endpoint name from the profile under test. */
  endpoint: string;
  /** Endpoint type (`openai`, `openai-compat`, ...). */
  type: string;
  /** The model the probe targeted. */
  model: string;
  /** HTTP status, when the failure reached the provider. */
  status?: number;
  /** The provider's complaint, cleaned and bounded. */
  message: string;
  /** The field the provider complained about (`error.param`). */
  param?: string;
  /** Error type/code when the payload named one. */
  type_code?: string;
  /** Request id when the provider supplied one. */
  requestId?: string;
}

/** Absolute path of the trace file. */
export function providerTestFailuresFile(home: string): string {
  return join(home, PROVIDER_TEST_FAILURES_FILE);
}

/**
 * Records one failed connection test. Every failed attempt appends one
 * line (no dedup — the trail is per attempt, like the wizard's retries).
 * Never throws.
 */
export function noteProviderTestFailure(input: {
  home: string;
  profile: EndpointProfile;
  result: ConnectionTestResult;
  /** Injectable clock (tests). */
  now?: Date;
}): void {
  if (input.result.ok) return;
  const detail: ProviderTestFailure | undefined = input.result.detail;
  const entry: ProviderTestFailureEntry = {
    at: (input.now ?? new Date()).toISOString(),
    endpoint: input.profile.name,
    type: input.profile.type,
    model: input.profile.defaultModel ?? "",
    ...(detail?.status !== undefined ? { status: detail.status } : {}),
    message: input.result.error,
    ...(detail?.param ? { param: detail.param } : {}),
    ...(detail?.type ? { type_code: detail.type } : {}),
    ...(detail?.requestId ? { requestId: detail.requestId } : {}),
  };
  try {
    const file = providerTestFailuresFile(input.home);
    const entries = [...readEntries(file), entry].slice(-PROVIDER_TEST_MAX_ENTRIES);
    writeEntries(file, entries);
  } catch {
    // Diagnostics never block onboarding.
  }
}

function readEntries(file: string): ProviderTestFailureEntry[] {
  if (!existsSync(file)) return [];
  try {
    const entries: ProviderTestFailureEntry[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as Partial<ProviderTestFailureEntry>;
        if (typeof parsed?.at === "string" && typeof parsed?.message === "string" && typeof parsed?.endpoint === "string") {
          entries.push({ ...parsed, at: parsed.at, endpoint: parsed.endpoint, message: parsed.message } as ProviderTestFailureEntry);
        }
      } catch {
        // A torn or hand-edited line is skipped, never fatal.
      }
    }
    return entries.slice(-PROVIDER_TEST_MAX_ENTRIES);
  } catch {
    return [];
  }
}

function writeEntries(file: string, entries: readonly ProviderTestFailureEntry[]): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, entries.length ? `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "", { mode: 0o600 });
  renameSync(tmp, file);
}
