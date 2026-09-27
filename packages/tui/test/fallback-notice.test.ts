import { describe, expect, test } from "bun:test";
import { createFallbackWatcher, fallbackToastText } from "../src/fallback-notice";
import type { AgentEvent } from "@moh/core";

/** ADR-0012 (#234): a fallback stop is surfaced visibly (toast), never silent. */

function fallback(from: string, to: string, reason = "quota_exhausted"): AgentEvent {
  return { type: "fallback", from, to, reason };
}

describe("createFallbackWatcher", () => {
  test("only serving transitions produce fallback and recovery notices", () => {
    const watch = createFallbackWatcher();
    expect(watch(fallback("zai/glm-5.3", "openai/gpt-5.6-terra"))).toBeNull();
    // A `fallback` record is the detailed log entry, never the notice.
    expect(watch(fallback("zai/glm-5.3", "opencode-go/deepseek-v4.1-flash", "rate_limited"))).toBeNull();
    // ADR-0050: the notice names the pair with the one core formatter.
    expect(watch({ type: "route_serving", selected: "zai/glm-5.3", previous: "zai/glm-5.3", serving: "zai/glm-5.3" })).toBeNull();
    expect(watch({ type: "route_serving", selected: "zai/glm-5.3", previous: "zai/glm-5.3", serving: "openai/gpt-5.6-terra" }))
      .toBe("using fallback zai/glm-5.3 → openai/gpt-5.6-terra");
    expect(watch({ type: "route_serving", selected: "zai/glm-5.3", previous: "openai/gpt-5.6-terra", serving: "zai/glm-5.3" }))
      .toBe("recovered zai/glm-5.3");
  });

  test("a record that names no move raises no notice", () => {
    const watch = createFallbackWatcher();
    // A child's birth declaration is scoped to the child's own log (ADR-0050
    // §6) and a client watching the parent never sees it; a `previous` that
    // equals `serving` names no transition at all.
    expect(watch({ type: "route_serving", selected: "openai/gpt-6-astra", previous: "opencode-go/deepseek-v4.1-flash", serving: "opencode-go/deepseek-v4.1-flash" }))
      .toBeNull();
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
