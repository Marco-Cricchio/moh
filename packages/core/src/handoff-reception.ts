/**
 * Session Handoff T3 (#436): the receiving side — discovery, newest-wins
 * comparison, stale marking, and the seeded-session opening context.
 *
 * Reception (#433 implementation decisions): the receiving machine never
 * replays the handoff as an event log. It creates a **new session**
 * seeded with the handoff rendered as a turn-scoped skill prompt
 * (PromptComposer pattern, ADR-0011 — the same seam `/ask-moh` uses),
 * so the handoff context lives exactly one turn as opening context.
 *
 * Newest-wins: at startup the fetched gist handoff is compared with the
 * newest local session; only a handoff that is genuinely newer is
 * offered (story 3), warning when it supersedes local work. A handoff
 * whose anchor SHA is not HEAD is marked **stale** and its seed prompt
 * says so, instructing reconciliation via git instead of silent trust
 * (story 5). Discovery failures are silent `{ status: "none" }` results:
 * an offline or gh-less machine just sees today's home screen (story 15).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { HandoffGitAnchor, RawHandoff } from "./handoff";
import { gitAnchor, HandoffRunner } from "./handoff";
import { listSessionSummaries, type SessionSummary } from "./session-store";
import { readRawHandoff, type HandoffPayload, type HandoffTransport } from "./handoff-transport";
import type { SkillPrompt } from "./types";

export interface DiscoverHandoffOptions {
  cwd: string;
  /** OS home (`~`); defaults to the real one. Derived paths use `<home>/.moh`. */
  home?: string;
  transport: HandoffTransport;
  /** Budget for the whole fetch. Default: 3000ms (startup must not hang). */
  timeoutMs?: number;
  /** Git anchor override (tests). Absent = live `gitAnchor(cwd)`. */
  git?: HandoffGitAnchor;
  /** Local session listing override (tests). */
  listLocal?: () => SessionSummary[];
  /** Local raw-artifact reader override (tests). Default: the project's
   * `<home>/.moh/projects/<slug>/handoff.json`. */
  readLocalArtifact?: () => RawHandoff | undefined;
}

/** The startup discovery outcome. Everything but `offer` means: nothing
 * to surface — the ordinary home flow stands. */
export type HandoffOffer =
  | { status: "none" }
  /** The newest local session is at least as new as the handoff. */
  | { status: "local-current" }
  /** The handoff is this machine's own publish (same session id). */
  | { status: "own-session" }
  | {
      status: "offer";
      payload: HandoffPayload;
      url: string;
      /** True when the anchor SHA is not HEAD (story 5). */
      stale: boolean;
    };

/** Runs a promise under a deadline (mirrors handoff-transport's). */
function deadline<T>(p: Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  return Promise.race([
    p,
    new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), timeoutMs).unref?.();
    }),
  ]);
}

/**
 * Startup discovery: fetches the newest published handoff and compares
 * it with the newest local session. Ordering key is the handoff's
 * `updatedAt` (last completed turn on the origin machine) against the
 * local session file's mtime. Own-session detection compares the
 * payload's internal sessionId against the **local raw artifact** (same
 * internal id, `session-xxxxxxxx`) — file basenames are a different id
 * space and never match. Never throws and never hangs: any failure
 * (offline, gh missing, timeout, unparsable gist) is `{ status: "none" }`.
 */
export async function discoverHandoff(options: DiscoverHandoffOptions): Promise<HandoffOffer> {
  const raced = await deadline(
    options.transport.fetch().catch(() => null),
    options.timeoutMs ?? 3_000,
  );
  if (raced === "timeout" || raced === null || !raced.ok) return { status: "none" };
  const { payload, url } = raced;
  const home = options.home ?? homedir();
  const local = (options.listLocal ?? (() => listSessionSummaries(options.cwd, home)))();
  const localArtifact =
    options.readLocalArtifact?.() ?? readRawHandoff(HandoffRunner.artifactFile(options.cwd, join(home, ".moh")));
  if (localArtifact?.sessionId === payload.sessionId) return { status: "own-session" };
  const newest = local[0];
  if (newest && Date.parse(payload.updatedAt) <= newest.mtimeMs) return { status: "local-current" };
  return { status: "offer", payload, url, stale: isHandoffStale(payload, options.cwd, options.git) };
}

/**
 * Stale marking (story 5): a handoff is current only when its anchor
 * SHA equals HEAD. Anything else — a different SHA, a missing anchor,
 * an unresolvable HEAD — is stale: never silently trusted, always
 * reconciled (the seed prompt carries the instruction).
 */
export function isHandoffStale(payload: RawHandoff, cwd: string, git?: HandoffGitAnchor): boolean {
  if (!payload.git?.head) return true;
  const current = git ?? gitAnchor(cwd);
  return current.head !== payload.git.head;
}

/** Short human timestamp for chrome ("2026-09-02 16:04"). */
function shortStamp(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Date(parsed).toISOString().slice(0, 16).replace("T", " ");
}

function section(title: string, lines: string[]): string {
  if (lines.length === 0) return "";
  return `\n## ${title}\n${lines.map((l) => `- ${l}`).join("\n")}\n`;
}

/** The seed skill prompt (ADR-0011 turn-scoped): the handoff rendered
 * as the opening context of exactly one turn. English like every
 * composed prompt section. */
export function handoffSeedPrompt(offer: Extract<HandoffOffer, { status: "offer" }>): SkillPrompt {
  const p = offer.payload;
  const anchorLines = [`branch: ${p.git?.branch ?? "unknown"}`, `SHA: ${p.git?.head ?? "unknown"}`];
  if (offer.stale) {
    anchorLines.push(
      "STALE: this SHA is not the current HEAD — before trusting the file list below, reconcile with git (`git log <sha>..HEAD`, `git diff <sha> <paths>`); the origin machine's state may predate local changes.",
    );
  }
  const text =
    `# Session handoff received\n` +
    `You are resuming work transferred from another machine via a moh session handoff (published ${shortStamp(p.updatedAt)} UTC). Treat the state below as the prior working context; verify against the repository before acting on it.` +
    section(
      "Working state",
      [
        `last user message: ${p.lastUserMessage || "(none)"}`,
        `last assistant reply: ${p.lastAssistantMessage || "(none)"}`,
        `turns completed: ${p.turns} (tool calls ${p.counts.toolCalls}, errors ${p.counts.errors}, cancelled ${p.counts.cancelled})`,
      ],
    ) +
    section("Git anchor", anchorLines) +
    section("Files touched (first-seen order)", p.files) +
    section("Test commands run", p.tests);
  return { name: "handoff-context", text };
}

/** The user-visible seed message sent with the prompt: one line, with
 * the stale warning when it applies (story 3/5). */
export function handoffSeedMessage(offer: Extract<HandoffOffer, { status: "offer" }>): string {
  const base = `Continuing from the session handoff published ${shortStamp(offer.payload.updatedAt)} UTC (branch ${offer.payload.git?.branch ?? "unknown"}).`;
  return offer.stale
    ? `${base}\n\nWarning: this handoff is stale (its git anchor is not the current HEAD) — reconcile via git diff before trusting it.`
    : base;
}
