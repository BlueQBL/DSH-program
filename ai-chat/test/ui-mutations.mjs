// 界面状态的变异测试：确认 ui-tests 真的能抓到这些缺陷
//
//   node test/ui-mutations.mjs
//
// 骨架在 test/mutation-harness.mjs（快照、还原、崩溃判定、收尾都在那边）。
// 这个脚本会改写 public/app.js、public/styles.css、public/index.html，
// 另外还有一条会改写 public/lib/store.js（「一个会话一份材料」那条边界在存储层），
// 所以必须在 ai-chat/ 下运行。

import { createMutationRunner } from './mutation-harness.mjs';

const APP = 'public/app.js';
const CSS = 'public/styles.css';
const HTML = 'public/index.html';
const STORE = 'public/lib/store.js';

const runner = createMutationRunner({
  label: '界面状态',
  suite: 'test/ui-tests.mjs',
  files: [APP, CSS, HTML, STORE],
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
  // 现在两个入口的样式都收在 .rail-actions .ghost-button 那一组里
  src.replace(
    '.rail-actions .ghost-button {\n  flex: 1 1 0;',
    '.rail-actions .ghost-button {\n  background: var(--ink);\n  flex: 1 1 0;',
  ),
);

// ---- 会话列表的置顶 / 最近（两组各自收放）

runner.run('组标题跟着会话一起被收起来（「置顶」「最近」两个字没了）', APP, (src) =>
  // 收的应该只是会话容器；改成收整组，标题就跟着消失了
  src.replace('    group.list.hidden = collapsed;', '    group.section.hidden = collapsed;'),
);

runner.run('组的收起状态不记住（刷新一次又全弹开）', APP, (src) =>
  src.replace(
    '  groupCollapsed[name] = collapsed === true;\n  writeGroupPreference();',
    '  groupCollapsed[name] = collapsed === true;',
  ),
);

runner.run('收某一组的时候把整栏也收起来（两个开关搅在一起）', APP, (src) =>
  src.replace(
    '  groupCollapsed[name] = collapsed === true;',
    '  setRailVisible(!collapsed);\n  groupCollapsed[name] = collapsed === true;',
  ),
);

runner.run('组一收起来，「＋ 新对话」也跟着没了', APP, (src) =>
  src.replace(
    '    group.list.hidden = collapsed;',
    '    group.list.hidden = collapsed;\n    els.newSession.hidden = collapsed;',
  ),
);

runner.run('置顶之后不重画列表（点了像没反应）', APP, (src) =>
  src.replace(
    "    setGroupCollapsed(next ? 'pinned' : 'recent', false);\n    renderSessionList();",
    "    setGroupCollapsed(next ? 'pinned' : 'recent', false);",
  ),
);

runner.run('置顶时不展开那一组（会话挪进了看不见的地方）', APP, (src) =>
  src.replace("    setGroupCollapsed(next ? 'pinned' : 'recent', false);\n", ''),
);

runner.run('把置顶写反（点一下变取消、再点才置顶）', APP, (src) =>
  src.replace('    const next = session?.pinned !== true;', '    const next = session?.pinned === true;'),
);

runner.run('会话不再分组（全都塞进「最近」）', APP, (src) =>
  src.replace('  const groups = groupSessions(sessions);', '  const groups = { pinned: [], recent: sessions };'),
);

runner.run('置顶之后按钮不改口（没法取消置顶）', APP, (src) =>
  src.replace("  pin.textContent = pinned ? '取消置顶' : '置顶';", "  pin.textContent = '置顶';"),
);

runner.run('组标题上的条数不更新（收起来就不知道里面有几条）', APP, (src) =>
  src.replace('    group.count.textContent = String(rows.length);', '    group.count.textContent = String(0);'),
);

// ---- 会话分支：从这一轮分出一个新会话

runner.run('「分出新会话」点了没反应', APP, (src) =>
  src.replace("  if (kind === 'branch') {", "  if (false && kind === 'branch') {"),
);

runner.run('分支分出来了，但正文区不说明它从哪儿来', APP, (src) =>
  src.replace('  note.hidden = false;', '  note.hidden = true;'),
);

runner.run('正在生成时也允许分支（把半截内容复制走）', APP, (src) =>
  src.replace(
    "    if (runtime.busy) {\n      flashHint('正在生成，等这一轮结束再分出新会话', 2600);",
    "    if (false) {\n      flashHint('正在生成，等这一轮结束再分出新会话', 2600);",
  ),
);

runner.run('分支会话行不再标箭头（一眼看不出它是岔出来的）', CSS, (src) =>
  src.replace(
    '.session-item[data-branch="true"] .session-name::before {',
    '.session-item-branch-renamed .session-name::before {',
  ),
);

// ---- 错误文案：服务端拒绝 ≠ 连不上服务端

runner.run('服务端拒了请求（400）也报成「连不上服务端」（把人引去查进程）', APP, (src) =>
  src.replace('    } else if (err.httpStatus) {', '    } else if (false) {'),
);

runner.run('不给错误带上 HTTP 状态码（上面那条分支就永远走不到）', APP, (src) =>
  src.replace('      rejected.httpStatus = response.status;', '      void response.status;'),
);

// ---- 会话引用：面板、材料条、上限文案

// 已有材料时再点「引用会话」：这三条守着「不许静默覆盖」那条规矩 ——
// 预填现有材料、把「会替换」写在按下去之前、确认按钮跟着改口。
runner.run('「引用会话」在有材料时不预填（打开是空白表单，看着像新建、其实是替换）', APP, (src) =>
  src.replace(
    "    sourceId: sourceId || seed?.sessionId || others[0]?.id || store.sessionId,\n    kind: (kind || seed?.kind) === 'turns' ? 'turns' : 'summary',\n    // numbers 显式传了就用传的（包括空数组）；没传才接上现有材料记着的那几轮\n    numbers: Array.isArray(numbers) ? [...numbers] : (Array.isArray(seed?.turns) ? [...seed.turns] : []),",
    "    sourceId: sourceId || others[0]?.id || store.sessionId,\n    kind: kind === 'turns' ? 'turns' : 'summary',\n    numbers: Array.isArray(numbers) ? [...numbers] : [],",
  ),
);

runner.run('已有材料时不出「会替换」的提示（静默覆盖又回来了）', APP, (src) =>
  src.replace('  const note = referenceReplaceNoteText();\n', "  const note = '';\n"),
);

runner.run('确认按钮一直写着「开新会话」（要替换的时候不改口）', APP, (src) =>
  src.replace(
    "  return existingReference() ? '替换这份材料' : '在这个会话里生效';",
    "  return '用这份材料开新会话';",
  ),
);

// C（明确替换）和 A（合并多条）的分界线：材料必须是**替换**，不是悄悄并排堆积。
// 真要做成合并，那是存储 schema 级的改动（reference → references[]），得单独设计。
runner.run('材料变成「合并」而不是替换（旧的那份悄悄留下，越积越长）', STORE, (src) =>
  src.replace(
    '      session.reference = clean;',
    "      session.reference = { ...clean, text: `${session.reference?.text ?? ''}\\n\\n${clean.text}` };",
  ),
);

runner.run('确认之后材料根本没挂上（界面看着像生效了）', APP, (src) =>
  src.replace('  // 有消息 + 就地生效：什么都不用做 —— 材料本来就属于这个会话\n  store.setReference(reference);', ''),
);

// ---- 就地生效这条新路：三种打掉它的方式
//
// 「引用」现在既能在当前会话里就地生效，也能带着它另开一个会话。下面四条把这两条路
// 和它们的差别各打掉一次 —— 少了任何一条，用户就会拿回一个错的（或者丢东西的）行为。

runner.run('就地生效又变回「总是另开一个新会话」（后面聊的东西留在别处了）', APP, (src) =>
  src.replace('function applyReference(reference, { newSession = false } = {}) {\n  if (newSession) {',
    'function applyReference(reference, { newSession = false } = {}) {\n  if (true) {'),
);

runner.run('就地生效却走了「切会话」那套收尾（顺手丢掉输入区挂着的引用回答）', APP, (src) =>
  src.replace(
    '  const first = store.session.messages.length === 0;\n  paintReferenceNote();',
    '  const first = store.session.messages.length === 0;\n  renderAfterSessionSwitch();\n  paintReferenceNote();',
  ),
);

runner.run('空白会话里也塞一个「带着它开一个新会话」（两条路本来是同一件事）', APP, (src) =>
  src.replace(
    '    els.referenceNewSessionLink.hidden = store.session.messages.length === 0;',
    '    els.referenceNewSessionLink.hidden = false;',
  ),
);

runner.run('「带着它开一个新会话」点了却不开新会话（次要入口成了摆设）', APP, (src) =>
  src.replace(
    "els.referenceNewSessionLink?.addEventListener('click', () => void submitReference({ newSession: true }));",
    "els.referenceNewSessionLink?.addEventListener('click', () => void submitReference());",
  ),
);

runner.run('「移除材料」只是把标注条藏起来（下一轮照样带上）', APP, (src) =>
  src.replace('  if (!store.session.reference) return;\n  store.clearReference();', '  if (!store.session.reference) return;'),
);

runner.run('勾选轮次不起作用（勾了也等于没勾）', APP, (src) =>
  src.replace(
    '  draft.numbers = box.checked\n    ? [...new Set([...draft.numbers, number])].sort((a, b) => a - b)\n    : draft.numbers.filter((n) => n !== number);',
    '  draft.numbers = draft.numbers;',
  ),
);

runner.run('超过 3 轮时不说「原文」档走不通（让用户白点一次）', APP, (src) =>
  src.replace(
    '    if (picked > MAX_REFERENCE_TURNS || (!picked && pairs.length > MAX_REFERENCE_TURNS)) {',
    '    if (false) {',
  ),
);

runner.run('「材料形式」下拉框不跟着草稿走（面板上写着「原文」，实际按「摘要」走）', APP, (src) =>
  src.replace("  if (els.referenceKind) els.referenceKind.value = runtime.referenceDraft.kind;\n", ''),
);

runner.run('「改选轮次」不带回上次勾的轮次（回来是一片空勾选框）', APP, (src) =>
  src.replace(
    'openReferencePanel({ sourceId: reference.sessionId, kind: reference.kind, numbers: reference.turns });',
    'openReferencePanel({ sourceId: reference.sessionId, kind: reference.kind, numbers: [] });',
  ),
);

runner.run('源会话被删掉后不清旧轮次号（在新会话上勾出用户没勾过的轮次）', APP, (src) =>
  src.replace(
    "  if (!sessions.some((s) => s.id === draft.sourceId)) {\n    draft.sourceId = sessions[0]?.id ?? '';\n    draft.numbers = [];\n  }",
    "  if (!sessions.some((s) => s.id === draft.sourceId)) draft.sourceId = sessions[0]?.id ?? '';",
  ),
);

runner.run('轮次行不标页数（用户不知道这一轮被编辑过、材料只取了最后一页）', APP, (src) =>
  src.replace(
    "      const pages = pair.pages > 1 ? `（${pair.pages} 页）` : '';",
    "      const pages = '';",
  ),
);

runner.run('页数标到问题后面（长问题会把它挤到省略号外，等于没标）', APP, (src) =>
  src.replace(
    '      text.textContent = `第 ${pair.number} 轮${pages} · ${preview}`;',
    '      text.textContent = `第 ${pair.number} 轮 · ${preview}${pages}`;',
  ),
);

// 靶点要写足上下文：JS 的 String.replace 传字符串时**只替换第一处匹配** ——
// `if (draft.kind === 'turns') {` 在 app.js 里出现两次（状态行那处在前、确认那处在后），
// 只写这一行的话打到的是状态行，标题里说的「去调模型」根本没发生
//（这条是我自己写的变异，被 .tmp-mutations/one-mutation.mjs 单条复核抓出来的）。
runner.run('「原文」档也走摘要（选了原文却去调模型）', APP, (src) =>
  src.replace(
    "  if (draft.kind === 'turns') {\n    const plan = referencePlan({ source, kind: 'turns', numbers });",
    "  if (false) {\n    const plan = referencePlan({ source, kind: 'turns', numbers });",
  ),
);

runner.run('面板说明里不提「带的是最新那一页」', HTML, (src) =>
  src.replace(
    '\n              某一轮被编辑重发过多次时，材料带的是**最新那一页**（轮次后面标着「N 页」）。',
    '',
  ),
);

runner.run('面板说明里不提「确认后挂在当前这个会话上」（就地生效那条路没人知道）', HTML, (src) =>
  src.replace('\n              确认后它挂在**当前这个会话**上、从下一轮开始生效；已经聊过的会话里，', ''),
);

// ---- 会话栏顶部的两个入口（新建 / 引用）：同一件事在两个地方要长得一样

runner.run('收起列表时不露出「引用会话」的备用入口（收起就引用不了）', APP, (src) =>
  src.replace('  if (els.referenceCompact) els.referenceCompact.hidden = visible;\n', ''),
);

runner.run('「引用会话」改回一行小字（同一件事两个地方两个样）', HTML, (src) =>
  src.replace('class="ghost-button rail-reference"', 'class="link-button rail-reference"'),
);

runner.run('两个入口不再并排（新对话自己占满一行）', CSS, (src) =>
  src.replace('.rail-actions {\n  display: flex;', '.rail-actions {\n  display: block;'),
);

runner.finish();
