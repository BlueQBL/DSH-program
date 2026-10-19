/*!
 * 三易 · 智能写作台 —— 服务端（server.js）
 *
 * 零依赖：只做三件事。
 *   1. 托管 index.html / css / js / lib（静态文件）
 *   2. /api/generate 用 SSE 把「多个版本」逐字推给前端（有 Key 走上游，没 Key 走离线引擎）
 *   3. /api/polish 一键优化（朱批）、/api/history 历史留档、/api/auth 账号（可选）
 *
 * 用法：node server.js [端口]
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');

const Modes = require('./lib/modes.js');
const Prompt = require('./lib/prompt.js');
const Polisher = require('./lib/polisher.js');
const Llm = require('./lib/llm.js');
const HistoryStore = require('./lib/store.js');
const Template = require('./lib/template.js');
const TemplateStore = require('./lib/template-store.js');
const Auth = require('./lib/auth.js');
const AuthRules = require('./lib/auth-rules.js');

const ROOT = __dirname;
const VERSION = require('./package.json').version;
const BASE_PORT = Number(process.argv[2] || process.env.PORT || 5260);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.WA_DATA_DIR || path.join(ROOT, 'data');
const BODY_LIMIT = 1024 * 1024; // 1MB：一次生成最多四稿，够用
const OFFLINE_CHUNK = Modes.clamp(process.env.WA_OFFLINE_CHUNK || 7, 1, 200);
const OFFLINE_SPEED = Modes.clamp(process.env.WA_OFFLINE_SPEED === undefined ? 16 : process.env.WA_OFFLINE_SPEED, 0, 500);
const HEARTBEAT_MS = 15000;

const config = Llm.readConfig();
const models = Llm.createModelRegistry(config, { log: (line) => console.log('  ' + line) });
const history = HistoryStore.createStore({ dir: path.join(DATA_DIR, 'history') });
const templates = TemplateStore.createTemplateStore({ dir: path.join(DATA_DIR, 'templates') });

/* ── 账号（可选） ───────────────────────────────────────── */
const USERS_FILE = process.env.WA_USERS_FILE || path.join(DATA_DIR, 'users.json');
/** 令牌签名密钥：环境变量优先，否则落在 data/auth-secret（**不进账号文件**） */
const SECRET_FILE = process.env.WA_AUTH_SECRET_FILE || path.join(DATA_DIR, 'auth-secret');
const REGISTER_OPEN = process.env.WA_ALLOW_REGISTER !== '0';
const users = Auth.createUserStore({ file: USERS_FILE });
const loginLimiter = Auth.createRateLimiter({ max: 8, windowMs: 10 * 60 * 1000 });
let authSecret = '';
/** 账号文件坏了的话，这里放一句给人看的话（服务照常起，只有账号那几条路返回 503） */
let authBroken = null;
const AUTH_BROKEN =
  '账号文件读不了（data/users.json 可能坏了）。为了不把已有账号当成空，登录 / 注册暂时停用 —— 修好文件再重启即可，写作本身不受影响。';

/**
 * 把磁盘上的模板注册成板块。
 *
 * 为什么服务端也要注册：留档里存的是板块 id（`tpl_xxx`），而 Modes 对不认识的 id
 * 会退回第一个板块 —— 不注册的话，自定义模板写的稿子在列表里会被显示成「文章续写」。
 * 所以模板一变就重新注册。
 */
async function syncTemplates() {
  const list = await templates.all();
  Modes.setCustomTemplates(list);
  return list.length;
}

/* ── 离线引擎按需加载：没有这个文件时服务照样能起，只是报错更清楚 ── */
let offlineEngine = null;
function loadOfflineEngine() {
  if (offlineEngine) return offlineEngine;
  try {
    offlineEngine = require('./lib/mock-writer.js');
  } catch (err) {
    throw new Error('离线引擎 lib/mock-writer.js 不可用：' + err.message);
  }
  return offlineEngine;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/* ── 小工具 ─────────────────────────────────────────────── */
function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ── 账号：这次是谁在写 ─────────────────────────────────────
 *
 * 定位：**可选**。不登录就是原来那样（本地模式，留档写在 'local' 那一桶）；
 * 登录之后多出账号、头像，以及「按人分开的留档」。
 *
 * 安全上的三件事写在这一段里：
 *   · 令牌是 HMAC 签名的 HttpOnly Cookie（页面脚本读不到）；
 *   · 改密码会让 tokenVersion +1，别处开着的页面立刻失效；
 *   · 所有写操作都过一道同源检查（SameSite=Lax 之外的第二道）。
 */
async function initAuth() {
  try {
    authSecret = await Auth.loadSecret({ file: SECRET_FILE });
    const count = await users.init();
    console.log(`  账号：${count ? `${count} 个（登录可选）` : '还没有账号（登录 / 注册入口开着）'}`);
  } catch (err) {
    // 不退出进程：写作照常能用，坏的只是账号那几条路 ——
    // 而且**绝不能**顺手把文件当成空的（那等于让所有人重新注册一遍，见 lib/auth.js）
    authBroken = err;
    console.error(`\n  账号文件读不了：${err.message}`);
    console.error('  为了不把已有账号当成空，登录 / 注册暂时停用。写作本身不受影响。\n');
  }
}

/** 这次请求是 https 吗（决定要不要给 Cookie 加 Secure） */
function isSecure(req) {
  if (req.socket && req.socket.encrypted) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https';
}

/**
 * 同源检查：跨站发起的写操作一律拒掉。
 *
 * 为什么 Cookie 已经是 SameSite=Lax 还要这一道：SameSite 是浏览器的行为，
 * 而这个服务可能被套在各种反代后面 —— 第二道闸不依赖浏览器守规矩。
 * 没有 Origin 头（curl、脚本、测试客户端）放行：那不是「跨站」，是「不是浏览器」。
 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** 限速的键：**IP + 名字**。按名字而不是只按 IP，是为了让同一台机器上两个人互不连坐 */
function limitKey(req, name) {
  const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
  return `${ip}|${AuthRules.nameKey(name)}`;
}

/**
 * 当前登录的是谁。
 * 四道：有 Cookie、签名对且没过期、这个 id 还在、令牌版本和账号当前版本一致
 *（最后一条是「改密码之后别处立刻失效」的实现）。
 */
function currentUser(req) {
  if (!authSecret || authBroken) return null;
  const token = Auth.readCookie(req.headers.cookie, Auth.TOKEN_COOKIE);
  if (!token) return null;
  const payload = Auth.verifyToken(token, authSecret);
  if (!payload) return null;
  const user = users.byId(payload.uid);
  if (!user) return null;
  if ((Number(user.tokenVersion) || 1) !== (Number(payload.tv) || 1)) return null;
  return user;
}

/** 下发登录态。remember = 「记住我」（不带这个就是浏览器会话 Cookie，关掉窗口就没了） */
function startSession(req, res, user, options) {
  const remember = Boolean(options && options.remember);
  const now = Date.now();
  const token = Auth.signToken(
    { uid: user.id, tv: Number(user.tokenVersion) || 1, iat: now, exp: now + Auth.TOKEN_TTL_MS },
    authSecret
  );
  res.setHeader(
    'set-cookie',
    Auth.sessionCookie(token, {
      maxAgeSeconds: remember ? Math.floor(Auth.TOKEN_TTL_MS / 1000) : 0,
      secure: isSecure(req),
    })
  );
}

/** 需要登录的接口统一从这儿过 */
function requireUser(req, res) {
  if (authBroken) {
    json(res, 503, { ok: false, error: AUTH_BROKEN, code: 'auth_broken' });
    return null;
  }
  const user = currentUser(req);
  if (!user) {
    json(res, 401, { ok: false, error: '需要先登录', code: 'unauthorized' });
    return null;
  }
  return user;
}

/** 这篇稿子归谁：登录了是账号 id，没登录是 'local' */
function ownerOf(req) {
  const user = currentUser(req);
  return user ? user.id : Auth.LOCAL_OWNER;
}

/** 按主人取留档 —— 每个请求现算一次，接口里不再自己拼 */
function ownerScope(req) {
  return history.scope(ownerOf(req));
}

/* ── SSE ────────────────────────────────────────────────── */
function openSse(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let closed = false;
  const timer = setInterval(() => {
    if (!closed) {
      try {
        res.write(': ping\n\n');
      } catch {
        closed = true;
      }
    }
  }, HEARTBEAT_MS);

  const api = {
    send(event, data) {
      if (closed || res.writableEnded) return false;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        return true;
      } catch {
        closed = true;
        return false;
      }
    },
    get closed() {
      return closed || res.writableEnded;
    },
    end() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      try {
        res.end();
      } catch {
        /* 客户端已经走了 */
      }
    },
  };

  req.on('close', () => {
    closed = true;
    clearInterval(timer);
  });
  return api;
}

function sseFatal(res, req, message) {
  const sse = openSse(req, res);
  sse.send('fatal', { message });
  sse.end();
}


/* ── 生成：一个版本 ─────────────────────────────────────── */
async function runVersion(params, material, index, sse, signal, model, template) {
  const mode = Modes.getMode(params.mode);
  const angle = Modes.angleOf(mode, index);
  // 自定义模板的提示词由浏览器带来（模板库在服务端，但生成不依赖它）
  const templateName = template && template.name ? String(template.name).slice(0, 24) : '';

  if (config.live) {
    let buffer = '';
    try {
      const messages = Prompt.buildMessages(params, material, index, template);
      for await (const evt of Llm.streamChat({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: model || models.resolved,
        messages,
        temperature: params.creativity,
        maxTokens: params.tokens,
        signal,
      })) {
        if (evt.type !== 'delta') continue;
        buffer += evt.text;
        if (!sse.send('delta', { version: index, text: evt.text })) return null;
      }
      return { index, angleId: angle.id, angleLabel: angle.label, text: buffer.trim(), engine: 'live' };
    } catch (err) {
      if (signal.aborted) return null;
      // 单独一稿失败不拖垮整批：退回离线引擎把这一稿补上，并如实标注
      sse.send('version-note', {
        version: index,
        level: 'warn',
        message: `第 ${index + 1} 稿上游失败，已用离线引擎补上：${err.message}`,
      });
      if (buffer.trim()) {
        return { index, angleId: angle.id, angleLabel: angle.label, text: buffer.trim(), engine: 'live-partial' };
      }
    }
  }

  // 离线引擎：整篇先写好，再按节奏吐字，做出与真实模型一致的逐字观感
  const engine = loadOfflineEngine();
  const text = String(engine.compose(params, material, index, { templateName }) || '').trim();
  let sent = 0;
  while (sent < text.length) {
    if (sse.closed || signal.aborted) return null;
    const piece = text.slice(sent, sent + OFFLINE_CHUNK);
    sent += OFFLINE_CHUNK;
    if (!sse.send('delta', { version: index, text: piece })) return null;
    if (OFFLINE_SPEED > 0) await sleep(OFFLINE_SPEED);
  }
  return { index, angleId: angle.id, angleLabel: angle.label, text, engine: 'offline' };
}

async function handleGenerate(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return json(res, 400, { ok: false, message: err.message });
  }

  const params = Modes.normalizeParams(body.params || body);
  const material = { input: String((body.material && body.material.input) || '').slice(0, Modes.LIMITS.inputMax) };
  if (!material.input.trim()) {
    return json(res, 400, { ok: false, message: '先写点什么再起稿' });
  }
  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());

  const sse = openSse(req, res);
  const startedAt = Date.now();
  const mode = Modes.getMode(params.mode);
  const plan = [];
  for (let i = 0; i < params.versions; i += 1) {
    const angle = Modes.angleOf(mode, i);
    plan.push({ index: i, angleId: angle.id, angleLabel: angle.label });
  }

  // 页面上选的模型只管这一次请求；不在可用列表里就退回默认，并在界面上说明
  const picked = models.resolveModel(body.model);
  // 自定义模板的提示词随请求带来（长度在这里收口，别让提示词无上限）
  const template = body.template && typeof body.template === 'object'
    ? {
        id: String(body.template.id || '').slice(0, 40),
        name: String(body.template.name || '').slice(0, Modes.LIMITS.templateNameMax),
        system: String(body.template.system || '').slice(0, Modes.LIMITS.templateSystemMax),
        outputHint: String(body.template.outputHint || '').slice(0, Modes.LIMITS.templateNoteMax),
      }
    : null;
  // 离线引擎要靠模板名把「离线做不了这个模板」那段说明写对（写不出名字时会退回「自定义模板」）
  if (template && template.name) params.templateName = template.name;

  sse.send('meta', {
    requestId: 'r' + startedAt.toString(36),
    engine: config.live ? 'live' : 'offline',
    engineNote: config.reason,
    model: config.live ? picked.model : '离线引擎',
    modelNote: picked.note,
    mode: params.mode,
    params,
    template: template ? { id: template.id, name: template.name } : null,
    versions: plan,
  });

  let results;
  try {
    results = await Promise.all(
      plan.map((p) => runVersion(params, material, p.index, sse, ctrl.signal, picked.model, template))
    );
  } catch (err) {
    sse.send('fatal', { message: err.message });
    sse.end();
    return;
  }
  if (sse.closed) return;

  const done = results.filter(Boolean).map((v) => ({
    index: v.index,
    angleId: v.angleId,
    angleLabel: v.angleLabel,
    chars: v.text.length,
    engine: v.engine,
    text: v.text,
  }));
  const failed = plan.filter((p) => !results.some((r) => r && r.index === p.index)).map((p) => p.index);

  if (!done.length) {
    sse.send('fatal', { message: '这一批没生成出内容，请换个说法或稍后再试' });
    sse.end();
    return;
  }

  sse.send('done', {
    elapsedMs: Date.now() - startedAt,
    versions: done,
    failed,
    engine: config.live ? 'live' : 'offline',
  });
  sse.end();
}

/* ── 一键优化 ───────────────────────────────────────────── */
async function handlePolish(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return json(res, 400, { ok: false, message: err.message });
  }

  const before = String(body.text || '').trim();
  if (!before) return json(res, 400, { ok: false, message: '没有可优化的文字' });
  if (before.length > Modes.LIMITS.inputMax) {
    return json(res, 400, { ok: false, message: `一次最多校对 ${Modes.LIMITS.inputMax} 字` });
  }

  let polished = '';
  let rewrites = [];
  let engine = 'offline';
  let note = '';
  const picked = models.resolveModel(body.model);
  if (picked.note) note = picked.note;

  if (config.live) {
    try {
      const result = await Llm.chatOnce({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: picked.model,
        messages: [
          { role: 'system', content: Prompt.polishSystem() },
          { role: 'user', content: Prompt.polishUser(before, { focus: body.focus }) },
        ],
        temperature: 0.2,
        maxTokens: Math.min(4000, Math.round(before.length * 2.4) + 600),
        jsonMode: true,
      });
      const parsed = Polisher.parseReply(result.text, before);
      polished = parsed.polished;
      rewrites = parsed.rewrites;
      engine = 'live';
      if (!parsed.parsed) note = '上游没有按 JSON 返回，已按纯文本处理，朱批由差异比对得出';
    } catch (err) {
      note = '上游失败，已改用离线校对：' + err.message;
    }
  }

  if (!polished) {
    const engineMod = loadOfflineEngine();
    const out = engineMod.polish(before);
    polished = String((out && out.polished) || before).trim();
    rewrites = (out && out.rewrites) || [];
    engine = 'offline';
  }

  const edits = Polisher.mergeEdits(before, rewrites, polished);
  const stat = Polisher.stats(edits);
  return json(res, 200, {
    ok: true,
    engine,
    model: engine === 'live' ? picked.model : '离线引擎',
    note,
    before,
    polished,
    edits,
    stats: stat,
    changed: stat.total > 0,
  });
}

/* ── 历史 ───────────────────────────────────────────────── */
/**
 * 留档按主人分开：登录了看到的是自己的，没登录看到的是本地模式那一桶。
 * 每个方法都从 ownerScope(req) 里拿 —— 「传错主人的稿子 id」在那一层就已经取不到了。
 */
async function handleHistory(req, res, url, method) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api','history', id? , 'export'?]
  const id = parts[2] && parts[2] !== 'export' && parts[2] !== 'claim' ? decodeURIComponent(parts[2]) : '';
  const store = ownerScope(req);

  if (method === 'POST' && parts[2] === 'claim') {
    const claimed = await store.claimLocal();
    return json(res, 200, { ok: true, claimed });
  }

  if (method === 'GET' && parts[2] === 'export') {
    const format = ['md', 'txt', 'json'].includes(url.searchParams.get('format'))
      ? url.searchParams.get('format')
      : 'md';
    const out = await store.exportAll(format, {
      mode: url.searchParams.get('mode') || 'all',
      q: url.searchParams.get('q') || '',
      starred: url.searchParams.get('starred') === '1',
    });
    res.writeHead(200, {
      'content-type': out.mime,
      'content-disposition': `attachment; filename="writing-${Date.now()}.${out.ext}"`,
      'cache-control': 'no-store',
    });
    res.end(out.body);
    return;
  }

  if (method === 'GET' && id) {
    const record = await store.get(id);
    if (!record) return json(res, 404, { ok: false, message: '这篇稿子已经不在了' });
    return json(res, 200, { ok: true, record });
  }

  if (method === 'GET') {
    const list = await store.list({
      mode: url.searchParams.get('mode') || 'all',
      q: url.searchParams.get('q') || '',
      starred: url.searchParams.get('starred') === '1',
      limit: Number(url.searchParams.get('limit')) || 50,
      offset: Number(url.searchParams.get('offset')) || 0,
    });
    // 登录之后顺手告诉界面「没登录时写的那 N 篇还在」，它才好说清去哪儿找
    const owners = await history.owners();
    const localElsewhere = store.owner === Auth.LOCAL_OWNER ? 0 : owners[Auth.LOCAL_OWNER] || 0;
    return json(res, 200, Object.assign({ ok: true }, list, { localElsewhere }));
  }

  if (method === 'POST') {
    try {
      const body = await readBody(req);
      const record = await store.create(body.record || body);
      return json(res, 201, { ok: true, record });
    } catch (err) {
      return json(res, 400, { ok: false, message: err.message });
    }
  }

  if (method === 'PATCH') {
    if (!id) return json(res, 400, { ok: false, message: '缺少稿子 id' });
    const body = await readBody(req).catch(() => ({}));
    const record = await store.update(id, body);
    if (!record) return json(res, 404, { ok: false, message: '这篇稿子已经不在了' });
    return json(res, 200, { ok: true, record });
  }

  if (method === 'DELETE') {
    // 清空必须显式带上 confirm，避免误触把留档全删了
    if (!id) {
      const confirmed = url.searchParams.get('confirm') === '1';
      if (!confirmed) return json(res, 400, { ok: false, message: '清空留档需要 confirm=1' });
      const removed = await store.clear();
      return json(res, 200, { ok: true, removed });
    }
    const okDelete = await store.remove(id);
    if (!okDelete) return json(res, 404, { ok: false, message: '这篇稿子已经不在了' });
    return json(res, 200, { ok: true, id });
  }

  return json(res, 405, { ok: false, message: '不支持的方法' });
}

/* ── 账号 ───────────────────────────────────────────────── */
/**
 * 这几条路的形状都一样：同源检查（在路由入口统一做）→ 读体 → 干事 → 回 publicUser。
 * 「谁能注册」由 WA_ALLOW_REGISTER 控制；「谁能登录」由 data/users.json 决定。
 */
async function handleAuth(req, res, url, method) {
  const path = url.pathname;

  // 当前登录的是谁。没登录也回 200（user: null）—— 这不是错误，是「本地模式」
  if (path === '/api/auth/me' && method === 'GET') {
    return json(res, 200, {
      ok: true,
      user: AuthRules.publicUser(currentUser(req)),
      registerOpen: REGISTER_OPEN,
      authError: authBroken ? AUTH_BROKEN : null,
    });
  }

  if (path === '/api/auth/register' && method === 'POST') {
    if (authBroken) return json(res, 503, { ok: false, error: AUTH_BROKEN, code: 'auth_broken' });
    if (!REGISTER_OPEN) {
      return json(res, 403, { ok: false, error: '这台服务关了注册（WA_ALLOW_REGISTER=0）', code: 'register_closed' });
    }
    const body = await readBody(req).catch(() => ({}));
    const key = limitKey(req, body.name);
    const gate = loginLimiter.check(key);
    if (!gate.allowed) {
      return json(res, 429, {
        ok: false,
        error: `试得有点频繁，请等 ${Math.ceil(gate.retryAfterMs / 1000)} 秒再试`,
        code: 'rate_limited',
      });
    }
    const result = await users.register({ name: body.name, password: body.password, avatar: body.avatar });
    if (!result.ok) {
      loginLimiter.fail(key);
      return json(res, 400, { ok: false, error: result.error, code: result.code });
    }
    loginLimiter.succeed(key);
    startSession(req, res, result.user, { remember: body.remember === true });
    // 恢复码只在这一次响应里出现：界面必须当场让用户抄下来，服务端也存不回来
    return json(res, 200, { ok: true, user: AuthRules.publicUser(result.user), recoveryCode: result.recoveryCode });
  }

  if (path === '/api/auth/recover' && method === 'POST') {
    if (authBroken) return json(res, 503, { ok: false, error: AUTH_BROKEN, code: 'auth_broken' });
    const body = await readBody(req).catch(() => ({}));
    const key = limitKey(req, body.name);
    const gate = loginLimiter.check(key);
    if (!gate.allowed) {
      return json(res, 429, {
        ok: false,
        error: `试得有点频繁，请等 ${Math.ceil(gate.retryAfterMs / 1000)} 秒再试`,
        code: 'rate_limited',
      });
    }
    const result = await users.recover({ name: body.name, code: body.code, newPassword: body.newPassword });
    if (!result.ok) {
      loginLimiter.fail(key);
      return json(res, result.code === 'no_recovery' ? 409 : 400, {
        ok: false,
        error: result.error,
        code: result.code,
      });
    }
    loginLimiter.succeed(key);
    // 恢复成功就等于登录成功：别的设备上的旧票已经作废，这里给这张补一张新的
    startSession(req, res, result.user, { remember: body.remember === true });
    return json(res, 200, { ok: true, user: AuthRules.publicUser(result.user), recoveryCode: result.recoveryCode });
  }

  if (path === '/api/auth/login' && method === 'POST') {
    if (authBroken) return json(res, 503, { ok: false, error: AUTH_BROKEN, code: 'auth_broken' });
    const body = await readBody(req).catch(() => ({}));
    const key = limitKey(req, body.name);
    const gate = loginLimiter.check(key);
    if (!gate.allowed) {
      return json(res, 429, {
        ok: false,
        error: `试得有点频繁，请等 ${Math.ceil(gate.retryAfterMs / 1000)} 秒再试`,
        code: 'rate_limited',
      });
    }
    const result = await users.verify({ name: body.name, password: body.password });
    if (!result.ok) {
      loginLimiter.fail(key);
      return json(res, 401, { ok: false, error: result.error, code: result.code });
    }
    loginLimiter.succeed(key);
    startSession(req, res, result.user, { remember: body.remember === true });
    return json(res, 200, { ok: true, user: AuthRules.publicUser(result.user) });
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    // 退出只是把浏览器手里那张票作废。**留档一个字节都不动** ——
    // 退出之后回到的是「本地模式」那一桶，不是空的。
    res.setHeader('set-cookie', Auth.clearSessionCookie());
    return json(res, 200, { ok: true, user: null });
  }

  if (path === '/api/auth/avatar' && method === 'POST') {
    const user = requireUser(req, res);
    if (!user) return undefined;
    const body = await readBody(req).catch(() => ({}));
    const result = await users.setAvatar(user.id, body.avatar);
    if (!result.ok) return json(res, 400, { ok: false, error: '换头像失败', code: result.code });
    return json(res, 200, { ok: true, user: AuthRules.publicUser(result.user) });
  }

  if (path === '/api/auth/name' && method === 'POST') {
    const user = requireUser(req, res);
    if (!user) return undefined;
    const body = await readBody(req).catch(() => ({}));
    // 名字不是凭证：改它**不动 tokenVersion**，别处开着的页面照常待着
    const result = await users.rename(user.id, body.name);
    if (!result.ok) {
      return json(res, result.code === 'no_user' ? 401 : 400, {
        ok: false,
        error: result.error,
        code: result.code,
      });
    }
    return json(res, 200, { ok: true, user: AuthRules.publicUser(result.user), unchanged: result.unchanged === true });
  }

  if (path === '/api/auth/password' && method === 'POST') {
    const user = requireUser(req, res);
    if (!user) return undefined;
    const body = await readBody(req).catch(() => ({}));
    const result = await users.setPassword(user.id, {
      oldPassword: body.oldPassword,
      newPassword: body.newPassword,
    });
    if (!result.ok) return json(res, 400, { ok: false, error: result.error, code: result.code });
    // 改密码会让 tokenVersion +1（别处的旧令牌立刻失效），
    // 所以**要给自己补发一张新的** —— 否则「改完密码就被踢出去」，用户会以为改坏了。
    startSession(req, res, result.user, { remember: body.remember === true });
    return json(res, 200, { ok: true, user: AuthRules.publicUser(result.user) });
  }

  return json(res, 404, { ok: false, message: '没有这个接口：' + path });
}

/* ── 自定义模板 ─────────────────────────────────────────── */
/**
 * 模板库。生成时用的是浏览器随请求带来的提示词，这里的落盘是为了「关掉浏览器还在」，
 * 顺带让服务端能把模板注册成板块（留档里显示的名字与稿签才对得上）。
 *
 * **模板是共用的，不按账号分**：它是一套「怎么写」的预设，不是谁的私密内容。
 * 留档才是按人分开的。这样登录之后，你自己刚建的那个模板不会突然看不见。
 */
async function handleTemplates(req, res, url, method) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api','templates', id?]
  const id = parts[2] ? decodeURIComponent(parts[2]) : '';

  if (method === 'GET' && id) {
    const tpl = await templates.get(id);
    if (!tpl) return json(res, 404, { ok: false, message: '这个模板已经不在了' });
    return json(res, 200, { ok: true, template: tpl });
  }

  if (method === 'GET') {
    const out = await templates.list({ q: url.searchParams.get('q') || '' });
    return json(res, 200, {
      ok: true,
      total: out.total,
      items: out.items,
      templates: out.records,
      limit: Template.LIMITS.count,
    });
  }

  if (method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return json(res, 400, { ok: false, message: err.message });
    }
    const tpl = body.template || body;
    const check = Template.validateTemplate(tpl);
    if (!check.ok) return json(res, 400, { ok: false, field: check.field, message: check.message });
    try {
      const saved = await templates.create(check.template);
      await syncTemplates();
      return json(res, 201, { ok: true, template: saved });
    } catch (err) {
      return json(res, 400, { ok: false, message: err.message });
    }
  }

  if (method === 'PATCH') {
    if (!id) return json(res, 400, { ok: false, message: '缺少模板 id' });
    const body = await readBody(req).catch(() => ({}));
    const merged = Object.assign({}, await templates.get(id), body.template || body);
    if (!merged.id) return json(res, 404, { ok: false, message: '这个模板已经不在了' });
    const check = Template.validateTemplate(merged);
    if (!check.ok) return json(res, 400, { ok: false, field: check.field, message: check.message });
    const saved = await templates.update(id, check.template);
    if (!saved) return json(res, 404, { ok: false, message: '这个模板已经不在了' });
    await syncTemplates();
    return json(res, 200, { ok: true, template: saved });
  }

  if (method === 'DELETE') {
    if (!id) return json(res, 400, { ok: false, message: '缺少模板 id' });
    const removed = await templates.remove(id);
    if (!removed) return json(res, 404, { ok: false, message: '这个模板已经不在了' });
    await syncTemplates();
    return json(res, 200, { ok: true, id });
  }

  return json(res, 405, { ok: false, message: '不支持的方法' });
}

/* ── 引擎自检 ───────────────────────────────────────────── */
async function handleEngineTest(req, res) {
  if (!config.live) {
    return json(res, 200, {
      ok: true,
      engine: 'offline',
      message: config.reason,
      model: '离线引擎',
    });
  }
  const out = await models.list(true);
  return json(res, 200, {
    ok: out.ok,
    engine: 'live',
    model: models.resolved,
    configured: config.model,
    baseUrl: config.baseUrl,
    verified: models.verified,
    modelAvailable: out.ok ? out.all.includes(models.resolved) : null,
    total: out.ok ? out.all.length : 0,
    chat: out.ok ? out.chat.slice(0, 60) : [],
    message: out.ok ? '' : out.error,
  });
}

/* ── 模型列表 ───────────────────────────────────────────── */
/**
 * 页面上那个模型下拉框的数据源。
 * 拿不到列表不算错误：返回 ok:false 加一句人话，界面显示「只用一个默认模型」。
 */
async function handleModels(req, res, url) {
  const force = url.searchParams.get('refresh') === '1';
  if (!config.live) {
    return json(res, 200, {
      ok: true,
      live: false,
      engine: 'offline',
      current: '离线引擎',
      default: '',
      models: [],
      total: 0,
      note: config.reason,
    });
  }
  const out = await models.list(force);
  return json(res, 200, {
    ok: out.ok,
    live: true,
    engine: 'live',
    baseUrl: config.baseUrl,
    default: config.model,
    current: models.resolved,
    verified: models.verified,
    configured: Boolean(process.env.AI_MODEL || process.env.OPENAI_MODEL),
    models: out.ok ? out.chat : [],
    total: out.ok ? out.all.length : 0,
    cached: Boolean(out.cached),
    note: out.ok ? models.note || '' : out.error || '取不到模型列表，将直接使用默认模型',
  });
}

/* ── 静态文件 ───────────────────────────────────────────── */
const DENY_DIRS = ['data', 'test', 'node_modules'];

/**
 * 服务端专用代码不给浏览器取。
 *
 * lib/ 里大部分是前后端共用的纯函数（modes / record / polisher / mock-writer），
 * 但上游接入与留档落盘只在服务端跑：浏览器既不需要，也就不必让它读走
 * （读走本身不会漏 Key，但「浏览器能取到的东西里不含鉴权代码」是一条值得守住的不变量）。
 */
const DENY_FILES = ['server.js', 'lib/llm.js', 'lib/store.js', 'lib/template-store.js', 'lib/auth.js'];

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel);
  const inside = file === ROOT || file.startsWith(ROOT + path.sep);
  const blocked =
    DENY_DIRS.some((d) => rel === d || rel.startsWith(d + '/')) || DENY_FILES.indexOf(rel) >= 0;

  if (!inside || blocked) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('403 不允许访问');
    return;
  }

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 找不到 ' + rel);
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

/* ── 路由 ───────────────────────────────────────────────── */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || HOST}`);
  const method = (req.method || 'GET').toUpperCase();

  if (!url.pathname.startsWith('/api/')) {
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('405 只支持 GET');
      return;
    }
    serveStatic(req, res, url);
    return;
  }

  try {
    // 同源检查拦在写操作的最前面（GET/HEAD 不改东西，也就不必挡）。
    // 放在这里而不是每个接口各写一遍：漏掉一处就是一个能被跨站利用的写口子。
    if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(req)) {
      return json(res, 403, { ok: false, message: '跨站请求被拒绝' });
    }

    if (url.pathname === '/api/health' && method === 'GET') {
      return json(res, 200, {
        ok: true,
        app: Modes.APP.id,
        name: `${Modes.APP.name} · ${Modes.APP.subtitle}`,
        version: VERSION,
        engine: {
          live: config.live,
          model: config.live ? models.resolved : '离线引擎',
          baseUrl: config.live ? config.baseUrl : '',
          note: config.reason,
          verified: models.verified,
        },
        models: {
          total: models.cache.all.length,
          chat: models.cache.chat.length,
        },
        modes: Modes.MODES.map((m) => ({ id: m.id, name: m.name, mark: m.mark })),
        // 这里报的是**当前这个人**的留档数：登录之后看见的就是自己的那些
        history: { count: await ownerScope(req).count() },
        accounts: { count: users.count(), registerOpen: REGISTER_OPEN, broken: Boolean(authBroken) },
      });
    }
    if (url.pathname === '/api/auth/me' || url.pathname.startsWith('/api/auth/')) {
      return handleAuth(req, res, url, method);
    }
    if (url.pathname === '/api/models' && method === 'GET') return handleModels(req, res, url);
    if (url.pathname === '/api/templates' || url.pathname.startsWith('/api/templates/')) {
      return handleTemplates(req, res, url, method);
    }
    if (url.pathname === '/api/engine/test' && method === 'GET') return handleEngineTest(req, res);
    if (url.pathname === '/api/generate' && method === 'POST') return handleGenerate(req, res);
    if (url.pathname === '/api/polish' && method === 'POST') return handlePolish(req, res);
    if (url.pathname === '/api/history' || url.pathname.startsWith('/api/history/')) {
      return handleHistory(req, res, url, method);
    }
    return json(res, 404, { ok: false, message: '没有这个接口：' + url.pathname });
  } catch (err) {
    console.error('[error]', req.method, url.pathname, err && err.stack ? err.stack : err);
    if (res.headersSent) {
      try {
        res.end();
      } catch {
        /* 已经断开 */
      }
      return;
    }
    return json(res, 500, { ok: false, message: (err && err.message) || '服务端出错了' });
  }
});

/* ── 启动 ───────────────────────────────────────────────── */
function banner(actualPort, probed) {
  const where = `http://${HOST}:${actualPort}/`;
  console.log(`${Modes.APP.name} · ${Modes.APP.subtitle} 已启动：${where}`);
  if (config.live) {
    console.log(`  成稿方式：已接入上游模型，当前用 ${models.resolved}`);
    console.log(`  上游地址：${config.baseUrl}`);
    if (config.model !== models.resolved) console.log(`  配置的模型：${config.model}（探测时发现调不通，已换）`);
    if (probed && probed.verified) {
      console.log('  页面右上角可以随时换模型；探测结果有 5 分钟缓存');
    } else if (probed && probed.note) {
      console.log(`  ⚠ ${probed.note}`);
      console.log(`  仍会用 ${models.resolved} 尝试；也可以先跑 GET /api/engine/test 看细节`);
    }
  } else {
    console.log(`  成稿方式：${config.reason}`);
    console.log('  接入真实模型：设置 DEEPSEEK_API_KEY 或 OPENAI_API_KEY 后重启');
    console.log('  别家平台（中转、聚合）的 Key 还要设地址：AI_BASE_URL 或 OPENAI_BASE_URL（可选 AI_MODEL / OPENAI_MODEL）');
  }
  console.log('  留档目录：' + path.join(DATA_DIR, 'history'));
  console.log('  模板目录：' + path.join(DATA_DIR, 'templates'));
  if (authBroken) console.log('  账号：读不了账号文件，登录 / 注册暂时停用（写作不受影响）');
  else if (REGISTER_OPEN) console.log('  账号文件：' + USERS_FILE + '（登录可选；不想让人注册就设 WA_ALLOW_REGISTER=0）');
  else console.log('  账号文件：' + USERS_FILE + '（已关闭注册，只能登录已有账号）');
  console.log('  按 Ctrl+C 停止。');
}

/**
 * 启动服务。测试里用 port=0 拿随机端口，所以这里把「监听」和「建服务」分开。
 *
 * 监听之后、打印横幅之前先探测一次上游：默认模型在中转平台上不一定存在，
 * 与其让第一个起稿的用户白等十几秒，不如开机就问清楚哪个模型能用。
 */
function start(options) {
  const opt = options || {};
  const want = opt.port === undefined ? BASE_PORT : Number(opt.port);
  let attempt = want;

  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE' && want !== 0 && attempt - want < 10) {
        console.warn(`端口 ${attempt} 已被占用，改用 ${attempt + 1}。`);
        attempt += 1;
        server.listen(attempt, HOST);
        return;
      }
      server.removeListener('error', onError);
      reject(err);
    };
    server.on('error', onError);
    server.once('listening', async () => {
      server.removeListener('error', onError);
      const actual = server.address().port;

      // 顺序有讲究：先把模板注册成板块，再加载留档 —— 留档里的板块 id
      // （tpl_xxx）要能解析出对应的名字与稿签，否则自定义模板写的稿子会被显示成「文章续写」。
      let templateCount = 0;
      try {
        templateCount = await syncTemplates();
      } catch (err) {
        console.warn('[templates] 初始化失败：' + err.message);
      }
      await history.ready().catch((err) => console.warn('[history] 初始化失败：' + err.message));
      // 账号在留档之后初始化：它读的是 data/users.json，坏了也不该挡住写作
      await initAuth();

      let probed = null;
      if (config.live && opt.probe !== false) {
        if (opt.banner !== false) console.log('  正在探测可用的上游模型……');
        probed = await models.probe().catch((err) => ({ ok: false, note: err.message }));
      }
      if (opt.banner !== false) {
        if (templateCount) console.log(`  自定义模板：${templateCount} 个（已注册成板块）`);
        banner(actual, probed);
      }
      resolve({
        port: actual,
        url: `http://${HOST}:${actual}/`,
        models,
        templates,
        probe: probed,
        close: () => new Promise((r) => server.close(r)),
      });
    });
    server.listen(attempt, HOST);
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error('启动失败：' + err.message);
    process.exit(1);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log('\n正在停止……');
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1500);
    });
  }
}

module.exports = {
  server,
  start,
  config,
  models,
  templates,
  history,
  users,
  loginLimiter,
  syncTemplates,
  ROOT,
  DATA_DIR,
  USERS_FILE,
  sseFatal,
};

