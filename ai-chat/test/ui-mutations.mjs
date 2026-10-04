// 界面状态的变异测试：确认 ui-tests 真的能抓到这些缺陷
//
//   node test/ui-mutations.mjs
//
// 骨架在 test/mutation-harness.mjs（快照、还原、崩溃判定、收尾都在那边）。
// 这个脚本会改写 public/app.js 与 public/styles.css，所以必须在 ai-chat/ 下运行。

import { createMutationRunner } from './mutation-harness.mjs';

const APP = 'public/app.js';
const CSS = 'public/styles.css';
const HTML = 'public/index.html';

const runner = createMutationRunner({
  label: '界面状态',
  suite: 'test/ui-tests.mjs',
  files: [APP, CSS, HTML],
});

// promptSave 现在分成三条分支（未改动 / 改过预设 / 自定义），每条各自收起面板。
// 下面三条分别打掉一条分支的收起，确认测试覆盖了全部路径 ——
// 早先只有一条通用变异，失效之后暴露了我没覆盖到分支收敛这件事。
runner.run('删掉「未改动就保存」分支的收起面板', APP, (src) =>
  src.replace(
    "      if (session.systemPrompt) store.updateSessionSettings({ systemPrompt: '' });\n      setPromptPanelOpen(false);",
    "      if (session.systemPrompt) store.updateSessionSettings({ systemPrompt: '' });",
  ),
);

runner.run('删掉「改过预设后保存」分支的收起面板', APP, (src) =>
  src.replace(
    "    renderSessionList();\n    setPromptPanelOpen(false);\n    flashHint('已保存自定义内容，角色仍是'",
    "    renderSessionList();\n    flashHint('已保存自定义内容，角色仍是'",
  ),
);

runner.run('删掉「自定义角色保存」分支的收起面板', APP, (src) =>
  src.replace(
    "  renderSessionList();\n  setPromptPanelOpen(false);\n  flashHint(edited ? '已保存到本对话",
    "  renderSessionList();\n  flashHint(edited ? '已保存到本对话",
  ),
);

runner.run('删掉「还原后收起面板」', APP, (src) =>
  src.replace(/\n  setPromptPanelOpen\(false\);\n(  flashHint\('已还原)/, '\n$1'),
);

runner.run('让 setPromptPanelOpen 只改 aria 不改 hidden', APP, (src) =>
  src.replace(
    'function setPromptPanelOpen(open) {\n  els.promptPanel.hidden = !open;',
    'function setPromptPanelOpen(open) {\n  void open;',
  ),
);

runner.run('删掉「换模型时刷新顶部标签」', APP, (src) =>
  src.replace(
    '  renderSessionList();\n  syncModeChip();\n  flashHint(`下一轮对话改用 ${model}`, 2600);',
    '  renderSessionList();\n  flashHint(`下一轮对话改用 ${model}`, 2600);',
  ),
);

runner.run('让顶部标签永远显示服务端默认模型（不顾所选）', APP, (src) =>
  src.replace('  const model = currentModelForRequest();', '  const model = runtime.serverDefaultModel;'),
);

// ---- 报头抖动（用户反馈：正文往上滚、快到顶的时候整页一直抖）
//
// 这一块的断言要防住三件事：滞回不能退化成单阈值、状态没变不能写 DOM、
// 报头高度不能带过渡。下面每条分别打掉一件。

runner.run('滞回退化成单阈值（抖动缺陷的原样）', APP, (src) =>
  src.replace(
    'const next = mastheadCompact === true ? y > COMPACT_EXIT_AT : y > COMPACT_ENTER_AT;',
    'const next = y > COMPACT_ENTER_AT;',
  ),
);

runner.run('进入/退出用同一个阈值（缓冲带塌掉）', APP, (src) =>
  src.replace('const COMPACT_EXIT_AT = 8;', 'const COMPACT_EXIT_AT = 48;'),
);

runner.run('每次滚动都重写 data-compact（值没变也写）', APP, (src) =>
  src.replace(
    "  if (next !== mastheadCompact) {\n    mastheadCompact = next;\n    els.masthead.dataset.compact = next ? 'true' : 'false';\n  }",
    "  mastheadCompact = next;\n  els.masthead.dataset.compact = next ? 'true' : 'false';",
  ),
);

runner.run('每次滚动都重写 --masthead-h（会话栏跟着每帧重算）', APP, (src) =>
  src.replace(
    "  if (height !== mastheadHeight) {\n    mastheadHeight = height;\n    document.documentElement.style.setProperty('--masthead-h', `${height}px`);\n  }",
    "  mastheadHeight = height;\n  document.documentElement.style.setProperty('--masthead-h', `${height}px`);",
  ),
);

runner.run('给报头加回内边距过渡（文档高度会连着 180ms 一帧帧变）', CSS, (src) =>
  src.replace(
    '  overflow-anchor: none;\n}',
    '  overflow-anchor: none;\n  transition: padding 0.18s ease;\n}',
  ),
);

runner.run('删掉报头的滚动锚定抑制', CSS, (src) => src.replace('  overflow-anchor: none;\n', ''));

// ---- 引用回答（用户提出：回答里的一段可以划出来引用，接着问）
//
// 这条盯的是一个真实浏览器行为：按下浮标按钮本身就会清掉文档选区。
// 所以「引用」必须在浮标出现时就存下来 —— 点的时候再读选区只会读到空字符串，
// 表现是「点了没反应」，而且本地很难想到是这个原因。

runner.run('点引用时重读选区（按钮按下已清空选区，会导致点了没反应）', APP, (src) =>
  src.replace('  const quote = floatQuote;', '  const quote = readSelectionQuote()?.quote ?? null;'),
);

runner.run('把引用只挂进输入区、不随提问发出去', APP, (src) =>
  src.replace(
    '  const asked = store.pushUser(text, { attachments: images, edit, version, reuse, quote });',
    '  const asked = store.pushUser(text, { attachments: images, edit, version, reuse });',
  ),
);

runner.run('点「重新生成」时把输入区挂着的引用一并吃掉', APP, (src) =>
  // 注意：这条不是「引用会串到旧那一问」——那一层由 store 守着（编辑/重生成时它
  // 一律忽略传进来的 quote，store-tests 有断言）。这里守的是**更轻但用户能看见**的一半：
  // 重试不该把用户刚挑好的那段引用顺手清掉。
  src.replace('  const quote = edit ? null : runtime.pendingQuote;', '  const quote = runtime.pendingQuote;'),
);

// ---- 会话标题（用户提出：参考 ChatGPT 的起标题做法）

runner.run('答完之后不去问模型要标题（永远只有本地兜底那版）', APP, (src) =>
  src.replace("    if (placeholder.status === 'done') void requestTitle(sessionIdAtSend);", ''),
);

// ---- 上下文压缩：压缩标记与「改动落在已压缩部分里」的处理

runner.run('改动落在已压缩的部分里也不作废摘要', APP, (src) =>
  // 摘要说的是那一轮**当时**的内容；用户改了它之后，摘要就成了「已不存在的版本」的浓缩，
  // 而模型看到的正是摘要 —— 悄悄用旧内容是最难查的一类问题
  src.replace('  if (index < 0 || index >= summary.covers) return false;', '  if (true) return false;'),
);

// ---- 布局：会话列表与聊天框互不干扰（用户反馈：会话一多就盖住输入区）
//
// 那次修复是**结构性**的（把输入区从 .board 外面挪进右栏，见 index.html 里的注释），
// 对应的断言在 ui-tests ⑭ 读 index.html 判结构。这里补两条 CSS 侧的变异 ——
// 它们同样能造出「列表盖住输入区」：把两栏并成一栏、或者让列表不再自己滚。

runner.run('把两栏并成一栏（会话栏和输入区又处在同一条水平带上）', CSS, (src) =>
  src.replace('  grid-template-columns: 292px minmax(0, 1fr);', '  grid-template-columns: minmax(0, 1fr);'),
);

runner.run('会话列表不再自己滚（会话一多就把页面撑高、压到输入区）', CSS, (src) =>
  src.replace('  overflow-y: auto;\n  /* 会话栏自己是一格：列表滚到头就别把整个页面带着滚了 */', '  /* 会话栏自己是一格：列表滚到头就别把整个页面带着滚了 */'),
);

runner.run('去掉会话栏的高度上限（列表长到和输入区重叠）', CSS, (src) =>
  src.replace('  max-height: calc(100dvh - var(--masthead-h, 108px) - 32px);', ''),
);

// ---- 列表收起之后，得留着开新对话的入口（参考 ChatGPT 的图标开关）

runner.run('收起列表时不在报头露出备用入口（收起后就没地方开新对话了）', APP, (src) =>
  src.replace('  if (els.newSessionCompact) els.newSessionCompact.hidden = visible;', '  void visible;'),
);

runner.run('收起状态不记住（刷新一次又自己弹出来）', APP, (src) =>
  src.replace('  writeRailPreference(visible);', '  void visible;'),
);

runner.run('把收起/展开开关从右端解下来（改成跟着标题走）', CSS, (src) =>
  src.replace(
    '.masthead-brand .icon-toggle {\n  position: absolute;',
    '.masthead-brand .icon-toggle {\n  position: static;',
  ),
);

// 把开关从原位剪下来、插到指定锚点前，用来模拟「它又跑回某个位置」。
// 用 id 定位、再前后找标签边界，不写多行字面量 —— 源码一重排就会静默失配。
function moveToggle(source, anchor) {
  const idAt = source.indexOf('id="sidebar-toggle"');
  if (idAt < 0) return source;
  const start = source.lastIndexOf('<button', idAt);
  const end = source.indexOf('</button>', idAt) + '</button>'.length;
  const tag = source.slice(start, end);
  const without = source.slice(0, start) + source.slice(end);
  const at = without.indexOf(anchor);
  if (at < 0) return source;
  return `${without.slice(0, at)}${tag}\n          ${without.slice(at)}`;
}

runner.run('把开关挪回大标题左边（用户说这个最难看）', HTML, (src) =>
  moveToggle(src, '<div class="masthead-title">'),
);

runner.run('把开关放回右格（和备用入口、模型框挤在一起，点一下就被推着挪）', HTML, (src) =>
  moveToggle(src, '<span class="mode-chip"'),
);

runner.run('报头左格改窄（开关不再对准会话栏和正文之间那道缝）', CSS, (src) =>
  src.replace(
    '  grid-template-columns: 292px minmax(0, 1fr);\n  column-gap: 28px;\n  align-items: end;',
    '  grid-template-columns: 260px minmax(0, 1fr);\n  column-gap: 28px;\n  align-items: end;',
  ),
);

runner.run('左格不再是定位祖先（开关会飘到整页右上角去）', CSS, (src) =>
  // 连同上一行的注释一起换：`position: relative` 在样式表里出现过很多次，
  // 只有带上这一格的注释才是唯一的靶点。
  src.replace(
    '  /* 定位祖先：开关相对这一格钉右端（见下一条） */\n  position: relative;',
    '  position: static;',
  ),
);

runner.run('「新对话」改回黑底实心', CSS, (src) =>
  src.replace('.rail-new {\n  display: block;', '.rail-new {\n  background: var(--ink);\n  display: block;'),
);

runner.finish();
