/*!
 * 三易 · 智能写作台 —— 朱批定位与差异（polisher.js）
 *
 * 一键优化拿到的是「改完的整篇」+「若干条改动说明」，但要在稿纸上画朱批，
 * 就必须把每条改动落成原文中的**具体位置**。这个文件负责这件事：
 *   定位 → 与真实差异合并 → 逐条采纳/还原 → 渲染成可点击的批注片段。
 *
 * 纯函数，浏览器与 Node 共用。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WriterPolisher = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TYPES = {
    grammar: { label: '语法', mark: '改' },
    collocation: { label: '搭配', mark: '改' },
    wording: { label: '用词', mark: '改' },
    punct: { label: '标点', mark: '标' },
    order: { label: '语序', mark: '换' },
    redundant: { label: '冗余', mark: '删' },
    tone: { label: '语气', mark: '调' },
    typo: { label: '错别字', mark: '正' },
  };

  const MAX_EDITS = 60;
  const MIN_BEFORE = 1;
  const MAX_BEFORE = 120;

  /* ── 分句 ───────────────────────────────────────────────── */
  /** 按句末标点/换行切段并保留分隔符：中文长文本最稳的差异粒度 */
  function splitSegments(text) {
    const out = [];
    const src = String(text || '');
    const re = /[^。！？!?；;\n]*[。！？!?；;\n]+|[^。！？!?；;\n]+/g;
    let m;
    while ((m = re.exec(src)) !== null) out.push(m[0]);
    return out.length ? out : [''];
  }

  /* ── 序列差异（LCS） ─────────────────────────────────────── */
  /** 对两个字符串数组做 LCS，返回操作序列：0=相同 1=仅左 2=仅右 */
  function lcsOps(a, b) {
    const n = a.length;
    const m = b.length;
    if (n === 0 && m === 0) return [];
    if (n === 0) return b.map(() => ({ type: 'ins', ai: -1, bi: 0 }));
    if (m === 0) return a.map(() => ({ type: 'del', ai: 0, bi: -1 }));

    const w = m + 1;
    const dp = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i * w + j] = a[i] === b[j]
          ? dp[(i + 1) * w + (j + 1)] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
      }
    }
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        ops.push({ type: 'same', ai: i, bi: j });
        i += 1;
        j += 1;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
        ops.push({ type: 'del', ai: i, bi: -1 });
        i += 1;
      } else {
        ops.push({ type: 'ins', ai: -1, bi: j });
        j += 1;
      }
    }
    while (i < n) {
      ops.push({ type: 'del', ai: i, bi: -1 });
      i += 1;
    }
    while (j < m) {
      ops.push({ type: 'ins', ai: -1, bi: j });
      j += 1;
    }
    return ops;
  }

  /**
   * 字级差异：只用于「同一句内部被改了词」的情况，段落级差异交给分句差异。
   * 相邻的「删」与「增」必须合并成一条替换——分成两条会出现「删了逗号又插了逗号」
   * 这种在界面上无法理解的朱批，也会让合并逻辑误判重叠。
   */
  function charDiff(beforeText, afterText, offsetInBefore) {
    const a = Array.from(beforeText);
    const b = Array.from(afterText);
    const ops = lcsOps(a, b);
    const edits = [];
    let i = 0;
    let ai = 0;

    while (i < ops.length) {
      if (ops[i].type === 'same') {
        ai += 1;
        i += 1;
        continue;
      }
      // 一段连续的改动：把中间的删与增都收进同一条
      const start = offsetInBefore + ai;
      let removed = '';
      let added = '';
      while (i < ops.length && ops[i].type !== 'same') {
        if (ops[i].type === 'del') {
          removed += a[ops[i].ai];
          ai += 1;
        } else {
          added += b[ops[i].bi];
        }
        i += 1;
      }
      edits.push({
        op: !removed ? 'insert' : !added ? 'delete' : 'replace',
        start,
        end: start + Array.from(removed).length,
        before: removed,
        after: added,
      });
    }
    return edits;
  }

  /**
   * 计算「改前 → 改后」的差异，坐标一律相对改前文本。
   * 先按句切分做粗对齐，句内再逐字对齐；句子太长时整句视为一次替换。
   */
  function diffEdits(before, after) {
    const src = String(before || '');
    const dst = String(after || '');
    if (src === dst) return [];

    const aSegs = splitSegments(src);
    const bSegs = splitSegments(dst);
    const ops = lcsOps(aSegs, bSegs);

    // 句首在原文本中的偏移，便于把句内差异换算回全文坐标
    const aOffsets = [];
    let cursor = 0;
    aSegs.forEach((s) => {
      aOffsets.push(cursor);
      cursor += s.length;
    });

    const edits = [];
    let ai = 0;
    let bi = 0;
    let i = 0;
    while (i < ops.length) {
      if (ops[i].type === 'same') {
        ai += 1;
        bi += 1;
        i += 1;
        continue;
      }
      // 收集一段连续的「删 + 增」，合并成一次改动
      let delText = '';
      let insText = '';
      const delStart = ai;
      while (i < ops.length && ops[i].type !== 'same') {
        if (ops[i].type === 'del') {
          delText += aSegs[ops[i].ai];
          ai += 1;
        } else {
          insText += bSegs[ops[i].bi];
          bi += 1;
        }
        i += 1;
      }
      const start = delStart < aOffsets.length ? aOffsets[delStart] : src.length;
      const short = Array.from(delText).length <= 400 && Array.from(insText).length <= 400;
      if (delText && insText && short) {
        charDiff(delText, insText, start).forEach((e) => edits.push(e));
      } else {
        edits.push({
          op: !delText ? 'insert' : !insText ? 'delete' : 'replace',
          start,
          end: start + delText.length,
          before: delText,
          after: insText,
        });
      }
    }
    return edits.filter((e) => e.before !== e.after).slice(0, MAX_EDITS);
  }

  /* ── 改动说明的定位 ─────────────────────────────────────── */
  /** 在原文里找 before 的唯一位置；出现 0 次或多次都算定位失败 */
  function locate(text, before) {
    const needle = String(before || '');
    const size = Array.from(needle).length;
    if (size < MIN_BEFORE || size > MAX_BEFORE) return null;
    const first = text.indexOf(needle);
    if (first < 0) return null;
    if (text.indexOf(needle, first + 1) >= 0) return null;
    return { start: first, end: first + needle.length };
  }

  /** 模型给的改动说明 → 带坐标的朱批条目（不能定位的直接丢弃） */
  function locateRewrites(text, rewrites) {
    const src = String(text || '');
    const out = [];
    const seen = new Set();
    (Array.isArray(rewrites) ? rewrites : []).forEach((raw) => {
      if (!raw || typeof raw !== 'object') return;
      const before = String(raw.before == null ? '' : raw.before);
      const after = String(raw.after == null ? '' : raw.after);
      if (!before || before === after) return;
      const pos = locate(src, before);
      if (!pos) return;
      const key = pos.start + ':' + pos.end;
      if (seen.has(key)) return;
      seen.add(key);
      const type = TYPES[raw.type] ? raw.type : 'wording';
      out.push({
        op: after ? (pos.end > pos.start ? 'replace' : 'insert') : 'delete',
        start: pos.start,
        end: pos.end,
        before,
        after,
        type,
        reason: String(raw.reason || '').slice(0, 40),
        source: 'model',
      });
    });
    return out.sort((x, y) => x.start - y.start).slice(0, MAX_EDITS);
  }

  /**
   * 合并「模型说明的改动」与「真实差异」。
   *
   * 以真实差异为准：润色稿是权威，朱批条目必须能**完整还原**出润色稿。
   * 模型给的说明只用来标注类型与原因——它说的地方若与真实差异对不上，
   * 宁可丢掉这条说明，也不能让「全部采纳」得到一份和润色稿不一样的文字。
   */
  function mergeEdits(text, rewrites, polished) {
    const src = String(text || '');
    const actual = diffEdits(src, polished).map((e) => ({
      op: e.op,
      start: e.start,
      end: e.end,
      before: e.before,
      after: e.after,
      type: inferType(e),
      reason: '',
      source: 'diff',
    }));

    locateRewrites(src, rewrites).forEach((named) => {
      // 说明覆盖到的真实改动，继承它的类型与原因
      const inside = actual.filter((e) => e.start >= named.start && e.end <= named.end);
      if (!inside.length) return;
      inside.forEach((e) => {
        e.type = named.type;
        if (named.reason) e.reason = named.reason;
        e.source = 'model';
      });
    });

    return actual.map((e, idx) => Object.assign({}, e, { id: 'e' + (idx + 1) }));
  }

  /** 差异兜底时的类型猜测：只看得到形状，猜错也比空着好 */
  function inferType(edit) {
    if (edit.op === 'delete') return 'redundant';
    if (edit.op === 'insert') return 'wording';
    const before = String(edit.before || '');
    const after = String(edit.after || '');
    if (/[，。！？；：、""''（）,.!?;:]$/.test(before) || /[，。！？；：、""''（）,.!?;:]$/.test(after)) return 'punct';
    if (before.length <= 4 && after.length <= 4) return 'wording';
    return 'wording';
  }

  /* ── 采纳 / 还原 ────────────────────────────────────────── */
  /**
   * 按「采纳的条目」重算文本。未采纳的条目保持原文，所以可以只采纳一半。
   * 从后往前替换，避免坐标位移互相影响。
   */
  function applyEdits(text, edits, acceptedIds) {
    const src = String(text || '');
    const accept = acceptedIds instanceof Set ? acceptedIds : new Set(acceptedIds || []);
    const list = (edits || []).filter((e) => accept.has(e.id)).slice().sort((a, b) => b.start - a.start);
    let out = src;
    list.forEach((e) => {
      out = out.slice(0, e.start) + (e.after || '') + out.slice(e.end);
    });
    return out;
  }

  /**
   * 把原文切成可渲染的片段：原样 / 划线待删 / 朱字新增。
   * 每条改动的第一个片段带 editId，界面据此挂批注与操作。
   */
  function renderSpans(text, edits) {
    const src = String(text || '');
    const list = (edits || []).slice().sort((a, b) => a.start - b.start || a.end - b.end);
    const spans = [];
    let cursor = 0;
    list.forEach((e) => {
      if (e.start < cursor) return; // 重叠条目按先出现者为准，避免切碎
      if (e.start > cursor) spans.push({ kind: 'same', text: src.slice(cursor, e.start) });
      const removed = src.slice(e.start, e.end);
      if (removed) spans.push({ kind: 'del', text: removed, editId: e.id });
      if (e.after) spans.push({ kind: 'ins', text: e.after, editId: e.id, lead: !removed });
      cursor = Math.max(cursor, e.end);
    });
    if (cursor < src.length) spans.push({ kind: 'same', text: src.slice(cursor) });
    return spans;
  }

  /** 按类型统计，用于「朱批 N 处」的概览 */
  function stats(edits) {
    const list = edits || [];
    const byType = {};
    list.forEach((e) => {
      const key = TYPES[e.type] ? e.type : 'wording';
      byType[key] = (byType[key] || 0) + 1;
    });
    return {
      total: list.length,
      named: list.filter((e) => e.source === 'model').length,
      byType,
      list: Object.keys(byType).map((k) => ({ type: k, label: TYPES[k].label, mark: TYPES[k].mark, count: byType[k] })),
    };
  }

  /* ── 两段文本对比 ───────────────────────────────────────── */

  /**
   * 改动量占比：被改掉的字数 ÷ 两者中较长的长度。
   * 这不是编辑距离，而是「有多少内容被重写了」的直觉指标，
   * 用来给用户一个「这两稿差多远」的粗略概念，不做精确承诺。
   */
  function similarity(before, after) {
    const a = String(before || '');
    const b = String(after || '');
    const longest = Math.max(a.length, b.length);
    if (!longest || a === b) return 1;
    const edits = diffEdits(a, b);
    const changed = edits.reduce((sum, e) => sum + Math.max(e.before.length, e.after.length), 0);
    return Math.max(0, Math.min(1, 1 - changed / longest));
  }

  /**
   * 对比两段文本：差异条目 + 统计 + 相似度。
   * 复用的是一键优化那套差异引擎，所以「改了哪里」两边口径一致。
   */
  function compare(before, after) {
    const a = String(before || '');
    const b = String(after || '');
    const edits = diffEdits(a, b).map((e, i) =>
      Object.assign({}, e, { id: 'c' + (i + 1), type: inferType(e), reason: '', source: 'diff' })
    );
    return {
      before: a,
      after: b,
      edits,
      stats: stats(edits),
      similarity: similarity(a, b),
      identical: a === b,
      addedChars: edits.reduce((sum, e) => sum + e.after.length, 0),
      removedChars: edits.reduce((sum, e) => sum + e.before.length, 0),
    };
  }

  /* ── 解析模型返回的 JSON ────────────────────────────────── */
  /** 从可能夹带解释的文字里抠出第一个完整的 JSON 对象 */
  function extractJson(raw) {
    const text = String(raw || '').replace(/^\uFEFF/, '');
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1] : text;
    const start = body.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < body.length; i += 1) {
      const ch = body[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(body.slice(start, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }

  /**
   * 把模型的原始回复整理成 {polished, rewrites}。
   * 解析失败也不丢结果：整段回复当润色稿，差异交给 diffEdits 兜底。
   */
  function parseReply(raw, fallbackText) {
    const data = extractJson(raw);
    if (data && typeof data === 'object') {
      const polished = String(
        data.polished || data.result || data.text || data.output || ''
      ).trim();
      const rewrites = data.rewrites || data.edits || data.changes || [];
      if (polished) return { polished, rewrites: Array.isArray(rewrites) ? rewrites : [], parsed: true };
    }
    const plain = String(raw || '').trim();
    if (plain && !/^[\[{]/.test(plain)) return { polished: plain, rewrites: [], parsed: false };
    return { polished: String(fallbackText || ''), rewrites: [], parsed: false };
  }

  return {
    TYPES,
    MAX_EDITS,
    splitSegments,
    diffEdits,
    locate,
    locateRewrites,
    mergeEdits,
    inferType,
    applyEdits,
    renderSpans,
    stats,
    similarity,
    compare,
    extractJson,
    parseReply,
  };
});
