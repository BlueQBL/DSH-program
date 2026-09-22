'use strict';

/**
 * 开发用：只检查"窄窗口下打印会不会整页空白"这一件事，跑得快。
 *   node scripts/print-probe.js
 *
 * 背景：headless Chrome 的 --print-to-pdf 在窄窗口（900 / 390）下会把整页印成空白，
 * 1440 宽正常。要分清是样式的问题还是应用的问题，所以拿一张不跑 JS 的金丝雀页对照。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const CHROME = process.env.CHROME_PATH ||
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe');
const PORT = Number(process.env.PORT || 5220);
const BASE = 'http://127.0.0.1:' + PORT + '/';
const OUT = path.join(__dirname, '..', '.screens');
const { extractText } = require('./pdf-text.js');

function reachable(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function printOnce(url, file, w, h) {
  return new Promise((resolve) => {
    const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'mdprint-'));
    const child = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--disable-crash-reporter', '--disable-breakpad',
      '--user-data-dir=' + prof,
      '--window-size=' + w + ',' + h,
      '--virtual-time-budget=4000',
      '--print-to-pdf=' + file,
      url,
    ], { stdio: 'ignore' });
    child.on('exit', () => resolve(true));
    child.on('error', () => resolve(false));
  });
}

(async () => {
  if (!(await reachable(BASE))) {
    console.error('先起服务：node server.js ' + PORT);
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });

  const targets = [
    { name: '金丝雀页（无 JS）', url: BASE + 'scripts/print-canary.html' },
    { name: '应用首页', url: BASE },
  ];

  for (const target of targets) {
    for (const size of [[1440, 900], [1000, 900], [900, 1000], [390, 844]]) {
      const file = path.join(OUT, 'probe-' + (target.name === '应用首页' ? 'app' : 'canary') + '-' + size[0] + '.pdf');
      await printOnce(target.url, file, size[0], size[1]);
      const info = fs.existsSync(file) ? extractText(fs.readFileSync(file)) : null;
      const chars = info ? info.pages.join('').replace(/\s/g, '').length : 0;
      console.log('  ' + target.name + ' @ ' + size[0] + '宽：' + (info ? info.pages.length : 0) +
        ' 段 · ' + chars + ' 字' + (chars < 60 ? '  ✗ 基本是空白' : '  ✓'));
    }
  }
})();
