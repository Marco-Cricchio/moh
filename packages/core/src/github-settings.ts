/**
 * Declarative GitHub repository settings (ADR-0017, #378).
 *
 * TypeScript port of the ideas in ddlaws0n/gh-manager (MIT, David Lawson
 * @ddlaws0n — https://github.com/ddlaws0n): a single declarative config
 * (a `repos.yaml`, parsed here from its JSON projection) describing desired
 * repository settings, a plan/diff engine comparing declared vs live state,
 * and an apply step reconciling the two.
 *
 * Semantics ported from gh-manager's plan/diff engine:
 * - `plan` is read-only: it fetches live state and computes the minimal set
 *   of changes; it never mutates.
 * - `apply` executes exactly the changes of a previously computed plan, one
 *   GitHub API call each, in plan order (repo settings first, then labels,
 *   then branch protection).
 * - Undeclared live settings are never touched (declarative subset only;
 *   undeclared labels are never deleted).
 *
 * Access goes through the `gh` CLI (`gh api`), so auth/token handling stays
 * with `gh` (env `GITHUB_TOKEN` or `gh auth login`); no secret ever reaches
 * moh's config. Both seams are injectable: tests pass fakes, no network.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Declared config (repos.yaml schema — JSON projection)
// ---------------------------------------------------------------------------

export const labelSchema = z.object({
  name: z.string().min(1),
  /** 6-digit hex, no `#`. */
  color: z.string().regex(/^[0-9a-fA-F]{6}$/),
  description: z.string().optional(),
});

export const branchProtectionSchema = z.object({
  branch: z.string().default("main"),
  /** Required status check contexts that must pass before merging. */
  requiredChecks: z.array(z.string()).optional(),
  /** Required approving reviews before merging. */
  requiredReviews: z.number().int().min(0).max(6).optional(),
  dismissStaleReviews: z.boolean().optional(),
  allowForcePushes: z.boolean().optional(),
});

export const repoConfigSchema = z.object({
  /** `owner/name`. */
  name: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  description: z.string().optional(),
  visibility: z.enum(["public", "private"]).optional(),
  labels: z.array(labelSchema).optional(),
  branchProtection: branchProtectionSchema.optional(),
});

export const reposConfigSchema = z.object({
  repos: z.array(repoConfigSchema).min(1),
});

export type LabelConfig = z.infer<typeof labelSchema>;
export type BranchProtectionConfig = z.infer<typeof branchProtectionSchema>;
export type RepoConfig = z.infer<typeof repoConfigSchema>;
export type ReposConfig = z.infer<typeof reposConfigSchema>;

/** Parses and validates a `repos.yaml` JSON projection; throws on invalid. */
export function parseReposConfig(json: unknown): ReposConfig {
  return reposConfigSchema.parse(json);
}

// ---------------------------------------------------------------------------
// Live-state types
// ---------------------------------------------------------------------------

export interface LiveLabel {
  name: string;
  color: string;
  description: string;
}

export interface LiveBranchProtection {
  branch: string;
  requiredChecks: string[];
  requiredReviews: number;
  dismissStaleReviews: boolean;
  allowForcePushes: boolean;
}

export interface LiveRepo {
  name: string;
  description: string;
  visibility: "public" | "private";
  labels: LiveLabel[];
  branchProtection: LiveBranchProtection | null;
}

// ---------------------------------------------------------------------------
// Plan / diff engine
// ---------------------------------------------------------------------------

export type ChangeAction = "update-repo" | "add-label" | "update-label" | "put-protection";

export type PlanChange =
  | {
      repo: string;
      action: "update-repo";
      summary: string;
      patch: { description?: string; visibility?: "public" | "private" };
    }
  | { repo: string; action: "add-label" | "update-label"; summary: string; label: LabelConfig }
  | {
      repo: string;
      action: "put-protection";
      summary: string;
      protection: BranchProtectionConfig & { branch: string };
    };

export interface Plan {
  repo: string;
  /** Minimal ordered change set; empty = live state matches declaration. */
  changes: PlanChange[];
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v) => b.includes(v));
}

/** Computes the minimal change set taking live state to the declaration. */
export function planRepo(desired: RepoConfig, live: LiveRepo): Plan {
  const changes: PlanChange[] = [];

  const patch: { description?: string; visibility?: "public" | "private" } = {};
  if (desired.description !== undefined && desired.description !== live.description) {
    patch.description = desired.description;
  }
  if (desired.visibility !== undefined && desired.visibility !== live.visibility) {
    patch.visibility = desired.visibility;
  }
  if (patch.description !== undefined || patch.visibility !== undefined) {
    const parts = [
      patch.description !== undefined ? `description → "${patch.description}"` : null,
      patch.visibility !== undefined ? `visibility ${live.visibility} → ${patch.visibility}` : null,
    ].filter(Boolean);
    changes.push({ repo: desired.name, action: "update-repo", summary: parts.join(", "), patch });
  }

  if (desired.labels) {
    for (const want of desired.labels) {
      const have = live.labels.find((l) => l.name === want.name);
      if (!have) {
        changes.push({
          repo: desired.name,
          action: "add-label",
          summary: `+ label "${want.name}" (#${want.color})`,
          label: want,
        });
      } else if (
        have.color.toLowerCase() !== want.color.toLowerCase() ||
        (have.description ?? "") !== (want.description ?? "")
      ) {
        changes.push({
          repo: desired.name,
          action: "update-label",
          summary: `~ label "${want.name}" ${have.color}→${want.color}`,
          label: want,
        });
      }
    }
    // Undeclared labels are left alone (declarative subset, never delete).
  }

  if (desired.branchProtection) {
    const want = desired.branchProtection;
    const have = live.branchProtection?.branch === want.branch ? live.branchProtection : null;
    const same =
      have !== null &&
      arraysEqual(have.requiredChecks, want.requiredChecks ?? []) &&
      have.requiredReviews === (want.requiredReviews ?? 0) &&
      have.dismissStaleReviews === (want.dismissStaleReviews ?? false) &&
      have.allowForcePushes === (want.allowForcePushes ?? false);
    if (!same) {
      const from = have ? "drifted" : "absent";
      changes.push({
        repo: desired.name,
        action: "put-protection",
        summary: `branch protection on "${want.branch}" (${from} → declared)`,
        protection: { ...want, branch: want.branch },
      });
    }
  }

  return { repo: desired.name, changes };
}

/** Renders a plan's changes as the markdown diff shown for consent before apply. */
export function renderPlan(changes: PlanChange[]): string {
  if (changes.length === 0) return "No changes: live state already matches the declared config.\n";
  const lines = changes.map((c) => `- **${c.repo}** — ${c.action}: ${c.summary}`);
  return `Plan (${changes.length} change${changes.length === 1 ? "" : "s"}):\n${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// GitHub access seams (gh CLI). Read seam: argv-only runner, same contract
// as tracker.ts. Mutating seam: one call per plan change.
// ---------------------------------------------------------------------------

export class GithubSettingsError extends Error {}

export type ShellRunner = (cmd: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export const defaultRunner: ShellRunner = async (cmd) => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

/** One GitHub API mutation: verb + path + JSON body. */
export interface GhMutator {
  (verb: "PATCH" | "POST" | "PUT", path: string, body: unknown): Promise<void>;
}

/** Default mutator over `gh api` (body on stdin via `--input -`). */
export const ghApiMutator: GhMutator = async (verb, path, body) => {
  const proc = Bun.spawn(["gh", "api", "--method", verb, "--input", "-", path], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(body));
  proc.stdin.end();
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  // Drain stdout so the pipe never blocks on large responses.
  await new Response(proc.stdout).text();
  if (code !== 0) throw new GithubSettingsError(`gh api ${verb} ${path} failed: ${stderr.trim()}`);
};

/** Live-state reader over `gh api` (read-only). */
export async function readLiveRepo(name: string, run: ShellRunner = defaultRunner): Promise<LiveRepo> {
  async function api(path: string): Promise<any> {
    const res = await run(["gh", "api", path]);
    if (res.code !== 0) throw new GithubSettingsError(`gh api ${path} failed: ${res.stderr.trim()}`);
    return JSON.parse(res.stdout);
  }
  const repo = await api(`repos/${name}`);
  const [labels, protection] = await Promise.all([
    api(`repos/${name}/labels?per_page=100`).catch(() => [] as any[]),
    api(`repos/${name}/branches/main/protection`).catch(() => null),
  ]);
  return {
    name,
    description: String(repo.description ?? ""),
    visibility: repo.private === true ? "private" : "public",
    labels: (Array.isArray(labels) ? labels : []).map((l: any) => ({
      name: String(l.name ?? ""),
      color: String(l.color ?? "").toLowerCase(),
      description: String(l.description ?? ""),
    })),
    branchProtection: protection
      ? {
          branch: "main",
          requiredChecks: (protection?.required_status_checks?.contexts ?? []) as string[],
          requiredReviews: (protection?.required_pull_request_reviews
            ?.required_approving_review_count ?? 0) as number,
          dismissStaleReviews: protection?.required_pull_request_reviews?.dismiss_stale_reviews === true,
          allowForcePushes: protection?.allow_force_pushes?.enabled === true,
        }
      : null,
  };
}

/**
 * Executes exactly the given plan changes, in order, one API call each.
 * Never called before the caller showed the rendered plan and obtained
 * explicit user consent (that gate lives in the gh-manager skill).
 */
export async function applyChanges(changes: PlanChange[], mutate: GhMutator = ghApiMutator): Promise<string[]> {
  const applied: string[] = [];
  for (const change of changes) {
    switch (change.action) {
      case "update-repo": {
        const body: Record<string, unknown> = {};
        if (change.patch.description !== undefined) body.description = change.patch.description;
        if (change.patch.visibility !== undefined) body.private = change.patch.visibility === "private";
        await mutate("PATCH", `repos/${change.repo}`, body);
        break;
      }
      case "add-label":
      case "update-label": {
        const verb = change.action === "add-label" ? "POST" : "PATCH";
        const path =
          change.action === "add-label"
            ? `repos/${change.repo}/labels`
            : `repos/${change.repo}/labels/${encodeURIComponent(change.label.name)}`;
        await mutate(verb, path, {
          name: change.label.name,
          color: change.label.color,
          description: change.label.description ?? "",
        });
        break;
      }
      case "put-protection": {
        const p = change.protection;
        await mutate("PUT", `repos/${change.repo}/branches/${encodeURIComponent(p.branch)}/protection`, {
          required_status_checks: p.requiredChecks ? { strict: false, contexts: p.requiredChecks } : null,
          enforce_admins: false,
          required_pull_request_reviews: {
            required_approving_review_count: p.requiredReviews ?? 0,
            dismiss_stale_reviews: p.dismissStaleReviews ?? false,
          },
          restrictions: null,
          allow_force_pushes: p.allowForcePushes ?? false,
        });
        break;
      }
    }
    applied.push(change.summary);
  }
  return applied;
}
