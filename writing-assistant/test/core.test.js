'use strict';

/**
 * 前端核心逻辑的测试：状态怎么变、稿子怎么算、本地留档怎么存。
 * 这一层不碰 DOM，所以能直接在 Node 里跑。
 * 运行：node test/core.test.js
 */

const assert = require('assert');
const Modes = require('../lib/modes.js');
const Core = require('../js/core.js');

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
  try {
    fn();
  } catch (err) {
    failures.push(`${name} 抛异常：${err.message}`);
  }
  console.log(`  ${failures.length === before ? '✓' : '✗'} ${name}`);
}

async function agroup(name, fn) {
  const before = failures.length;
  try {
    await fn();
  } catch (err) {
    failures.push(`${name} 抛异常：${err.message}`);
  }
  console.log(`  ${failures.length === before ? '✓' : '✗'} ${name}`);
}

function fakeStorage(seed) {
  const map = new Map(seed ? Object.entries(seed) : []);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

/** 造一个「已经成稿」的状态，供后续断言使用 */
function withVersions(mode) {
  let s = Core.createState({ mode: mode || 'continue', material: '这是一段原稿的开头，用来测试。' });
  s = Core.beginRun(s, [
    { index: 0, angleId: 'flow', angleLabel: '顺着语气' },
    { index: 1, angleId: 'detail', angleLabel: '落到细节' },
  ]);
  s = Core.appendDelta(s, 0, '第一稿的内容。');
  s = Core.appendDelta(s, 1, '第二稿的内容。');
  s = Core.finishVersion(s, 0, { text: '第一稿的内容。', engine: 'offline' });
  s = Core.finishVersion(s, 1, { text: '第二稿的内容。', engine: 'offline' });
  s = Core.endRun(s, { engine: 'offline' });
  return s;
}

console.log('写作台状态');

group('新状态：默认参数都落在合法范围内', () => {
  const s = Core.createState();
  eq(s.mode, 'continue', '默认续写');
  eq(s.material, '', '素材为空');
  eq(s.params.creativity, 0.8, '创意度默认 0.8');
  eq(s.params.length, 'medium', '篇幅默认中');
  eq(s.params.tone, Modes.defaultTone('continue'), '语气取模式默认');
  eq(s.params.versions, 3, '默认三稿');
  eq(Object.keys(s.fields).length, Modes.getMode('continue').fields.length, '专属字段齐备');
  eq(s.versions, [], '还没有稿子');
  eq(s.busy, false, '不在成稿中');
});

group('切模式：专属字段与语气跟着换，版本数不会超', () => {
  let s = Core.createState({ mode: 'email' });
  s = Core.setParam(s, { versions: 3 });
  const next = Core.setMode(s, 'summary'); // 摘要只有三个角度
  eq(next.mode, 'summary', '模式换了');
  eq(next.params.tone, Modes.defaultTone('summary'), '语气换成新模式默认');
  ok(next.fields.shape, '专属字段换成摘要的形态');
  eq(next.fields.to, undefined, '邮件字段被清掉');
  ok(next.params.versions <= Modes.angleCount('summary'), '版本数不超过新角度数');
  eq(Core.setMode(s, 'email'), s, '切回同一个模式时原样返回');
});

group('调参数：越界的值都被夹回来', () => {
  let s = Core.createState({ mode: 'rewrite' });
  s = Core.setParam(s, { creativity: 9 });
  eq(s.params.creativity, Modes.CREATIVITY_MAX, '创意度封顶');
  s = Core.setParam(s, { creativity: -3 });
  eq(s.params.creativity, 0, '创意度封底');
  s = Core.setParam(s, { versions: 99 });
  eq(s.params.versions, Modes.angleCount('rewrite'), '版本数不超过角度数');
  s = Core.setParam(s, { length: 'custom', customChars: 99999 });
  eq(Modes.normalizeParams(Object.assign({ mode: s.mode, fields: s.fields }, s.params)).chars, Modes.LIMITS.customCharsMax, '自定义字数封顶');
  s = Core.setParam(s, { tone: '不存在的语气' });
  eq(s.params.tone, Modes.defaultTone('rewrite'), '非法语气退回默认');
});

group('改专属字段：不影响其它字段', () => {
  let s = Core.createState({ mode: 'email' });
  s = Core.setField(s, 'to', '王经理');
  s = Core.setField(s, 'matter', '确认延期');
  eq(s.fields.to, '王经理', '收件人写进去了');
  eq(s.fields.expect, 'confirm', '其它字段保持默认');
});

group('成稿过程：摆稿片 → 逐字追加 → 收尾', () => {
  let s = Core.beginRun(Core.createState(), [
    { index: 0, angleId: 'a', angleLabel: '甲' },
    { index: 1, angleId: 'b', angleLabel: '乙' },
  ]);
  eq(s.busy, true, '进入成稿中');
  eq(s.versions.length, 2, '两张空稿片');
  eq(s.versions[0].text, '', '稿片是空的');
  s = Core.appendDelta(s, 1, '第二');
  s = Core.appendDelta(s, 0, '第一');
  eq(s.versions[0].text, '第一', '只写进对应的那一稿');
  eq(s.versions[1].text, '第二', '另一稿互不干扰');
  s = Core.finishVersion(s, 0, { text: '第一稿定稿', engine: 'live' });
  eq(s.versions[0].text, '第一稿定稿', '收尾时以完整文本为准');
  eq(s.versions[0].done, true, '标记完成');
  eq(s.versions[0].engine, 'live', '记下成稿方式');
  s = Core.failVersion(s, 1, '上游超时');
  eq(s.versions[1].failed, true, '失败也标出来');
  eq(s.versions[1].note, '上游超时', '失败原因留在稿片上');
  s = Core.endRun(s, { engine: 'live' });
  eq(s.busy, false, '退出成稿中');
});

group('采用哪一稿：只能采用存在的稿', () => {
  let s = withVersions();
  s = Core.adopt(s, 1);
  eq(s.adopted, 1, '采用第二稿');
  eq(Core.adoptedText(s), '第二稿的内容。', '取到那一稿的正文');
  s = Core.adopt(s, 99);
  eq(s.adopted, -1, '不存在的稿不采用');
  eq(Core.adoptedText(s), '第一稿的内容。', '没采用时退回第一稿');
});

group('优先稿：采用过就用采用的，否则用第一份写好的', () => {
  const s = withVersions();
  eq(Core.bestVersion(s).index, 0, '没采用时取第一份');
  eq(Core.bestVersion(Core.adopt(s, 1)).index, 1, '采用后取那一份');
  eq(Core.bestVersion(Core.createState()), null, '一稿都没有时返回空');
});

group('接着写：某一稿变成新的原稿', () => {
  const s = Core.asMaterial(withVersions(), '第二稿的内容。');
  eq(s.material, '第二稿的内容。', '原稿被替换');
  eq(s.versions, [], '旧稿片清空');
  eq(s.adopted, -1, '采用状态重置');
});

group('一键优化的目标：优先采用稿，其次第一稿，都没有就针对原稿', () => {
  const s = withVersions();
  eq(Core.polishTarget(s).source, 'version:0', '默认优化第一稿');
  eq(Core.polishTarget(Core.adopt(s, 1)).source, 'version:1', '采用后优化那一稿');
  eq(Core.polishTarget(Core.adopt(s, 1)).label, '第二稿', '目标名称是中文稿次');
  const empty = Core.createState({ material: '只有原稿' });
  eq(Core.polishTarget(empty).source, 'input', '没有稿子时针对原稿');
  eq(Core.polishTarget(empty).text, '只有原稿', '取到原稿文字');
});

group('能不能起稿', () => {
  ok(!Core.canGenerate(Core.createState()), '空素材不能起稿');
  ok(!Core.canGenerate(Core.createState({ material: '  ' })), '只有空格也不行');
  ok(Core.canGenerate(Core.createState({ material: '够长了' })), '有内容就能起稿');
  const busy = Object.assign(Core.createState({ material: '够长了' }), { busy: true });
  ok(!Core.canGenerate(busy), '成稿中不能再按');
});

console.log('板块工作区');

/** 造一个「某板块已经有原稿与成稿」的工作区 */
function worked(mode, material, text) {
  let s = Core.createState({ mode, material });
  s = Core.beginRun(s, [{ index: 0, angleId: 'a0', angleLabel: Modes.angleOf(mode, 0).label }]);
  s = Core.finishVersion(s, 0, { text, engine: 'offline' });
  return Core.endRun(s, {});
}

group('首次进入某个板块：原稿和成稿都是空的', () => {
  const c = worked('continue', '续写的开头。', '续写的成稿。');
  const moved = Core.switchWorkspace(c, 'rewrite', new Map());
  eq(moved.state.mode, 'rewrite', '模式切过去了');
  eq(moved.state.material, '', '原稿是空的（不带上一个板块的内容）');
  eq(moved.state.versions, [], '成稿也是空的（不挂着别人家的稿片）');
  eq(moved.restored, false, '没东西可恢复');
  eq(Core.hasWork(moved.state), false, '判定为空工作区');
});

group('切回用过的板块：把它自己那份原稿与成稿装回来', () => {
  const c = worked('continue', '续写的开头。', '续写的成稿。');
  let r = Core.switchWorkspace(c, 'rewrite', new Map());
  r.state = Object.assign({}, r.state, { material: '改写的原文。' });

  const back = Core.switchWorkspace(r.state, 'continue', r.workspaces);
  eq(back.state.mode, 'continue', '切回续写');
  eq(back.state.material, '续写的开头。', '原稿是续写自己那份');
  eq(back.state.versions.length, 1, '成稿也回来了');
  eq(back.state.versions[0].text, '续写的成稿。', '成的还是那一稿');
  eq(back.restored, true, '标记为「恢复」而不是新建');

  const again = Core.switchWorkspace(back.state, 'rewrite', back.workspaces);
  eq(again.state.material, '改写的原文。', '改写那份也没被续写覆盖');
  eq(again.state.versions.length, 0, '改写仍然没有成稿');
});

group('板块之间互不污染：一边改原稿，另一边不受影响', () => {
  const c = worked('continue', '续写的开头。', '续写的成稿。');
  const r1 = Core.switchWorkspace(c, 'summary', new Map());
  r1.state = Object.assign({}, r1.state, { material: '要被摘要的长文。' });
  const r2 = Core.switchWorkspace(r1.state, 'continue', r1.workspaces);
  r2.state = Object.assign({}, r2.state, { material: '续写改了原稿。' });
  const r3 = Core.switchWorkspace(r2.state, 'summary', r2.workspaces);
  eq(r3.state.material, '要被摘要的长文。', '摘要那份没被改动');
  const r4 = Core.switchWorkspace(r3.state, 'continue', r3.workspaces);
  eq(r4.state.material, '续写改了原稿。', '续写那份改对了');
});

group('采用稿、朱批、留档关联都跟着板块走', () => {
  let c = worked('continue', '续写的开头。', '续写的成稿。');
  c = Core.adopt(c, 0);
  c = Object.assign({}, c, {
    savedId: 'd_abc123',
    polish: { source: 'version:0', before: 'a', after: 'b', edits: [{ id: 'e1' }], accepted: new Set(['e1']) },
  });
  const r = Core.switchWorkspace(c, 'outline', new Map());
  eq(r.state.adopted, -1, '新板块没有采用稿');
  eq(r.state.polish, null, '新板块没有朱批');
  eq(r.state.savedId, '', '新板块没有留档关联');

  const back = Core.switchWorkspace(r.state, 'continue', r.workspaces);
  eq(back.state.adopted, 0, '采用稿回来了');
  eq(back.state.savedId, 'd_abc123', '留档关联回来了（采纳状态还能同步回那一篇）');
  eq(back.state.polish.after, 'b', '朱批稿回来了');
  eq(Array.from(back.state.polish.accepted), ['e1'], '采纳情况（Set）能往返');
});

group('参数跟着人走，专属字段跟着板块走', () => {
  let c = Core.createState({ mode: 'continue', material: '续写开头。' });
  c = Core.setParam(c, { creativity: 1.4, length: 'long' });
  c = Core.setField(c, 'direction', 'turn');
  const r = Core.switchWorkspace(c, 'copywriting', new Map());
  eq(r.state.params.creativity, 1.4, '创意度是人的偏好，跨板块保持');
  eq(r.state.params.length, 'long', '篇幅也一样');
  eq(r.state.fields.platform, 'xiaohongshu', '专属字段换成新板块的默认值');
  eq(r.state.fields.direction, undefined, '看不到上一个板块的专属字段');
  eq(r.state.params.tone, Modes.defaultTone('copywriting'), '语气换成新板块的');

  const back = Core.switchWorkspace(r.state, 'continue', r.workspaces);
  eq(back.state.fields.direction, 'turn', '切回来时续写自己的专属设置还在');
  eq(back.state.params.creativity, 1.4, '创意度没被改掉');
});

group('快照是拷贝：之后改当前状态，不会改到已存的快照', () => {
  const c = worked('continue', '续写的开头。', '续写的成稿。');
  const snap = Core.snapshot(c);
  const before = snap.fields.direction;
  c.versions[0].text = '被就地改掉了';
  c.fields.direction = 'close';
  eq(snap.versions[0].text, '续写的成稿。', '快照里的成稿没被跟着改');
  eq(snap.fields.direction, before, '快照里的字段还是当时那个值');
  eq(c.fields.direction, 'close', '当前状态确实改了');
});

group('清空工作区：清掉活，保留参数与专属设置', () => {
  let c = worked('copywriting', '一款折叠电煮锅', '文案成稿。');
  c = Core.setParam(c, { creativity: 1.1 });
  const cleared = Core.clearWork(c);
  eq(cleared.material, '', '原稿清了');
  eq(cleared.versions, [], '成稿清了');
  eq(cleared.adopted, -1, '采用状态清了');
  eq(cleared.savedId, '', '留档关联断了（留档本身不动）');
  eq(cleared.params.creativity, 1.1, '创意度保留');
  eq(cleared.fields.platform, 'xiaohongshu', '专属设置保留');
  eq(Core.hasWork(cleared), false, '判定为空');
});

group('切到同一个板块：原样返回，不做无意义的重建', () => {
  const c = worked('email', '通知客户延期', '邮件成稿。');
  const r = Core.switchWorkspace(c, 'email', new Map());
  eq(r.state, c, '返回同一个对象');
  eq(r.restored, false, '不算恢复');
});

console.log('稿子与记录');

group('字数：空白不算，上万字换个说法', () => {
  eq(Core.charCount('一二三'), 3, '三个字');
  eq(Core.charCount('一 二\n三'), 3, '空白不计');
  eq(Core.charCount(''), 0, '空串');
  eq(Core.formatChars(320), '320 字', '百字');
  eq(Core.formatChars(12345), '1.2 万字', '上万字');
});

group('相对时间：刚刚、几分钟前、今天、昨天、更早', () => {
  const base = new Date(2026, 2, 10, 15, 0);
  const at = (h, m, day) => new Date(2026, 2, day, h, m).toISOString();
  eq(Core.formatTime(at(14, 59, 10), base), '1 分钟前', '一分钟前');
  eq(Core.formatTime(at(15, 0, 10), base), '刚刚', '刚刚');
  eq(Core.formatTime(at(9, 5, 10), base), '今天 09:05', '今天');
  eq(Core.formatTime(at(20, 30, 9), base), '昨天 20:30', '昨天');
  eq(Core.formatTime(at(10, 0, 1), base), '3 月 1 日', '更早的同年');
  eq(Core.formatTime(at(10, 0, 1), new Date(2027, 0, 5)), '2026 年 3 月 1 日', '跨年带年份');
  eq(Core.formatTime('不是时间'), '', '解析不了就返回空');
});

group('稿次的中文写法', () => {
  eq(Core.versionLabel(0), '第一稿', '第一稿');
  eq(Core.versionLabel(3), '第四稿', '第四稿');
});

group('存成记录：采用稿的位置要重新映射', () => {
  const s = Core.adopt(withVersions(), 1);
  const record = Core.toRecord(s);
  eq(record.mode, 'continue', '带模式');
  eq(record.versions.length, 2, '两稿都进记录');
  eq(record.adoptedIndex, 1, '采用位置正确');
  eq(record.material.input, s.material, '素材进记录');
  ok(record.title.includes('文章续写'), '标题带模式名');
  eq(record.polished, null, '没有朱批时为 null');
});

group('存成记录：失败的空稿不进记录', () => {
  let s = withVersions();
  s = Core.failVersion(s, 1, '上游失败');
  s = Object.assign({}, s, { versions: s.versions.map((v) => (v.index === 1 ? Object.assign({}, v, { text: '' }) : v)) });
  const record = Core.toRecord(s);
  eq(record.versions.length, 1, '只留下成稿的那一份');
});

group('记录读回状态：参数、字段、稿子都能还原', () => {
  const s = withVersions('email');
  const record = Core.toRecord(Object.assign({}, s, { fields: Object.assign({}, s.fields, { to: '王经理' }) }));
  const back = Core.fromRecord(record);
  eq(back.mode, 'email', '模式还原');
  eq(back.material, s.material, '素材还原');
  eq(back.fields.to, '王经理', '专属字段还原');
  eq(back.versions.length, 2, '稿子还原');
  eq(back.versions[0].text, '第一稿的内容。', '正文还原');
  eq(back.savedId, record.id, '记住留档 id');
  eq(Core.fromRecord(record, false).savedId, '', '可以不带 id 载入');
});

group('记录读回状态：朱批也能还原', () => {
  const s = Object.assign(withVersions(), {
    polish: { source: 'version:0', before: '原文', after: '改后', edits: [{ id: 'e1' }], accepted: ['e1'] },
  });
  const back = Core.fromRecord(Core.toRecord(s));
  eq(back.polish.after, '改后', '润色稿还原');
  eq(back.polish.accepted, ['e1'], '采纳情况还原');
});

group('示例素材：六种模式都有两条，且各不相同', () => {
  const seen = new Set();
  Modes.MODES.forEach((mode) => {
    const a = Core.exampleOf(mode.id, 0);
    const b = Core.exampleOf(mode.id, 1);
    ok(a && a.length > 8, `${mode.name} 有第一条示例`);
    ok(b && b.length > 8, `${mode.name} 有第二条示例`);
    ok(a !== b, `${mode.name} 两条示例不一样`);
    seen.add(a);
    seen.add(b);
  });
  ok(seen.size >= 10, '示例之间不重复');
});

console.log('本地留档');

(async function main() {
  const storage = fakeStorage();

  await agroup('本地留档：存、取、列', async () => {
    const store = Core.createLocalStore(storage);
    eq(await store.count(), 0, '初始为空');
    const rec = await store.create(Core.toRecord(withVersions('rewrite')));
    ok(rec.id, '有 id');
    eq(await store.count(), 1, '存下来了');
    const got = await store.get(rec.id);
    eq(got.versions.length, 2, '正文完整');
    const list = await store.list({});
    eq(list.total, 1, '列表里有一篇');
    eq(list.items[0].versions, 2, '摘要有版本数');
    ok(list.modes.length === 6, '带回各模式计数');
    ok(storage.dump()['writing-assistant/v1'].includes(rec.id), '确实写进了本地存储');
  });

  await agroup('本地留档：筛选、搜索、星标', async () => {
    const store = Core.createLocalStore(storage);
    await store.create(Core.toRecord(withVersions('email')));
    eq((await store.list({ mode: 'email' })).total, 1, '按模式筛选');
    eq((await store.list({ mode: 'rewrite' })).total, 1, '另一个模式');
    eq((await store.list({ q: '第二稿的内容' })).total, 2, '搜正文');
    eq((await store.list({ q: '绝不存在的词' })).total, 0, '搜不到就是零');
    const target = (await store.list({ limit: 1 })).items[0];
    await store.update(target.id, { starred: true, title: '星标这篇' });
    eq((await store.list({ starred: true })).total, 1, '只看星标');
  });

  await agroup('本地留档：改与删', async () => {
    const store = Core.createLocalStore(storage);
    const items = (await store.list({})).items;
    const hit = items[0];
    const renamed = await store.update(hit.id, { title: '新标题' });
    eq(renamed.title, '新标题', '改名成功');
    eq(await store.update('d_没有这篇', {}), null, '改不存在的返回空');
    eq(await store.remove(hit.id), true, '删除成功');
    eq(await store.remove(hit.id), false, '重复删除返回 false');
    eq(await store.count(), 1, '还剩一篇');
  });

  await agroup('本地留档：导出三种格式', async () => {
    const store = Core.createLocalStore(storage);
    const md = await store.exportAll('md', {});
    ok(md.body.includes('# '), 'md 有标题');
    ok(md.body.includes('## 第一稿'), 'md 有稿次');
    const json = await store.exportAll('json', {});
    eq(JSON.parse(json.body).app, 'writing-assistant', 'json 带应用标识');
    const txt = await store.exportAll('txt', {});
    eq(txt.ext, 'txt', 'txt 扩展名');
  });

  await agroup('本地留档：超出上限时丢掉最旧的未星标稿子', async () => {
    const small = fakeStorage();
    const store = Core.createLocalStore(small);
    const ids = [];
    for (let i = 0; i < Core.LOCAL_CAP + 6; i += 1) {
      const s = Core.createState({ mode: 'outline', material: '第 ' + i + ' 篇题目' });
      let run = Core.beginRun(s, [{ index: 0, angleId: 'a', angleLabel: '甲' }]);
      run = Core.finishVersion(run, 0, { text: '第 ' + i + ' 篇正文' });
      ids.push((await store.create(Core.toRecord(run))).id);
    }
    eq(await store.count(), Core.LOCAL_CAP, '留档篇数被压在上限内');
    eq(await store.get(ids[0]), null, '最旧的被丢掉');
    ok(await store.get(ids[ids.length - 1]), '最新的留着');
  });

  await agroup('本地留档：存储坏了也不崩', async () => {
    const broken = fakeStorage({ 'writing-assistant/v1': '{不是 JSON' });
    const store = Core.createLocalStore(broken);
    eq(await store.count(), 0, '解析不了就当空');
    const rec = await store.create(Core.toRecord(withVersions('continue')));
    eq((await store.get(rec.id)).id, rec.id, '之后还能正常写入');
  });

  await agroup('本地留档：清空', async () => {
    const store = Core.createLocalStore(storage);
    const n = await store.clear();
    ok(n >= 1, '报告清掉的篇数');
    eq(await store.count(), 0, '清空后为零');
  });

  await agroup('界面偏好：存得下也读得回，坏数据不炸', async () => {
    const s = fakeStorage();
    Core.saveUI(s, { mode: 'email', params: { creativity: 1.1 } });
    eq(Core.loadUI(s).mode, 'email', '模式偏好读回来');
    eq(Core.loadUI(s).params.creativity, 1.1, '参数偏好读回来');
    eq(Core.loadUI(fakeStorage({ 'writing-assistant/ui/v1': '坏了' })), {}, '坏数据返回空对象');
    eq(Core.loadUI(fakeStorage()), {}, '没存过返回空对象');
  });

  const total = pass + failures.length;
  console.log(`\n通过 ${pass}/${total}`);
  if (failures.length) {
    console.log('\n失败项：');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exitCode = 1;
  }
})();
