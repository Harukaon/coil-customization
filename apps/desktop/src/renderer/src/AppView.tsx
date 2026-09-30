import { PanelLeft, PanelRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isRemoteClient, MOBILE_DECK_QUERY } from "./hooks/useMobileRemote";

import type {
  ComponentProps,
  Dispatch,
  FormEvent,
  MutableRefObject,
  SetStateAction,
} from "react";
import type {
  AgentMode,
  ChatMessage,
  PlanApprovalState,
  PlanExecutionTarget,
  ProjectSelection,
  ProjectSnapshot,
  PromptDocument,
  PromptImage,
  RuntimeConfiguration,
  SessionSnapshot,
  SessionSummary,
  SubagentActivity,
} from "@coilcoil/runtime-protocol";
import type { BrowserElementSelection } from "../../shared/desktop-api";
import { useInAppBrowserLinks } from "./features/browser/useInAppBrowserLinks";
import { ConversationPane } from "./features/conversation/ConversationPane";
import { MemoryWorkspace } from "./features/memory/MemoryWorkspace";
import { SkillsWorkspace } from "./features/settings/SkillsWorkspace";
import { WorkspaceInspector } from "./features/inspector/WorkspaceInspector";
import { useWorkspaceInspector } from "./features/inspector/useWorkspaceInspector";
import {
  WorkspaceSidebar,
  type SessionActivityState,
} from "./features/workspaces/WorkspaceSidebar";
import type { useComposerController } from "./features/composer/useComposerController";
import type { usePanelLayout } from "./hooks/usePanelLayout";
import { toastError } from "./ui/toast";
import { WindowDragBar } from "./ui/WindowDragBar";

type WorkspaceSurface = "conversation" | "skills" | "memory";
type ConversationProps = ComponentProps<typeof ConversationPane>;


export interface AppViewController {
  projects: ProjectSelection[];
  project: ProjectSelection | null;
  activeConversation?: SessionSummary;
  pendingProjectPath?: string;
  sessionsByProject: Record<string, SessionSummary[]>;
  sessionActivity: Record<string, SessionActivityState>;
  expandedProjects: Set<string>;
  expandedSessionLimits: Record<string, number>;
  snapshot?: SessionSnapshot;
  leftOpen: boolean;
  leftWidth: number;
  rightOpen: boolean;
  rightWidth: number;
  workspaceSurface: WorkspaceSurface;
  loading: boolean;
  timeline: ConversationProps["timeline"];
  queuedPrompts: ChatMessage[];
  running: boolean;
  activityLine: string;
  projectState: ProjectSnapshot;
  subagents: SubagentActivity[];
  startingSession: boolean;
  configuration?: RuntimeConfiguration;
  selectedModel: ConversationProps["selectedModel"];
  agentMode: AgentMode;
  agentModeLocked: boolean;
  fileDragActive: boolean;
  timelineRef: ConversationProps["timelineRef"];
  shouldAutoScrollRef: MutableRefObject<boolean>;
  composer: ReturnType<typeof useComposerController>;
  inspector: ReturnType<typeof useWorkspaceInspector>;
  setExpandedProjects: Dispatch<SetStateAction<Set<string>>>;
  setExpandedSessionLimits: Dispatch<SetStateAction<Record<string, number>>>;
  setSessionsByProject: Dispatch<SetStateAction<Record<string, SessionSummary[]>>>;
  setWorkspaceSurface: Dispatch<SetStateAction<WorkspaceSurface>>;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  setSettingsSection: Dispatch<SetStateAction<"models" | "mcp" | "skills" | "appearance">>;
  setPendingAgentMode: Dispatch<SetStateAction<AgentMode>>;
  setLeftOpen(open: boolean): void;
  beginResize: ReturnType<typeof usePanelLayout>["beginResize"];
  startNewConversation(owner?: ProjectSelection): void;
  openProject(): Promise<void>;
  removeProject(owner: ProjectSelection): void;
  openConversation(owner: ProjectSelection, session: SessionSummary): Promise<void>;
  archiveConversation(owner: ProjectSelection, session: SessionSummary): Promise<void>;
  deleteConversation(owner: ProjectSelection, session: SessionSummary): Promise<void>;
  deleteWorkspaceData(owner: ProjectSelection): Promise<void>;
  renameConversation(owner: ProjectSelection, session: SessionSummary, name: string): Promise<void>;
  pinConversation(owner: ProjectSelection, session: SessionSummary, pinned: boolean): Promise<void>;
  forkConversation(owner: ProjectSelection, session: SessionSummary): Promise<void>;
  moveConversation(owner: ProjectSelection, session: SessionSummary, target: ProjectSelection): Promise<void>;
  reorderProjects(fromPath: string, toPath: string): void;
  rewindPrompt(message: ChatMessage, text: string, images: PromptImage[], document: PromptDocument, restoreCode: boolean): Promise<void>;
  cancelQueuedPrompt(id: string): Promise<void>;
  promoteQueuedPrompt(id: string): Promise<void>;
  abortRun(): Promise<void>;
  stopSubagent(activity: SubagentActivity): Promise<void>;
  resumeSubagent(activity: SubagentActivity): Promise<void>;
  approvePlan(planId: string, target: PlanExecutionTarget, agent?: string): Promise<PlanApprovalState>;
  rejectPlan(planId: string): Promise<PlanApprovalState>;
  submitPrompt(event?: FormEvent, intent?: "queue" | "steer", override?: string, overrideImages?: PromptImage[]): Promise<void>;
  handleTimelineScroll(): void;
  handleFileDragEnter: ConversationProps["onDragEnter"];
  handleFileDragOver: ConversationProps["onDragOver"];
  handleFileDragLeave: ConversationProps["onDragLeave"];
  handleFileDrop: ConversationProps["onDrop"];
}

export function AppView({ controller }: { controller: AppViewController }): React.JSX.Element {
  const {
    projects, project, activeConversation, pendingProjectPath, sessionsByProject,
    sessionActivity, expandedProjects, expandedSessionLimits, snapshot,
    leftOpen, leftWidth, rightOpen, rightWidth, workspaceSurface, loading,
    timeline, queuedPrompts, running, activityLine, projectState, subagents,
    startingSession, configuration, selectedModel, agentMode, agentModeLocked, fileDragActive, timelineRef,
    shouldAutoScrollRef, composer, inspector, setExpandedProjects,
    setExpandedSessionLimits, setSessionsByProject, setWorkspaceSurface,
    setSettingsOpen, setSettingsSection, setPendingAgentMode, setLeftOpen, beginResize,
    startNewConversation, openProject, removeProject, openConversation,
    archiveConversation, deleteConversation, deleteWorkspaceData,
    renameConversation, pinConversation, forkConversation,
    moveConversation, reorderProjects,
    rewindPrompt, cancelQueuedPrompt, promoteQueuedPrompt, abortRun, stopSubagent, resumeSubagent,
    approvePlan, rejectPlan, submitPrompt, handleTimelineScroll,
    handleFileDragEnter, handleFileDragOver, handleFileDragLeave, handleFileDrop,
  } = controller;
  const {
    draft, document: draftDocument, images: draftImages, inputRef, modelMenuOpen, modelChanging,
    setDocument: setDraftDocument, setImages: setDraftImages, setModelMenuOpen,
    insertBrowserElement,
  } = composer;
  const shellRef = useRef<HTMLElement | null>(null);
  /* A workspace pane is mounted on demand. Align the motion state in a layout
     effect, before the browser paints the newly mounted pane. A normal effect
     would leave one paint where the pane can still use the grid's static
     origin, which is the top-left flash seen on Skills/Memory. */
  const [motionReadySurface, setMotionReadySurface] = useState<WorkspaceSurface>(workspaceSurface);
  useLayoutEffect(() => {
    if (motionReadySurface === workspaceSurface) return;
    setMotionReadySurface(workspaceSurface);
  }, [motionReadySurface, workspaceSurface]);
  const workspaceLayoutPending = motionReadySurface !== workspaceSurface;

  const [inspectorAddControlTarget, setInspectorAddControlTarget] = useState<HTMLDivElement | null>(null);
  const mobileRemote = isRemoteClient() && window.matchMedia(MOBILE_DECK_QUERY).matches;
  const attachBrowserElement = (selection: BrowserElementSelection): void => {
    insertBrowserElement(selection);
    composer.focus();
  };
  // On a phone the three panes are one horizontal snap track, and its natural
  // resting place is the first pane — the sidebar. The conversation is what the
  // app opens on, so the track starts one pane in, leaving the sidebar a swipe
  // to the left and the inspector a swipe to the right.
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || !isRemoteClient() || !window.matchMedia(MOBILE_DECK_QUERY).matches) return;
    const frame = window.requestAnimationFrame(() => {
      shell.scrollLeft = shell.clientWidth;
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useInAppBrowserLinks({
    scopeId: snapshot?.runtimeId ?? project?.path ?? "default",
    openBrowser: inspector.openBrowserTab,
    openFile: inspector.openFilePath,
    reportError: toastError,
  });

  return (
    <main
      ref={shellRef}
      className={`app-shell workspace-${workspaceSurface} ${motionReadySurface === workspaceSurface ? "workspace-motion-ready" : ""} ${leftOpen ? "" : "left-collapsed"} ${rightOpen ? "" : "right-collapsed"}`}
      style={{ "--sidebar-width": `${leftWidth}px`, "--inspector-width": `${rightWidth}px` } as React.CSSProperties}
    >
      {/* 固定的全窗口顶栏拖动层不跟随三栏布局移动，避免侧栏动画后 Electron 继续使用旧矩形。 */}
      <WindowDragBar className="app-window-drag-region" />
      <WorkspaceSidebar
        projects={projects}
        activeProject={project}
        activeSessionId={activeConversation?.id}
        sessionsByProject={sessionsByProject}
        sessionActivity={sessionActivity}
        expandedProjects={expandedProjects}
        expandedSessionLimits={expandedSessionLimits}
        modelLabel={snapshot?.model ? `${snapshot.model.provider}/${snapshot.model.name}` : "本地 Agent"}
        onNewConversation={startNewConversation}
        onOpenProject={() => { void openProject(); }}
        onToggleProject={(path) => setExpandedProjects((current) => {
          const next = new Set(current);
          if (next.has(path)) next.delete(path); else next.add(path);
          return next;
        })}
        onShowMoreSessions={(path, limit) => setExpandedSessionLimits((current) => ({ ...current, [path]: limit }))}
        onOpenConversation={(owner, session) => { void openConversation(owner, session); }}
        onArchiveConversation={(owner, session) => { void archiveConversation(owner, session); }}
        onDeleteConversation={(owner, session) => { void deleteConversation(owner, session); }}
        onDeleteWorkspaceData={(owner) => { void deleteWorkspaceData(owner); }}
        onRenameConversation={renameConversation}
        onPinConversation={(owner, session, pinned) => { void pinConversation(owner, session, pinned); }}
        onForkConversation={(owner, session) => { void forkConversation(owner, session); }}
        onMoveConversation={(owner, session, target) => { void moveConversation(owner, session, target); }}
        onReorderProjects={reorderProjects}
        onRestoreSessions={(owner, sessions) => setSessionsByProject((current) => ({ ...current, [owner.path]: sessions }))}
        skillsOpen={workspaceSurface === "skills"}
        onOpenSkills={() => { setModelMenuOpen(false); setWorkspaceSurface("skills"); }}
        memoryOpen={workspaceSurface === "memory"}
        onOpenMemory={() => { setModelMenuOpen(false); setWorkspaceSurface("memory"); }}
        onOpenSettings={() => { setSettingsSection("models"); setSettingsOpen(true); }}
        onRemoveProject={removeProject}
        onError={(message) => { if (message) toastError(message); }}
      />
      {leftOpen ? <div className="panel-resizer left-resizer" role="separator" aria-label="调整左侧栏宽度" aria-orientation="vertical" onPointerDown={(event) => beginResize("left", event)} /> : null}

      {workspaceSurface === "skills" ? (
        <SkillsWorkspace
          runtimeId={snapshot?.runtimeId}
          cwd={project?.path}
          layoutPending={workspaceLayoutPending}
          onClose={() => { shouldAutoScrollRef.current = true; setWorkspaceSurface("conversation"); }}
        />
      ) : workspaceSurface === "memory" ? (
        <MemoryWorkspace
          runtimeId={snapshot?.runtimeId}
          cwd={project?.path}
          layoutPending={workspaceLayoutPending}
          onClose={() => { shouldAutoScrollRef.current = true; setWorkspaceSurface("conversation"); }}
        />
      ) : (
        <>
          <ConversationPane
            fileDragActive={fileDragActive}
            layoutPending={workspaceLayoutPending}
            pendingProjectPath={pendingProjectPath}
            activeConversation={activeConversation}
            project={project}
            loading={loading}
            timeline={timeline}
            queuedPrompts={queuedPrompts}
            onCancelQueuedPrompt={(id) => { void cancelQueuedPrompt(id); }}
            onPromoteQueuedPrompt={(id) => { void promoteQueuedPrompt(id); }}
            onStopSubagent={(activity) => { void stopSubagent(activity); }}
            onResumeSubagent={(activity) => { void resumeSubagent(activity); }}
            running={running}
            timelineRef={timelineRef}
            activityLine={activityLine}
            projectState={projectState}
            subagents={subagents}
            snapshot={snapshot}
            startingSession={startingSession}
            draft={draft}
            draftDocument={draftDocument}
            draftImages={draftImages}
            inputRef={inputRef}
            configuration={configuration}
            selectedModel={selectedModel}
            agentMode={agentMode}
            agentModeLocked={agentModeLocked}
            modelMenuOpen={modelMenuOpen}
            modelChanging={modelChanging}
            onDragEnter={handleFileDragEnter}
            onDragOver={handleFileDragOver}
            onDragLeave={handleFileDragLeave}
            onDrop={handleFileDrop}
            onTimelineScroll={handleTimelineScroll}
            onRewind={rewindPrompt}
            onError={(message) => { if (message) toastError(message); }}
            onSubmit={(event) => { void submitPrompt(event); }}
            onDocumentChange={setDraftDocument}
            onReplaceTextRange={composer.replaceTextRange}
            onImagesChange={setDraftImages}
            onPaste={composer.handlePaste}
            onCompositionStart={composer.handleCompositionStart}
            onCompositionEnd={composer.handleCompositionEnd}
            onKeyDown={composer.handleKeyDown}
            onModelMenuOpenChange={setModelMenuOpen}
            onSelectModel={(model) => { void composer.selectModel(model); }}
            onConfigureModelOptions={composer.configureModelOptions}
            onFastChange={composer.setFast}
            onAgentModeChange={setPendingAgentMode}
            onOpenSettings={(section) => {
              setModelMenuOpen(false);
              setSettingsSection(section ?? "models");
              setSettingsOpen(true);
            }}
            onAbort={() => { void abortRun(); }}
            onStopGoal={() => { void window.coilcoil.request({ type: "stop_goal" }, snapshot?.runtimeId); }}
            onApprovePlan={approvePlan}
            onRejectPlan={rejectPlan}
          />
          <WorkspaceInspector
            tabs={inspector.state.tabs}
            activeTab={inspector.activeTab}
            activeTabId={inspector.state.activeTabId}
            selectedFilePath={inspector.state.selectedFilePath}
            rightOpen={rightOpen}
            projectPath={project?.path}
            projectState={projectState}
            snapshot={snapshot}
            configuration={configuration}
            onOpenFiles={inspector.openFilesTab}
            onOpenBrowser={inspector.openBrowserTab}
            onOpenRuntime={inspector.openRuntimeTab}
            onOpenTerminal={inspector.openTerminalTab}
            onRebindTerminal={inspector.rebindTerminalTab}
            onOpenFile={inspector.openFileTab}
            onSelectTab={inspector.selectTab}
            onCloseTab={inspector.closeTab}
            onRemovePath={inspector.removePath}
            onOpenOption={inspector.openOption}
            onBrowserElementPicked={attachBrowserElement}
            addControlTarget={mobileRemote ? null : inspectorAddControlTarget}
            showAddControl={mobileRemote || rightOpen}
          />
          {rightOpen ? <div className="panel-resizer right-resizer" role="separator" aria-label="调整右侧栏宽度" aria-orientation="vertical" onPointerDown={(event) => beginResize("right", event)} /> : null}
        </>
      )}
      <div className="app-sidebar-control">
        <div className="app-sidebar-control-bar window-drag-bar">
            <WindowDragBar />
            <button
              className="icon-button app-sidebar-toggle no-drag"
              type="button"
              aria-label={leftOpen ? "收起侧栏" : "展开侧栏"}
              aria-expanded={leftOpen}
              onClick={() => setLeftOpen(!leftOpen)}
            >
              <PanelLeft size={17} />
            </button>
        </div>
      </div>
      {workspaceSurface === "conversation" ? (
        <div className="conversation-inspector-control">
          <div className="conversation-inspector-control-bar window-drag-bar">
            <WindowDragBar />
            <div ref={setInspectorAddControlTarget} className="conversation-inspector-add-slot no-drag" />
            <button
              className="icon-button conversation-inspector-toggle no-drag"
              type="button"
              aria-label={rightOpen ? "收起右侧栏" : "展开作业栏"}
              aria-expanded={rightOpen}
              onClick={() => inspector.setRightOpen(!rightOpen)}
            >
              <PanelRight size={17} />
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}
