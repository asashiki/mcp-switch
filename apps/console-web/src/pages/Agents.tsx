import { useState } from "react";
import { Agents, Skills } from "@/lib/api";
import { useAsync } from "@/hooks/useAsync";
import type { Agent } from "@/types/api";
import PageHead from "@/components/PageHead";
import Modal from "@/components/Modal";

export default function AgentsPage() {
  const agentsQ = useAsync(() => Agents.list(), []);
  const skillsQ = useAsync(() => Skills.list(), []);
  const [addOpen, setAddOpen] = useState(false);
  const [secret, setSecret] = useState<{ agentId: string; secret: string } | null>(null);

  const list = agentsQ.data?.agents ?? [];
  const skillCount = skillsQ.data?.skills.filter(s => s.enabled).length ?? 0;

  const regen = async (a: Agent) => {
    if (!confirm(`确定为 ${a.displayName} 轮换一次密钥？旧密钥会立即吊销。`)) return;
    const r = await Agents.regen(a.agentId);
    setSecret({ agentId: a.agentId, secret: r.secret });
    agentsQ.reload();
  };
  const setEnabled = async (a: Agent, v: boolean) => {
    await Agents.setEnabled(a.agentId, v);
    agentsQ.reload();
  };
  const remove = async (a: Agent) => {
    if (!confirm(`删除 Agent「${a.displayName}」？\n它的密钥、令牌和技能可见性配置都会一并清除，使用该身份的客户端将立即断开。`)) return;
    await Agents.remove(a.agentId);
    agentsQ.reload();
  };
  const createAgent = async (agentId: string, displayName?: string) => {
    const r = await Agents.create(agentId.trim(), displayName?.trim() || undefined);
    if (r.secret) setSecret({ agentId: r.agentId, secret: r.secret });
    setAddOpen(false);
    agentsQ.reload();
  };

  return (
    <div className="frame">
      <PageHead
        eyebrow="AGENTS · 受權者"
        title="登记的 AI 客户端"
        lede="每个 agent 拥有独立 OAuth 密钥。技能可见性请在 「技能」 页每行下拉里调整。"
        actions={<button className="btn primary" onClick={() => setAddOpen(true)}>+ 登记 Agent</button>}
      />

      {agentsQ.loading && <Hint>载入中…</Hint>}
      {agentsQ.error   && <Hint err>载入失败：{agentsQ.error.message}</Hint>}

      <div className="agents-grid">
        {list.map((a, i) => (
          <article key={a.agentId} className={`agent-card ${a.enabled ? "" : "dim"}`}>
            <div className="ava" style={{ background: AVATAR_COLORS[i % AVATAR_COLORS.length] }}>
              {(a.displayName ?? a.agentId).slice(0, 1).toUpperCase()}
            </div>
            <div className="info">
              <div className="row1">
                <span className="nm">{a.displayName}</span>
                <span className="id">{a.agentId}</span>
              </div>
              <div className="meta">
                <span><span className="k">状态</span>{a.enabled ? "启用" : "禁用"}</span>
                <span><span className="k">最近</span>{fmtTs(a.lastUsedAt) ?? "从未"}</span>
                <span><span className="k">可见</span><span className="v tools">{skillCount} 项工具</span></span>
              </div>
            </div>
            <div className="actions">
              <button className="btn ghost sm" onClick={() => regen(a)}>轮换密钥</button>
              {a.enabled
                ? <button className="btn secondary sm" onClick={() => setEnabled(a, false)}>禁用</button>
                : <button className="btn secondary sm" onClick={() => setEnabled(a, true)}>启用</button>}
              <button className="btn danger sm" onClick={() => remove(a)}>删除</button>
            </div>
          </article>
        ))}
      </div>

      {/* 添加 agent 弹窗 */}
      <AddAgentModal open={addOpen} onClose={() => setAddOpen(false)} onCreate={createAgent} />

      {/* 一次性密钥展示 */}
      <Modal open={!!secret} onClose={() => setSecret(null)}
        title="新的一次性密钥" sub="WRITE IT DOWN NOW"
        footer={<button className="btn primary" onClick={() => setSecret(null)}>我已抄录</button>}>
        {secret && (
          <>
            <div className="warn-text">
              这串密钥只显示这一次。关闭此窗口后无法再次显示。
            </div>
            <div className="secret-box">
              <span className="lab">{secret.agentId}</span>
              {secret.secret}
            </div>
            <button className="btn ghost sm" style={{ marginTop: 10 }}
              onClick={() => { navigator.clipboard.writeText(secret.secret); }}>
              复制到剪贴板
            </button>
          </>
        )}
      </Modal>
    </div>
  );
}

const AVATAR_COLORS = [
  "var(--accent)", "var(--accent-2)",
  "linear-gradient(135deg, var(--accent), var(--accent-2))",
  "var(--ok)", "var(--warn)", "var(--text-2)",
];

function Hint({ children, err }: { children: React.ReactNode; err?: boolean }) {
  return (
    <div className="card"><div className="card-body" style={{
      color: err ? "var(--err)" : "var(--text-3)",
    }}>{children}</div></div>
  );
}

function fmtTs(s: string | null): string | null {
  if (!s) return null;
  try {
    const d = new Date(s);
    const today = new Date();
    if (d.toDateString() === today.toDateString())
      return `今天 ${d.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })}`;
    return `${d.getMonth()+1}·${d.getDate()} ${d.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })}`;
  } catch { return s; }
}

function AddAgentModal({
  open, onClose, onCreate,
}: { open: boolean; onClose: () => void; onCreate: (id: string, name?: string) => void }) {
  const [agentId, setId] = useState("");
  const [name, setName] = useState("");
  return (
    <Modal open={open} onClose={onClose} title="登记新 Agent"
      sub="OAUTH IDENTITY"
      footer={<>
        <button className="btn ghost" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={!agentId.trim()}
          onClick={() => onCreate(agentId, name)}>创建</button>
      </>}>
      <div className="field" style={{ marginBottom: 14 }}>
        <label>Agent ID（slug · 例：claude-android）</label>
        <input value={agentId} onChange={e => setId(e.target.value.replace(/\s+/g, "-").toLowerCase())} placeholder="claude-android" />
      </div>
      <div className="field">
        <label>显示名（可选）</label>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Claude on Android" />
        <div className="help">创建后会返回一次性密钥，仅显示一次，请立刻保管。</div>
      </div>
    </Modal>
  );
}
