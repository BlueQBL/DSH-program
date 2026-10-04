// 评价功能的变异测试：确认那批断言真的抓得住缺陷
//
//   node test/feedback-mutations.mjs
//
// 两条最要紧的：
//  · **评价要跟着「页」走** —— 一条回答可以有多页，第 1 页的赞不该跑到第 2 页；
//  · **点错了能改** —— 这是 ChatGPT 被抱怨最多的点，也是这个功能刻意做好的地方。
//
// 骨架在 test/mutation-harness.mjs。

import { createMutationRunner } from './mutation-harness.mjs';

const FEEDBACK = 'public/lib/feedback.js';
const STORE = 'public/lib/store.js';
const EXPORTERS = 'public/lib/exporters.js';

const runner = createMutationRunner({
  label: '用户评价',
  suite: 'test/feedback-tests.mjs',
  files: [FEEDBACK, STORE, EXPORTERS],
});

// ---- 规整：脏数据不许上屏

runner.run('认不出的档位也当评价（会冒出一个没有名字的档）', FEEDBACK, (src) =>
  src.replace("  if (!isRating(raw.rating)) return null;", '  if (false) return null;'),
);

runner.run('认不出的原因 id 也收（手改的 localStorage 会污染界面）', FEEDBACK, (src) =>
  src.replace(
    "    if (typeof item !== 'string' || !known.has(item) || reasons.includes(item)) continue;",
    "    if (typeof item !== 'string') continue;",
  ),
);

runner.run('原因不做去重与数量上限（同一项会重复出现）', FEEDBACK, (src) =>
  src.replace('    if (reasons.length >= MAX_REASONS) break;', '    if (false) break;'),
);

runner.run('补充说明不截断（长度没有上限）', FEEDBACK, (src) =>
  src.replace(
    "  const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, MAX_NOTE_CHARS) : '';",
    "  const note = typeof raw.note === 'string' ? raw.note.trim() : '';",
  ),
);

// ---- 点错了要能改

runner.run('再点一次同一个按钮不再取消（点了就改不了，和 ChatGPT 一样糟）', FEEDBACK, (src) =>
  src.replace('  return current === clicked ? null : clicked;', '  return clicked;'),
);

runner.run('原因再点一次不能取消', FEEDBACK, (src) =>
  src.replace('  if (current.includes(id)) return current.filter((x) => x !== id);', '  if (false) return current;'),
);

// ---- 撤回也要发出去

runner.run('撤回评价不发事件（服务端永远不知道他改主意了）', FEEDBACK, (src) =>
  src.replace("  if (action === 'clear') {", '  if (false) {'),
);

// ---- 存储：评价跟着「页」走

runner.run('评价只写在消息上、不写进版本（第 1 页的赞会跟到第 2 页）', STORE, (src) =>
  src.replace('      v.feedback = clean;', '      void v;'),
);

runner.run('用户消息也能被打分（语义上说不通）', STORE, (src) =>
  src.replace("      if (!message || message.role !== 'assistant') return null;", '      if (!message) return null;'),
);

runner.run('重新生成时不清掉旧评价（新回答顶着旧评价）', STORE, (src) =>
  src.replace('      target.feedback = null;', '      void target;'),
);

// ---- 导出：评价是这份记录的一部分

runner.run('Markdown 导出丢掉评价', EXPORTERS, (src) =>
  src.replace('        if (verdict) lines.push(`> 评价：${verdict}`, \'\');', '        void verdict;'),
);

runner.run('JSON 导出丢掉评价字段', EXPORTERS, (src) =>
  src.replace('          feedback: m.feedback\n            ? {', '          feedback: null\n            ? {'),
);

runner.finish();
