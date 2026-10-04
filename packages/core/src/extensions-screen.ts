/**
 * #1131: the read-only `/extensions` state — one fold over one session's
 * event log, the same discipline as the session analysis report (#767):
 * metadata only (names, versions, paths, capability strings, failure
 * reasons), never message content, tool outputs or reasoning. The fold is
 * the headless door — every fact here is derivable from events alone; a
 * live client (the TUI) may additionally merge what only the running
 * runtime knows (source file, declared capabilities, registered commands)
 * through `mergeExtensionLiveInfo`. Returns an explicit `{ error }` on an
 * unreadable or empty log — never throws, never a silent fallback
 * (ADR-0005 discipline). Read-only: it opens through the same store seam
 * as every other reader and disposes immediately.
 */
import type { AgentEvent } from "./types";
import { activePath } from "./session/event-log";
import { SessionStore } from "./session-store";

/** One prompt section an extension currently owns (ADR-0054): the
 * composition in force, replayed from `prompt_override` chrome events. */
export interface ExtensionsScreenSection {
  section: string;
  version: string;
  mode: "replaced" | "hidden";
}

/** One enabled extension as the screen lists it. */
export interface ExtensionsScreenExtension {
  name: string;
  /** The latest `extension_loaded` version (a hot-reload re-records it). */
  version: string;
  /** Source file when loaded from a path; undefined for bundled code
   * (ADR-0039). Fold-only state leaves it undefined; the live merge
   * fills it. */
  file?: string;
  /** The capabilities the code declared (ADR-0053). Not in the log: the
   * fold leaves it empty, the live merge fills it. */
  capabilities: readonly string[];
  /** ADR-0062 (#1130): registered slash commands. Same fold/merge split
   * as `capabilities`. */
  commands: readonly { name: string; description: string }[];
  /** ADR-0062 (#1132): registered rail panel names, folded from
   * `extension_loaded` and refined by the live merge (description,
   * max-height). Names only in a headless fold — the rendering itself is
   * never reconstructed (visible absence, never a mock). */
  panels: readonly (string | { name: string; description: string; maxHeight?: number })[];
  /** ADR-0062 (#1132): registered overlay names, same fold/merge split. */
  overlays: readonly (string | { name: string; description: string })[];
  /** Sections this extension currently owns (ADR-0054), in section order. */
  sections: ExtensionsScreenSection[];
  /** The last `extension_failed` record naming this extension, with the
   * count of all of them — a non-answer is absence, never authority
   * (ADR-0056), but it is never silent either. */
  lastFailure?: { reason: string; message: string };
  failureCount: number;
}

/** One refused registration visible on the screen (ADR-0062): the reason
 * text as the runtime recorded it. */
export interface ExtensionsScreenRefusal {
  extension: string;
  message: string;
}

/** The `extension_failed` reasons that are registration refusals — the
 * ones `/extensions` lists as "refused registrations" (ADR-0062). */
const REFUSAL_REASONS = new Set(["command_refused", "panel_refused", "overlay_refused"]);

/** The structured extension state one screen (TUI overlay, headless line)
 * renders. Everything here is derivable from the event log alone. */
export interface ExtensionsScreenState {
  extensions: ExtensionsScreenExtension[];
  refusals: ExtensionsScreenRefusal[];
}

/** Folds one session's extension chrome into the screen state. Pass the
 * full log or the active path — chrome events stay on the path; the fold
 * projects the active path itself so a forked log answers for the branch
 * the head points at, like every other read seam. */
export function extensionsScreenStateFromEvents(events: readonly AgentEvent[]): ExtensionsScreenState {
  const path = activePath(events);
  const byName = new Map<string, ExtensionsScreenExtension>();
  const order: string[] = [];
  /** Section → the extension currently owning it (ADR-0054 replay). */
  const owners = new Map<string, { extension: string; version: string; mode: "replaced" | "hidden" }>();

  const record = (name: string, version: string): ExtensionsScreenExtension => {
    let row = byName.get(name);
    if (!row) {
      row = { name, version, sections: [], failureCount: 0, capabilities: [], commands: [], panels: [], overlays: [] };
      byName.set(name, row);
      order.push(name);
    }
    row.version = version;
    return row;
  };

  for (const event of path) {
    if (event.type === "extension_loaded") {
      const row = record(event.name, event.version);
      // #1132: the registration facts ride the load event; a hot-reload
      // re-records it, so the names track what is in force (replace, not
      // append — the load event is a statement about *now*).
      const names = event as typeof event & { panels?: string[]; overlays?: string[] };
      row.panels = [...(names.panels ?? [])];
      row.overlays = [...(names.overlays ?? [])];
    } else if (event.type === "extension_failed") {
      const row = record(event.name, byName.get(event.name)?.version ?? "");
      row.lastFailure = { reason: event.reason, message: event.message };
      row.failureCount += 1;
    } else if (event.type === "prompt_override") {
      if (event.mode === "restored") {
        const current = owners.get(event.section);
        if (current?.extension === event.extension) owners.delete(event.section);
      } else {
        owners.set(event.section, { extension: event.extension, version: event.version, mode: event.mode });
      }
    }
  }

  // Fold the composition into the owning extensions' rows.
  const sectionNames = [...owners.keys()].sort();
  for (const section of sectionNames) {
    const owner = owners.get(section)!;
    const row = record(owner.extension, owner.version);
    row.sections.push({ section, version: owner.version, mode: owner.mode });
  }

  // Every refused registration is recorded whichever door it came
  // through: commands (#1130), panels/overlays (#1132). The fold is the
  // headless door — a refusal that never reached the log is not listed.
  const refusals: ExtensionsScreenRefusal[] = [];
  for (const event of path) {
    if (event.type === "extension_failed" && REFUSAL_REASONS.has(event.reason)) {
      refusals.push({ extension: event.name, message: event.message });
    }
  }

  return { extensions: order.map((name) => byName.get(name)!), refusals };
}

/** What only the running runtime knows about one instance: not in the
 * log, so a headless fold leaves it out. */
export interface ExtensionLiveInfo {
  name: string;
  /** Source file path for a file-loaded extension; absent = bundled code
   * (ADR-0039: no path, no consent). */
  file?: string;
  /** The capabilities the code declared (ADR-0053): enforcement by
   * absence, so each one is a slot the grant covers. */
  capabilities: readonly string[];
  /** ADR-0062 (#1130): slash commands this instance registered. */
  commands: readonly { name: string; description: string }[];
  /** ADR-0062 (#1132): the rail panel and overlays this instance
   * registered — what only a live client renders. */
  panels: readonly { name: string; description: string; maxHeight?: number }[];
  overlays: readonly { name: string; description: string }[];
}

/** Merges the live runtime facts into a folded state: per extension, the
 * source path, capabilities and registered commands. Live facts never
 * invent a row — an extension the fold does not know (it settled after
 * the log snapshot was taken) is skipped; the caller can refold. */
export function mergeExtensionLiveInfo(state: ExtensionsScreenState, live: readonly ExtensionLiveInfo[]): ExtensionsScreenState {
  const byName = new Map(live.map((l) => [l.name, l]));
  return {
    ...state,
    extensions: state.extensions.map((row) => {
      const info = byName.get(row.name);
      if (!info) return row;
      const merged: ExtensionsScreenExtension = {
        ...row,
        ...(info.file !== undefined ? { file: info.file } : {}),
        capabilities: [...info.capabilities],
        commands: info.commands.map((c) => ({ name: c.name, description: c.description ?? "" })),
        panels: info.panels.map((p) => ({ name: p.name, description: p.description ?? "", ...(p.maxHeight !== undefined ? { maxHeight: p.maxHeight } : {}) })),
        overlays: info.overlays.map((o) => ({ name: o.name, description: o.description ?? "" })),
      };
      return merged;
    }),
  };
}

/** Reads one session file and folds its extension state — the read-only
 * door a client with only a session path uses (the CLI, the TUI when the
 * live session is unknown). Explicit `{ error }` on an unreadable or
 * empty log. */
export function readExtensionsScreenState(file: string): ExtensionsScreenState | { error: string } {
  let events: AgentEvent[];
  try {
    const store = SessionStore.open(file);
    try {
      events = store.load();
    } finally {
      store.dispose();
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (events.length === 0) return { error: `empty session log ${file}` };
  return extensionsScreenStateFromEvents(events);
}
