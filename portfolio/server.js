/**
 * 个人作品集 · 静态服务器 + 访问统计 + 留言板
 *
 * 零依赖，只用 Node 内置模块。三件事：
 *   1. 发静态文件（无构建步骤）
 *   2. 访问统计：按天聚合 PV，UV 用不可逆哈希去重（不存原始 IP）
 *   3. 留言板：JSON 持久化，带蜜罐 / 频率限制 / 长度校验
 *
 *   node server.js              → http://localhost:5200
 *   node server.js 8080         → 换端口
 *   PORT=8080 node server.js
 *
 * 数据都在 data/ 目录里（明文 JSON，方便你自己看和备份）：
 *   data/store.json        主存储
 *   data/store.jsonl       每次写入的追加日志（崩了也能捞回来）
 *   data/secret            哈希访客身份用的随机盐（不要提交到仓库）
 *   data/admin-token       删留言用的令牌（首次启动自动生成并打印）
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const url = require('node:url');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 5200);
const HOST = process.env.HOST || '0.0.0.0';
// 数据目录可以用环境变量顶掉：冒烟测试就是靠这个写到临时目录，
// 绝不去碰真实的访问记录和留言。
const DATA_DIR = process.env.DSH_PORTFOLIO_DATA
  ? path.resolve(process.env.DSH_PORTFOLIO_DATA)
  : path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const LOG_FILE = path.join(DATA_DIR, 'store.jsonl');
const SECRET_FILE = path.join(DATA_DIR, 'secret');
const TOKEN_FILE = path.join(DATA_DIR, 'admin-token');

/* 展示与限制 */
const SHOW_DAYS = 14;
const MAX_MESSAGE = 500;
const MAX_NAME = 24;
const PAGE_SIZE = 8;
const RATE_WINDOW = 60000;      // 同一访客两次留言至少间隔（毫秒）
const RATE_MAX_PER_DAY = 8;     // 同一访客每天最多留言条数

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/* ---------------------------------------------------------------
   存储层：一个 JSON 文件 + 一行一条的追加日志
   --------------------------------------------------------------- */

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readSecret(name, bytes) {
  const file = path.join(DATA_DIR, name);
  try {
    const v = fs.readFileSync(file, 'utf8').trim();
    if (v) return v;
  } catch { /* 还没有，往下生成 */ }
  const v = crypto.randomBytes(bytes).toString('hex');
  try { fs.writeFileSync(file, v + '\n', { mode: 0o600 }); } catch { /* 只读文件系统 */ }
  return v;
}

function emptyStore() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    visits: { total: 0, days: {} },
    messages: [],
  };
}

function rebuildFromLog() {
  let raw = '';
  try { raw = fs.readFileSync(LOG_FILE, 'utf8'); } catch { return null; }
  const s = emptyStore();
  const deleted = [];
  let recovered = false;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    recovered = true;
    if (rec.t === 'visit' && rec.day) {
      const d = s.visits.days[rec.day] || (s.visits.days[rec.day] = { pv: 0, uv: 0, seen: [] });
      d.pv += 1;
      if (rec.uv && d.seen.indexOf(rec.uv) === -1) { d.seen.push(rec.uv); d.uv = d.seen.length; }
      s.visits.total += 1;
    } else if (rec.t === 'msg' && rec.msg) {
      s.messages.push(rec.msg);
    } else if (rec.t === 'del' && rec.id) {
      deleted.push(rec.id);            // 删过的留言不能因为重建又活过来
    }
  }

  if (deleted.length) {
    s.messages = s.messages.filter((m) => deleted.indexOf(m.id) === -1);
  }
  return recovered ? s : null;
}

function loadStore() {
  try {
    const obj = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (!obj.visits) obj.visits = { total: 0, days: {} };
    if (!obj.visits.days) obj.visits.days = {};
    if (!Array.isArray(obj.messages)) obj.messages = [];
    return { store: obj, recovered: false };
  } catch {
    // 没有 / 坏了：先从追加日志重建，实在没有就开新账
    const rebuilt = rebuildFromLog();
    return { store: rebuilt || emptyStore(), recovered: !!rebuilt };
  }
}

let store = emptyStore();
let SECRET = 'dev';
let ADMIN_TOKEN = '';
let writing = false;

function persist() {
  if (writing) return;
  writing = true;
  const tmp = STORE_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, STORE_FILE);          // 原子替换，写一半断电也不会坏
  } catch (e) {
    console.error('[portfolio] 写入 store.json 失败:', e.message);
  } finally {
    writing = false;
  }
}

function appendLog(rec) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(rec) + '\n');
  } catch { /* 日志写不了不影响主流程 */ }
}

/* ---------------------------------------------------------------
   小工具
   --------------------------------------------------------------- */

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

function sendJSON(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

function dayKey(d) {
  const dt = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
}

function sha(input) {
  return crypto.createHmac('sha256', SECRET).update(String(input)).digest('hex').slice(0, 32);
}

function clientIP(req) {
  // 放在 Nginx 之类的反代后面时，用 TRUST_PROXY=1 打开
  if (process.env.TRUST_PROXY === '1') {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || '0.0.0.0';
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体太大'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('不是合法的 JSON'), { code: 'BAD_JSON' }));
      }
    });
    req.on('error', reject);
  });
}

function cleanText(s, max) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')   // 控制字符
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

/** 明显的垃圾内容：太短、重复字符、乱码串、塞一堆链接 */
function isLowQuality(text) {
  const t = text.replace(/\s/g, '');
  if (t.length < 2) return true;
  if (/(.)\1{7,}/.test(t)) return true;
  if (/^[a-z0-9]{20,}$/i.test(t)) return true;
  if ((text.match(/https?:\/\//gi) || []).length >= 3) return true;
  return false;
}

/* ---------------------------------------------------------------
   访问统计
   --------------------------------------------------------------- */

function recordVisit(visitorId) {
  const day = dayKey();
  const d = store.visits.days[day] || (store.visits.days[day] = { pv: 0, uv: 0, seen: [] });

  d.pv += 1;
  store.visits.total += 1;

  const uid = sha(visitorId || 'anon');
  let isNew = false;
  if (d.seen.indexOf(uid) === -1) {
    d.seen.push(uid);
    isNew = true;
  }
  d.uv = d.seen.length;
  if (d.seen.length > 5000) d.seen = d.seen.slice(-5000);   // 只留当天的去重清单

  appendLog({ t: 'visit', day, uv: uid, at: new Date().toISOString() });
  persist();

  return { isNew };
}

function statsPayload() {
  const today = dayKey();
  const days = [];
  // 近 SHOW_DAYS 天（含今天），缺的日子补 0，前端拿去画趋势
  for (let i = SHOW_DAYS - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const k = dayKey(d);
    const rec = store.visits.days[k];
    days.push({ day: k, pv: rec ? rec.pv : 0, uv: rec ? rec.uv : 0 });
  }

  const todayRec = store.visits.days[today];
  let uvSum = 0;
  Object.keys(store.visits.days).forEach((k) => { uvSum += store.visits.days[k].uv || 0; });

  return {
    total: store.visits.total,
    today: todayRec ? todayRec.pv : 0,
    todayUv: todayRec ? todayRec.uv : 0,
    uvSum,
    dayCount: Object.keys(store.visits.days).length,
    messageCount: store.messages.length,
    since: store.createdAt ? store.createdAt.slice(0, 10) : today,
    days,
  };
}

/* ---------------------------------------------------------------
   留言板
   --------------------------------------------------------------- */

const rateLog = new Map();   // ipHash -> [时间戳]

function rateCheck(ipHash) {
  const now = Date.now();
  const list = (rateLog.get(ipHash) || []).filter((t) => now - t < 24 * 3600 * 1000);
  if (list.length) {
    const last = list[list.length - 1];
    if (now - last < RATE_WINDOW) {
      return { ok: false, error: 'RATE_WAIT', wait: Math.ceil((RATE_WINDOW - (now - last)) / 1000) };
    }
  }
  if (list.length >= RATE_MAX_PER_DAY) return { ok: false, error: 'RATE_DAY' };
  list.push(now);
  rateLog.set(ipHash, list);
  return { ok: true };
}

/** 对外只发这些字段：ipHash 永远不出网 */
function publicMessage(m) {
  return { id: m.id, name: m.name, text: m.text, at: m.at };
}

/* ---------------------------------------------------------------
   API
   --------------------------------------------------------------- */

async function handleAPI(req, res, pathname, query) {
  /* --- 记一次访问 --- */
  if (pathname === '/api/visit') {
    if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'METHOD' });
    let body = {};
    try { body = await readBody(req, 4096); } catch { /* 空请求体也算一次访问 */ }
    const r = recordVisit(body.visitorId);
    return sendJSON(res, 200, { ok: true, isNew: r.isNew, stats: statsPayload() });
  }

  /* --- 读统计 --- */
  if (pathname === '/api/stats') {
    if (req.method !== 'GET') return sendJSON(res, 405, { ok: false, error: 'METHOD' });
    return sendJSON(res, 200, { ok: true, stats: statsPayload() });
  }

  /* --- 留言板 --- */
  if (pathname === '/api/guestbook') {
    if (req.method === 'GET') {
      const total = store.messages.length;
      const offset = Math.max(0, Math.min(Number(query.offset) || 0, total));
      const limit = Math.max(1, Math.min(Number(query.limit) || PAGE_SIZE, 50));
      const ordered = store.messages.slice().reverse();       // 最新的在前
      const page = ordered.slice(offset, offset + limit);
      return sendJSON(res, 200, {
        ok: true,
        total,
        offset,
        limit,
        hasMore: offset + page.length < total,
        hideUrl: total === 0,        // 一条都没有时不假装有一面留言墙
        messages: page.map(publicMessage),
      });
    }

    if (req.method === 'POST') {
      let body;
      try {
        body = await readBody(req, 8192);
      } catch (e) {
        return sendJSON(res, e.code === 'TOO_LARGE' ? 413 : 400, {
          ok: false, error: e.code === 'TOO_LARGE' ? 'TOO_LARGE' : 'BAD_JSON',
        });
      }

      // 蜜罐：真人看不见这个字段，填了就是机器人。假装成功，别教它怎么绕过。
      if (body.website) return sendJSON(res, 200, { ok: true, spam: true, total: store.messages.length });

      const text = cleanText(body.text, MAX_MESSAGE);
      const name = cleanText(body.name, MAX_NAME) || (body.lang === 'en' ? 'Anonymous' : '匿名访客');

      if (!text) return sendJSON(res, 400, { ok: false, error: 'EMPTY' });
      if (text.replace(/\s/g, '').length < 2) return sendJSON(res, 400, { ok: false, error: 'TOO_SHORT' });
      if (isLowQuality(text)) return sendJSON(res, 400, { ok: false, error: 'LOW_QUALITY' });

      const ipHash = sha(clientIP(req));
      const rate = rateCheck(ipHash);
      if (!rate.ok) return sendJSON(res, 429, { ok: false, error: rate.error, wait: rate.wait || 0 });

      const msg = {
        id: crypto.randomBytes(8).toString('hex'),
        name,
        text,
        at: new Date().toISOString(),
        ipHash,                       // 只存哈希，用于限速与将来审核
      };
      store.messages.push(msg);
      if (store.messages.length > 2000) store.messages = store.messages.slice(-2000);

      appendLog({ t: 'msg', msg });
      persist();

      console.log('[portfolio] 新留言 · ' + msg.name + '：' + msg.text.slice(0, 40));
      return sendJSON(res, 201, {
        ok: true,
        message: publicMessage(msg),
        total: store.messages.length,
      });
    }

    if (req.method === 'DELETE') {
      const auth = String(req.headers.authorization || '');
      const token = auth.replace(/^Bearer\s+/i, '') || query.token || '';
      if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
        return sendJSON(res, 401, { ok: false, error: 'UNAUTHORIZED' });
      }
      const id = String(query.id || '');
      const before = store.messages.length;
      store.messages = store.messages.filter((m) => m.id !== id);
      if (store.messages.length === before) return sendJSON(res, 404, { ok: false, error: 'NOT_FOUND' });
      appendLog({ t: 'del', id, at: new Date().toISOString() });
      persist();
      console.log('[portfolio] 已删除留言 ' + id);
      return sendJSON(res, 200, { ok: true, total: store.messages.length });
    }

    return sendJSON(res, 405, { ok: false, error: 'METHOD' });
  }

  return sendJSON(res, 404, { ok: false, error: 'NOT_FOUND' });
}

/* ---------------------------------------------------------------
   静态文件
   --------------------------------------------------------------- */

async function serveStatic(req, res, pathname) {
  if (pathname.endsWith('/')) pathname += 'index.html';

  const filePath = path.resolve(ROOT, '.' + pathname);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  // data/ 里的东西绝不对外发：留言的 ipHash、管理员令牌、哈希盐都在里面。
  // 两条判断：一是"当前配置的数据目录"，二是 URL 里的 /data/ 段 ——
  // 后者是为了防止有人把 DSH_PORTFOLIO_DATA 指到别处时，默认目录反而漏出去。
  const segments = pathname.split('/').filter(Boolean);
  if (filePath === DATA_DIR || filePath.startsWith(DATA_DIR + path.sep) ||
      segments.indexOf('data') !== -1) {
    return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      return send(res, 301, '', { Location: pathname + '/' });
    }

    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': /\.(jpg|jpeg|png|webp|svg|woff2)$/i.test(filePath) ? 'public, max-age=86400' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      return send(res, 404, '404 Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    console.error('[portfolio] 读取失败:', filePath, err.message);
    return send(res, 500, 'Internal Server Error', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
}

async function handler(req, res) {
  let pathname;
  let query;
  try {
    const parsed = url.parse(req.url, true);
    pathname = decodeURIComponent(parsed.pathname || '/');
    query = parsed.query || {};
  } catch {
    return send(res, 400, 'Bad Request', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  // 手机在同一局域网里预览时会跨源，所以 API 放开来源（不带 cookie 凭证）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (pathname.indexOf('/api/') === 0) {
    try {
      return await handleAPI(req, res, pathname, query);
    } catch (e) {
      console.error('[portfolio] API 出错:', e);
      return sendJSON(res, 500, { ok: false, error: 'INTERNAL' });
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed', {
      Allow: 'GET, HEAD',
      'Content-Type': 'text/plain; charset=utf-8',
    });
  }

  return serveStatic(req, res, pathname);
}

/** 供冒烟测试复用：拿到一个还没 listen 的服务器 */
function createServer() {
  return http.createServer(handler);
}

/** 把数据层准备好。模块加载时就调用，所以被 require 时 API 也是可用的。 */
function initializeData() {
  try {
    ensureDataDir();
  } catch (e) {
    // 只读文件系统：API 还能用，只是落不了盘（页面会看到统计不动 / 留言提交失败）
    console.error('[portfolio] 无法创建数据目录:', e.message);
    console.error('  访问统计与留言板将不可用（页面会自动隐藏这两块）。');
    return false;
  }
  SECRET = readSecret('secret', 32);
  ADMIN_TOKEN = readSecret('admin-token', 16);

  const loaded = loadStore();
  store = loaded.store;
  if (loaded.recovered) {
    // 主文件坏了但日志能救回来：立刻把修复后的状态写回去，
    // 免得每次启动都要重放日志、也免得下一次写入又踩到坏文件
    console.warn('[portfolio] store.json 读取失败，已从 store.jsonl 重建：' +
      store.visits.total + ' 次访问 / ' + store.messages.length + ' 条留言');
    persist();
  }
  return true;
}

function boot() {
  const dataOK = initializeData();

  const portArg = Number(process.argv[2]);
  const port = Number.isFinite(portArg) && portArg > 0 ? portArg : PORT;

  // 启动前先"自检"一次：能自己请求到自己的 /api/stats，
  // 才算真的起来了。失败就是失败，别只在日志里看起来像成功。
  function selfCheck() {
    return new Promise((resolve) => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/api/stats', timeout: 3000 },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  const server = createServer();

  server
    .listen(port, HOST, async () => {
      const ok = await selfCheck();
      const url = `http://localhost:${port}/`;

      console.log('');
      console.log('  个人作品集已启动');
      console.log('  ' + '─'.repeat(46));
      console.log(`  地址        ${url}`);
      console.log(`  本机自检    ${ok ? '通过（/api/stats 返回 200）' : '失败，请检查防火墙或端口'}`);
      console.log(`  数据目录    ${DATA_DIR}${dataOK ? '' : '  ← 不可写，统计与留言板会隐藏'}`);
      console.log(`  已有数据    访问 ${store.visits.total} 次 · 留言 ${store.messages.length} 条`);
      console.log('');
      console.log(`  删留言      curl -X DELETE "${url}api/guestbook?id=<id>" -H "Authorization: Bearer ${ADMIN_TOKEN}"`);
      console.log('');
      console.log('  ▶ 这个窗口要保持开着，关掉或按 Ctrl+C 服务就停了。');
      console.log('    想一边逛一边敲命令，请再开一个终端。');
      console.log('');

      if (!ok) {
        console.error('  ⚠ 自检没通过：进程还在，但页面可能打不开。');
        console.error('    换端口试试：node server.js 5201');
      }
    })
    .on('error', (err) => {
      console.error('');
      if (err.code === 'EADDRINUSE') {
        console.error(`  ✗ 端口 ${port} 已经被占用 —— 很可能是上一个 node server.js 还在跑。`);
        console.error('    ① 直接用现成的：浏览器打开 http://localhost:' + port + '/');
        console.error('    ② 或结束旧进程：Get-NetTCPConnection -LocalPort ' + port +
          ' -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }');
        console.error(`    ③ 或换个端口：node server.js ${port + 1}`);
      } else if (err.code === 'EACCES') {
        console.error(`  ✗ 没有权限监听端口 ${port}（1024 以下需要管理员）。换一个：node server.js 5200`);
      } else {
        console.error('  ✗ 启动失败：' + err.code + ' ' + err.message);
      }
      console.error('');
      process.exit(1);
    });

  // Ctrl+C / 被结束进程时给一句回执。
  // 没有这句的话，日志会停在上面的启动信息上，看起来就像"它自己崩了"。
  //
  // 写法说明：先 console.log 再 process.exit(0)。Node 会同步写入文件描述符，
  // 这条信息不会丢；退出码 0 表示"是你让它停的"，不是出错。
  let closing = false;
  function shutdown(signal) {
    if (closing) return;
    closing = true;
    console.log('');
    console.log(`  收到 ${signal}，正在停止服务…`);
    console.log(`  已停止。数据都在 ${DATA_DIR}，下次启动会接着算。`);
    console.log('');
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('Ctrl+C'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // 直接关掉控制台窗口时走这个
  process.on('SIGHUP', () => shutdown('窗口关闭'));

  // 兜底：真有未捕获的异常，把原因打出来再退出，而不是静默消失
  process.on('uncaughtException', (e) => {
    console.error('\n  ✗ 服务端出现未处理的异常，即将退出：');
    console.error('    ' + (e && e.stack ? e.stack : e));
    process.exit(1);
  });
}

// 加载即就绪：直接跑、被测试 require，两种用法都能拿到可用的 API
initializeData();

module.exports = {
  createServer,
  handler,
  statsPayload,
  recordVisit,
  initializeData,
  getStore: () => store,
  DATA_DIR,
  ROOT,
};

if (require.main === module) boot();
