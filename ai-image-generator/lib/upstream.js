/*!
 * 蓝晒 · AI 图片生成器 —— 上游接入（upstream.js，仅服务端）
 *
 * 只认 OpenAI 兼容协议，所以 OpenAI-HK 这类聚合平台可以直接接：
 *   · 出图：POST {base}/images/generations   （DALL·E / gpt-image 系列同一套形状）
 *   · 列模型：GET  {base}/models
 *   · 优提示词：POST {base}/chat/completions  （用平台上的对话模型扩写描述）
 *
 * Key 只从环境变量读，**代码里不留任何 key 字面量**；没有 Key 时不报错，
 * 由 server.js 切到离线显影引擎，界面上如实说明。
 */
'use strict';

const DEFAULTS = {
  baseUrl: 'https://api.openai-hk.com/v1',
  chatModel: 'gpt-4o-mini',
  imageModel: 'gpt-image-2',
  stallMs: 60000,
  chatTimeoutMs: 90000,
  // 出图（尤其是一次多张 / 高画质）本来就慢：一张 1K 图常见 75~150 秒，
  // 一批两张甚至能到几分钟。超时定得太短，钱花了图却被我们自己掐断 —— 那是最冤的。
  imageTimeoutMs: 600000,
  listTimeoutMs: 15000,
  downloadTimeoutMs: 60000,
  maxImageBytes: 32 * 1024 * 1024,
};

/** Key 从这几个变量里找，先找到先用。名字列在这里，值永远不进代码。 */
const KEY_ENVS = ['OPENAI_HK_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY'];

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value == null ? '' : value).trim().toLowerCase());
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 上游多久没有新内容就算卡住；可用 AI_STALL_TIMEOUT_MS 覆盖 */
function stallMsOf(options) {
  if (options && options.stallMs) return Number(options.stallMs);
  return num(process.env.AI_STALL_TIMEOUT_MS, DEFAULTS.stallMs);
}

/**
 * 读取接入配置；live=false 表示走离线显影引擎。
 * @param {object} [env] 默认 process.env（测试里可以喂假的）
 */
function readConfig(env) {
  const e = env || process.env;
  let apiKey = '';
  let keyFrom = '';
  for (const name of KEY_ENVS) {
    const value = String(e[name] || '').trim();
    if (value) {
      apiKey = value;
      keyFrom = name;
      break;
    }
  }
  const baseUrl = String(e.AI_BASE_URL || e.OPENAI_BASE_URL || DEFAULTS.baseUrl).replace(/\/+$/, '');
  const forced = truthy(e.AI_FORCE_OFFLINE) || truthy(e.AI_FORCE_MOCK);
  const live = Boolean(apiKey) && !forced;
  return {
    apiKey,
    keyFrom,
    baseUrl,
    chatModel: String(e.AI_MODEL || e.OPENAI_MODEL || DEFAULTS.chatModel).trim(),
    imageModel: String(e.AI_IMAGE_MODEL || e.OPENAI_IMAGE_MODEL || DEFAULTS.imageModel).trim(),
    live,
    reason: live
      ? '已接入上游模型'
      : forced
        ? '已按 AI_FORCE_OFFLINE 强制使用离线显影引擎'
        : '未检测到 API Key，当前由离线显影引擎出图',
  };
}

const ERRORS = [
  {
    test: (s) => s === 401 || s === 403,
    // 最常见的误会：拿别家平台的 Key，却没设 AI_BASE_URL，请求打到了默认上游
    text:
      'API Key 无效或没有该模型的权限。请检查 OPENAI_HK_API_KEY；' +
      '如果用的是别家平台（中转、聚合）发的 Key，还要把 AI_BASE_URL 设成那家的地址，否则请求会打到默认上游',
  },
  { test: (s) => s === 402, text: '账户余额不足，请先充值' },
  {
    test: (s) => s === 400 || s === 422,
    text: '上游拒绝了这次请求：多半是尺寸、画质不被该模型支持，或者提示词触发了内容审核',
  },
  {
    test: (s) => s === 404,
    text: '模型名或接口地址不对：确认这个模型在当前账号下存在（模型下拉框里列的是列表里能出图的那些），并检查 AI_BASE_URL 是否指向了你以为的那家平台',
  },
  { test: (s) => s === 413, text: '请求体过大，把提示词缩短一些再试' },
  { test: (s) => s === 429, text: '请求过于频繁或已超出配额，稍后再试' },
  { test: (s) => s >= 500, text: '上游服务暂时不可用，稍后再试' },
];

/**
 * 把文本里的凭据抹掉。
 *
 * 为什么需要：上游的错误正文会被原样带进提示、日志和界面（这是必要的，否则排查无从下手）。
 * 但中转平台把请求头回带进错误体是真实存在的情况——一旦发生，Key 就会出现在页面上和日志里。
 * 所以任何来自上游的文本在出口处统一脱敏。
 *
 * @param {string} text 待处理的文本
 * @param {string} [apiKey] 当前使用的 Key，出现即整体替换
 */
function redact(text, apiKey) {
  let out = String(text == null ? '' : text);
  if (apiKey && apiKey.length >= 6) out = out.split(apiKey).join('***');
  return out
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{6,}=*/gi, '$1 ***')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '***')
    .replace(/\b(sk|hk|rk|pk|sk-ant|glpat)-[A-Za-z0-9_-]{6,}/g, '$1-***')
    .replace(/\bAKIA[0-9A-Z]{12,}\b/g, '***')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '***');
}

function describeStatus(status, bodyText, apiKey) {
  const hit = ERRORS.find((e) => e.test(status));
  const detail = redact(String(bodyText || '').replace(/\s+/g, ' '), apiKey).slice(0, 220);
  const base = hit ? hit.text : `上游返回 ${status}`;
  return detail ? `${base}（${detail}）` : base;
}

class UpstreamError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status || 0;
  }
}

/** 组合多个中止信号：外部取消 / 整体超时 / 长时间没有新内容 */
function makeGuard(signal, stallMs, timeoutMs) {
  const ctrl = new AbortController();
  let stallTimer = null;
  let killed = null;

  const onAbort = () => {
    killed = 'cancel';
    ctrl.abort();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const hardTimer = setTimeout(() => {
    killed = 'timeout';
    ctrl.abort();
  }, timeoutMs);
  if (typeof hardTimer.unref === 'function') hardTimer.unref();

  const bump = (ms) => {
    if (!stallMs) return;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      killed = 'stall';
      ctrl.abort();
    }, ms || stallMs);
    if (typeof stallTimer.unref === 'function') stallTimer.unref();
  };
  bump();

  return {
    signal: ctrl.signal,
    // 报错时要说「卡了多少秒」，就得把真实用的那个值带出去，不能回头猜默认值
    stallMs,
    bump,
    killed: () => killed,
    dispose() {
      if (stallTimer) clearTimeout(stallTimer);
      clearTimeout(hardTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

function toError(err, guard, label, apiKey) {
  if (err && err.name === 'AbortError') {
    const why = guard ? guard.killed() : null;
    if (why === 'timeout') return new UpstreamError(`${label}超时，请稍后再试或换个小一点的尺寸`, 0);
    if (why === 'stall') {
      const seconds = Math.max(1, Math.round(((guard && guard.stallMs) || DEFAULTS.stallMs) / 1000));
      return new UpstreamError(`${label}卡住了：${seconds} 秒没有新内容`, 0);
    }
    return new UpstreamError(`${label}已取消`, 0);
  }
  if (err instanceof UpstreamError) return err;
  return new UpstreamError(`${label}失败：${redact((err && err.message) || err, apiKey)}`, 0);
}

/** 出图/改图的超时：默认 10 分钟，可用 AI_IMAGE_TIMEOUT_MS 覆盖（一次多张时给宽一点） */
function imageTimeoutMsOf(options) {
  const fromOptions = Number(options && options.timeoutMs);
  if (Number.isFinite(fromOptions) && fromOptions > 0) return fromOptions;
  return num(process.env.AI_IMAGE_TIMEOUT_MS, DEFAULTS.imageTimeoutMs);
}

function authHeaders(apiKey) {
  return { authorization: `Bearer ${apiKey}` };
}

/**
 * 取上游模型列表（只负责取，不负责筛）。拿不到不抛错，返回 ok:false 让上层决定。
 */
async function listModels(config, options) {
  const opt = options || {};
  const guard = makeGuard(opt.signal, 15000, num(opt.timeoutMs, DEFAULTS.listTimeoutMs));
  try {
    const res = await fetch(`${config.baseUrl}/models`, {
      headers: Object.assign({ accept: 'application/json' }, authHeaders(config.apiKey)),
      signal: guard.signal,
    });
    const bodyText = await res.text().catch(() => '');
    if (!res.ok) {
      return { ok: false, ids: [], error: describeStatus(res.status, bodyText, config.apiKey) };
    }
    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      return { ok: false, ids: [], error: '上游返回的模型列表不是合法 JSON' };
    }
    const rows = Array.isArray(data) ? data : data.data || [];
    const ids = rows
      .map((m) => (m && (m.id || m.model || m.name)) || '')
      .filter((id) => typeof id === 'string' && id.trim())
      .map((id) => id.trim());
    return { ok: true, ids: Array.from(new Set(ids)), error: '' };
  } catch (err) {
    return { ok: false, ids: [], error: toError(err, guard, '取模型列表', config.apiKey).message };
  } finally {
    guard.dispose();
  }
}

/* ── 从上游的响应里把图片抠出来 ─────────────────────────────
 *
 * 这一段的厚度是被真实情况逼出来的：同一个「OpenAI 兼容」的 /v1/images/generations，
 * 不同平台 / 不同模型给回来的形状并不统一 ——
 *
 *   { data: [ { b64_json } ] }                      → 标准 DALL·E / gpt-image + response_format=b64_json
 *   { data: [ { url } ] }                           → 标准 DALL·E + 默认格式
 *   { data: [ { url, b64_json: null } ] }           → 两个字段都在，只有一个有值
 *   { data: [ "https://..." ] }                     → data 里直接放字符串
 *   { data: { url } }                               → data 不是数组
 *   { images: [ { url } ] }                         → 换个字段名
 *   { choices: [ { message: { content: "![x](url)" } } ] } → 聊天式返回（有的平台上 gpt-4o-image 就这样）
 *
 * 只认第一种的后果很实际：**上游已经把图生成了、额度已经扣了，我们这边却报「没有返回图片」**。
 * 所以这里把所有见过的形状都认一遍，认不出来时把「到底返回了什么」写进错误里。
 */

const MARKDOWN_URL = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/i;

function looksLikeBase64(text) {
  const value = String(text || '').trim();
  if (value.length < 32) return false;
  return /^[A-Za-z0-9+/=_\-\s]+$/.test(value);
}

/** 把一个「可能是图、可能是地址、可能什么都不是」的值归类 */
function classify(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  if (/^data:/i.test(text)) return { kind: 'data', value: text };
  if (/^https?:\/\//i.test(text)) return { kind: 'url', value: text };
  if (looksLikeBase64(text)) return { kind: 'b64', value: text };
  const md = MARKDOWN_URL.exec(text);
  if (md) return { kind: 'url', value: md[1] };
  const plain = /(https?:\/\/[^\s"'<>)]+)/i.exec(text);
  if (plain) return { kind: 'url', value: plain[1] };
  return null;
}

/** 从条目里找地址（含 markdown / 纯文本里夹的链接） */
function firstUrlOf(item) {
  for (const field of [item.url, item.image_url, item.imageUrl, item.url_string]) {
    if (!field) continue;
    const text = String(field).trim();
    if (!text) continue;
    if (/^data:/i.test(text) || /^https?:\/\//i.test(text)) return text;
    const md = MARKDOWN_URL.exec(text);
    if (md) return md[1];
    const plain = /(https?:\/\/[^\s"'<>)]+)/i.exec(text);
    if (plain) return plain[1];
  }
  return '';
}

function entryOf(item) {
  if (!item) return null;
  if (typeof item === 'string') {
    const hit = classify(item);
    if (!hit) return null;
    if (hit.kind === 'url') return { b64: '', url: hit.value, revisedPrompt: '', source: 'url' };
    return { b64: hit.value, url: '', revisedPrompt: '', source: hit.kind };
  }
  if (typeof item !== 'object') return null;

  const revisedPrompt = String(item.revised_prompt || item.revisedPrompt || '');

  // 名字里就写着 base64 的字段：直接当 base64 用。
  // 这里**不做长度判断** —— 「太短所以不是 base64」会误杀合法的短数据，
  // 而真正的判据是后面的格式嗅探（认不出是图片才会被拒绝）。
  for (const field of [item.b64_json, item.b64, item.base64, item.image_base64, item.image_b64]) {
    if (!field) continue;
    const text = String(field).trim();
    if (!text) continue;
    const url = firstUrlOf(item);
    if (/^data:/i.test(text)) return { b64: text, url, revisedPrompt, source: 'data-url' };
    if (/^https?:\/\//i.test(text)) return { b64: '', url: text, revisedPrompt, source: 'url' };
    return { b64: text, url, revisedPrompt, source: 'b64' };
  }

  const url = firstUrlOf(item);
  if (url) return { b64: '', url, revisedPrompt, source: 'url' };

  // 只剩一个含糊的 image 字段：可能是 base64，也可能是地址
  if (item.image) {
    const hit = classify(item.image);
    if (!hit) return null;
    if (hit.kind === 'url') return { b64: '', url: hit.value, revisedPrompt, source: 'url' };
    return { b64: hit.value, url: '', revisedPrompt, source: hit.kind };
  }
  return null;
}

/** 把整个响应体里的候选值都摊平 */
function collectImageEntries(data) {
  const buckets = [];
  const push = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach((item) => buckets.push(item));
      return;
    }
    buckets.push(value);
  };

  const root = data && typeof data === 'object' ? data : {};
  push(root.data);
  push(root.images);
  push(root.output);
  push(root.image);
  push(root.result);

  const choices = Array.isArray(root.choices) ? root.choices : [];
  for (const choice of choices) {
    const message = choice && choice.message;
    if (!message) continue;
    push(message.images);
    if (typeof message.content === 'string') push(message.content);
  }

  const out = [];
  const seen = new Set();
  for (const item of buckets) {
    const entry = entryOf(item);
    if (!entry) continue;
    // 去重用**整段**数据：base64 的头几十个字符对所有 PNG 都一样，
    // 只比前缀会把「一次出多张」里除了第一张以外全当成重复丢掉
    const key = entry.b64 || entry.url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/** 认不出来时，把「上游到底返回了什么形状」写进报错里，别让人靠猜 */
function describeShape(data) {
  if (!data || typeof data !== 'object') return '响应体不是对象';
  const keys = Object.keys(data).slice(0, 8).join(' / ') || '(没有字段)';
  const first = Array.isArray(data.data) ? data.data[0] : data.data;
  let inner = '无';
  if (Array.isArray(data.data)) inner = data.data.length ? `数组(${data.data.length})` : '空数组';
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    inner += `，第一个元素字段：${Object.keys(first).slice(0, 8).join(' / ') || '(空对象)'}`;
  }
  return `响应字段：${keys}；data：${inner}`;
}

/**
 * 文生图。
 *
 * **报文里不带 `n`**：一次就一张。平台对 n 的脾气很不一致（有的直接 400，
 * 有的收下 n 却只回一张），而额度是按 n 扣的 —— 一次要 2 张却只拿回 1 张，
 * 是最难受的失败。所以这里干脆不管 n，默认值就是 1。
 *
 * @param {object} options
 *   apiKey, baseUrl, model, prompt, size, quality, responseFormat, signal, timeoutMs
 * @returns {Promise<{images: Array<{b64: string, url: string, revisedPrompt: string, source: string}>, usage: object|null, raw: object}>}
 */
async function generateImage(options) {
  const o = options || {};
  const requestedFormat = o.responseFormat || 'b64_json';
  const base = {
    model: o.model,
    prompt: o.prompt,
    response_format: requestedFormat,
  };
  if (o.size) base.size = o.size;
  if (o.quality) base.quality = o.quality;

  const attempt = async (payload) => {
    const guard = makeGuard(o.signal, 0, imageTimeoutMsOf(o));
    try {
      const res = await fetch(`${o.baseUrl}/images/generations`, {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json', accept: 'application/json' }, authHeaders(o.apiKey)),
        body: JSON.stringify(payload),
        signal: guard.signal,
      });
      const bodyText = await res.text().catch(() => '');
      return { res, bodyText, guard };
    } catch (err) {
      guard.dispose();
      throw toError(err, guard, '请求上游出图', o.apiKey);
    }
  };

  let { res, bodyText, guard } = await attempt(base);
  // 有的模型/网关不认 response_format：去掉再试一次，拿回 URL 之后由服务端自己下载保存
  if (!res.ok && 'response_format' in base && (res.status === 400 || res.status === 422)) {
    guard.dispose();
    const fallback = Object.assign({}, base);
    delete fallback.response_format;
    ({ res, bodyText, guard } = await attempt(fallback));
  }
  try {
    if (!res.ok) throw new UpstreamError(describeStatus(res.status, bodyText, o.apiKey), res.status);
    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      throw new UpstreamError('上游返回的不是合法 JSON', 0);
    }
    if (data && data.error) {
      throw new UpstreamError(redact(data.error.message || '上游返回错误', o.apiKey), 0);
    }
    const images = collectImageEntries(data);
    const shape = describeShape(data);
    if (typeof o.log === 'function') {
      const kinds = images.map((img) => (img.b64 ? 'b64' : 'url'));
      o.log(`上游出图 → 拿到 ${images.length} 张（${kinds.join('/') || '没有'  }）`);
    }
    if (!images.length) {
      // 调不通的时候把「上游到底返回了什么」写进日志和错误里 —— 这一步是花钱买的，不能白花
      if (process.env.AIG_DEBUG === '1') {
        console.error('[上游原始返回]', redact(bodyText, o.apiKey).slice(0, 600));
      }
      throw new UpstreamError(
        `上游返回成功，但里面找不到图片数据（${shape}）。这一次的额度可能已经扣了 —— ` +
          '把这段贴出来就能定位是哪种返回形状没认出来',
        0
      );
    }
    return { images, usage: (data && data.usage) || null, raw: data, shape };
  } finally {
    guard.dispose();
  }
}

/**
 * 改图：基于一张（或多张）已有图片，按提示词改。
 *
 * 走的是 `/v1/images/edits`（multipart/form-data），响应形状和文生图一样，
 * 所以解析那段（collectImageEntries）与出图共用。
 *
 * @param {object} options
 *   apiKey, baseUrl, model, prompt, images: [{buffer, mime, filename}], size, quality, signal, timeoutMs
 */
async function editImage(options) {
  const o = options || {};
  const list = (o.images || []).filter((img) => img && img.buffer && img.buffer.length);
  if (!list.length) throw new UpstreamError('没有可编辑的原图', 0);

  const build = (withFormat) => {
    const form = new FormData();
    form.append('model', String(o.model || ''));
    form.append('prompt', String(o.prompt || ''));
    if (o.size) form.append('size', String(o.size));
    if (o.quality) form.append('quality', String(o.quality));
    // 和出图一样：表单里不带 n，一次就改出一张
    if (withFormat) form.append('response_format', o.responseFormat || 'b64_json');
    // gpt-image 支持多张参考图，字段名是 image[]；单张也用它，平台两种都收
    const field = list.length > 1 ? 'image[]' : 'image';
    list.forEach((img, index) => {
      const blob = new Blob([img.buffer], { type: img.mime || 'image/png' });
      form.append(field, blob, img.filename || `source-${index + 1}.png`);
    });
    return form;
  };

  const attempt = async (withFormat) => {
    const guard = makeGuard(o.signal, 0, imageTimeoutMsOf(o));
    try {
      const res = await fetch(`${o.baseUrl}/images/edits`, {
        method: 'POST',
        // multipart 的 content-type（含 boundary）由 fetch 自己填，别手动设
        headers: Object.assign({ accept: 'application/json' }, authHeaders(o.apiKey)),
        body: build(withFormat),
        signal: guard.signal,
      });
      const bodyText = await res.text().catch(() => '');
      return { res, bodyText, guard };
    } catch (err) {
      guard.dispose();
      throw toError(err, guard, '请求上游改图', o.apiKey);
    }
  };

  let { res, bodyText, guard } = await attempt(true);
  if (!res.ok && (res.status === 400 || res.status === 422)) {
    // 有的平台不认 response_format：去掉再试一次（拿回 URL 我们自己下载）
    guard.dispose();
    ({ res, bodyText, guard } = await attempt(false));
  }
  try {
    if (!res.ok) throw new UpstreamError(describeStatus(res.status, bodyText, o.apiKey), res.status);
    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      throw new UpstreamError('上游返回的不是合法 JSON', 0);
    }
    if (data && data.error) {
      throw new UpstreamError(redact(data.error.message || '上游返回错误', o.apiKey), 0);
    }
    const images = collectImageEntries(data);
    const shape = describeShape(data);
    if (typeof o.log === 'function') {
      const kinds = images.map((img) => (img.b64 ? 'b64' : 'url'));
      o.log(`上游改图 → 拿到 ${images.length} 张（${kinds.join('/') || '没有'}）`);
    }
    if (!images.length) {
      if (process.env.AIG_DEBUG === '1') {
        console.error('[上游原始返回]', redact(bodyText, o.apiKey).slice(0, 600));
      }
      throw new UpstreamError(
        `上游返回成功，但里面找不到改好的图片（${shape}）。这个模型可能不支持改图，换个模型试试`,
        0
      );
    }
    return { images, usage: (data && data.usage) || null, raw: data, shape };
  } finally {
    guard.dispose();
  }
}

/**
 * 一次性取回完整文本（优化提示词用，不需要逐字上屏）。
 */
async function chatOnce(options) {
  const o = options || {};
  const guard = makeGuard(o.signal, stallMsOf(o), num(o.timeoutMs, DEFAULTS.chatTimeoutMs));
  const body = {
    model: o.model,
    messages: o.messages,
    temperature: o.temperature === undefined ? 0.3 : o.temperature,
    max_tokens: o.maxTokens || 1200,
    stream: false,
  };
  if (o.jsonMode) body.response_format = { type: 'json_object' };

  const send = async () =>
    fetch(`${o.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, authHeaders(o.apiKey)),
      body: JSON.stringify(body),
      signal: guard.signal,
    });

  try {
    let res = await send();
    // 有的兼容网关不认 response_format，去掉再试一次
    if (!res.ok && o.jsonMode && (res.status === 400 || res.status === 422)) {
      delete body.response_format;
      res = await send();
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new UpstreamError(describeStatus(res.status, bodyText, o.apiKey), res.status);
    }
    const data = await res.json();
    const choice = data.choices && data.choices[0];
    const text = (choice && choice.message && choice.message.content) || '';
    if (!String(text).trim()) throw new UpstreamError('上游返回了空内容，请再试一次', 0);
    return { text: String(text), usage: data.usage || null, finishReason: (choice && choice.finish_reason) || '' };
  } catch (err) {
    throw toError(err, guard, '请求上游模型', o.apiKey);
  } finally {
    guard.dispose();
  }
}

/**
 * 把上游给的图片地址下回来。
 *
 * 为什么不让浏览器直接引用上游地址：这类中转给的链接会过期、可能带防盗链，
 * 而「历史记录 + 下载」要求这些图必须落成自己的文件。
 *
 * 现实里有两类坑，都在这儿处理：
 *   · 有的网关把图放在需要鉴权的路径下 —— 先不带 Key 试一次，401/403 再带上重试
 *   · 有的图床只放行浏览器（按 User-Agent 拦）—— 所以就带一个正常的 UA 和 Accept
 */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

async function fetchImageBytes(url, options) {
  const o = options || {};
  const maxBytes = num(o.maxBytes, DEFAULTS.maxImageBytes);
  const guard = makeGuard(o.signal, 0, num(o.timeoutMs, DEFAULTS.downloadTimeoutMs));
  const request = (withAuth) =>
    fetch(url, {
      signal: guard.signal,
      headers: Object.assign(
        {
          accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5',
          'user-agent': BROWSER_UA,
        },
        withAuth && o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}
      ),
    });

  try {
    let res = await request(false);
    if ((res.status === 401 || res.status === 403) && o.apiKey) {
      res = await request(true);
    }
    if (!res.ok) {
      const type = res.headers.get('content-type') || '未知类型';
      throw new UpstreamError(`下载上游图片失败：HTTP ${res.status}（${type}）`, res.status);
    }
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared && declared > maxBytes) {
      throw new UpstreamError(`上游图片太大（${Math.round(declared / 1024 / 1024)}MB），已放弃下载`, 0);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new UpstreamError('上游图片太大，已放弃下载', 0);
    }
    if (!buffer.length) throw new UpstreamError('上游图片是空的', 0);
    return { buffer, contentType: String(res.headers.get('content-type') || '') };
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    throw toError(err, guard, '下载上游图片', o.apiKey);
  } finally {
    guard.dispose();
  }
}

module.exports = {
  DEFAULTS,
  KEY_ENVS,
  UpstreamError,
  readConfig,
  describeStatus,
  redact,
  listModels,
  generateImage,
  editImage,
  collectImageEntries,
  describeShape,
  chatOnce,
  fetchImageBytes,
  makeGuard,
  stallMsOf,
  imageTimeoutMsOf,
};
