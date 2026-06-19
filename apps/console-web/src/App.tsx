import { useEffect, useState } from "react";
import { Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { Auth, TokenStore, UserStore } from "@/lib/api";
import { useT } from "@/i18n";
import Login from "@/pages/Login";
import Shell from "@/components/Shell";
import Overview from "@/pages/Overview";
import SkillsPage from "@/pages/Skills";
import AgentsPage from "@/pages/Agents";
import RemotePage from "@/pages/Remote";
import AuditPage from "@/pages/Audit";

type AuthState = "unknown" | "in" | "out";

export default function App() {
  const [auth, setAuth] = useState<AuthState>("unknown");
  const nav = useNavigate();
  const t = useT();

  useEffect(() => {
    const tk = TokenStore.get();
    if (!tk) { setAuth("out"); return; }
    Auth.me()
      .then((m) => { UserStore.set(m.username); setAuth("in"); })
      .catch(() => { TokenStore.clear(); setAuth("out"); });
  }, []);

  if (auth === "unknown") return <div style={{ padding: 40, color: "var(--text-3)" }}>{t("common.loading")}</div>;

  if (auth === "out") {
    return (
      <Routes>
        <Route path="/login" element={
          <Login onSuccess={() => { setAuth("in"); nav("/", { replace: true }); }} />
        } />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Shell onLogout={() => { TokenStore.clear(); setAuth("out"); nav("/login"); }}>
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/skills" element={<SkillsPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/remote" element={<RemotePage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
