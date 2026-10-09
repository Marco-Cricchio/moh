/**
 * Retro findings (ADR-0075, #1274): the accumulation half.
 *
 * A retro-maintenance pass extracts structured findings —
 * `{ category, evidence, confidence, session, signature }` — from a
 * closed session's event log, deterministically (no model call), into an
 * append-only, bounded, deduplicated store under
 * `~/.moh/projects/<slug>/retro/`, modeled on the ADR-0049 miss-report
 * corpus. It never touches steering files, config, or the prompt:
 * consumption happens only at consent (`moh retro`, #1275).
 *
 * The evidence signature is `category + observation fingerprint` (a
 * stable hash); dedup on append means the same observation from a later
 * session adds nothing. A durable dismissed-signatures set lives beside
 * the store and suppresses re-append of dismissed signatures — a
 * materially new observation is a new signature, eligible again.
 *
 * Categories are plain strings: the vocabulary evolves without a format
 * break, exactly as ADR-0075 requires. Evidence is user data (principle
 * 5): project dotdir, redacted at persistence like every other path
 * (ADR-0058). Writing is fail-silent and can never fail a dispose.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { redactString } from "./redact";
import { projectSlug } from "./session-store";
import type { AgentEvent } from "./types";

/** moh.json `retro` block; `retro.enabled: false` disables everything. */
export const retroConfigSchema = z.object({
  enabled: z.boolean().optional(),
  /** Store directory override (tests, clients). */
  dir: z.string().optional(),
});

export type RetroOptions = z.infer<typeof retroConfigSchema>;

/** One accumulated finding. Categories are plain strings by design. */
export interface RetroFinding {
  category: string;
  /** What was observed, one line, no secrets (redacted at persistence). */
  evidence: string;
  /** 0..1; mechanical detections sit high, heuristics lower. */
  confidence: number;
  /** The session that produced the observation. */
  session: string;
  /** `category + observation fingerprint` — the dedup and dismissal identity. */
  signature: string;
  appendedAt: string;
}

/** A finding as extraction produces it, before the store stamps `appendedAt`. */
export interface RetroCandidate {
  category: string;
  evidence: string;
  confidence: number;
  session: string;
  signature: string;
}

/** Distinct findings kept; beyond this the oldest (`appendedAt`) goes. */
export const RETRO_MAX_FINDINGS = 200;
/** Chars of evidence kept per finding (the session log holds the rest). */
export const RETRO_EVIDENCE_CHARS = 300;
/** Digest cadence (ADR-0075): at most one per 48 hours. */
export const RETRO_DIGEST_INTERVAL_MS = 48 * 60 * 60 * 1000;
/** Repeated dismissals raise a category's bar (ADR-0075): each dismissal
 * adds this to the minimum confidence that category must clear. */
export const RETRO_THRESHOLD_STEP = 0.05;
/** The bar a category can never exceed — beyond it extraction would be
 * silent rather than selective. */
export const RETRO_THRESHOLD_CAP = 0.9;

const FINDINGS_FILE = "findings.jsonl";
const DISMISSED_FILE = "dismissed.json";
const DIGEST_FILE = "digest.json";
const JUDGMENT_FILE = "judgment.json";

/** The stable identity: category plus an observation fingerprint. */
/** ADR-0075's threshold rule, in one place: each dismissal of a category
 * adds `RETRO_THRESHOLD_STEP` to the confidence bar that category must
 * clear, capped at `RETRO_THRESHOLD_CAP`. */
function thresholdFor(category: string, dismissals: ReadonlyArray<RetroDismissal>): number {
  const count = dismissals.filter((record) => record.category === category).length;
  return Math.min(RETRO_THRESHOLD_CAP, count * RETRO_THRESHOLD_STEP);
}

export function retroSignature(category: string, observation: string): string {
  return createHash("sha256").update(`${category}\u0000${observation}`).digest("hex").slice(0, 32);
}

function cleanEvidence(evidence: string): string {
  const cleaned = evidence.replace(/\s+/g, " ").trim();
  return cleaned.length > RETRO_EVIDENCE_CHARS ? `${cleaned.slice(0, RETRO_EVIDENCE_CHARS - 1)}…` : cleaned;
}

interface DigestState {
  lastDigest: string;
}

/** The judgement pipeline's threshold state (ADR-0075): closed sessions
 * counted since the last batch run, plus when that run happened. */
interface JudgmentState {
  closedSinceBatch: number;
  lastRunAt?: string;
}

export interface RetroDismissal {
  signature: string;
  category: string;
  dismissedAt: string;
}

export interface RetroReportFinding extends RetroFinding {
  priorDismissals: RetroDismissal[];
  lineage: string | null;
}

export interface RetroReport {
  findings: RetroReportFinding[];
  dismissed: RetroDismissal[];
}

/** The per-project retro store. Writes are atomic (temp + rename);
 * `findings.jsonl` only ever grows, except for the bounded eviction. */
export class RetroStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** <mohHome>/projects/<slug>/retro — sibling of the memory dir. */
  static forProject(cwd: string, mohHome = join(homedir(), ".moh")): RetroStore {
    return new RetroStore(join(mohHome, "projects", projectSlug(cwd, join(mohHome, "..")), "retro"));
  }

  get findingsFile(): string {
    return join(this.dir, FINDINGS_FILE);
  }

  /** Reads the findings, oldest first; a missing or corrupt file is empty. */
  read(): RetroFinding[] {
    if (!existsSync(this.findingsFile)) return [];
    try {
      const findings: RetroFinding[] = [];
      for (const line of readFileSync(this.findingsFile, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const p = JSON.parse(trimmed) as Partial<RetroFinding>;
          if (typeof p.category === "string" && typeof p.evidence === "string" && typeof p.signature === "string") {
            findings.push({
              category: p.category,
              evidence: p.evidence,
              confidence: typeof p.confidence === "number" ? p.confidence : 0,
              session: typeof p.session === "string" ? p.session : "",
              signature: p.signature,
              appendedAt: typeof p.appendedAt === "string" ? p.appendedAt : "",
            });
          }
        } catch {
          // A torn line is skipped, never fatal: losing one finding
          // cannot lose a session.
        }
      }
      return findings;
    } catch {
      return [];
    }
  }

  /**
   * Appends candidates, skipping any whose signature already exists in
   * the store or in the dismissed set. Bounded: beyond
   * `RETRO_MAX_FINDINGS` the oldest findings are evicted. Evidence is
   * redacted at persistence (ADR-0058). Returns how many were appended.
   * Never throws.
   */
  append(candidates: ReadonlyArray<RetroCandidate>, now = new Date()): number {
    if (candidates.length === 0) return 0;
    try {
      const existing = this.read();
      const records = this.dismissalRecords();
      const dismissed = new Set(records.map((record) => record.signature));
      const seen = new Set(existing.map((f) => f.signature));
      const appended: RetroFinding[] = [];
      for (const c of candidates) {
        if (!c.category.trim() || seen.has(c.signature) || dismissed.has(c.signature)) continue;
        // ADR-0075: repeated dismissals make extraction stricter instead
        // of re-proposing the same shape of finding.
        if (c.confidence < thresholdFor(c.category.trim(), records)) continue;
        seen.add(c.signature);
        appended.push({
          category: c.category.trim(),
          evidence: cleanEvidence(redactString(c.evidence)),
          confidence: Math.min(1, Math.max(0, c.confidence)),
          session: c.session,
          signature: c.signature,
          appendedAt: now.toISOString(),
        });
      }
      if (appended.length === 0) return 0;
      const kept = [...existing, ...appended].slice(-RETRO_MAX_FINDINGS);
      this.#writeFindings(kept);
      return appended.length;
    } catch {
      return 0; // accumulation is fail-silent, never a dispose failure
    }
  }

  /** The durable dismissed-signature set (ADR-0075: rejecting is a
   * durable user decision; the UX that calls this is #1275). */
  dismissed(): Set<string> {
    return new Set(this.dismissalRecords().map((record) => record.signature));
  }

  dismissalRecords(): RetroDismissal[] {
    try {
      const parsed = JSON.parse(readFileSync(join(this.dir, DISMISSED_FILE), "utf8")) as {
        signatures?: Record<string, string | { category?: string; dismissedAt?: string }>;
      };
      const findings = new Map(this.read().map((finding) => [finding.signature, finding.category]));
      return Object.entries(parsed.signatures ?? {}).map(([signature, value]) => ({
        signature,
        category: typeof value === "string" ? findings.get(signature) ?? "unknown" : value.category ?? findings.get(signature) ?? "unknown",
        dismissedAt: typeof value === "string" ? value : value.dismissedAt ?? "",
      })).sort((a, b) => a.dismissedAt.localeCompare(b.dismissedAt));
    } catch {
      return [];
    }
  }

  report(): RetroReport {
    const dismissed = this.dismissalRecords();
    const byCategory = new Map<string, RetroDismissal[]>();
    for (const record of dismissed) {
      const list = byCategory.get(record.category) ?? [];
      list.push(record);
      byCategory.set(record.category, list);
    }
    const dismissedSignatures = new Set(dismissed.map((record) => record.signature));
    const findings = this.read().filter((finding) => !dismissedSignatures.has(finding.signature)).map((finding) => ({
      ...finding,
      priorDismissals: byCategory.get(finding.category) ?? [],
      lineage: (byCategory.get(finding.category) ?? []).at(-1)?.dismissedAt ?? null,
    })).sort((a, b) => b.confidence - a.confidence || a.appendedAt.localeCompare(b.appendedAt));
    return { findings, dismissed };
  }

  /**
   * ADR-0075: repeated dismissals of a category raise the confidence bar
   * that category must clear — `RETRO_THRESHOLD_STEP` per dismissal,
   * capped at `RETRO_THRESHOLD_CAP`. Stricter extraction, never a silent
   * re-proposal. Derived from the durable dismissals, so it survives
   * eviction of the dismissed finding itself.
   */
  thresholdFor(category: string): number {
    return thresholdFor(category, this.dismissalRecords());
  }

  dismiss(signature: string, opts: { category?: string; now?: Date } = {}): void {
    const now = opts.now ?? new Date();
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const file = join(this.dir, DISMISSED_FILE);
      let signatures: Record<string, string | { category?: string; dismissedAt?: string }> = {};
      try {
        signatures = (JSON.parse(readFileSync(file, "utf8")) as { signatures?: Record<string, string | { category?: string; dismissedAt?: string }> }).signatures ?? {};
      } catch {
        // fresh set
      }
      // The category rides the record so a dismissal keeps its lineage
      // and its threshold after the finding itself is evicted.
      const known = opts.category ?? this.read().find((finding) => finding.signature === signature)?.category;
      signatures[signature] = known
        ? { category: known, dismissedAt: now.toISOString() }
        : now.toISOString();
      this.#writeAtomic(file, `${JSON.stringify({ version: 1, signatures }, null, 2)}\n`);
    } catch {
      // fail-silent
    }
  }

  /**
   * The session-start digest (ADR-0075): one line when findings
   * accumulated since the last digest, rate-limited to one per 48
   * hours, suppressed while the report is open in the same session
   * (`reportOpen` — the report replaces the digest, and the timestamp
   * still moves so the reviewed batch is not re-digested). Returns
   * null when silent. Never throws.
   */
  maybeDigest(now = new Date(), opts: { reportOpen?: boolean } = {}): { count: number; line: string } | null {
    try {
      let lastDigest = "";
      try {
        const parsed = JSON.parse(readFileSync(join(this.dir, DIGEST_FILE), "utf8")) as DigestState;
        lastDigest = typeof parsed.lastDigest === "string" ? parsed.lastDigest : "";
      } catch {
        // never digested: everything counts
      }
      const since = lastDigest ? new Date(lastDigest).getTime() : 0;
      if (!opts.reportOpen && Number.isFinite(since) && now.getTime() - since < RETRO_DIGEST_INTERVAL_MS) return null;
      const stamp = since > 0 ? new Date(since).toISOString() : "";
      const fresh = this.read().filter((f) => !stamp || f.appendedAt > stamp);
      const count = opts.reportOpen ? 0 : fresh.length;
      if (!opts.reportOpen && count === 0) return null;
      const head = fresh.reduce<RetroFinding | null>(
        (best, f) => (best === null || f.confidence > best.confidence ? f : best),
        null,
      );
      const line =
        count === 0
          ? "retro findings were reviewed in the open report — run `moh retro` for the full report"
          : `${count} new retro finding${count === 1 ? "" : "s"}${head ? ` (head: ${head.category})` : ""} — run \`moh retro\` to review`;
      this.#writeAtomic(join(this.dir, DIGEST_FILE), `${JSON.stringify({ lastDigest: now.toISOString() } satisfies DigestState)}\n`);
      return { count, line };
    } catch {
      return null;
    }
  }

  /**
   * ADR-0075 judgement threshold: one closed session counted toward the
   * next batch. Returns the running count. Never throws.
   */
  noteClosedSession(): number {
    try {
      const state = this.#readJudgment();
      const closedSinceBatch = state.closedSinceBatch + 1;
      this.#writeAtomic(
        join(this.dir, JUDGMENT_FILE),
        `${JSON.stringify({ version: 1, closedSinceBatch, ...(state.lastRunAt ? { lastRunAt: state.lastRunAt } : {}) }, null, 2)}\n`,
      );
      return closedSinceBatch;
    } catch {
      return 0;
    }
  }

  /** Closed sessions counted since the last judgement batch run. */
  closedSinceBatch(): number {
    return this.#readJudgment().closedSinceBatch;
  }

  /** True when the batch threshold is reached. */
  judgmentDue(batch: number): boolean {
    return this.closedSinceBatch() >= batch;
  }

  /** Records a completed batch run: the counter restarts at zero. */
  markJudgmentRun(now = new Date()): void {
    try {
      this.#writeAtomic(
        join(this.dir, JUDGMENT_FILE),
        `${JSON.stringify({ version: 1, closedSinceBatch: 0, lastRunAt: now.toISOString() }, null, 2)}\n`,
      );
    } catch {
      // fail-silent
    }
  }

  #readJudgment(): JudgmentState {
    try {
      const parsed = JSON.parse(readFileSync(join(this.dir, JUDGMENT_FILE), "utf8")) as JudgmentState;
      return {
        closedSinceBatch: typeof parsed.closedSinceBatch === "number" && parsed.closedSinceBatch >= 0 ? parsed.closedSinceBatch : 0,
        ...(typeof parsed.lastRunAt === "string" ? { lastRunAt: parsed.lastRunAt } : {}),
      };
    } catch {
      return { closedSinceBatch: 0 };
    }
  }

  #writeFindings(findings: ReadonlyArray<RetroFinding>): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    let mode = 0o600;
    try { mode = statSync(this.findingsFile).mode & 0o777; } catch { /* new file */ }
    const tmp = `${this.findingsFile}.tmp-${process.pid}`;
    writeFileSync(tmp, findings.map((f) => JSON.stringify(f)).join("\n") + "\n", { mode });
    renameSync(tmp, this.findingsFile);
  }

  #writeAtomic(file: string, body: string): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, file);
  }
}

/** Tools that indicate real work happened; guardrail checks only fire
 * for a session that actually touched the repo. */
const WORK_TOOLS = new Set(["bash", "edit", "write", "multiedit", "notebookedit"]);
/** A bash command re-issued this many times in one session is a spike. */
const REPEAT_THRESHOLD = 3;
/** Timed-out tool calls before the timeout pattern fires. */
const TIMEOUT_THRESHOLD = 2;

function head(text: string, max = 120): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * Deterministic mechanical extraction over a closed session's event log
 * — no model call, run at session close. The same event log (and the
 * same repository state) always produces the same candidates.
 *
 * Categories (plain strings, ADR-0075):
 * - `missing-guardrail` — a check exists in package.json but nothing
 *   wires it: no pre-commit hook, no CI job running it. The
 *   existing-but-unwired check IS the finding, not a reinvention.
 * - `tool-economy` — the same expensive bash command re-issued within
 *   one session (the #304 rerun ledger's territory), or repeated tool
 *   timeouts.
 *
 * Returns nothing for a session that used no tools.
 */
export function extractRetroFindings(
  events: ReadonlyArray<AgentEvent>,
  opts: { cwd: string; session: string },
): RetroCandidate[] {
  const calls = events.filter((e) => e.type === "tool_call");
  if (calls.length === 0) return [];
  const results = new Map<string, Extract<AgentEvent, { type: "tool_result" }>>();
  for (const e of events) {
    if (e.type === "tool_result") results.set(e.callId, e);
  }
  const session = opts.session;
  const candidates: RetroCandidate[] = [];

  // (a) Missing guardrails — only where package.json names the checks.
  const didWork = calls.some((c) => WORK_TOOLS.has(c.name));
  const pkgFile = join(opts.cwd, "package.json");
  if (didWork && existsSync(pkgFile)) {
    let scripts: Record<string, unknown> = {};
    try {
      scripts = (JSON.parse(readFileSync(pkgFile, "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {};
    } catch {
      // unreadable package.json: no guardrail facts derivable
    }
    const checks = ["lint", "test"].filter((s) => typeof scripts[s] === "string");
    if (checks.length > 0) {
      if (!isExecutable(join(opts.cwd, ".git", "hooks", "pre-commit"))) {
        candidates.push({
          category: "missing-guardrail",
          evidence: `package.json defines ${checks.map((c) => `\`${c}\``).join(" and ")} but no pre-commit hook runs ${checks.length === 1 ? "it" : "them"}`,
          confidence: 0.8,
          session,
          signature: retroSignature("missing-guardrail", "pre-commit:unwired"),
        });
      }
      if (!ciRunsChecks(opts.cwd, checks)) {
        candidates.push({
          category: "missing-guardrail",
          evidence: `package.json defines ${checks.map((c) => `\`${c}\``).join(" and ")} but no CI workflow job runs ${checks.length === 1 ? "it" : "them"}`,
          confidence: 0.8,
          session,
          signature: retroSignature("missing-guardrail", "ci:unwired"),
        });
      }
    }
  }

  // (b) Tool-economy spikes.
  const bashByCommand = new Map<string, number>();
  for (const c of calls) {
    if (c.name !== "bash") continue;
    const command = typeof (c.args as { command?: unknown })?.command === "string" ? (c.args as { command: string }).command : "";
    if (command) bashByCommand.set(command, (bashByCommand.get(command) ?? 0) + 1);
  }
  for (const [command, count] of bashByCommand) {
    if (count < REPEAT_THRESHOLD) continue;
    candidates.push({
      category: "tool-economy",
      evidence: `the same bash command was issued ${count} times this session: \`${head(command)}\``,
      confidence: 0.5,
      session,
      signature: retroSignature("tool-economy", `bash-repeat:${command}`),
    });
  }
  const timeouts = [...results.values()].filter((r) => r.errorKind === "timeout").length;
  if (timeouts >= TIMEOUT_THRESHOLD) {
    candidates.push({
      category: "tool-economy",
      evidence: `${timeouts} tool calls timed out this session`,
      confidence: 0.6,
      session,
      signature: retroSignature("tool-economy", "timeouts"),
    });
  }

  return candidates;
}

function isExecutable(file: string): boolean {
  try {
    return (statSync(file).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** True when any GitHub Actions workflow runs one of the named checks. */
function ciRunsChecks(cwd: string, checks: string[]): boolean {
  const dir = join(cwd, ".github", "workflows");
  if (!existsSync(dir)) return false;
  try {
    for (const name of readdirSync(dir)) {
      if (!/\.(ya?ml)$/.test(name)) continue;
      const text = readFileSync(join(dir, name), "utf8");
      if (checks.some((c) => new RegExp(`\\b${c}\\b`).test(text))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

import { readdirSync } from "node:fs";
