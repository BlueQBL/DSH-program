// 流式安全的 Markdown 解析器
//
// 界面上的回答是一个字一个字长出来的，所以解析器必须能处理「半截语法」：
//   · 未闭合的行内标记（**加粗、`代码）→ 退化成普通文本，下一帧自动补全
//   · 未闭合的代码围栏 → 当成「正在书写中的代码块」照常渲染，语言标签先不显示
// 全部输出都经过 escapeHtml，不做 innerHTML 直插，避免把模型输出当 HTML 执行。

import { highlight, displayLang } from './highlight.js';

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

/** 光标：表示「正在写到这里」 */
const CARET = '<span class="caret" aria-hidden="true"></span>';

/**
 * 行内标记：先占位保护 code，再处理粗体/斜体，最后还原 code。
 * 未闭合的标记一律保留字面量。
 */
function renderInline(raw, { caretAtEnd = false } = {}) {
  let text = escapeHtml(raw);
  const codes = [];

  // `code` —— 只配对同一行内成对的
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });

  // **粗体** 与 *斜体*（粗体先处理，避免 ** 被斜体抢走）
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[\s（(，,。；;])\*([^*\n]+)\*(?=$|[\s）)，,。；;！!？?])/g, '$1<em>$2</em>');

  text = text.replace(/\u0000(\d+)\u0000/g, (_m, index) => `<code>${codes[Number(index)]}</code>`);

  return caretAtEnd ? text + CARET : text;
}

/** 把一段纯文本切成块。返回值里 code 块带 closed 标记，供界面决定是否显示语言标签。 */
export function parseBlocks(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  let list = null;
  let quote = [];
  let code = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: 'p', text: paragraph.join('\n') });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push(list);
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      blocks.push({ type: 'quote', text: quote.join('\n') });
      quote = [];
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const line of lines) {
    // 代码围栏优先判断，块内不再识别其他语法
    const fence = line.match(/^\s*```\s*([A-Za-z0-9+#._-]*)\s*$/);
    if (code) {
      if (fence) {
        code.closed = true;
        blocks.push({ type: 'code', lang: code.lang, text: code.lines.join('\n'), closed: true });
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }
    if (fence) {
      flushAll();
      code = { lang: fence[1] || '', lines: [], closed: false };
      continue;
    }

    if (!line.trim()) {
      flushAll();
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushAll();
      blocks.push({ type: 'h', level: heading[1].length, text: heading[2] });
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) {
      flushAll();
      blocks.push({ type: 'hr' });
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*(\d{1,3})[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      flushQuote();
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { type: 'list', ordered, items: [] };
      }
      list.items.push(ordered ? numbered[2] : bullet[1]);
      continue;
    }

    const quoted = line.match(/^\s*>\s?(.*)$/);
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1]);
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(line);
  }

  // 收尾：未闭合的代码围栏按「书写中」处理
  if (code) {
    blocks.push({ type: 'code', lang: code.lang, text: code.lines.join('\n'), closed: false });
  }
  flushAll();
  return blocks;
}

/**
 * 渲染成 HTML 字符串。
 * @param {string} markdown
 * @param {{streaming?: boolean}} options streaming 为真时在最后一个文本节点后加书写光标
 */
export function renderMarkdown(markdown, { streaming = false } = {}) {
  const blocks = parseBlocks(markdown);
  const lastIndex = blocks.length - 1;
  const html = [];

  blocks.forEach((block, index) => {
    const isLast = streaming && index === lastIndex;
    switch (block.type) {
      case 'h': {
        const level = Math.min(4, Math.max(1, block.level));
        html.push(`<h${level}>${renderInline(block.text, { caretAtEnd: isLast })}</h${level}>`);
        break;
      }
      case 'p':
        html.push(`<p>${renderInline(block.text, { caretAtEnd: isLast })}</p>`);
        break;
      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul';
        const items = block.items
          .map((item, i) => {
            const caretHere = isLast && i === block.items.length - 1;
            return `<li>${renderInline(item, { caretAtEnd: caretHere })}</li>`;
          })
          .join('');
        html.push(`<${tag}>${items}</${tag}>`);
        break;
      }
      case 'quote':
        html.push(`<blockquote>${renderInline(block.text, { caretAtEnd: isLast })}</blockquote>`);
        break;
      case 'hr':
        html.push('<hr />');
        break;
      case 'code': {
        // 围栏还没闭合时，语言标签本身也还没写完，不能急着显示
        const label = block.closed ? escapeHtml(displayLang(block.lang) || 'code') : '书写中…';
        // 高亮器自己负责转义。
        // 未闭合的围栏照样高亮：语言标记在开围栏时就已知了，而流式输出期间
        // 「未闭合」才是常态 —— 等闭合才上色的话，用户几乎看不到颜色。
        const body = highlight(block.text, block.lang) + (isLast ? CARET : '');
        html.push(
          `<div class="code-block" data-lang="${escapeHtml(block.lang)}">` +
            `<div class="code-head"><span class="code-lang">${label}</span>` +
            `<button type="button" class="code-copy" data-copy-code>复制代码</button></div>` +
            `<pre><code>${body}</code></pre>` +
          '</div>',
        );
        break;
      }
      default:
        break;
    }
  });

  return html.join('');
}

/** 取纯文本，用于导出与复制（不做渲染） */
export function markdownToPlain(markdown) {
  return String(markdown ?? '')
    .replace(/```[^\n]*\n?/g, '')
    .replace(/[*`>#]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
