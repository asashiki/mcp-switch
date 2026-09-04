import { useEffect, useMemo, useRef, useState } from "react";
import { Remote } from "@/lib/api";
import type { AppComponentDiagnostic, AppDiagnostics, AppPreview } from "@/types/api";
import { useT } from "@/i18n";

function safeCspSources(values: string[]): string[] {
  return values.filter((value) => /^https:\/\/[A-Za-z0-9.*_-]+(?::\d+)?$/.test(value));
}

function safeJson(value: unknown): string {
  return JSON.stringify(value ?? {})
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function previewDocument(html: string, component: AppComponentDiagnostic, sample: unknown): string {
  const resources = safeCspSources(component.csp.resourceDomains);
  const connects = safeCspSources(component.csp.connectDomains);
  const frames = safeCspSources(component.csp.frameDomains);
  const policy = [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${resources.join(" ")}`,
    `style-src 'unsafe-inline' ${resources.join(" ")}`,
    `img-src data: blob: ${resources.join(" ")}`,
    `media-src data: blob: ${resources.join(" ")}`,
    `font-src data: ${resources.join(" ")}`,
    `connect-src ${connects.length ? connects.join(" ") : "'none'"}`,
    `frame-src ${frames.length ? frames.join(" ") : "'none'"}`,
    "base-uri 'none'",
    "form-action 'none'"
  ].join("; ");
  const injected = `<meta http-equiv="Content-Security-Policy" content="${policy.replace(/"/g, "&quot;")}">` +
    `<script>window.openai={toolOutput:${safeJson(sample)}};</script>`;
  return /<head(?:\s[^>]*)?>/i.test(html)
    ? html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${injected}`)
    : `${injected}${html}`;
}

function prettyBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export default function AppLab({ serverName, diagnostics }: {
  serverName: string;
  diagnostics: AppDiagnostics;
}) {
  const t = useT();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selected = diagnostics.components[selectedIndex] ?? null;
  const [preview, setPreview] = useState<AppPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [sampleText, setSampleText] = useState("{}");
  const [renderSample, setRenderSample] = useState<unknown>({});
  const [previewRevision, setPreviewRevision] = useState(0);
  const [iframeHeight, setIframeHeight] = useState(480);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const renderSampleRef = useRef(renderSample);
  const selectedUriRef = useRef(selected?.upstreamUri ?? null);

  useEffect(() => { renderSampleRef.current = renderSample; }, [renderSample]);
  useEffect(() => {
    selectedUriRef.current = selected?.upstreamUri ?? null;
    const sample = selected?.sampleStructuredContent ?? {};
    setSampleText(JSON.stringify(sample, null, 2));
    setRenderSample(sample);
    setPreview(null);
    setPreviewError(null);
    setIframeHeight(480);
  }, [selected?.toolName]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const message = event.data as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
      if (!message || message.jsonrpc !== "2.0") return;
      if (message.method === "ui/initialize" && (typeof message.id === "number" || typeof message.id === "string")) {
        iframeRef.current.contentWindow?.postMessage({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2026-01-26",
            hostInfo: { name: "MCP Switch App Lab", version: "0.2.0" },
            hostCapabilities: {},
            hostContext: { locale: navigator.language, theme: document.documentElement.dataset.theme ?? "light" }
          }
        }, "*");
        window.setTimeout(() => sendToolResult(renderSampleRef.current), 30);
      }
      if (message.method === "ui/notifications/size-changed") {
        const height = Number((message.params as { height?: unknown } | null)?.height);
        if (Number.isFinite(height)) setIframeHeight(Math.min(Math.max(Math.ceil(height), 220), 760));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const sendToolResult = (sample: unknown) => {
    iframeRef.current?.contentWindow?.postMessage({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { structuredContent: sample, content: [{ type: "text", text: JSON.stringify(sample) }] }
    }, "*");
  };

  const loadPreview = async () => {
    if (!selected) return;
    const requestedUri = selected.upstreamUri;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const loaded = await Remote.appPreview(diagnostics.serverId, requestedUri);
      if (selectedUriRef.current === requestedUri) setPreview(loaded);
    } catch (error) {
      if (selectedUriRef.current === requestedUri) {
        setPreviewError(error instanceof Error ? error.message : t("appLab.previewFailed"));
      }
    } finally {
      if (selectedUriRef.current === requestedUri) setPreviewLoading(false);
    }
  };

  const applySample = () => {
    try {
      const parsed = JSON.parse(sampleText);
      setRenderSample(parsed);
      setPreviewError(null);
      setPreviewRevision((value) => value + 1);
      window.setTimeout(() => sendToolResult(parsed), 50);
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : t("appLab.invalidJson"));
    }
  };

  const documentHtml = useMemo(
    () => preview && selected ? previewDocument(preview.html, selected, renderSample) : "",
    [preview, selected, renderSample, previewRevision]
  );

  const statusClass = diagnostics.status === "error" ? "err"
    : diagnostics.status === "warning" ? "warn"
      : diagnostics.status === "pass" ? "ok" : "line";

  return (
    <section className="app-lab">
      <div className="app-lab-head">
        <h4>{t("appLab.title", { server: serverName })}</h4>
        <div className="app-lab-summary">
          <span className={`tag ${statusClass}`}>{t(`appLab.status.${diagnostics.status}`)}</span>
          <span>{t("appLab.uiTools", { n: diagnostics.uiToolCount })}</span>
          <span>{t("appLab.resources", { n: diagnostics.appResourceCount })}</span>
        </div>
      </div>

      {diagnostics.components.length === 0 ? (
        <div className="app-lab-empty">{t("appLab.noComponents")}</div>
      ) : (
        <>
          <div className="app-lab-tabs" role="tablist">
            {diagnostics.components.map((component, index) => (
              <button key={`${component.toolName}-${component.upstreamUri}`} className={index === selectedIndex ? "on" : ""}
                onClick={() => { selectedUriRef.current = component.upstreamUri; setSelectedIndex(index); }}
                role="tab" aria-selected={index === selectedIndex}>
                {component.toolTitle ?? component.toolName}
              </button>
            ))}
          </div>

          {selected && <div className="app-lab-grid">
            <div className="app-lab-inspector">
              <div className="app-lab-facts">
                <div><span>{t("appLab.bridge")}</span><strong>{selected.bridge}</strong></div>
                <div><span>{t("appLab.mime")}</span><strong>{selected.normalizedMimeType ?? "—"}</strong></div>
                <div><span>{t("appLab.size")}</span><strong>{prettyBytes(selected.htmlBytes)}</strong></div>
                <div><span>{t("appLab.output")}</span><strong>{selected.hasOutputSchema ? "outputSchema ✓" : "—"}</strong></div>
              </div>
              <div className="app-lab-uri"><span>{t("appLab.upstreamResource")}</span><code>{selected.upstreamUri}</code></div>
              <div className="app-lab-uri"><span>{t("appLab.proxyResource")}</span><code>{selected.proxyUri}</code></div>
              {selected.dedicatedDomain && <div className="app-lab-uri"><span>{t("appLab.domain")}</span><code>{selected.dedicatedDomain}</code></div>}

              <div className="app-checks">
                {selected.checks.map((check, index) => (
                  <div className={`app-check ${check.severity}`} key={`${check.code}-${index}`}>
                    <span className="app-check-mark">{check.severity === "error" ? "×" : check.severity === "warning" ? "!" : check.severity === "pass" ? "✓" : "i"}</span>
                    <div><code>{check.code}</code><p>{check.message}</p></div>
                  </div>
                ))}
                {diagnostics.checks.filter((check) => !check.toolName).map((check, index) => (
                  <div className={`app-check ${check.severity}`} key={`global-${check.code}-${index}`}>
                    <span className="app-check-mark">{check.severity === "error" ? "×" : check.severity === "warning" ? "!" : check.severity === "pass" ? "✓" : "i"}</span>
                    <div><code>{check.code}</code><p>{check.message}</p></div>
                  </div>
                ))}
              </div>
            </div>

            <div className="app-preview-panel">
              <div className="app-preview-toolbar">
                <div>
                  <strong>{t("appLab.previewTitle")}</strong>
                  <p>{t("appLab.previewWarning")}</p>
                </div>
                {!preview && <button className="btn secondary sm" disabled={previewLoading || !selected.resourceFound}
                  onClick={loadPreview}>{previewLoading ? t("common.loading") : t("appLab.loadPreview")}</button>}
              </div>
              {previewError && <div className="app-preview-error">{previewError}</div>}
              {preview && <>
                <iframe
                  key={`${preview.uri}-${previewRevision}`}
                  ref={iframeRef}
                  title={`${serverName} ${selected.toolName} preview`}
                  sandbox="allow-scripts"
                  srcDoc={documentHtml}
                  style={{ height: iframeHeight }}
                  onLoad={() => window.setTimeout(() => sendToolResult(renderSampleRef.current), 60)}
                />
                <div className="field app-sample">
                  <label>{t("appLab.sampleLabel")}</label>
                  <textarea rows={9} value={sampleText} onChange={(event) => setSampleText(event.target.value)} />
                  <button className="btn ghost sm" onClick={applySample}>{t("appLab.applySample")}</button>
                </div>
              </>}
            </div>
          </div>}
        </>
      )}
    </section>
  );
}
