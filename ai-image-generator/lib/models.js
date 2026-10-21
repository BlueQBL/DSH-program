/*!
 * 蓝晒 · AI 图片生成器 —— 模型注册表（models.js，仅服务端）
 *
 * 这个项目的模型这部分比「聊天」「写作」那两个多一步：聚合平台（OpenAI-HK 这类）
 * 列出来的几百个模型里混着向量、语音、审核、视频，**能出图的只是其中一小撮**，
 * 而且「列表里有」不等于「我这个账号能调通」。所以这里做四件事：
 *
 *   1. 过滤：按名字挑出「文生图」模型，把只能改图的、只能看图说话的、做视频的都排掉
 *   2. 排序：常用的出图模型排前面（gpt-image 系 → dall-e 系 → flux / seedream …）
 *   3. 校验：列表拉不到、或者里面一个出图模型都没有时，退回平台文档里那几款已知模型，
 *      并把来源如实标出来（界面上会显示「来自平台文档」而不是假装是账号列表）
 *   4. 可用性：真的调一次才算「可用」。出图调用要花钱，所以不偷偷批量试 ——
 *      生成成功自动记为可用；用户点「检测」才花一次额度实测；结果落盘，重启还记得
 */
'use strict';

const upstream = require('./upstream.js');
const Styles = require('./styles.js');
const Images = require('./image.js');

const MODEL_LIST_TTL = 5 * 60 * 1000;

/** 名字里带这些的，多半是文生图模型 */
const IMAGE_HINTS = [
  /(^|[-_/])dall-?e([-_/]|$|\d)/i,
  /gpt-image/i,
  /\bimages?\b/i,
  /flux/i,
  /seedream|seededit|seedance-image/i,
  /sdxl|stable-?diffusion|sd-?3(\.|$|-)/i,
  /midjourney|(^|[-_/])mj([-_/]|$)/i,
  /ideogram/i,
  /imagen/i,
  /kolors/i,
  /cogview/i,
  /recraft/i,
  /playground-v/i,
  /nano-?banana/i,
  /grok.*image|image.*grok/i,
  /(qwen|wanx|ernie|hunyuan|doubao|jimeng)[-_]?(image|draw)/i,
];

/** 名字里带这些的，不管有没有 image 字样都不算「文生图」 */
const NOT_IMAGE = [
  /embed/i,
  /moderation/i,
  /rerank/i,
  /whisper|tts\b|speech|transcri|audio|voice/i,
  /\basr\b|\bocr\b/i,
  /(image|img)[-_]?(embed|search|similar|match|caption|tag|understand|check|quality|classif)/i,
  /(^|[-_])(edit|edits|editing)($|[-_])/i,
  /\bsora\b|\bveo\b|kling|hailuo|vidu|runway|video/i,
  /suno|udio|music/i,
];

/** 排序偏好：越靠前越可能是「拿来做图」的主模型 */
const IMAGE_PREFERRED = [
  /^gpt-image-2$/i,
  /^gpt-image-1\.5$/i,
  /^gpt-image-1$/i,
  /^gpt-image/i,
  /^dall-?e-3$/i,
  /^dall-?e/i,
  /^seedream/i,
  /^flux/i,
  /^imagen/i,
  /^ideogram/i,
  /^midjourney|^mj/i,
  /^qwen-image|^wanx/i,
  /^nano-?banana/i,
  /^grok.*image/i,
];

/**
 * 列表拿不到时用的兜底清单：只放平台文档里明确写过、且走同一套
 * /images/generations 接口的模型。这不是猜测，README 里写了出处。
 */
const KNOWN_IMAGE_MODELS = ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1', 'dall-e-3', 'dall-e-2'];

/** 聊天模型（优化提示词要用一个）：这些明显不是聊天模型 */
const NOT_CHAT = [
  /embed/i,
  /whisper|tts\b|speech|transcri|audio|voice/i,
  /\b(asr|ocr|moderation|rerank)\b/i,
  /dall-?e|gpt-image/i,
  /\bsora\b|\bveo\b|kling|hailuo|vidu|runway|video/i,
  /suno|udio|music/i,
  /davinci|babbage|ada-|curie/i,
];

const CHAT_PREFERRED = [
  /^gpt-4o-mini$/i,
  /^gpt-4\.1($|-)/i,
  /^gpt-4o($|-)/i,
  /^gpt-4-turbo/i,
  /^chatgpt-4o/i,
  /^deepseek-chat$/i,
  /^deepseek/i,
  /^qwen/i,
  /^glm/i,
  /^claude-/i,
  /^gemini-/i,
  /^kimi|^moonshot/i,
  /^grok-/i,
  /^doubao/i,
  /^o[1-4]($|-)/i,
];

function isImageModel(id) {
  if (typeof id !== 'string' || !id.trim()) return false;
  const name = id.trim();
  if (NOT_IMAGE.some((re) => re.test(name))) return false;
  return IMAGE_HINTS.some((re) => re.test(name));
}

function filterImageModels(list) {
  return Array.from(new Set((list || []).filter(isImageModel)));
}

function rankImageModel(id, preferred) {
  if (preferred && id === preferred) return -1;
  for (let i = 0; i < IMAGE_PREFERRED.length; i += 1) {
    if (IMAGE_PREFERRED[i].test(id)) return i;
  }
  return IMAGE_PREFERRED.length + 1;
}

function sortImageCandidates(list, preferred) {
  return (list || [])
    .slice()
    .sort((a, b) => {
      const ra = rankImageModel(a, preferred);
      const rb = rankImageModel(b, preferred);
      if (ra !== rb) return ra - rb;
      return a.localeCompare(b);
    });
}

function isChatModel(id) {
  if (typeof id !== 'string' || !id.trim()) return false;
  const name = id.trim();
  if (NOT_CHAT.some((re) => re.test(name))) return false;
  if (isImageModel(name)) return false;
  return true;
}

function filterChatModels(list) {
  return Array.from(new Set((list || []).filter(isChatModel)));
}

function sortChatCandidates(list, preferred) {
  const rank = (id) => {
    if (preferred && id === preferred) return -1;
    for (let i = 0; i < CHAT_PREFERRED.length; i += 1) {
      if (CHAT_PREFERRED[i].test(id)) return i;
    }
    return CHAT_PREFERRED.length + 1;
  };
  return (list || [])
    .slice()
    .sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      return a.localeCompare(b);
    });
}

/** 账号级的问题：换模型也救不回来，探测时遇到就直接停 */
const GLOBAL_FAILURES = new Set([400, 401, 402, 403, 405, 422, 429]);

/**
 * 建一个模型注册表。一个进程一个。
 *
 * @param {object} config readConfig() 的结果
 * @param {object} [options]
 *   log            日志函数
 *   ttl            列表缓存时长
 *   statusStore    可用性记忆（store.createModelStatusStore()），重启后还在
 *   probeImage     自定义「实测一个模型能不能出图」的实现（测试注入）
 *   probeChat      自定义 1-token 探活（测试注入）
 */
function createModelRegistry(config, options) {
  const opt = options || {};
  const log = typeof opt.log === 'function' ? opt.log : () => {};
  const ttl = Number(opt.ttl || MODEL_LIST_TTL);
  const statusStore = opt.statusStore || null;

  let cache = { at: 0, all: [], images: [], chat: [], source: 'upstream', error: '', note: '' };
  let inflight = null;

  let chatResolved = '';
  let chatVerified = false;
  let chatNote = '';
  let chatProbed = false;

  const memoryStatus = new Map();
  let sessionVerified = '';

  /** 可用性：落盘的优先，其次是本次进程里记下的 */
  function statusOf(model) {
    if (!model) return null;
    const saved = statusStore && typeof statusStore.get === 'function' ? statusStore.get(model) : null;
    if (saved) return saved;
    return memoryStatus.get(model) || null;
  }

  function rememberStatus(model, entry) {
    const value = Object.assign({ at: Date.now() }, entry);
    memoryStatus.set(model, value);
    if (statusStore && typeof statusStore.set === 'function') {
      try {
        statusStore.set(model, value);
      } catch (err) {
        log(`⚠ 可用性记录没写成：${err.message}`);
      }
    }
    return value;
  }

  /**
   * 取列表。
   * 拿不到列表不算错误：退回文档里的已知模型，并如实标注来源，
   * 界面上会说「来自平台文档，检测一下才知道能不能用」。
   */
  async function list(force) {
    if (!config.live) {
      return { ok: false, live: false, all: [], images: [], chat: [], source: 'offline', error: config.reason, note: config.reason };
    }
    if (!force && cache.all.length && Date.now() - cache.at < ttl) {
      return { ok: true, cached: true, live: true, all: cache.all, images: cache.images, chat: cache.chat, source: cache.source, error: '', note: cache.note };
    }
    if (inflight && !force) return inflight;

    inflight = (async () => {
      const out = await upstream.listModels(config);
      if (!out.ok) {
        const images = sortImageCandidates(KNOWN_IMAGE_MODELS, config.imageModel);
        cache = {
          at: Date.now(),
          all: [],
          images,
          chat: [],
          source: 'known',
          error: out.error,
          note: `取不到账号模型列表（${out.error}），先按平台文档里能出图的 ${images.length} 个模型显示`,
        };
        return { ok: false, live: true, all: [], images, chat: [], source: 'known', error: out.error, note: cache.note };
      }
      const images = sortImageCandidates(filterImageModels(out.ids), config.imageModel);
      const chat = sortChatCandidates(filterChatModels(out.ids), config.chatModel);
      const note = images.length
        ? ''
        : `账号模型列表里没有认出可出图的模型，先按平台文档里的 ${KNOWN_IMAGE_MODELS.length} 个显示`;
      const source = images.length ? 'upstream' : 'known';
      const shown = source === 'known' ? sortImageCandidates(KNOWN_IMAGE_MODELS, config.imageModel) : images;
      cache = { at: Date.now(), all: out.ids, images: shown, chat, source, error: '', note };
      return { ok: true, live: true, all: out.ids, images: shown, chat, source, error: '', note };
    })();

    try {
      return await inflight;
    } finally {
      inflight = null;
    }
  }

  /** 默认要用的出图模型：已验证过的优先，其次配置里的，其次排序最前的 */
  function pickImageModel() {
    const ids = cache.images.slice();
    const verified = ids.find((id) => {
      const st = statusOf(id);
      return st && st.ok;
    });
    if (verified) return verified;
    if (config.imageModel && ids.includes(config.imageModel)) return config.imageModel;
    if (ids.length) return ids[0];
    return config.imageModel;
  }

  /**
   * 实测一个模型能不能出图。
   *
   * 这一次调用是真的会生成一张图、真的扣额度 —— 所以只在你明确要求检测时跑。
   * 用最低画质 + 最小尺寸（1024×1024 是 gpt-image 的下限）把花费压到最低。
   */
  async function verifyImage(model) {
    const id = String(model || '').trim();
    if (!config.live) {
      return { ok: false, live: false, model: id, message: config.reason, offline: true };
    }
    if (!id) {
      return { ok: false, live: true, model: '', message: '先选一个模型再检测' };
    }
    const listed = await list();
    const ids = listed.images.slice();
    if (ids.length && !ids.includes(id)) {
      return { ok: false, live: true, model: id, message: `${id} 不在当前账号可出图的模型列表里，没法检测` };
    }

    const probe =
      typeof opt.probeImage === 'function'
        ? opt.probeImage
        : async (name) => {
            const out = await upstream.generateImage({
              apiKey: config.apiKey,
              baseUrl: config.baseUrl,
              model: name,
              prompt: 'a plain light grey square, minimal, no text',
              n: 1,
              size: '1024x1024',
              quality: 'low',
              responseFormat: 'b64_json',
              timeoutMs: Number(process.env.AI_IMAGE_PROBE_TIMEOUT_MS) || 180000,
            });
            // 光「有返回」不算调得通：还得真的能变成一张图。
            // 这里就把 base64 解一下、认一下格式 —— 本地操作，不额外花钱，
            // 但能在真出图之前就发现「返回的东西不是图片」这类问题。
            const first = out.images[0] || {};
            if (first.b64) {
              const decoded = Images.decodeBase64Image(first.b64);
              const stored = Images.toStoredImage(decoded.buffer, { contentType: decoded.declaredType });
              return {
                ok: true,
                message: `调通了，返回 ${stored.mime}，${Math.round(decoded.buffer.length / 1024)} KB`,
                images: out.images.length,
              };
            }
            if (first.url) {
              return {
                ok: true,
                message: /^data:/i.test(first.url) ? '调通了，返回内嵌图片数据' : '调通了，返回的是图片地址（未下载）',
                images: out.images.length,
              };
            }
            return { ok: false, message: '上游有返回，但里面没有可用的图片数据' };
          };

    try {
      const out = await probe(id);
      if (out && out.ok) {
        sessionVerified = id;
        rememberStatus(id, { ok: true, message: '' });
        return { ok: true, live: true, model: id, message: out.message || '调通了，这个模型可以出图' };
      }
      const message = (out && out.message) || '调不通';
      rememberStatus(id, { ok: false, message });
      return { ok: false, live: true, model: id, message };
    } catch (err) {
      const message = upstream.redact((err && err.message) || String(err), config.apiKey);
      rememberStatus(id, { ok: false, message });
      return { ok: false, live: true, model: id, message };
    }
  }

  /**
   * 聊天模型的探活：只发 1 个 token，几乎不花钱，所以开机就做一次。
   * 优化提示词靠它，选错了用户点一下就得失败，不如先问清楚。
   */
  async function probeChat() {
    if (chatProbed) return { ok: chatVerified, model: chatResolved || config.chatModel, verified: chatVerified, note: chatNote };
    chatProbed = true;
    if (!config.live) {
      chatNote = config.reason;
      return { ok: false, model: '', verified: false, note: chatNote, offline: true };
    }
    const listed = await list();
    const candidates = Array.from(new Set([config.chatModel].concat(listed.chat || []).filter(Boolean))).slice(0, 3);
    const tiny =
      typeof opt.probeChat === 'function'
        ? opt.probeChat
        : async (model) => {
            try {
              await upstream.chatOnce({
                apiKey: config.apiKey,
                baseUrl: config.baseUrl,
                model,
                messages: [{ role: 'user', content: 'ping' }],
                maxTokens: 1,
                temperature: 0,
                timeoutMs: 15000,
              });
              return { ok: true, message: '' };
            } catch (err) {
              return { ok: false, status: err.status, message: (err && err.message) || '调不通' };
            }
          };

    if (!candidates.length) {
      chatNote = '账号模型列表里没有认出聊天模型，优化提示词会退回离线扩写';
      return { ok: false, model: '', verified: false, note: chatNote };
    }
    for (const model of candidates) {
      const out = await tiny(model);
      if (out && out.ok) {
        chatResolved = model;
        chatVerified = true;
        chatNote = '';
        log(`聊天模型探活通过：${model}`);
        return { ok: true, model, verified: true, note: '' };
      }
      chatNote = (out && out.message) || '调不通';
      log(`聊天模型 ${model} 调不通：${chatNote}`);
      if (out && out.status && GLOBAL_FAILURES.has(out.status)) break;
    }
    chatResolved = chatResolved || config.chatModel;
    chatNote = chatNote || '聊天模型都调不通，优化提示词会退回离线扩写';
    return { ok: false, model: chatResolved, verified: false, note: chatNote };
  }

  /**
   * 这次请求用哪个出图模型。
   * 界面上选了 A 就用 A —— 不偷偷换；A 已知不可用时把话说清楚，让用户自己决定。
   */
  function resolveImageModel(requested) {
    if (!config.live) {
      return { model: '', note: '当前是离线显影引擎，模型选择不生效', offline: true };
    }
    const want = typeof requested === 'string' ? requested.trim() : '';
    const fallback = pickImageModel();
    if (!want) return { model: fallback, note: '' };
    if (want.length > 80) return { model: fallback, note: '模型名过长，已改用默认模型' };
    const ids = cache.images.slice();
    if (ids.length && !ids.includes(want)) {
      return { model: fallback, note: `${want} 不在当前账号可出图的模型里，已改用 ${fallback || config.imageModel}` };
    }
    const st = statusOf(want);
    if (st && st.ok === false) {
      return { model: want, note: `${want} 最近一次检测没通过：${st.message || '调不通'}`, unavailable: true };
    }
    return { model: want, note: '' };
  }

  /** 优化提示词用哪个聊天模型 */
  function resolveChatModel(requested) {
    if (!config.live) return { model: '', note: '当前是离线显影引擎，优化提示词走离线扩写', offline: true };
    const want = typeof requested === 'string' ? requested.trim() : '';
    const fallback = chatResolved || config.chatModel;
    if (!want) return { model: fallback, note: '' };
    if (want.length > 80) return { model: fallback, note: '模型名过长，已改用默认模型' };
    if (cache.chat.length && !cache.chat.includes(want)) {
      return { model: fallback, note: `${want} 不在可用的聊天模型里，已改用 ${fallback}` };
    }
    return { model: want, note: '' };
  }

  /** 界面下拉框要的清单：带可用性标记和尺寸规则 */
  function imageModelsForUi() {
    return cache.images.map((id) => {
      const st = statusOf(id);
      const state = !st ? 'untested' : st.ok ? 'verified' : 'unavailable';
      return {
        id,
        state,
        note: (st && st.message) || '',
        at: (st && st.at) || 0,
        sizeRule: Styles.sizeRuleOf(id),
      };
    });
  }

  return {
    list,
    verifyImage,
    probeChat,
    resolveImageModel,
    resolveChatModel,
    statusOf,
    rememberStatus,
    imageModelsForUi,
    pickImageModel,
    get cache() {
      return cache;
    },
    get imageModel() {
      return pickImageModel();
    },
    get chatModel() {
      return chatResolved || config.chatModel;
    },
    get chatVerified() {
      return chatVerified;
    },
    get chatNote() {
      return chatNote;
    },
    get sessionVerified() {
      return sessionVerified;
    },
  };
}

module.exports = {
  MODEL_LIST_TTL,
  KNOWN_IMAGE_MODELS,
  IMAGE_HINTS,
  NOT_IMAGE,
  isImageModel,
  filterImageModels,
  sortImageCandidates,
  rankImageModel,
  isChatModel,
  filterChatModels,
  sortChatCandidates,
  createModelRegistry,
};
