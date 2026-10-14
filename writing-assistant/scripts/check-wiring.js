/* 接线检查：把「界面三个文件之间对得上吗」这件事交给机器。
 *
 * 用法：node scripts/check-wiring.js
 *
 * 为什么需要：原生前端最容易出的错不是逻辑，而是名字对不上——
 * app.js 里 $('#generete') 少一个字母、CSS 里 --rule-h 忘了定义、
 * script 标签顺序错了导致 window.WriterCore 是 undefined。
 * 这些错在浏览器里表现为「点了没反应」，排查起来很烦，静态查一遍最省事。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const html = read('index.html');
const css = read('css/styles.css');
const app = read('js/app.js');
const core = read('js/core.js');
const api = read('js/api.js');
const scripts = [html, css, app, core, api];

let pass = 0;
const failures = [];

function ok(value, label) {
  if (value) pass += 1;
  else failures.push(label);
}

function group(name, fn) {
  const before = failures.length;
  fn();
  console.log(`  ${failures.length === before ? '✓' : '✗'} ${name}`);
}

const uniq = (list) => Array.from(new Set(list));
const matchAll = (text, re) => {
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
};

console.log('界面接线检查');

group('index.html 里的 id 不重复', () => {
  const ids = matchAll(html, /\sid="([^"]+)"/g);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  ok(dup.length === 0, `重复的 id：${uniq(dup).join('、')}`);
  ok(ids.length > 20, '页面上的 id 数量正常（说明结构没被截断）');
});

group('app.js 取的每个 id 在 index.html 里都存在', () => {
  const wanted = uniq(matchAll(app, /\$\('#([A-Za-z0-9_-]+)'\)/g));
  const missing = wanted.filter((id) => !new RegExp(`\\sid="${id}"`).test(html));
  ok(wanted.length > 15, `检查到 ${wanted.length} 个 id`);
  ok(missing.length === 0, `app.js 取了不存在的 id：${missing.join('、')}`);
});

group('app.js 取的每个 id 都进了 dom 缓存（避免重复查询与拼错）', () => {
  const wanted = uniq(matchAll(app, /\$\('#([A-Za-z0-9_-]+)'\)/g));
  const cached = uniq(matchAll(app, /dom\.[A-Za-z0-9_]+ = \$\('#([A-Za-z0-9_-]+)'\)/g));
  const strays = wanted.filter((id) => !cached.includes(id));
  ok(strays.length === 0, `没进缓存的 id：${strays.join('、')}`);
});

group('app.js 里用到的 class 都在样式表里有定义', () => {
  const used = uniq([
    ...matchAll(app, /class: '([^']+)'/g),
    ...matchAll(app, /class: "([^"]+)"/g),
    ...matchAll(html, /\sclass="([^"]+)"/g),
  ])
    .flatMap((v) => v.split(/\s+/))
    .filter(Boolean);
  const dynamic = new Set(['draft--adopted', 'draft--failed', 'drafts--empty', 'btn--stop', 'mark-prop--insert', 'annotation__btn']);
  const missing = used.filter((cls) => !dynamic.has(cls) && !css.includes('.' + cls));
  ok(used.length > 40, `检查到 ${used.length} 个 class`);
  ok(missing.length === 0, `样式表里没有的 class：${uniq(missing).join('、')}`);
});

group('样式表用的每个 CSS 变量都定义过', () => {
  const defined = new Set(matchAll(css, /^\s*(--[a-z0-9-]+):/gm));
  const used = uniq(matchAll(css, /var\((--[a-z0-9-]+)/g));
  const missing = used.filter((name) => !defined.has(name));
  ok(defined.size > 15, `定义了 ${defined.size} 个变量`);
  ok(missing.length === 0, `用了没定义的变量：${missing.join('、')}`);
});

group('script 标签按依赖顺序、且文件都在', () => {
  const srcs = matchAll(html, /<script src="([^"]+)"><\/script>/g);
  const expected = ['lib/modes.js', 'lib/record.js', 'lib/polisher.js', 'lib/mock-writer.js', 'js/core.js', 'js/api.js', 'js/app.js'];
  ok(JSON.stringify(srcs) === JSON.stringify(expected), `script 顺序是 ${srcs.join(' → ')}`);
  const missing = srcs.filter((src) => !fs.existsSync(path.join(ROOT, src)));
  ok(missing.length === 0, `缺文件：${missing.join('、')}`);
});

group('样式表与脚本引用的静态资源都存在', () => {
  const links = matchAll(html, /<link rel="stylesheet" href="([^"]+)"/g);
  const missing = links.filter((href) => !fs.existsSync(path.join(ROOT, href)));
  ok(missing.length === 0, `缺样式文件：${missing.join('、')}`);
  ok(links.length === 1, '只引了一个样式表');
});

group('CSS 大括号配平、没有明显的书写事故', () => {
  const open = (css.match(/{/g) || []).length;
  const close = (css.match(/}/g) || []).length;
  ok(open === close, `大括号不配平：{ ${open} 个，} ${close} 个`);
  ok(!/;;/.test(css), '没有连续两个分号');
  ok(!/:\s*;/.test(css), '没有空属性值');
});

group('界面上的每个动作按钮都接上了处理函数', () => {
  // 稿片上的动作：列表里声明，onDraftAction 里分发，两边必须一字不差
  const declared = uniq(matchAll(app, /\{ id: '([a-z]+)', label: /g));
  const branches = uniq(matchAll(app, /act === '([a-z]+)'/g));
  ok(declared.length >= 4, `稿片上有 ${declared.length} 个动作`);
  const dangling = declared.filter((a) => !branches.includes(a));
  ok(dangling.length === 0, `没有处理分支的动作：${dangling.join('、')}`);

  // 朱批条目的按钮：靠 dataset.act 分发，同样要能对上
  const annotated = uniq(matchAll(app, /dataset: \{ act: '([a-z]+)'/g));
  const missing = annotated.filter((a) => !branches.includes(a));
  ok(annotated.length >= 2, `朱批上有 ${annotated.length} 个动作`);
  ok(missing.length === 0, `朱批动作没有处理分支：${missing.join('、')}`);

  const buttons = ['polish-accept-all', 'polish-revert-all', 'polish-copy', 'polish-close', 'generate', 'polish-input', 'open-history', 'close-history', 'clear-history'];
  const orphan = buttons.filter((id) => !new RegExp(`dom\\.[A-Za-z0-9_]+ = \\$\\('#${id}'\\)`).test(app) || !app.includes(`dom.${idToCamel(id)}`));
  ok(orphan.length === 0, `没接事件的按钮：${orphan.join('、')}`);
});

function idToCamel(id) {
  const parts = id.split('-');
  return parts[0] + parts.slice(1).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

group('所有用户可见的文字都走 DOM 节点（不拼 innerHTML）', () => {
  scripts.forEach((text) => {
    ok(!/\.innerHTML\s*=/.test(text), '不该给 innerHTML 赋值');
    ok(!/insertAdjacentHTML/.test(text), '不该用 insertAdjacentHTML');
  });
  ok(!/document\.write/.test(app), '不用 document.write');
});

group('没有留下调试残留', () => {
  scripts.forEach((text) => {
    ok(!/\bdebugger\b/.test(text), '不该留 debugger');
    ok(!/console\.log\(/.test(text), '不该留 console.log');
  });
  ok(!/TODO|FIXME|XXX/.test(html + css + app + core + api), '不该留 TODO/FIXME');
});

group('中文排版：标点与空格没有明显问题', () => {
  const sources = { html, css, app, core, api };
  Object.keys(sources).forEach((name) => {
    const text = sources[name];
    // 中文之间的半角逗号句号多半是手滑
    ok(!/[\u4e00-\u9fa5],[\u4e00-\u9fa5]/.test(text), `${name}：中文里混了半角逗号`);
    ok(!/[\u4e00-\u9fa5]\.[\u4e00-\u9fa5]/.test(text), `${name}：中文里混了半角句号`);
    ok(!/[\u4e00-\u9fa5]\?/.test(text), `${name}：中文里混了半角问号`);
  });
});

const total = pass + failures.length;
console.log(`\n通过 ${pass}/${total}`);
if (failures.length) {
  console.log('\n问题：');
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exitCode = 1;
}
