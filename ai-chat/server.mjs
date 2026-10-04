// 对谈录 · server
//
// 一个零依赖的 Node HTTP 服务，做三件事：
//   1. 托管 public/ 下的静态文件（原生 HTML/CSS/JS，无构建步骤）
//   2. POST /api/chat  —— 把浏览器发来的 messages 转成上游 SSE 流，再原样流式转发给浏览器
//   3. 未配置 API Key 时，自动降级为本地离线回答（同样逐字流式），保证开箱即跑
//
// 设计原则：对话历史由客户端持有（浏览器 localStorage 是权威副本），
// 服务端只负责「转发」和「可选的耐久兜底」，不参与合并、不参与状态机。
// 这样多标签页、刷新、断流恢复都只需要一个真相来源。

import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockReply } from './lib/mock-responder.mjs';
import {
  classifyUpstreamError,
  pickModelCandidates,
  shouldTryNextModel,
  filterChatModels,
  supportsVision,
  visionModels,
} from './lib/error-mapping.mjs';
import { writeJson, readJsonBody, openEventStream, sleep, isAbort } from './lib/http-utils.mjs';
// 提示词与清洗规则放在 public/lib/title.js：浏览器和服务端 import 同一份，
// 免得两边各写一套提示词然后慢慢分叉
import { buildTitleMessages, titleFromModel } from './public/lib/title.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const DATA_DIR = path.join(HERE, 'data');
/** 用户评价的追加日志（一行一条 JSON），和兜底副本一样属于运行时数据 */
const FEEDBACK_FILE = path.join(DATA_DIR, 'feedback.jsonl');

const PORT = Number(process.env.PORT || 5250);
const HOST = process.env.HOST || '127.0.0.1';

// ---- 上游模型配置（OpenAI 兼容接口：DeepSeek / OpenAI / 硅基流动 / 本地 Ollama 均可）----
const API_KEY = (process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '').trim();
const API_BASE = (process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const API_MODEL = (process.env.AI_MODEL || process.env.OPENAI_MODEL || 'deepseek-v4.1-flash').trim();
const FORCE_MOCK = ['1', 'true', 'yes'].includes(String(process.env.AI_FORCE_MOCK || '').toLowerCase());

/** 有 Key 且没被强制降级 → 走真实模型 */
const HAS_MODEL = Boolean(API_KEY) && !FORCE_MOCK;
const MODE = HAS_MODEL ? 'model' : 'mock';

/**
 * 默认系统提示词。
 *
 * 页面上选了角色就把角色提示词拼在这段之前 —— 保留通用的回答要求（中文、Markdown、
 * 不编造），又让角色设定决定「以什么身份说话」。
 */
const BASE_SYSTEM_PROMPT = [
  '回答要求：',
  '1. 默认用中文回答，语气平和、直接，不说客套话，不复述用户的问题。',
  '2. 充分利用多轮上下文：用户提到「刚才」「上面」「那个」时，要能接上之前的内容，必要时明确说明你记住的是哪一句。',
  '3. 用 Markdown 组织回答：短段落、必要的列表或代码块，避免堆砌标题。',
  '4. 不要编造事实、数据或链接；不确定就直说，并给出验证方式。',
  '5. 用户发来图片时，先如实说出你在图里看到了什么，再回答他的问题；看不清的地方要说明，不要猜。',
].join('\n');

const DEFAULT_SYSTEM_PROMPT = ['你是「对谈录」里的一位中文助手。', BASE_SYSTEM_PROMPT].join('\n');

const LIMITS = {
  maxMessages: 40,        // 只带最近 40 条进上下文
  maxMessageChars: 32000, // 单条消息上限
  maxTotalChars: 200000,  // 整个上下文上限
  maxPromptChars: 4000,   // 系统提示词上限
  maxImages: 4,           // 单条消息的图片数上限
  maxImageChars: 2 * 1024 * 1024, // 单张图片 dataURL 字符数上限（约 1.5MB 原图）
};

/** 评价的原因最多几条、补充说明最长多少字（与前端 lib/feedback.js 的规则一致） */
const MAX_FEEDBACK_REASONS = 3;
const MAX_FEEDBACK_NOTE = 500;

/** 拼出本次请求要用的系统提示词：角色提示词在前，通用要求在后 */
function buildSystemPrompt(custom) {
  const own = typeof custom === 'string' ? custom.trim() : '';
  if (!own) return DEFAULT_SYSTEM_PROMPT;
  return `${own.slice(0, LIMITS.maxPromptChars)}\n\n${BASE_SYSTEM_PROMPT}`;
}

/** 只接受这几类内联图片，避免被塞进任意 dataURL */
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

/**
 * 校验并裁剪客户端发来的对话历史。
 *
 * 有图片的消息会被转成多模态格式（content 数组）。图片只允许放在最后一条用户消息上：
 * 历史里的图片没必要反复回传，既费 token 又容易被上游拒绝。
 */
function normalizeMessages(input) {
  if (!Array.isArray(input)) return [];
  const clean = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const role = item.role === 'assistant' ? 'assistant' : item.role === 'user' ? 'user' : null;
    if (!role) continue;
    const content = String(item.content ?? '').slice(0, LIMITS.maxMessageChars).trim();
    const images = (Array.isArray(item.images) ? item.images : [])
      .filter((src) => typeof src === 'string' && src.length <= LIMITS.maxImageChars && IMAGE_DATA_URL.test(src))
      .slice(0, LIMITS.maxImages);
    if (!content && !images.length) continue;
    clean.push({ role, content, images });
  }
  // 只保留最近 N 条，并让第一条一定是 user（上游对首条角色更宽容）
  let sliced = clean.slice(-LIMITS.maxMessages);
  const firstUser = sliced.findIndex((m) => m.role === 'user');
  if (firstUser > 0) sliced = sliced.slice(firstUser);
  // 总量保护：从最早的一条开始丢
  let total = sliced.reduce((sum, m) => sum + m.content.length + m.images.reduce((n, i) => n + i.length, 0), 0);
  while (total > LIMITS.maxTotalChars && sliced.length > 2) {
    const dropped = sliced.shift();
    total -= dropped.content.length + dropped.images.reduce((n, i) => n + i.length, 0);
  }

  // 只有最后一条用户消息保留图片，历史里的图片丢掉（省 token，也更不容易被上游拒）
  const lastUserIndex = sliced.map((m) => m.role).lastIndexOf('user');
  const usedImages = sliced[lastUserIndex]?.images ?? [];
  return sliced.map((msg, index) => {
    const keepImages = index === lastUserIndex ? msg.images : [];
    if (keepImages.length) {
      // 多模态格式：文字 + 若干 image_url
      const parts = [];
      if (msg.content) parts.push({ type: 'text', text: msg.content });
      for (const url of keepImages) parts.push({ type: 'image_url', image_url: { url } });
      return { role: msg.role, content: parts, hasImages: true };
    }
    return { role: msg.role, content: msg.content, hasImages: false };
  });
}

// ---------------------------------------------------------------- 模型流式调用

/**
 * 请求上游模型并把增量文本逐块产出。
 *
 * 契约：{ text } 一段增量；{ failure } 分类后的失败（带 message / reason / retryable，
 * 调用方要靠 reason 决定是换模型还是直接报错）。
 *
 * 超时用「卡住检测」而不是「总时长上限」：慢模型只要在持续出字就不该被杀，
 * 但一直不出字就要早点失败。实测某个模型会挂到 90 秒才返回，
 * 让用户干等一分半才知道换模型，体验很差。
 */
const STALL_TIMEOUT_MS = Number(process.env.AI_STALL_TIMEOUT_MS || 45000);

async function* streamModel(messages, signal, model = API_MODEL, { userChosen = false, systemPrompt = '' } = {}) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });

  let timer = null;
  const armWatchdog = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS);
  };
  const disarmWatchdog = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  armWatchdog();

  let upstream;
  try {
    upstream = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model,
        stream: true,
        temperature: 0.7,
        messages: [{ role: 'system', content: buildSystemPrompt(systemPrompt) }, ...messages],
      }),
    });
  } catch (err) {
    disarmWatchdog();
    // 客户端自己按了停止：原样抛给上层，不要当成上游故障
    if (signal?.aborted) throw err;
    if (isAbort(err)) {
      yield {
        failure: classifyUpstreamError({
          status: 0,
          baseUrl: API_BASE,
          model,
          userChosen,
          cause: `超过 ${Math.round(STALL_TIMEOUT_MS / 1000)} 秒没有任何响应`,
        }),
      };
      return;
    }
    const cause = err.cause?.code || err.cause?.message || err.message;
    yield { failure: classifyUpstreamError({ status: 0, baseUrl: API_BASE, cause, model, userChosen }) };
    return;
  }

  if (!upstream.ok || !upstream.body) {
    disarmWatchdog();
    let body = '';
    try {
      body = await upstream.text();
    } catch {
      /* 忽略读取失败 */
    }
    yield {
      failure: classifyUpstreamError({ status: upstream.status, body, model, baseUrl: API_BASE, userChosen }),
    };
    return;
  }

  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let usage = null;

  try {
    for await (const chunk of upstream.body) {
      // 有数据就重置看门狗：慢模型只要还在出字就不该被杀
      armWatchdog();
      buffer += decoder.decode(chunk, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        for (const line of frame.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          if (parsed.usage) usage = parsed.usage;
          if (parsed.error) {
            // 有些上游用 200 开流之后再在流里报错，同样要走分类，别丢原因
            yield {
              failure: classifyUpstreamError({
                status: 200,
                body: JSON.stringify({ error: parsed.error }),
                model,
                baseUrl: API_BASE,
                userChosen,
              }),
            };
            return;
          }
          const delta = parsed.choices?.[0]?.delta;
          const text = delta?.content;
          if (typeof text === 'string' && text.length) yield { text };
        }
      }
    }
  } catch (err) {
    // 流中途卡住被看门狗掐断
    if (signal?.aborted) throw err;
    if (isAbort(err)) {
      yield {
        failure: classifyUpstreamError({
          status: 0,
          baseUrl: API_BASE,
          model,
          userChosen,
          cause: `回答中途超过 ${Math.round(STALL_TIMEOUT_MS / 1000)} 秒没有新内容`,
        }),
      };
      return;
    }
    yield {
      failure: classifyUpstreamError({
        status: 0,
        baseUrl: API_BASE,
        model,
        userChosen,
        cause: err.cause?.code || err.message,
      }),
    };
    return;
  } finally {
    disarmWatchdog();
    signal?.removeEventListener('abort', forwardAbort);
  }
}

// ---------------------------------------------------------------- 对话接口

/** 尚未落盘完毕的对话（sessionId → Promise）；读历史时先等它写完，避免竞态 */
const pendingWrites = new Map();

/** 默认模型名在某个上游可能不存在，这些是已知的、各代理普遍提供的后备模型 */
const MODEL_OVERRIDE = (process.env.AI_MODEL_CANDIDATES || '').trim();

/** 用户是否手动指定了模型（指定了就尊重，不擅自替换） */
const MODEL_EXPLICIT = Boolean((process.env.AI_MODEL || process.env.OPENAI_MODEL || '').trim());

/** 启动探测出的可用模型（进程级缓存，只影响「先用哪个」，不影响兜底链） */
let resolvedModel = null;

/**
 * 上一个成功产出过内容的模型。
 *
 * 一旦某个模型答成功过，后续就优先用它 —— 中途换模型会让回答风格突变，
 * 用户会以为换了个 AI。但网络抖动导致的失败不能永久切走，所以这类失败只是
 * 「下次先重试它」，而不是「从此不用它」。
 */
let stickyModel = null;

/**
 * 最近失败过的模型（model → 解禁时间戳）。
 *
 * 有些模型会挂十几秒才超时。用户在页面上换来换去时，不能每次都白等一遍，
 * 所以在内存里给它一个短冷却期：几分钟内不再当首选，但别的模型也都不行时
 * 仍会再试它一次（冷却不是永久拉黑）。
 */
const modelCooldown = new Map();
const COOLDOWN_MS = 3 * 60 * 1000;

function penalizeModel(model) {
  modelCooldown.set(model, Date.now() + COOLDOWN_MS);
}

/**
 * 本次请求要用哪些模型，按顺序尝试。
 *
 * 关键区别：**用户明确选了一个模型，就只用那一个。**
 * 早先的做法是失败后自动降级到别的模型，结果是「界面显示你选的 A，实际回答来自 B」——
 * 用户在不知情下换了个 AI，这比直接报错更糟。所以在这种情形下宁可报错，
 * 让他自己在下拉框里换。只有「没指定、由服务端挑」时才走降级链。
 */
function modelCandidates(requested = '') {
  if (requested) return [requested];

  const list = pickModelCandidates({
    configured: process.env.AI_MODEL || process.env.OPENAI_MODEL || '',
    override: MODEL_OVERRIDE,
  });
  const now = Date.now();
  const preferred = [stickyModel, resolvedModel].filter(Boolean);

  // 「粘住」的模型只保留一层意义：在它**没被冷却**时使用它。
  // 这里必须真的把它从前面拿掉，而不是排到末尾 —— 一旦粘住的模型挂了，
  // 每个新请求都会先拿它去撞一次超时，那比不粘还糟。
  const stickyUsable = stickyModel && !isCooling(stickyModel, now) ? [stickyModel] : [];
  const rest = [...new Set([...preferred.filter((m) => m !== stickyModel), ...list])];

  const fresh = rest.filter((m) => !isCooling(m, now));
  const cooling = rest.filter((m) => isCooling(m, now));
  return [...stickyUsable, ...fresh, ...cooling];
}

function isCooling(model, now = Date.now()) {
  const until = modelCooldown.get(model);
  return Boolean(until && until > now);
}

/** 页面上显示的「当前模型」：优先上次成功用过的，否则启动探测结果，否则服务端默认 */
function preferredModel() {
  const now = Date.now();
  if (stickyModel && !isCooling(stickyModel, now)) return stickyModel;
  if (resolvedModel && !isCooling(resolvedModel, now)) return resolvedModel;
  return API_MODEL;
}

// ---------------------------------------------------------------- 上游模型列表

/** 模型列表缓存：上游这个接口不快，页面每次加载都去问一遍会很慢 */
const MODEL_LIST_TTL = 5 * 60 * 1000;
const MODEL_LIST_TIMEOUT_MS = Number(process.env.AI_MODELS_TIMEOUT_MS || 45000);
let modelListCache = { at: 0, all: [], chat: [] };

/**
 * 问上游要模型列表（带缓存）。
 * @returns {Promise<{ok: true, all: string[], chat: string[]} | {ok: false, status: number, error: string}>}
 */
async function fetchModelList({ force = false } = {}) {
  if (!HAS_MODEL) return { ok: false, status: 400, error: '当前是离线模式，没有上游模型可列。' };
  if (!force && modelListCache.all.length && Date.now() - modelListCache.at < MODEL_LIST_TTL) {
    return { ok: true, all: modelListCache.all, chat: modelListCache.chat, cached: true };
  }

  let res;
  try {
    res = await fetch(`${API_BASE}/models`, {
      headers: { authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: classifyUpstreamError({ status: 0, baseUrl: API_BASE, cause: err.cause?.code || err.message }).message,
    };
  }

  const raw = await res.text().catch(() => '');
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: classifyUpstreamError({ status: res.status, body: raw, baseUrl: API_BASE }).message,
    };
  }

  let ids = [];
  try {
    ids = (JSON.parse(raw).data ?? []).map((m) => m?.id).filter((id) => typeof id === 'string' && id);
  } catch {
    return { ok: false, status: 502, error: '上游返回的模型列表不是合法 JSON。' };
  }

  const all = [...new Set(ids)].sort();
  const chat = filterChatModels(all);
  modelListCache = { at: Date.now(), all, chat };
  return { ok: true, all, chat };
}

/**
 * 拿「能看图的模型」列表，给「这个模型不支持图片」的提示用。
 *
 * 关键：**先看缓存**。上游常常抽风，而这条提示恰恰是在上游已经出问题的时候显示的 ——
 * 如果此时再去问一次列表，就会变成「不支持图片。能看图的模型有：（暂时没查到）」，
 * 这种提示等于没说。缓存里有就用缓存的。
 */
function knownVisionModels(limit = 6) {
  if (modelListCache.chat.length) return visionModels(modelListCache.chat).slice(0, limit);
  return [];
}

/** 上线时预热一次模型列表，让「可看图的模型」提示一开始就有内容 */
async function warmModelList() {
  if (!HAS_MODEL) return;
  const list = await fetchModelList().catch(() => null);
  if (list?.ok) {
    console.log(`  可用聊天模型 ${list.chat.length} 个（其中 ${visionModels(list.chat).length} 个能看图）`);
  }
}

/** 「当前模型」：优先上次成功用过的，否则启动探测结果，否则服务端默认 */
function requestedOrCurrent() {
  return preferredModel();
}

/** 这个模型名是否在本账号可用列表里（拿不到列表时不做限制，交给上游判断） */
async function isModelAvailable(model) {
  const list = await fetchModelList();
  if (!list.ok) return true;
  return list.all.includes(model);
}

/**
 * 启动时探测一次：默认模型名在上游往往不存在（例如某些代理没有 deepseek-chat），
 * 而失败要等十几秒才返回。与其让第一个提问的用户白等，不如开机就问一次：
 * 用一个极小的请求找出真正可用的模型，之后所有请求直接用对的。
 *
 * 只在用户没手动指定 AI_MODEL 时探测 —— 手动指定了就按他说的来，不去动。
 */
async function probeModel() {
  if (!HAS_MODEL || MODEL_EXPLICIT || MODEL_OVERRIDE) return;
  const candidates = modelCandidates();

  for (const model of candidates) {
    let upstream;
    try {
      upstream = await fetch(`${API_BASE}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(20000),
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${API_KEY}`,
        },
        // max_tokens 压到最小，探测成本可以忽略
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
    } catch (err) {
      console.log(`  探测 ${model} 时网络异常（${err.cause?.code || err.message}），继续试下一个`);
      continue;
    }

    if (upstream.ok) {
      resolvedModel = model;
      console.log(`  已验证可用模型：${model}`);
      return;
    }
    let body = '';
    try {
      body = await upstream.text();
    } catch {
      /* 忽略 */
    }
    const verdict = classifyUpstreamError({ status: upstream.status, body, model, baseUrl: API_BASE });
    console.log(`  模型 ${model} 不可用：${verdict.message}`);
    if (!shouldTryNextModel(verdict)) {
      console.log('  这属于配置问题（不是模型名不对），停止探测。');
      return;
    }
  }

  console.log('  ⚠ 没有探测到任何可用模型，发送时仍会按顺序尝试。');
}

/**
 * 依次尝试候选模型，直到有一个真的开始产出内容。
 *
 * 关键约束：一旦某个模型已经吐出了文字，就认定它成功，不再换模型 ——
 * 否则用户会看到两条回答拼在一起。所以「换模型」只发生在还没产出任何内容时，
 * 且只针对「模型不存在」这一类失败；认证、限流、网络问题换模型也没用。
 *
 * @param {string} requested 本次请求指定的模型（来自页面选择框），空则用服务端默认
 */
async function* streamWithFallback(messages, signal, requested = '', { systemPrompt = '' } = {}) {
  const candidates = modelCandidates(requested);
  // 用户明确指定时只有一项，所以「换模型」这件事根本不会发生
  const allowSwitch = candidates.length > 1;
  // 首选项是用户自己选的吗？决定失败时该劝他「稍后重试」还是「换一个模型」
  const firstIsUserChosen = Boolean(requested) && candidates[0] === requested;

  let lastFailure = null;

  for (let i = 0; i < candidates.length; i += 1) {
    const model = candidates[i];
    const userChosen = firstIsUserChosen && i === 0;
    let produced = false;
    let failure = null;

    for await (const piece of streamModel(messages, signal, model, { userChosen, systemPrompt })) {
      if (piece.failure) {
        failure = piece.failure;
        break;
      }
      if (piece.text) {
        if (!produced) {
          produced = true;
          stickyModel = model;
          yield { model, switchedFrom: i > 0 ? candidates[i - 1] : null };
        }
        yield { text: piece.text };
      }
    }

    if (produced) return;

    lastFailure = failure;
    const isLast = i === candidates.length - 1;

    // 先把这次失败记账，再说要不要换下一个
    if (failure) {
      if (failure.reason === 'model') {
        // 模型名不存在：短期冷却即可，用户可能随时在上游那边开通它
        penalizeModel(model);
      } else if (failure.reason === 'network' || failure.reason === 'upstream') {
        // 会挂很久才失败的那类：冷却一下，免得用户每次换模型都白等一轮
        penalizeModel(model);
      }
    }

    if (!failure || isLast || !allowSwitch || !shouldTryNextModel(failure)) {
      yield { failure: failure ?? { reason: 'upstream', retryable: true, message: '本轮没有任何产出。' } };
      return;
    }

    // 模型不存在这类配置问题：换一个就是正解，且让新模型成为后续的默认
    resolvedModel = candidates[i + 1];
    console.error(`[对谈录] 模型 ${model} 不可用，自动改用 ${candidates[i + 1]}：${failure.message}`);
  }

  yield { failure: lastFailure ?? { reason: 'upstream', retryable: true, message: '本轮没有任何产出。' } };
}

// ---------------------------------------------------------------- 会话标题

/** 起标题是后台小请求：慢一点只是标题晚到，不该拖太久 */
const TITLE_TIMEOUT_MS = Number(process.env.AI_TITLE_TIMEOUT_MS || 15000);

/**
 * 给一段对话起标题。
 *
 * 与 /api/chat 的三点不同，都是刻意的：
 *  · **非流式**：只要一行字，流式反而更麻烦；
 *  · **不换模型、不重试**：失败就失败，客户端保留本地兜底标题 ——
 *    这是后台小事，不该像正文那样惊动用户；
 *  · **失败也返回 200**：调用方不需要区分「离线」「超时」「上游抽风」，
 *    它只关心「有没有拿到一个干净标题」。
 */
async function handleTitle(req, res, body) {
  const question = typeof body?.question === 'string' ? body.question.trim().slice(0, LIMITS.maxMessageChars) : '';
  if (!question) {
    writeJson(res, 400, { error: '缺少 question' });
    return;
  }
  const answer = typeof body?.answer === 'string' ? body.answer.slice(0, LIMITS.maxMessageChars) : '';
  const laterQuestions = (Array.isArray(body?.laterQuestions) ? body.laterQuestions : [])
    .filter((q) => typeof q === 'string')
    .slice(-4);

  if (!HAS_MODEL) {
    // 离线模式没有模型可用：让客户端继续用它自己算的兜底标题
    writeJson(res, 200, { ok: false, mode: 'mock', reason: 'offline', title: '' });
    return;
  }

  const requestedModel =
    typeof body?.model === 'string' && /^[A-Za-z0-9._:\/-]{1,80}$/.test(body.model.trim())
      ? body.model.trim()
      : '';
  const model = requestedModel || preferredModel();

  const messages = buildTitleMessages({ question, answer, laterQuestions });

  let upstream;
  try {
    upstream = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        // 标题就那么长：给足 48 个 token 已很宽裕，也顺手压住乱说话的空间
        max_tokens: 48,
        temperature: 0.2,
      }),
    });
  } catch (err) {
    writeJson(res, 200, { ok: false, reason: 'network', message: err.cause?.code || err.message, title: '' });
    return;
  }

  const text = await upstream.text().catch(() => '');
  if (!upstream.ok) {
    const classified = classifyUpstreamError({ status: upstream.status, body: text, model, baseUrl: API_BASE });
    writeJson(res, 200, { ok: false, reason: classified.reason, message: classified.message, title: '' });
    return;
  }

  let content = '';
  try {
    content = JSON.parse(text)?.choices?.[0]?.message?.content ?? '';
  } catch {
    content = '';
  }

  const title = titleFromModel(content);
  // 模型这次没说人话（空、或只吐了「对话」这种空词）→ 明确告诉调用方没拿到
  writeJson(res, 200, title ? { ok: true, title, model } : { ok: false, reason: 'empty', title: '', model });
}

// ---------------------------------------------------------------- 用户反馈

/**
 * 把一条评价追加进 data/feedback.jsonl。
 *
 * 为什么是 append-only 的 JSONL，而不是「一条反馈一个字段」：
 * 用户点错了要能改（点另一边 = 改判，再点一次 = 取消），所以同一个回答会有多条事件。
 * 追加写让日志始终说实话 —— 谁在什么时候把评价从踩改成了赞，全都留着。
 * 汇总成「最终状态」是读日志的人的事（一行一条 jq 就能算）。
 */
async function handleFeedback(req, res, body) {
  const rating = body?.rating === 'up' ? 'up' : body?.rating === 'down' ? 'down' : null;
  const action = body?.action === 'clear' ? 'clear' : 'set';

  // 取消评价时 rating 允许为空（那一条事件的意义就是「撤回了」）
  if (action === 'set' && !rating) {
    writeJson(res, 400, { error: 'rating 必须是 up 或 down' });
    return;
  }

  const sessionId = typeof body?.sessionId === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(body.sessionId)
    ? body.sessionId
    : null;
  const cut = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
  const reasons = (Array.isArray(body?.reasons) ? body.reasons : [])
    .filter((r) => typeof r === 'string' && r.length <= 32)
    .slice(0, MAX_FEEDBACK_REASONS);

  const entry = {
    at: new Date().toISOString(),
    action,
    rating,
    reasons,
    note: cut(body?.note, MAX_FEEDBACK_NOTE),
    sessionId,
    messageId: cut(body?.messageId, 64) || null,
    version: Number(body?.version) || 1,
    model: cut(body?.model, 80) || null,
    mode: cut(body?.mode, 20) || null,
    // 存一小段上下文：只记「用户点了踩」而不知道踩的是什么，这条日志没有用
    questionExcerpt: cut(body?.questionExcerpt, 200),
    answerExcerpt: cut(body?.answerExcerpt, 300),
  };

  try {
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(FEEDBACK_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (err) {
    writeJson(res, 500, { error: `反馈没能写进磁盘：${err.message}` });
    return;
  }

  writeJson(res, 200, { ok: true, at: entry.at });
}

async function handleChat(req, res, body) {
  const incoming = normalizeMessages(body.messages);
  const sessionId = typeof body.sessionId === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(body.sessionId)
    ? body.sessionId
    : null;

  if (!incoming.length || incoming.at(-1).role !== 'user') {
    writeJson(res, 400, { error: 'messages 必须以一条 user 消息结尾' });
    return;
  }

  // 客户端可以强制本次使用离线回答（用于「离线演示」开关，也用于自动化测试）
  const useMock = FORCE_MOCK || body.mode === 'mock' || !HAS_MODEL;

  // 页面上的模型选择框：本次请求用哪个模型。名字不合法就当没给，回落到服务端默认。
  const requestedModel =
    typeof body.model === 'string' && /^[A-Za-z0-9._:\/-]{1,80}$/.test(body.model.trim())
      ? body.model.trim()
      : '';

  // 角色设定：页面上选的角色 / 自定义提示词。超长会被截断，不会拒整轮请求。
  const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt.slice(0, LIMITS.maxPromptChars) : '';

  // 这一轮是否带图（只看最后一条用户消息）
  const lastUser = incoming.at(-1);
  const hasImages = Boolean(lastUser?.hasImages);

  const stream = openEventStream(res);
  const controller = new AbortController();
  let aborted = false;

  // 断线检测要小心：res 上的 close 在「请求体读完」时也可能触发，
  // 若在这里就把 aborted 置真，整个生成循环第一次迭代就会 break —— 一个字都发不出去。
  // 所以只认两种情况：请求被中止（客户端挂了），或响应在还没写完时被销毁。
  const onClientGone = () => {
    if (!res.writableEnded) {
      aborted = true;
      controller.abort();
    }
  };
  req.on('aborted', onClientGone);
  res.on('close', onClientGone);

  // 模型名先报默认值，真正用上哪个会在第一段内容产出前用 model 帧补正
  let activeModel = useMock
    ? '本地离线回答'
    : requestedModel || preferredModel();

  // 带图片时先确认模型收不收图片。
  // DeepSeek 全系都不支持图片，让请求发出去只会换回一个难懂的报错 ——
  // 这里提前拦住，并直接把「哪个模型能看图」告诉用户。
  if (!useMock && hasImages) {
    if (!supportsVision(activeModel)) {
      // 只读缓存，不再发网络请求：这条提示出现的时机正是上游已经不稳的时候
      const usable = knownVisionModels();
      stream.send('meta', { mode: 'model', model: activeModel, requestedModel: requestedModel || null, sessionId });
      stream.send('error', {
        message:
          `「${activeModel}」不支持图片。` +
          (usable.length
            ? `当前账号可用、且能看图的模型有：${usable.join('、')}。在顶部的模型选择框里换一个再发。`
            : '在顶部的模型选择框里换一个能看图的模型（名字里带 gpt-4o / gemini / claude 的通常可以）。'),
      });
      stream.send('done', { reason: 'error', model: activeModel });
      stream.end();
      return;
    }
  }

  stream.send('meta', {
    mode: useMock ? 'mock' : 'model',
    model: activeModel,
    requestedModel: requestedModel || null,
    sessionId,
    images: hasImages ? incoming.at(-1)?.content?.filter?.((p) => p.type === 'image_url').length ?? 0 : 0,
  });
  const partial = [];
  let failure = null;

  try {
    const source = useMock
      ? createMockReply(incoming, { signal: controller.signal })
      : streamWithFallback(incoming, controller.signal, requestedModel, { systemPrompt });

    for await (const piece of source) {
      if (aborted) break;
      // 契约定死：所有生成器都产出 { text } / { failure } / { model }。
      // 这里显式校验而不是假设——曾经因为离线生成器 yield 裸字符串，
      // piece.text 取到 undefined，整段回答被静默丢掉，界面上只剩一个空回复。
      if (!piece || typeof piece !== 'object') {
        throw new TypeError(`生成器产出了非对象分片：${JSON.stringify(piece)}`);
      }
      if (piece.model) {
        activeModel = piece.model;
        stream.send('model', { model: piece.model, switchedFrom: piece.switchedFrom });
        continue;
      }
      if (piece.failure) {
        failure = piece.failure.message;
        continue;
      }
      if (!piece.text) continue;
      partial.push(piece.text);
      if (!stream.send('delta', { text: piece.text })) break;
    }
  } catch (err) {
    if (!isAbort(err)) {
      failure = `生成回答时出错：${err.message}`;
      console.error('[对谈录] 生成失败：', err);
    }
  }

  if (!aborted) {
    if (failure) stream.send('error', { message: failure });
    stream.send('done', { reason: failure ? 'error' : 'stop', model: activeModel });
  }
  stream.end();

  // 耐久兜底：把这轮完整对话写进 data/conversations/<sessionId>.json
  // 客户端 localStorage 是权威副本，这里只在明确给了 sessionId 时落盘。
  // 不 await：落盘不该拖慢用户看到 done。写入过程登记在 pendingWrites 里，
  // 谁在这个窗口内读历史，谁就等它写完 —— 否则「刚发完就读」会读到空。
  if (sessionId && !aborted) {
    const task = saveConversation(sessionId, incoming, partial.join(''), failure).catch(() => {});
    pendingWrites.set(sessionId, task);
    task.finally(() => {
      if (pendingWrites.get(sessionId) === task) pendingWrites.delete(sessionId);
    });
  }
}

// ---------------------------------------------------------------- 历史兜底存储

function conversationFile(sessionId) {
  return path.join(DATA_DIR, 'conversations', `${sessionId}.json`);
}

/** 兜底副本里只留文字：图片是 base64，存进去会把 data/ 迅速撑爆，也没必要留 */
function textOnly(msg) {
  return { role: msg.role, content: typeof msg.content === 'string' ? msg.content : '' };
}

async function saveConversation(sessionId, incoming, replyText, failure) {
  if (!replyText && !failure) return;
  const previous = await loadConversation(sessionId);
  const turns = previous?.turns ?? [];
  const merged = [...turns];
  for (const msg of incoming.slice(-2).map(textOnly)) {
    const last = merged.at(-1);
    if (last && last.role === msg.role && last.content === msg.content) continue;
    if (!msg.content) continue;
    merged.push(msg);
  }
  if (replyText) merged.push({ role: 'assistant', content: replyText });

  const payload = {
    sessionId,
    updatedAt: new Date().toISOString(),
    turns: merged.slice(-400),
  };
  await mkdir(path.dirname(conversationFile(sessionId)), { recursive: true });
  await writeFile(conversationFile(sessionId), JSON.stringify(payload, null, 2), 'utf8');
}

async function loadConversation(sessionId) {
  try {
    return JSON.parse(await readFile(conversationFile(sessionId), 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 静态文件

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
};

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, relative);
  // 防目录穿越
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== PUBLIC_DIR) {
    writeJson(res, 403, { error: '越权访问' });
    return;
  }
  if (!existsSync(target)) {
    writeJson(res, 404, { error: '资源不存在' });
    return;
  }
  try {
    const data = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-length': data.length,
    });
    res.end(data);
  } catch {
    writeJson(res, 404, { error: '资源不存在' });
  }
}

// ---------------------------------------------------------------- 路由

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    if (pathname === '/api/config' && req.method === 'GET') {
      writeJson(res, 200, {
        mode: MODE,
        model: HAS_MODEL ? requestedOrCurrent() : '本地离线回答',
        defaultModel: HAS_MODEL ? API_MODEL : null,
        modelExplicit: MODEL_EXPLICIT,
        probing: HAS_MODEL && !MODEL_EXPLICIT && !resolvedModel && !MODEL_OVERRIDE,
        baseUrl: HAS_MODEL ? API_BASE : null,
        forcedMock: FORCE_MOCK,
        hint: HAS_MODEL
          ? null
          : '未检测到 API Key，当前使用本地离线回答。设置 DEEPSEEK_API_KEY 后重启即可接入真实模型。',
      });
      return;
    }

    if (pathname === '/api/chat' && req.method === 'POST') {
      await handleChat(req, res, await readJsonBody(req));
      return;
    }

    if (pathname === '/api/title' && req.method === 'POST') {
      await handleTitle(req, res, await readJsonBody(req));
      return;
    }

    if (pathname === '/api/feedback' && req.method === 'POST') {
      await handleFeedback(req, res, await readJsonBody(req));
      return;
    }

    if (pathname.startsWith('/api/history/') && req.method === 'GET') {
      const sessionId = pathname.slice('/api/history/'.length);
      if (!/^[A-Za-z0-9_-]{4,64}$/.test(sessionId)) {
        writeJson(res, 400, { error: 'sessionId 不合法' });
        return;
      }
      // 刚发完一轮就读历史时，先等这轮的落盘任务收尾，避免读到旧数据
      await pendingWrites.get(sessionId);
      const saved = await loadConversation(sessionId);
      writeJson(res, 200, saved ?? { sessionId, turns: [] });
      return;
    }

    if (pathname.startsWith('/api/history/') && req.method === 'DELETE') {
      const sessionId = pathname.slice('/api/history/'.length);
      if (/^[A-Za-z0-9_-]{4,64}$/.test(sessionId)) {
        await rm(conversationFile(sessionId), { force: true }).catch(() => {});
      }
      writeJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/health') {
      writeJson(res, 200, { ok: true, mode: MODE, uptime: Math.round(process.uptime()) });
      return;
    }

    // 「这个 Key 到底能用哪些模型」—— 页面顶部的模型选择框就靠它。
    // 直接问上游，因为各聚合代理账号能用的模型差别很大。
    // 参数：?all=1 连非聊天模型一起返回（诊断用）；?refresh=1 绕过缓存。
    if (pathname === '/api/models' && req.method === 'GET') {
      const wantAll = url.searchParams.get('all') === '1';
      const force = url.searchParams.get('refresh') === '1';
      const list = await fetchModelList({ force });

      if (!list.ok) {
        // 离线模式不算错误：页面据此隐藏选择框
        writeJson(res, HAS_MODEL ? list.status : 200, {
          mode: MODE,
          models: [],
          note: list.error,
        });
        return;
      }

      writeJson(res, 200, {
        mode: MODE,
        default: API_MODEL,
        current: requestedOrCurrent(),
        candidates: modelCandidates(),
        count: (wantAll ? list.all : list.chat).length,
        filteredOut: list.all.length - list.chat.length,
        cached: Boolean(list.cached),
        models: wantAll ? list.all : list.chat,
      });
      return;
    }

    if (pathname.startsWith('/api/')) {
      writeJson(res, 404, { error: '接口不存在' });
      return;
    }

    await serveStatic(req, res, pathname);
  } catch (err) {
    if (!res.headersSent) {
      writeJson(res, err.status || 500, { error: err.message || '服务端异常' });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  const where = `http://${HOST}:${PORT}`;
  console.log('');
  console.log('  对谈录 · AI 聊天助手已启动');
  console.log(`  ${where}`);
  console.log('');
  console.log(`  对话模式：${MODE === 'model' ? `真实模型 ${API_MODEL}` : '本地离线回答（未配置 API Key）'}`);
  if (!HAS_MODEL) {
    console.log('  接入真实模型：设置环境变量 DEEPSEEK_API_KEY 后重启（可选 AI_MODEL / AI_BASE_URL）');
  } else if (MODEL_EXPLICIT) {
    console.log('  已按 AI_MODEL 指定模型，不做自动探测。');
  }
  console.log('');

  // 异步探测可用模型，不阻塞启动：探测期间照常可以访问页面
  probeModel().catch((err) => console.log(`  探测模型时出错：${err.message}`));
  // 预热模型列表：让「能看图的模型有…」这类提示一开始就有内容
  warmModelList().catch(() => {});
});
