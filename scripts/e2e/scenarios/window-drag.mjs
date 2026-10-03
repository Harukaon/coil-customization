// 标题栏拖动区：屏幕上看着是拖动带的地方，窗口也必须真的认它能拖。
//
// 窗口哪里能拖，是 Chromium 按文档顺序收集一串矩形交给 Electron 决定的：标了 drag 的
// 并进去，标了 no-drag（所有按钮、输入框）的挖掉，排在后面的说了算。这串矩形**不按
// overflow 裁剪、不看透明度**，所以滚到标题栏后面的消息气泡、收起后只是变透明的右栏
// 标签，都会在标题栏上挖出看不见的洞——用户按下去，窗口不动。滚动本身不触发重新收集，
// 所以洞会一直留着，直到界面下一次排版，这就是「时好时坏」。
//
// 这里把用户真实碰到的几种局面造出来，在每条标题栏上铺一排取样点，比两样东西：
//   - 屏幕上这一点最上层、声明了拖动属性的元素是谁（用户以为自己按到的东西）；
//   - 按 Chromium / Electron 的规则，把整份文档的矩形按顺序叠起来，这一点归谁。
// 两者不一致就是洞。macOS 上如果给了 koffi（COILCOIL_E2E_KOFFI=装了 koffi 的目录），
// 还会直接问窗口本身：对每个取样点调一次内容视图的 hitTest:，返回 nil 就是系统会拿去
// 拖窗口——这和真实按下鼠标时 Chromium 走的是同一条判断。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const description = "标题栏拖动区：屏幕上是拖动带的地方，窗口也认它能拖（聊天、右栏、技能、记忆）";

const LONG = "这条消息故意写得很长，好把气泡撑得又高又宽，滚上去以后正好垫在标题栏后面。".repeat(3);

/**
 * 逼一次重新排版，再给清单一点时间送到窗口那边。读 offsetHeight 会同步跑完排版和
 * 排版后的收尾（Chromium 在那里重新收集拖动矩形），不依赖动画帧。
 */
async function settle(page) {
  await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:-20px;top:-20px;width:1px;height:1px;";
    document.body.append(probe);
    void document.body.offsetHeight;
    probe.remove();
    void document.body.offsetHeight;
  });
  await page.waitForTimeout(350);
}

/** 在页面里给一条（或几条同类）标题栏取样，比较「屏幕上看到的」和「矩形清单算出来的」。 */
function auditInPage({ selector, exclude, step }) {
  const label = (element) => {
    const raw = typeof element.className === "string" ? element.className.trim() : "";
    return element.tagName.toLowerCase() + (raw ? `.${raw.split(/\s+/).slice(0, 3).join(".")}` : "");
  };
  const modeOf = (element) => {
    const style = getComputedStyle(element);
    const mode = style.getPropertyValue("-webkit-app-region");
    if (!mode || mode === "none" || style.visibility !== "visible") return undefined;
    if (style.display === "inline" || style.display === "contents" || style.display === "none") return undefined;
    return mode;
  };
  // Chromium 的收集规则：按文档顺序，凡是声明了拖动属性、可见、是个盒子的元素都算，
  // 不裁剪。
  const regions = [];
  const walk = (element) => {
    const mode = modeOf(element);
    if (mode) {
      const box = element.getBoundingClientRect();
      regions.push({ element, drag: mode === "drag", left: box.left, top: box.top, right: box.right, bottom: box.bottom });
    }
    for (const child of element.children) walk(child);
  };
  walk(document.documentElement);
  // Electron 按顺序并集 / 差集：最后一个盖住这一点的矩形说了算。
  const modelAt = (x, y) => {
    let winner;
    for (const region of regions) {
      if (x >= region.left && x < region.right && y >= region.top && y < region.bottom) winner = region;
    }
    return winner;
  };
  // 屏幕上这一点从上往下第一个声明了拖动属性的元素。
  const paintedAt = (x, y) => {
    for (const element of document.elementsFromPoint(x, y)) {
      const mode = modeOf(element);
      if (mode) return { element, drag: mode === "drag" };
    }
    return undefined;
  };
  const inRoundedCorner = (element, x, y) => {
    const style = getComputedStyle(element);
    const radius = Math.max(...["borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius"].map((key) => Number.parseFloat(style[key]) || 0));
    if (!radius) return false;
    const box = element.getBoundingClientRect();
    const r = Math.min(radius, box.width / 2, box.height / 2);
    return (x < box.left + r || x >= box.right - r) && (y < box.top + r || y >= box.bottom - r);
  };
  const skipped = [...document.querySelectorAll(exclude.join(","))].map((element) => element.getBoundingClientRect());
  const inSkipped = (x, y) => skipped.some((box) => x >= box.left && x < box.right && y >= box.top && y < box.bottom);

  const bars = [...document.querySelectorAll(selector)].filter((element) => {
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility === "visible";
  });
  const points = [];
  const holes = [];
  const blocked = [];
  for (const bar of bars) {
    const box = bar.getBoundingClientRect();
    const left = Math.max(0, box.left);
    const right = Math.min(window.innerWidth, box.right);
    // 竖着每 4px 一行：标签条上下只剩几像素的拖动带，三行取样会正好踩在边界上漏掉。
    const rows = [];
    for (let y = Math.ceil(box.top + 2); y < box.bottom - 1; y += 4) rows.push(y);
    for (let x = Math.ceil(left + 3); x < right - 3; x += step) {
      for (const y of rows) {
        if (inSkipped(x, y)) continue;
        const painted = paintedAt(x, y);
        // 鼠标按下这一点会落到哪：最上层若是别的面板（比如收起时盖过来的会话区以外
        // 的东西）就不算这条标题栏。
        const top = document.elementFromPoint(x, y);
        if (!top || !(bar.contains(top) || top.closest(".window-drag-bar") || top.closest(".window-drag-layer"))) continue;
        const model = modelAt(x, y);
        const expected = painted?.drag === true;
        const actual = model?.drag === true;
        // 紧挨着某块矩形边缘的点：Chromium 交给窗口的矩形是取整过的，和这里的小数坐标
        // 差一个像素，窗口实测只比对离边缘远一点的点。
        const edge = [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dy]) => modelAt(x + dx, y + dy) !== model);
        // 圆角按钮四个角上露出来的那一点点：拖动矩形是直角的，屏幕上的按钮是圆角的，
        // 角上一两个像素本来就交给按钮，不算洞。
        const corner = Boolean(model && !actual && inRoundedCorner(model.element, x, y));
        points.push({ x, y, expected, edge: edge || corner });
        if (expected && !actual && !corner) holes.push({ x, y, painted: painted ? label(painted.element) : null, culprit: model ? label(model.element) : null });
        if (!expected && actual) blocked.push({ x, y, painted: painted ? label(painted.element) : null, culprit: model ? label(model.element) : null });
      }
    }
  }
  const summarize = (list) => {
    const byCulprit = {};
    for (const item of list) byCulprit[item.culprit ?? "（没有矩形）"] = (byCulprit[item.culprit ?? "（没有矩形）"] ?? 0) + 1;
    return { count: list.length, byCulprit, first: list.slice(0, 3) };
  };
  return { bars: bars.length, sampled: points.length, holes: summarize(holes), blocked: summarize(blocked), points };
}

/** 一条标题栏的取样结果；exclude 里的东西本来就是故意不可拖的（分栏拖把、标签条滚动条）。 */
async function audit(page, selector, exclude = []) {
  return page.evaluate(auditInPage, { selector, exclude: [".panel-resizer", ...exclude], step: 6 });
}

/**
 * 直接问窗口：这一点按下去会不会拖窗口。走的是 Chromium 在 macOS 上真实按下鼠标时
 * 用的同一个判断（内容视图的 hitTest: → Electron 的拖动区域），返回 nil 就是可拖。
 */
async function nativeDraggable(app, points) {
  const dir = process.env.COILCOIL_E2E_KOFFI;
  if (!dir || process.platform !== "darwin" || process.arch !== "arm64") return undefined;
  return app.evaluate(({ BrowserWindow }, { points, dir }) => {
    const state = globalThis;
    if (!state.__coilDragProbe) {
      const require = process.getBuiltinModule("module").createRequire(dir.endsWith("/") ? dir : `${dir}/`);
      const koffi = require("koffi");
      const objc = koffi.load("/usr/lib/libobjc.A.dylib");
      const NSPoint = koffi.struct("CoilDragProbePoint", { x: "double", y: "double" });
      const NSRect = koffi.struct("CoilDragProbeRect", { x: "double", y: "double", width: "double", height: "double" });
      state.__coilDragProbe = {
        sel: objc.func("sel_registerName", "uint64", ["str"]),
        id: objc.func("objc_msgSend", "uint64", ["uint64", "uint64"]),
        bool: objc.func("objc_msgSend", "bool", ["uint64", "uint64"]),
        rect: objc.func("objc_msgSend", NSRect, ["uint64", "uint64"]),
        convert: objc.func("objc_msgSend", NSPoint, ["uint64", "uint64", NSPoint, "uint64"]),
        hit: objc.func("objc_msgSend", "uint64", ["uint64", "uint64", NSPoint]),
        className: objc.func("object_getClassName", "str", ["uint64"]),
      };
    }
    const probe = state.__coilDragProbe;
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed() && candidate.isVisible() && candidate.webContents.getURL().startsWith("file:"));
    if (!win) return { error: "找不到主窗口" };
    const handle = win.getNativeWindowHandle().readBigUInt64LE(0);
    const nsWindow = probe.id(handle, probe.sel("window"));
    const content = probe.id(nsWindow, probe.sel("contentView"));
    const superview = probe.id(content, probe.sel("superview"));
    const bounds = probe.rect(content, probe.sel("bounds"));
    const flipped = probe.bool(content, probe.sel("isFlipped"));
    const results = points.map(({ x, y }) => {
      const local = { x, y: flipped ? y : bounds.height - y };
      const inSuper = probe.convert(content, probe.sel("convertPoint:toView:"), local, superview);
      const hit = probe.hit(content, probe.sel("hitTest:"), inSuper);
      // koffi 把装得下的 uint64 当普通数字返回，大的才是 BigInt；两种 0 都是 nil。
      return hit === 0 || hit === 0n ? { drag: true } : { drag: false, view: probe.className(hit) };
    });
    return { contentClass: probe.className(content), height: bounds.height, results };
  }, { points, dir });
}

function describe(result) {
  return JSON.stringify({ 取样: result.sampled, 洞: result.holes, 盖住的控件: result.blocked });
}

/** 屏幕上该拖的点，系统也认可拖；屏幕上是按钮的点，系统也不拿去拖。 */
async function checkBand(app, page, check, name, selector, exclude) {
  await settle(page);
  const result = await audit(page, selector, exclude);
  // 造出来的局面到取样时还在不在：被垫到标题栏后面的那个控件，此刻仍然压着标题栏。
  const marked = await page.evaluate((selector) => {
    const element = document.querySelector("[data-e2e-under-title]");
    const bar = document.querySelector(selector);
    if (!element || !bar) return undefined;
    const box = element.getBoundingClientRect();
    const barBox = bar.getBoundingClientRect();
    return {
      overlaps: box.top < barBox.bottom && box.bottom > barBox.top && box.left < barBox.right && box.right > barBox.left,
      element: `${element.tagName.toLowerCase()}.${String(element.className)}`,
      box: [box.left, box.top, box.right, box.bottom].map(Math.round),
    };
  }, selector);
  if (marked) check(`${name}：取样时那个控件仍垫在标题栏后面`, marked.overlaps, JSON.stringify(marked));
  // 标记只对造它的那一步有效，用完就摘掉，别让下一步拿着上一步的控件去核对。
  await page.evaluate(() => { for (const element of document.querySelectorAll("[data-e2e-under-title]")) element.removeAttribute("data-e2e-under-title"); });
  check(`${name}：有取样点`, result.sampled > 20, `只取到 ${result.sampled} 个点（${result.bars} 条标题栏）`);
  check(`${name}：看得见的拖动带上没有看不见的洞`, result.holes.count === 0, describe(result));
  check(`${name}：看得见的按钮没被拖动带盖住`, result.blocked.count === 0, describe(result));
  const native = await nativeDraggable(app, result.points);
  if (native) {
    if (native.error) {
      check(`${name}：窗口实测`, false, native.error);
    } else {
      const wrong = [];
      let compared = 0;
      native.results.forEach((answer, index) => {
        const point = result.points[index];
        if (point.edge) return;
        compared += 1;
        if (answer.drag !== point.expected) wrong.push({ x: point.x, y: point.y, 屏幕上: point.expected ? "拖动带" : "控件", 窗口认为: answer.drag ? "拖窗口" : `交给网页（${answer.view}）` });
      });
      check(`${name}：窗口实测和屏幕一致（${compared} 点）`, compared > 20 && wrong.length === 0, JSON.stringify({ 不一致: wrong.length, 前几个: wrong.slice(0, 4) }));
    }
  }
  return result;
}

/**
 * 把一个滚动容器滚到「某个控件正好垫在标题栏的拖动带后面」的位置：先在标题栏上找出
 * 屏幕上确实是拖动带的点，再挑一个横向能盖住其中某点的控件，把它滚上去盖住那一点。
 * 优先往回滚（像用户往上翻历史），滚不到再往下滚，内容不够长就在底部垫高。
 */
async function scrollUnder(page, { scroller, target, bar }) {
  return page.evaluate(({ scroller, target, bar }) => {
    const header = document.querySelector(bar);
    const container = document.querySelector(scroller);
    if (!header || !container) return { ok: false, reason: `找不到 ${!header ? bar : scroller}` };
    const modeOf = (element) => {
      const style = getComputedStyle(element);
      const mode = style.getPropertyValue("-webkit-app-region");
      if (!mode || mode === "none" || style.visibility !== "visible") return undefined;
      if (style.display === "inline" || style.display === "contents" || style.display === "none") return undefined;
      return mode;
    };
    // 只认这条标题栏自己的拖动层：右上角那组悬浮开关自带一层拖动层、排在最后，压在它
    // 下面的东西挖不出洞，挑那里就造不出局面。
    const paintedDrag = (x, y) => {
      for (const element of document.elementsFromPoint(x, y)) {
        const mode = modeOf(element);
        if (mode) return mode === "drag" && header.contains(element);
      }
      return false;
    };
    const headerBox = header.getBoundingClientRect();
    const rows = [];
    for (let y = Math.ceil(headerBox.top + 2); y < headerBox.bottom - 1; y += 4) rows.push(y);
    const dragPoints = [];
    for (let x = Math.ceil(Math.max(0, headerBox.left) + 3); x < Math.min(window.innerWidth, headerBox.right) - 3; x += 6) {
      for (const y of rows) if (paintedDrag(x, y)) dragPoints.push({ x, y });
    }
    if (!dragPoints.length) return { ok: false, reason: "标题栏上找不到屏幕上是拖动带的点" };
    const max = container.scrollHeight - container.clientHeight;
    const options = [];
    for (const element of [...container.querySelectorAll(target)].reverse()) {
      const box = element.getBoundingClientRect();
      if (box.height <= 0 || box.width <= 0) continue;
      const point = dragPoints.find(({ x }) => x >= box.left && x < box.right);
      if (!point) continue;
      // 让控件的上半截盖住那一点。
      options.push({ element, point, delta: box.top + Math.min(box.height / 2, 10) - point.y });
    }
    if (!options.length) return { ok: false, reason: `${scroller} 里没有横向能盖住拖动带的 ${target}` };
    let choice = options.find(({ delta }) => container.scrollTop + delta >= 0 && container.scrollTop + delta <= max);
    if (!choice) {
      choice = options.find(({ delta }) => delta > 0);
      if (!choice) return { ok: false, reason: "没有能滚到标题栏后面的控件" };
      container.style.paddingBottom = `${choice.delta - (max - container.scrollTop) + 400}px`;
    }
    container.scrollTop += choice.delta;
    for (const marked of document.querySelectorAll("[data-e2e-under-title]")) marked.removeAttribute("data-e2e-under-title");
    choice.element.setAttribute("data-e2e-under-title", "");
    const after = choice.element.getBoundingClientRect();
    return {
      ok: after.top <= choice.point.y && after.bottom > choice.point.y,
      element: `${choice.element.tagName.toLowerCase()}.${String(choice.element.className)}`,
      point: choice.point,
      box: [after.left, after.top, after.right, after.bottom].map(Math.round),
      header: [Math.round(headerBox.top), Math.round(headerBox.bottom)],
    };
  }, { scroller, target, bar });
}

async function clickByRole(page, role, name) {
  await page.getByRole(role, { name, exact: true }).first().click();
  await page.waitForTimeout(400);
}

async function openPanel(page, label) {
  const empty = page.locator(".inspector-empty-actions button", { hasText: label });
  if (await empty.count()) {
    await empty.first().click();
  } else {
    await clickByRole(page, "button", "打开面板");
    await page.getByRole("menuitem", { name: label }).click();
  }
  await page.waitForTimeout(600);
}

export async function run({ app, page, root, ui, check, shot }) {
  if (process.env.COILCOIL_E2E_KOFFI) {
    // 先确认窗口实测这条路本身是通的：输入框一定交给网页，左上角侧栏顶部一定拖窗口。
    const box = await page.locator(".prompt-editor").boundingBox();
    const native = await nativeDraggable(app, [{ x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }, { x: 150, y: 20 }]);
    check("窗口实测：探针能区分「交给网页」和「拖窗口」", native && !native.error && native.results[0].drag === false && native.results[1].drag === true, JSON.stringify(native));
  }

  // 一、长对话：用户自己发的消息气泡整个是一个按钮，滚上去以后垫在会话标题栏后面。
  await ui.newConversation("projA");
  for (let index = 1; index <= 5; index += 1) {
    await ui.send([{ tool: "read", args: { path: "README.md" } }, { echo: true }], `第${index}条 ${LONG}`);
  }
  const bubble = await scrollUnder(page, { scroller: ".conversation-body", target: ".user-bubble-button", bar: ".conversation-header" });
  check("造出局面：消息气泡滚到了会话标题栏后面", bubble.ok, JSON.stringify(bubble));
  await checkBand(app, page, check, "会话标题栏（气泡滚到后面）", ".conversation-header");
  await shot("chat-bubble-under-title");

  // 二、右栏开过几个标签再收起：收起只是变透明，标签条还在原地，压在会话标题栏右半边下面。
  await ui.newConversation("projB");
  await clickByRole(page, "button", "展开作业栏");
  await openPanel(page, "文件");
  await openPanel(page, "运行时");
  await openPanel(page, "终端");
  await openPanel(page, "浏览器");
  await clickByRole(page, "button", "收起右侧栏");
  await page.waitForTimeout(500);
  await checkBand(app, page, check, "会话标题栏（右栏收起）", ".conversation-header");
  await shot("chat-inspector-collapsed");

  // 三、右栏开着、标签多到要横向滚：滚走的标签伸到标签条外面，左边伸进会话标题栏，
  //     右边伸进右栏自己留的那段拖动带。
  await clickByRole(page, "button", "展开作业栏");
  for (let index = 0; index < 5; index += 1) await openPanel(page, "终端");
  for (const end of ["末尾", "开头"]) {
    const scrolled = await page.evaluate((end) => {
      const nav = document.querySelector(".inspector-nav");
      if (!nav) return null;
      nav.scrollLeft = end === "末尾" ? nav.scrollWidth : 0;
      return { overflow: nav.scrollWidth - nav.clientWidth, scrollLeft: nav.scrollLeft };
    }, end);
    check(`造出局面：右栏标签多到要滚动（滚到${end}）`, scrolled && scrolled.overflow > 60, JSON.stringify(scrolled));
    await checkBand(app, page, check, `会话标题栏（右栏标签滚到${end}）`, ".conversation-header");
    await checkBand(app, page, check, `右栏标题栏（标签滚到${end}）`, ".inspector-header", [".inspector-scrollbar"]);
  }
  await shot("inspector-many-tabs");

  // 四、右栏内容往下滚：运行时面板里的开关和按钮滚到右栏标题栏后面。
  await page.locator(".inspector-tab-select", { hasText: "运行时" }).first().click();
  await page.waitForTimeout(600);
  const runtime = await scrollUnder(page, { scroller: ".runtime-tab-panel.active", target: "button, input, select, textarea", bar: ".inspector-header" });
  check("造出局面：运行时面板的控件滚到了右栏标题栏后面", runtime.ok, JSON.stringify(runtime));
  await checkBand(app, page, check, "右栏标题栏（内容滚到后面）", ".inspector-header", [".inspector-scrollbar"]);

  // 浏览器面板也在右栏内容里：地址栏一排按钮紧贴着右栏标题栏下沿，标题栏挪到内容后面
  // 以后，它们照样点得到、标题栏照样拖得动。
  const browserTab = await page.evaluate(() => {
    const tab = [...document.querySelectorAll(".inspector-tab-select")].find((button) => !/^(文件|运行时|终端)/.test(button.getAttribute("aria-label") ?? ""));
    tab?.click();
    return tab?.getAttribute("aria-label") ?? null;
  });
  check("造出局面：切到了浏览器标签", browserTab !== null, String(browserTab));
  await page.waitForTimeout(800);
  await checkBand(app, page, check, "右栏标题栏（浏览器面板）", ".inspector-header", [".inspector-scrollbar"]);

  // 五、技能页：技能列表滚上去，工具栏按钮和开关垫在页头后面。
  for (let index = 1; index <= 12; index += 1) {
    const directory = join(root, "data", "agent", "skills", `e2e-skill-${index}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "SKILL.md"), `---\nname: e2e-skill-${index}\ndescription: 端到端测试用的技能 ${index}，用来把技能列表撑到需要滚动。\n---\n\n# e2e skill ${index}\n`);
  }
  await page.locator(".nav-skills").click();
  await page.waitForTimeout(1500);
  const skills = await scrollUnder(page, { scroller: ".skills-settings", target: "button", bar: ".skills-workspace-header" });
  check("造出局面：技能页的按钮滚到了页头后面", skills.ok, JSON.stringify(skills));
  await checkBand(app, page, check, "技能页页头（列表滚到后面）", ".skills-workspace-header");
  await shot("skills-scrolled");

  // 六、记忆页：页头本身也照同一条规矩排，静止状态下整条一致。
  await page.locator(".nav-memory").click();
  await page.waitForTimeout(1500);
  await checkBand(app, page, check, "记忆页页头", ".memory-workspace-header");
  await shot("memory");
}
