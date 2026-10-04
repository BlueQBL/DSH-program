// 捕获式验证：看服务端到底把什么发给了上游
//
//   node test/verify-upstream-payload.mjs
//
// 为什么需要它：角色提示词、图片格式这些东西的正确性，只有看「实际发出去的请求体」
// 才能确认，而不是看本地代码。而真实上游经常抽风 —— 一旦它不可达，
// 「角色是否生效」这种断言就没法验证了。
//
// 做法：起一个假的 OpenAI 兼容服务，把收到的请求记下来，
// 再让真实的服务端指向它跑一轮，然后断言请求体内容。

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let passed = 0;
const failures = [];
const check = (name, condition, detail = '') => {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
};

const randomPort = () => 41000 + Math.floor(Math.random() * 15000);

// ---------------------------------------------------------------- 假上游

/** 记录每一次 /chat/completions 的请求体 */
const captured = [];

const fake = createServer((req, res) => {
  if (req.url === '/v1/models') {
    const body = JSON.stringify({
      data: [
        { id: 'deepseek-v3.2' },
        { id: 'gpt-4o' },
        { id: 'gemini-2.5-flash' },
        { id: 'dall-e-3' },
        { id: 'text-embedding-3-large' },
      ],
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
    return;
  }

  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* 记原始串便于排查 */
      }
      captured.push({ body: parsed, raw });

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
      });
      // 探测用的非流式请求：直接给一个 JSON 响应
      if (parsed && parsed.stream === false) {
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
        return;
      }
      // 流式请求：分两帧吐出
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '收到' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '了。' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    return;
  }

  res.writeHead(404);
  res.end('{}');
});

await new Promise((resolve) => fake.listen(randomPort(), '127.0.0.1', resolve));
const fakeBase = `http://127.0.0.1:${fake.address().port}`;

// ---------------------------------------------------------------- 被测服务端

const serverPort = randomPort();
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(serverPort),
    AI_BASE_URL: `${fakeBase}/v1`,
    DEEPSEEK_API_KEY: 'fake-key-for-capture-test',
    AI_MODEL: 'deepseek-v3.2',
    AI_MODEL_CANDIDATES: 'deepseek-v3.2',
  },
  stdio: 'ignore',
});
const BASE = `http://127.0.0.1:${serverPort}`;

async function waitForServer(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function ask(body) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const frames = text
    .split('\n\n')
    .map((f) => f.replace(/^data:\s*/, '').trim())
    .filter(Boolean)
    .map((f) => {
      try {
        return JSON.parse(f);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return {
    reply: frames.filter((f) => f.type === 'delta').map((f) => f.text).join(''),
    error: frames.find((f) => f.type === 'error')?.message ?? null,
  };
}

/** 等假上游收到一个流式请求（服务端可能在探测后才发） */
async function waitForCapture(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = captured.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 60));
  }
  return null;
}

const streamed = () => captured.filter((c) => c.body?.stream !== false);

try {
  const up = await waitForServer();
  console.log(`假上游 ${fakeBase}`);
  console.log(`服务端 ${BASE}\n`);
  check('服务端能启动', up);
  if (!up) throw new Error('服务端没起来');

  console.log('角色提示词');
  {
    captured.length = 0;
    const custom = '你是一只只会喵喵叫的猫。回复必须以「喵」开头。';
    await ask({
      sessionId: 'payload_role',
      messages: [{ role: 'user', content: '你好' }],
      systemPrompt: custom,
    });
    const hit = await waitForCapture((c) => c.body?.stream !== false);
    check('收到了流式请求', Boolean(hit));

    const system = hit?.body?.messages?.[0];
    check('第一条是 system 消息', system?.role === 'system', JSON.stringify(system));
    check('角色提示词被写进 system', system?.content?.includes('只会喵喵叫的猫'), system?.content?.slice(0, 80));
    check('通用回答要求也被带上（两者拼接）', system?.content?.includes('不要编造事实'), system?.content?.slice(-120));
    check('用户消息在 system 之后', hit?.body?.messages?.[1]?.content === '你好');

    const reply = await ask({
      sessionId: 'payload_role2',
      messages: [{ role: 'user', content: '你好' }],
      systemPrompt: custom,
    });
    void reply;
  }

  console.log('\n未设角色时的默认提示词');
  {
    captured.length = 0;
    await ask({ sessionId: 'payload_default', messages: [{ role: 'user', content: '你好' }] });
    const hit = await waitForCapture((c) => c.body?.stream !== false);
    const system = hit?.body?.messages?.[0];
    check('默认也给 system 消息', system?.role === 'system');
    check('默认提示词不带任何角色设定', system?.content?.includes('对谈录') && !system?.content?.includes('喵'));
  }

  console.log('\n图片消息的格式');
  {
    captured.length = 0;
    const tiny =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    const res = await ask({
      sessionId: 'payload_img',
      messages: [{ role: 'user', content: '这是什么', images: [tiny] }],
      model: 'gpt-4o',
    });
    const hit = await waitForCapture((c) => c.body?.stream !== false);

    if (!hit) {
      // 模型不在假上游的列表里时会被拦下，这本身也是正确行为
      check('图片请求被处理（未发上游时应有明确说明）', Boolean(res.error), JSON.stringify(res));
    } else {
      const userMsg = hit.body.messages.at(-1);
      check('带图消息的 content 是数组（多模态格式）', Array.isArray(userMsg.content),
        JSON.stringify(userMsg.content)?.slice(0, 120));
      const textPart = userMsg.content.find((p) => p.type === 'text');
      const imagePart = userMsg.content.find((p) => p.type === 'image_url');
      check('文字部分保留', textPart?.text === '这是什么');
      check('图片用 image_url + dataURL 形式', imagePart?.image_url?.url?.startsWith('data:image/png;base64,'),
        imagePart?.image_url?.url?.slice(0, 40));
    }
  }

  console.log('\n非法的图片被过滤后才发出');
  {
    captured.length = 0;
    await ask({
      sessionId: 'payload_img_bad',
      messages: [{ role: 'user', content: '你好', images: ['data:text/html;base64,PHNjcmlwdD4='] }],
    });
    const hit = await waitForCapture((c) => c.body?.stream !== false);
    const userMsg = hit?.body?.messages?.at(-1);
    check('非法图片没有出现在请求里', typeof userMsg?.content === 'string', JSON.stringify(userMsg?.content).slice(0, 80));
  }

  console.log('\n多轮上下文');
  {
    captured.length = 0;
    await ask({
      sessionId: 'payload_multi',
      messages: [
        { role: 'user', content: '第一句' },
        { role: 'assistant', content: '第一答' },
        { role: 'user', content: '第二句' },
      ],
    });
    const hit = await waitForCapture((c) => c.body?.stream !== false);
    const msgs = hit?.body?.messages ?? [];
    check('完整历史都被带上（system + 3 条）', msgs.length === 4, `${msgs.length} 条`);
    check('历史顺序正确',
      msgs[1]?.content === '第一句' && msgs[2]?.content === '第一答' && msgs[3]?.content === '第二句',
      JSON.stringify(msgs.map((m) => m.content)));
  }

  console.log('\n流式参数');
  {
    const hit = streamed().at(-1);
    check('请求开启了 stream', hit?.body?.stream === true);
    check('指定了模型名', typeof hit?.body?.model === 'string' && hit.body.model.length > 0, hit?.body?.model);
  }
} catch (err) {
  failures.push(`测试中断：${err.message}`);
  console.log(`\n测试中断：${err.stack}`);
} finally {
  server.kill();
  fake.close();
}

console.log(`\n${'─'.repeat(52)}`);
if (failures.length === 0) {
  console.log(`全部通过：${passed} 项断言`);
  process.exit(0);
} else {
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
