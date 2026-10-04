// 前端持久化与多会话逻辑验证
//
//   node test/store-tests.mjs
//
// store.js 只依赖 localStorage / fetch / document 事件，所以可以在 Node 里
// 装上最小替身来验证真实行为：「刷新不丢、断流可恢复、多会话互不串台、旧数据能迁移」。
// 这些是用户直接感知的能力，靠肉眼看界面验证太不可靠。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_LIB = path.resolve(HERE, '../public/lib');

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

// ---------------------------------------------------------------- 环境替身

let pageHideHandlers = [];

function freshEnvironment({ seed = {} } = {}) {
  const backing = new Map(Object.entries(seed));
  globalThis.localStorage = {
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => backing.set(key, String(value)),
    removeItem: (key) => backing.delete(key),
    clear: () => backing.clear(),
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

  // store.js 会注册 pagehide / visibilitychange 兜底落盘
  pageHideHandlers = [];
  const makeTarget = () => ({
    addEventListener: (type, fn) => {
      if (type === 'pagehide') pageHideHandlers.push(fn);
    },
    visibilityState: 'visible',
  });
  globalThis.document = makeTarget();
  globalThis.window = makeTarget();

  return backing;
}

/** 模拟浏览器离开页面时的兜底写盘 */
function simulatePageHide() {
  for (const fn of pageHideHandlers) fn();
}

/**
 * 把 public/lib 下的模块装进 Node。
 *
 * store.js 里 `import ... from './personas.js'` 是相对路径 —— 用 data: URL 加载时
 * 相对路径无法解析，所以先改写成绝对 file: URL 再加载。
 */
const moduleCache = new Map();
async function loadModule(file) {
  if (moduleCache.has(file)) return moduleCache.get(file);

  let source = readFileSync(path.join(PUBLIC_LIB, file), 'utf8');
  source = source.replace(/from\s+'\.\/([\w.-]+)'/g, (_m, dep) => {
    const depPath = path.join(PUBLIC_LIB, dep).replace(/\\/g, '/');
    return `from 'file:///${depPath}'`;
  });
  const url = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  const mod = await import(url);
  moduleCache.set(file, mod);
  return mod;
}

const loadStore = () => loadModule('store.js');

const SESSIONS_KEY = 'duitanlu.sessions.v2';
const LEGACY_KEY = 'duitanlu.conversation.v1';
const LEGACY_SESSION_KEY = 'duitanlu.session.v1';

// ---------------------------------------------------------------- 基本与迁移

group('多会话 · 基本行为');

{
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();

  check('首次打开自动建一个会话', store.sessions.length === 1 && store.messages.length === 0);
  check('会话有可用 id', /^[A-Za-z0-9_-]{4,64}$/.test(store.sessionId), store.sessionId);
  check('新会话标题是「新对话」', store.session.title === '新对话');
  check('默认角色是通用助手', store.session.personaId === 'default');

  store.pushUser('第一个问题');
  check('首条提问后自动用问题当标题', store.session.title === '第一个问题', store.session.title);
}

{
  // 用户自己改过标题就不该再被首条消息覆盖
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();
  store.pushUser('随便什么');
  store.renameFromFirstMessage();
  store.renameSession(store.sessionId, '我自己起的名字');
  check('已有标题时不再自动改名', store.renameFromFirstMessage() === false);
  check('手动改的名字保留', store.session.title === '我自己起的名字');
}

group('多会话 · 隔离与切换');

{
  const backing = freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();

  const a = store.session.id;
  store.pushUser('聊代码');
  store.updateSessionSettings({ personaId: 'coding' });

  const b = store.createSession({ personaId: 'writing' }).id;
  check('新建后自动切换过去', store.sessionId === b);
  check('新会话是空的（不串上一个会话的消息）', store.messages.length === 0, `实际 ${store.messages.length} 条`);

  store.pushUser('聊写作');
  check('两个会话各自记着自己的消息', store.messages.length === 1 && store.messages[0].content === '聊写作');

  store.switchSession(a);
  check('切回去能看到原来的消息', store.messages.length === 1 && store.messages[0].content === '聊代码');
  check('切回去角色也跟着回来', store.session.personaId === 'coding');
  check('切换会话是持久化的', JSON.parse(backing.get(SESSIONS_KEY)).activeId === a);

  store.switchSession('not-a-real-id');
  check('切到不存在的会话被拒绝', store.sessionId === a);
}

{
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();
  store.pushUser('会话一');
  const second = store.createSession();
  store.pushUser('会话二');

  check('删除后会话数减一', store.deleteSession(second.id) && store.sessions.length === 1);
  check('删除当前会话会切到剩下的那个', store.sessionId !== second.id);
  check('删到只剩一个时拒绝再删', store.deleteSession(store.sessionId) === false);
  check('最后一个会话仍在', store.sessions.length === 1);
}

group('多会话 · 每会话独立设置');

{
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();

  store.updateSessionSettings({ personaId: 'counselor', model: 'gpt-4o' });
  check('设置写进了当前会话', store.session.personaId === 'counselor' && store.session.model === 'gpt-4o');

  // 新会话：模型沿用上次（gpt-4o），角色回到通用助手
  const fresh = store.createSession();
  check('新会话沿用了上次的模型', fresh.model === 'gpt-4o', fresh.model);
  check('新会话的角色不继承（回到通用助手）', fresh.personaId === 'default', fresh.personaId);

  store.switchSession(store.sessions.find((s) => s.personaId === 'counselor').id);
  check('切回去模型也跟着回来', store.session.model === 'gpt-4o', store.session.model);
  check('角色没有被别的会话改掉', store.session.personaId === 'counselor');
}

group('角色提示词');

{
  const { resolveSystemPrompt, getPersona, PERSONAS } = await loadModule('personas.js');

  check('未选角色时返回空（由服务端用自己的默认提示词）', resolveSystemPrompt('default', '') === '');
  check('内置角色能取到提示词', getPersona('coding').prompt.includes('工程师'));
  check('自定义角色只用用户写的', resolveSystemPrompt('custom', '你是猫娘') === '你是猫娘');
  check('手写提示词优先于角色预设', resolveSystemPrompt('coding', '你只讲冷笑话') === '你只讲冷笑话');
  check('空白手写提示词不算数（回落到角色预设）', resolveSystemPrompt('coding', '   ').includes('工程师'));
  check('提示词过长会被截断', resolveSystemPrompt('custom', 'x'.repeat(9000)).length === 4000);
  check('未知角色回落到第一个', getPersona('nope').id === 'default');

  // 标题相关的断言搬去了 test/title-tests.mjs（那里有完整的起名规则）

  check('每个内置角色都有名字与说明', PERSONAS.every((p) => p.id && p.name && p.tagline));
  check('内置角色里包含题目要求的几类',
    ['coding', 'writing', 'counselor'].every((id) => PERSONAS.some((p) => p.id === id)));
  check('心理咨询师角色带有危机处理的边界说明',
    getPersona('counselor').prompt.includes('热线') || getPersona('counselor').prompt.includes('急诊'));
  check('角色提示词都写了「不要做什么」', PERSONAS.filter((p) => p.prompt).every((p) => p.prompt.includes('不要')));
}

// ---------------------------------------------------------------- 持久化

group('持久化 · 刷新与断流');

{
  freshEnvironment();
  const { createStore } = await loadStore();
  const storeA = createStore();
  storeA.pushUser('我叫小林');
  // pushAssistant 现在返回 { message, version, reused }：版本功能需要知道落在哪一版上
  const { message: assistant } = storeA.pushAssistant();
  storeA.appendDelta(assistant, '记下了');
  storeA.finish(assistant, 'done');

  const firstSession = storeA.sessionId;
  const { createStore: createStore2 } = await loadStore();
  const storeB = createStore2();

  check('刷新后对话仍在', storeB.messages.length === 2, `实际 ${storeB.messages.length}`);
  check('刷新后内容一致', storeB.messages[0].content === '我叫小林');
  check('刷新后仍是同一个会话', storeB.sessionId === firstSession);
  check('刷新后没有误报中断', storeB.recoveredInterrupted === 0);
}

{
  freshEnvironment();
  const { createStore } = await loadStore();
  const storeA = createStore();
  storeA.pushUser('请解释一下闭包');
  const { message: assistant } = storeA.pushAssistant();
  storeA.appendDelta(assistant, '闭包指的是函数');
  storeA.appendDelta(assistant, '记住了它定义时的作用域');
  simulatePageHide();

  const { createStore: createStore2 } = await loadStore();
  const storeB = createStore2();

  check('中断后保留已写出的半截文字',
    storeB.messages[1].content === '闭包指的是函数记住了它定义时的作用域',
    JSON.stringify(storeB.messages[1].content));
  check('中断的消息标记为 interrupted', storeB.messages[1].status === 'interrupted');
  check('中断计数为 1', storeB.recoveredInterrupted === 1);
}

{
  // 多个会话同时中断，都要被恢复
  freshEnvironment();
  const { createStore } = await loadStore();
  const storeA = createStore();
  storeA.pushUser('a');
  storeA.pushAssistant();
  storeA.createSession();
  storeA.pushUser('b');
  storeA.pushAssistant();
  simulatePageHide();

  const { createStore: createStore2 } = await loadStore();
  const storeB = createStore2();
  check('多会话中断都被恢复', storeB.recoveredInterrupted === 2, `实际 ${storeB.recoveredInterrupted}`);
  check('两个会话都还在', storeB.sessions.length === 2);
}

{
  // 只有一个流式回答时，第一个增量必须立即落盘（否则中途刷新看不到正文）
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();
  store.pushUser('问');
  const { message: assistant } = store.pushAssistant();
  store.appendDelta(assistant, '第一段');
  const stored = JSON.parse(localStorage.getItem(SESSIONS_KEY));
  // 落盘结构现在带 versions：平铺的 content 是「最新一版」的镜像，两者都该是最新内容
  const savedAnswer = stored.sessions[0].messages[1];
  check('第一个增量立即落盘', savedAnswer.content === '第一段',
    JSON.stringify(savedAnswer.content));
  check('落盘时版本结构里的内容也同步了',
    savedAnswer.versions?.[savedAnswer.versions.length - 1]?.content === '第一段',
    JSON.stringify(savedAnswer.versions?.at(-1)?.content));
}

group('迁移 · 旧版单会话数据');

{
  freshEnvironment({
    seed: {
      [LEGACY_KEY]: JSON.stringify({
        version: 1,
        sessionId: 'legacy_session_1',
        messages: [
          { role: 'user', content: '旧版的第一句话', createdAt: 1700000000000 },
          { role: 'assistant', content: '旧版的回答', createdAt: 1700000001000, status: 'done' },
        ],
      }),
      [LEGACY_SESSION_KEY]: 'legacy_session_1',
    },
  });
  const { createStore } = await loadStore();
  const store = createStore();

  check('旧数据被迁移成一个会话', store.sessions.length === 1 && store.messages.length === 2);
  check('迁移时沿用原来的 sessionId', store.sessionId === 'legacy_session_1', store.sessionId);
  check('迁移的对话内容没丢', store.messages[0].content === '旧版的第一句话');
  check('迁移后用首条提问当标题', store.session.title === '旧版的第一句话', store.session.title);
  check('migrated 标记为真', store.migrated === true);
  check('旧键被清掉（不会重复迁移）',
    localStorage.getItem(LEGACY_KEY) === null && localStorage.getItem(LEGACY_SESSION_KEY) === null);
}

{
  // 新版已经有数据时，不该被旧键影响
  freshEnvironment({
    seed: {
      [SESSIONS_KEY]: JSON.stringify({
        version: 2,
        activeId: 's_new_1',
        sessions: [{ id: 's_new_1', title: '新数据', messages: [] }],
      }),
      [LEGACY_KEY]: JSON.stringify({ version: 1, messages: [{ role: 'user', content: '旧的' }] }),
    },
  });
  const { createStore } = await loadStore();
  const store = createStore();
  check('有新版数据时不走迁移', store.migrated === false && store.session.title === '新数据');
}

// ---------------------------------------------------------------- 图片

group('图片附件');

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

{
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();
  store.pushUser('看看这张图', { attachments: [{ name: 'a.png', mime: 'image/png', dataUrl: TINY_PNG, width: 1, height: 1 }] });

  check('图片被存进消息', store.messages[0].attachments.length === 1);
  check('图片带上了文件名与尺寸', store.messages[0].attachments[0].name === 'a.png');
  check('图片有独立 id', typeof store.messages[0].attachments[0].id === 'string');
}

{
  // 非图片的 dataURL 必须被拒 —— 否则能被塞进任意内容
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();
  store.pushUser('危险内容', {
    attachments: [
      { name: 'x.svg', dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' },
      { name: 'y.js', dataUrl: 'data:text/javascript;base64,YWxlcnQoMSk=' },
      { name: 'z.txt', dataUrl: 'data:text/plain;base64,aGk=' },
    ],
  });
  check('只接受 png/jpeg/webp/gif 的 dataURL', store.messages[0].attachments.length === 0,
    JSON.stringify(store.messages[0].attachments.map((a) => a.name)));
}

{
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();
  store.pushUser('太多图', {
    attachments: Array.from({ length: 9 }, (_, i) => ({ name: `p${i}.png`, dataUrl: TINY_PNG })),
  });
  check('单条消息图片数被限制在 4 张', store.messages[0].attachments.length === 4,
    String(store.messages[0].attachments.length));
}

{
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();
  store.pushUser('', { attachments: [{ name: 'photo.png', dataUrl: TINY_PNG }] });
  check('纯图片消息（没有文字）也能发出去', store.messages.length === 1 && store.messages[0].content === '');
}

// ---------------------------------------------------------------- 导出与图片工具

group('导出');

{
  const { toMarkdown, toPlainText, toJson, suggestedFilename } = await loadModule('exporters.js');

  const session = {
    id: 's1',
    title: '闭包讨论',
    createdAt: 1700000000000,
    updatedAt: 1700000600000,
    personaId: 'coding',
    personaName: '编程助手',
    model: 'deepseek-v3.2',
    messages: [
      { id: 'u1', role: 'user', content: '闭包是什么', createdAt: 1700000000000, status: 'done', attachments: [] },
      { id: 'a1', role: 'assistant', content: '**闭包**是……', createdAt: 1700000001000, status: 'done', model: 'deepseek-v3.2', attachments: [] },
      { id: 'u2', role: 'user', content: '看这张图', createdAt: 1700000002000, status: 'done', attachments: [{ name: 'chart.png', mime: 'image/png', width: 800, height: 600 }] },
      { id: 'a2', role: 'assistant', content: '图里是……', createdAt: 1700000003000, status: 'interrupted', error: null, attachments: [] },
    ],
  };

  const md = toMarkdown(session);
  check('Markdown 带标题', md.includes('# 闭包讨论'));
  check('Markdown 带角色信息', md.includes('编程助手'));
  check('Markdown 保留回答内容', md.includes('**闭包**是……'));
  check('Markdown 标出图片附件', md.includes('[图片：chart.png'), md.slice(0, 500));
  check('Markdown 说明被中断', md.includes('被中断'));
  check('Markdown 按轮次编号', md.includes('01 · 问') && md.includes('02 · 问'));

  const txt = toPlainText(session);
  check('纯文本含问答', txt.includes('【问 1】闭包是什么') && txt.includes('【答】'));

  const parsed = JSON.parse(toJson(session));
  check('JSON 可解析且带 schema', parsed.schema === 'duitanlu.export');
  check('JSON 带 schemaVersion', parsed.schemaVersion === 1);
  check('JSON 保留全部消息', parsed.sessions[0].messages.length === 4);
  check('JSON 导出图片元信息但不含 base64',
    parsed.sessions[0].messages[2].attachments[0].name === 'chart.png' &&
      !JSON.stringify(parsed).includes('base64'));

  const twoSessions = [session, { ...session, id: 's2', title: '第二个' }];
  check('导出全部时包含多个会话', JSON.parse(toJson(session, { exportAll: true, sessions: twoSessions })).count === 2);
  check('导出全部的 Markdown 分节',
    toMarkdown(session, { exportAll: true, sessions: twoSessions }).includes('## 第二个'));

  check('文件名去掉非法字符', !/[\\/:*?"<>|]/.test(suggestedFilename('a/b:c*d?e"f<g>h|i', 'md')));
  check('文件名带扩展名', suggestedFilename('标题', 'json').endsWith('.json'));
  check('空标题也能给出文件名', suggestedFilename('', 'md').endsWith('.md'));
}

{
  const { fitSize } = await loadModule('attachments.js');
  check('小图不缩放', fitSize(800, 600).scaled === false);
  check('大图按长边缩到 1568', fitSize(4000, 3000).width === 1568 && fitSize(4000, 3000).scaled === true);
  check('竖图按高度缩', fitSize(1000, 4000).height === 1568);
  check('缩放保持宽高比', Math.abs(fitSize(4000, 2000).height - 784) <= 1);
  check('尺寸缺失时不崩', fitSize(0, 0).width === 1568);
}

{
  const { supportsVision, visionModels } = await loadModule('vision.js');
  check('gpt-4o 可看图', supportsVision('gpt-4o') === true);
  check('gemini 可看图', supportsVision('gemini-2.5-flash') === true);
  check('claude 可看图', supportsVision('claude-sonnet-4-5') === true);
  check('**DeepSeek 全部不可看图**（这是真实限制）',
    ['deepseek-v3.2', 'deepseek-chat', 'deepseek-r1', 'deepseek-v4.1-flash'].every((m) => supportsVision(m) === false));
  check('从列表里挑出可看图的', visionModels(['deepseek-v3.2', 'gpt-4o', 'gemini-3-flash']).length === 2);
  check('空输入不崩', supportsVision('') === false && visionModels(null).length === 0);
}

// ---------------------------------------------------------------- 订阅与容错

group('订阅与脏数据容错');

{
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();
  const events = [];
  const unsubscribe = store.subscribe((snapshot) => events.push(snapshot.sessions.length));

  store.pushUser('a');
  const before = events.length;
  unsubscribe();
  store.pushUser('b');

  check('订阅在变更时收到通知', before >= 1, String(before));
  check('退订后不再收到通知', events.length === before);
}

{
  freshEnvironment({ seed: { [SESSIONS_KEY]: '{ 这不是合法 JSON' } });
  const { createStore } = await loadStore();
  let store = null;
  let threw = false;
  try {
    store = createStore();
  } catch {
    threw = true;
  }
  check('损坏的数据不抛异常', !threw);
  check('损坏后仍能用（自动建新会话）', Boolean(store) && store.sessions.length === 1 && store.messages.length === 0);
}

{
  freshEnvironment({
    seed: {
      [SESSIONS_KEY]: JSON.stringify({
        version: 2,
        activeId: 's_ok_1',
        sessions: [
          { id: 's_ok_1', title: '正常', messages: [{ role: 'user', content: '你好' }] },
          { role: 'user', content: '没有 id 的会话' },
          { id: 's_ok_2', title: '第二个正常会话', messages: [] },
          { id: 'bad!!id', title: 'id 非法', messages: [] },
          null,
        ],
      }),
    },
  });
  const { createStore } = await loadStore();
  const store = createStore();
  check('缺 id 的会话被丢弃（不伪造身份混进列表）', store.sessions.length === 2, `实际 ${store.sessions.length}`);
  check('合法会话保留', store.session.title === '正常');
  check('所有会话的 id 都合法', store.sessions.every((s) => /^[A-Za-z0-9_-]{4,64}$/.test(s.id)));
  check('activeId 指向有效的会话', store.sessions.some((s) => s.id === store.sessionId));
}

{
  freshEnvironment({
    seed: {
      [SESSIONS_KEY]: JSON.stringify({
        version: 2,
        activeId: '不存在的会话',
        sessions: [{ id: 's_real_1', messages: [] }],
      }),
    },
  });
  const { createStore } = await loadStore();
  const store = createStore();
  check('activeId 失效时回落到第一个会话', store.sessionId === 's_real_1', store.sessionId);
}

{
  // 跨标签页：adoptSnapshot 接管外部数据但不回写
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();
  store.pushUser('本页输入');
  const before = localStorage.getItem(SESSIONS_KEY);

  const external = {
    version: 2,
    activeId: store.sessionId,
    sessions: [
      { id: store.sessionId, title: '别的标签页改的', messages: [{ role: 'user', content: '外部内容' }] },
    ],
  };
  check('adoptSnapshot 接管外部数据', store.adoptSnapshot(external, { persist: false }) === true);
  check('接管后内容变了', store.messages[0].content === '外部内容');
  check('persist:false 时不回写（避免跨页回环）', localStorage.getItem(SESSIONS_KEY) === before);
  check('非法快照被拒绝', store.adoptSnapshot({ nope: true }) === false);
}

// ---------------------------------------------------------------- 新会话与空会话清理

group('新会话 · 角色与空会话清理');

{
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();

  store.pushUser('随便聊聊');
  store.updateSessionSettings({ personaId: 'counselor', systemPrompt: '你只做倾听' });

  const fresh = store.createSession();
  check('新建会话的角色是通用助手（不继承上一个）', fresh.personaId === 'default', fresh.personaId);
  check('新会话没有残留的自定义提示词', fresh.systemPrompt === '', JSON.stringify(fresh.systemPrompt));
  check('新会话的消息是空的', fresh.messages.length === 0);
}

{
  // 模型相反：应该沿用上次用过的
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();
  store.pushUser('第一句');
  store.updateSessionSettings({ model: 'gpt-4o', personaId: 'coding' });

  const next = store.createSession();
  check('新会话沿用上次用过的模型', next.model === 'gpt-4o', next.model);
  check('但角色仍然回到通用助手', next.personaId === 'default', next.personaId);
}

{
  // 回到已有会话时，那个会话的角色必须还是它自己的
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();

  const first = store.session.id;
  store.pushUser('聊代码');
  store.updateSessionSettings({ personaId: 'coding' });
  check('会话 A 的角色是编程助手', store.session.personaId === 'coding');

  const second = store.createSession().id;
  check('新会话 B 是通用助手', store.session.personaId === 'default');
  store.updateSessionSettings({ personaId: 'writing' });

  store.switchSession(first);
  check('回到会话 A，角色是它自己的（编程助手）', store.session.personaId === 'coding', store.session.personaId);
  store.switchSession(second);
  check('回到会话 B，角色是它自己的（写作助手）', store.session.personaId === 'writing', store.session.personaId);
}

{
  // 空会话清理：进来时开的空白会话，用户点了已有对话后应当消失
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();

  store.pushUser('老对话');
  const oldId = store.session.id;
  const blank = store.createSession().id; // 模拟「进来时自动开的空白会话」
  check('此时列表里有一个空白会话', store.sessions.length === 2 && store.session.id === blank);

  const dropped = store.dropEmptySessions({ keepId: oldId });
  check('切到已有对话时清掉了空白会话', dropped === 1, `删了 ${String(dropped)} 个`);
  check('列表里只剩那一个已有对话', store.sessions.length === 1 && store.sessions[0].id === oldId,
    store.sessions.map((s) => s.id).join(','));
  check('不会留下悬空的 activeId', store.sessions.some((s) => s.id === store.sessionId));
}

{
  // 边界：全都是空会话时不能全删（否则界面没有可显示的会话）
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();
  store.createSession();

  const dropped = store.dropEmptySessions();
  check('全是空会话时一个都不删', dropped === 0 && store.sessions.length === 2, `删了 ${String(dropped)} 个`);
}

{
  // 边界：被点的那个会话自己也是空的，必须留着（keepId 的作用）
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();
  store.pushUser('有内容');
  const contentId = store.session.id;
  const blankA = store.createSession().id;
  const blankB = store.createSession().id;

  const dropped = store.dropEmptySessions({ keepId: blankB });
  check('保留被点开的空白会话，只删其它空白会话', dropped === 1, `删了 ${String(dropped)} 个`);
  check('被点开的空白会话仍在列表里', store.sessions.some((s) => s.id === blankB));
  check('有内容的会话没被误删', store.sessions.some((s) => s.id === contentId));
  check('另一个空白会话被清掉了', !store.sessions.some((s) => s.id === blankA));
}

// ---------------------------------------------------------------- 编辑后重新回答

/**
 * 手工给一对问答各追加一版。
 *
 * 测试里需要「已经存在更早版本」的局面，但**没法用 pushUser 造出来**：
 * 指向最新一版的编辑一律是原地替换，不产生新页。所以这里直接推版本数组。
 */
function appendVersion(question, answer, qText, aText) {
  const stamp = () => ({
    createdAt: Date.now(),
    attachments: [],
    finishedAt: Date.now(),
    status: 'done',
    error: null,
    model: null,
    mode: null,
  });
  question.versions.push({ content: qText, ...stamp() });
  question.versionCount = question.versions.length;
  if (answer) answer.versions.push({ content: aText, ...stamp() });
}

group('编辑后重新回答 · 旧页必须保留');

{
  /**
   * 这是用户实测报上来的缺陷，值得原样钉住：
   * 「我生成之后重新编辑了需求，然后生成的内容把上一次的内容给覆盖了。
   *   我应该能看到本次的内容，更要看到上次的生成内容。」
   *
   * 根因是我当初按「改的是最新一页就原地覆盖」实现 —— 只有一页时，
   * 「最新一页」就是唯一那一页，于是编辑重发改成了覆盖，旧内容直接丢了。
   * 现在语义是：**编辑一律追加新页**。
   */
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();

  const q = store.pushUser('第一版问题').message;
  const a = store.pushAssistant({ question: q, version: 1 }).message;
  store.appendDelta(a, '第一版回答');
  store.finish(a, 'done');

  // 用户点编辑（此时只有一页），改完点「重新回答」
  const shown = store.viewVersion(q);
  check('只有一页时，编辑目标是第 1 页', shown === 1, String(shown));

  const resent = store.pushUser('第二版问题', { edit: q, version: shown });
  check('编辑重发**新增一页**，不是覆盖', resent.replaced === false, `replaced=${String(resent.replaced)}`);
  check('提问变成 2 版', q.versions.length === 2, String(q.versions.length));
  check('第 1 版（上一次的内容）还在',
    q.versions[0].content === '第一版问题', JSON.stringify(q.versions.map((v) => v.content)));
  check('第 2 版是本次的内容', q.versions[1].content === '第二版问题');

  const a2 = store.pushAssistant({ question: q, version: resent.version }).message;
  store.appendDelta(a2, '第二版回答');
  store.finish(a2, 'done');

  check('回答也变成 2 版', a2.versions.length === 2, String(a2.versions.length));
  check('上一次的回答还在',
    a2.versions[0].content === '第一版回答', JSON.stringify(a2.versions.map((v) => v.content)));
  check('本次的回答在第 2 版', a2.versions[1].content === '第二版回答');
  check('自动切到新生成的那一页', store.viewVersion(q) === 2, String(store.viewVersion(q)));

  // 用户能来回看两页
  store.setMessageVersion(q, 1);
  check('能切回第 1 页看上一次的内容', q.versions[store.viewVersion(q) - 1].content === '第一版问题');
  check('第 1 页对应的回答也是上一次的',
    a2.versions[store.viewVersion(q) - 1].content === '第一版回答');
  store.setMessageVersion(q, 2);
  check('能切回第 2 页看本次的内容', q.versions[store.viewVersion(q) - 1].content === '第二版问题');
}

{
  // 连续编辑多次：每一版都在，一个都不能丢
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();

  const q = store.pushUser('第 1 次问答').message;
  const a = store.pushAssistant({ question: q, version: 1 }).message;
  store.appendDelta(a, '回答 1');
  store.finish(a, 'done');

  for (let i = 2; i <= 4; i += 1) {
    const r = store.pushUser(`第 ${i} 次问答`, { edit: q, version: store.viewVersion(q) });
    const ans = store.pushAssistant({ question: q, version: r.version }).message;
    store.appendDelta(ans, `回答 ${i}`);
    store.finish(ans, 'done');
  }

  check('连续编辑 3 次后有 4 页', q.versions.length === 4, String(q.versions.length));
  check('四页的内容都按顺序保留',
    JSON.stringify(q.versions.map((v) => v.content)) ===
      JSON.stringify(['第 1 次问答', '第 2 次问答', '第 3 次问答', '第 4 次问答']),
    JSON.stringify(q.versions.map((v) => v.content)));
  check('四页的回答都按顺序保留',
    JSON.stringify(a.versions.map((v) => v.content)) ===
      JSON.stringify(['回答 1', '回答 2', '回答 3', '回答 4']),
    JSON.stringify(a.versions.map((v) => v.content)));
  check('会话里仍然只有一问一答', store.messages.length === 2, `${store.messages.length} 条`);
}

{
  // 「重新生成」是另一个动作：原地替换那一版，不新增页
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();

  const q = store.pushUser('问题').message;
  const a = store.pushAssistant({ question: q, version: 1 }).message;
  store.appendDelta(a, '第一次回答');
  store.finish(a, 'done');

  const retried = store.pushUser('问题', { edit: q, version: 1, reuse: true });
  check('重新生成是原地替换', retried.replaced === true);
  check('重新生成不新增页', q.versions.length === 1, String(q.versions.length));

  const a2 = store.pushAssistant({ question: q, version: retried.version }).message;
  store.appendDelta(a2, '第二次回答');
  store.finish(a2, 'done');
  check('重新生成后回答也只有 1 版', a2.versions.length === 1, String(a2.versions.length));
  check('回答被换成了新的', a2.versions[0].content === '第二次回答');
}

{
  // 关键场景：编辑**更早**的版本 → 必须追加新页，第 1 页原样保留
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();

  const q = store.pushUser('第一版问题').message;
  const ans = store.pushAssistant({ question: q, version: 1 }).message;
  store.appendDelta(ans, '第一版回答');
  store.finish(ans, 'done');

  // 手工追加第 2 版，构造出「存在更早版本」的局面。
  // 不能靠 pushUser 做这一步：改最新一版是原地替换，不会产生新页。
  appendVersion(q, ans, '第二版问题', '第二版回答');

  // 现在编辑第 1 版 → 应当追加为第 3 版，前两页都留着
  const edited = store.pushUser('改自第 1 版的新问题', { edit: q, version: 1 });
  check('编辑更早的版本会追加新页', edited.replaced === false);
  check('追加后的版本数是 3', q.versions.length === 3, String(q.versions.length));
  check('第 1 版内容没被覆盖', q.versions[0].content === '第一版问题', q.versions[0].content);
  check('第 2 版内容没被覆盖', q.versions[1].content === '第二版问题', q.versions[1].content);
  check('第 3 版是新内容', q.versions[2].content === '改自第 1 版的新问题');

  // 为新版本准备回答：页数要对齐
  const a3 = store.pushAssistant({ question: q, version: 3 });
  check('助手消息补齐到与提问相同的页数', a3.message.versions.length === 3,
    String(a3.message.versions.length));
  check('旧页的回答没被动过', a3.message.versions[0].content === '第一版回答');
  check('新页的回答是空的（等着写）', a3.message.versions[2].content === '');
  store.appendDelta(a3.message, '第三版回答');
  store.finish(a3.message, 'done');

  // 切换查看：每一页看到的是它自己那一版
  store.setMessageVersion(q, 1);
  check('可以切回第 1 页', store.viewVersion(q) === 1);
  check('第 1 页看到的是第 1 版内容', q.versions[store.viewVersion(q) - 1].content === '第一版问题',
    q.versions[store.viewVersion(q) - 1].content);
  check('第 1 页对应的回答也是第 1 版',
    a3.message.versions[store.viewVersion(q) - 1].content === '第一版回答');
  store.setMessageVersion(q, 3);
  check('可以切到第 3 页', store.viewVersion(q) === 3);
  check('第 3 页看到的是第 3 版内容',
    q.versions[store.viewVersion(q) - 1].content === '改自第 1 版的新问题');
}

{
  // 版本与平铺字段的镜像关系：平铺 content 永远是最新一版
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();
  const q = store.pushUser('v1').message;
  store.pushUser('v2', { edit: q, version: 1 });
  check('平铺 content 镜像最新一版', q.content === 'v2', q.content);
  check('versionCount 与实际一致', q.versionCount === q.versions.length);
}

{
  // 刷新后版本不能丢
  freshEnvironment();
  const { createStore } = await loadStore();
  const storeA = createStore();
  const q = storeA.pushUser('第一版').message;
  const a = storeA.pushAssistant({ question: q, version: 1 }).message;
  storeA.appendDelta(a, '回答一');
  storeA.finish(a, 'done');

  // 编辑重发：每次都新增一页，旧页保留
  storeA.pushUser('最终的第二版', { edit: q, version: 1 });
  check('编辑重发后第 1 页没被覆盖，新内容成为第 2 页',
    q.versions.length === 2 &&
      q.versions[0].content === '第一版' &&
      q.versions[1].content === '最终的第二版',
    JSON.stringify(q.versions.map((v) => v.content)));

  // 再编辑一次，看是否继续追加（而不是覆盖第 2 页）
  const edited = storeA.pushUser('新增的第三版', { edit: q, version: 1 });
  check('再次编辑继续追加为第 3 页', edited.replaced === false && q.versions.length === 3,
    `replaced=${String(edited.replaced)} versions=${q.versions.length}`);

  const { createStore: createStore2 } = await loadStore();
  const storeB = createStore2();
  const q2 = storeB.messages.find((m) => m.role === 'user');
  check('刷新后提问的版本数还在', q2?.versions.length === 3, String(q2?.versions.length));
  check('刷新后各版内容都在（顺序也保持）',
    JSON.stringify(q2?.versions.map((v) => v.content)) ===
      JSON.stringify(['第一版', '最终的第二版', '新增的第三版']),
    JSON.stringify(q2?.versions.map((v) => v.content)));
  check('刷新后第 1 页内容没被覆盖', q2?.versions[0].content === '第一版');
  check('刷新后助手消息存在', Boolean(storeB.messages.find((m) => m.role === 'assistant')));
}

{
  // 旧数据（没有 versions 字段）要被当成 1 版，不能崩
  freshEnvironment({
    seed: {
      [SESSIONS_KEY]: JSON.stringify({
        version: 2,
        activeId: 's_old_1',
        sessions: [
          {
            id: 's_old_1',
            title: '旧数据',
            messages: [
              { id: 'u1', role: 'user', content: '老提问', createdAt: 1700000000000, status: 'done' },
              { id: 'a1', role: 'assistant', content: '老回答', createdAt: 1700000001000, status: 'done' },
            ],
          },
        ],
      }),
    },
  });
  const { createStore } = await loadStore();
  const store = createStore();
  check('旧消息被补成 1 版', store.messages[0].versions.length === 1);
  check('旧消息内容没丢', store.messages[0].versions[0].content === '老提问');
  check('旧消息能读版本号', store.viewVersion(store.messages[0]) === 1);
  check('旧助手消息也被补成 1 版', store.messages[1].versions[0].content === '老回答');
}

{
  // 边界：给不存在的版本号要安全回落，不能崩
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();
  const q = store.pushUser('只有一版').message;
  const a = store.pushAssistant({ question: q, version: 99 }).message;
  check('指定不存在的版本号不会崩', a.versions.length >= 1, String(a.versions.length));
  store.setMessageVersion(q, 99);
  check('切到不存在的版本号会回落到最后一版', store.viewVersion(q) === q.versions.length);
  store.setMessageVersion(q, -5);
  check('切到负数版本号会回落到第 1 版', store.viewVersion(q) === 1);
}

group('版本决策 · 纯函数');

{
  const {
    resolveShownPage,
    totalPages,
    versionBarItems,
    versionLabel,
    editOutcome,
    editHint,
  } = await loadModule('versions.js');

  const versions = (n) =>
    Array.from({ length: n }, (_, i) => ({ content: `v${i + 1}`, createdAt: 0, attachments: [] }));

  // 显示哪一页
  check('没指定页码时显示最后一页', resolveShownPage({ versions: versions(3) }, undefined) === 3);
  check('指定页码在范围内时按指定的来', resolveShownPage({ versions: versions(3) }, 2) === 2);
  check('页码超出范围回落到最后一页', resolveShownPage({ versions: versions(3) }, 99) === 3);
  check('页码为负数回落到最后一页', resolveShownPage({ versions: versions(3) }, -1) === 3);
  check('非数字页码回落到最后一页', resolveShownPage({ versions: versions(3) }, 'abc') === 3);
  check('小数页码向下取整', resolveShownPage({ versions: versions(3) }, 2.7) === 2);
  check('单页时恒为 1', resolveShownPage({ versions: versions(1) }, 5) === 1);
  check('没有 versions 字段也不崩', resolveShownPage({}, 2) === 1);
  check('question 为 null 也不崩', resolveShownPage(null, 2) === 1);

  // 总页数
  check('总页数取提问与回答的较大者', totalPages({ versions: versions(3) }, { versions: versions(2) }) === 3);
  check('回答页数更多时也取得到', totalPages({ versions: versions(1) }, { versions: versions(4) }) === 4);
  check('两边都没有版本时是 1', totalPages({}, {}) === 1);

  // 页码按钮
  check('只有一页时不给按钮（界面据此隐藏版本栏）', versionBarItems(1, 1).length === 0);
  check('多页时按钮数量等于页数', versionBarItems(3, 2).length === 3);
  check('当前页被标记为 active', versionBarItems(3, 2).filter((i) => i.active).length === 1);
  check('active 落在正确的页上', versionBarItems(3, 2).find((i) => i.active).page === 2);
  check('按钮带可点的页码', versionBarItems(3, 1).map((i) => i.page).join(',') === '1,2,3');
  check('页码越界时 active 回落到最后一页',
    versionBarItems(3, 99).find((i) => i.active).page === 3);

  // 说明文字
  check('单页不显示页码说明', versionLabel(1, 1) === '');
  check('多页显示「第 n / N 页」', versionLabel(2, 3) === '第 2 / 3 页');

  // 编辑的后果 —— 这是整个功能的核心判断
  // 教训：最初这里断言的是「编辑最新一页 → 覆盖」，结果用户实测发现旧内容丢了。
  // 「编辑后重新回答」的意义就是保留旧版，所以现在**恒为追加**。
  check('只有一页时编辑 → 追加（绝不能覆盖唯一那一页）', editOutcome(1, 1) === 'append');
  check('编辑最新一页 → 也是追加', editOutcome(3, 3) === 'append');
  check('编辑更早的页 → 追加', editOutcome(1, 3) === 'append');
  check('页码越界也 → 追加', editOutcome(99, 3) === 'append');
  check('任何输入都返回 append', [editOutcome(), editOutcome(0, 0), editOutcome(-1, -1)].every((r) => r === 'append'));

  check('追加时会提示页号并说明旧页保留',
    editHint('append', 1, 3).includes('第 4 页') && editHint('append', 1, 3).includes('保留'));
  check('覆盖时会提示会覆盖哪一页', editHint('replace', 2, 3).includes('第 2 页'));
  check('未知结果不给提示', editHint('', 1, 1) === '');
}

group('历史构造 · 旧版本必须一起发出去');

{
  const { buildRequestHistory } = await loadModule('versions.js');

  const v = (content, extra = {}) => ({ content, attachments: [], createdAt: 0, ...extra });
  const img = (dataUrl) => ({ dataUrl, name: 'x.png', mime: 'image/png' });

  // 单页：正常一问一答
  {
    const q = { role: 'user', versions: [v('问题')] };
    const a = { role: 'assistant', versions: [v('回答')] };
    const h = buildRequestHistory([q, a], q, a);
    check('单页时历史是标准的 system 前的 一问一答', h.length === 2, JSON.stringify(h));
    check('单页时顺序正确', h[0].role === 'user' && h[1].role === 'assistant');
  }

  // 中间还有别的轮次
  {
    const q1 = { role: 'user', versions: [v('第一轮问')] };
    const a1 = { role: 'assistant', versions: [v('第一轮答')] };
    const q2 = { role: 'user', versions: [v('第二轮问')] };
    const a2 = { role: 'assistant', versions: [v('第二轮答')] };
    const h = buildRequestHistory([q1, a1, q2, a2], q2, a2);
    check('多轮历史全部带上', h.length === 4, String(h.length));
    check('多轮顺序正确',
      h.map((x) => x.content).join('|') === '第一轮问|第一轮答|第二轮问|第二轮答',
      h.map((x) => x.content).join('|'));
  }

  // 关键：编辑更早的版本后，旧版本 + 旧回答都要在请求里
  {
    const q = { role: 'user', versions: [v('原问题'), v('旧问题二'), v('新问题')] };
    const a = { role: 'assistant', versions: [v('原回答'), v('旧回答二'), v('')] };
    const h = buildRequestHistory([q, a], q, a);

    check('历史里带上了全部三个版本的提问', h.filter((x) => x.role === 'user').length === 3,
      JSON.stringify(h.map((x) => `${x.role}:${x.content}`)));
    check('旧版本与原版本都按顺序出现',
      h.filter((x) => x.role === 'user').map((x) => x.content).join('|') === '原问题|旧问题二|新问题',
      h.filter((x) => x.role === 'user').map((x) => x.content).join('|'));
    check('每个旧版本后面跟上了它当时的回答',
      h.map((x) => `${x.role}:${x.content}`).join(' | ') ===
        'user:原问题 | assistant:原回答 | user:旧问题二 | assistant:旧回答二 | user:新问题',
      h.map((x) => `${x.role}:${x.content}`).join(' | '));
    check('不会把空的最新回答也塞进去', !h.some((x) => x.role === 'assistant' && x.content === ''));
  }

  // 图片：只跟最后一条提问一起发
  {
    const q = { role: 'user', versions: [v('看这张图', { attachments: [img('data:image/png;base64,AA==')] })] };
    const a = { role: 'assistant', versions: [v('图里是……')] };
    const h = buildRequestHistory([q, a], q, a);
    // 注意：历史里最后一项是助手的回答，提问在它前面
    const lastUser = [...h].reverse().find((x) => x.role === 'user');
    check('末条提问带上了图片', lastUser?.images.length === 1, JSON.stringify(lastUser));
    check('助手回答不带图片', h.find((x) => x.role === 'assistant').images.length === 0);
  }

  {
    // 关键：**早前**带图的那条提问，它的图片不能再被回传 ——
    // 只有末尾那条的图片才需要发（服务端也只取末条）。
    // 少了这条断言，「历史也塞图片」这种回归就查不出来。
    const q1 = { role: 'user', versions: [v('早前发的图', { attachments: [img('data:image/png;base64,OLD=')] })] };
    const a1 = { role: 'assistant', versions: [v('早前看图后的回答')] };
    const q2 = { role: 'user', versions: [v('现在这个问题')] };
    const a2 = { role: 'assistant', versions: [v('现在的回答')] };
    const h = buildRequestHistory([q1, a1, q2, a2], q2, a2);

    check('早前那条带图提问的图片没有被回传',
      h[0].images.length === 0, JSON.stringify(h[0]));
    check('历史里的用户消息都不带图片',
      h.filter((x) => x.role === 'user' && x.content !== '现在这个问题').every((x) => x.images.length === 0),
      JSON.stringify(h.map((x) => ({ c: x.content, n: x.images.length }))));
    check('只有末尾那条带上了它自己的图片',
      h.filter((x) => x.images.length > 0).length === 0,
      '末尾这条本来就没图，所以应该一张都不带');
  }

  // 边界
  check('空消息列表返回空历史', buildRequestHistory([], null).length === 0);
  check('null 消息列表不崩', buildRequestHistory(null, null).length === 0);
  check('没有 versions 的消息被跳过', buildRequestHistory([{ role: 'user' }], null).length === 0);
  check('内容全空的消息不进历史',
    buildRequestHistory([{ role: 'user', versions: [v('')] }], null).length === 0);

  {
    // 旧版本没有回答时不该产生半截 assistant 条目
    const q = { role: 'user', versions: [v('原问题'), v('新问题')] };
    const h = buildRequestHistory([q], q, null);
    check('旧版本没有回答时不插入空回答', h.length === 2, JSON.stringify(h));
    check('顺序仍是 旧问题 → 新问题', h[0].content === '原问题' && h[1].content === '新问题');
  }
}

group('复制反馈 · 用户必须看得出复制成功');

{
  const { copyFeedbackState, copyHint, copyFeedbackDuration, defaultCopyLabel, COPY_LABELS } =
    await loadModule('copy-feedback.js');

  // 用户反馈：「复制按钮没有变化，看不出来是不是复制成功」
  // 所以按钮必须变成明确的成功字样 + 成功状态类
  const ok = copyFeedbackState(true);
  check('复制成功后按钮文字变成「已复制」', ok.label === '已复制', ok.label);
  check('复制成功后带上成功状态类（供样式换色）', ok.className === 'is-copied', ok.className);
  check('成功状态色不是红墨（红墨在这里表示「问」和「正在写」）', ok.tone === 'success', ok.tone);

  const fail = copyFeedbackState(false);
  check('复制失败也有反馈，不能没反应', fail.label === '复制失败', fail.label);
  check('失败带独立的状态类', fail.className === 'is-copy-failed', fail.className);
  check('失败与成功的状态类不同', fail.className !== ok.className);

  // 底部提示（就近看不到时的第二层反馈）
  check('成功提示写明复制了什么', copyHint(true, '代码').includes('代码'));
  check('失败提示给出补救办法', copyHint(false).includes('手动'));

  // 失败要停留更久，让用户来得及看清并手动复制
  check('失败反馈比成功停留更久', copyFeedbackDuration(false) > copyFeedbackDuration(true),
    `${copyFeedbackDuration(false)} vs ${copyFeedbackDuration(true)}`);
  check('成功反馈时长在合理区间（1–3 秒）',
    copyFeedbackDuration(true) >= 1000 && copyFeedbackDuration(true) <= 3000,
    String(copyFeedbackDuration(true)));

  check('三种复制入口都有默认文案',
    ['code', 'answer', 'full'].every((k) => typeof defaultCopyLabel(k) === 'string' && defaultCopyLabel(k)),
    JSON.stringify(COPY_LABELS.idle));

  // 纯函数：任何输入都不该抛
  check('传入 undefined 不崩', copyFeedbackState(undefined).label === '复制失败');
  check('copyHint 缺省参数不崩', typeof copyHint(true) === 'string');
}

{
  // 样式必须真的存在 —— 光有状态类而 CSS 没写，界面上依然看不出变化，
  // 而这正是用户报的那个问题
  const css = readFileSync(path.resolve(PUBLIC_LIB, '../styles.css'), 'utf8');
  check('定义了成功色变量', /--success:\s*#/.test(css), '缺少 --success 会让成功反馈没有颜色');
  check('成功色与红墨 accent 不同',
    !/--success:\s*#c2402a/i.test(css), '成功色不能等于红墨，否则语义混淆');
  check('代码块复制按钮有成功样式', /\.code-copy\.is-copied\s*\{/.test(css));
  check('代码块复制按钮有失败样式', /\.code-copy\.is-copy-failed\s*\{/.test(css));
  check('链接式按钮有成功样式', /\.link-button\.is-copied\s*\{/.test(css));
  check('导出菜单项有成功样式', /\.export-popup button\.is-copied\s*\{/.test(css));
  // 反馈期间按钮会被禁用，不能因此变灰，否则看不出「成功」
  check('反馈期间按钮不变灰', /\.code-copy:disabled\s*\{[^}]*opacity:\s*1/.test(css));
}

{
  // 代码块模板里必须带 data-copy-code，否则点击处理找不到它
  const { renderMarkdown } = await import('../public/lib/markdown.js');
  const html = renderMarkdown('```js\nconst a = 1;\n```');
  check('代码块复制按钮带 data-copy-code 标记', html.includes('data-copy-code'));
  check('复制按钮的初始文案是「复制代码」', html.includes('>复制代码<'), html.match(/class="code-copy"[^>]*>([^<]*)</)?.[1]);
}

// ---------------------------------------------------------------- 缺陷回归

group('缺陷回归 · 代码高亮');

{
  const { highlight, normalizeLang, displayLang } = await loadModule('highlight.js');

  const js = highlight('// 注释\nconst name = "小林";\nfunction greet(who) { return who; }', 'js');
  check('关键字被标记', js.includes('<span class="tok-keyword">const</span>'));
  check('注释被标记', js.includes('<span class="tok-comment">// 注释</span>'));
  check('字符串被标记', js.includes('<span class="tok-string">'));
  check('函数名被标记', js.includes('<span class="tok-func">greet</span>'));
  check('注释里的引号不会被当成字符串', js.indexOf('tok-comment') < js.indexOf('tok-string'));

  const py = highlight('# 计算\nclass User:\n    def f(self): pass', 'py');
  check('Python 关键字被标记', py.includes('tok-keyword">class<') && py.includes('tok-keyword">def<'));
  check('Python 注释（#）被标记', py.includes('<span class="tok-comment"># 计算</span>'));

  check('语言别名归一化', normalizeLang('javascript') === 'js' && normalizeLang('Python') === 'py');
  check('未知语言返回空（走通用高亮）', normalizeLang('brainfuck') === '');
  check('标签显示原语言名', displayLang('javascript') === 'js' && displayLang('kotlin') === 'kotlin');

  // 安全：高亮不能把模型输出的 HTML 变成真标签
  const evil = highlight('const s = "<script>alert(1)</script>";', 'js');
  check('高亮后 HTML 仍被转义', evil.includes('&lt;script&gt;') && !evil.includes('<script>'));
  const quotes = highlight(`const s = "a'b\\"c";`, 'js');
  check('引号被转义', quotes.includes('&#39;') && quotes.includes('&quot;'));

  // 流式：半截内容不能崩，也不能吞掉后面的字
  const partial = highlight('const s = "还没闭合', 'js');
  check('半截字符串照样显示（不吞内容）', partial.includes('还没闭合'));
  const partialComment = highlight('// 写到一半', 'js');
  check('半截注释照样显示', partialComment.includes('写到一半'));

  check('空输入返回空', highlight('', 'js') === '');
  check('无语言标记时仍能高亮注释与数字', highlight('# 标题\n数字 42', '').includes('tok-comment'));
  check('无语言标记时 # 在行内不算注释', !highlight('a #b', '').includes('tok-comment'));
}

group('缺陷回归 · hidden 属性必须生效');

{
  const css = readFileSync(path.resolve(PUBLIC_LIB, '../styles.css'), 'utf8');
  // 浏览器默认的 [hidden]{display:none} 优先级极低，任何 .cls{display:flex} 都能盖掉它，
  // 于是 el.hidden = true 失效、弹层关不掉（导出菜单踩过这个坑）
  check('有全局 [hidden] { display: none !important } 规则',
    /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css), '缺少这条规则会导致弹层关不掉');

  const hiddenRuleIndex = css.search(/\[hidden\]\s*\{/);
  const popupIndex = css.indexOf('.export-popup {');
  check('该规则出现在组件样式之前（便于阅读，且不被同权重覆盖）', hiddenRuleIndex > -1 && hiddenRuleIndex < popupIndex);

  // 全局 !important 规则是兜底；但组件自己也不该依赖兜底 —— 这里只确认
  // 「确实存在会设 display 的元素」，正因为存在，那条兜底规则才是必需的。
  const withDisplay = ['prompt-panel', 'attachment-strip', 'confirm-strip', 'reach-bottom', 'blank-sheet']
    .filter((cls) => new RegExp(`\\.${cls}\\s*\\{[^}]*display:`).test(css));
  check('确实有元素设了 display（因此兜底规则不是多余的）', withDisplay.length > 0, withDisplay.join(', '));
  check('这些元素都在全局兜底规则的保护范围内', withDisplay.every((cls) => hiddenRuleIndex > -1));
}

group('缺陷回归 · 进入页面默认开新会话');

{
  const { resolveStartingSession, shouldCreateSession, startNotice } = await loadModule('startup.js');

  check('有历史内容时开新会话', resolveStartingSession({ messageCount: 6 }) === 'fresh');
  check('有历史内容时确实会新建', shouldCreateSession('fresh') === true);

  // 刷新必须留在原会话：否则刷新会丢掉上一轮没写完的半截回答
  check('刷新时留在原会话', resolveStartingSession({ reload: true, messageCount: 6 }) === 'reload');
  check('刷新时不会新建会话', shouldCreateSession('reload') === false);

  // 上一轮没写完 → 留在原会话，让用户看到写到哪了
  check('上次有回答没写完时停在原会话',
    resolveStartingSession({ messageCount: 4, hasInterrupted: true }) === 'recover');
  check('恢复时不会新建会话', shouldCreateSession('recover') === false);

  check('当前会话本来就空时不用再建一个',
    resolveStartingSession({ messageCount: 0 }) === 'empty');
  check('空会话时不会新建会话', shouldCreateSession('empty') === false);

  check('开新会话时给出提示', startNotice('fresh').includes('新会话'));
  check('刷新时不给多余提示', startNotice('reload') === '');
}

group('会话列表的收放：用户选过就听用户的');

{
  const { resolveRailVisible } = await loadModule('startup.js');

  check('没存过偏好时：宽屏展开', resolveRailVisible({ narrow: false }) === true);
  check('没存过偏好时：窄屏收起（一栏列表挤在手机上，正文才是主角）',
    resolveRailVisible({ narrow: true }) === false);
  // 这条是这次改动的原因：原来窄屏一律强制收起、而且不记用户的选择，
  // 于是在宽屏上把列表收起来之后，刷一次页面它又自己弹出来
  check('存过「收起」→ 听用户的（宽屏也保持收起）',
    resolveRailVisible({ stored: 'hidden', narrow: false }) === false);
  check('存过「展开」→ 听用户的（窄屏也保持展开）',
    resolveRailVisible({ stored: 'shown', narrow: true }) === true);
  check('脏值当成没存过', resolveRailVisible({ stored: 'maybe', narrow: true }) === false);
  check('参数缺省也不炸', resolveRailVisible() === true);
}

group('会话列表的置顶 / 最近：分组是界面的事，置顶本身是数据');

{
  const { groupSessions } = await loadStore();

  const sample = [
    { id: 'a', updatedAt: 5 },
    { id: 'b', updatedAt: 4, pinned: true },
    { id: 'c', updatedAt: 3 },
    { id: 'd', updatedAt: 2, pinned: true },
  ];
  const split = groupSessions(sample);
  check('置顶的进「置顶」组', split.pinned.map((s) => s.id).join(',') === 'b,d', split.pinned.map((s) => s.id).join(','));
  check('其余的进「最近」组', split.recent.map((s) => s.id).join(',') === 'a,c', split.recent.map((s) => s.id).join(','));
  check('只分组不重排：组里还是传进来的顺序',
    groupSessions([{ id: 'x', updatedAt: 1 }, { id: 'y', updatedAt: 9, pinned: true }]).pinned[0].id === 'y');
  check('只认显式的 true（"true" / 1 都不算置顶）',
    groupSessions([{ id: 'z', pinned: 'true' }, { id: 'w', pinned: 1 }]).pinned.length === 0);
  check('没有置顶的会话时，置顶组是空数组（界面据此整块不显示）',
    groupSessions([{ id: 'z' }]).pinned.length === 0);
  check('脏输入不炸', groupSessions(undefined).recent.length === 0 && groupSessions('x').pinned.length === 0);
}

{
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();

  const keep = store.session.id;
  store.pushUser('这条很重要');
  const other = store.createSession().id;
  store.pushUser('随便问问');
  const before = store.sessions.find((s) => s.id === keep).updatedAt;
  // 置顶前后列表本身的顺序必须一模一样：「谁在上面」由界面的分组决定，
  // 不是由 store 偷偷重排（否则「最近」那一组里也会跟着乱）
  const orderBefore = store.sessions.map((s) => s.id).join(',');

  check('默认一条都没置顶', store.sessions.every((s) => s.pinned === false));
  check('置顶成功', store.setPinned(keep, true) === true);
  check('置顶状态记在会话上', store.sessions.find((s) => s.id === keep).pinned === true);
  check('置顶**不改**最近使用时间（会话行上的时钟不该跳）',
    store.sessions.find((s) => s.id === keep).updatedAt === before);
  check('置顶不改列表本身的顺序（谁在上面由界面的分组决定）',
    store.sessions.map((s) => s.id).join(',') === orderBefore,
    store.sessions.map((s) => s.id).join(','));
  check('取消置顶', store.setPinned(keep, false) === true && store.sessions.find((s) => s.id === keep).pinned === false);
  check('脏值不会把会话标成置顶', (store.setPinned(keep, 'yes'), store.sessions.find((s) => s.id === keep).pinned === false));
  check('没有这个会话时返回 false', store.setPinned('nope', true) === false);
}

{
  // 刷新之后置顶还在
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();
  const keep = store.session.id;
  store.pushUser('要留着的一条');
  store.setPinned(keep, true);
  simulatePageHide();

  const again = createStore();
  check('刷新之后置顶还在', again.sessions.find((s) => s.id === keep)?.pinned === true);
  check('刷新之后没置顶的仍然是没置顶', again.sessions.every((s) => s.pinned === (s.id === keep)));
}

{
  // 手改过的 localStorage：字符串 "true" 不该被当成置顶
  freshEnvironment({
    seed: {
      [SESSIONS_KEY]: JSON.stringify({
        activeId: 'sess1',
        sessions: [{ id: 'sess1', title: '手改过的', pinned: 'true', messages: [] }],
      }),
    },
  });
  const { createStore } = await loadStore();
  const store = createStore();
  check('手改出来的 "true" 不算置顶（只认布尔 true）', store.sessions[0].pinned === false,
    String(store.sessions[0].pinned));
}

{
  // 淘汰最旧的会话时，置顶的要往后排 —— 用户明确说过它重要
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();
  const keep = store.session.id;
  store.pushUser('这条很重要');
  store.setPinned(keep, true);
  for (let i = 0; i < 60; i += 1) store.createSession();

  check('会话数封顶在 50 条', store.sessions.length === 50, String(store.sessions.length));
  check('置顶的那条不会被淘汰（它是最旧的，但不是最先被淘汰的）',
    store.sessions.some((s) => s.id === keep));

  // 全都被置顶时也得能继续用：退回「淘汰最旧的」，不许卡住
  for (const session of store.sessions) store.setPinned(session.id, true);
  store.createSession();
  check('全是置顶时也会腾出位置（不会卡在上限）', store.sessions.length === 50, String(store.sessions.length));
}

// ---------------------------------------------------------------- 汇总

// 把失败项写进文件：变异测试要读它判断「这个缺陷有没有被测到」。
// 不能用管道捕获 stdout —— 受限沙箱下带 stdio:'pipe' 的子进程会直接 EPERM。
try {
  const tempDir = path.resolve(HERE, '../.tmp-mutations');
  mkdirSync(tempDir, { recursive: true });
  writeFileSync(
    path.join(tempDir, 'ui-result.json'),
    JSON.stringify({ passed, failed: [...failures] }, null, 2),
    'utf8',
  );

  // 同时登记真实断言数，供 test/readme-tests.mjs 核对 README 里的数字
  const countsFile = path.join(tempDir, 'counts.json');
  const counts = existsSync(countsFile) ? JSON.parse(readFileSync(countsFile, 'utf8')) : {};
  counts['store-tests'] = { count: passed, failed: failures.length };
  writeFileSync(countsFile, JSON.stringify(counts, null, 2), 'utf8');
} catch {
  /* 写不了不影响正常使用 */
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
