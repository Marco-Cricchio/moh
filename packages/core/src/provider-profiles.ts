/**
 * Authoritative built-in OpenAI-compatible provider metadata for #726.
 *
 * This module is declarative: transport construction and configuration
 * integration deliberately live elsewhere. URLs are documented defaults;
 * placeholders in URLs must be substituted by the endpoint owner.
 */
export interface ProviderProfile {
  id: string;
  displayName: string;
  baseUrl: string;
  apiKeyEnv: string;
  defaultModel: string;
  endpointAlternatives?: readonly { label: string; baseUrl: string }[];
  thinking?: { format: "openai-effort"; compatible: boolean };
}

export const PROVIDER_PROFILES = [
  { id: "deepseek", displayName: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY", defaultModel: "deepseek-chat" },
  { id: "groq", displayName: "Groq", baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY", defaultModel: "llama-3.3-70b-versatile" },
  { id: "cerebras", displayName: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", apiKeyEnv: "CEREBRAS_API_KEY", defaultModel: "llama-3.3-70b" },
  { id: "nvidia-nim", displayName: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", apiKeyEnv: "NVIDIA_API_KEY", defaultModel: "meta/llama-3.3-70b-instruct" },
  { id: "together", displayName: "Together AI", baseUrl: "https://api.together.xyz/v1", apiKeyEnv: "TOGETHER_API_KEY", defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  { id: "fireworks", displayName: "Fireworks AI", baseUrl: "https://api.fireworks.ai/inference/v1", apiKeyEnv: "FIREWORKS_API_KEY", defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct" },
  { id: "huggingface", displayName: "Hugging Face", baseUrl: "https://router.huggingface.co/v1", apiKeyEnv: "HF_TOKEN", defaultModel: "meta-llama/Llama-3.3-70B-Instruct" },
  { id: "mistral", displayName: "Mistral AI", baseUrl: "https://api.mistral.ai/v1", apiKeyEnv: "MISTRAL_API_KEY", defaultModel: "mistral-large-latest" },
  { id: "moonshot", displayName: "Moonshot AI", baseUrl: "https://api.moonshot.ai/v1", apiKeyEnv: "MOONSHOT_API_KEY", defaultModel: "moonshot-v1-128k" },
  { id: "minimax", displayName: "MiniMax", baseUrl: "https://api.minimax.io/v1", apiKeyEnv: "MINIMAX_API_KEY", defaultModel: "MiniMax-Text-01" },
  { id: "zai", displayName: "Z.ai", baseUrl: "https://api.z.ai/api/coding/paas/v4", apiKeyEnv: "ZAI_API_KEY", defaultModel: "glm-4.7" },
  { id: "qwen", displayName: "Qwen", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", apiKeyEnv: "DASHSCOPE_API_KEY", defaultModel: "qwen-plus", endpointAlternatives: [{ label: "China", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" }] },
  { id: "xiaomi-mimo", displayName: "Xiaomi MiMo", baseUrl: "https://api.xiaomimimo.com/v1", apiKeyEnv: "XIAOMI_MIMO_API_KEY", defaultModel: "mimo-v2-flash" },
  { id: "vercel-ai-gateway", displayName: "Vercel AI Gateway", baseUrl: "https://ai-gateway.vercel.sh/v1", apiKeyEnv: "AI_GATEWAY_API_KEY", defaultModel: "openai/gpt-4o-mini", thinking: { format: "openai-effort", compatible: true } },
  { id: "cloudflare-ai-gateway", displayName: "Cloudflare AI Gateway", baseUrl: "https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat", apiKeyEnv: "CLOUDFLARE_API_TOKEN", defaultModel: "meta/llama-3.3-70b-instruct" },
  { id: "baseten", displayName: "Baseten", baseUrl: "https://inference.baseten.co/v1", apiKeyEnv: "BASETEN_API_KEY", defaultModel: "deepseek-ai/DeepSeek-R1" },
] as const satisfies readonly ProviderProfile[];

export type ProviderProfileId = (typeof PROVIDER_PROFILES)[number]["id"];

/** Finds a first-party profile by its stable endpoint type. */
export function providerProfile(id: string): ProviderProfile | undefined {
  return PROVIDER_PROFILES.find((profile) => profile.id === id);
}

export function isProviderProfile(id: string): id is ProviderProfileId {
  return providerProfile(id) !== undefined;
}

/** The documented endpoint choices a guided setup can safely present. */
export function providerRequiresBaseUrlInput(id: string): boolean {
  return providerProfile(id)?.baseUrl.includes("{") ?? false;
}

export function providerEndpointChoices(id: string): readonly { label: string; baseUrl: string }[] {
  const profile = providerProfile(id);
  return profile ? [{ label: profile.displayName, baseUrl: profile.baseUrl }, ...(profile.endpointAlternatives ?? [])] : [];
}
