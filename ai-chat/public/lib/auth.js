// 账号（浏览器这一侧）：和 /api/auth/* 说话，以及「这个头像该画成什么」。
//
// 分成两块：
//   · createAuthApi —— 只是把 fetch 包一层（把 401/错误文案规整成异常），便于替换测试；
//   · paintAvatar / authFormError —— 纯逻辑（怎么画、能不能提交）。
//
// **判断规则一条都不在这里**：名字 / 密码 / 头像的合法性在 lib/auth-rules.js，
// 那个文件服务端也 import。这里只负责「先说一遍，让用户不用等服务端来回」——
// 服务端仍然会再拦一次，而且以它为准。

import { avatarView, nameKey, normalizeAvatar, validateName, validatePassword } from './auth-rules.js';

/** 头像上传的压缩参数：128px 的小图，够清楚，又小到能塞进账号文件 */
export const AVATAR_MAX_EDGE = 128;
export const AVATAR_TARGET_CHARS = 40 * 1024;

/**
 * 和 /api/auth/* 说话。
 *
 * `onUnauthorized` 是**唯一**处理「票过期了」的地方：任何一条路回 401 都会叫它一次。
 * 为什么收在这里：过期可能在任何一个请求上被发现（推送快照、拉快照、改头像……），
 * 每个调用点各写一遍「那我要不要切回未登录」必然漏掉一处 —— 而漏掉的那处表现为
 * 「界面还装作登录着，但什么都存不上」。
 */
export function createAuthApi({ fetchImpl = globalThis.fetch, onUnauthorized = null } = {}) {
  async function call(pathname, { method = 'GET', body } = {}) {
    const response = await fetchImpl(pathname, {
      method,
      // 同源请求会自己带上那张 HttpOnly 的票；页面脚本读不到它，也不该读到
      credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      const error = new Error(data?.error || `服务端返回 ${response.status}`);
      error.status = response.status;
      error.code = data?.code || '';
      if (response.status === 401 && typeof onUnauthorized === 'function') onUnauthorized(error);
      throw error;
    }
    return data ?? {};
  }

  return {
    me: () => call('/api/auth/me'),
    register: ({ name, password, remember, avatar }) =>
      call('/api/auth/register', { method: 'POST', body: { name, password, remember, avatar } }),
    login: ({ name, password, remember }) =>
      call('/api/auth/login', { method: 'POST', body: { name, password, remember } }),
    logout: () => call('/api/auth/logout', { method: 'POST' }),
    setAvatar: (avatar) => call('/api/auth/avatar', { method: 'POST', body: { avatar } }),
    rename: (name) => call('/api/auth/name', { method: 'POST', body: { name } }),
    changePassword: ({ oldPassword, newPassword, remember }) =>
      call('/api/auth/password', { method: 'POST', body: { oldPassword, newPassword, remember } }),
    snapshotMeta: () => call('/api/sessions/snapshot?meta=1'),
    snapshot: () => call('/api/sessions/snapshot'),
    putSnapshot: (snapshot, device) =>
      call('/api/sessions/snapshot', { method: 'PUT', body: { snapshot, device } }),
  };
}

/**
 * 「最近登录过的账号」。
 *
 * 存在浏览器里（`duitanlu.accounts.v1`），**只存名字和时间戳** —— 不存密码、不存头像图。
 * 用途只有一个：登录时点一下，不用再打一遍名字。
 * 列表里那个小头像色块是从名字算出来的（首字母），所以这里不需要多存任何东西。
 *
 * 四个函数都是纯的（列表进来、列表出去），读写在两个薄 wrapper 里 ——
 * 「去重 / 提前 / 封顶 / 前缀匹配」正是最容易写歪的地方，纯函数才好被单测和变异盯住。
 */
export const RECENT_ACCOUNTS_KEY = 'duitanlu.accounts.v1';
export const RECENT_ACCOUNTS_MAX = 6;

/** 读。脏数据（手改过的、旧版本留下的、根本不是数组的）一律当空，绝不让它把登录页炸掉 */
export function readRecentAccounts(storage = globalThis.localStorage) {
  try {
    const raw = JSON.parse(storage?.getItem(RECENT_ACCOUNTS_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      // 早期只存名字字符串的那种也认（兼容一行的事，免得改过格式之后老数据变空）
      .map((item) => (typeof item === 'string' ? { name: item, at: 0 } : item))
      .filter((item) => item && typeof item.name === 'string' && item.name.trim())
      .map((item) => ({ name: item.name.trim().slice(0, 40), at: Number(item.at) || 0 }))
      .slice(0, RECENT_ACCOUNTS_MAX);
  } catch {
    return [];
  }
}

export function writeRecentAccounts(list, storage = globalThis.localStorage) {
  const clean = Array.isArray(list) ? list.slice(0, RECENT_ACCOUNTS_MAX) : [];
  try {
    storage?.setItem(RECENT_ACCOUNTS_KEY, JSON.stringify(clean));
  } catch {
    /* 存不下（配额满 / 隐私模式）不影响登录，只是下次要重新打一遍名字 */
  }
  return clean;
}

/**
 * 记一个账号：已经在列表里就**提到最前面**（判重不分大小写，跟账号本身一个规矩），
 * 超过上限就砍掉最旧的那条。
 */
export function rememberAccount(list, name, { at = Date.now(), max = RECENT_ACCOUNTS_MAX } = {}) {
  const rows = Array.isArray(list) ? list : [];
  const clean = String(name ?? '').trim();
  if (!clean) return rows.slice(0, max);
  const key = nameKey(clean);
  return [{ name: clean, at }, ...rows.filter((item) => nameKey(item.name) !== key)].slice(0, max);
}

/** 换了名字之后，列表里那一条也要跟着换 —— 不然下次登录还摆着旧名字，点了还登不上去 */
export function renameRememberedAccount(list, oldName, newName, { at = Date.now(), max = RECENT_ACCOUNTS_MAX } = {}) {
  const rows = Array.isArray(list) ? list : [];
  const oldKey = nameKey(oldName);
  const rest = rows.filter((item) => nameKey(item.name) !== oldKey);
  const clean = String(newName ?? '').trim();
  return clean ? rememberAccount(rest, clean, { at, max }) : rest.slice(0, max);
}

/**
 * 输入框里那几个字能匹配谁：**按前缀**（不分大小写）。
 * 空输入 = 全都列出来（点一下名字格看到的就是「最近登录过的」）。
 */
export function matchRecentAccounts(list, query, { limit = RECENT_ACCOUNTS_MAX } = {}) {
  const rows = Array.isArray(list) ? list : [];
  const needle = nameKey(query);
  const matched = needle ? rows.filter((item) => nameKey(item.name).startsWith(needle)) : rows;
  return matched.slice(0, limit);
}

/**
 * 把这个头像画进一个元素里。
 *
 * 页面**只调这一个**函数：文字头像写文字、emoji 头像写 emoji、上传的头像显示 <img>，
 * 底色统一走 `--avatar-bg`（让 CSS 决定形状和大小）。
 * 认不出来的头像由 avatarView 回落成首字母，所以这里永远不会画出一块空白。
 */
export function paintAvatar(root, user) {
  if (!root) return null;
  const view = avatarView(user);
  const avatar = normalizeAvatar(user?.avatar) ?? { kind: 'initial', color: null };

  const image = root.querySelector?.('.avatar-img');
  const text = root.querySelector?.('.avatar-text');
  if (image) {
    image.hidden = !view.image;
    if (view.image) image.setAttribute('src', view.image);
  }
  if (text) {
    text.textContent = view.text;
    text.hidden = Boolean(view.image);
  }

  root.dataset.kind = view.image ? 'image' : avatar.kind;
  root.style?.setProperty?.('--avatar-bg', view.color || 'transparent');
  root.setAttribute('aria-label', view.label);
  root.setAttribute('title', view.label);
  return view;
}

/**
 * 提交之前先自己看一眼。
 * 返回一句给人看的话，空串表示「可以提交」。
 *
 * mode: 'login' | 'register' | 'password' | 'name'
 * 登录**不查长度**：规则可能变过，老账号的密码长短不该在登录框上被拦下来
 *（那样人只会看到一个自己的密码明明是对的错误）。
 */
export function authFormError({ mode, name, password, confirm = '', newPassword = '' }) {
  if (mode === 'name') {
    // 改名字只查名字：它是个显示用的名字，改它不要密码
    const checked = validateName(name);
    return checked.ok ? '' : checked.error;
  }
  if (mode === 'password') {
    if (!password) return '请填原密码';
    const checked = validatePassword(newPassword, { name });
    if (!checked.ok) return checked.error;
    if (newPassword !== confirm) return '两次输入的新密码不一样';
    if (newPassword === password) return '新密码和原密码一样';
    return '';
  }
  if (!String(name ?? '').trim()) return '请填一个名字';
  if (!password) return '请填一个密码';
  if (mode === 'register') {
    const checkedName = validateName(name);
    if (!checkedName.ok) return checkedName.error;
    const checkedPassword = validatePassword(password, { name });
    if (!checkedPassword.ok) return checkedPassword.error;
    if (password !== confirm) return '两次输入的密码不一样';
  }
  return '';
}

/**
 * 上传的那张图 → 头像对象（压完之后再过一道）。
 * 压过也可能不合格（不是这三种类型、或者还是太大），那就返回 null 让页面说清楚。
 */
export function avatarFromUpload(compressed) {
  const dataUrl = compressed?.dataUrl;
  const mime = String(compressed?.mime ?? '');
  if (!dataUrl || !/^image\/(png|jpeg|webp)$/.test(mime)) return null;
  return normalizeAvatar({ kind: 'image', dataUrl });
}

/** 上传失败时给一句能照着做的话（不是「上传失败」四个字） */
export function uploadErrorMessage(err) {
  const message = String(err?.message ?? '');
  if (/只支持图片/.test(message)) return '只能传 png / jpg / webp 的图片';
  if (/太大/.test(message)) return '这张图太大了，换一张小一点的';
  return '这张图没能处理成功，换一张试试（png / jpg / webp）';
}

/**
 * 什么时候该把笔记本推到服务端。
 *
 * 规则一条：**距上次推送够久、而且这会儿没在生成回答**。
 * 生成中不推是因为一次推送是**整本笔记本**（可能好几 MB），
 * 一边流式一边推，等于每几秒把整本传一遍 —— 那是自找的卡顿。
 */
export const SNAPSHOT_MIN_GAP_MS = 4000;

export function shouldPushSnapshot({ busy = false, lastPushedAt = 0, now = Date.now(), minGapMs = SNAPSHOT_MIN_GAP_MS } = {}) {
  if (busy) return false;
  return now - lastPushedAt >= minGapMs;
}

/**
 * 快照的说明文字（账号菜单里那一行）。
 * 说清楚「上次什么时候存的」，用户才敢在另一台机器上按「恢复」。
 */
export function snapshotNote({ savedAt = '', count = 0, pending = false, failed = false } = {}) {
  if (failed) return '快照没存上（服务端没接住），下次改动会再试';
  if (pending) return '正在存…';
  if (!savedAt) return '还没有服务端快照';
  const at = new Date(savedAt);
  const time = Number.isNaN(at.getTime())
    ? ''
    : `${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return `快照：${count} 个会话 · ${time}`;
}

/** 从服务端恢复之前的确认话：要说清会覆盖什么、会丢什么 */
export function restoreConfirmText({ count = 0, savedAt = '', localCount = 0 } = {}) {
  const at = new Date(savedAt);
  const when = Number.isNaN(at.getTime()) ? '（时间不明）' : at.toLocaleString('zh-CN');
  return `服务端那份快照有 ${count} 个会话（${when}）。恢复会用**它**覆盖这台机器上这个账号的 ${localCount} 个会话 —— 覆盖之后本地多出来的改动就没了。继续吗？`;
}
