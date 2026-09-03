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
