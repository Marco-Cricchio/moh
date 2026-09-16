/**
 * User-defined declarative color themes (#749): JSON files, one per theme,
 * under `~/.moh/themes/`. v1 format: version 1, slug id, display name,
 * `extends` (a built-in preset id only), and a partial `colors` map over the
 * real semantic tokens — omitted roles inherit from the base preset. No
 * executable code, no user-theme inheritance, no `$schema`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { COLOR_ROLES, DEFAULT_THEME, THEMES, isHexColor, type ColorRole, type Theme } from "./themes";

/** The on-disk v1 theme file. */
export interface UserThemeFile {
  version: 1;
  /** Stable slug; also the file name (`<id>.json`). */
  id: string;
  name: string;
  /** A built-in preset id — never another user theme. */
  extends: string;
  colors: Partial<Record<ColorRole, string>>;
}

/** The themes directory: `~/.moh/themes/` (home overridable for tests). */
export function themesDir(home: string = homedir()): string {
  return join(home, ".moh", "themes");
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** #749: display label for a theme ref — built-ins show `label · built-in`,
 * user themes `name · personal`, unknown refs the raw ref. */
export function themeLabelFor(ref: ThemeRef, home: string = homedir()): string {
  if (ref.startsWith("user:")) {
    const id = ref.slice("user:".length);
    const theme = loadUserTheme(home, id);
    return theme ? `${theme.label} · personal` : `${ref} (missing)`;
  }
  const preset = THEMES[ref as keyof typeof THEMES];
  return preset ? `${preset.label} · built-in` : ref;
}


/** Validates and parses one theme file's contents. The file path is part of
 * every error so the TUI can name the culprit; `@ internal` marks validation
 * not tied to a specific file. */
export function parseUserThemeFile(file: string, contents: string): { ok: true; theme: UserThemeFile } | { ok: false; error: string } {
  const bad = (why: string) => ({ ok: false as const, error: `${file}: ${why}` });
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (e) {
    return bad(`invalid JSON — ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("expected a JSON object");
  const src = raw as Record<string, unknown>;
  if (src.version !== 1) return bad(`unsupported "version" (must be 1)`);
  if (typeof src.id !== "string" || !SLUG.test(src.id)) {
    return bad(`invalid "id" — must be a lowercase slug ([a-z0-9-])`);
  }
  if (typeof src.name !== "string" || src.name.trim() === "") return bad(`missing "name"`);
  if (typeof src.extends !== "string" || !(src.extends in THEMES)) {
    return bad(`"extends" must be a built-in preset id (one of: ${Object.keys(THEMES).join(", ")}) — user-theme inheritance is not supported`);
  }
  if (typeof src.colors !== "object" || src.colors === null || Array.isArray(src.colors)) return bad(`missing "colors" object`);
  const colors: Partial<Record<ColorRole, string>> = {};
  for (const [role, value] of Object.entries(src.colors as Record<string, unknown>)) {
    if (!(COLOR_ROLES as readonly string[]).includes(role)) return bad(`unknown color role "${role}" (known: ${COLOR_ROLES.join(", ")})`);
    if (typeof value !== "string" || !isHexColor(value)) return bad(`"${role}" must be a hex color like #7aa2f7`);
    colors[role as ColorRole] = value.toLowerCase();
  }
  return { ok: true, theme: { version: 1, id: src.id, name: src.name, extends: src.extends, colors } };
}

/** Flattens a user theme onto its base preset: file colors win, the rest
 * inherits. The label is the theme's display name. Returns null when the
 * file is missing, unreadable, or invalid (caller decides the fallback). */
export function loadUserTheme(home: string, id: string): Theme | null {
  const file = join(themesDir(home), `${id}.json`);
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const parsed = parseUserThemeFile(file, contents);
  if (!parsed.ok) return null;
  const base = THEMES[parsed.theme.extends as keyof typeof THEMES];
  return {
    ...base,
    label: parsed.theme.name,
    ...parsed.theme.colors,
  } as Theme;
}

export interface UserThemeSummary {
  id: string;
  name: string;
}

/** Lists valid user themes (id + name), sorted by id. Invalid files are
 * skipped here; a malformed *active* theme reports through resolveThemeRef. */
export function listUserThemes(home: string): UserThemeSummary[] {
  const dir = themesDir(home);
  if (!existsSync(dir)) return [];
  const out: UserThemeSummary[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      try {
        const parsed = parseUserThemeFile(join(dir, entry), readFileSync(join(dir, entry), "utf8"));
        if (parsed.ok) out.push({ id: parsed.theme.id, name: parsed.theme.name });
      } catch {
        // Unreadable file: skipped from the list, never fatal.
      }
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Writes a theme file (create or overwrite by id). The id must match the
 * file naming; a different file already claiming the id is rejected so an
 * edit can never silently clobber an unrelated theme. */
export function saveUserTheme(home: string, theme: UserThemeFile): void {
  const parsed = parseUserThemeFile(`@ ${theme.id}.json`, JSON.stringify(theme));
  if (!parsed.ok) throw new Error(parsed.error);
  const dir = themesDir(home);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${theme.id}.json`);
  if (existsSync(file)) {
    const existing = parseUserThemeFile(file, readFileSync(file, "utf8"));
    if (existing.ok && existing.theme.id !== theme.id) {
      // The file on disk claims a different id — a name collision with an
      // unrelated theme; never silently clobber it.
      throw new Error(`${file}: already holds theme "${existing.theme.id}" — refusing to overwrite with "${theme.id}"`);
    }
  }
  // Atomic-ish write: temp file + rename, so a crash can't truncate.
  const tmp = join(dir, `.${theme.id}.json.tmp`);
  writeFileSync(tmp, JSON.stringify(theme, null, 2) + "\n");
  renameSync(tmp, file);
}

/** Deletes a theme file; returns whether it existed. */
export function deleteUserTheme(home: string, id: string): boolean {
  const file = join(themesDir(home), `${id}.json`);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}

export type ThemeRef = string; // built-in preset id or `user:<id>` (user-config narrows it)

/** Reconstructs which base preset a theme file extends (the loader doesn't
 * keep it on the resolved Theme). Falls back to tokyo-night. */
export function guessExtendsOf(home: string, id: string): string {
  try {
    const raw = JSON.parse(readFileSync(join(themesDir(home), `${id}.json`), "utf8")) as { extends?: string };
    return raw.extends && raw.extends in THEMES ? raw.extends : "tokyo-night";
  } catch {
    return "tokyo-night";
  }
}

export interface ResolvedTheme {
  theme: Theme;
  /** Ref actually in effect after fallbacks (`user:<id>` collapses to the
   * built-in id when the user theme is unavailable). */
  ref: string;
  /** Visible error when the configured ref could not be honored. */
  error?: string;
}

const DEFAULT_REF: ThemeRef = DEFAULT_THEME;

/** Resolves a config `theme` value to a live Theme. Built-in ids resolve
 * directly; `user:<id>` loads from the themes directory with fallback to
 * the theme's `extends` base preset, then to the default theme — always
 * with a visible error naming the path and cause (#749: TUI startup never
 * breaks on a bad theme file, and no "last good theme" is tracked). */
export function resolveThemeRef(home: string, ref: ThemeRef | undefined): ResolvedTheme {
  if (!ref) return { theme: THEMES[DEFAULT_THEME], ref: DEFAULT_REF };
  if (ref.startsWith("user:")) {
    const id = ref.slice("user:".length);
    const file = join(themesDir(home), `${id}.json`);
    const theme = loadUserTheme(home, id);
    if (theme) return { theme, ref };
    // Fallback to the file's declared base preset even when the file's
    // colors don't validate — the extends id is often still trustworthy.
    let extendsBase: string | null = null;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { extends?: unknown };
      if (typeof raw.extends === "string" && raw.extends in THEMES) extendsBase = raw.extends;
    } catch {
      // unreadable: fall through to the default-theme fallback below
    }
    if (extendsBase) {
      return {
        theme: THEMES[extendsBase as keyof typeof THEMES],
        ref: extendsBase,
        error: `theme ${ref} is invalid — using base preset "${extendsBase}" (${file})`,
      };
    }
    return {
      theme: THEMES[DEFAULT_THEME],
      ref: DEFAULT_REF,
      error: `theme ${ref} could not be loaded — using default "${DEFAULT_THEME}" (${file})`,
    };
  }
  if (ref in THEMES) return { theme: THEMES[ref as keyof typeof THEMES], ref };
  return {
    theme: THEMES[DEFAULT_THEME],
    ref: DEFAULT_REF,
    error: `unknown theme "${ref}" — using default "${DEFAULT_THEME}"`,
  };
}
