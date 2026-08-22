import type { AgentEvent, Message, Tool, ToolContext, ToolCall } from "../types";
import type { SessionConfig } from "../index";

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
  readonly #onAskUser: SessionConfig["onAskUser"] | undefined;
  readonly #append: (event: AgentEvent) => void;

  constructor(options: ToolRunnerOptions) {
    this.#tools = options.tools;
    this.#gate = options.gate;
    this.#parallel = options.parallel;
    this.#cwd = options.cwd;
    this.#skillDirs = options.skillDirs;
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
      this.#append({ type: "tool_call", callId: call.callId, name: call.name, args: call.args });
    }
    // Append each tool_result the moment its promise settles, so the log
    // reflects completion order; collect parts in that same order.
    const parts: Message["parts"] = [];
    const runOne = async (call: ToolCall) => {
      const result = await this.#execute(call, signal);
      this.#append({ type: "tool_result", ...result });
      parts.push({ kind: "tool_result", ...result });
    };
    // Capability downgrade: endpoints without parallelToolCalls run calls sequentially.
    if (!this.#parallel()) {
      for (const call of calls) await runOne(call);
    } else {
      await Promise.allSettled(calls.map(runOne));
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
