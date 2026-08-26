#!/bin/bash
# YexuL Canvas 启动脚本（macOS）
# 优先使用内置便携 Node（node/macos/{arm64,x64}），否则使用系统 Node
cd "$(dirname "$0")"

NODE_CMD=""
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ] && [ -x "./node/macos/arm64/node" ]; then
  NODE_CMD="./node/macos/arm64/node"
elif [ "$ARCH" = "x86_64" ] && [ -x "./node/macos/x64/node" ]; then
  NODE_CMD="./node/macos/x64/node"
elif [ -x "./node/macos/node" ]; then
  NODE_CMD="./node/macos/node"
elif command -v node >/dev/null 2>&1; then
  NODE_CMD="node"
fi

if [ -z "$NODE_CMD" ]; then
  echo "[错误] 未找到 Node.js（需要 18 或更高版本）。"
  echo "请先安装：https://nodejs.org  或执行  brew install node"
  echo "安装后重新运行本脚本。"
  read -p "按回车键退出…"
  exit 1
fi

NODE_MAJOR=$("$NODE_CMD" -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 18 ]; then
  echo "[错误] Node.js 版本过低（需要 18+），请升级后重试：brew upgrade node"
  read -p "按回车键退出…"
  exit 1
fi

echo "Starting YexuL Canvas ..."
echo "浏览器会自动打开。保持本窗口开启。"
echo
"$NODE_CMD" server.js
echo
echo "服务已停止。"
read -p "按回车键退出…"
