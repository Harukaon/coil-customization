import { AlertCircle, Bot, BrainCircuit, CheckCircle2, CircleDashed, GitBranch, History, LoaderCircle, PlugZap, RefreshCw, RotateCcw, Save, Sparkles, Wrench, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  ConfigurableSubagentProfile,
  ContextUsage,
  McpServerRuntimeStatus,
  RuntimeConfiguration,
  RuntimeInspectionSnapshot,
  RuntimeSummaryEvent,
  SessionNamingConfiguration,
  SubagentConfiguration,
  SummarizationModelConfiguration,
  SubagentProfileModels,
  TokenUsage,
} from "@coilcoil/runtime-protocol";
import { summarizeCacheUsage } from "@coilcoil/runtime-protocol";
import { diagnostics } from "../../diagnostics";
import { Modal } from "../../ui/dialog";
import { Select, type SelectOption } from "../../ui/Select";
import { toastError, toastSuccess } from "../../ui/toast";
import { Tooltip } from "../../ui/tooltip";
import { tokenNumber, toolDisplayName } from "./runtimePresentation";
import {
  mcpSectionBadge,
  mcpTogglePlan,
  mcpVisibility,
  mcpVisibilityLabel,
  toggledVisibility,
  type McpVisibilityOverrides,
} from "./mcpPolicy";
import { Checkbox, TextArea } from "../../ui/form";

const kindLabel: Record<RuntimeSummaryEvent["kind"], string> = {
  compaction: "上下文压缩",
  branch_summary: "分支总结",
};

const reasonLabel: Record<NonNullable<RuntimeSummaryEvent["reason"]>, string> = {
  manual: "手动触发",
  threshold: "达到阈值",
  overflow: "溢出恢复",
};

const subagentProfiles: Array<{ id: ConfigurableSubagentProfile; label: string; description: string }> = [
  { id: "explore", label: "Explore", description: "只读搜索与代码梳理" },
  { id: "worker", label: "Worker", description: "编码实现与文件修改" },
  { id: "reviewer", label: "Reviewer", description: "独立代码评审" },
];

const emptySubagentModels = (): SubagentProfileModels => ({ explore: "", worker: "", reviewer: "" });

function percent(value: number): string {
  return new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 }).format(value);
}

function SummaryStatus({ event }: { event: RuntimeSummaryEvent }): React.JSX.Element {
  if (event.status === "running") return <><RefreshCw className="spin" size={12} /><span>处理中</span></>;
  if (event.status === "failed") return <><AlertCircle size={12} /><span>失败</span></>;
  if (event.status === "aborted") return <><CircleDashed size={12} /><span>已取消</span></>;
  return <><CheckCircle2 size={12} /><span>已完成</span></>;
}

function SummaryCard({ event }: { event: RuntimeSummaryEvent }): React.JSX.Element {
  const released = event.tokensBefore !== undefined && event.estimatedTokensAfter !== undefined
    ? Math.max(0, event.tokensBefore - event.estimatedTokensAfter)
    : undefined;
  return (
    <details className={`runtime-summary-card ${event.active ? "active" : "historical"}`} open={event.status === "running"}>
      <summary>
        <span className="runtime-summary-kind">{event.kind === "branch_summary" ? <GitBranch size={13} /> : <History size={13} />}{kindLabel[event.kind]}</span>
        <span className={`runtime-summary-status ${event.status}`}><SummaryStatus event={event} /></span>
        <small>{event.active ? "当前上下文" : "历史分支"}</small>
      </summary>
      <div className="runtime-summary-body">
        <div className="runtime-summary-meta">
          <span>{new Date(event.timestamp).toLocaleString("zh-CN", { hour12: false })}</span>
          {event.reason ? <span>{reasonLabel[event.reason]}</span> : null}
          {event.retryAttempt ? <span>重试 {event.retryAttempt}/{event.retryMaxAttempts ?? "?"}</span> : null}
        </div>
        {event.tokensBefore !== undefined || event.estimatedTokensAfter !== undefined ? (
          <dl className="runtime-summary-tokens">
            {event.tokensBefore !== undefined ? <div><dt>压缩前</dt><dd>{tokenNumber(event.tokensBefore)}</dd></div> : null}
            {event.estimatedTokensAfter !== undefined ? <div><dt>压缩后</dt><dd>{tokenNumber(event.estimatedTokensAfter)}</dd></div> : null}
            {released !== undefined ? <div><dt>释放</dt><dd>{tokenNumber(released)}</dd></div> : null}
          </dl>
        ) : null}
        {event.summary ? <pre className="runtime-summary-text">{event.summary}</pre> : null}
        {event.usage ? <p className="runtime-summary-usage">总结请求：输入 {tokenNumber(event.usage.input)} · 输出 {tokenNumber(event.usage.output)}{event.usage.cacheRead ? ` · 缓存 ${tokenNumber(event.usage.cacheRead)}` : ""}</p> : null}
        {event.readFiles?.length ? <div className="runtime-summary-files"><strong>读取文件</strong>{event.readFiles.map((path) => <code key={`read-${path}`}>{path}</code>)}</div> : null}
        {event.modifiedFiles?.length ? <div className="runtime-summary-files"><strong>修改文件</strong>{event.modifiedFiles.map((path) => <code key={`modified-${path}`}>{path}</code>)}</div> : null}
        {event.error ? <p className="runtime-summary-error">{event.error}</p> : null}
      </div>
    </details>
  );
}

function RuntimeSection({
  title,
  icon,
  badge,
  children,
  open = false,
}: {
  title: string;
  icon: React.ReactNode;
  badge?: React.ReactNode;
  children: React.ReactNode;
  open?: boolean;
}): React.JSX.Element {
  return (
    <details className="runtime-section" open={open}>
      <summary><span>{icon}<strong>{title}</strong></span>{badge ? <small>{badge}</small> : null}</summary>
      <div className="runtime-section-body">{children}</div>
    </details>
  );
}

export function RuntimePanel({
  inspection,
  contextUsage,
  tokenUsage,
  runtimeId,
  cwd,
  configuration,
}: {
  inspection?: RuntimeInspectionSnapshot;
  contextUsage?: ContextUsage;
  tokenUsage?: TokenUsage;
  runtimeId?: string;
  cwd?: string;
  configuration?: RuntimeConfiguration;
}): React.JSX.Element {
  const [promptOpen, setPromptOpen] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptDraft, setPromptDraft] = useState(inspection?.effectiveSystemPrompt ?? "");
  const [busyAction, setBusyAction] = useState<string>();
  const [mcpOverrides, setMcpOverrides] = useState<McpVisibilityOverrides>({});
  const [subagentModels, setSubagentModels] = useState<SubagentProfileModels>(inspection?.subagent?.models ?? emptySubagentModels());
  const [namingModel, setNamingModel] = useState(inspection?.sessionNaming?.model ?? "");
  const [namingSaving, setNamingSaving] = useState(false);
  const [summaryModel, setSummaryModel] = useState(inspection?.summarizationModel?.model ?? "");
  const [summarySaving, setSummarySaving] = useState(false);
  const summaryModelUnavailable = inspection?.summarizationModel?.unavailable === true;
  const [subagentSaving, setSubagentSaving] = useState(false);
  const canEditSystemPrompt = inspection?.capabilities.editSystemPrompt !== false;
  const summaries = inspection?.summaryEvents ?? [];
  const activeTools = useMemo(() => inspection?.tools.filter((tool) => tool.active) ?? [], [inspection?.tools]);
  const availableModels = useMemo(() => configuration?.models.filter((model) => model.configured) ?? [], [configuration?.models]);
  const configuredSubagentCount = Object.values(subagentModels).filter(Boolean).length;
  const cumulativeCache = useMemo(
    () => summarizeCacheUsage(tokenUsage?.input, tokenUsage?.cacheRead, tokenUsage?.cacheWrite),
    [tokenUsage?.cacheRead, tokenUsage?.cacheWrite, tokenUsage?.input],
  );
  const tokenMetrics = useMemo(() => [
    cumulativeCache.promptTokens ? ["累计输入", tokenNumber(cumulativeCache.promptTokens)] : undefined,
    tokenUsage?.output ? ["累计输出", tokenNumber(tokenUsage.output)] : undefined,
    tokenUsage?.cacheRead ? ["缓存读取", tokenNumber(tokenUsage.cacheRead)] : undefined,
    tokenUsage?.cacheWrite ? ["缓存写入", tokenNumber(tokenUsage.cacheWrite)] : undefined,
    inspection?.cacheHitRate !== undefined ? ["最近命中", percent(inspection.cacheHitRate)] : undefined,
  ].filter((item): item is string[] => Boolean(item)), [cumulativeCache.promptTokens, inspection?.cacheHitRate, tokenUsage]);

  useEffect(() => {
    if (!editingPrompt) setPromptDraft(inspection?.effectiveSystemPrompt ?? "");
  }, [editingPrompt, inspection?.effectiveSystemPrompt]);

  useEffect(() => {
    if (!canEditSystemPrompt) setEditingPrompt(false);
  }, [canEditSystemPrompt]);

  // 总结模型是全局配置：另一个窗口改了，这边该跟着变，而不是拿着挂载时的那份不放。
  useEffect(() => {
    setSummaryModel(inspection?.summarizationModel?.model ?? "");
  }, [inspection?.summarizationModel?.model]);

  useEffect(() => {
    setSubagentModels(inspection?.subagent?.models ?? emptySubagentModels());
  }, [
    inspection?.subagent?.models.explore,
    inspection?.subagent?.models.reviewer,
    inspection?.subagent?.models.worker,
  ]);

  // Once the runtime reports a server in the state we optimistically rendered,
  // drop the override so the panel follows the runtime again.
  useEffect(() => {
    const servers = inspection?.mcp?.servers;
    if (!servers?.length) return;
    setMcpOverrides((current) => {
      const pending = Object.entries(current).filter(([name, visibility]) => {
        const server = servers.find((candidate) => candidate.name === name);
        return server ? mcpVisibility(server) !== visibility : true;
      });
      return pending.length === Object.keys(current).length ? current : Object.fromEntries(pending);
    });
  }, [inspection?.mcp?.servers]);

  const request = async <T,>(action: string, command: Parameters<typeof window.coilcoil.request>[0]): Promise<T | undefined> => {
    setBusyAction(action);
    try {
      return await window.coilcoil.request<T>(command, runtimeId);
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
      return undefined;
    } finally {
      setBusyAction(undefined);
    }
  };

  const saveSystemPrompt = async (): Promise<void> => {
    const result = await request<RuntimeInspectionSnapshot>("system-prompt", { type: "set_session_system_prompt", prompt: promptDraft });
    if (!result) return;
    setEditingPrompt(false);
    setPromptOpen(false);
    toastSuccess("当前会话的 System Prompt 已更新");
  };

  const restoreSystemPrompt = async (): Promise<void> => {
    const result = await request<RuntimeInspectionSnapshot>("system-prompt", { type: "set_session_system_prompt" });
    if (!result) return;
    setEditingPrompt(false);
    setPromptOpen(false);
    toastSuccess("已恢复当前会话的默认 System Prompt");
  };

  const saveSubagentModels = async (): Promise<void> => {
    setSubagentSaving(true);
    try {
      const result = await request<SubagentConfiguration>("subagent-models", {
        type: "save_subagent_configuration",
        input: {
          models: {
            explore: subagentModels.explore.trim(),
            worker: subagentModels.worker.trim(),
            reviewer: subagentModels.reviewer.trim(),
          },
        },
      });
      if (!result) return;
      setSubagentModels(result.models);
      const configuredCount = Object.values(result.models).filter(Boolean).length;
      toastSuccess(configuredCount > 0
        ? `已保存子 Agent 模型配置（${configuredCount}/3）`
        : "已清除子 Agent 模型配置，三个 profile 都将不可用");
    } finally {
      setSubagentSaving(false);
    }
  };

  const saveNamingModel = async (): Promise<void> => {
    setNamingSaving(true);
    try {
      const result = await request<SessionNamingConfiguration>("session-naming", {
        type: "save_session_naming_configuration",
        input: { model: namingModel.trim() },
      });
      if (!result) return;
      setNamingModel(result.model);
      toastSuccess(result.model ? `会话命名将使用 ${result.model}` : "会话命名已改回跟随会话当前模型");
    } finally {
      setNamingSaving(false);
    }
  };

  const saveSummaryModel = async (): Promise<void> => {
    setSummarySaving(true);
    try {
      const result = await request<SummarizationModelConfiguration>("summarization-model", {
        type: "save_summarization_model_configuration",
        input: { model: summaryModel.trim() },
      });
      if (!result) return;
      setSummaryModel(result.model);
      toastSuccess(result.model
        ? (result.unavailable
          ? `已保存 ${result.model}，但它当前不可用，总结暂时还用会话模型`
          : `上下文总结将使用 ${result.model}`)
        : "上下文总结已改回跟随会话当前模型");
    } finally {
      setSummarySaving(false);
    }
  };

  const setSkillEnabled = async (filePath: string, enabled: boolean): Promise<void> => {
    await request(`skill:${filePath}`, { type: "set_session_skill_enabled", filePath, enabled });
  };

  // 全局设置（不是会话级）：保存后主进程会广播 configuration_updated，
  // 上层跟着刷新，所以这里不用自己回写 configuration。
  const setToolPurposeAuditEnabled = async (enabled: boolean): Promise<void> => {
    const action = "tool-purpose";
    setBusyAction(action);
    try {
      await window.coilcoil.request<RuntimeConfiguration>({ type: "set_tool_purpose_audit_enabled", enabled }, runtimeId);
      toastSuccess(enabled ? "已开启工具调用意图记录。" : "已关闭工具调用意图强制校验。");
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyAction(undefined);
    }
  };

  const toggleMcpVisibility = async (server: McpServerRuntimeStatus): Promise<void> => {
    const next = toggledVisibility(mcpVisibility(server, mcpOverrides));
    const action = `mcp:${server.name}`;
    // Show the new state immediately: the workspace write below is durable, and
    // the session sync may be slow or unavailable while the extension boots.
    setMcpOverrides((current) => ({ ...current, [server.name]: next }));
    setBusyAction(action);
    try {
      for (const step of mcpTogglePlan(server, next)) {
        if (step.kind === "workspace") {
          if (!cwd) throw new Error("请先打开一个项目，再调整 MCP 可见性。");
          await window.coilcoil.request({
            type: "set_mcp_server_enabled",
            name: step.name,
            enabled: step.enabled,
            cwd,
          }, runtimeId);
        } else {
          // Only syncs an already-running Pi session. A session that has not
          // started yet, or an extension still booting, picks the workspace
          // setting up on its own — so this must never fail the toggle.
          await window.coilcoil.request({
            type: "set_session_mcp_server_enabled",
            name: step.name,
            enabled: step.enabled,
          }, runtimeId).catch(() => undefined);
        }
      }
      toastSuccess(next === "visible" ? `${server.name} 已展示给 Agent` : `${server.name} 已对 Agent 停用`);
    } catch (caught) {
      setMcpOverrides((current) => {
        const reverted = { ...current };
        delete reverted[server.name];
        return reverted;
      });
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyAction(undefined);
    }
  };

  return (
    <div className="runtime-panel">
      <section className="runtime-overview">
        <header>
          <strong>当前运行时</strong>
          <small>会话版本 {inspection?.sessionRevision ?? 0}</small>
          {/* 遇到说不清的问题时，这里是唯一能把现场交出去的入口。 */}
          <button
            className="runtime-log-button"
            type="button"
            title="三个进程的运行日志都写在这里，出问题时把它发给开发者"
            onClick={() => {
              diagnostics.flush();
              void window.coilcoil.revealDiagnostics().catch((caught) => {
                toastError(caught instanceof Error ? caught.message : String(caught));
              });
            }}
          >
            打开日志
          </button>
        </header>
        <div className="runtime-context-card">
          {contextUsage ? <span className="runtime-progress"><i style={{ width: `${Math.max(0, Math.min(100, contextUsage.percent ?? 0))}%` }} /></span> : null}
          <div className="runtime-context-total">
            <strong>{contextUsage?.tokens === null ? "正在计算" : tokenNumber(contextUsage?.tokens ?? inspection?.estimates.total ?? 0)}</strong>
            <small>{contextUsage ? `/ ${tokenNumber(contextUsage.contextWindow)} Token` : "当前上下文估算"}</small>
          </div>
          {tokenMetrics.length ? <dl className="runtime-metric-strip">{tokenMetrics.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : null}
          {inspection?.tokenBreakdown ? (
            <>
              <dl className="runtime-token-grid">
                <div><dt>用户提示词（当前）</dt><dd>{tokenNumber(inspection.tokenBreakdown.userPrompt)}</dd></div>
                <div><dt>工具定义注入</dt><dd>{tokenNumber(inspection.tokenBreakdown.toolDefinitions)}</dd></div>
                <div><dt>MCP 定义注入</dt><dd>{tokenNumber(inspection.tokenBreakdown.mcpDefinitions)}</dd></div>
                <div><dt>模型输出（累计）</dt><dd>{tokenNumber(tokenUsage?.output ?? 0)}</dd></div>
              </dl>
              <p className="runtime-estimate-note">定义注入按当前启用的 Context.tools 统计；工具结果另计入当前上下文。模型输出来自实际 usage。</p>
            </>
          ) : null}
          {inspection?.estimates.systemPrompt || inspection?.estimates.toolDefinitions || inspection?.estimates.messages ? (
            <p className="runtime-estimate-note">估算：{[
              inspection.estimates.systemPrompt ? `系统提示词 ${tokenNumber(inspection.estimates.systemPrompt)}` : undefined,
              inspection.estimates.toolDefinitions ? `工具定义 ${tokenNumber(inspection.estimates.toolDefinitions)}` : undefined,
              inspection.estimates.messages ? `消息 ${tokenNumber(inspection.estimates.messages)}` : undefined,
            ].filter(Boolean).join(" · ")} Token</p>
          ) : null}
        </div>
      </section>

      <button className="runtime-entry-card" type="button" onClick={() => setPromptOpen(true)}>
        <span><BrainCircuit size={14} /><strong>系统提示词</strong></span>
        <small>{inspection?.systemPromptOverride ? "当前会话已修改" : inspection?.estimates.systemPrompt ? `${tokenNumber(inspection.estimates.systemPrompt)} Token` : "等待捕获"}</small>
      </button>

      <RuntimeSection
        title="子 Agent 模型"
        icon={<Bot size={14} />}
        badge={configuredSubagentCount ? `${configuredSubagentCount}/3 已配置` : "3 个都未配置 · 不可用"}
      >
        <div className="runtime-subagent-models">
          {subagentProfiles.map((profile) => {
            const selected = subagentModels[profile.id];
            const selectedAvailable = availableModels.some((model) => `${model.provider}/${model.id}` === selected);
            const modelOptions: SelectOption[] = [
              { value: "", label: "未配置（此子 Agent 不可用）", detail: "不配置就不给派发，而不是悄悄用主会话模型" },
              ...(selected && !selectedAvailable
                ? [{ value: selected, label: selected, detail: "当前不可用", disabled: true }]
                : []),
              ...availableModels.map((model) => ({
                value: `${model.provider}/${model.id}`,
                label: model.name,
                detail: `${model.providerName} · ${model.provider}/${model.id}`,
                keywords: `${model.providerName} ${model.provider} ${model.id}`,
              })),
            ];
            return (
              <label className={`runtime-subagent-model-row ${selected ? "" : "unconfigured"}`} key={profile.id}>
                <span>
                  <strong>{selected ? null : <XCircle className="runtime-subagent-unavailable" size={13} />}{profile.label}</strong>
                  <small>{selected ? profile.description : "未配置模型，派发会被拒绝"}</small>
                </span>
                <Select
                  value={selected}
                  options={modelOptions}
                  onChange={(model) => setSubagentModels((current) => ({ ...current, [profile.id]: model }))}
                  ariaLabel={`${profile.label} 默认模型`}
                  className="runtime-subagent-select"
                  searchable
                />
              </label>
            );
          })}
        </div>
        <div className="runtime-actions">
          <button
            className="primary"
            type="button"
            disabled={subagentSaving || !runtimeId}
            onClick={() => { void saveSubagentModels(); }}
          >
            {subagentSaving ? <LoaderCircle className="spin" size={12} /> : <Save size={12} />}保存三个配置
          </button>
        </div>
        <p className="runtime-section-footnote">三个 profile 独立配置。没配模型的那一项不可用：Agent 派发它会直接收到「未配置，请改用其他方式」的错误，而不是悄悄改用主会话模型跑一遍。</p>
      </RuntimeSection>

      <RuntimeSection
        title="会话命名"
        icon={<Bot size={14} />}
        badge={namingModel ? namingModel : "跟随会话模型"}
      >
        <p className="runtime-section-footnote">
          第一轮结束后单独问一次模型，给这段对话起个标题。以前标题就是第一句话截断，
          侧栏里一排「继续」「帮我看一下」，根本找不到人。不配置就用会话当前的模型；
          想让它跑在便宜模型上就在这里指定。
        </p>
        <label className="runtime-subagent-model-row">
          <span><strong>命名用的模型</strong><small>只发一次很小的请求</small></span>
          <Select
            value={namingModel}
            options={[
              { value: "", label: "跟随会话当前模型", detail: "不额外指定" },
              ...(namingModel && !availableModels.some((model) => `${model.provider}/${model.id}` === namingModel)
                ? [{ value: namingModel, label: namingModel, detail: "当前不可用", disabled: true }]
                : []),
              ...availableModels.map((model) => ({
                value: `${model.provider}/${model.id}`,
                label: model.name,
                detail: `${model.providerName} · ${model.provider}/${model.id}`,
                keywords: `${model.providerName} ${model.provider} ${model.id}`,
              })),
            ]}
            onChange={setNamingModel}
            ariaLabel="会话命名使用的模型"
            className="runtime-subagent-select"
            searchable
          />
        </label>
        <div className="runtime-actions">
          <button
            className="primary"
            type="button"
            disabled={namingSaving || !runtimeId}
            onClick={() => { void saveNamingModel(); }}
          >
            {namingSaving ? <LoaderCircle className="spin" size={12} /> : <Save size={12} />}保存
          </button>
        </div>
      </RuntimeSection>

      <RuntimeSection
        title="上下文总结"
        icon={<History size={14} />}
        badge={summaryModel ? (summaryModelUnavailable ? `${summaryModel}（不可用）` : summaryModel) : "跟随会话模型"}
      >
        <p className="runtime-section-footnote">
          上下文压缩和回溯时的分支总结，都是单独的一发请求，而且把大半个会话都发了出去。
          不配就跟会话当前的模型，主对话跑在贵模型上时，这几发也一样贵；指定一个便宜模型只换总结，
          不影响对话本身。模型窗口太小的话这一发可能发不出去，选的时候留意。
        </p>
        {summaryModelUnavailable ? (
          <p className="runtime-section-footnote">
            配的 <strong>{summaryModel}</strong> 现在找不到（模型被删、或者凭证没了），总结已经回退到会话模型在跑。
            回退而不是报错，是因为压缩一旦停下来，上下文就会一路涨到溢出。
          </p>
        ) : null}
        <label className="runtime-subagent-model-row">
          <span><strong>总结用的模型</strong><small>压缩与分支总结共用</small></span>
          <Select
            value={summaryModel}
            options={[
              { value: "", label: "跟随会话当前模型", detail: "不额外指定" },
              ...(summaryModel && !availableModels.some((model) => `${model.provider}/${model.id}` === summaryModel)
                ? [{ value: summaryModel, label: summaryModel, detail: "当前不可用", disabled: true }]
                : []),
              ...availableModels.map((model) => ({
                value: `${model.provider}/${model.id}`,
                label: model.name,
                // 窗口大小得看得见：总结要把大半个会话塞进去，选了个小窗口模型就是白配。
                detail: model.contextWindow
                  ? `${model.providerName} · ${tokenNumber(model.contextWindow)} 窗口`
                  : `${model.providerName} · ${model.provider}/${model.id}`,
                keywords: `${model.providerName} ${model.provider} ${model.id}`,
              })),
            ]}
            onChange={setSummaryModel}
            ariaLabel="上下文总结使用的模型"
            className="runtime-subagent-select"
            searchable
          />
        </label>
        <div className="runtime-actions">
          <button
            className="primary"
            type="button"
            disabled={summarySaving || !runtimeId}
            onClick={() => { void saveSummaryModel(); }}
          >
            {summarySaving ? <LoaderCircle className="spin" size={12} /> : <Save size={12} />}保存
          </button>
        </div>
      </RuntimeSection>

      <RuntimeSection title="工具" icon={<Wrench size={14} />} badge={inspection?.tools.length ? `${activeTools.length}/${inspection.tools.length} 启用` : undefined}>
        <div className="runtime-toggle-list">
          <label title="每次工具调用都要求填写简短的直接目的（1 至 100 字，单行），并记在会话里。关闭后不再要求，也不再记录。">
            <span>
              <strong>强制填写调用目的</strong>
              <small>写进工具 schema 并注入系统提示词；不合规的调用会被拦下</small>
            </span>
            <Checkbox look="plain" className="runtime-toggle-input"
              aria-label="强制工具调用填写目的"
              checked={configuration?.toolPurposeAuditEnabled ?? true}
              disabled={busyAction === "tool-purpose" || !runtimeId}
              onChange={(event) => { void setToolPurposeAuditEnabled(event.target.checked); }}
            />
          </label>
        </div>
        <p className="runtime-section-footnote">打开时，每次工具调用都要先说明「这次要干什么」，记在会话里供事后查证；关闭则模型可以不带目的直接调。这是个全局设置，和当前会话无关。</p>
        {inspection?.tools.length ? <div className="runtime-chip-grid">{inspection.tools.map((tool) => (
          <Tooltip content={tool.description} key={tool.name}>
            <div className={`runtime-chip ${tool.active ? "active" : "inactive"}`}>
              <strong>{toolDisplayName(tool.name)}</strong>
              <small>{tool.name} · {tokenNumber(tool.estimatedTokens)} Token</small>
            </div>
          </Tooltip>
        ))}</div> : <p className="runtime-muted">尚未取得当前会话的工具定义。</p>}
      </RuntimeSection>

      <RuntimeSection title="Skills" icon={<Sparkles size={14} />} badge={inspection?.skills.length ? `${inspection.skills.filter((skill) => skill.sessionEnabled).length}/${inspection.skills.length} 可用` : undefined}>
        {inspection?.skills.length ? <div className="runtime-chip-grid">{inspection.skills.map((skill) => (
          <Tooltip content={skill.description} key={skill.filePath}>
            <button
              className={`runtime-chip toggle ${skill.sessionEnabled ? "active" : "inactive"}`}
              disabled={!skill.globallyEnabled || busyAction === `skill:${skill.filePath}`}
              type="button"
              onClick={() => { void setSkillEnabled(skill.filePath, !skill.sessionEnabled); }}
            >
              <strong>{skill.name}</strong>
              <small>{!skill.globallyEnabled ? "设置中已停用" : skill.readInSession ? "已读取" : skill.sessionEnabled ? "已提供给 Agent" : "当前会话停用"}</small>
            </button>
          </Tooltip>
        ))}</div> : <p className="runtime-muted">当前工作区没有发现可用 Skill。</p>}
        <p className="runtime-section-footnote">设置页控制工作区是否启用；这里的开关只影响当前会话。</p>
      </RuntimeSection>

      <RuntimeSection title="MCP" icon={<PlugZap size={14} />} badge={mcpSectionBadge(inspection?.mcp?.servers, mcpOverrides)}>
        {inspection?.mcp?.servers.length ? <div className="runtime-chip-grid">{inspection.mcp.servers.map((server) => {
          const visibility = mcpVisibility(server, mcpOverrides);
          return (
            <button
              key={server.name}
              className={`runtime-chip toggle ${visibility === "visible" ? "active" : "inactive"}`}
              type="button"
              disabled={busyAction === `mcp:${server.name}`}
              aria-pressed={visibility === "visible"}
              onClick={() => { void toggleMcpVisibility(server); }}
            >
              <strong>{server.name}</strong>
              <small>{mcpVisibilityLabel(visibility, server.toolCount)}</small>
            </button>
          );
        })}</div> : <p className="runtime-muted">{inspection?.mcp?.diagnostic || "当前工作区没有 MCP Server。"}</p>}
        <p className="runtime-section-footnote">只有「展示给 Agent」的 MCP，其工具才会出现在 Agent 面前；停用即永不展示。</p>
      </RuntimeSection>

      <RuntimeSection title="项目记忆" icon={<Sparkles size={14} />} badge={inspection?.memory ? ({ idle: "就绪", running: "整理中", busy: "正忙", succeeded: "已完成", failed: "失败", disabled: "已停用" }[inspection.memory.state]) : undefined} open={inspection?.memory?.state === "running" || inspection?.memory?.state === "failed"}>
        {inspection?.memory ? <div className="runtime-memory-card">
          <p className="runtime-section-footnote">这是工作区级记忆；切换或回溯会话不会回滚磁盘上的记忆文件。</p>
          {inspection.memory.message ? <p>{inspection.memory.message}</p> : null}
          {inspection.memory.error ? <p className="runtime-summary-error">{inspection.memory.error}</p> : null}
          <dl>
            {inspection.memory.memoryFile ? <div><dt>记忆文件</dt><dd title={inspection.memory.memoryFile}>{inspection.memory.memoryFile}</dd></div> : null}
            {inspection.memory.estimatedTokens !== undefined ? <div><dt>内容体积</dt><dd>估算 {tokenNumber(inspection.memory.estimatedTokens)} Token</dd></div> : null}
            {inspection.memory.injected ? <div><dt>当前会话</dt><dd>已注入</dd></div> : null}
            {inspection.memory.processedSessions.length ? <div><dt>最近处理</dt><dd>{inspection.memory.processedSessions.length} 个会话</dd></div> : null}
            {inspection.memory.durationMs !== undefined ? <div><dt>耗时</dt><dd>{(inspection.memory.durationMs / 1000).toFixed(1)} 秒</dd></div> : null}
            {inspection.memory.updatedAt ? <div><dt>最近更新</dt><dd>{new Date(inspection.memory.updatedAt).toLocaleString("zh-CN", { hour12: false })}</dd></div> : null}
          </dl>
          {inspection.memory.processedSessions.length ? <div className="runtime-summary-files"><strong>已整理会话</strong>{inspection.memory.processedSessions.map((path) => <code key={path} title={path}>{path.split(/[\\/]/).at(-1) || path}</code>)}</div> : null}
          {inspection.memory.content ? <pre className="runtime-memory-content">{inspection.memory.content}</pre> : null}
          <div className="runtime-actions"><button className="primary" type="button" disabled={!runtimeId || inspection.memory.state === "running" || busyAction === "memory"} onClick={() => { void request("memory", { type: "run_memory_now" }); }}><RefreshCw className={inspection.memory.state === "running" ? "spin" : ""} size={12} />立即整理</button></div>
        </div> : <p className="runtime-muted">Memory 扩展正在初始化。输入 <code>/memory</code> 或点击这里后，运行状态会实时显示。</p>}
      </RuntimeSection>

      <section className="runtime-summaries">
        <header><strong>Pi 总结事件</strong>{summaries.length ? <small>{summaries.filter((event) => event.active).length} 个当前生效</small> : null}</header>
        {summaries.length ? summaries.slice().reverse().map((event) => <SummaryCard key={event.id} event={event} />) : (
          <div className="runtime-summary-empty"><History size={18} /><p>当前会话尚未发生上下文压缩或分支总结。</p></div>
        )}
      </section>

      <Modal
        open={promptOpen}
        title="当前会话的系统提示词"
        description={canEditSystemPrompt
          ? "查看真正生效的 System Prompt；修改只影响当前会话，并可能降低提示缓存命中率。"
          : "Unrestricted 模式使用固定的 System Prompt，当前会话中仅可查看。"}
        size="lg"
        onClose={() => { setPromptOpen(false); setEditingPrompt(false); }}
        footer={canEditSystemPrompt ? <>
          {inspection?.systemPromptOverride ? <button className="coil-modal-button" type="button" disabled={busyAction === "system-prompt"} onClick={() => { void restoreSystemPrompt(); }}><RotateCcw size={12} /> 恢复默认</button> : null}
          {editingPrompt ? <button className="coil-modal-button" type="button" onClick={() => setEditingPrompt(false)}>取消编辑</button> : null}
          {editingPrompt ? <button className="coil-modal-button primary" type="button" disabled={busyAction === "system-prompt" || !promptDraft.trim()} onClick={() => { void saveSystemPrompt(); }}><Save size={12} /> 保存</button> : <button className="coil-modal-button primary" type="button" disabled={!inspection?.effectiveSystemPrompt} onClick={() => setEditingPrompt(true)}>编辑当前会话</button>}
        </> : undefined}
      >
        <div className="runtime-prompt-modal">
          {inspection?.effectiveSystemPrompt ? editingPrompt
            ? <TextArea look="plain" className="runtime-prompt-textarea" value={promptDraft} onChange={(event) => setPromptDraft(event.currentTarget.value)} spellCheck={false} />
            : <pre>{inspection.effectiveSystemPrompt}</pre>
          : <p className="runtime-muted">发送下一条消息后会捕获本次请求真正生效的 System Prompt。</p>}
        </div>
      </Modal>
    </div>
  );
}
