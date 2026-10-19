/*!
 * 三易 · 智能写作台 —— 账号体系的服务端那一半（auth.js，仅服务端）
 *
 * 只用 node:crypto 和 node:fs —— 这个项目零依赖，账号也不破例。
 *
 * 三条底线（每一条都有对应的测试）：
 *   1. **密码永不明文落盘**：scrypt 加随机盐，只存哈希和参数；
 *      比较用 timingSafeEqual（`===` 会在第一个不同的字节上早退，把哈希一个字节一个字节地漏出去）。
 *   2. **令牌是自己签的**：HMAC-SHA256，带过期时间；签名不对 / 过期 / 账号改过密码，一律作废。
 *   3. **账号文件坏了就报错，绝不当作空**：静默从零开始等于把所有人的账号清空，
 *      而且谁都能拿原来的名字重新注册一遍 —— 比服务起不来严重得多。
 *
 * 名字 / 密码 / 头像的规则不在这个文件里，在 lib/auth-rules.js（浏览器也读同一份）。
 */
'use strict';

const { createHmac, randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const Rules = require('./auth-rules.js');

/** 会话 Cookie 的名字。改名等于把所有已登录的人踢下线 */
const TOKEN_COOKIE = 'sanyi_session';

/** 令牌有效期：勾了「记住我」就 30 天，不勾就是这个浏览器会话（见 sessionCookie 的 maxAge） */
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * scrypt 参数。
 * N=16384 是「本地服务端够用、又不至于让每次登录卡住」的档位（一次约几十毫秒）。
 * 参数**跟着每条记录存下来**：以后要调高，老记录照样能验证，不用逼所有人改密码。
 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** 用随机盐算一次密码哈希。返回值整体就是「密码记录」，直接存进账号条目 */
function hashPassword(password, options) {
  const opt = options || {};
  const salt = typeof opt.salt === 'string' && opt.salt ? opt.salt : randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });
  // 参数跟着记录一起存（maxmem 是这次调用的运行时参数，不是「当初用的参数」，不存）
  return {
    algorithm: 'scrypt',
    salt,
    hash: hash.toString('hex'),
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    keylen: SCRYPT.keylen,
  };
}

/**
 * 验证密码。
 * 任何形状不对的记录（手改过的文件、旧版本留下的、压根不是对象的）都返回 false，
 * 而不是抛异常 —— 认证路径上「异常」和「失败」必须走同一出口，
 * 否则一个坏记录就能 500 掉整个登录接口。
 */
function verifyPassword(password, record) {
  if (!record || typeof record !== 'object') return false;
  if (typeof record.salt !== 'string' || typeof record.hash !== 'string') return false;
  if (!record.salt || !record.hash) return false;

  const expected = Buffer.from(record.hash, 'hex');
  if (!expected.length) return false;

  const params = {
    N: Number(record.N) || SCRYPT.N,
    r: Number(record.r) || SCRYPT.r,
    p: Number(record.p) || SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  };
  let actual;
  try {
    actual = scryptSync(String(password), record.salt, expected.length, params);
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** 待验证的假记录：账号不存在时也照样算一遍，让「有没有这个人」在耗时上分不出来 */
const DUMMY_PASSWORD = hashPassword('sanyi-dummy-password');

/* ── 恢复码 ─────────────────────────────────────────────────── */

/**
 * 生成一个恢复码（`ABCD-EFGH-JKMN`）。
 *
 * 为什么有它：这个工具没有邮箱、没有短信，也就没有「点邮件里的链接重置密码」那条路。
 * 恢复码是**注册时给你的一把备用钥匙**：抄下来收好，忘了密码时用它 + 新密码自助重来。
 * 它**只以哈希形式落盘**，所以连服务端也看不到原文 —— 丢了就是丢了（那就走本机命令行）。
 */
function makeRecoveryCode() {
  const alphabet = Rules.RECOVERY_ALPHABET;
  const need = Rules.RECOVERY_GROUPS * Rules.RECOVERY_GROUP_LEN;
  // 拒绝采样：从 256 里取，超出字母表范围的重取，避免取模偏差
  let out = '';
  while (out.length < need) {
    for (const byte of randomBytes(need)) {
      if (out.length >= need) break;
      if (byte >= 256 - (256 % alphabet.length)) continue;
      out += alphabet[byte % alphabet.length];
    }
  }
  return Rules.formatRecoveryCode(out);
}

/** 恢复码也走 scrypt 存哈希；比对时同样宽容（大小写、空格、短横线都不计较） */
function hashRecovery(code) {
  return hashPassword(Rules.normalizeRecoveryCode(code));
}

function verifyRecovery(code, record) {
  if (!record) return false;
  return verifyPassword(Rules.normalizeRecoveryCode(code), record);
}

/* ── 令牌 ───────────────────────────────────────────────────── */

/**
 * 签一个令牌：`base64url(载荷).base64url(HMAC)`。
 * 载荷是**明文可读的**（uid / tv / iat / exp）—— 刻意不加密：里面没有秘密，
 * 而且出问题时能直接把它 base64 解开看一眼，比黑盒强。**能不能信全靠签名。**
 */
function signToken(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body, secret)}`;
}

function sign(body, secret) {
  return createHmac('sha256', String(secret)).update(body).digest('base64url');
}

/**
 * 验令牌。返回载荷，或 null。
 * 四种情况都算 null：形状不对、签名不对、字段不全、过期。
 * `now` 可注入 —— 测试要拿它把「过期」摆到眼前。
 */
function verifyToken(token, secret, options) {
  const now = (options && options.now) || Date.now();
  if (typeof token !== 'string' || !secret) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const given = token.slice(dot + 1);

  const expected = sign(body, secret);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // 长度不一样时 timingSafeEqual 会抛，先挡掉（这里泄露的只是长度，签名长度本来就是固定的）
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.uid !== 'string' || !payload.uid) return null;
  if (!Number.isFinite(payload.exp) || payload.exp <= now) return null;
  return payload;
}

/** 从 Cookie 头里取一个值（不引第三方解析器：这里只需要「取一个名字」） */
function readCookie(header, name) {
  const parts = String(header == null ? '' : header).split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * 下发会话 Cookie。
 *
 * HttpOnly：页面脚本读不到它（XSS 也偷不走）；
 * SameSite=Lax：跨站发起的 POST 不带它（防 CSRF 的第一道）；
 * Path=/：整个站点都要用；
 * Secure：只在 https 下加 —— 本机 http 加了就等于这条 Cookie 永远发不出去
 *（登录看起来「成功」但立刻失效）。
 */
function sessionCookie(token, options) {
  const opt = options || {};
  const parts = [`${TOKEN_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (Number(opt.maxAgeSeconds) > 0) parts.push(`Max-Age=${Math.floor(opt.maxAgeSeconds)}`);
  if (opt.secure) parts.push('Secure');
  return parts.join('; ');
}

/** 退出登录：把同一个 Cookie 用一个立刻过期的空值覆盖掉 */
function clearSessionCookie() {
  return `${TOKEN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/* ── 登录限速 ───────────────────────────────────────────────── */

/**
 * 登录 / 注册的失败限速（内存里，进程重启即清零）。
 *
 * 为什么必须有：没有它，一个脚本可以对着 8 位密码安静地试一整夜。
 * 为什么不用「锁定账号」那套：那等于给了攻击者一个把别人锁在门外的开关 ——
 * 这里按 **IP + 名字** 计数，试错成本上去，正常用户换个拼写照常能进。
 */
function createRateLimiter(options) {
  const opt = options || {};
  const max = Number(opt.max) > 0 ? Number(opt.max) : 8;
  const windowMs = Number(opt.windowMs) > 0 ? Number(opt.windowMs) : 10 * 60 * 1000;
  const now = typeof opt.now === 'function' ? opt.now : () => Date.now();
  /** key → 失败时刻数组（只留窗口内的） */
  const hits = new Map();

  const prune = (key, at) => {
    const list = (hits.get(key) || []).filter((t) => at - t < windowMs);
    if (list.length) hits.set(key, list);
    else hits.delete(key);
    return list;
  };

  return {
    /** 还能不能试：返回 { allowed, retryAfterMs } */
    check(key) {
      const at = now();
      const list = prune(String(key), at);
      if (list.length < max) return { allowed: true, retryAfterMs: 0 };
      return { allowed: false, retryAfterMs: Math.max(0, windowMs - (at - list[0])) };
    },
    /** 记一次失败。注意只在**失败**时记 —— 成功不该累计（否则每天正常登录也会被自己锁住） */
    fail(key) {
      const at = now();
      const list = prune(String(key), at);
      list.push(at);
      hits.set(String(key), list);
      return list.length;
    },
    /** 成功了就清零：这个 IP 上真正的用户回来了，没必要连坐 */
    succeed(key) {
      hits.delete(String(key));
    },
    /** 给测试和收尾用 */
    size() {
      return hits.size;
    },
    reset() {
      hits.clear();
    },
  };
}

/* ── 主人 ───────────────────────────────────────────────────── */

/** 没登录时的留档主人：写进这个桶，登录之后换回自己的 */
const LOCAL_OWNER = 'local';

/**
 * 这条记录该不该给这个用户看。
 *
 * 按**记录里记下的主人**判，而不是「按 id 猜」——
 * 没登录的人只能看 owner 为 'local' 的那些（本地模式写下的）。
 */
function ownsRecord(record, user) {
  const owner = (user && user.id) || LOCAL_OWNER;
  return ((record && record.owner) || LOCAL_OWNER) === owner;
}

/** 把任意输入收成一个能当文件名用的主人键（没有就退回 local） */
function normalizeOwner(raw) {
  const text = String(raw == null ? '' : raw).trim();
  return /^[A-Za-z0-9_-]{1,40}$/.test(text) ? text : LOCAL_OWNER;
}

/* ── 账号文件 ───────────────────────────────────────────────── */

/**
 * 令牌签名密钥。
 * 优先用环境变量（容器 / 多实例时更省事），否则在 data/ 下生成一个文件 ——
 * **不写进账号文件**：那文件是要被备份、贴进 issue 的，密钥不该跟着跑。
 */
async function loadSecret(options) {
  const opt = options || {};
  const file = opt.file;
  const env = opt.env === undefined ? process.env.WA_AUTH_SECRET : opt.env;
  const fromEnv = typeof env === 'string' ? env.trim() : '';
  if (fromEnv.length >= 32) return fromEnv;
  try {
    const existing = (await fsp.readFile(file, 'utf8')).trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* 还没有，下面生成 */
  }
  const secret = randomBytes(32).toString('hex');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
  return secret;
}

/**
 * 账号文件（一个 JSON，原子写入）。
 *
 * 为什么是文件而不是内存：账号是重启之后还得在的东西。
 * 为什么不是数据库：这个项目零依赖，几百个账号一个 JSON 完全够用（这个工具本来就是自用的）。
 */
function createUserStore(options) {
  const opt = options || {};
  const file = opt.file;
  const clock = typeof opt.clock === 'function' ? opt.clock : () => Date.now();
  let users = [];
  let loaded = false;

  const newId = () => `u_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;

  async function persist() {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const payload = { version: 1, users };
    // 先写临时文件再改名：中途崩了也不会留下半个 JSON（改名在同一分区上是原子的）
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fsp.rename(tmp, file);
  }

  /** 读盘。**文件坏了就抛错**，不静默重置（见文件头第 3 条底线） */
  async function load() {
    let raw;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        users = [];
        loaded = true;
        return;
      }
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw Object.assign(new Error(`账号文件不是合法 JSON：${file}`), { code: 'users_file_broken' });
    }
    if (!parsed || !Array.isArray(parsed.users)) {
      throw Object.assign(new Error(`账号文件结构不对（缺少 users 数组）：${file}`), { code: 'users_file_broken' });
    }
    users = parsed.users.filter((u) => u && typeof u.id === 'string' && typeof u.name === 'string');
    loaded = true;
  }

  const findByName = (name) => users.find((u) => u.nameKey === Rules.nameKey(name)) || null;

  return {
    file,

    async init() {
      if (!loaded) await load();
      return users.length;
    },
    get loaded() {
      return loaded;
    },
    count() {
      return users.length;
    },
    byId(id) {
      return users.find((u) => u.id === id) || null;
    },
    byName(name) {
      return findByName(name);
    },

    /** 注册。名字重名按**大小写不敏感**判（Alice / alice 是同一个人） */
    async register(input) {
      const raw = input || {};
      const checkedName = Rules.validateName(raw.name);
      if (!checkedName.ok) return { ok: false, code: 'bad_name', error: checkedName.error };
      const checkedPassword = Rules.validatePassword(raw.password, { name: checkedName.name });
      if (!checkedPassword.ok) return { ok: false, code: 'bad_password', error: checkedPassword.error };
      if (findByName(checkedName.name)) {
        return { ok: false, code: 'name_taken', error: '这个名字已经有人用了' };
      }

      // 恢复码：生成一次、只回给注册的这个人一次，落盘的是哈希
      const recoveryCode = makeRecoveryCode();
      const user = {
        id: newId(),
        name: checkedName.name,
        nameKey: Rules.nameKey(checkedName.name),
        createdAt: new Date(clock()).toISOString(),
        lastLoginAt: new Date(clock()).toISOString(),
        // 改密码会让它 +1：所有旧令牌立刻作废（见 server.js 的 currentUser）
        tokenVersion: 1,
        password: hashPassword(raw.password),
        recovery: hashRecovery(recoveryCode),
        avatar: Rules.normalizeAvatar(raw.avatar) || { kind: 'initial', color: null },
      };
      users.push(user);
      await persist();
      // 恢复码只在返回值里出现这一次，不进 user 记录之外的任何地方
      return { ok: true, user, recoveryCode };
    },

    /**
     * 登录校验。
     * 账号不存在时也照样算一遍 scrypt（拿假记录），耗时上分不出「有没有这个人」；
     * 对外一律回同样的 'invalid'，不告诉对方是名字错还是密码错。
     */
    async verify(input) {
      const raw = input || {};
      const user = findByName(Rules.normalizeName(raw.name));
      if (!user) {
        verifyPassword(raw.password, DUMMY_PASSWORD);
        return { ok: false, code: 'invalid', error: '名字或密码不对' };
      }
      if (!verifyPassword(raw.password, user.password)) {
        return { ok: false, code: 'invalid', error: '名字或密码不对' };
      }
      user.lastLoginAt = new Date(clock()).toISOString();
      await persist();
      return { ok: true, user };
    },

    /**
     * 用恢复码重置密码（找回密码的正路）。
     *
     * 三件事：
     *   · 恢复码对不上就**什么都不改**（跟登录一样，不告诉对方是名字错还是码错）；
     *   · 成功之后 `tokenVersion + 1` —— 忘了密码往往意味着「有台设备可能不干净」，
     *     顺手把别处的登录全作废；
     *   · **换一把新钥匙**：旧的恢复码当场作废，新的随返回值给出去一次。
     *     不换的话，一个被翻出来的旧恢复码就是永久后门。
     *
     * 老账号（没有恢复码的）回 `no_recovery`，界面上据此指到本机命令行那条路。
     */
    async recover(input) {
      const raw = input || {};
      const user = findByName(Rules.normalizeName(raw.name));
      if (!user) {
        verifyPassword(Rules.normalizeRecoveryCode(raw.code), DUMMY_PASSWORD);
        return { ok: false, code: 'invalid', error: '名字或恢复码不对' };
      }
      if (!user.recovery) {
        return { ok: false, code: 'no_recovery', error: '这个账号还没有恢复码（它是加恢复码之前注册的）。在本机运行 node scripts/reset-password.js 重置' };
      }
      if (!verifyRecovery(raw.code, user.recovery)) {
        return { ok: false, code: 'invalid', error: '名字或恢复码不对' };
      }
      const checked = Rules.validatePassword(raw.newPassword, { name: user.name });
      if (!checked.ok) return { ok: false, code: 'bad_password', error: checked.error };
      if (verifyPassword(raw.newPassword, user.password)) {
        return { ok: false, code: 'same_password', error: '新密码和原密码一样' };
      }

      const recoveryCode = makeRecoveryCode();
      user.password = hashPassword(raw.newPassword);
      user.recovery = hashRecovery(recoveryCode);
      user.tokenVersion = (Number(user.tokenVersion) || 1) + 1;
      user.recoveredAt = new Date(clock()).toISOString();
      await persist();
      return { ok: true, user, recoveryCode };
    },

    /**
     * 只在本机用的重置（`scripts/reset-password.js` 那个命令行）。
     * 它没有恢复码这道关 —— 它的凭证是「能在这台机器上读写 data/」这件事本身。
     * 参数里带 `reissueRecovery: true` 会顺手发一把新钥匙。
     */
    async forcePassword(name, newPassword, options) {
      const user = findByName(Rules.normalizeName(name));
      if (!user) return { ok: false, code: 'no_user', error: '没有这个账号' };
      const checked = Rules.validatePassword(newPassword, { name: user.name });
      if (!checked.ok) return { ok: false, code: 'bad_password', error: checked.error };
      const recoveryCode = (options && options.reissueRecovery === false) ? '' : makeRecoveryCode();
      user.password = hashPassword(newPassword);
      if (recoveryCode) user.recovery = hashRecovery(recoveryCode);
      user.tokenVersion = (Number(user.tokenVersion) || 1) + 1;
      user.recoveredAt = new Date(clock()).toISOString();
      await persist();
      return { ok: true, user, recoveryCode };
    },

    async setAvatar(id, avatar) {
      const user = users.find((u) => u.id === id);
      if (!user) return { ok: false, code: 'no_user' };
      user.avatar = Rules.normalizeAvatar(avatar) || { kind: 'initial', color: null };
      await persist();
      return { ok: true, user };
    },

    /**
     * 改密码。
     * 成功之后 tokenVersion +1 —— 别处还开着的页面会立刻失效（这正是改密码时想要的效果）。
     * 旧密码不对就不改（这一步不能省：不然拿到一台没锁屏的电脑就能把号占了）。
     */
    async setPassword(id, input) {
      const raw = input || {};
      const user = users.find((u) => u.id === id);
      if (!user) return { ok: false, code: 'no_user' };
      if (!verifyPassword(raw.oldPassword, user.password)) {
        return { ok: false, code: 'bad_old_password', error: '原密码不对' };
      }
      const checked = Rules.validatePassword(raw.newPassword, { name: user.name });
      if (!checked.ok) return { ok: false, code: 'bad_password', error: checked.error };
      if (verifyPassword(raw.newPassword, user.password)) {
        return { ok: false, code: 'same_password', error: '新密码和原密码一样' };
      }
      user.password = hashPassword(raw.newPassword);
      user.tokenVersion = (Number(user.tokenVersion) || 1) + 1;
      await persist();
      return { ok: true, user };
    },

    /**
     * 换名字。
     *
     * 三件事写清楚：
     *   · **查重要排除自己**，而且**必须排在「没变」之前** —— 顺序反了的话这段排除自己
     *     就成了永远走不到的死代码（判重键相同的情况会在上一行就返回掉）。
     *     排在前面它才是真的在干活：你换成自己现在的名字、或者只改个大小写，
     *     都不该被自己拦下一句「这个名字已经有人用了」。
     *   · **nameKey 要跟着改** —— 它才是判重用的那个键，忘了改等于旧名字还占着，
     *     新名字谁都能抢。
     *   · **不动 tokenVersion** —— 名字不是凭证，换了不该把别的设备踢下线
     *     （令牌里带的是 uid，不是名字）。
     *
     * 也不要密码：这是个纯显示用的名字，写错了再写回来就行。
     */
    async rename(id, newName) {
      const user = users.find((u) => u.id === id);
      if (!user) return { ok: false, code: 'no_user' };
      const checked = Rules.validateName(newName);
      if (!checked.ok) return { ok: false, code: 'bad_name', error: checked.error };

      const nextKey = Rules.nameKey(checked.name);
      if (users.some((u) => u.id !== id && u.nameKey === nextKey)) {
        return { ok: false, code: 'name_taken', error: '这个名字已经有人用了' };
      }
      // 一字不差就是没变（不写盘、界面也能说一句「名字没变」）
      if (checked.name === user.name) return { ok: true, user, unchanged: true };

      // 走到这儿就真的要改了。注意只改大小写也走这里：**名字按用户写的那样存**
      user.name = checked.name;
      user.nameKey = nextKey;
      user.renamedAt = new Date(clock()).toISOString();
      await persist();
      return { ok: true, user };
    },

    /** 只给测试与命令行用：把内存状态重新读一遍 */
    async reload() {
      loaded = false;
      await load();
      return users.length;
    },

    /**
     * 账号名录（**只给本机命令行用，不挂任何接口**）。
     * 只有名字、注册时间和「有没有恢复码」——没有 id、没有哈希。
     * 为什么不挂接口：一份能列出所有人的名单，在别人的电脑上就是一份靶子。
     */
    names() {
      return users.map((u) => ({
        name: u.name,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt || '',
        hasRecovery: Boolean(u.recovery),
      }));
    },
  };
}

module.exports = {
  TOKEN_COOKIE,
  TOKEN_TTL_MS,
  SCRYPT,
  LOCAL_OWNER,
  hashPassword,
  verifyPassword,
  makeRecoveryCode,
  hashRecovery,
  verifyRecovery,
  signToken,
  verifyToken,
  readCookie,
  sessionCookie,
  clearSessionCookie,
  createRateLimiter,
  ownsRecord,
  normalizeOwner,
  loadSecret,
  createUserStore,
};
