import { Check, Copy, ExternalLink, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelProviderAuthState } from "@coilcoil/runtime-protocol";
import { Modal } from "../../ui/dialog";
import { toastError, toastSuccess } from "../../ui/toast";
import { oauthCallbackUrl } from "./providerOAuthPresentation";
import { TextField } from "../../ui/form";

function browserUrl(state: ModelProviderAuthState): string | undefined {
  return state.authUrl?.url ?? state.deviceCode?.verificationUri ?? state.links?.[0]?.url;
}

export function ProviderOAuthDialog({
  state,
  onRespond,
  onClose,
}: {
  state: ModelProviderAuthState;
  onRespond: (promptId: string, value: string) => Promise<void>;
  onClose: () => void;
}): React.JSX.Element {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const openedUrls = useRef(new Set<string>());
  const url = browserUrl(state);
  const callbackUrl = oauthCallbackUrl(state);
  const terminal = state.status === "succeeded" || state.status === "failed" || state.status === "cancelled";
  const waiting = state.status === "starting" || state.status === "authorizing";
  const title = state.status === "succeeded"
    ? "订阅登录成功"
    : state.status === "failed"
      ? "订阅登录失败"
      : state.loginLabel;

  useEffect(() => {
    setValue("");
  }, [state.prompt?.id]);

  useEffect(() => {
    if (!url || openedUrls.current.has(url)) return;
    openedUrls.current.add(url);
    void window.coilcoil.openExternal(url).catch((error) => {
      toastError(`无法打开浏览器：${error instanceof Error ? error.message : String(error)}`);
    });
  }, [url]);

  const description = useMemo(() => {
    if (state.status === "succeeded") return `${state.providerName} 的订阅凭据已经保存到 CoilCoil 私有运行时。`;
    if (state.status === "failed") return state.error ?? state.message ?? "授权流程没有完成。";
    return state.message ?? `CoilCoil 正在为 ${state.providerName} 完成订阅授权。`;
  }, [state]);

  const submit = async (promptId: string, answer: string): Promise<void> => {
    setSubmitting(true);
    try {
      await onRespond(promptId, answer);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      title={title}
      description={description}
      size="md"
      onClose={onClose}
      footer={<>
        {url && !terminal ? <button className="coil-modal-button" type="button" onClick={() => { void window.coilcoil.openExternal(url); }}><ExternalLink size={13} />在浏览器中打开</button> : null}
        <button className={terminal ? "coil-modal-button primary" : "coil-modal-button"} type="button" onClick={onClose}>{terminal ? "完成" : "取消"}</button>
      </>}
    >
      <div className="provider-oauth-dialog-body">
        {callbackUrl ? <section className="provider-oauth-callback">
          <span>OAuth 回调地址</span>
          <code>{callbackUrl}</code>
          <button type="button" onClick={() => { void window.coilcoil.copyText(callbackUrl); toastSuccess("回调地址已复制。"); }}><Copy size={13} />复制</button>
        </section> : null}

        {waiting && !state.deviceCode && !state.prompt ? <div className="provider-oauth-progress"><LoaderCircle className="spin" size={18} /><span>{state.message ?? "正在等待授权…"}</span></div> : null}

        {state.deviceCode ? <section className="provider-oauth-device-code">
          <span>设备验证码</span>
          <strong>{state.deviceCode.userCode}</strong>
          <button type="button" onClick={() => { void window.coilcoil.copyText(state.deviceCode!.userCode); toastSuccess("验证码已复制。"); }}><Copy size={13} />复制验证码</button>
          {state.deviceCode.expiresInSeconds ? <small>验证码约 {Math.max(1, Math.ceil(state.deviceCode.expiresInSeconds / 60))} 分钟内有效</small> : null}
        </section> : null}

        {state.authUrl?.instructions ? <p className="provider-oauth-instructions">{state.authUrl.instructions}</p> : null}

        {state.prompt?.type === "select" ? <section className="provider-oauth-prompt">
          <strong>{state.prompt.message}</strong>
          <div className="provider-oauth-options">
            {state.prompt.options.map((option) => <button type="button" disabled={submitting} key={option.id} onClick={() => { void submit(state.prompt!.id, option.id); }}>
              <span>{option.label}</span>
              {option.description ? <small>{option.description}</small> : null}
            </button>)}
          </div>
        </section> : state.prompt ? <form className="provider-oauth-prompt" onSubmit={(event) => { event.preventDefault(); void submit(state.prompt!.id, value); }}>
          <label htmlFor="provider-oauth-answer">{state.prompt.message}</label>
          <TextField look="plain" className="provider-oauth-input"
            id="provider-oauth-answer"
            type={state.prompt.type === "secret" ? "password" : "text"}
            value={value}
            placeholder={state.prompt.placeholder}
            autoComplete="off"
            onChange={(event) => setValue(event.target.value)}
          />
          <button className="provider-oauth-submit" type="submit" disabled={submitting}>
            {submitting ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}
            继续
          </button>
        </form> : null}

        {state.links?.length ? <div className="provider-oauth-links">{state.links.map((link) => <button type="button" key={link.url} onClick={() => { void window.coilcoil.openExternal(link.url); }}><ExternalLink size={12} />{link.label ?? link.url}</button>)}</div> : null}
        {state.error ? <div className="provider-oauth-error">{state.error}</div> : null}
      </div>
    </Modal>
  );
}
