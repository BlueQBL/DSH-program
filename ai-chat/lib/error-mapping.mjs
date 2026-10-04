// 上游错误分类 + 模型候选选择
//
// 这两个函数刻意做成纯函数：它们决定「用户看到什么提示」和「自动改用哪个模型」，
// 都是不看响应就无从验证的逻辑。
//
// 起因是一个真实的坑：某个第三方代理（api.openai-hk.com）在 default 分组下没有
// deepseek-chat，返回 503 + `model_not_found`。旧代码只看 HTTP 状态码，
// 把「模型不存在」当成「服务暂时不可用」，于是用户看到「稍后重试」——
// 去等一个永远不会好的东西。所以这里按上游的错误码细分，并区分能否重试。

/**
 * 从上游可能的各种错误体里挖出人话。
 * 兼容 OpenAI 官方、new-api、hk 代理等几种包装方式。
 */
function extractUpstreamMessage(raw) {
  if (!raw) return '';
  const text = String(raw).trim();
  const parse = (input) => {
    try {
      return JSON.parse(input);
    } catch {
      return null;
    }
  };
  const json = parse(text);
  if (json && typeof json === 'object') {
    const err = json.error;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
      const msg = err.message || err.msg || err.detail || '';
      const code = err.code && err.code !== msg ? `（${err.code}）` : '';
      return `${msg}${code}`.trim();
    }
    if (json.message) return String(json.message);
    if (json.detail) return String(json.detail);
  }
  // 不是 JSON 就直接截一段，至少比「服务不可用」有信息量
  return text.slice(0, 300);
}

/** 上游错误里能判出「这个模型不存在 / 没有可用渠道」的特征 */
const MODEL_MISSING = /model_not_found|无可用渠道|不存在|not found|does not exist|unknown model|invalid model|不支持|no available channel|distributor/i;
/** 认证 / 余额类问题 */
const AUTH_PROBLEM = /key error|invalid api key|incorrect api key|unauthorized|authentication|invalid_api_key|无权限|invalid token|expired/i;
const QUOTA_PROBLEM = /insufficient|quota|balance|余额|欠费|billing|exceeded your current quota|额度/i;

/**
 * 把上游失败翻译成「用户能据此行动」的一句话，并标注能否重试。
 *
 * @param {{status?:number, body?:string, model?:string, baseUrl?:string, cause?:string, userChosen?:boolean}} options
 *   userChosen 为真表示模型是用户在选择框里自己挑的 —— 此时不该劝他「稍后重试」，
 *   而要劝他换一个模型，因为服务端不会替他换。
 * @returns {{message: string, reason: 'auth'|'quota'|'model'|'rate'|'upstream'|'network', retryable: boolean}}
 */
export function classifyUpstreamError({
  status = 0,
  body = '',
  model = '',
  baseUrl = '',
  cause = '',
  userChosen = false,
} = {}) {
  const detail = extractUpstreamMessage(body);
  const modelLabel = model ? `「${model}」` : '当前模型';
  const pickAnother = userChosen ? '在顶部的模型选择框里换一个再发一次。' : '';

  if (status === 0) {
    // 用户自己选的模型挂掉时，别说「稍后重试」——他已经知道等没用，需要的是换一个
    const advice = userChosen
      ? `这个模型是你在选择框里选的，服务端不会替你换。${pickAnother}或者稍后再试一次（上游有时会临时变慢）。`
      : '请检查网络或代理设置；也可以先把 AI_BASE_URL 指向一个可达的 OpenAI 兼容接口。';
    return {
      reason: 'network',
      retryable: true,
      message: `连不上模型服务 ${baseUrl}（${cause || '网络错误'}）—— 模型 ${modelLabel}。${advice}`,
    };
  }

  if (status === 401 || status === 403 || AUTH_PROBLEM.test(detail)) {
    return {
      reason: 'auth',
      retryable: false,
      message:
        `上游拒绝了这个 Key（HTTP ${status}）${detail ? `：${detail}` : ''}。` +
        '请在环境变量 DEEPSEEK_API_KEY / OPENAI_API_KEY 里换一个有效的 Key 后重启服务。',
    };
  }

  if (status === 402 || QUOTA_PROBLEM.test(detail)) {
    return {
      reason: 'quota',
      retryable: false,
      message:
        `上游账户余额不足或额度用尽${detail ? `：${detail}` : ''}。` +
        '充值后重试；想先本地体验，清空 API Key 环境变量再重启即可回到离线回答。',
    };
  }

  // 模型问题必须单独识别：它返回的常常也是 5xx，但「稍后重试」是骗人的
  if (MODEL_MISSING.test(detail) || status === 404) {
    return {
      reason: 'model',
      retryable: false,
      message:
        `上游没有 ${modelLabel} 这个模型${detail ? `：${detail}` : `（HTTP ${status}）`}。` +
        '在页面顶部的模型选择框里换一个（可用列表见 /api/models），' +
        '或设置环境变量 AI_MODEL 后重启。',
    };
  }

  if (status === 429 || /rate limit|too many requests|限流|频率/i.test(detail)) {
    return {
      reason: 'rate',
      retryable: true,
      message: `触发了上游限流（模型 ${modelLabel}）${detail ? `：${detail}` : '（HTTP 429）'}。等几秒再发一次即可。`,
    };
  }

  if (status >= 500) {
    return {
      reason: 'upstream',
      retryable: true,
      message:
        `上游服务出错（HTTP ${status}，模型 ${modelLabel}）${detail ? `：${detail}` : ''}。` +
        (userChosen
          ? `这通常是上游或代理临时故障，稍后重试；若持续出现，${pickAnother}`
          : '这通常是上游或代理临时故障，稍后重试；若持续出现，换一个 AI_BASE_URL 或模型名。'),
    };
  }

  return {
    reason: 'upstream',
    retryable: false,
    message: `上游返回 ${status}（模型 ${modelLabel}）${detail ? `：${detail}` : ''}`,
  };
}

/** 挑模型的优先级：默认模型优先，其余作为后备 */
const MODEL_PREFERENCE = [
  'deepseek-v4.1-flash',
  'deepseek-v4-flash',
  'deepseek-v3.2',
  'deepseek-chat',
  'deepseek-v3',
  'deepseek-r1',
  'gpt-4o-mini',
  'gpt-4o',
];

/**
 * 上游模型列表里，哪些不是聊天模型。
 *
 * 聚合型代理会同时列出图像、语音、向量、审核模型 —— OpenAI-HK 有 156 个，
 * 其中一大半选中也没用。这些必须在选择框里过滤掉，否则用户会选到「画图模型」，
 * 然后收到一个跟他的操作对不上的报错。
 */
const NON_CHAT_MODEL = new RegExp(
  [
    '(^|[-_/])(image|images|dall-e|dalle|tts|whisper|audio|speech|embedding|embeddings|moderation|rerank|sora|veo|kling|midjourney|nano-banana|flux|stable-diffusion|upscal|ocr)([-_/]|$)',
    '(^|[-_/])(image|video|tts|audio|embedding|moderation)[-_]',
    '-(image|video|audio|tts|embedding|vision)(-|$)',
    'gpt-image',
    'sora_',
    'sd-?xl',
  ].join('|'),
  'i',
);

/** 这个模型名看起来能不能聊天 */
export function isChatModel(id) {
  if (!id || typeof id !== 'string') return false;
  return !NON_CHAT_MODEL.test(id);
}

/** 从上游模型列表里挑出可聊天的，去重并保持原顺序 */
export function filterChatModels(ids) {
  const seen = new Set();
  const out = [];
  for (const id of ids ?? []) {
    if (typeof id !== 'string' || !id) continue;
    if (!isChatModel(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 哪些模型能「看图」。
 *
 * 名字里带这些的一般是多模态接口。反过来要特别注意：**DeepSeek 全系目前不收图片**，
 * 用户在 DeepSeek 模型上贴图会被上游直接拒绝。所以界面必须提前说清楚并提示换模型，
 * 而不是让他发出去才收到一个看不懂的报错。
 */
const VISION_MODEL =
  /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-vision|gpt-5|gpt-6|claude-(3|opus|sonnet|haiku|fable)|gemini|grok-[2-9]|qwen-?vl|glm-4v|internvl|llava|pixtral|vision/i;

export function supportsVision(model) {
  if (!model || typeof model !== 'string') return false;
  return VISION_MODEL.test(model);
}

/** 从一批模型里挑出支持看图的，供界面提示用 */
export function visionModels(ids) {
  return (ids ?? []).filter((id) => typeof id === 'string' && supportsVision(id));
}

/**
 * 本次请求要用哪些模型，按顺序尝试。
 *
 * - 显式设了 AI_MODEL：只认它，不擅自替换（用户的选择优先，替换了反而让人困惑）
 * - 没设：默认名排第一，失败后按已知可用的模型依次兜底
 * - 设了 AI_MODEL_CANDIDATES：完全按它来，便于测试固定这条链路
 */
export function pickModelCandidates({ configured = '', defaults = MODEL_PREFERENCE, override = '' } = {}) {
  if (override) {
    return override
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const base = (configured || '').trim();
  if (!base) return [...defaults];
  return [base, ...defaults.filter((m) => m !== base)];
}

/** 只有「换一个模型可能好」的失败才值得换模型重试 */
export function shouldTryNextModel(classification) {
  return classification.reason === 'model';
}
