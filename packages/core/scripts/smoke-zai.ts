/**
 * Live fallback-chain smoke test (#28/#47): z.ai as primary (expected to
 * fail with quota_exhausted on a zero-balance key), mock endpoint as the
 * declared fallback. Verifies chain-triggering against a real API error.
 *
 * Usage:
 *   export MOH_ENDPOINT_ZAI_API_KEY=<your-temporary-key>
 *   bun packages/core/scripts/smoke-zai.ts [model-id]
 */
import { createSession, MockProvider } from "../src/index";
import { Endpoint, createRoute } from "../src/route";

const MODEL = process.argv[2] ?? "glm-4.6";
const key = process.env.MOH_ENDPOINT_ZAI_API_KEY;
if (!key) {
  console.error("Set MOH_ENDPOINT_ZAI_API_KEY first (see file header).");
  process.exit(1);
}

// Primary: real z.ai endpoint (openai-compat).
const zai = new Endpoint({
  name: "zai",
  kind: "openai",
  baseUrl: "https://api.z.ai/api/paas/v4",
});

// Fallback: a mock endpoint that answers successfully.
const fallback = new Endpoint({ name: "mock-fallback", kind: "mock" });
const fallbackProvider = MockProvider.scripted([
  { deltas: ["[mock-fallback] ", "the ", "primary ", "endpoint ", "failed; ", "I ", "took ", "over."], finish: "stop", deltaDelayMs: 40 },
]);

const route = createRoute({
  target: { endpoint: zai, modelId: MODEL },
  fallbacks: [{ endpoint: fallback, modelId: "mock-model" }],
  retries: 0, // no retry on the primary: straight to fallback on quota
  createStream: (target) => {
    if (target.endpoint === fallback) {
      return (messages, signal) => fallbackProvider.stream(messages, signal);
    }
    return undefined as never; // undefined -> default AI SDK factory (z.ai)
  },
});

const session = createSession({ provider: route });
const result = await session.send("Say hello.");
console.log("turn result:", result);
let text = "";
for (const event of session.history()) {
  if (event.type === "assistant_delta") text += event.text;
  else if (event.type !== "session_start" && event.type !== "session_mode" && event.type !== "user_message" && event.type !== "assistant_delta") {
    console.log(`[event] ${event.type}${event.type === "error" ? ` (${(event as { reason: string }).reason})` : ""}`);
  }
}
console.log("assistant text:", JSON.stringify(text));
