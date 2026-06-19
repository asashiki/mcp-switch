import { useState, FormEvent } from "react";
import { Auth, TokenStore, UserStore, ApiError } from "@/lib/api";
import { useT } from "@/i18n";

export default function Login({ onSuccess }: { onSuccess: () => void }) {
  const t = useT();
  const [username, setUser] = useState("admin");
  const [password, setPwd] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      const r = await Auth.login({ username, password });
      TokenStore.set(r.token);
      UserStore.set(r.username);
      onSuccess();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : t("login.failed");
      setErr(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <aside className="login-left">
        <div className="brand-big">
          MCP Switch<span style={{ color: "var(--accent)" }}>.</span>
        </div>

        <div>
          <h1 className="hero">
            {t("login.heroPre")}<br/>
            {t("login.heroMid")}<span className="hl">{t("login.heroHl")}</span>{t("login.heroPost")}
          </h1>
          <p className="sub">{t("login.sub")}</p>
        </div>

        <div className="colo">
          <div><span className="k">EDITION</span>self-hosted</div>
          <div><span className="k">LICENSE</span>MIT</div>
          <div><span className="k">GATEWAY</span>ONLINE</div>
        </div>
      </aside>

      <section className="login-right">
        <form className="login-form" onSubmit={submit}>
          <div className="eyebrow">SIGN&nbsp;IN</div>
          <h2>{t("login.enterConsole")}</h2>
          <p>{t("login.enterSub")}</p>

          <div className="field">
            <label htmlFor="u">{t("login.username")}</label>
            <input id="u" autoComplete="username" value={username}
              onChange={e => setUser(e.target.value)} placeholder="admin" />
          </div>
          <div className="field">
            <label htmlFor="p">{t("login.password")}</label>
            <input id="p" type="password" autoComplete="current-password"
              value={password} onChange={e => setPwd(e.target.value)}
              placeholder="••••••••••••" />
          </div>

          {err && <div className="warn-text" style={{ marginTop: 12 }}>{err}</div>}

          <button className="btn primary" type="submit" disabled={loading}>
            {loading ? t("login.signingIn") : t("login.signInBtn")}
          </button>
          <div className="note">{t("login.tokenNote")}</div>
        </form>
      </section>
    </div>
  );
}
