/*!
 * 蓝晒 · AI 图片生成器 —— 社区分享（community.js，仅服务端）
 *
 * 「社区」在这个项目里是**本机的一份展墙**：把一张出过的图挂上去，写下署名和一句说明，
 * 其他人（同一台机器上的其他浏览器 / 局域网里的同事）就能在社区里看到、点赞、
 * 顺手把提示词拿走自己再改一版（remix）。
 *
 * 为什么不做成真正的线上社区：这个项目是零依赖、只跑在本机的，凭空接一个外部服务
 * 会让「下载 / 历史」这些承诺变得不成立。所以：数据留在本机，分享靠链接。
 *
 * 存在 data/community.json：一条分享一个对象（图片本体还在 data/images/ 里，不复制）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LIMITS = {
  count: 500,
  authorMax: 24,
  noteMax: 120,
  likersMax: 2000,
};

function random4() {
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0');
}

function normalizeEntry(input) {
  const e = input || {};
  return {
    id: String(e.id || ''),
    recordId: String(e.recordId || ''),
    file: path.basename(String(e.file || '')),
    mime: String(e.mime || 'image/png').slice(0, 40),
    author: String(e.author || '匿名').replace(/\s+/g, ' ').trim().slice(0, LIMITS.authorMax) || '匿名',
    note: String(e.note || '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.noteMax),
    prompt: String(e.prompt || '').slice(0, 2000),
    hidePrompt: Boolean(e.hidePrompt),
    model: String(e.model || '').slice(0, 80),
    styleId: String(e.styleId || '').slice(0, 24),
    styleLabel: String(e.styleLabel || '').slice(0, 24),
    size: String(e.size || '').slice(0, 24),
    sharedAt: Number(e.sharedAt) || Date.now(),
    likes: Math.max(0, Math.trunc(Number(e.likes) || 0)),
    likers: Array.isArray(e.likers) ? e.likers.map((v) => String(v).slice(0, 40)).slice(0, LIMITS.likersMax) : [],
  };
}

/**
 * 社区存储。
 * @param {object} options { file, log }
 */
function createCommunityStore(options) {
  const opt = options || {};
  const file = opt.file || path.join(process.cwd(), 'data', 'community.json');
  const log = typeof opt.log === 'function' ? opt.log : () => {};
  let data = { version: 1, entries: [] };

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && Array.isArray(parsed.entries)) {
        data = { version: 1, entries: parsed.entries.map(normalizeEntry).filter((e) => e.recordId) };
      }
    }
  } catch (err) {
    log(`[community] 社区文件读不了，已忽略：${err.message}`);
    data = { version: 1, entries: [] };
  }

  function flush() {
    try {
      const tmp = `${file}.tmp-${process.pid}-${random4()}`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      try {
        fs.renameSync(tmp, file);
      } catch {
        fs.copyFileSync(tmp, file);
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      log(`[community] 社区没写成：${err.message}`);
    }
  }

  /** 给界面看的形状：对外的字段叫 publicView（别把 likers 这种内部细节全甩出去） */
  function publicView(entry, viewerId) {
    const viewer = String(viewerId || '');
    return {
      id: entry.id,
      recordId: entry.recordId,
      file: entry.file,
      mime: entry.mime,
      author: entry.author,
      note: entry.note,
      prompt: entry.hidePrompt ? '' : entry.prompt,
      hidePrompt: entry.hidePrompt,
      model: entry.model,
      styleId: entry.styleId,
      styleLabel: entry.styleLabel,
      size: entry.size,
      sharedAt: entry.sharedAt,
      likes: entry.likes,
      liked: viewer ? entry.likers.includes(viewer) : false,
    };
  }

  return {
    file,

    list(query) {
      const q = query || {};
      const sort = q.sort === 'hot' ? 'hot' : 'new';
      const limit = Math.min(60, Math.max(1, Math.trunc(Number(q.limit) || 24)));
      const all = data.entries.slice();
      all.sort((a, b) =>
        sort === 'hot' ? b.likes - a.likes || b.sharedAt - a.sharedAt : b.sharedAt - a.sharedAt
      );
      return {
        total: all.length,
        sort,
        items: all.slice(0, limit).map((e) => publicView(e, q.viewerId)),
      };
    },

    get(id) {
      const hit = data.entries.find((e) => e.id === String(id || ''));
      return hit ? Object.assign({}, hit) : null;
    },

    byRecord(recordId) {
      const hit = data.entries.find((e) => e.recordId === String(recordId || ''));
      return hit ? Object.assign({}, hit) : null;
    },

    /** 分享一张图。同一张图重复分享就更新署名与说明，不重复占位 */
    add(input) {
      const e = input || {};
      if (!e.recordId) return { ok: false, message: '缺少要分享的图片' };
      const existing = data.entries.find((item) => item.recordId === String(e.recordId));
      const base = normalizeEntry(
        Object.assign({}, existing || {}, {
          id: existing ? existing.id : `sh_${Date.now().toString(36)}_${random4()}`,
          sharedAt: existing ? existing.sharedAt : Date.now(),
          likes: existing ? existing.likes : 0,
          likers: existing ? existing.likers : [],
        }, e)
      );
      if (!base.file) return { ok: false, message: '这张图没存到本地，分享不了（上游链接会过期）' };
      if (existing) {
        Object.assign(existing, base);
      } else {
        if (data.entries.length >= LIMITS.count) return { ok: false, message: `社区最多挂 ${LIMITS.count} 张` };
        data.entries.unshift(base);
      }
      flush();
      return { ok: true, entry: Object.assign({}, existing || base), updated: Boolean(existing) };
    },

    /** 点赞 / 取消点赞（同一台浏览器点两次就是取消） */
    like(id, viewerId) {
      const entry = data.entries.find((e) => e.id === String(id || ''));
      if (!entry) return { ok: false, message: '这条分享已经不在了' };
      const viewer = String(viewerId || '').slice(0, 40);
      if (!viewer) return { ok: false, message: '缺少点赞标识' };
      const index = entry.likers.indexOf(viewer);
      if (index >= 0) entry.likers.splice(index, 1);
      else entry.likers.push(viewer);
      entry.likes = entry.likers.length;
      flush();
      return { ok: true, likes: entry.likes, liked: index < 0 };
    },

    remove(id) {
      const key = String(id || '');
      const before = data.entries.length;
      data.entries = data.entries.filter((e) => e.id !== key);
      if (data.entries.length === before) return false;
      flush();
      return true;
    },

    removeByRecord(recordId) {
      const key = String(recordId || '');
      const before = data.entries.length;
      data.entries = data.entries.filter((e) => e.recordId !== key);
      if (data.entries.length === before) return 0;
      flush();
      return before - data.entries.length;
    },

    clear() {
      const count = data.entries.length;
      data.entries = [];
      flush();
      return count;
    },

    count() {
      return data.entries.length;
    },
  };
}

module.exports = {
  LIMITS,
  normalizeEntry,
  createCommunityStore,
};
