// 前端持久化逻辑验证
//
//   node test/store-tests.mjs
//
// store.js 是纯逻辑模块（只依赖 localStorage 和 fetch），所以可以在 Node 里
// 装上最小替身来验证「刷新不丢、断流可恢复、清空即净」这几条真实行为。
// 这些是用户直接感知的能力，靠肉眼看界面验证太不可靠。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.resolve(HERE, '../public/lib/store.js');

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------- 环境替身

let pageHideHandlers = [];

/** 每个场景都换一份干净的 localStorage，模拟「重新打开页面」 */
function freshEnvironment({ seed = null } = {}) {
  const backing = new Map();
  if (seed) for (const [k, v] of Object.entries(seed)) backing.set(k, v);

  globalThis.localStorage = {
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => backing.set(key, String(value)),
    removeItem: (key) => backing.delete(key),
    clear: () => backing.clear(),
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

  // store.js 会注册 pagehide / visibilitychange 兜底落盘，这里给最小的事件替身
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

/**
 * 加载 store 模块。
 *
 * 模块本身无状态（所有状态都在 localStorage 里，由 createStore() 读取），
 * 所以复用同一个模块实例即可；「重新打开页面」这个语义由
 * 「换一份干净的 localStorage + 重新 createStore()」来体现。
 */
let storeModule = null;
async function loadStore() {
  if (!storeModule) {
    const source = readFileSync(STORE_PATH, 'utf8');
    const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
    storeModule = await import(dataUrl);
  }
  return storeModule;
}

const STORAGE_KEY = 'duitanlu.conversation.v1';
const SESSION_KEY = 'duitanlu.session.v1';

console.log('前端持久化 · store.js');

/**
 * 节流落盘的兜底路径：浏览器离开页面时会触发 pagehide，
 * store 借此把节流窗口里还没写的内容补上。测试里手动触发同一个事件。
 */
function simulatePageHide() {
  for (const fn of pageHideHandlers) fn();
}

// ---------------------------------------------------------------- 基本写入

{
  const backing = freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();

  check('新会话初始为空', store.messages.length === 0);
  check('生成了 sessionId', /^[A-Za-z0-9_-]{4,64}$/.test(store.sessionId), store.sessionId);
  check('sessionId 已落盘', backing.has(SESSION_KEY));

  store.pushUser('你好');
  check('提问后有 1 条消息', store.messages.length === 1);
  check('提问已写入 localStorage', backing.has(STORAGE_KEY));

  const saved = JSON.parse(backing.get(STORAGE_KEY));
  check('落盘结构带版本号', saved.version === 1);
  check('落盘内容包含提问原文', saved.messages[0].content === '你好');
}

// ---------------------------------------------------------------- 刷新不丢

{
  const backing = freshEnvironment();
  const first = await loadStore();
  const storeA = first.createStore();
  storeA.pushUser('我叫小林');
  const assistant = storeA.pushAssistant();
  storeA.appendDelta(assistant, '记下了');
  storeA.finish(assistant, 'done');

  const sessionId = storeA.sessionId;

  // 关掉页面，重新打开：同一份 localStorage
  const second = await loadStore();
  const storeB = second.createStore();

  check('刷新后对话仍在', storeB.messages.length === 2, `实际 ${storeB.messages.length} 条`);
  check('刷新后内容一致', storeB.messages[0].content === '我叫小林');
  check('刷新后助手回复一致', storeB.messages[1].content === '记下了');
  check('刷新后状态是 done', storeB.messages[1].status === 'done');
  check('刷新后 sessionId 不变', storeB.sessionId === sessionId);
  check('没有误报中断', storeB.recoveredInterrupted === 0);
  check('localStorage 仍然有效', backing.has(STORAGE_KEY));
}

// ---------------------------------------------------------------- 断流恢复

{
  freshEnvironment();
  const first = await loadStore();
  const storeA = first.createStore();
  storeA.pushUser('请解释一下闭包');
  const assistant = storeA.pushAssistant();
  storeA.appendDelta(assistant, '闭包指的是函数');
  storeA.appendDelta(assistant, '记住了它定义时的作用域');

  // 关键：写盘是节流的。浏览器在离开页面时会触发 pagehide 把最后一段补上，
  // 这里模拟的正是这个真实路径 —— 不触发它，就等同于页面被强杀。
  simulatePageHide();

  // 故意不 finish —— 模拟流式中途刷新页面
  const second = await loadStore();
  const storeB = second.createStore();

  check('中断后仍保留已写出的半截文字',
    storeB.messages[1].content === '闭包指的是函数记住了它定义时的作用域',
    JSON.stringify(storeB.messages[1].content));
  check('中断的消息被标记为 interrupted', storeB.messages[1].status === 'interrupted');
  check('中断计数为 1', storeB.recoveredInterrupted === 1);
  check('用户提问没有被牵连', storeB.messages[0].status === 'done');
}

{
  // 节流契约：一条回答的第一个增量必须立即落盘（否则中途刷新看不到任何正文），
  // 之后的增量在窗口内被合并，finish 时补齐完整内容。
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();
  store.pushUser('问');

  // 统计真正的写盘次数（localStorage.setItem 调用数）
  const realStorage = globalThis.localStorage;
  let writes = 0;
  globalThis.localStorage = {
    ...realStorage,
    setItem: (k, v) => {
      writes += 1;
      realStorage.setItem(k, v);
    },
  };

  const assistant = store.pushAssistant();
  const afterAssistant = writes;
  store.appendDelta(assistant, '第一段立即写盘');
  check('pushAssistant 落盘一次', afterAssistant === 1, `实际 ${afterAssistant} 次`);
  check('第一个增量立即落盘（中途刷新能看到正文）', writes === 2, `实际 ${writes} 次`);

  // 连着来 40 个增量：等同于 40 个 token
  for (let i = 0; i < 40; i += 1) store.appendDelta(assistant, '字');
  check('40 个增量没有被逐个写盘（节流生效）', writes <= 3, `实际 ${writes} 次`);

  const stored = JSON.parse(realStorage.getItem(STORAGE_KEY));
  check('已落盘的内容包含第一段正文', stored.messages[1].content.startsWith('第一段立即写盘'));

  store.finish(assistant, 'done');
  const afterFinish = JSON.parse(realStorage.getItem(STORAGE_KEY));
  check('finish 时补齐完整内容',
    afterFinish.messages[1].content === '第一段立即写盘' + '字'.repeat(40),
    JSON.stringify(afterFinish.messages[1].content.slice(0, 20)));

  globalThis.localStorage = realStorage;
}

// ---------------------------------------------------------------- 清空

{
  const backing = freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();
  store.pushUser('第一句');
  const assistant = store.pushAssistant();
  store.appendDelta(assistant, '回答');
  store.finish(assistant, 'done');

  let cleared = 0;
  globalThis.fetch = async (url, options) => {
    if (options?.method === 'DELETE') cleared += 1;
    return { ok: true };
  };

  store.clear();

  check('清空后消息为空', store.messages.length === 0);
  check('清空后通知了服务端删兜底副本', cleared === 1, `实际调用 ${cleared} 次`);

  // 刻意保留一个「空快照」而不是把键删掉：跨标签页同步靠 storage 事件，
  // 只有真正写入才会触发，否则别的标签页会继续显示已经清掉的对话。
  const afterClear = JSON.parse(backing.get(STORAGE_KEY) ?? 'null');
  check('清空后留下空快照（用于通知其它标签页）', Array.isArray(afterClear?.messages) && afterClear.messages.length === 0,
    backing.get(STORAGE_KEY));

  // 再刷新一次：清空必须是持久的，不能又冒出来
  const second = await loadStore();
  const storeB = second.createStore();
  check('清空后刷新依然为空（清空是持久的）', storeB.messages.length === 0);
}

// ---------------------------------------------------------------- 订阅

{
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();
  const events = [];
  const unsubscribe = store.subscribe((snapshot) => events.push(snapshot.messages.length));

  store.pushUser('a');
  store.pushUser('b');
  unsubscribe();
  store.pushUser('c');

  check('订阅在变更时收到通知', events.length === 2, JSON.stringify(events));
  check('退订后不再收到通知', events.length === 2);
}

// ---------------------------------------------------------------- 脏数据容错

{
  // 手改过的、来自旧版本的数据不能让界面白屏
  freshEnvironment({ seed: { [STORAGE_KEY]: '{ 这不是合法 JSON' } });
  const { createStore } = await loadStore();
  let store;
  let threw = false;
  try {
    store = createStore();
  } catch {
    threw = true;
  }
  check('损坏的 localStorage 不抛异常', !threw && store.messages.length === 0);
}

{
  freshEnvironment({
    seed: {
      [STORAGE_KEY]: JSON.stringify({
        version: 1,
        messages: [
          { role: 'user', content: '正常' },
          { role: '不存在的角色', content: '应被丢弃' },
          { role: 'assistant' },
          null,
          'not an object',
        ],
      }),
    },
  });
  const { createStore } = await loadStore();
  const store = createStore();
  check('丢弃非法角色与残缺条目', store.messages.length === 2, `实际 ${store.messages.length} 条`);
  check('保留合法条目', store.messages[0].content === '正常');
  check('缺失内容按空字符串兜底', store.messages[1].content === '');
  check('缺失状态兜底为 done', store.messages[1].status === 'done');
}

// ---------------------------------------------------------------- 跨标签页

{
  const backing = freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();
  store.pushUser('本页输入');

  // 另一个标签页写了新内容
  const otherTab = JSON.stringify({
    version: 1,
    sessionId: store.sessionId,
    messages: [
      { id: 'u1', role: 'user', content: '别的标签页说的', createdAt: Date.now(), status: 'done' },
      { id: 'a1', role: 'assistant', content: '别的标签页答的', createdAt: Date.now(), status: 'done' },
    ],
  });
  const before = backing.get(STORAGE_KEY);
  store.adopt(JSON.parse(otherTab).messages, { persist: false });

  check('adopt 接管了外部消息', store.messages.length === 2);
  check('adopt persist:false 不回写 localStorage（避免跨页回环）',
    backing.get(STORAGE_KEY) === before);
}

{
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();
  const ok = store.adopt([{ role: 'assistant', content: '还没写完', status: 'streaming' }]);
  check('adopt 空/有效输入判定正确', ok === true);
  check('adopt 把流式中的消息判为中断', store.messages[0].status === 'interrupted');
}

// ---------------------------------------------------------------- 重新生成

{
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();
  store.pushUser('闭包是什么');
  const assistant = store.pushAssistant();
  store.appendDelta(assistant, '半截回答');
  store.finish(assistant, 'interrupted');

  // 模拟 app.js 的 retryLast：摘掉旧回答与旧提问，再用同一条提问重发
  store.dropMessage(assistant);
  check('重试后只剩提问', store.messages.length === 1 && store.messages[0].role === 'user');
  const popped = store.popLast();
  check('popLast 取出的是那条提问', popped?.content === '闭包是什么');
  check('popLast 后列表为空', store.messages.length === 0);

  store.pushUser(popped.content);
  const retried = store.pushAssistant();
  store.appendDelta(retried, '这次成功');
  store.finish(retried, 'done');

  check('重试后提问不重复', store.messages.filter((m) => m.role === 'user').length === 1);
  check('重试后结构是 一问一答', store.messages.length === 2);
  check('重试结果无残留旧内容', store.messages[1].content === '这次成功');
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
