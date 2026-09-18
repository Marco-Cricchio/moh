import { join } from "node:path";
import { persistToolAllow } from "../config";
import type { PermissionResolver } from "../permissions";
import type { AgentEvent } from "../types";
import type { SessionConfig } from "./config";

/**
 * The tool-call hook surface PermissionGate needs (the name is historical:
 * it now carries both the `veto` and the `ask` outcomes, ADR-0031).
 */
export interface ToolHookChecker {
  checkToolVeto(call: {
    callId: string;
    name: string;
    args: unknown;
  }): Promise<{ veto: boolean; ask: boolean; reason?: string; by?: string; errors: AgentEvent[] }>;
}

export interface PermissionGateOptions {
  permissions: PermissionResolver;
  extensions?: ToolHookChecker;
  onPermissionRequest?: SessionConfig["onPermissionRequest"];
  /** Working dir — "always" on mcp__* tools persists to its moh.json. */
  cwd: string;
  /** Log append callback — the gate owns its own event emission. */
  append: (event: AgentEvent) => void;
}

/**
 * The 3-tier permission gate (#90): extension veto first (veto > user
 * rules > defaults, applies even in yolo — extensions can only
 * restrict), then rule resolution, then mode handling (yolo /
 * auto-accept / headless) and the user ask flow.
 *
 * The "always" answer's persistence decisions live here, out of the
 * agent loop: a runtime rule is added (+ `permission_rule_added` event)
 * and `mcp__*` tools are also persisted to moh.json (fail-soft — an
 * unwritable file still leaves the runtime rule for this session).
 */
export class PermissionGate {
  readonly #permissions: PermissionResolver;
  readonly #extensions: ToolHookChecker | undefined;
  readonly #onPermissionRequest: SessionConfig["onPermissionRequest"];
  readonly #cwd: string;
  readonly #append: (event: AgentEvent) => void;

  constructor(options: PermissionGateOptions) {
    this.#permissions = options.permissions;
    this.#extensions = options.extensions;
    this.#onPermissionRequest = options.onPermissionRequest;
    this.#cwd = options.cwd;
    this.#append = options.append;
  }

  /**
   * Resolves and enforces the gate for one tool call. Returns a
   * structured denial string on "deny"/headless-"ask" so the model
   * sees the refusal as a failed tool_result.
   */
  async check(
    tool: string,
    callId: string,
    args: unknown,
  ): Promise<{ allowed: true } | { allowed: false; denial: string }> {
    // Extension hook check first (#34, ADR-0031): a veto beats user rules,
    // defaults, yolo and auto-accept — extensions can only restrict, never
    // grant. An `ask` escalates the call to the consent flow below.
    let extensionAsk: { extension?: string; reason?: string } | undefined;
    if (this.#extensions) {
      const hook = await this.#extensions.checkToolVeto({ callId, name: tool, args });
      for (const e of hook.errors) this.#append(e);
      if (hook.veto) {
        this.#append({ type: "permission_denied", callId, tool, reason: "extension" });
        return {
          allowed: false,
          denial: `permission denied: ${tool} vetoed by extension${hook.by ? ` ${hook.by}` : ""}${hook.reason ? ` (${hook.reason})` : ""}`,
        };
      }
      if (hook.ask) extensionAsk = { ...(hook.by ? { extension: hook.by } : {}), ...(hook.reason ? { reason: hook.reason } : {}) };
    }
    const decision = this.#permissions.resolve(tool, args);
    // A written user rule outranks an extension judgment: an explicit deny
    // refuses without prompting (ADR-0031). An explicit allow does NOT
    // suppress the ask — judging what the rules already let through is the
    // whole point of a guardrail.
    if (decision === "deny") {
      this.#append({ type: "permission_denied", callId, tool, reason: "rule" });
      return { allowed: false, denial: `permission denied: ${tool} denied by permission rule` };
    }
    if (decision === "allow" && !extensionAsk) return { allowed: true };

    // "ask" decisions.
    const mode = this.#permissions.mode;
    // #377: yolo lifts prompts for built-in tools only — MCP tools keep
    // their explicit ask flow (server first-use consent lives in McpRuntime;
    // the per-call default "ask on first invocation" must survive yolo too).
    // ADR-0031: an extension ask is ignored here — the call proceeds as if
    // the hook had said nothing (use `veto` for anything lethal).
    if (mode === "yolo" && !tool.startsWith("mcp__")) {
      this.#append({ type: "permission_granted", callId, tool, reason: "yolo" });
      return { allowed: true };
    }
    // ADR-0031: an extension ask is evaluated before the auto-accept branch —
    // there is no other filter in that mode, which is exactly its value.
    if (mode === "auto-accept" && !extensionAsk) {
      this.#append({ type: "permission_granted", callId, tool, reason: "auto_accept" });
      return { allowed: true };
    }
    if (!this.#onPermissionRequest) {
      this.#append({ type: "permission_denied", callId, tool, reason: "headless" });
      return {
        allowed: false,
        denial: `permission denied: ${tool} requires user consent (headless mode)`,
      };
    }
    this.#append({
      type: "permission_requested",
      callId,
      tool,
      ...(extensionAsk ? { reason: "extension" } : {}),
    });
    const answer = await this.#onPermissionRequest(
      tool,
      args,
      extensionAsk ? { source: "extension" as const, ...extensionAsk } : undefined,
    );
    if (answer === "no") {
      this.#append({ type: "permission_denied", callId, tool, reason: "user" });
      return { allowed: false, denial: `permission denied: ${tool} requires user consent` };
    }
    this.#append({ type: "permission_granted", callId, tool, reason: "user" });
    // #775 (ADR-0029): on a browser call both "always" and "always for
    // this site" build the same session-scoped `browser:<action>
    // <url-glob>` runtime rule — never a tool-wide rule, never persisted.
    // ADR-0031: an extension ask never writes a rule at all — it offers no
    // "always" (a false positive must not disarm the filter that raised it).
    const runtimeOnly = tool === "browser";
    if (
      !extensionAsk &&
      (answer === "always" || answer === "always_for_site") &&
      this.#permissions.persistable(tool, args)
    ) {
      this.#persistAlways(tool, args, { runtimeOnly });
    }
    return { allowed: true };
  }

  /** "always" persistence (#90): runtime rule + moh.json write for mcp__* tools. */
  #persistAlways(tool: string, args: unknown, opts: { runtimeOnly?: boolean } = {}): void {
    const rule = this.#permissions.runtimeRuleFor(tool, args);
    if (rule) {
      this.#permissions.addRuntimeRule(rule);
      this.#append({ type: "permission_rule_added", rule: { ...rule, tier: "runtime" } });
    }
    if (opts.runtimeOnly) return; // #775: browser rules are session-scoped by design
    // MCP tools: "always" also persists to moh.json for future sessions (#15).
    if (tool.startsWith("mcp__")) {
      try {
        persistToolAllow(join(this.#cwd, "moh.json"), tool);
      } catch {
        // no writable moh.json: the runtime rule still covers this session
      }
    }
  }
}
