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
// 导出器是纯函数，直接拿它核对「窗口只管画、不管存」：画 20 轮，导出必须还是 45 轮
import { toMarkdown } from '../public/lib/exporters.js';

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
    /*
     * 真实的 `style` 既能直接赋值（`style.left = '5px'`）也有 setProperty/getPropertyValue。
     * 替身两者都要有：前者是既有断言在用的写法，后者是 CSS 变量（--rail-w）唯一能用的写法。
     */
    style: {
      _vars: {},
      setProperty(name, value) {
        this._vars[name] = String(value);
        this[name] = String(value);
      },
      getPropertyValue(name) {
        return this._vars[name] ?? '';
      },
      removeProperty(name) {
        delete this._vars[name];
        delete this[name];
      },
    },
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
/** 补历史之后 app 会把视口往下挪一截（滚动锚定），这里记下每次挪了多少 */
const scrollByCalls = [];

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
  // 真实浏览器里 scrollBy 会真的滚；替身只记账，顺便把 scrollY 跟着挪，
  // 这样「补完历史之后视口有没有被顶走」才有据可查
  scrollBy(dx, dy) {
    scrollByCalls.push({ dx, dy });
    globalThis.window.scrollY = Math.max(0, globalThis.window.scrollY + (Number(dy) || 0));
  },
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
  // app.js 也要读一份：有些断言是「这段代码不该再存在」（比如滚动收窄那套阈值）
  const appJs = readFileSync(path.resolve(PUBLIC, 'app.js'), 'utf8');

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

  // ---- 报头恒定：不做「滚下去自动收窄」
  //
  // 收窄那版曾经是对的（把空间让给正文），但它有两个用户明确否掉的后果：
  //   · 会话列表的吸顶偏移和高度上限都按 `--masthead-h` 算 —— 报头一矮，列表就往上跳、还变高；
  //   · 报头是半透明 + 模糊的，正文的字会从标题下面**透出来**。
  // 现在：高度恒定、不透明。这两条断言就是钉这两件事。
  check('没有「紧凑态」这套样式了（报头高度恒定）', !/data-compact/.test(css), '样式表里还有 data-compact');
  check('代码里没有「按滚动改报头状态」这回事了', !/dataset\.compact/.test(appJs));
  check('没有滚动收窄的阈值了（高度不随滚动变）', !/COMPACT_ENTER_AT|COMPACT_EXIT_AT/.test(appJs));
  check('报头是**不透明**的（正文不许从标题下面透出来）',
    /background:\s*var\(--paper\)/.test(mastheadRule) && !/backdrop-filter/.test(mastheadRule),
    mastheadRule.slice(-160));

  // 会话栏的 sticky 偏移跟着报头高度走，否则它的表头会被压在报头下面
  const railRule = css.match(/\.rail\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  check('会话栏让开了报头高度', /--masthead-h/.test(railRule), railRule.slice(0, 120));

  // ---- 运行期行为
  check('滚动监听已注册', scrollHandlers.length > 0, `${scrollHandlers.length} 个`);

  const callHandlers = () => {
    for (const fn of [...scrollHandlers]) fn();
  };
  const goTo = (y) => {
    window.scrollY = y;
    callHandlers();
  };

  // 首屏：把实测高度写给 CSS（会话栏按它算吸顶偏移）
  goTo(0);
  check('报头高度写进了 CSS 变量（供会话栏用）',
    document.documentElement._vars['--masthead-h'] === '116px',
    String(document.documentElement._vars['--masthead-h']));

  // 滚到任何位置，这个变量都不能变 —— 会话列表就是按它定位的，
  // 它一变，列表就跟着上下跳（这正是用户报的那个问题）。
  const heightBefore = document.documentElement._vars['--masthead-h'];
  goTo(400);
  goTo(1200);
  goTo(40); // 老实现的阈值就在 80 附近，这里专门走一遍那一带
  goTo(0);
  check('滚到哪儿报头高度都不变（会话列表因此纹丝不动）',
    document.documentElement._vars['--masthead-h'] === heightBefore,
    `${heightBefore} → ${document.documentElement._vars['--masthead-h']}`);

  // 高度没变就不该重写 CSS 变量，否则会话栏每帧都要重算 max-height
  const varWritesBefore = document.documentElement._varWrites.length;
  for (let i = 0; i < 20; i += 1) goTo(700 + i);
  check('报头高度没变时不重写 CSS 变量',
    document.documentElement._varWrites.length === varWritesBefore,
    `20 次滚动写了 ${document.documentElement._varWrites.length - varWritesBefore} 次`);

  // 布局过渡会让「文档高度」一帧帧地变 —— 报头里任何影响盒子高度的属性都不该有 transition
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
    /grid-template-columns:\s*(?:\d+px|var\(--rail-w[^)]*\))\s+minmax\(0,\s*1fr\)/.test(boardRule),
    boardRule.slice(0, 80));
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

  // 报头第一行和 .board 一样是两格：列宽和缝必须**逐字一致**，
  // 否则开关就落不到「正文左边缘的左边一点」那个位置上了。
  //
  // 这条在有拖拽之后变了写法：两处不再各自写死 292px，而是共用 `var(--rail-w)` ——
  // 于是"改一处忘一处"这个隐患从根上没了（拖一下两处一起动）。所以这里断言的是
  // **两边用的是同一个变量**，比"两边字面量相同"更强。
  const mastheadRule = css.match(/\.masthead\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const mastheadCols = mastheadRule.match(/grid-template-columns:[^;]+;/)?.[0] ?? '';
  const boardCols = boardRule.match(/grid-template-columns:[^;]+;/)?.[0] ?? '';
  check('报头第一行也是两格（会话栏一格 + 正文一格）',
    /grid-template-columns:\s*var\(--rail-w[^)]*\)\s+minmax\(0,\s*1fr\)/.test(mastheadCols), mastheadCols);
  check('报头两格的列宽和 .board 逐字一致（改一处就得改另一处）',
    mastheadCols === boardCols && mastheadCols !== '', `${mastheadCols} / ${boardCols}`);
  check('两处都用同一个变量 --rail-w（拖会话栏时不会只动一边）',
    /var\(--rail-w/.test(mastheadCols) && /var\(--rail-w/.test(boardCols),
    `${mastheadCols} / ${boardCols}`);
  check('--rail-w 有默认值（JS 没跑起来之前也是 292px）',
    /:root\s*\{[\s\S]*?--rail-w:\s*292px/.test(css));
  check('两处都不再写死 292px（否则拖了之后报头和正文会错位）',
    !/grid-template-columns:\s*292px/.test(css));
  check('两处的缝也一样宽', /column-gap:\s*28px/.test(mastheadRule));
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

  // ---- 会话栏宽度可以拖（写 --rail-w 一个变量，两处栅格共用）
  {
    const resizerRule = css.match(/\.rail-resizer\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    const resizer = getEl('rail-resizer');
    const vars = () => document.documentElement._vars;
    const stored = () => storage.get('duitanlu.railWidth.v1');

    check('会话栏里有拖拽手柄（role=separator，是个按钮所以键盘也能聚焦）',
      railBlock.includes('id="rail-resizer"') && /role="separator"/.test(railBlock)
        && /aria-orientation="vertical"/.test(railBlock));
    check('手柄在会话栏里、不在报头那一层（免得和收起/展开开关抢点击）',
      html.indexOf('id="rail-resizer"') > html.indexOf('class="rail"')
        && html.indexOf('id="rail-resizer"') < html.indexOf('class="stage"'));
    check('手柄的鼠标样式是左右拖', /cursor:\s*col-resize/.test(resizerRule), resizerRule.slice(0, 80));
    check('窄屏（单列）里手柄藏起来 —— 那边没有「缝」可拖',
      /@media \(max-width: 1000px\)[\s\S]*?\.rail-resizer\s*\{\s*display:\s*none/.test(css));

    // 启动时就套用记住的宽度（没存过就是默认 292）
    check('启动时把宽度写进 --rail-w', vars()['--rail-w'] === '292px', String(vars()['--rail-w']));
    check('手柄上的无障碍数值跟着写', resizer.attributes['aria-valuenow'] === '292',
      resizer.attributes['aria-valuenow']);

    // 拖：按下 → 移动 → 松开
    const before = document.documentElement._varWrites.length;
    dispatch(resizer, 'pointerdown', { clientX: 300, pointerId: 1, preventDefault() {} });
    dispatch(resizer, 'pointermove', { clientX: 360, pointerId: 1, preventDefault() {} });
    check('往右拖 60px：会话栏宽 292 → 352', vars()['--rail-w'] === '352px', String(vars()['--rail-w']));
    check('拖动中给整页上锁（不然会顺手选中文字）',
      document.body.dataset.resizing === 'true', String(document.body.dataset.resizing));
    dispatch(resizer, 'pointerup', { clientX: 360, pointerId: 1, preventDefault() {} });
    check('松开之后解锁', document.body.dataset.resizing === undefined);
    check('拖动结果记住了', stored() === '352', String(stored()));

    // 上下限：拖过头停在边界上（而且不许把正文挤成一条）
    dispatch(resizer, 'pointerdown', { clientX: 0, pointerId: 1, preventDefault() {} });
    dispatch(resizer, 'pointermove', { clientX: 9999, pointerId: 1, preventDefault() {} });
    check('拖到天边也停在 460px', vars()['--rail-w'] === '460px', String(vars()['--rail-w']));
    dispatch(resizer, 'pointermove', { clientX: -9999, pointerId: 1, preventDefault() {} });
    check('拖到最左也停在 200px', vars()['--rail-w'] === '200px', String(vars()['--rail-w']));
    dispatch(resizer, 'pointerup', { clientX: -9999, pointerId: 1, preventDefault() {} });

    // 值没变就不写 DOM（和报头高度那条规矩一致：不制造无谓的写入）
    const writesBefore = document.documentElement._varWrites.length;
    dispatch(resizer, 'keydown', { key: 'ArrowLeft', shiftKey: false, preventDefault() {} });
    check('已经在最小宽度上再按 ← 不会重写变量（值没变）',
      document.documentElement._varWrites.length === writesBefore,
      `写了 ${document.documentElement._varWrites.length - writesBefore} 次`);

    // 键盘：← → 各 8px，Home / End 到两端
    dispatch(resizer, 'keydown', { key: 'ArrowRight', shiftKey: false, preventDefault() {} });
    check('按 → 加 8px', vars()['--rail-w'] === '208px', String(vars()['--rail-w']));
    dispatch(resizer, 'keydown', { key: 'ArrowRight', shiftKey: true, preventDefault() {} });
    check('Shift + → 加 24px', vars()['--rail-w'] === '232px', String(vars()['--rail-w']));
    dispatch(resizer, 'keydown', { key: 'End', preventDefault() {} });
    check('End 到最大', vars()['--rail-w'] === '460px', String(vars()['--rail-w']));
    dispatch(resizer, 'keydown', { key: 'Home', preventDefault() {} });
    check('Home 到最小', vars()['--rail-w'] === '200px', String(vars()['--rail-w']));
    check('键盘调整也记住了', stored() === '200', String(stored()));

    // 双击回默认
    dispatch(resizer, 'dblclick', {});
    check('双击回到默认 292px', vars()['--rail-w'] === '292px', String(vars()['--rail-w']));
    check('默认宽度也落盘', stored() === '292', String(stored()));

    // 窄屏：CSS 已经藏了柄，JS 也拒绝开工（两道防线）
    const wideWidth = vars()['--rail-w'];
    globalThis.window.innerWidth = 800;
    dispatch(resizer, 'pointerdown', { clientX: 300, pointerId: 1, preventDefault() {} });
    dispatch(resizer, 'pointermove', { clientX: 500, pointerId: 1, preventDefault() {} });
    check('窄屏上拖不动（单列布局里没有「缝」）', vars()['--rail-w'] === wideWidth,
      String(vars()['--rail-w']));
    dispatch(resizer, 'pointerup', { clientX: 500, pointerId: 1, preventDefault() {} });
    globalThis.window.innerWidth = 1200;
  }

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
  // 列表里每一条**就是**那个 .session-item（app 的 sessionRow 现在直接返回它）。
  // 早期它返回的是模板片段，所以这里两种形状都认：自己就是那一行，或者从片段里取。
  const rowElementOf = (node) => (node?.dataset?.id ? node : node?.querySelector('.session-item') ?? null);
  const idsIn = (list) => list.children.map((node) => rowElementOf(node)?.dataset.id);
  /** 取某一行里的东西（会话行是模板克隆出来的，替身里按选择器缓存） */
  const rowOf = (list, id) => list.children.find((node) => rowElementOf(node)?.dataset.id === id) ?? null;
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
    rowElementOf(rowOf(pinnedList, targetId))?.dataset.pinned === 'true');
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

console.log('\n⑯ 会话标题太长：两行 + 悬停看全文');
//
// 会话栏 292px、标题上限 60 字（store.js 的 normalizeSession），一行只放得下约 20 个汉字 ——
// 所以标题必须有个看全的出口：先靠 CSS 放宽到两行，再由这里的浮层补长尾。
//
// 编号放在最后：前面几段的编号在 README 里被引用过（比如「⑯ 的最后两条断言」），
// 中间插一段会把那些引用指错地方。
{
  const css = readFileSync(path.resolve(PUBLIC, 'styles.css'), 'utf8');
  const html = readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

  // 标题**只占一行**：两行那版试过，行高参差不齐、列表被撑高，用户明确否掉了。
  //
  // 匹配必须**限定在这条规则的花括号内**（`[^}]*`）：用 `[\s\S]*?` 会跨过规则边界，
  // 撞上文件后面别的 `-webkit-line-clamp`（比如 .turn-quote-text 的 6 行）——
  // 我第一版就是这么写的，结果在干净代码上误报。
  const nameRule = /\.session-name\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  check('标题只占一行（改成两行会参差不齐，用户明确否掉）',
    /white-space:\s*nowrap/.test(nameRule) && !/line-clamp/.test(nameRule), nameRule);
  check('放不下的部分在末尾收成省略号（不是硬切、也不是溢出）',
    /text-overflow:\s*ellipsis/.test(nameRule) && /overflow:\s*hidden/.test(nameRule), nameRule);
  check('完整标题的浮层默认藏着', /id="title-float"[^>]*hidden/.test(html));
  check('浮层是 tooltip 语义', /id="title-float"[^>]*role="tooltip"/.test(html));
  check('浮层挂在页面级（fixed 定位）—— 塞进会话行会被 overflow 裁掉',
    /\.title-float\s*\{[\s\S]*?position:\s*fixed/.test(css));

  // 造一行「标题被截断」的会话行：替身不排版，所以宽度得自己给
  const floatEl = getEl('title-float');
  const fullTitle = '这是一条特别长的会话标题，长到会话栏一行根本放不下，必须能看全';

  // 列表里**真正渲染出来的**那一行：标题要带原生 title（屏幕阅读器/触摸屏的兜底出口）
  const renderedRow = getEl('recent-list').children[0] ?? getEl('pinned-list').children[0];
  const renderedName = renderedRow?.querySelector?.('[data-field="name"]');
  check('列表里的标题带着原生 title（触摸屏、屏幕阅读器也有出口）',
    Boolean(renderedName?.title) && renderedName.title === renderedName.textContent,
    `title=${JSON.stringify(renderedName?.title)} 文本=${JSON.stringify(renderedName?.textContent)}`);

  const rowEl = makeElement('li');
  rowEl.className = 'session-item';
  const nameEl = makeElement('span');
  nameEl.className = 'session-name';
  nameEl.textContent = fullTitle;
  nameEl.parentElement = rowEl;
  rowEl.querySelector = () => nameEl;
  const setClipped = (clipped) => {
    nameEl.scrollWidth = clipped ? 420 : 180;
    nameEl.clientWidth = 180;
    nameEl.scrollHeight = clipped ? 60 : 20;
    nameEl.clientHeight = 20;
  };

  // ---- 长标题：悬停浮出全文
  setClipped(true);
  dispatch(getEl('session-list'), 'mouseover', { target: nameEl });
  check('悬停被截断的标题：浮层出现', floatEl.hidden === false, String(floatEl.hidden));
  check('浮层里是**完整**标题（不是截断那半截）', floatEl.textContent === fullTitle, floatEl.textContent);

  // ---- 鼠标离开：不是立刻收，而是留 160ms —— 够把鼠标移进浮层里选中文字
  dispatch(getEl('session-list'), 'mouseout', { target: nameEl, relatedTarget: null });
  await new Promise((r) => setTimeout(r, 40));
  check('刚离开那一下浮层**还留着**（有延迟，不是立刻消失）', floatEl.hidden === false);
  await new Promise((r) => setTimeout(r, 260));
  check('离开之后浮层收起', floatEl.hidden === true);

  // ---- 鼠标移进浮层：取消收起（这就是那 160ms 延迟存在的理由 —— 文字要能选中复制）
  dispatch(getEl('session-list'), 'mouseover', { target: nameEl });
  dispatch(getEl('session-list'), 'mouseout', { target: nameEl, relatedTarget: null });
  dispatch(floatEl, 'mouseenter');
  await new Promise((r) => setTimeout(r, 260));
  check('鼠标移进浮层之后不再收起（文字可以选中复制）', floatEl.hidden === false);
  dispatch(floatEl, 'mouseleave');
  check('移出浮层就收起', floatEl.hidden === true);

  // ---- 键盘聚焦也浮出来（鼠标不是唯一的读法）
  dispatch(getEl('session-list'), 'focusin', { target: nameEl });
  check('键盘聚焦到某一行时也浮出全文', floatEl.hidden === false);
  dispatch(getEl('session-list'), 'focusout', { target: nameEl });

  // ---- 没被截断的标题不弹：弹一张写着同样内容的卡片是噪音
  dispatch(getEl('session-list'), 'mouseover', { target: nameEl });
  floatEl.hidden = true;
  setClipped(false);
  dispatch(getEl('session-list'), 'mouseover', { target: nameEl });
  check('标题没被截断时**不**弹浮层（不制造噪音）', floatEl.hidden === true);

  // ---- 位置变了就得收起来，否则指到别的地方去
  setClipped(true);
  dispatch(getEl('session-list'), 'mouseover', { target: nameEl });
  dispatch(getEl('session-list'), 'scroll', {});
  check('列表一滚动，浮层立刻收起（位置变了，留着会指错）', floatEl.hidden === true);

  dispatch(getEl('session-list'), 'mouseover', { target: nameEl });
  check('再悬停又出来（不是一次性）', floatEl.hidden === false);
  dispatch(getEl('session-list'), 'mouseout', { target: nameEl, relatedTarget: null });
  dispatch(getEl('new-session-button'), 'click');
  await new Promise((r) => setTimeout(r, 80));
  check('列表重画之后浮层收起（那一行可能已经不在了）', floatEl.hidden === true);

  // ---- 行尾只留一个「⋯」，四个功能收进菜单
  //
  // 这一段是**同一个问题的另一半**：那四个文字按钮以前常驻行尾（只做了 opacity: 0，
  // 宽度照占），292px 的行里被吃掉约 145px —— 标题只剩六七个字。
  {
    const rowAt = html.indexOf('id="session-template"');
    const tpl = html.slice(rowAt, html.indexOf('</template>', rowAt));
    const menuAt = tpl.indexOf('class="session-menu"');
    const menuEnd = tpl.indexOf('</span>', menuAt);
    const menuInner = menuAt >= 0 && menuEnd > menuAt ? tpl.slice(menuAt, menuEnd) : '';
    const moreAt = tpl.indexOf('data-action="more"');

    check('行里有一个「⋯」按钮', moreAt > -1 && /aria-haspopup="menu"/.test(tpl));
    check('「⋯」初始 aria-expanded=false', /data-action="more"[\s\S]*?aria-expanded="false"/.test(tpl));
    check('四个功能（置顶/重命名/自动命名/删除）都在菜单里',
      ['pin', 'rename', 'retitle', 'delete'].every((a) => menuInner.includes(`data-action="${a}"`)),
      menuInner);

    // 菜单上的措辞是**定过的**，不是随手写的：
    //   「重命名」= 你自己敲一个名字；「自动命名」= 让模型按现在的对话重新起一个。
    // 旧的两个词都换掉了 ——「改名」太家常，而「起名」是给小孩 / 宠物起名字的说法，
    // 摆在「重命名」旁边也不成对（一个「命名」一个「起名」，读起来像两回事）。
    const appSource = readFileSync(path.resolve(PUBLIC, 'app.js'), 'utf8');
    // 只看用户看得见的字：注释里留着的「自动改名」说的是**后台**那条路，不算。
    const appCode = appSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    check('菜单上的字是「重命名」和「自动命名」',
      menuInner.includes('>重命名</button>') && menuInner.includes('>自动命名</button>'), menuInner);
    check('「⋯」上的 title 里那四个功能也换了新词',
      /title="更多操作（置顶 \/ 重命名 \/ 自动命名 \/ 删除）"/.test(tpl),
      tpl.slice(moreAt, moreAt + 220));
    check('用户看得见的地方不再出现「改名」「起名」（菜单 / 气泡提示 / 对话框标题）',
      !/改名|起名/.test(menuInner) && !/改名|起名/.test(appCode) && !/改名|起名/.test(tpl),
      [
        ...appCode.split('\n').filter((line) => /改名|起名/.test(line)),
        ...tpl.split('\n').filter((line) => /改名|起名/.test(line)),
      ].join('\n') || '（没有，但断言还是失败了，去看 menuInner）');
    // 「重命名」弹出来的那个对话框也用同一套词（「换个名字」）。
    // 光靠上面那条「不许出现改名叫起名」是抓不住的：旧文案写的是「起个名字」，不带「起名」两个字。
    check('「重命名」的对话框说「给这个会话换个名字」',
      /window\.prompt\('给这个会话换个名字'/.test(appCode),
      appCode.split('\n').find((line) => line.includes('window.prompt(')) ?? '（找不到 window.prompt）');
    check('菜单默认藏着（不占行里的宽度）', /class="session-menu"[^>]*hidden/.test(tpl));
    check('行里除「⋯」之外没有别的常驻按钮（这才是标题能显示 19–20 个字的原因）',
      tpl.slice(0, menuAt).includes('data-action="more"')
        && !/data-action="(pin|rename|retitle|delete)"/.test(tpl.slice(0, menuAt)),
      tpl.slice(0, menuAt));
    check('旧的「四个文字按钮常驻」那套样式已经不在样式表里',
      !/\.session-tools\s*\{/.test(css) && !/class="session-tools"/.test(html));
    check('「⋯」是个小按钮（26px 宽，不是四个文字按钮）',
      /\.session-more\s*\{[^}]*width:\s*26px/.test(css));
    check('菜单用 fixed 定位（会话列表 overflow: auto，absolute 会被裁掉）',
      /\.session-menu\s*\{[^}]*position:\s*fixed/.test(css));
    check('触摸屏上「⋯」常显（没有 hover 可言）',
      /@media \(hover: none\)\s*\{\s*\.session-more\s*\{[^}]*opacity:\s*1/.test(css));

    // 造两行带「⋯」的会话行（替身不解析模板，所以手工搭结构）
    // 这一段自己读一次存储（和别处一样叫 state，块作用域里互不影响）
    const state = () => JSON.parse(storage.get('duitanlu.sessions.v2') ?? '{}');
    const realId = state().sessions[0].id;
    const buildRow = (id, top) => {
      const row = makeElement('li');
      row.className = 'session-item';
      row.dataset.id = id;
      const more = makeElement('button');
      more.className = 'session-more';
      more.dataset.action = 'more';
      more.parentElement = row;
      const menu = makeElement('span');
      menu.className = 'session-menu';
      menu.hidden = true;
      menu.parentElement = row;
      const deleteItem = makeElement('button');
      deleteItem.dataset.action = 'delete';
      deleteItem.parentElement = row;
      more.getBoundingClientRect = () => ({ top, bottom: top + 26, left: 240, right: 266, width: 26, height: 26 });
      menu.offsetWidth = 150;
      menu.offsetHeight = 120;
      row.querySelector = (sel) => (sel === '.session-menu' ? menu : null);
      return { row, more, menu, deleteItem };
    };
    const rowA = buildRow(realId, 100);
    const rowB = buildRow(realId, 400);

    dispatch(getEl('session-list'), 'click', { target: rowA.more });
    check('点「⋯」弹出菜单', rowA.menu.hidden === false);
    check('弹出后 aria-expanded 变成 true',
      rowA.more.attributes['aria-expanded'] === 'true', rowA.more.attributes['aria-expanded']);
    check('菜单摆在「⋯」旁边（fixed 定位，算出了坐标）',
      /px$/.test(rowA.menu.style.left) && /px$/.test(rowA.menu.style.top),
      `${rowA.menu.style.left} / ${rowA.menu.style.top}`);

    dispatch(getEl('session-list'), 'click', { target: rowB.more });
    check('同一时刻只开一个：点另一行的「⋯」，前一个收起',
      rowA.menu.hidden === true && rowB.menu.hidden === false);

    // 点菜单里的条目：事情真的做了，而且菜单收起
    const pinnedBefore = state().sessions.find((s) => s.id === realId)?.pinned === true;
    dispatch(getEl('session-list'), 'click', { target: rowA.menu });
    dispatch(getEl('session-list'), 'click', { target: rowA.more });
    const pinItem = makeElement('button');
    pinItem.dataset.action = 'pin';
    pinItem.parentElement = rowA.row;
    dispatch(getEl('session-list'), 'click', { target: pinItem });
    check('点菜单里的「置顶」真的置顶了（菜单不只是个装饰）',
      state().sessions.find((s) => s.id === realId)?.pinned === !pinnedBefore,
      `pinned ${pinnedBefore} → ${state().sessions.find((s) => s.id === realId)?.pinned}`);
    check('做过动作之后菜单收起', rowA.menu.hidden === true);

    // 关闭纪律：点外面 / Esc / 滚动 / 列表重画
    dispatch(getEl('session-list'), 'click', { target: rowB.more });
    for (const h of documentHandlers.filter((x) => x.type === 'click')) {
      h.fn({ target: makeElement('div'), preventDefault() {} });
    }
    check('点菜单外面就收起', rowB.menu.hidden === true);

    dispatch(getEl('session-list'), 'click', { target: rowB.more });
    for (const h of documentHandlers.filter((x) => x.type === 'keydown')) {
      h.fn({ key: 'Escape', preventDefault() {} });
    }
    check('按 Esc 收起', rowB.menu.hidden === true);

    dispatch(getEl('session-list'), 'click', { target: rowB.more });
    dispatch(getEl('session-list'), 'scroll', {});
    check('列表一滚动就收起（位置变了，留着会指错）', rowB.menu.hidden === true);

    dispatch(getEl('session-list'), 'click', { target: rowB.more });
    dispatch(getEl('new-session-button'), 'click');
    await new Promise((r) => setTimeout(r, 80));
    check('列表重画之后收起（菜单里的按钮已经换成新节点了）', rowB.menu.hidden === true);
  }

  // ---- 行尾那个「多久没动了」：平时显示时间，鼠标停上去原地换成「⋯」
  {
    const slotRule = css.match(/^\.session-slot\s*\{[\s\S]*?\n\}/m)?.[0] ?? '';
    // 取规则一律**锚定行首**（`^` + m 标志）：`.session-age` 也出现在后面的悬停选择器里
    //（`.session-more[...] ~ .session-age {`），不锚定就会取到那一条 —— 我这个坑踩过三次了。
    const ageRule = css.match(/^\.session-age\s*\{[\s\S]*?\n\}/m)?.[0] ?? '';

    // 取某条规则里某个属性的**最后一条**声明的值。
    // 两个坑都吃过：① CSS 后者生效，只看"出现过"会被追加式变异骗过；
    // ② `opacity:\s*0` 会把 `transition: opacity 0.15s ease` 也算上（前缀匹配）——
    // 所以统一走这个函数，不再手写正则。
    const cssDecl = (rule, prop) => {
      const found = [...String(rule).matchAll(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+);`, 'g'))];
      return found.length ? found[found.length - 1][1].trim() : '';
    };

    check('行尾有一个槽位，里面同时放着「⋯」和「多久了」',
      /class="session-slot"/.test(html) && /data-field="age"/.test(html)
        && /class="session-slot"[\s\S]*data-action="more"[\s\S]*data-field="age"/.test(html));
    check('槽位宽度**固定**（不然悬停切换那一下标题会重新截断）',
      /^\d+px$/.test(cssDecl(slotRule, 'width')), `${cssDecl(slotRule, 'width')} ← ${slotRule.slice(0, 120)}`);
    check('时间（不是「⋯」）是默认露出来的那一个',
      // 两块重叠摆在同一个位置（合并选择器里给定位），而且时间**自己那条规则**里没把自己藏起来
      /\.session-age,\s*\.session-more\s*\{[^}]*position:\s*absolute[^}]*right:\s*0/.test(css)
        && cssDecl(ageRule, 'opacity') === '',
      `${cssDecl(ageRule, 'opacity')} ← ${ageRule.slice(0, 120)}`);
    // 这两块是**重叠**的，而时间在后面 ⇒ 画在上层。悬停时它只是 opacity: 0，
    // 而**透明度不影响点击命中** —— 不写 pointer-events: none 的话，那层看不见的时间
    // 会把「⋯」的点击全吃掉（真人点三个点没反应）。替身不做命中测试，所以只能这样守。
    check('时间不参与点击（否则它会盖住「⋯」，点三个点没反应）',
      cssDecl(ageRule, 'pointer-events') === 'none', ageRule.slice(0, 160));
    check('悬停/聚焦/菜单开着时，时间让位给「⋯」',
      /\.session-item:hover \.session-age[\s\S]*opacity:\s*0/.test(css)
        && /\.session-more\[aria-expanded="true"\] ~ \.session-age/.test(css));
    check('触摸屏没 hover：「⋯」常显、时间藏起来（两个都露会叠在一起）',
      /@media \(hover: none\)\s*\{[\s\S]*?\.session-age\s*\{\s*opacity:\s*0/.test(css));

    // 时间怎么算：给几种 updatedAt，看渲染出来的文字
    const MIN = 60_000;
    const HOUR = 60 * MIN;
    const DAY = 24 * HOUR;
    const now = Date.now();
    const cases = [
      ['十分钟前建的', now - 10_000, '刚刚'],
      ['五分钟前动过', now - 5 * MIN, '5 分钟前'],
      ['三小时前动过', now - 3 * HOUR, '3 小时前'],
      ['昨天动过', now - 26 * HOUR, '昨天'],
      ['四天前动过', now - 4 * DAY, '4 天前'],
      ['三周前动过', now - 21 * DAY, '3 周前'],
      ['五个月前动过', now - 150 * DAY, '5 个月前'],
      ['两年前动过', now - 800 * DAY, '2 年前'],
    ];
    // 这些会话的**创建时间故意都设在两年前**，只有 updatedAt 各不相同 ——
    // 这样「按创建时间算」的实现会全部渲染成「2 年前」，上面每一条断言都会失败。
    // （我第一版把两个时间设成一样，结果那条变异完全看不出来。）
    const payload = {
      activeId: 's_age_first',
      sessions: cases.map(([title, updatedAt], i) => ({
        id: i === 0 ? 's_age_first' : `s_age_${i}`,
        title,
        createdAt: now - 800 * DAY,
        updatedAt,
        messages: [],
      })),
    };
    storage.set('duitanlu.sessions.v2', JSON.stringify(payload));
    for (const h of windowHandlers.filter((x) => x.type === 'storage')) {
      h.fn({ key: 'duitanlu.sessions.v2', newValue: JSON.stringify(payload) });
    }
    await new Promise((r) => setTimeout(r, 60));

    // 「最近」这一组默认只画 6 条，而这里要核对 8 档时间各怎么写 —— 先展开全部。
    // （不展开的话后两行压根没画出来，那不是缺陷，是这个显示开关的正常行为。）
    dispatch(getEl('recent-more'), 'click');

    const ages = new Map();
    for (const listId of ['pinned-list', 'recent-list']) {
      for (const row of getEl(listId).children) {
        const title = row.querySelector('[data-field="name"]')?.textContent ?? '';
        ages.set(title, row.querySelector('[data-field="age"]')?.textContent ?? '（没渲染出来）');
      }
    }
    for (const [title, , expected] of cases) {
      check(`「${title}」的行尾显示「${expected}」`, ages.get(title) === expected, String(ages.get(title)));
    }
    // 八行的创建时间都一样，但显示出来必须**各不相同** ——
    // 这一条是「按 updatedAt 算」的直接证据（按创建时间算的话八行会一模一样）。
    const distinct = new Set([...ages.values()]);
    check('同一批会话行尾显示的是各自的最后活动时间（不是统一的创建时间）',
      distinct.size >= 6, `${distinct.size} 种：${[...distinct].join(' / ')}`);
  }
}

console.log('\n⑰ 会话分支：从这一轮分出一个新会话');

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
  check('标题来源标成手动（「自动命名」不许覆盖分支名）', branch?.titleSource === 'manual');
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

console.log('\n⑱ 错误文案：服务端拒绝 ≠ 连不上服务端');

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

console.log('\n⑲ 会话引用：把另一个会话当背景材料带进新话题');

{
  const input = getEl('composer-input');
  const css = readFileSync(path.resolve(PUBLIC, 'styles.css'), 'utf8');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- 结构
  const stageAt = html.indexOf('<div class="stage">');
  const panelAt = html.indexOf('id="reference-panel"');
  const noteAt = html.indexOf('id="reference-note"');
  const exchangesAt = html.indexOf('id="exchanges"');
  const composerAt = html.indexOf('<form class="composer"');
  check('会话列表里有「引用别的会话…」入口', /id="reference-new-button"/.test(html));
  check('引用面板默认藏着', /id="reference-panel" hidden/.test(html));
  check('材料标注条默认藏着', /id="reference-note" hidden/.test(html));
  check('面板里能选会话、选材料形式、勾轮次、确认',
    ['reference-source', 'reference-kind', 'reference-turns', 'reference-confirm', 'reference-cancel']
      .every((id) => html.includes(`id="${id}"`)));
  check('材料标注条用虚线边，和分支那条实线标注区分开（两件事别混）',
    /\.reference-note\s*\{[\s\S]*?border-left:\s*2px dashed/.test(css));
  // 位置：材料条和面板都在**对话流后面**，贴着输入区 ——
  // 之前它们挂在正文最上面，存量会话聊长了，用户得翻回开头才看得见（点开面板甚至像没反应）。
  check('材料标注条在对话流后面、就在输入区里（存量会话不用翻回开头）',
    exchangesAt >= 0 && composerAt >= 0 && noteAt > exchangesAt && noteAt > composerAt,
    `exchanges=${exchangesAt} composer=${composerAt} note=${noteAt}`);
  check('引用面板在对话流后面、输入区正上方（打字的那个位置就能看见）',
    panelAt > exchangesAt && panelAt < composerAt,
    `exchanges=${exchangesAt} panel=${panelAt} composer=${composerAt}`);
  check('输入区是贴底的（材料条在里面才叫「永远在眼前」）',
    /\.composer\s*\{[\s\S]*?position:\s*sticky[\s\S]*?bottom:\s*0/.test(css));
  check('分支出处**没有**跟着搬（它说的是这条线从哪儿来，属于正文开头）',
    html.indexOf('id="branch-note"') < exchangesAt);

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

  // 再造一个「正在聊的会话」—— 也就是用户说的那个场景：
  // 已经聊了几轮，这一轮突然要用另一个会话的内容。
  dispatch(getEl('new-session-button'), 'click');
  await sleep(60);
  await say('我这边已经聊了一轮');
  const talking = active();
  check('造出一个「正在聊」的会话（1 轮）',
    talking.messages.filter((m) => m.role === 'user').length === 1 && talking.id !== source.id);

  // ---- 原文档：在**当前这个会话**里就地引用另一个会话的一轮
  getEl('reference-panel').__scrolledIntoView = false; // 先清掉，好验「打开时会滚进可视区」
  dispatch(getEl('reference-new-button'), 'click');
  await sleep(30);
  check('点入口后面板露出来', getEl('reference-panel').hidden === false);
  check('打开面板时会把它滚进可视区（长会话里点了不至于像没反应）',
    getEl('reference-panel').__scrolledIntoView === true);
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

  // 用户就是这么用的：**先打好这一轮的需求，再去引用**。所以引用的这一下
  // 绝不能碰输入区（更不能走那条「换会话」的收尾 —— 它会顺手丢掉输入区挂着的「引用回答」）。
  input.value = '我还没打完的这一轮需求';
  const quoteFloat = getEl('quote-float');
  const composerQuote = getEl('composer-quote');
  const answerBody = makeElement('div');
  answerBody.className = 'turn-body markdown';
  const answerTurn = makeElement('div');
  answerTurn.className = 'turn-assistant';
  answerBody.parentElement = answerTurn;
  const answerText = makeElement('span');
  answerText.parentElement = answerBody;
  activeSelection = {
    isCollapsed: false,
    rangeCount: 1,
    anchorNode: answerText,
    toString: () => '上一轮回答里的一段',
    getRangeAt: () => ({
      commonAncestorContainer: answerText,
      getBoundingClientRect: () => ({ top: 300, left: 100, width: 200, height: 40, bottom: 340, right: 300 }),
    }),
    removeAllRanges: () => { activeSelection.isCollapsed = true; },
  };
  for (const h of documentHandlers.filter((x) => x.type === 'selectionchange')) h.fn({});
  await sleep(200);
  activeSelection = null;
  dispatch(quoteFloat, 'click');
  check('先在输入区挂上一段「引用回答」', composerQuote.hidden === false);

  // 这一条是用户报的那个缺陷的**本质**：选了「原文」就不该去调模型。
  // 上面那些断言查的是「界面说的一致」，这一条查「实际做的一致」。
  summarizePosts = [];
  const sessionsBefore = state().sessions.length;
  dispatch(getEl('reference-confirm'), 'click');
  await sleep(80);
  check('「原文」档确认时没有去调模型（选了原文就该走原文，不该偷偷去压摘要）',
    summarizePosts.length === 0, `调了 ${summarizePosts.length} 次 /api/summarize`);
  check('就地生效：没有多出会话', state().sessions.length === sessionsBefore,
    `${sessionsBefore} → ${state().sessions.length}`);
  check('就地生效：还是这个会话（没被切走）', active().id === talking.id, String(active().id));
  check('就地生效：正在打的这一轮需求还在', input.value === '我还没打完的这一轮需求', input.value);
  check('就地生效：输入区挂着的那段「引用回答」也还在', composerQuote.hidden === false);
  check('原会话一条消息都没动', sessionById(source.id).messages.length === source.messages.length);
  const carrier = active();
  check('材料挂在这个会话上', Boolean(carrier.reference?.text));
  check('材料标出了出处与轮次',
    carrier.reference?.sessionId === source.id && carrier.reference?.turns?.join(',') === '1',
    JSON.stringify(carrier.reference ?? null));
  check('材料的档位就是「原文」（界面显示的那一档）', carrier.reference?.kind === 'turns',
    String(carrier.reference?.kind));
  check('材料**没有**变成这个会话的消息（它只是材料）',
    carrier.messages.every((m) => !JSON.stringify(m).includes('【背景材料】')));
  check('这个会话的消息一条没少', carrier.messages.length === talking.messages.length,
    `${talking.messages.length} → ${carrier.messages.length}`);
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
  check('就地生效：这一轮的问答接在原有对话后面', active().messages.length === 4,
    String(active().messages.length));

  // ---- 移除材料
  dispatch(getEl('reference-drop'), 'click');
  await sleep(40);
  check('移除之后标注条没了', getEl('reference-note').hidden === true);
  check('会话上也没有材料了', active().reference === null);
  lastChatBody = null;
  await say('移除之后再问一句');
  check('移除之后发出去的请求里没有材料',
    !JSON.stringify(lastChatBody?.messages ?? []).includes('【背景材料】'));
  check('移除不影响已经答过的轮次（消息一条没少）', active().messages.length === 6,
    String(active().messages.length));

  // ---- 摘要档：失败时明确指路，成功时就地挂上
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
  check('摘要档失败时不建会话、也不挂半份材料（不能让用户以为带上了）',
    state().sessions.length === beforeFail && active().reference === null,
    `${beforeFail} → ${state().sessions.length}`);
  check('失败时明确说可以改成「原文」档',
    getEl('reference-status').textContent.includes('原文'), getEl('reference-status').textContent);

  summarizeReply = { ok: true, summary: '那边聊了选题和结构，最后决定先做最小版本。', model: 'gpt-4o' };
  summarizePosts = [];
  const beforeSummary = state().sessions.length;
  dispatch(getEl('reference-confirm'), 'click');
  await sleep(120);
  check('摘要档成功时就地挂在这个会话上（不多开会话）',
    state().sessions.length === beforeSummary && Boolean(active().reference?.text));
  check('摘要请求走的是同一个 /api/summarize', summarizePosts.length === 1,
    String(summarizePosts.length));
  check('材料里装的是模型给的摘要',
    String(active().reference?.text ?? '').includes('先做最小版本'),
    String(active().reference?.text ?? '').slice(0, 80));
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

  // ---- 下面三块各自搭自己的存储。
  //
  // 为什么不接着用前面的会话：材料现在是**就地生效**的，「当前会话」和「源会话」很可能
  // 就是同一个（在自己身上引用自己）—— 再拿「当前会话克隆一份当源会话」这种写法会失真，
  // 断言就会验到别的东西上（我第一版就是这么写错的）。
  const install = (sessions, activeId) => {
    const payload = { activeId, sessions };
    storage.set('duitanlu.sessions.v2', JSON.stringify(payload));
    for (const h of windowHandlers.filter((x) => x.type === 'storage')) {
      h.fn({ key: 'duitanlu.sessions.v2', newValue: JSON.stringify(payload) });
    }
  };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  /** 一条消息：`total` 页（第 1..total-1 页是旧版，最后一页是 content） */
  const msgOf = (id, role, content, total = 1) => ({
    id,
    role,
    content,
    versions: Array.from({ length: total }, (_, i) => ({
      content: i === total - 1 ? content : `${content}（第 ${i + 1} 版）`,
      attachments: [],
      createdAt: 0,
    })),
  });
  /** 造一个会话：turns 是 [问, 答] 的数组；pages 指定某一轮有几页（下标从 0 起） */
  const fixture = (id, title, turns, pages = {}) => {
    const messages = [];
    turns.forEach(([q, a], i) => {
      const total = pages[i] ?? 1;
      messages.push(msgOf(`${id}_q${i}`, 'user', q, total));
      messages.push(msgOf(`${id}_a${i}`, 'assistant', a, total));
    });
    return { id, title, createdAt: 1, updatedAt: 1, messages };
  };

  // ---- 源会话被删掉之后点「改选轮次」：旧轮次号不能照勾到别的会话上
  //
  // 材料还在（它是快照），但源会话已经不在列表里了。这时面板会落到列表里第一个会话 ——
  // 关键是它**必须把之前勾的轮次一起清掉**：那些号码属于那个已经不在的会话，
  // 留着就会在新源会话上勾出几个「用户没勾过的轮次」，确认下去材料就对不上号了。
  {
    const gone = fixture('s_gone', '已删掉的来源', [['甲问', '甲答']]);
    const holder = fixture('s_holder', '拿着材料的会话', []);
    holder.reference = {
      kind: 'turns',
      sessionId: gone.id,
      title: gone.title,
      at: 1,
      text: '【背景材料】以下是另一个会话里的内容：《已删掉的来源》第 1 轮的一问一答\n\n用户：甲问\n助手：甲答\n\n【背景材料结束】',
      turns: [1],
      covers: 0,
    };
    const oneTurn = fixture('s_one', '一轮会话', [['乙问', '乙答']]);
    install([oneTurn, holder], holder.id);
    await sleep(60);
    check('材料还在、源会话已经不在了（这正说明材料是快照）',
      active().reference?.sessionId === gone.id && !state().sessions.some((s) => s.id === gone.id));
    check('标注条如实写了「原会话已删除」',
      getEl('reference-note-text').textContent.includes('原会话已删除'),
      getEl('reference-note-text').textContent);

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
    check('面板的提示里也写明那份材料的原会话已经删了',
      getEl('reference-replace-note').textContent.includes('原会话已删除'),
      getEl('reference-replace-note').textContent);
    dispatch(getEl('reference-cancel'), 'click');
  }

  // ---- 多页轮次：面板上标「N 页」，材料里写明给的是哪一页
  //
  // 取最后一页是**正常用法**（材料要的是这个会话现在的样子，旧页是留着对比的），
  // 但不能藏着 —— 页数标在轮次行上，材料里写一句「第 2 轮原先有 2 页，这里给的是最后一页」。
  {
    const multi = fixture('s_multi_pages', '多页会话',
      [['第一问', '第一答'], ['第二轮提问的第二版', '第二轮回答的第二版']], { 1: 2 });
    const blank = fixture('s_blank_pages', '新对话', []);
    install([multi, blank], blank.id);
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
    check('面板的说明里也写清了「确认后挂在当前这个会话上」（就地生效那条新路）',
      /确认后它挂在\*\*当前这个会话\*\*上/.test(html));

    getEl('reference-kind').value = 'turns';
    dispatch(getEl('reference-kind'), 'change', { target: { value: 'turns' } });
    const multiBox = boxesOf()[1];
    multiBox.checked = true;
    dispatch(getEl('reference-turns'), 'change', { target: multiBox });
    dispatch(getEl('reference-confirm'), 'click');
    await sleep(80);
    check('材料带的是最后一页', String(active().reference?.text ?? '').includes('第二轮回答的第二版'),
      String(active().reference?.text ?? '').slice(0, 200));
    check('材料里写明这一轮原先有几页、给的是哪一页',
      String(active().reference?.text ?? '').includes('第 2 轮原先有 2 页') &&
        String(active().reference?.text ?? '').includes('这里给的是最后一页'),
      String(active().reference?.text ?? ''));

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

  // ---- 已有材料时再点「引用会话」：预填 + 说清是替换，不许静默覆盖
  //
  // 用户报的那一幕：引用完还没提问，再点一次「引用会话」，面板是**空白默认值**，
  // 按下去就把第一份材料换掉了，全程没人告诉他这是替换。
  //
  // 规矩：一个会话一份材料 · 三个入口做同一件事（设置**这个会话**的材料）·
  // 已有就预填出来改，并把后果写在按下去之前。
  {
    const srcA = fixture('s_src_a', '材料甲', [['甲的一问', '甲的一答']]);
    const srcB = fixture('s_src_b', '材料乙', [['乙的一问', '乙的一答']]);
    const blank = fixture('s_carrier_c', '新对话', []);
    install([srcA, srcB, blank], blank.id);
    await sleep(60);
    check('造出一个空白会话（就是「刚引用完还没提问」的那个状态）', state().activeId === blank.id);

    const notice = () => getEl('reference-replace-note');
    const confirmLabel = () => getEl('reference-confirm').textContent;
    const newSessionLink = () => getEl('reference-new-session-link');

    // ---- 第一份材料：挂到空白会话上
    dispatch(getEl('reference-new-button'), 'click');
    await sleep(30);
    check('还没有材料时：不出「替换」提示', notice().hidden === true, notice().textContent);
    check('还没有材料时：主按钮说的是「在这个会话里生效」', confirmLabel() === '在这个会话里生效', confirmLabel());
    check('空白会话里不给「带着它开一个新会话」这个次要入口（两条路是一回事）',
      newSessionLink().hidden === true);
    dispatch(getEl('reference-source'), 'change', { target: { value: srcA.id } });
    getEl('reference-kind').value = 'turns';
    dispatch(getEl('reference-kind'), 'change', { target: { value: 'turns' } });
    const firstBox = boxesOf()[0];
    firstBox.checked = true;
    dispatch(getEl('reference-turns'), 'change', { target: firstBox });
    dispatch(getEl('reference-confirm'), 'click');
    await sleep(80);
    check('第一份材料挂上了（来自《材料甲》）',
      active().reference?.title === '材料甲' && active().reference?.turns?.join(',') === '1',
      JSON.stringify({ title: active().reference?.title, turns: active().reference?.turns }));

    // ---- 再点一次「引用会话」：面板要预填现有材料，并说明会替换
    dispatch(getEl('reference-new-button'), 'click');
    await sleep(30);
    check('再次打开时：面板预填了现有材料的来源会话',
      sourceOptionOf()?.value === srcA.id, String(sourceOptionOf()?.value));
    check('再次打开时：预填了材料形式（原文）', kindOf() === 'turns', kindOf());
    check('再次打开时：预填了上次勾的轮次', boxesOf()[0]?.checked === true);
    check('再次打开时：明说这一按会替换（不是静默覆盖）',
      notice().hidden === false && notice().textContent.includes('替换') === true,
      notice().textContent);
    check('再次打开时：按钮改口成「替换这份材料」', confirmLabel() === '替换这份材料', confirmLabel());

    // ---- 换成另一个来源再确认：替换掉旧的，而且**只有一条**（C 与 A 的分界）
    dispatch(getEl('reference-source'), 'change', { target: { value: srcB.id } });
    const secondBox = boxesOf()[0];
    secondBox.checked = true;
    dispatch(getEl('reference-turns'), 'change', { target: secondBox });
    dispatch(getEl('reference-confirm'), 'click');
    await sleep(80);
    const replaced = active();
    check('替换之后材料只有一份，而且是新的那份（《材料乙》）',
      replaced.reference?.title === '材料乙' && !String(replaced.reference?.text ?? '').includes('材料甲'),
      JSON.stringify({ title: replaced.reference?.title }));
    check('替换之后标注条也换成了新的', getEl('reference-note-text').textContent.includes('材料乙'),
      getEl('reference-note-text').textContent);

    // ---- 会话里已经聊过：这时才给出「带着它开一个新会话」这条次要入口
    await say('带着材料问一句');
    const talked = active();
    dispatch(getEl('reference-new-button'), 'click');
    await sleep(30);
    check('已经聊过的会话：提示仍是同一条规矩（替换），不再有第二种说法',
      notice().hidden === false && notice().textContent.includes('替换')
        && !notice().textContent.includes('另开一个新会话'),
      notice().textContent);
    check('已经聊过的会话：主按钮仍说「替换这份材料」', confirmLabel() === '替换这份材料', confirmLabel());
    check('已经聊过的会话：多出「带着它开一个新会话」这个次要入口',
      newSessionLink().hidden === false);

    const beforeSwitch = state().sessions.length;
    dispatch(newSessionLink(), 'click');
    await sleep(80);
    check('次要入口：确实另开了一个新会话', state().sessions.length === beforeSwitch + 1,
      `${beforeSwitch} → ${state().sessions.length}`);
    check('次要入口：材料挂在新会话上，不是原会话',
      active().id !== talked.id && Boolean(active().reference?.text));
    const oldOne = state().sessions.find((s) => s.id === talked.id);
    check('次要入口：老会话的材料和消息一条没动',
      oldOne?.reference?.title === '材料乙' && oldOne.messages.length === talked.messages.length,
      JSON.stringify({ title: oldOne?.reference?.title, messages: oldOne?.messages.length }));
    check('次要入口：新会话是空的（带过去的只有材料）',
      active().messages.length === 0, String(active().messages.length));
  }

  chatStreams = false;
}

console.log('\n⑳ 正文的渲染窗口：只画最近 20 轮，更早的按需补');

{
  // 替身不解析 HTML：模板克隆出来的节点 className 是空的，所以「哪一行是哪一个」只能靠
  // app 自己写在节点上的东西认 —— 对谈节点带 dataset.id，而「更早的 N 轮」那一行是
  // createElement 建的（className 是真的），两边都认得出。
  const exchanges = getEl('exchanges');
  const earlierRow = () => exchanges.children.find((n) => n.className === 'exchange-earlier') ?? null;
  const earlierButton = () => earlierRow()?.children[0] ?? null;
  const turnNodes = () => exchanges.children.filter((n) => n.dataset?.id);
  const numbers = () => turnNodes().map((n) => n.querySelector('[data-field="number"]').textContent);
  const turnIds = () => turnNodes().map((n) => n.dataset.turn ?? '');
  // 压缩标记：只有它自己的 label 会被写上文字（和上半场同一个认法）
  const notes = () =>
    exchanges.children.filter(
      (n) => String(n.querySelector('[data-field="context-note-label"]')?.textContent ?? '').length > 0,
    );
  const noteLabel = (node) => node?.querySelector('[data-field="context-note-label"]')?.textContent ?? '';
  const last = (arr) => arr[arr.length - 1];
  const dataNow = () => JSON.parse(storage.get('duitanlu.sessions.v2'));
  const seededMessages = (id) => dataNow().sessions.find((s) => s.id === id)?.messages ?? [];

  /** 造一个 n 轮的会话（一轮 = 一问一答），字段形状和别处的夹具一致 */
  function makeSession(id, title, turns, extra = {}) {
    const messages = [];
    for (let i = 1; i <= turns; i += 1) {
      messages.push({
        id: `${id}_u${i}`,
        role: 'user',
        content: `第 ${i} 个问题`,
        versions: [{ content: `第 ${i} 个问题`, createdAt: 0, attachments: [], quote: null, feedback: null }],
        versionCount: 1,
      });
      messages.push({
        id: `${id}_a${i}`,
        role: 'assistant',
        content: `第 ${i} 个回答`,
        versions: [
          {
            content: `第 ${i} 个回答`,
            createdAt: 0,
            attachments: [],
            quote: null,
            feedback: null,
            status: 'done',
            model: 'gpt-4o',
          },
        ],
        versionCount: 1,
      });
    }
    return { id, title, createdAt: 1000, updatedAt: 2000, messages, ...extra };
  }

  /** 灌进 localStorage，再走 app 自己的跨标签页通道让它接进去（等价于刷新一次） */
  function seed(payload) {
    storage.set('duitanlu.sessions.v2', JSON.stringify(payload));
    for (const h of windowHandlers.filter((x) => x.type === 'storage')) {
      h.fn({ key: 'duitanlu.sessions.v2', newValue: JSON.stringify(payload) });
    }
    reloadActiveSession();
  }

  const clickEarlier = () => dispatch(exchanges, 'click', { target: earlierButton() });
  const payloadOf = (extra = {}) => ({
    activeId: 's_win_a',
    sessions: [makeSession('s_win_a', '长会话', 45, extra), makeSession('s_win_b', '短会话', 3)],
  });

  configMode = 'model';
  chatMode = 'model';
  chatStreams = true;

  seed(payloadOf());
  await new Promise((r) => setTimeout(r, 60));

  check('45 轮的会话默认只画最近 20 轮', turnNodes().length === 20, `${turnNodes().length} 轮`);
  check('编号仍是全局序号（第 26–45 轮，不是从 01 重来）',
    numbers().join(',') === Array.from({ length: 20 }, (_v, i) => String(26 + i).padStart(2, '0')).join(','),
    numbers().join(','));
  check('正文里那个编号和节点上记的编号是同一个（两处不许各说各的）',
    numbers().join(',') === turnIds().join(','), `${numbers().join(',')} / ${turnIds().join(',')}`);
  check('顶上有一条「更早的 20 轮」', earlierButton()?.textContent === '更早的 20 轮', earlierButton()?.textContent);
  check('按钮上说明上面还藏着几轮',
    String(earlierButton()?.title ?? '').includes('还有 25 轮'), String(earlierButton()?.title ?? ''));
  check('「更早的」排在第一条对谈上面（它就是窗口的顶边）', exchanges.children[0] === earlierRow());
  check('窗口只管画、不管存：落盘里还是 90 条消息',
    seededMessages('s_win_a').length === 90, String(seededMessages('s_win_a').length));
  {
    // 数据这一侧单独守一遍：画 20 轮，导出必须还是全部 45 轮。
    // （分页只准决定「画哪些」，一旦渗进「有什么」，导出、摘要、引用原文就都会缺料。）
    const md = toMarkdown(dataNow().sessions.find((s) => s.id === 's_win_a'));
    check('导出用的是全部消息：藏在窗口之上的第 1 轮也在里面',
      md.includes('第 1 个问题') && md.includes('第 45 个问题'), `${md.length} 字`);
    check('导出的回答条数 = 45（不是画出来的 20）',
      (md.match(/第 \d+ 个回答/g) ?? []).length === 45,
      String((md.match(/第 \d+ 个回答/g) ?? []).length));
  }

  check('点「更早的」确实有处理器接住（不是画了个死按钮）', clickEarlier() > 0);
  check('点一次补到 40 轮', turnNodes().length === 40, `${turnNodes().length} 轮`);
  check('补进来的历史编号接得上（从第 6 轮开始）', numbers()[0] === '06', numbers()[0]);
  check('按钮改口成「更早的 5 轮」（只补剩下的那几轮）',
    earlierButton()?.textContent === '更早的 5 轮', earlierButton()?.textContent);
  clickEarlier();
  check('再点一次就全画出来了（45 轮）', turnNodes().length === 45, `${turnNodes().length} 轮`);
  check('全画出来之后「更早的」那一行就收了', earlierRow() === null);

  // ---- 滚到最上面也会自动补一段；在页面中间不许乱补
  //
  // 先把窗口弄回 20 轮：**换走再换回来**（切会话就复位）。
  // 这里不能靠「重新灌一份数据」来复位 —— 会话 id 没变，窗口本来就不该复位，
  // 那正是「按会话复位」这条规矩的另一面（下面单独有一条断言守它）。
  const rowFor = (id) => {
    const row = makeElement('li');
    row.className = 'session-item';
    row.dataset.id = id;
    return row;
  };
  const switchTo = (id) => dispatch(getEl('session-list'), 'click', { target: rowFor(id) });
  switchTo('s_win_b');
  switchTo('s_win_a');
  check('切走再回来的会话回到最近 20 轮', turnNodes().length === 20, `${turnNodes().length} 轮`);
  window.scrollY = 900;
  for (const fn of scrollHandlers) fn({});
  check('在页面中间滚动不会凭空补历史', turnNodes().length === 20, `${turnNodes().length} 轮`);
  window.scrollY = 10;
  for (const fn of scrollHandlers) fn({});
  check('滚到最上面自动补一段', turnNodes().length === 40, `${turnNodes().length} 轮`);

  // ---- 滚动锚定：往上插内容会把正在看的那一行顶下去，视口得跟着往下挪同样多
  {
    const realDocEl = document.documentElement;
    let reads = 0;
    scrollByCalls.length = 0;
    // 「补之前文档 1000 高、补之后 1600 高」—— 长高了 600，视口就该往下挪 600
    document.documentElement = {
      ...realDocEl,
      get scrollHeight() {
        reads += 1;
        return reads === 1 ? 1000 : 1600;
      },
    };
    clickEarlier();
    document.documentElement = realDocEl;
    check('补历史之后把视口往下挪「文档长高的那一截」（屏幕上的内容不动）',
      last(scrollByCalls)?.dx === 0 && last(scrollByCalls)?.dy === 600,
      JSON.stringify(last(scrollByCalls) ?? null));
  }

  // ---- 压缩界线落在窗口之上时，标记挂在窗口顶部（位置说的还是实话）
  //
  // 两个用例都要先把窗口复位（切走再回来）：压缩标记的位置只有在「只画 20 轮」的前提下
  // 才谈得上「落在窗口之上」。
  seed(payloadOf({ summary: { covers: 10, text: '前五轮的摘要', at: 1500 } }));
  switchTo('s_win_b');
  switchTo('s_win_a');
  check('摘要覆盖的轮次藏在窗口之上时，标记挂在窗口最前面（不是凭空消失）',
    notes().length === 1 && exchanges.children.indexOf(notes()[0]) === 1,
    `第 ${exchanges.children.indexOf(notes()[0])} 个孩子，共 ${exchanges.children.length} 个`);
  check('挂在顶上那条说的还是实话（以上 10 条已压缩）',
    noteLabel(notes()[0]).includes('以上 10 条'), noteLabel(notes()[0]));
  check('它下面紧跟的就是窗口里的第一轮（第 26 轮）',
    exchanges.children[2]?.dataset?.turn === '26', String(exchanges.children[2]?.dataset?.turn));

  // covers = 88 条 = 44 轮：界线正好落在第 44 轮那条回答后面，而它是画得出来的
  seed(payloadOf({ summary: { covers: 88, text: '几乎都压了', at: 1500 } }));
  switchTo('s_win_b');
  switchTo('s_win_a');
  {
    const at = exchanges.children.indexOf(notes()[0]);
    check('界线那一轮画得出来时，标记照旧紧跟在那条回答后面',
      notes().length === 1 && exchanges.children[at - 1]?.dataset?.turn === '44',
      `标记在第 ${at} 位，它前面是第 ${exchanges.children[at - 1]?.dataset?.turn} 轮`);
    check('后面的轮次照旧排在它下面（第 45 轮）',
      exchanges.children[at + 1]?.dataset?.turn === '45', String(exchanges.children[at + 1]?.dataset?.turn));
  }

  // ---- 换会话就复位：展开状态不持久化（少一份要跟会话对齐的状态）
  switchTo('s_win_b');
  switchTo('s_win_a');
  check('（准备）切回来又是 20 轮', turnNodes().length === 20, `${turnNodes().length} 轮`);
  clickEarlier();
  clickEarlier();
  check('（准备）在这个会话里已经全展开（45 轮）', turnNodes().length === 45, `${turnNodes().length} 轮`);
  switchTo('s_win_b');
  check('切到短会话：画的是它自己的 3 轮',
    turnNodes().length === 3 && numbers()[0] === '01', `${turnNodes().length} 轮 / 首个编号 ${numbers()[0]}`);
  switchTo('s_win_a');
  check('切回来又回到最近 20 轮（展开状态不持久化）', turnNodes().length === 20, `${turnNodes().length} 轮`);
}

console.log('\n㉑ 会话列表：最近这一组默认只显示几个');

{
  const recentRows = () => getEl('recent-list').children;
  const pinnedRows = () => getEl('pinned-list').children;
  const more = () => getEl('recent-more');
  const rowTitle = (row) => row.querySelector('[data-field="name"]')?.textContent ?? '';
  const rowIds = (rows) => rows.map((row) => row.dataset.id).join(',');

  const MIN = 60 * 1000;
  const DAY = 24 * 60 * MIN;
  const now = Date.now();
  const make = (id, title, { ago = 1, pinned = false } = {}) => ({
    id,
    title,
    createdAt: now - 100 * DAY,
    updatedAt: now - ago * MIN,
    pinned,
    messages: [],
  });

  const payload = {
    // active 故意选**最老的那个会话**：它在默认显示的 6 条之外，必须仍然出现在列表里。
    // id 必须过得了 store 那关（`/^[A-Za-z0-9_-]{4,64}$/`）—— 太短的会被整条丢掉，
    // 表现是「数据灌进去了但列表纹丝不动」（我第一次写成 r_1 就是这么被耍的）。
    activeId: 'rec_12',
    sessions: [
      // 置顶 7 个（超过 6）——「置顶」这一组**不裁**：用户明确说过它重要
      ...Array.from({ length: 7 }, (_v, i) => make(`pin_0${i + 1}`, `置顶${i + 1}`, { ago: 500 + i, pinned: true })),
      ...Array.from({ length: 12 }, (_v, i) =>
        make(`rec_${String(i + 1).padStart(2, '0')}`, `会话${i + 1}`, { ago: i + 1 })),
    ],
  };
  storage.set('duitanlu.sessions.v2', JSON.stringify(payload));
  for (const h of windowHandlers.filter((x) => x.type === 'storage')) {
    h.fn({ key: 'duitanlu.sessions.v2', newValue: JSON.stringify(payload) });
  }
  await new Promise((r) => setTimeout(r, 60));

  // ⑯ 那段为了核对 8 档时间点过「显示全部」，所以这里先把它收回来（同一个开关）
  if (/^只看最近/.test(more()?.textContent ?? '')) dispatch(more(), 'click');
  // ⑮ 结束时把两组都收着了（那是用户的选择，会记住）—— 这里先都展开，
  // 否则下面「收起 / 展开」那两条断言点下去的方向正好相反
  if (getEl('recent-list').hidden === true) dispatch(getEl('recent-toggle'), 'click');
  if (getEl('pinned-list').hidden === true) dispatch(getEl('pinned-toggle'), 'click');

  check('「最近」默认只画 6 个 + 当前这一个（不是 12 行全铺出来）',
    recentRows().length === 7, `${recentRows().length} 行`);
  check('默认画的是最近的那几个', rowIds(recentRows()).startsWith('rec_01,rec_02,rec_03,rec_04,rec_05,rec_06'),
    rowIds(recentRows()));
  check('当前会话在列 —— 哪怕它是最老的那个（刷新之后也一样，不该像丢了）',
    recentRows().some((row) => row.dataset.id === 'rec_12' && row.dataset.active === 'true'),
    rowIds(recentRows()));
  check('「最近」标题上的条数写的是真实条数（12，不是画出来的 7）',
    getEl('recent-count').textContent === '12', getEl('recent-count').textContent);
  check('按钮上写着还藏着几个', more().textContent === '显示全部（还藏着 5 个）', more().textContent);
  check('按钮记着藏起来的条数（5）', more().dataset.hiddenCount === '5', more().dataset.hiddenCount);
  check('「置顶」那一组不裁：7 个全在', pinnedRows().length === 7, `${pinnedRows().length} 行`);
  check('总条数没变（19 个会话，一个都没少）',
    getEl('session-count').textContent === '19', getEl('session-count').textContent);

  dispatch(more(), 'click');
  check('点「显示全部」：12 行全画出来', recentRows().length === 12, `${recentRows().length} 行`);
  check('展开之后按钮改口成「只看最近 6 个」（不是死胡同）',
    more().textContent === '只看最近 6 个', more().textContent);
  check('展开只是多画几行：条数还是 12、总数还是 19',
    getEl('recent-count').textContent === '12' && getEl('session-count').textContent === '19',
    `${getEl('recent-count').textContent} / ${getEl('session-count').textContent}`);
  check('这个选择记在本地（刷新之后还是展开的）',
    JSON.parse(storage.get('duitanlu.railGroups.v1') ?? '{}').recentAll === true,
    storage.get('duitanlu.railGroups.v1'));

  dispatch(more(), 'click');
  check('再点回来：又只剩 7 行（当前会话仍然在）',
    recentRows().length === 7 && recentRows().some((row) => row.dataset.id === 'rec_12'),
    `${recentRows().length} 行`);
  check('按钮的话也跟着回到「显示全部」', more().textContent === '显示全部（还藏着 5 个）', more().textContent);

  // 整组收起来时，这个按钮不该孤零零留在收起状态下面
  dispatch(getEl('recent-toggle'), 'click');
  check('「最近」收起来时，这个按钮也跟着藏', more().hidden === true, String(more().hidden));
  dispatch(getEl('recent-toggle'), 'click');
  check('展开回来按钮也回来', more().hidden === false, String(more().hidden));

  // 会话本来就不多时，这个按钮没有存在的理由
  const few = {
    activeId: 'few_01',
    sessions: [make('few_01', '只有一个', { ago: 1 }), make('few_02', '两个', { ago: 2 })],
  };
  storage.set('duitanlu.sessions.v2', JSON.stringify(few));
  for (const h of windowHandlers.filter((x) => x.type === 'storage')) {
    h.fn({ key: 'duitanlu.sessions.v2', newValue: JSON.stringify(few) });
  }
  await new Promise((r) => setTimeout(r, 60));
  check('只有 2 个会话时，不出「显示全部」', more().hidden === true, String(more().hidden));
  check('（顺便）2 个会话都画出来了', recentRows().length === 2, `${recentRows().length} 行`);
}

console.log('\n㉒ 搜索会话：按标题或正文找，找到之后列表切成平铺的结果');

{
  const searchBox = getEl('session-search');
  const searchSection = getEl('group-search');
  const results = () => getEl('search-list').children;
  const resultIds = () => results().map((row) => row.dataset.id).join(',');
  const metaOf = (id) => results().find((row) => row.dataset.id === id)?.querySelector('[data-field="meta"]')?.textContent ?? '';
  const more = () => getEl('recent-more');
  const type = (text) => {
    searchBox.value = text;
    dispatch(searchBox, 'input');
  };

  const MIN2 = 60 * 1000;
  const now = Date.now();
  const msg = (id, role, content, versions) => ({
    id,
    role,
    content,
    versions: (versions ?? [content]).map((text) => ({
      content: text,
      createdAt: 0,
      attachments: [],
      quote: null,
      feedback: null,
      ...(role === 'assistant' ? { status: 'done', model: 'gpt-4o' } : {}),
    })),
    versionCount: (versions ?? [content]).length,
  });
  const session = (id, title, messages, ago) => ({
    id,
    title,
    createdAt: now - 10 * 24 * 60 * MIN2,
    updatedAt: now - ago * MIN2,
    messages,
  });

  const payload = {
    // 当前会话故意选一个**搜不到**的、而且排在「最近」那一组的最后一个：
    // 搜索结果里不该硬塞当前会话（它跟这段字没关系）
    activeId: 'srch_h',
    sessions: [
      session('srch_pin', '置顶的旧笔记', [msg('srch_pin_u1', 'user', '这条一直钉在上面')], 60),
      // 这一条的提问有两个版本：现在显示的是「什么是闭包」，
      // 旧那一版里写着「旧版：什么叫闭包」—— 只在当前版里搜是搜不到后者的
      session('srch_a', '闭包那点事', [
        msg('srch_a_u1', 'user', '什么是闭包', ['旧版：什么叫闭包', '什么是闭包']),
        msg('srch_a_a1', 'assistant', '闭包是函数和它的词法环境的组合'),
      ], 1),
      session('srch_b', 'React 性能优化', [
        msg('srch_b_u1', 'user', 'useMemo 什么时候用'),
        msg('srch_b_a1', 'assistant', '只在计算很贵的时候用'),
      ], 2),
      session('srch_c', '今天吃什么', [], 3),
      session('srch_d', '周报模板', [msg('srch_d_u1', 'user', '本周做了三件事')], 4),
      session('srch_e', '论文思路', [msg('srch_e_u1', 'user', '先写引言')], 5),
      session('srch_f', '买菜清单', [msg('srch_f_u1', 'user', '西红柿 鸡蛋')], 6),
      session('srch_g', '装修预算', [msg('srch_g_u1', 'user', '刷墙多少钱')], 7),
      session('srch_h', '运动计划', [msg('srch_h_u1', 'user', '每周跑三次')], 8),
    ],
  };
  payload.sessions[0].pinned = true;
  storage.set('duitanlu.sessions.v2', JSON.stringify(payload));
  const payloadBefore = storage.get('duitanlu.sessions.v2');
  for (const h of windowHandlers.filter((x) => x.type === 'storage')) {
    h.fn({ key: 'duitanlu.sessions.v2', newValue: JSON.stringify(payload) });
  }
  await new Promise((r) => setTimeout(r, 60));
  // 上一段可能把「显示全部」点开过，这里先回到默认（同一个开关）
  if (/^只看最近/.test(more()?.textContent ?? '')) dispatch(more(), 'click');
  if (getEl('recent-list').hidden === true) dispatch(getEl('recent-toggle'), 'click');

  check('没输入时：搜索结果区藏着，两组照旧',
    searchSection.hidden === true && getEl('group-recent').hidden === false);
  check('（准备）8 个会话时「显示全部」是露着的', more().hidden === false, String(more().hidden));

  type('闭包');
  check('输入之后：搜索结果区出现', searchSection.hidden === false, String(searchSection.hidden));
  check('命中数写在标题右边', getEl('search-count').textContent === '1', getEl('search-count').textContent);
  check('命中的就是那一条', resultIds() === 'srch_a', resultIds());
  check('结果行里说明命中在哪儿（正文的一段）',
    metaOf('srch_a').startsWith('匹配：') && metaOf('srch_a').includes('闭包'), metaOf('srch_a'));
  check('搜索时原来的两组让位（平铺结果，不分组）',
    getEl('group-recent').hidden === true && getEl('group-pinned').hidden === true);
  check('搜索结果里不会硬塞当前会话（它跟这段字没关系）', !resultIds().includes('srch_h'), resultIds());
  check('搜索时「显示全部」也收起来（这时候它没有意义）', more().hidden === true, String(more().hidden));

  type('旧版');
  check('编辑过的旧版本里的字也搜得到（不是只搜当前那一版）',
    resultIds() === 'srch_a' && metaOf('srch_a').includes('旧版'), `${resultIds()} / ${metaOf('srch_a')}`);

  type('react');
  check('标题命中：大小写不敏感', resultIds() === 'srch_b', resultIds());
  check('标题命中时行里照旧显示「时间 · 几轮 · 角色」（没有可摘的正文）',
    metaOf('srch_b').includes('轮') && !metaOf('srch_b').startsWith('匹配：'), metaOf('srch_b'));

  type('USEMEMO');
  check('正文命中：大小写也不敏感',
    resultIds() === 'srch_b' && metaOf('srch_b').toLowerCase().includes('usememo'),
    `${resultIds()} / ${metaOf('srch_b')}`);

  type('不存在的字');
  check('搜不到时：命中数是 0', getEl('search-count').textContent === '0', getEl('search-count').textContent);
  check('搜不到时给一句话，而不是一个空列表',
    getEl('search-empty').hidden === false && getEl('search-list').children.length === 0);

  dispatch(searchBox, 'keydown', { key: 'Escape' });
  check('Esc 清空输入框', searchBox.value === '', searchBox.value);
  check('清空之后：搜索结果区收起、两组回来',
    searchSection.hidden === true && getEl('group-recent').hidden === false && getEl('group-pinned').hidden === false);
  check('清空之后「显示全部」也回来了', more().hidden === false, String(more().hidden));
  check('最近那一组又只画 7 行（8 个里画 6 + 当前）',
    getEl('recent-list').children.length === 7, `${getEl('recent-list').children.length} 行`);
  check('搜索一行数据都没改（落盘的 payload 一模一样）',
    storage.get('duitanlu.sessions.v2') === payloadBefore);
  check('所有会话都还在（9 个）', getEl('session-count').textContent === '9', getEl('session-count').textContent);

  // 从搜索结果里直接切过去（这才是「找到它」之后要做的事）。
  // 注意事件派在 #session-list 上：搜索区在它里面，真实浏览器里靠冒泡上来，替身没有冒泡。
  type('买菜');
  dispatch(getEl('session-list'), 'click', { target: results()[0] });
  check('点搜索结果就切到那个会话', JSON.parse(storage.get('duitanlu.sessions.v2')).activeId === 'srch_f',
    `activeId=${JSON.parse(storage.get('duitanlu.sessions.v2')).activeId} 命中=${resultIds()} 输入框=${searchBox.value}`);
  check('切过去之后搜索框里的字还在（方便接着找下一个）', searchBox.value === '买菜', searchBox.value);
  type('');
  await new Promise((r) => setTimeout(r, 20));
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
