/**
 * The compaction cut judge (#792, spec §5; #979): turns the runner's
 * section list into one drop set — one Jev call per section, their
 * previews never whole bodies — plus the ONE aggregate record per
 * compaction (`jev_judgment`, `useCase: "compact-cut"`, with what was
 * offered, what was judged, every judged section's verdict, the dropped
 * ids, the byte sizes before/after and `keptByFloor`).
 *
 * #979: the span is exactly what grows until compaction runs, so this
 * judge is bounded on both axes the span used to blow:
 *
 * - **Calls.** Sections run with a bounded concurrency, largest body
 *   first, inside the hook's own window (`hookTimeoutMs`), cut short by an
 *   abort signal the runtime fires when it gives up. A span that does not
 *   fit is judged as far as it goes and says so (`unjudged` +
 *   `unjudgedReason`) — never the old silent no-op after ~18 sections.
 * - **Records.** ONE aggregate per compaction carries every verdict; the
 *   old one-record-per-section shape is what flooded the per-turn event
 *   cap (50 events/turn) on its own. The judged set is capped
 *   (`SECTION_BUDGET`) so that one record stays inside the runtime's 8 KiB
 *   payload cap — a declared budget, not a silent sample: the aggregate
 *   names what was offered and what was judged.
 *
 * Fail-open throughout (ratified degradation model): a call that fails
 * produces no judgment for that section — the section stays, and moh
 * compacts exactly as it would without Jev. The one `∅ jev offline`
 * signal is the only trace. The core's 60% survival floor is applied
 * after this judge, by the core, and reported back through `onApplied` so
 * the aggregate record can carry it — including the honest `discarded`
 * outcome when the cut never reached the runner.
 */
import type { AppliedCut } from "@moh/extension";
import { noulProbability, type JevAnswer, type JevClient, type JevJudgmentMeta } from "./client";
import {
  COMPACTION_CUT_QUESTIONS,
  COMPACTION_CUT_THRESHOLDS,
  type CompactionCutSectionVerdict,
} from "./compaction";

/** The section shape the core hands over (`@moh/extension`'s view). */
export interface JudgedSection {
  readonly id: string;
  readonly kind: "assistant" | "tool_result" | "tool_call";
  readonly bytes: number;
  readonly preview: string;
}

export interface CompactionJudgeDeps {
  client: Pick<JevClient, "judge">;
  /**
   * The one log seam: the extension turns this into `ctx.appendEvent`
   * (`jev_judgment`). Required — a judgment nobody recorded is a judgment
   * nobody can audit (ratified: no sampling).
   */
  append: (payload: Record<string, unknown>) => void;
}

/**
 * #979: how many sections one compaction judges. The section count is what
 * a long session makes unbounded, and the one aggregate record carries a
 * verdict per judged section (~80 B each): this keeps that record well
 * inside the runtime's 8 KiB per-event payload cap for any span, at a
 * worst case of this many Jev calls. Which sections are left out is
 * *declared* in the record (`unjudged`, `unjudgedReason: "budget"`), and
 * the largest bodies — where the droppable bytes are — are judged first.
 */
export const COMPACTION_JUDGE_SECTION_BUDGET = 60;

/** #979: how many section calls may be in flight at once. The per-section
 * latency is unchanged; what shrinks is the number of sequential waves a
 * 70-section span needs (70/8 instead of 70) — the difference between
 * fitting the hook window and blowing it ~13 s in. */
export const COMPACTION_JUDGE_CONCURRENCY = 8;

/** #979: the window assumed when the runtime does not tell us one
 * (apiVersion < 1.9). It matches the core's default hook timeout: budgeting
 * against a smaller window than the real one only costs coverage. */
export const COMPACTION_JUDGE_DEFAULT_WINDOW_MS = 5_000;

/** #979: how much of the hook window is left unused, so the answer — and
 * the aggregate record — still lands before the runtime stops waiting. */
export const COMPACTION_JUDGE_WINDOW_MARGIN_MS = 250;

/** Why offered sections carry no verdict. */
export type CompactionUnjudgedReason = "budget" | "deadline" | "abandoned";

/** What one dispatch produced: the ids to drop, and the core's callback. */
export interface CompactionCutRun {
  /** Section ids the judgment says are droppable (the core still floors). */
  readonly drop: string[];
  /**
   * The one aggregate record per compaction, written when the outcome is
   * known — including `applied: false`, when the dispatch was abandoned
   * and this cut reached nothing (#979). Called at most once: the callback
   * is its own guard.
   */
  readonly onApplied: (applied: AppliedCut) => void;
}

/** One judged section, with the position it was offered at. */
interface Judged {
  readonly section: JudgedSection;
  readonly index: number;
  readonly verdict: CompactionCutSectionVerdict;
  readonly meta: JevJudgmentMeta;
}

/** The state one section is judged from: its shape, never its body. */
function stateFor(section: JudgedSection): string {
  return [`section kind: ${section.kind}`, `size: ${section.bytes} bytes`, `preview: ${section.preview}`].join("\n");
}

/**
 * The compact per-section verdict line. The preview that was judged stays
 * out — it is the judge's *input*, and its size is what the one record
 * cannot afford — while every field that decides a drop stays in (id,
 * kind, bytes, decision, probability).
 */
function verdictLine(entry: Judged): Record<string, unknown> {
  return {
    id: entry.section.id,
    kind: entry.section.kind,
    bytes: entry.section.bytes,
    decision: entry.verdict.decision,
    droppable: entry.verdict.droppable,
  };
}

/**
 * Builds the per-dispatch judge. Stateless by design: compaction runs at
 * most once per covered span, so there is nothing to cache.
 */
export function createCompactionJudge(deps: CompactionJudgeDeps) {
  return {
    /**
     * Judges the offered sections inside the hook's window. Never throws;
     * a failed call leaves its section out of the drop set (fail-open,
     * section by section). The returned `onApplied` writes the ONE
     * aggregate record once the core reports the outcome.
     */
    async judge(
      sections: readonly JudgedSection[],
      options: { hookTimeoutMs?: number; signal?: AbortSignal } = {},
    ): Promise<CompactionCutRun> {
      const started = Date.now();
      const windowMs = options.hookTimeoutMs ?? COMPACTION_JUDGE_DEFAULT_WINDOW_MS;
      const margin = Math.min(COMPACTION_JUDGE_WINDOW_MARGIN_MS, Math.max(0, Math.floor(windowMs / 4)));
      const budgetMs = Math.max(1, windowMs - margin);
      const runtimeSignal = options.signal;
      // Our own cut-off: the window's end, plus the runtime's abandonment.
      // Both mean the same thing to a call in flight — stop — and an
      // explicit controller (rather than `AbortSignal.timeout`) leaves no
      // timer behind for the rest of the session to carry.
      const cutoff = new AbortController();
      const timer = setTimeout(() => cutoff.abort(), budgetMs);
      const onRuntimeAbort = () => cutoff.abort();
      runtimeSignal?.addEventListener("abort", onRuntimeAbort, { once: true });
      if (runtimeSignal?.aborted) cutoff.abort();
      let cursor = 0;
      const judged: Judged[] = [];
      const ranked = sections
        .map((section, index) => ({ index, section }))
        .sort((a, b) => b.section.bytes - a.section.bytes || a.index - b.index)
        .slice(0, COMPACTION_JUDGE_SECTION_BUDGET);
      try {
        const worker = async (): Promise<void> => {
          for (;;) {
            if (cutoff.signal.aborted) return;
            if (cursor >= ranked.length) return;
            if (Date.now() >= started + budgetMs) return;
            const entry = ranked[cursor++]!;
            await deps.client.judge({
              state: stateFor(entry.section),
              questions: COMPACTION_CUT_QUESTIONS,
              signal: cutoff.signal,
              record: (answers: Record<string, JevAnswer>, meta: JevJudgmentMeta) => {
                const droppable = noulProbability(answers, "droppable");
                judged.push({
                  section: entry.section,
                  index: entry.index,
                  verdict: {
                    id: entry.section.id,
                    decision: droppable > COMPACTION_CUT_THRESHOLDS.DROP_MIN ? "drop" : "keep",
                    droppable,
                  },
                  meta,
                });
                // This judge owns its records (`record` returns null, see the
                // client contract): everything is appended once, through the
                // single aggregate below.
                return null;
              },
            });
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(COMPACTION_JUDGE_CONCURRENCY, ranked.length) }, () => worker()),
        );
      } finally {
        clearTimeout(timer);
        runtimeSignal?.removeEventListener("abort", onRuntimeAbort);
      }

      const ordered = [...judged].sort((a, b) => a.index - b.index);
      const drop = ordered.flatMap((entry) => (entry.verdict.decision === "drop" ? [entry.section.id] : []));
      const bytesBefore = sections.reduce((sum, s) => sum + s.bytes, 0);
      const bytesDropped = ordered.reduce(
        (sum, entry) => sum + (entry.verdict.decision === "drop" ? entry.section.bytes : 0),
        0,
      );
      // Sections never called on (out of budget, out of window, or
      // abandoned) are one thing; a call that came back without a verdict
      // (Jev unreachable, or cut off mid-flight) is another — and the
      // record says which, so the two never look alike.
      const unjudged = sections.length - cursor;
      const failed = cursor - ordered.length;
      const unjudgedReason: CompactionUnjudgedReason = runtimeSignal?.aborted
        ? "abandoned"
        : cutoff.signal.aborted
          ? "deadline"
          : "budget";
      const usage = ordered.reduce(
        (sum, entry) => ({
          inputTokens: sum.inputTokens + entry.meta.usage.inputTokens,
          outputTokens: sum.outputTokens + entry.meta.usage.outputTokens,
        }),
        { inputTokens: 0, outputTokens: 0 },
      );
      const summary: Record<string, unknown> = {
        useCase: "compact-cut",
        kind: "compaction",
        offered: sections.length,
        judged: ordered.length,
        ...(unjudged > 0 ? { unjudged, unjudgedReason } : {}),
        ...(failed > 0 ? { failed } : {}),
        // Every judged section's verdict rides here — ADR-0032's
        // audit-integrity clause: one record instead of one per section,
        // and nothing sampled away.
        sections: ordered.map(verdictLine),
        dropped: drop,
        bytesBefore,
        bytesAfter: bytesBefore - bytesDropped,
        latencyMs: Date.now() - started,
        usage,
      };
      let written = false;
      return {
        drop,
        onApplied: (applied) => {
          if (written) return;
          written = true;
          // A compaction that judged nothing has no judgment to audit: the
          // offline status is the trace, exactly as before.
          if (ordered.length === 0) return;
          deps.append({
            ...summary,
            outcome: applied.applied === false
              ? "discarded"
              : drop.length === 0
                ? "empty"
                : applied.keptByFloor
                  ? "floor"
                  : "cut",
            // The core's post-floor truth wins: `drop` next to a
            // post-floor `bytesAfter` would describe two different cuts.
            dropped: applied.droppedIds ?? drop,
            keptByFloor: applied.keptByFloor,
            bytesAfter: applied.bytesAfter,
          });
        },
      };
    },
  };
}

export type CompactionJudge = ReturnType<typeof createCompactionJudge>;
