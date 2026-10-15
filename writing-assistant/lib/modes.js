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
    templateNameMax: 24,
    templateTitleMax: 60,
    templateSystemMax: 4000,
    templateNoteMax: 400,
    templateExampleMax: 600,
    templatesMax: 60,
  };

  const TEMPLATE_PREFIX = 'tpl_';

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

  /* ── 写作板块 ───────────────────────────────────────────── */
  /* 板块分组只是导航上的归类，不影响生成逻辑：同组内可以自由切换，
     每个板块各有自己的工作区（原稿、成稿、朱批） */
  const GROUPS = [
    { id: 'write', name: '写作' },
    { id: 'work', name: '专业' },
    { id: 'craft', name: '创作与工具' },
    { id: 'custom', name: '我的模板' },
  ];

  /* 自定义模板的通用四角度：用户只写提示词，多版本的差别由这四个角度提供 */
  const CUSTOM_ANGLES = [
    { id: 'structured', label: '结构清晰', brief: '按小标题分段，一段一个意思，先立骨架再填内容' },
    { id: 'detailed', label: '写得具体', brief: '把要求落到具体的例子、数字、场景上，不说空话' },
    { id: 'concise', label: '精简版', brief: '只留核心信息，能删的都删掉，篇幅压到最短' },
    { id: 'another', label: '换个角度', brief: '换一个切入点或叙述顺序，与常规写法明显拉开' },
  ];

  const MODES = [
    {
      id: 'continue',
      name: '文章续写',
      mark: '续',
      group: 'write',
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
      group: 'write',
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
      group: 'work',
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
      group: 'work',
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
        { id: 'short', label: '三句说完', brief: '压到三句话以内：结论、理由、请求，一句一件事' },
      ],
      outputHint: '输出格式：第一行「主题：……」；空行后是称呼、正文、结尾敬语与落款占位。不要写解释说明。',
    },
    {
      id: 'summary',
      name: '摘要提炼',
      mark: '摘',
      group: 'write',
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
        { id: 'layered', label: '分层要点', brief: '先一句话总括，再分三层展开，适合直接放进汇报材料' },
      ],
      outputHint: '只输出摘要本身，不要写"本文主要讲述了"。数字、人名、时间必须与原文一致。',
    },
    {
      id: 'outline',
      name: '大纲起草',
      mark: '纲',
      group: 'write',
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
    {
      id: 'academic',
      name: '学术论文',
      mark: '论',
      group: 'work',
      tagline: '按学术规范把论点写完整',
      input: {
        label: '论文题目 / 研究内容',
        placeholder: '例如：写"短视频使用时长与大学生专注力的关系"这篇论文的引言部分，已有一份 320 人的问卷……',
        hint: '说清写哪一部分、研究对象、你已经有的材料',
      },
      fields: [
        {
          id: 'section',
          label: '写哪一部分',
          type: 'select',
          value: 'intro',
          options: [
            { value: 'abstract', label: '摘要', brief: '问题—方法—结论，200 字上下' },
            { value: 'intro', label: '引言', brief: '背景、缺口、本文要做什么' },
            { value: 'review', label: '文献综述', brief: '按脉络归拢已有研究' },
            { value: 'method', label: '研究方法', brief: '对象、工具、步骤、变量' },
            { value: 'result', label: '结果与讨论', brief: '先摆事实，再谈解释' },
            { value: 'conclusion', label: '结论与展望', brief: '回答开篇的问题，说清局限' },
          ],
        },
        {
          id: 'genre',
          label: '体例',
          type: 'select',
          value: 'journal',
          options: [
            { value: 'journal', label: '期刊论文', brief: '紧凑，一段一个意思' },
            { value: 'thesis', label: '学位论文', brief: '铺得开，允许展开论述' },
            { value: 'conference', label: '会议论文', brief: '篇幅短，突出新意' },
          ],
        },
        {
          id: 'discipline',
          label: '学科领域',
          type: 'text',
          value: '',
          placeholder: '例如：教育心理学（可留空）',
          max: 40,
        },
      ],
      tones: [
        { value: 'rigorous', label: '客观严谨', brief: '不用第一人称，判断留有余地' },
        { value: 'plain', label: '平实', brief: '把复杂的事说简单，不堆术语' },
        { value: 'critical', label: '批判思辨', brief: '主动指出既有研究的不足' },
        { value: 'applied', label: '问题导向', brief: '每段都回到实际问题' },
      ],
      angles: [
        { id: 'structure', label: '标准结构', brief: '按学科惯例的固定段落结构写：定义—论证—小结' },
        { id: 'dialogue', label: '与文献对话', brief: '把观点放在既有研究的脉络里，说明它补充了什么' },
        { id: 'evidence', label: '数据驱动', brief: '围绕用户给的数据与材料推进，每个判断都落到具体依据上' },
        { id: 'limits', label: '局限与展望', brief: '写的时候就带上边界条件，说清适用范围的限制' },
      ],
      outputHint:
        '只输出这一部分的正文，不要写"本文主要……"这类空转句。术语用学科内的规范说法。' +
        '绝对不编造文献、数据、作者名、期刊名：需要引用的地方写成「（相关研究，年份）」并注明需要你自己补。',
    },
    {
      id: 'report',
      name: '工作报告',
      mark: '报',
      group: 'work',
      tagline: '结论先行，说清依据与下一步',
      input: {
        label: '要汇报的事',
        placeholder: '例如：把三季度三家门店的经营情况写成一份报告，要给出结论和下一步打算……',
        hint: '把事实、数字、时间点写进来，报告只能基于你给的信息',
      },
      fields: [
        {
          id: 'kind',
          label: '报告类型',
          type: 'select',
          value: 'work',
          options: [
            { value: 'work', label: '工作汇报', brief: '做了什么、结果如何、下一步' },
            { value: 'review', label: '项目复盘', brief: '目标对照结果，提炼可复用的做法' },
            { value: 'market', label: '行业分析', brief: '现状—原因—趋势—建议' },
            { value: 'survey', label: '调研报告', brief: '发现—数据—结论—建议' },
            { value: 'weekly', label: '周报 / 月报', brief: '按事项罗列，简短' },
          ],
        },
        {
          id: 'audience',
          label: '给谁看',
          type: 'select',
          value: 'leader',
          options: [
            { value: 'leader', label: '上级 / 管理层', brief: '先结论，再依据，要决策项' },
            { value: 'team', label: '同组同事', brief: '重执行细节与分工' },
            { value: 'client', label: '客户 / 合作方', brief: '口径克制，只讲相关部分' },
            { value: 'public', label: '对外公开', brief: '少用内部术语' },
          ],
        },
      ],
      tones: [
        { value: 'bluf', label: '结论先行', brief: '第一段就把结论和要拍板的事说完' },
        { value: 'plain', label: '平实陈述', brief: '只讲事实，不加修饰' },
        { value: 'data', label: '数据说话', brief: '能用数字的地方都用数字，注明来源' },
        { value: 'crisp', label: '简明扼要', brief: '一段一个意思，能删就删' },
      ],
      angles: [
        { id: 'bluf', label: '结论—依据—行动', brief: '先给结论，再摆依据，最后落到谁在什么时候做什么' },
        { id: 'timeline', label: '时间线', brief: '按阶段推进：目标、过程、结果、下一步' },
        { id: 'psr', label: '问题—原因—对策', brief: '把要解决的事摆在前面，逐条给原因与对策' },
        { id: 'compare', label: '对比分析', brief: '用横向或纵向对比说明差距在哪、为什么' },
      ],
      outputHint:
        '分级标题 + 要点，每部分先给结论再给依据。数字、时间、人名只能来自用户给的信息，' +
        '缺的地方写「（待补）」而不要编。结尾必须有明确的下一步与责任人占位。',
    },
    {
      id: 'fiction',
      name: '小说创作',
      mark: '小',
      group: 'craft',
      tagline: '写情节、写人物、写对话',
      input: {
        label: '故事设定 / 已有片段',
        placeholder: '例如：一个夜班便利店店员，连续七天遇到同一个只买一瓶水的客人……',
        hint: '交代人物、场景、已有的情节，写起来才有根',
      },
      fields: [
        {
          id: 'part',
          label: '写哪一段',
          type: 'select',
          value: 'open',
          options: [
            { value: 'open', label: '开篇', brief: '把人拉进场景里' },
            { value: 'plot', label: '情节推进', brief: '让事情动起来' },
            { value: 'talk', label: '人物对话', brief: '靠对话交代信息与关系' },
            { value: 'turn', label: '转折', brief: '让读者以为的事翻个面' },
            { value: 'end', label: '结尾', brief: '留一个能站住的收束' },
          ],
        },
        {
          id: 'viewpoint',
          label: '叙事视角',
          type: 'select',
          value: 'third',
          options: [
            { value: 'first', label: '第一人称', brief: '「我」所见所想' },
            { value: 'third', label: '第三人称限知', brief: '贴着一个人写，不写别人心里' },
            { value: 'omni', label: '全知视角', brief: '可以同时交代多方动向' },
          ],
        },
        {
          id: 'genre',
          label: '类型',
          type: 'select',
          value: 'real',
          options: [
            { value: 'real', label: '现实', brief: '生活流，重细节与情绪' },
            { value: 'mystery', label: '悬疑', brief: '信息差与钩子' },
            { value: 'scifi', label: '科幻', brief: '设定自洽，服务于人' },
            { value: 'fantasy', label: '奇幻', brief: '世界感，不做说明文' },
            { value: 'romance', label: '言情', brief: '关系推进与分寸' },
            { value: 'history', label: '历史', brief: '时代质感与用词克制' },
          ],
        },
      ],
      tones: [
        { value: 'restrained', label: '克制冷静', brief: '不抒情，靠动作与细节说话' },
        { value: 'lyric', label: '细腻抒情', brief: '句子可以长，感官描写多一点' },
        { value: 'tense', label: '紧张短促', brief: '短句、少形容词、推进快' },
        { value: 'light', label: '幽默轻快', brief: '节奏轻，允许俏皮' },
      ],
      angles: [
        { id: 'scene', label: '场景切入', brief: '从一个具体的时间地点动作开始，先把画面立住' },
        { id: 'talk', label: '对话推进', brief: '用对话承载信息与冲突，少写叙述' },
        { id: 'inner', label: '内心独白', brief: '贴着人物的意识写，但不要直接解释情绪' },
        { id: 'hook', label: '转折留钩', brief: '在结尾抛出一个让读者想翻下一页的东西' },
      ],
      outputHint:
        '只输出小说正文，不要写"以下是小说的开头"这类说明。用具体动作、场景与对话推进，' +
        '不要用"他感到""她意识到"直接说明情绪。不要写成年表或梗概。',
    },
    {
      id: 'translate',
      name: '多语言翻译',
      mark: '译',
      group: 'craft',
      tagline: '换个语言说同一件事',
      input: {
        label: '待翻译原文',
        placeholder: '把要翻译的内容粘进来……',
        hint: '中文、英文都可以；段落会被保留',
      },
      fields: [
        {
          id: 'target',
          label: '目标语言',
          type: 'select',
          value: 'en',
          options: [
            { value: 'en', label: '英文', brief: 'English' },
            { value: 'ja', label: '日文', brief: '日本語' },
            { value: 'ko', label: '韩文', brief: '한국어' },
            { value: 'fr', label: '法文', brief: 'Français' },
            { value: 'de', label: '德文', brief: 'Deutsch' },
            { value: 'es', label: '西班牙文', brief: 'Español' },
            { value: 'ru', label: '俄文', brief: 'Русский' },
            { value: 'zh-tw', label: '繁体中文', brief: '用台湾用语习惯' },
            { value: 'other', label: '其它（自己填）', brief: '在下面写语言名' },
          ],
        },
        {
          id: 'targetCustom',
          label: '其它语言',
          type: 'text',
          value: '',
          placeholder: '例如：葡萄牙语（仅在上面选“其它”时用）',
          max: 30,
        },
        {
          id: 'glossary',
          label: '术语要求',
          type: 'text',
          value: '',
          placeholder: '例如：把“抓手”译成 lever（可留空）',
          max: 80,
        },
        {
          id: 'shape',
          label: '格式',
          type: 'select',
          value: 'keep',
          options: [
            { value: 'keep', label: '保留分段', brief: '段落与换行照原样' },
            { value: 'merge', label: '合并成一段', brief: '适合放进邮件或表格' },
            { value: 'bilingual', label: '中对照', brief: '一段原文一段译文' },
          ],
        },
      ],
      tones: [
        { value: 'literal', label: '忠实直译', brief: '贴着原文，不添不减' },
        { value: 'natural', label: '自然地道', brief: '像目标语言的母语者写的' },
        { value: 'localized', label: '本地化改写', brief: '换成目标语言读者熟悉的说法' },
        { value: 'formal', label: '正式书面', brief: '公文与商务场合用' },
      ],
      angles: [
        { id: 'faithful', label: '忠实直译', brief: '逐句对应，专业术语一律照通行译法，不为了顺口改动信息' },
        { id: 'natural', label: '自然地道', brief: '按目标语言的表达习惯重组句子，读者看不出这是译文' },
        { id: 'localized', label: '本地化改写', brief: '成语、俗语、单位、称呼都换成目标语言里对等的说法' },
        { id: 'rhythm', label: '保留语气节奏', brief: '保留原文的句长、语气与停顿，让口吻尽量不走样' },
      ],
      outputHint:
        '只输出译文，不要输出原文、不要加解释、不要用引号把整段包起来。' +
        '保留原文的段落与标点层级。专有名词用行业通行译法；拿不准的地方照原样保留并加「（?）」。',
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

  /* ── 自定义模板：注册成板块 ─────────────────────────────── *
   * 用户自己写的提示词模板，在运行时被包装成一个和内置板块同形的对象注册进来。
   * 这样界面、工作区、参数规整、导出这些逻辑一行都不用改——它们只认「板块」。
   * 内置板块永远排在前，自定义的追加在后面。
   * ───────────────────────────────────────────────────────── */

  function templateModeId(templateId) {
    return TEMPLATE_PREFIX + String(templateId || '').replace(/^tpl_/, '');
  }

  function isCustomMode(mode) {
    const id = typeof mode === 'string' ? mode : mode && mode.id;
    return typeof id === 'string' && id.indexOf(TEMPLATE_PREFIX) === 0;
  }

  /** 把一个模板记录包装成板块对象 */
  function buildCustomMode(tpl) {
    const t = tpl && typeof tpl === 'object' ? tpl : {};
    const name = String(t.name || '').trim().slice(0, LIMITS.templateNameMax) || '自定义模板';
    return {
      id: templateModeId(t.id),
      templateId: t.id || '',
      custom: true,
      name,
      mark: String(t.mark || name.charAt(0) || '自').slice(0, 1),
      group: 'custom',
      tagline: String(t.tagline || '').slice(0, LIMITS.templateTitleMax) || '你写的提示词',
      input: {
        label: String(t.inputLabel || '').trim().slice(0, 20) || '素材',
        placeholder: String(t.placeholder || '').slice(0, 200) || '把要处理的素材粘进来……',
        hint: String(t.inputHint || '').slice(0, 80) || '这段素材会连同你的提示词一起交给模型',
      },
      fields: [
        {
          id: 'note',
          label: String(t.noteLabel || '').trim().slice(0, 20) || '附加要求',
          type: 'text',
          value: '',
          placeholder: '这一篇的额外要求（可留空）',
          max: LIMITS.fieldMax,
        },
      ],
      tones: COMMON_TONES,
      angles: CUSTOM_ANGLES,
      outputHint: String(t.outputHint || '').slice(0, LIMITS.templateNoteMax) || '',
      // 空稿纸下面可点的示例：作者写了就用作者的，没写由 Core.exampleOf 按提示词结构推
      examples: String(t.example || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 2),
      // 关键：这段提示词会替代默认的角色与要求（Prompt.systemPrompt 会用它）
      system: String(t.system || '').slice(0, LIMITS.templateSystemMax),
    };
  }

  let customModes = [];

  /** 用一批模板替换掉当前所有自定义板块；返回注册结果 */
  function setCustomTemplates(templates) {
    const list = (Array.isArray(templates) ? templates : []).slice(0, LIMITS.templatesMax);
    customModes = list.map(buildCustomMode);
    // 先摘掉旧的自定义板块，再追加新的（内置板块顺序不动）
    for (let i = MODES.length - 1; i >= 0; i -= 1) {
      if (MODES[i].custom) MODES.splice(i, 1);
    }
    customModes.forEach((m) => MODES.push(m));
    return customModes;
  }

  function customModeOf(mode) {
    const m = typeof mode === 'string' ? getMode(mode) : mode;
    return m && m.custom ? m : null;
  }

  /** 按分组列出板块，供导航渲染 */
  function listGroups() {
    return GROUPS.map((g) => ({
      id: g.id,
      name: g.name,
      modes: MODES.filter((m) => (m.group || 'write') === g.id),
    })).filter((g) => g.modes.length);
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
    GROUPS,
    COMMON_TONES,
    CUSTOM_ANGLES,
    TEMPLATE_PREFIX,
    getMode,
    listModeIds,
    listGroups,
    defaultFields,
    defaultTone,
    toneOf,
    angleOf,
    angleCount,
    templateModeId,
    isCustomMode,
    buildCustomMode,
    setCustomTemplates,
    customModeOf,
    normalizeParams,
    describeParams,
    creativityStop,
    lengthPreset,
    clamp,
  };
});
