import { Copy, LoaderCircle, RefreshCw, Smartphone, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RemoteAccessInput, RemoteAccessState, RemoteTunnelMode } from "../../../../shared/desktop-api";
import { toastError, toastSuccess } from "../../ui/toast";
import { platformComputerLabel, rendererPlatform } from "../../platform";
import { Checkbox, Field, TextArea, TextField } from "../../ui/form";

const TUNNEL_MODES: { id: RemoteTunnelMode; name: string; summary: string; available: boolean }[] = [
  {
    id: "reverse-proxy",
    name: "自有服务器反代",
    summary: "主机主动连到你自己的服务器，服务器用一个域名对外提供 HTTPS。手机上什么都不用装。",
    available: true,
  },
  {
    id: "tailscale",
    name: "Tailscale 私有网络",
    summary: "主机和手机加入同一个私有网络直连，不需要服务器、域名和证书。手机上要装 Tailscale 并登录同一个账号。",
    available: true,
  },
];

function formatWhen(timestamp: number): string {
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
}

/**
 * Remote control: the switch, the pairing code, and what the Mac may do while
 * it is being driven from elsewhere.
 *
 * The pairing code lives here rather than in a log or a terminal because it is
 * the one secret a person has to read off this screen and type on another
 * device; anywhere else it either leaks into a file or is unreachable in the
 * packaged app.
 */
export function RemoteSettings(): React.JSX.Element {
  const [state, setState] = useState<RemoteAccessState>();
  const [saving, setSaving] = useState(false);
  const [port, setPort] = useState("");
  const [publicUrl, setPublicUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [notes, setNotes] = useState("");
  const notesTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void window.coilcoil.getRemoteAccess()
      .then((next) => {
        if (cancelled) return;
        setState(next);
        setPort(String(next.port));
        setPublicUrl(next.publicUrl ?? "");
        setUsername(next.username ?? "");
        setNotes(next.notes ?? "");
      })
      .catch((caught: unknown) => { if (!cancelled) toastError(caught instanceof Error ? caught.message : String(caught)); });
    // The code rotates on every pairing and the connected count changes on its
    // own, so this screen follows the main process rather than polling it.
    const stop = window.coilcoil.onRemoteAccessChanged((next) => { if (!cancelled) setState(next); });
    return () => { cancelled = true; stop(); };
  }, []);

  const save = async (input: RemoteAccessInput, done?: string): Promise<void> => {
    setSaving(true);
    try {
      const next = await window.coilcoil.saveRemoteAccess(input);
      setState(next);
      setPort(String(next.port));
      if (done) toastSuccess(done);
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  if (!state) {
    return <div className="remote-settings"><p className="remote-lead">正在读取远程控制状态…</p></div>;
  }

  const hostLabel = platformComputerLabel(rendererPlatform());
  const mode = TUNNEL_MODES.find((candidate) => candidate.id === state.mode) ?? TUNNEL_MODES[0];
  // Tailscale needs no address from the user: the tailnet address plus the port
  // is the whole answer, so asking for one would only be a field to get wrong.
  const address = mode.id === "tailscale"
    ? (state.tailscaleAddress ? `http://${state.tailscaleAddress}:${state.port}` : undefined)
    : state.publicUrl?.trim();

  return (
    <div className="remote-settings">
      <section className="remote-section">
        <div className="remote-switch-row">
          <div>
            <h3>用手机遥控这台 {hostLabel}</h3>
            <p className="remote-lead">
              手机上打开的是同一套界面、同一个会话，所有活儿仍然在这台 {hostLabel} 上执行。同一时间只允许一台设备接管。
            </p>
          </div>
          <button
            className={`remote-switch ${state.enabled ? "on" : ""}`}
            type="button"
            role="switch"
            aria-checked={state.enabled}
            aria-label="启用远程控制"
            disabled={saving}
            onClick={() => void save({ enabled: !state.enabled }, state.enabled ? "远程控制已关闭。" : "远程控制已开启。")}
          >
            <span />
          </button>
        </div>

        <div className={`remote-status ${state.error ? "error" : state.running ? "ok" : ""}`}>
          {saving ? <LoaderCircle className="spin" size={13} /> : <Smartphone size={13} />}
          <span>
            {state.error
              ? `无法启动：${state.error}`
              : !state.enabled
                ? "未开启"
                : state.running
                  ? state.connectedClients > 0 ? "正在被 1 台设备遥控" : `正在监听 ${state.host}:${state.port}，等待设备接入`
                  : "正在启动…"}
          </span>
        </div>
      </section>

      {state.enabled && state.running ? (
        <section className="remote-section">
          <h3>配对</h3>
          <p className="remote-lead">
            在手机浏览器里打开访问地址，输入这个码即可。配对成功后码会立刻作废并换新，手机保存的是一份长期凭证，不用每次输入。
          </p>
          <div className="remote-code-row">
            <output className="remote-code" aria-label="配对码">{state.pairingCode}</output>
            <button className="remote-action" type="button" disabled={saving} onClick={() => void window.coilcoil.regenerateRemotePairingCode()}>
              <RefreshCw size={13} />换一个
            </button>
          </div>
          {address ? (
            <div className="remote-code-row">
              <code className="remote-address">{address}</code>
              <button
                className="remote-action"
                type="button"
                onClick={() => { void window.coilcoil.copyText(address); toastSuccess("地址已复制。"); }}
              >
                <Copy size={13} />复制
              </button>
            </div>
          ) : mode.id === "tailscale" ? (
            <p className="remote-hint">还没检测到这台 {hostLabel} 的 Tailscale 地址。装好 Tailscale 并登录后，地址会自动出现在这里。</p>
          ) : (
            <p className="remote-hint">还没填访问地址，在下面「连接方式」里填上之后这里会显示，方便复制到手机。</p>
          )}
        </section>
      ) : null}

      <section className="remote-section">
        <h3>连接方式</h3>
        <p className="remote-lead">
          两种都是内网穿透，区别在于谁来转发。走服务器时入口只监听本机回环，由隧道送出去；走 Tailscale 时直接监听这台 {hostLabel} 的私有网络地址，手机在同一个私有网络里直连。
        </p>
        <div className="remote-modes">
          {TUNNEL_MODES.map((candidate) => (
            <button
              key={candidate.id}
              className={`remote-mode ${state.mode === candidate.id ? "active" : ""}`}
              type="button"
              disabled={!candidate.available || saving}
              aria-pressed={state.mode === candidate.id}
              // Switching modes must not throw away an address the user just
              // typed but has not saved yet — that is the value they came for.
              onClick={() => void save({ mode: candidate.id, port: Number.parseInt(port, 10), publicUrl })}
            >
              <span className="remote-mode-name">
                {candidate.name}
                {candidate.available ? null : <em>即将支持</em>}
              </span>
              <span className="remote-mode-summary">{candidate.summary}</span>
            </button>
          ))}
        </div>

        {mode.id === "tailscale" ? (
          <div className="remote-steps">
            <h4>Tailscale 怎么用</h4>
            <ol>
              <li>{hostLabel} 和手机各装一个 Tailscale，登录同一个账号。</li>
              <li>切到这个模式并开启远程控制，CoilCoil 会自动监听这台 {hostLabel} 的私有网络地址。</li>
              <li>
                手机浏览器打开 <code>http://{state.tailscaleAddress ?? `<${hostLabel} 的 Tailscale 地址>`}:{state.port}</code>
                {state.tailscaleAddress ? null : "（当前没检测到 Tailscale 地址，装好并登录后回到这里）"}
              </li>
            </ol>
            <p className="remote-hint">不需要域名和证书，也不用碰路由器。缺点是手机上必须装着 Tailscale 并保持登录。</p>
          </div>
        ) : mode.id === "reverse-proxy" ? (
          <div className="remote-steps">
            <h4>服务器上要做的三件事</h4>
            <ol>
              <li>准备一个解析到那台服务器的域名。</li>
              <li>在服务器上装好 nginx 或 Caddy，加一个把该域名反代到 <code>127.0.0.1:{state.port}</code> 的站点，并申请证书。转发配置必须带 WebSocket 升级，否则手机上的会话不会实时更新。</li>
              <li>在这台 {hostLabel} 上开一条常驻的反向隧道，把本机的 {state.port} 端口送到服务器的同一端口。仓库里的 <code>scripts/remote/mac-tunnel.sh install</code> 会把它装成开机自启、断线自动重连。</li>
            </ol>
            <p className="remote-hint">仓库 <code>scripts/remote/</code> 下有可直接套用的 nginx 配置模板和隧道脚本。</p>
          </div>
        ) : null}

        <form
          className="ui-form remote-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save(
              mode.id === "reverse-proxy"
                ? { port: Number.parseInt(port, 10), publicUrl }
                : { port: Number.parseInt(port, 10) },
              "已保存。",
            );
          }}
        >
          <Field>
            本机监听端口
            <TextField value={port} inputMode="numeric" onChange={(event) => setPort(event.target.value)} placeholder="7788" />
          </Field>
          {mode.id === "reverse-proxy" ? (
            <Field>
              手机访问地址
              <TextField value={publicUrl} onChange={(event) => setPublicUrl(event.target.value)} placeholder="https://coil.example.com" />
              <small className="remote-field-hint">你在服务器上配好的那个域名。只用来显示在上面方便复制，不影响监听。</small>
            </Field>
          ) : null}
          <footer className="ui-form-footer">
            <span>改端口会断开当前连接的设备，需要在手机上刷新。</span>
            <button className="remote-action primary" type="submit" disabled={saving}>保存</button>
          </footer>
        </form>
      </section>

      <section className="remote-section">
        <h3>备忘</h3>
        <p className="remote-lead">
          自己记东西的地方：隧道命令、域名、服务器上改过什么。内容只存在这台 {hostLabel} 上，跟着远程设置一起保存，谁都不会读它。
        </p>
        <TextArea
          className="remote-notes"
          value={notes}
          spellCheck={false}
          rows={6}
          placeholder={"例如：\nssh -N -R 7788:127.0.0.1:7788 vps\nhttps://coil.example.com"}
          onChange={(event) => {
            const next = event.target.value;
            setNotes(next);
            // Typing should not fire a write per keystroke, and there is no save
            // button to press: the box is a scratchpad, not a form.
            if (notesTimer.current !== undefined) window.clearTimeout(notesTimer.current);
            notesTimer.current = window.setTimeout(() => { void save({ notes: next }); }, 700);
          }}
        />
      </section>

      <section className="remote-section">
        <h3>账号密码</h3>
        <p className="remote-lead">
          配对码用过一次就失效，适合站在 {hostLabel} 前面配对。账号密码则可以随时随地登录，换手机、清了浏览器数据都不用再回到 {hostLabel} 上看码。两种方式都能用。
        </p>
        <form
          className="ui-form remote-form"
          onSubmit={(event) => {
            event.preventDefault();
            void window.coilcoil.setRemoteAccount(username, password)
              .then((next) => { setState(next); setPassword(""); toastSuccess(username.trim() && password ? "账号已保存。" : "账号已清除。"); })
              .catch((caught: unknown) => toastError(caught instanceof Error ? caught.message : String(caught)));
          }}
        >
          <Field>
            用户名
            <TextField value={username} autoComplete="username" onChange={(event) => setUsername(event.target.value)} />
          </Field>
          <Field>
            密码
            <TextField value={password} type="password" autoComplete="new-password" placeholder={state.username ? "留空则不修改现有密码" : "设置一个密码"} onChange={(event) => setPassword(event.target.value)} />
          </Field>
          <footer className="ui-form-footer">
            <span>{state.username ? `当前账号：${state.username}。清空用户名并保存即可停用。` : "尚未设置账号，目前只能用配对码登录。"}</span>
            <button className="remote-action primary" type="submit" disabled={saving}>保存</button>
          </footer>
        </form>
      </section>

      <section className="remote-section">
        <h3>信任自己的网络</h3>
        <p className="remote-lead">
          开启后，来自你自己的 Tailscale 私有网络或局域网的设备直接进入，不再要求登录。
        </p>
        <Field className="remote-check">
          <Checkbox look="plain" className="remote-check-input"
            checked={state.trustLocalNetwork}
            disabled={saving}
            onChange={(event) => void save({ trustLocalNetwork: event.target.checked })}
          />
          <span>
            <strong>私有网络和局域网免登录</strong>
            <small>
              判断依据是对方的真实 IP 地址，不是任何可以伪造的请求头。经由服务器反代进来的连接不算自己人：
              那种连接在本机看来都来自本地回环，一旦信任就等于对整个公网敞开，所以回环永远要登录。
            </small>
          </span>
        </Field>
      </section>

      <section className="remote-section">
        <h3>休眠策略</h3>
        <p className="remote-lead">
          {hostLabel} 睡着了就没人回应手机。开启后 CoilCoil 会声明系统不得进入闲置休眠——系统不需要额外授权，屏幕仍然可以照常息屏。
        </p>
        <Field className="remote-check">
          <Checkbox look="plain" className="remote-check-input"
            checked={state.keepAwake}
            disabled={saving}
            onChange={(event) => void save({ keepAwake: event.target.checked })}
          />
          <span>
            <strong>远程控制开启时阻止系统休眠</strong>
            <small>
              {state.keepAwakeActive ? "当前生效中。" : "当前未生效。"}
              合盖仍然会睡——那是硬件行为，任何软件都改不了。要合盖继续跑，得接电源并外接显示器，或在系统设置里关掉合盖休眠。
            </small>
          </span>
        </Field>
      </section>

      <section className="remote-section">
        <h3>已配对设备</h3>
        {state.devices.length ? (
          <>
            <ul className="remote-devices">
              {state.devices.map((device) => (
                <li key={`${device.pairedAt}`}>
                  <span className="remote-device-name" title={device.name}>{device.name}</span>
                  <span className="remote-device-when">配对于 {formatWhen(device.pairedAt)}</span>
                </li>
              ))}
            </ul>
            <button className="remote-action danger" type="button" onClick={() => void window.coilcoil.revokeRemoteDevices()}>
              <Trash2 size={13} />全部吊销
            </button>
          </>
        ) : (
          <p className="remote-hint">还没有设备配对。配对新设备会自动作废上一台，始终只有一台手机持有凭证。</p>
        )}
      </section>
    </div>
  );
}
