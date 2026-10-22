/*!
 * 蓝晒 · AI 图片生成器 —— 预设（印相配方）presets.js，仅服务端
 *
 * 界面上的「风格」是单一的（十种），但用法上大家常常是**一组固定搭配**：
 * 人像要 3:4 + 高画质 + 棚拍光；产品图要 1:1 + 纯白背景；电影感要 21:9 + 中等画质。
 * 每次重新点一遍太累，所以这里做两件事：
 *
 *   1. 内置几套「印相配方」：风格 + 画幅 + 清晰度 + 画质 + 一段附加词，一键套用
 *   2. 用户自己存的预设：把当前面板的设置存下来，下次一键还原（落盘，重启还在）
 *
 * 注意与「风格」的区别：风格改的是**画面味道**（往提示词里加一段英文描述），
 * 预设改的是**整套参数组合**。前者是原料，后者是配方。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Styles = require('./styles.js');

const LIMITS = {
  count: 30,
  nameMax: 24,
  extraMax: 300,
};

/** 内置配方：开箱即用的四套常用组合 */
const BUILTIN_PRESETS = [
  {
    id: 'recipe-portrait',
    name: '人像棚拍',
    builtin: true,
    styleId: 'photo',
    ratio: '3:4',
    tier: '2K',
    quality: 'high',
    extra: 'studio portrait, 85mm lens, seamless backdrop, soft beauty light, natural skin texture',
    note: '立幅 + 高画质 + 柔光棚拍',
  },
  {
    id: 'recipe-product',
    name: '产品主图',
    builtin: true,
    styleId: 'minimal',
    ratio: '1:1',
    tier: '2K',
    quality: 'high',
    extra: 'product hero shot on pure white seamless background, soft top light, crisp edges, subtle reflection',
    note: '方图 + 纯白背景 + 干净边缘',
  },
  {
    id: 'recipe-storyboard',
    name: '电影分镜',
    builtin: true,
    styleId: 'cinema',
    ratio: '21:9',
    tier: '1K',
    quality: 'medium',
    extra: 'cinematic storyboard frame, atmospheric haze, dramatic backlight, anamorphic flares',
    note: '宽银幕 + 逆光 + 空气感',
  },
  {
    id: 'recipe-ink',
    name: '国风插画',
    builtin: true,
    styleId: 'watercolor',
    ratio: '2:3',
    tier: '2K',
    quality: 'medium',
    extra: 'Chinese ink and wash fusion, rice paper texture, elegant negative space, muted palette',
    note: '人像幅 + 纸感 + 大量留白',
  },
  {
    id: 'recipe-neon',
    name: '赛博夜景',
    builtin: true,
    styleId: 'cyberpunk',
    ratio: '16:9',
    tier: '2K',
    quality: 'medium',
    extra: 'neon-lit night street, wet asphalt reflections, volumetric fog, high contrast',
    note: '横屏 + 霓虹 + 雨夜反光',
  },
];

/** 把一条预设收口成「一定是合法值」的形状：填错的一律退回默认，不让坏数据进界面 */
function normalizePreset(input) {
  const p = input || {};
  const styleIds = Styles.STYLES.map((s) => s.id);
  const ratios = Styles.SIZE_TABLE.map((r) => r.ratio);
  const qualities = Styles.QUALITIES.map((q) => q.id);
  const name = String(p.name || '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.nameMax);
  return {
    id: String(p.id || ''),
    name,
    builtin: false,
    styleId: styleIds.includes(p.styleId) ? p.styleId : Styles.STYLES[0].id,
    ratio: ratios.includes(p.ratio) ? p.ratio : Styles.DEFAULT_RATIO,
    tier: Styles.TIERS.includes(p.tier) ? p.tier : Styles.DEFAULT_TIER,
    quality: qualities.includes(p.quality) ? p.quality : Styles.DEFAULT_QUALITY,
    model: String(p.model || '').slice(0, 80),
    extra: String(p.extra || '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.extraMax),
    note: String(p.note || '').slice(0, 60),
    createdAt: Number(p.createdAt) || 0,
  };
}

function validatePreset(input) {
  const preset = normalizePreset(input);
  if (!preset.name) return { ok: false, message: '给这个预设起个名字' };
  if (preset.name.length < 2) return { ok: false, message: '名字太短了，至少两个字' };
  return { ok: true, preset };
}

/**
 * 用户预设的落盘存储（data/presets.json）。
 * 写法与历史记录一致：临时文件 + rename，坏文件不当成空表。
 */
function createPresetStore(options) {
  const opt = options || {};
  const file = opt.file || path.join(process.cwd(), 'data', 'presets.json');
  const log = typeof opt.log === 'function' ? opt.log : () => {};
  let data = { version: 1, presets: [] };

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && Array.isArray(parsed.presets)) {
        data = { version: 1, presets: parsed.presets.map(normalizePreset).filter((p) => p.name) };
      }
    }
  } catch (err) {
    log(`[presets] 预设文件读不了，已忽略：${err.message}`);
    data = { version: 1, presets: [] };
  }

  function flush() {
    try {
      const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      try {
        fs.renameSync(tmp, file);
      } catch {
        fs.copyFileSync(tmp, file);
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      log(`[presets] 预设没写成：${err.message}`);
    }
  }

  return {
    file,
    /** 内置配方 + 用户预设 */
    list() {
      return {
        builtin: BUILTIN_PRESETS.map((p) => normalizePreset(p)),
        saved: data.presets.slice(),
        limit: LIMITS.count,
      };
    },
    add(input) {
      const check = validatePreset(input);
      if (!check.ok) return check;
      if (data.presets.length >= LIMITS.count) {
        return { ok: false, message: `最多存 ${LIMITS.count} 个预设，先删一个吧` };
      }
      // 同名就覆盖（用户心里的「保存」通常就是这个意思）
      const exists = data.presets.findIndex((p) => p.name === check.preset.name);
      const preset = Object.assign({}, check.preset, {
        id: exists >= 0 ? data.presets[exists].id : `ps_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        createdAt: exists >= 0 ? data.presets[exists].createdAt || Date.now() : Date.now(),
      });
      if (exists >= 0) data.presets[exists] = preset;
      else data.presets.unshift(preset);
      flush();
      return { ok: true, preset, replaced: exists >= 0 };
    },
    remove(id) {
      const key = String(id || '');
      const before = data.presets.length;
      data.presets = data.presets.filter((p) => p.id !== key);
      if (data.presets.length === before) return false;
      flush();
      return true;
    },
  };
}

module.exports = {
  LIMITS,
  BUILTIN_PRESETS,
  normalizePreset,
  validatePreset,
  createPresetStore,
};
