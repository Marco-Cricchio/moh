/**
 * Update check (issue #273 / ADR-0014): the binary learns about new stable
 * versions via GitHub's `releases/latest` API and surfaces a notice in the
 * TUI. This module owns the check itself — cache, comparison, and the
 * silent-failure contract — fully injectable (fetch/clock/fs) so tests
 * never touch the network.
 *
 * Contract (mirrors the skills upstream check): the call-home is opt-out,
 * cached for 24h in `~/.moh/update-check.json`, carries no identifiers,
 * and fails with total silence — an update check must never degrade or
 * delay startup.
 */
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

/** GitHub endpoint for the newest stable release (no identifiers sent). */
export const RELEASES_LATEST_URL = "https://api.github.com/repos/Marco-Cricchio/moh/releases/latest";

/** How long a cached result is trusted. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 3600_000;

/** Default network budget; never blocks startup longer than this. */
export const UPDATE_CHECK_TIMEOUT_MS = 4_000;

/** `~/.moh/update-check.json` — the 24h cache. */
export function updateCacheFile(mohHome: string): string {
  return join(mohHome, "update-check.json");
}

/** Injectable IO: fetch, clock, and the cache file read/write. */
export interface UpdateCheckIo {
  fetch?: (url: string, signal?: AbortSignal) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;
  now?: () => number;
  read?: (file: string) => string;
  write?: (file: string, data: string) => void;
}

/** The cached check result. */
export interface UpdateCache {
  lastCheckedAt: number;
  latestVersion: string;
}

/**
 * Dev-run detection (ADR-0014): compiled binaries run from Bun's `$bunfs`
 * virtual filesystem; a repo checkout does not. The check is skipped
 * entirely in dev runs.
 */
export function isDevRun(dir: string = import.meta.dir): boolean {
  return !dir.includes("$bunfs");
}

/** Loose semver parse ("v1.2.3" → [1,2,3]); null when not semver-ish. */
function parseSemver(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Loose semver compare: -1 when a < b, 0 when equal, 1 when a > b. */
export function compareSemver(a: string, b: string): number {
  const [x, y] = [parseSemver(a), parseSemver(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x?.[i] ?? 0) - (y?.[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** What the TUI should show. */
export interface UpdateNotice {
  kind: "available" | "nonstable";
  latestVersion: string;
}

/**
 * Pure projection of (current, latest) → notice. No notice when the
 * versions are equal or either side is unparsable/missing.
 */
export function updateNoticeFor(current: string, latest: string | undefined): UpdateNotice | null {
  if (!latest || !parseSemver(latest) || !parseSemver(current)) return null;
  const norm = latest.replace(/^v/, "");
  const cmp = compareSemver(current, latest);
  if (cmp < 0) return { kind: "available", latestVersion: norm };
  if (cmp > 0) return { kind: "nonstable", latestVersion: norm };
  return null;
}

/** Reads the cache; missing, corrupt or partial files read as null. */
export function readUpdateCache(mohHome: string, io: UpdateCheckIo = {}): UpdateCache | null {
  try {
    const raw = (io.read ?? ((f: string) => readFileSync(f, "utf8")))(updateCacheFile(mohHome));
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" && parsed !== null &&
      typeof (parsed as UpdateCache).lastCheckedAt === "number" &&
      typeof (parsed as UpdateCache).latestVersion === "string"
    ) {
      return parsed as UpdateCache;
    }
  } catch {
    // missing or invalid: no cached result
  }
  return null;
}

/** True when the cache is absent or older than 24h. */
export function updateDue(cache: UpdateCache | null, now: number = Date.now()): boolean {
  return !cache || now - cache.lastCheckedAt >= UPDATE_CHECK_INTERVAL_MS;
}

/** Writes the cache atomically (temp file + rename); silent on failure. */
export function writeUpdateCache(mohHome: string, latestVersion: string, io: UpdateCheckIo = {}): void {
  const cache: UpdateCache = { lastCheckedAt: io.now?.() ?? Date.now(), latestVersion };
  const file = updateCacheFile(mohHome);
  const data = `${JSON.stringify(cache, null, 2)}\n`;
  try {
    if (io.write) io.write(file, data);
    else {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp-${process.pid}`;
      // An atomic replacement must not silently tighten an existing file.
      const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
      writeFileSync(tmp, data, { mode });
      renameSync(tmp, file);
    }
  } catch {
    // cache write failure is as silent as a network failure
  }
}

/**
 * Queries `releases/latest` and refreshes cache + returns the latest
 * stable version, or null on any failure — network error, non-2xx,
 * malformed body, non-semver tag — never throws, never blocks longer
 * than the timeout.
 */
export async function checkForUpdate(options: {
  mohHome: string;
  url?: string;
  timeoutMs?: number;
  io?: UpdateCheckIo;
}): Promise<string | null> {
  const io = options.io ?? {};
  const fetchImpl = io.fetch ?? globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS);
  let latest: string | null = null;
  try {
    const res = await fetchImpl(options.url ?? RELEASES_LATEST_URL, ctrl.signal);
    if (res.ok) {
      const body = await res.json();
      const tag = (body as { tag_name?: unknown } | null)?.tag_name;
      if (typeof tag === "string" && parseSemver(tag)) latest = tag.replace(/^v/, "");
    }
  } catch {
    return null; // silent by contract
  } finally {
    clearTimeout(timer);
  }
  if (latest === null) return null;
  writeUpdateCache(options.mohHome, latest, io);
  return latest;
}
