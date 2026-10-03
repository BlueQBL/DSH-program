// 上游自查
//
//   node test/check-upstream.mjs
//
// 当界面报「上游出错」时，先跑这个 —— 它会直接问上游三件事：
//   1. 连通性如何、HTTP 状态与原始错误体是什么
//   2. 这个 Key 到底能用哪些模型（遇到 model_not_found 时最想知道）
//   3. 当前默认模型能不能真的跑通流式
//
// 用的是服务端完全相同的环境变量与请求方式，所以结论可以直接对着改配置。

const key = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '';
const base = (process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const model = process.env.AI_MODEL || process.env.OPENAI_MODEL || 'deepseek-chat';

console.log('上游地址 :', base);
console.log('当前模型 :', model);
console.log('API Key  :', key ? `${key.slice(0, 6)}…（长度 ${key.length}）` : '(未设置 → 服务会走离线回答)');
console.log('');

if (!key) {
  console.log('没有配置 Key，服务端会使用本地离线回答，无需访问上游。');
  console.log('想接入真实模型：设置 DEEPSEEK_API_KEY 或 OPENAI_API_KEY 后重启服务。');
  process.exit(0);
}

let problems = 0;

// ---------------------------------------------------------------- 1. 模型列表
console.log('── 1. 这个 Key 能用哪些模型 ──');
let available = [];
try {
  const res = await fetch(`${base}/models`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) {
    console.log(`HTTP ${res.status} —— ${text.slice(0, 300)}`);
    problems += 1;
  } else {
    available = (JSON.parse(text).data ?? []).map((m) => m.id).filter(Boolean).sort();
    console.log(`共 ${available.length} 个模型`);
    const deepseek = available.filter((id) => /deepseek/i.test(id));
    if (deepseek.length) console.log('DeepSeek 系:', deepseek.join(', '));
    if (available.length && !available.includes(model)) {
      console.log(`\n⚠ 当前模型「${model}」不在列表里 —— 这就是界面报错的原因。`);
      console.log('  改法：设置环境变量 AI_MODEL 为下面任意一个，然后重启服务。');
      const suggestions = deepseek.filter((id) => /v3|v4|r1/.test(id)).slice(0, 4);
      console.log('  推荐试试:', (suggestions.length ? suggestions : available.slice(0, 4)).join(', '));
    }
  }
} catch (err) {
  console.log(`请求失败：${err.cause?.code || err.message}`);
  problems += 1;
}
console.log('');

// ---------------------------------------------------------------- 2. 默认模型
console.log('── 2. 当前模型能否跑通流式 ──');
async function tryStream(candidate) {
  const started = Date.now();
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model: candidate, stream: true, messages: [{ role: 'user', content: '只回三个字：收到了' }] }),
      signal: AbortSignal.timeout(45000),
    });

    if (!res.ok) {
      const body = await res.text();
      let reason = body.slice(0, 200);
      try {
        reason = JSON.parse(body).error?.message ?? reason;
      } catch {
        /* 原样保留 */
      }
      console.log(`  ${candidate} → HTTP ${res.status} ${reason}`);
      return false;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    let text = '';
    let chunks = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks += 1;
      buffered += decoder.decode(value, { stream: true });
      const frames = buffered.split('\n\n');
      buffered = frames.pop() ?? '';
      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const delta = JSON.parse(data).choices?.[0]?.delta?.content;
            if (delta) text += delta;
          } catch {
            /* 忽略半截帧 */
          }
        }
      }
    }
    console.log(`  ${candidate} → OK  ${Date.now() - started}ms  ${chunks} 个数据块  回答=${JSON.stringify(text.trim().slice(0, 30))}`);
    return true;
  } catch (err) {
    console.log(`  ${candidate} → 请求异常 ${err.name}: ${err.cause?.code || err.message}`);
    return false;
  }
}

const primaryOk = await tryStream(model);
if (!primaryOk) {
  problems += 1;
  // 顺手找出一个能用的，省得用户自己试
  const fallbacks = ['deepseek-v3.2', 'deepseek-v4-flash', 'deepseek-v4.1-flash', 'gpt-4o-mini', 'gpt-4o'];
  const toTry = (available.length ? available.filter((m) => fallbacks.includes(m)) : fallbacks)
    .filter((m) => m !== model)
    .slice(0, 4);

  console.log('\n  试着找一个能用的：');
  for (const candidate of toTry) {
    if (await tryStream(candidate)) {
      console.log(`\n  可以这样启动：AI_MODEL=${candidate} node server.mjs`);
      console.log('  （其实不设也行：服务端启动时会自动探测可用模型并改用它）');
      break;
    }
  }
}

console.log('');
console.log(problems === 0 ? '结论：上游配置正常。' : '结论：上游有问题，按上面的提示改 AI_MODEL 或 AI_BASE_URL。');
process.exit(problems === 0 ? 0 : 1);
