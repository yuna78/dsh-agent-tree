import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProcessTable,
  detectAgent,
  argCwd,
  buildProcessRoots,
  childLabel,
  parseRolloutMeta,
  codexThreadsUnder,
  codexHome,
  userPromptOf,
  shortPrompt,
  firstUserPrompt,
  promptTitleOf,
  pickCodexRoot,
} from '../index.js';

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
  assert.equal(clientModule.id, 'dsh-plugin-agent-tree');
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

test('waitingKind reads pendingInteraction.kind from the live status map', () => {
  const { waitingKind } = clientModule.__test;
  const statuses = new Map([
    ['q', { running: false, pendingInteraction: { kind: 'question' } }],
    ['a', { running: true, pendingInteraction: { kind: 'approval' } }],
    ['p', { running: false, pendingInteraction: { kind: 'plan-review' } }],
    ['n', { running: true }],
  ]);
  assert.equal(waitingKind(statuses, 'q'), 'question');
  assert.equal(waitingKind(statuses, 'a'), 'approval');
  assert.equal(waitingKind(statuses, 'p'), 'plan-review');
  assert.equal(waitingKind(statuses, 'n'), undefined, '只是跑着、没等你，就不算待处理');
  assert.equal(waitingKind(statuses, 'missing'), undefined);
  assert.equal(waitingKind(null, 'q'), undefined);
});

test('selectActiveTree keeps a waiting session that is not running, and ranks it first', () => {
  const { selectActiveTree } = clientModule.__test;
  const state = {
    ids: ['q', 'busy'],
    byId: {
      q: { id: 'q', displayTitle: '等你回答', updatedAt: 10, running: false },
      busy: { id: 'busy', displayTitle: '在跑', updatedAt: 900, running: true },
    },
  };
  const statuses = new Map([['q', { running: false, pendingInteraction: { kind: 'question' } }]]);
  const tree = selectActiveTree(state, workspaceState, statuses);
  assert.equal(tree.waiting, 1);
  assert.equal(tree.running, 1);
  const items = tree.groups.flatMap((group) => group.items);
  const waitingNode = items.find((node) => node.row.id === 'q');
  assert.equal(waitingNode.waiting, 'question', '不在跑也要挂进树里，并带上待处理类型');
  const ranked = items.filter((node) => node.waiting || node.active);
  assert.equal(ranked[0].row.id, 'q', '等你拍板的排在最前面（比在跑的还前）');
});

test('nodeRank orders waiting > running > scheduled > idle', () => {
  const { nodeRank } = clientModule.__test;
  assert.equal(nodeRank({ waiting: 'approval', active: true }), 3);
  assert.equal(nodeRank({ active: true }), 2);
  assert.equal(nodeRank({ schedule: { count: 1, nextAt: 0 } }), 1);
  assert.equal(nodeRank({}), 0);
  assert.equal(nodeRank(null), 0);
});

test('scheduleRemote falls back to ctx.get("remote.schedule")', () => {
  const { scheduleRemote } = clientModule.__test;
  assert.equal(scheduleRemote(undefined), undefined);
  assert.equal(scheduleRemote({}), undefined);
  const direct = { catalog: () => Promise.resolve({ ok: true, value: [] }) };
  assert.equal(scheduleRemote({ remote: { schedule: direct } }), direct);
  const viaGet = { catalog: () => Promise.resolve({ ok: true, value: [] }) };
  assert.equal(
    scheduleRemote({ remote: {}, get: (name) => (name === 'remote.schedule' ? viaGet : undefined) }),
    viaGet,
    '命名空间服务还没挂成属性时用 ctx.get 兜底',
  );
  assert.equal(
    scheduleRemote({
      get: () => {
        throw new Error('no such service');
      },
    }),
    undefined,
    '服务不存在时安静返回 undefined',
  );
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

test('host parseProcessTable keeps ppid and marks agents only by kind', () => {
  const table = [
    '  101  1  01:23  3.5 node /usr/local/bin/claude --resume',
    '  102  1  2-03:00:00  0.1 /opt/bin/codex exec "do it"',
    '  103  1  00:10  1.0 node /Users/x/dsh-agent-tree/index.js',
    '  104  1  00:05  0.0 /usr/bin/ps -axo pid=,ppid=,etime=,pcpu=,command=',
    '  105  1  00:30  9.9 /Applications/Notes.app/Contents/MacOS/Notes',
  ].join('\n');
  const rows = parseProcessTable(table);
  assert.equal(rows.length, 5, '全部进程行都保留（子进程要靠 ppid 挂树）');
  assert.equal(rows[0].ppid, 1);
  assert.equal(rows[0].kind, 'claude');
  assert.equal(rows[3].kind, null, 'ps 自己不算 agent');
  const roots = buildProcessRoots(rows);
  assert.equal(roots.length, 2, '只有 claude/codex 两个根');
  assert.equal(roots[0].kind, 'codex', '按已运行时长倒序');
  assert.equal(roots[0].elapsedSeconds, 2 * 86400 + 3 * 3600);
  assert.deepEqual(roots[1].children, []);
});

test('host buildProcessRoots nests helper children under the CLI', () => {
  const table = [
    '  200  40536  02-21:35:48  1.9 /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server',
    '  201  200  41:10  0.0 /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node ./server.mjs',
    '  202  200  41:10  0.0 /Users/x/.pencil/mcp/mcp-server-darwin-arm64 --agent codexCLI',
    '  203  201  10:00  0.0 /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl',
    '  300  40536  00:30  5.0 /opt/homebrew/bin/claude --resume',
  ].join('\n');
  const roots = buildProcessRoots(parseProcessTable(table));
  assert.equal(roots.length, 2);
  const codex = roots.find((root) => root.kind === 'codex');
  assert.equal(codex.children.length, 3, 'helper 子进程挂到 codex 下面');
  assert.deepEqual(
    codex.children.map((child) => child.label).sort(),
    ['MCP', 'computer use', 'computer use'],
  );
  assert.ok(codex.children.some((child) => child.pid === 203), '孙进程（深度 3）也收进来');
  assert.deepEqual(roots.find((root) => root.kind === 'claude').children, []);
});

test('host childLabel turns ps commands into readable labels', () => {
  assert.equal(childLabel('/x/Resources/cua_node/bin/node ./server.mjs'), 'computer use');
  assert.equal(childLabel('/x/cua_node/bin/node_repl'), 'computer use');
  assert.equal(childLabel('/x/codex-cli/bin/codex-code-mode-host'), 'code mode');
  assert.equal(childLabel('/x/.pencil/mcp/mcp-server-darwin-arm64 --app vscode'), 'MCP');
  assert.equal(childLabel('/Applications/ChatGPT.app/.../Codex (Renderer) --type=renderer'), 'renderer');
  assert.equal(childLabel('/usr/local/bin/rg foo'), 'rg');
});

test('client groups process children by label', () => {
  const { groupProcessChildren } = clientModule.__test;
  const groups = groupProcessChildren([
    { label: 'computer use', elapsedSeconds: 100, cpu: 0 },
    { label: 'computer use', elapsedSeconds: 300, cpu: 1.5 },
    { label: 'MCP', elapsedSeconds: 50, cpu: 0 },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].label, 'computer use', '数量多的排前面');
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].elapsedSeconds, 300, '显示最长的那个');
  assert.equal(groups[1].label, 'MCP');
  assert.deepEqual(groupProcessChildren(undefined), []);
});

// ------------------------------------------------------------ codex 子对话

const metaLine = (payload) => JSON.stringify({ timestamp: 't', ordinal: 0, type: 'session_meta', payload });

const rootPayload = { id: 'root-1', session_id: 'root-1', cwd: '/work/devline', originator: 'Codex Desktop', thread_source: 'thread' };
const subPayload = (id, parent, nick, path, depth = 1) => ({
  id,
  session_id: id,
  cwd: '/work/devline',
  thread_source: 'subagent',
  agent_nickname: nick,
  agent_path: path,
  source: { subagent: { thread_spawn: { parent_thread_id: parent, depth, agent_path: path, agent_nickname: nick } } },
});

test('parseRolloutMeta reads the session_meta header and leaves huge text alone', () => {
  const huge = metaLine({ ...rootPayload, base_instructions: { text: 'x'.repeat(5000) } });
  const meta = parseRolloutMeta(`${huge}\n${JSON.stringify({ type: 'event_msg' })}\n`);
  assert.equal(meta.id, 'root-1');
  assert.equal(meta.cwd, '/work/devline');
  assert.equal(meta.isSubagent, false);
  assert.equal(meta.parentId, '');
});

test('parseRolloutMeta marks subagent threads and their parent', () => {
  const meta = parseRolloutMeta(metaLine(subPayload('kid-1', 'root-1', 'Hubble', '/root/advance_review_logic')));
  assert.equal(meta.isSubagent, true);
  assert.equal(meta.parentId, 'root-1');
  assert.equal(meta.depth, 1);
  assert.equal(meta.nickname, 'Hubble');
  assert.equal(meta.agentPath, '/root/advance_review_logic');
});

test('parseRolloutMeta gives up quietly on non-JSON / non-meta headers', () => {
  assert.equal(parseRolloutMeta('not json at all\n'), null);
  assert.equal(parseRolloutMeta(JSON.stringify({ type: 'event_msg', payload: {} })), null);
  assert.equal(parseRolloutMeta(''), null);
  assert.equal(parseRolloutMeta(null), null);
});

const threadsFixture = () => {
  const now = Date.now();
  const mk = (meta, mtimeMs) => ({ ...meta, mtime: mtimeMs, path: `/tmp/${meta.id}.jsonl` });
  return {
    now,
    metas: [
      mk({ ...rootPayload }, now - 60000),
      mk(parseRolloutMeta(metaLine(subPayload('kid-1', 'root-1', 'Hubble', '/root/advance_review_logic'))), now - 13000),
      mk(parseRolloutMeta(metaLine(subPayload('kid-2', 'root-1', 'Carson', '/root/review_nextarchive_code'))), now - 900000),
      mk(parseRolloutMeta(metaLine(subPayload('grand-1', 'kid-1', 'Wegener', '/root/deep_work', 2))), now - 5000),
      mk(parseRolloutMeta(metaLine(subPayload('other', 'root-2', 'Nobody', '/root/other'))), now - 1000),
    ],
  };
};

test('codexThreadsUnder walks parent → child → grandchild of one root thread', () => {
  const { metas, now } = threadsFixture();
  const threads = codexThreadsUnder(metas, 'root-1', now);
  assert.equal(threads.length, 3, '两个直接子对话 + 一个孙对话，root-2 的不会串进来');
  assert.deepEqual(
    threads.map((thread) => thread.nickname),
    ['Hubble', 'Wegener', 'Carson'],
    '最近的排前面（Hubble 刚活动过，Carson 15 分钟前）',
  );
  assert.equal(threads[0].running, true, '2 分钟内活动过就算 running');
  assert.equal(threads[0].idleSeconds, 13);
  assert.equal(threads[1].depth, 2, '孙对话带深度，客户端按深度缩进');
  assert.equal(threads[2].running, false);
  assert.equal(codexThreadsUnder(metas, 'unknown', now).length, 0);
  assert.equal(codexThreadsUnder(null, 'root-1', now).length, 0);
});

test('codexThreadsUnder caps how much of a huge subagent fan-out it reports', () => {
  const now = Date.now();
  const metas = [parseRolloutMeta(metaLine(rootPayload))];
  for (let index = 0; index < 30; index += 1) {
    metas.push({
      ...parseRolloutMeta(metaLine(subPayload(`kid-${index}`, 'root-1', `Agent${index}`, `/root/a${index}`))),
      mtime: now - index * 1000,
    });
  }
  const threads = codexThreadsUnder(metas, 'root-1', now);
  assert.equal(threads.length, 8, '最多 8 个子对话');
  assert.equal(threads[0].nickname, 'Agent0', '按最近活动排序');
});

test('pickCodexRoot prefers the same cwd, then the newest root', () => {
  const now = Date.now();
  const metas = [
    { ...parseRolloutMeta(metaLine(rootPayload)), mtime: now - 5000 },
    { ...parseRolloutMeta(metaLine({ ...rootPayload, id: 'root-2', cwd: '/work/other' })), mtime: now - 1000 },
    { ...parseRolloutMeta(metaLine(subPayload('kid-1', 'root-1', 'Hubble', '/root/x'))), mtime: now },
  ];
  assert.equal(pickCodexRoot(metas, '/work/devline').id, 'root-1', '同 cwd 的优先');
  assert.equal(pickCodexRoot(metas, '/work/devline/sub').id, 'root-1', 'cwd 互为前缀也能对上（worktree 场景）');
  assert.equal(pickCodexRoot(metas, '/nope').id, 'root-2', '对不上 cwd 就用最新的主线程');
  assert.equal(pickCodexRoot([], '/x'), undefined);
  assert.equal(pickCodexRoot(metas.slice(2, 3), '/x'), undefined, '只有子对话时没有主线程');
});

test('pickCodexRoot prefers a desktop-originated thread when the process cwd is useless', () => {
  const now = Date.now();
  const metas = [
    { ...parseRolloutMeta(metaLine({ ...rootPayload, id: 'cli', originator: 'codex_exec' })), mtime: now - 500 },
    { ...parseRolloutMeta(metaLine({ ...rootPayload, id: 'desk', originator: 'Codex Desktop' })), mtime: now - 60000 },
  ];
  assert.equal(
    pickCodexRoot(metas, '/', { preferDesktop: true }).id,
    'desk',
    'ChatGPT.app 里的进程 cwd 是 /，靠 originator 认',
  );
  assert.equal(pickCodexRoot(metas, '/', { preferDesktop: false }).id, 'cli', '不开启就不特殊处理，回到最新');
});

test('codexHome respects CODEX_HOME', () => {
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = '/tmp/codex-home-test';
  assert.equal(codexHome(), '/tmp/codex-home-test');
  delete process.env.CODEX_HOME;
  assert.ok(codexHome().endsWith('/.codex'));
  if (before !== undefined) process.env.CODEX_HOME = before;
});

// ------------------------------------------------------- codex 会话标题 / 认领

test('userPromptOf picks the real user sentence, not codex context wrappers', () => {
  const wrap = {
    type: 'response_item',
    payload: { role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>/x</cwd>' }] },
  };
  assert.equal(userPromptOf(wrap), '', '上下文包裹不算用户说的话');
  const agentsMd = { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /x' }] } };
  assert.equal(userPromptOf(agentsMd), '', 'AGENTS.md 注入也不算');
  const real = {
    type: 'response_item',
    payload: { role: 'user', content: [{ type: 'input_text', text: '请只阅读当前目录下的审阅包文件，输出 JSON' }] },
  };
  assert.equal(userPromptOf(real), '请只阅读当前目录下的审阅包文件，输出 JSON');
  assert.equal(userPromptOf({ type: 'event_msg', payload: { type: 'user_message', message: '查一下流水线' } }), '查一下流水线');
  assert.equal(userPromptOf(null), '');
  assert.equal(userPromptOf({ type: 'response_item', payload: { role: 'assistant', content: [] } }), '');
});

test('shortPrompt flattens whitespace and caps the label length', () => {
  assert.equal(shortPrompt('  多个\n空格\t和换行  '), '多个 空格 和换行');
  assert.equal(shortPrompt(''), '');
  const long = shortPrompt('一'.repeat(80), 10);
  assert.equal(long.length, 10);
  assert.ok(long.endsWith('…'));
});

test('firstUserPrompt + promptTitleOf read a real rollout file', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const dir = await mkdtemp(joinPath(tmpdir(), 'agent-tree-title-'));
  const path = joinPath(dir, 'rollout-test.jsonl');
  const lines = [
    metaLine({ ...rootPayload, id: 'root-9' }),
    JSON.stringify({
      type: 'response_item',
      payload: { role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>/x</cwd>' }] },
    }),
    JSON.stringify({ type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: '把 backlog 里能推进的任务推进一下' }] } }),
  ];
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
  assert.equal(await firstUserPrompt(path), '把 backlog 里能推进的任务推进一下');
  assert.equal(await promptTitleOf({ path, mtime: 1 }), '把 backlog 里能推进的任务推进一下');
  assert.equal(await promptTitleOf({ path: joinPath(dir, 'missing.jsonl'), mtime: 1 }), '');
  assert.equal(await firstUserPrompt(null), '');
});

test('pickCodexRoot can hand out distinct sessions to processes sharing one cwd', () => {
  const now = Date.now();
  const metas = [
    { ...parseRolloutMeta(metaLine({ ...rootPayload, id: 'a' })), mtime: now - 1000 },
    { ...parseRolloutMeta(metaLine({ ...rootPayload, id: 'b' })), mtime: now - 5000 },
    { ...parseRolloutMeta(metaLine({ ...rootPayload, id: 'c' })), mtime: now - 9000 },
  ];
  const claimed = new Set();
  const first = pickCodexRoot(metas, '/work/devline', { exclude: claimed });
  claimed.add(first.id);
  const second = pickCodexRoot(metas, '/work/devline', { exclude: claimed });
  claimed.add(second.id);
  const third = pickCodexRoot(metas, '/work/devline', { exclude: claimed });
  claimed.add(third.id);
  assert.deepEqual([first.id, second.id, third.id], ['a', 'b', 'c'], '同 cwd 的三个进程各认领一条会话，不会三行同名');
  assert.equal(pickCodexRoot(metas, '/work/devline', { exclude: claimed }), undefined, '认领完了就不硬塞');
});
