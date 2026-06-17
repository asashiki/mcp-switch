// 极轻量的 HTML5 drag helper —— 不依赖第三方库
// 用法：onDragStart={dragStart("skill", id)} ；
//      onDrop={dragDrop("skill", (id) => move(id, to))}

export const dragStart = (kind: string, id: string) =>
  (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-mcp-switch", `${kind}:${id}`);
    e.currentTarget.classList.add("dragging");
  };

export const dragEnd = (e: React.DragEvent) => {
  e.currentTarget.classList.remove("dragging");
};

export const dragOver = (kind: string) =>
  (e: React.DragEvent) => {
    const t = e.dataTransfer.types;
    if (!t.includes("application/x-mcp-switch")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    e.currentTarget.classList.add("drag-over");
  };

export const dragLeave = (e: React.DragEvent) => {
  e.currentTarget.classList.remove("drag-over");
};

export const dragDrop = (kind: string, handler: (id: string) => void) =>
  (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData("application/x-mcp-switch");
    const [k, id] = (raw ?? "").split(":");
    // 只有真正匹配本 drop 区的类型时才消费 + 阻止冒泡，否则放行给外层
    // （否则技能行的 drop 会冒泡到 group-body 被追加到末尾，组内排序失效）。
    if (k !== kind || !id) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.classList.remove("drag-over");
    handler(id);
  };
