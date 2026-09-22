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

function runCaptured(args) {
  return new Promise((resolve) => {
    const dir = profileDir();
    const sinkPath = path.join(dir, 'stdout.txt');
    const sink = fs.openSync(sinkPath, 'w');
    const child = spawn(CHROME, args, { stdio: ['ignore', sink, 'inherit'] });
    const finish = (code) => {
      try { fs.closeSync(sink); } catch { /* 已经关了 */ }
      let out = '';
      try { out = fs.readFileSync(sinkPath, 'utf8'); } catch { out = ''; }
      resolve({ code: code === null ? 0 : code, out: out });
    };
    child.on('error', (err) => {
      console.error('起不了 Chrome：' + err.message);
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

  const probe = await runCaptured(commonArgs(profileDir(), [
    '--window-size=1600,1000',
    '--dump-dom',
    BASE + 'scripts/layout-probe.html',
  ]));

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

  /* 流程：真的去点、去打字，看结果对不对 */
  const flow = await runCaptured(commonArgs(profileDir(), [
    '--window-size=1440,900',
    '--virtual-time-budget=30000',
    '--dump-dom',
    BASE + 'scripts/flow-probe.html',
  ]));

  const flowReport = extractJson(flow.out);
  if (!flowReport) { process.exitCode = 1; return; }

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
  if (summary.failed || summary.crashed) process.exitCode = 1;
  console.log('完整报告：' + path.relative(process.cwd(), flowPath));
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
