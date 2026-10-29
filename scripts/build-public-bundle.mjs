#!/usr/bin/env node
/**
 * 生成可公开的仓库内容（白名单 + 隐私扫描），不含本机配置 / 运行数据。
 *
 *   node scripts/build-public-bundle.mjs [--out dist/public]
 *
 * 产物是一个独立仓库的内容，可以直接：
 *   gh repo create yuna78/dsh-agent-tree --public --source dist/public --remote origin --push
 *
 * 白名单（只公开这些）：
 *   包本体：package.json / index.js / client.js / cordis.patch.yml
 *   文档：  README.md / README.en.md / CHANGELOG.md / LICENSE / docs/**
 *   开发：  test/**、verify/**、scripts/build-public-bundle.mjs、.github/**
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.indexOf('--out');
const OUT = resolve(outArg > 0 ? process.argv[outArg + 1] : join(ROOT, 'dist', 'public'));

const FILES = ['package.json', 'index.js', 'client.js', 'cordis.patch.yml', '.gitignore', 'README.md', 'README.en.md', 'CHANGELOG.md', 'LICENSE'];
const DIRS = ['docs', 'test', 'verify', 'scripts', 'market'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.cache', '__pycache__', 'coverage']);
const SKIP_FILES = /(^|\/)(\.DS_Store|.*\.log|.*\.tmp|.*\.tgz|.*\.bak.*)$/;
/** 本机专属、绝不公开的文件。 */
const SKIP_PATHS = new Set(['scripts/build-public-bundle.local.mjs']);

/** 不允许出现在公开产物里的内容（本机路径 / 凭证 / 私有端点 / 客户名）。 */
const FORBIDDEN = [
  [/\/Users\/(?!x\/|example\/)[a-z0-9._-]+/i, '本机绝对路径'],
  [/ghp_[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/sk-[A-Za-z0-9_-]{20,}/, 'API key'],
  [/WOCHENG_[A-Z0-9_]*KEY/, '私有 provider key 名'],
  [/wochengtv\.net/, '私有中转端点'],
  [/yuna\.sun@/, '个人邮箱'],
];

function copyFile(src, dest, stats) {
  const rel = relative(ROOT, src).replace(/\\/g, '/');
  if (SKIP_PATHS.has(rel)) return;
  if (!existsSync(src)) throw new Error(`缺少公开文件：${rel}`);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
  stats.files += 1;
  stats.bytes += statSync(src).size;
}

function copyTree(src, dest, stats) {
  const rel = relative(ROOT, src).replace(/\\/g, '/');
  if (SKIP_PATHS.has(rel)) return;
  if (!existsSync(src)) throw new Error(`缺少公开目录：${rel}`);
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    const full = join(src, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      copyTree(full, join(dest, entry.name), stats);
      continue;
    }
    if (SKIP_FILES.test(entry.name)) continue;
    copyFile(full, join(dest, entry.name), stats);
  }
}

function scan(violations) {
  for (const rel of walk(OUT)) {
    const full = join(OUT, rel);
    const ext = extname(rel).toLowerCase();
    if (!['.md', '.js', '.mjs', '.json', '.yml', '.yaml', '.txt', ''].includes(ext)) continue;
    const text = readFileSync(full, 'utf8');
    for (const [pattern, label] of FORBIDDEN) {
      if (pattern.test(text)) violations.push(`${rel} 命中${label}：${pattern}`);
    }
  }
}

function walk(dir, out = [], base = dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out, base);
    else out.push(relative(base, full));
  }
  return out;
}

/** 公开仓的 package.json：去掉本机 scripts，保留发布契约。 */
function rewritePackageJson() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  pkg.version = pkg.version;
  writeFileSync(join(OUT, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
}

// ------------------------------------------------------------------ 执行
// 重建时保留公开仓的 .git（发布历史就在 dist/public，别一起删掉）
const gitBackup = join(ROOT, 'dist', '.public-git-backup');
const gitDir = join(OUT, '.git');
if (existsSync(gitDir)) {
  rmSync(gitBackup, { recursive: true, force: true });
  renameSync(gitDir, gitBackup);
}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const stats = { files: 0, bytes: 0 };
for (const file of FILES) copyFile(join(ROOT, file), join(OUT, file), stats);
for (const dir of DIRS) copyTree(join(ROOT, dir), join(OUT, dir), stats);
rewritePackageJson();

const gitHubDir = join(ROOT, '.github');
if (existsSync(gitHubDir)) copyTree(gitHubDir, join(OUT, '.github'), stats);

const violations = [];
scan(violations);
if (existsSync(gitBackup)) {
  mkdirSync(join(OUT), { recursive: true });
  renameSync(gitBackup, gitDir);
}

console.log(`公开包：${relative(ROOT, OUT) || OUT}`);
console.log(`  文件 ${stats.files} 个 / ${(stats.bytes / 1024).toFixed(1)} KB`);
if (violations.length > 0) {
  for (const violation of violations) console.log(`  ✗ ${violation}`);
  console.log(`\n隐私扫描 ${violations.length} 处命中 —— 先修掉再发布。`);
  process.exit(1);
}
console.log('  隐私扫描：0 命中');
console.log(`\n下一步：cd ${relative(process.cwd(), OUT) || OUT} && git status --short`);
