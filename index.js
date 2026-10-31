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
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'dsh-agent-tree';

// webServer 在 web 组合里必然存在（官方 web 插件都用它）；只用这一个注入。
export const inject = ['webServer'];

const ROUTE_PATH = '/local/dsh-agent-tree/processes';
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

/** 可执行文件名（小写精确）：只认真正的 CLI，不认 ChatGPT.app 里的 Codex 框架/助手进程。 */
const AGENT_EXECUTABLES = new Set(['claude', 'codex']);

/** 子孙进程的可读标签（顺序有意义：先匹配更具体的）。 */
const CHILD_HINTS = [
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
      kind: detectAgent(command),
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

async function snapshot() {
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
    processes.push({
      pid: row.pid,
      kind: row.kind,
      elapsedSeconds: row.elapsedSeconds,
      cpu: row.cpu,
      cwd,
      label: title !== '' ? title : displayLabel(row.command, cwd),
      sessionTitle: title,
      children: row.children,
      threads: root === undefined ? [] : codexThreadsUnder(codexMetas, root.id, now),
    });
  }
  const instances = await dshInstances().catch(() => []);
  const payload = { at: now, processes, instances };
  cache = { at: now, payload };
  return payload;
}

/** 一行能看懂的来源标签：项目目录 > 显式 --cwd > 桌面端 backend > 空。 */
export function displayLabel(command, cwd) {
  if (typeof cwd === 'string' && cwd !== '' && cwd !== '/') return baseName(cwd);
  const explicit = argCwd(command);
  if (explicit !== '') return baseName(explicit);
  if (/CodexCLI\.app|ChatGPT\.app/.test(String(command || ''))) return 'ChatGPT';
  return '';
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

export function apply(ctx) {
  ctx.effect(() => {
    try {
      if (!ctx.webServer || typeof ctx.webServer.register !== 'function') {
        console.warn('[dsh-agent-tree] webServer unavailable; external-process route skipped');
        return () => {};
      }
      return ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_PATH,
        handler: async (req, res) => {
          // best-effort 鉴权：能拿到 connection 的拒答判定就用它
          try {
            const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
            const rejection =
              connection && typeof connection.requestRejection === 'function'
                ? connection.requestRejection(req)
                : undefined;
            if (rejection !== undefined) {
              res.statusCode = rejection;
              res.end();
              return;
            }
          } catch (err) {
            /* 鉴权探测失败不阻塞读取 */
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
      });
    } catch (err) {
      console.warn('[dsh-agent-tree] route registration failed:', err);
      return () => {};
    }
  }, `dsh-agent-tree: GET ${ROUTE_PATH}`);
}
