import { ArchiveRestore, ChevronDown, LoaderCircle, RotateCcw, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectSelection, SessionSummary } from "@coilcoil/runtime-protocol";
import { Modal } from "../../ui/dialog";
import { filterArchivedSessionGroups, initialArchiveTarget, pendingArchiveTargets } from "./archiveSessions";
import { TextField } from "../../ui/form";

function archivedTime(value: string | undefined): string {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * 归档会话对话框。
 *
 * 读一个项目的归档列表要把这个项目的每个会话文件都扫一遍，所以打开时只读当前
 * 项目，其余项目等到展开、或者搜索时（搜索本来就是要求看全部）再读。
 */
export function ArchivedSessionsDialog({
  projects,
  activeProject,
  onRestored,
  onError,
}: {
  projects: ProjectSelection[];
  activeProject: ProjectSelection | null;
  onRestored: (project: ProjectSelection, sessions: SessionSummary[]) => void;
  onError: (message: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [restoringPath, setRestoringPath] = useState<string>();
  const [archives, setArchives] = useState<Record<string, SessionSummary[]>>({});
  const [loadingPaths, setLoadingPaths] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const cancelledRef = useRef(false);

  const load = useCallback(async (paths: string[]): Promise<void> => {
    if (!paths.length) return;
    setLoadingPaths((current) => [...current, ...paths]);
    await Promise.all(paths.map(async (path) => {
      try {
        const sessions = await window.coilcoil.request<SessionSummary[]>({ type: "list_archived_sessions", cwd: path });
        if (!cancelledRef.current) setArchives((current) => ({ ...current, [path]: sessions }));
      } catch (caught) {
        if (!cancelledRef.current) onError(caught instanceof Error ? caught.message : String(caught));
      }
    }));
    if (!cancelledRef.current) setLoadingPaths((current) => current.filter((path) => !paths.includes(path)));
  }, [onError]);

  // Read through refs so the eager read fires once per opening, not again every
  // time the parent re-renders with a fresh `projects` array.
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const activeRef = useRef(activeProject);
  activeRef.current = activeProject;

  useEffect(() => {
    if (!open) return;
    cancelledRef.current = false;
    const first = initialArchiveTarget(projectsRef.current, activeRef.current);
    if (first) void load([first]);
    return () => { cancelledRef.current = true; };
  }, [load, open]);

  // Searching is an explicit request to look past the project that opened, so it
  // is the one moment the remaining projects are worth reading.
  useEffect(() => {
    if (!open || !query.trim()) return;
    void load(pendingArchiveTargets(projects, archives, loadingPaths));
  }, [archives, load, loadingPaths, open, projects, query]);

  const loading = loadingPaths.length > 0;
  const count = useMemo(() => Object.values(archives).reduce((sum, sessions) => sum + sessions.length, 0), [archives]);
  const groups = useMemo(
    () => filterArchivedSessionGroups(projects, archives, query, expanded),
    [archives, expanded, projects, query],
  );
  const shown = useMemo(() => groups.reduce((sum, group) => sum + group.sessions.length, 0), [groups]);
  const unread = projects.length - Object.keys(archives).length;

  const close = (): void => {
    cancelledRef.current = true;
    setOpen(false);
    setQuery("");
    setArchives({});
    setLoadingPaths([]);
    setExpanded([]);
  };

  const restore = async (project: ProjectSelection, session: SessionSummary): Promise<void> => {
    setRestoringPath(session.path);
    try {
      const sessions = await window.coilcoil.request<SessionSummary[]>({ type: "restore_session", cwd: project.path, sessionPath: session.path });
      setArchives((current) => ({ ...current, [project.path]: (current[project.path] ?? []).filter((item) => item.path !== session.path) }));
      onRestored(project, sessions);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRestoringPath(undefined);
    }
  };

  return (
    <>
      <button className="icon-button" type="button" aria-label="归档会话" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><ArchiveRestore size={15} strokeWidth={1.7} /></button>
      <Modal open={open} bare onClose={close}>
        <section className="archive-dialog" role="dialog" aria-modal="true" aria-labelledby="archive-dialog-title">
          <header>
            <div>
              <strong id="archive-dialog-title">归档会话</strong>
              <small>{loading && !count ? "正在读取…" : query.trim() ? `${shown} 个匹配` : `${count} 个会话${unread > 0 ? `（还有 ${unread} 个项目未读取）` : ""}`}</small>
            </div>
            <span>{loading ? <LoaderCircle className="spin" size={14} /> : null}<button className="icon-button" type="button" aria-label="关闭归档会话" onClick={close}><X size={15} /></button></span>
          </header>
          <label className="archive-search"><Search size={14} /><TextField look="plain" className="archive-search-input" autoFocus value={query} placeholder="搜索归档会话标题（会读取全部项目）" onChange={(event) => setQuery(event.target.value)} /></label>
          <div className="archive-groups">
            {groups.map(({ project, sessions, hidden, pending }) => (
              <section key={project.path}>
                <h3>{project.name}</h3>
                {pending ? (
                  <button
                    className="archive-load-more"
                    type="button"
                    disabled={loadingPaths.includes(project.path)}
                    onClick={() => { void load([project.path]); }}
                  >
                    {loadingPaths.includes(project.path) ? <LoaderCircle className="spin" size={13} /> : <ChevronDown size={13} />}
                    读取这个项目的归档
                  </button>
                ) : null}
                {sessions.map((session) => (
                  <div className="archive-session" key={session.path}>
                    <span><strong>{session.title}</strong><small>{archivedTime(session.archivedAt)}</small></span>
                    <button type="button" disabled={restoringPath === session.path} onClick={() => { void restore(project, session); }}>
                      {restoringPath === session.path ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />}恢复
                    </button>
                  </div>
                ))}
                {hidden > 0 ? (
                  <button className="archive-load-more" type="button" onClick={() => setExpanded((current) => [...current, project.path])}>
                    <ChevronDown size={13} />还有 {hidden} 个
                  </button>
                ) : null}
              </section>
            ))}
            {!loading && count === 0 && !groups.some((group) => group.pending) ? <p className="archive-empty">暂无归档会话</p> : null}
            {!loading && count > 0 && shown === 0 ? <p className="archive-empty archive-filter-empty">没有匹配的归档会话</p> : null}
          </div>
        </section>
      </Modal>
    </>
  );
}
