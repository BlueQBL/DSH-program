/**
 * 开发用截图脚本（不是站点的一部分）
 *
 * 用本机 Chrome 把页面整页拍下来，方便对着图检查视觉：
 *   node scripts/shots.js            → 桌面 / 手机 / 浅色 三张，写到 .screens/
 *   CHROME_PATH=... node scripts/shots.js
 *
 * 注：整页截图会拍到首屏以下的区域，那些节点本来要滚动才显示，
 * 所以 URL 上带 ?reveal=all 让它们直接显示。
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = process.env.CHROME_PATH || '';
const OUT = path.join(__dirname, '..', '.screens');
const PORT = 5411 + Math.floor(Math.random() * 100);

const shots = [
  { name: 'desktop-dark', w: 1440, h: 1050, theme: 'dark' },
  { name: 'desktop-light', w: 1440, h: 1050, theme: 'light' },
  { name: 'tablet-dark', w: 834, h: 1112, theme: 'dark' },
  { name: 'mobile-dark', w: 390, h: 844, theme: 'dark' },
];

function shoot(s, port) {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-shot-'));
    const file = path.join(OUT, `${s.name}.png`);

    const child = spawn(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-crash-reporter',
        '--disable-breakpad',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        `--window-size=${s.w},${s.h}`,
        '--virtual-time-budget=5000',
        '--screenshot=' + file,
        `--user-data-dir=${path.join(dir, 'profile')}`,
        `--crash-dumps-dir=${path.join(dir, 'crash')}`,
        `http://127.0.0.1:${port}/?reveal=all&theme=${s.theme}`,
      ],
      { stdio: 'ignore' }
    );

    child.on('close', () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
      resolve(file);
    });
  });
}

(async function main() {
  if (!CHROME) {
    console.error('请用 CHROME_PATH 指定 chrome.exe 路径');
    process.exit(1);
  }

  fs.mkdirSync(OUT, { recursive: true });
  const { createServer } = require(path.join(__dirname, '..', 'server.js'));
  const server = createServer();

  await new Promise((res) => server.listen(PORT, '127.0.0.1', res));
  try {
    for (const s of shots) {
      const file = await shoot(s, PORT);
      const ok = fs.existsSync(file);
      console.log(
        `${ok ? '✓' : '✗'} ${s.name.padEnd(8)} ${s.w}×${s.h}  ${ok ? fs.statSync(file).size + ' bytes' : '失败'}  ${file}`
      );
    }
  } finally {
    server.close();
  }
})();
