import { useMemo, useState } from "react";
import { Audit } from "@/lib/api";
import { useAsync } from "@/hooks/useAsync";
import type { AuditEntry } from "@/types/api";
import PageHead from "@/components/PageHead";
import { useT } from "@/i18n";
import { tStatic, localeTag } from "@/i18n/locales";

type Filter = "all" | "errors" | "login";

// 把扁平 audit log 折叠为「会话」：相邻 30 秒内同一 agent 的 mcp_request 归一组。
interface Session {
  id: string;
  startAt: string;
  endAt: string;
  agent: string | null;
  bad: boolean;
  entries: AuditEntry[];
  toolCalls: string[];
}

export default function AuditPage() {
  const t = useT();
  const q = useAsync(() => Audit.list(150), []);
  const [filter, setFilter] = useState<Filter>("all");
  const [agent, setAgent]   = useState<string>("all");
  const [search, setSearch] = useState("");

  const entries = q.data?.entries ?? [];

  const filtered = useMemo(() => entries.filter(e => {
    if (agent !== "all" && e.agent_id !== agent) return false;
    if (filter === "errors" && e.success === 1) return false;
    if (filter === "login" && !(e.action === "console_login" || e.action === "console_api_login")) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      if (![e.tool_name ?? "", e.detail ?? "", e.action, e.agent_id ?? ""].some(s => s.toLowerCase().includes(q))) return false;
    }
    return true;
  }), [entries, filter, agent, search]);

  const sessions = useMemo(() => groupIntoSessions(filtered), [filtered]);
  const byDay = useMemo(() => groupByDay(sessions), [sessions]);

  const allAgents = useMemo(() =>
    Array.from(new Set(entries.map(e => e.agent_id).filter(Boolean))) as string[],
    [entries]);

  return (
    <div className="frame">
      <PageHead
        eyebrow={t("audit.eyebrow")}
        title={t("audit.title")}
        lede={t("audit.lede")}
        meta={<>{t("audit.recentN", { n: entries.length })}<br/>UPDATED {new Date().toLocaleTimeString(localeTag(), { hour12: false, hour: "2-digit", minute: "2-digit" })}</>}
      />

      <div className="audit-bar">
        {([
          ["all", "audit.filterAll"],
          ["errors", "audit.filterErrors"],
          ["login", "audit.filterLogin"],
        ] as [Filter, string][]).map(([k, labelKey]) => (
          <button key={k} className={`chip ${filter === k ? "active" : ""}`}
            onClick={() => setFilter(k)}>{t(labelKey)}</button>
        ))}

        <div className="seg" style={{ marginLeft: 6 }}>
          <button className={agent === "all" ? "on" : ""} onClick={() => setAgent("all")}>{t("audit.allAgents")}</button>
          {allAgents.slice(0, 4).map(a =>
            <button key={a} className={agent === a ? "on" : ""} onClick={() => setAgent(a)}>{a}</button>
          )}
        </div>

        <div className="right">
          <input className="search" placeholder={t("audit.searchPlaceholder")}
            value={search} onChange={e => setSearch(e.target.value)}
            style={{ width: 240 }} />
        </div>
      </div>

      {q.loading && <Hint>{t("audit.loading")}</Hint>}
      {q.error   && <Hint err>{t("audit.loadFailed", { msg: q.error.message })}</Hint>}

      {byDay.map(({ day, label, weekday, sessions, stat }) => (
        <section className="day-block" key={day}>
          <div className="day-head">
            <span className="date">{label}</span>
            <span className="wd">{weekday}</span>
            <span className="stat">{stat}</span>
          </div>

          {sessions.map(s => <SessionCard key={s.id} session={s} />)}
        </section>
      ))}

      {byDay.length === 0 && !q.loading && (
        <Hint>{t("audit.noMatch")}</Hint>
      )}
    </div>
  );
}

function Hint({ children, err }: { children: React.ReactNode; err?: boolean }) {
  return (
    <div className="card"><div className="card-body" style={{
      color: err ? "var(--err)" : "var(--text-3)", textAlign: "center",
    }}>{children}</div></div>
  );
}

function SessionCard({ session }: { session: Session }) {
  const t = useT();
  const { startAt, endAt, agent, bad, entries: items, toolCalls } = session;
  const lat = items.map(e => e.latency_ms ?? 0).filter(n => n > 0).sort((a, b) => a - b);
  const p95 = lat.length ? lat[Math.floor(lat.length * 0.95)] : null;

  const sumLine = bad
    ? t("audit.sumBlocked", { n: items.length })
    : agent
      ? t("audit.sumConnected", { agent, n: items.length })
      : t("audit.sumConsole", { action: items[0]?.action ?? "" });

  return (
    <div className={`session ${bad ? "bad" : ""}`}>
      <div className="when">
        {fmtTimeShort(startAt)}<br/>
        {startAt !== endAt && <span className="span">→ {fmtTimeShort(endAt)} · {durationSec(startAt, endAt)}</span>}
      </div>
      <div className="badge" style={{
        background: bad ? "var(--err)" : agentColor(agent),
      }}>
        {bad ? "!" : (agent ?? "·").slice(0, 1).toUpperCase()}
      </div>
      <div className="body">
        <div className="line1">
          {agent && <span className="ag">{agent}</span>} {sumLine}
        </div>
        <div className="calls">
          {toolCalls.map((t, i) => (
            <span key={i} className={`call ${bad ? "bad" : ""}`}>{t}</span>
          ))}
        </div>
      </div>
      <div className="right-meta">
        {t("audit.callsN", { n: items.length })}<br/>
        {p95 ? `P95 ${p95}ms` : ""}
      </div>
    </div>
  );
}

// ----- helpers -----

function groupIntoSessions(entries: AuditEntry[]): Session[] {
  const sorted = [...entries].sort((a, b) =>
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const out: Session[] = [];
  for (const e of sorted) {
    const last = out[out.length - 1];
    const same = last
      && last.agent === (e.agent_id ?? null)
      && Math.abs(new Date(last.endAt).getTime() - new Date(e.created_at).getTime()) < 60_000
      && (last.bad ? e.success === 0 : e.success === 1);
    if (same) {
      last.entries.unshift(e);
      last.startAt = e.created_at < last.startAt ? e.created_at : last.startAt;
      last.endAt   = e.created_at > last.endAt ? e.created_at : last.endAt;
      const label = displayCall(e);
      if (label) last.toolCalls.unshift(label);
    } else {
      const label = displayCall(e);
      out.push({
        id: `${e.created_at}-${e.action}-${e.agent_id ?? ""}`,
        startAt: e.created_at, endAt: e.created_at,
        agent: e.agent_id ?? null,
        bad: e.success === 0,
        entries: [e],
        toolCalls: label ? [label] : [],
      });
    }
  }
  return out;
}

function displayCall(e: AuditEntry): string {
  if (e.success === 0) {
    return e.detail ? e.detail : e.action;
  }
  if (e.tool_name) return e.tool_name;
  if (e.action === "token_refreshed") return tStatic("audit.callTokenRefresh");
  if (e.action === "console_login" || e.action === "console_api_login") return tStatic("audit.callLogin");
  if (e.action === "remote_rediscover") return tStatic("audit.callRemoteDiscover");
  return e.action;
}

function groupByDay(sessions: Session[]) {
  const map: Record<string, Session[]> = {};
  for (const s of sessions) {
    const d = new Date(s.startAt);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    (map[key] ??= []).push(s);
  }
  return Object.entries(map)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, ss]) => {
      const calls = ss.reduce((sum, s) => sum + s.entries.length, 0);
      const bad   = ss.filter(s => s.bad).reduce((sum, s) => sum + s.entries.length, 0);
      const d = new Date(day);
      const label = dayLabel(d);
      const wd = ["SUN","MON","TUE","WED","THU","FRI","SAT"][d.getDay()];
      return {
        day, label, weekday: wd,
        sessions: ss,
        stat: tStatic("audit.statLine").replace("{sessions}", String(ss.length)).replace("{calls}", String(calls)).replace("{bad}", String(bad)),
      };
    });
}

function dayLabel(d: Date) {
  const today = new Date(); today.setHours(0,0,0,0);
  const x = new Date(d); x.setHours(0,0,0,0);
  const diff = (today.getTime() - x.getTime()) / 86400000;
  if (diff === 0) return tStatic("day.today");
  if (diff === 1) return tStatic("day.yesterday");
  return `${d.getMonth()+1}·${String(d.getDate()).padStart(2,"0")}`;
}

function fmtTimeShort(s: string) {
  try {
    return new Date(s).toLocaleTimeString(localeTag(), { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch { return s; }
}
function durationSec(a: string, b: string) {
  const diff = Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000);
  if (diff < 60) return `${diff}s`;
  return `${Math.round(diff / 60)}min`;
}
function agentColor(agent: string | null): string {
  if (!agent) return "var(--text-2)";
  const palette = ["var(--accent)", "var(--accent-2)", "var(--ok)", "var(--warn)"];
  let h = 0; for (const c of agent) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}
