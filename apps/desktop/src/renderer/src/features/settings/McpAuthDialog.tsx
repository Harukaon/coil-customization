import { Check, ExternalLink, LoaderCircle, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { Modal } from "../../ui/dialog";
import {
  mcpAuthDescription,
  mcpAuthManualFallbackVisible,
  mcpAuthTerminal,
  mcpAuthTitle,
  type McpAuthFlowState,
} from "./mcpAuthPresentation";
import { TextArea } from "../../ui/form";

/**
 * What the user sees after pressing 认证 on an MCP server.
 *
 * The button used to open a browser and leave a paste box behind with no
 * indication of whether anything was still happening. This says which of the
 * three things is true — running, done, failed — keeps the authorization page
 * one click away, and only offers the paste box when the redirect genuinely
 * cannot be captured.
 */
export function McpAuthDialog({
  state,
  submitting,
  onRetry,
  onManualComplete,
  onClose,
}: {
  state: McpAuthFlowState;
  submitting: boolean;
  onRetry: () => void;
  onManualComplete: (input: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [manualInput, setManualInput] = useState("");
  const terminal = mcpAuthTerminal(state);
  const manual = mcpAuthManualFallbackVisible(state);

  useEffect(() => {
    if (state.phase === "starting") setManualInput("");
  }, [state.phase, state.server]);

  return (
    <Modal
      open
      title={mcpAuthTitle(state)}
      description={mcpAuthDescription(state)}
      size="md"
      onClose={onClose}
      footer={<>
        {state.authorizationUrl && !terminal
          ? <button className="coil-modal-button" type="button" onClick={() => { void window.coilcoil.openExternal(state.authorizationUrl!); }}><ExternalLink size={13} />重新打开授权页</button>
          : null}
        {state.phase === "failed"
          ? <button className="coil-modal-button primary" type="button" disabled={submitting} onClick={onRetry}><RotateCcw size={13} />重试</button>
          : null}
        <button className={state.phase === "succeeded" ? "coil-modal-button primary" : "coil-modal-button"} type="button" onClick={onClose}>{terminal ? "关闭" : "取消"}</button>
      </>}
    >
      <div className="provider-oauth-dialog-body">
        {!terminal && !manual ? <div className="provider-oauth-progress">
          <LoaderCircle className="spin" size={18} />
          <span>{state.phase === "waiting" ? "等待浏览器完成授权…" : state.phase === "completing" ? "正在完成认证…" : "正在准备授权…"}</span>
        </div> : null}

        {state.phase === "succeeded" ? <div className="provider-oauth-progress"><Check size={18} /><span>凭据已保存，服务器可以直接使用了。</span></div> : null}

        {manual ? <form
          className="provider-oauth-prompt"
          onSubmit={(event) => { event.preventDefault(); onManualComplete(manualInput.trim()); }}
        >
          <label htmlFor="mcp-auth-manual-input">浏览器没有自动回来？粘贴地址栏里的完整回调地址或授权码</label>
          <TextArea look="plain" className="provider-oauth-input"
            id="mcp-auth-manual-input"
            value={manualInput}
            placeholder="http://localhost:.../callback?code=..."
            onChange={(event) => setManualInput(event.target.value)}
          />
          <button className="provider-oauth-submit" type="submit" disabled={submitting || !manualInput.trim()}>
            {submitting ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}
            完成认证
          </button>
        </form> : null}

        {state.phase === "failed" && state.message ? <div className="provider-oauth-error">{state.message}</div> : null}
      </div>
    </Modal>
  );
}
