'use strict';

/**
 * 极简 DOM 垫片（只覆盖本应用用到的能力）。
 * 目的：让 test/dom.test.js 能把真实的 index.html + core.js + ui.js 跑起来，
 * 从而在零依赖的前提下验证"页面真的能用"，而不只是数据层对不对。
 *
 * 刻意不做的事：完整 CSS 层叠、布局、真实渲染。这里只保证 DOM 语义与事件流正确。
 */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);

const BOOLEAN_ATTRS = new Set(['hidden', 'disabled', 'checked', 'required', 'open', 'selected', 'novalidate', 'multiple']);

function camel(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/* ------------------------------------------------------------------ 节点 */

class Node {
  constructor(type) {
    this.nodeType = type;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this._listeners = new Map();
  }

  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] || null;
  }

  appendChild(node) {
    if (!node) throw new Error('appendChild(null)');
    if (node.nodeType === 11) {
      // DocumentFragment：把子节点搬过来
      node.childNodes.slice().forEach((child) => this.appendChild(child));
      node.childNodes.length = 0;
      return node;
    }
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    notifyMutation(this);
    return node;
  }

  append(...nodes) {
    nodes.forEach((n) => this.appendChild(typeof n === 'string' ? new Text(n) : n));
  }

  insertBefore(node, ref) {
    if (!ref) return this.appendChild(node);
    const i = this.childNodes.indexOf(ref);
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, node);
    notifyMutation(this);
    return node;
  }

  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) {
      this.childNodes.splice(i, 1);
      node.parentNode = null;
      notifyMutation(this);
    }
    return node;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  /* ---- 属性 ---- */
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'id' && this.ownerDocument) this.ownerDocument._index(this);
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  /* ---- 事件 ---- */
  addEventListener(type, fn) {
    if (typeof fn !== 'function') return;
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this._listeners.get(type);
    if (list) this._listeners.set(type, list.filter((f) => f !== fn));
  }

  dispatchEvent(event) {
    event.target = event.target || this;
    const path = [];
    for (let n = this; n; n = n.parentNode) path.push(n); // [target, ..., root]

    // 捕获阶段：从根往下
    for (let i = path.length - 1; i >= 1; i -= 1) {
      deliver(path[i], event, true);
      if (event._stopped) return !event.defaultPrevented;
    }
    // 目标 + 冒泡
    for (let i = 0; i < path.length; i += 1) {
      deliver(path[i], event, false);
      if (event._stopped) break;
      if (!event.bubbles && i === 0) break;
    }
    return !event.defaultPrevented;
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  /** 浏览器里 a.click() 会派发一次 click 事件 */
  click() {
    const Ctor = this.ownerDocument && this.ownerDocument.defaultView ? this.ownerDocument.defaultView.Event : DomEvent;
    this.dispatchEvent(new Ctor('click', { bubbles: true, cancelable: true }));
  }

  blur() {
    if (this.ownerDocument && this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
  }

  scrollIntoView() {
    /* 布局无关，忽略 */
  }

  /** 文本输入框上的全选；测试里只需要不报错 */
  select() {
    this._selection = { start: 0, end: String(this.value == null ? '' : this.value).length };
  }

  setSelectionRange(start, end) {
    this._selection = { start, end };
  }

  setPointerCapture() {}
  releasePointerCapture() {}

  closest(selector) {
    for (let n = this; n; n = n.parentNode) {
      if (n.nodeType === 1 && matches(n, selector)) return n;
    }
    return null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const out = [];
    walk(this, (node) => {
      if (node !== this && matches(node, selector)) out.push(node);
    });
    return out;
  }

  get textContent() {
    if (this.nodeType === 3) return this.data;
    return this.childNodes.map((n) => n.textContent).join('');
  }

  set textContent(value) {
    this.childNodes.slice().forEach((n) => (n.parentNode = null));
    this.childNodes.length = 0;
    const str = String(value == null ? '' : value);
    if (str) this.appendChild(new Text(str));
    else notifyMutation(this);
  }

  get isContentEditable() {
    return false;
  }
}

class Text extends Node {
  constructor(data) {
    super(3);
    this.data = String(data);
  }

  get nodeValue() {
    return this.data;
  }

  set nodeValue(v) {
    this.data = String(v);
  }

  get textContent() {
    return this.data;
  }

  set textContent(v) {
    this.data = String(v);
  }
}

class DocumentFragment extends Node {
  constructor() {
    super(11);
  }
}

class Element extends Node {
  constructor(tagName) {
    super(1);
    this.tagName = String(tagName).toUpperCase();
    this.localName = this.tagName.toLowerCase();
    this.namespaceURI = 'http://www.w3.org/1999/xhtml';
    this.style = makeStyle();
    this.dataset = makeDataset(this);
    this._props = { value: '', checked: false, disabled: false, hidden: false };
    this._defaultValue = '';
  }

  get id() {
    return this.getAttribute('id') || '';
  }

  set id(v) {
    this.setAttribute('id', v);
  }

  get className() {
    return this.getAttribute('class') || '';
  }

  set className(v) {
    this.setAttribute('class', v);
  }

  get classList() {
    const self = this;
    return {
      add(...names) {
        const set = new Set(self.className.split(/\s+/).filter(Boolean));
        names.forEach((n) => set.add(n));
        self.className = Array.from(set).join(' ');
      },
      remove(...names) {
        const drop = new Set(names);
        self.className = self.className.split(/\s+/).filter((c) => c && !drop.has(c)).join(' ');
      },
      contains(name) {
        return self.className.split(/\s+/).includes(name);
      },
      toggle(name, force) {
        const has = this.contains(name);
        const want = force === undefined ? !has : Boolean(force);
        if (want) this.add(name);
        else this.remove(name);
        return want;
      },
    };
  }

  /** 属性与 property 之间做最小同步（解析首次遇到属性时用） */
  syncFromAttribute(name, value) {
    if (name === 'value') {
      this._props.value = value;
      this._defaultValue = value;
    } else if (name === 'checked') {
      this._props.checked = true;
      this._checkedDefault = true;
    } else if (name === 'type') {
      this._props.type = value;
    } else if (name === 'disabled') {
      this._props.disabled = true;
    } else if (name === 'hidden') {
      this._props.hidden = true;
    }
  }

  get innerHTML() {
    return '';
  }

  set innerHTML(html) {
    this.childNodes.slice().forEach((n) => (n.parentNode = null));
    this.childNodes.length = 0;
    parseInto(this, String(html), this.ownerDocument);
    notifyMutation(this);
  }

  /* 表单相关的 property：和浏览器一样，写属性要同步回 attribute，
     否则 :checked / [checked] 这类选择器会读到过期的值 */
  get value() {
    return this._props.value;
  }

  set value(v) {
    this._props.value = v == null ? '' : String(v);
    this.attributes.set('value', this._props.value);
  }

  get checked() {
    return this._props.checked;
  }

  set checked(v) {
    const on = Boolean(v);
    this._props.checked = on;
    if (on) this.attributes.set('checked', '');
    else this.attributes.delete('checked');
  }

  get disabled() {
    return this._props.disabled;
  }

  set disabled(v) {
    this._props.disabled = Boolean(v);
    if (this._props.disabled) this.attributes.set('disabled', '');
    else this.attributes.delete('disabled');
  }

  get hidden() {
    return this._props.hidden;
  }

  set hidden(v) {
    this._props.hidden = Boolean(v);
    if (this._props.hidden) this.attributes.set('hidden', '');
    else this.attributes.delete('hidden');
  }

  get type() {
    return this._props.type || this.getAttribute('type') || (this.localName === 'textarea' ? 'textarea' : 'text');
  }

  set type(v) {
    this._props.type = v;
  }

  get files() {
    return this._props.files || null;
  }

  set files(v) {
    this._props.files = v;
  }

  /** 浏览器里 el.title = x 会同步到 title 属性，这里给常用反射属性补上同样行为 */
  get title() {
    return this.getAttribute('title') || '';
  }

  set title(v) {
    this.setAttribute('title', v);
  }

  get name() {
    return this.getAttribute('name') || '';
  }

  set name(v) {
    this.setAttribute('name', v);
  }

  get placeholder() {
    return this.getAttribute('placeholder') || '';
  }

  set placeholder(v) {
    this.setAttribute('placeholder', v);
  }

  get href() {
    return this.getAttribute('href') || '';
  }

  set href(v) {
    this.setAttribute('href', v);
  }

  get src() {
    return this.getAttribute('src') || '';
  }

  set src(v) {
    this.setAttribute('src', v);
  }

  get download() {
    return this.getAttribute('download') || '';
  }

  set download(v) {
    this.setAttribute('download', v);
  }

  /** 浏览器里 select.options 是 HTMLOptionsCollection，这里给个够用的替代 */
  get options() {
    return this.localName === 'select' ? this.querySelectorAll('option') : undefined;
  }

  get open() {
    return this.hasAttribute('open');
  }

  /** 浏览器里 form.reset() 只还原"值"，不会动 value 属性，这里照做 */
  reset() {
    walk(this, (node) => {
      if (node.nodeType !== 1) return;
      if (node.localName === 'input' || node.localName === 'textarea') {
        // 文本类回到默认值；单选/复选只回到 HTML 里写死的勾选状态
        if (node.type !== 'radio' && node.type !== 'checkbox') {
          node._props.value = node._defaultValue || '';
        }
        node.checked = node._checkedDefault === true;
      } else if (node.localName === 'select') {
        node._props.value = '';
      }
    });
  }

  showModal() {
    this.setAttribute('open', '');
  }

  close() {
    this.removeAttribute('open');
  }

  /** 让 svg / DOM 两种创建方式都能拿到标签名 */
  get nodeName() {
    return this.tagName;
  }
}

class Document extends Node {
  constructor() {
    super(9);
    this.ownerDocument = this;
    this.documentElement = null;
    this.head = null;
    this.body = null;
    this.activeElement = null;
    this._ids = new Map();
    this.readyState = 'loading';
  }

  _index(el) {
    const id = el.getAttribute('id');
    if (id) this._ids.set(id, el);
  }

  createElement(tag) {
    const el = new Element(tag);
    el.ownerDocument = this;
    return el;
  }

  createElementNS(ns, tag) {
    const el = this.createElement(tag);
    el.namespaceURI = ns;
    return el;
  }

  createTextNode(data) {
    const t = new Text(data);
    t.ownerDocument = this;
    return t;
  }

  /** 应用会用它拼导出文件的下载链接 */
  createElementFn() {
    return this.createElement('a');
  }

  createDocumentFragment() {
    const f = new DocumentFragment();
    f.ownerDocument = this;
    return f;
  }

  getElementById(id) {
    return this._ids.get(id) || null;
  }

  getElementsByTagName(tag) {
    return this.querySelectorAll(String(tag));
  }
}

/* ------------------------------------------------------------------ 事件对象 */

class DomEvent {
  constructor(type, init) {
    const o = init || {};
    this.type = type;
    this.bubbles = o.bubbles !== false;
    this.cancelable = o.cancelable !== false;
    this.defaultPrevented = false;
    this._stopped = false;
    this.target = null;
    this.currentTarget = null;
    Object.assign(this, o);
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {
    this._stopped = true;
  }

  stopImmediatePropagation() {
    this._stopped = true;
  }
}

function deliver(node, event, capture) {
  const list = node._listeners && node._listeners.get(event.type);
  if (!list || !list.length) return;
  event.currentTarget = node;
  list.slice().forEach((fn) => {
    if (event._stopped) return;
    const opts = fn._opts || {};
    if (capture && !opts.capture) return;
    fn.call(node, event);
  });
}

/* ------------------------------------------------------------------ 选择器引擎 */

const SIMPLE = /([#.]?[\w-]+|\[[^\]]+\]|:[\w-]+(?:\([^)]*\))?)/g;

function matches(el, selector) {
  if (!el || el.nodeType !== 1) return false;
  return String(selector)
    .split(',')
    .some((part) => matchChain(el, part.trim()));
}

function matchChain(el, selector) {
  const tokens = selector.split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  let node = el;
  // 从右往左匹配：只有后代/子代两种关系，够本应用用
  if (!matchSimple(node, tokens[tokens.length - 1])) return false;
  for (let i = tokens.length - 2; i >= 0; i -= 1) {
    const token = tokens[i];
    node = node.parentNode;
    while (node && node.nodeType === 1 && !matchSimple(node, token)) node = node.parentNode;
    if (!node || node.nodeType !== 1) return false;
  }
  return true;
}

function matchSimple(el, token) {
  const parts = token.match(SIMPLE);
  if (!parts) return false;
  for (const raw of parts) {
    if (!matchPart(el, raw)) return false;
  }
  return true;
}

function matchPart(el, raw) {
  if (raw.startsWith('#')) return el.getAttribute('id') === raw.slice(1);
  if (raw.startsWith('.')) return el.classList.contains(raw.slice(1));
  if (raw.startsWith('[')) {
    const body = raw.slice(1, -1);
    const eq = body.indexOf('=');
    if (eq < 0) return el.hasAttribute(body);
    const name = body.slice(0, eq);
    const value = body.slice(eq + 1).replace(/^["']|["']$/g, '');
    return el.getAttribute(name) === value;
  }
  if (raw.startsWith(':')) {
    if (raw === ':checked') return el.checked === true;
    if (raw === ':disabled') return el.disabled === true;
    if (raw === ':enabled') return el.disabled !== true;
    if (raw === ':first-child') return elementSiblings(el)[0] === el;
    if (raw === ':last-child') {
      const sibs = elementSiblings(el);
      return sibs[sibs.length - 1] === el;
    }
    if (raw === ':only-child') return elementSiblings(el).length === 1;
    if (raw.startsWith(':not(')) return !matchSimple(el, raw.slice(5, -1));
    if (raw.startsWith(':has(')) return Boolean(el.querySelector(raw.slice(5, -1)));
    return false; // 其它伪类不影响本应用的行为断言
  }
  return el.localName === raw.toLowerCase();
}

function elementSiblings(el) {
  const parent = el.parentNode;
  if (!parent) return [el];
  return parent.childNodes.filter((n) => n.nodeType === 1);
}

function walk(node, visit) {
  node.childNodes.forEach((child) => {
    if (child.nodeType === 1) {
      visit(child);
      walk(child, visit);
    }
  });
}

/* ------------------------------------------------------------------ HTML 解析 */

// 属性段允许引号里出现 > 或 <（例如 placeholder="补充细节、验收标准…" 这种带符号的文案）
const TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^"'<>])*)(\/?)>/g;
const RAW_TEXT = new Set(['script', 'style', 'textarea']);

function parseInto(root, html, doc) {
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let last = 0;
  let m;

  const flushText = (end) => {
    if (end <= last) return;
    const raw = html.slice(last, end);
    if (raw.trim()) {
      const text = new Text(raw);
      text.ownerDocument = doc;
      top().appendChild(text);
    }
    last = end;
  };

  TAG.lastIndex = 0;
  while ((m = TAG.exec(html))) {
    // 注释里的内容不是标签：整段跳过去
    const commentStart = html.lastIndexOf('<!--', m.index);
    if (commentStart >= last && html.indexOf('-->', commentStart) > m.index) {
      TAG.lastIndex = html.indexOf('-->', commentStart) + 3;
      continue;
    }

    // script / style 里的 JS 可能写着 a < b，这种 < 不是标签：越过它继续找真正的闭合标签
    if (RAW_TEXT.has(m[2].toLowerCase()) && m[1] !== '/' && TAG.lastIndex < html.length && html[TAG.lastIndex] !== '<') {
      TAG.lastIndex += 1;
      continue;
    }

    flushText(m.index);
    last = TAG.lastIndex;

    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3] || '';
    const selfClose = m[4] === '/' || VOID_TAGS.has(tag);

    if (closing) {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].localName === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const el = doc.createElement(tag);
    parseAttrs(el, attrs);
    top().appendChild(el);
    if (!selfClose) stack.push(el);
  }
  flushText(html.length);
  return root;
}

function parseAttrs(el, raw) {
  const re = /([\w:-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(raw))) {
    const name = m[1];
    const value = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5] : '';
    el.setAttribute(name, value);
    el.syncFromAttribute(name, value);
  }
  // SVG 的 <use href> 在旧解析器里走 xlink，这里只做存在性补全
  if (el.localName === 'use' && el.hasAttribute('href') && !el.hasAttribute('xlink:href')) {
    el.setAttribute('xlink:href', el.getAttribute('href'));
  }
}

/* ------------------------------------------------------------------ MutationObserver */

const observers = new Set();

function notifyMutation(target) {
  if (!observers.size) return;
  observers.forEach((obs) => {
    const root = obs._target;
    if (root && target && root.contains(target)) obs._dirty = true;
  });
}

class MutationObserver {
  constructor(callback) {
    this.callback = callback;
    this._target = null;
    this._dirty = false;
    observers.add(this);
  }

  observe(target) {
    this._target = target;
    this._dirty = true;
    this._schedule();
  }

  _schedule() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      if (this._dirty) {
        this._dirty = false;
        this.callback([{ type: 'childList', target: this._target }], this);
      }
      if (this._target) this._schedule();
    }, 0);
  }

  disconnect() {
    this._target = null;
    observers.delete(this);
    if (this._timer) clearTimeout(this._timer);
  }
}

/* ------------------------------------------------------------------ style */

function makeStyle() {
  const store = {};
  return {
    setProperty(name, value) {
      store[name] = String(value);
    },
    getPropertyValue(name) {
      return store[name] || '';
    },
    removeProperty(name) {
      delete store[name];
    },
    get cssText() {
      return Object.keys(store).map((k) => `${k}:${store[k]}`).join(';');
    },
    _store: store,
  };
}

/** dataset.xxx ↔ data-xxx 属性，和浏览器一致 */
function makeDataset(el) {
  const toAttr = (key) => 'data-' + String(key).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
  return new Proxy(
    {},
    {
      get(_, key) {
        if (typeof key !== 'string') return undefined;
        const value = el.getAttribute(toAttr(key));
        return value === null ? undefined : value;
      },
      set(_, key, value) {
        el.setAttribute(toAttr(key), value);
        return true;
      },
      has(_, key) {
        return el.hasAttribute(toAttr(key));
      },
      deleteProperty(_, key) {
        el.removeAttribute(toAttr(key));
        return true;
      },
    }
  );
}

/* ------------------------------------------------------------------ 组装 window */

function createEnvironment(options) {
  const o = options || {};
  const doc = new Document();
  const win = {};

  win.window = win;
  win.document = doc;
  win.self = win;
  win.console = console;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.setInterval = setInterval;
  win.clearInterval = clearInterval;
  win.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 2);
  win.cancelAnimationFrame = (id) => clearTimeout(id);
  win.MutationObserver = MutationObserver;
  win.Event = DomEvent;
  win.Node = Node;
  win.Element = Element;
  win.DocumentFragment = DocumentFragment;
  win.getComputedStyle = () => makeStyle();
  win.matchMedia = (query) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  win.confirm = () => true;
  win.location = { href: 'http://localhost:5210/', search: '', hash: '', pathname: '/', origin: 'http://localhost:5210' };
  win.history = { replaceState() {}, pushState() {} };
  win.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL() {} };
  win.Blob = class Blob {
    constructor(parts, opts2) {
      this.parts = parts || [];
      this.type = (opts2 && opts2.type) || '';
    }
    get size() {
      return this.parts.join('').length;
    }
  };
  win.Notification = class Notification {
    constructor(title, init) {
      this.title = title;
      this.body = init && init.body;
      Notification.instances.push(this);
    }
    static requestPermission() {
      Notification.permission = 'granted';
      return Promise.resolve('granted');
    }
  };
  win.Notification.permission = 'default';
  win.Notification.instances = [];

  class FileReader {
    readAsText(file) {
      this.result = file.content;
      setTimeout(() => {
        if (this.onload) this.onload({ target: this });
      }, 0);
    }
  }
  win.FileReader = FileReader;

  win.localStorage = o.storage || createMemoryStorage();

  // document 自身也是一个节点，事件能冒泡到这里（应用在 document 上做了委托）
  doc.defaultView = win;
  doc.newElement = doc.createElement.bind(doc);

  win.__parse = (html) => {
    // 只取 <body> 内部，和浏览器加载页面后的结构一致
    parseInto(doc, html, doc);
    doc.documentElement = doc.querySelector('html');
    doc.head = doc.querySelector('head');
    doc.body = doc.querySelector('body');
    doc.readyState = 'complete';
    return doc;
  };

  return win;
}

function createMemoryStorage(seed) {
  const map = new Map(seed ? Object.entries(seed) : []);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => Array.from(map.keys())[i] || null,
    get length() {
      return map.size;
    },
    _dump: () => Object.fromEntries(map),
  };
}

module.exports = {
  createEnvironment,
  createMemoryStorage,
  DomEvent,
  Node,
  Element,
  parseInto,
  matches,
  VOID_TAGS,
};
