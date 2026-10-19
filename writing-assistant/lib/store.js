/*!
 * 三易 · 智能写作台 —— 历史留档（store.js，仅服务端）
 *
 * 一稿一文件，写在 data/history/ 下：单篇损坏不影响其它稿子，
 * 也避免每次保存都重写整个列表。内存里只保留一份记录索引供列表检索。
 *
 * 「一篇稿子长什么样」不在这里定义，全部来自 lib/record.js。
 *
 * 主人（owner）：每篇稿子记着它是谁写的 —— 登录后是账号 id，没登录是 'local'。
 * **按人取用一律走 store.scope(owner)**，那一层把「只看自己的」写进每一个方法里；
 * 根上那几个方法不过滤主人（给留档总数、清理和测试用），别在接口里直接拿它当列表。
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

/** 没登录时的主人：登录后写下的稿子归账号，退出登录再看还是这一桶 */
const LOCAL_OWNER = 'local';

/** 把任意输入收成一个能当键用的主人值（认不出来就退回 local） */
function normalizeOwner(raw) {
  const text = String(raw == null ? '' : raw).trim();
  return /^[A-Za-z0-9_-]{1,40}$/.test(text) ? text : LOCAL_OWNER;
}

const ownerOf = (record) => normalizeOwner(record && record.owner);

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

  function sorted(rows) {
    const list = rows === undefined ? Array.from(index.values()) : rows;
    return Record.sortByUpdated(list);
  }

  /**
   * 超出上限时从最旧的开始清，星标的一律留住；极端情况下允许略微超出。
   *
   * 上限按**整台机器**算（800 篇），不按人算：这是个自用的本地工具，
   * 给每个账号分额度只会让「新建一个号试试」莫名其妙地挤掉别人的稿子。
   */
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

  /** 列表：先筛选再排序，摘要里不带正文，避免一次传太多 */
  function pageOf(rows, opts) {
    const o = opts || {};
    const all = sorted(rows).filter((r) => Record.matches(r, o));
    const limit = Modes.clamp(o.limit === undefined ? 50 : o.limit, 1, LIMITS.limitMax);
    const offset = Math.max(0, Number(o.offset) || 0);
    return {
      total: all.length,
      limit,
      offset,
      items: all.slice(offset, offset + limit).map(Record.summarize),
    };
  }

  /** 每个板块各有几篇（只统计传进来的这批，界面上那个筛选条要用） */
  function modeCounts(rows) {
    return Modes.listModeIds().map((id) => ({
      id,
      name: Modes.getMode(id).name,
      mark: Modes.getMode(id).mark,
      count: rows.filter((r) => r.mode === id).length,
    }));
  }

  async function createRecord(raw, owner) {
    const record = Record.normalizeRecord(raw);
    if (!record.versions.length) throw new Error('没有可保存的稿子');
    // 主人以调用方给的为准：客户端带来的 owner 字段一律不听
    record.owner = normalizeOwner(owner);
    await save(record);
    await trim();
    return record;
  }

  async function updateRecord(id, patch) {
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
  }

  async function removeRecord(id) {
    const key = String(id);
    if (!index.has(key)) return false;
    index.delete(key);
    await fsp.rm(fileOf(key), { force: true });
    return true;
  }

  /**
   * 按主人取用留档的唯一入口。
   *
   * 每个方法都只认自己这一桶 —— 这样「跨账号看到别人的稿子」不是靠每个接口记得传 owner，
   * 而是根本拿不到。返回值形状与根上的方法一致（少一个 exportAll 的差异也没有）。
   */
  function scope(rawOwner) {
    const owner = normalizeOwner(rawOwner);
    const mine = () => Array.from(index.values()).filter((r) => ownerOf(r) === owner);

    return {
      owner,

      async list(opts) {
        await ready();
        const rows = mine();
        return Object.assign(pageOf(rows, opts), { modes: modeCounts(rows) });
      },

      async get(id) {
        await ready();
        const record = index.get(String(id));
        return record && ownerOf(record) === owner ? record : null;
      },

      async create(raw) {
        await ready();
        return createRecord(raw, owner);
      },

      async update(id, patch) {
        await ready();
        const current = index.get(String(id));
        if (!current || ownerOf(current) !== owner) return null;
        return updateRecord(id, patch);
      },

      async remove(id) {
        await ready();
        const current = index.get(String(id));
        if (!current || ownerOf(current) !== owner) return false;
        return removeRecord(id);
      },

      async clear() {
        await ready();
        const ids = mine().map((r) => r.id);
        await Promise.all(ids.map((id) => removeRecord(id)));
        return ids.length;
      },

      async count() {
        await ready();
        return mine().length;
      },

      async exportAll(format, opts) {
        await ready();
        const rows = sorted(mine()).filter((r) => Record.matches(r, opts || {}));
        return Record.exportBundle(rows, format);
      },

      /**
       * 把「没登录时写的」那些稿子认领过来（登录之后那句「本地还有 N 篇」点一下就走这里）。
       *
       * 只在**已经登录**时可用：owner 是 local 的话认领等于原地打转。
       * 认领是显式动作、只动 owner 这一桶，不删不改别人的东西。
       */
      async claimLocal() {
        await ready();
        if (owner === LOCAL_OWNER) return 0;
        const rows = Array.from(index.values()).filter((r) => ownerOf(r) === LOCAL_OWNER);
        for (const record of rows) {
          record.owner = owner;
          await save(record);
        }
        return rows.length;
      },
    };
  }

  return {
    dir,
    ready,
    scope,

    /** 下面这几个不过滤主人：留档总数、清理，以及测试里「整库」的视角 */
    async list(opts) {
      await ready();
      const rows = Array.from(index.values());
      return Object.assign(pageOf(rows, opts), { modes: modeCounts(rows) });
    },

    async get(id) {
      await ready();
      return index.get(String(id)) || null;
    },

    async create(raw) {
      await ready();
      return createRecord(raw, raw && raw.owner);
    },

    async update(id, patch) {
      await ready();
      return updateRecord(id, patch);
    },

    async remove(id) {
      await ready();
      return removeRecord(id);
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

    /** 每个主人各有几篇（登录之后抽屉里那句「本地还有 N 篇」要用） */
    async owners() {
      await ready();
      const out = {};
      for (const record of index.values()) {
        const key = ownerOf(record);
        out[key] = (out[key] || 0) + 1;
      }
      return out;
    },

    async exportAll(format, opts) {
      await ready();
      const rows = sorted().filter((r) => Record.matches(r, opts || {}));
      return Record.exportBundle(rows, format);
    },
  };
}

module.exports = { createStore, LIMITS, LOCAL_OWNER, normalizeOwner };
