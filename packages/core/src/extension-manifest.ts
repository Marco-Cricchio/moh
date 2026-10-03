/**
 * The extension manifest (ADR-0061, #1125): capabilities, version and
 * entry point are declared in a static `moh.extension.json` beside the
 * entry point. Consent reads and signs the manifest (path + SHA-256 of
 * manifest and code) without executing anything; at import the runtime
 * verifies the code's declared capabilities are a subset of the
 * manifest's — a superset is a loud refusal, never a crash.
 *
 * Pure module: it only reads files. The runtime (extensions.ts) decides
 * what a missing or malformed manifest means for a load.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The manifest file name, beside the entry point. */
export const MANIFEST_FILE = "moh.extension.json";

/** A declared capability slot. Free-form string on purpose: the slot
 * vocabulary grows (ADR-0062 added the `contribute-*` slots), and an
 * unknown slot is a warning at install time, never a refusal here. */
export type CapabilitySlot = string;

export interface ExtensionManifest {
  readonly name: string;
  readonly version: string;
  /**
   * ADR-0066: the author's justification for a total network wildcard
   * (`host:*`). Required by the runtime when the manifest declares
   * `host:*`; the consent question displays it. moh never verifies the
   * text — the owner reads it and decides.
   */
  readonly reasoning?: string;
  /** The entry point(s) this manifest speaks for, relative to the manifest
   * (a basename or a relative path). A package with several entry modules
   * declares them all and shares one capability set. */
  readonly entry: readonly string[];
  readonly capabilities: readonly CapabilitySlot[];
}

/** What consent signs about one manifest: its own SHA-256 (`hash`), the
 * stable store key (`path` — the manifest file's path), and the
 * capabilities it declared. */
export interface ManifestAuthority {
  readonly hash: string;
  readonly path: string;
  readonly capabilities: readonly string[];
  /** ADR-0066: the manifest's `reasoning`, when it declares one. */
  readonly reasoning?: string;
}

export type ManifestReadResult =
  | { ok: true; manifest: ExtensionManifest; authority: ManifestAuthority }
  | { ok: false; reason: "missing" | "malformed"; message: string };

export function manifestPathFor(entryFile: string): string {
  return join(dirname(entryFile), MANIFEST_FILE);
}

function isManifestValue(value: unknown): value is ExtensionManifest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== "string" || v.name.length === 0) return false;
  if (typeof v.version !== "string") return false;
  const entry = v.entry;
  const entries = Array.isArray(entry) ? entry : [entry];
  if (entries.length === 0 || !entries.every((e) => typeof e === "string" && e.length > 0)) return false;
  if (v.capabilities !== undefined) {
    if (!Array.isArray(v.capabilities) || !v.capabilities.every((c) => typeof c === "string")) return false;
  }
  if (v.reasoning !== undefined && typeof v.reasoning !== "string") return false;
  return true;
}

function normalizeManifest(value: unknown): ExtensionManifest {
  const v = value as Record<string, unknown>;
  const entry = v.entry;
  return {
    name: v.name as string,
    version: v.version as string,
    entry: Object.freeze((Array.isArray(entry) ? entry : [entry]) as string[]),
    capabilities: Object.freeze((v.capabilities as string[] | undefined) ?? []),
    ...(typeof v.reasoning === "string" ? { reasoning: v.reasoning } : {}),
  };
}

/**
 * Reads and validates the manifest for one entry file: `moh.extension.json`
 * in the entry's directory, belonging to the file only when it names it
 * (a directory may hold several manifests-worth of modules; a manifest
 * whose `entry` names another file is not this module's). Never throws and
 * never executes anything: the whole point (ADR-0061) is that consent is
 * decidable from these bytes alone.
 */
export function readExtensionManifest(entryFile: string): ManifestReadResult {
  const file = manifestPathFor(entryFile);
  let bytes: Buffer;
  try {
    if (!existsSync(file)) {
      return { ok: false, reason: "missing", message: `no ${MANIFEST_FILE} beside ${basename(entryFile)}` };
    }
    bytes = readFileSync(file);
  } catch {
    return { ok: false, reason: "missing", message: `no ${MANIFEST_FILE} beside ${basename(entryFile)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "malformed", message: `${MANIFEST_FILE} is not valid JSON: ${message}` };
  }
  if (!isManifestValue(parsed)) {
    return {
      ok: false,
      reason: "malformed",
      message: `${MANIFEST_FILE} must declare { name, version, entry, capabilities? } with string values`,
    };
  }
  const manifest = normalizeManifest(parsed);
  const base = basename(entryFile);
  if (!manifest.entry.some((e) => e === base || join(dirname(entryFile), e) === entryFile)) {
    return {
      ok: false,
      reason: "missing",
      message: `${MANIFEST_FILE} declares entry ${manifest.entry.join(", ")} — not ${base}`,
    };
  }
  return {
    ok: true,
    manifest,
    // One read, one hash: the authority the consent signs is the exact
    // bytes this call parsed — no second read to race a swap.
    authority: {
      hash: createHash("sha256").update(bytes).digest("hex"),
      path: file,
      capabilities: manifest.capabilities,
      ...(manifest.reasoning !== undefined ? { reasoning: manifest.reasoning } : {}),
    },
  };
}

/** What a manifest edit changed, in consent terms: `added` is the widening
 * (new powers the question must name); `removed` is recorded but never
 * blocks — a narrower manifest is not a wider grant. */
export function capabilityDiff(
  previous: readonly CapabilitySlot[],
  next: readonly CapabilitySlot[],
): { added: CapabilitySlot[]; removed: CapabilitySlot[] } {
  const prev = new Set(previous);
  const cur = new Set(next);
  return {
    added: next.filter((c) => !prev.has(c)),
    removed: previous.filter((c) => !cur.has(c)),
  };
}

/** True when every capability the code declares is covered by the manifest. */
export function capabilitiesSubset(
  code: readonly CapabilitySlot[],
  manifest: readonly CapabilitySlot[],
): { ok: true } | { ok: false; undeclared: CapabilitySlot[] } {
  const declared = new Set(manifest);
  const undeclared = code.filter((c) => !declared.has(c));
  return undeclared.length === 0 ? { ok: true } : { ok: false, undeclared };
}
