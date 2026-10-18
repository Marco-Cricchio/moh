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
import { isAbsolute, join, relative, resolve } from "node:path";
import { retroSignature, type RetroFinding } from "./retro";

/** What kind of change an application is (ADR-0075's three shapes). */
type RetroApplicationKind = "coding-standards-rule" | "automated-check" | "navigation-pointer";

/** The one generated-file target (#1356, ADR-0077): the local git hook,
 * outside the project tree but inside the clone. */
export const PRE_COMMIT_TARGET = ".git/hooks/pre-commit";

/**
 * The real shared git dir for the project root (`<main>/.git` even from a
 * linked worktree — a lane's `.git` is a *file*, so an executable hook
 * must land in the main checkout where every worktree sees it). Falls
 * back to `<root>/.git` when git is unavailable or the root is not a
 * repository (tests write to bare temp dirs).
 */
function gitDir(projectRoot: string): string {
  const probe = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = probe.stdout?.toString().trim();
  return probe.exitCode === 0 && out ? out : join(projectRoot, ".git");
}

/** The detector's fixed observation fingerprint for the pre-commit shape
 * (`retroSignature("missing-guardrail", "pre-commit:unwired")`) — the
 * dispatch key, not the free-text evidence. */
const PRE_COMMIT_UNWIRED = retroSignature("missing-guardrail", "pre-commit:unwired");

interface RetroApplication {
  kind: RetroApplicationKind;
  /** Project-relative file a human would edit. */
  target: string;
  /** The concrete change, one line. */
  proposal: string;
  /** The marker heading the append lands under (stable, greppable). */
  section: string;
}

/** A `test` script that runs the whole tree in a single process — the
 * shape a blocking pre-commit hook turns into a minutes-long gate (#1363):
 * it is excluded from the generated checks, since the correct runner
 * (scripts/test.sh-style phasing) is project-specific and never invented.
 * Prefix match: `bun test .`, `vitest run`, `jest --runInBand` are the
 * same hazard as the bare command. */
const BARE_TEST_SCRIPT = /^(?:(?:bun|npm|pnpm|yarn)(?:\s+run)?\s+test|vitest|jest|node\s+--test)(\s|$)/;

function isBareTestScript(value: string): boolean {
  return BARE_TEST_SCRIPT.test(value.trim());
}

function packageScripts(projectRoot: string): Record<string, unknown> | null {
  try {
    return (JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch {
    return null;
  }
}

function derivableChecks(scripts: Record<string, unknown>): string[] {
  return ["lint", "test"].filter(
    (s) => typeof scripts[s] === "string" && (s !== "test" || !isBareTestScript(scripts[s] as string)),
  );
}

/** The hook content, or null when no check is derivable (package.json
 * unreadable, no lint/test script, or a test script that is only a bare
 * whole-tree run — see BARE_TEST_SCRIPT). */
export function preCommitHookContent(projectRoot: string): string | null {
  const scripts = packageScripts(projectRoot);
  if (!scripts) return null;
  const checks = derivableChecks(scripts);
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

type RetroApplyResult =
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
    if (content === null) {
      // #1363: distinguish "nothing derivable" from "the only derivable
      // check is a bare whole-tree run" — the refusal names the fix.
      const scripts = packageScripts(root);
      if (scripts && typeof scripts.test === "string" && isBareTestScript(scripts.test)) {
        return { ok: false, error: "refused: the test script is a bare whole-tree run — wire scripts/test.sh first" };
      }
      return { ok: false, error: "refused: no lint/test check derivable from package.json" };
    }
    const hooks = join(gitDir(root), "hooks");
    try {
      if (existsSync(file)) {
        if ((statSync(file).mode & 0o111) === 0o111) {
          return { ok: false, error: `refused: ${application.target} already exists — a hook is never overwritten` };
        }
        chmodSync(file, 0o755);
        return { ok: true, file, appended: false, created: false };
      }
      mkdirSync(hooks, { recursive: true });
      writeFileSync(join(hooks, "pre-commit"), content, { mode: 0o755 });
      return { ok: true, file: join(hooks, "pre-commit"), appended: false, created: true };
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
