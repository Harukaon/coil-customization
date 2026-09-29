import { Check, KeyRound, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  ModelProviderConfiguration,
  ModelProviderConfigurationSnapshot,
  ModelProviderSaveResult,
  RuntimeConfiguration,
} from "@coilcoil/runtime-protocol";
import { toastError, toastSuccess } from "../../ui/toast";
import { SPARK_API, SPARK_BASE_URL, SPARK_DEFAULT_MODELS, SPARK_PROVIDER_ID, SPARK_PROVIDER_NAME } from "./sparkai";

/**
 * The only thing a customer fills in: an API key. The address, protocol and model
 * list are fixed by `sparkai.ts` and saved as an ordinary custom provider, so the
 * rest of the settings code treats it like any other.
 */
export function SparkAiEditor({ runtimeId, onSaved, onReload, embedded }: {
  runtimeId?: string;
  onSaved: (configuration: RuntimeConfiguration) => void;
  /** Lets the full provider list refresh after a save. */
  onReload?: () => Promise<void> | void;
  /** Onboarding renders it without the settings page chrome. */
  embedded?: boolean;
}): React.JSX.Element {
  const [existing, setExisting] = useState<ModelProviderConfiguration>();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);

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

  const save = async (): Promise<void> => {
    if (!apiKey.trim() && !configured) {
      toastError("请先填写 API Key。");
      return;
    }
    setSaving(true);
    try {
      const result = await window.coilcoil.request<ModelProviderSaveResult>({
        type: "save_model_provider_configuration",
        input: {
          provider: {
            id: SPARK_PROVIDER_ID,
            name: SPARK_PROVIDER_NAME,
            baseUrl: SPARK_BASE_URL,
            api: SPARK_API,
            headers: {},
            compat: {},
            authHeader: false,
            disabled: false,
            replaceModels: true,
            // Keep whatever catalog is already stored (it may have come from the cloud).
            models: existing?.models.length ? existing.models : SPARK_DEFAULT_MODELS,
            modelOverrides: {},
          },
          credential: {
            method: "api-key",
            values: { key: apiKey.trim() },
            preserveFields: apiKey.trim() ? [] : ["key"],
          },
        },
      }, runtimeId);
      setApiKey("");
      onSaved(result.configuration);
      await load();
      await onReload?.();
      toastSuccess("已保存。");
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  return <form className="openai-responses-ws-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <header className="provider-editor-heading">
      <div>
        {embedded ? null : <span className="provider-source-tag">内置</span>}
        <strong>{SPARK_PROVIDER_NAME}</strong>
        <small>填写 API Key 即可使用，其余配置已内置。</small>
      </div>
      <button className="primary-button" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}保存</button>
    </header>
    <div className="settings-grid">
      <label>API Key<span className="secret-input"><KeyRound size={13} /><input type="password" value={apiKey} autoComplete="off" placeholder={configured ? "已配置；留空即可保留" : "粘贴 API Key"} onChange={(event) => setApiKey(event.target.value)} /></span></label>
    </div>
  </form>;
}
