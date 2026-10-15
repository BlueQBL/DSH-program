'use strict';

/**
 * 离线写作引擎测试：mock-writer.js 是纯函数，不需要 DOM 也不需要网络。
 * 重点盯三件事：产出必须有内容、篇幅与规格一致、校对只改确凿的地方。
 * 运行：node test/mock-writer.test.js
 */

const assert = require('assert');
const Modes = require('../lib/modes.js');
const M = require('../lib/mock-writer.js');

let pass = 0;
const failures = [];

function eq(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected);
    pass += 1;
  } catch (err) {
    failures.push(`${label}\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`);
  }
}

function ok(value, label) {
  eq(Boolean(value), true, label);
}

function no(value, label) {
  eq(Boolean(value), false, label);
}

function group(name, fn) {
  const before = failures.length;
  try {
    fn();
  } catch (err) {
    failures.push(`[${name}] 抛错：${err && err.stack ? err.stack : err}`);
  }
  const status = failures.length === before ? '✓' : '✗';
  console.log(`  ${status} ${name}`);
}

/* ------------------------------------------------------------------ 素材 */
const SOURCE = [
  '远程团队的周会总是开成了汇报会：每个人念一遍自己的进度，散会之后没有人记得要做什么。',
  '我们试过缩短时长，也试过取消周会，效果都不好，后来发现问题不在会上，而在会前没有人准备。',
  '会前如果每个人把三件事写下来——上周做完了什么、这周卡在哪里、需要谁配合，周会就只需要二十分钟。',
  '第二件事是把结论当场记下来，责任人写在后面，散会之后发到群里。',
  '第三件事是下一次开会先花三分钟过一遍上次的待办，没做完的说清原因，而不是重新讨论一遍。',
].join('');

const MODE_IDS = Modes.listModeIds();
/* 十个内置模式一起过通用断言（确定性、非空、禁用词、模式差异、角度差异）。
   translate 也在这十种里，它的产出是有意的短说明，只从第 3 组
   「篇幅要接近目标字数」里排除，原因写在该组里。 */
const ALL_MODES = MODE_IDS.slice();

const BANNED = ['作为AI', '作为 AI', '希望对你有帮助', '以下是', '下面是为你', '（此处可补充）', 'TODO', 'XXX', 'Lorem',
  // README 承诺不写的空转句：学术与报告最容易犯，所以放进全局断言
  '综上所述', '值得注意的是', '毋庸置疑', '不言而喻', '本文主要'];

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

/** 产出里出现的阿拉伯数字（报告会用它跟素材比对：数字只能来自素材） */
function digitsOf(text) {
  return String(text).match(/[0-9]+/g) || [];
}

/** 去掉清单编号（1. / 2、）与标题序号，剩下的数字才算正文里的数字 */
function unnumbered(text) {
  return String(text).replace(/^[ \t]*\d+[.、]\s*/gm, '');
}

/* ------------------------------------------------------------------ 1 确定性 */
group('确定性：同参数两次结果完全一致，不同版本明显不同', () => {
  MODE_IDS.forEach((mode) => {
    const params = Modes.normalizeParams({ mode: mode, length: 'medium', versions: 4 });
    const first = M.compose(params, { input: SOURCE }, 0);
    const second = M.compose(params, { input: SOURCE }, 0);
    eq(first, second, `${mode}：同一参数两次产出应逐字相同`);
    const versions = [0, 1, 2, 3].map((i) => M.compose(params, { input: SOURCE }, i));
    eq(new Set(versions).size, 4, `${mode}：四个版本应两两不同`);
  });
  // 种子换了，结果也要换
  ok(M.seededRandom('a')() !== M.seededRandom('b')(), '不同种子第一次取值应不同');
  eq(M.seededRandom('a')(), M.seededRandom('a')(), '同种子第一次取值应相同');
});

/* ------------------------------------------------------------------ 2 非空 */
group('非空：10 种模式 × 4 个版本 × 空素材/正常素材都写得出来', () => {
  let checked = 0;
  ALL_MODES.forEach((mode) => {
    const params = Modes.normalizeParams({ mode: mode, length: 'medium', versions: 4 });
    ['', SOURCE].forEach((input) => {
      for (let i = 0; i < 4; i += 1) {
        const text = M.compose(params, { input: input }, i);
        checked += 1;
        ok(typeof text === 'string' && text.trim().length > 0, `${mode} 第${i + 1}稿（${input ? '有' : '无'}素材）不应为空`);
        ok(M.charCount(text) > 50, `${mode} 第${i + 1}稿（${input ? '有' : '无'}素材）字数应大于 50，实际 ${M.charCount(text)}`);
      }
    });
    // 素材直接传字符串也要能跑
    ok(M.charCount(M.compose(params, SOURCE, 0)) > 50, `${mode}：material 传字符串也要能产出`);
  });
  eq(ALL_MODES.length, 10, '内置模式应有 10 种');
  eq(checked, 80, '共应检查 80 篇');
});

/* ------------------------------------------------------------------ 3 篇幅 */
group('篇幅：短/中/长三档落在 ±30% 内，且长 > 中 > 短', () => {
  /* 这里只收"按目标字数写"的模式。
     translate 与自定义模板（tpl_）被排除在外：离线引擎做不了翻译、也执行不了
     自定义提示词，它们返回的是如实说明 + 原样保留的原文，字数远小于目标字数
     是有意的设计，单独在第 14、15 组断言。
     学术论文的"摘要"也另有长度惯例（二百字上下），不跟着档位放大，
     单独在第 11 组断言。 */
  ['continue', 'email', 'copywriting', 'academic', 'report', 'fiction'].forEach((mode) => {
    const sizes = { short: 0, medium: 0, long: 0 };
    ['short', 'medium', 'long'].forEach((length) => {
      const params = Modes.normalizeParams({ mode: mode, length: length, versions: 1 });
      const text = M.compose(params, { input: SOURCE.repeat(3) }, 0);
      const n = M.charCount(text);
      sizes[length] = n;
      const target = params.chars;
      ok(n >= target * 0.7 && n <= target * 1.3, `${mode}/${length}：${n} 字应落在 ${Math.round(target * 0.7)}~${Math.round(target * 1.3)} 之间`);
    });
    ok(sizes.long > sizes.medium, `${mode}：长稿应比中稿长（${sizes.long} > ${sizes.medium}）`);
    ok(sizes.medium > sizes.short, `${mode}：中稿应比短稿长（${sizes.medium} > ${sizes.short}）`);
  });
  // 自定义字数也要认
  const custom = Modes.normalizeParams({ mode: 'continue', length: 'custom', customChars: 800, versions: 1 });
  const text = M.compose(custom, { input: SOURCE.repeat(2) }, 0);
  ok(M.charCount(text) >= 560 && M.charCount(text) <= 1040, `自定义 800 字：实际 ${M.charCount(text)} 字应落在 560~1040 之间`);
});

/* ------------------------------------------------------------------ 4 禁用词 */
group('禁用词：不出现套话，非文案模式不带 emoji', () => {
  const copyParams = Modes.normalizeParams({
    mode: 'copywriting',
    length: 'medium',
    versions: 4,
    fields: { platform: 'xiaohongshu', selling: '二十分钟开完', audience: '远程团队负责人' },
  });
  ALL_MODES.forEach((mode) => {
    const params = mode === 'copywriting' ? copyParams : Modes.normalizeParams({ mode: mode, length: 'medium', versions: 4 });
    for (let i = 0; i < 4; i += 1) {
      const text = M.compose(params, { input: SOURCE }, i);
      BANNED.forEach((word) => {
        no(text.indexOf(word) >= 0, `${mode} 第${i + 1}稿不应出现「${word}」`);
      });
      no(text.indexOf('```') >= 0, `${mode} 第${i + 1}稿不应出现代码块围栏`);
      if (mode !== 'copywriting') {
        no(EMOJI_RE.test(text), `${mode} 第${i + 1}稿不应出现 emoji`);
      }
    }
  });
  // 文案模式才允许 emoji，也确实该用上
  const copy = M.compose(copyParams, { input: '帮远程团队开周会的会议助手' }, 0);
  ok(EMOJI_RE.test(copy), '文案模式下应当出现 emoji 或话题标签里的情绪标记');
  ok(copy.indexOf('#') >= 0, '小红书文案应带话题标签');
});

/* ------------------------------------------------------------------ 5 模式差异 */
group('模式差异：同一素材下十种模式产出两两不同', () => {
  const outputs = {};
  ALL_MODES.forEach((mode) => {
    const params = Modes.normalizeParams({ mode: mode, length: 'medium', versions: 1 });
    outputs[mode] = M.compose(params, { input: SOURCE }, 0);
  });
  ALL_MODES.forEach((a) => {
    ALL_MODES.forEach((b) => {
      if (a >= b) return;
      no(outputs[a] === outputs[b], `${a} 与 ${b} 的产出不应完全相同`);
    });
  });

  const email = M.compose(Modes.normalizeParams({ mode: 'email', length: 'medium', versions: 1 }), { input: '通知供应商下周交付顺延两天，说明原因并给出新时间' }, 0);
  ok(email.indexOf('主题：') === 0, '邮件第一行必须是「主题：……」，实际开头为 ' + JSON.stringify(email.slice(0, 12)));

  const bullets = M.compose(
    Modes.normalizeParams({ mode: 'summary', length: 'medium', versions: 1, fields: { shape: 'bullets' } }),
    { input: SOURCE },
    0
  );
  const bulletLines = bullets.split('\n').filter((line) => line.trim());
  ok(bulletLines.length >= 3, `分条摘要至少应有 3 条，实际 ${bulletLines.length} 条`);
  bulletLines.forEach((line, i) => {
    ok(/^\d+[.、]\s*\S/.test(line), `分条摘要第 ${i + 1} 行应以分条标记开头，实际 ${JSON.stringify(line.slice(0, 12))}`);
  });

  const outline = M.compose(Modes.normalizeParams({ mode: 'outline', length: 'long', versions: 1 }), { input: SOURCE }, 0);
  ok(/^一、/.test(outline), '大纲应以「一、」开头的一级标题起头');
  ok(/^二、/m.test(outline), '大纲应有二级结构（至少两个一级标题）');
  ok(outline.indexOf('写什么：') >= 0, '大纲的要点后应跟一句「写什么」说明');
});

/* ------------------------------------------------------------------ 6 角度差异 */
group('角度差异：同一模式四个版本的产出两两不同，且邮件角度顺序确实换了', () => {
  ALL_MODES.forEach((mode) => {
    const params = Modes.normalizeParams({ mode: mode, length: 'medium', versions: 4 });
    const list = [0, 1, 2, 3].map((i) => M.compose(params, { input: SOURCE }, i));
    eq(new Set(list).size, 4, `${mode}：四个角度应产出四份不同的稿子`);
    list.forEach((text, i) => {
      const angle = Modes.angleOf(mode, i);
      ok(angle && angle.label, `${mode} 第${i + 1}稿应有角度定义（${angle && angle.label}）`);
    });
  });
  // 邮件第一条角度是"结论先行"：请求句要在背景句之前
  const emailParams = Modes.normalizeParams({ mode: 'email', length: 'medium', versions: 3, tone: 'polite' });
  const bluf = M.compose(emailParams, { input: '通知供应商下周交付顺延两天' }, 0);
  const context = M.compose(emailParams, { input: '通知供应商下周交付顺延两天' }, 1);
  ok(bluf.indexOf('需要您确认的是') >= 0 && bluf.indexOf('需要您确认的是') < bluf.indexOf('背景'),
    '结论先行角度应把请求放在背景之前');
  no(bluf === context, '第一稿与第二稿的动线不应相同');
});

/* ------------------------------------------------------------------ 7 校对 */
group('校对：能挑出冗余/标点/搭配/错别字，且每条改动都能定位', () => {
  const bad = '做为项目负责人，我们进行了一次讨论，决定截止目前把方案确定下来。这个方案非常好非常非常实用,但是也存在一些问题.认真的分析之后,我们发现它的确需要提高了水平！！实际上基本上都同意，可是重要的事情说了三遍。。。然后我们改了方案，然后通知了客户，然后又开了一次会。';
  const result = M.polish(bad);
  ok(Array.isArray(result.rewrites), 'rewrites 应是数组');
  ok(result.rewrites.length > 0, `有问题的原文应给出改动，实际 ${result.rewrites.length} 条`);
  no(result.polished === bad, '润色后的正文应与原文不同');

  const TYPES = ['grammar', 'collocation', 'wording', 'punct', 'order', 'redundant', 'tone', 'typo'];
  const seen = {};
  result.rewrites.forEach((item, i) => {
    const at = `${i + 1}.${JSON.stringify(item.before)}`;
    ok(typeof item.before === 'string' && item.before.length >= 2 && item.before.length <= 40, `${at} before 长度应在 2~40 字之间`);
    eq(bad.split(item.before).length - 1, 1, `${at} before 必须在原文中唯一出现一次`);
    no(item.after === item.before, `${at} after 必须与 before 不同`);
    ok(TYPES.indexOf(item.type) >= 0, `${at} type「${item.type}」应在允许集合内`);
    ok(typeof item.reason === 'string' && item.reason.length > 0 && item.reason.length <= 20, `${at} reason 应在 20 字以内，实际 ${item.reason && item.reason.length}`);
    seen[item.type] = true;
    // 改过之后，原文片段就不该再出现在润色结果里（后面的规则可能继续改这一处，所以只查 before）
    no(result.polished.indexOf(item.before) >= 0, `${at} 润色结果里不应再出现原文片段`);
  });

  ok(seen.redundant, '应识别出冗余（进行了一次讨论 / 基本上都）');
  ok(seen.punct, '应识别出标点问题（中英混用 / 连用叹号 / 省略号）');
  ok(seen.typo || seen.collocation, '应识别出错别字或搭配问题');

  // 具体改写结果抽查
  ok(result.polished.indexOf('进行了一次讨论') < 0, '「进行了一次讨论」这类冗余结构应被改掉');
  ok(result.polished.indexOf('做为') < 0, '「做为」应改成「作为」');
  ok(result.polished.indexOf('截止目前') < 0, '「截止目前」应改成「截至目前」');
  ok(result.polished.indexOf('！！！') < 0, '连续感叹号应收敛成一个');
  ok(result.polished.indexOf('。。。') < 0, '「。。。」应写成「……」');
  ok(result.polished.indexOf(',但是') < 0, '中文里的半角逗号应换成全角');

  // 干净文本一个字都不许动
  const clean = '会议定在周四下午三点，地点还是老会议室。议程有三项：进度确认、风险梳理、下一步分工。请各位提前十分钟到，把各自负责的部分准备好。';
  const untouched = M.polish(clean);
  eq(untouched.rewrites.length, 0, '干净文本不应产生任何改动');
  eq(untouched.polished, clean, '干净文本的润色结果应与原文完全一致');

  // 空文本不能报错
  const empty = M.polish('');
  eq(empty.rewrites.length, 0, '空文本不应产生改动');
  eq(empty.polished, '', '空文本润色结果仍是空');
});

/* ------------------------------------------------------------------ 8 要点 */
group('要点：条数不超过 max，每条非空且不重复', () => {
  [1, 3, 5, 8].forEach((max) => {
    const points = M.keyPoints(SOURCE, max);
    ok(points.length <= max, `max=${max} 时返回 ${points.length} 条，不应超过上限`);
    ok(points.length > 0, `max=${max} 时至少应返回一条要点`);
    points.forEach((p, i) => {
      ok(typeof p === 'string' && p.trim().length > 0, `max=${max} 第 ${i + 1} 条要点不应为空`);
      ok(M.charCount(p) <= 80, `max=${max} 第 ${i + 1} 条要点不宜超过 80 字，实际 ${M.charCount(p)}`);
    });
    eq(new Set(points).size, points.length, `max=${max} 的要点之间不应重复`);
    // 要点应当真的出自原文
    points.forEach((p) => {
      const core = p.replace(/[，。；：、！？]$/, '').slice(0, 10);
      ok(SOURCE.indexOf(core) >= 0, `要点应来自原文：${JSON.stringify(p.slice(0, 14))}`);
    });
  });
  eq(M.keyPoints('', 5).length, 0, '空文本没有要点');
  eq(M.keyPoints('嗯。', 5).length, 0, '只有语气词的文本没有要点');
});

/* ------------------------------------------------------------------ 9 随机 */
group('随机：同种子一致、不同种子不同、值域在 [0,1)', () => {
  const a1 = M.seededRandom('写作台');
  const a2 = M.seededRandom('写作台');
  const b = M.seededRandom('写作台-2');
  const seqA = [a1(), a1(), a1()];
  const seqA2 = [a2(), a2(), a2()];
  const seqB = [b(), b(), b()];
  eq(seqA, seqA2, '同种子的前三个数应完全一致');
  no(seqA.join(',') === seqB.join(','), '不同种子的序列应不同');
  seqA.forEach((v, i) => {
    ok(v >= 0 && v < 1, `第 ${i + 1} 个随机数 ${v} 应落在 [0,1)`);
  });
  const numeric = M.seededRandom(20260310);
  const values = [numeric(), numeric(), numeric(), numeric()];
  values.forEach((v, i) => {
    ok(v >= 0 && v < 1, `数字种子第 ${i + 1} 个随机数 ${v} 应落在 [0,1)`);
  });
  no(values[0] === values[1], '连续取值不应相同');
});

/* ------------------------------------------------------------------ 10 素材驱动 */
group('素材驱动：关键词、数字、原句语气会被带进产出', () => {
  const emailParams = Modes.normalizeParams({ mode: 'email', length: 'medium', versions: 1, tone: 'polite' });
  const email = M.compose(emailParams, { input: '通知供应商下周交付顺延两天，说明原因并给出新时间' }, 0);
  ok(email.indexOf('供应商') >= 0, '邮件正文应提到素材里的对象「供应商」');
  ok(email.indexOf('两天') >= 0, '邮件正文应保留素材里的时间信息「两天」');

  const summary = M.compose(Modes.normalizeParams({ mode: 'summary', length: 'medium', versions: 1 }), { input: SOURCE }, 0);
  ok(summary.indexOf('周会') >= 0, '摘要应覆盖素材的实际内容（周会）');
  ok(summary.indexOf('会前') >= 0, '摘要应覆盖素材的关键判断（会前准备）');

  const rewrite = M.compose(Modes.normalizeParams({ mode: 'rewrite', length: 'medium', versions: 1 }), { input: SOURCE }, 0);
  ok(rewrite.indexOf('周会') >= 0, '改写应保留原文的信息点');

  const cont = M.compose(Modes.normalizeParams({ mode: 'continue', length: 'medium', versions: 1 }), { input: SOURCE }, 0);
  ok(cont.indexOf('周会') >= 0, '续写应顺着素材的题目往下写');
  no(cont.indexOf(SOURCE.slice(0, 20)) >= 0, '续写不应复述原文开头');

  // 关键词抽取本身
  const kws = M.keywords('通知供应商下周交付顺延两天，供应商的交付时间需要重新确认。', 5);
  ok(kws.length > 0 && kws.length <= 5, `关键词条数应在 1~5 之间，实际 ${kws.length}`);
  ok(kws.indexOf('供应商') >= 0, '重复出现的「供应商」应被抽为关键词');
  eq(M.numberTokens('下周交付顺延两天，3 个工作日内回复。').length > 0, true, '应能抽出时间数字');
});

/* ---------------------------------------------------- 11 学术论文 */
const ACADEMIC_SRC =
  '写“短视频使用时长与大学生专注力的关系”这篇论文的引言部分，已经收了 320 份问卷，' +
  '用自陈报告和打卡记录两种方式测量使用时长，打卡记录的缺失率约 12%。';

/* 编造文献的四种典型长相：署名加年份、光秃秃的年份、期刊名、外文作者 */
const FABRICATED_CITE = [
  /[\u4e00-\u9fa5]{2,4}[（(]\d{4}[）)]/,
  /\d{4}\s*年/,
  /《[^》\n]{2,20}》/,
  /[A-Z][a-z]{2,}\s*(?:et al\.?|等)/,
];

group('学术论文：六个部分都写得出来，不编文献与数据，不写空转句', () => {
  const SECTIONS = ['abstract', 'intro', 'review', 'method', 'result', 'conclusion'];
  const materialDigits = digitsOf(ACADEMIC_SRC);
  SECTIONS.forEach((section) => {
    const params = Modes.normalizeParams({
      mode: 'academic',
      length: 'medium',
      versions: 4,
      fields: { section: section, genre: 'journal', discipline: '教育心理学' },
    });
    for (let i = 0; i < 4; i += 1) {
      const text = M.compose(params, { input: ACADEMIC_SRC }, i);
      const at = `academic/${section} 第${i + 1}稿`;
      ok(M.charCount(text) > 120, `${at} 应有正文，实际 ${M.charCount(text)} 字`);
      FABRICATED_CITE.forEach((re) => {
        const hit = text.match(re);
        no(Boolean(hit), `${at} 不应出现编造的文献或年份，实际出现 ${JSON.stringify(hit && hit[0])}`);
      });
      digitsOf(text).forEach((d) => {
        ok(materialDigits.indexOf(d) >= 0, `${at} 里的数字 ${d} 必须来自素材，不能自己编`);
      });
      if (section !== 'abstract') ok(text.indexOf('教育心理学') >= 0, `${at} 应带上学科领域`);
    }
  });
  // 摘要有自己的长度惯例（二百字上下），不跟着 medium 的 500 字走
  const abs = M.compose(
    Modes.normalizeParams({ mode: 'academic', length: 'medium', versions: 1, fields: { section: 'abstract' } }),
    { input: ACADEMIC_SRC },
    0
  );
  const absLen = M.charCount(abs);
  ok(absLen >= 150 && absLen <= 320, `摘要应落在 150~320 字（固定长度惯例），实际 ${absLen} 字`);
  ok(abs.indexOf('摘要：') === 0, '摘要应以「摘要：」起头');
  ok(abs.indexOf('关键词：') > 0, '摘要应带一行关键词');
  // 与文献对话的角度必须给引用占位，而不是编一个出处
  const dlg = M.compose(
    Modes.normalizeParams({ mode: 'academic', length: 'long', versions: 4, fields: { section: 'intro' } }),
    { input: ACADEMIC_SRC },
    1
  );
  ok(dlg.indexOf('（相关研究，年份）') >= 0, '与文献对话的角度应写成「（相关研究，年份）」占位');
  // 体例影响紧凑程度
  const thesis = M.charCount(
    M.compose(Modes.normalizeParams({ mode: 'academic', length: 'long', versions: 1, fields: { section: 'intro', genre: 'thesis' } }), { input: ACADEMIC_SRC }, 0)
  );
  const conf = M.charCount(
    M.compose(Modes.normalizeParams({ mode: 'academic', length: 'long', versions: 1, fields: { section: 'intro', genre: 'conference' } }), { input: ACADEMIC_SRC }, 0)
  );
  ok(thesis > conf, `学位论文应比会议论文写得开（${thesis} > ${conf}）`);
});

/* ---------------------------------------------------- 12 工作报告 */
const REPORT_SRC =
  '三季度三家门店的经营情况：A 店营收 128 万元，比二季度增长 9%；B 店与上期持平；C 店下滑 6%。' +
  '人力成本上涨是主要原因，公司已经用了 2 个月调整排班。';

group('工作报告：分级标题 + 下一步与责任人占位，数字只来自素材、缺的写（待补）', () => {
  const KINDS = ['work', 'review', 'market', 'survey', 'weekly'];
  const materialDigits = digitsOf(REPORT_SRC);
  KINDS.forEach((kind) => {
    const params = Modes.normalizeParams({ mode: 'report', length: 'medium', versions: 4, fields: { kind: kind, audience: 'leader' } });
    for (let i = 0; i < 4; i += 1) {
      const text = M.compose(params, { input: REPORT_SRC }, i);
      const at = `report/${kind} 第${i + 1}稿`;
      ok(/^[一二三四五六]、/m.test(text), `${at} 应有「一、」这样的分级标题`);
      ok(text.indexOf('下一步') >= 0, `${at} 结尾必须有下一步`);
      ok(text.indexOf('（待补）') >= 0, `${at} 缺数据处应写「（待补）」`);
      ok(text.indexOf('（责任人待定') >= 0, `${at} 应留责任人占位`);
      const heads = text.split('\n').filter((line) => /^[一二三四五六七]、/.test(line));
      ok(heads.length > 0 && heads[heads.length - 1].indexOf('下一步') >= 0, `${at} 的「下一步」应是最后一节，实际最后是 ${heads[heads.length - 1]}`);
      digitsOf(unnumbered(text)).forEach((d) => {
        ok(materialDigits.indexOf(d) >= 0, `${at} 里的数字 ${d} 必须来自素材`);
      });
    }
  });
  // 结论先行的语气：第一段就要给出结论与待决策项
  const bluf = M.compose(
    Modes.normalizeParams({ mode: 'report', length: 'medium', versions: 1, tone: 'bluf', fields: { kind: 'work', audience: 'leader' } }),
    { input: REPORT_SRC },
    0
  );
  const head = bluf.split('\n').slice(0, 4).join('\n');
  ok(head.indexOf('结论') >= 0 && head.indexOf('待决策项') >= 0, `bluf 语气第一段应同时给出结论与待决策项，实际开头 ${JSON.stringify(head.slice(0, 30))}`);
  // 素材里没有数字时，一个数字都不许编
  const noNumSrc = '这次的例行检查已经做完，发现有几处需要调整，具体数量还没有统计出来。';
  const noNum = M.compose(
    Modes.normalizeParams({ mode: 'report', length: 'medium', versions: 1, tone: 'plain', fields: { kind: 'work', audience: 'team' } }),
    { input: noNumSrc },
    0
  );
  eq(digitsOf(unnumbered(noNum)).length, 0, `素材没有数字时报告里不应出现数字，实际 ${JSON.stringify(digitsOf(unnumbered(noNum)))}`);
  ok(noNum.indexOf('（待补）') >= 0, '素材缺数字时应写「（待补）」，不许估一个');
});

/* ---------------------------------------------------- 13 小说 */
const FICTION_SRC = '一个夜班便利店店员，连续七天遇到同一个只买一瓶水的客人，第七天客人没有出现。';

const EMOTION_TELL = ['他感到', '她感到', '他意识到', '她意识到', '内心充满', '他觉得自己', '她觉得自己', '感到很', '感到一阵'];
const FICTION_META = ['以下是小说的开头', '本段', '故事梗概', '人物介绍', '这篇小说'];

group('小说：动作与对话推进，不直接说明情绪，视角守规矩，类型看得出差别', () => {
  const PARTS = ['open', 'plot', 'talk', 'turn', 'end'];
  PARTS.forEach((part) => {
    const params = Modes.normalizeParams({ mode: 'fiction', length: 'medium', versions: 4, fields: { part: part, viewpoint: 'third', genre: 'real' } });
    for (let i = 0; i < 4; i += 1) {
      const text = M.compose(params, { input: FICTION_SRC }, i);
      const at = `fiction/${part} 第${i + 1}稿`;
      ok(M.charCount(text) > 120, `${at} 应有正文，实际 ${M.charCount(text)} 字`);
      EMOTION_TELL.forEach((w) => no(text.indexOf(w) >= 0, `${at} 不应直接说明情绪（出现「${w}」）`));
      FICTION_META.forEach((w) => no(text.indexOf(w) >= 0, `${at} 不应写成说明句（出现「${w}」）`));
    }
  });
  // 第一人称：一个「他/她」都不能有
  const first = Modes.normalizeParams({ mode: 'fiction', length: 'long', versions: 4, fields: { part: 'open', viewpoint: 'first', genre: 'real' } });
  [0, 1, 2, 3].forEach((i) => {
    const text = M.compose(first, { input: FICTION_SRC }, i);
    const leak = text.match(/[他她]/);
    no(Boolean(leak), `第一人称第${i + 1}稿不应出现「他/她」，实际出现：${leak ? JSON.stringify(text.slice(Math.max(0, leak.index - 8), leak.index + 8)) : ''}`);
    ok(text.indexOf('我') >= 0, `第一人称第${i + 1}稿里应有「我」`);
  });
  // 第三人称限知：贴着一个主角写
  const third = M.compose(
    Modes.normalizeParams({ mode: 'fiction', length: 'medium', versions: 1, fields: { part: 'plot', viewpoint: 'third', genre: 'real' } }),
    { input: FICTION_SRC },
    0
  );
  ok(/[他她]/.test(third), '第三人称的稿子里应出现「他」或「她」');
  // 六种类型：产出两两不同，且各自留下自己的器物与用词
  const GENRE_MARKS = {
    real: ['雨', '收银', '便利店', '末班', '塑料袋', '面馆'],
    mystery: ['监控', '门锁', '声控灯', '电梯', '折痕', '划痕'],
    scifi: ['舱', '气闸', '同步率', '舷窗', '日志', '导光条'],
    fantasy: ['铜铃', '结界', '药炉', '灯芯', '镇尺', '斗篷'],
    romance: ['伞', '咖啡', '电梯', '杯子', '车票', '外套'],
    history: ['更鼓', '坊门', '驿', '油灯', '算盘', '公文'],
  };
  const byGenre = {};
  Object.keys(GENRE_MARKS).forEach((genre) => {
    byGenre[genre] = M.compose(
      Modes.normalizeParams({ mode: 'fiction', length: 'long', versions: 1, fields: { part: 'open', viewpoint: 'third', genre: genre } }),
      { input: FICTION_SRC },
      0
    );
  });
  eq(new Set(Object.keys(byGenre).map((g) => byGenre[g])).size, 6, '六种类型应产出六份不同的稿子');
  Object.keys(GENRE_MARKS).forEach((genre) => {
    const hit = GENRE_MARKS[genre].filter((w) => byGenre[genre].indexOf(w) >= 0);
    ok(hit.length > 0, `${genre} 的稿子里应至少留下一处该类型的用语`);
  });
});

/* ---------------------------------------------------- 14 翻译（诚实说明） */
const TRANSLATE_SRC = '会议定在周四下午三点。\n请把材料提前发我，我这边先对一遍。';

group('翻译：离线引擎如实说明，不假装翻译', () => {
  const params = Modes.normalizeParams({ mode: 'translate', length: 'medium', versions: 4, fields: { target: 'en', shape: 'keep' } });
  const text = M.compose(params, { input: TRANSLATE_SRC }, 0);
  ok(text.indexOf('离线') >= 0, '说明里要点明「离线」');
  ok(text.indexOf('离线引擎不做翻译') >= 0, '应有一句「离线引擎不做翻译」');
  ok(text.indexOf('DEEPSEEK_API_KEY') >= 0, '应告诉用户怎么接上真实模型');
  ok(text.indexOf('目标语言：英文') >= 0, '应写明目标语言的中文名');
  ok(text.indexOf('会议定在周四下午三点。') >= 0, '原文要原样保留');
  ok(text.indexOf('请把材料提前发我，我这边先对一遍。') >= 0, '原文的每一段都要保留');
  ok(M.charCount(text) < params.chars, `说明 + 原文有意短于目标字数（实际 ${M.charCount(text)} < ${params.chars}）`);
  // 四个角度的说明互不相同
  const four = [0, 1, 2, 3].map((i) => M.compose(params, { input: TRANSLATE_SRC }, i));
  eq(new Set(four).size, 4, '四个角度应给出四份不同的说明');
  // 语气也进说明
  const literal = M.compose(Modes.normalizeParams({ mode: 'translate', length: 'short', versions: 1, tone: 'literal', fields: { target: 'en' } }), { input: TRANSLATE_SRC }, 0);
  const formal = M.compose(Modes.normalizeParams({ mode: 'translate', length: 'short', versions: 1, tone: 'formal', fields: { target: 'en' } }), { input: TRANSLATE_SRC }, 0);
  no(literal === formal, '不同语气的翻译说明不应完全相同');
  // 目标语言中文名
  const tw = M.compose(Modes.normalizeParams({ mode: 'translate', length: 'short', versions: 1, fields: { target: 'zh-tw' } }), { input: TRANSLATE_SRC }, 0);
  ok(tw.indexOf('目标语言：繁体中文') >= 0, 'zh-tw 应映射成「繁体中文」');
  const other = M.compose(
    Modes.normalizeParams({ mode: 'translate', length: 'short', versions: 1, fields: { target: 'other', targetCustom: '葡萄牙语' } }),
    { input: TRANSLATE_SRC },
    0
  );
  ok(other.indexOf('葡萄牙语') >= 0, 'target=other 时应使用 targetCustom 里填的语言名');
  // 中对照：给出「原文一段 / 译文待补」的骨架
  const bi = M.compose(Modes.normalizeParams({ mode: 'translate', length: 'short', versions: 1, fields: { target: 'ja', shape: 'bilingual' } }), { input: TRANSLATE_SRC }, 0);
  ok(bi.indexOf('【原文 1】') >= 0 && bi.indexOf('【译文 1】') >= 0, '中对照应给出原文/译文的对照骨架');
  ok(bi.indexOf('待补') >= 0, '译文一栏应写明待补');
  ok(bi.indexOf('请把材料提前发我，我这边先对一遍。') >= 0, '中对照里的原文一个字也不能丢');
  // 术语要求要带进说明
  const gl = M.compose(
    Modes.normalizeParams({ mode: 'translate', length: 'short', versions: 1, fields: { target: 'en', glossary: '把“抓手”译成 lever' } }),
    { input: TRANSLATE_SRC },
    0
  );
  ok(gl.indexOf('抓手') >= 0, '填了术语要求时应写进说明');
});

/* ---------------------------------------------------- 15 自定义模板（诚实说明） */
group('自定义模板：tpl_ 前缀走诚实说明，不拿内置模式的稿子充数', () => {
  const raw = { mode: 'tpl_demo0001', templateName: '周会纪要模板', length: 'medium', versions: 4 };
  const text = M.compose(raw, { input: TRANSLATE_SRC }, 0);
  ok(text.indexOf('离线') >= 0, '说明里要点明「离线」');
  ok(text.indexOf('离线引擎写不了') >= 0, '应有一句「离线引擎写不了自定义模板」');
  ok(text.indexOf('周会纪要模板') >= 0, '应带上模板名');
  ok(text.indexOf('DEEPSEEK_API_KEY') >= 0, '应告诉用户怎么接上真实模型');
  ok(text.indexOf('会议定在周四下午三点。') >= 0, '原文要原样留着');
  no(text.indexOf('（相关研究，年份）') >= 0, '自定义模板不该套用学术论文的产出');
  no(/^[一二三四五六]、/m.test(text), '自定义模板不该套用报告的章节结构');
  // 名字拿不到时退回「自定义模板」
  const nameless = M.compose({ mode: 'tpl_noName', length: 'short' }, { input: TRANSLATE_SRC }, 0);
  ok(nameless.indexOf('「自定义模板」') >= 0, '模板名拿不到时应退回「自定义模板」');
  // 服务端的真实调用方式：模板注册成板块后，模板名走第四个参数传进来
  if (typeof Modes.setCustomTemplates === 'function') {
    Modes.setCustomTemplates([{ id: 'demo0001', name: '竞品周报模板', system: '写一份竞品周报' }]);
    const viaOption = M.compose({ mode: 'tpl_demo0001', length: 'short' }, { input: TRANSLATE_SRC }, 0, { templateName: '竞品周报模板' });
    ok(viaOption.indexOf('竞品周报模板') >= 0, '服务端把模板名放在第四个参数里时也要认出来');
    const registered = Modes.normalizeParams({ mode: 'tpl_demo0001', length: 'short' });
    eq(registered.mode, 'tpl_demo0001', '注册过的模板板块应保留自己的 id');
    ok(M.compose(registered, { input: TRANSLATE_SRC }, 0).indexOf('离线引擎写不了') >= 0, '注册过的模板同样返回诚实说明');
    Modes.setCustomTemplates([]);
  }
  // 四个角度互不相同，同参数两次结果一致
  const four = [0, 1, 2, 3].map((i) => M.compose(raw, { input: TRANSLATE_SRC }, i));
  eq(new Set(four).size, 4, '四个角度应给出四份不同的说明');
  eq(M.compose(raw, { input: TRANSLATE_SRC }, 0), text, '同参数两次结果应逐字相同');
  ok(M.charCount(text) < Modes.normalizeParams(raw).chars, '说明 + 原文有意短于目标字数（离线引擎执行不了模板）');
});

/* ---------------------------------------------------- 16 新模式的语气与确定性 */
group('新模式：语气影响产出，四角度两两不同，同参数两次一致', () => {
  const CASES = [
    ['academic', ['rigorous', 'plain', 'critical', 'applied'], { section: 'intro' }],
    ['report', ['bluf', 'plain', 'data', 'crisp'], { kind: 'work', audience: 'leader' }],
    ['fiction', ['restrained', 'lyric', 'tense', 'light'], { part: 'open', viewpoint: 'third', genre: 'real' }],
  ];
  CASES.forEach((item) => {
    const mode = item[0];
    const tones = item[1];
    const fields = item[2];
    const texts = tones.map((tone) =>
      M.compose(Modes.normalizeParams({ mode: mode, length: 'medium', versions: 1, tone: tone, fields: fields }), { input: SOURCE }, 0)
    );
    eq(new Set(texts).size, tones.length, `${mode}：四种语气的产出应两两不同`);
    texts.forEach((t, i) => ok(M.charCount(t) > 100, `${mode}/${tones[i]} 应写得出来，实际 ${M.charCount(t)} 字`));
    const params = Modes.normalizeParams({ mode: mode, length: 'medium', versions: 4, fields: fields });
    eq(M.compose(params, { input: SOURCE }, 0), M.compose(params, { input: SOURCE }, 0), `${mode}：同参数两次结果应逐字相同`);
    const four = [0, 1, 2, 3].map((i) => M.compose(params, { input: SOURCE }, i));
    eq(new Set(four).size, 4, `${mode}：四个角度应产出四份不同的稿子`);
  });
});

/* ------------------------------------------------------------------ 汇总 */
const total = pass + failures.length;
console.log(`\n${failures.length ? '✗' : '✓'} 离线写作引擎：${pass}/${total} 项通过\n`);
if (failures.length) {
  failures.slice(0, 20).forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  if (failures.length > 20) console.log(`  …另有 ${failures.length - 20} 项失败未列出`);
  process.exitCode = 1;
}
