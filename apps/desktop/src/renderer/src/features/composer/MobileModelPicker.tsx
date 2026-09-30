import { Check, ChevronLeft, ChevronRight, Search, Settings, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { ModelOption, RuntimeConfiguration, SessionSnapshot, ThinkingLevel } from "@coilcoil/runtime-protocol";
import { TextField } from "../../ui/form";

/**
 * The phone's model picker, written for the phone.
 *
 * It shares nothing with the desktop popover but the data. Reusing that markup
 * meant every layout rule here was a fight with one written for a bubble
 * anchored to a button, and the second level kept losing its scrollbar to a
 * height that resolved to "as tall as the content".
 *
 * Two levels are kept because there is genuinely too much for one screen:
 * parameters first, the model list behind its own row. Each level is a sheet
 * whose scroll area has an explicit maximum height, so scrolling never depends
 * on a flex height resolving the way it was hoped to.
 */

const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

export function MobileModelPicker({
  configuration,
  currentModel,
  currentThinkingLevel,
  currentFast,
  busy,
  thinkingLevels,
  fastAvailable,
  activeModel,
  onClose,
  onSelect,
  onConfigureOptions,
  onFastChange,
  onOpenSettings,
}: {
  configuration?: RuntimeConfiguration;
  currentModel?: SessionSnapshot["model"];
  currentThinkingLevel: ThinkingLevel;
  currentFast: boolean;
  busy: boolean;
  thinkingLevels: ThinkingLevel[];
  fastAvailable: boolean;
  activeModel?: ModelOption;
  onClose: () => void;
  onSelect: (model: ModelOption) => void;
  onConfigureOptions?: (model: ModelOption, thinkingLevel: ThinkingLevel) => Promise<void>;
  onFastChange?: (enabled: boolean) => Promise<void>;
  onOpenSettings: () => void;
}): React.JSX.Element {
  const [search, setSearch] = useState("");
  const [listOpen, setListOpen] = useState(false);

  const hasParameters = thinkingLevels.length > 0 || fastAvailable;
  // With nothing to configure the parameter level would be an empty screen in
  // the way, so the list is the only level.
  const showList = listOpen || !hasParameters;

  useEffect(() => {
    // Closing and reopening should start at the top level again.
    if (!showList) setSearch("");
  }, [showList]);

  const groups = useMemo(() => {
    const query = search.trim().toLowerCase();
    const grouped = new Map<string, { name: string; models: ModelOption[] }>();
    for (const model of configuration?.models ?? []) {
      if (!model.configured) continue;
      if (query && !`${model.providerName} ${model.provider} ${model.name} ${model.id}`.toLowerCase().includes(query)) continue;
      const group = grouped.get(model.provider) ?? { name: model.providerName, models: [] };
      group.models.push(model);
      grouped.set(model.provider, group);
    }
    return [...grouped.entries()];
  }, [configuration, search]);

  const dismiss = (): void => {
    setListOpen(false);
    onClose();
  };

  return createPortal(
    <div className="mmp-backdrop" role="presentation" onClick={dismiss}>
      <div className="mmp-sheet" role="dialog" aria-label={showList ? "选择模型" : "模型与参数"} onClick={(event) => event.stopPropagation()}>
        <header className="mmp-head">
          {showList && hasParameters ? (
            <button className="mmp-icon" type="button" aria-label="返回" onClick={() => setListOpen(false)}><ChevronLeft size={18} /></button>
          ) : null}
          <strong>{showList ? "选择模型" : "模型与参数"}</strong>
          <button className="mmp-icon" type="button" aria-label="关闭" onClick={dismiss}><X size={17} /></button>
        </header>

        {showList ? (
          <>
            <div className="mmp-search">
              <Search size={15} />
              <TextField look="plain" className="mmp-search-input"
                value={search}
                placeholder="搜索模型名称或 ID"
                spellCheck={false}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <div className="mmp-scroll">
              {groups.map(([provider, group]) => (
                <section className="mmp-group" key={provider}>
                  <h3>{group.name}</h3>
                  {group.models.map((model) => {
                    const active = currentModel?.provider === model.provider && currentModel.id === model.id;
                    return (
                      <button
                        className={`mmp-option ${active ? "active" : ""}`}
                        type="button"
                        key={`${model.provider}/${model.id}`}
                        disabled={busy}
                        onClick={() => { setListOpen(false); onSelect(model); onClose(); }}
                      >
                        <span><strong>{model.name}</strong><small>{model.id}</small></span>
                        {active ? <Check size={16} /> : null}
                      </button>
                    );
                  })}
                </section>
              ))}
              {!groups.length ? (
                <p className="mmp-empty">{configuration?.configuredProviders.length ? "没有匹配的模型" : "尚未配置模型服务商"}</p>
              ) : null}
            </div>
          </>
        ) : (
          <div className="mmp-scroll">
            {thinkingLevels.length ? (
              <section className="mmp-group">
                <h3>Thinking</h3>
                <div className="mmp-chips">
                  {thinkingLevels.map((level) => (
                    <button
                      className={`mmp-chip ${currentThinkingLevel === level ? "active" : ""}`}
                      type="button"
                      key={level}
                      disabled={busy || !activeModel || !onConfigureOptions}
                      onClick={() => activeModel && onConfigureOptions ? void onConfigureOptions(activeModel, level) : undefined}
                    >
                      {THINKING_LABELS[level]}
                      {currentThinkingLevel === level ? <Check size={14} /> : null}
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            {fastAvailable ? (
              <button
                className="mmp-row"
                type="button"
                aria-pressed={currentFast}
                disabled={busy}
                onClick={() => onFastChange ? void onFastChange(!currentFast) : undefined}
              >
                <span><strong>Fast</strong><small>Priority service</small></span>
                <i className={`mmp-toggle ${currentFast ? "active" : ""}`} aria-hidden="true"><b /></i>
              </button>
            ) : null}

            <button className="mmp-row" type="button" onClick={() => setListOpen(true)}>
              <span><strong>{currentModel?.name ?? "选择模型"}</strong><small>模型</small></span>
              <ChevronRight size={18} />
            </button>

            <button className="mmp-row" type="button" onClick={() => { dismiss(); onOpenSettings(); }}>
              <span><strong>模型与服务商设置</strong></span>
              <Settings size={17} />
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
