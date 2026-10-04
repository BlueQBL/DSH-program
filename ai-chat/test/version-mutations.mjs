// 版本功能的变异测试：确认「编辑分页」那批断言真的抓得住缺陷
//
//   node test/version-mutations.mjs
//
// 骨架在 test/mutation-harness.mjs（快照、还原、崩溃判定、收尾都在那边）。

import { createMutationRunner } from './mutation-harness.mjs';

const STORE = 'public/lib/store.js';
const VERSIONS = 'public/lib/versions.js';
const COPY_FEEDBACK = 'public/lib/copy-feedback.js';
const CSS = 'public/styles.css';

const runner = createMutationRunner({
  label: '版本功能',
  suite: 'test/store-tests.mjs',
  files: [STORE, VERSIONS, COPY_FEEDBACK, CSS],
});

// 这一条对应的正是用户实测报上来的缺陷：
// 「编辑后生成的内容把上一次的内容覆盖了」。
// 只要有人把 reuse 的判断写反（让编辑也走原地替换），这条就会失败。
runner.run('让「编辑重发」退化成原地覆盖（旧内容被吃掉）', STORE, (src) =>
  src.replace('        if (reuse) {', '        if (true) {'),
);

runner.run('「重新生成」也变成追加（会平白多出一页）', STORE, (src) =>
  src.replace('        if (reuse) {', '        if (false) {'),
);

runner.run('pushUser 忽略 edit，永远新建一条消息', STORE, (src) =>
  src.replace('if (edit && Array.isArray(edit.versions) && edit.versions.length) {', 'if (false) {'),
);

runner.run('pushAssistant 不按提问页数补齐（旧页回答会错位）', STORE, (src) =>
  src.replace('while (answer.versions.length < qCount) {', 'while (false) {'),
);

runner.run('page 越界时不回落（可能返回超范围的页）', VERSIONS, (src) =>
  src.replace('  return Math.min(Math.floor(n), total);', '  return Math.floor(n);'),
);

runner.run('只有一页时也生成页码按钮（界面会多出噪音）', VERSIONS, (src) =>
  src.replace('  if (total <= 1) return [];', '  if (false) return [];'),
);

runner.run('buildRequestHistory 丢掉历史版本（模型会看到自问自答）', VERSIONS, (src) =>
  src.replace('      for (let i = 0; i < versions.length - 1; i += 1) {', '      for (let i = 0; i < 0; i += 1) {'),
);

runner.run('buildRequestHistory 丢掉旧版本对应的回答', VERSIONS, (src) =>
  src.replace('        if (oldAnswer && versionText(oldAnswer)) {', '        if (false) {'),
);

runner.run('buildRequestHistory 把图片也塞给历史消息', VERSIONS, (src) =>
  // 目标是**单行、无转义**的一段：照抄多行字面量的替换很脆，
  // 引用功能调整过这里的写法之后就静默失配过一次
  src.replace('    const images = [];', '    const images = versionImages(current);'),
);

// ---- 复制反馈（用户反馈：点了复制看不出成功）
// 这一块的核心是「按钮必须变」，所以变异都围绕「变不了」来设计。

runner.run('复制成功时按钮文字不变（用户看不出成功）', COPY_FEEDBACK, (src) =>
  src.replace("  copied: '已复制',", '  copied: "",'),
);

runner.run('复制成功时不加成功状态类（样式无从换色）', COPY_FEEDBACK, (src) =>
  src.replace("className: 'is-copied'", 'className: ""'),
);

runner.run('成功与失败用同一个状态类（分不清成败）', COPY_FEEDBACK, (src) =>
  src.replace("className: 'is-copy-failed'", "className: 'is-copied'"),
);

runner.run('把成功色改成红墨（与「问」标的语义混淆）', CSS, (src) =>
  src.replace('--success: #2f6b4f;', '--success: #c2402a;'),
);

runner.run('删掉代码块复制按钮的成功样式（状态类失效）', CSS, (src) =>
  src.replace('.code-copy.is-copied {', '.code-copy-renamed.is-copied {'),
);

runner.run('失败时不给补救提示（用户不知道怎么手动复制）', COPY_FEEDBACK, (src) =>
  src.replace("return ok ? `${label}已复制` : '复制失败，请手动选择';", "return '';"),
);

runner.finish();

