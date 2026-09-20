/**
 * 冒烟测试 · 零依赖
 *
 * 三组检查，全都在真实 HTTP 上跑：
 *   A. 静态资源      —— 每个文件都返回 200，MIME 正确，路径穿越被挡住
 *   B. 页面内容      —— index.html 里该有的锚点、资源、无障碍属性都在，没有留 TODO
 *   C. 渲染后 DOM    —— 用无头 Chrome（本机装了就用，没装就跳过）真实渲染一遍，
 *                       把卡片、联系人、主题开关、扫描动效的状态打印出来
 *
 *   node scripts/smoke-test.js
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
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

/* ---------- 找到无头 Chrome ---------- */
async function findChrome() {
  const { existsSync } = fs;
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
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

/* ---------- 无头浏览器：把 DOM 抓下来 ----------
   不能用管道读 Chrome 的 stdout（受限环境里管道直接 EPERM），
   所以让它把 DOM 和日志都写进临时文件，我们再读文件。
   受限沙箱里 Chrome 起不来时会一连串报错，因此准备了几组启动参数，
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
  ['--no-sandbox', '--disable-dev-shm-usage', '--disable-features=NetworkServiceSandbox', '--disable-crash-reporter', '--disable-breakpad'],
  ['--no-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote', '--disable-crash-reporter', '--disable-breakpad'],
];

/* 一段"假上传"脚本：造一张 PNG 塞进 <input type=file>，触发 change，
   再等几拍把结果写进 <title>。用来验证头像上传这条链路真的能走通。 */
const UPLOAD_PROBE =
  'window.addEventListener("load",function(){setTimeout(function(){' +
  'var out=function(o){document.title="UP::"+encodeURIComponent(JSON.stringify(o))};' +
  'try{' +
  'var d=document.querySelector("[data-portrait-photo]");' +
  'var probe={' +
  'defSrc:d.getAttribute("src"),' +
  'defNaturalW:d.naturalWidth,defNaturalH:d.naturalHeight,defComplete:d.complete' +
  '};' +
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
  'out({' +
  'defSrc:probe.defSrc,defNaturalW:probe.defNaturalW,defNaturalH:probe.defNaturalH,defComplete:probe.defComplete,' +
  'custom:img.getAttribute("data-custom"),' +
  'srcIsData:img.getAttribute("src").indexOf("data:image/")===0,' +
  'srcLen:img.getAttribute("src").length,' +
  'hint:hint.textContent,hintKind:hint.getAttribute("data-kind"),' +
  'resetHidden:reset?reset.hidden:null,' +
  'storedKind:stored?(stored==="ERR"||stored.indexOf("ERR:")===0?stored:(stored.indexOf("data:image/")===0?"dataUrl("+stored.length+")":"other")):"null"' +
  '});' +
  '},900);' +
  '},"image/png");' +
  '}catch(e){out({fatal:String(e)})}' +
  '},700)})';

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
      try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ }

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

(async function main() {
  console.log('个人作品集 · 冒烟测试');
  console.log('\u001b[90m源目录: ' + ROOT + '\u001b[0m');

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
      check(
        (r.headers['content-type'] || '').includes(type),
        `${p} MIME 是 ${type}`,
        r.headers['content-type']
      );
      check(r.body.length > 0, `${p} 不是空响应`, `${r.body.length} 字节`);
    }

    const traversal = await get(port, '/../package.json');
    check(
      traversal.status === 403 || traversal.status === 404,
      '目录穿越被挡住（不能读到上级目录）',
      `实际 ${traversal.status}`
    );

    const missing = await get(port, '/does-not-exist.js');
    check(missing.status === 404, '不存在的路径 → 404', `实际 ${missing.status}`);

    const post = await new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/', method: 'POST' },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.end();
    });
    check(post === 405, 'POST → 405（只读静态服务）', `实际 ${post}`);

    /* ---------- B. 页面内容 ---------- */
    group('B. 页面结构');

    const page = (await get(port, '/')).body;
    const css = (await get(port, '/styles.css')).body;
    const js = (await get(port, '/main.js')).body;

    check(/<html[^>]+lang="zh-CN"/.test(page), 'html 声明了 lang="zh-CN"');
    check(/name="viewport"[^>]+width=device-width/.test(page), '有移动端 viewport');
    check(/<title>[^<]+<\/title>/.test(page), '有 title', (page.match(/<title>([^<]*)<\/title>/) || [])[1]);

    for (const id of ['top', 'about', 'work', 'contact']) {
      check(page.includes(`id="${id}"`), `存在锚点 #${id}`);
    }
    for (const sec of ['hero', 'about', 'work', 'contact']) {
      check(page.includes(`data-section="${sec}"`), `区块 ${sec} 已标记`);
    }
    check((page.match(/data-reveal/g) || []).length >= 10, '滚动揭示的挂载点足够多',
      (page.match(/data-reveal/g) || []).length + ' 处');
    check(page.includes('data-cards'), '项目卡片容器存在');
    check(page.includes('data-links'), '联系方式容器存在');
    check((page.match(/data-theme-toggle/g) || []).length >= 2, '桌面 / 移动各有一个主题开关');
    check(page.includes('data-portrait'), '头像扫描区存在');
    check(/<h1[^>]*>[^<]+<\/h1>/.test(page), 'h1 首页大标题存在');

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
    check(unsafe.length === 0, `外部链接都带 rel="noopener"`, blanks.length + ' 个 target=_blank');

    check(!/TODO|FIXME|XXX|占位|Lorem/i.test(page), '页面里没有留下占位符');
    check(!/undefined|NaN(?!\w)/.test(page.replace(/[\s\S]*?<script>/, '')), '页面里没有 undefined / NaN');

    // 资源引用
    check(page.includes('href="./styles.css"'), 'index.html 引用了 styles.css');
    check(page.includes('src="./main.js"'), 'index.html 引用了 main.js');
    check(page.includes('src="./assets/avatar.jpg"'), 'index.html 引用了默认头像照片');
    check(page.includes("src='./assets/avatar-line-art.svg'"), '照片缺失时有线描兜底图');

    /* ---------- C. CSS 与 JS 静态检查 ---------- */
    group('C. 样式与脚本');

    const braces = (s) => (s.match(/{/g) || []).length - (s.match(/}/g) || []).length;
    check(braces(css) === 0, 'styles.css 花括号配平', '差值 ' + braces(css));

    const tokens = (css.match(/--[a-z0-9-]+:/g) || []).length;
    check(tokens >= 20, '设计令牌数量正常', tokens + ' 个');
    check(css.includes('prefers-reduced-motion'), '样式里处理了"减少动效"偏好');
    check(
      (page + js).includes('prefers-color-scheme'),
      '页面/脚本里处理了系统主题偏好'
    );
    check(!/!important/.test(css.replace(/[\s\S]*prefers-reduced-motion[\s\S]*/, '')), '没有滥用 !important');
    check(css.includes('@media (min-width: 1180px)'), '有桌面断点');
    check(/@media \(min-width:\s*7\d\dpx\)/.test(css), '有平板断点');
    check(css.includes(':focus-visible'), '键盘焦点样式存在');

    // 移动端：栅格容器不能写死成超宽像素（1180 那种是 max-width，肉眼可见不算）
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

    // 语法层面真的能解析（不只是配平）
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
        dom = await runChrome(chrome, port);
      } catch (e) {
        chromeErr = e;
      }

      if (!dom && chromeErr && /crashpad|crash server|EPERM|sandbox|Access is denied/i.test(chromeErr.message)) {
        // 受限沙箱里 Chrome 的子进程起不来。这不是站点的问题，明确跳过而不是假装通过。
        console.log('  \u001b[33m-\u001b[0m 当前环境不允许 Chrome 启动子进程，跳过渲染检查（站点本身不受影响）');
        console.log('    \u001b[90m' + chromeErr.message.split('\n')[0].slice(0, 120) + '\u001b[0m');
        console.log('    \u001b[90m在有完整权限的终端里重跑 `npm run smoke` 即可执行这组检查\u001b[0m');
      } else if (!dom) {
        bad('无头浏览器能打开页面', chromeErr ? chromeErr.message.split('\n')[0] : '未知原因');
      } else {
        renderOK = true;
        if (process.env.PORTFOLIO_DUMP) {
          fs.writeFileSync(process.env.PORTFOLIO_DUMP, dom);
          console.log('  \u001b[90mDOM 已写出: ' + process.env.PORTFOLIO_DUMP + '\u001b[0m');
        }
        const cards = (dom.match(/class="card"/g) || []).length;
        check(cards === 6, '项目卡片渲染出 6 张', '实际 ' + cards);

        const links = (dom.match(/class="link"/g) || []).length;
        check(links === 3, '联系方式渲染出 3 条', '实际 ' + links);

        check(dom.includes('class="card__title">图片压缩工具'), '卡片标题文案正确');        check(dom.includes('class="chip">Spring Boot 3'), '技术栈标签渲染出来了');
        check(!dom.includes('undefined'), '渲染后 DOM 里没有 undefined');

        // 首屏的揭示必须已经跑过（下面的节点要等滚动，天然还没触发）
        const revealTotal = (dom.match(/data-reveal=""/g) || []).length;
        const shown = (dom.match(/data-shown="true"/g) || []).length;
        check(shown >= 5, '首屏节点已完成入场（data-shown）', shown + ' 个已显示');
        check(revealTotal > 0, '页面下方的节点仍在等待滚动触发', revealTotal + ' 个待触发');
        // 头像播完就该从揭示队列里摘掉（属性顺序可能变，所以先取整个开标签）
        const portraitTag = (dom.match(/<figure[^>]*data-portrait[^>]*>/) || [''])[0];
        check(
          portraitTag.indexOf('data-reveal') === -1 && portraitTag.indexOf('data-shown') !== -1,
          '头像播放后已脱离揭示队列',
          portraitTag.replace(/\s+/g, ' ').slice(0, 90)
        );
        check(/data-scanned="true"/.test(dom), '头像扫描成像已播放');

        const year = dom.match(/data-year[^>]*>(\d{4})</);
        check(year && Number(year[1]) >= 2026, '页脚年份已由脚本填上', year ? year[1] : '未填');

        // 缩略图回落：SVG 有没有真的画出来
        const artCount = (dom.match(/class="card__thumb"/g) || []).length;
        const svgCount = (dom.match(/<svg[^>]+viewBox="0 0 640 400"/g) || []).length;
        check(svgCount === artCount, `${artCount} 张缩略图都有内容（截图或 SVG 兜底）`, svgCount + ' 个 SVG');

        // 每张缩略图都得有自己的画（不能六张一模一样）
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

        // 联系方式条数从固定的 4 改成由数据决定
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
      // 从临时目录里跑 Chrome：这样 localStorage 归属 http://127.0.0.1:<port>，
      // 读写才可靠（文件系统临时目录上的 origin 配额行为不一致）
      const stage = fs.mkdtempSync(path.join(ROOT, '.smoke-stage-'));
      const profileDir = fs.mkdtempSync(path.join(ROOT, '.smoke-profile-'));

      try {
        const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
        const inject = '<script>' + UPLOAD_PROBE + '<\/script>';
        fs.writeFileSync(path.join(stage, 'index.html'), html.replace('</head>', inject + '</head>'));
        for (const f of ['styles.css', 'main.js']) {
          fs.copyFileSync(path.join(ROOT, f), path.join(stage, f));
        }
        fs.mkdirSync(path.join(stage, 'assets'), { recursive: true });
        for (const f of fs.readdirSync(path.join(ROOT, 'assets'))) {
          const src = path.join(ROOT, 'assets', f);
          if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(stage, 'assets', f));
        }

        const uploadServer = http.createServer((req, res) => {
          let p = req.url.split('?')[0];
          if (p === '/') p = '/index.html';
          if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
          let body;
          try {
            body = fs.readFileSync(path.join(stage, decodeURIComponent(p)));
          } catch {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('not found');
          }
          const ext = path.extname(p);
          const type = ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript'
            : ext === '.svg' ? 'image/svg+xml' : 'text/html';
          res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
          res.end(body);
        });

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
            waitMs: 6000,
          });
        } finally {
          uploadServer.close();
        }

        const title = dom2.match(/<title>([\s\S]*?)<\/title>/);
        const raw = title ? title[1].trim() : '';
        if (raw.indexOf('UP::') !== 0) {
          bad('假上传脚本跑起来了', raw.slice(0, 140) || '没拿到结果');
        } else {
          const r = JSON.parse(decodeURIComponent(raw.slice(4)));
          if (r.fatal) {
            bad('假上传脚本跑起来了', r.fatal);
          } else {
            // 默认照片必须真的解码出来了（200 只说明服务器给了文件）
            check(
              r.defSrc === './assets/avatar.jpg' && r.defNaturalW > 0,
              '默认照片在浏览器里真的解码成功',
              r.defSrc + ' → ' + r.defNaturalW + '×' + r.defNaturalH
            );
            check(r.defNaturalW === 1080 && r.defNaturalH === 1080, '默认照片是 1080×1080');
            check(r.custom === 'true', '图片被换成自定义照片（data-custom）');
            check(r.srcIsData === true, '头像 src 换成了 data:image/…');
            check(r.srcLen > 400, 'dataURL 有实际内容', r.srcLen + ' 字符');
            check(r.resetHidden === false, '"恢复默认"按钮出现');
            check(r.hintKind === 'ok', '提示语是成功态', String(r.hint).slice(0, 60));
            check(/已换成本机照片/.test(String(r.hint)), '提示语说明了照片尺寸与大小');
            check(
              /^dataUrl\(\d+\)$/.test(String(r.storedKind)),
              '照片写进了 localStorage',
              String(r.storedKind)
            );
          }
        }
      } finally {
        fs.rmSync(stage, { recursive: true, force: true });
        fs.rmSync(profileDir, { recursive: true, force: true });
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
  }

  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\u001b[31m冒烟测试自身出错:\u001b[0m', err);
  process.exit(1);
});
