/**
 * Schema version of the AgentEvent log. Bump on breaking event-shape changes.
 *
 * #575: v2 adds event identity — every newly appended event carries a ULID
 * `id` and a `parentId` referencing the branch head it follows. Reading is
 * backward-compatible: a v1 log is the degenerate (linear) tree.
 */
export const SCHEMA_VERSION = 2;

/**
 * #575 (format decision 8): identity/reference fields shared by every
 * AgentEvent variant. `id` is the event's ULID, stamped by the writer on
 * every appended event. `parentId` is the id (or, for pre-tree events, the
 * read-only `line:N` bridge) of the event this one follows; absent =
 * child of the current branch (the `to` of the last `branch_switched`,
 * else the last event). New events never carry `line:N` ids — the bridge
 * is read-only and only ever appears as a referenced value.
 */
/**
 * ADR-0038: the opaque, JSON-serializable command payload a client sends to
 * one extension. The core never interprets it.
 */
export type ExtensionControlPayload = Record<string, unknown>;

export interface EventIdentity {
  id?: string;
  parentId?: string;
}

/**
 * The single wording for a tool result synthesized because the turn was
 * cancelled (or the process died) before the tool returned (#237). Both
 * synthesizing sites — ToolRunner at abort time and replayMessages at
 * resume time — must agree, or the replayed log drifts from what a live
 * abort would have written.
 */
export const CANCELLED_TOOL_OUTPUT = "turn cancelled before the tool returned";

import { z } from "zod";
import type { FilesystemScope, PermissionRule } from "./permissions";
import type { SkillArgs } from "./skill-args";
import type { MentionAttachment, MentionWarning } from "./mentions";

export type TextPart = { kind: "text"; text: string };
/** Vision note 4: an image riding a user message as a multimodal content
 * block — bytes are the base64 of the `user_message` attachment (they must
 * stay identical for replay to rebuild the exact provider context). */
export type ImagePart = { kind: "image"; mime: string; base64: string };
/** #240: provider-exposed reasoning attached to an assistant message —
 * completed text plus the provider's opaque continuation artifacts
 * (e.g. a signature) required to resume the exact provider context. */
export type ReasoningPart = { kind: "reasoning"; text: string; continuation?: Record<string, unknown> };
export type ToolCallPart = ToolCall & { kind: "tool_call" };
export type ToolResultPart = { kind: "tool_result"; callId: string; ok: boolean; output: string; /** #731: structured failure reason — failures only. */ errorKind?: ToolErrorKind; /** #778: screenshot pixels when image-capable (rides the #490 pipeline). */ image?: { mime: string; base64: string } };
export type MessagePart = TextPart | ImagePart | ReasoningPart | ToolCallPart | ToolResultPart;

/**
 * #731: structured failure reason carried on failed `tool_result` events.
 * Metadata only — classification, never content — so `moh usage tools`
 * can show a failure break-down without re-parsing output text.
 */
export type ToolErrorKind =
  | "schema-validation"   // rejected by the tool's input schema (never executed)
  | "permission"          // denied by the permission gate or an extension veto
  | "timeout"             // the tool's own time limit fired
  | "cancelled"           // the turn was cancelled before the call settled
  | "not-found"           // target path/file/URL does not exist
  | "io"                  // filesystem/OS-level error (ENOTDIR, EACCES, …)
  | "http-status"         // fetch reached the server and got a non-2xx
  | "rate-limited"        // #1079: that non-2xx was a quota wall (429, or a provider-declared exhausted quota)
  | "transient"           // #1079: the retry did not save it — a 5xx, or a network failure, on both attempts
  | "edit-mismatch"       // edit's oldText not found / not unique
  | "invalid-regex"       // malformed pattern handed to a search tool
  | "command-exit"        // bash command ran and exited non-zero
  | "unknown";            // anything else (reserved — currently unused)

/**
 * One message in the conversation fed to providers.
 */
export interface Message {
  role: "system" | "user" | "assistant";
  parts: MessagePart[];
}

export type ProviderErrorKind =
  | "auth"
  | "rate_limited"
  | "quota_exhausted"
  | "overloaded"
  | "network"
  | "invalid_request"
  | "context_length"
  | "content_filtered"
  | "empty_completion"
  | "aborted";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    /**
     * ADR-0049 (door one, #986): the context window the provider declared
     * in its own overflow refusal, when moh recognized a formula in it.
     * Undefined otherwise — including for an unrecognized refusal, which
     * teaches nothing and leaves a trace instead.
     *
     * Recognition runs on the **untruncated** refusal text
     * (`normalizeProviderError`), before the 300-character cap that bounds
     * `message` and the body it is classified from, so this number can
     * come from text `message` no longer holds.
     */
    readonly declaredWindow?: number,
    /**
     * #1099: sanitized transport facts of the failed attempt, when the
     * normalized error carries them — the HTTP status the provider
     * answered with and, when the provider surfaced it, the Retry-After
     * hint in ms. Both are optional, additive and safe to serialize:
     * no header dump, no body, no credential ever rides here.
     */
    readonly details?: { httpStatus?: number; retryAfterMs?: number },
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * #1099: provenance of one call's usage numbers — where the numbers came
 * from. `"provider"` means the provider itself reported them;
 * `"client-estimated"` is reserved for a client that substitutes its own
 * estimate (moh's core never estimates tokens; the P1 quota surface uses
 * it); `"unavailable"` means the provider did not (the zeros that remain
 * are the event's neutral shape, never evidence of consumption or of its
 * absence). Absent on events that predate #1099 or carry no usage at all.
 */
export type UsageProvenance = "provider" | "client-estimated" | "unavailable";

/**
 * #1099: provider-reported usage detail beyond the aggregate input/output
 * pair. Cache tokens are a subset of what providers count inside input —
 * they are recorded beside `inputTokens`, never added to it, so aggregate
 * usage cannot double-count. Every field is optional: absent means the
 * provider did not report it — never zero.
 */
export interface UsageDetail {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/**
 * #1099: sanitized identity of the endpoint that served (or refused) one
 * attempt — the endpoint kind and its base URL without query string,
 * fragment or credentials. Built only through `endpointIdentity`.
 */
export interface EndpointIdentity {
  kind: string;
  baseUrl?: string;
}

/**
 * #1099: the one sanitizer for endpoint identity. Strips query strings,
 * fragments and userinfo; a baseUrl that fails to parse is dropped
 * entirely (the kind alone still identifies the endpoint class). Never
 * accepts or emits keys, authorization values or paths with credentials.
 */
export function endpointIdentity(kind: string, baseUrl: string | undefined): EndpointIdentity {
  if (!baseUrl) return { kind };
  try {
    const url = new URL(baseUrl);
    url.search = "";
    url.hash = "";
    url.username = "";
    url.password = "";
    return { kind, baseUrl: url.toString().replace(/\/$/, "") };
  } catch {
    return { kind };
  }
}

/**
 * #1099: the per-attempt audit record riding a `model_call` event — one
 * logical model-call attempt with stable correlation ids, timing, sanitized
 * endpoint identity and the normalized outcome. Attempts of one logical
 * call (same `callId` — retries and fallback restarts inside one agent-loop
 * iteration) share `turnId`/`callId` and differ in `attemptId` and
 * `retryIndex`; a fallback move is visible through `servingModel` and
 * `chainIndex`. Chrome only — never provider context.
 */
export interface AttemptTelemetry {
  /** The logical call this attempt belongs to (one agent-loop iteration). */
  callId: string;
  /** This attempt — unique across the session. */
  attemptId: string;
  /** The turn this attempt served (one `user_message` → `done` run). */
  turnId: string;
  /** 0-based attempt ordinal within the logical call (a retry or fallback
   * restart increments it; the first attempt is 0). */
  retryIndex: number;
  /** The attempt's model's position in the serving chain (0 when the
   * provider is not a route). */
  chainIndex: number;
  /** The user's standing choice (#974) and the ref that served the call. */
  selectedModel: string;
  servingModel: string;
  /** Sanitized endpoint identity — no keys, no query strings. */
  endpoint: EndpointIdentity;
  /** The wire the call spoke (absent for providers that do not declare one). */
  wire?: string;
  /** Explicit wall-clock boundaries and the monotonic difference. */
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** `completed` finalized a provider message; `failed` threw (or was
   * superseded by a retry/fallback stop); `aborted` was cancelled. */
  outcome: "completed" | "failed" | "aborted";
  /** ProviderError kind, when the attempt failed. */
  errorKind?: string;
  /** HTTP status where safe (sanitized number, never headers/body). */
  httpStatus?: number;
  /** Retry-After hint the provider surfaced, in ms. The route's own
   * backoff between attempts is not a field: it is the wall-clock gap
   * between one attempt's `endedAt` and the next attempt's `startedAt`
   * sharing the same `callId` — reconstructable from the chain. */
  retryAfterMs?: number;
  /** Whether the attempt consumed provider usage (a usage event was seen
   * for it). A failed attempt that consumed usage still bills. */
  consumedUsage: boolean;
  /** #1101: time to first content — ms from the attempt's start to its
   * first streamed text delta ("useful content": reasoning deltas do not
   * count). Absent when the attempt produced no text (a tool-only call,
   * a failure) — unknown, never zero. */
  ttfcMs?: number;
  /** Release-pinned pricing/catalog revision (ADR-0046 manifest). */
  pricingVersion: string;
}

/** #240/#253: provider reasoning stream lifecycle — neutral, SDK-free.
 * Deltas stream live (also relayed to the session's live channel);
 * the loop buffers them and persists the completed block as a single
 * `reasoning` AgentEvent when the call completes. */
export type ReasoningStreamEvent =
  | { type: "reasoning_start" }
  | { type: "reasoning_delta"; text: string }
  | { type: "reasoning_end"; continuation?: Record<string, unknown> }
  /** Live tool progress (#liveness): a short chunk of a running tool's
   * partial output, relayed from ToolContext.onProgress. Ephemeral —
   * never persisted; the completed output still lands in the log on the
   * tool_result event. */
  | { type: "tool_progress"; callId: string; tool: string; chunk: string };

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_calls"; calls: { callId: string; name: string; args: unknown }[] }
  | { type: "usage"; inputTokens: number; outputTokens: number;
      /** #1099: provider-reported detail beside the aggregate pair —
       * absent when the provider did not report it (never zero-filled). */
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      reasoningTokens?: number;
      /** #1099: where these numbers came from; `"unavailable"` when the
       * provider reported nothing (zeros are the neutral shape). */
      provenance?: UsageProvenance }
  | { type: "finish"; reason: FinishReason }
  /** #83: providers announce the model serving this call at stream start.
   * #240: the announcement may carry the effective thinking level the
   * provider actually sent (after per-wire capability mapping) — the
   * loop audits it on the `model_call` event. */
  | { type: "model_call_start"; model: string; thinkingLevel?: ThinkingLevel;
      /** #1099: sanitized endpoint identity and wire of the stream that
       * announced itself — no keys, no query strings. */
      endpoint?: EndpointIdentity;
      wire?: string }
  | ReasoningStreamEvent
  /** ADR-0012: the route engine announces a fallback stop: the active
   * target failed with `reason` (a ProviderError kind, e.g.
   * "quota_exhausted") and the request restarts on `to`. */
  | { type: "fallback"; from: string; to: string; reason: string }
  /** Session route health selected a new target after a completed call. */
  | { type: "route_serving"; selected: string; serving: string; previous: string };

export type FinishReason = "stop" | "tool_calls";

/** Token counts as reported by providers (#83). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Tool identity as advertised to providers (name, description, JSON schema). */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (object) of the tool args, from the Zod inputSchema; optional for schema-less tools. */
  parameters?: Record<string, unknown>;
}

/** Canonical thinking-level scale (#239 decision 8, #241). moh never
 * silently remaps one level to another: unsupported levels are not sent. */
/** One declared thinking capability format (#256): which wire-native
 * request shape a declared capability uses. The tuple is the single
 * spelling — the zod enum and every switch derive from it. */
export const THINKING_FORMATS = [
  "openai-effort",
  "openrouter-effort",
  "anthropic-effort",
  "google-thinking-level",
] as const;

export type ThinkingFormat = (typeof THINKING_FORMATS)[number];

export type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";

/** The canonical level set in display order (#241): the one scale pickers
 * offer and preferences persist, whatever a provider calls its levels. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh", "max"];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Neutral per-call stream request options (#240). Providers that do not
 * support thinking levels simply ignore them — no invented request fields. */
export interface StreamOptions {
  thinking?: { level: ThinkingLevel };
}

/**
 * A provider talks to a model. Single-shot: it never loops.
 */
export interface Provider {
  readonly name: string;
  /** Feature flags of the underlying endpoint; drive capability downgrades. */
  readonly capabilities?: EndpointCapabilities;
  stream(
    messages: Message[],
    signal: AbortSignal,
    /** Tools the loop offers the model this call (echo/e2e; providers may ignore). */
    tools?: readonly ToolSpec[],
    /** Neutral request options (#240): thinking level. Optional and
     * additive — existing/custom providers keep their signature. */
    options?: StreamOptions,
  ): AsyncIterable<StreamEvent>;
}

/** Per-endpoint feature flags (issue #28). */
export interface EndpointCapabilities {
  caching: boolean;
  parallelToolCalls: boolean;
  multimodal: boolean;
}

export type AgentEvent = AgentEventBase & EventIdentity;

type AgentEventBase =
  | { type: "session_start"; schemaVersion: number; promptVersion: string }
  /**
   * ADR-0021: appended by the core when a session with pre-existing events
   * is opened in resume (TUI and `moh run --resume` alike, same seam), at
   * resume-open before any turn; the store-level fork appends it to the new
   * file (forks are born consumed). Chrome only: the sole marker of
   * consumption for the pertinent-session suggestion.
   */
  | { type: "session_resumed" }
  /**
   * #477 (vision note 31): appended by `renameSession()` when a user
   * renames the session. Chrome only — never provider context. The last
   * `session_renamed` in the log is the session's display name (a
   * permanent override of the derived first-user_message title); an
   * explicitly empty name resets the override, which also appends an
   * event so the log stays append-only and the reset is itself history.
   */
  | { type: "session_renamed"; name: string }
  /**
   * Home pin (#user request): appended by `setSessionPinned()` when the
   * user pins/unpins the session from the Home picker. Chrome only —
   * never provider context. The LAST `session_pinned` in the log is the
   * session's pinned state (a toggle, so both true and false append —
   * the log stays append-only and the unpinned state is itself history).
   */
  | { type: "session_pinned"; pinned: boolean }
  /**
   * #576 (format decision 6): the head moves — `to` is the ULID of the
   * event that becomes the new head (any node: tips and interior; an
   * interior target makes subsequent appends split implicitly). Appended
   * immediately and validated by the writer seam (`switchBranch`); the
   * LAST `branch_switched` in the log wins. Chrome only — never provider
   * context. Also the adoption action for #400 divergence (semantics d9).
   */
  | { type: "branch_switched"; to: string }
  /**
   * #576 (head semantics d10): the last `branch_switched.to` references an
   * id absent from the file (truncation, corruption). Readers fall back to
   * the last valid event and surface this visible warning chrome — a
   * session never silently reads the wrong branch. Chrome only.
   */
  | { type: "branch_dangling"; to: string }
  /**
   * #579 (spec §4): a bookmark names a node for humans and filters.
   * Appended by `bookmarkNode()` (store-level, file-based) and
   * `session.bookmarkNode(to, name?)` (live). Chrome only — never
   * provider context, never compaction input; counted for topology. The
   * LAST `tree_bookmarked` for a node wins (set/rename with `name`, clear
   * with `name: ""` — an explicit reset event keeps the log append-only,
   * same shape as `session_renamed`). `to` is a ULID present in the log
   * or a `line:N` bridge to a pre-tree event.
   */
  | { type: "tree_bookmarked"; to: string; name?: string }
  | { type: "user_message"; text: string; /**
   * ADR-0037: true when this message was requested by an extension
   * through `requestTurn` — machine-composed, run as a normal turn. The
   * marker rides the event, so replay, the transcript and analysis can
   * tell a human-typed turn from a machine-triggered one. Absent on real
   * user sends. */
      synthetic?: boolean; /**
   * #488 (vision note 3): structured snapshots of the `@path` mentions in
   * `text` — file content snapshots and directory listings assembled by
   * the core at send time, gated by read-permission rules. The log records
   * what the model actually saw that turn; mentions stay in the text.
   * Absent when the message carried no mentions. */
      attachments?: MentionAttachment[] }
  | { type: "mention_warnings"; warnings: MentionWarning[] }
  | { type: "assistant_delta"; text: string }
  | ({ type: "tool_call" } & ToolCall & {
      /** #300: the effective timeout (ms) this call runs under, resolved
       * by the tool itself (defaults included — e.g. bash's 30s). Absent
       * when the tool declares no timeout; the runner stamps it from
       * `Tool.timeoutMs` at call time so clients can render a live timer. */
      timeoutMs?: number;
    })
  | { type: "tool_result"; callId: string; ok: boolean; output: string; /** #731: structured failure reason on failed results only — lets
             * telemetry classify errors without parsing output text. */
        errorKind?: ToolErrorKind;
        /** #778: a browser screenshot's pixels, present only when the
         * serving model declared image input (#490 pipeline). Replay
         * rebuilds the image part, so resume/fork inherit what the model saw. */
        image?: { mime: string; base64: string } }
  /** #83: one record per model call — which model served it and what it cost.
   * #240: `thinkingLevel` audits the effective level actually sent, if any
   * (#239 decision 9: switches, fallbacks, provider defaults accounted). */
  | { type: "model_call"; model: string; usage: TokenUsage; thinkingLevel?: ThinkingLevel; /** #243: the call did not finalize a provider message (interrupted,
   * failed, or superseded by a retry/fallback stop). Its reasoning stays
   * displayable, but replay must not treat its partial content as a valid
   * assistant message. */ failed?: true;
    /** #1099: provider-reported usage detail beside the aggregate pair —
     * absent when the provider did not report it (never zero-filled); cache
     * tokens are a subset of input, never added to it. */
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    /** #1099: where the usage numbers came from (`"unavailable"` when the
     * provider reported nothing). */
    usageProvenance?: UsageProvenance;
    /** #1099: the per-attempt audit record (correlation, timing, sanitized
     * identity, outcome). Chrome only — absent on pre-#1099 events. */
    attempt?: AttemptTelemetry }
  /** #240: completed provider reasoning of one model call — persisted in
   * the log (Principle 2), replayed into the assistant message context
   * with its opaque continuation artifacts. Emitted before the call's
   * `model_call` event; partial reasoning of interrupted calls never
   * forms a valid assistant message. */
  | { type: "reasoning"; text: string; continuation?: Record<string, unknown> }
  /** Turn rollup (#83): this turn's usage totals and the models that served it. */
  | { type: "done"; usage?: TokenUsage; models?: string[] }
  | { type: "error"; reason: string; message: string }
  | { type: "cancelled" }
  | { type: "permission_requested"; callId: string; tool: string; /** ADR-0031: "extension" when an extension's `ask` outcome raised this prompt. */
      reason?: string }
  | { type: "permission_granted"; callId: string; tool: string; reason: PermissionGrantReason }
  | { type: "permission_denied"; callId: string; tool: string; reason: string }
  | { type: "permission_rule_added"; rule: PermissionRule }
  /** Resume chrome: runtime allow rules reconstructed from this log. */
  | { type: "permission_rules_restored"; rules: string[] }
  | { type: "session_mode"; mode: "normal" | "auto-accept" | "yolo" }
  /** ADR-0011: a turn-scoped skill prompt was attached to this turn's
   * send. Chrome — appended just before the turn's user_message; replay
   * ignores it (the skill body lived in the system prompt, not the log). */
  | { type: "skill_invoked"; name: string }
  /** #166: the active model ref changed mid-session (no new session;
   * takes effect from the next turn). Chrome — replay shows the switch. */
  | { type: "model_switched"; from: string; to: string }
  /** #948: a switch was refused because the target's catalog window
   * cannot hold the session's measured context. Chrome — the attempt is
   * recorded, nothing is applied, the current model stays in effect. */
  | { type: "switch_refused"; from: string; to: string; reason: "context_length";
      measured: number; window: number }
  /** ADR-0012: a fallback stop fired mid-call (route engine). Chrome —
   * replay shows the switch; the TUI toasts it (visible, not silent). */
  | { type: "fallback"; from: string; to: string; reason: string }
  /** #363: session route health changed the target serving future calls.
   * Chrome: `selected` stays the user's choice while `serving` may be a
   * fallback. Emitted only for fallback/recovery transitions. */
  | { type: "route_serving"; selected: string; serving: string; previous: string }
  /**
   * Compaction marker: replay uses `summary` in place of the covered
   * prefix while retaining the recent tail; the log itself is never
   * truncated. #578 (core spec d5/d7): the pointer is `upToId` — the ULID
   * (or legacy `line:N` bridge) of the last covered event on the
   * root→head path at marker time; markers resolve on-path, so a marker
   * on an abandoned branch is invisible until that branch is active
   * again. Legacy numeric `upTo` markers (pre-tree logs) read as
   * `line:N` and resolve positionally.
   */
  | { type: "compaction"; summary: string; upTo?: number; upToId?: string;
      /** ADR-0035: an extension's section cut was reduced to the survival
       * floor before rendering (chrome — audit only, replay ignores it). */
      keptByFloor?: true;
      /** #949: the verbatim tail begins inside the oldest kept turn — the
       * tail policy's intra-turn cut fired (chrome — audit only; replay
       * reads the pointer normally, this only explains the marker). */
      partialTail?: true;
      /** #766 (ADR-0051): which summarizer served the marker —
       * "deterministic", "llm-fallback" (the digest exceeded the budget
       * and the run degraded to the LLM summarizer), or absent for the
       * default LLM summarizer. Chrome — audit only. */
      summarizer?: string }
  | {
      type: "extension_loaded";
      name: string;
      version: string;
      /** ADR-0062 (#1132): the rail panel and overlay names this instance
       * registered, present only when there are any. Registration facts
       * ride the load event so the headless `/extensions` fold reports
       * them with no second store; the discount of *rendering* them stays
       * client-side (visible absence, never a mock). */
      panels?: string[];
      overlays?: string[];
      /** ADR-0053: the startup announcement — the capability slots this
       * enabled extension holds, present only when there are any. */
      capabilities?: string[];
    }
  | { type: "extension_failed"; name: string; reason: string; message: string }
  /**
   * ADR-0032 (apiVersion 1.1): a structured record an extension appended
   * through `ctx.appendEvent`. `extension` is stamped by the runtime (never
   * self-declared); the payload is opaque to the core — chrome only, never
   * fed to the model, never a turn error. Clients render one subdued line.
   */
  | { type: "extension_event"; extension: string; name: string; payload?: unknown }
  /**
   * ADR-0064 + ADR-0065 (apiVersion 1.13): the host performed one
   * operation an extension asked for through `ctx.host`. One event per
   * performed operation, success and refusal — the owner can answer "what
   * did this extension do?" without reconstruction. `path` is the
   * **resolved** target (symlinks followed), never the requested path;
   * `bytes` present only when the operation touched content; `to` on
   * rename names the resolved destination. Chrome only — never model
   * context, never a turn error. Secret redaction applies downstream.
   */
  | { type: "host_op"; callId: string; extension: string; op: "read" | "write" | "append" | "rename" | "delete" | "readlink" | "fetch";
      path: string; outcome: "ok"; bytes?: number; to?: string; host?: string; status?: number; credential?: string; method?: string }
  /**
   * ADR-0064: one host-performed operation was refused by the scope check.
   * Distinct from `extension_failed` (extension faults): a refusal is a
   * policy answer, never a crash. `reason` is the typed refusal reason;
   * `target` (ADR-0066) names the request or redirect host a fetch was
   * refused for.
   */
  | { type: "host_refused"; callId: string; extension: string; op: "read" | "write" | "append" | "rename" | "delete" | "readlink" | "fetch";
      path: string; reason: "outside_scope" | "invalid_path" | "invalid_url" | "unknown_credential" | "denied" | "too_large" | "failed"; resolved?: string; target?: string; credential?: string; method?: string }
  /**
   * ADR-0054 (#1129): a prompt-section composition change — a section
   * replaced or hidden by an extension, or restored to core text. Chrome
   * only, appended when the set of contributions in force changes, never
   * per model call; replay reconstructs what was in force. The event
   * records who and which part, never the words: extension text does not
   * enter the log verbatim (it is reproducible from the extension's code
   * and the version recorded here).
   */
  | { type: "prompt_override"; section: string; extension: string; version: string;
      mode: "replaced" | "hidden" | "restored" }
  /**
   * ADR-0038 (apiVersion 1.3): a client command addressed to one running
   * extension (`AgentSession.setExtensionState`). The payload is opaque to
   * the core and JSON-serializable; the event is chrome — never fed to the
   * model, never a turn error — and it is delivered to the named
   * extension's `onEvent` hooks alone. Recording it keeps the intent
   * replayable: a resumed log still explains why an extension was paused.
   */
  | { type: "extension_control"; extension: string; payload: ExtensionControlPayload }
  /**
   * One informational startup line (e.g. a bundled integration that stayed
   * inactive because its configuration is absent). Chrome only: never a
   * warning, never a turn error, never model context — the client renders
   * it dim.
   */
  | { type: "session_note"; text: string }
  /**
   * Parallel development lanes (ADR-0060): a lane was created and bound to
   * this session. Chrome only — metadata only, no work content. `log` is
   * the owning session file when the lane rides a child session.
   */
  | {
      type: "lane_created";
      laneId: string;
      featureGroupId: string;
      branchRef: string;
      worktreePath: string;
      baseRef: string;
      baseRevision: string;
      targetRef: string;
      relation: "independent" | "depends-on" | "integration";
      parentLaneId?: string;
    }
  /** A lane owned (or observed) by this session changed lifecycle status. Chrome only. */
  | { type: "lane_transitioned"; laneId: string; from: string; to: string }
  /** #774 / ADR-0029: the browser tool was requested but the toolchain is
   * missing. Visible diagnostic chrome — never a turn error. */
  | { type: "browser_unavailable"; reason: string }
  /** MCP lifecycle (#15): lazy start, per-server failures, session-end stop. */
  | { type: "mcp_server_started"; server: string; tools: string[] }
  | { type: "mcp_server_failed"; server: string; reason: string; message: string }
  | { type: "mcp_server_stopped"; server: string }
  /** Sampling/roots/elicitation request from an MCP server, refused (tools only). */
  | { type: "mcp_refused"; server: string; capability: "sampling" | "roots" | "elicitation" }
  /**
   * Memory (#38): the maintenance subagent appended facts after a turn.
   * Discreet by design — clients may show an indicator, never chat noise.
   */
  | { type: "memory_updated"; entries: number; topics: string[] }
  /**
   * #400 single-writer guard: the session JSONL grew beyond what this
   * writer last appended (another machine over a sync channel, or a second
   * process). Chrome only: never provider context. Clients surface a
   * visible warning; concurrent same-file use is unsupported — the
   * recovery path is forking the session.
   */
  | { type: "session_file_growth"; file: string; expectedBytes: number; actualBytes: number; /**
   * #576 (head semantics d8): the local writer's own tip and the foreign
   * writer's tip (ULIDs) at divergence-detection time — the event is
   * self-describing in replay and the recovery action needs no rescan.
   * Absent on a legacy (identity-less) foreign tail. */
      localTip?: string; foreignTip?: string }
  /**
   * Compaction failure (#466, ADR-0022): a run (auto or forced) could not
   * produce a marker. Chrome only — never provider context. Clients show
   * a sticky warning until the next successful `compaction` marker or a
   * user-forced retry clears it. The auto trigger keeps retrying with
   * backoff on later turns; a failed run wrote no marker (not lossy).
   */
  | { type: "compaction_failed"; reason: string }
  /**
   * #949: the producer refused structurally — nothing foldable under the
   * #949 tail policy (the tail preference leaves no covered turns, or no
   * window is known to legalize a cut). Chrome only — never provider
   * context. One event per new measurement (the auto path retries on
   * every new `model_call`); a successful marker or a later skip
   * supersedes it. Carries the numbers that justify the skip so clients
   * explain it without recomputing anything.
   */
  | { type: "compaction_skipped"; reason: "too_few_turns" | "no_covered_turns" | "last_turn_exceeds_window";
      turns: number; measuredTokens: number; window: number; tailTokens?: number }
  /**
   * ADR-0049 (door one, #986): a provider's own overflow refusal declared
   * the endpoint's context window for `model` (`window`), replacing the
   * catalog value `catalog` (0 when the catalog knew nothing). Appended
   * once per **correction** — never for a number moh already used — and
   * it is the store: a later resume re-derives the same effective window
   * from this event, so the window is a session fact with a log record,
   * not a second file. Chrome only — never provider context, never a turn
   * error; clients show it as one visible line.
   */
  | { type: "declared_window"; model: string; window: number; catalog: number }
  /**
   * #578 (head semantics d6): the newest on-path compaction marker's
   * `upToId` does not resolve on the active path (truncation,
   * corruption). Replay restarts context from the path start; this
   * visible warning chrome is appended at resume-open. Chrome only.
   */
  | { type: "compaction_dangling" }
  /**
   * #1100 (P1 quota telemetry): one quota fact observed at a point in
   * time — a provider-declared number (quota endpoint, header, or a
   * rate-limit/exhaustion error), the user's own declaration, or a local
   * estimate. Every measured field is optional and absent means unknown,
   * never zero; `window.kind` stays `"unknown"` unless the provider
   * declared the window's shape. The endpoint identity is the #1099
   * sanitized shape — no keys, no query strings. Chrome only — never
   * provider context, never a turn error.
   */
  | {
      type: "quota_observation";
      endpoint: EndpointIdentity;
      /** The model ref the observation applies to, when scoped to one. */
      model?: string;
      /** Whose capacity the fact describes. A `pool` names a shared pool
       * through `scopeKey` — two endpoints can share one. */
      scope: "account" | "workspace" | "endpoint" | "provider" | "model" | "pool";
      /** Deterministic identity of the observed capacity (endpoint key,
       * or the pool's name for `pool` scope). Redacted by construction. */
      scopeKey: string;
      /** The moh.json endpoint name the observation was recorded for,
       * when the recorder knew it (redacted, bounded). */
      endpointName?: string;
      unit?: "tokens" | "requests" | "credits" | "usd" | "provider-defined";
      /** The measured window. `kind` is `"unknown"` unless the provider
       * declared rolling/fixed semantics — moh never assumes one. */
      window?: { label: string; kind: "rolling" | "fixed" | "unknown"; interval?: string };
      /** All optional: absent = the provider did not report it, never zero. */
      limit?: number;
      remaining?: number;
      used?: number;
      percent?: number;
      /** Reset fact, only when declared: an absolute time and/or a
       * duration. Absent = unknown/undocumented mechanics. */
      resetAt?: number;
      resetMs?: number;
      /** Where the fact came from. */
      source: "quota-endpoint" | "provider-error" | "provider-header" | "user-config" | "local-estimate";
      /** Confidence badge carried over from the quota seam when the
       * source is a probe (`official` = documented API). */
      authority?: "official" | "undocumented";
      /** When the fact was observed and until when it may be trusted. */
      observedAt: string;
      validUntil?: string;
      /** #1099 correlation, when the observation rode a call attempt. */
      callId?: string;
      attemptId?: string;
      /** The ProviderError kind that produced this observation
       * (`rate_limited` / `quota_exhausted`), when source is an error. */
      errorKind?: string;
    }
  /**
   * #1100: one normalized quota boundary the loop recorded — a block
   * (`exhausted` / `rate_limited`, the provider refused or throttled),
   * or the recovery that followed it inside the same logical call.
   * Episodes are *boundaries*: the projection pairs them into distinct
   * episodes with temporal bounds. Chrome only.
   */
  | {
      type: "quota_episode";
      phase: "exhausted" | "rate_limited" | "recovered";
      scopeKey: string;
      endpoint: EndpointIdentity;
      servingModel?: string;
      startedAt: string;
      endedAt?: string;
      /** Wall-clock spent waiting/backing off between the blocked attempt
       * and the one that recovered, when the loop saw the recovery. */
      waitMs?: number;
      /** Retry-After hint the provider surfaced for the block, in ms. */
      retryAfterMs?: number;
      /** The recovery came from a different serving model (fallback). */
      usedFallback?: boolean;
      callId?: string;
      attemptId?: string;
    }
  /**
   * #1100: the user's own commercial declaration for an endpoint —
   * plan, price, billing period, promotion, overage policy. Explicit and
   * user-owned: moh never infers a plan from endpoint identity. Every
   * string is redacted (trimmed, bounded); the declaration is
   * time-bounded by `validFrom`/`validUntil`. Chrome only.
   */
  | {
      type: "commercial_declaration";
      /** The moh.json endpoint name the declaration is about. */
      endpoint: string;
      plan?: string;
      price?: number;
      currency?: string;
      billingPeriod?: "monthly" | "yearly" | "custom";
      promotion?: string;
      overagePolicy?: "blocked" | "metered" | "unknown";
      validFrom: string;
      validUntil?: string;
    }
  /**
   * Subagents (#13); orchestration requester/limits (ADR-0055, #1127):
   * `requester` names who asked — the model, or the extension by name —
   * and `limits` records the scopes actually applied to the child (its
   * tool allow-list when one was set, the effective permission mode, the
   * applied iteration cap). Together they make an orchestration's children
   * derivable from the log across restarts, with no session identity.
   */
  | {
      type: "subagent_spawn";
      callId: string;
      name: string;
      preset?: string;
      log: string;
      requester: { kind: "model" } | { kind: "extension"; extension: string };
      limits: {
        /** The child's applied tool allow-list, when the spec named one. */
        tools?: string[];
        /** The effective permission mode the child runs under. */
        mode: "normal" | "auto-accept" | "yolo";
        /** The applied per-turn iteration cap (resolved, never undefined). */
        maxIterations: number;
      };
    }
  /**
   * ADR-0055 "one stop" (#1127): everything one orchestration started was
   * stopped — the listed live children were aborted. Chrome only; the
   * aborted children still land their own `subagent_result` (cancelled).
   */
  | { type: "orchestration_stopped"; callIds: string[]; stoppedAt: string }
  /** Subagent finished; usage tokens accumulated by the child, where exposed. */
  | {
      type: "subagent_result";
      callId: string;
      name: string;
      status: "done" | "error" | "cancelled";
      usage: { inputTokens: number; outputTokens: number };
      log: string;
      /** #320: first lines of the child's output (bounded), so the
       * transcript block and replay show a preview without re-reading the
       * child log. Absent when the child produced no output. */
      preview?: string;
    }
  /**
   * #1101 (P2 task-outcome telemetry): the user (or a client on the
   * user's behalf) declared a task/work unit. The id is user-declared or
   * generated — it never carries prompt text, file paths of the work, or
   * content. A `reopens` id links a reworked task to its original
   * (revision/reopen relation). Chrome only.
   */
  | {
      type: "task_declared";
      /** Correlation id: user-declared or generated. No content rides it. */
      taskId: string;
      /** The original task this one reopens (revision relation). */
      reopens?: string;
      declaredAt: string;
    }
  /**
   * #1101: one verification run a client recorded against a declared
   * task — a test/typecheck/build/lint (or equivalent) command's result.
   * Explicit, never inferred: only a client seam creates one. The
   * diagnostics are bounded, redacted *metadata* (a one-line summary) —
   * never full tool output. Repeated verifications are separate events;
   * the projection reads the latest at any point in time. Chrome only.
   */
  | {
      type: "task_verification";
      taskId: string;
      verificationId: string;
      category: "test" | "typecheck" | "build" | "lint" | "other";
      ok: boolean;
      /** Process exit status, when known — absent = unknown, never zero. */
      exitStatus?: number;
      durationMs?: number;
      /** Optional bounded, redacted one-line summary (≤ 240 chars after
       * the seam's redaction) — never full output, never file contents. */
      summary?: string;
      recordedAt: string;
    }
  /**
   * #1101: the explicit user verdict on a declared task: accepted,
   * rejected, or revision-needed. `unresolved` records an explicit
   * close-without-verdict; absence of any outcome event stays `unknown`
   * in every projection — no signal is never success or failure.
   * Chrome only.
   */
  | {
      type: "task_outcome";
      taskId: string;
      outcome: "accepted" | "rejected" | "revision-needed" | "unresolved";
      decidedAt: string;
    };

/**
 * ADR-0032: one status an extension currently publishes (its name plus its
 * own text). Ephemeral client chrome: never in the event log, cleared at
 * session end and on extension reload.
 */
export interface ExtensionStatus {
  extension: string;
  text: string;
}

/** Why an "ask" decision was auto-granted (session mode), never a user round-trip. */
export type PermissionGrantReason = "yolo" | "auto_accept" | "user";

export type TurnStatus = "done" | "error" | "cancelled";

/** One selectable answer of an ask_user question: short label, a
 * description shown to the user, and optional preview content (markdown
 * or text) rendered beside the question when the option is focused and
 * echoed to the model on selection (ADR-0019). */
export interface AskUserOption {
  label: string;
  description: string;
  /** Optional side-by-side preview content; echoed on selection. */
  preview?: string;
}

/** One question of an ask_user question set (ADR-0019): full text, the
 * required header chip (≤ 12 chars), 2–4 options, an optional
 * multiSelect flag, and the retained `suggested` — a purely visual
 * "recommended" chip per question, never a default answer. */
export interface AskUserQuestion {
  question: string;
  header: string;
  options: AskUserOption[];
  /** Space/Enter multi-selection; the answer carries a label list. */
  multiSelect?: boolean;
  /** The option label flagged as the suggested answer (the ➡️ of the
   * grilling format). Purely visual: never a default, never marked in
   * the result when not chosen. */
  suggested?: string;
}

/** An ask_user call: 1–4 questions, all answered in one round. */
export interface AskUserQuestionSet {
  questions: AskUserQuestion[];
}

/** The user's answer to one ask_user question: an offered label (a
 * non-empty label list for multiSelect), an "Other" free-text answer,
 * or "Other" on top of a selection. */
export interface AskUserAnswer {
  /** The chosen option label(s): exactly one for single-select, one or
   * more for multiSelect. */
  labels?: string[];
  /** Free-text "Other" answer, may combine with labels. */
  other?: string;
}

/** The whole set of answers collected before the turn resumes: one
 * answer per question, in question order — or an explicit cancellation
 * of the entire set. */
export interface AskUserSetResult {
  answers: AskUserAnswer[];
  /** True when the user explicitly cancelled the set (from the summary
   * screen). The tool result becomes "cancelled". */
  cancelled?: boolean;
}

/** Runtime context handed to every tool execution. */
export interface ToolContext {
  signal: AbortSignal;
  cwd: string;
  /** Progressive output channel (streamed partial output); may be a no-op. */
  onProgress: (chunk: string) => void;
  /** Skill directories (#30): read-only roots outside cwd the read tool may access. */
  skillDirs?: readonly string[];
  /** #377: filesystem reach of built-in path tools. "unrestricted" (yolo
   * sessions) lifts the project-root containment — paths are still
   * resolved canonically (realpath, symlink-aware); only the final
   * containment check is skipped. */
  filesystemScope?: FilesystemScope;
  /** 1-based live-run turn sequence — lets tools scope caches per turn
   * (e.g. the read ledger's re-read nudge, #196). */
  turn?: number;
  /** Interactive question channel (ask_user). Absent (headless) → the tool fails fast. */
  askUser?: (set: AskUserQuestionSet) => Promise<AskUserSetResult> | AskUserSetResult;
}

/** The tool contract every built-in and extension tool implements. */
export interface Tool<A = any> {
  name: string;
  description: string;
  /** Zod schema validating raw model args before execute(). */
  inputSchema: z.ZodType<A> | undefined;
  /** True for tools that converse with the human (ask_user): they
   * serialize within a parallel batch — one pending question at a
   * time is a UI invariant (#223). */
  interactive?: boolean;
  /** #300: the effective timeout (ms) for one call, resolved from the
   * raw model args (defaults included). The tool runner stamps the value
   * on the `tool_call` event; a tool without a timeout concept simply
   * omits this. Must be self-sanitizing: never trust the raw arg shape. */
  timeoutMs?: (args: unknown) => number | undefined;
  /**
   * #775: args the permission gate should see for this call, when they
   * differ from the model's validated args (the browser tool adds the
   * live page URL and an element description). Absent = use the args.
   */
  gateArgs?: (args: A) => unknown;
  execute(args: A, ctx: ToolContext): Promise<string> | string;
}

/** A tool invocation requested by the model. */
export interface ToolCall {
  callId: string;
  name: string;
  args: unknown;
}

export interface TurnResult {
  status: TurnStatus;
  /** Present when status is "error" (e.g. "max_iterations" or a ProviderError kind). */
  reason?: string;
  message?: string;
}

/** ADR-0011: one turn-scoped skill prompt attached to a send. The body
 * rides the system prompt (skills section) for exactly one turn; the
 * user message stays the clean text. */
export interface SkillPrompt {
  /** Skill name for audit/chrome (the `skill_invoked` event). */
  name: string;
  /** Full instructions, body only (frontmatter already stripped). */
  text: string;
}

/** Options for `AgentSession.send` (ADR-0011). */
export interface SendOptions {
  /** Turn-scoped skill prompt; dropped when the turn settles. */
  prompt?: SkillPrompt;
  /** #765: arguments substituted into the prompt's placeholders
   * (`$1`, `$@`, `${name:-default}`) at send time. Absent: the prompt
   * text is used verbatim. */
  args?: SkillArgs;
}
