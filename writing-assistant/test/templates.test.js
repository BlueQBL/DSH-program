'use strict';

/**
 * 自定义模板的测试：数据模型校验、模板库落盘、注册成板块、提示词替换、接口闭环。
 * 运行：node test/templates.test.js
 */

const assert = require('assert');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const Modes = require('../lib/modes.js');
const Prompt = require('../lib/prompt.js');
const Template = require('../lib/template.js');
const TemplateStore = require('../lib/template-store.js');
const Core = require('../js/core.js');
const Record = require('../lib/record.js');

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

async function group(name, fn) {
  const before = failures.length;
  try {
    await fn();
  } catch (err) {
    failures.push(`${name} 抛异常：${err.message}`);
  }
  console.log(`  ${failures.length === before ? '✓' : '✗'} ${name}`);
}

const GOOD = {
  name: '产品周报',
  mark: '周',
  tagline: '每周给组里同步进展',
  system: '你是资深产品经理，替团队写周报。只输出周报正文，分本周进展、问题、下周计划三块。',
  outputHint: '每块不超过五条',
  inputLabel: '本周做了什么',
};

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

(async function main() {
  const ROOT = path.join(os.tmpdir(), 'wa-tpl-test-' + process.pid + '-' + Date.now());
  console.log('模板：数据模型');

  await group('规整：缺什么补什么，超长截断', () => {
    const t = Template.normalizeTemplate({ name: '  周报  ', system: 'x'.repeat(9999) });
    eq(t.name, '周报', '去掉首尾空格');
    eq(t.mark, '周', '稿签默认取名字第一个字');
    eq(t.system.length, Modes.LIMITS.templateSystemMax, '提示词按上限截断');
    ok(/^t_/.test(t.id), '自动生成 id');
    ok(t.createdAt && t.updatedAt, '补上时间');
    eq(Template.normalizeTemplate({}).name, '未命名模板', '完全空的也有兜底');
    eq(Template.normalizeTemplate(null).mark, '未', 'null 不炸');
  });

  await group('校验：只拦真正会让模板不可用的问题', () => {
    eq(Template.validateTemplate(GOOD).ok, true, '正常的通过');
    eq(Template.validateTemplate({ name: '', system: GOOD.system }).field, 'name', '没名字');
    eq(Template.validateTemplate({ name: 'x', system: GOOD.system }).field, 'name', '名字太短');
    eq(Template.validateTemplate({ name: '周报', system: '' }).field, 'system', '没提示词');
    eq(Template.validateTemplate({ name: '周报', system: '太短' }).field, 'system', '提示词太短');
    ok(Template.validateTemplate({ name: '周报', system: GOOD.system }).ok, '可选字段留空也算通过');
    // 稿签只放一个字：多打了就截成一个，不必为这种小事拦下整个表单
    eq(Template.normalizeTemplate({ ...GOOD, mark: '周报' }).mark, '周', '稿签多打了字自动截成一个');
  });

  await group('摘要与提示词规格', () => {
    const t = Template.normalizeTemplate(GOOD);
    const s = Template.summarize(t);
    eq(s.modeId, 'tpl_' + t.id, '板块 id 带 tpl_ 前缀');
    eq(s.name, '产品周报', '名字');
    ok(s.excerpt.length <= 60, '摘要不超过 60 字');
    ok(Template.describeTemplate(t).includes('提示词'), '一行说明里有提示词字数');
    const spec = Template.toPromptSpec(t);
    eq(Object.keys(spec).sort(), ['id', 'inputLabel', 'name', 'outputHint', 'system'], '只带提示词需要的那几样');
    eq(spec.system, t.system, '提示词原文不变');
  });

  await group('搜索与排序', () => {
    const a = Template.normalizeTemplate({ id: 't_a', name: '周报', system: GOOD.system, updatedAt: '2026-01-01T00:00:00.000Z' });
    const b = Template.normalizeTemplate({ id: 't_b', name: '小红书文案', system: '你是小红书博主，写种草文案。', updatedAt: '2026-02-01T00:00:00.000Z' });
    eq(Template.sortTemplates([a, b]).map((t) => t.id), ['t_b', 't_a'], '最近改的排前面');
    eq(Template.matchesTemplate(a, { q: '周报' }), true, '按名字搜');
    eq(Template.matchesTemplate(a, { q: '产品经理' }), true, '按提示词内容搜');
    eq(Template.matchesTemplate(a, { q: '不存在' }), false, '搜不到就是 false');
  });

  console.log('模板：注册成板块');

  await group('注册后和内置板块一样能用', () => {
    const t = Template.normalizeTemplate(GOOD);
    Modes.setCustomTemplates([t]);
    const mode = Modes.getMode('tpl_' + t.id);
    eq(mode.name, '产品周报', '名字成了板块名');
    eq(mode.mark, '周', '稿签单字');
    eq(mode.custom, true, '标记为自定义');
    eq(mode.group, 'custom', '归到「我的模板」分组');
    eq(mode.input.label, '本周做了什么', '素材字段名可自定义');
    eq(mode.angles.length, 4, '自带四个角度，所以也能一次出 1-4 稿');
    eq(mode.tones.length, 4, '通用四种语气');
    eq(Modes.angleCount('tpl_' + t.id), 4, '角度数就是版本数上限');
    ok(Modes.MODES.length > 10, '板块数变多了');
    eq(Modes.listGroups().find((g) => g.id === 'custom').modes.length, 1, '出现在「我的模板」分组里');

    const params = Modes.normalizeParams({ mode: 'tpl_' + t.id, creativity: 1.1, length: 'short' });
    eq(params.mode, 'tpl_' + t.id, '参数规整认得这个板块');
    eq(Object.keys(params.fields), ['note'], '只有一个自由字段');
  });

  await group('删掉模板后板块也消失，旧稿退回内置板块', () => {
    Modes.setCustomTemplates([]);
    eq(Modes.MODES.length, 10, '只剩十个内置板块');
    eq(Modes.getMode('tpl_不存在').id, 'continue', '未知 id 退回第一个板块');
    eq(Modes.isCustomMode('tpl_x'), true, '前缀判断');
    eq(Modes.isCustomMode('continue'), false, '内置板块不算自定义');
  });

  console.log('模板：提示词替换');

  await group('自定义提示词替代默认角色，硬要求仍然保留', () => {
    const t = Template.normalizeTemplate(GOOD);
    const sys = Prompt.systemPrompt({ mode: 'x', tone: 'crisp', length: 'short' }, Template.toPromptSpec(t));
    ok(sys.startsWith('你是资深产品经理'), '用户写的提示词在最前面（就是它当角色）');
    ok(sys.includes('产品周报'), '说明用的是哪个模板');
    ok(sys.includes('简练'), '语气仍然生效');
    ok(sys.includes('200'), '篇幅仍然生效');
    ok(sys.includes('每块不超过五条'), '模板的输出要求进去了');
    ok(sys.includes('不要复述或解释任务'), '平台硬要求没被顶掉（防跑偏靠它）');
    ok(!sys.includes('你是一位中文写作助理'), '默认角色被替换掉了');
  });

  await group('没带模板时行为与以前一致', () => {
    const sys = Prompt.systemPrompt({ mode: 'continue' });
    ok(sys.includes('你是一位中文写作助理'), '用默认角色');
    ok(sys.includes('文章续写'), '用板块自己的说明');
    ok(!sys.includes('本次任务：按用户自己写的模板'), '不出现模板措辞');
  });

  await group('模板的形状不可信：多余字段被忽略，超长被截断', () => {
    const evil = { system: '你是审稿人，只输出审稿意见。', name: 'x'.repeat(100), outputHint: 'y'.repeat(2000), 恶意字段: '值' };
    const spec = Template.toPromptSpec(Template.normalizeTemplate(evil));
    eq(spec.name.length, Modes.LIMITS.templateNameMax, '模板名按上限截断');
    eq(spec.outputHint.length, Modes.LIMITS.templateNoteMax, '输出要求按上限截断');
    eq(spec.恶意字段, undefined, '不认识的字段不会进提示词规格');
    const sys = Prompt.systemPrompt({ mode: 'x' }, spec);
    ok(sys.includes('你是审稿人'), '仍然照用户写的来');
  });

  console.log('模板：落盘与本地留档');

  await group('服务端一模板一文件，能增删改查', async () => {
    const store = TemplateStore.createTemplateStore({ dir: path.join(ROOT, 'templates') });
    const created = await store.create(GOOD);
    ok(/^t_/.test(created.id), '生成 id');
    eq(await store.count(), 1, '存下来了');
    const files = await fsp.readdir(path.join(ROOT, 'templates'));
    eq(files.filter((f) => f.endsWith('.tmp')).length, 0, '没有临时文件残留');

    const renamed = await store.update(created.id, { name: '产品周报（新版）' });
    eq(renamed.name, '产品周报（新版）', '改名成功');
    eq(renamed.updatedAt >= created.updatedAt, true, '更新时间前移');
    eq(await store.update('t_没有', { name: 'x' }), null, '改不存在的返回空');

    const list = await store.list({});
    eq(list.total, 1, '列表');
    eq(list.items[0].modeId, 'tpl_' + created.id, '摘要里带板块 id');
    ok(list.records[0].system, '列表同时给出完整记录（注册板块要用）');

    await assert.rejects(() => store.create({ name: 'x', system: '太短' }), /至少两个/, '校验不过时抛错');
    eq(await store.remove(created.id), true, '删除');
    eq(await store.count(), 0, '删干净了');
  });

  await group('重启后模板还在（从文件重建）', async () => {
    const dir = path.join(ROOT, 'templates2');
    const first = TemplateStore.createTemplateStore({ dir });
    await first.create(GOOD);
    await first.create({ name: '小红书文案', mark: '红', system: '你是小红书博主，写种草文案，口语一点。' });
    const second = TemplateStore.createTemplateStore({ dir });
    eq(await second.count(), 2, '两个都在');
    const list = await second.list({});
    eq(list.total, 2, '列表一致');
    ok(list.items.some((t) => t.name === '小红书文案'), '内容没丢');
  });

  await group('坏文件跳过，不影响别的模板', async () => {
    const dir = path.join(ROOT, 'templates3');
    const store = TemplateStore.createTemplateStore({ dir });
    await store.create(GOOD);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'broken.json'), '{不是 JSON', 'utf8');
    const fresh = TemplateStore.createTemplateStore({ dir });
    eq(await fresh.count(), 1, '坏的被跳过');
  });

  await group('浏览器本地模板库：与接口同形', async () => {
    const storage = fakeStorage();
    const store = Core.createLocalTemplateStore(storage);
    const t = await store.create(GOOD);
    eq((await store.list()).total, 1, '存下来了');
    eq((await store.list()).templates[0].system, GOOD.system, '完整记录也带回来（注册板块要用）');
    eq((await store.update(t.id, { tagline: '改过' })).tagline, '改过', '能改');
    eq(await store.remove(t.id), true, '能删');
    eq(await store.count(), 0, '删干净');
    await assert.rejects(() => store.create({ name: '周报', system: '' }), /提示词/, '校验同样生效');
    await assert.rejects(() => store.create({ name: 'x', system: GOOD.system }), /至少两个/, '名字太短也拦');
    eq((await Core.createLocalTemplateStore(fakeStorage({ 'writing-assistant/templates/v1': '{坏了' })).list()).total, 0, '存储坏了当空');
  });

  await group('本地模板库有上限：到了就明确拒绝，而不是默默丢掉旧模板', async () => {
    const storage = fakeStorage();
    const store = Core.createLocalTemplateStore(storage);
    for (let i = 0; i < Modes.LIMITS.templatesMax; i += 1) {
      await store.create({ name: '模板' + i, system: '你是助手，只输出正文，不要解释。编号 ' + i });
    }
    eq(await store.count(), Modes.LIMITS.templatesMax, '刚好到上限');
    let message = '';
    try {
      await store.create({ name: '再来一个', system: '你是助手，只输出正文，不要解释。' });
    } catch (err) {
      message = err.message;
    }
    ok(/最多/.test(message), `超上限时明确报错：${message}`);
    eq(await store.count(), Modes.LIMITS.templatesMax, '一个也没被悄悄挤掉');
  });

  await group('删掉模板后，旧稿在留档里仍显示当时的板块名', async () => {
    const draft = {
      mode: 'tpl_这个模板已经删了',
      modeName: '产品周报',
      material: { input: '这周上线了新版搜索' },
      versions: [{ index: 0, text: '周报正文。' }],
    };
    const rec = Record.normalizeRecord(draft);
    // 板块已经不存在了，结构上的 id 会退回第一个板块（这样旧稿还载得回写作台）；
    // 但「当时的名字」必须留着，否则列表里会显示成「文章续写」——那是兜底值，不是事实
    eq(rec.mode, 'continue', '板块 id 退回第一个（那个板块已经没了）');
    eq(rec.modeName, '产品周报', '名字跟着记录走，显示的是当时的板块名');
    eq(Record.summarize(rec).modeName, '产品周报', '列表里显示的还是当时的名字');
    ok(Record.toMarkdown(rec).includes('- 模式：产品周报'), '导出的 markdown 也是当时的名字');
    ok(Record.toPlainText(rec).includes('产品周报'), '导出的纯文本也是');

    // 老记录没存过名字：仍然按板块 id 反查，行为不变
    const old = Record.normalizeRecord({
      mode: 'email',
      material: { input: '通知客户延期' },
      versions: [{ index: 0, text: '邮件正文。' }],
    });
    eq(old.modeName, '邮件撰写', '没存名字时按 id 反查');
    eq(Record.summarize(Record.normalizeRecord({ mode: 'tpl_也没有', versions: [{ index: 0, text: 'x' }] })).modeName, '文章续写',
      '既没存名字、id 也不认识时，退回第一个板块（这是兜底，不是事实）');
  });

  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => {});

  const total = pass + failures.length;
  console.log(`\n通过 ${pass}/${total}`);
  if (failures.length) {
    console.log('\n失败项：');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exitCode = 1;
  }
})();
