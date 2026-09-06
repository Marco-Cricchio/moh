import { describe, expect, it } from "bun:test";
import { simulateReadableStream } from "ai/test";
import { aiSdkStreamFor } from "../src/providers/ai-sdk";
import { ProviderError } from "../src/types";
import { Endpoint, type RouteTarget } from "../src/route";
import type { LanguageModel } from "ai";
import type { Message } from "../src/types";

// #404 regression: a provider error surfaced by the AI SDK stream as a plain
// (non-Error) structured object must not render as "[object Object]".
type StreamPart = Record<string, unknown> & { type: string };

function mockModel(parts: StreamPart[]): LanguageModel {
  return {
    specificationVersion: "v4",
    provider: "mock",
    doStream: async () => ({ stream: simulateReadableStream({ chunks: parts }) as any }),
  } as unknown as LanguageModel;
}

async function run(parts: StreamPart[]): Promise<ProviderError> {
  const target: RouteTarget = {
    endpoint: new Endpoint({ name: "t-openai", kind: "openai", apiKey: "k" }),
    modelId: "m",
  };
  const stream = aiSdkStreamFor(target, "k", undefined, mockModel(parts));
  const messages: Message[] = [{ role: "user", parts: [{ kind: "text", text: "hi" }] }];
  try {
    for await (const _ of stream(messages, new AbortController().signal)) void _;
  } catch (err) {
    return err as ProviderError;
  }
  throw new Error("expected the stream to throw");
}

describe("#404 plain-object provider error is not [object Object]", () => {
  it("extracts the message from a plain structured error object", async () => {
    const err = await run([
      {
        type: "error",
        error: {
          name: "AI_APICallError",
          message: "Invalid 'input_text': expected a string.",
          statusCode: 400,
          responseBody: JSON.stringify({
            error: { message: "Invalid 'input_text': expected a string.", type: "invalid_request_error", param: "input_text" },
          }),
        },
      },
    ]);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe("invalid_request");
    expect(err.message).not.toBe("[object Object]");
    expect(err.message).toContain("input_text");
  });

  it("extracts a nested structured message instead of coercing it to [object Object]", async () => {
    const err = await run([
      {
        type: "error",
        error: {
          statusCode: 400,
          message: { error: { message: "Tool result does not match a tool call.", param: "messages" } },
        },
      },
    ]);
    expect(err.kind).toBe("invalid_request");
    expect(err.message).not.toBe("[object Object]");
    expect(err.message).toContain("Tool result");
    expect(err.message).toContain("messages");
  });

  it("extracts a structured responseBody object", async () => {
    const err = await run([
      {
        type: "error",
        error: {
          statusCode: 400,
          responseBody: { error: { message: "Invalid reasoning continuation.", param: "reasoning" } },
        },
      },
    ]);
    expect(err.kind).toBe("invalid_request");
    expect(err.message).not.toBe("[object Object]");
    expect(err.message).toContain("Invalid reasoning continuation");
  });

  it("unwraps a cause when the outer SDK wrapper has no useful message", async () => {
    const err = await run([
      {
        type: "error",
        error: {
          cause: { statusCode: 400, data: { error: { message: "Malformed request payload." } } },
        },
      },
    ]);
    expect(err.kind).toBe("invalid_request");
    expect(err.message).not.toBe("[object Object]");
    expect(err.message).toContain("Malformed request payload");
  });

  it("reads SDK fields from Error instances whose message is not useful", async () => {
    const sdkError = Object.assign(new Error(""), {
      statusCode: 400,
      responseBody: { error: { message: "Malformed Error-instance payload." } },
    });
    Object.defineProperty(sdkError, "message", { value: { error: { message: "Nested Error-instance message." } }, configurable: true });
    const err = await run([{ type: "error", error: sdkError }]);
    expect(err.message).not.toBe("[object Object]");
    expect(err.message).toContain("Nested Error-instance message");
  });

  it("uses nested response data to classify quota failures", async () => {
    const err = await run([{ type: "error", error: {
      message: "Request failed",
      response: { status: 400, data: { error: { message: "Insufficient balance; recharge the account." } } },
    } }]);
    expect(err.kind).toBe("quota_exhausted");
  });

  it("bounds a non-JSON response body but preserves thrown primitives", async () => {
    const err = await run([{ type: "error", error: { statusCode: 400, responseBody: "x".repeat(500) } }]);
    expect(err.message).toHaveLength(301);
    expect(err.message.endsWith("…")).toBe(true);
  });

  it("falls back to the responseBody hint when the plain object has no message", async () => {
    const err = await run([
      {
        type: "error",
        error: { statusCode: 400, responseBody: "Unsupported parameter: 'temperature'" },
      },
    ]);
    expect(err.kind).toBe("invalid_request");
    expect(err.message).not.toBe("[object Object]");
    expect(err.message).toContain("temperature");
  });
});
