import { LoaderCircle, RefreshCw, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { DiscoveredMcpServer, McpConfigurationSnapshot, McpDiscoveryResult } from "@coilcoil/runtime-protocol";
import { toastError, toastSuccess } from "../../ui/toast";
import { Checkbox } from "../../ui/form";

/**
 * 「发现 MCP」弹窗：先看见机器上别的工具都配了什么，再自己勾几个导进来。
 *
 * 以前只有一个「导入检测到的配置」按钮，按下去是整包接管每一个来源，导进来什么
 * 事前看不见，事后也拆不开。这里改成逐个服务器勾选。
 *
 * 勾选默认是「全不选」而不是「全选」：整包导入正是要改掉的行为，默认全选等于换
 * 个样子做同一件事。
 */

const ORIGIN_NAMES: Record<DiscoveredMcpServer["origin"], string> = {
  cursor: "Cursor",
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  codex: "Codex",
  opencode: "opencode",
  windsurf: "Windsurf",
  vscode: "VS Code",
};

/** 一行里显示「它到底会跑什么」。完整内容留在 title 上，行内太长就省略。 */
function summarize(server: DiscoveredMcpServer): string {
  if (server.transport === "http") return server.url ?? "HTTP";
  return [server.command, ...(server.args ?? [])].filter(Boolean).join(" ") || "stdio";
}

function serverKey(server: { origin: string; name: string }): string {
  return `${server.origin} ${server.name}`;
}

export function McpDiscoveryDialog({
  open,
  cwd,
  runtimeId,
  onClose,
  onImported,
}: {
  open: boolean;
  cwd?: string;
  runtimeId?: string;
  onClose: () => void;
  onImported: (snapshot: McpConfigurationSnapshot) => void;
}): React.JSX.Element | null {
  const [result, setResult] = useState<McpDiscoveryResult | undefined>(undefined);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setScanning(true);
    setResult(undefined);
    setPicked(new Set());
    void window.coilcoil.request<McpDiscoveryResult>({ type: "discover_mcp_servers", cwd }, runtimeId)
      .then((discovered) => {
        if (!cancelled) setResult(discovered);
      })
      .catch((caught) => {
        if (cancelled) return;
        toastError(caught instanceof Error ? caught.message : String(caught));
        setResult({ servers: [], emptyOrigins: [] });
      })
      .finally(() => {
        if (!cancelled) setScanning(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, cwd, runtimeId, round]);

  if (!open) return null;

  const servers = result?.servers ?? [];
  const importable = servers.filter((server) => !server.alreadyPresent);
  const toggle = (server: DiscoveredMcpServer): void => {
    setPicked((previous) => {
      const next = new Set(previous);
      const key = serverKey(server);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };

  const importPicked = async (): Promise<void> => {
    const chosen = importable.filter((server) => picked.has(serverKey(server)));
    if (!chosen.length) return;
    setImporting(true);
    try {
      const snapshot = await window.coilcoil.request<McpConfigurationSnapshot>({
        type: "import_mcp_servers",
        input: { servers: chosen.map((server) => ({ origin: server.origin, name: server.name })), cwd },
      }, runtimeId);
      onImported(snapshot);
      toastSuccess(`已导入 ${chosen.length} 个 MCP 服务器。`);
      onClose();
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="mcp-json-overlay" role="dialog" aria-modal="true" aria-labelledby="mcp-discovery-title">
      <div className="mcp-json-dialog mcp-discovery-dialog">
        <header>
          <div>
            <strong id="mcp-discovery-title"><Search size={15} />发现 MCP</strong>
            <small>从这台机器上其它工具的配置里挑。勾中的会抄一份到 CoilCoil，之后归你自己管。</small>
          </div>
          <button type="button" aria-label="关闭" disabled={importing} onClick={onClose}><X size={15} /></button>
        </header>
        {scanning ? (
          <div className="settings-loading"><LoaderCircle className="spin" size={15} />正在扫描…</div>
        ) : (
          <div className="mcp-discovery-list">
            {servers.map((server) => {
              const key = serverKey(server);
              return (
                <label className={`mcp-discovery-row${server.alreadyPresent ? " present" : ""}`} key={key}>
                  <Checkbox look="plain"
                    checked={picked.has(key)}
                    disabled={server.alreadyPresent || importing}
                    onChange={() => toggle(server)}
                  />
                  <span className="mcp-discovery-row-main">
                    <b>{server.name}</b>
                    <small title={summarize(server)}>{summarize(server)}</small>
                  </span>
                  <span className="mcp-discovery-row-meta">
                    <em title={server.originPath}>{ORIGIN_NAMES[server.origin]}</em>
                    <small>{server.alreadyPresent ? "已存在" : server.transport === "http" ? "HTTP" : "stdio"}</small>
                  </span>
                </label>
              );
            })}
            {servers.length ? null : (
              <p className="mcp-discovery-empty">没有找到可以导入的 MCP。CoilCoil 只看这台机器上 Cursor、Claude、Codex、opencode、Windsurf、VS Code 的配置文件。</p>
            )}
            {result?.emptyOrigins.length ? (
              <div className="mcp-discovery-skipped">
                <strong>扫过但没有可导入内容的来源</strong>
                {result.emptyOrigins.map((origin) => (
                  <span key={`${origin.kind}-${origin.path}`}>
                    <b>{ORIGIN_NAMES[origin.kind]}</b>
                    <small title={origin.path}>{origin.reason}</small>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        )}
        <footer>
          <span>{scanning ? "" : `发现 ${servers.length} 个，其中 ${importable.length} 个可以导入`}</span>
          <div>
            <button type="button" disabled={scanning || importing} onClick={() => setRound((value) => value + 1)}>
              <RefreshCw size={13} />重新扫描
            </button>
            <button className="primary-button" type="button" disabled={scanning || importing || !picked.size} onClick={() => void importPicked()}>
              {importing ? <LoaderCircle className="spin" size={13} /> : null}
              导入选中的 {picked.size || ""}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
