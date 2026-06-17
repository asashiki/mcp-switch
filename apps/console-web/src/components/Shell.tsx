import { ReactNode, useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { Health, UserStore } from "@/lib/api";

const NAV = [
  { to: "/",        label: "概览"      },
  { to: "/skills",  label: "技能"      },
  { to: "/agents",  label: "Agents"   },
  { to: "/remote",  label: "接入"      },
  { to: "/audit",   label: "审计"      },
];

export default function Shell({
  children, onLogout,
}: { children: ReactNode; onLogout: () => void }) {
  const [mobOpen, setMobOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("mcp-switch.theme");
    return (saved === "dark" ? "dark" : "light");
  });
  const [health, setHealth] = useState<"ok" | "warn" | "err">("ok");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("mcp-switch.theme", theme);
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    const poll = () => Health.overview().then((h) => {
      if (cancelled) return;
      if (!h) { setHealth("ok"); return; } // 后端未实现时默认 ok
      const anyErr  = !h.gateway.ok || h.connectors.some(c => c.status === "err");
      const anyWarn = h.connectors.some(c => c.status === "warn");
      setHealth(anyErr ? "err" : anyWarn ? "warn" : "ok");
    }).catch(() => {});
    poll();
    const id = setInterval(poll, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const user = UserStore.get() ?? "—";
  const healthLabel =
    health === "ok"   ? "全部在线" :
    health === "warn" ? "部分预警" : "存在异常";

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            MCP Switch<span style={{ color: "var(--accent)" }}>.</span>
            <small>CONSOLE</small>
          </div>

          <nav className="nav-tabs">
            {NAV.map(n => (
              <NavLink key={n.to} to={n.to} end={n.to === "/"}
                className={({ isActive }) => isActive ? "active" : ""}>
                {n.label}
              </NavLink>
            ))}
          </nav>

          <div className="spacer" />

          <div className="top-util">
            <span className={`health-pill ${health === "ok" ? "" : health}`}>
              <span className="dot" /> {healthLabel}
            </span>
            <button className="icon-btn" title="切换主题"
              onClick={() => setTheme(t => t === "light" ? "dark" : "light")}>
              {theme === "light" ? "◐" : "◑"}
            </button>
            <span className="user-mini">
              <span className="ava">{user.slice(0, 1).toUpperCase()}</span>
              <span className="nm">{user}</span>
            </span>
            <button className="icon-btn" title="登出" onClick={onLogout}>↩</button>
            <button className="mob-menu-btn" onClick={() => setMobOpen(o => !o)} aria-label="menu">
              {mobOpen ? "✕" : "☰"}
            </button>
          </div>
        </div>

        <div className={`mob-nav ${mobOpen ? "open" : ""}`}>
          {NAV.map(n => (
            <NavLink key={n.to} to={n.to} end={n.to === "/"}
              onClick={() => setMobOpen(false)}
              className={({ isActive }) => isActive ? "active" : ""}>
              {n.label}
            </NavLink>
          ))}
        </div>
      </header>

      <main>{children}</main>
    </>
  );
}