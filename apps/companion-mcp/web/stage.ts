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
let last = "",
  generation = 0;
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
  for (let attempt = 0; attempt < 60 && epoch === generation; attempt++) {
    if (!["queued", "running"].includes(job.status) || !allowed(job.pollUrl))
      return;
    await new Promise((r) => setTimeout(r, 2500));
    if (epoch !== generation) return;
    if (document.hidden) continue;
    try {
      const response = await fetch(job.pollUrl, {
        credentials: "omit",
        signal: AbortSignal.timeout(10_000),
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
function render(input: unknown) {
  if (!input || typeof input !== "object") return;
  const data = input as { scene?: Scene; job?: Job } & Partial<Scene>;
  const s = data.scene ?? data;
  if (typeof s.sessionId !== "string" || typeof s.name !== "string") return;
  const key = JSON.stringify(input);
  if (key === last) return;
  last = key;
  const epoch = ++generation;
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
app.ontoolresult = (result) => render(result.structuredContent);
app.onhostcontextchanged = (context) => {
  if (context.theme) document.documentElement.style.colorScheme = context.theme;
  if (context.styles?.variables)
    applyHostStyleVariables(context.styles.variables);
};
// Standard bridge owns the host connection; legacy globals are a read-only fallback.
const win = window as Window & { openai?: { toolOutput?: unknown } };
if (win.openai?.toolOutput) render(win.openai.toolOutput);
window.addEventListener("openai:set_globals", () =>
  render(win.openai?.toolOutput),
);
if (window.parent !== window) {
  window.addEventListener("message", (event) => {
    if (
      event.source === window.parent &&
      event.origin === location.origin &&
      event.data?.type === "companion-local-preview"
    ) {
      document.documentElement.dataset.preview = "true";
      render(event.data.result);
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
window.addEventListener("pagehide", () => {
  generation++;
});
// Local settings preview only; a cross-origin MCP host uses the SDK resize bridge.
new ResizeObserver(() => {
  if (window.parent !== window)
    window.parent.postMessage(
      {
        type: "companion-preview-resize",
        height:
          document.querySelector("main")!.getBoundingClientRect().height + 8,
      },
      location.origin,
    );
}).observe(document.querySelector("main")!);
