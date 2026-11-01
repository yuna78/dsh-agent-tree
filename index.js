/**
 * `dsh-plugin-agent-tree` — 宿主半部（v0.1.0）。
 *
 * 唯一职责：给浏览器端一个只读的小接口 `GET /local/dsh-agent-tree/processes`，
 * 报告本机上正在跑的 claude / codex CLI 进程（浏览器自己看不到进程表），
 * 以及 codex 自己的会话线程：
 *   - 进程树：`ps` + `lsof` 读 pid / ppid / cwd / etime，按 ppid 归组；
 *   - codex 会话：读 `~/.codex/sessions/…/rollout-*.jsonl` 的 `session_meta`
 *     头（按 `parent_thread_id` 还原 subagent 线程树，首条真实用户消息当行名）。
 *
 * 宿主半部只读本机、不联网、不外发；所有读取都有超时和缓存，任何一步失败都只是少一行，
 * 不影响 DSH 启动。（客户端半部的「检查更新」按钮只在用户点击时向 npm registry 发一次只读 GET。）
 *
 * 设计原则：绝不因为这一半出错而影响 DSH 启动。
 *   - 路由注册失败只 warn，不影响其它插件；
 *   - 不注入 connection 服务，鉴权走 best-effort（拿得到就用它挡未授权请求）；
 *   - 每次最多扫 8 个匹配进程，lsof 有超时，结果缓存 3 秒。
 */
import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'dsh-agent-tree';

// webServer 在 web 组合里必然存在（官方 web 插件都用它）；只用这一个注入。
export const inject = ['webServer'];

const ROUTE_PATH = '/local/dsh-agent-tree/processes';
/** 桌面浮窗（desktop dock）的本地接口：浏览器发布状态 / 原生壳拉取 / 原生壳回传点击。 */
const DOCK_STATE_PATH = '/local/dsh-agent-tree/dock/state';
const DOCK_ACTION_PATH = '/local/dsh-agent-tree/dock/action';
const DOCK_STATE_VERSION = 1;
const DOCK_STATE_MAX_BYTES = 512 * 1024;
const DOCK_MAX_ACTIONS = 8;
const DOCK_ONLINE_MS = 15000;
const DOCK_TOKEN_BYTES = 24;
const DOCK_DESCRIPTOR_PREFIX = 'agent-tree-dock-';
const CACHE_MS = 3000;
const MAX_PROCESSES = 8;
const MAX_CHILDREN = 12;
const MAX_CHILD_DEPTH = 3;
const PS_TIMEOUT_MS = 4000;
const LSOF_TIMEOUT_MS = 4000;

// codex 的子对话（subagent threads）：读它自己的 rollout 记录，只读、只在本机。
const CODEX_LOOKBACK_MS = 48 * 3600 * 1000;
const CODEX_MAX_FILES = 240;
const CODEX_HEADER_BYTES = 4 * 1024 * 1024;
const CODEX_ACTIVE_MS = 120 * 1000;
const CODEX_SCAN_DAYS = 3;
const MAX_THREADS = 8;
const MAX_THREAD_DEPTH = 3;

/** 桌面端常驻 codex 后端（`codex app-server`）只要近期 rollout 有活动才挂行（活着 ≠ 有会话）。 */
const BACKEND_VISIBLE_MS = 10 * 60 * 1000;

/** 可执行文件名（小写精确）：只认真正的 CLI，不认 ChatGPT.app 里的 Codex 框架/助手进程。 */
const AGENT_EXECUTABLES = new Set(['claude', 'codex']);

/** 子孙进程的可读标签（顺序有意义：先匹配更具体的）。 */
const CHILD_HINTS = [
  [/Claude Helper/i, 'helper'],
  [/cua-repl|node_repl|SkyComputerUseService|server\.mjs/i, 'computer use'],
  [/code-mode-host/i, 'code mode'],
  [/mcp-server/i, 'MCP'],
  [/\(Renderer\)/i, 'renderer'],
  [/crashpad/i, 'crashpad'],
];

/** 跑一个短命令，失败就给空字符串（探测型调用，不需要抛错）。 */
function run(file, args, timeout) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout, maxBuffer: 1 << 20, windowsHide: true }, (error, stdout) => {
        resolve(error ? '' : String(stdout));
      });
    } catch (err) {
      resolve('');
    }
  });
}

/** `01:23` / `1-02:03:04` → 秒。 */
function elapsedSeconds(etime) {
  if (typeof etime !== 'string' || etime.length === 0) return 0;
  const [daysPart, clockPart] = etime.includes('-') ? etime.split('-') : ['0', etime];
  const days = Number(daysPart) || 0;
  const clock = clockPart.split(':').map(Number);
  while (clock.length < 3) clock.unshift(0);
  const [hours, minutes, seconds] = clock;
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

/**
 * ChatGPT / CodexCLI 桌面端的常驻 codex 后端：可执行文件 basename 恰好是 `codex`，
 * 但它是 app 的守护进程，活着 ≠ 有会话在跑——显示与否由 rollout 活动决定（见 codexRowActivity）。
 */
export function isCodexBackend(command) {
  const tokens = String(command || '').split(/\s+/);
  return tokens.includes('app-server') && tokens.some((token) => token.split('/').pop() === 'codex');
}

/**
 * Claude 桌面版主进程（`/Applications/Claude.app/Contents/MacOS/Claude`）。
 * Helper 走 `Frameworks/Claude Helper.app/…`，路径里没有 `Claude.app/Contents/MacOS/`，不会误伤；
 * ChatGPT 的 `Codex Framework` / `Codex (Renderer)` 是大写 Codex 且不在此路径，也不受影响。
 */
export function isClaudeDesktop(command) {
  return /Claude\.app\/Contents\/MacOS\/Claude(?:\s|$|\/)/.test(String(command || ''));
}

/** 从命令行里认出 claude / codex CLI；不是就返回 null。 */
export function detectAgent(command) {
  if (typeof command !== 'string' || command.length === 0) return null;
  if (command.includes('dsh-agent-tree') || command.includes('ps -axo')) return null;
  for (const token of command.split(/\s+/)) {
    if (token.length === 0 || token.startsWith('-')) continue;
    const base = token.split('/').pop().replace(/\.(js|mjs|cjs)$/, '');
    if (AGENT_EXECUTABLES.has(base)) return base === 'codex' ? 'codex' : 'claude';
  }
  return null;
}

/** 解析 `ps -axo pid=,ppid=,etime=,pcpu=,command=`（保留全部行，agent 判定在 kind 上）。 */
export function parseProcessTable(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const command = match[5];
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      kind: detectAgent(command) ?? (isClaudeDesktop(command) ? 'claude' : null),
      backend: isCodexBackend(command),
      desktop: isClaudeDesktop(command),
      elapsedSeconds: elapsedSeconds(match[3]),
      cpu: Number(match[4]) || 0,
      command,
    });
  }
  return rows;
}

/** 一行能看懂的子孙进程标签：codex app-server 的 computer-use / MCP 子进程等。 */
export function childLabel(command) {
  const text = String(command || '');
  for (const [pattern, label] of CHILD_HINTS) {
    if (pattern.test(text)) return label;
  }
  const first = text.split(/\s+/)[0] || '';
  return baseName(first).replace(/\.(js|mjs|cjs|ts)$/, '') || 'child';
}

/** 从 ps 行里挑出 claude/codex 根进程，并把它们的非 agent 后代挂成子树。 */
export function buildProcessRoots(rows, maxRoots = MAX_PROCESSES) {
  const childrenOf = new Map();
  for (const row of rows) {
    if (!childrenOf.has(row.ppid)) childrenOf.set(row.ppid, []);
    childrenOf.get(row.ppid).push(row);
  }
  const roots = rows
    .filter((row) => row.kind !== null)
    .sort((a, b) => b.elapsedSeconds - a.elapsedSeconds)
    .slice(0, maxRoots);
  return roots.map((root) => {
    const children = [];
    const walk = (pid, depth) => {
      if (depth > MAX_CHILD_DEPTH || children.length >= MAX_CHILDREN) return;
      for (const child of childrenOf.get(pid) || []) {
        // 嵌套的 agent 自己就是一个根，别重复挂
        if (child.kind !== null) continue;
        children.push({
          pid: child.pid,
          label: childLabel(child.command),
          elapsedSeconds: child.elapsedSeconds,
          cpu: child.cpu,
        });
        walk(child.pid, depth + 1);
      }
    };
    walk(root.pid, 1);
    children.sort((a, b) => b.elapsedSeconds - a.elapsedSeconds);
    return { ...root, children: children.slice(0, MAX_CHILDREN) };
  });
}

/** 命令行里显式写出的工作目录（`--cwd /x`、`--cd=/x`、`-C /x`），拿不到就空串。 */
export function argCwd(command) {
  const match = /(?:--cwd|--cd|-C)[=\s]+([^\s"'`]+)/.exec(String(command || ''));
  return match === null ? '' : match[1];
}

// ---------------------------------------------------------------- codex 子对话
//
// codex（CLI 与 ChatGPT 桌面端）每次会话都会写 `<CODEX_HOME>/sessions/<y>/<m>/<d>/rollout-*.jsonl`，
// 第一行是 `session_meta`，里面有 cwd、是否 subagent、父线程 id、昵称、agent 路径。
// 所以「codex 的子对话」不用猜：按 parent_thread_id 就能还原成树。

/** codex 的数据目录（`CODEX_HOME` 优先）。 */
export function codexHome() {
  const fromEnv = process.env.CODEX_HOME;
  return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : join(homedir(), '.codex');
}

/** rollout 里的一行 `session_meta` → 归一化后的线程信息；第一条不是 meta 就返回 null。 */
export function parseRolloutMeta(text) {
  const lines = String(text || '').split('\n');
  for (const line of lines) {
    if (line.trim() === '') continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      return null; // 头部被截断/不是 JSON：当作读不到
    }
    if (obj === null || typeof obj !== 'object' || obj.type !== 'session_meta') return null;
    const payload = obj.payload;
    if (payload === null || typeof payload !== 'object') return null;
    const source = payload.source !== null && typeof payload.source === 'object' ? payload.source : {};
    const subagent = source.subagent !== null && typeof source.subagent === 'object' ? source.subagent : {};
    const spawn = subagent.thread_spawn !== null && typeof subagent.thread_spawn === 'object' ? subagent.thread_spawn : {};
    const id = typeof payload.id === 'string' ? payload.id : '';
    return {
      id,
      sessionId: typeof payload.session_id === 'string' ? payload.session_id : '',
      parentId: typeof spawn.parent_thread_id === 'string' ? spawn.parent_thread_id : '',
      depth: Number(spawn.depth) || 0,
      isSubagent: payload.thread_source === 'subagent' || Object.keys(spawn).length > 0,
      nickname: typeof payload.agent_nickname === 'string' ? payload.agent_nickname : '',
      agentPath: typeof payload.agent_path === 'string' ? payload.agent_path : '',
      cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
      originator: typeof payload.originator === 'string' ? payload.originator : '',
    };
  }
  return null;
}

/** 从文件头读若干行（rollout 的第一行可能很大，含完整 base_instructions）。 */
async function readHeader(path) {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (err) {
    return '';
  }
  try {
    const buffer = Buffer.allocUnsafe(CODEX_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, CODEX_HEADER_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch (err) {
    return '';
  } finally {
    await handle.close().catch(() => {});
  }
}

/** 最近几天的 rollout 文件（按 mtime 倒序，最多 CODEX_MAX_FILES 个）。 */
async function recentRollouts(now) {
  const root = join(codexHome(), 'sessions');
  const files = [];
  for (let back = 0; back < CODEX_SCAN_DAYS && files.length < CODEX_MAX_FILES * 4; back += 1) {
    const day = new Date(now - back * 86400 * 1000);
    const dir = join(
      root,
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, '0'),
      String(day.getDate()).padStart(2, '0'),
    );
    let names;
    try {
      names = await readdir(dir);
    } catch (err) {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      let info;
      try {
        info = await stat(path);
      } catch (err) {
        continue;
      }
      if (now - info.mtimeMs > CODEX_LOOKBACK_MS) continue;
      files.push({ path, mtime: info.mtimeMs });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, CODEX_MAX_FILES);
}

const metaCache = new Map();

/** 最近 rollout 的 meta 列表（按 path+mtime 缓存，避免每 3 秒重读全部文件）。 */
async function recentCodexMetas(now) {
  const metas = [];
  for (const file of await recentRollouts(now)) {
    const hit = metaCache.get(file.path);
    if (hit !== undefined && hit.mtime === file.mtime) {
      metas.push(hit.meta);
      continue;
    }
    const meta = parseRolloutMeta(await readHeader(file.path));
    if (meta === null) continue;
    const entry = { ...meta, path: file.path, mtime: file.mtime };
    metaCache.set(file.path, { mtime: file.mtime, meta: entry });
    metas.push(entry);
  }
  return metas;
}

/** 这些前缀是 codex 自己塞的上下文包裹，不算用户真正说的话。 */
const PROMPT_SKIP =
  /^\s*(<(environment_context|app-context|user_instructions|user-instructions|system|developer)|#\s*AGENTS\.md|<INSTRUCTIONS)/i;

/** 从一行 rollout 事件里取「用户真正说的那句话」，取不到返回空串。 */
export function userPromptOf(event) {
  if (event === null || typeof event !== 'object') return '';
  const payload = event.payload !== null && typeof event.payload === 'object' ? event.payload : {};
  if (event.type === 'response_item' && payload.role === 'user') {
    const content = Array.isArray(payload.content) ? payload.content : [];
    for (const item of content) {
      const text = item !== null && typeof item === 'object' && typeof item.text === 'string' ? item.text : '';
      if (text !== '' && !PROMPT_SKIP.test(text)) return text;
    }
    return '';
  }
  if (event.type === 'event_msg' && payload.type === 'user_message' && typeof payload.message === 'string') {
    return PROMPT_SKIP.test(payload.message) ? '' : payload.message;
  }
  return '';
}

/** 压成一行、截短，用来当行标题。 */
export function shortPrompt(text, limit = 36) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (flat === '') return '';
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** 读 rollout 里第一条用户消息（最多读 2MB），拿不到就空串。 */
export async function firstUserPrompt(path) {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (err) {
    return '';
  }
  try {
    let buffer = '';
    const chunk = Buffer.allocUnsafe(65536);
    let total = 0;
    while (total < 2 * 1024 * 1024) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead <= 0) break;
      total += bytesRead;
      buffer += chunk.subarray(0, bytesRead).toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (line.trim() === '') continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch (err) {
          continue;
        }
        const prompt = userPromptOf(event);
        if (prompt !== '') return prompt;
      }
    }
    return '';
  } catch (err) {
    return '';
  } finally {
    await handle.close().catch(() => {});
  }
}

const titleCache = new Map();

/** 某条 rollout 的会话标题（首条用户消息，截短；按 path+mtime 缓存）。 */
export async function promptTitleOf(root) {
  if (root === undefined || typeof root.path !== 'string') return '';
  const hit = titleCache.get(root.path);
  if (hit !== undefined && hit.mtime === root.mtime) return hit.title;
  const title = shortPrompt(await firstUserPrompt(root.path));
  titleCache.set(root.path, { mtime: root.mtime, title });
  return title;
}

/**
 * 本机上其它 dsh web 实例：端口 + 它在用的会话。
 *
 * 同一台机器经常同时开好几个 `dsh web --port 30xx`。浏览器这一侧只能看到自己连着的那个实例，
 * 但进程表是共享的：
 *   - `ps` 找 `dsh ... web` 进程（排除自己）；
 *   - `lsof -a -p <pid> -iTCP -sTCP:LISTEN` 拿它监听的端口（3080 那个还会多一个 3081）；
 *   - `lsof -p <pid> -Fn` 里 `~/.dsh/sessions/<项目>/session-<id>/...` 就是它当前打开着的会话。
 *
 * 只读本机，不请求别的实例的接口，所以不需要它们的鉴权。
 */
export async function dshInstances(selfPid = process.pid) {
  const table = await run('ps', ['-axo', 'pid=,command='], PS_TIMEOUT_MS).catch(() => '');
  const candidates = [];
  for (const line of String(table).split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const command = match[2];
    if (pid === selfPid) continue;
    if (!/dsh\/lib\/bin\.js|\bdsh\b/.test(command)) continue;
    if (!/\bweb\b|--port/.test(command)) continue;
    candidates.push({ pid, command });
    if (candidates.length >= MAX_INSTANCES) break;
  }

  const instances = [];
  for (const candidate of candidates) {
    const ports = await instancePorts(candidate.pid);
    const sessionIds = await instanceSessions(candidate.pid);
    if (ports.length === 0 && sessionIds.length === 0) continue;
    instances.push({ pid: candidate.pid, ports, sessionIds, label: instanceLabel(candidate.command, ports) });
  }
  return instances;
}

const MAX_INSTANCES = 4;
const MAX_INSTANCE_SESSIONS = 12;

async function instancePorts(pid) {
  const output = await run('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], LSOF_TIMEOUT_MS).catch(
    () => '',
  );
  const ports = new Set();
  for (const line of String(output).split('\n').slice(1)) {
    const match = /:(\d+)\s*\(LISTEN\)/.exec(line);
    if (match !== null) ports.add(Number(match[1]));
  }
  return [...ports].sort((left, right) => left - right);
}

async function instanceSessions(pid) {
  const output = await run('lsof', ['-nP', '-p', String(pid), '-Fn'], LSOF_TIMEOUT_MS).catch(() => '');
  return parseLsofSessions(output);
}

/**
 * lsof `-Fn` 输出里挑会话 id。
 * 注意：卡片用的 session id 带 `session-` 前缀（存储里就是 `<项目>/session-<uuid>/`，会话 id = 目录名），
 * 只抓 uuid 会和客户端会话表对不上，于是全都变成「认不出的会话」。
 */
export function parseLsofSessions(text) {
  const ids = new Set();
  for (const line of String(text).split('\n')) {
    if (!line.startsWith('n')) continue;
    const match = /\/sessions\/[^/]+\/(session-[0-9a-f-]{36})\//.exec(line);
    if (match !== null) ids.add(match[1]);
    if (ids.size >= MAX_INSTANCE_SESSIONS) break;
  }
  return [...ids];
}

/** 行的名字：有端口就 `dsh :3083`，识别不到端口就 pid。 */
function instanceLabel(command, ports) {
  if (ports.length > 0) return `dsh :${ports[0]}`;
  const pid = /^\s*(\d+)/.exec(command);
  return pid === null ? 'dsh' : `dsh pid ${pid[1]}`;
}

/** 导出给自检/排查用：本机最近 rollout 的 meta 列表。 */
export async function collectCodexMetas(now = Date.now()) {
  return await recentCodexMetas(now);
}

/** 纯函数：给一个根线程 id，收集它下面（最多 MAX_THREADS 个、最深 MAX_THREAD_DEPTH 层）的子对话。 */
export function codexThreadsUnder(metas, rootId, now) {
  if (!Array.isArray(metas) || typeof rootId !== 'string' || rootId === '') return [];
  const children = new Map();
  for (const meta of metas) {
    if (!meta || !meta.isSubagent || meta.parentId === '') continue;
    const list = children.get(meta.parentId) || [];
    list.push(meta);
    children.set(meta.parentId, list);
  }
  const out = [];
  const walk = (parentId, depth) => {
    if (depth > MAX_THREAD_DEPTH) return;
    const list = (children.get(parentId) || []).slice().sort((a, b) => b.mtime - a.mtime);
    for (const meta of list) {
      if (out.length >= MAX_THREADS) return;
      const idle = Math.max(0, Math.round((now - meta.mtime) / 1000));
      out.push({
        nickname: meta.nickname || baseName(meta.agentPath) || '子对话',
        agentPath: meta.agentPath || '',
        depth,
        idleSeconds: idle,
        running: now - meta.mtime < CODEX_ACTIVE_MS,
      });
      walk(meta.id, depth + 1);
    }
  };
  walk(rootId, 1);
  return out;
}

/**
 * 纯函数：给一个 codex 进程，挑出它对应的主线程（rollout 的根）。
 *
 * 匹配顺序：同 cwd → cwd 互为前缀（进程在 worktree 里跑）→ 桌面端进程优先挑
 * `originator` 带 Desktop 的会话（ChatGPT.app 里的 codex 进程 cwd 常常是 `/`）→ 最新的主线程。
 * @param metas - `collectCodexMetas` 的结果
 * @param cwd - 该进程的工作目录
 * @param options - `preferDesktop`：进程来自 ChatGPT / Codex 桌面端
 */
export function pickCodexRoot(metas, cwd, options = {}) {
  if (!Array.isArray(metas)) return undefined;
  const exclude = options !== null && typeof options === 'object' && options.exclude instanceof Set ? options.exclude : null;
  const roots = metas.filter((meta) => meta && !meta.isSubagent && (exclude === null || !exclude.has(meta.id)));
  if (roots.length === 0) return undefined;
  const sorted = roots.slice().sort((a, b) => b.mtime - a.mtime);
  if (typeof cwd === 'string' && cwd !== '' && cwd !== '/') {
    const exact = sorted.find((meta) => meta.cwd === cwd);
    if (exact !== undefined) return exact;
    const nested = sorted.find(
      (meta) => meta.cwd !== '' && (meta.cwd.startsWith(cwd) || cwd.startsWith(meta.cwd)),
    );
    if (nested !== undefined) return nested;
  }
  if (options !== null && typeof options === 'object' && options.preferDesktop === true) {
    const desktop = sorted.find((meta) => /desktop/i.test(meta.originator));
    if (desktop !== undefined) return desktop;
  }
  return sorted[0];
}

/** 用 lsof 取进程工作目录；拿不到就空串。 */
/**
 * codex 行的活动信号：认领的 rollout 与它的子线程里，最近一次写入距现在多少秒。
 * 返回 null = 这行不该出现：桌面端常驻后端（`codex app-server`）且活动太久远；
 * 非 backend 的 CLI 进程活着就返回（进程退出 `ps` 自然看不到），`active` 只负责圆点亮不亮。
 */
export function codexRowActivity(now, root, threads, isBackend) {
  const rootAge =
    root !== undefined && root !== null && Number.isFinite(root.mtime)
      ? Math.max(0, (now - root.mtime) / 1000)
      : Infinity;
  const threadAge =
    Array.isArray(threads) && threads.length > 0
      ? Math.min(...threads.map((thread) => Math.max(0, Number(thread.idleSeconds) || 0)))
      : Infinity;
  const idleSeconds = Math.min(rootAge, threadAge);
  if (isBackend === true && !(idleSeconds <= BACKEND_VISIBLE_MS / 1000)) return null;
  return { active: idleSeconds < CODEX_ACTIVE_MS / 1000, idleSeconds };
}

/** 用 lsof 取进程工作目录；拿不到就空串。 */
async function cwdOf(pid) {
  const out = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], LSOF_TIMEOUT_MS);
  const line = out.split('\n').find((item) => item.startsWith('n'));
  return line === undefined ? '' : line.slice(1);
}

function baseName(path) {
  const parts = String(path).split('/').filter(Boolean);
  return parts.length === 0 ? String(path) : parts[parts.length - 1];
}

let cache = { at: 0, payload: null };

/** 导出给自检/排查用：完整进程快照（ps + lsof + rollout），与路由返回一致。 */
export async function snapshot() {
  const now = Date.now();
  if (cache.payload !== null && now - cache.at < CACHE_MS) return cache.payload;

  const table = await run('ps', ['-axo', 'pid=,ppid=,etime=,pcpu=,command='], PS_TIMEOUT_MS);
  const rows = buildProcessRoots(parseProcessTable(table));
  const codexMetas = rows.some((row) => row.kind === 'codex') ? await recentCodexMetas(now) : [];
  const processes = [];
  const claimedRoots = new Set();
  for (const row of rows) {
    let cwd = await cwdOf(row.pid);
    if (cwd === '' || cwd === '/') cwd = argCwd(row.command) || cwd;
    const root =
      row.kind === 'codex'
        ? pickCodexRoot(codexMetas, cwd, {
            preferDesktop: /ChatGPT\.app|CodexCLI\.app|Codex\.app/i.test(row.command),
            exclude: claimedRoots,
          })
        : undefined;
    if (root !== undefined) claimedRoots.add(root.id);
    const title = root === undefined ? '' : await promptTitleOf(root);
    const threads = root === undefined ? [] : codexThreadsUnder(codexMetas, root.id, now);
    // undefined = 非 codex 行（没有活动信号）；null = 桌面端常驻后端且无近期活动，这行不返回
    const activity = row.kind === 'codex' ? codexRowActivity(now, root, threads, row.backend === true) : undefined;
    if (activity === null) continue;
    processes.push({
      pid: row.pid,
      kind: row.kind,
      elapsedSeconds: row.elapsedSeconds,
      cpu: row.cpu,
      cwd,
      label: title !== '' ? title : displayLabel(row.command, cwd),
      sessionTitle: title,
      children: row.children,
      threads,
      desktop: row.desktop === true,
      active: activity === undefined ? true : activity.active,
      idleSeconds: activity === undefined ? undefined : activity.idleSeconds,
    });
  }
  const instances = await dshInstances().catch(() => []);
  const payload = { at: now, processes, instances };
  cache = { at: now, payload };
  return payload;
}

/** 一行能看懂的来源标签：项目目录 > 显式 --cwd > Claude 桌面版 > 桌面端 backend > 空。 */
export function displayLabel(command, cwd) {
  if (typeof cwd === 'string' && cwd !== '' && cwd !== '/') return baseName(cwd);
  const explicit = argCwd(command);
  if (explicit !== '') return baseName(explicit);
  if (isClaudeDesktop(command)) return 'Claude 桌面版';
  if (/CodexCLI\.app|ChatGPT\.app/.test(String(command || ''))) return 'ChatGPT';
  return '';
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

// ------------------------------------------------------------------ 桌面浮窗桥
//
// 浏览器里的卡片能读到会话 / 子代理 / 定时任务，但画不出浏览器视口之外的窗口；
// 原生壳（desktop/dock.swift）能画，却读不到这些数据。于是两边都退一步：
//
//   浏览器  --POST /local/dsh-agent-tree/dock/state-->  宿主（存一份最新快照）
//   原生壳  --GET  /local/dsh-agent-tree/dock/state-->  宿主（拿快照渲染）
//   原生壳  --POST /local/dsh-agent-tree/dock/action->  宿主（点行 → open 队列）
//   浏览器  <--  下一次 POST 的响应里带回 actions  ----  宿主（调 openSession）
//
// 浏览器那条走 DSH 自己的连接鉴权（cookie / Host+Origin 校验）；
// 原生壳没有 cookie，用 `~/.dsh/agent-tree-dock-<port>.json` 里的随机 token（0600）。
// 快照只活在内存里，不落盘、不出本机。

/** 一次性 token：进程重启就换，旧壳会收到 401 并重新读描述文件。 */
const dockToken = randomBytes(DOCK_TOKEN_BYTES).toString('hex');

const dock = {
  token: dockToken,
  /** 浏览器发布的最新快照（原样 JSON），以及它到达的时间。 */
  state: null,
  stateAt: 0,
  /** 原生壳最后一次来拉快照的时间：决定「桌面浮窗是否在线」。 */
  seenAt: 0,
  /** 原生壳点行后要交给浏览器执行的指令；下一次发布时被取走。 */
  actions: [],
  descriptorPath: '',
};

/** DSH 的主目录：和 profiles / sessions 同一个根。 */
export function dshHome(env = process.env) {
  const explicit = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return explicit !== '' ? explicit : join(homedir(), '.dsh');
}

/** 原生壳读的握手文件：每个端口一个，0600，内容只有 origin / port / token。 */
export function dockDescriptorPath(port, home = dshHome()) {
  return join(home, `${DOCK_DESCRIPTOR_PREFIX}${port}.json`);
}

/** 写握手文件；失败只 warn（不影响插件，只是桌面浮窗连不上）。 */
export async function publishDockDescriptor(options = {}) {
  const { origin, port, profile = '', pid = process.pid, home = dshHome(), token = dock.token } = options;
  if (!Number.isInteger(port) || port <= 0) throw new Error(`dock descriptor needs a port, got ${port}`);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = dockDescriptorPath(port, home);
  const body = `${JSON.stringify(
    { version: 1, origin, port, token, profile, pid, writtenAt: Date.now() },
    null,
    2,
  )}\n`;
  await writeFile(path, body, { mode: 0o600, encoding: 'utf8' });
  // 已存在的文件不会被 mode 改掉，补一次 chmod。
  await chmod(path, 0o600).catch(() => {});
  dock.descriptorPath = path;
  return path;
}

/** 读一个 JSON 请求体，超过 limit 直接拒绝（返回的 error.code = E_TOO_LARGE）。 */
export async function readJsonBody(req, limit = DOCK_STATE_MAX_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error(`request body larger than ${limit} bytes`);
      error.code = 'E_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** 快照是否合法：只要 `v: 1` + 一个 tree 对象；其它字段原样保存（客户端说了算）。 */
export function acceptDockState(payload, now = Date.now()) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (payload.v !== DOCK_STATE_VERSION) return false;
  if (payload.unchanged === true) {
    if (dock.state === null) return false;
    dock.stateAt = now;
    return true;
  }
  if (payload.tree === null || typeof payload.tree !== 'object' || Array.isArray(payload.tree)) return false;
  dock.state = payload;
  dock.stateAt = now;
  return true;
}

/** 原生壳还在拉快照吗？（15 秒没动静就当关掉了） */
export function dockOnline(now = Date.now()) {
  return dock.seenAt > 0 && now - dock.seenAt < DOCK_ONLINE_MS;
}

/** 原生壳来拉过快照：记一笔在线心跳。 */
export function noteDockSeen(now = Date.now()) {
  dock.seenAt = now;
}

/** 原生壳点了一行：排队，等浏览器下一次发布时取走。 */
export function queueDockAction(action, now = Date.now()) {
  if (action === null || typeof action !== 'object' || Array.isArray(action)) return false;
  if (action.action !== 'open') return false;
  const id = typeof action.id === 'string' ? action.id.trim() : '';
  if (id === '' || id.length > 200) return false;
  dock.actions.push({ action: 'open', id, at: now });
  while (dock.actions.length > DOCK_MAX_ACTIONS) dock.actions.shift();
  return true;
}

/** 取走全部待办指令（取走即清空，避免同一次点击被执行两次）。 */
export function takeDockActions() {
  return dock.actions.splice(0, dock.actions.length);
}

/** 给自检 / 排查看的当前桥状态。 */
export function dockSnapshot(now = Date.now()) {
  return {
    online: dockOnline(now),
    stateAt: dock.stateAt,
    seenAt: dock.seenAt,
    hasState: dock.state !== null,
    actions: dock.actions.length,
    descriptorPath: dock.descriptorPath,
  };
}

/** 只给单测用：把桥状态清干净（token 保持不变）。 */
export function resetDockBridge() {
  dock.state = null;
  dock.stateAt = 0;
  dock.seenAt = 0;
  dock.actions = [];
}

/** 常量时间比较 token，避免把描述文件里的值按字符时序猜出来。 */
export function dockTokenMatches(provided, expected = dock.token) {
  const value = Array.isArray(provided) ? provided[0] : provided;
  if (typeof value !== 'string' || value.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(value, 'utf8'), Buffer.from(expected, 'utf8'));
}

/** 本进程当前的 dock token。只对同进程有用（路由 handler 内部用的就是它）；
 *  dockSnapshot() 刻意不带它，诊断输出别泄密。 */
export function dockTokenValue() {
  return dock.token;
}

/** 只给单测用：当前 token 长度（不导出值本身）。 */
export function dockTokenLength() {
  return dock.token.length;
}

function dockHeader(req) {
  return req.headers['x-agent-tree-dock-token'];
}

/** 浏览器请求的鉴权判定；宿主没有 connection 服务时放行（和进程接口同策略）。 */
function requestRejectionOf(ctx, req) {
  try {
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
    if (connection && typeof connection.requestRejection === 'function') {
      return connection.requestRejection(req);
    }
  } catch (err) {
    /* 鉴权探测失败不阻塞读取 */
  }
  return undefined;
}

/** 等 webServer 真正 listen 之后再写描述文件（port 在 listen 前是 undefined）。 */
async function publishDescriptorWhenReady(ctx) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const port = ctx.webServer && ctx.webServer.port;
      if (Number.isInteger(port) && port > 0) {
        const origin =
          typeof ctx.webServer.getOrigin === 'function'
            ? ctx.webServer.getOrigin()
            : `http://127.0.0.1:${port}`;
        const path = await publishDockDescriptor({ origin, port, profile: process.env.DSH_PROFILE || '' });
        console.log(`[dsh-agent-tree] desktop dock descriptor: ${path}`);
        return;
      }
    } catch (err) {
      console.warn('[dsh-agent-tree] desktop dock descriptor failed:', err);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.warn('[dsh-agent-tree] desktop dock descriptor skipped: webServer never bound a port');
}

export function apply(ctx) {
  ctx.effect(() => {
    const disposers = [];
    try {
      if (!ctx.webServer || typeof ctx.webServer.register !== 'function') {
        console.warn('[dsh-agent-tree] webServer unavailable; external-process route skipped');
        return () => {};
      }
      disposers.push(
        ctx.webServer.register({
          kind: 'exact',
          path: ROUTE_PATH,
          handler: async (req, res) => {
            // best-effort 鉴权：能拿到 connection 的拒答判定就用它
            const rejection = requestRejectionOf(ctx, req);
            if (rejection !== undefined) {
              res.statusCode = rejection;
              res.end();
              return;
            }
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              res.statusCode = 405;
              res.setHeader('allow', 'GET');
              res.end();
              return;
            }
            try {
              sendJson(res, 200, await snapshot());
            } catch (err) {
              sendJson(res, 500, { error: String(err && err.message ? err.message : err) });
            }
          },
        }),
      );

      // ---- 浏览器发布状态（走 DSH 连接鉴权） ----
      disposers.push(
        ctx.webServer.register({
          kind: 'exact',
          path: DOCK_STATE_PATH,
          handler: async (req, res) => {
            // 这条路由两个租户共用：浏览器（cookie 鉴权）发布快照，原生壳（token 鉴权）拉取。
            // DSH 的连接栅栏会把无 cookie 的壳 401 掉，所以带有效 token 时豁免 401；
            // 403（Host 不可信 / 跨站）不豁免——token 只证明「是壳」，不洗白不可信的来源。
            const shellOk = dockTokenMatches(dockHeader(req));
            const rejection = requestRejectionOf(ctx, req);
            if (rejection !== undefined && !(rejection === 401 && shellOk)) {
              res.statusCode = rejection;
              res.end();
              return;
            }
            if (req.method === 'GET') {
              // 原生壳来拉：不要 cookie，但必须带 token。
              if (!shellOk) {
                sendJson(res, 401, { ok: false, error: 'dock token required' });
                return;
              }
              const now = Date.now();
              noteDockSeen(now);
              sendJson(res, 200, { ok: true, now, online: true, at: dock.stateAt, state: dock.state });
              return;
            }
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.setHeader('allow', 'GET, POST');
              res.end();
              return;
            }
            let payload;
            try {
              payload = await readJsonBody(req);
            } catch (err) {
              sendJson(res, err && err.code === 'E_TOO_LARGE' ? 413 : 400, {
                ok: false,
                error: String(err && err.message ? err.message : err),
              });
              return;
            }
            const now = Date.now();
            if (!acceptDockState(payload, now)) {
              sendJson(res, 400, { ok: false, error: 'expected { v: 1, tree: {...} }' });
              return;
            }
            sendJson(res, 200, {
              ok: true,
              now,
              dock: dockOnline(now),
              online: dockOnline(now),
              actions: takeDockActions(),
            });
          },
        }),
      );

      // ---- 原生壳回传点击（token） ----
      disposers.push(
        ctx.webServer.register({
          kind: 'exact',
          path: DOCK_ACTION_PATH,
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.setHeader('allow', 'POST');
              res.end();
              return;
            }
            if (!dockTokenMatches(dockHeader(req))) {
              sendJson(res, 401, { ok: false, error: 'dock token required' });
              return;
            }
            let body;
            try {
              body = await readJsonBody(req, 4096);
            } catch (err) {
              sendJson(res, 400, { ok: false, error: String(err && err.message ? err.message : err) });
              return;
            }
            if (!queueDockAction(body)) {
              sendJson(res, 400, { ok: false, error: 'expected { action: "open", id: "<session>" }' });
              return;
            }
            sendJson(res, 200, { ok: true, pending: dock.actions.length });
          },
        }),
      );
    } catch (err) {
      console.warn('[dsh-agent-tree] route registration failed:', err);
      for (const dispose of disposers) {
        try {
          dispose();
        } catch (error) {
          /* 注册一半失败：忽略单个释放错误 */
        }
      }
      return () => {};
    }

    void publishDescriptorWhenReady(ctx);

    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch (err) {
          /* 卸载时单个路由释放失败不阻塞其它 */
        }
      }
      if (dock.descriptorPath !== '') {
        void unlink(dock.descriptorPath).catch(() => {});
        dock.descriptorPath = '';
      }
    };
  }, `dsh-agent-tree: GET ${ROUTE_PATH} + desktop dock bridge`);
}
