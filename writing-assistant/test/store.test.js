'use strict';

/**
 * 历史留档的测试：一稿一文件、原子写入、检索与导出。
 * 全部在系统临时目录里跑，不碰项目里的 data/。
 * 运行：node test/store.test.js
 */

const assert = require('assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const Store = require('../lib/store.js');

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

async function rejects(fn, label) {
  try {
    await fn();
    failures.push(`${label}\n    期望抛错，实际没有`);
  } catch {
    pass += 1;
  }
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

const ROOT = path.join(os.tmpdir(), 'wa-store-test-' + process.pid + '-' + Date.now());

function draft(over) {
  const base = {
    mode: 'rewrite',
    params: { mode: 'rewrite', creativity: 0.5, length: 'short', tone: 'plain' },
    material: { input: '这是要被改写的原文' },
    versions: [
      { index: 0, angleId: 'faithful', angleLabel: '同义易词', text: '这是要被改写的原文。', engine: 'offline' },
      { index: 1, angleId: 'tighten', angleLabel: '压缩篇幅', text: '改写后的短句。', engine: 'offline' },
    ],
    adoptedIndex: 1,
  };
  return Object.assign(base, over || {});
}

(async function main() {
  console.log('历史留档');

  const dir = path.join(ROOT, 'history');
  const store = Store.createStore({ dir });

  await group('第一次访问自动建目录', async () => {
    eq(await store.count(), 0, '初始为空');
    ok(fs.existsSync(dir), '目录已创建');
  });

  await group('存一篇稿子：补齐 id、时间、标题与摘要', async () => {
    const rec = await store.create(draft());
    ok(/^d_[a-z0-9_]+$/.test(rec.id), 'id 形如 d_xxx');
    ok(rec.createdAt && rec.updatedAt, '有创建与更新时间');
    ok(rec.title.startsWith('内容改写 · '), '标题带模式名');
    ok(rec.title.includes('这是要被改写的原文'), '标题带素材开头');
    eq(rec.versions.length, 2, '两个版本都存下了');
    eq(rec.adoptedIndex, 1, '记住了采用了第二稿');
    ok(fs.existsSync(path.join(dir, rec.id + '.json')), '落盘成单独文件');
    eq(await store.count(), 1, '计数正确');
  });

  await group('写盘是原子的：不留 .tmp，文件是完整 JSON', async () => {
    const names = await fsp.readdir(dir);
    eq(names.filter((n) => n.endsWith('.tmp')).length, 0, '没有临时文件残留');
    const rec = await store.create(draft());
    const raw = await fsp.readFile(path.join(dir, rec.id + '.json'), 'utf8');
    ok(JSON.parse(raw).id === rec.id, '文件内容可解析且完整');
  });

  await group('取一篇稿子', async () => {
    const rec = await store.create(draft({ material: { input: '取稿用的素材' } }));
    const got = await store.get(rec.id);
    eq(got.material.input, '取稿用的素材', '内容一致');
    eq(await store.get('d_不存在'), null, '不存在的返回空');
  });

  await group('列表：按更新时间倒序，摘要里不带正文', async () => {
    const list = await store.list({});
    ok(list.total >= 3, '总数正确');
    ok(list.items[0].updatedAt >= list.items[list.items.length - 1].updatedAt, '新的在前');
    ok(list.items[0].excerpt.length <= 80, '摘要不超过 80 字');
    eq(list.items[0].text, undefined, '摘要里没有正文');
    eq(list.items[0].modeName, '内容改写', '带模式中文名');
    eq(list.items[0].mark, '改', '带稿签单字');
    ok(list.modes.length === 6, '返回各模式的篇数');
    ok(list.modes.find((m) => m.id === 'rewrite').count >= 3, '改写模式的计数正确');
  });

  await group('列表：分页与上限', async () => {
    const page = await store.list({ limit: 2 });
    eq(page.items.length, 2, '每页两条');
    eq(page.limit, 2, '回显 limit');
    const second = await store.list({ limit: 2, offset: 2 });
    ok(second.items[0].id !== page.items[0].id, '第二页不重复');
    const huge = await store.list({ limit: 9999 });
    ok(huge.limit <= 200, 'limit 有上限');
  });

  await group('列表：按模式筛选', async () => {
    await store.create(draft({ mode: 'email', params: { mode: 'email' }, material: { input: '通知供应商延期' } }));
    const mails = await store.list({ mode: 'email' });
    eq(mails.total, 1, '只剩邮件稿');
    eq(mails.items[0].mode, 'email', '模式正确');
    const all = await store.list({ mode: 'all' });
    ok(all.total > mails.total, 'all 能看到全部');
  });

  await group('列表：关键词搜索命中素材与正文', async () => {
    const byMaterial = await store.list({ q: '通知供应商' });
    eq(byMaterial.total, 1, '搜到素材里的词');
    const byText = await store.list({ q: '改写后的短句' });
    ok(byText.total >= 1, '搜到正文里的词');
    const byTitle = await store.list({ q: '内容改写' });
    ok(byTitle.total >= 1, '搜到标题里的词');
    const none = await store.list({ q: '绝不存在的词xyz' });
    eq(none.total, 0, '搜不到就是 0');
    const upper = await store.list({ q: 'XYZ' });
    eq(upper.total, 0, '大小写不敏感（小写搜大写同样为空）');
  });

  await group('改名、星标、改采用稿', async () => {
    const rec = await store.create(draft({ material: { input: '待整理的稿子' } }));
    const renamed = await store.update(rec.id, { title: '  改成这个名字  ', starred: true, adoptedIndex: 0 });
    eq(renamed.title, '改成这个名字', '标题去掉首尾空格');
    eq(renamed.starred, true, '星标生效');
    eq(renamed.adoptedIndex, 0, '采用稿更新');
    ok(renamed.updatedAt >= rec.updatedAt, '更新时间前移');

    const starred = await store.list({ starred: true });
    eq(starred.total, 1, '只看星标只剩一篇');

    const bad = await store.update(rec.id, { adoptedIndex: 99, title: '' });
    eq(bad.adoptedIndex, 0, '越界的采用稿被忽略');
    eq(bad.title, '改成这个名字', '空标题不会把原名清掉');

    eq(await store.update('d_没有', { starred: true }), null, '改不存在的返回空');
  });

  await group('润色结果可以存进同一篇稿子，也可以清掉', async () => {
    const rec = await store.create(draft({ material: { input: '带润色的稿子' } }));
    const saved = await store.update(rec.id, {
      polished: {
        source: 'version:0',
        before: '他说的非常非常对。',
        after: '他说得很对。',
        edits: [{ id: 'e1', before: '非常非常的', after: '很', type: 'redundant', reason: '程度副词堆叠' }],
        accepted: ['e1'],
      },
    });
    eq(saved.polished.after, '他说得很对。', '润色稿存下了');
    eq(saved.polished.edits.length, 1, '朱批条目存下了');
    const list = await store.list({ q: '带润色的稿子' });
    eq(list.items[0].hasPolish, true, '列表里能看出有润色');

    const cleared = await store.update(rec.id, { polished: null });
    eq(cleared.polished, null, '可以清掉');
  });

  await group('坏数据进来会被收敛，而不是写进文件', async () => {
    const rec = await store.create({
      mode: '不存在的模式',
      params: { creativity: 99, versions: 99 },
      material: { input: 12345 },
      versions: [
        { index: 0, text: '正常内容' },
        { index: 1, text: '' },
        'not an object',
        { index: 3, text: 'x'.repeat(99999) },
        { index: 4, text: '第五稿不该存在' },
      ],
      adoptedIndex: 99,
    });
    eq(rec.mode, 'continue', '非法模式退回续写');
    eq(rec.params.versions <= 4, true, '版本数被收敛');
    eq(rec.versions.length, 4, '最多四稿');
    ok(rec.versions[3].text.length <= 60000, '超长正文被截断');
    ok(rec.material.input.length > 0, '非字符串素材被转成字符串');
    eq(rec.adoptedIndex, -1, '越界的采用稿被丢弃');
  });

  await group('一稿都不给就不允许保存', async () => {
    await rejects(() => store.create({ mode: 'email', versions: [] }), '空稿子应当拒绝');
  });

  await group('删一篇', async () => {
    const rec = await store.create(draft({ material: { input: '要删掉的稿子' } }));
    const file = path.join(dir, rec.id + '.json');
    ok(fs.existsSync(file), '文件在');
    eq(await store.remove(rec.id), true, '删除成功');
    eq(fs.existsSync(file), false, '文件已删');
    eq(await store.get(rec.id), null, '取不到了');
    eq(await store.remove(rec.id), false, '重复删除返回 false');
  });

  await group('导出成 Markdown：结构清楚、含朱批', async () => {
    const out = await store.create({
      mode: 'copywriting',
      params: { mode: 'copywriting', creativity: 1.1, length: 'short', tone: 'lively', fields: { platform: 'xiaohongshu' } },
      material: { input: '一款静音咖啡机' },
      versions: [
        { index: 0, angleId: 'pain', angleLabel: '痛点开场', text: '早上七点，磨豆机吵醒了全家。' },
        { index: 1, angleId: 'scene', angleLabel: '场景故事', text: '她在厨房按下开关，只有水声。' },
      ],
      polished: {
        source: 'version:0',
        before: '早上七点，磨豆机吵醒了全家人。',
        after: '早上七点，磨豆机吵醒了全家。',
        edits: [{ id: 'e1', before: '全家人', after: '全家', type: 'redundant', reason: '「全家」已含人' }],
      },
    });
    void out;
    const md = await store.exportAll('md', { mode: 'copywriting' });
    eq(md.ext, 'md', '扩展名');
    ok(md.mime.includes('markdown'), 'MIME 正确');
    ok(md.body.includes('# 文案生成 ·'), '有标题');
    ok(md.body.includes('## 第一稿 · 痛点开场'), '有稿次与角度');
    ok(md.body.includes('早上七点，磨豆机吵醒了全家。'), '有正文');
    ok(md.body.includes('### 朱批'), '有朱批小节');
    ok(md.body.includes('全家人 → 全家'), '朱批写了改动前后');
    ok(md.body.includes('小红书'), '参数里有平台');
    ok(!md.body.includes('## 第三稿'), '没有的稿次不会凭空出现');
  });

  await group('导出成 txt 与 json', async () => {
    const txt = await store.exportAll('txt', {});
    eq(txt.ext, 'txt', 'txt 扩展名');
    ok(txt.body.includes('第一稿'), 'txt 里有稿次');
    const json = await store.exportAll('json', {});
    const data = JSON.parse(json.body);
    eq(data.app, 'writing-assistant', 'json 带应用标识');
    ok(data.count === data.records.length, '计数与条数一致');
    ok(data.records[0].versions.length > 0, 'json 里含完整记录');
  });

  await group('重启后还能读出来（索引从文件重建）', async () => {
    const before = await store.count();
    const fresh = Store.createStore({ dir });
    eq(await fresh.count(), before, '篇数一致');
    const list = await fresh.list({ limit: 1 });
    ok(list.items[0].title.length > 0, '标题还在');
  });

  await group('损坏的文件被跳过，不影响其它稿子', async () => {
    await fsp.writeFile(path.join(dir, 'broken.json'), '{不是合法 JSON', 'utf8');
    await fsp.writeFile(path.join(dir, 'noid.json'), '{"title":"没有 id"}', 'utf8');
    await fsp.writeFile(path.join(dir, 'stray.tmp'), '半截内容', 'utf8');
    const before = await store.count();
    const fresh = Store.createStore({ dir });
    eq(await fresh.count(), before, '坏文件不计入');
    const names = await fsp.readdir(dir);
    eq(names.filter((n) => n.endsWith('.tmp')).length, 0, '残留的 .tmp 被清掉');
  });

  await group('超出上限时清掉最旧的未星标稿子', async () => {
    const smallDir = path.join(ROOT, 'small');
    const oldLimit = Store.LIMITS.records;
    Store.LIMITS.records = 3;
    try {
      const small = Store.createStore({ dir: smallDir });
      const ids = [];
      for (let i = 0; i < 5; i += 1) {
        const rec = await small.create(draft({ material: { input: '第 ' + i + ' 篇' } }));
        ids.push(rec.id);
        await new Promise((r) => setTimeout(r, 2)); // 让更新时间有先后
      }
      eq(await small.count(), 3, '只留三篇');
      eq(await small.get(ids[0]), null, '最旧的被清掉');
      ok(await small.get(ids[4]), '最新的留着');
    } finally {
      Store.LIMITS.records = oldLimit;
    }
  });

  await group('清空留档', async () => {
    const cleared = await store.clear();
    ok(cleared > 0, '报告清掉的篇数');
    eq(await store.count(), 0, '清空后为空');
    const list = await store.list({});
    eq(list.total, 0, '列表也为空');
    const names = (await fsp.readdir(dir)).filter((n) => /^d_.*\.json$/.test(n));
    eq(names.length, 0, '目录里没有稿件文件了');
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
