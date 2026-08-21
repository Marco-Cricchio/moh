/**
 * Tracker registry (#11/#36): the issue-tracker abstraction behind the
 * workflow's frontier panel. Backends: GitHub Issues (via the `gh` CLI),
 * GitLab (via `glab`), and a local markdown tracker under
 * `.moh/tracker/`. Exposed to the model as built-in tools
 * (`tracker_list`, `tracker_claim`) under the same permission spine as
 * any tool — no workflow privilege.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import type { Tool } from "./types";

/** One issue, normalized across backends. */
export interface TrackerIssue {
  /** Backend-stable id (number as string for gh/gitlab, slug for local). */
  id: string;
  title: string;
  state: "open" | "closed";
  labels: string[];
  /** Assignees; non-empty means "claimed". */
  assignees: string[];
  /** Ids this issue is blocked by; empty/unknown → unblocked. */
  blockedBy: string[];
}

export interface TrackerBackend {
  readonly kind: "gh" | "gitlab" | "local-markdown";
  list(): Promise<TrackerIssue[]>;
  /** Assigns the current user to an open issue. */
  claim(id: string): Promise<void>;
}

/** Injectable process runner (tests); default: `Bun.spawn`. */
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

function ghIssueToTracker(raw: any): TrackerIssue {
  return {
    id: String(raw.number ?? raw.id ?? ""),
    title: String(raw.title ?? ""),
    state: raw.state === "closed" ? "closed" : "open",
    labels: Array.isArray(raw.labels) ? raw.labels.map((l: any) => String(l?.name ?? l)) : [],
    assignees: Array.isArray(raw.assignees) ? raw.assignees.map((a: any) => String(a?.login ?? a)) : [],
    // gh has no dependency field: unknown → unblocked (flat frontier)
    blockedBy: [],
  };
}

/** GitHub Issues backend over the `gh` CLI. */
export function ghTracker(repo: string, run: ShellRunner = defaultRunner): TrackerBackend {
  return {
    kind: "gh",
    async list() {
      const res = await run([
        "gh", "issue", "list", "--repo", repo, "--state", "all", "--limit", "200",
        "--json", "number,title,state,labels,assignees",
      ]);
      if (res.code !== 0) throw new Error(`gh issue list failed: ${res.stderr.trim()}`);
      return (JSON.parse(res.stdout) as any[]).map(ghIssueToTracker);
    },
    async claim(id) {
      const res = await run(["gh", "issue", "edit", id, "--repo", repo, "--add-assignee", "@me"]);
      if (res.code !== 0) throw new Error(`gh issue edit failed: ${res.stderr.trim()}`);
    },
  };
}

function gitlabIssueToTracker(raw: any): TrackerIssue {
  return {
    id: String(raw.iid ?? raw.id ?? ""),
    title: String(raw.title ?? ""),
    state: raw.state === "closed" ? "closed" : "open",
    labels: Array.isArray(raw.labels) ? raw.labels.map(String) : [],
    assignees: Array.isArray(raw.assignees) ? raw.assignees.map((a: any) => String(a?.username ?? a)) : [],
    blockedBy: [],
  };
}

/** GitLab backend over the `glab` CLI. */
export function gitlabTracker(repo: string, run: ShellRunner = defaultRunner): TrackerBackend {
  return {
    kind: "gitlab",
    async list() {
      const res = await run([
        "glab", "issue", "list", "--repo", repo, "--all", "--per-page", "200",
        "--output", "json",
      ]);
      if (res.code !== 0) throw new Error(`glab issue list failed: ${res.stderr.trim()}`);
      const data = JSON.parse(res.stdout);
      const issues = Array.isArray(data) ? data : (data?.issues ?? []);
      return (issues as any[]).map(gitlabIssueToTracker);
    },
    async claim(id) {
      const res = await run(["glab", "issue", "update", id, "--repo", repo, "--assignee", "@me"]);
      if (res.code !== 0) throw new Error(`glab issue update failed: ${res.stderr.trim()}`);
    },
  };
}

/**
 * Local markdown tracker: one file per issue in `.moh/tracker/`, with
 * frontmatter `id`, `title`, `state`, `labels`, `blocked-by`,
 * `claimed-by`. The only backend that knows dependencies.
 */
export const TRACKER_DIR = ".moh/tracker";

function splitList(v?: string): string[] {
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

export function localMarkdownTracker(dir: string, user = "@me"): TrackerBackend {
  const readIssues = (): TrackerIssue[] => {
    if (!existsSync(dir)) return [];
    const issues: TrackerIssue[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const raw = readFileSync(join(dir, entry.name), "utf8");
      const fields = new Map<string, string>();
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
      if (fm) {
        for (const line of fm[1]!.split(/\r?\n/)) {
          const kv = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(line);
          if (kv) fields.set(kv[1]!, kv[2]!.trim());
        }
      }
      const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---/, "").trim();
      issues.push({
        id: fields.get("id") ?? basename(entry.name, ".md"),
        title: fields.get("title") ?? body.split("\n")[0]?.slice(0, 80) ?? entry.name,
        state: fields.get("state") === "closed" ? "closed" : "open",
        labels: splitList(fields.get("labels")),
        assignees: splitList(fields.get("claimed-by")),
        blockedBy: splitList(fields.get("blocked-by")),
      });
    }
    return issues;
  };
  return {
    kind: "local-markdown",
    async list() {
      return readIssues();
    },
    async claim(id) {
      const issues = readIssues();
      const target = issues.find((i) => i.id === id);
      if (!target) throw new Error(`no tracker issue "${id}"`);
      if (target.state !== "open") throw new Error(`issue "${id}" is not open`);
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const file = join(dir, entry.name);
        const raw = readFileSync(file, "utf8");
        const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
        if (!fm) continue;
        const fields = new Map<string, string>();
        for (const line of fm[1]!.split(/\r?\n/)) {
          const kv = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(line);
          if (kv) fields.set(kv[1]!, kv[2]!.trim());
        }
        if ((fields.get("id") ?? basename(entry.name, ".md")) !== id) continue;
        const claimed = splitList(fields.get("claimed-by"));
        if (!claimed.includes(user)) claimed.push(user);
        fields.set("claimed-by", claimed.join(", "));
        const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---/, "");
        const fmText = [...fields.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
        writeFileSync(file, `---\n${fmText}\n---${body}`);
        return;
      }
      throw new Error(`tracker file for "${id}" not found`);
    },
  };
}


export interface ResolveTrackerOptions {
  /** Working dir. Default process.cwd(). */
  cwd?: string;
  run?: ShellRunner;
}

/**
 * Resolves the project's tracker: local markdown wins (explicit), then
 * the git remote's host (github → gh, gitlab → gitlab). Null when no
 * tracker can be detected — the frontier panel hides.
 */
export async function resolveTracker(options: ResolveTrackerOptions = {}): Promise<TrackerBackend | null> {
  const cwd = options.cwd ?? process.cwd();
  const run = options.run ?? defaultRunner;
  if (existsSync(join(cwd, TRACKER_DIR))) return localMarkdownTracker(join(cwd, TRACKER_DIR));
  const res = await run(["git", "-C", cwd, "remote", "get-url", "origin"]);
  if (res.code !== 0) return null;
  const url = res.stdout.trim();
  const m = /[:/]([^/:]+\/[^/.]+)(?:\.git)?$/.exec(url);
  if (!m) return null;
  const repo = m[1]!;
  if (/gitlab/i.test(url)) return gitlabTracker(repo, run);
  return ghTracker(repo, run);
}

/** Sync twin of `resolveTracker` for session creation (spawnSync). */
export function resolveTrackerSync(options: ResolveTrackerOptions = {}): TrackerBackend | null {
  const cwd = options.cwd ?? process.cwd();
  const run = options.run ?? defaultRunner;
  if (existsSync(join(cwd, TRACKER_DIR))) return localMarkdownTracker(join(cwd, TRACKER_DIR));
  const proc = Bun.spawnSync(["git", "-C", cwd, "remote", "get-url", "origin"], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) return null;
  const url = proc.stdout.toString().trim();
  const m = /[:/]([^/:]+\/[^/.]+)(?:\.git)?$/.exec(url);
  if (!m) return null;
  const repo = m[1]!;
  if (/gitlab/i.test(url)) return gitlabTracker(repo, run);
  return ghTracker(repo, run);
}

/** Formats issues as a compact list for the model. */
function formatIssues(issues: TrackerIssue[]): string {
  if (issues.length === 0) return "(no issues)";
  return issues
    .map((i) => {
      const bits = [`#${i.id}`, i.state === "closed" ? "✓" : "○", i.title];
      if (i.labels.length) bits.push(`[${i.labels.join(",")}]`);
      if (i.assignees.length) bits.push(`(claimed: ${i.assignees.join(",")})`);
      if (i.blockedBy.length) bits.push(`(blocked by: ${i.blockedBy.map((b) => `#${b}`).join(",")})`);
      return bits.join(" ");
    })
    .join("\n");
}

const listSchema = z.object({ state: z.enum(["open", "all"]).optional() });
const claimSchema = z.object({ id: z.string().min(1) });

/**
 * The tracker as built-in tools (#36): `tracker_list` (read, allowed by
 * default) and `tracker_claim` (mutating, asks by default). They run
 * through the same permission engine as any tool.
 */
export function trackerTools(backend: TrackerBackend): Record<string, Tool> {
  const list: Tool<z.infer<typeof listSchema>> = {
    name: "tracker_list",
    description: "List issues from the project's tracker (gh, gitlab, or local markdown).",
    inputSchema: listSchema,
    async execute(args) {
      const issues = await backend.list();
      const filtered = args.state === "all" ? issues : issues.filter((i) => i.state === "open");
      return formatIssues(filtered);
    },
  };
  const claim: Tool<z.infer<typeof claimSchema>> = {
    name: "tracker_claim",
    description: "Claim (self-assign) an open tracker issue by id.",
    inputSchema: claimSchema,
    async execute(args) {
      await backend.claim(args.id);
      return `claimed #${args.id}`;
    },
  };
  return { tracker_list: list as Tool, tracker_claim: claim as Tool };
}

/**
 * The frontier projection (#36): open issues partitioned into in-progress
 * (claimed), ready (unblocked), and blocked. Backends without dependency
 * data produce `deps: false`, and callers degrade to a flat list.
 */
export interface Frontier {
  /** Whether any issue carries dependency data. */
  deps: boolean;
  inProgress: TrackerIssue[];
  ready: TrackerIssue[];
  blocked: TrackerIssue[];
}

export function projectFrontier(issues: TrackerIssue[]): Frontier {
  const open = issues.filter((i) => i.state === "open");
  const closed = new Set(issues.filter((i) => i.state === "closed").map((i) => i.id));
  const deps = open.some((i) => i.blockedBy.length > 0);
  const claimed = open.filter((i) => i.assignees.length > 0);
  const pending = open.filter((i) => !i.assignees.length);
  const blocked = deps ? pending.filter((i) => i.blockedBy.some((b) => !closed.has(b))) : [];
  return {
    deps,
    inProgress: claimed,
    ready: pending.filter((i) => !blocked.includes(i)),
    blocked,
  };
}
