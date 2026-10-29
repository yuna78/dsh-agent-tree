/**
 * `@local/dsh-agent-tree` — 宿主半部。
 *
 * 唯一职责：给浏览器端一个只读的小接口 `GET /local/dsh-agent-tree/processes`，
 * 报告本机上正在跑的 claude / codex CLI 进程（浏览器自己看不到进程表）。
 *
 * 设计原则：绝不因为这一半出错而影响 DSH 启动。
 *   - 路由注册失败只 warn，不影响其它插件；
 *   - 不注入 connection 服务，鉴权走 best-effort（拿得到就用它挡未授权请求）；
 *   - 每次最多扫 8 个匹配进程，lsof 有超时，结果缓存 3 秒。
 */
import { execFile } from 'node:child_process';

export const name = 'dsh-agent-tree';

// webServer 在 web 组合里必然存在（官方 web 插件都用它）；只用这一个注入。
export const inject = ['webServer'];

const ROUTE_PATH = '/local/dsh-agent-tree/processes';
const CACHE_MS = 3000;
const MAX_PROCESSES = 8;
const MAX_CHILDREN = 12;
const MAX_CHILD_DEPTH = 3;
const PS_TIMEOUT_MS = 4000;
const LSOF_TIMEOUT_MS = 1500;

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
  const processes = [];
  for (const row of buildProcessRoots(parseProcessTable(table))) {
    let cwd = await cwdOf(row.pid);
    if (cwd === '' || cwd === '/') cwd = argCwd(row.command) || cwd;
    processes.push({
      pid: row.pid,
      kind: row.kind,
      elapsedSeconds: row.elapsedSeconds,
      cpu: row.cpu,
      cwd,
      label: displayLabel(row.command, cwd),
      children: row.children,
    });
  }
  const payload = { at: now, processes };
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
