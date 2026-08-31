import { join } from "node:path";
import { persistToolAllow } from "../config";
import type { PermissionResolver } from "../permissions";
import type { AgentEvent } from "../types";
import type { SessionConfig } from "./config";

/** The veto surface PermissionGate needs from the extension runtime. */
export interface ToolVetoChecker {
  checkToolVeto(call: {
    callId: string;
    name: string;
    args: unknown;
  }): Promise<{ veto: boolean; reason?: string; by?: string; errors: AgentEvent[] }>;
}

export interface PermissionGateOptions {
  permissions: PermissionResolver;
  extensions?: ToolVetoChecker;
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
  readonly #extensions: ToolVetoChecker | undefined;
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
    // Extension veto first (#34): veto > user rules > defaults, and it applies
    // even in yolo mode — extensions can only restrict, never grant.
    if (this.#extensions) {
      const veto = await this.#extensions.checkToolVeto({ callId, name: tool, args });
      for (const e of veto.errors) this.#append(e);
      if (veto.veto) {
        this.#append({ type: "permission_denied", callId, tool, reason: "extension" });
        return {
          allowed: false,
          denial: `permission denied: ${tool} vetoed by extension${veto.by ? ` ${veto.by}` : ""}${veto.reason ? ` (${veto.reason})` : ""}`,
        };
      }
    }
    const decision = this.#permissions.resolve(tool, args);
    if (decision === "deny") {
      this.#append({ type: "permission_denied", callId, tool, reason: "rule" });
      return { allowed: false, denial: `permission denied: ${tool} denied by permission rule` };
    }
    if (decision === "allow") return { allowed: true };

    // "ask" decisions.
    const mode = this.#permissions.mode;
    if (mode === "yolo") {
      this.#append({ type: "permission_granted", callId, tool, reason: "yolo" });
      return { allowed: true };
    }
    if (mode === "auto-accept") {
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
    this.#append({ type: "permission_requested", callId, tool });
    const answer = await this.#onPermissionRequest(tool, args);
    if (answer === "no") {
      this.#append({ type: "permission_denied", callId, tool, reason: "user" });
      return { allowed: false, denial: `permission denied: ${tool} requires user consent` };
    }
    this.#append({ type: "permission_granted", callId, tool, reason: "user" });
    if (answer === "always" && this.#permissions.persistable(tool, args)) {
      this.#persistAlways(tool, args);
    }
    return { allowed: true };
  }

  /** "always" persistence (#90): runtime rule + moh.json write for mcp__* tools. */
  #persistAlways(tool: string, args: unknown): void {
    const rule = this.#permissions.runtimeRuleFor(tool, args);
    if (rule) {
      this.#permissions.addRuntimeRule(rule);
      this.#append({ type: "permission_rule_added", rule: { ...rule, tier: "runtime" } });
    }
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
