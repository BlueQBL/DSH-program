// 会话分支的变异测试：确认「从这一轮分出新会话」那批断言真的抓得住缺陷
//
//   node test/branch-mutations.mjs
//
// 骨架在 test/mutation-harness.mjs（快照、还原、崩溃判定、收尾都在那边）。
// 界面那一侧（按钮点了没反应、说明条不显示、正在生成时也允许分支）的变异在
// test/ui-mutations.mjs 里，因为那些要跑 ui-tests；这里只打 store / lib 这一层。

import { createMutationRunner } from './mutation-harness.mjs';

const STORE = 'public/lib/store.js';
const BRANCH = 'public/lib/branch.js';

const runner = createMutationRunner({
  label: '会话分支',
  suite: 'test/store-tests.mjs',
  files: [STORE, BRANCH],
});

runner.run('从哪一条分都一样（把整段对话都复制过去）', BRANCH, (src) =>
  src.replace(
    '  const end = list.findIndex((message) => message?.id === upToMessageId);',
    '  const end = list.length - 1;',
  ),
);

runner.run('分叉点找不到就把整段复制过去（悄悄多带了好几轮）', BRANCH, (src) =>
  src.replace('  if (end < 0) return null;', '  if (end < 0) return stripBranchOnly(deepCopy(list));'),
);

runner.run('分支把图片也复制过去（localStorage 很快写不下）', BRANCH, (src) =>
  src.replace('      ...version,\n      attachments: [],', '      ...version,'),
);

runner.run('分支把评价也复制过去（等于替用户在新会话里表了态）', BRANCH, (src) =>
  src.replace('    feedback: null,\n    versions:', '    versions:'),
);

runner.run('只清了镜像字段上的评价，版本上那条评价照样跟过去', BRANCH, (src) =>
  src.replace('      attachments: [],\n      feedback: null,', '      attachments: [],'),
);

runner.run('分支标题按数量编号（删掉中间那条分支之后会重名）', BRANCH, (src) =>
  src.replace(
    '  const next = siblings.reduce((max, title) => Math.max(max, branchNumber(title)), 0) + 1;',
    '  const next = siblings.length + 1;',
  ),
);

runner.run('标题太长时把「-分支N」也砍掉（分支就认不出自己从哪来了）', BRANCH, (src) =>
  src.replace(
    '  const room = Math.max(1, MAX_TITLE_CHARS - suffix.length);',
    '  const room = MAX_TITLE_CHARS;',
  ),
);

runner.run('摘要覆盖范围越界也照抄（那条请求里可能连用户消息都不剩）', BRANCH, (src) =>
  src.replace(
    '  const keepsSummary =\n    sourceSummary && Number(sourceSummary.covers) < messages.length ? { ...sourceSummary } : null;',
    '  const keepsSummary = sourceSummary ? { ...sourceSummary } : null;',
  ),
);

runner.run('分支名标成「AI 起的」（下一轮起名就把分支名覆盖掉了）', STORE, (src) =>
  src.replace("        titleSource: 'manual',", "        titleSource: 'none',"),
);

runner.run('出处不存当时的标题（源会话一删就说不清它从哪来）', STORE, (src) =>
  src.replace(
    "    title: typeof raw.title === 'string' ? raw.title.slice(0, 60) : '',",
    "    title: '',",
  ),
);

runner.run('分出分支之后不切过去（用户还停在原会话，像点了没反应）', STORE, (src) =>
  // 锚点带上 branchOf 那一段：`sessions.push(session); activeId = ...` 在 createSession 里也有
  src.replace(
    '          images: plan.images,\n        },\n      });\n      sessions.push(session);\n      activeId = session.id;',
    '          images: plan.images,\n        },\n      });\n      sessions.push(session);',
  ),
);

runner.run('分支不是复制，而是把原会话的消息搬走', STORE, (src) =>
  src.replace(
    '          images: plan.images,\n        },\n      });\n      sessions.push(session);',
    '          images: plan.images,\n        },\n      });\n      source.messages = [];\n      sessions.push(session);',
  ),
);

runner.run('会话数到上限时分不出分支（直接卡住不建）', STORE, (src) =>
  // 抽出 makeRoom() 之后，两条新建路径共用它；这里让分支这条路径忘了腾位置
  src.replace(
    '      if (!plan) return null;\n\n      makeRoom();',
    '      if (!plan) return null;\n\n      if (sessions.length >= MAX_SESSIONS) return null;',
  ),
);

runner.finish();
