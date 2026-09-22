/**
 * 开发用：把版面拍成图 + 把版面量成数字（不是应用的一部分）
 *
 *   npm start                 # 另开一个终端把服务起起来
 *   node scripts/shots.js     # 五张截图 + 一份版面数字，写到 .screens/
 *
 *   CHROME_PATH=... node scripts/shots.js
 *   PORT=5200 node scripts/shots.js
 *
 * 截图靠 headless Chrome；数字来自 scripts/layout-probe.html。
 * 两者分工：图是给眼睛看的，数字是给判断用的——
 * "三栏宽度之和等于视口宽""光标记号和块对齐"这种事，肉眼看不出来。
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const CHROME = process.env.CHROME_PATH ||
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe');
const PORT = Number(process.env.PORT || process.argv[2] || 5220);
const BASE = 'http://127.0.0.1:' + PORT + '/';
const OUT = path.join(__dirname, '..', '.screens');
const BUDGET = '6000';

// 窄屏下三栏只显示一栏，用 hash 指定看哪一栏（app.js 认这个）
const shots = [
  { name: 'desktop', w: 1600, h: 1000, url: BASE },
  { name: 'desktop-1920', w: 1920, h: 1080, url: BASE },
  { name: 'tablet-notes', w: 900, h: 1000, url: BASE + '#pane=notes' },
  { name: 'tablet-read', w: 900, h: 1000, url: BASE + '#pane=read' },
  { name: 'phone-write', w: 390, h: 844, url: BASE + '#pane=write' },
];

function commonArgs(profile, extra) {
  return [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--user-data-dir=' + profile,
    '--virtual-time-budget=' + BUDGET,
  ].concat(extra);
}

function profileDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mdnotes-shot-'));
}

/** 本地服务活着吗？挂了就先自己起一个——后台任务会被回收，别让探针白跑一趟 */
function reachable(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function ensureServer() {
  if (await reachable(BASE)) return null;
  console.log('本地服务没在跑，先起一个（端口 ' + PORT + '）…');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), String(PORT)], {
    stdio: 'ignore',
  });
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    if (await reachable(BASE)) return child;
  }
  console.error('✗ 本地服务起不来，先手动 node server.js ' + PORT + ' 再跑。');
  process.exit(1);
  return child;
}

/** stdout 走文件重定向（不用管道），跑完把内容读回来 */
function run(args) {
  return new Promise((resolve) => {
    const sink = fs.openSync(path.join(profileDir(), 'stdout.txt'), 'w');
    const child = spawn(CHROME, args, { stdio: ['ignore', sink, 'inherit'] });
    child.on('error', (err) => {
      fs.closeSync(sink);
      console.error('起不了 Chrome：' + err.message);
      resolve({ code: 1, out: '' });
    });
    child.on('exit', (code) => {
      fs.closeSync(sink);
      resolve({ code: code === null ? 0 : code, out: '' });
    });
  });
}

function runCaptured(args, options) {
  return new Promise((resolve) => {
    const dir = profileDir();
    const sinkPath = path.join(dir, 'stdout.txt');
    const errPath = path.join(dir, 'stderr.txt');
    const sink = fs.openSync(sinkPath, 'w');
    const errSink = fs.openSync(errPath, 'w');
    const child = spawn(args[0], args.slice(1), {
      stdio: ['ignore', sink, options && options.captureStderr ? errSink : 'inherit'],
    });
    const finish = (code) => {
      try { fs.closeSync(sink); } catch { /* 已经关了 */ }
      try { fs.closeSync(errSink); } catch { /* 已经关了 */ }
      let out = '';
      let err = '';
      try { out = fs.readFileSync(sinkPath, 'utf8'); } catch { out = ''; }
      try { err = fs.readFileSync(errPath, 'utf8'); } catch { err = ''; }
      resolve({ code: code === null ? 0 : code, out: out, err: err });
    };
    child.on('error', (err) => {
      console.error('起不了进程：' + err.message);
      finish(1);
    });
    child.on('exit', (code) => finish(code));
  });
}

function unescapeHtml(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  if (!fs.existsSync(CHROME)) {
    console.error('找不到 Chrome，用 CHROME_PATH 指一个：' + CHROME);
    process.exit(1);
  }

  const ownServer = await ensureServer();
  try {
    await runAll();
  } finally {
    if (ownServer) {
      try { ownServer.kill(); } catch { /* 已经退了 */ }
    }
  }
}

async function runAll() {
  // PRINT_ONLY=1 只跑"导出 PDF 实测"这一段（改打印样式时用）
  if (process.env.PRINT_ONLY === '1') {
    await printCheck();
    return;
  }

  // PROBE_ONLY=1 时跳过截图（改完逻辑只想快速验一遍时用）
  if (process.env.PROBE_ONLY !== '1') {
    for (const s of shots) {
      const file = path.join(OUT, s.name + '.png');
      const res = await run(commonArgs(profileDir(), [
        '--window-size=' + s.w + ',' + s.h,
        '--screenshot=' + file,
        s.url,
      ]));
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      console.log((res.code === 0 && size > 0 ? '✓ ' : '✗ ') + s.name + ' (' + s.w + '×' + s.h + ') ' + size + ' B');
    }
  }

  const probe = await runCaptured([CHROME].concat(commonArgs(profileDir(), [
    '--window-size=1600,1000',
    '--dump-dom',
    BASE + 'scripts/layout-probe.html',
  ])));

  const report = extractJson(probe.out);
  if (!report) { process.exitCode = 1; return; }

  const jsonPath = path.join(OUT, 'layout-report.json');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');

  const c = report.columns || {};
  console.log('\n—— 版面数字 ' + '—'.repeat(30));
  console.log('视口        ' + report.viewport.w + '×' + report.viewport.h);
  if (c.rail) console.log('目录栏      ' + c.rail.w + ' px');
  if (c.source) console.log('稿纸栏      ' + c.source.w + ' px  (x=' + c.source.x + ')');
  if (c.proof) console.log('印张栏      ' + c.proof.w + ' px  (x=' + c.proof.x + ')');
  console.log('三栏之和    ' + c.sum + ' px');
  const k = report.content || {};
  console.log('笔记卡片    ' + k.cards + ' 张（选中 ' + k.activeCard + '）');
  console.log('印张块      ' + k.blocks + ' 个 · 代码卡 ' + k.codeblocks + ' · token ' + k.tokens +
    ' · 勾选框 ' + k.taskBoxes + ' · 表格 ' + k.tables);
  console.log('保存状态    ' + k.saveState + ' / ' + k.countState + ' / ' + k.storeInfo);
  if (report.style) {
    console.log('字体        Plex=' + report.style.plexLoaded + ' Newsreader=' + report.style.newsreaderLoaded +
      ' 状态=' + report.style.fontsStatus);
    console.log('印张字体    ' + report.style.previewFont + ' @ ' + report.style.previewSize + '/' + report.style.previewLine);
    console.log('底色        目录=' + report.style.railBg + ' 稿纸=' + report.style.sourceBg + ' 印张=' + report.style.proofBg);
    console.log('红笔        ' + report.style.accent + ' · 光标记号显示=' + report.style.tickOn);
  }
  const problems = report.problems || [];
  console.log('\n—— 版面问题 ' + problems.length + ' 个 ' + '—'.repeat(26));
  if (!problems.length) console.log('（没有发现问题）');
  problems.forEach((p, i) => console.log((i + 1) + '. ' + p));
  console.log('完整报告：' + path.relative(process.cwd(), jsonPath));

  /* 流程：真的去点、去打字，看结果对不对
     注意：这里跑**真实时钟**，不用 --virtual-time-budget——
     IndexedDB、平滑滚动、CSS 过渡在虚拟时钟下都不准，量出来的问题多半是假的。
     做法：探针把报告写进 localStorage，跑够时间后杀掉浏览器，
     再用第二个页面把它读出来。 */
  const flowProfile = profileDir();
  const flowMs = Number(process.env.PROBE_MS || 26000);
  console.log('\n跑流程探针（真实时钟 ' + Math.round(flowMs / 1000) + ' 秒）…');
  const child = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--user-data-dir=' + flowProfile,
    '--window-size=1440,900',
    BASE + 'scripts/flow-probe.html',
  ], { stdio: 'ignore', detached: false });

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退了 */ }
      setTimeout(resolve, 1200);
    }, flowMs);
    child.on('exit', () => { clearTimeout(timer); resolve(); });
    child.on('error', () => { clearTimeout(timer); resolve(); });
  });

  const flowRead = await runCaptured([CHROME,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-crash-reporter',
    '--user-data-dir=' + flowProfile,
    '--window-size=1440,900',
    '--virtual-time-budget=3000',
    '--dump-dom',
    BASE + 'scripts/read-report.html',
  ]);

  // 首选探针 POST 上来的报告（最可靠：探针被 kill 也不会丢）；读不到再退回 DOM/localStorage 那条路
  let flowReport = readReportJson('flow');
  if (!flowReport) flowReport = extractJson(flowRead.out);
  if (!flowReport || !flowReport.summary) {
    const rawPath = path.join(OUT, 'flow-dump.html');
    fs.writeFileSync(rawPath, flowRead.out || '', 'utf8');
    console.error('  ✗ 读不到流程报告（原始 dump：' + path.relative(process.cwd(), rawPath) +
      '，' + (flowRead.out || '').length + ' 字节）');
    process.exitCode = 1;
    return;
  }

  /* 边界用例：整篇被围栏包住、超长代码块这类"看着渲染了其实看不到"的情况 */
  const edgeProfile = profileDir();
  const edgeChild = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-crash-reporter', '--disable-breakpad', '--hide-scrollbars',
    '--user-data-dir=' + edgeProfile,
    '--window-size=1440,900',
    BASE + 'scripts/edge-probe.html',
  ], { stdio: 'ignore' });
  await new Promise((resolve) => {
    const timer = setTimeout(() => { try { edgeChild.kill(); } catch { /* 已退 */ } setTimeout(resolve, 1000); }, 22000);
    edgeChild.on('exit', () => { clearTimeout(timer); resolve(); });
    edgeChild.on('error', () => { clearTimeout(timer); resolve(); });
  });
  const edgeRead = await runCaptured([CHROME,
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-crash-reporter', '--user-data-dir=' + edgeProfile,
    '--window-size=1440,900', '--virtual-time-budget=3000', '--dump-dom',
    BASE + 'scripts/read-report.html?key=mdprobe:edge',
  ]);
  let edgeReport = readReportJson('edge');
  if (!edgeReport) edgeReport = extractJson(edgeRead.out);
  if (edgeReport && edgeReport.cases) {
    console.log('\n—— 边界用例 ' + '—'.repeat(30));
    edgeReport.cases.forEach((c) => {
      const flag = c.card && !c.card.visible ? ' ✗ 卡片不可见' : '';
      console.log('  ' + c.name + '：块 ' + c.blocks + ' · 正文 ' + c.textChars + ' 字 · 卡片 ' +
        (c.card ? c.card.h + 'px/' + c.card.lineCount + ' 行·色' + c.card.textColor : '无') + flag);
    });
    if (edgeReport.windowErrors && edgeReport.windowErrors.length) {
      console.log('  页面抛错：' + edgeReport.windowErrors.join(' | '));
    }
  } else {
    console.error('  ✗ 读不到边界用例报告');
    process.exitCode = 1;
  }

  const flowPath = path.join(OUT, 'flow-report.json');
  fs.writeFileSync(flowPath, JSON.stringify(flowReport, null, 2), 'utf8');

  const summary = flowReport.summary || {};
  console.log('\n—— 流程 ' + (summary.passed !== undefined
    ? summary.passed + '/' + summary.total + ' 通过' + (summary.failed ? '，' + summary.failed + ' 个失败' : '')
    : JSON.stringify(summary)) + ' ' + '—'.repeat(20));
  (flowReport.results || []).forEach((r) => {
    console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.step + (r.detail ? '   [' + r.detail + ']' : ''));
  });
  if (flowReport.windowErrors && flowReport.windowErrors.length) {
    console.log('  页面抛错：' + flowReport.windowErrors.join(' | '));
  }
  if (summary.crashed) console.log('  崩在：' + summary.crashed);
  if (summary.failed || summary.crashed) process.exitCode = 1;
  /* 导出 PDF：真的打一份出来，解开内容流看里面有没有字
     （PDF 里的中文是 CMap 编码的、搜不到，所以用 ASCII 标记词来判） */
  await printCheck();
}

async function printCheck() {
  /* 导出 PDF：走 CDP + 真实时钟，并且**点应用自己的「导出 PDF」按钮**
     （headless 里把 window.print 换掉，顺便记下打印那一刻的 document.title）。
     不用 --print-to-pdf：它在窄窗口下会打出空白页，是个会骗人的坑。 */
  const fenced = [
    '```md',
    '# 个人作品集网站 RPD',
    '## 核心功能',
    '1.首页:大标题+简介+头像',
    '2.关于我:详细介绍+技能列表',
    '3.项目展示:项目卡片列表，每个卡片包含项目名称、项目截图、简短描述、技术栈、项目链接',
    '## 设计要求',
    '- 简洁现代的设计风格',
    '- 深色主题',
    '```',
  ].join('\n');
  const cases = [
    { name: '960 宽（窄屏，编辑栏）', w: 960, h: 1000, title: '打印检查-窄屏' },
    { name: '1440 宽（宽屏，分栏）', w: 1440, h: 900, title: '打印检查-宽屏' },
  ];

  console.log('\n—— 导出 PDF 实测（走应用自己的导出按钮）' + ' ' + '—'.repeat(12));
  for (const item of cases) {
    const res = await runCaptured([
      process.execPath,
      path.join(__dirname, 'cdp-print.js'),
      String(item.w),
      String(item.h),
      '--body=' + b64(fenced),
      '--title=' + b64(item.title),
    ], { captureStderr: true });

    let info = null;
    const line = (res.out || '').trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
    try { info = JSON.parse(line); } catch { info = null; }

    if (!info) {
      console.log('  ✗ ' + item.name + '：拿不到结果');
      if (res.err) console.log('     ' + res.err.trim().split('\n').slice(-3).join(' | '));
      process.exitCode = 1;
      continue;
    }
    const titleOk = info.printTitle === item.title;
    const contentOk = info.chars >= 20;
    console.log('  ' + (contentOk && titleOk ? '✓' : '✗') + ' ' + item.name +
      '：印出 ' + info.chars + ' 字 · ' + info.pages + ' 段' +
      ' · 打印时标题=「' + info.printTitle + '」' + (titleOk ? '（文件名对）' : '（✗ 文件名不对）') +
      ' · 打印时栏位=' + info.paneAtPrint);
    console.log('      抽样：' + info.sample.slice(0, 60));
    if (!contentOk || !titleOk) process.exitCode = 1;
  }

  /* 被嵌在别的页面里打开时：打印的是外层文档，文件名取的是外层标题。
     修好之后外层标题会被换成笔记标题——这一条专门盯着它，别退回去。 */
  const framed = await runCaptured([
    process.execPath,
    path.join(__dirname, 'cdp-print.js'),
    '1440', '900', '--frame',
  ], { captureStderr: true });
  let frameInfo = null;
  try {
    frameInfo = JSON.parse((framed.out || '').trim());
  } catch { frameInfo = null; }
  if (!frameInfo) {
    console.log('  ✗ 嵌套打开：拿不到结果');
    process.exitCode = 1;
  } else {
    const innerTitle = frameInfo.inner && frameInfo.inner.innerTitle;
    const ok = Boolean(innerTitle) && frameInfo.browserTitle === innerTitle && frameInfo.inner.innerPrinted;
    console.log('  ' + (ok ? '✓' : '✗') + ' 嵌在别的页面里打开：外层标题=' +
      '「' + frameInfo.browserTitle + '」· 应用内标题=「' + innerTitle + '」' +
      (ok ? '（文件名对上）' : '（✗ 文件名会不对）'));
    if (!ok) process.exitCode = 1;
  }
  console.log('  PDF 存 .screens/ 里，可以直接打开看。');
}

/** UTF-8 文本 → base64（塞进 URL 用，免得正文里的换行引号反引号出问题） */
function b64(text) {
  return Buffer.from(String(text), 'utf8').toString('base64');
}

/** 读探针 POST 上来的报告（server.js 写进 .screens/<名字>.json） */
function readReportJson(name) {
  const file = path.join(OUT, name + '.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 从 --dump-dom 的输出里抠出报告节点的 JSON（取最后一个匹配，免得撞上注释里的字样） */
function extractJson(dom) {
  const all = String(dom || '').match(/<pre id="out">([\s\S]*?)<\/pre>/g) || [];
  const last = all[all.length - 1];
  if (!last) {
    console.error('✗ 探针没有输出（页面可能没起来，或被 dump 截断了）');
    return null;
  }
  const body = last.replace(/^<pre id="out">/, '').replace(/<\/pre>$/, '');
  try {
    return JSON.parse(unescapeHtml(body));
  } catch (err) {
    console.error('✗ 探针输出不是合法 JSON：' + err.message);
    console.error(body.slice(0, 400));
    return null;
  }
}

main();
