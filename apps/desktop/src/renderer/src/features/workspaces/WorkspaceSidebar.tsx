import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  Trash2,
  Archive,
  BookOpen,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  Copy,
  Folder,
  FolderInput,
  FolderOpen,
  GitFork,
  Hash,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Settings,
  Sparkles,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import type { ProjectSelection, SessionSummary } from "@coilcoil/runtime-protocol";
import { primaryModifierLabel } from "../../../../shared/platform-labels";
import { OrbitLoader } from "../../ui/loaders";
import { WindowDragBar } from "../../ui/WindowDragBar";
import { ArchivedSessionsDialog } from "./ArchivedSessionsDialog";
import { ConfirmDialog } from "../../ui/dialog";
import { copyText } from "../files/pathActions";
import { collectRecentSessions, DEFAULT_RECENT_ROWS, loadRecentSectionCollapsed, saveRecentSectionCollapsed, visibleRecentSessions } from "./recentSessions";
import { rendererPlatform } from "../../platform";
import { dropSidebarSection, loadSidebarSectionOrder, saveSidebarSectionOrder, SIDEBAR_SECTION_LABELS, type SidebarSection } from "./sidebarSections";
import { collectPinnedSessions, collapsedSessionLimit, conversationStatusKind, nextExpandedSessionLimit, SESSION_EXPANSION_BATCH, summarizeWorkspaceActivity, visibleProjectSessions, workspaceActivityLabel, type ConversationStatusKind, type PinnedSessionEntry } from "./sessionList";
import { TextField } from "../../ui/form";

export interface SessionActivityState {
  runtimeId?: string;
  running: boolean;
  unread: boolean;
}

/** The icon for a row's status; see {@link conversationStatusKind} for the order. */
function conversationStatusMarker(kind: ConversationStatusKind): React.JSX.Element | null {
  if (kind === "running") return <OrbitLoader size={10} />;
  if (kind === "unread") return <i className="conversation-unread" />;
  if (kind === "pinned") return <Pin size={11} strokeWidth={2} />;
  return null;
}

function relativeTime(value: string): string {
  const milliseconds = Date.now() - Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 60_000) return "刚刚";
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days} 天` : new Date(value).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

/**
 * The row of controls under a conversation list.
 *
 * Growing a list was one-way: every list could only be expanded, so a workspace
 * opened once to find something stayed tall for the rest of the session. The
 * two controls sit together and either can be absent.
 */
function ConversationListControls({ hiddenCount, expandedBy, onShowMore, onCollapse }: {
  hiddenCount: number;
  /** How many rows beyond the default are on screen; zero hides the collapse control. */
  expandedBy: number;
  onShowMore: () => void;
  onCollapse: () => void;
}): React.JSX.Element | null {
  if (hiddenCount <= 0 && expandedBy <= 0) return null;
  return <div className="conversation-list-controls">
    {hiddenCount > 0
      ? <button className="more-conversations" type="button" aria-label={`再显示 ${Math.min(SESSION_EXPANSION_BATCH, hiddenCount)} 个对话`} onClick={onShowMore}><MoreHorizontal size={15} /></button>
      : null}
    {expandedBy > 0
      ? <button className="more-conversations" type="button" aria-label="收起对话" onClick={onCollapse}><ChevronUp size={15} /></button>
      : null}
  </div>;
}

/**
 * The copy actions every conversation row offers, wherever it is listed.
 *
 * A session is addressed two ways outside this window — by the transcript file
 * on disk and by its id — and both are needed often enough that hunting for
 * them in the session directory is the wrong answer.
 */
function ConversationCopyItems({ session }: { session: SessionSummary }): React.JSX.Element {
  return <>
    <ContextMenu.Item className="conversation-context-item" onSelect={() => { void copyText(session.path, "会话路径"); }}><Copy size={13} /><span>复制会话路径</span></ContextMenu.Item>
    <ContextMenu.Item className="conversation-context-item" onSelect={() => { void copyText(session.id, "会话 ID"); }}><Hash size={13} /><span>复制会话 ID</span></ContextMenu.Item>
  </>;
}

type ConversationRenameScope = "project" | "pinned" | "recent";

function ConversationMenu({ project, session, activity, projects, onStartRename, onPin, onFork, onMove, onArchive, onDelete }: {
  project: ProjectSelection;
  session: SessionSummary;
  activity?: SessionActivityState;
  projects: ProjectSelection[];
  onStartRename: () => void;
  onPin: () => void;
  onFork: () => void;
  onMove: (target: ProjectSelection) => void;
  onArchive: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  return <>
    <ContextMenu.Item
      className="conversation-context-item"
      disabled={activity?.running}
      onSelect={(event) => {
        event.preventDefault();
        onStartRename();
      }}
    >
      <Pencil size={13} /><span>重命名</span>
    </ContextMenu.Item>
    <ContextMenu.Item className="conversation-context-item" disabled={activity?.running} onSelect={onPin}>
      {session.pinned ? <PinOff size={13} /> : <Pin size={13} />}<span>{session.pinned ? "取消置顶" : "置顶"}</span>
    </ContextMenu.Item>
    <ContextMenu.Item className="conversation-context-item" disabled={activity?.running} onSelect={onFork}>
      <GitFork size={13} /><span>复制对话</span>
    </ContextMenu.Item>
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className="conversation-context-item" disabled={activity?.running || projects.length < 2}>
        <FolderInput size={13} /><span>移动到工作区</span><ChevronRight className="conversation-context-more" size={13} />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent className="conversation-context-menu" sideOffset={2} collisionPadding={8}>
          {projects.filter((target) => target.path !== project.path).map((target) => (
            <ContextMenu.Item className="conversation-context-item" key={target.path} onSelect={() => onMove(target)}>
              <Folder size={13} /><span className="conversation-context-label" title={target.path}>{target.name}</span>
            </ContextMenu.Item>
          ))}
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
    <ConversationCopyItems session={session} />
    <ContextMenu.Separator className="conversation-context-separator" />
    <ContextMenu.Item className="conversation-context-item" disabled={activity?.running} onSelect={onArchive}>归档对话</ContextMenu.Item>
    <ContextMenu.Item className="conversation-context-item danger" disabled={activity?.running} onSelect={onDelete}>
      <Trash2 size={13} /><span>删除对话</span>
    </ContextMenu.Item>
  </>;
}

/**
 * A conversation row that names its own workspace.
 *
 * The pinned and recent sections both list conversations from every workspace at
 * once, so unlike the rows nested under a project these have to say where they
 * come from. A pinned conversation is listed in both sections, so which one is
 * rendering the row is passed in rather than inferred from the pin.
 */
function CrossProjectSessionRow({ project, session, activity, pinned, variant, active, timestamp, renaming, renameDraft, renameRef, onRenameChange, onRenameCommit, onRenameCancel, onOpen, onArchive, menu }: {
  project: ProjectSelection;
  session: SessionSummary;
  activity?: SessionActivityState;
  pinned: boolean;
  /** Which section is listing the row; a pinned conversation appears in both. */
  variant: "pinned" | "recent";
  active: boolean;
  timestamp: string;
  renaming: boolean;
  renameDraft: string;
  renameRef: React.RefObject<HTMLInputElement | null>;
  onRenameChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onOpen: () => void;
  onArchive: () => void;
  menu: React.ReactNode;
}): React.JSX.Element {
  // These are the rows most often watched from another project, so they are the
  // ones that most need to say whether the agent is still working and whether
  // what it finished has been read.
  const status = conversationStatusMarker(conversationStatusKind(activity, pinned));
  // No marker means no slot: a quiet recent row starts its title at the same
  // place a quiet row under a project does, and a spinner or unread dot pushes
  // the title along only while there is something to say.
  return <ContextMenu.Root>
    <ContextMenu.Trigger asChild>
      <div className={`conversation-row-wrap ${variant}-conversation-row-wrap`}>
        {renaming ? (
          <div className={`conversation-row renaming ${variant}-conversation-row ${active ? "active" : ""}`}>
            {status ? <span className="conversation-status">{status}</span> : null}
            <TextField look="plain"
              ref={renameRef}
              className="conversation-rename-input"
              value={renameDraft}
              aria-label="重命名对话"
              onChange={(event) => onRenameChange(event.target.value)}
              onBlur={onRenameCommit}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  onRenameCancel();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  onRenameCommit();
                }
              }}
            />
          </div>
        ) : (
          <button className={`conversation-row ${variant}-conversation-row ${active ? "active" : ""}`} type="button" onClick={onOpen}>
            {status ? <span className="conversation-status">{status}</span> : null}
            <span className="conversation-title-text">{session.title}</span>
            <span className="pinned-conversation-project" title={project.path}>{project.name}</span>
            <time>{relativeTime(timestamp)}</time>
          </button>
        )}
        {!renaming ? <button className="conversation-archive-btn" type="button" title="归档" onClick={(event) => { event.stopPropagation(); onArchive(); }}><Archive size={12} /></button> : null}
      </div>
    </ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content className="conversation-context-menu" collisionPadding={8}>{menu}</ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>;
}

export function WorkspaceSidebar({
  projects,
  activeProject,
  activeSessionId,
  sessionsByProject,
  sessionActivity,
  expandedProjects,
  expandedSessionLimits,
  modelLabel,
  onNewConversation,
  onOpenProject,
  onToggleProject,
  onShowMoreSessions,
  onOpenConversation,
  onArchiveConversation,
  onDeleteConversation,
  onDeleteWorkspaceData,
  onRenameConversation,
  onPinConversation,
  onForkConversation,
  onMoveConversation,
  onReorderProjects,
  onRestoreSessions,
  skillsOpen,
  onOpenSkills,
  memoryOpen,
  onOpenMemory,
  onOpenSettings,
  onRemoveProject,
  onError,
}: {
  projects: ProjectSelection[];
  activeProject: ProjectSelection | null;
  activeSessionId?: string;
  sessionsByProject: Record<string, SessionSummary[]>;
  sessionActivity: Record<string, SessionActivityState>;
  expandedProjects: Set<string>;
  expandedSessionLimits: Record<string, number>;
  modelLabel: string;
  onNewConversation: (project?: ProjectSelection) => void;
  onOpenProject: () => void;
  onToggleProject: (path: string) => void;
  onShowMoreSessions: (path: string, limit: number) => void;
  onOpenConversation: (project: ProjectSelection, session: SessionSummary) => void;
  onArchiveConversation: (project: ProjectSelection, session: SessionSummary) => void;
  onDeleteConversation: (project: ProjectSelection, session: SessionSummary) => void;
  onDeleteWorkspaceData: (project: ProjectSelection) => void;
  onRenameConversation: (project: ProjectSelection, session: SessionSummary, name: string) => Promise<void> | void;
  onPinConversation: (project: ProjectSelection, session: SessionSummary, pinned: boolean) => void;
  onForkConversation: (project: ProjectSelection, session: SessionSummary) => void;
  onMoveConversation: (project: ProjectSelection, session: SessionSummary, target: ProjectSelection) => void;
  onReorderProjects: (fromPath: string, toPath: string) => void;
  onRestoreSessions: (project: ProjectSelection, sessions: SessionSummary[]) => void;
  skillsOpen: boolean;
  onOpenSkills: () => void;
  memoryOpen: boolean;
  onOpenMemory: () => void;
  onOpenSettings: () => void;
  onRemoveProject: (project: ProjectSelection) => void;
  onError: (message: string) => void;
}): React.JSX.Element {
  const [renamingTarget, setRenamingTarget] = useState<{ path: string; scope: ConversationRenameScope }>();
  const [renameDraft, setRenameDraft] = useState("");
  const [draggingPath, setDraggingPath] = useState<string>();
  const [dropTargetPath, setDropTargetPath] = useState<string>();
  const renameRef = useRef<HTMLInputElement>(null);
  const [recentCollapsed, setRecentCollapsed] = useState(loadRecentSectionCollapsed);
  const [sectionOrder, setSectionOrder] = useState(loadSidebarSectionOrder);
  const [draggingSection, setDraggingSection] = useState<SidebarSection>();
  const [sectionDropTarget, setSectionDropTarget] = useState<SidebarSection>();
  const [recentLimit, setRecentLimit] = useState(DEFAULT_RECENT_ROWS);
  /* 删除不可撤销，所以两个删除入口都先过这个确认框。把要删的东西记在 state 里而
     不是各画一个对话框——右键菜单一关，菜单里的组件就跟着卸载了。 */
  const [pendingDelete, setPendingDelete] = useState<
    | { kind: "conversation"; project: ProjectSelection; session: SessionSummary }
    | { kind: "workspace"; project: ProjectSelection; count: number }
  >();
  const pinnedSessions = collectPinnedSessions(projects, sessionsByProject);
  const recentSessions = collectRecentSessions(projects, sessionsByProject);
  // The limit counts unpinned rows only; see visibleRecentSessions.
  const recentView = visibleRecentSessions(recentSessions, recentLimit);
  // The home project is recomputed as the first entry on every launch, so only
  // the mounted workspaces have an order worth persisting.
  const reorderable = (target: ProjectSelection): boolean => target.kind === "workspace";

  useEffect(() => {
    if (!renamingTarget) return;
    requestAnimationFrame(() => {
      renameRef.current?.focus();
      renameRef.current?.select();
    });
  }, [renamingTarget]);

  /**
   * Drag one section heading onto the other to swap the two blocks.
   *
   * Same mechanism the project rows already use (HTML5 drag with a text/plain
   * payload), so there is one way to reorder things in this sidebar rather than
   * two. Dragging is off while the recent section is not on screen: with a
   * single heading there is nowhere to drop it, and a drag that goes nowhere
   * reads as broken.
   */
  const sectionDragProps = (section: SidebarSection): React.HTMLAttributes<HTMLDivElement> & { draggable?: boolean } => {
    if (!recentSessions.length) return {};
    return {
      draggable: true,
      title: `拖动可以调整「${SIDEBAR_SECTION_LABELS[section]}」和另一栏的上下顺序`,
      onDragStart: (event) => {
        event.dataTransfer.effectAllowed = "move";
        // Firefox refuses to start a drag without a payload; this also keeps the
        // project rows' own drop handler from mistaking it for a folder.
        event.dataTransfer.setData("text/plain", `section:${section}`);
        setDraggingSection(section);
      },
      onDragOver: (event) => {
        if (!draggingSection || draggingSection === section) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setSectionDropTarget(section);
      },
      onDragLeave: () => setSectionDropTarget((current) => current === section ? undefined : current),
      onDrop: (event) => {
        event.preventDefault();
        const dragged = draggingSection;
        setDraggingSection(undefined);
        setSectionDropTarget(undefined);
        if (!dragged || dragged === section) return;
        setSectionOrder((current) => {
          const next = dropSidebarSection(current, dragged, section);
          saveSidebarSectionOrder(next);
          return next;
        });
      },
      onDragEnd: () => { setDraggingSection(undefined); setSectionDropTarget(undefined); },
    };
  };

  /** The heading's own drag state, as class names. */
  const sectionDragClass = (section: SidebarSection): string =>
    `${draggingSection === section ? " dragging" : ""}${sectionDropTarget === section ? " drop-target" : ""}`;

  const commitRename = async (project: ProjectSelection, session: SessionSummary): Promise<void> => {
    const next = renameDraft.trim();
    setRenamingTarget(undefined);
    if (!next || next === session.title) return;
    try {
      await onRenameConversation(project, session, next);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const beginRename = (scope: ConversationRenameScope, session: SessionSummary): void => {
    setRenameDraft(session.title);
    setRenamingTarget({ path: session.path, scope });
  };

  const cancelRename = (): void => setRenamingTarget(undefined);

  // 「最近」和「项目」两栏的上下顺序由用户定，所以两块各自先拼好，最后按顺序渲染：
  // 换的是真实的 DOM 顺序（不是 CSS 的 order），键盘 Tab 和读屏读到的顺序跟看到的一致。
  const recentSection = recentSessions.length ? (
    <section className="recent-sessions-section">
      <div className={`section-heading${sectionDragClass("recent")}`} {...sectionDragProps("recent")}>
        <button
          className="section-heading-toggle"
          type="button"
          aria-expanded={!recentCollapsed}
          onClick={() => setRecentCollapsed((current) => { saveRecentSectionCollapsed(!current); return !current; })}
        >
          <span>最近</span>
          <ChevronRight className={`section-heading-chevron ${recentCollapsed ? "" : "expanded"}`} size={13} strokeWidth={2} />
        </button>
      </div>
      {recentCollapsed ? null : <div className="conversation-list recent-conversation-list">
        {recentView.rows.map((entry) => <CrossProjectSessionRow
          key={entry.session.path}
          project={entry.project}
          session={entry.session}
          activity={sessionActivity[entry.session.path]}
          pinned={Boolean(entry.session.pinned)}
          variant="recent"
          active={entry.project.path === activeProject?.path && entry.session.id === activeSessionId}
          timestamp={new Date(entry.at).toISOString()}
          renaming={renamingTarget?.path === entry.session.path && renamingTarget.scope === "recent"}
          renameDraft={renameDraft}
          renameRef={renameRef}
          onRenameChange={setRenameDraft}
          onRenameCommit={() => { void commitRename(entry.project, entry.session); }}
          onRenameCancel={cancelRename}
          onOpen={() => onOpenConversation(entry.project, entry.session)}
          onArchive={() => onArchiveConversation(entry.project, entry.session)}
          menu={<ConversationMenu
            project={entry.project}
            session={entry.session}
            activity={sessionActivity[entry.session.path]}
            projects={projects}
            onStartRename={() => beginRename("recent", entry.session)}
            onPin={() => onPinConversation(entry.project, entry.session, !entry.session.pinned)}
            onFork={() => onForkConversation(entry.project, entry.session)}
            onMove={(target) => onMoveConversation(entry.project, entry.session, target)}
            onArchive={() => onArchiveConversation(entry.project, entry.session)}
            onDelete={() => setPendingDelete({ kind: "conversation", project: entry.project, session: entry.session })}
          />}
        />)}
        <ConversationListControls
          hiddenCount={recentView.hiddenCount}
          expandedBy={recentLimit - DEFAULT_RECENT_ROWS}
          onShowMore={() => setRecentLimit(nextExpandedSessionLimit(recentLimit, recentLimit + recentView.hiddenCount))}
          onCollapse={() => setRecentLimit(DEFAULT_RECENT_ROWS)}
        />
      </div>}
    </section>
  ) : null;

  const projectsSection = (<>
    <div className={`section-heading${sectionDragClass("projects")}`} {...sectionDragProps("projects")}><span>项目</span><span className="section-heading-actions"><ArchivedSessionsDialog projects={projects} activeProject={activeProject} onRestored={onRestoreSessions} onError={onError} /><button className="icon-button" type="button" aria-label="打开项目" onClick={onOpenProject}><FolderOpen size={15} strokeWidth={1.7} /></button></span></div>
    {projects.length ? projects.map((project) => {
      const expanded = expandedProjects.has(project.path);
      const allSessions = sessionsByProject[project.path] ?? [];
      // Collapsed workspaces hide their running conversations; the folder
      // row carries their state so nothing is forgotten in there. Pinned ones
      // are not counted: they are listed in the strip at the top now, not under
      // this folder, and a badge for a row that is not there is just confusing.
      const workspaceActivity = summarizeWorkspaceActivity(allSessions, sessionActivity);
      const workspaceActivityText = workspaceActivityLabel(workspaceActivity);
      const collapsedLimit = collapsedSessionLimit();
      const visibleLimit = Math.max(collapsedLimit, expandedSessionLimits[project.path] ?? collapsedLimit);
      const { rows: visibleSessions, hiddenCount, plainTotal } = visibleProjectSessions(allSessions, visibleLimit);
      return (
        <div className={`project-tree ${project.path === activeProject?.path ? "active" : ""}`} key={project.path}>
          <ContextMenu.Root>
            <ContextMenu.Trigger asChild>
              <div
                className={`project-row ${draggingPath === project.path ? "dragging" : ""} ${dropTargetPath === project.path ? "drop-target" : ""}`}
                draggable={reorderable(project)}
                onDragStart={(event) => {
                  if (!reorderable(project)) return;
                  event.dataTransfer.effectAllowed = "move";
                  // Firefox refuses to start a drag without payload, and a
                  // plain-text path is also what an external drop expects.
                  event.dataTransfer.setData("text/plain", project.path);
                  setDraggingPath(project.path);
                }}
                onDragOver={(event) => {
                  if (!draggingPath || draggingPath === project.path || !reorderable(project)) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDropTargetPath(project.path);
                }}
                onDragLeave={() => setDropTargetPath((current) => current === project.path ? undefined : current)}
                onDrop={(event) => {
                  event.preventDefault();
                  const from = draggingPath;
                  setDraggingPath(undefined);
                  setDropTargetPath(undefined);
                  if (from && from !== project.path && reorderable(project)) onReorderProjects(from, project.path);
                }}
                onDragEnd={() => { setDraggingPath(undefined); setDropTargetPath(undefined); }}
              >
                <button className="project-toggle" type="button" aria-expanded={expanded} onClick={() => onToggleProject(project.path)}>
                  <span className="project-leading"><Folder className="project-folder-icon" size={15} strokeWidth={1.7} />{expanded ? <ChevronDown className="project-hover-icon" size={14} /> : <ChevronRight className="project-hover-icon" size={14} />}</span>
                  <span className="project-name">{project.name}</span>
                  {workspaceActivityText ? (
                    // 运行中是一个转圈，读完了是一个静止的绿点。原来两种状态共用
                    // 一个绿点加呼吸动画，扫过去分不出「还在跑」和「跑完了没看」
                    // ——这正是一眼要判断的那件事。
                    <span className="project-activity-slot" role="img" aria-label={workspaceActivityText} title={workspaceActivityText}>
                      {workspaceActivity.running ? <OrbitLoader size={11} /> : <i className="project-activity unread" />}
                    </span>
                  ) : null}
                </button>
                <span className="project-row-actions">
                  <button className="project-action" type="button" aria-label={`在 ${project.name} 中新建对话`} onClick={() => onNewConversation(project)}><Plus size={14} /></button>
                </span>
              </div>
            </ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Content className="conversation-context-menu" collisionPadding={8}>
                <ContextMenu.Item
                  className="conversation-context-item"
                  disabled={project.kind === "home"}
                  onSelect={() => onRemoveProject(project)}
                >
                  <span>卸载工作区</span>
                </ContextMenu.Item>
                <ContextMenu.Separator className="conversation-context-separator" />
                <ContextMenu.Item
                  className="conversation-context-item danger"
                  disabled={project.kind === "home"}
                  onSelect={() => setPendingDelete({ kind: "workspace", project, count: allSessions.length })}
                >
                  <Trash2 size={13} /><span>删除工作区所有记录</span>
                </ContextMenu.Item>
              </ContextMenu.Content>
            </ContextMenu.Portal>
          </ContextMenu.Root>
          <div className={`conversation-list-shell ${expanded ? "expanded" : ""}`} aria-hidden={!expanded}>
            <div className="conversation-list">
              {/* 这里原来有一行「新对话」占位。拿掉了：空的输入框本身就是「还没有
                  对话」，再给它一行列表项反而像凭空多出一条记录——归档完最明显，
                  刚删掉一条，列表顶上立刻冒出一条新的。现在没有可选的对话时，列表
                  里就是什么都不选，右边是空白输入框。 */}
              {visibleSessions.map((session) => {
                const activity = sessionActivity[session.path];
                const renaming = renamingTarget?.path === session.path && renamingTarget.scope === "project";
                const status = conversationStatusMarker(conversationStatusKind(activity, Boolean(session.pinned)));
                return <ContextMenu.Root key={session.id}>
                  <ContextMenu.Trigger asChild>
                    <div className="conversation-row-wrap">
                      {renaming ? (
                        <div className={`conversation-row renaming ${project.path === activeProject?.path && session.id === activeSessionId ? "active" : ""}`}>
                          {session.pinned ? <span className="conversation-status"><Pin size={11} strokeWidth={2} /></span> : null}
                          <TextField look="plain"
                            ref={renameRef}
                            className="conversation-rename-input"
                            value={renameDraft}
                            aria-label="重命名对话"
                            onChange={(event) => setRenameDraft(event.target.value)}
                            onBlur={() => { void commitRename(project, session); }}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                event.preventDefault();
                                cancelRename();
                              } else if (event.key === "Enter") {
                                event.preventDefault();
                                void commitRename(project, session);
                              }
                            }}
                          />
                        </div>
                      ) : (
                        <button
                          className={`conversation-row ${project.path === activeProject?.path && session.id === activeSessionId ? "active" : ""}`}
                          type="button"
                          onClick={() => onOpenConversation(project, session)}
                        >
                          {status ? <span className="conversation-status">{status}</span> : null}
                          <span className="conversation-title-text">{session.title}</span>
                          <time>{relativeTime(session.updatedAt)}</time>
                        </button>
                      )}
                      {!renaming ? (
                        <button
                          className="conversation-archive-btn"
                          type="button"
                          title="归档"
                          onClick={(e) => { e.stopPropagation(); onArchiveConversation(project, session); }}
                        >
                          <Archive size={12} />
                        </button>
                      ) : null}
                    </div>
                  </ContextMenu.Trigger>
                  <ContextMenu.Portal>
                    <ContextMenu.Content className="conversation-context-menu" collisionPadding={8}>
                      <ConversationMenu
                        project={project}
                        session={session}
                        activity={activity}
                        projects={projects}
                        onStartRename={() => beginRename("project", session)}
                        onPin={() => onPinConversation(project, session, !session.pinned)}
                        onFork={() => onForkConversation(project, session)}
                        onMove={(target) => onMoveConversation(project, session, target)}
                        onArchive={() => onArchiveConversation(project, session)}
                        onDelete={() => setPendingDelete({ kind: "conversation", project, session })}
                      />
                    </ContextMenu.Content>
                  </ContextMenu.Portal>
                </ContextMenu.Root>;
              })}
              <ConversationListControls
                hiddenCount={hiddenCount}
                expandedBy={visibleLimit - collapsedLimit}
                onShowMore={() => onShowMoreSessions(project.path, nextExpandedSessionLimit(visibleLimit, plainTotal))}
                onCollapse={() => onShowMoreSessions(project.path, collapsedLimit)}
              />
              {/* 置顶的对话搬到顶上去了，所以「一条都没有」现在得按剩下的算。全被
                  置顶的工作区展开是空的，那就说清楚它们去哪了，别让人以为丢了。 */}
              {!plainTotal ? (
                <p className="empty-conversations">{allSessions.length ? "对话都在上面的置顶区" : "暂无对话"}</p>
              ) : null}
            </div>
          </div>
        </div>
      );
    }) : (
      <button className="open-project-card" type="button" onClick={onOpenProject}><span className="open-project-icon"><Plus size={14} /></span><span><strong>打开项目</strong><small>选择本地文件夹</small></span></button>
    )}
  </>);

  return (
    <aside className="sidebar">
      {/* 这里只保留顶部的布局高度。真正的拖动层放到侧栏内容之后，避免滚动列表里
          已经被裁掉的 no-drag 会话按钮在 Electron 的矩形清单里盖住顶部拖动区。 */}
      <div className="sidebar-drag-spacer" aria-hidden="true" />
      {/* 三个主按钮永远是竖着一列、带文字标签的样子。工作区一多就折成一排图标的
          做法已经去掉：省下的那点高度换来的是「同一个按钮换了位置、也没了名字」，
          左上角看着像换了个界面。 */}
      <nav className="primary-nav">
        <button className="nav-button nav-new" type="button" title="新建对话" disabled={!activeProject} onClick={() => onNewConversation()}><MessageSquarePlus size={16} strokeWidth={1.7} /><span>新建对话</span><kbd>{primaryModifierLabel(rendererPlatform())}N</kbd></button>
        <button className={`nav-button nav-skills ${skillsOpen ? "active" : ""}`} type="button" title="技能" onClick={onOpenSkills}><Sparkles size={16} strokeWidth={1.7} /><span>技能</span></button>
        <button className={`nav-button nav-memory ${memoryOpen ? "active" : ""}`} type="button" title="记忆" onClick={onOpenMemory}><BookOpen size={16} strokeWidth={1.7} /><span>记忆</span></button>
      </nav>
      <section className="project-section">
        {/* No heading and no count: the pin on each row already says what these are,
            and a 36px section title only costs vertical space. */}
        {pinnedSessions.length ? <section className="pinned-sessions-section">
          <div className="conversation-list pinned-conversation-list">
            {pinnedSessions.map((entry) => <CrossProjectSessionRow
              key={entry.session.path}
              project={entry.project}
              session={entry.session}
              activity={sessionActivity[entry.session.path]}
              pinned
              variant="pinned"
              active={entry.project.path === activeProject?.path && entry.session.id === activeSessionId}
              timestamp={entry.session.updatedAt}
              renaming={renamingTarget?.path === entry.session.path && renamingTarget.scope === "pinned"}
              renameDraft={renameDraft}
              renameRef={renameRef}
              onRenameChange={setRenameDraft}
              onRenameCommit={() => { void commitRename(entry.project, entry.session); }}
              onRenameCancel={cancelRename}
              onOpen={() => onOpenConversation(entry.project, entry.session)}
              onArchive={() => onArchiveConversation(entry.project, entry.session)}
              menu={<ConversationMenu
                project={entry.project}
                session={entry.session}
                activity={sessionActivity[entry.session.path]}
                projects={projects}
                onStartRename={() => beginRename("pinned", entry.session)}
                onPin={() => onPinConversation(entry.project, entry.session, false)}
                onFork={() => onForkConversation(entry.project, entry.session)}
                onMove={(target) => onMoveConversation(entry.project, entry.session, target)}
                onArchive={() => onArchiveConversation(entry.project, entry.session)}
                onDelete={() => setPendingDelete({ kind: "conversation", project: entry.project, session: entry.session })}
              />}
            />)}
          </div>
        </section> : null}
        {sectionOrder.map((name) => <Fragment key={name}>{name === "recent" ? recentSection : projectsSection}</Fragment>)}
      </section>
      <div className="sidebar-footer"><div className="brand-mark"><span className="brand-icon" aria-hidden="true" /></div><div className="brand-copy"><strong>CoilCoil</strong><span>{modelLabel}</span></div><button className="icon-button" type="button" aria-label="设置" onClick={onOpenSettings}><Settings size={17} strokeWidth={1.7} /></button></div>
      {/* 必须排在所有会话/项目按钮之后：它是整个左侧栏顶部的最终 drag 声明。外层
          .app-sidebar-control 在 AppView 里排得更后，所以左上角开关仍然可点击。 */}
      <div className="sidebar-drag window-drag-bar"><WindowDragBar className="sidebar-drag-region" /></div>
      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={pendingDelete?.kind === "workspace" ? "删除这个工作区的所有记录？" : "删除这条对话？"}
        description={pendingDelete?.kind === "workspace"
          ? `将永久删除「${pendingDelete.project.name}」的全部 ${pendingDelete.count} 条对话记录（含已归档的），然后把它从侧栏卸载。工作区目录里的文件不会被动。此操作不可撤销。`
          : `将永久删除「${pendingDelete?.session.title ?? ""}」。归档只是收起来，删除是真的删掉，不可撤销。`}
        actions={[
          {
            label: "删除",
            variant: "danger",
            onClick: () => {
              const target = pendingDelete;
              setPendingDelete(undefined);
              if (!target) return;
              if (target.kind === "workspace") onDeleteWorkspaceData(target.project);
              else onDeleteConversation(target.project, target.session);
            },
          },
          { label: "取消", onClick: () => setPendingDelete(undefined), autoFocus: true },
        ]}
        onClose={() => setPendingDelete(undefined)}
      />
    </aside>
  );
}
