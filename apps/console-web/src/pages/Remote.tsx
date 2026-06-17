import { useEffect, useState } from "react";
import { Remote } from "@/lib/api";
import { useAsync } from "@/hooks/useAsync";
import type { RemoteServer } from "@/types/api";
import PageHead from "@/components/PageHead";

// 接入表单对齐 claude.ai 连接器：Name + URL 必填；OAuth Client ID/Secret 可选。
// 三种鉴权自动适配：①开放服务器直连 ②OAuth 动态注册（DCR）→ 跳转授权
// ③OAuth 预注册客户端（填 ID/Secret）→ 跳转授权。另保留静态 Bearer Token（高级）。
export default function RemotePage() {
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
    if (oauth === "ok") setMsg(`授权完成 ✓ 已重新发现「${p.get("server") ?? ""}」的工具，去技能页启用它们。`);
    else setMsg(`授权失败：${p.get("msg") ?? "未知错误"}`);
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
      setMsg("已有有效授权 ✓");
      q.reload();
    } catch (e: any) {
      setMsg(`发起授权失败：${e?.message ?? "未知错误"}`);
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
      if (!entries.length) throw new Error("没找到 mcpServers 条目");
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
        setMsg(`已识别为本地 stdio 服务器「${key}」，已填入命令/参数/环境变量。`);
      } else if (remoteUrl) {
        const headersText = Object.entries(cfg.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n");
        setForm(f => ({ ...f, name: f.name || key, transport: "http", url: String(remoteUrl), headers: headersText }));
        setMsg(`已识别为远程服务器「${key}」，已填入 URL${headersText ? "/请求头" : ""}。`);
      } else {
        throw new Error("既没有 command 也没有 serverUrl/url");
      }
    } catch (e: any) {
      setMsg(`JSON 解析失败：${e?.message ?? "格式不对"}`);
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
        setMsg("已添加，该服务器要求 OAuth 授权，正在跳转…");
        await authorize(r.id);
        return;
      }
      setMsg(`已添加 · 发现 ${r.discovered} 个工具`);
      q.reload();
    } catch (e: any) {
      setMsg(e?.message ?? "添加失败");
    } finally { setBusy(false); }
  };

  const remove = async (id: string, name: string) => {
    if (!confirm(`删除远程服务器「${name}」？这会同时清理其孤儿技能。`)) return;
    await Remote.remove(id);
    q.reload();
  };

  const rediscover = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await Remote.rediscover();
      setMsg(`重新发现完成 · 共 ${r.seeded} 个工具`);
      q.reload();
    } catch (e: any) { setMsg(e?.message ?? "重新发现失败"); }
    finally { setBusy(false); }
  };

  const servers = q.data?.servers ?? [];

  return (
    <div className="frame">
      <PageHead
        eyebrow="CONNECT · 接入"
        title="MCP 接入"
        lede={<>把第三方 MCP 并入本中枢——支持<strong>远程 URL 中转</strong>和<strong>本机 stdio 托管</strong>两种方式。接入的工具会出现在技能页（默认按服务器自动成组）。</>}
        actions={<>
          <button className="btn ghost" onClick={rediscover} disabled={busy}>↻ 重新发现</button>
        </>}
      />

      {msg && <div className="hint-box" style={{ marginBottom: 14 }}>{msg}</div>}

      {q.loading && <div className="card"><div className="card-body" style={{ color: "var(--text-3)" }}>载入中…</div></div>}

      {servers.length === 0 && !q.loading && (
        <div className="card"><div className="card-body" style={{
          color: "var(--text-3)", textAlign: "center", padding: 32,
        }}>尚未接入任何远程服务器。在下面填写后点「添加并发现」。</div></div>
      )}

      {servers.map(s => (
        <article key={s.id} className="rcard">
          <div>
            <div className="rh">
              <span className="nm">{s.name}</span>
              <span className="id">{s.id}</span>
              <span className={`tag ${s.status === "online" || s.status === "ok" ? "ok" : s.needsAuth ? "warn" : "err"}`}>
                {s.status === "online" || s.status === "ok" ? "ONLINE" : s.needsAuth ? "待授权" : s.status.toUpperCase()}
              </span>
              <span className="tag line">{s.transport === "stdio" ? "本机 stdio" : authModeLabel(s)}</span>
            </div>
            <div className="url">{s.url}</div>
            <div className="meta">
              <span><span className="k">工具数</span>{s.toolCount}</span>
            </div>
            {s.lastError && !s.needsAuth && (
              <div className="err"><strong>错误：</strong>{s.lastError}</div>
            )}
            {showCfg === s.id && (
              <pre className="cfg-json">{serverConfigJson(s)}</pre>
            )}
          </div>
          <div className="ops">
            {(s.needsAuth || (s.authMode === "oauth" && !s.oauthAuthorized)) && (
              <button className="btn primary sm" disabled={busy} onClick={() => authorize(s.id)}>去授权 →</button>
            )}
            {s.authMode === "oauth" && s.oauthAuthorized && !s.needsAuth && (
              <button className="btn ghost sm" disabled={busy} onClick={() => authorize(s.id)} title="刷新/重新授权">重新授权</button>
            )}
            <button className="btn ghost sm" onClick={() => setShowCfg(c => c === s.id ? null : s.id)}>
              {showCfg === s.id ? "隐藏配置" : "查看配置"}
            </button>
            <button className="btn danger sm" onClick={() => remove(s.id, s.name)}>删除</button>
          </div>
        </article>
      ))}

      {/* 添加表单 —— 支持远程 URL（claude.ai 连接器）+ 本机 stdio 托管 */}
      <section className="add-remote">
        <h3>添加 MCP 服务器</h3>

        {/* ① 粘贴 JSON 自动填表（推荐入口，视觉上突出） */}
        <div className="import-panel">
          <div className="step">
            <span className="step-no">1</span>
            <div>
              <div className="step-title">粘贴 JSON 配置，自动填好下面的表单（推荐）</div>
              <div className="step-sub">直接复制 MCP 文档里的 <code>mcpServers</code> 配置——自动识别远程 URL / 本机 stdio。</div>
            </div>
          </div>
          <textarea className="import-box" rows={9} value={jsonText} onChange={e => setJsonText(e.target.value)}
            placeholder={form.transport === "stdio" ? STDIO_EXAMPLE : HTTP_EXAMPLE} />
          <div className="import-actions">
            <button className="btn primary sm" type="button" onClick={importJson} disabled={!jsonText.trim()}>解析并填到下方 ↓</button>
            {jsonText.trim() && <button className="btn ghost sm" type="button" onClick={() => setJsonText("")}>清空</button>}
          </div>
        </div>

        {/* ② 手动填写 / 核对（导入后这里会被自动填好） */}
        <div className="step" style={{ marginTop: 22, marginBottom: 12 }}>
          <span className="step-no">2</span>
          <div>
            <div className="step-title">核对 / 手动填写，然后添加</div>
            <div className="step-sub">先选传输方式，再填对应字段。上面导入后这里会自动带出来。</div>
          </div>
        </div>

        <div className="seg" style={{ marginBottom: 14 }}>
          <button type="button" className={`seg-btn ${form.transport === "http" ? "on" : ""}`} onClick={() => setTransport("http")}>
            远程 URL（中转）
          </button>
          <button type="button" className={`seg-btn ${form.transport === "stdio" ? "on" : ""}`} onClick={() => setTransport("stdio")}>
            本机 stdio（在本服务器托管）
          </button>
        </div>

        <div className="form-grid">
          <div className="field">
            <label>名称 *</label>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="例：Notion MCP" />
          </div>

          {form.transport === "http" ? <>
            <div className="field">
              <label>Remote MCP server URL *</label>
              <input value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} placeholder="https://.../mcp" />
            </div>
            <div className="field">
              <label>OAuth Client ID（可选）</label>
              <input value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))} placeholder="预注册客户端 ID" />
            </div>
            <div className="field">
              <label>OAuth Client Secret（可选）</label>
              <input type="password" value={form.clientSecret} onChange={e => setForm(f => ({ ...f, clientSecret: e.target.value }))} placeholder="配合 Client ID 使用" />
            </div>
            <div className="field full">
              <label>Bearer Token（可选）</label>
              <input type="password" value={form.bearerToken} onChange={e => setForm(f => ({ ...f, bearerToken: e.target.value }))} placeholder="静态 token 服务器用，如 sk-..." />
            </div>
            <div className="field full">
              <label>自定义请求头（可选）</label>
              <textarea rows={4} value={form.headers}
                onChange={e => setForm(f => ({ ...f, headers: e.target.value }))}
                placeholder={"每行一个 Key: Value\n例（context7）：\nCONTEXT7_API_KEY: ctx7_xxx"}
                style={{ fontFamily: "var(--mono)", fontSize: 12.5, resize: "vertical" }} />
            </div>
          </> : <>
            <div className="field">
              <label>命令 command *</label>
              <input value={form.command} onChange={e => setForm(f => ({ ...f, command: e.target.value }))}
                placeholder="npx / uvx / python" style={{ fontFamily: "var(--mono)" }} />
            </div>
            <div className="field full">
              <label>参数 args（可选）</label>
              <textarea rows={4} value={form.argsText}
                onChange={e => setForm(f => ({ ...f, argsText: e.target.value }))}
                placeholder={"每行一个参数\n例：\n-y\n@modelcontextprotocol/server-name"}
                style={{ fontFamily: "var(--mono)", fontSize: 12.5, resize: "vertical" }} />
            </div>
            <div className="field full">
              <label>环境变量 env（可选）</label>
              <textarea rows={4} value={form.envText}
                onChange={e => setForm(f => ({ ...f, envText: e.target.value }))}
                placeholder={"每行一个 Key: Value\n例：\nAPI_KEY: your-key\nBASE_URL: https://api.example.com"}
                style={{ fontFamily: "var(--mono)", fontSize: 12.5, resize: "vertical" }} />
            </div>
          </>}
        </div>

        <div className="form-actions">
          <span style={{ color: "var(--text-3)", fontSize: 12.5, marginRight: "auto" }}>
            {form.transport === "http"
              ? "开放服务器直接连；要求 OAuth 的服务器添加后会自动跳转授权登录。"
              : "在本 VPS 上拉起子进程托管，工具远程暴露给已连接的 AI。需服务器已装好对应运行时（node/npx、uv/uvx、python 等）。"}
          </span>
          <button className="btn primary"
            disabled={busy || !form.name.trim() || (form.transport === "http" ? !form.url.trim() : !form.command.trim())}
            onClick={submit}>
            {busy ? "处理中…" : "添加并发现"}
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

function authModeLabel(s: RemoteServer): string {
  switch (s.authMode) {
    case "oauth": return s.oauthAuthorized ? "OAuth · 已授权" : "OAuth";
    case "bearer": return "Bearer";
    case "bearer-env": return "Bearer(env)";
    default: return s.needsAuth ? "OAuth" : "开放";
  }
}
