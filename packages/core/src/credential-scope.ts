/**
 * ADR-0069: the `credential:<ref>` scope and the credential store — the
 * custody behind authenticated `ctx.host.fetch` requests. Authorization
 * is owned by the shared check-scope module.
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
import { chmodSync, mkdirSync, readFileSync, writeFileSync, statSync, existsSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
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
 * The keychain account for one (home, ref) pair (#1178): the keychain is
 * user-global while `home` is an assembly-level parameter, so the account
 * carries a digest of the home — two homes on one machine can never read
 * each other's secrets, and a temporary home (a test, a lane) cannot see
 * the ambient user's credential.
 */
/** Length of the home digest carried in a keychain account (#1178). */
const KEYCHAIN_DIGEST_CHARS = 16;
/** `security`'s exit code for "item not found" — a fine delete, a miss on get. */
const SECURITY_NOT_FOUND = 44;

/**
 * Escape a token for a `security -i` command line (#1262): double-quoted,
 * with the metacharacters the parser treats specially (`\`, `"`, `$`,
 * backtick) backslash-escaped. `security`'s line parser is shell-like but
 * not shell-strict; this form is verified live to round-trip quotes,
 * backslashes, tabs, `$` and backtick byte-exact.
 */
function securityEscape(token: string): string {
  return `"${token.replace(/[\\"$`]/g, "\\$&")}"`;
}

export function keychainAccount(home: string, ref: string): string {
  const digest = createHash("sha256").update(home).digest("hex").slice(0, KEYCHAIN_DIGEST_CHARS);
  return `${digest}:${ref}`;
}

type SecurityResult = { ok: boolean; out: string; err: string; exit: number | null };
type SecurityRunner = (args: string[], input?: string) => SecurityResult;

const defaultSecurityRunner: SecurityRunner = (args, input) => {
  const proc = Bun.spawnSync(["security", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: input === undefined ? "ignore" : Buffer.from(input, "utf8"),
  });
  return { ok: proc.exitCode === 0, out: proc.stdout.toString().trim(), err: proc.stderr.toString().trim(), exit: proc.exitCode };
};

/**
 * The OS-keychain store (ADR-0069, macOS Keychain via `security`): one
 * generic-password item per (home, ref), service `moh-secret`, account
 * home-digested (#1178). Returns undefined where no keychain CLI exists —
 * the caller falls back to the file store. `security` failing on a get
 * resolves as unknown (a loud fetch refusal), never as an empty string.
 * The names-only ledger lives beside the fallback store under the given
 * home, so `list()` stays truthful.
 *
 * Items written before #1178 used the bare ref as the account. They are
 * visible only from the ambient real user home (`home === homedir()`) —
 * a legacy fallback on `get` and cleanup on `delete` — never from a
 * temporary home, which is the isolation this scoping exists for.
 */
export function keychainCredentialStore(home: string, run: SecurityRunner = defaultSecurityRunner): CredentialStore | undefined {
  // No keychain where the platform provides none — but only for the real
  // `security` runner: an injected runner (tests) runs on any platform.
  if (run === defaultSecurityRunner && process.platform !== "darwin") return undefined;
  const service = "moh-secret";
  const isAmbientHome = home === homedir();
  const account = (ref: string): string => keychainAccount(home, ref);
  // Names-only ledger under the given home: the keychain has no
  // list-by-service, so a set/delete records the ref name (never the
  // value) beside the keychain item — `list()` stays truthful.
  const names = fileCredentialStore({ home: home });
  return {
    get: (ref) => {
      const r = run(["find-generic-password", "-s", service, "-a", account(ref), "-w"]);
      if (r.ok && r.out !== "") return r.out;
      // Legacy (#1178) fallback: a pre-scoping item stored under the bare
      // ref is honored only from the ambient real user home — a temporary
      // home must never see another home's secret.
      if (isAmbientHome) {
        const legacy = run(["find-generic-password", "-s", service, "-a", ref, "-w"]);
        if (legacy.ok && legacy.out !== "") return legacy.out;
      }
      return undefined;
    },
    set: (ref, value) => {
      // The value never rides argv (`ps` reads argv for every local user,
      // #1262): `security -i` reads the command from stdin, and the value
      // goes in escaped via securityEscape. Three shapes cannot survive
      // the line-based parser — a newline (it ends the command), a tab and
      // a trailing backslash (the parser mangles both) — and `security`
      // offers no argv-free
      // encoding that dodges them (`-X` stores hex literally, never
      // decoded). A value with either shape is refused loudly rather than
      // stored wrong: a silent mis-store on a credential surface is the
      // one unforgivable lie. `-U` covers create and replace in one call.
      // A failed write throws — the caller (CLI, TUI) shows it.
      if (/[\n\r\t]/.test(value) || value.endsWith("\\")) {
        throw new Error(
          `keychain write for "${ref}" refused: the value contains a newline, a tab or a trailing backslash, which the keychain CLI cannot store without exposing it in process argv`,
        );
      }
      const command = `add-generic-password -s ${securityEscape(service)} -a ${securityEscape(account(ref))} -w ${securityEscape(value)} -U\n`;
      const r = run(["-i"], command);
      if (!r.ok) throw new Error(`keychain write failed (security exit ${r.exit}): ${r.err}`);
      names.set(ref, "");
    },
    delete: (ref) => {
      // "not found" (SECURITY_NOT_FOUND) is a fine delete; any other failure is one.
      const remove = (acc: string): boolean => {
        const r = run(["delete-generic-password", "-s", service, "-a", acc]);
        if (!r.ok && r.exit !== SECURITY_NOT_FOUND) throw new Error(`keychain delete failed (security exit ${r.exit}): ${r.err}`);
        return r.ok;
      };
      let removed = remove(account(ref));
      if (isAmbientHome) {
        // Legacy cleanup: a pre-scoping bare-account item, ambient home only.
        removed = remove(ref) || removed;
      }
      names.delete(ref);
      return removed;
    },
    list: () => names.list(),
  };
}

/**
 * ADR-0069: the default store for session assembly — the OS keychain when
 * the platform provides one, the bounded 0600-file fallback otherwise.
 * `MOH_SECRET_STORE=file` forces the fallback (tests, headless boxes);
 * no other value is honored.
 */
export function defaultCredentialStore(home: string): CredentialStore {
  if (process.env.MOH_SECRET_STORE === "file") return fileCredentialStore({ home });
  return keychainCredentialStore(home) ?? fileCredentialStore({ home });
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
        chmodSync(file, 0o600);
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
