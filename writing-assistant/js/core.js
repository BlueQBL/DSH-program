/*!
 * 三易 · 智能写作台 —— 前端核心（core.js）
 *
 * 纯逻辑：写作台的状态怎么变、稿子怎么算、本地留档怎么存取。
 * 不碰 DOM，浏览器与 Node 都能跑，便于直接写测试。
 * 浏览器挂到 window.WriterCore，Node 走 module.exports。
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(
    isNode ? require('../lib/modes.js') : root.WriterModes,
    isNode ? require('../lib/record.js') : root.WriterRecord
  );
  if (isNode) module.exports = api;
  if (root) root.WriterCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Modes, Record) {
  'use strict';

  const KEY_STORE = 'writing-assistant/v1';
  const KEY_UI = 'writing-assistant/ui/v1';
  const LOCAL_CAP = 120;

  /** 空稿纸上给几条可以直接用的素材，省得对着空白发呆 */
  const EXAMPLES = {
    continue: [
      '周五的复盘会上，产品经理把用户反馈一条条念了出来。念到第七条时，会议室安静了。',
      '我搬进这间老房子的第一个晚上，听见楼上有弹珠落地的声音。房东说，楼上已经空了三年。',
    ],
    rewrite: [
      '本公司产品具有性能稳定、操作便捷的特点，能够满足广大用户的多样化需求，欢迎大家进行选购。',
      '通过这次培训，使我深刻地认识到了沟通的重要性，也让我明白了团队协作的意义所在。',
    ],
    copywriting: [
      '一款给通勤族用的折叠电煮锅，收纳后只有饭盒大小',
      '面向零基础成年人的线上钢琴课，每天 15 分钟',
    ],
    email: [
      '通知客户：原定本周五的系统验收因为设备未到位需要顺延，说明原因并请对方确认下周三是否可行',
      '向部门同事同步：下周一起周会改到周二上午十点，说明原因并请大家在日历上更新',
    ],
    summary: [
      '本次会议围绕三季度增长目标展开。运营组汇报新增用户环比增长 12%，但七日留存下滑 3 个百分点，主要原因是新手引导流程过长。技术组提出在下个版本中把引导步骤从五步压缩到两步，预计两周内上线。市场组认为投放成本上升，建议把预算向老客复购倾斜。会议决定：本周五前由产品组出引导流程的简化方案，运营组同步补充留存数据明细，下周一例会上过方案。',
      '这份季度报告统计了三家门店的经营情况。A 店客流下降 8% 但客单价提升 15%，总体营收持平；B 店因周边施工客流下降 22%，已申请线上补贴；C 店新开业三个月，日均订单 210 单，超出预期，计划在四季度复制其选址模型。',
    ],
    outline: [
      '写一篇给新入职同事看的《远程团队怎么开好周会》，发在公司内网',
      '整理一份面向管理层的《为什么要重做我们的结算系统》汇报提纲',
    ],
  };

  function exampleOf(mode, index) {
    const list = EXAMPLES[mode] || EXAMPLES.continue;
    return list[(index || 0) % list.length];
  }

  /* ── 状态 ───────────────────────────────────────────────── */
  function createState(over) {
    const mode = Modes.getMode(over && over.mode ? over.mode : 'continue').id;
    const state = {
      mode,
      material: '',
      fields: Modes.defaultFields(mode),
      params: {
        creativity: 0.8,
        length: 'medium',
        customChars: 600,
        versions: Math.min(3, Modes.angleCount(mode)),
        tone: Modes.defaultTone(mode),
      },
      versions: [],
      adopted: -1,
      polish: null,
      engine: null,
      notice: '',
      busy: false,
      savedId: '',
    };
    if (over) {
      if (typeof over.material === 'string') state.material = over.material;
      if (over.params) state.params = Object.assign(state.params, over.params);
      if (over.fields) state.fields = Object.assign(state.fields, over.fields);
    }
    return state;
  }

  /** 把状态里的参数合成一份可信配置（服务端与本地引擎都要经过它） */
  function resolvedParams(state) {
    return Modes.normalizeParams(
      Object.assign({ mode: state.mode, fields: state.fields }, state.params)
    );
  }

  function setMode(state, modeId) {
    const mode = Modes.getMode(modeId).id;
    if (mode === state.mode) return state;
    const next = Object.assign({}, state);
    next.mode = mode;
    // 模式换了，专属字段与语气都要换成新模式的定义；版本数不能超过新模式的角度数
    next.fields = Modes.defaultFields(mode);
    next.params = Object.assign({}, state.params, {
      tone: Modes.defaultTone(mode),
      versions: Modes.clamp(state.params.versions, 1, Modes.angleCount(mode)),
    });
    return next;
  }

  function setParam(state, patch) {
    const next = Object.assign({}, state);
    const params = Object.assign({}, state.params, patch || {});
    const resolved = Modes.normalizeParams(Object.assign({ mode: state.mode }, params));
    params.creativity = resolved.creativity;
    params.length = resolved.length;
    params.customChars = resolved.customChars;
    params.versions = Modes.clamp(params.versions, 1, Modes.angleCount(state.mode));
    params.tone = resolved.tone;
    next.params = params;
    return next;
  }

  function setField(state, fieldId, value) {
    const next = Object.assign({}, state);
    next.fields = Object.assign({}, state.fields, { [fieldId]: value });
    return next;
  }

  /* ── 生成过程 ───────────────────────────────────────────── */
  /** 收到 meta 后先把空稿片摆好，界面上立刻有「正在起稿」的位置感 */
  function beginRun(state, plan) {
    const next = Object.assign({}, state);
    next.busy = true;
    next.notice = '';
    next.adopted = -1;
    next.polish = null;
    next.savedId = '';
    next.versions = (plan || []).map((p) => ({
      index: p.index,
      angleId: p.angleId || '',
      angleLabel: p.angleLabel || '',
      text: '',
      engine: '',
      done: false,
      failed: false,
      note: '',
    }));
    return next;
  }

  function appendDelta(state, index, text) {
    const versions = state.versions.map((v) =>
      v.index === index ? Object.assign({}, v, { text: v.text + text }) : v
    );
    return Object.assign({}, state, { versions });
  }

  function finishVersion(state, index, info) {
    const versions = state.versions.map((v) =>
      v.index === index
        ? Object.assign({}, v, {
            text: (info && info.text) || v.text,
            engine: (info && info.engine) || v.engine,
            chars: (info && info.chars) || v.text.length,
            done: true,
          })
        : v
    );
    return Object.assign({}, state, { versions });
  }

  function failVersion(state, index, message) {
    const versions = state.versions.map((v) =>
      v.index === index ? Object.assign({}, v, { failed: true, done: true, note: message || '这一稿没生成出来' }) : v
    );
    return Object.assign({}, state, { versions });
  }

  function endRun(state, info) {
    return Object.assign({}, state, {
      busy: false,
      engine: (info && info.engine) || state.engine,
      notice: (info && info.notice) || state.notice,
    });
  }

  function adopt(state, index) {
    const hit = state.versions.some((v) => v.index === index);
    return Object.assign({}, state, { adopted: hit ? index : -1 });
  }

  function adoptedText(state) {
    const hit = state.versions.find((v) => v.index === state.adopted);
    if (hit) return hit.text;
    return state.versions[0] ? state.versions[0].text : state.material;
  }

  /** 「接着写」：把某一稿变成新的原稿，先把当前结果收进留档再改写 */
  function asMaterial(state, text) {
    return Object.assign({}, state, { material: text, versions: [], adopted: -1, polish: null, savedId: '' });
  }

  function bestVersion(state) {
    if (!state.versions.length) return null;
    if (state.adopted >= 0) return state.versions.find((v) => v.index === state.adopted) || null;
    return state.versions.find((v) => v.done && !v.failed && v.text) || null;
  }

  /* ── 记录 ───────────────────────────────────────────────── */
  function toRecord(state, extra) {
    const params = resolvedParams(state);
    const versions = state.versions
      .filter((v) => v.text && !v.failed)
      .map((v, i) => ({
        index: i,
        angleId: v.angleId,
        angleLabel: v.angleLabel,
        text: v.text,
        engine: v.engine === 'live' || v.engine === 'live-partial' ? v.engine : 'offline',
      }));
    const adoptedIndex = state.adopted >= 0 ? versions.findIndex((v) => v.index === state.adopted) : -1;
    return Record.normalizeRecord(
      Object.assign(
        {
          id: state.savedId || undefined,
          mode: state.mode,
          params,
          material: { input: state.material },
          versions,
          adoptedIndex,
          polished: state.polish
            ? {
                source: state.polish.source || '',
                before: state.polish.before || '',
                after: state.polish.after || '',
                edits: state.polish.edits || [],
                accepted: state.polish.accepted || [],
              }
            : null,
        },
        extra || {}
      )
    );
  }

  function fromRecord(record, keepId) {
    const mode = Modes.getMode(record.mode).id;
    const params = Modes.normalizeParams(record.params);
    const state = createState({ mode });
    state.material = (record.material && record.material.input) || '';
    state.fields = params.fields;
    state.params = {
      creativity: params.creativity,
      length: params.length,
      customChars: params.customChars,
      versions: params.versions,
      tone: params.tone,
    };
    state.versions = (record.versions || []).map((v, i) => ({
      index: i,
      angleId: v.angleId,
      angleLabel: v.angleLabel,
      text: v.text,
      engine: v.engine,
      chars: v.text.length,
      done: true,
      failed: false,
      note: '',
    }));
    state.adopted = record.adoptedIndex >= 0 && record.adoptedIndex < state.versions.length ? record.adoptedIndex : -1;
    state.polish = record.polished && record.polished.after
      ? {
          source: record.polished.source,
          before: record.polished.before,
          after: record.polished.after,
          edits: record.polished.edits || [],
          accepted: record.polished.accepted || [],
        }
      : null;
    state.savedId = keepId === false ? '' : record.id || '';
    return state;
  }

  /* ── 显示用的小工具 ─────────────────────────────────────── */
  /** 中文讲字数：空白不算 */
  function charCount(text) {
    return String(text || '').replace(/\s/g, '').length;
  }

  function formatChars(n) {
    const num = Number(n) || 0;
    return num >= 10000 ? (num / 10000).toFixed(1) + ' 万字' : num + ' 字';
  }

  function two(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /** 相对时间：列表里看时间比看完整日期有用 */
  function formatTime(iso, now) {
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return '';
    const base = now ? new Date(now) : new Date();
    const diff = base.getTime() - then.getTime();
    if (diff < 0) return '刚刚';
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';

    const sameDay = then.toDateString() === base.toDateString();
    if (sameDay) return '今天 ' + two(then.getHours()) + ':' + two(then.getMinutes());
    const yesterday = new Date(base.getTime() - 86400000);
    if (then.toDateString() === yesterday.toDateString()) return '昨天 ' + two(then.getHours()) + ':' + two(then.getMinutes());
    if (then.getFullYear() === base.getFullYear()) return `${then.getMonth() + 1} 月 ${then.getDate()} 日`;
    return `${then.getFullYear()} 年 ${then.getMonth() + 1} 月 ${then.getDate()} 日`;
  }

  function versionLabel(index) {
    return Record.sheetLabel(index);
  }

  /** 一键优化的选中对象：优先用户选中的那一稿，其次是采用了的那一稿 */
  function polishTarget(state) {
    const hit = bestVersion(state);
    if (hit && hit.text) return { source: 'version:' + hit.index, text: hit.text, label: versionLabel(hit.index) };
    return { source: 'input', text: state.material, label: '原稿' };
  }

  function canGenerate(state) {
    const text = String(state.material || '').trim();
    return !state.busy && text.length >= Modes.LIMITS.inputMin;
  }

  /* ── 本地留档（没有服务端时的退路） ─────────────────────── */
  /** 极薄的 localStorage 适配器：接口形状与服务端 /api/history 保持一致 */
  function createLocalStore(storage) {
    const KEY = KEY_STORE;

    function readAll() {
      try {
        const raw = storage.getItem(KEY);
        if (!raw) return [];
        const data = JSON.parse(raw);
        const list = Array.isArray(data) ? data : data && Array.isArray(data.records) ? data.records : [];
        return list.map((r) => Record.normalizeRecord(r)).filter((r) => r.versions.length);
      } catch {
        return [];
      }
    }

    /** 存储里永远保持「写入顺序」（旧 → 新），只在显示时才排序 */
    function writeAll(list) {
      const kept = list.slice();
      let dropped = 0;
      let i = 0;
      // 超出上限就从最旧的开始丢，星标的一律跳过
      while (kept.length > LOCAL_CAP && i < kept.length) {
        if (kept[i].starred) {
          i += 1;
          continue;
        }
        kept.splice(i, 1);
        dropped += 1;
      }
      storage.setItem(KEY, JSON.stringify({ version: 1, records: kept }));
      return dropped;
    }

    /**
     * 显示用的次序：新的在前。
     * 同一毫秒写入的两篇稿子时间戳完全一样，只能靠数组下标兜底，
     * 所以存储里必须保持写入顺序——把排好序的结果存回去会让次序自我放大成错的。
     */
    function sortRecords(list) {
      const order = new Map();
      list.forEach((r, i) => order.set(r.id, i));
      return list.slice().sort((a, b) => {
        const byTime = String(b.updatedAt).localeCompare(String(a.updatedAt));
        if (byTime !== 0) return byTime;
        return (order.get(b.id) || 0) - (order.get(a.id) || 0);
      });
    }

    return {
      kind: 'local',
      async list(opts) {
        const o = opts || {};
        const every = sortRecords(readAll());
        const all = every.filter((r) => Record.matches(r, o));
        const limit = Modes.clamp(o.limit === undefined ? 50 : o.limit, 1, 200);
        const offset = Math.max(0, Number(o.offset) || 0);
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
        return readAll().find((r) => r.id === id) || null;
      },
      async create(raw) {
        const record = Record.normalizeRecord(raw);
        if (!record.versions.length) throw new Error('没有可保存的稿子');
        const list = readAll().filter((r) => r.id !== record.id);
        list.push(record);
        writeAll(list);
        return record;
      },
      async update(id, patch) {
        const list = readAll();
        const current = list.find((r) => r.id === id);
        if (!current) return null;
        const p = patch || {};
        if (typeof p.title === 'string' && p.title.trim()) current.title = Record.clip(p.title.trim(), Record.LIMITS.titleChars);
        if (typeof p.starred === 'boolean') current.starred = p.starred;
        if (Number.isInteger(p.adoptedIndex) && p.adoptedIndex >= 0 && p.adoptedIndex < current.versions.length) {
          current.adoptedIndex = p.adoptedIndex;
        }
        if (p.polished === null) current.polished = null;
        if (p.polished && typeof p.polished === 'object') {
          current.polished = Record.normalizeRecord(Object.assign({}, current, { polished: p.polished })).polished;
        }
        current.updatedAt = Record.nowIso();
        writeAll(list.map((r) => (r.id === id ? current : r)));
        return current;
      },
      async remove(id) {
        const list = readAll();
        const rest = list.filter((r) => r.id !== id);
        if (rest.length === list.length) return false;
        writeAll(rest);
        return true;
      },
      async clear() {
        const n = readAll().length;
        storage.removeItem(KEY);
        return n;
      },
      async count() {
        return readAll().length;
      },
      async exportAll(format, opts) {
        const rows = sortRecords(readAll()).filter((r) => Record.matches(r, opts || {}));
        return Record.exportBundle(rows, format);
      },
    };
  }

  /** 界面偏好：模式、参数、上次的素材都留着，刷新后接着用 */
  function loadUI(storage) {
    try {
      const raw = storage.getItem(KEY_UI);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function saveUI(storage, data) {
    try {
      storage.setItem(KEY_UI, JSON.stringify(data));
    } catch {
      /* 存不下就算了，不影响使用 */
    }
  }

  return {
    KEY_STORE,
    KEY_UI,
    LOCAL_CAP,
    EXAMPLES,
    exampleOf,
    createState,
    resolvedParams,
    setMode,
    setParam,
    setField,
    beginRun,
    appendDelta,
    finishVersion,
    failVersion,
    endRun,
    adopt,
    adoptedText,
    asMaterial,
    bestVersion,
    toRecord,
    fromRecord,
    charCount,
    formatChars,
    formatTime,
    versionLabel,
    polishTarget,
    canGenerate,
    createLocalStore,
    loadUI,
    saveUI,
  };
});
