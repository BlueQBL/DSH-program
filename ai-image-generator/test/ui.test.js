'use strict';

/**
 * 界面的「接线」测试。
 *
 * 页面错误在源码里读不出来，但有一类错误能读出来：**接错了**。
 * app.js 里 $('#foo') 指的是一个 HTML 里不存在的 id、用到的样式类没写、
 * 调了 api.js 里没有的函数 —— 这些都会在用户面前变成「点了没反应」。
 * 所以这里把三份文件的约定对齐检查一遍。
 *
 * 运行：node test/ui.test.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { eq, ok, not, has, group, report } = require('./harness.js');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const html = read('public/index.html');
const css = read('public/css/styles.css');
const appJs = read('public/js/app.js');
const apiJs = read('public/js/api.js');

function idsInHtml() {
  const ids = new Set();
  for (const m of html.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);
  return ids;
}

function idsUsedInApp() {
  const used = new Set();
  for (const m of appJs.matchAll(/\$\('#([A-Za-z0-9_-]+)'/g)) used.add(m[1]);
  for (const m of appJs.matchAll(/\$\$\('#([A-Za-z0-9_-]+)/g)) used.add(m[1]);
  return used;
}

(async function main() {
  console.log('DOM 接线');

  await group('app.js 用到的每个 id，HTML 里都有', () => {
    const ids = idsInHtml();
    const missing = [...idsUsedInApp()].filter((id) => !ids.has(id));
    eq(missing, [], '没有指空的 id');
    ok(idsUsedInApp().size > 20, `确实在用一批 id（${idsUsedInApp().size} 个）`);
  });

  await group('HTML 里几个关键的控件都在', () => {
    const ids = idsInHtml();
    ['prompt', 'optimize', 'generate', 'model-select', 'verify-model', 'ratio-group', 'style-group', 'quality-group', 'frames', 'empty', 'history-drawer', 'history-list', 'viewer', 'toast'].forEach(
      (id) => ok(ids.has(id), `#${id} 在`)
    );
  });

  await group('无障碍的基本件：lang / viewport / 焦点可见 / noscript', () => {
    has(html, 'lang="zh-CN"', '声明了中文');
    has(html, 'name="viewport"', '有 viewport');
    has(html, '<noscript>', '有 noscript 兜底');
    has(css, ':focus-visible', '键盘焦点有可见描边');
    has(css, 'prefers-reduced-motion', '尊重「减少动态效果」');
    const labels = [...html.matchAll(/<label[^>]*for="([^"]+)"/g)].map((m) => m[1]);
    ok(labels.includes('prompt'), '描述框有 label');
    ok(labels.includes('model-select'), '模型下拉有 label');
  });

  console.log('取数层接线');

  await group('app.js 调用的接口，api.js 里都定义了', () => {
    const apiNames = new Set();
    for (const m of apiJs.matchAll(/^\s{4}([a-zA-Z]+)\s*[:(]/gm)) apiNames.add(m[1]);
    for (const m of apiJs.matchAll(/^\s{6}([a-zA-Z]+)\(/gm)) apiNames.add(m[1]);
    const used = new Set();
    for (const m of appJs.matchAll(/\bApi\.([a-zA-Z]+)/g)) used.add(m[1]);
    const missing = [...used].filter((name) => !apiNames.has(name));
    eq(missing, [], '没有调用不存在的接口');
    ok(used.has('generate') && used.has('models') && used.has('optimize'), '出图 / 模型 / 优化三个主要接口都在用');
  });

  await group('接口路径与后端对得上', () => {
    has(apiJs, '/api/images/generate', '出图接口');
    has(apiJs, '/api/models', '模型接口');
    has(apiJs, '/api/prompt/optimize', '优化提示词接口');
    has(apiJs, '/api/history', '历史接口');
    has(apiJs, '/download', '下载接口');
    has(apiJs, 'encodeURIComponent', '拼 id 时做了编码');
    const server = read('server.js');
    has(server, "'/api/images/generate'", '服务端有出图路由');
    has(server, "'/api/prompt/optimize'", '服务端有优化提示词路由');
    has(server, 'action === \'download\'', '服务端有下载分支');
  });

  console.log('样式接线');

  await group('app.js 会生成的类名，样式里都有', () => {
    const classes = [
      'frame',
      'frame__perf',
      'frame__body',
      'frame__head',
      'frame__plate',
      'frame__engine',
      'frame__image',
      'frame__prompt',
      'frame__meta',
      'frame__note',
      'frame__actions',
      'frame--fresh',
      'frame--developing',
      'develop',
      'develop__sweep',
      'develop__label',
      'chip',
      'chip__meta',
      'seg',
      'hist',
      'hist__thumb',
      'hist__body',
      'hist__prompt',
      'hist__meta',
      'hist__actions',
      'toast',
      'toast--error',
      'toast--ok',
      'note--warn',
      'note--error',
      'note--ok',
      'pill--live',
      'pill--offline',
      'model__line',
      'size-preview',
    ];
    const missing = classes.filter((name) => !new RegExp('\\.' + name.replace(/[-_]/g, '[-_]') + '\\b').test(css));
    eq(missing, [], '没有漏写的样式');
  });

  await group('版面上那几个关键结构确实存在（相纸 / 齿孔 / 曝光台 / 抽屉 / 看大图）', () => {
    has(html, 'class="console"', '曝光台');
    has(html, 'class="sheet"', '相纸区');
    has(html, 'class="drawer"', '历史抽屉');
    has(html, 'class="viewer"', '看大图');
    has(css, 'repeating-linear-gradient', '齿孔 / 纸面纹理是渐变画出来的（没有外部图片依赖）');
    has(css, '--p700', '普鲁士蓝是变量，不是散落的硬编码色值');
  });

  console.log('安全与卫生');

  await group('前端里没有写死的 Key，脚本都是外链（没有内联事件）', () => {
    [html, appJs, apiJs, css].forEach((text, i) => {
      const label = ['index.html', 'app.js', 'api.js', 'styles.css'][i];
      ok(!/\bsk-[A-Za-z0-9_-]{16,}/.test(text), `${label} 里没有 sk- 密钥`);
      ok(!/\bhk-[A-Za-z0-9]{16,}/.test(text), `${label} 里没有 hk- 密钥`);
    });
    not(/\son[a-z]+\s*=\s*"/i.test(html), '没有 onclick= 这类内联事件');
    const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    eq(scripts, ['/lib/styles.js', '/js/api.js', '/js/app.js'], '三个外链脚本，顺序对（共用模块最先）');
  });

  await group('页面不会去猜服务端逻辑（尺寸 / 提示词都以后端返回为准）', () => {
    has(appJs, 'Api.generate(', '出图走后端接口');
    ok(!appJs.includes('IMAGE_PREFERRED'), '没有把模型筛选规则复制到前端');
    ok(!appJs.includes('KNOWN_IMAGE_MODELS'), '也没有把兜底模型清单抄一份到前端');
    has(appJs, 'state.modelId || undefined', '模型是「选了才传」，让后端决定默认');
  });

  await group('尺寸表 / 提示词拼法是前后端同一份（styles.js 直接给浏览器用）', () => {
    has(html, '<script src="/lib/styles.js"></script>', '页面加载了共用的 styles.js');
    has(appJs, 'window.LanShaiStyles', '从共用模块取');
    has(appJs, 'Styles.listPresets()', '预设也来自共用模块，不跟后端要第二份');
    has(appJs, 'Styles.composePrompt(', '「最终提示词」预览用的是服务端同一个函数');
    has(appJs, 'Styles.sizeOf(', '尺寸也按共用表算');
    const styles = read('lib/styles.js');
    has(styles, 'globalThis.LanShaiStyles', 'styles.js 确实挂到了全局');
    has(styles, 'module.exports', '同时又给 Node 用');
    has(read('server.js'), "['/lib/styles.js'", '服务端只放行这一个 lib 文件');
  });

  await group('styles.js 在浏览器环境里也能跑（没有 module 变量、不靠 Node）', () => {
    const vm = require('node:vm');
    const source = read('lib/styles.js');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'styles.js' });
    ok(Boolean(sandbox.LanShaiStyles), '挂到了全局');
    eq(typeof sandbox.LanShaiStyles.composePrompt, 'function', '拼提示词的函数在');
    eq(sandbox.LanShaiStyles.sizeOf('16:9', '2K'), '2048x1152', '尺寸算得出');
    has(
      sandbox.LanShaiStyles.composePrompt('一只猫', 'photo', '1024x1024'),
      'photorealistic',
      '拼出来的和服务端一致'
    );
  });

  await group('「没存到本地」的图也能显示（别让已经付过钱的图消失）', () => {
    const app = read('public/js/app.js');
    const server = read('server.js');
    has(app, 'function imageSrc(', '有一个统一的取图地址函数');
    has(app, 'function isRemoteOnly(', '能判断这张有没有落到本地');
    has(app, "'打开原图'", '按钮文案跟着变，不假装能下载');
    has(app, 'out.remoteOnly', '出图返回 remoteOnly 时界面单独提示');
    has(server, 'remoteOnly', '服务端会把这个标记回给界面');
    has(server, 'remote_only', '下载接口单独给出原因码');
    has(server, '没存到本地', '备注里说清为什么没存下来');
  });

  report('ui');
})();
