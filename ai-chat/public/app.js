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
import { createStore, groupSessions } from './lib/store.js';
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
  copyFeedbackState,
  copyHint,
  copyFeedbackDuration,
} from './lib/copy-feedback.js';
import {
  resolveShownPage,
  totalPages,
  versionBarItems,
  versionLabel,
  editOutcome,
  editHint,
  buildRequestHistory,
} from './lib/versions.js';
import { hasQuote, quoteFromSelection, quoteLabel, quotePreview } from './lib/quote.js';
// 起标题的提示词与清洗都在 lib/title.js 里（服务端 import 同一份）；
// 这里只用得到「该不该起」和「洗一遍」两个
import { needsAutoTitle, titleFromModel } from './lib/title.js';
import {
  RATINGS,
  feedbackLabel,
  feedbackPayload,
  normalizeFeedback,
  ratingInfo,
  reasonsFor,
  toggleRating,
  toggleReason,
} from './lib/feedback.js';
import { buildSummaryMessages, compressionPlan, normalizeSummary, summaryLabel } from './lib/compress.js';
import {
  MAX_REFERENCE_TURNS,
  isValidReference,
  referenceFailureText,
  referenceLabel,
  referencePlan,
  turnPairs,
} from './lib/reference.js';
import {
  resolveStartingSession as resolveStartingSessionDecide,
  resolveRailVisible as resolveRailVisibleDecide,
  shouldCreateSession,
  startNotice,
} from './lib/startup.js';

const els = {
  masthead: document.querySelector('.masthead'),
  board: document.getElementById('board'),
  sidebarToggle: document.getElementById('sidebar-toggle'),
  sessionList: document.getElementById('session-list'),
  titleFloat: document.getElementById('title-float'),
  railResizer: document.getElementById('rail-resizer'),
  sessionCount: document.getElementById('session-count'),
  sessionTemplate: document.getElementById('session-template'),
  // 「这条会话是从哪儿分出来的」那条说明（只有分支会话显示）
  branchNote: document.getElementById('branch-note'),
  branchNoteText: document.getElementById('branch-note-text'),
  // 会话引用：入口按钮、引用面板、材料标注条
  referenceNewButton: document.getElementById('reference-new-button'),
  // 列表收起时，报头上的备用入口（和「新对话」并排）
  referenceCompact: document.getElementById('reference-compact'),
  referencePanel: document.getElementById('reference-panel'),
  referencePanelClose: document.getElementById('reference-panel-close'),
  referenceSource: document.getElementById('reference-source'),
  referenceKind: document.getElementById('reference-kind'),
  referenceTurns: document.getElementById('reference-turns'),
  referenceReplaceNote: document.getElementById('reference-replace-note'),
  referenceNewSessionLink: document.getElementById('reference-new-session-link'),
  referenceStatus: document.getElementById('reference-status'),
  referenceConfirm: document.getElementById('reference-confirm'),
  referenceCancel: document.getElementById('reference-cancel'),
  referenceNote: document.getElementById('reference-note'),
  referenceNoteText: document.getElementById('reference-note-text'),
  referenceNoteBody: document.getElementById('reference-note-body'),
  referenceToggle: document.getElementById('reference-toggle'),
  referenceChange: document.getElementById('reference-change'),
  referenceDrop: document.getElementById('reference-drop'),
  branchSourceButton: document.getElementById('branch-source-button'),
  // 会话列表的三组（置顶 / 最近 / 已归档）。每组：section（整组，空组整块藏起来）、
  // list（会话行容器，组内收起时藏的是它）、count、toggle（组标题右边的收起/展开）
  groupPinned: {
    section: document.getElementById('group-pinned'),
    list: document.getElementById('pinned-list'),
    count: document.getElementById('pinned-count'),
    toggle: document.getElementById('pinned-toggle'),
  },
  groupRecent: {
    section: document.getElementById('group-recent'),
    list: document.getElementById('recent-list'),
    count: document.getElementById('recent-count'),
    toggle: document.getElementById('recent-toggle'),
    // 「显示全部 / 只看最近几个」那个开关（纯显示，见 RECENT_VISIBLE）
    more: document.getElementById('recent-more'),
  },
  // 归档的那一组：默认收着（见 readGroupPreference 里那一档说明），
  // 它同时是归档唯一的出口 —— 没有它就等于把会话藏没了
  groupArchived: {
    section: document.getElementById('group-archived'),
    list: document.getElementById('archived-list'),
    count: document.getElementById('archived-count'),
    toggle: document.getElementById('archived-toggle'),
  },
  // 搜索：输入框 + 平铺的「搜索结果」区（有内容时两组让位）
  searchInput: document.getElementById('session-search'),
  groupSearch: {
    section: document.getElementById('group-search'),
    list: document.getElementById('search-list'),
    count: document.getElementById('search-count'),
    empty: document.getElementById('search-empty'),
  },
  newSession: document.getElementById('new-session-button'),
  // 列表收起（或窄屏）时，报头上的备用入口
  newSessionCompact: document.getElementById('new-session-compact'),
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
  // 轮次导航：右侧那列短杠 + 它的浮层 / 列表（见 paintTurnNav）
  turnNav: document.getElementById('turn-nav'),
  turnTip: document.getElementById('turn-tip'),
  turnList: document.getElementById('turn-list'),
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

  composerQuote: document.getElementById('composer-quote'),
  composerQuoteLabel: document.getElementById('composer-quote-label'),
  composerQuoteText: document.getElementById('composer-quote-text'),
  composerQuoteRemove: document.getElementById('composer-quote-remove'),
  quoteFloat: document.getElementById('quote-float'),

  compressButton: document.getElementById('compress-button'),
  contextTemplate: document.getElementById('context-note-template'),

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

/**
 * 会话列表是收起还是展开。
 *
 * 存起来，因为它是一次「偏好」而不是临时状态：收起之后每次刷新又自己弹出来，
 * 会让人反复去收（原来的行为就是这样）。存的是 'shown' / 'hidden'，
 * 没存过就交给 resolveRailVisible 按屏幕宽度决定（窄屏默认收起）。
 */
const RAIL_PREF_KEY = 'duitanlu.rail.v1';

function readRailPreference() {
  try {
    const saved = localStorage.getItem(RAIL_PREF_KEY);
    return saved === 'shown' || saved === 'hidden' ? saved : '';
  } catch {
    return '';
  }
}

function writeRailPreference(visible) {
  try {
    localStorage.setItem(RAIL_PREF_KEY, visible ? 'shown' : 'hidden');
  } catch {
    /* 隐私模式下忽略 */
  }
}

// ---------------------------------------------------------------- 会话栏宽度
//
// 会话栏能拖宽拖窄（ChatGPT 那种）。几个约定：
//   · 宽度**只写一个 CSS 变量** `--rail-w`，报头和正文两处栅格都用它 ——
//     否则拖完报头那一格不跟着动，收起/展开开关就会和那道缝错位；
//   · 有上下限（200–460px，且不把正文挤到 320px 以下），拖过头就停在边界上；
//   · 双击回到默认 292px；键盘 ← → 各 8px、Home / End 到最小 / 最大；
//   · 窄屏（≤1000px 是单列）没有「那道缝」可拖：CSS 把柄藏掉，这里也拒绝开工；
//   · 宽度记在本地，刷新之后还是你拖的那个宽度。

const RAIL_WIDTH_KEY = 'duitanlu.railWidth.v1';
const RAIL_WIDTH_DEFAULT = 292;
const RAIL_WIDTH_MIN = 200;
const RAIL_WIDTH_MAX = 460;
/**
 * 正文那一栏至少留这么宽，否则拖宽会话栏时最多只能拖到这儿。
 *
 * 320px 太小了：正文的阅读版心是 760px（styles.css 的 `--text-col`），
 * 压到 320px 时一行只剩十来个汉字，读起来已经不是「正文」了。
 * 主流那几家（ChatGPT / Claude）干脆不给拖 —— 视口不够就收侧栏，而不是把正文压窄；
 * 我们保留拖拽（这是本项目的便利），但下限按**能读**来定：640px。
 */
const RAIL_TRANSCRIPT_MIN = 640;

function railWidthMax() {
  const byViewport = Number(window.innerWidth) - RAIL_TRANSCRIPT_MIN;
  return Math.max(RAIL_WIDTH_MIN, Math.min(RAIL_WIDTH_MAX, byViewport));
}

function clampRailWidth(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return RAIL_WIDTH_DEFAULT;
  return Math.min(railWidthMax(), Math.max(RAIL_WIDTH_MIN, n));
}

function readRailWidth() {
  try {
    const saved = Number(localStorage.getItem(RAIL_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampRailWidth(saved) : RAIL_WIDTH_DEFAULT;
  } catch {
    return RAIL_WIDTH_DEFAULT;
  }
}

function writeRailWidth(width) {
  try {
    localStorage.setItem(RAIL_WIDTH_KEY, String(width));
  } catch {
    /* 隐私模式下忽略 */
  }
}

/** 上一次真正写进 CSS 变量的宽度（值没变就不写 DOM —— 和报头高度那条规矩一致） */
let lastRailWidth = null;

/** 把宽度写进 CSS 变量（两个栅格共用它），并同步手柄上的无障碍数值 */
function applyRailWidth(width) {
  const w = clampRailWidth(width);
  if (w !== lastRailWidth) {
    lastRailWidth = w;
    document.documentElement.style.setProperty('--rail-w', `${w}px`);
  }
  if (els.railResizer) {
    els.railResizer.setAttribute('aria-valuenow', String(w));
    els.railResizer.setAttribute('aria-valuemin', String(RAIL_WIDTH_MIN));
    els.railResizer.setAttribute('aria-valuemax', String(railWidthMax()));
  }
  return w;
}

function setRailWidth(width, { persist = true } = {}) {
  const w = applyRailWidth(width);
  if (persist) writeRailWidth(w);
  return w;
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
  /** 待发送的引用（在回答中划中一段），发送后清空 */
  pendingQuote: null,
  /** 正在等模型起标题的会话 id，避免同一会话重复请求 */
  titlingSessions: new Set(),
  /** 打开着的评价框（同时只开一个）与其草稿 */
  feedbackOpen: null,
  feedbackDraft: null,
  /** 摘要正文是否展开着（按消息条数记忆，换会话不串） */
  summaryOpen: false,
  /** 背景材料的原文是否展开着（会话引用） */
  referenceOpen: false,
  /** 引用面板上正在编辑的草稿（选哪个会话、哪种形式、勾了哪几轮） */
  referenceDraft: null,
  /** 正在压缩的会话 id，避免同一会话重复请求 */
  compressing: null,
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

/**
 * 「这个会话多久没动了」—— 会话列表行尾那个小时间。
 *
 * 用**相对时间**而不是绝对时刻：在列表里扫一眼想知道的是「新不新」，
 * 而不是「几点几分」。绝对时刻在下面那行 meta 里已经有了，这里不重复它的职责。
 *
 * 分档到「月 / 年」为止，**不用日期**：日期形式（`2026/10/6`）会把行尾那块撑宽，
 * 而宽度是固定的（悬停要换成「⋯」，两块必须一样宽）。
 *
 * @param {number} ts 会话最后活动时间
 * @param {number} [now] 便于测试注入的「现在」
 */
function formatAge(ts, now = Date.now()) {
  const value = Number(ts);
  const diff = now - value;
  if (!Number.isFinite(value) || !Number.isFinite(diff)) return '';
  if (diff < 60_000) return '刚刚'; // 含「未来时间」这种脏数据（负数也落这里）

  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

/**
 * 只刷新行尾那几个时间（不重建列表）。
 * 时间会随时间变（`刚刚` → `5 分钟前`），页面挂久了不刷新就一直显示旧的。
 * 只在文字真的变了才写 DOM —— 和这一页其他地方的规矩一致。
 */
function refreshSessionAges() {
  if (!els.sessionList) return;
  const now = Date.now();
  for (const item of els.sessionList.querySelectorAll('.session-item')) {
    const session = store.sessions.find((s) => s.id === item.dataset.id);
    const age = item.querySelector?.('[data-field="age"]');
    if (!session || !age) continue;
    const next = formatAge(session.updatedAt, now);
    if (age.textContent !== next) age.textContent = next;
  }
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

/**
 * 复制按钮的「就地反馈」。
 *
 * 为什么必须就地变：提示文字出现在底部输入区，而代码块可能在页面上方好几屏之外 ——
 * 用户点了「复制代码」，眼睛还在按钮上，根本看不到那句提示，只能猜有没有成功。
 *
 * 三件事一起做，保证在任何位置都看得出来：
 *   1. 按钮文字变成「已复制」「复制失败」并换色
 *   2. 加一个短暂的状态类，供样式做强调
 *   3. 底部的提示文字也照旧更新（就近看不到时还有一层）
 */
function flashButtonCopied(button, ok = true) {
  if (!button) return;

  // 第一次触碰时把原标题记下来，供之后还原
  if (button.dataset.originalLabel === undefined) {
    button.dataset.originalLabel = button.textContent;
  }
  const original = button.dataset.originalLabel;
  const state = copyFeedbackState(ok);

  button.textContent = state.label;
  button.classList.toggle('is-copied', ok);
  button.classList.toggle('is-copy-failed', !ok);
  button.disabled = true; // 短暂禁用，避免连点把状态刷乱

  if (!flashButtonCopied.timers) flashButtonCopied.timers = new WeakMap();
  clearTimeout(flashButtonCopied.timers.get(button));

  const timer = setTimeout(() => {
    button.textContent = original;
    button.classList.remove('is-copied', 'is-copy-failed');
    button.disabled = false;
    flashButtonCopied.timers.delete(button);
  }, copyFeedbackDuration(ok));

  flashButtonCopied.timers.set(button, timer);
}

/** 复制 + 就地反馈 + 底部提示，三处一起 */
async function copyWithFeedback(text, { button = null, label = '内容' } = {}) {
  const ok = await copyText(text);
  flashButtonCopied(button, ok);
  flashHint(copyHint(ok, label), copyFeedbackDuration(ok));
  return ok;
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
  if (hasQuote(runtime.pendingQuote)) return '已引用一段回答，接着说你的问题 · Enter 发送';
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

/**
 * 量报头高度，写进 `--masthead-h`（会话列表的吸顶偏移和高度上限都按它算）。
 *
 * ── 为什么这里**不再**做「滚下去自动收窄」──
 *
 * 那个功能有过，而且为它写过一整套防抖机制（滞回阈值、只在状态变化时写 DOM、
 * 故意不给过渡）。原因是它有个反馈循环：报头从完整切到紧凑少掉 60 像素左右，
 * **整页内容高度也跟着少那么多**，而报头固定在顶部、悬在 scrollY ≈ 40 的位置，于是：
 *
 *     scrollY 越过阈值 → 变紧凑 → 文档变矮 → 浏览器为了稳住画面把 scrollY 往下修正
 *     → 落到阈值另一侧 → 变回完整 → 文档长回来 → scrollY 又被修回去 → …
 *
 * 在阈值那一带无限来回跳。滞回能压住它，但压不住另一个更直接的毛病：
 * **会话列表的吸顶偏移（`top: var(--masthead-h)`）和高度上限都是按报头高度算的**，
 * 报头一收窄，会话列表就跟着往上跳、还变高 —— 用户看到的"正文一滚，会话列表也跟着动"。
 *
 * 用户的判断是对的：**正文滚，会话列表不该动；标题那一块也不该变。**
 * 所以收窄整个去掉了：报头高度从头到尾一样，`--masthead-h` 在滚动中不会变，
 * 会话列表纹丝不动，"在阈值附近抖"这件事也从根上不可能再发生。
 * 想要更多正文空间，拖会话栏那条缝改宽度就行。
 *
 * 剩下的职责只有一件：**量高度**（字体、系统缩放、窄屏换行都会让实测值不同，
 * 写死数字会失准）。而且只在实测值真的变了才写 DOM。
 */
function updateMastheadHeight() {
  // 这里每次滚动都会跑：取不到元素就直接跳过，绝不能让它抛错 ——
  // 那会让整个页面在滚动时不断报错，比样式不对严重得多。
  if (!els.masthead) return;

  const height = Math.round(els.masthead.offsetHeight) || 108;
  if (height !== mastheadHeight) {
    mastheadHeight = height;
    document.documentElement.style.setProperty('--masthead-h', `${height}px`);
  }
}

/** 上一次实测到的报头高度（0 = 还没量过） */
let mastheadHeight = 0;

/**
 * 一次滚动回调里把两件事都做完，省一次布局抖动。
 *
 * **必须防重入**：updateMastheadHeight 会改 CSS 变量、可能引发新一轮布局，
 * 而布局变化又能触发 scroll 事件 —— 于是 onViewportChange 再被调进来，
 * 自己调自己直接爆栈。加一个「本次回调正在执行」的开关就够，
 * 滚动状态本来也只需要最终一致。
 */
let handlingViewport = false;

function onViewportChange() {
  if (handlingViewport) return;
  handlingViewport = true;
  try {
    updateMastheadHeight();
    updatePinned();
    // 引用浮标是按屏幕坐标摆的，页面一滚它就会停在原地和选区错开
    hideQuoteFloat();
    // 轮次导航：「当前轮」跟着滚动更新；浮层和列表都是按坐标摆的，滚了就收起
    paintActiveTurn();
    hideTurnHelp();
  } finally {
    handlingViewport = false;
  }
}

window.addEventListener('scroll', onViewportChange, { passive: true });
window.addEventListener('resize', onViewportChange);

els.jumpBottom.addEventListener('click', () => {
  scrollToBottom('smooth');
  runtime.pinned = true;
  els.reachBottom.hidden = true;
});

// ---------------------------------------------------------------- 会话列表

/**
 * 下一次画列表时，是否要把当前会话滚进可视区。
 *
 * 会话多了之后列表会在自己那一格里滚动（不再撑高页面、也不会盖住输入区），
 * 但新的会话排在最后 —— 不滚一下的话，刚建的会话可能停在可视区外面，
 * 看起来像「点了新对话却没反应」。只在**切换/新建**时滚，平时重画不滚：
 * 否则用户翻看老会话时，任何一次重画都会把列表拽回去。
 */
let railRevealPending = false;

// ---------------------------------------------------------------- 列表的三组
//
// 列表分「置顶」「最近」「已归档」三组（布局参考 ChatGPT）：置顶的钉在最上面，
// 其余的按最近使用排在「最近」里，归档的收在最后那一组。每一组自己能收起/展开 ——
// 收起来的是**这一组的会话行**，「置顶」「最近」「已归档」这些标题永远还在。
//
// 归档是「优先级」这条轴的另一端：置顶是「现在最重要」，归档是「收起来了，但别删」。
// 它只管列表里摆不摆 —— 数据、搜索、导出一样都不受影响（删掉会话才是 deleteSession 的事）。
//
// 这和报头那个总开关是两件事：那个把整栏（连标题一起）收起来。
// 两者互不影响，也都不影响「＋ 新对话」—— 它在三组之外，永远够得着。

/** 组的名字，同时也是 localStorage 里的字段名（别改，用户的选择存在那儿） */
const RAIL_GROUPS = ['pinned', 'recent', 'archived'];
const RAIL_GROUPS_KEY = 'duitanlu.railGroups.v1';

const RAIL_GROUP_ELS = {
  pinned: els.groupPinned,
  recent: els.groupRecent,
  archived: els.groupArchived,
};

/**
 * 每一组是不是收着的。
 *
 * 「置顶」「最近」默认展开，「已归档」默认**收着** —— 两个方向相反的默认值，各有各的道理：
 *   · 前两组默认展开：第一次打开就看到列表空着，会以为会话丢了；
 *   · 「已归档」默认收起：归档的意思本来就是「先别占地方」，
 *     一归档就把这一栏撑长、还要用户自己再收一次，那归档就白归了。
 *
 * 用户自己点过收起/展开之后，那个选择一直算数（存 localStorage，刷新还在）——
 * 所以那里没存过值时（undefined）不能一律写成 false，否则「已归档」的默认收起会被抹掉。
 * 存过的值只认显式的 true：手改过的 localStorage、别处导入的数据塞进来的 "yes" / 1
 * 一律当默认。
 */
function readGroupPreference() {
  const state = { pinned: false, recent: false, archived: true };
  try {
    const raw = JSON.parse(localStorage.getItem(RAIL_GROUPS_KEY) ?? '{}');
    for (const name of RAIL_GROUPS) {
      if (raw?.[name] === undefined) continue;
      state[name] = raw[name] === true;
    }
  } catch {
    /* 存坏了就用上面那套默认值 */
  }
  return state;
}

let groupCollapsed = readGroupPreference();

/**
 * 「最近」这一组默认画几个。
 *
 * 会话多了之后，这一组会把整栏撑得很长：真正要用的通常就是最近那几个，而老会话
 * 是「想起来才去找」的东西 —— 那件事交给搜索框（见 railSearch）。
 *
 * 这是**纯显示开关**：数据一直全在内存里，「显示全部」只是多画几行。
 * 不做「滚到底再加载」，是因为那会引入加载状态、滚动位置、以及「分组标题上的条数
 * 到底算画出来的还是算全部的」这类问题 —— 而收益（20 行 DOM）本来就不值这些。
 */
const RECENT_VISIBLE = 6;

/** 用户是不是点了「显示全部」（跟分组收起状态存在同一处，刷新后还在） */
function readRecentShowAll() {
  try {
    return JSON.parse(localStorage.getItem(RAIL_GROUPS_KEY) ?? '{}')?.recentAll === true;
  } catch {
    return false;
  }
}

let recentShowAll = readRecentShowAll();

/**
 * 「最近」这一组上一次画了多少行 / 一共几行。
 *
 * 存成模块状态，是因为「显示全部」那个按钮的显隐要在**两个时机**都算一遍：
 * 列表重画时（renderSessionList）和这一组被收起/展开时（paintRailGroups）。
 * 收起时它得跟着藏，展开时要按「有没有藏东西」放回来 —— 只在重画时算，
 * 收起再展开之后它就不会回来了。
 */
let recentMoreState = { total: 0, shown: 0 };

/**
 * 搜索框里现在有哪几个字（不持久化：刷新回来是干净的列表）。
 *
 * 一有内容，列表就切成平铺的「搜索结果」——分组收起状态和「最近只显示 6 个」都让位，
 * 但**一处都没被改**：清空输入框，原来的样子原封不动回来。
 */
let searchQuery = '';

function writeGroupPreference() {
  try {
    localStorage.setItem(RAIL_GROUPS_KEY, JSON.stringify({ ...groupCollapsed, recentAll: recentShowAll }));
  } catch {
    /* 存不下就只在这次会话里生效 */
  }
}

/** 把每一组的收起状态画出来（藏的是会话行，标题那一行不动） */
function paintRailGroups() {
  for (const name of RAIL_GROUPS) {
    const group = RAIL_GROUP_ELS[name];
    if (!group?.section) continue;
    const collapsed = groupCollapsed[name] === true;
    group.list.hidden = collapsed;
    group.toggle.setAttribute('aria-expanded', String(!collapsed));
    // 样式靠它翻箭头（收起来时箭头指向右边）
    group.section.dataset.collapsed = collapsed ? 'true' : 'false';
  }
  // 「显示全部」那个按钮跟着这一组的收起状态走（收起时藏、展开时按有没有藏东西放回来）
  paintRecentMore();
}

function setGroupCollapsed(name, collapsed) {
  if (!RAIL_GROUPS.includes(name)) return;
  groupCollapsed[name] = collapsed === true;
  writeGroupPreference();
  paintRailGroups();
}

function toggleRailGroup(name) {
  setGroupCollapsed(name, groupCollapsed[name] !== true);
}

for (const name of RAIL_GROUPS) {
  RAIL_GROUP_ELS[name]?.toggle?.addEventListener('click', () => toggleRailGroup(name));
}

// 「显示全部 / 只看最近几个」：只翻一个开关然后重画列表 —— 数据层一点没动
els.groupRecent?.more?.addEventListener('click', () => {
  recentShowAll = !recentShowAll;
  writeGroupPreference();
  renderSessionList();
});

// 搜索：输入即筛。会话最多 50 个（store 的上限），用不着防抖；
// Esc 清空是给键盘用户的出口（不然只能一个个字删掉）。
els.searchInput?.addEventListener('input', () => {
  searchQuery = els.searchInput.value ?? '';
  renderSessionList();
});
els.searchInput?.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  els.searchInput.value = '';
  searchQuery = '';
  renderSessionList();
});

/**
 * 一条会话行（三组共用）。
 * 置顶的那条，按钮改成「取消置顶」；归档的那条改成「取消归档」，并且**不再摆「置顶」**——
 * 它此刻不在列表里，而置顶的意思是「钉在列表最上面」，摆着就是个自相矛盾的按钮
 * （想置顶就先取消归档，那是同一个菜单里的第一项）。
 * 分支会话在行首带一个小箭头（样式给的）。
 *
 * 字段都写在 `item`（那个 `.session-item`）上、也返回 `item`，不再返回整片模板：
 * 模板里只有这一个 li，两者在真实浏览器里等价；而「谁被写进去了」保持一处，
 * 别的代码（和测试）拿着这一行就能读到它的 id / 名字 / 记住的东西。
 */
function sessionRow(session, activeId) {
  const frag = els.sessionTemplate.content.cloneNode(true);
  const item = frag.querySelector('.session-item');
  // 这一行的身份在这里写全（class + dataset）：模板只管里面的结构，
  // 于是「哪一行是哪一条会话」只有一处说法，点它、读它都认这一份。
  item.className = 'session-item';
  item.dataset.id = session.id;
  item.dataset.active = String(session.id === activeId);
  item.dataset.pinned = String(session.pinned === true);
  item.dataset.archived = String(session.archived === true);
  item.dataset.branch = String(Boolean(session.branchOf));

  const fullTitle = session.title || '新对话';
  const name = item.querySelector('[data-field="name"]');
  name.textContent = fullTitle;
  // 原生 title 是最底层兜底（屏幕阅读器、触摸屏、以及我们的浮层没跑起来的任何情况）
  name.title = fullTitle;
  const turns = session.messages.filter((m) => m.role === 'user').length;
  item.dataset.turns = String(turns);
  const meta = item.querySelector('[data-field="meta"]');
  // 搜索时这一行要回答「它为什么被搜出来」：正文命中的话把那一段摆出来
  const excerpt = searchQuery ? searchExcerpt(session, searchQuery) : '';
  meta.textContent = excerpt
    ? `匹配：${excerpt}`
    : `${formatClock(session.updatedAt)} · ${turns} 轮 · ${personaLabel(session.personaId)}`;
  // 行尾那个「多久了」：平时显示它，鼠标停在行上时换成「⋯」（见 styles.css 的 .session-slot）
  const age = item.querySelector('[data-field="age"]');
  if (age) age.textContent = formatAge(session.updatedAt);

  const pin = item.querySelector('[data-action="pin"]');
  const pinned = session.pinned === true;
  const archived = session.archived === true;
  pin.hidden = archived;
  pin.textContent = pinned ? '取消置顶' : '置顶';
  pin.title = pinned ? '取消置顶，回到「最近」' : '置顶（钉在列表最上面）';

  // 归档 / 取消归档：同一个按钮，两副面孔（和上面那个置顶按钮一个路子）。
  // 「已归档」那一组里每一行都点着这一个 —— 它就是归档的出口。
  const archive = item.querySelector('[data-action="archive"]');
  archive.textContent = archived ? '取消归档' : '归档';
  archive.title = archived
    ? '取消归档，回到「最近」'
    : '归档（从列表里收起来，一条都没删）';
  return item;
}

/**
 * 「最近」组的显示裁剪。
 *
 * 规则只有一条，但它很要紧：**当前会话必须在列**。否则刷新之后（active 可能是个很老的
 * 会话）你会看到自己正待着的那个会话不在左栏里 —— 像丢了。它在 6 条之外时补在末尾。
 *
 * 「补在末尾」只对没归档的会话成立：归档是用户**自己按下去的**，
 * 那一条本来就该离开「最近」（它去了「已归档」），不属于「像丢了」那类意外。
 * 刷新之后它照样在「已归档」里，位置固定、找得回来。
 *
 * 注意这里只决定**画哪几行**：会话总数、分组条数一律照真实值写。
 */
function trimRecentRows(rows, activeId) {
  const head = rows.slice(0, RECENT_VISIBLE);
  if (head.some((session) => session.id === activeId)) return head;
  const current = rows.find((session) => session.id === activeId);
  return current ? [...head, current] : head;
}

/**
 * 「显示全部（还藏着 N 个）」/「只看最近 N 个」那一个按钮。
 *
 * 纯显示开关：数据一直全在内存里，展开只是多画几行 —— 没有加载状态，
 * 也不存在「滚到底才加载」那套副作用。展开时按钮改口成收回，
 * 免得它变成一个只能展开、没法还原的死胡同。
 */
function paintRecentMore() {
  const button = els.groupRecent?.more;
  if (!button) return;
  const { total, shown } = recentMoreState;
  const hidden = Math.max(0, total - shown);
  button.dataset.hiddenCount = String(hidden);
  // 没东西可藏（会话本来就不多）：这个按钮没有存在的理由 —— 展开着也一样
  if (total <= RECENT_VISIBLE) {
    button.hidden = true;
    return;
  }
  // 搜索时列表是平铺的结果，这个按钮同样没有存在的理由
  button.hidden = searchQuery !== '' || groupCollapsed.recent === true;
  button.textContent = recentShowAll ? `只看最近 ${RECENT_VISIBLE} 个` : `显示全部（还藏着 ${hidden} 个）`;
  button.title = recentShowAll
    ? '把「最近」收回到默认的几个（一个会话都没删）'
    : `「最近」还有 ${hidden} 个会话没显示出来`;
}

/**
 * 按一段字找会话：**标题或正文**命中都算。
 *
 * 正文要连**每一版**一起看（编辑过的提问、重新生成的回答都躺在 `versions` 里）——
 * 只看当前显示的那一版，就会出现「我明明写过这句话」却搜不到的情况。
 * 大小写不敏感：中文没有大小写，但中英混排太常见了。
 *
 * 返回值有个讲究：`null` 表示「没在搜索」，`[]` 表示「搜了，但一个都没命中」——
 * 这两件事在界面上长得完全不一样。
 */
function searchSessions(sessions, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return null;
  return sessions.filter(
    (session) =>
      String(session.title ?? '').toLowerCase().includes(needle)
      || session.messages.some((message) => messageTexts(message).some((text) => text.includes(needle))),
  );
}

/** 一条消息的所有文字（当前这一版 + 每一版）都转成小写，供搜索比对 */
function messageTexts(message) {
  return [message.content, ...(message.versions ?? []).map((v) => v?.content)].map((text) =>
    String(text ?? '').toLowerCase());
}

/**
 * 命中的那一小段上下文，摆到结果行里当说明（不然「正文命中」看不出命中在哪儿）。
 * 标题命中时返回空串 —— 那就照旧显示「时间 · 几轮 · 角色」。
 */
function searchExcerpt(session, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return '';
  for (const message of session.messages) {
    for (const text of [message.content, ...(message.versions ?? []).map((v) => v?.content)]) {
      const body = String(text ?? '');
      const at = body.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      const from = Math.max(0, at - 8);
      const snippet = body.slice(from, from + 30).replace(/\s+/g, ' ').trim();
      return `${from > 0 ? '…' : ''}${snippet}${from + 30 < body.length ? '…' : ''}`;
    }
  }
  return '';
}

/**
 * 画「搜索结果」那一块。
 * 没在搜索时整块藏起来（`hits === null`），两组照旧；在搜索时空结果是**一句话**，
 * 不是一个空列表 —— 空列表看起来像坏了。
 */
function paintSearchResults(hits, activeId) {
  const box = els.groupSearch;
  if (!box?.section) return;
  box.section.hidden = hits === null;
  if (hits === null) {
    box.list.replaceChildren();
    if (box.empty) box.empty.hidden = true;
    return;
  }
  box.count.textContent = String(hits.length);
  box.list.replaceChildren(...hits.map((session) => sessionRow(session, activeId)));
  if (box.empty) box.empty.hidden = hits.length > 0;
}

function renderSessionList() {
  const sessions = store.sessions;
  const activeId = store.sessionId;

  hideTitleFloat(); // 列表要重画了，浮出来的完整标题立刻失去意义
  closeSessionMenu(); // 菜单里的按钮也一起被重画，留着就是指向已消失的节点
  // 「会话」这个数字说的是**这一栏里摆着的**那几条：归档的不算。
  // 归档的在「已归档」那一组的标题上有自己的一条条数，两处加起来才是全部 ——
  // 不分的话，「我归档了一个，怎么还是 7」是必然会冒出来的疑问。
  els.sessionCount.textContent = String(sessions.filter((s) => s.archived !== true).length);

  const groups = groupSessions(sessions);
  // null = 没在搜索；有内容时才切成平铺的「搜索结果」
  const hits = searchSessions(sessions, searchQuery);
  let recentShown = 0;
  for (const name of RAIL_GROUPS) {
    const group = RAIL_GROUP_ELS[name];
    if (!group?.list) continue;
    const rows = groups[name];
    // 空的那一组整块藏起来：没有置顶的会话时，不该摆一个空的「置顶」标题在那儿
    // （搜索时两组一起让位：这时候你要的是「找到它」，不是按最近使用一页页翻）
    group.section.hidden = hits !== null || rows.length === 0;
    // 条数徽标写的是**这一组真实有几条**，跟画出来几行无关（藏起来的那几个也算）
    group.count.textContent = String(rows.length);
    // 「最近」默认只画前几个；「置顶」和「已归档」不裁 ——
    // 前一个是用户明确说过重要的东西，后一个是**你自己点开才看到的**（那一组默认收着），
    // 再在里面藏掉几个纯粹是添乱。
    const visible = name === 'recent' && !recentShowAll ? trimRecentRows(rows, activeId) : rows;
    if (name === 'recent') recentShown = visible.length;
    group.list.replaceChildren(...visible.map((session) => sessionRow(session, activeId)));
  }

  paintRailGroups();
  recentMoreState = { total: (groups.recent ?? []).length, shown: recentShown };
  paintRecentMore();
  paintSearchResults(hits, activeId);

  // 只有一个会话时不允许删，按钮就别装作能点
  const deletable = sessions.length > 1;
  for (const item of els.sessionList.querySelectorAll('.session-item')) {
    const deleteButton = item.querySelector('[data-action="delete"]');
    if (deleteButton) {
      deleteButton.disabled = !deletable;
      if (!deletable) deleteButton.title = '至少保留一个会话';
    }
    // 还没说过话的会话没什么可命名的
    const retitleButton = item.querySelector('[data-action="retitle"]');
    if (retitleButton && item.dataset.turns === '0') {
      retitleButton.disabled = true;
      retitleButton.title = '这个会话还没有内容';
    }
  }

  // 切换/新建之后，把当前会话滚进可视区（见 railRevealPending 的说明）
  if (railRevealPending) {
    railRevealPending = false;
    const activeItem = els.sessionList.querySelector('.session-item[data-active="true"]');
    activeItem?.scrollIntoView?.({ block: 'nearest' });
  }
}

els.sessionList.addEventListener('click', (event) => {
  const item = event.target.closest('.session-item');
  if (!item) return;
  const id = item.dataset.id;
  const action = event.target.closest('[data-action]')?.dataset.action;

  // 点「⋯」：开菜单（这是唯一不关菜单的动作，其余动作都要先把菜单收掉）
  if (action === 'more') {
    openSessionMenuFor(item, event.target.closest('[data-action="more"]'));
    return;
  }
  closeSessionMenu();

  if (action === 'pin') {
    const session = store.sessions.find((s) => s.id === id);
    const next = session?.pinned !== true;
    if (!store.setPinned(id, next)) return;
    // 它要挪到另一组去：那一组要是正收着，先展开 ——
    // 否则点一下看起来像「这个会话不见了」（这一栏不许有看起来没反应的操作）。
    setGroupCollapsed(next ? 'pinned' : 'recent', false);
    renderSessionList();
    flashHint(next ? '已置顶，钉在列表最上面' : '已取消置顶，回到「最近」', 2200);
    return;
  }

  if (action === 'archive') {
    const session = store.sessions.find((s) => s.id === id);
    const next = session?.archived !== true;
    if (!store.setArchived(id, next)) return;
    // 取消归档之后它回「最近」：那一组要是正收着，先展开（和置顶同一条道理）。
    // 归档时**不**把「已归档」展开 —— 那一组默认就是收着的，一归档就展开等于
    // 每次都把这一栏撑长一次；「它去哪儿了」交给下面那句话回答。
    if (!next) setGroupCollapsed('recent', false);
    // 归档**不**把你切走：正文里正看着的这个会话留在原地（它只是不在列表里了）。
    // 「聊完这一条，把它收起来」恰恰是最常见的用法 —— 这时候被弹到别的会话上才讨厌。
    renderSessionList();
    flashHint(next ? '已归档，左栏「已归档」里找得回来' : '已取消归档，回到「最近」', 2600);
    return;
  }

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
    const next = window.prompt('给这个会话换个名字', session?.title ?? '');
    if (next !== null) {
      store.renameSession(id, next);
      renderAll();
    }
    return;
  }

  if (action === 'retitle') {
    const session = store.sessions.find((s) => s.id === id);
    if (!session?.messages.length) {
      flashHint('这个会话还没有内容，没法命名', 2400);
      return;
    }
    if (runtime.config.mode === 'mock') {
      flashHint('离线模式的名字是本地算的；接上模型后点「自动命名」才行', 3600);
      return;
    }
    flashHint('正在自动命名…', 1600);
    void requestTitle(id, { force: true }).then((ok) => {
      if (!ok) flashHint('这次没命名成功，稍后再试', 2600);
    });
    return;
  }

  // 切到已有对话前，先把「进来时自动开的那个空白会话」清掉 ——
  // 留着它只会让列表里堆一串没用的「新对话」。
  // 注意 keepId：如果点的那个会话本身是空的（也是新建的），要留着它。
  switchToSession(id);
});

// ---------------------------------------------------------------- 会话行的「⋯」菜单
//
// 置顶 / 重命名 / 自动命名 / 删除都收进这个菜单，行尾只留一个「⋯」。
// 为什么：那四个文字按钮以前是**常驻**排着的（只做了 `opacity: 0`，宽度照占），
// 292px 的行里被吃掉约 145px，标题只剩六七个字。收进菜单之后整行宽度都归标题。
//
// 三个纪律，和标题浮层一致：
//   · 菜单是 `position: fixed`（会话列表 `overflow-y: auto`，absolute 会被裁掉），
//     位置按「⋯」的 rect 算，贴到视口下边就翻到上面；
//   · 同一时刻只开一个；开菜单时把标题浮层收掉（两个浮层不叠着出现）；
//   · 点条目 / 点外面 / Esc / 列表滚动 / 窗口缩放 / 列表重画 —— 一律收起。

let openSessionMenu = null;

function closeSessionMenu() {
  if (!openSessionMenu) return;
  openSessionMenu.menu.hidden = true;
  openSessionMenu.button.setAttribute('aria-expanded', 'false');
  openSessionMenu = null;
}

function openSessionMenuFor(row, button) {
  const menu = row?.querySelector?.('.session-menu');
  if (!menu) return;
  closeSessionMenu();
  hideTitleFloat(); // 两个浮层不叠着出现

  menu.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  openSessionMenu = { row, menu, button };

  const rect = button.getBoundingClientRect();
  const width = menu.offsetWidth || 150;
  const height = menu.offsetHeight || 150;
  // 右对齐到「⋯」，但不许跑出屏幕
  const left = Math.min(rect.right - width, Math.max(8, window.innerWidth - width - 8));
  // 默认挂在下面；下面放不下就翻到上面
  const below = rect.bottom + 6;
  const top = below + height > window.innerHeight - 8
    ? Math.max(8, rect.top - height - 6)
    : below;
  menu.style.left = `${Math.round(Math.max(8, left))}px`;
  menu.style.top = `${Math.round(top)}px`;
}

// ---------------------------------------------------------------- 会话标题的完整版
//
// 会话栏 292px 宽、标题上限 60 字：一行只放得下约 20 个汉字，所以标题**必须**有个看全的出口。
// 两条一起给：
//   · CSS 那边先把标题放宽到**两行**（约 40 字直接看得见，多数标题到此就够了）；
//   · 这里再补一个浮层：悬停 / 键盘聚焦时浮出完整标题。
//
// 三个细节，都是踩过才知道的：
//   · **只在真的被截断时才弹**。没截断也弹一张写着一模一样内容的卡片，那是噪音。
//   · 浮层挂在页面级（`position: fixed`）而不是塞在会话行里 —— 列表是 `overflow-y: auto`
//     的一格，放在行内会被裁掉。
//   · 鼠标移进浮层会让那一行收到 `mouseleave`，所以收起用 160ms 延迟兜一下：
//     这样**浮层里的文字能选中复制**（长标题经常就是要复制走的）。
// 触摸屏没有 hover（CSS 那边有 `@media (hover: none)`）—— 那条路径上靠两行 + 原生 title 兜底。

let titleFloatTimer = null;

function hideTitleFloat() {
  if (titleFloatTimer) {
    clearTimeout(titleFloatTimer);
    titleFloatTimer = null;
  }
  if (els.titleFloat) els.titleFloat.hidden = true;
}

/** 延迟收起：给鼠标从会话行移到浮层上留出时间（否则一移过去就消失，文字没法选中） */
function scheduleHideTitleFloat() {
  if (titleFloatTimer) clearTimeout(titleFloatTimer);
  titleFloatTimer = setTimeout(() => {
    titleFloatTimer = null;
    if (els.titleFloat) els.titleFloat.hidden = true;
  }, 160);
}

/** 标题真的被截断了吗（没截断就别弹） */
function isTitleClipped(name) {
  return name.scrollWidth > name.clientWidth + 1 || name.scrollHeight > name.clientHeight + 1;
}

function showTitleFloat(row) {
  const name = row?.querySelector?.('[data-field="name"]');
  const text = name?.textContent ?? '';
  if (!name || !text || !isTitleClipped(name)) {
    hideTitleFloat();
    return;
  }
  if (titleFloatTimer) {
    clearTimeout(titleFloatTimer);
    titleFloatTimer = null;
  }
  const float = els.titleFloat;
  if (!float) return;
  float.textContent = text;
  float.hidden = false;

  // 摆在那一行右边（会话栏和正文之间那道缝的位置），上下跟行对齐；
  // 贴到视口下边或右边就翻回来，别跑出屏幕。
  const rect = row.getBoundingClientRect();
  const width = float.offsetWidth || 220;
  const height = float.offsetHeight || 40;
  const left = Math.min(rect.right + 8, Math.max(8, window.innerWidth - width - 8));
  const top = Math.min(rect.top, Math.max(8, window.innerHeight - height - 8));
  float.style.left = `${Math.round(left)}px`;
  float.style.top = `${Math.round(top)}px`;
}

els.titleFloat?.addEventListener('mouseenter', () => {
  // 鼠标进到浮层上：取消收起（文字可以选中复制）
  if (titleFloatTimer) {
    clearTimeout(titleFloatTimer);
    titleFloatTimer = null;
  }
});
els.titleFloat?.addEventListener('mouseleave', hideTitleFloat);

els.sessionList.addEventListener('mouseover', (event) => {
  const row = event.target.closest?.('.session-item');
  if (row) showTitleFloat(row);
});
els.sessionList.addEventListener('mouseout', (event) => {
  const row = event.target.closest?.('.session-item');
  if (!row) return;
  // 在同一行内部移动（行 → 标题 → 元信息）不算离开
  const to = event.relatedTarget;
  if (to && row.contains?.(to)) return;
  scheduleHideTitleFloat();
});
// 键盘 Tab 到某一行的按钮上时也浮出来（鼠标不是唯一的读法）
els.sessionList.addEventListener('focusin', (event) => {
  const row = event.target.closest?.('.session-item');
  if (row) showTitleFloat(row);
});
els.sessionList.addEventListener('focusout', scheduleHideTitleFloat);
// 列表滚动（或窗口缩放）之后那一行的位置就变了，浮层跟着滚会指错地方
els.sessionList.addEventListener('scroll', hideTitleFloat, true);
els.sessionList.addEventListener('scroll', closeSessionMenu, true);
window.addEventListener('resize', hideTitleFloat);
window.addEventListener('resize', closeSessionMenu);

// 行尾那几个「多久了」会随时间变（`刚刚` → `5 分钟前`）：
// 每 30 秒刷一次，页面不可见时不干活（后台标签页不该占 CPU）。
// 另外回到这个页面时也刷一次 —— 离开了半小时再切回来，时间该是准的。
setInterval(() => {
  if (!document.hidden) refreshSessionAges();
}, 30_000);
window.addEventListener('focus', refreshSessionAges);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshSessionAges();
});

// ---------------------------------------------------------------- 会话标题
//
// 标题分两步走，和 ChatGPT 的做法一致：
//   1. 第一次发消息时，本地**立刻**算一个兜底标题（lib/title.js 的 fallbackTitle）——
//      侧栏任何时候都不会是空的，也不用等网络；
//   2. 这一轮回答写完之后，后台再问模型要一个更像样的标题来替换它。
//
// 三个约束：
//   · **只替换兜底标题**。用户自己改过的名字永远不动（titleSource === 'manual'）；
//     只有他明确点「自动命名」时才允许覆盖 —— 那一次传 force。
//   · **绝不挡正文**。这是后台小请求，失败、超时、离线都只是「标题保持兜底那版」，
//     不弹错误、不影响对话。
//   · 不重试、不换模型：上游挂了就让它挂着，反正标题已经有一个能用的了。

/** 拼这次请求要用的原料：开头的一问一答，加上后来问过的几件事 */
function titleInputFor(session) {
  const texts = (role) =>
    session.messages.filter((m) => m.role === role).map((m) => m.content ?? '').filter((t) => t.trim());
  const questions = texts('user');
  return {
    question: questions[0] ?? '',
    answer: texts('assistant')[0] ?? '',
    laterQuestions: questions.slice(1),
  };
}

/**
 * 要一个模型标题并写回会话。
 * @returns {Promise<boolean>} 是否真的换上了新标题
 */
async function requestTitle(sessionId, { force = false } = {}) {
  const session = store.sessions.find((s) => s.id === sessionId);
  if (!session) return false;
  if (!force && !needsAutoTitle(session)) return false;
  // 离线模式没有模型可用，本地兜底标题就是最终标题
  if (runtime.config.mode === 'mock') return false;
  // 同一个会话已经在起了：重复发请求只会浪费一次调用
  if (runtime.titlingSessions.has(sessionId)) return false;

  const input = titleInputFor(session);
  if (!input.question) return false;

  runtime.titlingSessions.add(sessionId);
  try {
    const response = await fetch('/api/title', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...input,
        model: session.model || runtime.chosenModel || runtime.serverDefaultModel || undefined,
      }),
    });
    const data = await response.json().catch(() => ({}));
    // 服务端已经洗过一遍，这里再洗一次：两边的规则是同一份（lib/title.js），是幂等的
    const title = titleFromModel(data?.title);
    if (!title) return false;
    return store.applyTitle(sessionId, title, { force });
  } catch {
    // 起标题失败不是错误：兜底标题已经显示着了
    return false;
  } finally {
    runtime.titlingSessions.delete(sessionId);
    renderSessionList();
  }
}

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

  // 编号写两份：正文里那份给人看，dataset 那份给「按编号找节点」的逻辑（测试也读它）。
  // 都从 node 上取 —— 真实 DOM 里和从 frag 上取等价，但替身不解析 HTML，
  // 只有挂在同一个元素上的查询才会回同一个占位节点。
  node.dataset.turn = String(number);
  node.querySelector('[data-field="number"]').textContent = String(number).padStart(2, '0');

  node.__assistant = frag.querySelector('[data-field="answer-turn"]');
  node.__answerBody = frag.querySelector('[data-field="answer"]');
  node.__answerModel = frag.querySelector('[data-field="answer-model"]');
  node.__answerVersion = frag.querySelector('[data-field="answer-version"]');
  node.__questionBody = frag.querySelector('[data-field="question"]');
  node.__questionImages = frag.querySelector('[data-field="question-images"]');
  node.__questionQuote = frag.querySelector('[data-field="question-quote"]');
  node.__questionQuoteLabel = frag.querySelector('[data-field="question-quote-label"]');
  node.__questionQuoteText = frag.querySelector('[data-field="question-quote-text"]');
  node.__askedAt = frag.querySelector('[data-field="asked-at"]');
  node.__userTag = frag.querySelector('[data-field="user-tag"]');
  node.__versionBar = frag.querySelector('[data-field="question-versions"]');
  node.__editBox = frag.querySelector('[data-field="edit-box"]');
  node.__editInput = frag.querySelector('[data-field="edit-input"]');
  node.__editHint = frag.querySelector('[data-field="edit-hint"]');

  // 评价（点赞 / 拉踩 + 补充说明）
  node.__rateUp = frag.querySelector('[data-action="rate-up"]');
  node.__rateDown = frag.querySelector('[data-action="rate-down"]');
  node.__feedbackSaved = frag.querySelector('[data-field="feedback-saved"]');
  node.__feedbackBox = frag.querySelector('[data-field="feedback-box"]');
  node.__feedbackTitle = frag.querySelector('[data-field="feedback-title"]');
  node.__feedbackReasons = frag.querySelector('[data-field="feedback-reasons"]');
  node.__feedbackNote = frag.querySelector('[data-field="feedback-note"]');
  node.__feedbackHint = frag.querySelector('[data-field="feedback-hint"]');

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

    // 这一问引用了回答里的哪一段。引用跟着版本走：翻回旧的一页，
    // 看到的就是当时引的那段，而不是最新版引的内容。
    const quote = qv.quote;
    const quoting = hasQuote(quote);
    node.__questionQuote.hidden = !quoting;
    if (quoting) {
      node.__questionQuoteLabel.textContent = quoteLabel(quote);
      node.__questionQuoteText.textContent = quote.truncated ? `${quote.text}\n…` : quote.text;
      // 正文里最多显示六行（见 styles.css 的 .turn-quote-text），完整原文放在悬停提示里
      node.__questionQuote.title = quote.text;
    }

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

  paintFeedback(node, message, shown, av);
}

// ---------------------------------------------------------------- 评价（赞 / 踩 + 补充）
//
// 参考 ChatGPT：每条回答下面有赞和踩。三个地方刻意做得比它好：
//  · **点错了能改**：再点一次取消，点另一边就是改判（ChatGPT 点下去就改不了了）；
//  · **点了赞就是一次完整反馈**，下面那个框是可选的补充，不填也算数；
//  · **服务端写不进去要说出来**：评价先存在本机，提交失败时会明确提示，
//    而不是让用户以为交上去了（「看不清结果」是这个项目反复踩过的坑）。

/** 这一页的评价现在长什么样 */
function paintFeedback(node, message, shown, av) {
  const saved = av.feedback ?? null;

  for (const [button, info] of [
    [node.__rateUp, RATINGS[0]],
    [node.__rateDown, RATINGS[1]],
  ]) {
    const active = saved?.rating === info.id;
    button.dataset.active = active ? 'true' : 'false';
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('title', active ? `${info.title}（再点一次取消）` : info.title);
  }

  // 「附了说明」这件事要留痕：光看按钮只知道赞/踩，不知道当初还写了字
  const hasDetail = Boolean(saved && (saved.reasons.length || saved.note));
  node.__feedbackSaved.hidden = !hasDetail;
  if (hasDetail) node.__feedbackSaved.textContent = '已附说明';

  const open =
    runtime.feedbackOpen &&
    runtime.feedbackOpen.messageId === message.id &&
    runtime.feedbackOpen.version === shown &&
    runtime.feedbackDraft;
  node.__feedbackBox.hidden = !open;
  if (!open) return;

  const draft = runtime.feedbackDraft;
  const info = ratingInfo(draft.rating);
  node.__feedbackTitle.textContent =
    draft.rating === 'down'
      ? `${info.icon} 哪里不对？点几个原因，或者补一句`
      : `${info.icon} 哪里帮到你了？补一句更好`;

  const options = reasonsFor(draft.rating);
  node.__feedbackReasons.hidden = options.length === 0;
  node.__feedbackReasons.replaceChildren(
    ...options.map((option) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'feedback-chip';
      chip.dataset.action = 'feedback-reason';
      chip.dataset.reason = option.id;
      chip.dataset.active = draft.reasons.includes(option.id) ? 'true' : 'false';
      chip.setAttribute('aria-pressed', String(draft.reasons.includes(option.id)));
      chip.textContent = option.label;
      return chip;
    }),
  );

  // 正在这个框里打字时不要把内容覆盖掉
  if (document.activeElement !== node.__feedbackNote) node.__feedbackNote.value = draft.note;
  node.__feedbackHint.hidden = true;
}

/** 打开某一页的评价框（先把已存的内容填进去） */
function openFeedbackBox(message, shown, rating, saved) {
  runtime.feedbackOpen = { messageId: message.id, version: shown };
  runtime.feedbackDraft = {
    messageId: message.id,
    version: shown,
    rating,
    reasons: [...(saved?.reasons ?? [])],
    note: saved?.rating === rating ? (saved?.note ?? '') : '',
  };
}

function closeFeedbackBox() {
  runtime.feedbackOpen = null;
  runtime.feedbackDraft = null;
}

/** 把评价发到服务端（失败不静默：本地存住了，但要说清服务端没收到） */
async function postFeedback({ message, version, feedback, action = 'set' }) {
  const index = store.messages.indexOf(message);
  const question = store.messages[index - 1];
  const payload = feedbackPayload({
    feedback,
    action,
    sessionId: store.sessionId,
    messageId: message.id,
    version,
    model: message.versions[version - 1]?.model ?? '',
    mode: runtime.config.mode ?? '',
    question: question?.versions?.[0]?.content ?? '',
    answer: message.versions[version - 1]?.content ?? '',
  });
  if (!payload) return false;

  try {
    const response = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return true;
  } catch (err) {
    flashHint(`评价已留在本机，但没能交给服务端：${err.message}`, 4200);
    return false;
  }
}

/**
 * 「这条会话是从哪儿分出来的」那条说明。
 *
 * 出处是**快照**，不是活引用：源会话还在就显示它现在的标题（点得进去），
 * 被删掉了就退回建分支时存下的那个标题，并标一句「已删除」。
 * 图片一律不带进分支，所以这里要如实说清带走了几张图 —— 不说的话，
 * 模型看不见图、用户却以为它看过（它会答「我没看到图」，那不是它的错）。
 */
function paintBranchNote() {
  const note = els.branchNote;
  if (!note) return;
  const origin = store.session.branchOf;
  if (!origin) {
    note.hidden = true;
    return;
  }

  const source = store.sessions.find((s) => s.id === origin.id);
  const parts = [`分支自《${source?.title || origin.title || '那个会话'}》`];
  if (!source) parts.push('原会话已删除');
  if (origin.images > 0) parts.push(`原会话的 ${origin.images} 张图没有带过来`);

  els.branchNoteText.textContent = parts.join(' · ');
  els.branchSourceButton.hidden = !source;
  note.hidden = false;
}

/**
 * 切到某个会话。
 *
 * 会话列表里的点击、以及分支说明条上的「回到那个会话」，都走这里 ——
 * 两处的行为必须一模一样（清掉空白会话、恢复运行时、滚进可视区、回到输入框），
 * 各写一份迟早会分叉。
 */
function switchToSession(id) {
  // 切走之前，把「进来时自动开的那个空白会话」清掉 —— 留着只会让列表里堆一串「新对话」。
  // 注意 keepId：要切过去的那个会话本身是空的（也是新建的）时，得留着它。
  const dropped = store.dropEmptySessions({ keepId: id });
  if (!store.switchSession(id)) return false;

  runtime.pinned = true;
  runtime.liveTurn = null;
  runtime.renderNode = null;
  railRevealPending = true; // 切到哪一条，就把它滚进可视区
  renderAfterSessionSwitch();
  scrollToBottom();
  els.input.focus();
  if (dropped > 0) flashHint('已清掉空白的「新对话」', 2200);
  return true;
}

// 分支说明条上的「回到那个会话」（源会话还在才显示这个按钮）
els.branchSourceButton?.addEventListener('click', () => {
  const origin = store.session.branchOf;
  if (!origin) return;
  const source = store.sessions.find((s) => s.id === origin.id);
  if (!source) {
    flashHint('那个会话已经删掉了', 2600);
    return;
  }
  switchToSession(source.id);
});

// ---------------------------------------------------------------- 会话引用（背景材料）
//
// 和「分出新会话」的分工（详见 lib/reference.js 顶部那段）：
//   分支 = 把整段对话**搬过去继续聊**（复制品变成新会话自己的消息，两边各走各的）；
//   引用 = 把另一个会话的内容当**材料**带进一个新话题 —— 不进本会话的消息、不进导出的正文、
//          不占压缩的下标，随时能换能删。
// 判据的另一半是上限：摘要不限轮数，「原文」最多 3 轮 —— 超过就该去用分支。

/** 把勾选的轮次还原成消息数组（摘要档要交给 /api/summarize） */
function referenceSlice(source, numbers) {
  const messages = Array.isArray(source?.messages) ? source.messages : [];
  const pairs = turnPairs(messages);
  const picked = numbers.length ? pairs.filter((pair) => numbers.includes(pair.number)) : pairs;
  const out = [];
  for (const pair of picked) {
    const question = messages[pair.index];
    const answer = messages[pair.index + 1];
    if (question) out.push(question);
    if (answer?.role === 'assistant') out.push(answer);
  }
  return out;
}

/** 面板上那句实时说明：说清这一按会发生什么，哪条路走不通也讲明白 */
function referenceStatusText() {
  const draft = runtime.referenceDraft;
  const source = store.sessions.find((s) => s.id === draft?.sourceId);
  if (!source) return '先选一个会话';

  const pairs = turnPairs(source.messages);
  if (!pairs.length) return '这个会话还没有可以引用的内容（至少要有一问一答）';

  const picked = draft.numbers.length;
  const scope = picked ? `第 ${draft.numbers.join('、')} 轮` : `整个会话（${pairs.length} 轮）`;

  if (draft.kind === 'turns') {
    if (picked > MAX_REFERENCE_TURNS || (!picked && pairs.length > MAX_REFERENCE_TURNS)) {
      const scopeText = picked ? `你勾了 ${picked} 轮` : `整个会话有 ${pairs.length} 轮`;
      return `「原文」档最多 ${MAX_REFERENCE_TURNS} 轮 —— ${scopeText}。少勾几轮，或者改成「摘要」档；想整段接着聊就用「分出新会话」`;
    }
    return `会把 ${picked ? scope : `全部 ${pairs.length} 轮`} 的一问一答原文照搬过去（最多 ${MAX_REFERENCE_TURNS} 轮）`;
  }
  if (runtime.config.mode === 'mock') {
    return '离线模式起不了摘要 —— 改成「原文」档就能用（它不需要模型）';
  }
  return `会先让模型把 ${scope} 压成一段摘要，再带进新会话`;
}

/** 哪些会话可以被引用（下拉框） */
function paintReferenceSources() {
  const draft = runtime.referenceDraft;
  const sessions = store.sessions;
  // 源会话找不到了（被删掉了）就落到列表里第一个，并且**把之前勾的轮次一起清掉**：
  // 那些轮次号属于那个已经不在的会话，留着会被当成新源会话的轮次照勾出来 ——
  // 用户看到几个「自己没勾过的勾」，确认下去带走的是一份来源和轮次都对不上号的材料。
  if (!sessions.some((s) => s.id === draft.sourceId)) {
    draft.sourceId = sessions[0]?.id ?? '';
    draft.numbers = [];
  }
  els.referenceSource.replaceChildren(
    ...sessions.map((session) => {
      const option = document.createElement('option');
      option.value = session.id;
      option.textContent = `${session.title || '新对话'} · ${turnPairs(session.messages).length} 轮`;
      option.selected = session.id === draft.sourceId;
      return option;
    }),
  );
}

/** 把可选的轮次列成勾选框（不勾 = 整个会话） */
function paintReferenceTurns() {
  const draft = runtime.referenceDraft;
  const source = store.sessions.find((s) => s.id === draft.sourceId);
  els.referenceTurns.replaceChildren(
    ...turnPairs(source?.messages).map((pair) => {
      const label = document.createElement('label');
      label.className = 'reference-turn';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset.action = 'reference-turn';
      box.dataset.number = String(pair.number);
      box.checked = draft.numbers.includes(pair.number);
      const text = document.createElement('span');
      text.className = 'reference-turn-text';
      // 多页的轮次要标出来：材料取的是**最后一页**，用户得看得见这件事
      //（他改过这一问几版，就说明这里本来有几页可选）
      //
      // 页数写在**问题前面**：这一格是 nowrap + 省略号（`.reference-turn-text` 的
      // max-width: 300px），24 个字的问题本来就顶到宽度上限 —— 把「N 页」放在后面
      // 会被省略号直接吃掉，而那正是这条标记存在的理由。
      const pages = pair.pages > 1 ? `（${pair.pages} 页）` : '';
      const preview = pair.question.replace(/\s+/g, ' ').slice(0, 24);
      text.textContent = `第 ${pair.number} 轮${pages} · ${preview}`;
      label.appendChild(box);
      label.appendChild(text);
      return label;
    }),
  );
}

/**
 * 这个会话已经挂着的那份材料（没有就返回 null）。
 *
 * 「一个会话一份背景材料」是这个功能的判据：它能被「改选轮次」改、被「移除材料」清。
 * 所以「引用会话」= 设置**这个会话**的材料 —— 已经有就把现有的摆出来让你改，
 * 而不是重开一份把旧的悄悄盖掉（那条路已经出过事）。
 */
function existingReference() {
  const reference = store.session.reference;
  return isValidReference(reference) ? reference : null;
}

/**
 * 面板顶上那句「这次确认会发生什么」。
 *
 * 材料现在是**就地在当前会话上生效**（另一条路「带着它开一个新会话」写在旁边那个次要入口上），
 * 所以规则只有一条：**一个会话一份材料，已有就是替换** —— 必须写在按下去之前。
 */
function referenceReplaceNoteText() {
  const existing = existingReference();
  if (!existing) return '';
  const alive = store.sessions.some((s) => s.id === existing.sessionId);
  const from = referenceLabel(existing).replace(/^背景材料：/, '') + (alive ? '' : '（原会话已删除）');
  return `这个会话已经有一份背景材料（${from}）。一个会话只带一份材料，`
    + '所以确认会替换它（旧的那份就没了）；不想带就点「移除材料」。';
}

/** 确认按钮该说什么：这个会话里已经有材料时，它做的是**替换**，不能还写着「用这份材料」 */
function referenceConfirmLabel() {
  return existingReference() ? '替换这份材料' : '在这个会话里生效';
}

function paintReferencePanel() {
  if (!runtime.referenceDraft) return;
  // 「材料形式」下拉框是**视图**，值必须跟着草稿走。
  //
  // 少这一行就会出岔子：下拉框会一直停在用户上一回挑的那一档，于是面板上写着「原文」、
  // 实际按「摘要」走（状态行还说要模型压一遍）；更麻烦的是用户再去点一次「原文」
  // 不会触发 change（值本来就是它），错位就永久留在那儿了。
  if (els.referenceKind) els.referenceKind.value = runtime.referenceDraft.kind;
  paintReferenceSources();
  paintReferenceTurns();
  els.referenceStatus.textContent = referenceStatusText();

  // 已有材料时：把后果和按钮文案都改口（少这两行就又变成「静默替换」）
  const note = referenceReplaceNoteText();
  if (els.referenceReplaceNote) {
    els.referenceReplaceNote.textContent = note;
    els.referenceReplaceNote.hidden = !note;
  }
  if (els.referenceConfirm) els.referenceConfirm.textContent = referenceConfirmLabel();

  // 「带着它开一个新会话」只在**已经聊过**的会话里才给：空会话里这两条路是同一件事
  //（空会话上就地生效 = 直接用掉它），摆两个按钮只会让人犹豫。
  if (els.referenceNewSessionLink) {
    els.referenceNewSessionLink.hidden = store.session.messages.length === 0;
  }
}

/**
 * 打开引用面板。
 *
 * 三个入口（左栏「引用会话」、报头备用入口、材料条上的「改选轮次」）做的是**同一件事**：
 * 设置这个会话的背景材料。所以只要这个会话已经有一份，面板就**预填现有的那一份**
 * （来源会话 / 材料形式 / 勾选的轮次）—— 打开就是「改这份材料」，而不是一份空白表单
 * 让你以为在新建、结果把旧的盖掉。
 *
 * 没有材料时：默认引「最近用过的另一个会话」（没有别的会话时引自己，列表里总得有一个）。
 */
function openReferencePanel({ sourceId = '', kind = '', numbers = null } = {}) {
  const seed = existingReference();
  const others = store.sessions.filter((s) => s.id !== store.sessionId);
  runtime.referenceDraft = {
    sourceId: sourceId || seed?.sessionId || others[0]?.id || store.sessionId,
    kind: (kind || seed?.kind) === 'turns' ? 'turns' : 'summary',
    // numbers 显式传了就用传的（包括空数组）；没传才接上现有材料记着的那几轮
    numbers: Array.isArray(numbers) ? [...numbers] : (Array.isArray(seed?.turns) ? [...seed.turns] : []),
  };
  els.referencePanel.hidden = false;
  paintReferencePanel();
  // 面板挨着输入区（见 index.html 里那段注释），但存量会话的正文可能很长：
  // 用户在底部打字、往上翻着看旧消息时点开面板，它照样可能在屏幕外 ——
  // 那样看起来就是「点了没反应」。所以打开时把它滚进可视区（`block: 'nearest'`：
  // 已经在视野里就什么都不做，只有看不见时才最小的滚动过去）。
  els.referencePanel.scrollIntoView?.({ block: 'nearest' });
}

function closeReferencePanel() {
  runtime.referenceDraft = null;
  els.referencePanel.hidden = true;
}

/**
 * 把材料挂上去。两种用法，判据是同一条：**材料是「这个会话」的背景**。
 *
 *   · **就地生效**（默认）：挂在当前会话上，从**下一轮**开始带上。正在聊的会话里
 *     突然需要另一个会话的内容时用这条 —— 前面对话照旧在上下文里，材料从这一轮起生效；
 *   · **带着它开一个新会话**（`newSession: true`）：复制一份材料到新会话，当前会话一个字不动。
 *     想开个新话题、只是手边要有那个会话的内容时用这条。
 */
function applyReference(reference, { newSession = false } = {}) {
  if (newSession) {
    store.createSession();
  } else if (store.session.messages.length === 0) {
    // 当前就是个空白会话：直接用掉它，别再堆一个「新对话」
    store.updateSessionSettings({ personaId: DEFAULT_PERSONA_ID, systemPrompt: '' });
  }
  // 有消息 + 就地生效：什么都不用做 —— 材料本来就属于这个会话
  store.setReference(reference);

  closeReferencePanel();
  runtime.referenceOpen = false;

  if (newSession) {
    runtime.pinned = true;
    runtime.liveTurn = null;
    runtime.renderNode = null;
    railRevealPending = true;
    renderAfterSessionSwitch();
    scrollToBottom();
    els.input.focus();
    flashHint(`已带着《${reference.title}》的材料开了一个新会话`, 3600);
    return;
  }

  // ---- 就地生效：**不切会话**，所以这条路不能走 renderAfterSessionSwitch ——
  // 它会顺手丢掉输入区挂着的那段「引用回答」（那句注释写的是「换会话后它已经没有出处了」，
  // 可这里根本没换会话），也会把用户正在打的需求冲掉。只重画材料条就够了。
  const first = store.session.messages.length === 0;
  paintReferenceNote();
  flashHint(
    first
      ? `已带上《${reference.title}》的材料，可以开始聊了`
      : `已带上《${reference.title}》的材料，从下一轮开始生效（随时能改选轮次或移除）`,
    3600,
  );
}

/** 确认：原文档本地就能拼；摘要档要问模型要一段摘要 */
async function submitReference({ newSession = false } = {}) {
  const draft = runtime.referenceDraft;
  if (!draft) return;
  const source = store.sessions.find((s) => s.id === draft.sourceId);
  const numbers = [...draft.numbers];

  if (draft.kind === 'turns') {
    const plan = referencePlan({ source, kind: 'turns', numbers });
    if (!plan.ok) {
      els.referenceStatus.textContent = referenceFailureText(plan.reason);
      flashHint(referenceFailureText(plan.reason), 4400);
      return;
    }
    applyReference(plan.reference, { newSession });
    return;
  }

  const slice = referenceSlice(source, numbers);
  if (!slice.length) {
    els.referenceStatus.textContent = referenceFailureText('empty');
    return;
  }

  els.referenceConfirm.disabled = true;
  els.referenceStatus.textContent = '正在让模型压摘要…';
  try {
    const response = await fetch('/api/summarize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: buildSummaryMessages({ messages: slice }),
        model: currentModelForRequest() || undefined,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.ok || !data.summary) {
      throw new Error(data?.message || '摘要没生成出来');
    }
    const plan = referencePlan({ source, kind: 'summary', numbers, summaryText: data.summary });
    if (!plan.ok) {
      els.referenceStatus.textContent = referenceFailureText(plan.reason);
      return;
    }
    applyReference(plan.reference, { newSession });
  } catch (err) {
    const text = `${err.message} —— 可以改成「原文」档（它不需要模型）`;
    els.referenceStatus.textContent = text;
    flashHint(text, 4800);
  } finally {
    els.referenceConfirm.disabled = false;
  }
}

/** 那条材料标注：写清从哪来、能展开看原文、能改选轮次、能移除 */
function paintReferenceNote() {
  const note = els.referenceNote;
  if (!note) return;
  const reference = store.session.reference;
  if (!isValidReference(reference)) {
    note.hidden = true;
    els.referenceNoteBody.hidden = true;
    els.referenceToggle.setAttribute('aria-expanded', 'false');
    runtime.referenceOpen = false;
    return;
  }

  const label = referenceLabel(reference);
  // 材料是快照：源会话被删掉照样能用，只是标注里说清出处已经不在
  const alive = store.sessions.some((s) => s.id === reference.sessionId);
  els.referenceNoteText.textContent = alive ? label : `${label}（原会话已删除）`;
  els.referenceNoteBody.textContent = reference.text;
  els.referenceNoteBody.hidden = !runtime.referenceOpen;
  els.referenceToggle.textContent = runtime.referenceOpen ? '收起材料' : '查看材料';
  els.referenceToggle.setAttribute('aria-expanded', String(runtime.referenceOpen));
  note.hidden = false;
}

els.referenceNewButton?.addEventListener('click', () => openReferencePanel());
// 列表收起时，报头上那个备用入口做的是同一件事
els.referenceCompact?.addEventListener('click', () => openReferencePanel());
els.referencePanelClose?.addEventListener('click', () => closeReferencePanel());
els.referenceCancel?.addEventListener('click', () => closeReferencePanel());
els.referenceConfirm?.addEventListener('click', () => void submitReference());
// 次要入口：同样一份材料，但**另开一个会话**带去（新会话引用那条老路）。
// 和主按钮共用一条确认流程，只有「挂到哪儿」不同。
els.referenceNewSessionLink?.addEventListener('click', () => void submitReference({ newSession: true }));
els.referenceSource?.addEventListener('change', (event) => {
  if (!runtime.referenceDraft) return;
  runtime.referenceDraft.sourceId = event.target.value;
  // 换了会话，之前勾的轮次号不再有意义
  runtime.referenceDraft.numbers = [];
  paintReferencePanel();
});
els.referenceKind?.addEventListener('change', (event) => {
  if (!runtime.referenceDraft) return;
  runtime.referenceDraft.kind = event.target.value === 'turns' ? 'turns' : 'summary';
  els.referenceStatus.textContent = referenceStatusText();
});
els.referenceTurns?.addEventListener('change', (event) => {
  const draft = runtime.referenceDraft;
  const box = event.target.closest?.('[data-action="reference-turn"]');
  if (!draft || !box) return;
  const number = Number(box.dataset.number);
  draft.numbers = box.checked
    ? [...new Set([...draft.numbers, number])].sort((a, b) => a - b)
    : draft.numbers.filter((n) => n !== number);
  els.referenceStatus.textContent = referenceStatusText();
});
els.referenceToggle?.addEventListener('click', () => {
  runtime.referenceOpen = !runtime.referenceOpen;
  paintReferenceNote();
});
els.referenceChange?.addEventListener('click', () => {
  const reference = store.session.reference;
  if (!reference) return;
  openReferencePanel({ sourceId: reference.sessionId, kind: reference.kind, numbers: reference.turns });
});
els.referenceDrop?.addEventListener('click', () => {
  if (!store.session.reference) return;
  store.clearReference();
  runtime.referenceOpen = false;
  render();
  flashHint('已移除背景材料 —— 之后不再带上它，已经答过的轮次一个字没变', 4200);
});

// ---------------------------------------------------------------- 正文的渲染窗口
//
// 一条会话可以聊到几百轮，而 render() 是**全量重画**：给每条回答建一个完整节点
// （评价、编辑、版本条、引用、页码都在里面），然后 replaceChildren() 一把换掉。
// 会话越长，问题不只是「打开慢一下」，而是**每一次交互都慢** ——
// 点个 👍、翻一页版本、切一次会话，那几百个节点都要重新建一遍。
//
// 所以正文只画最近 TRANSCRIPT_PAGE 轮，顶上留一个「更早的 N 轮」，
// 另外滚到最上面也会自动往前补一段。
//
// 三条纪律（第一条最要紧）：
//   · **只有 DOM 分层，数据一条都不许少**：请求历史、导出、压缩摘要、引用「原文」档、
//     分支复制全都读 store.messages 的**全部**内容，跟画出来多少轮无关。
//     分页只决定「画哪些」，绝不参与「有什么」。
//   · 轮次编号用**全局序号**：第 41 轮就是第 41 轮，不因为窗口从哪儿开始而改口 ——
//     引用面板里勾的、导出里写的都是这个号。
//   · 展开状态**不持久化**：刷新、切走再回来都是最近 20 轮。少一份要跟会话对齐的状态，
//     行为也可预期（换会话时窗口复位）。
const TRANSCRIPT_PAGE = 20;

/** 当前画最近多少轮（不持久化，见上） */
let transcriptWindow = TRANSCRIPT_PAGE;
/** 这个窗口是给哪个会话算的：会话一换就复位 */
let transcriptSessionId = null;
/** 离页面顶部多近就算「滚到顶了」，自动往前补一段 */
const EARLIER_AT_TOP = 80;

/** 上面还有多少轮没画出来 */
function hiddenTurnCount() {
  const turns = store.messages.reduce((n, m) => n + (m.role === 'assistant' ? 1 : 0), 0);
  return Math.max(0, turns - transcriptWindow);
}

/** 「更早的 N 轮」那一行；没有更早的返回 null */
function buildEarlierNode(hidden) {
  const step = Math.min(TRANSCRIPT_PAGE, hidden);
  const row = document.createElement('li');
  row.className = 'exchange-earlier';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost-button earlier-button';
  button.dataset.action = 'earlier';
  button.textContent = `更早的 ${step} 轮`;
  button.title = `上面还有 ${hidden} 轮没画出来，一次往前补 ${TRANSCRIPT_PAGE} 轮`;
  row.appendChild(button);
  return row;
}

/**
 * 往前补一段历史。
 *
 * **必须把视口锚住**：往上插内容会把正在看的那一行顶下去。补完按「文档变高了多少」
 * 把视口往下挪同样多 —— 屏幕上的东西一动不动，这才是「凭空多出一段历史」该有的样子。
 * （替身 DOM 没有 scrollBy，所以用可选调用；量不到高度就当没这回事。）
 */
function expandTranscript() {
  const before = document.documentElement?.scrollHeight ?? 0;
  transcriptWindow += TRANSCRIPT_PAGE;
  render();
  const delta = (document.documentElement?.scrollHeight ?? 0) - before;
  if (Number.isFinite(delta) && delta > 0) window.scrollBy?.(0, delta);
}

/** 滚到最上面就自动往前补一段（上面确实还有没画出来的轮次时） */
function maybeLoadEarlier() {
  if (hiddenTurnCount() <= 0) return;
  const y = Number(window.scrollY ?? 0);
  if (y > EARLIER_AT_TOP) return;
  expandTranscript();
}

window.addEventListener('scroll', maybeLoadEarlier, { passive: true });

// ---------------------------------------------------------------- 轮次导航（右侧那列短杠）
//
// 一轮一根短杠：hover 那根变长并浮出这轮的「问」和「答」的开头，点一下跳过去。
// 外形学豆包（细短杠，一百轮也只占一条细线），信息量学 ChatGPT（hover 出文字）。
// **放在右边**：左边已经排着页边序号「01/02」和会话栏，短杠挤在那儿会跟序号抢位置。
//
// 两条纪律：
//   · **它数的是全部轮次，不是画出来的那些**：正文只画最近 20 轮（见 TRANSCRIPT_PAGE），
//     而导航要能带你去第 3 轮 —— 所以数据来自 store.messages，点的时候先扩窗再滚。
//   · 「答」是**本地截断**（回答开头那一段，去掉 Markdown 标记），不是模型摘要：
//     一轮一次模型调用太贵，界面上也照实写「答：…」，不假装那是摘要。
// 出现条件：**至少 4 轮，而且正文比两屏还长**。
//
// 为什么不写死「超过 5 轮」：导航的价值是「省掉几屏滚动」，所以判据本该是**屏数**，不是轮数。
// 按真实尺寸算：可视区约 700px（1080p 减去吸顶报头 116px、贴底输入区 90px），一轮典型 300–400px
// （问 1–3 行 + 答常见 200–600px）⇒ 两屏 ≈ 1400px 正好落在**第 5 轮**上 —— 也就是说
// 「5 轮」这个数是对的，它只是「两屏」在典型轮高下的结果。写成屏数之后：
//   · 短回答的会话（每轮 150px）不会一上来就冒出一列短杠；
//   · 长回答的会话（每轮 600px）两三轮就冒出来 —— 那正是最需要它的时候；
//   · 窗口高度变了，判据跟着变。
// 4 轮是下限：再短就没有「跳」的意义了。
const TURN_NAV_MIN_TURNS = 4;
const TURN_NAV_MIN_SCREENS = 2;
const TURN_NAV_ACTIVE_AT = 0.35; // 节点顶端越过视口高度的这个比例，就算「正在看这一轮」
const TURN_NAV_LEAD = 4; // 跳到很早的一轮时，往前多留几轮做上下文
// 超过这么多轮就改出「列表」而不是单轮浮层：根距 27px（24px 热区 + 3px 缝）× 24 ≈ 650px，
// 正好填满那一列的高度 —— 再多就得压紧、再往后只能去滚那条 26px 宽的细条（不好滚 ✗）。
const TURN_NAV_LIST_AT = 24;
// 落地的那一轮闪多久（要和 styles.css 里 `landed-fade` 那条动画的时长看齐）
const TURN_NAV_LANDED_MS = 1400;

/** 每一轮的可导航信息（编号、问、答），按会话里的顺序 */
function turnNavItems() {
  const messages = store.messages;
  const items = [];
  messages.forEach((message, index) => {
    if (message.role !== 'assistant') return;
    const question = messages[index - 1];
    items.push({
      number: items.length + 1,
      question: String(question?.content ?? ''),
      answer: String(message.content ?? ''),
    });
  });
  return items;
}

/** 压成一行的短文字（浮层里用）：去掉 Markdown、空白折叠、超长截断 */
function oneLine(text, max) {
  const plain = markdownToPlain(String(text ?? '')).replace(/\s+/g, ' ').trim();
  return plain.length > max ? `${plain.slice(0, max)}…` : plain;
}

/** 视口里「正在看」的那一轮（判定线见 TURN_NAV_ACTIVE_AT） */
function currentTurnNumber() {
  const nodes = [...els.exchanges.children].filter((node) => node.dataset?.turn);
  if (!nodes.length) return 0;
  const line = (Number(window.innerHeight) || 800) * TURN_NAV_ACTIVE_AT;
  let current = Number(nodes[0].dataset.turn);
  for (const node of nodes) {
    if ((node.getBoundingClientRect?.().top ?? 0) <= line) current = Number(node.dataset.turn);
  }
  return current;
}

/** 把「当前轮」标到对应那根短杠上（滚动时跟着变） */
function paintActiveTurn() {
  const nav = els.turnNav;
  if (!nav || nav.hidden) return;
  const current = currentTurnNumber();
  for (const tick of nav.children) {
    if (Number(tick.dataset.turn) === current) tick.dataset.current = 'true';
    else delete tick.dataset.current;
  }
  if (!els.turnList?.hidden) paintTurnList(current);
}

/** 重画那列短杠（轮数变了、换会话了都要重画） */
function paintTurnNav() {
  const nav = els.turnNav;
  if (!nav) return;
  const items = turnNavItems();
  nav.dataset.turns = String(items.length);
  // 「正文比两屏还长」是量出来的：这里读一次 scrollHeight（会让浏览器先排版一次，
  // 但每次 render 只读一次，换来的是「短会话不出现、长回答的会话早点出现」）。
  const viewport = Number(window.innerHeight) || 800;
  const tall = (Number(els.exchanges?.scrollHeight) || 0) > viewport * TURN_NAV_MIN_SCREENS;
  // 轮次太少、或者一屏就看得完：那它只是杂物，纯粹多一列东西要瞄
  if (items.length < TURN_NAV_MIN_TURNS || !tall) {
    nav.hidden = true;
    nav.replaceChildren();
    hideTurnHelp();
    return;
  }
  /*
   * 密到什么程度，决定 hover 出什么：
   *   · 稀疏（≤24 轮）：一根短杠一根短杠地 hover，出**单轮浮层**（问 + 答）；
   *   · 密集（>24 轮）：短杠已经压紧、再往后只能滚那条 26px 宽的细条（不好滚 ✗），
   *     所以 hover 改成出**列表**（ChatGPT 那个形态）：每条一轮、能正常滚、点一下就过去。
   * 24 这个数来自几何：根距 27px（24px 热区 + 3px 缝）× 24 ≈ 650px，正好填满那一列的高度。
   */
  const dense = items.length > TURN_NAV_LIST_AT;
  nav.dataset.dense = dense ? 'true' : 'false';
  if (!dense) hideTurnList(); // 从密变疏（换会话了）时，别留着一个开着的列表
  nav.hidden = false;
  nav.replaceChildren(
    ...items.map((item) => {
      const tick = document.createElement('button');
      tick.type = 'button';
      tick.className = 'turn-tick';
      tick.dataset.turn = String(item.number);
      tick.title = `第 ${item.number} 轮`;
      // 无障碍：屏幕阅读器念的是「跳到第 7 轮：<那句话>」
      tick.setAttribute(
        'aria-label',
        `跳到第 ${item.number} 轮：${oneLine(item.question, 30) || '（这一轮没有提问）'}`,
      );
      return tick;
    }),
  );
  turnListBuilt = 0; // 轮次变了，列表要重建
  paintActiveTurn();
}

let turnTipTimer = null;
/** 列表是给多少轮建的（轮数变了才重建；200 轮时不该每次 hover 都重建一遍） */
let turnListBuilt = 0;

function hideTurnTip() {
  if (els.turnTip) els.turnTip.hidden = true;
}

function hideTurnList() {
  if (els.turnList) els.turnList.hidden = true;
}

/** 两种形态一起收（浮层和列表） */
function hideTurnHelp() {
  if (turnTipTimer) {
    clearTimeout(turnTipTimer);
    turnTipTimer = null;
  }
  hideTurnTip();
  hideTurnList();
}

/**
 * 延迟收起。
 * 和会话标题那个浮层同一个理由：鼠标从短杠挪到内容上的路上会短暂离开短杠，
 * 立刻收起的话根本读不完。浮层本身是 `pointer-events: none`（鼠标会穿过去），
 * 列表则**吃鼠标**（要点行），所以这里给的宽限对两者都够用。
 */
function scheduleHideTurnHelp() {
  if (turnTipTimer) clearTimeout(turnTipTimer);
  turnTipTimer = setTimeout(() => {
    turnTipTimer = null;
    // 两种形态都要收：只收浮层的话，列表会一直挂在那儿（这条是新断言抓出来的）
    hideTurnTip();
    hideTurnList();
  }, 160);
}

/** 浮出某一轮的「问 + 答开头」 */
function showTurnTip(tick, number) {
  const tip = els.turnTip;
  const item = turnNavItems()[number - 1];
  if (!tip || !item) return;
  if (turnTipTimer) {
    clearTimeout(turnTipTimer);
    turnTipTimer = null;
  }

  const head = document.createElement('p');
  head.className = 'turn-tip-head';
  head.textContent = `第 ${item.number} 轮`;
  const question = document.createElement('p');
  question.className = 'turn-tip-q';
  question.textContent = `问：${oneLine(item.question, 60) || '（没有提问）'}`;
  const answer = document.createElement('p');
  answer.className = 'turn-tip-a';
  answer.textContent = `答：${oneLine(item.answer, 60) || '（这一轮还没有回答）'}`;
  tip.replaceChildren(head, question, answer);
  tip.hidden = false;

  // 摆在短杠左边、纵向跟着它；贴到视口上下边就夹回来（和「⋯」菜单同一套纪律）
  const rect = tick.getBoundingClientRect?.();
  if (!rect) return;
  const height = Number(tip.offsetHeight) || 96;
  const viewport = Number(window.innerHeight) || 800;
  const top = Math.min(Math.max(8, rect.top - 8), Math.max(8, viewport - height - 8));
  tip.style.top = `${Math.round(top)}px`;
  tip.style.right = `${Math.round((Number(window.innerWidth) || 1200) - rect.left + 12)}px`;
}

/**
 * 密集模式用的那个列表：一条一轮（`第 N 轮 · 那句话`）。
 *
 * 只在轮数变了的时候重建（200 轮时不该每次 hover 都重建一遍）；
 * 每次打开只更新「当前轮」和「hover 的那一轮」两个标记。
 */
function paintTurnList(hoverNumber = 0) {
  const list = els.turnList;
  if (!list) return;
  const items = turnNavItems();
  if (turnListBuilt !== items.length) {
    list.replaceChildren(
      ...items.map((item) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'turn-list-row';
        row.dataset.turn = String(item.number);
        // 行上放不下完整内容，用原生 title 兜住（浮层那一版是 hover 看内容，这里一行只够一句话）
        row.title = `问：${oneLine(item.question, 100) || '（没有提问）'}\n答：${oneLine(item.answer, 100)}`;
        const head = document.createElement('span');
        head.className = 'turn-list-head';
        head.textContent = `第 ${item.number} 轮`;
        const text = document.createElement('span');
        text.className = 'turn-list-text';
        text.textContent = oneLine(item.question, 40) || '（没有提问）';
        row.replaceChildren(head, text);
        return row;
      }),
    );
    turnListBuilt = items.length;
  }

  const current = currentTurnNumber();
  for (const row of list.children) {
    const n = Number(row.dataset.turn);
    if (n === current) row.dataset.current = 'true';
    else delete row.dataset.current;
    if (hoverNumber && n === hoverNumber) row.dataset.hover = 'true';
    else delete row.dataset.hover;
  }
  return current;
}

/** 打开列表（鼠标/焦点落在某一根短杠上时） */
function showTurnList(number) {
  const list = els.turnList;
  if (!list) return;
  hideTurnTip();
  paintTurnList(number);
  list.hidden = false;
  // 把 hover 的那一行滚到列表中间：200 轮时列表是长条，不滚过去就等于没标
  const row = [...list.children].find((child) => Number(child.dataset.turn) === number);
  const offset = Number(row?.offsetTop);
  if (row && Number.isFinite(offset)) {
    list.scrollTop = Math.max(0, offset - (Number(list.clientHeight) || 0) / 2);
  }
}

/**
 * 跳到第 n 轮。
 *
 * 落点：**这一轮的开头**（不是中间）—— 跳过去就该从这一轮的提问读起。
 * 用 `block: 'start'`，但真正的"开头"由 styles.css 里的 `scroll-margin-top` 定：
 * 报头是吸顶且**不透明**的，直接把节点顶到视口最上沿，前一两行会被压在报头底下看不见。
 * 那个属性就是为这种情况准备的（留出报头高度 + 一点呼吸缝）。
 *
 * 另外要紧的是**跨分页**：正文只画最近 20 轮，而导航数的是全部轮次 —— 目标在窗口之上时
 * 得先把窗口扩到包含它（再往前多留几轮做上下文），否则 scrollIntoView 找不到那个节点，
 * 用户看到的就是「点了没反应」。
 */
/**
 * 取第 n 轮的节点。
 * 直接翻 `children` 找，而不是拼 `querySelector('[data-turn="n"]')` ——
 * 节点的身份就写在它自己的 dataset 上，少一层选择器解析（也少一处转义坑）。
 */
function turnNode(number) {
  return [...els.exchanges.children].find((node) => node.dataset?.turn === String(number)) ?? null;
}

function revealTurn(number) {
  const total = turnNavItems().length;
  if (!Number.isFinite(number) || number < 1 || number > total) return;
  const hidden = Math.max(0, total - transcriptWindow);
  if (number <= hidden) transcriptWindow = total - number + 1 + TURN_NAV_LEAD;
  render();
  const node = turnNode(number);
  if (node) markLandedTurn(node);
  node?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  hideTurnHelp();
}

/** 落地闪光的定时器（下一次跳转时先把它撤掉，免得旧的到时把新标记也删了） */
let landedTimer = null;

/**
 * 落地的那一轮闪一下再淡出（跳很远时，正文里得有个「我到了」的反馈）。
 *
 * 这里**不手动去清旧的标记**：`revealTurn` 每次都先 `render()`，节点是整批重画的 ——
 * 上一轮那个节点连同它的标记一起没了。
 * （原先写过一段"遍历 children 删旧标记"的代码，变异测试证明它是**死代码**：
 * 删掉它一条断言都不会失败。死代码比没有代码更糟，所以删了。
 * 而断言「只有新的那一轮亮着」留着 —— 它守的是**将来**有人给跳转加
 *「目标已经在视口里就不重画」那种优化：那时候旧标记会留下来，这条会立刻变红。）
 */
function markLandedTurn(node) {
  if (landedTimer) {
    clearTimeout(landedTimer);
    landedTimer = null;
  }
  node.dataset.landed = 'true';
  landedTimer = setTimeout(() => {
    landedTimer = null;
    delete node.dataset.landed;
  }, TURN_NAV_LANDED_MS);
}

els.turnNav?.addEventListener('click', (event) => {
  const tick = event.target.closest?.('[data-turn]');
  if (!tick) return;
  revealTurn(Number(tick.dataset.turn));
});
// hover 和键盘聚焦都要给内容：只做 hover 的话，键盘用户什么都看不到。
// 出浮层还是出列表，看这一列现在密不密（见 paintTurnNav 里 dense 的说明）。
for (const type of ['mouseover', 'focusin']) {
  els.turnNav?.addEventListener(type, (event) => {
    const tick = event.target.closest?.('[data-turn]');
    if (!tick) return;
    const number = Number(tick.dataset.turn);
    if (els.turnNav.dataset.dense === 'true') showTurnList(number);
    else showTurnTip(tick, number);
  });
}
for (const type of ['mouseout', 'focusout']) {
  els.turnNav?.addEventListener(type, scheduleHideTurnHelp);
}
// 列表自己会吃鼠标（要点行），所以鼠标进列表 = 取消收起，离开列表 = 延迟收起
els.turnList?.addEventListener('mouseenter', () => {
  if (turnTipTimer) {
    clearTimeout(turnTipTimer);
    turnTipTimer = null;
  }
});
els.turnList?.addEventListener('mouseleave', scheduleHideTurnHelp);
els.turnList?.addEventListener('click', (event) => {
  const row = event.target.closest?.('[data-turn]');
  if (!row) return;
  revealTurn(Number(row.dataset.turn));
});

function render({ keepLive = false } = {}) {
  const assistants = store.messages.filter((m) => m.role === 'assistant');
  const isBlank = store.messages.length === 0;

  // 换会话就把窗口复位（展开状态不持久化，见上面第三条纪律）
  if (transcriptSessionId !== store.sessionId) {
    transcriptSessionId = store.sessionId;
    transcriptWindow = TRANSCRIPT_PAGE;
  }

  els.blank.hidden = !isBlank;
  els.clear.disabled = isBlank;
  paintBranchNote();
  paintReferenceNote();

  if (keepLive && runtime.liveTurn && runtime.renderNode) {
    // 流式写入中：只增量重画这一条，其余不动（否则光标位置、滚动锚点都会跳）
    paintTurn(runtime.renderNode);
    return;
  }

  els.exchanges.replaceChildren();
  const summary = store.session.summary;
  const covered = summary ? Math.min(summary.covers, store.messages.length) : 0;

  // 只画最近这些轮；hidden 是窗口之上还有多少轮没画（编号仍按全局序号算）
  const hidden = Math.max(0, assistants.length - transcriptWindow);
  const visible = hidden > 0 ? assistants.slice(hidden) : assistants;
  const boundary = covered > 0 ? store.messages[covered - 1] : null;

  // 1) 窗口顶上那条「更早的 N 轮」
  if (hidden > 0) {
    const earlier = buildEarlierNode(hidden);
    if (earlier) els.exchanges.appendChild(earlier);
  }

  // 2) 压缩界线落在窗口**之上**时，标记挂在窗口顶部：
  //    上面确实都只有摘要了，这个位置说的还是实话。
  //    （界线那一轮画得出来时，标记照旧插在它后面，见下面。）
  if (boundary && hidden > 0 && !visible.includes(boundary)) {
    const note = buildContextNote(summary);
    if (note) els.exchanges.appendChild(note);
  }

  visible.forEach((message, index) => {
    // 编号 = 全局第几轮（不是「窗口里第几条」）
    const { node } = buildTurnNode(message, hidden + index + 1);
    els.exchanges.appendChild(node);
    paintTurn(node);

    // 压缩标记插在「最后一个被摘要覆盖的那一轮」后面 ——
    // 它标的是那条界线：以上的部分模型只看到了摘要，以下的是原文。
    // 放在列表最上面会骗人（看起来像整段都被压了）。
    if (covered > 0 && store.messages.indexOf(message) === covered - 1) {
      const note = buildContextNote(summary);
      if (note) els.exchanges.appendChild(note);
    }
  });

  paintCompressButton();

  // 轮次导航跟着会话走：轮数变了（新答完一轮、清空、换会话）就重画那列短杠
  paintTurnNav();

  if (runtime.liveTurn) {
    const live = els.exchanges.querySelector(`[data-id="${runtime.liveTurn.id}"]`);
    if (live) runtime.renderNode = live;
  }
}

/** 那道压缩标记：说明 + 展开摘要 + 取消压缩 */
function buildContextNote(summary) {
  const template = els.contextTemplate;
  if (!template?.content) return null;
  const frag = template.content.cloneNode(true);
  const node = frag.querySelector('[data-field="context-note"]');
  if (!node) return null;

  node.querySelector('[data-field="context-note-label"]').textContent = summaryLabel(summary);
  const text = node.querySelector('[data-field="context-note-text"]');
  text.textContent = summary.text;
  text.hidden = !runtime.summaryOpen;
  const toggle = node.querySelector('[data-action="toggle-summary"]');
  toggle.textContent = runtime.summaryOpen ? '收起摘要' : '查看摘要';
  toggle.setAttribute('aria-expanded', String(runtime.summaryOpen));
  return node;
}

/**
 * 「压缩上文」按钮该不该出现、点了会发生什么。
 *
 * 关键：**按钮可用 ⇔ 点下去真的有东西可压**。早先这里判的是「可压切片非空」，
 * 而切片非空的下限（几十上百字）比真正值得压的下限（1200 字）低得多，
 * 于是会出现「按钮亮着、一点却提示没有足够内容」这种死点。
 * 现在两边用的是同一次 compressionPlan（force），亮着就一定压得动。
 */
function paintCompressButton() {
  if (!els.compressButton) return;
  const summary = store.session.summary;
  const plan = compressionPlan({ messages: store.messages, summary, force: true });
  const canCompress = plan.mode !== 'none';
  els.compressButton.hidden = !canCompress || runtime.busy;
  els.compressButton.textContent = summary ? '再压一次' : '压缩上文';
  if (!canCompress) return;

  const rounds = Math.max(1, Math.round((plan.to - plan.from) / 2));
  els.compressButton.title =
    `把前面约 ${plan.chars} 字（${rounds} 轮）压成一段摘要，保留最近 ${plan.keepRecent} 条原文；` +
    '原始消息不会删掉，只是之后不再逐条发给模型';
}

// ---------------------------------------------------------------- 上下文压缩
//
// 什么时候压（见 lib/compress.js 的阈值）：
//  · **答完之后**：体量过了软线，就后台压一次 —— 不挡用户，下一轮开始就用上摘要；
//  · **发之前**：体量过了硬线（说明后台那次没赶上或失败了），这一轮先压再发，
//    界面上会说明「正在压缩」，而不是让服务端把最老的几轮悄悄丢掉；
//  · **手动**：用户点「压缩上文」，随时可压，也可以「再压一次」把范围扩大。
//
// 压缩只改「发给模型的那一份」：消息一条不删，界面和导出始终是完整的。

/**
 * 压一次。
 * @returns {Promise<boolean>} 是否真的换上了新摘要
 */
async function compressContext({ force = false, blocking = false } = {}) {
  const session = store.session;
  const plan = compressionPlan({ messages: store.messages, summary: session.summary, force });
  if (plan.mode === 'none') return false;
  // 离线模式没有模型可用：压不了，就照旧发原文
  if (runtime.config.mode === 'mock') return false;
  if (runtime.compressing === session.id) return false;

  const slice = store.messages.slice(plan.from, plan.to);
  if (!slice.length) return false;

  runtime.compressing = session.id;
  if (blocking) flashHint('上下文较长，正在压缩前面的对话…', 3000);
  paintCompressButton();

  try {
    const response = await fetch('/api/summarize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: buildSummaryMessages({ messages: slice, previousSummary: session.summary }),
        model: session.model || runtime.chosenModel || runtime.serverDefaultModel || undefined,
      }),
    });
    const data = await response.json().catch(() => ({}));
    // 摘要要覆盖「旧的摘要 + 这一次压的这段」，所以 covers 是累加的
    const summary = normalizeSummary({
      text: data?.summary,
      covers: plan.to,
      model: data?.model ?? null,
      at: Date.now(),
    });
    if (!summary) return false;

    store.setSummary(summary);
    render();
    const plain = estimateChars(store.messages.slice(0, plan.to));
    flashHint(`已压缩上文：约 ${Math.round(plain / 1000)}k 字 → ${summary.text.length} 字摘要`, 3600);
    return true;
  } catch {
    // 压缩失败不是错误：继续用原文发（服务端还有一层兜底裁剪）
    return false;
  } finally {
    runtime.compressing = null;
    paintCompressButton();
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
  // 挂着的引用属于上一个会话里的一段回答，换会话后它已经没有出处了
  setPendingQuote(null);
  // 打开着的评价框同理：它指的是上一个会话里的某条回答
  closeFeedbackBox();
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
  onViewportChange();
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

// 手动压缩：用户说压就压，不看阈值（但仍然要求有东西可压）
els.compressButton.addEventListener('click', async () => {
  if (runtime.busy) {
    flashHint('正在生成，等这一轮结束再压缩', 2600);
    return;
  }
  const session = store.session;
  const plan = compressionPlan({ messages: store.messages, summary: session.summary, force: true });
  if (plan.mode === 'none') {
    flashHint('还没有足够的内容可以压缩', 2600);
    return;
  }
  if (runtime.config.mode === 'mock') {
    flashHint('离线模式压不了：压缩要模型来写摘要', 3600);
    return;
  }
  els.compressButton.disabled = true;
  const ok = await compressContext({ force: true, blocking: true });
  els.compressButton.disabled = false;
  if (!ok) flashHint('这次没压成，稍后再试（不影响继续对话）', 3000);
});

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

// ---------------------------------------------------------------- 引用回答
//
// 在回答里划中一段 → 选区旁边浮出「引用这段」→ 点它，那段话就挂到输入框上方，
// 你接着问的问题会带着它一起发给模型（见 lib/quote.js 与 lib/versions.js）。
//
// 三个刻意的取舍：
//  1. **只认回答那一侧**。提问也可以划，但「引用」的语义是「引用它说过的话」；
//     允许引用自己的提问没有意义，还会让「引的是谁」变得含糊。
//  2. **不动用户的选择**：浮标按钮出现在选区旁边，点之前不改变任何东西，
//     用户想用浏览器自带的复制也照常能用。
//  3. **引用挂在输入区，不直接发送**。它只是一段待发送的上下文，
//     用户还要说自己想问什么 —— 点一下就直接发出去会很意外。

/** 选中的文字落在哪条回答的正文里；不在回答里返回 null */
function answerBodyOf(node) {
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  const body = el?.closest?.('.turn-body') ?? null;
  if (!body) return null;
  return body.closest('.turn-assistant') ? body : null;
}

/** 这段引用来自哪条消息、第几页（用户可能正停在旧的一页上） */
function quoteSourceOf(body) {
  const node = body?.closest?.('.exchange') ?? null;
  const id = node?.dataset?.id ?? null;
  const message = id ? store.messages.find((m) => m.id === id) : null;
  if (!message) return { page: 1, messageId: id };

  const index = store.messages.indexOf(message);
  const question = store.messages[index - 1];
  const page = question ? resolveShownPage(question, store.viewVersion(question)) : 1;
  return { page, messageId: message.id };
}

function currentSelection() {
  return globalThis.getSelection?.() ?? document.getSelection?.() ?? null;
}

/** 当前选区够不够格当引用；够的话连它的位置一起返回 */
function readSelectionQuote() {
  const selection = currentSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;

  const range = selection.getRangeAt(0);
  const body = answerBodyOf(range.commonAncestorContainer ?? selection.anchorNode);
  const quote = quoteFromSelection({
    text: selection.toString(),
    inAnswer: Boolean(body),
    ...quoteSourceOf(body),
  });
  if (!quote) return null;

  return { quote, rect: range.getBoundingClientRect?.() ?? null };
}

function hideQuoteFloat() {
  if (els.quoteFloat) els.quoteFloat.hidden = true;
}

/**
 * 浮标出现时那一段引用。
 *
 * **点击时绝不能再读一次选区**：按下去这个动作本身就会把浏览器的选区清掉，
 * 那时再读只会拿到空字符串 —— 功能会直接失效，而且看起来像「点了没反应」。
 * 所以引用在「浮标出现」的那一刻就存下来，点击只是取用它。
 */
let floatQuote = null;

/**
 * 把浮标按钮放到选区旁边。
 * 先取消隐藏再量尺寸 —— 隐藏的元素量出来是 0，位置会算错。
 */
function placeQuoteFloat(rect) {
  const button = els.quoteFloat;
  if (!button || !rect) return;
  button.hidden = false;

  const size = button.getBoundingClientRect?.() ?? { width: 0, height: 0 };
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  const width = size.width || 0;
  const height = size.height || 0;
  const gap = 10;

  const anchor = rect.left + rect.width / 2 - width / 2;
  const left = Math.max(8, Math.min(anchor, vw - width - 8));
  // 优先浮在选区上方；上面放不下就落到下面
  const above = rect.top - height - gap;
  const top = above > 8 ? above : rect.bottom + gap;

  button.style.left = `${Math.round(left)}px`;
  button.style.top = `${Math.round(Math.max(8, Math.min(top, vh - height - 8)))}px`;
}

function refreshQuoteFloat() {
  const found = readSelectionQuote();
  // 选区分明在、只是在提问那一侧（或者已经空了）→ 一并把上一次的候选清掉，
  // 免得留下一个「已经不该引用」的旧值等着被点
  floatQuote = found ? found.quote : null;
  if (!found) {
    hideQuoteFloat();
    return;
  }
  placeQuoteFloat(found.rect);
}

/** 把一段引用挂到输入区（发送前一直留着） */
function setPendingQuote(quote) {
  runtime.pendingQuote = hasQuote(quote) ? quote : null;
  renderComposerQuote();
  updateSendState();
  els.hint.textContent = defaultHint();
}

function renderComposerQuote() {
  const quote = runtime.pendingQuote;
  const show = hasQuote(quote);
  els.composerQuote.hidden = !show;
  if (!show) {
    els.composerQuoteLabel.textContent = '';
    els.composerQuoteText.textContent = '';
    els.composerQuote.title = '';
    return;
  }
  // 截断了要说一声：不然用户会以为引用条显示的是全部
  els.composerQuoteLabel.textContent = quote.truncated
    ? `${quoteLabel(quote)} · 过长，只带上前面一段`
    : quoteLabel(quote);
  els.composerQuoteText.textContent = quote.text;
  els.composerQuote.title = quotePreview(quote, 80);
}

/**
 * 选区变化。
 *
 * 用 selectionchange + 防抖：拖动选择的过程中这个事件会连着来几十次，
 * 每次都去量位置会让拖动发涩。等手停下来再算一次就够。
 */
let quoteFloatTimer = null;
document.addEventListener('selectionchange', () => {
  clearTimeout(quoteFloatTimer);
  quoteFloatTimer = setTimeout(() => {
    quoteFloatTimer = null;
    refreshQuoteFloat();
  }, 120);
});

// 按下就先拦掉默认行为：不让这次点击把浏览器的选区清掉。
// 这样即使后面还有别的路径要读选区，也仍然读得到。
els.quoteFloat.addEventListener('pointerdown', (event) => event.preventDefault());

els.quoteFloat.addEventListener('click', () => {
  // 用浮标出现时存下的那段，**不**重读选区（点击已经把它清掉了）
  const quote = floatQuote;
  floatQuote = null;
  hideQuoteFloat();
  if (!hasQuote(quote)) return;

  setPendingQuote(quote);
  // 选中的高亮收掉：引用已经落到输入区，留在正文里会让人以为还能再点一次
  currentSelection()?.removeAllRanges?.();
  els.input.focus();
  flashHint('已引用这一段，接着说你的问题', 2600);
});

els.composerQuoteRemove.addEventListener('click', () => {
  setPendingQuote(null);
  els.input.focus();
  flashHint('已取消引用', 1800);
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

  // 引用只跟着**新提问**走。编辑和重新生成动的是「原来那一问」，
  // 那一问引用了什么早已存进它自己的版本里（见 store.pushUser），
  // 这时再套上输入区里挂着的引用就串了。
  const quote = edit ? null : runtime.pendingQuote;

  // 体量已经过了硬线（后台那次没赶上，或者刚失败）：先压再发。
  // 宁可这一轮多等几秒，也不要让服务端把最老的几轮悄悄丢掉 ——
  // 用户不知道「模型已经忘了开头」才是最难查的问题。
  if (compressionPlan({ messages: store.messages, summary: store.session.summary }).mode === 'blocking') {
    await compressContext({ blocking: true });
  }

  els.input.value = '';
  runtime.pendingImages = [];
  if (quote) setPendingQuote(null);
  renderAttachments();
  autoGrow();
  updateSendState();

  // 编辑重发时，被编辑的位置之后的所有轮次在新一页里不再适用（那一页只到这次问答为止）。
  // 但因为我们是「追加版本」而不是「替换」，旧页仍然完整保留，所以这里不需要删任何东西。

  const asked = store.pushUser(text, { attachments: images, edit, version, reuse, quote });
  const question = asked.message;
  const versionNumber = asked.version;
  store.renameFromFirstMessage();
  // 记下这一轮属于哪个会话：用户可能在中途切走，标题要按当时那个会话来起
  const sessionIdAtSend = store.sessionId;

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
  const history = buildRequestHistory(store.messages, question, placeholder, {
    summary: store.session.summary,
    // 挂着的背景材料（会话引用）：只进请求，不进本地消息 ——
    // 所以它不占压缩的下标、不进导出的正文，删掉也只是下一轮不再带
    reference: store.session.reference,
  });

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
      // 带上 httpStatus：下面的 catch 要靠它把「服务端拒绝了请求」和
      // 「连不上服务端」分开说。以前两种情况共用一句「确认 node server.mjs 还在运行」，
      // 结果服务端明明活着、只是拒了一个请求，用户却跑去查进程（真事：400 就是这么被误报的）。
      const rejected = new Error(detail || `请求失败（HTTP ${response.status}）`);
      rejected.httpStatus = response.status;
      throw rejected;
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
    } else if (err.httpStatus) {
      // 服务端活着，它只是拒了这一轮（400 之类）。别再说「确认 node server.mjs 还在运行」——
      // 那句话会把人带去查进程，而真正的原因在服务端给的原话里。
      store.finish(placeholder, 'error', `服务端拒绝了这次请求（HTTP ${err.httpStatus}）：${err.message}`);
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
    // 这一轮真的答完了，才值得拿它去起标题 —— 用半截回答或错误信息起出来的名字会更糟。
    // 不 await：起标题是后台的事，用户看到正文结束就该能继续操作。
    if (placeholder.status === 'done') void requestTitle(sessionIdAtSend);
    // 同理：这一轮结束后体量过了软线就后台压一次，下一轮开始就用上摘要
    if (placeholder.status === 'done' && store.sessionId === sessionIdAtSend) {
      const plan = compressionPlan({ messages: store.messages, summary: store.session.summary });
      if (plan.mode !== 'none') void compressContext();
    }
    paintCompressButton();
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
 * 改动落在「已经进了摘要的那一段」里 → 摘要作废。
 *
 * 为什么必须作废：摘要是对那几条消息**当时内容**的浓缩。用户回头改了其中一轮，
 * 摘要说的就成了已经不存在的版本 —— 而模型看到的是摘要，不是本文。
 * 这种「悄悄用了旧内容」正是最难查的一类问题，所以宁可丢掉摘要、重新发完整上文。
 *
 * 覆盖范围是按**消息下标**算的，而编辑是给同一条消息追加版本（下标不变），
 * 所以「改动落在旧版本上」的情况不需要处理 —— 摘要描述的是那一轮的主题，不是某一页的措辞。
 *
 * @returns {boolean} 是否真的作废了摘要（调用方负责告诉用户，见下面两处调用）
 */
function dropSummaryIfStale(message) {
  const summary = store.session.summary;
  if (!summary) return false;
  const index = store.messages.indexOf(message);
  if (index < 0 || index >= summary.covers) return false;

  store.clearSummary();
  render();
  return true;
}

const STALE_SUMMARY_HINT = '你改的这一轮在已压缩的部分里，摘要已作废 —— 之后会重新发完整上文';

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
  const stale = dropSummaryIfStale(question);
  await send(text, { edit: question, version });
  // 这句话要等 send 结束再说：send 收尾时会按状态重设提示条，早说的话会被当场冲掉
  if (stale) flashHint(STALE_SUMMARY_HINT, 4400);
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
  flashHint(dropSummaryIfStale(question) ? STALE_SUMMARY_HINT : '已保存改动（没有重新回答）', 4400);
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
  // 清空之后，挂着的引用已经没有出处了
  setPendingQuote(null);
  closeFeedbackBox();
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
  // 点菜单外面（也包括点另一个「⋯」）就收起会话菜单。
  // 注意要放过「⋯」本身：它下面的 click 处理器会开新菜单，
  // 这里先关掉再开，顺序上没问题（同一个事件里，关了之后那边又开）。
  if (!event.target.closest('.session-menu') && !event.target.closest('[data-action="more"]')) {
    closeSessionMenu();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!els.quoteFloat.hidden) hideQuoteFloat();
  closeSessionMenu();
  hideTitleFloat();
  if (!els.exportPopup.hidden) {
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
    // 导出菜单里选「复制全文」：菜单项就在手边，让它自己变成「已复制」
    copyWithFeedback(toPlainText(session), { button: els.exportPopup.querySelector('[data-export="copy"]'), label: '全文' });
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

/**
 * 收起 / 展开会话列表。
 *
 * 三件事一起做，少一件都会让人困惑：
 *  · 列表那一栏显不显示（`.board[data-rail]`）；
 *  · 图标开关自己长什么样（`data-state` 让图标镜像一下，指向列表在哪边）；
 *  · **备用入口露不露**：新建会话的主按钮在列表里，列表收起来了就得在报头上留一个，
 *    否则用户收起来之后就没地方开新对话了。
 */
function setRailVisible(visible) {
  els.board.dataset.rail = visible ? 'shown' : 'hidden';
  els.sidebarToggle.setAttribute('aria-expanded', String(visible));
  els.sidebarToggle.dataset.state = visible ? 'shown' : 'hidden';
  // 两个备用入口一起露/一起藏：列表收起来之后，新建和引用都得够得着
  //（它们的主入口都在列表顶上，见 index.html 的 .rail-actions）
  if (els.newSessionCompact) els.newSessionCompact.hidden = visible;
  if (els.referenceCompact) els.referenceCompact.hidden = visible;
  writeRailPreference(visible);
}

els.sidebarToggle.addEventListener('click', () => {
  setRailVisible(els.board.dataset.rail === 'hidden');
});

// ---------------------------------------------------------------- 会话栏宽度：拖 / 键盘 / 双击

if (els.railResizer) {
  /** 拖动时记住起点：按下那一刻的宽度和鼠标位置（用差值算，跟手） */
  let drag = null;

  els.railResizer.addEventListener('pointerdown', (event) => {
    // 窄屏（单列）没有那道缝可拖；CSS 已经把柄藏了，这里再挡一次
    if (Number(window.innerWidth) <= 1000) return;
    drag = { startX: event.clientX, startWidth: readRailWidth() };
    document.body.dataset.resizing = 'true';
    els.railResizer.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  els.railResizer.addEventListener('pointermove', (event) => {
    if (!drag) return;
    setRailWidth(drag.startWidth + (event.clientX - drag.startX));
  });

  const endDrag = () => {
    if (!drag) return;
    drag = null;
    delete document.body.dataset.resizing;
    // 落盘的时机放在拖动结束：拖的过程中每帧都写一次 localStorage 没必要
    writeRailWidth(clampRailWidth(readRailWidth()));
  };
  els.railResizer.addEventListener('pointerup', endDrag);
  els.railResizer.addEventListener('pointercancel', endDrag);

  // 双击回到默认宽度（拖窄了想一键恢复）
  els.railResizer.addEventListener('dblclick', () => {
    setRailWidth(RAIL_WIDTH_DEFAULT);
    flashHint(`会话栏宽度已回到默认（${RAIL_WIDTH_DEFAULT}px）`, 2200);
  });

  // 键盘也能调：← → 各 8px（Shift 加大到 24px），Home / End 到最小 / 最大
  els.railResizer.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 24 : 8;
    const current = readRailWidth();
    let next = null;
    if (event.key === 'ArrowLeft') next = current - step;
    else if (event.key === 'ArrowRight') next = current + step;
    else if (event.key === 'Home') next = RAIL_WIDTH_MIN;
    else if (event.key === 'End') next = railWidthMax();
    if (next === null) return;
    event.preventDefault();
    setRailWidth(next);
  });

  // 启动时套用记住的宽度（顺便把手柄上的 aria 数值写上）
  applyRailWidth(readRailWidth());
}

// 窗口变窄时重新夹一次：视口小了，之前拖的宽度可能已经把正文挤没了
window.addEventListener('resize', () => {
  if (!els.railResizer) return;
  applyRailWidth(readRailWidth());
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
  railRevealPending = true; // 新会话排在列表最后，滚一下才看得见
  renderAfterSessionSwitch();
  scrollToBottom();
  els.input.focus();

  if (announce && created) flashHint('已新建对话，角色为通用助手', 2400);
  return created;
}

els.newSession.addEventListener('click', () => startNewSession({ announce: true }));
// 列表收起时的备用入口，做的是同一件事
els.newSessionCompact?.addEventListener('click', () => startNewSession({ announce: true }));

// ---------------------------------------------------------------- 事件委托

els.exchanges.addEventListener('click', (event) => {
  const copyCode = event.target.closest('[data-copy-code]');
  if (copyCode) {
    const block = copyCode.closest('.code-block');
    const code = block?.querySelector('code')?.textContent ?? '';
    // 按钮本身要变（「已复制」+ 成功色）：代码块常在页面上方，底部那句提示看不到
    copyWithFeedback(code, { button: copyCode, label: '代码' });
    return;
  }

  const image = event.target.closest('.turn-images img');
  if (image) {
    window.open(image.src, '_blank', 'noopener');
    return;
  }

  const action = event.target.closest('[data-action]');
  if (!action) return;

  // 「更早的 N 轮」和压缩标记一样，不在任何一条 .exchange 里（它是窗口顶上独立一行），
  // 所以也要赶在下面那句「找不到对应消息就 return」之前处理
  if (action.dataset.action === 'earlier') {
    expandTranscript();
    return;
  }

  // 压缩标记上的动作先处理：它不在任何一条 .exchange 里（它是插在中间的独立一行），
  // 所以不能等到下面那句「找不到对应消息就 return」之后
  if (action.dataset.action === 'toggle-summary') {
    runtime.summaryOpen = !runtime.summaryOpen;
    render();
    return;
  }
  if (action.dataset.action === 'drop-summary') {
    // 丢掉摘要 = 之后重新发完整上文。本地消息本来就没动过，所以这一步是安全的
    store.clearSummary();
    runtime.summaryOpen = false;
    render();
    flashHint('已取消压缩，之后会把完整上文重新发给模型', 3200);
    return;
  }

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
    copyWithFeedback(markdownToPlain(av?.content ?? ''), { button: action, label: '回答' });
    return;
  }

  if (kind === 'retry') {
    retryLast(message);
    return;
  }

  // ---- 从这一轮分出一个新会话（见 lib/branch.js）
  //
  // 和上面提问的「编辑 → 重新回答」是两件事：那个是**在本会话里**给同一个问题
  // 多留一页（旧页不覆盖），这个是**从这里换条路走**：内容复制到一个新会话，
  // 原会话一个字节都不动，两边从此各聊各的。
  if (kind === 'branch') {
    // 正在生成时不分：那一轮还没定稿，复制过去的是半截
    if (runtime.busy) {
      flashHint('正在生成，等这一轮结束再分出新会话', 2600);
      return;
    }
    const created = store.branchFrom(store.sessionId, message.id);
    if (!created) {
      flashHint('这一轮还没落定，先别分支', 2600);
      return;
    }

    runtime.pinned = true;
    runtime.liveTurn = null;
    runtime.renderNode = null;
    railRevealPending = true; // 新会话排在列表最后，滚一下才看得见
    renderAfterSessionSwitch();
    scrollToBottom();
    els.input.focus();

    const images = created.branchOf?.images ?? 0;
    flashHint(
      images > 0
        ? `已分出新会话「${created.title}」—— 原会话的 ${images} 张图没有带过来`
        : `已分出新会话「${created.title}」，两边从此各聊各的`,
      3600,
    );
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
    return;
  }

  // ---- 评价：赞 / 踩
  //
  // 点下去就**立刻算数**（和 ChatGPT 一样，这一下本身就是信号），
  // 随后展开一个可选补充框。再点一次同一个按钮 = 取消，点另一边 = 改判。
  if (kind === 'rate-up' || kind === 'rate-down') {
    const clicked = kind === 'rate-up' ? 'up' : 'down';
    const av = message.versions[Math.min(shown, message.versions.length) - 1];
    const saved = av?.feedback ?? null;
    const next = toggleRating(saved?.rating ?? null, clicked);

    if (!next) {
      // 取消评价：连已经填过的原因和说明一起撤掉（留着会让人以为还生效着）
      closeFeedbackBox();
      store.setFeedback(message, shown, null);
      paintTurn(node);
      void postFeedback({ message, version: shown, feedback: null, action: 'clear' });
      flashHint('已取消评价', 1800);
      return;
    }

    const feedback = normalizeFeedback({ rating: next, reasons: [], note: '', at: Date.now() });
    store.setFeedback(message, shown, feedback);
    openFeedbackBox(message, shown, next, saved);
    paintTurn(node);
    void postFeedback({ message, version: shown, feedback });
    node.__feedbackNote?.focus?.();
    flashHint(next === 'down' ? '记下了。哪里不对？可选补充' : '记下了。谢了', 2200);
    return;
  }

  if (kind === 'feedback-reason') {
    if (!runtime.feedbackDraft) return;
    const id = action.dataset.reason;
    runtime.feedbackDraft.reasons = toggleReason(runtime.feedbackDraft.reasons, id);
    paintTurn(node);
    return;
  }

  if (kind === 'feedback-save') {
    const draft = runtime.feedbackDraft;
    if (!draft) return;
    const feedback = normalizeFeedback({
      rating: draft.rating,
      reasons: draft.reasons,
      note: node.__feedbackNote?.value ?? draft.note,
      at: Date.now(),
    });
    closeFeedbackBox();
    store.setFeedback(message, shown, feedback);
    paintTurn(node);
    void postFeedback({ message, version: shown, feedback });
    flashHint('评价已记下', 2000);
    return;
  }

  if (kind === 'feedback-close') {
    // 收起只是不看了：已经点过的赞/踩照旧生效，填到一半的原因和说明不保存
    closeFeedbackBox();
    paintTurn(node);
    els.input.focus();
  }
});

// 补充说明：边打边存进草稿，这样别处的重绘（换会话、模型回话等）不会把草稿冲掉
els.exchanges.addEventListener('input', (event) => {
  const note = event.target.closest('[data-field="feedback-note"]');
  if (!note || !runtime.feedbackDraft) return;
  runtime.feedbackDraft.note = note.value;
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
  renderComposerQuote();
  setupSpeech();

  // 会话列表一开始收不收：用户选过就听他的，没选过才按屏幕宽度决定（见 startup.js）
  setRailVisible(
    resolveRailVisibleDecide({
      stored: readRailPreference(),
      narrow: window.matchMedia('(max-width: 1000px)').matches,
    }),
  );

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
  onViewportChange();
  els.input.focus();
}

boot();
