/* ================= GPT 对话窗口（多开 / 命名 / 流式 / 附图） ================= */
'use strict';

const Chat = {
  windows: [],          // {id, name, model, messages, attach:[], el, wnd:{x,y,w,h}, min, streaming}
  _count: 1,
  _z: 120,
  _lastFocused: null,
  _saveTimer: null,
  layer: null,

  /* ---------- 生命周期 ---------- */
  async init() {
    this.layer = document.getElementById('chat-layer');
    await Promise.all([this._loadModels(), this._loadSkills()]);
  },

  async _loadSkills() {
    try {
      const { skills } = await API.req('/api/skills');
      this._skills = Array.isArray(skills) ? skills : [];
    } catch { this._skills = []; }
    this.refreshSkills();
  },

  /** 刷新所有窗口的 Skill 加载栏 */
  refreshSkills() {
    for (const win of this.windows) this._renderSkills(win);
  },

  /** 渲染单个窗口的 Skill 加载栏（每个 Skill 一个按钮，点击加载/卸载为系统提示词） */
  _renderSkills(win) {
    const bar = win.el.querySelector('.chat-skills');
    if (!bar) return;
    bar.innerHTML = '';
    for (const s of (this._skills || [])) {
      const b = document.createElement('button');
      b.className = 'chat-skill' + (win.skill === s.name ? ' on' : '');
      b.textContent = s.name;
      b.title = s.description
        ? `${s.name}\n${s.description}\n（点击${win.skill === s.name ? '卸载' : '加载'}，作为对话系统提示词）`
        : `${s.name}（点击${win.skill === s.name ? '卸载' : '加载'}）`;
      b.addEventListener('click', () => {
        win.skill = win.skill === s.name ? '' : s.name;
        this._renderSkills(win);
        this.persist();
        App.toast(win.skill ? `已加载 Skill「${s.name}」` : `已卸载 Skill「${s.name}」`, 'ok');
      });
      bar.appendChild(b);
    }
  },

  async _loadModels() {
    try {
      const { models } = await API.req('/api/chat/models');
      this._chatModels = models || [];
    } catch { this._chatModels = []; }
    if (App && App.fillChatModelSelect) App.fillChatModelSelect();
    this.refreshModelSelects();
  },

  /** 默认对话模型：优先已勾选列表（预设已清除） */
  defaultModel() {
    const list = this._chatModels || [];
    const cfg = (App.config && App.config.defaultChatModel) || '';
    if (cfg && list.includes(cfg)) return cfg;
    return list[0] || cfg;
  },

  /** 模型控件 HTML：有勾选列表 → 下拉框（只含勾选模型，与生图区一致）；列表为空 → 可手动输入 */
  _modelControlHtml(win) {
    const list = this._chatModels || [];
    const cur = win.model || '';
    if (!list.length) {
      return `<input class="chat-model" placeholder="模型名（当前没有已勾选的对话模型，可手动输入）" value="${esc(cur)}" title="模型名">`;
    }
    const opts = [...list];
    if (cur && !opts.includes(cur)) opts.push(cur);
    const optsHtml = opts.map((m) => `<option value="${esc(m)}"${m === cur ? ' selected' : ''}>${esc(m)}</option>`).join('');
    return `<select class="chat-model" title="模型（只显示 ⚙ 设置 → 选择模型 中勾选的对话模型）">${optsHtml}</select>`;
  },

  /** 刷新所有已开窗口的模型下拉（勾选变化后调用，无需刷新页面） */
  refreshModelSelects() {
    for (const win of this.windows) {
      const box = win.el && win.el.querySelector('.chat-tools');
      if (!box) continue;
      const old = box.querySelector('.chat-model');
      const tmp = document.createElement('div');
      tmp.innerHTML = this._modelControlHtml(win);
      const neu = tmp.firstChild;
      if (old) old.replaceWith(neu);
      else box.insertBefore(neu, box.firstChild);
    }
  },

  async restoreAll() {
    try {
      const { windows } = await API.req('/api/chats');
      if (windows && windows.length) {
        for (const w of windows) this.create(w, true);
        return windows.length;
      }
    } catch { /* 忽略 */ }
    return 0;
  },

  create(saved, silent) {
    const d = saved || {};
    const win = {
      id: d.id || 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: d.name || `对话 ${this._count++}`,
      model: d.model || this.defaultModel(),
      skill: typeof d.skill === 'string' ? d.skill : '',
      messages: Array.isArray(d.messages) ? d.messages.slice(-200) : [],
      attach: Array.isArray(d.attach) ? d.attach : [],
      wnd: Object.assign({ x: 140 + (this.windows.length % 5) * 46, y: 140 + (this.windows.length % 5) * 36, w: 430, h: 560 }, d.wnd || {}),
      min: !!d.min,
      streaming: false,
    };

    const el = document.createElement('div');
    el.className = 'chat-window' + (win.min ? ' min' : '');
    el.style.left = Math.max(4, Math.min(win.wnd.x, window.innerWidth - 120)) + 'px';
    el.style.top = Math.max(96, Math.min(win.wnd.y, window.innerHeight - 80)) + 'px';
    el.style.width = win.wnd.w + 'px';
    el.style.height = win.wnd.h + 'px';
    el.style.zIndex = ++this._z;
    el.innerHTML = `
      <div class="chat-head" title="按住拖动移动窗口">
        <span class="chat-dot"></span>
        <span class="chat-name">${esc(win.name)}</span>
        <button class="chat-rename-btn" title="修改窗口名字">✎</button>
        <div class="chat-head-actions">
          <button class="chat-min" title="最小化 / 还原">—</button>
          <button class="chat-close" title="关闭窗口">✕</button>
        </div>
      </div>
      <div class="chat-tools">
        ${this._modelControlHtml(win)}
        <button class="chat-img" title="插入图片（画布中的图片可多选 / 本地上传）">🖼</button>
        <button class="chat-clear" title="清空对话">🧹</button>
      </div>
      <div class="chat-skills" title="Skill：点击加载 / 卸载（作为对话系统提示词）"></div>
      <div class="chat-prompts-row">
        <button class="chat-save" title="把当前输入框内容保存为常用对话（自定义名称）">💾 保存消息</button>
        <button class="chat-saved" title="从保存的常用对话中选择并载入输入框">⭐ 选择常用对话</button>
      </div>
      <div class="chat-attach" hidden></div>
      <div class="chat-msgs"></div>
      <div class="chat-input-wrap">
        <textarea class="chat-input" placeholder="输入消息，Enter 发送，Shift+Enter 换行"></textarea>
        <button class="chat-send">发送</button>
      </div>
      <div class="chat-resize" title="拖动调整大小"></div>`;

    win.el = el;
    this.windows.push(win);
    this.layer.appendChild(el);
    this._wire(win);
    this._renderSkills(win);
    this.renderMessages(win, true);
    this.renderAttach(win);
    if (!silent) this.persist();
    this.focus(win);
    return win;
  },

  remove(id) {
    const i = this.windows.findIndex((w) => w.id === id);
    if (i < 0) return;
    const win = this.windows[i];
    try { win._abort && win._abort(); } catch { /* ignore */ }
    win.el.remove();
    this.windows.splice(i, 1);
    this.persist();
    if (!this.windows.length) this.create();
  },

  focus(win) {
    win.el.style.zIndex = ++this._z;
    this._lastFocused = win;
  },

  /** 把画布图片插入到最近使用的对话窗口（没有窗口则自动新建） */
  attachToLast(id) {
    if (!id) return null;
    let win = this._lastFocused || this.windows[this.windows.length - 1];
    if (!win) win = this.create();
    if (!win.attach.includes(id)) win.attach.push(id);
    this.renderAttach(win);
    this.persist();
    this.focus(win);
    App.toast(`图片已插入「${win.name}」的附件区，输入文字后点发送`, 'ok');
    return win;
  },

  toggleMin(win) {
    win.min = !win.min;
    win.el.classList.toggle('min', win.min);
    this.persist();
  },

  /* ---------- 事件 ---------- */
  _wire(win) {
    const el = win.el;
    const q = (s) => el.querySelector(s);

    el.addEventListener('pointerdown', () => this.focus(win));

    /* 拖动（标题栏，指针捕获保证拖动顺畅，窗口可像生图区一样自由移动） */
    const head = q('.chat-head');
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, input')) return;
      e.preventDefault();
      try { head.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
      const sx = e.clientX, sy = e.clientY;
      const ox = el.offsetLeft, oy = el.offsetTop;
      const move = (ev) => {
        win.wnd.x = Math.max(-win.wnd.w + 120, Math.min(ox + ev.clientX - sx, window.innerWidth - 60));
        win.wnd.y = Math.max(96, Math.min(oy + ev.clientY - sy, window.innerHeight - 50));
        el.style.left = win.wnd.x + 'px';
        el.style.top = win.wnd.y + 'px';
      };
      const up = (ev) => {
        try { head.releasePointerCapture(ev.pointerId); } catch { /* 忽略 */ }
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
        head.removeEventListener('pointercancel', up);
        this.persist();
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
      head.addEventListener('pointercancel', up);
    });

    /* 调整大小（右下角） */
    const rz = q('.chat-resize');
    rz.addEventListener('pointerdown', (e) => {
      const sx = e.clientX, sy = e.clientY;
      const ow = el.offsetWidth, oh = el.offsetHeight;
      const move = (ev) => {
        win.wnd.w = Math.max(340, ow + ev.clientX - sx);
        win.wnd.h = Math.max(320, oh + ev.clientY - sy);
        el.style.width = win.wnd.w + 'px';
        el.style.height = win.wnd.h + 'px';
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        this.persist();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      e.preventDefault();
    });

    /* ✎ 修改窗口名字（失焦自动保存，与图片重命名一致） */
    const nameEl = q('.chat-name');
    const startRename = () => {
      if (win.el.querySelector('.chat-rename')) return;
      const input = document.createElement('input');
      input.className = 'chat-rename';
      input.value = win.name;
      input.maxLength = 40;
      nameEl.replaceWith(input);
      input.focus();
      input.select();
      let finished = false;
      const restore = (saved) => {
        if (finished) return;
        finished = true;
        const span = document.createElement('span');
        span.className = 'chat-name';
        span.textContent = saved;
        input.replaceWith(span);
      };
      input.addEventListener('blur', () => {
        const nm = input.value.trim();
        if (nm) win.name = nm;
        restore(win.name);
        this.persist();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); restore(win.name); }
      });
    };
    q('.chat-rename-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      startRename();
    });

    q('.chat-close').addEventListener('click', () => this.remove(win.id));
    q('.chat-min').addEventListener('click', () => this.toggleMin(win));
    q('.chat-clear').addEventListener('click', () => {
      if (confirm(`清空「${win.name}」的全部对话？`)) {
        win.messages = [];
        this.renderMessages(win);
        this.persist();
      }
    });
    /* 模型切换（用事件委托，模型下拉刷新后依然有效） */
    q('.chat-tools').addEventListener('change', (e) => {
      const t = e.target;
      if (t && t.classList && t.classList.contains('chat-model')) {
        win.model = t.value.trim();
        this.persist();
      }
    });

    /* 插入图片（画布多选 / 上传 / 拖入） */
    q('.chat-img').addEventListener('click', async () => {
      const ids = await App.pickImages('插入画布图片到对话（可多选）');
      if (ids && ids.length) {
        const grs = App._activeIsGrs && App._activeIsGrs();
        for (const id of ids) {
          /* GRS 平台请求体小：附图自动压缩后另存 */
          const finalId = grs ? await App.compressCacheToUpload(id) : id;
          if (!win.attach.includes(finalId)) win.attach.push(finalId);
        }
        this.renderAttach(win);
        this.persist();
        this.focus(win);
        App.toast(`已插入 ${ids.length} 张图片${grs ? '（GRS：已自动压缩）' : ''}，输入文字后点发送`, 'ok');
      }
    });

    /* 拖入图片 → 附加 */
    el.addEventListener('dragover', (e) => { e.preventDefault(); });
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
      const grs = App._activeIsGrs && App._activeIsGrs();
      for (const f of files) {
        try {
          let dataUrl = await fileToDataUrl(f);
          if (grs) dataUrl = await App.compressImage(dataUrl, 2048, 0.9);
          const up = await API.upload(dataUrl);
          win.attach.push(up.id);
        } catch (err) { App.toast(`上传失败：${err.message}`, 'err'); }
      }
      this.renderAttach(win);
      this.persist();
      if (grs && files.length) App.toast('（GRS：附图已自动压缩）', 'ok');
    });

    /* 发送 */
    const input = q('.chat-input');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.send(win);
      }
    });
    q('.chat-send').addEventListener('click', () => this.send(win));

    /* 保存消息 / 选择常用对话（独立于生图区提示词库） */
    q('.chat-save').addEventListener('click', () => App.openPromptSave(input.value, 'chat'));
    q('.chat-saved').addEventListener('click', async () => {
      const content = await App.pickPrompt('chat', '⭐ 选择常用对话');
      if (content) {
        input.value = input.value ? `${input.value}\n${content}` : content;
        input.focus();
        App.toast('已载入常用对话内容到输入框', 'ok');
      }
    });
  },

  /* ---------- 消息渲染 ---------- */
  renderAttach(win) {
    const box = win.el.querySelector('.chat-attach');
    box.hidden = !win.attach.length;
    box.innerHTML = '';
    for (const id of win.attach) {
      const name = App.imageNameById(id);
      const t = document.createElement('div');
      t.className = 'chat-attach-item';
      t.innerHTML = `
        <div class="chat-attach-thumb" title="${esc(name)}">
          <img src="/cache/${encodeURI(id)}"><button>✕</button>
        </div>
        <span class="attach-name" title="${esc(name)}">${esc(name)}</span>`;
      const aim = t.querySelector('img');
      aim.loading = 'lazy';
      aim.decoding = 'async';
      App.setThumbImg(aim, id, `/cache/${encodeURI(id)}`);
      aim.addEventListener('click', () => App.openLightbox(`/cache/${encodeURI(id)}`, name || '附加图片'));
      t.querySelector('button').addEventListener('click', () => {
        win.attach = win.attach.filter((x) => x !== id);
        this.renderAttach(win);
        this.persist();
      });
      box.appendChild(t);
    }
  },

  /* ---------- 消息操作（复制 / 引用） ---------- */
  _actsHtml() {
    return '<div class="chat-bubble-acts">'
      + '<button data-act="copy" title="复制这条消息">📋 复制</button>'
      + '<button data-act="quote" title="引用到输入框">❝ 引用</button>'
      + '</div>';
  },

  _wireActs(bubble, win, msg) {
    const acts = bubble.querySelector('.chat-bubble-acts');
    if (!acts) return;
    acts.querySelector('[data-act="copy"]').addEventListener('click', (e) => {
      e.stopPropagation();
      copyText(msg.content || '');
      App.toast('已复制到剪贴板 📋', 'ok');
    });
    acts.querySelector('[data-act="quote"]').addEventListener('click', (e) => {
      e.stopPropagation();
      const input = win.el.querySelector('.chat-input');
      const quote = String(msg.content || '').split('\n').map((l) => `> ${l}`).join('\n');
      if (!quote.trim()) return;
      input.value = input.value ? `${input.value.replace(/\n*$/, '')}\n${quote}` : quote;
      input.focus();
      App.toast('已引用到输入框 ❝', 'ok');
    });
  },

  renderMessages(win, appendOnly) {
    const box = win.el.querySelector('.chat-msgs');
    if (!appendOnly) box.innerHTML = '';
    for (const m of win.messages) {
      if (m._rendered) continue;
      m._rendered = true;
      const row = document.createElement('div');
      row.className = 'chat-msg ' + m.role;
      const body = document.createElement('div');
      body.className = 'chat-bubble';
      if (m.role === 'user' && m.images && m.images.length) {
        const imgs = document.createElement('div');
        imgs.className = 'chat-bubble-imgs';
        for (const id of m.images) {
          const im = document.createElement('img');
          im.src = `/cache/${encodeURI(id)}`;
          im.addEventListener('click', () => App.openLightbox(`/cache/${encodeURI(id)}`, '对话图片'));
          imgs.appendChild(im);
        }
        body.appendChild(imgs);
      }
      if (m.error) {
        body.classList.add('err');
        body.textContent = m.content || m.error;
      } else if (m.role === 'assistant') {
        body.innerHTML = markdownToHtml(m.content || '') + this._actsHtml();
      } else {
        body.innerHTML = esc(m.content || '') + this._actsHtml();
      }
      if (!m.error) this._wireActs(body, win, m);
      row.appendChild(body);
      box.appendChild(row);
    }
    box.scrollTop = box.scrollHeight;
  },

  appendDelta(win, msg, delta) {
    msg.content += delta;
    const box = win.el.querySelector('.chat-msgs');
    let el = msg._el;
    if (!el) {
      el = document.createElement('div');
      el.className = 'chat-msg assistant';
      el.innerHTML = '<div class="chat-bubble streaming"></div>';
      box.appendChild(el);
      msg._el = el;
    }
    el.querySelector('.chat-bubble').textContent = msg.content;
    box.scrollTop = box.scrollHeight;
  },

  finishDelta(win, msg, error) {
    if (error) msg.error = error;
    const box = win.el.querySelector('.chat-msgs');
    if (!msg._el) {
      msg._el = document.createElement('div');
      msg._el.className = 'chat-msg assistant';
      msg._el.innerHTML = '<div class="chat-bubble"></div>';
      box.appendChild(msg._el);
    }
    const bubble = msg._el.querySelector('.chat-bubble');
    bubble.classList.remove('streaming');
    bubble.classList.toggle('err', !!error);
    bubble.innerHTML = error
      ? markdownToHtml(msg.content || '')
      : markdownToHtml(msg.content || '') + this._actsHtml();
    if (!error) this._wireActs(bubble, win, msg);
    box.scrollTop = box.scrollHeight;
    win.streaming = false;
    this.persist();
  },

  /* ---------- 发送 ---------- */
  async send(win) {
    const input = win.el.querySelector('.chat-input');
    const text = input.value.trim();
    if (!text && !win.attach.length) return;
    if (win.streaming) { App.toast('正在生成回复，请稍候', 'err'); return; }

    const userMsg = { role: 'user', content: text, images: win.attach.slice() };
    win.messages.push(userMsg);
    win.attach = [];
    input.value = '';
    this.renderMessages(win);
    this.renderAttach(win);

    const assistantMsg = { role: 'assistant', content: '', _rendered: false };
    win.messages.push(assistantMsg);
    win.streaming = true;

    const history = win.messages.slice(-40).map((m) => ({
      role: m.role,
      content: m.content,
      images: m.images,
    }));

    /* 挂载 Skill：把勾选 Skill 的内容作为系统提示词一并发送 */
    let systemText = '';
    let skillName = '';
    if (win.skill) {
      const s = (this._skills || []).find((x) => x.name === win.skill);
      if (s && s.content) { systemText = s.content; skillName = s.name; }
      else win.skill = '';
    }

    const ac = new AbortController();
    win._abort = () => ac.abort();

    App.logTask('start', `对话 · ${win.model}${skillName ? ' · Skill「' + skillName + '」' : ''} · 「${text.slice(0, 30)}${text.length > 30 ? '…' : ''}」`);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: win.model, messages: history, stream: true, system: systemText, skillName }),
        signal: ac.signal,
      });
      if (!res.ok) {
        let err = `请求失败（HTTP ${res.status}）`;
        try { const j = await res.json(); if (j.error) err = j.error; } catch { /* ignore */ }
        throw new Error(err);
      }
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('text/event-stream')) {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
              const j = JSON.parse(data);
              if (j.error) throw new Error(j.error);
              const delta = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content ?? '';
              if (delta) this.appendDelta(win, assistantMsg, delta);
            } catch (e) {
              if (e && e.message && !(e instanceof SyntaxError)) throw e;
            }
          }
        }
        if (!assistantMsg.content) assistantMsg.content = '（无回复内容）';
        this.finishDelta(win, assistantMsg);
        App.logTask('done', `对话完成 · ${win.model} · ${assistantMsg.content.length} 字`);
      } else {
        const j = await res.json();
        assistantMsg.content = j.content || '';
        this.finishDelta(win, assistantMsg);
        App.logTask('done', `对话完成 · ${win.model} · ${assistantMsg.content.length} 字`);
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
      this.finishDelta(win, assistantMsg, e.message);
      App.logTask('error', `对话失败 · ${win.model} · ${e.message}`);
      if (/API Key|Base URL|鉴权/.test(e.message)) App.hintSettings();
    }
  },

  /* ---------- 持久化 ---------- */
  persist() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.save(), 800);
  },

  async save() {
    clearTimeout(this._saveTimer);
    try {
      await API.req('/api/chats', {
        method: 'POST',
        body: JSON.stringify({
          windows: this.windows.map((w) => ({
            id: w.id, name: w.name, model: w.model, skill: w.skill || '',
            messages: w.messages.map((m) => ({ role: m.role, content: m.content, images: m.images })).slice(-200),
            attach: w.attach, wnd: w.wnd, min: w.min,
          })),
        }),
      });
    } catch { /* 静默 */ }
  },
};

/* ================= 轻量 Markdown 渲染 ================= */
function markdownToHtml(src) {
  let s = esc(String(src || ''));
  const codeBlocks = [];
  /* 提取代码块 */
  s = s.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    const i = codeBlocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`) - 1;
    return `\u0000CODE${i}\u0000`;
  });
  const lines = s.split('\n');
  const out = [];
  let list = null;   // 'ul' | 'ol'
  let para = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.join('<br>')}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (list) { out.push(`</${list}>`); list = null; }
  };
  for (const raw of lines) {
    const line = raw;
    if (!line.trim()) { flushPara(); closeList(); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara(); closeList();
      const lv = Math.min(h[1].length + 2, 6);
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1\s*$/.test(line) || /^\s*[-*_]\s*$/.test(line)) { flushPara(); closeList(); out.push('<hr>'); continue; }
    if (/^\s*&gt;\s?/.test(line)) {
      flushPara(); closeList();
      out.push(`<blockquote>${inline(line.replace(/^\s*&gt;\s?/, ''))}</blockquote>`);
      continue;
    }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const kind = ul ? 'ul' : 'ol';
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    closeList();
    para.push(inline(line));
  }
  flushPara();
  closeList();
  s = out.join('\n');
  /* 回填代码块 */
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (m, i) => codeBlocks[Number(i)]);
  return s;
}

function inline(t) {
  return t
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
