// 账号体系的**服务端**那一半：密码哈希、令牌签名、登录限速、账号文件。
//
// 全程只用 node:crypto 和 node:fs —— 这个项目零依赖，认证也不破例。
//
// 三条底线（每一条都有对应的测试和变异）：
//   1. **密码永不明文落盘**：scrypt 加随机盐，只存哈希和参数；
//      比较用 timingSafeEqual（`===` 会在第一个不同的字节上早退，把哈希一个字节一个字节地漏出去）。
//   2. **令牌是自己签的**：HMAC-SHA256，带过期时间；签名不对 / 过期 / 账号被改过密码，一律作废。
//   3. **账号文件坏了就报错，绝不当作空**：静默从零开始等于把所有人的账号清空，
//      而且谁都能拿原来的名字重新注册一遍 —— 比服务起不来严重得多。
//
// 名字 / 密码 / 头像的规则在 `public/lib/auth-rules.js`：那份**浏览器和服务端共用**，
// 所以「前端拦不住的，后端也拦得住」不靠人记得同步（见那个文件的头注释）。

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  nameKey,
  normalizeAvatar,
  normalizeName,
  publicUser,
  validateName,
  validatePassword,
} from '../public/lib/auth-rules.js';

/** 会话 Cookie 的名字。改名等于把所有已登录的人踢下线 */
export const TOKEN_COOKIE = 'duitanlu_session';

/** 令牌有效期：记住我 30 天，不记住就是这个浏览器会话（见 sessionCookie 的 maxAge） */
export const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * scrypt 参数。
 * N=16384 是「本地服务端够用、又不至于让每次登录卡住」的档位（一次约几十毫秒）。
 * 参数**跟着每条记录存下来**：以后要调高，老记录照样能验证，不用逼所有人改密码。
 */
export const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** 用随机盐算一次密码哈希。返回值整体就是「密码记录」，直接存进用户条目 */
export function hashPassword(password, { salt = randomBytes(16).toString('hex') } = {}) {
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
 * 而不是抛异常 —— 认证路径上「异常」和「失败」必须走同一出口，否则一个坏记录就能 500 掉整个登录接口。
 */
export function verifyPassword(password, record) {
  if (!record || typeof record !== 'object') return false;
  if (typeof record.salt !== 'string' || typeof record.hash !== 'string') return false;
  if (!record.salt || !record.hash) return false;

  let expected;
  try {
    expected = Buffer.from(record.hash, 'hex');
  } catch {
    return false;
  }
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

// ---------------------------------------------------------------- 令牌

/** 待验证的假记录：账号不存在时也照样算一遍，让「有没有这个人」在耗时上分不出来 */
const DUMMY_PASSWORD = hashPassword('duitanlu-dummy-password');

/**
 * 签一个令牌：`base64url(载荷).base64url(HMAC)`。
 * 载荷是**明文可读的**（uid / tv / iat / exp）—— 刻意不加密：里面没有秘密，
 * 而且出问题时能直接把它 base64 解开看一眼，比黑盒强。**能不能信全靠签名。**
 */
export function signToken(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body, secret)}`;
}

function sign(body, secret) {
  return createHmac('sha256', String(secret)).update(body).digest('base64url');
}

/**
 * 验令牌。返回载荷，或 null。
 * 四种情况都算 null：形状不对、签名不对、字段不全、过期。
 * `now` 可注入，测试和变异都要用它把「过期」摆到眼前。
 */
export function verifyToken(token, secret, { now = Date.now() } = {}) {
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
export function readCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return '';
}

/**
 * 下发会话 Cookie。
 *
 * HttpOnly：脚本读不到它（XSS 也偷不走）；
 * SameSite=Lax：跨站发起的 POST 不带它（这是防 CSRF 的第一道）；
 * Path=/：整个站点都要用；
 * Secure：只在 https 下加 —— 本机 http 加了就等于这条 Cookie 永远发不出去（登录看起来「成功」但立刻失效）。
 */
export function sessionCookie(token, { maxAgeSeconds = 0, secure = false } = {}) {
  const parts = [
    `${TOKEN_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (maxAgeSeconds > 0) parts.push(`Max-Age=${Math.floor(maxAgeSeconds)}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** 退出登录：把同一个 Cookie 用一个立刻过期的空值覆盖掉 */
export function clearSessionCookie() {
  return `${TOKEN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// ---------------------------------------------------------------- 登录限速

/**
 * 登录/注册的失败限速（内存里，进程重启即清零）。
 *
 * 为什么必须有：没有它，一个脚本可以对着 8 位密码安静地试一整夜。
 * 为什么不用「锁定账号」那套：那等于给了攻击者一个把别人锁在门外的开关 ——
 * 这里按 **IP + 名字** 计数，试错成本上去，正常用户换个拼写照常能进。
 */
export function createRateLimiter({ max = 8, windowMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
  /** key → 失败时刻数组（只留窗口内的） */
  const hits = new Map();

  const prune = (key, at) => {
    const list = (hits.get(key) ?? []).filter((t) => at - t < windowMs);
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

// ---------------------------------------------------------------- 用户之间的隔离

/**
 * 这条记录该不该给这个用户看。
 *
 * 兜底副本和快照都按**记录里的 userId** 判，而不是「按 sessionId 猜」——
 * sessionId 是客户端随便起的名字，光凭它认不出主人。
 * 没登录的人只能看 userId 为 'local' 的那些（本地模式写下的）。
 */
export function ownsRecord(record, user) {
  const owner = user?.id ?? 'local';
  return (record?.userId ?? 'local') === owner;
}

// ---------------------------------------------------------------- 账号文件

/**
 * 令牌签名密钥。
 * 优先用环境变量（多实例/容器里更省事），否则在 data/ 下生成一个只有本机用户能读的文件 ——
 * **不写进账号文件**：那文件是要被导出、备份、贴进 issue 的，密钥不该跟着跑。
 */
export async function loadSecret({ file, env = process.env.AI_AUTH_SECRET } = {}) {
  const fromEnv = typeof env === 'string' ? env.trim() : '';
  if (fromEnv.length >= 32) return fromEnv;
  try {
    const existing = (await readFile(file, 'utf8')).trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* 还没有，下面生成 */
  }
  const secret = randomBytes(32).toString('hex');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
  return secret;
}

/**
 * 账号文件（一个 JSON，原子写入）。
 *
 * 为什么是文件而不是内存：账号是重启之后还得在的东西。
 * 为什么不是数据库：这个项目零依赖，几百个账号一个 JSON 完全够用（这个工具本来就是自用的）。
 */
export function createUserStore({ file, clock = () => Date.now() } = {}) {
  let users = [];
  let loaded = false;

  const newId = () => `u_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;

  async function persist() {
    await mkdir(path.dirname(file), { recursive: true });
    const payload = { version: 1, users };
    // 先写临时文件再改名：中途崩了也不会留下半个 JSON（改名在同一分区上是原子的）
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
  }

  /** 读盘。**文件坏了就抛错**，不静默重置（见文件头第 3 条底线） */
  async function load() {
    let raw;
    try {
      raw = await readFile(file, 'utf8');
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

  const findByName = (name) => users.find((u) => u.nameKey === nameKey(name));

  return {
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
      return users.find((u) => u.id === id) ?? null;
    },
    byName(name) {
      return findByName(name) ?? null;
    },

    /** 注册。名字重名按**大小写不敏感**判（Alice / alice 是同一个人） */
    async register({ name, password, avatar = null }) {
      const checkedName = validateName(name);
      if (!checkedName.ok) return { ok: false, code: 'bad_name', error: checkedName.error };
      const checkedPassword = validatePassword(password, { name: checkedName.name });
      if (!checkedPassword.ok) return { ok: false, code: 'bad_password', error: checkedPassword.error };
      if (findByName(checkedName.name)) {
        return { ok: false, code: 'name_taken', error: '这个名字已经有人用了' };
      }

      const user = {
        id: newId(),
        name: checkedName.name,
        nameKey: nameKey(checkedName.name),
        createdAt: new Date(clock()).toISOString(),
        lastLoginAt: new Date(clock()).toISOString(),
        // 改密码会让它 +1：所有旧令牌立刻作废（见 server.mjs 的 currentUser）
        tokenVersion: 1,
        password: hashPassword(password),
        avatar: normalizeAvatar(avatar) ?? { kind: 'initial', color: null },
      };
      users.push(user);
      await persist();
      return { ok: true, user };
    },

    /**
     * 登录校验。
     * 账号不存在时也照样算一遍 scrypt（拿假记录），耗时上分不出「有没有这个人」；
     * 对外一律回同样的 'invalid'，不告诉对方是名字错还是密码错。
     */
    async verify({ name, password }) {
      const user = findByName(normalizeName(name));
      if (!user) {
        verifyPassword(password, DUMMY_PASSWORD);
        return { ok: false, code: 'invalid', error: '名字或密码不对' };
      }
      if (!verifyPassword(password, user.password)) {
        return { ok: false, code: 'invalid', error: '名字或密码不对' };
      }
      user.lastLoginAt = new Date(clock()).toISOString();
      await persist();
      return { ok: true, user };
    },

    async setAvatar(id, avatar) {
      const user = users.find((u) => u.id === id);
      if (!user) return { ok: false, code: 'no_user' };
      user.avatar = normalizeAvatar(avatar) ?? { kind: 'initial', color: null };
      await persist();
      return { ok: true, user };
    },

    /**
     * 改密码。
     * 成功之后 tokenVersion +1 —— 别处还开着的页面会立刻失效（这正是改密码时想要的效果）。
     * 旧密码不对就不改（这一步不能省：不然拿到一个没锁屏的电脑就能把号占了）。
     */
    async setPassword(id, { oldPassword, newPassword }) {
      const user = users.find((u) => u.id === id);
      if (!user) return { ok: false, code: 'no_user' };
      if (!verifyPassword(oldPassword, user.password)) {
        return { ok: false, code: 'bad_old_password', error: '原密码不对' };
      }
      const checked = validatePassword(newPassword, { name: user.name });
      if (!checked.ok) return { ok: false, code: 'bad_password', error: checked.error };
      if (verifyPassword(newPassword, user.password)) {
        return { ok: false, code: 'same_password', error: '新密码和原密码一样' };
      }
      user.password = hashPassword(newPassword);
      user.tokenVersion = (Number(user.tokenVersion) || 1) + 1;
      await persist();
      return { ok: true, user };
    },

    /** 只给测试用：把内存状态重新读一遍 */
    async reload() {
      loaded = false;
      await load();
      return users.length;
    },
  };
}
