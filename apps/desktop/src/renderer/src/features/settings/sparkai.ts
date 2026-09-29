import type { ModelProviderModelConfiguration } from "@coilcoil/runtime-protocol";

/**
 * Private-deployment preset: the one provider customers use. Everything that is
 * specific to this build lives here so the rest of the app stays identical to
 * upstream CoilCoil and merges stay small.
 */
export const SPARK_PROVIDER_ID = "sparkai";
export const SPARK_PROVIDER_NAME = "Spark AI";
/** new-api gateway: the OpenAI-compatible routes live under /v1. */
export const SPARK_BASE_URL = "https://ai.sparkai.si/v1";
export const SPARK_API = "openai-completions";

/**
 * Placeholder catalog. A custom provider must define at least one model, so this
 * is what gets saved until the real list is fetched from the cloud server.
 */
export const SPARK_DEFAULT_MODELS: ModelProviderModelConfiguration[] = [
  { id: "gpt-5", name: "GPT-5", reasoning: true, input: ["text", "image"] },
];
