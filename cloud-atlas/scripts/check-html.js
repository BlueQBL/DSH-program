/* 页面结构自检：标签配平、id 齐全、脚本引用的元素都存在
 *
 * 用法：node scripts/check-html.js
 *
 * 为什么需要它：改版式时最容易出的错是少写一个闭合标签或者改了个 id，
 * 浏览器会默默地把后面的内容吞进错误的位置，页面看起来"还在"，
 * 但某个区块整段消失或者跑到别处——而这种问题靠肉眼看 HTML 很难发现。
 *
 * 做三件事：
 *   1. 主要容器标签开闭配平；
 *   2. app.js 里 getElementById 用到的 id 在 HTML 里都存在；
 *   3. HTML 里出现的 id 没有重复。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
const probe = fs.readFileSync(path.join(ROOT, 'js', 'verify-probe.js'), 'utf8');

let problems = 0;
const fail = (msg) => { console.log('× ' + msg); problems++; };

/* --- 1. 标签配平 --- */
const TAGS = ['section', 'article', 'aside', 'main', 'header', 'footer', 'div', 'details', 'figure', 'ul', 'ol', 'table', 'form', 'button', 'p', 'span', 'label', 'li', 'svg', 'text', 'g'];
for (const tag of TAGS) {
  const open = (html.match(new RegExp(`<${tag}\\b[^>]*>`, 'g')) || []).length;
  // 自闭合写法 <tag ... /> 也要算上
  const selfClose = (html.match(new RegExp(`<${tag}\\b[^>]*/>`, 'g')) || []).length;
  const close = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
  if (open - selfClose !== close) {
    fail(`<${tag}> 开 ${open - selfClose} 个、闭 ${close} 个，不配平`);
  }
}

/* --- 2. id 唯一 --- */
const ids = Array.from(html.matchAll(/\sid="([^"]+)"/g)).map((m) => m[1]);
const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dup.length) fail('id 重复：' + Array.from(new Set(dup)).join(', '));

/* --- 3. app.js 与自检探针里用到的 id 都要存在 --- */
const used = Array.from(app.matchAll(/\$\('([^']+)'\)/g)).map((m) => m[1]);
const missing = Array.from(new Set(used)).filter((id) => !ids.includes(id));
if (missing.length) fail('app.js 引用了 HTML 里不存在的 id：' + missing.join(', '));

/* 探针也要查。它读的元素一旦被改名或删掉，自检会开始报一堆"找不到元素"，
   那会掩盖真正的问题——所以让这个检查在这里就拦住。 */
const probeIds = Array.from(probe.matchAll(/querySelector(?:All)?\('#([\w-]+)/g)).map((m) => m[1]);
const probeClasses = Array.from(probe.matchAll(/querySelector(?:All)?\('\.([\w-]+)/g)).map((m) => m[1]);
const missingProbe = Array.from(new Set(probeIds)).filter((id) => !ids.includes(id));
if (missingProbe.length) fail('自检探针引用了 HTML 里不存在的 id：' + missingProbe.join(', '));

/* 探针里用到的类名：可能在样式表里而不在 HTML 里（由 JS 生成），
   所以只检查"有没有在任何一处定义过"，避免误报。 */
const css = fs.readFileSync(path.join(ROOT, 'css', 'styles.css'), 'utf8');
const unknownClasses = Array.from(new Set(probeClasses)).filter((cls) => (
  !html.includes(cls) && !app.includes(cls) && !css.includes(cls)
));
if (unknownClasses.length) fail('自检探针引用了没在任何地方出现的类名：' + unknownClasses.join(', '));

/* --- 4. 关键区块必须都在（防止改版式时整块删掉） --- */
const REQUIRED = [
  'seek-input', 'seek-list', 'locate-btn', 'saved-list', 'place-name', 'temp-now',
  'instr', 'm-humidity', 'm-wind', 'm-pressure', 'm-pop',
  'm-aqi', 'cell-aqi', 'aqi-scale', 'm-aqi-primary', 'air-detail', 'air-list',
  'm-uv', 'm-uv-word',
  'alerts', 'alerts-list',
  'plotbox', 'rb-time', 'rb-temp',
  'week-panel', 'week', 'week-scale', 'daybox',
  'compare-panel', 'compare', 'compare-chart', 'compare-table', 'compare-legend',
  'cmp-input', 'cmp-list', 'cmp-note', 'cmp-chips', 'cmp-form',
  'history-panel', 'history', 'history-stats', 'history-plot', 'history-compose', 'history-reading',
  'history-ranges', 'custom-range', 'hist-start', 'hist-end', 'hist-go',
];
for (const id of REQUIRED) {
  if (!ids.includes(id)) fail('缺少必需的元素 id：' + id);
}

/* --- 5. 脚本都要被引入 --- */
for (const src of ['js/core.js', 'js/aqi.js', 'js/alerts.js', 'js/icons.js', 'js/chart.js', 'js/app.js']) {
  if (!html.includes(`src="${src}"`)) fail('index.html 没有引入 ' + src);
}

/* --- 6. 首页不该出现模板占位符或未翻译的标记 --- */
for (const bad of ['TODO', 'FIXME', 'XXX', 'undefined']) {
  if (new RegExp(`>\\s*${bad}\\s*<`).test(html)) fail('页面里出现了 ' + bad);
}

console.log(problems === 0
  ? `页面结构自检通过：${ids.length} 个 id 唯一，标签配平，app.js 引用的元素齐全。`
  : `页面结构自检失败：${problems} 处。`);
process.exit(problems === 0 ? 0 : 1);
