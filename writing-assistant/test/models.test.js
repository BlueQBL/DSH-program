'use strict';

/**
 * 模型注册表的测试：列表过滤与排序、缓存、启动探测、请求级选择。
 * 用替换 globalThis.fetch 的方式喂假上游，不联网。
 * 运行：node test/models.test.js
 */

const assert = require('assert');
const Llm = require('../lib/llm.js');

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

/** 一个可控的假上游：能记下每次请求，能按模型名返回不同状态 */
function fakeUpstream(plan) {
  const calls = [];
  const state = {
    listStatus: 200,
    listBody: { data: [] },
    failModels: {},
    reply: '好的。',
  };
  const impl = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    calls.push({ url: String(url), model: body.model, stream: Boolean(body.stream), messages: body.messages || [] });
    if (String(url).endsWith('/models')) {
      return {
        ok: state.listStatus === 200,
        status: state.listStatus,
        text: async () => JSON.stringify(state.listBody),
        json: async () => state.listBody,
      };
    }
    const forced = state.failModels[body.model];
    if (forced) {
      return { ok: false, status: forced, text: async () => JSON.stringify({ error: { message: 'nope' } }) };
    }
    if (body.stream) {
      const pieces = [state.reply.slice(0, 2), state.reply.slice(2)];
      return {
        ok: true,
        status: 200,
        body: (async function* gen() {
          for (const p of pieces) {
            yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`, 'utf8');
          }
          yield Buffer.from('data: [DONE]\n\n', 'utf8');
        })(),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: state.reply } }] }),
      text: async () => JSON.stringify({ choices: [{ message: { content: state.reply } }] }),
    };
  };
  return { impl, calls, state, plan };
}

const LIVE = {
  live: true,
  apiKey: 'sk-test',
  baseUrl: 'http://fake.local/v1',
  model: 'deepseek-chat',
  reason: '测试用',
};
const OFFLINE = { live: false, apiKey: '', baseUrl: '', model: 'deepseek-chat', reason: '未检测到 API Key' };

(async function main() {
  const realFetch = globalThis.fetch;
  console.log('模型列表的过滤与排序');

  await group('列表里的向量、语音、画图、审核模型被滤掉', () => {
    const list = [
      'deepseek-chat',
      'text-embedding-3-small',
      'whisper-1',
      'tts-1',
      'dall-e-3',
      'gpt-4o-audio-preview',
      'text-moderation-latest',
      'bge-m3',
      'gpt-4o-mini',
      'qwen-max',
      'stable-diffusion-xl',
      'sora-1',
    ];
    const chat = Llm.filterChatModels(list);
    eq(chat, ['deepseek-chat', 'gpt-4o-mini', 'qwen-max'], '只留下能写字的');
    eq(Llm.filterChatModels(['', null, undefined, 12]), [], '非字符串一律丢掉');
  });

  await group('排序：默认模型最前，其次是通用模型，最后按名字排', () => {
    const list = ['zzz-custom', 'qwen-max', 'gpt-4o-mini', 'deepseek-chat', 'claude-3-5-sonnet', 'aaa-custom'];
    eq(
      Llm.sortModelCandidates(list, 'qwen-max'),
      ['qwen-max', 'deepseek-chat', 'gpt-4o-mini', 'claude-3-5-sonnet', 'aaa-custom', 'zzz-custom'],
      '默认模型提到最前，未知模型按名字排'
    );
    eq(Llm.rankModel('deepseek-chat', ''), 0, 'deepseek-chat 排最前');
    eq(Llm.rankModel('任意模型', '任意模型'), -1, '被指定的模型排在最前');
    ok(Llm.rankModel('gpt-4o-mini', '') < Llm.rankModel('完全没听过', ''), '常见模型优于陌生模型');
  });

  await group('上游报错翻成人话', () => {
    const unauthorized = Llm.describeStatus(401, '');
    ok(unauthorized.includes('API Key'), '401 指向 Key');
    ok(unauthorized.includes('AI_BASE_URL'), '401 提醒别家平台的 Key 要配 AI_BASE_URL');
    ok(Llm.describeStatus(402, '').includes('余额'), '402 指向余额');
    const notFound = Llm.describeStatus(404, '');
    ok(notFound.includes('AI_MODEL'), '404 指向模型名');
    ok(notFound.includes('AI_BASE_URL'), '404 也提醒地址可能不对');
    ok(Llm.describeStatus(429, '').includes('频繁'), '429 指向限流');
    ok(Llm.describeStatus(503, 'busy').includes('暂时不可用'), '5xx 说是上游的问题');
    ok(Llm.describeStatus(500, 'upstream boom').includes('upstream boom'), '错误正文被带上');
    ok(Llm.describeStatus(418, 'teapot').includes('418'), '没见过的状态码原样带出');
  });

  await group('默认上游：不设 AI_BASE_URL 就是 DeepSeek 官网，设了才换平台', () => {
    const onlyKey = Llm.readConfig({ DEEPSEEK_API_KEY: 'x' });
    eq(onlyKey.baseUrl, 'https://api.deepseek.com/v1', '只给 Key 时打的是 DeepSeek 官网');
    eq(onlyKey.model, 'deepseek-chat', '默认模型名');
    eq(Llm.readConfig({ OPENAI_API_KEY: 'x' }).baseUrl, 'https://api.deepseek.com/v1', '换成这个 Key 变量名也一样');
    eq(Llm.readConfig({}).live, false, '没 Key 就是离线');

    // 代码里不写死任何具体平台：整个 llm.js 只应存在一个上游地址字面量，且可被覆盖
    const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'llm.js'), 'utf8');
    const urls = source.match(/https?:\/\/[a-z0-9.:/-]+/gi) || [];
    eq(urls, ['https://api.deepseek.com/v1'], '源码里只有一个默认上游地址');
    eq(/openai-hk\.com/i.test(source), false, '没有写死 OpenAI-HK 的地址');
    eq(/api\.openai\.com/.test(source), false, '也没有写死 OpenAI 官方地址');

    const hk = Llm.readConfig({
      DEEPSEEK_API_KEY: 'x',
      AI_BASE_URL: 'https://api.openai-hk.com/v1',
      AI_MODEL: 'gpt-4o-mini',
    });
    eq(hk.baseUrl, 'https://api.openai-hk.com/v1', '设了 AI_BASE_URL 就走它');
    eq(hk.model, 'gpt-4o-mini', '模型名也听环境变量的');
    eq(hk.live, true, '照样是真实模型模式');
  });

  await group('卡住时的提示报的是真实秒数（不是写死的 60）', async () => {
    const http = require('node:http');
    const hang = http.createServer(() => {
      /* 收下请求但永不响应，专门用来触发停顿保护 */
    });
    await new Promise((r) => hang.listen(0, '127.0.0.1', r));
    const port = hang.address().port;
    try {
      await Llm.chatOnce({
        apiKey: 'x',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        stallMs: 2000,
      });
      failures.push('期望卡住超时，实际却成功了');
    } catch (err) {
      ok(err.message.includes('卡住'), '说明是卡住而不是别的错');
      ok(err.message.includes('2 秒'), `报的是真实秒数：${err.message}`);
      ok(!err.message.includes('60 秒'), '不是写死的 60 秒');
    } finally {
      hang.close();
    }
  });

  await group('凭据脱敏：上游把 Key 回带进错误体时不会漏到界面和日志', () => {
    // 假 Key 一律用拼接构造：写成完整字面量的话，仓库的密钥扫描器会把测试文件
    // 报成「高危命中」，那正是 tools/scan-secrets.mjs 里警告的自造噪声。
    const fake = (...parts) => parts.join('');
    const KEY = fake('sk-', 'live-', 'AbCdEf1234567890xyz');

    const leaked = JSON.stringify({ error: { message: 'bad auth', authorization: `Bearer ${KEY}` } });
    const text = Llm.describeStatus(401, leaked, KEY);
    ok(!text.includes(KEY), '整串 Key 被抹掉');
    ok(!text.includes('AbCdEf1234567890'), 'Key 的主体也没留下');
    ok(text.includes('API Key'), '仍然说清了是什么问题');

    eq(Llm.redact('key=' + KEY, KEY), 'key=***', '传入的 Key 会被整体替换');
    eq(Llm.redact('Authorization: Bearer ' + fake('sk-', 'abcdef123456'), ''), 'Authorization: Bearer ***', 'Bearer 后面的东西一律抹掉');
    eq(Llm.redact('用了 ' + fake('hk-', 'abcdef1234567890') + ' 这个 Key', ''), '用了 hk-*** 这个 Key', 'hk- 前缀也认');
    eq(Llm.redact('token: ' + fake('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxIn0', '.', 'abcd1234'), ''), 'token: ***', 'JWT 形态也抹');
    eq(Llm.redact(fake('AKIA', 'IOSFODNN7EXAMPLE') + ' 与 ' + fake('AIza', 'SyA1234567890abcdefghijklmnopqrst'), ''), '*** 与 ***', '云厂商密钥形态也抹');
    eq(Llm.redact('普通文本照旧，价格 12.5 元', ''), '普通文本照旧，价格 12.5 元', '不是密钥的文本不动它');
    eq(Llm.redact('', ''), '', '空文本不炸');
    eq(Llm.redact(null, ''), '', 'null 不炸');
  });

  console.log('注册表：列表缓存');

  await group('列表拿到后会缓存，不会每次刷新都去问上游', async () => {
    const fake = fakeUpstream();
    fake.state.listBody = { data: [{ id: 'b-model' }, { id: 'whisper-1' }, { id: 'a-model' }] };
    globalThis.fetch = fake.impl;
    const reg = Llm.createModelRegistry(LIVE, { log: () => {} });

    const first = await reg.list();
    eq(first.ok, true, '第一次成功');
    eq(first.chat, ['a-model', 'b-model'], '滤掉不能写字的，其余按名字排');
    eq(fake.calls.length, 1, '只问了一次上游');

    const second = await reg.list();
    eq(second.cached, true, '第二次走缓存');
    eq(fake.calls.length, 1, '没有再问上游');

    const forced = await reg.list(true);
    eq(forced.cached, undefined, '强制刷新不吃缓存');
    eq(fake.calls.length, 2, '强制刷新会再问一次');
    globalThis.fetch = realFetch;
  });

  await group('列表拿不到时不抛错，返回可读原因', async () => {
    const fake = fakeUpstream();
    fake.state.listStatus = 429;
    globalThis.fetch = fake.impl;
    const reg = Llm.createModelRegistry(LIVE, { log: () => {} });
    const out = await reg.list();
    eq(out.ok, false, '标记为失败');
    eq(out.chat, [], '没有模型');
    ok(out.error.includes('频繁'), '原因说清楚');
    globalThis.fetch = realFetch;
  });

  await group('列表不是合法 JSON 时也能收场', async () => {
    const fake = fakeUpstream();
    fake.state.listBody = null;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/models')) return { ok: true, status: 200, text: async () => '这不是 JSON' };
      return fake.impl(url, {});
    };
    const reg = Llm.createModelRegistry(LIVE, { log: () => {} });
    const out = await reg.list();
    eq(out.ok, false, '标记为失败');
    ok(out.error.includes('合法 JSON'), '说明是格式问题');
    globalThis.fetch = realFetch;
  });

  console.log('注册表：启动探测');

  await group('默认模型不存在时，自动探测到真正可用的那个', async () => {
    const fake = fakeUpstream();
    fake.state.listBody = { data: [{ id: 'whisper-1' }, { id: 'qwen-max' }, { id: 'gpt-4o-mini' }] };
    fake.state.failModels['deepseek-chat'] = 404;   // 默认模型在中转平台上不存在
    globalThis.fetch = fake.impl;
    const seen = [];
    const reg = Llm.createModelRegistry(LIVE, { log: (line) => seen.push(line) });

    const out = await reg.probe();
    eq(out.ok, true, '探测成功');
    eq(out.model, 'gpt-4o-mini', '挑中了排名最前的可用聊天模型');
    eq(reg.resolved, 'gpt-4o-mini', '记住它，后面直接用');
    eq(reg.verified, true, '标记为已实测');
    ok(seen.some((l) => l.includes('不可用') || l.includes('调不通')), '日志里说了哪个不行');
    ok(seen.some((l) => l.includes('gpt-4o-mini')), '日志里说了最后用哪个');
    eq((await reg.probe()).model, 'gpt-4o-mini', '二次探测直接返回结果');
    globalThis.fetch = realFetch;
  });

  await group('认证失败时立刻停手，不做无谓的重试', async () => {
    const fake = fakeUpstream();
    fake.state.listBody = { data: [{ id: 'gpt-4o-mini' }, { id: 'qwen-max' }] };
    fake.state.failModels['deepseek-chat'] = 401;
    globalThis.fetch = fake.impl;
    const reg = Llm.createModelRegistry(LIVE, { log: () => {} });

    const out = await reg.probe();
    eq(out.ok, false, '探测失败');
    ok(out.note.includes('API Key'), '原因指向 Key');
    // 认证问题换模型也没用，所以只应该试过一次
    eq(fake.calls.filter((c) => c.stream === false && c.messages.length).length, 1, '只试了一个模型就停下');
    globalThis.fetch = realFetch;
  });

  await group('列表取不到时，仍然会实测默认模型', async () => {
    const fake = fakeUpstream();
    fake.state.listStatus = 500;
    globalThis.fetch = fake.impl;
    const reg = Llm.createModelRegistry(LIVE, { log: () => {} });
    const out = await reg.probe();
    eq(out.ok, true, '实测通过');
    eq(out.model, 'deepseek-chat', '用的是配置里的默认模型');
    eq(out.chat, [], '没有可用列表');
    globalThis.fetch = realFetch;
  });

  await group('离线配置不探测，直接说明用离线引擎', async () => {
    globalThis.fetch = async () => {
      throw new Error('离线时不该发起任何请求');
    };
    const reg = Llm.createModelRegistry(OFFLINE, { log: () => {} });
    const out = await reg.probe();
    eq(out.ok, false, '没有可用的上游模型');
    eq(out.offline, true, '标记为离线');
    ok(out.note.includes('离线') || out.note.includes('Key'), '说明当前成稿方式');
    eq(reg.resolved, 'deepseek-chat', 'resolved 退回配置值');
    globalThis.fetch = realFetch;
  });

  console.log('注册表：请求级选择');

  await group('默认模型调得通就用默认，调不通才换成列表里的', async () => {
    const fake = fakeUpstream();
    fake.state.listBody = { data: [{ id: 'qwen-max' }, { id: 'gpt-4o-mini' }] };
    globalThis.fetch = fake.impl;
    const reg = Llm.createModelRegistry(LIVE, { log: () => {} });
    await reg.probe();
    eq(reg.resolved, 'deepseek-chat', '默认模型能用就尊重配置');
    eq(reg.resolveModel('').model, 'deepseek-chat', '没指定时用它');
    eq(reg.resolveModel(undefined).note, '', '没有额外说明');

    const other = Llm.createModelRegistry(LIVE, { log: () => {} });
    fake.state.failModels['deepseek-chat'] = 404;
    await other.probe();
    eq(other.resolved, 'gpt-4o-mini', '默认模型不在时改用列表里的');
    eq(other.resolveModel('').model, 'gpt-4o-mini', '没指定时用探测结果');
    globalThis.fetch = realFetch;
  });

  await group('指定列表里的模型就用它；指定列表外的会退回并说明', async () => {
    const fake = fakeUpstream();
    fake.state.listBody = { data: [{ id: 'qwen-max' }, { id: 'gpt-4o-mini' }] };
    globalThis.fetch = fake.impl;
    const reg = Llm.createModelRegistry(LIVE, { log: () => {} });
    await reg.probe();
    await reg.list();

    eq(reg.resolveModel('qwen-max').model, 'qwen-max', '列表里的照用');
    const bogus = reg.resolveModel('gpt-5-ultra');
    eq(bogus.model, reg.resolved, '列表外的退回默认');
    ok(bogus.note.includes('gpt-5-ultra') && bogus.note.includes('已改用'), '说明了换了哪个');
    const tooLong = reg.resolveModel('x'.repeat(200));
    eq(tooLong.model, reg.resolved, '超长模型名退回默认');
    ok(tooLong.note.includes('过长'), '说明原因');
    globalThis.fetch = realFetch;
  });

  await group('离线时模型选择不生效，且说清楚', async () => {
    const reg = Llm.createModelRegistry(OFFLINE, { log: () => {} });
    const picked = reg.resolveModel('gpt-4o');
    eq(picked.model, '', '不产生模型名');
    ok(picked.note.includes('离线引擎'), '说明当前是离线引擎');
  });

  await group('拿不到列表时不限制模型名，交给上游判断', async () => {
    const fake = fakeUpstream();
    fake.state.listStatus = 500;
    globalThis.fetch = fake.impl;
    const reg = Llm.createModelRegistry(LIVE, { log: () => {} });
    await reg.probe();
    eq(reg.resolveModel('任意模型名').model, '任意模型名', '不做白名单限制');
    eq(reg.resolveModel('任意模型名').note, '', '也不多嘴');
    globalThis.fetch = realFetch;
  });

  const total = pass + failures.length;
  console.log(`\n通过 ${pass}/${total}`);
  if (failures.length) {
    console.log('\n失败项：');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exitCode = 1;
  }
})();
