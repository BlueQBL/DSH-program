/*!
 * 三易 · 智能写作台 —— 提示词构建（prompt.js）
 *
 * 纯函数：把「模式 + 参数 + 素材」拼成给模型的消息。
 * 浏览器与服务端共用（服务端拼好再发上游；离线引擎另有一套模板）。
 */
(function (root, factory) {
  const api = factory(
    typeof module === 'object' && module.exports ? require('./modes.js') : root.WriterModes
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WriterPrompt = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Modes) {
  'use strict';

  const CREATIVITY_WORDS = [
    { max: 0.35, text: '严格保守：只能用用户给的信息，不许脑补事实、数字、人名。' },
    { max: 0.65, text: '稳妥：结构与措辞按最常见的写法来，可以有少量合理推断。' },
    { max: 0.95, text: '均衡：表达上可以有发挥，观点可以有立场，但不编造具体事实。' },
    { max: 1.25, text: '灵动：鼓励换角度、用比喻和具体场景，允许有个人风格。' },
    { max: 99, text: '大胆：角度可以出人意料，允许跳跃与强烈的语气，但不得伪造可核查的事实。' },
  ];

  function creativityWord(value) {
    const hit = CREATIVITY_WORDS.find((w) => value <= w.max);
    return (hit || CREATIVITY_WORDS[2]).text;
  }

  const ROLE = '你是一位中文写作助理，替用户把稿子写好、改好。你熟悉中文书面语的分寸感：不堆形容词，不写"综上所述""值得注意的是"这类空转句，不把话说满。';

  const TABOOS = [
    '不要复述或解释任务，不要说"以下是我为你写的""希望对你有帮助"。',
    '不要用 Markdown 代码块包裹正文，不要输出 JSON（除非任务明确要求）。',
    '不要输出"（此处可补充……）"这类占位提示，写不出来就直接不写。',
    '不要加 emoji（文案模式除外）。',
    '不要编造可核查的事实：数字、时间、人名、引用、数据来源，一律以用户给的信息为准。',
  ];

  function bulletList(items) {
    return items.map((t) => '- ' + t).join('\n');
  }

  /**
   * 系统提示：角色 + 本次任务的硬约束。
   * @param {object} params 已经过 Modes.normalizeParams 的参数
   */
  function systemPrompt(params) {
    const p = Modes.normalizeParams(params);
    const mode = Modes.getMode(p.mode);
    const tone = Modes.toneOf(mode, p.tone);

    const lines = [];
    lines.push(ROLE);
    lines.push('');
    lines.push(`本次任务：${mode.name}（${mode.tagline}）。`);
    lines.push(`语气要求：${tone.label}——${tone.brief}`);
    lines.push(`创意度：${creativityWord(p.creativity)}`);
    lines.push(`篇幅：全文约 ${p.chars} 字（可以有 ±15% 浮动，不要为了凑字数注水）。`);
    lines.push(`输出要求：${mode.outputHint}`);
    lines.push('');
    lines.push('硬性要求：');
    lines.push(bulletList(TABOOS));
    return lines.join('\n');
  }

  /**
   * 单个版本的用户提示。多版本时用 angle 拉开差异，而不是只调温度。
   */
  function userPrompt(params, material, versionIndex) {
    const p = Modes.normalizeParams(params);
    const mode = Modes.getMode(p.mode);
    const angle = Modes.angleOf(mode, versionIndex == null ? 0 : versionIndex);
    const source = String((material && material.input) || '').trim();
    const fields = p.fields || {};

    const parts = [];
    parts.push(`【写作模式】${mode.name}`);
    parts.push(`【本稿角度】${angle.label}：${angle.brief}`);

    const extras = [];
    mode.fields.forEach((f) => {
      const value = fields[f.id];
      if (!value) return;
      const opt = (f.options || []).find((o) => o.value === value);
      extras.push(`${f.label}：${opt ? opt.label : value}`);
    });
    if (extras.length) parts.push('【附加要求】\n' + extras.join('\n'));

    parts.push(`【${mode.input.label}】\n${source || '（用户没有提供素材，请根据模式自行合理起稿）'}`);
    if (versionIndex != null) {
      parts.push(`这是同时生成的多个版本中的第 ${versionIndex + 1} 稿，请与其他版本拉开明显差别，不要写成同一篇的微调。`);
    }
    return parts.join('\n\n');
  }

  /** 生成一次请求的完整消息体（单版本） */
  function buildMessages(params, material, versionIndex) {
    return [
      { role: 'system', content: systemPrompt(params) },
      { role: 'user', content: userPrompt(params, material, versionIndex) },
    ];
  }

  /* ── 一键优化（语法与表达） ─────────────────────────────── */

  const POLISH_TYPES = [
    { id: 'grammar', label: '语法', mark: '改' },
    { id: 'collocation', label: '搭配', mark: '改' },
    { id: 'wording', label: '用词', mark: '改' },
    { id: 'punct', label: '标点', mark: '标' },
    { id: 'order', label: '语序', mark: '换' },
    { id: 'redundant', label: '冗余', mark: '删' },
    { id: 'tone', label: '语气', mark: '调' },
    { id: 'typo', label: '错别字', mark: '正' },
  ];

  function polishSystem() {
    return [
      '你是一位中文校对编辑。你的工作是改语法、搭配、标点和啰嗦的地方，让文字更专业、更顺，而不是改成另一个人的语气。',
      '',
      '守则：',
      '- 不改变原意，不新增事实，不删减有效信息。',
      '- 保留作者的语气与用词习惯；能改一个字就不改一句话。',
      '- 只改确有问题的部分。原文没问题的地方，一个字也不要动。',
      '- 若原文已经很干净，rewrites 为空数组即可，不要为了凑数硬改。',
      '',
      '输出必须是严格的 JSON 对象（不要包在代码块里，不要有任何额外文字），结构如下：',
      JSON.stringify(
        {
          polished: '润色后的完整正文',
          rewrites: [
            {
              before: '原文片段（必须是原文里逐字出现的连续片段，长度 2-40 字，不要带省略号）',
              after: '替换后的片段',
              type: 'grammar|collocation|wording|punct|order|redundant|tone|typo',
              reason: '一句话说明为什么改，20 字以内',
            },
          ],
        },
        null,
        2
      ),
      '',
      `其中 type 只能取：${POLISH_TYPES.map((t) => t.id).join(' / ')}。`,
      'rewrites 里每一项的 before 必须在原文中唯一出现、且能定位到具体位置；不要用"这段""此处"之类的指代。',
    ].join('\n');
  }

  function polishUser(text, options) {
    const opt = options || {};
    const lines = [];
    lines.push('请校对下面这段文字。');
    if (opt.focus) lines.push(`重点：${opt.focus}`);
    if (opt.language === 'en' ) lines.push('注意：文中英文部分按英文语法校对。');
    lines.push('');
    lines.push('【原文】');
    lines.push(String(text || ''));
    return lines.join('\n');
  }

  return {
    ROLE,
    TABOOS,
    POLISH_TYPES,
    creativityWord,
    systemPrompt,
    userPrompt,
    buildMessages,
    polishSystem,
    polishUser,
  };
});
