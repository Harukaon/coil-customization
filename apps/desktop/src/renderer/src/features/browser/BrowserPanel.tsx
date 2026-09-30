import * as Popover from "@radix-ui/react-popover";
import { ArrowLeft, ArrowRight, Globe2, Minus, MousePointer2, Plus, RotateCw, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BrowserElementSelection, BrowserStateSnapshot } from "../../../../shared/desktop-api";
import { isRemoteClient } from "../../hooks/useMobileRemote";
import { visibleBrowserTabs } from "../inspector/inspectorTabs";
import { toastError } from "../../ui/toast";
import { BrowserDataMenu } from "./BrowserDataMenu";
import { LivePageSurface } from "./LivePageSurface";
import { TextField } from "../../ui/form";

/** Fast enough to follow the agent clicking through a page, cheap enough to stream. */
const REMOTE_FRAME_INTERVAL_MS = 1_200;

/**
 * 内置浏览器的页面区：地址栏 + 网页。
 *
 * 标签条不在这里——每个网页标签都是右侧栏顶部那一排里的一个标签，和终端一样，
 * 由 WorkspaceInspector 画（见 features/inspector/inspectorTabs.ts）。所以这里
 * 永远只显示当前标签页，标签集合和当前标签由主进程说了算。
 */
export function BrowserPanel({ active, scopeId, state, onState, onElementPicked }: {
  active: boolean;
  scopeId: string;
  state: BrowserStateSnapshot;
  onState(next: BrowserStateSnapshot): void;
  onElementPicked(selection: BrowserElementSelection): void;
}): React.JSX.Element {
  const [address, setAddress] = useState("");
  const [zoomOpen, setZoomOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const pickRequestRef = useRef(0);
  const hostRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  // 网页版不管窗口多宽都不是桌面窗口：收不到画面，只能按截图看 Mac 上的页面。以前只按
  // 手机宽度判断，电脑上开网页版时页面一直「正在读取」。
  const remote = isRemoteClient();
  const [frame, setFrame] = useState<string>();
  const activeTab = useMemo(() => {
    const tabs = visibleBrowserTabs(state);
    return tabs.find((tab) => tab.id === state.activeTabId) ?? tabs[0];
  }, [state]);

  const scopeRef = useRef(scopeId);
  scopeRef.current = scopeId;

  useEffect(() => setAddress(activeTab?.url === "about:blank" ? "" : activeTab?.url ?? ""), [activeTab?.id, activeTab?.url]);

  const activeTabId = activeTab?.id;

  useEffect(() => {
    pickRequestRef.current += 1;
    setPicking(false);
    void window.coilcoil.cancelBrowserElementPick();
  }, [activeTabId]);

  useEffect(() => () => {
    pickRequestRef.current += 1;
    void window.coilcoil.cancelBrowserElementPick();
  }, []);

  /**
   * 手机、网页版：页面在 Mac 上，定时截一张图看。桌面窗口是把页面的实时画面直接画进
   * 面板（见 LivePageSurface），网页版拿不到那条通道。
   */
  useEffect(() => {
    if (!remote) { setFrame(undefined); return; }
    if (!active || !activeTabId) { setFrame(undefined); return; }
    let cancelled = false;
    let timer: number | undefined;
    const tick = async (): Promise<void> => {
      try {
        const next = await window.coilcoil.captureBrowserTab(scopeRef.current);
        if (!cancelled && next) setFrame(next);
      } catch {
        // A tab that went away mid-capture just means the next frame is late.
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), REMOTE_FRAME_INTERVAL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [remote, active, activeTabId]);

  // 面板多大，正看着的那张页面就多大（主进程把它的离屏窗口改成这个尺寸，Agent 问窗口
  // 大小时也答这个）；面板收起、窗口藏起来时报 0，那张页面就按后台尺寸渲染。
  useLayoutEffect(() => {
    const host = hostRef.current;
    // 网页版报自己的面板大小，会把 Mac 上的页面改成手机那么窄。
    if (!host || remote) return;
    const update = (): void => {
      const visible = active && document.visibilityState === "visible";
      const rect = host.getBoundingClientRect();
      if (!visible || !activeTabId || rect.width <= 0 || rect.height <= 0) {
        void window.coilcoil.setBrowserUiViewport({ width: 0, height: 0 });
        return;
      }
      void window.coilcoil.setBrowserUiViewport({ width: rect.width, height: rect.height });
    };
    const observer = new ResizeObserver(update);
    observer.observe(host);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      document.removeEventListener("visibilitychange", update);
      void window.coilcoil.setBrowserUiViewport({ width: 0, height: 0 });
    };
  }, [active, activeTabId, remote]);

  /**
   * Every toolbar action ends in a state refresh, so a failed one has to say so.
   * Without this the rejection had nowhere to go and became an unhandled promise
   * error in the log that the user never saw.
   */
  const apply = (action: Promise<BrowserStateSnapshot>): Promise<void> => action.then(onState).catch((error: unknown) => {
    toastError(error instanceof Error ? error.message : String(error));
  });

  const zoomPercent = Math.round((state.zoom ?? 1) * 100);
  const zoomed = zoomPercent !== 100;

  const submitAddress = (event: React.FormEvent): void => {
    event.preventDefault();
    void apply(window.coilcoil.navigateBrowser(scopeId, address));
  };

  const toggleElementPicker = (): void => {
    if (picking) {
      pickRequestRef.current += 1;
      setPicking(false);
      void window.coilcoil.cancelBrowserElementPick();
      return;
    }
    const request = ++pickRequestRef.current;
    setPicking(true);
    void window.coilcoil.pickBrowserElement(scopeId).then((selection) => {
      if (pickRequestRef.current !== request || !selection) return;
      onElementPicked(selection);
    }).catch((error: unknown) => {
      if (pickRequestRef.current === request) toastError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (pickRequestRef.current === request) setPicking(false);
    });
  };

  return (
    <section className="browser-panel">
      <form className="browser-toolbar no-drag" onSubmit={submitAddress}>
        <button type="button" aria-label="后退" disabled={!activeTab?.canGoBack} onClick={() => apply(window.coilcoil.browserBack(scopeId))}><ArrowLeft size={13} /></button>
        <button type="button" aria-label="前进" disabled={!activeTab?.canGoForward} onClick={() => apply(window.coilcoil.browserForward(scopeId))}><ArrowRight size={13} /></button>
        <button type="button" aria-label="刷新网页" disabled={!activeTab} onClick={() => apply(window.coilcoil.reloadBrowser(scopeId))}><RotateCw size={12} /></button>
        <TextField look="plain" className="browser-toolbar-input" ref={addressRef} aria-label="网页地址" value={address} placeholder="输入网址或搜索内容" spellCheck={false} onChange={(event) => setAddress(event.target.value)} />
        {remote ? null : (
          <button
            className={`browser-element-picker ${picking ? "active" : ""}`}
            type="button"
            aria-label={picking ? "取消选择网页元素" : "选择网页元素"}
            aria-pressed={picking}
            title={picking ? "取消选择" : "选择页面元素并附加到对话"}
            disabled={!activeTab || activeTab.loading}
            onClick={toggleElementPicker}
          >
            <MousePointer2 size={13} />
          </button>
        )}
        {/* 缩放是整个内置浏览器的字号，所以按钮平时只是个图标；调过之后它自己把
            当前倍数写在旁边，用户一眼知道现在不是 100%，不用点开确认。 */}
        <Popover.Root open={zoomOpen} onOpenChange={setZoomOpen}>
          <Popover.Trigger asChild>
            <button className="browser-zoom" type="button" aria-label="缩放">
              <Search size={13} />
              {zoomed ? <span>{zoomPercent}%</span> : null}
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content className="browser-zoom-popover" side="bottom" align="end" sideOffset={6} collisionPadding={12}>
              <button type="button" aria-label="缩小" disabled={zoomPercent <= 50} onClick={() => apply(window.coilcoil.setBrowserZoom(scopeId, "out"))}><Minus size={13} /></button>
              <strong>{zoomPercent}%</strong>
              <button type="button" aria-label="放大" disabled={zoomPercent >= 300} onClick={() => apply(window.coilcoil.setBrowserZoom(scopeId, "in"))}><Plus size={13} /></button>
              <button type="button" className="browser-zoom-reset" disabled={!zoomed} onClick={() => apply(window.coilcoil.setBrowserZoom(scopeId, "reset"))}>重置</button>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        {/* Importing reads this Mac's keychain, so it stays on the Mac's own window. */}
        {remote ? null : <BrowserDataMenu />}
      </form>
      <div className={`browser-native-host ${remote ? "browser-remote-host" : ""}`} ref={hostRef}>
        {!activeTab ? <div className="browser-empty"><Globe2 size={24} /><strong>打开内置浏览器</strong><button type="button" onClick={() => apply(window.coilcoil.createBrowserTab(scopeId))}>新建标签页</button></div> : null}
        {/* 每张标签页都是离屏页面：面板里显示它的画面，用户直接在画面上点、打字，和
            Agent 用的是同一个页面。 */}
        {activeTab ? (
          <LivePageSurface
            key={activeTab.id}
            tab={activeTab}
            scopeId={scopeId}
            remoteFrame={remote ? frame ?? "" : undefined}
            onReload={() => void apply(window.coilcoil.reloadBrowser(scopeId))}
            onBack={() => void apply(window.coilcoil.browserBack(scopeId))}
            onForward={() => void apply(window.coilcoil.browserForward(scopeId))}
            onFocusAddress={() => { addressRef.current?.focus(); addressRef.current?.select(); }}
          />
        ) : null}
      </div>
    </section>
  );
}
