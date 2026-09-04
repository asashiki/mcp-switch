import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Agents, Health, Remote, Skills } from "@/lib/api";
import {
  registerSwitchWebMcpTools,
  WEBMCP_DIAGNOSTICS_EVENT,
  WEBMCP_DIAGNOSTICS_KEY,
  WEBMCP_DRAFT_EVENT,
  WEBMCP_DRAFT_KEY,
  type RemoteServerDraft,
  type WebMcpModelContext,
} from "@/webmcp/control-plane";

function getModelContext(): WebMcpModelContext | null {
  const value = (document as Document & { modelContext?: unknown }).modelContext;
  if (!value || typeof (value as WebMcpModelContext).registerTool !== "function") return null;
  return value as WebMcpModelContext;
}

/** Register site tools after authentication without adding permanent UI. */
export default function WebMcpBridge() {
  const navigate = useNavigate();

  useEffect(() => {
    const modelContext = getModelContext();
    if (!modelContext) return;

    const controller = new AbortController();
    void registerSwitchWebMcpTools(modelContext, {
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
      if (!controller.signal.aborted && result.failures.length) {
        console.warn("Some WebMCP tools could not be registered", result.failures);
      }
    });

    return () => controller.abort();
  // The registered callbacks use react-router's stable navigate function. Tools
  // intentionally read window.location at execution time, so route changes do
  // not cause duplicate registrations.
  }, [navigate]);

  return null;
}
