/**
 * 一条可以拖动窗口的标题带。
 *
 * ## 窗口怎么判断「这里能不能拖」（Electron 43 / Chromium 150，照源码核过）
 *
 * Chromium 每次排版之后，按文档顺序把整份页面里声明了 app-region 的元素的边框盒收成
 * 一串矩形交给 Electron；Electron 按顺序 drag 并集、no-drag 差集，按下鼠标的那一刻拿这块
 * 区域当场判断（LocalFrameView::UpdateDocumentDraggableRegions、drag_util.cc、
 * WebContentsView::NonClientHitTest）。三个要命的细节：
 *
 * - **不按 overflow 裁剪，不看透明度和 pointer-events。** 往上滚走的消息气泡、收起后只是
 *   变透明的面板，矩形都还在原地，照样在标题栏上挖出 no-drag 的洞——屏幕上看着是拖动带，
 *   按下去窗口不动。
 * - **滚动不排版，清单就不更新。** 洞会一直留到界面下一次排版，表现成「时好时坏、随便动
 *   一下就好」。2026-10 定位的「会话标题栏偶发拖不动」就是这个：滚上去的消息气泡（整个
 *   气泡是一个按钮）和收起的右栏标签条垫在会话标题栏底下。e2e 场景 window-drag 能把它
 *   复现出来。
 * - **写 `-webkit-app-region: none` 等于 no-drag。** AppRegion::ApplyValue 只认 drag，其余
 *   一律当 no-drag；要清掉某个元素的声明只能写 `initial`。
 *
 * ## 约定（新加标题栏时照做）
 *
 * 1. 标题栏的**第一个子节点**放 `<WindowDragBar />`，并给标题栏 `.window-drag-bar`
 *    和定位上下文。这一层是**空的**：绝对定位铺满标题栏，自己不放任何内容，所以
 *    它的矩形只随标题栏尺寸走，不会被后面新加的 UI 改写。
 * 2. **标题栏在文档里排在会从它底下经过的内容之后。** 它下面的滚动区（消息列表、右栏
 *    内容、技能列表……）写在前面，标题栏写在后面，屏幕上的位置用 grid-row 钉回顶上：
 *    滚到它底下的按钮先挖洞，标题栏的拖动层再整块盖回去。左侧栏的拖动层同理排在会话
 *    列表之后。反过来，真正浮在标题栏上面、要点得到的东西（左上角 / 右上角的悬浮开关、
 *    弹出层）排在标题栏之后。
 * 3. 标题栏**里面**拖动层排最前：标题栏自己的按钮排在它后面，才能在上面挖出自己的洞。
 *    放到后面，反而会把按钮那块重新变回可拖动。
 * 4. 只给真正要点的元素标 `no-drag`。`button` / `input` / `textarea` / `select` 已经由全局
 *    规则覆盖了，**不要给容器标**——那等于把整块从拖动带里挖掉。例外是标题栏里会横向
 *    滚动的条（右栏标签条）：整条标 no-drag，里面的东西用 `initial` 清掉各自的声明，否则
 *    滚出条外的标签会伸到条外面挖洞（往左一直伸进会话标题栏）。
 * 5. 会收起的面板，收起时整块不声明（`initial`）：收起只是变透明、原地不动，矩形还在。
 * 6. 清掉声明写 `initial`，**不要写 `none`**（见上，none 等于 no-drag）。
 * 7. 标题栏里会随内容长大的东西（标签条、按钮组）要限制在自己的区域内，不能盖住
 *    右侧操作按钮；需要滚动时，滚动区域自己处理，不要额外插入空白占位元素。
 * 8. 标题栏里的选择器**不要用 `:first-child`**：这一层永远排第一，写
 *    `> div:first-child` 一条也匹配不上。要按类型选就用 `:first-of-type`。
 *
 * ## 这里没有任何刷新机制，这是有意的
 *
 * 这个文件以前带着一整套「逼 Chromium 重算拖动矩形」的东西：一个 0×0 的哨兵元素、
 * 指针悬停时每 250ms 一次的轮询、按下鼠标时再刷一次、窗口 resize 刷一次、body 的
 * 子节点增删监听，以及每条标题栏各自的 ResizeObserver + MutationObserver。它们是
 * 为了治「标题栏偶发拖不动」一层层加上去的，但洞是按元素当时的真实位置算出来的，
 * 重算多少次都还在，补丁只是把现场盖住。2026-09-16 全部拆掉，回到裸结构；2026-10
 * 按上面第 2、4、5 条从结构上把洞去掉。
 *
 * 再出现拖不动：先看诊断日志里 `window-drag` / `drag_press_reached_page` 那条的
 * `modelWinner`——它就是在那一点挖洞的元素（见 ui/window-drag-report.ts）；再按那个
 * 局面补进 e2e 场景 window-drag。不要往这里加刷新。
 */
export function WindowDragBar({ className }: { className?: string }): React.JSX.Element {
  // 用 span 而不是 div：标题栏里到处是 `> div` 这类选择器，多插一个 div 会把它们
  // 悄悄挪到这一层上（绝对定位之后 span 一样是块盒，显示没差别）。
  return <span className={className ? `window-drag window-drag-layer ${className}` : "window-drag window-drag-layer"} aria-hidden="true" />;
}
