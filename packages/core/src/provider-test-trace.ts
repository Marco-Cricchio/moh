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
import { join } from "node:path";
import type { EndpointProfile } from "./config";
import type { ConnectionTestResult, ProviderTestFailure } from "./provider-onboarding";
import { boundedLog } from "./bounded-log";

/** File name inside the user's moh home. */
const PROVIDER_TEST_FAILURES_FILE = "provider-test-failures.log";
/** Failed attempts kept; beyond this the oldest (`at`) goes. */
export const PROVIDER_TEST_MAX_ENTRIES = 50;

interface ProviderTestFailureEntry {
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
function providerTestFailuresFile(home: string): string {
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
    boundedLog<ProviderTestFailureEntry>(file, {
      max: PROVIDER_TEST_MAX_ENTRIES,
      validate: validateEntry,
      update: (entries) => [...entries, entry],
    });
  } catch {
    // Diagnostics never block onboarding.
  }
}

function validateEntry(raw: unknown): ProviderTestFailureEntry | undefined {
  const parsed = raw as Partial<ProviderTestFailureEntry>;
  if (typeof parsed?.at === "string" && typeof parsed?.message === "string" && typeof parsed?.endpoint === "string") {
    return { ...parsed, at: parsed.at, endpoint: parsed.endpoint, message: parsed.message } as ProviderTestFailureEntry;
  }
  return undefined;
}
