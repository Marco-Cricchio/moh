/**
 * Where a client loads extensions from (#834).
 *
 * Two sources, one trust posture:
 *
 * - **`<mohHome>/extensions/`** — the user's own dotdir. Explicit,
 *   owner-controlled, machine-scoped. No project directory is ever
 *   auto-discovered: a cloned repository must not be able to run code on
 *   the user's machine.
 * - **`moh.json "extensions"`** — the project **proposes**, the user
 *   disposes: a declared path is offered through the runtime's one-time
 *   consent (resolved path + content hash) like any other file. The
 *   precedent is this repo's own (an API key lives in the user config for
 *   the same reason, `mcpTrust` ignores the repo's own `trusted` field).
 *
 * Everything loaded here is arbitrary in-process code: a client with no
 * consent seam (headless) fails closed — the runtime refuses the load with
 * `extension_failed { reason: "consent" }` and the session continues.
 * There is no sandbox: an extension runs with the same privileges as moh.
 */
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { canonicalModulePath } from "./extensions";

/** The user-level extension directory, inside the moh home. */
export const EXTENSIONS_DIR = "extensions";

/** Module types the loader picks up (`bun` imports all four natively). */
const LOADABLE = [".ts", ".mts", ".js", ".mjs"] as const;

function isLoadableModule(name: string): boolean {
  if (name.startsWith(".")) return false;
  if (name.endsWith(".d.ts")) return false; // type declarations are not modules
  return LOADABLE.some((ext) => name.endsWith(ext));
}

/**
 * The modules to load, in a deterministic order: the dotdir's files sorted
 * by name, then the project's declarations in the order `moh.json` lists
 * them. Paths are canonical (symlinks resolved) and deduplicated by that
 * canonical path, so one file reached by two spellings loads once — the
 * same rule the runtime's content identity follows. Hook precedence is
 * registration order, so this order is part of the contract, not an
 * implementation detail.
 */
export function extensionSourceFiles(options: {
  /** User moh dir (`~/.moh`). */
  mohHome: string;
  /** Project root; relative `moh.json` paths resolve against it. */
  cwd: string;
  /** `moh.json` `extensions` declarations, in file order. */
  declared?: readonly string[];
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const dir = join(options.mohHome, EXTENSIONS_DIR);
  if (existsSync(dir)) {
    let names: string[] = [];
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && isLoadableModule(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch {
      names = []; // an unreadable dir is "no extensions", never a session error
    }
    for (const name of names) {
      const file = canonicalModulePath(join(dir, name));
      if (seen.has(file)) continue;
      seen.add(file);
      out.push(file);
    }
  }
  for (const declared of options.declared ?? []) {
    // Absolute, or relative to the project — a declaration outside the
    // project root is legal and asks through the same consent, which names
    // the resolved path the user is being asked about.
    const file = canonicalModulePath(isAbsolute(declared) ? declared : join(options.cwd, declared));
    if (seen.has(file)) continue;
    seen.add(file);
    out.push(file);
  }
  return out;
}
