'use strict';

/**
 * 模式目录与参数规整的测试：这是界面、提示词、离线引擎三方共用的地基。
 * 运行：node test/modes.test.js
 */

const assert = require('assert');
const Modes = require('../lib/modes.js');
const Prompt = require('../lib/prompt.js');

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

function near(actual, expected, tol, label) {
  const diff = Math.abs(Number(actual) - Number(expected));
  if (diff <= tol) pass += 1;
  else failures.push(`${label}\n    期望 ≈${expected}(±${tol})\n    实际 ${actual}`);
}

function group(name, fn) {
  const before = failures.length;
  fn();
  console.log(`  ${failures.length === before ? '✓' : '✗'} ${name}`);
}

console.log('模式目录与参数');

group('六种模式都在，键值齐备', () => {
  eq(Modes.MODES.length, 6, '模式数量');
  eq(Modes.listModeIds(), ['continue', 'rewrite', 'copywriting', 'email', 'summary', 'outline'], '模式顺序');
  Modes.MODES.forEach((m) => {
    ok(m.name && m.mark && m.tagline, `${m.id} 有名称/单字/一句话说明`);
    eq(m.mark.length, 1, `${m.id} 的稿签单字只有一个字`);
    ok(m.input && m.input.label && m.input.placeholder, `${m.id} 有素材字段定义`);
    ok(m.outputHint && m.outputHint.length > 5, `${m.id} 有输出要求`);
    ok(m.fields.length >= 1, `${m.id} 至少一个附加字段`);
    ok(m.angles.length >= 3, `${m.id} 至少三个版本角度`);
    ok(m.tones.length >= 3, `${m.id} 至少三种语气`);
    m.fields.forEach((f) => {
      if (f.type === 'select') {
        ok(f.options.length >= 2, `${m.id}.${f.id} 选项足够`);
        ok(f.options.some((o) => o.value === f.value), `${m.id}.${f.id} 默认值在选项里`);
      } else {
        ok(typeof f.value === 'string', `${m.id}.${f.id} 文本字段有默认值`);
      }
    });
  });
});

group('取模式：认识的按 id 取，不认识的退回第一个', () => {
  eq(Modes.getMode('email').name, '邮件撰写', '按 id 取');
  eq(Modes.getMode('不存在').id, Modes.MODES[0].id, '未知 id 退回第一个');
  eq(Modes.getMode(undefined).id, Modes.MODES[0].id, '缺参数也不炸');
});

group('版本角度按下标循环取，不会越界', () => {
  eq(Modes.angleOf('email', 0).id, Modes.getMode('email').angles[0].id, '第一个角度');
  eq(Modes.angleOf('email', 9).id, Modes.angleOf('email', 9 % Modes.getMode('email').angles.length).id, '越界自动绕回');
  eq(Modes.angleOf('summary', -1).id, Modes.angleOf('summary', Modes.getMode('summary').angles.length - 1).id, '负数也能取到角度');
});

group('默认附加字段来自模式定义', () => {
  eq(Modes.defaultFields('copywriting').platform, 'xiaohongshu', '文案默认平台');
  eq(Modes.defaultFields('rewrite').strength, 'medium', '改写默认力度');
  eq(Object.keys(Modes.defaultFields('outline')).length, 1, '大纲只有一个字段');
});

group('参数规整：越界的都夹回来了', () => {
  const p = Modes.normalizeParams({ mode: 'rewrite', creativity: 9, versions: 99 });
  eq(p.mode, 'rewrite', '保留模式');
  eq(p.creativity, Modes.CREATIVITY_MAX, '创意度封顶');
  eq(p.versions, Modes.angleCount('rewrite'), '版本数不超过角度数');

  const q = Modes.normalizeParams({ mode: 'email', creativity: -5, versions: 0 });
  eq(q.creativity, 0, '创意度封底');
  eq(q.versions, 1, '至少一稿');

  const r = Modes.normalizeParams({});
  eq(r.mode, 'continue', '没给模式时默认续写');
  eq(r.length, 'medium', '没给篇幅时默认中篇');
  eq(r.tone, Modes.getMode('continue').tones[0].value, '没给语气时取模式第一个');
});

group('参数规整：篇幅与 token 换算', () => {
  eq(Modes.normalizeParams({ length: 'short' }).chars, 200, '短篇字数');
  eq(Modes.normalizeParams({ length: 'long' }).chars, 900, '长篇字数');
  ok(Modes.normalizeParams({ length: 'long' }).tokens > Modes.normalizeParams({ length: 'short' }).tokens, '长篇 token 更多');
  const custom = Modes.normalizeParams({ length: 'custom', customChars: 99999 });
  eq(custom.chars, Modes.LIMITS.customCharsMax, '自定义字数封顶');
  eq(Modes.normalizeParams({ length: 'custom', customChars: 1 }).chars, Modes.LIMITS.customCharsMin, '自定义字数有下限');
  const bogus = Modes.normalizeParams({ length: '超长' });
  eq(bogus.length, 'medium', '未知篇幅退回中篇');
});

group('参数规整：附加字段只接受合法值', () => {
  const p = Modes.normalizeParams({ mode: 'copywriting', fields: { platform: '不存在的平台', selling: 'x'.repeat(200) } });
  eq(p.fields.platform, 'xiaohongshu', '非法选项退回默认');
  eq(p.fields.selling.length, 60, '文本字段按上限截断');

  const q = Modes.normalizeParams({ mode: 'email', fields: { to: '王经理', matter: '确认延期' } });
  eq(q.fields.to, '王经理', '合法文本字段保留');
  eq(q.fields.expect, 'confirm', '未提供的字段取默认值');

  const r = Modes.normalizeParams({ mode: 'email', fields: { 恶意字段: '值' } });
  eq(Object.keys(r.fields).includes('恶意字段'), false, '不认识的字段时间被丢掉');
});

group('创意度档位与篇幅档位可反查', () => {
  eq(Modes.creativityStop(0.8).label, '均衡', '0.8 命中均衡');
  eq(Modes.creativityStop(0.75).label, '均衡', '0.75 就近取均衡');
  eq(Modes.creativityStop(99).label, '放飞', '越界取最后一个');
  eq(Modes.lengthPreset('long').chars, 900, '按 id 取篇幅');
  eq(Modes.lengthPreset('瞎写').id, 'medium', '未知篇幅退回中篇');
});

group('参数描述是一行人话', () => {
  const text = Modes.describeParams({ mode: 'copywriting', creativity: 1.1, length: 'short', tone: 'lively' });
  ok(text.includes('文案生成'), '含模式名');
  ok(text.includes('灵动'), '含创意度档位');
  ok(text.includes('200'), '含字数');
  ok(text.includes('轻快'), '含语气');
});

console.log('提示词');

group('系统提示带上了语气、创意度、篇幅与禁令', () => {
  const s = Prompt.systemPrompt({ mode: 'rewrite', creativity: 0.2, length: 'short', tone: 'formal' });
  ok(s.includes('内容改写'), '含模式名');
  ok(s.includes('严格保守'), '低创意度走保守措辞');
  ok(s.includes('200'), '含篇幅');
  ok(s.includes('更正式'), '含语气说明');
  ok(s.includes('不要编造'), '含不许编造事实的硬要求');
  ok(Prompt.systemPrompt({ mode: 'rewrite', creativity: 1.4 }).includes('大胆'), '高创意度走大胆措辞');
});

group('用户提示带上素材、附加要求与本稿角度', () => {
  const u = Prompt.userPrompt(
    { mode: 'email', fields: { to: '王经理', matter: '确认延期两天' }, tone: 'formal' },
    { input: '通知供应商交付顺延' },
    0
  );
  ok(u.includes('通知供应商交付顺延'), '含素材原文');
  ok(u.includes('王经理'), '含收件人');
  ok(u.includes('本稿角度'), '含角度');
  ok(u.includes('第 1 稿'), '标明是第几稿');
});

group('不同版本的角度说明不同，逼出差别', () => {
  const a = Prompt.userPrompt({ mode: 'copywriting' }, { input: '咖啡机' }, 0);
  const b = Prompt.userPrompt({ mode: 'copywriting' }, { input: '咖啡机' }, 1);
  ok(a !== b, '两稿提示词不同');
  ok(a.includes(Modes.angleOf('copywriting', 0).brief), '第 1 稿带自己的角度说明');
  ok(b.includes(Modes.angleOf('copywriting', 1).brief), '第 2 稿带自己的角度说明');
});

group('一条消息体：系统 + 用户', () => {
  const msgs = Prompt.buildMessages({ mode: 'summary' }, { input: '长文' }, 0);
  eq(msgs.length, 2, '两条消息');
  eq(msgs[0].role, 'system', '先系统');
  eq(msgs[1].role, 'user', '后用户');
});

group('校对提示要求严格 JSON，且不许为了凑数硬改', () => {
  const s = Prompt.polishSystem();
  ok(s.includes('JSON'), '要求 JSON');
  ok(s.includes('不要为了凑数硬改'), '明确不许硬改');
  ok(s.includes('不改变原意'), '明确保意');
  Prompt.POLISH_TYPES.forEach((t) => {
    ok(s.includes(t.id), `类型 ${t.id} 出现在提示里`);
  });
  const u = Prompt.polishUser('这是一段原文', { focus: '标点' });
  ok(u.includes('这是一段原文'), '待校对文本在里面');
  ok(u.includes('标点'), '重点要求在里面');
});

group('创意度措辞按档递进', () => {
  const words = [0.2, 0.5, 0.8, 1.1, 1.4].map((v) => Prompt.creativityWord(v));
  eq(new Set(words).size, 5, '五档措辞互不相同');
});

const total = pass + failures.length;
console.log(`\n通过 ${pass}/${total}`);
if (failures.length) {
  console.log('\n失败项：');
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exitCode = 1;
}
