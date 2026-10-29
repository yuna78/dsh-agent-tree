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
const PS_TIMEOUT_MS = 4000;
const LSOF_TIMEOUT_MS = 1500;

/** 可执行文件名（小写精确）：只认真正的 CLI，不认 ChatGPT.app 里的 Codex 框架/助手进程。 */
const AGENT_EXECUTABLES = new Set(['claude', 'codex']);

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

/** 解析 `ps -axo pid=,etime=,pcpu=,command=`。 */
export function parseProcessTable(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const command = match[4];
    const kind = detectAgent(command);
    if (kind === null) continue;
    rows.push({
      pid: Number(match[1]),
      kind,
      elapsedSeconds: elapsedSeconds(match[2]),
      cpu: Number(match[3]) || 0,
      command,
    });
  }
  return rows.sort((a, b) => b.elapsedSeconds - a.elapsedSeconds).slice(0, MAX_PROCESSES);
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

  const table = await run('ps', ['-axo', 'pid=,etime=,pcpu=,command='], PS_TIMEOUT_MS);
  const rows = parseProcessTable(table);
  const processes = [];
  for (const row of rows) {
    let cwd = await cwdOf(row.pid);
    if (cwd === '' || cwd === '/') cwd = argCwd(row.command) || cwd;
    processes.push({
      pid: row.pid,
      kind: row.kind,
      elapsedSeconds: row.elapsedSeconds,
      cpu: row.cpu,
      cwd,
      label: displayLabel(row.command, cwd),
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
