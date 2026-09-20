import type { AgentEvent, Message, ReasoningStreamEvent, Tool, ToolContext, ToolCall, ToolErrorKind } from "../types";
import { resolve, relative, sep } from "node:path";
import { splitCommandSegments, type FilesystemScope } from "../permissions";
// #778: the screenshot brand lives next to the tool that produces it — a
// type-only cycle would be fine, but the guard is a runtime function.
import { isScreenshotToolResult, renderScreenshotChip } from "../browser-tool";
import { CANCELLED_TOOL_OUTPUT } from "../types";
import type { SessionConfig } from "./config";

/**
 * A synthetic failed result for a tool call still open when the turn is
 * cancelled (#237): a tool whose promise never settles (e.g. bash with
 * orphaned children holding the output pipes) must not leave an orphan
 * tool_call in the log or the message list — every provider rejects the
 * next request with `invalid_request: Tool result is missing`.
 * Cancellation-aware tools get a short grace period to settle themselves
 * (the subagent spawn tool, for one, resolves with its own cancelled
 * result and emits `subagent_result` on abort); only tools still open
 * after it get the synthetic result. Races the tool promise; the loser is
 * discarded (its eventual settlement appends nothing — the call is already
 * closed).
 */
const ABORT_GRACE_MS = 300;
function cancelledResult(callId: string, signal: AbortSignal): Promise<{ callId: string; ok: boolean; output: string }> {
  const cancelled = { callId, ok: false, output: CANCELLED_TOOL_OUTPUT };
  if (signal.aborted) return new Promise((resolve) => setTimeout(() => resolve(cancelled), ABORT_GRACE_MS));
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => setTimeout(() => resolve(cancelled), ABORT_GRACE_MS), { once: true }),
  );
}

/** The gate surface ToolRunner needs — satisfied by PermissionGate (#90). */
export interface GateCheck {
  check(
    tool: string,
    callId: string,
    args: unknown,
  ): Promise<{ allowed: true } | { allowed: false; denial: string }>;
}

export interface ToolRunnerOptions {
  /** All registered tools, including MCP ones (live accessor — tools can be added mid-session). */
  tools: () => Record<string, Tool>;
  /** The 3-tier permission gate. */
  gate: GateCheck;
  /** Provider capability: false downgrades to sequential execution (live accessor). */
  parallel: () => boolean;
  /** Working dir passed to every ToolContext. */
  cwd: string;
  /** Skill dirs passed to every ToolContext (live accessor — refreshSkills rewrites them). */
  skillDirs: () => readonly string[];
  /** #377: filesystem scope derived from the session mode (yolo = unrestricted). */
  filesystemScope: () => FilesystemScope;
  /** 1-based live-run turn sequence passed to every ToolContext (#196). */
  turn: () => number;
  /** Interactive question channel; absent in headless sessions. */
  onAskUser?: SessionConfig["onAskUser"];
  /** Log append callback — the runner owns its tool_call/tool_result emission. */
  append: (event: AgentEvent) => void;
  /** Live tool-progress relay (ephemeral, #liveness): chunks emitted by a
   * running tool's `onProgress` reach clients without touching the log. */
  emitLive?: (event: ReasoningStreamEvent) => void;
  /** Best-effort client callback after a successful bash `git push` (#437). */
  onGitPush?: () => void;
  /** #617: best-effort callback after a successful in-root write/edit —
   * the session enqueues a targeted MPM refresh for the mutated path. */
  onFileMutation?: (relativePath: string) => void;
  /** #759: observed after every settled tool call (metadata only) — the
   * session counts exploratory tool usage per turn to validate the MPM
   * orientation's reasoning-seeded plans in the field. */
  onToolObserved?: (tool: string, ok: boolean) => void;
  /** #778: per-turn probe of the serving model's image input (same seam
   * as #488 mentions). Screenshots become typed image parts only when
   * true; absent/false → chip + warning text. */
  imageCapable?: () => boolean;
  /** ADR-0034: the post-tool inspection seam. Present when a runtime
   * (owned or borrowed) has `onToolResult` hooks registered: the result is
   * offered to them between the call settling and the `tool_result`
   * append. Absent = every result proceeds untouched (the common case:
   * nothing is paid for a seam nobody uses). */
  toolResultHooks?: ToolResultHookChecker;
}

/** ADR-0034: the post-tool inspection surface the runner needs — satisfied
 * by ExtensionRuntime (the runner never sees an extension instance). */
export interface ToolResultHookChecker {
  checkToolResultHooks(call: {
    callId: string;
    name: string;
    args: unknown;
    output: string;
  }): Promise<{ withheld?: string; by?: string; errors: AgentEvent[] }>;
}

/**
 * Same-turn tool execution (#91): schema validation, unknown-tool
 * handling, gated execution via the permission gate, and parallel
 * execution (`Promise.allSettled`, tool_result events in completion
 * order) with a sequential downgrade when the provider lacks
 * `parallelToolCalls`. Returns the result parts for the feedback
 * message the model sees for self-correction.
 */
/** Shell variable assignment token (the conservative common form). */
function isAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

/** True when one shell segment invokes `git push`. Supports environment
 * prefixes, `command git`, and Git's common global options, while keeping
 * arbitrary text such as `echo 'git push'` out of the trigger grammar. */
function isGitPushSegment(words: string[]): boolean {
  let i = 0;
  while (isAssignment(words[i] ?? "")) i += 1;
  if (words[i] === "env") {
    i += 1;
    while (words[i]?.startsWith("-") || isAssignment(words[i] ?? "")) i += 1;
  }
  if (words[i] === "command") {
    i += 1;
    while (words[i]?.startsWith("-")) i += 1;
  }
  if (words[i] !== "git") return false;
  i += 1;
  while (words[i]?.startsWith("-")) {
    const option = words[i++]!;
    // Git options with a separate argument. Other global options are
    // flag-like or use `=`, so they can be skipped safely here.
    if (option === "-C" || option === "-c" || option === "--git-dir" || option === "--work-tree") i += 1;
  }
  return words[i] === "push";
}

/** True for a shell command segment that invokes `git push`; quoted text
 * and `git status` are not triggers. Compound commands are intentional:
 * a successful bash call that did push must publish the fresh artifact. */
export function isGitPush(call: ToolCall): boolean {
  if (call.name !== "bash" || typeof (call.args as { command?: unknown })?.command !== "string") return false;
  return splitCommandSegments((call.args as { command: string }).command).some(isGitPushSegment);
}

/** The settled shape of one tool execution (success or failure). */
interface ToolOutcome {
  callId: string;
  ok: boolean;
  output: string;
  /** #731: structured failure reason — present on failures only. */
  errorKind?: ToolErrorKind;
  /** #778: a screenshot's pixels, when the model can see them. Rides the
   * tool_result event and the feedback part (replay rebuilds the part
   * from the event, so resume/fork inherit exactly what the model saw). */
  image?: { mime: string; base64: string };
}

/**
 * #731: classify a failed result's output into a `ToolErrorKind` so the
 * event log carries a machine-usable reason and `moh usage tools` can
 * break failures down without re-parsing free text. Matched on the
 * wording conventions the tools themselves emit; anything else is left
 * unclassified (no errorKind) rather than guessed.
 */
function classifyToolError(tool: string, output: string): ToolErrorKind | undefined {
  if (/^invalid arguments for /.test(output)) return "schema-validation";
  if (output === CANCELLED_TOOL_OUTPUT || /: turn cancelled before the command returned/.test(output)) return "cancelled";
  if (/: timed out after \d+ms/.test(output)) return "timeout";
  if (/permission denied|path outside project root|pattern escapes the project root|requires user co/.test(output)) return "permission";
  if (tool === "edit" && /oldText not found|oldText is not unique/.test(output)) return "edit-mismatch";
  if (/Invalid regular expression/.test(output)) return "invalid-regex";
  if (/^HTTP \d{3} /.test(output)) return "http-status";
  if (/file not found:|URL must have a valid scheme|only http\/https URLs are supported/.test(output)) return "not-found";
  if (/^exit code \d+/.test(output)) return "command-exit";
  if (/^[A-Z]+(\/[A-Z0-9]+)*: /.test(output)) return "io"; // node errno style: ENOTDIR, ENOENT/EACCES…
  return undefined;
}

export class ToolRunner {
  readonly #tools: () => Record<string, Tool>;
  readonly #gate: GateCheck;
  readonly #parallel: () => boolean;
  readonly #cwd: string;
  readonly #skillDirs: () => readonly string[];
  readonly #filesystemScope: () => FilesystemScope;
  readonly #turn: () => number;
  readonly #onAskUser: SessionConfig["onAskUser"] | undefined;
  readonly #append: (event: AgentEvent) => void;
  readonly #emitLive: ((event: ReasoningStreamEvent) => void) | undefined;
  readonly #onGitPush: (() => void) | undefined;
  readonly #onFileMutation: ((relativePath: string) => void) | undefined;
  readonly #onToolObserved: ((tool: string, ok: boolean) => void) | undefined;
  readonly #imageCapable: (() => boolean) | undefined;
  readonly #toolResultHooks: ToolResultHookChecker | undefined;

  /** Workspace-root-relative POSIX form of an (absolute or relative) path. */
  #relativeToRoot(path: string): string | null {
    if (!path) return null;
    const rel = relative(this.#cwd, resolve(this.#cwd, path)).split(sep).join("/");
    if (!rel || rel.startsWith("..")) return null;
    return rel;
  }

  constructor(options: ToolRunnerOptions) {
    this.#tools = options.tools;
    this.#gate = options.gate;
    this.#parallel = options.parallel;
    this.#cwd = options.cwd;
    this.#skillDirs = options.skillDirs;
    this.#filesystemScope = options.filesystemScope;
    this.#turn = options.turn;
    this.#onAskUser = options.onAskUser;
    this.#append = options.append;
    this.#emitLive = options.emitLive;
    this.#onGitPush = options.onGitPush;
    this.#onFileMutation = options.onFileMutation;
    this.#onToolObserved = options.onToolObserved;
    this.#imageCapable = options.imageCapable;
    this.#toolResultHooks = options.toolResultHooks;
  }

  /**
   * Runs same-turn tool calls in parallel (Promise.allSettled), appends
   * tool_call/tool_result events in completion order, and returns the
   * result parts in that same order — the caller feeds them back as a
   * user message. Returns outcome "aborted" if the turn was cancelled
   * mid-execution.
   */
  async run(
    calls: ToolCall[],
    signal: AbortSignal,
  ): Promise<{ outcome: "ok" | "aborted"; parts: Message["parts"] }> {
    if (calls.length === 0) return { outcome: "ok", parts: [] };
    for (const call of calls) {
      // #300: stamp the tool's effective timeout (resolved by the tool
      // itself, defaults included) so clients can render a live limit
      // without duplicating per-tool defaults. Resolved before schema
      // validation: an invalid arg never reaches execute, but the event
      // still records what the limit would have been. Sanitized by the
      // resolver contract; a non-finite value is dropped, not trusted.
      const resolved = this.#tools()[call.name]?.timeoutMs?.(call.args);
      this.#append({
        type: "tool_call",
        callId: call.callId,
        name: call.name,
        args: call.args,
        ...(typeof resolved === "number" && Number.isFinite(resolved) ? { timeoutMs: resolved } : {}),
      });
    }
    // Append each tool_result the moment its promise settles, so the log
    // reflects completion order; collect parts in that same order.
    const parts: Message["parts"] = [];
    const runOne = async (call: ToolCall) => {
      const result: ToolOutcome = await Promise.race([
        this.#execute(call, signal),
        cancelledResult(call.callId, signal),
      ]);
      // ADR-0034: the post-tool inspection point — between the call
      // settling and the `tool_result` append, so the withheld text is what
      // the log holds *and* what the feedback part carries (replay, resume
      // and fork rebuild from the log and must match what the model saw).
      // A result carrying an image is never offered: it is not judgeable
      // text, and withholding a screenshot breaks the calling turn.
      let settled = result;
      const hooks = this.#toolResultHooks;
      if (hooks && result.image === undefined) {
        const dispatch = await hooks.checkToolResultHooks({
          callId: result.callId,
          name: call.name,
          args: call.args,
          output: result.output,
        });
        for (const event of dispatch.errors) this.#append(event);
        if (dispatch.withheld !== undefined) {
          // Refusal-shaped, never a silent drop: the model sees a failed
          // result that says the content was withheld and why.
          settled = { callId: result.callId, ok: false, output: dispatch.withheld, errorKind: "permission" };
        }
      }
      this.#append({ type: "tool_result", ...settled });
      parts.push({
        kind: "tool_result" as const,
        callId: settled.callId,
        ok: settled.ok,
        output: settled.output,
        ...(settled.errorKind ? { errorKind: settled.errorKind } : {}),
        ...(settled.image ? { image: settled.image } : {}),
      });
      // #759: per-turn tool usage counter (orientation field validation).
      try { this.#onToolObserved?.(call.name, result.ok); } catch { /* metadata only */ }
      if (result.ok && isGitPush(call)) {
        // The bash result is final before publishing begins; a failed or
        // slow transport can neither delay nor alter the tool result/turn.
        try { this.#onGitPush?.(); } catch { /* client callback is best-effort */ }
      }
      // #617: a successful in-root write/edit is the highest-priority MPM
      // refresh input; the relative path (POSIX) feeds the lifecycle queue.
      if (result.ok && this.#onFileMutation && (call.name === "write" || call.name === "edit")) {
        try {
          const rel = this.#relativeToRoot(String((call.args as { path?: unknown }).path ?? ""));
          if (rel) this.#onFileMutation(rel);
        } catch { /* best-effort: lifecycle input only */ }
      }
    };
    // Capability downgrade: endpoints without parallelToolCalls run calls sequentially.
    if (!this.#parallel()) {
      for (const call of calls) await runOne(call);
    } else {
      // Interactive tools (ask_user) serialize within a parallel batch
      // (#223): one pending question at a time is a UI invariant, and the
      // gate's rejection read as a fake user answer in the transcript.
      // Non-interactive calls keep their concurrency; interactive ones
      // chain in call order.
      const interactive = calls.filter((call) => calls.length > 1 && this.#tools()[call.name]?.interactive);
      if (interactive.length <= 1) {
        await Promise.allSettled(calls.map(runOne));
      } else {
        let chain: Promise<unknown> = Promise.resolve();
        await Promise.allSettled(calls.map((call) => {
          const run = () => runOne(call);
          if (this.#tools()[call.name]?.interactive) {
            chain = chain.then(run);
            return chain;
          }
          return run();
        }));
      }
    }
    return { outcome: signal.aborted ? "aborted" : "ok", parts };
  }

  /**
   * One tool call: schema validation, unknown-tool handling, permission
   * gate, execution. Errors never throw — they become failed results the
   * model can self-correct on.
   */
  async #execute(
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<ToolOutcome> {
    const tool = this.#tools()[call.name];
    if (!tool) {
      return { callId: call.callId, ok: false, output: `unknown tool: ${call.name}`, errorKind: "schema-validation" };
    }
    let args: unknown = call.args;
    if (tool.inputSchema) {
      const parsed = tool.inputSchema.safeParse(call.args);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        return { callId: call.callId, ok: false, output: `invalid arguments for ${call.name}: ${issues}`, errorKind: "schema-validation" };
      }
      args = parsed.data;
    }
    // #775 (ADR-0029): the browser tool enriches its validated args with
    // the live page URL (URL-glob permission matching) and an element
    // description (the ask renders action + element + domain). The
    // enrichment is presentation + policy context only — execute still
    // receives the model's own args.
    const gateArgs = tool.gateArgs ? tool.gateArgs(args) : args;
    const gate = await this.#gate.check(call.name, call.callId, gateArgs);
    if (!gate.allowed) {
      return { callId: call.callId, ok: false, output: gate.denial, errorKind: "permission" };
    }
    const ctx: ToolContext = {
      signal,
      cwd: this.#cwd,
      // Live progress relay (#liveness): chunks reach clients ephemerally;
      // they are never appended to the log. The relay itself is
      // best-effort — a listener throwing must not fail the tool.
      onProgress: (chunk) => {
        try {
          this.#emitLive?.({ type: "tool_progress", callId: call.callId, tool: call.name, chunk });
        } catch { /* live listeners are presentation-only */ }
      },
      skillDirs: this.#skillDirs(),
      filesystemScope: this.#filesystemScope(),
      turn: this.#turn(),
      ...(this.#onAskUser ? { askUser: this.#onAskUser } : {}),
    };
    try {
      const output = await tool.execute(args, ctx);
      // #778: a screenshot result is promoted to a typed image part when
      // the serving model declares image input (#490 pipeline); the chip
      // + warning text is the visible fallback otherwise. ToolOutcome
      // gains the optional image either way — the event log's
      // tool_result and the feedback parts both carry it.
      if (isScreenshotToolResult(output)) {
        if (this.#imageCapable?.() === true) {
          return { callId: call.callId, ok: true, output: `[screenshot: ${output.target}]`, image: { mime: output.mime, base64: output.base64 } };
        }
        return { callId: call.callId, ok: true, output: renderScreenshotChip(output) };
      }
      return { callId: call.callId, ok: true, output: String(output) };
    } catch (err) {
      const output = err instanceof Error ? err.message : String(err);
      return {
        callId: call.callId,
        ok: false,
        output,
        errorKind: classifyToolError(call.name, output),
      };
    }
  }
}
