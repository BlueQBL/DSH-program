// 轻量语法高亮
//
// 为什么不用 highlight.js / Prism：这个项目的约束是零依赖、无构建步骤，
// 引一个几百 KB 的库只为了给代码加颜色不划算。而代码块里真正需要区分的
// 也就那么几类：注释、字符串、数字、关键字、类型名、函数名。
//
// 与流式渲染的配合：界面上的代码是一个字一个字长出来的，所以**必须能处理半截内容**。
// 这里用的是「不依赖配对」的策略 —— 字符串没闭合就当字符串显示到行尾，
// 不会因为等待配对而吞掉后面的内容（对比 markdown.js 里的粗体/围栏处理思路一致）。

/** 各语言的关键字。识别不出来的语言走通用高亮（只认注释/字符串/数字） */
const KEYWORDS = {
  js: 'const let var function return if else for while do break continue new class extends super this typeof instanceof in of delete void yield async await try catch finally throw switch case default export import from as static get set null undefined true false NaN Infinity',
  ts: 'const let var function return if else for while do break continue new class extends super this typeof instanceof in of delete void yield async await try catch finally throw switch case default export import from as static get set null undefined true false interface type enum namespace declare readonly public private protected implements abstract any unknown never string number boolean object symbol bigint satisfies keyof infer is asserts',
  jsx: 'const let var function return if else for while do break continue new class extends super this typeof instanceof in of delete void yield async await try catch finally throw switch case default export import from as static get set null undefined true false',
  py: 'def return if elif else for while break continue pass import from as class try except finally raise with lambda yield global nonlocal assert del in is not and or None True False async await match case',
  java: 'public private protected class interface extends implements static final void int long double float boolean char byte short new return if else for while do break continue switch case default try catch finally throw throws import package this super null true false instanceof enum abstract synchronized volatile transient native',
  go: 'package import func var const type struct interface map chan go defer return if else for range break continue switch case default select nil true false make new len cap append panic recover',
  rs: 'fn let mut const struct enum impl trait for while loop match if else return use mod pub crate self super as where async await move ref dyn box unsafe break continue static type in',
  sh: 'if then else elif fi for while do done case esac function return exit export local readonly echo cd set unset source alias',
  sql: 'select from where group by order having limit offset insert into values update set delete create table alter drop index join left right inner outer on as and or not null distinct count sum avg min max',
  css: 'important media supports keyframes import charset font-face',
};

/** 语言别名 → 上面那套集合 */
const LANG_ALIAS = {
  javascript: 'js',
  mjs: 'js',
  cjs: 'js',
  node: 'js',
  jsx: 'jsx',
  typescript: 'ts',
  tsx: 'ts',
  python: 'py',
  py3: 'py',
  golang: 'go',
  rust: 'rs',
  bash: 'sh',
  shell: 'sh',
  zsh: 'sh',
  console: 'sh',
  postgres: 'sql',
  postgresql: 'sql',
  mysql: 'sql',
  scss: 'css',
  less: 'css',
};

/** 每类词素的样式类名 */
const CLASS = {
  comment: 'tok-comment',
  string: 'tok-string',
  number: 'tok-number',
  keyword: 'tok-keyword',
  type: 'tok-type',
  func: 'tok-func',
};

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => {
    if (ch === '&') return '&amp;';
    if (ch === '<') return '&lt;';
    if (ch === '>') return '&gt;';
    if (ch === '"') return '&quot;';
    return '&#39;';
  });
}

export function normalizeLang(lang) {
  const key = String(lang || '').trim().toLowerCase();
  if (KEYWORDS[key]) return key;
  return LANG_ALIAS[key] ?? '';
}

/**
 * 一个正则一次扫完，靠命名分组的先后顺序决定优先级。
 * 顺序很关键：
 *   注释在最前（否则 `// 这里有个 "引号"` 里的引号会被当成字符串）
 *   字符串随即（否则关键字会命中字符串内容）
 *   然后才是数字、关键字、函数调用、类型名
 */
const TOKENIZER = new RegExp(
  [
    '(?<comment>\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*|#[^\\n]*|--[^\\n]*)',
    '(?<string>`(?:\\\\[\\s\\S]|[^`\\\\])*`|"(?:\\\\.|[^"\\\\\\n])*"?|\'(?:\\\\.|[^\'\\\\\\n])*\'?)',
    '(?<number>\\b0[xX][0-9a-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)',
    '(?<word>[A-Za-z_$][A-Za-z0-9_$]*)',
    '(?<punct>[^A-Za-z0-9_$\\s]+)',
    '(?<space>\\s+)',
  ].join('|'),
  'g',
);

/**
 * 给一段代码加高亮，返回 HTML。
 *
 * @param {string} code 原始代码（未转义）
 * @param {string} lang 语言标记
 */
export function highlight(code, lang) {
  const text = String(code ?? '');
  if (!text) return '';

  const normalized = normalizeLang(lang);
  const keywords = new Set((KEYWORDS[normalized] ?? '').split(' ').filter(Boolean));
  const generic = normalized === '';
  const out = [];

  TOKENIZER.lastIndex = 0;
  let match;

  while ((match = TOKENIZER.exec(text)) !== null) {
    const groups = match.groups;
    const raw = match[0];

    if (groups.comment) {
      // 通用模式下 # 只有在行首才算注释，否则 `a #b` 这类会被误判。
      // 判据直接看原文：这个 # 前面是不是只有空白（或什么都没有）。
      if (generic && raw.startsWith('#')) {
        const lineStart = text.lastIndexOf('\n', match.index - 1) + 1;
        const before = text.slice(lineStart, match.index);
        if (before.trim()) {
          out.push(escapeHtml(raw));
          continue;
        }
      }
      out.push(`<span class="${CLASS.comment}">${escapeHtml(raw)}</span>`);
      continue;
    }

    if (groups.string) {
      out.push(`<span class="${CLASS.string}">${escapeHtml(raw)}</span>`);
      continue;
    }

    if (groups.number) {
      out.push(`<span class="${CLASS.number}">${escapeHtml(raw)}</span>`);
      continue;
    }

    if (groups.word) {
      // 往后看一个非空白字符，判断这是不是在调用函数：foo(
      const rest = text.slice(match.index + raw.length);
      const isCall = /^\s*\(/.test(rest);

      if (keywords.has(raw)) out.push(`<span class="${CLASS.keyword}">${escapeHtml(raw)}</span>`);
      else if (isCall) out.push(`<span class="${CLASS.func}">${escapeHtml(raw)}</span>`);
      else if (/^[A-Z]/.test(raw)) out.push(`<span class="${CLASS.type}">${escapeHtml(raw)}</span>`);
      else out.push(escapeHtml(raw));
      continue;
    }

    out.push(escapeHtml(raw));
  }

  return out.join('');
}

/** 这个语言标记是否值得标在代码块角上（未知语言就给个通用默认值） */
export function displayLang(lang) {
  const key = String(lang || '').trim();
  if (!key) return '';
  return normalizeLang(key) || key.toLowerCase();
}
