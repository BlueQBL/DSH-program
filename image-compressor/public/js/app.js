/* ============================================================
   图片压缩工具 · 前端逻辑
   拖放上传 -> 质量调节 -> 对比结果 -> 单张/批量下载
   ============================================================ */
'use strict';

(() => {
  // ---------------- DOM ----------------
  const $ = (sel) => document.querySelector(sel);
  const dropzone = $('#dropzone');
  const fileInput = $('#file-input');
  const pickBtn = $('#pick-btn');
  const qualityRange = $('#quality-range');
  const qualityValue = $('#quality-value');
  const presetsBox = document.querySelector('.presets');
  const progressBox = $('#progress-box');
  const progressFill = $('#progress-fill');
  const progressPct = $('#progress-pct');
  const progressLabel = $('#progress-label');
  const summary = $('#summary');
  const cardsEl = $('#cards');
  const emptyState = $('#empty-state');
  const toastEl = $('#toast');
  const btnRecompress = $('#btn-recompress');
  const btnZip = $('#btn-zip');

  const sumCount = $('#sum-count');
  const sumOriginal = $('#sum-original');
  const sumCompressed = $('#sum-compressed');
  const sumSaved = $('#sum-saved');

  // ---------------- 状态 ----------------
  const ACCEPT_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.bmp', '.tif', '.tiff'];
  const MAX_FILES = 20;

  const session = {
    token: null,
    items: [],          // { originalUrl, file, name, downloadName, ...result }
    busy: false,
  };

  // ---------------- 工具函数 ----------------
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function fmtPct(n) {
    return `${(Number(n) || 0).toFixed(1)}%`;
  }

  const extOf = (name) => ('.' + (name.split('.').pop() || '').toLowerCase());

  /** 清理文件名主体：去掉异常字符、合并连续下划线、去掉首尾分隔符 */
  function cleanBase(s) {
    return String(s == null ? '' : s)
      .replace(/\.[^.]+$/, '')            // 去掉扩展名，便于统一加后缀
      .replace(/[^\w\u4e00-\u9fa5 .\-()（）【】\[\]]/g, ' ')   // 非法字符 -> 空格
      .replace(/_+/g, '_')                 // 连续下划线合并
      .replace(/\s{2,}/g, ' ')             // 连续空格合并
      .replace(/^[\s_.\-]+|[\s_.\-]+$/g, '')
      .trim();
  }

  /** 下载命名：原文件名主体 + _压缩 + 实际输出格式后缀（与 zip 保持一致） */
  function downloadName(item) {
    const src = item.originalName || item.name || 'image';
    const base = cleanBase(src) || 'image';
    const ext = extOf(item.fileName || src);
    return `${base}_压缩${ext}`;
  }

  let toastTimer = null;
  function toast(msg, kind = 'success', ms = 3200) {
    toastEl.textContent = '';
    const span = document.createElement('span');
    span.textContent = msg;
    toastEl.appendChild(span);
    toastEl.className = `toast show is-${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.classList.remove('show'); }, ms);
  }

  // ---------------- 质量滑杆 ----------------
  const PRESETS = [85, 70, 40];
  function setQuality(q) {
    q = Math.min(100, Math.max(1, Math.round(Number(q) || 70)));
    qualityRange.value = q;
    qualityValue.textContent = `${q}%`;
    const fill = ((q - 1) / 99) * 100;
    qualityRange.style.setProperty('--fill', `${fill}%`);
    document.querySelectorAll('.preset').forEach((p) => {
      p.classList.toggle('is-active', Number(p.dataset.quality) === q);
    });
  }
  qualityRange.addEventListener('input', () => setQuality(qualityRange.value));
  presetsBox.addEventListener('click', (e) => {
    const p = e.target.closest('.preset');
    if (p) setQuality(Number(p.dataset.quality));
  });

  // ---------------- 汇总 ----------------
  function refreshSummary() {
    const ok = session.items.filter((i) => !i.error);
    if (!session.token || ok.length === 0) { summary.hidden = true; return; }
    summary.hidden = false;
    const orig = ok.reduce((a, i) => a + i.originalSize, 0);
    const comp = ok.reduce((a, i) => a + i.compressedSize, 0);
    const saved = orig - comp;
    sumCount.textContent = ok.length;
    sumOriginal.textContent = fmtBytes(orig);
    sumCompressed.textContent = fmtBytes(comp);
    sumSaved.textContent = saved >= 0 ? `-${fmtPct((saved / orig) * 100)}` : fmtBytes(-saved);
  }

  // ---------------- 渲染 ----------------
  function renderItems(entering = true) {
    cardsEl.innerHTML = '';
    emptyState.hidden = session.items.length > 0;
    session.items.forEach((item, idx) => {
      cardsEl.appendChild(buildCard(item, idx, entering));
    });
    if (session.items.length) {
      requestAnimationFrame(() => {
        cardsEl.querySelectorAll('.compare').forEach(bindCompare);
        cardsEl.querySelectorAll('.meter i').forEach((el) => {
          // 等下一帧再填充宽度，触发过渡动画
          setTimeout(() => { el.style.width = el.dataset.w; }, 60);
        });
      });
    }
    refreshSummary();
  }

  function fmtDims(w, h) {
    return Number(w) && Number(h) ? `${w} × ${h}` : '';
  }

  function buildCard(item, idx, entering) {
    const delay = entering ? Math.min(idx * 45, 540) : 0;
    const art = document.createElement('article');
    art.className = 'card result-card' + (item.error ? ' has-error' : '') + (entering ? ' is-entering' : '');
    art.style.animationDelay = `${delay}ms`;

    if (item.error) {
      art.innerHTML = `
        <div class="rc-body" style="align-items:center;text-align:center;padding:34px 20px">
          <div class="error-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 8v5m0 3.5v.5M12 21a9 9 0 1 1 9-9" opacity=".0"/><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7.5V13m0 3.6v.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </div>
          <p class="error-text">${esc(item.error)}</p>
          <p class="error-name">${esc(item.originalName || item.name)}</p>
        </div>`;
      return art;
    }

    const saved = item.savedPercent;             // 可为负（反而变大）
    const isBad = saved < 0;
    const ratio = item.originalSize > 0 ? Math.max(0, Math.min(1, (item.savedBytes / item.originalSize))) : 0;
    const dim = fmtDims(item.originalWidth, item.originalHeight);
    const dimAfter = fmtDims(item.width, item.height);
    const convChip = item.converted
      ? `<span class="chip chip-warn" title="原格式不可直接有损压缩，已转为 PNG">转 PNG</span>` : '';

    art.innerHTML = `
      <div class="compare" role="slider" tabindex="0" aria-label="按住左右拖动对比原图与压缩效果"
           aria-valuemin="6" aria-valuemax="94" aria-valuenow="50" style="--x:50%">
        <img class="cmp-img cmp-before" alt="原图 ${esc(item.name)}" src="${esc(item.originalUrl)}" loading="lazy" />
        <img class="cmp-img cmp-after"  alt="压缩后 ${esc(item.downloadName)}" src="${esc(item.url)}" loading="lazy" />
        <div class="cmp-divider"><span class="cmp-handle" aria-hidden="true"></span></div>
        <span class="cmp-tag cmp-tag-before">原图</span>
        <span class="cmp-tag cmp-tag-after">压缩后</span>
      </div>
      <div class="rc-body">
        <div class="rc-head">
          <div class="rc-name">
            <span class="chip">${esc(item.format || extOf(item.fileName).slice(1)).toUpperCase()}</span>
            ${convChip}
            <span class="fname" title="${esc(item.name)}">${esc(item.name)}</span>
          </div>
          ${isBad
            ? `<span class="rc-save bad">变大 +${fmtPct(-saved)}</span>`
            : `<span class="rc-save">-${fmtPct(saved)}</span>`}
        </div>
        <div class="rc-sizes">
          <div class="size-cell">
            <b>${fmtBytes(item.originalSize)}</b>
            <span class="dim">${dim}</span>
          </div>
          <svg class="rc-arrow" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 12h15m0 0-5-5m5 5-5 5"/></svg>
          <div class="size-cell is-new">
            <b>${fmtBytes(item.compressedSize)}</b>
            <span class="dim">${dimAfter}</span>
          </div>
        </div>
        <div class="meter ${isBad ? 'meter-bad' : ''}">
          <i data-w="${(ratio * 100).toFixed(1)}%"></i>
        </div>
        <div class="rc-foot">
          ${isBad
            ? '<span class="rc-note">画质无损时体积可能不降，可尝试调低质量</span>'
            : `<span class="rc-note good">${esc(item.name)}：节省 ${fmtBytes(item.savedBytes)}</span>`}
          <a class="btn btn-ghost btn-small dl-link" href="${esc(item.url)}" download="${esc(item.downloadName)}" title="下载压缩后的 ${esc(item.downloadName)}">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5M4 19h16"/></svg>
            下载
          </a>
        </div>
      </div>`;
    return art;
  }

  // ---------------- 对比滑块 ----------------
  function bindCompare(el) {
    let dragging = false;
    const setX = (clientX) => {
      const r = el.getBoundingClientRect();
      let pct = ((clientX - r.left) / r.width) * 100;
      pct = Math.min(94, Math.max(6, pct));
      el.style.setProperty('--x', `${pct}%`);
      el.setAttribute('aria-valuenow', Math.round(pct));
    };
    const onMove = (e) => { if (dragging) setX(e.clientX); };
    const stop = () => { dragging = false; document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', stop); };
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      dragging = true;
      setX(e.clientX);
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', stop);
    });
    el.addEventListener('keydown', (e) => {
      const cur = Number(el.getAttribute('aria-valuenow') || 50);
      let next = null;
      if (e.key === 'ArrowLeft') next = cur - 6;
      if (e.key === 'ArrowRight') next = cur + 6;
      if (e.key === 'Home') next = 6;
      if (e.key === 'End') next = 94;
      if (next != null) {
        e.preventDefault();
        el.style.setProperty('--x', `${Math.min(94, Math.max(6, next))}%`);
        el.setAttribute('aria-valuenow', Math.round(next));
      }
    });
  }

  // ---------------- 上传请求 ----------------
  function uploadFiles(files) {
    if (session.busy) return;
    if (!files || files.length === 0) return;

    session.busy = true;
    setBusy(true);

    const q = Number(qualityRange.value);
    const fd = new FormData();
    if (session.token) fd.append('token', session.token); // 追加到已有会话
    fd.append('quality', String(q));
    files.forEach((f) => fd.append('files', f, f.name));

    progressBox.hidden = false;
    progressFill.style.width = '0%';
    progressPct.textContent = '0%';
    progressLabel.textContent = `正在上传 ${files.length} 张并压缩…`;

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/compress');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const p = Math.round((e.loaded / e.total) * 100);
        progressFill.style.width = `${p}%`;
        progressPct.textContent = `${p}%`;
        progressLabel.textContent = p < 100 ? `正在上传 ${files.length} 张图片…` : '已上传，正在压缩处理…';
      }
    };
    xhr.onload = () => {
      progressBox.hidden = true;
      setBusy(false);
      let res = null;
      try { res = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300 && res && res.ok) {
        handleBatchResult(res, files);
      } else {
        session.busy = false;
        toast((res && res.message) || '压缩失败，请稍后重试', 'error');
      }
    };
    xhr.onerror = () => {
      progressBox.hidden = true;
      setBusy(false);
      session.busy = false;
      toast('网络异常，无法连接服务，请确认后端已启动', 'error');
    };
    xhr.send(fd);
  }

  function handleBatchResult(res, files) {
    session.token = res.token;
    let added = 0;
    res.results.forEach((r) => {
      const file = files[r.index];
      const item = {
        originalUrl: file ? URL.createObjectURL(file) : null,
        file: file || null,
        name: file ? file.name : r.originalName,
        originalName: r.originalName || (file && file.name),
        fileName: r.fileName,
        downloadName: downloadName(r),
        error: r.error || null,
        originalSize: r.originalSize,
        compressedSize: r.compressedSize,
        savedBytes: r.savedBytes,
        savedPercent: r.savedPercent,
        format: r.format,
        converted: r.converted,
        originalWidth: r.originalWidth,
        originalHeight: r.originalHeight,
        width: r.width,
        height: r.height,
        url: r.url,
      };
      session.items.push(item);
      added++;
    });

    const errCount = session.items.filter((i) => i.error).length;
    renderItems();
    const okSaved = session.items.filter((i) => !i.error)
      .reduce((a, i) => a + (i.savedBytes > 0 ? i.savedBytes : 0), 0);

    if (errCount) {
      toast(`完成：成功 ${session.items.length - errCount} 张，失败 ${errCount} 张（详见卡片）`, 'error');
    } else {
      toast(`已压缩 ${added} 张，本次共节省 ${fmtBytes(okSaved)}`, 'success');
    }
    // 让结果区自然进入视野（如果屏幕够大则原地不动）
    requestAnimationFrame(() => {
      if (summary && !summary.hidden) {
        const r = summary.getBoundingClientRect();
        if (r.bottom > window.innerHeight * 0.9) {
          summary.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    });
  }

  // ---------------- 重新压缩 ----------------
  async function recompressAll() {
    if (!session.token || session.busy || session.items.length === 0) return;
    if (session.items.every((i) => i.error)) { toast('当前没有可重新压缩的图片', 'error'); return; }

    session.busy = true;
    btnRecompress.disabled = true;
    btnZip.disabled = true;
    const origHtml = btnRecompress.innerHTML;
    btnRecompress.innerHTML = '<span class="spinner" aria-hidden="true"></span>重压中…';

    try {
      const resp = await fetch('/api/recompress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: session.token, quality: Number(qualityRange.value) }),
      });
      const res = await resp.json().catch(() => ({}));
      if (!resp.ok || !res.ok) {
        if (resp.status === 404) { resetAll(); }
        throw new Error((res && res.message) || '重新压缩失败');
      }
      // 用新结果原位更新（原始预览 URL 复用，不重复创建）
      const byIdx = new Map(res.results.map((r) => [r.index, r]));
      session.items.forEach((item, idx) => {
        const r = byIdx.get(idx);
        if (!r) return;
        if (r.error) {
          item.error = r.error;
        } else {
          Object.assign(item, {
            error: null,
            fileName: r.fileName,
            downloadName: downloadName(r),
            originalSize: r.originalSize,
            compressedSize: r.compressedSize,
            savedBytes: r.savedBytes,
            savedPercent: r.savedPercent,
            format: r.format,
            converted: r.converted,
            width: r.width,
            height: r.height,
            url: r.url,
          });
        }
      });
      renderItems(false);
      toast(`已按 ${qualityRange.value}% 重新压缩全部图片`, 'success');
    } catch (e) {
      toast(e.message || '重新压缩失败', 'error');
    } finally {
      session.busy = false;
      btnRecompress.disabled = false;
      btnZip.disabled = false;
      btnRecompress.innerHTML = origHtml;
    }
  }

  // ---------------- 打包下载 ----------------
  async function downloadZip() {
    const ok = session.items.filter((i) => !i.error);
    if (!session.token || ok.length === 0) { toast('没有可下载的压缩结果', 'error'); return; }
    btnZip.disabled = true;
    const origHtml = btnZip.innerHTML;
    btnZip.innerHTML = '<span class="spinner" aria-hidden="true"></span>打包中…';
    try {
      const resp = await fetch(`/api/files/${session.token}/zip`);
      if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).message || '打包失败');
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `compressed-${session.token.slice(0, 6)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast(`已打包 ${ok.length} 张图片下载`, 'success');
    } catch (e) {
      toast(e.message || '打包下载失败', 'error');
    } finally {
      btnZip.disabled = false;
      btnZip.innerHTML = origHtml;
    }
  }

  // ---------------- 清空 / 重置 ----------------
  function resetAll() {
    session.items.forEach((i) => { if (i.originalUrl) URL.revokeObjectURL(i.originalUrl); });
    session.token = null;
    session.items = [];
    session.busy = false;
    renderItems();
    setBusy(false);
    toast('已清空，可以开始新一轮压缩', 'success', 2200);
  }

  // ---------------- 忙碌状态 ----------------
  function setBusy(b) {
    dropzone.classList.toggle('is-busy', b);
    dropzone.setAttribute('aria-disabled', b ? 'true' : 'false');
    pickBtn.disabled = b;
    fileInput.disabled = b;
    if (b) { progressBox.hidden = false; } else { session.busy = false; }
  }

  // ---------------- 文件采集 ----------------
  function pickFilesFromList(fileList) {
    const files = Array.from(fileList || [])
      .filter((f) => ACCEPT_EXTS.includes(extOf(f.name).toLowerCase()) || /^image\//.test(f.type || ''));
    const unsupported = (fileList ? fileList.length : 0) - files.length;
    if (unsupported > 0) toast(`已跳过 ${unsupported} 个不支持的格式`, 'error', 2600);
    if (files.length === 0) { toast('请选择 JPG / PNG / WebP / AVIF 等图片文件', 'error'); return; }
    const over = files.length - MAX_FILES;
    const slice = files.slice(0, MAX_FILES);
    if (over > 0) toast(`最多一次处理 ${MAX_FILES} 张，多余的 ${over} 张未加入`, 'error', 3000);
    uploadFiles(slice);
  }

  async function pickFromDataTransfer(dt) {
    if (!dt || !dt.items || dt.items.length === 0) { pickFilesFromList(dt && dt.files); return; }
    const items = Array.from(dt.items);
    const files = [];
    let skippedDir = 0;
    for (const it of items) {
      const entry = it.webkitGetAsEntry && it.webkitGetAsEntry();
      if (entry && entry.isDirectory) { skippedDir++; continue; }
      const f = it.getAsFile && it.getAsFile();
      if (f) files.push(f);
    }
    if (skippedDir) toast(`已跳过文件夹中的 ${skippedDir} 项，请直接拖入图片文件`, 'error', 2600);
    pickFilesFromList(files);
  }

  // ---------------- 事件绑定 ----------------
  dropzone.addEventListener('click', () => { if (!dropzone.classList.contains('is-busy')) fileInput.click(); });
  dropzone.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !dropzone.classList.contains('is-busy')) {
      e.preventDefault();
      fileInput.click();
    }
  });
  pickBtn.addEventListener('click', (e) => { e.stopPropagation(); if (!fileInput.disabled) fileInput.click(); });
  fileInput.addEventListener('change', () => { pickFilesFromList(fileInput.files); fileInput.value = ''; });

  ['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    if (!session.busy) dropzone.classList.add('is-drag');
  }));
  ['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-drag');
  }));
  dropzone.addEventListener('drop', (e) => {
    if (!session.busy) pickFromDataTransfer(e.dataTransfer);
  });

  // 粘贴图片（Ctrl/⌘ + V）
  document.addEventListener('paste', (e) => {
    if (session.busy) return;
    const files = Array.from((e.clipboardData && e.clipboardData.files) || [])
      .filter((f) => f.type.startsWith('image/'));
    if (files.length) pickFilesFromList(files);
  });

  // 页面级拖放兜底：防止浏览器直接打开图片
  ['dragover', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault()));

  btnRecompress.addEventListener('click', recompressAll);
  btnZip.addEventListener('click', downloadZip);

  // ---------------- 初始化 ----------------
  setQuality(70);

  // 卡片内“下载”链接：走新标签页避免页面刷新中断
  cardsEl.addEventListener('click', (e) => {
    const link = e.target.closest('a.dl-link');
    if (link) e.stopPropagation();
  });

  // 添加“清空重来”按钮到摘要操作区
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'btn btn-ghost';
  clearBtn.id = 'btn-clear';
  clearBtn.innerHTML = '清空重来';
  clearBtn.title = '删除当前结果与临时文件引用，开始新一轮';
  document.querySelector('.summary-actions').appendChild(clearBtn);
  document.querySelector('.summary-actions').addEventListener('click', (e) => {
    if (e.target.closest('#btn-clear')) resetAll();
  });
})();
