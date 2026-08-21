/**
 * Live streaming smoke test (#47): one script, three scenarios per provider
 * kind — text streaming, one tool-call round-trip, abort mid-stream.
 *
 * Providers are enabled by their env key; unset keys are skipped:
 *   MOH_ENDPOINT_ANTHROPIC_API_KEY  (default model claude-sonnet-4-5)
 *   MOH_ENDPOINT_OPENAI_API_KEY     (default model gpt-4o-mini)
 *   MOH_ENDPOINT_GOOGLE_API_KEY     (default model gemini-2.5-flash)
 *   MOH_ENDPOINT_ZAI_API_KEY        (openai-compat, default model glm-4.6)
 *   MOH_ENDPOINT_OLLAMA_API_KEY     (openai-compat -> local Ollama, default model qwen3:4b;
 *                                    set to any non-empty value, e.g. "local" — no key needed)
 * Optional per-provider model overrides: MOH_SMOKE_<NAME>_MODEL.
 * Throwaway keys only; never commit them.
 *
 * Usage: bun packages/core/scripts/smoke-live.ts
 */
import { z } from "zod";
import {
  Endpoint,
  createRoute,
  createSession,
  type AgentEvent,
  type Provider,
  type Tool,
} from "../src/index";

interface Case {
  name: string;
  kind: "anthropic" | "openai" | "google";
  baseUrl?: string;
  defaultModel: string;
}

const CASES: Case[] = [
  { name: "anthropic", kind: "anthropic", defaultModel: "claude-sonnet-4-5" },
  { name: "openai", kind: "openai", defaultModel: "gpt-4o-mini" },
  { name: "google", kind: "google", defaultModel: "gemini-2.5-flash" },
  { name: "zai", kind: "openai", baseUrl: "https://api.z.ai/api/paas/v4", defaultModel: "glm-4.6" },
  { name: "ollama", kind: "openai", baseUrl: "http://localhost:11434/v1", defaultModel: "qwen3:4b" },
];

function modelOf(c: Case): string {
  return process.env[`MOH_SMOKE_${c.name.toUpperCase()}_MODEL`] ?? c.defaultModel;
}

function eventTypes(session: { history(): AgentEvent[] }): string[] {
  return session.history().map((e) => e.type);
}

function assistantText(session: { history(): AgentEvent[] }): string {
  return session.history().map((e) => (e.type === "assistant_delta" ? e.text : "")).join("");
}

function echoTool(): Tool<{ text: string }> {
  return {
    name: "echo",
    description: "Echoes the given text back verbatim. Use it when the user asks you to echo something.",
    inputSchema: z.object({ text: z.string() }),
    execute: async (args: { text: string }) => `echo:${args.text}`,
  };
}

/** Scenario 1: text streams as multiple deltas and completes with `done`. */
async function smokeText(label: string, provider: Provider) {
  const session = createSession({ provider });
  const result = await session.send("Reply with exactly one word: hello");
  const deltas = session.history().filter((e) => e.type === "assistant_delta").length;
  const types = eventTypes(session);
  if (result.status !== "done") throw new Error(`${label}/text: turn ended ${JSON.stringify(result)}`);
  if (deltas < 1) throw new Error(`${label}/text: no assistant deltas`);
  if (!types.includes("done")) throw new Error(`${label}/text: missing done event`);
  const text = assistantText(session);
  console.log(`  text: ok (${deltas} deltas) ${JSON.stringify(text.slice(0, 60))}`);
}

/** Scenario 2: model calls the tool, core executes it, result returns, done. */
async function smokeTool(label: string, provider: Provider) {
  const session = createSession({ provider, tools: { echo: echoTool() }, permissions: { bypassPermissions: true } });
  const result = await session.send("Call the echo tool with text 'ping'. Then say 'tool ok'.");
  const types = eventTypes(session);
  if (result.status !== "done") throw new Error(`${label}/tool: turn ended ${JSON.stringify(result)}`);
  for (const t of ["tool_call", "permission_granted", "tool_result", "done"]) {
    if (!types.includes(t)) throw new Error(`${label}/tool: missing ${t} event (got ${types.join(",")})`);
  }
  console.log(`  tool: ok (round-trip tool_call -> tool_result -> done)`);
}

/** Scenario 3: abort mid-stream resolves cancelled without hanging. */
async function smokeAbort(label: string, provider: Provider) {
  const session = createSession({ provider });
  const turn = session.send("Count slowly from 1 to 100, one number per line.");
  // Abort only once the stream is provably mid-flight: at least one delta
  // has arrived (a fast model could otherwise finish the whole turn first).
  // history() is a snapshot; re-poll it.
  const deadline = Date.now() + 120_000;
  let deltasBeforeAbort = 0;
  while (Date.now() < deadline) {
    deltasBeforeAbort = session.history().filter((e) => e.type === "assistant_delta").length;
    if (deltasBeforeAbort > 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  session.abort();
  const result = await turn;
  if (deltasBeforeAbort < 1) throw new Error(`${label}/abort: no deltas arrived before abort; cannot verify mid-stream abort`);
  if (result.status !== "cancelled") throw new Error(`${label}/abort: expected cancelled, got ${JSON.stringify(result)}`);
  console.log(`  abort: ok (aborted after ${deltasBeforeAbort} deltas, turn resolved cancelled)`);
}

async function main() {
  const failures: string[] = [];
  for (const c of CASES) {
    const key = process.env[`MOH_ENDPOINT_${c.name.toUpperCase()}_API_KEY`];
    if (!key) {
      console.log(`[skip] ${c.name}: MOH_ENDPOINT_${c.name.toUpperCase()}_API_KEY not set`);
      continue;
    }
    const endpoint = new Endpoint({ name: c.name, kind: c.kind, ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}) });
    const provider: Provider = createRoute({ target: { endpoint, modelId: modelOf(c) } });
    console.log(`[${c.name}] model ${modelOf(c)} (kind ${c.kind}${c.baseUrl ? ", compat" : ""})`);
    for (const scenario of [smokeText, smokeTool, smokeAbort]) {
      try {
        await scenario(c.name, provider);
      } catch (err) {
        failures.push(`${scenario.name}:${c.name}: ${(err as Error).message}`);
        console.error(`  FAIL: ${(err as Error).message}`);
      }
    }
  }
  if (failures.length) {
    console.error(`\n${failures.length} failure(s):\n` + failures.map((f) => ` - ${f}`).join("\n"));
    process.exit(1);
  }
  console.log("\nall live smoke scenarios passed");
}

await main();
