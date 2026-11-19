import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/** Only calls containing video use the compatible dialect. Existing text,
 * image and audio calls retain the OpenAI adapter and its provider options.
 * Both clients use the same fetch so the reasoning wrapper still applies. */
export function chatModelWithVideo(
  options: Parameters<typeof createOpenAI>[0] & { baseURL: string },
  modelId: string,
): Extract<LanguageModel, { specificationVersion: "v4" }> {
  const standard = createOpenAI(options).chat(modelId);
  const video = createOpenAICompatible({ ...options, name: "openai", baseURL: options.baseURL, includeUsage: true }).chatModel(modelId);
  const choose = (args: Parameters<typeof standard.doStream>[0]) => args.prompt.some((message) =>
    message.role === "user" && message.content.some((part) => part.type === "file" && part.mediaType.startsWith("video/")),
  ) ? video : standard;
  return {
    specificationVersion: standard.specificationVersion,
    provider: standard.provider,
    modelId: standard.modelId,
    supportedUrls: standard.supportedUrls,
    doGenerate: (args) => choose(args).doGenerate(args),
    doStream: (args) => choose(args).doStream(args),
  };
}
