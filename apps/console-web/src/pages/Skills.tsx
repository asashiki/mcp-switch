import { useEffect, useMemo, useRef, useState } from "react";
import { Skills, Agents, SkillGroups, Remote } from "@/lib/api";
import { useAsync } from "@/hooks/useAsync";
import type { Skill, Agent, SkillGroup, AgentVisibility } from "@/types/api";
import PageHead from "@/components/PageHead";
import Toggle from "@/components/Toggle";
import VisibilityDropdown from "@/components/VisibilityDropdown";
import Modal from "@/components/Modal";
import { dragStart, dragEnd, dragOver, dragLeave, dragDrop } from "@/lib/drag";
import { useT } from "@/i18n";
import { localeTag } from "@/i18n/locales";

// 可多选的过滤标签。三个维度：启用态(已启用/未启用) + 来源(本地/远程) + 读写(可读/写入)。
// 同维度内 OR，跨维度 AND；全不选 = 显示全部。
type FilterTag = "enabled" | "disabled" | "local" | "remote" | "read" | "write";
const FILTER_TAGS: { key: FilterTag; labelKey: string }[] = [
  // 「已启用」标签去掉——进页面默认就是看启用的技能，留它冗余。
  { key: "disabled", labelKey: "filter.disabled" },
  { key: "local", labelKey: "filter.local" },
  { key: "remote", labelKey: "filter.remote" },
  { key: "read", labelKey: "filter.read" },
  { key: "write", labelKey: "filter.write" },
];

export default function SkillsPage() {
  const t = useT();
  const skillsQ = useAsync(() => Skills.list(), []);
  const agentsQ = useAsync(() => Agents.list(), []);
  const groupsQ = useAsync(() => SkillGroups.list(), []);
  const serversQ = useAsync(() => Remote.list(), []);

  // 远程服务里「尚未完成授权」的 serverId 集合：这些服务下的技能不可启用。
  const authPendingServers = useMemo(() => {
    const set = new Set<string>();
    for (const s of serversQ.data?.servers ?? []) {
      if (s.needsAuth || (s.authMode === "oauth" && !s.oauthAuthorized)) set.add(s.id);
    }
    return set;
  }, [serversQ.data]);

  // serverId → 传输方式。技能的「本地/远程」标签据此判定：stdio 托管=本地，URL 中转=远程。
  const serverTransport = useMemo(() => {
    const m = new Map<string, "http" | "stdio">();
    for (const s of serversQ.data?.servers ?? []) m.set(s.id, s.transport === "stdio" ? "stdio" : "http");
    return m;
  }, [serversQ.data]);

  // 每个 agent 的可见性（白名单）—— 用于反推「这个技能对哪些 agent 可见」
  const [visMap, setVisMap] = useState<Record<string, AgentVisibility>>({});
  useEffect(() => {
    const agents = agentsQ.data?.agents;
    if (!agents) return;
    Promise.all(agents.map(a => Agents.getVisibility(a.agentId).catch(() => null)))
      .then(rs => {
        const m: Record<string, AgentVisibility> = {};
        rs.forEach((r, i) => { if (r) m[agents[i].agentId] = r; });
        setVisMap(m);
      });
  }, [agentsQ.data]);

  const [groups, setGroups] = useState<SkillGroup[]>([]);
  useEffect(() => {
    if (groupsQ.data) setGroups(groupsQ.data.groups);
  }, [groupsQ.data]);

  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Set<FilterTag>>(new Set());
  const [mgmtOpen, setMgmtOpen] = useState(false);

  const toggleFilter = (t: FilterTag) =>
    setFilters(prev => {
      const next = new Set(prev);
      next.has(t) ? next.delete(t) : next.add(t);
      return next;
    });

  const skills = skillsQ.data?.skills ?? [];
  const agents = agentsQ.data?.agents ?? [];

  const skillById = useMemo(() => {
    const m: Record<string, Skill> = {};
    skills.forEach(s => { m[s.skillId] = s; });
    return m;
  }, [skills]);

  // 计算 visibleSet：某 skillId 对哪些 agent 可见。
  // 对未开启 restricted 的 agent：技能默认全部可见。
  const visForSkill = (skillId: string): Set<string> => {
    const set = new Set<string>();
    for (const a of agents) {
      const v = visMap[a.agentId];
      if (!v || !v.restricted) set.add(a.agentId);
      else if (v.allowlist.includes(skillId)) set.add(a.agentId);
    }
    return set;
  };

  // 把 set 翻译回各 agent 的 visibility 变更
  const updateVisForSkill = async (skillId: string, next: Set<string>) => {
    for (const a of agents) {
      const v = visMap[a.agentId];
      const wantOn = next.has(a.agentId);
      const allowAll = !v || !v.restricted;
      const currentlyOn = allowAll || (v?.allowlist.includes(skillId));
      if (wantOn === currentlyOn && !(allowAll && !wantOn)) continue;

      let newList: string[];
      if (allowAll) {
        // 当前是「全部可见」，要把这一个 skill 隐藏 → 切到 restricted 模式
        // 把现有 enabled skills 全部塞进 allowlist，再排除当前 skill
        const base = (v?.enabledSkills ?? skills.filter(s => s.enabled).map(s => s.skillId));
        newList = base.filter(id => id !== skillId);
      } else {
        // 已经是 restricted，调整 allowlist
        const cur = new Set(v.allowlist);
        if (wantOn) cur.add(skillId); else cur.delete(skillId);
        newList = Array.from(cur);
      }
      const r = await Agents.setVisibility(a.agentId, newList);
      setVisMap(prev => ({
        ...prev,
        [a.agentId]: { ...prev[a.agentId], ...r, enabledSkills: prev[a.agentId]?.enabledSkills ?? [] },
      }));
    }
  };

  const toggleSkill = async (id: string, enabled: boolean) => {
    try {
      await Skills.setEnabled(id, enabled);
    } catch (e) {
      // 后端会在「远程服务未授权」时拒绝启用 → 提示用户先去授权。
      alert(e instanceof Error ? e.message : t("skills.enableFailed"));
    }
    skillsQ.reload();
  };

  // 分组折叠态（key：用户组=g.id，远程虚拟组=rmcp-<serverId>，未归类=__ungrouped__）。
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapse = (k: string) =>
    setCollapsed(p => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });

  // 一键开/关一组技能。开启时跳过「所属远程服务未授权」的技能（后端也会拒绝）。
  const groupAllOn = (sk: Skill[]) => sk.length > 0 && sk.every(s => s.enabled);
  const setGroupEnabled = async (sk: Skill[], value: boolean) => {
    const targets = sk.filter(s => {
      if (s.enabled === value) return false;
      if (value && s.source === "remote-mcp" && s.serverId && authPendingServers.has(s.serverId)) return false;
      return true;
    });
    for (const s of targets) {
      try { await Skills.setEnabled(s.skillId, value); } catch { /* 跳过失败项 */ }
    }
    skillsQ.reload();
  };

  // 渲染分组头部右侧的「一键开关」+ 折叠箭头（复用于三种分组）。
  const GroupControls = ({ gkey, sk }: { gkey: string; sk: Skill[] }) => (
    <div className="grp-controls">
      <div className="grp-master" title={t("skills.groupMasterTitle")} onClick={e => e.stopPropagation()}>
        <Toggle on={groupAllOn(sk)} onChange={(v) => setGroupEnabled(sk, v)} />
      </div>
      <button className={`caret ${collapsed.has(gkey) ? "collapsed" : ""}`}
        title={collapsed.has(gkey) ? t("skills.expand") : t("skills.collapseTitle")} aria-label={collapsed.has(gkey) ? t("skills.expand") : t("skills.collapseTitle")}
        onClick={e => { e.stopPropagation(); toggleCollapse(gkey); }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );

  // 应用搜索 / 过滤（多选：同维度 OR，跨维度 AND）
  const matches = (s: Skill): boolean => {
    const wantEnable = filters.has("enabled") || filters.has("disabled");
    if (wantEnable) {
      const ok = (filters.has("enabled") && s.enabled) || (filters.has("disabled") && !s.enabled);
      if (!ok) return false;
    }
    const wantSource = filters.has("local") || filters.has("remote");
    if (wantSource) {
      // 远程=URL 中转接入；本地=内置工具 或 stdio 托管接入。
      const isRemote = s.source === "remote-mcp" && (s.serverId ? serverTransport.get(s.serverId) !== "stdio" : true);
      const ok = (filters.has("remote") && isRemote) || (filters.has("local") && !isRemote);
      if (!ok) return false;
    }
    const wantRW = filters.has("read") || filters.has("write");
    if (wantRW) {
      // readOnly: true=可读, false=写入, null=未知（两者都不算，被过滤掉）
      const ok = (filters.has("read") && s.readOnly === true) || (filters.has("write") && s.readOnly === false);
      if (!ok) return false;
    }
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      if (![s.title, s.skillId, s.description ?? ""].some(t => t.toLowerCase().includes(q))) return false;
    }
    return true;
  };

  // 把技能按 group 划分；group 里有的 skillId 优先归属。
  // 未被认领的远程技能按所属服务器聚合成「虚拟分组」（组名=远程 MCP 的名字），
  // 其余落到「未归类」。虚拟分组不落库——把技能拖进真实分组即认领。
  const groupedView = useMemo(() => {
    const claimed = new Set<string>();
    const view = groups.map(g => ({
      ...g,
      skills: g.skillIds
        .map(id => skillById[id])
        .filter(Boolean)
        .filter(matches),
    }));
    groups.forEach(g => g.skillIds.forEach(id => claimed.add(id)));
    const unclaimed = skills.filter(s => !claimed.has(s.skillId)).filter(matches);

    const remoteByServer = new Map<string, { name: string; skills: Skill[] }>();
    const unGroup: Skill[] = [];
    for (const s of unclaimed) {
      if (s.source === "remote-mcp" && s.serverId) {
        const entry = remoteByServer.get(s.serverId) ?? { name: s.serverName ?? s.serverId, skills: [] };
        entry.skills.push(s);
        remoteByServer.set(s.serverId, entry);
      } else {
        unGroup.push(s);
      }
    }
    const remoteGroups = [...remoteByServer.entries()]
      .map(([serverId, g]) => ({ serverId, ...g }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { groups: view, remoteGroups, ungrouped: unGroup };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, skills, query, filters, skillById]);

  // ---- 拖拽：技能跨组 / 跨位置 ----
  const moveSkill = (skillId: string, toGroupId: string | null, toIndex: number) => {
    setGroups(prev => {
      let removedFrom: string | null = null;
      const stripped = prev.map(g => {
        const i = g.skillIds.indexOf(skillId);
        if (i >= 0) {
          removedFrom = g.id;
          const ids = g.skillIds.filter(x => x !== skillId);
          return { ...g, skillIds: ids };
        }
        return g;
      });
      const after = stripped.map(g => {
        if (g.id !== toGroupId) return g;
        const ids = [...g.skillIds];
        const idx = Math.max(0, Math.min(toIndex, ids.length));
        ids.splice(idx, 0, skillId);
        return { ...g, skillIds: ids };
      });
      void SkillGroups.save(after);
      return after;
    });
  };

  const isGrouped = (id: string) => groups.some(g => g.skillIds.includes(id));

  // 未归类区域内的上下排序：持久化到后端 sort_order（未归类顺序就来自它）。
  const reorderUngrouped = (draggedId: string, beforeId: string | null) => {
    const ids = groupedView.ungrouped.map(s => s.skillId);
    const from = ids.indexOf(draggedId);
    if (from < 0) return;
    ids.splice(from, 1);
    const to = beforeId ? ids.indexOf(beforeId) : ids.length;
    ids.splice(to < 0 ? ids.length : to, 0, draggedId);
    void Skills.reorder(ids).then(() => skillsQ.reload());
  };

  // 拖到未归类：分组内的技能→拉出归为未归类；本就未归类的→在区内排序。
  const dropToUngrouped = (id: string, beforeId: string | null) => {
    if (isGrouped(id)) moveSkill(id, null, 0);
    else reorderUngrouped(id, beforeId);
  };

  // 拖拽：分组本身的排序
  const moveGroup = (groupId: string, targetId: string) => {
    if (groupId === targetId) return;
    setGroups(prev => {
      const list = [...prev];
      const from = list.findIndex(g => g.id === groupId);
      const to   = list.findIndex(g => g.id === targetId);
      if (from < 0 || to < 0) return prev;
      const [moved] = list.splice(from, 1);
      list.splice(to, 0, moved);
      const reordered = list.map((g, i) => ({ ...g, order: i }));
      void SkillGroups.save(reordered);
      return reordered;
    });
  };

  const addGroup = (name: string) => {
    const id = `g${Date.now().toString(36)}`;
    setGroups(prev => {
      const next = [...prev, { id, name: name.trim(), order: prev.length, skillIds: [] }];
      void SkillGroups.save(next);
      return next;
    });
  };
  const removeGroup = (id: string) => {
    setGroups(prev => {
      const next = prev.filter(g => g.id !== id);
      void SkillGroups.save(next);
      return next;
    });
  };
  const renameGroup = (id: string, name: string) => {
    setGroups(prev => {
      const next = prev.map(g => g.id === id ? { ...g, name } : g);
      void SkillGroups.save(next);
      return next;
    });
  };

  const total = skills.length;
  const onCount = skills.filter(s => s.enabled).length;

  return (
    <div className="frame">
      <PageHead
        eyebrow={t("skills.eyebrow")}
        title={t("skills.title")}
        lede={t("skills.lede")}
        meta={<>{t("skills.metaEnabled", { on: onCount, total })}<br/>UPDATED {new Date().toLocaleTimeString(localeTag(), { hour12: false, hour: "2-digit", minute: "2-digit" })}</>}
      />

      <div className="tools-bar">
        <input className="search" placeholder={t("skills.search")}
          value={query} onChange={e => setQuery(e.target.value)} />
        <div className="filter-chips">
          {FILTER_TAGS.map(({ key, labelKey }) => (
            <button key={key} className={`chip ${filters.has(key) ? "active" : ""}`}
              onClick={() => toggleFilter(key)}>
              {t(labelKey)}
            </button>
          ))}
        </div>
        <div className="right">
          <button className="btn ghost" onClick={() => setMgmtOpen(true)}>{t("skills.manageGroups")}</button>
        </div>
      </div>

      {skillsQ.loading && <div className="card"><div className="card-body" style={{ color: "var(--text-3)" }}>{t("skills.loading")}</div></div>}
      {skillsQ.error   && <div className="card"><div className="card-body" style={{ color: "var(--err)" }}>{t("skills.loadFailed", { msg: skillsQ.error.message })}</div></div>}

      {/* 用户自定义分组 */}
      {groupedView.groups.map((g, gi) => (
        <section className="group" key={g.id}
          onDragOver={dragOver("group")} onDragLeave={dragLeave}
          onDrop={dragDrop("group", (id) => moveGroup(id, g.id))}>
          <header className="group-head"
            draggable
            onDragStart={dragStart("group", g.id)}
            onDragEnd={dragEnd}>
            <span className="handle" aria-hidden>⋮⋮</span>
            <span className="nm">{g.name}</span>
            <span className="count">{t("skills.count", { n: g.skills.length })}</span>
            <GroupControls gkey={g.id} sk={g.skills} />
          </header>

          <div className={`group-body-wrap ${collapsed.has(g.id) ? "collapsed" : ""}`}>
          <div className="group-body"
            onDragOver={dragOver("skill")} onDragLeave={dragLeave}
            onDrop={dragDrop("skill", (id) => moveSkill(id, g.id, g.skills.length))}>
            {g.skills.length === 0 && (
              <div className="group-body empty">
                {t("skills.emptyGroup")}
              </div>
            )}
            {g.skills.map((s, si) => (
              <SkillRow
                key={s.skillId}
                skill={s}
                agents={agents}
                visibleSet={visForSkill(s.skillId)}
                onChangeVis={(next) => updateVisForSkill(s.skillId, next)}
                onToggleEnable={(v) => toggleSkill(s.skillId, v)}
                authPending={authPendingServers}
                serverTransport={serverTransport}
                onDropAbove={(id) => moveSkill(id, g.id, si)}
              />
            ))}
          </div>
          </div>
        </section>
      ))}

      {/* 远程 MCP 虚拟分组：未被用户分组认领的远程技能，按服务器自动成组 */}
      {groupedView.remoteGroups.map(g => (
        <section className="group un" key={`rmcp-${g.serverId}`}
          onDragOver={dragOver("skill")} onDragLeave={dragLeave}
          onDrop={dragDrop("skill", (id) => moveSkill(id, null, 0))}>
          <header className="group-head">
            <span className="handle" aria-hidden style={{ opacity: .3 }}>⋮⋮</span>
            <span className="nm">{g.name}</span>
            <span className={`tag ${serverTransport.get(g.serverId) === "stdio" ? "line" : "b"}`} style={{ marginLeft: 8 }}>
              {serverTransport.get(g.serverId) === "stdio" ? t("tag.local") : t("tag.remote")} · {t("skills.autoGrouped")}
            </span>
            <span className="count">{t("skills.dragToCustomize", { n: g.skills.length })}</span>
            <GroupControls gkey={`rmcp-${g.serverId}`} sk={g.skills} />
          </header>
          <div className={`group-body-wrap ${collapsed.has(`rmcp-${g.serverId}`) ? "collapsed" : ""}`}>
          <div className="group-body">
            {g.skills.map(s => (
              <SkillRow
                key={s.skillId}
                skill={s}
                agents={agents}
                visibleSet={visForSkill(s.skillId)}
                onChangeVis={(next) => updateVisForSkill(s.skillId, next)}
                onToggleEnable={(v) => toggleSkill(s.skillId, v)}
                authPending={authPendingServers}
                serverTransport={serverTransport}
                onDropAbove={() => { /* 虚拟分组内不支持局部插入 */ }}
              />
            ))}
          </div>
          </div>
        </section>
      ))}

      {/* 未归类 */}
      <section className="group un"
        onDragOver={dragOver("skill")} onDragLeave={dragLeave}
        onDrop={dragDrop("skill", (id) => dropToUngrouped(id, null))}>
        <header className="group-head">
          <span className="handle" aria-hidden style={{ opacity: .3 }}>⋮⋮</span>
          <span className="nm" style={{ fontStyle: "italic", color: "var(--text-2)" }}>{t("skills.ungrouped")}</span>
          <span className="count">{t("skills.ungroupedHint", { n: groupedView.ungrouped.length })}</span>
          <GroupControls gkey="__ungrouped__" sk={groupedView.ungrouped} />
        </header>
        <div className={`group-body-wrap ${collapsed.has("__ungrouped__") ? "collapsed" : ""}`}>
        <div className="group-body">
          {groupedView.ungrouped.length === 0 && (
            <div className="group-body empty">{t("skills.allGrouped")}</div>
          )}
          {groupedView.ungrouped.map(s => (
            <SkillRow
              key={s.skillId}
              skill={s}
              agents={agents}
              visibleSet={visForSkill(s.skillId)}
              onChangeVis={(next) => updateVisForSkill(s.skillId, next)}
              onToggleEnable={(v) => toggleSkill(s.skillId, v)}
              authPending={authPendingServers}
              serverTransport={serverTransport}
              onDropAbove={(id) => dropToUngrouped(id, s.skillId)}
            />
          ))}
        </div>
        </div>
      </section>

      <ManageGroupsModal
        open={mgmtOpen} onClose={() => setMgmtOpen(false)}
        groups={groups}
        onRename={renameGroup} onRemove={removeGroup} onAdd={addGroup}
        onReorder={moveGroup}
      />
    </div>
  );
}

// ============================================================================

function SkillRow({
  skill, agents, visibleSet, onChangeVis, onToggleEnable, onDropAbove, authPending, serverTransport,
}: {
  skill: Skill;
  agents: Agent[];
  visibleSet: Set<string>;
  onChangeVis: (next: Set<string>) => void;
  onToggleEnable: (v: boolean) => void;
  onDropAbove: (id: string) => void;
  authPending: Set<string>;
  serverTransport: Map<string, "http" | "stdio">;
}) {
  const t = useT();
  // 远程服务尚未授权 → 不能启用（没 token，启用了也只会在调用时失败）。
  const needsAuth = skill.source === "remote-mcp" && !!skill.serverId && authPending.has(skill.serverId);

  // 本地/远程标签：内置工具=本地；接入的服务器看其传输方式——stdio 托管=本地，URL 中转=远程。
  const isRemote = skill.source === "remote-mcp" && (skill.serverId ? serverTransport.get(skill.serverId) !== "stdio" : true);

  // 描述紧凑模式：默认只显示约两行，超出才给「展开」；点击平滑展开/收起。
  // 只在「收起态」量一次是否溢出（此时有 clamp，clientHeight≈两行高）：
  //  - 依赖只放 description，避免展开/收起时重测——展开后 clientHeight 变大会误判为
  //    「不溢出」从而让按钮消失（之前的 bug）。
  const descRef = useRef<HTMLDivElement>(null);
  const [descOpen, setDescOpen] = useState(false);
  const [descOverflow, setDescOverflow] = useState(false);
  useEffect(() => {
    const el = descRef.current;
    if (el) setDescOverflow(el.scrollHeight > el.clientHeight + 2);
  }, [skill.description]);

  return (
    <div className="skill"
      draggable
      onDragStart={dragStart("skill", skill.skillId)}
      onDragEnd={dragEnd}
      onDragOver={dragOver("skill")}
      onDragLeave={dragLeave}
      onDrop={dragDrop("skill", (id) => { if (id !== skill.skillId) onDropAbove(id); })}>

      <span className="drag" aria-hidden>⋮⋮</span>

      <div className="nm">
        <div className="t">{skill.title}</div>
      </div>

      <div className="desc-cell">
        <div ref={descRef} className={`desc ${descOpen ? "open" : "clamp"} ${!descOpen && descOverflow ? "masked" : ""}`}>
          {skill.description ?? <em style={{ color: "var(--text-3)" }}>{t("skills.noDesc")}</em>}
        </div>
        {descOverflow && (
          <button className="desc-more" onClick={() => setDescOpen(v => !v)}>
            {descOpen ? t("skills.collapse") : t("skills.expand")}
          </button>
        )}
      </div>

      <div className="tags">
        {isRemote ? <span className="tag b">{t("tag.remote")}</span> : <span className="tag line">{t("tag.local")}</span>}
        {/* 读/写分类：系统能从工具的 readOnlyHint 判断（本地/远程通用）。写技能更敏感，默认关闭。 */}
        {skill.readOnly === true && <span className="tag line">{t("tag.read")}</span>}
        {skill.readOnly === false && <span className="tag warn">{t("tag.write")}</span>}
        {needsAuth && <span className="tag err">{t("tag.needsAuth")}</span>}
      </div>

      <VisibilityDropdown
        agents={agents}
        visibleIds={visibleSet}
        onChange={onChangeVis}
        disabled={!skill.enabled}
      />

      <div className="sw-cell">
        <Toggle
          on={skill.enabled}
          onChange={onToggleEnable}
          disabled={needsAuth && !skill.enabled}
        />
        {needsAuth && !skill.enabled && (
          <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-3)" }} title={t("skills.needAuthTitle")}>
            {t("skills.needAuthFirst")}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================

function ManageGroupsModal({
  open, onClose, groups, onRename, onRemove, onAdd, onReorder,
}: {
  open: boolean; onClose: () => void;
  groups: SkillGroup[];
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
  onAdd: (name: string) => void;
  onReorder: (gid: string, targetId: string) => void;
}) {
  const t = useT();
  const [newName, setNewName] = useState("");

  return (
    <Modal open={open} onClose={onClose} title={t("skills.manageGroups")} sub={t("skills.manageSub")}
      footer={<>
        <button className="btn ghost" onClick={onClose}>{t("common.cancel")}</button>
        <button className="btn primary" onClick={onClose}>{t("common.done")}</button>
      </>}>
      {groups.map(g => (
        <div className="grp-row" key={g.id}
          draggable
          onDragStart={dragStart("group", g.id)}
          onDragEnd={dragEnd}
          onDragOver={dragOver("group")}
          onDragLeave={dragLeave}
          onDrop={dragDrop("group", (id) => onReorder(id, g.id))}>
          <span className="h" aria-hidden>⋮⋮</span>
          <span><input defaultValue={g.name}
            onBlur={e => { if (e.target.value !== g.name) onRename(g.id, e.target.value); }} /></span>
          <span className="ct">{t("skills.count", { n: g.skillIds.length })}</span>
          <button className="del" onClick={() => {
            if (confirm(t("skills.deleteGroupConfirm", { name: g.name }))) onRemove(g.id);
          }}>{t("common.delete")}</button>
        </div>
      ))}
      <div className="add-grp">
        <input placeholder={t("skills.newGroupPlaceholder")} value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && newName.trim()) { onAdd(newName.trim()); setNewName(""); }
          }} />
        <button className="btn primary" onClick={() => {
          if (newName.trim()) { onAdd(newName.trim()); setNewName(""); }
        }}>{t("common.add")}</button>
      </div>
      <div className="hint-box">
        {t("skills.manageHint")}
      </div>
    </Modal>
  );
}
