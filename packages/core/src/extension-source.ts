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
 *   precedent is this repo's own (`typesafe` lives in the user config for
 *   the same reason, `mcpTrust` ignores the repo's own `trusted` field).
 *
 * Everything loaded here is arbitrary in-process code: a client with no
 * consent seam (headless) fails closed — the runtime refuses the load with
 * `extension_failed { reason: "consent" }` and the session continues.
 * There is no sandbox: an extension runs with the same privileges as moh.
 */
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionRuntime } from "./extensions";

/** The user-level extension directory, inside the moh home. */
export const EXTENSIONS_DIR = "extensions";

/** Module types the loader picks up (`bun` imports all four natively). */
const LOADABLE = [".ts", ".mts", ".js", ".mjs"] as const;

/** One file the client loads, and which source named it. */
export interface ExtensionSourceFile {
  /** Absolute path of the module. */
  file: string;
  /** `user`: the `~/.moh/extensions/` dotdir; `project`: a `moh.json` proposal. */
  origin: "user" | "project";
}

function isLoadableModule(name: string): boolean {
  if (name.startsWith(".")) return false;
  if (name.endsWith(".d.ts")) return false; // type declarations are not modules
  return LOADABLE.some((ext) => name.endsWith(ext));
}

/**
 * The load list, in a deterministic order: the dotdir's files sorted by
 * name, then the project's declarations in the order `moh.json` lists
 * them (a path named twice loads once). Hook precedence is registration
 * order, so this order is part of the contract, not an implementation
 * detail.
 */
export function extensionSourceFiles(options: {
  /** User moh dir (`~/.moh`). */
  mohHome: string;
  /** Project root; relative `moh.json` paths resolve against it. */
  cwd: string;
  /** `moh.json` `extensions` declarations, in file order. */
  declared?: readonly string[];
}): ExtensionSourceFile[] {
  const out: ExtensionSourceFile[] = [];
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
      const file = resolve(dir, name);
      if (seen.has(file)) continue;
      seen.add(file);
      out.push({ file, origin: "user" });
    }
  }
  for (const declared of options.declared ?? []) {
    const file = isAbsolute(declared) ? declared : resolve(options.cwd, declared);
    if (seen.has(file)) continue;
    seen.add(file);
    out.push({ file, origin: "project" });
  }
  return out;
}

/**
 * Loads the resolved sources through the runtime, in order, as one pending
 * registration (the session awaits `ready()` before its first turn, so no
 * hook is ever missing). Never throws: every failure is the runtime's own
 * visible `extension_failed` event.
 */
export async function loadExtensionSource(
  runtime: ExtensionRuntime,
  sources: readonly ExtensionSourceFile[],
): Promise<{ ok: boolean; file: string }[]> {
  if (sources.length === 0) return [];
  const results = await runtime.registerFiles(sources.map((source) => source.file));
  return sources.map((source, index) => ({ file: source.file, ok: results[index] === true }));
}
