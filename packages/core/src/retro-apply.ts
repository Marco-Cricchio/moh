/**
 * Retro application (ADR-0075, #1275; pre-commit target #1356, ADR-0077)
 * — the last mile, and its gate.
 *
 * The report proposes a concrete application per finding (a rule, a
 * check, a navigation pointer); nothing here ever runs by itself. Two
 * rules bind this module:
 *
 * - **The proposal is deterministic**: the same finding always yields the
 *   same application, so the report can be reviewed and re-read.
 * - **The write is gated**: `applyRetroApplication` writes only when the
 *   caller passes an explicit `confirm: true`, only inside the project
 *   root (one exact-path carve-out: the generated git hook), and only by
 *   appending a marked block — never by editing the user's existing
 *   prose. Level-3 consumption (findings into the system prompt) does
 *   not exist here at all.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { retroSignature, type RetroFinding } from "./retro";

/** What kind of change an application is (ADR-0075's three shapes). */
export type RetroApplicationKind = "coding-standards-rule" | "automated-check" | "navigation-pointer";

/** The one generated-file target (#1356, ADR-0077): the local git hook,
 * outside the project tree but inside the clone. */
export const PRE_COMMIT_TARGET = ".git/hooks/pre-commit";

/** The detector's fixed observation fingerprint for the pre-commit shape
 * (`retroSignature("missing-guardrail", "pre-commit:unwired")`) — the
 * dispatch key, not the free-text evidence. */
const PRE_COMMIT_UNWIRED = retroSignature("missing-guardrail", "pre-commit:unwired");

export interface RetroApplication {
  kind: RetroApplicationKind;
  /** Project-relative file a human would edit. */
  target: string;
  /** The concrete change, one line. */
  proposal: string;
  /** The marker heading the append lands under (stable, greppable). */
  section: string;
}

/** The check commands a generated pre-commit hook runs: the lint/test
 * scripts package.json defines, through the package manager the lockfiles
 * reveal. Deterministic from repo state; `set -e` so the first failing
 * check blocks the commit — a guardrail that does not block is cosmetic.
 * Returns null when no check is derivable (package.json unreadable or no
 * lint/test script): an always-passing hook would be worse than none. */
export function preCommitHookContent(projectRoot: string): string | null {
  let scripts: Record<string, unknown> = {};
  try {
    scripts = (JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch {
    return null;
  }
  const checks = ["lint", "test"].filter((s) => typeof scripts[s] === "string");
  if (checks.length === 0) return null;
  const run = existsSync(resolve(projectRoot, "bun.lockb")) || existsSync(resolve(projectRoot, "bun.lock"))
    ? "bun run"
    : existsSync(resolve(projectRoot, "pnpm-lock.yaml"))
      ? "pnpm run"
      : existsSync(resolve(projectRoot, "yarn.lock"))
        ? "yarn run"
        : "npm run";
  return `#!/bin/sh\nset -e\n${checks.map((s) => `${run} ${s}`).join("\n")}\n`;
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
      // #1356: the pre-commit:unwired shape (matched by its fixed
      // signature, never by the free-text evidence) has a universal
      // target — the local git hook. The CI shape stays review-only
      // because a workflow file is project-specific YAML.
      if (finding.signature.startsWith(PRE_COMMIT_UNWIRED)) {
        return {
          kind: "automated-check",
          target: PRE_COMMIT_TARGET,
          proposal: "generate a pre-commit hook running the checks package.json defines",
          section: "## Retro findings",
        };
      }
      // A check is wired in a workflow — a YAML file a markdown
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
  | { ok: true; file: string; appended: boolean; created: boolean }
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
  /** #1343 follow-up: when the target steering file does not exist, create
   * it with the marked block instead of refusing. Still behind the same
   * explicit confirm — the gate refuses automation, not the act; the file
   * lands in the project (committable) because that is where the model
   * reads steering files. Callers that omit it keep the strict refusal. */
  createMissing?: boolean;
  application?: RetroApplication;
}): RetroApplyResult {
  if (!opts.confirm) return { ok: false, error: "refused: applying a change requires explicit confirmation" };
  const application = opts.application ?? proposeRetroApplication(opts.finding);
  if (!application.target) return { ok: false, error: "refused: this finding has no automatic target" };
  const root = resolve(opts.projectRoot);
  const file = resolve(root, application.target);
  const rel = relative(root, file);
  // #1356 (ADR-0077): the generated git hook lives outside the project
  // tree but inside the clone — the exact-path carve-out. An existing
  // hook is never overwritten, but one that exists yet is not executable
  // (a fresh clone strips the bit) is made executable instead: that is
  // the exact state the detector keeps firing on, and rewriting it is
  // what the never-overwrite rule guards against.
  if (application.target === PRE_COMMIT_TARGET) {
    const content = preCommitHookContent(root);
    if (content === null) return { ok: false, error: "refused: no lint/test check derivable from package.json" };
    try {
      if (existsSync(file)) {
        if ((statSync(file).mode & 0o111) === 0o111) {
          return { ok: false, error: `refused: ${application.target} already exists — a hook is never overwritten` };
        }
        chmodSync(file, 0o755);
        return { ok: true, file, appended: false, created: false };
      }
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content, { mode: 0o755 });
      return { ok: true, file, appended: false, created: true };
    } catch (error) {
      return { ok: false, error: `refused: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (rel.startsWith("..") || isAbsolute(rel)) return { ok: false, error: "refused: target escapes the project root" };
  if (!existsSync(file)) {
    if (!opts.createMissing) return { ok: false, error: `refused: ${application.target} does not exist` };
    try {
      writeFileSync(file, `# ${application.target.replace(/\.md$/, "")}\n`, { mode: 0o644 });
    } catch (error) {
      return { ok: false, error: `refused: ${error instanceof Error ? error.message : String(error)}` };
    }
    const appended = applyRetroApplication({ ...opts, application });
    return appended.ok ? { ...appended, created: true } : appended;
  }
  try {
    if (!statSync(file).isFile()) return { ok: false, error: `refused: ${application.target} is not a file` };
    const current = readFileSync(file, "utf8");
    const bullet = `- ${application.proposal} (retro ${opts.finding.signature})`;
    if (current.includes(bullet)) return { ok: true, file, appended: false, created: false };
    const block = current.includes(application.section)
      ? `${current.replace(/\s*$/, "")}\n${bullet}\n`
      : `${current.replace(/\s*$/, "")}\n\n${application.section}\n\n${bullet}\n`;
    writeFileSync(file, block);
    return { ok: true, file, appended: true, created: false };
  } catch (error) {
    return { ok: false, error: `refused: ${error instanceof Error ? error.message : String(error)}` };
  }
}
