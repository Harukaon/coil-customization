import { Check, Eye, EyeOff, KeyRound, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  FetchProviderModelsResult,
  ModelProviderConfiguration,
  ModelProviderModelConfiguration,
  ModelProviderConfigurationSnapshot,
  ModelProviderSaveResult,
  RuntimeConfiguration,
} from "@coilcoil/runtime-protocol";
import { toastError, toastSuccess } from "../../ui/toast";
import { loadModelCatalog } from "./modelCatalog";
import { SPARK_API, SPARK_DEFAULT_MODELS, SPARK_PROVIDER_ID, SPARK_PROVIDER_NAME, sparkBaseUrl, sparkModelFromUpstream } from "./sparkai";

/**
 * The first-launch key form: one API key, nothing else. The address and protocol are
 * fixed by `sparkai.ts`, the model list is whatever the gateway offers for that key,
 * and the first listed model becomes the default. Everything after that (hiding
 * models, context windows) is done on the provider's page in Settings.
 */
export function SparkAiEditor({ runtimeId, onSaved, onConfiguredChange }: {
  runtimeId?: string;
  onSaved: (configuration: RuntimeConfiguration) => void;
  /** Reports whether a key is stored, so onboarding can gate its Continue button. */
  onConfiguredChange?: (configured: boolean) => void;
}): React.JSX.Element {
  const [existing, setExisting] = useState<ModelProviderConfiguration>();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const load = async (): Promise<void> => {
    try {
      const snapshot = await window.coilcoil.request<ModelProviderConfigurationSnapshot>({ type: "get_model_provider_configuration" }, runtimeId);
      setExisting(snapshot.providers.find((provider) => provider.id === SPARK_PROVIDER_ID));
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  useEffect(() => { void load(); }, [runtimeId]);

  const configured = Boolean(existing?.apiKeyConfigured);
  useEffect(() => { onConfiguredChange?.(configured); }, [configured]);

  const save = async (): Promise<void> => {
    if (!apiKey.trim() && !configured) {
      toastError("请先填写 API Key。");
      return;
    }
    setSaving(true);
    try {
      const saveProvider = (models: ModelProviderModelConfiguration[], withKey: boolean): Promise<ModelProviderSaveResult> => window.coilcoil.request<ModelProviderSaveResult>({
        type: "save_model_provider_configuration",
        input: {
          provider: {
            id: SPARK_PROVIDER_ID,
            name: SPARK_PROVIDER_NAME,
            baseUrl: sparkBaseUrl(),
            api: SPARK_API,
            headers: {},
            compat: {},
            authHeader: false,
            disabled: false,
            replaceModels: true,
            models,
            modelOverrides: {},
          },
          credential: withKey ? {
            method: "api-key",
            values: { key: apiKey.trim() },
            preserveFields: apiKey.trim() ? [] : ["key"],
          } : undefined,
        },
      }, runtimeId);
      // 1) Store the key. The catalog is a placeholder (or the previous one) until step 2.
      let result = await saveProvider(existing?.models.length ? existing.models : SPARK_DEFAULT_MODELS, true);
      // 2) Ask the gateway which models this key can use and make that the catalog.
      let refreshed = false;
      try {
        await loadModelCatalog();
        const upstream = await window.coilcoil.request<FetchProviderModelsResult>({
          type: "fetch_provider_models",
          input: { baseUrl: sparkBaseUrl(), api: SPARK_API, provider: SPARK_PROVIDER_ID },
        }, runtimeId);
        if (upstream.models.length) {
          const models = upstream.models.map(sparkModelFromUpstream);
          result = await saveProvider(models, false);
          refreshed = true;
          // A fresh install has no default model, and the composer refuses to send
          // without one. Make the first listed model the default, but never replace
          // a default that already points at something usable.
          const current = result.configuration;
          const currentUsable = current.models.some((model) => model.provider === current.provider && model.id === current.modelId && model.configured);
          if (!currentUsable) {
            const first = models[0];
            result = { ...result, configuration: await window.coilcoil.request<RuntimeConfiguration>({
              type: "configure_model",
              provider: SPARK_PROVIDER_ID,
              modelId: first.id,
              thinkingLevel: first.reasoning ? "medium" : "off",
            }, runtimeId) };
          }
        }
      } catch (caught) {
        toastError(`密钥已保存，但获取模型列表失败：${caught instanceof Error ? caught.message : String(caught)}`);
      }
      setApiKey("");
      onSaved(result.configuration);
      await load();
      if (refreshed) toastSuccess("已保存，并获取到最新的模型列表。");
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  return <form className="spark-onboard" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <label htmlFor="spark-api-key">API Key</label>
    <div className="spark-onboard-field">
      <KeyRound size={16} />
      <input
        id="spark-api-key"
        type={revealed ? "text" : "password"}
        value={apiKey}
        autoComplete="off"
        spellCheck={false}
        autoFocus
        placeholder={configured ? "已配置，留空即保留" : "粘贴你的 API Key"}
        onChange={(event) => setApiKey(event.target.value)}
      />
      <button type="button" aria-label={revealed ? "隐藏" : "显示"} onClick={() => setRevealed((value) => !value)}>{revealed ? <EyeOff size={15} /> : <Eye size={15} />}</button>
    </div>
    <button className="spark-onboard-save" type="submit" disabled={saving || (!apiKey.trim() && !configured)}>
      {saving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{saving ? "保存中…" : configured && !apiKey.trim() ? "已配置" : "保存"}
    </button>
    <p>服务地址和模型已经内置，只需要这一个密钥。</p>
  </form>;
}
