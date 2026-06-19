import { ReactNode, useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { Health, UserStore } from "@/lib/api";
import { useI18n, LANGS, type Lang } from "@/i18n";

const NAV = [
  { to: "/",        key: "nav.overview" },
  { to: "/skills",  key: "nav.skills"   },
  { to: "/agents",  key: "nav.agents"   },
  { to: "/remote",  key: "nav.remote"   },
  { to: "/audit",   key: "nav.audit"    },
];

export default function Shell({
  children, onLogout,
}: { children: ReactNode; onLogout: () => void }) {
  const { t, lang, setLang } = useI18n();
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
    health === "ok"   ? t("header.allOnline") :
    health === "warn" ? t("header.partial") : t("header.issues");

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            MCP Switch<span style={{ color: "var(--accent)" }}>.</span>
            <small>{t("header.console")}</small>
          </div>

          <nav className="nav-tabs">
            {NAV.map(n => (
              <NavLink key={n.to} to={n.to} end={n.to === "/"}
                className={({ isActive }) => isActive ? "active" : ""}>
                {t(n.key)}
              </NavLink>
            ))}
          </nav>

          <div className="spacer" />

          <div className="top-util">
            <span className={`health-pill ${health === "ok" ? "" : health}`}>
              <span className="dot" /> {healthLabel}
            </span>
            <LangSwitcher lang={lang} setLang={setLang} title={t("header.language")} />
            <button className="icon-btn" title={t("header.theme")}
              onClick={() => setTheme(t => t === "light" ? "dark" : "light")}>
              {theme === "light" ? "◐" : "◑"}
            </button>
            <span className="user-mini">
              <span className="ava">{user.slice(0, 1).toUpperCase()}</span>
              <span className="nm">{user}</span>
            </span>
            <button className="icon-btn" title={t("header.logout")} onClick={onLogout}>↩</button>
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
              {t(n.key)}
            </NavLink>
          ))}
        </div>
      </header>

      <main>{children}</main>
    </>
  );
}

function LangSwitcher({ lang, setLang, title }: { lang: Lang; setLang: (l: Lang) => void; title: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const current = LANGS.find(l => l.code === lang) ?? LANGS[0];
  return (
    <div className="lang-switch" ref={ref}>
      <button className="icon-btn" title={title} aria-label={title} onClick={() => setOpen(o => !o)}>
        {current.code.toUpperCase()}
      </button>
      <div className={`lang-dd ${open ? "open" : ""}`} role="menu">
        {LANGS.map(l => (
          <button key={l.code} role="menuitemradio" aria-checked={l.code === lang}
            className={l.code === lang ? "on" : ""}
            onClick={() => { setLang(l.code); setOpen(false); }}>
            {l.label}
          </button>
        ))}
      </div>
    </div>
  );
}
