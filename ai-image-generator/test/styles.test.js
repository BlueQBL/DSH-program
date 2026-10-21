'use strict';

/**
 * 尺寸 / 风格 / 请求组装的测试。
 * 运行：node test/styles.test.js
 */

const { eq, ok, not, has, group, report } = require('./harness.js');
const Styles = require('../lib/styles.js');

(async function main() {
  console.log('尺寸表与约束');

  await group('八种画幅都在平台允许的范围内', () => {
    eq(Styles.SIZE_TABLE.length, 8, '八种画幅');
    let bad = [];
    for (const row of Styles.SIZE_TABLE) {
      for (const tier of Styles.TIERS) {
        const size = row.sizes[tier];
        const check = Styles.validateSize(size);
        if (!check.ok) bad.push(`${row.ratio}/${tier}:${size}(${check.reason})`);
      }
    }
    eq(bad, [], '所有预设尺寸都通过 validateSize（16 的倍数、比例 ≤3:1、像素范围）');
  });

  await group('validateSize 该拦的都拦住', () => {
    eq(Styles.validateSize('1024x1024').ok, true, '1024x1024 可以');
    eq(Styles.validateSize('1025x1024').ok, false, '不是 16 的倍数不行');
    eq(Styles.validateSize('4096x1024').ok, false, '长宽比超过 3:1 不行');
    eq(Styles.validateSize('256x256').ok, false, '像素太少不行');
    eq(Styles.validateSize('4096x2048').ok, false, '边长超过 3840 不行');
    eq(Styles.validateSize('abc').ok, false, '写错格式不行');
    has(Styles.validateSize('1025x1024').reason, '16 的倍数', '原因说清楚');
  });

  await group('模型不支持某个尺寸时，就近换成它收的那一档', () => {
    const free = Styles.resolveSize('gpt-image-2', '1280x720');
    eq(free.size, '1280x720', 'gpt-image 系原样通过');
    eq(free.note, '', '没有额外说明');

    const three = Styles.resolveSize('dall-e-3', '1280x720');
    eq(three.size, '1792x1024', 'dall-e-3 换成最接近的横版');
    eq(three.exact, false, '标记为不是原样');
    has(three.note, '三档', '说明为什么换');

    const two = Styles.resolveSize('dall-e-2', '1008x672');
    eq(two.size, '1024x1024', 'dall-e-2 换成方图');

    const unknown = Styles.resolveSize('flux-schnell', '1000x1000');
    eq(unknown.size, '1024x1024', '不认识的模型按平台规则兜底');
    has(unknown.note, '16 的倍数', '把原因写出来');
  });

  await group('画质按模型取值，dall-e-2 干脆不传', () => {
    eq(Styles.resolveQuality('gpt-image-2', 'low').quality, 'low', 'gpt-image 系直接用档位名');
    eq(Styles.resolveQuality('dall-e-3', 'high').quality, 'hd', 'dall-e-3 的 high 对应 hd');
    eq(Styles.resolveQuality('dall-e-3', 'low').quality, 'standard', 'dall-e-3 的 low 对应 standard');
    eq(Styles.resolveQuality('dall-e-2', 'high').quality, '', 'dall-e-2 不传画质');
    has(Styles.resolveQuality('dall-e-2', 'high').note, '没有画质档位', '说明了为什么省略');
    eq(Styles.resolveQuality('gpt-image-1', '不认识').quality, Styles.DEFAULT_QUALITY, '不认识的档位退回默认');
  });

  console.log('提示词组装');

  await group('最终提示词 = 描述 + 画幅说明 + 风格后缀', () => {
    const prompt = Styles.composePrompt('雨后的老城区，红伞', 'photo', '1280x720');
    has(prompt, '雨后的老城区，红伞', '原描述原样保留');
    has(prompt, 'widescreen', '带上画幅说明');
    has(prompt, 'photorealistic', '带上风格后缀');

    const portrait = Styles.composePrompt('一个人', 'anime', '720x1280');
    has(portrait, 'vertical', '竖幅带上竖构图说明');
    has(portrait, 'anime', '风格后缀跟风格走');
  });

  await group('描述会收口：多余空白压成一个、超长截断', () => {
    eq(Styles.cleanPrompt('  两个   空格\n\t换行  '), '两个 空格 换行', '压成单空格');
    eq(Styles.cleanPrompt(null), '', 'null 变成空串');
    eq(Styles.cleanPrompt('x'.repeat(5000)).length, Styles.LIMITS.promptMax, '超长按上限截断');
  });

  await group('buildRequest 给出要发给上游的东西', () => {
    const out = Styles.buildRequest({ prompt: '  一只白猫  ', styleId: 'watercolor', size: '2048x1152', quality: 'high', model: 'gpt-image-2' });
    eq(out.prompt, '一只白猫', '描述收口');
    eq(out.size, '2048x1152', '尺寸原样');
    eq(out.quality, 'high', '画质原样');
    eq(out.style.id, 'watercolor', '风格 id');
    eq(out.n, 1, '一次一张');
    has(out.finalPrompt, 'watercolor', '最终提示词带风格');
    eq(out.sizeNote, '', '没有替换说明');

    const dell3 = Styles.buildRequest({ prompt: 'a cat', styleId: 'photo', size: '1024x1024', quality: 'low', model: 'dall-e-3' });
    eq(dell3.quality, 'standard', 'dall-e-3 的画质被翻译');
  });

  await group('预设清单够界面用', () => {
    const presets = Styles.listPresets();
    eq(presets.ratios.length, 8, '八种画幅');
    ok(presets.ratios.every((r) => r.hint && r.sizes['1K']), '每种画幅都有构图说明和三档尺寸');
    eq(presets.styles.length, Styles.STYLES.length, '风格全给出');
    ok(presets.styles.every((s) => s.id && s.label && s.en), '风格有 id / 名字 / 英文后缀');
    eq(presets.qualities.length, 3, '三档画质');
    eq(presets.tiers, ['1K', '2K', '4K'], '三档清晰度');
    eq(Styles.sizeOf('16:9', '2K'), '2048x1152', '比例 + 清晰度能算出像素');
    eq(Styles.sizeOf('不存在的比例', '9K'), '1024x1024', '乱填退回默认');
  });

  await group('尺寸规则查得出来（界面上要提示固定尺寸的模型）', () => {
    eq(Styles.sizeRuleOf('dall-e-3').kind, 'fixed', 'dall-e-3 是固定尺寸');
    eq(Styles.sizeRuleOf('dall-e-3').allowed.length, 3, '三档');
    eq(Styles.sizeRuleOf('gpt-image-2').kind, 'flexible', 'gpt-image 系自由');
    eq(Styles.sizeRuleOf('flux-schnell').allowed, [], '不认识的模型没有固定档位');
  });

  await group('画幅标签是「4:3」这种，不是给模型看的构图说明', () => {
    eq(Styles.ratioLabel('1024x768'), '4:3', '1024×768 是 4:3');
    eq(Styles.ratioLabel('1280x720'), '16:9', '1280×720 是 16:9');
    eq(Styles.ratioLabel('1024x1024'), '1:1', '方图');
    eq(Styles.ratioLabel('1792x1024'), '7:4', 'dall-e-3 的横版按实际比例算（不硬套 16:9）');
    eq(Styles.ratioLabel('不是尺寸'), '', '认不出就给空串');
    // 构图说明和比例标签是两件事，别混用
    has(Styles.ratioHintOf('1024x768'), 'framing', '构图说明是给模型看的一句英文');
  });

  report('styles');
})();
