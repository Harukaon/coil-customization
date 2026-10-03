import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  FormEvent,
  RefObject,
} from "react";
import type {
  AgentMode,
  ChatMessage,
  ModelOption,
  PlanApprovalState,
  PlanExecutionTarget,
  PromptImage,
  PromptDocument,
  ProjectSelection,
  ProjectSnapshot,
  RuntimeConfiguration,
  SessionSnapshot,
  SubagentActivity,
} from "@coilcoil/runtime-protocol";
import { useChatContentWidth } from "../../hooks/useChatContentWidth";
import { ActivityPanel } from "../activity/ActivityPanel";
import { ConversationComposer } from "../composer/ConversationComposer";
import type { PromptEditorHandle } from "../composer/PromptEditor";
import { useSlashMenu, type SettingsSection } from "../composer/useSlashSkills";
import { WorkspaceStatus } from "../composer/WorkspaceStatus";
import { WindowDragBar } from "../../ui/WindowDragBar";
import { BlobsLoader, OrbitLoader } from "../../ui/loaders";
import { AgentTurnView, CompactionMarkView, MessageView, type ConversationTimelineItem } from "./ConversationTimeline";
import { hasRunningCompaction } from "./buildConversationTimeline";
import { PromptAnchorRail, type PromptAnchor } from "./PromptAnchorRail";
import { nextScrollDownVisible } from "./scrollDownVisibility";
import { useActivityGroupVirtualization } from "./useActivityGroupVirtualization";
import { PlanApprovalCard } from "../plans/PlanApprovalCard";
import { SubagentCard, SubagentDetailDialog } from "../subagents/SubagentActivity";

function turnModelName(
  model: ChatMessage["model"],
  configuration: RuntimeConfiguration | undefined,
  fallback: string,
): string {
  if (!model) return fallback;
  return configuration?.models.find((candidate) => candidate.provider === model.provider && candidate.id === model.id)?.name
    ?? model.id;
}

const INITIAL_VISIBLE_TURNS = 24;
const LOAD_MORE_TURNS = 20;

export function ConversationPane({
  fileDragActive,
  layoutPending,
  pendingProjectPath,
  activeConversation,
  project,
  loading,
  timeline,
  running,
  timelineRef,
  activityLine,
  projectState,
  subagents,
  snapshot,
  startingSession,
  draft,
  draftDocument,
  draftImages,
  inputRef,
  configuration,
  selectedModel,
  agentMode,
  agentModeLocked,
  modelMenuOpen,
  modelChanging,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  onTimelineScroll,
  onRewind,
  onError,
  onSubmit,
  onDocumentChange,
  onReplaceTextRange,
  onImagesChange,
  onPaste,
  onCompositionStart,
  onCompositionEnd,
  onKeyDown,
  onModelMenuOpenChange,
  onSelectModel,
  onConfigureModelOptions,
  onFastChange,
  onAgentModeChange,
  onOpenSettings,
  onAbort,
  onStopGoal,
  onPromoteQueuedPrompt,
  onStopSubagent,
  onResumeSubagent,
  queuedPrompts,
  onCancelQueuedPrompt,
  onApprovePlan,
  onRejectPlan,
}: {
  fileDragActive: boolean;
  layoutPending: boolean;
  pendingProjectPath?: string;
  activeConversation?: SessionSnapshot["session"];
  project: ProjectSelection | null;
  loading: boolean;
  timeline: ConversationTimelineItem[];
  running: boolean;
  timelineRef: RefObject<HTMLDivElement | null>;
  activityLine: string;
  projectState: ProjectSnapshot;
  subagents: SubagentActivity[];
  snapshot?: SessionSnapshot;
  startingSession: boolean;
  draft: string;
  draftDocument: PromptDocument;
  draftImages: PromptImage[];
  inputRef: RefObject<PromptEditorHandle | null>;
  configuration?: RuntimeConfiguration;
  selectedModel?: SessionSnapshot["model"];
  agentMode: AgentMode;
  agentModeLocked: boolean;
  modelMenuOpen: boolean;
  modelChanging: boolean;
  onDragEnter: (event: ReactDragEvent<HTMLElement>) => void;
  onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  onDragLeave: (event: ReactDragEvent<HTMLElement>) => void;
  onDrop: (event: ReactDragEvent<HTMLElement>) => void;
  onTimelineScroll: () => void;
  onRewind: (message: ChatMessage, text: string, images: PromptImage[], document: PromptDocument, restoreCode: boolean) => Promise<void>;
  onError: (message?: string) => void;
  onSubmit: (event: FormEvent) => void;
  onDocumentChange: (document: PromptDocument) => void;
  onReplaceTextRange: (start: number, end: number, replacement: string) => void;
  onImagesChange: React.Dispatch<React.SetStateAction<PromptImage[]>>;
  onPaste: React.ClipboardEventHandler<HTMLDivElement>;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  onKeyDown: React.KeyboardEventHandler<HTMLDivElement>;
  onModelMenuOpenChange: (open: boolean) => void;
  onSelectModel: (model: ModelOption) => void;
  onConfigureModelOptions: (model: ModelOption, thinkingLevel: RuntimeConfiguration["thinkingLevel"], contextWindow?: number) => Promise<void>;
  onFastChange: (enabled: boolean) => Promise<void>;
  onAgentModeChange: (mode: AgentMode) => void;
  onOpenSettings: (section?: SettingsSection) => void;
  onAbort: () => void;
  onStopGoal: () => void;
  onPromoteQueuedPrompt: (id: string) => void;
  onStopSubagent: (activity: SubagentActivity) => void;
  onResumeSubagent: (activity: SubagentActivity) => void;
  queuedPrompts: ChatMessage[];
  onCancelQueuedPrompt: (id: string) => void;
  onApprovePlan: (planId: string, target: PlanExecutionTarget, agent?: string) => Promise<PlanApprovalState>;
  onRejectPlan: (planId: string) => Promise<PlanApprovalState>;
}): React.JSX.Element {
  const { chatContentWidth, beginChatWidthResize } = useChatContentWidth();
  useActivityGroupVirtualization(timelineRef);
  const [editingMessageId, setEditingMessageId] = useState<string>();
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [visibleTimelineStart, setVisibleTimelineStart] = useState<number>();
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [showLoadEarlier, setShowLoadEarlier] = useState(false);
  const pendingScrollRestore = useRef<{ height: number; top: number } | undefined>(undefined);
  const pendingAnchorScroll = useRef<string>(undefined);
  const [selectedSubagentId, setSelectedSubagentId] = useState<string>();
  const selectedSubagent = subagents.find((activity) => activity.id === selectedSubagentId);
  const conversationTitle = pendingProjectPath ? "新对话" : activeConversation?.title ?? "新建对话";
  const slashMenu = useSlashMenu({
    draft,
    inputRef,
    project,
    runtimeId: snapshot?.runtimeId,
    onReplaceTextRange,
    onOpenSettings,
  });
  const hasComposerActivity = projectState.plan.length > 0 || subagents.length > 0 || queuedPrompts.length > 0 || slashMenu.slashActive || snapshot?.goal !== undefined;

  useEffect(() => {
    setEditingMessageId(undefined);
    setSelectedSubagentId(undefined);
    setVisibleTimelineStart(undefined);
    setHistoryExpanded(false);
    setShowLoadEarlier(false);
    pendingScrollRestore.current = undefined;
    pendingAnchorScroll.current = undefined;
  }, [activeConversation?.id, pendingProjectPath]);

  useEffect(() => {
    if (historyExpanded || !timeline.length) return;
    setVisibleTimelineStart(Math.max(0, timeline.length - INITIAL_VISIBLE_TURNS));
  }, [historyExpanded, timeline.length]);

  const timelineStart = Math.min(
    visibleTimelineStart ?? Math.max(0, timeline.length - INITIAL_VISIBLE_TURNS),
    timeline.length,
  );
  const visibleTimeline = timeline.slice(timelineStart);
  const hasEarlierTimeline = timelineStart > 0;
  // 压缩在跑时，底下那个常规转圈让给横线；普通对话照旧。
  const compactionRunning = hasRunningCompaction(visibleTimeline);

  const updateScrollDownVisibility = useCallback((): void => {
    const viewport = timelineRef.current;
    if (!viewport) {
      setShowScrollDown(false);
      return;
    }
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    setShowScrollDown((visible) => nextScrollDownVisible(visible, distance));
  }, [timelineRef]);

  const updateLoadEarlierVisibility = useCallback((): void => {
    const viewport = timelineRef.current;
    setShowLoadEarlier(Boolean(hasEarlierTimeline && viewport && viewport.scrollTop <= 64));
  }, [hasEarlierTimeline, timelineRef]);

  useLayoutEffect(() => {
    const restore = pendingScrollRestore.current;
    const viewport = timelineRef.current;
    if (!restore || !viewport) return;
    viewport.scrollTop = Math.max(0, viewport.scrollHeight - restore.height + restore.top);
    pendingScrollRestore.current = undefined;
    updateLoadEarlierVisibility();
  }, [timelineStart, timelineRef, updateLoadEarlierVisibility]);

  useEffect(() => {
    updateScrollDownVisibility();
    updateLoadEarlierVisibility();
  }, [timeline, running, loading, timelineStart, updateLoadEarlierVisibility, updateScrollDownVisibility]);

  const handleBodyScroll = useCallback((): void => {
    onTimelineScroll();
    updateScrollDownVisibility();
    updateLoadEarlierVisibility();
  }, [onTimelineScroll, updateLoadEarlierVisibility, updateScrollDownVisibility]);

  const loadEarlierTimeline = useCallback((): void => {
    if (!hasEarlierTimeline) return;
    const viewport = timelineRef.current;
    if (viewport) pendingScrollRestore.current = { height: viewport.scrollHeight, top: viewport.scrollTop };
    setHistoryExpanded(true);
    setVisibleTimelineStart(Math.max(0, timelineStart - LOAD_MORE_TURNS));
    setShowLoadEarlier(false);
  }, [hasEarlierTimeline, timelineRef, timelineStart]);

  const scrollToBottom = useCallback((): void => {
    const viewport = timelineRef.current;
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  }, [timelineRef]);

  const promptAnchors = useMemo((): PromptAnchor[] => {
    const anchors: PromptAnchor[] = [];
    timeline.forEach((item, index) => {
      if (item.kind === "user") anchors.push({ id: item.message.id, text: item.message.text, index });
    });
    return anchors;
  }, [timeline]);

  const scrollToMessage = useCallback((id: string, behavior: ScrollBehavior): void => {
    const target = timelineRef.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
    if (!target) return;
    target.scrollIntoView({ block: "start", behavior });
    target.classList.remove("anchor-flash");
    void target.offsetWidth; // 重新触发高亮动画
    target.classList.add("anchor-flash");
    window.setTimeout(() => target.classList.remove("anchor-flash"), 1600);
  }, [timelineRef]);

  const jumpToAnchor = useCallback((anchor: PromptAnchor): void => {
    if (anchor.index < timelineStart) {
      // 目标还在未加载的历史里：先展开到该轮，再由 layout effect 定位。
      pendingAnchorScroll.current = anchor.id;
      setHistoryExpanded(true);
      setVisibleTimelineStart(anchor.index);
      return;
    }
    scrollToMessage(anchor.id, "smooth");
  }, [scrollToMessage, timelineStart]);

  useLayoutEffect(() => {
    const pending = pendingAnchorScroll.current;
    if (!pending) return;
    pendingAnchorScroll.current = undefined;
    scrollToMessage(pending, "instant");
  }, [timelineStart, scrollToMessage]);

  const reportError = useCallback((message?: string): void => {
    if (message) onError(message);
  }, [onError]);

  return (
    <section className={`shell-surface conversation-pane ${fileDragActive ? "file-drag-active" : ""} ${hasComposerActivity ? "has-composer-activity" : ""}`} style={{ "--chat-content-width": `${chatContentWidth}px`, visibility: layoutPending ? "hidden" : undefined } as CSSProperties} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <div className="conversation-scroll">
        <div className="conversation-body" ref={timelineRef} onScroll={handleBodyScroll}>
          {loading ? <div className="loading-state loading-state-stacked"><BlobsLoader size={64} /><span>正在打开工作区…</span></div> : timeline.length || running || startingSession ? (
            <div className="timeline">
              {showLoadEarlier && hasEarlierTimeline ? (
                <div className="timeline-history-loader">
                  <button type="button" onClick={loadEarlierTimeline}>
                    加载更早的对话
                    <span>还有 {timelineStart} 轮</span>
                  </button>
                </div>
              ) : null}
              {visibleTimeline.map((item, index) => item.kind === "compaction" ? (
                <CompactionMarkView key={`compaction-${item.marks[0].id}`} marks={item.marks} />
              ) : item.kind === "user" ? (
                <MessageView
                  key={`user-${item.message.id}`}
                  message={item.message}
                  disabled={running || snapshot?.aborting === true}
                  editing={editingMessageId === item.message.id}
                  project={project}
                  configuration={configuration}
                  selectedModel={selectedModel}
                  thinkingLevel={snapshot?.pendingModel?.thinkingLevel ?? snapshot?.thinkingLevel ?? configuration?.thinkingLevel}
                  fast={snapshot?.fast}
                  modelChanging={modelChanging}
                  runtimeId={snapshot?.runtimeId}
                  onEditingChange={(next) => setEditingMessageId(next ? item.message.id : undefined)}
                  onRewind={onRewind}
                  onError={reportError}
                  onSelectModel={onSelectModel}
                  onConfigureModelOptions={onConfigureModelOptions}
                  onFastChange={onFastChange}
                  onOpenSettings={onOpenSettings}
                />
              ) : (
                <AgentTurnView
                  key={`agent-${item.order}`}
                  items={item.items}
                  continuation={item.continuation}
                  running={running && index === visibleTimeline.length - 1}
                  modelName={turnModelName(item.model, configuration, snapshot?.model?.name ?? "Agent")}
                  renderSubagent={(activity) => <SubagentCard activity={activity} onOpen={(selected) => setSelectedSubagentId(selected.id)} />}
                  renderPlan={(plan) => <PlanApprovalCard plan={plan} onApprove={onApprovePlan} onReject={onRejectPlan} />}
                />
              ))}
              {running && !compactionRunning ? <div className="agent-activity"><OrbitLoader size={13} /><span className="agent-activity-line">{activityLine}</span></div> : null}
            </div>
          ) : (
            <div className="empty-chat"><div className="empty-chat-mark"><span className="brand-icon" aria-hidden="true" /></div><h1>你想构建什么？</h1><p>{project ? `CoilCoil 已在 ${project.name} 中准备就绪。` : "打开项目以开始新的 Agent 会话。"}</p></div>
          )}
        </div>
        {showScrollDown ? (
          <button className="scroll-to-bottom" type="button" aria-label="滚动到最新消息" onClick={scrollToBottom}>
            <ArrowDown size={14} strokeWidth={2.2} />
          </button>
        ) : null}
        {!loading ? <PromptAnchorRail anchors={promptAnchors} loadedFrom={timelineStart} onSelect={jumpToAnchor} /> : null}
      </div>

      {/* 标题栏排在消息列表后面，屏幕上的位置由 grid-row 摆回顶上。消息气泡是按钮，往上滚走
          以后矩形还垫在标题栏底下；标题栏排在后面，它的拖动层才能把这些看不见的洞盖回去。
          标题栏自己的拖动层仍然是它的第一个子节点。整条约定见 ui/WindowDragBar.tsx。 */}
      <header className="conversation-header window-drag-bar">
        <WindowDragBar />
        <div className="conversation-title" title={conversationTitle}>
          <strong>{conversationTitle}</strong>{project ? <span>{project.name}</span> : null}
        </div>
      </header>

      <div className="composer-wrap">
        <div className="composer-width-resizer left" role="separator" aria-label="调整对话宽度" aria-orientation="vertical" onPointerDown={(event) => beginChatWidthResize("left", event)} />
        <div className="composer-width-resizer right" role="separator" aria-label="调整对话宽度" aria-orientation="vertical" onPointerDown={(event) => beginChatWidthResize("right", event)} />
        <div className="composer-stack">
          <div className="composer-overlays">
            <ActivityPanel
              goal={snapshot?.goal}
              todo={projectState.plan}
              subagents={subagents}
              queued={queuedPrompts}
              commands={slashMenu.slashActive ? slashMenu.filteredItems : undefined}
              commandIndex={slashMenu.itemIndex}
              onSelectCommand={slashMenu.selectItem}
              onOpenSubagent={(activity) => setSelectedSubagentId(activity.id)}
              onCancelQueued={onCancelQueuedPrompt}
              onPromoteQueued={onPromoteQueuedPrompt}
              onStopGoal={onStopGoal}
              onStopSubagent={onStopSubagent}
              onResumeSubagent={onResumeSubagent}
            />
          </div>
          <ConversationComposer
            variant="footer"
            project={project}
            running={running}
            aborting={snapshot?.aborting}
            goalActive={snapshot?.goal?.status === "running"}
            loading={loading}
            startingSession={startingSession}
            draft={draft}
            document={draftDocument}
            images={draftImages}
            inputRef={inputRef}
            configuration={configuration}
            selectedModel={selectedModel}
            thinkingLevel={snapshot?.pendingModel?.thinkingLevel ?? snapshot?.thinkingLevel ?? configuration?.thinkingLevel}
            fast={snapshot?.fast}
            modelMenuOpen={modelMenuOpen}
            modelChanging={modelChanging}
            onSubmit={onSubmit}
            onDocumentChange={onDocumentChange}
            onReplaceTextRange={onReplaceTextRange}
            onImagesChange={onImagesChange}
            onPaste={onPaste}
            onCompositionStart={onCompositionStart}
            onCompositionEnd={onCompositionEnd}
            onKeyDown={onKeyDown}
            onSlashKeyDown={slashMenu.handleSlashKeyDown}
            onModelMenuOpenChange={onModelMenuOpenChange}
            onSelectModel={onSelectModel}
            onConfigureModelOptions={onConfigureModelOptions}
            onFastChange={onFastChange}
            onOpenSettings={() => onOpenSettings()}
            onAbort={onAbort}
          />
        </div>
        <WorkspaceStatus
          project={project}
          agentMode={agentMode}
          agentModeLocked={agentModeLocked}
          onAgentModeChange={onAgentModeChange}
          responseMetrics={snapshot?.responseMetrics}
          responseMetricsHistory={snapshot?.responseMetricsHistory ?? []}
          contextUsage={snapshot?.contextUsage}
          tokenBreakdown={snapshot?.runtimeInspection.tokenBreakdown}
        />
      </div>
      <SubagentDetailDialog activity={selectedSubagent} onClose={() => setSelectedSubagentId(undefined)} />
    </section>
  );
}
