/**
 * 冒烟测试 · 零依赖
 *
 * 六组检查，A~C 走真实 HTTP，D~F 用无头 Chrome 走真实浏览器（没装就跳过）：
 *   A. 静态资源      —— 每个文件都返回 200，MIME 正确，路径穿越与 /data/ 被挡住
 *   B. 页面内容      —— 锚点、资源、无障碍、多语言挂载点、真实个人信息
 *   C. 样式与脚本    —— 括号配平、脚本可解析、断点与焦点样式齐全
 *   D. 真实渲染      —— 卡片、缩略图、入场动画、头像扫描
 *   E. 头像上传      —— 在浏览器里真的传一张图，断言落到 localStorage
 *   F. 多语言 / 统计 / 留言板 —— 真的点语言开关、真的发一条留言、读真实统计；
 *                       并回归"切语言之后项目和联系区不能变空白"
 *
 * 数据写在临时目录里（DSH_PORTFOLIO_DATA），绝不碰真实的访问记录与留言。
 *
 *   node scripts/smoke-test.js
 *   SMOKE_DEBUG=1 node scripts/smoke-test.js          # 保留 Chrome 日志、打印诊断
 *   PORTFOLIO_DUMP=<目录> node scripts/smoke-test.js  # 把每组的渲染 DOM 留下来
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

// 关键：在 require server.js 之前把数据目录指到临时位置，
// 否则跑一次测试就会往真实统计里塞访问量。
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-smoke-data-'));
process.env.DSH_PORTFOLIO_DATA = TMP_DATA;
process.env.TRUST_PROXY = '1';   // 允许用 X-Forwarded-For 模拟不同访客

const { createServer } = require(path.join(ROOT, 'server.js'));

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, extra = '') {
  pass++;
  console.log(`  \u001b[32m✓\u001b[0m ${name}${extra ? ' \u001b[90m' + extra + '\u001b[0m' : ''}`);
}
function bad(name, detail) {
  fail++;
  failures.push(name + (detail ? ' — ' + detail : ''));
  console.log(`  \u001b[31m✗\u001b[0m ${name}${detail ? ' \u001b[90m' + detail + '\u001b[0m' : ''}`);
}
function check(cond, name, detail) {
  cond ? ok(name, detail) : bad(name, detail);
}
function group(title) {
  console.log(`\n\u001b[1m${title}\u001b[0m`);
}

async function get(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      );
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
  });
}

/* ---------- 找本机 Chrome / Edge ---------- */
async function findChrome() {
  const { existsSync } = fs;
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/* ---------- 无头浏览器 ----------
   不能用管道读 Chrome 的 stdout（受限环境里管道直接 EPERM），
   所以让它把 DOM 和日志写进文件，我们再读文件。
   受限沙箱里 Chrome 起不来会连串报错，因此准备了几组启动参数，
   哪组先真的产出 DOM 就用哪组。 */
const BASE_FLAGS = [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--hide-scrollbars',
  '--virtual-time-budget=3000',
  '--window-size=1440,2400',
];

const FLAG_SETS = [
  ['--no-sandbox', '--disable-dev-shm-usage', '--disable-crash-reporter', '--disable-breakpad'],
  ['--no-sandbox', '--disable-dev-shm-usage', '--disable-features=NetworkServiceSandbox',
    '--disable-crash-reporter', '--disable-breakpad'],
  ['--no-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote',
    '--disable-crash-reporter', '--disable-breakpad'],
];

/* 浏览器里跑一遍的探针：切语言 + 发留言 + 读统计。
   内容放在 scripts/smoke-probe.js（写成一行字符串太容易出错）。 */
const PROBE_SRC = fs.readFileSync(path.join(__dirname, 'smoke-probe.js'), 'utf8');

/* 头像上传的探针：造一张 PNG 塞进 <input type=file>，触发 change */
const UPLOAD_PROBE =
  '(function(){window.addEventListener("load",function(){setTimeout(function(){' +
  'var out=function(o){document.title="UP::"+encodeURIComponent(JSON.stringify(o))};' +
  'try{' +
  'var d=document.querySelector("[data-portrait-photo]");' +
  'var probe={defSrc:d.getAttribute("src"),defNaturalW:d.naturalWidth,defNaturalH:d.naturalHeight};' +
  'var c=document.createElement("canvas");c.width=40;c.height=40;' +
  'var g=c.getContext("2d");g.fillStyle="#c0392b";g.fillRect(0,0,40,40);' +
  'g.fillStyle="#f1c40f";g.fillRect(10,10,20,20);' +
  'c.toBlob(function(blob){' +
  'var file=new File([blob],"t.png",{type:"image/png"});' +
  'var dt=new DataTransfer();dt.items.add(file);' +
  'var input=document.querySelector("[data-photo-input]");' +
  'input.files=dt.files;' +
  'input.dispatchEvent(new Event("change",{bubbles:true}));' +
  'setTimeout(function(){' +
  'var img=document.querySelector("[data-portrait-photo]");' +
  'var hint=document.querySelector("[data-photo-hint]");' +
  'var reset=document.querySelector("[data-photo-reset]");' +
  'var stored=null;try{stored=localStorage.getItem("portfolio.photo")}catch(e){stored="ERR:"+e.name}' +
  'out({defSrc:probe.defSrc,defNaturalW:probe.defNaturalW,defNaturalH:probe.defNaturalH,' +
  'custom:img.getAttribute("data-custom"),' +
  'srcIsData:img.getAttribute("src").indexOf("data:image/")===0,' +
  'srcLen:img.getAttribute("src").length,' +
  'hint:hint.textContent,hintKind:hint.getAttribute("data-kind"),' +
  'resetHidden:reset?reset.hidden:null,' +
  'storedKind:stored?(stored.indexOf("ERR:")===0?stored:(stored.indexOf("data:image/")===0?"dataUrl("+stored.length+")":"other")):"null"' +
  '});' +
  '},900);' +
  '},"image/png");' +
  '}catch(e){out({fatal:String(e)})}' +
  '},700)})})()';

function attempt(bin, port, extraFlags, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const outDir = o.outDir || fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-smoke-'));
    const outFile = path.join(outDir, 'dom.html');
    const errFile = path.join(outDir, 'chrome.log');
    const args = [
      ...BASE_FLAGS,
      ...extraFlags,
      `--user-data-dir=${path.join(outDir, 'profile')}`,
      `--crash-dumps-dir=${path.join(outDir, 'crash')}`,
      ...(o.waitMs ? [`--virtual-time-budget=${o.waitMs}`] : []),
      '--dump-dom',
      `http://127.0.0.1:${port}${o.path || '/'}`,
    ];

    let child;
    try {
      const out = fs.openSync(outFile, 'w');
      const err = fs.openSync(errFile, 'w');
      child = spawn(bin, args, { stdio: ['ignore', out, err] });
      fs.closeSync(out);
      fs.closeSync(err);
    } catch (e) {
      return reject(e);
    }

    const finish = (err) => {
      let dom = '';
      let log = '';
      try { dom = fs.readFileSync(outFile, 'utf8'); } catch { /* 没写出来 */ }
      try { log = fs.readFileSync(errFile, 'utf8'); } catch { /* 没写出来 */ }

      // 调试用：把每个分组的 DOM 留下来
      if (dom && process.env.PORTFOLIO_DUMP) {
        const tag = o.dumpTag || 'D';
        const p = process.env.PORTFOLIO_DUMP;
        let isFile = false;
        try { isFile = fs.existsSync(p) && fs.statSync(p).isFile(); } catch { /* 忽略 */ }
        if (/\.html?$/i.test(p)) isFile = true;
        const target = isFile ? p.replace(/(\.html?)$/i, '-' + tag + '$1')
          : path.join(p, 'dom-' + tag + '.html');
        try {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, dom);
          console.log('  \u001b[90mDOM 已写出[' + tag + ']: ' + target + '\u001b[0m');
        } catch (e) {
          console.log('  \u001b[31mDOM 写出失败[' + tag + ']: ' + e.message + '\u001b[0m');
        }
      }

      // 调试模式下先别删，失败时还能翻 Chrome 的日志
      if (!process.env.SMOKE_DEBUG) {
        try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ }
      }

      if (dom) return resolve(dom);            // 有 DOM 就算成功，退出码不管
      if (err) {
        const hint = log.split('\n').filter(Boolean).slice(-1)[0];
        return reject(new Error(hint ? hint.slice(0, 200) : err.message));
      }
      reject(new Error('Chrome 没有输出 DOM'));
    };

    child.on('error', finish);
    child.on('close', (code) =>
      finish(code === 0 ? null : new Error(`Chrome 退出码 ${code}`))
    );

    setTimeout(() => {
      try { child.kill(); } catch { /* 已经退出 */ }
    }, 40000);
  });
}

async function runChrome(bin, port, opts) {
  let lastErr;
  for (const flags of FLAG_SETS) {
    try {
      return await attempt(bin, port, flags, opts);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('无法启动无头浏览器');
}

/* 从倒出来的 DOM 里读探针结果
   （<title> 上挂了 data-i18n，所以匹配时不能写死成 "<title>"） */
function readTitle(dom, prefix) {
  const m = dom.match(/<title[^>]*>([\s\S]*?)<\/title>/);
  if (!m) return null;
  const raw = m[1].trim();
  if (raw.indexOf(prefix) !== 0) return null;
  try {
    return JSON.parse(decodeURIComponent(raw.slice(prefix.length)));
  } catch {
    return null;
  }
}

/** 把站点复制到临时目录并注入一段脚本 */
function stageSite(injectScript, tagPrefix) {
  const dir = fs.mkdtempSync(path.join(ROOT, tagPrefix));
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  fs.writeFileSync(path.join(dir, 'index.html'),
    html.replace('</head>', '<script>' + injectScript + '<\/script></head>'));
  for (const f of ['styles.css', 'main.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  }
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'assets'))) {
    const src = path.join(ROOT, 'assets', f);
    if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(dir, 'assets', f));
  }
  return dir;
}

/** 临时站点的静态服务器；apiPort 给了就把 /api/ 转发到真正的服务端 */
function stageServer(dir, apiPort) {
  return http.createServer((req, res) => {
    if (apiPort && req.url.indexOf('/api/') === 0) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const up = http.request({
          host: '127.0.0.1', port: apiPort, path: req.url, method: req.method,
          headers: { 'Content-Type': 'application/json' },
        }, (r) => {
          res.writeHead(r.statusCode, { 'Content-Type': r.headers['content-type'] || 'application/json' });
          r.pipe(res);
        });
        up.on('error', (e) => { res.writeHead(502); res.end(JSON.stringify({ error: String(e) })); });
        if (req.method === 'POST') up.end(Buffer.concat(chunks)); else up.end();
      });
      return;
    }
    let p = req.url.split('?')[0];
    if (p === '/') p = '/index.html';
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    let body;
    try {
      body = fs.readFileSync(path.join(dir, decodeURIComponent(p)));
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }
    const ext = path.extname(p);
    const type = ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript'
      : ext === '.svg' ? 'image/svg+xml' : ext === '.jpg' ? 'image/jpeg' : 'text/html';
    res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
    res.end(body);
  });
}

(async function main() {
  console.log('个人作品集 · 冒烟测试');
  console.log('\u001b[90m源目录: ' + ROOT + '\u001b[0m');
  if (process.env.SMOKE_DEBUG) console.log('\u001b[90m临时数据目录: ' + TMP_DATA + '\u001b[0m');

  const port = 5300 + Math.floor(Math.random() * 200);
  const server = createServer();
  await new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(port, '127.0.0.1', res);
  });

  try {
    /* ---------- A. 静态资源 ---------- */
    group('A. 静态资源');

    const assets = [
      ['/', 'text/html'],
      ['/index.html', 'text/html'],
      ['/styles.css', 'text/css'],
      ['/main.js', 'text/javascript'],
      ['/assets/avatar.jpg', 'image/jpeg'],
      ['/assets/avatar-line-art.svg', 'image/svg+xml'],
    ];
    for (const [p, type] of assets) {
      const r = await get(port, p);
      check(r.status === 200, `GET ${p} → 200`, `实际 ${r.status}`);
      check((r.headers['content-type'] || '').includes(type), `${p} MIME 是 ${type}`,
        r.headers['content-type']);
      check(r.body.length > 0, `${p} 不是空响应`, `${r.body.length} 字节`);
    }

    const traversal = await get(port, '/../package.json');
    check(traversal.status === 403 || traversal.status === 404,
      '目录穿越被挡住（不能读到上级目录）', `实际 ${traversal.status}`);

    const missing = await get(port, '/does-not-exist.js');
    check(missing.status === 404, '不存在的路径 → 404', `实际 ${missing.status}`);

    // 运行时数据（留言 ipHash、管理员令牌、哈希盐）绝不对外
    const dataStore = await get(port, '/data/store.json');
    check(dataStore.status === 403, 'GET /data/store.json → 403', `实际 ${dataStore.status}`);
    const dataToken = await get(port, '/data/admin-token');
    check(dataToken.status === 403, 'GET /data/admin-token → 403', `实际 ${dataToken.status}`);

    const post = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'POST' },
        (res) => { res.resume(); resolve(res.statusCode); });
      req.end();
    });
    check(post === 405, 'POST 到静态路径 → 405', `实际 ${post}`);

    /* ---------- B. 页面内容 ---------- */
    group('B. 页面结构');

    const page = (await get(port, '/')).body;
    const css = (await get(port, '/styles.css')).body;
    const js = (await get(port, '/main.js')).body;

    check(/<html[^>]+lang="zh-CN"/.test(page), 'html 声明了 lang="zh-CN"');
    check(/name="viewport"[^>]+width=device-width/.test(page), '有移动端 viewport');
    check(/<title[^>]*>[^<]+<\/title>/.test(page), '有 title',
      (page.match(/<title[^>]*>([^<]*)<\/title>/) || [])[1]);

    for (const id of ['top', 'about', 'work', 'guestbook', 'contact']) {
      check(page.includes(`id="${id}"`), `存在锚点 #${id}`);
    }
    for (const sec of ['hero', 'about', 'work', 'guestbook', 'contact']) {
      check(page.includes(`data-section="${sec}"`), `区块 ${sec} 已标记`);
    }
    check((page.match(/data-reveal/g) || []).length >= 10, '滚动揭示的挂载点足够多',
      (page.match(/data-reveal/g) || []).length + ' 处');
    check(page.includes('data-cards'), '项目卡片容器存在');
    check(page.includes('data-links'), '联系方式容器存在');
    check((page.match(/data-theme-toggle/g) || []).length >= 2, '桌面 / 移动各有一个主题开关');
    check(page.includes('data-portrait'), '头像扫描区存在');
    check(/<h1[^>]*>[^<]+<\/h1>/.test(page), 'h1 首页大标题存在');

    // 三个新功能的挂载点
    check((page.match(/data-lang-toggle/g) || []).length === 2, '桌面 / 移动各有一个语言开关');
    check(page.includes('data-gb-form') && page.includes('data-gb-list'), '留言板表单与列表挂载点存在');
    check(page.includes('data-stats-trend'), '访问统计（含 14 天折线）挂载点存在');
    check(/data-gb[^>]*hidden|hidden[^>]*data-gb/.test(page), '留言板默认隐藏（等后端确认后才显示）');
    check(/data-stats[^>]*hidden|hidden[^>]*data-stats/.test(page), '统计默认隐藏（拿不到数据就不编造）');
    check(page.includes('data-gb-website'), '留言表单带蜜罐字段');

    // 所有 data-i18n 的键都必须在 main.js 里有中文与英文两条
    const keys = [...new Set([...page.matchAll(/data-i18n(?:-attr|-placeholder|-aria)?="([^"]+)"/g)]
      .map((m) => m[1].split(':').pop().trim()))];
    const zhBlock = js.slice(js.indexOf('zh: {'), js.indexOf('en: {'));
    const enBlock = js.slice(js.indexOf('en: {'));
    const missingZh = keys.filter((k) => zhBlock.indexOf("'" + k + "'") === -1);
    const missingEn = keys.filter((k) => enBlock.indexOf("'" + k + "'") === -1);
    check(missingZh.length === 0, `页面里 ${keys.length} 个 i18n 键都有中文`, missingZh.join(',') || 'ok');
    check(missingEn.length === 0, `页面里 ${keys.length} 个 i18n 键都有英文`, missingEn.join(',') || 'ok');

    // 标题层级：不能跳级
    const levels = (page.match(/<h([1-3])[\s>]/g) || []).map((s) => Number(s.match(/[1-3]/)[0]));
    const jumps = levels.filter((lv, i) => i > 0 && lv > levels[i - 1] + 1);
    check(jumps.length === 0, '标题层级没有跳级', `h${levels.join(',h')}`);

    // 内链必须都存在
    const hrefs = [...page.matchAll(/href="(#[^"]+)"/g)].map((m) => m[1]);
    const dangling = hrefs.filter((h) => h !== '#' && !page.includes(`id="${h.slice(1)}"`));
    check(dangling.length === 0, `页面内 ${hrefs.length} 个锚点链接都能落地`, dangling.join(',') || 'ok');

    // 外链安全
    const blanks = [...page.matchAll(/<a[^>]+target="_blank"[^>]*>/g)].map((m) => m[0]);
    const unsafe = blanks.filter((t) => !/rel="[^"]*noopener/.test(t));
    check(unsafe.length === 0, '外部链接都带 rel="noopener"', blanks.length + ' 个 target=_blank');

    check(!/TODO|FIXME|XXX|Lorem/i.test(page), '页面里没有留下占位符');
    check(page.includes('href="./styles.css"'), 'index.html 引用了 styles.css');
    check(page.includes('src="./main.js"'), 'index.html 引用了 main.js');
    check(page.includes('src="./assets/avatar.jpg"'), 'index.html 引用了默认头像照片');
    check(page.includes("src='./assets/avatar-line-art.svg'"), '照片缺失时有线描兜底图');

    /* ---------- C. 样式与脚本 ---------- */
    group('C. 样式与脚本');

    const braces = (s) => (s.match(/{/g) || []).length - (s.match(/}/g) || []).length;
    check(braces(css) === 0, 'styles.css 花括号配平', '差值 ' + braces(css));

    const tokens = (css.match(/--[a-z0-9-]+:/g) || []).length;
    check(tokens >= 20, '设计令牌数量正常', tokens + ' 个');
    check(css.includes('prefers-reduced-motion'), '样式里处理了"减少动效"偏好');
    check((page + js).includes('prefers-color-scheme'), '页面/脚本里处理了系统主题偏好');
    check(css.includes('@media (min-width: 1180px)'), '有桌面断点');
    check(/@media \(min-width:\s*7\d\dpx\)/.test(css), '有平板断点');
    check(css.includes(':focus-visible'), '键盘焦点样式存在');

    const fixedWide = [...css.matchAll(/(?<!max-)(?<!min-)\bwidth:\s*(\d{4,})px/g)].map((m) => m[1]);
    check(fixedWide.length === 0, '没有写死的超宽容器', fixedWide.join(',') || 'ok');
    check(/clamp\(|min\(|max\(/.test(css), '尺寸用了 clamp / min / max 做流体适配');

    const jb = (js.match(/{/g) || []).length - (js.match(/}/g) || []).length;
    check(jb === 0, 'main.js 花括号配平', '差值 ' + jb);
    check(js.includes("'use strict'"), 'main.js 使用严格模式');
    check(!/console\.log/.test(js), 'main.js 没有遗留调试输出');
    check(js.includes('IntersectionObserver'), '滚动揭示用 IntersectionObserver');
    check(js.includes('prefers-reduced-motion'), '脚本里也尊重"减少动效"偏好');
    check(js.includes('data-fb'), '截图缺失时有 SVG 回落');
    check(!/__langTrace|__updateStatsText|__gbTrace/.test(js), 'main.js 里没有遗留调试脚手架');

    try {
      new (require('node:vm').Script)(js);
      ok('main.js 能被 JS 引擎解析');
    } catch (e) {
      bad('main.js 能被 JS 引擎解析', e.message);
    }

    /* ---------- D. 真实渲染（受限环境下自动跳过） ---------- */
    group('D. 无头浏览器渲染');
    let renderOK = false;
    const chrome = await findChrome();
    if (!chrome) {
      console.log('  \u001b[33m-\u001b[0m 没找到本机 Chrome / Edge，跳过渲染检查');
      console.log('    （装了 Chrome 会自动纳入，也可用 CHROME_PATH 指定）');
    } else {
      console.log('  \u001b[90m使用: ' + chrome + '\u001b[0m');
      let dom = '';
      let chromeErr = null;
      try {
        dom = await runChrome(chrome, port, { dumpTag: 'D' });
      } catch (e) {
        chromeErr = e;
      }

      if (!dom && chromeErr && /crashpad|crash server|EPERM|sandbox|Access is denied/i.test(chromeErr.message)) {
        console.log('  \u001b[33m-\u001b[0m 当前环境不允许 Chrome 启动子进程，跳过渲染检查（站点本身不受影响）');
        console.log('    \u001b[90m' + chromeErr.message.split('\n')[0].slice(0, 120) + '\u001b[0m');
        console.log('    \u001b[90m在有完整权限的终端里重跑 `npm run smoke` 即可执行这组检查\u001b[0m');
      } else if (!dom) {
        bad('无头浏览器能打开页面', chromeErr ? chromeErr.message.split('\n')[0] : '未知原因');
      } else {
        renderOK = true;
        const cards = (dom.match(/class="card"/g) || []).length;
        check(cards === 6, '项目卡片渲染出 6 张', '实际 ' + cards);

        const links = (dom.match(/class="link"/g) || []).length;
        check(links === 3, '联系方式渲染出 3 条', '实际 ' + links);

        check(dom.includes('class="card__title">图片压缩工具'), '卡片标题文案正确');
        check(dom.includes('class="chip">Spring Boot 3'), '技术栈标签渲染出来了');
        check(!dom.includes('undefined'), '渲染后 DOM 里没有 undefined');

        const revealTotal = (dom.match(/data-reveal=""/g) || []).length;
        const shown = (dom.match(/data-shown="true"/g) || []).length;
        check(shown >= 5, '首屏节点已完成入场（data-shown）', shown + ' 个已显示');
        check(revealTotal > 0, '页面下方的节点仍在等待滚动触发', revealTotal + ' 个待触发');

        const portraitTag = (dom.match(/<figure[^>]*data-portrait[^>]*>/) || [''])[0];
        check(portraitTag.indexOf('data-reveal') === -1 && portraitTag.indexOf('data-shown') !== -1,
          '头像播放后已脱离揭示队列', portraitTag.replace(/\s+/g, ' ').slice(0, 90));
        check(/data-scanned="true"/.test(dom), '头像扫描成像已播放');

        const year = dom.match(/data-year[^>]*>(\d{4})</);
        check(year && Number(year[1]) >= 2026, '页脚年份已由脚本填上', year ? year[1] : '未填');

        const artCount = (dom.match(/class="card__thumb"/g) || []).length;
        const svgCount = (dom.match(/<svg[^>]+viewBox="0 0 640 400"/g) || []).length;
        check(svgCount === artCount, `${artCount} 张缩略图都有内容（截图或 SVG 兜底）`, svgCount + ' 个 SVG');

        const arts = [...dom.matchAll(/<svg[^>]+viewBox="0 0 640 400"[\s\S]*?<\/svg>/g)].map((m) => m[0].length);
        check(new Set(arts).size === arts.length && arts.length > 0, '每张缩略图内容各不相同', arts.join(','));

        // 个人信息对不对（这几条最容易改漏）
        check(dom.includes('薛小飞'), '页面上是新名字"薛小飞"');
        check(!dom.includes('林知远'), '旧名字"林知远"已经清干净');
        check((dom.match(/xuexiaofei666@proton\.me/g) || []).length >= 2, '邮箱出现在页面与联系区');
        check(dom.includes('Xxf_nevergiveup'), '微信号已更新');
        check(!dom.includes('linzhiyuan'), '旧邮箱 / 旧微信号已清干净');
        check(dom.includes('江苏') && dom.includes('南京'), '现居地已更新为江苏南京');
        check(dom.includes('人工智能'), '角色描述包含"人工智能"');
        check(dom.includes('github.com/BlueQBL'), 'GitHub 链接指向 BlueQBL');

        const linkValues = [...dom.matchAll(/class="link__value">([^<]+)</g)].map((m) => m[1]);
        check(linkValues.length === 3, '联系方式 3 条（邮件 / GitHub / 微信）', linkValues.join(' , '));
        check(!dom.includes('博客'), '没有博客条目');
      }
    }

    /* ---------- E. 头像上传（真实点击 + localStorage 持久化） ---------- */
    group('E. 头像上传');
    if (!chrome || !renderOK) {
      console.log('  \u001b[33m-\u001b[0m 上一组没能渲染，跳过（上传链路需要真实浏览器）');
    } else {
      // 从临时目录里跑 Chrome：localStorage 归属 http://127.0.0.1:<port>，读写才可靠
      const stage = stageSite(UPLOAD_PROBE, '.smoke-stage-');
      const profileDir = fs.mkdtempSync(path.join(ROOT, '.smoke-profile-'));

      try {
        const uploadServer = stageServer(stage, 0);
        const uPort = port + 137;
        await new Promise((res, rej) => {
          uploadServer.once('error', rej);
          uploadServer.listen(uPort, '127.0.0.1', res);
        });

        let dom2 = '';
        try {
          dom2 = await runChrome(chrome, uPort, {
            outDir: profileDir,
            path: '/?reveal=all',
            dumpTag: 'E',
            // 预算要给够：页面自己会发真实 API 请求，那些 I/O 会吃掉虚拟时间
            waitMs: 12000,
          });
        } finally {
          uploadServer.close();
        }

        const r = readTitle(dom2, 'UP::');
        if (!r) {
          bad('假上传脚本跑起来了', '没拿到结果（DOM ' + dom2.length + ' 字节）');
        } else if (r.fatal) {
          bad('假上传脚本跑起来了', r.fatal);
        } else {
          check(r.defSrc === './assets/avatar.jpg' && r.defNaturalW > 0,
            '默认照片在浏览器里真的解码成功',
            r.defSrc + ' → ' + r.defNaturalW + '×' + r.defNaturalH);
          check(r.defNaturalW === 1080 && r.defNaturalH === 1080, '默认照片是 1080×1080');
          check(r.custom === 'true', '图片被换成自定义照片（data-custom）');
          check(r.srcIsData === true, '头像 src 换成了 data:image/…');
          check(r.srcLen > 400, 'dataURL 有实际内容', r.srcLen + ' 字符');
          check(r.resetHidden === false, '"恢复默认"按钮出现');
          check(r.hintKind === 'ok', '提示语是成功态', String(r.hint).slice(0, 60));
          check(/已换成本机照片/.test(String(r.hint)), '提示语说明了照片尺寸与大小');
          check(/^dataUrl\(\d+\)$/.test(String(r.storedKind)), '照片写进了 localStorage',
            String(r.storedKind));
        }
      } finally {
        fs.rmSync(stage, { recursive: true, force: true });
        fs.rmSync(profileDir, { recursive: true, force: true });
      }
    }

    /* ---------- F. 多语言 / 访问统计 / 留言板（真实交互） ---------- */
    group('F. 多语言 · 统计 · 留言板');
    if (!chrome || !renderOK) {
      console.log('  \u001b[33m-\u001b[0m 渲染不可用，跳过（这三块都需要真实浏览器）');
    } else {
      const stage2 = stageSite(PROBE_SRC, '.smoke-stage-');
      const profile2 = fs.mkdtempSync(path.join(ROOT, '.smoke-profile-'));

      try {
        const mixed = stageServer(stage2, port);
        const fPort = port + 211;
        await new Promise((res, rej) => {
          mixed.once('error', rej);
          mixed.listen(fPort, '127.0.0.1', res);
        });

        let dom3 = '';
        try {
          dom3 = await runChrome(chrome, fPort, {
            outDir: profile2, path: '/?reveal=all', dumpTag: 'F', waitMs: 25000,
          });
        } finally {
          mixed.close();
        }

        const r = readTitle(dom3, 'UP::');
        if (!r) {
          bad('浏览器探针跑起来了', '没拿到结果（DOM ' + dom3.length + ' 字节）');
        } else if (r.fatal) {
          bad('浏览器探针跑起来了', r.fatal);
        } else {
          /* --- 访问统计 --- */
          check(r.stats && r.stats.hidden === false, '页脚显示访问统计（后端可用时）');
          check(Number(r.stats.views) > 0, '统计里有真实 PV', 'views=' + r.stats.views);
          check(Number(r.stats.uv) > 0, '统计里有 UV', 'uv=' + r.stats.uv);
          check(r.stats.bars === 14, '折线是 14 根（近 14 天）', r.stats.bars + ' 根');
          check(/\d{4}-\d{2}-\d{2}/.test(r.stats.since), '显示起始日期', r.stats.since);
          check(!/[{}]/.test(r.stats.since), '起始日期没有漏出模板占位符', r.stats.since);

          /* --- 留言板 --- */
          check(r.gbBoardShown === true, '留言板显示出来了');
          check(r.gbFirstArrived === true, '留言提交后出现在列表里');
          // 成功提示一闪而过（紧接着测限速会把它换掉），所以按发生顺序回看
          const okLine = (r.dbgLog || []).find((x) => x.indexOf('ok:') === 0);
          check(!!okLine, '发完留言有成功提示', '状态变化: ' + JSON.stringify((r.dbgLog || []).slice(0, 4)));
          check(/收到|Got it/.test(okLine || ''), '成功提示的内容是"收到了"', String(okLine).slice(0, 24));
          check(r.items >= 1, '新留言在列表里', r.items + ' 条');
          check(r.first.indexOf('automated smoke test') >= 0, '列表里就是刚发的内容', r.first.slice(0, 40));
          check(r.firstName === 'Smoke Bot', '留言显示了填写的名字');
          check(r.avatarInitial === 'S', '头像用了名字首字母', r.avatarInitial);
          check(r.gbTextCleared === true, '发完之后输入框清空了');
          check(/s|秒/.test(r.gbRateStatus || '') && r.gbRateKind === 'error',
            '连发被限速时，前端给了一句人话', String(r.gbRateStatus).slice(0, 44));
          check(r.honeypotHidden === true, '蜜罐字段对真人不可见',
            'box=' + r.honeypotBoxOffset + ' clip=' + r.honeypotClip +
            ' opacity=' + r.honeypotOpacity + ' pointer=' + r.honeypotPointer);
          check(r.honeypotTabIndex === '-1', '蜜罐字段不会被 Tab 键聚焦');
          check(r.gbRateItems === 1, '被限速的第二条没有进列表', r.gbRateItems + ' 条');

          /* --- 多语言（英文） --- */
          check(r.en && r.en.docLang === 'en', '切到英文后 html lang=en');
          check(r.en.l1 === '薛小飞', '名字保持中文（不该被翻译）');
          check(r.en.l2.indexOf('Full-stack') >= 0, '英文角色描述生效', r.en.l2.slice(0, 40));
          check(r.en.l3 === 'About', '英文章节标题生效', r.en.l3);
          check(r.en.l4.indexOf('Image Compressor') >= 0, '英文项目名生效', r.en.l4);
          check(r.en.l5 === 'Post message', '英文按钮文案生效', r.en.l5);
          check(r.en.l6.indexOf('Static front end') >= 0, '英文页脚生效');
          check(r.en.l7 === 'Nanjing, Jiangsu', '英文现居地生效', r.en.l7);
          check(r.en.l8 === 'views', '英文统计标签生效', r.en.l8);
          check(r.en.saved === 'en', '语言选择写进了 localStorage', String(r.en.saved));

          // 回归：切到英文后，项目和联系板块必须仍然"看得见"。
          // 曾经的 bug 是重建节点导致它们停在 opacity:0，要刷新才出来。
          check(r.en.vis.cards.total === r.en.vis.cards.visible,
            '切到英文后项目卡片都还可见',
            r.en.vis.cards.visible + '/' + r.en.vis.cards.total +
            '，首张 opacity=' + r.en.vis.card0.opacity + ' h=' + r.en.vis.card0.h);
          check(r.en.vis.links.total === r.en.vis.links.visible,
            '切到英文后联系方式条目都还可见',
            r.en.vis.links.visible + '/' + r.en.vis.links.total +
            '，首条 opacity=' + r.en.vis.link0.opacity);
          // data-reveal 是"这个节点参与入场动画"的标记，会一直留着；
          // 关键是它必须已经 data-shown，并且真的不透明。
          check(r.en.vis.card0.shown === true && r.en.vis.card0.opacity > 0.9,
            '卡片已完成入场、不是停在 opacity:0',
            'shown=' + r.en.vis.card0.shown + ' opacity=' + r.en.vis.card0.opacity);
          check(r.en.vis.sections.visible === r.en.vis.sections.total,
            '所有 section 都有可见高度',
            r.en.vis.sections.visible + '/' + r.en.vis.sections.total);
          check(r.en.vis.link0.text.length > 2, '联系方式条目里有文字', r.en.vis.link0.text);

          /* --- 多语言（切回中文） --- */
          check(r.zh && r.zh.docLang === 'zh-CN', '切回中文后 html lang=zh-CN');
          check(r.zh.l3 === '关于我', '中文章节标题回来了', r.zh.l3);
          check(r.zh.l2.indexOf('全栈开发者') >= 0, '中文角色描述回来了');
          check(r.zh.l8 === '访问', '中文统计标签回来了');
          check(r.zh.saved === 'zh', '再切一次也会记住', String(r.zh.saved));
          check(r.zh.l4.indexOf('图片压缩工具') >= 0, '中文项目名回来了', r.zh.l4);
          check(r.zh.vis.cards.total === r.zh.vis.cards.visible, '切回中文后项目卡片仍然可见',
            r.zh.vis.cards.visible + '/' + r.zh.vis.cards.total);
          check(r.zh.vis.links.total === r.zh.vis.links.visible, '切回中文后联系方式仍然可见',
            r.zh.vis.links.visible + '/' + r.zh.vis.links.total);
        }
      } finally {
        fs.rmSync(stage2, { recursive: true, force: true });
        fs.rmSync(profile2, { recursive: true, force: true });
      }
    }

    /* ---------- 汇总 ---------- */
    console.log('\n' + '─'.repeat(52));
    if (fail === 0) {
      console.log(`\u001b[32m全部通过\u001b[0m  ${pass} 项检查`);
    } else {
      console.log(`\u001b[31m${fail} 项失败\u001b[0m / 共 ${pass + fail} 项`);
      failures.forEach((f) => console.log('  · ' + f));
    }
  } finally {
    server.close();
    if (!process.env.SMOKE_DEBUG) {
      fs.rmSync(TMP_DATA, { recursive: true, force: true });
    } else {
      console.log('\u001b[90m调试模式：临时数据留在 ' + TMP_DATA + '\u001b[0m');
    }
  }

  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\u001b[31m冒烟测试自身出错:\u001b[0m', err);
  process.exit(1);
});
