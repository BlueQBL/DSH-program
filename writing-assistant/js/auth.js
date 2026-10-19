/*!
 * 三易 · 智能写作台 —— 账号（浏览器这一侧，js/auth.js）
 *
 * 分成两块：
 *   · createAuthApi —— 只是把 fetch 包一层（把 401 / 错误文案规整成异常），便于替换测试；
 *   · 纯逻辑 —— 「最近登录过谁」「这个头像画成什么」「提交之前先自己看一眼」。
 *
 * **判断规则一条都不在这里**：名字 / 密码 / 头像的合法性在 lib/auth-rules.js，那个文件服务端也读。
 * 这里只负责「先说一遍，让用户不用等服务端来回」—— 服务端仍然会再拦一次，而且以它为准。
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('../lib/auth-rules.js') : root.WriterAuthRules);
  if (isNode) module.exports = api;
  if (root) root.WriterAuth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Rules) {
  'use strict';

  /** 头像上传的压缩参数：128px 的小图，够清楚，又小到能塞进账号文件 */
  const AVATAR_MAX_EDGE = 128;
  const AVATAR_TARGET_CHARS = 40 * 1024;

  /**
   * 和 /api/auth/* 说话。
   *
   * `onUnauthorized` 是**唯一**处理「票过期了」的地方：任何一条路回 401 都会叫它一次。
   * 为什么收在这里：过期可能在任何一个请求上被发现（改头像、改名字、存留档……），
   * 每个调用点各写一遍「那我要不要切回未登录」必然漏掉一处 ——
   * 而漏掉的那处表现为「界面还装作登录着，但什么都存不上」。
   */
  function createAuthApi(options) {
    const opt = options || {};
    const fetchImpl = opt.fetchImpl || ((url, init) => fetch(url, init));
    const onUnauthorized = typeof opt.onUnauthorized === 'function' ? opt.onUnauthorized : null;

    async function call(pathname, request) {
      const req = request || {};
      const response = await fetchImpl(pathname, {
        method: req.method || 'GET',
        // 同源请求会自己带上那张 HttpOnly 的票；页面脚本读不到它，也不该读到
        credentials: 'same-origin',
        headers: req.body ? { 'content-type': 'application/json' } : undefined,
        body: req.body ? JSON.stringify(req.body) : undefined,
      });

      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }

      if (!response.ok) {
        const error = new Error((data && (data.error || data.message)) || `服务端返回 ${response.status}`);
        error.status = response.status;
        error.code = (data && data.code) || '';
        if (response.status === 401 && onUnauthorized) onUnauthorized(error);
        throw error;
      }
      return data || {};
    }

    return {
      me: () => call('/api/auth/me'),
      register: (input) =>
        call('/api/auth/register', {
          method: 'POST',
          body: { name: input.name, password: input.password, remember: input.remember, avatar: input.avatar },
        }),
      login: (input) =>
        call('/api/auth/login', {
          method: 'POST',
          body: { name: input.name, password: input.password, remember: input.remember },
        }),
      logout: () => call('/api/auth/logout', { method: 'POST' }),
      setAvatar: (avatar) => call('/api/auth/avatar', { method: 'POST', body: { avatar } }),
      rename: (name) => call('/api/auth/name', { method: 'POST', body: { name } }),
      changePassword: (input) =>
        call('/api/auth/password', {
          method: 'POST',
          body: { oldPassword: input.oldPassword, newPassword: input.newPassword, remember: input.remember },
        }),
      /** 用恢复码重置密码（忘了密码时的正路），成功即登录，并换一把新钥匙 */
      recover: (input) =>
        call('/api/auth/recover', {
          method: 'POST',
          body: { name: input.name, code: input.code, newPassword: input.newPassword, remember: input.remember },
        }),
    };
  }

  /* ── 最近登录过的账号 ───────────────────────────────────── */

  /**
   * 存在浏览器里（`sanyi.accounts.v1`），**只存名字和时间戳** —— 不存密码、不存头像。
   * 用途只有一个：登录时点一下，不用再打一遍名字。
   * 列表里那个小头像色块是从名字算出来的（首字母），所以这里不需要多存任何东西。
   *
   * 四个函数都是纯的（列表进来、列表出去），读写在两个薄 wrapper 里 ——
   * 「去重 / 提前 / 封顶 / 前缀匹配」正是最容易写歪的地方，纯函数才好被单测盯住。
   */
  const RECENT_ACCOUNTS_KEY = 'sanyi.accounts.v1';
  const RECENT_ACCOUNTS_MAX = 6;

  /** 读。脏数据（手改过的、旧版本留下的、根本不是数组的）一律当空，绝不让它把登录框炸掉 */
  function readRecentAccounts(storage) {
    const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    try {
      const raw = JSON.parse((store && store.getItem(RECENT_ACCOUNTS_KEY)) || '[]');
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

  function writeRecentAccounts(list, storage) {
    const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    const clean = Array.isArray(list) ? list.slice(0, RECENT_ACCOUNTS_MAX) : [];
    try {
      if (store) store.setItem(RECENT_ACCOUNTS_KEY, JSON.stringify(clean));
    } catch {
      /* 存不下（配额满 / 隐私模式）不影响登录，只是下次要重新打一遍名字 */
    }
    return clean;
  }

  /**
   * 记一个账号：已经在列表里就**提到最前面**（判重不分大小写，跟账号本身一个规矩），
   * 超过上限就砍掉最旧的那条。
   */
  function rememberAccount(list, name, options) {
    const opt = options || {};
    const at = Number(opt.at) || Date.now();
    const max = Number(opt.max) || RECENT_ACCOUNTS_MAX;
    const rows = Array.isArray(list) ? list : [];
    const clean = String(name == null ? '' : name).trim();
    if (!clean) return rows.slice(0, max);
    const key = Rules.nameKey(clean);
    return [{ name: clean, at }].concat(rows.filter((item) => Rules.nameKey(item.name) !== key)).slice(0, max);
  }

  /** 换了名字之后，列表里那一条也要跟着换 —— 不然下次登录还摆着旧名字，点了还登不上去 */
  function renameRememberedAccount(list, oldName, newName, options) {
    const opt = options || {};
    const rows = Array.isArray(list) ? list : [];
    const oldKey = Rules.nameKey(oldName);
    const rest = rows.filter((item) => Rules.nameKey(item.name) !== oldKey);
    const clean = String(newName == null ? '' : newName).trim();
    return clean ? rememberAccount(rest, clean, opt) : rest.slice(0, Number(opt.max) || RECENT_ACCOUNTS_MAX);
  }

  /**
   * 输入框里那几个字能匹配谁：**按前缀**（不分大小写）。
   * 空输入 = 全都列出来（点一下名字框看到的就是「最近登录过的」）。
   */
  function matchRecentAccounts(list, query, options) {
    const opt = options || {};
    const limit = Number(opt.limit) || RECENT_ACCOUNTS_MAX;
    const rows = Array.isArray(list) ? list : [];
    const needle = Rules.nameKey(query);
    const matched = needle ? rows.filter((item) => Rules.nameKey(item.name).indexOf(needle) === 0) : rows;
    return matched.slice(0, limit);
  }

  /* ── 画头像 ─────────────────────────────────────────────── */

  /**
   * 把这个头像画进一个元素里。
   *
   * 页面**只调这一个**函数：emoji 头像写 emoji，首字母头像写首字母，
   * 自己上传的图显示 <img>，底色统一走 `--avatar-bg`（让 CSS 决定形状和大小）。
   * 认不出来的头像由 avatarView 回落成首字母，所以这里永远不会画出一块空白。
   */
  function paintAvatar(root, user) {
    if (!root) return null;
    const view = Rules.avatarView(user);
    const image = root.querySelector ? root.querySelector('.avatar__img') : null;
    const text = root.querySelector ? root.querySelector('.avatar__text') : null;
    if (image) {
      image.hidden = !view.image;
      if (view.image) image.setAttribute('src', view.image);
    }
    if (text) {
      text.textContent = view.text;
      text.hidden = Boolean(view.image);
    }
    if (root.dataset) root.dataset.kind = (Rules.normalizeAvatar(user && user.avatar) || {}).kind || 'initial';
    if (root.style && root.style.setProperty) root.style.setProperty('--avatar-bg', view.color || 'transparent');
    root.setAttribute('aria-label', view.label);
    root.setAttribute('title', view.label);
    return view;
  }

  /* ── 上传头像：先压再传 ─────────────────────────────────── */

  /** 按长边上限算出缩放后的尺寸；本来就小就原样返回（纯函数，测试盯得住） */
  function fitSize(width, height, maxEdge) {
    const edge = Number(maxEdge) > 0 ? Number(maxEdge) : AVATAR_MAX_EDGE;
    if (!width || !height) return { width: edge, height: edge, scaled: false };
    const longest = Math.max(width, height);
    if (longest <= edge) return { width, height, scaled: false };
    const ratio = edge / longest;
    return {
      width: Math.max(1, Math.round(width * ratio)),
      height: Math.max(1, Math.round(height * ratio)),
      scaled: true,
    };
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('这张图读不出来'));
      reader.readAsDataURL(file);
    });
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('只支持图片文件'));
      img.src = dataUrl;
    });
  }

  /**
   * 压一张图：长边缩到 128px，必要时降画质，直到体积达标。
   *
   * 为什么压：头像要写进 `data/users.json`，原图动辄几 MB —— 一个头像不该
   * 把账号文件撑成相册。压完一般 5–15KB，几十个头像也就几百 KB。
   */
  async function compressImage(file, options) {
    const opt = options || {};
    const maxEdge = Number(opt.maxEdge) > 0 ? Number(opt.maxEdge) : AVATAR_MAX_EDGE;
    const targetChars = Number(opt.targetChars) > 0 ? Number(opt.targetChars) : AVATAR_TARGET_CHARS;
    if (!file || !/^image\//.test(file.type || '')) throw new Error('只支持图片文件');

    const original = await readFileAsDataUrl(file);
    const img = await loadImage(original);
    const { width, height, scaled } = fitSize(img.naturalWidth || img.width, img.naturalHeight || img.height, maxEdge);

    let dataUrl = original;
    let mime = file.type || 'image/png';
    if (scaled || dataUrl.length > targetChars) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      // 白底：PNG 的透明区转 JPEG 会变黑，先铺白比事后解释容易
      if (ctx) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
      }
      let quality = 0.9;
      let out = canvas.toDataURL('image/jpeg', quality);
      while (out.length > targetChars && quality > 0.45) {
        quality -= 0.15;
        out = canvas.toDataURL('image/jpeg', quality);
      }
      dataUrl = out;
      mime = 'image/jpeg';
    }

    return {
      dataUrl,
      mime,
      name: file.name || '图片',
      width,
      height,
      originalChars: original.length,
      finalChars: dataUrl.length,
      compressed: dataUrl.length < original.length,
    };
  }

  /**
   * 压完的图 → 头像对象（再过一道服务端也会过的那道闸）。
   * 压过也可能不合格（不是这三种类型、或者还是太大），那就返回 null 让页面说清楚。
   */
  function avatarFromUpload(compressed) {
    if (!compressed) return null;
    const mime = String(compressed.mime || '');
    if (!/^image\/(png|jpeg|webp)$/.test(mime)) return null;
    return Rules.normalizeAvatar({ kind: 'image', dataUrl: compressed.dataUrl });
  }

  /** 上传失败时给一句能照着做的话（不是「上传失败」四个字） */
  function uploadErrorMessage(err) {
    const message = String((err && err.message) || '');
    if (/只支持图片/.test(message)) return '只能传 png / jpg / webp 的图片';
    if (/太大/.test(message)) return '这张图太大了，换一张小一点的';
    return '这张图没能处理成功，换一张试试（png / jpg / webp）';
  }

  /* ── 提交之前先自己看一眼 ───────────────────────────────── */

  /**
   * 返回一句给人看的话，空串表示「可以提交」。
   *
   * mode: 'login' | 'register' | 'name' | 'password' | 'recover'
   * 登录**不查密码长度**：规则可能变过，老账号的密码长短不该在登录框上被拦下来
   *（那样人只会看到一个自己的密码明明是对的错误）。
   */
  function authFormError(input) {
    const form = input || {};
    const mode = form.mode;
    const name = form.name;
    const password = form.password;
    const confirm = form.confirm || '';
    const newPassword = form.newPassword || '';
    const code = form.code || '';

    if (mode === 'name') {
      // 改名字只查名字：它是个显示用的名字，改它不要密码
      const checked = Rules.validateName(name);
      return checked.ok ? '' : checked.error;
    }
    if (mode === 'password') {
      if (!password) return '请填原密码';
      const checked = Rules.validatePassword(newPassword, { name });
      if (!checked.ok) return checked.error;
      if (newPassword !== confirm) return '两次输入的新密码不一样';
      if (newPassword === password) return '新密码和原密码一样';
      return '';
    }
    if (mode === 'recover') {
      if (!String(name == null ? '' : name).trim()) return '请填名字';
      // 恢复码读得宽松（空格、大小写、漏掉的短横线都不计较），但不合法的要当场说清楚
      if (!Rules.isRecoveryCode(code)) return '恢复码是 12 位，像 ABCD-EFGH-JKMN 这样；抄的时候可能漏了一位';
      const checkedNew = Rules.validatePassword(newPassword, { name });
      if (!checkedNew.ok) return checkedNew.error;
      if (newPassword !== confirm) return '两次输入的新密码不一样';
      return '';
    }
    if (!String(name == null ? '' : name).trim()) return '请填一个名字';
    if (!password) return '请填一个密码';
    if (mode === 'register') {
      const checkedName = Rules.validateName(name);
      if (!checkedName.ok) return checkedName.error;
      const checkedPassword = Rules.validatePassword(password, { name });
      if (!checkedPassword.ok) return checkedPassword.error;
      if (password !== confirm) return '两次输入的密码不一样';
    }
    return '';
  }

  return {
    AVATAR_MAX_EDGE,
    AVATAR_TARGET_CHARS,
    createAuthApi,
    fitSize,
    compressImage,
    avatarFromUpload,
    uploadErrorMessage,
    RECENT_ACCOUNTS_KEY,
    RECENT_ACCOUNTS_MAX,
    readRecentAccounts,
    writeRecentAccounts,
    rememberAccount,
    renameRememberedAccount,
    matchRecentAccounts,
    paintAvatar,
    authFormError,
    formatRecoveryCode: Rules.formatRecoveryCode,
    isRecoveryCode: Rules.isRecoveryCode,
  };
});
