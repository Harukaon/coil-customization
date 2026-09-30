import { Code2, Copy, Eye, FileText, FolderOpen, Image as ImageIcon, LoaderCircle, Pencil, Save, X, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FilePreviewDocument } from "../../../../shared/desktop-api";
import { toastError, toastSuccess } from "../../ui/toast";
import { beginEdit, editAvailability, hasExternalChange, isDirty, rebaseEdit, type EditSession } from "./fileEditing";
import { htmlZoomFrameStyle, stepHtmlZoom } from "./htmlZoom";
import { copyPath, revealLabel, revealPath } from "./pathActions";
import "./preview.css";
import { TextArea } from "../../ui/form";

export function FilePreviewPane({ preview, root, loading, error, onClose, onDirtyChange }: {
  preview?: FilePreviewDocument;
  root?: string;
  loading: boolean;
  error?: string;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}): React.JSX.Element {
  const [rendered, setRendered] = useState(true);
  const [htmlZoom, setHtmlZoom] = useState(100);
  const [session, setSession] = useState<EditSession>();
  const [saving, setSaving] = useState(false);
  const [discardArmed, setDiscardArmed] = useState(false);

  useEffect(() => {
    setRendered(true);
    setHtmlZoom(100);
    setSession(undefined);
    setDiscardArmed(false);
  }, [preview?.id]);

  const dirty = isDirty(session);
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const save = useCallback(async (): Promise<void> => {
    if (!session || !preview || !root || saving) return;
    setSaving(true);
    try {
      const result = await window.coilcoil.saveProjectFile({
        root,
        path: preview.path,
        content: session.draft,
        expectedMtimeMs: session.baseMtimeMs,
      });
      if (!result.saved) {
        toastError(result.message);
        return;
      }
      toastSuccess(`已保存 ${preview.name}`);
      setSession(undefined);
      setDiscardArmed(false);
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }, [preview, root, saving, session]);

  const cancelEdit = (): void => {
    // Leaving edit mode throws typing away, so a dirty draft asks once — the same
    // arm-then-confirm the skill list uses, instead of a system dialog.
    if (dirty && !discardArmed) {
      setDiscardArmed(true);
      return;
    }
    setSession(undefined);
    setDiscardArmed(false);
  };

  const availability = editAvailability(preview, root);
  const editing = Boolean(session);
  const outdated = hasExternalChange(session, preview);
  const canRender = !editing && (preview?.kind === "markdown" || preview?.kind === "html");
  const embeddedPreview = !editing && !loading && !error && (preview?.kind === "pdf" || preview?.kind === "image" || (preview?.kind === "html" && rendered));
  const notice = preview?.truncated || outdated;
  const kindLabel = preview?.kind === "text"
    ? "文本"
    : preview?.kind === "markdown"
      ? "Markdown"
      : preview?.kind === "image"
        ? "图片"
        : preview?.kind.toUpperCase();

  return (
    <section className={`inline-file-preview ${preview ? "has-document" : ""} ${notice ? "has-warning" : ""}`}>
      <header className="inline-preview-header">
        <div className="inline-preview-title">
          {preview?.kind === "image" ? <ImageIcon size={14} /> : <FileText size={14} />}
          <div className="inline-preview-heading">
            <strong title={preview?.path}>{preview?.name || "文件预览"}</strong>
            {/* The name alone is not enough to act on: the path is what gets pasted
                into a terminal, so it is shown and one click copies it. */}
            {preview?.path ? <button className="inline-preview-path" type="button" title={`${preview.path}\n点击复制`} onClick={() => { void copyPath(preview.path); }}>
              <span className="inline-preview-path-text">{preview.path}</span>
              <Copy size={11} />
            </button> : null}
          </div>
        </div>
        <div className="inline-preview-actions">
          {preview?.kind === "html" && rendered && !editing ? (
            <div className="preview-zoom" aria-label="HTML 预览缩放">
              <button type="button" aria-label="缩小 HTML 预览" title="缩小" disabled={htmlZoom <= 50} onClick={() => setHtmlZoom((current) => stepHtmlZoom(current, -1))}><ZoomOut size={12} /></button>
              <button className="preview-zoom-value" type="button" title="恢复 100%" onClick={() => setHtmlZoom(100)}>{htmlZoom}%</button>
              <button type="button" aria-label="放大 HTML 预览" title="放大" disabled={htmlZoom >= 200} onClick={() => setHtmlZoom((current) => stepHtmlZoom(current, 1))}><ZoomIn size={12} /></button>
            </div>
          ) : null}
          {canRender ? (
            <div className="preview-mode">
              <button className={!rendered ? "active" : ""} type="button" title="查看源码" onClick={() => setRendered(false)}><Code2 size={13} /></button>
              <button className={rendered ? "active" : ""} type="button" title="查看预览" onClick={() => setRendered(true)}><Eye size={13} /></button>
            </div>
          ) : null}
          {/* Editing is a mode of its own: the preview is never typed into, and
              leaving it is either a save or an explicit discard. */}
          {preview && !editing && availability.canEdit ? (
            <button className="inline-preview-edit" type="button" title="编辑此文件" onClick={() => setSession(beginEdit(preview))}>
              <Pencil size={12} />编辑
            </button>
          ) : null}
          {editing ? (
            <>
              <button className="inline-preview-save" type="button" disabled={saving || !dirty} title="保存（⌘S）" onClick={() => { void save(); }}>
                {saving ? <LoaderCircle className="spin" size={12} /> : <Save size={12} />}保存
              </button>
              <button className={`inline-preview-discard${discardArmed ? " armed" : ""}`} type="button" disabled={saving} title={discardArmed ? "再次点击放弃修改" : "退出编辑"} onClick={cancelEdit}>
                {discardArmed ? "确认放弃" : "取消"}
              </button>
            </>
          ) : null}
          {preview?.path ? <button className="inline-preview-reveal" type="button" aria-label={revealLabel()} title={revealLabel()} onClick={() => revealPath(preview.path)}><FolderOpen size={14} /></button> : null}
          <button className="inline-preview-close" type="button" aria-label="关闭文件预览" title="关闭文件预览" onClick={onClose}><X size={15} /></button>
        </div>
      </header>
      {preview?.truncated ? <div className="preview-warning">文件较大，仅显示前一部分内容。</div> : null}
      {outdated && session && preview ? (
        <div className="preview-warning preview-conflict">
          <span>此文件已在磁盘上被改动（可能是 Agent 写的）。</span>
          <button type="button" onClick={() => setSession(rebaseEdit(session, preview, false))}>用磁盘上的版本</button>
          <button type="button" onClick={() => setSession(rebaseEdit(session, preview, true))}>保留我的修改</button>
        </div>
      ) : null}
      <div className={`inline-preview-content ${embeddedPreview ? "embedded" : ""}`}>
        {loading ? <div className="preview-placeholder"><LoaderCircle className="spin" size={16} /><span>正在打开文件…</span></div> : null}
        {!loading && error ? <div className="preview-placeholder error"><FileText size={16} /><span>{error}</span></div> : null}
        {session ? (
          <TextArea look="plain"
            className="text-editor"
            aria-label={`编辑 ${preview?.name ?? "文件"}`}
            spellCheck={false}
            autoFocus
            value={session.draft}
            onChange={(event) => {
              const draft = event.target.value;
              setDiscardArmed(false);
              setSession((current) => current ? { ...current, draft } : current);
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                void save();
              }
            }}
          />
        ) : null}
        {!editing && !loading && !error && preview?.kind === "pdf" ? <embed className="pdf-preview" src={preview.content} type="application/pdf" /> : null}
        {!editing && !loading && !error && preview?.kind === "image" ? <div className="image-preview-shell"><img className="image-preview" src={preview.content} alt={preview.name} draggable={false} /></div> : null}
        {!editing && !loading && !error && preview?.kind === "markdown" && rendered ? <article className="preview-markdown markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{preview.content}</ReactMarkdown></article> : null}
        {!editing && !loading && !error && preview?.kind === "html" && rendered ? <div className="html-preview-shell"><iframe
          className="html-preview"
          title={preview.name}
          // Scripts run so a page's animations and interactions preview as they
          // will look, but without allow-same-origin the frame stays on an opaque
          // origin: no access to this window, its storage, or the file's own
          // directory. Nothing else in the sandbox is granted.
          sandbox="allow-scripts"
          srcDoc={preview.content}
          style={htmlZoomFrameStyle(htmlZoom)}
        /></div> : null}
        {!editing && !loading && !error && preview && (preview.kind === "text" || !rendered) ? <pre className="text-preview"><code>{preview.content}</code></pre> : null}
      </div>
      {preview ? (
        <footer className="inline-preview-status">
          {editing ? <span className="inline-preview-editing">编辑中{dirty ? " · 未保存" : ""}</span> : null}
          {!editing && availability.reason ? <span className="inline-preview-readonly">{availability.reason}</span> : null}
          <span>{kindLabel}</span>
          <span>{new Date(preview.updatedAt).toLocaleTimeString("zh-CN")}</span>
          <span>{editing ? "⌘S 保存" : "实时更新"}</span>
        </footer>
      ) : null}
    </section>
  );
}
