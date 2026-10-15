/*!
 * 三易 · 智能写作台 —— 模板留档（template-store.js，仅服务端）
 *
 * 和稿件留档同样的一稿一文件：单个模板坏了不影响别的，
 * 也避免每次保存都重写整个列表。
 */
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const Modes = require('./modes.js');
const Template = require('./template.js');

const LIMITS = { files: Modes.LIMITS.templatesMax };

async function sweepTemp(dir) {
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(names.filter((n) => n.endsWith('.tmp')).map((n) => fsp.rm(path.join(dir, n), { force: true })));
}

function createTemplateStore(options) {
  const dir = (options && options.dir) || path.join(__dirname, '..', 'data', 'templates');
  const index = new Map();
  let loaded = false;

  const fileOf = (id) => path.join(dir, `${id}.json`);

  async function writeAtomic(file, text) {
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 6)}.tmp`;
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, file);
  }

  async function save(tpl) {
    tpl.updatedAt = new Date().toISOString();
    await writeAtomic(fileOf(tpl.id), JSON.stringify(tpl, null, 2));
    index.set(tpl.id, tpl);
    return tpl;
  }

  function sorted() {
    return Template.sortTemplates(Array.from(index.values()));
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
        const tpl = Template.normalizeTemplate(JSON.parse(raw));
        index.set(tpl.id, tpl);
      } catch (err) {
        console.warn(`[templates] 跳过读不出来的模板 ${name}：${err.message}`);
      }
    }
  }

  return {
    dir,
    ready,

    async list(opts) {
      await ready();
      const o = opts || {};
      const all = sorted().filter((t) => Template.matchesTemplate(t, o));
      return { total: all.length, items: all.map(Template.summarize), records: all };
    },

    /** 给 prompt 用：服务端也需要模板原文（不经过摘要） */
    async all() {
      await ready();
      return sorted();
    },

    async get(id) {
      await ready();
      return index.get(String(id)) || null;
    },

    async create(raw) {
      await ready();
      const check = Template.validateTemplate(raw);
      if (!check.ok) throw new Error(check.message);
      if (index.size >= LIMITS.files) throw new Error(`模板最多 ${LIMITS.files} 个，先删掉几个不用的`);
      const tpl = await save(check.template);
      return tpl;
    },

    async update(id, patch) {
      await ready();
      const current = index.get(String(id));
      if (!current) return null;
      const merged = Template.normalizeTemplate(Object.assign({}, current, patch || {}, { id: current.id }));
      const check = Template.validateTemplate(merged);
      if (!check.ok) throw new Error(check.message);
      return save(check.template);
    },

    async remove(id) {
      await ready();
      const key = String(id);
      if (!index.has(key)) return false;
      index.delete(key);
      await fsp.rm(fileOf(key), { force: true });
      return true;
    },

    async count() {
      await ready();
      return index.size;
    },
  };
}

module.exports = { createTemplateStore, LIMITS };
