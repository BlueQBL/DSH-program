'use strict';

/**
 * 历史记录与可用性记录的测试。
 * 运行：node test/store.test.js
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { eq, ok, not, has, group, report } = require('./harness.js');
const Store = require('../lib/store.js');

async function withStore(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lanshai-store-'));
  const store = Store.createStore({ dir: path.join(dir, 'history'), imageDir: path.join(dir, 'images'), log: () => {} });
  try {
    await fn(store, dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function fakeImage(store, id) {
  return store.saveImage(id, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), '.png');
}

(async function main() {
  console.log('历史记录');

  await withStore(async (store, root) => {
    await group('新建记录：补齐 id / 时间 / 风格 / 尺寸，文件名只留 basename', async () => {
      const record = await store.create({
        prompt: '一只白猫',
        finalPrompt: '一只白猫, square composition, photorealistic',
        style: { id: 'photo', label: '摄影写实' },
        size: { requested: '1024x1024', actual: '1024x1024', ratio: 'square composition' },
        quality: 'low',
        model: 'gpt-image-2',
        engine: 'live',
        file: '../../../evil.png',
        mime: 'image/png',
        bytes: 1234,
        width: 1024,
        height: 1024,
        elapsedMs: 5400,
      });
      ok(Store.ID_RE.test(record.id), 'id 形状合法');
      ok(record.createdAt > 0, '有创建时间');
      eq(record.prompt, '一只白猫', '描述存住了');
      eq(record.file, 'evil.png', '路径穿越被 basename 挡掉');
      eq(record.style.label, '摄影写实', '风格标签存住');
      eq(record.engine, 'live', '引擎标记存住');
      eq(record.notes, [], '没给备注就是空数组');
      ok(fs.existsSync(path.join(root, 'history', record.id + '.json')), '真的落盘了');
    });

    await group('读回来、找得到、乱 id 取不到', async () => {
      const record = await store.create({ prompt: '雨后的街道', model: 'gpt-image-2', engine: 'live' });
      const again = await store.get(record.id);
      eq(again.prompt, '雨后的街道', '按 id 取回来了');
      eq(await store.get('../hack'), null, '路径穿越的 id 一律取不到');
      eq(await store.get('img_nope'), null, '不存在的 id 返回 null');
      eq(await store.get(''), null, '空 id 返回 null');
    });

    await group('列表按时间倒序，能搜索、能分页', async () => {
      await store.clear(); // 前面几组留下的记录时间戳是「现在」，会盖住这里造的两条
      const a = await store.create({ prompt: 'aaa 早', model: 'dall-e-3', engine: 'live', createdAt: 1000 });
      const b = await store.create({ prompt: 'bbb 晚', model: 'gpt-image-2', engine: 'live', createdAt: 2000 });
      const out = await store.list({});
      eq(out.items[0].id, b.id, '新的在前');
      eq(out.items[1].id, a.id, '旧的在后');
      ok(out.total >= 2, '总数对得上');

      const filtered = await store.list({ q: 'dall-e' });
      eq(filtered.items.map((r) => r.id), [a.id], '按模型名搜得到');

      const page = await store.list({ limit: 1, offset: 1 });
      eq(page.items.length, 1, '分页有一条');
      eq(page.limit, 1, 'limit 回显');
    });

    await group('坏掉的 JSON 文件跳过，不影响其它记录', async () => {
      const good = await store.create({ prompt: '好的', model: 'gpt-image-2', engine: 'live' });
      await fsp.writeFile(path.join(root, 'history', 'img_broken_1234.json'), '{ 这不是 JSON', 'utf8');
      const out = await store.list({});
      ok(out.items.some((r) => r.id === good.id), '好记录还在');
      not(out.items.some((r) => r.id === 'img_broken_1234'), '坏记录没被当成正常记录');
    });

    await group('存图、找图、删记录顺手删图', async () => {
      const record = await store.create({ prompt: '要删的', model: 'gpt-image-2', engine: 'live' });
      const file = await fakeImage(store, record.id);
      eq(file, `${record.id}.png`, '文件名是 id + 扩展名');

      const resolved = store.resolveImage(file);
      ok(resolved.startsWith(path.join(root, 'images')), '落在 images 目录里');
      ok(fs.existsSync(resolved), '文件真的写了');

      eq(store.resolveImage('../../etc/passwd'), path.join(root, 'images', 'passwd'), '穿越路径被 basename 收口，跑不出 images 目录');
      eq(store.resolveImage('a b.png'), '', '带空格这类怪名字直接拒掉');
      eq(store.resolveImage(''), '', '空文件名挡掉');

      const created = await store.create({ prompt: '要删的', id: record.id, file, model: 'gpt-image-2', engine: 'live' });
      eq(created.id, record.id, '同 id 覆盖写（测试里允许）');

      eq(await store.remove(record.id), true, '删除成功');
      eq(await store.get(record.id), null, '记录没了');
      not(fs.existsSync(resolved), '图片文件也删了');
      eq(await store.remove(record.id), false, '再删一次返回 false');
    });

    await group('统计与清空', async () => {
      await store.clear();
      eq(await store.count(), 0, '清空之后没有记录');

      const one = await store.create({ prompt: '甲', model: 'gpt-image-2', engine: 'live', bytes: 100 });
      await store.create({ prompt: '乙', model: 'dall-e-3', engine: 'live', bytes: 200 });
      const stats = await store.stats();
      eq(stats.count, 2, '两张');
      eq(stats.bytes, 300, '字节数加起来');
      eq(stats.models.sort(), ['dall-e-3', 'gpt-image-2'], '模型去重列出来');
      ok(stats.latestAt >= one.createdAt, '有最新时间');

      eq(await store.clear(), 2, '清空返回删了几条');
      eq(await store.count(), 0, '清干净了');
    });

    await group('字段长度有上限，别让界面传什么就存什么', async () => {
      const record = await store.create({
        prompt: 'x'.repeat(5000),
        finalPrompt: 'y'.repeat(9000),
        notes: Array.from({ length: 9 }, (_, i) => 'note' + i),
        model: 'm'.repeat(300),
      });
      eq(record.prompt.length, 2000, '描述截到 2000');
      eq(record.finalPrompt.length, 4000, '最终提示词截到 4000');
      eq(record.notes.length, 6, '备注最多 6 条');
      eq(record.model.length, 80, '模型名截到 80');
    });
  });

  console.log('模型可用性记录');

  await group('记下来、读得回、坏文件当没有', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lanshai-status-'));
    const file = path.join(dir, 'model-status.json');
    try {
      const store = Store.createModelStatusStore({ file, log: () => {} });
      eq(store.get('gpt-image-2'), null, '还没记录时是 null');

      store.set('gpt-image-2', { ok: true, at: 111, message: '' });
      store.set('dall-e-2', { ok: false, at: 222, message: '模型不存在' });
      eq(store.get('gpt-image-2').ok, true, '可用记成 true');
      eq(store.get('dall-e-2').message, '模型不存在', '原因也记住');
      eq(Object.keys(store.all()).length, 2, '两条记录');

      const again = Store.createModelStatusStore({ file, log: () => {} });
      eq(again.get('gpt-image-2').ok, true, '新实例读得到（重启不丢）');
      eq(again.get('dall-e-2').ok, false, '失败的记录也在');

      await fsp.writeFile(file, '{ 坏掉的 JSON', 'utf8');
      const broken = Store.createModelStatusStore({ file, log: () => {} });
      eq(broken.get('gpt-image-2'), null, '坏文件当作没有记忆（不影响出图）');
      broken.set('x', { ok: true });
      has(fs.readFileSync(file, 'utf8'), '"x"', '坏文件之后还能重新写');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  await group('先写临时文件再 rename（不留半截 JSON）', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lanshai-atomic-'));
    try {
      const file = path.join(dir, 'x.json');
      await Store.writeFileAtomic(file, '{"a":1}');
      eq(JSON.parse(fs.readFileSync(file, 'utf8')).a, 1, '写成功');
      const leftovers = (await fsp.readdir(dir)).filter((n) => n.includes('.tmp-'));
      eq(leftovers, [], '没有留下临时文件');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  report('store');
})();
