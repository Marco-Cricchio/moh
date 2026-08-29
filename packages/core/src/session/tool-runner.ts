import type { AgentEvent, Message, Tool, ToolContext, ToolCall } from "../types";
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
  /** 1-based live-run turn sequence passed to every ToolContext (#196). */
  turn: () => number;
  /** Interactive question channel; absent in headless sessions. */
  onAskUser?: SessionConfig["onAskUser"];
  /** Log append callback — the runner owns its tool_call/tool_result emission. */
  append: (event: AgentEvent) => void;
}

/**
 * Same-turn tool execution (#91): schema validation, unknown-tool
 * handling, gated execution via the permission gate, and parallel
 * execution (`Promise.allSettled`, tool_result events in completion
 * order) with a sequential downgrade when the provider lacks
 * `parallelToolCalls`. Returns the result parts for the feedback
 * message the model sees for self-correction.
 */
export class ToolRunner {
  readonly #tools: () => Record<string, Tool>;
  readonly #gate: GateCheck;
  readonly #parallel: () => boolean;
  readonly #cwd: string;
  readonly #skillDirs: () => readonly string[];
  readonly #turn: () => number;
  readonly #onAskUser: SessionConfig["onAskUser"] | undefined;
  readonly #append: (event: AgentEvent) => void;

  constructor(options: ToolRunnerOptions) {
    this.#tools = options.tools;
    this.#gate = options.gate;
    this.#parallel = options.parallel;
    this.#cwd = options.cwd;
    this.#skillDirs = options.skillDirs;
    this.#turn = options.turn;
    this.#onAskUser = options.onAskUser;
    this.#append = options.append;
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
      const result = await Promise.race([
        this.#execute(call, signal),
        cancelledResult(call.callId, signal),
      ]);
      this.#append({ type: "tool_result", ...result });
      parts.push({ kind: "tool_result", ...result });
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
  ): Promise<{ callId: string; ok: boolean; output: string }> {
    const tool = this.#tools()[call.name];
    if (!tool) {
      return { callId: call.callId, ok: false, output: `unknown tool: ${call.name}` };
    }
    let args: unknown = call.args;
    if (tool.inputSchema) {
      const parsed = tool.inputSchema.safeParse(call.args);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        return { callId: call.callId, ok: false, output: `invalid arguments for ${call.name}: ${issues}` };
      }
      args = parsed.data;
    }
    const gate = await this.#gate.check(call.name, call.callId, args);
    if (!gate.allowed) {
      return { callId: call.callId, ok: false, output: gate.denial };
    }
    const ctx: ToolContext = {
      signal,
      cwd: this.#cwd,
      onProgress: () => {},
      skillDirs: this.#skillDirs(),
      turn: this.#turn(),
      ...(this.#onAskUser ? { askUser: this.#onAskUser } : {}),
    };
    try {
      const output = await tool.execute(args, ctx);
      return { callId: call.callId, ok: true, output: String(output) };
    } catch (err) {
      return {
        callId: call.callId,
        ok: false,
        output: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
