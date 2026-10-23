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
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { basename, isAbsolute, join, sep } from "node:path";
import { canonicalModulePath } from "./extensions";
import { MANIFEST_FILE, readExtensionManifest } from "./extension-manifest";

/** The user-level extension directory, inside the moh home. */
const EXTENSIONS_DIR = "extensions";

/** Module types the loader picks up (`bun` imports all four natively). */
const LOADABLE = [".ts", ".mts", ".js", ".mjs"] as const;

function isLoadableModule(name: string): boolean {
  if (name.startsWith(".")) return false;
  if (name.endsWith(".d.ts")) return false; // type declarations are not modules
  return LOADABLE.some((ext) => name.endsWith(ext));
}

/**
 * A dotdir entry that is a directory, through a symlink too (dotfiles
 * managers, cross-device installs). A dangling link is not one — and must
 * not throw: a single broken link in `~/.moh/extensions` would otherwise
 * empty the whole list, loose files included.
 */
function isDirectoryEntry(dir: string, entry: Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(join(dir, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The module files one installed package directory contributes. A package
 * is its `moh.extension.json`: the manifest's `entry` list names the files
 * that load (each through the same content-bound consent as a loose file),
 * and everything else in the directory — `vendor/` above all — never loads.
 * A directory whose manifest is missing or unreadable contributes its
 * top-level loadable files anyway, so the runtime refuses loudly with its
 * manifest reason instead of the package vanishing silently (the loose-file
 * contract, one level down).
 */
function packageEntryFiles(dir: string): { files: string[]; name?: string } {
  const topLevelLoadables = (): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => (e.isFile() || e.isSymbolicLink()) && isLoadableModule(e.name))
        .map((e) => canonicalModulePath(join(dir, e.name)))
        .sort();
    } catch {
      return [];
    }
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"));
  } catch {
    return { files: topLevelLoadables() };
  }
  const v = parsed as { name?: unknown; entry?: unknown } | null;
  if (typeof v?.name !== "string" || v.name.length === 0) return { files: topLevelLoadables() };
  const entries = (Array.isArray(v.entry) ? v.entry : [v.entry]).filter(
    (e): e is string => typeof e === "string" && e.length > 0,
  );
  const files: string[] = [];
  const root = canonicalModulePath(dir);
  for (const entry of entries) {
    if (isAbsolute(entry)) continue;
    const file = canonicalModulePath(join(dir, entry));
    // Only the package's own files load: an entry that resolves outside
    // its directory (`../other.mjs`, or a link leading out) is skipped.
    if (!file.startsWith(root + sep)) continue;
    // A declared entry that does not exist is skipped here on purpose:
    // the runtime's refusal is keyed to a file's bytes, so there is
    // nothing it could name — and the installer's static checks already
    // refused a package whose manifest names no real file.
    if (isLoadableModule(basename(file)) && existsSync(file)) files.push(file);
  }
  return { files, name: v.name };
}

/**
 * The modules to load, in a deterministic order: the dotdir's loose files
 * sorted by name, then the dotdir's installed packages sorted by directory
 * name (each contributing its manifest's entries in declared order), then
 * the project's declarations in the order `moh.json` lists them. An
 * installed package whose manifest `name` matches a project declaration is
 * skipped — the same rule `moh extension list` applies, project scope wins
 * over the user dotdir. Paths are canonical (symlinks resolved) and
 * deduplicated by that canonical path, so one file reached by two spellings
 * loads once — the same rule the runtime's content identity follows. Hook
 * precedence is registration order, so this order is part of the contract,
 * not an implementation detail.
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
  const declaredNames = new Set<string>();
  for (const declared of options.declared ?? []) {
    const file = isAbsolute(declared) ? declared : join(options.cwd, declared);
    if (!existsSync(file)) continue;
    const manifest = readExtensionManifest(file);
    if (manifest.ok) declaredNames.add(manifest.manifest.name);
  }
  const dir = join(options.mohHome, EXTENSIONS_DIR);
  if (existsSync(dir)) {
    let entries: { name: string; isDir: boolean }[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => !e.name.startsWith("."))
        .map((e) => ({ name: e.name, isDir: isDirectoryEntry(dir, e) }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch {
      entries = []; // an unreadable dir is "no extensions", never a session error
    }
    const add = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      out.push(file);
    };
    for (const entry of entries) {
      if (entry.isDir || !isLoadableModule(entry.name)) continue;
      add(canonicalModulePath(join(dir, entry.name)));
    }
    for (const entry of entries) {
      if (!entry.isDir) continue;
      const pkg = packageEntryFiles(join(dir, entry.name));
      // The declared (project) copy wins over the user dotdir's, matching
      // `moh extension list` — the skip is by manifest identity, so a
      // different package in a same-named directory still loads.
      if (pkg.name !== undefined && declaredNames.has(pkg.name)) continue;
      for (const file of pkg.files) add(file);
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
