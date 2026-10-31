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
    /** 拖动阈值：超过它才算拖动，否则算一次点击（胶囊靠它区分「拖」和「展开」）。 */
    const DRAG_THRESHOLD = 4;
    const POLL_MS = 1000;
    const STATUS_EVENT = 'api-session/status';
    const SCHEDULE_EVENT = 'schedule/changed';
    const SCHEDULE_POLL_MS = 15000;
    const PROCESS_POLL_MS = 5000;
    const PROCESS_ROUTE = '/local/dsh-agent-tree/processes';
    /** 别的 dsh 实例没有本地的实时状态，用「最近 5 分钟有过活动」判断还在干活。 */
    const INSTANCE_ACTIVE_WINDOW_MS = 5 * 60 * 1000;

    /** 客户端半部的版本；必须和 package.json 的 version 一致（verify/smoke.mjs 会校验）。 */
    const PLUGIN_VERSION = '0.1.3';
    /** 检查更新：只在用户点按钮时请求一次 npm registry（公开、只读、带 CORS 的 GET）。 */
    const NPM_PACKAGE_NAME = 'dsh-plugin-agent-tree';
    const NPM_LATEST_URL = 'https://registry.npmjs.org/dsh-plugin-agent-tree/latest';
    const RELEASES_URL = 'https://github.com/yuna78/dsh-agent-tree/releases';
    const UPDATE_KEY = 'dsh-agent-tree:update';
    const UPDATE_TIMEOUT_MS = 8000;

    const DOT = {
      conversation: 'var(--dat-dot-1, var(--dsw-alias-state-success-primary, #138a63))',
      level2: 'var(--dat-dot-2, var(--dsw-alias-brand-primary, #4d6bfe))',
      deep: 'var(--dat-dot-deep, #8b5cf6)',
      idle: 'var(--dat-dot-idle, var(--dsw-alias-border-l3, #c9ccd1))',
    };
    const KIND_DOT = { claude: '#d97757', codex: '#10a37f' };

    /** 需要你拍板的状态：琥珀色，和「在跑」的绿/蓝明确区分。 */
    const WAIT = {
      question: { color: 'var(--dat-wait, #d97706)', badge: '待答', title: '等你回答 agent 的问题' },
      approval: { color: 'var(--dat-wait, #d97706)', badge: '待批', title: '等你批准一次操作' },
      'plan-review': { color: 'var(--dat-wait, #d97706)', badge: '待审', title: '等你审阅 agent 的计划' },
    };
    const WAIT_ORDER = { question: 0, approval: 1, 'plan-review': 2 };

    const GLYPH_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

    // ------------------------------------------------------------------ 皮肤（skin）

    const SKIN_KEY = 'dsh-agent-tree:skin';
    const SKIN_CSS_TAG = OVERLAY_ID + '/skins/v1';

    /** 一套皮肤能改的变量；没定义的自动回落到 DSH 主题令牌，所以默认皮肤是空对象。 */
    const SKIN_VARS = [
      '--dat-surface',
      '--dat-pill-bg',
      '--dat-head-bg',
      '--dat-banner',
      '--dat-border',
      '--dat-shadow',
      '--dat-radius',
      '--dat-title',
      '--dat-sub',
      '--dat-muted',
      '--dat-icon',
      '--dat-chip',
      '--dat-hover',
      '--dat-ok',
      '--dat-dot-1',
      '--dat-dot-2',
      '--dat-dot-deep',
      '--dat-dot-idle',
      '--dat-wait',
      '--dat-wait-soft',
      '--dat-wait-border',
    ];

    /**
     * 内置皮肤 = 一组 CSS 变量 + 一个图标 + 可选的 header banner。
     * 想自己加一套不用改源码：页面里给 window.__DSH_AGENT_TREE_SKINS__ 塞同样结构的对象即可
     * （见 docs/skins.md），id 唯一，选中状态存在 localStorage。
     */
    /**
     * 皮肤的「外框装饰」素材：真正的图片（透明底 SVG），渲染在卡片外面、窗口后面，
     * 所以看起来像从 dock 边缘长出来。内置皮肤引用 key；DIY 皮肤可以直接塞自己的 data URI。
     */
    const SKIN_DECOR = {
      sakura: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyMDAgMjAwIj4KICA8ZGVmcz4KICAgIDxnIGlkPSJibG9zc29tIj4KICAgICAgPGcgZmlsbD0iI2ZmZDZlNiIgc3Ryb2tlPSIjZjRhNmM0IiBzdHJva2Utd2lkdGg9IjIuMiIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+CiAgICAgICAgPHBhdGggZD0iTTAgMEMtOS03LTExLTE3LTUtMjNMMC0xOUw1LTIzQzExLTE3IDktNyAwIDBaIi8+CiAgICAgICAgPHBhdGggZD0iTTAgMEMtOS03LTExLTE3LTUtMjNMMC0xOUw1LTIzQzExLTE3IDktNyAwIDBaIiB0cmFuc2Zvcm09InJvdGF0ZSg3MikiLz4KICAgICAgICA8cGF0aCBkPSJNMCAwQy05LTctMTEtMTctNS0yM0wwLTE5TDUtMjNDMTEtMTcgOS03IDAgMFoiIHRyYW5zZm9ybT0icm90YXRlKDE0NCkiLz4KICAgICAgICA8cGF0aCBkPSJNMCAwQy05LTctMTEtMTctNS0yM0wwLTE5TDUtMjNDMTEtMTcgOS03IDAgMFoiIHRyYW5zZm9ybT0icm90YXRlKDIxNikiLz4KICAgICAgICA8cGF0aCBkPSJNMCAwQy05LTctMTEtMTctNS0yM0wwLTE5TDUtMjNDMTEtMTcgOS03IDAgMFoiIHRyYW5zZm9ybT0icm90YXRlKDI4OCkiLz4KICAgICAgPC9nPgogICAgICA8Y2lyY2xlIHI9IjMuNCIgZmlsbD0iI2Y3YTFjMyIvPgogICAgICA8ZyBmaWxsPSIjZTg2YTk5Ij4KICAgICAgICA8Y2lyY2xlIGN4PSIwIiBjeT0iLTYiIHI9IjEuMiIvPjxjaXJjbGUgY3g9IjUuNyIgY3k9Ii0xLjkiIHI9IjEuMiIvPgogICAgICAgIDxjaXJjbGUgY3g9IjMuNSIgY3k9IjQuOSIgcj0iMS4yIi8+PGNpcmNsZSBjeD0iLTMuNSIgY3k9IjQuOSIgcj0iMS4yIi8+CiAgICAgICAgPGNpcmNsZSBjeD0iLTUuNyIgY3k9Ii0xLjkiIHI9IjEuMiIvPgogICAgICA8L2c+CiAgICA8L2c+CiAgPC9kZWZzPgogIDxnIHN0cm9rZT0iIzhhNWE0OCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBmaWxsPSJub25lIj4KICAgIDxwYXRoIGQ9Ik04IDE5NkMzMCAxNjggNDggMTQ4IDY2IDEzMCIgc3Ryb2tlLXdpZHRoPSI3Ii8+CiAgICA8cGF0aCBkPSJNNjYgMTMwQzg0IDExNiAxMDAgOTYgMTA4IDc2IiBzdHJva2Utd2lkdGg9IjYiLz4KICAgIDxwYXRoIGQ9Ik04NCAxMTZDOTYgMTIwIDEwNiAxMzAgMTEwIDE0MCIgc3Ryb2tlLXdpZHRoPSI0Ii8+CiAgICA8cGF0aCBkPSJNNzQgMTIyQzY0IDExNCA1NiAxMDQgNTQgOTQiIHN0cm9rZS13aWR0aD0iNCIvPgogIDwvZz4KICA8ZyBmaWxsPSIjYTljZjkzIiBzdHJva2U9IiM4ZGJiNzgiIHN0cm9rZS13aWR0aD0iMS42Ij4KICAgIDxlbGxpcHNlIGN4PSI1NCIgY3k9IjkwIiByeD0iNyIgcnk9IjEyIiB0cmFuc2Zvcm09InJvdGF0ZSgtMjggNTQgOTApIi8+CiAgICA8ZWxsaXBzZSBjeD0iMTEwIiBjeT0iMTQyIiByeD0iNyIgcnk9IjEyIiB0cmFuc2Zvcm09InJvdGF0ZSgzNCAxMTAgMTQyKSIvPgogIDwvZz4KICA8dXNlIGhyZWY9IiNibG9zc29tIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxMDggNzIpIHJvdGF0ZSgtMTIpIHNjYWxlKDEuMTUpIi8+CiAgPHVzZSBocmVmPSIjYmxvc3NvbSIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMTUyIDQ2KSByb3RhdGUoMjQpIHNjYWxlKC44MikiLz4KICA8dXNlIGhyZWY9IiNibG9zc29tIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSg2NiAxMzIpIHJvdGF0ZSg4KSBzY2FsZSgxLjApIi8+CiAgPHVzZSBocmVmPSIjYmxvc3NvbSIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMTU0IDEwOCkgcm90YXRlKC0zMCkgc2NhbGUoLjYyKSIgb3BhY2l0eT0iLjkiLz4KICA8ZyBmaWxsPSIjZmZkNmU2IiBzdHJva2U9IiNmNGE2YzQiIHN0cm9rZS13aWR0aD0iMS44Ij4KICAgIDxwYXRoIGQ9Ik0zMCAxODJjOC00IDEzLTExIDEyLTE5IDYgOSA0IDE5LTQgMjUtNCAzLTkgMi0xMi0xIDEtMiAyLTQgNC01eiIvPgogIDwvZz4KICA8ZyBmaWxsPSIjZmZkNmU2Ij4KICAgIDxwYXRoIGQ9Ik0xNDIgMTMyYzQtMyA2LTggNS0xMiAzIDUgMiAxMS0yIDE0LTIgMi01IDEtNi0xIDEtMSAyLTEgMy0xeiIgb3BhY2l0eT0iLjg1Ii8+CiAgICA8cGF0aCBkPSJNOTYgNjBjMy0yIDUtNiA0LTkgMiA0IDEgOC0yIDEwLTIgMS0zIDEtNC0xIDEgMCAyIDAgMiAweiIgb3BhY2l0eT0iLjciLz4KICA8L2c+Cjwvc3ZnPgo=',
      whale: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyMDAgMjAwIj4KICA8ZyBmaWxsPSIjYThkYmZmIiBvcGFjaXR5PSIuOCI+CiAgICA8cGF0aCBkPSJNMTggMTcwYzktMTAgMjEtMTIgMzItNiA5IDUgMTMgMTQgMjQgMTUgMTIgMSAxOC04IDMxLTcgNiAuNSAxMCAyIDE0IDZsLTQgMTJIMTh6Ii8+CiAgICA8cGF0aCBkPSJNMTI2IDE1NmM2LTYgMTQtNyAyMS0zIDUgMyA3IDggMTMgOSAzIC41IDYgMCA4LTJsNyAxNWgtNDl6IiBvcGFjaXR5PSIuNiIvPgogIDwvZz4KICA8ZyBmaWxsPSIjZTlmNmZmIj4KICAgIDxjaXJjbGUgY3g9IjQwIiBjeT0iMTI2IiByPSIzLjgiLz48Y2lyY2xlIGN4PSIxNjgiIGN5PSIxMTIiIHI9IjMiLz4KICAgIDxjaXJjbGUgY3g9IjE1MCIgY3k9Ijc2IiByPSIyLjYiLz48Y2lyY2xlIGN4PSIyNiIgY3k9IjEwMiIgcj0iMi4yIi8+CiAgPC9nPgogIDxwYXRoIGQ9Ik0xNTggMTE2YzgtMTQgMjItMjQgMzYtMjcgMiAxMi02IDI0LTE4IDMwIDEyIDYgMjAgMTggMTggMzAtMTQtMy0yOC0xMy0zNi0yN3oiIGZpbGw9IiMzYzU5ZDgiLz4KICA8ZWxsaXBzZSBjeD0iOTQiIGN5PSIxMjIiIHJ4PSI1NiIgcnk9IjQyIiBmaWxsPSIjNGY2ZmU4Ii8+CiAgPHBhdGggZD0iTTM4IDEyMmMwIDIzIDI1IDQyIDU2IDQyIDIwIDAgMzgtNyA0OC0xOS0xMCA3LTI2IDEyLTQzIDEyLTIzIDAtNDMtOS01MS0yMnoiIGZpbGw9IiNjN2Q3ZmYiIG9wYWNpdHk9Ii42Ii8+CiAgPGcgZmlsbD0iIzFlM2E4YSI+CiAgICA8ZWxsaXBzZSBjeD0iNzAiIGN5PSIxMTAiIHJ4PSI0LjYiIHJ5PSI1LjIiLz4KICAgIDxjaXJjbGUgY3g9IjcxLjYiIGN5PSIxMDguMiIgcj0iMS41IiBmaWxsPSIjZmZmIi8+CiAgPC9nPgogIDxwYXRoIGQ9Ik00OCAxMjhjNC0zIDEwLTQgMTUtMiIgc3Ryb2tlPSIjYzlkOGZmIiBzdHJva2Utd2lkdGg9IjIuOCIgZmlsbD0ibm9uZSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+CiAgPGcgc3Ryb2tlPSIjN2ZjMmY1IiBzdHJva2Utd2lkdGg9IjQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgZmlsbD0ibm9uZSI+CiAgICA8cGF0aCBkPSJNNTQgNzhjLTUtMTAtNC0yMSAzLTMwIi8+CiAgICA8cGF0aCBkPSJNNzIgNzRjLTMtOS0xLTE3IDQtMjQiLz4KICA8L2c+CiAgPGcgZmlsbD0iIzllZDRmZiI+CiAgICA8Y2lyY2xlIGN4PSI1MiIgY3k9IjM4IiByPSI0Ii8+PGNpcmNsZSBjeD0iNzAiIGN5PSI0MiIgcj0iMyIvPjxjaXJjbGUgY3g9Ijg4IiBjeT0iMzYiIHI9IjMuNCIvPgogIDwvZz4KPC9zdmc+Cg==',
    };

    const SKINS = [
      {
        id: 'default',
        name: '默认',
        desc: '跟随 DSH 主题',
        icon: 'tree',
        light: {},
        dark: {},
      },
      {
        id: 'sakura',
        name: '樱花',
        desc: '粉白 · 樱色点缀',
        icon: 'sakura',
        light: {
          '--dat-surface': '#fffafc',
          '--dat-head-bg': 'linear-gradient(135deg,#ffe3ef 0%,#fff6fa 55%,#fffafc 100%)',
          '--dat-banner':
            'radial-gradient(circle at 16% -20%,rgba(244,114,182,.42),transparent 55%),radial-gradient(circle at 88% -10%,rgba(251,207,232,.75),transparent 60%)',
          '--dat-border': 'rgba(244,114,182,.38)',
          '--dat-shadow': '0 1px 2px rgba(157,23,77,.06),0 12px 30px rgba(236,72,153,.18)',
          '--dat-radius': '15px',
          '--dat-title': '#9d174d',
          '--dat-sub': '#a3567a',
          '--dat-muted': '#b98aa0',
          '--dat-icon': '#d6427f',
          '--dat-chip': 'rgba(244,114,182,.16)',
          '--dat-hover': 'rgba(244,114,182,.12)',
          '--dat-dot-2': '#db2777',
          '--dat-dot-deep': '#c026d3',
          '--dat-dot-idle': '#ecc3d3',
        },
        dark: {
          '--dat-surface': '#241a20',
          '--dat-head-bg': 'linear-gradient(135deg,#3a1f2e 0%,#2b1c23 100%)',
          '--dat-banner':
            'radial-gradient(circle at 16% -20%,rgba(244,114,182,.32),transparent 55%),radial-gradient(circle at 90% -10%,rgba(190,24,93,.42),transparent 60%)',
          '--dat-border': 'rgba(244,114,182,.34)',
          '--dat-shadow': '0 1px 2px rgba(0,0,0,.4),0 14px 34px rgba(0,0,0,.55)',
          '--dat-title': '#fbcfe8',
          '--dat-sub': '#d9a9bd',
          '--dat-muted': '#a97e90',
          '--dat-icon': '#f472b6',
          '--dat-chip': 'rgba(244,114,182,.2)',
          '--dat-hover': 'rgba(244,114,182,.16)',
          '--dat-dot-2': '#f472b6',
          '--dat-dot-deep': '#e879f9',
          '--dat-dot-idle': '#7b5666',
        },
        decor: [
          { key: 'sakura', x: -56, y: -66, w: 158, rot: -20, opacity: 0.95 },
          { key: 'sakura', x: 238, y: -24, w: 54, rot: 24, opacity: 0.9 },
          { key: 'sakura', x: -40, y: -36, w: 108, rot: 170, flip: true, anchor: 'bottom', opacity: 0.82 },
        ],
      },
      {
        id: 'whale',
        name: '鲸鱼娘',
        desc: 'DeepSeek 蓝 · 海面渐变',
        icon: 'whale',
        light: {
          '--dat-surface': '#f7fbff',
          '--dat-head-bg': 'linear-gradient(135deg,#dbeafe 0%,#eef6ff 62%,#f7fbff 100%)',
          '--dat-banner':
            'radial-gradient(circle at 84% -20%,rgba(65,118,230,.38),transparent 58%),radial-gradient(circle at 6% 130%,rgba(56,189,248,.45),transparent 62%)',
          '--dat-border': 'rgba(65,118,230,.32)',
          '--dat-shadow': '0 1px 2px rgba(30,64,175,.08),0 12px 32px rgba(65,118,230,.2)',
          '--dat-title': '#1e3a8a',
          '--dat-sub': '#3f5f92',
          '--dat-muted': '#6f8cb5',
          '--dat-icon': '#2563eb',
          '--dat-chip': 'rgba(65,118,230,.12)',
          '--dat-hover': 'rgba(65,118,230,.1)',
          '--dat-dot-2': '#2563eb',
          '--dat-dot-deep': '#7c3aed',
          '--dat-dot-idle': '#b9cbe6',
        },
        dark: {
          '--dat-surface': '#161d2b',
          '--dat-head-bg': 'linear-gradient(135deg,#1d3a75 0%,#121a28 100%)',
          '--dat-banner':
            'radial-gradient(circle at 84% -20%,rgba(65,118,230,.45),transparent 58%),radial-gradient(circle at 8% 130%,rgba(56,189,248,.3),transparent 62%)',
          '--dat-border': 'rgba(129,140,248,.36)',
          '--dat-shadow': '0 1px 2px rgba(0,0,0,.45),0 14px 36px rgba(0,0,0,.6)',
          '--dat-title': '#dbeafe',
          '--dat-sub': '#a8c2e8',
          '--dat-muted': '#7590b8',
          '--dat-icon': '#93c5fd',
          '--dat-chip': 'rgba(129,140,248,.2)',
          '--dat-hover': 'rgba(129,140,248,.16)',
          '--dat-dot-2': '#60a5fa',
          '--dat-dot-deep': '#a78bfa',
          '--dat-dot-idle': '#54658a',
        },
        decor: [
          { key: 'whale', x: 204, y: -66, w: 96, rot: 10, opacity: 0.95 },
          { key: 'whale', x: -58, y: -30, w: 104, rot: -12, flip: true, anchor: 'bottom', opacity: 0.82 },
        ],
      },
    ];

    /** 只收自己认识的变量，值里不许出现能提前闭合声明的字符（DIY 皮肤是本地代码，仍然收一道）。 */
    function sanitizeSkinVars(raw) {
      const out = {};
      if (raw === null || typeof raw !== 'object') return out;
      for (const key of SKIN_VARS) {
        const value = raw[key];
        if (typeof value !== 'string') continue;
        const trimmed = value.trim();
        if (trimmed === '' || trimmed.length > 400) continue;
        if (/[;{}<>\\]/.test(trimmed)) continue;
        out[key] = trimmed;
      }
      return out;
    }

    function sanitizeSkin(raw) {
      if (raw === null || typeof raw !== 'object') return null;
      const id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : '';
      if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(id)) return null;
      const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim().slice(0, 24) : id;
      const desc = typeof raw.desc === 'string' ? raw.desc.trim().slice(0, 40) : '';
      const icon = typeof raw.icon === 'string' && raw.icon.trim() !== '' ? raw.icon.trim() : 'tree';
      const iconSvg =
        typeof raw.iconSvg === 'string' && raw.iconSvg.trim().indexOf('<svg') === 0
          ? raw.iconSvg.trim().slice(0, 4000)
          : '';
      return {
        id,
        name,
        desc,
        icon,
        iconSvg,
        decor: sanitizeDecor(raw.decor),
        light: sanitizeSkinVars(raw.light),
        dark: sanitizeSkinVars(raw.dark),
      };
    }

    /**
     * 外框装饰：最多 4 张图，图可以是内置素材 key，也可以是自己的 data URI（PNG/WebP/SVG）。
     * 坐标是相对卡片左上角的像素，负值就是「冒出框外」。
     */
    function sanitizeDecor(raw) {
      if (!Array.isArray(raw)) return [];
      const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
      const number = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
      const out = [];
      for (const item of raw.slice(0, 4)) {
        if (item === null || typeof item !== 'object') continue;
        let src = '';
        if (typeof item.key === 'string' && Object.prototype.hasOwnProperty.call(SKIN_DECOR, item.key)) {
          src = SKIN_DECOR[item.key];
        } else if (
          typeof item.src === 'string' &&
          /^data:image\/(svg\+xml|png|webp|gif)[;,]/i.test(item.src.trim()) &&
          item.src.length <= 400000
        ) {
          src = item.src.trim();
        }
        if (src === '') continue;
        out.push({
          src,
          x: clamp(number(item.x, 0), -180, 340),
          y: clamp(number(item.y, 0), -180, 520),
          w: clamp(number(item.w, 100), 20, 280),
          rot: clamp(number(item.rot, 0), -60, 60),
          opacity: clamp(number(item.opacity, 1), 0.15, 1),
          flip: item.flip === true,
          anchor: item.anchor === 'bottom' ? 'bottom' : 'top',
        });
      }
      return out;
    }

    /** 内置皮肤 + 页面里通过 window.__DSH_AGENT_TREE_SKINS__ 注册的 DIY 皮肤。 */
    function getSkins() {
      const out = [];
      const seen = new Set();
      const push = (raw) => {
        const skin = sanitizeSkin(raw);
        if (skin === null || seen.has(skin.id)) return;
        seen.add(skin.id);
        out.push(skin);
      };
      for (const raw of SKINS) push(raw);
      const extra =
        typeof window !== 'undefined' && Array.isArray(window.__DSH_AGENT_TREE_SKINS__)
          ? window.__DSH_AGENT_TREE_SKINS__
          : [];
      for (const raw of extra) push(raw);
      return out;
    }

    function skinCss(skins) {
      const blocks = [];
      for (const skin of skins) {
        const selector = '.dsh-agent-tree-root[data-skin=' + JSON.stringify(skin.id) + ']';
        const light = SKIN_VARS.filter((key) => skin.light[key] !== undefined)
          .map((key) => `${key}:${skin.light[key]}`)
          .join(';');
        if (light !== '') blocks.push(selector + '{' + light + '}');
        const dark = SKIN_VARS.filter((key) => skin.dark[key] !== undefined)
          .map((key) => `${key}:${skin.dark[key]}`)
          .join(';');
        if (dark !== '') blocks.push('body[data-ds-dark-theme] ' + selector + '{' + dark + '}');
      }
      return blocks.join('\n');
    }

    function ensureSkinStyles() {
      if (typeof document === 'undefined') return;
      const skins = getSkins();
      const css = skinCss(skins);
      const signature = skins.map((skin) => skin.id).join(',') + '|' + css.length;
      const tagId = JSON.stringify(SKIN_CSS_TAG);
      const stale = document.querySelector('style[data-plugin-css=' + tagId + ']');
      if (stale !== null && stale.getAttribute('data-skin-signature') === signature) return;
      if (stale !== null) stale.remove();
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-plugin-agent-tree';
      tag.dataset.pluginCss = SKIN_CSS_TAG;
      tag.setAttribute('data-skin-signature', signature);
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    function readSkinId() {
      try {
        const raw = window.localStorage.getItem(SKIN_KEY);
        if (typeof raw === 'string' && raw !== '') return raw;
      } catch (err) {
        /* localStorage 不可用：用默认皮肤 */
      }
      return 'default';
    }

    function saveSkinId(id) {
      try {
        window.localStorage.setItem(SKIN_KEY, id);
      } catch (err) {
        /* 忽略 */
      }
    }

    function resolveSkin(skins, id) {
      for (const skin of skins) {
        if (skin.id === id) return skin;
      }
      return skins[0];
    }

    // ------------------------------------------------------------ 检查更新

    /** `1.2.3` / `1.2.3-rc.1` → { core:[1,2,3], pre:'rc.1' }；不合法返回 null。 */
    function parseVersion(value) {
      if (typeof value !== 'string') return null;
      const match = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(value);
      if (!match) return null;
      return {
        core: [Number(match[1]), Number(match[2]), Number(match[3])],
        pre: match[4] || '',
      };
    }

    /** 预发布标识按 semver 比：数字段比大小，字母段按字典序（数字段 < 字母段）。 */
    function comparePrerelease(left, right) {
      if (left === right) return 0;
      if (left === '') return 1; // 正式版 > 预发布
      if (right === '') return -1;
      const a = left.split('.');
      const b = right.split('.');
      const length = Math.max(a.length, b.length);
      for (let index = 0; index < length; index += 1) {
        const x = a[index];
        const y = b[index];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        const xNum = /^\d+$/.test(x);
        const yNum = /^\d+$/.test(y);
        if (xNum && yNum) {
          if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
        } else if (xNum) {
          return -1;
        } else if (yNum) {
          return 1;
        } else if (x !== y) {
          return x < y ? -1 : 1;
        }
      }
      return 0;
    }

    /** 比较两个版本号；拿不到合法版本时按「一样新」处理，不误报有更新。 */
    function compareVersions(left, right) {
      const a = parseVersion(left);
      const b = parseVersion(right);
      if (!a || !b) return 0;
      for (let index = 0; index < 3; index += 1) {
        if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
      }
      return comparePrerelease(a.pre, b.pre);
    }

    function isNewerVersion(candidate, current) {
      return compareVersions(candidate, current) > 0;
    }

    /** 上次检查结果（只缓存最新版本号和时间，用来在按钮上留个「有新版本」的小点）。 */
    function readUpdateCache() {
      try {
        const raw = window.localStorage.getItem(UPDATE_KEY);
        if (typeof raw !== 'string' || raw === '') return null;
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object') return null;
        if (!parseVersion(parsed.latest)) return null;
        return { latest: parsed.latest, at: Number(parsed.at) || 0 };
      } catch (err) {
        /* localStorage 不可用或内容坏了：当成没查过 */
        return null;
      }
    }

    function saveUpdateCache(entry) {
      try {
        window.localStorage.setItem(UPDATE_KEY, JSON.stringify({ latest: entry.latest, at: entry.at }));
      } catch (err) {
        /* 忽略 */
      }
    }

    /** 「刚刚 / 3 分钟前 / 2 小时前」——检查时间的口语表达。 */
    function checkedAgoLabel(at, now) {
      if (!Number.isFinite(at) || at <= 0) return '';
      const diff = Math.max(0, now - at);
      if (diff < 60 * 1000) return '刚刚';
      const minutes = Math.floor(diff / 60000);
      if (minutes < 60) return `${minutes} 分钟前`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours} 小时前`;
      return `${Math.floor(hours / 24)} 天前`;
    }

    /** 按钮的 tooltip：检查中 / 有新版 / 已最新 / 失败，各说各的。 */
    function updateButtonTitle(state, available) {
      if (!state || state.phase === 'checking') return '正在检查更新…';
      if (available) return `发现新版本 v${state.latest}（点一下看升级命令）`;
      if (state.phase === 'latest') return `已是最新 v${PLUGIN_VERSION}（点一下重新检查）`;
      if (state.phase === 'error') return '检查更新失败（点一下重试）';
      return '检查更新';
    }

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

    /** 会话最近有没有活动（别的实例的会话只能靠这个判断是否还在干活）。 */
    function recentlyActive(row, now, windowMs = INSTANCE_ACTIVE_WINDOW_MS) {
      const updatedAt = Number(row && row.updatedAt) || 0;
      return updatedAt > 0 && now - updatedAt <= windowMs;
    }

    /**
     * 别的实例里这一行要不要显示：有本地实时状态就听状态，没有就只看最近活动——
     * 旧会话（几小时前）会被滤掉，卡上只留在跑的 / 等你的。
     */
    function instanceRowLive(row, statuses, now) {
      if (!row) return false;
      const live = statuses && typeof statuses.get === 'function' ? statuses.get(row.id) : undefined;
      if (live && typeof live.running === 'boolean') {
        return live.running === true || waitingKind(statuses, row.id) !== undefined;
      }
      return recentlyActive(row, now);
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
      const childIndex = childSessionsIndex(sessions);
      const out = [];
      for (const instance of list) {
        if (instance === null || typeof instance !== 'object') continue;
        const ports = Array.isArray(instance.ports) ? instance.ports.filter((port) => Number.isFinite(port)) : [];
        const ids = Array.isArray(instance.sessionIds) ? instance.sessionIds : [];
        const rows = [];
        let subagents = 0;
        for (const id of ids) {
          const row = byId[id];
          if (row === undefined) continue;
          // 别的端口里已经不工作的会话不显示，只留在跑的 / 等你的。
          if (!instanceRowLive(row, statuses, now)) continue;
          const children = (childIndex.get(id) || []).filter((childId) => {
            const child = byId[childId];
            return child !== undefined && instanceRowLive(child, statuses, now);
          });
          subagents += children.length;
          rows.push({
            id,
            title: shortTitle(row),
            waiting: waitingKind(statuses, id),
            updatedAt: Number(row.updatedAt) || 0,
            updatedLabel: formatElapsed(Math.max(0, Math.round((now - (Number(row.updatedAt) || now)) / 1000))),
            subagents: children.length,
            children: children.slice(0, 6).map((childId) => ({
              id: childId,
              title: shortTitle(byId[childId]),
              updatedAt: Number(byId[childId].updatedAt) || 0,
              updatedLabel: formatElapsed(
                Math.max(0, Math.round((now - (Number(byId[childId].updatedAt) || now)) / 1000)),
              ),
            })),
          });
        }
        rows.sort((left, right) => right.updatedAt - left.updatedAt);
        // 没有在干活的会话就连实例节点一起收掉，卡上只留活着的分支。
        if (rows.length === 0) continue;
        out.push({
          key: `inst:${instance.pid}`,
          pid: instance.pid,
          port: ports.length > 0 ? ports[0] : undefined,
          label: ports.length > 0 ? `dsh :${ports[0]}` : `dsh pid ${instance.pid}`,
          url: ports.length > 0 ? `http://127.0.0.1:${ports[0]}/` : '',
          waiting: rows.some((row) => row.waiting !== undefined),
          count: rows.length,
          subagents,
          unknown: ids.filter((id) => byId[id] === undefined).length,
          rows: rows.slice(0, 6),
        });
        if (out.length >= 4) break;
      }
      return out;
    }

    /** `sessions.byId` → `parentId -> [子会话 id]`，拿它数每个会话下挂了多少 subagent。 */
    function childSessionsIndex(sessions) {
      const index = new Map();
      const byId = sessions && sessions.byId ? sessions.byId : {};
      for (const id of Object.keys(byId)) {
        const row = byId[id];
        const parentId = row && row.parentId;
        if (typeof parentId !== 'string' || parentId === '') continue;
        const bucket = index.get(parentId);
        if (bucket === undefined) index.set(parentId, [id]);
        else bucket.push(id);
      }
      for (const bucket of index.values()) bucket.sort();
      return index;
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
      const tagId = OVERLAY_ID + '/styles/v3';
      // 热更新时把旧样式换掉，而不是直接 return，否则会用到上一版 CSS。
      const stale = document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']');
      if (stale) stale.remove();
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-plugin-agent-tree';
      tag.dataset.pluginCss = tagId;
      tag.textContent = [
        /* ---------------- 动效 ---------------- */
        '@keyframes dshAgentTreePulse{0%,100%{opacity:.3}50%{opacity:1}}',
        '@keyframes dshAgentTreeBubbleIn{from{opacity:0;transform:translateY(3px) scale(.94)}to{opacity:1;transform:translateY(0) scale(1)}}',
        '@keyframes dshAgentTreeCardIn{from{opacity:0;transform:scale(.975)}to{opacity:1;transform:scale(1)}}',
        '@keyframes dshAgentTreeSpin{to{transform:rotate(360deg)}}',
        '.dsh-agent-tree-dot-run{animation:dshAgentTreePulse 1.2s ease-in-out infinite}',
        '.dsh-agent-tree-mini-row:hover{background:var(--dat-hover,var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1)))}',
        /* ---------------- 展开态的卡片 ---------------- */
        '.dsh-agent-tree-card{position:relative;display:flex;flex-direction:column;border-radius:var(--dat-radius,14px);border:1px solid var(--dat-border,var(--dsw-alias-border-l2,rgba(127,127,127,.28)));background:var(--dat-surface,var(--dsw-alias-bg-layer-1,#fff));box-shadow:var(--dat-shadow,var(--dsw-elevation-panel,0 8px 28px rgba(0,0,0,.16)));color:var(--dat-text,var(--dsw-alias-label-primary,#111));overflow:hidden;font-family:var(--dsw-font-family,system-ui,-apple-system,"PingFang SC",sans-serif);animation:dshAgentTreeCardIn .16s ease-out}',
        /* 皮肤外框装饰：绝对定位在卡片外层，卡片盖在上面，所以只露出框外的部分 */
        '.dsh-agent-tree-decor-layer{position:absolute;inset:0;pointer-events:none;z-index:0}',
        '.dsh-agent-tree-decor{position:absolute;display:block;pointer-events:none;user-select:none;-webkit-user-drag:none;z-index:0}',
        /* 标题层：图标 + 插件名 + 状态副行，像 plugin dock 的窗口头 */
        '.dsh-agent-tree-head{display:flex;align-items:center;gap:8px;padding:7px 8px 6px 10px;cursor:grab;touch-action:none;border-bottom:1px solid var(--dat-border,var(--dsw-alias-border-l1,rgba(127,127,127,.16)));background-color:var(--dat-head-bg,transparent);background-image:var(--dat-banner,none);background-size:100% 100%;background-repeat:no-repeat}',
        '.dsh-agent-tree-head:active{cursor:grabbing}',
        '.dsh-agent-tree-head-icon{flex:none;display:flex;align-items:center;justify-content:center;width:18px;height:18px;color:var(--dat-icon,var(--dsw-alias-label-secondary,#61666b))}',
        '.dsh-agent-tree-head-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}',
        '.dsh-agent-tree-head-title{font-size:12px;font-weight:600;letter-spacing:.2px;color:var(--dat-title,var(--dsw-alias-label-primary,#0f1115));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.dsh-agent-tree-head-sub{display:flex;align-items:center;gap:5px;min-width:0;font-size:9.5px;letter-spacing:.1px;color:var(--dat-muted,var(--dsw-alias-label-tertiary,#adb2b8));white-space:nowrap;overflow:hidden}',
        '.dsh-agent-tree-head-subtext{min-width:0;overflow:hidden;text-overflow:ellipsis}',
        /* 最小化按钮：无底色 ghost 图标，hover 才出现浅灰底 */
        '.dsh-agent-tree-minbtn{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;margin-left:1px;padding:0;border:0;border-radius:6px;background:none;color:var(--dat-muted,var(--dsw-alias-label-tertiary,#adb2b8));cursor:pointer;transition:background .14s ease,color .14s ease}',
        '.dsh-agent-tree-minbtn:hover{background:var(--dat-hover,var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12)));color:var(--dat-sub,var(--dsw-alias-label-secondary,#61666b))}',
        '.dsh-agent-tree-minbtn:active{background:var(--dat-hover,var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16)))}',
        '.dsh-agent-tree-minbtn:focus-visible,.dsh-agent-tree-pill:focus-visible{outline:2px solid rgba(65,118,230,.9);outline-offset:2px}',
        /* 检查更新：转圈 + 有新版本时右上角一个小点 */
        '.dsh-agent-tree-minbtn.is-busy svg{animation:dshAgentTreeSpin .85s linear infinite}',
        '.dsh-agent-tree-updot{position:absolute;top:4px;right:4px;width:5px;height:5px;border-radius:999px;background:var(--dat-dot-2,var(--dsw-alias-brand-primary,#4d6bfe));box-shadow:0 0 0 1.5px var(--dat-surface,var(--dsw-alias-bg-layer-1,#fff))}',
        /* ---------------- 收起态：圆头圆脑的胶囊 ---------------- */
        '.dsh-agent-tree-pill{display:flex;align-items:center;gap:6px;height:34px;max-width:340px;padding:0 8px 0 9px;border-radius:999px;border:1px solid var(--dat-border,var(--dsw-alias-border-l2,rgba(127,127,127,.28)));background:var(--dat-pill-bg,var(--dat-surface,var(--dsw-alias-bg-layer-1,#fff)));box-shadow:var(--dat-shadow,var(--dsw-elevation-panel,0 4px 16px rgba(0,0,0,.14)));color:var(--dat-text,var(--dsw-alias-label-primary,#111));font-family:var(--dsw-font-family,system-ui,-apple-system,"PingFang SC",sans-serif);font-size:11.5px;line-height:1;font-weight:600;letter-spacing:.2px;cursor:grab;touch-action:none;user-select:none;transition:box-shadow .16s ease,transform .16s ease,background .16s ease;animation:dshAgentTreeBubbleIn .18s cubic-bezier(.22,.8,.34,1)}',
        '.dsh-agent-tree-pill:hover{transform:translateY(-1px);background:var(--dat-hover,var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1)));box-shadow:0 2px 4px rgba(0,0,0,.05),0 10px 26px rgba(0,0,0,.18)}',
        '.dsh-agent-tree-pill:active{cursor:grabbing;transform:translateY(0);box-shadow:var(--dsw-elevation-panel,0 4px 16px rgba(0,0,0,.14))}',
        '.dsh-agent-tree-pill-glyph{flex:none;display:flex;align-items:center;color:var(--dat-icon,var(--dsw-alias-label-secondary,#61666b))}',
        '.dsh-agent-tree-pill-name{flex:0 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11.5px;color:var(--dat-title,var(--dsw-alias-label-primary,#111))}',
        '.dsh-agent-tree-pill-chip{display:inline-flex;align-items:center;gap:3px;flex:none;height:19px;padding:0 6px 0 5px;border-radius:999px;background:var(--dat-chip,var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1)));color:var(--dat-sub,var(--dsw-alias-label-secondary,#61666b));font-size:10px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1}',
        '.dsh-agent-tree-pill-chip svg{flex:none;display:block}',
        '.dsh-agent-tree-pill-agents{color:var(--dat-ok,var(--dsw-alias-state-success-primary,#138a63))}',
        '.dsh-agent-tree-pill-wait{color:var(--dat-wait-strong,var(--dat-wait,#b45309));background:var(--dat-wait-soft,rgba(217,119,6,.14))}',
        '.dsh-agent-tree-pill-chevron{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:999px;color:var(--dat-muted,var(--dsw-alias-label-tertiary,#adb2b8));opacity:.65;transition:opacity .14s ease,transform .14s ease,background .14s ease}',
        '.dsh-agent-tree-pill:hover .dsh-agent-tree-pill-chevron{opacity:1;background:var(--dat-chip,var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1)));transform:translateY(-1px)}',
        /* 换肤面板：在标题层下面展开，不脱离文档流，卡片 overflow:hidden 也不会裁掉 */
        '.dsh-agent-tree-skinpanel{display:flex;flex-direction:column;gap:2px;padding:4px 6px 6px;border-bottom:1px solid var(--dat-border,var(--dsw-alias-border-l1,rgba(127,127,127,.16)));animation:dshAgentTreeBubbleIn .14s ease-out}',
        '.dsh-agent-tree-skinitem{display:flex;align-items:center;gap:7px;padding:4px 6px;border:0;border-radius:7px;background:none;cursor:pointer;text-align:left;font-family:inherit;font-size:10.5px;line-height:1.2;color:var(--dat-sub,var(--dsw-alias-label-secondary,#61666b))}',
        '.dsh-agent-tree-skinitem:hover{background:var(--dat-hover,var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1)));color:var(--dat-title,var(--dsw-alias-label-primary,#0f1115))}',
        '.dsh-agent-tree-skinitem.is-active{font-weight:600;color:var(--dat-title,var(--dsw-alias-label-primary,#0f1115))}',
        '.dsh-agent-tree-skinswatch{flex:none;width:14px;height:14px;border-radius:999px;border:1px solid var(--dat-border,var(--dsw-alias-border-l2,rgba(127,127,127,.28)))}',
        '.dsh-agent-tree-skindesc{margin-left:auto;padding-left:10px;font-size:9px;font-weight:400;color:var(--dat-muted,var(--dsw-alias-label-tertiary,#adb2b8))}',
        '.dsh-agent-tree-skincheck{flex:none;display:inline-flex;color:var(--dat-icon,var(--dsw-alias-label-secondary,#61666b))}',
        '.dsh-agent-tree-skinicon{display:inline-flex;align-items:center;justify-content:center;width:100%;height:100%}',
        '.dsh-agent-tree-skinicon svg{width:100%;height:100%;display:block}',
        /* 检查更新面板：同样是标题层下面的 in-flow 一行，卡片 overflow:hidden 也不会裁掉 */
        '.dsh-agent-tree-updatepanel{display:flex;flex-direction:column;gap:6px;padding:8px 10px 9px;border-bottom:1px solid var(--dat-border,var(--dsw-alias-border-l1,rgba(127,127,127,.16)));animation:dshAgentTreeBubbleIn .14s ease-out}',
        '.dsh-agent-tree-uprow{display:flex;align-items:center;gap:6px;min-width:0}',
        '.dsh-agent-tree-uptitle{font-size:10.5px;font-weight:600;color:var(--dat-title,var(--dsw-alias-label-primary,#0f1115));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.dsh-agent-tree-upnote{font-size:9px;line-height:1.5;color:var(--dat-muted,var(--dsw-alias-label-tertiary,#adb2b8))}',
        '.dsh-agent-tree-uprow .dsh-agent-tree-upnote{margin-left:auto;padding-left:8px;white-space:nowrap}',
        '.dsh-agent-tree-upspin{flex:none;display:inline-flex;color:var(--dat-icon,var(--dsw-alias-label-secondary,#61666b));animation:dshAgentTreeSpin .85s linear infinite}',
        '.dsh-agent-tree-upok{flex:none;display:inline-flex;color:var(--dat-ok,var(--dsw-alias-state-success-primary,#138a63))}',
        '.dsh-agent-tree-upcmd{display:flex;align-items:center;gap:6px;min-width:0;padding:4px 5px 4px 7px;border-radius:7px;background:var(--dat-chip,var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1)))}',
        '.dsh-agent-tree-upcmd code{flex:1;min-width:0;overflow-x:auto;scrollbar-width:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9px;line-height:1.5;color:var(--dat-text,var(--dsw-alias-label-primary,#0f1115));white-space:nowrap}',
        '.dsh-agent-tree-upcopy{flex:none;border:0;border-radius:5px;padding:2px 6px;background:var(--dat-surface,var(--dsw-alias-bg-layer-1,#fff));color:var(--dat-sub,var(--dsw-alias-label-secondary,#61666b));font-family:inherit;font-size:9px;font-weight:600;line-height:1.4;cursor:pointer}',
        '.dsh-agent-tree-upcopy:hover{color:var(--dat-title,var(--dsw-alias-label-primary,#0f1115));background:var(--dat-hover,var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12)))}',
        '.dsh-agent-tree-upactions{display:flex;align-items:center;justify-content:space-between;gap:8px}',
        '.dsh-agent-tree-uplink{font-size:9px;font-weight:600;text-decoration:none;color:var(--dat-dot-2,var(--dsw-alias-brand-primary,#4d6bfe))}',
        '.dsh-agent-tree-uplink:hover{text-decoration:underline}',
        '@media (prefers-reduced-motion:reduce){.dsh-agent-tree-pill,.dsh-agent-tree-card,.dsh-agent-tree-dot-run,.dsh-agent-tree-skinpanel,.dsh-agent-tree-updatepanel{animation:none!important;transition:none!important}.dsh-agent-tree-minbtn.is-busy svg,.dsh-agent-tree-upspin{animation:none!important}}',
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

    /** 收起成胶囊的「最小化」小横杠。矢量画，比字符清晰。 */
    function MinusIcon({ size = 11 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 12 12',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        h('path', {
          d: 'M3.4 6h5.2',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
        }),
      );
    }

    /** 品牌小图标：插件 icon 的单色版——左边一个根节点，右边挂三个子节点。 */
    function TreeIcon({ size = 15 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        h('circle', { cx: 2.9, cy: 8, r: 1.35, stroke: 'currentColor', strokeWidth: 1.15 }),
        h('path', {
          d: 'M4.35 8h1.5M5.85 3.7v8.6M5.85 3.7h1.9M5.85 8h1.9M5.85 12.3h1.9',
          stroke: 'currentColor',
          strokeWidth: 1.15,
          strokeLinecap: 'round',
        }),
        h('circle', { cx: 9.45, cy: 3.7, r: 1.3, stroke: 'currentColor', strokeWidth: 1.15 }),
        h('circle', { cx: 9.45, cy: 8, r: 1.3, stroke: 'currentColor', strokeWidth: 1.15 }),
        h('circle', { cx: 9.45, cy: 12.3, r: 1.3, stroke: 'currentColor', strokeWidth: 1.15 }),
      );
    }

    /** 胶囊里的「agent 数」单色机器人。 */
    function RobotIcon({ size = 12 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 12 12',
          fill: 'none',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        h('rect', { x: 1.9, y: 4.1, width: 8.2, height: 5.7, rx: 1.8, stroke: 'currentColor', strokeWidth: 1.15 }),
        h('path', { d: 'M6 4.1V2.3', stroke: 'currentColor', strokeWidth: 1.15, strokeLinecap: 'round' }),
        h('circle', { cx: 6, cy: 1.7, r: 0.62, fill: 'currentColor' }),
        h('circle', { cx: 4.3, cy: 6.6, r: 0.75, fill: 'currentColor' }),
        h('circle', { cx: 7.7, cy: 6.6, r: 0.75, fill: 'currentColor' }),
      );
    }

    /** 胶囊里的「定时数」单色闹钟。 */
    function ClockIcon({ size = 12 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 12 12',
          fill: 'none',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        h('circle', { cx: 6, cy: 6.2, r: 4.1, stroke: 'currentColor', strokeWidth: 1.15 }),
        h('path', {
          d: 'M6 3.8v2.6l1.7 1.05',
          stroke: 'currentColor',
          strokeWidth: 1.15,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    /** 樱花皮肤的花瓣图标（5 瓣带缺口，线稿）。 */
    function SakuraIcon({ size = 15 }) {
      const petal = h('path', {
        d: 'M8 7.7C6.35 7.15 5.7 5.6 6.15 4.35 6.4 3.65 6.95 3.2 7.35 2.7L8 3.3l.65-.6c.4.5.95.95 1.2 1.65.45 1.25-.2 2.8-1.85 3.35Z',
        stroke: 'currentColor',
        strokeWidth: 0.95,
        strokeLinejoin: 'round',
      });
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        [0, 72, 144, 216, 288].map((deg, index) =>
          h('g', { key: `p${index}`, transform: `rotate(${deg} 8 8)` }, petal),
        ),
        h('circle', { cx: 8, cy: 8, r: 0.95, fill: 'currentColor' }),
      );
    }

    /** 鲸鱼娘皮肤的鲸鱼图标（单色线稿：圆头 + 尾鳍 + 喷水）。 */
    function WhaleIcon({ size = 15 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        h('path', {
          d: 'M2.5 9.9c0-2 1.95-3.6 4.4-3.6 2 0 3.55.9 4.2 2.25l2.55-1.45c.24-.14.55.03.55.3v4.1c0 .27-.31.44-.55.3L11.1 10.35C10.45 11.7 8.9 12.6 6.9 12.6c-2.45 0-4.4-1.6-4.4-3.6Z',
          stroke: 'currentColor',
          strokeWidth: 0.95,
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 5.2, cy: 9.5, r: 0.55, fill: 'currentColor' }),
        h('path', {
          d: 'M5.8 5.2c-.5-.5-.7-1.2-.5-1.9',
          stroke: 'currentColor',
          strokeWidth: 0.8,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M7.2 4.8c-.35-.45-.45-1-.3-1.55',
          stroke: 'currentColor',
          strokeWidth: 0.8,
          strokeLinecap: 'round',
        }),
      );
    }

    /** 换肤按钮的「颜色」图标（一滴颜料，比调色盘在 11px 更清楚）。 */
    function PaletteIcon({ size = 11 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 12 12',
          fill: 'none',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        h('path', {
          d: 'M6 1.3c1.85 1.75 3.15 3.25 3.15 4.95a3.15 3.15 0 1 1-6.3 0C2.85 4.55 4.15 3.05 6 1.3Z',
          stroke: 'currentColor',
          strokeWidth: 1.05,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M4.4 6.4a1.65 1.65 0 0 0 1.5 1.65',
          stroke: 'currentColor',
          strokeWidth: 0.95,
          strokeLinecap: 'round',
          opacity: 0.85,
        }),
      );
    }

    /** 检查更新的转圈图标：两段圆弧 + 箭头，检查中整颗 icon 会转。 */
    function RefreshIcon({ size = 11 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 12 12',
          fill: 'none',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        h('path', {
          d: 'M1.5 6a4.5 4.5 0 0 1 4.5-4.5c1.3 0 2.5.55 3.37 1.37L10.5 4',
          stroke: 'currentColor',
          strokeWidth: 1.1,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M10.5 1.5v2.5H8',
          stroke: 'currentColor',
          strokeWidth: 1.1,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M10.5 6a4.5 4.5 0 0 1-4.5 4.5c-1.3 0-2.5-.55-3.37-1.37L1.5 8',
          stroke: 'currentColor',
          strokeWidth: 1.1,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M1.5 10.5V8H4',
          stroke: 'currentColor',
          strokeWidth: 1.1,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    function CheckIcon({ size = 12 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 12 12',
          fill: 'none',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        h('path', {
          d: 'M2.6 6.3 4.9 8.6 9.4 3.6',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    /** 按皮肤画 icon：树 / 樱花 / 鲸鱼，或者 DIY 时直接给的 <svg> 字符串。 */
    function SkinGlyph({ skin, size = 15 }) {
      const icon = skin && skin.icon ? skin.icon : 'tree';
      if (skin && typeof skin.iconSvg === 'string' && skin.iconSvg !== '') {
        return h('span', {
          className: 'dsh-agent-tree-skinicon',
          style: { width: size, height: size },
          dangerouslySetInnerHTML: { __html: skin.iconSvg },
        });
      }
      if (icon === 'sakura') return h(SakuraIcon, { size });
      if (icon === 'whale') return h(WhaleIcon, { size });
      if (icon === 'robot') return h(RobotIcon, { size });
      if (icon === 'clock') return h(ClockIcon, { size });
      return h(TreeIcon, { size });
    }

    /** 换肤面板里的小色块：一半是皮肤的 icon 色，一半是它的表面色。 */
    function skinSwatch(skin) {
      const icon = (skin && skin.light && skin.light['--dat-icon']) || '';
      const dot = (skin && skin.light && (skin.light['--dat-dot-2'] || skin.light['--dat-dot-deep'])) || '';
      const surface = (skin && skin.light && skin.light['--dat-surface']) || '';
      const primary = icon || dot || 'var(--dsw-alias-label-tertiary, #adb2b8)';
      const back = surface || 'var(--dsw-alias-bg-layer-1, #fff)';
      return `linear-gradient(135deg, ${primary} 0%, ${primary} 46%, ${back} 54%, ${back} 100%)`;
    }

    /** 胶囊右侧的「点开」小箭头。 */
    function ChevronIcon({ direction = 'up', size = 12 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 12 12',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        h('path', {
          d: direction === 'up' ? 'M2.6 7.4 6 4l3.4 3.4' : 'M2.6 4.6 6 8l3.4-3.4',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
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
            color: 'var(--dat-muted, var(--dsw-alias-label-tertiary))',
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
            color: 'var(--dat-muted, var(--dsw-alias-label-tertiary))',
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
            border: '1px solid var(--dat-wait-border, rgba(217,119,6,.33))',
            background: 'var(--dat-wait-soft, rgba(217,119,6,.14))',
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
      const [skinId, setSkinId] = React.useState(() => readSkinId());
      const [skinMenuOpen, setSkinMenuOpen] = React.useState(false);
      const [updateCheck, setUpdateCheck] = React.useState(() => {
        const cache = readUpdateCache();
        return {
          phase: 'idle',
          latest: cache ? cache.latest : '',
          checkedAt: cache ? cache.at : 0,
          error: '',
        };
      });
      const [updatePanelOpen, setUpdatePanelOpen] = React.useState(false);
      const [updateCopied, setUpdateCopied] = React.useState(false);
      const updateAbortRef = React.useRef(null);
      const updateRequestRef = React.useRef(0);
      const skins = getSkins();
      const skin = resolveSkin(skins, skinId);
      const skinSignature = skins.map((item) => item.id).join(',');
      const now = useNow();

      React.useEffect(() => {
        ensureSkinStyles();
      }, [skinSignature]);

      React.useEffect(() => {
        if (!skinMenuOpen && !updatePanelOpen) return undefined;
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          setSkinMenuOpen(false);
          setUpdatePanelOpen(false);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [skinMenuOpen, updatePanelOpen]);

      React.useEffect(
        () => () => {
          if (updateAbortRef.current) updateAbortRef.current.abort();
        },
        [],
      );

      const pickSkin = (id) => {
        setSkinId(id);
        saveSkinId(id);
        setSkinMenuOpen(false);
      };

      const updateAvailable =
        updateCheck.latest !== '' && isNewerVersion(updateCheck.latest, PLUGIN_VERSION);
      const upgradeCommand = `dsh plugin --profile web add ${NPM_PACKAGE_NAME}@latest`;

      /** 点一下才联网：向 npm registry 要一次 latest（只读 GET，不带 cookie）。 */
      const runUpdateCheck = () => {
        setUpdatePanelOpen(true);
        setSkinMenuOpen(false);
        setUpdateCheck((state) => ({ ...state, phase: 'checking', error: '' }));
        if (updateAbortRef.current) updateAbortRef.current.abort();
        updateRequestRef.current += 1;
        const requestId = updateRequestRef.current;
        const current = () => updateRequestRef.current === requestId;
        let controller = null;
        try {
          if (typeof AbortController === 'function') controller = new AbortController();
        } catch (err) {
          controller = null;
        }
        updateAbortRef.current = controller;
        const timer = window.setTimeout(() => {
          if (controller) controller.abort();
        }, UPDATE_TIMEOUT_MS);
        const finish = (next) => {
          window.clearTimeout(timer);
          if (!current()) return;
          updateAbortRef.current = null;
          setUpdateCheck(next);
        };
        const options = { cache: 'no-store' };
        if (controller) options.signal = controller.signal;
        fetch(NPM_LATEST_URL, options)
          .then((response) => {
            if (!response.ok) throw new Error(`npm registry 返回 HTTP ${response.status}`);
            return response.json();
          })
          .then((payload) => {
            const latest = payload && typeof payload.version === 'string' ? payload.version : '';
            if (!parseVersion(latest)) throw new Error('返回里没有可用的版本号');
            const at = Date.now();
            saveUpdateCache({ latest, at });
            finish({
              phase: isNewerVersion(latest, PLUGIN_VERSION) ? 'outdated' : 'latest',
              latest,
              checkedAt: at,
              error: '',
            });
          })
          .catch((err) => {
            const timedOut = err && err.name === 'AbortError';
            const message = timedOut
              ? '超时（8s），浏览器没等到 npm registry'
              : String((err && err.message) || err || '未知错误');
            finish({
              phase: 'error',
              latest: updateCheck.latest,
              checkedAt: updateCheck.checkedAt,
              error: message.slice(0, 120),
            });
          });
      };

      const copyUpgradeCommand = () => {
        const done = () => {
          setUpdateCopied(true);
          window.setTimeout(() => setUpdateCopied(false), 1600);
        };
        const fallback = () => {
          try {
            const area = document.createElement('textarea');
            area.value = upgradeCommand;
            area.setAttribute('readonly', '');
            area.style.position = 'fixed';
            area.style.opacity = '0';
            document.body.appendChild(area);
            area.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(area);
            if (ok) done();
          } catch (err) {
            /* 复制失败也不影响面板，用户还能手动选 */
          }
        };
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(upgradeCommand).then(done, fallback);
            return;
          }
        } catch (err) {
          /* 落到 fallback */
        }
        fallback();
      };

      const renderUpdatePanel = () => {
        const phase = updateCheck.phase;
        const rows = [];
        if (phase === 'checking') {
          rows.push(
            h(
              'div',
              { key: 'head', className: 'dsh-agent-tree-uprow' },
              h('span', { className: 'dsh-agent-tree-upspin' }, h(RefreshIcon, { size: 11 })),
              h('span', { className: 'dsh-agent-tree-uptitle' }, '正在检查更新…'),
              h('span', { className: 'dsh-agent-tree-upnote' }, 'npm registry'),
            ),
          );
        } else if (phase === 'outdated') {
          rows.push(
            h(
              'div',
              { key: 'head', className: 'dsh-agent-tree-uprow' },
              h('span', { className: 'dsh-agent-tree-uptitle' }, `发现新版本 v${updateCheck.latest}`),
              h('span', { className: 'dsh-agent-tree-upnote' }, `当前 v${PLUGIN_VERSION}`),
            ),
            h(
              'div',
              { key: 'cmd', className: 'dsh-agent-tree-upcmd' },
              h('code', null, upgradeCommand),
              h(
                'button',
                { type: 'button', className: 'dsh-agent-tree-upcopy', onClick: copyUpgradeCommand },
                updateCopied ? '已复制' : '复制',
              ),
            ),
            h(
              'div',
              { key: 'note', className: 'dsh-agent-tree-upnote' },
              '复制后到终端运行，重启 dsh 并硬刷新页面生效。',
            ),
            h(
              'div',
              { key: 'actions', className: 'dsh-agent-tree-upactions' },
              h(
                'a',
                {
                  className: 'dsh-agent-tree-uplink',
                  href: RELEASES_URL,
                  target: '_blank',
                  rel: 'noreferrer noopener',
                },
                '更新说明 ↗',
              ),
              h(
                'button',
                { type: 'button', className: 'dsh-agent-tree-upcopy', onClick: runUpdateCheck },
                '重新检查',
              ),
            ),
          );
        } else if (phase === 'latest') {
          const ago = checkedAgoLabel(updateCheck.checkedAt, now);
          rows.push(
            h(
              'div',
              { key: 'head', className: 'dsh-agent-tree-uprow' },
              h('span', { className: 'dsh-agent-tree-upok' }, h(CheckIcon, { size: 11 })),
              h('span', { className: 'dsh-agent-tree-uptitle' }, `已是最新 · v${PLUGIN_VERSION}`),
            ),
            h(
              'div',
              { key: 'note', className: 'dsh-agent-tree-upnote' },
              `${ago === '' ? '刚刚' : ago}检查过 npm registry`,
            ),
          );
        } else if (phase === 'error') {
          rows.push(
            h(
              'div',
              { key: 'head', className: 'dsh-agent-tree-uprow' },
              h('span', { className: 'dsh-agent-tree-uptitle' }, '检查更新失败'),
              h(
                'button',
                { type: 'button', className: 'dsh-agent-tree-upcopy', onClick: runUpdateCheck },
                '重试',
              ),
            ),
            h(
              'div',
              { key: 'note', className: 'dsh-agent-tree-upnote' },
              updateCheck.error || '浏览器拿不到 npm registry（离线或网络被拦）。',
            ),
          );
        } else {
          rows.push(
            h(
              'div',
              { key: 'head', className: 'dsh-agent-tree-uprow' },
              h('span', { className: 'dsh-agent-tree-uptitle' }, '检查插件更新'),
              h('span', { className: 'dsh-agent-tree-upnote' }, `当前 v${PLUGIN_VERSION}`),
            ),
            h(
              'div',
              { key: 'note', className: 'dsh-agent-tree-upnote' },
              '点一下向 npm registry 查一次最新版本（只读 GET，不带 cookie）。',
            ),
          );
        }
        return h(
          'div',
          { className: 'dsh-agent-tree-updatepanel', role: 'status', 'aria-live': 'polite' },
          rows,
        );
      };
      const [pos, setPos] = React.useState(() => {
        const saved = readSavedPos();
        if (saved !== null) return saved;
        const width = typeof window !== 'undefined' ? window.innerWidth : 1280;
        const height = typeof window !== 'undefined' ? window.innerHeight : 800;
        return { x: Math.max(8, width - WIDTH - 20), y: Math.max(8, height - 300) };
      });

      const rootRef = React.useRef(null);
      /** 记录这次按下有没有变成拖动：有拖动就不把 pointerup 之后的 click 当成「展开」。 */
      const movedRef = React.useRef(false);

      const beginDrag = (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        movedRef.current = false;
        const startX = event.clientX;
        const startY = event.clientY;
        const baseX = pos.x;
        const baseY = pos.y;
        const onMove = (moveEvent) => {
          const dx = moveEvent.clientX - startX;
          const dy = moveEvent.clientY - startY;
          if (!movedRef.current && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
          movedRef.current = true;
          const width = rootRef.current ? rootRef.current.offsetWidth : WIDTH;
          const maxX = Math.max(0, window.innerWidth - width - 4);
          const maxY = Math.max(0, window.innerHeight - 36);
          setPos({
            x: Math.min(maxX, Math.max(0, baseX + dx)),
            y: Math.min(maxY, Math.max(0, baseY + dy)),
          });
        };
        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          if (!movedRef.current) return;
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
                  style: { flex: 'none', fontSize: 8.5, color: 'var(--dat-muted, var(--dsw-alias-label-tertiary))' },
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
                      color: 'var(--dat-muted, var(--dsw-alias-label-tertiary))',
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
                  color: node.waiting ? WAIT[node.waiting].color : 'var(--dat-text, var(--dsw-alias-label-primary))',
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
                    ? 'var(--dat-text, var(--dsw-alias-label-primary))'
                    : 'var(--dat-muted, var(--dsw-alias-label-tertiary))',
              }),
              node.waiting ? h(WaitBadge, { kind: node.waiting }) : clock,
              h(ModelChip, { text: model, inherited: own === '' && model !== '' }),
              h(
                'span',
                { style: { flex: 'none', fontSize: 9.5, color: 'var(--dat-muted, var(--dsw-alias-label-tertiary))' } },
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
              color: 'var(--dat-muted, var(--dsw-alias-label-tertiary))',
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
          clampSpan('dsh', { flex: 'none', fontSize: 11, fontWeight: 600, color: 'var(--dat-text, var(--dsw-alias-label-primary))' }),
          h('span', { style: { flex: 1 } }),
          h(
            'span',
            { style: { flex: 'none', fontSize: 9.5, color: 'var(--dat-muted, var(--dsw-alias-label-tertiary))' } },
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
                  color: 'var(--dat-muted, var(--dsw-alias-label-tertiary))',
                  textAlign: 'center',
                },
              },
              groupOpen ? '▾' : '▸',
            ),
            clampSpan(group.label, { fontSize: 11, fontWeight: 600, color: 'var(--dat-text, var(--dsw-alias-label-primary))' }),
            h(
              'span',
              { style: { flex: 'none', fontSize: 9.5, color: 'var(--dat-muted, var(--dsw-alias-label-tertiary))' } },
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
              title: [
                instance.label,
                instance.port === undefined ? '' : instance.url,
                instance.unknown > 0 ? `另有 ${instance.unknown} 个会话不在本实例的会话表里` : '',
                '只列在跑 / 等你的会话',
              ]
                .filter((line) => line !== '')
                .join('\n'),
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
              color: 'var(--dat-text, var(--dsw-alias-label-primary))',
            }),
            h('span', { style: { flex: 1 } }),
            h(
              'span',
              { style: { flex: 'none', fontSize: 9.5, color: 'var(--dat-muted, var(--dsw-alias-label-tertiary))' } },
              instance.count > 0
                ? `${instance.count} 个会话${instance.subagents > 0 ? ` · ${instance.subagents} 子代理` : ''}`
                : instance.unknown > 0
                  ? `${instance.unknown} 个会话（不在本实例）`
                  : '0 个会话',
            ),
          ),
        );
        if (!instOpen) return;
        instance.rows.forEach((row, rowIndex) => {
          const isLast = rowIndex === instance.rows.length - 1;
          const rowKey = `${instKey}:${row.id}`;
          const rowOpen = !collapsedNodes[rowKey];
          rows.push(
            h(
              'div',
              {
                key: rowKey,
                className: 'dsh-agent-tree-mini-row',
                onClick: openInstance,
                title: `${row.title}\n${instance.label}\n${row.id}${
                  row.subagents > 0 ? `\n${row.subagents} 个 subagent` : ''
                }`,
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
              row.subagents > 0
                ? h(
                    'span',
                    {
                      onClick: (event) => {
                        event.stopPropagation();
                        toggle(rowKey);
                      },
                      style: {
                        width: 8,
                        flex: 'none',
                        fontSize: 8.5,
                        color: 'var(--dat-muted, var(--dsw-alias-label-tertiary))',
                        textAlign: 'center',
                        cursor: 'pointer',
                      },
                    },
                    rowOpen ? '▾' : '▸',
                  )
                : h('span', { style: { width: 8, flex: 'none' } }),
              h(Dot, {
                color: row.waiting ? WAIT[row.waiting].color : DOT.level2,
                active: row.waiting !== undefined,
              }),
              clampSpan(row.title, {
                fontSize: 10.5,
                color: row.waiting ? WAIT[row.waiting].color : 'var(--dat-sub, var(--dsw-alias-label-secondary))',
              }),
              row.waiting ? h(WaitBadge, { kind: row.waiting }) : null,
              row.subagents > 0
                ? h(
                    'span',
                    { style: { flex: 'none', fontSize: 9, color: 'var(--dat-muted, var(--dsw-alias-label-tertiary))' } },
                    `${row.subagents}子`,
                  )
                : null,
              h(
                'span',
                { style: { flex: 'none', fontSize: 9.5, color: 'var(--dat-muted, var(--dsw-alias-label-tertiary))' } },
                row.updatedLabel,
              ),
            ),
          );
          if (!rowOpen || row.subagents === 0) return;
          row.children.forEach((child, childIndex2) => {
            const childLast = childIndex2 === row.children.length - 1;
            rows.push(
              h(
                'div',
                {
                  key: `${rowKey}:${child.id}`,
                  className: 'dsh-agent-tree-mini-row',
                  onClick: openInstance,
                  title: `${child.title}\n${instance.label}\n${child.id}`,
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '2px 8px 2px 22px',
                    cursor: 'pointer',
                    minWidth: 0,
                  },
                },
                glyph(childLast ? '└─' : '├─'),
                h(Dot, { color: DOT.deep, active: false }),
                clampSpan(child.title, { fontSize: 10, color: 'var(--dat-muted, var(--dsw-alias-label-tertiary))' }),
                h(
                  'span',
                  { style: { flex: 'none', fontSize: 9.5, color: 'var(--dat-muted, var(--dsw-alias-label-tertiary))' } },
                  child.updatedLabel,
                ),
              ),
            );
          });
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
              color: 'var(--dat-text, var(--dsw-alias-label-primary))',
            }),
            clampSpan(proc.label || `pid ${proc.pid}`, {
              fontSize: 10.5,
              color: 'var(--dat-sub, var(--dsw-alias-label-secondary))',
            }),
            proc.sessionTitle && proc.cwd && proc.cwd !== '/' && proc.cwd !== ''
              ? clampSpan(baseName(proc.cwd), {
                  flex: 'none',
                  fontSize: 9,
                  color: 'var(--dat-muted, var(--dsw-alias-label-tertiary))',
                })
              : null,
            h(
              'span',
              { style: { flex: 'none', fontSize: 9.5, color: 'var(--dat-muted, var(--dsw-alias-label-tertiary))' } },
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
                  color: thread.running === true ? 'var(--dat-text, var(--dsw-alias-label-primary))' : 'var(--dat-sub, var(--dsw-alias-label-secondary))',
                }),
                pathLeaf && thread.nickname
                  ? clampSpan(pathLeaf, { fontSize: 9, color: 'var(--dat-muted, var(--dsw-alias-label-tertiary))' })
                  : h('span', { style: { flex: 1 } }),
                h(
                  'span',
                  { style: { flex: 'none', fontSize: 9.5, color: 'var(--dat-muted, var(--dsw-alias-label-tertiary))', opacity: 0.85 } },
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
                color: 'var(--dat-muted, var(--dsw-alias-label-tertiary))',
              }),
              h(
                'span',
                { style: { flex: 'none', fontSize: 9.5, color: 'var(--dat-muted, var(--dsw-alias-label-tertiary))', opacity: 0.8 } },
                formatElapsed(child.elapsedSeconds),
              ),
            ),
          );
        });
      });

      const visible = rows.slice(0, MAX_ROWS);
      const stats = tree.stats || { total: 0, subagents: 0, runningLive: 0 };
      const statsLine = `会话 ${stats.total} · 子代理 ${stats.subagents} · 运行中 ${stats.runningLive}（${mode}）`;
      // 窗口头只有 288px，还要放三个按钮：副标题用最省的写法，别被省略号吃掉。
      const busyParts = [];
      if (tree.running > 0) busyParts.push(`${tree.running} 在跑`);
      if (tree.scheduled > 0) busyParts.push(`${tree.scheduled} 定时`);
      const headline =
        tree.waiting > 0
          ? `${tree.waiting} 待处理${busyParts.length > 0 ? ` · ${busyParts.join(' · ')}` : ''}`
          : busyParts.length > 0
            ? `${tree.running > 0 ? `${tree.running} 个 agent 在跑` : '空闲'}${
                tree.scheduled > 0 ? ` · ${tree.scheduled} 定时` : ''
              }`
            : '空闲 · 没有在跑的任务';

      const live = tree.running > 0;
      const waiting = tree.waiting > 0;
      const dotColor = waiting ? WAIT.question.color : live ? DOT.conversation : DOT.idle;
      const rootStyle = { position: 'fixed', left: pos.x, top: pos.y, zIndex: 60, userSelect: 'none' };

      // ---------------------------------------------------- 收起态：一颗圆头圆脑的胶囊
      if (collapsed) {
        // 胶囊上也挂一枚皮肤装饰，QQ 皮肤那种「dock 外面冒出来一点」的感觉。
        const pillDecor = (skin.decor || [])[0];
        return h(
          'div',
          { ref: rootRef, style: { ...rootStyle, width: 'auto' } },
          pillDecor
            ? h(
                'div',
                { className: 'dsh-agent-tree-decor-layer', 'aria-hidden': 'true' },
                h('img', {
                  className: 'dsh-agent-tree-decor',
                  src: pillDecor.src,
                  alt: '',
                  draggable: false,
                  style: {
                    top: -20,
                    right: -18,
                    width: 58,
                    opacity: 0.95,
                    transform: `rotate(${pillDecor.rot - 14}deg)`,
                  },
                }),
              )
            : null,
          h(
            'div',
            {
              className: 'dsh-agent-tree-root dsh-agent-tree-pill',
              'data-skin': skin.id,
              role: 'button',
              tabIndex: 0,
              'aria-expanded': false,
              'aria-label': `${headline}，展开 Agent Tree Dock`,
              title: `点击展开 · 按住拖动位置\n${statsLine}`,
              onPointerDown: beginDrag,
              onClick: () => {
                if (movedRef.current) return;
                setManualCollapsed(false);
              },
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
                  event.preventDefault();
                  setManualCollapsed(false);
                }
              },
            },
            h('span', { className: 'dsh-agent-tree-pill-glyph' }, h(SkinGlyph, { skin, size: 14 })),
            h('span', { className: 'dsh-agent-tree-pill-name' }, 'Agent Tree Dock'),
            waiting
              ? h(
                  'span',
                  {
                    className: 'dsh-agent-tree-pill-chip dsh-agent-tree-pill-wait',
                    title: `${tree.waiting} 个会话等你处理（提问 / 审批 / 计划审阅）`,
                  },
                  `${tree.waiting} 待处理`,
                )
              : null,
            live
              ? h(
                  'span',
                  {
                    className: 'dsh-agent-tree-pill-chip dsh-agent-tree-pill-agents',
                    title: `${tree.running} 个 agent 在跑`,
                  },
                  h(RobotIcon),
                  h('span', null, String(tree.running)),
                )
              : null,
            tree.scheduled > 0
              ? h(
                  'span',
                  {
                    className: 'dsh-agent-tree-pill-chip',
                    title: `${tree.scheduled} 个定时任务待触发`,
                  },
                  h(ClockIcon),
                  h('span', null, String(tree.scheduled)),
                )
              : null,
            h('span', { className: 'dsh-agent-tree-pill-chevron' }, h(ChevronIcon, { direction: 'up' })),
          ),
        );
      }

      // ---------------------------------------------------- 展开态：卡片 + 醒目的最小化按钮
      const decorations = (skin.decor || []).map((item, index) => {
        const style = {
          width: item.w,
          opacity: item.opacity,
          transform: `rotate(${item.rot}deg)${item.flip ? ' scaleX(-1)' : ''}`,
        };
        if (item.anchor === 'bottom') {
          style.bottom = item.y;
          style.left = item.x;
        } else {
          style.top = item.y;
          style.left = item.x;
        }
        return h('img', {
          key: `decor${index}`,
          className: 'dsh-agent-tree-decor',
          src: item.src,
          alt: '',
          draggable: false,
          style,
        });
      });

      return h(
        'div',
        { ref: rootRef, style: { ...rootStyle, width: WIDTH } },
        decorations.length > 0
          ? h('div', { className: 'dsh-agent-tree-decor-layer', 'aria-hidden': 'true' }, decorations)
          : null,
        h(
          'div',
          { className: 'dsh-agent-tree-root dsh-agent-tree-card', 'data-skin': skin.id },
          h(
            'div',
            {
              className: 'dsh-agent-tree-head',
              onPointerDown: beginDrag,
              title: `按住拖动位置\n${statsLine}`,
            },
            h('span', { className: 'dsh-agent-tree-head-icon' }, h(SkinGlyph, { skin, size: 15 })),
            h(
              'span',
              { className: 'dsh-agent-tree-head-text' },
              h('span', { className: 'dsh-agent-tree-head-title' }, 'Agent Tree Dock'),
              h(
                'span',
                { className: 'dsh-agent-tree-head-sub' },
                h(Dot, { color: dotColor, active: live || waiting }),
                h('span', { className: 'dsh-agent-tree-head-subtext' }, headline),
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-agent-tree-minbtn',
                title: '切换皮肤',
                'aria-label': '切换皮肤',
                'aria-expanded': skinMenuOpen ? 'true' : 'false',
                onPointerDown: (event) => event.stopPropagation(),
                onClick: (event) => {
                  event.stopPropagation();
                  setUpdatePanelOpen(false);
                  setSkinMenuOpen((open) => !open);
                },
              },
              h(PaletteIcon, { size: 11 }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-agent-tree-minbtn' + (updateCheck.phase === 'checking' ? ' is-busy' : ''),
                title: updateButtonTitle(updateCheck, updateAvailable),
                'aria-label': '检查更新',
                'aria-expanded': updatePanelOpen ? 'true' : 'false',
                onPointerDown: (event) => event.stopPropagation(),
                onClick: (event) => {
                  event.stopPropagation();
                  if (updatePanelOpen) {
                    setUpdatePanelOpen(false);
                    return;
                  }
                  runUpdateCheck();
                },
              },
              h(RefreshIcon, { size: 11 }),
              updateAvailable ? h('span', { className: 'dsh-agent-tree-updot' }) : null,
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-agent-tree-minbtn',
                title: '收起成胶囊（空闲时也会自动收起）',
                'aria-label': '收起成胶囊',
                onPointerDown: (event) => event.stopPropagation(),
                onClick: (event) => {
                  event.stopPropagation();
                  setManualCollapsed(true);
                },
              },
              h(MinusIcon, { size: 11 }),
            ),
          ),
          updatePanelOpen
            ? renderUpdatePanel()
            : skinMenuOpen
            ? h(
                'div',
                { className: 'dsh-agent-tree-skinpanel', role: 'menu', 'aria-label': '皮肤' },
                skins.map((item) =>
                  h(
                    'button',
                    {
                      key: item.id,
                      type: 'button',
                      role: 'menuitemradio',
                      'aria-checked': item.id === skin.id ? 'true' : 'false',
                      className:
                        'dsh-agent-tree-skinitem' + (item.id === skin.id ? ' is-active' : ''),
                      title: item.desc !== '' ? `${item.name} · ${item.desc}` : item.name,
                      onClick: () => pickSkin(item.id),
                    },
                    h('span', {
                      className: 'dsh-agent-tree-skinswatch',
                      style: { background: skinSwatch(item) },
                    }),
                    h('span', null, item.name),
                    item.desc !== ''
                      ? h('span', { className: 'dsh-agent-tree-skindesc' }, item.desc)
                      : h('span', { className: 'dsh-agent-tree-skindesc' }),
                    h(
                      'span',
                      { className: 'dsh-agent-tree-skincheck' },
                      item.id === skin.id ? h(CheckIcon, { size: 11 }) : null,
                    ),
                  ),
                ),
              )
            : null,
          h(
            'div',
            { style: { maxHeight: '46vh', overflowY: 'auto', padding: '0 0 5px' } },
            visible.length === 0
              ? h(
                  'div',
                  { style: { padding: '6px 10px 2px', fontSize: 10, color: 'var(--dat-muted, var(--dsw-alias-label-tertiary))' } },
                  '当前没有在跑什么。',
                )
              : visible,
            rows.length > MAX_ROWS
              ? h(
                  'div',
                  { style: { padding: '2px 8px 0', fontSize: 9.5, color: 'var(--dat-muted, var(--dsw-alias-label-tertiary))' } },
                  `还有 ${rows.length - MAX_ROWS} 行…`,
                )
              : null,
            h(
              'div',
              {
                style: {
                  padding: '4px 10px 0',
                  fontSize: 9,
                  color: 'var(--dat-muted, var(--dsw-alias-label-tertiary))',
                  opacity: 0.75,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                },
              },
              statsLine,
            ),
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
        ensureSkinStyles();

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
        ensureStyles,
        ensureSkinStyles,
        getSkins,
        sanitizeSkin,
        sanitizeSkinVars,
        skinCss,
        resolveSkin,
        readSkinId,
        saveSkinId,
        SKINS,
        SKIN_VARS,
        SKIN_KEY,
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
        parseVersion,
        compareVersions,
        isNewerVersion,
        checkedAgoLabel,
        updateButtonTitle,
        readUpdateCache,
        saveUpdateCache,
        PLUGIN_VERSION,
        UPDATE_KEY,
        NPM_LATEST_URL,
      },
    };
  },
});
