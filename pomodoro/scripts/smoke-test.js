/* 番茄钟 · 浏览器冒烟测试
 *
 * 用法（需要 playwright）：
 *   node scripts/smoke-test.js [地址]
 * 默认地址 http://127.0.0.1:5230/。截图落在 .screens/。
 *
 * 两种接管浏览器的方式：
 *   1) 默认：自己拉起本机 Chrome/Edge；
 *   2) 设了 CDP_URL（例如 http://127.0.0.1:9222）就连过去，
 *      适合浏览器已经在跑、或者环境不允许脚本直接 spawn 的情况。
 *
 * 覆盖：基础渲染、倒计时、暂停、上弦（拖拽 + 键盘）、到点结算、
 *       桌面通知内容、纸带与统计、刷新续跑、响应式布局。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { chromium } = require('playwright');

const BASE = process.argv[2] || 'http://127.0.0.1:5230/';
const CDP_URL = process.env.CDP_URL || '';
const SHOTS = path.join(__dirname, '..', '.screens');
const VIEWPORT = { width: 1440, height: 980 };
const CHROME = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean).find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });

/** 连接或拉起浏览器，返回 { browser, context } */
async function openBrowser() {
  if (CDP_URL) {
    const browser = await chromium.connectOverCDP(CDP_URL);
    const context = browser.contexts()[0] || (await browser.newContext());
    return { browser, context, how: `CDP ${CDP_URL}` };
  }
  if (!CHROME) throw new Error('找不到本机 Chrome/Edge，可用 CHROME_PATH 指定，或设 CDP_URL 连过去。');
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  return { browser, context, how: CHROME };
}

let pass = 0;
const failures = [];

function eq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass += 1;
  else failures.push(`${label}\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`);
}
function ok(value, label) { eq(Boolean(value), true, label); }
function group(name, fn) {
  const before = failures.length;
  fn();
  console.log(`  ${failures.length === before ? '✓' : '✗'} ${name}`);
}

/** 造一段极短的静音 WAV，用来测本地音乐——不往仓库里塞音频文件 */
function wavSilence(seconds = 0.5) {
  const rate = 8000;
  const dataLen = Math.floor(rate * seconds) * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // fmt 块长度
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // 单声道
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); // 字节率
  buf.writeUInt16LE(2, 32); // 块对齐
  buf.writeUInt16LE(16, 34); // 位深
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40); // 数据全是 0，也就是静音
  return buf;
}

/** 把计时状态摆到一个已知的"待机专注"（前面的用例会留下正在跑的短休） */
async function settleToIdleFocus(page) {
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('pomodoro/v1'));
    raw.phase = 'focus';
    raw.round = 1;
    raw.running = false;
    raw.deadline = 0;
    raw.startedAt = 0;
    raw.roundTaskId = '';
    // 本轮时长要跟设置对齐：上弦会让两者合法地不一致，但这里必须一致，
    // 否则后面"把专注改成 1 分钟"会变成空操作（值没变 → 不触发任何事）
    raw.totalMs = (raw.settings && raw.settings.focus ? raw.settings.focus : 25) * 60000;
    raw.remainingMs = raw.totalMs;
    localStorage.setItem('pomodoro/v1', JSON.stringify(raw));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(300);
}

/** 表盘上某个角度（0° 在正上方、顺时针）对应的屏幕坐标 */
async function dialPoint(page, angle, ratio = 0.42) {
  const box = await page.locator('#dial').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const r = (box.width / 2) * ratio;
  const a = ((angle - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });

  const { browser, context, how } = await openBrowser();
  console.log(`\n番茄钟 · 浏览器冒烟测试\n  ${BASE}\n  浏览器 ${how}\n`);

  const consoleErrors = [];
  const pageErrors = [];

  // 记录通知与音频分音，用来断言"到点确实响了、确实发了通知"
  await context.addInitScript(() => {
    window.__notes = [];
    window.__osc = 0;
    const Real = window.Notification;
    function Fake(title, opts) {
      window.__notes.push({ title, body: (opts && opts.body) || '' });
    }
    Fake.permission = 'granted';
    Fake.requestPermission = () => Promise.resolve('granted');
    window.Notification = Fake;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      const orig = AC.prototype.createOscillator;
      AC.prototype.createOscillator = function patched() {
        window.__osc += 1;
        return orig.call(this);
      };
    }
    void Real;
  });

  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.setViewportSize(VIEWPORT);
  await page.clock.install();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready).catch(() => {});

  // 每次都从干净的存档开始，否则上一轮跑剩的状态会串进来
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready).catch(() => {});
  // 指针有 0.45s 的过渡，等它扫到位——否则量到的角度是过渡途中的插值
  await page.waitForTimeout(900);

  /* ── 1. 基础渲染 ──────────────────────────────────── */
  const base = await page.evaluate(() => ({
    ticks: document.querySelectorAll('.dial__tick').length,
    minors: document.querySelectorAll('.dial__tick--minor').length,
    majors: document.querySelectorAll('.dial__tick--major').length,
    zero: document.querySelectorAll('.dial__tick--zero').length,
    nums: Array.from(document.querySelectorAll('.dial__num')).map((t) => t.textContent),
    clock: document.getElementById('clock').textContent,
    // 读渲染后的最终矩阵，而不是读声明——原点写错的话，角度声明照样是对的
    handAngle: (() => {
      const mx = getComputedStyle(document.getElementById('dialHand')).transform;
      const m = mx.match(/matrix\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(',').map(Number);
      const deg = (Math.atan2(p[1], p[0]) * 180) / Math.PI;
      return Math.round((((deg % 360) + 360) % 360) * 10) / 10;
    })(),
    bandLen: document.getElementById('dialBand').getAttribute('d').length,
    phase: document.body.dataset.phase,
    start: document.getElementById('startBtn').textContent,
    round: document.getElementById('roundLine').textContent,
    fonts: {
      display: getComputedStyle(document.querySelector('.dial__num')).fontFamily,
      mono: getComputedStyle(document.getElementById('clock')).fontFamily,
      ui: getComputedStyle(document.body).fontFamily,
    },
    loaded: Array.from(document.fonts).filter((f) => f.status === 'loaded').map((f) => f.family),
  }));

  group('表盘：60 格刻度、5 的倍数加粗、零位单独一格', () => {
    eq(base.ticks, 60, '刻度数');
    eq(base.minors, 48, '细刻度 48 格（每分钟一格，去掉每 5 分钟那 12 格）');
    eq(base.majors, 11, '粗刻度 11 格（5…55）');
    eq(base.zero, 1, '零位 1 格');
    eq(base.nums, ['5', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55'], '数字刻度');
  });

  group('初始状态：25:00，指针指在刻度 25', () => {
    eq(base.clock, '25:00', '计数窗');
    ok(Math.abs(base.handAngle - 150) < 1, `指针 150°（实际 ${base.handAngle}°）`);
    ok(base.bandLen > 20, '扇形带已绘制');
    eq(base.phase, 'focus', '阶段为专注');
    eq(base.start, '开始专注', '主按钮文案');
    eq(base.round, '第 1 / 4 个番茄', '轮次提示');
  });

  group('字体加载成功，三个角色各就各位', () => {
    ok(base.fonts.display.includes('Big Shoulders'), '表盘数字用 Big Shoulders Display');
    ok(base.fonts.mono.includes('Azeret'), '计数窗用 Azeret Mono');
    ok(base.fonts.ui.includes('Archivo'), '正文用 Archivo');
    ok(base.loaded.some((f) => /Big Shoulders/.test(f)), `Big Shoulders 实际已加载（已加载：${base.loaded.join(' / ')}）`);
    ok(base.loaded.some((f) => /Azeret/.test(f)), 'Azeret Mono 实际已加载');
    ok(base.loaded.some((f) => /Archivo/.test(f)), 'Archivo 实际已加载');
  });

  await page.screenshot({ path: path.join(SHOTS, 'desktop-idle.png') });

  /* ── 2. 倒计时 ────────────────────────────────────── */
  await page.click('#startBtn');
  await page.clock.fastForward(1000);
  const running = await page.evaluate(() => ({
    clock: document.getElementById('clock').textContent,
    start: document.getElementById('startBtn').textContent,
    running: document.body.classList.contains('is-running'),
    title: document.title,
    disabled: document.getElementById('setFocus').disabled,
    locked: document.getElementById('dial').classList.contains('is-locked'),
  }));

  group('按开始后开始倒数', () => {
    eq(running.clock, '24:59', '1 秒后是 24:59');
    eq(running.start, '暂停', '主按钮变成暂停');
    ok(running.running, 'body 带上运行中标记');
    eq(running.title, '24:59 · 专注', '标题跟着走（切到别的标签页也看得见）');
    ok(running.locked, '计时中表盘锁住，防止误碰改时长');
  });

  await page.clock.fastForward(60 * 1000);
  const after60 = await page.evaluate(() => document.getElementById('clock').textContent);
  group('计时准确：再走 60 秒应该正好 23:59', () => eq(after60, '23:59', '累计 61 秒'));

  // 后台标签页被降频：跑一长段再回来，时间不能漂
  await page.clock.fastForward(10 * 60 * 1000);
  const afterLong = await page.evaluate(() => document.getElementById('clock').textContent);
  group('长时间快进后依然准确（不会累积漂移）', () => eq(afterLong, '13:59', '11 分 1 秒后'));

  await page.screenshot({ path: path.join(SHOTS, 'desktop-running.png') });

  await page.click('#startBtn');
  await page.clock.fastForward(5000);
  const paused = await page.evaluate(() => ({
    clock: document.getElementById('clock').textContent,
    start: document.getElementById('startBtn').textContent,
  }));
  group('暂停后时间定住', () => {
    eq(paused.clock, '13:59', '暂停 5 秒后仍是 13:59');
    eq(paused.start, '继续', '主按钮变成继续');
  });

  await page.click('#resetBtn');
  const afterReset = await page.evaluate(() => ({
    clock: document.getElementById('clock').textContent,
    start: document.getElementById('startBtn').textContent,
    resetDisabled: document.getElementById('resetBtn').disabled,
  }));
  group('重置回本轮起点', () => {
    eq(afterReset.clock, '25:00', '回到 25:00');
    eq(afterReset.start, '开始专注', '回到待机');
    ok(afterReset.resetDisabled, '待机时重置按钮禁用');
  });

  /* ── 3. 上弦 ──────────────────────────────────────── */
  const p10 = await dialPoint(page, (10 / 60) * 360);
  await page.mouse.move(p10.x, p10.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(80);
  const wound = await page.evaluate(() => ({
    clock: document.getElementById('clock').textContent,
    handAngle: (() => {
      const mx = getComputedStyle(document.getElementById('dialHand')).transform;
      const m = mx.match(/matrix\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(',').map(Number);
      const deg = (Math.atan2(p[1], p[0]) * 180) / Math.PI;
      return Math.round((((deg % 360) + 360) % 360) * 10) / 10;
    })(),
    step: document.getElementById('setFocus').value,
  }));
  group('拖动表盘到刻度 10 上弦', () => {
    eq(wound.clock, '10:00', '计数窗变成 10:00');
    ok(Math.abs(wound.handAngle - 60) < 1, `指针转到 60°（实际 ${wound.handAngle}°）`);
  });

  const p45 = await dialPoint(page, (45 / 60) * 360);
  await page.mouse.move(p45.x, p45.y);
  await page.mouse.down();
  await page.mouse.move(p45.x, p45.y);
  await page.mouse.up();
  await page.waitForTimeout(80);
  eq(await page.textContent('#clock'), '45:00', '再拖到刻度 45');

  await page.focus('#dial');
  await page.keyboard.press('ArrowDown');
  eq(await page.textContent('#clock'), '44:00', '方向键 ↓ 减 1 分钟');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  eq(await page.textContent('#clock'), '46:00', '方向键 ↑ 加 1 分钟');

  await page.click('#stepDown');
  await page.click('#stepDown');
  eq(await page.textContent('#clock'), '44:00', '两个 − 按钮各减 1 分钟');

  const focusSetting = await page.inputValue('#setFocus');
  group('上弦没有污染设置里的时长', () => {
    eq(focusSetting, '25', '专注时长仍是 25 分钟（上弦只管这一轮）');
  });

  await page.screenshot({ path: path.join(SHOTS, 'desktop-wound.png') });

  /* ── 4. 到点结算 ──────────────────────────────────── */
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(200);

  // 把专注时长设成 1 分钟，免得等 25 分钟
  await page.fill('#setFocus', '1');
  await page.dispatchEvent('#setFocus', 'change');
  await page.waitForTimeout(60);
  eq(await page.textContent('#clock'), '01:00', '改成 1 分钟后待机界面立刻跟着变');

  await page.click('#startBtn');
  await page.clock.fastForward(61 * 1000);
  await page.waitForTimeout(200);

  const done = await page.evaluate(() => ({
    notes: window.__notes.slice(),
    osc: window.__osc,
    banner: document.getElementById('banner').hidden ? null : document.getElementById('bannerTitle').textContent,
    bannerSub: document.getElementById('bannerSub').textContent,
    bannerBtns: Array.from(document.querySelectorAll('#bannerActions button')).map((b) => b.textContent),
    phase: document.body.dataset.phase,
    chip: document.getElementById('phaseChip').textContent,
    clock: document.getElementById('clock').textContent,
    rows: document.querySelectorAll('.tape__row').length,
    total: document.querySelector('.tape__total') ? document.querySelector('.tape__total').textContent : '',
    tally: document.getElementById('topTally').textContent,
    todayBar: document.querySelector('.chart__bar:last-of-type .chart__num').textContent,
    figures: Array.from(document.querySelectorAll('.figures__item')).map((f) => ({
      num: f.querySelector('.figures__num').textContent,
      label: f.querySelector('.figures__label').textContent,
    })),
    ringing: document.getElementById('plate').classList.contains('is-ringing'),
    recordTask: (JSON.parse(localStorage.getItem('pomodoro/v1') || '{}').days || {})[Object.keys(JSON.parse(localStorage.getItem('pomodoro/v1') || '{}').days || {})[0]]?.sessions[0]?.taskId,
    saved: JSON.parse(localStorage.getItem('pomodoro/v1') || '{}'),
  }));

  group('时间到：敲铃、发通知、弹横幅', () => {
    ok(done.osc > 0, `确实发声了（创建了 ${done.osc} 个振荡器）`);
    eq(done.notes.length, 1, '发了一条桌面通知');
    ok(/专注结束/.test(done.notes[0].title), `通知标题（${done.notes[0].title}）`);
    ok(/短休 5 分钟/.test(done.notes[0].body), `通知正文带下一步（${done.notes[0].body}）`);
    eq(done.banner, '该休息了', '横幅标题');
    ok(/第 1 个番茄完成，今天共 1 个/.test(done.bannerSub), `横幅正文（${done.bannerSub}）`);
    eq(done.bannerBtns, ['开始短休', '先不开始'], '横幅上的两个动作');
    ok(done.ringing, '面板抖了一下（铃响）');
  });

  group('阶段自动推进到短休', () => {
    eq(done.phase, 'short', 'body 切到短休配色');
    eq(done.chip, '短休', '阶段标记');
    eq(done.clock, '05:00', '计数窗变成短休 5 分钟');
  });

  group('纸带记下这一笔', () => {
    eq(done.rows, 1, '一行记录');
    ok(/今天 1 个番茄/.test(done.total), `纸带合计（${done.total}）`);
    ok(/1 分钟专注/.test(done.total), '合计里带专注时长');
  });

  group('统计同步更新', () => {
    ok(/今天\s*1\s*个番茄/.test(done.tally), `顶栏今日（${done.tally}）`);
    eq(done.todayBar, '1', '今天那根柱子标着 1');
    const fig = (label) => done.figures.find((f) => f.label === label);
    eq(fig('7 天番茄').num, '1', '区间番茄数');
    eq(fig('天连续').num, '1', '连续天数');
  });

  group('存档已经落盘', () => {
    eq(done.saved.phase, 'short', '阶段已存');
    eq(Object.keys(done.saved.days).length, 1, '有 1 天的记录');
    eq(done.saved.days[Object.keys(done.saved.days)[0]].sessions.length, 1, '那天有 1 段');
  });

  await page.screenshot({ path: path.join(SHOTS, 'desktop-banner.png') });

  // 点横幅上的「开始短休」
  await page.click('#bannerActions button');
  await page.waitForTimeout(120);
  const started = await page.evaluate(() => ({
    hidden: document.getElementById('banner').hidden,
    clock: document.getElementById('clock').textContent,
  }));
  group('点横幅按钮开始下一轮，横幅收起', () => {
    ok(started.hidden, '横幅已收起');
    eq(started.clock, '05:00', '短休开始计时');
  });

  /* ── 5. 刷新续跑 + 数据留存 ───────────────────────── */
  await page.clock.fastForward(30 * 1000);
  const beforeReload = await page.textContent('#clock');
  await page.reload({ waitUntil: 'load' });
  await page.clock.fastForward(1000);
  const afterReload = await page.evaluate(() => ({
    clock: document.getElementById('clock').textContent,
    running: document.body.classList.contains('is-running'),
    rows: document.querySelectorAll('.tape__row').length,
    tally: document.getElementById('topTally').textContent,
  }));
  group('刷新页面后计时接着走，记录还在', () => {
    eq(afterReload.running, true, '仍处于计时中');
    eq(beforeReload, '04:30', '刷新前是 04:30');
    eq(afterReload.clock, '04:29', '刷新后接着走（不是从头再来）');
    eq(afterReload.rows, 1, '纸带还留着那一笔');
    ok(/1\s*个番茄/.test(afterReload.tally), '统计仍然在');
  });

  /* ── 6. 跨天统计 ──────────────────────────────────── */
  await page.evaluate(() => {
    const key = 'pomodoro/v1';
    const s = JSON.parse(localStorage.getItem(key));
    const now = Date.now();
    for (let i = 1; i <= 3; i++) {
      const d = new Date(now - i * 86400000);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      s.days[k] = { sessions: Array.from({ length: i + 2 }, (_, j) => ({
        id: `s${i}-${j}`, phase: 'focus', startTs: d.getTime() + j * 1800000, endTs: d.getTime() + j * 1800000 + 1500000, plannedMin: 25,
      })) };
    }
    localStorage.setItem(key, JSON.stringify(s));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(250);

  const multi = await page.evaluate(() => ({
    bars: Array.from(document.querySelectorAll('.chart__bar')).map((c) => ({
      n: c.querySelector('.chart__num').textContent,
      h: c.style.getPropertyValue('--h'),
      empty: c.dataset.empty,
    })),
    labels: Array.from(document.querySelectorAll('.chart__label')).map((l) => ({
      text: l.textContent,
      today: l.classList.contains('is-today'),
    })),
    figures: Array.from(document.querySelectorAll('.figures__item')).map((f) => ({
      num: f.querySelector('.figures__num').textContent,
      label: f.querySelector('.figures__label').textContent,
    })),
    goalBottom: document.querySelector('.chart__plot') ? document.querySelector('.chart__plot').style.getPropertyValue('--goal') : '',
    chartMeta: document.getElementById('chartMeta').textContent,
  }));

  // 种子：今天 1 个（前面刚跑完的那轮），1 天前 3 个、2 天前 4 个、3 天前 5 个
  group('7 天柱状图按最大值缩放，今天在最后一格', () => {
    eq(multi.bars.length, 7, '7 根柱子');
    eq(multi.labels.length, 7, '7 个标签');
    ok(multi.labels[6].today, '最后一格是今天');
    eq(multi.labels[6].text, '今天', '今天的标签');
    eq(multi.bars[6].n, '1', '今天是 1 个');
    eq(multi.bars[5].n, '3', '昨天是 3 个');
    eq(multi.bars[3].n, '5', '3 天前是 5 个');
    eq(multi.bars[0].n, '', '6 天前没有记录');
    eq(multi.bars[0].empty, '1', '空的那根标了 data-empty');
    eq(multi.bars[3].h, '62.50%', '最高的一根按目标 8 个缩放（5/8）');
    eq(multi.goalBottom, '100.00%', '目标线画在 8 个的位置');
    ok(/每天 8 个/.test(multi.chartMeta), `目标说明（${multi.chartMeta}）`);
  });

  group('累计与连续天数', () => {
    const fig = (label) => multi.figures.find((f) => f.label === label);
    eq(fig('天连续').num, '4', '今天 + 前 3 天 = 4 天连续');
    eq(fig('7 天番茄').num, '13', '1 + 3 + 4 + 5 = 13 个');
    eq(fig('天达标').num, '0', '目标 8 个，最高的一天 5 个 → 0 天达标');
  });

  await page.screenshot({ path: path.join(SHOTS, 'desktop-stats.png') });

  /* ── 6.5 任务：加 / 选 / 关联 / 完成 / 改 / 删 ─────── */
  await settleToIdleFocus(page);
  await page.fill('#taskInput', '写完这一节的稿');
  await page.press('#taskInput', 'Enter');
  await page.fill('#taskInput', '回邮件');
  await page.press('#taskInput', 'Enter');
  await page.waitForTimeout(120);

  const added = await page.evaluate(() => ({
    rows: Array.from(document.querySelectorAll('.task')).map((r) => ({
      title: r.querySelector('.task__title').textContent,
      sub: r.querySelector('.task__sub').textContent,
      active: r.dataset.active,
      done: r.dataset.done,
    })),
    meta: document.getElementById('tasksMeta').textContent,
    emptyHidden: document.getElementById('tasksEmpty').hidden,
    slip: document.getElementById('slipTitle').textContent,
    slipTag: document.querySelector('.slip__tag').textContent,
    stored: JSON.parse(localStorage.getItem('pomodoro/v1')).tasks.map((t) => t.title),
  }));

  group('往任务列表里加两条，第一条自动成为当前任务', () => {
    eq(added.rows.length, 2, '有两条任务');
    eq(added.rows.map((r) => r.title), ['写完这一节的稿', '回邮件'], '顺序按加入时间');
    eq(added.rows[0].active, '1', '第一条是当前任务');
    eq(added.rows[1].active, '0', '第二条不是');
    eq(added.meta, '0 / 2 已完成', '完成度');
    ok(added.emptyHidden, '空状态提示收起来了');
    eq(added.stored, ['写完这一节的稿', '回邮件'], '已经存档');
  });

  group('工单条跟着显示当前任务', () => {
    eq(added.slip, '写完这一节的稿', '面板上的纸条写着它');
    eq(added.slipTag, '待办', '还没开始 → 待办');
  });

  // 切到第二条，然后跑一个番茄
  await page.click('.task:nth-child(2) .task__main');
  await page.waitForTimeout(80);
  await page.fill('#setFocus', '1');
  await page.dispatchEvent('#setFocus', 'change');
  await page.click('#startBtn');
  await page.waitForTimeout(80);

  const runningSlip = await page.evaluate(() => ({
    slip: document.getElementById('slipTitle').textContent,
    tag: document.querySelector('.slip__tag').textContent,
  }));
  group('开工后工单条变成「在办」', () => {
    eq(runningSlip.slip, '回邮件', '纸条上是在办的那条');
    eq(runningSlip.tag, '在办', '标记变成在办');
  });

  await page.clock.fastForward(61 * 1000);
  await page.waitForTimeout(150);

  const afterTask = await page.evaluate(() => ({
    rows: Array.from(document.querySelectorAll('.task')).map((r) => ({
      title: r.querySelector('.task__title').textContent,
      sub: r.querySelector('.task__sub').textContent,
      active: r.dataset.active,
    })),
    tapeTasks: Array.from(document.querySelectorAll('.tape__task')).map((t) => t.textContent),
    recordTaskId: (() => {
      const s = JSON.parse(localStorage.getItem('pomodoro/v1'));
      const day = s.days[Object.keys(s.days).sort().pop()];
      const last = day.sessions.filter((x) => x.phase === 'focus').pop();
      return { taskId: last.taskId, matches: s.tasks.some((t) => t.id === last.taskId) };
    })(),
  }));

  group('这一轮番茄记到了当前任务头上', () => {
    const row = afterTask.rows.find((r) => r.title === '回邮件');
    ok(/1 个番茄/.test(row.sub), `任务行显示进度（${row.sub}）`);
    eq(row.active, '1', '仍然是当前任务');
    ok(afterTask.recordTaskId.matches, '记录里的 taskId 指向真实任务');
    eq(afterTask.tapeTasks.pop(), '回邮件', '纸带上也标了任务名');
  });

  // 改：点「改」→ 改标题和预估
  await page.click('.task:nth-child(2) .task__act');
  await page.waitForTimeout(80);
  const editing = await page.evaluate(() => ({
    editingRows: document.querySelectorAll('.task--editing').length,
    value: document.querySelector('.task__edit-input').value,
    focused: document.activeElement.classList.contains('task__edit-input'),
  }));
  group('点「改」进入就地编辑，输入框自动聚焦', () => {
    eq(editing.editingRows, 1, '有一行进入编辑态');
    eq(editing.value, '回邮件', '带出原标题');
    ok(editing.focused, '焦点在输入框里');
  });

  await page.fill('.task__edit-input', '回完所有邮件');
  await page.fill('.task__edit-est', '3');
  await page.press('.task__edit-input', 'Enter');
  await page.waitForTimeout(120);
  const edited = await page.evaluate(() => ({
    titles: Array.from(document.querySelectorAll('.task__title')).map((t) => t.textContent),
    sub: Array.from(document.querySelectorAll('.task__sub')).map((t) => t.textContent),
    stored: JSON.parse(localStorage.getItem('pomodoro/v1')).tasks.map((t) => ({ title: t.title, estimate: t.estimate })),
  }));
  group('编辑保存后标题和预估都更新了', () => {
    ok(edited.titles.includes('回完所有邮件'), '新标题生效');
    ok(edited.sub.some((s) => /1 \/ 3 个番茄/.test(s)), `进度按新的预估显示（${edited.sub.join(' | ')}）`);
    eq(edited.stored.find((t) => t.title === '回完所有邮件').estimate, 3, '预估存下来了');
  });

  // 完成第二条 → 当前任务应该让给第一条
  await page.click('.task:nth-child(2) .task__check');
  await page.waitForTimeout(120);
  const doneTask = await page.evaluate(() => ({
    rows: Array.from(document.querySelectorAll('.task')).map((r) => ({
      title: r.querySelector('.task__title').textContent,
      done: r.dataset.done,
      active: r.dataset.active,
    })),
    meta: document.getElementById('tasksMeta').textContent,
    slip: document.getElementById('slipTitle').textContent,
  }));
  group('勾完成之后当前任务让给还没做完的那条', () => {
    eq(doneTask.rows.find((r) => r.title === '回完所有邮件').done, '1', '标记为完成');
    eq(doneTask.rows.find((r) => r.title === '写完这一节的稿').active, '1', '当前任务换成第一条');
    eq(doneTask.meta, '1 / 2 已完成', '完成度更新');
    eq(doneTask.slip, '写完这一节的稿', '工单条跟着换');
  });

  /* ── 6.6 效率图表 ─────────────────────────────────── */
  const eff = await page.evaluate(() => ({
    hours: document.querySelectorAll('.hours__col').length,
    hoursNonEmpty: Array.from(document.querySelectorAll('.hours__col')).filter((c) => c.dataset.empty === '0').length,
    hoursMeta: document.getElementById('hoursMeta').textContent,
    rankRows: Array.from(document.querySelectorAll('#taskRank .rank__row')).map((r) => ({
      title: r.querySelector('.rank__title').textContent,
      num: r.querySelector('.rank__num').textContent,
      unknown: r.dataset.unknown,
    })),
    rankMeta: document.getElementById('rankMeta').textContent,
    pressed: Array.from(document.querySelectorAll('.range__btn')).map((b) => b.dataset.days + '=' + b.getAttribute('aria-pressed')),
  }));

  group('时段分布画了 24 根柱子', () => {
    eq(eff.hours, 24, '24 个小时');
    ok(eff.hoursNonEmpty > 0, `有数据的时段 ${eff.hoursNonEmpty} 个`);
    ok(/最出活 \d+:00/.test(eff.hoursMeta), `峰值提示（${eff.hoursMeta}）`);
  });

  group('任务消耗排行把番茄摊到任务上', () => {
    ok(eff.rankRows.length >= 1, `有 ${eff.rankRows.length} 行`);
    ok(eff.rankRows.some((r) => r.title === '回完所有邮件'), '刚做的那条在榜上');
    ok(/个 · /.test(eff.rankRows[0].num), `带番茄数和时长（${eff.rankRows[0].num}）`);
  });

  group('区间默认 7 天', () => {
    eq(eff.pressed, ['7=true', '30=false'], '7 天被按下');
  });

  // 切到 30 天
  await page.click('.range__btn[data-days="30"]');
  await page.waitForTimeout(180);
  const wideView = await page.evaluate(() => ({
    bars: document.querySelectorAll('.chart__bar').length,
    labels: Array.from(document.querySelectorAll('.chart__label')).filter((l) => l.textContent).length,
    pressed: Array.from(document.querySelectorAll('.range__btn')).map((b) => b.dataset.days + '=' + b.getAttribute('aria-pressed')),
    stored: JSON.parse(localStorage.getItem('pomodoro/v1')).settings.range,
    figLabel: document.querySelector('.figures__label').textContent,
  }));
  group('切到 30 天：柱子变多、标签自动抽稀', () => {
    eq(wideView.bars, 30, '30 根柱子');
    ok(wideView.labels <= 9, `标签抽稀到 ${wideView.labels} 个，不会糊成一片`);
    eq(wideView.pressed, ['7=false', '30=true'], '30 天被按下');
    eq(wideView.stored, 30, '区间存进设置');
    eq(wideView.figLabel, '30 天番茄', '指标标题跟着换');
  });
  await page.click('.range__btn[data-days="7"]');
  await page.waitForTimeout(150);

  /* ── 6.7 背景声音 ─────────────────────────────────── */
  const scenesInit = await page.evaluate(() => ({
    count: document.querySelectorAll('.scene').length,
    labels: Array.from(document.querySelectorAll('.scene')).map((s) => s.textContent),
    pressed: Array.from(document.querySelectorAll('.scene')).filter((s) => s.getAttribute('aria-pressed') === 'true').map((s) => s.dataset.scene),
    toggleDisabled: document.getElementById('musicToggle').disabled,
    musicName: document.getElementById('musicName').textContent,
  }));
  group('环境音场景齐了，默认是关闭', () => {
    eq(scenesInit.count, 7, '7 个场景');
    eq(scenesInit.labels[0], '关闭', '第一个是关闭');
    eq(scenesInit.pressed, ['off'], '默认选中关闭');
    ok(scenesInit.toggleDisabled, '没选音乐时播放按钮是禁用的');
    eq(scenesInit.musicName, '未选择', '还没选音乐');
  });

  await page.click('.scene[data-scene="rain"]');
  await page.waitForTimeout(500);
  const rain = await page.evaluate(() => ({
    pressed: Array.from(document.querySelectorAll('.scene')).filter((s) => s.getAttribute('aria-pressed') === 'true').map((s) => s.dataset.scene),
    meta: document.getElementById('soundMeta').textContent,
    hint: document.getElementById('soundHint').textContent,
    stored: JSON.parse(localStorage.getItem('pomodoro/v1')).settings.ambience,
    osc: window.__osc,
  }));
  group('选「雨」会真的出声（计时没跑时先试听）', () => {
    eq(rain.pressed, ['rain'], '雨被选中');
    eq(rain.stored, 'rain', '已存档');
    ok(/雨/.test(rain.meta), `状态栏说明（${rain.meta}）`);
    ok(/雨声/.test(rain.hint), `提示写着这个场景是什么动静（${rain.hint}）`);
    ok(rain.osc > 0, `生成了音频节点（振荡器 ${rain.osc} 个）`);
  });

  await page.screenshot({ path: path.join(SHOTS, 'desktop-sound.png') });

  // 音量滑块
  await page.fill('#ambVolume', '80');
  await page.dispatchEvent('#ambVolume', 'input');
  await page.waitForTimeout(120);
  const vol = await page.evaluate(() => ({
    text: document.getElementById('ambVolumeText').textContent,
    stored: JSON.parse(localStorage.getItem('pomodoro/v1')).settings.ambienceVolume,
  }));
  group('环境音音量可调', () => {
    eq(vol.text, '80%', '读数跟着走');
    eq(vol.stored, 0.8, '存档为 0–1');
  });

  // 本地音乐：用内存里的一段 WAV，不往仓库里放音频文件
  await page.setInputFiles('#musicFile', {
    name: '我的歌.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.from(wavSilence()),
  });
  await page.waitForTimeout(200);
  const picked = await page.evaluate(() => ({
    name: document.getElementById('musicName').textContent,
    disabled: document.getElementById('musicToggle').disabled,
    scene: JSON.parse(localStorage.getItem('pomodoro/v1')).settings.ambience,
    pressed: Array.from(document.querySelectorAll('.scene')).filter((s) => s.getAttribute('aria-pressed') === 'true').map((s) => s.dataset.scene),
  }));
  group('载入本地音乐：和环境音互斥，自动把环境音关掉', () => {
    eq(picked.name, '我的歌.wav', '显示文件名');
    eq(picked.disabled, false, '播放按钮可以点了');
    eq(picked.scene, 'off', '环境音被让位');
    eq(picked.pressed, ['off'], '场景按钮回到关闭');
  });

  await page.click('#musicToggle');
  await page.waitForTimeout(400);
  const playing = await page.evaluate(() => ({
    label: document.getElementById('musicToggle').textContent,
    meta: document.getElementById('soundMeta').textContent,
  }));
  group('本地音乐能真的播起来', () => {
    eq(playing.label, '暂停', '按钮变成暂停（说明 play() 真的成功了）');
    ok(/播放中/.test(playing.meta), `状态栏（${playing.meta}）`);
  });

  /* ── 7. 设置与开关 ────────────────────────────────── */
  await page.fill('#setLong', '99');
  await page.dispatchEvent('#setLong', 'change');
  await page.waitForTimeout(80);
  const clamped = await page.evaluate(() => ({
    long: document.getElementById('setLong').value,
    hint: document.getElementById('setHint').textContent,
    invalid: document.querySelector('#setLong').closest('.field__box').classList.contains('is-invalid'),
  }));
  group('超出范围的设置被夹回并给出说明', () => {
    eq(clamped.long, '60', '长休上限 60 分钟');
    ok(/1–60 之间/.test(clamped.hint), `提示（${clamped.hint}）`);
    ok(clamped.invalid, '输入框标红');
  });

  await page.click('#soundBtn');
  const soundOff = await page.evaluate(() => ({
    pressed: document.getElementById('soundBtn').getAttribute('aria-pressed'),
    checked: document.getElementById('setSound').checked,
    stored: JSON.parse(localStorage.getItem('pomodoro/v1')).settings.sound,
  }));
  group('顶栏开关和设置里的开关是同一个状态', () => {
    eq(soundOff.pressed, 'false', 'aria-pressed 关闭');
    eq(soundOff.checked, false, '设置里的勾也取消');
    eq(soundOff.stored, false, '已存档');
  });
  await page.click('#soundBtn');

  /* ── 8. 快捷键 ────────────────────────────────────── */
  // 先摆回待机专注：重置按钮在待机时是禁用的，不能拿来当"回到起点"用
  await settleToIdleFocus(page);
  // 焦点要是还停在按钮上，空格会被浏览器当成"按下这个按钮"（这是标准行为，不是 bug），
  // 所以先把焦点移开，再测全局快捷键。
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('Space');
  await page.waitForTimeout(60);
  const spaceOn = await page.evaluate(() => document.body.classList.contains('is-running'));
  await page.keyboard.press('Space');
  await page.waitForTimeout(60);
  const spaceOff = await page.evaluate(() => document.body.classList.contains('is-running'));
  group('空格开始 / 暂停', () => {
    ok(spaceOn, '第一下开始');
    eq(spaceOff, false, '第二下暂停');
  });

  const beforeSkip = await page.evaluate(() => ({
    phase: document.body.dataset.phase,
    rows: document.querySelectorAll('.tape__row').length,
  }));
  await page.keyboard.press('KeyN');
  await page.waitForTimeout(80);
  const skipped = await page.evaluate(() => ({
    phase: document.body.dataset.phase,
    rows: document.querySelectorAll('.tape__row').length,
  }));
  group('按 N 跳过这一段，且不计入统计', () => {
    ok(skipped.phase !== beforeSkip.phase, `阶段确实翻篇了（${beforeSkip.phase} → ${skipped.phase}）`);
    eq(skipped.rows, beforeSkip.rows, '纸带没有新增（跳过不算番茄）');
  });

  /* ── 9. 响应式 ────────────────────────────────────── */
  const layout = async (w, h, name) => {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(260);
    const info = await page.evaluate(() => {
      const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      const dial = document.getElementById('dial').getBoundingClientRect();
      const plate = document.querySelector('.plate').getBoundingClientRect();
      const tape = document.querySelector('.card--tape').getBoundingClientRect();
      const cols = getComputedStyle(document.querySelector('.layout')).gridTemplateColumns;
      return {
        overflow,
        dial: Math.round(dial.width),
        plate: Math.round(plate.width),
        tapeRight: Math.round(tape.right),
        cols,
        clockSize: getComputedStyle(document.getElementById('clock')).fontSize,
      };
    });
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
    return info;
  };

  const tablet = await layout(900, 1000, 'tablet-900');
  const phone = await layout(390, 844, 'phone-390');
  const wide = await layout(1920, 1100, 'desktop-1920');

  group('布局在窄屏下不横向溢出', () => {
    eq(tablet.overflow, 0, `900 宽无溢出（表盘 ${tablet.dial}px）`);
    eq(phone.overflow, 0, `390 宽无溢出（表盘 ${phone.dial}px）`);
    eq(wide.overflow, 0, `1920 宽无溢出（表盘 ${wide.dial}px）`);
    ok(phone.dial <= 390 - 30, '手机上表盘塞得下');
    ok(phone.dial > 200, '手机上表盘不至于太小');
  });

  /* ── 10. 控制台干净 ───────────────────────────────── */
  group('没有 JS 报错，也没有控制台错误', () => {
    eq(pageErrors, [], '未捕获异常');
    const meaningful = consoleErrors.filter((t) => !/fonts\.googleapis|fonts\.gstatic|net::ERR/.test(t));
    eq(meaningful, [], '控制台报错');
  });

  await browser.close();

  console.log('');
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}\n`);
    console.log(`失败 ${failures.length} 项，通过 ${pass} 项。截图见 .screens/\n`);
    process.exit(1);
  }
  console.log(`全部通过：${pass} 项断言。截图见 .screens/\n`);
})().catch((err) => {
  console.error('\n冒烟测试中断：', err);
  process.exit(1);
});
