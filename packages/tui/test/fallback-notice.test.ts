import { describe, expect, test } from "bun:test";
import { createFallbackWatcher, fallbackToastText } from "../src/fallback-notice";
import type { AgentEvent } from "@moh/core";

/** ADR-0012 (#234): a fallback stop is surfaced visibly (toast), never silent. */

function fallback(from: string, to: string, reason = "quota_exhausted"): AgentEvent {
  return { type: "fallback", from, to, reason };
}

describe("createFallbackWatcher", () => {
  test("fallback events produce an informative toast: reason on from → to", () => {
    const watch = createFallbackWatcher();
    expect(watch(fallback("zai/glm-5.3", "openai/gpt-5.6-terra")))
      .toBe("quota exhausted on zai/glm-5.3 → openai/gpt-5.6-terra");
    expect(watch(fallback("a/x", "b/y", "rate_limited"))).toBe("rate limited on a/x → b/y");
    expect(watch(fallback("a/x", "b/y", "network"))).toBe("network error on a/x → b/y");
  });

  test("every other event passes through silently", () => {
    const watch = createFallbackWatcher();
    const noise: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "v1" },
      { type: "user_message", text: "hi" },
      { type: "assistant_delta", text: "hi" },
      { type: "model_call", model: "zai/glm-5.3", usage: { inputTokens: 1, outputTokens: 1 } },
      { type: "model_call", model: "other/m2", usage: { inputTokens: 1, outputTokens: 1 } },
      { type: "model_switched", from: "a", to: "b" },
      { type: "done", usage: { inputTokens: 1, outputTokens: 1 }, models: ["zai/glm-5.3"] },
    ];
    for (const event of noise) expect(watch(event)).toBeNull();
  });
});

describe("fallbackToastText", () => {
  test("unknown reasons fall back to the raw kind", () => {
    expect(fallbackToastText("a", "b", "mystery")).toBe("mystery on a → b");
  });
});
