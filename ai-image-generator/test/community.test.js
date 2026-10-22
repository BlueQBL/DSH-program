'use strict';

/**
 * 社区分享（lib/community.js）的测试：分享 / 更新 / 点赞去重 / 排序 / 撤下。
 * 运行：node test/community.test.js
 */

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { eq, ok, not, has, group, report, sleep } = require('./harness.js');
const Community = require('../lib/community.js');

async function withStore(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lanshai-community-'));
  const store = Community.createCommunityStore({ file: path.join(dir, 'community.json'), log: () => {} });
  try {
    await fn(store, dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

(async function main() {
  console.log('分享');

  await withStore(async (store) => {
    await group('挂一张上去：署名、说明、提示词都收着了', async () => {
      const out = store.add({
        recordId: 'img_a1',
        file: 'img_a1.png',
        mime: 'image/png',
        author: '  小  飞 ',
        note: '这是我第一个满意的夜景',
        prompt: '霓虹雨夜',
        model: 'gpt-image-2',
        styleId: 'cyberpunk',
        styleLabel: '赛博朋克',
        size: '1280x720',
      });
      eq(out.ok, true, '分享成功');
      ok(out.entry.id.startsWith('sh_'), '有分享 id');
      eq(out.entry.author, '小 飞', '署名压成单空格');
      eq(store.count(), 1, '社区里有一张');

      const listed = store.list({});
      eq(listed.total, 1, '列表里也有');
      eq(listed.items[0].prompt, '霓虹雨夜', '提示词可见');
      eq(listed.items[0].likes, 0, '初始 0 赞');
      eq(listed.items[0].likers, undefined, '对外不透出点赞者名单');
    });

    await group('同一张再分享一次是更新，不是新增', async () => {
      const out = store.add({ recordId: 'img_a1', file: 'img_a1.png', author: '小飞', note: '改了一下说明' });
      eq(out.ok, true, '成功');
      eq(out.updated, true, '标记为更新');
      eq(store.count(), 1, '还是一条');
      eq(store.list({}).items[0].note, '改了一下说明', '说明更新了');
    });

    await group('没存到本地的图不能分享', async () => {
      const out = store.add({ recordId: 'img_remote', file: '', author: 'x' });
      eq(out.ok, false, '拒绝');
      has(out.message, '存到本地', '说明为什么');
      const missing = store.add({ file: 'x.png' });
      eq(missing.ok, false, '没有 recordId 也拒绝');
    });

    await group('不公开提示词：对外只给图，不给描述', async () => {
      store.add({ recordId: 'img_secret', file: 'img_secret.png', prompt: '秘密的提示词', hidePrompt: true });
      const item = store.list({}).items.find((e) => e.recordId === 'img_secret');
      eq(item.prompt, '', '提示词被隐去');
      eq(item.hidePrompt, true, '标记还在，界面才能解释为什么点不了「拿来改」');
    });

    await group('点赞：同一台浏览器点两次就是取消', async () => {
      const entry = store.list({}).items[0];
      const first = store.like(entry.id, 'viewer-a');
      eq(first.ok, true, '点赞成功');
      eq(first.likes, 1, '1 个赞');
      eq(first.liked, true, '标记为已赞');

      const second = store.like(entry.id, 'viewer-a');
      eq(second.likes, 0, '再点一次取消了');
      eq(second.liked, false, '标记为未赞');

      store.like(entry.id, 'viewer-a');
      const other = store.like(entry.id, 'viewer-b');
      eq(other.likes, 2, '两个人各点一次是 2');
      eq(store.like('sh_nope', 'viewer-a').ok, false, '不存在的条目点赞返回失败');
      eq(store.like(entry.id, '').ok, false, '没有点赞标识就拒绝');
    });

    await group('带 viewerId 列表时能看出「我赞过没有」', async () => {
      const forA = store.list({ viewerId: 'viewer-a' }).items[0];
      const forC = store.list({ viewerId: 'viewer-c' }).items[0];
      eq(forA.liked, true, 'A 赞过');
      eq(forC.liked, false, 'C 没赞过');
    });

    await group('排序：最新 / 最热', async () => {
      await sleep(6);
      store.add({ recordId: 'img_newest', file: 'img_newest.png' });
      const newest = store.list({ sort: 'new' });
      eq(newest.items[0].recordId, 'img_newest', '最新的在最前');
      eq(newest.sort, 'new', '排序方式回显');

      const hot = store.list({ sort: 'hot' });
      ok(hot.items[0].likes >= hot.items[1].likes, '最热的点赞数不少于后面的');
      eq(hot.items[0].likes, 2, '点赞最多的那张（被赞了两次）排最前');
      not(hot.items[0].recordId === 'img_newest', '不是最新的那张，而是最热的');
    });

    await group('撤下：按条目 / 按图片 / 全清', async () => {
      eq(store.removeByRecord('img_newest'), 1, '按图片撤下返回条数');
      const entry = store.list({}).items[0];
      eq(store.remove(entry.id), true, '按条目撤下成功');
      eq(store.remove(entry.id), false, '再撤返回 false');
      const left = store.count();
      eq(store.clear(), left, '全清返回条数');
      eq(store.count(), 0, '清干净了');
    });
  });

  await group('分享落盘，重启还在（点赞数也留着）', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lanshai-community2-'));
    const file = path.join(dir, 'community.json');
    try {
      const store = Community.createCommunityStore({ file, log: () => {} });
      store.add({ recordId: 'img_keep', file: 'img_keep.png', author: '小飞', prompt: '留着' });
      const id = store.list({}).items[0].id;
      store.like(id, 'viewer-a');

      const again = Community.createCommunityStore({ file, log: () => {} });
      eq(again.count(), 1, '重启后还有一条');
      eq(again.list({}).items[0].likes, 1, '点赞数也还在');
      eq(again.list({ viewerId: 'viewer-a' }).items[0].liked, true, '谁赞过也还在');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  await group('文件坏了当作空展墙（不崩、还能继续分享）', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lanshai-community3-'));
    const file = path.join(dir, 'community.json');
    try {
      await fsp.writeFile(file, 'not json at all', 'utf8');
      const store = Community.createCommunityStore({ file, log: () => {} });
      eq(store.count(), 0, '空列表');
      eq(store.add({ recordId: 'img_x', file: 'img_x.png' }).ok, true, '还能分享');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  report('community');
})();
