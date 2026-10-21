/*!
 * 蓝晒 · AI 图片生成器 —— 界面逻辑（app.js）
 *
 * 一条主线：写下画面 → （可选）优化提示词 → 选画幅 / 风格 / 画质 → 曝光
 *          → 相纸上的小样显影 → 自动存档 → 随时下载。
 *
 * 这里只做「把状态画到界面上」和「把点击变成请求」两件事，
 * 提示词怎么拼、尺寸怎么换、模型能不能用，都以服务端为准 —— 界面不重复实现一遍。
 */
(function () {
  'use strict';

  const Api = window.LanShai;
  const Styles = window.LanShaiStyles;
  if (!Api || !Styles) {
    console.error('styles.js / api.js 没有加载成功，界面无法工作');
    return;
  }

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const PREF_KEY = 'lan-shai:prefs';

  const state = {
    presets: null,
    models: null,
    engine: null,
    ratio: '1:1',
    tier: '1K',
    styleId: 'photo',
    quality: 'medium',
    modelId: '',
    busy: false,
    optimizing: false,
    optimizedFrom: '',
    records: [],
    byId: new Map(),
    plates: new Map(),
    nextPlate: 1,
    viewer: null,
    lastFocus: null,
  };

  /* ── 小工具 ───────────────────────────────────────────── */

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function formatTime(ts) {
    const d = new Date(Number(ts) || Date.now());
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function sizeLabel(size) {
    const parsed = Styles.parseSize(String(size || ''));
    return parsed ? `${parsed.width} × ${parsed.height}` : String(size || '');
  }

  function ratioOf(size) {
    const parsed = Styles.parseSize(String(size || ''));
    return parsed ? (parsed.width / parsed.height).toFixed(4) : '1';
  }

  function debounce(fn, ms) {
    let timer = 0;
    return function run(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(null, args), ms);
    };
  }

  function loadPrefs() {
    try {
      const raw = window.localStorage.getItem(PREF_KEY);
      if (!raw) return {};
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  }

  function savePrefs() {
    try {
      window.localStorage.setItem(
        PREF_KEY,
        JSON.stringify({
          ratio: state.ratio,
          tier: state.tier,
          styleId: state.styleId,
          quality: state.quality,
          modelId: state.modelId,
        })
      );
    } catch {
      /* 隐私模式下写不了，不影响使用 */
    }
  }

  function toast(message, kind, ms) {
    const el = $('#toast');
    el.textContent = message;
    el.className = 'toast' + (kind ? ` toast--${kind}` : '');
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      el.hidden = true;
    }, ms || 4200);
  }

  function setNote(sel, text, kind) {
    const el = $(sel);
    if (!el) return;
    el.textContent = text || '';
    el.className = 'note' + (kind ? ` note--${kind}` : '');
    el.hidden = !text;
  }

  /* ── 画面描述 ─────────────────────────────────────────── */

  function currentPrompt() {
    return $('#prompt').value.trim();
  }

  function updatePromptCount() {
    const n = $('#prompt').value.length;
    $('#prompt-count').textContent = `${n} / 2000`;
  }

  function selectedStyle() {
    const list = (state.presets && state.presets.styles) || [];
    return list.find((s) => s.id === state.styleId) || list[0] || { id: 'photo', label: '摄影写实', en: '' };
  }

  function requestedSize() {
    return Styles.sizeOf(state.ratio, state.tier) || '1024x1024';
  }

  function selectedModel() {
    const list = (state.models && state.models.image) || [];
    return list.find((m) => m.id === state.modelId) || null;
  }

  /** 与服务端同一个函数拼（styles.js 前后端共用），预览不会和发出去的对不上 */
  function composeFinalPrompt() {
    return Styles.composePrompt(currentPrompt(), state.styleId, requestedSize());
  }

  function syncFinalPrompt() {
    const text = composeFinalPrompt();
    $('#final-prompt').textContent = text || '（还没写描述）';
  }

  /* ── 选择器 ───────────────────────────────────────────── */

  function chipButton(label, meta, pressed, onPick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.setAttribute('aria-pressed', String(Boolean(pressed)));
    btn.innerHTML = `<span>${esc(label)}</span>${meta ? `<span class="chip__meta">${esc(meta)}</span>` : ''}`;
    btn.addEventListener('click', onPick);
    return btn;
  }

  function segButton(label, pressed, onPick, title) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seg';
    btn.textContent = label;
    if (title) btn.title = title;
    btn.setAttribute('aria-pressed', String(Boolean(pressed)));
    btn.addEventListener('click', onPick);
    return btn;
  }

  function renderChoosers() {
    const presets = state.presets;
    if (!presets) return;

    const ratioGroup = $('#ratio-group');
    ratioGroup.innerHTML = '';
    presets.ratios.forEach((row) => {
      const btn = chipButton(row.label, row.ratio, row.ratio === state.ratio, () => {
        state.ratio = row.ratio;
        afterChoice();
      });
      btn.title = `${row.label} ${row.ratio} · ${sizeLabel(row.sizes[state.tier])}`;
      ratioGroup.appendChild(btn);
    });

    const tierGroup = $('#tier-group');
    tierGroup.innerHTML = '';
    presets.tiers.forEach((tier) => {
      tierGroup.appendChild(
        segButton(tier, tier === state.tier, () => {
          state.tier = tier;
          afterChoice();
        }, `${tier} 清晰度`)
      );
    });

    const styleGroup = $('#style-group');
    styleGroup.innerHTML = '';
    presets.styles.forEach((style) => {
      const btn = chipButton(style.label, '', style.id === state.styleId, () => {
        state.styleId = style.id;
        afterChoice();
      });
      btn.title = style.hint || style.label;
      styleGroup.appendChild(btn);
    });

    const qualityGroup = $('#quality-group');
    qualityGroup.innerHTML = '';
    presets.qualities.forEach((q) => {
      qualityGroup.appendChild(
        segButton(q.label, q.id === state.quality, () => {
          state.quality = q.id;
          afterChoice();
        }, q.note)
      );
    });
  }

  function afterChoice() {
    $$('#ratio-group .chip').forEach((btn, i) => {
      btn.setAttribute('aria-pressed', String(state.presets.ratios[i].ratio === state.ratio));
    });
    $$('#tier-group .seg').forEach((btn, i) => {
      btn.setAttribute('aria-pressed', String(state.presets.tiers[i] === state.tier));
    });
    $$('#style-group .chip').forEach((btn, i) => {
      btn.setAttribute('aria-pressed', String(state.presets.styles[i].id === state.styleId));
    });
    $$('#quality-group .seg').forEach((btn, i) => {
      btn.setAttribute('aria-pressed', String(state.presets.qualities[i].id === state.quality));
    });
    updateSizeLine();
    syncFinalPrompt();
    savePrefs();
  }

  function updateSizeLine() {
    const size = requestedSize();
    $('#size-preview').textContent = sizeLabel(size);
    const model = selectedModel();
    const rule = model && model.sizeRule;
    if (rule && rule.kind === 'fixed') {
      setNote('#size-note', `${model.id} 只有固定几档尺寸：${rule.allowed.map(sizeLabel).join(' / ')}。按下曝光会就近换成最接近的一档，界面上会写明换成了哪个。`, 'warn');
    } else {
      setNote('#size-note', '');
    }
    const quality = (state.presets.qualities || []).find((q) => q.id === state.quality);
    setNote('#quality-note', quality ? `当前：${quality.label} —— ${quality.note}` : '');
  }

  /* ── 模型 ─────────────────────────────────────────────── */

  function renderModels() {
    const select = $('#model-select');
    const info = state.models;
    select.innerHTML = '';

    if (!info || !info.live) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '离线显影引擎';
      select.appendChild(option);
      select.disabled = true;
      state.modelId = '';
      $('#verify-model').disabled = true;
      $('#model-line').textContent = (state.engine && state.engine.note) || '未接入上游模型，正在用离线显影引擎出图';
      $('#model-line').className = 'model__line mono note--warn';
      return;
    }

    select.disabled = false;
    $('#verify-model').disabled = false;

    const usable = (info.image || []).filter((m) => m.state !== 'unavailable');
    const blocked = (info.image || []).filter((m) => m.state === 'unavailable');

    if (!usable.length && !blocked.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '没有认出来能出图的模型';
      select.appendChild(option);
      select.disabled = true;
    }

    usable.forEach((model) => {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = `${model.id}${model.state === 'verified' ? ' · 已验证' : ' · 待检测'}`;
      select.appendChild(option);
    });

    if (blocked.length) {
      const group = document.createElement('optgroup');
      group.label = `检测没通过（${blocked.length}）`;
      blocked.forEach((model) => {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = `${model.id} · 调不通`;
        option.title = model.note || '';
        option.disabled = true;
        group.appendChild(option);
      });
      select.appendChild(group);
    }

    const keep = state.modelId && usable.some((m) => m.id === state.modelId) ? state.modelId : null;
    const preferred =
      keep ||
      (info.current && usable.some((m) => m.id === info.current) ? info.current : '') ||
      (usable[0] ? usable[0].id : '');
    state.modelId = preferred;
    select.value = preferred;

    const counts = info.counts || {};
    const parts = [];
    if (info.source === 'upstream') {
      parts.push(`上游 ${counts.all} 个模型`);
      parts.push(`能出图 ${counts.image} 个`);
    } else if (info.source === 'known') {
      parts.push('账号列表里没认出能出图的模型');
      parts.push(`先按平台文档列 ${counts.image} 个`);
    }
    parts.push(`已验证 ${counts.verified || 0} 个`);
    if (counts.unavailable) parts.push(`调不通 ${counts.unavailable} 个`);
    if (info.chat && info.chat.model) {
      parts.push(`优化提示词用 ${info.chat.model}${info.chat.verified ? '' : '（未实测）'}`);
    }
    $('#model-line').textContent = parts.join(' · ') + (info.note ? ` —— ${info.note}` : '');
    $('#model-line').className = 'model__line mono' + (info.error ? ' note--warn' : '');

    updateSizeLine();
  }

  function renderEngine() {
    const engine = state.engine || {};
    const badge = $('#engine-badge');
    const live = Boolean(engine.live);
    badge.className = 'pill ' + (live ? 'pill--live' : 'pill--offline');
    badge.textContent = live ? '上游出图' : '离线显影';
    badge.title = live ? `上游：${engine.baseUrl}（Key 来自 ${engine.keyFrom}）` : engine.note || '';
  }

  async function refreshModels(force) {
    try {
      const info = await Api.models(force);
      state.models = info;
      renderModels();
      return info;
    } catch (err) {
      state.models = { ok: false, live: (state.engine && state.engine.live) || false, image: [], counts: {}, error: err.message };
      renderModels();
      $('#model-line').textContent = '取模型列表失败：' + err.message;
      return null;
    }
  }

  async function verifySelected() {
    const model = state.modelId;
    if (!model) {
      toast('先选一个模型', 'error');
      return;
    }
    const ok = window.confirm(
      `检测「${model}」会真的生成一张最低画质的图（1024×1024、低画质），会消耗一点额度。继续？`
    );
    if (!ok) return;
    const btn = $('#verify-model');
    btn.disabled = true;
    btn.textContent = '检测中…';
    try {
      const out = await Api.verifyModel(model);
      toast(`${model}：${out.message || '调通了'}`, out.ok ? 'ok' : 'error', 6000);
    } catch (err) {
      toast(`${model}：${err.message}`, 'error', 8000);
    } finally {
      btn.disabled = false;
      btn.textContent = '检测';
      await refreshModels(false);
    }
  }

  /* ── 相纸（出图） ─────────────────────────────────────── */

  function plateNumber(id) {
    if (!state.plates.has(id)) {
      state.plates.set(id, state.nextPlate);
      state.nextPlate += 1;
    }
    return state.plates.get(id);
  }

  /**
   * 这张图的地址。
   * 正常情况下指向我们自己的 /api/images/<file>；如果当时没存到本地（只拿到上游的临时链接），
   * 就退回那个链接 —— 宁可显示一个会过期的地址，也别让已经付过钱的图凭空消失。
   */
  function imageSrc(record) {
    if (record && record.file) return Api.imageUrl(record.file);
    if (record && /^https?:\/\//i.test(record.remoteUrl || '')) return record.remoteUrl;
    return '';
  }

  function isRemoteOnly(record) {
    return Boolean(record && !record.file && /^https?:\/\//i.test(record.remoteUrl || ''));
  }

  function frameImageMarkup(record) {
    const src = imageSrc(record);
    if (!src) return '';
    return `<img src="${esc(src)}" alt="${esc(record.prompt)}" loading="lazy" decoding="async">`;
  }

  function frameElement(record, options) {
    const opts = options || {};
    const plate = plateNumber(record.id);
    const el = document.createElement('article');
    el.className = 'frame' + (opts.fresh ? ' frame--fresh' : '');
    el.dataset.id = record.id;

    const meta = [
      sizeLabel(record.size && record.size.actual),
      record.style && record.style.label ? record.style.label : '',
      record.quality ? `画质 ${record.quality}` : '',
      record.elapsedMs ? `${(record.elapsedMs / 1000).toFixed(1)}s` : '',
    ].filter(Boolean);

    const notes = Array.isArray(record.notes) ? record.notes.filter(Boolean) : [];

    el.innerHTML = `
      <div class="frame__perf" aria-hidden="true"></div>
      <div class="frame__body">
        <header class="frame__head">
          <span class="frame__plate mono">PLATE ${pad2(plate)}</span>
          <span class="frame__engine mono">${esc(record.model || '')}</span>
        </header>
        <button class="frame__image" type="button" data-act="view" style="--frame-ratio:${ratioOf(record.size && record.size.actual)}" aria-label="看大图">
          ${frameImageMarkup(record)}
        </button>
        <p class="frame__prompt">${esc(record.prompt)}</p>
        <p class="frame__meta mono">${esc(meta.join(' · '))}</p>
        <p class="frame__meta mono">${formatTime(record.createdAt)} · ${record.engine === 'offline' ? '离线显影' : '上游出图'}</p>
        ${notes.length ? `<p class="frame__note">${esc(notes.join('；'))}</p>` : ''}
        <div class="frame__actions">
          <button class="btn btn--tiny btn--ghost" type="button" data-act="download">${isRemoteOnly(record) ? '打开原图' : '下载'}</button>
          <button class="btn btn--tiny btn--ghost" type="button" data-act="copy">复制描述</button>
          <button class="btn btn--tiny btn--danger" type="button" data-act="delete">删除</button>
        </div>
      </div>`;
    return el;
  }

  function developingElement(payload) {
    const el = document.createElement('article');
    el.className = 'frame frame--developing';
    el.dataset.busy = '1';
    const style = selectedStyle();
    el.innerHTML = `
      <div class="frame__perf" aria-hidden="true"></div>
      <div class="frame__body">
        <header class="frame__head">
          <span class="frame__plate mono">PLATE --</span>
          <span class="frame__engine mono">${esc(payload.model || '离线显影引擎')}</span>
        </header>
        <div class="frame__image" style="--frame-ratio:${ratioOf(payload.size)}">
          <div class="develop" aria-hidden="true">
            <span class="develop__sweep"></span>
            <span class="develop__label">显影中</span>
          </div>
        </div>
        <p class="frame__prompt">${esc(payload.prompt)}</p>
        <p class="frame__meta mono">${sizeLabel(payload.size)} · ${esc(style.label)} · 正在等上游出图</p>
      </div>`;
    return el;
  }

  function updateCounts(stats) {
    const list = stats || state.stats || { count: state.records.length, bytes: 0 };
    $('#sheet-count').textContent = String(list.count || 0);
    $('#sheet-size').textContent = list.bytes ? `· ${formatBytes(list.bytes)}` : '';
    $('#history-count').textContent = String(list.count || 0);
    $('#empty').hidden = state.records.length > 0;
  }

  async function generate() {
    if (state.busy) return;
    const prompt = currentPrompt();
    if (prompt.length < 2) {
      toast('先写一句你想看到的画面，再按「曝光」', 'error');
      $('#prompt').focus();
      return;
    }

    state.busy = true;
    const btn = $('#generate');
    const label = $('.btn__label', btn);
    btn.disabled = true;
    label.textContent = '显影中…';
    const startedAt = Date.now();
    const hint = $('#generate-hint');
    hint.textContent = '0s';
    const timer = setInterval(() => {
      hint.textContent = `${Math.round((Date.now() - startedAt) / 1000)}s`;
    }, 500);

    const size = requestedSize();
    const placeholder = developingElement({ prompt, size, model: state.modelId || (state.models && !state.models.live ? '离线显影引擎' : '') });
    $('#frames').prepend(placeholder);
    $('#empty').hidden = true;

    try {
      const out = await Api.generate({
        prompt,
        styleId: state.styleId,
        size,
        quality: state.quality,
        model: state.modelId || undefined,
      });
      placeholder.remove();
      state.records.unshift(out.record);
      state.byId.set(out.record.id, out.record);
      $('#frames').prepend(frameElement(out.record, { fresh: true }));
      state.stats = { count: (state.stats ? state.stats.count : 0) + 1, bytes: ((state.stats && state.stats.bytes) || 0) + (out.record.bytes || 0) };
      updateCounts();
      const note = (out.notes || []).filter(Boolean).join('；');
      if (out.remoteOnly) {
        toast(`出图完成，但${note || '这张没存到本地'}`, 'error', 10000);
      } else {
        toast(note ? `出图完成 —— ${note}` : '出图完成，已存进历史', 'ok', 6000);
      }
      // 模型可用性可能刚刚变了（成功 = 已验证），顺手刷一下下拉框上的标记
      refreshModels(false);
    } catch (err) {
      placeholder.remove();
      updateCounts();
      toast(err.message || '出图失败', 'error', 9000);
      if (err.code === 'model_unavailable') refreshModels(false);
    } finally {
      clearInterval(timer);
      state.busy = false;
      btn.disabled = false;
      label.textContent = '曝光';
      hint.textContent = '';
    }
  }

  /* ── 优化提示词 ───────────────────────────────────────── */

  async function optimizePrompt() {
    if (state.optimizing) return;
    const before = currentPrompt();
    if (before.length < 2) {
      toast('先写一句描述，再让 AI 帮你扩写', 'error');
      $('#prompt').focus();
      return;
    }

    state.optimizing = true;
    const btn = $('#optimize');
    btn.disabled = true;
    btn.textContent = '扩写中…';
    setNote('#optimize-note', '');
    try {
      const out = await Api.optimize({ prompt: before, styleId: state.styleId, size: requestedSize() });
      state.optimizedFrom = out.before || before;
      $('#prompt').value = out.prompt;
      $('#revert-prompt').hidden = false;
      updatePromptCount();
      syncFinalPrompt();
      const head = out.engine === 'live' ? `已由 ${out.model} 扩写` : '已离线扩写';
      const detail = [out.notes, out.note].filter(Boolean).join('；');
      setNote('#optimize-note', head + (detail ? `：${detail}` : ''), out.engine === 'live' ? 'ok' : '');
    } catch (err) {
      setNote('#optimize-note', err.message || '优化失败', 'error');
      toast(err.message || '优化失败', 'error', 7000);
    } finally {
      state.optimizing = false;
      btn.disabled = false;
      btn.textContent = '✦ 优化提示词';
    }
  }

  /* ── 历史记录 ─────────────────────────────────────────── */

  async function loadHistory() {
    try {
      const out = await Api.history.list({ limit: 60 });
      state.stats = out.stats || { count: out.total, bytes: 0 };
      state.records = out.items.slice();
      state.byId = new Map(state.records.map((r) => [r.id, r]));
      // 编号按时间顺序给：PLATE 01 是最早的一张，像印相纸上按顺序排的小样
      const ascending = out.items.slice().sort((a, b) => a.createdAt - b.createdAt);
      state.plates = new Map();
      state.nextPlate = 1;
      ascending.forEach((r) => plateNumber(r.id));
      $('#frames').innerHTML = '';
      state.records
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt)
        .forEach((r) => $('#frames').appendChild(frameElement(r)));
      updateCounts(state.stats);
    } catch (err) {
      setNote('#optimize-note', '');
      $('#empty').hidden = false;
      toast('历史记录读不了：' + err.message, 'error', 7000);
    }
  }

  async function removeRecord(id) {
    if (!window.confirm('删掉这张？图片文件也会一起删除。')) return;
    try {
      await Api.history.remove(id);
      state.records = state.records.filter((r) => r.id !== id);
      state.byId.delete(id);
      const frame = $(`.frame[data-id="${id}"]`);
      if (frame) frame.remove();
      const row = $(`.hist[data-id="${id}"]`);
      if (row) row.remove();
      state.stats = {
        count: Math.max(0, (state.stats ? state.stats.count : 1) - 1),
        bytes: state.stats ? state.stats.bytes : 0,
      };
      updateCounts();
      renderHistoryList();
      if (state.viewer && state.viewer.id === id) closeViewer();
      toast('已删除', 'ok');
    } catch (err) {
      toast(err.message || '删除失败', 'error');
    }
  }

  async function clearHistory() {
    if (!window.confirm('清空全部历史？图片文件也会一起删除，不能撤销。')) return;
    try {
      const out = await Api.history.clear();
      state.records = [];
      state.byId.clear();
      state.plates = new Map();
      state.nextPlate = 1;
      state.stats = { count: 0, bytes: 0 };
      $('#frames').innerHTML = '';
      updateCounts();
      renderHistoryList();
      toast(`已清空 ${out.removed || 0} 张`, 'ok');
    } catch (err) {
      toast(err.message || '清空失败', 'error');
    }
  }

  function histRow(record) {
    const el = document.createElement('div');
    el.className = 'hist';
    el.dataset.id = record.id;
    el.innerHTML = `
      <button class="hist__thumb" type="button" data-act="view" aria-label="看大图">
        <img src="${esc(imageSrc(record))}" alt="" loading="lazy">
      </button>
      <div class="hist__body">
        <p class="hist__prompt">${esc(record.prompt)}</p>
        <p class="hist__meta mono">${esc(sizeLabel(record.size && record.size.actual))} · ${esc(record.style && record.style.label)} · ${esc(record.model || '')} · ${formatTime(record.createdAt)}</p>
        <div class="hist__actions">
          <button class="btn btn--tiny btn--ghost" type="button" data-act="download">${isRemoteOnly(record) ? '打开原图' : '下载'}</button>
          <button class="btn btn--tiny btn--danger" type="button" data-act="delete">删除</button>
        </div>
      </div>`;
    return el;
  }

  async function renderHistoryList(query) {
    const list = $('#history-list');
    const empty = $('#history-empty');
    let items;
    if (query) {
      try {
        const out = await Api.history.list({ q: query, limit: 60 });
        items = out.items;
      } catch {
        items = state.records.filter((r) => `${r.prompt} ${r.model}`.toLowerCase().includes(String(query).toLowerCase()));
      }
    } else {
      items = state.records.slice().sort((a, b) => b.createdAt - a.createdAt);
    }
    list.innerHTML = '';
    items.forEach((record) => {
      state.byId.set(record.id, record);
      plateNumber(record.id);
      list.appendChild(histRow(record));
    });
    empty.hidden = items.length > 0;
  }

  function openDrawer() {
    state.lastFocus = document.activeElement;
    $('#history-drawer').hidden = false;
    renderHistoryList($('#history-search').value.trim());
    $('#history-search').focus();
  }

  function closeDrawer() {
    $('#history-drawer').hidden = true;
    if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
  }

  /* ── 看大图 ───────────────────────────────────────────── */

  function openViewer(record) {
    if (!record) return;
    state.lastFocus = document.activeElement;
    state.viewer = record;
    const img = $('#viewer-image');
    img.src = imageSrc(record);
    img.alt = record.prompt || '';
    const meta = [
      sizeLabel(record.size && record.size.actual),
      record.style && record.style.label,
      record.quality ? `画质 ${record.quality}` : '',
      record.model,
      formatTime(record.createdAt),
    ].filter(Boolean);
    $('#viewer-caption').textContent = `${meta.join(' · ')} —— ${record.prompt}`;
    $('#viewer-download').textContent = isRemoteOnly(record) ? '打开原图' : '下载这张';
    $('#viewer').hidden = false;
    $('#viewer-download').focus();
  }

  function closeViewer() {
    $('#viewer').hidden = true;
    state.viewer = null;
    if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
  }

  /* ── 动作：下载 / 复制 ───────────────────────────────── */

  function download(record) {
    if (!record) return;
    if (isRemoteOnly(record)) {
      // 没存到本地：只能把上游那个临时链接打开，让人自己另存 —— 并说清为什么
      window.open(record.remoteUrl, '_blank', 'noopener');
      toast('这张没存到本地，已打开上游临时链接（可能会过期）；要长期保存请右键另存', 'error', 7000);
      return;
    }
    const a = document.createElement('a');
    a.href = Api.downloadUrl(record.id);
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function copyPrompt(record) {
    const text = (record && (record.optimized && record.optimized.prompt ? record.optimized.prompt : record.prompt)) || '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast('描述已复制', 'ok', 2400);
    } catch {
      toast('复制失败：浏览器不允许写剪贴板', 'error', 5000);
    }
  }

  /* ── 事件 ─────────────────────────────────────────────── */

  function bindEvents() {
    $('#prompt').addEventListener('input', () => {
      updatePromptCount();
      syncFinalPrompt();
    });

    $('#optimize').addEventListener('click', optimizePrompt);
    $('#revert-prompt').addEventListener('click', () => {
      if (!state.optimizedFrom) return;
      $('#prompt').value = state.optimizedFrom;
      $('#revert-prompt').hidden = true;
      setNote('#optimize-note', '已还原成你原来写的那句');
      updatePromptCount();
      syncFinalPrompt();
    });

    $('#generate').addEventListener('click', generate);
    $('#verify-model').addEventListener('click', verifySelected);

    $('#model-select').addEventListener('change', (event) => {
      state.modelId = event.target.value;
      updateSizeLine();
      savePrefs();
    });

    $('#open-history').addEventListener('click', openDrawer);
    $('#history-clear').addEventListener('click', clearHistory);
    $('#history-search').addEventListener(
      'input',
      debounce((event) => renderHistoryList(event.target.value.trim()), 260)
    );

    // 点相纸 / 历史里的操作按钮（事件委托：相纸会一直加新卡片）
    document.addEventListener('click', (event) => {
      const act = event.target.closest('[data-act]');
      const close = event.target.closest('[data-close]');
      if (close) {
        if (close.dataset.close === 'viewer') closeViewer();
        if (close.dataset.close === 'drawer') closeDrawer();
        return;
      }
      if (!act) return;
      const holder = act.closest('.frame, .hist');
      if (!holder) return;
      const record = state.byId.get(holder.dataset.id);
      if (!record) return;
      const kind = act.dataset.act;
      if (kind === 'view') openViewer(record);
      else if (kind === 'download') download(record);
      else if (kind === 'copy') copyPrompt(record);
      else if (kind === 'delete') removeRecord(record.id);
    });

    $('#viewer-download').addEventListener('click', () => download(state.viewer));
    $('#viewer-copy').addEventListener('click', () => copyPrompt(state.viewer));

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (!$('#viewer').hidden) {
          closeViewer();
          return;
        }
        if (!$('#history-drawer').hidden) closeDrawer();
        return;
      }
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key === 'Enter') {
        event.preventDefault();
        if (!$('#generate').disabled) generate();
      }
    });
  }

  /* ── 启动 ─────────────────────────────────────────────── */

  async function boot() {
    bindEvents();
    updatePromptCount();

    let health;
    try {
      health = await Api.health();
    } catch (err) {
      $('#engine-badge').className = 'pill pill--offline';
      $('#engine-badge').textContent = '连不上服务';
      $('#model-line').textContent = err.message;
      $('#model-line').className = 'model__line mono note--error';
      $('#generate').disabled = true;
      toast(err.message, 'error', 12000);
      return;
    }

    // 尺寸表 / 风格表 / 提示词拼法来自共用的 styles.js，不跟后端要一份 JSON
    state.presets = Styles.listPresets();
    state.engine = health.engine;
    renderEngine();

    const prefs = loadPrefs();
    const preset = state.presets;
    const hasRatio = (prefs.ratio && preset.ratios.some((r) => r.ratio === prefs.ratio));
    state.ratio = hasRatio ? prefs.ratio : preset.defaultRatio || '1:1';
    state.tier = preset.tiers.includes(prefs.tier) ? prefs.tier : preset.defaultTier;
    state.styleId = preset.styles.some((s) => s.id === prefs.styleId) ? prefs.styleId : preset.defaultStyle;
    state.quality = preset.qualities.some((q) => q.id === prefs.quality) ? prefs.quality : preset.defaultQuality;
    state.modelId = prefs.modelId || '';

    renderChoosers();
    updateSizeLine();
    syncFinalPrompt();

    await refreshModels(false);
    await loadHistory();

    if (state.engine && state.engine.live && (state.models && state.models.source === 'known')) {
      toast('账号列表里没认出能出图的模型，先按平台文档列了几个；点「检测」确认哪个真的能用', 'error', 9000);
    }
  }

  boot();
})();
