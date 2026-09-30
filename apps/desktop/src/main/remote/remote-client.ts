import type { DesktopPlatform } from "../../shared/desktop-api";

/**
 * The browser client is another renderer for the same desktop process. Keep
 * this allow-list in step with the preload IPC surface: state must come from
 * the main process, never from a browser-only copy of models/config/database.
 */
export const REMOTE_INVOKE_CHANNELS = [
  "mcp:test-connection",
  "runtime:request",
  "app:version",
  "project:select",
  "project:home",
  "dialog:pick-directory",
  "window:minimum-width",
  "window:grow-width",
  "window:background",
  "window:opacity",
  "app:badge-count",
  "external:open",
  "clipboard:write",
  "path:reveal",
  "project-directory:list",
  "project-file:action",
  "project-file:save",
  "path:classify",
  "projects:mounted",
  "projects:mounted:set",
  "preview:open",
  "preview:close",
  "browser:set-scope",
  "browser:get-state",
  "browser:capture",
  "browser:create-tab",
  "browser:select-tab",
  "browser:close-tab",
  "browser:navigate",
  "browser:zoom",
  "browser:back",
  "browser:forward",
  "browser:reload",
  "browser:import-list",
  "system:open-full-disk-access",
  "system:mac-permissions",
  "browser:import-cookies",
  "browser:data-stats",
  "browser:saved-logins",
  "browser:data-clear",
  "browser:ui-viewport",
  "terminal:get",
  "terminal:create",
  "terminal:write",
  "terminal:resize",
  "terminal:close",
  "window:is-maximized",
  "diagnostics:log",
  "diagnostics:reveal",
  "remote:get",
  "remote:save",
  "remote:new-code",
  "remote:account",
  "remote:revoke",
] as const;

/** Main-process pushes forwarded to remote clients. */
export const REMOTE_PUSH_CHANNELS = [
  "runtime:event",
  "update:available",
  "browser:state",
  "browser:agent-activated",
  "preview:updated",
  "terminal:state",
  "terminal:data",
  "window:maximized",
  "window:focus",
  "remote:state",
] as const;

/**
 * The browser-side half of the desktop bridge.
 *
 * The renderer talks to Electron through one flat object on `window.coilcoil`,
 * and every member of it is either a request or a subscription. That shape is
 * what makes a phone a remote control rather than a second app: the same
 * renderer runs untouched, and only the transport underneath changes. This is
 * served as a classic script so it finishes before the app's module bundle
 * starts, which is the only ordering the renderer depends on.
 *
 * It is authored as a string because it is the one piece of code that runs in
 * the phone's browser but ships inside the main process bundle; keeping it here
 * avoids a second build target and a packaging rule for one file.
 */
function computerLabel(platform: DesktopPlatform): string {
  return platform === "darwin" ? "Mac" : platform === "win32" ? "Windows" : "Linux";
}

export function bridgeScript(platform: DesktopPlatform): string {
  const hostLabel = computerLabel(platform);
  return `(function () {
  "use strict";
  // The Vite dev page is also loaded by Electron itself. Its preload bridge is
  // the real desktop transport; never replace it with the browser WebSocket
  // bridge or the desktop window would compete with the phone for the lease.
  if (window.coilcoil && !window.coilcoil.isRemote) return;
  // dev 下 7789 服务和 Vite 插件会各插一次 bridge：同一页跑两个 socket 会
  // 自己踢自己。第二个直接返回，吃第一份的 window.coilcoil。
  if (window.__coilcoilRemoteBridge) return;
  window.__coilcoilRemoteBridge = true;
  var pending = new Map();
  var listeners = new Map();
  var queue = [];
  var socket = null;
  var open = false;
  var nextId = 1;
  var hostLabel = ${JSON.stringify(hostLabel)};

  function fanOut(channel, payload) {
    var set = listeners.get(channel);
    if (!set) return;
    set.forEach(function (listener) {
      try { listener(payload); } catch (error) { console.error(error); }
    });
  }

  function connect() {
    var scheme = location.protocol === "https:" ? "wss://" : "ws://";
    socket = new WebSocket(scheme + location.host + "/__remote/ws");
    socket.onopen = function () {
      open = true;
      var waiting = queue;
      queue = [];
      waiting.forEach(function (frame) { socket.send(frame); });
    };
    socket.onmessage = function (message) {
      var frame;
      try { frame = JSON.parse(message.data); } catch (error) { return; }
      if (frame.push) { fanOut(frame.push, frame.payload); return; }
      var entry = pending.get(frame.id);
      if (!entry) return;
      pending.delete(frame.id);
      if (frame.ok) entry.resolve(frame.value);
      else entry.reject(new Error(frame.error || "远程请求失败。"));
    };
    socket.onclose = function (event) {
      open = false;
      if (event.code === 4000) {
        // 非回环才会被踢：本机回环多端共存，误收 4000（旧服务端、并发边际）时
        // 直接重连，不弹遮罩——回环本来就不该有“被接管”这回事。
        var loopback = location.hostname === "127.0.0.1" || location.hostname === "localhost";
        if (loopback) { connect(); return; }
        // Another device took over. Reconnecting here would start a fight
        // between the two phones, so this one stops and says so.
        displaced();
        return;
      }
      // Events missed while disconnected cannot be replayed, and the app has no
      // way to notice it is behind. Reloading re-reads the Mac's live state.
      setTimeout(function () { location.reload(); }, 1500);
    };
  }

  function displaced() {
    var cover = document.createElement("div");
    cover.setAttribute("style", [
      "position:fixed", "inset:0", "z-index:2147483647",
      "display:flex", "flex-direction:column", "gap:14px",
      "align-items:center", "justify-content:center", "text-align:center",
      "padding:32px", "background:#0d1618", "color:#e6eeec",
      "font-family:-apple-system,'PingFang SC',system-ui,sans-serif"
    ].join(";"));
    var title = document.createElement("div");
    title.setAttribute("style", "font-size:19px;font-weight:600");
    title.textContent = "已在其他设备上接管";
    var hint = document.createElement("div");
    hint.setAttribute("style", "font-size:14px;line-height:1.7;opacity:.7;max-width:22em");
    hint.textContent = "同一时间只允许一台设备遥控这台 " + hostLabel + "。要在这台设备上继续，点下面重新接管。";
    var button = document.createElement("button");
    button.setAttribute("style", [
      "font:inherit", "font-size:16px", "padding:12px 28px", "border:0",
      "border-radius:10px", "background:#0d6f70", "color:#fff", "cursor:pointer"
    ].join(";"));
    button.textContent = "重新接管";
    button.onclick = function () { location.reload(); };
    cover.appendChild(title);
    cover.appendChild(hint);
    cover.appendChild(button);
    document.body.appendChild(cover);
  }

  function invoke(channel, args) {
    return new Promise(function (resolve, reject) {
      var id = String(nextId++);
      pending.set(id, { resolve: resolve, reject: reject });
      var frame = JSON.stringify({ id: id, channel: channel, args: args || [] });
      if (open) socket.send(frame); else queue.push(frame);
    });
  }

  function subscribe(channel) {
    return function (listener) {
      var set = listeners.get(channel);
      if (!set) { set = new Set(); listeners.set(channel, set); }
      set.add(listener);
      return function () { set.delete(listener); };
    };
  }

  function resolves(value) {
    return function () { return Promise.resolve(value); };
  }

  function ignore() { return function () {}; }

  connect();

  window.coilcoil = {
    platform: ${JSON.stringify(platform)},
    isRemote: true,

    request: function (command, runtimeId) {
      return invoke("runtime:request", [{ command: command, runtimeId: runtimeId }]).then(function (result) {
        if (!result || !result.ok) throw new Error((result && result.error) || "运行时请求失败。");
        return result.value;
      });
    },
  onRuntimeEvent: function (listener) {
    return subscribe("runtime:event")(function (payload) { listener(payload.event, payload.runtimeId); });
  },
  onUpdateAvailable: subscribe("update:available"),

    testMcpConnection: function (input) { return invoke("mcp:test-connection", [input]); },
    appVersion: function () { return invoke("app:version", []); },
    homeProject: function () { return invoke("project:home", []); },
    selectProject: function () { return invoke("project:select", []); },
    pickDirectory: function (options) { return invoke("dialog:pick-directory", [options]); },
    setWindowMinimumWidth: function (width) { return invoke("window:minimum-width", [width]); },
    growWindowWidth: function (byPixels) { return invoke("window:grow-width", [byPixels]); },
    setWindowBackground: function (color) { return invoke("window:background", [color]); },
    setWindowOpacity: function (opacity) { return invoke("window:opacity", [opacity]); },
    setBadgeCount: function (count) { return invoke("app:badge-count", [count]); },
    listProjectDirectory: function (root, path) { return invoke("project-directory:list", [root, path]); },
    classifyPaths: function (paths) { return invoke("path:classify", [paths]); },
    revealPath: function (path) { return invoke("path:reveal", [path]); },
    openExternal: function (url) { return invoke("external:open", [url]); },
    copyText: function (value) { return invoke("clipboard:write", [value]); },
    mountedProjects: function () { return invoke("projects:mounted", []); },
    setMountedProjects: function (projects) { return invoke("projects:mounted:set", [projects]); },
    performProjectFileAction: function (input) { return invoke("project-file:action", [input]); },
    saveProjectFile: function (input) { return invoke("project-file:save", [input]); },
    openFilePreview: function (input) { return invoke("preview:open", [input]); },
    closeFilePreview: function (id) { return invoke("preview:close", [id]); },
    onFilePreviewUpdated: subscribe("preview:updated"),

    minimizeWindow: function () { invoke("window:minimize", []); },
    toggleWindowMaximized: function () { invoke("window:toggle-maximized", []); },
    closeWindow: function () { invoke("window:close", []); },
    isWindowMaximized: function () { return invoke("window:is-maximized", []); },
    onWindowMaximizedChange: subscribe("window:maximized"),
    getBubbleShortcut: resolves({ registered: false }),
    setBubbleShortcut: resolves({ registered: false }),
    hideBubble: resolves(undefined),
    openMainWindow: resolves(undefined),
    onOpenBubbleSession: ignore,

    setBrowserScope: function (scopeId, workspacePath) { return invoke("browser:set-scope", [scopeId, workspacePath]); },
    getBrowserState: function (scopeId) { return invoke("browser:get-state", [scopeId]); },
    captureBrowserTab: function (scopeId) { return invoke("browser:capture", [scopeId]); },
    pickBrowserElement: resolves(undefined),
    cancelBrowserElementPick: resolves(undefined),
    createBrowserTab: function (scopeId, url) { return invoke("browser:create-tab", [scopeId, url]); },
    selectBrowserTab: function (scopeId, id) { return invoke("browser:select-tab", [scopeId, id]); },
    closeBrowserTab: function (scopeId, id) { return invoke("browser:close-tab", [scopeId, id]); },
    navigateBrowser: function (scopeId, url) { return invoke("browser:navigate", [scopeId, url]); },
    setBrowserZoom: function (scopeId, step) { return invoke("browser:zoom", [scopeId, step]); },
    browserBack: function (scopeId) { return invoke("browser:back", [scopeId]); },
    browserForward: function (scopeId) { return invoke("browser:forward", [scopeId]); },
    reloadBrowser: function (scopeId) { return invoke("browser:reload", [scopeId]); },
    setBrowserUiViewport: function (viewport) { return invoke("browser:ui-viewport", [viewport]); },
    onBrowserStateUpdated: subscribe("browser:state"),
    // 画面只画进桌面窗口；网页版按截图看页面（见 BrowserPanel）。
    attachBrowserSurface: ignore,
    // 网页版只看画面，不往 Mac 上的页面里送鼠标键盘。
    sendBrowserInput: function () {},
    chooseBrowserSelect: resolves(undefined),
    chooseBrowserValue: resolves(undefined),
    findInBrowserPage: function () {},
    readBrowserCaret: resolves(null),
    readBrowserTooltip: resolves(null),
    dropFilesIntoBrowserPage: function () {},
    replyBrowserDialog: function (scopeId, tabId, dialogId, accept, text) { return invoke("browser:dialog-reply", [scopeId, tabId, dialogId, accept, text || ""]); },
    onBrowserPageEvent: ignore,
    onBrowserAgentActivated: subscribe("browser:agent-activated"),

    listImportableBrowsers: function () { return invoke("browser:import-list", []); },
    openPermissionSettings: function (id) { return invoke("system:open-full-disk-access", [id]); },
    getMacPermissions: function () { return invoke("system:mac-permissions", []); },
    importBrowserCookies: function (input) { return invoke("browser:import-cookies", [input]); },
    getBrowserDataStats: function () { return invoke("browser:data-stats", []); },
    listSavedLogins: function () { return invoke("browser:saved-logins", []); },
    clearBrowserData: function () { return invoke("browser:data-clear", []); },

    getTerminalSessions: function () { return invoke("terminal:get", []); },
    createTerminal: function (cwd) { return invoke("terminal:create", [cwd]); },
    writeTerminal: function (id, data) { return invoke("terminal:write", [id, data]); },
    resizeTerminal: function (id, cols, rows) { return invoke("terminal:resize", [id, cols, rows]); },
    closeTerminal: function (id) { return invoke("terminal:close", [id]); },
    onTerminalStateUpdated: subscribe("terminal:state"),
    onTerminalData: subscribe("terminal:data"),

    revealDiagnostics: function () { return invoke("diagnostics:reveal", []); },
    writeDiagnostics: function (batch) { void invoke("diagnostics:log", [batch]); },
    getRemoteAccess: function () { return invoke("remote:get", []); },
    saveRemoteAccess: function (input) { return invoke("remote:save", [input]); },
    regenerateRemotePairingCode: function () { return invoke("remote:new-code", []); },
    setRemoteAccount: function (username, password) { return invoke("remote:account", [username, password]); },
    revokeRemoteDevices: function () { return invoke("remote:revoke", []); },
    onRemoteAccessChanged: subscribe("remote:state"),
    onWindowFocusChange: subscribe("window:focus"),
    filePath: function () { return ""; },
  };
})();
`;
}

/**
 * Shown until a device is admitted. Deliberately self-contained and tiny.
 *
 * Two ways in, because they suit different moments: a pairing code is right in
 * front of the Mac and expires the instant it is used, while an account works
 * from anywhere and survives a restart. A connection from the user's own
 * tailnet or LAN never reaches this page at all.
 */
export function pairingPage(username?: string, platform: DesktopPlatform = "darwin"): string {
  const account = username ? JSON.stringify(username) : "null";
  const hostLabel = computerLabel(platform);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>登录 CoilCoil</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100dvh; display: grid; place-items: center;
    font-family: -apple-system, "PingFang SC", system-ui, sans-serif;
    background: #f2f4f3; color: #101c1f;
  }
  @media (prefers-color-scheme: dark) { body { background: #0d1618; color: #e6eeec; } }
  main { width: min(92vw, 360px); display: flex; flex-direction: column; gap: 18px; }
  h1 { font-size: 20px; margin: 0; }
  p { margin: 0; font-size: 14px; line-height: 1.7; opacity: .75; }
  .tabs { display: flex; gap: 6px; padding: 4px; border-radius: 12px; background: rgb(127 127 127 / 14%); }
  .tabs button {
    flex: 1; font: inherit; font-size: 14px; padding: 9px; border: 0; border-radius: 9px;
    background: transparent; color: inherit; cursor: pointer;
  }
  .tabs button[aria-selected="true"] { background: #0d6f70; color: #fff; }
  form { display: flex; flex-direction: column; gap: 12px; }
  input {
    font: inherit; font-size: 16px; padding: 13px; width: 100%; box-sizing: border-box;
    border-radius: 10px; border: 1px solid currentColor; background: transparent; color: inherit;
  }
  input.code { font-size: 28px; letter-spacing: .3em; text-align: center; }
  button.go {
    font: inherit; font-size: 16px; padding: 14px; border-radius: 10px;
    border: 0; background: #0d6f70; color: #fff; cursor: pointer;
  }
  .error { color: #b3261e; font-size: 14px; min-height: 20px; }
  @media (prefers-color-scheme: dark) { .error { color: #f2b8b5; } }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <h1>登录以遥控这台 ${hostLabel}</h1>
  <div class="tabs" role="tablist">
    <button id="tab-code" role="tab" aria-selected="true" type="button">配对码</button>
    <button id="tab-account" role="tab" aria-selected="false" type="button">账号密码</button>
  </div>

  <form id="form-code">
    <p>在 ${hostLabel} 上的 CoilCoil 设置里查看六位配对码。用过一次就失效。</p>
    <input class="code" id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" required>
    <button class="go" type="submit">配对</button>
  </form>

  <form id="form-account" hidden>
    <p id="account-hint">用 ${hostLabel} 上设置好的账号登录。</p>
    <input id="username" autocomplete="username" placeholder="用户名" required>
    <input id="password" type="password" autocomplete="current-password" placeholder="密码" required>
    <button class="go" type="submit">登录</button>
  </form>

  <div class="error" id="error"></div>
</main>
<script>
  var account = ${account};
  var error = document.getElementById("error");
  var tabCode = document.getElementById("tab-code");
  var tabAccount = document.getElementById("tab-account");
  var formCode = document.getElementById("form-code");
  var formAccount = document.getElementById("form-account");

  if (account) {
    document.getElementById("username").value = account;
    document.getElementById("account-hint").textContent = "用 ${hostLabel} 上设置好的账号登录。";
  } else {
    document.getElementById("account-hint").textContent = "${hostLabel} 上还没有设置账号，请先在设置里添加，或改用配对码。";
  }

  function show(which) {
    var code = which === "code";
    tabCode.setAttribute("aria-selected", String(code));
    tabAccount.setAttribute("aria-selected", String(!code));
    formCode.hidden = !code;
    formAccount.hidden = code;
    error.textContent = "";
  }
  tabCode.onclick = function () { show("code"); };
  tabAccount.onclick = function () { show("account"); };

  function submit(path, payload) {
    error.textContent = "";
    fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (response) {
      if (response.ok) { location.replace("/"); return; }
      return response.json().then(function (body) { error.textContent = body.error || "登录失败。"; });
    }).catch(function () { error.textContent = "无法连接到 ${hostLabel}。"; });
  }

  formCode.addEventListener("submit", function (event) {
    event.preventDefault();
    submit("/__remote/pair", { code: document.getElementById("code").value, name: navigator.userAgent });
  });

  formAccount.addEventListener("submit", function (event) {
    event.preventDefault();
    submit("/__remote/sign-in", {
      username: document.getElementById("username").value,
      password: document.getElementById("password").value,
      name: navigator.userAgent
    });
  });
</script>
</body>
</html>
`;
}
