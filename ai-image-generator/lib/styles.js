/*!
 * 蓝晒 · AI 图片生成器 —— 尺寸与风格预设（styles.js，前后端共用）
 *
 * 这里管三件事：
 *   1. 尺寸表：按 OpenAI-HK 文档给的常用组合（边长 16 的倍数、长宽比 ≤3:1、
 *      总像素 655,360 ~ 8,294,400）；不同模型的可用尺寸不一样，用 resolveSize() 收口。
 *   2. 风格表：接口没有 style 参数，风格是靠「往提示词里加一段英文描述」实现的 ——
 *      所以每种风格都带一段可读的后缀，用户在界面上能看到最终发出去的到底是什么。
 *   3. 请求组装：把「描述 + 风格 + 尺寸 + 画质」变成一个上游能收的 payload。
 *
 * 纯数据 + 纯函数，**前后端共用同一份**（浏览器挂到 globalThis.LanShaiStyles，Node 走
 * module.exports）：界面上的「最终提示词」预览和真正发给上游的那段必须是同一段，
 * 各写一遍迟早会漂移。
 */
'use strict';

const LIMITS = {
  promptMin: 2,
  promptMax: 2000,
  n: 1,
};

/**
 * 尺寸表：一个比例一行，三档清晰度。
 * 数字全部照抄平台文档的常用组合，别自己编 —— 平台对边长、比例、总像素都有硬约束。
 */
const SIZE_TABLE = [
  { ratio: '1:1', label: '方形', sizes: { '1K': '1024x1024', '2K': '2048x2048', '4K': '2880x2880' }, hint: 'square composition' },
  { ratio: '16:9', label: '横屏', sizes: { '1K': '1280x720', '2K': '2048x1152', '4K': '3840x2160' }, hint: 'widescreen cinematic framing' },
  { ratio: '9:16', label: '竖屏', sizes: { '1K': '720x1280', '2K': '1152x2048', '4K': '2160x3840' }, hint: 'vertical poster framing' },
  { ratio: '4:3', label: '经典', sizes: { '1K': '1024x768', '2K': '2048x1536', '4K': '3264x2448' }, hint: 'classic 4:3 framing' },
  { ratio: '3:4', label: '立幅', sizes: { '1K': '768x1024', '2K': '1536x2048', '4K': '2448x3264' }, hint: 'portrait 3:4 framing' },
  { ratio: '3:2', label: '摄影', sizes: { '1K': '1008x672', '2K': '2064x1376', '4K': '3504x2336' }, hint: 'photographic 3:2 framing' },
  { ratio: '2:3', label: '人像', sizes: { '1K': '672x1008', '2K': '1376x2064', '4K': '2336x3504' }, hint: 'portrait 2:3 framing' },
  { ratio: '21:9', label: '宽银幕', sizes: { '1K': '1344x576', '2K': '2016x864', '4K': '3808x1632' }, hint: 'ultra-wide 21:9 framing' },
];

const TIERS = ['1K', '2K', '4K'];
const DEFAULT_RATIO = '1:1';
const DEFAULT_TIER = '1K';

/** 每档画质对成本的影响是真的（gpt-image 低/中/高差别很大），所以界面要写清楚 */
const QUALITIES = [
  { id: 'low', label: '低', note: '最省额度，适合试构图' },
  { id: 'medium', label: '中', note: '平衡细节与花费' },
  { id: 'high', label: '高', note: '细节最足，最贵' },
];
const DEFAULT_QUALITY = 'medium';

/**
 * 风格表。en 是真正发给模型的英文后缀（模型对英文风格词更敏感），
 * hint 是给人看的中文说明，palette 供离线显影引擎配色（没有 Key 时也能看出版面）。
 */
const STYLES = [
  {
    id: 'photo',
    label: '摄影写实',
    en: 'photorealistic photograph, natural window light, 35mm lens, shallow depth of field, fine film grain, highly detailed',
    hint: '像真实相机拍的照片',
    palette: ['#0d1f33', '#3d6b88', '#e9c46a'],
  },
  {
    id: 'cinema',
    label: '电影感',
    en: 'cinematic film still, anamorphic widescreen, dramatic key light, teal and orange grade, atmospheric haze',
    hint: '大银幕的构图与调色',
    palette: ['#0d1218', '#2c4557', '#f4a62a'],
  },
  {
    id: 'anime',
    label: '二次元插画',
    en: 'anime illustration, clean lineart, cel shading, expressive lighting, vivid palette',
    hint: '清爽的日系赛璐璐上色',
    palette: ['#f5c9d6', '#a9cbf0', '#ff9fb2'],
  },
  {
    id: 'watercolor',
    label: '水彩',
    en: 'watercolor painting, wet-on-wet washes, paper texture, soft edges, limited palette',
    hint: '纸面晕开的透明水色',
    palette: ['#eaf1f2', '#9fc0ba', '#e79a63'],
  },
  {
    id: 'render3d',
    label: '3D 渲染',
    en: '3D render, soft studio lighting, subsurface scattering, glossy reflections, octane quality',
    hint: '干净的三维棚拍质感',
    palette: ['#171726', '#473d6b', '#ffc857'],
  },
  {
    id: 'minimal',
    label: '极简构成',
    en: 'minimalist geometric composition, flat color blocks, generous negative space, precise edges',
    hint: '留白与几何色块',
    palette: ['#f0ece4', '#2f3440', '#e2653f'],
  },
  {
    id: 'cyberpunk',
    label: '赛博朋克',
    en: 'cyberpunk scene, neon signage, rain-slick surfaces, volumetric fog, high contrast magenta and cyan',
    hint: '霓虹雨夜的未来都市',
    palette: ['#080c1c', '#ff2e88', '#12e0f0'],
  },
  {
    id: 'oil',
    label: '油画',
    en: 'oil painting, visible brushstrokes, chiaroscuro lighting, layered glazes, museum texture',
    hint: '厚涂的古典光感',
    palette: ['#1a150f', '#6b4c2a', '#d8a441'],
  },
  {
    id: 'film',
    label: '复古胶片',
    en: 'analog film photograph, 1980s Kodachrome, halation, light leaks, soft contrast',
    hint: '过期胶片的暖调颗粒',
    palette: ['#17110c', '#8a6748', '#e3b489'],
  },
  {
    id: 'pixel',
    label: '像素艺术',
    en: 'pixel art, 16-bit palette, crisp dithering, limited colors, retro game sprite style',
    hint: '复古游戏的点阵画',
    palette: ['#12121e', '#4ade80', '#f472b6'],
  },
];

function findStyle(id) {
  return STYLES.find((s) => s.id === id) || STYLES[0];
}

function findRatio(ratio) {
  return SIZE_TABLE.find((r) => r.ratio === ratio) || SIZE_TABLE[0];
}

function parseSize(size) {
  const m = /^(\d{2,4})x(\d{2,4})$/.exec(String(size || '').trim());
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

/**
 * 平台对 size 的硬约束（gpt-image 系列的）：最大边长 3840、两边都是 16 的倍数、
 * 长宽比不超过 3:1、总像素 655,360 ~ 8,294,400。
 */
function validateSize(size) {
  const parsed = parseSize(size);
  if (!parsed) return { ok: false, reason: '尺寸要写成「宽x高」，例如 1024x1024' };
  const { width, height } = parsed;
  if (width % 16 !== 0 || height % 16 !== 0) return { ok: false, reason: '宽高都必须是 16 的倍数' };
  if (width > 3840 || height > 3840) return { ok: false, reason: '最大边长不能超过 3840' };
  const ratio = Math.max(width, height) / Math.min(width, height);
  if (ratio > 3) return { ok: false, reason: '长宽比不能超过 3:1' };
  const pixels = width * height;
  if (pixels < 655360 || pixels > 8294400) return { ok: false, reason: '总像素要在 655,360 ~ 8,294,400 之间' };
  return { ok: true, reason: '', width, height, ratio };
}

/** 比例最接近的候选：用于「模型不支持这个尺寸」时的就近替换 */
function nearestSize(parsed, candidates) {
  const target = parsed ? Math.max(parsed.width, parsed.height) / Math.min(parsed.width, parsed.height) : 1;
  let best = candidates[0];
  let bestDiff = Infinity;
  for (const c of candidates) {
    const p = parseSize(c);
    if (!p) continue;
    const r = Math.max(p.width, p.height) / Math.min(p.width, p.height);
    const diff = Math.abs(r - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = c;
    }
  }
  return best;
}

/** dall-e 系的尺寸是写死的几档，gpt-image 系才认任意组合 */
const MODEL_SIZE_RULES = [
  {
    match: /dall-?e-3/i,
    allowed: ['1024x1024', '1792x1024', '1024x1792'],
    quality: { low: 'standard', medium: 'standard', high: 'hd' },
    note: 'dall-e-3 只有三档固定尺寸',
  },
  {
    match: /dall-?e-2/i,
    allowed: ['1024x1024', '512x512', '256x256'],
    quality: null,
    note: 'dall-e-2 只有三档固定尺寸，且不支持画质档位',
  },
];

/**
 * 把「用户选的尺寸」换成「这个模型真的收的尺寸」。
 * 不偷偷改：真要换，note 里会写清楚换成了什么，界面上照实显示。
 */
function resolveSize(model, size) {
  const requested = String(size || '').trim() || SIZE_TABLE[0].sizes[DEFAULT_TIER];
  const rule = MODEL_SIZE_RULES.find((r) => r.match.test(String(model || '')));
  if (rule) {
    if (rule.allowed.includes(requested)) return { size: requested, note: '', exact: true };
    const fallback = nearestSize(parseSize(requested), rule.allowed);
    return { size: fallback, note: `${rule.note}，已改用 ${fallback.replace('x', '×')}`, exact: false };
  }
  const check = validateSize(requested);
  if (check.ok) return { size: requested, note: '', exact: true };
  const fallback = nearestSize(parseSize(requested), SIZE_TABLE.map((r) => r.sizes[DEFAULT_TIER]));
  return { size: fallback, note: `${check.reason}，已改用 ${fallback.replace('x', '×')}`, exact: false };
}

/** 这个模型适用的画质值（dall-e-2 传了会被拒） */
function resolveQuality(model, quality) {
  const q = QUALITIES.some((item) => item.id === quality) ? quality : DEFAULT_QUALITY;
  const rule = MODEL_SIZE_RULES.find((r) => r.match.test(String(model || '')));
  if (!rule) return { quality: q, note: '' };
  if (!rule.quality) return { quality: '', note: '该模型没有画质档位，已省略 quality 参数' };
  return { quality: rule.quality[q] || rule.quality[DEFAULT_QUALITY], note: '' };
}

/** 比例说明塞进提示词，让构图别和画幅打架 */
function ratioHintOf(size) {
  const parsed = parseSize(size);
  if (!parsed) return '';
  const ratio = parsed.width / parsed.height;
  const row = SIZE_TABLE.find((r) => {
    const p = parseSize(r.sizes[DEFAULT_TIER]);
    return p && Math.abs(p.width / p.height - ratio) < 0.03;
  });
  if (row) return row.hint;
  if (ratio > 1.2) return 'wide horizontal framing';
  if (ratio < 0.83) return 'tall vertical framing';
  return 'square composition';
}

/**
 * 画幅比例标签：1024x768 → '4:3'。
 *
 * 记录里的 size.ratio 存的是这个，**不是**上面那段构图说明 ——
 * 说明是给模型看的提示词，标签是给人看的元数据，混在一起两边都不好用
 * （曾经这里塞过提示词，结果历史里存成了 "classic " 这种半截字符串）。
 */
function ratioLabel(size) {
  const parsed = parseSize(size);
  if (!parsed) return '';
  for (const row of SIZE_TABLE) {
    const p = parseSize(row.sizes[DEFAULT_TIER]);
    if (p && Math.abs(p.width / p.height - parsed.width / parsed.height) < 0.02) return row.ratio;
  }
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(parsed.width, parsed.height) || 1;
  return `${Math.round(parsed.width / g)}:${Math.round(parsed.height / g)}`;
}

function cleanPrompt(prompt) {
  return String(prompt == null ? '' : prompt).replace(/\s+/g, ' ').trim().slice(0, LIMITS.promptMax);
}

/** 最终发给模型的提示词：原描述 + 比例说明 + 风格后缀 */
function composePrompt(prompt, styleId, size) {
  const text = cleanPrompt(prompt);
  const style = findStyle(styleId);
  const parts = [text];
  const hint = ratioHintOf(size);
  if (hint) parts.push(hint);
  if (style && style.en) parts.push(style.en);
  return parts.filter(Boolean).join(', ');
}

/**
 * 组装请求。
 * 返回最终提示词和真正会发出去的参数 —— 界面上「最终提示词」那一栏读的就是它。
 */
function buildRequest(input) {
  const i = input || {};
  const prompt = cleanPrompt(i.prompt);
  const style = findStyle(i.styleId);
  const sizeOut = resolveSize(i.model, i.size);
  const qualityOut = resolveQuality(i.model, i.quality);
  return {
    prompt,
    style: { id: style.id, label: style.label, en: style.en },
    requestedSize: String(i.size || ''),
    size: sizeOut.size,
    sizeNote: sizeOut.note,
    quality: qualityOut.quality,
    qualityNote: qualityOut.note,
    finalPrompt: composePrompt(prompt, style.id, sizeOut.size),
    n: LIMITS.n,
  };
}

/** 界面上要用的：这个模型的尺寸规则（有的模型只有固定几档） */
function sizeRuleOf(model) {
  const rule = MODEL_SIZE_RULES.find((r) => r.match.test(String(model || '')));
  if (!rule) return { kind: 'flexible', allowed: [], note: '' };
  return { kind: 'fixed', allowed: rule.allowed.slice(), note: rule.note };
}

/** 界面初始化要用的预设（尺寸 / 风格 / 画质 / 限制） */
function listPresets() {
  return {
    ratios: SIZE_TABLE.map((r) => ({ ratio: r.ratio, label: r.label, sizes: r.sizes, hint: r.hint })),
    tiers: TIERS,
    defaultRatio: DEFAULT_RATIO,
    defaultTier: DEFAULT_TIER,
    styles: STYLES.map((s) => ({ id: s.id, label: s.label, hint: s.hint, en: s.en })),
    defaultStyle: STYLES[0].id,
    qualities: QUALITIES.map((q) => ({ id: q.id, label: q.label, note: q.note })),
    defaultQuality: DEFAULT_QUALITY,
    limits: LIMITS,
  };
}

/** 这次请求用哪个尺寸（比例 + 清晰度 → 具体像素） */
function sizeOf(ratio, tier) {
  const row = findRatio(ratio);
  const t = TIERS.includes(tier) ? tier : DEFAULT_TIER;
  return row.sizes[t];
}

const API = {
  LIMITS,
  SIZE_TABLE,
  TIERS,
  QUALITIES,
  STYLES,
  DEFAULT_RATIO,
  DEFAULT_TIER,
  DEFAULT_QUALITY,
  findStyle,
  findRatio,
  parseSize,
  validateSize,
  resolveSize,
  resolveQuality,
  sizeRuleOf,
  ratioHintOf,
  ratioLabel,
  composePrompt,
  buildRequest,
  listPresets,
  sizeOf,
  cleanPrompt,
};

// 浏览器里同一份文件也当脚本加载：挂到全局，界面就不用再抄一遍「怎么拼提示词」
if (typeof module === 'object' && module.exports) module.exports = API;
if (typeof globalThis !== 'undefined') globalThis.LanShaiStyles = API;
