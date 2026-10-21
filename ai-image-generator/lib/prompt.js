/*!
 * 蓝晒 · AI 图片生成器 —— 提示词优化（prompt.js，前后端共用）
 *
 * 「优化提示词」这件事的边界：AI 只负责把一句简单的描述扩成一段更有效的画面描述，
 * **不能改用户的意图**（主体、数量、情绪都得以原话为准）。
 *
 * 两条路：
 *   live    ：调平台上的聊天模型（同一个 Key），要求它按 JSON 回复，带一句中文说明
 *   offline ：没有 Key 时用模板拼一段结构化扩写，界面上标「离线扩写」
 */
'use strict';

const Styles = require('./styles.js');

const OPTIMIZE_LIMITS = {
  promptMax: 2000,
  resultMax: 3000,
  notesMax: 240,
};

function optimizeSystem() {
  return [
    '你是一位图像提示词工程师，服务的对象是用 AI 文生图工具作图的普通人。',
    '你的任务：把用户那句简单的描述扩写成一段更有效的图片提示词，让画面更具体、更好看。',
    '',
    '硬性要求：',
    '1. 不改用户的意图。主体、数量、动作、情绪、性别、场景以用户的描述为准；没写的才补。',
    '2. 只输出英文提示词（图像模型对英文更敏感），一段话，60~140 个英文单词，不要换行、不要列表、不要引号。',
    '3. 覆盖这些维度：主体细节、环境与背景、光线、镜头与构图、材质与色彩、画面质量。',
    '4. 不要出现任何品牌名、名人名、水印；不要求画面里出现文字，除非用户明确要求。',
    '5. 不要用「masterpiece, best quality, 8k」这类空话堆砌，写具体的画面内容。',
    '',
    '输出 JSON，形状固定为：',
    '{"prompt":"<英文提示词>","notes":"<一句中文说明你补了什么，30 字以内>"}',
    '不要输出 JSON 以外的任何内容。',
  ].join('\n');
}

function optimizeUser(input) {
  const i = input || {};
  const style = Styles.findStyle(i.styleId);
  const size = String(i.size || '1024x1024');
  const ratio = Styles.ratioHintOf(size);
  return [
    `用户描述：${Styles.cleanPrompt(i.prompt)}`,
    `已选风格：${style.label}（英文参考：${style.en}）`,
    `画幅：${size}，构图要求：${ratio}`,
    '',
    '按上面的要求扩写这段描述，只回 JSON。',
  ].join('\n');
}

/** 去掉代码围栏 / 引号 / 前缀，留下能直接用的文本 */
function unwrap(text) {
  let out = String(text == null ? '' : text).trim();
  out = out.replace(/^```[a-z]*\s*/i, '').replace(/```$/i, '').trim();
  out = out.replace(/^(优化后的?提示词|英文提示词|prompt)\s*[:：]\s*/i, '').trim();
  out = out.replace(/^["'“”]+|["'“”]+$/g, '').trim();
  return out;
}

/**
 * 解析优化结果。上游可能不按 JSON 回（很多兼容网关的 response_format 不生效），
 * 那就按纯文本来 —— 拿到什么用什么，并说明「没按 JSON 回」。
 */
function parseReply(text) {
  const raw = String(text == null ? '' : text);
  const fenced = raw.replace(/^```[a-z]*\s*/i, '').replace(/```$/i, '').trim();
  try {
    const data = JSON.parse(fenced);
    const prompt = unwrap((data && (data.prompt || data.optimized || data.text)) || '');
    const notes = String((data && (data.notes || data.note || data.explain)) || '').slice(0, OPTIMIZE_LIMITS.notesMax);
    if (prompt) return { prompt: prompt.slice(0, OPTIMIZE_LIMITS.resultMax), notes, parsed: true };
  } catch {
    /* 不是 JSON，按纯文本处理 */
  }
  const prompt = unwrap(raw).split(/\n{2,}/)[0].slice(0, OPTIMIZE_LIMITS.resultMax);
  return { prompt, notes: '', parsed: false };
}

/**
 * 离线扩写：没有 Key 时也得给出比原文更具体的东西。
 *
 * 不用随机数 —— 同样的输入永远得到同样的结果，界面上点两次不会得到两段不同的文字。
 */
function expandOffline(input) {
  const i = input || {};
  const subject = Styles.cleanPrompt(i.prompt);
  const style = Styles.findStyle(i.styleId);
  const size = String(i.size || '1024x1024');
  const ratio = Styles.ratioHintOf(size);

  const layers = [
    'a coherent environment with clear depth layering and supporting background detail',
    'soft directional key light with gentle rim light and natural falloff shadows',
    'medium shot, 35mm equivalent perspective, shallow depth of field, sharp focus on the subject',
    'rich material detail with tactile surface texture and clean edges',
    'harmonious limited color palette with subtle atmospheric perspective',
  ];
  const prompt = [subject, ...layers, ratio, style.en, 'no watermark, no text overlay']
    .filter(Boolean)
    .join(', ')
    .slice(0, OPTIMIZE_LIMITS.resultMax);

  return {
    prompt,
    notes: `离线扩写：按下单的主体、光线、镜头、质感、色彩补了细节（${style.label}）`,
    parsed: true,
    engine: 'offline',
  };
}

module.exports = {
  OPTIMIZE_LIMITS,
  optimizeSystem,
  optimizeUser,
  parseReply,
  expandOffline,
  unwrap,
};
