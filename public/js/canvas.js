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

    vp.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    vp.addEventListener('pointermove', (e) => this._onPointerMove(e));
    window.addEventListener('pointerup', (e) => this._onPointerUp(e));
    vp.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    window.addEventListener('resize', () => this.applyView());
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
        this.select(node.id);
        const interactive = e.target.closest('input, textarea, select, button, a, .no-drag');
        const draggable = (node.type === 'zone' || node.type === 'mjzone')
          ? !!e.target.closest('.node-header')
          : !!e.target.closest('.img-wrap img, .img-cap');
        if (!interactive && draggable) {
          this._drag = { kind: 'node', id: node.id, sx: e.clientX, sy: e.clientY, nodeX: node.x, nodeY: node.y, moved: false };
          this.els.viewport.setPointerCapture(e.pointerId);
          e.preventDefault();
        }
      }
      return;
    }

    // 空白处：平移 + 取消选择
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
    } else if (d.kind === 'node') {
      const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
      if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
      const node = this.getNode(d.id);
      if (!node) return;
      node.x = d.nodeX + dx / this.zoom;
      node.y = d.nodeY + dy / this.zoom;
      this._placeNode(node);
      this._scheduleSave();
    }
  },

  _onPointerUp() {
    if (this._drag) {
      this.els.viewport.classList.remove('panning');
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
    if (this.selectedId === id) this.select(null);
    this._updateHint();
    this._scheduleSave();
  },

  select(id) {
    this.selectedId = id;
    for (const n of this.nodes) n.el.classList.toggle('selected', n.id === id);
    if (this.onSelectionChange) this.onSelectionChange(id);
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
