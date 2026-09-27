/* 云图 · 曲线台
 *
 * 画的是「从此刻起的 24 小时气温曲线」。做法参考自记纸（chart recorder）：
 *   - 横轴是时间，纵轴是气温，两侧留白由 niceRange 对齐到 2 度一格；
 *   - 夜间时段在顶部压一条暗带，日出日落各插一根刻度，曲线因此有了昼夜背景；
 *   - 曲线用 Catmull-Rom 转贝塞尔，保留一点手绘的松弛感，不做折线也不做过冲的样条；
 *   - 光标可拖可键盘操作，读数写在 SVG 上方的独立区域，不随曲线浮动，避免挡住数据。
 *
 * 这个文件只负责把数据变成 SVG 字符串和一个可复用的光标控制器；
 * 交互怎么绑（鼠标、触摸、方向键）由这里统一处理，app.js 不用关心几何换算。
 */
(function (root, factory) {
  const api = factory(root && root.CloudCore ? root.CloudCore : (typeof require === 'function' ? require('./core.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CloudChart = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';

  if (!C) throw new Error('cloud-chart 需要先加载 core.js');

  const W = 900;      // viewBox 宽度：所有几何都按这个坐标系算，实际显示尺寸由 CSS 决定
  const H = 250;
  const PAD = { top: 22, right: 14, bottom: 34, left: 44 };

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  /* 曲线用到的渐变和裁切，同样只定义一次，随图表一起输出（同页可能有多个图，用后缀区分）。 */
  let uid = 0;

  /**
   * 渲染一整块曲线。
   *
   * @param {object} opts
   *   hours      核心模块 normalizeForecast 出来的 hours 数组
   *   unit       'c' | 'f'，只影响显示，几何始终按摄氏算
   *   sunrise    今日日出 "HH:MM"
   *   sunset     今日日落 "HH:MM"
   *   dayLabel   图表标题右侧的说明文字（例如「今天 09-27 周一」）
   *   emptyText  没有数据时的占位文案
   * @returns {string} SVG 字符串（空数据时返回占位段落）
   */
  function hourly(opts) {
    const o = opts || {};
    const hours = (o.hours || []).filter((h) => h && isFinite(h.temp));

    if (hours.length < 2) {
      return `<p class="chart-empty">${esc(o.emptyText || '这段时段没有观测数据')}</p>`;
    }

    const id = 'ct-chart-' + (++uid);
    const unit = o.unit === 'f' ? 'f' : 'c';
    const temps = hours.map((h) => h.temp);
    /* 上下各留 1.5 度余量，曲线才不会贴着框线；范围再对齐到 2 度一格。 */
    const range = C.niceRange(temps, 1.5);
    const yOf = (t) => PAD.top + C.yAt(t, range.min, range.max, plotH);
    const xOf = (i) => PAD.left + C.xAt(i, hours.length, plotW);

    const pts = hours.map((h, i) => ({ x: xOf(i), y: yOf(h.temp) }));
    const line = C.pathFrom(pts);
    const area = C.areaFrom(pts, PAD.top + plotH);

    /* --- 顶部昼夜带：日出日落之间留亮，其余压暗。竖线标出日出/日落的确切位置。 --- */
    const nightBands = [];
    hours.forEach((h, i) => {
      const night = C.isNightHour(h.time, o.sunrise, o.sunset);
      if (!night) return;
      const x0 = xOf(i) - plotW / (hours.length - 1) / 2;
      const w = plotW / (hours.length - 1);
      nightBands.push(Math.max(PAD.left, x0));
      nightBands.push(Math.min(PAD.left + plotW, x0 + w));
    });
    /* 相邻的夜间时段合并成矩形，避免 24 个 rect 在窄屏上出现缝。 */
    const nightRects = mergePairs(nightBands).map(([a, b]) => (
      `<rect x="${r1(a)}" y="${PAD.top}" width="${r1(Math.max(0, b - a))}" height="${plotH}" class="ch-night"/>`
    )).join('');

    const sunMarks = [];
    [['sunrise', o.sunrise, '日出'], ['sunset', o.sunset, '日落']].forEach(([kind, hhmm, label]) => {
      if (!hhmm) return;
      const idx = hours.findIndex((h) => C.hourOf(h.time) >= Number(hhmm.slice(0, 2)));
      if (idx < 0) return;
      const x = xOf(idx);
      sunMarks.push(`<g class="ch-sunmark"><line x1="${r1(x)}" y1="${PAD.top}" x2="${r1(x)}" y2="${PAD.top + plotH}"/>`
        + `<circle cx="${r1(x)}" cy="${PAD.top + 3}" r="2.6"/>`
        + `<text x="${r1(x + 4)}" y="${PAD.top - 8}">${label}</text></g>`);
    });

    /* --- 纵轴刻度：左侧标温度，横线贯穿图面（细到几乎看不见，只作对齐参考）。 --- */
    const grade = C.ticks(range.min, range.max, 5).map((t) => {
      const y = yOf(t);
      return `<g class="ch-grade"><line x1="${PAD.left}" y1="${r1(y)}" x2="${PAD.left + plotW}" y2="${r1(y)}"/>`
        + `<text x="${PAD.left - 8}" y="${r1(y + 4)}">${C.convertTemp(t, unit)}°</text></g>`;
    }).join('');

    /* --- 横轴刻度：每 3 小时一个整点，整点下方标时刻。 --- */
    const timeAxis = hours.map((h, i) => {
      const hour = C.hourOf(h.time);
      if (i % 3 !== 0) return '';
      const x = xOf(i);
      return `<g class="ch-tick"><line x1="${r1(x)}" y1="${PAD.top + plotH}" x2="${r1(x)}" y2="${PAD.top + plotH + 5}"/>`
        + `<text x="${r1(x)}" y="${PAD.top + plotH + 20}">${hour}:00</text></g>`;
    }).join('');

    /* --- 数据点：只在高低温的极值处标出来，24 个点全标会变成噪声。 --- */
    const maxI = temps.indexOf(Math.max.apply(null, temps));
    const minI = temps.indexOf(Math.min.apply(null, temps));
    const peaks = [maxI, minI].filter((v, i, a) => a.indexOf(v) === i).map((i) => {
      const p = pts[i];
      const above = i === maxI;
      return `<g class="ch-peak"><circle cx="${r1(p.x)}" cy="${r1(p.y)}" r="3.4"/>`
        + `<text x="${r1(p.x)}" y="${r1(p.y + (above ? -12 : 17))}" text-anchor="middle">${C.convertTemp(hours[i].temp, unit)}°</text></g>`;
    }).join('');

    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="${esc(hours.length + ' 小时气温曲线')}">
      <defs>
        <linearGradient id="${id}-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.30"/>
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.02"/>
        </linearGradient>
        <clipPath id="${id}-clip"><rect x="${PAD.left}" y="${PAD.top - 6}" width="${plotW}" height="${plotH + 12}"/></clipPath>
      </defs>
      ${nightRects}
      <g class="ch-frame">
        <line x1="${PAD.left}" y1="${PAD.top + plotH}" x2="${PAD.left + plotW}" y2="${PAD.top + plotH}"/>
      </g>
      ${grade}
      <g clip-path="url(#${id}-clip)">
        <path class="ch-area" d="${area}" fill="url(#${id}-fill)"/>
        <path class="ch-line" d="${line}"/>
      </g>
      ${sunMarks.join('')}
      ${peaks}
      ${timeAxis}
      <g class="ch-cursor" hidden>
        <line y1="${PAD.top}" y2="${PAD.top + plotH}"/>
        <circle cy="${PAD.top + plotH}" r="3"/>
      </g>
      <rect class="ch-hit" x="${PAD.left}" y="${PAD.top}" width="${plotW}" height="${plotH}" tabindex="0"
        role="slider" aria-label="按小时查看气温"
        aria-valuemin="${C.convertTemp(range.min, unit)}" aria-valuemax="${C.convertTemp(range.max, unit)}"
        aria-valuenow="${C.convertTemp(hours[0].temp, unit)}"/>
    </svg>`;
  }

  function mergePairs(flat) {
    const out = [];
    for (let i = 0; i < flat.length; i += 2) {
      const a = flat[i];
      const b = flat[i + 1];
      const last = out[out.length - 1];
      if (last && Math.abs(last[1] - a) < 0.6) last[1] = b;
      else out.push([a, b]);
    }
    return out;
  }

  const r1 = (v) => Math.round(v * 10) / 10;

  /* --------------------------------------------------------------- 光标控制 */

  /**
   * 把一块已插入 DOM 的曲线变成长按可拖的读数器。
   *
   * 交互分工：
   *   - 鼠标 / 触摸：在图上按住左右拖，读数实时更新；
   *   - 键盘：方向键逐小时移动，Home / End 跳到两端；
   *   - 鼠标离开曲线后光标保留在最后位置，不闪回，方便边看边记。
   *
   * 读数通过 onRead 回调交给页面渲染（页面那块区域同时是 aria-live 的反馈口）。
   */
  function attachCursor(svgEl, hours, opts) {
    const o = opts || {};
    if (!svgEl || !hours || hours.length < 2) return null;

    const hit = svgEl.querySelector('.ch-hit');
    const cursor = svgEl.querySelector('.ch-cursor');
    if (!hit || !cursor) return null;

    const cursorLine = cursor.querySelector('line');
    const cursorDot = cursor.querySelector('circle');
    const range = C.niceRange(hours.map((h) => h.temp), 1.5);
    const yOf = (t) => PAD.top + C.yAt(t, range.min, range.max, plotH);
    const xOf = (i) => PAD.left + C.xAt(i, hours.length, plotW);

    let index = 0;

    function render(i, opts2) {
      index = Math.max(0, Math.min(hours.length - 1, i));
      const x = xOf(index);
      const h = hours[index];
      cursorLine.setAttribute('x1', r1(x));
      cursorLine.setAttribute('x2', r1(x));
      cursorDot.setAttribute('cx', r1(x));
      cursorDot.setAttribute('cy', r1(yOf(h.temp)));
      cursor.removeAttribute('hidden');
      /* aria-valuenow 必须是「值」而不是索引，否则读屏软件会念出「第 5」这种无意义的话。
         范围轴是摄氏，英制下要换算后再上报，最小值同样换算过。 */
      hit.setAttribute('aria-valuenow', String(C.convertTemp(h.temp, o.unit)));
      hit.setAttribute('aria-valuetext', `${C.hourOffsetLabel(index)} ${C.convertTemp(h.temp, o.unit)} 度`);
      if (o.onRead) o.onRead(index, h, (opts2 && opts2.silent) === true);
    }

    /** 屏幕像素 → 数据索引。要用 SVG 的实际渲染宽度换算，viewBox 只是逻辑坐标。 */
    function indexFromEvent(ev) {
      const box = svgEl.getBoundingClientRect();
      if (!box.width) return index;
      const scale = W / box.width;
      const x = (ev.clientX - box.left) * scale;
      return C.nearestIndex(x - PAD.left, hours.length, plotW);
    }

    let dragging = false;

    function onDown(ev) {
      dragging = true;
      hit.focus({ preventScroll: true });
      render(indexFromEvent(ev));
      // 拖动期间锁住指针，手指滑出图形边界也不会丢事件
      if (hit.setPointerCapture && ev.pointerId != null) {
        try { hit.setPointerCapture(ev.pointerId); } catch (e) { /* 老浏览器忽略 */ }
      }
      ev.preventDefault();
    }

    function onMove(ev) {
      if (!dragging) return;
      render(indexFromEvent(ev));
      ev.preventDefault();
    }

    function onUp() {
      dragging = false;
    }

    function onKey(ev) {
      const map = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: hours.length - 1 };
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        // 上下键按 3 小时步进：逐小时太碎，方向键连按会很累
        render(index + (ev.key === 'ArrowDown' ? 3 : -3));
      } else if (map[ev.key] != null) {
        render(map[ev.key]);
      } else {
        return;
      }
      ev.preventDefault();
    }

    hit.addEventListener('pointerdown', onDown);
    hit.addEventListener('pointermove', onMove);
    hit.addEventListener('pointerup', onUp);
    hit.addEventListener('pointercancel', onUp);
    hit.addEventListener('keydown', onKey);
    hit.addEventListener('focus', () => render(index, { silent: true }));

    /* 首屏先落在「此刻」，用户不用先动鼠标才知道图怎么读。 */
    render(0);

    return {
      setIndex: (i) => render(i),
      get index() { return index; },
      destroy() {
        hit.removeEventListener('pointerdown', onDown);
        hit.removeEventListener('pointermove', onMove);
        hit.removeEventListener('pointerup', onUp);
        hit.removeEventListener('pointercancel', onUp);
        hit.removeEventListener('keydown', onKey);
      },
    };
  }

  return { hourly, attachCursor, W, H, PAD };
});
