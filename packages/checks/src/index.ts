/**
 * `@moh/checks`: the first-party checks extension (ADR-0080, #1633 slices 4b–4c).
 *
 * Runs the repository's declared checks (`moh.json` `checks`) after a turn
 * that changed the working tree, and reports the outcome to the user. A
 * failing `block: true` check is also handed to the model as a synthetic
 * turn (resolve-before-done); report-only failures never reach it.
 *
 * - **Change detection**: a fingerprint of `git status --porcelain` plus
 *   `git diff HEAD` (`.moh/` excluded), read through the read-only `git`
 *   tool and compared with the one taken at the previous turn boundary —
 *   the first one before the first turn starts. Neither shows a rewrite of
 *   a file that is already untracked, so a settled `write`/`edit` call also
 *   marks the turn changed. A turn that only reads or talks runs nothing.
 * - **Runs**: one check at a time through `runTool("bash")` — the model's
 *   exact gate path, the user's rules and mode decide each call. A check
 *   fails on a non-zero exit; moh never parses the tool's output.
 * - **Hook ceiling**: `afterTurn` only schedules the run and returns; the
 *   checks run after it, chained so two turns never overlap their runs.
 * - **Report**: the footer status, plus one `checks` extension event per
 *   run carrying each outcome and the tail of each output.
 * - **Resolve-before-done**: failing blocking checks become one
 *   `requestTurn` with their names and output tails. The correction turn is
 *   judged like any other — if it changes the tree the checks run again, on
 *   purpose (ADR-0037's "skip your own synthetic turn" is exactly what this
 *   extension must not do). The core bounds the chain at two consecutive
 *   synthetic turns; a refused request, or a correction that changes
 *   nothing, leaves the footer at "✗ (unresolved)". Never a commit block.
 *
 * The grant is the consented door with a manifest derived from the declared
 * checks: the enable question lists the exact commands, and editing them
 * asks again (the hash changes under the same per-project path).
 */
import { createHash } from "node:crypto";
import { defineExtension, MOH_EXTENSION_API_VERSION, type ExtensionDefinition } from "@moh/extension";

/** The extension's name, as stamped in the log and shown in /extensions. */
const CHECKS_NAME = "checks";
/** Part of the consent hash: a version that changes what the grant means asks again. */
const CHECKS_VERSION = "0.2.0";
const CAPABILITIES = ["tool:bash", "tool:git"];
/** Output tail kept per check in the event: the event payload is capped at 8 KiB. */
const TAIL_CHARS = 1500;

/** One declared check — the `moh.json` `checks` entry shape (ADR-0080). */
interface Check {
  name: string;
  run: string;
  block?: boolean;
  timeoutMs?: number;
}

type Outcome = "pass" | "fail" | "denied";

const tail = (text: string): string => (text.length > TAIL_CHARS ? text.slice(-TAIL_CHARS) : text);

/** The synthetic user-side message for failing blocking checks: deterministic, never model-written. */
function correction(failed: readonly { name: string; tail: string }[]): string {
  return [
    "The repository's blocking checks (moh.json `checks`) failed after your change:",
    ...failed.map((f) => `\n### ${f.name}\n\n\`\`\`\n${f.tail}\n\`\`\``),
    "\nFix the cause, or record an explicit exception the repository accepts, then stop.",
  ].join("\n");
}

/** The footer line for one run's outcomes. */
function statusLine(results: readonly { name: string; outcome: Outcome }[]): string {
  const failed = results.filter((r) => r.outcome !== "pass").map((r) => (r.outcome === "denied" ? `${r.name} (denied)` : r.name));
  return failed.length === 0 ? "checks ✓" : `checks: ${failed.join(", ")} ✗`;
}

export function createChecksExtension(checks: readonly Check[]): ExtensionDefinition {
  return defineExtension({
    name: CHECKS_NAME,
    version: CHECKS_VERSION,
    apiVersion: MOH_EXTENSION_API_VERSION,
    capabilities: [...CAPABILITIES],
    setup: (ctx) => {
      const runTool = ctx.host?.runTool;
      if (!runTool) return; // enforcement by absence: no grant, no checks
      // moh's own state (`.moh/`) is harness, never the turn's change.
      const paths = ["--", ".", ":(exclude).moh"];
      const fingerprint = async (): Promise<string | undefined> => {
        const status = await runTool("git", { args: ["status", "--porcelain", ...paths] });
        if (!status.ok) return undefined;
        // No commit yet means no HEAD to diff against: the status alone speaks.
        const diff = await runTool("git", { args: ["diff", "HEAD", ...paths] });
        return `${status.output}\0${diff.ok ? diff.output : ""}`;
      };
      let touched = false;
      ctx.onToolResult(["write", "edit"], () => {
        touched = true;
      });
      // Taken before the first turn writes anything: at setup no session is
      // bound yet, so the seam cannot run a tool.
      let baseline: Promise<string | undefined> | undefined;
      let queue: Promise<void> = Promise.resolve();
      /** Blocking checks the last run left failing. */
      let pending: string[] = [];
      const unresolved = (): void => ctx.setStatus(`checks: ${pending.join(", ")} ✗ (unresolved)`);

      const runIfChanged = async (synthetic: boolean): Promise<void> => {
        const before = await baseline;
        const now = await fingerprint();
        const wrote = touched;
        touched = false;
        if (now === undefined || (now === before && !wrote)) {
          // A correction turn that changed nothing resolved nothing.
          if (synthetic && pending.length > 0) unresolved();
          return;
        }
        ctx.setStatus("checks: running…");
        const results: { name: string; outcome: Outcome; block: boolean; tail: string }[] = [];
        for (const check of checks) {
          const r = await runTool("bash", { command: check.run, ...(check.timeoutMs !== undefined ? { timeoutMs: check.timeoutMs } : {}) });
          const outcome: Outcome = r.ok ? "pass" : r.reason === "denied" ? "denied" : "fail";
          results.push({ name: check.name, outcome, block: check.block === true, tail: tail(r.ok ? r.output : (r.message ?? r.reason)) });
        }
        ctx.setStatus(statusLine(results));
        ctx.appendEvent({ name: "checks", payload: { results } });
        // A check that writes (a report file) must not re-trigger the next
        // turn; settled before a correction turn can write anything.
        baseline = fingerprint();
        await baseline;
        const failed = results.filter((r) => r.block && r.outcome === "fail");
        pending = failed.map((r) => r.name);
        if (failed.length === 0) return;
        // Not awaited: the correction turn settles later, and its own
        // afterTurn queues the re-run behind this one.
        void ctx.requestTurn(correction(failed)).then((ran) => {
          if (!ran) unresolved();
        });
      };

      ctx.beforeTurn(async () => {
        baseline ??= fingerprint();
        await baseline;
      });
      ctx.afterTurn(({ result, synthetic }) => {
        if (result.status !== "done") return;
        const run = () => runIfChanged(synthetic === true);
        queue = queue.then(run, run);
      });
    },
  });
}

/** What the bundled descriptor reads from the activation context. */
interface ChecksActivationContext {
  cwd: string;
  checks?: readonly Check[];
}

/**
 * The bundled descriptor (ADR-0080): always mounted; it declines (`null`)
 * when the project declares no checks. The consent is the grant: its
 * manifest names the exact commands and is keyed per project, so a new or
 * edited `checks` array is a new question. Headless with no stored grant,
 * the load is refused loudly — "declared, not consented" — and nothing runs.
 */
export const checksBundledSource = {
  name: CHECKS_NAME,
  consentRequired: true,
  manifest: (context: ChecksActivationContext) => {
    const checks = context.checks ?? [];
    return {
      capabilities: [...CAPABILITIES],
      hash: createHash("sha256").update(`${CHECKS_VERSION}\n${JSON.stringify(checks)}`).digest("hex"),
      path: `checks:${context.cwd}`,
      reasoning: [
        "Runs this repository's declared checks (moh.json `checks`) after a turn that changed files, one at a time through the bash tool and your permission rules, and shows the outcome in the footer:",
        ...checks.map((c) => `- ${c.name}: ${c.run}`),
        "It never edits files and never blocks a commit. A failing check marked `block: true` is handed to the model as a correction turn (at most two in a row); other results are never shown to it.",
      ].join("\n"),
    };
  },
  activate(context: ChecksActivationContext): ExtensionDefinition | null {
    return context.checks?.length ? createChecksExtension(context.checks) : null;
  },
};
