import { useState, FormEvent } from "react";
import { Auth, TokenStore, UserStore, ApiError } from "@/lib/api";

export default function Login({ onSuccess }: { onSuccess: () => void }) {
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
      const msg = e instanceof ApiError ? e.message : "登录失败";
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
            为你的 AI 助理，<br/>
            建一处 <span className="hl">安静的工坊</span>。
          </h1>
          <p className="sub">
            把工具、密钥与权限整理成一处中枢，供任意 AI 安全调用。
            浅仪式 · 浅色为主，印象色只在该出现的地方出现。
          </p>
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
          <h2>进入控制台</h2>
          <p>用你的管理员凭据登录。会话有效期 7 天。</p>

          <div className="field">
            <label htmlFor="u">用户名</label>
            <input id="u" autoComplete="username" value={username}
              onChange={e => setUser(e.target.value)} placeholder="admin" />
          </div>
          <div className="field">
            <label htmlFor="p">口令</label>
            <input id="p" type="password" autoComplete="current-password"
              value={password} onChange={e => setPwd(e.target.value)}
              placeholder="••••••••••••" />
          </div>

          {err && <div className="warn-text" style={{ marginTop: 12 }}>{err}</div>}

          <button className="btn primary" type="submit" disabled={loading}>
            {loading ? "正在登录…" : "登 录"}
          </button>
          <div className="note">令牌仅保存在浏览器本地，登出即清除。</div>
        </form>
      </section>
    </div>
  );
}
