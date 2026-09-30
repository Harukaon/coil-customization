import { Check, Eye, EyeOff, KeyRound, LoaderCircle, RefreshCw } from "lucide-react";
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
 * The only thing a customer has to fill in is an API key. The address and protocol
 * are fixed by `sparkai.ts`; the provider is saved as an ordinary custom one.
 *
 * Like the other built-in providers it has a model catalog choice. "保留内置" follows
 * the gateway's own list (refreshed on every save); "自定义目录" lets the user hide
 * models and change a model's context window. The mode is not stored anywhere: a
 * saved catalog that is exactly the gateway's list is "保留内置", anything else is
 * a custom one.
 */
interface CatalogRow { base: ModelProviderModelConfiguration; shown: boolean; contextWindow?: number }
type CatalogMode = "builtin" | "custom";

function sameAsGateway(stored: ModelProviderModelConfiguration[], cloud: ModelProviderModelConfiguration[]): boolean {
  return cloud.length > 0 && cloud.length === stored.length
    && cloud.every((model) => stored.some((entry) => entry.id === model.id && entry.contextWindow === model.contextWindow));
}

function catalogRows(mode: CatalogMode, stored: ModelProviderModelConfiguration[], cloud: ModelProviderModelConfiguration[]): CatalogRow[] {
  if (mode === "builtin") return cloud.map((base) => ({ base, shown: true, contextWindow: base.contextWindow }));
  const rows = cloud.map((model): CatalogRow => {
    const kept = stored.find((entry) => entry.id === model.id);
    const base = kept ?? model;
    return { base, shown: Boolean(kept), contextWindow: base.contextWindow };
  });
  for (const kept of stored) if (!cloud.some((model) => model.id === kept.id)) rows.push({ base: kept, shown: true, contextWindow: kept.contextWindow });
  return rows;
}

export function SparkAiEditor({ runtimeId, onSaved, onReload, embedded, onConfiguredChange }: {
  runtimeId?: string;
  onSaved: (configuration: RuntimeConfiguration) => void;
  /** Lets the full provider list refresh after a save. */
  onReload?: () => Promise<void> | void;
  /** Onboarding renders it without the settings page chrome. */
  embedded?: boolean;
  /** Reports whether a key is stored, so onboarding can gate its Continue button. */
  onConfiguredChange?: (configured: boolean) => void;
}): React.JSX.Element {
  const [existing, setExisting] = useState<ModelProviderConfiguration>();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [mode, setMode] = useState<CatalogMode>("builtin");
  const [cloud, setCloud] = useState<ModelProviderModelConfiguration[]>([]);
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const fetchCloud = async (): Promise<ModelProviderModelConfiguration[]> => {
    await loadModelCatalog();
    const upstream = await window.coilcoil.request<FetchProviderModelsResult>({
      type: "fetch_provider_models",
      input: { baseUrl: sparkBaseUrl(), api: SPARK_API, provider: SPARK_PROVIDER_ID },
    }, runtimeId);
    return upstream.models.map(sparkModelFromUpstream);
  };

  const load = async (): Promise<void> => {
    try {
      const snapshot = await window.coilcoil.request<ModelProviderConfigurationSnapshot>({ type: "get_model_provider_configuration" }, runtimeId);
      const found = snapshot.providers.find((provider) => provider.id === SPARK_PROVIDER_ID);
      setExisting(found);
      if (embedded || !found?.apiKeyConfigured) return;
      let latest: ModelProviderModelConfiguration[] = [];
      try { latest = await fetchCloud(); } catch { /* offline: fall back to what is stored */ }
      setCloud(latest);
      const next: CatalogMode = latest.length && sameAsGateway(found.models, latest) ? "builtin" : "custom";
      setMode(next);
      setRows(catalogRows(next, found.models, latest));
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const refreshCloud = async (): Promise<void> => {
    setRefreshing(true);
    try {
      const latest = await fetchCloud();
      setCloud(latest);
      // Keep the user's choices; new gateway models arrive hidden in a custom catalog.
      const stored = rows.filter((row) => row.shown).map((row) => ({ ...row.base, contextWindow: row.contextWindow }));
      setRows(catalogRows(mode, mode === "custom" ? stored : latest, latest));
      toastSuccess(`云端目录共 ${latest.length} 个模型。`);
    } catch (caught) {
      toastError(`获取云端模型列表失败：${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      setRefreshing(false);
    }
  };

  const chooseMode = (next: CatalogMode): void => {
    if (next === mode) return;
    setMode(next);
    setRows(catalogRows(next, next === "custom" ? cloud : cloud, cloud));
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
      // 2) Decide the catalog. "保留内置" (and onboarding) follows the gateway's list; a
      //    custom catalog is the rows the user left shown.
      let refreshed = false;
      try {
        const chosen = embedded || mode === "builtin"
          ? await fetchCloud()
          : rows.filter((row) => row.shown).map((row) => ({ ...row.base, contextWindow: row.contextWindow ?? row.base.contextWindow }));
        if (!embedded && mode === "custom" && chosen.length === 0) throw new Error("至少要保留一个模型。");
        if (chosen.length) {
          result = await saveProvider(chosen, false);
          refreshed = true;
          // A fresh install has no default model, and the composer refuses to send
          // without one. Make the first listed model the default, but never replace
          // a default that already points at something usable.
          const current = result.configuration;
          const currentUsable = current.models.some((model) => model.provider === current.provider && model.id === current.modelId && model.configured);
          if (!currentUsable) {
            const first = chosen[0];
            result = { ...result, configuration: await window.coilcoil.request<RuntimeConfiguration>({
              type: "configure_model",
              provider: SPARK_PROVIDER_ID,
              modelId: first.id,
              thinkingLevel: first.reasoning ? "medium" : "off",
            }, runtimeId) };
          }
        }
      } catch (caught) {
        toastError(`密钥已保存，但模型目录没有更新：${caught instanceof Error ? caught.message : String(caught)}`);
      }
      setApiKey("");
      onSaved(result.configuration);
      await load();
      await onReload?.();
      if (refreshed) toastSuccess(embedded || mode === "builtin" ? "已保存，并获取到最新的模型列表。" : "已保存。");
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  if (embedded) {
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

  return <form className="openai-responses-ws-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <header className="provider-editor-heading">
      <div>
        <div className="provider-heading-tags"><span className="provider-source-tag">内置</span></div>
        <strong>{SPARK_PROVIDER_NAME}</strong>
        <small>填写 API Key 即可使用，模型目录默认跟随云端。</small>
      </div>
      <div className="provider-editor-actions">
        <button className="primary-button" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}保存设置</button>
      </div>
    </header>
    <div className="settings-grid">
      <label>API Key<span className="secret-input"><KeyRound size={13} /><input type="password" value={apiKey} autoComplete="off" placeholder={configured ? "已配置；留空即可保留" : "粘贴 API Key"} onChange={(event) => setApiKey(event.target.value)} /></span></label>
    </div>
    {configured ? <section className="provider-models-section">
      <header>
        <div>
          <strong>模型目录</strong>
          <small>{mode === "builtin" ? "保留内置：跟随云端的模型列表，每次保存时自动更新。" : "自定义目录：只保留你勾选的模型，可以单独调整上下文长度。"}</small>
        </div>
        <div className="provider-model-mode">
          <button className={mode === "builtin" ? "active" : ""} type="button" onClick={() => chooseMode("builtin")}>保留内置</button>
          <button className={mode === "custom" ? "active" : ""} type="button" onClick={() => chooseMode("custom")}>自定义目录</button>
        </div>
      </header>
      <div className="provider-model-toolbar">
        <button className="secondary-button" type="button" disabled={refreshing || saving} onClick={() => void refreshCloud()}>
          {refreshing ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{refreshing ? "正在获取…" : "刷新云端列表"}
        </button>
      </div>
      {mode === "builtin"
        ? <div className="provider-builtins-summary">当前目录包含 {rows.length} 个模型：{rows.map((row) => row.base.name || row.base.id).join("、") || "（尚未获取到）"}。</div>
        : <div className="spark-catalog">
          {rows.map((row, index) => <div className="spark-catalog-row" key={row.base.id}>
            <label className="checkbox-setting spark-catalog-show">
              <input type="checkbox" checked={row.shown} aria-label={`显示 ${row.base.name || row.base.id}`} onChange={(event) => setRows((current) => current.map((item, at) => at === index ? { ...item, shown: event.target.checked } : item))} />
              <span><strong>{row.base.name || row.base.id}</strong><small>{row.base.id}</small></span>
            </label>
            <label className="spark-catalog-context">
              <span>上下文</span>
              <input type="number" min={1000} step={1000} value={row.contextWindow ?? ""} aria-label={`${row.base.name || row.base.id} 上下文长度`} onChange={(event) => setRows((current) => current.map((item, at) => at === index ? { ...item, contextWindow: Number(event.target.value) || undefined } : item))} />
            </label>
          </div>)}
        </div>}
    </section> : null}
  </form>;
}
