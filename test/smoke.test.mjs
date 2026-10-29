import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProcessTable, detectAgent, argCwd } from '../index.js';

/**
 * 在 Node 里模拟浏览器模块加载器：拿到 client.js 的 factory，喂一个假的
 * `require('react')`，再调用 apply(ctx) 看它注册了哪个座位。
 */
let clientModule = null;
let registrations = [];

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: Symbol('Fragment'),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value ?? null }),
  useMemo: (fn) => fn(),
};

globalThis.window = {
  innerWidth: 1440,
  innerHeight: 900,
  localStorage: {
    store: new Map(),
    getItem(key) {
      return this.store.has(key) ? this.store.get(key) : null;
    },
    setItem(key, value) {
      this.store.set(key, String(value));
    },
  },
  addEventListener() {},
  removeEventListener() {},
  __ModuleLoader__: {
    load({ id, factory }) {
      const requireShim = (name) => {
        if (name === 'react') return fakeReact;
        throw new Error(`unexpected require(${name})`);
      };
      clientModule = factory(requireShim);
      clientModule.id = id;
    },
  },
};

const fakeSlots = {
  inject: (name, fn) => {
    registrations.push(`inject:${name}`);
    return fn();
  },
  register: (descriptor) => {
    registrations.push(`register:${descriptor.name}:${descriptor.key ?? descriptor.id}`);
    return () => {};
  },
};

const fakeCtx = {
  sessions: {
    list: { getSnapshot: () => ({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }) },
    subagentAddress: () => undefined,
  },
  workspaces: {
    list: {
      getSnapshot: () => ({
        items: [],
        archivedSessionIds: [],
        pinnedSessionIds: [],
        state: 'idle',
        phase: 'ready',
        error: null,
      }),
    },
  },
  remote: { $on: () => () => {} },
  uiWorkspace: { openSession() {} },
  slots: fakeSlots,
  effect: (fn) => fn(),
};

await import('../client.js');

test('client bundle loads and exposes apply/inject', () => {
  assert.ok(clientModule, 'module should be registered on window.__ModuleLoader__');
  assert.equal(clientModule.id, '@local/dsh-agent-tree');
  assert.equal(typeof clientModule.apply, 'function');
  assert.deepEqual(clientModule.inject, ['sessions', 'slots', 'workspaces', 'remote', 'uiWorkspace']);
});

test('apply mounts exactly one mini overlay (no main panel, no sidebar tab)', () => {
  registrations = [];
  clientModule.apply(fakeCtx);
  assert.deepEqual(registrations, ['inject:shell.overlay', 'register:shell.overlay:dsh-agent-tree.mini']);
});

const workspaceState = {
  items: [
    { workspaceId: 'w1', path: '/Users/x/proj-alpha', title: 'proj-alpha', sessionIds: ['c1', 'c2'] },
    { workspaceId: 'w2', path: '/Users/x/proj-beta', title: '', sessionIds: ['c3'] },
  ],
};

const sessionState = {
  ids: ['c1', 'c2', 's1', 's2', 'g1', 'c3', 's3', 'orphan', 's4', 'blank'],
  byId: {
    c1: { id: 'c1', displayTitle: '会话一', updatedAt: 500, running: false },
    c2: { id: 'c2', displayTitle: '会话二', updatedAt: 400, running: false },
    s1: { id: 's1', displayTitle: '子代理-1', parentId: 'c1', origin: 'subagent', updatedAt: 200, running: true },
    s2: { id: 's2', displayTitle: '子代理-2', parentId: 'c1', origin: 'subagent', updatedAt: 300, running: true },
    g1: { id: 'g1', displayTitle: '孙代理-1', parentId: 's1', origin: 'subagent', updatedAt: 250, running: true },
    c3: { id: 'c3', displayTitle: '会话三', updatedAt: 100, running: false },
    s3: { id: 's3', displayTitle: '已完成子代理', parentId: 'c3', origin: 'subagent', updatedAt: 90, running: false },
    orphan: { id: 'orphan', displayTitle: '无工作区会话', updatedAt: 600, running: false },
    s4: { id: 's4', displayTitle: '孤儿子代理', parentId: 'orphan', origin: 'subagent', updatedAt: 650, running: true },
    blank: { id: 'blank', blank: true, origin: 'subagent', running: true },
  },
};

test('selectActiveTree nests conversation → subagent → grandchild', () => {
  const { selectActiveTree } = clientModule.__test;
  const tree = selectActiveTree(sessionState, workspaceState, null);

  assert.equal(tree.groups.length, 2, 'w1 有活跃分支；w2 没有 → 只剩 w1 + 未分组');
  const [first, ungrouped] = tree.groups;
  assert.equal(first.label, 'proj-alpha', 'workspace 标题优先，没有则用目录名');
  assert.equal(ungrouped.label, '未分组');

  const conversation = first.items[0];
  assert.equal(conversation.kind, 'conversation');
  assert.equal(conversation.row.id, 'c1');
  assert.equal(conversation.active, false, 'c1 自己没在跑，是子代理在跑');
  assert.deepEqual(
    conversation.children.map((child) => child.row.id),
    ['s2', 's1'],
    '活跃优先 + updatedAt 倒序',
  );
  assert.deepEqual(
    conversation.children[1].children.map((child) => child.row.id),
    ['g1'],
    '孙代理挂在父 subagent 下面（真树，不是拍平）',
  );
  assert.equal(tree.running, 4, 's1/s2/g1/s4');
  assert.equal(tree.conversations, 2);
});

test('selectActiveTree shows a running top-level conversation without subagents', () => {
  const { selectActiveTree } = clientModule.__test;
  const state = {
    ids: ['busy'],
    byId: { busy: { id: 'busy', displayTitle: '正在跑的对话', updatedAt: 5, running: true } },
  };
  const tree = selectActiveTree(state, workspaceState, null);
  assert.equal(tree.running, 1, '顶层对话自己在跑也算活跃');
  const conversation = tree.groups[0].items[0];
  assert.equal(conversation.kind, 'conversation');
  assert.equal(conversation.active, true);
  assert.equal(conversation.children.length, 0);
});

test('selectActiveTree hangs an orphan subagent directly under the workspace', () => {
  const { selectActiveTree } = clientModule.__test;
  const state = {
    ids: ['c1', 'kid'],
    byId: {
      c1: { id: 'c1', displayTitle: '会话一', updatedAt: 10, running: false },
      kid: { id: 'kid', displayTitle: '孤儿子代理', parentId: 'gone', origin: 'subagent', updatedAt: 20, running: true },
    },
  };
  const tree = selectActiveTree(state, workspaceState, null);
  assert.equal(tree.running, 1);
  const items = tree.groups.flatMap((group) => group.items);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'subagent', '父会话不在目录里就直接挂 workspace 下');
  assert.equal(items[0].row.id, 'kid');
});

test('selectActiveTree prefers live status map over the snapshot flag', () => {
  const { selectActiveTree } = clientModule.__test;
  const idle = {
    ids: ['c', 's'],
    byId: {
      c: { id: 'c', updatedAt: 1, running: false },
      s: { id: 's', parentId: 'c', origin: 'subagent', running: false },
    },
  };
  assert.equal(selectActiveTree(idle, workspaceState, null).running, 0);
  const live = new Map([['s', { running: true }]]);
  assert.equal(selectActiveTree(idle, workspaceState, live).running, 1);
});

test('selectActiveTree tolerates missing workspace state', () => {
  const { selectActiveTree } = clientModule.__test;
  const tree = selectActiveTree(sessionState, null, null);
  assert.ok(tree.groups.every((group) => group.label === '未分组'));
});

test('selectActiveTree reports stats for diagnosis', () => {
  const { selectActiveTree } = clientModule.__test;
  const tree = selectActiveTree(sessionState, workspaceState, null);
  assert.deepEqual(tree.stats, { total: 9, subagents: 5, runningSnapshot: 4, runningLive: 4 });
});

test('duration / title helpers', () => {
  const { durationMs, formatDuration, shortTitle, baseName, workspaceLabel } = clientModule.__test;
  const pv = { subagentTiming: { settledMs: 5000, active: { since: 10000, through: 20000 } } };
  assert.equal(durationMs(pv, true, 15000), 10000, 'settled + 进行中一段');
  assert.equal(durationMs(pv, false, 15000), 15000, '已结束用 through');
  assert.equal(formatDuration(75000), '1m15s');
  assert.equal(formatDuration(400), '');
  assert.equal(shortTitle({ id: 'abc', displayTitle: '  ' }), 'abc');
  assert.equal(baseName('/Users/x/My Project'), 'My Project');
  assert.equal(workspaceLabel({ workspaceId: 'w', path: '/Users/x/Proj', title: '' }), 'Proj');
});

test('selectActiveTree lists idle sessions that carry a schedule', () => {
  const { selectActiveTree, toScheduleMap } = clientModule.__test;
  const sessions = {
    ids: ['c1'],
    byId: { c1: { id: 'c1', displayTitle: '定时跑 backlog 的会话', updatedAt: 10, running: false } },
  };
  const schedules = toScheduleMap([
    { id: 'a', status: 'active', sessionId: 'c1', scheduledAt: '2026-10-29T03:30:00.000Z' },
    { id: 'b', status: 'inactive', sessionId: 'c1', scheduledAt: '2026-10-29T01:00:00.000Z' },
  ]);
  assert.equal(schedules.size, 1);
  assert.equal(schedules.get('c1').count, 1, '只有 active 的算数');
  assert.equal(schedules.get('c1').nextAt, Date.parse('2026-10-29T03:30:00.000Z'));

  const tree = selectActiveTree(sessions, workspaceState, null, schedules);
  assert.equal(tree.running, 0);
  assert.equal(tree.scheduled, 1);
  const conversation = tree.groups[0].items[0];
  assert.equal(conversation.active, false);
  assert.ok(conversation.schedule, '节点带上定时信息');
  assert.equal(conversation.schedule.count, 1);
});

test('model chips: projection → compact label', () => {
  const { modelLabel } = clientModule.__test;
  assert.equal(modelLabel({ modelSelection: { next: { provider: 'deepseek', model: 'deepseek-v4.1-flash' }, lastUsed: null } }), 'v4.1-flash');
  assert.equal(modelLabel({ modelSelection: { next: null, lastUsed: { provider: 'deepseek', model: 'deepseek-chat' } } }), 'chat');
  assert.equal(modelLabel({ modelSelection: { lastUsed: { model: 'anthropic/claude-sonnet-4' } } }), 'claude-sonnet-4');
  assert.equal(modelLabel({}), '');
  assert.equal(modelLabel(undefined), '');
});

test('countdown / elapsed labels', () => {
  const { countdownLabel, formatElapsed } = clientModule.__test;
  const now = Date.parse('2026-10-29T00:00:00.000Z');
  assert.equal(countdownLabel(now + 8 * 60000, now), '8m');
  assert.equal(countdownLabel(now - 5000, now), 'now');
  assert.equal(countdownLabel(now + 3 * 3600000, now), '3h');
  assert.equal(countdownLabel(Infinity, now), '');
  assert.equal(formatElapsed(45), '45s');
  assert.equal(formatElapsed(720), '12m');
  assert.equal(formatElapsed(3900), '1h5m');
  assert.equal(formatElapsed(0), '');
});

test('host detectAgent ignores GUI helpers and picks real CLIs', () => {
  assert.equal(detectAgent('/usr/local/bin/node /usr/local/bin/claude --resume'), 'claude');
  assert.equal(detectAgent('/opt/homebrew/bin/codex exec "go"'), 'codex');
  assert.equal(
    detectAgent('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex -c x app-server'),
    'codex',
    'ChatGPT 桌面端的 Codex CLI backend 算 codex',
  );
  assert.equal(
    detectAgent('/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/1/Helpers/browser_crashpad_handler --monitor-self'),
    null,
    'Codex Framework 的助手进程不是 CLI',
  );
  assert.equal(detectAgent('/Applications/Notes.app/Contents/MacOS/Notes'), null);
  assert.equal(detectAgent('/usr/bin/ps -axo pid=,etime=,pcpu=,command='), null);
  assert.equal(argCwd('codex --cd /Users/x/my-repo exec'), '/Users/x/my-repo');
  assert.equal(argCwd('claude --cwd=/Users/x/p'), '/Users/x/p');
  assert.equal(argCwd('claude'), '');
});

test('host parseProcessTable picks claude/codex only', () => {
  const table = [
    '  101  01:23  3.5 node /usr/local/bin/claude --resume',
    '  102  2-03:00:00  0.1 /opt/bin/codex exec "do it"',
    '  103  00:10  1.0 node /Users/x/dsh-agent-tree/index.js',
    '  104  00:05  0.0 /usr/bin/ps -axo pid=,etime=,pcpu=,command=',
    '  105  00:30  9.9 /Applications/Notes.app/Contents/MacOS/Notes',
  ].join('\n');
  const rows = parseProcessTable(table);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].pid, 102, '按已运行时长倒序');
  assert.equal(rows[0].kind, 'codex');
  assert.equal(rows[0].elapsedSeconds, 2 * 86400 + 3 * 3600);
  assert.equal(rows[1].kind, 'claude');
  assert.equal(rows[1].elapsedSeconds, 83);
});
