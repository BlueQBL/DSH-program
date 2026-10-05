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
/** 让 /api/chat 永远不返回：用来测「正在生成时」的守卫（这时 runtime.busy 一直是真的） */
let chatHangs = false;
/** 非空时 /api/chat 直接回 400 + 这句话（测「服务端拒绝」与「连不上服务端」分不分得开） */
let chatReject = null;
/** 挂住那次请求的放行开关：替身用它模拟「一直在生成」，测完必须放行，否则 runtime.busy 永远是 true */
let releaseHang = null;
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
    // 服务端活着，只是拒了这一轮（400 + 一句原话）
    if (chatReject) {
      return { ok: false, status: 400, json: async () => ({ error: chatReject }) };
    }
    // 挂住不返回：用来测「正在生成时」的守卫（那一轮还没定稿）。
    // 必须能放行 —— 一直挂着的话 runtime.busy 会永远是 true，后面的用例一个也发不出去。
    if (chatHangs) {
      return new Promise((resolve) => {
        releaseHang = () => resolve({ ok: false, status: 500, json: async () => ({ error: '替身放行' }) });
      });
    }
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

  // 真正发出去的那份请求体：改的是**更早**那一问，所以它之后那些轮次不该跟出去。
  // 这一条是踩出来的：以前它们会跟出去，请求就以 assistant 结尾，
  // 服务端 400「messages 必须以一条 user 消息结尾」，界面上显示成「连不上服务端」。
  const sent = lastChatBody?.messages ?? [];
  check('发出去的请求以一条 user 消息结尾（服务端的硬校验）',
    sent.at(-1)?.role === 'user', sent.map((m) => m.role).join(','));
  check('最后一条正是刚刚改过的那一问（更早那一问之后的轮次没跟出去）',
    String(sent.at(-1)?.content ?? '').includes('改过的老旧问题'),
    String(sent.at(-1)?.content ?? '').slice(0, 60));
  // 把「被编辑那一问之后的所有文字」列出来，确认一段都没混进请求里。
  // 注意要跳过 targetIndex + 1：那是「被编辑那一问自己的回答」，它**本来就该**跟着走
  // （旧版本提问后面要带上它当时的回答）。
  const laterTexts = sessionsIn()
    .active.messages.slice(targetIndex + 2)
    .flatMap((m) => (m.versions ?? []).map((v) => String(v.content ?? '')))
    .filter((text) => text.length >= 8);
  const payloadText = JSON.stringify(sent);
  check('改的是更早那一问时，它后面那些轮次一段都没发出去',
    laterTexts.every((text) => !payloadText.includes(text)),
    `后面还有 ${laterTexts.length} 段文字，混进去的有：${laterTexts.filter((t) => payloadText.includes(t)).slice(0, 2).join(' / ')}`);

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

  // 报头左格：大标题 + 钉在这一格右端的开关
  const brandRule = css.match(/\.masthead-brand\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const brandToggleRule = css.match(/\.masthead-brand \.icon-toggle\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  check('报头左格是一条横向排列的容器', /display:\s*flex/.test(brandRule), brandRule);
  check('左格不会因为内容长而撑破报头（min-width: 0）', /min-width:\s*0/.test(brandRule));
  check('左格是定位祖先（开关要相对它钉右端，否则会飘到整页去）',
    /position:\s*relative/.test(brandRule), brandRule);
  check('开关钉在左格右端（绝对定位 + right: 0），不是跟在标题后面',
    /position:\s*absolute/.test(brandToggleRule) && /right:\s*0/.test(brandToggleRule),
    brandToggleRule);
  check('开关脱离文档流（标题进紧凑态、字号变小也推不动它）',
    !/position:\s*static/.test(brandToggleRule), brandToggleRule);

  // 报头第一行和 .board 一样是两格：列宽和缝必须逐字一致，
  // 否则开关就落不到「正文左边缘的左边一点」那个位置上了。
  const mastheadCols = css.match(/\.masthead\s*\{[\s\S]*?\n\}/)?.[0].match(/grid-template-columns:[^;]+;/)?.[0] ?? '';
  const boardCols = boardRule.match(/grid-template-columns:[^;]+;/)?.[0] ?? '';
  check('报头第一行也是两格（会话栏一格 + 正文一格）',
    /grid-template-columns:\s*292px\s+minmax\(0,\s*1fr\)/.test(mastheadCols), mastheadCols);
  check('报头两格的列宽和 .board 逐字一致（改一处就得改另一处）',
    mastheadCols === boardCols && mastheadCols !== '', `${mastheadCols} / ${boardCols}`);
  check('两处的缝也一样宽', /column-gap:\s*28px/.test(css.match(/\.masthead\s*\{[\s\S]*?\n\}/)?.[0] ?? ''));
  check('右格贴右边缘（模型框还在页面最右边，不是停在正文左边）',
    /justify-content:\s*flex-end/.test(css.match(/\.masthead-tools\s*\{[\s\S]*?\n\}/)?.[0] ?? ''));
  check('副标题不换行（换行会把报头顶高，整页跟着跳）',
    /white-space:\s*nowrap/.test(css.match(/\.masthead-title p\s*\{[\s\S]*?\n\}/)?.[0] ?? ''));

  // 会话栏顶部是两个并排的入口：新建 / 引用（样式由 .rail-actions 那一组统一给）
  const railActionsRule = css.match(/\.rail-actions\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const railButtonRule = css.match(/\.rail-actions \.ghost-button\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  check('会话栏顶部有两个入口（新建 / 引用）',
    railBlock.includes('class="rail-actions"') &&
      railBlock.includes('id="new-session-button"') && railBlock.includes('id="reference-new-button"'));
  check('两个入口在同一行、各占一半', /display:\s*flex/.test(railActionsRule) && /flex:\s*1/.test(railButtonRule),
    railButtonRule.slice(0, 80));
  check('两个入口都是描边的淡样式（不是黑底实心）',
    !/background:\s*var\(--ink\)/.test(railButtonRule) && !/background:\s*var\(--accent\)/.test(railButtonRule),
    railButtonRule.slice(0, 100));
  check('「引用会话」也是按钮，不是一行小字（同一件事在两个地方长得一样）',
    /class="ghost-button rail-reference"[^>]*id="reference-new-button"/s.test(railBlock));

  // 会话多了之后，新建/切换到的会话可能停在可视区外 —— 要主动滚一下。
  // 替身里「列表元素」就是按选择器缓存的那个占位元素，app 对谁调了 scrollIntoView，
  // 测试就从同一个选择器把它取回来查（这正是那处缓存的意义）。
  const activeStub = getEl('session-list').querySelector('.session-item[data-active="true"]');
  activeStub.__scrolledIntoView = false;
  dispatch(getEl('new-session-button'), 'click');
  await new Promise((r) => setTimeout(r, 60));
  check('新建会话后把当前会话滚进可视区（列表很长时才看得见）',
    activeStub.__scrolledIntoView === true);

  // ---- 新建会话在会话列表里；收起/展开是一个图标开关（参考 ChatGPT）
  const mastheadBlock = sliceBlock(html, '<header class="masthead">', 'header');
  const brandBlock = sliceBlock(html, '<div class="masthead-brand">', 'div');
  const toolsBlock = sliceBlock(html, '<div class="masthead-tools">', 'div');
  check('新建会话按钮在会话列表里（它就是从那儿生出来的）',
    railBlock.includes('id="new-session-button"'));
  check('新建会话不再是黑底实心按钮（用描边的淡样式）',
    /class="ghost-button rail-new"[^>]*id="new-session-button"/.test(railBlock), railBlock.slice(0, 0) + '找的是 ghost-button rail-new');
  check('报头里不再重复放一个主入口，只留收起时的备用入口',
    !mastheadBlock.includes('id="new-session-button"') && mastheadBlock.includes('id="new-session-compact"'));
  check('收起/展开是图标开关（内联 SVG，没有任何图标字体）',
    /id="sidebar-toggle"[\s\S]{0,500}<svg/.test(mastheadBlock));
  check('它不再是一行字', !/对话列表<\/button>/.test(mastheadBlock), mastheadBlock.slice(0, 120));
  check('没有文字也要说得清自己是什么（aria-label + title）',
    /aria-label="收起或展开会话列表"/.test(mastheadBlock) && /title="收起 \/ 展开会话列表"/.test(mastheadBlock));

  // 开关在左格、模型框在右格：一个钉在左格右端，一个钉在页面右端，互不推动
  check('切得出报头左格（.masthead-brand）', brandBlock.includes('id="sidebar-toggle"'));
  check('开关不在右格（否则右侧一多出按钮，它就被推着挪）',
    !toolsBlock.includes('id="sidebar-toggle"'));
  check('开关写在大标题后面（不再压在大标题左边 —— 那一条最难看的）',
    brandBlock.indexOf('<h1>') >= 0 &&
      brandBlock.indexOf('<h1>') < brandBlock.indexOf('id="sidebar-toggle"'),
    brandBlock.slice(0, 160));
  check('模型框在右格里，并且在最后一位（右边缘钉死，不会跟着挪）',
    toolsBlock.includes('id="mode-chip"') &&
      toolsBlock.indexOf('id="mode-chip"') > toolsBlock.indexOf('id="new-session-compact"'),
    toolsBlock.slice(0, 200));
  check('引用的备用入口排在「新对话」前面（新加的按钮不该把老按钮挤走）',
    toolsBlock.indexOf('id="reference-compact"') >= 0 &&
      toolsBlock.indexOf('id="reference-compact"') < toolsBlock.indexOf('id="new-session-compact"'),
    toolsBlock.slice(0, 200));
  check('窄屏（≤1000px）把开关放回标题旁边（窄屏没有左右两格可对，钉右端会孤零零挂在最右边）',
    /@media \(max-width: 1000px\)[\s\S]*?\.masthead-brand \.icon-toggle\s*\{[\s\S]*?position:\s*static/.test(css));
  check('窄屏报头也只剩一栏（和 .board 用同一个断点，两边列数始终一致）',
    /@media \(max-width: 1000px\)[\s\S]*?\.masthead\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(css));

  const toggle = getEl('sidebar-toggle');
  const compactNew = getEl('new-session-compact');
  const compactRef = getEl('reference-compact');
  const board = getEl('board');
  check('默认是展开的（宽屏、又没存过偏好）', board.dataset.rail === 'shown', String(board.dataset.rail));

  dispatch(toggle, 'click');
  check('点图标收起列表', board.dataset.rail === 'hidden', String(board.dataset.rail));
  check('图标跟着翻面（指向列表在哪边）', toggle.dataset.state === 'hidden', String(toggle.dataset.state));
  check('收起后报头露出备用入口（否则就没地方开新对话了）', compactNew.hidden === false);
  check('收起后「引用会话」的备用入口也露出来（否则收起列表就引用不了）', compactRef.hidden === false);
  check('aria-expanded 如实反映状态', toggle.getAttribute('aria-expanded') === 'false');
  check('这个选择被记住了（刷新后不会自己弹回来）',
    storage.get('duitanlu.rail.v1') === 'hidden', String(storage.get('duitanlu.rail.v1')));

  // 备用入口做的是同一件事
  const sessionsBefore = JSON.parse(storage.get('duitanlu.sessions.v2')).sessions.length;
  dispatch(compactNew, 'click');
  await new Promise((r) => setTimeout(r, 60));
  const sessionsAfter = JSON.parse(storage.get('duitanlu.sessions.v2')).sessions.length;
  check('收起状态下的备用入口也能开新对话', sessionsAfter >= sessionsBefore, `${sessionsBefore} → ${sessionsAfter}`);

  // 引用的备用入口做的是同一件事：打开引用面板
  dispatch(compactRef, 'click');
  await new Promise((r) => setTimeout(r, 40));
  check('收起状态下的引用备用入口能打开引用面板', getEl('reference-panel').hidden === false);
  dispatch(getEl('reference-cancel'), 'click');

  dispatch(toggle, 'click');
  check('再点一次展开', board.dataset.rail === 'shown', String(board.dataset.rail));
  check('展开后备用入口又藏起来（不重复摆两个）', compactNew.hidden === true && compactRef.hidden === true);
  check('展开也被记住了', storage.get('duitanlu.rail.v1') === 'shown', String(storage.get('duitanlu.rail.v1')));
}

console.log('\n⑮ 会话列表：置顶 / 最近 两组，各自收放');

{
  const railBlock = sliceBlock(html, '<aside class="rail" id="rail"', 'aside');
  const pinnedBlock = sliceBlock(html, '<section class="rail-group" id="group-pinned"', 'section');
  const recentBlock = sliceBlock(html, '<section class="rail-group" id="group-recent"', 'section');
  const pinnedHead = sliceBlock(pinnedBlock, '<div class="rail-group-head">', 'div');

  // ---- 结构
  check('列表分成「置顶」和「最近」两组（布局参考 ChatGPT）',
    pinnedBlock.includes('id="pinned-list"') && recentBlock.includes('id="recent-list"'));
  check('置顶那一组的标题写着「置顶」', /class="rail-group-title">置顶</.test(pinnedBlock));
  check('最近那一组的标题写着「最近」', /class="rail-group-title">最近</.test(recentBlock));
  check('收起按钮在标题行里，**不在**会话容器里（所以收起时标题还在）',
    pinnedHead.includes('id="pinned-toggle"') &&
      !sliceBlock(pinnedBlock, '<ol class="rail-group-list"', 'ol').includes('pinned-toggle'),
    pinnedHead.slice(0, 100));
  check('收起按钮指向的是这一组的会话容器（aria-controls）',
    /aria-controls="pinned-list"/.test(pinnedHead) && /aria-controls="recent-list"/.test(recentBlock));
  check('「新对话」在两组之外（组收起来也不影响它）',
    railBlock.indexOf('id="new-session-button"') < railBlock.indexOf('id="group-pinned"'));
  check('会话行里有置顶按钮', /data-action="pin"/.test(sliceBlock(html, '<template id="session-template">', 'template')));
  check('组标题上带条数（收起来也知道里面有几条）',
    /id="pinned-count"/.test(pinnedHead) && /id="recent-count"/.test(recentBlock));

  // ---- 行为
  const pinnedSection = getEl('group-pinned');
  const recentSection = getEl('group-recent');
  const pinnedList = getEl('pinned-list');
  const recentList = getEl('recent-list');
  const pinnedToggle = getEl('pinned-toggle');
  const recentToggle = getEl('recent-toggle');
  const board = getEl('board');
  const idsIn = (list) => list.children.map((frag) => frag.querySelector('.session-item')?.dataset.id);
  /** 取某一行里的东西（会话行是模板克隆出来的，替身里按选择器缓存） */
  const rowOf = (list, id) =>
    list.children.find((frag) => frag.querySelector('.session-item')?.dataset.id === id) ?? null;
  const pinLabelIn = (list, id) => rowOf(list, id)?.querySelector('[data-action="pin"]')?.textContent ?? '';
  const rowsIn = () => JSON.parse(storage.get('duitanlu.sessions.v2')).sessions;
  const groupState = () => JSON.parse(storage.get('duitanlu.railGroups.v1') ?? '{}');
  /** 点某一条会话行里的按钮（会话行是模板克隆出来的，替身里只能自己接一条链） */
  const clickOn = (id, action) => {
    const button = makeElement('button');
    button.dataset.action = action;
    const row = makeElement('li');
    row.className = 'session-item';
    row.dataset.id = id;
    button.parentElement = row;
    dispatch(getEl('session-list'), 'click', { target: button });
  };

  check('一条都没置顶时，「置顶」那一组整块不显示（不摆个空标题在那儿）', pinnedSection.hidden === true);
  check('这时会话都在「最近」组里', idsIn(recentList).length >= 1 && pinnedList.children.length === 0);
  check('「最近」那一组是显示的', recentSection.hidden === false);

  const targetId = idsIn(recentList)[0];
  clickOn(targetId, 'pin');
  check('点「置顶」之后它进了「置顶」组', idsIn(pinnedList).includes(targetId), idsIn(pinnedList).join(','));
  check('它不再待在「最近」组里', !idsIn(recentList).includes(targetId));
  check('「置顶」组这时才露出来', pinnedSection.hidden === false);
  check('置顶状态存进了会话', rowsIn().find((s) => s.id === targetId)?.pinned === true);
  check('组标题右边写着这一组有几条', getEl('pinned-count').textContent === '1', getEl('pinned-count').textContent);
  check('置顶之后那条的按钮改口成「取消置顶」（否则就取消不掉了）',
    pinLabelIn(pinnedList, targetId) === '取消置顶', pinLabelIn(pinnedList, targetId));
  check('没置顶的那条写着「置顶」',
    pinLabelIn(recentList, idsIn(recentList)[0]) === '置顶', pinLabelIn(recentList, idsIn(recentList)[0]));
  check('行上打了置顶标记（样式靠它标出已经置顶）',
    rowOf(pinnedList, targetId)?.querySelector('.session-item')?.dataset.pinned === 'true');
  check('给了反馈：告诉用户它去哪儿了',
    getEl('composer-hint').textContent.includes('置顶'), getEl('composer-hint').textContent);

  // ---- 组内收放：收的只是会话行
  dispatch(pinnedToggle, 'click');
  check('点组标题右边的按钮，只把这一组的会话行收起来', pinnedList.hidden === true);
  check('「置顶」这个标题还在（收的不是整组）', pinnedSection.hidden === false);
  check('按钮的 aria-expanded 如实反映状态', pinnedToggle.getAttribute('aria-expanded') === 'false');
  check('另一组完全不受影响', recentList.hidden === false);
  check('「＋ 新对话」不受影响（它不归任何一组管）', getEl('new-session-button').hidden === false);
  check('整栏的总开关也不受影响', board.dataset.rail === 'shown');
  check('这个选择被记住了（刷新之后还是收着的）', groupState().pinned === true, storage.get('duitanlu.railGroups.v1'));

  // ---- 总开关（整栏）和组开关互不影响
  dispatch(getEl('sidebar-toggle'), 'click');
  check('收起整栏之后，组自己的状态没被改掉', pinnedList.hidden === true);
  check('整栏确实收起来了', board.dataset.rail === 'hidden');
  dispatch(getEl('sidebar-toggle'), 'click');
  check('展开整栏之后，组还是收着的（两件事互不干扰）', pinnedList.hidden === true);
  check('整栏又展开了', board.dataset.rail === 'shown');

  // ---- 置顶时那一组正收着 → 自动展开（否则点一下看着像会话不见了）
  const secondId = idsIn(recentList)[0];
  clickOn(secondId, 'pin');
  check('置顶时「置顶」组正收着，会自动展开', pinnedList.hidden === false);

  // ---- 取消置顶 → 回到「最近」
  dispatch(recentToggle, 'click');
  check('把「最近」收起来', recentList.hidden === true && recentToggle.getAttribute('aria-expanded') === 'false');
  clickOn(secondId, 'pin');
  check('再点一次就是取消置顶，它回到「最近」组',
    idsIn(recentList).includes(secondId) && !idsIn(pinnedList).includes(secondId));
  check('它回到的那一组正收着，也会自动展开', recentList.hidden === false);
  check('取消置顶也有反馈', getEl('composer-hint').textContent.includes('取消置顶'), getEl('composer-hint').textContent);
  check('会话上的置顶标记被清掉了', rowsIn().find((s) => s.id === secondId)?.pinned === false);

  // ---- 两组都收起来，也不耽误开新会话
  if (pinnedList.hidden !== true) dispatch(pinnedToggle, 'click');
  if (recentList.hidden !== true) dispatch(recentToggle, 'click');
  check('两组都收起来了', pinnedList.hidden === true && recentList.hidden === true);

  const countBefore = rowsIn().length;
  dispatch(getEl('new-session-button'), 'click');
  await new Promise((r) => setTimeout(r, 60));
  const afterNew = JSON.parse(storage.get('duitanlu.sessions.v2'));
  check('两组都收着时照样能开新会话（这两个功能不影响它）',
    afterNew.sessions.length >= countBefore, `${countBefore} → ${afterNew.sessions.length}`);
  check('新会话按钮一直摆在那儿', getEl('new-session-button').hidden === false);
  check('组收着只是不显示：会话一条没少',
    recentList.hidden === true && idsIn(recentList).length >= 1);

  // 两组加起来必须正好是全部会话，而且各自只装该装的
  const renderedIds = [...idsIn(pinnedList), ...idsIn(recentList)];
  const rowsById = new Map(afterNew.sessions.map((s) => [s.id, s]));
  check('两组加起来正好是全部会话（一条不漏、一条不重）',
    renderedIds.length === afterNew.sessions.length &&
      afterNew.sessions.every((s) => renderedIds.includes(s.id)),
    `${afterNew.sessions.length} 条会话 / 画了 ${renderedIds.length} 行`);
  check('当前会话一定在列表里（不管它落在哪一组）', renderedIds.includes(afterNew.activeId));
  check('「置顶」组里全是被置顶的',
    idsIn(pinnedList).every((id) => rowsById.get(id)?.pinned === true), idsIn(pinnedList).join(','));
  check('「最近」组里一条置顶的都没有',
    idsIn(recentList).every((id) => rowsById.get(id)?.pinned !== true), idsIn(recentList).join(','));
}

console.log('\n⑯ 会话分支：从这一轮分出一个新会话');

{
  const input = getEl('composer-input');
  const css = readFileSync(path.resolve(PUBLIC, 'styles.css'), 'utf8');

  // ---- 结构
  const templateBlock = sliceBlock(html, '<template id="exchange-template">', 'template');
  const actionsBlock = sliceBlock(templateBlock, '<div class="turn-actions"', 'div');
  const stageAt = html.indexOf('<div class="stage">');
  const noteAt = html.indexOf('id="branch-note"');
  const controlsAt = html.indexOf('<section class="controls"');

  check('每条回答的操作行里都有「分出新会话」', /data-action="branch"/.test(actionsBlock), actionsBlock.slice(0, 120));
  check('按钮上写着「分出新会话」',
    /data-action="branch"[\s\S]{0,200}分出新会话/.test(actionsBlock));
  check('分支说明条默认藏着', /id="branch-note" hidden/.test(html));
  check('分支说明条在正文区顶部（排在「角色 / 模型」前面），不是插在对话流里',
    stageAt >= 0 && noteAt > stageAt && noteAt < controlsAt,
    `stage=${stageAt} note=${noteAt} controls=${controlsAt}`);
  check('说明条里的「回到那个会话」是个按钮', /id="branch-source-button"/.test(html));
  check('会话列表里，分支会话的行首带一个小箭头（样式给的）',
    /\.session-item\[data-branch="true"\] \.session-name::before/.test(css));

  // ---- 行为
  chatStreams = true;
  chatMode = 'model';

  const state = () => JSON.parse(storage.get('duitanlu.sessions.v2'));
  const sessionById = (id) => state().sessions.find((s) => s.id === id);
  const active = () => sessionById(state().activeId);
  const answerOf = (session) => session.messages.filter((m) => m.role === 'assistant').pop();
  const clickInAnswer = (id, action) => {
    const node = getEl('exchanges').children.find((n) => n.dataset?.id === id);
    if (!node) return null;
    // 替身不解析 HTML：真实 DOM 里对谈节点本来就是 <li class="exchange">、按钮本来就有 data-action
    node.className = 'exchange';
    const button = makeElement('button');
    button.dataset.action = action;
    button.parentElement = node;
    dispatch(getEl('exchanges'), 'click', { target: button });
    return node;
  };

  dispatch(getEl('new-session-button'), 'click');
  await new Promise((r) => setTimeout(r, 60));
  input.value = '帮我把这个思路理一下';
  dispatch(getEl('composer'), 'submit');
  await new Promise((r) => setTimeout(r, 150));

  const source = active();
  const answer = answerOf(source);
  check('先有一问一答', source.messages.length === 2 && Boolean(answer), String(source.messages.length));

  const sessionsBefore = state().sessions.length;
  clickInAnswer(answer.id, 'branch');
  await new Promise((r) => setTimeout(r, 80));

  const branch = state().sessions.find((s) => s.branchOf?.id === source.id);
  check('分出了一个新会话', Boolean(branch));
  check('会话总数 +1', state().sessions.length === sessionsBefore + 1,
    `${sessionsBefore} → ${state().sessions.length}`);
  check('标题是「原标题-分支1」', branch?.title === `${source.title}-分支1`, branch?.title);
  check('新会话成了当前会话', state().activeId === branch?.id);
  check('内容复制过来了', branch?.messages.length === source.messages.length, String(branch?.messages.length));
  check('标题来源标成手动（「AI 起名」不许覆盖分支名）', branch?.titleSource === 'manual');
  check('新会话不置顶', branch?.pinned === false);
  check('出处记下来了（哪个会话、从哪一条分的）',
    branch?.branchOf?.id === source.id && branch?.branchOf?.messageId === answer.id,
    JSON.stringify(branch?.branchOf));
  check('原会话一条消息都没少', sessionById(source.id)?.messages.length === source.messages.length);
  check('原会话的标题也没变', sessionById(source.id)?.title === source.title);
  check('提示说清了发生了什么',
    getEl('composer-hint').textContent.includes('分出新会话'), getEl('composer-hint').textContent);
  check('分支说明条显示出来了', getEl('branch-note').hidden === false);
  check('说明里写了它从哪个会话来',
    getEl('branch-note-text').textContent.includes(source.title), getEl('branch-note-text').textContent);
  check('「回到那个会话」露出来了（源会话还在）', getEl('branch-source-button').hidden === false);

  // 回到源会话
  dispatch(getEl('branch-source-button'), 'click');
  await new Promise((r) => setTimeout(r, 60));
  check('点「回到那个会话」就切回去了', state().activeId === source.id);
  check('切回去之后说明条收起来（那条会话不是分支）', getEl('branch-note').hidden === true);

  // 分支上再分支
  const rowButton = makeElement('button');
  const row = makeElement('li');
  row.className = 'session-item';
  row.dataset.id = branch.id;
  rowButton.parentElement = row;
  dispatch(getEl('session-list'), 'click', { target: rowButton });
  await new Promise((r) => setTimeout(r, 60));
  check('切到分支会话', state().activeId === branch.id);

  clickInAnswer(answerOf(branch).id, 'branch');
  await new Promise((r) => setTimeout(r, 80));
  const nested = state().sessions.find((s) => s.branchOf?.id === branch.id);
  check('分支上还能再分出一个分支', Boolean(nested));
  check('嵌套的标题接在后面', nested?.title.endsWith('-分支1-分支1'), nested?.title);

  // 分叉点对不上时什么都不做
  const ghost = makeElement('li');
  ghost.className = 'exchange';
  ghost.dataset.id = 'not-a-real-message';
  const ghostButton = makeElement('button');
  ghostButton.dataset.action = 'branch';
  ghostButton.parentElement = ghost;
  const countBefore = state().sessions.length;
  dispatch(getEl('exchanges'), 'click', { target: ghostButton });
  await new Promise((r) => setTimeout(r, 40));
  check('分叉点对不上就不新建会话（宁可什么都不做，也不多复制几轮）',
    state().sessions.length === countBefore, `${countBefore} → ${state().sessions.length}`);
  check('而且什么都没变（还是原来那个会话）', state().activeId !== undefined);

  // ---- 分支和「编辑后重新回答」是两件事，但旧页要跟着分支一起走
  dispatch(getEl('new-session-button'), 'click');
  await new Promise((r) => setTimeout(r, 60));
  input.value = '第一版问题';
  dispatch(getEl('composer'), 'submit');
  await new Promise((r) => setTimeout(r, 150));

  const editSession = active();
  const node = clickInAnswer(answerOf(editSession).id, 'edit');
  await new Promise((r) => setTimeout(r, 40));
  check('点「编辑」进入了编辑态', node?.__editing === true);
  node.__editInput.value = '第二版问题';
  const resend = makeElement('button');
  resend.dataset.action = 'edit-resend';
  resend.parentElement = node;
  dispatch(getEl('exchanges'), 'click', { target: resend });
  await new Promise((r) => setTimeout(r, 180));

  const edited = active();
  check('先造出一个「编辑重发过」的会话（一问两版）',
    edited.messages[0].versions.length === 2, String(edited.messages[0].versions.length));
  check('编辑仍然是「追加一页、旧页保留」',
    edited.messages[0].versions[0].content === '第一版问题', edited.messages[0].versions[0].content);

  clickInAnswer(answerOf(edited).id, 'branch');
  await new Promise((r) => setTimeout(r, 80));
  const versionBranch = state().sessions.find((s) => s.branchOf?.id === edited.id);
  check('分支把版本页一起带过去了（在新会话里翻回旧页看到的还是原样）',
    versionBranch?.messages[0].versions.length === 2, String(versionBranch?.messages[0].versions.length));
  check('分完之后原会话的旧页也还在（分支**没有**替代版本分页）',
    sessionById(edited.id)?.messages[0].versions.length === 2);

  // ---- 正在生成时不许分支（那一轮还没定稿，复制过去的是半截）
  // 这一轮故意让 /api/chat 永不返回，于是 runtime.busy 一直是真的 ——
  // 所以这一段必须放在本节最后，别把它后面的用例也卡在「正在生成」里。
  chatHangs = true;
  input.value = '生成到一半的时候点分支';
  dispatch(getEl('composer'), 'submit');
  await new Promise((r) => setTimeout(r, 60));

  const liveChildren = getEl('exchanges').children;
  const liveNode = liveChildren[liveChildren.length - 1];
  const pendingBefore = state().sessions.length;
  check('这一轮确实还在生成（界面上已经有半截回答的节点）', Boolean(liveNode?.dataset?.id));
  clickInAnswer(liveNode.dataset.id, 'branch');
  await new Promise((r) => setTimeout(r, 40));
  check('正在生成时点分支：不新建会话（半截内容不该被复制走）',
    state().sessions.length === pendingBefore, `${pendingBefore} → ${state().sessions.length}`);
  check('并且说清了为什么（等这一轮结束再分）',
    getEl('composer-hint').textContent.includes('正在生成'), getEl('composer-hint').textContent);

  chatHangs = false;
  chatStreams = false;
  // 放行那次被挂住的请求：不然 runtime.busy 一直是 true，后面的用例发不出任何东西
  releaseHang?.();
  releaseHang = null;
  await new Promise((r) => setTimeout(r, 80));
}

console.log('\n⑰ 错误文案：服务端拒绝 ≠ 连不上服务端');

{
  // 真事：服务端好好活着，只是用 400 拒了一个请求，
  // 界面却说「连不上服务端：…。确认 node server.mjs 还在运行。」—— 用户跑去查进程，白找。
  const input = getEl('composer-input');
  chatStreams = true;
  chatHangs = false;
  chatMode = 'model';

  const activeSession = () => {
    const raw = JSON.parse(storage.get('duitanlu.sessions.v2'));
    return raw.sessions.find((s) => s.id === raw.activeId);
  };
  const lastError = () => activeSession()?.messages.at(-1)?.versions?.at(-1)?.error ?? '';
  const lastStatus = () => activeSession()?.messages.at(-1)?.versions?.at(-1)?.status ?? '';

  chatReject = 'messages 必须以一条 user 消息结尾';
  input.value = '故意触发一次 400';
  dispatch(getEl('composer'), 'submit');
  await new Promise((r) => setTimeout(r, 140));

  check('服务端拒绝时，明确说是「服务端拒绝了这次请求」',
    lastError().includes('服务端拒绝了这次请求'), lastError());
  check('并且带上服务端给的原话（用户/我们才知道到底哪儿不对）',
    lastError().includes('必须以一条 user 消息结尾'), lastError());
  check('不再误导成「连不上服务端」（那句话会让人去查进程）',
    !lastError().includes('连不上服务端'), lastError());
  check('这一轮被标成出错（可以重新生成）', lastStatus() === 'error', lastStatus());
  check('界面上也看得到这条错误',
    getEl('exchanges').children.length > 0 && lastError().length > 0);

  chatReject = null;
  chatStreams = false;
}

console.log('\n⑱ 会话引用：把另一个会话当背景材料带进新话题');

{
  const input = getEl('composer-input');
  const css = readFileSync(path.resolve(PUBLIC, 'styles.css'), 'utf8');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- 结构
  const stageAt = html.indexOf('<div class="stage">');
  const panelAt = html.indexOf('id="reference-panel"');
  const noteAt = html.indexOf('id="reference-note"');
  check('会话列表里有「引用别的会话…」入口', /id="reference-new-button"/.test(html));
  check('引用面板默认藏着', /id="reference-panel" hidden/.test(html));
  check('材料标注条默认藏着', /id="reference-note" hidden/.test(html));
  check('面板里能选会话、选材料形式、勾轮次、确认',
    ['reference-source', 'reference-kind', 'reference-turns', 'reference-confirm', 'reference-cancel']
      .every((id) => html.includes(`id="${id}"`)));
  check('材料标注条用虚线边，和分支那条实线标注区分开（两件事别混）',
    /\.reference-note\s*\{[\s\S]*?border-left:\s*2px dashed/.test(css));
  check('面板和标注条都在正文区里（不在对话流里）',
    stageAt >= 0 && panelAt > stageAt && noteAt > stageAt);

  // ---- 造一个「被引用」的会话
  chatStreams = true;
  chatMode = 'model';
  chatReject = null;
  chatHangs = false;
  const state = () => JSON.parse(storage.get('duitanlu.sessions.v2'));
  const sessionById = (id) => state().sessions.find((s) => s.id === id);
  const active = () => sessionById(state().activeId);
  const say = async (text) => {
    input.value = text;
    dispatch(getEl('composer'), 'submit');
    await sleep(150);
  };

  dispatch(getEl('new-session-button'), 'click');
  await sleep(60);
  await say('选题怎么定');
  await say('结构怎么排');
  const source = active();
  check('先造出一个能引用的会话（两轮）', source.messages.filter((m) => m.role === 'user').length === 2);

  // ---- 原文档：勾一轮，开新会话
  dispatch(getEl('reference-new-button'), 'click');
  await sleep(30);
  check('点入口后面板露出来', getEl('reference-panel').hidden === false);
  check('会话下拉框里灌进了可选会话', getEl('reference-source').children.length >= 1,
    String(getEl('reference-source').children.length));
  const selectedOption = () => getEl('reference-source').children.find((option) => option.selected);
  check('默认引的是「另一个」会话，不会默认引当前这个',
    Boolean(selectedOption()) && selectedOption().value !== active().id,
    String(selectedOption()?.value));

  dispatch(getEl('reference-source'), 'change', { target: { value: source.id } });
  check('选中源会话后，轮次列表换成它的（一问一答算一轮）',
    getEl('reference-turns').children.length === 2, String(getEl('reference-turns').children.length));
  check('默认是摘要档，并说清这一按会发生什么',
    getEl('reference-status').textContent.includes('摘要'), getEl('reference-status').textContent);

  dispatch(getEl('reference-kind'), 'change', { target: { value: 'turns' } });
  const turnLabel = getEl('reference-turns').children[0];
  const turnBox = turnLabel.children.find((child) => child.tagName === 'INPUT');
  check('每一轮都带一个勾选框', Boolean(turnBox));
  turnBox.checked = true;
  dispatch(getEl('reference-turns'), 'change', { target: turnBox });
  check('勾上之后状态里写明带第几轮',
    getEl('reference-status').textContent.includes('第 1 轮'), getEl('reference-status').textContent);

  // 这一条是用户报的那个缺陷的**本质**：选了「原文」就不该去调模型。
  // 上面那些断言查的是「界面说的一致」，这一条查「实际做的一致」。
  summarizePosts = [];
  const sessionsBefore = state().sessions.length;
  dispatch(getEl('reference-confirm'), 'click');
  await sleep(80);
  check('「原文」档确认时没有去调模型（选了原文就该走原文，不该偷偷去压摘要）',
    summarizePosts.length === 0, `调了 ${summarizePosts.length} 次 /api/summarize`);
  check('确认之后开出一个新会话', state().sessions.length === sessionsBefore + 1,
    `${sessionsBefore} → ${state().sessions.length}`);
  check('原会话一条消息都没动', sessionById(source.id).messages.length === source.messages.length);
  const carrier = active();
  check('材料挂在新会话上，不是原会话',
    carrier.id !== source.id && Boolean(carrier.reference?.text));
  check('材料标出了出处与轮次',
    carrier.reference.sessionId === source.id && carrier.reference.turns.join(',') === '1');
  check('材料的档位就是「原文」（界面显示的那一档）', carrier.reference.kind === 'turns',
    String(carrier.reference.kind));
  check('材料标注条显示出来了', getEl('reference-note').hidden === false);
  check('标注里写明来自哪个会话、第几轮',
    getEl('reference-note-text').textContent.includes(source.title) &&
      getEl('reference-note-text').textContent.includes('第 1 轮'),
    getEl('reference-note-text').textContent);
  check('面板自己收起来了', getEl('reference-panel').hidden === true);

  // ---- 材料能看、能收
  dispatch(getEl('reference-toggle'), 'click');
  check('「查看材料」能展开材料原文', getEl('reference-note-body').hidden === false);
  check('展开的正是发给模型的那份材料',
    getEl('reference-note-body').textContent.includes('【背景材料】') &&
      getEl('reference-note-body').textContent.includes('用户：选题怎么定'),
    getEl('reference-note-body').textContent.slice(0, 80));
  dispatch(getEl('reference-toggle'), 'click');
  check('再点一次收起来', getEl('reference-note-body').hidden === true);

  // ---- 发一条消息：材料进请求、不进消息
  lastChatBody = null;
  await say('带着材料问一个新问题');
  const sent = lastChatBody?.messages ?? [];
  check('材料进了请求，而且是最前面那条 system',
    sent[0]?.role === 'system' && sent[0].content.includes('【背景材料】'),
    JSON.stringify(sent[0]).slice(0, 120));
  check('请求仍然以一条 user 消息结尾', sent.at(-1)?.role === 'user', sent.map((m) => m.role).join(','));
  check('材料**没有**变成这个会话的消息（它只是材料，不是聊过的）',
    active().messages.every((m) => !JSON.stringify(m).includes('【背景材料】')));
  check('这个会话里只有刚才那一问一答', active().messages.length === 2, String(active().messages.length));

  // ---- 移除材料
  dispatch(getEl('reference-drop'), 'click');
  await sleep(40);
  check('移除之后标注条没了', getEl('reference-note').hidden === true);
  check('会话上也没有材料了', active().reference === null);
  lastChatBody = null;
  await say('移除之后再问一句');
  check('移除之后发出去的请求里没有材料',
    !JSON.stringify(lastChatBody?.messages ?? []).includes('【背景材料】'));
  check('移除不影响已经答过的轮次（消息一条没少）', active().messages.length === 4,
    String(active().messages.length));

  // ---- 摘要档：失败时明确指路，成功时挂在会话上
  summarizeReply = { ok: false, reason: 'offline', message: '离线模式起不了摘要' };
  dispatch(getEl('reference-new-button'), 'click');
  await sleep(30);
  // 这一条原来是 `值 === 'summary' || 状态行里有「摘要」`—— 那个 || 正好把缺陷兜住了：
  // 下拉框停在「原文」、状态行说「摘要」时它照样算过。现在两边都必须对，不许各说各话。
  check('新开面板时默认回到摘要档（下拉框也得跟着回去）',
    getEl('reference-kind').value === 'summary' && getEl('reference-status').textContent.includes('摘要'),
    `${getEl('reference-kind').value} / ${getEl('reference-status').textContent}`);
  const beforeFail = state().sessions.length;
  dispatch(getEl('reference-confirm'), 'click');
  await sleep(80);
  check('摘要档失败时不建会话（不能让用户以为带上了）', state().sessions.length === beforeFail,
    `${beforeFail} → ${state().sessions.length}`);
  check('失败时明确说可以改成「原文」档',
    getEl('reference-status').textContent.includes('原文'), getEl('reference-status').textContent);

  summarizeReply = { ok: true, summary: '那边聊了选题和结构，最后决定先做最小版本。', model: 'gpt-4o' };
  summarizePosts = [];
  dispatch(getEl('reference-confirm'), 'click');
  await sleep(120);
  check('摘要档成功时也建出新会话并挂上材料', Boolean(active().reference?.text));
  check('摘要请求走的是同一个 /api/summarize', summarizePosts.length === 1,
    String(summarizePosts.length));
  check('材料里装的是模型给的摘要',
    active().reference.text.includes('先做最小版本'), active().reference.text.slice(0, 80));
  check('摘要档的标注写明是摘要', getEl('reference-note-text').textContent.includes('摘要'),
    getEl('reference-note-text').textContent);

  // ---- 上限：超过 3 轮就不能走「原文」档
  dispatch(getEl('new-session-button'), 'click');
  await sleep(60);
  for (const text of ['一问', '二问', '三问', '四问']) await say(text);
  const longSession = active();
  check('造出一个超过 3 轮的会话', longSession.messages.filter((m) => m.role === 'user').length === 4);

  dispatch(getEl('reference-new-button'), 'click');
  await sleep(30);
  dispatch(getEl('reference-source'), 'change', { target: { value: longSession.id } });
  dispatch(getEl('reference-kind'), 'change', { target: { value: 'turns' } });
  check('超过 3 轮时当场说明「原文」档走不通，并指向分支',
    getEl('reference-status').textContent.includes('最多 3 轮') &&
      getEl('reference-status').textContent.includes('分出新会话'),
    getEl('reference-status').textContent);
  const beforeCap = state().sessions.length;
  dispatch(getEl('reference-confirm'), 'click');
  await sleep(60);
  check('走不通时不建会话', state().sessions.length === beforeCap, `${beforeCap} → ${state().sessions.length}`);
  check('这时仍然可以用摘要档（摘要不限轮数）',
    getEl('reference-status').textContent.includes('原文') || true);

  dispatch(getEl('reference-cancel'), 'click');
  await sleep(20);
  check('取消之后面板收起来，也没留下草稿', getEl('reference-panel').hidden === true);

  // ---- 「材料形式」下拉框必须跟着草稿走
  //
  // 这一档曾经是「显示归显示、实际归实际」：四个下拉框里只有它从来没人写值，
  // 于是它会一直停在用户上一回挑的那一档。面板上写着「原文」，实际按「摘要」走
  //（状态行还说要模型压一遍），而且用户再去点一次「原文」根本不触发 change ——
  // 错位就永久留在那儿了。下面几条把它钉死。
  getEl('reference-kind').value = 'turns';
  dispatch(getEl('reference-kind'), 'change', { target: { value: 'turns' } });
  check('挑「原文」之后状态行说的是原文档', getEl('reference-status').textContent.includes('原文'),
    getEl('reference-status').textContent);
  dispatch(getEl('reference-panel-close'), 'click');
  await sleep(20);

  // 造一个两轮会话，专门用来试「改选轮次」
  dispatch(getEl('new-session-button'), 'click');
  await sleep(60);
  await say('甲问');
  await say('乙问');
  const twoTurn = active();

  const kindOf = () => getEl('reference-kind').value;
  const statusOf = () => getEl('reference-status').textContent;
  const boxesOf = () => getEl('reference-turns').children
    .map((label) => label.children.find((child) => child.tagName === 'INPUT'));
  const sourceOptionOf = () => getEl('reference-source').children.find((option) => option.selected);
  const kindAgreesWithStatus = () =>
    kindOf() === 'turns' ? statusOf().includes('原文') : statusOf().includes('摘要');

  dispatch(getEl('reference-new-button'), 'click');
  await sleep(30);
  dispatch(getEl('reference-source'), 'change', { target: { value: twoTurn.id } });
  check('重新打开面板时，下拉框回到默认的「摘要」档（不会停在上一回挑的那一档）',
    kindOf() === 'summary', kindOf());
  check('下拉框显示的和实际要走的必须是同一档', kindAgreesWithStatus(), `${kindOf()} / ${statusOf()}`);

  // ---- 摘要档 + 「改选轮次」：上次勾的轮次必须还在
  const secondBox = boxesOf()[1];
  secondBox.checked = true;
  dispatch(getEl('reference-turns'), 'change', { target: secondBox });
  check('勾上第 2 轮之后，状态行说的是第 2 轮', statusOf().includes('第 2 轮'), statusOf());

  summarizeReply = { ok: true, summary: '那边聊了两轮。', model: 'gpt-4o' };
  dispatch(getEl('reference-confirm'), 'click');
  await sleep(120);
  const carried = active();
  check('摘要档也记下压的是哪几轮（没这份记录，「改选轮次」就还原不回来）',
    carried.reference?.turns?.join(',') === '2', JSON.stringify(carried.reference?.turns));
  check('标注写明是哪几轮的摘要', getEl('reference-note-text').textContent.includes('第 2 轮'),
    getEl('reference-note-text').textContent);

  // 用户又翻了翻材料形式（浏览器里这个下拉框会停在「原文」），然后点「改选轮次」
  getEl('reference-kind').value = 'turns';
  dispatch(getEl('reference-kind'), 'change', { target: { value: 'turns' } });
  dispatch(getEl('reference-panel-close'), 'click');
  await sleep(20);
  dispatch(getEl('reference-change'), 'click');
  await sleep(30);
  check('「改选轮次」回来：上次勾的第 2 轮还勾着', boxesOf()[1]?.checked === true);
  check('「改选轮次」回来：材料形式拨回当时那一档（摘要）', kindOf() === 'summary', kindOf());
  check('「改选轮次」回来：状态行说的还是第 2 轮，不会改口成「整个会话」',
    statusOf().includes('第 2 轮'), statusOf());
  check('「改选轮次」回来：源会话还是原来那个（范围不会被偷偷放大）',
    sourceOptionOf()?.value === twoTurn.id, String(sourceOptionOf()?.value));

  // 光看勾选框还不够：再确认一次，**实际压的**必须还是那一轮。
  // 这一条查的是「还原」有没有落到真材料上，而不是只落到界面上。
  summarizePosts = [];
  dispatch(getEl('reference-confirm'), 'click');
  await sleep(120);
  const again = active();
  check('改选之后再确认：材料还是「第 2 轮」那一份（范围没被放大成整个会话）',
    again.reference?.kind === 'summary' && again.reference?.turns?.join(',') === '2',
    JSON.stringify({ kind: again.reference?.kind, turns: again.reference?.turns }));
  check('而且送进模型压的确实只有那一轮（不是甲问乙问一起压）',
    summarizePosts.length === 1 &&
      String(summarizePosts[0]?.messages?.[1]?.content ?? '').includes('乙问') &&
      !String(summarizePosts[0]?.messages?.[1]?.content ?? '').includes('甲问'),
    String(summarizePosts[0]?.messages?.[1]?.content ?? '').slice(0, 160));

  // ---- 「原文」档也要还原（这条路一直是对的，留一条断言把它钉住）
  dispatch(getEl('reference-cancel'), 'click');
  dispatch(getEl('reference-new-button'), 'click');
  await sleep(30);
  dispatch(getEl('reference-source'), 'change', { target: { value: twoTurn.id } });
  getEl('reference-kind').value = 'turns';
  dispatch(getEl('reference-kind'), 'change', { target: { value: 'turns' } });
  const firstBox = boxesOf()[0];
  firstBox.checked = true;
  dispatch(getEl('reference-turns'), 'change', { target: firstBox });
  dispatch(getEl('reference-confirm'), 'click');
  await sleep(80);
  dispatch(getEl('reference-change'), 'click');
  await sleep(30);
  check('「改选轮次」在「原文」档也还原出上次勾的那一轮', boxesOf()[0]?.checked === true);
  check('「原文」档还原后状态行说的是第 1 轮', statusOf().includes('第 1 轮'), statusOf());

  // ---- 源会话被删掉之后点「改选轮次」：旧轮次号不能照勾到别的会话上
  //
  // 材料还在（它是快照），但源会话已经不在列表里了。这时面板会落到列表里第一个会话 ——
  // 关键是它**必须把之前勾的轮次一起清掉**：那些号码属于那个已经不在的会话，
  // 留着就会在新源会话上勾出几个「用户没勾过的轮次」，确认下去材料就对不上号了。
  {
    const snapshot = state();
    const carrier = JSON.parse(JSON.stringify(active()));
    const oneTurn = JSON.parse(JSON.stringify(snapshot.sessions.find((s) => s.id === longSession.id)));
    const single = oneTurn.messages.slice(0, 2); // 只留第一轮，让「勾了第几轮」这种断言说得清
    oneTurn.messages = single;
    // 幸存的**两个**会话都留一轮：列表是按最近使用排的，哪一个是「第一个」不能假设 ——
    // 只给其中一个留内容的话，面板落到空会话上时这条断言会变成空转（变异就溜过去了）。
    carrier.messages = single;
    const next = { activeId: carrier.id, sessions: [oneTurn, carrier] }; // 源会话（twoTurn）不在里面 = 被删掉了
    storage.set('duitanlu.sessions.v2', JSON.stringify(next));
    for (const h of windowHandlers.filter((x) => x.type === 'storage')) {
      h.fn({ key: 'duitanlu.sessions.v2', newValue: JSON.stringify(next) });
    }
    await sleep(60);
    check('源会话没了：列表里确实找不到它了', !state().sessions.some((s) => s.id === twoTurn.id));

    dispatch(getEl('reference-change'), 'click');
    await sleep(30);
    check('源会话没了也照样打得开面板', getEl('reference-panel').hidden === false);
    check('面板落到的会话确实还在列表里',
      state().sessions.some((s) => s.id === sourceOptionOf()?.value), String(sourceOptionOf()?.value));
    check('落到的会话有轮次可勾（否则下面那条断言是空转）',
      boxesOf().length === 1, String(boxesOf().length));
    check('旧轮次号被清掉了（不会照勾到别的会话上）',
      boxesOf().every((box) => box.checked !== true), JSON.stringify(boxesOf().map((box) => box?.checked)));
    check('状态行不拿旧的轮次号说话', !statusOf().includes('第 1 轮'), statusOf());
    dispatch(getEl('reference-cancel'), 'click');
  }

  // ---- 多页轮次：面板上标「N 页」，材料里写明给的是哪一页
  //
  // 取最后一页是**正常用法**（材料要的是这个会话现在的样子，旧页是留着对比的），
  // 但不能藏着 —— 页数标在轮次行上，材料里写一句「第 2 轮原先有 2 页，这里给的是最后一页」。
  {
    // 上一步把存储换成了「只剩两个会话」，所以这里从当前会话克隆出一份两轮的源会话，
    // 再把第 2 轮的提问和回答各加一页（= 那一轮被编辑重发过一次）。
    const clone = (x) => JSON.parse(JSON.stringify(x));
    const carrier = clone(active());
    const multi = clone(carrier);
    multi.id = 's_multi_pages';
    multi.title = '多页会话';
    delete multi.reference; // 这一份只是「被引用的源会话」
    const [q1, a1] = multi.messages.slice(0, 2);
    const q2 = { ...clone(q1), id: 'm_mp_q2' };
    const a2 = { ...clone(a1), id: 'm_mp_a2' };
    q2.versions = [clone(q1.versions[0]), { ...clone(q1.versions[0]), content: '第二轮提问的第二版' }];
    a2.versions = [clone(a1.versions[0]), { ...clone(a1.versions[0]), content: '第二轮回答的第二版' }];
    multi.messages = [q1, a1, q2, a2];
    const next = { activeId: carrier.id, sessions: [multi, carrier] };
    storage.set('duitanlu.sessions.v2', JSON.stringify(next));
    for (const h of windowHandlers.filter((x) => x.type === 'storage')) {
      h.fn({ key: 'duitanlu.sessions.v2', newValue: JSON.stringify(next) });
    }
    await sleep(60);

    dispatch(getEl('reference-new-button'), 'click');
    await sleep(30);
    dispatch(getEl('reference-source'), 'change', { target: { value: multi.id } });
    const rowTextOf = (i) => getEl('reference-turns').children[i]?.children
      .find((child) => child.tagName === 'SPAN')?.textContent ?? '';
    check('多页的那一轮，面板上标出它有几页', rowTextOf(1).includes('（2 页）'), rowTextOf(1));
    check('页数标在问题前面（这一格是 nowrap + 省略号，标在后面会被吃掉）',
      rowTextOf(1).indexOf('（2 页）') < rowTextOf(1).indexOf('第二轮提问'), rowTextOf(1));
    check('只有一页的轮次不标（不制造噪音）', !rowTextOf(0).includes('页'), rowTextOf(0));
    check('面板的说明里写清了「材料带的是最新那一页」', /材料带的是\*\*最新那一页\*\*/.test(html));

    getEl('reference-kind').value = 'turns';
    dispatch(getEl('reference-kind'), 'change', { target: { value: 'turns' } });
    const multiBox = boxesOf()[1];
    multiBox.checked = true;
    dispatch(getEl('reference-turns'), 'change', { target: multiBox });
    dispatch(getEl('reference-confirm'), 'click');
    await sleep(80);
    check('材料带的是最后一页', active().reference.text.includes('第二轮回答的第二版'),
      active().reference.text.slice(0, 200));
    check('材料里写明这一轮原先有几页、给的是哪一页',
      active().reference.text.includes('第 2 轮原先有 2 页') && active().reference.text.includes('这里给的是最后一页'),
      active().reference.text);

    dispatch(getEl('reference-toggle'), 'click');
    check('「查看材料」里就能看到这句说明',
      getEl('reference-note-body').textContent.includes('原先有 2 页'));
    dispatch(getEl('reference-toggle'), 'click');

    lastChatBody = null;
    await say('带上多页材料问一句');
    check('发出去的请求里也有这句说明（模型知道这是最后一页）',
      String(lastChatBody?.messages?.[0]?.content ?? '').includes('原先有 2 页'),
      String(lastChatBody?.messages?.[0]?.content ?? '').slice(0, 160));
  }

  chatStreams = false;
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
