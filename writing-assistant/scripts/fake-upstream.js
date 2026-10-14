/* 假的 OpenAI 兼容上游：没有 API Key 时，用它把「真实模型链路」跑起来看。
 *
 * 用法：
 *   node scripts/fake-upstream.js             # 默认 127.0.0.1:5399
 *   node scripts/fake-upstream.js 5400
 *
 * 另开一个终端：
 *   # Windows PowerShell
 *   $env:DEEPSEEK_API_KEY="sk-fake"; $env:AI_BASE_URL="http://127.0.0.1:5399/v1"; node server.js
 *
 * 然后打开写作台，你会看到：启动时探测出可用模型、右上角模型下拉框里有好几个模型、
 * 起稿真的是流式的、一键优化真的走 JSON 返回。
 *
 * 它故意做出一台「不好用的平台」的样子，好让兜底路径也能被看见：
 *   · 列表里有向量、语音、画图模型（应当被页面滤掉）
 *   · 默认模型 deepseek-chat 不存在（应当被探测换掉）
 *   · gpt-4o-broken 永远返回 500（用来试「某一稿失败退回离线引擎」）
 */
'use strict';

const http = require('node:http');

const PORT = Number(process.argv[2] || process.env.FAKE_PORT || 5399);
const HOST = '127.0.0.1';

const MODELS = [
  'text-embedding-3-small',
  'whisper-1',
  'dall-e-3',
  'gpt-4o-mini',
  'claude-3-5-sonnet-20241022',
  'qwen-max',
  'glm-4-plus',
  'gpt-4o-broken',
];

const REPLY = '会议室安静了三秒，然后有人把笔记本合上了。真正的问题不是没人说话，是没人知道该由谁先说。';

const POLISH = {
  polished: '今天我们讨论了一次，大家都觉得这个方案非常重要，需要尽快落实下去。',
  rewrites: [
    { before: '进行了一次讨论', after: '讨论了一次', type: 'redundant', reason: '去掉多余的进行' },
    { before: '非常非常的重要', after: '非常重要', type: 'tone', reason: '程度副词堆叠' },
    { before: ',', after: '，', type: 'punct', reason: '中文里用全角标点' },
  ],
};

function send(res, status, payload, contentType) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, { 'content-type': contentType || 'application/json; charset=utf-8' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => {
    raw += c;
  });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};

    if (req.url.startsWith('/v1/models')) {
      return send(res, 200, { object: 'list', data: MODELS.map((id) => ({ id, object: 'model' })) });
    }
    if (!req.url.startsWith('/v1/chat/completions')) {
      return send(res, 404, { error: { message: 'no such route' } });
    }

    // 两台「坏掉」的样子：一个模型永远 500，一个模型名不存在
    if (body.model === 'gpt-4o-broken') {
      return send(res, 500, { error: { message: 'internal error', type: 'server_error' } });
    }
    if (body.model && MODELS.indexOf(body.model) < 0) {
      return send(res, 404, { error: { message: 'model not found', code: 'model_not_found' } });
    }

    if (!body.stream) {
      return send(res, 200, { choices: [{ message: { content: JSON.stringify(POLISH) }, finish_reason: 'stop' }] });
    }

    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    // 按逗号切段吐字，看起来和真实模型一样
    const pieces = REPLY.match(/[^。]*。|[^。]+$/g) || [REPLY];
    pieces.forEach((p) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`));
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`假上游已启动：http://${HOST}:${PORT}/v1`);
  console.log(`  模型列表 ${MODELS.length} 个（含向量/语音/画图，用来验证页面会过滤）`);
  console.log('  默认模型 deepseek-chat 故意不存在；gpt-4o-broken 故意永远 500');
  console.log('');
  console.log('接上它：');
  console.log(`  $env:DEEPSEEK_API_KEY="sk-fake"`);
  console.log(`  $env:AI_BASE_URL="http://${HOST}:${PORT}/v1"`);
  console.log('  node server.js');
  console.log('按 Ctrl+C 停止。');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
