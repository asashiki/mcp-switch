import { useEffect, useRef, useState } from "react";
import type { Agent } from "@/types/api";

/**
 * 单个技能的「对哪些 agent 可见」下拉。
 * - 默认所有 agent 都打勾 = 全部可见
 * - 取消任一勾 → 调用 onChange 推送变更
 * - 视觉上：全部可见 = 安静的灰底；部分可见 = accent-soft 高亮
 */
export default function VisibilityDropdown({
  agents, visibleIds, onChange, disabled,
}: {
  agents: Agent[];
  visibleIds: Set<string>;   // 当前可见的 agent id 集合
  onChange: (next: Set<string>) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const total = agents.length;
  const onCount = agents.filter(a => visibleIds.has(a.agentId)).length;
  const partial = onCount < total;
  const allHidden = onCount === 0;

  const label =
    disabled ? "技能未启用" :
    allHidden ? "全部隐藏" :
    partial ? `${onCount} / ${total} 可见` : "全部可见";

  const toggleAgent = (id: string) => {
    const next = new Set(visibleIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange(next);
  };
  const selectAll = () => onChange(new Set(agents.map(a => a.agentId)));

  return (
    <div className="vis-wrap" ref={ref}>
      <button
        type="button"
        className={`vis-btn ${partial && !disabled ? "partial" : ""}`}
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
      >
        <span className="dot" />
        {label}
        {!disabled && <span className="caret">▾</span>}
      </button>
      <div className={`vis-dd ${open ? "open" : ""}`}>
        <div className="dh">
          对哪些 AGENT 可见
          <span className="all" onClick={selectAll}>全选</span>
        </div>
        {agents.map(a => {
          const on = visibleIds.has(a.agentId);
          return (
            <div key={a.agentId} className={`vi ${on ? "on" : ""}`} onClick={() => toggleAgent(a.agentId)}>
              <span className="ck" />
              <span>{a.displayName}</span>
              <span className="ag-id">{a.agentId}</span>
            </div>
          );
        })}
        <div className="df">
          {partial
            ? `${total - onCount} 个 agent 看不见这个工具。`
            : "未来登记的新 agent 默认包含。"}
        </div>
      </div>
    </div>
  );
}
