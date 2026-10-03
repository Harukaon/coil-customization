import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const rendererRoot = resolve(import.meta.dirname, "../src/renderer/src");
const styles = readFileSync(resolve(rendererRoot, "styles.css"), "utf8");

/** styles.css 一条规则写一行，取出选择器后面那对花括号里的声明。 */
function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped} \\{([^}]*)\\}`, "m").exec(styles);
  assert.ok(match, `styles.css 里找不到 ${selector} 这条规则`);
  return match[1];
}

/** 选择器列表换行写的时候，要从列表开头一直读到花括号。 */
function declarationsOfList(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}[^{}]*\\{([^}]*)\\}`, "m").exec(styles);
  assert.ok(match, `styles.css 里找不到以 ${selector} 开头的规则`);
  return match[1];
}

function pixels(selector: string, property: string): number {
  const match = new RegExp(`(?:^|;)\\s*${property}:\\s*(-?[\\d.]+)(?:px)?\\s*(?:;|$)`).exec(declarations(selector));
  assert.ok(match, `${selector} 上没有 ${property}`);
  return Number.parseFloat(match[1]);
}

/** 渲染层里所有文件，用来做整片扫描。 */
function rendererFiles(extensions: string[]): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(full);
    }
  };
  walk(rendererRoot);
  return found;
}

/** 挂了 <WindowDragBar /> 的那些标题栏容器。 */
const DRAG_BAR_HOSTS = [
  "conversation-header",
  "inspector-header",
  "skills-workspace-header",
  "memory-workspace-header",
  "sidebar-drag",
  "app-sidebar-control-bar",
  "conversation-inspector-control-bar",
];

test("拖动层铺满标题栏，并且排在内容下面", () => {
  const layer = declarations(".window-drag-layer");
  assert.match(layer, /position:\s*absolute/);
  assert.match(layer, /inset:\s*0/);
  // 层要在内容下面，否则它会把标题栏里按钮的点击吃掉。
  assert.match(declarations(".window-drag-layer ~ *"), /z-index:\s*1/);
});

test("左侧栏顶部的拖动区覆盖整个宽度", () => {
  const region = declarations(".sidebar-drag-region");
  assert.match(region, /inset:\s*0(?:;|$)/);
  assert.doesNotMatch(region, /50px/, "顶部拖动区不应再为旧按钮预留不可拖动的空带");
});

test("窗口顶栏拖动层固定覆盖整个窗口，不跟随三栏移动", () => {
  const appView = readFileSync(resolve(rendererRoot, "AppView.tsx"), "utf8");
  assert.match(appView, /<WindowDragBar className="app-window-drag-region" \/>/);
  const region = declarations(".app-window-drag-region");
  assert.match(region, /top:\s*0/);
  assert.match(region, /right:\s*0/);
  assert.match(region, /left:\s*0/);
  assert.match(region, /height:\s*56px/);
  assert.doesNotMatch(region, /border:\s*1px dashed rgb\(170 170 170 \/ 72%\)/, "顶部拖动区不应显示调试虚线");
});

test("宿主标题栏都给拖动层建立了定位上下文", () => {
  assert.match(declarations(".window-drag-bar"), /position:\s*relative/);
  for (const host of DRAG_BAR_HOSTS) {
    assert.match(declarations(`.${host}`), /position:\s*(?:relative|absolute)/, `.${host} 需要定位上下文`);
  }
});

test("左侧栏的拖动层排在滚动内容之后，顶部仍由占位高度让出", () => {
  const sidebar = readFileSync(resolve(rendererRoot, "features/workspaces/WorkspaceSidebar.tsx"), "utf8");
  const spacer = sidebar.indexOf('className="sidebar-drag-spacer"');
  const projectSection = sidebar.indexOf('className="project-section"');
  const dragBar = sidebar.lastIndexOf('className="sidebar-drag window-drag-bar"');
  assert.ok(spacer >= 0, "侧栏需要单独的顶部布局占位");
  assert.ok(projectSection > spacer, "滚动内容应当排在顶部占位之后");
  assert.ok(dragBar > projectSection, "侧栏拖动层必须排在滚动内容之后");
  assert.match(declarations(".sidebar-drag-spacer"), /flex:\s*0\s*0\s*56px/);
  assert.match(declarations(".sidebar-drag"), /position:\s*absolute/);
  assert.match(declarations(".sidebar-drag"), /height:\s*56px/);
});

test("标题栏在文档里排在会从它底下经过的内容之后", () => {
  // 拖动矩形按文档顺序叠，最后盖住某一点的说了算，而且不按 overflow 裁剪：滚到标题栏
  // 底下的按钮（消息气泡整个就是一个按钮）照样挖洞。标题栏排在后面，它的拖动层才能把
  // 这些看不见的洞整块盖回去。2026-10 的「会话标题栏偶发拖不动」就是标题栏排在前面。
  const cases: Array<[file: string, content: string, header: string]> = [
    ["features/conversation/ConversationPane.tsx", 'className="conversation-scroll"', 'className="conversation-header window-drag-bar"'],
    ["features/inspector/InspectorPane.tsx", "className={`inspector-content", 'className="inspector-header window-drag-bar"'],
    ["features/settings/SkillsWorkspace.tsx", 'className="skills-workspace-content"', 'className="skills-workspace-header window-drag-bar"'],
    ["features/memory/MemoryWorkspace.tsx", 'className="memory-workspace-content"', 'className="memory-workspace-header window-drag-bar"'],
  ];
  for (const [file, content, header] of cases) {
    const source = readFileSync(resolve(rendererRoot, file), "utf8");
    const contentAt = source.indexOf(content);
    const headerAt = source.indexOf(header);
    assert.ok(contentAt >= 0, `${file} 里找不到 ${content}`);
    assert.ok(headerAt >= 0, `${file} 里找不到 ${header}`);
    assert.ok(headerAt > contentAt, `${file}：标题栏必须写在 ${content} 后面`);
  }
});

test("标题栏换到内容后面，屏幕位置由 grid-row 钉住", () => {
  // 只改文档顺序、不钉格子的话，自动排布会把标题栏排到最后一行去。
  const rows: Array<[selector: string, row: number]> = [
    [".conversation-header", 1], [".conversation-scroll", 2], [".composer-wrap", 3],
    [".inspector-header", 1], [".inspector-content", 2],
    [".skills-workspace-content", 2], [".memory-workspace-content", 2],
  ];
  for (const [selector, row] of rows) {
    assert.match(declarations(selector), new RegExp(`grid-row:\\s*${row}(?:;|\\s|$)`), `${selector} 要钉在第 ${row} 行`);
  }
  for (const header of [".skills-workspace-header", ".memory-workspace-header"]) {
    const match = new RegExp(`^\\${header} \\{([^}]*)\\}`, "m").exec(styles);
    assert.ok(match, `styles.css 里找不到 ${header}`);
    assert.match(match[1], /grid-row:\s*1(?:;|\s|$)/, `${header} 要钉在第 1 行`);
  }
});

test("收起的侧栏整块不声明拖动属性", () => {
  // 收起只是变透明、原地不动，右栏标签条正好垫在会话标题栏右半边底下，照样挖洞。
  const rule = /^\.app-shell\.left-collapsed > \.sidebar,\s*\n\.app-shell\.left-collapsed > \.sidebar \*,\s*\n\.app-shell\.right-collapsed > \.inspector-pane,\s*\n\.app-shell\.right-collapsed > \.inspector-pane \* \{([^}]*)\}/m.exec(styles);
  assert.ok(rule, "styles.css 里要有一条规则清掉收起面板里所有元素的拖动声明");
  assert.match(rule[1], /-webkit-app-region:\s*initial/);
});

test("右栏标签条整条一块 no-drag，里面的标签不各自声明", () => {
  // 标签多了横向滚，滚出条外的标签会伸到条外面（往左一直伸进会话标题栏）挖洞。
  const inspector = readFileSync(resolve(rendererRoot, "features/inspector/InspectorPane.tsx"), "utf8");
  assert.match(inspector, /className="inspector-nav no-drag"/);
  assert.match(declarations(".inspector-nav *"), /-webkit-app-region:\s*initial/);
});

test("不许写 -webkit-app-region: none——Chromium 把它当成 no-drag", () => {
  // AppRegion::ApplyValue 只认 drag，其余关键字一律落成 no-drag。想清掉声明只能写
  // initial。2026-10 第一版修复就踩过：写成 none 之后，收起的右栏整块变成了洞。
  const offenders = rendererFiles([".css", ".ts", ".tsx"])
    .filter((file) => {
      // 只看代码，注释里讲这条坑的话不算。
      const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      return /-webkit-app-region:\s*none|WebkitAppRegion:\s*["']none/.test(code);
    })
    .map((file) => file.slice(rendererRoot.length + 1));
  assert.deepEqual(offenders, [], "要清掉拖动声明请写 initial");
});

test("挂了拖动层的标题栏，标记类必须写在标记里", () => {
  // 以前这个类是脚本在运行时补上去的，跟着刷新机制一起拆了。现在没有任何脚本会补，
  // 漏写就等于拖动层没有定位上下文，会铺到更外面某个祖先上去。
  const offenders: string[] = [];
  for (const file of rendererFiles([".tsx"])) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("<WindowDragBar")) continue;
    if (file.endsWith("WindowDragBar.tsx")) continue;
    for (const host of DRAG_BAR_HOSTS) {
      if (!source.includes(host)) continue;
      const written = new RegExp(`className="[^"]*\\b${host}\\b[^"]*window-drag-bar`).test(source)
        || new RegExp(`className="[^"]*window-drag-bar[^"]*\\b${host}\\b`).test(source);
      if (!written) offenders.push(`${file.slice(rendererRoot.length + 1)} → .${host}`);
    }
  }
  assert.deepEqual(offenders, [], "挂 <WindowDragBar /> 的容器要同时写上 window-drag-bar");
});

test("拖动区只由拖动层提供，标题栏元素自己不写 app-region", () => {
  // 以前是「哪里拖不动就给哪个元素补一条 CSS」，补出来的规则彼此不知道对方存在。
  // 现在的约定是：只有 .window-drag 这一个类给 drag，只有交互元素给 no-drag。
  const dragRules = styles
    .split("\n")
    .filter((line) => /-webkit-app-region:\s*drag/.test(line))
    .map((line) => line.slice(0, line.indexOf("{")).trim());
  assert.deepEqual(dragRules, [".window-drag"]);
});

test("左右悬浮开关排在会话和右栏的拖动层之后", () => {
  // Electron 按 DOM 顺序合并 drag / no-drag 矩形，最后覆盖同一点的声明获胜。
  // 两个按钮虽然视觉上有更高 z-index，但若写在会话或右栏前面，折叠后移动过来的
  // 标题栏拖动层仍会把鼠标按下截走，表现为「看得到、悬停有效、就是点不了」。
  const appView = readFileSync(resolve(rendererRoot, "AppView.tsx"), "utf8");
  const lastPane = Math.max(appView.lastIndexOf("<ConversationPane"), appView.lastIndexOf("<WorkspaceInspector"));
  assert.ok(lastPane >= 0, "AppView 里应当渲染会话区和右栏");
  assert.ok(appView.lastIndexOf('className="app-sidebar-control"') > lastPane);
  assert.ok(appView.lastIndexOf('className="conversation-inspector-control"') > lastPane);
});

test("所有工作区共用 AppView 的左侧栏开关", () => {
  const workspaceFiles = [
    resolve(rendererRoot, "features/settings/SkillsWorkspace.tsx"),
    resolve(rendererRoot, "features/memory/MemoryWorkspace.tsx"),
  ];
  for (const file of workspaceFiles) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /PanelLeft|leftOpen|onOpenLeft/, `${file} 不应再实现自己的左侧栏开关`);
  }
  const appView = readFileSync(resolve(rendererRoot, "AppView.tsx"), "utf8");
  assert.equal((appView.match(/className="app-sidebar-control"/g) ?? []).length, 1);
  assert.match(appView, /className="icon-button app-sidebar-toggle no-drag"/);
});

test("窗口按钮压在右上角，标题栏右侧要给它让位", () => {
  // Windows / Linux 上窗口按钮由应用自己画在右上角（138px 宽），标题栏高 56px，
  // 于是就压在标题栏右侧那一块上。页头右侧的动作按钮和开关不让位就会被压住点
  // 不到：实测设置页头部右侧的动作按钮正好落在关闭按钮底下。
  const clearance = /padding-right:\s*calc\(26px \+ var\(--window-controls-width\)\)/;
  for (const selector of [
    ".app-shell > .skills-workspace > .skills-workspace-header",
    ".app-shell > .memory-workspace > .memory-workspace-header",
  ]) {
    assert.match(declarationsOfList(selector), clearance, `${selector} 要给窗口按钮让位`);
  }
  // 设置页只在右侧让位：窗口按钮在右上角，左侧什么也没盖住，多留 138px 会在
  // 标题前面凭空多出一大块空白。
  const settingsCss = readFileSync(resolve(rendererRoot, "features/settings/settings.css"), "utf8");
  const settingsHeader = /\n\.settings-page-header \{([^}]*)\}/.exec(settingsCss)?.[1];
  assert.ok(settingsHeader, "settings.css 里找不到 .settings-page-header 这条规则");
  assert.match(settingsHeader, /padding:\s*0 26px/, ".settings-page-header 左侧不应该给窗口按钮留位");
  assert.match(settingsHeader, clearance, ".settings-page-header 右侧要给窗口按钮让位");
  assert.match(declarations(".conversation-header"), /padding:\s*0 calc\(8px \+ var\(--window-controls-width\)\) 0 20px/, ".conversation-header 要给窗口按钮让位");
  // 手机上根本没有窗口按钮，不能凭空留出 138px。
  const mobileCss = readFileSync(resolve(rendererRoot, "mobile.css"), "utf8");
  assert.match(mobileCss, /\[data-client="remote"\] \{ --window-controls-width: 0px; \}/, "远程客户端要把窗口按钮宽度归零");
});

test("右侧栏标签条按内容取宽，并给右侧按钮留位", () => {
  const header = declarations(".inspector-header");
  const horizontalPadding = 2 * Number.parseFloat(/padding:\s*[\d.]+(?:px)?\s+([\d.]+)px/.exec(header)?.[1] ?? "NaN");
  const gap = Number.parseFloat(/gap:\s*([\d.]+)px/.exec(header)?.[1] ?? "NaN");
  // 桌面端两个按钮现在属于同一个固定槽：左右各 8px，中间 2px。标题栏标签条仍要
  // 给这两个按钮以及 nav 到按钮之间的一个 7px 间距留位。
  const controlWidth = pixels(".conversation-inspector-control", "width");
  const actions = controlWidth - 16;

  const reserved = Number.parseFloat(
    /max-width:\s*calc\(100% - ([\d.]+)px([^)]*)\)/.exec(declarations(".inspector-nav"))?.[1] ?? "NaN",
  );
  assert.ok(Number.isFinite(reserved), ".inspector-nav 必须用 calc(100% - Npx) 限宽");
  assert.equal(reserved, actions + gap);
  // 还要再扣除右上角那三枚自绘的窗口按钮（Windows / Linux 138px，mac 为 0）。实测
  // 漏掉这一项的后果：标签铺满时末尾标签右半边落在窗口按钮下，点它实际按到最大化。
  assert.match(
    declarations(".inspector-nav"),
    /max-width:\s*calc\(100% - 69px - var\(--window-controls-width\)\)/,
    ".inspector-nav 要让开窗口按钮",
  );
  assert.match(declarations(".inspector-nav"), /width:\s*max-content/);
  assert.match(declarations(".inspector-nav"), /flex:\s*0 1 auto/);
  assert.equal(horizontalPadding, 16);
});

test("自绘窗口按钮和右栏头部同高同中线", () => {
  // 44px 是右栏头部那一行（.inspector-pane 的首行栅格），也是右栏固定控制条的高度。
  // 窗口按钮照 Windows 原生的 32px 画会整体偏高 6px，夹在旁边的添加 / 开关按钮里
  // 一眼就看出来没对齐。
  assert.match(declarations(".window-controls"), /height:\s*44px/, ".window-controls 要和右栏头部同高");
  assert.match(declarations(".inspector-pane"), /grid-template-rows:\s*44px/, "右栏头部第一行是 44px");
  assert.equal(pixels(".conversation-inspector-control", "height"), 44);
  // 图标用 Windows 原生的 10px：13px 时在 Windows 上明显偏大（2026-09 用户反馈）。
  const controls = readFileSync(resolve(rendererRoot, "ui/WindowControls.tsx"), "utf8");
  const glyphs = controls.match(/<svg width="\d+" height="\d+"/g) ?? [];
  assert.equal(glyphs.length, 4, "最小化 / 最大化 / 还原 / 关闭共 4 个图标");
  for (const glyph of glyphs) assert.match(glyph, /width="10" height="10"/, `窗口按钮图标大小应统一：${glyph}`);
});

test("标题栏里的选择器不能用 :first-child——拖动层永远排在第一个", () => {
  // <WindowDragBar /> 插在最前面，`> div:first-child` 于是一条都匹配不上。记忆页
  // 的标题栏就是这么坏掉的：包图标和标题的那个 div 从 flex 掉回 block，图标被挤
  // 到标题栏外面。要按类型选就用 :first-of-type，最好直接给类名。
  const offenders: string[] = [];
  for (const file of rendererFiles([".css"])) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const brace = line.indexOf("{");
      if (brace < 0) continue;
      const selector = line.slice(0, brace);
      if (!selector.includes(":first-child")) continue;
      if (DRAG_BAR_HOSTS.some((host) => selector.includes(host))) offenders.push(selector.trim());
    }
  }
  assert.deepEqual(offenders, [], "标题栏里请改用 :first-of-type 或直接给类名");
});

test("no-window-drag 不是一个类，样式表里根本没有它", () => {
  // 写过这个类的两处元素本来就是 no-drag（一个是 button，一个自己写了 app-region），
  // 于是它看起来「有用」，实际上什么都没做——留着只会让下一个人以为标了就生效。
  const offenders = rendererFiles([".css", ".ts", ".tsx"])
    .filter((file) => readFileSync(file, "utf8").includes("no-window-drag"))
    .map((file) => file.slice(rendererRoot.length + 1));
  assert.deepEqual(offenders, [], "只有 .no-drag 这一个类，别再造一个同义词");
});

test("拆掉的刷新补丁不许再长回来", () => {
  // 2026-09-16 把整套「逼 Chromium 重算拖动矩形」的东西拆干净了：哨兵元素、悬停
  // 轮询、按下时重算、resize 重算、body 子节点监听、每条标题栏的两个观察器。洞是按
  // 元素当时的真实位置算出来的，重算多少次都还在。再遇到拖不动，先看诊断日志里
  // drag_press_reached_page 的 modelWinner（挖洞的就是它），不要往回加刷新。
  const banned = ["window-drag-sentinel", "refreshWindowDragRegions", "installWindowDragRegions", "observeWindowDragBar"];
  const offenders: string[] = [];
  for (const file of rendererFiles([".css", ".ts", ".tsx"])) {
    const source = readFileSync(file, "utf8");
    for (const token of banned) {
      if (source.includes(token)) offenders.push(`${file.slice(rendererRoot.length + 1)} → ${token}`);
    }
  }
  assert.deepEqual(offenders, [], "拖动带不要再加刷新机制，见 ui/WindowDragBar.tsx 的文件头");
});
