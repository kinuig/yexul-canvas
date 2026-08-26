/* ================= 应用入口 ================= */
'use strict';

const App = {
  defaultModel: 'gpt-image-1',
  modelGroups: [],
  config: {},
  _authHintShown: false,
  lightbox: { src: '', cacheId: '', scale: 1 },
  partitions: {},          // { id: {name, view, nodes} }
  activeId: 'main',
  _canvasSaveTimer: null,
  /* 任务状态与日志 */
  taskRunning: 0,
  _taskStartTs: 0,
  _taskTimer: null,
  taskLog: [],
  _lastTaskLabel: '',
  _serverLogLines: [],
  _serverLogKey: '',
  _serverLogRendered: false,
  _serverLogTimer: null,

  /* ---------- 启动 ---------- */
  async boot() {
    Canvas.init();
    Canvas.onEmptyClick = () => Canvas.select(null);
    Canvas.onSelectionChange = () => {};

    try {
      const [cfg, models] = await Promise.all([API.configGet(), API.models()]);
      this.config = cfg;
      this.modelGroups = models.groups || [];
      NodeFactory.setModels(models.groups);
      if (cfg.defaultModel) this.defaultModel = cfg.defaultModel;
      await this.loadProviders();
      this._fillSettings(cfg);
      this._updateChip();
    } catch (e) {
      this.toast(`初始化失败：${e.message}`, 'err');
    }

    /* 画布分区 */
    await this.loadPartitions();
    this.renderPartitionBar();
    this.importPartition(this.activeId);
    if (!Canvas.nodes.length && this.activeId === 'main') {
      Canvas.resetView();
      const zone = Canvas.newZone(0, 0, { title: '生图区 #1' });
      zone.el.querySelector('.z-prompt').placeholder = '点右上角「＋ 新建生图区」可再新建生图区\n在这里输入提示词，点击「✨ 生成图片」开始';
      this.toast('欢迎使用 YexuL Canvas 🎨 点右上角「＋ 新建生图区」新建生图区，拖入本地图片作为参考图', 'ok');
    }
    Canvas.select(null);

    /* GPT 对话窗口 */
    await Chat.init();
    const chatCount = await Chat.restoreAll();
    if (!chatCount) Chat.create();

    this._bindUI();
    this.refreshHistoryCount();
    this._refreshCacheInfo();
    this._authHintShown = false;

    /* 恢复任务日志 */
    try {
      const saved = localStorage.getItem('yexul_task_log');
      if (saved) this.taskLog = JSON.parse(saved) || [];
    } catch { /* 忽略 */ }
    this._updateTaskChip();
    this._renderTaskLog();
  },

  _createZoneAt(pos) {
    const zone = Canvas.newZone(pos.x, pos.y, {});
    this.toast('已新建生图区，输入提示词后点击「生成」', 'ok');
    return zone;
  },

  /* ---------- 任务状态与日志 ---------- */
  /** 记录任务日志：type = start | done | error | info */
  logTask(type, text) {
    const entry = { ts: Date.now(), type, text };
    this.taskLog.unshift(entry);
    if (this.taskLog.length > 100) this.taskLog.length = 100;
    try { localStorage.setItem('yexul_task_log', JSON.stringify(this.taskLog)); } catch { /* 忽略 */ }
    if (type === 'start') {
      if (this.taskRunning === 0) this._taskStartTs = Date.now();
      this.taskRunning++;
    } else if (type === 'done' || type === 'error') {
      this.taskRunning = Math.max(0, this.taskRunning - 1);
      this._lastTaskLabel = type === 'done' ? '✅ 任务完成' : '❌ 任务失败（点击看日志）';
    }
    this._updateTaskChip();
    const panel = document.getElementById('task-log-panel');
    if (panel && !panel.hidden) this._renderTaskLog();
  },

  _updateTaskChip() {
    const chip = document.getElementById('task-status');
    if (!chip) return;
    if (this.taskRunning > 0) {
      const s = Math.floor((Date.now() - this._taskStartTs) / 1000);
      chip.className = 'chip chip-run';
      chip.innerHTML = `<span class="spin"></span> 生成中${this.taskRunning > 1 ? ` (${this.taskRunning})` : ''} ${s}s`;
      chip.title = '当前任务运行中 · 点击查看日志';
      if (!this._taskTimer) {
        this._taskTimer = setInterval(() => this._updateTaskChip(), 1000);
      }
    } else {
      if (this._taskTimer) { clearInterval(this._taskTimer); this._taskTimer = null; }
      chip.className = 'chip ' + (this._lastTaskLabel.startsWith('❌') ? 'chip-err' : 'chip-ok');
      chip.innerHTML = this._lastTaskLabel || '🟢 空闲';
      chip.title = '点击查看任务日志';
    }
  },

  _renderTaskLog() {
    const box = document.getElementById('task-log-view');
    if (!box) return;
    box.innerHTML = '';
    if (!this.taskLog.length) {
      box.innerHTML = '<div class="task-log-empty">暂无任务记录<br>生图 / 对话任务会实时记录在这里</div>';
      return;
    }
    const icons = { start: '▶', done: '✅', error: '❌', info: 'ℹ️' };
    for (const e of this.taskLog) {
      const row = document.createElement('div');
      row.className = 'task-log-item ' + (e.type || 'info');
      row.textContent = `${fmtTime(e.ts)}  ${icons[e.type] || '·'}  ${e.text}`;
      row.title = e.text;
      box.appendChild(row);
    }
  },

  /** 服务日志视图渲染：连续重复行折叠为 ×N，单行截断，仅在底部时自动滚动 */
  _renderServerLogView() {
    const box = document.getElementById('server-log-view');
    const badge = document.getElementById('server-log-count');
    if (!box) return;
    box.innerHTML = '';
    if (!this._serverLogLines || !this._serverLogLines.length) {
      box.innerHTML = '<div class="task-log-empty">暂无服务端接入日志<br>MJ 提交 / 轮询 / 下载过程会记录在这里</div>';
      if (badge) badge.hidden = true;
      return;
    }
    if (badge) {
      badge.hidden = false;
      badge.textContent = this._serverLogLines.length > 999 ? '999+' : String(this._serverLogLines.length);
    }
    const nearBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
    /* 连续重复行折叠 */
    const groups = [];
    for (const line of this._serverLogLines.slice(-300)) {
      const last = groups[groups.length - 1];
      if (last && last.text === line) last.count++;
      else groups.push({ text: line, count: 1 });
    }
    for (const g of groups) {
      const row = document.createElement('div');
      row.className = 'task-log-item server';
      row.textContent = g.count > 1 ? `${g.text}  ×${g.count}` : g.text;
      row.title = g.text;
      box.appendChild(row);
    }
    if (nearBottom) box.scrollTop = box.scrollHeight;
  },

  /** 拉取服务端接入日志（内容变化才重绘，避免闪烁） */
  async _loadServerLogs() {
    try {
      const { lines } = await API.req('/api/logs');
      const key = lines.length ? `${lines.length}:${lines[lines.length - 1]}` : '0';
      if (key === this._serverLogKey && this._serverLogRendered) return;
      this._serverLogKey = key;
      this._serverLogLines = lines || [];
      this._serverLogRendered = true;
      this._renderServerLogView();
    } catch { /* 忽略 */ }
  },

  _switchTaskLogTab(tab) {
    const taskView = document.getElementById('task-log-view');
    const serverView = document.getElementById('server-log-view');
    const copyBtn = document.getElementById('btn-task-log-copy');
    document.querySelectorAll('.task-log-tab').forEach((b) => {
      b.classList.toggle('on', b.dataset.tab === tab);
    });
    taskView.hidden = tab !== 'task';
    serverView.hidden = tab !== 'server';
    copyBtn.hidden = tab !== 'server';
    if (tab === 'server') {
      this._renderServerLogView();
    }
  },

  /* ---------- 分区管理 ---------- */
  async loadPartitions() {
    let saved = null;
    try { saved = await API.canvasGet(); } catch { /* 忽略 */ }
    if (saved && saved.partitions && typeof saved.partitions === 'object') {
      this.partitions = saved.partitions;
      const keys = Object.keys(this.partitions);
      if (!keys.length) {
        this.partitions.main = { name: '大工作区', view: null, nodes: [] };
      }
      this.activeId = (saved.active && this.partitions[saved.active]) ? saved.active : Object.keys(this.partitions)[0];
    } else {
      /* 迁移旧版平铺结构 */
      this.partitions = {
        main: {
          name: '大工作区',
          view: (saved && saved.view) ? saved.view : null,
          nodes: (saved && saved.nodes) ? saved.nodes : [],
        },
      };
      this.activeId = 'main';
    }
  },

  renderPartitionBar() {
    const bar = document.getElementById('partition-bar');
    bar.innerHTML = '';
    const keys = Object.keys(this.partitions);
    for (const id of keys) {
      const tab = document.createElement('div');
      const isActive = id === this.activeId;
      const realName = this.partitions[id].name || id;
      tab.className = 'ptab' + (isActive ? ' on' : '');
      tab.dataset.id = id;
      tab.title = isActive ? `当前分区（${realName}）· 双击重命名` : `${realName} · 点击切换`;
      const name = document.createElement('span');
      name.className = 'ptab-name';
      name.textContent = isActive ? '当前分区' : realName;
      name.title = '双击重命名';
      tab.appendChild(name);
      if (keys.length > 1) {
        const x = document.createElement('button');
        x.className = 'ptab-x';
        x.textContent = '✕';
        x.title = '删除分区';
        x.addEventListener('click', (e) => { e.stopPropagation(); this.removePartition(id); });
        tab.appendChild(x);
      }
      tab.addEventListener('click', () => { if (!isActive) this.switchPartition(id); });
      name.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this._renamePartitionUI(id, name);
      });
      bar.appendChild(tab);
    }
    const add = document.createElement('button');
    add.className = 'ptab-add';
    add.textContent = '＋ 新建';
    add.title = '新建一个分区';
    add.addEventListener('click', () => this.addPartition());
    bar.appendChild(add);
  },

  addPartition() {
    let n = 1;
    while (this.partitions['p' + n]) n++;
    const id = 'p' + n;
    this.partitions[id] = { name: `分区 ${n}`, view: null, nodes: [] };
    this.switchPartition(id);
    this.toast(`已新建「分区 ${n}」，点页签可切回「大工作区」`, 'ok');
  },

  removePartition(id) {
    const name = this.partitions[id] && this.partitions[id].name;
    if (!confirm(`确认删除分区「${name}」？其中的画布内容将一并删除。`)) return;
    delete this.partitions[id];
    const keys = Object.keys(this.partitions);
    if (!keys.length) {
      this.partitions.main = { name: '大工作区', view: null, nodes: [] };
    }
    if (this.activeId === id) this.importPartition(keys.includes('main') ? 'main' : keys[0]);
    this.renderPartitionBar();
    this.saveCanvasNow();
  },

  _renamePartitionUI(id, nameEl) {
    const input = document.createElement('input');
    input.className = 'ptab-rename';
    input.value = this.partitions[id].name;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    const commit = () => {
      this.partitions[id].name = input.value.trim() || this.partitions[id].name;
      this.renderPartitionBar();
      this.saveCanvasNow();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); commit(); }
    });
  },

  switchPartition(id) {
    if (id === this.activeId) return;
    /* 先导出当前分区，再载入目标分区 */
    if (this.partitions[this.activeId]) this.partitions[this.activeId] = Canvas.exportState();
    this.importPartition(id);
    this.renderPartitionBar();
    this.saveCanvasNow();
  },

  importPartition(id) {
    this.activeId = id;
    const p = this.partitions[id] || { view: null, nodes: [] };
    Canvas.importState(p);
    this.renderPartitionBar();
  },

  /* ---------- 画布持久化（分区结构） ---------- */
  queueCanvasSave() {
    clearTimeout(this._canvasSaveTimer);
    this._canvasSaveTimer = setTimeout(() => this.saveCanvasNow(), 1200);
  },

  async saveCanvasNow() {
    clearTimeout(this._canvasSaveTimer);
    if (!this.partitions || !this.activeId) return;
    this.partitions[this.activeId] = Canvas.exportState();
    try {
      await API.canvasSet({ active: this.activeId, partitions: this.partitions });
    } catch { /* 静默 */ }
  },

  /* ---------- 顶部与全局 UI ---------- */
  _bindUI() {
    document.getElementById('btn-new-zone').addEventListener('click', () => {
      const c = Canvas.viewCenter();
      Canvas.newZone(c.x, c.y, {});
    });
    document.getElementById('btn-mj').addEventListener('click', () => {
      const c = Canvas.viewCenter();
      const z = Canvas.newMjZone(c.x, c.y, {});
      this.toast(`已新建「${z.data.title}」，模式与参数参照 MJ 绘图插件`, 'ok');
    });
    document.getElementById('btn-chat').addEventListener('click', () => {
      const win = Chat.create();
      this.toast(`已打开「${win.name}」，双击标题可重命名`, 'ok');
    });
    document.getElementById('btn-upload').addEventListener('click', () => this._openFilePicker());
    document.getElementById('file-input').addEventListener('change', (e) => {
      this.handleFiles([...e.target.files], Canvas.viewCenter());
      e.target.value = '';
    });

    /* 历史 */
    document.getElementById('btn-history').addEventListener('click', async () => {
      const panel = document.getElementById('history-panel');
      panel.hidden = !panel.hidden;
      if (!panel.hidden) await this.renderHistory();
    });
    document.getElementById('btn-history-close').addEventListener('click', () => {
      document.getElementById('history-panel').hidden = true;
    });
    document.getElementById('btn-history-clear').addEventListener('click', async () => {
      if (!confirm('确认清空全部生成历史？（缓存图片文件会保留在 cache 目录）')) return;
      await API.historyClear();
      this.renderHistory();
      this.toast('历史已清空', 'ok');
    });

    /* 设置 */
    document.getElementById('btn-settings').addEventListener('click', () => this._openSettings());
    document.getElementById('btn-settings-close').addEventListener('click', () => this._closeSettings());
    document.getElementById('modal-mask').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this._closeSettings();
    });
    document.getElementById('btn-settings-save').addEventListener('click', () => this._saveSettings());
    document.getElementById('btn-prov-fetch').addEventListener('click', () => this._fetchProviderFromForm());
    document.getElementById('btn-prov-clear').addEventListener('click', () => this._clearProviderForm());
    document.getElementById('btn-cache-open').addEventListener('click', () => this._openCache());
    document.getElementById('btn-cache').addEventListener('click', () => this._openCache());

    /* 连接状态 chip */
    document.getElementById('conn-chip').addEventListener('click', () => this._openSettings());

    /* 任务状态 chip 与日志面板（双页签） */
    document.getElementById('task-status').addEventListener('click', () => {
      const panel = document.getElementById('task-log-panel');
      panel.hidden = !panel.hidden;
      if (!panel.hidden) {
        this._renderTaskLog();
        this._loadServerLogs();
        clearInterval(this._serverLogTimer);
        this._serverLogTimer = setInterval(() => this._loadServerLogs(), 8000);
      } else {
        clearInterval(this._serverLogTimer);
        this._serverLogTimer = null;
      }
    });
    document.getElementById('btn-task-log-close').addEventListener('click', () => {
      document.getElementById('task-log-panel').hidden = true;
      clearInterval(this._serverLogTimer);
      this._serverLogTimer = null;
    });
    document.querySelectorAll('.task-log-tab').forEach((b) => {
      b.addEventListener('click', () => this._switchTaskLogTab(b.dataset.tab));
    });
    document.getElementById('btn-task-log-clear').addEventListener('click', async () => {
      this.taskLog = [];
      try { localStorage.setItem('yexul_task_log', '[]'); } catch { /* 忽略 */ }
      this._renderTaskLog();
      try { await API.logsClear(); } catch { /* 忽略 */ }
      this._serverLogLines = [];
      this._serverLogKey = '';
      this._renderServerLogView();
      this.toast('任务与服务日志已清空', 'ok');
    });
    document.getElementById('btn-task-log-copy').addEventListener('click', () => {
      const text = (this._serverLogLines || []).join('\n');
      if (!text) { this.toast('暂无服务日志可复制', 'err'); return; }
      copyText(text);
      this.toast(`已复制 ${this._serverLogLines.length} 行服务日志（可直接发给我排查）`, 'ok');
    });
    document.addEventListener('click', (e) => {
      const panel = document.getElementById('task-log-panel');
      if (!panel.hidden && !e.target.closest('#task-log-panel') && !e.target.closest('#task-status')) {
        panel.hidden = true;
        clearInterval(this._serverLogTimer);
        this._serverLogTimer = null;
      }
    });

    /* 缩放 */
    document.getElementById('zoom-in').addEventListener('click', () => {
      const r = Canvas.els.viewport.getBoundingClientRect();
      Canvas.zoomAround(r.left + r.width / 2, r.top + r.height / 2, 1.25);
    });
    document.getElementById('zoom-out').addEventListener('click', () => {
      const r = Canvas.els.viewport.getBoundingClientRect();
      Canvas.zoomAround(r.left + r.width / 2, r.top + r.height / 2, 0.8);
    });
    document.getElementById('zoom-fit').addEventListener('click', () => Canvas.fitView());
    document.getElementById('btn-zoom-reset').addEventListener('click', () => Canvas.resetView());

    /* 图片选择器（多选） */
    document.getElementById('btn-picker-close').addEventListener('click', () => this._closePicker());
    document.getElementById('btn-picker-cancel').addEventListener('click', () => this._closePicker());
    document.getElementById('picker-mask').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this._closePicker();
    });
    document.getElementById('btn-picker-ok').addEventListener('click', () => {
      this._resolvePicker([...this._pickerSel]);
    });
    document.getElementById('btn-picker-upload').addEventListener('click', () => this._uploadFromPicker());

    /* 保存内容 / 常用对话库弹窗 */
    document.getElementById('btn-prompt-save-close').addEventListener('click', () => {
      document.getElementById('prompt-save-mask').hidden = true;
    });
    document.getElementById('btn-prompt-save-cancel').addEventListener('click', () => {
      document.getElementById('prompt-save-mask').hidden = true;
    });
    document.getElementById('prompt-save-mask').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) document.getElementById('prompt-save-mask').hidden = true;
    });
    document.getElementById('btn-prompt-save-ok').addEventListener('click', () => this._doSavePrompt());
    document.getElementById('btn-saved-close').addEventListener('click', () => this._closeSavedModal());

    /* 模型勾选窗口 */
    document.getElementById('btn-model-select-close').addEventListener('click', () => this._closeModelSelect());
    document.getElementById('btn-model-select-cancel').addEventListener('click', () => this._closeModelSelect());
    document.getElementById('model-select-mask').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this._closeModelSelect();
    });
    document.getElementById('btn-model-select-save').addEventListener('click', () => this._saveModelSelect());
    document.querySelectorAll('.model-select-head-btns [data-act]').forEach((b) => {
      b.addEventListener('click', () => {
        const s = this._modelSel;
        if (!s) return;
        const img = b.dataset.act.endsWith('img');
        const all = b.dataset.act.startsWith('all');
        const list = img ? s.imageModels : s.chatModels;
        const set = img ? s.selImg : s.selChat;
        set.clear();
        if (all) list.forEach((m) => set.add(m));
        this._renderModelSelect();
      });
    });
    document.getElementById('saved-mask').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this._closeSavedModal();
    });

    /* 查看器 */
    document.getElementById('btn-lb-close').addEventListener('click', () => this._closeLightbox());
    document.getElementById('btn-lb-download').addEventListener('click', () => {
      if (this.lightbox.src) downloadUrl(this.lightbox.src, (this.lightbox.cacheId || 'image.png').split('/').pop());
    });
    document.getElementById('btn-lb-ref').addEventListener('click', () => {
      this.setRefFromImage(this.lightbox.cacheId, this.lightbox.src);
    });
    const lbStage = document.getElementById('lightbox-stage');
    const lbImg = document.getElementById('lightbox-img');
    const applyLb = () => {
      lbImg.style.transform = `translate(${this.lightbox.tx || 0}px, ${this.lightbox.ty || 0}px) scale(${this.lightbox.scale || 1})`;
    };
    lbStage.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.lightbox.scale = Math.min(8, Math.max(0.5, (this.lightbox.scale || 1) * Math.exp(-e.deltaY * 0.0012)));
      if (this.lightbox.scale <= 1.01) { this.lightbox.tx = 0; this.lightbox.ty = 0; }
      applyLb();
    });
    /* 放大后可拖动平移（竖图放大后上下都能看到） */
    let lbDragging = false, lbSx = 0, lbSy = 0, lbOx = 0, lbOy = 0;
    lbStage.addEventListener('pointerdown', (e) => {
      if ((this.lightbox.scale || 1) <= 1.01) return;
      lbDragging = true;
      lbSx = e.clientX; lbSy = e.clientY;
      lbOx = this.lightbox.tx || 0; lbOy = this.lightbox.ty || 0;
      try { lbStage.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
      lbStage.classList.add('dragging');
      e.preventDefault();
    });
    lbStage.addEventListener('pointermove', (e) => {
      if (!lbDragging) return;
      this.lightbox.tx = lbOx + (e.clientX - lbSx);
      this.lightbox.ty = lbOy + (e.clientY - lbSy);
      applyLb();
    });
    const lbEndDrag = (e) => {
      if (!lbDragging) return;
      lbDragging = false;
      lbStage.classList.remove('dragging');
      try { lbStage.releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
    };
    lbStage.addEventListener('pointerup', lbEndDrag);
    lbStage.addEventListener('pointercancel', lbEndDrag);
    /* 双击复位 */
    lbStage.addEventListener('dblclick', () => {
      this.lightbox.scale = 1; this.lightbox.tx = 0; this.lightbox.ty = 0;
      applyLb();
    });
    document.getElementById('lightbox').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this._closeLightbox();
    });

    /* 画布拖入文件 */
    const vp = document.getElementById('viewport');
    vp.addEventListener('dragover', (e) => {
      if ([...e.dataTransfer.types].includes('Files')) {
        e.preventDefault();
        e.stopPropagation();
        vp.classList.add('drop-hint');
      }
    });
    vp.addEventListener('dragleave', (e) => {
      if (e.target === vp) vp.classList.remove('drop-hint');
    });
    vp.addEventListener('drop', (e) => {
      if (![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      vp.classList.remove('drop-hint');
      const pos = Canvas.screenToWorld(e.clientX, e.clientY);
      this.handleFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/')), pos);
    });

    /* 粘贴图片 */
    window.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) {
        e.preventDefault();
        this.handleFiles(files, Canvas.viewCenter());
      }
    });

    /* 键盘 */
    window.addEventListener('keydown', (e) => {
      const inInput = e.target.closest('input, textarea, select');
      if (e.key === 'Escape') {
        if (!document.getElementById('lightbox').hidden) this._closeLightbox();
        else if (!document.getElementById('picker-mask').hidden) this._closePicker();
        else if (!document.getElementById('prompt-save-mask').hidden) document.getElementById('prompt-save-mask').hidden = true;
        else if (!document.getElementById('saved-mask').hidden) this._closeSavedModal();
        else if (!document.getElementById('model-select-mask').hidden) this._closeModelSelect();
        else if (!document.getElementById('modal-mask').hidden) this._closeSettings();
        else if (!document.getElementById('history-panel').hidden) document.getElementById('history-panel').hidden = true;
        else Canvas.select(null);
      }
      if (inInput) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && Canvas.selectedId) {
        e.preventDefault();
        Canvas.removeNode(Canvas.selectedId);
      }
      if (e.key === ' ' && !e.repeat) {
        Canvas._spaceDown = true;
        Canvas.els.viewport.style.cursor = 'grab';
        e.preventDefault();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        this.saveCanvasNow();
        this.toast('画布布局已保存', 'ok');
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === ' ') {
        Canvas._spaceDown = false;
        Canvas.els.viewport.style.cursor = '';
      }
    });

    /* 页面关闭前保存 */
    window.addEventListener('beforeunload', () => this.saveCanvasNow());

    /* 防止浏览器把文件拖到窗口外直接打开 */
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());
  },

  /* ---------- 上传本地图片插件 ---------- */
  _openFilePicker() {
    document.getElementById('file-input').click();
  },

  async handleFiles(files, worldPos) {
    if (!files.length) return;
    const pos = worldPos || Canvas.viewCenter();
    let i = 0;
    for (const f of files) {
      try {
        const up = await API.upload(await fileToDataUrl(f));
        Canvas.newImage(pos.x + (i % 4) * 30, pos.y + (i % 4) * 30, {
          src: up.url, cacheId: up.id, label: f.name,
        });
        this.toast(`已上传：${f.name}（同时缓存到 cache\\uploads）`, 'ok');
        i++;
      } catch (e) {
        this.toast(`上传失败（${f.name}）：${e.message}`, 'err');
      }
    }
    this._refreshCacheInfo();
  },

  /* ---------- 图片选择器（多选，含全部画布分区） ---------- */
  _pickerResolve: null,
  _pickerSel: new Set(),

  /** 打开多选选择器，返回 Promise<string[]>（cacheId 数组，取消返回 []） */
  pickImages(title) {
    return new Promise((resolve) => {
      this._pickerResolve = resolve;
      this._pickerSel = new Set();
      document.getElementById('picker-title').textContent = title || '选择图片（可多选）';
      document.getElementById('picker-mask').hidden = false;
      this._renderPicker();
    });
  },

  /** 根据 cacheId 查找画布上图片节点的当前名字（重命名后同步） */
  imageNameById(cacheId) {
    if (!cacheId) return '';
    if (this.activeId) this.partitions[this.activeId] = Canvas.exportState();
    for (const pid of Object.keys(this.partitions || {})) {
      const p = this.partitions[pid];
      for (const n of (p && p.nodes) || []) {
        if (n.type === 'image' && n.data && n.data.cacheId === cacheId && n.data.label) return n.data.label;
      }
    }
    return cacheId.split('/').pop() || '图片';
  },

  /** 收集所有分区画布上的图片（图片节点 / 生图结果 / 参考图），携带显示名 */
  collectAllCanvasImageIds() {
    if (this.activeId) this.partitions[this.activeId] = Canvas.exportState();
    const out = [];
    const seen = new Set();
    const add = (id, url, name) => {
      if (id && !seen.has(id)) { seen.add(id); out.push({ id, url, name: name || id.split('/').pop() || '图片' }); }
    };
    /* 第一遍：图片节点（重命名后的名字优先） */
    for (const pid of Object.keys(this.partitions || {})) {
      const p = this.partitions[pid];
      for (const n of (p && p.nodes) || []) {
        if (n.type === 'image' && n.data && n.data.cacheId) add(n.data.cacheId, n.data.src, n.data.label);
      }
    }
    /* 第二遍：生图结果 / MJ 结果 / 参考图（重复的不会再覆盖名字） */
    for (const pid of Object.keys(this.partitions || {})) {
      const p = this.partitions[pid];
      for (const n of (p && p.nodes) || []) {
        if (n.type === 'zone' && n.data) {
          for (const r of n.data.results || []) if (r.file) add(r.file, r.url, '生成图');
          for (const rid of n.data.refIds || []) add(rid, `/cache/${encodeURI(rid)}`, '参考图');
        }
        if (n.type === 'mjzone' && n.data) {
          for (const r of n.data.mjResults || []) if (r.file) add(r.file, r.url, r.label || 'MJ 图');
          for (const rid of n.data.refIds || []) add(rid, `/cache/${encodeURI(rid)}`, '参考图');
        }
      }
    }
    return out;
  },

  _renderPicker() {
    const grid = document.getElementById('picker-grid');
    grid.innerHTML = '';
    const imgs = this.collectAllCanvasImageIds();
    if (!imgs.length) {
      grid.innerHTML = '<div class="picker-empty">画布上还没有图片<br>点击上方「上传本地图片」或先把图片拖到画布上</div>';
      this._updatePickerHint();
      return;
    }
    for (const im of imgs) {
      const item = document.createElement('div');
      item.className = 'picker-item' + (this._pickerSel.has(im.id) ? ' selected' : '');
      item.title = `${im.name}\n${im.id}`;
      item.innerHTML = `<img loading="lazy" decoding="async"><span class="picker-check">✓</span><span class="picker-name">${esc(im.name)}</span>`;
      this.setThumbImg(item.querySelector('img'), im.id, im.url);
      item.addEventListener('click', () => {
        if (this._pickerSel.has(im.id)) this._pickerSel.delete(im.id);
        else this._pickerSel.add(im.id);
        item.classList.toggle('selected', this._pickerSel.has(im.id));
        this._updatePickerHint();
      });
      grid.appendChild(item);
    }
    this._updatePickerHint();
  },

  _updatePickerHint() {
    const n = this._pickerSel.size;
    document.getElementById('picker-selected-hint').textContent = `已选 ${n} 张`;
    const btn = document.getElementById('btn-picker-ok');
    btn.textContent = n ? `插入 ${n} 张` : '插入';
    btn.disabled = !n;
  },

  _resolvePicker(ids) {
    document.getElementById('picker-mask').hidden = true;
    const cb = this._pickerResolve;
    this._pickerResolve = null;
    this._pickerSel = new Set();
    if (cb) cb(ids || []);
  },

  _closePicker() {
    document.getElementById('picker-mask').hidden = true;
    const cb = this._pickerResolve;
    this._pickerResolve = null;
    this._pickerSel = new Set();
    if (cb) cb([]);
  },

  async _uploadFromPicker() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    return new Promise((resolve) => {
      input.onchange = async () => {
        const files = [...input.files].filter((f) => f.type.startsWith('image/'));
        if (!files.length) return resolve(null);
        const c = Canvas.viewCenter();
        let i = 0;
        for (const f of files) {
          try {
            const up = await API.upload(await fileToDataUrl(f));
            Canvas.newImage(c.x + (i % 4) * 30, c.y + (i % 4) * 30, { src: up.url, cacheId: up.id, label: f.name });
            this._pickerSel.add(up.id);
            i++;
          } catch (e) {
            this.toast(`上传失败（${f.name}）：${e.message}`, 'err');
          }
        }
        this._renderPicker();
        this.toast(`已上传 ${i} 张并加入选择`, 'ok');
        resolve(null);
      };
      input.click();
    });
  },

  setRefFromImage(cacheId, src) {
    if (!cacheId) return;
    const zone = Canvas.selectedId ? Canvas.getNode(Canvas.selectedId) : null;
    if (zone && zone.type === 'zone') {
      this.addRefToZone(zone, cacheId).then((compressed) => {
        this.toast(compressed ? '已设为当前生图区的参考图 🎯（GRS：已自动压缩）' : '已设为当前生图区的参考图 🎯', 'ok');
      });
    } else {
      this.toast('请先点选一个「生图区」节点，再点设为参考图', 'err');
    }
  },

  /** 当前激活提供商是否为 GRS（grsai 平台请求体上限小，参考图需压缩） */
  _activeIsGrs() {
    const prov = (this._providers.providers || []).find((x) => x.id === this._providers.active);
    return !!(prov && /grs/i.test(prov.baseUrl || ''));
  },

  /** 用浏览器 canvas 压缩图片：长边 ≤ maxSide，输出 JPEG（白底），返回 dataURL */
  compressImage(src, maxSide = 2048, quality = 0.9) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const w = img.naturalWidth || img.width;
          const h = img.naturalHeight || img.height;
          const scale = Math.min(1, maxSide / Math.max(w, h));
          const cw = Math.max(1, Math.round(w * scale));
          const ch = Math.max(1, Math.round(h * scale));
          const cv = document.createElement('canvas');
          cv.width = cw;
          cv.height = ch;
          const ctx = cv.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, cw, ch);
          ctx.drawImage(img, 0, 0, cw, ch);
          resolve(cv.toDataURL('image/jpeg', quality));
        } catch (e) { reject(e); }
      };
      img.onerror = () => reject(new Error('图片读取失败'));
      img.src = src;
    });
  },

  /** 压缩缓存图片并另存为新上传（GRS 等小请求体平台用），返回新 id；失败返回原 id */
  async compressCacheToUpload(cacheId) {
    try {
      const dataUrl = await this.compressImage(`/cache/${encodeURI(cacheId)}`, 2048, 0.9);
      const up = await API.upload(dataUrl);
      return up && up.id ? up.id : cacheId;
    } catch { return cacheId; }
  },

  /** 给生图区添加参考图：GRS 平台会自动压缩后另存（避免请求体过大被平台 413 拒绝） */
  async addRefToZone(zone, cacheId) {
    const d = zone && zone.data;
    if (!d || !cacheId || d.refIds.includes(cacheId)) return false;
    let id = cacheId;
    let compressed = false;
    if (this._activeIsGrs()) {
      try {
        const dataUrl = await this.compressImage(`/cache/${encodeURI(cacheId)}`, 2048, 0.9);
        const up = await API.upload(dataUrl);
        if (up && up.id) { id = up.id; compressed = true; }
      } catch { /* 压缩失败则用原图 */ }
    }
    if (!d.refIds.includes(id)) d.refIds.push(id);
    NodeFactory.renderRefs(zone);
    Canvas._scheduleSave();
    return compressed;
  },

  /* ---------- 查看器 ---------- */
  openLightbox(src, info) {
    this.lightbox = { src, cacheId: info && info.cacheId ? info.cacheId : this._cacheIdFromSrc(src), scale: 1, tx: 0, ty: 0 };
    const img = document.getElementById('lightbox-img');
    img.src = src;
    img.style.transform = 'translate(0px, 0px) scale(1)';
    document.getElementById('lightbox-info').textContent = info || src.split('/').pop();
    document.getElementById('lightbox').hidden = false;
  },
  _cacheIdFromSrc(src) {
    const m = String(src).match(/^\/cache\/(.+)$/);
    return m ? decodeURIComponent(m[1]) : '';
  },
  _closeLightbox() {
    document.getElementById('lightbox').hidden = true;
    document.getElementById('lightbox-img').src = '';
    this.lightbox = { src: '', cacheId: '', scale: 1, tx: 0, ty: 0 };
  },

  /* ---------- 设置 ---------- */
  /** 填充「默认对话模型」下拉：只含已勾选的对话模型 + 「留空自动」选项 */
  fillChatModelSelect(preferred) {
    const sel = document.getElementById('set-chat-model');
    if (!sel) return;
    const list = (typeof Chat !== 'undefined' && Chat._chatModels) || [];
    const cur = preferred !== undefined ? String(preferred) : sel.value;
    const opts = [...list];
    if (cur && !opts.includes(cur)) opts.push(cur);
    sel.innerHTML = '';
    const o0 = document.createElement('option');
    o0.value = '';
    o0.textContent = '（留空：自动用勾选列表第一个）';
    sel.appendChild(o0);
    for (const m of opts) {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = m;
      sel.appendChild(o);
    }
    sel.value = cur || '';
  },

  _fillSettings(cfg) {
    document.getElementById('set-cache-dir').textContent = cfg.cacheDir || '—';
    this.fillChatModelSelect(cfg.defaultChatModel);
    document.getElementById('set-mj-base').value = cfg.mjBaseUrl || '';
    document.getElementById('set-mj-key').value = cfg.mjApiKey || '';
    const sel = document.getElementById('set-default-model');
    sel.innerHTML = '';
    for (const g of this.modelGroups) {
      const og = document.createElement('optgroup');
      og.label = g.category;
      for (const m of g.models) {
        const o = document.createElement('option');
        o.value = m.id;
        o.textContent = m.name;
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
    sel.value = cfg.defaultModel || this.defaultModel;
    this.renderProviders();
  },

  _openSettings() {
    this._fillSettings(this.config);
    document.getElementById('modal-mask').hidden = false;
    this._refreshCacheInfo();
  },
  _closeSettings() { document.getElementById('modal-mask').hidden = true; },

  async _saveSettings() {
    const defaultModel = document.getElementById('set-default-model').value;
    const defaultChatModel = document.getElementById('set-chat-model').value.trim();
    const mjBaseUrl = document.getElementById('set-mj-base').value.trim();
    const mjApiKey = document.getElementById('set-mj-key').value.trim();
    try {
      await API.configSet({ defaultModel, defaultChatModel, mjBaseUrl, mjApiKey });
      this.config = { ...this.config, defaultModel, defaultChatModel, mjBaseUrl, mjApiKey };
      this.defaultModel = defaultModel;
      this.toast('设置已保存 ✅（含 MJ 独立配置）', 'ok');
    } catch (e) {
      this.toast(`保存失败：${e.message}`, 'err');
    }
  },

  /* ---------- API 提供商 ---------- */
  _providers: { active: '', providers: [] },
  _editingProviderId: '',

  async loadProviders() {
    try {
      this._providers = await API.req('/api/providers');
    } catch { /* 忽略 */ }
  },

  renderProviders() {
    const box = document.getElementById('provider-list');
    if (!box) return;
    box.innerHTML = '';
    const { active, providers } = this._providers;
    if (!providers.length) {
      box.innerHTML = '<div class="provider-empty">还没有保存的提供商，在下方填写 Base URL 与 API Key 后点「测试连接并拉取模型」</div>';
      return;
    }
    for (const p of providers) {
      const row = document.createElement('div');
      const isActive = p.id === active;
      row.className = 'provider-row' + (isActive ? ' on' : '');
      const imgN = (p.imageModels || []).length;
      const chatN = (p.chatModels || []).length;
      const selImgN = (p.selectedImageModels || []).length;
      const selChatN = (p.selectedChatModels || []).length;
      row.innerHTML = `
        <div class="provider-info">
          <div class="provider-name">${isActive ? '● ' : ''}${esc(p.name)}${isActive ? '（当前使用）' : ''}</div>
          <div class="provider-meta">${esc(p.baseUrl)} · 已选 ${selImgN}/${imgN} 生图 · ${selChatN}/${chatN} 对话${p.fetchedAt ? ' · 已拉取' : ''}</div>
        </div>
        <div class="provider-actions">
          <button class="btn btn-mini" data-act="models" title="勾选要使用的模型（未勾选的不显示）">🗂 选择模型</button>
          ${isActive ? '' : '<button class="btn btn-mini" data-act="use">使用</button>'}
          <button class="btn btn-mini btn-ghost" data-act="fetch" title="重新拉取该平台的生图/对话模型">🔄</button>
          <button class="btn btn-mini btn-ghost" data-act="edit" title="编辑该提供商">✎</button>
          <button class="btn btn-mini btn-ghost" data-act="del" title="删除">✕</button>
        </div>`;
      row.querySelector('[data-act="use"]')?.addEventListener('click', () => this.useProvider(p.id));
      row.querySelector('[data-act="models"]').addEventListener('click', () => this.openModelSelect(p.id));
      row.querySelector('[data-act="fetch"]').addEventListener('click', () => this.fetchProvider(p.id));
      row.querySelector('[data-act="edit"]').addEventListener('click', () => this.editProvider(p));
      row.querySelector('[data-act="del"]').addEventListener('click', () => this.deleteProvider(p.id));
      box.appendChild(row);
    }
  },

  editProvider(p) {
    this._editingProviderId = p.id;
    document.getElementById('prov-name').value = p.name || '';
    document.getElementById('prov-baseurl').value = p.baseUrl || '';
    document.getElementById('prov-apikey').value = p.apiKey || '';
    document.getElementById('btn-prov-fetch').textContent = '🔌 更新并重新拉取模型';
  },

  _clearProviderForm() {
    this._editingProviderId = '';
    document.getElementById('prov-name').value = '';
    document.getElementById('prov-baseurl').value = '';
    document.getElementById('prov-apikey').value = '';
    document.getElementById('btn-prov-fetch').textContent = '🔌 测试连接并拉取模型';
    document.getElementById('prov-result').textContent = '';
  },

  async _fetchProviderFromForm() {
    const el = document.getElementById('prov-result');
    const btn = document.getElementById('btn-prov-fetch');
    el.className = 'field-hint';
    el.textContent = '正在连接并拉取模型…';
    btn.disabled = true;
    try {
      const res = await API.req('/api/providers/fetch', {
        method: 'POST',
        body: JSON.stringify({
          id: this._editingProviderId,
          name: document.getElementById('prov-name').value,
          baseUrl: document.getElementById('prov-baseurl').value,
          apiKey: document.getElementById('prov-apikey').value,
        }),
      });
      if (!res.ok) {
        el.className = 'field-hint err';
        el.textContent = `❌ ${res.error || '拉取失败'}`;
        return;
      }
      el.className = 'field-hint ok';
      el.textContent = `✅ ${res.message}`;
      this._clearProviderForm();
      await this.loadProviders();
      this.renderProviders();
      await this.refreshModelsAfterProviderChange();
      this._updateChip();
      this.toast(res.message, 'ok');
      /* 拉取成功后自动弹出模型勾选窗口 */
      if (res.ok && res.id && (res.imageCount > 0 || res.chatCount > 0)) {
        this.openModelSelect(res.id);
      }
    } catch (e) {
      el.className = 'field-hint err';
      el.textContent = `❌ ${e.message}`;
    } finally {
      btn.disabled = false;
    }
  },

  async useProvider(id) {
    try {
      await API.req('/api/providers/use', { method: 'POST', body: JSON.stringify({ id }) });
      await this.loadProviders();
      this.renderProviders();
      await this.refreshModelsAfterProviderChange();
      this._updateChip();
      const p = (this._providers.providers || []).find((x) => x.id === id);
      this.toast(`已切换到「${p ? p.name : id}」（界面已自动刷新）`, 'ok');
    } catch (e) {
      this.toast(`切换失败：${e.message}`, 'err');
    }
  },

  async fetchProvider(id) {
    try {
      const res = await API.req('/api/providers/fetch', { method: 'POST', body: JSON.stringify({ id }) });
      if (!res.ok) { this.toast(res.error || '拉取失败', 'err'); return; }
      await this.loadProviders();
      this.renderProviders();
      await this.refreshModelsAfterProviderChange();
      this.toast(res.message, 'ok');
    } catch (e) {
      this.toast(`拉取失败：${e.message}`, 'err');
    }
  },

  async deleteProvider(id) {
    const p = (this._providers.providers || []).find((x) => x.id === id);
    if (!confirm(`删除提供商「${p ? p.name : id}」？`)) return;
    try {
      await API.req('/api/providers/delete', { method: 'POST', body: JSON.stringify({ id }) });
      await this.loadProviders();
      this.renderProviders();
      await this.refreshModelsAfterProviderChange();
      this._updateChip();
    } catch (e) {
      this.toast(`删除失败：${e.message}`, 'err');
    }
  },

  /** 提供商变化后：刷新生图模型目录、各生图区下拉、对话模型列表 */
  async refreshModelsAfterProviderChange() {
    try {
      const { groups } = await API.models();
      this.modelGroups = groups || [];
      NodeFactory.setModels(groups);
      NodeFactory.rebuildZoneModelSelects();
      await Chat._loadModels();
      const sel = document.getElementById('set-default-model');
      if (sel) {
        const cur = sel.value;
        sel.innerHTML = '';
        for (const g of this.modelGroups) {
          const og = document.createElement('optgroup');
          og.label = g.category;
          for (const m of g.models) {
            const o = document.createElement('option');
            o.value = m.id;
            o.textContent = m.name;
            og.appendChild(o);
          }
          sel.appendChild(og);
        }
        sel.value = this.modelGroups.some((g) => g.models.some((m) => m.id === cur)) ? cur : (this.config.defaultModel || 'gpt-image-1');
      }
    } catch { /* 忽略 */ }
  },

  _updateChip() {
    const chip = document.getElementById('conn-chip');
    const prov = (this._providers.providers || []).find((x) => x.id === this._providers.active);
    const has = !!(prov && prov.apiKey);
    chip.className = 'chip ' + (has ? 'chip-ok' : 'chip-warn');
    chip.textContent = has ? `API · ${prov.name}` : '未配置 API · 点击设置';
    chip.title = has ? `${prov.baseUrl} · 点击打开设置` : '点击添加 API 提供商';
  },

  hintSettings() {
    if (this._authHintShown) return;
    this._authHintShown = true;
    setTimeout(() => this._openSettings(), 800);
  },

  /* ---------- 缓存 ---------- */
  async _openCache() {
    try {
      const res = await API.cacheOpen();
      this.toast(`已打开缓存目录：${res.dir}`, 'ok');
    } catch (e) {
      this.toast(`打开失败：${e.message}`, 'err');
    }
  },

  async _refreshCacheInfo() {
    try {
      const info = await API.cacheInfo();
      const el = document.getElementById('set-cache-info');
      if (el) el.textContent = `生成图 ${info.generated.n} 张（${fmtBytes(info.generated.bytes)}） · 上传图 ${info.uploads.n} 张（${fmtBytes(info.uploads.bytes)}）`;
    } catch { /* 忽略 */ }
  },

  /* ---------- 常用对话库 / 常用提示词库（两套独立存储） ---------- */
  _promptSaveContent: '',
  _promptSaveKind: 'prompt',
  _savedCallback: null,
  _savedKind: 'prompt',

  /** 打开「保存内容」弹窗（kind: chat=保存消息 / prompt=保存提示词） */
  openPromptSave(content, kind) {
    const text = String(content || '').trim();
    if (!text) { this.toast('请先输入内容再保存', 'err'); return; }
    this._promptSaveContent = text;
    this._promptSaveKind = kind === 'chat' ? 'chat' : 'prompt';
    document.getElementById('prompt-save-title').textContent =
      this._promptSaveKind === 'chat' ? '💾 保存消息（常用对话）' : '💾 保存提示词（常用提示词）';
    document.getElementById('prompt-save-preview').textContent = text.length > 400 ? `${text.slice(0, 400)}…` : text;
    const inp = document.getElementById('prompt-save-name');
    inp.value = text.replace(/\s+/g, ' ').slice(0, 20);
    document.getElementById('prompt-save-mask').hidden = false;
    inp.focus();
    inp.select();
  },

  async _doSavePrompt() {
    const name = document.getElementById('prompt-save-name').value.trim();
    const content = this._promptSaveContent;
    if (!name) { this.toast('请给内容起个名字', 'err'); return; }
    try {
      const res = await API.promptsSave(this._promptSaveKind, name, content);
      document.getElementById('prompt-save-mask').hidden = true;
      this._promptSaveContent = '';
      const label = this._promptSaveKind === 'chat' ? '常用对话' : '常用提示词';
      this.toast(res.replaced ? `已更新「${name}」` : `已保存到${label}：「${name}」`, 'ok');
    } catch (e) {
      this.toast(`保存失败：${e.message}`, 'err');
    }
  },

  /** 打开常用库选择器（kind: chat=常用对话 / prompt=常用提示词），返回 Promise<string|null> */
  pickPrompt(kind, title) {
    return new Promise((resolve) => {
      this._savedCallback = resolve;
      this._savedKind = kind === 'chat' ? 'chat' : 'prompt';
      document.getElementById('saved-title').textContent =
        title || (this._savedKind === 'chat' ? '⭐ 选择常用对话' : '📂 选择常用提示词');
      document.getElementById('saved-mask').hidden = false;
      this._renderSavedList();
    });
  },

  async _renderSavedList() {
    const list = document.getElementById('saved-list');
    const isChat = this._savedKind === 'chat';
    try {
      const { items } = await API.promptsGet(this._savedKind);
      list.innerHTML = '';
      if (!items.length) {
        list.innerHTML = `<div class="picker-empty">还没有保存的内容<br>${isChat ? '在对话窗口点「保存消息」即可存到这里' : '在生图区点「保存当前提示词」即可存到这里'}</div>`;
        return;
      }
      items.sort((a, b) => b.ts - a.ts);
      for (const it of items) {
        const row = document.createElement('div');
        row.className = 'saved-item';
        row.innerHTML = `<div class="saved-info">
            <div class="saved-name">${esc(it.name)}</div>
            <div class="saved-preview">${esc(it.content).slice(0, 100)}${it.content.length > 100 ? '…' : ''}</div>
          </div>
          <button class="saved-del" title="删除">✕</button>`;
        row.addEventListener('click', (e) => {
          if (e.target.closest('.saved-del')) return;
          this._closeSaved(it.content);
        });
        row.querySelector('.saved-del').addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm(`删除「${it.name}」？`)) return;
          await API.promptsDelete(this._savedKind, it.id);
          this._renderSavedList();
          this.toast(`已删除「${it.name}」`, 'ok');
        });
        list.appendChild(row);
      }
    } catch (e) {
      list.innerHTML = `<div class="picker-empty">加载失败：${esc(e.message)}</div>`;
    }
  },

  _closeSaved(content) {
    document.getElementById('saved-mask').hidden = true;
    const cb = this._savedCallback;
    this._savedCallback = null;
    if (cb) cb(content);
  },

  _closeSavedModal() {
    document.getElementById('saved-mask').hidden = true;
    const cb = this._savedCallback;
    this._savedCallback = null;
    if (cb) cb(null);
  },

  /* ---------- 缩略图（4K 大图卡片展示性能优化） ---------- */
  _thumbCache: new Map(),

  /** 生成/获取缩略图 URL：浏览器 canvas 压缩后上传服务端缓存 */
  async ensureThumb(file, url) {
    if (!file || !url) return url;
    if (this._thumbCache.has(file)) {
      const v = this._thumbCache.get(file);
      return v === false ? url : v;
    }
    const thumbUrl = `/cache/thumbs/${file.split('/').pop().replace(/\.[^.]+$/, '')}.jpg`;
    try {
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error('load fail'));
        im.src = url;
      });
      const MAX = 384;
      const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * scale));
      c.height = Math.max(1, Math.round(img.naturalHeight * scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const dataUrl = c.toDataURL('image/jpeg', 0.8);
      await API.req('/api/thumb', { method: 'POST', body: JSON.stringify({ id: file, base64: dataUrl }) });
      this._thumbCache.set(file, thumbUrl);
      return thumbUrl;
    } catch {
      this._thumbCache.set(file, false);
      return url;
    }
  },

  /** 给图片元素设置 src，并异步换成缩略图（避免大图解码卡顿） */
  setThumbImg(imgEl, file, url, onDone) {
    if (!imgEl) return;
    imgEl.src = url;
    if (!file) return;
    this.ensureThumb(file, url).then((t) => {
      if (t && t !== url && imgEl.isConnected) imgEl.src = t;
      if (onDone) onDone(t);
    });
  },

  /* ---------- 模型勾选窗口 ---------- */
  _modelSel: null,   // {id, imageModels:[], chatModels:[], selImg:Set, selChat:Set}

  openModelSelect(providerId) {
    const p = (this._providers.providers || []).find((x) => x.id === providerId);
    if (!p) return;
    if (!(p.imageModels || []).length && !(p.chatModels || []).length) {
      this.toast('该提供商还没有拉取过模型，请先点「测试连接并拉取模型」', 'err');
      return;
    }
    this._modelSel = {
      id: p.id,
      imageModels: (p.imageModels || []).slice(),
      chatModels: (p.chatModels || []).slice(),
      selImg: new Set(p.selectedImageModels || p.imageModels || []),
      selChat: new Set(p.selectedChatModels || p.chatModels || []),
    };
    /* 收起设置界面，让选择模型窗口独立显示；关闭后再恢复设置界面 */
    this._settingsWasOpen = !document.getElementById('modal-mask').hidden;
    document.getElementById('modal-mask').hidden = true;
    document.getElementById('model-select-title').textContent = `选择要使用的模型 · ${p.name}`;
    document.getElementById('model-select-mask').hidden = false;
    this._renderModelSelect();
  },

  _renderModelSelect() {
    const s = this._modelSel;
    if (!s) return;
    const fill = (box, models, selSet) => {
      box.innerHTML = '';
      if (!models.length) {
        box.innerHTML = '<div class="picker-empty">该分类没有拉取到模型</div>';
        return;
      }
      for (const m of models) {
        const label = document.createElement('label');
        label.className = 'model-check' + (selSet.has(m) ? ' on' : '');
        label.innerHTML = `<input type="checkbox" ${selSet.has(m) ? 'checked' : ''}><span>${esc(m)}</span>`;
        label.querySelector('input').addEventListener('change', (e) => {
          if (e.target.checked) selSet.add(m);
          else selSet.delete(m);
          label.classList.toggle('on', e.target.checked);
          this._updateModelSelectHint();
        });
        box.appendChild(label);
      }
    };
    fill(document.getElementById('ms-image-list'), s.imageModels, s.selImg);
    fill(document.getElementById('ms-chat-list'), s.chatModels, s.selChat);
    this._updateModelSelectHint();
  },

  _updateModelSelectHint() {
    const s = this._modelSel;
    if (!s) return;
    document.getElementById('ms-hint').textContent = `已勾选：生图 ${s.selImg.size}/${s.imageModels.length} · 对话 ${s.selChat.size}/${s.chatModels.length}（未勾选的不会显示在生图区/对话下拉）`;
  },

  _closeModelSelect() {
    document.getElementById('model-select-mask').hidden = true;
    this._modelSel = null;
    if (this._settingsWasOpen) {
      document.getElementById('modal-mask').hidden = false;
      this._settingsWasOpen = false;
    }
  },

  async _saveModelSelect() {
    const s = this._modelSel;
    if (!s) return;
    try {
      await API.req('/api/providers/select', {
        method: 'POST',
        body: JSON.stringify({
          id: s.id,
          imageModels: [...s.selImg],
          chatModels: [...s.selChat],
        }),
      });
      this._closeModelSelect();
      await this.loadProviders();
      this.renderProviders();
      await this.refreshModelsAfterProviderChange();
      this.toast('模型选择已保存，生图区/对话下拉已刷新', 'ok');
    } catch (e) {
      this.toast(`保存失败：${e.message}`, 'err');
    }
  },

  /* ---------- 历史 ---------- */
  async refreshHistoryCount() {
    try {
      const { items } = await API.history();
      const badge = document.getElementById('history-count');
      badge.hidden = !items.length;
      badge.textContent = items.length > 99 ? '99+' : String(items.length);
    } catch { /* 忽略 */ }
  },

  async renderHistory() {
    const list = document.getElementById('history-list');
    try {
      const { items } = await API.history();
      list.innerHTML = '';
      if (!items.length) {
        list.innerHTML = '<div class="hist-empty">还没有生成记录<br>在生图区输入提示词开始创作吧</div>';
        return;
      }
      for (const it of items) {
        const item = document.createElement('div');
        item.className = 'hist-item' + (it.status === 'error' ? ' err' : '');
        const thumb = (it.files && it.files[0])
          ? `<img src="${esc(it.files[0].url)}" loading="lazy">`
          : (it.status === 'error' ? '<span class="noimg">❌</span>' : '<span class="noimg">🖼</span>');
        item.innerHTML = `
          <div class="hist-thumb">${thumb}</div>
          <div class="hist-info">
            <div class="hist-model">${it.status === 'error' ? '生成失败' : esc(it.model || '')}</div>
            <div class="hist-prompt">${it.status === 'error' ? esc(it.error || '未知错误') : esc(it.prompt || '(无提示词)')}</div>
            <div class="hist-meta">
              <span>${fmtTime(it.ts)}</span>
              ${it.size ? `<span>${esc(it.size)}</span>` : ''}
              ${it.refCount ? `<span>🎯x${it.refCount}</span>` : ''}
              ${it.status === 'success' ? `<span>${((it.ms || 0) / 1000).toFixed(0)}s</span>` : ''}
            </div>
            ${it.status === 'success' ? `<div class="hist-actions">
              <button class="btn btn-mini" data-act="place">⤢ 放到画布</button>
              <button class="btn btn-mini" data-act="dl">⬇ 下载</button>
            </div>` : ''}
          </div>`;
        if (it.status === 'success' && it.files && it.files.length) {
          const him = item.querySelector('.hist-thumb img');
          if (him) {
            him.decoding = 'async';
            this.setThumbImg(him, it.files[0].file, it.files[0].url);
          }
          item.querySelector('.hist-thumb').addEventListener('click', () =>
            App.openLightbox(it.files[0].url, `${it.model} · ${fmtTime(it.ts)}`));
          item.querySelector('[data-act="place"]').addEventListener('click', () => {
            const c = Canvas.viewCenter();
            it.files.forEach((f, i) => {
              Canvas.newImage(c.x + (i % 4) * 30, c.y + (i % 4) * 30, {
                src: f.url, cacheId: f.file, label: '历史生成图',
              });
            });
            this.toast(`已把 ${it.files.length} 张图放到画布`, 'ok');
          });
          item.querySelector('[data-act="dl"]').addEventListener('click', () => {
            it.files.forEach((f, i) => setTimeout(() => downloadUrl(f.url, f.file.split('/').pop()), i * 350));
          });
        }
        list.appendChild(item);
      }
    } catch (e) {
      list.innerHTML = `<div class="hist-empty">历史加载失败：${esc(e.message)}</div>`;
    }
  },

  /* ---------- Toast ---------- */
  toast(msg, kind) {
    const box = document.getElementById('toasts');
    const t = document.createElement('div');
    t.className = 'toast ' + (kind || '');
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 260);
    }, 3600);
    while (box.children.length > 4) box.firstChild.remove();
  },
};

document.addEventListener('DOMContentLoaded', () => App.boot());
