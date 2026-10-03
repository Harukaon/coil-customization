import * as Popover from "@radix-ui/react-popover";
import { Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { WindowDragBar } from "../../ui/WindowDragBar";
import { isMiddleClickClose, MIDDLE_MOUSE_BUTTON } from "./inspectorTabs";

export interface InspectorTab<T extends string> {
  id: T;
  label: string;
  icon: LucideIcon;
  closable?: boolean;
  disabled?: boolean;
  /** 图标转起来表示还在加载（网页标签用）。 */
  spinning?: boolean;
  /** 悬停提示；不给就用 label。 */
  hint?: string;
}

export function InspectorPane<T extends string>({
  tabs,
  activeTab,
  onSelectTab,
  onCloseTab,
  addControlTarget,
  showAddControl,
  addOptions,
  onAddTab,
  emptyState,
  children,
}: {
  tabs: InspectorTab<T>[];
  activeTab: T;
  onSelectTab: (tab: T) => void;
  onCloseTab?: (tab: T) => void;
  addControlTarget: HTMLElement | null;
  showAddControl: boolean;
  addOptions?: InspectorTab<T>[];
  onAddTab?: (tab: T) => void;
  emptyState?: ReactNode;
  children: ReactNode;
}): React.JSX.Element {
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const scrollbarRef = useRef<HTMLDivElement>(null);
  const [scrollbar, setScrollbar] = useState({ visible: false, thumbRatio: 1, offsetRatio: 0 });
  const addControl = showAddControl && addOptions?.length && onAddTab ? (
    <Popover.Root open={addMenuOpen} onOpenChange={setAddMenuOpen}>
      <Popover.Trigger asChild>
        <button className="icon-button inspector-add-tab" type="button" aria-label="打开面板" title="打开面板"><Plus size={15} /></button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="inspector-add-popover" role="menu" side="bottom" align="end" sideOffset={5} collisionPadding={8}>
          {addOptions.map((item) => {
            const Icon = item.icon;
            return <button key={item.id} type="button" role="menuitem" disabled={item.disabled} onClick={() => { onAddTab(item.id); setAddMenuOpen(false); }}><Icon size={13} /><span>{item.label}</span></button>;
          })}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  ) : null;
  const updateScrollbar = useCallback((): void => {
    const nav = navRef.current;
    if (!nav) return;
    const maxScroll = Math.max(0, nav.scrollWidth - nav.clientWidth);
    if (!maxScroll) {
      setScrollbar({ visible: false, thumbRatio: 1, offsetRatio: 0 });
      return;
    }
    const thumbRatio = Math.min(1, Math.max(0.18, nav.clientWidth / nav.scrollWidth));
    const scrollRatio = nav.scrollLeft / maxScroll;
    setScrollbar({
      visible: true,
      thumbRatio,
      offsetRatio: scrollRatio * (1 - thumbRatio),
    });
  }, []);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const update = (): void => updateScrollbar();
    update();
    nav.addEventListener("scroll", update, { passive: true });
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(nav);
    const mutationObserver = new MutationObserver(update);
    mutationObserver.observe(nav, { childList: true, subtree: true, characterData: true });
    return () => {
      nav.removeEventListener("scroll", update);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [tabs.length, updateScrollbar]);

  const dragScrollbar = useCallback((event: ReactPointerEvent<HTMLSpanElement>): void => {
    const nav = navRef.current;
    const track = scrollbarRef.current;
    if (!nav || !track || !scrollbar.visible) return;
    const startX = event.clientX;
    const startScrollLeft = nav.scrollLeft;
    const maxScroll = Math.max(0, nav.scrollWidth - nav.clientWidth);
    const travel = Math.max(1, track.clientWidth * (1 - scrollbar.thumbRatio));
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent): void => {
      nav.scrollLeft = Math.max(0, Math.min(maxScroll, startScrollLeft + ((next.clientX - startX) * maxScroll) / travel));
    };
    const end = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }, [scrollbar]);

  return (
    <aside className="inspector-pane">
      {addControlTarget && addControl ? createPortal(addControl, addControlTarget) : null}
      <section className={`inspector-content inspector-content-${activeTab}`}>
        {tabs.length ? children : <div className="inspector-empty-tabs">{emptyState}</div>}
      </section>
      {/* 标题栏排在内容后面，屏幕上的位置由 grid-row 摆回顶上：内容往上滚走的按钮矩形还垫在
          标题栏底下，标题栏排在后面才盖得住。标题栏里面，拖动层仍然排在最前，标签条和右侧
          按钮在它上面挖洞。整条约定见 ui/WindowDragBar.tsx。 */}
      <header className="inspector-header window-drag-bar">
        <WindowDragBar />
        <nav ref={navRef} className="inspector-nav no-drag" aria-label="右侧面板">
          {tabs.map((item) => {
            const Icon = item.icon;
            return (
              <div
                className={`inspector-tab ${item.id === activeTab ? "active" : ""}`}
                key={item.id}
                // 中键关闭。按下那一下就要拦掉，否则 Chromium 会先起自动滚动
                // （Linux 上还有中键粘贴），松开时的 auxclick 就不一定还在这个标签上。
                onMouseDown={(event) => { if (event.button === MIDDLE_MOUSE_BUTTON) event.preventDefault(); }}
                onAuxClick={(event) => {
                  if (!onCloseTab || !isMiddleClickClose(event.button, item.closable)) return;
                  event.preventDefault();
                  onCloseTab(item.id);
                }}
              >
                <button
                  className="inspector-tab-select"
                  type="button"
                  title={item.hint ?? item.label}
                  aria-label={item.hint ?? item.label}
                  aria-pressed={item.id === activeTab}
                  onClick={() => onSelectTab(item.id)}
                >
                  <Icon className={item.spinning ? "spin" : undefined} size={15} strokeWidth={1.7} />
                  <span>{item.label}</span>
                </button>
                {item.closable && onCloseTab ? (
                  <button className="inspector-tab-close" type="button" aria-label={`关闭 ${item.label}`} onClick={() => onCloseTab(item.id)}>
                    <X size={11} />
                  </button>
                ) : null}
              </div>
            );
          })}
        </nav>
        {scrollbar.visible ? (
          <div ref={scrollbarRef} className="inspector-scrollbar no-drag" aria-hidden="true">
            <span
              className="inspector-scrollbar-thumb"
              style={{ left: `${scrollbar.offsetRatio * 100}%`, width: `${scrollbar.thumbRatio * 100}%` }}
              onPointerDown={dragScrollbar}
            />
          </div>
        ) : null}
        {!addControlTarget && addControl ? <div className="inspector-actions no-drag">{addControl}</div> : null}
      </header>
    </aside>
  );
}
