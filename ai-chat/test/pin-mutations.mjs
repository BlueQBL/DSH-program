// 会话置顶的变异测试：确认「置顶」那批断言真的抓得住缺陷
//
//   node test/pin-mutations.mjs
//
// 骨架在 test/mutation-harness.mjs（快照、还原、崩溃判定、收尾都在那边）。
// 界面那一侧（两组各自收放、组标题不跟着收）的变异在 test/ui-mutations.mjs 里，
// 因为那些要跑 ui-tests；这里只打 store 这一层。

import { createMutationRunner } from './mutation-harness.mjs';

const STORE = 'public/lib/store.js';

const runner = createMutationRunner({
  label: '会话置顶',
  suite: 'test/store-tests.mjs',
  files: [STORE],
});

runner.run('分组反过来（置顶的进了「最近」）', STORE, (src) =>
  src.replace(
    '    pinned: list.filter((session) => session?.pinned === true),\n    recent: list.filter((session) => session?.pinned !== true),',
    '    pinned: list.filter((session) => session?.pinned !== true),\n    recent: list.filter((session) => session?.pinned === true),',
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
    '    const oldest = byOldest.find((s) => s.pinned !== true) ?? byOldest[0];',
    '    const oldest = byOldest[0];',
  ),
);

runner.finish();
