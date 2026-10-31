#!/usr/bin/env node
/**
 * dsh-plugin-agent-tree 冒烟测试。不联网、不开 DSH、不开浏览器：
 *
 *   1) npm 包契约（能装 / 能被市场识别 / 不会把测试和私有配置发出去）
 *   2) cordis.patch.yml 插入的模块名 = 包名
 *   3) 客户端半部该注册的座位、该读的数据源是否还在
 *   4) 宿主半部的路由 / 鉴权 / 超时护栏是否还在
 *   5) 公开文件里没有本机路径 / token / 私有端点
 *   6) 跑完整单测（node --test test/*.test.mjs）
 *
 * 运行：node verify/smoke.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const warnings = [];

const fail = (message) => failures.push(message);
const warn = (message) => warnings.push(message);
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

/** 公开文件里不该出现的东西：本机路径、凭证、私有端点。 */
const FORBIDDEN = [
  [/\/Users\/(?!x\/|example\/)[a-z0-9._-]+/i, '本机绝对路径'],
  [/ghp_[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/sk-[A-Za-z0-9_-]{20,}/, 'API key'],
  [/WOCHENG_[A-Z0-9_]*KEY/, '私有 provider key 名'],
  [/wochengtv\.net/, '私有中转端点'],
  [/yuna\.sun@/, '个人邮箱'],
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------- 1. 包契约
const pkg = JSON.parse(read('package.json'));

if (!/^dsh-plugin-[a-z0-9-]+$/.test(pkg.name)) fail(`包名应为 dsh-plugin-<x>：${pkg.name}`);
if (pkg.private !== false) fail('private 必须是 false，否则 npm publish 会 EPRIVATE');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version)) fail(`版本号不合法：${pkg.version}`);
if (!pkg.description || pkg.description.length < 20) fail('description 太短，市场看不清用途');
if (!pkg.dsh || !pkg.dsh.bundle || !pkg.dsh.bundle.patch) fail('缺 dsh.bundle.patch —— 市场会判「不可安装」');
if (!pkg.dsh || !pkg.dsh.client || pkg.dsh.client.platform !== 'web') fail('缺 dsh.client.platform=web');
if (!Array.isArray(pkg.files) || pkg.files.length === 0) fail('缺 files 白名单');
if (!pkg.repository || !/github\.com[/:]yuna78\/dsh-agent-tree/.test(pkg.repository.url)) {
  fail('repository 必须指向 GitHub 仓库（市场靠它判定 npm 归属）');
}
if (!pkg.homepage) fail('缺 homepage');
if (!pkg.bugs || !pkg.bugs.url) fail('缺 bugs.url');
if (!pkg.license) fail('缺 license');
if (!pkg.engines || !pkg.engines.dsh) fail('缺 engines.dsh 兼容范围');
if (!pkg.peerDependencies || !pkg.peerDependencies['@deepseek-ai/dsh']) {
  warn('没有 peerDependencies["@deepseek-ai/dsh"]，安装时不会校验宿主版本');
}
if (pkg.peerDependencies && pkg.peerDependencies['@deepseek-ai/dsh'] && !/-rc\./.test(pkg.peerDependencies['@deepseek-ai/dsh'])) {
  warn('peer 范围里没有预发布分支：DSH 还在 -rc 线时会被静默排除');
}
if (!pkg.keywords || !pkg.keywords.includes('dsh') || !pkg.keywords.includes('dsh-plugin')) {
  fail('keywords 至少要有 dsh / dsh-plugin');
}
if (!pkg.scripts || !pkg.scripts.prepublishOnly) fail('缺 scripts.prepublishOnly，发布前不会自动跑门禁');

const bundlePatchPath = pkg.dsh?.bundle?.patch;
if (bundlePatchPath && !existsSync(join(ROOT, bundlePatchPath))) fail(`dsh.bundle.patch 指向的文件不存在：${bundlePatchPath}`);

for (const entry of pkg.files || []) {
  const target = join(ROOT, entry.replace(/\/$/, ''));
  if (!existsSync(target)) fail(`files 白名单里的 ${entry} 不存在`);
}

// ---------------------------------------------------------- 2. cordis.patch.yml
if (bundlePatchPath && existsSync(join(ROOT, bundlePatchPath))) {
  const patch = read(bundlePatchPath);
  if (!patch.includes(`name: '${pkg.name}'`) && !patch.includes(`name: "${pkg.name}"`)) {
    fail(`cordis.patch.yml 里的 name 必须是 ${pkg.name}（否则装完加载不到模块）`);
  }
  if (!/- insert:/.test(patch)) fail('cordis.patch.yml 缺 insert 段');
}

// ------------------------------------------------------------- 3. 客户端半部
const client = read('client.js');
const CLIENT_MARKERS = [
  ["__ModuleLoader__", '客户端模块加载器入口'],
  ["OVERLAY_ID = 'dsh-agent-tree.mini'", 'overlay 座位 id'],
  ["'shell.overlay'", 'shell.overlay 座位'],
  ['selectActiveTree', '建树函数'],
  ['projectionValues', '投影读取'],
  ['modelSelection', '模型标签数据源'],
  ['schedule.catalog', '定时任务数据源'],
  ["'remote.schedule'", '定时任务命名空间兜底'],
  ['proc.threads', 'codex 子对话渲染'],
  ['pendingInteraction', '待你处理（提问/审批/计划审阅）数据源'],
  ['api-session/status', '实时 running 事件'],
  ['/local/dsh-agent-tree/processes', '外部进程接口'],
  ['workspaces.list.getSnapshot', 'workspace 归属'],
  ['subagentAddress', '跳转地址'],
  ['buildInstances', '本机其它 dsh 实例渲染'],
  ['data.instances', '实例列表接口字段'],
  ['NPM_LATEST_URL', '检查更新接口'],
  ['renderUpdatePanel', '检查更新面板'],
  ['PLUGIN_VERSION', '客户端版本号'],
];
for (const [marker, label] of CLIENT_MARKERS) {
  if (!client.includes(marker)) fail(`client.js 少了${label}（${marker}）`);
}
if (!client.includes('inherited')) fail('client.js 少了模型继承标记（inherited）');

// 检查更新靠 client.js 里的版本号：它必须和 package.json 一致，否则会误报 / 漏报。
const clientVersion = /const PLUGIN_VERSION = '([^']+)'/.exec(client);
if (!clientVersion) fail('client.js 里没有 PLUGIN_VERSION 常量');
else if (clientVersion[1] !== pkg.version) {
  fail(`client.js 的 PLUGIN_VERSION=${clientVersion[1]} 和 package.json 的 ${pkg.version} 不一致`);
}
if (!client.includes('https://registry.npmjs.org/dsh-plugin-agent-tree/latest')) {
  fail('client.js 少了 npm registry 的 latest 地址（检查更新用）');
}

// ------------------------------------------------------------- 4. 宿主半部
const host = read('index.js');
const HOST_MARKERS = [
  ['export const inject', 'inject 声明'],
  ['webServer', 'webServer 服务注入'],
  ['requestRejection', '鉴权护栏'],
  ['execFile', '进程探测'],
  ['parseProcessTable', '进程表解析'],
  ['detectAgent', 'CLI 识别'],
  ['CACHE_MS', '结果缓存'],
  ['PS_TIMEOUT_MS', '超时护栏'],
  ['parseRolloutMeta', 'codex rollout 解析'],
  ['codexThreadsUnder', 'codex 子对话树'],
  ['rollout-', 'codex 会话文件前缀'],
  ['dshInstances', '本机 dsh 实例发现'],
  ['-sTCP:LISTEN', '实例监听端口读取'],
];
for (const [marker, label] of HOST_MARKERS) {
  if (!host.includes(marker)) fail(`index.js 少了${label}（${marker}）`);
}
if (!/sendJson\(res, 200/.test(host)) fail('宿主路由没有 200 JSON 响应');
if (!/ctx\.effect\(/.test(host)) fail('宿主路由没有放进 ctx.effect，卸载时不会释放');
if (!/'GET'|\"GET\"/.test(host) || !/405/.test(host)) warn('宿主路由没看到只读方法限制（405）');

// ------------------------------------------------------------ 5. 隐私与卫生
const scanTargets = [
  'package.json',
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'README.md',
  'README.en.md',
  'CHANGELOG.md',
  'LICENSE',
  ...walk(join(ROOT, 'docs')).map((file) => relative(ROOT, file)),
  ...walk(join(ROOT, 'test')).map((file) => relative(ROOT, file)),
  ...walk(join(ROOT, 'scripts')).map((file) => relative(ROOT, file)),
  ...walk(join(ROOT, 'verify')).map((file) => relative(ROOT, file)),
];
for (const file of scanTargets) {
  if (!existsSync(join(ROOT, file))) continue;
  if (statSync(join(ROOT, file)).size > 512 * 1024) continue;
  const text = read(file);
  for (const [pattern, label] of FORBIDDEN) {
    if (pattern.test(text)) fail(`${file} 命中${label}：${pattern}`);
  }
}

// ------------------------------------------------------------------ 6. 单测
const tests = spawnSync(process.execPath, ['--test', 'test/*.test.mjs'], {
  cwd: ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
const testOut = `${tests.stdout || ''}${tests.stderr || ''}`;
const passMatch = /# pass (\d+)/.exec(testOut) || /ℹ pass (\d+)/.exec(testOut);
const failMatch = /# fail (\d+)/.exec(testOut) || /ℹ fail (\d+)/.exec(testOut);
if (tests.status !== 0) {
  fail(`单测没通过（exit ${tests.status}）\n${testOut.split('\n').slice(-25).join('\n')}`);
}
const testLine = passMatch ? `单测 ${passMatch[1]} 通过 / ${failMatch ? failMatch[1] : '?'} 失败` : '单测（未取到计数）';

// -------------------------------------------------------------------- 汇总
console.log(`\nAgent Tree 冒烟自检 · ${relative(process.cwd(), ROOT) || '.'}`);
console.log('─'.repeat(64));
console.log(`包：${pkg.name}@${pkg.version} · ${testLine}`);
if (warnings.length > 0) {
  for (const message of warnings) console.log(`! WARN ${message}`);
}
if (failures.length > 0) {
  for (const message of failures) console.log(`✗ FAIL ${message}`);
  console.log('─'.repeat(64));
  console.log(`FAILED · ${failures.length} 项\n`);
  process.exit(1);
}
console.log('─'.repeat(64));
console.log(`PASS · 契约 / 座位 / 数据源 / 隐私 / 单测 全绿（warn ${warnings.length}）\n`);
