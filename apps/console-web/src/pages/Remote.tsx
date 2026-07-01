import { useEffect, useState } from "react";
import { Remote } from "@/lib/api";
import { useAsync } from "@/hooks/useAsync";
import type { RemoteServer } from "@/types/api";
import PageHead from "@/components/PageHead";
import { useT } from "@/i18n";

// 接入表单对齐 claude.ai 连接器：Name + URL 必填；OAuth Client ID/Secret 可选。
// 三种鉴权自动适配：①开放服务器直连 ②OAuth 动态注册（DCR）→ 跳转授权
// ③OAuth 预注册客户端（填 ID/Secret）→ 跳转授权。另保留静态 Bearer Token（高级）。
export default function RemotePage() {
  const t = useT();
  const q = useAsync(() => Remote.list(), []);
  const [form, setForm] = useState({
    name: "", transport: "http" as "http" | "stdio", url: "",
    command: "", argsText: "", envText: "",
    clientId: "", clientSecret: "", bearerToken: "", headers: "",
  });
  const [jsonText, setJsonText] = useState("");
  const setTransport = (t: "http" | "stdio") => setForm(f => ({ ...f, transport: t }));
  const [showCfg, setShowCfg] = useState<string | null>(null);

  // 把一个已接入的服务器还原成 mcpServers JSON（密钥值脱敏成 ***）。
  const serverConfigJson = (s: RemoteServer): string => {
    const inner: Record<string, unknown> = {};
    if (s.transport === "stdio") {
      if (s.command) inner.command = s.command;
      if (s.args?.length) inner.args = s.args;
      if (s.envKeys?.length) inner.env = Object.fromEntries(s.envKeys.map(k => [k, "***"]));
    } else {
      inner.serverUrl = s.url;
      if (s.headerKeys?.length) inner.headers = Object.fromEntries(s.headerKeys.map(k => [k, "***"]));
    }
    return JSON.stringify({ mcpServers: { [s.name || s.id]: inner } }, null, 2);
  };
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // OAuth 授权完成后外部跳回 /console/remote?oauth=ok|err
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const oauth = p.get("oauth");
    if (!oauth) return;
    if (oauth === "ok") setMsg(t("remote.msgAuthOk", { server: p.get("server") ?? "" }));
    else setMsg(t("remote.msgAuthFail", { msg: p.get("msg") ?? t("common.unknownError") }));
    window.history.replaceState(null, "", window.location.pathname);
    q.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const authorize = async (id: string) => {
    setBusy(true); setMsg(null);
    try {
      const r = await Remote.oauthStart(id);
      if (r.status === "redirect" && r.authorizeUrl) {
        window.location.href = r.authorizeUrl; // 跳外部授权页，回来落在 ?oauth=ok
        return;
      }
      setMsg(t("remote.msgHasAuth"));
      q.reload();
    } catch (e: any) {
      setMsg(t("remote.msgStartAuthFail", { msg: e?.message ?? t("common.unknownError") }));
    } finally { setBusy(false); }
  };

  // 把 "Key: Value" 多行文本解析成对象（每行一个）。用于 headers 和 env。
  const parseKeyVals = (text: string): Record<string, string> | undefined => {
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const i = t.indexOf(":");
      if (i <= 0) continue;
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim();
      if (k && v) out[k] = v;
    }
    return Object.keys(out).length ? out : undefined;
  };
  // args：每行一个参数。
  const parseLines = (text: string): string[] =>
    text.split("\n").map(s => s.trim()).filter(Boolean);

  // 从粘贴的 mcpServers JSON 自动识别并填表（兼容 Claude Desktop / VSCode 配置）。
  const importJson = () => {
    setMsg(null);
    try {
      const obj = JSON.parse(jsonText);
      const servers = obj?.mcpServers ?? obj;
      const entries = Object.entries(servers ?? {});
      if (!entries.length) throw new Error(t("remote.msgNoEntries"));
      const [key, cfgRaw] = entries[0] as [string, any];
      const cfg = cfgRaw ?? {};
      const remoteUrl = cfg.serverUrl ?? cfg.url;
      if (cfg.command) {
        // 本地 stdio 服务器
        const envText = Object.entries(cfg.env ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n");
        setForm(f => ({
          ...f, name: f.name || key, transport: "stdio",
          command: String(cfg.command),
          argsText: Array.isArray(cfg.args) ? cfg.args.map(String).join("\n") : "",
          envText,
        }));
        setMsg(t("remote.msgStdioDetected", { key }));
      } else if (remoteUrl) {
        const headersText = Object.entries(cfg.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n");
        setForm(f => ({ ...f, name: f.name || key, transport: "http", url: String(remoteUrl), headers: headersText }));
        setMsg(t("remote.msgHttpDetected", { key, headers: headersText ? t("remote.headersFrag") : "" }));
      } else {
        throw new Error(t("remote.msgNoCmdUrl"));
      }
    } catch (e: any) {
      setMsg(t("remote.msgJsonFail", { msg: e?.message ?? t("remote.msgBadJson") }));
    }
  };

  const resetForm = () => setForm({
    name: "", transport: "http", url: "", command: "", argsText: "", envText: "",
    clientId: "", clientSecret: "", bearerToken: "", headers: "",
  });

  const submit = async () => {
    setBusy(true); setMsg(null);
    try {
      const stdio = form.transport === "stdio";
      const r = await Remote.add({
        name: form.name.trim(),
        transport: form.transport,
        url: stdio ? undefined : form.url.trim(),
        command: stdio ? form.command.trim() : undefined,
        args: stdio ? parseLines(form.argsText) : undefined,
        env: stdio ? parseKeyVals(form.envText) : undefined,
        clientId: stdio ? undefined : (form.clientId.trim() || undefined),
        clientSecret: stdio ? undefined : (form.clientSecret.trim() || undefined),
        bearerToken: stdio ? undefined : (form.bearerToken.trim() || undefined),
        headers: stdio ? undefined : parseKeyVals(form.headers),
      });
      resetForm(); setJsonText("");
      if (r.needsAuth) {
        setMsg(t("remote.msgAddedNeedsAuth"));
        await authorize(r.id);
        return;
      }
      setMsg(t("remote.msgAddedDiscovered", { n: r.discovered }));
      q.reload();
    } catch (e: any) {
      setMsg(e?.message ?? t("remote.msgAddFail"));
    } finally { setBusy(false); }
  };

  const remove = async (id: string, name: string) => {
    if (!confirm(t("remote.deleteConfirm", { name }))) return;
    await Remote.remove(id);
    q.reload();
  };

  const rediscover = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await Remote.rediscover();
      setMsg(t("remote.msgRediscovered", { n: r.seeded }));
      q.reload();
    } catch (e: any) { setMsg(e?.message ?? t("remote.msgRediscoverFail")); }
    finally { setBusy(false); }
  };

  const servers = q.data?.servers ?? [];

  return (
    <div className="frame">
      <PageHead
        eyebrow={t("remote.eyebrow")}
        title={t("remote.title")}
        lede={<>{t("remote.ledePre")}<strong>{t("remote.ledeRemote")}</strong>{t("remote.ledeAnd")}<strong>{t("remote.ledeStdio")}</strong>{t("remote.ledePost")}</>}
        actions={<>
          <button className="btn ghost" onClick={rediscover} disabled={busy}>{t("remote.rediscover")}</button>
        </>}
      />

      {(() => {
        const clientUrl = `${window.location.origin}/mcp`;
        return (
          <div className="hint-box" style={{ marginBottom: 14 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("remote.clientConnectTitle")}</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
              <code style={{ fontSize: 14 }}>{clientUrl}</code>
              <button
                className="btn ghost sm"
                onClick={e => {
                  navigator.clipboard?.writeText(clientUrl);
                  const b = e.currentTarget; const o = b.textContent;
                  b.textContent = t("remote.copied"); setTimeout(() => { b.textContent = o; }, 1200);
                }}
              >{t("remote.copy")}</button>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-3)" }}>{t("remote.clientConnectHint")}</div>
          </div>
        );
      })()}

      {msg && <div className="hint-box" style={{ marginBottom: 14 }}>{msg}</div>}

      {q.loading && <div className="card"><div className="card-body" style={{ color: "var(--text-3)" }}>{t("common.loading")}</div></div>}

      {servers.length === 0 && !q.loading && (
        <div className="card"><div className="card-body" style={{
          color: "var(--text-3)", textAlign: "center", padding: 32,
        }}>{t("remote.empty")}</div></div>
      )}

      {servers.map(s => (
        <article key={s.id} className="rcard">
          <div>
            <div className="rh">
              <span className="nm">{s.name}</span>
              <span className="id">{s.id}</span>
              <span className={`tag ${s.status === "online" || s.status === "ok" ? "ok" : s.needsAuth ? "warn" : "err"}`}>
                {s.status === "online" || s.status === "ok" ? "ONLINE" : s.needsAuth ? t("remote.pendingAuth") : s.status.toUpperCase()}
              </span>
              <span className="tag line">{s.transport === "stdio" ? t("remote.localStdio") : authModeLabel(s, t)}</span>
            </div>
            <div className="url">{s.url}</div>
            <div className="meta">
              <span><span className="k">{t("remote.toolCountK")}</span>{s.toolCount}</span>
            </div>
            {s.lastError && !s.needsAuth && (
              <div className="err"><strong>{t("remote.errorPrefix")}</strong>{s.lastError}</div>
            )}
            {showCfg === s.id && (
              <>
                <div className="meta" style={{ color: "var(--text-3)", margin: "4px 0" }}>{t("remote.upstreamCfgCaption")}</div>
                <pre className="cfg-json">{serverConfigJson(s)}</pre>
              </>
            )}
          </div>
          <div className="ops">
            {(s.needsAuth || (s.authMode === "oauth" && !s.oauthAuthorized)) && (
              <button className="btn primary sm" disabled={busy} onClick={() => authorize(s.id)}>{t("remote.authorize")}</button>
            )}
            {s.authMode === "oauth" && s.oauthAuthorized && !s.needsAuth && (
              <button className="btn ghost sm" disabled={busy} onClick={() => authorize(s.id)} title={t("remote.reauthorizeTitle")}>{t("remote.reauthorize")}</button>
            )}
            <button className="btn ghost sm" onClick={() => setShowCfg(c => c === s.id ? null : s.id)}>
              {showCfg === s.id ? t("remote.hideConfig") : t("remote.viewConfig")}
            </button>
            <button className="btn danger sm" onClick={() => remove(s.id, s.name)}>{t("common.delete")}</button>
          </div>
        </article>
      ))}

      {/* 添加表单 —— 支持远程 URL（claude.ai 连接器）+ 本机 stdio 托管 */}
      <section className="add-remote">
        <h3>{t("remote.addTitle")}</h3>

        {/* ① 粘贴 JSON 自动填表（推荐入口，视觉上突出） */}
        <div className="import-panel">
          <div className="step">
            <span className="step-no">1</span>
            <div>
              <div className="step-title">{t("remote.step1Title")}</div>
              <div className="step-sub">{t("remote.step1SubA")}<code>mcpServers</code>{t("remote.step1SubB")}</div>
            </div>
          </div>
          <textarea className="import-box" rows={9} value={jsonText} onChange={e => setJsonText(e.target.value)}
            placeholder={form.transport === "stdio" ? STDIO_EXAMPLE : HTTP_EXAMPLE} />
          <div className="import-actions">
            <button className="btn primary sm" type="button" onClick={importJson} disabled={!jsonText.trim()}>{t("remote.parseFill")}</button>
            {jsonText.trim() && <button className="btn ghost sm" type="button" onClick={() => setJsonText("")}>{t("common.clear")}</button>}
          </div>
        </div>

        {/* ② 手动填写 / 核对（导入后这里会被自动填好） */}
        <div className="step" style={{ marginTop: 22, marginBottom: 12 }}>
          <span className="step-no">2</span>
          <div>
            <div className="step-title">{t("remote.step2Title")}</div>
            <div className="step-sub">{t("remote.step2Sub")}</div>
          </div>
        </div>

        <div className="seg" style={{ marginBottom: 14 }}>
          <button type="button" className={`seg-btn ${form.transport === "http" ? "on" : ""}`} onClick={() => setTransport("http")}>
            {t("remote.segHttp")}
          </button>
          <button type="button" className={`seg-btn ${form.transport === "stdio" ? "on" : ""}`} onClick={() => setTransport("stdio")}>
            {t("remote.segStdio")}
          </button>
        </div>

        <div className="form-grid">
          <div className="field">
            <label>{t("remote.nameLabel")}</label>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder={t("remote.namePlaceholder")} />
          </div>

          {form.transport === "http" ? <>
            <div className="field">
              <label>{t("remote.urlLabel")}</label>
              <input value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} placeholder="https://.../mcp" />
            </div>
            <div className="field">
              <label>{t("remote.clientIdLabel")}</label>
              <input value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))} placeholder={t("remote.clientIdPlaceholder")} />
            </div>
            <div className="field">
              <label>{t("remote.clientSecretLabel")}</label>
              <input type="password" value={form.clientSecret} onChange={e => setForm(f => ({ ...f, clientSecret: e.target.value }))} placeholder={t("remote.clientSecretPlaceholder")} />
            </div>
            <div className="field full">
              <label>{t("remote.bearerLabel")}</label>
              <input type="password" value={form.bearerToken} onChange={e => setForm(f => ({ ...f, bearerToken: e.target.value }))} placeholder={t("remote.bearerPlaceholder")} />
            </div>
            <div className="field full">
              <label>{t("remote.headersLabel")}</label>
              <textarea rows={4} value={form.headers}
                onChange={e => setForm(f => ({ ...f, headers: e.target.value }))}
                placeholder={t("remote.headersPlaceholder")}
                style={{ fontFamily: "var(--mono)", fontSize: 12.5, resize: "vertical" }} />
            </div>
          </> : <>
            <div className="field">
              <label>{t("remote.commandLabel")}</label>
              <input value={form.command} onChange={e => setForm(f => ({ ...f, command: e.target.value }))}
                placeholder="npx / uvx / python" style={{ fontFamily: "var(--mono)" }} />
            </div>
            <div className="field full">
              <label>{t("remote.argsLabel")}</label>
              <textarea rows={4} value={form.argsText}
                onChange={e => setForm(f => ({ ...f, argsText: e.target.value }))}
                placeholder={t("remote.argsPlaceholder")}
                style={{ fontFamily: "var(--mono)", fontSize: 12.5, resize: "vertical" }} />
            </div>
            <div className="field full">
              <label>{t("remote.envLabel")}</label>
              <textarea rows={4} value={form.envText}
                onChange={e => setForm(f => ({ ...f, envText: e.target.value }))}
                placeholder={t("remote.envPlaceholder")}
                style={{ fontFamily: "var(--mono)", fontSize: 12.5, resize: "vertical" }} />
            </div>
          </>}
        </div>

        <div className="form-actions">
          <span style={{ color: "var(--text-3)", fontSize: 12.5, marginRight: "auto" }}>
            {form.transport === "http" ? t("remote.hintHttp") : t("remote.hintStdio")}
          </span>
          <button className="btn primary"
            disabled={busy || !form.name.trim() || (form.transport === "http" ? !form.url.trim() : !form.command.trim())}
            onClick={submit}>
            {busy ? t("remote.processing") : t("remote.addDiscover")}
          </button>
        </div>
      </section>
    </div>
  );
}

// 导入框占位示例：随下方传输方式切换，纯视觉用（解析时仍按内容自动识别）。
const HTTP_EXAMPLE = `{
  "mcpServers": {
    "context7": {
      "serverUrl": "https://mcp.context7.com/mcp",
      "headers": {
        "CONTEXT7_API_KEY": "***"
      }
    }
  }
}`;
const STDIO_EXAMPLE = `{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "some-mcp-server"],
      "env": {
        "API_KEY": "your-key"
      }
    }
  }
}`;

function authModeLabel(s: RemoteServer, t: (k: string) => string): string {
  switch (s.authMode) {
    case "oauth": return s.oauthAuthorized ? t("remote.authOauthAuthorized") : "OAuth";
    case "bearer": return "Bearer";
    case "bearer-env": return "Bearer(env)";
    default: return s.needsAuth ? "OAuth" : t("remote.authOpen");
  }
}
