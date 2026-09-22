/*!
 * 校样 · Markdown 解析与语法高亮（markdown.js）
 *
 * 纯逻辑，不碰 DOM：浏览器挂到 window.MDMarkdown，Node 走 module.exports。
 *
 * 安全策略：只认 Markdown。原文里的 HTML 一律转义（不做 raw HTML 透传），
 *          链接协议走白名单（http/https/mailto/#/相对路径）。
 *          笔记存在 LocalStorage 里，可能被手工改过，所以渲染侧必须自己兜底。
 *
 * 块级元素带 data-line / data-end（1 基，含首含尾），
 * 供界面做"光标 ↔ 预览"双向定位，这是本应用的核心交互。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MDMarkdown = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
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
    // 不含冒号的当作站内相对路径，含冒号但不在白名单的直接作废
    return /:/.test(raw) ? '' : raw;
  }

  /* -------------------------------------------------------------- 行内解析 */

  const CODE_TOKEN = '\u0000';

  /**
   * 行内 Markdown → HTML。
   * 顺序很要紧：先摘出行内代码（避免其中内容被后续规则误伤），再转义，
   * 再做链接/强调，最后把代码放回去。
   */
  function renderInline(text) {
    const codes = [];
    let s = String(text == null ? '' : text);

    // 行内代码：反引号数量必须配对，CommonMark 规定首尾各去一个空格
    s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, function (_m, _t, body) {
      codes.push(body.replace(/^ ([\s\S]*) $/, '$1'));
      return CODE_TOKEN + (codes.length - 1) + '\u0001';
    });

    s = escapeHtml(s);

    // 图片 → 链接 → 尖括号自动链接 → 裸链接
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^"]*)&quot;)?\)/g, function (_m, alt, src, title) {
      const href = safeUrl(src);
      if (!href) return escapeHtml(alt);
      return (
        '<img src="' + escapeAttr(href) + '" alt="' + escapeAttr(alt) + '"' +
        (title ? ' title="' + escapeAttr(title) + '"' : '') + ' loading="lazy">'
      );
    });

    s = s.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^"]*)&quot;)?\)/g, function (_m, label, href, title) {
      const url = safeUrl(href);
      if (!url) return label;
      return (
        '<a href="' + escapeAttr(url) + '"' +
        (title ? ' title="' + escapeAttr(title) + '"' : '') +
        ' target="_blank" rel="noopener noreferrer">' + label + '</a>'
      );
    });

    s = s.replace(/&lt;((?:https?|mailto):[^\s&]+)&gt;/g, function (m, url) {
      const href = safeUrl(url);
      return href
        ? '<a href="' + escapeAttr(href) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(url) + '</a>'
        : m;
    });

    s = s.replace(/(^|[\s(（])(https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?，。；：！？])/g, function (_m, lead, url) {
      return lead + '<a href="' + escapeAttr(safeUrl(url) || url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(url) + '</a>';
    });

    // 强调：先把 \u0000 占位符挡住——它们只有数字，不会被下列规则命中
    // 每组都写成"末尾可选"，否则 **单字** 这种两边定界符夹一个字的情况会漏
    s = s.replace(/\*\*([^\s*](?:[\s\S]*?[^\s*])?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w])__([^\s_](?:[\s\S]*?[^\s_])?)__(?!\w)/g, '$1<strong>$2</strong>');
    s = s.replace(/(^|[^*\w])\*([^\s*](?:[^*]*[^\s*])?)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_([^\s_](?:[^_]*[^\s_])?)_(?![\w_])/g, '$1<em>$2</em>');
    s = s.replace(/~~([^\s~](?:[^~]*[^\s~])?)~~/g, '<del>$1</del>');

    // 硬换行：行尾两个空格，或反斜杠
    s = s.replace(/(?: {2,}|\\)\n/g, '<br>\n');

    // 放回行内代码
    s = s.replace(/\u0000(\d+)\u0001/g, function (_m, n) {
      const body = codes[Number(n)];
      return body === undefined ? '' : '<code class="md-code">' + escapeHtml(body) + '</code>';
    });

    return s;
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
  const RE_HEADING = /^ {0,3}(#{1,6})[ \t]*(.*)$/;
  const RE_QUOTE = /^ {0,3}>[ \t]?(.*)$/;
  const RE_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/;
  const RE_TASK = /^\[([ xX])\][ \t]+([\s\S]*)$/;
  const RE_TABLE_DELIM = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

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

  function isBlockStart(line) {
    if (RE_FENCE.test(line) || RE_HR.test(line) || RE_QUOTE.test(line)) return true;
    if (matchItem(line)) return true;
    const h = line.match(RE_HEADING);
    return Boolean(h && !/^#/.test(h[2]));
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

  /* -------------------------------------------------------------- 块级解析 */

  /**
   * @param {string[]} lines 已切分的行
   * @param {number} offset  这些行在原文里的"前一行的行号"，用于算绝对行号
   */
  function parseBlocks(lines, offset) {
    const out = [];
    const total = lines.length;
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

      /* 分隔线 ---------------------------------------------------------- */
      if (RE_HR.test(line)) {
        out.push('<hr data-line="' + lineNo + '" data-end="' + lineNo + '">');
        i++;
        continue;
      }

      /* 标题 ------------------------------------------------------------ */
      const heading = line.match(RE_HEADING);
      if (heading && !/^#/.test(heading[2])) {
        const level = heading[1].length;
        const text = heading[2].replace(/[ \t]+#+[ \t]*$/, '').trim();
        out.push(
          '<h' + level + ' data-line="' + lineNo + '" data-end="' + lineNo + '">' +
          renderInline(text) + '</h' + level + '>'
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
          parseBlocks(buf, lineNo - 1) + '</blockquote>'
        );
        continue;
      }

      /* 表格 ------------------------------------------------------------ */
      if (line.indexOf('|') >= 0 && i + 1 < total && isTableDelim(lines[i + 1])) {
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
          // 项间的空行（一个或多个）属于本列表，不能把列表切断
          let k = i;
          while (k < total && /^[ \t]*$/.test(lines[k])) k++;
          const peek = k < total ? matchItem(lines[k]) : null;
          if (!peek || peek.indent !== baseIndent || peek.ordered !== ordered) break;
          if (k > i) loose = true; // 项间有空行 → 整张列表算松散，项内套 <p>
          i = k;

          const it = matchItem(lines[i]);
          const itemLine = offset + i + 1;
          const buf = [it.text];
          const contentIndent = it.contentIndent;
          i++;

          while (i < total) {
            const cur = lines[i];
            if (/^[ \t]*$/.test(cur)) {
              // 空行：后面还有缩进更深的行才算本项未完；否则留给外层去判断"是不是同一列表的下一项"
              let j = i;
              while (j < total && /^[ \t]*$/.test(lines[j])) j++;
              if (j >= total) { i = total; break; }
              const after = matchItem(lines[j]);
              if (after ? after.indent <= baseIndent : indentWidth(lines[j]) <= baseIndent) break;
              // 逐个 push，保持 buf 与原文行号一一对应
              for (let b = i; b < j; b++) buf.push('');
              loose = true;
              i = j;
              continue;
            }
            const next = matchItem(cur);
            if (next && next.indent <= baseIndent) break;      // 下一个同级项
            if (indentWidth(cur) <= baseIndent && !next) break; // 掉出列表
            const lead = cur.length - cur.replace(/^[ \t]*/, '').length;
            buf.push(cur.slice(Math.min(lead, contentIndent)));
            i++;
          }

          items.push({
            line: itemLine,
            end: offset + i,
            buf: buf,
            loose: false,
          });
        }

        // CommonMark 的规矩：列表里只要有一处空行，整张列表都算松散
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

      /* 段落 ------------------------------------------------------------ */
      const buf = [line];
      i++;
      while (i < total && !/^[ \t]*$/.test(lines[i]) && !isBlockStart(lines[i])) {
        // 段落中途遇到表格分隔行就不再吞了
        if (lines[i].indexOf('|') >= 0 && i + 1 < total && isTableDelim(lines[i + 1])) break;
        buf.push(lines[i]);
        i++;
      }
      out.push(
        '<p data-line="' + lineNo + '" data-end="' + (offset + i) + '">' +
        renderInline(buf.join('\n')) + '</p>'
      );
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

    // 任务列表：脱掉 [ ] 标记，标在 li 上；行号回写用 data-toggle-line
    let taskDone = null;
    const task = buf.length ? buf[0].match(RE_TASK) : null;
    if (task) {
      taskDone = task[1].toLowerCase() === 'x';
      buf[0] = task[2];
    }

    let body;
    if (tight) {
      body = renderInline(buf.join(' ').trim());
    } else {
      body = parseBlocks(buf, item.line - 1);
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
    py: 'python', python3: 'python', rb: 'generic', ruby: 'generic',
    sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', terminal: 'bash', dockerfile: 'bash',
    htm: 'html', xml: 'html', svg: 'html', vue: 'html',
    scss: 'css', less: 'css', sass: 'css',
    yml: 'yaml', json5: 'json', jsonc: 'json',
    md: 'markdown', mdown: 'markdown',
    patch: 'diff', udiff: 'diff',
    properties: 'yaml', ini: 'yaml', toml: 'yaml', conf: 'yaml',
    text: 'plain', txt: 'plain', plain: 'plain', '': 'plain',
  };

  const LANG_LABEL = {
    js: 'JavaScript', json: 'JSON', html: 'HTML', css: 'CSS', python: 'Python',
    bash: 'Shell', sql: 'SQL', yaml: 'YAML', markdown: 'Markdown', diff: 'Diff',
    generic: '代码', plain: '纯文本',
  };

  /** 把别名（jsx / ts / sh …）收敛成内部键 */
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
      if (c === '[') { // 跳过字符类，否则 [()] 里的括号会被数成捕获组
        i += 1;
        while (i < source.length && source[i] !== ']') {
          if (source[i] === '\\') i += 1;
          i += 1;
        }
        continue;
      }
      if (c !== '(') continue;
      if (source[i + 1] === '?') continue; // (?: (?= (?! (?<= (?<!
      n += 1;
    }
    return n;
  }

  const masterCache = new Map();

  /* 规则表约定：每条规则的源串自带 0 个捕获组，
     buildMaster 会给每条包一层 ( )，组号即规则序号，token 类型靠组号定位 */
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

  /**
   * 语法高亮：命中规则切成 <span class="tk tk-xxx">，未命中的片段原样转义。
   * 未知语言退回 generic，纯文本只做转义。
   */
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

  /** Markdown → HTML（块级元素带 data-line / data-end） */
  function render(src) {
    const text = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
    if (!text.trim()) return '';
    return parseBlocks(text.split('\n'), 0);
  }

  const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;

  /** 字数：汉字按字计，西文按词计——中文写作者的习惯 */
  function stats(src) {
    const text = String(src == null ? '' : src);
    const cjk = (text.match(CJK) || []).length;
    const words = (text.replace(CJK, ' ').match(/[A-Za-z0-9_'’-]+/g) || []).length;
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
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      .replace(/~~(.*?)~~/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\|/g, ' ')
      .replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, ' ');
  }

  return {
    escapeHtml: escapeHtml,
    escapeAttr: escapeAttr,
    safeUrl: safeUrl,
    renderInline: renderInline,
    render: render,
    highlight: highlight,
    normalizeLang: normalizeLang,
    langLabel: function (lang) { return LANG_LABEL[normalizeLang(lang)] || LANG_LABEL.generic; },
    languages: Object.keys(RULES),
    stats: stats,
    plainText: plainText,
  };
});
