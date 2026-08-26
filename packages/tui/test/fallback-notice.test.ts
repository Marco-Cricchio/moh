import { describe, expect, test } from "bun:test";
import { createFallbackWatcher } from "../src/fallback-notice";
import type { AgentEvent } from "@moh/core";

/** ADR-0012 (#234): a fallback stop is surfaced visibly (toast), never silent. */

describe("createFallbackWatcher", () => {
  test("no notice for a single model call or repeats of the same model", () => {
    const watch = createFallbackWatcher();
    expect(watch({ type: "model_call", model: "zai/glm-5.3", usage: { inputTokens: 1, outputTokens: 1 } })).toBeNull();
    expect(watch({ type: "model_call", model: "zai/glm-5.3", usage: { inputTokens: 1, outputTokens: 1 } })).toBeNull();
  });

  test("notice when the model changes within a turn (fallback fired)", () => {
    const watch = createFallbackWatcher();
    watch({ type: "model_call", model: "zai/glm-5.3", usage: { inputTokens: 1, outputTokens: 1 } });
    expect(watch({ type: "model_call", model: "openai/gpt-5.6-terra", usage: { inputTokens: 1, outputTokens: 1 } }))
      .toBe("fallback → openai/gpt-5.6-terra");
  });

  test("a new turn or an explicit model switch resets the baseline", () => {
    const watch = createFallbackWatcher();
    watch({ type: "model_call", model: "zai/glm-5.3", usage: { inputTokens: 1, outputTokens: 1 } });
    watch({ type: "user_message", text: "again" });
    expect(watch({ type: "model_call", model: "openai/gpt-5.6-terra", usage: { inputTokens: 1, outputTokens: 1 } })).toBeNull();
    watch({ type: "model_call", model: "openai/gpt-5.6-terra", usage: { inputTokens: 1, outputTokens: 1 } });
    watch({ type: "model_switched", from: "openai/gpt-5.6-terra", to: "google/gemini-3-pro" });
    expect(watch({ type: "model_call", model: "google/gemini-3-pro", usage: { inputTokens: 1, outputTokens: 1 } })).toBeNull();
  });

  test("other events pass through silently", () => {
    const watch = createFallbackWatcher();
    const noise: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "v1" },
      { type: "assistant_delta", text: "hi" },
      { type: "done", usage: { inputTokens: 1, outputTokens: 1 }, models: ["zai/glm-5.3"] },
      { type: "error", reason: "x", message: "y" },
    ];
    for (const event of noise) expect(watch(event)).toBeNull();
  });
});
