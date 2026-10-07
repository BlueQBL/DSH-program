// 会话置顶 / 归档的变异测试：确认那批断言真的抓得住缺陷
//
//   node test/pin-mutations.mjs
//
// 骨架在 test/mutation-harness.mjs（快照、还原、崩溃判定、收尾都在那边）。
// 界面那一侧（三组各自收放、组标题不跟着收、归档的出口和搜索标记）的变异在
// test/ui-mutations.mjs 里，因为那些要跑 ui-tests；这里只打 store 这一层。

import { createMutationRunner } from './mutation-harness.mjs';

const STORE = 'public/lib/store.js';

const runner = createMutationRunner({
  label: '会话置顶与归档',
  suite: 'test/store-tests.mjs',
  files: [STORE],
});

runner.run('分组反过来（置顶的进了「最近」）', STORE, (src) =>
  src.replace(
    '    pinned: live.filter((session) => session?.pinned === true),\n    recent: live.filter((session) => session?.pinned !== true),',
    '    pinned: live.filter((session) => session?.pinned !== true),\n    recent: live.filter((session) => session?.pinned === true),',
  ),
);

runner.run('脏数据里的 "true" 也当成置顶（到处冒出没置顶过的会话）', STORE, (src) =>
  src.replace('    pinned: raw.pinned === true,', '    pinned: Boolean(raw.pinned),'),
);

runner.run('置顶顺手改了「最近使用时间」（会话行上的时钟会莫名其妙跳一下）', STORE, (src) =>
  src.replace(
    '      session.pinned = pinned === true;\n      commit();',
    '      session.pinned = pinned === true;\n      touch(session);\n      commit();',
  ),
);

runner.run('淘汰最旧会话时不管置顶（用户说过重要的那条被删掉）', STORE, (src) =>
  // 这条规则现在收在 store.js 的 makeRoom() 里（新建会话和分出新会话共用一份）
  src.replace(
    '    const oldest = byOldest.find((s) => s.pinned !== true && s.archived !== true)\n      ?? byOldest.find((s) => s.pinned !== true)\n      ?? byOldest[0];',
    '    const oldest = byOldest[0];',
  ),
);

// ---------------------------------------------------------------- 归档

runner.run('脏数据里的 "true" 也当成归档（会话一打开就没了）', STORE, (src) =>
  src.replace('    archived: raw.archived === true,', '    archived: Boolean(raw.archived),'),
);

runner.run('归档的不离开「最近」组（归档点了等于没点）', STORE, (src) =>
  src.replace(
    "  const live = list.filter((session) => session?.archived !== true);",
    '  const live = list;',
  ),
);

runner.run('归档的留在「置顶」组里（一个会话同时出现在两个组里）', STORE, (src) =>
  src.replace(
    '  const live = list.filter((session) => session?.archived !== true);',
    '  const live = list.filter((session) => session?.archived !== true || session?.pinned === true);',
  ),
);

runner.run('归档顺手改了「最近使用时间」（取消归档之后它凭空冒到第一名）', STORE, (src) =>
  src.replace(
    '      session.archived = archived === true;\n      if (session.archived) session.pinned = false;',
    '      session.archived = archived === true;\n      touch(session);\n      if (session.archived) session.pinned = false;',
  ),
);

runner.run('归档时不清置顶（「钉在最上面」和「不在列表里」同时成立）', STORE, (src) =>
  src.replace('      if (session.archived) session.pinned = false;\n', ''),
);

runner.run('归档不认布尔（脏值 "yes" 也能把会话收起来）', STORE, (src) =>
  src.replace('      session.archived = archived === true;', '      session.archived = Boolean(archived);'),
);

runner.run('淘汰时漏掉归档那一档（归档的会话第一个被扔掉）', STORE, (src) =>
  src.replace(
    '    const oldest = byOldest.find((s) => s.pinned !== true && s.archived !== true)\n      ?? byOldest.find((s) => s.pinned !== true)\n      ?? byOldest[0];',
    '    const oldest = byOldest.find((s) => s.pinned !== true) ?? byOldest[0];',
  ),
);

runner.run('淘汰顺序里归档和置顶颠倒（把用户说「现在就要用」的那条先扔掉）', STORE, (src) =>
  src.replace(
    '      ?? byOldest.find((s) => s.pinned !== true)\n      ?? byOldest[0];',
    '      ?? byOldest.find((s) => s.archived !== true)\n      ?? byOldest[0];',
  ),
);

runner.finish();
