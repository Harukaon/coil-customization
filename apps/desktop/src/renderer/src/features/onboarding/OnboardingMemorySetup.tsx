import { LoaderCircle, Save } from "lucide-react";
import { useEffect, useState } from "react";
import type { MemoryConfigurationSnapshot, MemorySettings } from "@coilcoil/runtime-protocol";
import { toastError, toastSuccess } from "../../ui/toast";
import { Checkbox, TextArea, TextField } from "../../ui/form";

export function OnboardingMemorySetup({ runtimeId, cwd }: { runtimeId?: string; cwd?: string }): React.JSX.Element {
  const [configuration, setConfiguration] = useState<MemoryConfigurationSnapshot>();
  const [settings, setSettings] = useState<MemorySettings>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void window.coilcoil.request<MemoryConfigurationSnapshot>({ type: "get_memory_configuration", cwd }, runtimeId)
      .then((next) => {
        if (cancelled) return;
        setConfiguration(next);
        setSettings(next.settings);
      })
      .catch((caught) => {
        if (!cancelled) toastError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cwd, runtimeId]);

  const update = <K extends keyof MemorySettings>(key: K, value: MemorySettings[K]): void => {
    setSettings((current) => current ? { ...current, [key]: value } : current);
    setSaved(false);
  };

  const save = async (): Promise<void> => {
    if (!configuration || !settings) return;
    setSaving(true);
    setSaved(false);
    try {
      await window.coilcoil.request<MemoryConfigurationSnapshot>({
        type: "save_memory_configuration",
        cwd,
        input: {
          settings,
          globalContent: configuration.global.content,
          projectContent: configuration.project?.content,
        },
      }, runtimeId);
      setSaved(true);
      toastSuccess("记忆配置已保存");
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="onboarding-setup-loading"><LoaderCircle className="spin" size={15} />读取记忆配置…</div>;
  if (!settings || !configuration) return <div className="onboarding-empty-state">暂时无法读取记忆配置，可以之后在「记忆」页面设置。</div>;

  return (
    <div className="onboarding-memory-config">
      <div className="onboarding-memory-toggles">
        <label><Checkbox look="plain" className="onboarding-memory-checkbox" checked={settings.globalEnabled} onChange={(event) => update("globalEnabled", event.target.checked)} /><span>注入全局记忆</span></label>
        <label><Checkbox look="plain" className="onboarding-memory-checkbox" checked={settings.projectEnabled} onChange={(event) => update("projectEnabled", event.target.checked)} /><span>注入项目记忆</span></label>
        <label><Checkbox look="plain" className="onboarding-memory-checkbox" checked={settings.autoSummarize} onChange={(event) => update("autoSummarize", event.target.checked)} /><span>回复后自动整理</span></label>
      </div>
      <div className="onboarding-memory-fields">
        <label><span>全局上限</span><TextField look="plain" className="onboarding-memory-number" type="number" min={100} max={1000000} step={100} value={settings.globalMaxChars} onChange={(event) => update("globalMaxChars", Math.max(100, Number(event.target.value) || 100))} /></label>
        <label><span>索引上限</span><TextField look="plain" className="onboarding-memory-number" type="number" min={100} max={1000000} step={100} value={settings.projectMaxChars} onChange={(event) => update("projectMaxChars", Math.max(100, Number(event.target.value) || 100))} /></label>
        <label><span>整理间隔</span><TextField look="plain" className="onboarding-memory-number" type="number" min={1} max={1000} step={1} value={settings.summarizeEveryTurns} onChange={(event) => update("summarizeEveryTurns", Math.min(1000, Math.max(1, Math.round(Number(event.target.value) || 1))))} /><small>轮</small></label>
      </div>
      <label className="onboarding-memory-rules"><span>生成规则</span><TextArea look="plain" className="onboarding-memory-rules-input" value={settings.generationRules} onChange={(event) => update("generationRules", event.target.value)} spellCheck={false} /></label>
      <div className="onboarding-config-actions">
        <button className="onboarding-inline-save" type="button" disabled={saving} onClick={() => void save()}>
          {saving ? <LoaderCircle className="spin" size={13} /> : <Save size={13} />}
          {saved ? "已保存" : "保存记忆配置"}
        </button>
        <span>{configuration.turnsSinceSummary.toLocaleString()} 轮以来未整理</span>
      </div>
    </div>
  );
}
