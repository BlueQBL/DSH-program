/* 版面验证：让页面自己量真实尺寸，再把结果读回来判断
 *
 * 用法：
 *   node scripts/verify-layout.js              # 五种宽度各查一遍
 *   node scripts/verify-layout.js "?city=杭州"  # 换城市再查
 *
 * 测量逻辑在 js/verify-probe.js 里，由页面在 ?verify=1 时自行加载并在渲染完成后执行。
 * 这里只负责：起服务 → 用无头 Chrome 按各宽度打开 → 把 title 里的结果读出来 → 判断。
 *
 * 为什么这样分工：iframe 套一层去外部测量会和 --virtual-time-budget 打架
 * （定时器被快进、网络还没走完，于是总是在页面就绪前就 dump 了），
 * 由页面自己量则完全没有跨文档的时序问题。
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.SHOT_PORT || 5241);

const CHROME_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
  path.join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
];

const VIEWPORTS = [
  { name: '桌面 1440', width: 1440, height: 1000 },
  { name: '笔记本 1120', width: 1120, height: 1000 },
  { name: '平板 900', width: 900, height: 1000 },
  { name: '手机 414', width: 414, height: 900 },
  { name: '小屏 360', width: 360, height: 760 },
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 1200 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (ok) return true;
    await wait(250);
  }
  return false;
}

/** 打开页面并把标题里的测量结果读回来。stdout 走管道读，Chrome 自己会结束。 */
function measure(browser, viewport, query) {
  const profile = path.join(ROOT, '.screens', 'profile');
  fs.mkdirSync(profile, { recursive: true });

  const sep = query.includes('?') ? '&' : '?';
  const url = `http://127.0.0.1:${PORT}/${query}${sep}verify=1`;

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--user-data-dir=${profile}`,
    `--window-size=${viewport.width},${viewport.height}`,
    '--deny-permission-prompts',
    // 探针最多等 12 秒，这里给到 20 秒余量（首次取数要打上游）
    '--virtual-time-budget=20000',
    '--dump-dom',
    url,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(browser, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.on('error', reject);
    child.on('exit', () => {
      const html = Buffer.concat(chunks).toString('utf8');
      const m = html.match(/<title>RESULT:(.*?)<\/title>/s);
      if (!m) {
        fs.writeFileSync(path.join(ROOT, '.screens', 'fail-' + viewport.width + '.html'), html, 'utf8');
        return resolve(null);
      }
      const json = m[1]
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
      try {
        resolve(JSON.parse(json));
      } catch (e) {
        reject(new Error('测量结果不是合法 JSON：' + json.slice(0, 240)));
      }
    });
  });
}

async function main() {
  const browser = CHROME_CANDIDATES.find((p) => p && fs.existsSync(p));
  if (!browser) throw new Error('没有找到 Chrome 或 Edge');

  const query = process.argv[2] || '?nolocate=1';
  fs.mkdirSync(path.join(ROOT, '.screens'), { recursive: true });

  const server = spawn(process.execPath, [path.join(ROOT, 'server.js'), String(PORT)], { cwd: ROOT, stdio: 'ignore' });

  const report = [];
  let failures = 0;

  try {
    if (!(await waitForServer(8000))) throw new Error(`服务没能在 ${PORT} 起来`);

    for (const vp of VIEWPORTS) {
      const res = await measure(browser, vp, query);
      console.log('\n' + '─'.repeat(76));
      console.log(`版面检查　${vp.name}　视口 ${vp.width}×${vp.height}`);
      console.log('─'.repeat(76));

      if (!res) {
        console.log('× 页面没有返回测量结果（详见 .screens/fail-' + vp.width + '.html）');
        failures++;
        report.push({ viewport: vp.name, issues: ['没有返回测量结果'] });
        continue;
      }

      const m = res.metrics;
      console.log(`基调 ${m['基调']}　状态 ${m['状态']}　气温 ${m['气温文本']}　`
        + `曲线 ${m['曲线路径数']} 条　7 日 ${m['7 日行数']} 行　量程条 ${m['量程条数']} 条`);
      if (m['字号']) console.log(`字号：城市名 ${m['字号'].城市名}　气温读数 ${m['字号'].气温读数}　正文 ${m['字号'].正文}`);
      if (m['曲线包围盒']) console.log(`曲线包围盒 ${m['曲线包围盒'].w}×${m['曲线包围盒'].h}　收藏栏气温 [${(m['收藏栏气温'] || []).join(' ')}]`);

      const contrasts = Object.entries(m)
        .filter(([, v]) => v && typeof v === 'object' && typeof v.ratio === 'number')
        .sort((a, b) => a[1].ratio - b[1].ratio);
      if (contrasts.length) {
        const worst = contrasts.slice(0, 6).map(([k, v]) => `${k} ${v.ratio}:1`).join('　');
        console.log(`对比度最低的六项：${worst}`);
      }

      if (!res.issues.length) {
        console.log('✓ 没有发现问题');
      } else {
        failures += res.issues.length;
        res.issues.forEach((iss) => {
          console.log(`× [${iss.kind}] ${iss.note}`
            + (iss.text ? `　文本「${iss.text}」` : '')
            + (iss.fg ? `　前景 ${iss.fg} 底色 ${iss.bg}` : ''));
        });
      }

      if (res.interactions && res.interactions.length) {
        const bad = res.interactions.filter((d) => !d.ok).length;
        console.log(`交互自检 ${res.interactions.length - bad}/${res.interactions.length} 通过`);
        if (bad) {
          res.interactions.filter((d) => !d.ok).forEach((d) => console.log(`  × ${d.what}　${d.detail}`));
        }
      }
      report.push({ viewport: vp.name, metrics: m, issues: res.issues, interactions: res.interactions });
    }
  } finally {
    server.kill();
  }

  fs.writeFileSync(path.join(ROOT, '.screens', 'layout-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('\n' + (failures === 0
    ? '版面检查通过：五种宽度下都没有溢出、重叠、塌陷、对比度不足或小点击目标。'
    : `版面检查发现 ${failures} 处问题（明细见 .screens/layout-report.json）。`));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('版面检查失败：' + err.message);
  process.exit(2);
});
