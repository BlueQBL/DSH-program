/*!
 * 三易 · 智能写作台 —— 历史留档（store.js，仅服务端）
 *
 * 一稿一文件，写在 data/history/ 下：单篇损坏不影响其它稿子，
 * 也避免每次保存都重写整个列表。内存里只保留一份记录索引供列表检索。
 *
 * 「一篇稿子长什么样」不在这里定义，全部来自 lib/record.js。
 */
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const Modes = require('./modes.js');
const Record = require('./record.js');

const LIMITS = {
  records: 800,
  limitMax: 200,
};

/** 清空 .tmp 残留：进程被强杀时可能留下半截文件 */
async function sweepTemp(dir) {
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    names.filter((n) => n.endsWith('.tmp')).map((n) => fsp.rm(path.join(dir, n), { force: true }))
  );
}

function createStore(options) {
  const dir = (options && options.dir) || path.join(__dirname, '..', 'data', 'history');
  const index = new Map();
  let loaded = false;

  const fileOf = (id) => path.join(dir, `${id}.json`);

  async function writeAtomic(file, text) {
    const tmp = `${file}.${process.pid}.${Record.randomSuffix()}.tmp`;
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, file);
  }

  async function save(record) {
    record.updatedAt = Record.nowIso();
    await writeAtomic(fileOf(record.id), JSON.stringify(record, null, 2));
    index.set(record.id, record);
    return record;
  }

  function sorted() {
    return Record.sortByUpdated(Array.from(index.values()));
  }

  /** 超出上限时从最旧的开始清，星标的一律留住；极端情况下允许略微超出 */
  async function trim() {
    const excess = index.size - LIMITS.records;
    if (excess <= 0) return 0;
    const victims = sorted()
      .filter((r) => !r.starred)
      .slice(-excess);
    for (const r of victims) {
      index.delete(r.id);
      await fsp.rm(fileOf(r.id), { force: true }).catch(() => {});
    }
    return victims.length;
  }

  async function ready() {
    if (loaded) return;
    loaded = true;
    await fsp.mkdir(dir, { recursive: true });
    await sweepTemp(dir);
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = await fsp.readFile(path.join(dir, name), 'utf8');
        const record = Record.normalizeRecord(JSON.parse(raw));
        if (!record.versions.length) throw new Error('没有可用的版本');
        index.set(record.id, record);
      } catch (err) {
        console.warn(`[history] 跳过读不出来的稿子 ${name}：${err.message}`);
      }
    }
  }

  return {
    dir,
    ready,

    /** 列表：先筛选再排序，摘要里不带正文，避免一次传太多 */
    async list(opts) {
      await ready();
      const o = opts || {};
      const all = sorted().filter((r) => Record.matches(r, o));
      const limit = Modes.clamp(o.limit === undefined ? 50 : o.limit, 1, LIMITS.limitMax);
      const offset = Math.max(0, Number(o.offset) || 0);
      const every = sorted();
      return {
        total: all.length,
        limit,
        offset,
        items: all.slice(offset, offset + limit).map(Record.summarize),
        modes: Modes.listModeIds().map((id) => ({
          id,
          name: Modes.getMode(id).name,
          mark: Modes.getMode(id).mark,
          count: every.filter((r) => r.mode === id).length,
        })),
      };
    },

    async get(id) {
      await ready();
      return index.get(String(id)) || null;
    },

    async create(raw) {
      await ready();
      const record = Record.normalizeRecord(raw);
      if (!record.versions.length) throw new Error('没有可保存的稿子');
      await save(record);
      await trim();
      return record;
    },

    async update(id, patch) {
      await ready();
      const current = index.get(String(id));
      if (!current) return null;
      const p = patch && typeof patch === 'object' ? patch : {};
      if (typeof p.title === 'string' && p.title.trim()) current.title = Record.clip(p.title.trim(), Record.LIMITS.titleChars);
      if (typeof p.starred === 'boolean') current.starred = p.starred;
      if (Number.isInteger(p.adoptedIndex) && p.adoptedIndex >= 0 && p.adoptedIndex < current.versions.length) {
        current.adoptedIndex = p.adoptedIndex;
      }
      if (Array.isArray(p.tags)) current.tags = p.tags.map((t) => Record.clip(t, 16)).slice(0, 8);
      if (p.polished === null) current.polished = null;
      if (p.polished && typeof p.polished === 'object') {
        current.polished = Record.normalizeRecord({ ...current, polished: p.polished }).polished;
      }
      return save(current);
    },

    async remove(id) {
      await ready();
      const key = String(id);
      if (!index.has(key)) return false;
      index.delete(key);
      await fsp.rm(fileOf(key), { force: true });
      return true;
    },

    async clear() {
      await ready();
      const ids = Array.from(index.keys());
      index.clear();
      await Promise.all(ids.map((id) => fsp.rm(fileOf(id), { force: true })));
      return ids.length;
    },

    async count() {
      await ready();
      return index.size;
    },

    async exportAll(format, opts) {
      await ready();
      const rows = sorted().filter((r) => Record.matches(r, opts || {}));
      return Record.exportBundle(rows, format);
    },
  };
}

module.exports = { createStore, LIMITS };
