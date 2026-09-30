import { Check, ChevronRight, CircleDot, KeyRound, LoaderCircle, LogIn, LogOut, Plus, RefreshCw, Search, Trash2, X, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  OpenAIResponsesWsConfiguration,
  FetchProviderModelsResult,
  ModelProviderConfiguration,
  ModelProviderAuthState,
  ModelProviderConfigurationInput,
  ModelProviderConfigurationSnapshot,
  ModelProviderCredentialConfiguration,
  ModelProviderCredentialField,
  ModelProviderModelConfiguration,
  ModelProviderSaveResult,
  RuntimeConfiguration,
  TestProviderConnectionResult,
  ThinkingLevel,
} from "@coilcoil/runtime-protocol";
import { toastError, toastSuccess } from "../../ui/toast";
import {
  loadModelCatalog,
  mergeSelectedUpstreamModels,
  THINKING_LEVELS,
  thinkingLevelMapFromLevels,
  thinkingLevelsFromMap,
  type ModelCatalogMeta,
} from "./modelCatalog";
import { Select, type SelectOption } from "../../ui/Select";
import { UpstreamModelPicker, type UpstreamModelOption } from "./UpstreamModelPicker";
import { ProviderOAuthDialog } from "./ProviderOAuthDialog";
import { SPARK_API, SPARK_DEFAULT_MODELS, SPARK_PROVIDER_ID, SPARK_PROVIDER_NAME, sparkBaseUrl, sparkCatalogIsSynced, sparkModelFromUpstream } from "./sparkai";
import { Checkbox, Field, TextArea, TextField } from "../../ui/form";

export type EditableModel = ModelProviderModelConfiguration & { uid: string };
type ProviderDraft = Omit<ModelProviderConfigurationInput["provider"], "models"> & { models: EditableModel[] };

interface ModelAdvancedText {
  thinkingLevelMap: string;
  samplingParams: string;
  headers: string;
  compat: string;
  costTiers: string;
}

interface ProviderFormState {
  draft: ProviderDraft;
  providerHeadersText: string;
  providerCompatText: string;
  overridesText: string;
  modelAdvanced: Record<string, ModelAdvancedText>;
  credentialMethod: string;
  credentialValues: Record<string, string>;
  credentialPreserveFields: string[];
  credentialDirty: boolean;
  preserveApiKeyReference: boolean;
}

const THINKING_OPTIONS: SelectOption[] = [
  { value: "off", label: "off" },
  { value: "minimal", label: "minimal" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max" },
];

function uid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function providerFormFingerprint(state: ProviderFormState): string {
  return JSON.stringify(state);
}

function jsonText(value: unknown): string {
  return value && typeof value === "object" && Object.keys(value).length ? JSON.stringify(value, null, 2) : "{}";
}

function parseJsonObject(value: string, label: string): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "{}") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`${label}不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label}必须是 JSON 对象。`);
  return parsed as Record<string, unknown>;
}

function parseStringMap(value: string, label: string): Record<string, string> | undefined {
  const parsed = parseJsonObject(value, label);
  if (!parsed) return undefined;
  if (Object.values(parsed).some((item) => typeof item !== "string")) throw new Error(`${label}中的值必须全部是字符串。`);
  return parsed as Record<string, string>;
}

function parseCostTiers(value: string, label: string): NonNullable<ModelProviderModelConfiguration["cost"]>["tiers"] | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "[]") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`${label}不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${label}必须是 JSON 数组。`);
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${label}的第 ${index + 1} 项必须是对象。`);
    const tier = item as Record<string, unknown>;
    const keys = ["inputTokensAbove", "input", "output", "cacheRead", "cacheWrite"] as const;
    if (keys.some((key) => typeof tier[key] !== "number" || !Number.isFinite(tier[key]))) {
      throw new Error(`${label}的每一项都需要 inputTokensAbove、input、output、cacheRead、cacheWrite 数字字段。`);
    }
    return {
      inputTokensAbove: tier.inputTokensAbove as number,
      input: tier.input as number,
      output: tier.output as number,
      cacheRead: tier.cacheRead as number,
      cacheWrite: tier.cacheWrite as number,
    };
  });
}

function blankModel(): EditableModel {
  return {
    uid: uid(),
    id: "",
    name: "",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function modelFromUpstream(option: UpstreamModelOption, meta: ModelCatalogMeta): EditableModel {
  const base = blankModel();
  return {
    ...base,
    id: option.id,
    name: meta.name || option.name || option.id,
    reasoning: meta.reasoning ?? base.reasoning,
    // A catalogue that states the effort words is the only reliable source for
    // which thinking levels this model actually accepts.
    thinkingLevelMap: meta.thinkingLevels?.length
      ? thinkingLevelMapFromLevels(meta.thinkingLevels) as EditableModel["thinkingLevelMap"]
      : base.thinkingLevelMap,
    input: meta.input ?? base.input,
    contextWindow: meta.contextWindow ?? base.contextWindow,
    maxTokens: meta.maxTokens ?? base.maxTokens,
  };
}

function toEditableModel(model: ModelProviderModelConfiguration): EditableModel {
  return { ...clone(model), uid: uid() };
}

function initialAdvancedText(models: EditableModel[]): Record<string, ModelAdvancedText> {
  return Object.fromEntries(models.map((model) => [model.uid, {
    thinkingLevelMap: jsonText(model.thinkingLevelMap),
    samplingParams: jsonText(model.samplingParams),
    headers: jsonText(model.headers),
    compat: jsonText(model.compat),
    costTiers: JSON.stringify(model.cost?.tiers ?? [], null, 2),
  }]));
}

function draftFromProvider(provider: ModelProviderConfiguration): ProviderDraft {
  const { source: _source, apiKeyConfigured: _configured, authType: _authType, credential: _credential, hasPrivateApiKeyReference: _privateReference, models, ...draft } = provider;
  return { ...clone(draft), disabled: Boolean(provider.disabled), models: models.map(toEditableModel) };
}

function blankProvider(index: number): ProviderDraft {
  return {
    id: index === 1 ? "custom-provider" : `custom-provider-${index}`,
    name: "新的服务商",
    baseUrl: "",
    api: "openai-completions",
    headers: {},
    compat: {},
    authHeader: false,
    apiKeyReference: undefined,
    disabled: false,
    replaceModels: true,
    models: [blankModel()],
    modelOverrides: {},
  };
}

function apiOptions(snapshot: ModelProviderConfigurationSnapshot | undefined): SelectOption[] {
  return [
    { value: "", label: "继承服务商协议", detail: "仅在模型覆盖时使用" },
    ...(snapshot?.supportedApis ?? []).map((api) => ({ value: api.id, label: api.label, detail: api.description })),
  ];
}

function modelThinkingLevels(model: EditableModel, configuration: RuntimeConfiguration | undefined, providerId: string): ThinkingLevel[] {
  const runtimeModel = configuration?.models.find((item) => item.provider === providerId && item.id === model.id);
  if (runtimeModel?.supportedThinkingLevels.length) return runtimeModel.supportedThinkingLevels;
  return thinkingLevelsFromMap(model.thinkingLevelMap, Boolean(model.reasoning));
}

function sourceLabel(source: ModelProviderConfiguration["source"]): string {
  return source === "custom" ? "自定义" : source === "override" ? "内置覆盖" : "内置";
}

function customCredentialConfiguration(): ModelProviderCredentialConfiguration {
  return {
    name: "API 密钥",
    selectedMethod: "api-key",
    methods: [{
      id: "api-key",
      label: "API 密钥",
      fields: [{
        id: "key",
        label: "API 密钥",
        input: "secret",
        required: false,
        placeholder: "粘贴 API 密钥（没有密钥要求时可留空）",
        configured: false,
      }],
    }],
  };
}

function methodFields(
  configuration: ModelProviderCredentialConfiguration,
  method: string,
): ModelProviderCredentialField[] {
  return configuration.methods.find((item) => item.id === method)?.fields ?? [];
}

function NumberInput({ value, onChange, placeholder, className }: { value?: number; onChange: (value: number | undefined) => void; placeholder?: string; className?: string }): React.JSX.Element {
  return <TextField className={className} type="number" min="0" value={value ?? ""} placeholder={placeholder} onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))} />;
}

function ProviderCredentialEditor({
  configuration,
  method,
  values,
  configured,
  oauthConfigured,
  oauthBusy,
  onMethodChange,
  onValueChange,
  onOAuthLogin,
  onOAuthLogout,
}: {
  configuration: ModelProviderCredentialConfiguration;
  method: string;
  values: Record<string, string>;
  configured: boolean;
  oauthConfigured: boolean;
  oauthBusy: boolean;
  onMethodChange: (method: string) => void;
  onValueChange: (field: string, value: string) => void;
  onOAuthLogin: () => void;
  onOAuthLogout: () => void;
}): React.JSX.Element {
  const active = configuration.methods.find((item) => item.id === method) ?? configuration.methods[0];
  const authConfigured = configured || oauthConfigured;
  const simpleKeyOnly = configuration.methods.length === 1
    && (active?.fields.length ?? 0) === 1
    && active?.fields[0]?.input === "secret"
    && !configuration.oauth;
  if (simpleKeyOnly && active) {
    const field = active.fields[0]!;
    return (
      <Field className="provider-credential-compact">
        <span>
          {field.label || "API 密钥"}
          <em className={configured ? "configured" : ""}>{configured ? "已配置" : field.required ? "必填" : "可选"}</em>
        </span>
        <span className="secret-input">
          <KeyRound size={13} />
          <TextField
            className="secret-input-field"
            type="password"
            value={values[field.id] ?? ""}
            autoComplete="off"
            placeholder={field.configured ? "已配置；留空即可保留" : field.placeholder}
            onChange={(event) => onValueChange(field.id, event.target.value)}
          />
        </span>
      </Field>
    );
  }
  return (
    <section className="provider-credential-editor">
      <header>
        <strong>连接与认证</strong>
        <span className={authConfigured ? "configured" : ""}>{oauthConfigured ? "订阅已登录" : configured ? "API 凭据已配置" : "未配置"}</span>
      </header>
      {configuration.oauth ? <div className={`provider-oauth-action ${oauthConfigured ? "configured" : ""}`}>
        <div>
          <strong>{configuration.oauth.label}</strong>
          <span>{oauthConfigured ? "当前使用订阅凭据" : "由 CoilCoil 打开浏览器并保存授权凭据"}</span>
        </div>
        {oauthConfigured
          ? <button type="button" disabled={oauthBusy} onClick={onOAuthLogout}><LogOut size={13} />退出登录</button>
          : <button className="primary" type="button" disabled={oauthBusy} onClick={onOAuthLogin}>{oauthBusy ? <LoaderCircle className="spin" size={13} /> : <LogIn size={13} />}订阅登录</button>}
      </div> : null}
      {configuration.methods.length > 1 ? <Field>API 凭据方式<Select value={active?.id ?? ""} options={configuration.methods.map((item) => ({ value: item.id, label: item.label, detail: item.description }))} ariaLabel="服务商 API 凭据方式" onChange={onMethodChange} /></Field> : null}
      {active ? <>
        {active.description && configuration.methods.length > 1 ? <p className="provider-credential-description">{active.description}</p> : null}
        {active.fields.length ? <div className="provider-credential-fields">{active.fields.map((field) => <Field className={field.input === "textarea" ? "wide" : ""} key={field.id}>
          <span>{field.label}<em className={field.required ? "required" : ""}>{field.required ? "必填" : "可选"}</em></span>
          {field.input === "textarea" ? <TextArea value={values[field.id] ?? ""} placeholder={field.placeholder} onChange={(event) => onValueChange(field.id, event.target.value)} /> : field.input === "secret" ? <span className="secret-input"><KeyRound size={13} /><TextField className="secret-input-field" type="password" value={values[field.id] ?? ""} autoComplete="off" placeholder={field.configured ? "已配置；留空即可保留" : field.placeholder} onChange={(event) => onValueChange(field.id, event.target.value)} /></span> : <TextField value={values[field.id] ?? ""} placeholder={field.placeholder} onChange={(event) => onValueChange(field.id, event.target.value)} />}
          {field.description ? <small>{field.description}</small> : null}
        </Field>)}</div> : <p className="provider-credential-description">此方式使用应用运行环境中已经存在的凭据，不需要在这里填写密钥。</p>}
      </> : configuration.oauth ? null : <div className="provider-oauth-only"><strong>运行环境凭据</strong><p>此服务商使用应用运行环境中已经存在的认证信息。</p></div>}
      {configuration.oauth && configuration.methods.length ? <div className="provider-oauth-note">订阅登录与 API 凭据是两种独立方式；由于 Pi 每个服务商只保存一份当前凭据，完成其中一种登录会替换另一种。</div> : null}
    </section>
  );
}

/** Exported for scripts/ui-preview: the折叠列表只有画出来才看得出对不对。 */
export function ProviderModelCard({
  model,
  index,
  apiOptions: options,
  advanced,
  onChange,
  onAdvancedChange,
  onRemove,
  expanded,
  onToggle,
}: {
  model: EditableModel;
  index: number;
  apiOptions: SelectOption[];
  advanced: ModelAdvancedText;
  onChange: (next: EditableModel) => void;
  onAdvancedChange: (next: ModelAdvancedText) => void;
  onRemove: () => void;
  expanded: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const updateCost = (key: keyof NonNullable<EditableModel["cost"]>, value: number | undefined): void => {
    const current = model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    onChange({ ...model, cost: { ...current, [key]: value ?? 0 } });
  };
  const supportsImages = model.input?.includes("image") ?? false;
  const toggleImage = (): void => onChange({ ...model, input: supportsImages ? ["text"] : ["text", "image"] });
  // The checkbox row and the advanced JSON edit the same field; the JSON text is
  // the single source of truth so the two can never disagree.
  const mappedLevels = (() => {
    try {
      const parsed = JSON.parse(advanced.thinkingLevelMap.trim() || "{}") as Partial<Record<string, string | null>>;
      return thinkingLevelsFromMap(parsed, Boolean(model.reasoning));
    } catch {
      return undefined;
    }
  })();
  const toggleThinkingLevel = (level: ThinkingLevel): void => {
    if (!mappedLevels) return;
    const next = mappedLevels.includes(level)
      ? mappedLevels.filter((item) => item !== level)
      : [...mappedLevels, level];
    // Pi needs at least one level to clamp to; an empty set would leave the
    // model with nothing to send.
    onAdvancedChange({
      ...advanced,
      thinkingLevelMap: JSON.stringify(thinkingLevelMapFromLevels(next.length ? next : ["off"]), null, 2),
    });
  };
  /* 一个服务商挂几十个模型是常事，全部摊开就没法找了。折叠态一行一个，只报能
     认出它是谁的那几项（名字、上下文、识图）；要改参数再点开。 */
  const contextLabel = model.contextWindow ? `${Math.round(model.contextWindow / 1000)}K 上下文` : "未设上下文";
  return (
    <article className={`provider-model-card ${expanded ? "expanded" : ""}`}>
      <header>
        <button className="provider-model-summary" type="button" aria-expanded={expanded} onClick={onToggle}>
          <ChevronRight className="provider-model-caret" size={14} />
          <CircleDot size={14} />
          <strong>{model.name || model.id || `模型 ${index + 1}`}</strong>
          <small>{model.id || "未填模型 ID"}</small>
          <span className="provider-model-badges">
            <em>{contextLabel}</em>
            {supportsImages ? <em>识图</em> : null}
            {model.reasoning ? <em>推理</em> : null}
          </span>
        </button>
        <button type="button" aria-label={`移除模型 ${index + 1}`} onClick={onRemove}><Trash2 size={14} />移除</button>
      </header>
      {!expanded ? null : <>
      <div className="settings-grid provider-model-identity"><Field>模型 ID<TextField value={model.id} placeholder="例如 dog-coder-v1" onChange={(event) => onChange({ ...model, id: event.target.value })} /></Field><Field>显示名称<TextField value={model.name ?? ""} placeholder="可选，默认使用模型 ID" onChange={(event) => onChange({ ...model, name: event.target.value })} /></Field></div>
      <div className="settings-grid"><Field>协议覆盖<Select value={model.api ?? ""} options={options} ariaLabel={`模型 ${index + 1} 的协议`} onChange={(api) => onChange({ ...model, api: api || undefined })} searchable /></Field><Field>模型专用 Base URL<TextField value={model.baseUrl ?? ""} placeholder="可选，默认继承服务商 Base URL" onChange={(event) => onChange({ ...model, baseUrl: event.target.value })} /></Field></div>
      <div className="settings-grid provider-model-capabilities"><Field>上下文窗口<NumberInput value={model.contextWindow} placeholder="128000" onChange={(contextWindow) => onChange({ ...model, contextWindow })} /></Field><Field>最大输出 Token<NumberInput value={model.maxTokens} placeholder="16384" onChange={(maxTokens) => onChange({ ...model, maxTokens })} /></Field></div>
      <div className="provider-checkbox-row"><Field className="checkbox-setting"><Checkbox tone="system" checked={Boolean(model.reasoning)} onChange={(event) => onChange({ ...model, reasoning: event.target.checked })} />支持 Thinking / 推理</Field><Field className="checkbox-setting"><Checkbox tone="system" checked={supportsImages} onChange={toggleImage} />支持图片输入</Field></div>
      {model.reasoning ? <div className="provider-thinking-levels">
        <span>可用 Thinking 强度<small>只有勾选的强度会出现在模型选择器里，也只有它们会被发送给服务商</small></span>
        {mappedLevels ? <div className="provider-thinking-options">
          {THINKING_LEVELS.map((level) => <button
            className={mappedLevels.includes(level) ? "active" : ""}
            type="button"
            key={level}
            aria-pressed={mappedLevels.includes(level)}
            onClick={() => toggleThinkingLevel(level)}
          >{level}</button>)}
        </div> : <small className="provider-thinking-invalid">Thinking 映射 JSON 当前无法解析，请在下方高级参数中修正。</small>}
      </div> : null}
      <details className="provider-advanced">
        <summary>高级模型参数 <ChevronRight size={14} /></summary>
        <p>这些字段直接写入 <code>models.json</code> 模型定义；适合网关兼容性、采样和精确的 Thinking 映射。</p>
        <div className="provider-cost-grid"><Field>输入成本 / M Token<NumberInput className="provider-cost-input" value={model.cost?.input} onChange={(value) => updateCost("input", value)} /></Field><Field>输出成本 / M Token<NumberInput className="provider-cost-input" value={model.cost?.output} onChange={(value) => updateCost("output", value)} /></Field><Field>缓存读取 / M Token<NumberInput className="provider-cost-input" value={model.cost?.cacheRead} onChange={(value) => updateCost("cacheRead", value)} /></Field><Field>缓存写入 / M Token<NumberInput className="provider-cost-input" value={model.cost?.cacheWrite} onChange={(value) => updateCost("cacheWrite", value)} /></Field></div>
        <div className="settings-grid"><Field>Thinking 映射 JSON<TextArea value={advanced.thinkingLevelMap} placeholder={'{ "high": "high", "max": null }'} onChange={(event) => onAdvancedChange({ ...advanced, thinkingLevelMap: event.target.value })} /></Field><Field>采样参数 JSON<TextArea value={advanced.samplingParams} placeholder={'{ "temperature": 0.7, "top_p": 0.95 }'} onChange={(event) => onAdvancedChange({ ...advanced, samplingParams: event.target.value })} /></Field></div>
        <Field>成本阶梯 JSON<TextArea value={advanced.costTiers} placeholder={'[{ "inputTokensAbove": 272000, "input": 10, "output": 45, "cacheRead": 1, "cacheWrite": 12.5 }]'} onChange={(event) => onAdvancedChange({ ...advanced, costTiers: event.target.value })} /></Field>
        <div className="settings-grid"><Field>请求头 JSON<TextArea value={advanced.headers} placeholder={'{ "X-Gateway": "value" }'} onChange={(event) => onAdvancedChange({ ...advanced, headers: event.target.value })} /></Field><Field>兼容性 JSON<TextArea value={advanced.compat} placeholder={'{ "supportsDeveloperRole": false }'} onChange={(event) => onAdvancedChange({ ...advanced, compat: event.target.value })} /></Field></div>
      </details>
      </>}
    </article>
  );
}

function OpenAIResponsesWsEditor({ runtimeId, onSaved, onReload }: {
  runtimeId?: string;
  onSaved: (configuration: RuntimeConfiguration) => void;
  onReload: (configuration: RuntimeConfiguration) => Promise<void>;
}): React.JSX.Element {
  const [configuration, setConfiguration] = useState<OpenAIResponsesWsConfiguration>();
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:8317");
  const [apiKey, setApiKey] = useState("");
  const [fast, setFast] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void window.coilcoil.request<OpenAIResponsesWsConfiguration>({ type: "get_openai_responses_ws_configuration" }, runtimeId)
      .then((next) => {
        setConfiguration(next);
        setBaseUrl(next.baseUrl);
        setFast(next.fast);
      })
      .catch((caught) => toastError(caught instanceof Error ? caught.message : String(caught)));
  }, [runtimeId]);

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const next = await window.coilcoil.request<RuntimeConfiguration>({
        type: "save_openai_responses_ws_configuration",
        input: {
          baseUrl,
          apiKey: apiKey.trim() || undefined,
          preserveApiKey: Boolean(configuration?.apiKeyConfigured),
          fast,
        },
      }, runtimeId);
      const stored = await window.coilcoil.request<OpenAIResponsesWsConfiguration>({ type: "get_openai_responses_ws_configuration" }, runtimeId);
      setConfiguration(stored);
      setApiKey("");
      onSaved(next);
      await onReload(next);
      toastSuccess("OpenAI Response (WS) 已连接；模型目录已刷新。");
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  return <form className="ui-form openai-responses-ws-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <header className="provider-editor-heading">
      <div><span className="provider-source-tag">CoilCoil 自有 Pi 扩展</span><strong>OpenAI Response (WS)</strong><small>面向兼容 OpenAI Codex Responses WebSocket 的服务；支持普通代理 API Key，不要求 ChatGPT accountId，并保持持久 WebSocket。</small></div>
      <button className="primary-button" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}保存并连接</button>
    </header>
    <div className="provider-native-summary"><strong>由 CoilCoil 扩展独立注册</strong><p>内部标识为 <code>openai-responses-ws</code>，不会覆盖已有服务商或 Pi 内置的 <code>openai-codex-responses</code>。模型目录从服务端的 <code>/v1/models?client_version=pi</code> 自动读取。</p></div>
    <div className="settings-grid">
      <Field>服务地址（Base URL）<TextField value={baseUrl} placeholder="http://127.0.0.1:8317" onChange={(event) => setBaseUrl(event.target.value)} /></Field>
      <Field>API Key<span className="secret-input"><KeyRound size={13} /><TextField className="secret-input-field" type="password" value={apiKey} autoComplete="off" placeholder={configuration?.apiKeyConfigured ? "已配置；留空即可保留" : "粘贴 API Key"} onChange={(event) => setApiKey(event.target.value)} /></span></Field>
    </div>
    <Field className="checkbox-setting"><Checkbox tone="system" checked={fast} onChange={(event) => setFast(event.target.checked)} />启用 Fast / priority mode（仅支持该能力的模型生效）</Field>
    <footer className="ui-form-footer"><span>{configuration?.configPath}</span><span className="provider-runtime-note">配置仅保存于 CoilCoil 私有运行时。</span></footer>
  </form>;
}

export function ModelSettings({ configuration, onSaved, runtimeId }: {
  configuration?: RuntimeConfiguration;
  onSaved: (configuration: RuntimeConfiguration) => void;
  runtimeId?: string;
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ModelProviderConfigurationSnapshot>();
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedSource, setSelectedSource] = useState<ModelProviderConfiguration["source"]>("built-in");
  const [draft, setDraft] = useState<ProviderDraft>();
  const [providerHeadersText, setProviderHeadersText] = useState("{}");
  const [providerCompatText, setProviderCompatText] = useState("{}");
  const [overridesText, setOverridesText] = useState("{}");
  const [modelAdvanced, setModelAdvanced] = useState<Record<string, ModelAdvancedText>>({});
  const [credentialConfiguration, setCredentialConfiguration] = useState<ModelProviderCredentialConfiguration>(customCredentialConfiguration());
  const [credentialMethod, setCredentialMethod] = useState("api-key");
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>({});
  const [credentialPreserveFields, setCredentialPreserveFields] = useState<string[]>([]);
  const [credentialDirty, setCredentialDirty] = useState(false);
  const [preserveApiKeyReference, setPreserveApiKeyReference] = useState(false);
  const [testModelId, setTestModelId] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("medium");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  /* 折叠是默认态，展开的记在这里。按 uid 记而不是按序号：过滤之后序号会变。 */
  const [expandedModels, setExpandedModels] = useState<Set<string>>(new Set());
  const [testing, setTesting] = useState(false);
  const [removeArmed, setRemoveArmed] = useState(false);
  const [upstreamPickerModels, setUpstreamPickerModels] = useState<UpstreamModelOption[]>();
  const [oauthFlow, setOAuthFlow] = useState<ModelProviderAuthState>();
  const [savedFingerprint, setSavedFingerprint] = useState<string>();

  const selectedProvider = snapshot?.providers.find((provider) => provider.id === selectedId);
  const oauthBusy = Boolean(oauthFlow && oauthFlow.provider === (selectedId ?? draft?.id)
    && oauthFlow.status !== "succeeded"
    && oauthFlow.status !== "failed"
    && oauthFlow.status !== "cancelled");
  const canRemove = Boolean(selectedId && (selectedSource !== "built-in" || selectedProvider?.apiKeyConfigured));
  const removeLabel = selectedSource === "built-in" || draft?.id === SPARK_PROVIDER_ID ? "清除配置" : "移除";
  const currentFingerprint = useMemo(() => draft ? providerFormFingerprint({
    draft,
    providerHeadersText,
    providerCompatText,
    overridesText,
    modelAdvanced,
    credentialMethod,
    credentialValues,
    credentialPreserveFields,
    credentialDirty,
    preserveApiKeyReference,
  }) : undefined, [credentialDirty, credentialMethod, credentialPreserveFields, credentialValues, draft, modelAdvanced, overridesText, preserveApiKeyReference, providerCompatText, providerHeadersText]);
  const hasUnsavedChanges = Boolean(currentFingerprint && currentFingerprint !== savedFingerprint);

  const applyProvider = (provider: ModelProviderConfiguration, nextConfiguration = configuration, sparkSynced?: boolean): void => {
    const nextDraft = draftFromProvider(provider);
    // Spark AI is stored as a custom provider (which always carries its models), but to the user it is
    // a built-in one: "保留内置" means its catalog follows the gateway.
    if (sparkSynced !== undefined) nextDraft.replaceModels = !sparkSynced;
    const nextHeadersText = jsonText(provider.headers);
    const nextCompatText = jsonText(provider.compat);
    const nextOverridesText = jsonText(provider.modelOverrides);
    const nextModelAdvanced = initialAdvancedText(nextDraft.models);
    setSelectedId(provider.id);
    setSelectedSource(provider.source);
    setDraft(nextDraft);
    setProviderHeadersText(nextHeadersText);
    setProviderCompatText(nextCompatText);
    setOverridesText(nextOverridesText);
    setModelAdvanced(nextModelAdvanced);
    setCredentialConfiguration(provider.credential);
    const nextMethod = provider.credential.selectedMethod ?? provider.credential.methods[0]?.id ?? "";
    const fields = methodFields(provider.credential, nextMethod);
    const nextCredentialValues = Object.fromEntries(fields.flatMap((field) => field.value === undefined ? [] : [[field.id, field.value]]));
    const nextCredentialPreserveFields = fields.filter((field) => field.input === "secret" && field.configured).map((field) => field.id);
    const nextPreserveApiKeyReference = provider.hasPrivateApiKeyReference || Boolean(provider.apiKeyReference);
    setCredentialMethod(nextMethod);
    setCredentialValues(nextCredentialValues);
    setCredentialPreserveFields(nextCredentialPreserveFields);
    setCredentialDirty(false);
    setPreserveApiKeyReference(nextPreserveApiKeyReference);
    const available = nextConfiguration?.models.filter((model) => model.provider === provider.id) ?? [];
    const current = nextConfiguration?.provider === provider.id ? nextConfiguration.modelId : undefined;
    const nextTestModelId = current && available.some((model) => model.id === current) ? current : nextDraft.models[0]?.id ?? available[0]?.id ?? "";
    const nextThinkingLevel = nextConfiguration?.provider === provider.id ? nextConfiguration.thinkingLevel : "medium";
    setTestModelId(nextTestModelId);
    setThinkingLevel(nextThinkingLevel);
    setRemoveArmed(false);
    setSavedFingerprint(providerFormFingerprint({
      draft: nextDraft,
      providerHeadersText: nextHeadersText,
      providerCompatText: nextCompatText,
      overridesText: nextOverridesText,
      modelAdvanced: nextModelAdvanced,
      credentialMethod: nextMethod,
      credentialValues: nextCredentialValues,
      credentialPreserveFields: nextCredentialPreserveFields,
      credentialDirty: false,
      preserveApiKeyReference: nextPreserveApiKeyReference,
    }));
  };

  const load = async (preferredId?: string, nextConfiguration = configuration): Promise<void> => {
    setLoading(true);
    try {
      const next = await window.coilcoil.request<ModelProviderConfigurationSnapshot>({ type: "get_model_provider_configuration" }, runtimeId);
      setSnapshot(next);
      const selected = next.providers.find((provider) => provider.id === preferredId)
        ?? next.providers.find((provider) => provider.id === SPARK_PROVIDER_ID)
        ?? sparkPlaceholder();
      await applyPrepared(selected, nextConfiguration);
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [runtimeId]);

  /** Spark AI before anything is saved: fixed address and protocol, one placeholder model. */
  const sparkPlaceholder = (): ModelProviderConfiguration => ({
    id: SPARK_PROVIDER_ID,
    name: SPARK_PROVIDER_NAME,
    baseUrl: sparkBaseUrl(),
    api: SPARK_API,
    headers: {},
    compat: {},
    authHeader: false,
    hasPrivateApiKeyReference: false,
    apiKeyConfigured: false,
    disabled: false,
    credential: customCredentialConfiguration(),
    replaceModels: true,
    models: SPARK_DEFAULT_MODELS,
    source: "custom",
  });

  /** Ask the gateway for its model list, with capabilities filled in from the local catalog. */
  const fetchSparkCatalog = async (): Promise<EditableModel[]> => {
    await loadModelCatalog();
    const result = await window.coilcoil.request<FetchProviderModelsResult>({
      type: "fetch_provider_models",
      input: { baseUrl: sparkBaseUrl(), api: SPARK_API, apiKey: draftApiKey(), provider: SPARK_PROVIDER_ID },
    }, runtimeId);
    if (!result.models.length) throw new Error("云端没有返回可用模型。");
    return result.models.map((model) => toEditableModel(sparkModelFromUpstream(model)));
  };

  /** Show a provider; for Spark AI first work out whether its saved catalog is still the gateway's own. */
  const applyPrepared = async (provider: ModelProviderConfiguration, nextConfiguration = configuration): Promise<void> => {
    if (provider.id !== SPARK_PROVIDER_ID) { applyProvider(provider, nextConfiguration); return; }
    let synced = !provider.apiKeyConfigured;
    if (provider.apiKeyConfigured) {
      try {
        await loadModelCatalog();
        const result = await window.coilcoil.request<FetchProviderModelsResult>({
          type: "fetch_provider_models",
          input: { baseUrl: sparkBaseUrl(), api: SPARK_API, provider: SPARK_PROVIDER_ID },
        }, runtimeId);
        synced = sparkCatalogIsSynced(provider.models, result.models.map(sparkModelFromUpstream));
      } catch { /* offline: show what is saved, editable */ }
    }
    applyProvider(provider, nextConfiguration, synced);
  };

  useEffect(() => window.coilcoil.onRuntimeEvent((event, eventRuntimeId) => {
    if (event.type !== "model_provider_auth_updated") return;
    if (eventRuntimeId && runtimeId && eventRuntimeId !== runtimeId) return;
    setOAuthFlow(event.state.status === "cancelled" ? undefined : event.state);
    if (event.state.status === "succeeded") {
      toastSuccess(`${event.state.providerName} 订阅登录成功。`);
      void load(event.state.provider);
    }
  }), [runtimeId]);

  const providerOptions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (snapshot?.providers ?? []).filter((provider) => !normalized || `${provider.id} ${provider.name}`.toLowerCase().includes(normalized));
  }, [query, snapshot]);
  const sparkProvider = snapshot?.providers.find((provider) => provider.id === SPARK_PROVIDER_ID);
  const customProviders = providerOptions.filter((provider) => provider.source === "custom" && provider.id !== SPARK_PROVIDER_ID);
  const overrideProviders = providerOptions.filter((provider) => provider.source === "override");
  const builtinProviders = providerOptions.filter((provider) => provider.source === "built-in");
  const protocolOptions = apiOptions(snapshot);
  const defaultModels = useMemo(() => {
    if (!draft) return [] as EditableModel[];
    if (draft.replaceModels) return draft.models;
    const runtime = configuration?.models.filter((model) => model.provider === draft.id) ?? [];
    return runtime.map((model): EditableModel => ({ uid: `runtime-${model.id}`, id: model.id, name: model.name, reasoning: model.reasoning, input: model.supportsImages ? ["text", "image"] : ["text"], contextWindow: model.contextWindow }));
  }, [configuration, draft]);
  const activeTestModel = defaultModels.find((model) => model.id === testModelId) ?? defaultModels[0];
  const thinkingOptions = activeTestModel ? modelThinkingLevels(activeTestModel, configuration, draft?.id ?? "").map((level) => THINKING_OPTIONS.find((option) => option.value === level)!).filter(Boolean) : THINKING_OPTIONS.filter((option) => option.value === "off");
  const isSpark = draft?.id === SPARK_PROVIDER_ID;
  // Spark AI is a custom provider underneath, but its page is a built-in one: key, then the model catalog.
  const isBuiltinProvider = selectedSource !== "custom" || isSpark;
  /* 搜索只挑要画哪几张卡，不动 draft.models 本身——过滤是看的事，删和改都还认
     uid。序号跟着原始位置走，这样「模型 3」在搜与不搜时说的是同一个。 */
  const visibleModels = useMemo(() => {
    const rows = (draft?.models ?? []).map((model, index) => ({ model, index }));
    const query = modelQuery.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter(({ model }) => `${model.id} ${model.name ?? ""}`.toLowerCase().includes(query));
  }, [draft?.models, modelQuery]);

  const selectProvider = (provider: ModelProviderConfiguration): void => { void applyPrepared(provider); };
  const addProvider = (): void => {
    const ids = new Set(snapshot?.providers.map((provider) => provider.id) ?? []);
    let index = 1;
    while (ids.has(index === 1 ? "custom-provider" : `custom-provider-${index}`)) index += 1;
    const next = blankProvider(index);
    setSelectedId(undefined);
    setSelectedSource("custom");
    setDraft(next);
    setProviderHeadersText("{}");
    setProviderCompatText("{}");
    setOverridesText("{}");
    setModelAdvanced(initialAdvancedText(next.models));
    const credential = customCredentialConfiguration();
    setCredentialConfiguration(credential);
    setCredentialMethod(credential.selectedMethod ?? "api-key");
    setCredentialValues({});
    setCredentialPreserveFields([]);
    setCredentialDirty(false);
    setPreserveApiKeyReference(false);
    setTestModelId(next.models[0]?.id ?? "");
    setThinkingLevel("medium");
    setRemoveArmed(false);
    setSavedFingerprint(undefined);
  };

  const updateModel = (uidValue: string, next: EditableModel): void => setDraft((current) => current ? {
    ...current,
    models: current.models.map((model) => model.uid === uidValue ? next : model),
  } : current);

  const updateCredentialMethod = (method: string): void => {
    const fields = methodFields(credentialConfiguration, method);
    setCredentialMethod(method);
    setCredentialValues(Object.fromEntries(fields.flatMap((field) => field.value === undefined ? [] : [[field.id, field.value]])));
    setCredentialPreserveFields(fields.filter((field) => field.input === "secret" && field.configured).map((field) => field.id));
    setCredentialDirty(true);
  };

  const updateCredentialValue = (field: string, value: string): void => {
    setCredentialValues((current) => ({ ...current, [field]: value }));
    setCredentialDirty(true);
  };

  const buildInput = (catalog?: EditableModel[]): ModelProviderConfigurationInput => {
    if (!draft) throw new Error("服务商配置仍在加载。");
    const models = (catalog ?? draft.models).map((model) => {
      const advanced = modelAdvanced[model.uid] ?? { thinkingLevelMap: "{}", samplingParams: "{}", headers: "{}", compat: "{}", costTiers: "[]" };
      const { uid: _uid, ...item } = model;
      return {
        ...item,
        thinkingLevelMap: parseJsonObject(advanced.thinkingLevelMap, `模型 ${model.id || "（未命名）"} 的 Thinking 映射`) as ModelProviderModelConfiguration["thinkingLevelMap"],
        samplingParams: parseJsonObject(advanced.samplingParams, `模型 ${model.id || "（未命名）"} 的采样参数`),
        headers: parseStringMap(advanced.headers, `模型 ${model.id || "（未命名）"} 的请求头`),
        compat: parseJsonObject(advanced.compat, `模型 ${model.id || "（未命名）"} 的兼容性参数`),
        cost: item.cost ? { ...item.cost, tiers: parseCostTiers(advanced.costTiers, `模型 ${model.id || "（未命名）"} 的成本阶梯`) } : undefined,
      };
    });
    return {
      provider: {
        ...draft,
        id: draft.id.trim(),
        name: draft.name?.trim() || undefined,
        baseUrl: draft.baseUrl?.trim() || undefined,
        api: draft.api?.trim() || undefined,
        ...(isSpark ? { name: SPARK_PROVIDER_NAME, baseUrl: sparkBaseUrl(), api: SPARK_API, replaceModels: true } : {}),
        headers: parseStringMap(providerHeadersText, "服务商请求头"),
        compat: parseJsonObject(providerCompatText, "服务商兼容性参数"),
        modelOverrides: parseJsonObject(overridesText, "模型覆盖 JSON") as ProviderDraft["modelOverrides"],
        models,
      },
      credential: credentialDirty && credentialMethod ? {
        method: credentialMethod,
        values: credentialValues,
        preserveFields: credentialPreserveFields,
      } : undefined,
      preserveApiKeyReference,
    };
  };

  const save = async (): Promise<ModelProviderSaveResult | undefined> => {
    setSaving(true);
    try {
      // "保留内置" for Spark AI: take the gateway's current list as the catalog.
      const catalog = isSpark && !draft?.replaceModels ? await fetchSparkCatalog() : undefined;
      const result = await window.coilcoil.request<ModelProviderSaveResult>({ type: "save_model_provider_configuration", input: buildInput(catalog) }, runtimeId);
      onSaved(result.configuration);
      await load(result.provider.id, result.configuration);
      toastSuccess(isBuiltinProvider ? "已保存设置。" : "已保存服务商。");
      return result;
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
      return undefined;
    } finally {
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!selectedId || !canRemove) return;
    setSaving(true);
    try {
      const next = selectedSource === "built-in"
        ? await window.coilcoil.request<RuntimeConfiguration>({ type: "remove_provider_auth", provider: selectedId }, runtimeId)
        : await window.coilcoil.request<RuntimeConfiguration>({ type: "remove_model_provider_configuration", provider: selectedId }, runtimeId);
      onSaved(next);
      await load(undefined, next);
      toastSuccess(selectedSource === "built-in" ? "已清除该服务商的凭据。" : "已移除该服务商配置。");
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
      setRemoveArmed(false);
    }
  };

  const startOAuthLogin = async (): Promise<void> => {
    const provider = selectedId ?? draft?.id;
    if (!provider || !credentialConfiguration.oauth) return;
    try {
      const state = await window.coilcoil.request<ModelProviderAuthState>({ type: "start_model_provider_oauth", provider }, runtimeId);
      setOAuthFlow((current) => current?.flowId === state.flowId ? current : state);
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const respondOAuthLogin = async (promptId: string, value: string): Promise<void> => {
    if (!oauthFlow) return;
    try {
      await window.coilcoil.request({ type: "respond_model_provider_oauth", flowId: oauthFlow.flowId, promptId, value }, runtimeId);
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    }
  };

  const closeOAuthLogin = (): void => {
    const flow = oauthFlow;
    setOAuthFlow(undefined);
    if (!flow || flow.status === "succeeded" || flow.status === "failed" || flow.status === "cancelled") return;
    void window.coilcoil.request({ type: "cancel_model_provider_oauth", flowId: flow.flowId }, runtimeId).catch((caught) => {
      toastError(caught instanceof Error ? caught.message : String(caught));
    });
  };

  const logoutOAuth = async (): Promise<void> => {
    const provider = selectedId ?? draft?.id;
    if (!provider) return;
    setSaving(true);
    try {
      const next = await window.coilcoil.request<RuntimeConfiguration>({ type: "remove_provider_auth", provider }, runtimeId);
      onSaved(next);
      await load(provider, next);
      toastSuccess("已退出订阅登录。");
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const draftApiKey = (): string | undefined => {
    const key = credentialValues.key?.trim();
    return key || undefined;
  };

  const fetchUpstreamModels = async (): Promise<void> => {
    if (!draft?.baseUrl?.trim()) {
      toastError("请先填写 Base URL，再拉取上游模型。");
      return;
    }
    setFetchingModels(true);
    try {
      void loadModelCatalog();
      const headers = parseStringMap(providerHeadersText, "服务商请求头");
      const result = await window.coilcoil.request<FetchProviderModelsResult>({
        type: "fetch_provider_models",
        input: {
          baseUrl: draft.baseUrl,
          api: draft.api,
          apiKey: draftApiKey(),
          headers,
          provider: selectedId,
        },
      }, runtimeId);
      if (!result.models.length) {
        toastError("上游未返回可用模型。");
        return;
      }
      setUpstreamPickerModels(result.models);
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setFetchingModels(false);
    }
  };

  const applyUpstreamSelection = (selected: Array<UpstreamModelOption & { meta: ModelCatalogMeta }>): void => {
    if (!draft) return;
    const metaById = new Map(selected.map((item) => [item.id, item]));
    const { next: compact, added } = mergeSelectedUpstreamModels(
      draft.models,
      selected.map((item) => item.id),
      (id) => {
        const item = metaById.get(id)!;
        return modelFromUpstream(item, item.meta);
      },
    );
    setDraft((current) => current ? { ...current, replaceModels: true, models: compact.length ? compact : [blankModel()] } : current);
    setModelAdvanced((current) => ({ ...current, ...initialAdvancedText(added.filter((model) => !current[model.uid])) }));
    if (!testModelId || !compact.some((model) => model.id === testModelId)) {
      setTestModelId(compact.find((model) => model.id.trim())?.id ?? "");
    }
    setUpstreamPickerModels(undefined);
    toastSuccess(added.length ? `已添加 ${added.length} 个上游模型。` : "所选模型均已在本地目录中。");
  };

  const testConnection = async (): Promise<void> => {
    if (!draft?.baseUrl?.trim() || !draft.api?.trim()) {
      toastError("测试需要 Base URL 和请求协议。");
      return;
    }
    const modelId = testModelId.trim() || draft.models.find((model) => model.id.trim())?.id.trim() || "";
    if (!modelId) {
      toastError("请先选择要测试的模型。");
      return;
    }
    setTesting(true);
    try {
      const headers = parseStringMap(providerHeadersText, "服务商请求头");
      const result = await window.coilcoil.request<TestProviderConnectionResult>({
        type: "test_provider_connection",
        input: {
          baseUrl: draft.baseUrl,
          api: draft.api,
          apiKey: draftApiKey(),
          headers,
          modelId,
          provider: selectedId,
        },
      }, runtimeId);
      const summary = result.detail ? `${result.message}：${result.detail}` : result.message;
      if (result.ok) toastSuccess(`模型 ${modelId}：${summary}`);
      else toastError(`模型 ${modelId} 测试失败 — ${summary}`);
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="model-provider-settings">
      {oauthFlow ? <ProviderOAuthDialog key={oauthFlow.flowId} state={oauthFlow} onRespond={respondOAuthLogin} onClose={closeOAuthLogin} /> : null}
      {upstreamPickerModels && draft ? <UpstreamModelPicker
        models={upstreamPickerModels}
        configuredIds={new Set(draft.models.map((model) => model.id).filter(Boolean))}
        onCancel={() => setUpstreamPickerModels(undefined)}
        onConfirm={applyUpstreamSelection}
      /> : null}
      <aside className="provider-catalog">
        <div className="provider-catalog-toolbar"><strong>服务商</strong><button type="button" aria-label="添加自定义服务商" onClick={addProvider}><Plus size={14} />添加</button></div>
        <div className="provider-catalog-search"><Search size={14} /><TextField className="provider-catalog-search-input" value={query} placeholder="搜索服务商" onChange={(event) => setQuery(event.target.value)} /></div>
        {loading ? <p className="settings-loading"><LoaderCircle className="spin" size={15} />加载服务商目录…</p> : null}
        <section className="provider-catalog-group">
          <button className={selectedId === SPARK_PROVIDER_ID || (!selectedId && draft?.id === SPARK_PROVIDER_ID) ? "active" : ""} type="button" onClick={() => selectProvider(sparkProvider ?? sparkPlaceholder())}>
            <span><strong>{SPARK_PROVIDER_NAME}</strong><small>{SPARK_PROVIDER_ID}</small></span>
            <em className={hasUnsavedChanges && isSpark ? "unsaved" : sparkProvider?.apiKeyConfigured ? "configured" : ""}>{hasUnsavedChanges && isSpark ? "未保存" : sparkProvider?.apiKeyConfigured ? "已配置" : "内置"}</em>
          </button>
        </section>
        {([
          ["自定义服务商", customProviders],
          ["内置覆盖", overrideProviders],
          ["内置服务商", builtinProviders],
        ] as const).map(([title, providers]) => providers.length ? <section className="provider-catalog-group" key={title}>
          <h2>{title}</h2>
          {providers.map((provider) => {
            const selected = selectedId === provider.id || (!selectedId && draft?.id === provider.id);
            return <button className={selected ? "active" : ""} type="button" key={provider.id} onClick={() => selectProvider(provider)}>
              <span><strong>{provider.name ?? provider.id}</strong><small>{provider.id}</small></span>
              <em className={selected && hasUnsavedChanges ? "unsaved" : provider.disabled ? "disabled" : provider.apiKeyConfigured ? "configured" : ""}>{selected && hasUnsavedChanges ? "未保存" : provider.disabled ? "已禁用" : provider.authType === "oauth" ? "订阅已登录" : provider.apiKeyConfigured ? "已配置" : sourceLabel(provider.source)}</em>
            </button>;
          })}
        </section> : null)}
      </aside>
      <section className="provider-editor">
        {!draft && !loading ? <div className="provider-editor-empty"><CircleDot size={22} /><strong>选择或添加一个服务商</strong><p>所有配置都会写入 CoilCoil 私有运行时的 <code>models.json</code>，不会读取或修改用户的本地 Agent 目录。</p></div> : null}
        {draft?.id === "openai-responses-ws" ? <OpenAIResponsesWsEditor runtimeId={runtimeId} onSaved={onSaved} onReload={(next) => load("openai-responses-ws", next)} /> : draft ? <form className="ui-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <header className="provider-editor-heading">
            <div>
              <div className="provider-heading-tags"><span className="provider-source-tag">{isSpark ? "内置" : selectedId ? sourceLabel(selectedSource) : "新的自定义服务商"}</span>{hasUnsavedChanges ? <span className="provider-unsaved-tag">未保存</span> : null}</div>
              <strong>{draft.name || draft.id || "未命名服务商"}</strong>
              {isSpark ? <small>服务地址已内置，填写 API Key 即可使用；模型目录默认跟随云端。</small> : isBuiltinProvider ? <small>请求协议与内置模型由内置服务商决定；认证字段和运行参数按该服务商的真实实现配置。</small> : null}
            </div>
            <div className="provider-editor-actions">
              <Field className="provider-enable-toggle">
                <Checkbox tone="system"
                  checked={!draft.disabled}
                  onChange={(event) => setDraft((current) => current ? { ...current, disabled: !event.target.checked } : current)}
                />
                启用此服务商
              </Field>
              {canRemove ? <button className={removeArmed ? "danger-text-button armed" : "danger-text-button"} type="button" disabled={saving} onClick={() => removeArmed ? void remove() : setRemoveArmed(true)}>{removeArmed ? "再次点击确认" : <><Trash2 size={14} />{removeLabel}</>}</button> : null}
              <button className="primary-button" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{isBuiltinProvider ? "保存设置" : "保存服务商"}</button>
            </div>
          </header>
          {draft.disabled ? <div className="provider-action-message">已禁用：保存后该服务商不会出现在模型列表中，配置与凭据仍会保留。</div> : null}
          {isBuiltinProvider ? <>
            <ProviderCredentialEditor configuration={credentialConfiguration} method={credentialMethod} values={credentialValues} configured={Boolean(selectedProvider?.apiKeyConfigured && selectedProvider.authType !== "oauth")} oauthConfigured={selectedProvider?.authType === "oauth"} oauthBusy={oauthBusy} onMethodChange={updateCredentialMethod} onValueChange={updateCredentialValue} onOAuthLogin={() => { void startOAuthLogin(); }} onOAuthLogout={() => { void logoutOAuth(); }} />
            {isSpark ? null : <details className="provider-advanced">
              <summary>其他选项 <ChevronRight size={14} /></summary>
              <p>这些选项直接对应 <code>models.json</code> 的服务商覆盖。普通配置不需要填写；“密钥引用”用于通过环境变量或命令延迟取得密钥，不是另一把 API 密钥。</p>
              <div className="settings-grid"><Field>服务地址覆盖（Base URL）<TextField value={draft.baseUrl ?? ""} placeholder="仅代理或私有网关需要" onChange={(event) => setDraft((current) => current ? { ...current, baseUrl: event.target.value } : current)} /></Field><Field>密钥引用<TextField value={draft.apiKeyReference ?? ""} placeholder="$PROVIDER_KEY 或 !op read …" onChange={(event) => setDraft((current) => current ? { ...current, apiKeyReference: event.target.value || undefined } : current)} /></Field></div>
              <div className="provider-checkbox-row"><Field className="checkbox-setting"><Checkbox tone="system" checked={Boolean(draft.authHeader)} onChange={(event) => setDraft((current) => current ? { ...current, authHeader: event.target.checked } : current)} />自动添加 Authorization: Bearer</Field><Field className="checkbox-setting"><Checkbox tone="system" checked={preserveApiKeyReference} onChange={(event) => setPreserveApiKeyReference(event.target.checked)} />保留已有 models.json 密钥/引用</Field></div>
              <div className="settings-grid"><Field>请求头 JSON<TextArea value={providerHeadersText} placeholder={'{ "X-Gateway-Key": "$GATEWAY_KEY" }'} onChange={(event) => setProviderHeadersText(event.target.value)} /></Field><Field>兼容性 JSON<TextArea value={providerCompatText} placeholder={'{ "supportsDeveloperRole": false }'} onChange={(event) => setProviderCompatText(event.target.value)} /></Field></div>
            </details>}
          </> : <>
            <div className="settings-grid"><Field>服务商 ID<TextField value={draft.id} disabled={Boolean(selectedId)} placeholder="例如 dog-provider" onChange={(event) => setDraft((current) => current ? { ...current, id: event.target.value } : current)} /></Field><Field>显示名称<TextField value={draft.name ?? ""} placeholder="例如 DogProvider" onChange={(event) => setDraft((current) => current ? { ...current, name: event.target.value } : current)} /></Field></div>
            <div className="settings-grid"><Field>请求协议<Select value={draft.api ?? ""} options={protocolOptions.filter((option) => option.value)} ariaLabel="请求协议" placeholder="选择协议" onChange={(api) => setDraft((current) => current ? { ...current, api } : current)} searchable /></Field><Field>Base URL<TextField value={draft.baseUrl ?? ""} placeholder={draft.api === "anthropic-messages" ? "https://api.anthropic.com" : "https://api.example.com/v1"} onChange={(event) => setDraft((current) => current ? { ...current, baseUrl: event.target.value } : current)} /></Field></div>
            <ProviderCredentialEditor configuration={credentialConfiguration} method={credentialMethod} values={credentialValues} configured={Boolean(selectedProvider?.apiKeyConfigured && selectedProvider.authType !== "oauth")} oauthConfigured={selectedProvider?.authType === "oauth"} oauthBusy={oauthBusy} onMethodChange={updateCredentialMethod} onValueChange={updateCredentialValue} onOAuthLogin={() => { void startOAuthLogin(); }} onOAuthLogout={() => { void logoutOAuth(); }} />
            <details className="provider-advanced">
              <summary>其他选项 <ChevronRight size={14} /></summary>
              <p>密钥引用、Radius OAuth、请求头与兼容性参数都属于高级配置。普通 API 密钥请填写上方输入框。</p>
              <Field>密钥引用<TextField value={draft.apiKeyReference ?? ""} placeholder="$DOG_PROVIDER_KEY 或 !op read …" onChange={(event) => setDraft((current) => current ? { ...current, apiKeyReference: event.target.value || undefined } : current)} /></Field>
              <div className="provider-checkbox-row"><Field className="checkbox-setting"><Checkbox tone="system" checked={Boolean(draft.authHeader)} onChange={(event) => setDraft((current) => current ? { ...current, authHeader: event.target.checked } : current)} />自动添加 Authorization: Bearer</Field><Field className="checkbox-setting"><Checkbox tone="system" checked={draft.oauth === "radius"} onChange={(event) => setDraft((current) => current ? { ...current, oauth: event.target.checked ? "radius" : undefined } : current)} />使用 Radius OAuth</Field><Field className="checkbox-setting"><Checkbox tone="system" checked={preserveApiKeyReference} onChange={(event) => setPreserveApiKeyReference(event.target.checked)} />保留已有 models.json 密钥/引用</Field></div>
              <div className="settings-grid"><Field>请求头 JSON<TextArea value={providerHeadersText} placeholder={'{ "X-Gateway-Key": "$GATEWAY_KEY" }'} onChange={(event) => setProviderHeadersText(event.target.value)} /></Field><Field>兼容性 JSON<TextArea value={providerCompatText} placeholder={'{ "supportsDeveloperRole": false }'} onChange={(event) => setProviderCompatText(event.target.value)} /></Field></div>
            </details>
          </>}
          <section className="provider-models-section">
            <header><div><strong>模型目录</strong><small>{isSpark ? (draft.replaceModels ? "自定义目录：只保留你留下的模型，可以调整上下文、隐藏不想显示的模型。" : "保留内置：跟随云端的模型列表，每次保存时自动更新。") : draft.replaceModels ? "此目录会写入 models.json，并替换该服务商的默认模型目录。" : "保留内置模型目录；如需自定义模型，请启用自定义目录。"}</small></div><div className="provider-model-mode"><button className={!draft.replaceModels ? "active" : ""} type="button" onClick={() => setDraft((current) => current ? { ...current, replaceModels: false } : current)}>保留内置</button><button className={draft.replaceModels ? "active" : ""} type="button" onClick={() => setDraft((current) => {
              if (!current) return current;
              return { ...current, replaceModels: true, models: current.models.length ? current.models : [blankModel()] };
            })}>自定义目录</button></div></header>
            {!isBuiltinProvider || draft.replaceModels ? <div className="provider-model-toolbar provider-model-toolbar-top">
              {!isBuiltinProvider || isSpark ? <button className="secondary-button" type="button" disabled={fetchingModels || saving} onClick={() => void fetchUpstreamModels()}>{fetchingModels ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{fetchingModels ? "正在拉取…" : "拉取上游模型列表"}</button> : null}
              {draft.replaceModels && draft.models.length > 1 ? <Field className="provider-model-search">
                <Search size={14} />
                <TextField className="provider-model-search-input" value={modelQuery} placeholder={`在 ${draft.models.length} 个模型里搜索`} aria-label="搜索模型" onChange={(event) => setModelQuery(event.target.value)} />
                {modelQuery ? <button type="button" aria-label="清除搜索" onClick={() => setModelQuery("")}><X size={13} /></button> : null}
              </Field> : null}
            </div> : null}
            {draft.replaceModels ? <>
              <div className="provider-model-list">{visibleModels.map(({ model, index }) => <ProviderModelCard key={model.uid} model={model} index={index} apiOptions={protocolOptions} advanced={modelAdvanced[model.uid] ?? { thinkingLevelMap: "{}", samplingParams: "{}", headers: "{}", compat: "{}", costTiers: "[]" }} expanded={expandedModels.has(model.uid)} onToggle={() => setExpandedModels((current) => { const next = new Set(current); if (next.has(model.uid)) next.delete(model.uid); else next.add(model.uid); return next; })} onChange={(next) => updateModel(model.uid, next)} onAdvancedChange={(next) => setModelAdvanced((current) => ({ ...current, [model.uid]: next }))} onRemove={() => { setDraft((current) => current ? { ...current, models: current.models.filter((item) => item.uid !== model.uid) } : current); setModelAdvanced((current) => { const { [model.uid]: _removed, ...rest } = current; return rest; }); }} />)}</div>
              {draft.models.length && !visibleModels.length ? <p className="provider-model-empty">没有匹配「{modelQuery}」的模型。</p> : null}
              <div className="provider-model-toolbar">
                <button className="add-model-button" type="button" onClick={() => { const next = blankModel(); setDraft((current) => current ? { ...current, models: [...current.models, next] } : current); setModelAdvanced((current) => ({ ...current, ...initialAdvancedText([next]) })); /* 新加的那条要立刻能填，也不能被正在生效的搜索藏起来。 */ setModelQuery(""); setExpandedModels((current) => new Set(current).add(next.uid)); }}><Plus size={14} />添加模型</button>
              </div>
            </> : <><div className="provider-builtins-summary">{isSpark ? `当前目录包含 ${defaultModels.length} 个模型，保存时会从云端同步最新的列表。选“自定义目录”可以隐藏模型、调整上下文。` : `当前内置目录包含 ${defaultModels.length} 个模型。启用“自定义目录”后，你可以只保留需要展示的模型。`}</div><details className="provider-advanced"><summary>按模型覆盖参数 <ChevronRight size={14} /></summary><p>保留内置目录时，使用 <code>modelOverrides</code> 为任意内置模型配置上下文、输出上限、图片能力、采样或兼容性参数。</p><Field>modelOverrides JSON<TextArea value={overridesText} placeholder={'{\n  "gpt-5.6": { "contextWindow": 128000, "maxTokens": 16384 }\n}'} onChange={(event) => setOverridesText(event.target.value)} /></Field></details></>}
          </section>
          {!isBuiltinProvider || isSpark ? <section className="provider-test-card">
            <div><strong>测试模型</strong><small>测试只发起一次独立请求，不会创建会话，也不会改变当前或新会话使用的模型。</small></div>
            <div className="settings-grid"><Field>模型<Select value={testModelId} options={defaultModels.map((model) => ({ value: model.id, label: model.name || model.id, detail: model.id }))} ariaLabel="要测试的模型" placeholder="请选择模型" onChange={(modelId) => { setTestModelId(modelId); const selected = defaultModels.find((model) => model.id === modelId); const levels: ThinkingLevel[] = selected ? modelThinkingLevels(selected, configuration, draft.id) : ["off"]; setThinkingLevel((current) => levels.includes(current) ? current : levels[0]); }} searchable /></Field><Field>Thinking<Select value={thinkingLevel} options={thinkingOptions} ariaLabel="测试 Thinking 强度" onChange={(value) => setThinkingLevel(value as ThinkingLevel)} disabled={thinkingOptions.length <= 1} /></Field></div>
            <div className="provider-default-actions"><button className="secondary-button" type="button" disabled={saving || testing || !testModelId} onClick={() => void testConnection()}>{testing ? <LoaderCircle className="spin" size={15} /> : <Zap size={15} />}{testing ? "测试中…" : "测试此模型"}</button></div>
          </section> : null}
          <footer className="ui-form-footer"><span>{snapshot?.configPath}</span><span className="provider-runtime-note">内置协议、模型覆盖和凭据都在 CoilCoil 私有运行时中处理。</span></footer>
        </form> : null}
      </section>
    </div>
  );
}
