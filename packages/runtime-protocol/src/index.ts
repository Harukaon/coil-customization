export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type AgentMode = "standard" | "unrestricted";

export interface ProjectSelection {
  name: string;
  path: string;
  kind: "home" | "workspace";
}

export interface ModelOption {
  provider: string;
  providerName: string;
  id: string;
  name: string;
  reasoning: boolean;
  supportsImages: boolean;
  supportedThinkingLevels: ThinkingLevel[];
  contextWindow?: number;
  configured: boolean;
}

export interface RuntimeConfiguration {
  provider?: string;
  modelId?: string;
  thinkingLevel: ThinkingLevel;
  configuredProviders: string[];
  models: ModelOption[];
  migratedLegacyCredentials: boolean;
  /** Whether CoilCoil injects and validates the tool-call purpose field. */
  toolPurposeAuditEnabled?: boolean;
}

/** An explicit model choice carried across a session boundary. */
export interface SessionModelSelection {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

/** A model choice waiting for the next prompt of a busy session. */
export interface PendingSessionModel {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevel: ThinkingLevel;
}

/** Configuration for CoilCoil's own OpenAI Responses WebSocket Pi extension. */
export interface OpenAIResponsesWsConfiguration {
  configPath: string;
  baseUrl: string;
  apiKeyConfigured: boolean;
  fast: boolean;
}

export interface OpenAIResponsesWsConfigurationInput {
  baseUrl: string;
  apiKey?: string;
  preserveApiKey: boolean;
  fast?: boolean;
}

/**
 * Pi's built-in streaming transports that can be configured through
 * `models.json`. The runtime deliberately keeps the value as a string so a
 * newer Pi transport can be exposed before CoilCoil itself needs a release.
 */
export interface ModelProviderApiOption {
  id: string;
  label: string;
  description: string;
}

export interface ModelProviderCredentialField {
  /** `key` writes to the Pi credential key; environment names write to credential.env. */
  id: string;
  label: string;
  input: "text" | "secret" | "textarea";
  required: boolean;
  placeholder?: string;
  description?: string;
  /** The value is returned only for non-secret fields. */
  value?: string;
  configured: boolean;
}

export interface ModelProviderCredentialMethod {
  id: string;
  label: string;
  description?: string;
  fields: ModelProviderCredentialField[];
}

/** Pi-native authentication capabilities projected into the desktop settings UI. */
export interface ModelProviderCredentialConfiguration {
  name?: string;
  selectedMethod?: string;
  methods: ModelProviderCredentialMethod[];
  oauth?: {
    name: string;
    label: string;
  };
}

export type ModelProviderAuthPrompt =
  | { id: string; type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
  | {
      id: string;
      type: "select";
      message: string;
      options: Array<{ id: string; label: string; description?: string }>;
    };

export interface ModelProviderAuthState {
  flowId: string;
  provider: string;
  providerName: string;
  loginLabel: string;
  status: "starting" | "waiting_for_user" | "authorizing" | "succeeded" | "failed" | "cancelled";
  message?: string;
  prompt?: ModelProviderAuthPrompt;
  authUrl?: {
    url: string;
    instructions?: string;
  };
  deviceCode?: {
    userCode: string;
    verificationUri: string;
    expiresInSeconds?: number;
  };
  links?: Array<{ url: string; label?: string }>;
  error?: string;
}

/** A provider OAuth state plus a cursor for Agent-side await calls. */
export interface ModelProviderAuthSnapshot {
  state: ModelProviderAuthState;
  revision: number;
}

export interface ModelCostConfiguration {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: Array<{
    inputTokensAbove: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  }>;
}

/** A serializable subset of a Pi `models.json` model definition. */
export interface ModelProviderModelConfiguration {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelCostConfiguration;
  samplingParams?: Record<string, unknown>;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

/**
 * A provider entry projected from CoilCoil's private Pi `models.json`.
 * Credentials are intentionally represented only as availability/reference
 * metadata; the literal key stays in Pi's private auth store.
 */
export interface ModelProviderConfiguration {
  id: string;
  name?: string;
  baseUrl?: string;
  api?: string;
  oauth?: "radius";
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  authHeader?: boolean;
  /** Pi value expression such as `$MY_KEY` or `!op read ...`, never a raw key. */
  apiKeyReference?: string;
  /** A literal `models.json` API key exists but is intentionally redacted. */
  hasPrivateApiKeyReference: boolean;
  apiKeyConfigured: boolean;
  /** The active stored/resolved credential kind. No secret material is exposed. */
  authType?: "api_key" | "oauth";
  /** Soft-disable: keep config but hide models from the picker. */
  disabled: boolean;
  credential: ModelProviderCredentialConfiguration;
  /** `models` exists in models.json and replaces Pi's catalog for this provider. */
  replaceModels: boolean;
  models: ModelProviderModelConfiguration[];
  modelOverrides?: Record<string, Omit<ModelProviderModelConfiguration, "id" | "api" | "baseUrl">>;
  source: "built-in" | "custom" | "override";
}

/** Editable provider input. `apiKey` is write-only and never returned. */
export interface ModelProviderConfigurationInput {
  provider: Omit<ModelProviderConfiguration, "apiKeyConfigured" | "authType" | "hasPrivateApiKeyReference" | "source" | "credential">;
  credential?: {
    method: string;
    values: Record<string, string>;
    /** Keep configured secret fields whose inputs were intentionally left blank. */
    preserveFields: string[];
  };
  /** @deprecated Use `credential`; retained for older CLI/runtime clients. */
  apiKey?: string;
  /** Keep an existing redacted literal or expression from models.json. */
  preserveApiKeyReference?: boolean;
}

/**
 * A partial provider edit, the way the `coilcoil` tool sends one.
 *
 * The settings panel always posts the whole draft back, because a form holds
 * every field anyway. An Agent does not: it is told "把上下文改成 200k", and
 * making it restate the entire model catalogue to do that is how models get
 * silently deleted. So every field here is optional and means "leave it"; the
 * runtime reads the current configuration and applies only what was sent.
 */
export interface ModelProviderPatchInput {
  id: string;
  name?: string;
  baseUrl?: string;
  api?: string;
  oauth?: "radius";
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  authHeader?: boolean;
  apiKeyReference?: string;
  disabled?: boolean;
  /** `models` in models.json replaces Pi's own catalog for this provider. */
  replaceModels?: boolean;
  /** Upserted by model id under `merge` (the default); the whole list under `replace`. */
  models?: ModelProviderModelConfiguration[];
  modelsMode?: "merge" | "replace";
  removeModels?: string[];
  modelOverrides?: ModelProviderConfiguration["modelOverrides"];
  /** Explicitly preserve the existing models.json key/reference when no new one is supplied. */
  preserveApiKeyReference?: boolean;
  /** Literal key; stored in Pi's private auth store, never in models.json. */
  apiKey?: string;
  credential?: {
    method: string;
    values: Record<string, string>;
    preserveFields?: string[];
  };
}

export interface ModelProviderConfigurationSnapshot {
  configPath: string;
  providers: ModelProviderConfiguration[];
  supportedApis: ModelProviderApiOption[];
}

export interface ModelProviderSaveResult {
  provider: ModelProviderConfiguration;
  configuration: RuntimeConfiguration;
}

export interface FetchProviderModelsInput {
  baseUrl: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Use stored auth.json credentials for this provider when apiKey is omitted. */
  provider?: string;
}

export interface FetchProviderModelsResult {
  models: Array<{ id: string; name?: string }>;
}

export interface TestProviderConnectionInput {
  baseUrl: string;
  api: string;
  apiKey?: string;
  headers?: Record<string, string>;
  modelId?: string;
  /** Use stored auth.json credentials for this provider when apiKey is omitted. */
  provider?: string;
}

export interface TestProviderConnectionResult {
  ok: boolean;
  message: string;
  detail?: string;
}

export type McpTransport = "stdio" | "http";

export interface McpServerConfiguration {
  name: string;
  scope: "global" | "project";
  transport: McpTransport;
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  url?: string;
  headers: Record<string, string>;
  auth?: "oauth" | "bearer" | false;
  bearerTokenEnv?: string;
  lifecycle: "keep-alive" | "lazy" | "eager";
  idleTimeout?: number;
  requestTimeoutMs?: number;
  exposeResources: boolean;
  directTools: boolean | string[];
  excludeTools: string[];
  debug: boolean;
  disabled: boolean;
  source?: string;
  sourceKind?: "user" | "project" | "import";
  /**
   * Which app an imported definition came from. For imports the adapter sets
   * `source` to CoilCoil's own config path (that is where overrides get written),
   * so this is the only field that identifies the true origin.
   */
  importKind?: McpImportConfiguration["kind"];
}

export interface McpImportConfiguration {
  kind: "cursor" | "claude-code" | "claude-desktop" | "codex" | "opencode" | "windsurf" | "vscode";
  path: string;
  serverCount: number;
  enabled: boolean;
}

/**
 * 一台机器上「别的工具里已经配好」的一个 MCP 服务器。
 *
 * 只是发现结果，不代表已经生效：用户在弹窗里勾了哪几个，才有哪几个被抄进
 * CoilCoil 自己的配置。`alreadyPresent` 用来把已经装过的那几个标灰，避免重复导入
 * 覆盖掉用户后来改过的参数。
 */
export interface DiscoveredMcpServer {
  /** 来源工具。 */
  origin: McpImportConfiguration["kind"];
  /** 来源配置文件的绝对路径，弹窗里要显示出来。 */
  originPath: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  /** 原样的定义，导入时整块抄过去。 */
  definition: Record<string, unknown>;
  /** CoilCoil 里已经有同名服务器。 */
  alreadyPresent: boolean;
}

export interface McpDiscoveryResult {
  servers: DiscoveredMcpServer[];
  /** 扫过但一个服务器也没读出来的来源，用来解释「为什么这里是空的」。 */
  emptyOrigins: Array<{ kind: McpImportConfiguration["kind"]; path: string; reason: string }>;
}

export interface ImportMcpServersInput {
  /** 要导入的服务器，按 origin + name 定位。 */
  servers: Array<{ origin: McpImportConfiguration["kind"]; name: string }>;
  cwd?: string;
}

export interface McpConfigurationSnapshot {
  configPath: string;
  projectConfigPath?: string;
  servers: McpServerConfiguration[];
  imports: McpImportConfiguration[];
}

export interface McpJsonDocument {
  path: string;
  content: string;
}

export type McpJsonValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const MCP_IMPORT_KINDS = new Set([
  "cursor",
  "claude-code",
  "claude-desktop",
  "codex",
  "opencode",
  "windsurf",
  "vscode",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown, label: string): string | undefined {
  if (!isPlainObject(value)) return `${label} 必须是对象。`;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return `${label}.${key} 必须是字符串。`;
  }
  return undefined;
}

/** Validate Cursor-compatible mcp.json text before writing. Rejects invalid JSON to keep MCP usable. */
/** One server pulled out of a pasted MCP configuration, ready to fill the editor. */
export interface McpServerSnippet {
  /** Absent when the snippet was a bare server object with nothing to name it. */
  name?: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  url?: string;
  headers: Record<string, string>;
}

export type McpSnippetResult =
  | { ok: true; servers: McpServerSnippet[] }
  | { ok: false; error: string };

function stringRecordOrUndefined(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return Object.fromEntries(entries);
}

function looksLikeServerEntry(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  return typeof value.command === "string" || typeof value.url === "string" || typeof value.httpUrl === "string";
}

function snippetFromEntry(name: string | undefined, entry: Record<string, unknown>): McpServerSnippet {
  // `url` is what CoilCoil and Claude write; `httpUrl` and `serverUrl` turn up in
  // configurations copied from other hosts and mean the same thing.
  const url = [entry.url, entry.httpUrl, entry.serverUrl].find((value) => typeof value === "string" && value.trim()) as string | undefined;
  const command = typeof entry.command === "string" && entry.command.trim() ? entry.command.trim() : undefined;
  // A `type` of "http"/"sse"/"stdio" rides along in Claude Code exports. The
  // transport is decided by which of command/url is present, so type only breaks
  // the tie when a snippet somehow carries both.
  const declaredType = typeof entry.type === "string" ? entry.type.toLowerCase() : undefined;
  const transport: McpTransport = url && (!command || declaredType === "http" || declaredType === "sse") ? "http" : "stdio";
  const args = Array.isArray(entry.args)
    ? entry.args.filter((item): item is string => typeof item === "string")
    : [];
  return {
    ...(name ? { name } : {}),
    transport,
    ...(transport === "stdio" ? { command } : {}),
    args: transport === "stdio" ? args : [],
    env: transport === "stdio" ? stringRecordOrUndefined(entry.env) ?? {} : {},
    ...(transport === "stdio" && typeof entry.cwd === "string" && entry.cwd.trim() ? { cwd: entry.cwd.trim() } : {}),
    ...(transport === "http" ? { url: url?.trim() } : {}),
    headers: transport === "http" ? stringRecordOrUndefined(entry.headers) ?? {} : {},
  };
}

/**
 * Read a pasted MCP configuration in whatever shape it was copied in.
 *
 * The JSON people have on hand is rarely CoilCoil's file: it may be a whole
 * `{ "mcpServers": {…} }` document, the `{ "servers": {…} }` VS Code writes, a
 * single `{ "name": {…} }` pair, or - most often, because it is what a README
 * shows - a bare server object with no name at all. Rejecting everything but the
 * first shape is what makes a copied snippet impossible to use, so all four are
 * accepted here and the caller asks for a name only when there is none.
 */
export function parseMcpServerSnippets(text: string): McpSnippetResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "请先粘贴 MCP 配置 JSON。" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return { ok: false, error: `JSON 语法错误：${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isPlainObject(parsed)) return { ok: false, error: "MCP 配置必须是 JSON 对象。" };

  const container = isPlainObject(parsed.mcpServers)
    ? parsed.mcpServers
    : isPlainObject(parsed.servers)
      ? parsed.servers
      : undefined;
  if (container) {
    const servers = Object.entries(container)
      .filter((entry): entry is [string, Record<string, unknown>] => looksLikeServerEntry(entry[1]))
      .map(([name, entry]) => snippetFromEntry(name, entry));
    if (!servers.length) return { ok: false, error: "没有找到带 command 或 url 的 MCP 服务器。" };
    return { ok: true, servers };
  }

  if (looksLikeServerEntry(parsed)) return { ok: true, servers: [snippetFromEntry(undefined, parsed)] };

  const pairs = Object.entries(parsed).filter((entry): entry is [string, Record<string, unknown>] => looksLikeServerEntry(entry[1]));
  if (pairs.length) return { ok: true, servers: pairs.map(([name, entry]) => snippetFromEntry(name, entry)) };

  return { ok: false, error: "没有找到 MCP 服务器定义：需要 command（stdio）或 url（HTTP）。" };
}

export function validateMcpJsonText(text: string): McpJsonValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `JSON 语法错误：${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isPlainObject(parsed)) return { ok: false, error: "根节点必须是 JSON 对象，例如 { \"mcpServers\": {} }。" };
  if (!("mcpServers" in parsed)) return { ok: false, error: "缺少 mcpServers 字段。" };
  if (!isPlainObject(parsed.mcpServers)) return { ok: false, error: "mcpServers 必须是对象。" };

  for (const [name, entry] of Object.entries(parsed.mcpServers)) {
    if (!name.trim()) return { ok: false, error: "存在空的 MCP 服务器名称。" };
    if (!MCP_SERVER_NAME_PATTERN.test(name)) {
      return { ok: false, error: `MCP 名称「${name}」只能包含字母、数字、点、下划线和连字符。` };
    }
    if (!isPlainObject(entry)) return { ok: false, error: `mcpServers.${name} 必须是对象。` };
    const hasCommand = typeof entry.command === "string" && entry.command.trim().length > 0;
    const hasUrl = typeof entry.url === "string" && entry.url.trim().length > 0;
    // An entry may carry only overrides for a server that is defined elsewhere —
    // an imported Cursor/Claude/Codex config, or a shared `.mcp.json`. Removing
    // such a server can only tombstone it as `{ "disabled": true }` here, so
    // demanding a transport would reject files CoilCoil itself writes.
    const overrideOnly = !hasCommand && !hasUrl
      && Object.keys(entry).every((key) => key === "disabled" || key === "excludeTools");
    if (!hasCommand && !hasUrl && !overrideOnly) {
      return { ok: false, error: `mcpServers.${name} 需要提供 command（stdio）或 url（HTTP）。` };
    }
    if (hasCommand && hasUrl) {
      return { ok: false, error: `mcpServers.${name} 不能同时设置 command 与 url。` };
    }
    if (entry.args !== undefined) {
      if (!Array.isArray(entry.args) || entry.args.some((item) => typeof item !== "string")) {
        return { ok: false, error: `mcpServers.${name}.args 必须是字符串数组。` };
      }
    }
    if (entry.env !== undefined) {
      const error = isStringRecord(entry.env, `mcpServers.${name}.env`);
      if (error) return { ok: false, error };
    }
    if (entry.headers !== undefined) {
      const error = isStringRecord(entry.headers, `mcpServers.${name}.headers`);
      if (error) return { ok: false, error };
    }
    if (entry.cwd !== undefined && typeof entry.cwd !== "string") {
      return { ok: false, error: `mcpServers.${name}.cwd 必须是字符串。` };
    }
    if (entry.auth !== undefined && entry.auth !== "oauth" && entry.auth !== "bearer" && entry.auth !== false) {
      return { ok: false, error: `mcpServers.${name}.auth 只能是 oauth、bearer 或 false。` };
    }
    if (entry.disabled !== undefined && typeof entry.disabled !== "boolean") {
      return { ok: false, error: `mcpServers.${name}.disabled 必须是布尔值。` };
    }
    if (entry.lifecycle !== undefined && entry.lifecycle !== "lazy" && entry.lifecycle !== "keep-alive" && entry.lifecycle !== "eager") {
      return { ok: false, error: `mcpServers.${name}.lifecycle 只能是 lazy、keep-alive 或 eager。` };
    }
  }

  if (parsed.imports !== undefined) {
    if (!Array.isArray(parsed.imports) || parsed.imports.some((item) => typeof item !== "string" || !MCP_IMPORT_KINDS.has(item))) {
      return { ok: false, error: "imports 必须是受支持的导入源字符串数组。" };
    }
  }

  if (parsed.settings !== undefined && !isPlainObject(parsed.settings)) {
    return { ok: false, error: "settings 必须是对象。" };
  }

  return { ok: true, value: parsed };
}

export interface McpServerRuntimeStatus {
  name: string;
  status: "connected" | "needs-auth" | "failed" | "cached" | "not connected" | "disabled";
  toolCount: number;
  resourceCount: number;
  failedAgo: number | null;
  /**
   * 上一次连接失败时服务器回的 HTTP 状态码，没答话就是 null。
   *
   * 有这个数就说明服务器是活的，连不上多半是登录过期——界面据此把「检查状态」
   * 直接接到重新授权上，而不是留下一句没有出路的错误。
   */
  failureHttpStatus?: number | null;
  disabled: boolean;
  /** Disabled only for this Pi session; the workspace configuration is unchanged. */
  sessionDisabled: boolean;
}

export interface McpRuntimeStatus {
  servers: McpServerRuntimeStatus[];
  totalTools: number;
  totalResources: number;
  connectedCount: number;
  disabledCount: number;
  sessionDisabledCount: number;
  state?: "ready" | "initializing" | "unavailable";
  diagnostic?: string;
}

export interface McpActionResult {
  text: string;
  details?: Record<string, unknown>;
  status?: McpRuntimeStatus;
}

export type SkillSource = "user" | "project" | "agents" | "bundled";

export interface SkillEntry {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: SkillSource;
  enabled: boolean;
  disableModelInvocation: boolean;
  scope: "user" | "project";
}

export interface SkillDiagnostic {
  type: "warning" | "error" | "collision";
  message: string;
  path?: string;
}

export interface SkillConfigurationSnapshot {
  agentDir: string;
  userSkillsDir: string;
  projectSkillsDir?: string;
  agentsSkillsDir: string;
  skillPaths: string[];
  projectSkillPaths: string[];
  customSkillPaths: string[];
  enableSkillCommands: boolean;
  skills: SkillEntry[];
  /**
   * Skills CoilCoil was told to hide (`!` in settings), files still on disk.
   *
   * They are deliberately kept out of `skills` — that list is "what this
   * workspace offers" and the settings panel renders it directly. But hiding
   * used to mean *forgetting*: a removed skill could no longer be found by
   * path, so deleting it, re-enabling it, or reinstalling it all failed with
   * 「未找到技能」 and the folder stayed on disk forever. Listing them here is
   * what makes removal reversible.
   */
  removedSkills?: SkillEntry[];
  diagnostics: SkillDiagnostic[];
}

export interface SessionSummary {
  id: string;
  path: string;
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  archivedAt?: string;
  pinned?: boolean;
  pinnedAt?: string;
}

export type ChatRole = "user" | "assistant" | "tool" | "system";

export interface PromptImage {
  id?: string;
  mimeType: string;
  data: string;
  name?: string;
  /**
   * Extra model context that belongs to this image but should not be pasted into
   * the editable composer. Browser element picks use this for the selected DOM
   * identity while the image carries the spatial context.
   */
  context?: string;
}

/** Serializable page data kept with an atomic browser-element prompt node. */
export interface BrowserElementSnapshot {
  pageUrl: string;
  pageTitle: string;
  tagName: string;
  selector: string;
  xpath: string;
  outerHtml: string;
  text?: string;
  attributes: Record<string, string>;
  styles: Record<string, string>;
  component?: string;
  componentProps?: Record<string, string | number | boolean | null>;
  source?: { file: string; line?: number; column?: number };
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface PromptTextPart {
  type: "text";
  text: string;
}

export interface PromptBrowserElementPart {
  type: "browser-element";
  id: string;
  label: string;
  element: BrowserElementSnapshot;
  screenshotId?: string;
}

export type PromptPart = PromptTextPart | PromptBrowserElementPart;

/** The single source of truth for a composer/history message with atomic nodes. */
export interface PromptDocument {
  version: 1;
  parts: PromptPart[];
}

export function emptyPromptDocument(): PromptDocument {
  return { version: 1, parts: [] };
}

/** Text shown by the editor and used as the natural-language message body. */
export function promptDocumentText(document: PromptDocument | undefined): string {
  if (!document) return "";
  return document.parts.map((part) => part.type === "text" ? part.text : part.label).join("");
}

export function promptDocumentHasContent(document: PromptDocument | undefined): boolean {
  return Boolean(document?.parts.some((part) => part.type === "browser-element" || part.text.trim()));
}

/** `/compact` 带的额外要求，没写就是空对象。 */
export interface ManualCompactionCommand {
  instructions?: string;
}

const MANUAL_COMPACTION_COMMAND = "compact";

/**
 * 认出一句话是不是 `/compact`。
 *
 * 放在协议包里，是因为两边都要用：输入框靠它决定这句话不该变成一条对话消息，
 * 运行时靠它拦下所有客户端（桌面、远程浏览器）发来的同一句话。两边各写一份
 * 正则，迟早会分家。全角斜杠也认：中文输入法不问自己就会打出它。
 */
export function manualCompactionCommand(prompt: string): ManualCompactionCommand | undefined {
  const trimmed = prompt.trim();
  const slash = trimmed[0];
  if (slash !== "/" && slash !== "／") return undefined;
  const rest = trimmed.slice(1);
  if (rest.slice(0, MANUAL_COMPACTION_COMMAND.length).toLowerCase() !== MANUAL_COMPACTION_COMMAND) return undefined;
  const tail = rest.slice(MANUAL_COMPACTION_COMMAND.length);
  // `/compactify 一下` 是一句话，不是这条命令。
  if (tail && !/^\s/.test(tail)) return undefined;
  const instructions = tail.trim();
  return instructions ? { instructions } : {};
}

/** A user prompt accepted by the runtime but not started by Pi yet. */
export interface QueuedPrompt {
  id: string;
  text: string;
  promptDocument?: PromptDocument;
  images?: PromptImage[];
  queuedAt: number;
  /** The user asked this one to interject and the steer has not landed yet. */
  promoting?: boolean;
}

/**
 * 已经交给 Pi、但要等这一轮跑完才会落进对话的介入消息。
 *
 * 它既不在队列里（已经离开了），也不在记录里（还没送到），所以除非单独带着，
 * 切走一次就再也找不回来了——用户碰到的正是这个：介入还生效，界面上却没了。
 */
export interface SteeringMessage {
  id: string;
  text: string;
  promptDocument?: PromptDocument;
  images?: PromptImage[];
  timestamp: number;
}

/** A Pi custom message, carried so the UI can render it as its own card. */
export interface ChatMessageCustom {
  /** Pi `customType`, e.g. `terminal-notification`. */
  type: string;
  details?: Record<string, unknown>;
}

export interface ChatMessage {
  id: string;
  entryId?: string;
  order: number;
  role: ChatRole;
  /** Present when this message came from an extension rather than the model. */
  custom?: ChatMessageCustom;
  model?: Pick<ModelOption, "provider" | "id">;
  text: string;
  promptDocument?: PromptDocument;
  images?: PromptImage[];
  thinking?: string;
  timestamp: number;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  /** `steering` is a message Pi has accepted for the running turn but has not delivered yet. */
  status?: "queued" | "steering" | "running" | "succeeded" | "failed" | "aborted";
  /** 用户消息：之后 Agent 改过文件，编辑它重新发送时可以把那些文件退回那时的样子。 */
  checkpoint?: boolean;
}

/** 编辑一条历史消息之前问一下：代码要不要回退、回退会动到哪些文件。 */
export interface RewindPreview {
  /** 找得到这条消息。 */
  checkpoint: boolean;
  /** 这条消息之后 Agent 改过、现在和当时不一样的文件；回退就是把它们恢复原样。 */
  files: GitCommitFile[];
  /** Agent 改过但没备份下来（太大、已过期）的文件，回退时不动。 */
  skipped?: string[];
}

export interface TodoItem {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

/**
 * Status of the `/goal` loop this session is in.
 *
 * A loop that completed or was stopped is not one of these: it stops being part
 * of the session's state entirely rather than sticking around as a finished
 * status, so nothing downstream has to decide whether a goal is worth showing.
 * What happened is told by the `goal_complete` tool result in the timeline.
 */
export type GoalStatus = "running" | "paused";

export interface GoalState {
  status: GoalStatus;
  goal: string;
  /** Rounds the loop has sent so far; the first prompt is round 1. */
  iteration: number;
  startedAt: number;
  updatedAt: number;
  /** Written by the Agent when it declares the goal reached. */
  summary?: string;
  /** Last turn error; the loop keeps running and tells the Agent about it. */
  lastError?: string;
}

export type PlanApprovalStatus =
  | "pending_approval"
  | "running"
  | "delegated"
  | "completed"
  | "rejected"
  | "failed";

export type PlanExecutionTarget = "main" | "subagent";

export interface PlanApprovalState {
  id: string;
  title: string;
  /** The complete plan document. It is persisted to file without extra metadata. */
  markdown: string;
  filePath: string;
  revision: number;
  status: PlanApprovalStatus;
  createdAt: number;
  updatedAt: number;
  executionTarget?: PlanExecutionTarget;
  agentProfile?: string;
  subagentRunId?: string;
  report?: string;
  error?: string;
}

export type SubagentActivityStatus = "pending" | "running" | "completed" | "failed" | "stopped";

export interface SubagentRecentTool {
  tool: string;
  args: string;
}

export interface SubagentToolCall {
  text: string;
  expandedText?: string;
}

export interface SubagentMessage {
  role: string;
  text: string;
  thinking?: string;
}

export type SubagentTimelineEntry =
  | {
      id: string;
      order: number;
      kind: "message";
      role: string;
      text: string;
      thinking?: string;
    }
  | {
      id: string;
      order: number;
      kind: "tool";
      tool: string;
      args: string;
      expandedArgs?: string;
      output?: string;
      status: "running" | "succeeded" | "failed";
    };

export interface SubagentActivity {
  id: string;
  runId: string;
  parentToolId?: string;
  index: number;
  agent: string;
  task?: string;
  model?: string;
  status: SubagentActivityStatus;
  background: boolean;
  controlReady?: boolean;
  resumable?: boolean;
  currentTool?: string;
  currentPath?: string;
  recentTools?: SubagentRecentTool[];
  recentOutput?: string[];
  messages?: SubagentMessage[];
  toolCalls?: SubagentToolCall[];
  /** Ordered child-session events used by the read-only miniature conversation UI. */
  timeline?: SubagentTimelineEntry[];
  finalOutput?: string;
  transcriptPath?: string;
  sessionFile?: string;
  worktreePath?: string;
  toolCount: number;
  turnCount?: number;
  tokens: number;
  durationMs: number;
  error?: string;
  updatedAt: number;
  /** Durable plan that dispatched this run, when applicable. */
  planId?: string;
  /** True when the run inherited the parent session's model instead of a user-configured default. */
  modelInherited?: boolean;
}

export interface ToolRun {
  id: string;
  order: number;
  name: string;
  label: string;
  args: Record<string, unknown>;
  output: string;
  status: "running" | "succeeded" | "failed";
  startedAt: number;
  endedAt?: number;
}

export interface ResponseMetrics {
  firstTokenMs?: number;
  averageTokensPerSecond?: number;
  inputTokens?: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalMs: number;
  turnDurationMs: number;
  timestamp: number;
}

export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
  /** True when based on the rewritten request, not provider-reported usage. */
  estimated?: boolean;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/**
 * Estimated composition of the prompt that is currently visible to the
 * model. Provider usage reports the whole prompt as one input bucket, so the
 * categories below are intentionally marked as an estimate in the UI.
 */
export interface RuntimeTokenBreakdown {
  userPrompt: number;
  /** Active ordinary tool names, descriptions, and parameter schemas. */
  toolDefinitions: number;
  /** Active MCP proxy/direct tool names, descriptions, and parameter schemas. */
  mcpDefinitions: number;
  toolResults: number;
  mcpResults: number;
  systemPrompt: number;
  history: number;
  total: number;
}

export interface CacheUsageSummary {
  /** Full prompt volume. Pi exposes input/cacheRead/cacheWrite as non-overlapping buckets. */
  promptTokens: number;
  /** Tokens the cache could not serve. Writes are not counted here: they are new. */
  uncachedTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Share of the reusable prompt that came from cache. Undefined when there was none. */
  hitRate?: number;
}

/**
 * Normalize Pi's provider-independent cache buckets for display.
 *
 * Pi maps every provider onto three non-overlapping buckets: `input` is the part
 * of the prompt the cache could not serve, `cacheRead` is what it did serve, and
 * `cacheWrite` is what this request put into the cache for later.
 *
 * The hit rate is therefore `cacheRead / (cacheRead + input)`, matching what
 * other agents report. Writes stay out of the denominator on purpose: a request
 * that fills the cache is the investment that makes the next ones cheap, and
 * charging it as a miss made a healthy session look broken every time the
 * context crossed a new cache breakpoint.
 */
export function summarizeCacheUsage(
  inputTokens: number | null | undefined,
  cacheReadTokens: number | null | undefined,
  cacheWriteTokens: number | null | undefined,
): CacheUsageSummary {
  const safe = (value: number | null | undefined): number => Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
  const input = safe(inputTokens);
  const cacheRead = safe(cacheReadTokens);
  const cacheWrite = safe(cacheWriteTokens);
  // The three buckets do not overlap, so the whole prompt is their sum and a
  // hit rate is the share of it that came back from cache. Cache writes belong
  // in the denominator and in "uncached": they were paid for at full price on
  // this request, and leaving them out reports a healthy-looking rate for a
  // turn that in fact re-uploaded everything.
  const promptTokens = input + cacheRead + cacheWrite;
  return {
    promptTokens,
    uncachedTokens: input + cacheWrite,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    hitRate: promptTokens > 0 ? cacheRead / promptTokens : undefined,
  };
}

export type RuntimeSummaryKind = "compaction" | "branch_summary";
export type RuntimeSummaryStatus = "running" | "succeeded" | "failed" | "aborted";

export interface RuntimeSummaryUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost?: number;
}

export interface RuntimeSummaryEvent {
  id: string;
  kind: RuntimeSummaryKind;
  status: RuntimeSummaryStatus;
  timestamp: number;
  active: boolean;
  reason?: "manual" | "threshold" | "overflow";
  summary?: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  firstKeptEntryId?: string;
  fromId?: string;
  usage?: RuntimeSummaryUsage;
  readFiles?: string[];
  modifiedFiles?: string[];
  error?: string;
  willRetry?: boolean;
  retryAttempt?: number;
  retryMaxAttempts?: number;
}

/**
 * One batch of tool results dropped from the context.
 *
 * This is the first, cheap stage of compaction — the tool call stays, only its
 * output goes — and it used to happen with no trace anywhere in the interface.
 */
export interface ContextClearingRecord {
  at: number;
  clearedResults: number;
  freedTokens: number;
  /** Estimated size of the request after old tool results were removed. */
  projectedTokens?: number;
  contextWindow?: number;
}

export interface RuntimeInspectionSnapshot {
  sessionRevision: number;
  activeLeafId?: string;
  summaryEvents: RuntimeSummaryEvent[];
  /** Tool-result clearings this session has done, oldest first. */
  contextClearings?: ContextClearingRecord[];
  effectiveSystemPrompt?: string;
  systemPromptOverride: boolean;
  estimates: {
    systemPrompt?: number;
    toolDefinitions?: number;
    messages?: number;
    total?: number;
  };
  /** Cache-read share of the latest completed model request, not a lifetime average. */
  cacheHitRate?: number;
  /** This session's model responses, added up. Context compaction is deliberately left out. */
  cache?: CacheUsageSummary;
  /** Estimated composition of the prompt currently sent to the model. */
  tokenBreakdown?: RuntimeTokenBreakdown;
  tools: RuntimeToolDefinition[];
  skills: RuntimeSkillState[];
  mcp?: McpRuntimeStatus;
  memory?: ProjectMemoryRuntimeStatus;
  /** User-configured default models for the built-in subagent profiles. */
  subagent?: SubagentConfiguration;
  /** 会话自动命名用哪个模型；空表示跟随会话当前模型。 */
  sessionNaming?: SessionNamingConfiguration;
  /** 压缩和分支摘要用哪个模型；空就是会话当前的那个。 */
  summarizationModel?: SummarizationModelConfiguration;
  capabilities: {
    editSystemPrompt: boolean;
    removeOriginalSessionItems: false;
    removeOriginalSessionItemsReason: string;
  };
}

export interface RuntimeToolDefinition {
  name: string;
  description: string;
  source: string;
  active: boolean;
  /** Built-in/workflow tool or MCP-provided tool. */
  category?: "tool" | "mcp";
  estimatedTokens: number;
}

export interface RuntimeSkillState {
  name: string;
  description: string;
  filePath: string;
  source: SkillSource;
  globallyEnabled: boolean;
  sessionEnabled: boolean;
  publishedToModel: boolean;
  readInSession: boolean;
  estimatedMetadataTokens: number;
}

export interface ProjectMemoryRuntimeStatus {
  cwd: string;
  updatedAt: number;
  attemptId?: string;
  state: "idle" | "running" | "busy" | "succeeded" | "failed" | "disabled";
  source: "startup" | "prompt" | "manual" | "automatic";
  exists: boolean;
  injected: boolean;
  projectRoot?: string;
  projectName?: string;
  memoryFile?: string;
  projectMemoryDir?: string;
  contentChars?: number;
  estimatedTokens?: number;
  content?: string;
  sessionFile?: string;
  processedSessions: string[];
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  message?: string;
  error?: string;
}

export interface MemorySettings {
  version: 1;
  projectMaxChars: number;
  globalMaxChars: number;
  generationRules: string;
  autoSummarize: boolean;
  /** 自动整理的间隔轮数：累计这么多轮回复后，后台才检查一次记忆。 */
  summarizeEveryTurns: number;
  globalEnabled: boolean;
  projectEnabled: boolean;
}

export interface MemoryDocumentSnapshot {
  scope: "global" | "project";
  /** `entry` is one memory body file; `index` is the file that lists them. */
  kind?: "index" | "entry";
  label: string;
  filePath: string;
  directory: string;
  exists: boolean;
  content: string;
  contentChars: number;
  maxChars: number;
  projectRoot?: string;
  projectName?: string;
}

export interface MemoryConfigurationSnapshot {
  settings: MemorySettings;
  settingsFile: string;
  storageRoot: string;
  global: MemoryDocumentSnapshot;
  /** The open project's memory, which is also the entry for it in `projects`. */
  project?: MemoryDocumentSnapshot;
  /** Every project the memory store holds, sorted by name, open project included. */
  projects: MemoryDocumentSnapshot[];
  /** Turns counted for the open project since the last background summary ran. */
  turnsSinceSummary: number;
}

export interface SaveMemoryConfigurationInput {
  settings: MemorySettings;
  globalContent: string;
  projectContent?: string;
  /** Edits to any listed project memory. A path the store did not list is rejected. */
  projectContents?: Array<{ filePath: string; content: string }>;
}

/** Built-in subagent profiles whose default models can be configured independently. */
export type ConfigurableSubagentProfile = "explore" | "worker" | "reviewer";

/** User-configured model for each built-in subagent profile. */
export interface SubagentProfileModels {
  /** `provider/model-id`, or empty to inherit the parent session's model. */
  explore: string;
  /** `provider/model-id`, or empty to inherit the parent session's model. */
  worker: string;
  /** `provider/model-id`, or empty to inherit the parent session's model. */
  reviewer: string;
}

/**
 * 会话自动命名用哪个模型。
 *
 * 空字符串表示用会话当前的模型——命名只是一次很小的请求，多数时候没必要单独配；
 * 想让它跑在便宜模型上的人再去配。
 */
export interface SessionNamingConfiguration {
  model: string;
}

export interface SessionNamingConfigurationInput {
  model: string;
}

/**
 * 上下文总结（压缩、回溯时的分支摘要）跑在哪个模型上。
 *
 * 空字符串表示跟随会话当前的模型。总结是一发独立的、反复发生的大请求，主对话跑在
 * 贵模型上的时候，很多人愿意让它跑在便宜模型上。
 */
export interface SummarizationModelConfiguration {
  model: string;
  /** 配了但现在找不到（模型被删、凭证没了）：总结已经回退到会话模型在跑。 */
  unavailable?: boolean;
}

export interface SummarizationModelConfigurationInput {
  model: string;
}

/** User-configured default models for dispatched subagents. */
export interface SubagentConfiguration {
  models: SubagentProfileModels;
}

export interface SubagentConfigurationInput {
  models: SubagentProfileModels;
}

export interface TerminalRun {
  id: string;
  command: string;
  cwd: string;
  output: string;
  status: "running" | "succeeded" | "failed" | "stopped";
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
}

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  additions: number;
  deletions: number;
  patch?: string;
}

/** 一个文件在暂存区或工作区里的状态；`undefined` 表示那一侧没有改动。 */
export type GitFileState = "modified" | "added" | "deleted" | "renamed" | "copied" | "type-changed" | "untracked" | "conflicted";

export interface GitFileChange {
  /** 相对仓库根目录的路径。 */
  path: string;
  /** 改名 / 复制前的路径。 */
  originalPath?: string;
  staged?: GitFileState;
  unstaged?: GitFileState;
}

export interface GitStatus {
  /** 这个工作区不在 git 仓库里时为 false，其余字段都没有意义。 */
  repository: boolean;
  root?: string;
  /** 当前分支；分离 HEAD 时是 undefined。 */
  branch?: string;
  detached: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  /** 仓库里一个提交都还没有。 */
  unborn: boolean;
  /** HEAD 指向的提交；还没有提交时是 undefined。 */
  head?: string;
  /**
   * 改动（最多 GIT_STATUS_LIMIT 条）。未跟踪的文件按文件夹聚合：一整个没被跟踪的
   * 文件夹只算一条，路径以 `/` 结尾——和 git 自己默认的显示方式一样。
   */
  files: GitFileChange[];
  /** 一共有多少条改动；比 files 多时就是 truncated。 */
  total: number;
  truncated: boolean;
}

/** 工作区里找到的一个 git 仓库：工作区本身所在的，或者子文件夹里的。 */
export interface GitRepository {
  root: string;
  /** 相对工作区的路径；工作区本身所在的仓库是 `.`。 */
  name: string;
}

export interface GitBranch {
  name: string;
  upstream?: string;
  current: boolean;
}

export interface GitDiff {
  path: string;
  staged: boolean;
  /** 看的是某个历史提交里的改动时，那个提交的哈希。 */
  commit?: string;
  patch: string;
  binary: boolean;
  truncated: boolean;
}

/** 指向一个提交的引用。`fullName` 是 `refs/heads/main` 这种完整名字。 */
export interface GitCommitRef {
  name: string;
  fullName: string;
  kind: "branch" | "remote" | "tag" | "head";
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  /** 第一个是主线父提交；合并提交有多个，根提交没有。 */
  parents: string[];
  author: string;
  email: string;
  /** 作者时间，毫秒。 */
  date: number;
  subject: string;
  /** 提交说明除了标题以外的部分。 */
  body: string;
  refs: GitCommitRef[];
}

export interface GitLog {
  /** 按拓扑顺序排，子提交一定在父提交前面。 */
  commits: GitCommit[];
  /** 后面还有更早的提交。 */
  hasMore: boolean;
  head?: string;
  /** 当前分支和它的上游的完整引用名，给图上的线配色用。 */
  currentRef?: string;
  upstreamRef?: string;
}

/** 一个历史提交里改了的文件（和第一个父提交比）。 */
export interface GitCommitFile {
  path: string;
  originalPath?: string;
  state: GitFileState;
}

export type GitAction =
  | { op: "status" }
  | { op: "diff"; path: string; staged: boolean }
  | { op: "stage"; paths: string[] }
  | { op: "unstage"; paths: string[] }
  /** 丢弃工作区里的改动；未跟踪的文件会被删除。暂存区不动。 */
  | { op: "discard"; paths: string[] }
  /** `stageAll`：暂存区是空的就先把所有改动暂存再提交。 */
  | { op: "commit"; message: string; stageAll?: boolean }
  /** 整个仓库一起暂存 / 取消暂存 / 丢弃（不按列表里的条目，列表可能被截断）。 */
  | { op: "stage_all" }
  | { op: "unstage_all" }
  | { op: "discard_all" }
  | { op: "push" }
  | { op: "pull" }
  | { op: "branches" }
  /** 工作区本身所在的仓库，加上子文件夹里找到的仓库。cwd 是工作区。 */
  | { op: "repositories" }
  | { op: "checkout"; branch: string }
  | { op: "create_branch"; name: string }
  /** 提交历史：默认是当前分支和它的上游，`all` 时是所有分支和标签。 */
  | { op: "log"; limit?: number; all?: boolean }
  | { op: "commit_files"; hash: string }
  | { op: "commit_diff"; hash: string; path: string; originalPath?: string };

export interface FileNode {
  name: string;
  path: string;
  kind: "file" | "directory";
  children?: FileNode[];
}

export interface ProjectSnapshot {
  cwd: string;
  files: FileNode[];
  changes: ChangedFile[];
  /** 读 git 改动失败了（和「确实没有改动」区分开）；有值时 changes 不可信。 */
  changesError?: string;
  terminals: TerminalRun[];
  plan: TodoItem[];
  planApproval?: PlanApprovalState;
  refreshedAt: number;
}

/**
 * Result of relocating one session to another workspace. Both session lists are
 * returned because the sidebar shows the source and the target at the same time.
 */
export interface MoveSessionResult {
  sessions: SessionSummary[];
  targetSessions: SessionSummary[];
  session: SessionSummary;
}

export interface SessionSnapshot {
  runtimeId?: string;
  /** Monotonic within one live runtime; prevents an older async snapshot from replacing newer message events. */
  messageRevision?: number;
  session: SessionSummary;
  /** Fixed when the session is created; changing modes requires a new session. */
  agentMode: AgentMode;
  messages: ChatMessage[];
  promptQueue: QueuedPrompt[];
  /** 已交给 Pi、等这一轮结束才会落地的介入消息；切换会话后要靠它把界面恢复回来。 */
  steering: SteeringMessage[];
  tools: ToolRun[];
  subagents: SubagentActivity[];
  project: ProjectSnapshot;
  model?: Pick<ModelOption, "provider" | "id" | "name" | "reasoning">;
  /** Present when the user changed models while the current agent turn was busy. */
  pendingModel?: PendingSessionModel;
  thinkingLevel: ThinkingLevel;
  fast: boolean;
  /** Present while this session is in a `/goal` loop; absent once it ends. */
  goal?: GoalState;
  /** A stop was delivered; the turn is winding down and may still be finishing a tool. */
  aborting?: boolean;
  responseMetrics?: ResponseMetrics;
  responseMetricsHistory: ResponseMetrics[];
  contextUsage?: ContextUsage;
  tokenUsage: TokenUsage;
  runtimeInspection: RuntimeInspectionSnapshot;
  running: boolean;
}

export interface RuntimeBootstrap {
  configuration: RuntimeConfiguration;
  activeSession?: SessionSnapshot;
}

/** Returned by `open_workspace`: the session list and the currently opened snapshot, if any. */
export interface WorkspaceSnapshot {
  sessions: SessionSummary[];
  snapshot?: SessionSnapshot;
}

export type RuntimeCommand =
  | { type: "bootstrap" }
  | { type: "get_configuration" }
  | { type: "get_openai_responses_ws_configuration" }
  | { type: "save_openai_responses_ws_configuration"; input: OpenAIResponsesWsConfigurationInput }
  | { type: "get_model_provider_configuration" }
  | { type: "save_model_provider_configuration"; input: ModelProviderConfigurationInput }
  | { type: "remove_model_provider_configuration"; provider: string }
  | {
      /** Update the default used by future sessions. This never mutates a live session. */
      type: "configure_model";
      provider: string;
      modelId: string;
      thinkingLevel: ThinkingLevel;
      /** CoilCoil-private context limit override for this provider/model. */
      contextWindow?: number;
      apiKey?: string;
    }
  | {
      /** Change one existing session; a busy turn queues the choice for the next prompt. */
      type: "set_session_model";
      provider: string;
      modelId: string;
      thinkingLevel: ThinkingLevel;
      contextWindow?: number;
    }
  | { type: "set_session_fast"; enabled: boolean }
  | { type: "set_tool_purpose_audit_enabled"; enabled: boolean }
  | { type: "remove_provider_auth"; provider: string }
  | { type: "start_model_provider_oauth"; provider: string }
  | { type: "respond_model_provider_oauth"; flowId: string; promptId: string; value: string }
  | { type: "cancel_model_provider_oauth"; flowId: string }
  | { type: "fetch_provider_models"; input: FetchProviderModelsInput }
  | { type: "test_provider_connection"; input: TestProviderConnectionInput }
  | { type: "get_mcp_configuration"; cwd?: string }
  | { type: "get_mcp_json" }
  | { type: "save_mcp_json"; content: string; cwd?: string }
  | { type: "get_mcp_status" }
  | { type: "save_mcp_server"; server: McpServerConfiguration; previousName?: string; cwd?: string }
  | { type: "remove_mcp_server"; name: string; scope?: "global" | "project"; cwd?: string }
  | { type: "set_mcp_server_enabled"; name: string; enabled: boolean; cwd: string }
  | { type: "enable_mcp_imports"; imports: McpImportConfiguration["kind"][]; cwd?: string }
  | { type: "discover_mcp_servers"; cwd?: string }
  | { type: "import_mcp_servers"; input: ImportMcpServersInput }
  | { type: "connect_mcp_server"; name: string }
  | { type: "start_mcp_auth"; name: string }
  | { type: "await_mcp_auth"; name: string }
  /** 浏览器回调已经到手，换令牌并重连——和上面那步分开，界面才说得出自己在等什么。 */
  | { type: "finish_mcp_auth"; name: string }
  | { type: "cancel_mcp_auth"; name: string }
  | { type: "complete_mcp_auth"; name: string; input: string }
  | { type: "logout_mcp_server"; name: string }
  | { type: "get_memory_configuration"; cwd?: string }
  | { type: "save_memory_configuration"; input: SaveMemoryConfigurationInput; cwd?: string }
  | { type: "get_subagent_configuration" }
  | { type: "get_session_naming_configuration" }
  | { type: "get_summarization_model_configuration" }
  | { type: "save_summarization_model_configuration"; input: SummarizationModelConfigurationInput }
  | { type: "save_subagent_configuration"; input: SubagentConfigurationInput }
  | { type: "save_session_naming_configuration"; input: SessionNamingConfigurationInput }
  | { type: "get_skill_configuration"; cwd?: string }
  | { type: "set_skill_enabled"; filePath: string; enabled: boolean; cwd?: string }
  | { type: "remove_skill"; filePath: string; cwd?: string }
  | { type: "delete_skill"; filePath: string; cwd?: string }
  | { type: "add_skill_path"; path: string; cwd?: string }
  | { type: "remove_skill_path"; path: string; cwd?: string }
  | { type: "set_enable_skill_commands"; enabled: boolean; cwd?: string }
  | { type: "get_runtime_inspection" }
  | { type: "set_session_system_prompt"; prompt?: string }
  | { type: "set_session_skill_enabled"; filePath: string; enabled: boolean }
  | { type: "set_session_mcp_server_enabled"; name: string; enabled: boolean }
  | { type: "approve_plan"; planId: string; target: PlanExecutionTarget; agent?: string }
  | { type: "reject_plan"; planId: string }
  | { type: "run_memory_now" }
  /** 手动压缩上下文（`/compact`）；`instructions` 是用户对这份摘要的额外要求。 */
  | { type: "run_compaction_now"; instructions?: string }
  | { type: "remove_original_session_item"; entryId: string }
  | { type: "stop_subagent"; id: string; background: boolean }
  | { type: "resume_subagent"; id: string }
  | { type: "list_sessions"; cwd: string }
  | { type: "list_archived_sessions"; cwd: string }
  | { type: "archive_session"; cwd: string; sessionPath: string }
  | { type: "delete_session"; cwd: string; sessionPath: string }
  | { type: "delete_workspace_sessions"; cwd: string }
  | { type: "restore_session"; cwd: string; sessionPath: string }
  | { type: "rename_session"; cwd: string; sessionPath: string; name: string }
  | { type: "pin_session"; cwd: string; sessionPath: string; pinned: boolean }
  | { type: "fork_session"; cwd: string; sessionPath: string }
  | { type: "move_session"; cwd: string; sessionPath: string; targetCwd: string }
  | { type: "create_session"; cwd: string; model?: SessionModelSelection; agentMode?: AgentMode }
  | { type: "open_session"; cwd: string; sessionPath: string }
  | { type: "open_workspace"; cwd: string }
  | { type: "prompt"; text: string; promptDocument?: PromptDocument; images?: PromptImage[]; clientMessageId?: string }
  /** `restoreCode`：先把工作区退回这条消息发出时的检查点，再重新发送。 */
  | { type: "rewind_prompt"; entryId: string; text: string; promptDocument?: PromptDocument; images?: PromptImage[]; clientMessageId?: string; restoreCode?: boolean }
  | { type: "rewind_preview"; entryId: string }
  | { type: "steer"; text: string; promptDocument?: PromptDocument; images?: PromptImage[]; clientMessageId?: string }
  | { type: "abort" }
  | { type: "stop_goal" }
  | { type: "cancel_queued_prompt"; id: string }
  | { type: "promote_queued_prompt"; id: string }
  | { type: "refresh_project" }
  /** 工作区的 git 操作。不属于任何会话，结果类型见 GitAction 各分支的说明。 */
  | { type: "git"; cwd: string; action: GitAction }
  | { type: "list_directory"; path: string }
  | { type: "read_file"; path: string; maxBytes?: number };

export type RuntimeEvent =
  | { type: "runtime_ready"; configuration: RuntimeConfiguration }
  | { type: "configuration_updated"; configuration: RuntimeConfiguration }
  | { type: "model_provider_auth_updated"; state: ModelProviderAuthState }
  | { type: "sessions_updated"; cwd: string; sessions: SessionSummary[] }
  | { type: "session_snapshot"; snapshot: SessionSnapshot }
  | { type: "session_fast_updated"; fast: boolean }
  | { type: "prompt_queue_updated"; queue: QueuedPrompt[]; revision: number }
  | { type: "message_started"; message: ChatMessage; revision: number }
  | { type: "message_delta"; id: string; field: "text" | "thinking"; delta: string; revision: number }
  | { type: "message_finished"; message: ChatMessage; revision: number }
  /** `text` is present when the runtime is handing the message back for the composer to keep. */
  | { type: "message_rejected"; id: string; revision: number; text?: string; promptDocument?: PromptDocument }
  /** A steered message Pi took for the running turn; it lands when the turn ends. */
  | { type: "message_steering"; id: string; text: string; promptDocument?: PromptDocument; images?: PromptImage[]; timestamp: number; revision: number }
  | { type: "tool_started"; tool: ToolRun }
  | { type: "tool_updated"; tool: ToolRun }
  | { type: "tool_finished"; tool: ToolRun }
  | { type: "plan_updated"; plan: TodoItem[] }
  | { type: "plan_approval_updated"; plan?: PlanApprovalState }
  | { type: "goal_updated"; goal?: GoalState }
  | { type: "subagents_updated"; subagents: SubagentActivity[] }
  | { type: "project_updated"; project: ProjectSnapshot }
  | {
      type: "metrics_updated";
      responseMetrics?: ResponseMetrics;
      responseMetricsHistory: ResponseMetrics[];
      contextUsage?: ContextUsage;
      tokenUsage: TokenUsage;
    }
  /**
   * The upstream dropped the turn and the runtime is retrying it.
   *
   * Retries used to be silent, so an unstable provider looked like the Agent
   * randomly stopping. `delayMs` is how long the wait before this attempt is.
   */
  | { type: "agent_retry"; attempt: number; maxAttempts: number; delayMs: number; message: string }
  | { type: "agent_retry_finished"; success: boolean; attempt: number; error?: string }
  | { type: "runtime_inspection_updated"; inspection: RuntimeInspectionSnapshot }
  | { type: "runtime_notice"; level: "info" | "success" | "error"; message: string }
  | { type: "run_state"; running: boolean; aborting?: boolean }
  | { type: "runtime_released" }
  | { type: "runtime_error"; message: string; detail?: string };

export interface RuntimeCommandEnvelope {
  id: string;
  runtimeId?: string;
  command: RuntimeCommand;
}

export interface RuntimeResponseEnvelope {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface RuntimeEventEnvelope {
  runtimeId?: string;
  event: RuntimeEvent;
}

export type ScopedRuntimeEvent = RuntimeEventEnvelope;

export type RuntimeWireMessage = RuntimeResponseEnvelope | RuntimeEventEnvelope;

export function isRuntimeCommandEnvelope(value: unknown): value is RuntimeCommandEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RuntimeCommandEnvelope>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.command === "object" &&
    candidate.command !== null &&
    typeof (candidate.command as { type?: unknown }).type === "string"
  );
}

export function isRuntimeEventEnvelope(value: unknown): value is RuntimeEventEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "event" in value &&
    typeof (value as RuntimeEventEnvelope).event?.type === "string"
  );
}

export const SESSION_OPEN_SUPERSEDED_ERROR = "COILCOIL_SESSION_OPEN_SUPERSEDED";

/**
 * Which process a diagnostic entry came from.
 *
 * CoilCoil runs as three: the Electron main process, the Renderer, and the
 * runtime child that owns Pi. A symptom the user can see — a stop that seems
 * ignored, a composer still spinning — is usually the seam between two of them,
 * so an entry is only useful next to the entries from the other two.
 */
export type DiagnosticProcess = "main" | "renderer" | "runtime";

export type DiagnosticLevel = "debug" | "info" | "warn" | "error";

export interface DiagnosticLogEntry {
  /** Epoch milliseconds. The only key that orders entries across processes. */
  ts: number;
  level: DiagnosticLevel;
  process: DiagnosticProcess;
  /** Area this belongs to, e.g. `run-state`, `prompt-queue`, `abort`. */
  scope: string;
  /** What happened, in the past tense and stable enough to grep for. */
  event: string;
  /** Which session runtime this concerns, when it concerns one. */
  runtimeId?: string;
  sessionPath?: string;
  /** Structured detail. Must survive JSON.stringify and carry no secrets. */
  data?: Record<string, unknown>;
  /** Present on errors: the message and, where we have one, the stack. */
  error?: { message: string; stack?: string };
}

/** A batch of Renderer entries on its way to the process that owns the file. */
export interface DiagnosticLogBatch {
  entries: DiagnosticLogEntry[];
}
