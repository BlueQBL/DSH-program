// 会话引用的变异测试：确认「背景材料」那批断言真的抓得住缺陷
//
//   node test/reference-mutations.mjs
//
// 骨架在 test/mutation-harness.mjs（快照、还原、崩溃判定、收尾都在那边）。
// 界面那一侧（面板、勾选、移除、上限文案）的变异在 test/ui-mutations.mjs 里，
// 因为那些要跑 ui-tests；这里只打 lib / store / 请求构造 / 导出这一层。

import { createMutationRunner } from './mutation-harness.mjs';

const REFERENCE = 'public/lib/reference.js';
const STORE = 'public/lib/store.js';
const VERSIONS = 'public/lib/versions.js';
const EXPORTERS = 'public/lib/exporters.js';

const runner = createMutationRunner({
  label: '会话引用',
  suite: 'test/store-tests.mjs',
  files: [REFERENCE, STORE, VERSIONS, EXPORTERS],
});

// ---- 材料怎么进请求（这是「引用」和「分支」的分界线，也是最容易写错的地方）

runner.run('材料根本不进请求（引用挂了个寂寞）', VERSIONS, (src) =>
  src.replace(
    "  const material = isValidReference(reference) ? String(reference.text).trim() : '';",
    "  const material = '';",
  ),
);

runner.run('材料与摘要各占一条 system（后面那条会被服务端直接丢掉）', VERSIONS, (src) =>
  src.replace(
    "  if (prefix) {\n    history.push({ role: 'system', content: prefix, images: [] });\n  }",
    "  if (material) history.push({ role: 'system', content: material, images: [] });\n  if (summaryPart) history.push({ role: 'system', content: summaryPart, images: [] });",
  ),
);

runner.run('材料排在摘要后面（摘要不贴着正文了）', VERSIONS, (src) =>
  src.replace('[material, summaryPart]', '[summaryPart, material]'),
);

// ---- 材料本身：上限、措辞、离线

runner.run('原文档不限轮数（整段对话都能被"引用"搬过去）', REFERENCE, (src) =>
  src.replace("    if (picked.length > MAX_REFERENCE_TURNS) return { ok: false, reason: 'too-many-turns' };\n", ''),
);

runner.run('材料太长也照发（静默超预算）', REFERENCE, (src) =>
  src.replace("    if (text.length > MAX_REFERENCE_CHARS) return { ok: false, reason: 'too-long' };\n", ''),
);

runner.run('材料里不说清「这是背景资料，不是你们聊过的」', REFERENCE, (src) =>
  src.replace(
    "'（这是用户提供的**背景资料**，供参考用。它不是你和用户现在这段对话的一部分，',",
    "'（以下是那个会话的内容：',",
  ),
);

runner.run('离线也照样生成摘要档（装作带上了）', REFERENCE, (src) =>
  src.replace("  if (mode === 'mock') return { ok: false, reason: 'no-model' };\n", ''),
);

runner.run('模型没给出摘要也照用（挂上一份空材料）', REFERENCE, (src) =>
  src.replace("  if (!summary) return { ok: false, reason: 'no-summary' };\n", ''),
);

runner.run('只带图的那一轮装作不存在（材料里凭空少一轮）', REFERENCE, (src) =>
  src.replace('  return images ? `（这一轮有 ${images} 张图片，图片没有带过来）` : \'\';', "  return '';"),
);

runner.run('多页的那一轮不说明给的是哪一页（用户以为引的是他当时看的那页）', REFERENCE, (src) =>
  src.replace('  const note = multiPageNote(picked);\n  if (note) lines.push(note);\n', ''),
);

runner.run('每一轮只按提问算页数（回答那边多出来的页看不见）', REFERENCE, (src) =>
  src.replace('  return Math.max(1, q, a);', '  return Math.max(1, q);'),
);

// ---- 落到会话上

runner.run('材料不挂到会话上（刷新就没了）', STORE, (src) =>
  src.replace('      session.reference = clean;', '      session.reference = null;'),
);

runner.run('脏数据里的轮次号不夹上限（引用会悄悄长成一条链）', STORE, (src) =>
  src.replace(
    "      .slice(0, kind === 'turns' ? MAX_REFERENCE_TURNS : MAX_RECORDED_TURNS),",
    '      .slice(0, 999),',
  ),
);

runner.run('摘要档的轮次记录也被「原文最多 3 轮」砍掉（勾了 5 轮只记 3 轮，「改选轮次」还还原不回来）', STORE, (src) =>
  src.replace(
    "kind === 'turns' ? MAX_REFERENCE_TURNS : MAX_RECORDED_TURNS",
    'MAX_REFERENCE_TURNS',
  ),
);

runner.run('摘要档不记「压的是哪几轮」（点「改选轮次」回来是一片空勾选框）', REFERENCE, (src) =>
  src.replace(
    '      turns: wanted.length ? picked.map((p) => p.number) : [],',
    '      turns: [],',
  ),
);

runner.run('空正文的材料也算材料（界面会出现一条点不开的标注）', STORE, (src) =>
  src.replace("  if (!text) return null;\n", ''),
);

// ---- 导出：材料要如实交代，但不能混进对话正文

runner.run('导出的 JSON 里没有材料（导入方以为这是纯对话）', EXPORTERS, (src) =>
  src.replace('        reference: s.reference?.text', '        reference: null && s.reference?.text'),
);

runner.run('Markdown 里不提背景材料', EXPORTERS, (src) =>
  src.replace('    if (item.reference?.text) {', '    if (false) {'),
);

runner.finish();
