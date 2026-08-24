/**
 * Live model listing for OpenAI-compatible endpoints (#181 follow-up):
 * `GET <baseUrl>/models` — the standard listing route every
 * openai-compat backend (z.ai, lmstudio, ollama's compat layer, …)
 * speaks. Complements the vendored `subscriptionModelCatalog` (static,
 * subscription providers) with a runtime fetch for endpoints that have
 * no vendored catalog. Failures throw — callers fall back to free-text
 * entry, exactly like an unknown provider type.
 */
export async function listOpenAiCompatModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const res = await fetch(url, {
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { id?: unknown }[] };
  const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
  if (ids.length === 0) throw new Error(`${url} → empty model list`);
  return ids;
}
