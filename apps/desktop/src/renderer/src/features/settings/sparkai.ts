import type { ModelProviderModelConfiguration, RuntimeConfiguration } from "@coilcoil/runtime-protocol";
import { lookupModelMeta, thinkingLevelMapFromLevels } from "./modelCatalog";

/**
 * Private-deployment preset: the one provider customers use. Everything that is
 * specific to this build lives here so the rest of the app stays identical to
 * upstream CoilCoil and merges stay small.
 */
export const SPARK_PROVIDER_ID = "sparkai";
export const SPARK_PROVIDER_NAME = "Spark AI";
/** new-api gateway: the OpenAI-compatible routes live under /v1. */
export const SPARK_BASE_URL = "https://ai.sparkai.si/v1";
/** The address in use. The e2e suite points it at a local mock through this localStorage key. */
export function sparkBaseUrl(): string {
  try { return window.localStorage.getItem("coilcoil.sparkBaseUrl") || SPARK_BASE_URL; } catch { return SPARK_BASE_URL; }
}
export const SPARK_API = "openai-completions";

/**
 * Placeholder catalog. A custom provider must define at least one model, so this
 * is what gets saved until the real list is fetched from the cloud server.
 */
export const SPARK_DEFAULT_MODELS: ModelProviderModelConfiguration[] = [
  { id: "gpt-5", name: "GPT-5", reasoning: true, input: ["text", "image"] },
];

/** Turn one entry of the gateway's /models list into a catalog model, using what the local catalog knows about that id. */
export function sparkModelFromUpstream(upstream: { id: string; name?: string }): ModelProviderModelConfiguration {
  const meta = lookupModelMeta(upstream.id);
  return {
    id: upstream.id,
    name: meta.name || upstream.name || upstream.id,
    reasoning: meta.reasoning ?? false,
    ...(meta.thinkingLevels?.length ? { thinkingLevelMap: thinkingLevelMapFromLevels(meta.thinkingLevels) as ModelProviderModelConfiguration["thinkingLevelMap"] } : {}),
    input: meta.input ?? ["text"],
    contextWindow: meta.contextWindow ?? 128000,
    maxTokens: meta.maxTokens ?? 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

/**
 * Default picks for the onboarding "Agent" step: the gateway's models in the
 * order it lists them, Explore, Worker, Reviewer, then session naming. With fewer
 * than four models the list wraps around rather than leaving a slot empty.
 */
export function sparkAgentDefaults(configuration?: RuntimeConfiguration): { explore: string; worker: string; reviewer: string; naming: string } | undefined {
  const models = configuration?.models.filter((model) => model.provider === SPARK_PROVIDER_ID && model.configured) ?? [];
  if (!models.length) return undefined;
  const at = (index: number): string => { const model = models[index % models.length]; return `${model.provider}/${model.id}`; };
  return { explore: at(0), worker: at(1), reviewer: at(2), naming: at(3) };
}
