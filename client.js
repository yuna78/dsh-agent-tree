/**
 * `dsh-plugin-agent-tree` — 客户端半部（v0.1.0）。
 *
 * 内容：一张常驻角落的迷你 agent 树。
 *   - 顶层是「本机 agent 列表」：`dsh`（本实例）与本机 `claude` / `codex` 进程同级；
 *   - `dsh` 下面 workspace → 对话 → subagent（可再下钻），git-graph 风格连接线；
 *   - 等你拍板的会话（待答/待批/待审）琥珀色置顶；定时任务的会话带 ⏱ 倒计时；
 *   - 每行右侧是该会话正在用的模型；
 *   - codex 那行下面挂它自己的 subagent 线程（读 rollout 头，见宿主半部），
 *     再下面是它拉起的 MCP / computer use 等工具进程。
 *
 * 只读：所有数据来自客户端已有的 session store / projection，加上宿主半部的
 * 只读小接口 `GET /local/dsh-agent-tree/processes`。
 *
 * 视觉约定：
 *   - 顶层对话：绿色圆点
 *   - 第 2 层 subagent：蓝色圆点
 *   - 第 3 层及更深：紫色圆点（已结束的用灰点）
 *
 * 数据来源（官方 0.2.1-rc.2 客户端契约）：
 *   - `useSessions(s => s)` → { ids, byId }
 *   - `useSessionStatus(map => map)`，没有 global props 时自己订阅
 *     `ctx.remote.$on('api-session/status', (sessionId, running) => …)`
 *   - `ctx.workspaces.list.getSnapshot()` → items[].{ workspaceId, path, title, sessionIds }
 *   - `byId[id].projectionValues.{subagentTiming, modelSelection}` → 耗时 / 模型
 *   - `ctx.remote.schedule.catalog()` + `schedule/changed` → 定时任务
 *   - `GET /local/dsh-agent-tree/processes`（本插件宿主半部）→ 外部 agent 进程
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-agent-tree',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const OVERLAY_ID = 'dsh-agent-tree.mini';
    const POS_KEY = 'dsh-agent-tree:pos';
    const WIDTH = 288;
    const MAX_ROWS = 48;
    const POLL_MS = 1000;
    const STATUS_EVENT = 'api-session/status';
    const SCHEDULE_EVENT = 'schedule/changed';
    const SCHEDULE_POLL_MS = 15000;
    const PROCESS_POLL_MS = 5000;
    const PROCESS_ROUTE = '/local/dsh-agent-tree/processes';

    const DOT = {
      conversation: 'var(--dsw-alias-state-success-primary, #138a63)',
      level2: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      deep: '#8b5cf6',
      idle: 'var(--dsw-alias-border-l3, #c9ccd1)',
    };
    const KIND_DOT = { claude: '#d97757', codex: '#10a37f' };

    /** 需要你拍板的状态：琥珀色，和「在跑」的绿/蓝明确区分。 */
    const WAIT = {
      question: { color: '#d97706', badge: '待答', title: '等你回答 agent 的问题' },
      approval: { color: '#d97706', badge: '待批', title: '等你批准一次操作' },
      'plan-review': { color: '#d97706', badge: '待审', title: '等你审阅 agent 的计划' },
    };
    const WAIT_ORDER = { question: 0, approval: 1, 'plan-review': 2 };

    const GLYPH_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

    // ------------------------------------------------------------------ 纯函数

    function hasSchedule(node) {
      return node && node.schedule !== undefined && node.schedule !== null;
    }

    /** 子孙进程按标签归组：`computer use ×4`、`MCP ×3`，按数量再按时长排序。 */
    function groupProcessChildren(children) {
      const groups = new Map();
      for (const child of Array.isArray(children) ? children : []) {
        const label = (child && child.label) || 'child';
        let entry = groups.get(label);
        if (!entry) {
          entry = { label, count: 0, elapsedSeconds: 0, cpu: 0 };
          groups.set(label, entry);
        }
        entry.count += 1;
        entry.elapsedSeconds = Math.max(entry.elapsedSeconds, Number(child.elapsedSeconds) || 0);
        entry.cpu += Number(child.cpu) || 0;
      }
      return Array.from(groups.values()).sort(
        (a, b) => b.count - a.count || b.elapsedSeconds - a.elapsedSeconds,
      );
    }

    function sortNodes(nodes) {
      nodes.sort(
        (a, b) =>
          nodeRank(b) - nodeRank(a) ||
          (WAIT_ORDER[b.waiting] ?? 9) - (WAIT_ORDER[a.waiting] ?? 9) ||
          (b.row.updatedAt || 0) - (a.row.updatedAt || 0),
      );
      for (const node of nodes) sortNodes(node.children);
      return nodes;
    }

    function isRunning(row, statuses) {
      const live = statuses && typeof statuses.get === 'function' ? statuses.get(row.id) : undefined;
      if (live && typeof live.running === 'boolean') return live.running;
      return row.running === true;
    }

    /** 这个会话有没有在等你做判断：`question` / `approval` / `plan-review`。 */
    function waitingKind(statuses, sessionId) {
      const live = statuses && typeof statuses.get === 'function' ? statuses.get(sessionId) : undefined;
      const kind = live && live.pendingInteraction && live.pendingInteraction.kind;
      return WAIT[kind] ? kind : undefined;
    }

    /** 节点的排序权重：等你拍板 > 在跑 > 有定时任务 > 其它。 */
    function nodeRank(node) {
      if (node && node.waiting) return 3;
      if (node && node.active) return 2;
      if (hasSchedule(node)) return 1;
      return 0;
    }

    function baseName(path) {
      if (typeof path !== 'string' || path.length === 0) return '';
      const parts = path.split('/').filter(Boolean);
      return parts.length === 0 ? path : parts[parts.length - 1];
    }

    function workspaceLabel(ws) {
      if (!ws) return '未分组';
      const title = typeof ws.title === 'string' ? ws.title.trim() : '';
      return title.length > 0 ? title : baseName(ws.path) || String(ws.workspaceId);
    }

    function shortTitle(row) {
      const title = (row.displayTitle || '').trim();
      return title.length > 0 ? title : row.id;
    }

    function durationMs(projectionValues, running, now) {
      const timing = projectionValues && projectionValues.subagentTiming;
      if (!timing) return 0;
      const settled = timing.settledMs || 0;
      if (!timing.active) return settled;
      const through = running ? now : timing.active.through || now;
      return settled + Math.max(0, through - (timing.active.since || through));
    }

    function formatDuration(ms) {
      if (!ms || ms < 1000) return '';
      const total = Math.floor(ms / 1000);
      if (total < 60) return `${total}s`;
      const minutes = Math.floor(total / 60);
      if (minutes < 60) return `${minutes}m${total % 60}s`;
      return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
    }

    /** `subagentTiming` 的兄弟投影：模型选择 → 卡片里那个小标签。 */
    function modelLabel(projectionValues) {
      const selection = projectionValues && projectionValues.modelSelection;
      if (!selection) return '';
      const chosen = selection.next || selection.lastUsed;
      if (!chosen || typeof chosen.model !== 'string') return '';
      let label = chosen.model;
      if (label.includes('/')) label = label.slice(label.lastIndexOf('/') + 1);
      label = label.replace(/^deepseek[-_]/, '').replace(/^anthropic[-_]/, '');
      if (label.length > 16) label = `${label.slice(0, 15)}…`;
      return label;
    }

    /** 定时任务：宿主返回的 catalog 条目 → `sessionId -> { count, nextAt }`。 */
    function toScheduleMap(entries) {
      const map = new Map();
      if (!Array.isArray(entries)) return map;
      for (const entry of entries) {
        if (!entry || entry.status !== 'active' || entry.sessionId === undefined) continue;
        const current = map.get(entry.sessionId) || { count: 0, nextAt: Number.POSITIVE_INFINITY };
        const at = Date.parse(entry.scheduledAt);
        map.set(entry.sessionId, {
          count: current.count + 1,
          nextAt: Number.isFinite(at) ? Math.min(current.nextAt, at) : current.nextAt,
        });
      }
      return map;
    }

    /**
     * 定时任务的行内标记：`mark` 放在标题前面当小闹钟，`label` 放在右侧当倒计时。
     * 倒计时已经到期（`now`）时 label 仍然给 `now`，mark 不消失——一眼就知道这行是循环任务。
     */
    function scheduleMark(scheduled, now) {
      if (scheduled === undefined || scheduled === null) return null;
      const label = countdownLabel(scheduled.nextAt, now);
      return {
        mark: '\u23f0',
        label,
        title: `${scheduled.count} 个定时任务${
          Number.isFinite(scheduled.nextAt) ? `，下次 ${new Date(scheduled.nextAt).toLocaleString()}` : ''
        }`,
      };
    }

    /** 距离下次触发还有多久，比如 `8m` / `2h` / `3d`。 */
    function countdownLabel(nextAt, now) {
      if (!Number.isFinite(nextAt)) return '';
      const diff = nextAt - now;
      if (diff <= 0) return 'now';
      const minutes = Math.round(diff / 60000);
      if (minutes < 1) return '<1m';
      if (minutes < 60) return `${minutes}m`;
      const hours = Math.round(minutes / 60);
      if (hours < 24) return `${hours}h`;
      return `${Math.round(hours / 24)}d`;
    }

    /** 外部进程已经跑了多久：秒 → `12m` / `1h3m`。 */
    function formatElapsed(seconds) {
      if (!seconds || seconds < 0) return '';
      if (seconds < 60) return `${Math.round(seconds)}s`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m`;
      const hours = Math.floor(minutes / 60);
      return `${hours}h${minutes % 60}m`;
    }

    /**
     * 本机其它 dsh 实例：宿主半部用 `ps`+`lsof` 找到它们的端口和正在用的会话，
     * 这里把会话 id 对回本地会话表（共用同一个 `~/.dsh/sessions`，所以标题能拿到）。
     */
    function buildInstances(instances, sessions, statuses, now) {
      const list = Array.isArray(instances) ? instances : [];
      const byId = sessions && sessions.byId ? sessions.byId : {};
      const out = [];
      for (const instance of list) {
        if (instance === null || typeof instance !== 'object') continue;
        const ports = Array.isArray(instance.ports) ? instance.ports.filter((port) => Number.isFinite(port)) : [];
        const ids = Array.isArray(instance.sessionIds) ? instance.sessionIds : [];
        const rows = [];
        for (const id of ids) {
          const row = byId[id];
          if (row === undefined) continue;
          rows.push({
            id,
            title: shortTitle(row),
            waiting: waitingKind(statuses, id),
            updatedAt: Number(row.updatedAt) || 0,
            updatedLabel: formatElapsed(Math.max(0, Math.round((now - (Number(row.updatedAt) || now)) / 1000))),
          });
        }
        rows.sort((left, right) => right.updatedAt - left.updatedAt);
        if (ports.length === 0 && rows.length === 0) continue;
        out.push({
          key: `inst:${instance.pid}`,
          pid: instance.pid,
          port: ports.length > 0 ? ports[0] : undefined,
          label: ports.length > 0 ? `dsh :${ports[0]}` : `dsh pid ${instance.pid}`,
          url: ports.length > 0 ? `http://127.0.0.1:${ports[0]}/` : '',
          waiting: rows.some((row) => row.waiting !== undefined),
          count: rows.length,
          unknown: ids.length - rows.length,
          rows: rows.slice(0, 6),
        });
        if (out.length >= 4) break;
      }
      return out;
    }

    /**
     * 建真树：workspace → 对话 → subagent（可递归）。
     * 只保留通往「活跃 / 有定时任务」节点的分支，所以卡永远小。
     *
     * node = { kind: 'conversation' | 'subagent', row, active, children, schedule? }
     * group = { id, label, items: node[] }
     */
    function selectActiveTree(sessionState, workspaceState, statuses, schedules) {
      const byId = (sessionState && sessionState.byId) || {};
      const ids =
        Array.isArray(sessionState && sessionState.ids) && sessionState.ids.length > 0
          ? sessionState.ids
          : Object.keys(byId);
      const rows = ids.map((id) => byId[id]).filter((row) => row !== undefined && !row.blank);

      const stats = { total: rows.length, subagents: 0, runningSnapshot: 0, runningLive: 0 };
      for (const row of rows) {
        if (row.origin === 'subagent') stats.subagents += 1;
        if (row.running === true) stats.runningSnapshot += 1;
        if (isRunning(row, statuses)) stats.runningLive += 1;
      }

      const workspaces = (workspaceState && workspaceState.items) || [];
      const workspaceOf = new Map();
      const workspaceById = new Map();
      for (const ws of workspaces) {
        if (!ws || ws.workspaceId === undefined) continue;
        workspaceById.set(ws.workspaceId, ws);
        for (const sessionId of ws.sessionIds || []) {
          if (!workspaceOf.has(sessionId)) workspaceOf.set(sessionId, ws.workspaceId);
        }
      }

      // 祖先链：根 → 自己（父不在 byId 就停在能到的最上层）
      const chainOf = (row) => {
        const chain = [];
        const seen = new Set();
        let current = row;
        while (current && !seen.has(current.id)) {
          seen.add(current.id);
          chain.unshift(current);
          const parentId = current.parentId;
          const parent = parentId && byId[parentId];
          current = parent && parent !== current ? parent : undefined;
        }
        return chain;
      };

      const groups = new Map();
      const ensureGroup = (workspaceId) => {
        let group = groups.get(workspaceId);
        if (!group) {
          group = {
            id: String(workspaceId),
            label: workspaceLabel(workspaceById.get(workspaceId)),
            items: [],
          };
          groups.set(workspaceId, group);
        }
        return group;
      };

      const conversationNodes = new Map(); // `${groupId}|${rowId}` -> node
      const subagentNodes = new Map(); // rowId -> node

      const ensureConversation = (group, row) => {
        const key = `${group.id}|${row.id}`;
        let node = conversationNodes.get(key);
        if (!node) {
          node = { kind: 'conversation', row, active: isRunning(row, statuses), children: [] };
          conversationNodes.set(key, node);
          group.items.push(node);
        }
        return node;
      };

      const ensureSubagent = (parent, group, row) => {
        let node = subagentNodes.get(row.id);
        if (!node) {
          node = { kind: 'subagent', row, active: isRunning(row, statuses), children: [] };
          subagentNodes.set(row.id, node);
          if (parent) parent.children.push(node);
          else group.items.push(node);
        }
        return node;
      };

      /** 把一条会话挂进树：顶层是对话就建对话节点，顶层是 subagent 就直挂 workspace。 */
      const attach = (row) => {
        const chain = chainOf(row);
        const top = chain[0];
        const workspaceId = workspaceOf.has(top.id)
          ? workspaceOf.get(top.id)
          : workspaceOf.has(row.id)
            ? workspaceOf.get(row.id)
            : '__ungrouped__';
        const group = ensureGroup(workspaceId);
        if (top.origin === 'subagent') {
          let parent = null;
          for (const link of chain) parent = ensureSubagent(parent, group, link);
          return subagentNodes.get(row.id) || parent;
        }
        const conversation = ensureConversation(group, top);
        let parent = conversation;
        for (const link of chain.slice(1)) parent = ensureSubagent(parent, group, link);
        return subagentNodes.get(row.id) || conversation;
      };

      const activeRows = rows.filter((row) => isRunning(row, statuses));
      for (const row of activeRows) attach(row);

      // 需要你判断的会话：可能已经不在跑（等输入），但必须出现在最上面
      const waitingNodes = new Set();
      for (const row of rows) {
        const kind = waitingKind(statuses, row.id);
        if (kind === undefined) continue;
        const node = attach(row);
        if (!node) continue;
        node.waiting = kind;
        waitingNodes.add(node);
      }

      // 定时任务（间歇式工作的会话）：不在跑也要列出来，标上倒计时
      const scheduleEntries = schedules instanceof Map ? schedules : new Map();
      const scheduledNodes = new Set();
      for (const [sessionId, info] of scheduleEntries) {
        const row = byId[sessionId];
        if (!row || row.blank) continue;
        const node = attach(row);
        if (!node) continue;
        node.schedule = info;
        scheduledNodes.add(node);
      }

      for (const group of groups.values()) sortNodes(group.items);

      const ordered = [];
      for (const ws of workspaces) {
        const group = groups.get(ws.workspaceId);
        if (group) ordered.push(group);
      }
      const ungrouped = groups.get('__ungrouped__');
      if (ungrouped) ordered.push(ungrouped);

      return {
        groups: ordered,
        running: activeRows.length,
        waiting: waitingNodes.size,
        scheduled: scheduledNodes.size,
        conversations: conversationNodes.size,
        stats,
      };
    }

    function readSavedPos() {
      try {
        const raw = window.localStorage.getItem(POS_KEY);
        if (raw === null) return null;
        const parsed = JSON.parse(raw);
        if (typeof parsed.x === 'number' && typeof parsed.y === 'number') return parsed;
      } catch (err) {
        /* localStorage 不可用或内容坏了：用默认位置 */
      }
      return null;
    }

    function savePos(pos) {
      try {
        window.localStorage.setItem(POS_KEY, JSON.stringify(pos));
      } catch (err) {
        /* 忽略 */
      }
    }

    function ensureStyles() {
      if (typeof document === 'undefined') return;
      const tagId = OVERLAY_ID + '/styles';
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']')) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-plugin-agent-tree';
      tag.dataset.pluginCss = tagId;
      tag.textContent = [
        '@keyframes dshAgentTreePulse{0%,100%{opacity:.3}50%{opacity:1}}',
        '.dsh-agent-tree-dot-run{animation:dshAgentTreePulse 1.2s ease-in-out infinite}',
        '.dsh-agent-tree-mini-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      ].join('');
      document.head.appendChild(tag);
    }

    let clientCtx = null;

    // ---------------------------------------------------------------- 组件

    function useNow() {
      const [now, setNow] = React.useState(() => Date.now());
      React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), POLL_MS);
        return () => clearInterval(timer);
      }, []);
      return now;
    }

    function Dot({ color, active }) {
      return h('span', {
        className: active ? 'dsh-agent-tree-dot-run' : undefined,
        style: {
          width: 6,
          height: 6,
          borderRadius: 999,
          flex: 'none',
          display: 'inline-block',
          background: active ? color : DOT.idle,
        },
      });
    }

    function clampSpan(text, style) {
      return h(
        'span',
        {
          style: {
            minWidth: 0,
            flex: 1,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            ...style,
          },
        },
        text,
      );
    }

    function glyph(text) {
      return h(
        'span',
        {
          style: {
            flex: 'none',
            fontFamily: GLYPH_FONT,
            fontSize: 9.5,
            lineHeight: '12px',
            color: 'var(--dsw-alias-border-l3, #b9bcc2)',
            whiteSpace: 'pre',
            letterSpacing: 0,
          },
        },
        text,
      );
    }

    /** 每行左侧的模型小标签。 */
    function ModelChip({ text, inherited }) {
      if (!text) return null;
      return h(
        'span',
        {
          title: inherited ? `模型：${text}（继承自上级）` : `模型：${text}`,
          style: {
            flex: 'none',
            maxWidth: 68,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: GLYPH_FONT,
            fontSize: 8,
            lineHeight: '12px',
            padding: '0 3px',
            borderRadius: 3,
            color: 'var(--dsw-alias-label-tertiary)',
            background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))',
          },
        },
        text,
      );
    }

    /** 「等你拍板」的小徽标：琥珀色 `待答` / `待批` / `待审`。 */
    /** 定时 / 循环任务的小闹钟。 */
    function AlarmMark({ title }) {
      return h(
        'span',
        {
          title,
          style: {
            flex: 'none',
            fontSize: 9,
            lineHeight: 1,
            opacity: 0.75,
            color: 'var(--dsw-alias-label-tertiary)',
          },
        },
        '\u23f0',
      );
    }

    function WaitBadge({ kind }) {
      const info = WAIT[kind];
      if (!info) return null;
      return h(
        'span',
        {
          title: info.title,
          style: {
            flex: 'none',
            fontSize: 8.5,
            fontWeight: 600,
            lineHeight: 1,
            padding: '1px 3px',
            borderRadius: 3,
            color: info.color,
            border: `1px solid ${info.color}55`,
            background: `${info.color}14`,
          },
        },
        info.badge,
      );
    }

    function MiniInner({ tree, onOpen, mode, processes, instances, sessions, statuses }) {
      const [manualCollapsed, setManualCollapsed] = React.useState(null);
      const collapsed =
        manualCollapsed === null ? tree.running === 0 && tree.scheduled === 0 && tree.waiting === 0 : manualCollapsed;
      const [collapsedNodes, setCollapsedNodes] = React.useState({});
      const now = useNow();
      const [pos, setPos] = React.useState(() => {
        const saved = readSavedPos();
        if (saved !== null) return saved;
        const width = typeof window !== 'undefined' ? window.innerWidth : 1280;
        const height = typeof window !== 'undefined' ? window.innerHeight : 800;
        return { x: Math.max(8, width - WIDTH - 20), y: Math.max(8, height - 300) };
      });

      const dragRef = React.useRef(null);
      const onPointerDown = (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        dragRef.current = { x: event.clientX, y: event.clientY, left: pos.x, top: pos.y };
        const onMove = (moveEvent) => {
          const base = dragRef.current;
          if (base === null) return;
          const maxX = Math.max(0, window.innerWidth - WIDTH - 4);
          const maxY = Math.max(0, window.innerHeight - 36);
          setPos({
            x: Math.min(maxX, Math.max(0, base.left + moveEvent.clientX - base.x)),
            y: Math.min(maxY, Math.max(0, base.top + moveEvent.clientY - base.y)),
          });
        };
        const onUp = () => {
          dragRef.current = null;
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          setPos((current) => {
            savePos(current);
            return current;
          });
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      };

      const toggle = (key) => setCollapsedNodes((prev) => ({ ...prev, [key]: !prev[key] }));

      /** 递归画树：git log --graph 风格的 ├─ └─ │ 连接线。 */
      const renderNodes = (nodes, prefix, depth, out, inheritedModel) => {
        nodes.forEach((node, index) => {
          const isLast = index === nodes.length - 1;
          const connector = `${prefix}${isLast ? '└─' : '├─'}`;
          const childPrefix = `${prefix}${isLast ? '   ' : '│  '}`;
          const key = `${node.kind}:${node.row.id}`;
          const hasChildren = node.children.length > 0;
          const expanded = !collapsedNodes[key];
          const own = modelLabel(node.row.projectionValues);
          const model = own || inheritedModel || '';
          const schedule = scheduleMark(node.schedule, now);
          const alarm = schedule ? h(AlarmMark, { title: schedule.title }) : null;
          const clock = schedule
            ? h(
                'span',
                {
                  title: schedule.title,
                  style: { flex: 'none', fontSize: 8.5, color: 'var(--dsw-alias-label-tertiary)' },
                },
                schedule.label,
              )
            : null;

          if (node.kind === 'conversation') {
            out.push(
              h(
                'div',
                {
                  key,
                  className: 'dsh-agent-tree-mini-row',
                  onClick: () => onOpen(node.row.id),
                  title: `${shortTitle(node.row)}\n${node.row.id}`,
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '3px 8px 3px 12px',
                    cursor: 'pointer',
                    minWidth: 0,
                  },
                },
                glyph(connector),
                h(
                  'span',
                  {
                    onClick: (event) => {
                      if (!hasChildren) return;
                      event.stopPropagation();
                      toggle(key);
                    },
                    style: {
                      width: 8,
                      flex: 'none',
                      fontSize: 8.5,
                      color: 'var(--dsw-alias-label-tertiary)',
                      textAlign: 'center',
                      cursor: hasChildren ? 'pointer' : 'default',
                    },
                  },
                  hasChildren ? (expanded ? '▾' : '▸') : '',
                ),
                node.waiting
                  ? h(Dot, { color: WAIT[node.waiting].color, active: true })
                  : node.active
                    ? h(Dot, { color: DOT.conversation, active: true })
                    : null,
                alarm,
                clampSpan(shortTitle(node.row), {
                  fontSize: 10.5,
                  fontWeight: node.waiting || node.active ? 600 : 500,
                  color: node.waiting ? WAIT[node.waiting].color : 'var(--dsw-alias-label-primary)',
                }),
                node.waiting ? h(WaitBadge, { kind: node.waiting }) : clock,
                h(ModelChip, { text: model, inherited: own === '' && model !== '' }),
              ),
            );
            if (expanded) renderNodes(node.children, childPrefix, depth + 1, out, model);
            return;
          }

          const color = depth <= 2 ? DOT.level2 : DOT.deep;
          out.push(
            h(
              'div',
              {
                key,
                className: 'dsh-agent-tree-mini-row',
                onClick: () => onOpen(node.row.id),
                title: `${shortTitle(node.row)}\n${node.row.id}`,
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 8px 2px 12px',
                  cursor: 'pointer',
                  minWidth: 0,
                },
              },
              glyph(connector),
              h(Dot, { color: node.waiting ? WAIT[node.waiting].color : color, active: node.active || Boolean(node.waiting) }),
              alarm,
              clampSpan(shortTitle(node.row), {
                fontSize: 10.5,
                color: node.waiting
                  ? WAIT[node.waiting].color
                  : node.active
                    ? 'var(--dsw-alias-label-primary)'
                    : 'var(--dsw-alias-label-tertiary)',
              }),
              node.waiting ? h(WaitBadge, { kind: node.waiting }) : clock,
              h(ModelChip, { text: model, inherited: own === '' && model !== '' }),
              h(
                'span',
                { style: { flex: 'none', fontSize: 9.5, color: 'var(--dsw-alias-label-tertiary)' } },
                formatDuration(durationMs(node.row.projectionValues, node.active, now)),
              ),
            ),
          );
          if (expanded && hasChildren) renderNodes(node.children, childPrefix, depth + 1, out, model);
        });
      };

      const rows = [];
      const processList = Array.isArray(processes) ? processes : [];

      // 顶层：本机上的 agent——dsh 自己 + 每个外部 claude/codex，彼此同级。
      const rootKey = 'root';
      const rootOpen = !collapsedNodes[rootKey];
      const caret = (open) =>
        h(
          'span',
          {
            style: {
              width: 8,
              flex: 'none',
              fontSize: 8.5,
              color: 'var(--dsw-alias-label-tertiary)',
              textAlign: 'center',
            },
          },
          open ? '▾' : '▸',
        );

      rows.push(
        h(
          'div',
          {
            key: rootKey,
            className: 'dsh-agent-tree-mini-row',
            onClick: () => toggle(rootKey),
            title: '这个 DSH 实例',
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 8px 2px 10px',
              cursor: 'pointer',
              minWidth: 0,
            },
          },
          caret(rootOpen),
          h(Dot, {
            color: tree.waiting > 0 ? WAIT.question.color : DOT.conversation,
            active: tree.running > 0 || tree.waiting > 0,
          }),
          clampSpan('dsh', { flex: 'none', fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }),
          h('span', { style: { flex: 1 } }),
          h(
            'span',
            { style: { flex: 'none', fontSize: 9.5, color: 'var(--dsw-alias-label-tertiary)' } },
            `${tree.groups.length} 个 workspace`,
          ),
        ),
      );

      if (rootOpen) tree.groups.forEach((group, groupIndex) => {
        const isLastGroup = groupIndex === tree.groups.length - 1;
        const groupConnector = isLastGroup ? '└─' : '├─';
        const groupPrefix = isLastGroup ? '   ' : '│  ';
        const groupKey = `g:${group.id}`;
        const groupOpen = !collapsedNodes[groupKey];
        rows.push(
          h(
            'div',
            {
              key: groupKey,
              className: 'dsh-agent-tree-mini-row',
              onClick: () => toggle(groupKey),
              title: group.label,
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '4px 8px 2px 12px',
                cursor: 'pointer',
                minWidth: 0,
              },
            },
            glyph(groupConnector),
            h(
              'span',
              {
                onClick: (event) => {
                  event.stopPropagation();
                  toggle(groupKey);
                },
                style: {
                  width: 8,
                  flex: 'none',
                  fontSize: 8.5,
                  color: 'var(--dsw-alias-label-tertiary)',
                  textAlign: 'center',
                },
              },
              groupOpen ? '▾' : '▸',
            ),
            clampSpan(group.label, { fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }),
            h(
              'span',
              { style: { flex: 'none', fontSize: 9.5, color: 'var(--dsw-alias-label-tertiary)' } },
              String(group.items.length),
            ),
          ),
        );
        if (groupOpen) renderNodes(group.items, groupPrefix, 1, rows, '');
      });

      // 本机其它 dsh 实例：端口 + 它们在用的会话（宿主半部用 ps/lsof 发现，不需要跨端口鉴权）。
      const instanceViews = buildInstances(instances, sessions, statuses, now);
      instanceViews.forEach((instance) => {
        const instKey = instance.key;
        const instOpen = !collapsedNodes[instKey];
        const openInstance = () => {
          if (instance.url === '') return;
          if (typeof window !== 'undefined' && typeof window.open === 'function') window.open(instance.url, '_blank', 'noopener');
        };
        rows.push(
          h(
            'div',
            {
              key: instKey,
              className: 'dsh-agent-tree-mini-row',
              onClick: () => {
                toggle(instKey);
                openInstance();
              },
              title: `${instance.label}${instance.port === undefined ? '' : `\n${instance.url}`}${
                instance.unknown > 0 ? `\n另有 ${instance.unknown} 个会话不在本实例的会话表里` : ''
              }`,
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '4px 8px 2px 10px',
                cursor: 'pointer',
                minWidth: 0,
              },
            },
            instance.rows.length === 0 ? h('span', { style: { width: 8, flex: 'none' } }) : caret(instOpen),
            h(Dot, {
              color: instance.waiting ? WAIT.question.color : DOT.conversation,
              active: instance.rows.length > 0 || instance.waiting,
            }),
            clampSpan(instance.label, {
              flex: 'none',
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--dsw-alias-label-primary)',
            }),
            h('span', { style: { flex: 1 } }),
            h(
              'span',
              { style: { flex: 'none', fontSize: 9.5, color: 'var(--dsw-alias-label-tertiary)' } },
              `${instance.count} 个会话`,
            ),
          ),
        );
        if (!instOpen) return;
        instance.rows.forEach((row, rowIndex) => {
          const isLast = rowIndex === instance.rows.length - 1;
          rows.push(
            h(
              'div',
              {
                key: `${instKey}:${row.id}`,
                className: 'dsh-agent-tree-mini-row',
                onClick: openInstance,
                title: `${row.title}\n${instance.label}\n${row.id}`,
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 8px 2px 12px',
                  cursor: 'pointer',
                  minWidth: 0,
                },
              },
              glyph(isLast ? '└─' : '├─'),
              h(Dot, {
                color: row.waiting ? WAIT[row.waiting].color : DOT.level2,
                active: row.waiting !== undefined,
              }),
              clampSpan(row.title, {
                fontSize: 10.5,
                color: row.waiting ? WAIT[row.waiting].color : 'var(--dsw-alias-label-secondary)',
              }),
              row.waiting ? h(WaitBadge, { kind: row.waiting }) : null,
              h(
                'span',
                { style: { flex: 'none', fontSize: 9.5, color: 'var(--dsw-alias-label-tertiary)' } },
                row.updatedLabel,
              ),
            ),
          );
        });
      });

      // 外部 claude / codex：和 dsh 同级的顶层节点（不缩进），子进程挂在它们下面。
      processList.forEach((proc) => {
        const procKey = `proc:${proc.pid}`;
        const children = Array.isArray(proc.children) ? proc.children : [];
        const procOpen = !collapsedNodes[procKey];
        const childGroups = groupProcessChildren(children);
        rows.push(
          h(
            'div',
            {
              key: procKey,
              className: 'dsh-agent-tree-mini-row',
              onClick: () => {
                if (children.length === 0) return;
                toggle(procKey);
              },
              title: `${proc.kind} · pid ${proc.pid}${
                proc.sessionTitle ? `\n${proc.sessionTitle}` : ''
              }${proc.cwd ? `\n${proc.cwd}` : ''}${children.length > 0 ? `\n${children.length} 个子进程` : ''}`,
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '4px 8px 2px 10px',
                cursor: children.length > 0 ? 'pointer' : 'default',
                minWidth: 0,
              },
            },
            children.length === 0 ? h('span', { style: { width: 8, flex: 'none' } }) : caret(procOpen),
            h(Dot, { color: KIND_DOT[proc.kind] || DOT.deep, active: true }),
            clampSpan(proc.kind, {
              flex: 'none',
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--dsw-alias-label-primary)',
            }),
            clampSpan(proc.label || `pid ${proc.pid}`, {
              fontSize: 10.5,
              color: 'var(--dsw-alias-label-secondary)',
            }),
            proc.sessionTitle && proc.cwd && proc.cwd !== '/' && proc.cwd !== ''
              ? clampSpan(baseName(proc.cwd), {
                  flex: 'none',
                  fontSize: 9,
                  color: 'var(--dsw-alias-label-tertiary)',
                })
              : null,
            h(
              'span',
              { style: { flex: 'none', fontSize: 9.5, color: 'var(--dsw-alias-label-tertiary)' } },
              `${formatElapsed(proc.elapsedSeconds)}${proc.cpu >= 1 ? ` ${Math.round(proc.cpu)}%` : ''}`,
            ),
          ),
        );
        if (!procOpen) return;

        // 子对话（codex 的 subagent threads，来自它自己的 rollout 记录）排在子进程前面
        const threads = Array.isArray(proc.threads) ? proc.threads : [];
        const entries = [
          ...threads.map((thread) => ({ kind: 'thread', thread })),
          ...childGroups.map((child) => ({ kind: 'child', child })),
        ];
        entries.forEach((entry, index) => {
          const isLastEntry = index === entries.length - 1;
          const connector = isLastEntry ? '└─' : '├─';

          if (entry.kind === 'thread') {
            const thread = entry.thread;
            const indent = '   '.repeat(Math.max(0, (Number(thread.depth) || 1) - 1));
            const pathLeaf = thread.agentPath ? String(thread.agentPath).split('/').filter(Boolean).pop() || '' : '';
            const idle = Number(thread.idleSeconds) || 0;
            rows.push(
              h(
                'div',
                {
                  key: `${procKey}:thread:${index}`,
                  title: `${thread.nickname}${thread.agentPath ? `\n${thread.agentPath}` : ''}\n${
                    thread.running ? '正在工作' : `最后活动 ${formatElapsed(idle)}前`
                  }`,
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '2px 8px 2px 12px',
                    minWidth: 0,
                  },
                },
                glyph(`${indent}${connector}`),
                h(Dot, { color: DOT.conversation, active: thread.running === true }),
                clampSpan(thread.nickname || pathLeaf || '子对话', {
                  flex: 'none',
                  fontSize: 10.5,
                  fontWeight: thread.running === true ? 600 : 500,
                  color: thread.running === true ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
                }),
                pathLeaf && thread.nickname
                  ? clampSpan(pathLeaf, { fontSize: 9, color: 'var(--dsw-alias-label-tertiary)' })
                  : h('span', { style: { flex: 1 } }),
                h(
                  'span',
                  { style: { flex: 'none', fontSize: 9.5, color: 'var(--dsw-alias-label-tertiary)', opacity: 0.85 } },
                  thread.running === true ? 'running' : `${formatElapsed(idle)}前`,
                ),
              ),
            );
            return;
          }

          const child = entry.child;
          rows.push(
            h(
              'div',
              {
                key: `${procKey}:${child.label}`,
                title: child.count > 1 ? `${child.count} 个 ${child.label} 子进程` : child.label,
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 8px 2px 12px',
                  minWidth: 0,
                },
              },
              glyph(connector),
              clampSpan(child.count > 1 ? `${child.label} ×${child.count}` : child.label, {
                fontSize: 10.5,
                color: 'var(--dsw-alias-label-tertiary)',
              }),
              h(
                'span',
                { style: { flex: 'none', fontSize: 9.5, color: 'var(--dsw-alias-label-tertiary)', opacity: 0.8 } },
                formatElapsed(child.elapsedSeconds),
              ),
            ),
          );
        });
      });

      const visible = rows.slice(0, MAX_ROWS);
      const stats = tree.stats || { total: 0, subagents: 0, runningLive: 0 };
      const statsLine = `会话 ${stats.total} · 子代理 ${stats.subagents} · 运行中 ${stats.runningLive}（${mode}）`;
      const busyParts = [];
      if (tree.running > 0) busyParts.push(`${tree.running} 个在跑`);
      if (tree.scheduled > 0) busyParts.push(`${tree.scheduled} 个定时`);
      const headline =
        tree.waiting > 0
          ? `${tree.waiting} 个等你处理${busyParts.length > 0 ? ` · ${busyParts.join(' · ')}` : ''}`
          : busyParts.length > 0
            ? `${tree.running > 0 ? `${tree.running} 个 agent 在跑` : '空闲'}${
                tree.scheduled > 0 ? ` · ${tree.scheduled} 个定时` : ''
              }`
            : 'Agent 树';

      return h(
        'div',
        {
          style: {
            position: 'fixed',
            left: pos.x,
            top: pos.y,
            width: WIDTH,
            zIndex: 60,
            borderRadius: 10,
            border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))',
            background: 'var(--dsw-alias-bg-layer-1, #fff)',
            boxShadow: '0 8px 28px rgba(0,0,0,.16)',
            color: 'var(--dsw-alias-label-primary)',
            overflow: 'hidden',
            userSelect: 'none',
          },
        },
        h(
          'div',
          {
            onPointerDown,
            title: `按住拖动位置\n${statsLine}`,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '5px 8px',
              cursor: 'grab',
              borderBottom: collapsed ? 'none' : '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.16))',
            },
          },
          h(Dot, {
            color: tree.waiting > 0 ? WAIT.question.color : DOT.conversation,
            active: tree.running > 0 || tree.waiting > 0,
          }),
          h(
            'span',
            {
              style: {
                flex: 1,
                fontSize: 10.5,
                letterSpacing: 0.2,
                color: 'var(--dsw-alias-label-secondary)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              },
            },
            headline,
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: (event) => {
                event.stopPropagation();
                setManualCollapsed((value) => {
                  const current = value === null ? tree.running === 0 && tree.scheduled === 0 : value;
                  return !current;
                });
              },
              title: collapsed ? '展开' : '收起',
              style: {
                flex: 'none',
                border: 0,
                background: 'transparent',
                color: 'var(--dsw-alias-label-tertiary)',
                cursor: 'pointer',
                fontSize: 10,
                lineHeight: '14px',
                padding: 0,
              },
            },
            collapsed ? '▸' : '▾',
          ),
        ),
        collapsed
          ? null
          : h(
              'div',
              { style: { maxHeight: '46vh', overflowY: 'auto', padding: '0 0 5px' } },
              visible.length === 0
                ? h(
                    'div',
                    { style: { padding: '6px 10px 2px', fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' } },
                    '当前没有在跑什么。',
                  )
                : visible,
              rows.length > MAX_ROWS
                ? h(
                    'div',
                    { style: { padding: '2px 8px 0', fontSize: 9.5, color: 'var(--dsw-alias-label-tertiary)' } },
                    `还有 ${rows.length - MAX_ROWS} 行…`,
                  )
                : null,
              h(
                'div',
                {
                  style: {
                    padding: '4px 10px 0',
                    fontSize: 9,
                    color: 'var(--dsw-alias-label-tertiary)',
                    opacity: 0.75,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  },
                },
                statsLine,
              ),
            ),
      );
    }

    function useWorkspaceSnapshot() {
      const [snapshot, setSnapshot] = React.useState(() => {
        try {
          return clientCtx && clientCtx.workspaces ? clientCtx.workspaces.list.getSnapshot() : null;
        } catch (err) {
          return null;
        }
      });
      React.useEffect(() => {
        const read = () => {
          try {
            if (!clientCtx || !clientCtx.workspaces) return;
            setSnapshot(clientCtx.workspaces.list.getSnapshot());
          } catch (err) {
            /* 忽略瞬时错误 */
          }
        };
        read();
        const timer = setInterval(read, POLL_MS);
        return () => clearInterval(timer);
      }, []);
      return snapshot;
    }

    /**
     * 拿 `remote.schedule` 命名空间。
     * 它是别的客户端插件挂上来的服务（服务名就是 `remote.schedule`），
     * 只读 `ctx.remote.schedule` 在命名空间还没挂上时会拿到 undefined，
     * 所以再用 `ctx.get('remote.schedule')` 试一次。
     */
    function scheduleRemote(ctx) {
      if (!ctx) return undefined;
      try {
        const direct = ctx.remote && ctx.remote.schedule;
        if (direct && typeof direct.catalog === 'function') return direct;
      } catch (err) {
        /* 服务还没就绪：继续走 ctx.get */
      }
      try {
        const service = typeof ctx.get === 'function' ? ctx.get('remote.schedule') : undefined;
        if (service && typeof service.catalog === 'function') return service;
      } catch (err) {
        /* 没有 schedule 能力就当没有定时任务 */
      }
      return undefined;
    }

    /** 定时任务目录：轮询 + 跟随 `schedule/changed`。 */
    function useScheduleCatalog() {
      const [schedules, setSchedules] = React.useState(() => new Map());
      React.useEffect(() => {
        let alive = true;
        const read = async () => {
          const schedule = scheduleRemote(clientCtx);
          if (!schedule) return;
          try {
            const result = await schedule.catalog();
            if (!alive || !result || result.ok !== true) return;
            setSchedules(toScheduleMap(result.value));
          } catch (err) {
            /* 读取失败保留上一份 */
          }
        };
        read();
        const timer = setInterval(read, SCHEDULE_POLL_MS);
        let dispose;
        try {
          if (clientCtx && clientCtx.remote && typeof clientCtx.remote.$on === 'function') {
            dispose = clientCtx.remote.$on(SCHEDULE_EVENT, () => read());
          }
        } catch (err) {
          /* 订阅失败只影响及时性 */
        }
        return () => {
          alive = false;
          clearInterval(timer);
          if (typeof dispose === 'function') dispose();
        };
      }, []);
      return schedules;
    }

    /** 本机 claude / codex 进程：走插件自己的宿主接口，拿不到就当没有。 */
    function useExternalProcesses() {
      const [processes, setProcesses] = React.useState([]);
      const [instances, setInstances] = React.useState(() => []);
      React.useEffect(() => {
        let alive = true;
        const read = async () => {
          try {
            const response = await fetch(PROCESS_ROUTE, { headers: { accept: 'application/json' } });
            if (!response.ok) {
              if (alive) setProcesses([]);
              return;
            }
            const data = await response.json();
            if (!alive || data === null || typeof data !== 'object') return;
            if (Array.isArray(data.processes)) setProcesses(data.processes);
            setInstances(Array.isArray(data.instances) ? data.instances : []);
          } catch (err) {
            if (alive) setProcesses([]);
          }
        };
        read();
        const timer = setInterval(read, PROCESS_POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, []);
      return { processes, instances };
    }

    function MiniLive(props) {
      const sessions = props.useSessions((snapshot) => snapshot);
      const statuses = props.useSessionStatus((value) => value);
      const workspaces = useWorkspaceSnapshot();
      const schedules = useScheduleCatalog();
      const external = useExternalProcesses();
      const tree = selectActiveTree(sessions, workspaces, statuses, schedules);
      return h(MiniInner, {
        tree,
        onOpen: props.open,
        mode: 'live',
        processes: external.processes,
        instances: external.instances,
        sessions,
        statuses,
      });
    }

    /** 没有 global props 时：轮询快照 + 自己订阅状态流。 */
    function MiniPolled({ open }) {
      const [sessions, setSessions] = React.useState(null);
      const [statuses, setStatuses] = React.useState(() => new Map());
      const workspaces = useWorkspaceSnapshot();
      const schedules = useScheduleCatalog();
      const external = useExternalProcesses();

      React.useEffect(() => {
        const read = () => {
          const ctx = clientCtx;
          if (!ctx || !ctx.sessions || !ctx.sessions.list) return;
          setSessions(ctx.sessions.list.getSnapshot());
        };
        read();
        const timer = setInterval(read, POLL_MS);
        return () => clearInterval(timer);
      }, []);

      React.useEffect(() => {
        const ctx = clientCtx;
        if (!ctx || !ctx.remote || typeof ctx.remote.$on !== 'function') return undefined;
        try {
          return ctx.remote.$on(STATUS_EVENT, (sessionId, running) => {
            setStatuses((prev) => {
              const next = new Map(prev);
              next.set(sessionId, { running: running === true });
              return next;
            });
          });
        } catch (err) {
          console.warn('[dsh-agent-tree] status subscription failed:', err);
          return undefined;
        }
      }, []);

      if (sessions === null) return null;
      const tree = selectActiveTree(sessions, workspaces, statuses, schedules);
      return h(MiniInner, {
        tree,
        onOpen: open,
        mode: 'poll',
        processes: external.processes,
        instances: external.instances,
        sessions,
        statuses,
      });
    }

    function Mini(props) {
      return props && props.useSessions && props.useSessionStatus
        ? h(MiniLive, props)
        : h(MiniPolled, { open: props && props.open });
    }

    return {
      inject: ['sessions', 'slots', 'workspaces', 'remote', 'uiWorkspace'],
      apply(ctx) {
        clientCtx = ctx;
        ensureStyles();

        const open = (id) => {
          try {
            const address = ctx.sessions.subagentAddress ? ctx.sessions.subagentAddress(id) : undefined;
            ctx.uiWorkspace.openSession(address === undefined ? id : address);
          } catch (err) {
            console.warn('[dsh-agent-tree] openSession failed:', err);
          }
        };

        ctx.effect(
          () =>
            ctx.slots.inject('shell.overlay', () =>
              ctx.slots.register({ name: 'shell.overlay', id: OVERLAY_ID, inject: () => ({ open }) }, Mini),
            ),
          'dsh-agent-tree: mini overlay',
        );
      },
      // 仅供本地单测使用。
      __test: {
        selectActiveTree,
        buildInstances,
        MiniInner,
        durationMs,
        formatDuration,
        shortTitle,
        baseName,
        workspaceLabel,
        isRunning,
        waitingKind,
        nodeRank,
        scheduleRemote,
        sortNodes,
      groupProcessChildren,
        modelLabel,
        toScheduleMap,
        scheduleMark,
        countdownLabel,
        formatElapsed,
      },
    };
  },
});
