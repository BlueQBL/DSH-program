/*!
 * 三易 · 智能写作台 —— 取数层（api.js）
 *
 * 两种活法，界面不关心用的是哪一种：
 *   服务端模式：走 /api/*，成稿由上游模型或服务端离线引擎产出，留档写在 data/history/
 *   本地模式：直接打开 index.html（file://）时走这里，成稿用浏览器里的离线引擎，留档写 localStorage
 * 两者对外接口形状完全一致，所以 app.js 只写一套逻辑。
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(
    isNode ? require('../lib/modes.js') : root.WriterModes,
    isNode ? require('../lib/polisher.js') : root.WriterPolisher,
    isNode ? require('../lib/mock-writer.js') : root.WriterMock,
    isNode ? require('./core.js') : root.WriterCore
  );
  if (isNode) module.exports = api;
  if (root) root.WriterApi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Modes, Polisher, Mock, Core) {
  'use strict';

  const HEALTH_TIMEOUT = 2500;
  const LOCAL_CHUNK = 6;
  const LOCAL_SPEED = 14;

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'ApiError';
      this.status = status || 0;
    }
  }

  function friendly(err) {
    if (err instanceof ApiError) return err;
    const text = String((err && err.message) || err);
    if (/Failed to fetch|NetworkError|Load failed/i.test(text)) {
      return new ApiError('连不上本地服务：请确认 node server.js 还在运行');
    }
    return new ApiError(text);
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new ApiError('已取消', 0));
          },
          { once: true }
        );
      }
    });
  }

  /* ── 服务端接口 ─────────────────────────────────────────── */
  async function readError(res) {
    let message = `服务端返回 ${res.status}`;
    try {
      const data = await res.json();
      if (data && data.message) message = data.message;
    } catch {
      /* 不是 JSON 就用状态码兜底 */
    }
    return new ApiError(message, res.status);
  }

  /** 解析 SSE 事件流：一帧是「event: x」加若干「data:」行 */
  function parseFrame(frame) {
    let event = 'message';
    const data = [];
    frame.split(/\r?\n/).forEach((line) => {
      if (line.startsWith(':')) return;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    });
    let payload = null;
    if (data.length) {
      try {
        payload = JSON.parse(data.join('\n'));
      } catch {
        payload = null;
      }
    }
    return { event, payload };
  }

  function createServerApi(health) {
    const base = '';

    async function getJson(url) {
      const res = await fetch(base + url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw await readError(res);
      return res.json();
    }

    return {
      kind: 'server',
      info: health,
      base,

      /** 起稿：SSE 逐字推进，多个版本并行 */
      async generate(params, material, handlers, signal, model) {
        const res = await fetch(base + '/api/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ params: Modes.normalizeParams(params), material, model: model || undefined }),
          signal,
        }).catch((err) => {
          throw friendly(err);
        });
        if (!res.ok) throw await readError(res);
        if (!res.body) throw new ApiError('服务端没有返回内容流');

        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let final = null;

        const dispatch = (frame) => {
          const { event, payload } = parseFrame(frame);
          if (!payload) return;
          if (event === 'meta' && handlers.onMeta) handlers.onMeta(payload);
          else if (event === 'delta' && handlers.onDelta) handlers.onDelta(payload.version, payload.text);
          else if (event === 'version-note' && handlers.onVersionNote) handlers.onVersionNote(payload);
          else if (event === 'done') final = payload;
          else if (event === 'fatal') throw new ApiError(payload.message || '生成失败');
        };

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            dispatch(buffer.slice(0, cut));
            buffer = buffer.slice(cut + 2);
          }
        }
        if (buffer.trim()) dispatch(buffer);
        if (!final) throw new ApiError('连接中断，这一批没有生成完');
        if (handlers.onDone) handlers.onDone(final);
        return final;
      },

      async polish(text, opts) {
        const res = await fetch(base + '/api/polish', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, focus: (opts && opts.focus) || '', model: (opts && opts.model) || undefined }),
        }).catch((err) => {
          throw friendly(err);
        });
        if (!res.ok) throw await readError(res);
        return res.json();
      },

      /** 模型下拉框的数据源 */
      async models(refresh) {
        return getJson('/api/models' + (refresh ? '?refresh=1' : ''));
      },

      async testEngine() {
        return getJson('/api/engine/test');
      },

      history: {
        async list(opts) {
          const o = opts || {};
          const q = new URLSearchParams();
          if (o.mode) q.set('mode', o.mode);
          if (o.q) q.set('q', o.q);
          if (o.starred) q.set('starred', '1');
          if (o.limit) q.set('limit', String(o.limit));
          if (o.offset) q.set('offset', String(o.offset));
          return getJson('/api/history?' + q.toString());
        },
        async get(id) {
          const data = await getJson('/api/history/' + encodeURIComponent(id));
          return data.record;
        },
        async create(record) {
          const res = await fetch(base + '/api/history', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ record }),
          });
          if (!res.ok) throw await readError(res);
          return (await res.json()).record;
        },
        async update(id, patch) {
          const res = await fetch(base + '/api/history/' + encodeURIComponent(id), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          });
          if (res.status === 404) return null;
          if (!res.ok) throw await readError(res);
          return (await res.json()).record;
        },
        async remove(id) {
          const res = await fetch(base + '/api/history/' + encodeURIComponent(id), { method: 'DELETE' });
          if (res.status === 404) return false;
          if (!res.ok) throw await readError(res);
          return true;
        },
        async clear() {
          const res = await fetch(base + '/api/history?confirm=1', { method: 'DELETE' });
          if (!res.ok) throw await readError(res);
          return (await res.json()).removed || 0;
        },
        async count() {
          const data = await getJson('/api/health');
          return (data.history && data.history.count) || 0;
        },
        async exportAll(format, opts) {
          const o = opts || {};
          const q = new URLSearchParams({ format: format || 'md' });
          if (o.mode) q.set('mode', o.mode);
          if (o.q) q.set('q', o.q);
          if (o.starred) q.set('starred', '1');
          const res = await fetch(base + '/api/history/export?' + q.toString());
          if (!res.ok) throw await readError(res);
          const body = await res.text();
          const ext = format === 'json' ? 'json' : format === 'txt' ? 'txt' : 'md';
          return {
            ext,
            mime: format === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
            body,
          };
        },
      },
    };
  }

  /* ── 本地模式：没有服务端也能全功能跑起来 ────────────────── */
  function createLocalApi(win, note) {
    const storage = win.localStorage;
    const history = Core.createLocalStore(storage);

    return {
      kind: 'local',
      info: {
        ok: true,
        engine: { live: false, model: '离线引擎', note: note || '未连接本地服务，正在用浏览器内的离线引擎成稿' },
      },
      base: '',

      async generate(params, material, handlers, signal) {
        const resolved = Modes.normalizeParams(params);
        const mode = Modes.getMode(resolved.mode);
        const plan = [];
        for (let i = 0; i < resolved.versions; i += 1) {
          const angle = Modes.angleOf(mode, i);
          plan.push({ index: i, angleId: angle.id, angleLabel: angle.label });
        }
        const started = Date.now();
        if (handlers.onMeta) {
          handlers.onMeta({
            engine: 'offline',
            engineNote: this.info.engine.note,
            model: '离线引擎',
            mode: resolved.mode,
            params: resolved,
            versions: plan,
          });
        }

        // 逐字上屏，节奏与真实模型一致，界面上看不出区别
        const texts = plan.map((p) => Mock.compose(resolved, material, p.index));
        const sent = plan.map(() => 0);
        let alive = true;
        while (alive) {
          alive = false;
          for (let i = 0; i < plan.length; i += 1) {
            const full = texts[i];
            if (sent[i] >= full.length) continue;
            alive = true;
            const piece = full.slice(sent[i], sent[i] + LOCAL_CHUNK);
            sent[i] += LOCAL_CHUNK;
            if (handlers.onDelta) handlers.onDelta(plan[i].index, piece);
          }
          // 一轮睡一次：多稿并行推进，而不是一稿写完再写下一稿
          if (alive && LOCAL_SPEED > 0) await sleep(LOCAL_SPEED, signal);
        }

        const versions = plan.map((p, i) => ({
          index: p.index,
          angleId: p.angleId,
          angleLabel: p.angleLabel,
          text: texts[i],
          chars: texts[i].length,
          engine: 'offline',
        }));
        const done = { elapsedMs: Date.now() - started, versions, failed: [], engine: 'offline' };
        if (handlers.onDone) handlers.onDone(done);
        return done;
      },

      async polish(text) {
        const out = Mock.polish(text) || { polished: text, rewrites: [] };
        const edits = Polisher.mergeEdits(text, out.rewrites || [], out.polished || text);
        const stat = Polisher.stats(edits);
        return {
          ok: true,
          engine: 'offline',
          note: '',
          before: text,
          polished: out.polished || text,
          edits,
          stats: stat,
          changed: stat.total > 0,
        };
      },

      async testEngine() {
        return { ok: true, engine: 'offline', message: this.info.engine.note, model: '离线引擎' };
      },

      /** 本地模式没有上游，模型框只显示「离线引擎」 */
      async models() {
        return {
          ok: true,
          live: false,
          engine: 'offline',
          default: '',
          current: '离线引擎',
          models: [],
          total: 0,
          note: this.info.engine.note,
        };
      },

      history,
    };
  }

  /**
   * 探活：同源 /api/health 能通就用服务端，否则退回本地模式。
   * 直接双击 index.html 打开时 fetch 会失败，正好落到本地模式，不必额外判断协议。
   */
  async function detect(win) {
    const w = win || (typeof window !== 'undefined' ? window : null);
    if (w && w.location && w.location.protocol === 'file:') {
      return createLocalApi(w, '正在以文件方式打开，用浏览器内的离线引擎成稿，留档存在本机浏览器里');
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT);
      const res = await fetch('/api/health', { signal: ctrl.signal, headers: { accept: 'application/json' } });
      clearTimeout(timer);
      if (!res.ok) throw new Error('health ' + res.status);
      const health = await res.json();
      return createServerApi(health);
    } catch {
      return createLocalApi(
        w || { localStorage: memoryStorage() },
        '没找到本地服务（node server.js），已切到浏览器内的离线引擎'
      );
    }
  }

  /** 连 localStorage 都没有时的兜底，保证界面不崩 */
  function memoryStorage() {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => void map.set(k, String(v)),
      removeItem: (k) => void map.delete(k),
    };
  }

  return {
    ApiError,
    detect,
    createServerApi,
    createLocalApi,
    memoryStorage,
    parseFrame,
    LOCAL_SPEED,
    LOCAL_CHUNK,
  };
});
