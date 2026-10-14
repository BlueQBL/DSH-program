/*!
 * 三易 · 智能写作台 —— 上游模型接入（llm.js，仅服务端）
 *
 * 只说 OpenAI 兼容协议（DeepSeek / OpenAI / 各类兼容网关都能接）。
 * 没有 Key 时不报错，交给 server.js 切到离线引擎，界面上一句话说明白。
 */
'use strict';

const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  stallMs: 60000,
  timeoutMs: 180000,
};

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value == null ? '' : value).trim().toLowerCase());
}

/** 上游多久没有新内容就算卡住；可用 AI_STALL_TIMEOUT_MS 覆盖 */
function stallMsOf(options) {
  if (options && options.stallMs) return Number(options.stallMs);
  const fromEnv = Number(process.env.AI_STALL_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULTS.stallMs;
}

/** 读取环境变量里的接入配置；live=false 表示走离线引擎 */
function readConfig(env) {
  const e = env || process.env;
  const apiKey = String(e.DEEPSEEK_API_KEY || e.OPENAI_API_KEY || '').trim();
  const baseUrl = String(e.AI_BASE_URL || e.OPENAI_BASE_URL || DEFAULTS.baseUrl).replace(/\/+$/, '');
  const model = String(e.AI_MODEL || e.OPENAI_MODEL || DEFAULTS.model).trim();
  const forced = truthy(e.AI_FORCE_OFFLINE) || truthy(e.AI_FORCE_MOCK);
  const live = Boolean(apiKey) && !forced;
  return {
    apiKey,
    baseUrl,
    model,
    live,
    // 「当前用哪个模型」由探测结果决定，这里只说清是不是接了真实模型
    reason: live ? '已接入上游模型' : forced ? '已按 AI_FORCE_OFFLINE 强制使用离线引擎' : '未检测到 API Key，当前由离线引擎成稿',
  };
}

const ERRORS = [
  {
    test: (s) => s === 401 || s === 403,
    // 最常见的误会：用别家平台的 Key，却没设 AI_BASE_URL，请求打到了默认上游。
    // 只提示「Key 无效」会让人去查一个没问题的 Key，所以这里直接把那句话说破。
    text: 'API Key 无效或没有该模型的权限。请检查 DEEPSEEK_API_KEY；如果用的是别家平台（中转、聚合）发的 Key，还要把 AI_BASE_URL 设成那家的地址，否则请求会打到默认上游',
  },
  { test: (s) => s === 402, text: '账户余额不足，请先充值' },
  {
    test: (s) => s === 404,
    text: '模型名或接口地址不对：确认 AI_MODEL 在当前上游存在（启动探测的日志里会列出可用的那些），并检查 AI_BASE_URL 是否指向了你以为的那家平台',
  },
  { test: (s) => s === 429, text: '请求过于频繁或已超出配额，稍后再试' },
  { test: (s) => s >= 500, text: '上游服务暂时不可用，稍后再试' },
];

/**
 * 把文本里的凭据抹掉。
 *
 * 为什么需要：上游的错误正文会被原样带进提示、日志和界面（这是必要的，否则
 * 排查无从下手）。但中转平台把请求头回带进错误体是真实存在的情况——一旦发生，
 * API Key 就会出现在页面上和日志文件里。所以任何来自上游的文本在出口处统一脱敏。
 *
 * @param {string} text 待处理的文本
 * @param {string} [apiKey] 当前使用的 Key，出现即整体替换
 */
function redact(text, apiKey) {
  let out = String(text == null ? '' : text);
  if (apiKey && apiKey.length >= 6) out = out.split(apiKey).join('***');
  // 先按整体形态抹（Bearer / JWT），再按各家前缀抹：
  // 顺手把前缀也吃掉，少留一点「这是哪家的 Key」的线索
  return out
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{6,}=*/gi, '$1 ***')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '***')
    .replace(/\b(sk|hk|rk|pk|sk-ant|glpat)-[A-Za-z0-9_-]{6,}/g, '$1-***')
    .replace(/\bAKIA[0-9A-Z]{12,}\b/g, '***')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '***');
}

function describeStatus(status, bodyText, apiKey) {
  const hit = ERRORS.find((e) => e.test(status));
  const detail = redact(String(bodyText || '').replace(/\s+/g, ' '), apiKey).slice(0, 200);
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

  const bump = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      killed = 'stall';
      ctrl.abort();
    }, stallMs);
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
    if (why === 'timeout') return new UpstreamError(`${label}超时，请缩短篇幅或稍后再试`, 0);
    if (why === 'stall') {
      // 探测用的是很短的停顿阈值，这里要报真实秒数，否则日志会误导排查方向
      const seconds = Math.max(1, Math.round(((guard && guard.stallMs) || DEFAULTS.stallMs) / 1000));
      return new UpstreamError(`${label}卡住了：${seconds} 秒没有新内容`, 0);
    }
    return new UpstreamError(`${label}已取消`, 0);
  }
  if (err instanceof UpstreamError) return err;
  // fetch 的报错里可能带着完整 URL（有的网关把 key 放查询串），出口统一脱敏
  return new UpstreamError(`${label}失败：${redact((err && err.message) || err, apiKey)}`, 0);
}

/**
 * 流式对话。逐块 yield {type:'delta', text}，结束 yield {type:'usage', usage}。
 * 任何异常都抛 UpstreamError（带中文说明），由上层决定是否降级。
 */
async function* streamChat(options) {
  const { apiKey, baseUrl, model, messages, temperature, maxTokens, signal } = options;
  const stallMs = stallMsOf(options);
  const guard = makeGuard(signal, stallMs, Number(options.timeoutMs || DEFAULTS.timeoutMs));

  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: guard.signal,
    });
  } catch (err) {
    guard.dispose();
    throw toError(err, guard, '连接上游', apiKey);
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    guard.dispose();
    throw new UpstreamError(describeStatus(res.status, bodyText, apiKey), res.status);
  }
  if (!res.body) {
    guard.dispose();
    throw new UpstreamError('上游没有返回内容流', 0);
  }

  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let sawText = false;
  try {
    for await (const chunk of res.body) {
      guard.bump();
      buffer += decoder.decode(chunk, { stream: true });
      // SSE 事件以空行分隔；只处理 data: 行
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let data;
        try {
          data = JSON.parse(payload);
        } catch {
          continue;
        }
        if (data.error) throw new UpstreamError(data.error.message || '上游返回错误', 0);
        const choice = data.choices && data.choices[0];
        if (!choice) continue;
        const piece =
          (choice.delta && (choice.delta.content || '')) ||
          (choice.message && choice.message.content) ||
          '';
        if (piece) {
          sawText = true;
          yield { type: 'delta', text: piece };
        }
      }
    }
    if (buffer.startsWith('data:')) {
      const payload = buffer.slice(5).trim();
      if (payload && payload !== '[DONE]' && payload.charAt(0) === '{') {
        try {
          const data = JSON.parse(payload);
          const choice = data.choices && data.choices[0];
          const piece = choice && choice.delta && choice.delta.content;
          if (piece) yield { type: 'delta', text: piece };
        } catch {
          /* 尾部半截 JSON 丢掉即可 */
        }
      }
    }
  } catch (err) {
    throw toError(err, guard, '接收上游内容', apiKey);
  } finally {
    guard.dispose();
  }

  if (!sawText) throw new UpstreamError('上游返回了空内容，请换个说法再试一次', 0);
  yield { type: 'usage', usage: null };
}

/** 一次性取回完整文本（一键优化用，不需要逐字上屏） */
async function chatOnce(options) {
  const { apiKey, baseUrl, model, messages, temperature, maxTokens, signal } = options;
  const guard = makeGuard(signal, stallMsOf(options), Number(options.timeoutMs || DEFAULTS.timeoutMs));
  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (options.jsonMode) body.response_format = { type: 'json_object' };

  try {
    let res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: guard.signal,
    });
    // 有的兼容网关不认 response_format，去掉再试一次
    if (!res.ok && options.jsonMode && (res.status === 400 || res.status === 422)) {
      delete body.response_format;
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: guard.signal,
      });
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new UpstreamError(describeStatus(res.status, bodyText, apiKey), res.status);
    }
    const data = await res.json();
    const choice = data.choices && data.choices[0];
    const text = (choice && choice.message && choice.message.content) || '';
    if (!String(text).trim()) throw new UpstreamError('上游返回了空内容，请再试一次', 0);
    return {
      text: String(text),
      usage: data.usage || null,
      finishReason: (choice && choice.finish_reason) || '',
    };
  } catch (err) {
    throw toError(err, guard, '请求上游', apiKey);
  } finally {
    guard.dispose();
  }
}

/** 探活：列出可用模型，用于界面上「测试连接」 */
async function listModels(config, signal) {
  const guard = makeGuard(signal, 15000, 20000);
  try {
    const res = await fetch(`${config.baseUrl}/models`, {
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal: guard.signal,
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new UpstreamError(describeStatus(res.status, bodyText, apiKey), res.status);
    }
    const data = await res.json();
    const ids = (data.data || []).map((m) => m && m.id).filter(Boolean);
    return { ok: true, models: ids };
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    throw toError(err, guard, '连接测试', config.apiKey);
  } finally {
    guard.dispose();
  }
}

/* ══════════════════════════════════════════════════════════
 * 模型注册表：启动探测 + 列表缓存 + 请求级选择
 *
 * 聚合平台（OpenAI-HK、各类中转）动不动列几百个模型，里面混着向量、语音、
 * 画图、审核，真正能拿来写文章的只是一部分。所以这里做三件事：
 *   1. 把列表里不能写字的模型滤掉，再按「适合写作」的顺序排好
 *   2. 开机拿一个 1 token 的极小请求实测默认模型是否真的能调通
 *   3. 页面上选定的模型只影响本次请求；选了一个不在列表里的，说清楚并退回默认
 * ══════════════════════════════════════════════════════════ */

const MODEL_LIST_TTL = 5 * 60 * 1000;

/** 账号级的问题：换模型也救不回来，探测时遇到就直接停 */
const GLOBAL_FAILURES = new Set([400, 401, 402, 403, 405, 422, 429]);

/** 明显不是聊天模型的：向量、语音、画图、审核、重排 */
const NON_CHAT = /embed|whisper|tts|audio|speech|voice|transcri|dall|image|vision-only|moderation|rerank|bge-|m3e|stable-diffusion|sdxl|flux|sora|veo|kling|seedance|clip-|ocr|asr|codex-mini|davinci|babbage|ada-|curie/i;

/** 排序偏好：越靠前越可能是「拿来写文章」的通用模型 */
const PREFERRED = [
  /^deepseek-chat$/i,
  /^deepseek-reasoner$/i,
  /^deepseek-v\d/i,
  /^deepseek/i,
  /^gpt-4\.1($|-)/i,
  /^gpt-4o($|-)/i,
  /^gpt-4-turbo/i,
  /^chatgpt-4o/i,
  /^o[1-4]($|-)/i,
  /^claude-3[.-]5/i,
  /^claude-/i,
  /^gemini-2/i,
  /^gemini-/i,
  /^qwen(2\.5|3)?-?(max|plus|turbo|chat)?$/i,
  /^qwen/i,
  /^glm-4/i,
  /^glm/i,
  /^kimi|^moonshot/i,
  /^grok-/i,
  /^doubao/i,
  /^hunyuan/i,
  /^ernie/i,
  /^minimax|^abab/i,
  /^step-/i,
  /^spark-/i,
  /^yi-/i,
];

function filterChatModels(list) {
  return (list || []).filter((id) => typeof id === 'string' && id && !NON_CHAT.test(id));
}

function rankModel(id, configured) {
  if (configured && id === configured) return -1;
  for (let i = 0; i < PREFERRED.length; i += 1) {
    if (PREFERRED[i].test(id)) return i;
  }
  return PREFERRED.length + 1;
}

/** 把可写字的模型排好：默认模型在最前，其次是常见的通用模型，最后按名字排 */
function sortModelCandidates(list, configured) {
  return (list || [])
    .slice()
    .sort((a, b) => {
      const ra = rankModel(a, configured);
      const rb = rankModel(b, configured);
      if (ra !== rb) return ra - rb;
      return a.localeCompare(b);
    });
}

/**
 * 建一个模型注册表。一个进程一个，负责缓存列表、记住启动探测结果。
 * @param {object} config readConfig() 的结果
 * @param {object} [options] { log, probeTimeoutMs, ttl }
 */
function createModelRegistry(config, options) {
  const opt = options || {};
  const log = typeof opt.log === 'function' ? opt.log : () => {};
  const ttl = Number(opt.ttl || MODEL_LIST_TTL);
  const probeTimeoutMs = Number(opt.probeTimeoutMs || process.env.AI_PROBE_TIMEOUT_MS || 8000);

  let cache = { at: 0, all: [], chat: [], error: '' };
  let resolved = '';       // 启动探测时真正调通过的那个模型
  let verified = false;    // 探测跑过且成功
  let probed = false;      // 探测跑过（不管成没成）
  let probeNote = '';
  let inflight = null;

  /** 取上游模型列表（带缓存）；拿不到不抛错，返回 ok:false 让上层决定 */
  async function list(force) {
    if (!config.live) return { ok: false, error: config.reason, all: [], chat: [] };
    if (!force && cache.chat.length && Date.now() - cache.at < ttl) {
      return { ok: true, all: cache.all, chat: cache.chat, cached: true };
    }
    if (inflight && !force) return inflight;

    inflight = (async () => {
      const guard = makeGuard(null, 15000, Math.max(probeTimeoutMs, 12000));
      try {
        const res = await fetch(`${config.baseUrl}/models`, {
          headers: { authorization: `Bearer ${config.apiKey}` },
          signal: guard.signal,
        });
        const bodyText = await res.text().catch(() => '');
        if (!res.ok) {
          const message = describeStatus(res.status, bodyText, config.apiKey);
          cache = { at: Date.now(), all: [], chat: [], error: message };
          return { ok: false, error: message, all: [], chat: [] };
        }
        let ids = [];
        try {
          const data = JSON.parse(bodyText);
          const rows = Array.isArray(data) ? data : data.data || [];
          ids = rows.map((m) => (m && (m.id || m.model || m.name)) || '').filter(Boolean);
        } catch {
          const message = '上游返回的模型列表不是合法 JSON';
          cache = { at: Date.now(), all: [], chat: [], error: message };
          return { ok: false, error: message, all: [], chat: [] };
        }
        const all = Array.from(new Set(ids)).sort();
        const chat = sortModelCandidates(filterChatModels(all), config.model);
        cache = { at: Date.now(), all, chat, error: '' };
        return { ok: true, all, chat };
      } catch (err) {
        const message = toError(err, guard, '取模型列表', config.apiKey).message;
        cache = { at: Date.now(), all: [], chat: [], error: message };
        return { ok: false, error: message, all: [], chat: [] };
      } finally {
        guard.dispose();
      }
    })();

    try {
      return await inflight;
    } finally {
      inflight = null;
    }
  }

  /** 一个 1 token 的极小请求：只用来确认「这个模型真的调得通」 */
  async function tinyCall(model) {
    const guard = makeGuard(null, 6000, probeTimeoutMs);
    try {
      const res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
        signal: guard.signal,
      });
      if (res.ok) return { ok: true };
      const bodyText = await res.text().catch(() => '');
      return { ok: false, status: res.status, message: describeStatus(res.status, bodyText, config.apiKey) };
    } catch (err) {
      return { ok: false, status: 0, message: toError(err, guard, '探测模型', config.apiKey).message };
    } finally {
      guard.dispose();
    }
  }

  /**
   * 启动探测：找出真的能用的模型。
   * 先按列表挑几个候选（默认模型优先），再实测；认证/余额这类问题不用继续试。
   */
  async function probe() {
    if (probed) return { ok: verified, model: resolved || config.model, verified, note: probeNote };
    probed = true;

    if (!config.live) {
      probeNote = config.reason;
      return { ok: false, model: '离线引擎', verified: false, note: probeNote, offline: true };
    }

    const listed = await list();
    const ranked = listed.ok ? listed.chat : [];
    const candidates = Array.from(new Set([config.model].concat(ranked).filter(Boolean))).slice(0, 3);

    if (!listed.ok) {
      log(`⚠ 取不到模型列表：${listed.error}`);
    } else {
      log(`上游返回 ${listed.all.length} 个模型，其中可写字的 ${listed.chat.length} 个`);
    }

    for (const model of candidates) {
      const out = await tinyCall(model);
      if (out.ok) {
        resolved = model;
        verified = true;
        probeNote = '';
        log(`已验证可用模型：${model}`);
        return { ok: true, model, verified: true, note: '', chat: ranked, all: listed.all || [] };
      }
      log(`模型 ${model} 调不通：${out.message}`);
      // 认证、余额、限流是账号级问题，换模型也没用，直接停；
      // 404（模型名不存在）和 5xx（这个模型正好过载）都是单个模型的事，继续试下一个
      probeNote = out.message;
      if (out.status && GLOBAL_FAILURES.has(out.status)) {
        log(`这属于账号或配置问题（${out.status}），停止探测。`);
        return { ok: false, model, verified: false, note: out.message, chat: ranked, all: listed.all || [] };
      }
    }

    resolved = resolved || config.model;
    probeNote = candidates.length ? '候选模型都调不通，仍会按默认模型尝试' : '没有可试的模型';
    log('⚠ ' + probeNote);
    return { ok: false, model: resolved, verified: false, note: probeNote, chat: ranked, all: listed.all || [] };
  }

  /**
   * 本次请求用哪个模型。
   * 页面上选了一个不在可用列表里的，说清楚并退回默认——不悄悄换、也不直接失败。
   */
  function resolveModel(requested) {
    const want = typeof requested === 'string' ? requested.trim() : '';
    const fallback = resolved || config.model;
    if (!config.live) return { model: '', note: '当前是离线引擎，模型选择不生效' };
    if (!want) return { model: fallback, note: '' };
    if (want.length > 80) return { model: fallback, note: '模型名过长，已改用默认模型' };
    if (want === fallback || want === config.model) return { model: want, note: '' };
    if (cache.chat.length && !cache.all.includes(want)) {
      return { model: fallback, note: `${want} 不在当前账号的可用模型里，已改用 ${fallback}` };
    }
    return { model: want, note: '' };
  }

  return {
    config,
    list,
    probe,
    resolveModel,
    get resolved() {
      return resolved || config.model;
    },
    get verified() {
      return verified;
    },
    get note() {
      return probeNote;
    },
    get cache() {
      return cache;
    },
  };
}

module.exports = {
  DEFAULTS,
  MODEL_LIST_TTL,
  UpstreamError,
  readConfig,
  describeStatus,
  redact,
  streamChat,
  chatOnce,
  listModels,
  filterChatModels,
  sortModelCandidates,
  rankModel,
  createModelRegistry,
};
