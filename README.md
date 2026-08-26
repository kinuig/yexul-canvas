# YexuL Canvas · 无限画布 AI 生图

**YexuL Canvas** 是一款**本地运行**的「无限画布 AI 生图 + 多窗口 AI 对话」桌面工具（浏览器 UI + 本机 Node 服务）。

- 🧩 无限画布：生图区 / 画布分区 / 图片节点 / MJ 生图区，滚轮缩放、拖拽平移
- 🎨 生图：文生图 / 图生图 / 图像编辑，比例+分辨率（1K/2K/4K）、多张并发实时回传、可中断
- 💬 对话：多窗口 GPT 聊天，流式输出、Markdown、多图视觉输入、每窗口独立 Skill 加载
- 📦 本地缓存与历史、常用提示词库、任务日志（服务端接入日志）
- 🪄 Skill 系统：对话窗口一键加载（内置「Midjourney提示词优化」，含专业词汇资产库与范本）
- 🔌 兼容 OpenAI 格式的 API 平台（/v1/images/generations、/v1/chat/completions），支持 MJ-Proxy 风格 Midjourney 接口

数据全部保存在本机（`data\` 与 `cache\`），API Key 只存在你自己的电脑上。

## 快速开始

**环境要求：Node.js 18+**（Windows 与 macOS 的便携版运行时见 Releases 发布包）

```bash
# Windows
启动画布.bat

# macOS / Linux
chmod +x 启动画布.command && ./启动画布.command
```

浏览器自动打开 `http://127.0.0.1:172`（端口被占用自动顺延 173~191，全部占用则自动随机分配并打印实际地址）。

首次使用：⚙ 设置 → 填 API 提供商（Base URL + API Key）→「测试连接并拉取模型」→ 勾选模型 → 开始创作。

详细说明见 [快速开始.md](./快速开始.md) 与 [使用说明.md](./使用说明.md)。

## 目录结构

```
├─ server.js            零依赖 Node 服务（Node 内置模块）
├─ public/              前端（原生 JS / CSS）
├─ skills/              Skill 文件（.md，frontmatter 声明 name/description）
├─ data/                运行数据（prompts.json 为内置常用提示词；其余运行时生成、已忽略）
├─ cache/               图片缓存（运行时生成、已忽略）
├─ 启动画布.bat          Windows 启动
├─ 启动画布.command      macOS 启动
└─ config.json          端口 / 主机 / 是否自动开浏览器
```

## 自定义 Skill

在 `skills\` 放入 `.md` 文件：

```markdown
---
name: 我的技能
description: 一句话说明这个技能的用途
---

这里是技能内容（作为对话的系统提示词）。
```

重启后，对话窗口顶部即出现对应按钮，点击加载 / 卸载。

## 安全说明

- 程序只在本机监听（默认 127.0.0.1），不对公网开放；
- 所有配置与缓存都保存在程序目录，删除 `data\` 与 `cache\` 即完全重置；
- 上传到平台的只有你的提示词与图片（正常 API 调用）。

## License

[MIT](./LICENSE)
