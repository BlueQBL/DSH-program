'use strict';

/**
 * 印相配方（lib/presets.js）的测试：内置配方、用户预设的增删覆盖、落盘与重启。
 * 运行：node test/presets.test.js
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { eq, ok, not, has, group, report } = require('./harness.js');
const Presets = require('../lib/presets.js');
const Styles = require('../lib/styles.js');

async function withStore(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lanshai-presets-'));
  const store = Presets.createPresetStore({ file: path.join(dir, 'presets.json'), log: () => {} });
  try {
    await fn(store, dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

(async function main() {
  console.log('内置配方');

  await group('几套开箱即用的配方，参数都是合法的', () => {
    const styleIds = Styles.STYLES.map((s) => s.id);
    const ratios = Styles.SIZE_TABLE.map((r) => r.ratio);
    ok(Presets.BUILTIN_PRESETS.length >= 4, `内置 ${Presets.BUILTIN_PRESETS.length} 套`);
    Presets.BUILTIN_PRESETS.forEach((p) => {
      const one = Presets.normalizePreset(p);
      ok(styleIds.includes(one.styleId), `${p.name} 的风格存在`);
      ok(ratios.includes(one.ratio), `${p.name} 的画幅存在`);
      ok(Styles.TIERS.includes(one.tier), `${p.name} 的清晰度合法`);
      eq(one.builtin, false, 'normalize 之后 builtin 标记由 store 决定');
      ok(one.extra.length > 10, `${p.name} 带了附加词`);
    });
    eq(Presets.normalizePreset(Presets.BUILTIN_PRESETS[0]).builtin, false, '规范化时会清掉 builtin（内置标记由 list 负责）');
  });

  await group('填错的值一律退回默认，不让坏数据进界面', () => {
    const one = Presets.normalizePreset({ name: '随便', styleId: '不存在', ratio: '9:99', tier: '9K', quality: 'ultra' });
    eq(one.styleId, Styles.STYLES[0].id, '风格退回第一个');
    eq(one.ratio, Styles.DEFAULT_RATIO, '画幅退回默认');
    eq(one.tier, Styles.DEFAULT_TIER, '清晰度退回默认');
    eq(one.quality, Styles.DEFAULT_QUALITY, '画质退回默认');
    eq(Presets.normalizePreset({ name: '  多个   空格  ' }).name, '多个 空格', '名字压成单空格');
    eq(Presets.normalizePreset({ name: 'x'.repeat(40) }).name.length, Presets.LIMITS.nameMax, '名字有长度上限');
  });

  await group('没有名字的预设存不了', () => {
    const out = Presets.validatePreset({ styleId: 'photo' });
    eq(out.ok, false, '拒绝');
    has(out.message, '名字', '说清楚缺什么');
    eq(Presets.validatePreset({ name: '夜' }).ok, false, '一个字太短，也拒绝');
    eq(Presets.validatePreset({ name: '夜景' }).ok, true, '两个字就行');
  });

  console.log('用户预设');

  await withStore(async (store) => {
    await group('存一个、列出来、再重启还认得', async () => {
      const out = store.add({ name: '我的夜景', styleId: 'cyberpunk', ratio: '16:9', tier: '2K', quality: 'medium', model: 'gpt-image-2' });
      eq(out.ok, true, '存下了');
      ok(out.preset.id.startsWith('ps_'), '有 id');
      eq(out.replaced, false, '不是覆盖');

      const listed = store.list();
      eq(listed.saved.length, 1, '列表里有一条');
      eq(listed.builtin.length, Presets.BUILTIN_PRESETS.length, '内置的还在');
      eq(listed.saved[0].name, '我的夜景', '名字对');
      eq(listed.saved[0].ratio, '16:9', '画幅对');

      const again = Presets.createPresetStore({ file: store.file, log: () => {} });
      eq(again.list().saved.length, 1, '新实例（等价于重启）读得到');
    });

    await group('同名就覆盖，不重复堆', async () => {
      const out = store.add({ name: '我的夜景', styleId: 'photo', ratio: '1:1', tier: '1K', quality: 'low' });
      eq(out.ok, true, '成功');
      eq(out.replaced, true, '标记为覆盖');
      eq(store.list().saved.length, 1, '还是一条');
      eq(store.list().saved[0].styleId, 'photo', '内容更新了');
    });

    await group('删一个；删不存在的返回 false', async () => {
      const id = store.list().saved[0].id;
      eq(store.remove(id), true, '删掉了');
      eq(store.list().saved.length, 0, '列表空了');
      eq(store.remove(id), false, '再删返回 false');
    });

    await group('存到上限就不让存了', async () => {
      for (let i = 0; i < Presets.LIMITS.count; i += 1) {
        store.add({ name: `预设${i}`, styleId: 'photo' });
      }
      eq(store.list().saved.length, Presets.LIMITS.count, `存满 ${Presets.LIMITS.count} 条`);
      const extra = store.add({ name: '再来一个' });
      eq(extra.ok, false, '超限拒绝');
      has(extra.message, '最多', '说明为什么');
    });
  });

  await group('文件坏了当作没有预设（不把整本当空数据之外的东西）', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lanshai-presets-bad-'));
    const file = path.join(dir, 'presets.json');
    try {
      await fsp.writeFile(file, '{ 这不是 JSON', 'utf8');
      const store = Presets.createPresetStore({ file, log: () => {} });
      eq(store.list().saved, [], '读不了就是空列表');
      eq(store.list().builtin.length > 0, true, '内置配方照常可用');
      const out = store.add({ name: '恢复后存的' });
      eq(out.ok, true, '还能继续存');
      has(fs.readFileSync(file, 'utf8'), '恢复后存的', '写回去了');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  report('presets');
})();
