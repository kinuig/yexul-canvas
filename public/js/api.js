/* ================= API 客户端 ================= */
'use strict';

const API = {
  async req(url, opts = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    let json = null;
    try { json = await res.json(); } catch { /* ignore */ }
    if (!res.ok) {
      const err = new Error((json && json.error) || `请求失败（HTTP ${res.status}）`);
      err.status = res.status;
      err.json = json;
      throw err;
    }
    return json;
  },

  health: () => API.req('/api/health'),
  models: () => API.req('/api/models'),
  configGet: () => API.req('/api/config'),
  configSet: (cfg) => API.req('/api/config', { method: 'POST', body: JSON.stringify(cfg) }),
  testConn: (cfg) => API.req('/api/test', { method: 'POST', body: JSON.stringify(cfg) }),

  generate: (payload) => API.req('/api/generate', { method: 'POST', body: JSON.stringify(payload) }),

  upload: (dataUrl) => API.req('/api/upload', { method: 'POST', body: JSON.stringify({ base64: dataUrl }) }),

  history: () => API.req('/api/history'),
  historyClear: () => API.req('/api/history/clear', { method: 'POST' }),

  promptsGet: (kind) => API.req(kind === 'chat' ? '/api/chat-prompts' : '/api/prompts'),
  promptsSave: (kind, name, content) => API.req(kind === 'chat' ? '/api/chat-prompts' : '/api/prompts', {
    method: 'POST', body: JSON.stringify({ name, content }),
  }),
  promptsDelete: (kind, id) => API.req(kind === 'chat' ? '/api/chat-prompts/delete' : '/api/prompts/delete', {
    method: 'POST', body: JSON.stringify({ id }),
  }),

  canvasGet: () => API.req('/api/canvas'),
  canvasSet: (layout) => API.req('/api/canvas', { method: 'POST', body: JSON.stringify(layout) }),

  cacheInfo: () => API.req('/api/cache/info'),
  cacheOpen: () => API.req('/api/cache/open', { method: 'POST' }),

  logs: () => API.req('/api/logs'),
  logsClear: () => API.req('/api/logs/clear', { method: 'POST' }),
};

/** 读取本地文件为 dataURL */
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('读取文件失败'));
    fr.readAsDataURL(file);
  });
}

/** 复制文本到剪贴板（带降级） */
function copyText(t) {
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).catch(fallback);
  } else {
    fallback();
  }
}

/** 下载 URL 文件 */
function downloadUrl(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name || url.split('/').pop() || 'image.png';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 时间格式化 */
function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
