import { LoaderCircle, Maximize2, Send, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, RuntimeEvent, SessionSnapshot } from "@coilcoil/runtime-protocol";
import {
  conversationMessagesReducer,
  EMPTY_CONVERSATION_MESSAGES,
  selectConversationMessages,
} from "./features/conversation/conversationMessages";
import { toastError } from "./ui/toast";
import "./bubble.css";
import { TextArea } from "./ui/form";

/**
 * The floating ask-anything window.
 *
 * It is the same renderer as the workspace, cut down to what a passing question
 * needs: one conversation in the home project, a list of messages, and a way to
 * hand the whole thing to the main window when the answer turns into work. The
 * runtime is shared - main broadcasts its events to every window - so a session
 * opened here is already streaming when the workspace picks it up.
 */
export function BubbleApp(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<SessionSnapshot>();
  const [messages, dispatch] = useReducer(conversationMessagesReducer, EMPTY_CONVERSATION_MESSAGES);
  const [running, setRunning] = useState(false);
  const [draft, setDraft] = useState("");
  const [starting, setStarting] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const snapshotRef = useRef<SessionSnapshot>(undefined);
  snapshotRef.current = snapshot;

  // A passing question belongs in the home project: it is the one workspace that
  // always exists and never belongs to a particular piece of work.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const home = await window.coilcoil.homeProject();
        const created = await window.coilcoil.request<SessionSnapshot>({ type: "create_session", cwd: home.path });
        if (cancelled) return;
        setSnapshot(created);
        dispatch({ type: "reset", sessionPath: created.session.path, messages: created.messages });
      } catch (caught) {
        if (!cancelled) toastError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) setStarting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return window.coilcoil.onRuntimeEvent((event: RuntimeEvent, runtimeId?: string) => {
      const current = snapshotRef.current;
      if (!current || (runtimeId && runtimeId !== current.runtimeId)) return;
      const sessionPath = current.session.path;
      switch (event.type) {
        case "message_started":
        case "message_finished":
          dispatch({ type: "runtime_message", message: event.message, revision: event.revision, sessionPath });
          break;
        case "message_delta":
          dispatch({ ...event, timestamp: Date.now(), sessionPath });
          break;
        case "message_rejected":
          dispatch({ type: "reject", id: event.id, revision: event.revision });
          break;
        case "run_state":
          setRunning(event.running);
          break;
        default:
          break;
      }
    });
  }, []);

  const visible = useMemo(() => selectConversationMessages(messages)
    .filter((message) => message.role === "user" || message.role === "assistant"), [messages]);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [visible]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") void window.coilcoil.hideBubble();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const send = useCallback((): void => {
    const text = draft.trim();
    const current = snapshotRef.current;
    if (!text || !current) return;
    const clientMessageId = `bubble-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setDraft("");
    dispatch({
      type: "queue",
      sessionPath: current.session.path,
      message: { id: clientMessageId, order: Date.now(), role: "user", text, timestamp: Date.now() },
    });
    void window.coilcoil.request({ type: "prompt", text, clientMessageId }, current.runtimeId)
      .catch((caught: unknown) => {
        dispatch({ type: "reject", id: clientMessageId });
        setDraft(text);
        toastError(caught instanceof Error ? caught.message : String(caught));
      });
  }, [draft]);

  const handOver = (): void => {
    const current = snapshotRef.current;
    void window.coilcoil.openMainWindow(current
      ? { cwd: current.session.cwd, sessionPath: current.session.path }
      : undefined);
  };

  return (
    <div className="bubble-shell">
      <header className="bubble-header window-drag">
        <button className="bubble-icon-button no-drag" type="button" title="在 CoilCoil 中打开" aria-label="在 CoilCoil 中打开" onClick={handOver}>
          <Maximize2 size={13} />
        </button>
        <span className="bubble-title">{snapshot?.session.title?.trim() || "快速提问"}</span>
        <button className="bubble-icon-button no-drag" type="button" title="关闭（Esc）" aria-label="关闭" onClick={() => void window.coilcoil.hideBubble()}>
          <X size={14} />
        </button>
      </header>

      <div className="bubble-messages" ref={listRef}>
        {starting ? <p className="bubble-hint"><LoaderCircle className="spin" size={13} />正在准备会话…</p> : null}
        {!starting && !visible.length ? <p className="bubble-hint">问点什么，回车发送。</p> : null}
        {visible.map((message) => <BubbleMessage key={message.id} message={message} />)}
        {running ? <p className="bubble-hint"><LoaderCircle className="spin" size={13} />正在回复…</p> : null}
      </div>

      <div className="bubble-composer">
        <TextArea look="plain" className="bubble-composer-input"
          ref={inputRef}
          value={draft}
          rows={1}
          autoFocus
          placeholder="问点什么…"
          aria-label="向 CoilCoil 提问"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            send();
          }}
        />
        <button className="bubble-send" type="button" aria-label="发送" disabled={!draft.trim() || !snapshot} onClick={send}>
          <Send size={14} />
        </button>
      </div>
    </div>
  );
}

function BubbleMessage({ message }: { message: ChatMessage }): React.JSX.Element {
  if (message.role === "user") {
    return <div className="bubble-message user"><span>{message.text}</span></div>;
  }
  return (
    <div className="bubble-message assistant markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
    </div>
  );
}
