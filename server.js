/*
 * ============================================================
 *  YexuL Canvas · 无限画布生图 —— Windows 本地服务端
 *  零依赖（仅使用 Node.js 内置模块，Node >= 18）
 *
 *  职责：
 *   1. 静态服务：public/（页面）与 cache/（本地缓存图片）
 *   2. 生图代理：对接 gpt-best（OpenAI 兼容格式）的
 *      /v1/images/generations（文生图 / 图生图）与
 *      /v1/images/edits（图像编辑），并支持异步任务轮询
 *   3. 缓存：生成的图片一律落盘 cache/generated/，
 *      上传的本地图片落盘 cache/uploads/
 *   4. 历史记录 / 画布布局 / API 配置 持久化到 data/
 * ============================================================
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { exec } = require('child_process');
const crypto = require('crypto');
const zlib = require('zlib');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const CACHE_DIR = path.join(ROOT, 'cache');
const GEN_DIR = path.join(CACHE_DIR, 'generated');
const UPLOAD_DIR = path.join(CACHE_DIR, 'uploads');
const THUMB_DIR = path.join(CACHE_DIR, 'thumbs');
const LOG_FILE = path.join(DATA_DIR, 'logs.jsonl');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const USER_FILE = path.join(DATA_DIR, 'user.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const CANVAS_FILE = path.join(DATA_DIR, 'canvas.json');
const CHATS_FILE = path.join(DATA_DIR, 'chats.json');
const PROMPTS_FILE = path.join(DATA_DIR, 'prompts.json');
const PROVIDERS_FILE = path.join(DATA_DIR, 'providers.json');
const CHAT_PROMPTS_FILE = path.join(DATA_DIR, 'chat-prompts.json');
const SKILLS_DIR = path.join(ROOT, 'skills');

const APP_VERSION = '1.0.0';
const UPSTREAM_TIMEOUT_MS = 290 * 1000;   // 同步请求最长等待
const ASYNC_POLL_INTERVAL_MS = 3000;      // 异步任务轮询间隔
const ASYNC_MAX_WAIT_MS = 300 * 1000;     // 异步任务最长等待
const MAX_BODY = 96 * 1024 * 1024;        // 请求体上限（上传 base64 图片）
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/* ---------------- 工具函数 ---------------- */

function ensureDirs() {
  for (const d of [DATA_DIR, CACHE_DIR, GEN_DIR, UPLOAD_DIR, THUMB_DIR, PUBLIC_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

/** 接入日志：写控制台 + data/logs.jsonl（上限约 1MB，超出截头） */
function accessLog(text) {
  const line = `${new Date().toISOString()}  ${text}`;
  console.log('[接入日志] ' + text);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
    const st = fs.statSync(LOG_FILE);
    if (st.size > 1024 * 1024) {
      const buf = fs.readFileSync(LOG_FILE, 'utf8');
      const cut = buf.slice(buf.length - 512 * 1024);
      fs.writeFileSync(LOG_FILE, cut, 'utf8');
    }
  } catch { /* 忽略 */ }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};

/** 通过魔数嗅探图片真实格式 */
function sniffImageExt(buf) {
  if (!buf || buf.length < 12) return 'png';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  return 'png';
}

/** 根据 URL 后缀猜扩展名 */
function extFromUrl(u) {
  try {
    const p = new URL(u).pathname.toLowerCase();
    const m = p.match(/\.(png|jpe?g|webp|gif)($|\?)/);
    if (m) return m[1] === 'jpeg' ? 'jpg' : m[1];
  } catch { /* ignore */ }
  return null;
}

/**
 * 规范化 Base URL：允许用户填
 *   https://xxx.com 、 https://xxx.com/v1 、 https://xxx.com/v1/
 * 返回值不带版本段，各接口统一拼接 /v1/...
 */
function normalizeBase(raw) {
  let s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  s = s.replace(/\/v\d+\/?$/i, '');
  return s;
}

function maskKey(k) {
  if (!k) return '';
  return k.length > 10 ? `${k.slice(0, 6)}…${k.slice(-4)}` : '****';
}

function uid() {
  return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

/* ---------------- 模型目录（依据 gpt-best 绘图文档整理） ---------------- */

const MODEL_CATALOG = [
  {
    category: 'GPT 系列', models: [
      { id: 'gpt-image-1', name: 'GPT-Image-1（编辑能力）', sizes: ['1024x1024', '1536x1024', '1024x1536', 'auto'], quality: true, supportsImage: true, supportsEdit: true },
      { id: 'gpt-image-2', name: 'GPT-Image-2（最新·可自定义尺寸）', sizes: ['1024x1024', '1536x1024', '1024x1536', '2048x2048', '2048x1152', 'auto', 'custom'], freeSize: true, quality: true, supportsImage: true, supportsEdit: true, note: '尺寸边长需为16的倍数，最大3840' },
      { id: 'gpt-4o-image', name: 'GPT-4o Image', sizes: ['1024x1024', '1536x1024', '1024x1536', 'auto'], quality: true, supportsImage: true, supportsEdit: true },
      { id: 'gpt-4o-image-vip', name: 'GPT-4o Image VIP', sizes: ['1024x1024', '1536x1024', '1024x1536', 'auto'], quality: true, supportsImage: true, supportsEdit: true },
      { id: 'dall-e-3', name: 'DALL·E 3', sizes: ['1024x1024', '1792x1024', '1024x1792'], supportsImage: false },
      { id: 'sora_image', name: 'Sora Image', sizes: ['1024x1024', '1536x1024', '1024x1536'], supportsImage: true },
      { id: 'sora_image-vip', name: 'Sora Image VIP', sizes: ['1024x1024', '1536x1024', '1024x1536'], supportsImage: true },
    ],
  },
  {
    category: 'Google · Nano Banana', models: [
      { id: 'nano-banana', name: 'Nano Banana（性价比）', ratios: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '4:5', '5:4', '21:9'], supportsImage: true },
      { id: 'nano-banana-hd', name: 'Nano Banana HD（4K 高清）', ratios: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '4:5', '5:4', '21:9'], supportsImage: true },
      { id: 'nano-banana-2', name: 'Nano Banana 2（Pro）', ratios: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '4:5', '5:4', '21:9'], supportsImage: true },
      { id: 'gemini-3.1-flash-image-preview', name: 'Nano Banana 3.1 Flash', ratios: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '4:5', '5:4', '21:9', '1:4', '4:1', '8:1', '1:8'], supportsImage: true },
      { id: 'gemini-3.1-flash-lite-image', name: 'Nano Banana 3.1 Flash-Lite（最速）', ratios: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '4:5', '5:4', '21:9', '1:4', '4:1', '8:1', '1:8'], supportsImage: true },
    ],
  },
  {
    category: 'Flux 系列', models: [
      { id: 'flux-pro', name: 'FLUX Pro', sizes: ['1024x1024', '1024x768', '1024x576', '1024x512', '1366x768', '1344x576', '960x1280', '768x1366', '768x512', '512x1024', '512x768'], supportsImage: false },
      { id: 'flux-dev', name: 'FLUX Dev', sizes: ['1024x1024', '1024x768', '1024x576', '1024x512', '1366x768', '1344x576', '960x1280', '768x1366', '768x512', '512x1024', '512x768'], supportsImage: false },
      { id: 'flux', name: 'FLUX', sizes: ['1024x1024', '1024x768', '1024x576', '1024x512', '1366x768', '1344x576', '960x1280', '768x1366', '768x512', '512x1024', '512x768'], supportsImage: false },
      { id: 'flux-kontext-pro', name: 'FLUX Kontext Pro（图生图）', ratios: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9'], supportsImage: true, note: '参考图 URL 会并入提示词' },
      { id: 'flux-kontext-max', name: 'FLUX Kontext Max（图生图）', ratios: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9'], supportsImage: true, note: '参考图 URL 会并入提示词' },
      { id: 'flux-kontext-dev', name: 'FLUX Kontext Dev（必须有参考图）', ratios: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9'], supportsImage: true, note: '必须有参考图' },
    ],
  },
  {
    category: '通义 · Qwen', models: [
      { id: 'qwen-image', name: 'Qwen-Image（文生图）', sizes: ['1024x1024', '1280x720', '720x1280', '1664x928', '928x1664', '1472x1140', '1140x1472'], supportsImage: false, negative: true },
      { id: 'qwen-image-edit', name: 'Qwen-Image-Edit（图生图）', sizes: ['1024x1024', '1280x720', '720x1280', '1664x928', '928x1664', '1472x1140', '1140x1472'], supportsImage: true, supportsEdit: true, negative: true, note: '仅支持一张参考图' },
      { id: 'qwen-image-edit-2509', name: 'Qwen-Image-Edit-2509（多图输入）', sizes: ['1024x1024', '1280x720', '720x1280', '1664x928', '928x1664', '1472x1140', '1140x1472'], supportsImage: true, supportsEdit: true, negative: true, note: '支持多张参考图' },
    ],
  },
  {
    category: '豆包 · 即梦 / 火山', models: [
      { id: 'seedream-v5-pro', name: 'Seedream V5 Pro（最新）', sizes: ['1024x1024', '2048x2048'], supportsImage: true },
      { id: 'doubao-seedream-4-0-250828', name: 'Seedream 4.0（即梦4）', sizes: ['1024x1024', '2048x2048', '1280x720', '720x1280'], supportsImage: true, negative: true },
      { id: 'doubao-seedream-3-0-t2i-250415', name: 'Seedream 3.0（文生图）', sizes: ['1024x1024', '2048x2048', '1280x720', '720x1280'], supportsImage: false, negative: true },
      { id: 'doubao-seededit-3-0-i2i-250628', name: 'SeedEdit 3.0（图生图/编辑）', sizes: ['1024x1024', '2048x2048', '1280x720', '720x1280'], supportsImage: true, supportsEdit: true, negative: true },
    ],
  },
  {
    category: 'Grok', models: [
      { id: 'grok-4.2-image', name: 'Grok 4.2 Image', ratios: ['1:1', '2:3', '3:2', '9:16', '16:9'], supportsImage: true },
      { id: 'grok-4.1-image', name: 'Grok 4.1 Image', ratios: ['1:1', '2:3', '3:2', '9:16', '16:9'], supportsImage: true },
    ],
  },
  {
    category: 'Recraft', models: [
      { id: 'recraftv3', name: 'Recraft V3', sizes: ['1024x1024', '1024x768', '1024x576', '1024x512', '1366x768', '1344x576', '960x1280', '768x1366', '768x512', '512x1024', '512x768'], supportsImage: false },
      { id: 'recraftv3-halloween', name: 'Recraft V3（万圣节风格）', sizes: ['1024x1024', '1024x768', '1024x576', '1024x512', '1366x768', '1344x576', '960x1280', '768x1366', '768x512', '512x1024', '512x768'], supportsImage: false },
    ],
  },
];

function findModel(id) {
  for (const g of MODEL_CATALOG) {
    const m = g.models.find((x) => x.id === id);
    if (m) return m;
  }
  return null;
}

/* 旧模型名 → 平台正式模型名（兼容老版本保存的数据） */
const MODEL_ALIASES = {
  'nano-banana-3.1-flash': 'gemini-3.1-flash-image-preview',
  'nano-banana-3.1-flash-lite': 'gemini-3.1-flash-lite-image',
};

/* ---------------- 比例 / 分辨率 → 尺寸 ---------------- */

const RATIO_LIST = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '1:2', '2:1', '9:21', '21:9'];

/** 比例 + 分辨率 → 像素尺寸（长边 1K=1024 / 2K=2048 / 4K=3840，短边按比例，16 倍数取整）
 *  maxPixels：总像素上限（GPT-Image 系列为 8,294,400，超出按比例缩回，避免平台拒绝） */
function ratioToSize(ratio, resolution, maxPixels) {
  const m = String(ratio || '1:1').match(/^(\d+):(\d+)$/);
  if (!m) return '';
  const w = Number(m[1]);
  const h = Number(m[2]);
  const cap = maxPixels || Infinity;
  const round16 = (n) => Math.max(16, Math.min(3840, Math.round(n / 16) * 16));
  let long = resolution === '1K' ? 1024 : resolution === '4K' ? 3840 : 2048;
  // 长宽比上限 3:1
  let r = Math.min(w, h) / Math.max(w, h);
  r = Math.max(r, 1 / 3);
  let short = round16(long * r);
  // 总像素上限：等比缩回
  if (long * short > cap) {
    const scale = Math.sqrt(cap / (long * short));
    long = round16(long * scale);
    short = round16(short * scale);
  }
  return w >= h ? `${long}x${short}` : `${short}x${long}`;
}

/** 从模型的固定尺寸表里选比例/像素量最接近的一项 */
function nearestSize(mdef, targetSize) {
  if (!mdef || !Array.isArray(mdef.sizes) || !mdef.sizes.length) return targetSize;
  const list = mdef.sizes.filter((s) => /^\d+x\d+$/.test(s));
  if (!list.length) return targetSize;
  const tm = String(targetSize).match(/^(\d+)x(\d+)$/);
  if (!tm) return list[0];
  const ta = Number(tm[1]) / Number(tm[2]);
  const tp = Number(tm[1]) * Number(tm[2]);
  let best = list[0];
  let bestScore = Infinity;
  for (const s of list) {
    const m2 = s.match(/^(\d+)x(\d+)$/);
    const a = Number(m2[1]) / Number(m2[2]);
    const p = Number(m2[1]) * Number(m2[2]);
    const score = Math.abs(a - ta) * 100 + Math.abs(Math.log2(p) - Math.log2(tp));
    if (score < bestScore) { bestScore = score; best = s; }
  }
  return best;
}

/* ---------------- 上游调用（gpt-best / OpenAI 兼容） ---------------- */

/** 组合超时信号与外部中断信号（Node 18 兼容实现） */
function withTimeoutSignal(timeoutMs, external) {
  if (!external) return AbortSignal.timeout(timeoutMs);
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([AbortSignal.timeout(timeoutMs), external]);
  }
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  if (t.unref) t.unref();
  const onAbort = () => c.abort(external.reason);
  if (external.aborted) onAbort();
  else external.addEventListener('abort', onAbort, { once: true });
  return c.signal;
}

async function requestJson(url, init, timeout, externalSignal) {
  const res = await fetch(url, {
    ...init,
    signal: withTimeoutSignal(timeout || UPSTREAM_TIMEOUT_MS, externalSignal),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch { /* 非 JSON */ }
  return { res, json, text };
}

/** 带重试的请求：502 / 503 / 504（上游繁忙）自动重试，退避 2s/5s/10s */
async function requestJsonWithRetry(url, init, timeout, retries = 3, label = '', externalSignal) {
  const BACKOFF = [2000, 5000, 10000];
  let last = null;
  for (let i = 0; i <= retries; i++) {
    const r = await requestJson(url, init, timeout, externalSignal);
    if (r.res.status !== 502 && r.res.status !== 503 && r.res.status !== 504) return r;
    last = r;
    if (i < retries) {
      const wait = BACKOFF[i] || 10000;
      console.log(`[重试] ${label || url} 收到 HTTP ${r.res.status}，${(wait / 1000)}s 后第 ${i + 1} 次重试…`);
      accessLog(`${label || url} 收到 HTTP ${r.res.status}，${(wait / 1000)}s 后第 ${i + 1} 次重试`);
      await new Promise((res) => setTimeout(res, wait));
    }
  }
  return last;
}

function upstreamErrorMessage(res, json, text) {
  if (res.status === 401 || res.status === 403) return '鉴权失败：API Key 无效或已过期，请在「设置」中检查';
  if (res.status === 404) return '接口不存在：请检查 Base URL 或模型名称（404）';
  if (res.status === 405) return '接口方法不被允许（405）：该地址可能不支持 Midjourney 接口——请在设置里为该提供商单独填写「MJ 接口地址」（支持 MJ 的域名），或换回原 Base URL';
  if (res.status === 413) return '请求体过大（413）：附图/参考图太多太大，超出平台请求体上限——请减少附图数量，或在 GRS 提供商下重新添加图片（程序会自动压缩到 2048px 以内）';
  if (res.status === 429) return '请求过于频繁或额度不足（429），请稍后再试';
  if (res.status >= 500) return `上游服务错误（${res.status}），请稍后再试`;
  const detail = json?.error?.message || json?.message || json?.description || json?.detail ||
    (typeof json?.error === 'string' ? json.error : '') || (text || '').slice(0, 200);
  return detail ? `上游返回错误（${res.status}）：${detail}` : `上游返回错误（${res.status}）`;
}

/** 从各种可能的响应结构里提取图片列表 */
function extractImages(json) {
  if (!json || typeof json !== 'object') return [];
  const out = [];
  const push = (item) => {
    if (item && typeof item === 'object') {
      if (typeof item.url === 'string' && item.url) out.push({ url: item.url });
      else if (typeof item.b64_json === 'string' && item.b64_json) out.push({ b64: item.b64_json });
    }
  };
  // 同步标准结构：{ data: [ {url|b64_json} ] }
  if (Array.isArray(json.data)) json.data.forEach(push);
  // 异步结构：{ data: { data: [ ... ] } }
  if (json.data && Array.isArray(json.data.data)) json.data.data.forEach(push);
  // 异步结构（平台示例）：{ data: { data: { data: [ ... ] } } }
  if (json.data && json.data.data && Array.isArray(json.data.data.data)) json.data.data.data.forEach(push);
  // 异步结构变体
  if (json.data && Array.isArray(json.data.result)) json.data.result.forEach(push);
  return out;
}

/** 轮询异步任务直到完成 */
async function pollAsyncTask(base, key, taskId, startedAt, externalSignal) {
  for (;;) {
    if (Date.now() - startedAt > ASYNC_MAX_WAIT_MS) throw new Error('任务等待超时（5分钟），可稍后在平台上查询该任务');
    await new Promise((r) => setTimeout(r, ASYNC_POLL_INTERVAL_MS));
    const { res, json } = await requestJson(`${base}/v1/images/tasks/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${key}` },
    }, 30000, externalSignal);
    if (!res.ok) throw new Error(upstreamErrorMessage(res, json, ''));
    const status = (json?.data?.status || json?.status || '').toUpperCase();
    if (status === 'SUCCESS') return json;
    if (status === 'FAILURE') throw new Error(`任务失败：${json?.data?.fail_reason || json?.fail_reason || '未知原因'}`);
  }
}

/** 把缓存里的参考图读成 {buf, mime, dataUri} */
async function loadRefs(ids) {
  const out = [];
  for (const id of ids || []) {
    if (typeof id !== 'string' || !id || id.includes('..') || id.includes('\\') || id.includes(':')) continue;
    // 只允许 cache 下 generated/ 与 uploads/ 两处的文件
    if (!/^(generated|uploads)\/[A-Za-z0-9._-]+$/.test(id)) continue;
    const file = path.join(CACHE_DIR, id);
    if (!fs.existsSync(file)) continue;
    const buf = await fsp.readFile(file);
    const ext = path.extname(file).slice(1).toLowerCase();
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext] || 'image/png';
    out.push({ buf, mime, dataUri: `data:${mime};base64,${buf.toString('base64')}` });
  }
  return out;
}

/** Gemini 原生格式生图（/v1beta/models/{model}:generateContent）：
 *  用于 NewAPI 等平台（/v1/images/generations 只支持 imagen 模型）。
 *  返回与 extractImages 相同形状的 [{b64}]。 */
async function upstreamGeminiNative({ base, key, model, prompt, aspectRatio, imageSize, refs }, externalSignal) {
  const parts = [];
  for (const r of refs) {
    const b64 = String(r.dataUri || '').split(',')[1] || '';
    if (b64) parts.push({ inlineData: { data: b64, mimeType: r.mime } });
  }
  parts.push({ text: prompt });
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseModalities: ['IMAGE'] },
  };
  if (aspectRatio || imageSize) {
    body.generationConfig.imageConfig = Object.assign(
      aspectRatio ? { aspectRatio } : {},
      imageSize ? { imageSize } : {},
    );
  }
  const { res, json, text } = await requestJsonWithRetry(`${base}/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, UPSTREAM_TIMEOUT_MS, 2, `生图 ${model}（Gemini 原生）`, externalSignal);
  if (!res.ok) throw new Error(upstreamErrorMessage(res, json, text));

  const imgs = [];
  const pushParts = (arr) => {
    for (const p of arr || []) {
      if (p && p.inlineData && typeof p.inlineData.data === 'string' && p.inlineData.data) {
        imgs.push({ b64: p.inlineData.data });
      }
    }
  };
  for (const c of json.candidates || []) pushParts(c.content && c.content.parts);
  if (!imgs.length) throw new Error('Gemini 原生接口未返回图片，请更换模型或稍后重试');
  return imgs;
}

/** 生成（generations，含图生图） */
async function upstreamGenerations({ base, key, model, prompt, negative, size, aspectRatio, imageSize, n, quality, outputFormat, background, moderation, refs, customParams }, externalSignal) {
  const body = { model, prompt };
  if (negative) body.negative_prompt = negative;
  if (size) body.size = size;
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  if (imageSize) body.image_size = imageSize;
  if (n && Number(n) > 1) body.n = Number(n);
  if (quality && quality !== 'auto') body.quality = quality;
  body.response_format = 'url';
  if (outputFormat && outputFormat !== 'auto') body.output_format = outputFormat;
  if (background && background !== 'auto') body.background = background;
  if (moderation && moderation !== 'auto') body.moderation = moderation;
  if (refs.length) body.image = refs.map((r) => r.dataUri);
  if (customParams && typeof customParams === 'object') Object.assign(body, customParams);

  const { res, json, text } = await requestJsonWithRetry(`${base}/v1/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, UPSTREAM_TIMEOUT_MS, 2, `生图 ${model}`, externalSignal);

  if (!res.ok) {
    const msg = upstreamErrorMessage(res, json, text);
    const detail = String(json?.error?.message || json?.message || json?.description || text || '').slice(0, 400);
    // NewAPI 等平台的 gemini 生图模型不走 /v1/images/generations：自动回退 Gemini 原生格式
    if (/not supported model for image generation|only imagen models/i.test(detail)) {
      accessLog(`生图 ${model}：平台不支持标准 generations 接口（${detail}），改用 Gemini 原生格式重试`);
      return upstreamGeminiNative({ base, key, model, prompt, aspectRatio, imageSize, refs }, externalSignal);
    }
    throw new Error(msg);
  }

  // 平台可能返回异步任务（code + task_id），此时轮询
  const taskId = json?.data && typeof json.data === 'string' ? json.data : json?.task_id || json?.data?.task_id;
  if (taskId) {
    const finalJson = await pollAsyncTask(base, key, taskId, Date.now(), externalSignal);
    return extractImages(finalJson);
  }
  return extractImages(json);
}

/** 图像编辑（edits，multipart 文件流） */
async function upstreamEdits({ base, key, model, prompt, negative, size, n, quality, refs }, externalSignal) {
  const fd = new FormData();
  fd.append('model', model);
  fd.append('prompt', prompt);
  if (negative) fd.append('negative_prompt', negative);
  if (size) fd.append('size', size);
  if (n && Number(n) > 1) fd.append('n', String(Number(n)));
  if (quality && quality !== 'auto') fd.append('quality', quality);
  if (refs[0]) fd.append('image', new Blob([refs[0].buf], { type: refs[0].mime }), `ref.${refs[0].mime.split('/')[1]}`);

  const { res, json, text } = await requestJsonWithRetry(`${base}/v1/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: fd,
  }, UPSTREAM_TIMEOUT_MS, 2, `编辑 ${model}`, externalSignal);
  if (!res.ok) throw new Error(upstreamErrorMessage(res, json, text));
  return extractImages(json);
}


/** GRS（grsai）专用 nano-banana 生图接口：POST /v1/api/generate
 *  参数：model / prompt / images[] / aspectRatio / imageSize(1K/2K/4K) / replyType(json)
 *  响应：{ id, status:'succeeded', results:[{url}], progress } */
async function upstreamGrsGenerate({ base, key, model, prompt, aspectRatio, imageSize, refs }, externalSignal) {
  const body = {
    model,
    prompt,
    images: (refs || []).map((r) => r.dataUri),
    aspectRatio: aspectRatio || 'auto',
    imageSize: imageSize || '1K',
    replyType: 'json',
  };
  const { res, json, text } = await requestJsonWithRetry(`${base}/v1/api/generate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, UPSTREAM_TIMEOUT_MS, 2, `生图 ${model}（GRS draw）`, externalSignal);
  if (!res.ok) throw new Error(upstreamErrorMessage(res, json, text));

  const pick = (j) => (Array.isArray(j && j.results) ? j.results : [])
    .filter((x) => x && typeof x.url === 'string' && x.url)
    .map((x) => ({ url: x.url }));
  const out = pick(json);
  if (out.length) return out;

  /* 排队/异步：轮询结果接口 */
  const tid = json && (json.id || json.taskId || json.task_id);
  if (tid) {
    accessLog(`GRS 生图任务排队：${tid}，轮询结果中…`);
    const started = Date.now();
    for (;;) {
      if (Date.now() - started > ASYNC_MAX_WAIT_MS) throw new Error('GRS 生图任务等待超时（5分钟）');
      await new Promise((s) => setTimeout(s, 3000));
      const q = await requestJsonWithRetry(`${base}/v1/draw/result`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: tid, task_id: tid }),
      }, 30000, 2, `GRS 查询 ${tid}`, externalSignal);
      if (!q.res.ok) throw new Error(upstreamErrorMessage(q.res, q.json, q.text));
      const rr = pick(q.json);
      if (rr.length) return rr;
      if (q.json && String(q.json.status).toLowerCase() === 'failed') throw new Error('GRS 生图任务失败');
    }
  }
  throw new Error('GRS 生图接口未返回图片');
}

/** 下载并保存图片到缓存 */
async function saveImageToCache(source, meta) {
  let buf = null;
  if (source.url) {
    const r = await fetch(source.url, { signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`下载生成图失败（HTTP ${r.status}）`);
    buf = Buffer.from(await r.arrayBuffer());
  } else if (source.b64) {
    buf = Buffer.from(source.b64.replace(/^data:[^;]+;base64,/, ''), 'base64');
  }
  if (!buf || buf.length < 64) throw new Error('生成结果为空');
  const ext = extFromUrl(source.url || '') || sniffImageExt(buf);
  const name = `${Date.now()}-${(meta.model || 'img').replace(/[^\w.-]/g, '_')}-${meta.idx}.${ext}`;
  await fsp.writeFile(path.join(GEN_DIR, name), buf);
  return { file: path.posix.join('generated', name), url: `/cache/generated/${encodeURIComponent(name)}`, bytes: buf.length };
}

/* ---------------- 历史记录 ---------------- */

function loadHistory() {
  const h = readJson(HISTORY_FILE, []);
  return Array.isArray(h) ? h : [];
}

function saveHistory(list) {
  writeJson(HISTORY_FILE, list.slice(0, 1000));
}

function addHistory(entry) {
  const list = loadHistory();
  list.unshift(entry);
  saveHistory(list);
}

/* ---------------- 配置 ---------------- */

function loadServerConfig() {
  return Object.assign({ port: 172, host: '127.0.0.1' }, readJson(CONFIG_FILE, {}));
}

function loadUserConfig() {
  return Object.assign({ baseUrl: '', apiKey: '', defaultModel: 'gpt-image-1', defaultChatModel: '', mjBaseUrl: '', mjApiKey: '' }, readJson(USER_FILE, {}));
}

/* ---------------- API 提供商管理 ---------------- */

function loadProviders() {
  const existing = readJson(PROVIDERS_FILE, null);
  if (existing && Array.isArray(existing.providers) && existing.providers.length) {
    // 迁移：老数据没有勾选字段时，默认勾选全部已拉取模型
    let changed = false;
    for (const prov of existing.providers) {
      if (!Array.isArray(prov.selectedImageModels)) {
        prov.selectedImageModels = (prov.imageModels || []).slice();
        changed = true;
      }
      if (!Array.isArray(prov.selectedChatModels)) {
        prov.selectedChatModels = (prov.chatModels || []).slice();
        changed = true;
      }
    }
    if (changed) writeJson(PROVIDERS_FILE, existing);
    return existing;
  }
  // 首次使用：把旧配置迁移为「默认提供商」
  const u = loadUserConfig();
  const p = {
    active: 'default',
    providers: [{
      id: 'default', name: '默认提供商',
      baseUrl: u.baseUrl || '', apiKey: u.apiKey || '',
      imageModels: [], chatModels: [], selectedImageModels: [], selectedChatModels: [], fetchedAt: 0,
    }],
  };
  writeJson(PROVIDERS_FILE, p);
  return p;
}

function saveProviders(p) {
  writeJson(PROVIDERS_FILE, p);
}

/** 当前生效的提供商（生图/对话默认使用） */
function activeProvider() {
  const p = loadProviders();
  const act = (p.providers || []).find((x) => x.id === p.active) || (p.providers || [])[0] || null;
  if (act && act.baseUrl && act.apiKey) return act;
  const u = loadUserConfig();
  return { id: 'default', name: '默认提供商', baseUrl: u.baseUrl || '', apiKey: u.apiKey || '', imageModels: [], chatModels: [], fetchedAt: 0 };
}

/** 根据模型名把 /v1/models 结果分为 生图模型 / 对话模型
 *  生图只收录 Gemini / nano-banana / GPT-image / dall-e / imagen 家族，其余由内置目录兜底 */
function classifyModels(ids) {
  const image = [];
  const chat = [];
  const isImage = (low) => low.includes('gpt-image') || low.includes('dall')
    || low.includes('nano-banana') || low.includes('imagen')
    || (low.includes('gemini') && low.includes('image'));
  const CHAT_EXCLUDE = ['embedding', 'moderation', 'whisper', 'tts', 'audio', 'rerank',
    'davinci', 'babbage', 'curie', 'ada', 'bge-', 'speech', 'transcribe', 'voice', 'asr'];
  for (const id of ids) {
    const low = String(id).toLowerCase();
    if (isImage(low)) image.push(id);
    else if (!CHAT_EXCLUDE.some((k) => low.includes(k))) chat.push(id);
  }
  return { image, chat };
}

/** 拉取某 baseUrl+key 的模型并分类，返回 {image, chat} */
async function fetchProviderModels(baseUrl, apiKey) {
  const base = normalizeBase(baseUrl);
  const { res, json } = await requestJson(`${base}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  }, 25000);
  if (!res.ok) throw new Error(upstreamErrorMessage(res, json, ''));
  const ids = (Array.isArray(json.data) ? json.data.map((m) => m.id) : []).filter((id) => typeof id === 'string');
  return classifyModels(ids);
}

/* ---------------- 静态文件服务 ---------------- */

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '');
  let root = PUBLIC_DIR;
  let cacheControl = 'no-cache';
  if (rel.startsWith('cache/')) {
    root = CACHE_DIR;
    rel = rel.slice('cache/'.length);
    cacheControl = 'public, max-age=31536000, immutable';
  }
  if (!rel) rel = 'index.html';
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep) && file !== root) {
    sendJson(res, 403, { error: '非法路径' });
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      sendJson(res, 404, { error: '文件不存在' });
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cacheControl });
    res.end(buf);
  });
}

/* ---------------- 路由 ---------------- */

async function handleApi(req, res, urlPath, query) {
  const u = new URL(req.url, 'http://x');
  const api = urlPath.split('?')[0];

  /* 健康检查 */
  if (api === '/api/health' && req.method === 'GET') {
    const cfg = loadServerConfig();
    return sendJson(res, 200, {
      ok: true, app: 'yexul-canvas', version: APP_VERSION,
      port: cfg.port, host: cfg.host, cacheDir: CACHE_DIR,
      hasKey: !!loadUserConfig().apiKey,
    });
  }

  /* 模型目录：只返回当前提供商「已勾选」的生图模型（内置目录不再默认展示，与勾选项同名时合并元数据） */
  if (api === '/api/models' && req.method === 'GET') {
    const prov = activeProvider();
    const sel = (prov.selectedImageModels || []).slice();
    const groups = [];
    if (sel.length) {
      groups.push({
        category: `已勾选模型（${prov.name || '当前提供商'}）`,
        models: sel.map((id) => {
          const c = findModel(id);
          return c ? { ...c } : { id, name: id, supportsImage: true };
        }),
      });
    }
    return sendJson(res, 200, { groups });
  }

  /* 读取 / 保存用户配置（默认模型等） */
  if (api === '/api/config' && req.method === 'GET') {
    const user = loadUserConfig();
    const prov = activeProvider();
    const cfg = loadServerConfig();
    return sendJson(res, 200, {
      ...user,
      apiKeyMasked: maskKey(prov.apiKey || user.apiKey),
      activeProvider: prov.name || '',
      port: cfg.port, host: cfg.host, cacheDir: CACHE_DIR, version: APP_VERSION,
    });
  }
  if (api === '/api/config' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
    const user = loadUserConfig();
    if (typeof body.baseUrl === 'string') user.baseUrl = body.baseUrl.trim();
    if (typeof body.apiKey === 'string' && body.apiKey !== '') user.apiKey = body.apiKey.trim();
    if (typeof body.defaultModel === 'string') user.defaultModel = body.defaultModel.trim();
    if (typeof body.defaultChatModel === 'string') user.defaultChatModel = body.defaultChatModel.trim();
    /* MJ 独立配置：地址与 Key 与当前提供商无关，空值可清除 */
    if (typeof body.mjBaseUrl === 'string') user.mjBaseUrl = body.mjBaseUrl.trim();
    if (typeof body.mjApiKey === 'string') user.mjApiKey = body.mjApiKey.trim();
    writeJson(USER_FILE, user);
    return sendJson(res, 200, { ok: true, apiKeyMasked: maskKey(user.apiKey) });
  }

  /* ---------- API 提供商 ---------- */
  if (api === '/api/providers' && req.method === 'GET') {
    const p = loadProviders();
    return sendJson(res, 200, {
      active: p.active,
      providers: (p.providers || []).map((x) => ({ ...x, apiKeyMasked: maskKey(x.apiKey) })),
    });
  }
  /* GRS（grsai.ai）内置模型目录：平台不开放 /v1/models 拉取接口，按官网模型列表内置 */
  const GRS_MODELS = {
    imageModels: [
      'gpt-image-2', 'gpt-image-2-vip',
      'nano-banana-pro', 'nano-banana-fast', 'nano-banana-pro-vt',
      'nano-banana-2', 'nano-banana-2-lite', 'nano-banana-pro-cl',
      'nano-banana-2-cl', 'nano-banana-2-2k-cl', 'nano-banana-pro-vip',
      'nano-banana-pro-4k-vip', 'nano-banana-2-4k-cl',
    ],
    chatModels: [
      'gpt-5.6-sol', 'gpt-5.4', 'gpt-5.6-terra', 'gpt-5.5',
      'gemini-3-flash', 'gemini-3.1-pro', 'gemini-3-pro', 'gemini-3.1-flash-lite',
      'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-pro',
    ],
  };
  const isGrsProvider = (baseUrl) => {
    try { return /grs/i.test(new URL(normalizeBase(baseUrl)).hostname); } catch { return false; }
  };

  if (api === '/api/providers/add' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
    const name = String(body.name || '').trim().slice(0, 40) || '新提供商';
    const baseUrl = String(body.baseUrl || '').trim();
    const apiKey = String(body.apiKey || '').trim();
    const p = loadProviders();
    let prov = body.id ? (p.providers || []).find((x) => x.id === body.id) : null;
    if (prov) {
      // 编辑模式：只更新传入的字段
      if (name !== '新提供商') prov.name = name;
      if (baseUrl) prov.baseUrl = baseUrl;
      if (apiKey) prov.apiKey = apiKey;
      if (typeof body.mjBaseUrl === 'string') prov.mjBaseUrl = body.mjBaseUrl.trim() || '';
    } else {
      if (!baseUrl || !apiKey) return sendJson(res, 400, { error: '请填写 Base URL 与 API Key' });
      prov = {
        id: uid(), name, baseUrl, apiKey,
        mjBaseUrl: String(body.mjBaseUrl || '').trim(),
        imageModels: [], chatModels: [], selectedImageModels: [], selectedChatModels: [], fetchedAt: 0,
      };
      // GRS 等不开放 /v1/models 的平台：直接载入内置目录（默认不勾选，由用户在「选择模型」中勾选）
      if (isGrsProvider(baseUrl)) {
        prov.imageModels = GRS_MODELS.imageModels.slice();
        prov.chatModels = GRS_MODELS.chatModels.slice();
        accessLog(`提供商「${name}」为 GRS 平台，已载入内置模型目录（生图 ${GRS_MODELS.imageModels.length} / 对话 ${GRS_MODELS.chatModels.length}）`);
      }
      p.providers.push(prov);
    }
    saveProviders(p);
    return sendJson(res, 200, { ok: true, id: prov.id });
  }
  if (api === '/api/providers/delete' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
    const p = loadProviders();
    p.providers = (p.providers || []).filter((x) => x.id !== body.id);
    if (p.active === body.id) p.active = p.providers[0] ? p.providers[0].id : '';
    saveProviders(p);
    return sendJson(res, 200, { ok: true });
  }
  if (api === '/api/providers/use' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
    const p = loadProviders();
    if ((p.providers || []).some((x) => x.id === body.id)) p.active = body.id;
    saveProviders(p);
    return sendJson(res, 200, { ok: true, active: p.active });
  }
  /* 勾选/取消勾选模型：只有勾选的模型才出现在生图区与对话下拉 */
  if (api === '/api/providers/select' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 128 * 1024)).toString('utf8') || '{}');
    const p = loadProviders();
    const prov = (p.providers || []).find((x) => x.id === body.id);
    if (!prov) return sendJson(res, 400, { error: '提供商不存在' });
    if (Array.isArray(body.imageModels)) {
      prov.selectedImageModels = body.imageModels.filter((m) => (prov.imageModels || []).includes(m));
    }
    if (Array.isArray(body.chatModels)) {
      prov.selectedChatModels = body.chatModels.filter((m) => (prov.chatModels || []).includes(m));
    }
    saveProviders(p);
    return sendJson(res, 200, {
      ok: true,
      selectedImage: prov.selectedImageModels.length,
      selectedChat: prov.selectedChatModels.length,
    });
  }
  /* 测试连接并拉取模型：可针对已存提供商（id）或表单新填的值 */
  if (api === '/api/providers/fetch' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
    const p = loadProviders();
    let prov = body.id ? (p.providers || []).find((x) => x.id === body.id) : null;
    const name = String(body.name || '').trim().slice(0, 40);
    const baseUrl = String(body.baseUrl || '').trim();
    const apiKey = String(body.apiKey || '').trim();
    try {
      if (prov) {
        if (baseUrl) prov.baseUrl = baseUrl;
        if (apiKey) prov.apiKey = apiKey;
        if (name) prov.name = name;
        if (typeof body.mjBaseUrl === 'string') prov.mjBaseUrl = body.mjBaseUrl.trim() || '';
      } else {
        if (!baseUrl || !apiKey) return sendJson(res, 400, { error: '请填写 Base URL 与 API Key' });
        // 只有一个未拉取过的「默认提供商」时，直接升级它，避免重复新建
        const upgradable = (p.providers || []).length === 1 && (p.providers || [])[0].id === 'default' && !(p.providers || [])[0].fetchedAt;
        if (upgradable) {
          prov = (p.providers || [])[0];
          prov.baseUrl = baseUrl;
          prov.apiKey = apiKey;
          if (name) prov.name = name;
          prov.mjBaseUrl = String(body.mjBaseUrl || '').trim();
        } else {
          prov = {
            id: uid(),
            name: name || (() => { try { return new URL(normalizeBase(baseUrl)).hostname; } catch { return '新提供商'; } })(),
            baseUrl, apiKey,
            mjBaseUrl: String(body.mjBaseUrl || '').trim(),
            imageModels: [], chatModels: [], fetchedAt: 0,
          };
          p.providers.push(prov);
        }
      }
      let image = [];
      let chat = [];
      let pulledOk = true;
      try {
        const r = await fetchProviderModels(prov.baseUrl, prov.apiKey);
        image = r.image;
        chat = r.chat;
      } catch (e) {
        // 部分平台不开放 /v1/models：仍保存并启用提供商
        pulledOk = false;
        if (isGrsProvider(prov.baseUrl)) {
          // GRS：载入官网内置模型目录，供「选择模型」勾选
          image = GRS_MODELS.imageModels.slice();
          chat = GRS_MODELS.chatModels.slice();
          accessLog(`提供商「${prov.name}」模型拉取失败（${e.message}）——GRS 平台未开放模型列表接口，已载入内置目录`);
        } else {
          accessLog(`提供商「${prov.name}」模型拉取失败（${e.message}），仍保存提供商，模型列表为空`);
        }
      }
      prov.imageModels = image;
      prov.chatModels = chat;
      // 拉取成功后默认全部勾选；拉取失败（含 GRS 内置目录）默认不勾选，由用户在「选择模型」中勾选
      prov.selectedImageModels = pulledOk ? image.slice() : [];
      prov.selectedChatModels = pulledOk ? chat.slice() : [];
      prov.fetchedAt = pulledOk ? Date.now() : 0;
      p.active = prov.id;
      saveProviders(p);
      return sendJson(res, 200, {
        ok: true, id: prov.id, name: prov.name,
        imageModels: image, chatModels: chat,
        imageCount: image.length, chatCount: chat.length,
        message: pulledOk
          ? `拉取成功：生图模型 ${image.length} 个，对话模型 ${chat.length} 个`
          : (isGrsProvider(prov.baseUrl)
            ? `已保存并启用提供商「${prov.name}」（GRS 未开放模型列表接口，已载入官网内置清单：生图 ${image.length} 个 / 对话 ${chat.length} 个，请勾选要用的模型）`
            : `已保存并启用提供商「${prov.name}」（该平台未开放模型列表接口，未拉取到模型，模型下拉为空）`),
      });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: `拉取失败：${e.message}` });
    }
  }

  /* 测试连接（兼容旧接口，只测试不保存） */
  if (api === '/api/test' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
    const base = normalizeBase(body.baseUrl);
    const key = String(body.apiKey || '').trim();
    if (!base || !key) return sendJson(res, 400, { ok: false, error: '请先填写 Base URL 与 API Key' });
    try {
      const { image, chat } = await fetchProviderModels(base, key);
      return sendJson(res, 200, { ok: true, imageCount: image.length, chatCount: chat.length, message: `连接成功：生图模型 ${image.length} 个，对话模型 ${chat.length} 个` });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: `连接失败：${e.message}` });
    }
  }

  /* 上传本地图片 */
  if (api === '/api/upload' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const base64 = String(body.base64 || '');
    if (!base64) return sendJson(res, 400, { error: '缺少图片数据' });
    const m = base64.match(/^data:(image\/(png|jpeg|jpg|webp|gif));base64,(.+)$/s);
    if (!m) return sendJson(res, 400, { error: '仅支持 PNG / JPG / WEBP / GIF 图片' });
    const buf = Buffer.from(m[3], 'base64');
    if (buf.length > MAX_UPLOAD_BYTES) return sendJson(res, 400, { error: '图片超过 25MB 限制' });
    const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
    const name = `u_${uid()}.${ext}`;
    await fsp.writeFile(path.join(UPLOAD_DIR, name), buf);
    return sendJson(res, 200, {
      ok: true, id: path.posix.join('uploads', name),
      url: `/cache/uploads/${encodeURIComponent(name)}`, bytes: buf.length,
    });
  }

  /* 生图（核心） */
  if (api === '/api/generate' && req.method === 'POST') {
    const t0 = Date.now();
    let model = '';
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const user = loadUserConfig();
      const prov = activeProvider();
      const base = normalizeBase(body.baseUrl || prov.baseUrl);
      const key = String(body.apiKey || prov.apiKey || '').trim();
      model = String(body.model || user.defaultModel || 'gpt-image-1').trim();
      if (MODEL_ALIASES[model]) model = MODEL_ALIASES[model];
      const prompt = String(body.prompt || '').trim();
      const mode = body.mode === 'edits' ? 'edits' : 'generations';
      const mdef = findModel(model);

      if (!base || !key) return sendJson(res, 400, { error: '尚未配置 Base URL / API Key，请打开右上角「设置」' });
      if (!prompt) return sendJson(res, 400, { error: '请输入提示词（Prompt）' });
      if (mode === 'edits' && !(mdef?.supportsEdit)) {
        return sendJson(res, 400, { error: `模型 ${model} 不支持「图像编辑」模式，请使用文生图/图生图` });
      }

      const refs = await loadRefs(body.refIds);
      if (mode === 'edits' && refs.length === 0) {
        return sendJson(res, 400, { error: '图像编辑模式需要至少一张参考图（上传本地图片）' });
      }
      if (mdef && mdef.id === 'flux-kontext-dev' && refs.length === 0) {
        return sendJson(res, 400, { error: 'flux-kontext-dev 必须有参考图，请先添加本地图片' });
      }

      /* GRS（grsai）平台：生图接口只用 size 参数（文档无 aspect_ratio/image_size），全部走 size 分支 */
      const grsStyle = isGrsProvider(base);
      /* GRS 的 nginx 请求体上限实测约 32MB：参考图过大会 413，提前给友好提示 */
      if (grsStyle) {
        const estBytes = Buffer.byteLength(JSON.stringify({ prompt, image: refs.map((r) => r.dataUri) }));
        if (estBytes > 20 * 1024 * 1024) {
          return sendJson(res, 400, {
            error: `参考图过大（约 ${(estBytes / 1048576).toFixed(1)}MB），超出 GRS 平台请求体上限（约 32MB）：请在 GRS 提供商下重新添加参考图（程序会自动压缩到合理尺寸），或减少参考图数量`,
          });
        }
      }

      /* 尺寸：比例 + 分辨率 → 尺寸；再按模型能力适配 */
      const ratio = /^\d+:\d+$/.test(String(body.ratio || '')) ? String(body.ratio) : '1:1';
      const resolution = ['1K', '2K', '4K'].includes(body.resolution) ? body.resolution : '2K';
      const customSize = /^\d{2,4}x\d{2,4}$/.test(String(body.customSize || '').trim())
        ? String(body.customSize).trim() : '';

      let size = '';
      let aspectRatio = '';
      let imageSize = '';
      // GRS 平台的 nano-banana：走专用接口 /v1/api/generate（imageSize=1K/2K/4K 参数控分辨率）
      const grsNb = grsStyle && model.includes('nano-banana');
      // Gemini 生图模型（平台拉取的 gemini-*-image 系列可能带渠道前缀，如 [yu]/[m]/[c]，也可能不在内置目录）
      const isGeminiModel = /gemini-/.test(model);
      // 比例类模型（nano-banana 家族 / grok / flux-kontext / gemini 生图）：直接传比例
      const isRatioModel = isGeminiModel || !!(mdef && Array.isArray(mdef.ratios) && mdef.ratios.length);
      // Nano Banana 家族（含 gemini 生图）：分辨率通过 image_size 参数下发
      const isNanoFamily = isRatioModel && (model.includes('nano-banana') || isGeminiModel);
      if ((isRatioModel && !customSize && !grsStyle) || (grsNb && !customSize)) {
        aspectRatio = ratio;
        if ((isNanoFamily || grsNb) && ['1K', '2K', '4K'].includes(resolution)) imageSize = resolution;
      } else {
        // GPT-Image 系列总像素上限 8,294,400（官方硬限制，超出会被拒）；GRS 网关无此限制（实测 3840x2160 直出）
        const pixelCap = (!grsStyle && /gpt-image/.test(model)) ? 8294400 : undefined;
        const computed = customSize || ratioToSize(ratio, resolution, pixelCap);
        if (mdef && mdef.freeSize) size = computed;                       // 可自由指定（gpt-image-2）
        else if (mdef && Array.isArray(mdef.sizes) && mdef.sizes.length) size = nearestSize(mdef, computed);
        else size = computed;
      }

      const qv = String(body.quality || 'auto').toLowerCase();
      const params = {
        base, key, model, prompt,
        negative: String(body.negative || '').trim(),
        size,
        aspectRatio,
        imageSize,
        n: Math.min(Math.max(Number(body.n) || 1, 1), 8),
        quality: ['low', 'medium', 'high', 'auto'].includes(qv) ? qv : 'auto',
        outputFormat: ['png', 'jpg', 'jpeg', 'webp'].includes(String(body.format || '').toLowerCase())
          ? String(body.format).toLowerCase() : '',
        background: ['transparent', 'white', 'black'].includes(String(body.background || '').toLowerCase())
          ? String(body.background).toLowerCase() : '',
        moderation: ['low', 'none'].includes(String(body.moderation || '').toLowerCase())
          ? String(body.moderation).toLowerCase() : '',
        refs,
      };

      const runner = (p, sig) => {
        if (mode === 'edits') return upstreamEdits(p, sig);
        if (grsStyle && p.model.includes('nano-banana')) return upstreamGrsGenerate(p, sig);
        return upstreamGenerations(p, sig);
      };
      accessLog(`生图任务 · 模型=${model} · 垫图=${refs.length}张 · 提示词=「${prompt.slice(0, 40)}${prompt.length > 40 ? '…' : ''}」 · 尺寸=${params.size || params.aspectRatio || (params.imageSize || '默认')} · 张数=${params.n}`);

      /* 流式模式：出一张回传一张（NDJSON），前端可实时展示进度并中断 */
      if (body.stream === true) {
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        });
        const abortCtl = new AbortController();
        let clientGone = false;
        res.on('close', () => {
          clientGone = true;
          try { abortCtl.abort(); } catch { /* 忽略 */ }
        });
        const sendEvent = (obj) => {
          if (clientGone || res.destroyed || !res.writable) return false;
          try { res.write(JSON.stringify(obj) + '\n'); return true; } catch { return false; }
        };
        const streamT0 = Date.now();
        const files = [];
        const failLog = [];
        try {
          const worker = async () => {
            let myN;
            while ((myN = ++streamIdx - 1) < params.n && !clientGone && !abortCtl.signal.aborted) {
              try {
                const imgs = await runner({ ...params, n: 1 }, abortCtl.signal);
                const img = imgs && imgs[0];
                if (img) {
                  const f = await saveImageToCache(img, { model, idx: myN + 1 });
                  files[myN] = f;
                  sendEvent({ type: 'image', idx: myN, total: params.n, file: f.file, url: f.url });
                }
              } catch (e) {
                if (abortCtl.signal.aborted || clientGone) break;
                failLog.push(`${myN + 1}/${params.n}: ${String(e.message || e)}`);
                accessLog(`生图第 ${myN + 1}/${params.n} 张失败：${String(e.message || e)}`);
                sendEvent({ type: 'fail', idx: myN, total: params.n, error: String(e.message || e) });
              }
            }
          };
          let streamIdx = 0;
          await Promise.all(Array.from({ length: Math.min(3, params.n) }, () => worker()));

          const finished = files.filter(Boolean);
          if (clientGone || abortCtl.signal.aborted) {
            // 前端中断：保留已完成的部分
            if (finished.length) {
              addHistory({
                id: uid(), ts: Date.now(), ms: Date.now() - streamT0,
                model, prompt, negative: params.negative,
                size: params.size || params.aspectRatio, mode,
                refCount: refs.length, status: 'success',
                files: finished,
              });
              accessLog(`生图已中断 · 模型=${model} · 已回传 ${finished.length}/${params.n} 张（部分保留）`);
            }
            try { res.end(); } catch { /* 忽略 */ }
            return;
          }
          if (!finished.length) {
            const msg = failLog.length ? `所有请求都失败了（${failLog.join('；')}）` : '上游未返回任何图片，请更换模型或稍后重试';
            sendEvent({ type: 'error', error: msg });
            addHistory({
              id: uid(), ts: Date.now(), ms: Date.now() - streamT0,
              model, prompt, negative: params.negative,
              size: params.size || params.aspectRatio, mode,
              refCount: refs.length, status: 'error', error: msg, files: [],
            });
            try { res.end(); } catch { /* 忽略 */ }
            return;
          }
          const entry = {
            id: uid(), ts: Date.now(), ms: Date.now() - streamT0,
            model, prompt, negative: params.negative,
            size: params.size || params.aspectRatio, mode,
            refCount: refs.length, status: 'success',
            files: finished,
          };
          addHistory(entry);
          sendEvent({ type: 'done', ok: true, id: entry.id, ms: entry.ms, count: finished.length, files: finished });
          try { res.end(); } catch { /* 忽略 */ }
          return;
        } catch (e) {
          const message = String(e.message || e);
          accessLog(`生图失败（流式） · 模型=${model} · ${message}`);
          if (!clientGone && !res.writableEnded) {
            try {
              res.write(JSON.stringify({ type: 'error', error: message }) + '\n');
              res.end();
            } catch { /* 忽略 */ }
          }
          return;
        }
      }

      /* 张数统一处理：所选张数 > 1 时，一次性并发多次请求（每次 1 张）补齐，
         保证返回张数与选择一致（平台对 n 的支持不稳定，不依赖平台回传数量） */
      let images;
      if (params.n > 1) {
        const CONCURRENCY = 3;
        images = [];
        let idx = 0;
        const worker = async () => {
          while (idx < params.n) {
            const myN = idx++;
            const imgs = await runner({ ...params, n: 1 });
            images[myN] = imgs[0] || null;
          }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, params.n) }, () => worker()));
        images = images.filter(Boolean);
        if (images.length < params.n) {
          accessLog(`张数补齐结果：请求 ${params.n} 张，成功 ${images.length} 张（部分请求失败）`);
        }
      } else {
        images = await runner(params);
      }
      if (!images.length) throw new Error('上游未返回任何图片，请更换模型或稍后重试');

      const files = [];
      for (let i = 0; i < images.length; i++) {
        files.push(await saveImageToCache(images[i], { model, idx: i + 1 }));
      }

      const entry = {
        id: uid(), ts: Date.now(), ms: Date.now() - t0,
        model, prompt, negative: params.negative,
        size: params.size || params.aspectRatio, mode,
        refCount: refs.length, status: 'success',
        files,
      };
      addHistory(entry);
      return sendJson(res, 200, { ok: true, id: entry.id, ms: entry.ms, files });
    } catch (e) {
      const message = String(e.message || e);
      const user = loadUserConfig();
      accessLog(`生图失败 · 模型=${model} · ${message}`);
      addHistory({
        id: uid(), ts: Date.now(), ms: Date.now() - t0,
        model: '', prompt: '', size: '', mode: 'generations',
        refCount: 0, status: 'error', error: message, files: [],
      });
      return sendJson(res, 500, { error: message });
    }
  }

  /* 历史记录 */
  if (api === '/api/history' && req.method === 'GET') {
    return sendJson(res, 200, { items: loadHistory() });
  }
  if (api === '/api/history/clear' && req.method === 'POST') {
    saveHistory([]);
    return sendJson(res, 200, { ok: true });
  }

  /* 画布布局持久化 */
  if (api === '/api/canvas' && req.method === 'GET') {
    return sendJson(res, 200, readJson(CANVAS_FILE, { nodes: [], view: null }));
  }
  if (api === '/api/canvas' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString('utf8') || '{}');
    writeJson(CANVAS_FILE, body);
    return sendJson(res, 200, { ok: true });
  }

  /* 缓存信息 & 打开缓存文件夹 */
  if (api === '/api/cache/info' && req.method === 'GET') {
    const stat = (d) => {
      try {
        let n = 0, bytes = 0;
        for (const f of fs.readdirSync(d)) {
          const s = fs.statSync(path.join(d, f));
          if (s.isFile()) { n++; bytes += s.size; }
        }
        return { n, bytes };
      } catch { return { n: 0, bytes: 0 }; }
    };
    const g = stat(GEN_DIR), u = stat(UPLOAD_DIR), t = stat(THUMB_DIR);
    return sendJson(res, 200, {
      dir: CACHE_DIR, generated: g, uploads: u, thumbs: t,
      totalFiles: g.n + u.n + t.n, totalBytes: g.bytes + u.bytes + t.bytes,
    });
  }

  /* 缩略图上传（前端 canvas 压缩后回传，解决 4K 图在卡片里解码卡顿） */
  if (api === '/api/thumb' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString('utf8') || '{}');
    const id = String(body.id || '');
    const base64 = String(body.base64 || '');
    const m = base64.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/);
    if (!m || !/^(generated|uploads)\/[A-Za-z0-9._-]+$/.test(id)) {
      return sendJson(res, 400, { error: '缩略图参数不合法' });
    }
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length || buf.length > 2 * 1024 * 1024) return sendJson(res, 400, { error: '缩略图过大' });
    const name = id.split('/').pop().replace(/\.[^.]+$/, '') + '.jpg';
    await fsp.writeFile(path.join(THUMB_DIR, name), buf);
    return sendJson(res, 200, { ok: true, url: `/cache/thumbs/${encodeURIComponent(name)}` });
  }

  /* 接入日志（最近 300 行） */
  if (api === '/api/logs' && req.method === 'GET') {
    try {
      const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
      return sendJson(res, 200, { lines: lines.slice(-300) });
    } catch {
      return sendJson(res, 200, { lines: [] });
    }
  }
  if (api === '/api/logs/clear' && req.method === 'POST') {
    try { fs.writeFileSync(LOG_FILE, '', 'utf8'); } catch { /* 忽略 */ }
    return sendJson(res, 200, { ok: true });
  }
  if (api === '/api/cache/open' && req.method === 'POST') {
    const dir = CACHE_DIR;
    const cmd = process.platform === 'win32' ? `explorer.exe "${dir}"` : (process.platform === 'darwin' ? `open "${dir}"` : `xdg-open "${dir}"`);
    try { exec(cmd, { stdio: 'ignore', windowsHide: true }, () => {}); } catch { /* 忽略 */ }
    return sendJson(res, 200, { ok: true, dir });
  }

  /* 聊天模型列表：只返回当前提供商「已勾选」的对话模型 */
  if (api === '/api/chat/models' && req.method === 'GET') {
    const prov = activeProvider();
    return sendJson(res, 200, { models: (prov.selectedChatModels || []).slice() });
  }

  /* Skill 列表（skills 目录下的 .md / .txt，支持 YAML frontmatter 的 name/description） */
  if (api === '/api/skills' && req.method === 'GET') {
    const skills = [];
    try {
      for (const f of fs.readdirSync(SKILLS_DIR)) {
        if (!/\.(md|txt)$/i.test(f)) continue;
        const file = path.join(SKILLS_DIR, f);
        const st = fs.statSync(file);
        if (!st.isFile() || st.size > 1024 * 1024) continue;
        let text = fs.readFileSync(file, 'utf8');
        let name = f.replace(/\.(md|txt)$/i, '');
        let description = '';
        const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
        if (fm) {
          const meta = fm[1];
          const nm = meta.match(/^name:\s*(.+)$/m);
          const ds = meta.match(/^description:\s*(.+)$/m);
          if (nm && nm[1].trim()) name = nm[1].trim();
          if (ds) description = ds[1].trim();
          text = text.slice(fm[0].length);
        }
        skills.push({ id: f, name, description, content: text.trim(), bytes: text.length });
      }
      skills.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    } catch { /* 目录不存在等 */ }
    return sendJson(res, 200, { skills });
  }

  /* GPT 对话（支持流式） */
  if (api === '/api/chat' && req.method === 'POST') {
    const user = loadUserConfig();
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const prov = activeProvider();
    const base = normalizeBase(body.baseUrl || prov.baseUrl);
    const key = String(body.apiKey || prov.apiKey || '').trim();
    const model = String(body.model || 'gpt-4o').trim();
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const stream = body.stream !== false;

    if (!base || !key) return sendJson(res, 400, { error: '尚未配置 Base URL / API Key，请打开右上角「设置」' });
    if (!model) return sendJson(res, 400, { error: '请填写模型名称' });
    if (!messages.length) return sendJson(res, 400, { error: '消息为空' });

    /* 构造上游消息：纯文本 / 文本+图片（image_url dataURI） */
    const upMessages = [];
    /* 挂载 Skill（系统提示词）：放在最前，并过滤历史里残留的 system 角色 */
    const systemText = String(body.system || '').trim();
    const skillName = String(body.skillName || '').trim();
    if (systemText) upMessages.push({ role: 'system', content: systemText });
    let imgCount = 0;
    for (const m of messages) {
      if (m.role === 'system') continue;
      let text = String(m.content || '').trim();
      const refs = Array.isArray(m.images) && m.images.length ? await loadRefs(m.images) : [];
      imgCount += refs.length;
      if (!refs.length) {
        upMessages.push({ role: m.role === 'assistant' || m.role === 'user' || m.role === 'system' ? m.role : 'user', content: text });
      } else {
        /* 只发图没打字时补默认指令，避免平台丢弃空文本导致图片不被识别 */
        if (!text) text = '请看这张图片';
        const parts = [{ type: 'text', text }];
        for (const im of refs) parts.push({ type: 'image_url', image_url: { url: im.dataUri, detail: 'high' } });
        upMessages.push({ role: m.role === 'assistant' || m.role === 'user' || m.role === 'system' ? m.role : 'user', content: parts });
      }
    }
    accessLog(`对话请求 · 模型=${model}${skillName ? ' · 带Skill「' + skillName + '」' : ' · 无Skill'} · 消息 ${messages.length} 条 · 附图 ${imgCount} 张${systemText ? `（系统提示 ${systemText.length} 字）` : ''}`);

    const payload = { model, messages: upMessages, stream };
    if (body.temperature != null && Number.isFinite(Number(body.temperature))) {
      payload.temperature = Math.min(2, Math.max(0, Number(body.temperature)));
    }

    /* GRS 平台请求体上限实测约 32MB（nginx 413）：超限时剥除历史消息附图，仅保留最新一张消息的附图 */
    if (isGrsProvider(base)) {
      const estBytes = () => Buffer.byteLength(JSON.stringify(payload));
      if (estBytes() > 20 * 1024 * 1024) {
        accessLog(`对话请求体过大（约 ${(estBytes() / 1048576).toFixed(1)}MB，GRS），剥除历史附图重试`);
        let lastImgIdx = -1;
        for (let i = upMessages.length - 1; i >= 0; i--) {
          const c = upMessages[i].content;
          if (Array.isArray(c) && c.some((x) => x && x.type === 'image_url')) { lastImgIdx = i; break; }
        }
        if (lastImgIdx >= 0) {
          for (let i = 0; i < upMessages.length; i++) {
            if (i === lastImgIdx) continue;
            const c = upMessages[i].content;
            if (Array.isArray(c)) {
              upMessages[i].content = c.filter((x) => x && x.type === 'text').map((x) => x.text).join('') || '';
            }
          }
        }
        if (estBytes() > 20 * 1024 * 1024) {
          return sendJson(res, 400, {
            error: `对话附图过大（约 ${(estBytes() / 1048576).toFixed(1)}MB），超出 GRS 平台请求体上限（约 32MB）：请减少附图，或在 GRS 提供商下重新添加图片（程序会自动压缩到 2048px 以内）`,
          });
        }
      }
    }

    let upRes;
    try {
      upRes = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(300000),
      });
    } catch (e) {
      accessLog(`对话失败 · 模型=${model}${skillName ? ' · 带Skill「' + skillName + '」' : ''} · 上游请求失败：${e.message}`);
      return sendJson(res, 502, { error: `上游请求失败：${e.message}` });
    }

    if (!upRes.ok) {
      const text = await upRes.text().catch(() => '');
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
      const msg = upstreamErrorMessage(upRes, json, text);
      accessLog(`对话失败 · 模型=${model}${skillName ? ' · 带Skill「' + skillName + '」' : ''} · HTTP ${upRes.status} · ${msg}`);
      return sendJson(res, upRes.status, { error: msg });
    }

    /* 非流式 */
    if (!stream) {
      const json = await upRes.json().catch(() => null);
      const content = json?.choices?.[0]?.message?.content ?? '';
      return sendJson(res, 200, { ok: true, content });
    }

    /* 流式：直接转发上游 SSE */
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let done = false;
    const finish = () => { if (!done) { done = true; res.end(); } };
    req.on('close', () => {
      if (!done) { try { upRes.body.cancel(); } catch { /* ignore */ } finish(); }
    });
    (async () => {
      try {
        const reader = upRes.body.getReader();
        for (;;) {
          const { done: d, value } = await reader.read();
          if (d) break;
          if (value && value.length && !done) res.write(Buffer.from(value));
        }
      } catch (e) {
        if (!done) {
          try { res.write(`data: ${JSON.stringify({ error: String(e.message || e) })}\n\n`); } catch { /* ignore */ }
        }
      }
      finish();
    })();
    return undefined;
  }

  /* 对话窗口持久化 */
  if (api === '/api/chats' && req.method === 'GET') {
    return sendJson(res, 200, { windows: readJson(CHATS_FILE, []) });
  }
  if (api === '/api/chats' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 8 * 1024 * 1024)).toString('utf8') || '{}');
    const windows = Array.isArray(body.windows) ? body.windows : [];
    writeJson(CHATS_FILE, windows);
    return sendJson(res, 200, { ok: true, count: windows.length });
  }

  /* 常用对话库（chat-prompts.json）与 常用提示词库（prompts.json）—— 两套独立存储 */
  const promptLibFile = (kind) => (kind === 'chat' ? CHAT_PROMPTS_FILE : PROMPTS_FILE);
  if (req.method === 'GET' && (api === '/api/prompts' || api === '/api/chat-prompts')) {
    return sendJson(res, 200, { items: readJson(promptLibFile(api === '/api/chat-prompts' ? 'chat' : 'prompt'), []) });
  }
  if (req.method === 'POST' && (api === '/api/prompts' || api === '/api/chat-prompts')) {
    const body = JSON.parse((await readBody(req, 512 * 1024)).toString('utf8') || '{}');
    const name = String(body.name || '').trim();
    const content = String(body.content || '').trim();
    if (!name || !content) return sendJson(res, 400, { error: '名称与内容不能为空' });
    if (name.length > 60) return sendJson(res, 400, { error: '名称最长 60 字' });
    if (content.length > 20000) return sendJson(res, 400, { error: '内容过长（上限 20000 字）' });
    const file = promptLibFile(api === '/api/chat-prompts' ? 'chat' : 'prompt');
    const list = readJson(file, []);
    const exist = list.find((p) => p.name === name);
    if (exist) {
      exist.content = content;
      exist.ts = Date.now();
    } else {
      list.push({ id: uid(), name, content, ts: Date.now() });
    }
    writeJson(file, list);
    return sendJson(res, 200, { ok: true, replaced: !!exist, count: list.length });
  }
  if (req.method === 'POST' && (api === '/api/prompts/delete' || api === '/api/chat-prompts/delete')) {
    const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
    const id = String(body.id || '');
    const file = promptLibFile(api === '/api/chat-prompts/delete' ? 'chat' : 'prompt');
    let list = readJson(file, []);
    const before = list.length;
    list = list.filter((p) => p.id !== id);
    writeJson(file, list);
    return sendJson(res, 200, { ok: true, removed: before - list.length });
  }

  /* ================= Midjourney ================= */

  /** MJ 模式+图片通道 → 路径前缀：
   *  模式：默认 /mj、fast /mj-fast/mj、turbo /mj-turbo/mj、relax /mj-relax/mj
   *  图片通道（国内访问关键）：默认无、relay 转发加速、origin discord 原图、proxy 平台代理
   *  组合：/mj-{mode}-{channel}/mj，如 turbo+relay → /mj-turbo-relay/mj */
  const mjPrefixOf = (mode, channel) => {
    let seg = '';
    const m = String(mode || '');
    const c = String(channel || '');
    if (m && m !== 'default') seg += '-' + m;
    if (c && c !== 'default') seg += '-' + c;
    return seg ? `/mj${seg}/mj` : '/mj';
  };

  /** 轮询 MJ 任务直到完成，返回任务对象（状态字段兼容 top-level / result / data 嵌套） */
  async function pollMjTask(base, prefix, key, taskId) {
    const t0 = Date.now();
    let modalCount = 0;
    let lastStatus = '';
    accessLog(`MJ 开始轮询任务 ${taskId}（${base}${prefix}/task/${taskId}/fetch）`);
    for (;;) {
      if (Date.now() - t0 > 600000) throw new Error('MJ 任务等待超时（10分钟）——任务可能仍在平台排队，可稍后在平台网站查看或再提交一次');
      await new Promise((r) => setTimeout(r, 3000));
      // 查询接口同样带重试：平台高峰 503 时不会立刻失败
      const { res, json } = await requestJsonWithRetry(`${base}${prefix}/task/${encodeURIComponent(taskId)}/fetch`, {
        headers: { Authorization: `Bearer ${key}` },
      }, 30000, 2, `MJ 查询 ${taskId}`);
      if (!res.ok) {
        accessLog(`MJ 查询任务失败 HTTP ${res.status}`);
        throw new Error(upstreamErrorMessage(res, json, ''));
      }
      const task = (json && typeof json.result === 'object' && json.result) || (json && typeof json.data === 'object' && json.data) || json;
      const status = String(task.status || '').toUpperCase();
      if (status !== lastStatus) {
        lastStatus = status;
        accessLog(`MJ 任务 ${taskId} 状态 → ${status}${task.progress ? '（' + task.progress + '）' : ''}${task.failReason ? '，原因：' + task.failReason : ''}`);
      }
      if (status === 'SUCCESS') return task;
      if (status === 'FAILURE') throw new Error(`MJ 任务失败：${task.failReason || '未知原因'}`);
      if (status === 'CANCEL') throw new Error('MJ 任务已被平台取消');
      if (status === 'MODAL') {
        modalCount++;
        if (modalCount >= 3) {
          throw new Error('MJ 任务需要确认（MODAL 弹窗等待）——请到平台网站完成确认后再试');
        }
      }
    }
  }

  /** 提交 MJ 任务（imagine / blend），返回 {task} 或直接返回图片 */
  async function mjSubmit({ base, prefix, key, taskType, prompt, botType, refs, dimensions }) {
    let url;
    let body;
    if (taskType === 'blend') {
      url = `${base}${prefix}/submit/blend`;
      body = { botType: botType || 'MID_JOURNEY', base64Array: refs.map((r) => r.dataUri), dimensions: dimensions || 'SQUARE', notifyHook: '', state: '' };
    } else {
      url = `${base}${prefix}/submit/imagine`;
      body = { prompt, botType: botType || 'MID_JOURNEY', base64Array: refs.map((r) => r.dataUri), notifyHook: '', state: '' };
    }
    const { res, json } = await requestJsonWithRetry(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 60000, 3, `MJ ${taskType}`);

    accessLog(`MJ 提交 ${taskType}（${url}）→ HTTP ${res.status}，code=${json && json.code}`);
    if (!res.ok) throw new Error(upstreamErrorMessage(res, json, ''));
    const code = json && json.code;
    // 1=成功 22=排队 21=窗口等待（MODAL）
    if (code !== 1 && code !== 21 && code !== 22) {
      const msg = json && (json.description || json.message) ? (json.description || json.message) : `未知响应 code=${code}`;
      throw new Error(`MJ 提交失败：${msg}`);
    }
    const taskId = json && json.result;
    if (taskId && typeof taskId === 'string') {
      accessLog(`MJ 提交成功，任务ID=${taskId}，开始等待结果…`);
      const task = await pollMjTask(base, prefix, key, taskId);
      return { task, taskId };
    }
    // 某些平台 Blend 直接返回结果
    if (json && (json.imageUrl || (json.data && json.data.imageUrl))) {
      return { task: { imageUrl: json.imageUrl || json.data.imageUrl, buttons: [] }, taskId: '' };
    }
    throw new Error('MJ 未返回任务或图片');
  }

  /** MJ 动作（U/V/Reroll 等） */
  async function mjAction({ base, prefix, key, taskId, customId, botType }) {
    const url = `${base}${prefix}/submit/action`;
    const { res, json } = await requestJsonWithRetry(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, customId, botType: botType || 'MID_JOURNEY' }),
    }, 60000, 3, 'MJ action');
    accessLog(`MJ 操作提交（${url}，task=${taskId}，customId=${String(customId).slice(0, 50)}）→ HTTP ${res.status}，code=${json && json.code}${json && json.description ? '，' + json.description : ''}`);
    if (!res.ok) throw new Error(upstreamErrorMessage(res, json, ''));
    const code = json && json.code;
    if (code !== 1 && code !== 21 && code !== 22) {
      throw new Error(`MJ 操作失败：${(json && (json.description || json.message)) || `code=${code}`}`);
    }
    const newTaskId = json && json.result;
    if (!newTaskId || typeof newTaskId !== 'string') throw new Error('MJ 操作未返回任务 ID');
    const task = await pollMjTask(base, prefix, key, newTaskId);
    return { task, taskId: newTaskId };
  }

  /** 下载一张 MJ 图片：带鉴权 → 401/403 回退不带，返回 Buffer 或 null */
  async function downloadMjImage(url, key, timeoutMs = 300000) {
    let host = '';
    try { host = new URL(url).hostname; } catch { /* 忽略 */ }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        accessLog(`MJ 下载图片：${host}（${attempt === 0 ? '带鉴权头' : '不带鉴权'}）`);
        const r = await fetch(url, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: attempt === 0 ? { Authorization: `Bearer ${key}` } : {},
        });
        if (!r.ok) {
          if ((r.status === 401 || r.status === 403) && attempt === 0) {
            accessLog(`MJ 图片带鉴权下载被拒（${r.status}），回退为无鉴权重试`);
            continue;
          }
          accessLog(`MJ 图片下载失败（${host}，HTTP ${r.status}）`);
          break;
        }
        const buf = Buffer.from(await r.arrayBuffer());
        if (!buf.length) {
          accessLog(`MJ 图片响应为空（${host}）`);
          break;
        }
        accessLog(`MJ 图片下载完成（${host}，${(buf.length / 1048576).toFixed(2)}MB）`);
        return buf;
      } catch (e) {
        accessLog(`MJ 图片下载失败（${host}，第 ${attempt + 1} 次）：${e.message}`);
      }
      await new Promise((s) => setTimeout(s, 2000));
    }
    return null;
  }

  /** 把 MJ 任务结果落缓存（返回结果数组）：
   *  · 四宫格（带 U/V 按钮且平台给了 4 张 CDN 分块）：直接逐张下载回传（不再拼整图），
   *    U/V 按钮按象限归属（::1::~::4::），无法定位象限的按钮挂第一张；
   *  · 放大/变体等单图（无按钮）：优先 imageUrls[]（CDN 直链，快且稳），失败再退回 imageUrl。 */
  async function cacheMjTask(task, meta, key) {
    const urls = [];
    if (Array.isArray(task.imageUrls)) {
      for (const u of task.imageUrls) {
        const raw = u && typeof u === 'object' ? u.url : u;
        if (typeof raw === 'string' && raw) urls.push(raw);
      }
    }
    const main = typeof task.imageUrl === 'string' && task.imageUrl
      ? task.imageUrl
      : (task.data && typeof task.data.imageUrl === 'string' && task.data.imageUrl);
    const hasButtons = Array.isArray(task.buttons) && task.buttons.length > 0;
    const buttons = (task.buttons || []).map((b) => ({ customId: b.customId, label: b.label, emoji: b.emoji }));

    const makeResult = async (buf, fromUrl, btns) => {
      const ext = extFromUrl(fromUrl || '') || sniffImageExt(buf);
      const name = `mj_${Date.now()}-${(meta.taskType || 'img')}.${ext}`;
      await fsp.writeFile(path.join(GEN_DIR, name), buf);
      return {
        file: path.posix.join('generated', name),
        url: `/cache/generated/${encodeURIComponent(name)}`,
        buttons: btns,
        taskId: meta.taskId || '',
        promptEn: task.promptEn || '',
      };
    };

    /* 四宫格：全部走 CDN，单图单图回传 */
    if (hasButtons && urls.length >= 4) {
      const out = [];
      for (let i = 0; i < 4 && i < urls.length; i++) {
        const buf = await downloadMjImage(urls[i], key, 120000);
        if (!buf) {
          accessLog(`MJ CDN 分块 ${i + 1}/4 下载失败，跳过`);
          continue;
        }
        const mine = buttons.filter((b) => {
          const m = String(b.customId || '').match(/::([1-4])::/);
          return m ? Number(m[1]) === i + 1 : i === 0;
        });
        out.push(await makeResult(buf, urls[i], mine));
      }
      if (out.length) {
        accessLog(`MJ 四宫格 CDN 下载完成：${out.length}/4 张，逐张回传`);
        return out;
      }
      if (main) {
        const b2 = await downloadMjImage(main, key, 300000);
        if (b2) return [await makeResult(b2, main, buttons)];
      }
      throw new Error('下载 MJ 图片失败（CDN 分块与整图均不可用）。若是 discord 域名，可在 MJ 生图区把「图片通道」切换为「转发加速 relay」再试');
    }

    /* 单图（放大/变体 / 无 CDN 分块）：CDN 优先 */
    const ordered = main ? [...urls, main] : urls;
    const seen = new Set();
    for (const url of ordered.filter((u) => (seen.has(u) ? false : (seen.add(u), true)))) {
      const buf = await downloadMjImage(url, key, 300000);
      if (buf) return [await makeResult(buf, url, buttons)];
    }
    throw new Error('下载 MJ 图片失败（所有地址均不可用）。若是 discord 域名，可在 MJ 生图区把「图片通道」切换为「转发加速 relay」再试');
  }

  /* MJ 生图 / 图生图（imagine / blend） */
  if (api === '/api/mj/imagine' && req.method === 'POST') {
    const t0 = Date.now();
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const prov = activeProvider();
      const u = loadUserConfig();
      /* MJ 独立配置优先：地址/Key 与当前提供商无关（留空才回退到提供商） */
      const base = normalizeBase(body.baseUrl || u.mjBaseUrl || prov.mjBaseUrl || prov.baseUrl);
      const key = String(body.apiKey || u.mjApiKey || prov.apiKey || '').trim();
      const prefix = mjPrefixOf(body.mode, body.channel);
      const taskType = body.taskType === 'blend' ? 'blend' : 'imagine';
      const botType = body.botType === 'NIJI_JOURNEY' ? 'NIJI_JOURNEY' : 'MID_JOURNEY';
      const prompt = String(body.prompt || '').trim();

      if (!base || !key) return sendJson(res, 400, { error: '尚未配置 Base URL / API Key，请打开右上角「设置」' });
      const refs = await loadRefs(body.refIds);
      if (taskType === 'blend' && refs.length === 0) {
        return sendJson(res, 400, { error: 'Blend 图生图需要至少一张参考图（垫图）' });
      }
      if (taskType === 'imagine' && !prompt) {
        return sendJson(res, 400, { error: '请输入提示词（Prompt）' });
      }

      /* 拼装 MJ 参数 */
      let fullPrompt = prompt;
      if (body.ar) fullPrompt += ` --ar ${String(body.ar)}`;
      if (body.version) fullPrompt += ` --v ${String(body.version)}`;
      if (body.quality) fullPrompt += ` --q ${String(body.quality)}`;
      if (body.hd) fullPrompt += ' --hd';
      /* --raw 写实模式：提示词里已含 --raw 时不重复添加（避免两个 raw 冲突） */
      if (body.raw) {
        if (/--raw\b/i.test(fullPrompt)) {
          accessLog('MJ 提示词已包含 --raw，跳过重复添加');
        } else {
          fullPrompt += ' --raw';
        }
      }
      if (body.lens) fullPrompt += ` ${String(body.lens)}`;
      if (body.aperture) fullPrompt += ` ${String(body.aperture)}`;

      const { task, taskId } = await mjSubmit({ base, prefix, key, taskType, prompt: fullPrompt, botType, refs, dimensions: body.dimensions });
      const cached = await cacheMjTask(task, { taskType, taskId }, key);
      addHistory({
        id: uid(), ts: Date.now(), ms: Date.now() - t0,
        model: `MJ·${taskType === 'blend' ? 'Blend' : 'Imagine'}${body.mode && body.mode !== 'default' ? `(${body.mode})` : ''}`,
        prompt: prompt, negative: '', size: body.ar || '', mode: 'mj',
        refCount: refs.length, status: 'success',
        files: cached.map((c) => ({ file: c.file, url: c.url })),
      });
      return sendJson(res, 200, {
        ok: true, ms: Date.now() - t0,
        images: cached,
        image: cached[0] || null,
        promptEn: cached[0] ? cached[0].promptEn : '',
      });
    } catch (e) {
      accessLog(`MJ 生图失败 · ${String(e.message || e)}`);
      addHistory({ id: uid(), ts: Date.now(), ms: Date.now() - t0, model: 'MJ', prompt: '', negative: '', size: '', mode: 'mj', refCount: 0, status: 'error', error: String(e.message || e), files: [] });
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }

  /* MJ 动作（U/V/Reroll/Zoom 等） */
  if (api === '/api/mj/action' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const prov = activeProvider();
      const u = loadUserConfig();
      /* MJ 独立配置优先：地址/Key 与当前提供商无关（留空才回退到提供商） */
      const base = normalizeBase(body.baseUrl || u.mjBaseUrl || prov.mjBaseUrl || prov.baseUrl);
      const key = String(body.apiKey || u.mjApiKey || prov.apiKey || '').trim();
      const prefix = mjPrefixOf(body.mode, body.channel);
      if (!base || !key) return sendJson(res, 400, { error: '尚未配置 Base URL / API Key' });
      if (!body.taskId || !body.customId) return sendJson(res, 400, { error: '缺少任务或操作标识' });
      const { task, taskId } = await mjAction({
        base, prefix, key,
        taskId: String(body.taskId),
        customId: String(body.customId),
        botType: body.botType === 'NIJI_JOURNEY' ? 'NIJI_JOURNEY' : 'MID_JOURNEY',
      });
      const cached = await cacheMjTask(task, { taskType: 'action', taskId }, key);
      return sendJson(res, 200, { ok: true, images: cached, image: cached[0] || null });
    } catch (e) {
      accessLog(`MJ 操作失败 · ${String(e.message || e)}`);
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }

  return sendJson(res, 404, { error: `未知接口：${api}` });
}

/* ---------------- 主服务 ---------------- */

function startServer() {
  ensureDirs();
  const cfg = loadServerConfig();

  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = (req.url || '/').split('?')[0];
      if (urlPath.startsWith('/api/')) {
        await handleApi(req, res, urlPath, req.url);
      } else {
        serveStatic(req, res, urlPath);
      }
    } catch (e) {
      if (!res.headersSent) {
        sendJson(res, 400, { error: `请求解析失败：${e.message}` });
      } else {
        res.end();
      }
    }
  });

  /* 端口策略：PORT 环境变量 > config.json > 默认 172；顺序尝试 20 个端口，
     全部不可用则交给系统随机分配一个可用端口（port 0），保证一定能启动 */
  const basePort = Number(process.env.PORT) || Number(cfg.port) || 172;
  const tryPorts = [basePort];
  for (let i = 1; i <= 20; i++) tryPorts.push(basePort + i);

  let started = false;
  server.on('listening', () => {
    if (started) return;
    started = true;
    const addr = server.address();
    const port = (addr && typeof addr === 'object' && addr.port) ? addr.port : 0;
    const url = `http://${cfg.host}:${port}`;
    const line = '='.repeat(58);
    console.log(line);
    console.log('  YexuL Canvas  v' + APP_VERSION);
    console.log(line);
    console.log(`  浏览器地址   ${url}`);
    console.log(`  缓存目录     ${CACHE_DIR}`);
    console.log(`  停止服务     关闭本窗口 或 按 Ctrl+C`);
    console.log(line);
    if (port !== (Number(cfg.port) || 172)) {
      console.log(`  [注意] 默认端口 ${cfg.port || 172} 不可用，已改用 ${port}`);
    }
    if (cfg.autoOpenBrowser !== false) {
      setTimeout(() => {
        const cmd = process.platform === 'win32'
          ? `start "" "${url}"`
          : (process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`);
        try { exec(cmd, { stdio: 'ignore', windowsHide: true }, () => {}); } catch { /* 打不开浏览器不影响服务 */ }
      }, 900);
    }
  });

  let index = 0;
  const attempt = () => {
    if (index >= tryPorts.length) {
      /* 常规端口全被占用：交给系统随机分配一个可用端口 */
      if (index === tryPorts.length) {
        index++;
        console.log(`[提示] ${tryPorts[0]}~${tryPorts[tryPorts.length - 1]} 均不可用，改用系统随机可用端口…`);
        server.listen(0, cfg.host);
        return;
      }
      console.error('[错误] 无法监听任何端口');
      process.exit(1);
    }
    const port = tryPorts[index++];
    server.listen(port, cfg.host);
  };
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' || e.code === 'EACCES') {
      console.log(`[提示] 端口不可用（${e.code}），尝试下一个…`);
      attempt();
    } else {
      console.error('[错误]', e);
      process.exit(1);
    }
  });
  attempt();
}

startServer();
