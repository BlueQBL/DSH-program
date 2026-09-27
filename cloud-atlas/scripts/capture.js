/* 截图：起一个临时服务，用无头 Chrome 把页面按几种版面宽度拍下来
 *
 * 用法：
 *   node scripts/capture.js                        # 默认拍北京（跳过定位）
 *   node scripts/capture.js "?city=杭州&unit=f"    # 换城市、换单位
 *
 * 为什么要拍：CSS 的错（重叠、溢出、配色对比不足）在源码里读不出来。
 * 拍完用 scripts/inspect-shot.js 把 PNG 转成字符画，就能在终端里"看"版面对不对。
 *
 * 说明：这个脚本会真的访问上游接口取天气，因为要验证的是"真实数据下的版面"。
 * 如果没有网络，页面会显示错误横幅——那也是一种需要被看到的真实状态。
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.screens');
const PORT = Number(process.env.SHOT_PORT || 5240);

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 1200 },
  { name: 'laptop', width: 1120, height: 1100 },
  { name: 'mobile', width: 414, height: 1000 },
];

const CHROME_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
  path.join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
];

function findBrowser() {
  const hit = CHROME_CANDIDATES.find((p) => p && fs.existsSync(p));
  if (!hit) throw new Error('没有找到 Chrome 或 Edge，无法截图');
  return hit;
}

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

async function shoot(browser, viewport, query, suffix) {
  const file = path.join(OUT, `${viewport.name}${suffix}.png`);
  const url = `http://127.0.0.1:${PORT}/${query}`;
  const profile = path.join(OUT, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    // 必须给独立的用户目录：不指定时 Chrome 会去用正在运行的个人配置，
    // 要么被占用起不来，要么把用户的浏览器窗口搅乱。
    `--user-data-dir=${profile}`,
    `--window-size=${viewport.width},${viewport.height}`,
    // 定位在无头环境里必被拒绝，这里直接拒掉，省掉等待授权的时间
    '--deny-permission-prompts',
    // 给页面足够的时间走完：取地名 → 取天气 → 渲染曲线
    '--virtual-time-budget=12000',
    `--screenshot=${file}`,
    url,
  ];

  await new Promise((resolve, reject) => {
    // stdio: 'ignore' 是必须的：捕获子进程输出会走管道，在被限制的环境里会 EPERM。
    // 截图直接写文件，本来也不需要读它的 stdout。
    const child = spawn(browser, args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 || code === null ? resolve() : reject(new Error(`浏览器退出码 ${code}`))));
  });

  if (!fs.existsSync(file)) throw new Error('浏览器没有写出截图 ' + file);
  return file;
}

async function main() {
  const query = process.argv[2] || '?nolocate=1';
  const suffix = process.argv[3] ? '-' + process.argv[3] : '';

  fs.mkdirSync(OUT, { recursive: true });

  const server = spawn(process.execPath, [path.join(ROOT, 'server.js'), String(PORT)], {
    cwd: ROOT,
    stdio: 'ignore',
  });

  let browser = null;
  try {
    browser = findBrowser();
    if (!(await waitForServer(8000))) throw new Error(`服务没能在 http://127.0.0.1:${PORT} 起来`);

    const files = [];
    for (const vp of VIEWPORTS) {
      const file = await shoot(browser, vp, query, suffix);
      files.push(file);
      console.log(`拍好 ${path.relative(ROOT, file)}  ${vp.width}×${vp.height}`);
    }

    console.log('\n看图：node scripts/inspect-shot.js .screens/desktop' + suffix + '.png');
    console.log('查版面：node scripts/verify-layout.js  （会自己起服务）');
  } finally {
    server.kill();
  }
}

main().catch((err) => {
  console.error('截图失败：' + err.message);
  process.exit(1);
});
