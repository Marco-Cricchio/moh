/**
 * Self-update (issue #274 / ADR-0014): `moh update` downloads the platform
 * asset from the latest stable GitHub Release, verifies it against the
 * release's checksums.txt, and replaces the running executable atomically
 * (temp file next to the binary, then rename over it).
 *
 * Fully injectable (fetch/fs/clock/confirm) so unit tests never touch the
 * network or the real binary. The CLI layer (`packages/cli/src/update.ts`)
 * owns exit codes, usage, and the interactive confirmation.
 */
import { chmodSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CryptoHasher } from "bun";
import { RELEASES_LATEST_URL, compareSemver, writeUpdateCache } from "./update-check";

/** Platform vocabulary shared with scripts/build.ts (ADR-0013). */
export const UPDATE_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64"] as const;
export type UpdatePlatform = (typeof UPDATE_PLATFORMS)[number];

/** Injectable network seam (release JSON, binary asset, checksums). */
export interface UpdateFetchResponse {
  ok: boolean;
  status?: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}
export type UpdateFetch = (url: string) => Promise<UpdateFetchResponse>;

/** Injectable environment for tests. */
export interface SelfUpdateIo {
  fetch?: UpdateFetch;
  /** sha256 of a buffer, hex (default: Bun.CryptoHasher). */
  sha256?: (data: Uint8Array) => string;
  /** Write downloaded bytes to a path and mark executable (default: node:fs). */
  writeExecutable?: (path: string, data: Uint8Array) => void;
  rename?: (from: string, to: string) => void;
  remove?: (path: string) => void;
  /** Refresh the update-check cache after a successful update (#328);
   * silent on failure — an update that succeeded is never reported failed. */
  writeUpdateCache?: (mohHome: string, latestVersion: string) => void;
}

export type SelfUpdateStatus =
  | "dev-run" // running from a repo checkout, not a compiled binary
  | "unsupported-platform"
  | "up-to-date"
  | "confirm-declined"
  | "checksum-mismatch"
  | "error" // network / malformed release / missing asset
  | "updated";

export interface SelfUpdateResult {
  status: SelfUpdateStatus;
  /** Human-readable, ends without newline; printed as-is by the CLI. */
  message: string;
}

/** Maps a (process.platform, process.arch) pair onto the release vocabulary. */
export function detectUpdatePlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): UpdatePlatform {
  if (platform === "darwin") return arch === "x64" ? "darwin-x64" : arch === "arm64" ? "darwin-arm64" : unsupported(arch);
  if (platform === "linux" && arch === "x64") return "linux-x64";
  return unsupported(`${platform}-${arch}`);
  function unsupported(what: string): never {
    throw new Error(`unsupported platform ${what} — supported: ${UPDATE_PLATFORMS.join(", ")}`);
  }
}

/** The `releases/latest` endpoint, overridable via MOH_RELEASES_URL (e2e). */
export function releasesUrl(): string {
  return process.env.MOH_RELEASES_URL ?? RELEASES_LATEST_URL;
}

/** True for prerelease-suffixed versions ("0.2.0-rc.1", "0.3.0-dev"). */
export function isPrerelease(version: string): boolean {
  return /-\S+/.test(version.replace(/^v/, ""));
}

/** Minimal shape of the GitHub release we consume. */
interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}
interface ReleaseBody {
  tag_name?: unknown;
  assets?: unknown;
}

/** Extracts an asset's download URL by name from a release body. */
export function assetUrl(body: unknown, name: string): string | null {
  const assets = (body as ReleaseBody | null)?.assets;
  if (!Array.isArray(assets)) return null;
  for (const a of assets) {
    if (a && typeof (a as ReleaseAsset).name === "string" && (a as ReleaseAsset).name === name) {
      const url = (a as ReleaseAsset).browser_download_url;
      if (typeof url === "string" && url) return url;
    }
  }
  return null;
}

/** sha256 hex of a checksums.txt payload for `name`; null when absent. */
export function checksumFor(checksumsText: string, name: string): string | null {
  for (const line of checksumsText.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (m && m[2] === name) return m[1];
  }
  return null;
}

const defaultSha256 = (data: Uint8Array): string => {
  const hasher = new CryptoHasher("sha256");
  hasher.update(data);
  return hasher.digest("hex");
};

const defaultWriteExecutable = (path: string, data: Uint8Array): void => {
  writeFileSync(path, data);
  chmodSync(path, 0o755);
};

/**
 * Performs the full update. Never touches the current binary unless the
 * downloaded asset verified against checksums.txt; a mismatch or any later
 * failure leaves the running executable exactly as it was.
 */
export async function performSelfUpdate(options: {
  currentVersion: string;
  execPath: string;
  platform?: UpdatePlatform;
  /** Skip the downgrade-from-nonstable confirmation (CLI --yes). */
  assumeYes?: boolean;
  /** Ask about downgrading to latest stable; default callback returns true. */
  confirmDowngrade?: (latestVersion: string) => Promise<boolean> | boolean;
  url?: string;
  /** moh home dir; when set, a successful update refreshes the
   * update-check cache so it agrees with the freshly installed binary (#328). */
  mohHome?: string;
  io?: SelfUpdateIo;
}): Promise<SelfUpdateResult> {
  const io = {
    sha256: defaultSha256,
    writeExecutable: defaultWriteExecutable,
    rename: renameSync,
    remove: (p: string) => {
      try {
        unlinkSync(p);
      } catch {
        // best-effort cleanup
      }
    },
    writeUpdateCache,
    ...options.io,
  };
  return runUpdate(options, io);
}

/** Shared implementation once IO is resolved. */
async function runUpdate(
  options: Parameters<typeof performSelfUpdate>[0],
  io: { sha256: (data: Uint8Array) => string; writeExecutable: (path: string, data: Uint8Array) => void; rename: (from: string, to: string) => void; remove: (path: string) => void; writeUpdateCache: (mohHome: string, latestVersion: string) => void },
): Promise<SelfUpdateResult> {
  const fetchImpl = options.io?.fetch ?? (globalThis.fetch as unknown as UpdateFetch);
  let platform: UpdatePlatform;
  try {
    platform = options.platform ?? detectUpdatePlatform();
  } catch (e) {
    return { status: "unsupported-platform", message: (e as Error).message };
  }

  // 1. Latest stable release metadata.
  let release: unknown;
  try {
    const res = await fetchImpl(options.url ?? releasesUrl());
    if (!res.ok) {
      return { status: "error", message: `could not fetch the latest release (HTTP ${res.status ?? "?"}) — try again later` };
    }
    release = await res.json();
  } catch {
    return { status: "error", message: "network error while fetching the latest release — try again later" };
  }
  const tag = (release as ReleaseBody | null)?.tag_name;
  if (typeof tag !== "string" || !tag) {
    return { status: "error", message: "latest release has no version tag — try again later" };
  }
  const latest = tag.replace(/^v/, "");

  // 2. Version decision: equal stable → nothing to do; anything that would
  // mean moving down to the latest stable (a newer current version, or a
  // prerelease build of the same version) asks for confirmation first.
  const cmp = compareSemver(options.currentVersion, latest);
  const currentIsPrerelease = isPrerelease(options.currentVersion);
  if (cmp === 0 && !currentIsPrerelease) {
    return { status: "up-to-date", message: `moh ${latest} is already the latest stable release` };
  }
  if (cmp > 0 || currentIsPrerelease) {
    const answer = options.assumeYes
      ? true
      : options.confirmDowngrade
        ? await options.confirmDowngrade(latest)
        : false; // non-interactive by default: refuse the downgrade
    if (!answer) return { status: "confirm-declined", message: `staying on ${options.currentVersion} (latest stable is ${latest})` };
  }

  // 3. Locate the platform asset and checksums.
  const assetName = `moh-${platform}`;
  const asset = assetUrl(release, assetName);
  const checksumsUrl = assetUrl(release, "checksums.txt");
  if (!asset || !checksumsUrl) {
    return { status: "error", message: `latest release is missing its ${assetName} asset or checksums.txt — not updating` };
  }

  // 4. Download asset + checksums.
  let assetBytes: ArrayBuffer;
  let checksumsText: string;
  try {
    const [assetRes, sumsRes] = await Promise.all([fetchImpl(asset), fetchImpl(checksumsUrl)]);
    if (!assetRes.ok || !sumsRes.ok) {
      return { status: "error", message: "could not download the update assets — try again later" };
    }
    assetBytes = await assetRes.arrayBuffer();
    checksumsText = await sumsRes.text();
  } catch {
    return { status: "error", message: "network error while downloading the update — try again later" };
  }

  // 5. Verify sha256 against checksums.txt before touching anything.
  const expected = checksumFor(checksumsText, assetName);
  const actual = io.sha256(new Uint8Array(assetBytes));
  if (!expected || expected !== actual) {
    return {
      status: "checksum-mismatch",
      message: `checksum mismatch for ${assetName} (expected ${expected ?? "no entry in checksums.txt"}, got ${actual}) — update aborted, binary untouched`,
    };
  }

  // 6. Atomic replace: temp file next to the binary, then rename over it.
  const tmp = join(dirname(options.execPath), `.${assetName}.update-${process.pid}`);
  try {
    io.writeExecutable(tmp, new Uint8Array(assetBytes));
    io.rename(tmp, options.execPath);
  } catch (e) {
    io.remove(tmp);
    return { status: "error", message: `could not replace ${options.execPath}: ${(e as Error).message}` };
  }
  // #328: the cache must agree with the freshly installed binary — the
  // download always targeted `releases/latest`, so the installed version
  // is the latest stable (or the version the user just confirmed downgrading
  // to; either way the cache must not keep advertising something else).
  if (options.mohHome) {
    try {
      io.writeUpdateCache(options.mohHome, latest);
    } catch {
      // best-effort: a succeeded update is never reported failed (#328)
    }
  }
  return { status: "updated", message: `updated moh ${options.currentVersion} → ${latest}` };
}
