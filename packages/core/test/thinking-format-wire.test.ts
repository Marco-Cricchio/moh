import { describe, expect, test } from "bun:test";
import { thinkingForWire } from "../src/providers/ai-sdk";

describe("#256 thinkingForWire with a declared format", () => {
  test("openai-effort maps every level to reasoningEffort on any wire", () => {
    expect(thinkingForWire("openai-chat", "high", "openai-effort")).toEqual({
      providerOptions: { openai: { reasoningEffort: "high" } },
      effective: "high",
    });
    expect(thinkingForWire("anthropic-messages", "off", "openai-effort")).toEqual({
      providerOptions: { openai: { reasoningEffort: "none" } },
      effective: "off",
    });
  });

  test("anthropic-effort maps to anthropic effort even on the openai wire", () => {
    expect(thinkingForWire("openai-chat", "low", "anthropic-effort")).toEqual({
      providerOptions: { anthropic: { effort: "low" } },
      effective: "low",
    });
    expect(thinkingForWire("openai-chat", "off", "anthropic-effort")).toEqual({
      providerOptions: { anthropic: { thinking: { type: "disabled" } } },
      effective: "off",
    });
  });

  test("google-thinking-level drops xhigh/max and nulls for off", () => {
    expect(thinkingForWire("openai-chat", "xhigh", "google-thinking-level")).toBeUndefined();
    expect(thinkingForWire("openai-chat", "max", "google-thinking-level")).toBeUndefined();
    expect(thinkingForWire("openai-chat", "medium", "google-thinking-level")).toEqual({
      providerOptions: { google: { thinkingConfig: { thinkingLevel: "medium" } } },
      effective: "medium",
    });
    expect(thinkingForWire("openai-chat", "off", "google-thinking-level")).toEqual({
      providerOptions: { google: { thinkingConfig: { thinkingLevel: null } } },
      effective: "off",
    });
  });

  test("openrouter-effort maps like openai-effort (the openrouter wrapper rewrites it)", () => {
    expect(thinkingForWire("openai-chat", "high", "openrouter-effort")).toEqual({
      providerOptions: { openai: { reasoningEffort: "high" } },
      effective: "high",
    });
  });

  test("no declared format keeps the wire-derived mapping (#240 behavior)", () => {
    expect(thinkingForWire("anthropic-messages", "high")).toEqual({
      providerOptions: { anthropic: { effort: "high" } },
      effective: "high",
    });
    expect(thinkingForWire("google", "xhigh")).toBeUndefined();
  });
});
