/* ================= 节点工厂：生图区 / 图片 ================= */
'use strict';

const NodeFactory = {
  _zoneCount: 1,
  _mjCount: 1,
  _models: [],        // 由 app.js 注入：全部模型（含分组信息）

  /* MJ 参数选项（参照 PS 插件 mj-shengtu） */
  MJ_VERSIONS: ['', '8.2', '8.1', '8', '7.1', '7', '6.1', '6', '5.2', '5.1', '5', '4', '3', '2', '1'],
  MJ_QUALITIES: ['', '0.25', '0.5', '1', '2'],
  MJ_LENSES: ['', '8mm fisheye lens', '9mm fisheye lens', '10mm fisheye lens', '12mm ultra wide lens', '14mm ultra wide lens', '16mm ultra wide lens', '18mm wide angle lens', '20mm wide angle lens', '24mm wide angle lens', '28mm wide angle lens', '35mm lens', '40mm lens', '50mm lens', '55mm lens', '85mm portrait lens', '100mm lens', '105mm lens', '135mm telephoto lens', '180mm telephoto lens', '200mm telephoto lens', '300mm telephoto lens', '400mm telephoto lens', '500mm super telephoto lens', '600mm super telephoto lens', '800mm super telephoto lens', 'macro lens', 'tilt-shift lens'],
  MJ_APERTURES: ['', 'aperture f/1.0', 'aperture f/1.2', 'aperture f/1.4', 'aperture f/1.8', 'aperture f/2.0', 'aperture f/2.8', 'aperture f/3.5', 'aperture f/4.0', 'aperture f/5.6', 'aperture f/8.0', 'aperture f/10'],

  /* 旧模型名 → 正式模型名（兼容旧保存数据） */
  ALIASES: {
    'nano-banana-3.1-flash': 'gemini-3.1-flash-image-preview',
    'nano-banana-3.1-flash-lite': 'gemini-3.1-flash-lite-image',
  },

  RATIOS: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '1:2', '2:1', '9:21', '21:9'],
  RESOLUTIONS: ['1K', '2K', '4K'],
  QUALITIES: [['auto', 'Auto（自动）'], ['high', 'High（高）'], ['medium', 'Medium（中）'], ['low', 'LOW（低）']],
  BACKGROUNDS: [['auto', 'Auto（自动）'], ['transparent', 'Transparent（透明）'], ['white', 'White（白色）'], ['black', 'Black（黑色）']],
  FORMATS: [['png', 'PNG'], ['jpg', 'JPEG'], ['webp', 'WEBP']],
  MODERATIONS: [['auto', 'Auto（自动）'], ['low', 'Low（低）'], ['none', 'None（关闭）']],

  setModels(groups) {
    this._models = [];
    for (const g of groups || []) {
      for (const m of g.models) this._models.push({ ...m, category: g.category });
    }
  },

  modelById(id) {
    return this._models.find((m) => m.id === id) || null;
  },

  /** 填充模型下拉（分区切换 / 提供商拉取模型后重建用） */
  fillModelSelect(sel) {
    sel.innerHTML = '';
    for (const g of (App.modelGroups || [])) {
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
  },

  /** 提供商切换 / 模型拉取后：重建所有生图区的模型下拉 */
  rebuildZoneModelSelects() {
    for (const n of Canvas.nodes) {
      if (n.type !== 'zone' || !n.el) continue;
      const sel = n.el.querySelector('.z-model');
      if (!sel) continue;
      const prev = n.data.model;
      this.fillModelSelect(sel);
      const valid = this._models.some((m) => m.id === prev);
      n.data.model = valid ? prev : (sel.options[0] ? sel.options[0].value : '');
      if (!sel.options.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '（暂无勾选模型，请到设置里勾选）';
        sel.appendChild(opt);
      }
      sel.value = n.data.model;
      this.syncControls(n);
    }
    Canvas._scheduleSave();
  },

  /* ================= 生图区 ================= */
  zone(data) {
    const d = Object.assign({
      title: `生图区 #${this._zoneCount++}`,
      model: (App && App.defaultModel) || 'gpt-image-1',
      prompt: '',
      negative: '',
      showNeg: false,
      ratio: '1:1',          // 比例（统一比例列表 + custom）
      resolution: '2K',      // 分辨率 1K / 2K / 4K
      customSize: '',        // 自定义尺寸（比例选「自定义…」时使用）
      n: 1,
      advOpen: false,        // 高级设置是否展开
      quality: 'auto',       // auto / high / medium / low
      background: 'auto',    // auto / transparent / white / black
      format: 'png',         // png / jpg / webp
      moderation: 'auto',    // auto / low / none
      mode: 'gen',           // gen | edit
      refIds: [],
      results: [],
    }, data || {});
    if (this.ALIASES[d.model]) d.model = this.ALIASES[d.model];
    /* 迁移：旧数据的结果是平铺数组，包装成单个「任务」组，与新格式（按任务分组）一致 */
    if (Array.isArray(d.results) && d.results.length && !Array.isArray(d.results[0].files)) {
      d.results = [{ id: 'legacy', ts: 0, model: '', size: '', prompt: '', files: d.results }];
    }
    if (!Array.isArray(d.results)) d.results = [];

    const zone = {
      id: 'z' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      type: 'zone',
      x: 0, y: 0,
      data: d,
      el: null,
      _timer: null,
    };

    zone.el = document.createElement('div');
    zone.el.className = 'node zone';
    zone.el.innerHTML = `
      <div class="node-header">
        <span class="node-icon">🧩</span>
        <span class="node-title">${esc(d.title)}</span>
        <button class="node-edit" title="修改生图区名字">✎</button>
        <button class="node-del" title="删除生图区">✕</button>
      </div>
      <div class="zone-body">
        <div>
          <label class="lbl">模型</label>
          <select class="z-model"></select>
        </div>
        <div>
          <label class="lbl">提示词 Prompt</label>
          <textarea class="z-prompt" placeholder="描述你想生成的画面，例如：一只可爱的橘猫坐在窗台上晒太阳，温暖的午后，油画风格"></textarea>
          <div class="prompt-tools">
            <button class="btn btn-mini z-save-prompt" title="保存当前提示词（自定义名称，存入常用提示词库）">💾 保存当前提示词</button>
            <button class="btn btn-mini z-pick-prompt" title="从常用提示词库载入">📂 常用提示词</button>
          </div>
        </div>
        <button class="neg-toggle">＋ 负面提示词（Negative Prompt）</button>
        <textarea class="z-neg neg" placeholder="不希望出现的元素，例如：模糊，低质量，多余的手指" hidden></textarea>
        <div>
          <label class="lbl">比例 / 尺寸</label>
          <div class="zone-row">
            <select class="z-ratio"></select>
            <div class="seg z-res-seg">
              <button class="z-res-1k" title="长边 1024px">1K</button>
              <button class="z-res-2k" title="长边 2048px">2K</button>
              <button class="z-res-4k" title="长边 3840px">4K</button>
            </div>
          </div>
          <input type="text" class="z-custom-size" placeholder="自定义尺寸 宽x高，例如 1344x768（边长16的倍数）" hidden>
          <span class="ref-hint z-ratio-hint" hidden></span>
        </div>
        <div class="zone-row">
          <div>
            <label class="lbl">数量</label>
            <select class="z-n">
              <option value="1">1 张</option><option value="2">2 张</option>
              <option value="3">3 张</option><option value="4">4 张</option>
              <option value="8">8 张</option>
            </select>
          </div>
          <div class="z-mode-wrap">
            <label class="lbl">模式</label>
            <div class="seg">
              <button class="z-mode-gen on" title="文生图 / 图生图（Generations）">生图</button>
              <button class="z-mode-edit" title="图像编辑（Edits）">编辑</button>
            </div>
          </div>
        </div>
        <button class="adv-toggle">⚙ 高级设置（质量 / 背景 / 格式 / 审核）</button>
        <div class="z-adv" hidden>
          <div class="zone-row">
            <div class="z-quality-wrap">
              <label class="lbl">质量 Quality</label>
              <select class="z-quality"></select>
            </div>
            <div>
              <label class="lbl">背景 Background</label>
              <select class="z-background"></select>
            </div>
          </div>
          <div class="zone-row">
            <div>
              <label class="lbl">格式 Format</label>
              <select class="z-format"></select>
            </div>
            <div>
              <label class="lbl">审核 Moderation</label>
              <select class="z-moderation"></select>
            </div>
          </div>
          <span class="ref-hint">部分参数仅对支持的模型生效（质量：GPT 系列；背景/审核：Nano Banana 等）</span>
        </div>
        <div>
          <label class="lbl">参考图（本地图片插件 · 图生图 / 编辑）</label>
          <div class="refs-area"></div>
          <span class="ref-hint">把图片文件拖到这里，或点击 ＋ 从画布/本地上传</span>
        </div>
        <button class="gen-btn">✨ 生成图片</button>
        <div class="gen-status"></div>
      </div>
      <div class="zone-results">
        <div class="results-head">
          <span class="results-title">生成结果</span>
          <div class="results-head-btns">
            <button class="btn btn-mini z-results-clear" title="清除该生图区展示的所有结果（历史记录与本地缓存图片保留）">🗑 清除结果</button>
            <button class="btn btn-mini z-results-all">全部放到画布</button>
          </div>
        </div>
        <div class="results-grid"></div>
      </div>`;

    this._wireZone(zone);
    this.syncControls(zone);
    this.renderRefs(zone);
    this.renderResults(zone);
    return zone;
  },

  _fillSelect(sel, options, value) {
    sel.innerHTML = '';
    for (const [v, label] of options) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      sel.appendChild(o);
    }
    sel.value = value;
  },

  _wireZone(zone) {
    const el = zone.el;
    const d = zone.data;
    const q = (s) => el.querySelector(s);

    /* 删除 */
    q('.node-del').addEventListener('click', () => {
      clearInterval(zone._timer);
      Canvas.removeNode(zone.id);
    });

    /* ✎ 修改生图区名字（失焦自动保存） */
    const startTitleRename = () => {
      const cur = q('.node-title');
      if (!cur) return;
      const input = document.createElement('input');
      input.className = 'node-title-input';
      input.value = d.title;
      input.maxLength = 40;
      cur.replaceWith(input);
      input.focus();
      input.select();
      let finished = false;
      const restore = (saved) => {
        if (finished) return;
        finished = true;
        const span = document.createElement('span');
        span.className = 'node-title';
        span.textContent = saved;
        input.replaceWith(span);
      };
      input.addEventListener('blur', () => {
        const nm = input.value.trim();
        if (nm) d.title = nm;
        restore(d.title);
        Canvas._scheduleSave();
        if (nm) App.toast(`生图区已重命名为「${d.title}」`, 'ok');
      });
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
        if (ev.key === 'Escape') { ev.preventDefault(); restore(d.title); }
      });
    };
    q('.node-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      startTitleRename();
    });

    /* 模型下拉 */
    const modelSel = q('.z-model');
    this.fillModelSelect(modelSel);
    /* 勾选列表里没有当前默认模型时，回退到第一个勾选模型 */
    if (modelSel.value !== d.model) {
      d.model = modelSel.options[0] ? modelSel.options[0].value : '';
      if (!d.model) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '（暂无勾选模型，请到设置里勾选）';
        modelSel.appendChild(opt);
      }
    }
    modelSel.value = d.model;
    modelSel.addEventListener('change', () => {
      d.model = modelSel.value;
      const m = NodeFactory.modelById(d.model);
      if (!(m && m.supportsEdit)) d.mode = 'gen';
      this.syncControls(zone);
      Canvas._scheduleSave();
    });

    /* 提示词 */
    const prompt = q('.z-prompt');
    prompt.value = d.prompt;
    prompt.addEventListener('input', () => { d.prompt = prompt.value; Canvas._scheduleSave(); });

    /* 保存 / 载入常用提示词（独立于对话窗口的常用对话库） */
    q('.z-save-prompt').addEventListener('click', () => App.openPromptSave(d.prompt, 'prompt'));
    q('.z-pick-prompt').addEventListener('click', async () => {
      const content = await App.pickPrompt('prompt', '📂 选择常用提示词');
      if (content) {
        prompt.value = content;
        d.prompt = content;
        prompt.focus();
        Canvas._scheduleSave();
        App.toast('已载入常用提示词', 'ok');
      }
    });

    /* 负面提示词 */
    const negToggle = q('.neg-toggle');
    const neg = q('.z-neg');
    neg.value = d.negative;
    neg.addEventListener('input', () => { d.negative = neg.value; Canvas._scheduleSave(); });
    negToggle.addEventListener('click', () => {
      d.showNeg = !d.showNeg;
      neg.hidden = !d.showNeg;
      negToggle.textContent = d.showNeg ? '− 收起负面提示词' : '＋ 负面提示词（Negative Prompt）';
    });
    neg.hidden = !d.showNeg;

    /* 比例 / 分辨率 / 自定义尺寸 */
    const ratioSel = q('.z-ratio');
    const customInput = q('.z-custom-size');
    this._fillSelect(ratioSel, this.RATIOS.map((r) => [r, r]).concat([['custom', '自定义…']]), d.ratio);
    ratioSel.addEventListener('change', () => {
      d.ratio = ratioSel.value;
      this.syncControls(zone);
      Canvas._scheduleSave();
    });
    q('.z-res-1k').addEventListener('click', () => { d.resolution = '1K'; this.syncControls(zone); Canvas._scheduleSave(); });
    q('.z-res-2k').addEventListener('click', () => { d.resolution = '2K'; this.syncControls(zone); Canvas._scheduleSave(); });
    q('.z-res-4k').addEventListener('click', () => { d.resolution = '4K'; this.syncControls(zone); Canvas._scheduleSave(); });
    customInput.addEventListener('input', () => { d.customSize = customInput.value; Canvas._scheduleSave(); });

    /* 数量 / 模式 */
    q('.z-n').addEventListener('change', (e) => { d.n = Number(e.target.value); Canvas._scheduleSave(); });
    q('.z-mode-gen').addEventListener('click', () => { d.mode = 'gen'; this.syncControls(zone); Canvas._scheduleSave(); });
    q('.z-mode-edit').addEventListener('click', () => { d.mode = 'edit'; this.syncControls(zone); Canvas._scheduleSave(); });

    /* 高级设置 */
    const advToggle = q('.adv-toggle');
    const adv = q('.z-adv');
    advToggle.addEventListener('click', () => {
      d.advOpen = !d.advOpen;
      adv.hidden = !d.advOpen;
      advToggle.textContent = (d.advOpen ? '−' : '⚙') + ' 高级设置（质量 / 背景 / 格式 / 审核）';
    });
    this._fillSelect(q('.z-quality'), this.QUALITIES, d.quality);
    this._fillSelect(q('.z-background'), this.BACKGROUNDS, d.background);
    this._fillSelect(q('.z-format'), this.FORMATS, d.format);
    this._fillSelect(q('.z-moderation'), this.MODERATIONS, d.moderation);
    q('.z-quality').addEventListener('change', (e) => { d.quality = e.target.value; Canvas._scheduleSave(); });
    q('.z-background').addEventListener('change', (e) => { d.background = e.target.value; Canvas._scheduleSave(); });
    q('.z-format').addEventListener('change', (e) => { d.format = e.target.value; Canvas._scheduleSave(); });
    q('.z-moderation').addEventListener('change', (e) => { d.moderation = e.target.value; Canvas._scheduleSave(); });

    /* 参考图：拖入文件 */
    const refsArea = q('.refs-area');
    refsArea.addEventListener('dragover', (e) => { e.preventDefault(); refsArea.classList.add('drag-over'); });
    refsArea.addEventListener('dragleave', () => refsArea.classList.remove('drag-over'));
    refsArea.addEventListener('drop', async (e) => {
      e.preventDefault();
      refsArea.classList.remove('drag-over');
      const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
      for (const f of files) await this._uploadAsRef(zone, f);
    });

    /* 生成 */
    q('.gen-btn').addEventListener('click', () => this.generate(zone));
    prompt.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) this.generate(zone);
    });

    /* 结果区 */
    q('.z-results-clear').addEventListener('click', () => {
      if (!d.results.length) return;
      if (!confirm('清除该生图区展示的所有生成结果？\n（历史记录与本地缓存图片会保留）')) return;
      d.results = [];
      this.renderResults(zone);
      Canvas._scheduleSave();
      App.toast('已清除生图区的结果展示（历史与缓存保留）', 'ok');
    });
    q('.z-results-all').addEventListener('click', () => {
      let placed = 0;
      for (const batch of d.results) {
        for (const r of (Array.isArray(batch.files) ? batch.files : [])) {
          Canvas.newImage(zone.x + 390 + Math.random() * 60, zone.y + (placed % 3) * 40, {
            src: r.url, cacheId: r.file, label: '生成图',
          });
          placed++;
        }
      }
      Canvas._scheduleSave();
      if (!placed) App.toast('结果区还没有图片', 'err');
    });
  },

  /** 根据当前模型 / 比例同步控件可见性 */
  syncControls(zone) {
    const el = zone.el;
    const d = zone.data;
    const m = NodeFactory.modelById(d.model);
    const q = (s) => el.querySelector(s);

    const modeWrap = q('.z-mode-wrap');
    const resSeg = q('.z-res-seg');
    const customInput = q('.z-custom-size');
    const ratioHint = q('.z-ratio-hint');
    const qualityWrap = q('.z-quality-wrap');

    /* 模式（仅支持编辑的模型显示） */
    modeWrap.hidden = !(m && m.supportsEdit);
    q('.z-mode-gen').classList.toggle('on', d.mode === 'gen');
    q('.z-mode-edit').classList.toggle('on', d.mode === 'edit');

    /* 分辨率 */
    const isCustom = d.ratio === 'custom';
    const ratioModel = m && Array.isArray(m.ratios) && m.ratios.length > 0;
    resSeg.hidden = isCustom || ratioModel;
    customInput.hidden = !isCustom;
    customInput.value = d.customSize;
    q('.z-res-1k').classList.toggle('on', d.resolution === '1K');
    q('.z-res-2k').classList.toggle('on', d.resolution === '2K');
    q('.z-res-4k').classList.toggle('on', d.resolution === '4K');
    if (ratioModel && !isCustom) {
      ratioHint.hidden = false;
      ratioHint.textContent = '该模型按比例生成，分辨率通过 image_size 参数下发';
    } else {
      ratioHint.hidden = true;
    }

    /* 高级设置中的质量（仅支持 quality 的模型显示） */
    qualityWrap.hidden = !(m && m.quality);

    q('.z-n').value = String(d.n);
    q('.z-ratio').value = d.ratio;
  },

  async _uploadAsRef(zone, file) {
    try {
      let dataUrl = await fileToDataUrl(file);
      let note = '';
      if (App && App._activeIsGrs && App._activeIsGrs()) {
        dataUrl = await App.compressImage(dataUrl, 2048, 0.9);
        note = '（GRS：已自动压缩）';
      }
      const up = await API.upload(dataUrl);
      zone.data.refIds.push(up.id);
      this.renderRefs(zone);
      Canvas._scheduleSave();
      if (App) App.toast(`参考图已添加：${file.name}${note}`, 'ok');
    } catch (e) {
      if (App) App.toast(`上传失败：${e.message}`, 'err');
    }
  },

  renderRefs(zone) {
    const area = zone.el.querySelector('.refs-area');
    area.innerHTML = '';
    for (const id of zone.data.refIds) {
      const name = App.imageNameById(id);
      const item = document.createElement('div');
      item.className = 'ref-item';
      item.innerHTML = `
        <div class="ref-thumb" title="${esc(name)}">
          <img src="/cache/${encodeURI(id)}" alt="参考图"><button class="ref-x">✕</button>
        </div>
        <span class="ref-name" title="${esc(name)}">${esc(name)}</span>`;
      const refImg = item.querySelector('img');
      refImg.loading = 'lazy';
      refImg.decoding = 'async';
      App.setThumbImg(refImg, id, `/cache/${encodeURI(id)}`);
      refImg.addEventListener('click', () => App.openLightbox(`/cache/${encodeURI(id)}`, name || '参考图'));
      item.querySelector('.ref-x').addEventListener('click', () => {
        zone.data.refIds = zone.data.refIds.filter((x) => x !== id);
        this.renderRefs(zone);
        Canvas._scheduleSave();
      });
      area.appendChild(item);
    }
    const add = document.createElement('button');
    add.className = 'ref-add';
    add.textContent = '＋';
    add.title = '添加参考图（画布图片可多选 / 本地上传）';
    add.addEventListener('click', async () => {
      const ids = await App.pickImages('添加参考图（可多选）');
      if (ids && ids.length) {
        for (const id of ids) {
          await App.addRefToZone(zone, id);
        }
        if (App) App.toast(`已添加 ${ids.length} 张参考图${(App._activeIsGrs && App._activeIsGrs()) ? '（GRS：已自动压缩）' : ''}`, 'ok');
      }
    });
    area.appendChild(add);
  },

  /* ================= 生成 ================= */
  _setStatus(zone, state, text) {
    const el = zone.el.querySelector('.gen-status');
    const btn = zone.el.querySelector('.gen-btn');
    zone.data.status = { state, text };
    el.className = 'gen-status' + (state === 'err' ? ' err' : state === 'ok' ? ' ok' : '');
    el.textContent = text || '';
    const running = state === 'running';
    /* 运行中按钮变成「停止」，随时可中断 */
    btn.disabled = false;
    btn.classList.toggle('stop', running);
    btn.innerHTML = running ? '⏹ 停止' : '✨ 生成图片';
  },

  async generate(zone) {
    const d = zone.data;
    if (d.status && d.status.state === 'running') {
      /* 点击「停止」：中断当前跑图（已回传的图保留） */
      if (zone._abort) { try { zone._abort.abort(); } catch { /* 忽略 */ } }
      this._setStatus(zone, 'running', '正在停止…');
      return;
    }

    const m = NodeFactory.modelById(d.model);
    if (!d.model) { this._setStatus(zone, 'err', '暂无可用模型：请到 ⚙ 设置 → 提供商 → 🗂 选择模型 里勾选'); return; }
    if (!d.prompt.trim()) { this._setStatus(zone, 'err', '请输入提示词（Prompt）'); return; }
    if (d.mode === 'edit' && d.refIds.length === 0) {
      this._setStatus(zone, 'err', '「编辑」模式需要至少一张参考图：把本地图片拖进下方参考图区域');
      return;
    }
    if (m && m.id === 'flux-kontext-dev' && d.refIds.length === 0) {
      this._setStatus(zone, 'err', 'flux-kontext-dev 必须有参考图才能生成');
      return;
    }
    if (d.ratio === 'custom' && !/^\d{2,4}x\d{2,4}$/.test((d.customSize || '').trim())) {
      this._setStatus(zone, 'err', '自定义尺寸格式应为 宽x高，例如 1344x768');
      return;
    }

    const payload = {
      model: d.model,
      prompt: d.prompt.trim(),
      mode: d.mode === 'edit' ? 'edits' : 'generations',
      refIds: d.refIds.slice(),
      n: d.n,
      format: d.format,
      quality: d.quality,
      background: d.background,
      moderation: d.moderation,
      stream: true,
    };
    if (d.ratio === 'custom') payload.customSize = d.customSize.trim();
    else {
      payload.ratio = d.ratio;
      payload.resolution = d.resolution;
    }
    if (d.negative.trim()) payload.negative = d.negative.trim();

    const t0 = Date.now();
    const abortCtl = new AbortController();
    if (zone._abort) { try { zone._abort.abort(); } catch { /* 忽略 */ } }
    zone._abort = abortCtl;
    zone._done = 0;

    /* 每个任务一组：新任务置顶显示，与之前的任务分开 */
    const batch = {
      id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ts: Date.now(),
      model: d.model,
      size: d.mode === 'edit' ? '编辑' : (d.ratio === 'custom' ? d.customSize.trim() : `${d.ratio} · ${d.resolution}`),
      prompt: d.prompt.slice(0, 300),
      files: [],
    };
    d.results.unshift(batch);
    this.renderResults(zone);

    this._setStatus(zone, 'running', `生成中… 已出 0/${d.n} · 0s`);
    if (App && App.logTask) App.logTask('start', `生图 · ${d.model} · ${d.n} 张 · 「${d.prompt.slice(0, 30)}${d.prompt.length > 30 ? '…' : ''}」`);
    clearInterval(zone._timer);
    zone._timer = setInterval(() => {
      if (zone.data.status && zone.data.status.state !== 'running') return;
      const s = Math.floor((Date.now() - t0) / 1000);
      const done = zone._done || 0;
      this._setStatus(zone, 'running', `生成中… 已出 ${done}/${d.n} · ${s}s${s > 60 ? '（大图/高峰期可能较慢）' : ''}`);
    }, 1000);

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: abortCtl.signal,
      });
      if (!res.ok) {
        let err = `请求失败（HTTP ${res.status}）`;
        try { const j = await res.json(); if (j && j.error) err = j.error; } catch { /* 忽略 */ }
        throw new Error(err);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let finishedCount = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === 'image') {
            /* 出一张回传一张，实时加入本任务组 */
            zone._done = (zone._done || 0) + 1;
            finishedCount = zone._done;
            batch.files.push({ file: ev.file, url: ev.url });
            this.renderResults(zone);
            this._setStatus(zone, 'running', `生成中… 已出 ${finishedCount}/${ev.total} · ${Math.floor((Date.now() - t0) / 1000)}s`);
            Canvas._scheduleSave();
          } else if (ev.type === 'fail') {
            this._setStatus(zone, 'running', `生成中… 第 ${ev.idx + 1} 张失败，继续跑其余 · ${Math.floor((Date.now() - t0) / 1000)}s`);
            if (App) App.toast(`第 ${ev.idx + 1} 张失败：${ev.error}`, 'err');
          } else if (ev.type === 'error') {
            throw new Error(ev.error);
          }
          /* done 事件无需处理，循环结束后统一收尾 */
        }
      }
      if (!batch.files.length) d.results = d.results.filter((x) => x !== batch);
      this.renderResults(zone);
      clearInterval(zone._timer);
      this._setStatus(zone, 'ok', `✅ 完成 · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s · 共 ${finishedCount} 张`);
      Canvas._scheduleSave();
      if (App) {
        App.refreshHistoryCount();
        App.logTask('done', `生图完成 · ${d.model} · ${finishedCount} 张 · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      }
    } catch (e) {
      clearInterval(zone._timer);
      const aborted = e.name === 'AbortError' || abortCtl.signal.aborted;
      if (aborted) {
        const got = zone._done || 0;
        if (!batch.files.length) d.results = d.results.filter((x) => x !== batch);
        this.renderResults(zone);
        this._setStatus(zone, 'ok', `⏹ 已停止 · 本次回传 ${got} 张（已出的图保留在结果区）`);
        Canvas._scheduleSave();
        if (App) {
          App.logTask('done', `生图已中断 · ${d.model} · 已回传 ${got} 张`);
          App.refreshHistoryCount();
        }
      } else {
        if (!batch.files.length) d.results = d.results.filter((x) => x !== batch);
        this.renderResults(zone);
        this._setStatus(zone, 'err', `❌ ${e.message}`);
        if (App) {
          App.logTask('error', `生图失败 · ${d.model} · ${e.message}`);
          if (/API Key|Base URL|鉴权/.test(e.message)) App.hintSettings();
          App.refreshHistoryCount();
        }
      }
    } finally {
      zone._abort = null;
    }
  },

  /* ================= 结果区（按任务分组） ================= */
  renderResults(zone) {
    const d = zone.data;
    const wrap = zone.el.querySelector('.zone-results');
    const grid = zone.el.querySelector('.results-grid');
    wrap.classList.toggle('show', d.results.length > 0);
    grid.innerHTML = '';
    d.results.forEach((batch) => {
      const files = Array.isArray(batch.files) ? batch.files : [];
      if (!files.length) return;
      const t = new Date(batch.ts || 0);
      const timeStr = batch.ts
        ? `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`
        : '—';
      const sec = document.createElement('div');
      sec.className = 'result-batch';
      sec.innerHTML = `
        <div class="result-batch-head" title="${esc(batch.prompt || '')}">
          <span class="batch-title">${esc(batch.model || '')}${batch.size ? ' · ' + esc(batch.size) : ''} · ${files.length} 张</span>
          <button class="batch-place-all" data-batch-place title="把这组的图片全部放到画布上">⤢ 到画布</button>
          <span class="batch-time">${timeStr}</span>
        </div>
        <div class="result-batch-grid"></div>`;
      sec.querySelector('[data-batch-place]').addEventListener('click', () => {
        let placed = 0;
        for (const r of files) {
          const off = (d._placedCount || 0) % 5;
          Canvas.newImage(
            zone.x + 390 + off * 40,
            zone.y + 140 + off * 40,
            { src: r.url, cacheId: r.file, label: '生成图' },
          );
          d._placedCount = (d._placedCount || 0) + 1;
          placed++;
        }
        Canvas._scheduleSave();
        App.toast(`已把这组 ${placed} 张图片放到画布`, 'ok');
      });
      const bgrid = sec.querySelector('.result-batch-grid');
      files.forEach((r, i) => {
        const item = document.createElement('div');
        item.className = 'result-item';
        item.innerHTML = `
          <img src="${r.thumb || r.url}" alt="生成图 ${i + 1}" loading="lazy" decoding="async">
          <span class="result-tag">#${i + 1}</span>
          <div class="result-actions">
            <button data-act="place" title="作为图片放到画布上">⤢ 到画布</button>
            <button data-act="ref" title="设为该区参考图">🎯 参考</button>
            <button data-act="dl" title="下载到本地">⬇</button>
          </div>`;
        const rim = item.querySelector('img');
        rim.addEventListener('click', () => App.openLightbox(r.url, `生成图 #${i + 1} · ${batch.model || ''} · ${batch.size || ''}`));
        if (!r.thumb) {
          App.setThumbImg(rim, r.file, r.url, (tt) => {
            if (tt && tt !== r.url) { r.thumb = tt; Canvas._scheduleSave(); }
          });
        }
        item.querySelector('[data-act="place"]').addEventListener('click', () => {
          const off = (d._placedCount || 0) % 5;
          Canvas.newImage(
            zone.x + 390 + off * 40,
            zone.y + 140 + off * 40,
            { src: r.url, cacheId: r.file, label: '生成图' },
          );
          d._placedCount = (d._placedCount || 0) + 1;
          Canvas._scheduleSave();
        });
        item.querySelector('[data-act="ref"]').addEventListener('click', async () => {
          await App.addRefToZone(zone, r.file);
          App.toast('已设为该生图区的参考图', 'ok');
        });
        item.querySelector('[data-act="dl"]').addEventListener('click', () => {
          downloadUrl(r.url, r.file.split('/').pop());
        });
        bgrid.appendChild(item);
      });
      grid.appendChild(sec);
    });
  },

  /* ================= 图片节点 ================= */
  image(data) {
    const d = Object.assign({
      src: '',
      cacheId: '',        // 例如 uploads/u_xxx.png / generated/xxx.png
      label: '图片',
    }, data || {});

    const node = {
      id: 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      type: 'image',
      x: 0, y: 0,
      data: d,
      el: null,
    };

    node.el = document.createElement('div');
    node.el.className = 'node image';
    node.el.innerHTML = `
      <div class="img-wrap">
        <button class="img-zoom" title="放大查看（大图模式）">🔍</button>
        <img src="${esc(d.src)}" alt="图片" draggable="false">
        <div class="img-toolbar">
          <button data-act="ref" title="设为参考图（选中生图区后使用）">🎯</button>
          <button data-act="chat" title="插入到对话窗口">💬</button>
          <button data-act="dl" title="下载">⬇</button>
          <button data-act="del" title="从画布删除">🗑</button>
        </div>
      </div>
      <div class="img-cap"><span class="img-label">${esc(d.label)}</span><button class="img-edit" title="修改名字">✎</button><span class="img-size"></span></div>`;

    const img = node.el.querySelector('img');
    img.addEventListener('load', () => {
      const cap = node.el.querySelector('.img-size');
      if (cap) cap.textContent = `${img.naturalWidth}×${img.naturalHeight}`;
    });
    /* 左上角 🔍 放大镜：点击进入大图模式（不再用双击，避免与拖动冲突） */
    node.el.querySelector('.img-zoom').addEventListener('click', (e) => {
      e.stopPropagation();
      App.openLightbox(d.src, d.label);
    });
    node.el.querySelector('[data-act="ref"]').addEventListener('click', () => App.setRefFromImage(d.cacheId, d.src));
    node.el.querySelector('[data-act="chat"]').addEventListener('click', () => Chat.attachToLast(d.cacheId));
    node.el.querySelector('[data-act="dl"]').addEventListener('click', () => downloadUrl(d.src, (d.cacheId || 'image.png').split('/').pop()));
    node.el.querySelector('[data-act="del"]').addEventListener('click', () => Canvas.removeNode(node.id));

    /* 点击名字后的 ✎ 进入修改，点其他位置（失焦）自动保存 */
    const startRename = () => {
      const cur = node.el.querySelector('.img-label');
      if (!cur) return;
      const input = document.createElement('input');
      input.className = 'img-rename';
      input.value = d.label;
      input.maxLength = 60;
      cur.replaceWith(input);
      input.focus();
      input.select();
      let finished = false;
      const restore = (saved) => {
        if (finished) return;
        finished = true;
        const span = document.createElement('span');
        span.className = 'img-label';
        span.title = saved;
        span.textContent = saved;
        input.replaceWith(span);
      };
      input.addEventListener('blur', () => {
        const name = input.value.trim();
        if (name) d.label = name;
        restore(d.label);
        Canvas._scheduleSave();
        if (name) App.toast(`图片已重命名为「${d.label}」`, 'ok');
      });
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
        if (ev.key === 'Escape') { ev.preventDefault(); restore(d.label); }
      });
    };
    node.el.querySelector('.img-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      startRename();
    });

    /* 拖入新图片直接替换 */
    node.el.addEventListener('dragover', (e) => { e.preventDefault(); node.el.classList.add('drag-over'); });
    node.el.addEventListener('dragleave', () => node.el.classList.remove('drag-over'));
    node.el.addEventListener('drop', async (e) => {
      e.preventDefault();
      node.el.classList.remove('drag-over');
      const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
      if (!f) return;
      try {
        const up = await API.upload(await fileToDataUrl(f));
        d.src = up.url; d.cacheId = up.id; d.label = f.name;
        img.src = up.url;
        Canvas._scheduleSave();
      } catch (err) { App.toast(`替换失败：${err.message}`, 'err'); }
    });

    return node;
  },

  /* ================= MJ 生图区（Midjourney） ================= */
  mjzone(data) {
    const d = Object.assign({
      title: `MJ 生图 #${this._mjCount++}`,
      mode: 'default',       // default | fast | turbo | relax
      channel: 'default',    // default | relay | origin | proxy（图片通道，国内访问选 relay）
      taskType: 'imagine',   // imagine | blend
      prompt: '',
      refIds: [],
      ar: '1:1',             // --ar
      version: '',           // --v
      quality: '',           // --q
      botType: 'MID_JOURNEY',
      dimensions: 'SQUARE',  // Blend 比例
      lens: '',
      aperture: '',
      hd: false,
      advOpen: false,
      raw: false,            // --raw 写实模式
      mjResults: [],         // 按任务分组：[{id, ts, label, prompt, files:[{url,file,thumb,buttons,taskId,promptEn}]}]
    }, data || {});
    /* 迁移：旧数据是平铺数组，包装成单个「任务」组 */
    if (Array.isArray(d.mjResults) && d.mjResults.length && !Array.isArray(d.mjResults[0].files)) {
      d.mjResults = [{ id: 'legacy', ts: 0, label: '', prompt: '', files: d.mjResults }];
    }
    if (!Array.isArray(d.mjResults)) d.mjResults = [];

    const zone = {
      id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      type: 'mjzone',
      x: 0, y: 0,
      data: d,
      el: null,
      _timer: null,
    };

    zone.el = document.createElement('div');
    zone.el.className = 'node zone mj-zone';
    zone.el.innerHTML = `
      <div class="node-header">
        <span class="node-icon">🎨</span>
        <span class="node-title">${esc(d.title)}</span>
        <button class="node-edit" title="修改生图区名字">✎</button>
        <button class="node-del" title="删除生图区">✕</button>
      </div>
      <div class="zone-body">
        <div class="zone-row">
          <div>
            <label class="lbl">绘图模式</label>
            <select class="m-mode">
              <option value="default">默认（Fast）</option>
              <option value="fast">Fast</option>
              <option value="turbo">Turbo</option>
              <option value="relax">Relax</option>
            </select>
          </div>
          <div>
            <label class="lbl">图片通道（国内访问）</label>
            <select class="m-channel">
              <option value="default">默认</option>
              <option value="relay">转发加速 relay</option>
              <option value="origin">原图 origin</option>
              <option value="proxy">平台代理 proxy</option>
            </select>
          </div>
        </div>
        <div class="zone-row">
          <div>
            <label class="lbl">任务类型</label>
            <div class="seg">
              <button class="m-task-imagine on">Imagine 文生图</button>
              <button class="m-task-blend">Blend 图生图</button>
            </div>
          </div>
        </div>
        <div>
          <label class="lbl">提示词 Prompt</label>
          <textarea class="m-prompt" placeholder="描述你想绘制的画面，支持中文，例如：一只橘猫坐在窗台上，温暖的午后，油画风格"></textarea>
        </div>
        <div>
          <label class="lbl">参考图（垫图 / Blend 用图）</label>
          <div class="refs-area"></div>
          <span class="ref-hint">拖入图片文件或点 ＋ 从画布/本地上传（Blend 需要至少一张）</span>
        </div>
        <div class="zone-row">
          <div>
            <label class="lbl">画面比例 --ar</label>
            <select class="m-ar"></select>
          </div>
          <div>
            <label class="lbl">版本 --v</label>
            <select class="m-version"></select>
          </div>
        </div>
        <div class="zone-row">
          <div>
            <label class="lbl">质量 --q</label>
            <select class="m-quality"></select>
          </div>
          <div>
            <label class="lbl">机器人类型</label>
            <select class="m-bot">
              <option value="MID_JOURNEY">Midjourney</option>
              <option value="NIJI_JOURNEY">Niji</option>
            </select>
          </div>
        </div>
        <div class="m-blend-wrap" hidden>
          <label class="lbl">Blend 比例</label>
          <select class="m-blend-dim">
            <option value="SQUARE">1:1 SQUARE</option>
            <option value="PORTRAIT">2:3 PORTRAIT</option>
            <option value="LANDSCAPE">3:2 LANDSCAPE</option>
          </select>
        </div>
        <button class="adv-toggle">⚙ 高级设置（镜头 / 光圈 / HD / Raw）</button>
        <div class="z-adv" hidden>
          <div class="zone-row">
            <div>
              <label class="lbl">镜头焦段</label>
              <select class="m-lens"></select>
            </div>
            <div>
              <label class="lbl">光影 / 光圈</label>
              <select class="m-aperture"></select>
            </div>
          </div>
          <label class="checkbox-label">
            <input type="checkbox" class="m-hd"> HD 高清（--hd）
          </label>
          <label class="checkbox-label">
            <input type="checkbox" class="m-raw"> Raw 写实模式（--raw）
          </label>
        </div>
        <button class="gen-btn">🎨 提交 MJ 绘图</button>
        <div class="gen-status"></div>
      </div>
      <div class="zone-results">
        <div class="results-head">
          <span class="results-title">MJ 结果（可点 U/V 放大变体）</span>
          <div class="results-head-btns">
            <button class="btn btn-mini z-results-clear" title="清除展示（历史与缓存保留）">🗑 清除结果</button>
          </div>
        </div>
        <div class="results-grid"></div>
      </div>`;

    this._wireMjZone(zone);
    this._syncMjControls(zone);
    this.renderRefs(zone);
    this.renderMjResults(zone);
    return zone;
  },

  _wireMjZone(zone) {
    const el = zone.el;
    const d = zone.data;
    const q = (s) => el.querySelector(s);

    q('.node-del').addEventListener('click', () => {
      clearInterval(zone._timer);
      Canvas.removeNode(zone.id);
    });

    /* ✎ 改名（与生图区一致） */
    const startTitleRename = () => {
      const cur = q('.node-title');
      if (!cur) return;
      const input = document.createElement('input');
      input.className = 'node-title-input';
      input.value = d.title;
      input.maxLength = 40;
      cur.replaceWith(input);
      input.focus();
      input.select();
      let finished = false;
      const restore = (saved) => {
        if (finished) return;
        finished = true;
        const span = document.createElement('span');
        span.className = 'node-title';
        span.textContent = saved;
        input.replaceWith(span);
      };
      input.addEventListener('blur', () => {
        const nm = input.value.trim();
        if (nm) d.title = nm;
        restore(d.title);
        Canvas._scheduleSave();
        if (nm) App.toast(`MJ 生图区已重命名为「${d.title}」`, 'ok');
      });
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
        if (ev.key === 'Escape') { ev.preventDefault(); restore(d.title); }
      });
    };
    q('.node-edit').addEventListener('click', (e) => { e.stopPropagation(); startTitleRename(); });

    /* 模式 / 图片通道 / 任务类型 */
    q('.m-mode').addEventListener('change', (e) => { d.mode = e.target.value; Canvas._scheduleSave(); });
    q('.m-channel').addEventListener('change', (e) => { d.channel = e.target.value; Canvas._scheduleSave(); });
    q('.m-task-imagine').addEventListener('click', () => { d.taskType = 'imagine'; this._syncMjControls(zone); Canvas._scheduleSave(); });
    q('.m-task-blend').addEventListener('click', () => { d.taskType = 'blend'; this._syncMjControls(zone); Canvas._scheduleSave(); });

    /* 提示词 */
    const prompt = q('.m-prompt');
    prompt.value = d.prompt;
    prompt.addEventListener('input', () => { d.prompt = prompt.value; Canvas._scheduleSave(); });

    /* 参数下拉 */
    const arSel = q('.m-ar');
    this._fillSelect(arSel, this.RATIOS.map((r) => [r, r]).concat([['', '默认']]), d.ar);
    arSel.addEventListener('change', () => { d.ar = arSel.value; Canvas._scheduleSave(); });
    const vSel = q('.m-version');
    this._fillSelect(vSel, this.MJ_VERSIONS.map((v) => [v, v || '默认']), d.version);
    vSel.addEventListener('change', () => { d.version = vSel.value; Canvas._scheduleSave(); });
    const qSel = q('.m-quality');
    this._fillSelect(qSel, this.MJ_QUALITIES.map((v) => [v, v || '默认']), d.quality);
    qSel.addEventListener('change', () => { d.quality = qSel.value; Canvas._scheduleSave(); });
    q('.m-bot').addEventListener('change', (e) => { d.botType = e.target.value; Canvas._scheduleSave(); });
    q('.m-blend-dim').addEventListener('change', (e) => { d.dimensions = e.target.value; Canvas._scheduleSave(); });

    /* 高级设置 */
    const advToggle = q('.adv-toggle');
    const adv = q('.z-adv');
    advToggle.addEventListener('click', () => {
      d.advOpen = !d.advOpen;
      adv.hidden = !d.advOpen;
      advToggle.textContent = (d.advOpen ? '−' : '⚙') + ' 高级设置（镜头 / 光圈 / HD / Raw）';
    });
    const lensSel = q('.m-lens');
    this._fillSelect(lensSel, this.MJ_LENSES.map((v) => [v, v || '默认']), d.lens);
    lensSel.addEventListener('change', () => { d.lens = lensSel.value; Canvas._scheduleSave(); });
    const apSel = q('.m-aperture');
    this._fillSelect(apSel, this.MJ_APERTURES.map((v) => [v, v || '默认']), d.aperture);
    apSel.addEventListener('change', () => { d.aperture = apSel.value; Canvas._scheduleSave(); });
    q('.m-hd').addEventListener('change', (e) => { d.hd = e.target.checked; Canvas._scheduleSave(); });
    q('.m-raw').addEventListener('change', (e) => { d.raw = e.target.checked; Canvas._scheduleSave(); });
    /* 恢复勾选状态 */
    q('.m-hd').checked = !!d.hd;
    q('.m-raw').checked = !!d.raw;

    /* 参考图拖入 */
    const refsArea = q('.refs-area');
    refsArea.addEventListener('dragover', (e) => { e.preventDefault(); refsArea.classList.add('drag-over'); });
    refsArea.addEventListener('dragleave', () => refsArea.classList.remove('drag-over'));
    refsArea.addEventListener('drop', async (e) => {
      e.preventDefault();
      refsArea.classList.remove('drag-over');
      const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
      for (const f of files) await this._uploadAsRef(zone, f);
    });

    /* 提交 */
    q('.gen-btn').addEventListener('click', () => this.mjGenerate(zone));
    prompt.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) this.mjGenerate(zone);
    });

    /* 清除结果 */
    q('.z-results-clear').addEventListener('click', () => {
      if (!d.mjResults.length) return;
      if (!confirm('清除该 MJ 生图区展示的所有结果？\n（历史记录与本地缓存图片会保留）')) return;
      d.mjResults = [];
      this.renderMjResults(zone);
      Canvas._scheduleSave();
      App.toast('已清除 MJ 结果展示（历史与缓存保留）', 'ok');
    });
  },

  _syncMjControls(zone) {
    const el = zone.el;
    const d = zone.data;
    const q = (s) => el.querySelector(s);
    q('.m-task-imagine').classList.toggle('on', d.taskType === 'imagine');
    q('.m-task-blend').classList.toggle('on', d.taskType === 'blend');
    q('.m-blend-wrap').hidden = d.taskType !== 'blend';
    const promptWrap = q('.m-prompt').closest('div');
    if (d.taskType === 'blend') {
      promptWrap.hidden = true;
      q('.m-ar').closest('div').querySelector('.lbl').textContent = '画面比例 --ar（Blend 用下方比例）';
    } else {
      promptWrap.hidden = false;
    }
  },

  _setMjStatus(zone, state, text) {
    const el = zone.el.querySelector('.gen-status');
    const btn = zone.el.querySelector('.gen-btn');
    zone.data.status = { state, text };
    el.className = 'gen-status' + (state === 'err' ? ' err' : state === 'ok' ? ' ok' : '');
    el.textContent = text || '';
    btn.disabled = state === 'running';
    btn.innerHTML = state === 'running'
      ? '<span class="spin"></span>MJ 绘制中…'
      : '🎨 提交 MJ 绘图';
  },

  async mjGenerate(zone) {
    const d = zone.data;
    if (d.status && d.status.state === 'running') return;
    if (d.taskType === 'imagine' && !d.prompt.trim()) {
      this._setMjStatus(zone, 'err', '请输入提示词（Prompt）');
      return;
    }
    if (d.taskType === 'blend' && d.refIds.length === 0) {
      this._setMjStatus(zone, 'err', 'Blend 图生图需要至少一张参考图（垫图）');
      return;
    }

    const payload = {
      mode: d.mode,
      channel: d.channel,
      taskType: d.taskType,
      botType: d.botType,
      prompt: d.prompt.trim(),
      refIds: d.refIds.slice(),
      ar: d.ar || '',
      version: d.version || '',
      quality: d.quality || '',
      hd: !!d.hd,
      raw: !!d.raw,
      lens: d.lens || '',
      aperture: d.aperture || '',
      dimensions: d.dimensions,
    };

    const t0 = Date.now();
    this._setMjStatus(zone, 'running', '提交中… 0s');
    App.logTask('start', `MJ ${d.taskType === 'blend' ? 'Blend' : 'Imagine'} · 「${(d.prompt || '（图生图）').slice(0, 30)}」`);
    clearInterval(zone._timer);
    zone._timer = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      this._setMjStatus(zone, 'running', `MJ 排队/绘制中… ${s}s${s > 90 ? '（MJ 出图较慢，请耐心等待）' : ''}`);
    }, 1000);

    try {
      const res = await API.req('/api/mj/imagine', { method: 'POST', body: JSON.stringify(payload) });
      clearInterval(zone._timer);
      /* 四宫格：平台 CDN 分块逐张回传（images 数组），整次任务归为一组 */
      const imgs = Array.isArray(res.images) && res.images.length ? res.images : (res.image ? [res.image] : []);
      const baseLabel = `MJ·${d.taskType === 'blend' ? 'Blend' : 'Imagine'}`;
      const files = imgs.map((im, i) => Object.assign(
        { label: imgs.length > 1 ? `${baseLabel} ${i + 1}/${imgs.length}` : baseLabel },
        im,
      ));
      d.mjResults.unshift({ id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: Date.now(), label: baseLabel, prompt: d.prompt.slice(0, 300), files });
      this.renderMjResults(zone);
      this._setMjStatus(zone, 'ok', `✅ 完成 · 耗时 ${(res.ms / 1000).toFixed(1)}s · ${files.length} 张 · 可点 U/V 继续操作`);
      Canvas._scheduleSave();
      App.logTask('done', `MJ 完成 · ${d.taskType} · ${files.length} 张 · ${(res.ms / 1000).toFixed(1)}s`);
      App.refreshHistoryCount();
    } catch (e) {
      clearInterval(zone._timer);
      this._setMjStatus(zone, 'err', `❌ ${e.message}`);
      App.logTask('error', `MJ 失败 · ${d.taskType} · ${e.message}`);
      if (/API Key|Base URL|鉴权/.test(e.message)) App.hintSettings();
      App.refreshHistoryCount();
    }
  },

  async mjRunAction(zone, item, btn) {
    const d = zone.data;
    this._setMjStatus(zone, 'running', `执行操作中… ${btn.label || btn.customId}`);
    App.logTask('start', `MJ 操作 · ${btn.label || btn.customId}`);
    try {
      const res = await API.req('/api/mj/action', {
        method: 'POST',
        body: JSON.stringify({ taskId: item.taskId, customId: btn.customId, botType: d.botType, mode: d.mode, channel: d.channel }),
      });
      const imgs = Array.isArray(res.images) && res.images.length ? res.images : (res.image ? [res.image] : []);
      const label = `MJ·${btn.label || '操作'}`;
      d.mjResults.unshift({
        id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        ts: Date.now(),
        label,
        prompt: '',
        files: imgs.map((im) => Object.assign({ label }, im)),
      });
      this.renderMjResults(zone);
      this._setMjStatus(zone, 'ok', `✅ 操作完成（${btn.label || btn.customId}）`);
      Canvas._scheduleSave();
      App.logTask('done', `MJ 操作完成 · ${btn.label || btn.customId}`);
    } catch (e) {
      this._setMjStatus(zone, 'err', `❌ ${e.message}`);
      App.logTask('error', `MJ 操作失败 · ${e.message}`);
    }
  },

  /* MJ 结果区：按任务分组（与生图区一致），每组带「⤢ 到画布」 */
  renderMjResults(zone) {
    const d = zone.data;
    const wrap = zone.el.querySelector('.zone-results');
    const grid = zone.el.querySelector('.results-grid');
    wrap.classList.toggle('show', d.mjResults.length > 0);
    grid.innerHTML = '';
    d.mjResults.forEach((batch) => {
      const files = Array.isArray(batch.files) ? batch.files : [];
      if (!files.length) return;
      const t = new Date(batch.ts || 0);
      const timeStr = batch.ts
        ? `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`
        : '—';
      const sec = document.createElement('div');
      sec.className = 'result-batch';
      sec.innerHTML = `
        <div class="result-batch-head" title="${esc(batch.prompt || '')}">
          <span class="batch-title">${esc(batch.label || 'MJ 任务')} · ${files.length} 张</span>
          <button class="batch-place-all" data-batch-place title="把这组的图片全部放到画布上">⤢ 到画布</button>
          <span class="batch-time">${timeStr}</span>
        </div>
        <div class="result-batch-grid"></div>`;
      sec.querySelector('[data-batch-place]').addEventListener('click', () => {
        let placed = 0;
        for (const r of files) {
          const off = (d._placedCount || 0) % 5;
          Canvas.newImage(zone.x + 390 + off * 40, zone.y + 140 + off * 40, { src: r.url, cacheId: r.file, label: r.label || 'MJ 图' });
          d._placedCount = (d._placedCount || 0) + 1;
          placed++;
        }
        Canvas._scheduleSave();
        App.toast(`已把这组 ${placed} 张图片放到画布`, 'ok');
      });
      const bgrid = sec.querySelector('.result-batch-grid');
      files.forEach((r, i) => {
        const item = document.createElement('div');
        item.className = 'result-item';
        item.innerHTML = `
          <img src="${r.thumb || r.url}" alt="MJ 结果 ${i + 1}" loading="lazy" decoding="async">
          <span class="result-tag">#${i + 1}</span>
          <div class="result-actions">
            <button data-act="place" title="作为图片放到画布上">⤢ 到画布</button>
            <button data-act="ref" title="设为参考图">🎯 参考</button>
            <button data-act="dl" title="下载到本地">⬇</button>
          </div>`;
        const mrim = item.querySelector('img');
        mrim.addEventListener('click', () => App.openLightbox(r.url, `${batch.label || 'MJ 结果'} #${i + 1}`));
        if (!r.thumb) {
          App.setThumbImg(mrim, r.file, r.url, (tt) => {
            if (tt && tt !== r.url) { r.thumb = tt; Canvas._scheduleSave(); }
          });
        }
        item.querySelector('[data-act="place"]').addEventListener('click', () => {
          Canvas.newImage(zone.x + 390 + i * 40, zone.y + 140 + i * 40, { src: r.url, cacheId: r.file, label: r.label || 'MJ 图' });
          Canvas._scheduleSave();
        });
        item.querySelector('[data-act="ref"]').addEventListener('click', () => {
          if (!d.refIds.includes(r.file)) d.refIds.push(r.file);
          this.renderRefs(zone);
          Canvas._scheduleSave();
          App.toast('已设为该 MJ 生图区的参考图', 'ok');
        });
        item.querySelector('[data-act="dl"]').addEventListener('click', () => {
          downloadUrl(r.url, r.file.split('/').pop());
        });
        if (r.buttons && r.buttons.length) {
          const acts = document.createElement('div');
          acts.className = 'mj-actions';
          acts.innerHTML = '<span class="mj-actions-title">可执行操作：</span>';
          for (const b of r.buttons) {
            const chip = document.createElement('button');
            chip.textContent = `${b.emoji || ''} ${b.label || b.customId}`;
            chip.title = b.customId;
            chip.addEventListener('click', () => this.mjRunAction(zone, r, b));
            acts.appendChild(chip);
          }
          item.appendChild(acts);
        }
        bgrid.appendChild(item);
      });
      grid.appendChild(sec);
    });
  },
};
