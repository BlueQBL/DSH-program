// 对话状态 + 本地持久化（支持多会话）
//
// 唯一的真相来源是浏览器：所有会话都写进 localStorage，刷新、关闭再打开都还在。
// 服务端 history 只作为「换个入口也能找回来」的兜底，不参与合并。
//
// 数据结构：
//   { version, activeId, sessions: [ { id, title, createdAt, updatedAt,
//                                     personaId, systemPrompt, model, messages } ] }
// 每个会话各自持有角色、提示词和模型 —— 一边用编程助手问代码、一边用写作助手改稿，
// 互不影响。
//
// 每条消息的状态：
//   done        正常结束
//   streaming   正在逐字写入（此时若刷新页面，下次启动会被判定为 interrupted）
//   interrupted 中途断开（网络、手动停止、刷新）
//   error       出错结束
//
// 流式中的半截文本也照样落盘，所以刷新后能看到「写到哪里断的」，而不是整条消息消失。

import { DEFAULT_PERSONA_ID, resolveSystemPrompt } from './personas.js';
import { normalizeQuote } from './quote.js';
import { fallbackTitle, inferTitleSource, needsAutoTitle, titleFromModel } from './title.js';
import { normalizeFeedback } from './feedback.js';
import { normalizeSummary } from './compress.js';
import { branchPlan } from './branch.js';
import { MAX_REFERENCE_CHARS, MAX_REFERENCE_TURNS, MAX_RECORDED_TURNS } from './reference.js';

const STORAGE_KEY = 'duitanlu.sessions.v2';
const LEGACY_KEY = 'duitanlu.conversation.v1';
const LEGACY_SESSION_KEY = 'duitanlu.session.v1';
const SCHEMA_VERSION = 2;

/** 会话数量上限：localStorage 只有 5MB 左右，不设上限迟早写爆 */
export const MAX_SESSIONS = 50;

function uid(prefix = 'm') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function safeParse(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    // 数据被手改过或来自旧版本 —— 宁可当作空，也不能让整个界面白屏
    return null;
  }
}

const isSessionId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(value);

function newSessionId() {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 图片附件。
 *
 * 只留 dataURL 给重发用，并限制单张大小 —— 图片是 base64 塞进请求体的，
 * 不设限的话几张手机照片就能把上下文撑到几十 MB。
 */
export const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 4;

function normalizeAttachment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const dataUrl = typeof raw.dataUrl === 'string' ? raw.dataUrl : '';
  if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(dataUrl)) return null;
  if (dataUrl.length > MAX_IMAGE_BYTES * 1.4) return null; // base64 比原字节大约 1/3
  return {
    id: typeof raw.id === 'string' ? raw.id : uid('img'),
    name: typeof raw.name === 'string' ? raw.name.slice(0, 120) : '图片',
    mime: typeof raw.mime === 'string' ? raw.mime : 'image/png',
    dataUrl,
    width: Number(raw.width) || null,
    height: Number(raw.height) || null,
  };
}

/**
 * 把消息内容规整成「版本」数组。
 *
 * 一条消息可以有多个版本，用于「编辑后重新回答」这个功能：
 *   · 用户消息 A1 发出后得到回答 B1；用户把提问改成 A2 再发 → A2 是同一个
 *     用户消息槽位的第 2 版，得到的 B2 是同一条助手回答的第 2 版。
 *   · 于是这一轮对话就有了「第 1 页 / 第 2 页」，切换查看，互不覆盖。
 *
 * 旧数据没有 versions 字段：把 content 当成唯一的第 1 版，
 * 这样历史数据不需要迁移就能直接工作。
 */
function normalizeVersion(raw, fallbackContent = '', fallbackAttachments = []) {
  if (!raw || typeof raw !== 'object') return null;
  const version = {
    content: typeof raw.content === 'string' ? raw.content : '',
    createdAt: Number(raw.createdAt) || Date.now(),
    attachments: (Array.isArray(raw.attachments) ? raw.attachments : [])
      .map(normalizeAttachment)
      .filter(Boolean)
      .slice(0, MAX_IMAGES_PER_MESSAGE),
    // 引用只在用户消息上：它属于「这一次提问」，所以跟着版本走 ——
    // 编辑重发时旧版本连它当时引用的那段一起留档，翻回第 1 页看到的还是原样
    quote: normalizeQuote(raw.quote),
    // 评价只在助手回答上，也**跟着版本走**：第 1 页的赞不该跟到第 2 页去
    feedback: normalizeFeedback(raw.feedback),
    // 助手回答才有
    finishedAt: Number(raw.finishedAt) || null,
    status: ['done', 'streaming', 'interrupted', 'error'].includes(raw.status) ? raw.status : 'done',
    error: typeof raw.error === 'string' ? raw.error : null,
    model: typeof raw.model === 'string' ? raw.model : null,
    mode: typeof raw.mode === 'string' ? raw.mode : null,
  };
  if (!version.content && !version.attachments.length && raw.status === undefined) {
    // 完全空的版本没有意义
    if (!fallbackContent && !fallbackAttachments.length) return null;
  }
  return version;
}

function normalizeMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const role = raw.role === 'assistant' ? 'assistant' : raw.role === 'user' ? 'user' : null;
  if (!role) return null;

  const attachments = (Array.isArray(raw.attachments) ? raw.attachments : [])
    .map(normalizeAttachment)
    .filter(Boolean)
    .slice(0, MAX_IMAGES_PER_MESSAGE);

  let versions = (Array.isArray(raw.versions) ? raw.versions : [])
    .map((v) => normalizeVersion(v))
    .filter(Boolean);

  const versionCount = Math.max(
    versions.length,
    Number.isInteger(raw.versionCount) && raw.versionCount > 0 ? raw.versionCount : 0,
    1,
  );

  if (!versions.length) {
    // 旧数据 / 手工构造：把平铺字段当成第 1 版
    versions = [
      {
        content: typeof raw.content === 'string' ? raw.content : '',
        createdAt: Number(raw.createdAt) || Date.now(),
        attachments,
        quote: normalizeQuote(raw.quote),
        feedback: normalizeFeedback(raw.feedback),
        finishedAt: Number(raw.finishedAt) || null,
        status: ['done', 'streaming', 'interrupted', 'error'].includes(raw.status) ? raw.status : 'done',
        error: typeof raw.error === 'string' ? raw.error : null,
        model: typeof raw.model === 'string' ? raw.model : null,
        mode: typeof raw.mode === 'string' ? raw.mode : null,
      },
    ];
  }

  const current = versions[versions.length - 1];

  return {
    id: typeof raw.id === 'string' ? raw.id : uid(),
    role,
    versions,
    versionCount,
    // 平铺字段始终镜像「最新一版」，旧代码（渲染、导出）不需要改动即可工作
    content: current.content,
    createdAt: current.createdAt,
    finishedAt: current.finishedAt,
    status: current.status,
    error: current.error,
    mode: current.mode,
    model: current.model,
    personaId: typeof raw.personaId === 'string' ? raw.personaId : null,
    attachments: current.attachments,
    quote: current.quote,
    feedback: current.feedback,
  };
}

/** 当前显示第几版（1 起） */
function currentVersionNumber(message) {
  return Math.max(1, Math.min(message.versionCount || 1, message.versions.length));
}

/** 取出某一版（1 起）；超出范围就回落到最新一版 */
function versionAt(message, n) {
  const index = Math.max(0, Math.min((Number(n) || 1) - 1, message.versions.length - 1));
  return message.versions[index];
}

/** 让平铺字段与「最新一版」保持一致 */
function syncFlatFields(message) {
  const current = message.versions[message.versions.length - 1];
  if (!current) return;
  message.content = current.content;
  message.createdAt = current.createdAt;
  message.finishedAt = current.finishedAt;
  message.status = current.status;
  message.error = current.error;
  message.mode = current.mode;
  message.model = current.model;
  message.attachments = current.attachments;
  message.quote = current.quote;
  message.feedback = current.feedback;
}

function normalizeBranchOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // 出处必须像一个会话 id。认不出来就当「这条会话不是分支」——
  // 宁可不显示来源，也不要指着一个不存在的东西。
  if (!isSessionId(raw.id)) return null;
  return {
    id: raw.id,
    /** 当时的标题快照：源会话被删掉之后，界面上还能说清它是从哪儿来的 */
    title: typeof raw.title === 'string' ? raw.title.slice(0, 60) : '',
    /** 从哪一条回答分的叉 */
    messageId: typeof raw.messageId === 'string' ? raw.messageId : '',
    at: Number(raw.at) || 0,
    /** 原会话里有多少张图**没有**带过来（如实告诉用户，界面要显示） */
    images: Math.max(0, Math.trunc(Number(raw.images)) || 0),
  };
}

/**
 * 「背景材料」（会话引用，见 lib/reference.js）。
 *
 * 只认有正文的材料 —— 空正文的材料等于没挂，留着只会让界面显示一条点不开的标注。
 * 正文里存的是**快照**，所以这里不需要（也不应该）去校验来源会话还在不在。
 */
function normalizeReference(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) return null;
  const kind = raw.kind === 'turns' ? 'turns' : 'summary';
  return {
    kind,
    sessionId: isSessionId(raw.sessionId) ? raw.sessionId : '',
    title: typeof raw.title === 'string' ? raw.title.slice(0, 60) : '',
    at: Number(raw.at) || 0,
    text: text.slice(0, MAX_REFERENCE_CHARS),
    // 轮次号的上限分两种：原文档档这里是**材料的轮数**，硬上限 3
    //（超了「引用」就悄悄变成隐形的分支）；摘要档那只是「压的是哪几轮」的记录，
    // 摘要本身不限轮数 —— 拿 3 去夹它会把用户勾的范围改小，界面就还原不回去了。
    turns: (Array.isArray(raw.turns) ? raw.turns : [])
      .map((n) => Math.trunc(Number(n)))
      .filter((n) => Number.isFinite(n) && n > 0)
      .slice(0, kind === 'turns' ? MAX_REFERENCE_TURNS : MAX_RECORDED_TURNS),
    covers: Math.max(0, Math.trunc(Number(raw.covers)) || 0),
  };
}

function normalizeSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // id 缺失或非法一律丢弃，而不是自动补一个新 id。
  // localStorage 是可以被手改、也可能被别处导入的：给一个来源不明的条目发新身份，
  // 等于把它洗成「合法会话」混进列表，用户会看到凭空多出来的对话。
  if (!isSessionId(raw.id)) return null;

  const createdAt = Number(raw.createdAt) || Date.now();
  const session = {
    id: raw.id,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 60) : '新对话',
    createdAt,
    updatedAt: Number(raw.updatedAt) || createdAt,
    personaId: typeof raw.personaId === 'string' ? raw.personaId : DEFAULT_PERSONA_ID,
    systemPrompt: typeof raw.systemPrompt === 'string' ? raw.systemPrompt.slice(0, 4000) : '',
    model: typeof raw.model === 'string' ? raw.model : '',
    // 置顶：只认显式的 true。别的地方（手改过的 localStorage、导入的数据）
    // 塞进来的 "true" / 1 / {} 一律当成「没置顶」。
    pinned: raw.pinned === true,
    // 归档：同一个纪律 —— 只认显式的 true。
    // 老数据（还没有这个字段的那些）里读到 undefined，就是「没归档」，会照常出现在列表里。
    archived: raw.archived === true,
    messages: (Array.isArray(raw.messages) ? raw.messages : []).map(normalizeMessage).filter(Boolean),
  };
  // 这个名字是谁起的。老数据没有这个字段，靠标题内容反推（见 lib/title.js）——
  // 反推错了会把用户自己起的名字当成机器起的，所以那一步是保守的：认不出来就当用户起的。
  session.titleSource = inferTitleSource({ ...session, titleSource: raw.titleSource });
  session.summary = normalizeSessionSummary(raw.summary, session.messages);
  // 从哪个会话分出来的（不是分支就是 null）。见 lib/branch.js
  session.branchOf = normalizeBranchOf(raw.branchOf);
  // 挂着的背景材料（会话引用）。见 lib/reference.js
  session.reference = normalizeReference(raw.reference);
  return session;
}

/**
 * 会话的上下文摘要（见 lib/compress.js）。
 *
 * 覆盖范围越界就丢掉：消息被清空、被别处改少之后，旧摘要说的「以上 N 条」
 * 已经对不上了。宁可从头再发一遍原文，也不能让模型看到一份对不上号的摘要 ——
 * 更糟的是，如果摘要把所有消息都覆盖掉，请求里就只剩摘要、没有用户提问了。
 */
function normalizeSessionSummary(raw, messages) {
  const summary = normalizeSummary(raw);
  if (!summary) return null;
  const total = (messages ?? []).length;
  if (!total || summary.covers >= total) return null;
  return summary;
}

/**
 * 从旧版单会话数据迁移。
 * 老用户第一次打开新版本时会走这里，对话不能丢。
 */
function migrateLegacy() {
  const legacy = safeParse(localStorage.getItem(LEGACY_KEY));
  const legacyId = localStorage.getItem(LEGACY_SESSION_KEY);
  if (!legacy || !Array.isArray(legacy.messages) || !legacy.messages.length) return null;

  const session = normalizeSession({
    id: isSessionId(legacyId) ? legacyId : newSessionId(),
    title: fallbackTitle(legacy.messages.find((m) => m.role === 'user')?.content) || '过去的对话',
    createdAt: legacy.messages[0]?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    messages: legacy.messages,
  });
  return session;
}

function makeSession(overrides = {}) {
  const now = Date.now();
  return {
    id: newSessionId(),
    title: '新对话',
    // none = 还没有名字（空会话）。第一次发消息时才会算一个兜底标题，
    // 随后可以被模型标题替换 —— 见 lib/title.js 的 titleSource 说明。
    titleSource: 'none',
    /** 上下文摘要：会话太长时把前面部分压成它（见 lib/compress.js） */
    summary: null,
    /**
     * 这条会话是从哪个会话分出来的：`{ id, title, messageId, at, images }`。
     * 不是分支就是 null。注意它只是**出处**（给界面看 + 能跳回去），
     * 不是引用 —— 内容早就复制成本会话自己的消息了，源会话删掉也不影响这里。
     */
    branchOf: null,
    /**
     * 挂着的「背景材料」（会话引用，见 lib/reference.js）：
     * 另一个会话的摘要或某几轮的原文，**快照**存进来，只在构造请求时拼到最前面。
     */
    reference: null,
    createdAt: now,
    updatedAt: now,
    personaId: DEFAULT_PERSONA_ID,
    systemPrompt: '',
    model: '',
    /** 置顶：钉在会话列表最上面那一组（见 groupSessions） */
    pinned: false,
    /**
     * 归档：从会话列表里收起来，但**一条数据都没删**（见 groupSessions）。
     * 它和置顶是同一条「优先级」轴上的两端 —— 置顶是「现在最重要」，
     * 归档是「收起来了，但别删」。所以两者不会同时为真：归档会顺手把置顶清掉。
     */
    archived: false,
    messages: [],
    ...overrides,
  };
}

/**
 * 把会话分成「置顶」「最近」「已归档」三组（会话列表就按这三组画，布局参考 ChatGPT）。
 *
 * 传进来的顺序就是组内顺序 —— `store.sessions` 已经按最近使用排好了，
 * 这里只负责分组，**不重排**：置顶的会话落在置顶组的哪个位置，仍然由「最近用过」决定，
 * 置顶这件事本身不会让它跳到组里的第一名。
 *
 * 归档的那一条**只**进「已归档」：即使它身上还留着 pinned（手改过的 localStorage、
 * 旧版本存下的数据），也不该同时出现在置顶组里 —— 一个会话只能在一个组里，
 * 否则同一个名字在一栏里出现两次，看起来像有两条。
 *
 * 没有置顶的会话时 pinned 是空数组，界面上那一组连标题都不显示。
 *
 * @param {Array<{pinned?: boolean, archived?: boolean}>} sessions
 * @returns {{pinned: Array<object>, recent: Array<object>, archived: Array<object>}}
 */
export function groupSessions(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  const live = list.filter((session) => session?.archived !== true);
  return {
    pinned: live.filter((session) => session?.pinned === true),
    recent: live.filter((session) => session?.pinned !== true),
    archived: list.filter((session) => session?.archived === true),
  };
}

export function createStore() {
  const restored = safeParse(localStorage.getItem(STORAGE_KEY));

  let sessions = Array.isArray(restored?.sessions)
    ? restored.sessions.map(normalizeSession).filter(Boolean)
    : [];

  let migrated = false;
  if (!sessions.length) {
    const legacy = migrateLegacy();
    if (legacy) {
      sessions = [legacy];
      migrated = true;
      // 迁移完成就清掉旧键，避免下次又搬一遍
      try {
        localStorage.removeItem(LEGACY_KEY);
        localStorage.removeItem(LEGACY_SESSION_KEY);
      } catch {
        /* 忽略 */
      }
    }
  }

  if (!sessions.length) sessions = [makeSession()];

  let activeId = isSessionId(restored?.activeId) && sessions.some((s) => s.id === restored.activeId)
    ? restored.activeId
    : sessions[0].id;

  /** 最近用过的模型：新会话沿用它（角色不沿用，见 createSession） */
  let lastUsedModel = sessions.find((s) => s.model)?.model ?? '';

  // 上次是流式中途离开的（刷新 / 关页 / 断网）：标记成中断，保留已写出的文字
  let recoveredInterrupted = 0;
  for (const session of sessions) {
    for (const msg of session.messages) {
      if (msg.status === 'streaming') {
        msg.status = 'interrupted';
        msg.finishedAt = msg.finishedAt || Date.now();
        recoveredInterrupted += 1;
      }
    }
  }

  const listeners = new Set();
  const active = () => sessions.find((s) => s.id === activeId) ?? sessions[0];

  function snapshot() {
    return {
      version: SCHEMA_VERSION,
      activeId,
      updatedAt: new Date().toISOString(),
      sessions,
    };
  }

  /**
   * 落盘节流。
   *
   * 流式输出时每来一个 token 都会 appendDelta，如果每次都 JSON.stringify 全部会话，
   * 一轮回答就是上百次全量序列化 —— 会话越多越卡主线程。
   *
   * 但也不能节流过头：曾经因为「谁最后写盘就重置计时」，导致 pushAssistant 之后
   * 整段回答在写完之前一个字节都没落盘，中途刷新只能看到提问和空回复。
   * 所以这里以「一个流式周期」为单位计时 —— 每条回答的第一个增量立即写盘，
   * 之后最多每 250ms 一次，finish / 页面隐藏时立刻补写。
   */
  const WRITE_INTERVAL_MS = 250;
  let writeTimer = null;
  let lastWrite = 0;

  function writeNow() {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    lastWrite = Date.now();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot()));
    } catch (err) {
      // 配额满或隐私模式：不影响当前会话，只是不再落盘
      console.warn('[对谈录] 本地保存失败：', err);
    }
  }

  /** 延迟落盘：同一流式周期内的高频调用会被合并成一次写入 */
  function schedulePersist() {
    const elapsed = Date.now() - lastWrite;
    if (elapsed >= WRITE_INTERVAL_MS) {
      writeNow();
      return;
    }
    if (writeTimer) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      writeNow();
    }, WRITE_INTERVAL_MS - elapsed);
  }

  function persist() {
    writeNow();
  }

  /** 开始一个新的流式周期：让紧接着的第一个增量必定立即落盘 */
  function beginStreamingCycle() {
    lastWrite = 0;
  }

  // 页面被隐藏或关闭时，把节流窗口里还没写的内容补上，避免丢掉最后几个字
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    const flush = () => writeNow();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('pagehide', flush);
  }

  function emit() {
    for (const fn of listeners) fn(snapshot());
  }

  function commit() {
    persist();
    emit();
  }

  /** 会话内容变了就更新排序时间，列表才能按最近使用排序 */
  function touch(session) {
    session.updatedAt = Date.now();
  }

  /**
   * 会话数到上限时腾一个位置。
   * 新建会话和分出新会话都要用，所以只留一份 —— 规则改一处就够。
   */
  function makeRoom() {
    if (sessions.length < MAX_SESSIONS) return;
    // 不静默失败：按最久未使用淘汰一个。
    // 但「谁先走」分三档，规则只有一条：**用户明确表过态的排在后面**。
    //   普通（没置顶也没归档）→ 归档 → 置顶
    // 置顶是「现在最重要」，归档是「收起来了，但别删」—— 两个都是用户说过的意思，
    // 所以都排在普通会话后面；实在全都表过态了，才退回「淘汰最旧的」。
    //
    // 归档这一档非有不可：归档的会话「最久没用」几乎永远成立（归档的语义就是不用了），
    // 落进旧规则里它会**第一个**被淘汰 —— 那就成了「我明明归档了，它却没了」，
    // 比删除还让人恼火（删除至少是自己按下去的）。
    const byOldest = [...sessions].sort((a, b) => a.updatedAt - b.updatedAt);
    const oldest = byOldest.find((s) => s.pinned !== true && s.archived !== true)
      ?? byOldest.find((s) => s.pinned !== true)
      ?? byOldest[0];
    sessions = sessions.filter((s) => s.id !== oldest.id);
  }

  if (recoveredInterrupted || migrated) commit();
  else persist();

  return {
    /** 当前会话 id（旧接口沿用，服务端兜底副本按它落盘） */
    get sessionId() {
      return activeId;
    },
    get messages() {
      return active().messages;
    },
    get session() {
      return active();
    },
    /** 会话列表按最近使用排序 */
    get sessions() {
      return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    },
    get recoveredInterrupted() {
      return recoveredInterrupted;
    },
    get migrated() {
      return migrated;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    snapshot,

    // ------------------------------------------------------------ 会话管理

    /**
     * 新建会话并切换过去。
     *
     * 新会话**一律从默认角色（通用助手）开始**，不继承上一个会话的角色 ——
     * 角色的语义是「这个会话让 AI 扮演谁」，换话题就该重新选。
     * 模型则相反：那是「用哪个引擎」，沿用上次选过的更省事。
     */
    createSession() {
      makeRoom();
      const session = makeSession({ model: lastUsedModel });
      sessions.push(session);
      activeId = session.id;
      commit();
      return session;
    },

    /**
     * 从某一轮分出一个新会话（见 lib/branch.js）。
     *
     * 复制的是「到 messageId 那一条回答为止（含）」的全部内容，
     * **原会话一个字节都不动**：它的版本页、引用、标题、摘要全都留在原地，
     * 新会话拿到的是自己的副本，从此两边各聊各的。
     *
     * 带过去：角色、系统提示词、模型、压缩摘要（覆盖范围越界就丢掉，见 branchPlan）。
     * 不带：图片（一律不带）、👍/👎 评价（那是对原会话那几页的评价）。
     * 标题 `原标题-分支N`，并标成 `manual` —— 用户明确要的分支名，
     * 不许被后台的自动命名覆盖（那是另一条规则，别串）。
     *
     * @param {string} id 源会话 id
     * @param {string} messageId 分叉点（那一条回答的 id）
     * @returns {object|null} 新会话；源会话或分叉点找不到就返回 null（什么都不做）
     */
    branchFrom(id, messageId) {
      const source = sessions.find((s) => s.id === id);
      if (!source) return null;

      const plan = branchPlan({
        source,
        messageId,
        // 同一个源会话下已有的分支 —— 新分支的编号要避开它们（删掉中间那条也不重名）
        siblingTitles: sessions.filter((s) => s.branchOf?.id === id).map((s) => s.title),
      });
      if (!plan) return null;

      makeRoom();
      const session = makeSession({
        title: plan.title,
        titleSource: 'manual',
        summary: plan.summary,
        personaId: source.personaId,
        systemPrompt: source.systemPrompt,
        model: source.model,
        messages: plan.messages,
        branchOf: {
          id: source.id,
          title: source.title,
          messageId,
          at: Date.now(),
          images: plan.images,
        },
      });
      sessions.push(session);
      activeId = session.id;
      commit();
      return session;
    },

    /**
     * 删掉所有空会话（一条消息都没有），但至少保留一个。
     *
     * 用途：进页面时开了一个新会话，用户直接点了左边某个已有对话 ——
     * 那个空白会话留着没有意义，只会让列表里堆一串「新对话」。
     * @returns {number} 删掉的条数
     */
    dropEmptySessions({ keepId = '' } = {}) {
      const empties = sessions.filter((s) => s.messages.length === 0 && s.id !== keepId);
      // 如果全是空的，就没有「已有对话」可回，一个都别删
      if (!empties.length || empties.length >= sessions.length) return 0;

      sessions = sessions.filter((s) => !(s.messages.length === 0 && s.id !== keepId));
      if (!sessions.some((s) => s.id === activeId)) activeId = sessions[0].id;
      for (const s of empties) {
        fetch(`/api/history/${s.id}`, { method: 'DELETE' }).catch(() => {});
      }
      commit();
      return empties.length;
    },

    switchSession(id) {
      if (!isSessionId(id) || !sessions.some((s) => s.id === id)) return false;
      // 记下当前的模型供下一个新会话沿用（角色不延续）
      const current = active();
      if (current.model) lastUsedModel = current.model;
      activeId = id;
      commit();
      return true;
    },

    /**
     * 用户重命名（菜单里的「重命名」）。
     *
     * 改完把 titleSource 标成 `manual` —— 从此**任何后台自动命名都不许再动它**。
     * 这是「模型起的标题」和「你自己起的名字」之间唯一的界线，别绕过去。
     */
    renameSession(id, title) {
      const session = sessions.find((s) => s.id === id);
      if (!session) return false;
      const clean = String(title ?? '').trim().slice(0, 60);
      session.title = clean || '新对话';
      session.titleSource = 'manual';
      touch(session);
      commit();
      return true;
    },

    /**
     * 模型起的标题。
     *
     * 规则：`fallback`（本地兜底）可以被替换；`auto` 不重复替换；
     * `manual`（用户改过）只有 `force: true` 才能动 —— 那对应界面上
     * 用户自己点了「自动命名」，是他明确要求才换的。
     */
    applyTitle(id, title, { force = false } = {}) {
      const session = sessions.find((s) => s.id === id);
      if (!session) return false;

      const clean = titleFromModel(title);
      if (!clean) return false;

      const source = inferTitleSource(session);
      if (!force && source !== 'fallback') return false;

      session.title = clean;
      session.titleSource = 'auto';
      // 刻意不 touch()：换个名字不算「用过这个会话」。
      // 会话行里显示的时钟时间跟着 updatedAt 走，改标题顺手把它推后几秒会显得莫名其妙。
      commit();
      return true;
    },

    /** 这个会话现在该不该去问模型要个标题（纯判断，见 lib/title.js） */
    needsAutoTitle(id) {
      const session = sessions.find((s) => s.id === id);
      return session ? needsAutoTitle(session) : false;
    },

    /**
     * 置顶 / 取消置顶。
     *
     * 刻意不 touch()：置顶不是「用过这个会话」，只是把它钉到列表最上面去。
     * 顺手把 updatedAt 推到此刻的话，会话行上那个时钟会莫名其妙跳一下，
     * 而且它会在「最近」那一组里冒到头上 —— 那是两件不相干的事。
     */
    setPinned(id, pinned) {
      const session = sessions.find((s) => s.id === id);
      if (!session) return false;
      session.pinned = pinned === true;
      commit();
      return true;
    },

    /**
     * 归档 / 取消归档。
     *
     * 归档**不删任何东西**：会话还在 sessions 里、消息一条不少、导出还带上它、
     * 搜索也还搜得到（见 app.js 的搜索）。它改的只是「列表里摆不摆」这一件事 ——
     * 这是它和 deleteSession 的全部区别。
     *
     * 三个刻意的决定：
     *   · 和置顶一样**不 touch()**：归档不是「又用了它一次」。顺带把时间推到现在的话，
     *     取消归档之后它会凭空冒到「最近」的第一名，而它其实只是个刚被翻出来的老会话。
     *   · 归档时顺手**清掉置顶**：置顶的意思是「钉在列表最上面」，而归档的这条不在列表里。
     *     两个状态同时为真，用户就答不上来「取消归档之后它该回哪儿」——
     *     现在的答案是「回『最近』」，简单、可解释，也不用记一个隐形的旧状态。
     *   · 只认布尔：别处（手改的 localStorage、导入的数据）塞进来的 "true" / 1 一律当没归档。
     */
    setArchived(id, archived) {
      const session = sessions.find((s) => s.id === id);
      if (!session) return false;
      session.archived = archived === true;
      if (session.archived) session.pinned = false;
      commit();
      return true;
    },

    /**
     * 记下（或替换）上下文摘要。
     *
     * 只动 session.summary 一个字段：**消息一条都不删**。
     * 压缩改变的是「发给模型的那一份」，本地记录、界面、导出始终是完整的。
     */
    setSummary(summary) {
      const session = active();
      const clean = normalizeSessionSummary(summary, session.messages);
      session.summary = clean;
      commit();
      return clean;
    },

    /** 丢掉摘要（下次会把全文重新发过去） */
    clearSummary() {
      const session = active();
      session.summary = null;
      commit();
    },

    /** 这个会话当前的摘要（没有就是 null） */
    summaryOf(id) {
      const session = sessions.find((s) => s.id === id) ?? active();
      return session?.summary ?? null;
    },

    /**
     * 挂上一份「背景材料」（见 lib/reference.js）。
     *
     * 材料是**快照**：正文存在这个会话自己身上，所以源会话之后怎么变都不影响它。
     * 它也**不进 messages** —— 只在构造请求时拼在最前面一条 system 里，
     * 所以导出、压缩下标、消息数都不受影响。
     */
    setReference(reference) {
      const session = active();
      const clean = normalizeReference(reference);
      session.reference = clean;
      commit();
      return clean;
    },

    /** 移除材料（之后不再带上；已经答过的轮次一个字不变） */
    clearReference() {
      const session = active();
      session.reference = null;
      commit();
    },

    /** 删除会话；最后一个不允许删（否则界面没有可显示的东西） */
    deleteSession(id) {
      if (sessions.length <= 1) return false;
      const index = sessions.findIndex((s) => s.id === id);
      if (index < 0) return false;
      const [removed] = sessions.splice(index, 1);
      if (activeId === id) activeId = sessions[Math.min(index, sessions.length - 1)].id;
      commit();
      fetch(`/api/history/${removed.id}`, { method: 'DELETE' }).catch(() => {});
      return true;
    },

    /**
     * 用首条提问给会话起个**兜底**名字（本地算，立刻就有）。
     *
     * 只在「这个名字还没起过」时生效：一旦有了名字（兜底或模型或用户），
     * 后面再发消息都不该把它改回首条提问的截断版本。
     */
    renameFromFirstMessage() {
      const session = active();
      if (inferTitleSource(session) !== 'none') return false;
      const firstUser = session.messages.find((m) => m.role === 'user');
      if (!firstUser) return false;
      session.title = fallbackTitle(firstUser.content || firstUser.attachments?.[0]?.name || '');
      session.titleSource = 'fallback';
      commit();
      return true;
    },

    updateSessionSettings({ personaId, systemPrompt, model } = {}) {
      const session = active();
      if (personaId !== undefined) session.personaId = personaId;
      if (systemPrompt !== undefined) session.systemPrompt = String(systemPrompt).slice(0, 4000);
      if (model !== undefined) {
        session.model = String(model).slice(0, 80);
        if (session.model) lastUsedModel = session.model;
      }
      touch(session);
      commit();
      return session;
    },

    /** 这个会话最终要发给模型的系统提示词 */
    effectiveSystemPrompt() {
      const session = active();
      return resolveSystemPrompt(session.personaId, session.systemPrompt);
    },

    // ------------------------------------------------------------ 消息

    /**
     * 用户提问。text 可以为空（纯图片消息）。
     *
     * @param {string} content
     * @param {{attachments?: object[], edit?: object, version?: number, reuse?: boolean, quote?: object|null}} options
     *   `edit` + `version`：编辑后重新回答。**一律追加新版本，绝不覆盖旧版** ——
     *   这是这个功能的全部意义：用户既要看到本次的内容，也要能看到上一次生成的内容。
     *   早先按「改最新一版就原地覆盖」实现，结果旧内容直接丢了，是错的。
     *
     *   `reuse: true`：只把那一版的内容换掉，不新增页。给「重新生成」用 ——
     *   它是「同样的问题再要一次答案」，不该凭空多出一页。
     *
     *   `quote`：这一轮引用了回答里的一段（见 lib/quote.js）。只在**新提问**上生效；
     *   编辑与重新生成都不接受它 —— 那两种动作改的是「问什么」，
     *   引用属于那一次提问本身，跟着旧版本原样留着。
     */
    pushUser(content, { attachments = [], edit = null, version = null, reuse = false, quote = null } = {}) {
      const session = active();
      const cleanAttachments = (attachments ?? [])
        .map(normalizeAttachment)
        .filter(Boolean)
        .slice(0, MAX_IMAGES_PER_MESSAGE);
      const cleanQuote = normalizeQuote(quote);
      const now = Date.now();

      if (edit && Array.isArray(edit.versions) && edit.versions.length) {
        const target = Math.max(1, Math.min(Number(version) || edit.versions.length, edit.versions.length));

        if (reuse) {
          const v = edit.versions[target - 1];
          v.content = content ?? '';
          v.attachments = cleanAttachments;
          v.createdAt = now;
          v.finishedAt = now;
          v.status = 'done';
          v.error = null;
          syncFlatFields(edit);
          touch(session);
          commit();
          return { message: edit, version: target, replaced: true };
        }

        // 追加新版本；被编辑的是哪一版只记录来源，不影响「旧页保留」这个约定。
        // 引用跟着被编辑的那一版走：用户改的是文字，不是「引用的是哪一段」。
        edit.versions.push({
          content: content ?? '',
          createdAt: now,
          attachments: cleanAttachments,
          quote: edit.versions[target - 1]?.quote ?? null,
          finishedAt: now,
          status: 'done',
          error: null,
          model: null,
          mode: null,
          editedFrom: target,
        });
        edit.versionCount = edit.versions.length;
        edit.viewVersion = edit.versions.length;
        syncFlatFields(edit);
        touch(session);
        commit();
        return { message: edit, version: edit.versions.length, replaced: false };
      }

      const msg = {
        id: uid('u'),
        role: 'user',
        versions: [
          {
            content: content ?? '',
            createdAt: now,
            attachments: cleanAttachments,
            quote: cleanQuote,
            finishedAt: now,
            status: 'done',
            error: null,
            model: null,
            mode: null,
          },
        ],
        versionCount: 1,
        personaId: session.personaId,
      };
      syncFlatFields(msg);
      session.messages.push(msg);
      // 第一次说话就顺手起个**兜底**标题（本地算，立刻就有），列表里才认得出这个会话。
      // 等这一轮回答写完，客户端会再去问模型要一个更像样的标题来替换它。
      if (inferTitleSource(session) === 'none') {
        session.title = fallbackTitle(content || cleanAttachments[0]?.name || '');
        session.titleSource = 'fallback';
      }
      touch(session);
      commit();
      return { message: msg, version: 1, replaced: false };
    },

    /**
     * 为某个提问准备一条助手消息。
     *
     * @param {{mode?: string, model?: string, question?: object, version?: number}} options
     *   question + version 指出「这一版回答属于提问的第几版」：
     *   · 那一版还没有助手消息 → 新建一条
     *   · 已有（中断 / 出错）→ 重置那一版重新写，不产生多余消息
     */
    pushAssistant({ mode = null, model = null, question = null, version = null } = {}) {
      const session = active();
      const now = Date.now();

      let answer = null;
      if (question) {
        const qIndex = session.messages.indexOf(question);
        const candidate = qIndex >= 0 ? session.messages[qIndex + 1] : null;
        if (candidate && candidate.role === 'assistant') answer = candidate;
      }

      if (!answer) {
        const msg = {
          id: uid('a'),
          role: 'assistant',
          versions: [
            {
              content: '',
              createdAt: now,
              attachments: [],
              feedback: null,
              finishedAt: null,
              status: 'streaming',
              error: null,
              model,
              mode,
            },
          ],
          versionCount: 1,
          personaId: session.personaId,
        };
        syncFlatFields(msg);
        session.messages.push(msg);
        persist();
        beginStreamingCycle();
        return { message: msg, version: 1, reused: false };
      }

      // 助手消息的页数要和提问对齐：不够就补空页，然后重置目标页
      const qCount = Math.max(1, question ? question.versions.length : 1);
      while (answer.versions.length < qCount) {
        answer.versions.push({
          content: '',
          createdAt: now,
          attachments: [],
          feedback: null,
          finishedAt: null,
          status: 'streaming',
          error: null,
          model,
          mode,
        });
      }
      const n = Math.max(1, Math.min(Number(version) || qCount, answer.versions.length));
      const target = answer.versions[n - 1];
      target.content = '';
      target.attachments = [];
      target.createdAt = now;
      target.finishedAt = null;
      target.status = 'streaming';
      target.error = null;
      target.model = model;
      target.mode = mode;
      // 重新生成等于把这一页的回答换掉：旧回答的评价不该留在新回答上
      //（它评的是刚才那一段文字，而那段文字已经不存在了）
      target.feedback = null;
      answer.versionCount = answer.versions.length;
      delete answer.viewVersion;
      syncFlatFields(answer);
      persist();
      beginStreamingCycle();
      return { message: answer, version: n, reused: true };
    },

    /** 这条消息当前应该渲染哪一版（默认最新一版） */
    viewVersion(message) {
      const total = message.versions?.length ?? 1;
      const want = Number(message.viewVersion) || total;
      return Math.max(1, Math.min(want, total));
    },

    /** 切换查看第几版。只影响渲染，不改数据 */
    setMessageVersion(message, n) {
      const total = message.versions?.length ?? 1;
      const target = Math.max(1, Math.min(Number(n) || 1, total));
      if (target === total) delete message.viewVersion;
      else message.viewVersion = target;
      commit();
      return target;
    },

    /** 增量追加。用节流落盘：正文实时上屏，但不为每个 token 全量序列化一遍 */
    appendDelta(message, text) {
      const v = message.versions[message.versions.length - 1];
      v.content += text;
      message.content = v.content;
      schedulePersist();
    },

    setMode(message, mode) {
      const v = message.versions[message.versions.length - 1];
      v.mode = mode;
      message.mode = mode;
      persist();
    },

    setMessageModel(message, model) {
      const v = message.versions[message.versions.length - 1];
      v.model = model;
      message.model = model;
      persist();
    },

    /**
     * 记录用户对某一条回答的评价。
     *
     * 写在**那一版**上（不是整条消息上）：一条回答可以有多页，
     * 第 1 页点赞不该让第 2 页也显示成点过赞。
     *
     * @param {object} message 助手消息
     * @param {number|null} version 第几页（1 起）；不传就是当前显示的那一页
     * @param {object|null} feedback 传 null 表示取消评价
     * @returns {{rating: string, reasons: string[], note: string, at: number}|null}
     */
    setFeedback(message, version, feedback) {
      if (!message || message.role !== 'assistant') return null;
      const index = Math.max(0, Math.min((Number(version) || message.versions.length) - 1, message.versions.length - 1));
      const v = message.versions[index];
      if (!v) return null;

      const clean = normalizeFeedback(feedback);
      v.feedback = clean;
      if (index === message.versions.length - 1) message.feedback = clean;
      commit();
      return clean;
    },

    finish(message, status = 'done', error = null) {
      const v = message.versions[message.versions.length - 1];
      v.status = status;
      v.error = error;
      v.finishedAt = Date.now();
      message.status = status;
      message.error = error;
      message.finishedAt = v.finishedAt;
      const session = sessions.find((s) => s.messages.includes(message));
      if (session) touch(session);
      commit();
    },

    /** 停止生成：把已写出的内容保留下来 */
    interrupt(message) {
      const v = message.versions[message.versions.length - 1];
      v.status = 'interrupted';
      v.finishedAt = Date.now();
      message.status = 'interrupted';
      message.finishedAt = v.finishedAt;
      commit();
    },

    /**
     * 清空当前会话的消息（保留会话本身与它的角色设定）。
     *
     * 注意这里故意「先删键、再写回一份空快照」，而不是彻底不留痕迹：
     * 跨标签页同步依赖 storage 事件，只有真正写入才会触发事件。
     */
    clear() {
      const session = active();
      session.messages = [];
      session.title = '新对话';
      // 名字也跟着作废：消息都清空了，旧标题（模型起的或用户起的）已经没有意义，
      // 下一轮提问应当重新起一个
      session.titleSource = 'none';
      // 摘要同理：它覆盖的那些消息已经不存在了
      session.summary = null;
      touch(session);
      commit();
      fetch(`/api/history/${session.id}`, { method: 'DELETE' }).catch(() => {});
    },

    /** 彻底删除所有本地数据（换机器前清干净） */
    wipe() {
      sessions = [makeSession()];
      activeId = sessions[0].id;
      commit();
    },

    /**
     * 把外部（服务端兜底副本 / 其它标签页）的消息接回当前会话。
     * persist:false 用于「跟随其它标签页」——写入方已经落盘，跟着再写一次只会自找循环。
     */
    adopt(messagesFromServer, { persist: shouldPersist = true } = {}) {
      const cleaned = (messagesFromServer ?? []).map(normalizeMessage).filter(Boolean);
      if (!cleaned.length) return false;
      const session = active();
      session.messages = cleaned.map((m) => (m.status === 'streaming' ? { ...m, status: 'interrupted' } : m));
      if (shouldPersist) commit();
      else emit();
      return true;
    },

    adoptSnapshot(snapshotFromStorage, { persist: shouldPersist = false } = {}) {
      if (!snapshotFromStorage || !Array.isArray(snapshotFromStorage.sessions)) return false;
      sessions = snapshotFromStorage.sessions.map(normalizeSession).filter(Boolean);
      if (!sessions.length) return false;
      activeId = sessions.some((s) => s.id === snapshotFromStorage.activeId)
        ? snapshotFromStorage.activeId
        : sessions[0].id;
      if (shouldPersist) commit();
      else emit();
      return true;
    },
  };
}

export { STORAGE_KEY, SCHEMA_VERSION };
