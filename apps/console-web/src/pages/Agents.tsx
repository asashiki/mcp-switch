import { useState } from "react";
import { Agents, Skills } from "@/lib/api";
import { useAsync } from "@/hooks/useAsync";
import type { Agent } from "@/types/api";
import PageHead from "@/components/PageHead";
import Modal from "@/components/Modal";
import { useT } from "@/i18n";
import { tStatic, localeTag } from "@/i18n/locales";

export default function AgentsPage() {
  const t = useT();
  const agentsQ = useAsync(() => Agents.list(), []);
  const skillsQ = useAsync(() => Skills.list(), []);
  const [addOpen, setAddOpen] = useState(false);
  const [secret, setSecret] = useState<{ agentId: string; secret: string } | null>(null);

  const list = agentsQ.data?.agents ?? [];
  const skillCount = skillsQ.data?.skills.filter(s => s.enabled).length ?? 0;

  const regen = async (a: Agent) => {
    if (!confirm(t("agents.regenConfirm", { name: a.displayName }))) return;
    const r = await Agents.regen(a.agentId);
    setSecret({ agentId: a.agentId, secret: r.secret });
    agentsQ.reload();
  };
  const setEnabled = async (a: Agent, v: boolean) => {
    await Agents.setEnabled(a.agentId, v);
    agentsQ.reload();
  };
  const remove = async (a: Agent) => {
    if (!confirm(t("agents.removeConfirm", { name: a.displayName }))) return;
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
        eyebrow={t("agents.eyebrow")}
        title={t("agents.title")}
        lede={t("agents.lede")}
        actions={<button className="btn primary" onClick={() => setAddOpen(true)}>{t("agents.register")}</button>}
      />

      {agentsQ.loading && <Hint>{t("common.loading")}</Hint>}
      {agentsQ.error   && <Hint err>{t("skills.loadFailed", { msg: agentsQ.error.message })}</Hint>}

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
                <span><span className="k">{t("agents.statusK")}</span>{a.enabled ? t("agents.enabled") : t("agents.disabled")}</span>
                <span><span className="k">{t("agents.lastK")}</span>{fmtTs(a.lastUsedAt) ?? t("agents.never")}</span>
                <span><span className="k">{t("agents.visibleK")}</span><span className="v tools">{t("agents.toolsN", { n: skillCount })}</span></span>
              </div>
            </div>
            <div className="actions">
              <button className="btn ghost sm" onClick={() => regen(a)}>{t("agents.regen")}</button>
              {a.enabled
                ? <button className="btn secondary sm" onClick={() => setEnabled(a, false)}>{t("agents.disable")}</button>
                : <button className="btn secondary sm" onClick={() => setEnabled(a, true)}>{t("agents.enable")}</button>}
              <button className="btn danger sm" onClick={() => remove(a)}>{t("common.delete")}</button>
            </div>
          </article>
        ))}
      </div>

      {/* 添加 agent 弹窗 */}
      <AddAgentModal open={addOpen} onClose={() => setAddOpen(false)} onCreate={createAgent} />

      {/* 一次性密钥展示 */}
      <Modal open={!!secret} onClose={() => setSecret(null)}
        title={t("agents.secretTitle")} sub="WRITE IT DOWN NOW"
        footer={<button className="btn primary" onClick={() => setSecret(null)}>{t("agents.secretWroteDown")}</button>}>
        {secret && (
          <>
            <div className="warn-text">
              {t("agents.secretWarn")}
            </div>
            <div className="secret-box">
              <span className="lab">{secret.agentId}</span>
              {secret.secret}
            </div>
            <button className="btn ghost sm" style={{ marginTop: 10 }}
              onClick={() => { navigator.clipboard.writeText(secret.secret); }}>
              {t("agents.copy")}
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
    const hm = d.toLocaleTimeString(localeTag(), { hour12: false, hour: "2-digit", minute: "2-digit" });
    if (d.toDateString() === today.toDateString())
      return tStatic("agents.today").replace("{time}", hm);
    return `${d.getMonth()+1}·${d.getDate()} ${hm}`;
  } catch { return s; }
}

function AddAgentModal({
  open, onClose, onCreate,
}: { open: boolean; onClose: () => void; onCreate: (id: string, name?: string) => void }) {
  const t = useT();
  const [agentId, setId] = useState("");
  const [name, setName] = useState("");
  return (
    <Modal open={open} onClose={onClose} title={t("agents.addTitle")}
      sub="OAUTH IDENTITY"
      footer={<>
        <button className="btn ghost" onClick={onClose}>{t("common.cancel")}</button>
        <button className="btn primary" disabled={!agentId.trim()}
          onClick={() => onCreate(agentId, name)}>{t("common.create")}</button>
      </>}>
      <div className="field" style={{ marginBottom: 14 }}>
        <label>{t("agents.agentIdLabel")}</label>
        <input value={agentId} onChange={e => setId(e.target.value.replace(/\s+/g, "-").toLowerCase())} placeholder="claude-android" />
      </div>
      <div className="field">
        <label>{t("agents.displayNameLabel")}</label>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Claude on Android" />
        <div className="help">{t("agents.addHelp")}</div>
      </div>
    </Modal>
  );
}
