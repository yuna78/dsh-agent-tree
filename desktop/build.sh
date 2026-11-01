#!/usr/bin/env bash
# desktop/build.sh — 编译桌面壳并收集渲染页到 desktop/build/
#
# 产物：desktop/build/dsh-agent-tree-dock（单文件可执行，旁边带 dock.html/css/js、
# client.js 和 vendor/ 里的 React）。壳运行时按「可执行文件同目录」找 dock.html。
#
# 用法：npm run dock:build && ./desktop/build/dsh-agent-tree-dock
#       （或直接 npm run dock —— 编译完立刻拉起）

set -euo pipefail
cd "$(dirname "$0")"

mkdir -p build/vendor

echo "swiftc dock.swift ..."
swiftc -O dock.swift -o build/dsh-agent-tree-dock

cp dock.html dock.css dock.js build/
cp ../client.js build/client.js
cp vendor/react.js vendor/react-dom.js build/vendor/

echo "built: desktop/build/dsh-agent-tree-dock"
echo "run:   ./desktop/build/dsh-agent-tree-dock   (先启动装了本插件的 dsh)"
