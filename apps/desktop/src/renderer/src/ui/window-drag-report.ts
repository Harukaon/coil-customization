/**
 * 记录「标题栏这一刻拖不动」的现场。只记录，不修复。
 *
 * ## 为什么需要它
 *
 * 「标题栏偶尔拖不动」是个薛定谔式的故障：只要界面保持不动它就一直坏着，而任何
 * 一点变化（改窗口大小、某个按钮出现或消失、随手按一下别处）都会让它自己恢复。
 * 所以出事的时候既看不见、也问不出来——等你去看它，它已经好了。用户 2026-09-18
 * 的原话：「状态不变它就是坏的，状态一变它就恢复，像薛定谔的猫」。
 *
 * 2026-10 靠它定位到了原因：Blink 收集拖动矩形不按 overflow 裁剪、不看透明度，滚到
 * 标题栏底下的消息气泡、收起后只是变透明的右栏标签，都在拖动带上挖出看不见的洞；
 * 滚动又不触发重新收集，所以界面不动就一直坏、动一下就好。修法和约定见
 * ui/WindowDragBar.tsx 的文件头。
 *
 * ## 怎么读一条记录
 *
 * `modelWinner` 是按窗口那边的算法（文档顺序叠矩形，最后盖住这一点的说了算）算出来
 * 的元素——**它就是挖洞的那一个**；`expected` 是屏幕上实际在最上层、用户以为自己按到
 * 的拖动层。`paintStack` 是屏幕上这一点从上到下的元素，可以看出元凶有没有露在外面。
 *
 * ## 判据
 *
 * 一次左键按下落在「按我们自己这份清单算应该是可拖动」的位置上，**而网页居然收到
 * 了这一下**——正常能拖的时候这一下会被系统截走，网页什么都收不到。所以收到就等于
 * 失效正在发生。这是唯一不需要改变任何状态就能观测到它的办法。
 *
 * 这里不做任何补救。想知道为什么不补救，看 ui/WindowDragBar.tsx 的文件头。
 *
 * ## 重要：不要用 DOM 遍历顺序冒充屏幕上的层级
 *
 * `-webkit-app-region` 的矩形清单和实际绘制顺序不是一回事。悬浮按钮可以在 DOM
 * 前面、靠 z-index 压在标题栏上；旧版记录器只按 DOM 顺序取最后一个矩形，曾把按钮
 * 自己的点击误报成拖拽失效。现在同时用 `elementsFromPoint()` 记录屏幕上的真实命中栈，
 * 只有实际最上层仍是 drag 时才报 `drag_press_reached_page`。
 */
import { diagnostics } from "../diagnostics";

/** 一条矩形，和 Electron 收到的那串一一对应。 */
export interface DragRegion {
  element: string;
  draggable: boolean;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 两次记录之间至少隔这么久，按不动时连按几下不至于刷屏。 */
export const REPORT_INTERVAL_MS = 2_000;
const TITLE_STRIP_HEIGHT = 72;

function label(element: Element): string {
  const raw = typeof element.className === "string" ? element.className : "";
  const classes = raw.trim().split(/\s+/).filter(Boolean).slice(0, 3).join(".");
  return element.tagName.toLowerCase() + (classes ? `.${classes}` : "");
}

function regionForElement(target: Document, element: Element): DragRegion | undefined {
  const style = target.defaultView?.getComputedStyle(element);
  const mode = style?.getPropertyValue("-webkit-app-region");
  if (!style || !mode || mode === "none" || style.visibility !== "visible") return undefined;
  if (style.display === "inline" || style.display === "contents" || style.display === "none") return undefined;
  const box = element.getBoundingClientRect();
  return {
    element: label(element),
    draggable: mode === "drag",
    left: box.left,
    top: box.top,
    right: box.right,
    bottom: box.bottom,
  };
}

/** The app-region declaration on the topmost painted element at a point. */
function paintedRegionAt(target: Document, x: number, y: number): { region?: DragRegion; stack: string[] } {
  const elements = target.elementsFromPoint?.(x, y) ?? [];
  for (const element of elements) {
    const region = regionForElement(target, element);
    if (region) return { region, stack: elements.slice(0, 8).map(label) };
  }
  return { stack: elements.slice(0, 8).map(label) };
}

/**
 * 按 Chromium 收集可拖动矩形的规则走一遍文档。
 *
 * 跳过 `visibility: hidden` 和非盒元素（纯 inline 标了 app-region 等于没标），
 * 不按 overflow 裁剪——被滚出可视区、肉眼看不见的元素照样占着它那块矩形。
 */
export function collectDragRegions(target: Document = document): DragRegion[] {
  const regions: DragRegion[] = [];
  const walk = (element: Element): void => {
    const style = target.defaultView?.getComputedStyle(element);
    const mode = style?.getPropertyValue("-webkit-app-region");
    if (style && mode && mode !== "none" && style.visibility === "visible") {
      const display = style.display;
      if (display !== "inline" && display !== "contents" && display !== "none") {
        const box = element.getBoundingClientRect();
        regions.push({
          element: label(element),
          draggable: mode === "drag",
          left: box.left, top: box.top, right: box.right, bottom: box.bottom,
        });
      }
    }
    for (const child of element.children) walk(child);
  };
  if (target.documentElement) walk(target.documentElement);
  return regions;
}

/**
 * 窗口那边认为这一点归谁——Electron 真正拿来判断能不能拖的就是这个。屏幕上用户
 * 看到、以为自己按到的东西请用 paintedRegionAt；两者不一致就是洞。
 *
 * Electron 把这串矩形按顺序做并集（drag）/差集（no-drag）落成一个区域，对单点来说
 * 就等于：**最后一个盖住它的矩形说了算**。
 */
export function regionAt(regions: DragRegion[], x: number, y: number): DragRegion | undefined {
  let winner: DragRegion | undefined;
  for (const region of regions) {
    if (x >= region.left && x < region.right && y >= region.top && y < region.bottom) winner = region;
  }
  return winner;
}

/**
 * 这一下按下该不该被记成一次失效。
 *
 * 右键和 Ctrl+左键要排除：Electron 自己会在这两种按下期间整个关掉拖动区，让右键
 * 菜单能弹出来，那一下落到网页上是正常的。
 */
export function isDragPressLeak(button: number, ctrlKey: boolean, winner: DragRegion | undefined): boolean {
  if (button !== 0 || ctrlKey) return false;
  return winner?.draggable === true;
}

/** 装上记录器。返回卸载函数。 */
export function installWindowDragFailureReport(target: Document = document): () => void {
  let reportedAt = 0;
  const onMouseDown = (event: Event): void => {
    if (!(event instanceof MouseEvent)) return;
    const now = performance.now();
    if (now - reportedAt < REPORT_INTERVAL_MS) return;
    if (event.button !== 0 || event.ctrlKey || event.clientY < 0 || event.clientY > TITLE_STRIP_HEIGHT) return;
    const regions = collectDragRegions(target);
    const modelWinner = regionAt(regions, event.clientX, event.clientY);
    const painted = paintedRegionAt(target, event.clientX, event.clientY);
    const winner = painted.region;
    // A button/input/no-drag overlay is expected to receive the press. The old
    // DOM-order model often called this a drag failure when z-index put the
    // overlay above a later drag rectangle.
    if (!isDragPressLeak(event.button, event.ctrlKey, winner)) {
      if (modelWinner?.draggable && winner && !winner.draggable) {
        reportedAt = now;
        diagnostics.info("window-drag", "drag_region_model_mismatch", {
          point: { x: Math.round(event.clientX), y: Math.round(event.clientY) },
          modelWinner,
          paintedWinner: winner,
          paintStack: painted.stack,
          target: event.target instanceof Element ? label(event.target) : undefined,
          nativeWindowFocused: undefined,
        });
      }
      return;
    }
    reportedAt = now;
    const view = target.defaultView;
    const scroller = target.scrollingElement;
    diagnostics.warn("window-drag", "drag_press_reached_page", {
      point: { x: Math.round(event.clientX), y: Math.round(event.clientY) },
      // 屏幕上最上层和事件都表明这里应该是可拖的，可这一下还是落到了网页上。
      expected: winner,
      modelWinner,
      paintStack: painted.stack,
      target: event.target instanceof Element ? label(event.target) : undefined,
      regionCount: regions.length,
      dragRegions: regions.filter((region) => region.draggable),
      // 下面这些是用来找「窗口那边那份为什么会对不上」的线索。
      viewport: { width: view?.innerWidth, height: view?.innerHeight },
      outer: { width: view?.outerWidth, height: view?.outerHeight },
      screenPosition: { x: view?.screenX, y: view?.screenY },
      devicePixelRatio: view?.devicePixelRatio,
      rootScroll: { top: scroller?.scrollTop ?? 0, left: scroller?.scrollLeft ?? 0 },
      visibility: target.visibilityState,
      rendererFocused: target.hasFocus(),
      // 全屏时 Electron 本来就不接拖动，这一条能把那种情况摘出去。
      looksFullscreen: view ? view.outerHeight >= view.screen.height : undefined,
      activeElement: target.activeElement ? label(target.activeElement) : undefined,
      selectionEmpty: view?.getSelection()?.isCollapsed ?? true,
    });
  };
  target.addEventListener("mousedown", onMouseDown, { capture: true, passive: true });
  return () => target.removeEventListener("mousedown", onMouseDown, { capture: true });
}
