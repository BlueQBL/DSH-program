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
const ALL_MODES = ['continue', 'rewrite', 'copywriting', 'email', 'summary', 'outline'];

const BANNED = ['作为AI', '作为 AI', '希望对你有帮助', '以下是', '下面是为你', '（此处可补充）', 'TODO', 'XXX', 'Lorem'];

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

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
group('非空：6 种模式 × 4 个版本 × 空素材/正常素材都写得出来', () => {
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
  eq(checked, 48, '共应检查 48 篇');
});

/* ------------------------------------------------------------------ 3 篇幅 */
group('篇幅：短/中/长三档落在 ±30% 内，且长 > 中 > 短', () => {
  ['continue', 'email', 'copywriting'].forEach((mode) => {
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
group('模式差异：同一素材下六种模式产出两两不同', () => {
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

/* ------------------------------------------------------------------ 汇总 */
const total = pass + failures.length;
console.log(`\n${failures.length ? '✗' : '✓'} 离线写作引擎：${pass}/${total} 项通过\n`);
if (failures.length) {
  failures.slice(0, 20).forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  if (failures.length > 20) console.log(`  …另有 ${failures.length - 20} 项失败未列出`);
  process.exitCode = 1;
}
