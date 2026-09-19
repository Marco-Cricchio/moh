/**
 * The skill-suggestion judge (#793): the two-call cookbook per user turn.
 *
 * Call 1 ranks the whole roster plus the `needs_skill` gate; call 2 re-reads
 * at most `SKILL_SUGGEST_KEEP` finalists with their full descriptions. At
 * most ONE suggested skill leaves this judge; every failure, an empty
 * roster, a gate below the floor or no finalist clearing the relevance
 * floor degrade to no suggestion at all — never a guess, never a turn error.
 *
 * Both judgments are recorded (`jev_skill_suggest`), one record per call:
 * the rank record carries the whole roster's probabilities, the relevance
 * record the finalists' answers and the winner. No sampling (ratified).
 */
import type { JevAnswer, JevClient, JevJudgmentMeta } from "./client";
import { noulProbability } from "./client";
import {
  NEEDS_SKILL_MIN,
  SKILL_SUGGEST_KEEP,
  candidatesForRank,
  buildRelevance,
  rankQuestionsFor,
  rankStateFor,
  relevanceQuestionsFor,
  relevanceStateFor,
  type SkillCandidate,
} from "./skills";

export interface SkillSuggestJudgeDeps {
  client: Pick<JevClient, "judge">;
  /**
   * The one log seam: the extension turns this into `ctx.appendEvent`
   * (`jev_skill_suggest`). Required — no sampling.
   */
  append: (payload: Record<string, unknown>) => void;
}

/** What one suggest() produced. `undefined` = no suggestion (any reason). */
export interface SkillSuggestVerdict {
  /** The suggested skill name. */
  readonly skill: string;
  /** The exact prompt line contributed through `setPromptNote`. */
  readonly line: string;
}

/** Builds the per-turn skill-suggestion judge. Stateless across turns. */
export function createSkillSuggestJudge(deps: SkillSuggestJudgeDeps) {
  return {
    /**
     * Runs the two-call cookbook for one turn.
     * `null` = no suggestion (call failure, empty roster, gate or relevance
     * below the floors, or a call-2 washout). The roster must be non-empty;
     * the task text is the same slice shape as classification's (capped).
     */
    async suggest(task: string, roster: readonly SkillCandidate[]): Promise<SkillSuggestVerdict | null> {
      const candidates = candidatesForRank(roster);
      if (candidates.length === 0) return null;

      // ---- Call 1: rank the whole roster + the needs-skill gate --------
      let needsSkill: number | undefined;
      let ranked: { name: string; probability: number }[] = [];
      let rankAnswers: Record<string, JevAnswer> | undefined;
      let rankMeta: JevJudgmentMeta | undefined;
      const rankOutcome = await deps.client.judge({
        state: rankStateFor({ task, roster: candidates }),
        questions: rankQuestionsFor(candidates),
        record: (answers, meta) => {
          needsSkill = noulProbability(answers, "needs_skill");
          ranked = candidates
            .map((c) => ({ name: c.name, probability: noulProbability(answers, `skill:${c.name}`) }))
            .sort((a, b) => b.probability - a.probability);
          rankAnswers = answers;
          rankMeta = meta;
          // The rank record is complete on its own; nothing to append here.
          return null;
        },
      });
      if (!rankOutcome.ok || needsSkill === undefined) {
        deps.append({ useCase: "skill_suggest", call: "rank", ok: false, kind: rankOutcome.ok ? "no-answer" : rankOutcome.kind, skills: candidates.length });
        return null;
      }
      deps.append({
        useCase: "skill_suggest",
        call: "rank",
        ok: true,
        needsSkill,
        gated: needsSkill < NEEDS_SKILL_MIN,
        skills: candidates.length,
        top: ranked.slice(0, SKILL_SUGGEST_KEEP).map((r) => ({ name: r.name, probability: r.probability })),
        answers: rankAnswers,
        model: rankMeta?.model,
        latencyMs: rankMeta?.latencyMs,
        usage: rankMeta?.usage,
      });
      if (needsSkill < NEEDS_SKILL_MIN) return null;

      // ---- Call 2: re-read the top finalists ----------------------------
      const finalists = ranked.slice(0, SKILL_SUGGEST_KEEP).filter((r) => r.probability > 0);
      if (finalists.length === 0) return null;
      const byName = new Map(candidates.map((c) => [c.name, c]));
      const finalistSkills = finalists.map((f) => byName.get(f.name)).filter((s) => s !== undefined);
      let relevance: string | undefined;
      let relevanceAnswers: Record<string, JevAnswer> | undefined;
      let relevanceMeta: JevJudgmentMeta | undefined;
      const relOutcome = await deps.client.judge({
        state: relevanceStateFor({ task, roster: finalistSkills }),
        questions: relevanceQuestionsFor(finalists.map((f) => f.name)),
        record: (answers, meta) => {
          relevanceAnswers = answers;
          relevanceMeta = meta;
          relevance = buildRelevance(
            finalists.map((f) => ({ name: f.name, probability: noulProbability(answers, `relevance:${f.name}`) })),
            needsSkill,
          );
          return null;
        },
      });
      if (!relOutcome.ok || relevance === undefined) {
        deps.append({
          useCase: "skill_suggest",
          call: "relevance",
          ok: false,
          kind: relOutcome.ok ? "no-winner" : relOutcome.kind,
          finalists: finalists.map((f) => f.name),
        });
        return null;
      }
      const winner = [...finalists]
        .map((f) => ({ name: f.name, probability: noulProbability(relevanceAnswers!, `relevance:${f.name}`) }))
        .sort((a, b) => b.probability - a.probability)[0]!;
      deps.append({
        useCase: "skill_suggest",
        call: "relevance",
        ok: true,
        suggested: winner.name,
        line: relevance,
        finalists: finalists.map((f) => f.name),
        answers: relevanceAnswers,
        model: relevanceMeta?.model,
        latencyMs: relevanceMeta?.latencyMs,
        usage: relevanceMeta?.usage,
      });
      return { skill: winner.name, line: relevance };
    },
  };
}

export type SkillSuggestJudge = ReturnType<typeof createSkillSuggestJudge>;
