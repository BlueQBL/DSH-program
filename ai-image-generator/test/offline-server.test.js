'use strict';

/**
 * 没有 Key 时也要能玩：用 `node server.js` 真起一个离线实例，
 * 把「出图 → 落盘 → 历史 → 下载」再走一遍。
 *
 * 这一条路径很重要 —— 大多数人第一次打开项目时手上还没有 Key，
 * 如果那时界面是一片红叉，再好的东西也没人看得见。
 *
 * 运行：node test/offline-server.test.js
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { eq, ok, has, group, report, sleep } = require('./harness.js');

const ROOT = path.join(__dirname, '..');
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

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

async function waitUp(url, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 15000);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(120);
  }
  throw new Error('服务没起来：' + url);
}

function killTree(child) {
  if (!child || child.killed) return;
  // 这个子进程没有自己的子进程，直接 kill 就够；
  // taskkill 是给 Windows 上「有时候 SIGTERM 不生效」留的保险（失败了也不影响收尾）。
  try {
    child.kill('SIGTERM');
  } catch {
    /* 已经退了 */
  }
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {});
    } catch {
      /* taskkill 不可用就算了 */
    }
  }
}

async function post(base, route, body) {
  const res = await fetch(base + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

(async function main() {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lanshai-offline-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), String(port)], {
    cwd: ROOT,
    stdio: 'ignore', // 抓子进程输出在受限环境里会 EPERM，这里也不需要它的日志
    env: Object.assign({}, process.env, {
      AI_FORCE_OFFLINE: '1',
      DEEPSEEK_API_KEY: '',
      OPENAI_HK_API_KEY: '',
      OPENAI_API_KEY: '',
      AIG_DATA_DIR: dataDir,
      HOST: '127.0.0.1',
    }),
  });

  try {
    const base = `http://127.0.0.1:${port}`;
    await waitUp(base + '/api/health');

    console.log('离线模式');

    await group('健康检查如实说：没接上游，用离线显影', async () => {
      const health = await (await fetch(base + '/api/health')).json();
      eq(health.ok, true, '服务活着');
      eq(health.engine.live, false, '没接上游');
      has(health.engine.note, '离线', '说明当前怎么出图');
      eq(health.models.image, 0, '离线时没有上游模型清单');
    });

    await group('模型接口回空列表 + 一句人话（不是报错）', async () => {
      const out = await (await fetch(base + '/api/models')).json();
      eq(out.ok, true, '不是错误');
      eq(out.live, false, 'live:false');
      eq(out.source, 'offline', '来源标成离线');
      eq(out.image, [], '没有模型');
      has(out.note, '离线', '说明原因');
    });

    let record = null;
    await group('出图：离线显影画出一张真的 PNG，并落盘', async () => {
      const out = await post(base, '/api/images/generate', {
        prompt: '雨后的老城区，一个人撑着红伞走过积水',
        styleId: 'cinema',
        size: '1024x768',
        quality: 'low',
      });
      eq(out.status, 200, '出图成功');
      eq(out.data.engine, 'offline', '引擎标记为离线');
      record = out.data.record;
      eq(record.model, '离线显影引擎', '模型一栏写清楚');
      eq(record.size.actual, '1024x768', '尺寸按请求');
      eq(record.width, 1024, '记录了宽');
      ok(record.bytes > 1024, '图片有内容');

      const file = path.join(dataDir, 'images', record.file);
      ok(fs.existsSync(file), '图片文件真的落盘了');
      const head = fs.readFileSync(file).subarray(0, 4);
      eq(head.equals(PNG_SIG), true, '落盘的是 PNG');
    });

    await group('图片能取回，也能当附件下载', async () => {
      const res = await fetch(base + `/api/images/${record.file}`);
      eq(res.status, 200, '取图 200');
      eq(res.headers.get('content-type'), 'image/png', 'content-type 对');
      const bytes = Buffer.from(await res.arrayBuffer());
      eq(bytes.subarray(0, 4).equals(PNG_SIG), true, '是 PNG');

      const dl = await fetch(base + `/api/history/${record.id}/download`);
      eq(dl.status, 200, '下载 200');
      has(dl.headers.get('content-disposition') || '', 'attachment', '是附件');
    });

    await group('离线也一次只出一张：传 n=2 只回 1 张', async () => {
      const out = await post(base, '/api/images/generate', {
        prompt: '同一个小院子的四季',
        styleId: 'film',
        size: '256x256',
        quality: 'low',
        n: 2,
      });
      eq(out.status, 200, '出图成功');
      eq(out.data.records.length, 1, '只有一张（批量已经拆掉）');
      eq(out.data.records[0].batchTotal, undefined, '记录里没有批次字段');
      has((out.data.notes || []).join('；'), '一次只出一张', '备注里说明张数被忽略');
    });

    await group('改图：离线时真的在原图上动手（不是另画一张）', async () => {
      const out = await post(base, '/api/images/edit', {
        prompt: '把色调改成赛博朋克的霓虹',
        styleId: 'cyberpunk',
        size: '1024x768',
        quality: 'low',
        sourceId: record.id,
      });
      eq(out.status, 200, '改图成功');
      const edited = out.data.records[0];
      eq(edited.kind, 'edit', '标记为改图');
      eq(edited.parentId, record.id, '记住了原图');
      has((out.data.notes || []).join('；'), '离线改图', '备注里说明这是离线改图');
      eq(edited.engine, 'offline', '离线引擎');

      const before = Buffer.from(await (await fetch(base + `/api/images/${record.file}`)).arrayBuffer());
      const after = Buffer.from(await (await fetch(base + `/api/images/${edited.file}`)).arrayBuffer());
      eq(after.subarray(0, 4).equals(PNG_SIG), true, '改出来的还是 PNG');
      eq(after.equals(before), false, '内容和原图不一样');
      eq(edited.width, 1024, '宽度保持原图');
      eq(edited.height, 768, '高度保持原图');
    });

    await group('改图：改不了的原图（JPEG）明确说清，而不是给出花屏', async () => {
      const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(128, 7)]);
      const out = await post(base, '/api/images/edit', {
        prompt: '改一下',
        styleId: 'photo',
        size: '512x512',
        sourceB64: 'data:image/jpeg;base64,' + jpeg.toString('base64'),
      });
      eq(out.status, 400, '拒绝');
      eq(out.data.code, 'offline_edit_unsupported', '带上原因码');
      has(out.data.message, 'PNG', '说清离线只支持 PNG');
    });

    await group('预设与社区在离线模式下也能用', async () => {
      const saved = await post(base, '/api/presets/saved', {
        preset: { name: '离线配方', styleId: 'film', ratio: '4:3', tier: '1K', quality: 'low' },
      });
      eq(saved.status, 200, '预设存得下');
      eq(saved.data.saved.length, 1, '列表里有一条');

      const shared = await post(base, '/api/community', { recordId: record.id, author: '离线的小飞' });
      eq(shared.status, 200, '分享得上去');
      const list = await (await fetch(base + '/api/community')).json();
      eq(list.items.length, 1, '社区里有一张');
      eq(list.items[0].author, '离线的小飞', '署名对');
    });

    await group('优化提示词走离线扩写，也给出更具体的东西', async () => {
      const out = await post(base, '/api/prompt/optimize', {
        prompt: '一只白猫',
        styleId: 'watercolor',
        size: '1024x1024',
      });
      eq(out.status, 200, '成功');
      eq(out.data.engine, 'offline', '离线');
      eq(out.data.model, '离线扩写', '标明是离线扩写');
      has(out.data.prompt, '一只白猫', '原描述保留');
      has(out.data.prompt, 'watercolor', '带上了风格');
      ok(out.data.prompt.length > '一只白猫'.length + 60, '确实扩写了');
      has(out.data.notes, '离线', '说明这是离线扩写');
    });

    await group('历史记录里能看到这一张，统计也对', async () => {
      const out = await (await fetch(base + '/api/history')).json();
      ok(out.stats.count >= 3, `记录数对得上（${out.stats.count} 张：出图 + 一次一张 + 改图）`);
      ok(out.items.some((r) => r.id === record.id), '最初那张还在列表里');
      ok(out.stats.bytes > 0, '总大小有数');
      const one = await (await fetch(base + `/api/history/${record.id}`)).json();
      eq(one.record.prompt, '雨后的老城区，一个人撑着红伞走过积水', '描述存住了');
      eq(one.record.style.id, 'cinema', '风格存住了');
    });

    await group('删掉之后记录和文件一起消失', async () => {
      const del = await fetch(base + `/api/history/${record.id}`, { method: 'DELETE' });
      eq(del.status, 200, '删除成功');
      const after = await (await fetch(base + '/api/history')).json();
      ok(!after.items.some((r) => r.id === record.id), '列表里没有它了');
      ok(!fs.existsSync(path.join(dataDir, 'images', record.file)), '图片文件也删了');
    });

    await group('离线时也挡住跨站写操作', async () => {
      const res = await fetch(base + '/api/images/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://evil.example.com' },
        body: JSON.stringify({ prompt: '随便' }),
      });
      eq(res.status, 403, '跨站被拒');
    });
  } finally {
    killTree(child);
    await sleep(400);
    // 万一没杀干净，也别让这个测试进程一直挂着等它
    try {
      child.unref();
    } catch {
      /* ignore */
    }
    await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }

  report('offline-server');
})();
