'use strict';

/**
 * 端到端：真起一个服务，指向「假上游」，把「筛模型 → 检测 → 出图 → 落盘 → 历史 → 下载」走一遍。
 *
 * 为什么要连着假上游测：这一整条路上最容易坏的不是某一行代码，而是**接口形状**——
 * model 参数叫错、response_format 位置不对、base64 前缀没剥、下载头缺了。
 * 只有真的发请求才看得出来。
 *
 * 运行：node test/server.test.js
 */

const net = require('node:net');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { eq, ok, not, has, group, report, sleep } = require('./harness.js');

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

/** 假上游没带 Key 会回 401 —— 那也算起来了 */
async function waitUp(url, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 15000);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 401) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(100);
  }
  throw new Error('假上游没起来：' + url);
}

async function post(base, route, body, headers) {
  const res = await fetch(base + route, {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
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
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lanshai-e2e-'));
  const fakePort = await freePort();

  // 环境必须在 require('../server.js') 之前设置好：配置是在模块加载时读的
  process.env.AIG_FAKE_PORT = String(fakePort);
  process.env.AIG_DATA_DIR = dataDir;
  process.env.DEEPSEEK_API_KEY = ['sk', 'fake', '1234567890'].join('-');
  process.env.AI_BASE_URL = `http://127.0.0.1:${fakePort}/v1`;
  delete process.env.AI_FORCE_OFFLINE;
  delete process.env.AI_IMAGE_MODEL;

  const fake = require('../scripts/fake-upstream.js');
  try {
    await waitUp(`http://127.0.0.1:${fakePort}/v1/models`);
    const app = await require('../server.js').start({ port: 0, banner: false });
    const base = `http://127.0.0.1:${app.port}`;

    try {
      console.log('健康检查与预设');

      await group('服务起来了，说明接的是上游', async () => {
        const health = await (await fetch(base + '/api/health')).json();
        eq(health.ok, true, '健康检查通过');
        eq(health.engine.live, true, '标记为接入上游');
        eq(health.engine.keyFrom, 'DEEPSEEK_API_KEY', '说清 Key 来自哪个变量');
        eq(health.presets.ratios.length, 8, '预设跟着健康检查下发');
      });

      await group('预设接口够界面直接渲染', async () => {
        const presets = await (await fetch(base + '/api/presets')).json();
        eq(presets.ok, true, '成功');
        eq(presets.styles.length, 10, '十种风格');
        ok(presets.ratios.every((r) => r.hint && r.sizes['1K'] && r.sizes['4K']), '画幅带构图说明和三档尺寸');
        eq(presets.limits.promptMax, 2000, '描述长度上限');
      });

      console.log('模型筛选（这一步是项目要求的重点）');

      await group('只把「能出图」的模型列出来，向量 / 语音 / 视频 / 聊天全部排除', async () => {
        const out = await (await fetch(base + '/api/models')).json();
        eq(out.ok, true, '取到了');
        eq(out.source, 'upstream', '来源是账号模型列表');
        const ids = out.image.map((m) => m.id);
        eq(ids, [
          'gpt-image-2',
          'gpt-image-1',
          'dall-e-3',
          'dall-e-2',
          'flux-schnell',
          'ideogram-v2',
          'midjourney-v6-image',
          'gemini-2.5-flash-image',
        ], '筛出来的出图模型按偏好排好');
        not(ids.includes('gpt-4o-mini'), '聊天模型不在出图清单里');
        not(ids.includes('whisper-1'), '语音模型不在');
        not(ids.includes('text-embedding-3-small'), '向量模型不在');
        not(ids.includes('sora-1'), '视频模型不在');
        eq(out.counts.all, 16, '原始列表条数也报出来');
        eq(out.counts.image, 8, '能出图的数量');
        eq(out.current, 'gpt-image-2', '默认用配置里的那个');
        eq(out.chat.model, 'gpt-4o-mini', '优化提示词用的聊天模型是 1 token 探活选出来的');
      });

      await group('检测一个坏模型 → 标记调不通，并在清单里单独归组', async () => {
        const bad = await post(base, '/api/models', { model: 'dall-e-2' });
        eq(bad.status, 502, '检测失败（上游 404）');
        eq(bad.data.ok, false, 'ok:false');
        has(bad.data.message, '模型名', '把上游的原因翻出来');

        const out = await (await fetch(base + '/api/models')).json();
        const hit = out.image.find((m) => m.id === 'dall-e-2');
        eq(hit.state, 'unavailable', '界面上会被归到「调不通」');
        eq(out.counts.unavailable, 1, '统计里也算上');
      });

      await group('检测一个好模型 → 已验证', async () => {
        const good = await post(base, '/api/models', { model: 'gpt-image-1' });
        eq(good.status, 200, '检测通过');
        eq(good.data.ok, true, 'ok:true');
        const out = await (await fetch(base + '/api/models')).json();
        eq(out.image.find((m) => m.id === 'gpt-image-1').state, 'verified', '界面上显示已验证');
        eq(out.counts.verified, 1, '已验证数量');
      });

      await group('检测不在清单里的模型会被挡住', async () => {
        const out = await post(base, '/api/models', { model: 'sora-1' });
        eq(out.status, 502, '不允许检测');
        has(out.data.message, '不在当前账号', '说明为什么');
      });

      console.log('出图 → 落盘 → 历史 URL');

      const generated = [];
      await group('出图成功：图片落地、记录带全字段', async () => {
        const out = await post(base, '/api/images/generate', {
          prompt: '雨后的老城区，一个人撑着红伞走过积水',
          styleId: 'cinema',
          size: '1280x720',
          quality: 'low',
          model: 'gpt-image-1',
        });
        eq(out.status, 200, '出图成功');
        eq(out.data.ok, true, 'ok:true');
        eq(out.data.engine, 'live', '走上游');
        const record = out.data.record;
        generated.push(record);
        ok(record.id.startsWith('img_'), '记录 id 形状对');
        eq(record.model, 'gpt-image-1', '模型名存住了');
        eq(record.size.actual, '1280x720', '尺寸存住了');
        eq(record.style.id, 'cinema', '风格存住了');
        eq(record.engine, 'live', '引擎标记');
        ok(record.bytes > 100, '图片有字节数');
        has(record.finalPrompt, 'cinematic', '最终提示词里带上了风格后缀');
      });

      await group('图片能直接取回，也能当附件下载', async () => {
        const record = generated[0];
        const res = await fetch(base + `/api/images/${record.file}`);
        eq(res.status, 200, '图片地址能取');
        eq(res.headers.get('content-type'), 'image/png', 'content-type 对');
        const bytes = Buffer.from(await res.arrayBuffer());
        eq(bytes.subarray(0, 4).equals(PNG_SIG), true, '取回来的是 PNG');

        const dl = await fetch(base + `/api/history/${record.id}/download`);
        eq(dl.status, 200, '下载地址能取');
        has(dl.headers.get('content-disposition') || '', 'attachment', '是附件下载');
        has(decodeURIComponent(dl.headers.get('content-disposition') || ''), 'lan-shai', '文件名有前缀');
        const downloaded = Buffer.from(await dl.arrayBuffer());
        eq(downloaded.equals(bytes), true, '下载到的和页面显示的是同一张');
      });

      await group('上游只给 URL、但那个地址打不开：照样留下这张图，并如实标注', async () => {
        const out = await post(base, '/api/images/generate', {
          prompt: '一只猫，测试图床坏掉的情况',
          styleId: 'photo',
          size: '1024x1024',
          quality: 'low',
          model: 'ideogram-v2',
        });
        eq(out.status, 200, '出图算成功（上游确实生成了、也扣了钱）');
        eq(out.data.remoteOnly, true, '标记为「只有上游链接」');
        const record = out.data.record;
        eq(record.file, '', '没有本地文件');
        ok(String(record.remoteUrl).startsWith('http'), '保留了上游地址');
        has((out.data.notes || []).join('；'), '没存到本地', '备注里说清楚');
        generated.push(record);

        const dl = await fetch(base + `/api/history/${record.id}/download`);
        eq(dl.status, 409, '下载会说清楚为什么不能下');
        const body = await dl.json();
        eq(body.code, 'remote_only', '带上原因码');
        ok(String(body.remoteUrl).startsWith('http'), '把上游地址还给界面');

        const listed = await (await fetch(base + '/api/history')).json();
        ok(listed.items.some((r) => r.id === record.id), '历史里能看见这一张');
      });

      await group('上游只给 URL 的模型：服务端把图下回来自己存', async () => {
        const out = await post(base, '/api/images/generate', {
          prompt: '霓虹雨夜',
          styleId: 'cyberpunk',
          size: '1024x1024',
          quality: 'medium',
          model: 'flux-schnell',
        });
        eq(out.status, 200, '出图成功');
        generated.push(out.data.record);
        ok(String(out.data.record.remoteUrl).startsWith('http'), '记录里留了上游图片地址（方便回头查）');
        const res = await fetch(base + `/api/images/${out.data.record.file}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        eq(bytes.subarray(0, 4).equals(PNG_SIG), true, '下回来的确实是 PNG');
      });

      await group('不认 response_format 的模型：客户端自动重试一次也能出图', async () => {
        const out = await post(base, '/api/images/generate', {
          prompt: '一只白猫坐在窗台上',
          styleId: 'photo',
          size: '1024x1024',
          quality: 'high',
          model: 'dall-e-3',
        });
        eq(out.status, 200, '出图成功');
        generated.push(out.data.record);
        eq(out.data.record.quality, 'hd', 'dall-e-3 的画质被翻译成 hd');
        ok(Array.isArray(out.data.notes), 'notes 是数组');
      });

      await group('选了一个已知调不通的模型：直接说清楚，不偷偷换', async () => {
        const before = (await (await fetch(base + '/api/history')).json()).stats.count;
        const out = await post(base, '/api/images/generate', {
          prompt: '随便什么',
          styleId: 'photo',
          size: '1024x1024',
          model: 'dall-e-2',
        });
        eq(out.status, 400, '拒绝');
        eq(out.data.code, 'model_unavailable', '带上原因码');
        has(out.data.message, '检测', '提示去检测或换模型');
        const after = (await (await fetch(base + '/api/history')).json()).stats.count;
        eq(after, before, '没有留下半张记录');
      });

      await group('选了一个清单外的模型名：退回默认并说明', async () => {
        const out = await post(base, '/api/images/generate', {
          prompt: '清单外的模型',
          styleId: 'minimal',
          size: '1024x1024',
          model: 'totally-unknown-image',
        });
        eq(out.status, 200, '照常出图');
        has(out.data.notes.join('；'), '不在当前账号可出图的模型', '说明换成了哪个');
        generated.push(out.data.record);
      });

      await group('尺寸不被模型支持时，就近替换并写进备注', async () => {
        const out = await post(base, '/api/images/generate', {
          prompt: '横构图的城市',
          styleId: 'film',
          size: '1280x720',
          model: 'dall-e-3',
        });
        eq(out.status, 200, '出图成功');
        eq(out.data.record.size.actual, '1792x1024', 'dall-e-3 换成它支持的那一档');
        has(out.data.notes.join('；'), '三档', '备注里说明换了尺寸');
        generated.push(out.data.record);
      });

      await group('描述太短 / 请求体不是 JSON 都拒掉', async () => {
        const short = await post(base, '/api/images/generate', { prompt: ' ' });
        eq(short.status, 400, '空描述被拒');
        const bad = await fetch(base + '/api/images/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{不是 JSON',
        });
        eq(bad.status, 400, '坏 JSON 被拒');
      });

      console.log('优化提示词');

      await group('用上游聊天模型把一句话扩成详细提示词', async () => {
        const out = await post(base, '/api/prompt/optimize', {
          prompt: '雨后的老城区',
          styleId: 'cinema',
          size: '1280x720',
        });
        eq(out.status, 200, '优化成功');
        eq(out.data.engine, 'live', '走上游');
        eq(out.data.model, 'gpt-4o-mini', '用的是探活出来的聊天模型');
        has(out.data.prompt, 'staged', '拿到的是扩写后的提示词');
        has(out.data.notes, '光线', '带一句中文说明');
        eq(out.data.before, '雨后的老城区', '原文也回传，界面才能「还原」');
      });

      await group('描述太短时提醒，而不是让上游报错', async () => {
        const out = await post(base, '/api/prompt/optimize', { prompt: '' });
        eq(out.status, 400, '拒绝');
        has(out.data.message, '描述', '说人话');
      });

      console.log('历史记录');

      await group('列表、单条、删除、清空', async () => {
        const list = await (await fetch(base + '/api/history?limit=50')).json();
        ok(list.stats.count >= 3, '累计出过好几张');
        eq(list.items.length, Math.min(50, list.stats.count), '列表条数对');
        ok(list.items[0].createdAt >= list.items[1].createdAt, '新的在前');
        ok(list.stats.bytes > 0, '统计里有总大小');

        const id = list.items[0].id;
        const one = await (await fetch(base + `/api/history/${id}`)).json();
        eq(one.record.id, id, '单条取得到');

        const del = await fetch(base + `/api/history/${id}`, { method: 'DELETE' });
        eq(del.status, 200, '删得掉');
        const gone = await fetch(base + `/api/history/${id}`);
        eq(gone.status, 404, '删掉之后就取不到');

        const noConfirm = await fetch(base + '/api/history', { method: 'DELETE' });
        eq(noConfirm.status, 400, '清空必须带 confirm=1');
        const cleared = await (await fetch(base + '/api/history?confirm=1', { method: 'DELETE' })).json();
        ok(cleared.removed >= 2, '清空返回删掉的数量');
        const after = await (await fetch(base + '/api/history')).json();
        eq(after.stats.count, 0, '清干净了');
      });

      console.log('静态文件与同源检查');

      await group('页面能打开，服务端代码不会被取走', async () => {
        const home = await fetch(base + '/');
        eq(home.status, 200, '首页 200');
        has(await home.text(), '蓝晒', '首页是那个页面');

        eq((await fetch(base + '/js/app.js')).status, 200, '前端脚本能取');
        eq((await fetch(base + '/css/styles.css')).status, 200, '样式能取');
        eq((await fetch(base + '/favicon.svg')).status, 200, '图标能取');
        const shared = await fetch(base + '/lib/styles.js');
        eq(shared.status, 200, '前后端共用的 styles.js 能取（界面要用它算尺寸和提示词）');
        eq((await shared.text()).includes('LanShaiStyles'), true, '拿到的确实是共用模块');
        eq((await fetch(base + '/lib/upstream.js')).status, 404, '别的服务端模块取不到');
        eq((await fetch(base + '/lib/store.js')).status, 404, '落盘模块也取不到');
        eq((await fetch(base + '/data/history')).status, 404, '数据目录取不到');
        eq((await fetch(base + '/server.js')).status, 404, 'server.js 取不到');
      });

      await group('跨站发起的写操作被拒绝', async () => {
        const out = await post(base, '/api/images/generate', { prompt: 'x' }, { origin: 'http://evil.example.com' });
        eq(out.status, 403, '跨站被拒');
        has(out.data.message, '跨站', '说明原因');
      });

      await group('没有这个接口就明确 404', async () => {
        const res = await fetch(base + '/api/nope');
        eq(res.status, 404, '404');
      });
    } finally {
      await app.close();
    }
  } finally {
    try {
      fake.server.close();
    } catch {
      /* ignore */
    }
    await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }

  report('server');
})();
