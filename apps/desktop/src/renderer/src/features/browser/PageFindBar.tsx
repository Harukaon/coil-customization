import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { TextField } from "../../ui/form";

/**
 * 页面内查找（⌘F / Ctrl+F）：面板右上角一条小栏，和浏览器自带的查找一样用。
 *
 * 打字就找，回车下一处、Shift+回车上一处，Esc 收起。高亮是网页自己画的（Chromium 的
 * findInPage），画面里直接看得到。收起时把键盘还给页面。
 */
export function PageFindBar({ result, onFind, onClose }: {
  /** 最近一次的结果：一共几处、现在是第几处。 */
  result: { matches: number; active: number } | undefined;
  onFind(text: string, forward: boolean, newSearch: boolean): void;
  onClose(): void;
}): React.JSX.Element {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const step = (forward: boolean): void => {
    if (text) onFind(text, forward, false);
    inputRef.current?.focus();
  };

  const count = !text ? "" : !result ? "…" : result.matches === 0 ? "无结果" : `${result.active}/${result.matches}`;
  return (
    <div className="browser-find-bar" role="search" onMouseDown={(event) => event.stopPropagation()}>
      <TextField look="plain" className="browser-find-input"
        ref={inputRef}
        aria-label="在网页中查找"
        placeholder="在网页中查找"
        value={text}
        spellCheck={false}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          onFind(next, true, true);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") { event.preventDefault(); step(!event.shiftKey); }
          else if (event.key === "Escape") { event.preventDefault(); onClose(); }
          else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "g") { event.preventDefault(); step(!event.shiftKey); }
        }}
      />
      <span className="browser-find-count" aria-live="polite">{count}</span>
      <button type="button" aria-label="上一处" disabled={!result?.matches} onClick={() => step(false)}><ChevronUp size={14} /></button>
      <button type="button" aria-label="下一处" disabled={!result?.matches} onClick={() => step(true)}><ChevronDown size={14} /></button>
      <button type="button" aria-label="关闭查找" onClick={onClose}><X size={13} /></button>
    </div>
  );
}
