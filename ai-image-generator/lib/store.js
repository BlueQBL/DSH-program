/*!
 * 蓝晒 · AI 图片生成器 —— 历史记录与可用性记忆（store.js，仅服务端）
 *
 * 落盘原则和仓库里其它项目一致：
 *   · 一条记录一个 JSON 文件，坏文件跳过而不是把整本记录当空
 *   · 先写临时文件再 rename：断电 / 崩溃不会留下半截 JSON
 *   · 图片单独存 data/images/，记录里只放文件名 —— 删记录时顺手删图，
 *     不留「孤儿图片」把磁盘慢慢吃满
 */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ID_RE = /^[a-z]{2,4}_[a-z0-9_]{4,40}$/i;
const MAX_RECORDS = 5000;

function random4() {
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0');
}

function newId(prefix) {
  return `${prefix || 'img'}_${Date.now().toString(36)}_${random4()}`;
}

/**
 * 原子写：先写 .tmp 再 rename，避免半截文件。
 *
 * rename 在 Windows 上有一种真实的偶发失败：文件刚写完正在被安全软件扫描，
 * 目标被短暂锁住，于是 EPERM。这不是逻辑错，重试一下就好 —— 但也不能无限重试，
 * 最后退化成「直接覆盖写」，至少别把记录弄丢。
 */
async function sleepSync(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameWithRetry(tmp, target) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fsp.rename(tmp, target);
      return true;
    } catch (err) {
      if (attempt === 4) break;
      await sleepSync(20 * (attempt + 1));
    }
  }
  // 兜底：覆盖写（不是原子的，但比丢掉这条记录好）
  await fsp.copyFile(tmp, target);
  await fsp.unlink(tmp).catch(() => {});
  return false;
}

function renameSyncWithRetry(tmp, target) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.renameSync(tmp, target);
      return true;
    } catch {
      const until = Date.now() + 20 * (attempt + 1);
      while (Date.now() < until) {
        /* 短暂等一下：Windows 上被扫描锁住的文件通常几十毫秒就放开 */
      }
    }
  }
  fs.copyFileSync(tmp, target);
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  return false;
}

async function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${random4()}`;
  await fsp.writeFile(tmp, text, 'utf8');
  await renameWithRetry(tmp, file);
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * 历史记录表。
 * @param {object} options { dir, imageDir, log }
 */
function createStore(options) {
  const opt = options || {};
  const dir = opt.dir || path.join(process.cwd(), 'data', 'history');
  const imageDir = opt.imageDir || path.join(path.dirname(dir), 'images');
  const log = typeof opt.log === 'function' ? opt.log : () => {};
  let readyPromise = null;

  async function ready() {
    if (!readyPromise) {
      readyPromise = (async () => {
        await fsp.mkdir(dir, { recursive: true });
        await fsp.mkdir(imageDir, { recursive: true });
      })();
      readyPromise.catch(() => {
        readyPromise = null;
      });
    }
    return readyPromise;
  }

  function fileOf(id) {
    return path.join(dir, `${id}.json`);
  }

  function imagePathOf(file) {
    const name = path.basename(String(file || ''));
    if (!name) return '';
    return path.join(imageDir, name);
  }

  /** 记录的形状在入口统一收口：别让界面传什么就存什么 */
  function normalize(input) {
    const r = input || {};
    const prompt = String(r.prompt || '').slice(0, 2000);
    const id = ID_RE.test(String(r.id || '')) ? String(r.id) : newId('img');
    const style = r.style && typeof r.style === 'object' ? r.style : {};
    const size = r.size && typeof r.size === 'object' ? r.size : {};
    const record = {
      id,
      createdAt: Number(r.createdAt) || Date.now(),
      prompt,
      finalPrompt: String(r.finalPrompt || prompt).slice(0, 4000),
      optimized: r.optimized && typeof r.optimized === 'object'
        ? {
            prompt: String(r.optimized.prompt || '').slice(0, 3000),
            notes: String(r.optimized.notes || '').slice(0, 240),
            engine: r.optimized.engine === 'live' ? 'live' : 'offline',
          }
        : null,
      style: { id: String(style.id || 'photo').slice(0, 24), label: String(style.label || '').slice(0, 24) },
      size: {
        requested: String(size.requested || '').slice(0, 24),
        actual: String(size.actual || '').slice(0, 24),
        ratio: String(size.ratio || '').slice(0, 8),
      },
      quality: String(r.quality || '').slice(0, 12),
      model: String(r.model || '').slice(0, 80),
      engine: r.engine === 'offline' ? 'offline' : 'live',
      file: path.basename(String(r.file || '')),
      mime: String(r.mime || 'image/png').slice(0, 40),
      bytes: Number(r.bytes) || 0,
      width: Number(r.width) || 0,
      height: Number(r.height) || 0,
      remoteUrl: String(r.remoteUrl || '').slice(0, 500),
      elapsedMs: Number(r.elapsedMs) || 0,
      notes: Array.isArray(r.notes) ? r.notes.map((n) => String(n).slice(0, 200)).slice(0, 6) : [],
    };
    return record;
  }

  async function create(input) {
    await ready();
    const record = normalize(input);
    await writeFileAtomic(fileOf(record.id), JSON.stringify(record, null, 2));
    return record;
  }

  async function get(id) {
    const key = String(id || '');
    if (!ID_RE.test(key)) return null;
    await ready();
    try {
      const text = await fsp.readFile(fileOf(key), 'utf8');
      const data = JSON.parse(text);
      if (!data || data.id !== key) return null;
      return data;
    } catch {
      return null;
    }
  }

  /** 读全部记录；坏文件跳过并留一句日志，不当成空表 */
  async function readAll() {
    await ready();
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch (err) {
      log(`[history] 读不了记录目录：${err.message}`);
      return [];
    }
    const items = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!ID_RE.test(id)) continue;
      try {
        const text = await fsp.readFile(path.join(dir, name), 'utf8');
        const data = JSON.parse(text);
        if (data && data.id === id) items.push(data);
      } catch {
        log(`[history] 跳过坏记录：${name}`);
      }
    }
    items.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
    return items.slice(0, MAX_RECORDS);
  }

  async function list(query) {
    const q = query || {};
    const all = await readAll();
    const keyword = String(q.q || '').trim().toLowerCase();
    const filtered = keyword
      ? all.filter((r) =>
          [r.prompt, r.finalPrompt, r.style && r.style.label, r.model]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(keyword)
        )
      : all;
    const offset = clampInt(q.offset, 0, MAX_RECORDS, 0);
    const limit = clampInt(q.limit, 1, 200, 50);
    return { items: filtered.slice(offset, offset + limit), total: filtered.length, offset, limit };
  }

  async function remove(id) {
    const record = await get(id);
    if (!record) return false;
    await fsp.unlink(fileOf(id)).catch(() => {});
    const imageFile = imagePathOf(record.file);
    if (imageFile) await fsp.unlink(imageFile).catch(() => {});
    return true;
  }

  async function clear() {
    const all = await readAll();
    let removed = 0;
    for (const record of all) {
      const ok = await remove(record.id).catch(() => false);
      if (ok) removed += 1;
    }
    return removed;
  }

  async function count() {
    return (await readAll()).length;
  }

  /** 页头上那句「N 张 · 总共多大」的出处 */
  async function stats() {
    const all = await readAll();
    const bytes = all.reduce((sum, r) => sum + (Number(r.bytes) || 0), 0);
    const models = Array.from(new Set(all.map((r) => r.model).filter(Boolean)));
    return { count: all.length, bytes, models, latestAt: all.length ? all[0].createdAt : 0 };
  }

  /** 把落盘的文件名还原成可下载的路径（挡掉 ../ 这类穿越） */
  function resolveImage(file) {
    const name = path.basename(String(file || ''));
    if (!name || name === '.' || name === '..') return '';
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return '';
    return path.join(imageDir, name);
  }

  async function saveImage(id, buffer, ext) {
    await ready();
    const file = `${id}${ext}`;
    const target = path.join(imageDir, file);
    const tmp = `${target}.tmp-${process.pid}-${random4()}`;
    await fsp.writeFile(tmp, buffer);
    await fsp.rename(tmp, target);
    return file;
  }

  return {
    dir,
    imageDir,
    ready,
    create,
    get,
    list,
    remove,
    clear,
    count,
    stats,
    readAll,
    resolveImage,
    saveImage,
    normalize,
    newId,
  };
}

/**
 * 模型可用性记忆（data/model-status.json）。
 *
 * 为什么要落盘：出图实测是真花钱的，重启之后再问一遍很浪费；
 * 而且「上次这个模型明明调不通」这件事，界面上一眼能看到才有意义。
 */
function createModelStatusStore(options) {
  const opt = options || {};
  const file = opt.file || path.join(process.cwd(), 'data', 'model-status.json');
  const log = typeof opt.log === 'function' ? opt.log : () => {};
  let data = { version: 1, models: {} };

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.models && typeof parsed.models === 'object') {
        data = { version: 1, models: parsed.models };
      }
    }
  } catch (err) {
    // 文件坏了：当作没有记忆（只影响下拉框上的标记，不影响出图）
    log(`[models] 可用性记录读不了，已忽略：${err.message}`);
    data = { version: 1, models: {} };
  }

  function flush() {
    try {
      const tmp = `${file}.tmp-${process.pid}-${random4()}`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      renameSyncWithRetry(tmp, file);
    } catch (err) {
      log(`[models] 可用性记录没写成：${err.message}`);
    }
  }

  return {
    file,
    get(model) {
      const hit = data.models[String(model || '')];
      if (!hit || typeof hit !== 'object') return null;
      return { ok: Boolean(hit.ok), at: Number(hit.at) || 0, message: String(hit.message || '') };
    },
    set(model, entry) {
      const key = String(model || '').trim();
      if (!key) return;
      data.models[key] = {
        ok: Boolean(entry && entry.ok),
        at: Number(entry && entry.at) || Date.now(),
        message: String((entry && entry.message) || '').slice(0, 300),
      };
      flush();
    },
    all() {
      return Object.assign({}, data.models);
    },
  };
}

module.exports = {
  ID_RE,
  newId,
  createStore,
  createModelStatusStore,
  writeFileAtomic,
};
