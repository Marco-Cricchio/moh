/**
 * Retro application (ADR-0075, #1275) — the last mile, and its gate.
 *
 * The report proposes a concrete application per finding (a rule, a
 * check, a navigation pointer); nothing here ever runs by itself. Two
 * rules bind this module:
 *
 * - **The proposal is deterministic**: the same finding always yields the
 *   same application, so the report can be reviewed and re-read.
 * - **The write is gated**: `applyRetroApplication` writes only when the
 *   caller passes an explicit `confirm: true`, only inside the project
 *   root, and only by appending a marked block — never by editing the
 *   user's existing prose. Level-3 consumption (findings into the system
 *   prompt) does not exist here at all.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { RetroFinding } from "./retro";

/** What kind of change an application is (ADR-0075's three shapes). */
export type RetroApplicationKind = "coding-standards-rule" | "automated-check" | "navigation-pointer";

export interface RetroApplication {
  kind: RetroApplicationKind;
  /** Project-relative file a human would edit. */
  target: string;
  /** The concrete change, one line. */
  proposal: string;
  /** The marker heading the append lands under (stable, greppable). */
  section: string;
}

/** Category → application. Deterministic; an unknown category gets the
 * review-only shape rather than an invented target. */
export function proposeRetroApplication(finding: RetroFinding): RetroApplication {
  switch (finding.category) {
    case "coding-standards":
      return {
        kind: "coding-standards-rule",
        target: "CODING_STANDARDS.md",
        proposal: `add a rule: ${finding.evidence}`,
        section: "## Retro findings",
      };
    case "missing-guardrail":
      // A check is wired in a workflow or a hook — a YAML file a markdown
      // bullet must not be appended to. The proposal names the change; the
      // human makes it. No automatic target.
      return {
        kind: "automated-check",
        target: "",
        proposal: `wire the check that exists but never runs: ${finding.evidence}`,
        section: "## Retro findings",
      };
    case "tool-economy":
      return {
        kind: "navigation-pointer",
        target: "AGENTS.md",
        proposal: `note the expensive pattern so the next session avoids it: ${finding.evidence}`,
        section: "## Retro findings",
      };
    case "navigation":
      return {
        kind: "navigation-pointer",
        target: "AGENTS.md",
        proposal: `add a navigation pointer: ${finding.evidence}`,
        section: "## Retro findings",
      };
    default:
      return {
        kind: "coding-standards-rule",
        target: "",
        proposal: `review by hand — no automatic target for category "${finding.category}": ${finding.evidence}`,
        section: "## Retro findings",
      };
  }
}

export type RetroApplyResult =
  | { ok: true; file: string; appended: boolean }
  | { ok: false; error: string };

/**
 * Applies one proposal by appending it under `application.section` in
 * `application.target` inside `projectRoot`.
 *
 * Refuses — with an explicit reason, never silently — when the caller did
 * not confirm, when the target escapes the project root, when the target
 * is missing (a new steering file is the human's to create), or when the
 * proposal is already present (idempotent: a second apply adds nothing).
 */
export function applyRetroApplication(opts: {
  finding: RetroFinding;
  projectRoot: string;
  confirm: boolean;
  application?: RetroApplication;
}): RetroApplyResult {
  if (!opts.confirm) return { ok: false, error: "refused: applying a change requires explicit confirmation" };
  const application = opts.application ?? proposeRetroApplication(opts.finding);
  if (!application.target) return { ok: false, error: "refused: this finding has no automatic target" };
  const root = resolve(opts.projectRoot);
  const file = resolve(root, application.target);
  const rel = relative(root, file);
  if (rel.startsWith("..") || isAbsolute(rel)) return { ok: false, error: "refused: target escapes the project root" };
  if (!existsSync(file)) return { ok: false, error: `refused: ${application.target} does not exist` };
  try {
    if (!statSync(file).isFile()) return { ok: false, error: `refused: ${application.target} is not a file` };
    const current = readFileSync(file, "utf8");
    const bullet = `- ${application.proposal} (retro ${opts.finding.signature})`;
    if (current.includes(bullet)) return { ok: true, file, appended: false };
    const block = current.includes(application.section)
      ? `${current.replace(/\s*$/, "")}\n${bullet}\n`
      : `${current.replace(/\s*$/, "")}\n\n${application.section}\n\n${bullet}\n`;
    writeFileSync(file, block);
    return { ok: true, file, appended: true };
  } catch (error) {
    return { ok: false, error: `refused: ${error instanceof Error ? error.message : String(error)}` };
  }
}
