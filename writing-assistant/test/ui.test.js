/*!
 * 前端界面的行为测试：把 index.html 之外的脚本按真实顺序加载进一个极小的 DOM 桩，
 * 对着**真实服务端**跑起来，然后模拟点击各板块，断言界面上真的切过去了。
 *
 * 为什么需要它：前端这层原来一条行为测试都没有，所以「点了板块没反应」这类问题
 * 只能靠人在浏览器里发现。这个测试用最小的桩件把整条链路跑通：
 *   加载脚本 → 走一遍 boot() → 点击导航 → 看稿签与参数摘要有没有跟着变
 *
 * 桩件是"够用就好"的：只实现前端真正用到的那几个 DOM API。
 * 运行：node test/ui.test.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

// 关键：环境变量要在 require server.js 之前设好（上次就是栽在这里，
// 结果把模板写进了项目里的 data/）
process.env.WA_DATA_DIR = path.join(os.tmpdir(), 'wa-probe-' + Date.now());
process.env.AI_FORCE_OFFLINE = '1';
process.env.WA_OFFLINE_SPEED = '0';
process.env.WA_OFFLINE_CHUNK = '200';

const { start } = require(path.join(ROOT, 'server.js'));

function makeElement(tag) {
  const el = {
    nodeType: 1,
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    attrs: {},
    dataset: {},
    style: {},
    _text: '',
    _events: {},
    className: '',
    value: '',
    disabled: false,
    hidden: false,
    checked: false,
    inert: false,
    scrollTop: 0,
    scrollHeight: 120,
    parent: null,
  };
  Object.defineProperty(el, 'textContent', {
    get() {
      return el._text;
    },
    set(v) {
      el._text = String(v);
    },
  });
  Object.defineProperty(el, 'firstChild', {
    get() {
      return el.children[0] || null;
    },
  });
  el.setAttribute = (k, v) => {
    el.attrs[k] = String(v);
  };
  el.getAttribute = (k) => (k in el.attrs ? el.attrs[k] : null);
  el.removeAttribute = (k) => {
    delete el.attrs[k];
  };
  el.appendChild = (c) => {
    el.children.push(c);
    c.parent = el;
    return c;
  };
  el.append = (...cs) => cs.forEach((c) => c && el.appendChild(c));
  el.insertBefore = (c) => el.appendChild(c);
  el.replaceChildren = (...cs) => {
    el.children = [];
    el.append(...cs);
  };
  el.removeChild = (c) => {
    el.children = el.children.filter((x) => x !== c);
    return c;
  };
  el.remove = () => {
    if (el.parent) el.parent.removeChild(el);
  };
  el.addEventListener = (type, fn) => {
    el._events[type] = (el._events[type] || []).concat(fn);
  };
  el.removeEventListener = () => {};
  el.dispatchEvent = () => true;
  el.focus = () => {};
  el.blur = () => {};
  el.select = () => {};
  el.scrollIntoView = () => {};
  el.click = () => {
    (el._events.click || []).forEach((fn) => fn({ target: el, preventDefault() {}, stopPropagation() {} }));
  };
  el.classList = { toggle() {}, add() {}, remove() {}, contains: () => false };
  el.querySelector = (sel) => findOne(el, sel);
  el.querySelectorAll = (sel) => findAll(el, sel);
  el.closest = (sel) => {
    let node = el;
    while (node) {
      if (matchesSel(node, sel)) return node;
      node = node.parent;
    }
    return null;
  };
  return el;
}

function matchesSel(el, sel) {
  const m = String(sel).match(
    /^([a-zA-Z]*)?(?:#([A-Za-z0-9_-]+))?(?:\.([A-Za-z0-9_-]+))?(?:\[([A-Za-z-]+)(?:=["']?([^"'\]]+)["']?)?\])?$/
  );
  if (!m) return false;
  const [, tag, id, cls, attr, val] = m;
  if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  if (id && el.attrs.id !== id) return false;
  if (cls && !String(el.className || '').split(/\s+/).includes(cls)) return false;
  if (attr) {
    const key = attr.replace(/^data-/, '');
    const got = Object.prototype.hasOwnProperty.call(el.dataset || {}, key) ? el.dataset[key] : el.attrs[attr];
    if (got === undefined || got === null) return false;
    if (val !== undefined && String(got) !== String(val)) return false;
  }
  return true;
}
function walk(root, sel, all, out) {
  for (const child of root.children || []) {
    if (matchesSel(child, sel)) {
      out.push(child);
      if (!all) return out;
    }
    walk(child, sel, all, out);
    if (!all && out.length) return out;
  }
  return out;
}
const findOne = (root, sel) => walk(root, sel, false, [])[0] || null;
const findAll = (root, sel) => walk(root, sel, true, []);

let pass = 0;
const failures = [];
function eq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass += 1;
  else failures.push(label + '\n    期望 ' + JSON.stringify(expected) + '\n    实际 ' + JSON.stringify(actual));
}
function ok(value, label) {
  eq(Boolean(value), true, label);
}
function group(name, fn) {
  const before = failures.length;
  fn();
  console.log('  ' + (failures.length === before ? '✓' : '✗') + ' ' + name);
}
async function agroup(name, fn) {
  const before = failures.length;
  try {
    await fn();
  } catch (err) {
    failures.push(name + ' 抛异常：' + (err && err.message));
  }
  console.log('  ' + (failures.length === before ? '✓' : '✗') + ' ' + name);
}

const collectText = (el) =>
  !el ? '' : el.nodeType === 3 ? String(el.textContent || '') : String(el._text || '') + (el.children || []).map(collectText).join('');

(async () => {
  const app = await start({ port: 0, banner: false });
  const base = app.url.replace(/\/$/, '');

  // 建一个模板（模拟用户自己建的）
  const created = await fetch(base + '/api/templates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      template: {
        name: '产品周报',
        mark: '周',
        system: '你是资深产品经理，替团队写周报，只输出正文，分进展、问题、下周计划三块。',
        outputHint: '每块不超过五条',
      },
    }),
  });
  const tpl = (await created.json()).template;

  const ids = new Map();
  const byId = (id) => {
    if (!ids.has(id)) ids.set(id, makeElement('div'));
    return ids.get(id);
  };
  const ink = makeElement('span');
  ink.className = 'btn__ink';
  const kbd = makeElement('span');
  kbd.className = 'btn__kbd';
  byId('generate').appendChild(ink);
  byId('generate').appendChild(kbd);

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const exportNodes = [...html.matchAll(/data-export="([^"]+)"/g)].map((m) => {
    const el = makeElement('button');
    el.dataset.export = m[1];
    return el;
  });
  // 按标签扫描：id 之外还要记住这个标签上写没写 hidden / inert / disabled，
  // 否则「一开始浮层是关着的」这种事在桩里永远是 false，测出来的只是桩的形状。
  html.split('>').forEach((chunk) => {
    const id = chunk.match(/\sid="([^"]+)"/);
    if (!id) return;
    const el = byId(id[1]);
    if (/\shidden(\s|=|$)/.test(chunk)) el.hidden = true;
    if (/\sinert(\s|=|$)/.test(chunk)) el.setAttribute('inert', '');
    if (/\sdisabled(\s|=|$)/.test(chunk)) el.disabled = true;
  });

  const document = {
    readyState: 'complete',
    body: makeElement('body'),
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    addEventListener: () => {},
    querySelector: (sel) => (/^#/.test(sel) ? byId(sel.slice(1)) : null),
    querySelectorAll: (sel) => (sel === '[data-export]' ? exportNodes.slice() : []),
  };

  const storage = new Map();
  /**
   * 一个极小的 Cookie 罐子。
   * 为什么要它：登录态是 HttpOnly Cookie，而 Node 的 fetch 不会自动保存 ——
   * 不补这一层，「注册之后还是未登录」根本测不出来。
   */
  const jar = new Map();
  const applySetCookie = (lines) => {
    lines.forEach((line) => {
      const [pair, ...attrs] = String(line).split(';');
      const eq = pair.indexOf('=');
      if (eq < 0) return;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a));
      if (!value || expired) jar.delete(name);
      else jar.set(name, value);
    });
  };
  const cookieHeader = () => Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');

  const win = {
    document,
    location: { protocol: 'http:', href: base + '/' },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => void storage.set(k, String(v)),
      removeItem: (k) => void storage.delete(k),
    },
    confirm: () => true,
    scrollTo: () => {},
    setTimeout,
    clearTimeout,
    console,
    // 指到真服务端：relative URL 补上 base；顺手把登录态那张票带上
    fetch: async (url, init) => {
      const abs = /^https?:/.test(url) ? url : base + url;
      const options = Object.assign({}, init || {});
      const headers = new Headers(options.headers || {});
      const cookie = cookieHeader();
      if (cookie) headers.set('cookie', cookie);
      options.headers = headers;
      const res = await fetch(abs, options);
      const lines = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);
      applySetCookie(lines);
      return res;
    },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    Blob: function Blob() {},
    AbortController,
    TextDecoder,
    addEventListener: () => {},
  };
  win.window = win;

  win.URLSearchParams = URLSearchParams;
  win.URL = URL;
  win.Response = Response;
  win.Headers = Headers;
  win.Request = Request;
  win.TextEncoder = TextEncoder;
  win.structuredClone = (v) => v;

  const context = vm.createContext(win);
  for (const f of [
    'lib/modes.js',
    'lib/record.js',
    'lib/template.js',
    'lib/polisher.js',
    'lib/mock-writer.js',
    'lib/auth-rules.js',
    'js/core.js',
    'js/auth.js',
    'js/api.js',
    'js/app.js',
  ]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), context, { filename: f });
  }

  const errors = [];
  process.on('unhandledRejection', (err) => errors.push(String((err && err.stack) || err).split('\n').slice(0, 5).join('\n')));

  await new Promise((r) => setTimeout(r, 400));

  const nav = ids.get('modes');
  const label = () => (ids.get('material-label') || {})._text;
  const summary = () => (ids.get('param-summary') || {})._text;
  const tab = () => (ids.get('input-tab') || {})._text;
  const nodes = () => (nav.children || []).filter((c) => c.className === 'mode' || c.className === 'modes__sep');
  const click = (name) => {
    const btn = nodes().find((c) => collectText(c).includes(name) && c.className === 'mode');
    if (btn) btn.click();
    return Boolean(btn);
  };
  const active = () => {
    const hit = nodes().find((c) => c.className === 'mode' && c.attrs['aria-current'] === 'true');
    return hit ? collectText(hit) : '';
  };

  console.log('前端界面（对着真实服务端）');

  group('启动：导航列出全部板块，并按分组加了细线', () => {
    const texts = nodes().map((c) => collectText(c));
    ok(texts.some((x) => x.includes('文章续写')), '有「文章续写」');
    ok(texts.some((x) => x.includes('学术论文')), '有「学术论文」');
    ok(texts.some((x) => x.includes('小说创作')), '有「小说创作」');
    ok(texts.some((x) => x.includes('多语言翻译')), '有「多语言翻译」');
    ok(texts.some((x) => x.includes('产品周报')), '服务端上的自定义模板也进导航了');
    eq(nodes().filter((c) => c.className === 'modes__sep').length, 3, '三处分组细线');
    ok(collectText(nodes().find((c) => c.className === 'mode' && c.attrs['aria-current'] === 'true')).includes('文章续写'), '默认停在文章续写');
  });

  group('点击每个板块：稿签、素材框、参数摘要三处一起跟着变', () => {
    const expect = {
      小说创作: '故事设定 / 已有片段',
      多语言翻译: '待翻译原文',
      学术论文: '论文题目 / 研究内容',
      工作报告: '要汇报的事',
      内容改写: '待改写原文',
    };
    Object.keys(expect).forEach((name) => {
      ok(click(name), '导航里有「' + name + '」');
      eq(label(), expect[name], '点「' + name + '」后素材框标签变了');
      ok(summary().indexOf(name) === 0, '参数摘要以「' + name + '」开头：' + summary().slice(0, 24));
      ok(tab().indexOf(name) === 0, '稿签也写明了板块名：' + tab());
      ok(active().indexOf(name) >= 0, '高亮落在「' + name + '」上');
    });
  });

  group('点击自定义模板：切到那个模板的板块', () => {
    ok(click('产品周报'), '导航里有这个模板');
    eq(summary().slice(0, 4), '产品周报', '参数摘要换成了模板名');
    eq(label(), '素材', '素材字段用的是模板里定义的默认名');
    ok(tab().indexOf('产品周报') === 0, '稿签写的是模板名');
  });

  group('切回文章续写：稿签与标签都回到最初', () => {
    ok(click('文章续写'), '点回去');
    eq(label(), '原稿开头', '标签回到续写');
    eq(tab(), '文章续写 · 原稿', '稿签回到续写');
    eq(active(), '续文章续写', '高亮回到续写');
  });

  group('自定义模板的示例：不会空着，也不是别的板块的示例', () => {
    const chips = () => ((ids.get('drafts-examples') || {}).children || []).map((c) => c._text);
    click('产品周报');
    const texts = chips();
    ok(texts.length >= 1, '产品周报有空稿纸示例（不是一条都没有）');
    ok(texts[0].indexOf('进展') >= 0, '示例是从提示词推出来的结构：' + texts[0]);
    ok(texts[0].indexOf('示例结构') >= 0, '标明了这是结构骨架，不是现成材料');
    ok(!/文章续写|原稿开头/.test(texts.join('')), '不是拿续写或别的板块的示例凑数');

    click('小说创作');
    ok(chips().some((t) => t.indexOf('便利店') >= 0), '内置板块的示例照旧');
  });

  // ── 真实走一遍：起稿 → 换板块 → 换回来 → 优化 ────────────
  const box = () => ids.get('material');
  const typeIn = (text) => {
    const el = box();
    el.value = text;
    (el._events.input || []).forEach((fn) => fn({ target: el }));
  };
  const drafts = () => findAll(ids.get('drafts'), '.draft');
  const draftText = (card) => collectText(findOne(card, '.draft__text'));
  const waitFor = async (fn, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (fn()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };
  const firstDraft = () => drafts()[0];

  await agroup('起稿：点一下真的出稿（离线引擎）', async () => {
    click('文章续写');
    typeIn('周五的复盘会上，产品经理把用户反馈一条条念了出来。念到第七条时，会议室安静了。');
    ids.get('generate').click();
    const okDone = await waitFor(() => drafts().length > 0 && draftText(firstDraft()).length > 40);
    ok(okDone, '稿片区出现了成稿');
    ok(collectText(firstDraft()).indexOf('第一稿') >= 0, '稿签写着第一稿：' + collectText(firstDraft()).slice(0, 12));
    ok(/\d+ 稿/.test(summary()), '参数摘要标了这一批几稿：' + summary());
    // 栏宽跟着稿数走：3 稿 → data-count=3（CSS 据此分成三栏）
    eq(ids.get('drafts').dataset.count, String(drafts().length), '稿数写进了 data-count（' + ids.get('drafts').dataset.count + '）');
    eq(drafts().length, 3, '默认出三稿');
  });

  await agroup('换板块：上一个板块的原稿与成稿都不跟过来', async () => {
    click('内容改写');
    eq(box().value, '', '新板块的原稿是空的（没带上续写那段）');
    eq(drafts().length, 0, '稿片区也是空的（没挂着续写的稿片）');
    eq(ids.get('drafts').dataset.count, '0', '没有稿子时 data-count 是 0（栏宽回到一栏）');
    typeIn('本公司产品具有性能稳定、操作便捷的特点。');
    eq(box().value, '本公司产品具有性能稳定、操作便捷的特点。', '在新板块里能正常写东西');
  });

  await agroup('一稿就占满：把「一次几稿」调成一，data-count 跟着变成 1', async () => {
    // 参数栏里「一次几稿」的第一颗按钮 = 一稿
    const one = findAll(ids.get('ctl-versions'), '.chip').find((b) => collectText(b) === '一');
    ok(one, '参数栏里有「一」这颗按钮');
    one.click();
    ok(summary().indexOf('1 稿') >= 0, '参数摘要说这一批 1 稿：' + summary().slice(0, 24));
    ids.get('generate').click();
    const done = await waitFor(() => drafts().length === 1 && draftText(firstDraft()).length > 5);
    ok(done, '只出了一稿（' + drafts().length + ' 稿，' + draftText(firstDraft()).length + ' 字）');
    eq(ids.get('drafts').dataset.count, '1', 'data-count 是 1（CSS 据此让这张稿纸占满整行）');

    // 调回三稿，栏数跟着回去
    const three = findAll(ids.get('ctl-versions'), '.chip').find((b) => collectText(b) === '三');
    if (three) three.click();
    ids.get('generate').click();
    ok(await waitFor(() => drafts().length === 3), '三稿并排又回来了');
    eq(ids.get('drafts').dataset.count, '3', 'data-count 回到 3');
  });

  await agroup('四稿是 2×2：栏数是两栏，不是四栏', async () => {
    const four = findAll(ids.get('ctl-versions'), '.chip').find((b) => collectText(b) === '四');
    ok(four, '参数栏里有「四」这颗按钮');
    if (four) four.click();
    ids.get('generate').click();
    ok(await waitFor(() => drafts().length === 4), '出了四稿');
    eq(ids.get('drafts').dataset.count, '4', 'data-count 是 4');
    // 稿数是 4，但 CSS 里给的是两栏 —— 两行两列，每张稿纸占一半宽
    const css = fs.readFileSync(path.join(ROOT, 'css/styles.css'), 'utf8');
    const rule = (css.match(/\.drafts\[data-count="4"\] \{[^}]*\}/) || [''])[0];
    ok(/repeat\(2, minmax\(0, 1fr\)\)/.test(rule), '四稿在样式表里是 repeat(2, …)：' + rule.replace(/\s+/g, ' ').slice(0, 60));
  });

  await agroup('换回去：续写那份原稿与成稿原样还在', async () => {
    click('文章续写');
    ok(box().value.indexOf('复盘会') >= 0, '续写的原稿回来了');
    eq(drafts().length, 3, '续写的三稿都回来了');
    ok(draftText(firstDraft()).length > 40, '成稿正文还在');

    click('内容改写');
    eq(box().value, '本公司产品具有性能稳定、操作便捷的特点。', '改写那份没被续写覆盖');
    click('产品周报');
    eq(box().value, '', '自定义模板板块也是独立的一份');
    typeIn('进展：这周上线了新版搜索。');
    click('内容改写');
    eq(box().value, '本公司产品具有性能稳定、操作便捷的特点。', '切走一趟再回来，改写那份还在');
    click('文章续写');
    eq(drafts().length, 3, '续写的三稿仍然在');
  });

  await agroup('一键优化：朱批面板出得来（离线校对）', async () => {
    ok(click('文章续写'), '回到续写');
    const polishBtn = findAll(firstDraft(), '[data-act]').find((b) => b.dataset.act === 'polish');
    ok(polishBtn, '稿片上有「一键优化」按钮');
    polishBtn.click();
    const shown = await waitFor(() => ids.get('polish').hidden === false);
    ok(shown, '朱批面板显示了');
    ok(collectText(ids.get('polish-notes')).length > 0, '批注清单里有内容');
    ok((ids.get('polish-summary')._text || '').length > 0, '摘要说了几处改动：' + (ids.get('polish-summary')._text || '').slice(0, 30));
  });

  await agroup('成稿自动进留档：抽屉计数不为 0', async () => {
    const count = Number((ids.get('history-count')._text || '0')) || 0;
    ok(count >= 1, '留档里已经有稿子了（' + count + ' 篇）');
  });

  await agroup('对比两稿：面板能开，改动清单出得来', async () => {
    ids.get('open-compare').click();
    eq(ids.get('compare').hidden, false, '对比面板显示了');
    ok((ids.get('compare-summary')._text || '').length > 0, '摘要给出了差异：' + (ids.get('compare-summary')._text || '').slice(0, 40));
    ok((findAll(ids.get('compare-changes'), 'li') || []).length >= 1, '改动清单里有条目');
  });

  // ── 账号：登录、留档按人分开、认领、退出 ──────────────────
  const accountSignin = () => ids.get('account-signin');
  const accountSelf = () => ids.get('account-self');
  const historyCount = () => Number(ids.get('history-count')._text || '0') || 0;
  let recoveryCode = '';

  await agroup('登录浮层：点「登录 / 注册」打开，能切到注册', async () => {
    eq(ids.get('auth-overlay').hidden, true, '一开始浮层是藏着的');
    accountSignin().click();
    eq(ids.get('auth-overlay').hidden, false, '点一下打开了');
    eq(ids.get('auth-title')._text, '登录', '默认停在登录');
    ids.get('auth-tab-register').click();
    eq(ids.get('auth-title')._text, '注册', '切到注册');
    eq(ids.get('auth-confirm-field').hidden, false, '注册要输两遍密码');
    ids.get('auth-cancel').click();
    eq(ids.get('auth-overlay').hidden, true, '取消就关掉，什么都没改');
  });

  await agroup('注册：报头换成账号，留档立刻按这个账号算', async () => {
    const before = historyCount();
    ok(before >= 1, '注册前，没登录那一桶里有 ' + before + ' 篇');
    accountSignin().click();
    ids.get('auth-tab-register').click();
    ids.get('auth-name').value = '三易测试员';
    ids.get('auth-password').value = 'test-pass-2024';
    ids.get('auth-confirm').value = 'test-pass-2024';
    ids.get('auth-submit').click();
    const done = await waitFor(() => accountSelf().hidden === false);
    ok(done, '注册成功：报头出现了账号');
    eq(ids.get('account-name')._text, '三易测试员', '名字显示出来了');
    // 恢复码只出现这一次 → 注册之后浮层不关，先把这串码摆出来
    eq(ids.get('auth-code-shown').hidden, false, '停在「恢复码」那一屏');
    recoveryCode = ids.get('auth-code-value')._text || '';
    ok(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(recoveryCode), '恢复码是 ABCD-EFGH-JKMN 这样：' + recoveryCode);
    eq(ids.get('auth-actions').hidden, true, '那一屏只剩「抄好了」，没有别的按钮');
    ids.get('auth-code-done').click();
    eq(ids.get('auth-overlay').hidden, true, '点「抄好了」浮层才关');
    ok(
      String(ids.get('account-avatar').attrs['aria-label'] || '').indexOf('三易测试员') === 0,
      '头像画出来了：' + ids.get('account-avatar').attrs['aria-label']
    );
    await waitFor(() => historyCount() === 0);
    eq(historyCount(), 0, '新账号看到的是自己的留档：0 篇');
  });

  await agroup('认领：把「没登录时写的」接到这个账号名下', async () => {
    const text = () => collectText(ids.get('history-list'));
    ok(text().indexOf('本地模式') >= 0, '抽屉里说清了本地还有几篇：' + text().slice(0, 40));
    const btn = findAll(ids.get('history-list'), 'button').find((b) => collectText(b).indexOf('认领') >= 0);
    ok(Boolean(btn), '有一个「认领到这个账号」按钮');
    if (btn) btn.click();
    const claimed = await waitFor(() => historyCount() >= 1);
    ok(claimed, '认领之后留档回来了（' + historyCount() + ' 篇）');
  });

  await agroup('退出登录：账号没了，稿子跟着账号走', async () => {
    accountSelf().click();
    eq(ids.get('account-menu').hidden, false, '点账号打开菜单');
    ids.get('account-logout').click();
    const out = await waitFor(() => accountSignin().hidden === false);
    ok(out, '退出了：报头又是「登录 / 注册」');
    eq(accountSelf().hidden, true, '账号块收起来了');
    eq(ids.get('account-name')._text, '', '名字清掉了');
    // 认领过的稿子已经归账号，没登录那一桶现在是空的 —— 这正是「按人分开」的意思
    await waitFor(() => historyCount() === 0);
    eq(historyCount(), 0, '没登录那一桶现在是空的：稿子跟着账号走了');
  });

  await agroup('登录：密码错了不放行，对了就回到自己的留档', async () => {
    accountSignin().click();
    ids.get('auth-name').value = '三易测试员';
    ids.get('auth-password').value = 'wrong-password';
    ids.get('auth-submit').click();
    const failed = await waitFor(() => ids.get('auth-error').hidden === false);
    ok(failed, '密码不对时说一句：' + ids.get('auth-error')._text);
    eq(accountSelf().hidden, true, '没放进去：报头还是「登录 / 注册」');

    ids.get('auth-password').value = 'test-pass-2024';
    ids.get('auth-submit').click();
    const back = await waitFor(() => accountSelf().hidden === false);
    ok(back, '密码对了就登上了');
    await waitFor(() => historyCount() >= 1);
    ok(historyCount() >= 1, '这个账号的留档还在（' + historyCount() + ' 篇）');
  });

  await agroup('最近登录过的账号：退出之后再登录，名字点一下就填上', async () => {
    accountSelf().click();
    ids.get('account-logout').click();
    ok(await waitFor(() => accountSignin().hidden === false), '先退出登录');

    accountSignin().click();
    eq(ids.get('auth-recent').hidden, false, '登录框下面列出了最近登录过的账号');
    const chips = (ids.get('auth-recent').children || []).map((c) => collectText(c));
    ok(chips.indexOf('三易测试员') >= 0, '刚才那个名字在列表里：' + chips.join('、'));
    const chip = (ids.get('auth-recent').children || []).find((c) => collectText(c).indexOf('三易测试员') >= 0);
    if (chip) chip.click();
    eq(ids.get('auth-name').value, '三易测试员', '点一下就填好了名字');

    ids.get('auth-password').value = 'test-pass-2024';
    ids.get('auth-submit').click();
    ok(await waitFor(() => accountSelf().hidden === false), '只需要再打一次密码就登进去了');
  });

  await agroup('改名字：只露一个「新名字」框，不要密码', async () => {
    accountSelf().click();
    ids.get('account-rename').click();
    eq(ids.get('auth-title')._text, '改名字', '标题是「改名字」');
    eq(ids.get('auth-name-field').hidden, false, '名字框露着');
    eq(ids.get('auth-password-field').hidden, true, '密码框藏着（改名字不要密码）');
    eq(ids.get('auth-name-label')._text, '新名字', '标签写的是「新名字」');
    ids.get('auth-name').value = '改过的名字';
    ids.get('auth-submit').click();
    const renamed = await waitFor(() => ids.get('account-name')._text === '改过的名字');
    ok(renamed, '报头上的名字跟着换了：' + ids.get('account-name')._text);
  });

  await agroup('换头像：格子点一个 emoji，保存后头像跟着换', async () => {
    accountSelf().click();
    ids.get('account-avatar-edit').click();
    eq(ids.get('avatar-overlay').hidden, false, '头像浮层打开了');
    const grid = ids.get('avatar-grid');
    eq((grid.children || []).length, 20, '有 20 个 emoji 可选');
    const pick = grid.children[2];
    pick.click();
    eq(findAll(grid, '.avatar-choice--on').length, 1, '选中的只有一个');
    ids.get('avatar-save').click();
    const saved = await waitFor(() => ids.get('avatar-overlay').hidden === true);
    ok(saved, '保存之后浮层自己关了');
    ok(
      String(ids.get('account-avatar').attrs['aria-label'] || '').indexOf('emoji') >= 0,
      '报头上的头像换成了 emoji：' + ids.get('account-avatar').attrs['aria-label']
    );
  });

  await agroup('忘了密码：用恢复码重置，重置完直接登进去', async () => {
    // 先退出来，模拟「密码忘了、人在登录框前」
    accountSelf().click();
    ids.get('account-logout').click();
    ok(await waitFor(() => accountSignin().hidden === false), '已退出登录');

    accountSignin().click();
    eq(ids.get('auth-forgot').hidden, false, '登录框下面有「忘了密码？」');
    ids.get('auth-forget').click();
    eq(ids.get('auth-title')._text, '用恢复码重置密码', '切到找回密码那一屏');
    eq(ids.get('auth-code-field').hidden, false, '多了一个「恢复码」框');
    eq(ids.get('auth-new-field').hidden, false, '还要填新密码');

    // 输错恢复码：当场拦住，不发请求
    ids.get('auth-name').value = '改过的名字';
    ids.get('auth-code').value = 'AAAA-AAAA-AAAA';
    ids.get('auth-new').value = 'reset-pass-2025';
    ids.get('auth-confirm').value = 'reset-pass-2025';
    ids.get('auth-submit').click();
    ok(await waitFor(() => ids.get('auth-error').hidden === false), '错码被服务端挡回来：' + (ids.get('auth-error')._text || ''));
    eq(accountSelf().hidden, true, '没放进去');

    // 换成真码
    ids.get('auth-code').value = recoveryCode;
    ids.get('auth-submit').click();
    ok(await waitFor(() => accountSelf().hidden === false), '恢复码对了就重置并登录');
    eq(ids.get('auth-code-shown').hidden, false, '重置完同样把新的恢复码摆出来');
    const fresh = ids.get('auth-code-value')._text || '';
    ok(fresh && fresh !== recoveryCode, '恢复码换了一把新的：' + fresh);
    ids.get('auth-code-done').click();
    eq(ids.get('auth-overlay').hidden, true, '看完就关');
    await waitFor(() => historyCount() >= 1);
    ok(historyCount() >= 1, '留档一篇没丢（' + historyCount() + ' 篇）');
  });

  console.log('\n通过 ' + pass + '/' + (pass + failures.length));
  if (failures.length) {
    console.log('\n失败项：');
    failures.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
    process.exitCode = 1;
  }

  await app.close();
  await fs.promises.rm(process.env.WA_DATA_DIR, { recursive: true, force: true }).catch(() => {});
})();
