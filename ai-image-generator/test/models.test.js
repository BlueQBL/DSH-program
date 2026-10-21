'use strict';

/**
 * 模型筛选与注册表的测试：这一步是这个项目比「聊天 / 写作」多出来的那一层，
 * 所以单独测细一点。用替换 globalThis.fetch 的方式喂假上游，不联网。
 *
 * 运行：node test/models.test.js
 */

const { eq, ok, not, has, group, report } = require('./harness.js');
const Models = require('../lib/models.js');

const LIVE = {
  live: true,
  // 假 Key 拼接构造：写成完整字面量会被仓库的密钥扫描器报成「高危命中」（自造噪声）
  apiKey: ['sk', 'test', '1234567890'].join('-'),
  keyFrom: 'TEST',
  baseUrl: 'http://fake.local/v1',
  chatModel: 'gpt-4o-mini',
  imageModel: 'gpt-image-2',
  reason: '测试用',
};
const OFFLINE = { live: false, apiKey: '', keyFrom: '', baseUrl: '', chatModel: 'gpt-4o-mini', imageModel: 'gpt-image-2', reason: '未检测到 API Key' };

function memStatus() {
  const map = new Map();
  return {
    get: (key) => map.get(key) || null,
    set: (key, value) => map.set(key, value),
    all: () => Object.fromEntries(map),
  };
}

/** 可控的假上游：记下每次请求，能按模型名返回不同状态 */
function fakeUpstream() {
  const state = {
    models: [],
    listStatus: 200,
    listBody: null,
    failModels: {},
    imageStatus: {},
  };
  const calls = [];
  const impl = async (url, init) => {
    const target = String(url);
    let body = {};
    try {
      body = init && init.body ? JSON.parse(init.body) : {};
    } catch {
      body = {};
    }
    calls.push({ url: target, body });
    if (target.endsWith('/models')) {
      const payload = state.listBody !== null ? state.listBody : { data: state.models.map((id) => ({ id })) };
      return {
        ok: state.listStatus === 200,
        status: state.listStatus,
        text: async () => JSON.stringify(payload),
        json: async () => payload,
      };
    }
    const forced = state.failModels[body.model] || state.imageStatus[body.model];
    if (forced) {
      return {
        ok: false,
        status: forced.status || 404,
        text: async () => JSON.stringify({ error: { message: forced.message || 'nope' } }),
      };
    }
    if (target.endsWith('/images/generations')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    };
  };
  return { impl, calls, state };
}

function makeRegistry(fake, options) {
  return Models.createModelRegistry(LIVE, Object.assign({ log: () => {}, statusStore: memStatus() }, options || {}));
}

(async function main() {
  const realFetch = globalThis.fetch;
  console.log('按名字筛出「能出图」的模型');

  await group('认得各种出图模型，排掉向量 / 语音 / 视频 / 只看图的', () => {
    const list = [
      'gpt-4o-mini',
      'text-embedding-3-small',
      'whisper-1',
      'tts-1',
      'gpt-4o-vision',
      'sora-1',
      'dall-e-3',
      'dall-e-2',
      'dall-e-3-edit',
      'gpt-image-1',
      'gpt-image-2',
      'flux-schnell',
      'stable-diffusion-xl',
      'seedream-4',
      'qwen-image',
      'midjourney-v6-image',
      'nano-banana-pro',
      'gemini-2.5-flash-image',
    ];
    eq(Models.filterImageModels(list), [
      'dall-e-3',
      'dall-e-2',
      'gpt-image-1',
      'gpt-image-2',
      'flux-schnell',
      'stable-diffusion-xl',
      'seedream-4',
      'qwen-image',
      'midjourney-v6-image',
      'nano-banana-pro',
      'gemini-2.5-flash-image',
    ], '该留的都留下、该排的都排掉');

    eq(Models.isImageModel('gpt-4o-vision'), false, '只能看图的不是出图模型');
    eq(Models.isImageModel('dall-e-3-edit'), false, '只能改图的（需要输入图）不算');
    eq(Models.isImageModel('sora-1'), false, '视频模型排掉');
    eq(Models.isImageModel('text-embedding-3-large'), false, '向量模型排掉');
    eq(Models.filterImageModels(['', null, 12]), [], '非字符串一律丢掉');
    eq(Models.filterImageModels(['gpt-image-2', 'gpt-image-2']), ['gpt-image-2'], '去重');
  });

  await group('排序：当前选的 / 常用的排前面', () => {
    const sorted = Models.sortImageCandidates(
      ['gemini-2.5-flash-image', 'flux-schnell', 'dall-e-3', 'gpt-image-1', 'gpt-image-2'],
      'gpt-image-2'
    );
    eq(sorted.slice(0, 4), ['gpt-image-2', 'gpt-image-1', 'dall-e-3', 'flux-schnell'], '出图主模型在前，冷门的在后');
    eq(Models.rankImageModel('gpt-image-2', 'gpt-image-2'), -1, '被选中的排最前');
  });

  await group('聊天模型（优化提示词用）也会挑出来', () => {
    const list = ['gpt-4o-mini', 'gpt-image-2', 'text-embedding-3-small', 'whisper-1', 'deepseek-chat', 'claude-3-5-sonnet'];
    eq(Models.filterChatModels(list), ['gpt-4o-mini', 'deepseek-chat', 'claude-3-5-sonnet'], '只留能聊的');
    eq(Models.sortChatCandidates(['claude-3-5-sonnet', 'gpt-4o-mini', 'deepseek-chat'], 'gpt-4o-mini')[0], 'gpt-4o-mini', '默认的排最前');
  });

  console.log('注册表：取列表');

  await group('列表来自账号，只保留能出图的那些', async () => {
    const fake = fakeUpstream();
    fake.state.models = ['gpt-4o-mini', 'text-embedding-3-small', 'whisper-1', 'gpt-image-2', 'dall-e-3'];
    globalThis.fetch = fake.impl;
    const reg = makeRegistry(fake);

    const out = await reg.list();
    eq(out.ok, true, '取到了');
    eq(out.source, 'upstream', '来源是账号列表');
    eq(out.images, ['gpt-image-2', 'dall-e-3'], '只留出图模型');
    eq(out.all.length, 5, '原始列表条数也带着');
    eq(out.chat.includes('gpt-4o-mini'), true, '聊天模型也挑出来了');
    eq(fake.calls.length, 1, '只问了一次上游');

    const second = await reg.list();
    eq(second.cached, true, '第二次吃缓存');
    eq(fake.calls.length, 1, '没有再问上游');
    const forced = await reg.list(true);
    eq(forced.cached, undefined, '强制刷新不吃缓存');
    eq(fake.calls.length, 2, '强制刷新会再问一次');
    globalThis.fetch = realFetch;
  });

  await group('列表取不到时退回平台文档里的已知模型，并说清来源', async () => {
    const fake = fakeUpstream();
    fake.state.listStatus = 500;
    globalThis.fetch = fake.impl;
    const reg = makeRegistry(fake);
    const out = await reg.list();
    eq(out.ok, false, '标记为没取到');
    eq(out.source, 'known', '来源标成「平台文档」');
    eq(out.images, ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1', 'dall-e-3', 'dall-e-2'], '兜底清单按偏好排好');
    has(out.note, '平台文档', '说明这不是账号列表');
    globalThis.fetch = realFetch;
  });

  await group('列表里一个出图模型都没有时，也用兜底清单', async () => {
    const fake = fakeUpstream();
    fake.state.models = ['gpt-4o-mini', 'deepseek-chat', 'text-embedding-3-small'];
    globalThis.fetch = fake.impl;
    const reg = makeRegistry(fake);
    const out = await reg.list();
    eq(out.source, 'known', '来源是平台文档');
    eq(out.images.length, 5, '列出 5 个已知模型');
    has(out.note, '没有认出', '说明列表里没认出出图模型');
    globalThis.fetch = realFetch;
  });

  await group('列表不是合法 JSON 也不算崩', async () => {
    const fake = fakeUpstream();
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/models')) return { ok: true, status: 200, text: async () => '这不是 JSON' };
      return fake.impl(url, {});
    };
    const reg = makeRegistry(fake);
    const out = await reg.list();
    eq(out.ok, false, '标记为失败');
    eq(out.source, 'known', '退回兜底清单');
    globalThis.fetch = realFetch;
  });

  console.log('注册表：这次用哪个模型');

  await group('默认用配置里的出图模型；指定列表外的会退回并说明', async () => {
    const fake = fakeUpstream();
    fake.state.models = ['gpt-image-1', 'gpt-image-2', 'dall-e-3', 'gpt-4o-mini'];
    globalThis.fetch = fake.impl;
    const reg = makeRegistry(fake);
    await reg.list();

    eq(reg.resolveImageModel('').model, 'gpt-image-2', '没指定就用配置里的');
    eq(reg.resolveImageModel('').note, '', '没有额外说明');
    eq(reg.resolveImageModel('dall-e-3').model, 'dall-e-3', '列表里的照用');

    const bogus = reg.resolveImageModel('sora-1');
    eq(bogus.model, 'gpt-image-2', '列表外的退回默认');
    has(bogus.note, '不在当前账号可出图的模型', '说明了为什么退');
    not(bogus.unavailable, '不是「已知不可用」');

    const tooLong = reg.resolveImageModel('x'.repeat(200));
    has(tooLong.note, '过长', '超长模型名退回');
    globalThis.fetch = realFetch;
  });

  await group('离线时不产生模型名，并说明走离线显影', () => {
    const reg = Models.createModelRegistry(OFFLINE, { log: () => {} });
    const picked = reg.resolveImageModel('gpt-image-2');
    eq(picked.model, '', '不产生模型名');
    has(picked.note, '离线', '说明当前是离线');
    const chat = reg.resolveChatModel('');
    has(chat.note, '离线', '优化提示词也说明走离线');
  });

  await group('配置里的模型不在列表里时，改用列表里排最前的那个', async () => {
    const fake = fakeUpstream();
    fake.state.models = ['dall-e-3', 'flux-schnell', 'gpt-4o-mini'];
    globalThis.fetch = fake.impl;
    const reg = makeRegistry(fake);
    await reg.list();
    eq(reg.pickImageModel(), 'dall-e-3', 'gpt-image-2 不在列表里，用列表里排最前的');
    globalThis.fetch = realFetch;
  });

  console.log('注册表：可用性检测');

  await group('检测通过就记成「已验证」，下次直接认这个模型', async () => {
    const fake = fakeUpstream();
    fake.state.models = ['gpt-image-2', 'dall-e-3', 'gpt-4o-mini'];
    globalThis.fetch = fake.impl;
    let probed = '';
    const reg = makeRegistry(fake, {
      probeImage: async (model) => {
        probed = model;
        return { ok: true, message: '' };
      },
    });
    await reg.list();

    const out = await reg.verifyImage('dall-e-3');
    eq(out.ok, true, '检测通过');
    eq(probed, 'dall-e-3', '检测的就是选中的那个模型');
    eq(reg.statusOf('dall-e-3').ok, true, '状态记下来了');
    const ui = reg.imageModelsForUi();
    eq(ui.find((m) => m.id === 'dall-e-3').state, 'verified', '界面上显示已验证');
    eq(reg.pickImageModel(), 'dall-e-3', '已验证的优先做默认模型');
    globalThis.fetch = realFetch;
  });

  await group('检测没通过就记成「调不通」，并按「不偷偷换模型」的规矩提示', async () => {
    const fake = fakeUpstream();
    fake.state.models = ['gpt-image-2', 'dall-e-3', 'gpt-4o-mini'];
    globalThis.fetch = fake.impl;
    const reg = makeRegistry(fake, {
      probeImage: async () => ({ ok: false, message: '模型名或接口地址不对' }),
    });
    await reg.list();

    const out = await reg.verifyImage('dall-e-3');
    eq(out.ok, false, '检测没通过');
    has(out.message, '模型名', '把上游的话带出来');
    const ui = reg.imageModelsForUi();
    eq(ui.find((m) => m.id === 'dall-e-3').state, 'unavailable', '界面上标成调不通');

    const picked = reg.resolveImageModel('dall-e-3');
    eq(picked.model, 'dall-e-3', '仍然返回用户选的那个（不偷偷换）');
    eq(picked.unavailable, true, '但标记为不可用，让上层拒绝请求');
    has(picked.note, '检测没通过', '把原因说清楚');
    globalThis.fetch = realFetch;
  });

  await group('检测一个不在列表里的模型会被挡住', async () => {
    const fake = fakeUpstream();
    fake.state.models = ['gpt-image-2', 'gpt-4o-mini'];
    globalThis.fetch = fake.impl;
    const reg = makeRegistry(fake, { probeImage: async () => ({ ok: true }) });
    await reg.list();
    const out = await reg.verifyImage('sora-1');
    eq(out.ok, false, '不检测');
    has(out.message, '不在当前账号', '说明为什么');
    globalThis.fetch = realFetch;
  });

  await group('检测抛异常也不炸：记成调不通并脱敏', async () => {
    const fake = fakeUpstream();
    fake.state.models = ['gpt-image-2'];
    globalThis.fetch = fake.impl;
    const key = ['sk', 'leak', '1234567890'].join('-');
    const reg = Models.createModelRegistry(Object.assign({}, LIVE, { apiKey: key }), {
      log: () => {},
      statusStore: memStatus(),
      probeImage: async () => {
        throw new Error(`bad auth: Bearer ${key}`);
      },
    });
    await reg.list();
    const out = await reg.verifyImage('gpt-image-2');
    eq(out.ok, false, '检测失败');
    not(out.message.includes(key), 'Key 不会漏进消息里');
    eq(reg.statusOf('gpt-image-2').ok, false, '状态记成不可用');
    globalThis.fetch = realFetch;
  });

  await group('可用性记录会落盘（重启还记得）', async () => {
    const fake = fakeUpstream();
    fake.state.models = ['gpt-image-2'];
    globalThis.fetch = fake.impl;
    const store = memStatus();
    const reg = makeRegistry(fake, { statusStore: store, probeImage: async () => ({ ok: true }) });
    await reg.list();
    await reg.verifyImage('gpt-image-2');

    // 换一个新注册表（等价于重启），共用同一份记录
    const reg2 = Models.createModelRegistry(LIVE, { log: () => {}, statusStore: store });
    await reg2.list();
    eq(reg2.statusOf('gpt-image-2').ok, true, '新进程读到上次的结果');
    eq(reg2.imageModelsForUi()[0].state, 'verified', '界面上还是已验证');
    globalThis.fetch = realFetch;
  });

  await group('默认检测会把返回的图真的解一遍：不是图片就判不通', async () => {
    const png = require('../lib/offline.js').encodePng(2, 2, Buffer.alloc(12, 0));
    const fake = fakeUpstream();
    fake.state.models = ['gpt-image-2', 'dall-e-3', 'gpt-4o-mini'];
    globalThis.fetch = async (url, init) => {
      const target = String(url);
      if (target.endsWith('/models')) return fake.impl(url, init);
      const body = JSON.parse(init.body);
      if (body.model === 'dall-e-3') {
        // 上游 200 了、额度也扣了，但返回里根本没有图片数据 —— 正是要提前发现的那种情况
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ revised_prompt: 'x' }] }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }) };
    };
    const reg = makeRegistry(fake); // 不注入 probeImage，走真正的默认实现
    await reg.list();

    const good = await reg.verifyImage('gpt-image-2');
    eq(good.ok, true, '能解成图片就算调得通');
    has(good.message, 'PNG', '连格式一起告诉你');

    const bad = await reg.verifyImage('dall-e-3');
    eq(bad.ok, false, '返回里没有图片数据 → 判不通');
    has(bad.message, '找不到图片数据', '原因说清楚');
    eq(reg.statusOf('dall-e-3').ok, false, '记成不可用');
    globalThis.fetch = realFetch;
  });

  console.log('注册表：优化提示词用的聊天模型');

  await group('用 1 个 token 探活，挑出真能聊的那个', async () => {
    const fake = fakeUpstream();
    fake.state.models = ['gpt-image-2', 'qwen-max', 'gpt-4o-mini'];
    globalThis.fetch = fake.impl;
    const chats = [];
    const reg = makeRegistry(fake, {
      probeChat: async (model) => {
        chats.push(model);
        // 500 = 这个模型正好过载，换一个试；429 / 401 才算账号级问题
        if (model === 'gpt-4o-mini') return { ok: false, status: 500, message: 'overloaded' };
        return { ok: true };
      },
    });
    await reg.list();
    const out = await reg.probeChat();
    eq(out.ok, true, '探到了');
    eq(out.model, 'qwen-max', '默认的过载了就换下一个');
    eq(chats, ['gpt-4o-mini', 'qwen-max'], '按偏好顺序试');
    eq(reg.chatModel, 'qwen-max', '记住它');
    eq(reg.chatVerified, true, '标记已实测');
    eq((await reg.probeChat()).model, 'qwen-max', '二次调用直接返回结果');
    globalThis.fetch = realFetch;
  });

  await group('认证问题不用再试别的模型', async () => {
    const fake = fakeUpstream();
    fake.state.models = ['gpt-4o-mini', 'qwen-max'];
    globalThis.fetch = fake.impl;
    const chats = [];
    const reg = makeRegistry(fake, {
      probeChat: async (model) => {
        chats.push(model);
        return { ok: false, status: 401, message: 'API Key 无效' };
      },
    });
    await reg.list();
    const out = await reg.probeChat();
    eq(out.ok, false, '探活失败');
    eq(chats.length, 1, '只试了一个就停手');
    has(out.note, 'API Key', '原因指向 Key');
    globalThis.fetch = realFetch;
  });

  await group('列表里没有聊天模型时，仍会试一次配置里的默认模型（1 个 token，几乎不花钱）', async () => {
    const fake = fakeUpstream();
    fake.state.models = ['gpt-image-2'];
    globalThis.fetch = fake.impl;
    const chats = [];
    const reg = makeRegistry(fake, {
      probeChat: async (model) => {
        chats.push(model);
        return { ok: true };
      },
    });
    await reg.list();
    const out = await reg.probeChat();
    eq(out.ok, true, '配置里的默认模型调得通');
    eq(chats, ['gpt-4o-mini'], '只试了配置里那一个');
    globalThis.fetch = realFetch;
  });

  await group('聊天模型全都不通时，说明优化提示词会退回离线扩写', async () => {
    const fake = fakeUpstream();
    fake.state.models = ['gpt-image-2', 'qwen-max'];
    globalThis.fetch = fake.impl;
    const reg = makeRegistry(fake, {
      probeChat: async () => ({ ok: false, status: 404, message: 'model not found' }),
    });
    await reg.list();
    const out = await reg.probeChat();
    eq(out.ok, false, '没探到');
    has(out.note, 'model not found', '把上游的话带出来');
    ok(out.note.length > 0, '注册表上留着这句失败原因');
    globalThis.fetch = realFetch;
  });

  report('models');
})();
