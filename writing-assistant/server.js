/*!
 * 三易 · 智能写作台 —— 服务端（server.js）
 *
 * 零依赖：只做三件事。
 *   1. 托管 index.html / css / js / lib（静态文件）
 *   2. /api/generate 用 SSE 把「多个版本」逐字推给前端（有 Key 走上游，没 Key 走离线引擎）
 *   3. /api/polish 一键优化（朱批）与 /api/history 历史留档
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
async function runVersion(params, material, index, sse, signal, model) {
  const mode = Modes.getMode(params.mode);
  const angle = Modes.angleOf(mode, index);

  if (config.live) {
    let buffer = '';
    try {
      const messages = Prompt.buildMessages(params, material, index);
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
  const text = String(engine.compose(params, material, index) || '').trim();
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

  sse.send('meta', {
    requestId: 'r' + startedAt.toString(36),
    engine: config.live ? 'live' : 'offline',
    engineNote: config.reason,
    model: config.live ? picked.model : '离线引擎',
    modelNote: picked.note,
    mode: params.mode,
    params,
    versions: plan,
  });

  let results;
  try {
    results = await Promise.all(plan.map((p) => runVersion(params, material, p.index, sse, ctrl.signal, picked.model)));
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
async function handleHistory(req, res, url, method) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api','history', id? , 'export'?]
  const id = parts[2] && parts[2] !== 'export' ? decodeURIComponent(parts[2]) : '';

  if (method === 'GET' && parts[2] === 'export') {
    const format = ['md', 'txt', 'json'].includes(url.searchParams.get('format'))
      ? url.searchParams.get('format')
      : 'md';
    const out = await history.exportAll(format, {
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
    const record = await history.get(id);
    if (!record) return json(res, 404, { ok: false, message: '这篇稿子已经不在了' });
    return json(res, 200, { ok: true, record });
  }

  if (method === 'GET') {
    const list = await history.list({
      mode: url.searchParams.get('mode') || 'all',
      q: url.searchParams.get('q') || '',
      starred: url.searchParams.get('starred') === '1',
      limit: Number(url.searchParams.get('limit')) || 50,
      offset: Number(url.searchParams.get('offset')) || 0,
    });
    return json(res, 200, Object.assign({ ok: true }, list));
  }

  if (method === 'POST') {
    try {
      const body = await readBody(req);
      const record = await history.create(body.record || body);
      return json(res, 201, { ok: true, record });
    } catch (err) {
      return json(res, 400, { ok: false, message: err.message });
    }
  }

  if (method === 'PATCH') {
    if (!id) return json(res, 400, { ok: false, message: '缺少稿子 id' });
    const body = await readBody(req).catch(() => ({}));
    const record = await history.update(id, body);
    if (!record) return json(res, 404, { ok: false, message: '这篇稿子已经不在了' });
    return json(res, 200, { ok: true, record });
  }

  if (method === 'DELETE') {
    // 清空必须显式带上 confirm，避免误触把留档全删了
    if (!id) {
      const confirmed = url.searchParams.get('confirm') === '1';
      if (!confirmed) return json(res, 400, { ok: false, message: '清空留档需要 confirm=1' });
      const removed = await history.clear();
      return json(res, 200, { ok: true, removed });
    }
    const okDelete = await history.remove(id);
    if (!okDelete) return json(res, 404, { ok: false, message: '这篇稿子已经不在了' });
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
const DENY_FILES = ['server.js', 'lib/llm.js', 'lib/store.js'];

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
        history: { count: await history.count() },
      });
    }
    if (url.pathname === '/api/models' && method === 'GET') return handleModels(req, res, url);
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
      history.ready().catch((err) => console.warn('[history] 初始化失败：' + err.message));

      let probed = null;
      if (config.live && opt.probe !== false) {
        if (opt.banner !== false) console.log('  正在探测可用的上游模型……');
        probed = await models.probe().catch((err) => ({ ok: false, note: err.message }));
      }
      if (opt.banner !== false) banner(actual, probed);
      resolve({
        port: actual,
        url: `http://${HOST}:${actual}/`,
        models,
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

module.exports = { server, start, config, models, history, ROOT, DATA_DIR, sseFatal };

