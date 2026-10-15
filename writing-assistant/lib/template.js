/*!
 * 三易 · 智能写作台 —— 自定义模板（template.js）
 *
 * 「一个模板长什么样」只在这里定义：服务端落盘、浏览器本地存、跑测试都用它。
 * 纯函数，浏览器与 Node 共用。
 *
 * 模板不发明新的写作流程：它只是把「系统提示词」和几个字段交给用户自己写，
 * 运行时被 Modes.buildCustomMode() 包装成一个和内置板块同形的板块。
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(
    isNode ? require('./modes.js') : root.WriterModes,
    isNode ? require('./record.js') : root.WriterRecord
  );
  if (isNode) module.exports = api;
  if (root) root.WriterTemplate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Modes, Record) {
  'use strict';

  const L = Modes.LIMITS;

  function clip(text, max) {
    return Record.clip(text, max);
  }

  /**
   * 收敛任意来源的模板数据。
   * 用户可能在表单里只填了一半，也可能直接打接口传了个奇怪的 JSON，都要挡在这里。
   */
  function normalizeTemplate(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const name = clip(String(input.name || '').trim() || '未命名模板', L.templateNameMax);
    const system = clip(String(input.system || '').trim(), L.templateSystemMax);
    const now = Record.nowIso();
    return {
      id: /^[A-Za-z0-9_-]{3,40}$/.test(String(input.id || '')) ? String(input.id) : makeTemplateId(),
      name,
      mark: clip(String(input.mark || '').trim() || name.charAt(0), 1) || '自',
      tagline: clip(String(input.tagline || '').trim(), L.templateTitleMax),
      system,
      outputHint: clip(String(input.outputHint || '').trim(), L.templateNoteMax),
      // 示例素材：空稿纸下面那两条可点的示例。作者不写就按提示词里的结构自动推一个。
      example: clip(String(input.example || '').trim(), L.templateExampleMax),
      inputLabel: clip(String(input.inputLabel || '').trim(), 20),
      placeholder: clip(String(input.placeholder || '').trim(), 200),
      inputHint: clip(String(input.inputHint || '').trim(), 80),
      noteLabel: clip(String(input.noteLabel || '').trim(), 20),
      createdAt: input.createdAt || now,
      updatedAt: input.updatedAt || input.createdAt || now,
    };
  }

  function makeTemplateId() {
    return 't_' + Date.now().toString(36) + '_' + Record.randomSuffix();
  }

  /** 表单校验：只拦真正会让模板不可用的问题，其余给默认值（稿签多打了字就截成一个） */
  function validateTemplate(raw) {
    const t = normalizeTemplate(raw);
    if (!String(raw && raw.name ? raw.name : '').trim()) return { ok: false, field: 'name', message: '给模板起个名字' };
    if (t.name.length < 2) return { ok: false, field: 'name', message: '名字至少两个字' };
    if (!t.system) return { ok: false, field: 'system', message: '提示词不能为空——这是模板的核心' };
    if (t.system.length < 10) return { ok: false, field: 'system', message: '提示词太短了，至少写清「你是谁、要写什么、不要写什么」' };
    return { ok: true, template: t };
  }

  /** 列表里显示的一行说明 */
  function describeTemplate(t) {
    const parts = [];
    if (t.tagline) parts.push(t.tagline);
    parts.push('提示词 ' + t.system.length + ' 字');
    if (t.outputHint) parts.push('有输出要求');
    return parts.join(' · ');
  }

  /** 模板 → 交给提示词构建器的规格（只挑它需要的字段，避免把整个记录塞进请求） */
  function toPromptSpec(t) {
    const tpl = normalizeTemplate(t);
    return {
      id: tpl.id,
      name: tpl.name,
      system: tpl.system,
      outputHint: tpl.outputHint,
      inputLabel: tpl.inputLabel,
    };
  }

  /** 服务端/浏览器都需要的分页与筛选 */
  function matchesTemplate(t, opts) {
    const o = opts || {};
    const q = String(o.q || '').trim().toLowerCase();
    if (!q) return true;
    return [t.name, t.tagline, t.system, t.outputHint].join('\n').toLowerCase().indexOf(q) >= 0;
  }

  function sortTemplates(list) {
    return (list || []).slice().sort((a, b) => {
      const byUpdated = String(b.updatedAt).localeCompare(String(a.updatedAt));
      if (byUpdated !== 0) return byUpdated;
      return String(b.id).localeCompare(String(a.id));
    });
  }

  function summarize(t) {
    return {
      id: t.id,
      name: t.name,
      mark: t.mark,
      tagline: t.tagline,
      modeId: Modes.templateModeId(t.id),
      systemChars: t.system.length,
      hasOutputHint: Boolean(t.outputHint),
      hasExample: Boolean(t.example),
      updatedAt: t.updatedAt,
      excerpt: clip(t.system.replace(/\s+/g, ' '), 60),
    };
  }

  return {
    LIMITS: {
      name: L.templateNameMax,
      system: L.templateSystemMax,
      outputHint: L.templateNoteMax,
      count: L.templatesMax,
    },
    normalizeTemplate,
    makeTemplateId,
    validateTemplate,
    describeTemplate,
    toPromptSpec,
    matchesTemplate,
    sortTemplates,
    summarize,
  };
});
