// 上下文压缩的变异测试：确认那批断言真的抓得住缺陷
//
//   node test/compress-mutations.mjs
//
// 两条底线：
//  · **压缩只改「发给模型的那一份」**：任何「顺手把本地消息也删了」的改动都必须被抓到；
//  · **摘要必须真的顶替掉那几条**：界面上说压过了、请求里却还是发全文（或者什么都没发），
//    是最糟的一种「看起来成功了」。
//
// 骨架在 test/mutation-harness.mjs。

import { createMutationRunner } from './mutation-harness.mjs';

const COMPRESS = 'public/lib/compress.js';
const VERSIONS = 'public/lib/versions.js';
const STORE = 'public/lib/store.js';
const EXPORTERS = 'public/lib/exporters.js';

const runner = createMutationRunner({
  label: '上下文压缩',
  suite: 'test/compress-tests.mjs',
  files: [COMPRESS, VERSIONS, STORE, EXPORTERS],
});

// ---- 什么时候压

runner.run('不看体量就压（短会话也会被压一遍）', COMPRESS, (src) =>
  src.replace('  if (chars < floor) return nothingToDo;', '  if (false) return nothingToDo;'),
);

runner.run('手动压缩的下限不生效（低于门槛也照压）', COMPRESS, (src) =>
  src.replace('  const floor = force ? MIN_COMPRESS_CHARS_MANUAL : MIN_COMPRESS_CHARS;', '  const floor = 0;'),
);

runner.run('手动压缩也留着最近 6 条（点了却几乎没压掉什么）', COMPRESS, (src) =>
  src.replace('  const keepRecent = force ? KEEP_RECENT_MANUAL : KEEP_RECENT;', '  const keepRecent = KEEP_RECENT;'),
);

runner.run('软线失效（该后台压的时候不压）', COMPRESS, (src) =>
  src.replace('  if (liveChars > SOFT_LIMIT_CHARS) return { mode: \'background\'', '  if (false) return { mode: \'background\''),
);

runner.run('硬线失效（该先压再发的时候不压）', COMPRESS, (src) =>
  src.replace('  if (liveChars > HARD_LIMIT_CHARS) return { mode: \'blocking\'', '  if (false) return { mode: \'blocking\''),
);

runner.run('不保留最近几条（把眼前的话也压进摘要）', COMPRESS, (src) =>
  src.replace('  const to = Math.max(covered, messages.length - keepRecent);', '  const to = messages.length;'),
);

runner.run('已经压过的部分又算进体量（会反复压同一段）', COMPRESS, (src) =>
  src.replace('  const liveChars = estimateChars(messages.slice(covered));', '  const liveChars = estimateChars(messages);'),
);

// 注：`to = Math.max(covered, ...)` 那个 max 是**防守**，不是行为：
// 取不取它，slice 都是空的，compressionPlan 都返回 none —— 所以写不出能杀掉它的变异。
// 它的价值是把「from ≤ to」这条不变量写明白（app.js 直接拿这两个下标去 slice）。

// ---- 摘要本身

runner.run('摘要不设长度上限（压完还是那么长）', COMPRESS, (src) =>
  src.replace('    .slice(0, SUMMARY_MAX_CHARS)', '    .slice(0, Number.MAX_SAFE_INTEGER)'),
);

runner.run('空摘要也算数（会推进一段什么都没说）', COMPRESS, (src) =>
  src.replace("  if (!text) return null;", '  if (false) return null;'),
);

runner.run('摘要不带覆盖条数（不知道它顶替了哪一段）', COMPRESS, (src) =>
  src.replace('  if (covers < 1) return null;', '  if (false) return null;'),
);

runner.run('压缩提示词不提「保留事实与代码原样」（压完就没法用了）', COMPRESS, (src) =>
  src.replace("  '必须保留：事实与数据、已经做出的决定、用户的偏好与要求、尚未解决的问题、',\n", ''),
);

runner.run('再压一次时不带上次的摘要（越压越少，而不是越压越紧）', COMPRESS, (src) =>
  src.replace('  if (previousSummary?.text) {', '  if (false) {'),
);

runner.run('发给模型的摘要块不标明「这是压缩过的上文」', COMPRESS, (src) =>
  src.replace("    '【较早对话的摘要】',", "    '【对话】',"),
);

// ---- 压进请求历史

runner.run('摘要不放进请求（界面上说压了，实际还是发全文）', VERSIONS, (src) =>
  // 摘要现在和「背景材料」合成同一条 system（见 versions.js 里的 prefix），
  // 所以这里改的是「摘要那一份要不要拼进前缀」。
  src.replace("  const summaryPart = covered > 0 ? block : '';", "  const summaryPart = '';"),
);

runner.run('被覆盖的消息照样逐条发（等于没压）', VERSIONS, (src) =>
  src.replace('    if (index < covered) continue; // 已经进了摘要', '    if (false) continue;'),
);

runner.run('压过头：把这一轮要回答的提问也压掉（请求会以 system 结尾）', VERSIONS, (src) =>
  src.replace(
    '  const covered = Math.min(coveredCount(all, summary), ceiling);',
    '  const covered = coveredCount(all, summary);',
  ),
);

// ---- 存储：压缩不许动本地记录

runner.run('存储时把摘要顺手当成消息删掉（压缩变成删除）', STORE, (src) =>
  src.replace('      session.summary = clean;', '      session.summary = clean;\n      session.messages = session.messages.slice(clean ? clean.covers : 0);'),
);

runner.run('覆盖条数越界也照存（请求里可能只剩摘要）', STORE, (src) =>
  src.replace('  if (!total || summary.covers >= total) return null;', '  if (false) return null;'),
);

runner.run('清空会话时不作废摘要（摘要在说已经不存在的消息）', STORE, (src) =>
  src.replace('      // 摘要同理：它覆盖的那些消息已经不存在了\n      session.summary = null;', ''),
);

// ---- 导出

runner.run('导出里不交代压缩过（读的人以为模型看的是全文）', EXPORTERS, (src) =>
  src.replace("  if (item.summary?.text) {", '  if (false) {'),
);

runner.run('JSON 导出丢掉摘要字段', EXPORTERS, (src) =>
  src.replace('        contextSummary: s.summary?.text', '        contextSummary: null && s.summary?.text'),
);

runner.finish();
