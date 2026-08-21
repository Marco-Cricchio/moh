import { createHash } from "node:crypto";
import type { Message, Provider, StreamEvent, ToolSpec } from "./types";

/**
 * Echo provider (issue #39, spec #16): deterministically reflects what moh
 * actually sends — system prompt, tools, messages — as a single JSON reply
 * of sha256 digests. No credentials, no network. Used by the context-
 * engineering e2e suite: if an injected instructions file goes missing or
 * the tool registry regresses, the digests change and tests fail.
 */

/** Stable digest of a message: sha256 over its concatenated text parts. */
function textOf(message: Message): string {
  return message.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
}

function messageSha256(message: Message): string {
  return createHash("sha256").update(textOf(message)).digest("hex");
}

/** What the provider received on one model call. */
export interface EchoRequest {
  readonly system: string;
  readonly tools: readonly ToolSpec[];
  readonly messages: readonly Message[];
}

export interface EchoSummary {
  echo: 1;
  systemSha256: string;
  /** sha256 over sorted "name: description" tool lines. */
  toolsSha256: string;
  tools: string[];
  messages: { role: string; sha256: string }[];
}

export class EchoProvider implements Provider {
  readonly name = "echo";
  #requests: EchoRequest[] = [];

  /** The most recent model call as received (for in-process assertions). */
  get lastRequest(): EchoRequest | undefined {
    return this.#requests.at(-1);
  }

  /** All model calls so far, in order. */
  get requests(): readonly EchoRequest[] {
    return this.#requests;
  }

  static summarize(req: EchoRequest): EchoSummary {
    const toolLines = [...req.tools].map((t) => `${t.name}: ${t.description}`).sort();
    return {
      echo: 1,
      systemSha256: createHash("sha256").update(req.system).digest("hex"),
      toolsSha256: createHash("sha256").update(toolLines.join("\n")).digest("hex"),
      tools: toolLines.map((l) => l.slice(0, l.indexOf(":"))),
      messages: req.messages.map((m) => ({ role: m.role, sha256: messageSha256(m) })),
    };
  }

  async *stream(messages: Message[], signal: AbortSignal, tools?: readonly ToolSpec[]): AsyncIterable<StreamEvent> {
    // Convention (see AgentSession.#assemblePrompt): the system prompt is
    // always the first message, role "system".
    const system = messages[0]?.role === "system" ? textOf(messages[0]) : "";
    // Snapshot: the caller may keep mutating its message array after the call.
    const snapshot: EchoRequest = {
      system,
      tools: tools ? [...tools] : [],
      messages: messages.map((m) => ({ role: m.role, parts: m.parts.map((p) => ({ ...p })) })),
    };
    this.#requests.push(snapshot);
    if (signal.aborted) return;
    yield { type: "text_delta", text: JSON.stringify(EchoProvider.summarize(snapshot)) };
    yield { type: "finish", reason: "stop" };
  }
}
