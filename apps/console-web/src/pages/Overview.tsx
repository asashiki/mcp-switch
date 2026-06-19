import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Stats, Health, Audit } from "@/lib/api";
import { useAsync } from "@/hooks/useAsync";
import PageHead from "@/components/PageHead";
import { useT } from "@/i18n";
import { tStatic, localeTag } from "@/i18n/locales";

type Range = "1h" | "24h" | "7d" | "30d";

export default function Overview() {
  const t = useT();
  const [range, setRange] = useState<Range>("24h");

  const stats = useAsync(() => Stats.range(range), [range]);
  const health = useAsync(() => Health.overview(), []);
  const audit  = useAsync(() => Audit.list(50), []);

  // 页眉承诺的 30s 自动刷新（useAsync 刷新期间保留旧 data，不会闪占位符）
  useEffect(() => {
    const id = setInterval(() => { stats.reload(); health.reload(); audit.reload(); }, 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const data = stats.data;
  const hasStats = !!data;
  const audits = audit.data?.entries ?? [];

  const recentAnomalies = audits.filter(e => e.success === 0 || e.action === "mcp_unauthorized").slice(0, 4);

  return (
    <div className="frame">
      <PageHead
        eyebrow={t("overview.eyebrow")}
        title={t("overview.title")}
        lede={t("overview.lede")}
        meta={
          <>
            {t("overview.metaRefresh")}<br/>
            {hasStats ? t("overview.asOf", { time: new Date().toLocaleTimeString(localeTag(), { hour12: false }) }) : t("overview.loadingStats")}
          </>
        }
      />

      {/* KPI */}
      <div className="kpi-grid">
        <KPI label={t("overview.kpiCalls")} value={data?.totalCalls ?? "—"} unit={t("overview.unitTimes")}
             trend={data?.deltaVsPrev ? pctTrend(data.deltaVsPrev.totalCalls) : null}
             trendLabel={t("overview.vsPrev")} />
        <KPI label={t("overview.kpiP95")} value={data?.p95LatencyMs ?? "—"} unit="ms"
             trend={data?.deltaVsPrev ? msTrend(-data.deltaVsPrev.p95LatencyMs) : null}
             trendLabel={t("overview.vsPrev")} />
        <KPI label={t("overview.kpiErrors")} value={data ? (data.errorCalls + data.unauthorizedCalls) : "—"} unit={t("overview.unitTimes")}
             trend={data?.deltaVsPrev ? pctTrend(data.deltaVsPrev.errorCalls, true) : null}
             trendLabel={t("overview.vsPrev")} />
        <KPI label={t("overview.kpiActiveAgents")} value={data ? data.byAgent.filter(a => a.count > 0).length : "—"} unit={t("overview.unitCount")}
             trendLabel={data ? t("overview.registered", { n: data.byAgent.length }) : ""} deco />
      </div>

      {/* traffic + top tools */}
      <div className="ov-grid">
        <div className="card deco">
          <div className="card-head">
            <h3>{t("overview.trafficTitle")}</h3>
            <span className="sub">requests over time</span>
            <span className="right">
              <div className="seg">
                {(["1h","24h","7d","30d"] as Range[]).map(r => (
                  <button key={r} className={r === range ? "on" : ""}
                    onClick={() => setRange(r)}>{r.toUpperCase()}</button>
                ))}
              </div>
            </span>
          </div>
          <div className="card-body">
            {!hasStats ? (
              <Placeholder>{stats.error ? t("overview.statsFailed", { msg: stats.error.message }) : t("overview.statsLoading")}</Placeholder>
            ) : (
              <TrafficChart points={data!.timeline.map(p => p.n)} />
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h3>{t("overview.topToolsTitle")}</h3><span className="sub">top tools</span></div>
          <div className="card-body">
            {!hasStats ? (
              <Placeholder>{stats.error ? t("overview.statsFailed", { msg: stats.error.message }) : t("overview.statsLoading")}</Placeholder>
            ) : (
              <ol className="top-tools">
                {data!.topTools.slice(0, 8).map((t, i) => {
                  const max = data!.topTools[0]?.count || 1;
                  const w = Math.max(8, Math.round(t.count / max * 100));
                  return (
                    <li key={t.skillId}>
                      <span className="rk">{String(i + 1).padStart(2, "0")}</span>
                      <span className="nm">
                        <span className="t">{t.title}</span>
                      </span>
                      <span className="ct">
                        <div className="num">{t.count}</div>
                        <div className="bar" style={{ width: `${w}%` }} />
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </div>
      </div>

      {/* agent share + anomalies */}
      <div className="ov-grid">
        <div className="card">
          <div className="card-head"><h3>{t("overview.agentShareTitle")}</h3><span className="sub">who's using what</span></div>
          <div className="card-body">
            {!hasStats ? (
              <Placeholder>{stats.error ? t("overview.statsFailed", { msg: stats.error.message }) : t("overview.statsLoading")}</Placeholder>
            ) : (
              <div className="agent-share">
                {data!.byAgent.slice(0, 6).map((a, i) => (
                  <div className="row" key={a.agentId}>
                    <div className="name">
                      <span className="dot" style={{ background: AGENT_COLORS[i % AGENT_COLORS.length] }} />
                      {a.displayName}
                    </div>
                    <div className="bar-wrap">
                      <div className="bar" style={{
                        width: `${a.pct * 100}%`,
                        background: AGENT_COLORS[i % AGENT_COLORS.length],
                      }} />
                    </div>
                    <div className="val">{a.count}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="card deco">
          <div className="card-head">
            <h3>{t("overview.anomaliesTitle")}</h3><span className="sub">recent issues</span>
            <span className="right"><Link className="btn ghost sm" to="/audit">{t("overview.toAudit")}</Link></span>
          </div>
          <div className="card-body">
            {audit.loading && !audit.data ? <Placeholder>{t("common.loading")}</Placeholder> :
             recentAnomalies.length === 0 ? <Placeholder>{t("overview.noAnomalies")}</Placeholder> :
            <div className="anom-list">
              {recentAnomalies.map((e, i) => (
                <div className="anom" key={i}>
                  <div className="ts">{fmtTime(e.created_at)}<br/>
                    <span className="day">{fmtDay(e.created_at)}</span>
                  </div>
                  <div className="body">
                    <span className="what">{prettyAction(e.action)}</span>
                    {e.tool_name && <> · {e.tool_name}</>}
                    {e.detail && <> · {e.detail}</>}
                    {e.agent_id && <span className="note">agent · {e.agent_id}</span>}
                  </div>
                  <span className={`tag ${e.success === 0 ? "err" : "warn"}`}>
                    {e.success === 0 ? t("common.failed") : `${e.latency_ms ?? "?"}ms`}
                  </span>
                </div>
              ))}
            </div>}
          </div>
        </div>
      </div>

      {/* system health */}
      <div className="card deco" style={{ marginTop: 16 }}>
        <div className="card-head"><h3>{t("overview.healthTitle")}</h3><span className="sub">gateway · connectors</span></div>
        {!health.data ? (
          <div className="card-body">
            <Placeholder>{health.error ? t("overview.healthFailed", { msg: health.error.message }) : t("overview.healthLoading")}</Placeholder>
          </div>
        ) : (
          <div className="sys-grid">
            <HealthItem nm="mcp-switch" status={health.data.gateway.ok ? "ok" : "err"} meta={`:4200 · ${health.data.gateway.uptime}`} />
            {health.data.connectors.map(c => (
              <HealthItem key={c.id} nm={c.name} status={c.status === "disabled" ? "warn" : c.status} meta={c.note ?? ""} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- helpers --------------------------------------------------------

const AGENT_COLORS = [
  "var(--accent)", "var(--accent-2)", "var(--ok)", "var(--warn)", "var(--text-2)", "var(--text-3)",
];

function KPI({ label, value, unit, trend, trendLabel, deco }: {
  label: string; value: string | number; unit?: string;
  trend?: { dir: "up" | "down" | "neutral"; text: string } | null;
  trendLabel?: string; deco?: boolean;
}) {
  return (
    <div className={`kpi ${deco ? "deco" : ""}`}>
      <div className="lab">{label}</div>
      <div className="val">{value}{unit && <span className="unit">{unit}</span>}</div>
      {(trend || trendLabel) && (
        <div className="trend">
          {trend && <span className={trend.dir === "up" ? "up" : trend.dir === "down" ? "down" : ""}>
            {trend.text}
          </span>} {trendLabel}
        </div>
      )}
    </div>
  );
}

function pctTrend(v: number, badIsUp = false) {
  if (Math.abs(v) < 0.005) return { dir: "neutral" as const, text: tStatic("trend.flat") };
  const up = v > 0;
  const dir = up ? (badIsUp ? "down" : "up") : (badIsUp ? "up" : "down");
  return { dir: dir as "up" | "down", text: `${up ? "↑" : "↓"} ${Math.abs(v * 100).toFixed(1)}%` };
}
function msTrend(deltaMs: number) {
  if (Math.abs(deltaMs) < 1) return { dir: "neutral" as const, text: tStatic("trend.flat") };
  const better = deltaMs > 0; // 这里我们传入的是 -delta（即变快是 +），所以正数=变快
  return {
    dir: (better ? "up" : "down") as "up" | "down",
    text: `${better ? "↓" : "↑"} ${Math.abs(deltaMs).toFixed(0)}ms`,
  };
}
function fmtTime(s: string) {
  try { return new Date(s).toLocaleTimeString(localeTag(), { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
  catch { return s; }
}
function fmtDay(s: string) {
  try {
    const d = new Date(s);
    const today = new Date(); today.setHours(0,0,0,0);
    const dd = new Date(d); dd.setHours(0,0,0,0);
    const diff = (today.getTime() - dd.getTime()) / 86400000;
    if (diff < 1) return tStatic("day.today");
    if (diff < 2) return tStatic("day.yesterday");
    return d.toLocaleDateString(localeTag(), { month: "short", day: "numeric" });
  } catch { return ""; }
}
function prettyAction(a: string) {
  const key = a === "console_api_login" ? "console_login" : a;
  const known = ["mcp_unauthorized", "mcp_request", "tool_call", "token_refreshed", "console_login", "remote_rediscover"];
  return known.includes(key) ? tStatic(`action.${key}`) : a;
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      padding: "32px 16px", color: "var(--text-3)", fontSize: 13.5,
      textAlign: "center", lineHeight: 1.6,
    }}>{children}</div>
  );
}

function HealthItem({ nm, status, meta }: { nm: string; status: "ok" | "warn" | "err"; meta: string }) {
  return (
    <div className="item">
      <div className="nm"><span className={`dot ${status === "ok" ? "" : status}`} /> {nm}</div>
      <div className="meta">{meta}</div>
    </div>
  );
}

function TrafficChart({ points }: { points: number[] }) {
  if (!points.length) return <Placeholder>{tStatic("overview.noData")}</Placeholder>;
  const w = 700;
  const h = 200;
  const max = Math.max(...points);
  const step = points.length > 1 ? w / (points.length - 1) : 0;
  const norm = (p: number) => h - 20 - (p / max) * (h - 40);
  const line = points.map((p, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)},${norm(p).toFixed(1)}`).join(" ");
  const area = `${line} L${w},${h} L0,${h} Z`;
  return (
    <svg className="traffic-chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id="g-area" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%"   stopColor="var(--accent)" stopOpacity=".22"/>
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0"/>
        </linearGradient>
      </defs>
      <g stroke="var(--border)" strokeOpacity=".6">
        <line x1="0" x2={w} y1={h * .25} y2={h * .25} />
        <line x1="0" x2={w} y1={h * .5}  y2={h * .5}  />
        <line x1="0" x2={w} y1={h * .75} y2={h * .75} />
      </g>
      <path d={area} fill="url(#g-area)" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="1.8"/>
    </svg>
  );
}
