'use strict';

/**
 * 开发用：用 CDP 在**真实时钟**下打印一份 PDF，并把里面的字抽出来看。
 *
 *   node scripts/cdp-print.js [宽] [高] [--body=<base64>] [--title=标题]
 *
 * 为什么不直接用 --print-to-pdf：
 *   它在窄窗口下配合 --virtual-time-budget 会把整页印成空白（headless 的坑），
 *   害我追了半天的"假 bug"。CDP 走的是真实时钟，和真人点"另存为 PDF"一致。
 * 顺带还能问浏览器：打印的那一刻 document.title 是什么（也就是 PDF 的默认文件名）。
 * Node 22 自带 WebSocket，所以不需要任何依赖。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { extractText } = require('./pdf-text.js');

const CHROME = process.env.CHROME_PATH ||
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe');
const PORT = Number(process.env.PORT || 5220);
const BASE = 'http://127.0.0.1:' + PORT + '/';

const args = process.argv.slice(2);
const WIDTH = Number(args[0] || 1440);
const HEIGHT = Number(args[1] || 900);
const bodyArg = args.find((a) => a.indexOf('--body=') === 0);
const titleArg = args.find((a) => a.indexOf('--title=') === 0);
const BODY = bodyArg ? Buffer.from(bodyArg.slice(7), 'base64').toString('utf8') : null;
const TITLE = titleArg ? Buffer.from(titleArg.slice(8), 'base64').toString('utf8') : '打印检查';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function reachable(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function main() {
  if (!(await reachable(BASE))) {
    console.error('先起服务：node server.js ' + PORT);
    process.exit(1);
  }

  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'mdcdp-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-crash-reporter', '--user-data-dir=' + prof,
    '--remote-debugging-port=0', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('等不到 DevTools 地址')), 15000);
    chrome.stderr.on('data', (chunk) => {
      buf += chunk.toString();
      const m = /ws:\/\/[^\s]+/.exec(buf);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    });
    chrome.on('exit', () => { clearTimeout(timer); reject(new Error('Chrome 退出了')); });
  });

  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const pageErrors = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params && msg.params.exceptionDetails;
      pageErrors.push((d && ((d.exception && d.exception.description) || d.text)) || '未知异常');
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params && msg.params.type === 'error') {
      pageErrors.push('console.error: ' + (msg.params.args || [])
        .map((a) => a.value || a.description || '').join(' '));
    }
    if (msg.id && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('WebSocket 连不上')));
  });

  function send(method, params, sessionId) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
    });
  }

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
  }, sessionId);

  // 先把要打印的笔记写进 localStorage（同一台浏览器里的同一份 origin，不用等落盘）
  await send('Page.navigate', { url: BASE }, sessionId);
  await wait(1200);
  if (BODY !== null) {
    const seed = `(() => {
      const now = Date.now();
      localStorage.setItem('markdown-notes/v1', JSON.stringify({
        v: 1, activeId: 'probe-1',
        notes: [{ id: 'probe-1', title: ${JSON.stringify(TITLE)}, body: ${JSON.stringify(BODY)}, createdAt: now, updatedAt: now }],
      }));
      return localStorage.getItem('markdown-notes/v1') ? 'ok' : 'empty';
    })()`;

    // 播种要确认真的种进去了：写完立刻跳转时，这次写入有可能没提交，
    // 页面还是老的默认笔记——不确认的话，后面所有结论都是错的（踩过）。
    let seeded = false;
    for (let attempt = 1; attempt <= 3 && !seeded; attempt += 1) {
      await send('Runtime.evaluate', { expression: seed, returnByValue: true }, sessionId);
      await wait(300);
      await send('Page.navigate', { url: BASE }, sessionId);
      await wait(1800);
      const check = await send('Runtime.evaluate', {
        expression: "(() => { try { const s = JSON.parse(localStorage.getItem('markdown-notes/v1') || '{}'); return String(s.activeId === 'probe-1' && (s.notes || []).length === 1); } catch (e) { return 'err'; } })()",
        returnByValue: true,
      }, sessionId);
      seeded = check.result.value === 'true';
      if (!seeded) await wait(800);
    }
    if (!seeded) {
      console.error('播种没成功（写了 localStorage 但跳转后读不到），这一轮结果不可信');
      process.exit(1);
    }
  }

  const titleNow = await send('Runtime.evaluate', {
    expression: 'document.title', returnByValue: true,
  }, sessionId);

  // 走应用自己的导出路径：点「导出 PDF」按钮。
  // 把 window.print 换掉（headless 里没有打印对话框），顺便记下"打印那一刻的
  // document.title"——那正是浏览器给 PDF 的默认文件名。
  // --frame：把应用嵌进一个没有标题的外层页面，验证"嵌在别的页面里打印"这个坑
  if (args.indexOf('--frame') >= 0) {
    await send('Page.navigate', { url: BASE + 'scripts/print-frame.html' }, sessionId);
    await wait(1500);

    // 等 iframe 里的应用初始化完（它画完首屏会打上 data-ready），否则点是空按钮
    let innerReady = false;
    for (let i = 0; i < 60 && !innerReady; i += 1) {
      const probe = await send('Runtime.evaluate', {
        expression: `(() => {
          const f = document.getElementById('frame');
          if (!f || !f.contentWindow || !f.contentDocument) return 'no-frame';
          const d = f.contentDocument;
          return String(d.documentElement.dataset.ready === 'true' && d.querySelectorAll('.card').length > 0);
        })()`,
        returnByValue: true,
      }, sessionId);
      innerReady = probe.result.value === 'true';
      if (!innerReady) await wait(250);
    }
    if (!innerReady) console.error('警告：iframe 里的应用没在 15 秒内就绪');

    const inner = await send('Runtime.evaluate', {
      expression: 'window.exportInsideFrame()', returnByValue: true,
    }, sessionId);
    await wait(1200);
    const info = await send('Target.getTargetInfo', { targetId }, undefined);
    const inside = await send('Runtime.evaluate', {
      expression: `(() => {
        const w = document.getElementById('frame').contentWindow;
        const btn = w.document.getElementById('exportPdf');
        return JSON.stringify({
          innerTitle: w.document.title,
          innerPrinted: Boolean(w.__printed),
          topTitle: document.title,
          btnExists: Boolean(btn),
          btnDisabled: btn ? btn.disabled : null,
          cards: w.document.querySelectorAll('.card').length,
          ready: w.document.documentElement.dataset.ready,
          nested: w.top !== w.self,
          toasts: Array.prototype.map.call(w.document.querySelectorAll('.toast'), (t) => t.textContent),
        });
      })()`,
      returnByValue: true,
    }, sessionId);
    const detail = JSON.parse(inside.result.value);
    console.log(JSON.stringify({
      mode: 'frame',
      browserTitle: info.targetInfo ? info.targetInfo.title : '',
      exportedInnerTitle: inner.result.value,
      inner: detail,
    }, null, 1));
    ws.close();
    try { chrome.kill(); } catch { /* 已经退了 */ }
    return;
  }


  // 点导出之前必须等应用真的初始化完（它画完首屏会打上 data-ready）——
  // 早一点点，导出逻辑会因为"还没有打开的笔记"直接返回，量出来就是假故障。
  for (let i = 0; i < 40; i += 1) {
    const ready = await send('Runtime.evaluate', {
      expression: "document.documentElement.dataset.ready === 'true'",
      returnByValue: true,
    }, sessionId);
    if (ready.result.value === true) break;
    await wait(250);
  }

  const clickExport = `(() => {
    const before = document.title;
    window.__printTitle = null;
    window.__printCalls = 0;
    window.print = function () {
      window.__printTitle = document.title;
      window.__printCalls += 1;
    };
    const btn = document.getElementById('exportPdf');
    if (!btn) return 'no-button';
    btn.click();
    return 'clicked';
  })()`;
  const clicked = await send('Runtime.evaluate', { expression: clickExport, returnByValue: true }, sessionId);
  await wait(1500);
  const after = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      printTitle: window.__printTitle,
      printCalls: window.__printCalls,
      title: document.title,
      pane: document.querySelector('.app').dataset.pane,
      cards: document.querySelectorAll('.card').length,
      noteTitleField: (document.getElementById('title') || {}).value || '',
      toasts: document.querySelectorAll('.toast').length,
      ready: document.documentElement.dataset.ready,
      editorChars: (document.getElementById('editor') || {}).value ? document.getElementById('editor').value.length : 0,
      topLevel: window.top === window.self,
    })`,
    returnByValue: true,
  }, sessionId);
  const state = JSON.parse(after.result.value);

  const boot = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      readyState: document.readyState,
      hasStore: typeof window.MDStore,
      hasMarkdown: typeof window.MDMarkdown,
      hasImages: typeof window.MDImages,
      railVar: getComputedStyle(document.documentElement).getPropertyValue('--rail').trim(),
      notesRaw: (localStorage.getItem('markdown-notes/v1') || '').slice(0, 80),
      cardCount: document.querySelectorAll('.card').length,
      railEmpty: Boolean(document.querySelector('.rail__empty')),
      scriptTags: Array.prototype.map.call(document.scripts, (s) => s.src.split('/').pop()).join(','),
    })`,
    returnByValue: true,
  }, sessionId);
  const bootInfo = JSON.parse(boot.result.value);

  // 只读 document.title 是渲染进程的视角，可能还没同步过去
  const targetInfo = await send('Target.getTargetInfo', { targetId }, undefined);
  const browserTitle = targetInfo.targetInfo ? targetInfo.targetInfo.title : '(拿不到)';

  // --layout：切到打印媒体，把关键元素的几何与计算样式倒出来（查"打印空白"用）
  if (args.indexOf('--layout') >= 0) {
    await send('Emulation.setEmulatedMedia', { media: 'print' }, sessionId);
    await wait(500);
    const probe = `(() => {
      const pick = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return { display: cs.display, overflow: cs.overflow, whiteSpace: cs.whiteSpace,
          h: Math.round(r.height), w: Math.round(r.width), y: Math.round(r.y),
          chars: (el.innerText || '').replace(/\\s/g, '').length };
      };
      return JSON.stringify({
        page: pick('.page'), body: pick('#preview'),
        card: pick('.md-codeblock'), pre: pick('.md-codeblock__pre'),
        scroll: pick('.proof__scroll'), proof: pick('.proof'),
      });
    })()`;
    const out = await send('Runtime.evaluate', { expression: probe, returnByValue: true }, sessionId);
    console.error('打印媒体下的布局：' + out.result.value);
  }

  const pdf = await send('Page.printToPDF', {
    printBackground: true,
    paperWidth: 8.27,
    paperHeight: 11.69,
    marginTop: 0.63,
    marginBottom: 0.63,
    marginLeft: 0.55,
    marginRight: 0.55,
    preferCSSPageSize: true,
  }, sessionId);

  const outDir = path.join(__dirname, '..', '.screens');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'cdp-print-' + WIDTH + '.pdf');
  fs.writeFileSync(file, Buffer.from(pdf.data, 'base64'));

  const text = extractText(fs.readFileSync(file));
  const chars = text.pages.join('').replace(/\s/g, '').length;
  const sample = text.pages.map((p) => p.replace(/\s+/g, ' ')).join(' ').trim().slice(0, 70);

  console.log(JSON.stringify({
    width: WIDTH,
    height: HEIGHT,
    pages: text.pages.length,
    chars: chars,
    ok: chars >= 20,
    clicked: clicked.result.value,
    printCalls: state.printCalls,
    printTitle: state.printTitle,
    documentTitle: state.title,
    browserTitle: browserTitle,
    topLevel: state.topLevel,
    paneAtPrint: state.pane,
    cards: state.cards,
    noteTitleField: state.noteTitleField,
    editorChars: state.editorChars,
    toasts: state.toasts,
    ready: state.ready,
    pageErrors: pageErrors.slice(0, 4),
    boot: bootInfo,
    file: path.relative(process.cwd(), file),
    sample: sample,
  }));

  ws.close();
  try { chrome.kill(); } catch { /* 已经退了 */ }
}

main().catch((err) => {
  console.error('失败：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
