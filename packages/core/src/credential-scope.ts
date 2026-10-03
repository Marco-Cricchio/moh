/**
 * ADR-0069: the `credential:<ref>` scope and the credential store — the
 * one check-scope module behind authenticated `ctx.host.fetch` requests.
 * The host resolves the ref and injects the value at request time; there
 * is no read-the-value API on the seam, so the shape of the surface makes
 * the leak path not exist. Pure module: validation and the storage seam
 * decide; the runtime (extensions.ts) performs and logs.
 *
 * Decisions owned here:
 * - storage behind an injected seam: OS keychain when available, bounded
 *   0600-file fallback otherwise — a namespace separate from the endpoint
 *   auth store (`~/.moh/secrets.json`, never the user-config file);
 * - the user mints, always: `set`/`delete` are client surfaces (CLI, TUI);
 *   no extension API mints a credential — the consumer never mints;
 * - flat, user-owned namespace: secrets are named, granted per extension
 *   by scope string; two extensions granted the same ref share it;
 * - names are not secrets: refs appear in consent, manifest and log;
 *   values never do (ADR-0058's pass remains in force regardless).
 */
import { mkdirSync, readFileSync, writeFileSync, statSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CREDENTIAL_SCOPE_PREFIX = "credential:";

/** True when the capability string is a credential scope (`credential:<ref>`). */
export function isCredentialScope(capability: string): boolean {
  return capability.startsWith(CREDENTIAL_SCOPE_PREFIX);
}

/** The ref half of a `credential:<ref>` scope string. */
export function credentialScopeRef(capability: string): string {
  return capability.slice(CREDENTIAL_SCOPE_PREFIX.length);
}

export type CredentialScopeValidity = { ok: true; ref: string } | { ok: false; reason: "malformed"; message: string };

/**
 * Load-time validation of one `credential:<ref>` capability. A ref is a
 * non-empty printable name without whitespace — it must survive consent,
 * manifest and log as itself.
 */
export function validateCredentialScope(capability: string): CredentialScopeValidity {
  const ref = credentialScopeRef(capability);
  if (ref.trim() === "" || /\s/.test(ref) || ref.includes("\0")) {
    return { ok: false, reason: "malformed", message: `invalid credential scope "${capability}": a ref is a non-empty name without whitespace` };
  }
  return { ok: true, ref };
}

/** All credential scopes in a capability grant (order preserved). */
export function credentialScopesOf(capabilities: readonly string[]): string[] {
  return capabilities.filter(isCredentialScope);
}

/**
 * The consent effect sentence (ADR-0069): the owner approves "may use the
 * credential `ref`". A ref is not itself a secret; naming it in consent is
 * how the owner sees which secret a grant addresses.
 */
export function credentialEffectSentence(ref: string): string {
  return `may use the credential \`${ref}\``;
}

/**
 * ADR-0069: the storage seam. Injected by session assembly (keychain when
 * available, the 0600-file fallback otherwise, in-memory in tests). The
 * value exists only behind `get` — the host resolves and injects; no
 * surface returns a list of values, only names.
 */
export interface CredentialStore {
  /** The secret for one ref, or undefined when none is stored. */
  get(ref: string): string | undefined;
  /** Creates or replaces one ref's secret (a user-surface operation). */
  set(ref: string, value: string): void;
  /** Removes one ref's secret; true when it existed. */
  delete(ref: string): boolean;
  /** The stored ref names, sorted — names only, never values. */
  list(): string[];
}

/** The fallback file's name under the moh home — its own namespace,
 * separate from the endpoint auth store's user-config file. */
export const SECRETS_FILE = "secrets.json";

/**
 * The OS-keychain store (ADR-0069, macOS Keychain via `security`): one
 * generic-password item per ref, service `moh-secret`. Returns undefined
 * where no keychain CLI exists — the caller falls back to the file store.
 * `security` failing on a get resolves as unknown (a loud fetch refusal),
 * never as an empty string.
 */
export function keychainCredentialStore(): CredentialStore | undefined {
  if (process.platform !== "darwin") return undefined;
  const service = "moh-secret";
  const run = (args: string[]): { ok: boolean; out: string } => {
    const proc = Bun.spawnSync(["security", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    return { ok: proc.exitCode === 0, out: proc.stdout.toString().trim() };
  };
  return {
    get: (ref) => {
      const r = run(["find-generic-password", "-s", service, "-a", ref, "-w"]);
      return r.ok && r.out !== "" ? r.out : undefined;
    },
    set: (ref, value) => {
      // `-U` updates an existing item; one call covers create and replace.
      run(["add-generic-password", "-s", service, "-a", ref, "-w", value, "-U"]);
    },
    delete: (ref) => run(["delete-generic-password", "-s", service, "-a", ref]).ok,
    // `security` has no list-by-service; names come from nothing here —
    // list() on the keychain store is unsupported and returns what a
    // client tracked itself, i.e. empty. `moh secret list` on macOS reads
    // the fallback file only; refs set in the keychain are known by name.
    list: () => [],
  };
}

/**
 * ADR-0069: the default store for session assembly — the OS keychain when
 * the platform provides one, the bounded 0600-file fallback otherwise.
 */
export function defaultCredentialStore(home: string): CredentialStore {
  return keychainCredentialStore() ?? fileCredentialStore({ home });
}

/**
 * The bounded 0600-file fallback (ADR-0069, the Claude Code model):
 * `<home>/.moh/secrets.json`, created 0600, written 0600 on every save —
 * a mode repair on write covers a file whose mode drifted. The endpoint
 * auth store (user-config `auth` section) is untouched.
 */
export function fileCredentialStore(options: { home: string }): CredentialStore {
  const file = join(options.home, ".moh", SECRETS_FILE);
  const read = (): Map<string, string> => {
    if (!existsSync(file)) return new Map();
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const map = new Map<string, string>();
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") map.set(k, v);
      }
      return map;
    } catch {
      // A corrupt store must not fail a fetch open: an unreadable secret
      // resolves as unknown, which the fetch path refuses loudly.
      return new Map();
    }
  };
  const write = (map: Map<string, string>): void => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(Object.fromEntries(map), null, 2) + "\n", { mode: 0o600 });
    try {
      const mode = statSync(file).mode & 0o777;
      if (mode !== 0o600) {
        // An existing file kept its old mode: repair it on every write.
        require("node:fs").chmodSync(file, 0o600);
      }
    } catch {
      // Best-effort mode repair; the initial write already asked for 0600.
    }
  };
  return {
    get: (ref) => read().get(ref),
    set: (ref, value) => {
      const map = read();
      map.set(ref, value);
      write(map);
    },
    delete: (ref) => {
      const map = read();
      const had = map.delete(ref);
      if (had) write(map);
      return had;
    },
    list: () => [...read().keys()].sort(),
  };
}
