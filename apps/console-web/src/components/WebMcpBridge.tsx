import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Agents, Health, Remote, Skills } from "@/lib/api";
import { useT } from "@/i18n";
import {
  registerSwitchWebMcpTools,
  WEBMCP_DIAGNOSTICS_EVENT,
  WEBMCP_DIAGNOSTICS_KEY,
  WEBMCP_DRAFT_EVENT,
  WEBMCP_DRAFT_KEY,
  WEBMCP_TOOL_COUNT,
  type RemoteServerDraft,
  type WebMcpModelContext,
} from "@/webmcp/control-plane";

type RegistrationState =
  | { kind: "unsupported" }
  | { kind: "registering" }
  | { kind: "ready"; count: number }
  | { kind: "partial"; count: number; failures: number };

function getModelContext(): WebMcpModelContext | null {
  const value = (document as Document & { modelContext?: unknown }).modelContext;
  if (!value || typeof (value as WebMcpModelContext).registerTool !== "function") return null;
  return value as WebMcpModelContext;
}

/**
 * Registers top-level WebMCP site tools only after the console session has been
 * authenticated. Unsupported browsers get no badge and retain the normal SPA.
 */
export default function WebMcpBridge() {
  const navigate = useNavigate();
  const location = useLocation();
  const t = useT();
  const [state, setState] = useState<RegistrationState>(() =>
    getModelContext() ? { kind: "registering" } : { kind: "unsupported" },
  );

  useEffect(() => {
    const modelContext = getModelContext();
    if (!modelContext) {
      setState({ kind: "unsupported" });
      return;
    }

    const controller = new AbortController();
    setState({ kind: "registering" });
    registerSwitchWebMcpTools(modelContext, {
      listServers: (signal) => Remote.list(signal),
      listSkills: (signal) => Skills.list(signal),
      listAgents: (signal) => Agents.list(signal),
      getHealth: (signal) => Health.overview(signal),
      diagnoseApps: (serverId, signal) => Remote.appDiagnostics(serverId, signal),
      getConsoleContext: () => {
        const params = new URLSearchParams(window.location.search);
        return {
          route: window.location.pathname.replace(/^\/console/, "") || "/",
          focusedServerId: params.get("focus"),
          appLabOpen: params.get("appLab") === "1",
          draftPending: sessionStorage.getItem(WEBMCP_DRAFT_KEY) !== null,
        };
      },
      focusServer: (serverId, openAppLab, diagnostics) => {
        if (diagnostics) {
          sessionStorage.setItem(WEBMCP_DIAGNOSTICS_KEY, JSON.stringify(diagnostics));
          window.dispatchEvent(new CustomEvent(WEBMCP_DIAGNOSTICS_EVENT, { detail: diagnostics }));
        }
        const params = new URLSearchParams({ focus: serverId });
        if (openAppLab) params.set("appLab", "1");
        navigate(`/remote?${params.toString()}`);
      },
      stageRemoteServerDraft: (draft: RemoteServerDraft) => {
        sessionStorage.setItem(WEBMCP_DRAFT_KEY, JSON.stringify(draft));
        window.dispatchEvent(new CustomEvent(WEBMCP_DRAFT_EVENT, { detail: draft }));
        navigate("/remote?draft=webmcp");
      },
    }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setState(result.failures.length
        ? { kind: "partial", count: result.registered.length, failures: result.failures.length }
        : { kind: "ready", count: result.registered.length });
    });

    return () => controller.abort();
  // The registered callbacks use react-router's stable navigate function. Tools
  // intentionally read window.location at execution time, so route changes do
  // not cause duplicate registrations.
  }, [navigate]);

  if (state.kind === "unsupported") return null;

  const current = location.pathname === "/remote" ? t("webmcp.contextRemote") : t("webmcp.contextConsole");
  return (
    <aside className={`webmcp-bar ${state.kind === "partial" ? "warn" : ""}`} aria-live="polite">
      <span className="webmcp-mark" aria-hidden="true">AI</span>
      <div>
        <strong>{t("webmcp.title")}</strong>
        <span>
          {state.kind === "registering"
            ? t("webmcp.registering")
            : state.kind === "partial"
              ? t("webmcp.partial", { on: state.count, total: WEBMCP_TOOL_COUNT })
              : t("webmcp.ready", { n: state.count })}
          {" · "}{current}{" · "}{t("webmcp.draftSafety")}
        </span>
      </div>
    </aside>
  );
}
