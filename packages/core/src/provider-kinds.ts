/**
 * The built-in provider kinds (#1423): one record per kind, in the order
 * every derived list keeps. `ProviderKind` (route), the builtin set
 * (provider-registry), the wire map and the OAuth kinds and base URLs
 * (wire), `PROVIDER_PROFILES` (provider-profiles), the OpenAI-shaped live
 * listings (live-model-catalog) and the provider credential variable
 * (route) all read this table instead of keeping their own copy.
 *
 * Data only: per-kind behavior (quota probes, auth flows) stays where it is.
 */
import type { WireApi } from "./wire";

interface ProviderKindRecord {
  readonly kind: string;
  /** Default wire (ADR-0010); a catalog entry may override it per model. */
  readonly wire: WireApi;
  /** A builtin OAuth provider (ADR-0010). */
  readonly oauth: boolean;
  /** Documented default backend when the endpoint sets no baseUrl. */
  readonly defaultBaseUrl?: string;
  /** Provider credential variable, read after MOH_ENDPOINT_<NAME>_API_KEY. */
  readonly apiKeyEnv?: string;
  /** Lists its models over the OpenAI `<baseUrl>/models` shape (#920). */
  readonly liveListing?: "openai";
  /** First-party OpenAI-compatible profile metadata (#726). */
  readonly profile?: {
    readonly displayName: string;
    readonly defaultModel: string;
    readonly endpointAlternatives?: readonly { readonly label: string; readonly baseUrl: string }[];
  };
}

export const PROVIDER_KINDS = [
  { kind: "anthropic", wire: "anthropic-messages", oauth: false },
  { kind: "openai", wire: "openai-chat", oauth: false },
  { kind: "google", wire: "google", oauth: false },
  { kind: "github-copilot", wire: "openai-chat", oauth: true, defaultBaseUrl: "https://api.individual.githubcopilot.com" },
  { kind: "openrouter", wire: "openai-chat", oauth: true, defaultBaseUrl: "https://openrouter.ai/api/v1" },
  { kind: "kimi-coding", wire: "anthropic-messages", oauth: true, defaultBaseUrl: "https://api.kimi.com/coding" },
  { kind: "xai", wire: "openai-chat", oauth: true, defaultBaseUrl: "https://api.x.ai/v1" },
  { kind: "deepseek", wire: "openai-chat", oauth: false, defaultBaseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY", liveListing: "openai", profile: { displayName: "DeepSeek", defaultModel: "deepseek-chat" } },
  { kind: "groq", wire: "openai-chat", oauth: false, defaultBaseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY", liveListing: "openai", profile: { displayName: "Groq", defaultModel: "llama-3.3-70b-versatile" } },
  { kind: "cerebras", wire: "openai-chat", oauth: false, defaultBaseUrl: "https://api.cerebras.ai/v1", apiKeyEnv: "CEREBRAS_API_KEY", liveListing: "openai", profile: { displayName: "Cerebras", defaultModel: "llama-3.3-70b" } },
  { kind: "nvidia-nim", wire: "openai-chat", oauth: false, defaultBaseUrl: "https://integrate.api.nvidia.com/v1", apiKeyEnv: "NVIDIA_API_KEY", liveListing: "openai", profile: { displayName: "NVIDIA NIM", defaultModel: "meta/llama-3.3-70b-instruct" } },
  { kind: "together", wire: "openai-chat", oauth: false, defaultBaseUrl: "https://api.together.xyz/v1", apiKeyEnv: "TOGETHER_API_KEY", liveListing: "openai", profile: { displayName: "Together AI", defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo" } },
  { kind: "fireworks", wire: "openai-chat", oauth: false, defaultBaseUrl: "https://api.fireworks.ai/inference/v1", apiKeyEnv: "FIREWORKS_API_KEY", liveListing: "openai", profile: { displayName: "Fireworks AI", defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct" } },
  { kind: "huggingface", wire: "openai-chat", oauth: false, defaultBaseUrl: "https://router.huggingface.co/v1", apiKeyEnv: "HF_TOKEN", liveListing: "openai", profile: { displayName: "Hugging Face", defaultModel: "meta-llama/Llama-3.3-70B-Instruct" } },
  { kind: "mistral", wire: "openai-chat", oauth: false, defaultBaseUrl: "https://api.mistral.ai/v1", apiKeyEnv: "MISTRAL_API_KEY", liveListing: "openai", profile: { displayName: "Mistral AI", defaultModel: "mistral-large-latest" } },
  { kind: "moonshot", wire: "openai-chat", oauth: false, defaultBaseUrl: "https://api.moonshot.ai/v1", apiKeyEnv: "MOONSHOT_API_KEY", liveListing: "openai", profile: { displayName: "Moonshot AI", defaultModel: "moonshot-v1-128k" } },
  { kind: "minimax", wire: "openai-chat", oauth: false, defaultBaseUrl: "https://api.minimax.io/v1", apiKeyEnv: "MINIMAX_API_KEY", liveListing: "openai", profile: { displayName: "MiniMax", defaultModel: "MiniMax-Text-01" } },
  { kind: "zai", wire: "openai-chat", oauth: false, defaultBaseUrl: "https://api.z.ai/api/coding/paas/v4", apiKeyEnv: "ZAI_API_KEY", liveListing: "openai", profile: { displayName: "Z.ai", defaultModel: "glm-4.7" } },
  { kind: "qwen", wire: "openai-chat", oauth: false, defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", apiKeyEnv: "DASHSCOPE_API_KEY", liveListing: "openai", profile: { displayName: "Qwen", defaultModel: "qwen-plus", endpointAlternatives: [{ label: "China", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" }] } },
  { kind: "xiaomi-mimo", wire: "openai-chat", oauth: false, defaultBaseUrl: "https://api.xiaomimimo.com/v1", apiKeyEnv: "XIAOMI_MIMO_API_KEY", liveListing: "openai", profile: { displayName: "Xiaomi MiMo", defaultModel: "mimo-v2-flash" } },
  { kind: "vercel-ai-gateway", wire: "openai-chat", oauth: false, defaultBaseUrl: "https://ai-gateway.vercel.sh/v1", apiKeyEnv: "AI_GATEWAY_API_KEY", liveListing: "openai", profile: { displayName: "Vercel AI Gateway", defaultModel: "openai/gpt-4o-mini" } },
  { kind: "cloudflare-ai-gateway", wire: "openai-chat", oauth: false, defaultBaseUrl: "https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat", apiKeyEnv: "CLOUDFLARE_API_TOKEN", liveListing: "openai", profile: { displayName: "Cloudflare AI Gateway", defaultModel: "meta/llama-3.3-70b-instruct" } },
  { kind: "baseten", wire: "openai-chat", oauth: false, defaultBaseUrl: "https://inference.baseten.co/v1", apiKeyEnv: "BASETEN_API_KEY", profile: { displayName: "Baseten", defaultModel: "deepseek-ai/DeepSeek-R1" } },
  { kind: "opencode", wire: "openai-chat", oauth: false, apiKeyEnv: "OPENCODE_API_KEY" },
] as const satisfies readonly ProviderKindRecord[];
