// 对话状态 + 本地持久化
//
// 唯一的真相来源是浏览器：所有轮次都写进 localStorage，刷新、关闭再打开都还在。
// 服务端 history 只作为「换个入口也能找回来」的兜底，不参与合并。
//
// 每条消息的状态：
//   done        正常结束
//   streaming   正在逐字写入（此时若刷新页面，下次启动会被判定为 interrupted）
//   interrupted 中途断开（网络、手动停止、刷新）
//   error       出错结束
//
// 流式中的半截文本也照样落盘，所以刷新后能看到「写到哪里断的」，而不是整条消息消失。

const STORAGE_KEY = 'duitanlu.conversation.v1';
const SESSION_KEY = 'duitanlu.session.v1';
const SCHEMA_VERSION = 1;

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

function loadSessionId() {
  try {
    const existing = localStorage.getItem(SESSION_KEY);
    if (existing && /^[A-Za-z0-9_-]{4,64}$/.test(existing)) return existing;
    const created = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem(SESSION_KEY, created);
    return created;
  } catch {
    return `s_${Date.now().toString(36)}`;
  }
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
  };
}

export function createStore() {
  const sessionId = loadSessionId();
  const restored = safeParse(localStorage.getItem(STORAGE_KEY));
  let messages = Array.isArray(restored?.messages)
    ? restored.messages.map(normalizeMessage).filter(Boolean)
    : [];

  // 上次是流式中途离开的（刷新 / 关页 / 断网）：把那条标记成中断，保留已写出的文字
  let recoveredInterrupted = 0;
  for (const msg of messages) {
    if (msg.status === 'streaming') {
      msg.status = 'interrupted';
      msg.finishedAt = msg.finishedAt || Date.now();
      recoveredInterrupted += 1;
    }
  }

  const listeners = new Set();

  function snapshot() {
    return { version: SCHEMA_VERSION, sessionId, updatedAt: new Date().toISOString(), messages };
  }

  /**
   * 落盘节流。
   *
   * 流式输出时每来一个 token 都会 appendDelta，如果每次都 JSON.stringify 整段对话，
   * 一轮回答就是上百次全量序列化 —— 对话越长越卡主线程。
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

  /** 立即落盘（消息结束、清空、接管外部数据时用） */
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

  if (recoveredInterrupted) commit();
  else persist();

  return {
    sessionId,
    get messages() {
      return messages;
    },
    get recoveredInterrupted() {
      return recoveredInterrupted;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    snapshot,

    /** 用户提问 */
    pushUser(content) {
      const msg = {
        id: uid('u'),
        role: 'user',
        content,
        createdAt: Date.now(),
        finishedAt: Date.now(),
        status: 'done',
        error: null,
        mode: null,
      };
      messages.push(msg);
      commit();
      return msg;
    },

    /** 新建一条助手消息，进入 streaming 状态 */
    pushAssistant({ mode = null } = {}) {
      const msg = {
        id: uid('a'),
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
        finishedAt: null,
        status: 'streaming',
        error: null,
        mode,
      };
      messages.push(msg);
      persist();
      beginStreamingCycle();
      return msg;
    },

    /** 增量追加。用节流落盘：正文实时上屏，但不为每个 token 全量序列化一遍对话 */
    appendDelta(message, text) {
      message.content += text;
      schedulePersist();
    },

    setMode(message, mode) {
      message.mode = mode;
      persist();
    },

    finish(message, status = 'done', error = null) {
      message.status = status;
      message.error = error;
      message.finishedAt = Date.now();
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
      const index = messages.indexOf(message);
      if (index >= 0) {
        messages.splice(index, 1);
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
      return messages.pop() ?? null;
    },

    /**
     * 清空：本地清干净，并让服务端兜底副本一起失效。
     *
     * 注意这里故意「先删键、再写回一份空快照」，而不是彻底不留痕迹：
     * 跨标签页同步依赖 storage 事件，只有真正写入才会触发事件，
     * 什么都不写的话，别的标签页会继续显示已经清掉的对话。
     */
    clear() {
      messages = [];
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* 忽略 */
      }
      commit();
      fetch(`/api/history/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    },

    /**
     * 把外部（服务端兜底副本 / 其它标签页）的对话接回本地。
     * persist:false 用于「跟随其它标签页」——写入方已经落盘，跟着再写一次只会自找循环。
     */
    adopt(messagesFromServer, { persist: shouldPersist = true } = {}) {
      const cleaned = (messagesFromServer ?? []).map(normalizeMessage).filter(Boolean);
      if (!cleaned.length) return false;
      messages = cleaned.map((m) => (m.status === 'streaming' ? { ...m, status: 'interrupted' } : m));
      if (shouldPersist) commit();
      else emit();
      return true;
    },
  };
}
