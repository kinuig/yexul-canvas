/* ================= 无限画布引擎 =================
 * 坐标体系：world（画布世界坐标）与 screen（视口坐标）
 * world = (screen - pan) / zoom
 */
'use strict';

const Canvas = {
  zoom: 1,
  panX: 0,
  panY: 0,
  minZoom: 0.08,
  maxZoom: 4,
  nodes: [],               // {id, type, x, y, el, data}
  selectedId: null,
  selectedIds: new Set(),  // 多选集合（框选 / 全选）
  els: {},
  _saveTimer: null,
  onEmptyClick: null,
  onSelectionChange: null,

  /* ---------- 初始化 ---------- */
  init() {
    this.els.root = document.getElementById('canvas-root');
    this.els.viewport = document.getElementById('viewport');
    this.els.hint = document.getElementById('empty-hint');

    const vp = this.els.viewport;

    /* 框选矩形 */
    this.els.marquee = document.createElement('div');
    this.els.marquee.id = 'marquee';
    vp.appendChild(this.els.marquee);

    vp.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    vp.addEventListener('pointermove', (e) => this._onPointerMove(e));
    window.addEventListener('pointerup', (e) => this._onPointerUp(e));
    vp.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    window.addEventListener('resize', () => this.applyView());

    /* 批量删除 / 全选 / 取消选择 */
    window.addEventListener('keydown', (e) => {
      if (e.target && e.target.closest && e.target.closest('input, textarea, select')) return;
      const modalOpen = document.querySelector('#modal-mask:not([hidden]), #picker-mask:not([hidden]), #model-select-mask:not([hidden]), #lightbox:not([hidden])');
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (this.selectedIds.size) { e.preventDefault(); this.deleteSelection(); }
      } else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.selectAllImages();
      } else if (e.key === 'Escape' && !modalOpen && this.selectedIds.size) {
        this.select(null);
      }
    });
  },

  /* ---------- 坐标转换 ---------- */
  screenToWorld(sx, sy) {
    const r = this.els.viewport.getBoundingClientRect();
    return {
      x: (sx - r.left - this.panX) / this.zoom,
      y: (sy - r.top - this.panY) / this.zoom,
    };
  },
  worldToScreen(wx, wy) {
    const r = this.els.viewport.getBoundingClientRect();
    return { x: r.left + wx * this.zoom + this.panX, y: r.top + wy * this.zoom + this.panY };
  },

  viewCenter() {
    const r = this.els.viewport.getBoundingClientRect();
    return this.screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
  },

  /* ---------- 视图变换 ---------- */
  applyView() {
    this.els.root.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    const vp = this.els.viewport;
    const size = Math.max(10, 44 * this.zoom);
    vp.style.setProperty('--grid-size', `${size}px`);
    vp.style.setProperty('--grid-pos', `${this.panX}px ${this.panY}px`);
    const label = document.getElementById('zoom-label');
    if (label) label.textContent = `${Math.round(this.zoom * 100)}%`;
    this._updateHint();
    this._scheduleSave();
  },

  zoomAround(sx, sy, factor) {
    const r = this.els.viewport.getBoundingClientRect();
    const mx = sx - r.left, my = sy - r.top;
    const newZoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
    const k = newZoom / this.zoom;
    this.panX = mx - (mx - this.panX) * k;
    this.panY = my - (my - this.panY) * k;
    this.zoom = newZoom;
    this.applyView();
  },

  setView(z, x, y) {
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, z));
    this.panX = x; this.panY = y;
    this.applyView();
  },

  resetView() {
    const r = this.els.viewport.getBoundingClientRect();
    this.setView(1, r.width / 2 - 200, r.height / 2 - 160);
  },

  fitView() {
    if (!this.nodes.length) { this.resetView(); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.nodes) {
      const w = n.el.offsetWidth, h = n.el.offsetHeight;
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + w); maxY = Math.max(maxY, n.y + h);
    }
    const r = this.els.viewport.getBoundingClientRect();
    const pad = 80;
    const zw = (r.width - pad * 2) / Math.max(1, maxX - minX);
    const zh = (r.height - pad * 2) / Math.max(1, maxY - minY);
    const z = Math.min(this.maxZoom, Math.max(this.minZoom, Math.min(zw, zh)));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    this.zoom = z;
    this.panX = r.width / 2 - cx * z;
    this.panY = r.height / 2 - cy * z;
    this.applyView();
  },

  /* ---------- 事件：拖拽 / 平移 ---------- */
  _drag: null,   // {kind:'pan'|'node', id, sx, sy, nodeX, nodeY, moved}
  _spaceDown: false,

  _onPointerDown(e) {
    if (e.button === 1 || (e.button === 0 && this._spaceDown)) {
      this._drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, px: this.panX, py: this.panY };
      this.els.viewport.classList.add('panning');
      this.els.viewport.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;

    const nodeEl = e.target.closest('.node');
    if (nodeEl) {
      const node = this.nodes.find((n) => n.el === nodeEl);
      if (node) {
        const inMulti = this.selectedIds.size > 1 && this.selectedIds.has(node.id);
        if (!inMulti) this.select(node.id);
        const interactive = e.target.closest('input, textarea, select, button, a, .no-drag');
        const draggable = (node.type === 'zone' || node.type === 'mjzone')
          ? !!e.target.closest('.node-header')
          : !!e.target.closest('.img-wrap img, .img-cap');
        if (!interactive && draggable) {
          if (inMulti) {
            /* 多选组整体拖动 */
            const group = {};
            for (const id of this.selectedIds) {
              const n = this.getNode(id);
              if (n) group[id] = { x: n.x, y: n.y };
            }
            this._drag = { kind: 'group', sx: e.clientX, sy: e.clientY, group, moved: false };
          } else {
            this._drag = { kind: 'node', id: node.id, sx: e.clientX, sy: e.clientY, nodeX: node.x, nodeY: node.y, moved: false };
          }
          this.els.viewport.setPointerCapture(e.pointerId);
          e.preventDefault();
        }
      }
      return;
    }

    /* 空白处：Shift+拖拽 = 框选；否则平移 */
    if (e.shiftKey) {
      this._drag = { kind: 'marquee', sx: e.clientX, sy: e.clientY, moved: false };
      this.els.viewport.classList.add('marqueeing');
      this.els.viewport.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    this._drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, px: this.panX, py: this.panY, moved: false };
    this.els.viewport.classList.add('panning');
    this.els.viewport.setPointerCapture(e.pointerId);
    if (this.onEmptyClick) this.onEmptyClick();
    e.preventDefault();
  },

  _onPointerMove(e) {
    const d = this._drag;
    if (!d) return;
    if (d.kind === 'pan') {
      const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
      if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
      this.panX = d.px + dx;
      this.panY = d.py + dy;
      this.applyView();
    } else if (d.kind === 'marquee') {
      const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
      if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
      const r = this.els.viewport.getBoundingClientRect();
      const x1 = Math.min(d.sx, e.clientX) - r.left;
      const y1 = Math.min(d.sy, e.clientY) - r.top;
      const w = Math.abs(dx);
      const h = Math.abs(dy);
      const mq = this.els.marquee;
      mq.style.display = 'block';
      mq.style.left = x1 + 'px';
      mq.style.top = y1 + 'px';
      mq.style.width = w + 'px';
      mq.style.height = h + 'px';
    } else if (d.kind === 'node') {
      const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
      if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
      const node = this.getNode(d.id);
      if (!node) return;
      node.x = d.nodeX + dx / this.zoom;
      node.y = d.nodeY + dy / this.zoom;
      this._placeNode(node);
      this._scheduleSave();
    } else if (d.kind === 'group') {
      const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
      if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
      for (const [id, start] of Object.entries(d.group)) {
        const n = this.getNode(id);
        if (!n) continue;
        n.x = start.x + dx / this.zoom;
        n.y = start.y + dy / this.zoom;
        this._placeNode(n);
      }
      this._scheduleSave();
    }
  },

  _onPointerUp(e) {
    const d = this._drag;
    if (!d) return;
    if (d.kind === 'marquee') {
      this.els.marquee.style.display = 'none';
      this.els.viewport.classList.remove('marqueeing');
      if (d.moved) {
        const a = this.screenToWorld(d.sx, d.sy);
        const b = this.screenToWorld(e.clientX, e.clientY);
        const x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y);
        const x2 = Math.max(a.x, b.x), y2 = Math.max(a.y, b.y);
        const ids = [];
        for (const n of this.nodes) {
          if (n.type !== 'image') continue;
          const w = n.el.offsetWidth, h = n.el.offsetHeight;
          if (n.x < x2 && n.x + w > x1 && n.y < y2 && n.y + h > y1) ids.push(n.id);
        }
        this.setSelection(ids);
        if (App) App.toast(`已框选 ${ids.length} 张图片（拖动可整体移动，拖到生图区可批量设为参考图，Delete 删除）`, 'ok');
      }
      this._drag = null;
      return;
    }
    if (d.kind === 'group') {
      /* 整体拖到生图区上：批量设为参考图 */
      if (d.moved && e) {
        const w = this.screenToWorld(e.clientX, e.clientY);
        const zone = this.nodes.find((n) =>
          (n.type === 'zone' || n.type === 'mjzone') && !this.selectedIds.has(n.id)
          && w.x >= n.x && w.x <= n.x + n.el.offsetWidth && w.y >= n.y && w.y <= n.y + n.el.offsetHeight);
        if (zone) {
          let added = 0;
          for (const id of this.selectedIds) {
            const n = this.getNode(id);
            if (!n || n.type !== 'image' || !n.data.cacheId) continue;
            if (!zone.data.refIds.includes(n.data.cacheId)) { zone.data.refIds.push(n.data.cacheId); added++; }
          }
          if (added) {
            NodeFactory.renderRefs(zone);
            this._scheduleSave();
            if (App) App.toast(`已把 ${added} 张图设为「${zone.data.title || '生图区'}」的参考图`, 'ok');
          }
        }
      }
    }
    if (this._drag) {
      this.els.viewport.classList.remove('panning', 'marqueeing');
      this._drag = null;
    }
  },

  _onWheel(e) {
    const t = e.target;
    if (t.closest('textarea, input, select, .panel-body, .modal-body, #lightbox-stage')) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0016);
    this.zoomAround(e.clientX, e.clientY, factor);
  },

  /* ---------- 节点管理 ---------- */
  getNode(id) { return this.nodes.find((n) => n.id === id); },

  addNode(node, silent) {
    this.nodes.push(node);
    this.els.root.appendChild(node.el);
    this._placeNode(node);
    if (!silent) {
      this.select(node.id);
      this._scheduleSave();
    }
    this._updateHint();
    return node;
  },

  removeNode(id) {
    const i = this.nodes.findIndex((n) => n.id === id);
    if (i < 0) return;
    const [node] = this.nodes.splice(i, 1);
    node.el.remove();
    this.selectedIds.delete(id);
    if (this.selectedId === id) this.selectedId = null;
    this._updateHint();
    this._scheduleSave();
  },

  select(id) {
    this.selectedId = id;
    this.selectedIds.clear();
    if (id) this.selectedIds.add(id);
    this._applySelectionClasses();
    if (this.onSelectionChange) this.onSelectionChange(id);
  },

  /** 批量设置选中（框选 / 全选结果） */
  setSelection(ids) {
    this.selectedIds = new Set(ids || []);
    this.selectedId = this.selectedIds.size === 1 ? [...this.selectedIds][0] : null;
    this._applySelectionClasses();
    if (this.onSelectionChange) this.onSelectionChange(this.selectedId);
  },

  _applySelectionClasses() {
    for (const n of this.nodes) n.el.classList.toggle('selected', this.selectedIds.has(n.id));
  },

  /** Delete：批量删除选中的图片节点 */
  deleteSelection() {
    const ids = [...this.selectedIds];
    let removed = 0;
    for (const id of ids) {
      const n = this.getNode(id);
      if (n && n.type === 'image') { this.removeNode(id); removed++; }
    }
    this.select(null);
    if (App && removed) App.toast(`已删除 ${removed} 张图片`, 'ok');
  },

  /** Ctrl+A：全选画布上的图片节点 */
  selectAllImages() {
    const ids = this.nodes.filter((n) => n.type === 'image').map((n) => n.id);
    this.setSelection(ids);
    if (App) App.toast(`已全选 ${ids.length} 张图片`, 'ok');
  },

  _placeNode(node) {
    node.el.style.transform = `translate(${node.x}px, ${node.y}px)`;
  },

  _updateHint() {
    if (this.els.hint) this.els.hint.hidden = this.nodes.length > 0;
  },

  /* ---------- 创建节点 ---------- */
  newZone(x, y, data) {
    const zone = NodeFactory.zone(data || {});
    zone.x = x - 186; zone.y = y - 30;
    return this.addNode(zone);
  },

  newMjZone(x, y, data) {
    const zone = NodeFactory.mjzone(data || {});
    zone.x = x - 186; zone.y = y - 30;
    return this.addNode(zone);
  },

  newImage(x, y, data) {
    const img = NodeFactory.image(data);
    img.x = x; img.y = y;
    return this.addNode(img);
  },

  /* ---------- 持久化（分区由 app.js 统一管理） ---------- */
  exportState() {
    return {
      view: { zoom: this.zoom, panX: this.panX, panY: this.panY },
      nodes: this.nodes.map((n) => ({ id: n.id, type: n.type, x: Math.round(n.x), y: Math.round(n.y), data: n.data })),
    };
  },

  clearAll() {
    for (const n of this.nodes) n.el.remove();
    this.nodes = [];
    this.selectedId = null;
    this.selectedIds.clear();
    this._updateHint();
  },

  /** 载入一个分区状态（清空现有节点后重建） */
  importState(state) {
    this.clearAll();
    if (state && state.view) {
      this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, state.view.zoom || 1));
      this.panX = state.view.panX || 0;
      this.panY = state.view.panY || 0;
    } else {
      const r = this.els.viewport.getBoundingClientRect();
      this.zoom = 1;
      this.panX = r.width / 2 - 200;
      this.panY = r.height / 2 - 160;
    }
    for (const sn of (state && state.nodes) || []) {
      if (sn.type === 'zone') {
        const z = NodeFactory.zone(sn.data);
        z.id = sn.id; z.x = sn.x; z.y = sn.y;
        this.addNode(z, true);
      } else if (sn.type === 'mjzone') {
        const z = NodeFactory.mjzone(sn.data);
        z.id = sn.id; z.x = sn.x; z.y = sn.y;
        this.addNode(z, true);
      } else if (sn.type === 'image') {
        const im = NodeFactory.image(sn.data);
        im.id = sn.id; im.x = sn.x; im.y = sn.y;
        this.addNode(im, true);
      }
    }
    this.applyView();
    this.select(null);
    return this.nodes.length;
  },

  _scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.save(), 1200);
  },

  async save() {
    clearTimeout(this._saveTimer);
    if (App && App.queueCanvasSave) App.queueCanvasSave();
  },

  /** 收集画布上所有图片节点的 cacheId */
  collectImageIds() {
    const out = [];
    for (const n of this.nodes) {
      if (n.type === 'image' && n.data.cacheId) out.push({ id: n.data.cacheId, url: n.data.src });
      if (n.type === 'zone') {
        for (const r of n.data.results || []) {
          if (r.file) out.push({ id: r.file, url: r.url });
        }
      }
    }
    return out;
  },
};
