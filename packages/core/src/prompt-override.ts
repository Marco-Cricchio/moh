/**
 * ADR-0054 (#1129): the application half of prompt-section replacement.
 *
 * The runtime dispatch decides only who beat the 5 s window; this module
 * turns the winning replacements into the composition that actually serves
 * the call — capability enforcement by absence, one author per section,
 * the provenance line the core writes at the head of a replaced section,
 * `null` = hidden — and produces the `prompt_override` chrome records for
 * whatever changed against the composition previously in force.
 *
 * The core always keeps the text it composed itself: the composer re-runs
 * at every assembly, so a replacement is a per-call projection here, never
 * stored state — nothing to revoke, nothing to invalidate.
 */
import { SECTION_ORDER, type SectionName } from "./prompt-composer";
import type { AgentEvent } from "./types";

/** The six data sections an extension may replace; `base` and the
 * instruction files are moh's identity and the user's words, the two note
 * sections are the extension channel itself. A section added to
 * SECTION_ORDER later defaults to not replaceable (ADR-0054). */
export const REPLACEABLE_SECTIONS: readonly SectionName[] = [
  "environment",
  "tools",
  "skills",
  "memory",
  "session_state",
  "mpm",
];

/** The capability slot that covers one section (ADR-0053 scope): declared
 * in the consented code, signed in the manifest, named in the consent
 * question, and judged here at every application. */
export function replaceSectionCapability(section: string): string {
  return `replace-prompt-section:${section}`;
}

/** One author's winning replacements, as stamped by the dispatch. */
export interface ReplacementAuthor {
  readonly by: string;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly sections: Partial<Record<string, string | null>>;
}

/** A contribution in force: who owns which section, and how. */
export interface PromptContribution {
  readonly section: SectionName;
  readonly extension: string;
  readonly version: string;
  readonly mode: "replaced" | "hidden";
}

export interface PromptOverrideApplication {
  /** The effective sections: core text with replacements applied and
   * hidden sections omitted. */
  readonly sections: Partial<Record<SectionName, string>>;
  /** The effective system prompt (same join rule as the composer). */
  readonly system: string;
  /** The contributions now in force, in section order. */
  readonly contributions: readonly PromptContribution[];
  /** The visible refusals: ungranted, non-replaceable, contested. */
  readonly refusals: AgentEvent[];
}

/**
 * Applies the dispatch's replacements to the core's own assembled
 * sections. `skillsProtected` reports the ADR-0011 turn-scoped skill
 * prompt: it keeps its precedence over `skills`, so while it is in force
 * a replacement for `skills` is refused that call (the core is the
 * section's author for the turn).
 */
export function applyPromptReplacements(
  base: Partial<Record<SectionName, string>>,
  authors: readonly ReplacementAuthor[],
  options: { skillsProtected?: boolean } = {},
): PromptOverrideApplication {
  const refusals: AgentEvent[] = [];
  const applied = new Map<SectionName, PromptContribution>();
  const sections: Partial<Record<SectionName, string>> = { ...base };
  for (const author of authors) {
    for (const [section, value] of Object.entries(author.sections)) {
      if (!REPLACEABLE_SECTIONS.includes(section as SectionName)) {
        refusals.push({
          type: "extension_failed",
          name: author.by,
          reason: "section_not_replaceable",
          message: `section "${section}" is not replaceable (ADR-0054: only ${REPLACEABLE_SECTIONS.join(", ")})`,
        });
        continue;
      }
      const name = section as SectionName;
      if (name === "skills" && options.skillsProtected) {
        refusals.push({
          type: "extension_failed",
          name: author.by,
          reason: "section_protected",
          message: "the skills section is held by the turn-scoped skill prompt this turn (ADR-0011)",
        });
        continue;
      }
      if (!author.capabilities.includes(replaceSectionCapability(name))) {
        refusals.push({
          type: "extension_failed",
          name: author.by,
          reason: "section_not_granted",
          message: `no capability grant for section "${name}" (${replaceSectionCapability(name)} must be declared and consented)`,
        });
        continue;
      }
      if (applied.has(name)) {
        refusals.push({
          type: "extension_failed",
          name: author.by,
          reason: "section_contested",
          message: `section "${name}" already has an author in this composition; one author per section (ADR-0054)`,
        });
        continue;
      }
      if (value === null) {
        delete sections[name];
        applied.set(name, { section: name, extension: author.by, version: author.version, mode: "hidden" });
        continue;
      }
      if (typeof value !== "string") {
        refusals.push({
          type: "extension_failed",
          name: author.by,
          reason: "invalid_section",
          message: `section "${name}" replacement must be a string or null`,
        });
        continue;
      }
      sections[name] = `[extension: ${author.by} v${author.version} — section replaced]\n\n${value}`;
      applied.set(name, { section: name, extension: author.by, version: author.version, mode: "replaced" });
    }
  }
  const contributions = SECTION_ORDER.flatMap((section) => {
    const c = applied.get(section);
    return c ? [c] : [];
  });
  const system = SECTION_ORDER.filter((n) => n in sections)
    .map((n) => sections[n])
    .join("\n\n");
  return { sections, system, contributions, refusals };
}

/**
 * The `prompt_override` records for one application, diffed against the
 * contributions previously in force: one event per changed section —
 * replaced or hidden, restored when a section returns to core text. The
 * words never ride the event (see the type's contract).
 */
export function promptOverrideEvents(
  previous: ReadonlyMap<SectionName, PromptContribution>,
  application: PromptOverrideApplication,
): AgentEvent[] {
  const events: AgentEvent[] = [];
  const now = new Map(application.contributions.map((c) => [c.section, c]));
  for (const [section, before] of previous) {
    const after = now.get(section);
    if (after) continue;
    events.push({
      type: "prompt_override",
      section,
      extension: before.extension,
      version: before.version,
      mode: "restored",
    });
  }
  for (const after of now.values()) {
    const before = previous.get(after.section);
    if (before && before.extension === after.extension && before.version === after.version && before.mode === after.mode) {
      continue;
    }
    events.push({ type: "prompt_override", ...after });
  }
  return events;
}
