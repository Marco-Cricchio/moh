import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { installAiSdkWarningSink, subscribeAiSdkWarnings, formatAiSdkWarning } from "../src/ai-sdk-warnings";

/** #347: the AI SDK's warning system (`ai@7`, `logWarnings`) prints raw
 * `process.emitWarning` output that corrupts the interactive TUI. moh
 * installs its own sink (`globalThis.AI_SDK_LOG_WARNINGS`) that routes
 * every warning to a concise, moh-owned notice instead. */

const original = (globalThis as Record<string, unknown>).AI_SDK_LOG_WARNINGS;

describe("installAiSdkWarningSink", () => {
  beforeEach(() => { installAiSdkWarningSink(); });
  afterEach(() => {
    if (original === undefined) delete (globalThis as Record<string, unknown>).AI_SDK_LOG_WARNINGS;
    else (globalThis as Record<string, unknown>).AI_SDK_LOG_WARNINGS = original;
  });

  test("installs a function on the SDK's documented global", () => {
    expect(typeof (globalThis as Record<string, unknown>).AI_SDK_LOG_WARNINGS).toBe("function");
  });

  test("an SDK-style invocation reaches subscribers as a concise notice", () => {
    const seen: string[] = [];
    const off = subscribeAiSdkWarnings((m) => seen.push(m));
    const sink = (globalThis as { AI_SDK_LOG_WARNINGS: (o: unknown) => void }).AI_SDK_LOG_WARNINGS;
    sink({
      warnings: [
        { type: "unsupported_setting", setting: "structuredOutputs", provider: "x", detail: "not supported" },
        { type: "deprecated", feature: "old param" },
      ],
      provider: "anthropic",
      model: "claude-x",
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("AI SDK");
    expect(seen[0]).toContain("unsupported_setting");
    expect(seen[0]).not.toContain("\n"); // one line: never a dump
    expect(seen[1]).toContain("deprecated");
    off();
  });

  test("no subscriber, no crash", () => {
    const sink = (globalThis as { AI_SDK_LOG_WARNINGS: (o: unknown) => void }).AI_SDK_LOG_WARNINGS;
    expect(() => sink({ warnings: [{ type: "x" }] })).not.toThrow();
  });

  test("does not write the SDK warning to raw terminal streams", () => {
    const writes: string[] = [];
    const originalWrite = process.stderr.write;
    const originalWarn = console.warn;
    process.stderr.write = ((chunk: unknown) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write;
    console.warn = (...args: unknown[]) => writes.push(args.join(" "));
    try {
      const sink = (globalThis as { AI_SDK_LOG_WARNINGS: (o: unknown) => void }).AI_SDK_LOG_WARNINGS;
      sink({ warnings: [{ type: "unsupported_setting", detail: "not supported" }] });
      expect(writes).toEqual([]);
    } finally {
      process.stderr.write = originalWrite;
      console.warn = originalWarn;
    }
  });

  test("unsubscribed listeners stop receiving", () => {
    const seen: string[] = [];
    const off = subscribeAiSdkWarnings((m) => seen.push(m));
    off();
    const sink = (globalThis as { AI_SDK_LOG_WARNINGS: (o: unknown) => void }).AI_SDK_LOG_WARNINGS;
    sink({ warnings: [{ type: "x" }] });
    expect(seen).toHaveLength(0);
  });
});

describe("formatAiSdkWarning", () => {
  test("keeps type, elides context, truncates long payloads to one line", () => {
    const line = formatAiSdkWarning({ type: "unsupported_setting", detail: "x".repeat(500) }, "anthropic");
    expect(line.startsWith("AI SDK warning (anthropic): unsupported_setting")).toBe(true);
    expect(line.length).toBeLessThan(200);
    expect(line.endsWith("…")).toBe(true);
  });

  test("unknown shapes degrade to their JSON, still one line", () => {
    const line = formatAiSdkWarning({ mystery: true });
    expect(line.startsWith("AI SDK warning: ")).toBe(true);
    expect(line).toContain("mystery");
    expect(line).not.toContain("\n");
  });
});
