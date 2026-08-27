import { describe, expect, test } from "bun:test";
import { loadMohConfig } from "../src/config";

function parseConfig(endpoints: unknown[]): ReturnType<typeof loadMohConfig> {
  const file = `/tmp/moh-config-256-${Math.random().toString(36).slice(2)}.json`;
  require("node:fs").writeFileSync(file, JSON.stringify({ endpoints }));
  try {
    return loadMohConfig(file);
  } finally {
    require("node:fs").unlinkSync(file);
  }
}

describe("#256 capabilities.thinking schema", () => {
  test("a valid endpoint-level declaration parses with its levels", () => {
    const config = parseConfig([
      {
        name: "local",
        type: "openai-compat",
        baseUrl: "https://example.test/v1",
        capabilities: { thinking: { format: "openai-effort", levels: ["off", "low", "high"] } },
      },
    ]);
    expect(config.endpoints![0]!.capabilities?.thinking).toEqual({
      format: "openai-effort",
      levels: ["off", "low", "high"],
    });
  });

  test("per-model declarations parse; format is optional there", () => {
    const config = parseConfig([
      {
        name: "or",
        type: "openrouter",
        capabilities: {
          thinking: { format: "openai-effort", levels: ["low"] },
          thinkingModels: { "openai/gpt-5.6-luna": { levels: ["high", "xhigh"] } },
        },
      },
    ]);
    expect(config.endpoints![0]!.capabilities?.thinkingModels).toEqual({
      "openai/gpt-5.6-luna": { levels: ["high", "xhigh"] },
    });
  });

  test("non-canonical level names are rejected loudly", () => {
    expect(() =>
      parseConfig([
        { name: "local", type: "openai-compat", baseUrl: "x", capabilities: { thinking: { format: "openai-effort", levels: ["tiny"] } } },
      ]),
    ).toThrow("canonical thinking levels");
  });

  test("an unknown format is rejected", () => {
    expect(() =>
      parseConfig([
        { name: "local", type: "openai-compat", baseUrl: "x", capabilities: { thinking: { format: "xai-effort", levels: ["low"] } } },
      ]),
    ).toThrow();
  });

  test("an empty levels list is rejected", () => {
    expect(() =>
      parseConfig([
        { name: "local", type: "openai-compat", baseUrl: "x", capabilities: { thinking: { format: "openai-effort", levels: [] } } },
      ]),
    ).toThrow();
  });
});
