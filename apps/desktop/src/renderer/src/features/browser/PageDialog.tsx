import { useState } from "react";
import type { BrowserPageDialog } from "../../../../shared/desktop-api";
import { TextField } from "../../ui/form";

/**
 * 网页自己弹的 alert / confirm / prompt：一张卡片盖在这张页面的画面上，只挡这张页面。
 *
 * 不用 App 的 Modal：Modal 一打开就把焦点抢过去、挡住整个窗口，可这种对话框常常是
 * Agent 在后台点出来的，用户那时正在对话框里打字。卡片出现时不抢焦点，用户点了再答；
 * Agent 也可以自己答（CDP），答了卡片就消失。样式沿用 App 弹窗的那一套。
 */
export function PageDialog({ dialog, onReply }: {
  dialog: BrowserPageDialog;
  onReply(accept: boolean, text?: string): void;
}): React.JSX.Element {
  const [text, setText] = useState(dialog.defaultPrompt);
  const [answered, setAnswered] = useState(false);
  const reply = (accept: boolean): void => {
    if (answered) return;
    setAnswered(true);
    onReply(accept, dialog.type === "prompt" ? text : undefined);
  };
  const title = dialog.origin ? `${dialog.origin} 显示` : "网页显示";
  return (
    <div
      className="coil-modal browser-page-dialog"
      role="alertdialog"
      aria-label={title}
      // 卡片上的点击、按键归卡片自己，不落到下面的页面画面上。
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          reply(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          reply(dialog.type === "alert");
        }
      }}
    >
      <h2 className="coil-modal-title">{title}</h2>
      {dialog.message ? <p className="coil-modal-description">{dialog.message}</p> : null}
      {dialog.type === "prompt" ? (
        <TextField look="plain"
          className="browser-page-dialog-input"
          aria-label="回答网页的问题"
          value={text}
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
        />
      ) : null}
      <div className="coil-modal-footer">
        {dialog.type === "alert" ? null : (
          <button type="button" className="coil-modal-button" disabled={answered} onClick={() => reply(false)}>取消</button>
        )}
        <button type="button" className="coil-modal-button primary" disabled={answered} onClick={() => reply(true)}>确定</button>
      </div>
    </div>
  );
}
