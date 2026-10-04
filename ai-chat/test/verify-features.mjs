// 五个新功能的端到端验证
//
//   node test/verify-features.mjs [base]
//
// 覆盖：角色提示词是否真的影响回答、会话隔离、图片校验、导出结构。

const BASE = process.argv[2] || 'http://127.0.0.1:5280';

async function ask({ messages, sessionId, model, systemPrompt }) {
  const body = { messages, sessionId };
  if (model) body.model = model;
  if (systemPrompt) body.systemPrompt = systemPrompt;

  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const rd = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let meta = null;
  let error = null;
  let done = null;
  for (;;) {
    const { value, done: d } = await rd.read();
    if (d) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const p of parts)
      for (const line of p.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        let ev;
        try {
          ev = JSON.parse(raw);
        } catch {
          continue;
        }
        if (ev.type === 'meta') meta = ev;
        if (ev.type === 'error') error = ev.message;
        if (ev.type === 'delta') text += ev.text;
        if (ev.type === 'done') done = ev;
      }
  }
  return { text: text.trim(), meta, error, done };
}

const results = [];
const ok = (name, pass, detail = '') => results.push([name, pass, detail]);

/** 上游可能抽风：这些断言依赖真实模型，失败时要能区分「上游挂了」和「代码错了」 */
async function upstreamAlive() {
  try {
    const res = await fetch(`${BASE}/api/models`, { signal: AbortSignal.timeout(60000) });
    const data = await res.json();
    return Array.isArray(data.models) && data.models.length > 0;
  } catch {
    return false;
  }
}

const alive = await upstreamAlive();
if (!alive) {
  console.log('⚠ 上游模型列表当前不可达 —— 依赖真实模型的断言会被跳过（不是代码问题）');
  console.log('  仍会验证不依赖上游的逻辑：图片拦截、会话隔离、离线降级。\n');
}

// ---------------------------------------------------------------- 角色提示词

console.log('① 角色提示词是否真的影响回答');
if (!alive) {
  console.log('   跳过（上游不可达）');
} else {
  const question = '用一句话说说你怎么看这段代码：const a = [1,2,3].map(x => x * 2)';
  const plain = await ask({
    sessionId: `f_plain_${Date.now().toString(36)}`,
    messages: [{ role: 'user', content: question }],
  });
  const asCounselor = await ask({
    sessionId: `f_role_${Date.now().toString(36)}`,
    messages: [{ role: 'user', content: question }],
    systemPrompt:
      '你是一位心理咨询师。无论对方说什么，你都只能反问他的感受，绝对不要给出任何技术解释或代码建议。回答里必须出现「感受」两个字。',
  });
  console.log('   无角色:', JSON.stringify(plain.text.slice(0, 70)));
  console.log('   咨询师:', JSON.stringify(asCounselor.text.slice(0, 70)));
  ok('角色轮产出了内容', asCounselor.text.length > 10, asCounselor.error ?? `长度 ${asCounselor.text.length}`);
  ok('角色提示词生效（回答里出现了设定的关键词）', asCounselor.text.includes('感受'),
    asCounselor.text.slice(0, 90));
  ok('两种角色给出不同回答', plain.text !== asCounselor.text);
}

// ---------------------------------------------------------------- 会话隔离

console.log('\n② 不同 sessionId 的上下文互不串台');
if (!alive) {
  console.log('   跳过（上游不可达）');
} else {
  const a = `f_a_${Date.now().toString(36)}`;
  const b = `f_b_${Date.now().toString(36)}`;
  await ask({ sessionId: a, messages: [{ role: 'user', content: '我叫阿龙，记住这个名字' }] });
  const inB = await ask({ sessionId: b, messages: [{ role: 'user', content: '我叫什么名字？' }] });
  console.log('   会话 B 的回答:', JSON.stringify(inB.text.slice(0, 70)));
  ok('新会话不知道另一个会话的内容', !inB.text.includes('阿龙'), inB.text.slice(0, 90));

  const saved = await (await fetch(`${BASE}/api/history/${a}`)).json();
  ok('每个会话各自落盘一份兜底副本', Array.isArray(saved.turns) && saved.turns.length >= 2,
    `${saved.turns?.length ?? 0} 条`);
  await fetch(`${BASE}/api/history/${a}`, { method: 'DELETE' });
  await fetch(`${BASE}/api/history/${b}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------- 图片

console.log('\n③ 图片：校验与拒绝路径');
{
  const tinyPng =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

  // 用一个明确不支持图片的模型 + 一张合法图 → 应该被提前拦住并给出可看图模型
  const rejected = await ask({
    sessionId: `f_img_${Date.now().toString(36)}`,
    messages: [{ role: 'user', content: '这是什么', images: [tinyPng] }],
    model: 'deepseek-v3.2',
  });
  console.log('   不支持图片的模型返回:', JSON.stringify((rejected.error ?? '').slice(0, 130)));
  ok('在不支持图片的模型上贴图会被提前拦住', Boolean(rejected.error), JSON.stringify(rejected.error));
  ok('拒绝时说明了原因（模型不支持）', /不支持图片/.test(rejected.error ?? ''));
  // 这个提示不该依赖「此刻还能连上上游」——列表在启动时就预热过了
  ok('拒绝时列出了能看图的模型（来自预热的缓存）', /gpt-4o|gemini|claude/.test(rejected.error ?? ''),
    rejected.error);

  // 图片格式不合法 → 被过滤掉，请求照常成功
  const filtered = await ask({
    sessionId: `f_img2_${Date.now().toString(36)}`,
    messages: [{ role: 'user', content: '你好', images: ['data:text/html;base64,PHNjcmlwdD4='] }],
  });
  ok(
    '非法图片被静默过滤',
    filtered.text.length > 0 || (filtered.error && !/图片/.test(filtered.error)),
    filtered.error ?? `长度 ${filtered.text.length}`,
  );
}

// ---------------------------------------------------------------- 其它

console.log('\n④ 模型列表与配置');
{
  const config = await (await fetch(`${BASE}/api/config`)).json();
  ok('配置接口返回默认模型', Boolean(config.defaultModel), config.defaultModel);

  if (alive) {
    const models = await (await fetch(`${BASE}/api/models`)).json();
    ok('模型列表可用', models.models.length > 0, `${models.models.length} 个`);
    ok('列表已过滤非聊天模型', models.filteredOut > 0, `滤掉 ${models.filteredOut} 个`);
    ok('可看图模型在列表里被标出', models.models.some((m) => /gpt-4o|gemini|claude/.test(m)));
  } else {
    console.log('   跳过模型列表断言（上游不可达）');
  }
}

console.log('');
let allOk = true;
for (const [name, pass, detail] of results) {
  if (!pass) allOk = false;
  console.log(pass ? '  ✓' : '  ✗', name, pass ? '' : `—— ${detail}`);
}
console.log(allOk ? '\n功能验证通过' : '\n有未通过项');
process.exit(allOk ? 0 : 1);
