/**
 * 开发用布局体检（不属于站点本身）
 *
 * 用本机 Chrome 真实渲染，量出手机上最容易翻车的那些事：
 *   - 横向溢出，以及具体是哪些元素撑破了视口
 *   - 关键元素的位置 / 尺寸 / 字号 / 可见性
 *   - 卡片的栅格列数与每行张数
 *   - 正文与背景的对比度（WCAG AA 正文要 ≥ 4.5:1）
 *   - 有没有"看不见但占着位置"的节点
 *
 * 实现说明：headless Chrome 的 --dump-dom 拿不到运行时变量，
 * 所以让页面把结果编码进 <title>，我们再从 DOM 里抠出来解析。
 *
 *   CHROME_PATH=/path/to/chrome node scripts/verify-layout.js
 */
'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = process.env.CHROME_PATH || '';
const ROOT = path.join(__dirname, '..');
const PORT = 5511 + Math.floor(Math.random() * 120);

/* ---------------------------------------------------------------
   注入到页面里的探针。整段被包成字符串，最后在浏览器里 eval。
   --------------------------------------------------------------- */
const PROBE = function () {
  var out = {};
  var de = document.documentElement;
  var vw = window.innerWidth;
  var vh = window.innerHeight;

  out.viewport = { w: vw, h: vh };
  out.docH = de.scrollHeight;
  out.overflowX = de.scrollWidth - de.clientWidth;

  // 撑破视口的可见元素
  var wide = [];
  Array.prototype.slice.call(document.body.querySelectorAll('*')).forEach(function (el) {
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') return;
    var r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    if (r.right > vw + 1.5 || r.left < -1.5) {
      var cls = typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '';
      wide.push({ sel: el.tagName.toLowerCase() + cls, l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) });
    }
  });
  out.overflowing = wide.slice(0, 10);

  function box(sel) {
    var el = document.querySelector(sel);
    if (!el) return null;
    var r = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    return {
      x: Math.round(r.left), y: Math.round(r.top + window.scrollY),
      w: Math.round(r.width), h: Math.round(r.height),
      display: cs.display, opacity: +cs.opacity
    };
  }
  function font(sel) {
    var el = document.querySelector(sel);
    if (!el) return null;
    var cs = getComputedStyle(el);
    return { size: cs.fontSize, weight: cs.fontWeight, lh: cs.lineHeight, family: cs.fontFamily.split(',')[0].replace(/"/g, '') };
  }

  out.rail = box('.rail');
  out.topbar = box('.topbar');
  out.hero = box('.hero');
  out.heroName = box('.hero__name');
  out.heroNameFont = font('.hero__name');
  out.heroNameLines = (function () {
    var el = document.querySelector('.hero__name');
    if (!el) return null;
    // clientHeight / line-height = 实际占了几行
    var lh = parseFloat(getComputedStyle(el).lineHeight);
    return lh ? Math.round(el.clientHeight / lh) : null;
  })();
  out.portrait = box('.portrait');
  out.portraitStage = box('.portrait__stage');
  out.uploadBtn = box('[data-photo-upload]');
  out.resetBtnHidden = (function () {
    var el = document.querySelector('[data-photo-reset]');
    return el ? el.hidden : null;
  })();
  out.cards = box('.cards');
  out.cardFirst = box('.card');
  out.cardCount = document.querySelectorAll('.card').length;

  var tops = {};
  Array.prototype.slice.call(document.querySelectorAll('.card')).forEach(function (c) {
    var t = Math.round(c.getBoundingClientRect().top + window.scrollY);
    tops[t] = (tops[t] || 0) + 1;
  });
  out.cardRows = Object.keys(tops).sort(function (a, b) { return a - b; }).map(function (k) { return tops[k]; });
  out.cardWidth = out.cardFirst ? out.cardFirst.w : null;

  out.linkCount = document.querySelectorAll('.link').length;
  out.skillsRows = document.querySelectorAll('.skills__row').length;
  out.factsRows = document.querySelectorAll('.facts__row').length;
  out.thumbSvg = document.querySelectorAll('.card__thumb svg').length;
  out.thumbImg = document.querySelectorAll('.card__thumb img').length;

  // 对比度
  function rgb(s) {
    var m = (s || '').match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    var p = m[1].split(',').map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function lum(c) {
    function f(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function bgOf(el) {
    var node = el;
    while (node) {
      var c = rgb(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0.9) return c;
      node = node.parentElement;
    }
    return { r: 11, g: 16, b: 21 };
  }
  function ratio(el) {
    var fg = rgb(getComputedStyle(el).color);
    if (!fg) return null;
    var l1 = lum(fg), l2 = lum(bgOf(el));
    return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
  }
  out.contrast = {};
  [['bodyText', '.about__body p'], ['lede', '.hero__lede'], ['role', '.hero__role'],
   ['secNote', '.sec-head__note'], ['cardDesc', '.card__desc'], ['chip', '.chip'],
   ['factsV', '.facts__v'], ['footer', '.foot__note'], ['linkValue', '.link__value'],
   ['tag', '.tag'], ['skillItem', '.skills__items li'], ['cardLink', '.card__link']
  ].forEach(function (pair) {
    var el = document.querySelector(pair[1]);
    if (el) out.contrast[pair[0]] = ratio(el);
  });

  // 透明却占位的节点（排除还在等入场的）
  var invisible = [];
  Array.prototype.slice.call(document.querySelectorAll('section > *, .card, .link, .facts, .skills__row')).forEach(function (el) {
    if (el.hasAttribute('data-reveal')) return;
    var cs = getComputedStyle(el);
    var r = el.getBoundingClientRect();
    if (+cs.opacity < 0.05 && r.height > 20) {
      invisible.push(el.tagName.toLowerCase() + '.' + String(el.className).trim().split(/\s+/)[0]);
    }
  });
  out.invisible = invisible.slice(0, 8);

  out.revealPending = document.querySelectorAll('[data-reveal]:not([data-shown])').length;
  out.revealDone = document.querySelectorAll('[data-reveal][data-shown]').length;
  out.scanned = !!document.querySelector('[data-scanned="true"]');
  out.theme = de.getAttribute('data-theme');

  return out;
};

/* ---------------------------------------------------------------
   把探针注入一份页面副本，再用无头 Chrome 打开
   --------------------------------------------------------------- */
function buildTempSite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-probe-'));
  const inject =
    // 量尺寸时把过渡关掉：否则会读到 opacity 0.996 这种动画中间态，误判成"没显示"
    '<style>*,*::before,*::after{transition:none!important;animation:none!important}</style>' +
    '<script>window.addEventListener("load",function(){setTimeout(function(){' +
    'try{document.title="PROBE::"+encodeURIComponent(JSON.stringify((' + PROBE.toString() + ')()))}' +
    'catch(e){document.title="PROBE_ERR::"+e.message}},600)})<\/script>';

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  fs.writeFileSync(path.join(dir, 'index.html'), html.replace('</head>', inject + '</head>'));

  for (const f of ['styles.css', 'main.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  }
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'assets'))) {
    fs.copyFileSync(path.join(ROOT, 'assets', f), path.join(dir, 'assets', f));
  }
  return dir;
}

function readDirOK(dir) {
  fs.copyFileSync(path.join(ROOT, 'main.js'), path.join(dir, 'main.js'));
}

function serve(dir) {
  return (req, res) => {
    let p = req.url.split('?')[0];
    if (p === '/') p = '/index.html';
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }

    const file = path.join(dir, decodeURIComponent(p));
    if (!file.startsWith(dir)) { res.writeHead(403); return res.end(); }

    // 先读文件再写响应头：读失败时才不会出现"头已经发过了"
    let body;
    try {
      body = fs.readFileSync(file);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }

    const ext = path.extname(file);
    const type = ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript'
      : ext === '.svg' ? 'image/svg+xml' : 'text/html';
    res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
    res.end(body);
  };
}

function chromeDump(width, height, url) {
  return new Promise((resolve, reject) => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-shot-'));
    const domFile = path.join(outDir, 'dom.html');
    const logFile = path.join(outDir, 'chrome.log');
    const child = spawn(
      CHROME,
      [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
        '--disable-crash-reporter', '--disable-breakpad', '--hide-scrollbars',
        '--force-device-scale-factor=1',
        `--window-size=${width},${height}`,
        '--virtual-time-budget=6000',
        `--user-data-dir=${path.join(outDir, 'profile')}`,
        `--crash-dumps-dir=${path.join(outDir, 'crash')}`,
        '--dump-dom',
        url,
      ],
      { stdio: ['ignore', fs.openSync(domFile, 'w'), fs.openSync(logFile, 'w')] }
    );

    child.on('error', reject);
    child.on('close', () => {
      let dom = '';
      let log = '';
      try { dom = fs.readFileSync(domFile, 'utf8'); } catch { /* 忽略 */ }
      try { log = fs.readFileSync(logFile, 'utf8'); } catch { /* 忽略 */ }
      fs.rmSync(outDir, { recursive: true, force: true });
      if (!dom) return reject(new Error(log.split('\n').filter(Boolean).slice(-1)[0] || '没有 DOM'));
      resolve(dom);
    });

    setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, 45000);
  });
}

async function probeAt(label, w, h, theme) {
  const dir = buildTempSite();
  const srv = http.createServer(serve(dir));
  await new Promise((res) => srv.listen(PORT, '127.0.0.1', res));
  try {
    const dom = await chromeDump(w, h, `http://127.0.0.1:${PORT}/?reveal=all&theme=${theme}`);
    const title = dom.match(/<title>([\s\S]*?)<\/title>/);
    if (!title) throw new Error('页面没有 title');
    const raw = title[1].trim();
    if (raw.indexOf('PROBE::') !== 0) {
      throw new Error('探针没跑起来: ' + raw.slice(0, 120));
    }
    const json = decodeURIComponent(raw.slice('PROBE::'.length));
    return JSON.parse(json);
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async function main() {
  if (!CHROME) {
    console.error('请用 CHROME_PATH 指定 chrome.exe 路径');
    process.exit(1);
  }

  const sizes = [['desktop', 1440, 1050], ['tablet', 834, 1112], ['mobile', 390, 844], ['tiny', 320, 640]];
  const themes = ['dark', 'light'];

  const problems = [];
  let measured = 0;

  for (const theme of themes) {
    for (const [label, w, h] of sizes) {
      let r;
      try {
        r = await probeAt(label, w, h, theme);
        measured++;
      } catch (e) {
        console.error(label + '/' + theme + ' 测量失败: ' + e.message);
        process.exitCode = 1;
        continue;
      }

      console.log('\n' + '='.repeat(58));
      console.log(`${theme.toUpperCase()}  ${label}  ${w}×${h}   （实际视口 ${r.viewport.w}×${r.viewport.h}）`);
      console.log('='.repeat(58));

      const bugs = [];
      if (r.overflowX > 0) bugs.push(`横向溢出 ${r.overflowX}px`);
      if (r.cardCount < 1) bugs.push('一张项目卡片都没有');
      if (r.linkCount < 2) bugs.push(`联系方式只有 ${r.linkCount} 条，太少了`);
      if (r.linkCount > 8) bugs.push(`联系方式 ${r.linkCount} 条，联系区会长得失控`);
      if (r.thumbSvg + r.thumbImg !== r.cardCount) bugs.push('缩略图有缺');
      if (r.invisible.length) bugs.push('有透明却占位的节点: ' + r.invisible.join(','));

      const expectCols = w >= 760 ? 2 : 1;
      const wrongRow = r.cardRows.find((n) => n !== expectCols);
      if (wrongRow) bugs.push(`栅格列数异常（期望 ${expectCols}）: ${r.cardRows.join('/')}`);

      if (w >= 1180 && (!r.rail || r.rail.display === 'none')) bugs.push('宽屏下左侧索引栏没显示');
      if (w < 1180 && r.rail && r.rail.display !== 'none') bugs.push('窄屏下左侧索引栏不该显示');
      if (!r.topbar || r.topbar.display === 'none') bugs.push('顶部栏没显示');

      if (r.heroNameFont && r.heroNameFont.size === '16px') bugs.push('首页大标题字号没生效');
      if (r.heroNameLines && r.heroNameLines > 1) bugs.push(`首页大标题折成 ${r.heroNameLines} 行`);
      if (r.cardWidth < 260) bugs.push(`卡片太窄: ${r.cardWidth}px`);
      if (r.hero && r.hero.w > r.viewport.w) bugs.push('hero 比视口还宽');
      if (r.portrait && r.portrait.w > r.viewport.w) bugs.push('头像比视口还宽');
      if (r.portrait && r.portrait.w < 220) bugs.push(`头像太小: ${r.portrait.w}px`);
      // 上传按钮必须真的看得见、点得到
      if (!r.uploadBtn || r.uploadBtn.display === 'none' || r.uploadBtn.w < 90) {
        bugs.push('"上传照片"按钮不见了或太小');
      } else if (r.uploadBtn.h < 36) {
        bugs.push(`"上传照片"按钮只有 ${r.uploadBtn.h}px 高，手指不好点`);
      }
      if (r.resetBtnHidden !== true) bugs.push('没传照片时"恢复默认"不该出现');
      // 正文一行的字数不能少到读不下去
      if (r.cardWidth && r.cardWidth < 300 && w < 760) bugs.push('窄屏卡片宽度异常');

      // 对比度：正文 4.5:1，辅助文字放宽到 3:1（大字号按 AA 也是 3:1）
      const softOK = ['secNote', 'footer'];
      Object.keys(r.contrast).forEach((k) => {
        const v = r.contrast[k];
        const need = softOK.indexOf(k) >= 0 ? 3 : 4.5;
        if (v < need) bugs.push(`对比度不足 ${k}=${v}（需 ≥${need}）`);
      });

      console.log('主题:        ' + r.theme + '   页面高度: ' + r.docH + 'px');
      console.log('横向溢出:    ' + r.overflowX + 'px');
      console.log('索引栏:      ' + (r.rail && r.rail.display !== 'none' ? '显示 ' + r.rail.w + 'px' : '隐藏'));
      console.log('大标题:      ' + (r.heroNameFont ? r.heroNameFont.size + ' / ' + r.heroNameFont.family : '—') +
        (r.heroNameLines ? '（' + r.heroNameLines + ' 行）' : ''));
      console.log('头像:        ' + (r.portrait ? r.portrait.w + 'px 容器 / ' + (r.portraitStage ? r.portraitStage.w + 'px 图' : '') : '—'));
      console.log('上传按钮:    ' + (r.uploadBtn ? r.uploadBtn.w + '×' + r.uploadBtn.h + 'px，可见' : '缺失') +
        '（恢复默认: ' + (r.resetBtnHidden ? '未显示（正确）' : '显示了') + '）');
      console.log('卡片:        ' + r.cardCount + ' 张，每行 ' + r.cardRows.join(' / ') + ' 列，单张宽 ' + r.cardWidth + 'px');
      console.log('缩略图:      ' + r.thumbSvg + ' 个 SVG / ' + r.thumbImg + ' 张截图');
      console.log('对比度:      ' + Object.keys(r.contrast).map((k) => k + ' ' + r.contrast[k]).join('  '));
      console.log('入场动画:    ' + r.revealDone + ' 已显示 / ' + r.revealPending + ' 待滚动');

      if (bugs.length) {
        console.log('\n\u001b[31m问题:\u001b[0m');
        bugs.forEach((b) => console.log('  ✗ ' + b));
        bugs.forEach((b) => problems.push(`${theme}/${label}: ${b}`));
      } else {
        console.log('\n\u001b[32m✓ 没有问题\u001b[0m');
      }
    }
  }

  console.log('\n' + '─'.repeat(58));
  if (problems.length) {
    console.log(`\u001b[31m共 ${problems.length} 项问题\u001b[0m（已测 ${measured}/${sizes.length * themes.length} 组）`);
    process.exitCode = 1;
  } else {
    console.log(`\u001b[32m${themes.length} 个主题 × ${sizes.length} 个宽度 = ${measured} 组全部通过\u001b[0m`);
  }
})();
