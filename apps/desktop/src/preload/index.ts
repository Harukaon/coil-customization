import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { DiagnosticLogBatch, RuntimeCommand, RuntimeEvent } from "@coilcoil/runtime-protocol";
import type { FileNode } from "@coilcoil/runtime-protocol";
import type {
  BrowserCaret,
  BrowserDataStats,
  BrowserElementSelection,
  BrowserFindRequest,
  BrowserInputModifiers,
  BrowserImportSummary,
  BrowserPageEvent,
  BrowserPageInput,
  BrowserStateSnapshot,
  BrowserUiViewport,
  BubbleSessionTarget,
  BubbleShortcutState,
  CoilCoilDesktopApi,
  DesktopPlatform,
  FilePreviewDocument,
  ImportableProfile,
  ImportBrowserCookiesInput,
  MacPermissionId,
  MacPermissions,
  McpConnectionTest,
  McpConnectionTestInput,
  OpenFilePreviewInput,
  OpenFilePreviewResult,
  PathKind,
  ProjectFileActionInput,
  ProjectFileActionResult,
  ProjectSelection,
  RemoteAccessInput,
  RemoteAccessState,
  RuntimeEventPayload,
  RuntimeRequestPayload,
  RuntimeRequestResult,
  SavedLoginSummary,
  SaveProjectFileInput,
  SaveProjectFileResult,
  TerminalDataEvent,
  TerminalSessionSnapshot,
  UpdateAvailable,
} from "../shared/desktop-api";
import { attachBrowserSurface } from "./browser-surfaces";

const PROJECT_SELECT_CHANNEL = "project:select";
const PROJECT_HOME_CHANNEL = "project:home";
const APP_VERSION_CHANNEL = "app:version";
const PATH_CLASSIFY_CHANNEL = "path:classify";
const PATH_REVEAL_CHANNEL = "path:reveal";
const MCP_TEST_CHANNEL = "mcp:test-connection";
const BUBBLE_GET_SHORTCUT_CHANNEL = "bubble:get-shortcut";
const BUBBLE_SET_SHORTCUT_CHANNEL = "bubble:set-shortcut";
const BUBBLE_HIDE_CHANNEL = "bubble:hide";
const BUBBLE_OPEN_MAIN_CHANNEL = "bubble:open-main";
const BUBBLE_OPEN_SESSION_CHANNEL = "bubble:open-session";
const PICK_DIRECTORY_CHANNEL = "dialog:pick-directory";
const WINDOW_MINIMUM_WIDTH_CHANNEL = "window:minimum-width";
const WINDOW_GROW_WIDTH_CHANNEL = "window:grow-width";
const WINDOW_BACKGROUND_CHANNEL = "window:background";
const WINDOW_OPACITY_CHANNEL = "window:opacity";
const BADGE_COUNT_CHANNEL = "app:badge-count";
const EXTERNAL_OPEN_CHANNEL = "external:open";
const CLIPBOARD_WRITE_CHANNEL = "clipboard:write";
const RUNTIME_REQUEST_CHANNEL = "runtime:request";
const RUNTIME_EVENT_CHANNEL = "runtime:event";
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
const PREVIEW_UPDATED_CHANNEL = "preview:updated";
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
const BROWSER_INPUT_CHANNEL = "browser:input";
const BROWSER_PAGE_EVENT_CHANNEL = "browser:page-event";
const BROWSER_DIALOG_REPLY_CHANNEL = "browser:dialog-reply";
const BROWSER_SELECT_CHOOSE_CHANNEL = "browser:select-choose";
const BROWSER_VALUE_CHOOSE_CHANNEL = "browser:value-choose";
const BROWSER_FIND_CHANNEL = "browser:find";
const BROWSER_CARET_CHANNEL = "browser:caret";
const BROWSER_TOOLTIP_CHANNEL = "browser:tooltip";
const BROWSER_DROP_FILES_CHANNEL = "browser:drop-files";
const BROWSER_NAVIGATE_CHANNEL = "browser:navigate";
const BROWSER_ZOOM_CHANNEL = "browser:zoom";
const BROWSER_BACK_CHANNEL = "browser:back";
const BROWSER_FORWARD_CHANNEL = "browser:forward";
const BROWSER_RELOAD_CHANNEL = "browser:reload";
const BROWSER_UI_VIEWPORT_CHANNEL = "browser:ui-viewport";
const MOUNTED_PROJECTS_CHANNEL = "projects:mounted";
const MOUNTED_PROJECTS_SET_CHANNEL = "projects:mounted:set";
type MountedProject = { name: string; path: string; kind: "workspace" };
const BROWSER_IMPORT_LIST_CHANNEL = "browser:import-list";
const OPEN_FULL_DISK_ACCESS_CHANNEL = "system:open-full-disk-access";
const MAC_PERMISSIONS_CHANNEL = "system:mac-permissions";
const BROWSER_IMPORT_COOKIES_CHANNEL = "browser:import-cookies";
const BROWSER_DATA_STATS_CHANNEL = "browser:data-stats";
const BROWSER_SAVED_LOGINS_CHANNEL = "browser:saved-logins";
const BROWSER_DATA_CLEAR_CHANNEL = "browser:data-clear";
const TERMINAL_STATE_CHANNEL = "terminal:state";
const TERMINAL_DATA_CHANNEL = "terminal:data";
const TERMINAL_GET_CHANNEL = "terminal:get";
const TERMINAL_CREATE_CHANNEL = "terminal:create";
const TERMINAL_WRITE_CHANNEL = "terminal:write";
const TERMINAL_RESIZE_CHANNEL = "terminal:resize";
const TERMINAL_CLOSE_CHANNEL = "terminal:close";
const UPDATE_AVAILABLE_CHANNEL = "update:available";
const REMOTE_GET_CHANNEL = "remote:get";
const REMOTE_SAVE_CHANNEL = "remote:save";
const REMOTE_NEW_CODE_CHANNEL = "remote:new-code";
const REMOTE_ACCOUNT_CHANNEL = "remote:account";
const REMOTE_REVOKE_CHANNEL = "remote:revoke";
const REMOTE_STATE_CHANNEL = "remote:state";

const platform = ((): DesktopPlatform => {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "win32") return "win32";
  return "linux";
})();

const api: CoilCoilDesktopApi = {
  platform,
  appVersion: () => ipcRenderer.invoke(APP_VERSION_CHANNEL) as Promise<string>,
  homeProject: () =>
    ipcRenderer.invoke(PROJECT_HOME_CHANNEL) as Promise<ProjectSelection>,
  selectProject: () =>
    ipcRenderer.invoke(PROJECT_SELECT_CHANNEL) as Promise<ProjectSelection | null>,
  pickDirectory: (options?: { title?: string }) =>
    ipcRenderer.invoke(PICK_DIRECTORY_CHANNEL, options) as Promise<string | null>,
  setWindowMinimumWidth: (width: number) =>
    ipcRenderer.invoke(WINDOW_MINIMUM_WIDTH_CHANNEL, width) as Promise<void>,
  growWindowWidth: (byPixels: number) =>
    ipcRenderer.invoke(WINDOW_GROW_WIDTH_CHANNEL, byPixels) as Promise<void>,
  setWindowBackground: (color: string) =>
    ipcRenderer.invoke(WINDOW_BACKGROUND_CHANNEL, color) as Promise<void>,
  setWindowOpacity: (opacity: number) =>
    ipcRenderer.invoke(WINDOW_OPACITY_CHANNEL, opacity) as Promise<number>,
  setBadgeCount: (count: number) =>
    ipcRenderer.invoke(BADGE_COUNT_CHANNEL, count) as Promise<void>,
  mountedProjects: () =>
    ipcRenderer.invoke(MOUNTED_PROJECTS_CHANNEL) as Promise<MountedProject[]>,
  setMountedProjects: (projects: MountedProject[]) =>
    ipcRenderer.invoke(MOUNTED_PROJECTS_SET_CHANNEL, projects) as Promise<MountedProject[]>,
  // Electron 32 起渲染进程拿不到 File.path，外部拖入文件的真实路径只能在这里解析。
  filePath: (file: File) => webUtils.getPathForFile(file),
  openExternal: (url: string) =>
    ipcRenderer.invoke(EXTERNAL_OPEN_CHANNEL, url) as Promise<void>,
  classifyPaths: (paths: string[]) =>
    ipcRenderer.invoke(PATH_CLASSIFY_CHANNEL, paths) as Promise<Record<string, PathKind>>,
  revealPath: (path: string) =>
    ipcRenderer.invoke(PATH_REVEAL_CHANNEL, path) as Promise<boolean>,
  copyText: (text: string) =>
    ipcRenderer.invoke(CLIPBOARD_WRITE_CHANNEL, text) as Promise<void>,
  openFilePreview: (input: OpenFilePreviewInput) =>
    ipcRenderer.invoke(PREVIEW_OPEN_CHANNEL, input) as Promise<OpenFilePreviewResult>,
  closeFilePreview: (id: string) =>
    ipcRenderer.invoke(PREVIEW_CLOSE_CHANNEL, id) as Promise<void>,
  performProjectFileAction: (input: ProjectFileActionInput) =>
    ipcRenderer.invoke(PROJECT_FILE_ACTION_CHANNEL, input) as Promise<ProjectFileActionResult>,
  saveProjectFile: (input: SaveProjectFileInput) =>
    ipcRenderer.invoke(PROJECT_FILE_SAVE_CHANNEL, input) as Promise<SaveProjectFileResult>,
  testMcpConnection: (input: McpConnectionTestInput) =>
    ipcRenderer.invoke(MCP_TEST_CHANNEL, input) as Promise<McpConnectionTest>,
  getBubbleShortcut: () => ipcRenderer.invoke(BUBBLE_GET_SHORTCUT_CHANNEL) as Promise<BubbleShortcutState>,
  setBubbleShortcut: (accelerator?: string) =>
    ipcRenderer.invoke(BUBBLE_SET_SHORTCUT_CHANNEL, accelerator) as Promise<BubbleShortcutState>,
  hideBubble: () => ipcRenderer.invoke(BUBBLE_HIDE_CHANNEL) as Promise<void>,
  openMainWindow: (target?: BubbleSessionTarget) =>
    ipcRenderer.invoke(BUBBLE_OPEN_MAIN_CHANNEL, target) as Promise<void>,
  onOpenBubbleSession: (listener: (target: BubbleSessionTarget) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, target: BubbleSessionTarget): void => listener(target);
    ipcRenderer.on(BUBBLE_OPEN_SESSION_CHANNEL, handler);
    return () => ipcRenderer.removeListener(BUBBLE_OPEN_SESSION_CHANNEL, handler);
  },
  onFilePreviewUpdated: (listener: (document: FilePreviewDocument) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, document: FilePreviewDocument): void => listener(document);
    ipcRenderer.on(PREVIEW_UPDATED_CHANNEL, handler);
    return () => ipcRenderer.removeListener(PREVIEW_UPDATED_CHANNEL, handler);
  },
  listProjectDirectory: (root: string, path?: string) => ipcRenderer.invoke(PROJECT_DIRECTORY_LIST_CHANNEL, root, path) as Promise<FileNode[]>,
  setBrowserScope: (scopeId: string, workspacePath?: string) =>
    ipcRenderer.invoke(BROWSER_SET_SCOPE_CHANNEL, scopeId, workspacePath) as Promise<BrowserStateSnapshot>,
  getBrowserState: (scopeId: string) => ipcRenderer.invoke(BROWSER_GET_STATE_CHANNEL, scopeId) as Promise<BrowserStateSnapshot>,
  captureBrowserTab: (scopeId: string) => ipcRenderer.invoke(BROWSER_CAPTURE_CHANNEL, scopeId) as Promise<string | undefined>,
  pickBrowserElement: (scopeId: string) =>
    ipcRenderer.invoke(BROWSER_PICK_ELEMENT_CHANNEL, scopeId) as Promise<BrowserElementSelection | undefined>,
  cancelBrowserElementPick: () => ipcRenderer.invoke(BROWSER_CANCEL_PICK_CHANNEL) as Promise<void>,
  createBrowserTab: (scopeId: string, url?: string, placeholder?: boolean) => ipcRenderer.invoke(BROWSER_CREATE_TAB_CHANNEL, scopeId, url, placeholder === true) as Promise<BrowserStateSnapshot>,
  selectBrowserTab: (scopeId: string, id: string) => ipcRenderer.invoke(BROWSER_SELECT_TAB_CHANNEL, scopeId, id) as Promise<BrowserStateSnapshot>,
  closeBrowserTab: (scopeId: string, id: string) => ipcRenderer.invoke(BROWSER_CLOSE_TAB_CHANNEL, scopeId, id) as Promise<BrowserStateSnapshot>,
  navigateBrowser: (scopeId: string, url: string) => ipcRenderer.invoke(BROWSER_NAVIGATE_CHANNEL, scopeId, url) as Promise<BrowserStateSnapshot>,
  setBrowserZoom: (scopeId: string, step: "in" | "out" | "reset") => ipcRenderer.invoke(BROWSER_ZOOM_CHANNEL, scopeId, step) as Promise<BrowserStateSnapshot>,
  browserBack: (scopeId: string) => ipcRenderer.invoke(BROWSER_BACK_CHANNEL, scopeId) as Promise<BrowserStateSnapshot>,
  browserForward: (scopeId: string) => ipcRenderer.invoke(BROWSER_FORWARD_CHANNEL, scopeId) as Promise<BrowserStateSnapshot>,
  reloadBrowser: (scopeId: string) => ipcRenderer.invoke(BROWSER_RELOAD_CHANNEL, scopeId) as Promise<BrowserStateSnapshot>,
  setBrowserUiViewport: (viewport: BrowserUiViewport) => ipcRenderer.invoke(BROWSER_UI_VIEWPORT_CHANNEL, viewport) as Promise<void>,
  listImportableBrowsers: () => ipcRenderer.invoke(BROWSER_IMPORT_LIST_CHANNEL) as Promise<ImportableProfile[]>,
  openPermissionSettings: (id: MacPermissionId) => ipcRenderer.invoke(OPEN_FULL_DISK_ACCESS_CHANNEL, id) as Promise<void>,
  getMacPermissions: () => ipcRenderer.invoke(MAC_PERMISSIONS_CHANNEL) as Promise<MacPermissions>,
  importBrowserCookies: (input: ImportBrowserCookiesInput) =>
    ipcRenderer.invoke(BROWSER_IMPORT_COOKIES_CHANNEL, input) as Promise<BrowserImportSummary>,
  getBrowserDataStats: () => ipcRenderer.invoke(BROWSER_DATA_STATS_CHANNEL) as Promise<BrowserDataStats>,
  listSavedLogins: () => ipcRenderer.invoke(BROWSER_SAVED_LOGINS_CHANNEL) as Promise<SavedLoginSummary[]>,
  clearBrowserData: () => ipcRenderer.invoke(BROWSER_DATA_CLEAR_CHANNEL) as Promise<BrowserDataStats>,
  onBrowserStateUpdated: (listener: (state: BrowserStateSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: BrowserStateSnapshot): void => listener(state);
    ipcRenderer.on(BROWSER_STATE_CHANNEL, handler);
    return () => ipcRenderer.removeListener(BROWSER_STATE_CHANNEL, handler);
  },
  attachBrowserSurface,
  sendBrowserInput: (scopeId: string, tabId: string, input: BrowserPageInput) => {
    ipcRenderer.send(BROWSER_INPUT_CHANNEL, scopeId, tabId, input);
  },
  replyBrowserDialog: (scopeId: string, tabId: string, dialogId: string, accept: boolean, text?: string) =>
    ipcRenderer.invoke(BROWSER_DIALOG_REPLY_CHANNEL, scopeId, tabId, dialogId, accept, text ?? "") as Promise<void>,
  chooseBrowserSelect: (scopeId: string, tabId: string, pickerId: string, index: number | null) =>
    ipcRenderer.invoke(BROWSER_SELECT_CHOOSE_CHANNEL, scopeId, tabId, pickerId, index) as Promise<void>,
  chooseBrowserValue: (scopeId: string, tabId: string, pickerId: string, value: string | null, final: boolean) =>
    ipcRenderer.invoke(BROWSER_VALUE_CHOOSE_CHANNEL, scopeId, tabId, pickerId, value, final) as Promise<void>,
  findInBrowserPage: (scopeId: string, tabId: string, request: BrowserFindRequest) => {
    ipcRenderer.send(BROWSER_FIND_CHANNEL, scopeId, tabId, request);
  },
  dropFilesIntoBrowserPage: (scopeId: string, tabId: string, drop: { x: number; y: number; modifiers: BrowserInputModifiers }, files: File[]) => {
    const paths = Array.from(files, (file) => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return "";
      }
    }).filter(Boolean);
    if (paths.length) ipcRenderer.send(BROWSER_DROP_FILES_CHANNEL, scopeId, tabId, drop, paths);
  },
  readBrowserTooltip: (scopeId: string, tabId: string, point: { x: number; y: number }) =>
    ipcRenderer.invoke(BROWSER_TOOLTIP_CHANNEL, scopeId, tabId, point) as Promise<string | null>,
  readBrowserCaret: (scopeId: string, tabId: string) =>
    ipcRenderer.invoke(BROWSER_CARET_CHANNEL, scopeId, tabId) as Promise<BrowserCaret | null>,
  onBrowserPageEvent: (listener: (event: BrowserPageEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, event: BrowserPageEvent): void => listener(event);
    ipcRenderer.on(BROWSER_PAGE_EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(BROWSER_PAGE_EVENT_CHANNEL, handler);
  },
  onBrowserAgentActivated: (listener: (scopeId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, scopeId: string): void => listener(scopeId);
    ipcRenderer.on(BROWSER_AGENT_ACTIVATED_CHANNEL, handler);
    return () => ipcRenderer.removeListener(BROWSER_AGENT_ACTIVATED_CHANNEL, handler);
  },
  getTerminalSessions: () => ipcRenderer.invoke(TERMINAL_GET_CHANNEL) as Promise<TerminalSessionSnapshot[]>,
  createTerminal: (cwd: string) => ipcRenderer.invoke(TERMINAL_CREATE_CHANNEL, cwd) as Promise<TerminalSessionSnapshot[]>,
  writeTerminal: (id: string, data: string) => ipcRenderer.invoke(TERMINAL_WRITE_CHANNEL, id, data) as Promise<void>,
  resizeTerminal: (id: string, cols: number, rows: number) => ipcRenderer.invoke(TERMINAL_RESIZE_CHANNEL, id, cols, rows) as Promise<void>,
  closeTerminal: (id: string) => ipcRenderer.invoke(TERMINAL_CLOSE_CHANNEL, id) as Promise<TerminalSessionSnapshot[]>,
  onTerminalStateUpdated: (listener: (state: TerminalSessionSnapshot[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: TerminalSessionSnapshot[]): void => listener(state);
    ipcRenderer.on(TERMINAL_STATE_CHANNEL, handler);
    return () => ipcRenderer.removeListener(TERMINAL_STATE_CHANNEL, handler);
  },
  onTerminalData: (listener: (event: TerminalDataEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: TerminalDataEvent): void => listener(value);
    ipcRenderer.on(TERMINAL_DATA_CHANNEL, handler);
    return () => ipcRenderer.removeListener(TERMINAL_DATA_CHANNEL, handler);
  },
  request: async <T>(command: RuntimeCommand, runtimeId?: string): Promise<T> => {
    const result = await ipcRenderer.invoke(
      RUNTIME_REQUEST_CHANNEL,
      { command, runtimeId } satisfies RuntimeRequestPayload,
    ) as RuntimeRequestResult;
    if (!result.ok) throw new Error(result.error);
    return result.value as T;
  },
  minimizeWindow: () => ipcRenderer.send(WINDOW_MINIMIZE_CHANNEL),
  toggleWindowMaximized: () => ipcRenderer.send(WINDOW_TOGGLE_MAXIMIZED_CHANNEL),
  closeWindow: () => ipcRenderer.send(WINDOW_CLOSE_CHANNEL),
  isWindowMaximized: () => ipcRenderer.invoke(WINDOW_IS_MAXIMIZED_CHANNEL) as Promise<boolean>,
  onWindowMaximizedChange: (listener: (maximized: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, maximized: boolean): void => listener(maximized);
    ipcRenderer.on(WINDOW_MAXIMIZED_CHANNEL, handler);
    return () => ipcRenderer.removeListener(WINDOW_MAXIMIZED_CHANNEL, handler);
  },
  onWindowFocusChange: (listener: (focused: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, focused: boolean): void => listener(focused);
    ipcRenderer.on(WINDOW_FOCUS_CHANNEL, handler);
    return () => ipcRenderer.removeListener(WINDOW_FOCUS_CHANNEL, handler);
  },
  /** Fire-and-forget: logging must never be able to stall the Renderer. */
  writeDiagnostics: (batch: DiagnosticLogBatch) => ipcRenderer.send(DIAGNOSTIC_LOG_CHANNEL, batch),
  revealDiagnostics: () => ipcRenderer.invoke(DIAGNOSTIC_REVEAL_CHANNEL) as Promise<string>,
  getRemoteAccess: () => ipcRenderer.invoke(REMOTE_GET_CHANNEL) as Promise<RemoteAccessState>,
  saveRemoteAccess: (input: RemoteAccessInput) => ipcRenderer.invoke(REMOTE_SAVE_CHANNEL, input) as Promise<RemoteAccessState>,
  regenerateRemotePairingCode: () => ipcRenderer.invoke(REMOTE_NEW_CODE_CHANNEL) as Promise<RemoteAccessState>,
  setRemoteAccount: (username: string, password: string) => ipcRenderer.invoke(REMOTE_ACCOUNT_CHANNEL, username, password) as Promise<RemoteAccessState>,
  revokeRemoteDevices: () => ipcRenderer.invoke(REMOTE_REVOKE_CHANNEL) as Promise<RemoteAccessState>,
  onRemoteAccessChanged: (listener: (state: RemoteAccessState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: RemoteAccessState): void => listener(state);
    ipcRenderer.on(REMOTE_STATE_CHANNEL, handler);
    return () => ipcRenderer.removeListener(REMOTE_STATE_CHANNEL, handler);
  },
  onRuntimeEvent: (listener: (event: RuntimeEvent, runtimeId?: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: RuntimeEventPayload): void => listener(value.event, value.runtimeId);
    ipcRenderer.on(RUNTIME_EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(RUNTIME_EVENT_CHANNEL, handler);
  },
  onUpdateAvailable: (listener: (update: UpdateAvailable) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, update: UpdateAvailable): void => listener(update);
    ipcRenderer.on(UPDATE_AVAILABLE_CHANNEL, handler);
    return () => ipcRenderer.removeListener(UPDATE_AVAILABLE_CHANNEL, handler);
  },
};

contextBridge.exposeInMainWorld("coilcoil", api);
