/*!
 * 蓝晒 · AI 图片生成器 —— 取数层（api.js）
 *
 * 只做一件事：把这个服务端暴露的几个接口包成函数，并把错误统一成
 * 带中文 message 的 ApiError —— 界面层不需要知道 HTTP 状态码怎么翻译。
 */
(function (root) {
  'use strict';

  class ApiError extends Error {
    constructor(message, status, code) {
      super(message);
      this.name = 'ApiError';
      this.status = status || 0;
      this.code = code || '';
    }
  }

  async function toPayload(res) {
    let data = null;
    try {
      const text = await res.text();
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const message = (data && data.message) || `服务端返回 ${res.status}`;
      throw new ApiError(message, res.status, (data && data.code) || '');
    }
    if (!data || typeof data !== 'object') {
      throw new ApiError('服务端返回的内容看不懂（不是 JSON）', res.status);
    }
    return data;
  }

  async function request(path, options) {
    let res;
    try {
      res = await fetch(path, options);
    } catch {
      throw new ApiError('连不上本地服务：确认 node server.js 还在运行');
    }
    return toPayload(res);
  }

  function postJson(path, body) {
    return request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  }

  root.LanShai = {
    ApiError,

    health: () => request('/api/health'),
    presets: () => request('/api/presets'),
    models: (refresh) => request('/api/models' + (refresh ? '?refresh=1' : '')),
    verifyModel: (model) => postJson('/api/models', { model }),
    optimize: (payload) => postJson('/api/prompt/optimize', payload),
    generate: (payload) => postJson('/api/images/generate', payload),

    history: {
      list(opts) {
        const o = opts || {};
        const q = new URLSearchParams();
        if (o.q) q.set('q', o.q);
        if (o.limit) q.set('limit', String(o.limit));
        if (o.offset) q.set('offset', String(o.offset));
        const suffix = q.toString() ? '?' + q.toString() : '';
        return request('/api/history' + suffix);
      },
      get: (id) => request('/api/history/' + encodeURIComponent(id)),
      remove: (id) => request('/api/history/' + encodeURIComponent(id), { method: 'DELETE' }),
      clear: () => request('/api/history?confirm=1', { method: 'DELETE' }),
    },

    imageUrl: (file) => '/api/images/' + encodeURIComponent(file),
    downloadUrl: (id) => '/api/history/' + encodeURIComponent(id) + '/download',
  };
})(typeof window !== 'undefined' ? window : globalThis);
