'use strict';

/**
 * 上游接入的测试：配置读取、错误翻译、脱敏、出图请求的形状、两种返回形态。
 * 运行：node test/upstream.test.js
 */

const path = require('node:path');
const http = require('node:http');
const { eq, ok, not, has, group, report, sleep } = require('./harness.js');
const Upstream = require('../lib/upstream.js');

/** 前面几组会把 globalThis.fetch 换成假的，测真实下载之前要换回来 */
const realFetch = globalThis.fetch;

/**
 * 假 Key 一律拼接构造。
 * 写成完整字面量的话，仓库的密钥扫描器（tools/scan-secrets.mjs）会把测试文件
 * 报成「高危命中」—— 报告一有这种自造噪声，人就会学会无视它。
 */
const fake = (...parts) => parts.join('-');

/** 造一个可控的响应 */
function respond(status, payload, options) {
  const o = options || {};
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (o.headers ? o.headers[name.toLowerCase()] || null : null) },
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    json: async () => (typeof payload === 'string' ? JSON.parse(payload) : payload),
    arrayBuffer: async () => Buffer.from(o.bytes || ''),
  };
}

(async function main() {
  console.log('配置从环境变量来');

  await group('Key 只从环境变量读，代码里不留字面量', () => {
    const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'lib', 'upstream.js'), 'utf8');
    ok(!/\bsk-[A-Za-z0-9_-]{16,}/.test(src), '没有 sk- 开头的密钥字面量');
    ok(!/\bhk-[A-Za-z0-9]{16,}/.test(src), '没有 hk- 开头的密钥字面量');
    has(src, 'OPENAI_HK_API_KEY', '写明了从哪个环境变量取 Key');
  });

  await group('读得到 Key / 地址 / 模型，没 Key 就是离线', () => {
    const empty = Upstream.readConfig({});
    eq(empty.live, false, '没有 Key 不 live');
    eq(empty.baseUrl, 'https://api.openai-hk.com/v1', '默认打 OpenAI-HK');
    has(empty.reason, 'Key', '说明为什么离线');

    const hk = Upstream.readConfig({ OPENAI_HK_API_KEY: fake('hk', 'abcdef1234567890'), AI_IMAGE_MODEL: 'gpt-image-2' });
    eq(hk.live, true, '有 Key 就 live');
    eq(hk.keyFrom, 'OPENAI_HK_API_KEY', '记得 Key 来自哪个变量');
    eq(hk.imageModel, 'gpt-image-2', '出图模型听环境变量的');

    const priority = Upstream.readConfig({
      OPENAI_HK_API_KEY: fake('hk', 'first1234567890'),
      OPENAI_API_KEY: fake('sk', 'second1234567890'),
    });
    eq(priority.keyFrom, 'OPENAI_HK_API_KEY', '专用的变量优先');

    const right = Upstream.readConfig({ DEEPSEEK_API_KEY: 'x', AI_BASE_URL: 'https://example.com/v1/' });
    eq(right.baseUrl, 'https://example.com/v1', '地址去掉结尾斜杠');
    eq(Upstream.readConfig({ AI_FORCE_OFFLINE: '1', OPENAI_HK_API_KEY: fake('hk', 'abcdef123456') }).live, false, 'AI_FORCE_OFFLINE 强制离线');
  });

  console.log('错误翻译与脱敏');

  await group('状态码翻成人话', () => {
    has(Upstream.describeStatus(401, ''), 'API Key', '401 指向 Key');
    has(Upstream.describeStatus(401, ''), 'AI_BASE_URL', '401 提醒别家平台要配地址');
    has(Upstream.describeStatus(402, ''), '余额', '402 指向余额');
    has(Upstream.describeStatus(404, ''), '模型名', '404 指向模型名');
    has(Upstream.describeStatus(400, ''), '尺寸', '400 提到尺寸/画质/审核这些参数问题');
    has(Upstream.describeStatus(429, ''), '频繁', '429 指向限流');
    has(Upstream.describeStatus(503, 'busy'), '暂时不可用', '5xx 说是上游的问题');
    has(Upstream.describeStatus(418, 'teapot'), '418', '没见过的状态码原样带出');
    has(Upstream.describeStatus(500, 'upstream boom'), 'upstream boom', '错误正文被带上');
    eq(Upstream.describeStatus(500, 'x'.repeat(500)).length < 400, true, '正文不会无限长');
  });

  await group('上游把 Key 回带进错误体时，出口统一抹掉', () => {
    const key = ['hk', 'live', 'AbCdEf1234567890xyz'].join('-');
    const leaked = JSON.stringify({ error: { message: `bad auth`, authorization: `Bearer ${key}` } });
    const text = Upstream.describeStatus(401, leaked, key);
    not(text.includes(key), '整串 Key 被抹掉');
    has(text, 'API Key', '仍然说清是什么问题');

    eq(Upstream.redact(`key=${key}`, key), 'key=***', '传入的 Key 整体替换');
    eq(Upstream.redact('Authorization: Bearer abcdef123456', ''), 'Authorization: Bearer ***', 'Bearer 后面一律抹');
    eq(Upstream.redact('用了 ' + ['hk', 'abcdef1234567890'].join('-') + ' 这个 Key', ''), '用了 hk-*** 这个 Key', 'hk- 前缀也认');
    eq(Upstream.redact('普通文本，价格 12.5 元', ''), '普通文本，价格 12.5 元', '不是密钥的文本不动');
    eq(Upstream.redact(null, ''), '', 'null 不炸');
  });

  console.log('出图请求');

  await group('请求形状对：model / prompt / size / quality / n / response_format', async () => {
    let captured = null;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
      return respond(200, { data: [{ b64_json: 'aGVsbG8=' }] });
    };
    const out = await Upstream.generateImage({
      apiKey: fake('sk', 'test', '1234567890'),
      baseUrl: 'http://fake.local/v1',
      model: 'gpt-image-2',
      prompt: 'a white cat',
      size: '1024x1024',
      quality: 'low',
      n: 1,
    });
    eq(captured.url, 'http://fake.local/v1/images/generations', '打的是 /images/generations');
    eq(captured.headers.authorization, 'Bearer ' + fake('sk', 'test', '1234567890'), '带上 Bearer');
    eq(captured.body.model, 'gpt-image-2', '模型名');
    eq(captured.body.prompt, 'a white cat', '提示词');
    eq(captured.body.size, '1024x1024', '尺寸');
    eq(captured.body.quality, 'low', '画质');
    eq(captured.body.n, 1, '张数');
    eq(captured.body.response_format, 'b64_json', '默认要 base64，方便自己落盘');
    eq(out.images.length, 1, '拿到一张');
    eq(out.images[0].b64, 'aGVsbG8=', 'base64 原样带出');
  });

  await group('data: 前缀的 base64 也认（平台文档里的返回就是这样）', async () => {
    globalThis.fetch = async () => respond(200, { data: [{ b64_json: 'data:image/png;base64,aGVsbG8=', url: 'https://x/y.png' }] });
    const out = await Upstream.generateImage({ apiKey: 'k'.repeat(12), baseUrl: 'http://f/v1', model: 'm', prompt: 'p' });
    eq(out.images[0].b64, 'data:image/png;base64,aGVsbG8=', '前缀原样返回，交给 image.js 去剥');
    eq(out.images[0].url, 'https://x/y.png', '顺带把 url 也留着');
  });

  await group('只给 URL 时也能收场', async () => {
    globalThis.fetch = async () => respond(200, { data: [{ url: 'https://cdn/x.png' }] });
    const out = await Upstream.generateImage({ apiKey: 'k'.repeat(12), baseUrl: 'http://f/v1', model: 'm', prompt: 'p', responseFormat: 'url' });
    eq(out.images.length, 1, '拿到一张');
    eq(out.images[0].url, 'https://cdn/x.png', '地址带出来');
    eq(out.images[0].b64, '', '没有 base64');
    eq(out.images[0].source, 'url', '标出来源是地址');
  });

  await group('模型不认 response_format：去掉再试一次', async () => {
    const bodies = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if ('response_format' in body) return respond(400, { error: { message: 'response_format not supported' } });
      return respond(200, { data: [{ url: 'https://cdn/x.png' }] });
    };
    const out = await Upstream.generateImage({ apiKey: 'k'.repeat(12), baseUrl: 'http://f/v1', model: 'dall-e-3', prompt: 'p' });
    eq(bodies.length, 2, '试了两次');
    eq('response_format' in bodies[0], true, '第一次带着参数');
    eq('response_format' in bodies[1], false, '第二次去掉了');
    eq(out.images[0].url, 'https://cdn/x.png', '拿到了图');
  });

  await group('上游报错抛 UpstreamError，状态码留着给上层映射', async () => {
    globalThis.fetch = async () => respond(402, { error: { message: 'insufficient quota' } });
    try {
      await Upstream.generateImage({ apiKey: 'k'.repeat(12), baseUrl: 'http://f/v1', model: 'm', prompt: 'p' });
      report('upstream'); // 不该走到这里
    } catch (err) {
      eq(err.name, 'UpstreamError', '是 UpstreamError');
      eq(err.status, 402, '状态码带出来');
      has(err.message, '余额', '翻成中文说明');
    }
  });

  await group('返回里没有图片就说清楚', async () => {
    globalThis.fetch = async () => respond(200, { data: [] });
    try {
      await Upstream.generateImage({ apiKey: 'k'.repeat(12), baseUrl: 'http://f/v1', model: 'm', prompt: 'p' });
    } catch (err) {
      has(err.message, '找不到图片数据', '说明上游没给可用的图');
    }
  });

  console.log('上游把图片藏在哪（各家形状都不一样）');

  await group('标准的 data[0].b64_json 与 data[0].url', async () => {
    globalThis.fetch = async () => respond(200, { data: [{ b64_json: 'aGVsbG8=' }] });
    const one = await Upstream.generateImage({ apiKey: 'k'.repeat(12), baseUrl: 'http://f/v1', model: 'm', prompt: 'p' });
    eq(one.images[0].b64, 'aGVsbG8=', 'b64 抠出来了');

    globalThis.fetch = async () => respond(200, { data: [{ url: 'https://x/y.png', revised_prompt: '改过的' }] });
    const two = await Upstream.generateImage({ apiKey: 'k'.repeat(12), baseUrl: 'http://f/v1', model: 'm', prompt: 'p' });
    eq(two.images[0].url, 'https://x/y.png', 'url 抠出来了');
    eq(two.images[0].revisedPrompt, '改过的', 'revised_prompt 也带着');
  });

  await group('data 不是数组 / 换字段名 / data 里直接放字符串', async () => {
    const shapes = [
      { name: 'data 是对象', body: { data: { url: 'https://x/a.png' } }, expect: 'https://x/a.png' },
      { name: 'data 是字符串数组', body: { data: ['https://x/b.png'] }, expect: 'https://x/b.png' },
      { name: 'images 字段', body: { images: [{ url: 'https://x/c.png' }] }, expect: 'https://x/c.png' },
      { name: 'output 字段', body: { output: [{ url: 'https://x/d.png' }] }, expect: 'https://x/d.png' },
      { name: 'image_url 字段', body: { data: [{ image_url: 'https://x/e.png' }] }, expect: 'https://x/e.png' },
      { name: 'url 在 image 字段里', body: { data: [{ image: 'https://x/f.png' }] }, expect: 'https://x/f.png' },
      {
        name: '聊天式返回（markdown 图片）',
        body: { choices: [{ message: { content: '画好了 ![img](https://x/g.png)' } }] },
        expect: 'https://x/g.png',
      },
      { name: 'b64 在 data-url 里', body: { data: [{ url: 'data:image/png;base64,aGVsbG8=' }] }, expect: 'data:image/png;base64,aGVsbG8=' },
    ];
    for (const shape of shapes) {
      globalThis.fetch = async () => respond(200, shape.body);
      const out = await Upstream.generateImage({ apiKey: 'k'.repeat(12), baseUrl: 'http://f/v1', model: 'm', prompt: 'p' });
      const got = out.images[0].b64 || out.images[0].url;
      eq(got, shape.expect, shape.name);
    }
  });

  await group('认不出来时，把「到底返回了什么」写进错误里', async () => {
    globalThis.fetch = async () =>
      respond(200, { created: 1, data: [{ revised_prompt: '只回了个改写后的提示词' }], usage: { total_tokens: 10 } });
    try {
      await Upstream.generateImage({ apiKey: 'k'.repeat(12), baseUrl: 'http://f/v1', model: 'dall-e-3', prompt: 'p' });
      ok(false, '应该报错');
    } catch (err) {
      has(err.message, '找不到图片数据', '说清是没找到图片');
      has(err.message, '响应字段', '把返回的字段名列出来（这样才能定位）');
      has(err.message, 'revised_prompt', '连 data[0] 的字段也列出来');
      has(err.message, '额度', '提醒额度可能已经扣了');
    }
  });

  await group('collectImageEntries 去重，不会把同一张算两遍', () => {
    const entries = Upstream.collectImageEntries({
      data: [{ url: 'https://x/a.png' }, { url: 'https://x/a.png' }],
      images: ['https://x/b.png'],
    });
    eq(entries.length, 2, '两个不同的图，重复的去掉');
  });

  console.log('模型列表与聊天');

  await group('列表取回并去重', async () => {
    globalThis.fetch = async (url) => {
      if (!String(url).endsWith('/models')) throw new Error('不该问别的');
      return respond(200, { data: [{ id: 'a' }, { id: 'b' }, { id: 'a' }, { model: 'c' }, {}] });
    };
    const out = await Upstream.listModels({ apiKey: 'k'.repeat(12), baseUrl: 'http://f/v1' });
    eq(out.ok, true, '取到了');
    eq(out.ids, ['a', 'b', 'c'], '去重、认 id 和 model 两种字段');
  });

  await group('列表取不到返回 ok:false（不抛错，让上层决定）', async () => {
    globalThis.fetch = async () => respond(401, { error: { message: 'key error' } });
    const out = await Upstream.listModels({ apiKey: 'k'.repeat(12), baseUrl: 'http://f/v1' });
    eq(out.ok, false, '标记失败');
    has(out.error, 'API Key', '原因翻成人话');
    eq(out.ids, [], '没有模型');
  });

  await group('聊天接口：JSON 模式不被支持时去掉再试', async () => {
    const bodies = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.response_format) return respond(400, { error: { message: 'unsupported' } });
      return respond(200, { choices: [{ message: { content: '{"prompt":"x"}' } }] });
    };
    const out = await Upstream.chatOnce({
      apiKey: 'k'.repeat(12),
      baseUrl: 'http://f/v1',
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      jsonMode: true,
    });
    eq(bodies.length, 2, '试了两次');
    eq(bodies[0].response_format.type, 'json_object', '第一次要 JSON');
    eq('response_format' in bodies[1], false, '第二次去掉了');
    eq(out.text, '{"prompt":"x"}', '拿到内容');
  });

  console.log('下载上游图片');

  globalThis.fetch = realFetch; // 下面两组要真的开 socket

  await group('把上游给的图片地址下回来', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64, 7)]);
    const server = http.createServer((req, res) => {
      if (req.url === '/ok.png') {
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
        res.end(png);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nope');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      const out = await Upstream.fetchImageBytes(`http://127.0.0.1:${port}/ok.png`);
      eq(out.buffer.length, png.length, '字节数对得上');
      eq(out.contentType, 'image/png', '带上 content-type');

      try {
        await Upstream.fetchImageBytes(`http://127.0.0.1:${port}/missing.png`);
      } catch (err) {
        has(err.message, '404', '404 说清楚');
      }

      try {
        await Upstream.fetchImageBytes(`http://127.0.0.1:${port}/ok.png`, { maxBytes: 16 });
      } catch (err) {
        has(err.message, '太大', '超过上限就放弃');
      }
    } finally {
      server.close();
    }
  });

  await group('图片地址要鉴权时，带 Key 再试一次', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(32, 3)]);
    const key = ['sk', 'download', '1234567890'].join('-');
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push(String(req.headers.authorization || ''));
      if (String(req.headers.authorization || '') !== `Bearer ${key}`) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('need key');
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
      res.end(png);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      const out = await Upstream.fetchImageBytes(`http://127.0.0.1:${port}/private.png`, { apiKey: key });
      eq(out.buffer.length, png.length, '第二次带 Key 拿到了');
      eq(seen.length, 2, '先不带、再带');
      eq(seen[0], '', '第一次没有 Authorization');
      eq(seen[1], `Bearer ${key}`, '第二次带上了');
    } finally {
      server.close();
    }
  });

  await group('上游卡住时报的是「超时」而不是含糊的失败', async () => {
    const hang = http.createServer(() => {
      /* 收下请求但永不响应 */
    });
    await new Promise((r) => hang.listen(0, '127.0.0.1', r));
    const port = hang.address().port;
    const started = Date.now();
    try {
      await Upstream.chatOnce({
        apiKey: 'k'.repeat(12),
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        timeoutMs: 400,
        stallMs: 0,
      });
      ok(false, '应该超时');
    } catch (err) {
      has(err.message, '超时', '说明超时');
      ok(Date.now() - started < 5000, '没有真的等很久');
    } finally {
      hang.close();
      await sleep(20);
    }
  });

  report('upstream');
})();
