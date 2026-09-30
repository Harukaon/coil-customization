import { Bot, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BrowserInputModifiers, BrowserPageInput, BrowserSelectPicker, BrowserSurfaceInfo, BrowserTabSnapshot, BrowserValuePicker } from "../../../../shared/desktop-api";
import { rendererPlatform } from "../../platform";
import { PageDialog } from "./PageDialog";
import { PageFindBar } from "./PageFindBar";
import { PageSelectPicker } from "./PageSelectPicker";
import { PageValuePicker } from "./PageValuePicker";
import { TextArea } from "../../ui/form";

/**
 * 面板里的一张离屏页面：显示它的实时画面，用户在画面上的操作原样送进页面。
 *
 * 页面本身在主进程里离屏渲染（browser-offscreen.ts），Agent 也在操作同一个页面——
 * 没有接管，也不刷新。用户的鼠标、滚轮落在画面上，按画面对应的页面位置送过去；键盘
 * 和输入法先落在一个看不见的输入框（焦点代理）里，由它把按键、组字过程转成页面的
 * 输入。用户点回 App 别处，焦点代理失焦，页面也跟着失焦。
 *
 * Agent 怎么操作都碰不到这个输入框：它的点击和打字只进离屏页面，所以用户在对话框里
 * 打字时，焦点一直在对话框里。
 *
 * 画面由预加载直接画进这里的画布（有 GPU 时是共享纹理，60 帧，不经过 React），
 * 这里只拿「画面多大」来换算点击位置，不会每帧重画界面。
 *
 * `remoteFrame` 是网页版、手机用的：它们拿的是定时截图，只看不点。
 */
export function LivePageSurface({ tab, scopeId, remoteFrame, onReload, onBack, onForward, onFocusAddress }: {
  tab: BrowserTabSnapshot;
  scopeId: string;
  remoteFrame?: string;
  onReload(): void;
  onBack(): void;
  onForward(): void;
  onFocusAddress(): void;
}): React.JSX.Element {
  const [info, setInfo] = useState<BrowserSurfaceInfo>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [cursor, setCursor] = useState("default");
  // 焦点代理（接键盘的隐形输入框）在画面上的位置：输入法候选框总出现在它旁边。
  const [proxyAt, setProxyAt] = useState({ x: 0, y: 0, height: 16 });
  const composingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const proxyRef = useRef<HTMLTextAreaElement>(null);
  /** 最近一帧画的页面有多大：用户点画面上哪儿，按这一帧换算成页面上的位置。 */
  const viewportRef = useRef<{ width: number; height: number } | undefined>(undefined);
  const interactive = remoteFrame === undefined;

  useEffect(() => {
    setInfo(undefined);
    viewportRef.current = undefined;
    const canvas = canvasRef.current;
    if (!interactive || !canvas) return;
    return window.coilcoil.attachBrowserSurface(tab.id, canvas, (next) => {
      viewportRef.current = next.viewport;
      setInfo(next);
    });
  }, [interactive, tab.id]);

  // 页面内查找（⌘F）：查找栏开着吗、最近一次的结果。
  const [findOpen, setFindOpen] = useState(false);
  const [findResult, setFindResult] = useState<{ matches: number; active: number }>();
  const find = useCallback((text: string, forward: boolean, newSearch: boolean): void => {
    if (newSearch) setFindResult(undefined);
    window.coilcoil.findInBrowserPage(scopeId, tab.id, text ? { text, forward, newSearch } : { stop: true });
  }, [scopeId, tab.id]);
  const closeFind = useCallback((): void => {
    setFindOpen(false);
    setFindResult(undefined);
    window.coilcoil.findInBrowserPage(scopeId, tab.id, { stop: true });
    proxyRef.current?.focus({ preventScroll: true });
  }, [scopeId, tab.id]);
  // 换了标签页（这个组件按标签页重建）或组件收起时，清掉那张页面上的高亮。
  useEffect(() => () => window.coilcoil.findInBrowserPage(scopeId, tab.id, { stop: true }), [scopeId, tab.id]);

  // 用户点开的网页下拉框：列表由面板画（离屏页面里原生弹层出不来，见 browser-page-selects.ts）。
  const [picker, setPicker] = useState<BrowserSelectPicker>();
  const pickerRef = useRef<BrowserSelectPicker | undefined>(undefined);
  // 用户点开的日期、时间、颜色选择器：用 App 窗口里 Chromium 自己的（见 PageValuePicker）。
  const [valuePicker, setValuePicker] = useState<BrowserValuePicker>();
  const valuePickerRef = useRef<BrowserValuePicker | undefined>(undefined);

  useEffect(() => {
    setCursor("default");
    setPicker(undefined);
    pickerRef.current = undefined;
    setValuePicker(undefined);
    valuePickerRef.current = undefined;
    if (!interactive) return;
    const stop = window.coilcoil.onBrowserPageEvent((event) => {
      if (event.tabId !== tab.id) return;
      if (event.kind === "cursor") setCursor(event.cursor);
      else if (event.kind === "find") setFindResult({ matches: event.matches, active: event.active });
      else if (event.kind === "value-picker") {
        // 用户已经点回 App 别处了：不在他面前弹选择器。
        if (event.picker && document.activeElement !== proxyRef.current) {
          void window.coilcoil.chooseBrowserValue(scopeId, tab.id, event.picker.id, null, false).catch(() => undefined);
          return;
        }
        valuePickerRef.current = event.picker ?? undefined;
        setValuePicker(event.picker ?? undefined);
      } else if (event.kind === "select") {
        if (event.picker && document.activeElement !== proxyRef.current) {
          void window.coilcoil.chooseBrowserSelect(scopeId, tab.id, event.picker.id, null).catch(() => undefined);
          return;
        }
        pickerRef.current = event.picker ?? undefined;
        setPicker(event.picker ?? undefined);
      }
    });
    return () => {
      stop();
      const open = pickerRef.current;
      pickerRef.current = undefined;
      if (open) void window.coilcoil.chooseBrowserSelect(scopeId, tab.id, open.id, null).catch(() => undefined);
      const openValue = valuePickerRef.current;
      valuePickerRef.current = undefined;
      if (openValue) void window.coilcoil.chooseBrowserValue(scopeId, tab.id, openValue.id, null, false).catch(() => undefined);
    };
  }, [interactive, scopeId, tab.id]);

  /** 选了一项或者放弃：写回页面、收起列表，键盘还给页面。只认一次，收起时的失焦不再算第二次。 */
  const choose = useCallback((index: number | null, restoreFocus = true): void => {
    const open = pickerRef.current;
    if (!open) return;
    pickerRef.current = undefined;
    setPicker(undefined);
    const previous = document.activeElement;
    void window.coilcoil.chooseBrowserSelect(scopeId, tab.id, open.id, index).catch(() => undefined).then(() => {
      if (restoreFocus && (document.activeElement === previous || document.activeElement === document.body)) {
        proxyRef.current?.focus({ preventScroll: true });
      }
    });
  }, [scopeId, tab.id]);

  /** 日期、时间、颜色选择器关了（选完、Esc、点别处）：告诉页面那边收起，键盘还给页面。 */
  const closeValuePicker = useCallback((): void => {
    const open = valuePickerRef.current;
    if (!open) return;
    valuePickerRef.current = undefined;
    setValuePicker(undefined);
    void window.coilcoil.chooseBrowserValue(scopeId, tab.id, open.id, null, false).catch(() => undefined);
    if (document.activeElement === document.body) proxyRef.current?.focus({ preventScroll: true });
  }, [scopeId, tab.id]);

  const send = useCallback((input: BrowserPageInput): void => {
    window.coilcoil.sendBrowserInput(scopeId, tab.id, input);
  }, [scopeId, tab.id]);

  // 输入法候选框跟着页面里的光标走：点完、按完键、输完一段字之后问一下页面光标在哪儿，
  // 把焦点代理挪过去。问不到（没在能打字的地方、跨源内嵌页）就留在用户点的地方；
  // 正在组字时不挪，候选框不跳。
  const caretTimer = useRef(0);
  const caretAsk = useRef(0);
  const followCaret = useCallback((delay: number): void => {
    window.clearTimeout(caretTimer.current);
    caretTimer.current = window.setTimeout(() => {
      const ask = ++caretAsk.current;
      void window.coilcoil.readBrowserCaret(scopeId, tab.id).then((caret) => {
        const root = rootRef.current;
        const viewport = viewportRef.current;
        if (ask !== caretAsk.current || composingRef.current || !caret || !root || !viewport) return;
        const box = root.getBoundingClientRect();
        const scale = Math.min(box.width / viewport.width, box.height / viewport.height);
        if (!Number.isFinite(scale) || scale <= 0) return;
        const height = Math.max(8, Math.min(96, caret.height * scale));
        setProxyAt({
          x: Math.max(0, Math.min(box.width - 1, caret.x * scale)),
          y: Math.max(0, Math.min(box.height - height, caret.y * scale)),
          height,
        });
      }).catch(() => undefined);
    }, delay);
  }, [scopeId, tab.id]);
  useEffect(() => () => window.clearTimeout(caretTimer.current), []);

  /**
   * 画面上的一点对应页面上的哪一点。
   *
   * 画面按页面比例贴在左上角（object-fit: contain），页面和面板一样大时一比一；Agent
   * 把页面调成手机尺寸时会缩放。落在画面外的（缩放后留出的空白）不算点到页面。
   */
  const pagePoint = useCallback((clientX: number, clientY: number, captured = false): { x: number; y: number } | undefined => {
    const root = rootRef.current;
    const viewport = viewportRef.current;
    if (!root || !viewport || viewport.width <= 0 || viewport.height <= 0) return undefined;
    const box = root.getBoundingClientRect();
    const scale = Math.min(box.width / viewport.width, box.height / viewport.height);
    if (!Number.isFinite(scale) || scale <= 0) return undefined;
    const x = (clientX - box.left) / scale;
    const y = (clientY - box.top) / scale;
    if (!captured && (x < 0 || y < 0 || x > viewport.width || y > viewport.height)) return undefined;
    return { x: Math.max(0, Math.min(viewport.width - 1, x)), y: Math.max(0, Math.min(viewport.height - 1, y)) };
  }, []);

  // 网页的悬停提示（元素的 title）：离屏页面里浏览器不画，鼠标停住 0.6 秒后问一下网页，有就
  // 画在鼠标下面；一动、一按、一滚、一打字就收起（见 browser-page-tooltip.ts）。
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number }>();
  const tooltipRef = useRef<HTMLDivElement>(null);
  const hover = useRef({ timer: 0, ask: 0, x: 0, y: 0, showing: false });
  const hideTooltip = useCallback((): void => {
    const state = hover.current;
    window.clearTimeout(state.timer);
    state.timer = 0;
    state.ask += 1;
    state.showing = false;
    setTooltip(undefined);
  }, []);
  const hoverAt = useCallback((clientX: number, clientY: number): void => {
    const state = hover.current;
    // 停着不动时 pointermove 也可能再来一下、手也会抖：没挪出 4 像素就不算动（在等的接着等，显示着的接着显示）。
    if (Math.abs(clientX - state.x) < 4 && Math.abs(clientY - state.y) < 4 && (state.timer || state.showing)) return;
    hideTooltip();
    state.x = clientX;
    state.y = clientY;
    const ask = state.ask;
    state.timer = window.setTimeout(() => {
      state.timer = 0;
      const point = pagePoint(clientX, clientY);
      const root = rootRef.current;
      if (!point || !root) return;
      void window.coilcoil.readBrowserTooltip(scopeId, tab.id, point).then((text) => {
        if (!text || ask !== hover.current.ask) return;
        const box = root.getBoundingClientRect();
        hover.current.showing = true;
        setTooltip({ text, x: clientX - box.left, y: clientY - box.top });
      }).catch(() => undefined);
    }, 600);
  }, [hideTooltip, pagePoint, scopeId, tab.id]);
  useEffect(() => () => window.clearTimeout(hover.current.timer), []);
  // 提示贴在鼠标下面；放不下时往左挪、翻到鼠标上面，不出画面。
  useLayoutEffect(() => {
    const element = tooltipRef.current;
    const root = rootRef.current;
    if (!tooltip || !element || !root) return;
    const left = Math.min(tooltip.x + 2, root.clientWidth - element.offsetWidth - 6);
    const below = tooltip.y + 20;
    const top = below + element.offsetHeight > root.clientHeight - 6 ? tooltip.y - element.offsetHeight - 8 : below;
    element.style.left = `${Math.max(6, left)}px`;
    element.style.top = `${Math.max(6, top)}px`;
  }, [tooltip]);

  // 鼠标移动一帧只送一次最新的位置；按下、抬起、滚轮之前先把攒着的那次送掉，顺序不能乱。
  const pendingMove = useRef<{ clientX: number; clientY: number; buttons: number; modifiers: BrowserInputModifiers } | undefined>(undefined);
  const moveFrame = useRef(0);
  const flushMove = useCallback((): void => {
    if (moveFrame.current) cancelAnimationFrame(moveFrame.current);
    moveFrame.current = 0;
    const move = pendingMove.current;
    pendingMove.current = undefined;
    if (!move) return;
    const point = pagePoint(move.clientX, move.clientY, move.buttons !== 0);
    if (!point) return;
    send({ kind: "mouse", type: "move", ...point, button: "none", clickCount: 0, buttons: move.buttons, modifiers: move.modifiers });
  }, [pagePoint, send]);
  useEffect(() => () => { if (moveFrame.current) cancelAnimationFrame(moveFrame.current); }, []);

  const sendButton = (event: React.MouseEvent, type: "down" | "up"): void => {
    const button = event.button === 0 ? "left" : event.button === 1 ? "middle" : event.button === 2 ? "right" : undefined;
    if (!button) return;
    const point = pagePoint(event.clientX, event.clientY, type === "up");
    if (!point) return;
    flushMove();
    send({ kind: "mouse", type, ...point, button, clickCount: Math.max(1, event.detail), buttons: event.buttons, modifiers: modifiersOf(event) });
  };

  // 从访达拖文件到页面上：拖着经过时面板描一圈提示，松手时把文件交给页面，放进松手的
  // 位置（见 browser-page-drags.ts）。网页自己拖来拖去的不在这里，在主进程里接。
  const [fileOver, setFileOver] = useState(false);
  const carriesFiles = (event: React.DragEvent): boolean => Array.from(event.dataTransfer.types).includes("Files");
  const fileDrag: Pick<React.HTMLAttributes<HTMLDivElement>, "onDragEnter" | "onDragOver" | "onDragLeave" | "onDrop"> = {
    onDragEnter: (event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setFileOver(true);
    },
    onDragOver: (event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (event) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setFileOver(false);
    },
    onDrop: (event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setFileOver(false);
      const point = pagePoint(event.clientX, event.clientY);
      const files = Array.from(event.dataTransfer.files);
      if (!point || !files.length) return;
      window.coilcoil.dropFilesIntoBrowserPage(scopeId, tab.id, { ...point, modifiers: modifiersOf(event) }, files);
      proxyRef.current?.focus({ preventScroll: true });
    },
  };

  const dismissedButton = useRef<number | undefined>(undefined);
  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>): void => {
    // 不让 App 自己处理这次按下（选中文字、把焦点给别的元素）；焦点交给焦点代理。
    event.preventDefault();
    hideTooltip();
    // 下拉框的列表开着时，点别处只是把它收起来，和系统下拉菜单一样，这一下不送进页面。
    if (pickerRef.current) { dismissedButton.current = event.button; choose(null); return; }
    // 鼠标侧键：后退、前进，和浏览器一样。
    if (event.button === 3) { onBack(); return; }
    if (event.button === 4) { onForward(); return; }
    const root = rootRef.current;
    if (root) {
      const box = root.getBoundingClientRect();
      // 输入法的候选框跟着焦点代理走，放在用户点的地方，候选框就出现在他打字的位置附近。
      setProxyAt({ x: Math.max(0, event.clientX - box.left), y: Math.max(0, event.clientY - box.top), height: 16 });
    }
    proxyRef.current?.focus({ preventScroll: true });
    sendButton(event, "down");
  };

  // 拖动时指针跑出画面也要继续跟：按下时把指针抓在这一层上，松开之前的移动和抬起都归它。
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.buttons) hideTooltip();
    else hoverAt(event.clientX, event.clientY);
    pendingMove.current = { clientX: event.clientX, clientY: event.clientY, buttons: event.buttons, modifiers: modifiersOf(event) };
    if (!moveFrame.current) moveFrame.current = requestAnimationFrame(flushMove);
  };

  const onPointerLeave = (event: React.PointerEvent<HTMLDivElement>): void => {
    hideTooltip();
    if (event.buttons) return;
    flushMove();
    send({ kind: "mouse", type: "leave", x: 0, y: 0, button: "none", clickCount: 0, buttons: 0, modifiers: modifiersOf(event) });
  };

  // 滚轮要拦下 App 自己的滚动和缩放，React 的 onWheel 是被动监听拦不住，所以自己挂。
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !interactive) return;
    const onWheel = (event: WheelEvent): void => {
      if ((event.target as Element | null)?.closest(".browser-select-picker")) return;
      event.preventDefault();
      hideTooltip();
      if (pickerRef.current) { choose(null); return; }
      const point = pagePoint(event.clientX, event.clientY);
      if (!point) return;
      flushMove();
      // 按行、按页滚的鼠标（deltaMode 1、2）换成像素，页面里的滚动距离才对。
      const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? root.clientHeight : 1;
      send({ kind: "wheel", ...point, deltaX: event.deltaX * unit, deltaY: event.deltaY * unit, modifiers: modifiersOf(event) });
      // 页面滚了，光标在画面上的位置也跟着变。
      if (document.activeElement === proxyRef.current) followCaret(250);
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [choose, flushMove, followCaret, hideTooltip, interactive, pagePoint, send]);

  const keyboard = useSurfaceKeyboard({
    send,
    composing: composingRef,
    onCaretMoved: () => followCaret(60),
    onReload,
    onBack,
    onForward,
    onFocusAddress,
    onFind: () => setFindOpen(true),
  });

  // 用户点回 App 别处（焦点代理失焦）或者这张页面不再显示：告诉页面它失焦了。
  const focusedRef = useRef(false);
  useEffect(() => () => {
    if (focusedRef.current) send({ kind: "focus", focused: false });
  }, [send]);

  // 面板大小变了（拖分隔条、窗口缩放）：下拉列表收起，和系统下拉菜单一样，不留在错位的地方。
  useEffect(() => {
    const root = rootRef.current;
    if (!picker || !root) return;
    let first = true;
    const observer = new ResizeObserver(() => {
      if (first) { first = false; return; }
      choose(null);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [picker, choose]);

  const dialog = tab.dialog;
  const box = rootRef.current?.getBoundingClientRect();
  const viewport = info?.viewport;
  const scale = box && viewport ? Math.min(box.width / viewport.width, box.height / viewport.height) : 1;
  const loading = interactive ? !info : !remoteFrame;
  return (
    <div className={`browser-live-page ${interactive ? "interactive" : ""} ${dialog ? "has-dialog" : ""}`} ref={rootRef} onKeyDownCapture={hideTooltip}>
      {interactive
        // 第一帧到之前藏着：切标签时画布里还是上一张页面的画面。
        ? <canvas ref={canvasRef} className={`browser-live-frame ${info ? "" : "waiting"}`} data-mode={info?.mode} role="img" aria-label={tab.title} />
        : remoteFrame ? <img className="browser-live-frame" src={remoteFrame} alt={tab.title} draggable={false} /> : null}
      {loading ? <div className="browser-empty"><LoaderCircle className="spin" size={20} /><strong>正在读取页面…</strong></div> : null}
      {interactive ? (
        <div
          className="browser-live-input"
          style={{ cursor }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
          onMouseDown={onMouseDown}
          onMouseUp={(event) => {
            if (dismissedButton.current === event.button) { dismissedButton.current = undefined; return; }
            sendButton(event, "up");
            followCaret(50);
          }}
          onContextMenu={(event) => event.preventDefault()}
          {...fileDrag}
        />
      ) : null}
      {fileOver ? <div className="browser-drop-hint" aria-hidden="true"><span>松手，把文件放进网页</span></div> : null}
      {tooltip ? <div ref={tooltipRef} className="coil-tooltip browser-page-tooltip" role="tooltip">{tooltip.text}</div> : null}
      {interactive ? (
        <TextArea look="plain"
          ref={proxyRef}
          className="browser-live-proxy"
          style={{ left: proxyAt.x, top: proxyAt.y, fontSize: proxyAt.height }}
          aria-label={`网页：${tab.title}`}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          tabIndex={-1}
          onFocus={() => { focusedRef.current = true; send({ kind: "focus", focused: true }); followCaret(50); }}
          onBlur={() => { focusedRef.current = false; send({ kind: "focus", focused: false }); }}
          {...keyboard}
        />
      ) : null}
      {findOpen && interactive ? <PageFindBar result={findResult} onFind={find} onClose={closeFind} /> : null}
      {valuePicker && box ? (
        <PageValuePicker
          key={valuePicker.id}
          picker={valuePicker}
          scale={scale}
          onValue={(value, final) => void window.coilcoil.chooseBrowserValue(scopeId, tab.id, valuePicker.id, value, final).catch(() => undefined)}
          onClose={closeValuePicker}
        />
      ) : null}
      {picker && box ? (
        <PageSelectPicker key={picker.id} picker={picker} scale={scale} bounds={{ width: box.width, height: box.height }} onChoose={choose} />
      ) : null}
      {dialog ? (
        // 网页弹的对话框还在等回答：页面脚本停着，画面上的点击送进去也没用，先让用户答它。
        <PageDialog
          key={dialog.id}
          dialog={dialog}
          onReply={(accept, text) => void window.coilcoil.replyBrowserDialog(scopeId, tab.id, dialog.id, accept, text)}
        />
      ) : null}
      {tab.agentActive ? (
        // Agent 这会儿正在操作这张页面（不管是谁开的；停手几秒后收起）：底部一句安静的提示。以前
        // 还有流动的彩色描边、光晕和毛玻璃，用户嫌太重，去掉了。不挡操作——用户和 Agent 可以同时
        // 操作，不排队；用户把鼠标移上来、或者正在页面里打字时，提示变淡，不挡他看页面。
        <div className="browser-agent-bar" role="status">
          <Bot size={13} aria-hidden="true" />
          <span>Agent 正在操作这个页面</span>
        </div>
      ) : null}
    </div>
  );
}

function modifiersOf(event: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): BrowserInputModifiers {
  return { shift: event.shiftKey, control: event.ctrlKey, alt: event.altKey, meta: event.metaKey };
}

/**
 * 这些组合键归 App（新建对话、设置）或系统菜单（退出、隐藏、最小化、关窗口、缩放
 * 界面、开发者工具），不送进页面，也不拦，照常往上传。
 */
function isAppShortcut(event: React.KeyboardEvent, mac: boolean): boolean {
  const mod = mac ? event.metaKey : event.ctrlKey;
  if (!mod) return false;
  const key = event.key.toLowerCase();
  if (["n", ",", "q", "h", "m", "w", "=", "+", "-", "0", "`"].includes(key)) return true;
  return event.altKey && key === "i";
}

/**
 * 焦点代理上的键盘和输入法。
 *
 * - 普通按键：原样送进页面，并拦下（输入框里不留字、App 的快捷键不跟着动）。
 * - 输入法组字：按键不送（keyCode 229），组字过程和结果单独送，页面收到完整的组字事件。
 * - 浏览器自己的快捷键（⌘L 地址栏、⌘R 刷新、⌘[ ⌘] 前进后退）由面板处理。
 * - 表情面板、听写这些不经键盘插进来的字，当文字送过去。
 * - 菜单栏「编辑」里的复制粘贴会落在焦点代理上，转成对页面的复制粘贴；按 ⌘C 这类
 *   快捷键时已经随按键送过，菜单那一下就不再送第二遍。
 */
function useSurfaceKeyboard({ send, composing, onCaretMoved, onReload, onBack, onForward, onFocusAddress, onFind }: {
  send(input: BrowserPageInput): void;
  /** 正在组字吗：面板这边也要知道，组字时不挪候选框。 */
  composing: React.MutableRefObject<boolean>;
  /** 按完键、输完一段字：页面里的光标可能挪了。 */
  onCaretMoved(): void;
  onReload(): void;
  onBack(): void;
  onForward(): void;
  onFocusAddress(): void;
  /** ⌘F / Ctrl+F：打开面板的查找栏。 */
  onFind(): void;
}): Pick<React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  "onKeyDown" | "onKeyUp" | "onCompositionUpdate" | "onCompositionEnd" | "onInput" | "onCopy" | "onCut" | "onPaste" | "onBeforeInput"> {
  const mac = rendererPlatform() === "darwin";
  const pressed = useRef(new Set<string>());
  /** 刚随按键送过的编辑命令，菜单栏紧跟着再触发一次时不重复送。 */
  const recentEdit = useRef<{ command: string; at: number } | undefined>(undefined);

  const clear = (element: HTMLTextAreaElement): void => { if (element.value) element.value = ""; };

  const editOnce = (command: "copy" | "cut" | "paste" | "undo" | "redo"): void => {
    const recent = recentEdit.current;
    if (recent && recent.command === command && Date.now() - recent.at < 400) return;
    send({ kind: "edit", command });
  };

  return {
    onKeyDown: (event) => {
      const native = event.nativeEvent;
      if (native.isComposing || event.keyCode === 229 || event.key === "Dead" || event.key === "Process" || composing.current) return;
      const mod = mac ? event.metaKey : event.ctrlKey;
      if (mod && !event.altKey && !event.shiftKey) {
        const key = event.key.toLowerCase();
        const panel = key === "l" ? onFocusAddress : key === "r" ? onReload : key === "[" ? onBack : key === "]" ? onForward : key === "f" ? onFind : undefined;
        if (panel) {
          event.preventDefault();
          event.stopPropagation();
          panel();
          return;
        }
      }
      if (isAppShortcut(event, mac)) return;
      event.preventDefault();
      event.stopPropagation();
      if (mod) {
        const key = event.key.toLowerCase();
        const command = key === "c" ? "copy" : key === "x" ? "cut" : key === "v" ? "paste" : key === "z" ? (event.shiftKey ? "redo" : "undo") : undefined;
        if (command) recentEdit.current = { command, at: Date.now() };
      }
      pressed.current.add(event.code);
      send({
        kind: "key",
        type: "down",
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        location: event.location,
        repeat: event.repeat,
        modifiers: modifiersOf(event),
      });
    },
    onKeyUp: (event) => {
      if (!pressed.current.delete(event.code)) return;
      event.preventDefault();
      event.stopPropagation();
      send({
        kind: "key",
        type: "up",
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        location: event.location,
        repeat: false,
        modifiers: modifiersOf(event),
      });
      onCaretMoved();
    },
    onCompositionUpdate: (event) => {
      composing.current = true;
      const text = event.data;
      send({ kind: "ime", type: "update", text, selectionStart: text.length, selectionEnd: text.length });
    },
    onCompositionEnd: (event) => {
      composing.current = false;
      const text = event.data;
      send(text ? { kind: "ime", type: "commit", text } : { kind: "ime", type: "cancel" });
      clear(event.currentTarget);
      onCaretMoved();
    },
    onInput: (event) => {
      const native = event.nativeEvent as InputEvent;
      const element = event.currentTarget;
      if (native.isComposing || composing.current || native.inputType === "insertCompositionText") return;
      // 按键打的字在按下时就送过、也拦下了；走到这里的是表情面板、听写这类直接插进来的字。
      if (native.data && native.inputType.startsWith("insert")) send({ kind: "text", text: native.data });
      clear(element);
    },
    onBeforeInput: (event) => {
      const native = event.nativeEvent as InputEvent;
      if (native.inputType === "historyUndo" || native.inputType === "historyRedo") {
        event.preventDefault();
        editOnce(native.inputType === "historyUndo" ? "undo" : "redo");
      }
    },
    onCopy: (event) => { event.preventDefault(); editOnce("copy"); },
    onCut: (event) => { event.preventDefault(); editOnce("cut"); },
    onPaste: (event) => { event.preventDefault(); editOnce("paste"); },
  };
}
