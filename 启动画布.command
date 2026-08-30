#!/bin/bash
# ============================================================
# YexuL Canvas 启动脚本（macOS）
#  - 自动选择内置便携 Node（Apple 芯片 / Intel 均支持）
#  - 自动修复：执行权限丢失、macOS 隔离属性（微信/浏览器下载）
# ============================================================
cd "$(dirname "$0")"

# 1) 自修复：补执行权限（微信传文件夹等场景可能丢失 +x）
chmod +x "./node/macos/arm64/node" 2>/dev/null
chmod +x "./node/macos/x64/node" 2>/dev/null

# 2) 自修复：清除 macOS 隔离属性（quarantine）——微信/浏览器下载的文件
#    会被系统标记，导致内置 node 被 Gatekeeper 拦截
if command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "./node" 2>/dev/null
fi

# 3) 选择 Node：内置便携版（按 CPU 架构）→ 兼容目录 → 系统 Node
NODE_CMD=""
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ] && [ -f "./node/macos/arm64/node" ]; then
  NODE_CMD="./node/macos/arm64/node"
elif [ "$ARCH" = "x86_64" ] && [ -f "./node/macos/x64/node" ]; then
  NODE_CMD="./node/macos/x64/node"
elif [ -f "./node/macos/node" ]; then
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

# 4) 检查 Node 能否运行；被系统拦截时清隔离属性再试一次
NODE_MAJOR=$("$NODE_CMD" -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_MAJOR" ]; then
  echo "[提示] 内置 Node 被系统安全策略拦截，正在自动清除隔离属性…"
  xattr -cr "./node" 2>/dev/null || true
  chmod +x "./node/macos/arm64/node" "./node/macos/x64/node" 2>/dev/null
  NODE_MAJOR=$("$NODE_CMD" -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
fi
# 5) 架构兜底：当前架构的二进制跑不起来时，尝试另一个架构（如缺少 Rosetta）
if [ -z "$NODE_MAJOR" ]; then
  if [ "$ARCH" = "arm64" ] && [ -f "./node/macos/x64/node" ]; then
    NODE_CMD="./node/macos/x64/node"
  elif [ "$ARCH" = "x86_64" ] && [ -f "./node/macos/arm64/node" ]; then
    NODE_CMD="./node/macos/arm64/node"
  fi
  NODE_MAJOR=$("$NODE_CMD" -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
fi
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 18 ]; then
  echo "[错误] Node.js 无法运行或版本过低（需要 18+）。"
  echo "如反复出现，请打开「终端」执行下面一行后重试："
  echo "  xattr -cr \"$PWD\""
  read -p "按回车键退出…"
  exit 1
fi

echo "YexuL Canvas 启动中…（浏览器会自动打开）"
echo "保持本窗口开启；停止服务请关闭本窗口。"
echo
"$NODE_CMD" server.js
echo
echo "服务已停止。"
read -p "按回车键退出…"
