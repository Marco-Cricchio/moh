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
import { readImportedHandoff } from "./handoff-file";
import { handoffDebug } from "./handoff-debug";
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
  /** Parked manual import reader override (tests, T7 #440). Default:
   * the project's `<home>/.moh/projects/<slug>/imported-handoff.json`. */
  readImported?: () => RawHandoff | undefined;
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
/**
 * Bounded startup discovery (story 15). The deadline must cover the
 * WHOLE fetch chain — 2–3 sequential `gh` child processes (user
 * lookup, gist list, gist view), each paying CLI startup + keyring
 * cost. Field evidence (#680 follow-up, PC B): 3s cut the chain after
 * the first call, so every machine with a slightly slow gh saw no
 * offer row, ever; the e2e simulation measured `gh api user` alone at
 * ~0.5s and full chains past 3s on a healthy network. 10s keeps the
 * discovery bounded (it runs once at Home mount, never blocking
 * render) while actually accommodating the real chain.
 */
export const DISCOVERY_DEADLINE_MS = 10_000;

export async function discoverHandoff(options: DiscoverHandoffOptions): Promise<HandoffOffer> {
  const raced = await deadline(
    options.transport.fetch().catch(() => null),
    options.timeoutMs ?? DISCOVERY_DEADLINE_MS,
  );
  if (raced === "timeout" || raced === null || !raced.ok) {
    // No reachable gist handoff — a parked manual import (T7 #440) can
    // still be newer than the local session; offer it when so.
    handoffDebug(raced === "timeout" ? "fetch-timeout" : "fetch-error", {
      outcome: raced === "timeout" ? "timeout" : raced === null ? "thrown" : raced.error,
    });
    return offerFromImport(options);
  }
  handoffDebug("fetch-ok", { sessionId: raced.payload.sessionId, updatedAt: raced.payload.updatedAt, url: raced.url });
  const imported = (options.readImported ?? (() => readImportedHandoff(options.cwd, options.home)))();
  const home = options.home ?? homedir();
  const local = (options.listLocal ?? (() => listSessionSummaries(options.cwd, home)))();
  const localArtifact =
    options.readLocalArtifact?.() ?? readRawHandoff(HandoffRunner.artifactFile(options.cwd, join(home, ".moh")));
  // Rediscovering your own publish (gist or re-imported export) is a no-op.
  if (localArtifact?.sessionId === raced.payload.sessionId) {
    handoffDebug("decision", { status: "own-session", artifactSessionId: localArtifact.sessionId });
    return { status: "own-session" };
  }
  // Newest handoff candidate wins (story 21: newest state wins regardless
  // of producing machine): fetched gist vs parked manual import.
  let candidate: { payload: HandoffPayload; url: string } = { payload: raced.payload, url: raced.url };
  if (imported && Date.parse(imported.updatedAt) > Date.parse(candidate.payload.updatedAt)) {
    if (localArtifact?.sessionId === imported.sessionId) {
      handoffDebug("decision", { status: "own-session", source: "imported", artifactSessionId: localArtifact.sessionId });
      return { status: "own-session" };
    }
    candidate = { payload: imported, url: "imported file" };
  }
  const newest = local[0];
  if (newest && Date.parse(candidate.payload.updatedAt) <= newest.mtimeMs) {
    handoffDebug("decision", {
      status: "local-current",
      candidateUpdatedAt: candidate.payload.updatedAt,
      newestLocalMtimeMs: newest.mtimeMs,
      newestLocalFile: newest.file,
    });
    return { status: "local-current" };
  }
  const offer = {
    status: "offer",
    payload: candidate.payload,
    url: candidate.url,
    stale: isHandoffStale(candidate.payload, options.cwd, options.git),
  } as const;
  handoffDebug("decision", { status: "offer", url: offer.url, stale: offer.stale });
  return offer;
}

/** T7 (#440) import fallback path: reached when no gist handoff was
 * reachable at all. A parked manual import that is genuinely newer than
 * the newest local session is offered; own-session imports are silently
 * dropped — importing your own export back is a no-op, exactly like
 * rediscovering your own gist publish. */
function offerFromImport(options: DiscoverHandoffOptions): HandoffOffer {
  const imported = (options.readImported ?? (() => readImportedHandoff(options.cwd, options.home)))();
  if (!imported) return { status: "none" };
  const home = options.home ?? homedir();
  const local = (options.listLocal ?? (() => listSessionSummaries(options.cwd, home)))();
  const localArtifact =
    options.readLocalArtifact?.() ?? readRawHandoff(HandoffRunner.artifactFile(options.cwd, join(home, ".moh")));
  if (localArtifact?.sessionId === imported.sessionId) return { status: "own-session" };
  const newest = local[0];
  if (newest && Date.parse(imported.updatedAt) <= newest.mtimeMs) return { status: "local-current" };
  return {
    status: "offer",
    payload: imported,
    url: "imported file",
    stale: isHandoffStale(imported, options.cwd, options.git),
  };
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
    section(
      "Wayfinder",
      p.wayfinder
        ? [
            ...p.wayfinder.tickets.map((ticket) =>
              `${ticket.relations.join(" + ")}: ${ticket.url ? `[${ticket.title}](${ticket.url})` : `#${ticket.id} ${ticket.title}`}`,
            ),
            `frontier: ${p.wayfinder.frontier.ready} ready · ${p.wayfinder.frontier.inProgress} in progress · ${p.wayfinder.frontier.blocked} blocked`,
          ]
        : [],
    ) +
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
