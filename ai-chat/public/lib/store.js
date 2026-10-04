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

import { DEFAULT_PERSONA_ID, deriveTitle, resolveSystemPrompt } from './personas.js';

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

function normalizeMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const role = raw.role === 'assistant' ? 'assistant' : raw.role === 'user' ? 'user' : null;
  if (!role) return null;
  return {
    id: typeof raw.id === 'string' ? raw.id : uid(),
    role,
    content: typeof raw.content === 'string' ? raw.content : '',
    createdAt: Number(raw.createdAt) || Date.now(),
    finishedAt: Number(raw.finishedAt) || null,
    status: ['done', 'streaming', 'interrupted', 'error'].includes(raw.status) ? raw.status : 'done',
    error: typeof raw.error === 'string' ? raw.error : null,
    mode: typeof raw.mode === 'string' ? raw.mode : null,
    model: typeof raw.model === 'string' ? raw.model : null,
    personaId: typeof raw.personaId === 'string' ? raw.personaId : null,
    attachments: (Array.isArray(raw.attachments) ? raw.attachments : [])
      .map(normalizeAttachment)
      .filter(Boolean)
      .slice(0, MAX_IMAGES_PER_MESSAGE),
  };
}

function normalizeSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // id 缺失或非法一律丢弃，而不是自动补一个新 id。
  // localStorage 是可以被手改、也可能被别处导入的：给一个来源不明的条目发新身份，
  // 等于把它洗成「合法会话」混进列表，用户会看到凭空多出来的对话。
  if (!isSessionId(raw.id)) return null;

  const createdAt = Number(raw.createdAt) || Date.now();
  return {
    id: raw.id,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 60) : '新对话',
    createdAt,
    updatedAt: Number(raw.updatedAt) || createdAt,
    personaId: typeof raw.personaId === 'string' ? raw.personaId : DEFAULT_PERSONA_ID,
    systemPrompt: typeof raw.systemPrompt === 'string' ? raw.systemPrompt.slice(0, 4000) : '',
    model: typeof raw.model === 'string' ? raw.model : '',
    messages: (Array.isArray(raw.messages) ? raw.messages : []).map(normalizeMessage).filter(Boolean),
  };
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
    title: deriveTitle(legacy.messages.find((m) => m.role === 'user')?.content) || '过去的对话',
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
    createdAt: now,
    updatedAt: now,
    personaId: DEFAULT_PERSONA_ID,
    systemPrompt: '',
    model: '',
    messages: [],
    ...overrides,
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
      if (sessions.length >= MAX_SESSIONS) {
        // 不静默失败：按最久未使用淘汰一个
        const oldest = [...sessions].sort((a, b) => a.updatedAt - b.updatedAt)[0];
        sessions = sessions.filter((s) => s.id !== oldest.id);
      }
      const session = makeSession({ model: lastUsedModel });
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

    renameSession(id, title) {
      const session = sessions.find((s) => s.id === id);
      if (!session) return false;
      const clean = String(title ?? '').trim().slice(0, 60);
      session.title = clean || '新对话';
      touch(session);
      commit();
      return true;
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

    renameFromFirstMessage() {
      const session = active();
      if (session.title !== '新对话') return false;
      const firstUser = session.messages.find((m) => m.role === 'user');
      if (!firstUser) return false;
      session.title = deriveTitle(firstUser.content || firstUser.attachments?.[0]?.name || '');
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
     * @param {string} content
     * @param {{attachments?: object[]}} options
     */
    pushUser(content, { attachments = [] } = {}) {
      const session = active();
      const msg = {
        id: uid('u'),
        role: 'user',
        content: content ?? '',
        createdAt: Date.now(),
        finishedAt: Date.now(),
        status: 'done',
        error: null,
        mode: null,
        model: null,
        personaId: session.personaId,
        attachments: (attachments ?? []).map(normalizeAttachment).filter(Boolean).slice(0, MAX_IMAGES_PER_MESSAGE),
      };
      session.messages.push(msg);
      // 第一次说话就顺手把「新对话」换成真实标题，列表里才认得出这个会话
      if (session.title === '新对话') {
        session.title = deriveTitle(content || msg.attachments?.[0]?.name || '');
      }
      touch(session);
      commit();
      return msg;
    },

    /** 新建一条助手消息，进入 streaming 状态 */
    pushAssistant({ mode = null, model = null } = {}) {
      const session = active();
      const msg = {
        id: uid('a'),
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
        finishedAt: null,
        status: 'streaming',
        error: null,
        mode,
        model,
        personaId: session.personaId,
        attachments: [],
      };
      session.messages.push(msg);
      persist();
      beginStreamingCycle();
      return msg;
    },

    /** 增量追加。用节流落盘：正文实时上屏，但不为每个 token 全量序列化一遍 */
    appendDelta(message, text) {
      message.content += text;
      schedulePersist();
    },

    setMode(message, mode) {
      message.mode = mode;
      persist();
    },

    setMessageModel(message, model) {
      message.model = model;
      persist();
    },

    finish(message, status = 'done', error = null) {
      message.status = status;
      message.error = error;
      message.finishedAt = Date.now();
      const session = sessions.find((s) => s.messages.includes(message));
      if (session) touch(session);
      commit();
    },

    /** 停止生成：把已写出的内容保留下来 */
    interrupt(message) {
      message.status = 'interrupted';
      message.finishedAt = Date.now();
      commit();
    },

    /** 出错重试前，把失败的那条助手消息丢掉 */
    dropMessage(message) {
      const session = sessions.find((s) => s.messages.includes(message));
      if (!session) return;
      const index = session.messages.indexOf(message);
      if (index >= 0) {
        session.messages.splice(index, 1);
        commit();
      }
    },

    /**
     * 取出最后一条消息（重新生成时用）。
     *
     * 重新生成必须复用原来那条提问，而不是再 push 一条 ——
     * 否则列表里会留下两条一模一样的提问，「一问一答」的对谈结构就断了。
     * 这里只改内存不落盘，调用方紧接着会把消息加回去。
     */
    popLast() {
      return active().messages.pop() ?? null;
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
