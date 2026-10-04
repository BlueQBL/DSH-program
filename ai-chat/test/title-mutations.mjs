// 会话标题的变异测试：确认那批断言真的抓得住缺陷
//
//   node test/title-mutations.mjs
//
// 这里最要紧的一条是「用户改过的名字不能被自动改名覆盖」——
// 它是这个功能的伦理底线：系统可以自动起名，但不能擅自改掉用户起的名字。
//
// 骨架在 test/mutation-harness.mjs（快照、还原、崩溃判定、收尾都在那边）。

import { createMutationRunner } from './mutation-harness.mjs';

const TITLE = 'public/lib/title.js';
const STORE = 'public/lib/store.js';

const runner = createMutationRunner({
  label: '会话标题',
  suite: 'test/title-tests.mjs',
  files: [TITLE, STORE],
});

// ---- 最要紧的一条：用户的名字不能被自动改名动到

runner.run('自动改名不再区分来源（会把用户改过的名字覆盖掉）', STORE, (src) =>
  src.replace("      if (!force && source !== 'fallback') return false;", '      if (false) return false;'),
);

runner.run('用户改名时不标记来源（下次就会被当成兜底标题替换）', STORE, (src) =>
  src.replace("      session.titleSource = 'manual';", "      session.titleSource = 'fallback';"),
);

runner.run('老数据一律当成兜底标题（用户起的名字会被改掉）', TITLE, (src) =>
  src.replace("  return first && title === fallbackTitle(first) ? 'fallback' : 'manual';", "  return 'fallback';"),
);

runner.run('已经有模型标题的会话还会被重复改名', TITLE, (src) =>
  src.replace("  if (inferTitleSource(session) !== 'fallback') return false;", '  if (false) return false;'),
);

runner.run('还没答案就急着起标题（用半截对话起出来的名字更差）', TITLE, (src) =>
  src.replace('  return hasQuestion && hasAnswer;', '  return hasQuestion;'),
);

// ---- 清洗：模型吐出来的东西不能直接上屏

runner.run('不清洗模型输出（引号、句号都会显示在列表里）', TITLE, (src) =>
  src.replace("  text = stripWrappers(text.replace(/\\s+/g, ' ').trim());", '  text = text.trim();'),
);

runner.run('不限制标题长度（列表里会被省略号截掉，等于白让模型多说）', TITLE, (src) =>
  src.replace('  if (title.length > TITLE_MAX_CHARS) {', '  if (false) {'),
);

runner.run('空话也当成标题（会出现叫「对话」的会话）', TITLE, (src) =>
  src.replace('  if (!clean || DEGENERATE.test(clean)) return null;', '  if (!clean) return null;'),
);

runner.run('过短的结果也接受（会留下一个字的名字）', TITLE, (src) =>
  src.replace('  return title.length >= 2 ? title : null;', '  return title;'),
);

// ---- 本地兜底标题：客套话与请求动词

runner.run('兜底标题不剥客套话（「帮我看看…」会原样出现在列表里）', TITLE, (src) =>
  src.replace('    const match = rest.match(POLITE_PREFIX);', '    const match = null;'),
);

runner.run('兜底标题不留情面地剥请求动词（「介绍一下你自己」会变成「你自己」）', TITLE, (src) =>
  src.replace('    if (next.length >= 4) rest = next;', '    rest = next;'),
);

// ---- 起标题的原料

runner.run('起标题时不带回答（很多话题要看到回答才说得清）', TITLE, (src) =>
  src.replace("  if (String(answer ?? '').trim()) lines.push(`助手：${cut(answer, 600)}`);", ''),
);

runner.run('起标题时不带后来问过的事（标题只会描述开头）', TITLE, (src) =>
  src.replace('  if (later.length) {', '  if (false) {'),
);

runner.finish();
