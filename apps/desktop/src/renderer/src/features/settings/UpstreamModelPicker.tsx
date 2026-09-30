import { Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Modal } from "../../ui/dialog";
import { catalogSourceLabel, loadModelCatalog, lookupModelMeta, type ModelCatalogMeta } from "./modelCatalog";
import { Checkbox, TextField } from "../../ui/form";

export interface UpstreamModelOption {
  id: string;
  name?: string;
}

export function UpstreamModelPicker({
  models,
  configuredIds,
  onCancel,
  onConfirm,
}: {
  models: UpstreamModelOption[];
  configuredIds: Set<string>;
  onCancel: () => void;
  onConfirm: (selected: Array<UpstreamModelOption & { meta: ModelCatalogMeta }>) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set([...configuredIds].filter((id) => models.some((model) => model.id === id))));
  const [catalogReady, setCatalogReady] = useState(false);

  useEffect(() => {
    let active = true;
    void loadModelCatalog().finally(() => {
      if (active) setCatalogReady(true);
    });
    return () => { active = false; };
  }, []);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return models;
    return models.filter((model) => `${model.id} ${model.name ?? ""}`.toLowerCase().includes(normalized));
  }, [models, query]);

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectVisible = (): void => {
    setSelected((current) => {
      const next = new Set(current);
      for (const model of filtered) next.add(model.id);
      return next;
    });
  };

  const clearVisible = (): void => {
    setSelected((current) => {
      const next = new Set(current);
      for (const model of filtered) next.delete(model.id);
      return next;
    });
  };

  const confirm = (): void => {
    const chosen = models
      .filter((model) => selected.has(model.id))
      .map((model) => ({ ...model, meta: lookupModelMeta(model.id) }));
    onConfirm(chosen);
  };

  return (
    <Modal open bare onClose={onCancel}>
      <div className="upstream-model-picker" role="dialog" aria-modal="true" aria-labelledby="upstream-model-picker-title">
        <header>
          <div>
            <strong id="upstream-model-picker-title">选择要同步的上游模型</strong>
            <small>共 {models.length} 个上游模型 · 已选 {selected.size}{catalogReady ? "" : " · 参数目录加载中…"}</small>
          </div>
          <button type="button" aria-label="关闭" onClick={onCancel}><X size={14} /></button>
        </header>
        <div className="upstream-model-picker-toolbar">
          <label className="upstream-model-search"><Search size={13} /><TextField look="plain" className="upstream-model-search-input" value={query} placeholder="搜索模型 id 或名称" onChange={(event) => setQuery(event.target.value)} /></label>
          <button type="button" onClick={selectVisible}>全选当前</button>
          <button type="button" onClick={clearVisible}>清空当前</button>
        </div>
        <div className="upstream-model-picker-list">
          {filtered.length ? filtered.map((model) => {
            const configured = configuredIds.has(model.id);
            const meta = catalogReady ? lookupModelMeta(model.id) : undefined;
            return (
              <label key={model.id} className={selected.has(model.id) ? "active" : ""}>
                <Checkbox look="plain" checked={selected.has(model.id)} onChange={() => toggle(model.id)} />
                <span>
                  <strong>{model.name && model.name !== model.id ? model.name : model.id}</strong>
                  <small>{model.id}</small>
                </span>
                <span className="upstream-model-picker-tags">
                  {configured ? <em className="configured">已配置</em> : null}
                  <em>{catalogReady ? catalogSourceLabel(meta ?? { sources: [] }) : "…"}</em>
                </span>
              </label>
            );
          }) : <p className="upstream-model-picker-empty">没有匹配的上游模型。</p>}
        </div>
        <footer>
          <span>仅会把勾选的模型写入本地目录；已配置项保留你现有字段。</span>
          <div>
            <button type="button" onClick={onCancel}>取消</button>
            <button className="primary-button" type="button" disabled={!selected.size} onClick={confirm}>添加所选（{selected.size}）</button>
          </div>
        </footer>
      </div>
    </Modal>
  );
}
