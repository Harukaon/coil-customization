import { ArrowDown, ArrowUp, Check, ChevronDown, FolderGit2, GitBranch, LoaderCircle, Minus, Plus, RefreshCw, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { GitBranch as GitBranchInfo, GitCommit, GitCommitFile, GitFileChange, GitRepository } from "@coilcoil/runtime-protocol";
import { ConfirmDialog } from "../../ui/dialog";
import { Select } from "../../ui/Select";
import { toastSuccess } from "../../ui/toast";
import { DiffView } from "./GitDiffView";
import { FileRow } from "./GitFileRow";
import { GitHistory } from "./GitHistory";
import { listRepositories, useGit } from "./useGit";
import "./git.css";
import { TextArea, TextField } from "../../ui/form";

function BranchMenu({ current, load, onCheckout, onCreate, disabled }: {
  current?: string;
  load: () => Promise<GitBranchInfo[]>;
  onCheckout: (branch: string) => void;
  onCreate: (name: string) => void;
  disabled: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<GitBranchInfo[]>([]);
  const [name, setName] = useState("");
  useEffect(() => {
    if (!open) return;
    void load().then(setList, () => setList([]));
  }, [load, open]);
  return (
    <div className="git-branch">
      <button className="git-branch-button" type="button" aria-label="切换分支" aria-expanded={open} disabled={disabled} onClick={() => setOpen((value) => !value)}>
        <GitBranch size={13} />
        <span>{current ?? "分离 HEAD"}</span>
        <ChevronDown size={12} />
      </button>
      {open ? (
        <div className="git-branch-menu" role="menu">
          {list.map((branch) => (
            <button key={branch.name} type="button" role="menuitem" className={branch.current ? "current" : ""} onClick={() => {
              setOpen(false);
              if (!branch.current) onCheckout(branch.name);
            }}>
              {branch.current ? <Check size={12} /> : <span className="git-branch-spacer" />}
              <span>{branch.name}</span>
              {branch.upstream ? <small>{branch.upstream}</small> : null}
            </button>
          ))}
          <form className="git-branch-create" onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return;
            onCreate(name.trim());
            setName("");
            setOpen(false);
          }}>
            <TextField look="plain" className="git-branch-input" value={name} placeholder="新分支名，回车创建并切换" aria-label="新分支名" onChange={(event) => setName(event.target.value)} />
          </form>
        </div>
      ) : null}
    </div>
  );
}

/** 每组先画这么多行，其余按「显示更多」再画：改动再多，挂在页面上的行数也有上限。 */
const ROW_STEP = 200;
/** 一次操作涉及这么多处改动以上，先确认范围再动手。 */
const BULK_CONFIRM_THRESHOLD = 50;
const REPOSITORY_CHOICE_KEY = "coilcoil.git.repositoryByWorkspace";

function savedRepository(workspace: string): string | undefined {
  try {
    const value = JSON.parse(window.localStorage.getItem(REPOSITORY_CHOICE_KEY) ?? "{}") as Record<string, unknown>;
    return typeof value[workspace] === "string" ? value[workspace] as string : undefined;
  } catch {
    return undefined;
  }
}

function saveRepository(workspace: string, root: string): void {
  try {
    const value = JSON.parse(window.localStorage.getItem(REPOSITORY_CHOICE_KEY) ?? "{}") as Record<string, unknown>;
    window.localStorage.setItem(REPOSITORY_CHOICE_KEY, JSON.stringify({ ...value, [workspace]: root }));
  } catch {
    // 记不住就算了。
  }
}

interface PendingConfirm {
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  run(): void;
}

/** 一组改动：先画 ROW_STEP 行，按「显示更多」再加。 */
function FileSection({ title, files, stateOf, actions, row }: {
  title: string;
  files: GitFileChange[];
  stateOf: (file: GitFileChange) => NonNullable<GitFileChange["staged"]>;
  actions: React.ReactNode;
  row: (file: GitFileChange, state: NonNullable<GitFileChange["staged"]>) => React.ReactNode;
}): React.JSX.Element {
  const [shown, setShown] = useState(ROW_STEP);
  return (
    <section className="git-section">
      <header>
        <span>{title} <b>{files.length}</b></span>
        {actions}
      </header>
      <ul>{files.slice(0, shown).map((file) => row(file, stateOf(file)))}</ul>
      {files.length > shown ? (
        <button className="git-load-more" type="button" onClick={() => setShown((value) => value + ROW_STEP)}>
          显示更多（还有 {files.length - shown} 处）
        </button>
      ) : null}
    </section>
  );
}

/**
 * 右侧作业栏的 Git 面板：看改动、看 diff、暂存、提交、推送拉取、切换分支。
 *
 * 和 VS Code 的源代码管理一个思路。暂存区和工作区分两组列；一个文件可以同时出现
 * 在两组里（暂存了一部分又接着改）。点文件名看 diff，单栏和左右对照可以切换。
 * 下面是可折叠的提交历史（带分支线条图），点提交看它改的文件，再点文件看 diff。
 *
 * 一个上层文件夹里放着好几个小项目也照常能用（和 VS Code 一样）：面板会找出工作区
 * 本身所在的仓库和子文件夹里的仓库，可以只看其中一个；改动再多也只交来有限的条数、
 * 只画有限的行，整体没被跟踪的文件夹算一条。
 */
export function GitPanel({ cwd, active }: { cwd?: string; active: boolean }): React.JSX.Element {
  const [repositories, setRepositories] = useState<GitRepository[]>();
  const [repositoryRoot, setRepositoryRoot] = useState<string>();
  useEffect(() => {
    setRepositories(undefined);
    setRepositoryRoot(undefined);
    if (!cwd || !active) return;
    let cancelled = false;
    listRepositories(cwd).then((list) => {
      if (cancelled) return;
      setRepositories(list);
      const saved = savedRepository(cwd);
      setRepositoryRoot(list.find((repository) => repository.root === saved)?.root ?? list[0]?.root);
    }, () => {
      if (!cancelled) setRepositories([]);
    });
    return () => { cancelled = true; };
  }, [active, cwd]);
  const repository = repositories?.find((item) => item.root === repositoryRoot);
  const repositoryLabel = repository ? (repository.name === "." ? "工作区所在的仓库" : repository.name) : "";
  const git = useGit(repositoryRoot, active && Boolean(repositoryRoot));
  const [confirm, setConfirm] = useState<PendingConfirm>();
  const [view, setView] = useState<
    | { kind: "change"; path: string; staged: boolean }
    | { kind: "commit"; commit: GitCommit; file: GitCommitFile }
  >();
  const [message, setMessage] = useState("");
  const files = git.status?.files ?? [];
  const staged = files.filter((file) => file.staged);
  const unstaged = files.filter((file) => file.unstaged);
  const busy = git.busy !== undefined;

  const total = git.status?.total ?? 0;
  const truncated = git.status?.truncated === true;
  const commitNow = useCallback(async (stageAll: boolean): Promise<void> => {
    const ok = await git.run({ op: "commit", message, stageAll });
    if (ok) {
      setMessage("");
      toastSuccess("已提交。");
    }
  }, [git, message]);
  const commit = useCallback(async (): Promise<void> => {
    if (staged.length || (!truncated && total < BULK_CONFIRM_THRESHOLD)) return commitNow(staged.length === 0);
    setConfirm({
      title: "暂存全部并提交？",
      description: `会先把「${repositoryLabel}」里全部 ${total} 处改动暂存，再一起提交。`,
      confirmLabel: "暂存全部并提交",
      run: () => { void commitNow(true); },
    });
  }, [commitNow, repositoryLabel, staged.length, total, truncated]);

  // DiffView 换了 load 才重新读，所以按看的是哪份 diff 固定下来。
  const { diff: loadChange, commitDiff } = git;
  const diffLoad = useMemo(() => {
    if (!view) return undefined;
    if (view.kind === "change") return () => loadChange(view.path, view.staged);
    return () => commitDiff(view.commit.hash, view.file.path, view.file.originalPath);
  }, [commitDiff, loadChange, view]);

  if (!cwd) return <div className="git-panel"><div className="git-empty">先打开一个工作区。</div></div>;
  if (repositories && repositories.length === 0) {
    return <div className="git-panel"><div className="git-empty">这个工作区里没有 git 仓库。</div></div>;
  }
  const status = git.status;
  return (
    <div className="git-panel">
      {view && diffLoad ? (
        <DiffView
          load={diffLoad}
          path={view.kind === "change" ? view.path : view.file.path}
          label={view.kind === "change" ? (view.staged ? "已暂存" : "工作区") : `${view.commit.shortHash} ${view.commit.subject}`}
          onBack={() => setView(undefined)}
        />
      ) : null}
      {/* 看 diff 时列表只是藏起来：回来时历史展开到哪、滚到哪都还在。 */}
      <div className="git-main" hidden={Boolean(view)}>
        {repositories && repositories.length > 1 ? (
          <div className="git-repository">
            <FolderGit2 size={13} />
            <Select
              ariaLabel="仓库"
              value={repositoryRoot}
              searchable={repositories.length > 8}
              options={repositories.map((item) => ({
                value: item.root,
                label: item.name === "." ? `${item.root.split(/[\\/]/).at(-1)}（工作区所在的仓库）` : item.name,
                detail: item.root,
              }))}
              onChange={(root) => {
                setRepositoryRoot(root);
                setView(undefined);
                saveRepository(cwd, root);
              }}
            />
          </div>
        ) : null}
        <div className="git-toolbar">
          <BranchMenu
            current={status?.branch}
            load={git.branches}
            disabled={busy || !status}
            onCheckout={(branch) => { void git.run({ op: "checkout", branch }); }}
            onCreate={(name) => { void git.run({ op: "create_branch", name }); }}
          />
          <span className="git-sync" title={status?.upstream ? `上游 ${status.upstream}` : "还没有上游分支，第一次推送时会自动设置"}>
            {status?.ahead ? <span><ArrowUp size={11} />{status.ahead}</span> : null}
            {status?.behind ? <span><ArrowDown size={11} />{status.behind}</span> : null}
          </span>
          <button className="git-icon-button" type="button" aria-label="拉取" title="拉取（只快进）" disabled={busy || !status?.upstream} onClick={() => { void git.run({ op: "pull" }).then((ok) => ok && toastSuccess("已拉取。")); }}>
            {git.busy === "pull" ? <LoaderCircle size={14} className="spin" /> : <ArrowDown size={14} />}
          </button>
          <button className="git-icon-button" type="button" aria-label="推送" title="推送" disabled={busy || !status?.branch} onClick={() => { void git.run({ op: "push" }).then((ok) => ok && toastSuccess("已推送。")); }}>
            {git.busy === "push" ? <LoaderCircle size={14} className="spin" /> : <ArrowUp size={14} />}
          </button>
          <button className="git-icon-button" type="button" aria-label="刷新" disabled={busy} onClick={() => { void git.refresh(); }}><RefreshCw size={13} /></button>
        </div>

        {git.error ? <div className="git-error" role="alert">{git.error}</div> : null}
        {truncated ? (
          <div className="git-notice" role="status">
            改动太多（共 {total} 处），只列出前 {files.length} 处。{repositories && repositories.length > 1 ? "可以在上面选一个子仓库单独看。" : ""}「全部暂存 / 全部丢弃」作用于整个仓库。
          </div>
        ) : null}

        <div className="git-commit">
          <TextArea look="plain" className="git-commit-input"
            value={message}
            placeholder={status?.branch ? `提交说明（提交到 ${status.branch}）` : "提交说明"}
            aria-label="提交说明"
            rows={3}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && message.trim() && files.length && !busy) {
                event.preventDefault();
                void commit();
              }
            }}
          />
          <button className="git-commit-button" type="button" disabled={!message.trim() || !files.length || busy} onClick={() => { void commit(); }}>
            {git.busy === "commit" ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}
            {staged.length ? `提交 ${staged.length} 个文件` : "暂存全部并提交"}
          </button>
        </div>

        {!status ? <div className="git-empty"><LoaderCircle size={14} className="spin" />正在读取 git 状态…</div> : null}
        {status && files.length === 0 ? <div className="git-empty">工作区是干净的，没有改动。</div> : null}

        {staged.length ? (
          <FileSection
            key={`staged:${repositoryRoot}`}
            title="已暂存的更改"
            files={staged}
            stateOf={(file) => file.staged!}
            actions={<button className="git-icon-button" type="button" aria-label="全部取消暂存" disabled={busy} onClick={() => { void git.run({ op: "unstage_all" }); }}><Minus size={13} /></button>}
            row={(file, state) => (
              <FileRow key={`staged:${file.path}`} file={file} state={state} onOpen={() => setView({ kind: "change", path: file.path, staged: true })} actions={(
                <button className="git-icon-button" type="button" aria-label={`取消暂存 ${file.path}`} disabled={busy} onClick={() => { void git.run({ op: "unstage", paths: [file.path] }); }}><Minus size={13} /></button>
              )} />
            )}
          />
        ) : null}

        {unstaged.length ? (
          <FileSection
            key={`unstaged:${repositoryRoot}`}
            title="更改"
            files={unstaged}
            stateOf={(file) => file.unstaged!}
            actions={(
              <>
                <button className="git-icon-button" type="button" aria-label="全部丢弃" disabled={busy} onClick={() => setConfirm({
                  title: "丢弃全部改动？",
                  description: `「${repositoryLabel}」里所有没暂存的改动都会被丢掉（${truncated ? `共 ${total} 处，包括没列出来的` : `${unstaged.length} 处`}），未跟踪的文件和文件夹会被删除，.gitignore 管的文件不动。已暂存的部分不受影响。这一步没法撤销。`,
                  confirmLabel: "丢弃",
                  danger: true,
                  run: () => { void git.run({ op: "discard_all" }); },
                })}><Undo2 size={13} /></button>
                <button className="git-icon-button" type="button" aria-label="全部暂存" disabled={busy} onClick={() => {
                  const stageAll = (): void => { void git.run({ op: "stage_all" }); };
                  if (!truncated && unstaged.length < BULK_CONFIRM_THRESHOLD) return stageAll();
                  setConfirm({
                    title: "暂存全部改动？",
                    description: `会把「${repositoryLabel}」里全部 ${truncated ? `${total} 处（包括没列出来的）` : `${unstaged.length} 处`}改动都暂存。`,
                    confirmLabel: "全部暂存",
                    run: stageAll,
                  });
                }}><Plus size={13} /></button>
              </>
            )}
            row={(file, state) => (
              <FileRow key={`unstaged:${file.path}`} file={file} state={state} onOpen={file.path.endsWith("/") ? undefined : () => setView({ kind: "change", path: file.path, staged: false })} actions={(
                <>
                  <button className="git-icon-button" type="button" aria-label={`丢弃 ${file.path}`} disabled={busy} onClick={() => setConfirm({
                    title: "丢弃改动？",
                    description: `${file.path} 在工作区里的改动会被丢掉${file.path.endsWith("/") ? "，这个文件夹整个会被删除" : "，未跟踪的文件会被删除"}。已暂存的部分不受影响。这一步没法撤销。`,
                    confirmLabel: "丢弃",
                    danger: true,
                    run: () => { void git.run({ op: "discard", paths: [file.path] }); },
                  })}><Undo2 size={13} /></button>
                  <button className="git-icon-button" type="button" aria-label={`暂存 ${file.path}`} disabled={busy} onClick={() => { void git.run({ op: "stage", paths: [file.path] }); }}><Plus size={13} /></button>
                </>
              )} />
            )}
          />
        ) : null}

        <GitHistory status={status} log={git.log} commitFiles={git.commitFiles} onOpenFile={(commit, file) => setView({ kind: "commit", commit, file })} />
      </div>

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.title ?? ""}
        description={confirm?.description ?? ""}
        onClose={() => setConfirm(undefined)}
        actions={[
          { label: "取消", onClick: () => setConfirm(undefined), autoFocus: true },
          { label: confirm?.confirmLabel ?? "确定", variant: confirm?.danger ? "danger" : "primary", onClick: () => {
            const pending = confirm;
            setConfirm(undefined);
            pending?.run();
          } },
        ]}
      />
    </div>
  );
}
