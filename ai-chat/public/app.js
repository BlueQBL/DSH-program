// 对谈录 · 前端主程序
//
// 一条消息从输入到落盘的完整路径：
//   输入框（可选图片 / 语音）→ store.pushUser（立刻落盘）
//          → store.pushAssistant（占位，状态 streaming）
//          → POST /api/chat，逐帧读 SSE
//          → 每帧 appendDelta（边写边落盘，刷新也能看到半截文字）
//          → store.finish（状态 done / error / interrupted）
//
// 渲染用的是「一帧一渲染」而不是每个 token 都动 DOM：
// SSE 的到达节奏不可控，用 requestAnimationFrame 合并，界面才稳。
//
// 职责划分：本文件只做编排与渲染；角色库、图片压缩、语音、导出各自在
// public/lib/ 下独立成模块，便于单独测试。

import { renderMarkdown, markdownToPlain } from './lib/markdown.js';
import { createStore } from './lib/store.js';
import { PERSONAS, CUSTOM_PERSONA_ID, DEFAULT_PERSONA_ID, getPersona, personaLabel, resolveSystemPrompt } from './lib/personas.js';
import {
  compressImage,
  imageFilesFromClipboard,
  imageFilesFromDrop,
  toAttachment,
  MAX_IMAGES,
} from './lib/attachments.js';
import { createSpeechInput, isSpeechSupported, unsupportedReason } from './lib/speech.js';
import { toMarkdown, toPlainText, toJson, download, suggestedFilename } from './lib/exporters.js';
import { supportsVision } from './lib/vision.js';
import {
  resolveShownPage,
  totalPages,
  versionBarItems,
  versionLabel,
  editOutcome,
  editHint,
  buildRequestHistory,
} from './lib/versions.js';
import {
  resolveStartingSession as resolveStartingSessionDecide,
  shouldCreateSession,
  startNotice,
} from './lib/startup.js';

const els = {
  board: document.getElementById('board'),
  sidebarToggle: document.getElementById('sidebar-toggle'),
  sessionList: document.getElementById('session-list'),
  sessionCount: document.getElementById('session-count'),
  sessionTemplate: document.getElementById('session-template'),
  newSession: document.getElementById('new-session-button'),
  exportAll: document.getElementById('export-all-button'),

  modeChip: document.getElementById('mode-chip'),
  modeLabel: document.getElementById('mode-label'),
  personaSelect: document.getElementById('persona-select'),
  personaHint: document.getElementById('persona-hint'),
  modelSelect: document.getElementById('model-select'),
  pickerLoading: document.getElementById('picker-loading'),
  promptToggle: document.getElementById('prompt-toggle'),
  promptPanel: document.getElementById('prompt-panel'),
  promptClose: document.getElementById('prompt-close'),
  promptClose2: document.getElementById('prompt-close-2'),
  promptInput: document.getElementById('prompt-input'),
  promptChars: document.getElementById('prompt-chars'),
  promptReset: document.getElementById('prompt-reset'),
  promptSave: document.getElementById('prompt-save'),

  notice: document.getElementById('notice'),
  exchanges: document.getElementById('exchanges'),
  blank: document.getElementById('blank-sheet'),
  starters: document.getElementById('starters'),
  exchangeTemplate: document.getElementById('exchange-template'),
  reachBottom: document.getElementById('reach-bottom'),
  jumpBottom: document.getElementById('jump-bottom'),

  composer: document.getElementById('composer'),
  input: document.getElementById('composer-input'),
  send: document.getElementById('send-button'),
  stop: document.getElementById('stop-button'),
  hint: document.getElementById('composer-hint'),
  clear: document.getElementById('clear-button'),
  confirmStrip: document.getElementById('confirm-strip'),
  confirmText: document.getElementById('confirm-text'),
  confirmClear: document.getElementById('confirm-clear'),
  cancelClear: document.getElementById('cancel-clear'),

  imageButton: document.getElementById('image-button'),
  imageInput: document.getElementById('image-input'),
  attachmentStrip: document.getElementById('attachment-strip'),
  attachmentTemplate: document.getElementById('attachment-template'),
  voiceButton: document.getElementById('voice-button'),

  exportButton: document.getElementById('export-button'),
  exportPopup: document.getElementById('export-popup'),
};

const store = createStore();

const MODEL_PREF_KEY = 'duitanlu.model.v1';

function readModelPreference() {
  try {
    const saved = localStorage.getItem(MODEL_PREF_KEY);
    return saved && /^[A-Za-z0-9._:\/-]{1,80}$/.test(saved) ? saved : '';
  } catch {
    return '';
  }
}

function writeModelPreference(model) {
  try {
    if (model) localStorage.setItem(MODEL_PREF_KEY, model);
    else localStorage.removeItem(MODEL_PREF_KEY);
  } catch {
    /* 隐私模式下忽略 */
  }
}

/** 运行期状态（不落盘） */
const runtime = {
  config: { mode: 'unknown', model: null, hint: null },
  busy: false,
  controller: null,
  liveTurn: null,
  renderNode: null,
  activeModel: null,
  frameHandle: null,
  pinned: true,
  serverDefaultModel: null,
  availableModels: [],
  chosenModel: readModelPreference(),
  pendingImages: [],
  exportAll: false,
  pendingDelete: null,
  speech: null,
  listening: false,
};

/**
 * 下次 renderControls() 是否强制刷新提示词框。
 * 换会话 / 换角色时置真 —— 这两种情况下文本框必须显示新对象的提示词，
 * 不能被「正在聚焦就不覆盖」的守卫挡住。
 */
let forcePromptText = false;

// ---------------------------------------------------------------- 小工具

function formatClock(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatKb(chars) {
  return `${Math.max(1, Math.round(chars / 1024))}KB`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function flashHint(text, ms = 2200) {
  els.hint.textContent = text;
  clearTimeout(flashHint.timer);
  flashHint.timer = setTimeout(() => {
    els.hint.textContent = defaultHint();
  }, ms);
}

function defaultHint() {
  if (runtime.listening) return '正在听…再点一次「结束」';
  if (runtime.busy) return '正在生成…按 Esc 可以停下来';
  return 'Enter 发送 · Shift + Enter 换行';
}

// ---------------------------------------------------------------- 滚动

function distanceFromBottom() {
  return document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
}

function scrollToBottom(behavior = 'auto') {
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
}

function updatePinned() {
  const far = distanceFromBottom() > 120;
  runtime.pinned = !far;
  els.reachBottom.hidden = !far;
}

window.addEventListener('scroll', updatePinned, { passive: true });
window.addEventListener('resize', updatePinned);

els.jumpBottom.addEventListener('click', () => {
  scrollToBottom('smooth');
  runtime.pinned = true;
  els.reachBottom.hidden = true;
});

// ---------------------------------------------------------------- 会话列表

function renderSessionList() {
  const sessions = store.sessions;
  const activeId = store.sessionId;

  els.sessionCount.textContent = String(sessions.length);
  els.sessionList.replaceChildren(
    ...sessions.map((session) => {
      const frag = els.sessionTemplate.content.cloneNode(true);
      const item = frag.querySelector('.session-item');
      item.dataset.id = session.id;
      item.dataset.active = String(session.id === activeId);

      frag.querySelector('[data-field="name"]').textContent = session.title || '新对话';
      const turns = session.messages.filter((m) => m.role === 'user').length;
      frag.querySelector('[data-field="meta"]').textContent =
        `${formatClock(session.updatedAt)} · ${turns} 轮 · ${personaLabel(session.personaId)}`;
      return frag;
    }),
  );

  // 只有一个会话时不允许删，按钮就别装作能点
  const deletable = sessions.length > 1;
  for (const button of els.sessionList.querySelectorAll('[data-action="delete"]')) {
    button.disabled = !deletable;
    if (!deletable) button.title = '至少保留一个会话';
  }
}

els.sessionList.addEventListener('click', (event) => {
  const item = event.target.closest('.session-item');
  if (!item) return;
  const id = item.dataset.id;
  const action = event.target.closest('[data-action]')?.dataset.action;

  if (action === 'delete') {
    // 删除不可逆：就地确认，而不是弹一层模态
    runtime.pendingDelete = id;
    const session = store.sessions.find((s) => s.id === id);
    els.confirmText.textContent = `删除「${session?.title || '这个对话'}」后无法找回，确定吗？`;
    els.confirmStrip.hidden = false;
    els.confirmClear.focus();
    return;
  }

  if (action === 'rename') {
    const session = store.sessions.find((s) => s.id === id);
    const next = window.prompt('给这个对话起个名字', session?.title ?? '');
    if (next !== null) {
      store.renameSession(id, next);
      renderAll();
    }
    return;
  }

  // 切到已有对话前，先把「进来时自动开的那个空白会话」清掉 ——
  // 留着它只会让列表里堆一串没用的「新对话」。
  // 注意 keepId：如果点的那个会话本身是空的（也是新建的），要留着它。
  const dropped = store.dropEmptySessions({ keepId: id });

  if (store.switchSession(id)) {
    runtime.pinned = true;
    runtime.liveTurn = null;
    runtime.renderNode = null;
    renderAfterSessionSwitch();
    scrollToBottom();
    els.input.focus();
    if (dropped > 0) flashHint('已清掉空白的「新对话」', 2200);
  }
});

// ---------------------------------------------------------------- 角色与提示词

function fillPersonaSelect() {
  els.personaSelect.replaceChildren(
    ...PERSONAS.map((persona) => {
      const option = document.createElement('option');
      option.value = persona.id;
      option.textContent = persona.name;
      return option;
    }),
  );
}

function renderControls() {
  const session = store.session;
  els.personaSelect.value = session.personaId;

  const persona = getPersona(session.personaId);
  const custom = session.systemPrompt.trim();
  const isCustomPersona = session.personaId === CUSTOM_PERSONA_ID;
  if (isCustomPersona) {
    els.personaHint.textContent = custom
      ? `自定义提示词（${custom.length} 字）· 从下一轮开始生效`
      : '还没写提示词，将使用默认回答要求';
  } else {
    // 在预设角色上改过内容时说清楚「角色没变、只是提示词被你改过」
    els.personaHint.textContent = custom
      ? `${persona.tagline} · 提示词已修改（${custom.length} 字）`
      : persona.tagline;
  }

  // 提示词框显示的是「这个会话真正会用的那段」。
  // 焦点守卫只为「用户正在打字时别被覆盖」——换成别的会话 / 别的角色时必须强制刷新，
  // 否则展开新角色的提示词会看到上一个角色的内容（真踩过）。
  if (forcePromptText || document.activeElement !== els.promptInput) {
    els.promptInput.value = resolveSystemPrompt(session.personaId, session.systemPrompt);
    forcePromptText = false;
  }
  els.promptChars.textContent = String(els.promptInput.value.length);

  const model = session.model || runtime.chosenModel || runtime.serverDefaultModel || '';
  if (model && runtime.availableModels.includes(model)) els.modelSelect.value = model;
  // 顶部标签跟着一起刷新：换会话 / 换模型之后它必须和下拉框一致
  syncModeChip();
}

els.personaSelect.addEventListener('change', () => {
  const id = els.personaSelect.value;
  const persona = getPersona(id);
  // 换角色时清掉手写提示词：否则「角色显示 A、提示词是 B」，两边打架
  store.updateSessionSettings({ personaId: id, systemPrompt: '' });
  forcePromptText = true; // 文本框必须换成新角色的提示词
  renderControls();
  renderSessionList();
  flashHint(
    id === CUSTOM_PERSONA_ID ? '已切到自定义，在提示词里写你的设定' : `已切到「${persona.name}」`,
    2600,
  );
});

/**
 * 提示词面板的唯一开关入口。
 *
 * 收敛成一个函数是有原因的：面板的隐藏状态和按钮的 aria-expanded 必须同步，
 * 分散着设 hidden 迟早有一处会忘。另外「保存后自动收起」这件事以前根本没人做，
 * 用户按了保存之后面板还杵在那儿，只能自己去点一下 —— 现在保存 / 还原都会自动收起。
 */
function setPromptPanelOpen(open) {
  els.promptPanel.hidden = !open;
  els.promptToggle.setAttribute('aria-expanded', String(open));
  if (open) {
    els.promptChars.textContent = String(els.promptInput.value.length);
    els.promptInput.focus();
  }
}

els.promptToggle.addEventListener('click', () => {
  setPromptPanelOpen(els.promptPanel.hidden);
});

// 「只想看看」的出口：收起但什么都不改（不看内容、不保存、不动角色）
els.promptClose.addEventListener('click', () => {
  setPromptPanelOpen(false);
  els.input.focus();
});
els.promptClose2.addEventListener('click', () => {
  setPromptPanelOpen(false);
  els.input.focus();
});

els.promptInput.addEventListener('input', () => {
  els.promptChars.textContent = String(els.promptInput.value.length);
});

els.promptSave.addEventListener('click', () => {
  const session = store.session;
  const edited = els.promptInput.value.trim();

  if (session.personaId !== CUSTOM_PERSONA_ID) {
    // 用的是内置角色。用户可能只是点进来看看，一个字都没改。
    // 这时绝不能把内容存成「自定义提示词」，更不能把角色改成「自定义」——
    // 那等于篡改用户明确选过的角色（之前就是这个 bug）。
    const preset = getPersona(session.personaId).prompt.trim();
    if (edited === preset) {
      // 没改过：什么也不用存，把之前可能残留的自定义内容清掉即可
      if (session.systemPrompt) store.updateSessionSettings({ systemPrompt: '' });
      setPromptPanelOpen(false);
      flashHint(`「${getPersona(session.personaId).name}」的提示词未改动，角色保持不变`, 2800);
      els.input.focus();
      return;
    }
    // 真改过了：内容存下来，角色名保留 —— 用户看到的角色不该被偷偷换掉
    store.updateSessionSettings({ systemPrompt: els.promptInput.value });
    renderControls();
    renderSessionList();
    setPromptPanelOpen(false);
    flashHint('已保存自定义内容，角色仍是' + getPersona(session.personaId).name, 3000);
    els.input.focus();
    return;
  }

  // 当前就是「自定义」角色：直接保存用户写的内容
  store.updateSessionSettings({ systemPrompt: els.promptInput.value });
  renderControls();
  renderSessionList();
  setPromptPanelOpen(false);
  flashHint(edited ? '已保存到本对话，下一轮生效' : '自定义提示词已清空，将使用默认要求', 2800);
  els.input.focus();
});

els.promptReset.addEventListener('click', () => {
  const id = store.session.personaId === CUSTOM_PERSONA_ID ? 'default' : store.session.personaId;
  store.updateSessionSettings({ systemPrompt: '', personaId: id });
  els.promptInput.value = getPersona(id).prompt;
  els.promptChars.textContent = String(els.promptInput.value.length);
  renderControls();
  setPromptPanelOpen(false);
  flashHint('已还原为角色预设', 2600);
});

// ---------------------------------------------------------------- 模型选择

function populateModelPicker(models, current) {
  const options = [...models];
  if (current && !options.includes(current)) options.unshift(current);

  if (!options.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '离线回答（无模型）';
    els.modelSelect.replaceChildren(option);
    return;
  }

  els.modelSelect.replaceChildren(
    ...options.map((id) => {
      const option = document.createElement('option');
      option.value = id;
      // 标出哪些能看图：DeepSeek 全系不支持图片，用户需要提前知道
      option.textContent = supportsVision(id) ? `${id} · 可看图` : id;
      if (id === current) option.selected = true;
      return option;
    }),
  );
}

function updatePickerDisabled() {
  els.modelSelect.disabled = runtime.busy || !runtime.availableModels.length;
}

async function loadModelPicker() {
  if (runtime.config.mode !== 'model') {
    els.pickerLoading.hidden = true;
    populateModelPicker([], '');
    updatePickerDisabled();
    return;
  }

  els.pickerLoading.hidden = false;
  try {
    const res = await fetch('/api/models');
    const data = await res.json();
    const models = Array.isArray(data.models) ? data.models : [];
    if (data.default) runtime.serverDefaultModel = data.default;
    runtime.availableModels = models;

    if (!models.length) {
      if (data.note) flashHint(`模型列表不可用：${data.note}`, 4000);
      populateModelPicker([], '');
      return;
    }

    if (runtime.chosenModel && !models.includes(runtime.chosenModel)) {
      flashHint(`之前选的 ${runtime.chosenModel} 已不可用，改回默认模型`, 4000);
      runtime.chosenModel = '';
      writeModelPreference('');
    }
    populateModelPicker(models, store.session.model || runtime.chosenModel || runtime.serverDefaultModel);
  } catch (err) {
    flashHint(`读取模型列表失败：${err.message}`, 4000);
  } finally {
    els.pickerLoading.hidden = true;
    updatePickerDisabled();
  }
}

els.modelSelect.addEventListener('change', () => {
  const model = els.modelSelect.value;
  // 记在这个会话上：一边用能看图的模型、一边用便宜的模型，互不干扰
  store.updateSessionSettings({ model });
  runtime.chosenModel = model;
  writeModelPreference(model);
  renderSessionList();
  syncModeChip();
  flashHint(`下一轮对话改用 ${model}`, 2600);
  els.input.focus();
});

// ---------------------------------------------------------------- 渲染

/**
 * 一条「对谈」的 DOM 结构与缓存。
 * 数字编号只在建节点时算一次；其余字段全部在 paintTurn 里按版本重画，
 * 这样切换版本时两侧（问与答）能一起更新。
 */
function buildTurnNode(message, number) {
  const frag = els.exchangeTemplate.content.cloneNode(true);
  const node = frag.querySelector('.exchange');
  node.dataset.id = message.id;

  frag.querySelector('[data-field="number"]').textContent = String(number).padStart(2, '0');

  node.__assistant = frag.querySelector('[data-field="answer-turn"]');
  node.__answerBody = frag.querySelector('[data-field="answer"]');
  node.__answerModel = frag.querySelector('[data-field="answer-model"]');
  node.__answerVersion = frag.querySelector('[data-field="answer-version"]');
  node.__questionBody = frag.querySelector('[data-field="question"]');
  node.__questionImages = frag.querySelector('[data-field="question-images"]');
  node.__askedAt = frag.querySelector('[data-field="asked-at"]');
  node.__userTag = frag.querySelector('[data-field="user-tag"]');
  node.__versionBar = frag.querySelector('[data-field="question-versions"]');
  node.__editBox = frag.querySelector('[data-field="edit-box"]');
  node.__editInput = frag.querySelector('[data-field="edit-input"]');
  node.__editHint = frag.querySelector('[data-field="edit-hint"]');

  return { node, assistant: node.__assistant };
}

/** 画出「第 n 版 / 共 N 版」的切换条 */
function paintVersionBar(node, question, shown) {
  const bar = node.__versionBar;
  const items = versionBarItems(question.versions.length, shown);

  if (!items.length) {
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }

  const dots = items.map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'version-dot';
    button.textContent = item.label;
    button.dataset.action = 'version';
    button.dataset.version = String(item.page);
    button.title = item.title;
    if (item.active) {
      button.dataset.active = 'true';
      button.setAttribute('aria-current', 'true');
    }
    return button;
  });

  const label = document.createElement('span');
  label.className = 'version-label';
  label.textContent = versionLabel(shown, question.versions.length);

  bar.hidden = false;
  bar.replaceChildren(...dots, label);
}

/** 按当前选中的版本重画一条对谈 */
function paintTurn(node) {
  const message = store.messages.find((m) => m.id === node.dataset.id);
  if (!message) return;

  const answer = node.__assistant;
  const body = node.__answerBody;

  const index = store.messages.indexOf(message);
  const question = store.messages[index - 1];

  // 一条对谈的「页」由提问决定；回答跟着显示同一页
  const shown = question ? resolveShownPage(question, store.viewVersion(question)) : 1;

  // ---- 问的那一侧
  if (question) {
    const qv = question.versions[shown - 1] ?? question.versions[question.versions.length - 1];
    node.__askedAt.textContent = formatClock(qv.createdAt);
    node.__questionBody.textContent = qv.content ?? '';
    node.__questionBody.hidden = !qv.content;

    const images = qv.attachments ?? [];
    node.__questionImages.hidden = images.length === 0;
    node.__questionImages.replaceChildren(
      ...images.map((att) => {
        const li = document.createElement('li');
        const img = document.createElement('img');
        img.src = att.dataUrl;
        img.alt = att.name;
        img.title = `${att.name}${att.width ? ` · ${att.width}×${att.height}` : ''}（点击看大图）`;
        li.appendChild(img);
        return li;
      }),
    );

    const label = personaLabel(question.personaId ?? store.session.personaId);
    node.__userTag.hidden = !label || label === '通用助手';
    if (!node.__userTag.hidden) node.__userTag.textContent = label;

    paintVersionBar(node, question, shown);

    // 编辑框：只有在编辑态里才显示，且内容回填当前版本
    if (node.__editing) {
      node.__editBox.hidden = false;
      if (document.activeElement !== node.__editInput) node.__editInput.value = qv.content ?? '';
      // 提前说清这一按会发生什么：覆盖当前页，还是新增一页
      const outcome = editOutcome(shown, question.versions.length);
      node.__editHint.textContent = editHint(outcome, shown, question.versions.length);
    } else {
      node.__editBox.hidden = true;
    }
  }

  // ---- 答的那一侧
  const av = message.versions[Math.min(shown, message.versions.length) - 1] ?? message.versions[message.versions.length - 1];
  const streaming = av.status === 'streaming';
  answer.dataset.status = av.status;
  answer.dataset.pending = streaming && !av.content ? 'true' : 'false';

  const html = renderMarkdown(av.content, { streaming });
  // 内容没变就不动 DOM，避免流式期间反复重排
  if (body.dataset.painted !== html) {
    body.innerHTML = html;
    body.dataset.painted = html;
  }

  const timing = node.querySelector('[data-field="answer-timing"]');
  if (av.finishedAt) timing.textContent = formatDuration(av.finishedAt - av.createdAt);
  else timing.textContent = streaming ? '正在写' : '';

  // 回答用了哪个模型 —— 换了模型时这行能解释「为什么风格变了」
  node.__answerModel.hidden = !av.model;
  if (av.model) node.__answerModel.textContent = av.model;

  // 第几页的回答（只有多页时才显示，免得噪音）
  const pages = totalPages(question, message);
  node.__answerVersion.hidden = pages <= 1;
  if (!node.__answerVersion.hidden) node.__answerVersion.textContent = `第 ${shown} 页`;

  const status = node.querySelector('[data-field="answer-status"]');
  status.dataset.tone = av.status === 'error' ? 'error' : 'info';
  status.hidden = !av.error && av.status !== 'interrupted';
  if (av.error) status.textContent = av.error;
  else if (av.status === 'interrupted') status.textContent = '已停止，写出的部分留在这里。可以让它重新生成。';

  const actions = node.querySelector('[data-field="answer-actions"]');
  const isLast = store.messages.at(-1)?.id === message.id;
  const isNewestPage = !question || shown === question.versions.length;
  actions.dataset.visible = !streaming && isLast && isNewestPage && av.content ? 'true' : 'false';
}

function render({ keepLive = false } = {}) {
  const assistants = store.messages.filter((m) => m.role === 'assistant');
  const isBlank = store.messages.length === 0;

  els.blank.hidden = !isBlank;
  els.clear.disabled = isBlank;

  if (keepLive && runtime.liveTurn && runtime.renderNode) {
    // 流式写入中：只增量重画这一条，其余不动（否则光标位置、滚动锚点都会跳）
    paintTurn(runtime.renderNode);
    return;
  }

  els.exchanges.replaceChildren();
  assistants.forEach((message, index) => {
    const { node } = buildTurnNode(message, index + 1);
    els.exchanges.appendChild(node);
    paintTurn(node);
  });

  if (runtime.liveTurn) {
    const live = els.exchanges.querySelector(`[data-id="${runtime.liveTurn.id}"]`);
    if (live) runtime.renderNode = live;
  }
}

/** 会话切换 / 设置变化时需要整体重画的部分 */
function renderAll() {
  renderSessionList();
  renderControls();
  render();
}

/** 切会话：提示词框必须换成新会话的内容 */
function renderAfterSessionSwitch() {
  forcePromptText = true;
  renderAll();
}

function scheduleLivePaint() {
  if (runtime.frameHandle) return;
  runtime.frameHandle = requestAnimationFrame(() => {
    runtime.frameHandle = null;
    if (!runtime.renderNode) return;
    paintTurn(runtime.renderNode);
    if (runtime.pinned) scrollToBottom();
  });
}

function setBusy(busy) {
  runtime.busy = busy;
  els.input.disabled = busy;
  els.send.disabled = busy || !(els.input.value.trim() || runtime.pendingImages.length);
  els.send.textContent = busy ? '生成中' : '发送';
  els.stop.hidden = !busy;
  els.hint.textContent = defaultHint();
  updatePickerDisabled();
  updatePinned();
}

function updateSendState() {
  els.send.disabled = runtime.busy || !(els.input.value.trim() || runtime.pendingImages.length);
}

// ---------------------------------------------------------------- 输入框

function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 240)}px`;
}

els.input.addEventListener('input', () => {
  autoGrow();
  updateSendState();
});

els.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    els.composer.requestSubmit();
  }
  if (event.key === 'Escape' && runtime.busy) {
    event.preventDefault();
    stopGenerating();
  }
});

els.input.addEventListener('paste', async (event) => {
  const files = imageFilesFromClipboard(event);
  if (!files.length) {
    requestAnimationFrame(autoGrow);
    return;
  }
  // 粘贴图片时不要把 base64 文本也塞进输入框
  event.preventDefault();
  await addImages(files);
});

els.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  send();
});

els.stop.addEventListener('click', stopGenerating);

els.starters.addEventListener('click', (event) => {
  const button = event.target.closest('.starter');
  if (!button) return;
  els.input.value = button.dataset.starter ?? '';
  autoGrow();
  updateSendState();
  els.input.focus();
});

// ---------------------------------------------------------------- 图片

function renderAttachments() {
  els.attachmentStrip.hidden = runtime.pendingImages.length === 0;
  els.attachmentStrip.replaceChildren(
    ...runtime.pendingImages.map((att) => {
      const frag = els.attachmentTemplate.content.cloneNode(true);
      const li = frag.querySelector('.attachment');
      li.dataset.id = att.id;
      const img = frag.querySelector('img');
      img.src = att.dataUrl;
      img.alt = att.name;
      frag.querySelector('[data-field="info"]').textContent =
        `${att.width}×${att.height} · ${formatKb(att.dataUrl.length)}`;
      return frag;
    }),
  );
  updateSendState();
}

async function addImages(files) {
  const room = MAX_IMAGES - runtime.pendingImages.length;
  if (room <= 0) {
    flashHint(`一条消息最多 ${MAX_IMAGES} 张图`, 3000);
    return;
  }
  if (files.length > room) flashHint(`只能再加 ${room} 张，多余的已忽略`, 3000);

  for (const file of files.slice(0, room)) {
    try {
      flashHint(`正在压缩 ${file.name || '图片'}…`, 4000);
      const compressed = await compressImage(file);
      runtime.pendingImages.push(toAttachment(compressed));
    } catch (err) {
      flashHint(`这张图用不了：${err.message}`, 4000);
    }
  }
  renderAttachments();
  if (runtime.pendingImages.length) {
    const last = runtime.pendingImages.at(-1);
    flashHint(`${runtime.pendingImages.length} 张图已就绪 · ${formatKb(last.dataUrl.length)}`, 2200);
    els.input.focus();
  }
}

els.imageButton.addEventListener('click', () => els.imageInput.click());
els.imageInput.addEventListener('change', async () => {
  const files = [...(els.imageInput.files ?? [])];
  els.imageInput.value = '';
  if (files.length) await addImages(files);
});

els.attachmentStrip.addEventListener('click', (event) => {
  if (event.target.closest('[data-action="remove"]')) {
    const id = event.target.closest('.attachment')?.dataset.id;
    runtime.pendingImages = runtime.pendingImages.filter((a) => a.id !== id);
    renderAttachments();
  }
});

// 拖拽图片进来
els.composer.addEventListener('dragover', (event) => {
  if (!event.dataTransfer?.types?.includes('Files')) return;
  event.preventDefault();
  els.composer.dataset.dragover = 'true';
});
els.composer.addEventListener('dragleave', () => {
  delete els.composer.dataset.dragover;
});
els.composer.addEventListener('drop', async (event) => {
  delete els.composer.dataset.dragover;
  const files = imageFilesFromDrop(event);
  if (!files.length) return;
  event.preventDefault();
  await addImages(files);
});

// ---------------------------------------------------------------- 语音输入

/** 每次开始识别都新建一个会话：SpeechRecognition 实例不能重用同一个 onend 状态 */
function startSpeech(base, handlers) {
  runtime.speech = createSpeechInput({ lang: 'zh-CN', ...handlers });
  runtime.speech.start();
  void base;
}

function speechHandlers(base) {
  return {
    onInterim: (text) => {
      els.input.value = base + text;
      autoGrow();
      updateSendState();
    },
    onFinal: (text) => {
      els.input.value = base + text;
      autoGrow();
      updateSendState();
    },
    onError: (message) => flashHint(message, 5000),
    onEnd: () => {
      runtime.listening = false;
      els.voiceButton.dataset.listening = 'false';
      els.voiceButton.textContent = '语音输入';
      els.hint.textContent = defaultHint();
      els.input.focus();
    },
  };
}

function setupSpeech() {
  if (!isSpeechSupported()) {
    els.voiceButton.disabled = true;
    els.voiceButton.title = unsupportedReason();
    els.voiceButton.textContent = '语音不可用';
    return;
  }
  els.voiceButton.title = '点击开始，再点一次结束';
}

els.voiceButton.addEventListener('click', () => {
  if (!isSpeechSupported()) {
    flashHint(unsupportedReason(), 5000);
    return;
  }
  if (runtime.listening) {
    runtime.speech?.stop();
    return;
  }
  // 已输入的文字先留着，识别结果接在后面，别把用户打的字冲掉
  const prefix = els.input.value.trim();
  const base = prefix ? `${prefix} ` : '';
  runtime.listening = true;
  els.voiceButton.dataset.listening = 'true';
  els.voiceButton.textContent = '结束';
  els.hint.textContent = '正在听…再点一次「结束」';
  startSpeech(base, speechHandlers(base));
});

// ---------------------------------------------------------------- 发送与流式读取

/**
 * 逐帧读取 SSE。
 * 用 fetch + ReadableStream 而不是 EventSource：需要 POST，且要能中途 abort。
 */
async function readEventStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        try {
          onEvent(JSON.parse(raw));
        } catch {
          /* 半截帧：丢掉，下一帧会补齐 */
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}

/**
 * 发送一轮对话。
 *
 * @param {string} rawText
 * @param {{edit?: object, version?: number, reuse?: boolean}} options
 *   edit + version：编辑后重新发送（**追加新页，旧页保留**）。
 *   reuse: true：原地替换那一版，不新增页（给「重新生成」用）。
 */
async function send(rawText, { edit = null, version = null, reuse = false } = {}) {
  const text = (rawText ?? els.input.value).trim();
  const images = [...runtime.pendingImages];
  if ((!text && !images.length) || runtime.busy) return;

  els.input.value = '';
  runtime.pendingImages = [];
  renderAttachments();
  autoGrow();
  updateSendState();

  // 编辑重发时，被编辑的位置之后的所有轮次在新一页里不再适用（那一页只到这次问答为止）。
  // 但因为我们是「追加版本」而不是「替换」，旧页仍然完整保留，所以这里不需要删任何东西。

  const asked = store.pushUser(text, { attachments: images, edit, version, reuse });
  const question = asked.message;
  const versionNumber = asked.version;
  store.renameFromFirstMessage();

  const answered = store.pushAssistant({
    model: currentModelForRequest(),
    question,
    version: versionNumber,
  });
  const placeholder = answered.message;
  runtime.liveTurn = placeholder;
  runtime.renderNode = null;
  render();
  renderSessionList();
  setBusy(true);
  if (runtime.pinned) scrollToBottom();

  // 发给服务端的历史交给 lib/versions.js 里的纯函数构造（那边有完整测试）：
  // 它负责「每条消息取最新一版」+「末尾提问额外补上历史版本及其旧回答」，
  // 并保证图片只跟末条一起发。
  const history = buildRequestHistory(store.messages, question, placeholder);

  const controller = new AbortController();
  runtime.controller = controller;

  let sawDone = false;
  let doneReason = null;
  let streamError = null;
  let meta = null;
  let switchedNote = null;

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: history,
        sessionId: store.sessionId,
        model: currentModelForRequest() || undefined,
        systemPrompt: store.effectiveSystemPrompt() || undefined,
      }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      let detail = '';
      try {
        detail = (await response.json())?.error ?? '';
      } catch {
        /* 忽略 */
      }
      throw new Error(detail || `请求失败（HTTP ${response.status}）`);
    }

    await readEventStream(response, (event) => {
      switch (event.type) {
        case 'meta':
          meta = event;
          store.setMode(placeholder, event.mode);
          updateModeChip(event.mode, event.model);
          break;
        case 'model':
          runtime.activeModel = event.model;
          store.setMessageModel(placeholder, event.model);
          switchedNote = applyActiveModel(event.model, event.switchedFrom) || switchedNote;
          break;
        case 'delta':
          if (typeof event.text === 'string' && event.text) {
            store.appendDelta(placeholder, event.text);
            scheduleLivePaint();
          }
          break;
        case 'error':
          streamError = event.message || '生成失败';
          break;
        case 'done':
          sawDone = true;
          doneReason = event.reason ?? 'stop';
          break;
        default:
          break;
      }
    });

    if (streamError) {
      store.finish(placeholder, placeholder.content ? 'interrupted' : 'error', streamError);
    } else if (doneReason === 'error') {
      store.finish(
        placeholder,
        placeholder.content ? 'interrupted' : 'error',
        placeholder.content ? '生成中断，写出的部分保留在上方。' : '这一轮没有生成成功，可以重新生成。',
      );
    } else if (!placeholder.content) {
      store.finish(placeholder, 'error', '这轮没有收到任何内容，可以重新生成。');
    } else {
      store.finish(placeholder, 'done');
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      store.interrupt(placeholder);
    } else if (placeholder.content) {
      store.finish(placeholder, 'interrupted', `连接中断：${err.message}`);
    } else {
      store.finish(placeholder, 'error', `连不上服务端：${err.message}。确认 node server.mjs 还在运行。`);
    }
  } finally {
    runtime.controller = null;
    runtime.liveTurn = null;
    if (runtime.frameHandle) {
      cancelAnimationFrame(runtime.frameHandle);
      runtime.frameHandle = null;
    }
    renderAll();
    setBusy(false);
    if (runtime.pinned) scrollToBottom();
    els.input.focus();
    if (switchedNote) {
      flashHint(`所选模型 ${switchedNote} 不可用，已自动改用 ${runtime.activeModel || '可用模型'}`, 4200);
    } else if (!sawDone && !streamError && meta === null) {
      flashHint('这轮没有收到任何响应帧，检查服务端日志', 2600);
    }
  }
}

/** 本次请求用哪个模型：会话自己的选择优先 */
function currentModelForRequest() {
  return store.session.model || runtime.chosenModel || runtime.serverDefaultModel || '';
}

function stopGenerating() {
  runtime.controller?.abort();
}

/**
 * 重新生成：用当前这一版的提问（和它的图片）再问一次，覆盖这一版的回答。
 *
 * 不新增页 —— 「重新生成」是「同样的输入再要一次答案」，
 * 而「编辑后重新回答」才是产生新页的动作。两者语义不同，别混。
 */
async function retryLast(message) {
  if (runtime.busy) return;
  const index = store.messages.indexOf(message);
  if (index < 1) return;
  const question = store.messages[index - 1];
  if (!question || question.role !== 'user') return;

  const shown = store.viewVersion(question);
  const qv = question.versions[shown - 1];
  if (!qv) return;

  const text = qv.content ?? '';
  const images = qv.attachments ?? [];
  if (!text && !images.length) return;

  // 用「同一版提问」重发：reuse 让它原地替换那一版，不新增页 ——
  // 「重新生成」是「同样的问题再要一次答案」，不该凭空多出一页。
  els.input.value = '';
  runtime.pendingImages = images;
  await send(text, { edit: question, version: shown, reuse: true });
}

/**
 * 编辑后重新回答。
 *
 * 关键行为（用户明确要求）：**绝不覆盖原来那一页**。
 * 每次都追加新的一页，于是「本次的内容」和「上一次生成的内容」都能看到、可对比。
 * 这里不要改成「覆盖最新一页」—— 那样旧内容直接丢了，功能就白做了。
 */
async function resendEdited(question, version, newText) {
  if (runtime.busy) return;
  const text = String(newText ?? '').trim();
  const v = question.versions[version - 1];
  const keepImages = v?.attachments ?? [];
  if (!text && !keepImages.length) {
    flashHint('内容不能为空', 2400);
    return;
  }

  els.input.value = '';
  runtime.pendingImages = keepImages;
  await send(text, { edit: question, version });
}

/** 只改不发：把这一版的内容改掉，不触发回答 */
function saveEditOnly(question, version, newText) {
  const text = String(newText ?? '').trim();
  const v = question.versions[version - 1];
  if (!v) return;
  if (!text && !(v.attachments ?? []).length) {
    flashHint('内容不能为空', 2400);
    return;
  }
  v.content = text;
  v.createdAt = Date.now();
  store.setMessageVersion(question, version);
  render();
  flashHint('已保存改动（没有重新回答）', 2400);
}

// ---------------------------------------------------------------- 模式提示

/**
 * 顶部那个状态标签显示什么。
 *
 * 它必须和「模型选择框里选的那个」始终一致 —— 顶上说 deepseek-v3.2、
 * 下拉框里却是 gpt-4o，用户根本不知道该信哪个。所以模型名统一从
 * currentModelForRequest() 取，任何会影响它的操作（换会话、换模型、
 * 服务端回报实际模型）之后都要重新同步一次。
 */
function syncModeChip() {
  if (runtime.config.mode === 'mock') {
    els.modeChip.dataset.mode = 'mock';
    els.modeLabel.textContent = '离线回答';
    return;
  }
  if (runtime.config.mode === 'unknown') {
    els.modeChip.dataset.mode = 'unknown';
    els.modeLabel.textContent = '连接中…';
    return;
  }
  els.modeChip.dataset.mode = 'model';
  const model = currentModelForRequest();
  els.modeLabel.textContent = model || '真实模型';
  els.modeChip.title = model ? `当前模型：${model}` : '当前回答由谁生成';
}

/** 服务端在 meta 帧里报的模型 —— 在拿到实际模型之前先用它显示 */
function updateModeChip(mode, model) {
  if (mode === 'mock' || mode === 'unknown') {
    runtime.config.mode = mode;
    syncModeChip();
    return;
  }
  runtime.config.mode = 'model';
  // meta 里的模型是服务端默认；如果本会话/本地偏好已经指定了，以指定为准
  if (!currentModelForRequest() && model) runtime.serverDefaultModel = model;
  syncModeChip();
  updatePickerDisabled();
}

/**
 * 服务端回报本轮真正用的模型。
 * 用户选的那个被换掉时必须让界面说实话，否则界面在骗人。
 * @returns {string|null} 被替换掉的模型名（用于提示），没有则为 null
 */
function applyActiveModel(model, switchedFrom) {
  if (!model) return null;
  const selectedBefore = els.modelSelect.value;
  if (selectedBefore === model) return null;
  if (!runtime.availableModels.includes(model)) return null;

  els.modelSelect.value = model;
  const lost = switchedFrom || selectedBefore;
  if (!lost || lost === model) return null;

  if (store.session.model === lost) {
    store.updateSessionSettings({ model: '' });
    renderSessionList();
  }
  if (runtime.chosenModel === lost) {
    runtime.chosenModel = '';
    writeModelPreference('');
  }
  syncModeChip();
  return lost;
}

function showNotice(config) {
  if (config.mode === 'mock') {
    els.notice.hidden = false;
    els.notice.innerHTML =
      '当前没有配置 API Key，正在使用<strong>本地离线回答</strong>：多会话、角色设定、逐字输出、刷新不丢都是真的，' +
      '只有「回答内容」是模板，图片也无法识别。接入真实模型：设置环境变量 <code>DEEPSEEK_API_KEY</code> 后重启服务。';
    return;
  }
  if (config.recovered) {
    els.notice.hidden = false;
    els.notice.textContent = '上次离开时有一轮还在生成，已经停下，写出的部分保留在上面。';
    return;
  }
  els.notice.hidden = true;
}

// ---------------------------------------------------------------- 清空与删除

els.clear.addEventListener('click', () => {
  if (store.messages.length === 0) return;
  runtime.pendingDelete = null;
  els.confirmText.textContent = '清空后这个会话的消息无法找回，确定吗？';
  els.confirmStrip.hidden = false;
  els.confirmClear.focus();
});

els.cancelClear.addEventListener('click', () => {
  els.confirmStrip.hidden = true;
  runtime.pendingDelete = null;
  els.clear.focus();
});

els.confirmClear.addEventListener('click', () => {
  els.confirmStrip.hidden = true;

  if (runtime.pendingDelete) {
    const id = runtime.pendingDelete;
    runtime.pendingDelete = null;
    store.deleteSession(id);
  } else {
    stopGenerating();
    store.clear();
  }

  runtime.liveTurn = null;
  runtime.renderNode = null;
  renderAll();
  setBusy(false);
  els.input.focus();
  scrollToBottom();
});

// ---------------------------------------------------------------- 导出

els.exportButton.addEventListener('click', (event) => {
  event.stopPropagation();
  const willShow = els.exportPopup.hidden;
  els.exportPopup.hidden = !willShow;
  els.exportButton.setAttribute('aria-expanded', String(willShow));
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('.export-menu')) {
    els.exportPopup.hidden = true;
    els.exportButton.setAttribute('aria-expanded', 'false');
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !els.exportPopup.hidden) {
    els.exportPopup.hidden = true;
    els.exportButton.setAttribute('aria-expanded', 'false');
  }
});

/** 给导出用的会话对象：补上角色名，导出文件里能看出用的什么角色 */
function sessionForExport(session) {
  return { ...session, personaName: personaLabel(session.personaId) };
}

function doExport(kind) {
  const session = sessionForExport(store.session);
  const all = runtime.exportAll;
  const sessions = all ? store.sessions.map(sessionForExport) : [session];
  const title = all ? '对谈录-全部对话' : session.title;

  if (kind === 'copy') {
    copyText(toPlainText(session)).then((ok) =>
      flashHint(ok ? '已复制全文到剪贴板' : '复制失败，请手动选择'),
    );
    return;
  }

  if (kind === 'md') {
    download(
      suggestedFilename(title, 'md'),
      toMarkdown(session, { exportAll: all, sessions }),
      'text/markdown;charset=utf-8',
    );
  } else if (kind === 'txt') {
    download(suggestedFilename(title, 'txt'), toPlainText(session), 'text/plain;charset=utf-8');
  } else if (kind === 'json') {
    download(
      suggestedFilename(title, 'json'),
      toJson(session, { exportAll: all, sessions }),
      'application/json;charset=utf-8',
    );
  }
  flashHint(`已导出（${all ? `${sessions.length} 个会话` : '当前会话'}）`, 2600);
}

els.exportPopup.addEventListener('click', (event) => {
  const kind = event.target.closest('[data-export]')?.dataset.export;
  if (!kind) return;
  els.exportPopup.hidden = true;
  els.exportButton.setAttribute('aria-expanded', 'false');
  doExport(kind);
});

els.exportAll.addEventListener('click', () => {
  runtime.exportAll = true;
  doExport('md');
  runtime.exportAll = false;
});

// ---------------------------------------------------------------- 会话栏开关

function setRailVisible(visible) {
  els.board.dataset.rail = visible ? 'shown' : 'hidden';
  els.sidebarToggle.setAttribute('aria-expanded', String(visible));
}

els.sidebarToggle.addEventListener('click', () => {
  setRailVisible(els.board.dataset.rail === 'hidden');
});

/**
 * 新建并切到一个新会话。
 *
 * 角色回到默认的「通用助手」（新话题重新选角色），模型沿用上次用过的 ——
 * 换引擎没必要每次都重选。
 *
 * @returns {boolean} 是否真的新建了（当前已经是空会话时就不用再建一个）
 */
function startNewSession({ announce = false } = {}) {
  const current = store.session;
  let created = false;

  if (current.messages.length > 0) {
    store.createSession();
    created = true;
  } else {
    // 当前就是个空白会话：把它重置成默认状态就行，不用再堆一个「新对话」
    store.updateSessionSettings({ personaId: DEFAULT_PERSONA_ID, systemPrompt: '' });
  }

  runtime.pinned = true;
  runtime.liveTurn = null;
  runtime.renderNode = null;
  renderAfterSessionSwitch();
  scrollToBottom();
  els.input.focus();

  if (announce && created) flashHint('已新建对话，角色为通用助手', 2400);
  return created;
}

els.newSession.addEventListener('click', () => startNewSession({ announce: true }));

// ---------------------------------------------------------------- 事件委托

els.exchanges.addEventListener('click', (event) => {
  const copyCode = event.target.closest('[data-copy-code]');
  if (copyCode) {
    const block = copyCode.closest('.code-block');
    const code = block?.querySelector('code')?.textContent ?? '';
    copyText(code).then((ok) => flashHint(ok ? '代码已复制' : '复制失败，请手动选择'));
    return;
  }

  const image = event.target.closest('.turn-images img');
  if (image) {
    window.open(image.src, '_blank', 'noopener');
    return;
  }

  const action = event.target.closest('[data-action]');
  if (!action) return;
  const node = action.closest('.exchange');
  const message = store.messages.find((m) => m.id === node?.dataset.id);
  if (!message) return;

  const kind = action.dataset.action;
  const index = store.messages.indexOf(message);
  const question = store.messages[index - 1];
  // 默认作用于「当前显示的那一页」
  const shown = question ? store.viewVersion(question) : 1;

  if (kind === 'copy') {
    const av = message.versions[Math.min(shown, message.versions.length) - 1];
    copyText(markdownToPlain(av?.content ?? '')).then((ok) =>
      flashHint(ok ? '回答已复制' : '复制失败，请手动选择'),
    );
    return;
  }

  if (kind === 'retry') {
    retryLast(message);
    return;
  }

  // ---- 版本切换
  if (kind === 'version') {
    const target = Number(action.dataset.version);
    if (question && target) {
      store.setMessageVersion(question, target);
      node.__editing = false;
      render();
    }
    return;
  }

  // ---- 编辑
  if (kind === 'edit') {
    if (!question) return;
    // 正在生成时不让进编辑态：那一轮还没写完，改了版本号会乱
    if (runtime.busy) {
      flashHint('正在生成，等这一轮结束再编辑', 2400);
      return;
    }
    // 只有一个编辑框处于打开状态，避免同时改好几处
    for (const other of els.exchanges.querySelectorAll('.exchange')) {
      if (other !== node) other.__editing = false;
    }
    node.__editing = true;
    node.__editInput.value = question.versions[shown - 1]?.content ?? '';
    paintTurn(node);
    node.__editInput.focus();
    return;
  }

  if (kind === 'edit-cancel') {
    node.__editing = false;
    paintTurn(node);
    els.input.focus();
    return;
  }

  if (kind === 'edit-resend') {
    const text = node.__editInput.value;
    node.__editing = false;
    if (question) resendEdited(question, shown, text);
    return;
  }

  if (kind === 'edit-save') {
    const text = node.__editInput.value;
    node.__editing = false;
    if (question) saveEditOnly(question, shown, text);
  }
});

// ---------------------------------------------------------------- 跨标签页同步

window.addEventListener('storage', (event) => {
  if (event.key !== 'duitanlu.sessions.v2') return;
  if (runtime.busy) return; // 本页正在生成时不打断

  let snapshot = null;
  try {
    snapshot = JSON.parse(event.newValue ?? 'null');
  } catch {
    return;
  }
  if (!snapshot) return;

  // 别的标签页改了对话：读回来跟随显示（写入方已经落盘，这里不再回写）
  if (store.adoptSnapshot(snapshot, { persist: false })) {
    runtime.liveTurn = null;
    runtime.renderNode = null;
    renderAll();
    setBusy(false);
  }
});

// ---------------------------------------------------------------- 启动

/**
 * 这次加载是不是「刷新当前页面」？
 *
 * 区分它很重要：
 *  · 刷新 → 应该留在原来那个会话，否则刷新会把上一轮的半截回答一起丢掉，
 *          「流式中断后仍能看到写到哪」这个能力就没了。
 *  · 重新打开页面 → 开一个新会话，不要把上次的对话直接摊在面前。
 */
function isPageReload() {
  try {
    const [nav] = performance.getEntriesByType('navigation');
    if (nav?.type) return nav.type === 'reload';
  } catch {
    /* 老浏览器没有这个 API */
  }
  return false;
}

/**
 * 进入页面时决定停在哪个会话。
 * 判断逻辑在 lib/startup.js 里（纯函数，可单测）；这里只负责读状态 + 执行。
 */
function resolveStartingSession() {
  const reason = resolveStartingSessionDecide({
    reload: isPageReload(),
    messageCount: store.messages.length,
    hasInterrupted: store.session.messages.some((m) => m.status === 'interrupted'),
  });

  // 已经有内容、且不是「刷新 / 恢复」→ 开一个新会话（角色回到通用助手，模型沿用）
  if (shouldCreateSession(reason)) store.createSession();
  return reason;
}

async function boot() {
  const startReason = resolveStartingSession();

  fillPersonaSelect();
  renderAll();
  setBusy(false);
  autoGrow();
  renderAttachments();
  setupSpeech();

  // 窄屏默认收起会话栏：它会把正文挤得没法读
  if (window.matchMedia('(max-width: 1000px)').matches) setRailVisible(false);

  // 1) 问服务端现在是哪种模式
  try {
    const response = await fetch('/api/config');
    runtime.config = await response.json();
    runtime.config.recovered = store.recoveredInterrupted > 0;
    if (runtime.config.defaultModel) runtime.serverDefaultModel = runtime.config.defaultModel;
    updateModeChip(runtime.config.mode, runtime.config.model);
    els.notice.hidden = true;
    showNotice(runtime.config);
  } catch {
    updateModeChip('unknown', null);
    els.notice.hidden = false;
    els.notice.textContent = '读不到服务端配置，界面仍可用，但发送会失败——确认 node server.mjs 正在运行。';
  }

  // 2) 拉取可用模型（离线模式会显示一个说明项）
  await loadModelPicker();
  renderControls();

  // 3) 本地为空时，尝试从服务端兜底副本恢复当前会话
  if (store.messages.length === 0) {
    try {
      const response = await fetch(`/api/history/${store.sessionId}`);
      const saved = await response.json();
      if (Array.isArray(saved?.turns) && saved.turns.length) {
        store.adopt(saved.turns);
        renderAll();
        flashHint('本地没有记录，已从服务端兜底副本恢复这个会话', 3200);
      }
    } catch {
      /* 兜底失败不影响使用 */
    }
  }

  if (store.migrated) flashHint('已把旧版对话迁移到新版本', 3600);
  else {
    const notice = startNotice(startReason);
    if (notice) flashHint(notice, 3600);
  }

  renderAll();
  updatePinned();
  els.input.focus();
}

boot();
