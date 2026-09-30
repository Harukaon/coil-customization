import type {
  RuntimeCommand,
  RuntimeEventEnvelope,
  RuntimeResponseEnvelope,
  RuntimeWireMessage,
  FileNode,
} from "@coilcoil/runtime-protocol";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, screen, session, shell } from "electron";
import { createRequire } from "node:module";
import type { DiagnosticLogBatch } from "@coilcoil/runtime-protocol";
import type {
  BrowserUiViewport,
  ImportBrowserCookiesInput,
  MacPermissionId,
  McpConnectionTestInput,
  OpenFilePreviewInput,
  PathKind,
  ProjectFileActionInput,
  ProjectFileActionResult,
  ProjectSelection,
  RemoteAccessInput,
  RuntimeRequestPayload,
  RuntimeRequestResult,
  SaveProjectFileInput,
} from "../shared/desktop-api";
import { appIconPath } from "./app-icon";
import { macPermissions, openPermissionSettings } from "./mac-permissions";
import { BUBBLE_OPEN_SESSION_CHANNEL, setupBubbleWindow } from "./bubble-window.js";
import { testMcpConnection } from "./mcp-connection-test.js";
import { BrowserRuntimeManager } from "./browser-runtime";
import {
  browserContextMenuItems,
  runContextMenuAction,
  type GuestContextMenuParams,
} from "./browser-context-menu";
import { BROWSER_PARTITION } from "./browser-page-policy";
import { configureBrowserIdentity } from "./browser-user-agent";
import { readMountedProjects, writeMountedProjects } from "./mounted-projects";
import { checkWorkspaceName, memoryBucketName, rememberedMemoryNames, workspaceNamePrompt } from "./workspace-name-guard";
import { proxyEnvironment, refreshProxyEnvironment } from "./system-proxy";
import { browserDataStats, clearBrowserData, importBrowserCookies, listImportableProfiles, savedLogins } from "./browser-import";
import { saveProjectFile } from "./file-edit";
import { closeAllFilePreviews, closeFilePreview, openFilePreview, windowPreviewOwner, PREVIEW_UPDATED_CHANNEL, type PreviewOwner } from "./file-preview";
import { installHostNavigationGuard } from "./host-navigation";
import { currentPlatform, trashLabel } from "../shared/platform-labels";
import { applicationMenuTemplate, windowBackgroundColor, windowChromeOptions } from "./window-chrome";
import { writeStoredWindowOpacity } from "./window-opacity";
import { migrateLegacyUserData } from "./data-migration";
import {
  DIAGNOSTIC_LEVEL_ENV,
  DIAGNOSTIC_LOG_DIRECTORY,
  DiagnosticLog,
  installProcessErrorHandlers,
  levelFromEnvironment,
  processStartupData,
} from "@coilcoil/diagnostics";
import { TerminalRuntimeManager } from "./terminal-runtime";
import { RemoteAccessController } from "./remote/remote-access";
import {
  checkForUpdate,
  UPDATE_FIRST_CHECK_MS,
  UPDATE_INTERVAL_MS,
  type UpdateAvailable,
} from "./update-check";

// This is deliberately opt-in and development-only. It lets the desktop smoke
// harness inspect the *running* renderer instead of proving layout solely with
// a synthetic DOM fixture. Electron otherwise does not expose the application
// WebContents through the scoped browser CDP bridge below.
const rendererDebugPort = process.env.COILCOIL_RENDERER_DEBUG_PORT;
if (!app.isPackaged && rendererDebugPort && /^\d{2,5}$/.test(rendererDebugPort)) {
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", rendererDebugPort);
}

const PROJECT_SELECT_CHANNEL = "project:select";
const PROJECT_HOME_CHANNEL = "project:home";
const APP_VERSION_CHANNEL = "app:version";
const PICK_DIRECTORY_CHANNEL = "dialog:pick-directory";
const WINDOW_MINIMUM_WIDTH_CHANNEL = "window:minimum-width";
const WINDOW_GROW_WIDTH_CHANNEL = "window:grow-width";
const WINDOW_BACKGROUND_CHANNEL = "window:background";
const WINDOW_OPACITY_CHANNEL = "window:opacity";
const BADGE_COUNT_CHANNEL = "app:badge-count";
const MOUNTED_PROJECTS_CHANNEL = "projects:mounted";
const MOUNTED_PROJECTS_SET_CHANNEL = "projects:mounted:set";

/** 挂载的文件夹清单：和 window.json 一样，userData 下自己一个小文件。 */
function mountedProjectsFile(): string {
  return join(app.getPath("userData"), "mounted-projects.json");
}

/** 透明度存在 userData 下的单独一个小文件里，和 remote.json 一样。 */
function windowOpacityFile(): string {
  return join(app.getPath("userData"), "window.json");
}
/** 首帧用的底色；窗口半透明时露出的就是这一层，之后由渲染进程按主题同步。 */
const WINDOW_BACKGROUND = { light: "#f8f8f7", dark: "#1f1f1f" } as const;
/** 只接受 CSS 颜色字面量，不接受任意字符串。 */
const CSS_COLOR = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d\s.,%/-]+\))$/i;
const EXTERNAL_OPEN_CHANNEL = "external:open";
const PATH_CLASSIFY_CHANNEL = "path:classify";
const PATH_REVEAL_CHANNEL = "path:reveal";
const MCP_TEST_CHANNEL = "mcp:test-connection";
const CLIPBOARD_WRITE_CHANNEL = "clipboard:write";
const RUNTIME_REQUEST_CHANNEL = "runtime:request";
const RUNTIME_EVENT_CHANNEL = "runtime:event";
const REMOTE_GET_CHANNEL = "remote:get";
const REMOTE_SAVE_CHANNEL = "remote:save";
const REMOTE_NEW_CODE_CHANNEL = "remote:new-code";
const REMOTE_ACCOUNT_CHANNEL = "remote:account";
const REMOTE_REVOKE_CHANNEL = "remote:revoke";
const REMOTE_STATE_CHANNEL = "remote:state";
const WINDOW_MINIMIZE_CHANNEL = "window:minimize";
const WINDOW_TOGGLE_MAXIMIZED_CHANNEL = "window:toggle-maximized";
const WINDOW_IS_MAXIMIZED_CHANNEL = "window:is-maximized";
const WINDOW_MAXIMIZED_CHANNEL = "window:maximized";
const WINDOW_FOCUS_CHANNEL = "window:focus";
const WINDOW_CLOSE_CHANNEL = "window:close";
const DIAGNOSTIC_LOG_CHANNEL = "diagnostics:log";
const DIAGNOSTIC_REVEAL_CHANNEL = "diagnostics:reveal";
const PREVIEW_OPEN_CHANNEL = "preview:open";
const PREVIEW_CLOSE_CHANNEL = "preview:close";
const PROJECT_FILE_ACTION_CHANNEL = "project-file:action";
const PROJECT_FILE_SAVE_CHANNEL = "project-file:save";
const PROJECT_DIRECTORY_LIST_CHANNEL = "project-directory:list";
const BROWSER_STATE_CHANNEL = "browser:state";
const BROWSER_AGENT_ACTIVATED_CHANNEL = "browser:agent-activated";
const BROWSER_GET_STATE_CHANNEL = "browser:get-state";
const BROWSER_CAPTURE_CHANNEL = "browser:capture";
const BROWSER_PICK_ELEMENT_CHANNEL = "browser:pick-element";
const BROWSER_CANCEL_PICK_CHANNEL = "browser:cancel-pick";
const BROWSER_SET_SCOPE_CHANNEL = "browser:set-scope";
const BROWSER_CREATE_TAB_CHANNEL = "browser:create-tab";
const BROWSER_SELECT_TAB_CHANNEL = "browser:select-tab";
const BROWSER_CLOSE_TAB_CHANNEL = "browser:close-tab";
const BROWSER_NAVIGATE_CHANNEL = "browser:navigate";
const BROWSER_ZOOM_CHANNEL = "browser:zoom";
const BROWSER_BACK_CHANNEL = "browser:back";
const BROWSER_FORWARD_CHANNEL = "browser:forward";
const BROWSER_RELOAD_CHANNEL = "browser:reload";
const BROWSER_UI_VIEWPORT_CHANNEL = "browser:ui-viewport";
const BROWSER_IMPORT_LIST_CHANNEL = "browser:import-list";
const OPEN_FULL_DISK_ACCESS_CHANNEL = "system:open-full-disk-access";
const MAC_PERMISSIONS_CHANNEL = "system:mac-permissions";
const BROWSER_IMPORT_COOKIES_CHANNEL = "browser:import-cookies";
const BROWSER_DATA_STATS_CHANNEL = "browser:data-stats";
const BROWSER_SAVED_LOGINS_CHANNEL = "browser:saved-logins";
const BROWSER_DATA_CLEAR_CHANNEL = "browser:data-clear";
const BROWSER_INPUT_CHANNEL = "browser:input";
const BROWSER_DIALOG_REPLY_CHANNEL = "browser:dialog-reply";
const BROWSER_SELECT_CHOOSE_CHANNEL = "browser:select-choose";
const BROWSER_VALUE_CHOOSE_CHANNEL = "browser:value-choose";
const BROWSER_FIND_CHANNEL = "browser:find";
const BROWSER_CARET_CHANNEL = "browser:caret";
const BROWSER_TOOLTIP_CHANNEL = "browser:tooltip";
const BROWSER_DROP_FILES_CHANNEL = "browser:drop-files";
const TERMINAL_STATE_CHANNEL = "terminal:state";
const TERMINAL_DATA_CHANNEL = "terminal:data";
const TERMINAL_GET_CHANNEL = "terminal:get";
const TERMINAL_CREATE_CHANNEL = "terminal:create";
const TERMINAL_WRITE_CHANNEL = "terminal:write";
const TERMINAL_RESIZE_CHANNEL = "terminal:resize";
const TERMINAL_CLOSE_CHANNEL = "terminal:close";
const UPDATE_AVAILABLE_CHANNEL = "update:available";
let isQuitting = false;
const moduleRequire = createRequire(import.meta.url);
const browserRuntimes = new Map<number, BrowserRuntimeManager>();
const terminalRuntimes = new Map<number, TerminalRuntimeManager>();
let primaryBrowserRuntime: BrowserRuntimeManager | undefined;
let primaryTerminalRuntime: TerminalRuntimeManager | undefined;

function chromeDevtoolsMcpEntry(): string {
  const resolved = moduleRequire.resolve("chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js");
  if (!app.isPackaged) return resolved;
  const unpacked = resolved.replace(`${join("app.asar", "node_modules")}`, `${join("app.asar.unpacked", "node_modules")}`);
  return existsSync(unpacked) ? unpacked : resolved;
}

function backgroundNodeExecutable(): string {
  const executableName = basename(process.execPath);
  const macHelperExecutable = join(dirname(dirname(process.execPath)), "Frameworks", `${executableName} Helper.app`, "Contents", "MacOS", `${executableName} Helper`);
  return process.platform === "darwin" && existsSync(macHelperExecutable) ? macHelperExecutable : process.execPath;
}

/**
 * 新对话的会话刚建好：把它草稿阶段开的标签页交给它。
 *
 * 浏览器按会话分，可新对话要等发出第一条消息才有会话；在那之前界面的作用域是工作区
 * 路径（渲染层 browserScopeId 的兜底），也就是这条 create_session 的 cwd。用户先开
 * 页面、再让 Agent 看它是很自然的顺序，所以会话一建好，那几张标签页就归它。在快照
 * 回到界面之前做，界面切到会话作用域时标签页已经在那儿了，不会先补建一张空白页。
 *
 * `browser` 是发起请求那个窗口的浏览器。气泡窗口没有浏览器，它建的会话不会把主窗口
 * 草稿里的页面拿走。
 */
function handDraftTabsToNewSession(browser: BrowserRuntimeManager | undefined, command: RuntimeCommand, value: unknown): void {
  if (!browser || command.type !== "create_session") return;
  const session = (value as { session?: { id?: unknown; cwd?: unknown } } | undefined)?.session;
  if (typeof session?.id !== "string" || !session.id) return;
  try {
    browser.adoptScope(command.cwd, session.id, typeof session.cwd === "string" ? session.cwd : command.cwd);
  } catch (error) {
    // 接手失败只是草稿里的页面留在原处，不能挡住这条消息。
    diagnosticLog().warn("browser", "draft_tabs_adoption_failed", { message: error instanceof Error ? error.message : String(error) });
  }
}

async function safeProjectPath(input: Pick<OpenFilePreviewInput, "root" | "path">): Promise<{ root: string; path: string }> {
  const root = await realpath(input.root);
  const candidate = isAbsolute(input.path) ? resolve(input.path) : resolve(root, input.path);
  const path = await realpath(candidate);
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error("所选文件不在当前项目中。");
  }
  return { root, path };
}

/**
 * Resolve a file to preview.
 *
 * Preview deliberately accepts a file the project does not contain. Agents cite
 * absolute paths outside the workspace all the time — a dependency's source, a
 * log, a config in the home directory — and refusing to open the very path the
 * reply just linked was the wrong answer. Only the single named file is
 * reachable this way: directory listing stays contained to the project, so an
 * outside path can be read but never browsed. This grants the agent nothing it
 * lacks, because its own read tool already reaches the whole filesystem.
 */
async function safePreviewPath(input: OpenFilePreviewInput): Promise<{ root: string; path: string }> {
  const root = await realpath(input.root);
  const candidate = isAbsolute(input.path) ? resolve(input.path) : resolve(root, input.path);
  const path = await realpath(candidate);
  if (!(await stat(path)).isFile()) throw new Error("所选路径不是文件。");
  return { root, path };
}

async function safeProjectEntryPath(
  input: Pick<ProjectFileActionInput, "root" | "path">,
): Promise<{ root: string; path: string }> {
  const root = await realpath(input.root);
  const path = isAbsolute(input.path) ? resolve(input.path) : resolve(root, input.path);
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(!rel ? "不能对工作区根目录执行此操作。" : "所选项目条目不在当前项目中。");
  }
  await lstat(path);
  return { root, path };
}

async function performProjectFileAction(
  event: Electron.IpcMainInvokeEvent | undefined,
  input: ProjectFileActionInput,
): Promise<ProjectFileActionResult> {
  const target = await safeProjectEntryPath(input);
  if (input.action === "reveal") {
    shell.showItemInFolder(target.path);
    return { completed: true };
  }
  if (input.action !== "trash") throw new Error("不支持的文件操作。");
  const owner = event ? BrowserWindow.fromWebContents(event.sender) ?? undefined : undefined;
  const trash = trashLabel(currentPlatform(process.platform));
  const options = {
    type: "warning" as const,
    title: `移到${trash}`,
    message: `确定要将“${basename(target.path)}”移到${trash}吗？`,
    buttons: ["取消", `移到${trash}`],
    defaultId: 0,
    cancelId: 0,
  };
  const result = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
  if (result.response !== 1) return { completed: false, trashed: false };
  await shell.trashItem(target.path);
  return { completed: true, trashed: true };
}

async function listProjectDirectory(rootValue: string, relativePath = ""): Promise<FileNode[]> {
  const root = await realpath(rootValue);
  if (!(await stat(root)).isDirectory()) throw new Error("项目路径不是文件夹。");
  const candidate = resolve(root, relativePath || ".");
  const path = await realpath(candidate);
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) throw new Error("目录不在当前项目中。");
  if (!(await stat(path)).isDirectory()) throw new Error("所选路径不是文件夹。");
  const entries = await readdir(path, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((entry) => ({
      name: entry.name,
      path: relative(root, join(path, entry.name)) || entry.name,
      kind: entry.isDirectory() ? "directory" : "file",
    } satisfies FileNode));
}

function isEventEnvelope(message: RuntimeWireMessage): message is RuntimeEventEnvelope {
  return "event" in message;
}


/**
 * How recently an agent must have driven the browser for a window activation to
 * be worth recording. Longer than a single command round trip, short enough that
 * a user clicking the dock a moment later is not blamed on the agent.
 */
const WINDOW_ACTIVATION_ATTRIBUTION_MS = 3_000;
/** How long after one of our own reveals its window events still belong to it. */
const DELIBERATE_REVEAL_WINDOW_MS = 1_000;

/** How much of the runtime child's stderr to keep for its own obituary. */
const RUNTIME_STDERR_TAIL_LINES = 60;

let mainLog: DiagnosticLog | undefined;

/**
 * The main process's log, and the file the Renderer's entries land in too.
 *
 * Created on first use rather than at module load: it writes under `userData`,
 * which is only settled once Electron has resolved the app paths.
 */
function diagnosticLog(): DiagnosticLog {
  mainLog ??= new DiagnosticLog({
    directory: join(app.getPath("userData"), "agent", DIAGNOSTIC_LOG_DIRECTORY),
    process: "main",
    level: levelFromEnvironment(process.env[DIAGNOSTIC_LEVEL_ENV]),
    echo: !app.isPackaged,
  });
  return mainLog;
}

class RuntimeHost {
  private child?: ChildProcess;
  /**
   * The runtime child's recent stderr.
   *
   * Everything it prints went to this process's own stderr, which a packaged
   * app throws away — so the one place that said why it died was the one place
   * nobody could read. Keeping a tail means the exit entry can carry it.
   */
  private stderrTail: string[] = [];
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(
    private readonly onEvent: (runtimeId: string | undefined, event: RuntimeEventEnvelope["event"]) => void,
    private readonly onExit: () => void,
  ) {}

  start(): void {
    if (this.child?.connected) return;
    const runtimeEntry = join(__dirname, "runtime.js");
    const nodeExecutable = backgroundNodeExecutable();
    const child = fork(runtimeEntry, [], {
      execPath: process.execPath,
      env: {
        ...process.env,
        // Node ignores the system proxy; without this the runtime's model
        // requests and WebSockets go out directly. See system-proxy.ts.
        ...proxyEnvironment(),
        ELECTRON_RUN_AS_NODE: "1",
        COILCOIL_AGENT_DIR: join(app.getPath("userData"), "agent"),
        COILCOIL_SESSION_DIR: join(app.getPath("userData"), "sessions"),
        COILCOIL_NODE_EXEC_PATH: nodeExecutable,
        ...(primaryBrowserRuntime ? {
          COILCOIL_BROWSER_MCP_COMMAND: nodeExecutable,
          COILCOIL_BROWSER_MCP_ARGS: JSON.stringify([
            chromeDevtoolsMcpEntry(),
            "--wsEndpoint", primaryBrowserRuntime.endpoint(),
            "--wsHeaders", JSON.stringify({ Authorization: `Bearer ${primaryBrowserRuntime.token}` }),
            "--allow-unrestricted-paths",
            "--no-usage-statistics",
            "--no-performance-crux",
            "--experimentalStructuredContent",
            "--experimentalPageIdRouting",
          ]),
          COILCOIL_BROWSER_MCP_ENV: JSON.stringify({
            CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
            CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
            ELECTRON_RUN_AS_NODE: "1",
          }),
        } : {}),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.child = child;

    this.stderrTail = [];
    diagnosticLog().info("runtime-host", "runtime_spawned", {
      pid: child.pid,
      entry: runtimeEntry,
      proxy: proxyEnvironment().HTTPS_PROXY ?? "direct",
    });
    // Keep the cache current so the next respawn follows a VPN that came up or
    // went away since; the running child keeps the proxy it was started with.
    void refreshProxyEnvironment((event, data) => diagnosticLog().info("network", event, data));
    child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[runtime] ${chunk.toString()}`));
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      process.stderr.write(`[runtime] ${text}`);
      for (const line of text.split("\n")) {
        if (line.trim()) this.stderrTail.push(line);
      }
      if (this.stderrTail.length > RUNTIME_STDERR_TAIL_LINES) {
        this.stderrTail = this.stderrTail.slice(-RUNTIME_STDERR_TAIL_LINES);
      }
    });
    child.on("message", (raw: RuntimeWireMessage) => this.handleMessage(raw));
    child.once("exit", (code, signal) => {
      this.child = undefined;
      const reason = `CoilCoil runtime exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}.`;
      const unexpected = !isQuitting;
      diagnosticLog().log(unexpected ? "error" : "info", "runtime-host", "runtime_exited", {
        code,
        signal,
        quitting: isQuitting,
        pendingRequests: this.pending.size,
        stderrTail: this.stderrTail,
      });
      for (const request of this.pending.values()) request.reject(new Error(reason));
      this.pending.clear();
      this.onExit();
      if (!isQuitting) {
        this.onEvent(undefined, {
            type: "runtime_error",
            message: reason,
        });
      }
    });
  }

  private handleMessage(message: RuntimeWireMessage): void {
    if (isEventEnvelope(message)) {
      this.onEvent(message.runtimeId, message.event);
      return;
    }
    const response = message as RuntimeResponseEnvelope;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error || "运行时请求失败。"));
  }

  request<T>(command: RuntimeCommand, runtimeId?: string): Promise<T> {
    this.start();
    const child = this.child;
    if (!child?.connected) return Promise.reject(new Error("CoilCoil 运行时不可用。"));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      child.send({ id, runtimeId, command }, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  stop(): void {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    child.removeAllListeners("exit");
    if (child.connected) child.disconnect();
    child.kill("SIGTERM");
    for (const request of this.pending.values()) request.reject(new Error("CoilCoil 正在关闭。"));
    this.pending.clear();
  }
}

class RuntimeBridge {
  private host?: RuntimeHost;

  private broadcast = (runtimeId: string | undefined, event: RuntimeEventEnvelope["event"]): void => {
    // 浏览器按会话分，一个会话一批标签页；cookie 仍按工作区分。每个会话在哪个工作区，
    // 只有快照说得清：用会话 id 记下它的工作区，它的 Agent 在后台开的标签页才会落在
    // 那个工作区的 cookie jar 里——界面切到别处也不影响。
    // 会话结束、运行时被回收时都不关它的标签页：切回来页面还要在，一直留到退出 App。
    if (runtimeId && event.type === "session_snapshot") {
      const { id, cwd } = event.snapshot.session;
      for (const runtime of browserRuntimes.values()) runtime.noteScopeWorkspace(id, cwd);
    }
    for (const window of appWindows()) {
      window.webContents.send(RUNTIME_EVENT_CHANNEL, { runtimeId, event });
    }
    // Remote clients are additional viewers of the same session, so they see
    // exactly what the desktop window sees, at the same moment.
    remoteAccess?.broadcast(RUNTIME_EVENT_CHANNEL, { runtimeId, event });
  };

  private runtimeHost(): RuntimeHost {
    if (this.host) return this.host;
    const host = new RuntimeHost(this.broadcast, () => {
      if (this.host === host) this.host = undefined;
    });
    this.host = host;
    return host;
  }

  start(): void {
    this.runtimeHost().start();
  }

  request<T>(payload: RuntimeRequestPayload): Promise<T> {
    return this.runtimeHost().request<T>(payload.command, payload.runtimeId);
  }

  stop(): void {
    this.host?.stop();
    this.host = undefined;
  }
}

const runtime = new RuntimeBridge();

let remoteAccess: RemoteAccessController | undefined;

/**
 * Shared by the window's IPC handlers and the remote entry point, so a phone
 * and the desktop window always get the same answer.
 */
async function homeProject(): Promise<ProjectSelection> {
  const path = join(app.getPath("userData"), "Home");
  await mkdir(path, { recursive: true });
  return { name: "Home", path, kind: "home" };
}

/** What an absolute path in the transcript actually is, so a link can be routed. */
async function classifyPaths(paths: string[]): Promise<Record<string, PathKind>> {
  if (!Array.isArray(paths)) throw new Error("路径列表无效。");
  const entries = await Promise.all(paths.slice(0, 200).map(async (candidate): Promise<[string, PathKind]> => {
    if (typeof candidate !== "string" || !candidate.trim() || !isAbsolute(candidate)) return [String(candidate), "missing"];
    try {
      const stats = await stat(candidate);
      return [candidate, stats.isDirectory() ? "directory" : "file"];
    } catch {
      return [candidate, "missing"];
    }
  }));
  return Object.fromEntries(entries);
}

/**
 * 手机远程端在这台机器上没有自己的 WebContents，所以它开的预览把更新广播回去。
 *
 * id 用一个负数：WebContents 的 id 都是正的，这样「谁开的预览谁才能关」这条判断
 * 对远程和桌面是同一套，不会互相认错。
 */
const remotePreviewOwner: PreviewOwner = {
  id: -1,
  alive: () => Boolean(remoteAccess),
  send: (document) => remoteAccess?.broadcast(PREVIEW_UPDATED_CHANNEL, document),
  // 远程这份没有窗口可以销毁，退订也就无事可做。
  onGone: () => () => undefined,
};

function remoteController(): RemoteAccessController {
  if (remoteAccess) return remoteAccess;
  remoteAccess = new RemoteAccessController({
    configFile: join(app.getPath("userData"), "remote.json"),
    authFile: join(app.getPath("userData"), "remote-devices.json"),
    platform: process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux",
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    rendererDir: join(__dirname, "../renderer"),
    invoke: async (channel, args) => {
      if (channel === RUNTIME_REQUEST_CHANNEL) {
        const payload = args[0] as RuntimeRequestPayload;
        try {
          const value = await runtime.request(payload);
          handDraftTabsToNewSession(primaryBrowserRuntime, payload.command, value);
          return { ok: true, value } satisfies RuntimeRequestResult;
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) } satisfies RuntimeRequestResult;
        }
      }
      if (channel === MCP_TEST_CHANNEL) return testMcpConnection(args[0] as McpConnectionTestInput);
      if (channel === APP_VERSION_CHANNEL) return app.getVersion();
      if (channel === PROJECT_HOME_CHANNEL) return homeProject();
      if (channel === PROJECT_SELECT_CHANNEL) {
        const result = await dialog.showOpenDialog({ title: "打开项目", properties: ["openDirectory"] });
        const path = result.filePaths[0];
        return result.canceled || !path ? null : { name: basename(path), path, kind: "workspace" } satisfies ProjectSelection;
      }
      if (channel === PICK_DIRECTORY_CHANNEL) {
        const options = args[0] as { title?: unknown } | undefined;
        const result = await dialog.showOpenDialog({
          title: typeof options?.title === "string" && options.title.trim() ? options.title.trim() : "选择目录",
          properties: ["openDirectory"],
        });
        return result.canceled ? null : result.filePaths[0] ?? null;
      }
      if (
        channel === WINDOW_MINIMUM_WIDTH_CHANNEL
        || channel === WINDOW_GROW_WIDTH_CHANNEL
        || channel === WINDOW_BACKGROUND_CHANNEL
        || channel === WINDOW_OPACITY_CHANNEL
      ) return channel === WINDOW_OPACITY_CHANNEL ? 1 : undefined;
      if (channel === BADGE_COUNT_CHANNEL) {
        const count = Number(args[0]);
        app.setBadgeCount(Number.isFinite(count) && count > 0 ? Math.floor(count) : 0);
        return undefined;
      }
      if (channel === EXTERNAL_OPEN_CHANNEL) {
        if (typeof args[0] !== "string") throw new Error("授权地址无效。");
        const url = new URL(args[0]);
        if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("只允许打开 HTTP 或 HTTPS 授权地址。");
        await shell.openExternal(url.toString());
        return undefined;
      }
      if (channel === CLIPBOARD_WRITE_CHANNEL) {
        if (typeof args[0] !== "string" || args[0].length > 1_000_000) throw new Error("剪贴板内容无效。");
        clipboard.writeText(args[0]);
        return undefined;
      }
      if (channel === PROJECT_DIRECTORY_LIST_CHANNEL) return listProjectDirectory(args[0] as string, args[1] as string | undefined);
      if (channel === PATH_CLASSIFY_CHANNEL) return classifyPaths(args[0] as string[]);
      if (channel === PATH_REVEAL_CHANNEL) {
        const rawPath = args[0];
        if (typeof rawPath !== "string" || !rawPath.trim() || !isAbsolute(rawPath)) throw new Error("路径无效。");
        const target = resolve(rawPath);
        const stats = await stat(target).catch(() => undefined);
        if (!stats) throw new Error("路径不存在或已被移动。");
        if (stats.isDirectory()) {
          const error = await shell.openPath(target);
          if (error) throw new Error(error);
        } else shell.showItemInFolder(target);
        return true;
      }
      // 手机上的浏览器存储是另一个来源的，挂载的文件夹清单只能问这台机器
      // 要——同一份文件，桌面和手机看到的是同一份清单。
      if (channel === MOUNTED_PROJECTS_CHANNEL) return readMountedProjects(mountedProjectsFile());
      if (channel === MOUNTED_PROJECTS_SET_CHANNEL) return writeMountedProjects(mountedProjectsFile(), args[0]);
      // 文件预览：内容是这台机器读出来直接放进返回值里的，手机拿到的和桌面拿到的
      // 是同一份文档，所以图片、PDF、Markdown 在手机上照样看得到。
      if (channel === PREVIEW_OPEN_CHANNEL) return openFilePreview(remotePreviewOwner, args[0] as OpenFilePreviewInput, safePreviewPath);
      if (channel === PREVIEW_CLOSE_CHANNEL) return closeFilePreview(remotePreviewOwner.id, args[0] as string);
      if (channel === PROJECT_FILE_SAVE_CHANNEL) return saveProjectFile(args[0] as SaveProjectFileInput, safeProjectPath);
      if (channel === PROJECT_FILE_ACTION_CHANNEL) return performProjectFileAction(undefined, args[0] as ProjectFileActionInput);
      // The phone drives the same browser the agent drives — the one belonging
      // to the desktop window — rather than a browser of its own, which it has
      // no way to host anyway.
      if (channel.startsWith("browser:")) {
        const browser = primaryBrowserRuntime;
        if (!browser) throw new Error("内置浏览器尚未就绪，请先在 Mac 上打开 CoilCoil 窗口。");
        switch (channel) {
          // 网页版/手机看哪个会话是它自己的事，不能把桌面窗口也带过去。
          case BROWSER_SET_SCOPE_CHANNEL: return browser.watchRemoteScope(args[0] as string, args[1] as string | undefined);
          case BROWSER_GET_STATE_CHANNEL: return browser.state(args[0] as string);
          case BROWSER_CAPTURE_CHANNEL: return browser.captureTab(args[0] as string);
          case BROWSER_CREATE_TAB_CHANNEL: return browser.createTab(args[1] as string | undefined, true, args[0] as string, args[2] === true);
          case BROWSER_SELECT_TAB_CHANNEL: return browser.selectTab(args[1] as string, args[0] as string);
          case BROWSER_CLOSE_TAB_CHANNEL: return browser.closeTab(args[1] as string, args[0] as string);
          case BROWSER_NAVIGATE_CHANNEL: return browser.navigate(args[1] as string, args[0] as string);
          case BROWSER_ZOOM_CHANNEL: return browser.setZoom(args[1] as "in" | "out" | "reset", args[0] as string);
          case BROWSER_BACK_CHANNEL: return browser.back(args[0] as string);
          case BROWSER_FORWARD_CHANNEL: return browser.forward(args[0] as string);
          case BROWSER_RELOAD_CHANNEL: return browser.reload(args[0] as string);
          case BROWSER_DIALOG_REPLY_CHANNEL: return browser.replyDialog(String(args[0]), String(args[1]), String(args[2]), args[3] === true, String(args[4] ?? ""));
          case BROWSER_IMPORT_LIST_CHANNEL: return listImportableProfiles();
          case MAC_PERMISSIONS_CHANNEL: return macPermissions();
          case OPEN_FULL_DISK_ACCESS_CHANNEL: return openPermissionSettings(args[0] as MacPermissionId);
          case BROWSER_IMPORT_COOKIES_CHANNEL: return importBrowserCookies(args[0] as ImportBrowserCookiesInput, browser.partitionName());
          case BROWSER_DATA_STATS_CHANNEL: return browserDataStats(browser.partitionName());
          case BROWSER_SAVED_LOGINS_CHANNEL: return savedLogins(browser.partitionName());
          case BROWSER_DATA_CLEAR_CHANNEL: return clearBrowserData((name, data) => diagnosticLog().info("browser-data", name, data));
          case BROWSER_UI_VIEWPORT_CHANNEL: return undefined;
          default: break;
        }
      }
      if (channel === TERMINAL_GET_CHANNEL) return primaryTerminalRuntime?.state() ?? [];
      if (channel === TERMINAL_CREATE_CHANNEL) return primaryTerminalRuntime?.create(args[0] as string) ?? [];
      if (channel === TERMINAL_WRITE_CHANNEL) {
        primaryTerminalRuntime?.write(args[0] as string, args[1] as string);
        return undefined;
      }
      if (channel === TERMINAL_RESIZE_CHANNEL) {
        primaryTerminalRuntime?.resize(args[0] as string, args[1] as number, args[2] as number);
        return undefined;
      }
      if (channel === TERMINAL_CLOSE_CHANNEL) return primaryTerminalRuntime?.close(args[0] as string) ?? [];
      if (channel === WINDOW_IS_MAXIMIZED_CHANNEL) return appWindows()[0]?.isMaximized() ?? false;
      if (channel === DIAGNOSTIC_LOG_CHANNEL) {
        const batch = args[0] as DiagnosticLogBatch;
        if (Array.isArray(batch?.entries)) diagnosticLog().writeEntries(batch.entries);
        return undefined;
      }
      if (channel === DIAGNOSTIC_REVEAL_CHANNEL) {
        const log = diagnosticLog();
        shell.showItemInFolder(log.filePath);
        return log.filePath;
      }
      if (channel === REMOTE_GET_CHANNEL) return remoteController().state();
      if (channel === REMOTE_SAVE_CHANNEL) return remoteController().apply((args[0] ?? {}) as RemoteAccessInput);
      if (channel === REMOTE_NEW_CODE_CHANNEL) return remoteController().regenerateCode();
      if (channel === REMOTE_ACCOUNT_CHANNEL) return remoteController().setAccount(String(args[0] ?? ""), String(args[1] ?? ""));
      if (channel === REMOTE_REVOKE_CHANNEL) return remoteController().revokeDevices();
      throw new Error(`远程会话不支持 ${channel}。`);
    },
    log: (level, event, data) => diagnosticLog().log(level, "remote", event, data),
    // The pairing code is shown in settings and nowhere else, so any change to
    // it has to reach an open settings screen on its own.
    onStateChanged: (state) => {
      for (const window of appWindows()) {
        window.webContents.send(REMOTE_STATE_CHANNEL, state);
      }
      remoteAccess?.broadcast(REMOTE_STATE_CHANNEL, state);
    },
  });
  return remoteAccess;
}

/**
 * 在 App 窗口里、鼠标所在的地方弹出网页的右键菜单。
 *
 * Chromium 对每次右键都发 context-menu，但自己什么都不弹，所以得我们来搭。离屏页面的
 * 画面就在面板里，用户右键的位置就是鼠标现在的位置，所以不用另算坐标。
 */
function popupGuestContextMenu(guest: Electron.WebContents, window: BrowserWindow, params: Electron.ContextMenuParams): void {
  if (guest.isDestroyed()) return;
  const menuParams: GuestContextMenuParams = {
    x: params.x,
    y: params.y,
    linkURL: params.linkURL,
    srcURL: params.srcURL,
    mediaType: params.mediaType,
    selectionText: params.selectionText,
    isEditable: params.isEditable,
    pageURL: params.pageURL,
    editFlags: {
      canCut: params.editFlags.canCut,
      canCopy: params.editFlags.canCopy,
      canPaste: params.editFlags.canPaste,
      canSelectAll: params.editFlags.canSelectAll,
    },
  };
  const history = guest.navigationHistory;
  const items = browserContextMenuItems(menuParams, {
    canGoBack: history.canGoBack(),
    canGoForward: history.canGoForward(),
  });
  const template = items.map((item) => item.type === "separator"
    ? { type: "separator" as const }
    : {
      label: item.label,
      enabled: item.enabled,
      click: () => {
        if (guest.isDestroyed() || !item.action) return;
        runContextMenuAction(item.action, menuParams, {
          copyToClipboard: (text) => clipboard.writeText(text),
          copyImageAt: (x, y) => guest.copyImageAt(x, y),
          cut: () => guest.cut(),
          copy: () => guest.copy(),
          paste: () => guest.paste(),
          selectAll: () => guest.selectAll(),
          goBack: () => { if (history.canGoBack()) history.goBack(); },
          goForward: () => { if (history.canGoForward()) history.goForward(); },
          reload: () => guest.reload(),
          inspectElement: (x, y) => guest.inspectElement(x, y),
        });
      },
    });
  if (window.isDestroyed()) return;
  Menu.buildFromTemplate(template).popup({ window });
}

let primaryWindow: BrowserWindow | undefined;
let disposeBubble: (() => void) | undefined;

async function createWindow(): Promise<void> {
  const platform = currentPlatform(process.platform);
  const iconForCurrentTheme = () => nativeImage.createFromPath(appIconPath({
    dark: nativeTheme.shouldUseDarkColors,
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    mainDirectory: __dirname,
  }));
  const initialIcon = iconForCurrentTheme();
  const mainWindow = new BrowserWindow({
    width: 1024,
    height: 720,
    minWidth: 395,
    minHeight: 500,
    show: false,
    backgroundColor: windowBackgroundColor(WINDOW_BACKGROUND[nativeTheme.shouldUseDarkColors ? "dark" : "light"], platform),
    title: "CoilCoil",
    ...(platform !== "darwin" && !initialIcon.isEmpty() ? { icon: initialIcon } : {}),
    ...windowChromeOptions(platform),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      // 内置浏览器的页面都是离屏页面（见 browser-offscreen.ts），不嵌 <webview>：关掉它，
      // 界面里的脚本也就造不出一个自带权限的网页来。
      webviewTag: false,
    },
  });

  if (platform !== "darwin") {
    mainWindow.setMenuBarVisibility(false);
    mainWindow.autoHideMenuBar = true;
  }
  const updateAppIcon = (): void => {
    const icon = iconForCurrentTheme();
    if (icon.isEmpty()) return;
    if (platform === "darwin") app.dock?.setIcon(icon);
    else if (!mainWindow.isDestroyed()) mainWindow.setIcon(icon);
  };
  updateAppIcon();
  nativeTheme.on("updated", updateAppIcon);
  mainWindow.once("closed", () => nativeTheme.off("updated", updateAppIcon));
  // The Renderer draws the window buttons, so it has to know which one to show.
  const publishMaximized = (): void => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(WINDOW_MAXIMIZED_CHANNEL, mainWindow.isMaximized());
  };
  mainWindow.on("maximize", publishMaximized);
  mainWindow.on("unmaximize", publishMaximized);

  // 窗口级的焦点，用来让纯装饰的动画在没人看的时候停下来（见 renderer 的
  // `idle-motion.ts`）。这件事必须由主进程来判断：内置浏览器的页面是挂在同一个
  // 窗口里的独立 WebContents，焦点落进去时 Renderer 自己的 window 会收到 blur，
  // 照那个信号停就会在用户正浏览网页时把界面上的动画停掉。BrowserWindow 的
  // focus/blur 只在整个窗口失去焦点时才触发，正是我们要的那个语义。
  const publishFocus = (focused: boolean) => (): void => {
    if (mainWindow.isDestroyed()) return;
    diagnosticLog().info("window-drag", focused ? "window_focus" : "window_blur", {
      focused,
      bounds: mainWindow.getBounds(),
      minimized: mainWindow.isMinimized(),
      maximized: mainWindow.isMaximized(),
      fullScreen: mainWindow.isFullScreen(),
    });
    mainWindow.webContents.send(WINDOW_FOCUS_CHANNEL, focused);
  };
  mainWindow.on("focus", publishFocus(true));
  mainWindow.on("blur", publishFocus(false));

  // A renderer can only tell us about presses that escape the native drag
  // region. These main-process events are the other half of the record: if a
  // user reports a failed drag but there is no renderer press, we can now see
  // whether the native window ever entered a move sequence. Throttle the live
  // `move` stream so a long drag does not drown out the useful state changes.
  let lastWindowMoveLogAt = 0;
  const logWindowMove = (event: "move" | "moved"): void => {
    const now = Date.now();
    if (event === "move" && now - lastWindowMoveLogAt < 250) return;
    lastWindowMoveLogAt = now;
    if (mainWindow.isDestroyed()) return;
    diagnosticLog().info("window-drag", `window_${event}`, {
      bounds: mainWindow.getBounds(),
      focused: mainWindow.isFocused(),
      minimized: mainWindow.isMinimized(),
      maximized: mainWindow.isMaximized(),
      fullScreen: mainWindow.isFullScreen(),
    });
  };
  mainWindow.on("move", () => logWindowMove("move"));
  mainWindow.on("moved", () => logWindowMove("moved"));

  const browserRuntime = new BrowserRuntimeManager(mainWindow, (state) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(BROWSER_STATE_CHANNEL, state);
    // 手机看的是同一个浏览器：标签开了关了、地址变了，那边也得跟着变，否则它只能
    // 看到自己刚打开面板那一刻的样子。
    remoteAccess?.broadcast(BROWSER_STATE_CHANNEL, state);
  }, (scopeId) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(BROWSER_AGENT_ACTIVATED_CHANNEL, scopeId);
    remoteAccess?.broadcast(BROWSER_AGENT_ACTIVATED_CHANNEL, scopeId);
  }, (contents, params) => popupGuestContextMenu(contents, mainWindow, params));
  const terminalRuntime = new TerminalRuntimeManager((state) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(TERMINAL_STATE_CHANNEL, state);
    remoteAccess?.broadcast(TERMINAL_STATE_CHANNEL, state);
  }, (id, data) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(TERMINAL_DATA_CHANNEL, { id, data });
    remoteAccess?.broadcast(TERMINAL_DATA_CHANNEL, { id, data });
  });
  installHostNavigationGuard(mainWindow, browserRuntime, (scopeId) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(BROWSER_AGENT_ACTIVATED_CHANNEL, scopeId);
  });
  await browserRuntime.start();
  if (process.env.COILCOIL_BROWSER_PROBE_LOG === "1") {
    console.error("[browser-probe]", JSON.stringify({
      devtoolsEndpoint: browserRuntime.endpoint(),
      token: browserRuntime.token,
    }));
  }
  const ownerWebContentsId = mainWindow.webContents.id;
  browserRuntimes.set(ownerWebContentsId, browserRuntime);
  terminalRuntimes.set(ownerWebContentsId, terminalRuntime);
  primaryBrowserRuntime ??= browserRuntime;
  primaryTerminalRuntime ??= terminalRuntime;
  mainWindow.once("closed", () => {
    browserRuntimes.delete(ownerWebContentsId);
    terminalRuntimes.delete(ownerWebContentsId);
    if (primaryTerminalRuntime === terminalRuntime) {
      primaryTerminalRuntime = terminalRuntimes.values().next().value;
    }
    if (primaryBrowserRuntime === browserRuntime) {
      runtime.stop();
      primaryBrowserRuntime = browserRuntimes.values().next().value;
      if (primaryBrowserRuntime && !isQuitting) runtime.start();
    }
    void browserRuntime.dispose().catch((error) => console.error("[browser] 关闭运行时失败", error));
    terminalRuntime.dispose();
  });

  // Diagnostic for the report that an agent driving the browser raises — and even
  // un-minimizes — the app window. Pair this with COILCOIL_BROWSER_CDP_LOG=1 and
  // read the last CDP command before the event. The window coming forward while
  // an agent works in the background is the symptom; the command that provoked
  // it is the answer. A stack trace cannot give it — `focus` is a native event
  // with no JS caller, which is why the stderr-only probe this replaces never
  // settled it — so record what the agent had just asked the browser to do
  // instead, and keep it where the user can reach it rather than in a stream a
  // packaged app throws away.
  //
  // 163 entries in, the record still could not answer the question, because it
  // counted our own reveals too: startup, and the bubble — which is clicked
  // precisely while an agent is working, so every one of those looked like the
  // bug. `markDeliberateReveal` fences them off. What still lands here after
  // this is Chromium promoting a guest, with nobody in this process asking.
  let deliberateRevealAt = 0;
  const markDeliberateReveal = (): void => {
    deliberateRevealAt = Date.now();
  };
  const logActivation = (event: string) => () => {
    if (Date.now() - deliberateRevealAt < DELIBERATE_REVEAL_WINDOW_MS) return;
    const recent = browserRuntime.recentCdpCommands();
    // Nothing from an agent recently means the user raised the window themselves.
    if (!recent.some((entry) => entry.msAgo < WINDOW_ACTIVATION_ATTRIBUTION_MS)) return;
    diagnosticLog().warn("window-activation", "window_activated_during_agent_browsing", {
      event,
      minimized: mainWindow.isMinimized(),
      visible: mainWindow.isVisible(),
      recentCdp: recent,
    });
  };
  mainWindow.on("focus", logActivation("focus"));
  mainWindow.on("show", logActivation("show"));
  mainWindow.on("restore", logActivation("restore"));

  // `once`, not `on`. Electron re-emits this on the window every time a new
  // WebContents inside it becomes ready to display (the built-in browser used to
  // create one per page), which made the app show itself while an Agent opened
  // pages in the background. Showing the window is a startup step; it happens
  // exactly once.
  // 透明度在 show() 之前落下去，否则窗口会先按不透明画出来再跳一下。
  // 不再用 BrowserWindow.setOpacity() 做透明：它会连同文字一起变淡。
  // 透明效果由渲染层的表面毛玻璃控制，窗口本身保持不透明，避免启动时出现一帧旧透明度。
  mainWindow.setOpacity(1);
  mainWindow.once("ready-to-show", () => {
    markDeliberateReveal();
    mainWindow.show();
  });
  loadRendererInto(mainWindow);
  primaryWindow = mainWindow;
  mainWindow.once("closed", () => {
    if (primaryWindow !== mainWindow) return;
    primaryWindow = undefined;
    // The bubble only ever hides, so it would keep the app alive on platforms
    // that quit with the last window. Closing the workspace closes it too.
    disposeBubble?.();
    disposeBubble = undefined;
  });
  disposeBubble?.();
  disposeBubble = setupBubbleWindow({
    preloadPath: join(__dirname, "../preload/index.cjs"),
    // The bubble is the same renderer bundle: the hash is what makes it draw the
    // compact view instead of the full workspace.
    loadRenderer: (window) => loadRendererInto(window, "bubble"),
    revealMainWindow: (target) => {
      const window = primaryWindow;
      if (!window || window.isDestroyed()) return;
      markDeliberateReveal();
      // Only move what is actually out of place. Calling show() on a window that
      // is already up still raises it over whatever the user put in front of it,
      // and still emits the events the activation diagnostic reads.
      if (window.isMinimized()) window.restore();
      if (!window.isVisible()) window.show();
      if (!window.isFocused()) window.focus();
      if (target) window.webContents.send(BUBBLE_OPEN_SESSION_CHANNEL, target);
    },
  });
}

/**
 * CoilCoil 自己的窗口。
 *
 * 内置浏览器里 Agent 用的标签页是隐藏的离屏窗口（见 browser-offscreen.ts），装的是
 * 任意网页。广播对话事件、设置状态这类消息只能发给 App 自己的窗口，不能落进网页的
 * 渲染进程；「还有没有窗口」这类判断也只算 App 窗口。
 */
function appWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed() && !window.webContents.isOffscreen());
}

function loadRendererInto(window: BrowserWindow, hash?: string): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(hash ? `${process.env.ELECTRON_RENDERER_URL}#${hash}` : process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"), hash ? { hash } : undefined);
  }
}

/**
 * Offer an update, once per build.
 *
 * Notify only: the macOS packages are unsigned, so nothing can install them for
 * the user. Re-offering the same version on every six-hour tick would turn a
 * helpful popup into a nuisance, so a declined version stays declined until a
 * newer one is published.
 */
let offeredUpdate: string | undefined;

function offerUpdate(update: UpdateAvailable): void {
  if (offeredUpdate === update.latest) return;
  offeredUpdate = update.latest;
  for (const window of appWindows()) {
    if (!window.isDestroyed()) window.webContents.send(UPDATE_AVAILABLE_CHANNEL, update);
  }
  remoteAccess?.broadcast(UPDATE_AVAILABLE_CHANNEL, update);
}


function scheduleUpdateChecks(): void {
  // The end-to-end runs start the app with this set: a "new version" dialog that depends on what
  // GitHub says that day would cover the window and break whatever the run is doing.
  if (process.env.COILCOIL_DISABLE_UPDATE_CHECK === "1") return;
  // A failed check is not worth telling anyone about: the user did not ask for
  // it, and an offline machine would otherwise raise a dialog about GitHub.
  const run = (): void => {
    void checkForUpdate(app.getVersion())
      .then((update) => { if (update) return offerUpdate(update); })
      .catch(() => undefined);
  };
  const first = setTimeout(run, UPDATE_FIRST_CHECK_MS);
  const repeat = setInterval(run, UPDATE_INTERVAL_MS);
  first.unref?.();
  repeat.unref?.();
}

app.whenReady().then(async () => {
  const log = diagnosticLog();
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate(currentPlatform(process.platform))));
  // Not fatal on purpose: taking the whole app down over one broken operation
  // is a worse outcome than carrying on with the failure written down.
  installProcessErrorHandlers(log, { exitOnUncaught: false });
  log.info("process", "app_started", processStartupData({
    version: app.getVersion(),
    packaged: app.isPackaged,
    locale: app.getLocale(),
  }));
  try {
    const migration = migrateLegacyUserData(app.getPath("userData"));
    if (migration.migrated) {
      console.info(`[migration] copied legacy data from ${migration.source} (${migration.copied.length} entries)`);
    }
  } catch (error) {
    console.error("[migration] legacy data migration failed; starting with current data", error);
  }
  // 内置浏览器对外报的身份：默认 UA 里带着 Electron 那一段，Google 一类的站点
  // 会据此判定成自动化程序，同一条网络下系统 Chrome 没事、内置浏览器每次都要过
  // 人机验证。这里趁 session 还没被任何页面用过就换掉。
  configureBrowserIdentity(session.fromPartition(BROWSER_PARTITION), {
    platform: process.platform,
    platformVersion: process.getSystemVersion(),
    architecture: process.arch,
    locale: app.getLocale(),
  });

  // 没有哪个窗口该嵌 <webview>（内置浏览器全是离屏页面）。各窗口都关了 webviewTag，这里
  // 再兜一层底：以后谁的 webPreferences 默认值变了，也挂不上。
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });

  ipcMain.handle(MCP_TEST_CHANNEL, async (_event, input: McpConnectionTestInput) => testMcpConnection(input));
  ipcMain.handle(APP_VERSION_CHANNEL, (): string => app.getVersion());
  ipcMain.handle(PROJECT_HOME_CHANNEL, () => homeProject());
  ipcMain.handle(PROJECT_SELECT_CHANNEL, async (event): Promise<ProjectSelection | null> => {
    const result = await dialog.showOpenDialog({
      title: "打开项目",
      properties: ["openDirectory"],
    });
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    // Memory is filed by project name alone, so two same-named folders would
    // share one memory. Rather than give the store an identity of its own, the
    // person importing the folder decides. See workspace-name-guard.ts.
    const open = readMountedProjects(mountedProjectsFile())
      .map((project) => ({ name: memoryBucketName(project.path), path: project.path }));
    const verdict = checkWorkspaceName(
      { name: memoryBucketName(path), path },
      open,
      rememberedMemoryNames(join(app.getPath("userData"), "agent", "memory")),
    );
    const prompt = workspaceNamePrompt(verdict);
    if (prompt) {
      const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const options = { ...prompt, defaultId: prompt.proceedId ?? 0, cancelId: 0 };
      const answer = owner
        ? await dialog.showMessageBox(owner, options)
        : await dialog.showMessageBox(options);
      if (prompt.proceedId === undefined || answer.response !== prompt.proceedId) return null;
    }
    return { name: basename(path), path, kind: "workspace" };
  });
  ipcMain.handle(PICK_DIRECTORY_CHANNEL, async (_event, options?: { title?: string }): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: typeof options?.title === "string" && options.title.trim() ? options.title.trim() : "选择目录",
      properties: ["openDirectory"],
    });
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    return path;
  });
  ipcMain.handle(WINDOW_MINIMUM_WIDTH_CHANNEL, (event, requestedWidth: number): void => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !Number.isFinite(requestedWidth)) return;
    const [, minimumHeight] = window.getMinimumSize();
    window.setMinimumSize(Math.max(315, Math.ceil(requestedWidth)), minimumHeight);
  });
  /**
   * Make room for a panel by widening the window rather than by squeezing the
   * conversation. Growth goes to the right; when that hits the edge of the
   * display the window slides left instead, and it never exceeds the work area.
   * A maximized or full-screen window has no room to give, so it is left alone.
   */
  // 渲染进程应用主题后同步窗口底色，否则暗色下缩放窗口会露出浅色画布。
  ipcMain.handle(WINDOW_BACKGROUND_CHANNEL, (event, color: string): void => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return;
    if (typeof color !== "string" || !CSS_COLOR.test(color.trim())) return;
    window.setBackgroundColor(windowBackgroundColor(color.trim(), currentPlatform(process.platform)));
  });
  /**
   * Dock 角标：有几个对话回复完了还没看。
   *
   * 只有未读会计数，运行中的不算——角标问的是「有几件事等着你」，还在跑的那些
   * 不需要你做任何事。0 要显式清掉，否则上一次的数字会一直挂在图标上。
   */
  ipcMain.handle(MOUNTED_PROJECTS_CHANNEL, () => readMountedProjects(mountedProjectsFile()));
  ipcMain.handle(MOUNTED_PROJECTS_SET_CHANNEL, (_event, projects: unknown) =>
    writeMountedProjects(mountedProjectsFile(), projects));
  ipcMain.handle(BADGE_COUNT_CHANNEL, (_event, count: number): void => {
    const unread = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    // 角标的红底白字是系统画的，跟界面里那两个未读点无关：用户要的是界面里别用
    // 红色，Dock 上保持红色未读数。这里不去改它，也没有 API 能改它的颜色。
    // Linux 上只有部分桌面环境实现得了，setBadgeCount 会返回 false，不是错误。
    app.setBadgeCount(unread);
  });
  // 整窗透明度，见 window-opacity.ts 里为什么不用 vibrancy。
  // 只作用在发起设置的那扇窗（也就是主窗）：气泡窗是本来就以 transparent 创建
  // 的浮层，再叠一层整窗透明会把它自己的投影一起透掉。
  ipcMain.handle(WINDOW_OPACITY_CHANNEL, (event, opacity: number): number => {
    const applied = writeStoredWindowOpacity(windowOpacityFile(), opacity);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && !window.isDestroyed()) window.setOpacity(applied);
    return applied;
  });
  ipcMain.handle(WINDOW_GROW_WIDTH_CHANNEL, (event, byPixels: number): void => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed() || window.isMaximized() || window.isFullScreen()) return;
    if (!Number.isFinite(byPixels) || byPixels <= 0) return;
    const bounds = window.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const width = Math.min(bounds.width + Math.ceil(byPixels), area.width);
    if (width <= bounds.width) return;
    const x = Math.max(area.x, Math.min(bounds.x, area.x + area.width - width));
    window.setBounds({ ...bounds, x, width });
  });
  // What an absolute path in the transcript actually is, so a link can be drawn
  // and routed as the file or the folder it points at.
  ipcMain.handle(PATH_CLASSIFY_CHANNEL, (_event, paths: string[]) => classifyPaths(paths));
  // A folder belongs to the file manager: the right-hand panel is the workspace
  // tree and single-file previews, not a second file browser.
  ipcMain.handle(PATH_REVEAL_CHANNEL, async (_event, rawPath: string): Promise<boolean> => {
    if (typeof rawPath !== "string" || !rawPath.trim() || !isAbsolute(rawPath)) throw new Error("路径无效。");
    const target = resolve(rawPath);
    const stats = await stat(target).catch(() => undefined);
    if (!stats) throw new Error("路径不存在或已被移动。");
    if (stats.isDirectory()) {
      const error = await shell.openPath(target);
      if (error) throw new Error(error);
      return true;
    }
    shell.showItemInFolder(target);
    return true;
  });
  ipcMain.handle(EXTERNAL_OPEN_CHANNEL, async (_event, rawUrl: string): Promise<void> => {
    if (typeof rawUrl !== "string") throw new Error("授权地址无效。");
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("只允许打开 HTTP 或 HTTPS 授权地址。");
    await shell.openExternal(url.toString());
  });
  ipcMain.handle(CLIPBOARD_WRITE_CHANNEL, (_event, text: string): void => {
    if (typeof text !== "string" || text.length > 1_000_000) throw new Error("剪贴板内容无效。");
    clipboard.writeText(text);
  });
  ipcMain.handle(PREVIEW_OPEN_CHANNEL, (event, input: OpenFilePreviewInput) => openFilePreview(windowPreviewOwner(event.sender), input, safePreviewPath));
  ipcMain.handle(PREVIEW_CLOSE_CHANNEL, (event, id: string): void => {
    closeFilePreview(event.sender.id, id);
  });
  ipcMain.handle(PROJECT_FILE_ACTION_CHANNEL, (event, input: ProjectFileActionInput) => performProjectFileAction(event, input));
  ipcMain.handle(PROJECT_FILE_SAVE_CHANNEL, (_event, input: SaveProjectFileInput) => saveProjectFile(input, safeProjectPath));
  ipcMain.handle(PROJECT_DIRECTORY_LIST_CHANNEL, (_event, root: string, path?: string) => listProjectDirectory(root, path));
  const browserFor = (event: Electron.IpcMainInvokeEvent): BrowserRuntimeManager => {
    const value = browserRuntimes.get(event.sender.id);
    if (!value) throw new Error("内置浏览器运行时不可用。");
    return value;
  };
  ipcMain.handle(BROWSER_SET_SCOPE_CHANNEL, (event, scopeId: string, workspacePath?: string) =>
    browserFor(event).setUiScope(scopeId, workspacePath));
  ipcMain.handle(BROWSER_GET_STATE_CHANNEL, (event, scopeId: string) => browserFor(event).state(scopeId));
  ipcMain.handle(BROWSER_CAPTURE_CHANNEL, (event, scopeId: string) => browserFor(event).captureTab(scopeId));
  ipcMain.handle(BROWSER_PICK_ELEMENT_CHANNEL, (event, scopeId: string) => browserFor(event).pickElement(scopeId));
  ipcMain.handle(BROWSER_CANCEL_PICK_CHANNEL, (event): void => browserFor(event).cancelElementPick());
  ipcMain.handle(BROWSER_CREATE_TAB_CHANNEL, (event, scopeId: string, url?: string, placeholder?: boolean) => browserFor(event).createTab(url, true, scopeId, placeholder === true));
  ipcMain.handle(BROWSER_SELECT_TAB_CHANNEL, (event, scopeId: string, id: string) => browserFor(event).selectTab(id, scopeId));
  ipcMain.handle(BROWSER_CLOSE_TAB_CHANNEL, (event, scopeId: string, id: string) => browserFor(event).closeTab(id, scopeId));
  ipcMain.handle(BROWSER_NAVIGATE_CHANNEL, (event, scopeId: string, url: string) => browserFor(event).navigate(url, scopeId));
  ipcMain.handle(BROWSER_ZOOM_CHANNEL, (event, scopeId: string, step: "in" | "out" | "reset") => browserFor(event).setZoom(step, scopeId));
  ipcMain.handle(BROWSER_BACK_CHANNEL, (event, scopeId: string) => browserFor(event).back(scopeId));
  ipcMain.handle(BROWSER_FORWARD_CHANNEL, (event, scopeId: string) => browserFor(event).forward(scopeId));
  ipcMain.handle(BROWSER_RELOAD_CHANNEL, (event, scopeId: string) => browserFor(event).reload(scopeId));
  ipcMain.handle(BROWSER_IMPORT_LIST_CHANNEL, () => listImportableProfiles());
  // 每次都现探一遍：用户可能刚在系统设置里改完就切回来。
  ipcMain.handle(MAC_PERMISSIONS_CHANNEL, () => macPermissions());
  // 目的地在 mac-permissions 的表里写死，调用方只能递一个已知的 id——这条绕过了
  // openExternal 的协议白名单，不能让任何外来字符串走到 shell 那里。
  ipcMain.handle(OPEN_FULL_DISK_ACCESS_CHANNEL, (_event, id: MacPermissionId) => openPermissionSettings(id));
  // 登录状态是按工作区存的，所以导入、统计、清空都冲当前这个窗口的那一份去。
  ipcMain.handle(BROWSER_IMPORT_COOKIES_CHANNEL, (event, input: ImportBrowserCookiesInput) =>
    importBrowserCookies(input, browserFor(event).partitionName()));
  ipcMain.handle(BROWSER_DATA_STATS_CHANNEL, (event) => browserDataStats(browserFor(event).partitionName()));
  ipcMain.handle(BROWSER_SAVED_LOGINS_CHANNEL, (event) => savedLogins(browserFor(event).partitionName()));
  // 清空不带分区：它清的是每一份 cookie jar，不是当前工作区那一份。
  ipcMain.handle(BROWSER_DATA_CLEAR_CHANNEL, () => clearBrowserData(
    (name, data) => diagnosticLog().info("browser-data", name, data),
  ));
  ipcMain.handle(BROWSER_UI_VIEWPORT_CHANNEL, (event, viewport: BrowserUiViewport): void => {
    // Renderer cleanup can race the window's closed event during dev reload/quit.
    browserRuntimes.get(event.sender.id)?.setUiViewport(viewport);
  });
  ipcMain.handle(BROWSER_DIALOG_REPLY_CHANNEL, (event, scopeId: unknown, tabId: unknown, dialogId: unknown, accept: unknown, text: unknown): void => {
    browserFor(event).replyDialog(String(scopeId), String(tabId), String(dialogId), accept === true, String(text ?? ""));
  });
  // 查找栏打一个字搜一次，走单向消息；内容由运行时核对。
  ipcMain.on(BROWSER_FIND_CHANNEL, (event, scopeId: unknown, tabId: unknown, request: unknown) => {
    browserRuntimes.get(event.sender.id)?.findInPage(String(scopeId), String(tabId), request);
  });
  ipcMain.on(BROWSER_DROP_FILES_CHANNEL, (event, scopeId: unknown, tabId: unknown, drop: unknown, paths: unknown) => {
    browserRuntimes.get(event.sender.id)?.dropFiles(String(scopeId), String(tabId), drop, paths);
  });
  ipcMain.handle(BROWSER_TOOLTIP_CHANNEL, (event, scopeId: unknown, tabId: unknown, point: unknown) =>
    browserRuntimes.get(event.sender.id)?.tooltipAt(String(scopeId), String(tabId), point) ?? null);
  ipcMain.handle(BROWSER_CARET_CHANNEL, (event, scopeId: unknown, tabId: unknown) =>
    browserRuntimes.get(event.sender.id)?.caretOf(String(scopeId), String(tabId)) ?? null);
  ipcMain.handle(BROWSER_VALUE_CHOOSE_CHANNEL, (event, scopeId: unknown, tabId: unknown, pickerId: unknown, value: unknown, final: unknown): Promise<void> =>
    browserFor(event).chooseValue(String(scopeId), String(tabId), String(pickerId), typeof value === "string" ? value : null, final === true));
  ipcMain.handle(BROWSER_SELECT_CHOOSE_CHANNEL, (event, scopeId: unknown, tabId: unknown, pickerId: unknown, index: unknown): Promise<void> =>
    browserFor(event).chooseSelect(String(scopeId), String(tabId), String(pickerId), typeof index === "number" && Number.isFinite(index) ? index : null));
  // 用户对面板里页面的操作：鼠标移动一秒几十次，走单向消息，不等回音。内容由运行时逐项核对。
  ipcMain.on(BROWSER_INPUT_CHANNEL, (event, scopeId: unknown, tabId: unknown, input: unknown): void => {
    if (typeof scopeId !== "string" || typeof tabId !== "string") return;
    browserRuntimes.get(event.sender.id)?.forwardInput(scopeId, tabId, input);
  });
  const terminalFor = (event: Electron.IpcMainInvokeEvent): TerminalRuntimeManager => {
    const value = terminalRuntimes.get(event.sender.id);
    if (!value) throw new Error("终端运行时不可用。");
    return value;
  };
  ipcMain.handle(TERMINAL_GET_CHANNEL, (event) => terminalFor(event).state());
  ipcMain.handle(TERMINAL_CREATE_CHANNEL, (event, cwd: string) => terminalFor(event).create(cwd));
  ipcMain.handle(TERMINAL_WRITE_CHANNEL, (event, id: string, data: string): void => terminalFor(event).write(id, data));
  ipcMain.handle(TERMINAL_RESIZE_CHANNEL, (event, id: string, cols: number, rows: number): void => terminalFor(event).resize(id, cols, rows));
  ipcMain.handle(TERMINAL_CLOSE_CHANNEL, (event, id: string) => terminalFor(event).close(id));
  // The Renderer cannot write files. Its entries ride over here and join the
  // main process's own, so one file holds all three processes in time order.
  // The window buttons on Windows and Linux are drawn by the Renderer, so the
  // three things a title bar does have to be reachable from it.
  const senderWindow = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): BrowserWindow | null => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return window && !window.isDestroyed() ? window : null;
  };
  ipcMain.on(WINDOW_MINIMIZE_CHANNEL, (event) => senderWindow(event)?.minimize());
  ipcMain.on(WINDOW_CLOSE_CHANNEL, (event) => senderWindow(event)?.close());
  ipcMain.on(WINDOW_TOGGLE_MAXIMIZED_CHANNEL, (event) => {
    const window = senderWindow(event);
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.handle(WINDOW_IS_MAXIMIZED_CHANNEL, (event) => senderWindow(event)?.isMaximized() ?? false);

  ipcMain.on(DIAGNOSTIC_LOG_CHANNEL, (_event, batch: DiagnosticLogBatch) => {
    if (!Array.isArray(batch?.entries)) return;
    diagnosticLog().writeEntries(batch.entries);
  });

  ipcMain.handle(DIAGNOSTIC_REVEAL_CHANNEL, async (): Promise<string> => {
    const log = diagnosticLog();
    shell.showItemInFolder(log.filePath);
    return log.filePath;
  });

  ipcMain.handle(REMOTE_GET_CHANNEL, () => remoteController().state());
  ipcMain.handle(REMOTE_SAVE_CHANNEL, (_event, input: RemoteAccessInput) => remoteController().apply(input ?? {}));
  ipcMain.handle(REMOTE_NEW_CODE_CHANNEL, () => remoteController().regenerateCode());
  ipcMain.handle(REMOTE_ACCOUNT_CHANNEL, (_event, username: string, password: string) => remoteController().setAccount(username ?? "", password ?? ""));
  ipcMain.handle(REMOTE_REVOKE_CHANNEL, () => remoteController().revokeDevices());

  ipcMain.handle(RUNTIME_REQUEST_CHANNEL, async (event, payload: RuntimeRequestPayload): Promise<RuntimeRequestResult> => {
    try {
      const value = await runtime.request(payload);
      handDraftTabsToNewSession(browserRuntimes.get(event.sender.id), payload.command, value);
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  await createWindow();
  scheduleUpdateChecks();
  // Resolved before the first spawn so the runtime never starts a session on a
  // direct connection it will lose the moment another tunnel takes the route.
  const noteProxy = (event: string, data: Record<string, unknown>): void => diagnosticLog().info("network", event, data);
  await refreshProxyEnvironment(noteProxy);
  // A VPN that comes up after launch should be picked up without a relaunch;
  // the value is read again every time the runtime child is spawned.
  setInterval(() => { void refreshProxyEnvironment(noteProxy); }, 45_000).unref();
  runtime.start();
  void remoteController().start();
  app.on("activate", () => {
    if (appWindows().length === 0) {
      void createWindow()
        .then(() => runtime.start())
        .catch((error) => diagnosticLog().error("window", "reactivate_failed", error));
    }
  });
});

app.on("before-quit", () => {
  if (isQuitting) return;
  isQuitting = true;
  closeAllFilePreviews();
  for (const browser of browserRuntimes.values()) void browser.dispose().catch(() => {});
  for (const terminal of terminalRuntimes.values()) terminal.dispose();
  browserRuntimes.clear();
  terminalRuntimes.clear();
  remoteAccess?.stop();
  remoteAccess = undefined;
  runtime.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
