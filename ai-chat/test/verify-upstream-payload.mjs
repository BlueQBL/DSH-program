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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 用真实的「请求历史构造函数」拼出这一轮：这样「引用」是走完整链路
// （会话里的消息 → buildRequestHistory → HTTP → 服务端 → 上游）才被验证的，
// 而不是我在测试里手工拼一段字符串再断言它原样到达。
import { buildRequestHistory } from '../public/lib/versions.js';

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
      // 非流式请求（模型探测、起标题）：直接给一个 JSON 响应。
      // 内容特意带引号和句号 —— 正好验证服务端会把标题洗干净再返回。
      if (parsed && parsed.stream === false) {
        res.end(JSON.stringify({ choices: [{ message: { content: '"闭包与作用域。"' } }] }));
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
    // 原始响应留着：出错时断言的详情里能直接看到服务端到底回了什么，
    // 否则「reply 为空」这种情况只能靠猜（400 的 JSON 体也是空 reply）
    status: res.status,
    raw: text.slice(0, 300),
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

  console.log('\n引用回答：划中的那一段必须真的发给模型');
  {
    captured.length = 0;
    const v = (content, extra = {}) => ({ content, attachments: [], createdAt: 0, ...extra });
    // 按客户端的真实调用方式搭这一轮：历史里已有一问一答，末尾是这一轮的新提问，
    // 后面跟一条**空内容**的助手占位消息（它会被跳过 —— 这正是真实流程的样子）
    const q1 = { role: 'user', versions: [v('先解释一下闭包')] };
    const a1 = { role: 'assistant', versions: [v('闭包是函数记住它出生时的环境。')] };
    const q2 = {
      role: 'user',
      versions: [v('那第三点再展开讲讲', { quote: { text: '第三，要注意边界情况。', page: 2 } })],
    };
    const a2 = { role: 'assistant', versions: [v('')] };

    const res = await ask({
      sessionId: 'payload_quote',
      messages: buildRequestHistory([q1, a1, q2, a2], q2, a2),
    });
    check('引用这一轮真的得到了回答', res.reply === '收到了。', JSON.stringify(res));

    const hit = await waitForCapture((c) => c.body?.stream !== false);
    const msgs = hit?.body?.messages ?? [];
    const userMsg = msgs.at(-1);
    check('整轮历史按顺序到达（system + 一问一答 + 带引用的提问）', msgs.length === 4, `${msgs.length} 条`);
    check('引用原文真的到了上游', userMsg?.content?.includes('第三，要注意边界情况。'), String(userMsg?.content));
    check('引用写成 Markdown 引用块（模型能认出这是转引）', /^> /m.test(userMsg?.content ?? ''));
    check('引用的出处（第 2 页）也带上了', userMsg?.content?.includes('第 2 页'), String(userMsg?.content));
    check('用户自己打的问题在引用之后',
      userMsg?.content?.trimEnd().endsWith('那第三点再展开讲讲'), String(userMsg?.content));
    check('引用只加在用户消息上，助手的历史回答原样',
      msgs[2]?.content === '闭包是函数记住它出生时的环境。', String(msgs[2]?.content));
  }

  console.log('\n流式参数');
  {
    const hit = streamed().at(-1);
    check('请求开启了 stream', hit?.body?.stream === true);
    check('指定了模型名', typeof hit?.body?.model === 'string' && hit.body.model.length > 0, hit?.body?.model);
  }

  // 放在最后：这一节会把抓包清空，前面的「流式参数」需要用到之前那批流式请求
  console.log('\n会话标题：一次独立的非流式小请求');
  {
    captured.length = 0;
    const res = await fetch(`${BASE}/api/title`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: '闭包是什么？顺便讲讲作用域',
        answer: '闭包是函数记住它出生时的环境。',
        laterQuestions: ['那变量提升呢'],
      }),
    });
    const data = await res.json();

    check('起标题接口可用', res.status === 200, String(res.status));
    check('返回的标题已经洗干净（引号和句号都去掉了）',
      data.title === '闭包与作用域', JSON.stringify(data));

    const hit = await waitForCapture((c) => c.body?.stream === false);
    const msgs = hit?.body?.messages ?? [];
    check('起标题是非流式请求', hit?.body?.stream === false);
    check('提示词要求只输出标题', /只输出标题/.test(msgs[0]?.content ?? ''), String(msgs[0]?.content).slice(0, 60));
    check('提示词要求用同一种语言', /相同的语言/.test(msgs[0]?.content ?? ''));
    check('把开头的一问一答都给了模型',
      String(msgs[1]?.content ?? '').includes('闭包是什么') && String(msgs[1]?.content ?? '').includes('闭包是函数'),
      String(msgs[1]?.content));
    check('后来问过的事也带上了（标题不用只描述开头）',
      String(msgs[1]?.content ?? '').includes('变量提升'));
    check('输出很短（标题不该烧 token）', Number(hit?.body?.max_tokens) <= 64, String(hit?.body?.max_tokens));

    // 没有 question 时不该去打扰上游
    captured.length = 0;
    const bad = await fetch(`${BASE}/api/title`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: '只有回答' }),
    });
    check('缺 question 直接拒绝', bad.status === 400, String(bad.status));
    check('拒绝时没有发上游请求', captured.length === 0, String(captured.length));
  }

  console.log('\n用户评价：真的写进了服务端的追加日志');
  {
    const readEntries = () => {
      const file = path.join(ROOT, 'data', 'feedback.jsonl');
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    };

    const post = (body) =>
      fetch(`${BASE}/api/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // 用一个唯一标记找自己那条：这个文件是追加写的，历次测试的记录都留在里面
    const marker = `payload-test-${Date.now()}`;
    const res = await post({
      action: 'set',
      sessionId: 'payload_feedback',
      messageId: 'a_1',
      version: 2,
      rating: 'down',
      reasons: ['wrong', 'verbose'],
      note: marker,
      model: 'deepseek-v3.2',
      mode: 'model',
      questionExcerpt: '闭包是什么',
      answerExcerpt: '闭包是函数记住它出生时的环境。',
    });
    const data = await res.json();
    check('反馈接口可用', res.status === 200 && data.ok === true, JSON.stringify(data));

    const entry = readEntries().reverse().find((e) => e.note === marker);
    check('反馈落到了 data/feedback.jsonl', Boolean(entry), '没找到带标记的那一行');
    check('记下了档位与原因', entry?.rating === 'down' && entry?.reasons?.join() === 'wrong,verbose',
      JSON.stringify(entry));
    check('记下了是哪条回答的哪一页', entry?.messageId === 'a_1' && entry?.version === 2);
    check('带上答案开头（否则这条日志没法归因）',
      String(entry?.answerExcerpt ?? '').includes('闭包是函数记住'), String(entry?.answerExcerpt));
    check('带上时间戳', typeof entry?.at === 'string' && entry.at.includes('T'), String(entry?.at));

    // 撤回也要留痕：日志是追加写的，不记这一笔就推不出「最后到底是赞还是踩」
    const clearMarker = `${marker}-clear`;
    const cleared = await post({
      action: 'clear',
      sessionId: 'payload_feedback',
      messageId: 'a_1',
      version: 2,
      reasons: [clearMarker], // 借用原因字段当标记，只为在文件里认出这一条
    });
    check('撤回评价接口可用', cleared.status === 200, String(cleared.status));
    const clearEntry = readEntries().reverse().find((e) => e.reasons?.includes(clearMarker));
    check('撤回也追加了一条事件', clearEntry?.action === 'clear', JSON.stringify(clearEntry));
    check('撤回那条没有档位', clearEntry?.rating === null);

    // 脏数据不该进日志
    const before = readEntries().length;
    const bad = await post({ action: 'set', note: '没有档位' });
    check('没有档位的「记下」被拒绝', bad.status === 400, String(bad.status));
    check('被拒绝的请求没有写进日志', readEntries().length === before, String(readEntries().length - before));
  }
} catch (err) {
  failures.push(`测试中断：${err.message}`);
  console.log(`\n测试中断：${err.stack}`);
} finally {
  server.kill();
  fake.close();
}

// 登记真实断言数，供 test/readme-tests.mjs 核对 README 里的数字。
// 必须用「实际通过了多少」，不能去数字面 check( —— 有的在条件分支里、有的在循环里。
try {
  const dir = path.resolve(HERE, '../.tmp-mutations');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'counts.json');
  const counts = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  counts['verify-upstream-payload'] = { count: passed, failed: failures.length };
  writeFileSync(file, JSON.stringify(counts, null, 2), 'utf8');
} catch {
  /* 写不了不影响测试本身 */
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
