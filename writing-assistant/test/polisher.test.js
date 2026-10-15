'use strict';

/**
 * 朱批定位与差异的测试。
 * 核心是两条性质：① 全部采纳后必须等于润色稿；② 一条都不采纳必须等于原稿。
 * 运行：node test/polisher.test.js
 */

const assert = require('assert');
const P = require('../lib/polisher.js');

let pass = 0;
const failures = [];

function eq(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected);
    pass += 1;
  } catch {
    failures.push(`${label}\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`);
  }
}

function ok(value, label) {
  eq(Boolean(value), true, label);
}

function group(name, fn) {
  const before = failures.length;
  fn();
  console.log(`  ${failures.length === before ? '✓' : '✗'} ${name}`);
}

/** 把差异条目按原样拼回「原文」，用来验证坐标没算错 */
function rebuild(original, edits) {
  const sorted = edits.slice().sort((a, b) => b.start - a.start);
  let out = original;
  sorted.forEach((e) => {
    out = out.slice(0, e.start) + (e.before || '') + out.slice(e.end);
  });
  return out;
}

const SRC = '今天开会讨论了新版本的上线时间。大家觉得周五太赶,不如推到下周一。';
const DST = '今天开会讨论了新版本的上线时间。大家认为周五太赶，不如推迟到下周一。';

console.log('分句与差异');

group('分句保留标点，拼回去等于原文', () => {
  const segs = P.splitSegments(SRC);
  eq(segs.join(''), SRC, '拼接还原');
  ok(segs.length >= 2, '至少切出两句');
  eq(P.splitSegments('')[0], '', '空串也返回一段');
});

group('原文等于改后时没有差异', () => {
  eq(P.diffEdits(SRC, SRC), [], '一模一样');
  eq(P.diffEdits('', ''), [], '两个空串');
});

group('差异坐标能把原文原样拼回来', () => {
  ['', SRC, 'ABC', '一二三四五六七八九十'].forEach((src, i) => {
    const dst = i % 2 ? 'X' : src + '尾巴';
    eq(rebuild(src, P.diffEdits(src, dst)), src, `第 ${i} 组差异坐标正确`);
  });
  eq(rebuild(SRC, P.diffEdits(SRC, DST)), SRC, '真实句子差异坐标正确');
});

group('逐字替换能定位到词，而不是整句重写', () => {
  const edits = P.diffEdits(SRC, DST);
  ok(edits.length >= 2, '至少抓到两处改动');
  ok(edits.some((e) => e.before.includes('觉得') || e.before.includes(',')), '抓到「觉得」或半角逗号');
  ok(edits.every((e) => e.end >= e.start && e.start >= 0), '坐标合法');
  ok(edits.every((e) => e.end <= SRC.length), '坐标不越界');
});

group('纯新增与纯删除分别标成 insert / delete', () => {
  const add = P.diffEdits('今天下雨。', '今天下大雨了。');
  ok(add.every((e) => e.op !== 'replace'), '不是替换');
  const del = P.diffEdits('今天下大雨了。', '今天下雨。');
  ok(del.length >= 1, '有差异');
  eq(rebuild('今天下大雨了。', del), '今天下大雨了。', '坐标正确');
});

console.log('改动说明定位');

group('唯一出现才认，重复出现一律不认', () => {
  eq(P.locate('这是一句话', '一句'), { start: 2, end: 4 }, '唯一片段能定位');
  eq(P.locate('一句又一句', '一句'), null, '出现两次拒绝定位');
  eq(P.locate('这是一句话', '不存在'), null, '找不到就返回空');
  eq(P.locate('这是一句话', ''), null, '空片段不认');
  eq(P.locate('这是一句话', 'x'.repeat(200)), null, '过长片段不认');
});

group('整理模型给的说明：排序、去重、丢掉对不上的', () => {
  const list = P.locateRewrites(SRC, [
    { before: '不如推到下周一', after: '不如顺延到下周一', type: 'wording', reason: '更书面' },
    { before: '大家觉得周五太赶', after: '大家认为周五太赶', type: 'wording', reason: '用词' },
    { before: '大家都觉得周五太赶', after: '大家认为周五太赶', type: 'wording', reason: '对不上原文' },
    { before: '大家觉得周五太赶', after: '大家认为周五太赶', type: 'wording', reason: '重复条目' },
    { before: '周五', after: '周五', type: 'wording', reason: '没改动' },
    { before: '觉得', after: '认为', type: '不是合法类型', reason: '类型非法' },
  ]);
  eq(list.length, 3, '三条有效');
  eq(list.map((e) => e.start), list.map((e) => e.start).slice().sort((a, b) => a - b), '按位置排好序');
  ok(list.some((e) => e.reason === '更书面'), '保留原因');
  eq(list.find((e) => e.before === '觉得').type, 'wording', '非法类型退回用词');
});

console.log('合并与采纳');

group('模型说明只给真实改动贴类型与原因，绝不改变改动本身', () => {
  const edits = P.mergeEdits(
    SRC,
    [{ before: '大家觉得周五太赶', after: '大家认为周五太赶', type: 'wording', reason: '用词更准' }],
    DST
  );
  ok(edits.length >= 2, '真实差异都被收下');
  const named = edits.filter((e) => e.source === 'model');
  ok(named.length >= 1, '说明覆盖到的改动被标为来自说明');
  eq(named.find((e) => e.before.includes('觉得')).reason, '用词更准', '原因贴上了');
  eq(named.find((e) => e.before.includes('觉得')).type, 'wording', '类型也用说明里的');
  ok(edits.some((e) => e.source === 'diff'), '说明没覆盖到的改动仍然由差异给出');
  eq(edits.map((e) => e.id), edits.map((e, i) => 'e' + (i + 1)), 'id 依次编号');
  eq(rebuild(SRC, edits), SRC, '合并后坐标依然正确');
});

group('说明覆盖的范围里，每处改动都带上这条原因', () => {
  const rewrites = [{ before: '大家觉得周五太赶', after: '大家认为周五太赶', type: 'wording', reason: '用词' }];
  const edits = P.mergeEdits(SRC, rewrites, DST);
  const span = P.locate(SRC, rewrites[0].before);
  const inside = edits.filter((e) => e.start >= span.start && e.end <= span.end);
  ok(inside.length >= 1, '说明范围内有改动');
  ok(inside.every((e) => e.reason === '用词'), '范围内的改动都带原因');
  const outside = edits.filter((e) => e.start < span.start || e.end > span.end);
  ok(outside.every((e) => e.reason === ''), '范围外的改动没有被误贴原因');
});

group('一条都不采纳等于原稿，全部采纳等于润色稿', () => {
  const plain = P.mergeEdits(SRC, [], DST);
  eq(P.applyEdits(SRC, plain, []), SRC, '不采纳保持原样');
  eq(P.applyEdits(SRC, plain, new Set(plain.map((e) => e.id))), DST, '全采纳得到润色稿');

  // 即使模型把同一段描述成另一种改法，全部采纳也必须落在润色稿上
  const named = P.mergeEdits(SRC, [{ before: '不如推到下周一', after: '不如顺延到下周一', type: 'wording', reason: '更书面' }], DST);
  eq(P.applyEdits(SRC, named, []), SRC, '带说明时不采纳也保持原样');
  eq(P.applyEdits(SRC, named, new Set(named.map((e) => e.id))), DST, '带说明时全采纳仍然等于润色稿');
});

group('只采纳一半时，只有那半边的改动生效', () => {
  const edits = P.mergeEdits(SRC, [], DST);
  const onlyComma = edits.find((e) => e.before === ',' || e.after === '，');
  ok(onlyComma, '找得到半角逗号那一处');
  const out = P.applyEdits(SRC, edits, [onlyComma.id]);
  ok(out.includes('，'), '逗号被改成了全角');
  ok(out.includes('觉得'), '「觉得」没被动');
  ok(out.includes('推到'), '「推到」没被动');
});

group('插入型改动没有可删内容也能落位', () => {
  const before = '会议定在下午三点。';
  const after = '会议定在下午三点，地点在二楼会议室。';
  const edits = P.mergeEdits(before, [], after);
  eq(P.applyEdits(before, edits, new Set(edits.map((e) => e.id))), after, '插入也能全采纳还原润色稿');
  eq(rebuild(before, edits), before, '插入条目不影响原文还原');
});

console.log('渲染与统计');

group('渲染片段：原文、划线待删、朱字新增', () => {
  const edits = P.mergeEdits(SRC, [], DST);
  const spans = P.renderSpans(SRC, edits);
  const sameAndDel = spans.filter((s) => s.kind !== 'ins').map((s) => s.text).join('');
  eq(sameAndDel, SRC, '非新增片段拼起来就是原文');
  ok(spans.some((s) => s.kind === 'ins'), '有新增片段');
  ok(spans.some((s) => s.kind === 'del'), '有删除片段');
  spans.forEach((s) => {
    if (s.kind !== 'same') ok(s.editId, '改动片段带得上条目 id');
  });
  eq(P.renderSpans(SRC, []), [{ kind: 'same', text: SRC }], '没有改动时整段原样');
});

group('重叠条目不会把文字切碎', () => {
  const edits = [
    { id: 'e1', op: 'replace', start: 0, end: 4, before: '今天开会', after: '昨天开会' },
    { id: 'e2', op: 'replace', start: 2, end: 6, before: '开会讨论', after: '碰了一下' },
  ];
  const spans = P.renderSpans(SRC, edits);
  eq(spans.filter((s) => s.kind !== 'ins').map((s) => s.text).join(''), SRC, '原文完整且不重复');
});

group('统计按类型归类', () => {
  const edits = P.mergeEdits(SRC, [
    { before: '觉得', after: '认为', type: 'wording', reason: '用词' },
    { before: ',', after: '，', type: 'punct', reason: '标点' },
  ], DST);
  const s = P.stats(edits);
  ok(s.total >= 2, '总数正确');
  eq(s.named, 2, '两条带说明');
  ok(s.byType.wording >= 1 && s.byType.punct >= 1, '分类正确');
  ok(s.list.every((x) => x.label && x.mark && x.count > 0), '概览每一项都可显示');
});

console.log('解析模型回复');

group('代码块里的 JSON 也能抠出来', () => {
  const raw = '好的，结果如下：\n```json\n{"polished":"改好了","rewrites":[{"before":"a","after":"b","type":"wording","reason":"ok"}]}\n```\n以上。';
  const data = P.extractJson(raw);
  eq(data.polished, '改好了', '取出润色稿');
  eq(data.rewrites.length, 1, '取出改动');
});

group('嵌套花括号与转义引号不会提前截断', () => {
  const raw = '{"polished":"他说：\\"行\\"","rewrites":[],"meta":{"a":{"b":1}}}';
  const data = P.extractJson(raw);
  eq(data.polished, '他说："行"', '转义引号解析正确');
  eq(data.meta.a.b, 1, '嵌套对象完整');
});

group('模型跑偏时：整段当润色稿，差异交给比对兜底', () => {
  const plain = P.parseReply('今天开会讨论了新版本的上线时间。大家认为周五太赶，不如推迟到下周一。', SRC);
  eq(plain.parsed, false, '认得不是 JSON');
  ok(plain.polished.includes('认为'), '纯文本被当成润色稿');
  eq(plain.rewrites, [], '没有改动说明');

  const broken = P.parseReply('{这里坏了', SRC);
  eq(broken.polished, SRC, '彻底解析不了就退回原文');
  eq(broken.rewrites, []);

  const out = P.mergeEdits(SRC, broken.rewrites, broken.polished);
  eq(out.length, 0, '退回原文时不会有朱批');

  const alt = P.parseReply('{"result":"改后的文本","edits":[{"before":"x","after":"y","type":"wording"}]}', SRC);
  eq(alt.polished, '改后的文本', '兼容 result 字段名');
  eq(alt.rewrites.length, 1, '兼容 edits 字段名');
});

group('类型表覆盖提示词里允许的全部类型', () => {
  const types = Object.keys(P.TYPES);
  eq(types.sort(), ['collocation', 'grammar', 'order', 'punct', 'redundant', 'tone', 'typo', 'wording'], '八个类型');
  types.forEach((t) => ok(P.TYPES[t].label && P.TYPES[t].mark, `${t} 有中文名与标记`));
});

console.log('两稿对比');

group('对比：差异条目、相似度、增删字数', () => {
  const r = P.compare(SRC, DST);
  ok(r.edits.length >= 2, `抓到 ${r.edits.length} 处不同`);
  eq(r.identical, false, '不是同一份');
  ok(r.similarity > 0.5 && r.similarity < 1, `相似度落在合理区间（${(r.similarity * 100).toFixed(0)}%）`);
  ok(r.removedChars > 0, '有被删改的字');
  ok(r.addedChars > 0, '有新增的字');
  eq(r.before, SRC, '带上左稿全文');
  eq(r.after, DST, '带上右稿全文');
  eq(P.applyEdits(SRC, r.edits, new Set(r.edits.map((e) => e.id))), DST, '对比给出的改动能把左稿还原成右稿');
  r.edits.forEach((e) => {
    eq(e.id.slice(0, 1), 'c', 'id 有独立前缀（不与朱批条目混用）');
    ok(P.TYPES[e.type], '给出了可读的类型');
  });
});

group('对比：一模一样时明确说没有差异', () => {
  const same = P.compare(SRC, SRC);
  eq(same.identical, true, '标记为完全相同');
  eq(same.edits, [], '没有差异条目');
  eq(same.similarity, 1, '相似度 100%');
  eq(same.addedChars, 0, '没有新增');
  eq(same.removedChars, 0, '没有删改');
});

group('对比：长度悬殊与空文本都不崩', () => {
  const grew = P.compare('短短一句。', '短短一句。后面又补了很长很长的一段内容，用来测试长度悬殊时的表现。');
  eq(grew.identical, false, '不一样');
  ok(grew.similarity < 1 && grew.similarity > 0, '相似度在 0 到 1 之间');
  eq(grew.removedChars, 0, '只增不删时删改字数为 0');

  const empty = P.compare('', '凭空出现的一段话。');
  eq(empty.removedChars, 0, '空对非空：没有删改');
  ok(empty.addedChars > 0, '全是新增');
  eq(P.compare('', '').similarity, 1, '两个空串算完全相同');
  eq(P.compare('', '').identical, true, '两个空串完全一致');
});

group('对比与朱批用同一套差异引擎，口径一致', () => {
  const a = '他说的非常非常对。';
  const b = '他说得很对。';
  const compared = P.compare(a, b).edits;
  const merged = P.mergeEdits(a, [], b);
  eq(
    compared.map((e) => [e.start, e.end, e.before, e.after]),
    merged.map((e) => [e.start, e.end, e.before, e.after]),
    '两处给出的位置与文段完全相同'
  );
  eq(P.compare(a, b).stats.total, P.stats(merged).total, '统计口径也一致');
});

const total = pass + failures.length;
console.log(`\n通过 ${pass}/${total}`);
if (failures.length) {
  console.log('\n失败项：');
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exitCode = 1;
}
