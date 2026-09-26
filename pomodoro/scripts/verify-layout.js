/* 番茄钟 · 版面体检
 *
 * 用法：
 *   node scripts/verify-layout.js [地址]
 *
 * 截图看不出问题（比如两块元素悄悄叠在一起、计数窗里的数字被裁掉、深色卡片和底色糊成一片），
 * 所以这里直接读浏览器的真实几何和计算样式，逐条断言版面不变量，并把关键数据打出来。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { decodePng, sampleAt, isWarm } = require('./lib/png.js');

const BASE = process.argv[2] || 'http://127.0.0.1:5230/';
const CDP_URL = process.env.CDP_URL || '';
const CHROME = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean).find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });

let pass = 0;
const failures = [];
function eq(a, b, label) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass += 1;
  else failures.push(`${label}\n    期望 ${JSON.stringify(b)}\n    实际 ${JSON.stringify(a)}`);
}
const ok = (v, label) => eq(Boolean(v), true, label);
function group(name, fn) {
  const before = failures.length;
  fn();
  console.log(`  ${failures.length === before ? '✓' : '✗'} ${name}`);
}

/** 页面里跑：把关心的元素量一遍 */
const MEASURE = () => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      sel,
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      right: Math.round(r.right), bottom: Math.round(r.bottom),
      color: cs.color,
      bg: cs.backgroundColor,
      font: cs.fontFamily.split(',')[0].replace(/["']/g, ''),
      size: cs.fontSize,
      weight: cs.fontWeight,
      overflowX: el.scrollWidth - el.clientWidth,
      overflowY: el.scrollHeight - el.clientHeight,
    };
  };
  const sels = [
    '.topbar', '.layout', '.instrument', '.plate', '.plate__label', '.dial',
    '.counter', '.counter__window', '.counter__digits', '.counter__meta', '.chip',
    '.counter__round', '.pushers', '.pusher--main', '#resetBtn', '#skipBtn',
    '.instrument__hint', '.column', '.card--tape', '.tape', '.card--tape + .card',
    '.chart', '.figures', '#setTitle',
  ];
  const boxes = {};
  for (const s of sels) boxes[s] = box(s);

  // 数字实际渲染宽度 vs 容器宽度：判断会不会被裁掉
  const digits = document.querySelector('.counter__digits');
  const range = document.createRange();
  range.selectNodeContents(digits);
  const textW = Math.round(range.getBoundingClientRect().width);

  // 对比度
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((v) => parseFloat(v));
    return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
  };
  const rel = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const L = (c) => 0.2126 * rel(c.r) + 0.7152 * rel(c.g) + 0.0722 * rel(c.b);
  const blend = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const ratio = (fgHex, bgHex) => {
    const f = parse(fgHex); const b = parse(bgHex);
    if (!f || !b) return null;
    const F = f.a < 1 ? blend(f, b) : f;
    const l1 = L(F); const l2 = L(b);
    const hi = Math.max(l1, l2); const lo = Math.min(l1, l2);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };

  const shell = getComputedStyle(document.body).backgroundColor;
  const cardEl = document.querySelector('.card:not(.card--tape)');
  const card = cardEl ? getComputedStyle(cardEl).backgroundColor : null;

  /** 取某个选择器的前景色 / 背景色，元素不存在就返回 null（对比度表里会跳过） */
  const cs = (sel, prop) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const v = getComputedStyle(el)[prop];
    return v && v !== 'rgba(0, 0, 0, 0)' ? v : null;
  };
  const pairs = [
    ['正文/桌面', cs('body', 'color'), shell],
    ['深色卡标题/卡片', cs('#chartTitle', 'color'), card],
    ['深色卡次要字/卡片', cs('#chartMeta', 'color'), card],
    ['字段标签/卡片', cs('.field__label', 'color'), card],
    ['计数窗数字/窗内底', cs('.counter__digits', 'color'), 'rgb(20, 25, 21)'],
    ['纸面标题/纸面', cs('.card--tape .card__title', 'color'), cs('.card--tape', 'backgroundColor')],
    ['纸带时间戳/纸面', cs('.tape__span', 'color'), cs('.card--tape', 'backgroundColor')],
    ['纸面次要字/纸面', cs('#tapeMeta', 'color'), cs('.card--tape', 'backgroundColor')],
    ['铭牌/面板', cs('.plate__label', 'color'), 'rgb(243, 239, 227)'],
    ['面板文字/面板', cs('.counter__round', 'color'), 'rgb(243, 239, 227)'],
    ['阶段标记/面板', cs('.chip', 'color'), cs('.chip', 'backgroundColor')],
  ];
  const contrast = {};
  for (const [label, fg, bg] of pairs) {
    if (!fg || !bg) continue;
    const r = ratio(fg, bg);
    if (r !== null) contrast[label] = r;
  }

  return {
    boxes,
    textW,
    shell,
    card,
    contrast,
    viewport: { w: innerWidth, h: innerHeight },
    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    // 表盘几何：只报"应该在哪里"，实际渲染到哪儿由下面的像素采样来验
    handGeom: (() => {
      const d = document.getElementById('dial').getBoundingClientRect();
      // 读渲染后的最终变换（computed style 会给出矩阵），而不是读声明，
      // 这样"原点写错导致实际角度不对"才瞒不过去。
      const mx = getComputedStyle(document.getElementById('dialHand')).transform;
      const m = mx.match(/matrix\(([^)]+)\)/);
      const angle = m ? (Math.atan2(Number(m[1].split(',')[1]), Number(m[1].split(',')[0])) * 180) / Math.PI : null;
      const band = document.getElementById('dialBand').getAttribute('d') || '';
      // 路径形如 M cx cy L x1 y1 A r r 0 large 1 x2 y2 Z，末点是扇形带的右缘
      const arc = band.match(/A [\d.]+ [\d.]+ \d \d 1 ([\d.]+) ([\d.]+)/);
      const angleOf = (x, y) => {
        let a = (Math.atan2(Number(x) - 210, 210 - Number(y)) * 180) / Math.PI;
        return a < 0 ? a + 360 : a;
      };
      return {
        box: { x: d.x, y: d.y, w: d.width, h: d.height },
        declAngle: angle === null ? null : Math.round(((angle % 360) + 360) % 360 * 10) / 10,
        bandAngle: arc ? Math.round(angleOf(arc[1], arc[2]) * 10) / 10 : null,
        bandLen: band.length,
      };
    })(),
    bandLen: document.getElementById('dialBand').getAttribute('d').length,
    dialSvg: (() => {
      const r = document.querySelector('.dial__svg').getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    })(),
    tickStroke: getComputedStyle(document.querySelector('.dial__tick--minor')).stroke,
  };
};

(async () => {
  let browser;
  let context;
  if (CDP_URL) {
    browser = await chromium.connectOverCDP(CDP_URL);
    context = browser.contexts()[0] || (await browser.newContext());
  } else {
    if (!CHROME) throw new Error('找不到本机 Chrome/Edge，可用 CHROME_PATH 或 CDP_URL 指定。');
    browser = await chromium.launch({ executablePath: CHROME });
    context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
  }

  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 980 });
  await page.goto(BASE, { waitUntil: 'load' });

  // 造几天真实数据再刷新：纸带、柱状图、统计数字都要在"有内容"的状态下量
  await page.evaluate(() => {
    localStorage.clear();
    const pad = (n) => String(n).padStart(2, '0');
    const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const days = {};
    const plan = [4, 6, 3, 0, 5, 7, 2];
    for (let i = 0; i < plan.length; i++) {
      const base = new Date();
      base.setDate(base.getDate() - i);
      base.setHours(9, 0, 0, 0);
      const t0 = base.getTime();
      const sessions = [];
      for (let j = 0; j < plan[i]; j++) {
        const s = t0 + j * 30 * 60000;
        sessions.push({ id: `s${i}-${j}`, phase: 'focus', startTs: s, endTs: s + 25 * 60000, plannedMin: 25 });
        sessions.push({ id: `b${i}-${j}`, phase: 'short', startTs: s + 25 * 60000, endTs: s + 30 * 60000, plannedMin: 5 });
      }
      if (sessions.length) days[dayKey(base)] = { sessions };
    }
    localStorage.setItem('pomodoro/v1', JSON.stringify({
      settings: { focus: 25, short: 5, long: 15, rounds: 4, goal: 8, autoNext: false, sound: true, ticking: false, keepAwake: false },
      phase: 'focus', round: 1, running: false, deadline: 0,
      remainingMs: 25 * 60000, totalMs: 25 * 60000, startedAt: 0, days, notifyAsked: true,
    }));
  });
  await page.reload({ waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready).catch(() => {});
  // 指针有 0.45s 的过渡，等它扫到位再量，否则量到的是中间的插值
  await page.waitForTimeout(900);

  console.log(`\n番茄钟 · 版面体检\n  ${BASE}\n`);

  const m = await page.evaluate(MEASURE);
  const b = m.boxes;

  /* ── 1. 仪器内部自上而下的顺序与不重叠 ───────────── */
  const chain = ['.plate__label', '.dial', '.counter', '.counter__meta', '.pushers'];
  let ordered = true;
  let msg = [];
  for (let i = 1; i < chain.length; i++) {
    const prev = b[chain[i - 1]];
    const cur = b[chain[i]];
    const gap = cur.y - prev.bottom;
    msg.push(`${chain[i - 1].slice(1)}→${chain[i].slice(1)} ${gap}px`);
    if (gap < 2) ordered = false;
  }
  group('面板内五块自上而下依次排开、互不重叠', () => {
    ok(ordered, `相邻间距：${msg.join('，')}`);
  });

  group('所有元素都待在面板的内容框里', () => {
    const plate = b['.plate'];
    const strays = chain.filter((s) => {
      const r = b[s];
      return r.x < plate.x || r.right > plate.right || r.y < plate.y || r.bottom > plate.bottom;
    });
    eq(strays, [], '越界的元素');
  });

  group('表盘是正方形，且 SVG 铺满', () => {
    eq(b['.dial'].w, b['.dial'].h, `表盘 ${b['.dial'].w}×${b['.dial'].h}`);
    eq(m.dialSvg.w, b['.dial'].w, 'SVG 宽度等于表盘宽度');
    ok(m.dialSvg.w > 240, `表盘够大（${m.dialSvg.w}px）`);
  });

  /* ── 2. 数字不会被裁 ───────────────────────────── */
  group('计数窗放得下 25:00，不溢出', () => {
    ok(b['.counter__digits'].overflowX <= 0, '数字自身不溢出');
    ok(m.textW + 8 <= b['.counter__window'].w, `数字宽 ${m.textW}px，窗口宽 ${b['.counter__window'].w}px`);
    eq(b['.counter__window'].overflowX, 0, '窗口无横向滚动');
  });

  /* ── 3. 指针：不看属性，直接采截图上的像素 ─────── */
  /* 属性写着 rotate(150) 不等于画出来就在 150°——transform-origin 写错、
     SVG 尺寸算错、层级被盖住，属性都照样是对的。所以这里把指针尖"应该"在的
     屏幕坐标算出来，去截图里挖那一块像素，看它是不是番茄红。 */
  await page.evaluate(() => window.scrollTo(0, 0));
  const shot = await page.screenshot(); // 整屏，坐标即 CSS 像素
  const img = decodePng(shot);

  const box = m.handGeom.box;
  const dcx = box.x + box.w / 2;
  const dcy = box.y + box.h / 2;
  const R = box.w / 2;
  const atAngle = (deg, ratio) => sampleAt(img, dcx + Math.sin((deg * Math.PI) / 180) * R * ratio, dcy - Math.cos((deg * Math.PI) / 180) * R * ratio);

  const tipPx = atAngle(150, 0.55);        // 指针应该扫过这里（别贴着尖端取，那里只有一两个像素宽）
  const opposite = atAngle(330, 0.55);     // 对面什么都没有，应是搪瓷
  const outside = atAngle(150, 0.99);      // 表盘外圈，应是面板的搪瓷
  // 轴心是"深色轮毂 + 中间一颗浅色销钉"，和真实仪表一样，所以要分开取
  const pinPx = sampleAt(img, dcx, dcy, 2);
  const hubRing = [0, 90, 180, 270].map((d) => sampleAt(img, dcx + Math.sin((d * Math.PI) / 180) * 10, dcy - Math.cos((d * Math.PI) / 180) * 10, 1));
  const hubMaxLum = Math.max(...hubRing.map((c) => c.lum));

  console.log('\n  像素采样（整屏截图，坐标即 CSS 像素）：');
  console.log(`    截图              ${img.width}×${img.height}，表盘圆心 (${Math.round(dcx)},${Math.round(dcy)})，半径 ${Math.round(R)}`);
  console.log(`    指针方向   150° @0.55R   ${tipPx.hex}   暖色=${isWarm(tipPx)}`);
  console.log(`    反方向     330° @0.55R   ${opposite.hex}   暖色=${isWarm(opposite)}`);
  console.log(`    轴心销钉                 ${pinPx.hex}   亮度=${Math.round(pinPx.lum)}`);
  console.log(`    轮毂环（r=10px）         ${hubRing.map((c) => c.hex).join(' ')}   最亮=${Math.round(hubMaxLum)}`);
  console.log(`    表盘外沿   150° @0.99R   ${outside.hex}\n`);

  group('指针确实画在刻度 25（150°）上', () => {
    eq(m.handGeom.declAngle, 150, '渲染后的最终角度');
    eq(m.handGeom.bandAngle, 150, '扇形带右缘与指针齐平');
    ok(isWarm(tipPx), `指针方向的像素是阶段色（${tipPx.hex}）`);
    ok(!isWarm(opposite), `反方向没有指针（${opposite.hex}）`);
    ok(opposite.lum > 200, '反方向是搪瓷亮面');
    ok(pinPx.lum > 190, `轴心是浅色销钉（${pinPx.hex}）`);
    ok(hubMaxLum < 130, `销钉四周是深色轮毂（最亮 ${Math.round(hubMaxLum)}）`);
    ok(outside.lum > 200, `表盘外圈仍是面板搪瓷（${outside.hex}）`);
  });

  /* ── 4. 溢出 ───────────────────────────────────── */
  group('1440 宽无横向溢出', () => {
    eq(m.docOverflow, 0, '文档溢出');
    const bad = Object.values(b).filter((r) => r && r.overflowX > 1).map((r) => `${r.sel}:${r.overflowX}`);
    eq(bad, [], '内部元素溢出');
  });

  /* ── 5. 对比度 ─────────────────────────────────── */
  console.log('\n  对比度（WCAG AA：正文 ≥4.5，大字 ≥3）：');
  for (const [k, v] of Object.entries(m.contrast)) {
    console.log(`    ${k.padEnd(18, '　')} ${String(v).padStart(6)}:1  ${v >= 4.5 ? 'AA' : v >= 3 ? 'AA-大字' : '偏低'}`);
  }
  console.log('');
  group('正文与关键文字的对比度达标', () => {
    for (const [k, v] of Object.entries(m.contrast)) ok(v >= 4.5, `${k} = ${v}:1`);
  });

  group('深色卡片和桌面底色能分出层次', () => {
    const diff = (a, c) => {
      const p = (s) => s.match(/\d+/g).map(Number);
      const A = p(a); const C = p(c);
      return Math.abs(A[0] - C[0]) + Math.abs(A[1] - C[1]) + Math.abs(A[2] - C[2]);
    };
    const d = diff(m.card, m.shell);
    ok(d >= 12, `卡片 ${m.card} 与桌面 ${m.shell} 的通道差合计 ${d}（≥12 才看得出是一张卡）`);
  });

  /* ── 6. 响应式下重排 ───────────────────────────── */
  console.log('  各宽度下的关键尺寸：');
  const widths = [1920, 1440, 1180, 1020, 900, 768, 600, 430, 360];
  const rowsOut = [];
  for (const w of widths) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(140);
    const r = await page.evaluate(() => {
      const g = (s) => { const e = document.querySelector(s); const r = e.getBoundingClientRect(); return { w: Math.round(r.width), x: Math.round(r.x), b: Math.round(r.bottom) }; };
      const layout = document.querySelector('.layout');
      const plate = document.querySelector('.plate').getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        plate: Math.round(plate.width),
        dial: g('.dial').w,
        window: g('.counter__window').w,
        digitsOverflow: document.querySelector('.counter__digits').scrollWidth - document.querySelector('.counter__window').clientWidth,
        // 单列 / 双列以 grid 实际算出几列为准，光看坐标会被"单列 + 居中面板"骗过去
        single: getComputedStyle(layout).gridTemplateColumns.trim().split(/\s+/).length === 1,
        pusherH: Math.round(document.querySelector('.pusher--main').getBoundingClientRect().height),
        chartPlotH: Math.round(document.querySelector('.chart__plot').getBoundingClientRect().height),
      };
    });
    rowsOut.push([w, r]);
    console.log(`    ${String(w).padStart(4)}px  面板 ${String(r.plate).padStart(4)}  表盘 ${String(r.dial).padStart(3)}  计数窗 ${String(r.window).padStart(3)}  主按钮 ${r.pusherH}  柱状图 ${r.chartPlotH}  ${r.single ? '单列' : '双列'}  溢出 ${r.overflow}`);
  }
  console.log('');

  group('每种宽度都不横向溢出，数字都放得下', () => {
    const bad = rowsOut.filter(([, r]) => r.overflow !== 0).map(([w]) => `${w}px 溢出 ${w}`);
    eq(bad, [], '溢出的宽度');
    const clipped = rowsOut.filter(([, r]) => r.digitsOverflow > 0).map(([w, r]) => `${w}px 数字超 ${r.digitsOverflow}px`);
    eq(clipped, [], '数字被裁的宽度');
  });

  group('窄屏时右栏落到面板下方（单列）', () => {
    const wide = rowsOut.find(([w]) => w === 1440)[1];
    const at1020 = rowsOut.find(([w]) => w === 1020)[1];
    const narrow = rowsOut.find(([w]) => w === 430)[1];
    eq(wide.single, false, '1440 是双列');
    eq(at1020.single, true, '1020 起切成单列');
    eq(narrow.single, true, '430 是单列');
  });

  group('柱状图绘图区高度稳定，不随宽度塌掉', () => {
    const bad = rowsOut.filter(([, r]) => r.chartPlotH < 90).map(([w, r]) => `${w}px 只有 ${r.chartPlotH}px`);
    eq(bad, [], '被压扁的宽度');
  });

  group('触屏尺寸下按钮不至于太小', () => {
    const small = rowsOut.filter(([, r]) => r.pusherH < 40).map(([w, r]) => `${w}px 按钮高 ${r.pusherH}`);
    eq(small, [], '过矮的按钮');
  });

  await browser.close();

  console.log('');
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}\n`);
    console.log(`失败 ${failures.length} 项，通过 ${pass} 项。\n`);
    process.exit(1);
  }
  console.log(`全部通过：${pass} 项断言。\n`);
})().catch((err) => {
  console.error('\n版面体检中断：', err);
  process.exit(1);
});
