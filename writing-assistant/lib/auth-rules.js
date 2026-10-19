/*!
 * 三易 · 智能写作台 —— 账号规则（auth-rules.js）
 *
 * 名字 / 密码 / 头像的规矩，**浏览器与服务端用的是同一个文件**。
 * 为什么必须共用：规则一旦两边各写一套就会慢慢分叉。轻的分叉是「前端说能过、后端说不行」，
 * 重的那种是**前端拦了、后端没拦** —— 绕过页面直接发请求就进去了。
 *
 * 所以这里只有纯函数和常量：不碰 DOM、不碰 node:crypto，两边都跑得起来，
 * 也就被同一批纯函数测试盯住（test/auth.test.js）。
 *
 * 服务端那一半（密码哈希、令牌签名、账号文件）在 lib/auth.js 里 —— 那些**只能**在服务端跑。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WriterAuthRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const USERNAME_MIN = 2;
  const USERNAME_MAX = 20;
  const PASSWORD_MIN = 8;
  const PASSWORD_MAX = 200;

  /**
   * 头像图片的上限（dataURL 字符数，约 48KB 二进制）。
   * 头像是**存进 users.json 的**，不设上限就等于让一次上传把账号文件撑爆。
   * 客户端会先压到 128px 再上传，这里是**不信任客户端**的第二道闸。
   */
  const AVATAR_IMAGE_MAX = 64 * 1024;

  /**
   * 恢复码的格式：三组四位，中间短横线。字母表去掉了 I / O / 0 / 1
   *（抄写时最容易看错的四个），剩下的都是不会认错的字符。
   * 它只在这里定义一次，服务端生成与前端规整都读它。
   */
  const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const RECOVERY_GROUPS = 3;
  const RECOVERY_GROUP_LEN = 4;

  /**
   * 内置头像（emoji）白名单。
   * 只认这几个：头像是要写进页面的，**白名单**比「过滤 + 转义」好懂也好测 ——
   * 手改过的本地缓存、别处导入的数据塞进来别的字符，一律丢掉换成默认头像。
   */
  const AVATAR_EMOJI = [
    '🖋', '🖌', '📝', '📖', '📚', '✒️', '🗒', '📜',
    '🪶', '🎐', '🍵', '🪴', '🌾', '🌙', '⭐', '🔥',
    '🧭', '🎨', '🦊', '🐧',
  ];

  /**
   * 首字母头像的底色。
   * 都在稿纸（#f6f7f2）上压得住白字：太浅的底会让首字母糊成一片。
   */
  const AVATAR_COLORS = [
    '#b23a2b', '#2f6b4f', '#29496b', '#7a4b8f',
    '#a8761f', '#2f6f6b', '#8c3a5c', '#495a51',
  ];

  /** 名字：去掉首尾空白。**不改内部空白** —— 名字里有空格是「不合法」，不是「帮你改掉」 */
  function normalizeName(raw) {
    return typeof raw === 'string' ? raw.trim() : '';
  }

  /** 用来判重名的键：大小写不敏感（Alice 和 alice 是同一个人，不然会出现两个「看起来一样」的账号） */
  function nameKey(name) {
    return normalizeName(name).toLowerCase();
  }

  /**
   * 名字的合法性。
   * 允许中文、字母、数字、下划线、短横线；不许有空格和别的符号 ——
   * 名字会出现在账号菜单、导出文件名和日志里，能省掉一类「奇怪字符」的问题。
   */
  function validateName(raw) {
    const name = normalizeName(raw);
    if (!name) return { ok: false, error: '请填一个名字' };
    if (name.length < USERNAME_MIN) return { ok: false, error: `名字至少 ${USERNAME_MIN} 个字` };
    if (name.length > USERNAME_MAX) return { ok: false, error: `名字最多 ${USERNAME_MAX} 个字` };
    if (/\s/.test(name)) return { ok: false, error: '名字里不能有空格' };
    if (!/^[\w\u4e00-\u9fa5-]+$/.test(name)) {
      return { ok: false, error: '名字只能用中文、字母、数字、下划线和短横线' };
    }
    return { ok: true, name };
  }

  /**
   * 密码的合法性。
   *
   * 只挡三类：**太短**、**太长**和**和名字一样**。刻意不搞「必须有大写 + 数字 + 符号」那一套 ——
   * 那套规则把人逼去用 `Passw0rd!` 这种既难记又好猜的东西。长度是这里唯一有意义的硬指标。
   * 强度提示（passwordHint）只作提示，不拦人。
   */
  function validatePassword(raw, options) {
    const password = typeof raw === 'string' ? raw : '';
    const name = (options && options.name) || '';
    if (!password) return { ok: false, error: '请填一个密码' };
    if (password.length < PASSWORD_MIN) return { ok: false, error: `密码至少 ${PASSWORD_MIN} 位` };
    if (password.length > PASSWORD_MAX) return { ok: false, error: `密码最多 ${PASSWORD_MAX} 位` };
    if (name && password.toLowerCase() === nameKey(name)) {
      return { ok: false, error: '密码不能和名字一样' };
    }
    return { ok: true };
  }

  /**
   * 密码强度提示（纯提示，不拦提交）。
   * 返回值带一句**说得出理由**的话：只说「弱」会让人不知道该改什么。
   */
  function passwordHint(raw) {
    const password = typeof raw === 'string' ? raw : '';
    if (!password) return { level: 'empty', text: '' };
    const classes = [
      /[a-z]/.test(password),
      /[A-Z]/.test(password),
      /\d/.test(password),
      /[^A-Za-z0-9]/.test(password),
    ].filter(Boolean).length;

    if (password.length < PASSWORD_MIN) {
      return { level: 'weak', text: `还差 ${PASSWORD_MIN - password.length} 位` };
    }
    if (/^\d+$/.test(password)) return { level: 'weak', text: '全是数字，容易被猜到' };
    if (classes === 1 && password.length < 12) return { level: 'ok', text: '能用；再长一点更稳' };
    if (password.length >= 12 && classes >= 3) return { level: 'good', text: '很稳' };
    return { level: 'ok', text: '还行' };
  }

  /** 首字母：拉丁字母转大写，中文照原样，实在没有就用问号 */
  function initialChar(name) {
    const first = Array.from(normalizeName(name))[0] || '?';
    return /[a-z]/.test(first) ? first.toUpperCase() : first;
  }

  /* ── 恢复码 ─────────────────────────────────────────────── */

  /**
   * 把用户抄下来的恢复码整理成标准形状：去空白、去短横线、转大写。
   * **宽容地读**：`abcd-efgh-jkmn`、`ABCD EFGH JKMN`、`abcdefghjkmn` 都认 ——
   * 人抄一串码时出现的空格、大小写、漏打短横线，都不该让「找回密码」失败。
   */
  function normalizeRecoveryCode(raw) {
    const text = String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
    return text;
  }

  /** 是不是一个形状正确的恢复码（12 位，只含字母表里的字符） */
  function isRecoveryCode(raw) {
    const code = normalizeRecoveryCode(raw);
    if (code.length !== RECOVERY_GROUPS * RECOVERY_GROUP_LEN) return false;
    for (const ch of code) {
      if (RECOVERY_ALPHABET.indexOf(ch) < 0) return false;
    }
    return true;
  }

  /** 12 位裸码 → `ABCD-EFGH-JKMN` 这种给人抄的写法 */
  function formatRecoveryCode(raw) {
    const code = normalizeRecoveryCode(raw);
    const groups = [];
    for (let i = 0; i < code.length; i += RECOVERY_GROUP_LEN) {
      groups.push(code.slice(i, i + RECOVERY_GROUP_LEN));
    }
    return groups.join('-');
  }

  /**
   * 从名字里挑一个底色。
   * 同一个名字永远得到同一个颜色（按码点求和取模）—— 改天再看还是这个色，
   * 不用把「自动挑的颜色」也存起来。
   */
  function avatarColorFor(seed) {
    const sum = Array.from(String(seed == null ? '' : seed)).reduce(
      (acc, ch) => acc + (ch.codePointAt(0) || 0),
      0
    );
    return AVATAR_COLORS[sum % AVATAR_COLORS.length];
  }

  /**
   * 头像的规整。**唯一入口** —— 注册、换头像、读账号记录都走它。
   * 认不出来的一律返回 null，调用方据此回落到默认头像（首字母）。
   *
   * 三种形态：
   *   { kind: 'initial', color: '#hex' | null }  —— 首字母；color 为 null 时按名字算
   *   { kind: 'emoji', emoji: '🖋' }             —— 只能是白名单里的
   *   { kind: 'image', dataUrl: 'data:image/…' } —— 压到 128px 再上传的小图
   */
  function normalizeAvatar(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.kind === 'emoji') {
      return AVATAR_EMOJI.indexOf(raw.emoji) >= 0 ? { kind: 'emoji', emoji: raw.emoji } : null;
    }
    if (raw.kind === 'image') {
      const dataUrl = typeof raw.dataUrl === 'string' ? raw.dataUrl : '';
      return isAvatarImage(dataUrl) ? { kind: 'image', dataUrl } : null;
    }
    if (raw.kind === 'initial') {
      const color = typeof raw.color === 'string' && AVATAR_COLORS.indexOf(raw.color) >= 0 ? raw.color : null;
      return { kind: 'initial', color };
    }
    return null;
  }

  /**
   * 这是一张能用的头像图吗。
   *
   * 两道关：**只有这三种图片类型**（svg 能带脚本，直接排除）、**大小有上限**。
   */
  function isAvatarImage(dataUrl) {
    if (typeof dataUrl !== 'string' || dataUrl.length > AVATAR_IMAGE_MAX) return false;
    return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl);
  }

  /**
   * 「这个头像该画成什么」——**页面只问这一个函数**，不再自己判断 kind。
   *
   * 返回 { text, color, image, label }：文字头像给 text + color（当底色），
   * 图片头像给 image（当 <img> 的 src），label 给屏幕阅读器。
   * 认不出来的头像（手改过的数据）自动回落到「首字母 + 按名字算的颜色」，不会画出一块空白。
   */
  function avatarView(user) {
    const name = normalizeName(user && user.name) || '?';
    const avatar = normalizeAvatar(user && user.avatar) || { kind: 'initial', color: null };
    if (avatar.kind === 'emoji') {
      return { text: avatar.emoji, color: null, image: '', label: `${name}：emoji 头像` };
    }
    if (avatar.kind === 'image') {
      return { text: '', color: null, image: avatar.dataUrl, label: `${name}：自己上传的头像` };
    }
    return {
      text: initialChar(name),
      color: avatar.color || avatarColorFor(nameKey(name)),
      image: '',
      label: `${name}：首字母头像`,
    };
  }

  /**
   * 能发给浏览器的账号信息。
   * **只在这里**决定「哪些字段可以出去」—— 密码哈希、盐、tokenVersion 这些
   * 永远不该离开服务端，而漏字段比漏逻辑更容易发生，所以收成一个函数。
   */
  function publicUser(user) {
    if (!user) return null;
    return {
      id: user.id,
      name: user.name,
      createdAt: user.createdAt,
      avatar: normalizeAvatar(user.avatar) || { kind: 'initial', color: null },
    };
  }

  return {
    USERNAME_MIN,
    USERNAME_MAX,
    PASSWORD_MIN,
    PASSWORD_MAX,
    AVATAR_IMAGE_MAX,
    AVATAR_EMOJI,
    AVATAR_COLORS,
    RECOVERY_ALPHABET,
    RECOVERY_GROUPS,
    RECOVERY_GROUP_LEN,
    normalizeName,
    nameKey,
    validateName,
    validatePassword,
    passwordHint,
    initialChar,
    normalizeRecoveryCode,
    isRecoveryCode,
    formatRecoveryCode,
    avatarColorFor,
    normalizeAvatar,
    isAvatarImage,
    avatarView,
    publicUser,
  };
});
