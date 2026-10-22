/*!
 * 蓝晒 · AI 图片生成器 —— 假上游（scripts/fake-upstream.js）
 *
 * 一台「故意不好用」的 OpenAI 兼容上游，专门用来在没有真 Key 的情况下
 * 把真实链路走通：模型列表里混着向量 / 语音 / 视频模型，有能出图的、
 * 有永远 404 的、有只能给 URL 的、还有不认 response_format 的。
 *
 * 用法：
 *   node scripts/fake-upstream.js            # → http://127.0.0.1:5399/v1
 *   node scripts/fake-upstream.js 5400
 *
 * 然后把应用指过来：
 *   $env:DEEPSEEK_API_KEY="sk-fake"; $env:AI_BASE_URL="http://127.0.0.1:5399/v1"; node server.js
 */
'use strict';

const http = require('node:http');
const path = require('node:path');
const Offline = require(path.join(__dirname, '..', 'lib', 'offline.js'));

const PORT = Number(process.argv[2] || process.env.AIG_FAKE_PORT || 5399);
const HOST = '127.0.0.1';

/** 列表里混着各种东西，和真实的聚合平台一个样 */
const MODELS = [
  'gpt-4o-mini',
  'gpt-4o',
  'deepseek-chat',
  'qwen-max',
  'text-embedding-3-small',
  'whisper-1',
  'tts-1',
  'dall-e-3',
  'dall-e-2',
  'gpt-image-1',
  'gpt-image-2',
  'gpt-4o-image',
  'flux-schnell',
  'ideogram-v2',
  'gemini-2.5-flash-image',
  'sora-1',
  'midjourney-v6-image',
];

/** 这些模型出图会失败，用来验证「检测」和「已排除」那一组 */
const BROKEN = new Set(['dall-e-2']);

/**
 * 「一次只出一张」的闸门。
 *
 * 这个项目已经去掉了批量出图：报文里不许出现 n>1。真实平台对 n 的支持乱七八糟
 * （有的直接 400，有的收下 n 却只回一张），额度还是按 n 扣的。假上游在这里
 * 直接 400 —— 万一以后有人把批量加回来，测试会立刻炸，而不是等用户花了钱才发现。
 */
function rejectBatch(body) {
  const n = Number(body && body.n);
  return Number.isFinite(n) && n > 1;
}

/** 这个模型不认 response_format：客户端应该去掉参数重试一次 */
const NO_RESPONSE_FORMAT = new Set(['dall-e-3']);

/** 这个模型永远只给 URL，不给 base64：验证「下载后落盘」那条路 */
const URL_ONLY = new Set(['flux-schnell']);

/** 这个模型给的地址指向一个「图床坏了」的页面：验证「取不回来也别丢图」的兜底 */
const BAD_DOWNLOAD = new Set(['ideogram-v2']);

const files = new Map(); // /files/xxx.png 的内存图片

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/** 原样收下请求体（multipart 用） */
function collect(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(chunks));
  });
}

/** 用离线引擎现画一张图，假上游也得给出真的 PNG，否则浏览器显示裂图 */
function paint(prompt, size) {
  return Offline.render({ prompt, styleId: 'photo', size: size || '512x512' });
}

function host(req) {
  return req.headers.host || `${HOST}:${PORT}`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const auth = String(req.headers.authorization || '');

  // 图片地址是「CDN」：真实平台的这类链接不需要鉴权，假上游也照样公开
  if (url.pathname.startsWith('/files/') && req.method === 'GET') {
    // 模拟「图床坏了」：200 但返回的是 HTML 错误页，而不是图片
    if (url.pathname.includes('broken')) {
      const body = Buffer.from('<html><body>image expired</body></html>', 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length });
      res.end(body);
      return;
    }
    const hit = files.get(url.pathname);
    if (!hit) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': hit.mime, 'content-length': hit.buffer.length });
    res.end(hit.buffer);
    return;
  }

  if (!auth.startsWith('Bearer ')) {
    return json(res, 401, { error: { message: 'key error please check', type: 'hk_api_error' } });
  }

  if (url.pathname === '/v1/models' && req.method === 'GET') {
    return json(res, 200, { object: 'list', data: MODELS.map((id) => ({ id, object: 'model' })) });
  }

  if (url.pathname === '/v1/images/generations' && req.method === 'POST') {
    const body = await readBody(req);
    const model = String(body.model || '');
    if (BROKEN.has(model)) {
      return json(res, 404, {
        error: { message: `model ${model} not found in this group`, type: 'hk_api_error' },
      });
    }
    if (!MODELS.includes(model)) {
      return json(res, 404, { error: { message: `unknown model ${model}`, type: 'hk_api_error' } });
    }
    if (NO_RESPONSE_FORMAT.has(model) && 'response_format' in body) {
      return json(res, 400, {
        error: { message: 'response_format is not supported for this model', type: 'invalid_request_error' },
      });
    }

    const painted = paint(String(body.prompt || 'fake prompt'), body.size);
    const wantsUrl = URL_ONLY.has(model) || BAD_DOWNLOAD.has(model) || body.response_format === 'url';
    const count = 1; // 一次一张：客户端不许要更多

    if (rejectBatch(body)) {
      return json(res, 400, {
        error: { message: 'n must be 1: this client generates one image at a time', type: 'invalid_request_error' },
      });
    }

    if (BAD_DOWNLOAD.has(model)) {
      // 图生成了，地址也给得出来，但那个地址打不开（模拟图床过期 / 防盗链）
      return json(res, 200, {
        created: Math.floor(Date.now() / 1000),
        data: [{ revised_prompt: body.prompt, url: `http://${host(req)}/files/broken-${Date.now().toString(36)}.png` }],
        usage: { input_tokens: 8, output_tokens: 260, total_tokens: 268 },
      });
    }

    if (wantsUrl) {
      const entries = [];
      for (let i = 0; i < count; i += 1) {
        const name = `/files/${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 7)}.png`;
        files.set(name, { buffer: i === 0 ? painted.buffer : paint(`${body.prompt}#${i}`, body.size).buffer, mime: 'image/png' });
        entries.push({ revised_prompt: body.prompt, url: `http://${host(req)}${name}` });
      }
      return json(res, 200, {
        created: Math.floor(Date.now() / 1000),
        data: entries,
        usage: { input_tokens: 8, output_tokens: 260 * count, total_tokens: 268 * count },
      });
    }

    const entries = [];
    for (let i = 0; i < count; i += 1) {
      const one = i === 0 ? painted : paint(`${body.prompt}#${i}`, body.size);
      entries.push({ revised_prompt: body.prompt, b64_json: `data:image/png;base64,${one.buffer.toString('base64')}` });
    }
    return json(res, 200, {
      created: Math.floor(Date.now() / 1000),
      data: entries,
      usage: { input_tokens: 8, output_tokens: 260 * count, total_tokens: 268 * count },
    });
  }

  if (url.pathname === '/v1/images/edits' && req.method === 'POST') {
    // multipart 不做完整解析，但「字段名对不对」必须验 —— 这里就在检查我们发出去的请求体
    const text = Buffer.concat(await collect(req)).toString('latin1');
    const missing = [];
    if (!/name="model"/.test(text)) missing.push('model');
    if (!/name="prompt"/.test(text)) missing.push('prompt');
    if (!/name="image(\[\])?"/.test(text)) missing.push('image');
    if (missing.length) {
      return json(res, 400, {
        error: { message: 'missing form fields: ' + missing.join(','), type: 'invalid_request_error' },
      });
    }

    const model = String((text.match(/name="model"\r?\n\r?\n([^\r\n]+)/) || [])[1] || '').trim();
    const prompt = String((text.match(/name="prompt"\r?\n\r?\n([^\r\n]+)/) || [])[1] || 'x').trim();
    if (rejectBatch({ n: (text.match(/name="n"\r?\n\r?\n([^\r\n]+)/) || [])[1] })) {
      return json(res, 400, {
        error: { message: 'n must be 1: this client edits one image at a time', type: 'invalid_request_error' },
      });
    }
    if (BROKEN.has(model)) {
      return json(res, 404, { error: { message: `model ${model} not found in this group`, type: 'hk_api_error' } });
    }
    if (!MODELS.includes(model)) {
      return json(res, 404, { error: { message: `unknown model ${model}`, type: 'hk_api_error' } });
    }
    if (NO_RESPONSE_FORMAT.has(model) && /name="response_format"/.test(text)) {
      return json(res, 400, {
        error: { message: 'response_format is not supported for this model', type: 'invalid_request_error' },
      });
    }

    // 给一张「看起来被改过」的图：测试只关心「图有没有回来、我们能不能存下来」
    const painted = paint('edited: ' + prompt, '512x512');
    if (!/name="response_format"/.test(text)) {
      const name = `/files/edit-${Date.now().toString(36)}.png`;
      files.set(name, { buffer: painted.buffer, mime: 'image/png' });
      return json(res, 200, { created: Math.floor(Date.now() / 1000), data: [{ url: `http://${host(req)}${name}` }] });
    }
    return json(res, 200, {
      created: Math.floor(Date.now() / 1000),
      data: [{ b64_json: `data:image/png;base64,${painted.buffer.toString('base64')}` }],
      usage: { input_tokens: 20, output_tokens: 240, total_tokens: 260 },
    });
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    const body = await readBody(req);
    const wantJson = Boolean(body.response_format && body.response_format.type === 'json_object');
    const userMsg = String(
      (body.messages || []).filter((m) => m && m.role === 'user').map((m) => m.content).join(' ') || ''
    );
    const subject = (userMsg.match(/用户描述：(.+)/) || [])[1] || '画面';
    const content = wantJson
      ? JSON.stringify({
          prompt:
            `${subject.trim()}, staged in a believable environment with layered depth, soft directional light from the left, ` +
            'subtle rim light, medium shot at 35mm with shallow depth of field, rich surface texture, harmonious cool palette, ' +
            'clean composition, no watermark, no text overlay',
          notes: '补上了光线、镜头和质感',
        })
      : '好的。';
    return json(res, 200, {
      id: 'chatcmpl-fake',
      model: body.model || 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 40, completion_tokens: 60, total_tokens: 100 },
    });
  }

  return json(res, 404, { error: { message: 'no such endpoint: ' + url.pathname } });
});

server.listen(PORT, HOST, () => {
  console.log(`假上游已启动：http://${HOST}:${PORT}/v1`);
  console.log('  能出图：gpt-image-2 / gpt-image-1 / gpt-4o-image / dall-e-3 / flux-schnell / ideogram-v2 / gemini-2.5-flash-image / midjourney-v6-image');
  console.log('  只接一张的：任何模型收到 n>1 都 400（本项目一次只出一张，这是回归闸门）');
  console.log('  故意坏的：dall-e-2（永远 404）、ideogram-v2（地址打不开，用来验证「取不回来也别丢图」）');
  console.log('  接上应用：$env:DEEPSEEK_API_KEY="sk-fake"; $env:AI_BASE_URL="http://127.0.0.1:' + PORT + '/v1"; node server.js');
});

module.exports = { server, MODELS, BROKEN, URL_ONLY, NO_RESPONSE_FORMAT, BAD_DOWNLOAD };
