#!/usr/bin/env node
/**
 * dsh-agent-tree-dock —— 一把启动桌面浮窗。
 *
 *   npx -p dsh-plugin-agent-tree dsh-agent-tree-dock [--verbose] [--origin=…] [--reset]
 *
 * 第一次运行会先就地编译（swiftc，macOS 自带 Xcode 命令行工具即可），
 * 之后直接 exec 编译产物。参数原样透传给壳。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = dirname(fileURLToPath(import.meta.url));
const binary = join(desktop, 'build', 'dsh-agent-tree-dock');

if (!existsSync(binary)) {
  console.error('[agent-tree-dock] 首次运行，先编译桌面壳…');
  const build = spawnSync('bash', [join(desktop, 'build.sh')], { stdio: 'inherit' });
  if (build.status !== 0) {
    console.error(
      '[agent-tree-dock] 编译失败。macOS 需要 Xcode 命令行工具：xcode-select --install（装完再试一次）',
    );
    process.exit(build.status ?? 1);
  }
}

const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (error) => {
  console.error(`[agent-tree-dock] 启动失败：${error.message}`);
  process.exit(1);
});
