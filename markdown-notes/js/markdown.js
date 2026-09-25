/*!
 * 校样 · Markdown 解析与语法高亮（markdown.js）
 *
 * 纯逻辑，不碰 DOM：浏览器挂到 window.MDMarkdown，Node 走 module.exports。
 *
 * 安全策略：只认 Markdown。原文里的 HTML 一律转义（不做 raw HTML 透传），
 *          链接协议走白名单（http/https/mailto/#/相对路径），图片只认绝对
 *          URL 或"当前笔记图库"里的文件名。笔记存在 LocalStorage 里，
 *          可能被手工改过，所以渲染侧必须自己兜底。
 *
 * 块级元素带 data-line / data-end（1 基，含首含尾），
 * 供界面做"光标 ↔ 预览"双向定位，这是本应用的核心交互。
 * 标题另外带 id（sec-N 或自定义锚点），供目录导航与站内跳转使用。
 *
 * Markdown 风格（flavor）决定开哪些扩展语法，见 FLAVORS。
 */
(function (root, factory) {
  const mathApi = typeof module === 'object' && module.exports
    ? require('./mathml.js')
    : (root && root.MDMath ? root.MDMath : null);
  const api = factory(mathApi);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MDMarkdown = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (mathApi) {
  'use strict';

  /* ------------------------------------------------------------------ 转义 */

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeAttr(text) {
    return escapeHtml(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const SAFE_URL = /^(?:https?:|mailto:|tel:|#|\/|\.{1,2}\/)/i;

  /** 链接白名单：挡掉 javascript: / data: 这类能把笔记变成 XSS 载体的协议。 */
  function safeUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(raw)) return 'mailto:' + raw;
    if (SAFE_URL.test(raw)) return raw;
    return /:/.test(raw) ? '' : raw;
  }

  /** 站内锚点（#sec-1 / #fn-2）：界面要拦下来自己滚动，不要改地址栏 */
  function isAnchor(url) {
    return /^#[A-Za-z][\w:-]*$/.test(String(url || ''));
  }

  /**
   * 整篇正文是不是被**一层围栏**包住了？
   *
   * 从 AI 对话里复制内容时特别常见：外面套着 ```md … ```，
   * 于是整篇文章在印张上变成一个代码块，看起来"正文不见了"。
   * 这里只做识别，不改用户的内容——由界面出一个"拆掉外层围栏"的按钮，
   * 让人自己决定（静默改写用户的原文是不能接受的）。
   *
   * @returns {{fence:string, info:string, inner:string, indent:string}|null}
   */
  function detectWrappingFence(src) {
    const text = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
    const open = text.match(/^([ \t]*)(`{3,}|~{3,})[ \t]*([^\n`]*)\n/);
    if (!open) return null;

    const fence = open[2];
    const closer = new RegExp('\\n' + fence[0] + '{' + fence.length + ',}[ \\t]*[ \\t]*$');
    if (!closer.test(text.replace(/\s+$/, ''))) return null;

    const body = text.replace(/\s+$/, '');
    const endAt = body.length - body.match(new RegExp(fence[0] + '{' + fence.length + ',}[ \\t]*$'))[0].length;
    const inner = body.slice(open[0].length, endAt);

    // 里面还套着别的围栏时不算"整篇被包住"，别乱拆
    const innerFence = new RegExp('^[ \\t]*' + fence[0] + '{' + fence.length + ',}', 'm');
    if (innerFence.test(inner)) return null;

    return {
      fence: fence,
      info: open[3].trim(),
      indent: open[1],
      inner: inner.replace(/\n$/, ''),
    };
  }

  /* ------------------------------------------------------------ 风格开关 */

  const GFM_FLAGS = {
    tables: true,
    taskLists: true,
    strikethrough: true,
    autolinks: true,
    footnotes: true,
    math: true,
    lenientHeadings: true,
    attrIds: true,
  };

  const FLAVORS = {
    gfm: {
      label: 'GitHub 风格',
      hint: 'GFM 那套（表格 / 任务清单 / 删除线 / 裸链接）再加脚注与公式，跟大多数编辑器互通',
      flags: Object.assign({}, GFM_FLAGS),
    },
    commonmark: {
      label: '标准风格',
      hint: '只认 CommonMark 核心语法：井号后必须有空格，贴到别的严格解析器里不会变形',
      flags: {},
    },
    paper: {
      label: '论文风格',
      hint: '脚注、公式、表格，标题自动编号、图片自动编号并配图注；不要任务清单那类随手记语法',
      flags: {
        tables: true,
        footnotes: true,
        math: true,
        autolinks: true,
        attrIds: true,
        lenientHeadings: true,
        subSup: true,
        headingNumbering: true,
        figureNumbering: true,
      },
    },
    chinese: {
      label: '中文写作',
      hint: 'GitHub 风格 + 中英之间自动留白、单换行即换行',
      flags: Object.assign({}, GFM_FLAGS, { cjkSpacing: true, hardWrap: true }),
    },
    extended: {
      label: '全扩展',
      hint: 'GitHub 风格 + ==高亮==、^上标^ ~下标~、定义列表、标题与图编号，全都打开',
      flags: Object.assign({}, GFM_FLAGS, {
        highlight: true,
        subSup: true,
        definitionLists: true,
        headingNumbering: true,
        figureNumbering: true,
      }),
    },
  };

  const FEATURES = [
    { key: 'tables', label: '表格', sample: '| a | b |' },
    { key: 'taskLists', label: '任务清单', sample: '- [x] 做完的' },
    { key: 'strikethrough', label: '删除线', sample: '~~删掉~~' },
    { key: 'autolinks', label: '裸链接', sample: 'https://a.dev' },
    { key: 'footnotes', label: '脚注', sample: '文字[^1]' },
    { key: 'math', label: '数学公式', sample: '$e^{i\\pi}$' },
    { key: 'lenientHeadings', label: '井号后可不空格', sample: '#标题' },
    { key: 'attrIds', label: '标题自定义锚点', sample: '## 标题 {#id}' },
    { key: 'headingNumbering', label: '标题自动编号', sample: '## 1.2 方法' },
    { key: 'figureNumbering', label: '图片自动编号', sample: '图 1　架构图' },
    { key: 'cjkSpacing', label: '中英之间留白', sample: '用 React 写' },
    { key: 'hardWrap', label: '单换行即换行', sample: '回车就断行' },
    { key: 'highlight', label: '高亮', sample: '==重点==' },
    { key: 'subSup', label: '上下标', sample: 'H~2~O / x^2^' },
    { key: 'definitionLists', label: '定义列表', sample: '术语\\n: 解释' },
  ];

  const DEFAULT_FLAVOR = 'gfm';

  function flavorFlags(name, extra) {
    const preset = FLAVORS[name] ? name : DEFAULT_FLAVOR;
    return Object.assign({}, FLAVORS[preset].flags, extra || {});
  }

  function flavorList() {
    return Object.keys(FLAVORS).map(function (key) {
      return {
        value: key,
        label: FLAVORS[key].label,
        hint: FLAVORS[key].hint,
        flags: Object.keys(FLAVORS[key].flags),
      };
    });
  }

  /* -------------------------------------------------------------- 运行选项 */

  function normalizeOptions(opts) {
    const o = opts || {};
    return {
      name: FLAVORS[o.flavor] ? o.flavor : DEFAULT_FLAVOR,
      flavor: flavorFlags(o.flavor, o.flags),
      resolveImage: typeof o.resolveImage === 'function' ? o.resolveImage : null,
      headingCount: 0,
      usedIds: Object.create(null),
      sectionCounters: [0, 0, 0, 0, 0, 0], // 论文风格的标题编号（1 / 1.1 / 1.1.1）
      figureCount: 0,                     // 论文风格的图编号
    };
  }

  /** 当前这次渲染的选项。render() 是同步的，用模块级变量最省事。 */
  let OPT = normalizeOptions();

  const F = function (key) { return Boolean(OPT.flavor[key]); };

  /* -------------------------------------------------------------- 行内解析 */

  const CODE_TOKEN = '\u0000';

  /**
   * 行内 Markdown → HTML。
   * 顺序很要紧：先摘出行内代码和公式（避免其中内容被后续规则误伤），再转义，
   * 再做链接/强调，最后把代码与公式放回去。
   */
  function renderInline(text) {
    const codes = [];
    let s = String(text == null ? '' : text);

    // 行内代码：反引号数量必须配对，CommonMark 规定首尾各去一个空格
    s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, function (_m, _t, body) {
      codes.push({ kind: 'code', tex: body.replace(/^ ([\s\S]*) $/, '$1') });
      return CODE_TOKEN + (codes.length - 1) + '\u0001';
    });

    // 行内公式：$...$。两侧不贴空白，否则 "$5 和 $6" 会被误判成公式；
    // 开头的 $ 前面有反斜杠就是转义（\$5 显示成 $5），不能当成公式起点
    if (F('math')) {
      s = s.replace(/(?<!\\)\$(?!\s)([^\$\n]+?)(?<![\s\\])\$/g, function (all, body) {
        if (all.indexOf(CODE_TOKEN) >= 0) return all;
        codes.push({ kind: 'math', tex: body });
        return CODE_TOKEN + (codes.length - 1) + '\u0001';
      });
      s = s.replace(/\\\$/g, '$');
    }

    s = escapeHtml(s);

    // 图片 → 链接 → 尖括号自动链接 → 裸链接
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^"]*)&quot;)?\)/g, function (_m, alt, src, title) {
      return imageTag(src, alt, title);
    });

    s = s.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^"]*)&quot;)?\)/g, function (_m, label, href, title) {
      const url = safeUrl(href);
      if (!url) return label;
      return (
        '<a href="' + escapeAttr(url) + '"' +
        (title ? ' title="' + escapeAttr(title) + '"' : '') +
        (isAnchor(url) ? '' : ' target="_blank" rel="noopener noreferrer"') +
        '>' + label + '</a>'
      );
    });

    s = s.replace(/&lt;((?:https?|mailto):[^\s&]+)&gt;/g, function (m, url) {
      const href = safeUrl(url);
      return href
        ? '<a href="' + escapeAttr(href) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(url) + '</a>'
        : m;
    });

    if (F('autolinks')) {
      s = s.replace(/(^|[\s(（])(https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?，。；：！？])/g, function (_m, lead, url) {
        return lead + '<a href="' + escapeAttr(safeUrl(url) || url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(url) + '</a>';
      });
    }

    // 脚注引用：编号按出现顺序给
    if (F('footnotes')) {
      s = s.replace(/\[\^([^\]\s]+)\]/g, function (_m, label) {
        return footnoteRef(label);
      });
    }

    // 强调。每组都写成"末尾可选"，否则 **单字** 这种两边定界符夹一个字的情况会漏
    s = s.replace(/\*\*([^\s*](?:[\s\S]*?[^\s*])?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w])__([^\s_](?:[\s\S]*?[^\s_])?)__(?!\w)/g, '$1<strong>$2</strong>');
    s = s.replace(/(^|[^*\w])\*([^\s*](?:[^*]*[^\s*])?)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_([^\s_](?:[^_]*[^\s_])?)_(?![\w_])/g, '$1<em>$2</em>');

    if (F('strikethrough')) {
      s = s.replace(/~~([^\s~](?:[^~]*[^\s~])?)~~/g, '<del>$1</del>');
    }

    if (F('highlight')) {
      s = s.replace(/==([^\s=](?:[^=]*[^\s=])?)==/g, '<mark class="md-mark">$1</mark>');
    }

    if (F('subSup')) {
      s = s.replace(/\^([^\s^](?:[^\^\n]*?[^\s^])?)\^/g, '<sup class="md-sup">$1</sup>');
      // 下标：只在"不像数值区间"的时候生效——5~10 这种范围不能变成下标
      s = s.replace(/(^|[^\s~])~([^\s~]{1,12})~(?!~)/g, function (all, lead, body) {
        const before = lead.slice(-1);
        if (/[0-9]/.test(before) && /^[0-9]/.test(body)) return all;
        if (body.indexOf('\\') >= 0) return all;
        return lead + '<sub class="md-sub">' + body + '</sub>';
      });
    }

    // 硬换行：行尾两个空格，或反斜杠
    s = s.replace(/(?: {2,}|\\)\n/g, '<br>\n');

    // 放回行内代码与公式
    s = s.replace(/\u0000(\d+)\u0001/g, function (_m, n) {
      const item = codes[Number(n)];
      if (!item) return '';
      if (item.kind === 'code') return '<code class="md-code">' + escapeHtml(item.tex) + '</code>';
      return mathHtml(item.tex, false);
    });

    if (F('cjkSpacing')) s = applyCjkSpacing(s);

    return s;
  }

  /** 图片：绝对地址直接用；相对地址去"当前笔记的图库"里找，找不到就明说 */
  function imageTag(src, alt, title) {
    const raw = String(src || '').trim();
    const titleAttr = title ? ' title="' + escapeAttr(title) + '"' : '';
    const altAttr = ' alt="' + escapeAttr(alt || '') + '"';

    if (/^(?:https?:)?\/\//i.test(raw)) {
      const url = safeUrl(raw);
      if (!url) return escapeHtml(alt || raw);
      return '<img src="' + escapeAttr(url) + '"' + altAttr + titleAttr + ' loading="lazy" referrerpolicy="no-referrer">';
    }
    if (/^data:image\//i.test(raw)) {
      return '<img src="' + escapeAttr(raw) + '"' + altAttr + titleAttr + '>';
    }

    const resolved = OPT.resolveImage ? OPT.resolveImage(raw) : null;
    if (resolved) {
      return '<img src="' + escapeAttr(resolved) + '"' + altAttr + titleAttr +
        ' data-src="' + escapeAttr(raw) + '" loading="lazy">';
    }
    const name = raw.split('/').pop() || raw;
    // undefined = 图库还没读完（异步的），先占个位，别急着说"没有"
    if (resolved === undefined) {
      return (
        '<span class="md-img-loading" data-src="' + escapeAttr(raw) + '">' +
        '<span class="md-img-loading__name">' + escapeHtml(name) + '</span>' +
        '<span class="md-img-loading__hint">正在取图…</span>' +
        '</span>'
      );
    }
    return (
      '<span class="md-img-missing" data-src="' + escapeAttr(raw) + '" title="这篇笔记的图库里没有「' +
      escapeAttr(raw) + '」">' +
      '<span class="md-img-missing__name">' + escapeHtml(name) + '</span>' +
      '<span class="md-img-missing__hint">图库里没有这张图</span>' +
      '</span>'
    );
  }

  /** 数学：TeX → MathML。解析不了就退回显示原始 TeX，不装作渲染成功。 */
  function mathHtml(tex, display) {
    const source = String(tex == null ? '' : tex);
    if (!mathApi) {
      return '<code class="md-math-bad" title="公式模块没加载">' + escapeHtml(source) + '</code>';
    }
    let result;
    try {
      result = mathApi.texToMathML(source, { display: Boolean(display) });
    } catch (err) {
      return '<code class="md-math-bad" title="公式解析出错">' + escapeHtml(source) + '</code>';
    }
    if (!result.ok) {
      return '<code class="md-math-bad" title="公式没解析成功，先按原文显示">' + escapeHtml(source) + '</code>';
    }
    if (!result.unknown.length) return result.html;
    return result.html.replace(
      '<math ',
      '<math data-unknown="' + escapeAttr(result.unknown.join(' ')) + '" ' +
      'title="有 ' + result.unknown.length + ' 处写法没认出来：' +
      escapeAttr(result.unknown.map(function (u) { return '\\' + u; }).join(' ')) + '" '
    );
  }

  /* ------------------------------------------------------------ 中文排版 */

  const CJK_RANGE = '\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af';
  // 只在"本来就挨着"的地方补空隙；写了空格的地方不再重复加
  const CJK_BEFORE = new RegExp('([' + CJK_RANGE + '])([A-Za-z0-9])', 'g');
  const CJK_AFTER = new RegExp('([A-Za-z0-9])([' + CJK_RANGE + '])', 'g');

  /** 中英之间补一点空隙：插一个不占文字的空 span，复制出去的文本还是干净的 */
  function spaceText(text) {
    return String(text)
      .replace(CJK_BEFORE, '$1<span class="cjk-gap"></span>$2')
      .replace(CJK_AFTER, '$1<span class="cjk-gap"></span>$2');
  }

  /**
   * 只对"标签外面"的文字下手：代码、公式、属性里不能插东西。
   * 文本里的尖括号早就转义成 &lt; 了，所以按标签切分是安全的。
   */
  function applyCjkSpacing(html) {
    const re = /<\/?([a-zA-Z][\w-]*)[^>]*>/g;
    let out = '';
    let last = 0;
    let skip = false;
    let m;
    while ((m = re.exec(html)) !== null) {
      const text = html.slice(last, m.index);
      if (text) out += skip ? text : spaceText(text);
      const name = m[1].toLowerCase();
      const closing = m[0][1] === '/';
      if (name === 'code' || name === 'mtext' || name === 'math') skip = !closing;
      out += m[0];
      last = re.lastIndex;
    }
    const rest = html.slice(last);
    return out + (rest ? (skip ? rest : spaceText(rest)) : '');
  }

  /* ------------------------------------------------------------ 块级识别表 */

  function indentWidth(line) {
    let n = 0;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === ' ') n += 1;
      else if (line[i] === '\t') n += 4 - (n % 4);
      else break;
    }
    return n;
  }

  const RE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`]*)$/;
  const RE_HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
  const RE_HEADING = /^ {0,3}(#{1,6})([ \t]*)(.*)$/;
  const RE_QUOTE = /^ {0,3}>[ \t]?(.*)$/;
  const RE_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/;
  const RE_TASK = /^\[([ xX])\][ \t]+([\s\S]*)$/;
  const RE_TABLE_DELIM = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
  const RE_MATH_OPEN = /^ {0,3}\$\$(.*)$/;
  const RE_FN_DEF = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/;
  const RE_DEF_MARK = /^ {0,3}:[ \t]+(.*)$/;
  const RE_ATTR_ID = /\s*\{#([A-Za-z][\w:-]*)\}\s*$/;

  function matchItem(line) {
    const m = line.match(RE_ITEM);
    if (!m) return null;
    const indent = indentWidth(m[1]);
    const text = m[4];
    let contentIndent;
    if (text) contentIndent = line.indexOf(text);
    else contentIndent = indent + m[2].length + 1;
    return {
      indent: indent,
      ordered: /\d/.test(m[2][0]),
      number: /^\d/.test(m[2]) ? parseInt(m[2], 10) : 0,
      text: text,
      contentIndent: contentIndent,
    };
  }

  /**
   * 井号后面算不算标题文字。
   * 严格 CommonMark：井号后必须有空格（或直接行尾）。
   * 宽松（默认，照顾中文写法）：井号后不空格也认，只要后面不是另一个井号。
   */
  function isHeadingText(spaces, text) {
    if (text === undefined || text === null) return false;
    if (F('lenientHeadings')) return !/^#/.test(text) && text.trim() !== '';
    return spaces.length > 0 || text === '';
  }

  function isBlockStart(line) {
    if (RE_FENCE.test(line) || RE_HR.test(line) || RE_QUOTE.test(line)) return true;
    if (F('math') && RE_MATH_OPEN.test(line)) return true;
    if (matchItem(line)) return true;
    const h = line.match(RE_HEADING);
    return Boolean(h && isHeadingText(h[2], h[3]));
  }

  function isTableDelim(line) {
    return line.indexOf('|') >= 0 && RE_TABLE_DELIM.test(line.trim()) && /-/.test(line);
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = [];
    let buf = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && s[i + 1] === '|') { buf += '|'; i++; continue; }
      if (s[i] === '|') { cells.push(buf.trim()); buf = ''; continue; }
      buf += s[i];
    }
    cells.push(buf.trim());
    return cells;
  }

  function alignOf(delim) {
    return delim.startsWith(':') && delim.endsWith(':') ? 'center' : delim.endsWith(':') ? 'right' : delim.startsWith(':') ? 'left' : '';
  }

  /* ---------------------------------------------------------------- 脚注 */

  /**
   * 脚注定义在解析正文前先扫一遍摘出来，同时把那些行清空——
   * 行数不变，所以 data-line 行号不会错位。
   * 正文里遇到 [^label] 时按出现顺序编号，跟常见的脚注实现一致。
   */
  function createFootnoteState() {
    return { defs: new Map(), order: [], used: new Map(), missing: [], firstLine: 0, lastLine: 0 };
  }

  let FN = createFootnoteState();

  function collectFootnoteDefs(lines) {
    const defs = new Map();
    let firstLine = 0;
    let lastLine = 0;
    let i = 0;

    while (i < lines.length) {
      const m = lines[i].match(RE_FN_DEF);
      if (!m) { i += 1; continue; }
      const label = m[1];
      const start = i;
      const body = [m[2]];
      const end = { value: start + 1 };
      lines[i] = '';
      i += 1;

      while (i < lines.length) {
        const cur = lines[i];
        if (/^[ \t]*$/.test(cur)) {
          const next = lines[i + 1];
          if (next && indentWidth(next) >= 2) { body.push(''); lines[i] = ''; i += 1; continue; }
          break;
        }
        if (indentWidth(cur) < 2) break;
        body.push(cur.replace(/^ {1,4}/, ''));
        lines[i] = '';
        i += 1;
      }
      end.value = start + body.length;

      if (!defs.has(label)) {
        defs.set(label, { label: label, line: start + 1, end: end.value, body: body });
      }
      firstLine = firstLine || start + 1;
      lastLine = Math.max(lastLine, end.value);
    }

    return { defs: defs, firstLine: firstLine, lastLine: lastLine };
  }

  function footnoteRef(label) {
    const key = String(label);
    if (!FN.defs.has(key)) {
      if (FN.missing.indexOf(key) < 0) FN.missing.push(key);
      return (
        '<sup class="fn-ref is-missing" title="没有找到脚注定义 [^' + escapeAttr(key) + ']">' +
        '<span class="fn-ref__mark">?</span></sup>'
      );
    }
    let number = FN.used.get(key);
    if (!number) {
      FN.order.push(key);
      number = FN.order.length;
      FN.used.set(key, number);
    }
    return (
      '<sup class="fn-ref" id="fnref-' + escapeAttr(key) + '">' +
      '<a href="#fn-' + escapeAttr(key) + '" data-footnote="' + escapeAttr(key) + '">' + number + '</a>' +
      '</sup>'
    );
  }

  function renderFootnotes() {
    const labels = FN.order.slice();
    FN.defs.forEach(function (rec, key) {
      if (labels.indexOf(key) < 0) labels.push(key);
    });
    if (!labels.length) return '';

    const items = labels.map(function (key) {
      const rec = FN.defs.get(key);
      const used = FN.used.has(key);
      const body = rec.body.length > 1
        ? parseBlocks(rec.body, rec.line - 1, { nested: true })
        : renderInline(rec.body[0]);
      return (
        '<li id="fn-' + escapeAttr(key) + '" data-line="' + rec.line + '" data-end="' + rec.end + '"' +
        (used ? '' : ' class="is-unused"') + '>' +
        body +
        ' <a class="fn-back" href="#fnref-' + escapeAttr(key) + '" title="回到正文">↩</a>' +
        (used ? '' : '<span class="fn-unused">未引用</span>') +
        '</li>'
      );
    });

    return (
      '<section class="md-footnotes" data-line="' + (FN.firstLine || 1) + '" data-end="' + (FN.lastLine || 1) + '">' +
      '<div class="md-footnotes__label">脚注</div>' +
      '<ol class="md-footnotes__list">' + items.join('') + '</ol>' +
      '</section>'
    );
  }

  /* -------------------------------------------------------------- 块级解析 */

  /**
   * @param {string[]} lines 已切分的行
   * @param {number} offset  这些行在原文里的"前一行的行号"，用于算绝对行号
   * @param {{nested?:boolean}} [ctx] nested=true 表示是被引用/列表项/脚注调用的子解析
   */
  function parseBlocks(lines, offset, ctx) {
    const out = [];
    const total = lines.length;
    const nested = Boolean(ctx && ctx.nested);
    let i = 0;

    while (i < total) {
      const line = lines[i];
      const lineNo = offset + i + 1;

      if (/^[ \t]*$/.test(line)) { i++; continue; }

      /* 围栏代码块 ------------------------------------------------------ */
      const fence = line.match(RE_FENCE);
      if (fence) {
        const ch = fence[1][0];
        const len = fence[1].length;
        const info = fence[2].trim();
        const buf = [];
        i++;
        while (i < total) {
          const close = lines[i].match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
          if (close && close[1][0] === ch && close[1].length >= len) { i++; break; }
          buf.push(lines[i]);
          i++;
        }
        out.push(codeFigure(buf.join('\n'), info, lineNo, offset + i));
        continue;
      }

      /* 块级公式 -------------------------------------------------------- */
      const mathOpen = F('math') ? line.match(RE_MATH_OPEN) : null;
      if (mathOpen) {
        const start = lineNo;
        const body = [];
        const rest = mathOpen[1];
        const inlineClose = rest.indexOf('$$');
        if (inlineClose >= 0) {
          body.push(rest.slice(0, inlineClose));
          i++;
        } else {
          if (rest.trim()) body.push(rest);
          i++;
          while (i < total) {
            const close = lines[i].indexOf('$$');
            if (close >= 0) { body.push(lines[i].slice(0, close)); i++; break; }
            body.push(lines[i]);
            i++;
          }
        }
        out.push(
          '<div class="md-math md-math--block" data-line="' + start + '" data-end="' + (offset + i) + '">' +
          mathHtml(body.join('\n').trim(), true) +
          '</div>'
        );
        continue;
      }

      /* 分隔线 ---------------------------------------------------------- */
      if (RE_HR.test(line)) {
        out.push('<hr data-line="' + lineNo + '" data-end="' + lineNo + '">');
        i++;
        continue;
      }

      /* 标题 ------------------------------------------------------------ */
      const heading = line.match(RE_HEADING);
      if (heading && isHeadingText(heading[2], heading[3])) {
        const level = heading[1].length;
        let text = heading[3].replace(/[ \t]+#+[ \t]*$/, '').trim();
        let id = '';
        if (F('attrIds')) {
          const attr = text.match(RE_ATTR_ID);
          if (attr) { id = attr[1]; text = text.slice(0, attr.index).trim(); }
        }
        if (!id) {
          OPT.headingCount += 1;
          id = 'sec-' + OPT.headingCount;
        } else if (OPT.usedIds[id]) {
          let n = 2;
          while (OPT.usedIds[id + '-' + n]) n += 1;
          id = id + '-' + n;
        }
        OPT.usedIds[id] = true;
        // 论文风格：标题自动编号（1 / 1.1 / 1.1.1，下级重新计数）
        let number = '';
        if (F('headingNumbering')) {
          const counters = OPT.sectionCounters;
          counters[level - 1] += 1;
          for (let d = level; d < 6; d += 1) counters[d] = 0;
          number = '<span class="sec-num">' + counters.slice(0, level).join('.') + '</span> ';
        }
        out.push(
          '<h' + level + ' id="' + escapeAttr(id) + '" data-line="' + lineNo + '" data-end="' + lineNo + '">' +
          number + renderInline(text) + '</h' + level + '>'
        );
        i++;
        continue;
      }

      /* 引用 ------------------------------------------------------------ */
      const quote = line.match(RE_QUOTE);
      if (quote) {
        const buf = [quote[1]];
        i++;
        while (i < total) {
          const inner = lines[i].match(RE_QUOTE);
          if (inner) { buf.push(inner[1]); i++; continue; }
          if (/^[ \t]*$/.test(lines[i]) || isBlockStart(lines[i])) break;
          buf.push(lines[i]); // 惰性续行
          i++;
        }
        out.push(
          '<blockquote data-line="' + lineNo + '" data-end="' + (offset + i) + '">' +
          parseBlocks(buf, lineNo - 1, { nested: true }) + '</blockquote>'
        );
        continue;
      }

      /* 表格 ------------------------------------------------------------ */
      if (F('tables') && line.indexOf('|') >= 0 && i + 1 < total && isTableDelim(lines[i + 1])) {
        const head = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map(alignOf);
        const rows = [];
        i += 2;
        const startLine = lineNo;
        while (i < total && lines[i].indexOf('|') >= 0 && !/^[ \t]*$/.test(lines[i])) {
          rows.push({ cells: splitRow(lines[i]), line: offset + i + 1 });
          i++;
        }
        out.push(renderTable(head, aligns, rows, startLine, offset + i));
        continue;
      }

      /* 列表 ------------------------------------------------------------ */
      const first = matchItem(line);
      if (first) {
        const baseIndent = first.indent;
        const ordered = first.ordered;
        const startNumber = first.number || 1;
        const items = [];
        const listStart = lineNo;
        let loose = false;

        while (i < total) {
          let k = i;
          while (k < total && /^[ \t]*$/.test(lines[k])) k++;
          const peek = k < total ? matchItem(lines[k]) : null;
          if (!peek || peek.indent !== baseIndent || peek.ordered !== ordered) break;
          if (k > i) loose = true;
          i = k;

          const it = matchItem(lines[i]);
          const itemLine = offset + i + 1;
          const buf = [it.text];
          const contentIndent = it.contentIndent;
          i++;

          while (i < total) {
            const cur = lines[i];
            if (/^[ \t]*$/.test(cur)) {
              let j = i;
              while (j < total && /^[ \t]*$/.test(lines[j])) j++;
              if (j >= total) { i = total; break; }
              const after = matchItem(lines[j]);
              if (after ? after.indent <= baseIndent : indentWidth(lines[j]) <= baseIndent) break;
              for (let b = i; b < j; b++) buf.push('');
              loose = true;
              i = j;
              continue;
            }
            const next = matchItem(cur);
            if (next && next.indent <= baseIndent) break;
            if (indentWidth(cur) <= baseIndent && !next) break;
            const lead = cur.length - cur.replace(/^[ \t]*/, '').length;
            buf.push(cur.slice(Math.min(lead, contentIndent)));
            i++;
          }

          items.push({ line: itemLine, end: offset + i, buf: buf, loose: false });
        }

        items.forEach(function (item) { item.loose = loose; });

        const open = ordered ? 'ol' : 'ul';
        const attr = ordered && startNumber !== 1 ? ' start="' + startNumber + '"' : '';
        out.push(
          '<' + open + ' data-line="' + listStart + '" data-end="' + (offset + i) + '"' + attr + '>' +
          items.map(renderItem).join('') +
          '</' + open + '>'
        );
        continue;
      }

      /* 段落 / 定义列表 -------------------------------------------------- */
      const buf = [line];
      i++;
      while (i < total && !/^[ \t]*$/.test(lines[i]) && !isBlockStart(lines[i])) {
        if (F('tables') && lines[i].indexOf('|') >= 0 && i + 1 < total && isTableDelim(lines[i + 1])) break;
        if (F('definitionLists') && RE_DEF_MARK.test(lines[i])) break; // 下一行是 ": 解释"，这段是定义项
        buf.push(lines[i]);
        i++;
      }

      if (F('definitionLists') && i < total && RE_DEF_MARK.test(lines[i])) {
        const termStart = lineNo;
        const defs = [];
        while (i < total) {
          const mark = lines[i].match(RE_DEF_MARK);
          if (!mark) break;
          const defLine = offset + i + 1;
          const defBody = [mark[1]];
          i++;
          while (i < total && !/^[ \t]*$/.test(lines[i]) && indentWidth(lines[i]) >= 2 && !RE_DEF_MARK.test(lines[i])) {
            defBody.push(lines[i].replace(/^ {1,4}/, ''));
            i++;
          }
          defs.push({ line: defLine, end: offset + i, body: defBody });
        }
        const terms = buf.map(function (t) {
          return '<dt>' + renderInline(t.trim()) + '</dt>';
        }).join('');
        const dd = defs.map(function (def) {
          const content = def.body.length > 1
            ? parseBlocks(def.body, def.line - 1, { nested: true })
            : renderInline(def.body[0]);
          return '<dd data-line="' + def.line + '" data-end="' + def.end + '">' + content + '</dd>';
        }).join('');
        out.push(
          '<dl class="md-dl" data-line="' + termStart + '" data-end="' + (offset + i) + '">' + terms + dd + '</dl>'
        );
        continue;
      }

      const joiner = F('hardWrap') ? '  \n' : '\n';
      const inline = renderInline(buf.join(joiner));
      const span = 'data-line="' + lineNo + '" data-end="' + (offset + i) + '"';

      // 论文风格：整段只有一张图时，排成图 + 自动编号的图注（图 1　说明文字）
      const onlyImage = F('figureNumbering') ? inline.match(/^<img\b[^>]*>$/) : null;
      if (onlyImage) {
        OPT.figureCount += 1;
        const alt = onlyImage[0].match(/alt="([^"]*)"/);
        out.push(
          '<figure class="md-figure" ' + span + '>' + inline +
          '<figcaption>图 ' + OPT.figureCount +
          (alt && alt[1] ? '　' + alt[1] : '') + '</figcaption></figure>'
        );
        continue;
      }

      out.push('<p ' + span + '>' + inline + '</p>');
    }

    // 脚注区只放在整篇最后（子解析不重复放）
    if (!nested && F('footnotes') && (FN.order.length || FN.defs.size)) {
      out.push(renderFootnotes());
    }

    return out.join('\n');
  }

  /** 紧凑项只输出行内内容；松散项（有空行）走完整块级解析，项内套 <p> */
  function renderItem(item) {
    const buf = item.buf;
    const tight =
      !item.loose &&
      (buf.length === 1 ||
        (buf.length > 1 && buf.every(function (l) { return l !== '' && !isBlockStart(l); })));

    let taskDone = null;
    if (F('taskLists') && buf.length) {
      const task = buf[0].match(RE_TASK);
      if (task) {
        taskDone = task[1].toLowerCase() === 'x';
        buf[0] = task[2];
      }
    }

    let body;
    if (tight) {
      body = renderInline(buf.join(F('hardWrap') ? '  \n' : ' ').trim());
    } else {
      body = parseBlocks(buf, item.line - 1, { nested: true });
    }

    let cls = '';
    let box = '';
    if (taskDone !== null) {
      cls = ' class="md-task' + (taskDone ? ' is-done' : '') + '"';
      box =
        '<input type="checkbox" class="md-check" data-toggle-line="' + item.line + '"' +
        (taskDone ? ' checked' : '') +
        ' aria-label="' + (taskDone ? '标记为未完成' : '标记为已完成') + '">';
    }

    return (
      '<li data-line="' + item.line + '" data-end="' + item.end + '"' + cls + '>' +
      box + body + '</li>'
    );
  }

  function renderTable(head, aligns, rows, start, end) {
    let html = '<div class="md-table" data-line="' + start + '" data-end="' + end + '"><table>';
    html += '<thead><tr>';
    head.forEach(function (cell, idx) {
      const a = aligns[idx] ? ' style="text-align:' + aligns[idx] + '"' : '';
      html += '<th' + a + '>' + renderInline(cell) + '</th>';
    });
    html += '</tr></thead><tbody>';
    rows.forEach(function (row) {
      html += '<tr>';
      const count = Math.max(head.length, row.cells.length);
      for (let c = 0; c < count; c++) {
        const a = aligns[c] ? ' style="text-align:' + aligns[c] + '"' : '';
        html += '<td' + a + '>' + renderInline(row.cells[c] || '') + '</td>';
      }
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    return html;
  }

  function codeFigure(code, info, start, end) {
    const lang = normalizeLang(info);
    const label = info.split(/[\s{]/)[0] || 'text';
    return (
      '<figure class="md-codeblock" data-line="' + start + '" data-end="' + end + '" data-lang="' + escapeAttr(label) + '">' +
      '<figcaption class="md-codeblock__bar"><span class="md-codeblock__lang">' + escapeHtml(label) + '</span>' +
      '<button type="button" class="md-codeblock__copy" data-copy>复制</button></figcaption>' +
      '<pre class="md-codeblock__pre"><code>' + highlight(code, lang) + '</code></pre>' +
      '</figure>'
    );
  }

  /* ------------------------------------------------------------ 语法高亮 */

  /* 每条规则的源串必须不含捕获组（组号 = 规则序号），buildMaster 负责补外层括号 */
  const JS_KEYWORDS =
    'as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|instanceof|interface|let|new|of|package|private|protected|public|readonly|return|set|static|super|switch|this|throw|try|type|typeof|var|void|while|with|yield|declare|namespace|satisfies';
  const GENERIC_KEYWORDS =
    JS_KEYWORDS + '|and|begin|def|elif|elseif|end|except|fin|fn|func|impl|is|lambda|match|module|mut|nil|not|or|pass|raise|range|select|struct|then|unless|until|use|val|when|where';

  const RULES = {
    js: {
      flags: 'gm',
      rules: [
        ['comment', /\/\/[^\n]*|\/\*[\s\S]*?\*\//],
        ['string', /`(?:\\[\s\S]|[^\\`])*`|'(?:\\[\s\S]|[^\\'\n])*'|"(?:\\[\s\S]|[^\\"\n])*"/],
        ['number', /(?<![\w$.])(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)(?![\w$])/],
        ['keyword', new RegExp('(?<![\\w$])(?:' + JS_KEYWORDS + ')(?![\\w$])')],
        ['literal', /(?<![\w$])(?:true|false|null|undefined|NaN|Infinity)(?![\w$])/],
        ['function', /(?<![\w$])[A-Za-z_$][\w$]*(?=\s*\()/],
        ['type', /(?<![\w$.])[A-Z][A-Za-z0-9_$]*/],
        ['punct', /[{}[\]().,;:?!+\-*/%=<>&|^~]+/],
      ],
    },
    json: {
      flags: 'gm',
      rules: [
        ['key', /"(?:\\.|[^"\\])*"(?=\s*:)/],
        ['string', /"(?:\\.|[^"\\])*"/],
        ['number', /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/],
        ['literal', /\b(?:true|false|null)\b/],
        ['punct', /[{}[\],:]/],
      ],
    },
    html: {
      flags: 'gim',
      rules: [
        ['comment', /<!--[\s\S]*?-->/],
        ['meta', /<!DOCTYPE[^>]*>|<\?[\s\S]*?\?>/],
        ['tag', /<\/?[A-Za-z][\w:-]*/],
        ['attr', /[A-Za-z_:][\w:.-]*(?==)/],
        ['string', /"[^"]*"|'[^']*'/],
        ['punct', /\/?>/],
        ['literal', /&[a-zA-Z#0-9]+;/],
      ],
    },
    css: {
      flags: 'gm',
      rules: [
        ['comment', /\/\*[\s\S]*?\*\//],
        ['string', /"[^"\n]*"|'[^'\n]*'/],
        ['meta', /@[\w-]+/],
        ['key', /[-\w]+(?=\s*:)/],
        ['number', /(?<![\w])(?:\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr|ch|pt)?|#(?:[0-9a-fA-F]{3,8}))(?![\w])/],
        ['function', /[-\w]+(?=\()/],
        ['punct', /[{};:,>+~*]/],
      ],
    },
    python: {
      flags: 'gm',
      rules: [
        ['comment', /#[^\n]*/],
        ['string', /"""[\s\S]*?"""|'''[\s\S]*?'''|[rbfu]{0,2}"(?:\\.|[^"\\\n])*"|[rbfu]{0,2}'(?:\\.|[^'\\\n])*'/],
        ['meta', /@[\w.]+/],
        ['keyword', new RegExp('(?<![\\w.])(?:' + GENERIC_KEYWORDS + ')(?![\\w])')],
        ['literal', /(?<![\w.])(?:True|False|None|self|cls)(?![\w])/],
        ['builtin', /(?<![\w.])(?:print|len|range|enumerate|zip|map|filter|sorted|sum|min|max|abs|open|int|str|float|list|dict|set|tuple|isinstance|type|super|Exception)(?![\w])/],
        ['number', /(?<![\w.])\d[\d_]*(?:\.\d[\d_]*)?(?![\w])/],
        ['function', /(?<![\w.])[A-Za-z_]\w*(?=\s*\()/],
        ['type', /(?<![\w.])[A-Z]\w*/],
        ['punct', /[{}[\]().,;:+\-*/%=<>|&^~]+/],
      ],
    },
    bash: {
      flags: 'gm',
      rules: [
        ['comment', /#[^\n]*/],
        ['string', /"(?:\\.|[^"\\])*"|'(?:[^'])*'/],
        ['variable', /\$\{[^}]+\}|\$[\w@*#?$!-]+/],
        ['flag', /(?<=^|\s)-{1,2}[A-Za-z][\w-]*/],
        ['keyword', /\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|function|return|export|local|read|in|select|time)\b/],
        ['builtin', /\b(?:echo|printf|cd|ls|pwd|cat|grep|sed|awk|cut|sort|uniq|head|tail|mkdir|rmdir|rm|cp|mv|touch|chmod|chown|find|xargs|curl|wget|git|npm|npx|pnpm|yarn|node|python|pip|docker|kubectl|ssh|scp|tar|zip|unzip|make|sudo|apt|brew|source|exit|test|which|env|sleep|kill|ps|df|du)\b/],
        ['punct', /[|&;<>(){}[\]]/],
      ],
    },
    sql: {
      flags: 'gim',
      rules: [
        ['comment', /--[^\n]*|\/\*[\s\S]*?\*\//],
        ['string', /'(?:''|[^'])*'/],
        ['keyword', /\b(?:select|from|where|insert|into|values|update|set|delete|create|table|view|index|drop|alter|add|join|left|right|inner|outer|full|on|group|by|order|having|limit|offset|distinct|as|and|or|not|null|is|in|between|like|case|when|then|else|end|union|all|primary|key|foreign|references|default|asc|desc|count|sum|avg|min|max|with|returning|exists)\b/],
        ['number', /(?<![\w.])\d+(?:\.\d+)?(?![\w])/],
        ['function', /[A-Za-z_]\w*(?=\s*\()/],
        ['punct', /[(),;.*=<>+\-/]/],
      ],
    },
    yaml: {
      flags: 'gm',
      rules: [
        ['comment', /#[^\n]*/],
        ['key', /^[ \t-]*[A-Za-z_][\w.$-]*(?=\s*:)/],
        ['string', /"(?:\\.|[^"\\])*"|'[^'\n]*'/],
        ['literal', /\b(?:true|false|null|yes|no|on|off)\b/],
        ['number', /(?<![\w.])\d+(?:\.\d+)?(?![\w])/],
        ['meta', /^[ \t]*-(?=\s)/],
        ['punct', /[:|>[\]{}]/],
      ],
    },
    markdown: {
      flags: 'gm',
      rules: [
        ['comment', /^ {0,3}>[^\n]*/],
        ['string', /^ {0,3}`{3,}[\s\S]*?^ {0,3}`{3,}[ \t]*$/],
        ['keyword', /^ {0,3}#{1,6}[^\n]*/],
        ['code', /`[^`\n]+`/],
        ['strong', /\*\*[^*\n]+\*\*|__[^_\n]+__/],
        ['emph', /\*[^*\n]+\*|_[^_\n]+_/],
        ['link', /!?\[[^\]\n]*\]\([^)\n]*\)/],
        ['meta', /^ {0,3}(?:[-*+]|\d+[.)])[ \t]/],
      ],
    },
    latex: {
      flags: 'gm',
      rules: [
        ['comment', /%[^\n]*/],
        ['keyword', /\\[A-Za-z]+/],
        ['punct', /[{}[\]]/],
        ['number', /(?<![\w.])\d+(?:\.\d+)?(?![\w])/],
        ['meta', /\$\$?/],
      ],
    },
    diff: {
      flags: 'gm',
      rules: [
        ['meta', /^(?:diff|index|---|\+\+\+)[^\n]*/],
        ['hunk', /^@@[^\n]*/],
        ['add', /^\+[^\n]*/],
        ['del', /^-[^\n]*/],
      ],
    },
    generic: {
      flags: 'gm',
      rules: [
        ['comment', /\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//],
        ['string', /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\[\s\S]|[^\\`])*`/],
        ['number', /(?<![\w.])\d[\d_]*(?:\.\d[\d_]*)?(?![\w])/],
        ['keyword', new RegExp('(?<![\\w.])(?:' + GENERIC_KEYWORDS + ')(?![\\w])')],
        ['literal', /\b(?:true|false|null|None|nil)\b/],
        ['function', /(?<![\w.])[A-Za-z_]\w*(?=\s*\()/],
        ['type', /(?<![\w.])[A-Z]\w*/],
        ['punct', /[{}[\]().,;:?!+\-*/%=<>&|^~]+/],
      ],
    },
  };

  const LANG_ALIAS = {
    javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js', ecmascript: 'js',
    typescript: 'js', ts: 'js', tsx: 'js',
    py: 'python', python3: 'python',
    sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', terminal: 'bash', dockerfile: 'bash',
    htm: 'html', xml: 'html', svg: 'html', vue: 'html',
    scss: 'css', less: 'css', sass: 'css',
    yml: 'yaml', json5: 'json', jsonc: 'json',
    md: 'markdown', mdown: 'markdown',
    tex: 'latex', math: 'latex', formula: 'latex',
    patch: 'diff', udiff: 'diff',
    properties: 'yaml', ini: 'yaml', toml: 'yaml', conf: 'yaml',
    text: 'plain', txt: 'plain', plain: 'plain', '': 'plain',
  };

  const LANG_LABEL = {
    js: 'JavaScript', json: 'JSON', html: 'HTML', css: 'CSS', python: 'Python',
    bash: 'Shell', sql: 'SQL', yaml: 'YAML', markdown: 'Markdown', diff: 'Diff',
    latex: 'LaTeX', generic: '代码', plain: '纯文本',
  };

  function normalizeLang(lang) {
    const key = String(lang || '').trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(RULES, key)) return key;
    if (Object.prototype.hasOwnProperty.call(LANG_ALIAS, key)) return LANG_ALIAS[key];
    return key ? 'generic' : 'plain';
  }

  function groupCount(source) {
    let n = 0;
    for (let i = 0; i < source.length; i++) {
      const c = source[i];
      if (c === '\\') { i += 1; continue; }
      if (c === '[') {
        i += 1;
        while (i < source.length && source[i] !== ']') {
          if (source[i] === '\\') i += 1;
          i += 1;
        }
        continue;
      }
      if (c !== '(') continue;
      if (source[i + 1] === '?') continue;
      n += 1;
    }
    return n;
  }

  const masterCache = new Map();

  function masterFor(key) {
    if (masterCache.has(key)) return masterCache.get(key);
    const pack = RULES[key];
    const bad = pack.rules.filter(function (r) { return groupCount(r[1].source) !== 0; });
    if (bad.length) throw new Error('高亮规则不允许自带捕获组：' + key + ' → ' + bad[0][0]);
    const master = new RegExp(
      pack.rules.map(function (r) { return '(' + r[1].source + ')'; }).join('|'),
      pack.flags.indexOf('g') < 0 ? pack.flags + 'g' : pack.flags
    );
    const entry = { master: master, types: pack.rules.map(function (r) { return r[0]; }) };
    masterCache.set(key, entry);
    return entry;
  }

  function highlight(code, lang) {
    const src = String(code == null ? '' : code);
    const key = normalizeLang(lang);
    if (key === 'plain') return escapeHtml(src);

    const entry = masterFor(key);
    const master = entry.master;
    let out = '';
    let last = 0;
    let m;
    master.lastIndex = 0;

    while ((m = master.exec(src)) !== null) {
      if (m[0] === '') { master.lastIndex += 1; continue; }
      let hit = -1;
      for (let g = 1; g < m.length; g++) {
        if (m[g] !== undefined) { hit = g - 1; break; }
      }
      if (hit < 0) continue;
      if (m.index > last) out += escapeHtml(src.slice(last, m.index));
      out += '<span class="tk tk-' + entry.types[hit] + '">' + escapeHtml(m[0]) + '</span>';
      last = m.index + m[0].length;
    }

    if (last < src.length) out += escapeHtml(src.slice(last));
    return out;
  }

  /* ---------------------------------------------------------- 渲染 / 统计 */

  /**
   * Markdown → HTML
   * @param {string} src
   * @param {{flavor?:string, flags?:object, resolveImage?:function}} [opts]
   */
  function render(src, opts) {
    const text = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
    OPT = normalizeOptions(opts);
    FN = createFootnoteState();

    const lines = text.split('\n');

    if (OPT.flavor.footnotes) {
      const found = collectFootnoteDefs(lines);
      FN.defs = found.defs;
      FN.firstLine = found.firstLine;
      FN.lastLine = found.lastLine;
    }

    // 只剩脚注定义时也要把脚注排出来
    if (!lines.join('').trim() && !FN.defs.size) return '';
    return parseBlocks(lines, 0);
  }

  const CJK_ONLY = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;

  /** 字数：汉字按字计，西文按词计——中文写作者的习惯 */
  function stats(src) {
    const text = String(src == null ? '' : src);
    const cjk = (text.match(CJK_ONLY) || []).length;
    const words = (text.replace(CJK_ONLY, ' ').match(/[A-Za-z0-9_'’-]+/g) || []).length;
    const count = cjk + words;
    const lines = text ? text.split('\n').length : 0;
    return {
      chars: text.length,
      charsNoSpace: text.replace(/\s/g, '').length,
      cjk: cjk,
      words: words,
      count: count,
      lines: lines,
      readMinutes: count === 0 ? 0 : Math.max(1, Math.round(count / 400)),
    };
  }

  /** 粗略去掉 Markdown 标记，用于搜索摘要与字数预览 */
  function plainText(src) {
    return String(src == null ? '' : src)
      .replace(/\r\n?/g, '\n')
      .replace(/^ {0,3}`{3,}.*$/gm, ' ')
      .replace(/^ {0,3}(?:[-*+]|\d+[.)])[ \t]+/gm, '')
      .replace(/^ {0,3}>[ \t]?/gm, '')
      .replace(/^ {0,3}#{1,6}[ \t]*/gm, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[\^([^\]]+)\]/g, '')
      .replace(/^ {0,3}\[\^([^\]]+)\]:[ \t]*/gm, '')
      .replace(/\$\$?/g, '')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      .replace(/~~(.*?)~~/g, '$1')
      .replace(/==(.*?)==/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\|/g, ' ')
      .replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, ' ');
  }

  return {
    escapeHtml: escapeHtml,
    escapeAttr: escapeAttr,
    safeUrl: safeUrl,
    isAnchor: isAnchor,
    detectWrappingFence: detectWrappingFence,
    renderInline: renderInline,
    render: render,
    highlight: highlight,
    normalizeLang: normalizeLang,
    langLabel: function (lang) { return LANG_LABEL[normalizeLang(lang)] || LANG_LABEL.generic; },
    languages: Object.keys(RULES),
    stats: stats,
    plainText: plainText,
    flavors: flavorList,
    flavorFlags: flavorFlags,
    features: FEATURES,
    FLAVORS: FLAVORS,
    DEFAULT_FLAVOR: DEFAULT_FLAVOR,
    mathAvailable: Boolean(mathApi),
  };
});
