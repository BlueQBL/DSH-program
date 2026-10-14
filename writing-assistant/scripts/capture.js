/* 截图：起一个临时服务，用无头浏览器把「写作台」按几种版面宽度拍下来。
 *
 * 用法：
 *   node scripts/capture.js            # 拍空闲、成稿、朱批、留档四种状态
 *   node scripts/capture.js idle       # 只拍指定状态
 *
 * 为什么要拍：CSS 的错（格线错位、稿片重叠、朱色对比不足）在源码里读不出来，
 * 拍成 PNG 打开一看就知道版面对不对。
 *
 * 为什么走 CDP 而不是 --screenshot：稿片、朱批、留档都是点出来的状态，
 * 一次页面加载拍不到。这里用调试协议真的去点按钮，拍的是用户的真实所见。
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.screens');
const APP_PORT = Number(process.env.WA_SHOT_PORT || 5261);

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 1080 },
  { name: 'mobile', width: 414, height: 900 },
];

const CHROME_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
  path.join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

function findBrowser() {
  const hit = CHROME_CANDIDATES.find((p) => p && fs.existsSync(p));
  if (!hit) throw new Error('没有找到 Chrome 或 Edge，无法截图');
  return hit;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 关掉浏览器：Windows 上 Chrome 会把自己重启成另一个进程，必须整棵树一起收 */
function killTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {});
  } else {
    child.kill('SIGKILL');
  }
}

/** 每次跑都换一个空闲端口：上一次没退干净的浏览器可能还占着旧端口 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 1500 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('超时')));
  });
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await getJson(url);
    } catch {
      await wait(200);
    }
  }
  throw new Error('等不到 ' + url);
}

/* ── 一个极简的 CDP 客户端 ────────────────────────────────── */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let seq = 0;

    ws.addEventListener('open', () =>
      resolve({
        send(method, params, sessionId) {
          seq += 1;
          const id = seq;
          return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
            setTimeout(() => {
              if (pending.has(id)) {
                pending.delete(id);
                rej(new Error(method + ' 超时'));
              }
            }, 20000);
          });
        },
        close() {
          ws.close();
        },
      })
    );
    ws.addEventListener('error', () => reject(new Error('连不上浏览器调试端口')));
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const hit = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) hit.rej(new Error(msg.error.message || '浏览器报错'));
        else hit.res(msg.result);
      }
    });
  });
}

/* ── 每种要拍的状态：怎么把界面点到那个样子 ─────────────── */
const SAMPLE = '周五的复盘会上，产品经理把用户反馈一条条念了出来。念到第七条时，会议室安静了。';
const MESSY = '今天我们进行了一次讨论,大家都觉得这个方案非常非常的重要，需要尽快的落实下去，我们必须要加以重视!!!';

function fill(selector, value, click) {
  return `(() => {
    const box = document.querySelector(${JSON.stringify(selector)});
    box.value = ${JSON.stringify(value)};
    box.dispatchEvent(new Event('input', { bubbles: true }));
    ${click ? `document.querySelector(${JSON.stringify(click)}).click();` : ''}
    return true;
  })()`;
}

const SCENES = {
  idle: {
    label: '空闲',
    async run(cdp, evaluate) {
      await evaluate("document.getElementById('material').value = ''; true");
    },
  },
  drafted: {
    label: '成稿',
    async run(cdp, evaluate) {
      await evaluate(fill('#material', SAMPLE, '#generate'));
      await wait(5600);
    },
  },
  marked: {
    label: '朱批',
    async run(cdp, evaluate) {
      await evaluate(fill('#material', MESSY, '#polish-input'));
      await wait(1800);
    },
  },
  drawer: {
    label: '留档',
    async run(cdp, evaluate) {
      await evaluate(fill('#material', SAMPLE, '#generate'));
      await wait(5600);
      await evaluate("document.getElementById('open-history').click(); true");
      await wait(700);
    },
  },
};

async function shoot(browser, viewport, sceneName) {
  const scene = SCENES[sceneName];
  // 每次都用全新的用户目录：复用同一个目录时，新起的 Chrome 会把命令转交给
  // 上一次没退干净的实例，于是调试端口永远等不到。
  const profile = path.join(OUT, `profile-${viewport.name}-${sceneName}-${process.pid}-${Date.now().toString(36)}`);
  fs.mkdirSync(profile, { recursive: true });
  const debugPort = await freePort();

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--deny-permission-prompts',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${debugPort}`,
    `--window-size=${viewport.width},${viewport.height}`,
    'about:blank',
  ];

  // stdio: 'ignore' 是必须的：捕获子进程输出会走管道，在被限制的环境里会 EPERM
  const child = spawn(browser, args, { stdio: 'ignore' });
  let cdp = null;
  let targetId = '';
  try {
    const version = await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`, 20000);

    // 走浏览器级端点再挂到一个页面上：直接连 /json/list 那个页面端点时，
    // 新版无头 Chrome 对 Page.enable、Emulation.* 这类命令不回应。
    cdp = await connect(version.webSocketDebuggerUrl);
    const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
    targetId = created.targetId;
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const session = attached.sessionId;
    const call = (method, params) => cdp.send(method, params, session);

    await call('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.name === 'mobile',
    });

    const evaluate = async (expression) => {
      const out = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (out.exceptionDetails) throw new Error(out.exceptionDetails.text || '页面脚本出错');
      return out.result && out.result.value;
    };

    await call('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}/` });
    // 等界面装配完成（启动会先异步探活接口）
    for (let i = 0; i < 50; i += 1) {
      const ready = await evaluate('Boolean(document.querySelector(".mode") && document.getElementById("generate"))');
      if (ready) break;
      await wait(200);
    }
    await wait(400);

    await scene.run(cdp, evaluate, call);

    const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const file = path.join(OUT, `${viewport.name}-${sceneName}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    return file;
  } finally {
    if (cdp && targetId) await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    if (cdp) cdp.close();
    killTree(child);
    await wait(300);
  }
}

async function main() {
  const only = process.argv[2];
  const scenes = only ? [only] : Object.keys(SCENES);
  scenes.forEach((name) => {
    if (!SCENES[name]) throw new Error(`没有这种状态：${name}（可选 ${Object.keys(SCENES).join(' / ')}）`);
  });

  fs.mkdirSync(OUT, { recursive: true });

  const server = spawn(process.execPath, [path.join(ROOT, 'server.js'), String(APP_PORT)], {
    cwd: ROOT,
    stdio: 'ignore',
    env: Object.assign({}, process.env, { WA_OFFLINE_SPEED: '6' }),
  });

  try {
    const browser = findBrowser();
    await waitForHttp(`http://127.0.0.1:${APP_PORT}/api/health`, 10000);

    for (const name of scenes) {
      for (const viewport of VIEWPORTS) {
        const file = await shoot(browser, viewport, name);
        console.log(`拍好 ${path.relative(ROOT, file)}  ${viewport.width}×${viewport.height}  ${SCENES[name].label}`);
      }
    }
    console.log('\n截图目录：' + path.relative(ROOT, OUT));
  } finally {
    killTree(server);
  }
}

main().catch((err) => {
  console.error('截图失败：' + err.message);
  process.exit(1);
});
