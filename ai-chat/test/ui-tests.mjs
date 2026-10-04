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
    querySelector() {
      return makeElement('span');
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
    closest() {
      return null;
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
globalThis.document = {
  getElementById: (id) => getEl(id),
  createElement: (tag) => {
    const el = makeElement(tag);
    created.push(el);
    return el;
  },
  addEventListener: () => {},
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
    // 只接住 scroll，供测试主动触发
    if (type === 'scroll') scrollHandlers.push(fn);
  },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  scrollTo() {},
  open() {},
  prompt: () => null,
  scrollY: 0,
  innerHeight: 800,
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

for (const id of ['session-template', 'attachment-template', 'exchange-template']) {
  const el = getEl(id);
  el.content = {
    cloneNode: () => {
      const frag = makeElement('div');
      frag.querySelector = () => makeElement('span');
      frag.querySelectorAll = () => [];
      return frag;
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
