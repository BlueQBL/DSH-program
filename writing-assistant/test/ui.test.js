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
  [...html.matchAll(/id="([^"]+)"/g)].forEach((m) => byId(m[1]));

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
    // 指到真服务端：relative URL 补上 base
    fetch: (url, init) => fetch(/^https?:/.test(url) ? url : base + url, init),
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
  for (const f of ['lib/modes.js', 'lib/record.js', 'lib/template.js', 'lib/polisher.js', 'lib/mock-writer.js', 'js/core.js', 'js/api.js', 'js/app.js']) {
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
  });

  await agroup('换板块：上一个板块的原稿与成稿都不跟过来', async () => {
    click('内容改写');
    eq(box().value, '', '新板块的原稿是空的（没带上续写那段）');
    eq(drafts().length, 0, '稿片区也是空的（没挂着续写的稿片）');
    typeIn('本公司产品具有性能稳定、操作便捷的特点。');
    eq(box().value, '本公司产品具有性能稳定、操作便捷的特点。', '在新板块里能正常写东西');
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

  console.log('\n通过 ' + pass + '/' + (pass + failures.length));
  if (failures.length) {
    console.log('\n失败项：');
    failures.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
    process.exitCode = 1;
  }

  await app.close();
  await fs.promises.rm(process.env.WA_DATA_DIR, { recursive: true, force: true }).catch(() => {});
})();
