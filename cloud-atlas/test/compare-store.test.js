/* 对比清单的存储迁移测试
 *
 * 用法：node test/compare-store.test.js
 *
 * 这一条测的是"升级之后会怎样"，而不是"从零开始会怎样"——
 * 而真实用户遇到的恰恰是前者：
 *
 *   旧版把「自动生成的默认清单」（收藏城市的前 5 个）也写进了 localStorage。
 *   于是升级到新版后，那份自动生成的清单被当成"用户自己的选择"读回来，
 *   新的默认值（只展示当前城市）永远不生效。用户看到的是自己删剩下的那几个，
 *   而不是当前城市——功能看起来"根本没改"。
 *
 * 存储格式本身分不出"自动填的"和"用户挑的"，所以新版：
 *   1. 换成带版本号的键，存成 { v, source, places }；
 *   2. 只认 source === 'user'；
 *   3. 对旧键做一次迁移判断：清单里的城市**全部都在收藏里** → 认定为旧版自动填的，丢掉；
 *      只要有一个不在收藏里（旧版能搜非收藏城市，用户挑的必然如此）→ 保留。
 *
 * 为什么要用真实浏览器：bug 就在"读存储"这一步。
 * 页面跑起来之后再去改内存状态是测不到的，必须预置好 localStorage 再冷启动。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 5261);
const CHROME = [
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'Google/Chrome/Application/chrome.exe'),
].find((p) => p && fs.existsSync(p));

let server = null;
let port = PORT;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const ok = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (ok) return true;
    await wait(200);
  }
  return false;
}

/** 把要预置的存储序列化成一段脚本 */
function seedScript(seed) {
  const lines = [
    `localStorage.setItem('cloud-atlas.saved', ${JSON.stringify(JSON.stringify(seed.saved || []))});`,
  ];
  if (seed.legacy) {
    lines.push(`localStorage.setItem('cloud-atlas.compare', ${JSON.stringify(JSON.stringify(seed.legacy))});`);
  }
  if (seed.modern) {
    lines.push(`localStorage.setItem('cloud-atlas.compare.v2', ${JSON.stringify(JSON.stringify(seed.modern))});`);
  }
  return lines.join('\n    ');
}

/**
 * 冷启动一次，等应用渲染完之后把关键状态抄进标题。
 *
 * 为什么要抄一层：--dump-dom 出来的是启动页，应用页面在 iframe 里、DOM 不在 dump 里。
 * 而启动页与应用同源（都从本机服务取），所以它可以直接读 iframe 的 DOM。
 */
async function coldStart(seed, label) {
  const profile = path.join(ROOT, '.screens', 'profile-' + label);
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });

  const boot = path.join(ROOT, '.screens', 'seed-' + label + '.html');
  const appUrl = `/?city=${encodeURIComponent(seed.city)}&nolocate=1&fav=`;
  fs.writeFileSync(boot, `<!DOCTYPE html><meta charset="utf-8"><title>pending</title>
<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style>
<iframe id="f"></iframe>
<script>
  try {
    ${seedScript(seed)}
  } catch (e) { document.title = 'probe:seed-error:' + e.message; }
  const f = document.getElementById('f');

  function snapshot() {
    const d = f.contentDocument;
    const chips = Array.prototype.map.call(d.querySelectorAll('.cmp-chip__name'), (n) => n.textContent.trim());
    const legacyLeft = (function () {
      try { return String(localStorage.getItem('cloud-atlas.compare')); } catch (e) { return 'n/a'; }
    })();
    let stored = null;
    try { stored = localStorage.getItem('cloud-atlas.compare.v2'); } catch (e) {}
    return {
      here: (d.querySelector('#place-name') || {}).textContent || '',
      chips,
      lines: d.querySelectorAll('.cmp-line').length,
      tableHidden: !!(d.querySelector('#compare-table-wrap') || {}).hidden,
      note: ((d.querySelector('#cmp-note') || {}).textContent || '').trim(),
      legacyLeft: legacyLeft === 'null' ? null : 'kept',
      source: stored ? (JSON.parse(stored).source || null) : null,
    };
  }

  let done = false;
  function poll() {
    const d = f.contentDocument;
    const st = d && d.body && d.body.dataset.state;
    if (st === 'ready' && !done) {
      done = true;
      // 等对比区取数完成：清单里的城市数 = 图上的曲线数
      const settle = () => {
        const snap = snapshot();
        if (snap.chips.length === 0 || snap.lines === snap.chips.length) {
          document.title = 'probe:' + JSON.stringify(snap);
          return;
        }
        setTimeout(settle, 150);
      };
      setTimeout(settle, 400);
      return;
    }
    if (!done) setTimeout(poll, 150);
  }

  f.addEventListener('load', () => {
    // 首次 load 是应用页面；之后如果应用换了文档就不重复启动
    if (!done) poll();
  });
  f.src = ${JSON.stringify(appUrl)};
<\/script>`, 'utf8');

  const args = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions',
    `--user-data-dir=${profile}`,
    '--window-size=1440,1000', '--deny-permission-prompts',
    '--virtual-time-budget=30000', '--dump-dom',
    `http://127.0.0.1:${port}/.screens/seed-${label}.html`,
  ];

  const html = await new Promise((resolve, reject) => {
    const child = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.on('error', reject);
    child.on('exit', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

  const title = (html.match(/<title>([\s\S]*?)<\/title>/) || ['', ''])[1]
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

  if (!title.startsWith('probe:')) {
    return { error: '启动页没有产出读数，标题是：' + title.slice(0, 160) };
  }
  const body = title.slice('probe:'.length);
  if (body.startsWith('seed-error:')) return { error: body };
  try {
    return JSON.parse(body);
  } catch (e) {
    return { error: '读数不是合法 JSON：' + body.slice(0, 160) };
  }
}

/* 四个城市用真实坐标：北京、广州、拉萨、南京。
   名字用"市"结尾，因为地名库返回的就是这个形态（Photon 给「广州市」而不是「广州」），
   榜单里比对的也是渲染出来的文本。 */
const BJ = { id: 'bj', name: '北京市', city: null, region: '北京', country: '中国', latitude: 39.9042, longitude: 116.4074 };
const GZ = { id: 'gz', name: '广州市', city: null, region: '广东省', country: '中国', latitude: 23.1291, longitude: 113.2644 };
const LS = { id: 'ls', name: '拉萨市', city: null, region: '西藏', country: '中国', latitude: 29.65, longitude: 91.1 };

test.before(async () => {
  if (!CHROME) return;
  server = spawn(process.execPath, [path.join(ROOT, 'server.js'), String(port)], { cwd: ROOT, stdio: 'ignore' });
  if (!(await waitForServer(8000))) throw new Error('服务没起来');
});

test.after(() => {
  if (server) server.kill();
});

test('没有存过清单时，默认只有当前城市', { skip: !CHROME ? '没有浏览器' : false }, async () => {
  const r = await coldStart({ city: '南京', saved: [BJ, GZ] }, 'fresh');
  assert.ok(!r.error, r.error);
  assert.deepEqual(r.chips, ['南京市'], '默认应当只有当前城市，实际：' + r.chips.join('、'));
  assert.equal(r.lines, 1, '应当画出 1 条曲线');
  assert.equal(r.tableHidden, true, '只有 1 个城市时对照表要隐藏');
  assert.match(r.note, /还能/, '提示行要说明还能加几个');
});

test('旧格式清单若全部来自收藏 → 判为旧版自动填的，丢弃并套用新默认', { skip: !CHROME ? '没有浏览器' : false }, async () => {
  /* 这就是用户遇到的情况：旧版默认把收藏的前几个写进存储，他甚至删过几个。
     剩下的仍然全是收藏城市，所以判为自动填的，换回"只有当前城市"。 */
  const r = await coldStart({ city: '南京', saved: [BJ, GZ], legacy: [BJ, GZ] }, 'legacy-all-fav');
  assert.ok(!r.error, r.error);
  assert.deepEqual(r.chips, ['南京市'],
    '旧版自动填的清单应当被丢弃、换成当前城市，实际：' + r.chips.join('、'));
  assert.equal(r.legacyLeft, null, '旧键应当被清掉，避免下次又误判');
});

test('旧格式清单里含收藏之外的城市 → 是用户自己挑的，保留', { skip: !CHROME ? '没有浏览器' : false }, async () => {
  // 拉萨不在收藏里：旧版只能通过搜索加进来，所以这份清单必然出自用户之手
  const r = await coldStart({ city: '南京', saved: [BJ, GZ], legacy: [LS, BJ] }, 'legacy-mixed');
  assert.ok(!r.error, r.error);
  assert.deepEqual(r.chips, ['拉萨市', '北京市'],
    '用户自己挑的清单要保留，实际：' + r.chips.join('、'));
  assert.equal(r.source, 'user', '保留后应当升级成新版格式并标记为 user');
});

test('新版格式里 source=default 的清单不被当成用户选择', { skip: !CHROME ? '没有浏览器' : false }, async () => {
  /* 新版只认 source === 'user'。
     这条防的是"以后又有人图省事把默认值写进存储"，那样 bug 会原样回来。 */
  const r = await coldStart({
    city: '南京',
    saved: [BJ, GZ],
    modern: { v: 2, source: 'default', places: [BJ, GZ] },
  }, 'modern-default');
  assert.ok(!r.error, r.error);
  assert.deepEqual(r.chips, ['南京市'], 'source=default 时应当套用默认，实际：' + r.chips.join('、'));
});

test('新版格式里 source=user 的清单被原样采用', { skip: !CHROME ? '没有浏览器' : false }, async () => {
  const r = await coldStart({
    city: '南京',
    saved: [BJ, GZ],
    modern: { v: 2, source: 'user', places: [GZ, LS] },
  }, 'modern-user');
  assert.ok(!r.error, r.error);
  assert.deepEqual(r.chips, ['广州市', '拉萨市'], '用户的选择要原样保留，实际：' + r.chips.join('、'));
  assert.equal(r.lines, 2, '应当画出 2 条曲线');
  assert.equal(r.tableHidden, false, '两个城市时对照表要出现');
});
