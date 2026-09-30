import {
  type Provider,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SettingsManager,
  readStoredCredential,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_OPENAI_RESPONSES_WS_BASE_URL,
  LEGACY_CLIPROXYAPI_CONFIG_FILE,
  OPENAI_RESPONSES_WS_CONFIG_FILE,
  OPENAI_RESPONSES_WS_PROVIDER_ID,
  OPENAI_RESPONSES_WS_PROVIDER_NAME,
} from "@coilcoil/openai-responses-ws/config";
import {
  type ModelOption,
  type ModelProviderConfiguration,
  type ModelProviderModelConfiguration,
  type OpenAIResponsesWsConfiguration,
  type OpenAIResponsesWsConfigurationInput,
  type RuntimeConfiguration,
  type ThinkingLevel,
} from "@coilcoil/runtime-protocol";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import {
  join,
} from "node:path";
import {
  PrivateModelsConfiguration,
  assertOptionalUrl,
  credentialConfiguration,
  modelConfiguration,
  thinkingLevelMap,
} from "./provider-helpers.js";
import { RuntimeBase } from "./runtime-base.js";
import {
  cloneJson,
  errorMessage,
  isRecord,
  objectValue,
  optionalBoolean,
  optionalString,
  safeUnknownRecord,
  stringRecord,
  stripJsonComments,
} from "./runtime-utils.js";
import {
  globalToolPurposeAuditEnabled,
  setGlobalToolPurposeAuditEnabled,
} from "./session-values.js";

export abstract class RuntimeProviderCore extends RuntimeBase {
  async getConfiguration(): Promise<RuntimeConfiguration> {
    setGlobalToolPurposeAuditEnabled(this.readToolPurposeAuditSetting());
    const modelRuntime = await this.ready();
    const cwd = this.active?.cwd ?? process.cwd();
    const settings = SettingsManager.create(cwd, this.agentDir);
    const providers = new Map(modelRuntime.getProviders().map((provider) => [provider.id, provider.name || provider.id]));
    const disabledProviders = this.disabledProviderIds();
    const configuredProviders = modelRuntime
      .getProviders()
      .filter((provider) => modelRuntime.hasConfiguredAuth(provider.id) && !disabledProviders.has(provider.id))
      .map((provider) => provider.id)
      .sort();
    const configuredSet = new Set(configuredProviders);
    const runtimeOptions = this.readModelRuntimeOptions();
    const restricted = this.restrictedCatalogs();
    const models: ModelOption[] = modelRuntime
      .getModels()
      .filter((model) => !disabledProviders.has(model.provider))
      .filter((model) => restricted.get(model.provider)?.has(model.id) ?? true)
      .map((model) => ({
        provider: model.provider,
        providerName: providers.get(model.provider) ?? model.provider,
        id: model.id,
        name: model.name || model.id,
        reasoning: Boolean(model.reasoning),
        supportsImages: model.input.includes("image"),
        supportedThinkingLevels: getSupportedThinkingLevels(model) as ThinkingLevel[],
        contextWindow: runtimeOptions[model.provider]?.[model.id]?.contextWindow
          ?? (typeof model.contextWindow === "number" ? model.contextWindow : undefined),
        configured: configuredSet.has(model.provider),
      }))
      .sort((a, b) => {
        if (a.configured !== b.configured) return a.configured ? -1 : 1;
        const providerOrder = a.providerName.localeCompare(b.providerName);
        return providerOrder || a.name.localeCompare(b.name, undefined, { numeric: true });
      });

    return {
      provider: settings.getDefaultProvider(),
      modelId: settings.getDefaultModel(),
      thinkingLevel: (settings.getDefaultThinkingLevel() ?? "medium") as ThinkingLevel,
      configuredProviders,
      models,
      migratedLegacyCredentials: this.migratedLegacyCredentials,
      toolPurposeAuditEnabled: globalToolPurposeAuditEnabled(),
    };
  }

  protected coilcoilSettingsPath(): string {
    return join(this.agentDir, "coilcoil-settings.json");
  }

  protected readToolPurposeAuditSetting(): boolean {
    const path = this.coilcoilSettingsPath();
    if (!existsSync(path)) return true;
    try {
      const value = JSON.parse(readFileSync(path, "utf8"));
      return !isRecord(value) || value.toolPurposeAuditEnabled !== false;
    } catch {
      return true;
    }
  }

  async setToolPurposeAuditEnabled(enabled: boolean): Promise<RuntimeConfiguration> {
    const path = this.coilcoilSettingsPath();
    let current: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        const value = JSON.parse(readFileSync(path, "utf8"));
        if (isRecord(value)) current = value;
      } catch {
        current = {};
      }
    }
    mkdirSync(this.agentDir, { recursive: true });
    const temporaryPath = `${path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify({ ...current, toolPurposeAuditEnabled: enabled }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
    setGlobalToolPurposeAuditEnabled(enabled);
    this.reloadActiveSessionResources("工具调用意图设置重新加载失败");
    const configuration = await this.getConfiguration();
    this.emitEvent({ type: "configuration_updated", configuration });
    return configuration;
  }

  protected openAIResponsesWsConfigurationPath(): string {
    return join(this.agentDir, OPENAI_RESPONSES_WS_CONFIG_FILE);
  }

  protected modelRuntimeOptionsPath(): string {
    return join(this.agentDir, "model-runtime-options.json");
  }

  protected readModelRuntimeOptions(): Record<string, Record<string, { contextWindow?: number; }>> {
    const path = this.modelRuntimeOptionsPath();
    if (!existsSync(path)) return {};
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isRecord(value)) return {};
      const result: Record<string, Record<string, { contextWindow?: number; }>> = {};
      for (const [provider, models] of Object.entries(value)) {
        if (!isRecord(models)) continue;
        result[provider] = {};
        for (const [modelId, options] of Object.entries(models)) {
          if (!isRecord(options)) continue;
          const contextWindow = typeof options.contextWindow === "number" && Number.isFinite(options.contextWindow) && options.contextWindow > 0
            ? Math.round(options.contextWindow)
            : undefined;
          if (contextWindow) result[provider][modelId] = { contextWindow };
        }
      }
      return result;
    } catch {
      return {};
    }
  }

  protected writeModelRuntimeContextWindow(provider: string, modelId: string, contextWindow: number): void {
    const values = this.readModelRuntimeOptions();
    values[provider] ??= {};
    values[provider][modelId] = { ...(values[provider][modelId] ?? {}), contextWindow };
    const path = this.modelRuntimeOptionsPath();
    const temporaryPath = `${path}.${process.pid}.tmp`;
    mkdirSync(this.agentDir, { recursive: true });
    writeFileSync(temporaryPath, `${JSON.stringify(values, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
  }

  protected modelWithRuntimeOptions<T extends { provider: string; id: string; contextWindow: number; }>(model: T): T {
    const contextWindow = this.readModelRuntimeOptions()[model.provider]?.[model.id]?.contextWindow;
    return contextWindow && contextWindow !== model.contextWindow ? { ...model, contextWindow } : model;
  }

  protected readOpenAIResponsesWsConfigurationFile(): Record<string, unknown> {
    const path = this.openAIResponsesWsConfigurationPath();
    const legacyPath = join(this.agentDir, LEGACY_CLIPROXYAPI_CONFIG_FILE);
    const sourcePath = existsSync(path) ? path : legacyPath;
    if (!existsSync(sourcePath)) return {};
    try {
      const value: unknown = JSON.parse(readFileSync(sourcePath, "utf8"));
      if (!isRecord(value)) throw new Error("配置文件必须包含 JSON 对象。");
      return value;
    } catch (error) {
      throw new Error(`无法读取 OpenAI Response (WS) 配置：${errorMessage(error)}`);
    }
  }

  async getOpenAIResponsesWsConfiguration(): Promise<OpenAIResponsesWsConfiguration> {
    const value = this.readOpenAIResponsesWsConfigurationFile();
    return {
      configPath: this.openAIResponsesWsConfigurationPath(),
      baseUrl: optionalString(value, "baseUrl") ?? DEFAULT_OPENAI_RESPONSES_WS_BASE_URL,
      apiKeyConfigured: Boolean(optionalString(value, "apiKey")),
      fast: optionalBoolean(value, "fast") ?? false,
    };
  }

  async saveOpenAIResponsesWsConfiguration(input: OpenAIResponsesWsConfigurationInput): Promise<RuntimeConfiguration> {
    const baseUrl = assertOptionalUrl(input.baseUrl, "OpenAI Response (WS) Base URL");
    if (!baseUrl) throw new Error("OpenAI Response (WS) Base URL 不能为空。");
    const existing = this.readOpenAIResponsesWsConfigurationFile();
    const apiKey = input.apiKey?.trim() || (input.preserveApiKey ? optionalString(existing, "apiKey") : undefined);
    if (!apiKey) throw new Error("OpenAI Response (WS) API Key 不能为空。");
    const value = {
      baseUrl,
      apiKey,
      fast: input.fast === true,
    };
    mkdirSync(this.agentDir, { recursive: true });
    const path = this.openAIResponsesWsConfigurationPath();
    const temporaryPath = `${path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
    try { chmodSync(path, 0o600); } catch { /* Non-POSIX filesystems can ignore private modes. */ }

    if (this.active) {
      if (this.canReloadActiveSession(this.active)) {
        await this.refreshAgentMcpConfiguration(this.active.eventBus, this.active.cwd, this.active.session.sessionId);
        await this.active.session.reload();
      }
      else this.reloadActiveSessionResources("OpenAI Response (WS) 配置重新加载失败");
    }
    const configuration = await this.getConfiguration();
    this.emitEvent({ type: "configuration_updated", configuration });
    return configuration;
  }

  protected disabledProviderIds(): Set<string> {
    const privateConfiguration = this.readPrivateModelsConfiguration();
    return new Set(
      Object.entries(privateConfiguration.providers)
        .filter(([, provider]) => provider.disabled === true)
        .map(([id]) => id),
    );
  }

  /**
   * Providers whose catalog the user replaced ("自定义目录"): only the models they kept.
   *
   * Pi treats a `models` list in models.json as an upsert on top of a built-in
   * provider, so the built-in models were still there after the user had asked for
   * their own list. The picker and every list built from this configuration go
   * through here, so a built-in provider (Anthropic, Codex, ...) shows exactly the
   * list the user saved, the same as a custom one always did.
   */
  protected restrictedCatalogs(): Map<string, Set<string>> {
    const restricted = new Map<string, Set<string>>();
    for (const [id, provider] of Object.entries(this.readPrivateModelsConfiguration().providers)) {
      if (!Array.isArray(provider.models) || provider.models.length === 0) continue;
      const kept = provider.models.flatMap((model) => (isRecord(model) && typeof model.id === "string" ? [model.id] : []));
      if (kept.length) restricted.set(id, new Set(kept));
    }
    return restricted;
  }

  protected modelsConfigurationPath(): string {
    return join(this.agentDir, "models.json");
  }

  protected readPrivateModelsConfiguration(): PrivateModelsConfiguration {
    const path = this.modelsConfigurationPath();
    if (!existsSync(path)) return { providers: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
    } catch (error) {
      throw new Error(`无法读取 CoilCoil 私有 models.json：${errorMessage(error)}`);
    }
    if (!isRecord(parsed) || !isRecord(parsed.providers)) {
      throw new Error("CoilCoil 私有 models.json 必须包含 providers 对象。");
    }
    const providers = Object.fromEntries(
      Object.entries(parsed.providers).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])),
    );
    return { providers: cloneJson(providers) };
  }

  protected writePrivateModelsConfiguration(configuration: PrivateModelsConfiguration): void {
    mkdirSync(this.agentDir, { recursive: true });
    const path = this.modelsConfigurationPath();
    const temporaryPath = `${path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(configuration, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      // A private runtime still works when a filesystem does not support POSIX permissions.
    }
  }

  protected modelProviderFromConfiguration(
    providerId: string,
    provider: Record<string, unknown> | undefined,
    runtimeModels: readonly { id: string; name?: string; api?: string; baseUrl?: string; reasoning?: boolean; input: readonly string[]; contextWindow?: number; maxTokens?: number; thinkingLevelMap?: Record<string, string | null | undefined>; cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; tiers?: Array<{ inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number; }>; }; samplingParams?: Record<string, unknown>; headers?: Record<string, string>; compat?: object; }[],
    runtimeProvider: Provider | undefined,
    builtins: ReadonlySet<string>,
    modelRuntime: ModelRuntime,
  ): ModelProviderConfiguration {
    const configuredModels = Array.isArray(provider?.models)
      ? provider.models.map((item) => modelConfiguration(item)).filter((item): item is ModelProviderModelConfiguration => Boolean(item))
      : runtimeModels.map((model) => ({
        id: model.id,
        name: model.name,
        api: model.api,
        baseUrl: model.baseUrl,
        reasoning: model.reasoning,
        thinkingLevelMap: thinkingLevelMap(model.thinkingLevelMap),
        input: model.input.filter((item): item is "text" | "image" => item === "text" || item === "image"),
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        cost: model.cost && typeof model.cost.input === "number" && typeof model.cost.output === "number" && typeof model.cost.cacheRead === "number" && typeof model.cost.cacheWrite === "number"
          ? { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead, cacheWrite: model.cost.cacheWrite, tiers: model.cost.tiers?.map((tier) => ({ ...tier })) }
          : undefined,
        samplingParams: model.samplingParams ? cloneJson(model.samplingParams) : undefined,
        headers: model.headers ? stringRecord(model.headers, true) : undefined,
        compat: safeUnknownRecord(model.compat),
      }));
    const modelOverrides = objectValue(provider?.modelOverrides);
    const mappedOverrides = modelOverrides
      ? Object.fromEntries(Object.entries(modelOverrides).flatMap(([modelId, value]) => {
        const model = modelConfiguration(value, modelId);
        if (!model) return [];
        const { id: _id, api: _api, baseUrl: _baseUrl, ...override } = model;
        return [[modelId, override]];
      })) as ModelProviderConfiguration["modelOverrides"]
      : undefined;
    const apiKey = provider ? optionalString(provider, "apiKey") : undefined;
    const apiKeyReference = apiKey?.startsWith("$") || apiKey?.startsWith("!") ? apiKey : undefined;
    const storedCredential = readStoredCredential(providerId, join(this.agentDir, "auth.json"));
    const storedApiKeyCredential = storedCredential?.type === "api_key" ? storedCredential : undefined;
    const authType = storedCredential?.type
      ?? (modelRuntime.isUsingOAuth(providerId)
        ? "oauth"
        : modelRuntime.hasConfiguredAuth(providerId) || Boolean(apiKey)
          ? "api_key"
          : undefined);
    const providerName = runtimeProvider?.name;
    const fallbackName = providerId === OPENAI_RESPONSES_WS_PROVIDER_ID ? OPENAI_RESPONSES_WS_PROVIDER_NAME : providerId;
    return {
      id: providerId,
      name: provider ? optionalString(provider, "name") ?? providerName ?? fallbackName : providerName ?? fallbackName,
      baseUrl: provider ? optionalString(provider, "baseUrl") : undefined,
      api: provider ? optionalString(provider, "api") : undefined,
      oauth: provider?.oauth === "radius" ? "radius" : undefined,
      headers: provider ? stringRecord(provider.headers, true) : undefined,
      compat: provider ? safeUnknownRecord(provider.compat) : undefined,
      authHeader: provider ? optionalBoolean(provider, "authHeader") : undefined,
      apiKeyReference,
      hasPrivateApiKeyReference: Boolean(apiKey && !apiKeyReference),
      apiKeyConfigured: modelRuntime.hasConfiguredAuth(providerId) || Boolean(apiKey),
      authType,
      disabled: provider?.disabled === true,
      credential: credentialConfiguration(runtimeProvider, storedApiKeyCredential),
      replaceModels: Array.isArray(provider?.models),
      models: configuredModels,
      modelOverrides: mappedOverrides && Object.keys(mappedOverrides).length ? mappedOverrides : undefined,
      source: provider ? builtins.has(providerId) ? "override" : "custom" : "built-in",
    };
  }
}
