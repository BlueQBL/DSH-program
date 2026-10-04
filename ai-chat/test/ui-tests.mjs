// 界面状态同步的回归测试
//
//   node test/ui-tests.mjs
//
// 为什么需要它：有些缺陷不是逻辑错，而是**两个界面元素说法不一致**
// （顶部标签显示 A、下拉框显示 B），或者**某个动作少做了一步**
// （保存了却没收起面板）。这类问题在纯函数测试里看不见，
// 靠读代码也很难发现 —— 只有把 app.js 真正跑一遍才露出来。
//
// 做法：用极简 DOM 替身加载真实的 app.js，然后模拟真实点击。
// 不是为了完整模拟浏览器，而是为了让「点了之后状态对不对」可断言。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, '../public');

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

// ---------------------------------------------------------------- 极简 DOM 替身

const listeners = [];
let idSeq = 0;

function makeElement(tag = 'div', attrs = {}) {
  const el = {
    tagName: String(tag).toUpperCase(),
    id: attrs.id ?? `el${++idSeq}`,
    dataset: {},
    style: {},
    children: [],
    className: attrs.className ?? '',
    parentElement: null,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    attributes: { ...attrs },
    _text: '',
    _html: '',
    _value: '',
    _options: [],
    hidden: Boolean(attrs.hidden),
    disabled: false,
    selected: false,
    get textContent() {
      return this._text;
    },
    set textContent(v) {
      this._text = String(v);
    },
    get innerHTML() {
      return this._html;
    },
    set innerHTML(v) {
      this._html = String(v);
    },
    get value() {
      return this._value;
    },
    set value(v) {
      this._value = String(v);
    },
    get options() {
      return this._options;
    },
    focus() {
      globalThis.document.activeElement = this;
    },
    blur() {
      if (globalThis.document.activeElement === this) globalThis.document.activeElement = null;
    },
    addEventListener(type, fn) {
      listeners.push({ el: this, type, fn });
    },
    removeEventListener() {},
    querySelector(selector) {
      // 同一个选择器在同一个元素上要给回**同一个**替身：真实 DOM 里它就是那个子元素，
      // 而这个替身不解析 HTML，所以只能「每个选择器一个占位元素」。
      // 关键是稳定 —— 否则 app.js 写进去的文字，测试再读就没了。
      if (!this.__queryCache) this.__queryCache = new Map();
      if (!this.__queryCache.has(selector)) this.__queryCache.set(selector, makeElement('span'));
      return this.__queryCache.get(selector);
    },
    querySelectorAll() {
      return [];
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    replaceChildren(...kids) {
      this.children = kids;
    },
    setAttribute(k, v) {
      this.attributes[k] = String(v);
    },
    getAttribute(k) {
      return this.attributes[k];
    },
    closest(selector) {
      // 支持三种写法：单类（`.turn-body`）、单属性（`[data-action]`）、
      // 带值的属性（`[data-field="feedback-note"]`）—— app.js 里用到的就这几种。
      // 要判断祖先链，测试会自己把 parentElement 接起来。
      const want = String(selector ?? '').trim();
      const attrEq = /^\[([\w-]+)="([^"]*)"\]$/.exec(want);
      const attr = attrEq ?? /^\[([\w-]+)\]$/.exec(want);
      const cls = want.startsWith('.') ? want.slice(1) : null;
      if (!cls && !attr) return null;

      const dataKey = (name) =>
        name.startsWith('data-') ? name.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase()) : null;
      const key = attr ? dataKey(attr[1]) : null;

      const matches = (node) => {
        if (cls) return String(node.className ?? '').split(/\s+/).includes(cls);
        if (key) {
          if (!node.dataset || node.dataset[key] === undefined) return false;
          return attrEq ? String(node.dataset[key]) === attrEq[2] : true;
        }
        if (!node.attributes || node.attributes[attr[1]] === undefined) return false;
        return attrEq ? String(node.attributes[attr[1]]) === attrEq[2] : true;
      };

      let node = this;
      while (node) {
        if (matches(node)) return node;
        node = node.parentElement ?? null;
      }
      return null;
    },
    getBoundingClientRect() {
      return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    },
    // 记一笔就行：断言关心的是「有没有把当前会话滚进可视区」，不是滚动本身
    scrollIntoView(options) {
      this.__scrolledIntoView = true;
      this.__scrollOptions = options;
    },
    requestSubmit() {},
    // 模拟给 select 灌选项：app.js 用 createElement + selected 实现
    insertBefore() {},
  };
  // selected 与 value 联动，模拟真实 select 的行为
  Object.defineProperty(el, 'value', {
    get() {
      const sel = this._options.find((o) => o.selected);
      return sel ? sel.value : this._value;
    },
    set(v) {
      this._value = String(v);
      for (const o of this._options) o.selected = o.value === String(v);
    },
  });
  return el;
}

function dispatch(el, type, event = {}) {
  let ran = 0;
  for (const l of listeners) {
    if (l.el !== el || l.type !== type) continue;
    ran += 1;
    l.fn({
      ...event,
      target: event.target ?? el,
      preventDefault() {},
      stopPropagation() {},
    });
  }
  return ran;
}

/** 收集 window 上的 scroll 监听，测试里主动触发。
    必须在定义 window 之前声明 —— 否则 window 的 addEventListener 闭包会撞上 TDZ。 */
const scrollHandlers = [];
/** window 上的全部监听（按类型），用来触发 storage 这类事件 */
const windowHandlers = [];

const registry = new Map();
const getEl = (id) => {
  if (!registry.has(id)) registry.set(id, makeElement('div', { id }));
  return registry.get(id);
};

/** 报头元素（app.js 用 querySelector 取，所以要单独准备一个） */
const mastheadEl = makeElement('header');
mastheadEl.className = 'masthead';
// 模拟真实高度：offsetHeight 在替身里默认是 undefined，会让 app.js 回落到 108
mastheadEl.offsetHeight = 116;

/* 抖动那条缺陷是「写得太频繁」引起的，所以要能数出到底写了几次。
   dataset 换成带计数的访问器，顺便把每次写入时的 scrollY 记下来 ——
   有了这条写入轨迹，就能断言状态没有来回翻。 */
const compactWrites = [];
let compactValue = undefined;
Object.defineProperty(mastheadEl, 'dataset', {
  configurable: true,
  get: () => ({
    get compact() {
      return compactValue;
    },
    set compact(v) {
      compactValue = String(v);
      compactWrites.push({ value: compactValue, scrollY: globalThis.window.scrollY });
    },
  }),
});

const html = readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
for (const m of html.matchAll(/id="([^"]+)"/g)) getEl(m[1]);

// createElement 出来的元素要能被 getElementById 再取到同一个实例 ——
// 真实 DOM 里 document.getElementById 不会返回「另一个同 id 的新对象」，
// 替身如果做不到这点，就会出现「处理器挂在 A 上、测试点到 B 上」这种假失败。
const created = [];
/** document 上的监听（selectionchange / keydown 这些），测试可以主动触发 */
const documentHandlers = [];
/** 当前假选区：测试设好之后再触发 selectionchange */
let activeSelection = null;

globalThis.document = {
  getElementById: (id) => getEl(id),
  createElement: (tag) => {
    const el = makeElement(tag);
    created.push(el);
    return el;
  },
  addEventListener: (type, fn) => documentHandlers.push({ type, fn }),
  getSelection: () => activeSelection,
  body: makeElement('body'),
  activeElement: null,
  visibilityState: 'visible',
  // 报头是通过 querySelector('.masthead') 拿到的，所以替身要能返回它
  querySelector: (sel) => (sel === '.masthead' ? mastheadEl : null),
  querySelectorAll: () => [],
  documentElement: {
    scrollHeight: 1000,
    // CSS 变量：记录下来供断言检查（报头高度会写进 --masthead-h）
    _vars: {},
    _varWrites: [],
    style: {
      setProperty(name, value) {
        globalThis.document.documentElement._vars[name] = value;
        globalThis.document.documentElement._varWrites.push({ name, value });
      },
    },
  },
};
globalThis.window = {
  addEventListener: (type, fn) => {
    windowHandlers.push({ type, fn });
    // 只接住 scroll，供早期那些测试主动触发（它们直接遍历这个数组）
    if (type === 'scroll') scrollHandlers.push(fn);
  },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  scrollTo() {},
  open() {},
  prompt: () => null,
  scrollY: 0,
  innerHeight: 800,
  innerWidth: 1200,
  location: { href: 'http://localhost/' },
};

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
  clear: () => storage.clear(),
};
globalThis.performance = { getEntriesByType: () => [{ type: 'navigate' }] };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = () => {};
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} }, userAgent: 'node' },
  configurable: true,
  writable: true,
});
globalThis.Blob = class {};
globalThis.URL.createObjectURL = () => 'blob:';
globalThis.URL.revokeObjectURL = () => {};
globalThis.FileReader = class {};

for (const id of ['session-template', 'attachment-template', 'exchange-template', 'context-note-template']) {
  const el = getEl(id);
  el.content = {
    cloneNode: () => {
      const frag = makeElement('div');
      // 同一个选择器要拿到**同一个**元素：真实 DOM 里 querySelector('.x') 每次返回的都是
      // 那个元素本身，而 app.js 把节点缓存成 node.__rateDown 之类，靠它反复重绘。
      // 替身如果每次都给新元素，「缓存了但没画到界面上」这种错就永远测不出来。
      const cache = new Map();
      frag.querySelector = (selector) => {
        if (!cache.has(selector)) cache.set(selector, makeElement('span'));
        return cache.get(selector);
      };
      frag.querySelectorAll = () => [];      return frag;
    },
  };
}

// 让 select 能接收 replaceChildren 灌进来的 option
for (const id of ['model-select', 'persona-select']) {
  const el = getEl(id);
  const orig = el.replaceChildren.bind(el);
  el.replaceChildren = (...kids) => {
    orig(...kids);
    el._options = kids.filter((k) => k.tagName === 'OPTION');
    const sel = el._options.find((o) => o.selected);
    if (sel) el._value = sel.value;
  };
}

// ---------------------------------------------------------------- 假服务端

let upstreamModels = ['deepseek-v3.2', 'gpt-4o', 'gemini-2.5-flash'];
let configMode = 'model';
let configDefault = 'deepseek-v3.2';
/** 最近一次 /api/chat 的请求体：用来验证「引用真的发出去了」 */
let lastChatBody = null;
/** 最近一次 /api/title 的请求体，以及要回给客户端的标题 */
let lastTitleBody = null;
let titleReply = { ok: true, title: '变量未声明的报错' };
/** 每次 /api/feedback 的请求体（按顺序） */
let feedbackPosts = [];
/** 每次 /api/summarize 的请求体，以及要回给客户端的摘要 */
let summarizePosts = [];
let summarizeReply = { ok: true, summary: '前面聊了闭包与作用域。', model: 'gpt-4o' };
/** 聊天是否走「正常流式回答」这条路（默认关，老用例依赖失败分支） */
let chatStreams = false;
/** 流式回答里 meta 帧报告的运行模式（离线用例会把它设成 mock） */
let chatMode = 'model';

/** 造一个能用的 SSE 响应体：app.js 的 readEventStream 要 getReader() */
function sseResponse(frames) {
  const chunks = frames.map((f) => new TextEncoder().encode(`data: ${JSON.stringify(f)}\n\n`));
  let i = 0;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }),
      }),
    },
  };
}

globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target.includes('/api/config')) {
    return {
      ok: true,
      json: async () => ({ mode: configMode, model: configDefault, defaultModel: configDefault }),
    };
  }
  if (target.includes('/api/models')) {
    return {
      ok: true,
      json: async () => ({ mode: configMode, default: configDefault, models: upstreamModels }),
    };
  }
  if (target.includes('/api/history')) {
    return { ok: true, json: async () => ({ turns: [] }) };
  }
  if (target.includes('/api/title')) {
    lastTitleBody = JSON.parse(init?.body ?? '{}');
    return { ok: true, json: async () => titleReply };
  }
  if (target.includes('/api/feedback')) {
    feedbackPosts.push(JSON.parse(init?.body ?? '{}'));
    return { ok: true, json: async () => ({ ok: true, at: new Date().toISOString() }) };
  }
  if (target.includes('/api/summarize')) {
    summarizePosts.push(JSON.parse(init?.body ?? '{}'));
    return { ok: true, json: async () => summarizeReply };
  }
  if (target.includes('/api/chat')) {
    lastChatBody = JSON.parse(init?.body ?? '{}');
    if (chatStreams) {
      return sseResponse([
        { type: 'meta', mode: chatMode, model: 'deepseek-v3.2', sessionId: 's_test' },
        { type: 'delta', text: '报错是因为' },
        { type: 'delta', text: '变量没声明。' },
        { type: 'done', reason: 'stop' },
      ]);
    }
    // 故意不给 body：send() 会走「请求失败」分支，正好验证失败路径不会把引用搞丢
    return { ok: false, json: async () => ({ error: 'stub' }) };
  }
  void init;
  return { ok: true, json: async () => ({}) };
};

// ---------------------------------------------------------------- 加载真实 app.js

const errors = [];

/**
 * 最后的汇总有没有跑过。
 *
 * 这个标志是为了防一类特别难查的失败：脚本里注册了 unhandledRejection / uncaughtException
 * 之后，Node 就不再按默认行为报错退出了。如果模块顶层 await 之后抛的异常落进未处理的
 * promise 拒绝，表现就是「输出停在半路 + 退出码 0 + stderr 全空」——
 * 完全看不出是哪一行炸的（这脚本真踩过：sessions 的 TDZ 错误就是这样被吞掉的）。
 * 所以下面两个处理器在「汇总还没跑」时必须大声失败，而不是安静地退出 0。
 */
let summaryPrinted = false;

function failLoudly(kind, err) {
  if (summaryPrinted) return; // 正常流程里收集到的异常，交给汇总统一打印
  const stack = err?.stack ?? String(err);
  console.error(`\n${'─'.repeat(52)}`);
  console.error(`✗ 测试中途异常终止：${kind}`);
  console.error(`  ${err?.message ?? err}`);
  console.error('  调用栈：');
  for (const line of String(stack).split('\n').slice(0, 6)) console.error(`    ${line}`);
  console.error('  （汇总行没打印出来，说明脚本在跑到最后之前就断了）');
  process.exitCode = 1;
  process.exit(1);
}

// 异步抛出的异常（比如 timer / promise 里）不会从 dispatch 里冒出来，
// 必须单独接住，否则界面「静默半途而废」而我们看不到原因
process.on('uncaughtException', (err) => {
  errors.push(`未捕获异常：${err?.message ?? err}`);
  failLoudly('uncaughtException', err);
});
process.on('unhandledRejection', (err) => {
  errors.push(`未处理的 Promise 拒绝：${err?.message ?? err}`);
  failLoudly('unhandledRejection', err);
});

try {
  await import(`file:///${path.join(PUBLIC, 'app.js').replace(/\\/g, '/')}`);
  await new Promise((r) => setTimeout(r, 200));
} catch (err) {
  errors.push(`加载 app.js 失败：${err.message}`);
}

console.log('界面状态同步');
console.log('');
check('app.js 能加载并完成启动', errors.length === 0, errors.join('; '));

const chip = getEl('mode-label');
const modelSelect = getEl('model-select');
const promptPanel = getEl('prompt-panel');
const promptToggle = getEl('prompt-toggle');
const promptSave = getEl('prompt-save');
const promptInput = getEl('prompt-input');
const personaSelect = getEl('persona-select');
const newSessionBtn = getEl('new-session-button');

/**
 * 落盘快照与其中的当前会话。
 *
 * 必须声明在**模块顶层**：这两个名字被 ③④ 两段共用。之前 ③ 段用块内 `let` 声明、
 * ④ 段直接给它们赋值，而 ⑥ 段又在块内写了 `const sessions` ——
 * 模块里的 const/let 是模块作用域的，⑥ 段那个声明会让 447 行落进它的
 * 暂时性死区（TDZ），于是「sessions is not defined」。
 * 教训：跨段共用的变量一律在顶层用 let 声明一次，段内只赋值、不重新声明。
 */
let sessions = {};
let active = null;

/** 读一次落盘快照，并取出当前会话 —— 三段都这么做，抽出来省得再写错 */
function reloadActiveSession() {
  sessions = JSON.parse(storage.get('duitanlu.sessions.v2') ?? '{}');
  active = sessions.sessions?.find((s) => s.id === sessions.activeId);
  return active;
}

/**
 * 点一个元素，并且**要求至少有一个处理器被触发**。
 *
 * 只检查「没抛异常」是不够的：如果处理器压根没挂上，点击会静默无效果，
 * 断言失败时看不出是「逻辑不对」还是「事件没接上」。这里把两种情况分开报。
 */
function click(el, name, { expectHandlers = true } = {}) {
  const before = errors.length;
  let ran = 0;
  try {
    ran = dispatch(el, 'click');
  } catch (err) {
    errors.push(`${name} 抛异常：${err.constructor.name}: ${err.message}`);
  }
  if (errors.length > before) {
    check(`${name} 不抛异常`, false, errors.at(-1));
    return false;
  }
  if (expectHandlers && ran === 0) {
    check(`${name} 有处理器被触发`, false, `触发 0 个 —— 事件没接上（元素 #${el.id}）`);
    return false;
  }
  return true;
}

function fire(el, type, name) {
  try {
    dispatch(el, type);
  } catch (err) {
    errors.push(`${name} 抛异常：${err.constructor.name}: ${err.message}`);
  }
}

// ---------------------------------------------------------------- 断言

console.log('\n① 顶部模型标签与下拉框一致');
{
  // 初始就必须一致：靠「服务端默认」而不是「所选模型」来显示，是这次要防的缺陷。
  // 所以先做一个「默认 ≠ 所选」的场景，让两者可以被区分开。
  const serverDefault = configDefault;
  check('初始状态：标签 = 下拉框选中的那个', chip.textContent === modelSelect.value,
    `标签="${chip.textContent}" 下拉框="${modelSelect.value}"`);

  // 换一个和默认值不同的模型：如果代码用「服务端默认」而不是「所选」，
  // 这一步之后标签就不会变，下面的断言会立刻抓到
  const other = upstreamModels.find((m) => m !== serverDefault && m !== modelSelect.value)
    ?? upstreamModels.find((m) => m !== modelSelect.value);
  modelSelect.value = other;
  fire(modelSelect, 'change', '切换模型');
  check('切换模型后标签显示新模型', chip.textContent === other,
    `标签="${chip.textContent}" 期望="${other}"`);
  check('切换模型后标签与下拉框仍一致', chip.textContent === modelSelect.value);
  check('标签没有停留在服务端默认值上', chip.textContent !== serverDefault || other === serverDefault,
    `标签="${chip.textContent}" 服务端默认="${serverDefault}"`);

  // 先把标签弄脏，再触发一次同步来源的动作，确认它会被纠正。
  // 这一步是专门用来抓「某条路径忘了刷新标签」的
  const third = upstreamModels.find((m) => m !== other) ?? other;
  chip.textContent = '脏值';
  modelSelect.value = third;
  fire(modelSelect, 'change', '再次切换模型');
  check('标签被脏值污染后，换模型能纠正它', chip.textContent === third,
    `标签="${chip.textContent}" 期望="${third}"`);

  click(newSessionBtn, '新建会话');
  check('新建会话后标签仍是所选模型', chip.textContent === modelSelect.value,
    `标签="${chip.textContent}" 下拉框="${modelSelect.value}"`);
  check('新建会话后标签不为空', chip.textContent.length > 0);
  check('新建会话后标签不是脏值', chip.textContent !== '脏值');
}

console.log('\n② 提示词面板保存后自动收起');
{
  promptPanel.hidden = true;
  click(promptToggle, '展开提示词面板');
  check('点击后面板展开', promptPanel.hidden === false, `hidden=${promptPanel.hidden}`);
  check('展开时 aria-expanded=true', promptToggle.getAttribute('aria-expanded') === 'true');

  promptInput.value = '你是一位只讲冷笑话的助手';
  fire(promptInput, 'input', '输入提示词');
  click(promptSave, '保存到本对话');
  check('保存后面板自动收起', promptPanel.hidden === true, `hidden=${promptPanel.hidden}`);
  check('收起时 aria-expanded=false', promptToggle.getAttribute('aria-expanded') === 'false');

  // 保存的落盘要在还原之前检查 —— 还原会把它清掉（顺序写错会得到假失败）
  const savedAfterSave = JSON.parse(storage.get('duitanlu.sessions.v2') ?? '{}');
  const activeAfterSave = savedAfterSave.sessions?.find((s) => s.id === savedAfterSave.activeId);
  check('提示词被保存到当前会话', activeAfterSave?.systemPrompt === '你是一位只讲冷笑话的助手',
    JSON.stringify(activeAfterSave?.systemPrompt));

  click(promptToggle, '再点一次展开');
  check('收起之后还能再展开（没有被锁死）', promptPanel.hidden === false);
  click(promptToggle, '再点一次收起');
  check('再点一次能收起', promptPanel.hidden === true);

  // 还原按钮也应该收起面板，并把提示词清掉
  click(promptToggle, '第三次展开');
  click(getEl('prompt-reset'), '点还原');
  check('点「用角色预设」后面板也收起', promptPanel.hidden === true, `hidden=${promptPanel.hidden}`);
  const savedAfterReset = JSON.parse(storage.get('duitanlu.sessions.v2') ?? '{}');
  const activeAfterReset = savedAfterReset.sessions?.find((s) => s.id === savedAfterReset.activeId);
  check('点还原会清掉自定义提示词', activeAfterReset?.systemPrompt === '',
    JSON.stringify(activeAfterReset?.systemPrompt));
}

console.log('\n③ 在预设角色上保存提示词，角色不能被改成「自定义」');
{
  // 这是用户报的原话：「选择对应角色之后，查看提示词页面点保存，角色应该还是之前选的，
  // 但实际变为自定义角色」。根因是保存处理函数无条件把角色切成了 custom。
  //
  // 场景一：只查看，一个字都没改
  getEl('prompt-panel').hidden = true;
  personaSelect.value = 'coding';
  fire(personaSelect, 'change', '选择「编程助手」');
  reloadActiveSession();
  check('选择角色后会话记录的是该角色', active?.personaId === 'coding', active?.personaId);

  click(promptToggle, '展开提示词查看');
  check('提示词框自动填入了该角色的预设', promptInput.value.includes('工程师'),
    promptInput.value.slice(0, 40));

  click(promptSave, '未改动就保存');
  reloadActiveSession();
  check('未改动保存后角色仍是编程助手（没被改成自定义）', active?.personaId === 'coding', active?.personaId);
  check('未改动保存不会写入自定义提示词', active?.systemPrompt === '', JSON.stringify(active?.systemPrompt));
  check('未改动保存后下拉框仍显示编程助手', personaSelect.value === 'coding', personaSelect.value);
  check('未改动保存后面板也收起', getEl('prompt-panel').hidden === true);

  // 场景二：真的改了内容再保存
  click(promptToggle, '再展开');
  promptInput.value = `${promptInput.value}\n另外：回答必须用中文。`;
  fire(promptInput, 'input', '修改提示词');
  click(promptSave, '改动后保存');
  reloadActiveSession();
  check('改过内容保存后角色依然是编程助手', active?.personaId === 'coding', active?.personaId);
  check('改过的内容被存进会话', (active?.systemPrompt ?? '').includes('回答必须用中文'),
    JSON.stringify(active?.systemPrompt?.slice(0, 50)));
  check('改过内容保存后面板也收起', getEl('prompt-panel').hidden === true);

  // 场景三：显式选「自定义」角色时才应该用自定义内容
  click(promptToggle, '第三次展开');
  personaSelect.value = 'custom';
  fire(personaSelect, 'change', '选择「自定义」角色');
  promptInput.value = '你是一只猫';
  fire(promptInput, 'input', '写自定义提示词');
  click(promptSave, '保存自定义');
  reloadActiveSession();
  check('显式选自定义时保存后面板也收起', getEl('prompt-panel').hidden === true,
    `hidden=${getEl('prompt-panel').hidden}`);
  check('显式选自定义时角色是自定义', active?.personaId === 'custom', active?.personaId);
  check('自定义内容被保存', active?.systemPrompt === '你是一只猫', JSON.stringify(active?.systemPrompt));
}

console.log('\n④ 「只想看看」的收起按钮不改动任何东西');
{
  getEl('prompt-panel').hidden = true;
  personaSelect.value = 'writing';
  fire(personaSelect, 'change', '选择写作助手');
  click(promptToggle, '展开');
  const before = storage.get('duitanlu.sessions.v2');
  click(getEl('prompt-close'), '点右上角 × 收起');
  check('点 × 后面板收起', getEl('prompt-panel').hidden === true);
  check('点 × 不写入任何数据', storage.get('duitanlu.sessions.v2') === before);
  reloadActiveSession();
  check('点 × 不改变角色', active?.personaId === 'writing', active?.personaId);

  click(promptToggle, '再展开');
  click(getEl('prompt-close-2'), '点底部「收起」');
  check('底部「收起」按钮同样生效', getEl('prompt-panel').hidden === true);
}

console.log('\n⑤ 点击会话列表的交互不崩（清理逻辑在 store 层已单测）');
{
  // 空会话清理的判断逻辑（哪些该删、keepId 的作用、全是空会话时不删）都在
  // store-tests.mjs 里直接测过 —— 那里能精确控制状态。这里只确认界面这条路径
  // 本身不会抛异常，毕竟它要同时处理「删除 + 切换 + 重渲染」三件事。
  const sessionList = getEl('session-list');
  const handlers = listeners.filter((l) => l.el === sessionList && l.type === 'click');
  check('会话列表的点击处理器已挂上', handlers.length > 0, `${handlers.length} 个`);

  let threw = null;
  try {
    for (const h of handlers) {
      h.fn({
        target: {
          closest(sel) {
            if (sel === '.session-item') return { dataset: { id: 's_not_exist_1' } };
            return null;
          },
        },
        preventDefault() {},
        stopPropagation() {},
      });
    }
  } catch (err) {
    threw = err;
  }
  check('点一个不存在的会话不会抛异常', threw === null, threw?.message);

  try {
    for (const h of handlers) {
      h.fn({
        target: {
          closest(sel) {
            if (sel === '.session-item') return { dataset: { id: storeIdOfActive() } };
            return null;
          },
        },
        preventDefault() {},
        stopPropagation() {},
      });
    }
  } catch (err) {
    threw = err;
  }
  check('点当前会话自己也不会抛异常', threw === null, threw?.message);
}

/** 从落盘数据里取当前会话 id（不依赖 app 内部变量） */
function storeIdOfActive() {
  const snapshot = JSON.parse(storage.get('duitanlu.sessions.v2') ?? '{}');
  return snapshot.activeId ?? '';
}

console.log('\n⑥ 换角色 / 换会话后状态不串');
{
  const before = chip.textContent;
  const target = upstreamModels.find((m) => m !== before);
  modelSelect.value = target;
  fire(modelSelect, 'change', '切换模型');
  check('切换后顶部与下拉框一致', chip.textContent === modelSelect.value,
    `顶部="${chip.textContent}" 下拉框="${modelSelect.value}"`);

  personaSelect.value = 'coding';
  fire(personaSelect, 'change', '切换角色');
  check('切角色不会把模型标签改掉', chip.textContent === modelSelect.value,
    `顶部="${chip.textContent}" 下拉框="${modelSelect.value}"`);

  // 这个按钮的约定（见 app.js 的 startNewSession）：
  //  · 当前会话已经有内容 → 新建一个，并且角色回到「通用助手」（新话题重新选角色）
  //  · 当前会话本来就是空的 → 不堆一个重复的「新对话」，只把它重置回默认状态
  // 之前这条断言写的是「点一下必然多一个会话」，与上面的约定不符，
  // 而且依赖前面几段累积的状态，会随执行顺序漂移。
  const countBefore = (JSON.parse(storage.get('duitanlu.sessions.v2') ?? '{}').sessions ?? []).length;
  click(newSessionBtn, '在空会话上点新建');
  reloadActiveSession();
  check('空会话上点新建不会堆出重复的空会话', (sessions.sessions ?? []).length === countBefore,
    `${countBefore} → ${(sessions.sessions ?? []).length}`);
  check('空会话上点新建会把角色重置为通用助手', active?.personaId === 'default', active?.personaId);
  check('空会话上点新建会把自定义提示词清掉', active?.systemPrompt === '',
    JSON.stringify(active?.systemPrompt));
}

console.log('\n⑦ 离线模式下标签显示正确');
{
  // 离线时不应该显示出「模型名」这种误导性内容
  const notice = getEl('notice');
  void notice;
  check('离线模式下标签为「离线回答」或模型名（都算合理）',
    chip.textContent === '离线回答' || chip.textContent.length > 0, chip.textContent);
}

console.log('\n⑧ 报头固定：滚到任何位置都能开新会话 / 切会话');
{
  // 先去掉注释再断言：样式里的注释会解释「为什么故意不写 transition」，
  // 留着它，检查 transition 的规则就会被自己的注释绊倒。
  const css = readFileSync(path.resolve(PUBLIC, 'styles.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  // 这条是用户要求的核心：报头不跟着正文滚走
  const mastheadRule = css.match(/\.masthead\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  check('报头是 sticky（固定在顶部）', /position:\s*sticky/.test(mastheadRule), mastheadRule.slice(0, 120));
  check('报头贴在顶部（top: 0）', /top:\s*0/.test(mastheadRule));
  check('报头有不透明背景（否则正文会从它下面透出来）',
    /background:\s*color-mix|background:\s*var\(--paper\)|background:\s*#/.test(mastheadRule));

  // 层级必须高于会话栏和输入区，否则滚动时会被它们压住
  const zOf = (sel) => Number(css.match(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[\\s\\S]*?z-index:\\s*(\\d+)`))?.[1] ?? NaN);
  const zMasthead = Number(mastheadRule.match(/z-index:\s*(\d+)/)?.[1] ?? NaN);
  const zRail = zOf('.rail');
  const zComposer = zOf('.composer');
  const zPopup = zOf('.export-popup');
  check('报头层级高于会话栏', zMasthead > zRail, `报头 ${zMasthead} vs 会话栏 ${zRail}`);
  check('报头层级高于输入区', zMasthead > zComposer, `报头 ${zMasthead} vs 输入区 ${zComposer}`);
  check('导出弹层高于报头（否则会被遮挡）', zPopup > zMasthead, `弹层 ${zPopup} vs 报头 ${zMasthead}`);

  // 紧凑态：滚动后收窄，但按钮必须还在
  check('定义了紧凑态样式', /\.masthead\[data-compact="true"\]/.test(css));
  const compactRule = css.match(/\.masthead\[data-compact="true"\]\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  check('紧凑态只缩小留白（不动按钮）', /padding/.test(compactRule), compactRule.slice(0, 100));
  check('紧凑态不隐藏 masthead-tools', !/masthead-tools[^}]*display:\s*none/.test(css));

  // 会话栏的 sticky 偏移跟着报头高度走，否则它的表头会被压在报头下面
  const railRule = css.match(/\.rail\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  check('会话栏让开了报头高度', /--masthead-h/.test(railRule), railRule.slice(0, 120));

  // ---- 运行期行为
  check('滚动监听已注册', scrollHandlers.length > 0, `${scrollHandlers.length} 个`);

  // 首屏：不紧凑，并且把实测高度写给 CSS
  window.scrollY = 0;
  // 快照一份再遍历：处理器执行时若又注册了监听，直接遍历原数组会越跑越多
  for (const fn of [...scrollHandlers]) fn();
  check('首屏不是紧凑态', mastheadEl.dataset.compact === 'false', String(mastheadEl.dataset.compact));
  check('报头高度写进了 CSS 变量（供会话栏用）',
    document.documentElement._vars['--masthead-h'] === '116px',
    String(document.documentElement._vars['--masthead-h']));

  // 往下滚：切换成紧凑态
  window.scrollY = 400;
  for (const fn of [...scrollHandlers]) fn();
  check('往下滚之后切换成紧凑态', mastheadEl.dataset.compact === 'true', String(mastheadEl.dataset.compact));

  // 滚回顶部：恢复
  window.scrollY = 0;
  for (const fn of [...scrollHandlers]) fn();
  check('滚回顶部后恢复非紧凑', mastheadEl.dataset.compact === 'false', String(mastheadEl.dataset.compact));

  // ---- 抖动缺陷（用户报的「快到顶时整页一直抖」）
  //
  // 复现条件是个跨帧的反馈循环，不是同一帧里的重入：
  //   滚动越过阈值 → 报头收窄 → 文档矮了 30 多像素 → 浏览器的滚动锚定把 scrollY 拉回来
  //   → 又回到阈值另一侧 → 状态翻回去 → 文档又长回来 → …
  // 阈值那一带就会一直上下跳。所以光靠「本帧重入守卫」是挡不住的，
  // 必须让状态**只跟方向有关**：进入和退出用两个不同的阈值，中间留缓冲带。
  //
  // 断言不写死 48/8 这两个数字，而是从外部行为把两个阈值量出来 ——
  // 这样调参数不会弄坏测试，但「两个阈值退化成同一个」一定会被抓住。

  const callHandlers = () => {
    for (const fn of [...scrollHandlers]) fn();
  };
  const goTo = (y) => {
    window.scrollY = y;
    callHandlers();
    return mastheadEl.dataset.compact;
  };

  // 从完整态出发往下走，量出「进入紧凑」的位置
  goTo(0);
  let enterAt = -1;
  for (let y = 1; y <= 200; y += 1) {
    if (goTo(y) === 'true') {
      enterAt = y;
      break;
    }
  }

  // 从紧凑态出发往上走，量出「退出紧凑」的位置
  goTo(400);
  let exitAt = -1;
  for (let y = 199; y >= 0; y -= 1) {
    if (goTo(y) === 'false') {
      exitAt = y;
      break;
    }
  }

  check('能滚进紧凑态', enterAt > 0, `进入阈值 ≈ ${enterAt}`);
  check('能滚回完整态', exitAt >= 0, `退出阈值 ≈ ${exitAt}`);
  // 缓冲带要「足够宽」，不能只是比 0 大一点点：报头收窄一步会让文档高度少 60px 左右，
  // 缓冲带比这个台阶还窄的话，一次扰动就能把 scrollY 推过对岸那条线，循环照样成立。
  check('缓冲带比报头的高度台阶更宽（这是防抖的关键）',
    enterAt - exitAt >= 40, `进入 ${enterAt} − 退出 ${exitAt} = ${enterAt - exitAt}，需 ≥ 40`);

  // 缓冲带内必须「记住方向」：同一个 scrollY 得到的状态取决于从哪边来，
  // 这正是滞回的定义。单阈值实现会在这里露馅 —— 它会两次都返回同一个值。
  goTo(0);
  goTo(300);
  const fromBelowInBand = goTo(Math.round((enterAt + exitAt) / 2)); // 从紧凑态退回缓冲带
  goTo(0);
  const fromTopInBand = goTo(Math.round((enterAt + exitAt) / 2)); // 从顶部走进缓冲带
  check('缓冲带内保持来向的状态（滞回生效）',
    fromBelowInBand === 'true' && fromTopInBand === 'false',
    `从下往上 ${fromBelowInBand} / 从上往下 ${fromTopInBand}`);

  // 抖动之所以看得见，是因为写入次数跟着滚动次数跑：
  // 位置没变也写一遍，样式就一帧帧重算。现在只有状态真的变了才写。
  goTo(600); // 先滚到位，后面那三十次才真的算「位置没变」
  const writesBefore = compactWrites.length;
  for (let i = 0; i < 30; i += 1) goTo(600);
  check('同一个位置反复滚动不再重复写 DOM',
    compactWrites.length === writesBefore,
    `30 次滚动写了 ${compactWrites.length - writesBefore} 次`);

  // 并且写入的值必须是交替的，不能出现 true/true 或来回翻的轨迹
  const sweep = [];
  goTo(0);
  for (let y = 0; y <= 120; y += 3) sweep.push(goTo(y));
  for (let y = 120; y >= 0; y -= 3) sweep.push(goTo(y));
  const flips = sweep.filter((v, i) => i > 0 && v !== sweep[i - 1]).length;
  check('来回滚一遍只翻两次状态（下→上各一次，没有抖动）',
    flips === 2, `翻了 ${flips} 次：${sweep.join('').slice(0, 60)}`);

  // --masthead-h 同理：高度没变就不该重写，否则会话栏每帧都要重算 max-height
  const varWritesBefore = document.documentElement._varWrites.length;
  for (let i = 0; i < 20; i += 1) goTo(700 + i);
  check('报头高度没变时不重写 CSS 变量',
    document.documentElement._varWrites.length === varWritesBefore,
    `20 次滚动写了 ${document.documentElement._varWrites.length - varWritesBefore} 次`);

  // 布局过渡会让「文档高度」在 180ms 里一帧帧地变，等于把抖动的燃料留在页面里。
  // 报头里任何影响盒子高度的属性都不该有 transition。
  check('报头本身没有过渡（高度变化必须瞬时完成）',
    !/transition:/.test(mastheadRule), mastheadRule.slice(-80));
  check('标题字号没有过渡（字号会带动行高、行高会带动报头高度）',
    !/transition:\s*font-size/.test(css));
  check('报头不做滚动锚定候选（免得这个易出问题的角落再多一个变量）',
    /overflow-anchor:\s*none/.test(mastheadRule));
}

console.log('\n⑨ 引用回答：划中一段接着问');
{
  const settle = () => new Promise((r) => setTimeout(r, 180));
  const fireDocument = (type, event = {}) => {
    for (const h of documentHandlers) if (h.type === type) h.fn({ ...event, preventDefault() {} });
  };

  const quoteFloat = getEl('quote-float');
  const composerQuote = getEl('composer-quote');
  const composerQuoteLabel = getEl('composer-quote-label');
  const composerQuoteText = getEl('composer-quote-text');
  const input = getEl('composer-input');
  const hint = getEl('composer-hint');

  // 造一条「回答正文」元素链：.turn-body → .turn-assistant。
  // 引用的规则是「只认回答那一侧」，所以祖先链必须是真的。
  const answerBody = makeElement('div');
  answerBody.className = 'turn-body markdown';
  const answerTurn = makeElement('div');
  answerTurn.className = 'turn-assistant';
  answerBody.parentElement = answerTurn;
  const answerText = makeElement('span');
  answerText.parentElement = answerBody;

  const rect = { top: 300, left: 100, width: 200, height: 40, bottom: 340, right: 300 };
  const selectIn = (node, text) => {
    activeSelection = {
      isCollapsed: false,
      rangeCount: 1,
      anchorNode: node,
      toString: () => text,
      getRangeAt: () => ({ commonAncestorContainer: node, getBoundingClientRect: () => rect }),
      removeAllRanges: () => {
        activeSelection.isCollapsed = true;
      },
    };
  };

  // 初始：没有引用条，也没有浮标
  check('一开始输入区没有引用条', composerQuote.hidden === true);

  // 替身量出来的按钮尺寸是 0，位置就算不准 —— 给一个真实尺寸再验算定位
  quoteFloat.getBoundingClientRect = () => ({ width: 90, height: 28, top: 0, left: 0, right: 90, bottom: 28 });

  // 划中回答里的一段
  selectIn(answerText, '第三，要注意边界情况。');
  fireDocument('selectionchange');
  await settle();
  check('划中回答里的一段后浮出「引用」按钮', quoteFloat.hidden === false);
  // 选区 100..300 宽、300..340 高；按钮 90×28 → 水平居中在 155，浮到选区长上方 262
  check('浮标居中浮在选区上方',
    quoteFloat.style.left === '155px' && quoteFloat.style.top === '262px',
    `${quoteFloat.style.left} / ${quoteFloat.style.top}`);

  // 贴到屏幕最上边时，上方放不下就要翻到下方；贴到右边要被拦回来
  rect.top = 4;
  rect.bottom = 44;
  rect.left = 1180;
  rect.right = 1190;
  selectIn(answerText, '边缘的一段');
  fireDocument('selectionchange');
  await settle();
  check('上方放不下时翻到选区下方', quoteFloat.style.top === '54px', quoteFloat.style.top);
  check('靠右边缘时不会跑出屏幕', quoteFloat.style.left === '1102px', quoteFloat.style.left);
  rect.top = 300;
  rect.bottom = 340;
  rect.left = 100;
  rect.right = 300;

  // 点的这一下才是「引用」真正落地的时刻。
  // 这里**故意在点击前把选区清掉**，模拟真实浏览器：按下按钮这个动作本身就会清掉选区。
  // 如果处理函数是「点的时候再读一次选区」，它只会拿到空字符串 —— 功能看起来就是点了没反应。
  selectIn(answerText, '第三，要注意边界情况。');
  fireDocument('selectionchange');
  await settle();
  activeSelection = null;
  dispatch(quoteFloat, 'click');
  check('点「引用这段」后输入区挂上引用条', composerQuote.hidden === false);
  check('引用条里是选中的原文', composerQuoteText.textContent === '第三，要注意边界情况。');
  check('引用条标了出处', composerQuoteLabel.textContent.includes('引用回答'), composerQuoteLabel.textContent);
  check('点完浮标就收起来', quoteFloat.hidden === true);
  check('提示语告诉用户接下来做什么', hint.textContent.includes('引用'), hint.textContent);
  check('只引用还没打字时发送仍然是禁用的', getEl('send-button').disabled === true);

  // 只认回答那一侧：划在自己的提问里不该出现引用
  const userBody = makeElement('div');
  userBody.className = 'turn-body';
  const userTurn = makeElement('div');
  userTurn.className = 'turn-user';
  userBody.parentElement = userTurn;
  const userText = makeElement('span');
  userText.parentElement = userBody;
  selectIn(userText, '我自己问的话');
  fireDocument('selectionchange');
  await settle();
  check('划中自己的提问时不给引用按钮', quoteFloat.hidden === true);
  check('引用条也没被替换成提问内容', composerQuoteText.textContent === '第三，要注意边界情况。');

  // 取消引用
  dispatch(getEl('composer-quote-remove'), 'click');
  check('点 × 之后引用条收起', composerQuote.hidden === true);
  check('取消后正文也清空了', composerQuoteText.textContent === '');
  check('取消后不再提示「接着说你的问题」', !hint.textContent.includes('接着说你的问题'), hint.textContent);

  // 重新引用一次，然后发出去：引用必须真的进请求体
  selectIn(answerText, '第三，要注意边界情况。');
  fireDocument('selectionchange');
  await settle();
  dispatch(quoteFloat, 'click');
  input.value = '那第三点再展开讲讲';
  lastChatBody = null;
  dispatch(getEl('composer'), 'submit');
  await new Promise((r) => setTimeout(r, 60));

  const sent = lastChatBody?.messages ?? [];
  const lastUser = [...sent].reverse().find((m) => m.role === 'user');
  check('请求体里能找到这一轮提问', Boolean(lastUser), JSON.stringify(sent));
  check('引用原文出现在发给模型的正文里',
    typeof lastUser?.content === 'string' && lastUser.content.includes('第三，要注意边界情况。'),
    String(lastUser?.content));
  check('用户自己打的话也在，且排在引用之后',
    typeof lastUser?.content === 'string' && lastUser.content.trimEnd().endsWith('那第三点再展开讲讲'),
    String(lastUser?.content));
  check('引用用 Markdown 引用块包住（模型知道这是转引）',
    typeof lastUser?.content === 'string' && /^> /m.test(lastUser.content), String(lastUser?.content));
  check('发出去之后引用条收起来了（不会跟着下一轮）', composerQuote.hidden === true);
  check('发出去的正文被清空', input.value === '');

  // ---- 「重新生成」不能动输入区挂着的引用
  //
  // 重新生成改的是原来那一问，引用是「用户此刻正打算引的那段」。
  // 它既不该被这次重试带走（用户会发现自己挑的那段没了），
  // 也不该被塞进旧那一问（那一问引过什么早已存在它自己的版本里）。
  const sessionsRaw = JSON.parse(storage.get('duitanlu.sessions.v2'));
  const activeSession = sessionsRaw.sessions.find((s) => s.id === sessionsRaw.activeId);
  const answerMsg = [...activeSession.messages].reverse().find((m) => m.role === 'assistant');
  const answerIndex = activeSession.messages.indexOf(answerMsg);

  selectIn(answerText, '这次重试不该动的那一段');
  fireDocument('selectionchange');
  await settle();
  dispatch(quoteFloat, 'click');
  check('重试之前输入区确实挂着引用', composerQuote.hidden === false);

  const exchangeNode = makeElement('li');
  exchangeNode.className = 'exchange';
  exchangeNode.dataset.id = answerMsg.id;
  const retryButton = makeElement('button');
  retryButton.dataset.action = 'retry';
  retryButton.parentElement = exchangeNode;

  lastChatBody = null;
  dispatch(getEl('exchanges'), 'click', { target: retryButton });
  await new Promise((r) => setTimeout(r, 80));

  check('重新生成之后，输入区挂着的引用还在', composerQuote.hidden === false);
  check('重新生成不会把引用塞进原来那一问',
    !String(
      ([...(lastChatBody?.messages ?? [])].reverse().find((m) => m.role === 'user')?.content) ?? '',
    ).includes('这次重试不该动的那一段'),
    JSON.stringify(lastChatBody?.messages?.at(-1)));
  check('重新生成发出去的仍然是原来那一问',
    String(activeSession.messages[answerIndex - 1]?.content ?? '').length > 0);
}

console.log('\n⑩ 会话标题：先本地兜底，再让模型换一个');
{
  const input = getEl('composer-input');
  const sessionsIn = () => {
    const raw = JSON.parse(storage.get('duitanlu.sessions.v2'));
    return { raw, active: raw.sessions.find((s) => s.id === raw.activeId) };
  };

  // 这一节要的是「正常答完一轮」，所以把聊天打开成流式的正常分支
  chatStreams = true;
  lastTitleBody = null;
  titleReply = { ok: true, title: '"变量未声明的报错。"' }; // 带引号和句号，看客户端会不会洗

  dispatch(getEl('new-session-button'), 'click');
  check('新建之后是占位标题', sessionsIn().active.title === '新对话', sessionsIn().active.title);

  input.value = '帮我看看这段代码为什么报错';
  dispatch(getEl('composer'), 'submit');
  await new Promise((r) => setTimeout(r, 120));

  const afterFirstTurn = sessionsIn().active;
  // 第一问发出去时本地就先算好一个兜底标题 —— 侧栏不会出现空的「新对话」
  check('回答写完之后标题已经能认了（本地兜底或模型标题都可以）',
    afterFirstTurn.title.length > 2 && afterFirstTurn.title !== '新对话', afterFirstTurn.title);

  check('回答写完之后去问了模型要标题', lastTitleBody !== null, JSON.stringify(lastTitleBody));
  check('起标题的原料是开头的一问一答',
    String(lastTitleBody?.question ?? '').includes('这段代码为什么报错') &&
      String(lastTitleBody?.answer ?? '').includes('变量没声明'),
    JSON.stringify(lastTitleBody));
  check('模型标题洗掉了引号和句号', afterFirstTurn.title === '变量未声明的报错', afterFirstTurn.title);
  check('来源标成模型起的', afterFirstTurn.titleSource === 'auto', String(afterFirstTurn.titleSource));

  // 用户自己改名之后，自动改名不能再动它
  const manualId = afterFirstTurn.id;
  const renameButton = makeElement('button');
  renameButton.dataset.action = 'rename';
  const item = makeElement('li');
  item.className = 'session-item';
  item.dataset.id = manualId;
  renameButton.parentElement = item;
  globalThis.window.prompt = () => '我的调试记录';
  dispatch(getEl('session-list'), 'click', { target: renameButton });
  check('手动改名生效', sessionsIn().active.title === '我的调试记录', sessionsIn().active.title);
  check('手动改名后来源是用户', sessionsIn().active.titleSource === 'manual', sessionsIn().active.titleSource);

  // 再问一轮：不该再自动起标题（已经是 manual）
  lastTitleBody = null;
  input.value = '再帮我看看别的地方';
  dispatch(getEl('composer'), 'submit');
  await new Promise((r) => setTimeout(r, 120));
  check('用户改过名字之后不再自动请求标题', lastTitleBody === null, JSON.stringify(lastTitleBody));
  check('用户的名字没被改掉', sessionsIn().active.title === '我的调试记录', sessionsIn().active.title);

  // 明确点「起名」时才换
  titleReply = { ok: true, title: '代码报错排查' };
  const retitleButton = makeElement('button');
  retitleButton.dataset.action = 'retitle';
  const retitleItem = makeElement('li');
  retitleItem.className = 'session-item';
  retitleItem.dataset.id = manualId;
  retitleItem.dataset.turns = '2';
  retitleButton.parentElement = retitleItem;
  dispatch(getEl('session-list'), 'click', { target: retitleButton });
  await new Promise((r) => setTimeout(r, 120));
  check('点「起名」会带上后来问过的事（标题不该只描述开头）',
    Array.isArray(lastTitleBody?.laterQuestions) && lastTitleBody.laterQuestions.length > 0,
    JSON.stringify(lastTitleBody?.laterQuestions));
  check('点「起名」可以覆盖用户自己起的名字',
    sessionsIn().active.title === '代码报错排查', sessionsIn().active.title);

  // 离线模式：没有模型可用，保留本地兜底标题
  configMode = 'mock';
  chatMode = 'mock';
  lastTitleBody = null;
  dispatch(getEl('new-session-button'), 'click');
  input.value = '离线模式也要有个名字';
  dispatch(getEl('composer'), 'submit');
  await new Promise((r) => setTimeout(r, 120));
  check('离线模式不去请求模型标题', lastTitleBody === null);
  check('离线模式用的是本地算的名字',
    sessionsIn().active.title === '离线模式也要有个名字', sessionsIn().active.title);
  check('离线模式的来源是兜底', sessionsIn().active.titleSource === 'fallback', sessionsIn().active.titleSource);
  configMode = 'model';
  chatMode = 'model';
  chatStreams = false;
}

console.log('\n⑪ 评价回答：赞 / 踩 + 意见反馈');
{
  const input = getEl('composer-input');
  const sessionsIn = () => {
    const raw = JSON.parse(storage.get('duitanlu.sessions.v2'));
    return { raw, active: raw.sessions.find((s) => s.id === raw.activeId) };
  };
  const answerOf = (session) => session.messages.find((m) => m.role === 'assistant');
  const exchangeNodeFor = (id) => getEl('exchanges').children.find((n) => n.dataset?.id === id);
  // 对谈里的点击/输入都挂在列表上（事件委托），所以要把事件派发到列表、target 指向按钮
  const clickIn = (target) => dispatch(getEl('exchanges'), 'click', { target });
  const typeIn = (target) => dispatch(getEl('exchanges'), 'input', { target });

  chatStreams = true;
  chatMode = 'model';

  // 先问一轮，拿到一条回答
  input.value = '闭包是什么';
  dispatch(getEl('composer'), 'submit');
  await new Promise((r) => setTimeout(r, 120));

  const session = sessionsIn().active;
  const answer = answerOf(session);
  const exchange = exchangeNodeFor(answer.id);
  check('评价按钮画在那条回答上', Boolean(exchange?.__rateDown));

  // 替身不解析 HTML，所以 <template> 里写着的 class 与 data-* 都要手动补：
  // 真实 DOM 里交换节点本来就是 <li class="exchange">、按钮本来就有 data-action。
  // 少了这两样，事件处理函数会在第一、二步就找不到目标（看起来像「点了没反应」）。
  exchange.className = 'exchange';
  exchange.__rateDown.parentElement = exchange;
  exchange.__rateUp.parentElement = exchange;
  exchange.__rateDown.dataset.action = 'rate-down';
  exchange.__rateUp.dataset.action = 'rate-up';
  exchange.__feedbackNote.dataset.field = 'feedback-note';
  exchange.__feedbackNote.parentElement = exchange.__feedbackBox;
  exchange.__feedbackBox.parentElement = exchange;
  // 原因小标签是 app.js 用 createElement 现造的，但它们的祖先链也要接上 ——
  // 事件处理函数要靠 closest('.exchange') 反查是哪一条回答
  exchange.__feedbackReasons.parentElement = exchange;

  feedbackPosts = [];
  clickIn(exchange.__rateDown);
  await new Promise((r) => setTimeout(r, 60));

  check('点「没用」立刻记下了评价', answerOf(sessionsIn().active).feedback?.rating === 'down');
  check('评价写进了那一版（跟着页走）',
    answerOf(sessionsIn().active).versions[0].feedback?.rating === 'down');
  check('按钮变成选中态', exchange.__rateDown.dataset.active === 'true', String(exchange.__rateDown.dataset.active));
  check('「有用」没有被带上', exchange.__rateUp.dataset.active === 'false');
  check('拉踩时展开了补充框', exchange.__feedbackBox.hidden === false);
  check('补充框里给出一排原因', exchange.__feedbackReasons.children.length >= 4,
    String(exchange.__feedbackReasons.children.length));
  check('点了就发到服务端（这一下本身就是信号）', feedbackPosts.length === 1, JSON.stringify(feedbackPosts));
  check('发出去的是拉踩', feedbackPosts[0]?.rating === 'down');
  check('带上答案开头（不然这条日志没有意义）',
    String(feedbackPosts[0]?.answerExcerpt ?? '').includes('变量没声明'), String(feedbackPosts[0]?.answerExcerpt));

  // 勾两个原因 → 填一句说明 → 提交
  const chips = exchange.__feedbackReasons.children;
  chips[0].dataset.action = 'feedback-reason';
  chips[1].dataset.action = 'feedback-reason';
  chips[0].parentElement = exchange.__feedbackReasons;
  chips[1].parentElement = exchange.__feedbackReasons;
  clickIn(chips[0]);
  clickIn(chips[1]);
  // 每次点完都会重画这排标签（replaceChildren 换成了新元素），所以要重新取一遍
  const chipsNow = exchange.__feedbackReasons.children;
  check('原因可以多选并标成选中态',
    chipsNow[0].dataset.active === 'true' && chipsNow[1].dataset.active === 'true',
    `${chipsNow[0]?.dataset.active} / ${chipsNow[1]?.dataset.active}`);

  exchange.__feedbackNote.value = '第三条不对';
  typeIn(exchange.__feedbackNote);
  const saveButton = makeElement('button');
  saveButton.dataset.action = 'feedback-save';
  saveButton.parentElement = exchange;
  clickIn(saveButton);
  await new Promise((r) => setTimeout(r, 60));

  const saved = answerOf(sessionsIn().active).feedback;
  check('提交后原因存下来了', saved?.reasons.length === 2, JSON.stringify(saved?.reasons));
  check('提交后补充说明也存下来了', saved?.note === '第三条不对', String(saved?.note));
  check('提交后又发了一条到服务端', feedbackPosts.length === 2, String(feedbackPosts.length));
  check('这条带上了原因与说明',
    feedbackPosts[1]?.reasons.length === 2 && feedbackPosts[1]?.note === '第三条不对',
    JSON.stringify(feedbackPosts[1]));
  check('提交后补充框收起', exchange.__feedbackBox.hidden === true);
  check('界面上留下「附了说明」的痕迹',
    exchange.__feedbackSaved.hidden === false && exchange.__feedbackSaved.textContent === '已附说明',
    String(exchange.__feedbackSaved.textContent));

  // 点另一边 = 改判
  clickIn(exchange.__rateUp);
  await new Promise((r) => setTimeout(r, 60));
  const changed = answerOf(sessionsIn().active).feedback;
  check('点另一边就是改判', changed?.rating === 'up');
  check('改判会把上一次的原因清掉（它不再适用了）', changed?.reasons.length === 0, JSON.stringify(changed?.reasons));
  check('改判后「有用」是选中态',
    exchange.__rateUp.dataset.active === 'true' && exchange.__rateDown.dataset.active === 'false');

  // 再点一次同一个 = 取消
  const before = feedbackPosts.length;
  clickIn(exchange.__rateUp);
  await new Promise((r) => setTimeout(r, 60));
  check('再点一次取消评价（ChatGPT 点下去就改不了，这里能）',
    answerOf(sessionsIn().active).feedback === null);
  check('取消也会告诉服务端一声（日志要说实话）',
    feedbackPosts.length === before + 1 && feedbackPosts.at(-1)?.action === 'clear',
    JSON.stringify(feedbackPosts.at(-1)));

  // 服务端没写成功时要说出来，而不是让用户以为交上去了
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/feedback')) {
      return { ok: false, json: async () => ({ error: '磁盘满了' }) };
    }
    return realFetch(url, init);
  };
  clickIn(exchange.__rateDown);
  await new Promise((r) => setTimeout(r, 60));
  check('服务端失败时本地仍然记下了', answerOf(sessionsIn().active).feedback?.rating === 'down');
  check('并且明确告诉用户没提交上去',
    getEl('composer-hint').textContent.includes('没能交给服务端'), getEl('composer-hint').textContent);
  globalThis.fetch = realFetch;
  clickIn(exchange.__rateDown); // 收尾：把评价取消掉
  await new Promise((r) => setTimeout(r, 60));

  chatStreams = false;
}

console.log('\n⑫ 上下文压缩：手动压一次，看摘要有没有真的顶替上文');
{
  const input = getEl('composer-input');
  const sessionsIn = () => {
    const raw = JSON.parse(storage.get('duitanlu.sessions.v2'));
    return { raw, active: raw.sessions.find((s) => s.id === raw.activeId) };
  };
  const compressButton = getEl('compress-button');
  // 替身不解析 HTML，所以模板里的 class 不会带过来 —— 靠「app 往里面画过什么」
  // 来认这个压缩标记：只有它自己的 label 会被写上文字
  const contextNotes = () =>
    getEl('exchanges').children.filter((n) => String(n.querySelector('[data-field="context-note-label"]')?.textContent ?? '').length > 0);

  configMode = 'model';
  chatMode = 'model';
  chatStreams = true;

  // 先灌一个够长的会话：手动压缩要求「有东西可压」（≥ 2000 字）
  const seed = JSON.parse(storage.get('duitanlu.sessions.v2'));
  const active = seed.sessions.find((s) => s.id === seed.activeId);
  active.messages = [];
  for (let i = 1; i <= 6; i += 1) {
    active.messages.push({
      id: `u_seed_${i}`,
      role: 'user',
      content: `第 ${i} 个问题`.padEnd(400, '问'),
      versions: [{ content: `第 ${i} 个问题`.padEnd(400, '问'), createdAt: 0, attachments: [], quote: null, feedback: null }],
      versionCount: 1,
    });
    active.messages.push({
      id: `a_seed_${i}`,
      role: 'assistant',
      content: `第 ${i} 个回答`.padEnd(400, '答'),
      versions: [{ content: `第 ${i} 个回答`.padEnd(400, '答'), createdAt: 0, attachments: [], feedback: null, status: 'done', model: 'gpt-4o' }],
      versionCount: 1,
    });
  }
  storage.set('duitanlu.sessions.v2', JSON.stringify(seed));
  // 让 app 重新读一遍这份数据：走它自己的「跨标签页同步」通道
  //（等价于刷新，也顺便验证了这条路真的把数据接进去了）
  for (const h of windowHandlers.filter((x) => x.type === 'storage')) {
    h.fn({ key: 'duitanlu.sessions.v2', newValue: JSON.stringify(seed) });
  }
  reloadActiveSession();
  await new Promise((r) => setTimeout(r, 60));

  check('没有压缩时正文里没有压缩标记', contextNotes().length === 0);
  check('有内容可压时「压缩上文」按钮出现', compressButton.hidden === false);

  summarizePosts = [];
  dispatch(compressButton, 'click');
  await new Promise((r) => setTimeout(r, 120));

  const afterCompress = sessionsIn().active;
  check('压缩后会话上有了摘要', afterCompress.summary?.text === '前面聊了闭包与作用域。', JSON.stringify(afterCompress.summary));
  // 手动压缩只留最后一轮：12 条里压掉 10 条（自动压缩会留 6 条，压 6 条）
  check('手动压缩覆盖到只剩最后一轮', afterCompress.summary?.covers === 10, String(afterCompress.summary?.covers));
  check('消息一条都没少（压缩不是删除）', afterCompress.messages.length === 12, String(afterCompress.messages.length));
  check('压缩请求发到了服务端', summarizePosts.length === 1, String(summarizePosts.length));
  check('请求里带上待压缩的对话',
    String(summarizePosts[0]?.messages?.[1]?.content ?? '').includes('第 1 个问题'), String(summarizePosts[0]?.messages?.[1]?.content).slice(0, 60));
  check('提示词要求只输出摘要', /只输出摘要/.test(String(summarizePosts[0]?.messages?.[0]?.content ?? '')));

  check('正文里出现了压缩标记', contextNotes().length === 1, String(contextNotes().length));
  const note = contextNotes()[0];
  check('标记说明了压掉多少条', String(note.querySelector('[data-field="context-note-label"]').textContent).includes('以上 10 条'),
    String(note.querySelector('[data-field="context-note-label"]').textContent));
  check('摘要默认收着', note.querySelector('[data-field="context-note-text"]').hidden === true);
  check('按钮写的是「查看摘要」', note.querySelector('[data-action="toggle-summary"]').textContent === '查看摘要');

  // 展开 / 收起
  const toggle = note.querySelector('[data-action="toggle-summary"]');
  toggle.dataset.action = 'toggle-summary';
  toggle.parentElement = note;
  dispatch(getEl('exchanges'), 'click', { target: toggle });
  const noteAfter = contextNotes()[0];
  check('点「查看摘要」能展开摘要原文',
    noteAfter.querySelector('[data-field="context-note-text"]').hidden === false);
  check('展开的是模型看到的那段摘要',
    noteAfter.querySelector('[data-field="context-note-text"]').textContent === '前面聊了闭包与作用域。');

  // 这一轮发出去的请求必须用摘要顶替前面八条
  input.value = '接着说说作用域';
  lastChatBody = null;
  dispatch(getEl('composer'), 'submit');
  await new Promise((r) => setTimeout(r, 120));
  const sent = lastChatBody?.messages ?? [];
  check('发出去的请求最前面是摘要', sent[0]?.role === 'system', JSON.stringify(sent[0])?.slice(0, 60));
  check('摘要正文在里面', String(sent[0]?.content ?? '').includes('前面聊了闭包与作用域。'));
  check('被压掉的那几轮不再逐条发',
    !sent.some((m) => String(m.content).includes('第 1 个问题')), JSON.stringify(sent.map((m) => m.content?.slice(0, 12))));
  check('最近的几轮仍然发原文',
    sent.some((m) => String(m.content).includes('第 6 个问题')), JSON.stringify(sent.map((m) => m.content?.slice(0, 12))));
  check('请求以 user 消息结尾', sent.at(-1)?.role === 'user');

  // 取消压缩：本地消息本来就没动，所以只是「之后重新发全文」
  const beforeCancel = sessionsIn().active.messages.length;
  const dropButton = contextNotes()[0].querySelector('[data-action="drop-summary"]');
  dropButton.dataset.action = 'drop-summary';
  dropButton.parentElement = contextNotes()[0];
  dispatch(getEl('exchanges'), 'click', { target: dropButton });
  check('可以取消压缩', sessionsIn().active.summary === null);
  check('取消后标记也没了', contextNotes().length === 0);
  check('取消压缩不会删掉任何消息（它只改发给模型的那一份）',
    sessionsIn().active.messages.length === beforeCancel,
    `${beforeCancel} → ${sessionsIn().active.messages.length}`);

  chatStreams = false;
}

console.log('\n⑬ 改动落在已压缩的部分里：摘要必须作废');
{
  const sessionsIn = () => {
    const raw = JSON.parse(storage.get('duitanlu.sessions.v2'));
    return { raw, active: raw.sessions.find((s) => s.id === raw.activeId) };
  };
  const contextNotes = () =>
    getEl('exchanges').children.filter((n) => String(n.querySelector('[data-field="context-note-label"]')?.textContent ?? '').length > 0);

  chatStreams = true;
  chatMode = 'model';

  // 再压一次（⑫ 结尾把摘要取消了）
  dispatch(getEl('compress-button'), 'click');
  await new Promise((r) => setTimeout(r, 120));
  const compressed = sessionsIn().active;
  check('先有了一份摘要', Boolean(compressed.summary?.text), JSON.stringify(compressed.summary));
  const covered = compressed.summary?.covers ?? 0;
  check('摘要覆盖了前面一段', covered >= 8, String(covered));

  // 找到「被摘要覆盖的那一轮」对应的对谈节点，改它的提问
  const targetIndex = Math.max(0, covered - 2); // 覆盖范围里的最后一条用户提问
  const targetQuestion = compressed.messages[targetIndex];
  const targetAnswer = compressed.messages[targetIndex + 1];
  check('取到的是一问一答', targetQuestion?.role === 'user' && targetAnswer?.role === 'assistant');
  const exchange = getEl('exchanges').children.find((n) => n.dataset?.id === targetAnswer.id);
  check('这一轮在界面里有节点', Boolean(exchange?.__editInput));

  exchange.className = 'exchange';
  const resendButton = makeElement('button');
  resendButton.dataset.action = 'edit-resend';
  resendButton.parentElement = exchange;
  exchange.__editInput.value = '改过的老旧问题';

  const messagesBefore = sessionsIn().active.messages.length;
  dispatch(getEl('exchanges'), 'click', { target: resendButton });
  await new Promise((r) => setTimeout(r, 180));

  check('改过已压缩的部分之后，摘要作废了', sessionsIn().active.summary === null,
    JSON.stringify(sessionsIn().active.summary));
  check('作废之后正文里的压缩标记也没了', contextNotes().length === 0);
  check('消息没有因此被删（编辑是追加一页）', sessionsIn().active.messages.length === messagesBefore,
    `${messagesBefore} → ${sessionsIn().active.messages.length}`);
  check('提示明确说了正在发生什么',
    getEl('composer-hint').textContent.includes('摘要已作废'), getEl('composer-hint').textContent);
  check('改动本身生效了（新版本记下了新文字）',
    JSON.stringify(sessionsIn().active.messages[targetIndex].versions).includes('改过的老旧问题'));

  chatStreams = false;
}

/**
 * 按标签开关配对，从 index.html 里切出一个元素的整段 HTML。
 *
 * 只数一种标签就够用（`div` 或 `aside`）—— 我们要判断的是「谁在谁里面」。
 * 刻意不靠缩进匹配：缩进会变，而这类断言最怕的就是「因为格式变了就悄悄失效」。
 */
function sliceBlock(source, startTag, tagName = 'div') {
  const start = source.indexOf(startTag);
  if (start < 0) return '';
  const openTag = `<${tagName}`;
  const closeTag = `</${tagName}>`;
  let depth = 0;
  let cursor = start;
  while (cursor < source.length) {
    const nextOpen = source.indexOf(openTag, cursor);
    const nextClose = source.indexOf(closeTag, cursor);
    if (nextClose < 0) break;
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth += 1;
      cursor = nextOpen + openTag.length;
      continue;
    }
    depth -= 1;
    cursor = nextClose + closeTag.length;
    if (depth === 0) return source.slice(start, cursor);
  }
  return source.slice(start);
}

console.log('\n⑭ 布局：会话列表与聊天框各占各的列，互不干扰');
{
  // 用户实测反馈：会话一多，左栏的会话列表长到吸顶高度上限时盖住了输入区
  // —— 因为输入区当时挂在 .board 外面、横跨整页宽度，正好和左栏处在同一条水平带上，
  // 而会话栏的 z-index 更高（3 > 2），既挡住显示也截走点击。
  // 修法是结构性的：把输入区（以及清空确认条）放进右栏内部，两边永远不共享空间。
  const stageBlock = sliceBlock(html, '<div class="stage">', 'div');
  const railBlock = sliceBlock(html, '<aside class="rail"', 'aside');

  check('切得出右栏（.stage）这一段', stageBlock.length > 500, String(stageBlock.length));
  check('切得出会话栏（.rail）这一段', railBlock.length > 200, String(railBlock.length));

  check('聊天框在右栏里（与会话详情同一列）', stageBlock.includes('id="composer"'));
  check('会话详情（.sheet）也在右栏里', stageBlock.includes('id="sheet"'));
  check('清空确认条也在右栏里（它说的是这个会话的事）', stageBlock.includes('id="confirm-strip"'));
  check('会话栏里没有聊天框', !railBlock.includes('id="composer"'));
  check('会话栏里没有会话详情', !railBlock.includes('id="exchanges"'));
  check('输入区排在会话详情之后（在右栏里位于正文下方）',
    stageBlock.indexOf('id="sheet"') < stageBlock.indexOf('id="composer"'));
  check('清空确认条排在输入区之前（它就在输入框上方）',
    stageBlock.indexOf('id="confirm-strip"') < stageBlock.indexOf('id="composer"'));

  const css = readFileSync(path.resolve(PUBLIC, 'styles.css'), 'utf8');
  const boardRule = css.match(/\.board\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const railRule = css.match(/\.rail\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const listRule = css.match(/\.session-list\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const composerRule = css.match(/\.composer\s*\{[\s\S]*?\n\}/)?.[0] ?? '';

  check('会话栏与右栏是两列（互不重叠的前提）',
    /grid-template-columns:\s*\d+px\s+minmax\(0,\s*1fr\)/.test(boardRule), boardRule.slice(0, 80));
  check('会话栏有高度上限（会话再多也不撑高页面）', /max-height:\s*calc\(100dvh/.test(railRule), railRule);
  check('列表在自己那一格里滚动', /overflow-y:\s*auto/.test(listRule), listRule.slice(0, 60));
  check('聊天框仍然吸底，滚到哪儿都能打字',
    /position:\s*sticky/.test(composerRule) && /bottom:\s*0/.test(composerRule), composerRule.slice(0, 80));
  check('窄屏下会话栏变成列表上的一段（不是盖在上面）',
    /@media \(max-width: 1000px\)[\s\S]*?\.rail\s*\{[\s\S]*?position:\s*static/.test(css));
  check('列表滚到头不会把整页带着滚', /overscroll-behavior:\s*contain/.test(listRule), listRule);

  // 会话多了之后，新建/切换到的会话可能停在可视区外 —— 要主动滚一下。
  // 替身里「列表元素」就是按选择器缓存的那个占位元素，app 对谁调了 scrollIntoView，
  // 测试就从同一个选择器把它取回来查（这正是那处缓存的意义）。
  const activeStub = getEl('session-list').querySelector('.session-item[data-active="true"]');
  activeStub.__scrolledIntoView = false;
  dispatch(getEl('new-session-button'), 'click');
  await new Promise((r) => setTimeout(r, 60));
  check('新建会话后把当前会话滚进可视区（列表很长时才看得见）',
    activeStub.__scrolledIntoView === true);
}

console.log(`\n${'─'.repeat(52)}`);
summaryPrinted = true;
if (errors.length) {
  console.log('运行期异常：');
  for (const e of errors) console.log(`  · ${e}`);
}

// 把失败项写进文件：变异测试要读它判断「这个缺陷有没有被测到」。
// 不能用管道捕获 stdout —— 受限沙箱下带 stdio:'pipe' 的子进程会直接 EPERM。
try {
  const tempDir = path.resolve(HERE, '../.tmp-mutations');
  mkdirSync(tempDir, { recursive: true });
  writeFileSync(
    path.join(tempDir, 'ui-result.json'),
    JSON.stringify({ passed, failed: [...failures, ...errors] }, null, 2),
    'utf8',
  );

  // 同时登记真实断言数，供 test/readme-tests.mjs 核对 README 里的数字。
  // 必须用「实际执行了多少」，不能去数字面 check( —— 有的在条件分支里、有的在循环里。
  const countsFile = path.join(tempDir, 'counts.json');
  const counts = existsSync(countsFile) ? JSON.parse(readFileSync(countsFile, 'utf8')) : {};
  counts['ui-tests'] = { count: passed, failed: failures.length + errors.length };
  writeFileSync(countsFile, JSON.stringify(counts, null, 2), 'utf8');
} catch {
  /* 写不了不影响正常使用 */
}

if (failures.length === 0 && errors.length === 0) {
  console.log(`全部通过：${passed} 项断言`);
  process.exit(0);
}
console.log(`通过 ${passed} 项，失败 ${failures.length + errors.length} 项`);
for (const f of [...failures, ...errors]) console.log(`  · ${f}`);
process.exit(1);
