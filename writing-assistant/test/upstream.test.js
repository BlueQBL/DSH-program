'use strict';

/**
 * 真实模型链路的端到端测试：起一个「假的 OpenAI 兼容上游」，把本项目的服务端
 * 指过去，然后按真实 HTTP 打进来。
 *
 * 为什么要有这个文件：离线引擎的测试再多，也证明不了「接上真实模型以后能不能用」。
 * 这里覆盖的是平时最容易出问题、又最难手工复现的那几段：
 *   · 启动探测（默认模型在中转平台上不存在时能不能自己找到能用的）
 *   · 模型列表过滤与页面选择是否真的传到了上游
 *   · SSE 流式拼接
 *   · 一键优化的 JSON 返回与朱批落位
 *   · 单稿失败时退回离线引擎、不整批失败
 *
 * 运行：node test/upstream.test.js
 */

const assert = require('assert');
const http = require('node:http');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const Polisher = require('../lib/polisher.js');

let pass = 0;
const failures = [];

function eq(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected);
    pass += 1;
  } catch {
    failures.push(`${label}\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`);
  }
}

function ok(value, label) {
  eq(Boolean(value), true, label);
}

async function group(name, fn) {
  const before = failures.length;
  try {
    await fn();
  } catch (err) {
    failures.push(`${name} 抛异常：${err.message}`);
  }
  console.log(`  ${failures.length === before ? '✓' : '✗'} ${name}`);
}

/* ── 假的 OpenAI 兼容上游 ───────────────────────────────── */
const UPSTREAM_MODELS = [
  'text-embedding-3-small',
  'whisper-1',
  'dall-e-3',
  'gpt-4o-mini',
  'claude-3-5-sonnet-20241022',
  'qwen-max',
  'qwen-leaky',        // 出错时会把 Authorization 原样回带（真实平台也这么干过）
  'gpt-4o-broken',     // 专门用来测「模型挂了」的降级路径
];

const REWRITE_REPLY = {
  polished: '今天我们讨论了一次，大家都觉得这个方案非常重要，需要尽快落实下去。',
  rewrites: [
    { before: '进行了一次讨论', after: '讨论了一次', type: 'redundant', reason: '去掉多余的进行' },
    { before: '非常非常的重要', after: '非常重要', type: 'tone', reason: '程度副词堆叠' },
    { before: ',', after: '，', type: 'punct', reason: '中文里用全角标点' },
  ],
};

const PROSE = '会议室安静了三秒，然后有人把笔记本合上了。真正的问题不是没人说话，是没人知道该由谁先说。';

function createFakeUpstream() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({
        path: req.url.split('?')[0],
        model: body.model || '',
        stream: Boolean(body.stream),
        responseFormat: body.response_format ? body.response_format.type : '',
        auth: req.headers.authorization || '',
      });

      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: UPSTREAM_MODELS.map((id) => ({ id, object: 'model' })) }));
        return;
      }

      if (body.model === 'gpt-4o-broken') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'internal error' } }));
        return;
      }

      // 把请求头原样回带进错误体：这是真实存在过的平台行为，用来验证我方会脱敏
      if (body.model === 'qwen-leaky') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: 'invalid api key', authorization: req.headers.authorization, hint: '请更换 Key 后重试' },
          })
        );
        return;
      }

      // 真实平台对不存在的模型名会回 404，这里也照做，
      // 否则「默认模型不在平台上」这条最常踩的路根本测不到
      if (body.model && !UPSTREAM_MODELS.includes(body.model)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'model not found', code: 'model_not_found' } }));
        return;
      }

      // 一键优化：不流式，返回 JSON 文本
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(REWRITE_REPLY) } }] }));
        return;
      }

      // 起稿：流式返回，分三段吐出来
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const pieces = [PROSE.slice(0, 20), PROSE.slice(20, 40), PROSE.slice(40)];
      pieces.forEach((p) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`));
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return { server, calls };
}

function parseSse(text) {
  const events = [];
  text.split('\n\n').forEach((frame) => {
    if (!frame.trim()) return;
    let event = '';
    const data = [];
    frame.split(/\r?\n/).forEach((line) => {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    });
    if (!event || !data.length) return;
    try {
      events.push({ event, data: JSON.parse(data.join('\n')) });
    } catch {
      /* 不是 JSON 的帧丢掉 */
    }
  });
  return events;
}

(async function main() {
  const DATA_DIR = path.join(os.tmpdir(), 'wa-upstream-test-' + process.pid + '-' + Date.now());
  const upstream = createFakeUpstream();
  await new Promise((r) => upstream.server.listen(0, '127.0.0.1', r));
  const upstreamPort = upstream.server.address().port;

  // 这些必须在 require server.js 之前设好：配置在模块加载时读取
  process.env.WA_DATA_DIR = DATA_DIR;
  process.env.WA_OFFLINE_SPEED = '0';
  process.env.WA_OFFLINE_CHUNK = '200';
  process.env.AI_PROBE_TIMEOUT_MS = '4000';
  process.env.DEEPSEEK_API_KEY = 'test-key-not-real';   // 明显是假的：不能让仓库扫描器把它当成真 Key
  process.env.AI_BASE_URL = `http://127.0.0.1:${upstreamPort}/v1`;
  process.env.AI_MODEL = 'deepseek-chat';   // 故意用一个假上游没有的模型名
  delete process.env.AI_FORCE_OFFLINE;

  const { start } = require('../server.js');
  const app = await start({ port: 0, banner: false });
  const base = app.url.replace(/\/$/, '');
  console.log(`真实模型链路（假上游 :${upstreamPort} → 本项目 :${app.port}）`);

  async function post(url, body) {
    const res = await fetch(base + url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  async function sse(url, body) {
    const res = await fetch(base + url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status !== 200) return { status: res.status, events: [] };
    return { status: 200, events: parseSse(await res.text()) };
  }

  await group('启动探测：默认模型不存在时，自己找到能用的那个', async () => {
    eq(app.probe.ok, true, '探测成功');
    eq(app.probe.model, 'gpt-4o-mini', '挑中了排名最前的可用聊天模型');
    eq(app.models.resolved, 'gpt-4o-mini', '注册表记住了它');
    ok(upstream.calls.some((c) => c.model === 'deepseek-chat' && c.stream === false), '确实试过默认模型');
    ok(upstream.calls.length >= 2, '试完默认模型又试了别的');
  });

  await group('健康检查：带上当前模型与上游规模', async () => {
    const data = await (await fetch(base + '/api/health')).json();
    eq(data.engine.live, true, '走真实模型');
    eq(data.engine.model, 'gpt-4o-mini', '当前模型是探测出来的那个');
    eq(data.engine.verified, true, '标记为已实测');
    eq(data.models.total, 8, '上游一共 8 个模型');
    eq(data.models.chat, 5, '其中可写字的 5 个');
    eq(data.engine.baseUrl, `http://127.0.0.1:${upstreamPort}/v1`, '带上游地址');
  });

  await group('模型列表：过滤掉不能写字的，并按适合写作的顺序排', async () => {
    const data = await (await fetch(base + '/api/models')).json();
    eq(data.ok, true, '取到了');
    eq(data.live, true, '是真实模型模式');
    eq(data.default, 'deepseek-chat', '配置里的默认模型');
    eq(data.current, 'gpt-4o-mini', '当前实际使用的模型');
    eq(data.total, 8, '总数');
    eq(
      data.models,
      ['gpt-4o-broken', 'gpt-4o-mini', 'claude-3-5-sonnet-20241022', 'qwen-max', 'qwen-leaky'],
      // qwen-max 命中的是「qwen-<档位>」这条更具体的规则，排在泛化的 qwen 规则前面
      '列表已过滤并排序'
    );
    ok(!data.models.includes('whisper-1'), '语音模型不在列表里');
    ok(!data.models.includes('text-embedding-3-small'), '向量模型不在列表里');
  });

  await group('起稿：SSE 流式来自真实上游，拼接结果与最终稿一致', async () => {
    const out = await sse('/api/generate', {
      params: { mode: 'continue', length: 'short', versions: 2 },
      material: { input: '会议室安静了三秒。' },
    });
    eq(out.status, 200, '状态码 200');
    const meta = out.events.find((e) => e.event === 'meta');
    eq(meta.data.engine, 'live', '标记为真实模型');
    eq(meta.data.model, 'gpt-4o-mini', '用的是页面默认模型');
    const done = out.events.find((e) => e.event === 'done').data;
    eq(done.engine, 'live', '结果也标记为真实模型');
    eq(done.versions.length, 2, '两稿都成了');
    eq(done.versions[0].text, PROSE, '正文来自上游');
    const glued = {};
    out.events
      .filter((e) => e.event === 'delta')
      .forEach((e) => {
        glued[e.data.version] = (glued[e.data.version] || '') + e.data.text;
      });
    eq(glued[0], PROSE, '逐字推的内容拼起来就是正文');
    eq(done.versions[0].engine, 'live', '这一稿标明来自模型');
  });

  await group('起稿：一次多稿是多个并发请求，各带自己的角度提示', async () => {
    upstream.calls.length = 0;
    const out = await sse('/api/generate', {
      params: { mode: 'copywriting', length: 'short', versions: 3, fields: { platform: 'xiaohongshu' } },
      material: { input: '一款折叠电煮锅' },
    });
    const done = out.events.find((e) => e.event === 'done').data;
    eq(done.versions.length, 3, '三稿');
    const streamCalls = upstream.calls.filter((c) => c.stream);
    eq(streamCalls.length, 3, '上游收到了三次流式请求');
    eq(new Set(streamCalls.map((c) => c.model)).size, 1, '三稿用的是同一个模型');
    ok(upstream.calls.every((c) => c.auth === 'Bearer test-key-not-real'), '带上了 API Key');
  });

  await group('页面上选的模型会真的传到上游', async () => {
    upstream.calls.length = 0;
    const out = await sse('/api/generate', {
      params: { mode: 'continue', length: 'short', versions: 1 },
      material: { input: '会议室安静了三秒。' },
      model: 'qwen-max',
    });
    const meta = out.events.find((e) => e.event === 'meta').data;
    eq(meta.model, 'qwen-max', '反馈给页面的是选中的模型');
    eq(meta.modelNote, '', '没有额外说明');
    ok(upstream.calls.some((c) => c.stream && c.model === 'qwen-max'), '上游收到的就是 qwen-max');
  });

  await group('选了列表外的模型：退回默认并在界面上说明', async () => {
    upstream.calls.length = 0;
    const out = await sse('/api/generate', {
      params: { mode: 'continue', length: 'short', versions: 1 },
      material: { input: '会议室安静了三秒。' },
      model: 'gpt-5-ultra',
    });
    const meta = out.events.find((e) => e.event === 'meta').data;
    eq(meta.model, 'gpt-4o-mini', '退回默认模型');
    ok(meta.modelNote.includes('gpt-5-ultra') && meta.modelNote.includes('已改用'), '说明换了哪个');
    ok(!upstream.calls.some((c) => c.model === 'gpt-5-ultra'), '不会拿一个不存在的模型去撞上游');
  });

  await group('某一稿上游失败：只退那一稿，其他稿照常出', async () => {
    upstream.calls.length = 0;
    const out = await sse('/api/generate', {
      params: { mode: 'continue', length: 'short', versions: 2 },
      material: { input: '会议室安静了三秒。' },
      model: 'gpt-4o-broken',   // 这个模型假上游会返回 500
    });
    const notes = out.events.filter((e) => e.event === 'version-note');
    eq(notes.length, 2, '每一稿都有一条说明');
    ok(notes[0].data.message.includes('离线引擎补上'), '如实说明退回了离线引擎');
    ok(notes[0].data.message.includes('上游'), '说明了原因来自上游');
    const done = out.events.find((e) => e.event === 'done').data;
    eq(done.versions.length, 2, '仍然出了两稿');
    ok(done.versions.every((v) => v.text.length > 100), '退回后内容依然完整');
    eq(done.failed.length, 0, '不算失败');
  });

  await group('一键优化：走真实上游的 JSON 返回，朱批能落位也能全采纳', async () => {
    upstream.calls.length = 0;
    const MESSY = '今天我们进行了一次讨论,大家都觉得这个方案非常非常的重要，需要尽快落实下去。';
    const out = await post('/api/polish', { text: MESSY, model: 'qwen-max' });
    eq(out.status, 200, '状态码 200');
    eq(out.json.engine, 'live', '来自真实模型');
    eq(out.json.model, 'qwen-max', '用的是选中的模型');
    eq(out.json.polished, REWRITE_REPLY.polished, '润色稿就是上游给的那份');
    ok(out.json.edits.length >= 2, `挑出了 ${out.json.edits.length} 处改动`);
    eq(out.json.changed, true, '标记为有改动');
    const accepted = new Set(out.json.edits.map((e) => e.id));
    eq(Polisher.applyEdits(MESSY, out.json.edits, accepted), REWRITE_REPLY.polished, '全部采纳等于润色稿');
    eq(Polisher.applyEdits(MESSY, out.json.edits, []), MESSY, '一条都不采纳等于原文');
    ok(upstream.calls.some((c) => c.responseFormat === 'json_object'), '请求里要求了 JSON 输出');
  });

  await group('一键优化：上游挂了就退回离线校对，并说明原因', async () => {
    const out = await post('/api/polish', { text: '这句话需要校对一下,非常非常的重要。', model: 'gpt-4o-broken' });
    eq(out.status, 200, '状态码 200');
    eq(out.json.engine, 'offline', '退回离线');
    ok(out.json.note.includes('离线校对'), '说明退回了离线');
    ok(out.json.edits.length >= 1, '离线也给出了改动');
  });

  await group('上游把 API Key 回带进错误体时，界面上也看不到它', async () => {
    // 关键：错误正文是要给用户看的（否则没法排查），但里面绝不能带 Key
    const out = await sse('/api/generate', {
      params: { mode: 'continue', length: 'short', versions: 1 },
      material: { input: '会议室安静了三秒。' },
      model: 'qwen-leaky',
    });
    const notes = out.events.filter((e) => e.event === 'version-note');
    eq(notes.length, 1, '有一条失败说明');
    const message = notes[0].data.message;
    ok(!message.includes('test-key-not-real'), 'Key 没有出现在给用户看的说明里');
    ok(!message.includes('Bearer sk-'), 'Bearer 后面的东西也被抹掉了');
    ok(message.includes('API Key'), '但仍然说清了是 Key 的问题');
    ok(message.includes('离线引擎补上'), '并说明已经用离线引擎兜住');

    const done = out.events.find((e) => e.event === 'done').data;
    eq(done.versions.length, 1, '仍然出了一稿');
    ok(!JSON.stringify(out.events).includes('test-key-not-real'), '整条 SSE 流里都找不到 Key');

    // 一键优化走的是同一条错误通道，同样不能漏
    const polish = await post('/api/polish', { text: '这句话需要校对一下,非常非常的重要。', model: 'qwen-leaky' });
    ok(!JSON.stringify(polish.json).includes('test-key-not-real'), '一键优化的响应里也找不到 Key');
  });

  await group('逐个接口扫一遍：任何响应里都不会出现 API Key', async () => {
    const KEY = 'test-key-not-real';
    const bodies = [];
    const blocked = [];

    const gets = [
      '/api/health',
      '/api/models',
      '/api/engine/test',
      '/api/history',
      '/api/history/export?format=md',
      '/api/history/export?format=json',
      // 浏览器能直接取到的文件也一起扫：前端本来就不该有 Key
      '/',
      '/index.html',
      '/js/app.js',
      '/js/api.js',
      '/js/core.js',
      '/css/styles.css',
      '/lib/modes.js',
      '/lib/record.js',
      '/lib/polisher.js',
      '/lib/mock-writer.js',
      // 服务端专用代码：应当取不到
      '/server.js',
      '/lib/llm.js',
      '/lib/store.js',
    ];
    for (const path of gets) {
      const res = await fetch(base + path);
      const text = await res.text();
      if (res.status === 403) blocked.push(path);
      bodies.push([path, text]);
    }

    const gen = await fetch(base + '/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        params: { mode: 'continue', length: 'short', versions: 1 },
        material: { input: '会议室安静了三秒。' },
      }),
    });
    bodies.push(['/api/generate (SSE)', await gen.text()]);

    const pol = await fetch(base + '/api/polish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '这句话需要校对一下,非常非常的重要。' }),
    });
    bodies.push(['/api/polish', await pol.text()]);

    const saved = await fetch(base + '/api/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        record: { mode: 'outline', material: { input: '扫描用' }, versions: [{ index: 0, text: '一段正文。' }] },
      }),
    });
    bodies.push(['/api/history (POST)', await saved.text()]);

    ok(bodies.length >= 18, `扫了 ${bodies.length} 个响应`);

    // 服务端专用代码取不到 —— 于是「浏览器能拿到的东西」里不可能有鉴权代码
    eq(blocked.sort(), ['/lib/llm.js', '/lib/store.js', '/server.js'], '服务端专用文件被挡在 403');

    const fetchable = bodies.filter(([path]) => blocked.indexOf(path) < 0);
    fetchable.forEach(([path, text]) => {
      ok(!text.includes(KEY), `${path} 的响应里没有 Key`);
      ok(!/Bearer\s+\S/.test(text), `${path} 的响应里没有可用的 Authorization 值`);
      ok(!/"apiKey"\s*:/.test(text), `${path} 的响应里没有 apiKey 字段`);
      ok(!/\bprocess\.env\b/.test(text), `${path} 里不含读环境变量的服务端代码`);
    });

    // 前端根本不参与鉴权：浏览器里既没有 Key，也没有发请求头的代码
    const front = fetchable.filter(([p]) => p.startsWith('/js/') || p.startsWith('/lib/') || p === '/' || p === '/index.html');
    ok(front.length >= 9, '扫了前端与共享文件');
    front.forEach(([path, text]) => {
      ok(!/\bapiKey\b/.test(text), `${path} 里没有 apiKey 变量`);
      ok(!/Bearer|Authorization/.test(text), `${path} 里不参与鉴权`);
    });
  });

  await group('上游的模型列表被页面刷新时不会每次穿透', async () => {
    upstream.calls.length = 0;
    await fetch(base + '/api/models');
    await fetch(base + '/api/models');
    eq(upstream.calls.filter((c) => c.path === '/v1/models').length, 0, '两次都吃缓存');
    await fetch(base + '/api/models?refresh=1');
    eq(upstream.calls.filter((c) => c.path === '/v1/models').length, 1, '只有 refresh=1 才真的去问');
  });

  await group('引擎自检：报告当前模型是否真的可用', async () => {
    const data = await (await fetch(base + '/api/engine/test')).json();
    eq(data.ok, true, '自检通过');
    eq(data.engine, 'live', '真实模型模式');
    eq(data.model, 'gpt-4o-mini', '当前模型');
    eq(data.configured, 'deepseek-chat', '配置里的模型');
    eq(data.verified, true, '已实测');
    eq(data.modelAvailable, true, '当前模型在可用列表里');
    ok(data.chat.includes('qwen-max'), '列出了可写字的模型');
    ok(!data.chat.includes('whisper-1'), '语音模型不在其中');
  });

  await app.close();
  await new Promise((r) => upstream.server.close(r));
  await fsp.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});

  const total = pass + failures.length;
  console.log(`\n通过 ${pass}/${total}`);
  if (failures.length) {
    console.log('\n失败项：');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exitCode = 1;
  }
})();
