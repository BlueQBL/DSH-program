/*!
 * 蓝晒 · AI 图片生成器 —— 截图（scripts/capture.js）
 *
 * 起「假上游 + 应用」两个进程，用无头浏览器把界面按几种状态真的点出来、拍下来。
 * 为什么要这样拍：版面错位、相纸齿孔对不齐、显影动画压住文字这类问题，
 * 读 CSS 是看不出来的，拍成 PNG 打开一看就知道。
 *
 * 用法：
 *   node scripts/capture.js            # 拍全部状态
 *   node scripts/capture.js idle       # 只拍一种
 *
 * 产物在 .screens/（已在 .gitignore 里）。
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.screens');

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 1000 },
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

function killTree(child) {
  if (!child || child.killed) return;
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {});
    } catch {
      /* ignore */
    }
  }
}

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
    const req = require('node:http').get(url, { timeout: 2000 }, (res) => {
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
  let last = null;
  while (Date.now() < deadline) {
    try {
      return await getJson(url);
    } catch (err) {
      last = err;
      await wait(200);
    }
  }
  throw new Error('等不到 ' + url + (last ? `（${last.message}）` : ''));
}

/* ── 极简 CDP 客户端 ─────────────────────────────────────── */
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
            }, 30000);
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

/* ── 要拍的几个状态 ─────────────────────────────────────── */

const SAMPLE = '雨后的老城区，一个人撑着红伞走过积水，路灯刚亮';
const SAMPLE2 = '窗台上打盹的白猫，午后斜射进来的光';

const SCENES = {
  idle: {
    label: '空闲',
    full: true,
    async run(api) {
      await api.evaluate('document.getElementById("prompt").focus(); true');
    },
  },
  developed: {
    label: '出图',
    full: true,
    async run(api) {
      await api.evaluate(`(() => {
        const box = document.getElementById('prompt');
        box.value = ${JSON.stringify(SAMPLE)};
        box.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('generate').click();
        return true;
      })()`);
      await api.waitFor('!!document.querySelector(".frame:not(.frame--developing) img")', 40000, '第一张出来');
      await wait(900);
    },
  },
  verified: {
    label: '检测模型',
    full: false,
    async run(api) {
      // 检测前会弹一次「要花额度，继续吗」；无头浏览器里把它当成「确认」
      await api.evaluate('window.confirm = () => true; true');
      await api.evaluate('document.getElementById("verify-model").click(); true');
      await api.waitFor('document.getElementById("toast") && !document.getElementById("toast").hidden', 30000, '检测结果吐司');
      await wait(500);
    },
  },
  optimized: {
    label: '优化提示词',
    full: false,
    async run(api) {
      await api.evaluate(`(() => {
        const box = document.getElementById('prompt');
        box.value = ${JSON.stringify(SAMPLE2)};
        box.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('optimize').click();
        return true;
      })()`);
      await api.waitFor('document.querySelector("#revert-prompt") && !document.querySelector("#revert-prompt").hidden', 30000, '扩写完成');
      await wait(400);
    },
  },
  drawer: {
    label: '历史',
    full: false,
    async run(api) {
      await api.evaluate(`(() => {
        const box = document.getElementById('prompt');
        box.value = ${JSON.stringify(SAMPLE)};
        box.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('generate').click();
        return true;
      })()`);
      await api.waitFor('!!document.querySelector(".frame:not(.frame--developing) img")', 40000, '出图');
      await wait(300);
      await api.evaluate('document.getElementById("open-history").click(); true');
      await api.waitFor('!!document.querySelector(".hist")', 15000, '历史列表');
      await wait(500);
    },
  },
  viewer: {
    label: '看大图',
    full: false,
    async run(api) {
      await api.evaluate(`(() => {
        const box = document.getElementById('prompt');
        box.value = ${JSON.stringify(SAMPLE)};
        box.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('generate').click();
        return true;
      })()`);
      await api.waitFor('!!document.querySelector(".frame .frame__image img")', 40000, '出图');
      await wait(300);
      await api.evaluate('document.querySelector(".frame .frame__image").click(); true');
      await api.waitFor('!document.getElementById("viewer").hidden', 10000, '看大图打开');
      await wait(700);
    },
  },
};

async function shoot(browser, viewport, sceneName, appPort) {
  const scene = SCENES[sceneName];
  // 每次都换一个用户目录：复用会让新起的 Chrome 把命令转交给上一次没退干净的实例
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

  const child = spawn(browser, args, { stdio: 'ignore' });
  let cdp = null;
  let targetId = '';
  try {
    const version = await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`, 25000);
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

    const api = {
      async evaluate(expression) {
        const out = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (out.exceptionDetails) throw new Error(out.exceptionDetails.text || '页面脚本出错');
        return out.result && out.result.value;
      },
      async waitFor(expression, timeoutMs, label) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (await api.evaluate(`Boolean(${expression})`)) return true;
          await wait(150);
        }
        throw new Error('等不到：' + (label || expression));
      },
      wait,
    };

    await call('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
    // 等界面装配好（启动会先异步取健康检查、模型、历史）
    await api.waitFor('!!document.getElementById("model-select") && document.querySelectorAll("#style-group .chip").length > 0', 20000, '界面装好');
    await wait(600);

    await scene.run(api);

    const shot = await call('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: scene.full !== false,
    });
    const file = path.join(OUT, `${viewport.name}-${sceneName}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    return file;
  } finally {
    if (cdp && targetId) await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    if (cdp) cdp.close();
    killTree(child);
    await wait(300);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

async function main() {
  const only = process.argv[2];
  const scenes = only ? [only] : Object.keys(SCENES);
  scenes.forEach((name) => {
    if (!SCENES[name]) throw new Error(`没有这种状态：${name}（可选 ${Object.keys(SCENES).join(' / ')}）`);
  });

  fs.mkdirSync(OUT, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanshai-shot-'));
  const fakePort = await freePort();
  const appPort = await freePort();

  const browser = findBrowser();

  // 先起假上游（stdout 丢掉：抓子进程输出在受限环境里会 EPERM）
  const fake = spawn(process.execPath, [path.join(ROOT, 'scripts', 'fake-upstream.js'), String(fakePort)], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  // 再起应用，指向假上游
  const app = spawn(process.execPath, [path.join(ROOT, 'server.js'), String(appPort)], {
    cwd: ROOT,
    stdio: 'ignore',
    env: Object.assign({}, process.env, {
      AI_FORCE_OFFLINE: '',
      DEEPSEEK_API_KEY: ['sk', 'fake', 'local', 'capture'].join('-'),
      AI_BASE_URL: `http://127.0.0.1:${fakePort}/v1`,
      AIG_DATA_DIR: dataDir,
      HOST: '127.0.0.1',
    }),
  });

  try {
    await waitForHttp(`http://127.0.0.1:${appPort}/api/health`, 20000);

    for (const name of scenes) {
      for (const viewport of VIEWPORTS) {
        const file = await shoot(browser, viewport, name, appPort);
        console.log(`拍好 ${path.relative(ROOT, file)}  ${viewport.width}×${viewport.height}  ${SCENES[name].label}`);
      }
    }
    console.log('\n截图目录：' + path.relative(ROOT, OUT));
  } finally {
    killTree(fake);
    killTree(app);
    await wait(400);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('截图失败：' + err.message);
  process.exit(1);
});
