import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Message } from "./types";

/**
 * PromptComposer (#27): the core assembles the system prompt for every
 * model call as typed TS sections in a fixed order. No template language:
 * each section is a plain function `(ctx) => string`, reassembled each call.
 */

/** Fixed section order; the assembled prompt always follows this sequence. */
export const SECTION_ORDER = [
  "base",
  "environment",
  "tools",
  "skills",
  "memory",
  "session_state",
  "extension_notes",
] as const;

export type SectionName = (typeof SECTION_ORDER)[number];

/** Index entry for one skill: name—description only (progressive disclosure). */
export interface SkillIndexEntry {
  name: string;
  description: string;
}

/** Everything a section may read. Pure data; deterministic for equal inputs. */
export interface PromptContext {
  cwd: string;
  platform: string;
  now: Date;
  /** Active route (`endpoint/model-id`), when routing is configured. */
  route?: string;
  /** Active model identifier (e.g. the provider's model). */
  model?: string;
  tools: { name: string; description: string }[];
  skills: SkillIndexEntry[];
  /** Durable memory excerpt injected as a section (P1 feature; optional). */
  memory?: string;
  /** Current session-state summary (compaction, todo snapshot; optional). */
  sessionState?: string;
  /** Trailing notes appended by extensions (append-only; hooks land later). */
  extensionNotes?: string[];
}

export type SectionRenderer = (ctx: PromptContext) => string;

/** The assembled, read-only prompt view handed to hooks and hashing. */
export interface AssembledPrompt {
  /** Non-empty sections in SECTION_ORDER, keyed by name. */
  readonly sections: Readonly<Partial<Record<SectionName, string>>>;
  /** The full system prompt (non-empty sections joined by blank lines). */
  readonly system: string;
  /** sha256-based hash of `system`; recorded as `promptVersion` in session_start. */
  readonly version: string;
}

/**
 * Read-only view exposed to a `beforeModelCall`-compatible hook.
 * Types only in v1; extension hooks land in a later ticket.
 */
export interface BeforeModelCallContext {
  readonly prompt: AssembledPrompt;
  readonly messages: readonly Message[];
}

export type BeforeModelCallHook = (ctx: BeforeModelCallContext) => void | Promise<void>;

/** Default combined character budget for AGENTS.md + CONTEXT.md. */
export const DEFAULT_INSTRUCTIONS_BUDGET = 20_000;

/** The shipped base prompt. English; replies follow the user's language. */
export const BASE_PROMPT = [
  "You are moh, a provider-agnostic coding agent working inside the user's project.",
  "",
  "Core behavior:",
  "- Be concise and direct; prefer working code over prose.",
  "- Use the available tools to inspect and modify the project; never guess file contents.",
  "- Follow the project instructions below when they do not conflict with these rules.",
  "- Reply in the user's language.",
].join("\n");

export interface PromptComposerConfig {
  /** User-level moh dir (`~/.moh`). Default: `<homedir>/.moh`. */
  mohHome?: string;
  /** Project root; instructions files and `.moh/prompts/` are read from here. */
  projectDir?: string;
  /** Combined character budget for injected instruction files. */
  budget?: number;
  /** Full replacement of the shipped base prompt text (file override wins). */
  basePrompt?: string;
  /** Per-section renderer overrides, for tests and downstream composition. */
  sections?: Partial<Record<SectionName, SectionRenderer>>;
}

function readIfExists(file: string): string | null {
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8");
}

/**
 * Assembles the system prompt. Section content comes from typed TS
 * functions; file-based inputs (instructions, base-prompt override) are
 * read at compose time so every model call sees current files.
 */
export class PromptComposer {
  readonly #projectDir: string;
  readonly #mohHome: string;
  readonly #budget: number;
  readonly #basePrompt: string;
  readonly #overrides: Partial<Record<SectionName, SectionRenderer>>;

  constructor(config: PromptComposerConfig = {}) {
    this.#projectDir = config.projectDir ?? process.cwd();
    this.#mohHome = config.mohHome ?? join(homedir(), ".moh");
    this.#budget = config.budget ?? DEFAULT_INSTRUCTIONS_BUDGET;
    this.#basePrompt = config.basePrompt ?? BASE_PROMPT;
    this.#overrides = config.sections ?? {};
  }

  /** The section table in fixed order. Each section: `(ctx) => string`. */
  get sections(): Record<SectionName, SectionRenderer> {
    const table: Record<SectionName, SectionRenderer> = {
      base: (ctx) => this.#renderBase(ctx),
      environment: (ctx) => this.#renderEnvironment(ctx),
      tools: (ctx) => this.#renderTools(ctx),
      skills: (ctx) => this.#renderSkills(ctx),
      memory: (ctx) => (ctx.memory ? `## Memory\n\n${ctx.memory}` : ""),
      session_state: (ctx) => (ctx.sessionState ? `## Session state\n\n${ctx.sessionState}` : ""),
      extension_notes: (ctx) =>
        ctx.extensionNotes?.length ? `## Extension notes\n\n${ctx.extensionNotes.join("\n\n")}` : "",
    };
    return { ...table, ...this.#overrides };
  }

  /** Assembles all sections in fixed order; empty sections are omitted. */
  compose(ctx: PromptContext): AssembledPrompt {
    const renderers = this.sections;
    const sections: Partial<Record<SectionName, string>> = {};
    for (const name of SECTION_ORDER) {
      const text = renderers[name](ctx).trim();
      if (text) sections[name] = text;
    }
    const system = SECTION_ORDER.filter((n) => n in sections)
      .map((n) => sections[n])
      .join("\n\n");
    return { sections, system, version: hashPrompt(system) };
  }

  #renderBase(_ctx: PromptContext): string {
    const base = this.#basePromptOverride() ?? this.#basePrompt;
    const instructions = this.#renderInstructions();
    return instructions ? `${base}\n\n${instructions}` : base;
  }

  /** Full base-prompt file override: `.moh/prompts/system.md` < `~/.moh/prompts/`, project wins. */
  #basePromptOverride(): string | null {
    return (
      readIfExists(join(this.#projectDir, ".moh", "prompts", "system.md")) ??
      readIfExists(join(this.#mohHome, "prompts", "system.md"))
    );
  }

  /** AGENTS.md (or CLAUDE.md, silent fallback) + CONTEXT.md, capped with a truncation notice.
   * The budget caps the combined file *content*; headings do not count. */
  #renderInstructions(): string {
    const files: { heading: string; content: string }[] = [];
    const agents = readIfExists(join(this.#projectDir, "AGENTS.md"));
    const claude = agents ? null : readIfExists(join(this.#projectDir, "CLAUDE.md")); // silent fallback
    if (agents) files.push({ heading: "### Project instructions (AGENTS.md)", content: agents.trim() });
    if (claude) files.push({ heading: "### Project instructions (CLAUDE.md)", content: claude.trim() });
    const context = readIfExists(join(this.#projectDir, "CONTEXT.md"));
    if (context) files.push({ heading: "### Domain context (CONTEXT.md)", content: context.trim() });
    if (files.length === 0) return "";
    const total = files.reduce((n, f) => n + f.content.length, 0);
    let remaining = total <= this.#budget ? Infinity : this.#budget;
    const blocks: string[] = [];
    for (const f of files) {
      const content = remaining === Infinity ? f.content : f.content.slice(0, remaining);
      remaining -= f.content.length;
      blocks.push(`${f.heading}\n\n${content}`);
    }
    if (total > this.#budget) {
      blocks.push(`[truncated: project instructions exceed the ${this.#budget} character budget]`);
    }
    return blocks.join("\n\n");
  }

  #renderEnvironment(ctx: PromptContext): string {
    const lines = [
      "## Environment",
      "",
      `- Working directory: ${ctx.cwd}`,
      `- Platform: ${ctx.platform}`,
      `- Date: ${ctx.now.toISOString().slice(0, 10)}`,
      `- Route: ${ctx.route ?? "(unset)"}`,
      `- Model: ${ctx.model ?? "(unset)"}`,
    ];
    return lines.join("\n");
  }

  #renderTools(ctx: PromptContext): string {
    const lines = ["## Tools", ""];
    for (const tool of ctx.tools) lines.push(`- ${tool.name}: ${tool.description}`);
    return lines.join("\n");
  }

  #renderSkills(ctx: PromptContext): string {
    if (ctx.skills.length === 0) return "";
    const lines = ["## Skills", "", "Load a skill's full instructions with the read tool when needed.", ""];
    for (const skill of ctx.skills) lines.push(`- ${skill.name} — ${skill.description}`);
    return lines.join("\n");
  }
}

/** Stable prompt hash: sha256 of the assembled system, first 16 hex chars. */
export function hashPrompt(system: string): string {
  return createHash("sha256").update(system).digest("hex").slice(0, 16);
}
