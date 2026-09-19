import { App, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
type Scene = {
  sessionId: string;
  revision: number;
  name: string;
  sceneName: string;
  line: string;
  spriteUrl?: string;
  backgroundUrl?: string;
};
type Job = {
  id: string;
  status: string;
  imageUrl?: string;
  pollUrl?: string;
  error?: string;
};
const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
let last = "", generation = 0, standardReceived = false, disposed = false;
let pollController: AbortController | null = null;
const allowed = (url: unknown): url is string =>
  typeof url === "string" && /^https?:\/\//.test(url);
function setImage(selector: string, url?: string) {
  const el = $<HTMLImageElement>(selector);
  if (!allowed(url)) {
    el.hidden = true;
    el.removeAttribute("src");
    return;
  }
  if (el.getAttribute("src") !== url) el.src = url;
  el.hidden = false;
}
for (const selector of [".background", ".portrait", ".cg"])
  $(selector).addEventListener("error", () => {
    $(selector).hidden = true;
    $(".status").textContent = "图片暂时无法显示。可以让 AI 重新打开这一幕。";
  });
function showJob(job: Job) {
  if (job.status === "succeeded" && job.imageUrl) {
    setImage(".cg", job.imageUrl);
    $(".stage").classList.add("has-art");
    $(".status").textContent = "";
  } else
    $(".status").textContent =
      job.status === "queued" || job.status === "running"
        ? "正在绘制这一幕，你可以继续聊天。"
        : job.error || "插画未完成。";
}
async function poll(job: Job, epoch: number) {
  const controller = new AbortController(); pollController = controller;
  const signal = controller.signal;
  for (let attempt = 0; attempt < 60 && epoch === generation; attempt++) {
    if (!["queued", "running"].includes(job.status) || !allowed(job.pollUrl))
      return;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, 2500);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
    if (epoch !== generation) return;
    if (document.hidden) continue;
    try {
      const response = await fetch(job.pollUrl, {
        credentials: "omit",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok) throw new Error();
      job = (await response.json()) as Job;
      if (epoch !== generation) return;
      showJob(job);
    } catch {
      if (epoch === generation)
        $(".status").textContent = "暂时无法更新进度，请稍后让 AI 查询这一幕。";
      return;
    }
  }
  if (epoch === generation && ["queued", "running"].includes(job.status))
    $(".status").textContent = "仍在等待插画，请稍后让 AI 查询进度。";
}
function render(input: unknown, source: "standard" | "legacy" | "preview" = "standard") {
  if (disposed || (source === "legacy" && standardReceived)) return;
  if (typeof input === "string") { try { input = JSON.parse(input); } catch { return; } }
  if (!input || typeof input !== "object") return;
  const data = input as { scene?: Scene; job?: Job } & Partial<Scene>;
  const s = data.scene ?? data;
  if (typeof s.sessionId !== "string" || typeof s.name !== "string") return;
  if (source === "standard") standardReceived = true;
  const key = JSON.stringify({ sessionId:s.sessionId, revision:s.revision, name:s.name,
    sceneName:s.sceneName, line:s.line, spriteUrl:s.spriteUrl, backgroundUrl:s.backgroundUrl, job:data.job });
  if (key === last) return;
  last = key;
  const epoch = ++generation;
  pollController?.abort();
  $(".name").textContent = s.name;
  $(".scene").textContent = s.sceneName ?? "";
  $(".line").textContent = s.line ?? "";
  $(".status").textContent = "";
  setImage(".background", s.backgroundUrl);
  setImage(".portrait", s.spriteUrl);
  setImage(".cg");
  $(".stage").classList.toggle("has-art", !!(s.backgroundUrl || s.spriteUrl));
  $("#toggle").hidden = false;
  if (data.job) {
    showJob(data.job);
    void poll(data.job, epoch);
  }
}
$("#toggle").onclick = () => {
  const collapsed = document.body.classList.toggle("collapsed");
  $("#toggle").textContent = collapsed ? "展开" : "收起";
};
const app = new App({ name: "companion-stage", version: "0.1.0" });
app.ontoolresult = (result) => {
  if (disposed) return;
  if (result.isError) {
    $(".status").textContent = "场景更新失败，请让 AI 查看工具错误。";
    return;
  }
  if (result.structuredContent) render(result.structuredContent);
  else for (const block of result.content ?? []) {
    if (block.type === "text") {
      try { const value = JSON.parse(block.text); if (value?.sessionId || value?.scene?.sessionId) { render(value); break; } } catch {}
    }
  }
};
app.onhostcontextchanged = (context) => {
  if (context.theme) document.documentElement.style.colorScheme = context.theme;
  if (context.styles?.variables)
    applyHostStyleVariables(context.styles.variables);
};
// Standard bridge owns the host connection; legacy globals are a read-only fallback.
const win = window as Window & { openai?: { toolOutput?: unknown } };
const legacy = (event?: Event) => {
  const globals = (event as CustomEvent | undefined)?.detail?.globals;
  render(globals?.toolOutput ?? win.openai?.toolOutput, "legacy");
};
legacy();
window.addEventListener("openai:set_globals", legacy);
if (window.parent !== window) {
  window.addEventListener("message", (event) => {
    if (
      event.source === window.parent &&
      event.origin === location.origin &&
      event.data?.type === "companion-local-preview"
    ) {
      document.documentElement.dataset.preview = "true";
      render(event.data.result, "preview");
    }
  });
  void app
    .connect()
    .then(() => {
      const context = app.getHostContext();
      if (context?.theme)
        document.documentElement.style.colorScheme = context.theme;
      if (context?.styles?.variables)
        applyHostStyleVariables(context.styles.variables);
    })
    .catch(() => {});
}
const dispose = () => {
  disposed = true; generation++; pollController?.abort(); previewResize.disconnect();
  window.removeEventListener("openai:set_globals", legacy);
};
app.onteardown = () => { dispose(); return {}; };
window.addEventListener("pagehide", dispose, { once: true });
// Local settings preview only; a cross-origin MCP host uses the SDK resize bridge.
const previewResize = new ResizeObserver(() => {
  if (window.parent !== window)
    window.parent.postMessage(
      {
        type: "companion-preview-resize",
        height:
          document.querySelector("main")!.getBoundingClientRect().height + 8,
      },
      location.origin,
    );
});
previewResize.observe(document.querySelector("main")!);
