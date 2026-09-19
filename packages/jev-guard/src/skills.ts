/**
 * The Jev skill suggestion use case (#793): at most ONE suggested skill per
 * turn, following the official TypeSafe cookbook's two-call pattern.
 *
 * Golden rule (TypeSafe skill guidance): a use case's questions AND its
 * thresholds live in ONE file, co-written with the owner and revised as
 * configuration — never scattered through the logic. This module is that
 * single home for the skill-suggestion check.
 *
 * Ratified shape (vision note 35 #9, issue #793):
 * - call 1 ranks the WHOLE roster (one noul per skill — never an aggregated
 *   Score, the note-35 calibration lesson) and answers `needs_skill`:
 *   "does this turn need a skill at all?". A `needs_skill` below
 *   `NEEDS_SKILL_MIN` short-circuits — no second call, no suggestion;
 * - call 2 re-reads the top `SKILL_SUGGEST_KEEP` finalists with their full
 *   descriptions and one relevance noul each; the strongest answer at or
 *   above `SKILL_RELEVANCE_MIN` wins;
 * - the roster is bundled first-party + user skills (the core's discovery
 *   already merges both; the winner rides the ADR-0036 `turn_notes`
 *   section, so the roster itself never enters the prompt);
 * - at most one suggestion: any call failure, an empty roster or a verdict
 *   below the floor all degrade to NO line — never a guess.
 */
import type { JevQuestion } from "./client";
import { questions } from "./questions-core";
import { truncateToBytes } from "./routing";

/**
 * Ratified thresholds (code constants in v1, tuned on data, never config).
 * NEEDS_SKILL_MIN: the call-1 gate — below this the turn gets no skill
 *   judgment at all. SKILL_SUGGEST_KEEP: how many finalists call 2 re-reads.
 *   SKILL_RELEVANCE_MIN: the per-skill floor a winner must clear.
 *   SKILLS_RANK_MAX: the cap on a single rank request (same bound as the
 *   rerank fan-out; the rest of the roster is dropped from consideration).
 */
export const SKILL_THRESHOLDS = {
  needsSkillMin: 0.6,
  keep: 3,
  relevanceMin: 0.6,
  rankMax: 30,
} as const;

export const NEEDS_SKILL_MIN = SKILL_THRESHOLDS.needsSkillMin;
export const SKILL_SUGGEST_KEEP = SKILL_THRESHOLDS.keep;
export const SKILL_RELEVANCE_MIN = SKILL_THRESHOLDS.relevanceMin;
export const SKILLS_RANK_MAX = SKILL_THRESHOLDS.rankMax;

/** The judged state: the task plus the roster, capped like the other per-turn states. */
export const SKILL_MESSAGE_MAX_BYTES = 4096;

/** One skill in the roster, as the suggestion call sees it. */
export interface SkillCandidate {
  readonly name: string;
  readonly description: string;
}

/**
 * The roster the judge ranks: the session's own skill index (bundled
 * first-party + user skills, project wins on clash), capped. An empty
 * roster short-circuits the whole use case — no roster, no call.
 */
export function candidatesForRank(roster: readonly SkillCandidate[]): SkillCandidate[] {
  return roster.slice(0, SKILLS_RANK_MAX);
}

/** The roster rendered for the state: one `- name: description` line per skill. */
export function rosterFromIndex(roster: readonly SkillCandidate[]): string {
  return roster.map((s) => `- ${s.name}: ${s.description}`).join("\n");
}

const NEEDS_SKILL_INSTRUCTIONS =
  "Does answering this message benefit from loading one of the listed skills (a reusable instruction bundle), rather than answering directly?";

const RANK_INSTRUCTIONS =
  "Could this skill plausibly be the right one for the request above? Judge only from its name and description.";

const RELEVANCE_INSTRUCTIONS =
  "Read the request above and this skill's full description. Is this skill genuinely the right one to load before answering? Answer from the fit, not the name.";

/**
 * Call 1's question map: one noul per roster entry (ids `skill:<name>`,
 * same instructions for every question — the roster differs; the task is
 * the state) plus the turn-level `needs_skill` gate.
 */
export function rankQuestionsFor(roster: readonly SkillCandidate[]): Record<string, JevQuestion> {
  const out: Record<string, JevQuestion> = {
    needs_skill: questions.noul(NEEDS_SKILL_INSTRUCTIONS, {
      true: "one of the listed skills likely fits",
      false: "answer directly, no skill needed",
    }),
  };
  for (const skill of roster) {
    out[`skill:${skill.name}`] = questions.noul(RANK_INSTRUCTIONS, {
      true: "plausibly the right skill",
      false: "not a fit for this request",
    });
  }
  return out;
}

/** Call 1's state: the task plus the rendered roster, truncated. */
export function rankStateFor(input: { task: string; roster: readonly SkillCandidate[] }): string {
  return truncateToBytes(`Request:\n${input.task}\n\nAvailable skills:\n${rosterFromIndex(input.roster)}`, SKILL_MESSAGE_MAX_BYTES);
}

/** Call 2's question map: one relevance noul per finalist (ids `relevance:<name>`). */
export function relevanceQuestionsFor(finalists: readonly string[]): Record<string, JevQuestion> {
  const out: Record<string, JevQuestion> = {};
  for (const name of finalists) {
    out[`relevance:${name}`] = questions.noul(RELEVANCE_INSTRUCTIONS, {
      true: "this is the skill to load",
      false: "not the right skill after a closer look",
    });
  }
  return out;
}

/** Call 2's state: the task plus the finalists' full descriptions. */
export function relevanceStateFor(input: { task: string; roster: readonly SkillCandidate[] }): string {
  return truncateToBytes(`Request:\n${input.task}\n\nCandidate skills:\n${rosterFromIndex(input.roster)}`, SKILL_MESSAGE_MAX_BYTES);
}

/** The winner line, or `undefined` when nothing clears the floor. */
const WINNER_LINE = (name: string) =>
  `This request looks like a fit for the \`${name}\` skill — load its SKILL.md before acting.`;

export interface RankedSkill {
  readonly name: string;
  readonly probability: number;
}

/**
 * Reads the call-2 answers into at most one suggestion: the strongest
 * finalist at or above `SKILL_RELEVANCE_MIN`. `needsSkill` (call 1's gate)
 * must also have cleared its floor when provided — a turn that does not
 * need a skill gets none even if a finalist squeaked past. Two finalists
 * above the floor yield the stronger one, never two lines.
 */
export function buildRelevance(ranked: readonly RankedSkill[], needsSkill?: number): string | undefined {
  if (needsSkill !== undefined && needsSkill < NEEDS_SKILL_MIN) return undefined;
  const winner = [...ranked].sort((a, b) => b.probability - a.probability)[0];
  if (!winner || winner.probability < SKILL_RELEVANCE_MIN) return undefined;
  return WINNER_LINE(winner.name);
}
