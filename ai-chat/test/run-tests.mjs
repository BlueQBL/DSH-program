// 对谈录 · 自动化测试
//
//   node test/run-tests.mjs
//
// 分三层：
//   1. 纯函数层 —— Markdown 容错解析、离线回答的意图与记忆抽取
//   2. HTTP 层   —— 静态资源、路由、参数校验
//   3. 流式层   —— 真的起一个服务、真的读 SSE，验证「逐字」和「多轮记忆」
//
// 之所以自己起服务而不是复用已运行的实例：测试必须能在随机端口上跑，且不依赖环境变量。

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown, parseBlocks, escapeHtml } from '../public/lib/markdown.js';
import { composeReply, extractFacts, createMockReply } from '../lib/mock-responder.mjs';
import {
  classifyUpstreamError,
  pickModelCandidates,
  shouldTryNextModel,
  filterChatModels,
  isChatModel,
  supportsVision,
  visionModels,
} from '../lib/error-mapping.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// 默认自己在随机端口起一个服务；也可以用 DSH_TEST_BASE 指向一个已经在跑的实例
// （受限沙箱里子进程没法用管道，这时指向外部实例最省事）。
const EXTERNAL_BASE = process.env.DSH_TEST_BASE || '';

/**
 * 取一个大概率空闲的端口。
 * 不用「基准端口 + 固定偏移」：那样容易撞上系统保留端口（5500 就被 Windows 占了），
 * 报出来是「服务起不来」，看着像代码问题，其实是端口问题。
 */
function randomPort() {
  return 40000 + Math.floor(Math.random() * 20000);
}

const PORT = randomPort();
/** 主实例的地址：外部指定则用指定的，否则由 startServerWithRetry 决定（会随重试变化） */
let BASE = EXTERNAL_BASE || `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function group(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------- 1. Markdown

group('Markdown 解析（含流式半截语法）');

{
  const html = renderMarkdown('这是**粗体**和`代码`。');
  check('粗体渲染', html.includes('<strong>粗体</strong>'));
  check('行内代码渲染', html.includes('<code>代码</code>'));
}

{
  // 流到一半：** 还没闭合，必须退化成普通文本，不能吞掉后面的内容
  const html = renderMarkdown('这是**还没闭合的粗体');
  check('未闭合粗体不吞内容', html.includes('还没闭合的粗体') && !html.includes('<strong>'));
}

{
  const html = renderMarkdown('```js\nconst a = 1;\n');
  // 高亮会把 token 包进 span（`1` 变成 <span class="tok-number">1</span>），
  // 所以不能直接比对原文 —— 去掉标签再比
  const plain = html.replace(/<[^>]+>/g, '');
  check('未闭合代码围栏照常渲染', plain.includes('const a = 1;'), plain.slice(0, 80));
  check('未闭合围栏标注书写中', html.includes('书写中'));
  check('未闭合围栏不给语言标签', !html.includes('>js<'));
  // 未闭合时也要上色：流式输出期间「未闭合」才是常态，等闭合才上色等于没有颜色
  check('未闭合围栏也做语法高亮', html.includes('tok-keyword'));
}

{
  const html = renderMarkdown('```js\nconst a = 1;\n```');
  check('闭合围栏显示语言标签', html.includes('>js<'));
  check('闭合围栏有复制按钮', html.includes('data-copy-code'));
}

{
  const html = renderMarkdown('1. 第一\n2. 第二\n\n- 甲\n- 乙');
  check('有序列表', html.includes('<ol>') && html.includes('<li>第一</li>'));
  check('无序列表', html.includes('<ul>') && html.includes('<li>甲</li>'));
}

{
  const html = renderMarkdown('## 标题\n\n> 引用\n\n---');
  check('标题层级', html.includes('<h2>标题</h2>'));
  check('引用块', html.includes('<blockquote>引用</blockquote>'));
  check('分隔线', html.includes('<hr />'));
}

{
  const html = renderMarkdown('<img src=x onerror=alert(1)>' + ' & ' + '"引号"');
  check('HTML 被转义，不做注入', html.includes('&lt;img') && !html.includes('<img'));
  check('& 被转义', html.includes('&amp;'));
  check('escapeHtml 覆盖引号', escapeHtml(`"'`) === '&quot;&#39;');
}

{
  const blocks = parseBlocks('');
  check('空文本解析为空块', Array.isArray(blocks) && blocks.length === 0);
}

{
  const html = renderMarkdown('只有一段话', { streaming: true });
  check('流式状态下有书写光标', html.includes('class="caret"'));
  const closed = renderMarkdown('只有一段话');
  check('非流式状态没有光标', !closed.includes('class="caret"'));
}

{
  // 代码围栏里的内容不能参与行内解析，否则下划线、星号会被吃掉
  const html = renderMarkdown('```\nconst a = *b*;\n```');
  check('代码块内不做行内标记解析', html.includes('*b*') && !html.includes('<em>'));
}

{
  const html = renderMarkdown('看这个 `a**b**c` 例子');
  check('行内代码内的星号不被解析', html.includes('<code>a**b**c</code>'));
}

// ---------------------------------------------------------------- 2. 离线回答

group('离线回答 · 意图与记忆');

{
  const history = [
    { role: 'user', content: '我叫小林，正在学习 Rust' },
    { role: 'assistant', content: '好' },
  ];
  const facts = extractFacts(history);
  check('抽出称呼', facts.get('name')?.value === '小林', `实际：${facts.get('name')?.value}`);
  check('抽出正在学的内容', /Rust/.test(facts.get('learn')?.value ?? ''), `实际：${facts.get('learn')?.value}`);

  // 时间副词组合是容易漏的地方：漏掉任何一个字，匹配会静默失败，表现为「模型没记住」
  const phrasings = [
    ['我正在学习 Rust', 'Rust'],
    ['我在学 Rust', 'Rust'],
    ['我学 Rust', 'Rust'],
    ['我最近在学习 Kubernetes', 'Kubernetes'],
    ['我在学习前端开发', '前端开发'],
    ['我叫小林，正在学习 Rust', 'Rust'],
  ];
  const extracted = phrasings.map(
    ([text]) => extractFacts([{ role: 'user', content: text }]).get('learn')?.value,
  );
  check('各种时间副词措辞都能抽出事实', extracted.every((v) => typeof v === 'string' && v.length > 0),
    JSON.stringify(phrasings.map((p, i) => [p[0], extracted[i]])));
  check('抽出的就是那个技术名词', extracted.every((v, i) => v === phrasings[i][1]),
    JSON.stringify(phrasings.map((p, i) => `${p[0]} → ${extracted[i]}`)));

  const question = extractFacts([{ role: 'user', content: '我叫什么名字' }]);
  check('提问不会被误存成事实', !question.has('name'), `实际：${question.get('name')?.value}`);
}

{
  const reply = composeReply([
    { role: 'user', content: '我叫小林' },
    { role: 'assistant', content: '好' },
    { role: 'user', content: '我叫什么名字？' },
  ]);
  check('问名字时回到上文回答', reply.includes('小林'), `实际：${reply}`);
}

{
  const reply = composeReply([
    { role: 'user', content: '帮我看看防抖怎么写' },
    { role: 'assistant', content: '好' },
    { role: 'user', content: '我刚才说了什么？' },
  ]);
  check('问「我刚才说了什么」时引用原话', reply.includes('防抖'), `实际：${reply}`);
}

{
  const reply = composeReply([
    { role: 'user', content: '记住我最喜欢的编辑器是 Vim' },
    { role: 'assistant', content: '好' },
    { role: 'user', content: '我刚才说了什么' },
  ]);
  check('记住了用户主动要求记住的内容', reply.includes('Vim'), `实际：${reply}`);
}

{
  const reply = composeReply([{ role: 'user', content: '闭包是什么' }]);
  check('命中知识小抄时给出结构化回答', reply.includes('闭包') && reply.includes('作用域'));
  check('离线回答明确声明自己不是真实模型', reply.includes('离线') || reply.includes('本地'));
}

{
  const reply = composeReply([{ role: 'user', content: '今天北京天气怎么样' }]);
  check('无数据能力时拒绝编造', /编|拿不到|没有数据|接一个/.test(reply), `实际：${reply}`);
}

{
  const reply = composeReply([{ role: 'user', content: '你好' }]);
  check('问候语有专门回应', reply.includes('你好'), `实际：${reply}`);
}

{
  const replies = new Set();
  for (const q of ['我叫什么名字', '我刚才说了什么', '你会什么', '你好', '闭包是什么']) {
    replies.add(composeReply([{ role: 'user', content: q }]));
  }
  check('不同意图给出不同回答（不是同一个模板）', replies.size === 5, `实际种类：${replies.size}`);
}

{
  const reply = composeReply([{ role: 'user', content: '' }]);
  check('空输入不抛异常', typeof reply === 'string' && reply.length > 0);
}

{
  // 生成器的产出契约：必须是 { text } / { error } 对象。
  // 这一条如果没人看着，错了也不会报错 —— 消费端只会静默丢弃，界面上表现为「空回复」。
  const pieces = [];
  for await (const piece of createMockReply([{ role: 'user', content: '闭包是什么' }], {})) {
    pieces.push(piece);
  }
  const allObjects = pieces.every((p) => p && typeof p === 'object');
  check('离线生成器产出的是对象分片（不是裸字符串）', allObjects,
    `首个分片：${JSON.stringify(pieces[0])}`);
  check('对象分片带 text 字段', pieces.every((p) => typeof p.text === 'string' && p.text.length > 0));
  check('分片拼起来等于完整回答',
    pieces.map((p) => p.text).join('') === composeReply([{ role: 'user', content: '闭包是什么' }]));
  check('离线回答被切成足够多的块（逐字输出）', pieces.length > 20, `实际：${pieces.length} 块`);
}

// ---------------------------------------------------------------- 上游错误分类

group('上游错误分类（决定用户看到什么提示）');

{
  // 真实案例：某代理在 default 分组下没有 deepseek-chat，返回 503 + model_not_found。
  // 旧代码只看 HTTP 状态码，把它当成「服务暂时不可用，稍后重试」——
  // 用户会去等一个永远不会好的东西。这类失败必须点出模型名，且标记为不可重试。
  const verdict = classifyUpstreamError({
    status: 503,
    model: 'deepseek-chat',
    baseUrl: 'https://api.openai-hk.com/v1',
    body: JSON.stringify({
      error: { message: '分组 default 下模型 deepseek-chat 无可用渠道（distributor）', type: 'new_api_error', code: 'model_not_found' },
    }),
  });
  check('模型不存在被单独识别', verdict.reason === 'model', `实际：${verdict.reason}`);
  check('模型不存在不标为可重试', verdict.retryable === false);
  check('提示里点出是哪个模型', verdict.message.includes('deepseek-chat'));
  check('提示里给出可用的替代方案', /模型选择框|\/api\/models|AI_MODEL/.test(verdict.message), verdict.message);
  check('提示里指向 /api/models', verdict.message.includes('/api/models'));
  check('保留了上游的原始说明', verdict.message.includes('无可用渠道'));
}

{
  const verdict = classifyUpstreamError({
    status: 401,
    model: 'gpt-4o',
    body: JSON.stringify({ error: { message: 'key error please check', type: 'hk_api_error' } }),
  });
  check('Key 错误被识别为认证问题', verdict.reason === 'auth', `实际：${verdict.reason}`);
  check('认证问题不可重试', verdict.retryable === false);
  check('认证提示指向要改的环境变量', /DEEPSEEK_API_KEY|OPENAI_API_KEY/.test(verdict.message));
}

{
  const verdict = classifyUpstreamError({
    status: 402,
    body: JSON.stringify({ error: { message: 'Insufficient balance' } }),
  });
  check('余额不足被识别', verdict.reason === 'quota', `实际：${verdict.reason}`);
  check('余额提示给出离线退路', /清空|离线/.test(verdict.message));
}

{
  const verdict = classifyUpstreamError({
    status: 429,
    body: JSON.stringify({ error: { message: 'rate limit exceeded' } }),
  });
  check('限流被识别且可重试', verdict.reason === 'rate' && verdict.retryable === true, `实际：${verdict.reason}`);
}

{
  const verdict = classifyUpstreamError({ status: 502, body: 'Bad Gateway' });
  check('纯 5xx 才算上游临时故障', verdict.reason === 'upstream' && verdict.retryable === true);
  check('非 JSON 响应也被截取展示', verdict.message.includes('Bad Gateway'));
}

{
  const verdict = classifyUpstreamError({ status: 0, baseUrl: 'https://example.invalid/v1', cause: 'ENOTFOUND' });
  check('网络不可达被识别', verdict.reason === 'network', `实际：${verdict.reason}`);
  check('网络提示带上目标地址', verdict.message.includes('https://example.invalid/v1'));
  check('网络提示带上底层原因', verdict.message.includes('ENOTFOUND'));
}

// ---------------------------------------------------------------- 模型候选

group('模型候选与兜底');

{
  const list = pickModelCandidates({ configured: '' });
  check('未指定时默认模型排第一', list[0] === 'deepseek-v4.1-flash', list[0]);
  check('默认链里有已知可用的后备', list.includes('deepseek-v3.2') && list.includes('deepseek-v4-flash'));
  check('默认链无重复', new Set(list).size === list.length);
}

{
  const list = pickModelCandidates({ configured: 'my-model' });
  check('指定的模型排在第一位', list[0] === 'my-model');
  check('指定后仍保留后备', list.length > 1 && !list.slice(1).includes('my-model'));
}

{
  const list = pickModelCandidates({ configured: 'a', override: 'x, y ,z' });
  check('override 完全接管候选链', JSON.stringify(list) === JSON.stringify(['x', 'y', 'z']), JSON.stringify(list));
}

{
  check('模型不存在才换模型', shouldTryNextModel({ reason: 'model' }) === true);
  check('认证失败不换模型', shouldTryNextModel({ reason: 'auth' }) === false);
  check('限流不换模型', shouldTryNextModel({ reason: 'rate' }) === false);
  check('网络故障不换模型', shouldTryNextModel({ reason: 'network' }) === false);
}

// ---------------------------------------------------------------- 模型选择框的过滤

group('模型选择框：只列可聊天的模型');

{
  // OpenAI-HK 这类聚合代理会列出 156 个模型，其中一大半选中也没用。
  // 不滤掉的话，用户会选到「画图模型」然后收到一个跟操作对不上的报错。
  const upstream = [
    'deepseek-v3.2', 'deepseek-v4-flash', 'deepseek-v4.1-flash', 'deepseek-r1', 'deepseek-chat',
    'gpt-4o', 'gpt-4o-mini', 'gpt-5.4', 'claude-sonnet-4-5', 'gemini-2.5-pro', 'grok-4',
    'dall-e-3', 'gpt-image-1', 'gpt-image-2.5-sunburst', 'nano-banana-2', 'sora_image', 'sora_video2',
    'tts-1', 'tts-1-hd', 'whisper-1', 'text-embedding-3-large', 'text-embedding-ada-002',
    'text-moderation-latest', 'o1-mini',
  ];
  const chat = filterChatModels(upstream);

  check('聊天模型全部保留',
    ['deepseek-v3.2', 'deepseek-v4-flash', 'deepseek-v4.1-flash', 'deepseek-r1', 'deepseek-chat',
      'gpt-4o', 'gpt-4o-mini', 'gpt-5.4', 'claude-sonnet-4-5', 'gemini-2.5-pro', 'grok-4', 'o1-mini']
      .every((m) => chat.includes(m)),
    JSON.stringify(chat));

  for (const junk of ['dall-e-3', 'gpt-image-1', 'nano-banana-2', 'sora_image', 'tts-1', 'text-embedding-3-large', 'text-moderation-latest']) {
    check(`过滤掉非聊天模型 ${junk}`, !chat.includes(junk));
  }

  check('过滤后没有误伤 deepseek-chat', isChatModel('deepseek-chat') === true);
  check('空/非法输入不抛异常', filterChatModels(null).length === 0 && isChatModel('') === false);
  check('结果去重且保持原顺序', JSON.stringify(filterChatModels(['a', 'a', 'b'])) === JSON.stringify(['a', 'b']));
}

// ---------------------------------------------------------------- 多模态与图片支持

group('离线回答 · 多模态消息');

{
  // 服务端带图片时会把 content 转成 [{type:'text'},{type:'image_url'}]，
  // 离线回答器必须能读出来 —— 否则抽取逻辑读到 undefined，静默退化成空回答
  const multimodal = [
    {
      role: 'user',
      content: [
        { type: 'text', text: '我叫小林' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
      ],
    },
  ];
  check('能从多模态数组里抽出文字事实', extractFacts(multimodal).get('name')?.value === '小林',
    JSON.stringify([...extractFacts(multimodal).entries()]));

  const reply = composeReply(multimodal);
  check('带图的消息不会让离线回答空掉', reply.length > 20, `长度 ${reply.length}`);

  const onlyImage = composeReply([
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] },
  ]);
  check('只发图时明确说明看不了图', onlyImage.includes('看不了图片'));
  check('只发图时给出可看图的模型建议', onlyImage.includes('gpt-4o'));
}

group('图片支持判断');

{
  check('DeepSeek 全系不支持图片（真实限制）',
    ['deepseek-v3.2', 'deepseek-v4.1-flash', 'deepseek-r1', 'deepseek-chat'].every((m) => supportsVision(m) === false));
  check('gpt-4o / gemini / claude 支持图片',
    ['gpt-4o', 'gpt-4o-mini', 'gemini-2.5-flash', 'claude-sonnet-4-5'].every((m) => supportsVision(m) === true));
  check('从模型列表里挑出可看图的', visionModels(['deepseek-v3.2', 'gpt-4o', 'gemini-3-flash']).length === 2);
  check('空输入不崩', supportsVision('') === false && visionModels(null).length === 0);
}

// ---------------------------------------------------------------- HTTP 与流式

function startServer(env = {}) {
  // stdio 用 ignore：既不需要把子进程输出接管道（受限沙箱下会 EPERM），
  // 也让服务端日志不至于和测试输出混在一起。启动失败由健康检查兜底。
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), ...env },
    stdio: 'ignore',
  });
  return { child };
}

/**
 * 起一个服务实例并等它健康，返回 { child, base } 与一个 stop()。
 *
 * 带端口重试：随机端口有小概率撞上被占用的端口，而 stdio 是 ignore 的，
 * 看不到 EADDRINUSE，只会表现为「起不来」—— 那是最难查的那种偶发失败。
 */
async function startServerWithRetry(env = {}, { attempts = 4 } = {}) {
  for (let i = 1; i <= attempts; i += 1) {
    const port = randomPort();
    const { child } = startServer({ ...env, PORT: String(port) });
    const base = `http://127.0.0.1:${port}`;
    if (await waitForServer(6000, base)) {
      return { child, base, stop: () => child.kill() };
    }
    child.kill();
  }
  return null;
}
async function waitForServer(timeoutMs = 8000, base = BASE) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** 读一条 SSE 流，返回所有事件 */
async function collectStream(body, { abortAfterMs = 0 } = {}) {
  const controller = new AbortController();
  if (abortAfterMs) setTimeout(() => controller.abort(), abortAfterMs);

  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal,
  });

  const events = [];
  const stamps = [];
  if (!res.ok || !res.body) return { status: res.status, events, stamps, text: '' };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            const event = JSON.parse(line.slice(5).trim());
            events.push(event);
            stamps.push(Date.now());
            if (event.type === 'delta') text += event.text;
          } catch {
            /* 忽略半截帧 */
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  }

  return { status: res.status, events, stamps, text };
}

/**
 * 用原始 socket 读一次对话流，精确记录每个 TCP 数据段的到达时刻。
 *
 * 为什么不复用 fetch：undici 会把多个响应块合并成一次 reader.read()，
 * 于是「逐字」这件事在 fetch 层量不出来 —— 收到 10 个增量可能只触发 2 次 read。
 * 要看服务端是不是真的一段一段 flush 出来，必须往下一层看。
 */
function collectStreamRaw(body, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/chat', BASE);
    const payload = JSON.stringify(body);
    const socket = net.connect(Number(url.port), url.hostname);
    const segments = [];
    const startedAt = Date.now();
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs, () => finish({ error: '超时' }));
    socket.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    socket.on('connect', () => {
      socket.write(
        `POST /api/chat HTTP/1.1\r\n` +
          `Host: ${url.host}\r\n` +
          `Content-Type: application/json\r\n` +
          `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
          `Accept: text/event-stream\r\n` +
          `Connection: close\r\n\r\n` +
          payload,
      );
    });

    socket.on('data', (chunk) => {
      segments.push({ at: Date.now() - startedAt, bytes: chunk.length, text: chunk.toString('utf8') });
      // 收到 done 帧就够了，不必等连接关闭
      if (chunk.includes('"type":"done"')) finish({ segments, ok: true });
    });

    socket.on('close', () => {
      if (!settled) {
        settled = true;
        resolve({ segments, ok: segments.length > 0 });
      }
    });
  });
}

const server = EXTERNAL_BASE ? null : await startServerWithRetry();
if (server) BASE = server.base;

try {
  const up = await waitForServer(6000);
  group('HTTP 层');
  check('服务能启动', up);
  if (!up) throw new Error(`服务未启动：${BASE}（检查端口是否被占用）`);

  {
    const res = await fetch(`${BASE}/api/config`);
    const config = await res.json();
    check('未配置 Key 时自动降级为离线模式', config.mode === 'mock', `实际：${config.mode}`);
    check('config 附带接入提示', typeof config.hint === 'string' && config.hint.length > 0);
  }

  {
    const res = await fetch(`${BASE}/`);
    const html = await res.text();
    check('首页可访问', res.ok && html.includes('对谈录'));
    check('首页引用了前端模块', html.includes('app.js'));

    // app.js 按这些选择器取 DOM。少一个不会报错，只会让某个字段永远空白 ——
    // 所以在这里钉住，改动模板时能被立刻发现。
    const requiredHooks = [
      'id="exchanges"', 'id="composer-input"', 'id="send-button"', 'id="stop-button"',
      'id="clear-button"', 'id="mode-chip"', 'id="confirm-strip"', 'id="reach-bottom"',
      'id="exchange-template"', 'id="blank-sheet"', 'id="starters"', 'id="export-button"',
      'id="notice"', 'data-field="number"', 'data-field="asked-at"', 'data-field="question"',
      'data-field="answer"', 'data-field="answer-timing"', 'data-field="answer-status"',
      'data-field="answer-actions"', 'data-action="copy"', 'data-action="retry"',
    ];
    const missing = requiredHooks.filter((hook) => !html.includes(hook));
    check('模板与 app.js 的选择器全部对得上', missing.length === 0, `缺少：${missing.join(', ')}`);
  }

  {
    const res = await fetch(`${BASE}/lib/markdown.js`);
    check('子目录静态资源可访问', res.ok && res.headers.get('content-type').includes('javascript'));
  }

  {
    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'assistant', content: '没有用户提问' }] }),
    });
    check('messages 不以 user 结尾时返回 400', res.status === 400, `实际：${res.status}`);
  }

  {
    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '不是 JSON',
    });
    check('非法 JSON 返回 400', res.status === 400, `实际：${res.status}`);
  }

  {
    const res = await fetch(`${BASE}/api/history/bad!!id`);
    check('非法 sessionId 返回 400', res.status === 400, `实际：${res.status}`);
  }

  {
    const res = await fetch(`${BASE}/api/models`);
    const data = await res.json();
    check('离线模式下列表为空但接口不报错', res.ok && Array.isArray(data.models) && data.models.length === 0,
      JSON.stringify(data).slice(0, 120));
    check('离线模式给出说明（页面据此隐藏选择框）', typeof data.note === 'string' && data.note.length > 0);
    check('报告当前模式', data.mode === 'mock', data.mode);
  }

  group('流式层');

  const session = `t_${Date.now().toString(36)}`;
  const first = await collectStream({ messages: [{ role: 'user', content: '我叫小林，正在做一个记账工具' }], sessionId: session });

  check('返回 200', first.status === 200, `实际：${first.status}`);
  check('首帧是 meta，声明模式', first.events[0]?.type === 'meta' && first.events[0]?.mode === 'mock');
  check('末帧是 done', first.events.at(-1)?.type === 'done', `实际：${first.events.at(-1)?.type}`);

  const deltas = first.events.filter((e) => e.type === 'delta');
  check('回答被切成多个增量块（逐字输出）', deltas.length >= 10, `实际块数：${deltas.length}`);
  check('存在 stop 结束原因', first.events.at(-1)?.reason === 'stop');
  check('增量拼起来是一段完整回答', first.text.length > 30, `实际长度：${first.text.length}`);

  {
    // 服务端是不是真的一段一段 flush 出来 —— 只在原始 socket 层量得到
    const raw = await collectStreamRaw({
      messages: [{ role: 'user', content: '闭包是什么' }],
      sessionId: `${session}_raw`,
    });
    const chunks = (raw.segments ?? []).filter((s) => s.text.includes('"type":"delta"'));
    check('原始连接收到多个独立数据段', chunks.length >= 5, `实际段数：${chunks.length}`);

    const span = chunks.length ? chunks.at(-1).at - chunks[0].at : 0;
    check('数据段随时间陆续到达（不是一次性 flush）', span > 200, `实际跨度：${span}ms`);

    const gaps = chunks.slice(1).map((s, i) => s.at - chunks[i].at);
    const maxGap = gaps.length ? Math.max(...gaps) : 0;
    check('相邻数据段之间有真实间隔', maxGap > 0 || span > 200, `最大间隔 ${maxGap}ms`);

    // 首帧（meta）必须早于第一个增量，客户端才能先拿到模式信息
    const metaIndex = (raw.segments ?? []).findIndex((s) => s.text.includes('"type":"meta"'));
    const firstDeltaIndex = (raw.segments ?? []).findIndex((s) => s.text.includes('"type":"delta"'));
    check('meta 帧先于增量到达', metaIndex !== -1 && metaIndex <= firstDeltaIndex, `meta@${metaIndex} delta@${firstDeltaIndex}`);

    await fetch(`${BASE}/api/history/${session}_raw`, { method: 'DELETE' }).catch(() => {});
  }

  {
    const res = await fetch(`${BASE}/api/history/${session}`);
    const saved = await res.json();
    check('服务端留下兜底副本', Array.isArray(saved.turns) && saved.turns.length >= 2, `实际：${JSON.stringify(saved).slice(0, 120)}`);
    check('兜底副本含用户提问', saved.turns.some((t) => t.role === 'user' && t.content.includes('小林')));
    check('兜底副本含助手回答', saved.turns.some((t) => t.role === 'assistant' && t.content.length > 10));
  }

  {
    // 多轮：把上一轮带回上下文，让助手「记得」
    const second = await collectStream({
      sessionId: session,
      messages: [
        { role: 'user', content: '我叫小林，正在做一个记账工具' },
        { role: 'assistant', content: first.text },
        { role: 'user', content: '我叫什么名字？' },
      ],
    });
    check('第二轮能回到上文回答出名字', second.text.includes('小林'), `实际：${second.text.slice(0, 120)}`);
  }

  {
    const third = await collectStream({
      sessionId: session,
      messages: [
        { role: 'user', content: '我发现了一个很难复现的 bug' },
        { role: 'assistant', content: '说说看' },
        { role: 'user', content: '我刚才说了什么？' },
      ],
    });
    check('能引用更早的原话', third.text.includes('bug'), `实际：${third.text.slice(0, 160)}`);
  }

  {
    // 中途挂断：客户端断开后服务端不能崩、不能继续占着连接
    const partial = await collectStream(
      { messages: [{ role: 'user', content: '闭包是什么' }], sessionId: `${session}_abort` },
      { abortAfterMs: 400 },
    );
    check('客户端中途断开时服务端不报错', !server || server.child.exitCode === null, `exitCode=${server?.child.exitCode}`);
    const still = await fetch(`${BASE}/api/health`);
    check('断开后服务仍然健康', still.ok);
    check('断开是客户端行为（收到过增量）', partial.events.some((e) => e.type === 'delta'));
  }

  {
    // 离线模式下带 model 字段不应报错，也不该试图去调上游
    const offline = await collectStream({
      sessionId: `${session}_model`,
      messages: [{ role: 'user', content: '你好' }],
      model: 'some-model',
    });
    check('离线模式下指定模型被安全忽略', offline.events.at(-1)?.type === 'done' && offline.text.length > 0);
    await fetch(`${BASE}/api/history/${session}_model`, { method: 'DELETE' }).catch(() => {});
  }

  {
    // 非法模型名不能原样进上游请求体
    const weird = await collectStream({
      sessionId: `${session}_weird`,
      messages: [{ role: 'user', content: '你好' }],
      model: 'bad model\n{"injected":true}',
    });
    const meta = weird.events.find((e) => e.type === 'meta');
    check('非法模型名被拒绝并回落默认', meta?.requestedModel === null, JSON.stringify(meta));
    await fetch(`${BASE}/api/history/${session}_weird`, { method: 'DELETE' }).catch(() => {});
  }

  {
    // 图片：只接受 png/jpeg/webp/gif 的 dataURL，其他一律丢掉
    const mixed = await collectStream({
      sessionId: `${session}_img`,
      messages: [
        {
          role: 'user',
          content: '这是什么',
          images: [
            'data:image/png;base64,iVBORw0KGgo=',
            'data:text/html;base64,PHNjcmlwdD4=',
            'javascript:alert(1)',
            'data:image/svg+xml;base64,PHN2Zz4=',
          ],
        },
      ],
    });
    check('非法图片被过滤，只留合法的', mixed.events.find((e) => e.type === 'meta')?.images === 1,
      JSON.stringify(mixed.events.find((e) => e.type === 'meta')));
    check('过滤后仍能正常生成回答', mixed.text.length > 0);
    await fetch(`${BASE}/api/history/${session}_img`, { method: 'DELETE' }).catch(() => {});
  }

  {
    // 超长 systemPrompt 要被截断，而不是把整轮请求撑爆
    const longPrompt = await collectStream({
      sessionId: `${session}_prompt`,
      messages: [{ role: 'user', content: '你好' }],
      systemPrompt: 'x'.repeat(50000),
    });
    check('超长系统提示词不会让请求失败', longPrompt.events.at(-1)?.type === 'done' && longPrompt.text.length > 0);
    await fetch(`${BASE}/api/history/${session}_prompt`, { method: 'DELETE' }).catch(() => {});
  }

  {
    // 失败路径必须也能被客户端识别出来。
    // 客户端靠 done.reason 判断这轮算不算成功 ——
    // 早期客户端只看 done 到没到，于是错误文案被吞掉，用户只看到「没有收到任何内容」。
    // 这里专门起一个「配了 Key 但上游不可达」的实例，走的是真实模型分支。
    //
    // 注意把 AI_MODEL_CANDIDATES 收成单个模型：否则候选链里的其他模型会依次去撞
    // 127.0.0.1:9，测试会白等好几轮超时。
    const failEnv = {
      DEEPSEEK_API_KEY: 'definitely-not-a-real-key', // 明显不像密钥，避免被密钥扫描器误报
      AI_BASE_URL: 'http://127.0.0.1:9/v1', // 保留端口，必定连不上
      AI_MODEL: 'test-model',
      AI_MODEL_CANDIDATES: 'test-model',
    };
    const failInstance = EXTERNAL_BASE ? null : await startServerWithRetry(failEnv);

    try {
      if (!failInstance) {
        check('无效 Key 实例能启动', false, '三次尝试都没起来（端口冲突或启动失败）');
      } else {
        const failBase = failInstance.base;
        const config = await (await fetch(`${failBase}/api/config`)).json();
        check('配了 Key 就走真实模型分支', config.mode === 'model', `实际：${config.mode}`);

        const controller = new AbortController();
        const res = await fetch(`${failBase}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: '测试失败路径' }] }),
          signal: controller.signal,
        });
        const raw = await res.text();
        const frames = raw
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

        const errorFrame = frames.find((f) => f.type === 'error');
        const doneFrame = frames.find((f) => f.type === 'done');
        check('上游不可达时发出 error 帧', Boolean(errorFrame), JSON.stringify(frames));
        check('错误文案可操作（说明该改什么）',
          Boolean(errorFrame) && /API_BASE_URL|DEEPSEEK_API_KEY|网络|代理/.test(errorFrame.message),
          errorFrame?.message);
        check('失败时 done.reason 是 error', doneFrame?.reason === 'error', `实际：${doneFrame?.reason}`);
        check('失败时没有伪造任何正文', !frames.some((f) => f.type === 'delta'));
      }
    } finally {
      failInstance?.stop();
    }
  }

  {
    const res = await fetch(`${BASE}/api/history/${session}`, { method: 'DELETE' });
    check('DELETE 历史返回 ok', res.ok);
    const after = await (await fetch(`${BASE}/api/history/${session}`)).json();
    check('删除后兜底副本为空', Array.isArray(after.turns) && after.turns.length === 0);
  }

  {
    await fetch(`${BASE}/api/history/${session}_abort`, { method: 'DELETE' });
  }
} catch (err) {
  failures.push(`测试中断：${err.message}`);
  console.log(`\n测试中断：${err.stack}`);
} finally {
  server?.child.kill();
}

// ---------------------------------------------------------------- 汇总

console.log(`\n${'─'.repeat(52)}`);
if (failures.length === 0) {
  console.log(`全部通过：${passed} 项断言`);
  process.exit(0);
} else {
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
