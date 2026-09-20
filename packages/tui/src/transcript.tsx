import React, { useMemo } from "react";
import { Box, Text } from "ink";
import type { AgentEvent } from "@moh/core";
import type { Theme } from "./themes";
import { useTheme } from "./themes";
import { sanitizeLine, truncate } from "./ui";
import { sanitizeForDisplay } from "./render-sanitize";
import { createMarkdownRenderer, Markdown, MarkdownRows, wrapRenderedLines } from "./markdown";
import { formatDuration, formatTimeout } from "./tool-timing";
import { askUserQuestionSummary } from "./permission-gate";
import type { ToolTimings } from "./tool-timing";
import type { ToolTailMap } from "./tool-progress";
import type { PreviewImage } from "./image-preview";
export type BlockKind = "user" | "moh" | "code" | "diff" | "tool" | "error" | "chrome" | "thinking" | "subagent" | "info";
export interface TranscriptBlock {
  key: string;
  kind: BlockKind;
  glyph: string;
  type: string;
  detail?: string;
  lines: string[];
  /** Original assistant prose, retained for terminal Markdown rendering. */
  markdown?: string;
  /** Pre-rendered terminal rows take precedence over source Markdown.
   * Row chunks use continuation + tight to avoid adding spacing. */
  readonly renderedMarkdownRows?: readonly string[];
  /** True for paragraphs that continue an assistant reply already started
   * above: they render without their own head row so one reply reads as one
   * continuous output (#205). */
  continuation?: boolean;
  /** True for a list-item segment that directly follows another list item
   * (tight list): it renders without the inter-block blank row so a split
   * list still reads as one list (#226). */
  tight?: boolean;
  lineKinds?: Array<"body" | "heading" | "bullet" | "ask" | "answer">;
  state?: "run" | "ok" | "fail";
  usage?: { inputTokens: number; outputTokens: number };
  /** #300: timing metadata for tool blocks — the callId pairing the block
   * with the live ledger, the event's effective `timeoutMs` limit, and
   * (once a result exists in this window) the call→result duration. Pure
   * data: rendering decides what to show. */
  callId?: string;
  timeoutMs?: number;
  durationMs?: number;
  /** Vision note 4 (#490): the image attachment this user row cites, when
   * the message carried one. The transcript renderer emits it place-once
   * after the row's stable paint; identity rides the block itself so the
   * caller never has to match log indices to projection keys. */
  image?: PreviewImage;
}

/** Vibe phrasing for a tool call (#193): plain language, no raw command. */
/** One row of the resolved ask_user Static projection (#413): a question
 * line (kind "ask") or its answer line (kind "answer"). */
export interface AskUserProjectionEntry {
  line: string;
  kind: "ask" | "answer";
}

/** The compact Static projection of a resolved ask_user set (#413, spec
 * #411/#412): one row per question — the question itself, then "↳ you:"
 * with the chosen answers parsed back from the tool_result output —
 * unchosen options omitted. Shared by the volatile block: while the set is
 * open, each unanswered question projects alone (state "run" keeps it
 * volatile via settledBoundary); once the result arrives, the same walker
 * attaches the answers. Legacy single-question args (pre-ADR-0019 replay)
 * fall back to the old two-row shape through `legacyDetail`. */
export function askUserProjectionEntries(
  args: unknown,
  resultOutput: string | undefined,
  legacyDetail: () => string,
): AskUserProjectionEntry[] {
  const a = (args ?? {}) as { questions?: unknown };
  if (!Array.isArray(a.questions)) {
    // Legacy single-question shape: one question row + one answer row.
    const question = askUserQuestionSummary(a) ?? legacyDetail();
    const line = sanitizeForDisplay(question);
    return [
      { line, kind: "ask" },
      ...(resultOutput !== undefined && resultOutput !== "" ? [{ line: `↳ you: ${sanitizeLine(resultOutput)}`, kind: "answer" as const }] : []),
    ];
  }
  const questions = a.questions as ReadonlyArray<{ question?: unknown }>;
  return questions.flatMap((q) => {
    const text = typeof q.question === "string" ? q.question : "";
    const answer = resultOutput !== undefined ? askUserAnswerFor(resultOutput, text) : undefined;
    return [
      { line: sanitizeForDisplay(text), kind: "ask" as const },
      ...(answer !== undefined ? [{ line: `↳ you: ${sanitizeLine(answer)}`, kind: "answer" as const }] : []),
    ];
  });
}

/** Pulls a question's answer out of the tool_result output produced by the
 * core's `formatAskUserSetResult` (one "Q: a" line per question; question
 * text is unique in the set). Matches on the `"<question>: "` prefix rather
 * than position, so a colon inside the question text cannot misalign the
 * parse. Unanswerable (cancelled sets, drifted shape) → undefined: no
 * answer row is invented. */
function askUserAnswerFor(output: string, question: string): string | undefined {
  if (question === "") return undefined;
  const prefix = `${question}: `;
  const line = output.split("\n").find((l) => l.startsWith(prefix));
  return line !== undefined ? line.slice(prefix.length) : undefined;
}

/** Vibe plain-language verbs for tool activity (#193). */
const TOOL_ACTION: Record<string, string> = {


  read: "read a file",
  write: "wrote a file",
  edit: "edited a file",
  glob: "looked for files",
  grep: "searched the code",
  fetch: "fetched a page",
  todo: "updated the plan",
  bash: "ran a command",
};

/** The file-ish detail vibe shows (a path or pattern, not a command line). */
const vibeDetail = (name: string, args: unknown): string => {
  if (!args || typeof args !== "object") return "";
  const rec = args as Record<string, unknown>;
  // Search tools: the pattern says what was looked for, the path is noise.
  if (name === "glob" || name === "grep") {
    if (typeof rec.pattern === "string") return sanitizeForDisplay(rec.pattern).split("\n")[0]!;
  }
  const path = rec.path ?? rec.file;
  if (typeof path === "string") return sanitizeForDisplay(path).split("\n")[0]!;
  if (name === "fetch" && typeof rec.url === "string") return sanitizeForDisplay(rec.url).split("\n")[0]!;
  return "";
};

/** Vibe hint for a shell command (#215): enough to tell what kind of
 * thing is running — and what it is acting on — without being the full
 * command line. Owner feedback (#751 follow-up): two words truncated
 * prematurely (`ran a command · cat >>` — on what? `gh pr` — doing what?),
 * so the hint now carries the command plus its meaningful arguments and
 * stops at the first shell-control word, capped. */
const vibeCommandHint = (args: unknown): string => {
  if (!args || typeof args !== "object") return "";
  const command = (args as { command?: unknown }).command;
  if (typeof command !== "string" || !command.trim()) return "";
  // #749-adjacent regression: multi-line payloads whose first lines are
  // comments (`# Check: …`) leaked into the vibe hint. Lead with the first
  // executable line, mirroring bashDetail.
  const lines = sanitizeForDisplay(command).trim().split("\n");
  const executable = lines.find((line) => line.trim() !== "" && !line.trimStart().startsWith("#")) ?? lines.find((line) => line.trim() !== "") ?? "";
  const words = executable.trim().split(/\s+/)
    // Skip leading env assignments (FOO=bar cmd) and wrappers (cd x && cmd)
    .filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) && word !== "&&" && word !== ";");
  const picked: string[] = [];
  let pendingRedirect = false;
  for (const word of words.slice(1)) {
    // A single redirection target is part of the story (`cat >> log.txt`);
    // anything past it — more redirections, pipes, control words — is not.
    const isRedirect = word === ">" || word === ">>" || word === "<" || word === "<<";
    if (word === "|" || word === "||" || word === "&" || word === ";") break;
    if (pendingRedirect) {
      picked.push(word);
      break;
    }
    if (isRedirect) {
      picked.push(word);
      pendingRedirect = true;
      continue;
    }
    picked.push(word);
  }
  const hint = [words[0]?.split("/").pop() ?? "", ...picked].filter(Boolean).join(" ");
  return hint.length > 48 ? `${hint.slice(0, 47)}…` : hint;
};

/** Compact bash titles lead with the executable line rather than narration.
 * The command itself stays untouched on the event, for expansion and replay. */
const bashDetail = (command: string): string => {
  const lines = sanitizeLine(command).split("\n");
  const executable = lines.find((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  return executable ?? lines.find((line) => line.trim() !== "") ?? "";
};

const detailOf = (args: unknown, toolName?: string): string => {
  if (!args || typeof args !== "object") return "";
  const rec = args as Record<string, unknown>;
  for (const key of ["command", "path", "file", "pattern", "query", "url"]) {
    if (typeof rec[key] === "string") return key === "command" && toolName === "bash"
      ? bashDetail(rec[key])
      : sanitizeLine(String(rec[key])).split("\n")[0]!;
  }
  let rendered: string;
  try { rendered = JSON.stringify(args); } catch { rendered = String(args); }
  return truncate(sanitizeLine(rendered), 100);
};

/** Preserve source identity when a projection starts inside an assistant run. */
export function assistantRunOrigin(events: readonly AgentEvent[], start: number): { startIndex: number; sourceOffset: number; previousLine: string } | undefined {
  if (events[start]?.type !== "assistant_delta" || events[start - 1]?.type !== "assistant_delta") return undefined;
  let first = start;
  while (first > 0 && events[first - 1]?.type === "assistant_delta") first--;
  let prefix = "";
  for (let i = first; i < start; i++) {
    const event = events[i]!;
    if (event.type === "assistant_delta") prefix += sanitizeForDisplay(event.text);
  }
  return { startIndex: first, sourceOffset: prefix.length, previousLine: prefix.trimEnd().split("\n").at(-1) ?? "" };
}

/** ADR-0032 (#784): the one line an `extension_event` gets. The payload is
 * `unknown` by contract (the core never inspects it), so every field is
 * narrowed defensively: a shape this renderer does not recognize degrades to
 * the bare event name — it never guesses and never throws.
 *
 * `jev_judgment` (the Jev guardrail's record, #786) is phrased as
 * `jev · guardrail · ask (destructive 0.42)`: the event name minus its
 * `_judgment` suffix names the product, then the payload's `useCase` and
 * `decision`, then the key probability the verdict was based on (#843) —
 * not the first answer, which may be an `in_scope` the verdict ignored. A
 * routing judgment
 * (#787) reads `jev · routing · switch to a/big` instead — its payload has
 * no numeric question to inline. `jev_routing` (the router's own notices:
 * a misconfigured label, an unpriced model, a manual override) gets one
 * short line per kind. */
export function extensionEventLine(name: string, payload: unknown): string {
  const record = asRecord(payload);
  if (record === undefined) return name;
  if (name === "jev_routing") return routingNoticeLine(record);
  if (name === "jev_usecase") return useCaseLine(record);
  if (!name.endsWith("_judgment")) return name;
  if (record.useCase === "routing") return routingJudgmentLine(record);
  if (record.useCase === "injection") return injectionJudgmentLine(record);
  if (record.useCase === "guardrail" || record.useCase === "guardrail_passes") return guardrailJudgmentLine(record);
  const parts = [name.slice(0, -"_judgment".length)];
  if (typeof record.useCase === "string" && record.useCase !== "") parts.push(record.useCase);
  if (typeof record.decision === "string" && record.decision !== "") parts.push(record.decision);
  const first = Object.entries(asRecord(record.questions) ?? {})[0];
  // Only a numeric answer is short enough to be worth reading inline; the
  // distribution shapes (choice/score) stay in the log for /jev-style views.
  if (first !== undefined && typeof first[1] === "number" && Number.isFinite(first[1])) {
    parts[parts.length - 1] = `${parts[parts.length - 1]} (${first[0]} ${first[1]})`;
  }
  return parts.join(" · ");
}

/** ADR-0038: the short form of a control payload (`{ cmd: "off" }` → `off`).
 * #832: the uniform grammar names the use case first (`injection off`). */
function controlCommandLine(payload: Record<string, unknown> | undefined): string {
  if (payload?.cmd === "usecase") {
    const usecase = typeof payload.usecase === "string" && payload.usecase !== "" ? payload.usecase : "?";
    const action = typeof payload.action === "string" && payload.action !== "" ? payload.action : "?";
    return `${usecase} ${action}`;
  }
  const cmd = payload?.cmd;
  return typeof cmd === "string" && cmd !== "" ? cmd : "control";
}

/**
 * #832: one line per per-use-case control change. The asymmetry is the whole
 * point of the line — a warm `on` for a use case the config left off must
 * say so, and so must a warm `off` for one the config leaves on, because the
 * very next session starts from the config again. A refusal is a refusal:
 * nothing pretends the command landed. Anything unrecognized degrades to the
 * use case and action, never to a guess.
 */
function useCaseLine(record: Record<string, unknown>): string {
  const usecase = typeof record.usecase === "string" ? record.usecase : "?";
  const action = typeof record.action === "string" ? record.action : "?";
  const refused = typeof record.refused === "string" ? record.refused : undefined;
  if (refused === "unknown-usecase") return `jev · ${usecase} · not a Jev use case`;
  if (refused === "unknown-action") return `jev · ${usecase} · "${action}" is not a command (on, off${usecase === "routing" ? ", auto" : ""})`;
  if (refused === "unavailable") return `jev · ${usecase} · ${action} refused — not available in this session`;
  if (refused === "unsupported") return `jev · ${usecase} · "${action}" belongs to model routing`;
  const note = typeof record.note === "string" ? record.note : undefined;
  if (note !== undefined) return `jev · ${usecase} · ${action} for this session — ${note}`;
  if (record.sessionOnly === true) {
    return `jev · ${usecase} · ${action} for this session — the config still says ${record.config === true ? "on" : "off"}`;
  }
  return `jev · ${usecase} · ${action} for this session`;
}

/** #787: the router's notices — one line each, never a warning, never a
 * turn error. An unknown kind degrades to the bare product name. */
function routingNoticeLine(record: Record<string, unknown>): string {
  const kind = typeof record.kind === "string" ? record.kind : "";
  if (kind === "ignored-label" && typeof record.ref === "string") {
    return `jev · routing · label ${record.ref} ignored (not in the model pool)`;
  }
  if (kind === "unpriced" && typeof record.count === "number") {
    return `jev · routing · ${record.count} model(s) have no catalog price → bilanciato`;
  }
  if (kind === "listing-failed" && typeof record.message === "string") {
    return `jev · routing · ${record.message}`;
  }
  if (kind === "inert") return "jev · routing · inert (fewer than two tiers to choose from)";
  if (kind === "override" && typeof record.model === "string") {
    return `jev · routing · suspended by your manual model switch (${record.model})`;
  }
  // #847: the serving model is not the one the router picked — name both sides.
  if (kind === "mismatch" && typeof record.current === "string" && typeof record.expected === "string") {
    return `jev · routing · serving ${record.current}, router picked ${record.expected}`;
  }
  return "jev · routing";
}

/**
 * #791: one anti-injection judgment. The mid band is the whole point of
 * the line — it is the visible warning the user gets instead of a silent
 * pass — and a `sensitive`-driven warning carries the advice the record
 * brought with it (its copy lives in the extension, not here). The confirm
 * band's outcome reads as what happened to the turn: sent anyway,
 * cancelled (nothing was sent), or refused in headless.
 */
function injectionJudgmentLine(record: Record<string, unknown>): string {
  const decision = typeof record.decision === "string" ? record.decision : "judgment";
  const injection = typeof record.injection === "number" ? record.injection : 0;
  const sensitive = typeof record.sensitive === "number" ? record.sensitive : 0;
  const where = typeof record.source === "string" && record.source.startsWith("tool:")
    ? ` (${record.source.slice("tool:".length)} result withheld)`
    : "";
  if (decision === "cancelled") return "jev · injection · cancelled — nothing was sent";
  if (decision === "refused-headless") return "jev · injection · refused — possible injection, nothing was sent";
  if (decision === "confirmed") return `jev · injection · sent anyway (injection ${injection.toFixed(2)})`;
  if (decision === "withheld") return `jev · injection · withheld${where} (injection ${injection.toFixed(2)})`;
  if (decision === "warn") {
    const advice = typeof record.advice === "string" ? record.advice : undefined;
    if (advice !== undefined) return `jev · injection · warn (sensitive ${sensitive.toFixed(2)} — ${advice})`;
    return `jev · injection · warn (injection ${injection.toFixed(2)})`;
  }
  return `jev · injection · ${decision} (injection ${injection.toFixed(2)})`;
}

/** #786, #843: one guardrail judgment — the verdict, and on an ask/deny the
 * key dimension and probability it was based on. A `pass` never reaches
 * this line (the projection filters it); old logs without a `decision`
 * degrade to the use-case-only line rather than inventing a verdict. */
function guardrailJudgmentLine(record: Record<string, unknown>): string {
  // #846: the turn's aggregate — one line for all the passing judgments.
  if (record.useCase === "guardrail_passes") {
    const calls = typeof record.calls === "number" && Number.isFinite(record.calls) ? record.calls : undefined;
    return calls === undefined ? "jev · guardrail · passed" : `jev · guardrail · ${calls} calls passed`;
  }
  const decision = typeof record.decision === "string" && record.decision !== "" ? record.decision : undefined;
  if (decision === undefined) return "jev · guardrail";
  const key = typeof record.keyProbability === "number" && Number.isFinite(record.keyProbability)
    ? record.keyProbability
    : undefined;
  if (key === undefined) return `jev · guardrail · ${decision}`;
  const dimension = typeof record.keyDimension === "string" && record.keyDimension !== "" ? record.keyDimension : "destructive";
  return `jev · guardrail · ${decision} (${dimension} ${key.toFixed(2)})`;
}

/** #787: one routing judgment — what the router decided, and why. */
function routingJudgmentLine(record: Record<string, unknown>): string {
  const tier = typeof record.tier === "string" ? record.tier : undefined;
  if (record.decision === "switch") {
    const target = typeof record.target === "string" ? record.target : tier;
    return `jev · routing · switch to ${target}${tier ? ` (${tier})` : ""}`;
  }
  const reason = typeof record.reason === "string" ? record.reason : "stay";
  return `jev · routing · stay (${reason})`;
}

/**
 * #791, #843: the judgments the transcript leaves out. The record is in the
 * log (every judgment is), the line is not: an injection pass below the
 * warn threshold and a guardrail `pass` changed nothing the user could act
 * on — a line each would be the noise the threshold exists to avoid. A
 * guardrail record with no `decision` (pre-#843 log) keeps its old line:
 * replay never rewrites history.
 */
function isSilentInjection(name: string, payload: unknown): boolean {
  if (name !== "jev_judgment") return false;
  const record = asRecord(payload);
  if (record === undefined) return false;
  if (record.useCase === "injection") return record.decision === "silent" || record.decision === "pass";
  if (record.useCase === "guardrail") return record.decision === "pass";
  return false;
}

/**
 * #845: which Jev records survive **vibe** mode. Vibe is the plain-language
 * projection — a Jev-heavy turn must not read as a wall of `◈ jev · …`
 * lines — but the records that tell the user Jev is earning its keep stay:
 * an anti-injection verdict that changed what the user saw or sent, a
 * guardrail `ask`/`deny` (the notable outcomes), a real routing `switch`,
 * a quality-gate `correct` (a correction turn is running), a skill that was
 * actually suggested, and the user's own use-case control lines (including
 * refusals). Everything else — passes, stays, classifications, rerank
 * records, router notices — drops from the transcript only: the event log
 * is never filtered, this is a projection option (the vibe contract).
 * Phrased on the event `name` + `payload`, never on rendered strings — the
 * renderer stays the single place that turns a record into a line. Dev
 * mode never consults this: its output is byte-for-byte today's.
 */
function survivesVibe(name: string, payload: unknown): boolean {
  if (name === "jev_usecase") return true;
  // The router's notices (unpriced, ignored-label, inert, mismatch) are
  // chatter in vibe; the one exception is the `override` — the echo of the
  // user's own manual model switch, their command like a control line.
  if (name === "jev_routing") return asRecord(payload)?.kind === "override";
  if (name === "jev_skill_suggest") {
    const record = asRecord(payload);
    return record?.suggested !== undefined && record.suggested !== null;
  }
  if (name !== "jev_judgment") return true;
  const record = asRecord(payload);
  if (record === undefined) return true;
  const decision = typeof record.decision === "string" ? record.decision : undefined;
  switch (record.useCase) {
    case "injection":
      // Anything that changed what the user saw or sent; the silent/pass
      // band is already dropped in both modes (isSilentInjection).
      return decision !== undefined && decision !== "silent" && decision !== "pass";
    case "guardrail":
      return decision === "ask" || decision === "deny";
    case "routing":
      return decision === "switch";
    case "lint":
      return decision === "correct";
    default:
      // classification, rerank and any future judgment: measured, not read.
      return false;
  }
}

/** A JSON object as an inspectable record; anything else (arrays, null,
 * primitives, a getter that throws) is not something to read fields from. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Complete, deterministic projection of the append-only event log. Events
 * may be grouped (assistant deltas, tool call/result), but none disappear
 * without an intentional chrome representation.
 *
 * `mode` (#193): `dev` renders the full technical grammar; `vibe` is the
 * plain-language view over the same log — metric/chrome blocks drop, tool
 * activity collapses to one plain-language line (unresolved calls keep
 * `state: "run"` so the pending marker stays live), failures always show.
 * The log itself is never filtered: this is a projection option only. */
export function projectTranscript(events: ReadonlyArray<AgentEvent>, options: { mode?: "vibe" | "dev"; filePreview?: "always" | "on-demand" | "none"; keyBase?: number; /** True when the slice begins mid-reply (live tail): its first paragraph is a continuation (#205). */ proseContinuation?: boolean; initialAssistantRun?: ReturnType<typeof assistantRunOrigin>; /** #242: render persisted provider reasoning blocks (display-only
   * projection; the log is never filtered). Default: hidden. */ showReasoning?: boolean; /** #300: wall-clock ledger for tool timing (limit + final duration);
   * presentation-only, never part of the log. */ toolTimings?: ToolTimings; /** #liveness: live scrolling tails (last lines) of running tools'
   * partial output — ephemeral, volatile blocks only. */ toolTails?: ToolTailMap } = {}): TranscriptBlock[] {
  const vibe = options.mode === "vibe";
  const keyBase = options.keyBase ?? 0;
  const blocks: TranscriptBlock[] = [];
  const results = new Map<string, Extract<AgentEvent, { type: "tool_result" }>>();
  for (const event of events) if (event.type === "tool_result") results.set(event.callId, event);
  // #320: subagent results link to their spawn by callId (same pair
  // pattern as tool calls) so one block projects with its final state —
  // never mutating after Static promotion (#194).
  const subagentResults = new Map<string, Extract<AgentEvent, { type: "subagent_result" }>>();
  for (const event of events) if (event.type === "subagent_result") subagentResults.set(event.callId, event);
  // #326: the log persists a completed call's reasoning at flush time —
  // after that call's text deltas — but the reasoning block must render
  // ABOVE the reply. The projection reorders each call's group above the
  // delta run that precedes it (pure display order; the log is never
  // rewritten, and block keys keep the original log index so #329 sealed
  // heads still match).
  const ordered = orderReasoningAboveReply(events);

  for (let i = 0; i < ordered.length; i++) {
    const { event, index } = ordered[i]!;
    const key = `${keyBase + index}-${event.type}`;
    switch (event.type) {
      case "user_message": {
        // Vision note 4 (#490): an image attachment rides its citing row.
        const image = (event.attachments ?? []).find((a) => a.kind === "image");
        // ADR-0037: a synthetic turn is machine-triggered — the reader
        // must never mistake it for something a human typed.
        const synthetic = event.synthetic === true;
        blocks.push({
          key,
          kind: "user",
          glyph: synthetic ? "»" : "›",
          type: synthetic ? "synthetic" : "you",
          lines: (synthetic ? `[automatic correction] ${event.text}` : event.text)
            .split("\n")
            .map(sanitizeForDisplay),
          ...(image ? { image: { name: image.path, mime: image.mime, base64: image.content, width: image.width, height: image.height } } : {}),
        });
        break;
      }
      case "mention_warnings":
        // #488: denied/missing @mentions surface visibly — never a silent drop.
        blocks.push({
          key,
          kind: "info",
          glyph: "!",
          type: "mention",
          lines: event.warnings.map((w) => sanitizeForDisplay(`@${w.path} — ${w.reason}`)),
        });
        break;
      case "assistant_delta": {
        const origin = index === 0 ? options.initialAssistantRun : undefined;
        const runKey = origin ? `${origin.startIndex}-assistant_delta` : key;
        const sourceOffset = origin?.sourceOffset ?? 0;
        let text = sanitizeForDisplay(event.text);
        while (ordered[i + 1]?.event.type === "assistant_delta") text += sanitizeForDisplay((ordered[++i] as { event: Extract<AgentEvent, { type: "assistant_delta" }> }).event.text);
        let lastItemLine = origin?.previousLine ?? "";
        // One reply, many append-only segments (#205): the terminal Markdown
        // renderer owns fences/tables/headings inline, but a whole reply as
        // ONE block would grow after Static promotion and ink never reprints
        // a promoted item — later paragraphs would vanish. Each closed
        // segment becomes its own never-mutating block; continuation
        // segments render without a head row so the reply still reads as one
        // continuous output.
        for (const segment of assistantSegments(text)) {
          const first = segment.text.split("\n")[0] ?? "";
          const tight = tightItemBoundary(lastItemLine, first);
          blocks.push(proseBlock(`${runKey}-p${sourceOffset + segment.start}`, segment.text, sourceOffset + segment.start > 0 || !!options.proseContinuation, tight));
          lastItemLine = segment.text.trimEnd().split("\n").at(-1) ?? "";
        }
        break;
      }
      case "tool_call": {
        const result = results.get(event.callId);
        const state = result ? (result.ok ? "ok" : "fail") : "run";
        // #300 timing metadata: the callId links the block to the live
        // ledger; the limit rides the event; the duration exists once the
        // result is visible in this projection window.
        const timing = options.toolTimings?.get(event.callId);
        const timingFields = {
          callId: event.callId,
          ...(typeof event.timeoutMs === "number" && Number.isFinite(event.timeoutMs) ? { timeoutMs: event.timeoutMs } : {}),
          ...(timing?.durationMs !== undefined ? { durationMs: timing.durationMs } : {}),
        };
        // Fetch output is page-sized minified noise in any mode: vibe's
        // plain-language collapse (URL only, no body) applies to dev too (#219).
        if (event.name === "fetch") {
          if (state !== "fail") {
            blocks.push({ key, kind: "moh", glyph: "◆", type: "moh", lines: [vibeDetail("fetch", event.args) ? `fetched a page · ${vibeDetail("fetch", event.args)}` : "fetched a page"], state });
            break;
          }
          blocks.push({ key, kind: "error", glyph: "✗", type: "fetch", detail: detailOf(event.args, event.name), lines: result?.output.split("\n").slice(0, 5).map(sanitizeLine) ?? [], state: "fail" });
          break;
        }
        // ask_user (#70, set shape #411, Static projection #413): one row
        // per question plus one answer row each (the chosen answers land
        // in the tool_result output); unchosen options are omitted — the
        // settled block is the compact record, not a replay of the whole
        // interactive block. Legacy single-question args still render.
        if (event.name === "ask_user") {
          // Failed validation attempts render as a one-line retry record,
          // NOT the full arguments: repeating the whole question for every
          // failed attempt made the question appear N times before the
          // inline popup (production session a1dfb4c8 — GLM retry loops).
          const entries = result?.ok === false
            ? [{ line: `retry — ${sanitizeLine(result.output.split("\n")[0] ?? "validation failed")}`, kind: "answer" as const }]
            : askUserProjectionEntries(event.args, result?.output, () => detailOf(event.args));
          if (entries.length > 0) {
            blocks.push({
              key,
              kind: "moh",
              glyph: "?",
              type: "ask",
              lines: entries.map((entry) => entry.line),
              lineKinds: entries.map((entry) => entry.kind),
              state,
              ...timingFields,
            });
          }
          break;
        }
        // #liveness: a running tool with live partial output shows its
        // scrolling tail (last lines, dim) inside the volatile block.
        // Settled blocks keep the usual result cap — determinism #194.
        const liveTail = state === "run" ? options.toolTails?.get(event.callId) : undefined;
        // Computed before the vibe branch: the todo box is always fully
        // open (both modes — vibe's plain-language collapse never hides it).
        const todoLines = event.name === "todo" && event.args && typeof event.args === "object"
          ? (event.args as { todos?: Array<{ content?: unknown; status?: unknown; activeForm?: unknown }> }).todos
              ?.filter((t) => typeof t.content === "string" && t.content !== "")
              .map((t) => `${t.status === "done" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]"} ${t.content as string}`)
          : undefined;
        if (vibe) {
          // The todo box is always fully open (both modes): vibe's
          // plain-language collapse must never hide the task list — the
          // user watches progress on it (regression: vibe showed only the
          // one-line "updated the plan" head, no list).
          if (todoLines) {
            blocks.push({
              key,
              kind: "moh",
              glyph: "◆",
              type: "plan",
              lines: todoLines,
              state,
              ...timingFields,
            });
            break;
          }
          if (state !== "fail") {
            const action = TOOL_ACTION[event.name] ?? `used ${event.name}`;
            const target = event.name === "bash" ? vibeCommandHint(event.args) : vibeDetail(event.name, event.args);
            blocks.push({ key, kind: "moh", glyph: "◆", type: "moh", lines: [target ? `${action} · ${target}` : action], state, ...timingFields });
            break;
          }
          blocks.push({ key, kind: "error", glyph: "✗", type: event.name, detail: detailOf(event.args, event.name), lines: result?.ok === false ? result.output.split("\n").slice(0, 5).map(sanitizeLine) : [], state: "fail" });
          break;
        }
        blocks.push({
          key,
          kind: "tool",
          glyph: state === "ok" ? "✓" : state === "fail" ? "✗" : "◌",
          type: event.name,
          detail: detailOf(event.args, event.name),
          // The todo box is always fully open (both modes): the task list
          // is the one tool output that reads as a persistent panel, not
          // a log. Other tools: settled = usual cap; running = live tail.
          lines: todoLines ?? (event.name !== "read" && (result?.output || liveTail?.length)
            ? (liveTail?.length ? liveTail : result!.output.split("\n")).slice(0, state === "run" && liveTail?.length ? liveTail.length : options.filePreview === "always" ? 15 : 5).map(sanitizeLine)
            : []),
          state,
          ...timingFields,
        });
        if (event.name === "read" && result?.ok && options.filePreview !== "none") {
          const start = event.args && typeof event.args === "object" && typeof (event.args as { offset?: unknown }).offset === "number" ? (event.args as { offset: number }).offset : 1;
          const previewLines = result.output.split("\n").slice(0, options.filePreview === "always" ? 15 : 5);
          blocks.push({ key: `${key}-preview`, kind: "code", glyph: "⌨", type: "preview", detail: `${detailOf(event.args, event.name)} · ${start}–${start + Math.max(0, previewLines.length - 1)}`, lines: previewLines.map((line, lineIndex) => `${String(start + lineIndex).padStart(3)} │ ${sanitizeLine(line)}`) });
        }
        break;
      }
      case "tool_result":
        if (!ordered.some((candidate) => candidate.event.type === "tool_call" && candidate.event.callId === event.callId)) {
          blocks.push({ key, kind: "tool", glyph: event.ok ? "✓" : "✗", type: "tool result", detail: event.callId, lines: event.output.split("\n").map(sanitizeLine), state: event.ok ? "ok" : "fail" });
        }
        break;
      case "permission_requested":
        blocks.push({ key, kind: "tool", glyph: "◌", type: "permission", detail: `${event.tool} · requested`, lines: [], state: "run" });
        break;
      case "permission_granted":
        // Auto-accept grants are ambient mode, not news: one block per tool
        // call only adds noise (#215). Explicit grants still show.
        if (event.reason === "auto_accept" || event.reason === "yolo") break;
        blocks.push({ key, kind: "tool", glyph: "✓", type: "permission", detail: `${event.tool} · allowed (${event.reason})`, lines: [], state: "ok" });
        break;
      case "permission_denied":
        blocks.push({ key, kind: "tool", glyph: "⊘", type: "permission", detail: `${event.tool} · denied`, lines: [event.reason], state: "fail" });
        break;
      case "permission_rule_added":
        blocks.push({ key, kind: "chrome", glyph: "◈", type: "permission rule", detail: JSON.stringify(event.rule), lines: [] });
        break;
      case "permission_rules_restored":
        blocks.push({ key, kind: "chrome", glyph: "◈", type: "restored permission rules", detail: `${event.rules.length} restored`, lines: event.rules.map(sanitizeLine) });
        break;
      case "model_call":
        // The model line closes the turn instead (#213): per-call blocks
        // appear mid-turn and after every prompt; `done` reports the models
        // that actually served the turn, and only then is the line final
        // (settled blocks must never mutate after Static promotion, #194).
        break;
      case "done":
        if (vibe) break;
        // End-of-turn chrome (#213): one `model` line only, carried by
        // `done` so it is written once when the model's reply turn ends.
        // The usage line is gone entirely.
        if (event.models?.length) blocks.push({ key, kind: "chrome", glyph: "─", type: "model", detail: event.models.join(", "), lines: [] });
        break;
      case "error":
        blocks.push({ key, kind: "error", glyph: "✗", type: "error", detail: event.reason, lines: [event.message], state: "fail" });
        break;
      case "cancelled":
        blocks.push({ key, kind: "chrome", glyph: "◌", type: "cancelled", detail: "steering · turn interrupted", lines: [] });
        break;
      case "subagent_spawn": {
        const result = subagentResults.get(event.callId);
        const state = result ? (result.status === "done" ? "ok" : "fail") : "run";
        const tokens = result ? `${((result.usage.inputTokens + result.usage.outputTokens) / 1000).toFixed(1)}k tok` : "running";
        if (vibe && state !== "fail") {
          blocks.push({ key, kind: "subagent", glyph: "◇", type: event.name, lines: [`ran a subagent · ${event.name}${event.preset ? ` (${event.preset})` : ""}`], state });
          break;
        }
        blocks.push({
          key,
          kind: "subagent",
          glyph: state === "ok" ? "✓" : state === "fail" ? "✗" : "◇",
          type: event.name,
          detail: `${event.preset ? `${event.preset} · ` : ""}${result ? result.status : "running"} · ${tokens}`,
          lines: result?.preview ? result.preview.split("\n").map(sanitizeLine) : [],
          state,
        });
        break;
      }
      case "subagent_result":
        // Projects through its spawn block (#320) — nothing of its own.
        break;
      case "session_start":
        if (vibe) break;
        blocks.push({ key, kind: "chrome", glyph: "◈", type: "session started", detail: `prompt ${event.promptVersion.slice(0, 8)}`, lines: [] });
        break;
      case "session_mode":
        if (vibe) break;
        blocks.push({ key, kind: "chrome", glyph: "◈", type: "permission mode", detail: event.mode, lines: [] });
        break;
      case "skill_invoked":
        if (vibe) break;
        blocks.push({ key, kind: "chrome", glyph: "◈", type: "skill", detail: event.name, lines: [] });
        break;
      case "model_switched":
        if (vibe) break;
        blocks.push({ key, kind: "chrome", glyph: "◈", type: "model switched", detail: `${event.from} → ${event.to} (next turn)`, lines: [] });
        break;
      case "fallback":
        // ADR-0012: a fallback stop is turn chrome — the toast is the
        // timely notice; this block is the durable record for replay.
        blocks.push({ key, kind: "chrome", glyph: "↻", type: "fallback", detail: `${event.from} → ${event.to}`, lines: [event.reason] });
        break;
      case "route_serving":
        // #363: selected and serving routes are distinct session state.
        blocks.push({ key, kind: "chrome", glyph: "↻", type: "serving route", detail: `${event.selected} · ${event.serving}`, lines: [] });
        break;
      case "memory_updated":
        if (vibe) break;
        blocks.push({ key, kind: "chrome", glyph: "◈", type: "memory updated", detail: event.topics.join(", "), lines: [] });
        break;
      case "compaction":
        if (vibe) break;
        blocks.push({ key, kind: "chrome", glyph: "▣", type: "context compacted", lines: [event.summary.split("\n").slice(0, 3).join("\n")] });
        break;
      case "session_resumed":
        // ADR-0021: resume-open marker; visible on replay as chrome.
        blocks.push({ key, kind: "chrome", glyph: "↻", type: "resumed", detail: "", lines: [] });
        break;
      case "session_renamed":
        // #477: rename marker; visible on replay as chrome.
        blocks.push({ key, kind: "chrome", glyph: "✎", type: "renamed", detail: event.name === "" ? "(reset)" : event.name, lines: [] });
        break;
      case "session_file_growth":
        // #400 single-writer guard: visible on replay too (headless resume
        // of a file that once grew from elsewhere shows why history may
        // interleave). Never hidden in vibe mode: it is a data warning.
        // #576: the payload names both tips — the log now legitimately
        // holds two paths from the fork point, so fork is advice, not the
        // only recovery.
        blocks.push({
          key,
          kind: "error",
          glyph: "✗",
          type: "session file grew from elsewhere",
          detail: `${event.expectedBytes} → ${event.actualBytes} bytes`,
          lines: [
            ...(event.localTip && event.foreignTip
              ? [`local tip ${event.localTip} · foreign tip ${event.foreignTip}`]
              : []),
            "Concurrent use of one session file is unsupported; fork the session, or switch back to your local tail to resolve.",
          ],
          state: "fail",
        });
        break;
      case "branch_switched":
        // #576: head moved — chrome on replay; one primitive for switch,
        // rewind and #400 divergence adoption.
        blocks.push({ key, kind: "chrome", glyph: "⑂", type: "branch switched", detail: event.to, lines: [] });
        break;
      case "branch_dangling":
        // #576 (head semantics d10): the head target is absent from the
        // file — visible fallback warning, never silent corruption.
        blocks.push({
          key,
          kind: "error",
          glyph: "⚠",
          type: "dangling branch switch",
          detail: event.to,
          lines: ["The switch target is missing from the log (truncated or corrupted file); the last valid event is the head instead."],
          state: "fail",
        });
        break;
      case "compaction_failed":
        // #466/ADR-0022: chrome on replay too — why no marker exists yet.
        if (vibe) break;
        blocks.push({ key, kind: "error", glyph: "⚠", type: "compaction failed", detail: event.reason, lines: ["The producer retries on later turns; /compact forces one now."] });
        break;
      case "compaction_dangling":
        // #578 (d6): the newest on-path marker's pointer does not resolve —
        // context restarted from the session start, visibly.
        blocks.push({
          key,
          kind: "error",
          glyph: "⚠",
          type: "dangling compaction pointer",
          lines: ["The compaction pointer does not resolve on this session's active path (truncated or corrupted file); context was rebuilt from the session start."],
          state: "fail",
        });
        break;
      case "extension_loaded":
        if (vibe) break;
        blocks.push({ key, kind: "chrome", glyph: "◈", type: "extension loaded", detail: `${event.name} ${event.version}`, lines: [] });
        break;
      case "extension_control":
        // ADR-0038: a client command addressed to one extension — the
        // extension's own record (an `extension_event`) explains what it
        // did with it, so this one line only names the command.
        blocks.push({
          key,
          kind: "chrome",
          glyph: "◈",
          type: `${event.extension} · ${controlCommandLine(event.payload)}`,
          lines: [],
        });
        break;
      case "extension_event":
        // ADR-0032 (#784): an extension's own chrome record — one dim line.
        // The renderer stays generic: only the records this client can
        // phrase get a summary, every other name renders as itself. The
        // one record that renders nothing is the anti-injection check's
        // `silent`/`pass` band (#791): the log keeps every judgment, but
        // the low band is *silent* — the whole point of the threshold is
        // that an unremarkable turn gains no line.
        // is *silent* — the whole point of the threshold is that an
        // unremarkable turn gains no line.
        //
        // #845: vibe mode keeps only the Jev lines that earn their keep —
        // the same audit trail stays whole in dev mode and in the log.
        if (isSilentInjection(event.name, event.payload)) break;
        if (vibe && !survivesVibe(event.name, event.payload)) break;
        blocks.push({ key, kind: "chrome", glyph: "◈", type: extensionEventLine(event.name, event.payload), lines: [] });
        break;
      case "session_note":
        // One informational startup line (e.g. a bundled integration that
        // stayed inactive): information, never a warning — dim, no glyph
        // beyond the marker that says "this is chrome".
        blocks.push({ key, kind: "chrome", glyph: "·", type: event.text, lines: [] });
        break;
      case "extension_failed":
        blocks.push({ key, kind: "error", glyph: "✗", type: "extension failed", detail: event.name, lines: [event.message], state: "fail" });
        break;
      case "mcp_server_started":
        if (vibe) break;
        blocks.push({ key, kind: "chrome", glyph: "◈", type: "MCP started", detail: `${event.server} · ${event.tools.length} tools`, lines: [] });
        break;
      case "mcp_server_failed":
        blocks.push({ key, kind: "error", glyph: "✗", type: "MCP failed", detail: event.server, lines: [event.message], state: "fail" });
        break;
      case "mcp_server_stopped":
        blocks.push({ key, kind: "chrome", glyph: "◈", type: "MCP stopped", detail: event.server, lines: [] });
        break;
      case "mcp_refused":
        blocks.push({ key, kind: "chrome", glyph: "⊘", type: "MCP refused", detail: `${event.server} · ${event.capability}`, lines: [] });
        break;
      case "reasoning": {
        // #242: completed provider reasoning of one model call, persisted
        // just before its `model_call` (#240). Rendered only when display
        // is on — toggling is projection-only, never a log change. The
        // model label comes from the call's `model_call`; a call that
        // failed keeps its block in error state.
        if (!options.showReasoning) break;
        // A provider call may persist several reasoning parts (#240). They
        // share one display buffer and one model-labelled block: the 64 KiB
        // limit is per call, not per persisted part.
        const texts = [event.text];
        let model = "model";
        let modelCallIndex = -1;
        for (let j = i + 1; j < ordered.length; j++) {
          const next = ordered[j]!.event;
          if (next.type === "reasoning") { texts.push(next.text); continue; }
          if (next.type === "model_call") {
            model = next.model;
            modelCallIndex = j;
          }
          break;
        }
        const previous = events[index - 1];
        const callEvent = modelCallIndex !== -1 ? ordered[modelCallIndex]!.event : undefined;
        const failed = modelCallIndex !== -1 && (
          (callEvent?.type === "model_call" && callEvent.failed === true)
          || ordered[modelCallIndex + 1]?.event.type === "error"
          || (previous?.type === "fallback" && previous.from === model)
        );
        // `previous` above is the ORIGINAL log neighbor (not the reordered
        // one): after the reorder a moved group can sit beside a fallback
        // event, and a same-model fallback must not stain it failed.
        blocks.push({
          key,
          kind: "thinking",
          glyph: "⋯",
          type: "thinking",
          detail: `· ${model}${failed ? " · failed" : ""}`,
          // Sanitize before enforcing the byte cap: tab expansion is part
          // of the displayed buffer and must not push it beyond 64 KiB.
          lines: capReasoningText(texts.join("\n\n").split("\n").map(sanitizeLine).join("\n")).split("\n"),
          ...(failed ? { state: "fail" as const } : {}),
        });
        // The grouped reasoning events and model_call have no other visual
        // projection; continue at the event after the call (usually error).
        if (modelCallIndex !== -1) i = modelCallIndex;
        break;
      }
      case "tree_bookmarked":
        // #579: chrome-only bookmark event — the /tree panel (#581) renders
        // bookmarked nodes from the log; the transcript has no projection.
        break;
      case "browser_unavailable":
        // #774: chrome-only diagnostic — surfaces render the warning from
        // the log; the transcript has no dedicated projection.
        break;
      default: {
        const exhaustive: never = event;
        throw new Error(`unhandled AgentEvent: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  // One final display boundary protects every event-log projection, including
  // chrome and error fields added after individual case projections.
  return blocks.map((block) => ({
    ...block,
    type: sanitizeForDisplay(block.type),
    detail: block.detail === undefined ? undefined : sanitizeForDisplay(block.detail),
    lines: block.lines.map(sanitizeForDisplay),
  }));
}

/** Returns log order with stable absolute indices. A completed provider
 * reasoning group is never retro-inserted above preceding deltas: once those
 * deltas are in Ink Static, doing so violates append-only terminal history
 * and caused the v0.21.1 duplicated agentic replies regression. */
export function orderReasoningAboveReply(events: ReadonlyArray<AgentEvent>): Array<{ event: AgentEvent; index: number }> {
  return events.map((event, index) => ({ event, index }));
}

/** #242: display buffer per reasoning call — 64 KiB. Projection-only:
 * the persisted log keeps the full text forever. */
export const REASONING_DISPLAY_CAP = 64 * 1024;

/** Tail-caps one reasoning text to the display buffer with a visible
 * truncation marker (#242 decision 7). The kept tail never exceeds the
 * cap; oversized reasoning therefore cannot destabilize the transcript. */
export function capReasoningText(text: string): string {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(text);
  if (encoded.byteLength <= REASONING_DISPLAY_CAP) return text;
  const marker = `… reasoning truncated — showing the last ${Math.round(REASONING_DISPLAY_CAP / 1024)} KiB (full text stays in the session log) …\n`;
  const markerBytes = encoder.encode(marker).byteLength;
  const tailBudget = REASONING_DISPLAY_CAP - markerBytes;
  let start = encoded.byteLength - tailBudget;
  // Start on a UTF-8 code-point boundary: a replacement glyph could make
  // the decoded display exceed the byte budget we just enforced.
  while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) start++;
  return marker + new TextDecoder().decode(encoded.subarray(start));
}

function proseBlock(key: string, prose: string, continuation = false, tight = false): TranscriptBlock {
  const raw = prose.split("\n");
  const lineKinds: Array<"body" | "heading" | "bullet"> = [];
  const lines = raw.map((line) => {
    if (/^#{1,6}\s+/.test(line)) { lineKinds.push("heading"); return line.replace(/^#{1,6}\s+/, ""); }
    if (/^\s*[-*]\s+/.test(line)) { lineKinds.push("bullet"); return line.replace(/^\s*[-*]\s+/, "· "); }
    lineKinds.push("body");
    return line;
  });
  return { key, kind: "moh", glyph: "◆", type: "moh", lines, lineKinds, markdown: prose, ...(continuation ? { continuation: true } : {}), ...(tight ? { tight: true } : {}) };
}

const LIST_ITEM = /^\s{0,3}(?:[-*+]|\d+[.)])\s+/;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

/** Tight-list item boundary (#226): consecutive list lines (no blank
 * between) each close a segment, so streaming promotes item-by-item
 * instead of holding the whole list volatile. Shared by the segment
 * splitter and the settled boundary so promotion granularity always
 * equals projection granularity. */
const tightItemBoundary = (prev: string, line: string): boolean => LIST_ITEM.test(prev) && LIST_ITEM.test(line);

/** Splits an assistant reply into promotable segments (#205). A segment
 * closes at a blank line outside code fences — but not between the items of
 * a loose list (GFM keeps it one list; splitting would restart numbering) —
 * or right after a closing fence (fence content is final once closed). The
 * final segment stays open while the reply streams. Shared by the
 * transcript projection and the settled/live boundary so a promoted prefix
 * never mutates after ink has printed it. */
export function assistantSegments(text: string): Array<{ start: number; end: number; text: string }> {
  const lines = text.split("\n");
  const offsets: number[] = [];
  let at = 0;
  for (const line of lines) { offsets.push(at); at += line.length + 1; }
  const segments: Array<{ start: number; end: number; text: string }> = [];
  let segStart = 0;
  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = line.match(FENCE_LINE);
    if (fence) {
      const marker = fence[1]!;
      const char = marker[0]! as "`" | "~";
      if (fenceChar === null) { fenceChar = char; fenceLen = marker.length; }
      else if (fenceChar === char && marker.length >= fenceLen && /^\s*$/.test(line.slice(fence[0].length))) {
        // Closed fence: the segment (prose + code) is final.
        fenceChar = null;
        const end = Math.min(text.length, offsets[i + 1] ?? text.length);
        segments.push({ start: segStart, end, text: text.slice(segStart, end) });
        segStart = end;
      }
      continue;
    }
    if (fenceChar !== null) continue;
    if (line.trim() === "") {
      const prev = lines[i - 1] ?? "";
      const next = lines[i + 1] ?? "";
      if (LIST_ITEM.test(prev) && LIST_ITEM.test(next)) continue; // loose list
      if (i + 1 >= lines.length) break; // trailing blank: nothing new opens
      const end = Math.min(text.length, offsets[i + 1] ?? text.length);
      if (next.trim() === "" ) continue;
      segments.push({ start: segStart, end, text: text.slice(segStart, end) });
      segStart = end;
      continue;
    }
    // Tight-list items close one by one (#226).
    if (i > 0 && tightItemBoundary(lines[i - 1]!, line)) {
      const end = offsets[i]!;
      segments.push({ start: segStart, end, text: text.slice(segStart, end) });
      segStart = end;
    }
  }
  if (segStart < text.length) segments.push({ start: segStart, end: text.length, text: text.slice(segStart) });
  return segments.filter((segment) => segment.text.trim().length > 0 || segments.length === 1);
}

/** Length of the reply prefix that is semantically final (last closed
 * segment). The settled/live boundary may promote up to here and no
 * further: everything after it can still grow (#205). */
export function closedPrefixLength(text: string): number {
  const lines = text.split("\n");
  let at = 0;
  let segStart = 0;
  let closed = 0;
  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const offset = at;
    at += line.length + 1;
    const fence = line.match(FENCE_LINE);
    if (fence) {
      const marker = fence[1]!;
      const char = marker[0]! as "`" | "~";
      if (fenceChar === null) { fenceChar = char; fenceLen = marker.length; }
      else if (fenceChar === char && marker.length >= fenceLen && /^\s*$/.test(line.slice(fence[0].length))) {
        fenceChar = null;
        closed = Math.min(text.length, at);
        segStart = closed;
      }
      continue;
    }
    if (fenceChar !== null) continue;
    if (line.trim() === "") {
      const prev = lines[i - 1] ?? "";
      const next = lines[i + 1] ?? "";
      // The final "" after a trailing \n is a split artifact, not a real
      // blank line (#227): text that merely ends a line can still be
      // extended into the same table/list by the next delta, and a promoted
      // prefix must never grow after ink has printed it. A real blank
      // (followed by another line) does close — GFM blocks cannot continue
      // across one.
      if (i + 1 >= lines.length) continue;
      if (LIST_ITEM.test(prev) && LIST_ITEM.test(next)) continue; // loose list
      // A blank after a list item with nothing after it yet may still turn
      // out to be a loose-list separator — wait for the next line.
      if (LIST_ITEM.test(prev) && next.trim() === "") continue;
      closed = Math.min(text.length, at);
      continue;
    }
    // Tight-list items are final one by one, in lockstep with
    // assistantSegments (#226).
    if (i > 0 && tightItemBoundary(lines[i - 1]!, line)) closed = offset;
  }
  return closed;
}

const mix = (a: string, b: string, amount: number): string => {
  const rgb = (value: string) => [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16));
  const aa = rgb(a), bb = rgb(b);
  return `#${aa.map((value, i) => Math.round(value * amount + bb[i]! * (1 - amount)).toString(16).padStart(2, "0")).join("")}`;
};

function blockColor(block: TranscriptBlock, theme: Theme): string {
  if (block.state === "fail" || block.kind === "error") return theme.err;
  if (block.state === "ok") return theme.ok;
  if (block.kind === "user") return theme.warn;
  if (block.kind === "code" || block.kind === "diff") return theme.purple;
  if (block.kind === "chrome" || block.kind === "thinking" || block.kind === "subagent") return theme.dim;
  return theme.accent;
}

export function blockTint(block: TranscriptBlock, theme: Theme): string | undefined {
  if (block.kind === "thinking") return undefined;
  const semantic = block.kind === "user" ? theme.warn : block.kind === "moh" ? theme.accent : block.kind === "code" || block.kind === "diff" ? theme.purple : block.kind === "error" ? theme.err : block.kind === "subagent" ? theme.accent : theme.dim;
  return mix(semantic, theme.surface, block.kind === "error" ? 0.2 : block.kind === "chrome" || block.kind === "subagent" ? 0.07 : 0.14);
}

function Row({ width, bg, indent = 0, children }: { width: number; bg?: string; indent?: number; children: React.ReactNode }) {
  return <Box width={Math.max(1, width - 1)} backgroundColor={bg} paddingLeft={indent} flexShrink={0}><Text>{children}</Text></Box>;
}

const sameKinds = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => {
  if (!a || !b) return !a && !b;
  return a.length === b.length && a.every((kind, i) => kind === b[i]);
};

const sameBlock = (a: TranscriptBlock, b: TranscriptBlock): boolean =>
  a.key === b.key && a.kind === b.kind && a.glyph === b.glyph && a.type === b.type && a.continuation === b.continuation && a.tight === b.tight
  && a.detail === b.detail && a.markdown === b.markdown && a.state === b.state && a.usage?.inputTokens === b.usage?.inputTokens
  && a.usage?.outputTokens === b.usage?.outputTokens && a.callId === b.callId && a.timeoutMs === b.timeoutMs && a.durationMs === b.durationMs
  && a.lines.length === b.lines.length && a.lines.every((line, i) => line === b.lines[i])
  && sameKinds(a.lineKinds, b.lineKinds)
  && sameKinds(a.renderedMarkdownRows, b.renderedMarkdownRows);

/** Right-aligned timer on the tool-block head (#300). `⏱ elapsed · limit`
 * while the call runs (decision 2 format); the limit drops when the tool
 * declares none. Settled blocks show the deterministic call→result
 * duration instead (`✓ bash · 18s`, decision 3) — the volatile elapsed
 * never crosses into Static (determinism #194). */
function blockTimerLabel(block: TranscriptBlock, live: { elapsedMs: number; timeoutMs?: number } | undefined): string {
  if (live) return `⏱ ${formatDuration(live.elapsedMs)}${live.timeoutMs !== undefined ? ` · ${formatTimeout(live.timeoutMs)}` : ""}`;
  return block.durationMs !== undefined ? `· ${formatDuration(block.durationMs)}` : "";
}

/**
 * Content-compared memo: projection rebuilds every block object per event
 * (ref equality is useless), but unchanged blocks must not re-render —
 * each re-render repaints its rows, which at streaming rates is O(n²)
 * output and froze the UI (session 20260825T062108113Z regression).
 * `liveMeta` participates in the comparator: it exists only on live
 * blocks (never inside Static) and the settled memo path never sees it,
 * so `React.memo` on settled blocks stays intact (#300).
 */
export const TranscriptBlockView = React.memo(function TranscriptBlockView({ block, width, liveMeta }: { block: TranscriptBlock; width: number; liveMeta?: { elapsedMs: number; timeoutMs?: number } }) {
  const theme = useTheme();
  const color = blockColor(block, theme);
  const bg = blockTint(block, theme);
  const detail = block.detail;
  const contentWidth = Math.max(20, width - 6);
  // ink drops the fg color on wrapped continuation lines of a Text (#213):
  // wrap the head detail ourselves and render each line as its own row.
  const headLabel = `${block.glyph} ${block.type}`;
  // #300: the timer claims the head row's right side; keep the first
  // detail line clear of it (timer + two spaces of margin).
  const timerReserve = blockTimerLabel(block, liveMeta).length + 2;
  const detailBudget = Math.max(10, width - 2 - headLabel.length - (timerReserve > 2 ? timerReserve : 1));
  // wrapRenderedLines never splits a word; an overlong unbroken token
  // (path, URL) would still overflow and hit ink's color-dropping wrap —
  // hard-chunk such words so every row is ours (#213).
  const detailLines = detail
    ? wrapRenderedLines(detail, detailBudget).flatMap((line) =>
        line.length > detailBudget ? (line.match(new RegExp(`.{1,${detailBudget}}`, "g")) ?? [line]) : [line])
    : [];
  const markdown = useMemo(() => block.renderedMarkdownRows === undefined && block.markdown ? createMarkdownRenderer(theme, contentWidth) : null, [block.renderedMarkdownRows, block.markdown, theme, contentWidth]);
  // #300: the right-aligned timer shares the head row with the label.
  // Without a timer the head renders exactly as before; with one, the
  // detail budget shrinks so the label never crowds the timer.
  const timerLabel = blockTimerLabel(block, liveMeta);
  return (
    <Box flexDirection="column">
      {/* One blank row separates blocks (not head from body): a block opens
          with a top margin so the head sits directly above its body (#211). */}
      {block.continuation ? null : <Text> </Text>}
      {block.continuation ? null : (
        <>
          {timerLabel ? (
            <Box width={Math.max(1, width - 1)} backgroundColor={bg} paddingLeft={1} paddingRight={1} justifyContent="space-between" flexShrink={0}>
              <Text><Text color={color}>{headLabel}</Text>{detailLines[0] !== undefined && <Text color={theme.dim}> {detailLines[0]}</Text>}</Text>
              <Text color={theme.dim}>{timerLabel}</Text>
            </Box>
          ) : (
            <Row width={width} bg={bg}><Text color={color}>{headLabel}</Text>{detailLines[0] !== undefined && <Text color={theme.dim}> {detailLines[0]}</Text>}</Row>
          )}
          {detailLines.slice(1).map((line, index) => (
            <Row key={`detail-${index}`} width={width} bg={bg} indent={timerLabel ? 2 : headLabel.length + 1}><Text color={theme.dim}>{line}</Text></Row>
          ))}
        </>
      )}
      {block.renderedMarkdownRows !== undefined || (block.markdown && markdown) ? (
        <>
          {/* Segments split exactly at blank lines (trimmed per segment),
              so restore the single GFM inter-block blank row here — heading
              and hr paragraphs get their spacing back without doubles. */}
          {block.continuation && !block.tight ? <Box width={Math.max(1, width - 1)} backgroundColor={bg} flexShrink={0}><Text> </Text></Box> : null}
          {block.renderedMarkdownRows !== undefined
            ? <MarkdownRows rows={block.renderedMarkdownRows} rowWidth={width} bg={bg} />
            : block.markdown && markdown ? <Markdown text={block.markdown} md={markdown} width={contentWidth} rowWidth={width} bg={bg} /> : null}
        </>
      ) : block.lines.map((line, index) => {
        const lineKind = block.lineKinds?.[index];
        const lineColor = block.kind === "diff" ? (line.startsWith("+") ? theme.ok : line.startsWith("-") ? theme.err : theme.dim) : block.kind === "error" ? theme.err : block.kind === "thinking" || lineKind === "answer" ? theme.dim : block.kind === "tool" || block.kind === "subagent" ? theme.dim : lineKind === "heading" ? theme.accent : lineKind === "ask" ? theme.purple : theme.fg;
        const stateGlyph = block.kind === "tool" ? line.match(/^(.*?)(\s[✓✗◌])$/) : null;
        const body = stateGlyph
          ? <><Text color={lineColor}>{stateGlyph[1]}</Text><Text color={stateGlyph[2]!.includes("✓") ? theme.ok : stateGlyph[2]!.includes("✗") ? theme.err : theme.accent}>{stateGlyph[2]}</Text></>
          : <Text color={lineColor} bold={lineKind === "heading"} italic={block.kind === "thinking"}>{line || " "}</Text>;
        if (lineKind === "heading") return <React.Fragment key={index}><Row width={width} bg={bg} indent={4}>{body}</Row><Row width={width} bg={bg} indent={4}><Text color={theme.muted}>{"─".repeat(Math.min(line.length, 40))}</Text></Row></React.Fragment>;
        // Wrapped body continuations must keep the row color too (#213):
        // pre-wrap instead of relying on ink's Text wrap.
        const indent = lineKind === "bullet" ? 6 : 4;
        const bodyBudget = Math.max(8, width - 1 - indent);
        const wrapped = wrapRenderedLines(line || " ", bodyBudget)
          .flatMap((row) => (row.length > bodyBudget ? (row.match(new RegExp(`.{1,${bodyBudget}}`, "g")) ?? [row]) : [row]));
        if (wrapped.length === 1) return <Row key={index} width={width} bg={bg} indent={indent}>{body}</Row>;
        // Multi-row: render our wrapped rows only — the full `line` would
        // wrap again via ink and duplicate the tail (#213 regression).
        return <React.Fragment key={index}>
          {wrapped.map((segment, s) => {
            const seg = segment.match(/^(.*?)(\s[✓✗◌])$/);
            const kind = lineKind as string | undefined;
            const isHeading = kind === "heading";
            return <Row key={s} width={width} bg={bg} indent={indent}>
              {seg
                ? <><Text color={lineColor}>{seg[1]}</Text><Text color={seg[2]!.includes("✓") ? theme.ok : seg[2]!.includes("✗") ? theme.err : theme.accent}>{seg[2]}</Text></>
                : <Text color={lineColor} bold={isHeading} italic={block.kind === "thinking"}>{segment}</Text>}
            </Row>;
          })}
        </React.Fragment>;
      })}
    </Box>
  );
}, (prev, next) => prev.width === next.width && sameBlock(prev.block, next.block)
  && prev.liveMeta?.elapsedMs === next.liveMeta?.elapsedMs && prev.liveMeta?.timeoutMs === next.liveMeta?.timeoutMs);
