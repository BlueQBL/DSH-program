/*!
 * 三易 · 智能写作台 —— 写作模式目录与参数规整（modes.js）
 *
 * 纯数据 + 纯函数：浏览器挂到 window.WriterModes，Node 走 module.exports。
 * 服务端（拼提示词）和浏览器（画界面）共用同一份定义，避免两边漂移。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WriterModes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const APP = {
    id: 'writing-assistant',
    name: '三易',
    subtitle: '智能写作台',
    tagline: '一次起稿，多份成稿，朱批定稿',
    storageKey: 'writing-assistant/v1',
  };

  const LIMITS = {
    inputMax: 12000,
    inputMin: 2,
    fieldMax: 200,
    versionsMax: 4,
    customCharsMin: 80,
    customCharsMax: 2000,
  };

  /* ── 篇幅 ───────────────────────────────────────────────── */
  const LENGTHS = [
    { id: 'short', label: '短', chars: 200, tokens: 800, note: '一段话讲清' },
    { id: 'medium', label: '中', chars: 500, tokens: 1600, note: '常规篇幅' },
    { id: 'long', label: '长', chars: 900, tokens: 2800, note: '展开写透' },
    { id: 'custom', label: '自定义', chars: 600, tokens: 1800, note: '按字数来' },
  ];

  /* ── 创意度 ─────────────────────────────────────────────── */
  const CREATIVITY = [
    { value: 0.2, label: '严守事实', hint: '只用你给的信息，不外扩' },
    { value: 0.5, label: '稳妥', hint: '结构规矩，措辞保守' },
    { value: 0.8, label: '均衡', hint: '该有的发挥都有，不出格' },
    { value: 1.1, label: '灵动', hint: '换个说法，敢用比喻' },
    { value: 1.4, label: '放飞', hint: '角度大胆，可能跑偏' },
  ];
  const CREATIVITY_MIN = 0;
  const CREATIVITY_MAX = 1.6;

  /* ── 通用语气 ───────────────────────────────────────────── */
  const COMMON_TONES = [
    { value: 'plain', label: '平实', brief: '不用形容词堆砌，把事说清楚' },
    { value: 'professional', label: '专业', brief: '术语准确，句子有分量，不寒暄' },
    { value: 'warm', label: '亲切', brief: '像跟熟人说话，可以有语气词' },
    { value: 'crisp', label: '简练', brief: '句子短，能删就删，一段一个意思' },
  ];

  /* ── 六种写作模式 ───────────────────────────────────────── */
  const MODES = [
    {
      id: 'continue',
      name: '文章续写',
      mark: '续',
      tagline: '接着往下写，语气不跑偏',
      input: {
        label: '原稿开头',
        placeholder: '把你已经写好的开头或段落粘进来，我接着往下写……',
        hint: '粘贴得越多，接得越像你写的',
      },
      fields: [
        {
          id: 'direction',
          label: '续写方向',
          type: 'select',
          value: 'follow',
          options: [
            { value: 'follow', label: '顺着往下', brief: '保持原有节奏推进' },
            { value: 'detail', label: '补细节', brief: '把已有的点展开写实' },
            { value: 'turn', label: '换个角度', brief: '引入新的视角或反例' },
            { value: 'climax', label: '推向高潮', brief: '把矛盾或情绪顶上去' },
            { value: 'close', label: '收束结尾', brief: '给这一段一个落点' },
          ],
        },
      ],
      tones: COMMON_TONES.concat([
        { value: 'same', label: '贴合原稿', brief: '模仿原文的句长、人称与用词习惯' },
      ]),
      angles: [
        { id: 'flow', label: '顺着语气', brief: '沿用原文的句长与节奏，自然接续，不换人称' },
        { id: 'detail', label: '落到细节', brief: '挑原文里的一个点往下钻，用具体场景、动作、数字把它写实' },
        { id: 'twist', label: '换个视角', brief: '从另一个角色或另一段时间切入，与原文形成呼应而非重复' },
        { id: 'land', label: '收个尾', brief: '把这一段推向结论或情绪落点，最后一句话要能立住' },
      ],
      outputHint: '只输出续写的正文，不要复述原文开头，不要解释你写了什么。',
    },
    {
      id: 'rewrite',
      name: '内容改写',
      mark: '改',
      tagline: '换一种说法，意思不走样',
      input: {
        label: '待改写原文',
        placeholder: '把要改写的段落粘进来……',
        hint: '改写默认不新增事实，只换表达',
      },
      fields: [
        {
          id: 'strength',
          label: '改写力度',
          type: 'select',
          value: 'medium',
          options: [
            { value: 'light', label: '轻度', brief: '只换词与句式，结构不动' },
            { value: 'medium', label: '中度', brief: '句序、段落可以重排' },
            { value: 'heavy', label: '彻底', brief: '保留信息点，重写整篇' },
          ],
        },
        {
          id: 'keep',
          label: '结构',
          type: 'select',
          value: 'keepStructure',
          options: [
            { value: 'keepStructure', label: '保留原结构', brief: '段数与顺序不变' },
            { value: 'freeStructure', label: '允许重排', brief: '按更好的逻辑重新组织' },
          ],
        },
      ],
      tones: COMMON_TONES.concat([
        { value: 'vivid', label: '有画面', brief: '多用动词和具体场景，少用抽象名词' },
        { value: 'formal', label: '更正式', brief: '书面语，去掉口语与口水词' },
      ]),
      angles: [
        { id: 'faithful', label: '同义易词', brief: '信息点一个不丢，逐一换成更准确的说法' },
        { id: 'restructure', label: '重排结构', brief: '按"先说结论、再说理由"的顺序重新组织' },
        { id: 'person', label: '换人称', brief: '换个叙述人称或立场来写，意思不变' },
        { id: 'tighten', label: '压缩篇幅', brief: '把可删的字都删掉，只留干货' },
      ],
      outputHint: '只输出改写后的正文，不要输出对照表，不要解释改动。',
    },
    {
      id: 'copywriting',
      name: '文案生成',
      mark: '文',
      tagline: '按平台的调子，把卖点说动人',
      input: {
        label: '产品 / 主题',
        placeholder: '要推的是什么？产品、活动、课程、门店……',
        hint: '一句话说清即可',
      },
      fields: [
        {
          id: 'platform',
          label: '投放平台',
          type: 'select',
          value: 'xiaohongshu',
          options: [
            { value: 'xiaohongshu', label: '小红书', brief: '口语、分段、带话题标签' },
            { value: 'wechat', label: '公众号', brief: '有标题党空间，段落偏长' },
            { value: 'douyin', label: '短视频口播', brief: '前三秒抓人，短句' },
            { value: 'ecommerce', label: '电商详情页', brief: '卖点清单化' },
            { value: 'moments', label: '朋友圈', brief: '两三句，不硬广' },
          ],
        },
        { id: 'selling', label: '核心卖点', type: 'text', value: '', placeholder: '最想让人记住的一点（可留空）', max: 60 },
        { id: 'audience', label: '给谁看', type: 'text', value: '', placeholder: '例如：刚工作的女生（可留空）', max: 40 },
      ],
      tones: [
        { value: 'sincere', label: '真诚', brief: '像朋友推荐，不喊口号', },
        { value: 'lively', label: '轻快', brief: '节奏短促，有梗但不油腻' },
        { value: 'pro', label: '专业背书', brief: '用参数、成分、流程说话' },
        { value: 'story', label: '讲故事', brief: '用一个具体的人的具体场景切入' },
      ],
      angles: [
        { id: 'pain', label: '痛点开场', brief: '先写目标人群正在受的具体的苦，再给出路' },
        { id: 'scene', label: '场景故事', brief: '用一个可复现的生活场景把产品放进去' },
        { id: 'compare', label: '对比论证', brief: '用前后对比或同类对比说明差别' },
        { id: 'ask', label: '提问互动', brief: '用提问把读者卷进来，结尾留互动钩子' },
      ],
      outputHint: '按平台的排版习惯输出可直接发布的成品（含标题、正文、需要的话题标签），不要写"以下是我为你写的"。',
    },
    {
      id: 'email',
      name: '邮件撰写',
      mark: '函',
      tagline: '把事说清，不绕弯子',
      input: {
        label: '要写什么事',
        placeholder: '例如：跟供应商确认下周的交付时间顺延两天，说明原因并给出新时间……',
        hint: '交代背景、你要对方做什么',
      },
      fields: [
        { id: 'to', label: '收件人', type: 'text', value: '', placeholder: '例如：王经理 / 项目组（可留空）', max: 40 },
        { id: 'matter', label: '核心诉求', type: 'text', value: '', placeholder: '例如：确认延期并回复新时间（可留空）', max: 60 },
        {
          id: 'expect',
          label: '期望动作',
          type: 'select',
          value: 'confirm',
          options: [
            { value: 'confirm', label: '请确认', brief: '需要对方回复是/否' },
            { value: 'meeting', label: '约会议', brief: '给时间选项让对方挑' },
            { value: 'notify', label: '仅知悉', brief: '不需要回复' },
            { value: 'urge', label: '催办', brief: '有礼貌但有压力' },
            { value: 'thanks', label: '致谢 / 致歉', brief: '关系维护为主' },
          ],
        },
      ],
      tones: [
        { value: 'formal', label: '正式', brief: '书面语，称呼与落款完整' },
        { value: 'polite', label: '温和', brief: '礼貌，留有余地' },
        { value: 'direct', label: '直接', brief: '三句以内说完，不客套' },
      ],
      angles: [
        { id: 'bluf', label: '结论先行', brief: '第一句就说清楚要对方做什么，再补背景' },
        { id: 'context', label: '先讲背景', brief: '先交代来龙去脉，再提出请求' },
        { id: 'bullet', label: '分条列点', brief: '把事项拆成三到五条，便于对方逐条回复' },
      ],
      outputHint: '输出格式：第一行「主题：……」；空行后是称呼、正文、结尾敬语与落款占位。不要写解释说明。',
    },
    {
      id: 'summary',
      name: '摘要提炼',
      mark: '摘',
      tagline: '长文压短，重点不丢',
      input: {
        label: '待摘要原文',
        placeholder: '把长文、会议记录、报告粘进来……',
        hint: '越长越好用，最多 12000 字',
      },
      fields: [
        {
          id: 'shape',
          label: '摘要形态',
          type: 'select',
          value: 'paragraph',
          options: [
            { value: 'paragraph', label: '一段话', brief: '连贯成段，适合转发' },
            { value: 'bullets', label: '分条要点', brief: '三到七条，条条独立' },
            { value: 'minutes', label: '会议纪要', brief: '结论 / 待办 / 责任人' },
            { value: 'exec', label: '执行摘要', brief: '面向决策者，先结论后依据' },
          ],
        },
      ],
      tones: COMMON_TONES,
      angles: [
        { id: 'neutral', label: '客观概括', brief: '只陈述原文说了什么，不加判断' },
        { id: 'decision', label: '面向决策', brief: '突出结论、影响与需要拍板的事' },
        { id: 'todo', label: '动作清单', brief: '突出待办、责任人与时间' },
      ],
      outputHint: '只输出摘要本身，不要写"本文主要讲述了"。数字、人名、时间必须与原文一致。',
    },
    {
      id: 'outline',
      name: '大纲起草',
      mark: '纲',
      tagline: '先立骨架，再填肉',
      input: {
        label: '题目 / 写作意图',
        placeholder: '例如：写一篇讲"远程团队如何开好周会"的公众号长文……',
        hint: '说清写什么、给谁看、想达到什么效果',
      },
      fields: [
        {
          id: 'genre',
          label: '文体',
          type: 'select',
          value: 'article',
          options: [
            { value: 'article', label: '公众号长文', brief: '有钩子、有递进' },
            { value: 'report', label: '工作报告', brief: '结论与依据分明' },
            { value: 'speech', label: '演讲稿', brief: '口语、有节奏、能念出来' },
            { value: 'lesson', label: '教学讲义', brief: '目标—讲解—练习' },
          ],
        },
      ],
      tones: COMMON_TONES,
      angles: [
        { id: 'psr', label: '问题—分析—结论', brief: '最稳的结构，适合说明文' },
        { id: 'timeline', label: '时间线', brief: '按阶段推进，适合复盘与教程' },
        { id: 'modules', label: '并列模块', brief: '几个独立板块横向铺开' },
        { id: 'story', label: '故事线', brief: '用一个案例串起全部要点' },
      ],
      outputHint: '输出分级大纲：一级标题、二级要点，每个要点后跟一句"这一段写什么"。不要写成正文。',
    },
  ];

  /* ── 查询 ───────────────────────────────────────────────── */
  function getMode(id) {
    return MODES.find((m) => m.id === id) || MODES[0];
  }

  function listModeIds() {
    return MODES.map((m) => m.id);
  }

  function defaultFields(mode) {
    const m = typeof mode === 'string' ? getMode(mode) : mode;
    const out = {};
    m.fields.forEach((f) => {
      out[f.id] = f.value || '';
    });
    return out;
  }

  function defaultTone(mode) {
    const m = typeof mode === 'string' ? getMode(mode) : mode;
    return m.tones[0] ? m.tones[0].value : 'plain';
  }

  function toneOf(mode, value) {
    const m = typeof mode === 'string' ? getMode(mode) : mode;
    return m.tones.find((t) => t.value === value) || m.tones[0] || { value: 'plain', label: '平实', brief: '' };
  }

  function angleOf(mode, index) {
    const m = typeof mode === 'string' ? getMode(mode) : mode;
    const list = m.angles && m.angles.length ? m.angles : [{ id: 'a', label: '常规', brief: '按最常规的写法来' }];
    return list[((index % list.length) + list.length) % list.length];
  }

  function angleCount(mode) {
    const m = typeof mode === 'string' ? getMode(mode) : mode;
    return Math.min(LIMITS.versionsMax, (m.angles && m.angles.length) || 1);
  }

  /* ── 参数规整 ───────────────────────────────────────────── */
  function clamp(n, min, max) {
    const v = Number(n);
    if (!Number.isFinite(v)) return min;
    return Math.min(max, Math.max(min, v));
  }

  /**
   * 把任意来源的参数收敛成一份可信的配置。
   * 界面上改动的、URL 里带进来的、接口传上来的，都要先过这里。
   */
  function normalizeParams(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const mode = getMode(input.mode).id;

    const creativity = Math.round(clamp(input.creativity === undefined ? 0.8 : input.creativity, CREATIVITY_MIN, CREATIVITY_MAX) * 10) / 10;

    const lengthId = LENGTHS.some((l) => l.id === input.length) ? input.length : 'medium';
    const customChars = Math.round(clamp(input.customChars === undefined ? 600 : input.customChars, LIMITS.customCharsMin, LIMITS.customCharsMax));
    const preset = LENGTHS.find((l) => l.id === lengthId);
    const chars = lengthId === 'custom' ? customChars : preset.chars;
    // 中文约 1.5 字/token，留 30% 余量；上限防跑飞
    const tokens = lengthId === 'custom' ? Math.round(clamp(chars * 2.2 + 400, 400, 8000)) : preset.tokens;

    const angles = angleCount(mode);
    const versions = Math.round(clamp(input.versions === undefined ? Math.min(3, angles) : input.versions, 1, angles));

    const tone = toneOf(mode, input.tone).value;

    const fields = defaultFields(mode);
    const rawFields = input.fields && typeof input.fields === 'object' ? input.fields : {};
    Object.keys(fields).forEach((key) => {
      const def = getMode(mode).fields.find((f) => f.id === key);
      if (!def) return;
      if (def.type === 'select') {
        const ok = def.options.some((o) => o.value === rawFields[key]);
        fields[key] = ok ? rawFields[key] : def.value;
      } else {
        fields[key] = String(rawFields[key] == null ? '' : rawFields[key]).slice(0, def.max || LIMITS.fieldMax);
      }
    });

    return {
      mode,
      creativity,
      length: lengthId,
      customChars,
      chars,
      tokens,
      versions,
      tone,
      fields,
    };
  }

  /** 参数的一行中文描述，用于历史记录与稿签 */
  function describeParams(params) {
    const p = normalizeParams(params);
    const mode = getMode(p.mode);
    const creat = CREATIVITY.reduce((best, cur) =>
      Math.abs(cur.value - p.creativity) < Math.abs(best.value - p.creativity) ? cur : best
    );
    const tone = toneOf(mode, p.tone);
    return `${mode.name} · 创意度 ${p.creativity.toFixed(1)} ${creat.label} · 约 ${p.chars} 字 · ${tone.label}`;
  }

  /** 创意度对应的档位对象 */
  function creativityStop(value) {
    const v = clamp(value, CREATIVITY_MIN, CREATIVITY_MAX);
    return CREATIVITY.reduce((best, cur) =>
      Math.abs(cur.value - v) < Math.abs(best.value - v) ? cur : best
    );
  }

  function lengthPreset(id) {
    return LENGTHS.find((l) => l.id === id) || LENGTHS[1];
  }

  return {
    APP,
    LIMITS,
    LENGTHS,
    CREATIVITY,
    CREATIVITY_MIN,
    CREATIVITY_MAX,
    MODES,
    getMode,
    listModeIds,
    defaultFields,
    defaultTone,
    toneOf,
    angleOf,
    angleCount,
    normalizeParams,
    describeParams,
    creativityStop,
    lengthPreset,
    clamp,
  };
});
