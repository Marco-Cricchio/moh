/**
 * Live smoke test for the default provider bundle (#28, follow-up of #47).
 * z.ai is OpenAI-compatible: Endpoint kind "openai" + baseUrl.
 *
 * Usage:
 *   export MOH_ENDPOINT_ZAI_API_KEY=<your-temporary-key>
 *   bun packages/core/scripts/smoke-zai.ts [model-id]
 *
 * Never commit the key. Use a throwaway key only.
 */
import { Endpoint, createRoute, createSession } from "../src/index";

const MODEL = process.argv[2] ?? "glm-4.6";
const key = process.env.MOH_ENDPOINT_ZAI_API_KEY;
if (!key) {
  console.error("Set MOH_ENDPOINT_ZAI_API_KEY first (see file header).");
  process.exit(1);
}

const endpoint = new Endpoint({
  name: "zai",
  kind: "openai",
  baseUrl: "https://api.z.ai/api/paas/v4",
});
const route = createRoute({ target: { endpoint, modelId: MODEL } });

const session = createSession({ provider: route });
const result = await session.send(
  "Reply with exactly one short sentence confirming you can stream.",
);
console.log("turn result:", result);
for (const event of session.history()) {
  if (event.type === "assistant_delta") process.stdout.write(event.text);
  else if (event.type !== "session_start" && event.type !== "session_mode" && event.type !== "user_message") {
    console.log(`\n[event] ${event.type}`);
  }
}
console.log("\nhistory events:", session.history().length);
