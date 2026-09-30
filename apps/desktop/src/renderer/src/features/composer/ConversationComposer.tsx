import { ArrowUp, LoaderCircle, Square, X } from "lucide-react";
import type { DragEvent as ReactDragEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import type {
  ModelOption,
  PromptDocument,
  PromptImage,
  ProjectSelection,
  RuntimeConfiguration,
  SessionSnapshot,
} from "@coilcoil/runtime-protocol";
import { carriesPaths, droppedPaths, quotePath } from "./pathInsert";
import { ModelPicker } from "./ModelPicker";
import type { PromptEditorHandle } from "./PromptEditor";
import { PromptImagePreview } from "./PromptImagePreview";
import { TiptapPromptEditor } from "./TiptapPromptEditor";

export type ComposerVariant = "footer" | "inline";

export function ConversationComposer({
  variant = "footer",
  project,
  running,
  aborting,
  goalActive,
  loading,
  startingSession,
  draft,
  document,
  images,
  inputRef,
  configuration,
  selectedModel,
  thinkingLevel,
  fast,
  modelMenuOpen,
  modelChanging,
  autoFocus,
  onSubmit,
  onDocumentChange,
  onReplaceTextRange,
  onImagesChange,
  onPaste,
  onCompositionStart,
  onCompositionEnd,
  onKeyDown,
  onSlashKeyDown,
  onModelMenuOpenChange,
  onSelectModel,
  onConfigureModelOptions,
  onFastChange,
  onOpenSettings,
  onAbort,
  onEscape,
  onPathDropError,
}: {
  variant?: ComposerVariant;
  project: ProjectSelection | null;
  running: boolean;
  /** A stop was pressed and the turn has not finished winding down. */
  aborting?: boolean;
  /** A `/goal` loop owns the session: every message interjects, nothing queues. */
  goalActive?: boolean;
  loading: boolean;
  startingSession: boolean;
  draft: string;
  images: PromptImage[];
  inputRef: RefObject<PromptEditorHandle | null>;
  configuration?: RuntimeConfiguration;
  selectedModel?: SessionSnapshot["model"];
  thinkingLevel?: RuntimeConfiguration["thinkingLevel"];
  fast?: boolean;
  modelMenuOpen: boolean;
  modelChanging: boolean;
  autoFocus?: boolean;
  onSubmit: (event: FormEvent) => void;
  document: PromptDocument;
  onDocumentChange: (document: PromptDocument) => void;
  onReplaceTextRange: (start: number, end: number, replacement: string) => void;
  onImagesChange: React.Dispatch<React.SetStateAction<PromptImage[]>>;
  onPaste: React.ClipboardEventHandler<HTMLDivElement>;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  onKeyDown: React.KeyboardEventHandler<HTMLDivElement>;
  onSlashKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => boolean;
  onModelMenuOpenChange: (open: boolean) => void;
  onSelectModel: (model: ModelOption) => void;
  onConfigureModelOptions?: (model: ModelOption, thinkingLevel: RuntimeConfiguration["thinkingLevel"], contextWindow?: number) => Promise<void>;
  onFastChange?: (enabled: boolean) => Promise<void>;
  onOpenSettings: () => void;
  onAbort?: () => void;
  /** Send the draft into the running turn instead of the queue. */
  onEscape?: () => void;
  onPathDropError?: (message: string) => void;
}): React.JSX.Element {
  const inline = variant === "inline";

  const handlePathDragOver = (event: ReactDragEvent<HTMLElement>): void => {
    if (!carriesPaths(event.dataTransfer)) return;
    event.preventDefault();
    // Do not stopPropagation on enter/over — that made the pane think the drag left,
    // flashing the drop mask off while hovering an inline composer / user message.
    event.dataTransfer.dropEffect = "copy";
  };

  const handlePathDrop = (event: ReactDragEvent<HTMLElement>): void => {
    if (!carriesPaths(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      const paths = droppedPaths(event.dataTransfer);
      if (!paths.length) return;
      const value = draft;
      const start = inputRef.current?.getCaretOffset() ?? value.length;
      const before = value.slice(0, start);
      const after = value.slice(start);
      const leadingSpace = before.length && !/\s$/.test(before) ? " " : "";
      const trailingSpace = after.length && !/^\s/.test(after) ? " " : "";
      const insertion = `${leadingSpace}${paths.map(quotePath).join(" ")}${trailingSpace}`;
      onReplaceTextRange(start, start, insertion);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setCaretOffset(start + insertion.length);
      });
    } catch {
      onPathDropError?.("无法插入拖入的路径。请重新拖动一次。");
    }
  };

  const handleKeyDown: React.KeyboardEventHandler<HTMLDivElement> = (event) => {
    if (onSlashKeyDown?.(event)) return;
    if (event.key === "Escape" && onEscape) {
      event.preventDefault();
      onEscape();
      return;
    }
    onKeyDown(event);
  };

  return (
    <form
      className={`composer ${inline ? "composer-inline" : ""}`}
      data-composer-variant={variant}
      onSubmit={onSubmit}
      onDragEnter={handlePathDragOver}
      onDragOver={handlePathDragOver}
      onDrop={handlePathDrop}
    >
      {images.length ? (
        <div className="composer-images">
          {images.map((image) => (
            <figure key={image.id ?? image.data.slice(0, 24)} title={image.name} data-element={image.name?.startsWith("网页元素") ? "" : undefined}>
              <PromptImagePreview image={image} alt={image.name ?? "粘贴的图片"} className="composer-image-preview" />
              <button type="button" aria-label="移除图片" onClick={() => onImagesChange((current) => current.filter((item) => item !== image))}>
                <X size={11} />
              </button>
            </figure>
          ))}
        </div>
      ) : null}
      {/* 主输入框和历史消息编辑态共用同一套 Tiptap 文档与键盘行为。 */}
      <TiptapPromptEditor
        ref={inputRef as never}
        document={document}
        onChange={onDocumentChange}
        ariaLabel={inline ? "编辑历史消息" : "发送消息给 CoilCoil"}
        placeholder={inline ? "编辑历史消息…" : "让 CoilCoil 处理这个项目…"}
        disabled={!project || loading || startingSession || modelChanging}
        onPasteImages={onPaste}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        onKeyDown={handleKeyDown}
        autoFocus={autoFocus}
      />
      <div className="composer-toolbar">
        <ModelPicker
          configuration={configuration}
          currentModel={selectedModel}
          currentThinkingLevel={thinkingLevel}
          currentFast={fast}
          open={modelMenuOpen}
          busy={modelChanging}
          side={inline ? "bottom" : "top"}
          onOpenChange={onModelMenuOpenChange}
          onSelect={onSelectModel}
          onConfigureOptions={onConfigureModelOptions}
          onFastChange={onFastChange}
          onOpenSettings={onOpenSettings}
        />
        {!inline && running && onAbort ? (
          <button
            className={`stop-button ${aborting ? "aborting" : ""}`}
            type="button"
            aria-label={aborting ? "正在停止 Agent" : "停止 Agent"}
            title={aborting ? "正在停止：还在等一个已经发出的工具调用收尾" : "停止"}
            disabled={aborting}
            onClick={onAbort}
          >
            {aborting ? <LoaderCircle className="spin" size={13} /> : <Square size={12} fill="currentColor" />}
          </button>
        ) : null}
        <button
          className="send-button"
          type="submit"
          aria-label={inline ? "从这里重新开始" : running ? (goalActive ? "介入当前轮次" : "加入队列") : "发送消息"}
          title={!inline && running && goalActive ? "目标模式：消息会插进当前轮次，不排队" : undefined}
          disabled={!project || startingSession || modelChanging || (!draft.trim() && !images.length)}
        >
          <ArrowUp size={17} strokeWidth={2.2} />
        </button>
      </div>
    </form>
  );
}
