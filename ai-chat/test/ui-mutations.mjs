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

// ---- 报头：高度恒定 + 不透明
//
// 这两条是用户明确提的：正文滚动时**会话列表不能跟着动**（它的吸顶偏移按报头高度算），
// 而且**正文不许从标题下面透出来**。以前那套「滚下去自动收窄」就是为了这个被去掉的 ——
// 下面这些变异把「偷偷把收窄/半透明加回来」和「高度又被滚动改」各打掉一次。

runner.run('把滚动收窄那套样式加回来（报头高度又会随滚动变）', CSS, (src) =>
  src.replace(
    '  overflow-anchor: none;\n}',
    '  overflow-anchor: none;\n}\n\n.masthead[data-compact="true"] {\n  padding-bottom: 8px;\n}',
  ),
);

runner.run('代码里又去按滚动改报头状态（会话列表跟着跳）', APP, (src) =>
  src.replace(
    '  const height = Math.round(els.masthead.offsetHeight) || 108;',
    "  els.masthead.dataset.compact = window.scrollY > 80 ? 'true' : 'false';\n  const height = Math.round(els.masthead.offsetHeight) || 108;",
  ),
);

runner.run('报头改回半透明 + 模糊（正文的字从标题下面透出来）', CSS, (src) =>
  src.replace(
    '  background: var(--paper);\n  /*\n   * 报头**高度恒定**',
    '  background: color-mix(in srgb, var(--paper) 88%, transparent);\n  backdrop-filter: blur(8px);\n  /*\n   * 报头**高度恒定**',
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
  // 列宽现在走 var(--rail-w)（这里是 .board 那处，第一处），并成一栏 = 只留 1fr
  src.replace(
    '  grid-template-columns: var(--rail-w, 292px) minmax(0, 1fr);',
    '  grid-template-columns: minmax(0, 1fr);',
  ),
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
  // 列宽现在走 var(--rail-w)：改窄 = 这一处写死成别的值（两处就错位了）
  src.replace(
    '  grid-template-columns: var(--rail-w, 292px) minmax(0, 1fr);\n  column-gap: 28px;\n  align-items: end;',
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

// ---- 引用面板 / 材料条的位置：贴在输入区那一边，不是正文最上面
//
// 「搬回正文最上面」这种事没法用一个 replace 表达，所以写了个小工具：把 [from, to)
// 这一段原样搬到 <div class="stage"> 的后面 —— 也就是它以前待的地方。

function moveBackToTop(src, from, to) {
  const start = src.indexOf(from);
  if (start < 0) return src;
  const end = src.indexOf(to, start);
  if (end < 0) return src;
  const block = src.slice(start, end + to.length);
  const marker = '        <div class="stage">\n';
  return src
    .replace(block, () => '')
    .replace(marker, () => `${marker}${block}\n`);
}

runner.run('材料条又搬回正文最上面（存量会话里得翻回开头才看得见）', HTML, (src) =>
  moveBackToTop(
    src,
    '            <p class="reference-note" id="reference-note" hidden>',
    'id="reference-note-body" hidden></pre>',
  ),
);

runner.run('引用面板又搬回正文最上面（长会话里点开像没反应）', HTML, (src) =>
  moveBackToTop(
    src,
    '          <section class="reference-panel" id="reference-panel" hidden',
    '</section>',
  ),
);

runner.run('打开引用面板不滚进可视区（长会话里点了就是没反应）', APP, (src) =>
  src.replace("  els.referencePanel.scrollIntoView?.({ block: 'nearest' });\n", ''),
);

runner.run('输入区不再贴底（材料条跟着滚走，「永远在眼前」就没了）', CSS, (src) =>
  src.replace('.composer {\n  position: sticky;\n  bottom: 0;', '.composer {\n  position: static;'),
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

// ---- 会话标题太长：两行 + 悬停看全文
//
// 会话栏 292px、标题上限 60 字，一行只放得下约 20 个汉字 —— 这 8 条把「看全标题」的
// 每一环各打掉一次：两行、悬停、只在截断时弹、延迟收起、移进浮层取消收起、
// 滚动与重画时收起、原生 title 兜底。

runner.run('标题改成两行（行高参差不齐、列表被撑高，用户明确否掉）', CSS, (src) =>
  src.replace(
    '.session-name {\n  display: block;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;',
    '.session-name {\n  display: -webkit-box;\n  -webkit-line-clamp: 2;\n  -webkit-box-orient: vertical;\n  overflow: hidden;\n  white-space: nowrap;',
  ),
);

runner.run('长标题末尾不给省略号（硬切一刀，看不出还有内容）', CSS, (src) =>
  src.replace(
    '.session-name {\n  display: block;\n  overflow: hidden;\n  text-overflow: ellipsis;',
    '.session-name {\n  display: block;\n  overflow: hidden;',
  ),
);

runner.run('悬停不给完整标题（长标题还是看不全）', APP, (src) =>
  src.replace(
    "els.sessionList.addEventListener('mouseover', (event) => {\n  const row = event.target.closest?.('.session-item');\n  if (row) showTitleFloat(row);\n});\n",
    '',
  ),
);

runner.run('不看是否被截断，一律弹卡片（没截断也弹 = 噪音）', APP, (src) =>
  src.replace('  if (!name || !text || !isTitleClipped(name)) {', '  if (!name || !text) {'),
);

runner.run('离开那一行不收起（浮层赖着不走）', APP, (src) =>
  src.replace(
    "els.sessionList.addEventListener('mouseout', (event) => {\n  const row = event.target.closest?.('.session-item');\n  if (!row) return;\n  // 在同一行内部移动（行 → 标题 → 元信息）不算离开\n  const to = event.relatedTarget;\n  if (to && row.contains?.(to)) return;\n  scheduleHideTitleFloat();\n});\n",
    '',
  ),
);

runner.run('一离开就立刻收起（没时间把鼠标移进浮层，文字就选不中了）', APP, (src) =>
  src.replace(
    '  titleFloatTimer = setTimeout(() => {\n    titleFloatTimer = null;\n    if (els.titleFloat) els.titleFloat.hidden = true;\n  }, 160);',
    '  titleFloatTimer = null;\n  if (els.titleFloat) els.titleFloat.hidden = true;',
  ),
);

runner.run('滚动时浮层不收（位置变了还留在原地指错）', APP, (src) =>
  src.replace("els.sessionList.addEventListener('scroll', hideTitleFloat, true);\n", ''),
);

runner.run('列表重画时浮层不收（那一行可能已经不在了）', APP, (src) =>
  src.replace('  hideTitleFloat(); // 列表要重画了，浮出来的完整标题立刻失去意义\n', ''),
);

runner.run('不给原生 title 兜底（触摸屏和屏幕阅读器就没有出口了）', APP, (src) =>
  // 靶点跟着 sessionRow 的写法挪过一次：它现在把字段写在 item 上（`name` 是那一个 span），
  // 不再是 `frag.querySelector(...)` —— 替换没匹配上源码时 harness 会直接报「变异没生效」
  src.replace(
    "  // 原生 title 是最底层兜底（屏幕阅读器、触摸屏、以及我们的浮层没跑起来的任何情况）\n  name.title = fullTitle;\n",
    '',
  ),
);

// ---- 会话行尾的「⋯」菜单
//
// 那四个文字按钮**常驻行尾**时（只做了 opacity: 0，宽度照占），292px 的行被吃掉约 145px，
// 标题只剩六七个字。下面这些把「收进菜单」这件事的每一环各打掉一次。

runner.run('四个功能又搬回行里常驻（标题只剩六个字）', HTML, (src) => {
  // 把四个条目从菜单里拿出来，直接挂在行里 —— 回到"常驻"那种写法
  const open = '<span class="session-menu" role="menu" hidden>\n';
  const at = src.indexOf(open);
  if (at < 0) return src;
  const close = src.indexOf('</span>', at);
  if (close < 0) return src;
  const inner = src.slice(at + open.length, close);
  return `${src.slice(0, at)}${inner}${src.slice(close + '</span>\n'.length)}`;
});

runner.run('点「⋯」不弹菜单（四个功能没有入口了）', APP, (src) =>
  src.replace(
    "  if (action === 'more') {\n    openSessionMenuFor(item, event.target.closest('[data-action=\"more\"]'));\n    return;\n  }\n",
    '',
  ),
);

runner.run('点菜单外面不收起（菜单赖着不走）', APP, (src) =>
  src.replace(
    "  if (!event.target.closest('.session-menu') && !event.target.closest('[data-action=\"more\"]')) {\n    closeSessionMenu();\n  }\n",
    '',
  ),
);

runner.run('按 Esc 不收起菜单', APP, (src) => src.replace('  closeSessionMenu();\n  hideTitleFloat();\n', '  hideTitleFloat();\n'));

runner.run('列表滚动时菜单不收（位置变了还留在原地指错）', APP, (src) =>
  src.replace("els.sessionList.addEventListener('scroll', closeSessionMenu, true);\n", ''),
);

runner.run('列表重画时菜单不收（里面的按钮已经换成新节点了）', APP, (src) =>
  src.replace('  closeSessionMenu(); // 菜单里的按钮也一起被重画，留着就是指向已消失的节点\n', ''),
);

runner.run('菜单塞在行里（absolute 会被列表的 overflow 裁掉）', CSS, (src) =>
  src.replace('.session-menu {\n  position: fixed;', '.session-menu {\n  position: absolute;'),
);

runner.run('「⋯」做成四个文字按钮那么宽（又把行宽吃回去了）', CSS, (src) =>
  // 靶点跟过两次：先是 .session-tools 那一组，后来 margin-right 挪到了 .session-slot 上
  src.replace('  width: 26px;\n  height: 26px;\n  padding: 0;', '  width: 145px;\n  height: 26px;\n  padding: 0;'),
);

// 措辞是用户定过的（「重命名」/「自动命名」），改回去也得被抓住 ——
// 这两条守的不是功能，是「菜单上写的那几个字不许自己漂回去」。
runner.run('菜单上的措辞改回「改名」「AI 起名」', HTML, (src) =>
  src
    .replace('>重命名</button>', '>改名</button>')
    .replace('>自动命名</button>', '>AI 起名</button>'),
);

runner.run('气泡提示里又把这件事叫「起名」', APP, (src) =>
  src.replace("flashHint('正在自动命名…', 1600);", "flashHint('正在让 AI 起名…', 1600);"),
);

runner.run('「重命名」的对话框又写回「起个名字」', APP, (src) =>
  // 这条专门盯「不许出现改名叫起名」那条断言抓不住的说法：旧文案里没有「起名」两个字
  src.replace("window.prompt('给这个会话换个名字'", "window.prompt('给这个对话起个名字'"),
);

// ---- 会话栏宽度可拖（写 --rail-w，两处栅格共用）

runner.run('拖了没反应（pointermove 不处理）', APP, (src) =>
  src.replace(
    "  els.railResizer.addEventListener('pointermove', (event) => {\n    if (!drag) return;\n    setRailWidth(drag.startWidth + (event.clientX - drag.startX));\n  });\n",
    '',
  ),
);

runner.run('宽度不夹上下限（能拖到 20px 或 2000px）', APP, (src) =>
  src.replace('  return Math.min(railWidthMax(), Math.max(RAIL_WIDTH_MIN, n));', '  return n;'),
);

runner.run('宽度不记住（刷新又回 292）', APP, (src) => src.replace('  if (persist) writeRailWidth(w);\n', ''));

runner.run('双击不回默认宽度', APP, (src) =>
  src.replace(
    "  els.railResizer.addEventListener('dblclick', () => {\n    setRailWidth(RAIL_WIDTH_DEFAULT);\n    flashHint(`会话栏宽度已回到默认（${RAIL_WIDTH_DEFAULT}px）`, 2200);\n  });\n",
    '',
  ),
);

runner.run('键盘调不了宽度（只能用鼠标）', APP, (src) =>
  src.replace(
    "  els.railResizer.addEventListener('keydown', (event) => {\n    const step = event.shiftKey ? 24 : 8;",
    "  els.railResizer.addEventListener('keydown', (event) => {\n    if (true) return;\n    const step = event.shiftKey ? 24 : 8;",
  ),
);

runner.run('窄屏也允许拖（单列布局里没有「缝」可拖）', APP, (src) =>
  src.replace('    if (Number(window.innerWidth) <= 1000) return;\n', ''),
);

runner.run('报头那格没跟着用 --rail-w（拖了之后报头和正文错位）', CSS, (src) =>
  src.replace(
    '  grid-template-columns: var(--rail-w, 292px) minmax(0, 1fr);\n  column-gap: 28px;\n  align-items: end;',
    '  grid-template-columns: 292px minmax(0, 1fr);\n  column-gap: 28px;\n  align-items: end;',
  ),
);

runner.run('值没变也照写 CSS 变量（每拖一下都写一遍 DOM）', APP, (src) =>
  src.replace(
    "  if (w !== lastRailWidth) {\n    lastRailWidth = w;\n    document.documentElement.style.setProperty('--rail-w', `${w}px`);\n  }",
    "  lastRailWidth = w;\n  document.documentElement.style.setProperty('--rail-w', `${w}px`);",
  ),
);

runner.run('窄屏上还显示拖拽手柄（那边拖它没有意义）', CSS, (src) =>
  src.replace('  .rail-resizer {\n    display: none;\n  }\n', ''),
);

// ---- 行尾那个「多久没动了」：平时显示时间，悬停原地换成「⋯」

runner.run('行尾不显示时间（槽位空着）', HTML, (src) =>
  src.replace('          <span class="session-age" data-field="age"></span>\n', ''),
);

runner.run('悬停时不换成「⋯」（时间和三个点叠在一起）', CSS, (src) =>
  src.replace(
    '.session-item:hover .session-age,\n.session-item:focus-within .session-age,\n.session-more[aria-expanded="true"] ~ .session-age {\n  opacity: 0;\n}\n',
    '',
  ),
);

runner.run('槽位宽度不固定（悬停那一下标题会重新截断）', CSS, (src) =>
  // 必须**改写**那句声明：插一句 width: auto 在前面没用（CSS 后者生效，变异等于没生效 —— 我第一版就是这么写的）
  src.replace('  width: 52px;\n  height: 26px;\n  margin: 5px 4px 0 0;', '  width: auto;\n  height: 26px;\n  margin: 5px 4px 0 0;'),
);

runner.run('触摸屏上时间和「⋯」叠在一起', CSS, (src) =>
  src.replace(
    '@media (hover: none) {\n  .session-more {\n    opacity: 1;\n  }\n  .session-age {\n    opacity: 0;\n  }\n}',
    '@media (hover: none) {\n  .session-more {\n    opacity: 1;\n  }\n}',
  ),
);

runner.run('时间那块挡住「⋯」（真人点三个点没反应）', CSS, (src) =>
  src.replace(
    '  transition: opacity 0.15s ease;\n  pointer-events: none; /* 为什么必须有这一行，见下 */\n',
    '  transition: opacity 0.15s ease;\n',
  ),
);

runner.run('「多久了」算错档（把分钟当成小时）', APP, (src) =>
  src.replace('  const hours = Math.floor(minutes / 60);', '  const hours = Math.floor(minutes / 6000);'),
);

runner.run('时间用创建时间而不是最后活动时间（刚发过消息的会话还显示「3 天前」）', APP, (src) =>
  src.replace("  if (age) age.textContent = formatAge(session.updatedAt);", "  if (age) age.textContent = formatAge(session.createdAt);"),
);

// ---- 正文的渲染窗口（只画最近 20 轮，更早的按需补）
//
// 这里每一条对应 ⑳ 里的一组断言。最要紧的是**分页不许渗进数据**：
// 但只要窗口算错、编号算错、补历史不锚定，用户当场就能看出来，所以都各打掉一次。

runner.run('正文一次画全部轮次（分页形同虚设，几百轮照样一次建完）', APP, (src) =>
  src.replace(
    '  const visible = hidden > 0 ? assistants.slice(hidden) : assistants;',
    '  const visible = assistants;',
  ),
);

runner.run('编号按窗口重新排（第 26 轮显示成第 1 轮）', APP, (src) =>
  src.replace('    const { node } = buildTurnNode(message, hidden + index + 1);', '    const { node } = buildTurnNode(message, index + 1);'),
);

runner.run('不画「更早的 N 轮」（藏起来的历史没有入口）', APP, (src) =>
  src.replace(
    '  if (hidden > 0) {\n    const earlier = buildEarlierNode(hidden);\n    if (earlier) els.exchanges.appendChild(earlier);\n  }\n',
    '',
  ),
);

runner.run('点「更早的」没反应（画了个死按钮）', APP, (src) =>
  src.replace("  if (action.dataset.action === 'earlier') {\n    expandTranscript();\n    return;\n  }\n", ''),
);

runner.run('点「更早的」不往前推进（永远停在 20 轮）', APP, (src) =>
  src.replace('  transcriptWindow += TRANSCRIPT_PAGE;', '  transcriptWindow = TRANSCRIPT_PAGE;'),
);

runner.run('补历史之后不锚定（正在看的那一行被顶走）', APP, (src) =>
  src.replace('  if (Number.isFinite(delta) && delta > 0) window.scrollBy?.(0, delta);\n', ''),
);

runner.run('滚到最上面也不自动补一段', APP, (src) =>
  src.replace("window.addEventListener('scroll', maybeLoadEarlier, { passive: true });\n", ''),
);

runner.run('换会话不复位窗口（这个会话展开的，跑到别的会话上还算数）', APP, (src) =>
  src.replace(
    '  if (transcriptSessionId !== store.sessionId) {\n    transcriptSessionId = store.sessionId;\n    transcriptWindow = TRANSCRIPT_PAGE;\n  }\n',
    '',
  ),
);

runner.run('压缩界线落在窗口之上时标记干脆不画（凭空消失）', APP, (src) =>
  src.replace(
    '  if (boundary && hidden > 0 && !visible.includes(boundary)) {\n    const note = buildContextNote(summary);\n    if (note) els.exchanges.appendChild(note);\n  }\n',
    '',
  ),
);

// ---- 会话列表：「最近」这一组默认只显示几个
//
// 它是个**纯显示开关**，所以这里守的是三件事：默认确实只画几个、当前会话不许被藏掉、
// 计数与总数说的是真话（数字不许跟着「画了几行」走）。

runner.run('「最近」不裁（十几二十个会话照样一次全铺出来）', APP, (src) =>
  src.replace(
    '    const visible = name === \'recent\' && !recentShowAll ? trimRecentRows(rows, activeId) : rows;',
    '    const visible = rows;',
  ),
);

runner.run('连「置顶」那一组也裁（用户说重要的东西被藏了）', APP, (src) =>
  src.replace(
    "    const visible = name === 'recent' && !recentShowAll ? trimRecentRows(rows, activeId) : rows;",
    "    const visible = name === 'pinned' && !recentShowAll ? trimRecentRows(rows, activeId) : rows;",
  ),
);

runner.run('组标题上的条数跟着「画了几行」走（藏起来的那几个不算数了）', APP, (src) =>
  src.replace(
    '    group.count.textContent = String(rows.length);',
    '    group.count.textContent = String(Math.min(rows.length, RECENT_VISIBLE));',
  ),
);

runner.run('当前会话不在前几个时干脆不画（刷新之后像会话丢了）', APP, (src) =>
  src.replace('  return current ? [...head, current] : head;', '  return head;'),
);

runner.run('点「显示全部」没反应', APP, (src) =>
  src.replace(
    "els.groupRecent?.more?.addEventListener('click', () => {\n  recentShowAll = !recentShowAll;\n  writeGroupPreference();\n  renderSessionList();\n});\n",
    '',
  ),
);

runner.run('展开状态不记住（刷新又回到 6 个）', APP, (src) =>
  src.replace(
    'localStorage.setItem(RAIL_GROUPS_KEY, JSON.stringify({ ...groupCollapsed, recentAll: recentShowAll }));',
    'localStorage.setItem(RAIL_GROUPS_KEY, JSON.stringify(groupCollapsed));',
  ),
);

runner.run('「最近」整组收起来时，这个按钮还留在下面', APP, (src) =>
  src.replace(
    "  // 搜索时列表是平铺的结果，这个按钮同样没有存在的理由\n  button.hidden = searchQuery !== '' || groupCollapsed.recent === true;",
    '  button.hidden = false;',
  ),
);

runner.run('展开那一组之后按钮不回来（收起再展开就再也点不到了）', APP, (src) =>
  src.replace(
    '  // 「显示全部」那个按钮跟着这一组的收起状态走（收起时藏、展开时按有没有藏东西放回来）\n  paintRecentMore();\n',
    '',
  ),
);

runner.run('会话本来就不多时也摆一个「显示全部」（没东西可显示）', APP, (src) =>
  src.replace(
    '  if (total <= RECENT_VISIBLE) {\n    button.hidden = true;\n    return;\n  }\n',
    '',
  ),
);

// ---- 搜索会话（标题 + 正文，全局匹配）
//
// 搜索最容易出的两类问题是：**漏**（正文里明明有却搜不到、旧版本搜不到）和
// **多**（把不相干的会话也塞进来、或者搜索时硬塞当前会话）。两条都各打掉一次。

runner.run('搜索只看标题（正文里写过的字搜不到）', APP, (src) =>
  src.replace(
    "      String(session.title ?? '').toLowerCase().includes(needle)\n      || session.messages.some((message) => messageTexts(message).some((text) => text.includes(needle))),\n",
    "      String(session.title ?? '').toLowerCase().includes(needle),\n",
  ),
);

runner.run('只搜当前那一版（编辑过的旧版本里的字搜不到）', APP, (src) =>
  src.replace(
    'return [message.content, ...(message.versions ?? []).map((v) => v?.content)].map((text) =>',
    'return [message.content].map((text) =>',
  ),
);

runner.run('标题匹配区分大小写（输入 react 搜不到「React」）', APP, (src) =>
  src.replace(
    "      String(session.title ?? '').toLowerCase().includes(needle)",
    "      String(session.title ?? '').includes(needle)",
  ),
);

runner.run('打字没反应（输入框不接事件）', APP, (src) =>
  src.replace(
    "els.searchInput?.addEventListener('input', () => {\n  searchQuery = els.searchInput.value ?? '';\n  renderSessionList();\n});\n",
    '',
  ),
);

runner.run('Esc 不清空输入框', APP, (src) =>
  src.replace(
    "els.searchInput?.addEventListener('keydown', (event) => {\n  if (event.key !== 'Escape') return;\n  els.searchInput.value = '';\n  searchQuery = '';\n  renderSessionList();\n});\n",
    '',
  ),
);

runner.run('搜索结果区赖着不走（清空了还占着位置）', APP, (src) =>
  src.replace('  box.section.hidden = hits === null;', '  box.section.hidden = false;'),
);

runner.run('搜索时两组不让位（结果下面还堆着原来的分组）', APP, (src) =>
  src.replace(
    '    group.section.hidden = hits !== null || rows.length === 0;',
    '    group.section.hidden = rows.length === 0;',
  ),
);

runner.run('搜索结果里硬塞当前会话（它跟这段字没关系）', APP, (src) =>
  src.replace(
    '  box.list.replaceChildren(...hits.map((session) => sessionRow(session, activeId)));',
    '  box.list.replaceChildren(...[...hits, store.session].filter(Boolean).map((session) => sessionRow(session, activeId)));',
  ),
);

runner.run('一个都没搜到时给个空列表，不说一句话', APP, (src) =>
  src.replace('  if (box.empty) box.empty.hidden = hits.length > 0;', '  if (box.empty) box.empty.hidden = true;'),
);

runner.run('搜索时「显示全部」还露着（这时候它没有意义）', APP, (src) =>
  src.replace(
    "  button.hidden = searchQuery !== '' || groupCollapsed.recent === true;",
    '  button.hidden = groupCollapsed.recent === true;',
  ),
);

// ---- 宽度的账：正文「有上限、可收窄」+ 输入区跟正文同一条版心
//
// 用户报的两个现象（正文甩出版心、输入框比正文宽）都源于宽度没对齐，这里每一条各打掉一处。

runner.run('正文轨道改回固定宽度（容器一窄就横向溢出，不再收窄换行）', CSS, (src) =>
  src.replace(
    '  grid-template-columns: var(--margin-col) minmax(0, var(--text-col)) 1fr;',
    '  grid-template-columns: var(--margin-col) var(--text-col) 1fr;',
  ),
);

runner.run('页宽公式又写死会话栏宽度（拖宽会话栏 = 从正文身上割肉）', CSS, (src) =>
  src.replace('var(--rail-w, 292px) + 28px + var(--margin-col)', '292px + 28px + var(--margin-col)'),
);

runner.run('页宽公式漏掉一道缝（正文照样差 24px 装不下）', CSS, (src) =>
  src.replace('var(--text-col) + var(--gap-col) +', 'var(--text-col) +'),
);

runner.run('输入区不跟正文同版心（收起会话栏就横着拉出去）', CSS, (src) =>
  src.replace(
    '.composer > * {\n  margin-left: calc(var(--margin-col) + var(--gap-col));\n  max-width: var(--text-col);\n}\n',
    '',
  ),
);

runner.run('输入区内容不左对齐（和正文栏错开一个页边栏）', CSS, (src) =>
  src.replace(
    '.composer > * {\n  margin-left: calc(var(--margin-col) + var(--gap-col));\n',
    '.composer > * {\n',
  ),
);

runner.run('输入区那一排按钮不换行（版心收窄时就横向挤出去）', CSS, (src) =>
  src.replace('  flex-wrap: wrap;\n  padding-top: 9px;\n', '  padding-top: 9px;\n'),
);

runner.run('长串不按字符换行（URL 把版心撑破）', CSS, (src) =>
  src.replace('  /* 断不开的长串（URL、一长串英文/代码）按字符换行，别把版心撑破 */\n  overflow-wrap: break-word;\n', ''),
);

runner.run('会话栏拖拽的下限又回到 320px（正文被压成一条）', APP, (src) =>
  src.replace('const RAIL_TRANSCRIPT_MIN = 640;', 'const RAIL_TRANSCRIPT_MIN = 320;'),
);

runner.finish();
