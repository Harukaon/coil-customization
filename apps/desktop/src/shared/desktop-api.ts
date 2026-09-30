import type {
  DiagnosticLogBatch,
  BrowserElementSnapshot,
  FileNode,
  ProjectSelection,
  PromptImage,
  RuntimeCommand,
  RuntimeEvent,
  ScopedRuntimeEvent,
} from "@coilcoil/runtime-protocol";

export type { ProjectSelection } from "@coilcoil/runtime-protocol";

export type DesktopPlatform = "darwin" | "linux" | "win32";

export type PreviewKind = "text" | "markdown" | "html" | "pdf" | "image";

export interface FilePreviewDocument {
  id: string;
  path: string;
  name: string;
  kind: PreviewKind;
  content: string;
  truncated: boolean;
  updatedAt: number;
  /** The file's modification time when this content was read, in milliseconds. */
  mtimeMs: number;
  /** Whether this document may be edited in place and written back. */
  editable: boolean;
  /** Why a text file that looks editable is not; shown instead of the edit button. */
  readOnlyReason?: string;
}

/** The bubble's global shortcut: nothing is claimed until the user picks one. */
export interface BubbleShortcutState {
  accelerator?: string;
  registered: boolean;
  error?: string;
  /** Offered in the settings page as a starting point, never applied on its own. */
  suggestion?: string;
}

export interface McpConnectionTestInput {
  url: string;
  headers?: Record<string, string>;
}

/** What an MCP server answered when asked to shake hands. */
export type McpConnectionTest =
  | { ok: true; status: number; statusText: string; body: string }
  | { ok: false; error: string };

/** Which conversation the bubble was on when it handed over to the main window. */
export interface BubbleSessionTarget {
  cwd: string;
  sessionPath: string;
}

export interface OpenFilePreviewInput {
  root: string;
  path: string;
  forceText?: boolean;
}

export type FileFallbackAction = "reveal" | "force-text" | "trash";

export interface OpenFilePreviewResult {
  opened: boolean;
  document?: FilePreviewDocument;
  actions?: FileFallbackAction[];
}

export interface SaveProjectFileInput {
  root: string;
  path: string;
  content: string;
  /** The mtime the editor loaded; a mismatch means the file changed underneath it. */
  expectedMtimeMs: number;
}

export type SaveProjectFileResult =
  | { saved: true; mtimeMs: number }
  | { saved: false; reason: "conflict" | "invalid" | "too-large"; message: string };

export type ProjectFileAction = "reveal" | "trash";

/** What an absolute path in the transcript points at. */
export type PathKind = "file" | "directory" | "missing";

export interface ProjectFileActionInput {
  root: string;
  path: string;
  action: ProjectFileAction;
}

export interface ProjectFileActionResult {
  completed: boolean;
  trashed?: boolean;
}

/** 一项系统权限现在是什么状态。`unknown` 表示探不出来，不能当成被拒绝。 */
export type MacPermissionStatus = "granted" | "denied" | "unknown" | "unsupported";

/**
 * 这些在 macOS 里是**彼此独立**的开关——「完全磁盘访问权限」既不包含「App 管理」，
 * 也不包含「屏幕录制」。
 */
export type MacPermissionId = "full-disk" | "screen-recording" | "app-management" | "accessibility";

export interface MacPermissions {
  platform: "darwin" | "other";
  status: Record<MacPermissionId, MacPermissionStatus>;
}

export interface BrowserTabSnapshot {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /**
   * 这张是 Agent 开的：标签条上带 Agent 标识。只是「谁开的」，不是「归谁」：每张标签页
   * 用户和 Agent 都能直接用，不用接管。
   */
  agent?: boolean;
  /**
   * Agent 这会儿正在操作这张页面（不管是谁开的）：面板上亮出提示。停手几秒后变回 false。
   * 用户和 Agent 可以同时操作，不排队。
   */
  agentActive?: boolean;
  /**
   * 旧版本快照可能带有这个标记；当前界面会过滤其他工作区的标签页，不再展示它们。
   */
  foreign?: boolean;
  /** 网页弹出的 alert/confirm/prompt 还在等人回答：面板里显示一张卡片，不弹系统对话框。 */
  dialog?: BrowserPageDialog;
}

/** 网页自己弹的对话框。页面脚本停在那里，等用户或 Agent 回答。 */
export interface BrowserPageDialog {
  id: string;
  type: "alert" | "confirm" | "prompt";
  message: string;
  /** prompt 里预先填好的文字。 */
  defaultPrompt: string;
  /** 弹对话框的网站，卡片上写「xxx 显示」，和浏览器一样。 */
  origin: string;
}

export interface BrowserStateSnapshot {
  scopeId: string;
  tabs: BrowserTabSnapshot[];
  activeTabId?: string;
  /** 这个内置浏览器当前的缩放倍数，1 就是 100%。 */
  zoom: number;
}

/**
 * 面板里正在画的页面画面：多大、用的哪种方式。只在这些变了的时候通知，不是每一帧。
 *
 * 画面本身由预加载直接画进画布（GPU 纹理，不经过界面脚本）；界面只用这些信息换算
 * 用户点在页面上的哪个位置、摆下拉框列表。
 */
export interface BrowserSurfaceInfo {
  /** 画面的像素大小（页面大小乘屏幕缩放）。 */
  width: number;
  height: number;
  /**
   * 画面上这一帧的页面有多大（网页自己的 CSS 像素，不是图片像素）。
   *
   * 用户在画面上点哪儿，要按这一帧换算成页面上的位置：面板刚改完大小、新画面还没
   * 到的时候，用户看到的是旧尺寸的画面，点的也是旧画面上的位置。
   */
  viewport: { width: number; height: number };
  /** texture：GPU 共享纹理；jpeg：没有 GPU 或纹理传不过去时的普通画面。 */
  mode: "texture" | "jpeg";
}

/** 同时按着的修饰键。 */
export interface BrowserInputModifiers {
  shift: boolean;
  control: boolean;
  alt: boolean;
  meta: boolean;
}

/**
 * 用户在面板里对网页做的一次操作，由主进程原样送进那张页面。
 *
 * 坐标已经换算成页面上的位置（CSS 像素，见 BrowserSurfaceInfo.viewport）。按键带的是
 * 键盘事件本来的 key/code/keyCode，主进程据此拼出和真实按键一样的事件。
 */
export type BrowserPageInput =
  | {
    kind: "mouse";
    type: "down" | "up" | "move" | "enter" | "leave";
    x: number;
    y: number;
    button: "left" | "middle" | "right" | "none";
    clickCount: number;
    /** 同 MouseEvent.buttons：拖动时哪些键还按着。 */
    buttons: number;
    modifiers: BrowserInputModifiers;
  }
  | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number; modifiers: BrowserInputModifiers }
  | {
    kind: "key";
    type: "down" | "up";
    key: string;
    code: string;
    keyCode: number;
    location: number;
    repeat: boolean;
    modifiers: BrowserInputModifiers;
  }
  /** 输入法：组字中（update）、上屏（commit）、放弃（cancel）。 */
  | { kind: "ime"; type: "update"; text: string; selectionStart: number; selectionEnd: number }
  | { kind: "ime"; type: "commit"; text: string }
  | { kind: "ime"; type: "cancel" }
  /** 不是敲键盘来的文字：表情面板、听写、系统服务插进来的。 */
  | { kind: "text"; text: string }
  /** 菜单栏「编辑」里的命令，作用在网页里选中的内容上。 */
  | { kind: "edit"; command: "copy" | "cut" | "paste" | "undo" | "redo" | "selectAll" }
  /** 用户的焦点进出这张页面：页面据此认为自己有没有焦点（光标闪不闪、失焦事件）。 */
  | { kind: "focus"; focused: boolean };

/** 网页下拉框里的一项。 */
export interface BrowserSelectOption {
  label: string;
  value: string;
  disabled: boolean;
  /** 所在分组（optgroup）的名字，不在分组里是空串。 */
  group: string;
}

/** 用户点开了网页里的下拉框：面板照着画一个选项列表。 */
export interface BrowserSelectPicker {
  id: string;
  /** 下拉框在页面上的位置（页面像素），列表贴着它的下沿弹出。 */
  rect: { x: number; y: number; width: number; height: number };
  options: BrowserSelectOption[];
  selectedIndex: number;
}

/**
 * 用户点开了网页里的日期、时间、日期时间、月份、周或颜色输入框：面板在它的位置用 App 窗口里
 * Chromium 自己的选择器打开，选的值写回页面。
 */
export interface BrowserValuePicker {
  id: string;
  type: "date" | "time" | "datetime-local" | "month" | "week" | "color";
  /** 输入框现在的值、可选范围和步长（和网页上的属性一样，空串是没设）。 */
  value: string;
  min: string;
  max: string;
  step: string;
  /** 输入框在页面上的位置（页面像素），选择器贴着它弹出。 */
  rect: { x: number; y: number; width: number; height: number };
}

/** 网页那边发生的、面板要跟着变的事。 */
export type BrowserPageEvent =
  /** 鼠标指到的地方该显示什么光标，已经是 CSS 的 cursor 值。 */
  | { tabId: string; kind: "cursor"; cursor: string }
  /** 用户点开了一个下拉框。 */
  | { tabId: string; kind: "select"; picker: BrowserSelectPicker | null }
  /** 用户点开了日期、时间、颜色这类输入框的选择器；null 是收起。 */
  | { tabId: string; kind: "value-picker"; picker: BrowserValuePicker | null }
  /** 页面内查找的结果：一共几处、现在是第几处（从 1 数）。 */
  | { tabId: string; kind: "find"; matches: number; active: number };

/** 页面里光标的位置（页面坐标，CSS 像素）：面板把输入法候选框放在这儿。 */
export interface BrowserCaret { x: number; y: number; height: number }

/** 页面内查找：换了要找的字就从头找（newSearch），回车是找下一处（forward 为 false 是上一处）。 */
export type BrowserFindRequest = { text: string; forward: boolean; newSearch: boolean } | { stop: true };


/** Visible size of the browser panel, so agents see the viewport the user sees. */
export interface BrowserUiViewport {
  width: number;
  height: number;
  /** 面板左上角在窗口里的位置（CSS 像素）：网页的右键菜单要弹在用户点的地方。 */
  left?: number;
  top?: number;
}

export interface BrowserElementSourceLocation {
  file: string;
  line?: number;
  column?: number;
}

/** One element explicitly picked by the user from the visible built-in page. */
export interface BrowserElementSelection extends BrowserElementSnapshot {
  /** A viewport screenshot captured while Chromium's selected-node highlight is visible. */
  screenshot?: string;
}

/** A browser CoilCoil can import an existing signed-in state from. */
export type ImportableBrowserId =
  | "chrome"
  | "chrome-beta"
  | "chrome-canary"
  | "chromium"
  | "edge"
  | "brave"
  | "vivaldi"
  | "arc"
  | "safari";

/**
 * One profile of one installed browser. Chrome keeps a separate persona per
 * profile directory, so the user must be able to say which one to take.
 */
export interface ImportableProfile {
  browser: ImportableBrowserId;
  browserName: string;
  /** Profile directory name, or "default" for browsers without profiles. */
  id: string;
  name: string;
  email?: string;
  /** Absent when the count could not be read without asking for credentials. */
  cookieCount?: number;
  passwordCount?: number;
  available: boolean;
  /** Why it cannot be imported right now, when `available` is false. */
  problem?: string;
  /**
   * 挡住它的那件事用户自己能解决时，点这一行就直接去解决，而不是留一句话让人
   * 自己找设置。目前只有一种：macOS 不让读别的浏览器的数据，要给完全磁盘访问权限。
   */
  fix?: "full-disk-access";
}

export interface ImportBrowserCookiesInput {
  browser: ImportableBrowserId;
  profile: string;
  /** Saved logins are a separate decision from sessions, so they are opt-in. */
  includePasswords?: boolean;
}

export interface BrowserImportSummary {
  imported: number;
  /** Expired or malformed records that were never worth writing. */
  skipped: number;
  /** Records the built-in browser refused. */
  failed: number;
  /** Records that could not be decrypted or parsed at the source. */
  unreadable: number;
  /** Distinct sites now carrying a session. */
  hosts: number;
  /** Saved logins written into CoilCoil's own encrypted store. */
  passwords: number;
  /** Sites behind `failed` and `unreadable`, so the user can see what is missing. */
  problemHosts: string[];
  /** Something was skipped but the import itself succeeded. */
  note?: string;
  error?: string;
}

/** What the built-in browser currently remembers. */
export interface BrowserDataStats {
  cookies: number;
  hosts: number;
  savedLogins: number;
}

/** A saved login as it may be shown on screen: never the password itself. */
export interface SavedLoginSummary {
  origin: string;
  username: string;
  importedAt: number;
}

export interface TerminalSessionSnapshot {
  id: string;
  cwd: string;
  output: string;
  status: "running" | "exited";
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
}

export interface TerminalDataEvent {
  id: string;
  data: string;
}

export interface UpdateAvailable {
  current: string;
  latest: string;
  url: string;
}

/** How the phone reaches this Mac from outside the local network. */
export type RemoteTunnelMode = "reverse-proxy" | "tailscale";

export interface RemotePairedDevice {
  name: string;
  pairedAt: number;
  lastSeenAt: number;
}

export interface RemoteAccessState {
  enabled: boolean;
  /** False while enabled means the entry point failed to start; see `error`. */
  running: boolean;
  port: number;
  host: string;
  mode: RemoteTunnelMode;
  publicUrl?: string;
  keepAwake: boolean;
  keepAwakeActive: boolean;
  /** Skip the login screen for connections from the user's own tailnet or LAN. */
  trustLocalNetwork: boolean;
  /** The account that can sign in without a pairing code, when one is set. */
  username?: string;
  /** This Mac's tailnet address, when Tailscale is running. */
  tailscaleAddress?: string;
  /** Free-form notes the user keeps on this screen; saved with the settings. */
  notes: string;
  /** Present only while running: a code means nothing with nothing listening. */
  pairingCode?: string;
  devices: RemotePairedDevice[];
  connectedClients: number;
  error?: string;
}

export interface RemoteAccessInput {
  enabled?: boolean;
  port?: number;
  host?: string;
  mode?: RemoteTunnelMode;
  publicUrl?: string;
  keepAwake?: boolean;
  trustLocalNetwork?: boolean;
  notes?: string;
}

export interface CoilCoilDesktopApi {
  /**
   * Set only by the browser-side bridge a phone loads. The renderer uses it to
   * pick the phone layout, which must never be chosen from window width alone:
   * a desktop window dragged narrow is still a desktop window.
   */
  isRemote?: boolean;
  platform: DesktopPlatform;
  /** The running build's version, as packaged. */
  appVersion(): Promise<string>;
  homeProject(): Promise<ProjectSelection>;
  selectProject(): Promise<ProjectSelection | null>;
  pickDirectory(options?: { title?: string }): Promise<string | null>;
  setWindowMinimumWidth(width: number): Promise<void>;
  /** Widen the window by this many pixels so an opening panel need not shrink the conversation. */
  growWindowWidth(byPixels: number): Promise<void>;
  /** 同步窗口底色（CSS 颜色字面量），避免暗色主题下窗口画布仍是浅色。 */
  setWindowBackground(color: string): Promise<void>;
  /** 挂载的文件夹清单（存在 userData 里，开发版和安装版共用一份）。 */
  mountedProjects(): Promise<Array<{ name: string; path: string; kind: "workspace" }>>;
  /** 覆盖磁盘上的挂载清单；返回真正落盘的那一份。 */
  setMountedProjects(
    projects: Array<{ name: string; path: string; kind: "workspace" }>,
  ): Promise<Array<{ name: string; path: string; kind: "workspace" }>>;
  /** 整窗透明度（0.96~1）。返回真正生效的值——超出范围会被收敛。 */
  setWindowOpacity(opacity: number): Promise<number>;
  /** Dock/任务栏角标上的未读数；0 表示清掉角标。 */
  setBadgeCount(count: number): Promise<void>;
  /** 从系统拖入的文件解析出绝对路径；渲染进程自己拿不到。 */
  filePath(file: File): string;
  openExternal(url: string): Promise<void>;
  /** Classify absolute paths so a link can be drawn and routed correctly. */
  classifyPaths(paths: string[]): Promise<Record<string, PathKind>>;
  /** Show the path in the operating system's file manager. */
  revealPath(path: string): Promise<boolean>;
  copyText(text: string): Promise<void>;
  openFilePreview(input: OpenFilePreviewInput): Promise<OpenFilePreviewResult>;
  closeFilePreview(id: string): Promise<void>;
  /** Write an edited text file back, inside the workspace only. */
  saveProjectFile(input: SaveProjectFileInput): Promise<SaveProjectFileResult>;
  performProjectFileAction(input: ProjectFileActionInput): Promise<ProjectFileActionResult>;
  onFilePreviewUpdated(listener: (document: FilePreviewDocument) => void): () => void;
  /** Dismiss the floating bubble window; its conversation stays alive. */
  /** Shake hands with an HTTP MCP server and report what it said. */
  testMcpConnection(input: McpConnectionTestInput): Promise<McpConnectionTest>;
  getBubbleShortcut(): Promise<BubbleShortcutState>;
  /** Claim an accelerator, or release the current one when given nothing. */
  setBubbleShortcut(accelerator?: string): Promise<BubbleShortcutState>;
  hideBubble(): Promise<void>;
  /** Hand the bubble's conversation to the main window and dismiss the bubble. */
  openMainWindow(target?: BubbleSessionTarget): Promise<void>;
  /** The main window listens for a conversation handed over from the bubble. */
  onOpenBubbleSession(listener: (target: BubbleSessionTarget) => void): () => void;
  listProjectDirectory(root: string, path?: string): Promise<FileNode[]>;
  /** `workspacePath` picks the cookie jar: one per mounted folder. */
  setBrowserScope(scopeId: string, workspacePath?: string): Promise<BrowserStateSnapshot>;
  getBrowserState(scopeId: string): Promise<BrowserStateSnapshot>;
  /**
   * A JPEG data URL of the built-in browser's current page, or undefined when
   * no tab can be captured. Used by the remote client, which cannot receive the
   * live picture the desktop window draws into its panel.
   */
  captureBrowserTab(scopeId: string): Promise<string | undefined>;
  /** Enter Chromium's native element picker and resolve after a click or cancel. */
  pickBrowserElement(scopeId: string): Promise<BrowserElementSelection | undefined>;
  cancelBrowserElementPick(): Promise<void>;
  /**
   * `placeholder`：面板打开时给空会话垫的那一张。主进程只在这个会话一张都没有时才建
   * （判断和建在同一步，不和 Agent 开页抢），Agent 开了真正的页面后它会被收掉。
   */
  createBrowserTab(scopeId: string, url?: string, placeholder?: boolean): Promise<BrowserStateSnapshot>;
  selectBrowserTab(scopeId: string, id: string): Promise<BrowserStateSnapshot>;
  closeBrowserTab(scopeId: string, id: string): Promise<BrowserStateSnapshot>;
  navigateBrowser(scopeId: string, url: string): Promise<BrowserStateSnapshot>;
  browserBack(scopeId: string): Promise<BrowserStateSnapshot>;
  browserForward(scopeId: string): Promise<BrowserStateSnapshot>;
  reloadBrowser(scopeId: string): Promise<BrowserStateSnapshot>;
  /** 内置浏览器的字号：一次一挡，或直接回到 100%。 */
  setBrowserZoom(scopeId: string, step: "in" | "out" | "reset"): Promise<BrowserStateSnapshot>;
  setBrowserUiViewport(viewport: BrowserUiViewport): Promise<void>;
  /** Browsers installed on this Mac whose signed-in state can be taken over. */
  listImportableBrowsers(): Promise<ImportableProfile[]>;
  /** 打开系统设置里某一项权限那一页。 */
  openPermissionSettings(id: MacPermissionId): Promise<void>;
  /** 这台 Mac 现在给了哪些权限。每次调用都现探一遍，不缓存。 */
  getMacPermissions(): Promise<MacPermissions>;
  /** Copy one profile's cookies into the built-in browser. May prompt for the keychain. */
  importBrowserCookies(input: ImportBrowserCookiesInput): Promise<BrowserImportSummary>;
  getBrowserDataStats(): Promise<BrowserDataStats>;
  /** Origins and usernames of the imported logins; the passwords never leave main. */
  listSavedLogins(): Promise<SavedLoginSummary[]>;
  /** Sign the built-in browser out of everything, including saved logins. */
  clearBrowserData(): Promise<BrowserDataStats>;
  onBrowserStateUpdated(listener: (state: BrowserStateSnapshot) => void): () => void;
  onBrowserAgentActivated(listener: (scopeId: string) => void): () => void;
  /**
   * 把面板里的画布交给预加载：这张页面的画面直接画进去。返回的函数摘下画布。
   * 网页版没有这条路（它看定时截图），调用什么也不做。
   */
  attachBrowserSurface(tabId: string, canvas: HTMLCanvasElement, onInfo: (info: BrowserSurfaceInfo) => void): () => void;
  /**
   * 把用户对面板里那张页面的一次操作送进去。只对当前会话正显示着的那张生效；
   * 不等回音，鼠标移动这种一秒几十次的操作不该每次都来回一趟。
   */
  sendBrowserInput(scopeId: string, tabId: string, input: BrowserPageInput): void;
  /** 回答网页弹出的对话框：确定（prompt 带上填的字）或取消。卡片过时了就什么都不做。 */
  replyBrowserDialog(scopeId: string, tabId: string, dialogId: string, accept: boolean, text?: string): Promise<void>;
  /** 在面板画的下拉框列表里选了第几项；null 是没选就关掉了。 */
  chooseBrowserSelect(scopeId: string, tabId: string, pickerId: string, index: number | null): Promise<void>;
  /**
   * 面板的日期、时间、颜色选择器里选了值：写回页面。final 是选完了（发 change、收起）；
   * value 为 null 是没选就关了。
   */
  chooseBrowserValue(scopeId: string, tabId: string, pickerId: string, value: string | null, final: boolean): Promise<void>;
  /** 页面内查找（面板的查找栏）；结果从 onBrowserPageEvent 的 find 事件回来。网页版没有。 */
  findInBrowserPage(scopeId: string, tabId: string, request: BrowserFindRequest): void;
  /**
   * 用户从外面拖到页面上的文件，放进松手的位置（页面坐标），和在 Chrome 里拖进去一样。
   * 路径由预加载从这些文件上取，网页脚本自己造的文件取不到路径。网页版没有。
   */
  dropFilesIntoBrowserPage(scopeId: string, tabId: string, drop: { x: number; y: number; modifiers: BrowserInputModifiers }, files: File[]): void;
  /** 鼠标停在页面这一点（页面坐标）：这里的悬停提示（元素的 title）；没有是 null。网页版没有。 */
  readBrowserTooltip(scopeId: string, tabId: string, point: { x: number; y: number }): Promise<string | null>;
  /** 问页面光标在哪儿（输入法候选框跟着它走）；没在能打字的地方时是 null。网页版没有。 */
  readBrowserCaret(scopeId: string, tabId: string): Promise<BrowserCaret | null>;
  onBrowserPageEvent(listener: (event: BrowserPageEvent) => void): () => void;
  getTerminalSessions(): Promise<TerminalSessionSnapshot[]>;
  /** Always opens another shell: each one gets its own inspector tab. */
  createTerminal(cwd: string): Promise<TerminalSessionSnapshot[]>;
  writeTerminal(id: string, data: string): Promise<void>;
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>;
  closeTerminal(id: string): Promise<TerminalSessionSnapshot[]>;
  onTerminalStateUpdated(listener: (state: TerminalSessionSnapshot[]) => void): () => void;
  onTerminalData(listener: (event: TerminalDataEvent) => void): () => void;
  request<T = unknown>(command: RuntimeCommand, runtimeId?: string): Promise<T>;
  onRuntimeEvent(listener: (event: RuntimeEvent, runtimeId?: string) => void): () => void;
  onUpdateAvailable(listener: (update: UpdateAvailable) => void): () => void;
  /** The three things a title bar does, for the buttons the Renderer draws. */
  minimizeWindow(): void;
  toggleWindowMaximized(): void;
  closeWindow(): void;
  isWindowMaximized(): Promise<boolean>;
  onWindowMaximizedChange(listener: (maximized: boolean) => void): () => void;
  /**
   * 整个窗口是否持有焦点。注意这不等于 Renderer 自己的 `window.onfocus`：
   * 内置浏览器的页面占着同一个窗口里另一份 WebContents，焦点落到它上面时
   * Renderer 会看到 blur，而窗口其实还在用。
   */
  onWindowFocusChange(listener: (focused: boolean) => void): () => void;
  /** Hand Renderer entries to the process that owns the log file. */
  writeDiagnostics(batch: DiagnosticLogBatch): void;
  /** Show the log in the file manager and return its path. */
  revealDiagnostics(): Promise<string>;
  getRemoteAccess(): Promise<RemoteAccessState>;
  saveRemoteAccess(input: RemoteAccessInput): Promise<RemoteAccessState>;
  regenerateRemotePairingCode(): Promise<RemoteAccessState>;
  setRemoteAccount(username: string, password: string): Promise<RemoteAccessState>;
  revokeRemoteDevices(): Promise<RemoteAccessState>;
  onRemoteAccessChanged(listener: (state: RemoteAccessState) => void): () => void;
}


export interface RuntimeRequestPayload {
  command: RuntimeCommand;
  runtimeId?: string;
}

export type RuntimeRequestResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export type RuntimeEventPayload = ScopedRuntimeEvent;
