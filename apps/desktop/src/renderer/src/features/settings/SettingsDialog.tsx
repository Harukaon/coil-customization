import { Activity, ArrowLeft, ClipboardPaste, Compass, FileJson, Keyboard, LoaderCircle, LogOut, Network, Palette, Plus, Power, RefreshCw, Settings, Smartphone, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, FormEvent, PointerEvent as ReactPointerEvent } from "react";
import type {
  McpConfigurationSnapshot,
  McpActionResult,
  McpRuntimeStatus,
  McpServerConfiguration,
  McpServerRuntimeStatus,
  RuntimeConfiguration,
} from "@coilcoil/runtime-protocol";
import { parseMcpServerSnippets } from "@coilcoil/runtime-protocol";
import { Select, type SelectOption } from "../../ui/Select";
import { toastError, toastSuccess } from "../../ui/toast";
import { mcpEnablementClass, mcpEnablementLabel, mcpMountBadge, isMountedMcpServer, mcpOriginLabel } from "../runtime/mcpPolicy";
import { ModelSettings } from "./ModelSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { McpAuthDialog } from "./McpAuthDialog";
import {
  mcpAuthFlowCallbackReceived,
  mcpAuthFlowFailed,
  mcpAuthFlowFromStart,
  mcpAuthFlowStarted,
  mcpAuthFlowSucceeded,
  type McpAuthFlowState,
  failureNeedsReauthorization,
} from "./mcpAuthPresentation";
import { McpDiscoveryDialog } from "./McpDiscoveryDialog";
import { McpJsonEditor } from "./McpJsonEditor";
import { useMobileRemote } from "../../hooks/useMobileRemote";
import { platformComputerLabel, rendererPlatform } from "../../platform";
import { RemoteSettings } from "./RemoteSettings";
import { ShortcutSettings } from "./ShortcutSettings";
import { SkillSettings } from "./SkillSettings";
import "./settings.css";
import { Checkbox, Field, TextArea, TextField } from "../../ui/form";

/** Keep in step with the sidebar width in mobile.css. */
const SETTINGS_MOBILE_SIDEBAR_WIDTH = 220;

type SettingsSection = "models" | "mcp" | "skills" | "shortcuts" | "remote" | "appearance";
const MASKED_SECRET_VALUE = "••••••";
const SETTINGS_SIDEBAR_WIDTH_KEY = "coilcoil.settings-sidebar-width";
const DEFAULT_SETTINGS_SIDEBAR_WIDTH = 220;
const MINIMUM_SETTINGS_SIDEBAR_WIDTH = 160;
const MAXIMUM_SETTINGS_SIDEBAR_WIDTH = 360;
const MCP_SCOPE_OPTIONS: SelectOption[] = [
  { value: "global", label: "全局" },
  { value: "project", label: "当前项目" },
];
const MCP_TRANSPORT_OPTIONS: SelectOption[] = [
  { value: "stdio", label: "stdio 命令" },
  { value: "http", label: "HTTP" },
];
const MCP_AUTH_OPTIONS: SelectOption[] = [
  { value: "auto", label: "自动检测" },
  { value: "oauth", label: "OAuth" },
  { value: "bearer", label: "Bearer" },
  { value: "false", label: "不认证" },
];
const MCP_LIFECYCLE_OPTIONS: SelectOption[] = [
  { value: "lazy", label: "按需连接" },
  { value: "keep-alive", label: "保持连接" },
  { value: "eager", label: "启动时连接" },
];

function storedSettingsSidebarWidth(): number {
  const value = Number(window.localStorage.getItem(SETTINGS_SIDEBAR_WIDTH_KEY));
  return Number.isFinite(value) && value >= MINIMUM_SETTINGS_SIDEBAR_WIDTH
    ? Math.min(MAXIMUM_SETTINGS_SIDEBAR_WIDTH, value)
    : DEFAULT_SETTINGS_SIDEBAR_WIDTH;
}

function blankMcpServer(): McpServerConfiguration {
  return {
    name: "",
    scope: "global",
    transport: "stdio",
    args: [],
    env: {},
    headers: {},
    lifecycle: "lazy",
    exposeResources: true,
    directTools: false,
    excludeTools: [],
    debug: false,
    disabled: false,
  };
}

function sensitiveConfigurationKey(key: string): boolean {
  return /(?:authorization|api[-_]?key|token|secret|password|cookie|credential)/i.test(key);
}

function maskedStringMap(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sensitiveConfigurationKey(key) && entry ? MASKED_SECRET_VALUE : entry]));
}

function parseStringMap(value: string, label: string, original: Record<string, string> = {}): Record<string, string> {
  const trimmed = value.trim();
  if (!trimmed) return {};
  const parsed: unknown = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((item) => typeof item !== "string")) {
    throw new Error(`${label}必须是字符串键值的 JSON 对象。`);
  }
  return Object.fromEntries(Object.entries(parsed as Record<string, string>).map(([key, entry]) => [
    key,
    entry === MASKED_SECRET_VALUE && Object.hasOwn(original, key) ? original[key] : entry,
  ]));
}

function McpSettings({ runtimeId, cwd, reloadKey = 0 }: { runtimeId?: string; cwd?: string; reloadKey?: number }): React.JSX.Element {
  const [configuration, setConfiguration] = useState<McpConfigurationSnapshot>();
  const [selectedName, setSelectedName] = useState<string>();
  const [draft, setDraft] = useState<McpServerConfiguration>(blankMcpServer);
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("{}");
  const [headersText, setHeadersText] = useState("{}");
  const [snippetOpen, setSnippetOpen] = useState(false);
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [snippetText, setSnippetText] = useState("");
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<string>();
  const [originalEnv, setOriginalEnv] = useState<Record<string, string>>({});
  const [originalHeaders, setOriginalHeaders] = useState<Record<string, string>>({});
  const [directToolsText, setDirectToolsText] = useState("");
  const [excludeToolsText, setExcludeToolsText] = useState("");
  const [loading, setLoading] = useState(true);
  const [statusLoading, setStatusLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<{ server: string; ok: boolean; text: string }>();
  const [togglingEnabled, setTogglingEnabled] = useState(false);
  const [removeArmed, setRemoveArmed] = useState(false);
  const [listRemoveArmed, setListRemoveArmed] = useState<string>();
  const [runtimeStatus, setRuntimeStatus] = useState<McpRuntimeStatus>();
  const [authFlow, setAuthFlow] = useState<McpAuthFlowState>();
  const editVersionRef = useRef(0);
  const loadVersionRef = useRef(0);

  /**
   * Fill the form from a pasted configuration.
   *
   * What people have to hand is whatever a README or another app showed them,
   * which is usually a bare server object with no name. Everything it carries
   * lands in the form, and the pi-specific choices - scope, lifecycle, auth -
   * stay where they are, to be set here afterwards.
   */
  const applySnippet = (): void => {
    const result = parseMcpServerSnippets(snippetText);
    if (!result.ok) {
      toastError(result.error);
      return;
    }
    const [snippet, ...rest] = result.servers;
    if (!snippet) return;
    setDraft((current) => ({
      ...current,
      name: snippet.name ?? current.name,
      transport: snippet.transport,
      command: snippet.transport === "stdio" ? snippet.command ?? "" : undefined,
      url: snippet.transport === "http" ? snippet.url ?? "" : undefined,
      cwd: snippet.cwd,
    }));
    setArgsText(snippet.args.join("\n"));
    setEnvText(JSON.stringify(snippet.env, null, 2));
    setHeadersText(JSON.stringify(snippet.headers, null, 2));
    // Pasted secrets are the real values, so the masking table must forget what
    // it held for the server that was on screen a moment ago.
    setOriginalEnv({});
    setOriginalHeaders({});
    setSnippetOpen(false);
    setSnippetText("");
    toastSuccess(rest.length
      ? `已填入「${snippet.name ?? "未命名"}」，另外 ${rest.length} 个服务器请分别粘贴。`
      : snippet.name ? `已填入「${snippet.name}」，确认后保存。` : "已填入配置，请补一个名称后保存。");
  };

  /**
   * Ask the server itself whether the address and headers are right.
   *
   * "Failed to connect" is the same message for a wrong URL, a rejected key and
   * a server that is down. The handshake reply usually names the problem, so it
   * is shown verbatim rather than summarised into another vague sentence.
   */
  const probeConnection = async (): Promise<void> => {
    setProbing(true);
    setProbeResult(undefined);
    try {
      const headers = parseStringMap(headersText, "请求头", originalHeaders);
      const result = await window.coilcoil.testMcpConnection({ url: draft.url ?? "", headers });
      if (!result.ok) {
        setProbeResult(`连接失败：${result.error}`);
        return;
      }
      const healthy = result.status >= 200 && result.status < 300;
      setProbeResult(`HTTP ${result.status} ${result.statusText}${healthy ? "" : " · 服务器拒绝了这次握手"}${result.body ? `\n${result.body}` : ""}`);
    } catch (caught) {
      setProbeResult(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setProbing(false);
    }
  };

  const selectServer = (server?: McpServerConfiguration, userInitiated = false): void => {
    if (userInitiated) editVersionRef.current += 1;
    const next = server ? { ...server, args: [...server.args], env: { ...server.env }, headers: { ...server.headers } } : blankMcpServer();
    setSelectedName(server?.name);
    setDraft(next);
    setArgsText(next.args.join("\n"));
    setOriginalEnv({ ...next.env });
    setOriginalHeaders({ ...next.headers });
    setEnvText(JSON.stringify(maskedStringMap(next.env), null, 2));
    setHeadersText(JSON.stringify(maskedStringMap(next.headers), null, 2));
    setDirectToolsText(Array.isArray(next.directTools) ? next.directTools.join("\n") : "");
    setExcludeToolsText(next.excludeTools.join("\n"));
    setProbeResult(undefined);
    setCheckResult(undefined);
    setRemoveArmed(false);
    setListRemoveArmed(undefined);
  };

  /**
   * Ask the runtime for live status, with or without a runtimeId.
   *
   * Settings opened from the home screen has no conversation to name, and this
   * used to bail out on that alone — leaving every status blank and every action
   * greyed out. The runtime already falls back to the last session it served, so
   * the request is sent either way and its own error is what gets reported.
   */
  const loadStatus = async (surfaceError = false): Promise<void> => {
    setStatusLoading(true);
    try {
      setRuntimeStatus(await window.coilcoil.request<McpRuntimeStatus>({ type: "get_mcp_status" }, runtimeId));
    } catch (caught) {
      setRuntimeStatus(undefined);
      if (surfaceError) toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStatusLoading(false);
    }
  };

  const load = async (): Promise<void> => {
    const loadVersion = ++loadVersionRef.current;
    const editVersion = editVersionRef.current;
    setLoading(true);
    try {
      const next = await window.coilcoil.request<McpConfigurationSnapshot>({ type: "get_mcp_configuration", cwd }, runtimeId);
      if (loadVersion !== loadVersionRef.current) return;
      setConfiguration(next);
      if (editVersion === editVersionRef.current) {
        const selected = next.servers.find((server) => server.name === selectedName) ?? next.servers[0];
        selectServer(selected);
      }
    } catch (caught) {
      if (loadVersion !== loadVersionRef.current) return;
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (loadVersion === loadVersionRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    void loadStatus();
  }, [cwd, runtimeId, reloadKey]);

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    try {
      const server: McpServerConfiguration = {
        ...draft,
        name: draft.name.trim(),
        command: draft.command?.trim() || undefined,
        url: draft.url?.trim() || undefined,
        cwd: draft.cwd?.trim() || undefined,
        args: argsText.split("\n").map((item) => item.trim()).filter(Boolean),
        env: parseStringMap(envText, "环境变量", originalEnv),
        headers: parseStringMap(headersText, "请求头", originalHeaders),
        bearerTokenEnv: draft.bearerTokenEnv?.trim() || undefined,
        idleTimeout: draft.idleTimeout === undefined || Number.isNaN(draft.idleTimeout) ? undefined : draft.idleTimeout,
        requestTimeoutMs: draft.requestTimeoutMs === undefined || Number.isNaN(draft.requestTimeoutMs) ? undefined : draft.requestTimeoutMs,
        directTools: directToolsText.trim() ? directToolsText.split("\n").map((item) => item.trim()).filter(Boolean) : draft.directTools === true,
        excludeTools: excludeToolsText.split("\n").map((item) => item.trim()).filter(Boolean),
      };
      const next = await window.coilcoil.request<McpConfigurationSnapshot>({ type: "save_mcp_server", server, previousName: selectedName, cwd }, runtimeId);
      setConfiguration(next);
      selectServer(next.servers.find((item) => item.name === server.name));
      void loadStatus();
      toastSuccess("已保存 MCP 服务器。");
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const applyActionResult = (result: McpActionResult): void => {
    if (result.status) setRuntimeStatus(result.status);
    const detailsError = typeof result.details?.error === "string" ? result.details.error : undefined;
    if (detailsError) {
      toastError(typeof result.details?.message === "string" ? result.details.message : detailsError);
      return;
    }
    toastSuccess(result.text || "MCP 扩展已完成操作。");
  };

  const actionErrorMessage = (result: McpActionResult): string | undefined => {
    const error = typeof result.details?.error === "string" ? result.details.error : undefined;
    if (!error) return undefined;
    return typeof result.details?.message === "string" ? result.details.message : error;
  };

  /**
   * Reconnect with the credential that was just saved.
   *
   * A token nobody connects with looks to the user exactly like a failed
   * login, so this runs on both completion paths and never blocks them.
   */
  const connectAfterAuth = async (server: string): Promise<void> => {
    try {
      const result = await window.coilcoil.request<McpActionResult>({ type: "connect_mcp_server", name: server }, runtimeId);
      if (result.status) setRuntimeStatus(result.status);
    } catch {
      // The status refresh below reports whatever the connection settles on.
    }
  };

  /**
   * Take one MCP server through its browser authorization.
   *
   * `start_mcp_auth` arms the runtime's waiter on pi's loopback listener before
   * it answers, so the browser is opened only after that reply lands — an
   * approval that comes back sooner than the reply would otherwise arrive with
   * nobody listening, which is exactly how the redirect used to get lost. Once
   * the browser is open this parks on `await_mcp_auth` until the redirect is
   * captured and the token exchange is done.
   */
  const runAuth = async (server: string): Promise<void> => {
    const started = mcpAuthFlowStarted(server);
    setAuthFlow(started);
    setActionBusy(true);
    try {
      const startResult = await window.coilcoil.request<McpActionResult>({ type: "start_mcp_auth", name: server }, runtimeId);
      if (startResult.status) setRuntimeStatus(startResult.status);
      const waiting = mcpAuthFlowFromStart(started, startResult);
      setAuthFlow((current) => current?.server === server ? waiting : current);
      if (waiting.phase !== "waiting" || !waiting.authorizationUrl) return;
      await window.coilcoil.openExternal(waiting.authorizationUrl);
      if (!waiting.awaitingCallback) return;
      // 两步，不是一步：浏览器回来就先把话说对，再去换令牌和重连。合成一步的时候，
      // 这两件事的几秒钟全挂在「等待浏览器完成授权…」下面。
      await window.coilcoil.request<McpActionResult>({ type: "await_mcp_auth", name: server }, runtimeId);
      setAuthFlow((current) => current?.server === server ? mcpAuthFlowCallbackReceived(current) : current);
      const result = await window.coilcoil.request<McpActionResult>({ type: "finish_mcp_auth", name: server }, runtimeId);
      if (result.status) setRuntimeStatus(result.status);
      setAuthFlow((current) => current?.server === server ? mcpAuthFlowSucceeded(current, result) : current);
      void loadStatus();
    } catch (caught) {
      setAuthFlow((current) => current?.server === server ? mcpAuthFlowFailed(current, caught) : current);
    } finally {
      setActionBusy(false);
    }
  };

  /** The paste-the-redirect fallback, for servers whose callback never arrives. */
  const completeAuth = async (input: string): Promise<void> => {
    const server = authFlow?.server;
    if (!server || !input.trim()) return;
    setActionBusy(true);
    setAuthFlow((current) => current?.server === server ? { ...current, phase: "completing", message: undefined } : current);
    try {
      const result = await window.coilcoil.request<McpActionResult>({ type: "complete_mcp_auth", name: server, input: input.trim() }, runtimeId);
      if (result.status) setRuntimeStatus(result.status);
      const failure = actionErrorMessage(result);
      if (failure) throw new Error(failure);
      await connectAfterAuth(server);
      setAuthFlow((current) => current?.server === server ? mcpAuthFlowSucceeded(current, result) : current);
      void loadStatus();
    } catch (caught) {
      setAuthFlow((current) => current?.server === server ? mcpAuthFlowFailed(current, caught) : current);
    } finally {
      setActionBusy(false);
    }
  };

  /**
   * Closing the dialog puts the status view away; it does not abandon the login.
   *
   * It used to cancel the runtime's waiter on every close. Once the browser has
   * been sent to the authorization page the login is happening over there, and
   * deleting the waiter leaves the redirect with nothing to land on a minute
   * later — the callback server answers 400, the browser shows a failure page,
   * and the authorization code is thrown away. From the user's side that reads
   * exactly as "I logged in and the callback never came back", which is what
   * this did to three of their beeswax logins.
   *
   * A flow that never reached the browser has nothing in flight and is still
   * released here.
   */
  const closeAuth = (): void => {
    const flow = authFlow;
    setAuthFlow(undefined);
    if (!flow || flow.phase === "succeeded" || flow.phase === "failed") return;
    if (flow.authorizationUrl) return;
    void window.coilcoil.request({ type: "cancel_mcp_auth", name: flow.server }, runtimeId).catch(() => undefined);
  };

  const logout = async (): Promise<void> => {
    if (!selectedName) return;
    setActionBusy(true);
    try {
      applyActionResult(await window.coilcoil.request<McpActionResult>({ type: "logout_mcp_server", name: selectedName }, runtimeId));
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setActionBusy(false);
    }
  };

  /**
   * The one question the panel is actually asked: does this server work?
   *
   * It used to be unanswerable. 已启用 only ever meant the user had not switched
   * the server off, and the separate 认证 button sat greyed out unless a session
   * happened to be open — so a server nobody had logged into looked exactly like
   * a healthy one, with no lit control to press. This connects for real and
   * reports what came back; when the answer is that nobody is logged in, the
   * authorization dialog opens on the spot.
   *
   * The answer is deliberately transient and belongs to this one press. Lazy
   * connection means an idle server is a healthy server, so a stale "not
   * connected" must never leak back out into the label.
   */
  const checkServer = async (server: string): Promise<void> => {
    setChecking(true);
    setCheckResult(undefined);
    try {
      const result = await window.coilcoil.request<McpActionResult>({ type: "connect_mcp_server", name: server }, runtimeId);
      if (result.status) setRuntimeStatus(result.status);
      const entry = result.status?.servers.find((item) => item.name === server);
      if (entry?.status === "needs-auth") {
        await runAuth(server);
        return;
      }
      const failure = actionErrorMessage(result);
      if (failure) {
        // 服务器答了话却连不上，而这台是要登录的：那就是登录过期，一路接到重新
        // 授权，别把用户丢在一句错误前面。判断规则见 failureNeedsReauthorization。
        if (failureNeedsReauthorization(entry, supportsAuth)) {
          await runAuth(server);
          return;
        }
        setCheckResult({ server, ok: false, text: failure });
        return;
      }
      if (entry?.status === "connected" || entry?.status === "cached") {
        const tools = entry.toolCount ? ` · ${entry.toolCount} 个工具` : "";
        setCheckResult({ server, ok: true, text: `已连接${tools}` });
        return;
      }
      setCheckResult({ server, ok: false, text: result.text || "连不上，服务器没有说明原因。" });
    } catch (caught) {
      setCheckResult({ server, ok: false, text: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setChecking(false);
    }
  };

  const setEnabled = async (): Promise<void> => {
    if (!selectedName || !cwd) return;
    const name = selectedName;
    const enabling = draft.disabled;
    // Writing the override reloads the MCP extension, so the authoritative
    // answer only arrives with the response. Reflect it optimistically and keep
    // a spinner up until it lands, instead of leaving the button looking inert.
    setDraft((current) => ({ ...current, disabled: !enabling }));
    setTogglingEnabled(true);
    try {
      const next = await window.coilcoil.request<McpConfigurationSnapshot>({ type: "set_mcp_server_enabled", name, enabled: enabling, cwd }, runtimeId);
      setConfiguration(next);
      const saved = next.servers.find((server) => server.name === name);
      if (saved) setDraft((current) => ({ ...current, disabled: saved.disabled }));
      toastSuccess(enabling ? `已启用 ${name}` : `已停用 ${name}（Agent 将看不到它）`);
      await loadStatus();
    } catch (caught) {
      setDraft((current) => ({ ...current, disabled: enabling }));
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setTogglingEnabled(false);
    }
  };

  const remove = async (name = selectedName, scope = draft.scope): Promise<void> => {
    if (!name) return;
    const removing = name;
    setSaving(true);
    try {
      const next = await window.coilcoil.request<McpConfigurationSnapshot>({
        type: "remove_mcp_server",
        name: removing,
        scope,
        cwd,
      }, runtimeId);
      setConfiguration(next);
      if (selectedName === removing) {
        const fallback = next.servers.find((server) => server.name !== removing);
        selectServer(fallback, true);
      } else {
        setListRemoveArmed(undefined);
      }
      void loadStatus();
      toastSuccess(`已删除 MCP 服务器 ${removing}。`);
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
      void load();
      void loadStatus();
    } finally {
      setSaving(false);
      setRemoveArmed(false);
      setListRemoveArmed(undefined);
    }
  };

  const selectedStatus = runtimeStatus?.servers.find((server) => server.name === selectedName);
  const mounted = Boolean(selectedName) && isMountedMcpServer(draft);
  const supportsAuth = draft.transport === "http" && draft.auth !== false;

  return (
    <div className="mcp-settings">
      <aside className="mcp-server-list">
        <div className="mcp-list-toolbar"><button className="mcp-add-button" type="button" disabled={loading} onClick={() => selectServer(undefined, true)}><Plus size={13} />添加服务器</button><button className="mcp-refresh-button" type="button" aria-label="刷新 MCP 状态" disabled={statusLoading} onClick={() => void loadStatus(true)}>{statusLoading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}</button></div>
        {runtimeStatus ? <p className="mcp-status-summary">{runtimeStatus.state === "initializing" ? "MCP 扩展初始化中" : runtimeStatus.state === "unavailable" ? "MCP 扩展暂不可用" : `${runtimeStatus.servers.length - runtimeStatus.disabledCount} 个已启用 · ${runtimeStatus.totalTools} 个工具 · ${runtimeStatus.totalResources} 个资源${runtimeStatus.disabledCount ? ` · ${runtimeStatus.disabledCount} 个已停用` : ""}`}</p> : null}
        {loading ? <div className="settings-loading"><LoaderCircle className="spin" size={15} />加载 MCP 配置…</div> : configuration?.servers.map((server) => {
          const status = runtimeStatus?.servers.find((item) => item.name === server.name);
          const armed = listRemoveArmed === server.name;
          return (
            <div className={`mcp-server-row${server.name === selectedName ? " active" : ""}`} key={server.name}>
              <button className="mcp-server-select" type="button" onClick={() => selectServer(server, true)}>
                <span className="mcp-server-title">
                  <i className={`mcp-status-dot ${mcpEnablementClass(server, status)}`} />
                  <strong>{server.name}</strong>
                </span>
                <span className="mcp-server-meta">
                  {mcpMountBadge(server) ? <em className="mounted">{mcpOriginLabel(server)}</em> : null}
                  {status && (status.toolCount || status.resourceCount) ? <em>{status.toolCount} 工具 · {status.resourceCount} 资源</em> : null}
                  <small>{mcpEnablementLabel(server, status)} · {server.transport === "http" ? server.url : server.command}</small>
                </span>
              </button>
              <button
                className={`mcp-server-remove${armed ? " armed" : ""}`}
                type="button"
                aria-label={armed ? `再次点击确认删除 ${server.name}` : `删除 ${server.name}`}
                title={armed ? "再次点击确认删除" : "删除"}
                disabled={saving || actionBusy}
                onClick={(event) => {
                  event.stopPropagation();
                  if (armed) void remove(server.name, server.scope);
                  else setListRemoveArmed(server.name);
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          );
        })}
        {!loading && !configuration?.servers.length ? <p>尚未配置 MCP 服务器。</p> : null}
        {!loading ? <p className="mcp-list-hint">停用表示 Agent 永远看不到它。想知道某个服务器现在通不通，点开它再点「检查状态」。</p> : null}
      </aside>
      <section className="mcp-editor">
        <form className="ui-form" onSubmit={(event) => void save(event)}>
          <div className="mcp-editor-heading"><div><strong>{selectedName ? "编辑 MCP 服务器" : "添加 MCP 服务器"}</strong><small>连接、认证与工具发现都由 CoilCoil 自己完成，认证信息存在本机应用目录里。</small></div></div>
          {selectedName ? <div className="mcp-runtime-card"><span><i className={`mcp-status-dot ${mcpEnablementClass(draft, selectedStatus)}`} /><strong>{mcpEnablementLabel(draft, selectedStatus)}</strong>{selectedStatus && (selectedStatus.toolCount || selectedStatus.resourceCount) ? <small>{selectedStatus.toolCount} 个工具 · {selectedStatus.resourceCount} 个资源</small> : null}{checking ? <small className="mcp-check-result">正在连接…慢的服务器要十几秒</small> : null}{!checking && checkResult?.server === selectedName ? <small className={`mcp-check-result${checkResult.ok ? " ok" : " failed"}`}>{checkResult.text}</small> : null}</span><button type="button" aria-label={draft.disabled ? "启用 MCP 服务器" : "停用 MCP 服务器"} disabled={togglingEnabled || actionBusy || !cwd} onClick={() => void setEnabled()}>{togglingEnabled ? <LoaderCircle className="spin" size={13} /> : <Power size={13} />}{draft.disabled ? "启用" : "停用"}</button><button type="button" disabled={checking || actionBusy || draft.disabled} onClick={() => void checkServer(selectedName)}>{checking ? <LoaderCircle className="spin" size={13} /> : <Activity size={13} />}检查状态</button>{supportsAuth ? <button type="button" disabled={checking || actionBusy} onClick={() => void logout()}><LogOut size={13} />登出</button> : null}</div> : null}
          {runtimeStatus?.diagnostic ? <p className="mcp-source-note">{runtimeStatus.diagnostic}</p> : null}
          {mounted ? <p className="mcp-source-note">这个服务器挂载自 {mcpOriginLabel(draft)}，定义保存在 <code>{draft.source}</code>。CoilCoil 只叠加启用状态等本地覆盖，要改命令、地址或请求头请到该应用里编辑。</p> : null}
          {mounted ? null : <div className="mcp-snippet">
            <button className="mcp-snippet-toggle" type="button" onClick={() => setSnippetOpen((current) => !current)}><ClipboardPaste size={13} />{snippetOpen ? "收起 JSON 粘贴" : "粘贴 MCP JSON 配置"}</button>
            {snippetOpen ? <>
              <TextArea className="mcp-snippet-input" value={snippetText} placeholder={'{\n  "command": "npx",\n  "args": ["-y", "chrome-devtools-mcp@latest"]\n}'} onChange={(event) => setSnippetText(event.target.value)} />
              <div className="mcp-snippet-actions">
                <small>支持完整的 mcpServers 文档、单个服务器对象，或「名称: 配置」这一对。</small>
                <button type="button" onClick={applySnippet}>填入表单</button>
              </div>
            </> : null}
          </div>}
          <fieldset className="mcp-definition-fields" disabled={mounted}>
          <div className="settings-grid"><Field>名称<TextField value={draft.name} placeholder="例如 github" onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></Field><Field>作用域<Select value={draft.scope} options={MCP_SCOPE_OPTIONS} disabled={!cwd} ariaLabel="MCP 作用域" onChange={(scope) => setDraft((current) => ({ ...current, scope: scope as McpServerConfiguration["scope"] }))} /></Field></div>
          <Field>连接方式<Select value={draft.transport} options={MCP_TRANSPORT_OPTIONS} ariaLabel="MCP 连接方式" onChange={(transport) => setDraft((current) => ({ ...current, transport: transport as McpServerConfiguration["transport"] }))} /></Field>
          {draft.transport === "stdio" ? <><Field>启动命令<TextField value={draft.command ?? ""} placeholder="npx" onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))} /></Field><Field>参数（每行一个）<TextArea value={argsText} placeholder="-y&#10;@modelcontextprotocol/server-filesystem" onChange={(event) => setArgsText(event.target.value)} /></Field><div className="settings-grid"><Field>工作目录<TextField value={draft.cwd ?? ""} placeholder="可选" onChange={(event) => setDraft((current) => ({ ...current, cwd: event.target.value }))} /></Field><Field>环境变量 JSON<TextArea value={envText} onChange={(event) => setEnvText(event.target.value)} /></Field></div></> : <><Field>服务器地址<TextField value={draft.url ?? ""} placeholder="https://example.com/mcp" onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))} /></Field><div className="settings-grid"><Field>认证<Select value={String(draft.auth ?? "auto")} options={MCP_AUTH_OPTIONS} ariaLabel="MCP HTTP 认证方式" onChange={(auth) => setDraft((current) => ({ ...current, auth: auth === "auto" ? undefined : auth === "false" ? false : auth as "oauth" | "bearer" }))} /></Field><Field>Bearer 环境变量<TextField value={draft.bearerTokenEnv ?? ""} placeholder="例如 GITHUB_TOKEN" onChange={(event) => setDraft((current) => ({ ...current, bearerTokenEnv: event.target.value }))} /></Field></div><Field>请求头 JSON<TextArea value={headersText} onChange={(event) => setHeadersText(event.target.value)} /></Field><div className="mcp-probe"><button type="button" disabled={probing || !draft.url?.trim()} onClick={() => void probeConnection()}>{probing ? <LoaderCircle className="spin" size={13} /> : <Network size={13} />}测试连接</button>{probeResult ? <pre className="mcp-probe-result">{probeResult}</pre> : null}</div></>}
          <div className="settings-grid"><Field>生命周期<Select value={draft.lifecycle} options={MCP_LIFECYCLE_OPTIONS} ariaLabel="MCP 生命周期" onChange={(lifecycle) => setDraft((current) => ({ ...current, lifecycle: lifecycle as McpServerConfiguration["lifecycle"] }))} /></Field><Field>空闲超时（分钟）<TextField type="number" min="0" value={draft.idleTimeout ?? ""} placeholder="使用扩展默认值" onChange={(event) => setDraft((current) => ({ ...current, idleTimeout: event.target.value ? Number(event.target.value) : undefined }))} /></Field></div>
          <div className="settings-grid"><Field>请求超时（毫秒）<TextField type="number" min="0" value={draft.requestTimeoutMs ?? ""} placeholder="使用扩展默认值" onChange={(event) => setDraft((current) => ({ ...current, requestTimeoutMs: event.target.value ? Number(event.target.value) : undefined }))} /></Field><Field className="checkbox-setting"><Checkbox tone="system" checked={draft.debug} onChange={(event) => setDraft((current) => ({ ...current, debug: event.target.checked }))} />显示服务器调试输出</Field></div>
          <div className="settings-grid"><Field>直接注册的工具（每行一个）<TextArea value={directToolsText} placeholder="留空时使用下面的全部开关" onChange={(event) => setDirectToolsText(event.target.value)} /></Field><Field>排除工具（每行一个）<TextArea value={excludeToolsText} onChange={(event) => setExcludeToolsText(event.target.value)} /></Field></div>
          <div className="settings-grid"><Field className="checkbox-setting"><Checkbox tone="system" checked={draft.directTools === true} disabled={Boolean(directToolsText.trim())} onChange={(event) => setDraft((current) => ({ ...current, directTools: event.target.checked }))} />直接注册全部服务器工具</Field><Field className="checkbox-setting"><Checkbox tone="system" checked={draft.exposeResources} onChange={(event) => setDraft((current) => ({ ...current, exposeResources: event.target.checked }))} />向 Agent 暴露资源</Field></div>
          </fieldset>
          {draft.sourceKind === "import" || (draft.source && draft.source !== configuration?.configPath) ? <p className="mcp-source-note">{draft.sourceKind === "import" ? <>当前条目来自外部导入{draft.source ? `（${draft.source}）` : ""}。删除只会从 CoilCoil 列表中移除并本地停用，不会修改外部应用配置。保存会写入 CoilCoil 私有覆盖。</> : <>当前配置来自 {draft.source}。保存后会在 CoilCoil 私有配置中创建同名覆盖，不会修改外部应用。</>}</p> : null}
          <footer className="ui-form-footer">
            <span>{configuration?.configPath}</span>
            <div className="mcp-editor-footer-actions">
              {selectedName ? <button className={removeArmed ? "danger-text-button armed" : "danger-text-button"} type="button" disabled={saving || actionBusy} onClick={() => removeArmed ? void remove() : setRemoveArmed(true)}>{removeArmed ? "再次点击确认移除" : <><Trash2 size={14} />{mounted ? "移除" : "删除"}</>}</button> : null}
              {mounted ? null : <button className="primary-button" type="submit" disabled={saving || !draft.name.trim()}>{saving ? <LoaderCircle className="spin" size={15} /> : null}保存 MCP</button>}
            </div>
          </footer>
        </form>
        {configuration?.imports.length ? <div className="mcp-imports"><div><strong>检测到的兼容配置</strong><small>Cursor、Claude、Codex 等工具已有的 MCP。点右边逐个挑，选中的会抄一份到 CoilCoil，不会整包接管。</small></div><div className="mcp-import-list">{configuration.imports.map((item) => <span className={item.enabled ? "enabled" : ""} key={`${item.kind}-${item.path}`}><b>{item.kind}</b><small>{item.serverCount} 个服务器</small></span>)}</div><button type="button" disabled={saving} onClick={() => setDiscoveryOpen(true)}>发现并按需导入</button></div> : null}
        <McpDiscoveryDialog open={discoveryOpen} cwd={cwd} runtimeId={runtimeId} onClose={() => setDiscoveryOpen(false)} onImported={(snapshot) => { setConfiguration(snapshot); void loadStatus(); }} />
        {authFlow ? <McpAuthDialog
          state={authFlow}
          submitting={actionBusy}
          onRetry={() => void runAuth(authFlow.server)}
          onManualComplete={(input) => void completeAuth(input)}
          onClose={closeAuth}
        /> : null}
      </section>
    </div>
  );
}

export function SettingsDialog({ configuration, open, onClose, onSaved, runtimeId, cwd, initialSection = "models", onReplayOnboarding }: {
  configuration?: RuntimeConfiguration;
  open: boolean;
  onClose: () => void;
  onSaved: (configuration: RuntimeConfiguration) => void;
  runtimeId?: string;
  cwd?: string;
  initialSection?: SettingsSection;
  /** 重新走一遍首次启动的引导。手机远程端没有这一项：权限那一步说的是这台 Mac。 */
  onReplayOnboarding?: () => void;
}): React.JSX.Element | null {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const mobile = useMobileRemote();
  const hostLabel = platformComputerLabel(rendererPlatform());
  /**
   * Two pages stay on the Mac.
   *
   * A global shortcut only means anything to the machine the keyboard is
   * attached to, and remote access is the thing the phone is currently holding
   * open — turning it off from there would strand whoever is using it.
   */
  const hidden = mobile && (section === "shortcuts" || section === "remote");
  const shown: SettingsSection = hidden ? "models" : section;
  const [sidebarWidth, setSidebarWidth] = useState(storedSettingsSidebarWidth);
  const [mcpJsonOpen, setMcpJsonOpen] = useState(false);
  const [mcpReloadKey, setMcpReloadKey] = useState(0);
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    let cancelled = false;
    void window.coilcoil.appVersion()
      .then((version) => { if (!cancelled) setAppVersion(version); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (open) setSection(initialSection);
    else {
      setSection("models");
      setMcpJsonOpen(false);
    }
  }, [initialSection, open]);

  const beginSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let finalWidth = startWidth;
    const screen = event.currentTarget.closest(".settings-screen") as HTMLElement | null;
    document.body.classList.add("resizing-panels");
    const move = (pointer: PointerEvent): void => {
      finalWidth = Math.round(Math.max(
        MINIMUM_SETTINGS_SIDEBAR_WIDTH,
        Math.min(MAXIMUM_SETTINGS_SIDEBAR_WIDTH, startWidth + pointer.clientX - startX),
      ));
      screen?.style.setProperty("--settings-sidebar-width", `${finalWidth}px`);
    };
    const stop = (): void => {
      document.body.classList.remove("resizing-panels");
      window.removeEventListener("pointermove", move);
      setSidebarWidth(finalWidth);
      window.localStorage.setItem(SETTINGS_SIDEBAR_WIDTH_KEY, String(finalWidth));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }, [sidebarWidth]);

  /**
   * The settings screen is one wide canvas on a phone, not a rebuilt layout.
   *
   * Pages like MCP carry dense tables and long paths that would each need their
   * own mobile design. Keeping the desktop widths and letting the phone pan
   * across them costs nothing and behaves the same on every page: swipe left
   * for the section list, swipe right for the page itself.
   */
  const screenRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const screen = screenRef.current;
    if (!open || !mobile || !screen) return;
    const frame = window.requestAnimationFrame(() => {
      // Land on the page rather than the section list: the caller already chose
      // which page to open.
      screen.scrollLeft = SETTINGS_MOBILE_SIDEBAR_WIDTH;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, mobile]);

  if (!open) return null;
  return (
    <main ref={screenRef} className="settings-screen" aria-labelledby="settings-title" style={{ "--settings-sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      <aside className="settings-sidebar">
        <div className="settings-window-drag window-drag" />
        <button className="settings-sidebar-home" type="button" aria-label="返回工作区" onClick={onClose}><ArrowLeft size={15} /><span>返回工作区</span></button>
        <nav className="settings-tabs" aria-label="设置栏目">
          <button className={section === "models" ? "active" : ""} type="button" onClick={() => setSection("models")}><Settings size={15} />模型与服务商</button>
          <button className={section === "mcp" ? "active" : ""} type="button" onClick={() => setSection("mcp")}><Network size={15} />MCP</button>
          <button className={section === "skills" ? "active" : ""} type="button" onClick={() => setSection("skills")}><Sparkles size={15} />技能</button>
          {/* 「快捷键」栏目暂时撤掉：它底下只有「快速提问气泡」这一项，而那个功能
              已经整条停用了（#39，见 main/bubble-window.ts）。这里是唯一能进到那页
              的入口，撤掉之后就没有地方能再给气泡设快捷键。页面本身留着，功能回来
              时把这个按钮放回去即可。 */}
          {mobile ? null : <button className={section === "remote" ? "active" : ""} type="button" onClick={() => setSection("remote")}><Smartphone size={15} />远程控制</button>}
          <button className={section === "appearance" ? "active" : ""} type="button" onClick={() => setSection("appearance")}><Palette size={15} />外观</button>
          {onReplayOnboarding && !mobile ? (
            <button className="settings-sidebar-replay" type="button" onClick={onReplayOnboarding}>
              <Compass size={14} />重新查看引导
            </button>
          ) : null}
        </nav>
        <div className="settings-version" title={appVersion ? `CoilCoil ${appVersion}` : undefined}>
          {appVersion ? `CoilCoil ${appVersion}` : ""}
        </div>
      </aside>
      <div className="settings-sidebar-resizer" role="separator" aria-label="调整设置侧栏宽度" aria-orientation="vertical" onPointerDown={beginSidebarResize} />
      <section className="settings-page" role="region">
        <header className="settings-page-header window-drag">
          <div>
            <span className="settings-icon">
              {shown === "models" ? <Settings size={17} /> : shown === "mcp" ? <Network size={17} /> : shown === "appearance" ? <Palette size={17} /> : shown === "shortcuts" ? <Keyboard size={17} /> : shown === "remote" ? <Smartphone size={17} /> : <Sparkles size={17} />}
            </span>
            <div>
              <h1 id="settings-title">{shown === "models" ? "模型与服务商" : shown === "mcp" ? "MCP" : shown === "appearance" ? "外观" : shown === "shortcuts" ? "快捷键" : shown === "remote" ? "远程控制" : "技能"}</h1>
              <p>
                {shown === "remote"
                  ? `从手机遥控这台 ${hostLabel}，配对码只在这里显示。`
                  : shown === "skills"
                  ? "按需加载的专业技能包。"
                  : shown === "appearance"
                    ? "全局色调，一键切换并本机保存。"
                    : shown === "shortcuts"
                      ? "全局快捷键会被系统里所有应用共享，所以默认一个都不占用。"
                      : "模型凭据和 MCP 配置均保存在 CoilCoil 的私有运行时中。"}
              </p>
            </div>
          </div>
          {shown === "mcp" ? (
            <button
              className="settings-header-action"
              type="button"
              onClick={() => setMcpJsonOpen(true)}
            >
              <FileJson size={14} />打开 JSON 配置
            </button>
          ) : null}
        </header>
        <div className="settings-page-content">
          {shown === "models" ? (
            <ModelSettings configuration={configuration} onSaved={onSaved} runtimeId={runtimeId} />
          ) : shown === "mcp" ? (
            <McpSettings runtimeId={runtimeId} cwd={cwd} reloadKey={mcpReloadKey} />
          ) : shown === "shortcuts" ? (
            <ShortcutSettings />
          ) : shown === "remote" ? (
            <RemoteSettings />

          ) : shown === "appearance" ? (
            <AppearanceSettings />
          ) : (
            <SkillSettings runtimeId={runtimeId} cwd={cwd} />
          )}
        </div>
      </section>
      <McpJsonEditor
        open={mcpJsonOpen}
        cwd={cwd}
        runtimeId={runtimeId}
        onClose={() => setMcpJsonOpen(false)}
        onSaved={() => setMcpReloadKey((value) => value + 1)}
      />
    </main>
  );
}
