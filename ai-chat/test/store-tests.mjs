// 前端持久化与多会话逻辑验证
//
//   node test/store-tests.mjs
//
// store.js 只依赖 localStorage / fetch / document 事件，所以可以在 Node 里
// 装上最小替身来验证真实行为：「刷新不丢、断流可恢复、多会话互不串台、旧数据能迁移」。
// 这些是用户直接感知的能力，靠肉眼看界面验证太不可靠。

import { readFileSync } from 'node:fs';
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
  const { resolveSystemPrompt, getPersona, deriveTitle, PERSONAS } = await loadModule('personas.js');

  check('未选角色时返回空（由服务端用自己的默认提示词）', resolveSystemPrompt('default', '') === '');
  check('内置角色能取到提示词', getPersona('coding').prompt.includes('工程师'));
  check('自定义角色只用用户写的', resolveSystemPrompt('custom', '你是猫娘') === '你是猫娘');
  check('手写提示词优先于角色预设', resolveSystemPrompt('coding', '你只讲冷笑话') === '你只讲冷笑话');
  check('空白手写提示词不算数（回落到角色预设）', resolveSystemPrompt('coding', '   ').includes('工程师'));
  check('提示词过长会被截断', resolveSystemPrompt('custom', 'x'.repeat(9000)).length === 4000);
  check('未知角色回落到第一个', getPersona('nope').id === 'default');

  check('标题取首句并截断', deriveTitle('帮我看看这段代码为什么报错啊啊啊啊啊啊啊啊啊啊').length <= 25);
  check('空内容给出占位标题', deriveTitle('') === '新对话');
  check('标题去掉换行与引号', deriveTitle('  「你好\n世界」  ') === '你好 世界', deriveTitle('  「你好\n世界」  '));

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
  const assistant = storeA.pushAssistant();
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
  const assistant = storeA.pushAssistant();
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
  const assistant = store.pushAssistant();
  store.appendDelta(assistant, '第一段');
  const stored = JSON.parse(localStorage.getItem(SESSIONS_KEY));
  check('第一个增量立即落盘', stored.sessions[0].messages[1].content === '第一段',
    JSON.stringify(stored.sessions[0].messages[1].content));
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
