'use strict';

/**
 * 文档与现实的一致性测试：README 里写的路径、环境变量、接口、数字，
 * 必须真的能在代码里找到。文档漂移比没有文档更糟。
 * 运行：node test/readme.test.js
 */

const assert = require('assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const README = read('README.md');
const SERVER = read('server.js');
const LLM = read('lib/llm.js');
const Modes = require('../lib/modes.js');
const StoreLimits = require('../lib/store.js').LIMITS;

let pass = 0;
const failures = [];

function eq(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected);
    pass += 1;
  } catch {
    failures.push(`${label}\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`);
  }
}

function ok(value, label) {
  eq(Boolean(value), true, label);
}

function group(name, fn) {
  const before = failures.length;
  fn();
  console.log(`  ${failures.length === before ? '✓' : '✗'} ${name}`);
}

const matchAll = (text, re) => {
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
};

console.log('README 与现实');

group('README 里提到的每个文件路径都存在', () => {
  const candidates = matchAll(README, /`([A-Za-z0-9_./-]+\.(?:js|css|html|json|md))`/g);
  const missing = Array.from(new Set(candidates)).filter((rel) => {
    if (rel.includes('*')) return false;
    return !fs.existsSync(path.join(ROOT, rel));
  });
  ok(candidates.length > 8, `提到了 ${candidates.length} 个文件`);
  eq(missing, [], 'README 里不该出现不存在的文件');
});

group('README 里写的目录都存在', () => {
  const dirs = ['js', 'lib', 'css', 'scripts', 'test'];
  const missing = dirs.filter((d) => !fs.existsSync(path.join(ROOT, d)));
  eq(missing, [], '目录齐备');
});

group('README 里列的环境变量都被代码真的读了', () => {
  const vars = Array.from(new Set(matchAll(README, /`([A-Z][A-Z0-9_]{3,})`/g)));
  const sources = SERVER + LLM;
  const unused = vars.filter((name) => !sources.includes(name));
  ok(vars.length >= 8, `README 列了 ${vars.length} 个环境变量`);
  eq(unused, [], '不该写进 README 却没人读的变量');
});

group('README 里写的接口都在服务端有实现', () => {
  const routes = Array.from(new Set(matchAll(README, /\|\s*(?:GET|POST|PATCH|DELETE)\s*\|\s*`([^`?]+)/g)));
  ok(routes.length >= 7, `README 列了 ${routes.length} 个接口`);
  // 逐段核对：:id 这类参数段跳过，其余每一段都要能在 server.js 里找到
  const missing = routes.filter((route) =>
    route
      .split('/')
      .filter((seg) => seg && !seg.startsWith(':'))
      .some((seg) => !SERVER.includes(seg))
  );
  eq(missing, [], 'README 里的接口都该在 server.js 里找得到');
});

group('README 里的端口与默认值一致', () => {
  ok(README.includes('127.0.0.1:5260'), '写的是 5260');
  ok(SERVER.includes('5260'), 'server.js 里也是 5260');
  ok(README.includes('端口被占用会自动往后试 10 个'), '说明了端口兜底');
  ok(/port - BASE_PORT < 10|attempt - want < 10/.test(SERVER), '代码里确实往后试 10 个');
});

group('README 里的数字与代码一致', () => {
  eq(Modes.MODES.length, 6, '代码里是六种模式');
  ok(README.includes('六种：'), 'README 说六种');
  eq(StoreLimits.records, 800, '代码里留档上限 800');
  ok(README.includes('最多 800 篇'), 'README 说 800 篇');
  eq(Modes.LIMITS.versionsMax, 4, '代码里最多四稿');
  ok(README.includes('一次生成多个版本 | 1–4 稿'), 'README 说 1–4 稿');
  eq(Modes.LIMITS.customCharsMax, 2000, '自定义字数上限 2000');
  ok(README.includes('80–2000 字'), 'README 说 80–2000 字');
});

group('README 里列的测试文件都存在，且 npm test 都跑了', () => {
  const listed = matchAll(README, /`test\/([a-z-]+\.test\.js)`/g);
  const missing = Array.from(new Set(listed)).filter((f) => !fs.existsSync(path.join(ROOT, 'test', f)));
  eq(missing, [], 'README 列出的测试文件都在');
  const pkg = JSON.parse(read('package.json'));
  const notRun = Array.from(new Set(listed)).filter((f) => !pkg.scripts.test.includes(`test/${f}`));
  eq(notRun, [], 'README 列出的测试都在 npm test 里');
  ok(pkg.scripts.test.includes('scripts/check-wiring.js'), '接线检查也在 npm test 里');
  const wiring = README.includes('check-wiring.js');
  ok(wiring, 'README 说明了接线检查');
});

group('README 里对离线引擎的说法与代码相符', () => {
  ok(fs.existsSync(path.join(ROOT, 'lib', 'mock-writer.js')), '离线引擎文件存在');
  ok(README.includes('不配 API Key 也能用'), '说明了没 Key 也能用');
  ok(README.includes('40 条中文校对规则'), '写明了规则条数');
  const rules = read('lib/mock-writer.js');
  const block = rules.slice(rules.indexOf('const RULES = ['), rules.indexOf('\n  ];', rules.indexOf('const RULES = [')));
  eq((block.match(/\n    \{/g) || []).length, 40, '规则条数与代码一致');
});

group('README 里承诺的无障碍做法在代码里落实了', () => {
  const css = read('css/styles.css');
  const html = read('index.html');
  const app = read('js/app.js');
  ok(css.includes('prefers-reduced-motion'), '尊重减少动效');
  ok(css.includes(':focus-visible'), '有可见焦点');
  ok(html.includes('aria-live'), '有播报区域');
  ok(html.includes('inert'), '抽屉初始是 inert');
  ok(app.includes("setAttribute('inert'"), '关闭抽屉时设 inert');
  ok(html.includes('class="skip"'), '有跳到正文的链接');
});

group('README 里的截图脚本与包命令都存在', () => {
  ok(fs.existsSync(path.join(ROOT, 'scripts', 'capture.js')), '截图脚本在');
  const pkg = JSON.parse(read('package.json'));
  eq(pkg.scripts.shot, 'node scripts/capture.js', 'npm run shot 指向它');
  eq(pkg.scripts.start, 'node server.js', 'npm start 是起服务');
});

group('README 讲的视觉方向与样式表一致', () => {
  const css = read('css/styles.css');
  ok(css.includes('--zhu:'), '有朱砂令牌');
  ok(css.includes('--paper:'), '有稿纸令牌');
  ok(css.includes('--rule-h: 28px'), '格线节拍是 28px');
  ok(README.includes('--rule-h: 28px'), 'README 讲的也是 28px');
  ok(css.includes('--jade:'), '有松绿令牌');
});

const total = pass + failures.length;
console.log(`\n通过 ${pass}/${total}`);
if (failures.length) {
  console.log('\n失败项：');
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exitCode = 1;
}
