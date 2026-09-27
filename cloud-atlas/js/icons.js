/* 云图 · 天象符号
 *
 * 所有天气符号共用一套「刻线」语言：同一个圆盘里，不同天象是同一套排线的不同走向与密度，
 * 像仪表盘上的雕版刻度。这样 7 日条带里七个符号并排时是成体系的，
 * 而不是七个各自为政的小图标。
 *
 * 实现上只用三层：<defs> 里预定义好刻线图案 → 每个符号用 clipPath 裁出形状 → 填上图案。
 * 图案和裁切路径全局定义一次（ICON_DEFS），每个符号只是几十字节的引用。
 *
 * 用法：
 *   document.body.insertAdjacentHTML('afterbegin', Icons.sprite());
 *   el.innerHTML = Icons.svg(code, isDay, { size: 64, cls: 'wx' });
 */
(function (root, factory) {
  /* Node 下直接 require 拿 core；浏览器里 core.js 先于本文件加载，从 window 上取。
     两者都拿不到时也不报错——fallbackTone 里有一份等价的兜底映射，
     所以这个文件单独也能跑。 */
  let C = null;
  if (typeof module === 'object' && module.exports) {
    try { C = require('./core.js'); } catch (e) { C = null; }
  }
  if (!C && root && root.CloudCore) C = root.CloudCore;

  const api = factory(C);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CloudIcons = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';

  /* 每个 tone 对应一套排线参数（角度、线距、线宽）。
     角度是「反直觉但正确」的：45° 的斜线看起来像光，90° 的竖线看起来像雨。 */
  const TONE = {
    clear: { angle: 0, gap: 5, width: 1.1, disc: 15 },     // 水平排线 = 晴空的分层
    fair: { angle: 20, gap: 5.5, width: 1.1, disc: 13 },
    cloud: { angle: -18, gap: 6, width: 1.2, disc: 12 },
    overcast: { angle: -34, gap: 5, width: 1.3, disc: 10 },
    fog: { angle: 0, gap: 7, width: 1.6, disc: 8 },
    drizzle: { angle: 62, gap: 6, width: 1.1, disc: 10 },
    rain: { angle: 70, gap: 7, width: 1.3, disc: 10 },
    snow: { angle: 45, gap: 9, width: 1.1, disc: 10 },
    storm: { angle: 55, gap: 5, width: 1.6, disc: 12 },
  };

  /* 夜间一律改用同一套更疏的竖向排线：夜里看不清云型，压暗比编造细节诚实。 */
  const NIGHT_TONE = { angle: 78, gap: 8, width: 1, disc: 9 };

  const NS = 'http://www.w3.org/2000/svg';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  /* --------------------------------------------------------------- 图案定义 */

  /** 一条 45° 斜线图案，靠 rotate 得到各种角度；patternTransform 比逐条算坐标省事得多。 */
  function hatchPattern(id, angle, gap, width, color) {
    return `<pattern id="${id}" width="${gap}" height="${gap}" patternUnits="userSpaceOnUse" patternTransform="rotate(${angle})">`
      + `<line x1="0" y1="0" x2="0" y2="${gap}" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`
      + '</pattern>';
  }

  function dotPattern(id, gap, r, color) {
    return `<pattern id="${id}" width="${gap}" height="${gap}" patternUnits="userSpaceOnUse">`
      + `<circle cx="${gap / 2}" cy="${gap / 2}" r="${r}" fill="${color}"/>`
      + '</pattern>';
  }

  const TONES = ['clear', 'fair', 'cloud', 'overcast', 'fog', 'drizzle', 'rain', 'snow', 'storm'];

  /**
   * 全局只定义一次。tone 线条用 currentColor，所以同一个符号在深底和浅底上都不用改。
   * 这里同时给出：排线图案、圆形/云形/雨形裁切路径、以及整个符号集共用的渐变。
   */
  const DEFS = `<defs>
    ${TONES.map((t) => hatchPattern('ct-' + t, TONE[t].angle, TONE[t].gap, TONE[t].width, 'currentColor')).join('')}
    ${hatchPattern('ct-night', NIGHT_TONE.angle, NIGHT_TONE.gap, NIGHT_TONE.width, 'currentColor')}
    ${dotPattern('ct-snowdot', 6, 1.15, 'currentColor')}
    <radialGradient id="ct-glow" cx="50%" cy="46%" r="52%">
      <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.30"/>
      <stop offset="70%" stop-color="var(--accent)" stop-opacity="0.06"/>
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
    </radialGradient>
    <path id="ct-cloud" d="M18 44 h27 a9.5 9.5 0 0 0 0.6-19 A13 13 0 0 0 20 22.4 A10 10 0 0 0 18 44 Z"/>
    <path id="ct-cloud-small" d="M20 42 h22 a8 8 0 0 0 0.5-16 A11 11 0 0 0 21.5 23.5 A8.5 8.5 0 0 0 20 42 Z"/>
    <circle id="ct-disc-lg" cx="32" cy="32" r="17"/>
    <circle id="ct-disc-sm" cx="32" cy="32" r="11.5"/>
    <clipPath id="ct-clip-cloud"><use href="#ct-cloud"/></clipPath>
    <clipPath id="ct-clip-cloud-small"><use href="#ct-cloud-small"/></clipPath>
    <clipPath id="ct-clip-disc"><use href="#ct-disc-lg"/></clipPath>
    <clipPath id="ct-clip-disc-sm"><use href="#ct-disc-sm"/></clipPath>
  </defs>`;

  /* ------------------------------------------------------- 各天象的形体组合 */

  /** 云＋雨的实体形状：云形之上，下面几道雨丝用短竖线表示，不画水滴。 */
  const RAIN_STROKES = '<g class="wx-fall" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none">'
    + '<line x1="24" y1="49" x2="21" y2="57"/><line x1="33" y1="49" x2="30" y2="59"/>'
    + '<line x1="42" y1="49" x2="39" y2="56"/></g>';

  const DRIZZLE_STROKES = '<g class="wx-fall" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none">'
    + '<line x1="26" y1="49" x2="24" y2="54"/><line x1="34" y1="49" x2="32" y2="55"/>'
    + '<line x1="42" y1="49" x2="40" y2="53"/></g>';

  /* 雪用点阵图案填充，不用实心圆：远看是雪，近看是刻点，和排线是同一套语言。 */
  const SNOW_DOTS = '<rect x="18" y="47" width="30" height="16" fill="#ct-snowdot"/>';

  const STORM_BOLT = '<path d="M35 46 L27 58 L33 58 L29 66 L41 53 L34.5 53 Z" fill="currentColor" class="wx-bolt"/>';

  /* 雾不画云：一道一道横线才是「能见度差」这件事最直接的画法，四道线比三道更能压住下缘。 */
  const FOG_RULES = '<g stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none">'
    + '<line x1="14" y1="22" x2="50" y2="22"/><line x1="12" y1="30" x2="52" y2="30"/>'
    + '<line x1="16" y1="38" x2="48" y2="38"/><line x1="22" y1="46" x2="42" y2="46"/></g>';

  /* 晴：圆盘填斜排线 + 一圈短辐条。辐条是「仪表刻度」的来源，不是光芒。
     辐条单独成组并带 wx-rays 类，只有大号符号才会让它慢慢转（见 CSS 的 .wx-icon--animate）。 */
  const SUN_RAYS = '<g class="wx-rays" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none">'
    + '<line x1="32" y1="6" x2="32" y2="11"/><line x1="32" y1="53" x2="32" y2="58"/>'
    + '<line x1="6" y1="32" x2="11" y2="32"/><line x1="53" y1="32" x2="58" y2="32"/>'
    + '<line x1="13.6" y1="13.6" x2="17.1" y2="17.1"/><line x1="46.9" y1="46.9" x2="50.4" y2="50.4"/>'
    + '<line x1="13.6" y1="50.4" x2="17.1" y2="46.9"/><line x1="46.9" y1="17.1" x2="50.4" y2="13.6"/></g>';

  /* 月亮：实心月牙。带 wx-moon 类，这样夜间的符号也有自己的动效（极轻微的明暗呼吸）。 */
  const MOON = '<path class="wx-moon" d="M38 12 a20 20 0 1 0 12 34 A16 16 0 0 1 38 12 Z" fill="currentColor" fill-opacity="0.85"/>';

  /**
   * 生成一个天象符号。
   * @param {number|null} code WMO 天气码
   * @param {boolean} isDay 是否白天
   * @param {{size?:number, cls?:string, title?:string, tone?:string, animate?:boolean}} [opts]
   *        tone 可以覆盖由 code 推出的基调——7 日条带里夜间符号需要显式指定 night。
   *        animate 打开落雨、飘雪、闪电和太阳缓转；只建议用在大号符号上，
   *        7 日条带里 30px 的小符号动起来是干扰而不是信息。
   */
  function svg(code, isDay, opts) {
    const o = opts || {};
    const size = o.size || 64;
    const tone = o.tone || (C ? C.sky(code, isDay) : fallbackTone(code, isDay));
    const cls = ['wx-icon', o.animate ? 'wx-icon--animate' : '', o.cls || ''].filter(Boolean).join(' ');
    const label = o.title || (C ? C.describeCode(code).label : '');

    const aria = label
      ? `role="img" aria-label="${esc(label)}"`
      : 'aria-hidden="true"';

    return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 64 64" ${aria} focusable="false">`
      + `<title>${esc(label)}</title>`
      + body(tone, isDay)
      + '</svg>';
  }

  /**
   * 合成基调 → 形体。
   * 形体只有十种（晴/晴间多云/多云/阴/雾/毛毛雨/雨/雪/雷暴），
   * 但基调有十三个——雨夜、雨昼的形体是同一个，差别只在排线的方向与疏密。
   * 所以这一步只回答「画什么形状」，不问「白天还是夜里」。
   */
  function baseTone(tone) {
    if (tone === 'night') return 'clear';
    if (tone.endsWith('-night')) return tone.replace('-night', '');
    return TONE[tone] ? tone : 'cloud';
  }

  /**
   * 排线图案的选择规则，只有这一处：
   *   云 → 夜里用疏竖线（ct-night），白天用自己基调的排线；
   *   太阳盘 → 永远用 ct-clear，图案不能随昼夜变，否则"太阳"就没了形状；
   *   月亮 → 本来就是实心路径，不需要排线。
   *
   * 这里必须显式判 isDay === true：之前写成 !isDay 判断昼夜、却用 isDay 真假选图案，
   * 两套判断在 isDay 为 null/undefined 时结论相反，图标会引用一个自己没用上的填充，
   * 结果整个符号渲染成空白。
   */
  function cloudFill(tone, isDay) {
    return isDay === true ? '#' + 'ct-' + baseTone(tone) : '#ct-night';
  }

  function fallbackTone(code, isDay) {
    if (isDay !== true) return 'night';
    if (code == null) return 'cloud';
    if (code === 0 || code === 1) return 'clear';
    if (code === 2) return 'cloud';
    if (code === 3) return 'overcast';
    if (code === 45 || code === 48) return 'fog';
    if (code >= 71 && code <= 86) return 'snow';
    if (code >= 95) return 'storm';
    if (code >= 51) return 'rain';
    return 'cloud';
  }

  /** 云形的实体 + 外轮廓，雨、雪、雷暴、多云共用这一段。 */
  function cloudShape(fill) {
    return `<use href="#ct-cloud" clip-path="url(#ct-clip-cloud)" fill="${fill}"/>`
      + '<path d="M18 44 h27 a9.5 9.5 0 0 0 0.6-19 A13 13 0 0 0 20 22.4 A10 10 0 0 0 18 44 Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>';
  }

  /**
   * 各天象的形体。
   *
   * animate 只控制要不要加 wx-icon--animate 这个类，**形状完全不变**——
   * 具体动什么由 CSS 决定（见 styles.css 的「天象动效」一节）。
   *
   * 为什么不在这里决定哪种天气加哪个动画类：
   * 那样静态版和动画版会生成不同的标签结构，同一个天气在 7 日条带（静态）
   * 和主读数（动）里就成了两个图形。全部交给 CSS，几何就永远一致，
   * 而且"要不要动"变成一个纯粹的样式问题，跟数据无关。
   */
  function body(tone, isDay) {
    const t = baseTone(tone);
    const night = isDay !== true;
    const fill = cloudFill(tone, isDay);

    /* 晴 / 晴间多云：一个主盘（太阳或月亮），可选加一小片云压在下缘。 */
    if (t === 'clear' || t === 'fair') {
      const disc = night
        ? MOON
        : `<use href="#ct-disc-lg" clip-path="url(#ct-clip-disc)" fill="#ct-clear"/>`
          + `<circle cx="32" cy="32" r="17" fill="none" stroke="currentColor" stroke-width="1.4"/>`
          + SUN_RAYS;
      const cloud = t === 'fair'
        ? `<use href="#ct-cloud-small" clip-path="url(#ct-clip-cloud-small)" fill="${fill}"/>`
          + '<path d="M20 42 h22 a8 8 0 0 0 0.5-16 A11 11 0 0 0 21.5 23.5 A8.5 8.5 0 0 0 20 42 Z" fill="none" stroke="currentColor" stroke-width="1.4"/>'
        : '';
      return `<g class="wx-body">${disc}${cloud}</g>`;
    }

    /* 阴 / 多云：云本身就是一个色块 + 外轮廓，内部填排线。 */
    if (t === 'cloud' || t === 'overcast') {
      // 多云在白天的云后还露一小块天体：白天是太阳盘，夜里是月亮
      const extra = t === 'cloud'
        ? (night
          ? '<g class="wx-moon" transform="translate(24 -9) scale(0.9)">' + MOON + '</g>'
          : '<use href="#ct-disc-sm" clip-path="url(#ct-clip-disc-sm)" fill="#ct-clear" transform="translate(25 -8) scale(0.95)"/>')
        : '';      return `<g class="wx-body">${extra}${cloudShape(fill)}</g>`;
    }

    if (t === 'fog') return `<g class="wx-body">${FOG_RULES}</g>`;

    if (t === 'drizzle' || t === 'rain') {
      const strokes = t === 'drizzle' ? DRIZZLE_STROKES : RAIN_STROKES;
      return `<g class="wx-body">${cloudShape(fill)}${strokes}</g>`;
    }

    if (t === 'snow') {
      return `<g class="wx-body">${cloudShape(fill)}<g class="wx-fall">${SNOW_DOTS}</g></g>`;
    }

    if (t === 'storm') {
      return `<g class="wx-body">${cloudShape(fill)}`
        + '<g class="wx-fall" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="22" y1="48" x2="20" y2="53"/><line x1="45" y1="48" x2="43" y2="53"/></g>'
        + STORM_BOLT + '</g>';
    }

    return `<g class="wx-body">${cloudShape(fill)}</g>`;
  }

  /** 整页只需要注入一次：放在 <body> 最前面，全屏隐藏但定义可被任何 <use> 引用。 */
  function sprite() {
    return `<svg class="wx-sprite" width="0" height="0" aria-hidden="true" focusable="false" style="position:absolute;width:0;height:0;overflow:hidden">${DEFS}</svg>`;
  }

  return { svg, sprite, DEFS, TONE, baseTone, fallbackTone };
});
