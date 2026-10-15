/*!
 * 三易 · 智能写作台 —— 稿子记录的形状（record.js）
 *
 * 「一篇稿子长什么样」只允许有一个定义：服务端（文件留档）、浏览器（本地留档）、
 * 导出（md/txt/json）与测试全都走这里。纯函数，浏览器与 Node 共用。
 */
(function (root, factory) {
  const api = factory(
    typeof module === 'object' && module.exports ? require('./modes.js') : root.WriterModes
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WriterRecord = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Modes) {
  'use strict';

  const LIMITS = {
    textPerVersion: 60000,
    materialChars: 40000,
    titleChars: 60,
    excerptChars: 80,
    versions: Modes.LIMITS.versionsMax,
  };

  const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

  function nowIso() {
    return new Date().toISOString();
  }

  function randomSuffix() {
    return Math.random().toString(36).slice(2, 6);
  }

  function makeId() {
    return 'd_' + Date.now().toString(36) + '_' + randomSuffix();
  }

  function clip(text, max) {
    const s = String(text == null ? '' : text);
    return s.length > max ? s.slice(0, max) : s;
  }

  /** 第几稿的中文写法，稿签上要用 */
  function sheetLabel(index) {
    return `第${CN_NUM[index] || index + 1}稿`;
  }

  /** 标题取「模式 + 素材开头」，没素材就用第一稿开头——列表里一眼能认出来 */
  function deriveTitle(record) {
    const mode = Modes.getMode(record.mode);
    const seed = String((record.material && record.material.input) || '').trim()
      || String((record.versions && record.versions[0] && record.versions[0].text) || '').trim();
    const flat = seed.replace(/\s+/g, ' ').replace(/^[「『"'（(]+/, '').trim();
    if (!flat) return mode.name + ' · 未命名稿';
    return clip(`${mode.name} · ${flat}`, LIMITS.titleChars);
  }

  function excerptOf(record) {
    const first = record.versions && record.versions[0];
    const text = String((first && first.text) || (record.material && record.material.input) || '');
    return clip(text.replace(/\s+/g, ' ').trim(), LIMITS.excerptChars);
  }

  function normalizeVersion(raw, index) {
    const v = raw && typeof raw === 'object' ? raw : {};
    const text = clip(v.text || '', LIMITS.textPerVersion);
    return {
      index: Number.isInteger(v.index) ? v.index : index,
      angleId: clip(v.angleId || '', 40),
      angleLabel: clip(v.angleLabel || '', 40),
      text,
      engine: v.engine === 'live' ? 'live' : v.engine === 'live-partial' ? 'live-partial' : 'offline',
      chars: Number(v.chars) || text.length,
      createdAt: v.createdAt || nowIso(),
    };
  }

  /**
   * 客户端传来的东西一律不信任：字段缺失、类型不对、超长都要在这里收敛掉。
   * 服务端与浏览器本地留档共用，保证两边存下来的稿子长得一模一样。
   */
  function normalizeRecord(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const params = Modes.normalizeParams(input.params || { mode: input.mode });
    const versions = (Array.isArray(input.versions) ? input.versions : [])
      .slice(0, LIMITS.versions)
      .map((v, i) => normalizeVersion(v, i));
    const adopted = Number.isInteger(input.adoptedIndex) ? input.adoptedIndex : -1;

    const record = {
      id: /^[A-Za-z0-9_-]{4,40}$/.test(String(input.id || '')) ? String(input.id) : makeId(),
      createdAt: input.createdAt || nowIso(),
      updatedAt: input.updatedAt || input.createdAt || nowIso(),
      mode: params.mode,
      // 存下当时的板块名：自定义模板被删掉后，板块 id 就没人认识了，
      // 只靠 id 反查会让旧稿显示成「文章续写」——那是查不到时的兜底，不是事实
      modeName: clip(input.modeName || Modes.getMode(params.mode).name, 24),
      params,
      material: { input: clip((input.material && input.material.input) || '', LIMITS.materialChars) },
      versions,
      adoptedIndex: adopted >= 0 && adopted < versions.length ? adopted : -1,
      starred: Boolean(input.starred),
      tags: (Array.isArray(input.tags) ? input.tags : []).map((t) => clip(t, 16)).slice(0, 8),
      polished: input.polished && typeof input.polished === 'object'
        ? {
            source: clip(input.polished.source || '', 40),
            before: clip(input.polished.before || '', LIMITS.textPerVersion),
            after: clip(input.polished.after || '', LIMITS.textPerVersion),
            edits: Array.isArray(input.polished.edits) ? input.polished.edits.slice(0, 200) : [],
            accepted: Array.isArray(input.polished.accepted) ? input.polished.accepted.map(String).slice(0, 200) : [],
          }
        : null,
    };
    record.title = clip(input.title || deriveTitle(record), LIMITS.titleChars);
    return record;
  }

  function summarize(record) {
    const mode = Modes.getMode(record.mode);
    return {
      id: record.id,
      title: record.title,
      mode: record.mode,
      modeName: record.modeName || mode.name,
      mark: mode.mark,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      starred: Boolean(record.starred),
      versions: (record.versions || []).length,
      chars: (record.versions || []).reduce((sum, v) => sum + String(v.text || '').length, 0),
      params: record.params,
      excerpt: excerptOf(record),
      hasPolish: Boolean(record.polished && record.polished.after),
      adoptedIndex: record.adoptedIndex,
    };
  }

  function haystack(record) {
    return [
      record.title,
      (record.material && record.material.input) || '',
      (record.versions || []).map((v) => v.text).join('\n'),
    ].join('\n').toLowerCase();
  }

  function matches(record, opts) {
    const o = opts || {};
    if (o.mode && o.mode !== 'all' && record.mode !== o.mode) return false;
    if (o.starred && !record.starred) return false;
    const q = String(o.q || '').trim().toLowerCase();
    if (!q) return true;
    return haystack(record).includes(q);
  }

  /**
   * 最近的排前面。
   * 同一毫秒写入的稿子时间戳完全相同，必须再给一个确定的次序，
   * 否则「超出上限丢最旧的」会丢错人、重启后列表顺序也会飘。
   */
  function sortByUpdated(records) {
    return (records || []).slice().sort((a, b) => {
      const byUpdated = String(b.updatedAt).localeCompare(String(a.updatedAt));
      if (byUpdated !== 0) return byUpdated;
      const byCreated = String(b.createdAt).localeCompare(String(a.createdAt));
      if (byCreated !== 0) return byCreated;
      return String(b.id).localeCompare(String(a.id));
    });
  }

  /** 模式附加字段（平台、收件人、力度……）拼成一行人话，导出时不能丢 */
  function fieldsLine(record) {
    const mode = Modes.getMode(record.mode);
    const params = record.params || Modes.normalizeParams({ mode: record.mode });
    const parts = [];
    mode.fields.forEach((f) => {
      const value = (params.fields || {})[f.id];
      if (!value) return;
      const opt = (f.options || []).find((o) => o.value === value);
      parts.push(`${f.label}：${opt ? opt.label : value}`);
    });
    return parts.join(' · ');
  }

  function toMarkdown(record) {
    const mode = Modes.getMode(record.mode);
    const modeName = record.modeName || mode.name;
    const extras = fieldsLine(record);
    const lines = [];
    lines.push(`# ${record.title}`);
    lines.push('');
    lines.push(`- 模式：${modeName}`);
    lines.push(`- 参数：${Modes.describeParams(record.params)}`);
    if (extras) lines.push(`- 附加：${extras}`);
    lines.push(`- 时间：${record.createdAt}`);
    lines.push(`- 版本：${record.versions.length} 稿${record.adoptedIndex >= 0 ? `（采用了${sheetLabel(record.adoptedIndex)}）` : ''}`);
    lines.push('');
    if (record.material.input) {
      lines.push('## 素材');
      lines.push('');
      lines.push(record.material.input);
      lines.push('');
    }
    record.versions.forEach((v, i) => {
      lines.push(`## ${sheetLabel(i)} · ${v.angleLabel || '常规'}`);
      lines.push('');
      lines.push(v.text);
      lines.push('');
    });
    if (record.polished && record.polished.after) {
      lines.push('## 润色稿');
      lines.push('');
      lines.push(record.polished.after);
      lines.push('');
      if (record.polished.edits.length) {
        lines.push('### 朱批');
        lines.push('');
        record.polished.edits.forEach((e) => {
          lines.push(`- 〔${e.type || '改动'}〕${e.before} → ${e.after}${e.reason ? `（${e.reason}）` : ''}`);
        });
        lines.push('');
      }
    }
    return lines.join('\n');
  }

  function toPlainText(record) {
    const mode = Modes.getMode(record.mode);
    const extras = fieldsLine(record);
    const sep = '\n' + '─'.repeat(24) + '\n';
    const parts = [
      `${record.title}\n${record.modeName || mode.name} · ${Modes.describeParams(record.params)}${extras ? ' · ' + extras : ''} · ${record.createdAt}`,
    ];
    record.versions.forEach((v, i) => {
      parts.push(`${sheetLabel(i)}（${v.angleLabel || '常规'}）\n\n${v.text}`);
    });
    if (record.polished && record.polished.after) parts.push(`润色稿\n\n${record.polished.after}`);
    return parts.join(sep);
  }

  /** 打包导出：md 归档、txt 直粘、json 搬家 */
  function exportBundle(records, format) {
    const rows = records || [];
    const stamp = nowIso();
    if (format === 'json') {
      return {
        ext: 'json',
        mime: 'application/json; charset=utf-8',
        body: JSON.stringify({ app: Modes.APP.id, exportedAt: stamp, count: rows.length, records: rows }, null, 2),
      };
    }
    if (format === 'txt') {
      return {
        ext: 'txt',
        mime: 'text/plain; charset=utf-8',
        body: rows.map(toPlainText).join('\n\n' + '═'.repeat(32) + '\n\n'),
      };
    }
    const head = `# ${Modes.APP.name} · 写作留档\n\n导出时间：${stamp}　共 ${rows.length} 篇\n\n---\n\n`;
    return {
      ext: 'md',
      mime: 'text/markdown; charset=utf-8',
      body: head + rows.map(toMarkdown).join('\n\n---\n\n'),
    };
  }

  return {
    LIMITS,
    CN_NUM,
    nowIso,
    makeId,
    randomSuffix,
    clip,
    sheetLabel,
    deriveTitle,
    excerptOf,
    normalizeVersion,
    normalizeRecord,
    summarize,
    matches,
    sortByUpdated,
    fieldsLine,
    toMarkdown,
    toPlainText,
    exportBundle,
  };
});
