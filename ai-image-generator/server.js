/*!
 * 蓝晒 · AI 图片生成器 —— 服务端（server.js）
 *
 * 零依赖：只做四件事。
 *   1. 托管 public/ 里的页面（原生 HTML/CSS/JS，不需要打包）
 *   2. /api/images/generate  把「描述 + 尺寸 + 风格 + 画质」变成一张图，落盘并记进历史
 *   3. /api/prompt/optimize  用平台上的聊天模型把一句话扩成详细提示词
 *   4. /api/models           列出**能出图**的模型（并记住哪些实测过、哪些调不通）
 *
 * 用法：node server.js [端口]
 *
 * API Key 只从环境变量读（见 lib/upstream.js 里的 KEY_ENVS），代码里没有任何 key。
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');

const Styles = require('./lib/styles.js');
const Prompt = require('./lib/prompt.js');
const Upstream = require('./lib/upstream.js');
const Models = require('./lib/models.js');
const Images = require('./lib/image.js');
const Offline = require('./lib/offline.js');
const Store = require('./lib/store.js');
const Presets = require('./lib/presets.js');
const Community = require('./lib/community.js');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const VERSION = require('./package.json').version;
const BASE_PORT = Number(process.argv[2] || process.env.PORT || 5270);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.AIG_DATA_DIR || path.join(ROOT, 'data');
const BODY_LIMIT = 256 * 1024;
// 改图要把原图传回来（浏览器读成 data URL 再发过来），所以这一个接口单独放宽
const EDIT_BODY_LIMIT = 32 * 1024 * 1024;

const config = Upstream.readConfig();
const store = Store.createStore({
  dir: path.join(DATA_DIR, 'history'),
  imageDir: path.join(DATA_DIR, 'images'),
  log: (line) => console.log('  ' + line),
});
const statusStore = Store.createModelStatusStore({
  file: path.join(DATA_DIR, 'model-status.json'),
  log: (line) => console.log('  ' + line),
});
const registry = Models.createModelRegistry(config, {
  log: (line) => console.log('  ' + line),
  statusStore,
});
const presets = Presets.createPresetStore({
  file: path.join(DATA_DIR, 'presets.json'),
  log: (line) => console.log('  ' + line),
});
const community = Community.createCommunityStore({
  file: path.join(DATA_DIR, 'community.json'),
  log: (line) => console.log('  ' + line),
});

/* ── 小工具 ─────────────────────────────────────────────── */

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
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit) {
  const max = Number(limit) || BODY_LIMIT;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
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

/** 把上游的错误状态翻成「对浏览器有意义」的状态码 */
function statusFor(err) {
  const s = (err && err.status) || 0;
  if (s === 402) return 402;
  if (s === 429) return 429;
  if (s === 404) return 404;
  if (s === 400 || s === 422) return 400;
  return 502;
}

/** 同源检查：跨站发起的写操作一律拒掉（Cookie 之外的第二种保护，这里没有 Cookie，但接口一样要守） */
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

/* ── 引擎信息 ───────────────────────────────────────────── */

function engineInfo() {
  return {
    live: config.live,
    baseUrl: config.live ? config.baseUrl : '',
    keyFrom: config.live ? config.keyFrom : '',
    note: config.reason,
    imageModel: config.live ? registry.imageModel : '',
    chatModel: config.live ? registry.chatModel : '',
    chatVerified: registry.chatVerified,
    chatNote: registry.chatNote,
  };
}

/* ── 模型列表 ───────────────────────────────────────────── */

async function handleModels(req, res, url) {
  const force = url.searchParams.get('refresh') === '1';
  if (!config.live) {
    return json(res, 200, {
      ok: true,
      live: false,
      engine: 'offline',
      source: 'offline',
      image: [],
      chat: { model: '', verified: false, note: '' },
      counts: { all: 0, image: 0, verified: 0, unavailable: 0 },
      current: '',
      note: config.reason,
      error: '',
    });
  }

  const listed = await registry.list(force);
  const image = registry.imageModelsForUi();
  const verified = image.filter((m) => m.state === 'verified').length;
  const unavailable = image.filter((m) => m.state === 'unavailable').length;

  return json(res, 200, {
    ok: true,
    live: true,
    engine: 'live',
    baseUrl: config.baseUrl,
    source: listed.source,
    image,
    chat: { model: registry.chatModel, verified: registry.chatVerified, note: registry.chatNote },
    counts: { all: listed.all.length, image: image.length, verified, unavailable },
    current: registry.imageModel,
    preferred: config.imageModel,
    note: listed.note || '',
    error: listed.error || '',
    cached: Boolean(listed.cached),
  });
}

/**
 * 实测一个模型能不能出图。
 *
 * 会真的生成一张最低画质的图（花一点额度）——所以只在你点「检测」时跑，
 * 开机不批量试。结果落盘，下次打开还认得。
 */
async function handleVerify(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return json(res, 400, { ok: false, message: err.message });
  }
  if (!config.live) {
    return json(res, 200, { ok: false, live: false, model: String(body.model || ''), message: config.reason });
  }
  const out = await registry.verifyImage(body.model);
  return json(res, out.ok ? 200 : 502, Object.assign({ live: true }, out));
}

/* ── 优化提示词 ─────────────────────────────────────────── */

async function handleOptimize(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return json(res, 400, { ok: false, message: err.message });
  }

  const before = Styles.cleanPrompt(body.prompt);
  if (before.length < Styles.LIMITS.promptMin) {
    return json(res, 400, { ok: false, message: '先写一句描述，再让 AI 帮你扩写' });
  }

  const styleId = String(body.styleId || '').trim();
  const size = String(body.size || '').trim() || Styles.SIZE_TABLE[0].sizes[Styles.DEFAULT_TIER];
  const picked = registry.resolveChatModel(body.chatModel);
  let note = picked.note || '';

  if (config.live && picked.model) {
    try {
      const out = await Upstream.chatOnce({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: picked.model,
        messages: [
          { role: 'system', content: Prompt.optimizeSystem() },
          { role: 'user', content: Prompt.optimizeUser({ prompt: before, styleId, size }) },
        ],
        temperature: 0.4,
        maxTokens: 900,
        jsonMode: true,
      });
      const parsed = Prompt.parseReply(out.text);
      if (parsed.prompt) {
        if (!parsed.parsed) note = (note ? note + '；' : '') + '上游没有按 JSON 返回，已按纯文本处理';
        return json(res, 200, {
          ok: true,
          engine: 'live',
          model: picked.model,
          before,
          prompt: parsed.prompt,
          notes: parsed.notes,
          parsed: parsed.parsed,
          changed: parsed.prompt !== before,
          note,
        });
      }
      note = (note ? note + '；' : '') + '上游返回了空内容，已用离线扩写';
    } catch (err) {
      note = (note ? note + '；' : '') + '上游优化失败，已用离线扩写：' + ((err && err.message) || err);
    }
  }

  const offline = Prompt.expandOffline({ prompt: before, styleId, size });
  return json(res, 200, {
    ok: true,
    engine: 'offline',
    model: '离线扩写',
    before,
    prompt: offline.prompt,
    notes: offline.notes,
    parsed: true,
    changed: offline.prompt !== before,
    note,
  });
}

/* ── 生成一张图 ─────────────────────────────────────────── */

/**
 * 上游可能给 base64，也可能给 URL：两种都要变成我们自己的一个文件。
 *
 * 三种形态依次试：
 *   1. base64（含 `data:image/png;base64,` 前缀）
 *   2. `url` 字段本身就是一个 data URL（少见，但遇到就别丢）
 *   3. 真正的远程地址：下载回来再存
 */
async function materialize(image, opts) {
  if (!image) throw new Error('上游没有给图片数据');

  if (image.b64) {
    const decoded = Images.decodeBase64Image(image.b64);
    const stored = Images.toStoredImage(decoded.buffer, { contentType: decoded.declaredType });
    return Object.assign(stored, { remoteUrl: /^https?:\/\//i.test(image.url || '') ? image.url : '', via: 'base64' });
  }

  if (image.url && /^data:/i.test(image.url)) {
    const decoded = Images.decodeBase64Image(image.url);
    const stored = Images.toStoredImage(decoded.buffer, { contentType: decoded.declaredType });
    return Object.assign(stored, { remoteUrl: '', via: 'data-url' });
  }

  if (image.url) {
    const downloaded = await Upstream.fetchImageBytes(image.url, {
      signal: opts && opts.signal,
      apiKey: config.apiKey,
    });
    const stored = Images.toStoredImage(downloaded.buffer, { contentType: downloaded.contentType });
    return Object.assign(stored, { remoteUrl: image.url, via: 'download' });
  }

  throw new Error('上游既没有给 base64，也没有给图片地址');
}

/* ── 落盘：一张图变成一条记录 ───────────────────────────── */

const sizeOfRecord = (size) => {
  const parsed = Styles.parseSize(size);
  return { width: parsed ? parsed.width : 0, height: parsed ? parsed.height : 0 };
};

/**
 * 把一张「已经拿到手的东西」存成记录。
 * @param {object} input {id, startedAt, prompt, finalPrompt, style, size, quality, model, engine, stored, notes, kind, parent}
 */
async function persistImage(input) {
  const i = input;
  const file = await store.saveImage(i.id, i.stored.buffer, i.stored.ext);
  const dims = sizeOfRecord(i.size);
  return store.create({
    id: i.id,
    createdAt: i.startedAt,
    prompt: i.prompt,
    finalPrompt: i.finalPrompt,
    style: i.style,
    size: { requested: i.requestedSize || i.size, actual: i.size, ratio: Styles.ratioLabel(i.size) },
    quality: i.quality,
    model: i.model,
    engine: i.engine,
    file,
    mime: i.stored.mime,
    bytes: i.stored.buffer.length,
    width: dims.width,
    height: dims.height,
    remoteUrl: i.stored.remoteUrl || '',
    elapsedMs: Date.now() - i.startedAt,
    notes: i.notes,
    kind: i.kind,
    parentId: i.parent && i.parent.id,
    parentFile: i.parent && i.parent.file,
  });
}

/**
 * 图片取不回来，但上游给了地址：留一个「只有上游链接」的记录。
 * 宁可留一个会过期的地址，也不能把已经付过钱的图丢掉。
 */
async function persistRemoteOnly(input) {
  const i = input;
  const dims = sizeOfRecord(i.size);
  return store.create({
    id: i.id,
    createdAt: i.startedAt,
    prompt: i.prompt,
    finalPrompt: i.finalPrompt,
    style: i.style,
    size: { requested: i.requestedSize || i.size, actual: i.size, ratio: Styles.ratioLabel(i.size) },
    quality: i.quality,
    model: i.model,
    engine: i.engine,
    file: '',
    mime: '',
    bytes: 0,
    width: dims.width,
    height: dims.height,
    remoteUrl: i.remoteUrl,
    elapsedMs: Date.now() - i.startedAt,
    notes: i.notes,
    kind: i.kind,
    parentId: i.parent && i.parent.id,
    parentFile: i.parent && i.parent.file,
  });
}

/**
 * 把上游返回的图片存成记录。
 *
 * 我们只请求一张，正常情况这里就循环一次。留成循环只是为了**不丢已经付过钱的图**：
 * 万一某个网关不听话多回了一张，就多存一条记录，而不是悄悄扔掉。
 * 每张都单独处理 —— 某一张取不回来，不该拖累其它已经到手的。
 */
async function persistImages(input) {
  const i = input;
  const records = [];
  const notes = (i.notes || []).slice();
  const failures = [];
  let anyRemoteOnly = false;
  let dropped = 0;

  for (let index = 0; index < i.images.length; index += 1) {
    const image = i.images[index];
    const id = store.newId('img');
    // 只有「多回了一张」时才用得上这个标号
    const tag = i.images.length > 1 ? `（第 ${index + 1}/${i.images.length} 张）` : '';
    let stored = null;
    let failure = null;
    try {
      stored = await materialize(image, { signal: i.signal });
    } catch (err) {
      failure = err;
    }

    if (stored) {
      records.push(
        await persistImage({
          id,
          startedAt: i.startedAt,
          prompt: i.prompt,
          finalPrompt: i.finalPrompt,
          requestedSize: i.requestedSize,
          style: i.style,
          size: i.size,
          quality: i.quality,
          model: i.model,
          engine: i.engine,
          stored,
          notes,
          kind: i.kind,
          parent: i.parent,
        })
      );
      continue;
    }

    const remote = String((image && image.url) || '');
    const reason = (failure && failure.message) || '取图失败';
    console.error(`[出图] ${i.model}${tag} 取图失败：${reason}` + (remote ? `（保留上游地址 ${remote.slice(0, 120)}）` : ''));
    if (!/^https?:\/\//i.test(remote)) {
      // 连地址都没有：这一张确实救不回来，记下原因继续处理下一张
      dropped += 1;
      failures.push(`第 ${index + 1} 张：${reason}`);
      continue;
    }
    anyRemoteOnly = true;
    if (!notes.some((n) => String(n).includes('没存到本地'))) {
      notes.push(`有图片没存到本地（${reason}），显示的是上游临时链接，可能会过期`);
    }
    records.push(
      await persistRemoteOnly({
        id,
        startedAt: i.startedAt,
        prompt: i.prompt,
        finalPrompt: i.finalPrompt,
        requestedSize: i.requestedSize,
        style: i.style,
        size: i.size,
        quality: i.quality,
        model: i.model,
        engine: i.engine,
        remoteUrl: remote,
        notes: notes.concat(`这张没存到本地（${reason}），显示的是上游临时链接，可能会过期`),
        kind: i.kind,
        parent: i.parent,
      })
    );
  }

  return { records, notes, anyRemoteOnly, dropped, failures };
}

/**
 * 向上游要一张图。
 *
 * 这里**不传 n**：一次就要一张。曾经做过批量（要 2 张、4 张），现实是网关对 n
 * 的支持五花八门，而额度按 n 扣 —— 花了 2 张的钱只看到 1 张，比多等几秒糟得多。
 * 现在一张一张来，出了问题也只是「这一张没出来」，一眼就能说清。
 */
async function requestImages(options) {
  const o = options;
  const log = o.log || (() => {});
  const base = {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: o.model,
    prompt: o.prompt,
    size: o.size,
    quality: o.quality,
    responseFormat: 'b64_json',
    signal: o.signal,
    log,
  };
  return Upstream.generateImage(base);
}

async function handleGenerate(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return json(res, 400, { ok: false, message: err.message });
  }

  const prompt = Styles.cleanPrompt(body.prompt);
  if (prompt.length < Styles.LIMITS.promptMin) {
    return json(res, 400, { ok: false, message: '先写一句你想看到的画面，再按「曝光」' });
  }

  const picked = registry.resolveImageModel(body.model);
  if (picked.unavailable) {
    return json(res, 400, {
      ok: false,
      code: 'model_unavailable',
      model: picked.model,
      message: picked.note + '。换一个模型，或者重新检测一次。',
    });
  }

  const request = Styles.buildRequest({
    prompt,
    styleId: body.styleId,
    size: body.size,
    quality: body.quality,
    model: picked.model,
  });
  const notes = [picked.note, request.sizeNote, request.qualityNote].filter(Boolean);
  // 旧版界面还会带 n 上来。一次只出一张，别让「以为要了 2 张」这种错觉留着
  if (Number(body.n) > 1) notes.push('一次只出一张，已忽略请求里的张数');

  const ctrl = new AbortController();
  // 客户端走了就中止上游请求。听 res 而不是 req：请求体读完 req 也会 close，
  // 那里中止会把「刚读完 body」当成「人已经走了」。
  res.on('close', () => {
    if (!res.writableEnded) ctrl.abort();
  });
  const startedAt = Date.now();

  if (config.live) {
    const logLine = (line) => console.log('  ' + line);
    let out;
    try {
      out = await requestImages({
        model: picked.model,
        prompt: request.finalPrompt,
        size: request.size,
        quality: request.quality,
        signal: ctrl.signal,
        log: logLine,
      });
    } catch (err) {
      if (ctrl.signal.aborted) return json(res, 499, { ok: false, message: '已取消' });
      // 模型级的失败记下来：界面上会把它标成「调不通」，不必再拿同一张脸撞一次
      const status = (err && err.status) || 0;
      if (status === 404) {
        registry.rememberStatus(picked.model, { ok: false, message: (err && err.message) || '调不通' });
      }
      return json(res, statusFor(err), {
        ok: false,
        code: 'upstream_failed',
        model: picked.model,
        message: (err && err.message) || '上游出图失败',
      });
    }

    const result = await persistImages({
      startedAt,
      prompt,
      finalPrompt: request.finalPrompt,
      requestedSize: request.requestedSize,
      style: request.style,
      size: request.size,
      quality: request.quality,
      model: picked.model,
      engine: 'live',
      notes,
      kind: 'generate',
      signal: ctrl.signal,
      images: out.images,
    });

    if (!result.records.length) {
      const detail = result.failures.length ? result.failures.join('；') : result.notes.slice(-1)[0] || '未知原因';
      return json(res, 502, {
        ok: false,
        code: 'bad_image',
        message: '上游返回了，但图取不回来：' + detail,
        shape: out.shape || '',
      });
    }

    registry.rememberStatus(picked.model, { ok: true, message: '' });
    const total = result.records.reduce((sum, r) => sum + (r.bytes || 0), 0);
    console.log(
      `[出图] ${picked.model} ${request.size} quality=${request.quality || '-'} ` +
        `${((Date.now() - startedAt) / 1000).toFixed(1)}s → ${Math.round(total / 1024)}KB`
    );
    return json(res, 200, {
      ok: true,
      engine: 'live',
      records: result.records,
      record: result.records[0],
      notes: result.notes,
      usage: out.usage || null,
      remoteOnly: result.anyRemoteOnly,
      shape: out.shape || '',
    });
  }

  // 离线显影：画一张真的有内容的 PNG，让整条链路能走通
  const painted = Offline.render({
    prompt: request.finalPrompt,
    styleId: request.style.id,
    size: request.size,
  });
  const localNotes = notes.slice();
  if (painted.capped) localNotes.push(`离线显影把最长边压到 ${Offline.CAP_MAX_SIDE}px，接上 Key 之后就按真实尺寸出图`);
  const record = await persistImage({
    id: store.newId('img'),
    startedAt,
    prompt,
    finalPrompt: request.finalPrompt,
    requestedSize: request.requestedSize,
    style: request.style,
    size: `${painted.width}x${painted.height}`,
    quality: request.quality,
    model: '离线显影引擎',
    engine: 'offline',
    stored: { buffer: painted.buffer, mime: painted.mime, ext: painted.ext, remoteUrl: '' },
    notes: localNotes,
    kind: 'generate',
  });
  return json(res, 200, { ok: true, engine: 'offline', records: [record], record, notes: localNotes, usage: null });
}

/* ── 改图：基于已有图片 ─────────────────────────────────── */

/**
 * 取原图。两种来源：
 *   1. `sourceId`：历史里的一张（最常见 —— 从相纸上点「编辑」）
 *   2. `sourceB64`：浏览器读进来的本地图片（data URL）
 */
async function loadSourceImage(body) {
  const sourceId = String(body.sourceId || '').trim();
  if (sourceId) {
    const record = await store.get(sourceId);
    if (!record) return { ok: false, message: '要改的那张图已经不在了' };
    if (!record.file) return { ok: false, message: '那张图没存到本地（只有上游链接），没法作为原图' };
    const file = store.resolveImage(record.file);
    try {
      const buffer = await fsp.readFile(file);
      const stored = Images.toStoredImage(buffer, { contentType: record.mime });
      return { ok: true, record, buffer: stored.buffer, mime: stored.mime, ext: stored.ext, name: record.file };
    } catch {
      return { ok: false, message: '原图文件读不出来（可能被删了）' };
    }
  }

  const sourceB64 = String(body.sourceB64 || '').trim();
  if (sourceB64) {
    try {
      const decoded = Images.decodeBase64Image(sourceB64);
      const stored = Images.toStoredImage(decoded.buffer, { contentType: decoded.declaredType });
      return { ok: true, record: null, buffer: stored.buffer, mime: stored.mime, ext: stored.ext, name: `upload${stored.ext}` };
    } catch (err) {
      return { ok: false, message: '这张本地图片读不了：' + err.message };
    }
  }

  return { ok: false, message: '没有指定要改哪张图' };
}

async function handleEdit(req, res) {
  let body;
  try {
    body = await readBody(req, EDIT_BODY_LIMIT);
  } catch (err) {
    return json(res, 400, { ok: false, message: err.message === '请求体过大' ? '原图太大了（超过 24MB），换一张小一点的' : err.message });
  }

  // 改图时「描述」是「要改什么」，可以比出图更短，但也不能空
  const prompt = Styles.cleanPrompt(body.prompt);
  if (!prompt) {
    return json(res, 400, { ok: false, message: '写一句「要怎么改」，例如：把背景换成夜景，人物保留' });
  }

  const source = await loadSourceImage(body);
  if (!source.ok) return json(res, 400, { ok: false, message: source.message });

  const picked = registry.resolveImageModel(body.model);
  if (picked.unavailable) {
    return json(res, 400, {
      ok: false,
      code: 'model_unavailable',
      model: picked.model,
      message: picked.note + '。换一个模型，或者重新检测一次。',
    });
  }

  const request = Styles.buildRequest({
    prompt,
    styleId: body.styleId,
    size: body.size,
    quality: body.quality,
    model: picked.model,
  });
  const parent = source.record;
  const notes = [picked.note, request.sizeNote, request.qualityNote].filter(Boolean);
  if (Number(body.n) > 1) notes.push('一次只改出一张，已忽略请求里的张数');
  if (parent) {
    // PLATE 编号是界面按时间顺序排出来的，服务端不知道，所以这里只给记录 id 的尾巴
    notes.push(`基于原图（${String(parent.id).slice(-6)}）修改`);
  } else {
    notes.push('基于本地图片修改');
  }

  const ctrl = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ctrl.abort();
  });
  const startedAt = Date.now();

  if (config.live) {
    const logLine = (line) => console.log('  ' + line);
    let out;
    try {
      out = await Upstream.editImage({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: picked.model,
        prompt: request.finalPrompt,
        images: [{ buffer: source.buffer, mime: source.mime, filename: source.name }],
        size: request.size,
        quality: request.quality,
        responseFormat: 'b64_json',
        signal: ctrl.signal,
        log: logLine,
      });
    } catch (err) {
      if (ctrl.signal.aborted) return json(res, 499, { ok: false, message: '已取消' });
      const status = (err && err.status) || 0;
      if (status === 404) {
        registry.rememberStatus(picked.model, { ok: false, message: (err && err.message) || '调不通' });
      }
      return json(res, statusFor(err), {
        ok: false,
        code: 'upstream_failed',
        model: picked.model,
        message: (err && err.message) || '上游改图失败',
      });
    }

    const result = await persistImages({
      startedAt,
      prompt,
      finalPrompt: request.finalPrompt,
      requestedSize: request.requestedSize,
      style: request.style,
      size: request.size,
      quality: request.quality,
      model: picked.model,
      engine: 'live',
      notes,
      kind: 'edit',
      parent: parent ? { id: parent.id, file: parent.file } : null,
      signal: ctrl.signal,
      images: out.images,
    });

    if (!result.records.length) {
      const detail = result.failures.length ? result.failures.join('；') : result.notes.slice(-1)[0] || '未知原因';
      return json(res, 502, {
        ok: false,
        code: 'bad_image',
        message: '上游返回了，但图取不回来：' + detail,
        shape: out.shape || '',
      });
    }
    registry.rememberStatus(picked.model, { ok: true, message: '' });
    console.log(
      `[改图] ${picked.model} ${request.size} ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
    );
    return json(res, 200, {
      ok: true,
      engine: 'live',
      records: result.records,
      record: result.records[0],
      notes: result.notes,
      usage: out.usage || null,
      remoteOnly: result.anyRemoteOnly,
      shape: out.shape || '',
    });
  }

  // 离线改图：真的在原图上动手（换风格配色 + 压暗四角 + 加颗粒），不是另画一张
  notes.push('离线改图：在原图上换了风格配色、压暗四角、加了颗粒（接上 Key 之后是上游按描述重画）');
  let painted;
  try {
    painted = Offline.applyEdit({
      buffer: source.buffer,
      styleId: request.style.id,
      prompt: request.finalPrompt,
    });
  } catch (err) {
    return json(res, 400, {
      ok: false,
      code: 'offline_edit_unsupported',
      message:
        '离线显影只能改 PNG 格式的原图（' +
        err.message +
        '）。接上 Key 之后，JPEG / WebP 也能改。',
    });
  }
  const record = await persistImage({
    id: store.newId('img'),
    startedAt,
    prompt,
    finalPrompt: request.finalPrompt,
    requestedSize: request.requestedSize,
    style: request.style,
    size: `${painted.width}x${painted.height}`,
    quality: request.quality,
    model: '离线显影引擎',
    engine: 'offline',
    stored: { buffer: painted.buffer, mime: painted.mime, ext: painted.ext, remoteUrl: '' },
    notes,
    kind: 'edit',
    parent: parent ? { id: parent.id, file: parent.file } : null,
  });
  return json(res, 200, { ok: true, engine: 'offline', records: [record], record, notes, usage: null });
}

/* ── 从链接导入 ─────────────────────────────────────────── */

/**
 * 把一张「已经在别处生成好、但我们没存下来」的图收回历史。
 *
 * 真实场景就是它诞生的原因：某次出图上游成功了、也扣了钱，但我们这边取图失败
 * （图床抽风 / 超时 / 返回形状没认出来），历史里就没这张。这时平台控制台里
 * 那条记录的返回体通常还带着 `url`（例如 https://myfile.aibeke.com/img/...），
 * 贴进来就能把图重新落盘 —— 还能正常下载、改图、分享。
 */
async function handleImport(req, res) {
  let body;
  try {
    // 贴 data:image/... 的整段内嵌图片时，请求体会很大（base64 是原图的 4/3），
    // 所以这个接口和改图一样放宽上限
    body = await readBody(req, EDIT_BODY_LIMIT);
  } catch (err) {
    return json(res, 400, {
      ok: false,
      message: err.message === '请求体过大' ? '这张内嵌图片太大了（超过 24MB），改用 http(s) 链接导入' : err.message,
    });
  }

  const raw = String(body.url || '').trim();
  if (!raw) return json(res, 400, { ok: false, message: '贴一个图片链接（http(s):// 或 data:image/...）' });
  if (!/^(https?:\/\/|data:image\/)/i.test(raw)) {
    return json(res, 400, { ok: false, message: '只认 http(s) 链接或 data:image 开头的内嵌图片' });
  }
  // 只有 http(s) 链接需要防「贴错了」；data:image 本身就是一整段 base64，长度天然很长
  if (!/^data:/i.test(raw) && raw.length > 2000) {
    return json(res, 400, { ok: false, message: '链接太长了，检查一下是不是贴错了' });
  }

  const startedAt = Date.now();
  let stored;
  try {
    if (/^data:/i.test(raw)) {
      const decoded = Images.decodeBase64Image(raw);
      stored = Images.toStoredImage(decoded.buffer, { contentType: decoded.declaredType });
    } else {
      const downloaded = await Upstream.fetchImageBytes(raw, { apiKey: config.apiKey });
      stored = Images.toStoredImage(downloaded.buffer, { contentType: downloaded.contentType });
    }
  } catch (err) {
    return json(res, 502, {
      ok: false,
      code: 'import_failed',
      message:
        '这张图取不回来：' +
        ((err && err.message) || '未知原因') +
        '。链接可能已经过期（这类中转的图床一般只留几天），或者需要登录才能看',
    });
  }

  const dims = Images.dimensionsOf(stored.buffer);
  const id = store.newId('img');
  const styleId = String(body.styleId || '').trim();
  const style = Styles.findStyle(styleId || 'photo');
  let record;
  try {
    record = await persistImage({
      id,
      startedAt,
      prompt: Styles.cleanPrompt(body.prompt) || '（从链接导入）',
      finalPrompt: Styles.cleanPrompt(body.prompt) || '',
      style: { id: style.id, label: style.label },
      size: dims ? `${dims.width}x${dims.height}` : '',
      quality: '',
      model: '导入（原模型未知）',
      engine: 'live',
      stored: Object.assign({}, stored, { remoteUrl: /^https?:\/\//i.test(raw) ? raw : '' }),
      notes: ['从链接导入：这张本来没存到本地（上游返回过图，但当时没取回来）'],
      kind: 'generate',
    });
  } catch (err) {
    return json(res, 500, { ok: false, message: '图片存不下来：' + err.message });
  }

  console.log(`[导入] ${record.file} ${Math.round(stored.buffer.length / 1024)}KB ← ${raw.slice(0, 90)}`);
  return json(res, 200, { ok: true, record });
}

/* ── 历史记录 ───────────────────────────────────────────── */

async function handleHistory(req, res, url, method) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api','history', id?, action?]
  const id = parts[2] ? decodeURIComponent(parts[2]) : '';
  const action = parts[3] || '';

  if (method === 'GET' && id && action === 'download') {
    const record = await store.get(id);
    if (!record) return json(res, 404, { ok: false, message: '这张图已经不在了' });
    if (!record.file) {
      return json(res, 409, {
        ok: false,
        code: 'remote_only',
        message: '这张没存到本地（当时只拿到了上游的临时链接），只能在上游链接还有效时手动另存',
        remoteUrl: record.remoteUrl || '',
      });
    }
    const file = store.resolveImage(record.file);
    let buffer;
    try {
      buffer = await fsp.readFile(file);
    } catch {
      return json(res, 404, { ok: false, message: '图片文件丢了，记录还在（可以删掉这条）' });
    }
    const name = Images.downloadName(record);
    res.writeHead(200, {
      'content-type': record.mime || 'image/png',
      'content-length': buffer.length,
      'cache-control': 'no-store',
      'content-disposition': `attachment; filename="image${path.extname(record.file) || '.png'}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
    res.end(buffer);
    return;
  }

  if (method === 'GET' && id) {
    const record = await store.get(id);
    if (!record) return json(res, 404, { ok: false, message: '这张图已经不在了' });
    return json(res, 200, { ok: true, record });
  }

  if (method === 'GET') {
    const out = await store.list({
      q: url.searchParams.get('q') || '',
      limit: Number(url.searchParams.get('limit')) || 50,
      offset: Number(url.searchParams.get('offset')) || 0,
    });
    const stats = await store.stats();
    return json(res, 200, Object.assign({ ok: true }, out, { stats }));
  }

  if (method === 'DELETE' && !id) {
    if (url.searchParams.get('confirm') !== '1') {
      return json(res, 400, { ok: false, message: '清空历史需要 confirm=1' });
    }
    const removed = await store.clear();
    // 图删了，挂在社区里的那份也没图可看了 —— 一起撤下来，别留一堆破图
    const unshared = community.clear();
    return json(res, 200, { ok: true, removed, unshared });
  }

  if (method === 'DELETE' && id) {
    const removed = await store.remove(id);
    if (!removed) return json(res, 404, { ok: false, message: '这张图已经不在了' });
    const unshared = community.removeByRecord(id);
    return json(res, 200, { ok: true, id, unshared });
  }

  return json(res, 405, { ok: false, message: '不支持的方法' });
}

/* ── 预设（印相配方） ───────────────────────────────────── */

const PRESET_ROUTE = '/api/presets/saved';

async function handlePresets(req, res, url, method) {
  if (method === 'GET') {
    return json(res, 200, Object.assign({ ok: true }, presets.list()));
  }

  if (method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return json(res, 400, { ok: false, message: err.message });
    }
    const out = presets.add(body.preset || body);
    if (!out.ok) return json(res, 400, { ok: false, message: out.message });
    return json(res, 200, Object.assign({ ok: true }, presets.list(), { preset: out.preset, replaced: out.replaced }));
  }

  if (method === 'DELETE') {
    const id = decodeURIComponent(url.pathname.slice(PRESET_ROUTE.length).replace(/^\/+/, ''));
    if (!id) return json(res, 400, { ok: false, message: '缺少预设 id' });
    const removed = presets.remove(id);
    if (!removed) return json(res, 404, { ok: false, message: '这个预设已经不在了' });
    return json(res, 200, Object.assign({ ok: true, id }, presets.list()));
  }

  return json(res, 405, { ok: false, message: '不支持的方法' });
}

/* ── 社区分享 ───────────────────────────────────────────── */

async function handleCommunity(req, res, url, method) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api','community', id?, 'like'?]
  const id = parts[2] ? decodeURIComponent(parts[2]) : '';
  const action = parts[3] || '';
  const viewerId = String(req.headers['x-viewer-id'] || url.searchParams.get('viewer') || '').slice(0, 40);

  if (method === 'GET' && !id) {
    const out = community.list({
      sort: url.searchParams.get('sort') || 'new',
      limit: Number(url.searchParams.get('limit')) || 24,
      viewerId,
    });
    return json(res, 200, Object.assign({ ok: true }, out));
  }

  if (method === 'GET' && id) {
    const entry = community.get(id);
    if (!entry) return json(res, 404, { ok: false, message: '这条分享已经不在了' });
    return json(res, 200, { ok: true, entry, viewerId });
  }

  if (method === 'POST' && !id) {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return json(res, 400, { ok: false, message: err.message });
    }
    const record = await store.get(String(body.recordId || ''));
    if (!record) return json(res, 404, { ok: false, message: '要分享的那张图已经不在了' });
    if (!record.file) {
      return json(res, 400, { ok: false, message: '这张没存到本地（只有上游临时链接），分享出去会失效' });
    }
    const out = community.add({
      recordId: record.id,
      file: record.file,
      mime: record.mime,
      author: body.author,
      note: body.note,
      prompt: record.optimized && record.optimized.prompt ? record.optimized.prompt : record.prompt,
      hidePrompt: body.hidePrompt,
      model: record.model,
      styleId: record.style && record.style.id,
      styleLabel: record.style && record.style.label,
      size: record.size && record.size.actual,
    });
    if (!out.ok) return json(res, 400, { ok: false, message: out.message });
    return json(res, 200, {
      ok: true,
      entry: community.list({ viewerId }).items.find((e) => e.recordId === record.id) || null,
      updated: out.updated,
      count: community.count(),
    });
  }

  if (method === 'POST' && id && action === 'like') {
    if (!viewerId) return json(res, 400, { ok: false, message: '缺少点赞标识（刷新一下页面再试）' });
    const out = community.like(id, viewerId);
    if (!out.ok) return json(res, 404, { ok: false, message: out.message });
    return json(res, 200, { ok: true, likes: out.likes, liked: out.liked });
  }

  if (method === 'DELETE' && id) {
    const removed = community.remove(id);
    if (!removed) return json(res, 404, { ok: false, message: '这条分享已经不在了' });
    return json(res, 200, { ok: true, id, count: community.count() });
  }

  if (method === 'DELETE' && !id) {
    // 按图片撤销分享：?recordId=xxx
    const recordId = url.searchParams.get('recordId') || '';
    if (!recordId) return json(res, 400, { ok: false, message: '缺少 recordId' });
    const removed = community.removeByRecord(recordId);
    return json(res, 200, { ok: true, removed, count: community.count() });
  }

  return json(res, 405, { ok: false, message: '不支持的方法' });
}

/* ── 图片文件 ───────────────────────────────────────────── */

async function handleImageFile(req, res, url) {
  const file = store.resolveImage(url.pathname.split('/').pop());
  if (!file) return json(res, 404, { ok: false, message: '没有这张图' });
  let buffer;
  try {
    buffer = await fsp.readFile(file);
  } catch {
    return json(res, 404, { ok: false, message: '没有这张图' });
  }
  const ext = path.extname(file).toLowerCase();
  const download = url.searchParams.get('download') === '1';
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': buffer.length,
    'cache-control': 'private, max-age=31536000, immutable',
  };
  if (download) {
    headers['content-disposition'] = `attachment; filename="${path.basename(file)}"`;
    headers['cache-control'] = 'no-store';
  }
  res.writeHead(200, headers);
  res.end(buffer);
}

/* ── 静态文件 ───────────────────────────────────────────── */

/**
 * 前后端共用的一份纯函数（尺寸表 / 风格表 / 提示词拼法）挂在这里。
 *
 * 为什么单独放行：lib/ 里别的东西（上游接入、落盘、Key）只在服务端跑，
 * 浏览器既不需要、也不该拿到；styles.js 是纯数据 + 纯函数，没有秘密，
 * 而且必须和服务器用的是同一份，界面上的预览才不会和真正发出去的对不上。
 */
const SHARED_FILES = new Map([['/lib/styles.js', path.join(ROOT, 'lib', 'styles.js')]]);

function serveFile(res, file, options) {
  const o = options || {};
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 找不到文件');
      return;
    }
    const headers = {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-cache',
    };
    if (o.download) headers['content-disposition'] = o.download;
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

function serveStatic(req, res, url) {
  const shared = SHARED_FILES.get(url.pathname);
  if (shared) return serveFile(res, shared);

  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  const inside = file === PUBLIC_DIR || file.startsWith(PUBLIC_DIR + path.sep);
  if (!inside) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('403 不允许访问');
    return;
  }
  serveFile(res, file);
}

/* ── 路由 ───────────────────────────────────────────────── */

async function handle(req, res) {
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

  if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(req)) {
    return json(res, 403, { ok: false, message: '跨站请求被拒绝' });
  }

  if (url.pathname === '/api/health' && method === 'GET') {
    const stats = await store.stats();
    return json(res, 200, {
      ok: true,
      app: 'ai-image-generator',
      name: '蓝晒 · AI 图片生成器',
      version: VERSION,
      engine: engineInfo(),
      models: {
        total: registry.cache.all.length,
        image: registry.cache.images.length,
        source: registry.cache.source,
      },
      history: { count: stats.count, bytes: stats.bytes },
      community: { count: community.count() },
      savedPresets: presets.list().saved.length,
      presets: Styles.listPresets(),
    });
  }

  if (url.pathname === '/api/presets' && method === 'GET') {
    return json(res, 200, Object.assign({ ok: true }, Styles.listPresets()));
  }

  if (url.pathname === '/api/models' && method === 'GET') return handleModels(req, res, url);
  if (url.pathname === '/api/models' && method === 'POST') return handleVerify(req, res);
  if (url.pathname === '/api/prompt/optimize' && method === 'POST') return handleOptimize(req, res);
  if (url.pathname === '/api/images/generate' && method === 'POST') return handleGenerate(req, res);
  if (url.pathname === '/api/images/edit' && method === 'POST') return handleEdit(req, res);
  if (url.pathname === '/api/images/import' && method === 'POST') return handleImport(req, res);
  if (url.pathname === PRESET_ROUTE || url.pathname.startsWith(PRESET_ROUTE + '/')) {
    return handlePresets(req, res, url, method);
  }
  if (url.pathname === '/api/community' || url.pathname.startsWith('/api/community/')) {
    return handleCommunity(req, res, url, method);
  }
  if (url.pathname.startsWith('/api/history')) return handleHistory(req, res, url, method);
  if (url.pathname.startsWith('/api/images/') && method === 'GET') return handleImageFile(req, res, url);

  return json(res, 404, { ok: false, message: '没有这个接口：' + url.pathname });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[error]', req.method, req.url, err && err.stack ? err.stack : err);
    if (res.headersSent) {
      try {
        res.end();
      } catch {
        /* 已经断开 */
      }
      return;
    }
    json(res, 500, { ok: false, message: (err && err.message) || '服务端出错了' });
  });
});

/* ── 启动 ───────────────────────────────────────────────── */

function banner(actualPort, listed, chat) {
  console.log(`蓝晒 · AI 图片生成器 已启动：http://${HOST}:${actualPort}/`);
  if (config.live) {
    console.log(`  上游地址：${config.baseUrl}（Key 来自 ${config.keyFrom}）`);
    if (listed && listed.error) console.log(`  ⚠ ${listed.note}`);
    const count = (listed && listed.images.length) || 0;
    if (count) {
      const via = listed.source === 'upstream' ? '账号模型列表' : '平台文档（列表里没列出来）';
      console.log(`  可出图的模型 ${count} 个，来自${via}：${listed.images.join('、')}`);
    } else {
      console.log('  没有认出可出图的模型：界面右侧会说明原因，也可以直接输入模型名');
    }
    if (chat && chat.verified) console.log(`  优化提示词用：${chat.model}`);
    else if (chat && chat.note) console.log(`  ⚠ 优化提示词：${chat.note}`);
    console.log('  可用性检测要点「检测」才跑（会生成一张最低画质的图，花一点点额度）');
  } else {
    console.log(`  出图方式：${config.reason}`);
    console.log('  接入真实模型：设置 OPENAI_HK_API_KEY（或 OPENAI_API_KEY / DEEPSEEK_API_KEY）');
    console.log('  别家平台（中转、聚合）的 Key 还要设地址：AI_BASE_URL（可选 AI_IMAGE_MODEL / AI_MODEL）');
    console.log('  没有 Key 时用离线显影引擎：按提示词画一张 PNG，链路（历史 / 下载）照样能走通');
  }
  console.log('  历史目录：' + path.join(DATA_DIR, 'history'));
  console.log('  图片目录：' + path.join(DATA_DIR, 'images'));
  console.log('  按 Ctrl+C 停止。');
}

/**
 * 启动服务。测试里用 port=0 拿随机端口，所以「建服务」和「监听」分开。
 *
 * 监听之后先做两件几乎不花钱的事：拉一次模型列表（了解有哪些能出图的模型）、
 * 用 1 个 token 探一下聊天模型（优化提示词要用它）。**不**批量实测出图模型 ——
 * 那要花钱，什么时候试由用户点「检测」决定。
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

      await store.ready().catch((err) => console.warn('[store] 初始化失败：' + err.message));

      let listed = null;
      let chat = null;
      if (config.live && opt.probe !== false) {
        if (opt.banner !== false) console.log('  正在问上游有哪些模型……');
        listed = await registry.list().catch(() => null);
        chat = await registry.probeChat().catch(() => null);
      }
      if (opt.banner !== false) banner(actual, listed, chat);

      resolve({
        port: actual,
        url: `http://${HOST}:${actual}/`,
        registry,
        store,
        config,
        listed,
        chat,
        close: () =>
          new Promise((r) => {
            const timer = setTimeout(r, 1500);
            if (typeof timer.unref === 'function') timer.unref();
            server.close(() => {
              clearTimeout(timer);
              r();
            });
          }),
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
  registry,
  store,
  statusStore,
  engineInfo,
  ROOT,
  DATA_DIR,
};
