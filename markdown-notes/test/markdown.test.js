'use strict';

/**
 * 解析层测试：markdown.js 是纯函数，直接在 Node 里跑，不碰 DOM。
 * 运行：node test/markdown.test.js
 */

const assert = require('assert');
const md = require('../js/markdown.js');

let pass = 0;
const failures = [];

function eq(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected);
    pass += 1;
  } catch {
    failures.push(
      `${label}\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`
    );
  }
}

function ok(value, label) {
  eq(Boolean(value), true, label);
}

function no(value, label) {
  eq(Boolean(value), false, label);
}

function has(haystack, needle, label) {
  if (String(haystack).indexOf(needle) >= 0) pass += 1;
  else failures.push(`${label}\n    应包含 ${JSON.stringify(needle)}\n    实际 ${JSON.stringify(haystack)}`);
}

function lacks(haystack, needle, label) {
  if (String(haystack).indexOf(needle) < 0) pass += 1;
  else failures.push(`${label}\n    不应包含 ${JSON.stringify(needle)}\n    实际 ${JSON.stringify(haystack)}`);
}

function group(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`[${name}] 抛错：${err && err.stack ? err.stack : err}`);
  }
}

/** 去掉标签还原成纯文本，用来验证"渲染不丢字、不吞字" */
function stripTags(html) {
  return String(html)
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/* ------------------------------------------------------------------ 安全 */

group('转义与链接白名单', () => {
  const html = md.render('<script>alert(1)</script>');
  lacks(html, '<script', '原文 HTML 必须转义，不能透传');
  has(html, '&lt;script&gt;', '转义后的尖括号保留可视');

  lacks(md.renderInline('[点我](javascript:alert(1))'), 'href', 'javascript: 链接必须拒绝');
  lacks(md.renderInline('![x](data:text/html;base64,AAA)'), '<img', 'data: 图片必须拒绝');
  has(md.renderInline('[官网](https://example.com)'), 'href="https://example.com"', 'https 链接放行');
  has(md.renderInline('[官网](https://example.com)', 'rel="noopener"'), 'noopener', '外链带 noopener');
  has(md.renderInline('<https://a.dev>'), 'href="https://a.dev"', '尖括号自动链接');
  has(md.renderInline('见 https://a.dev/x 说明'), 'href="https://a.dev/x"', '裸链接自动识别');
  eq(md.safeUrl('mailto:a@b.com'), 'mailto:a@b.com', 'mailto 放行');
  eq(md.safeUrl('a@b.com'), 'mailto:a@b.com', '裸邮箱转 mailto');
  eq(md.safeUrl('vbscript:x'), '', 'vbscript 拒绝');
  eq(md.safeUrl('./note.md'), './note.md', '相对路径放行');
});

/* -------------------------------------------------------------- 行内语法 */

group('行内语法', () => {
  has(md.renderInline('**粗**'), '<strong>粗</strong>', '加粗');
  has(md.renderInline('__粗__'), '<strong>粗</strong>', '下划线加粗');
  has(md.renderInline('*斜*'), '<em>斜</em>', '斜体');
  has(md.renderInline('~~删~~'), '<del>删</del>', '删除线');
  has(md.renderInline('`code()`'), '<code class="md-code">code()</code>', '行内代码');
  has(md.renderInline('a  \nb'), '<br>', '行尾两空格硬换行');
  has(md.renderInline('a\\\nb'), '<br>', '反斜杠硬换行');

  // 行内代码内的内容不能被强调规则吃掉
  const protectedCode = md.renderInline('`**not bold**`');
  has(protectedCode, '<code class="md-code">**not bold**</code>', '代码里不解析强调');
  lacks(protectedCode, '<strong>', '代码里不解析强调（无残留 strong）');

  // 不支持下划线变量被误判成斜体：snake_case 要活着
  lacks(md.renderInline('user_id_name'), '<em>', 'snake_case 不误判斜体');
  has(md.renderInline('user_id_name'), 'user_id_name', 'snake_case 原样保留');

  has(md.renderInline('a < b & c'), 'a &lt; b &amp; c', '普通文本里的尖括号与 & 转义');
  has(md.renderInline('[**粗**链接](https://x.dev)'), '<strong>粗</strong>', '链接文字里支持强调');
});

/* -------------------------------------------------------------- 块级语法 */

group('标题', () => {
  eq(md.render('# 标题'), '<h1 data-line="1" data-end="1">标题</h1>', '一级标题');
  eq(md.render('### 三级'), '<h3 data-line="1" data-end="1">三级</h3>', '三级标题');
  has(md.render('#标题'), '>标题<', '中文习惯：井号后不空格也认');
  has(md.render('## 标题 ##'), '>标题<', '收尾井号被剥掉');
  has(md.render('####### 七个井号'), '<p ', '七个井号不是标题');
});

group('围栏代码块', () => {
  const html = md.render('```js\nconst n = 1;\n```');
  has(html, 'data-lang="js"', '记住语言');
  has(html, 'tk-keyword', '关键字上色');
  has(html, 'tk-number', '数字上色');
  has(html, 'class="md-codeblock__copy"', '带复制按钮');
  // 代码块正文保持原样（复制时再补行尾换行，见 app.js）
  eq(stripTags(html.match(/<code>([\s\S]*)<\/code>/)[1]), 'const n = 1;', '代码内容一字不差');

  const unclosed = md.render('```\nplain text\n');
  has(unclosed, 'md-codeblock', '未闭合围栏也当代码块');
  has(unclosed, 'plain text', '未闭合围栏内容保留');

  const tilde = md.render('~~~python\nprint(1)\n~~~');
  has(tilde, 'data-lang="python"', '波浪号围栏');

  const noLang = md.render('```\nx\n```');
  has(noLang, 'data-lang="text"', '无语言标注');

  // 代码块里的 Markdown 不能被解析
  const raw = md.render('```\n# 不是标题\n- 不是列表\n```');
  lacks(raw, '<h1', '代码块内不解析标题');
  lacks(raw, '<ul', '代码块内不解析列表');
});

group('列表', () => {
  const ul = md.render('- 甲\n- 乙');
  has(ul, '<ul data-line="1" data-end="2">', '无序列表包裹');
  eq((ul.match(/<li /g) || []).length, 2, '两个列表项');
  lacks(ul, '<p', '紧凑列表项不套段落');

  const ol = md.render('3. 甲\n4. 乙');
  has(ol, '<ol data-line="1" data-end="2" start="3">', '有序列表保留起始序号');

  const nested = md.render('- 甲\n  - 子项\n- 乙');
  has(nested, '<ul', '嵌套列表');
  eq((nested.match(/<ul/g) || []).length, 2, '嵌套出两层 ul');

  const loose = md.render('- 甲\n\n- 乙');
  eq((loose.match(/<ul/g) || []).length, 1, '空行不切断同一个列表');
  eq((loose.match(/<li /g) || []).length, 2, '空行分隔后仍有两个列表项');
  eq((loose.match(/<p /g) || []).length, 2, '松散列表项套段落');

  const deep = md.render('- 一\n  - 二\n    - 三');
  eq((deep.match(/<ul/g) || []).length, 3, '三层嵌套');

  const mixed = md.render('- 甲\n1. 乙');
  eq((mixed.match(/<ul|<ol/g) || []).length, 2, '符号不同视为两个列表');
});

group('任务列表', () => {
  const html = md.render('- [ ] 未完成\n- [x] 已完成');
  has(html, 'type="checkbox"', '渲染成复选框');
  has(html, 'data-toggle-line="1"', '复选框带行号，可回写原文');
  has(html, 'data-toggle-line="2" checked', '已完成项默认勾选');
  has(html, 'md-task is-done', '已完成项带样式类');
  lacks(html, '[ ]', '任务标记不残留');
});

group('引用与分隔线', () => {
  const q = md.render('> 引一句\n> 换行');
  has(q, '<blockquote data-line="1" data-end="2">', '引用包裹');
  has(q, '<p', '引用里的段落');

  const nestedQ = md.render('> 外层\n> > 内层');
  eq((nestedQ.match(/<blockquote/g) || []).length, 2, '嵌套引用');

  const lazy = md.render('> 第一行\n第二行');
  has(lazy, '第一行', '引用惰性续行');
  has(lazy, '第二行', '引用惰性续行（第二行）');

  has(md.render('---'), '<hr data-line="1"', '分隔线');
  has(md.render('***'), '<hr', '星号分隔线');
  has(md.render('甲\n\n---\n\n乙'), '乙', '分隔线不吞后文');
});

group('表格', () => {
  const html = md.render('| 名 | 值 |\n| :-- | --: |\n| a | 1 |');
  has(html, '<table>', '表格');
  has(html, 'text-align:left', '左对齐');
  has(html, 'text-align:right', '右对齐');
  eq((html.match(/<th[ >]/g) || []).length, 2, '表头两列');
  eq((html.match(/<td/g) || []).length, 2, '表体两格');
  has(html, 'data-line="1"', '表格带行号');

  const pad = md.render('| a | b |\n| - | - |\n| 1 |');
  eq((pad.match(/<td/g) || []).length, 2, '缺格自动补齐');
});

group('段落与行号', () => {
  const html = md.render('第一段\n还是第一段\n\n第二段');
  has(html, '<p data-line="1" data-end="2">', '段落跨行、行号区间正确');
  has(html, '<p data-line="4" data-end="4">', '第二段行号正确（跳过空行）');

  const doc = md.render('# 标题\n\n正文\n\n```js\nlet a = 1;\n```\n\n> 引用\n\n- 项');
  has(doc, '<h1 data-line="1"', '标题行号');
  has(doc, '<p data-line="3"', '正文行号');
  has(doc, 'data-line="5" data-end="7"', '代码块行号区间');
  has(doc, '<blockquote data-line="9"', '引用行号');
  has(doc, '<ul data-line="11"', '列表行号');

  eq(md.render(''), '', '空文档渲染为空串');
  eq(md.render('   \n  \n'), '', '纯空白渲染为空串');
  eq(md.render('a\r\nb').indexOf('\r'), -1, 'CRLF 归一化');
});

/* ---------------------------------------------------------------- 高亮 */

group('语法高亮', () => {
  const samples = {
    js: 'const x = "s"; // c\nfunction f(a) { return a + 1; }',
    json: '{"k": [1, true, null]}',
    html: '<div class="a">text</div>',
    css: '.a { color: #fff; width: 50%; }',
    python: 'def f(x):\n    """doc"""\n    return x  # c',
    bash: 'git status --short\nfor f in *.md; do echo "$f"; done',
    sql: 'SELECT id, name FROM users WHERE id = 1 -- c',
    yaml: 'key: value\nlist:\n  - 1\n  # c',
    markdown: '# 标题\n\n- 项 **粗**\n\n`code`',
    diff: '@@ -1 +1 @@\n-old\n+new',
    generic: 'fn main() { let x = 1; // c }',
    plain: 'whatever <div>',
  };

  Object.keys(samples).forEach((lang) => {
    const src = samples[lang];
    let html;
    try {
      html = md.highlight(src, lang);
    } catch (err) {
      failures.push(`[高亮/${lang}] 抛错：${err.message}`);
      return;
    }
    eq(stripTags(html), src, `高亮不丢字（${lang}）`);
    if (lang !== 'plain') has(html, 'tk-', `${lang} 至少命中一个 token`);
  });

  has(md.highlight(samples.js, 'javascript'), 'tk-keyword', 'js 别名');
  has(md.highlight(samples.python, 'py'), 'tk-keyword', 'python 别名');
  has(md.highlight(samples.bash, 'shell'), 'tk-builtin', 'shell 别名');
  has(md.highlight(samples.diff, 'diff'), 'tk-add', 'diff 增行');
  has(md.highlight(samples.diff, 'diff'), 'tk-del', 'diff 删行');
  has(md.highlight('<?php echo 1;', 'zzz-unknown'), 'tk-', '未知语言退回通用规则');
  eq(md.highlight('<b>&', 'plain'), '&lt;b&gt;&amp;', 'plain 只转义');

  // 高亮不能把原文的尖括号漏成真标签
  lacks(md.highlight('a < b', 'js'), '<b>', '高亮里的尖括号必须转义');

  eq(md.normalizeLang('JS'), 'js', '语言名大小写不敏感');
  eq(md.normalizeLang(''), 'plain', '空语言 = plain');
  eq(md.langLabel('sh'), 'Shell', '语言显示名');
  ok(md.languages.indexOf('js') >= 0, '语言表含 js');
});

/* ---------------------------------------------------------------- 统计 */

group('统计与纯文本', () => {
  const s = md.stats('# 标题\n\nHello world 你好世界');
  eq(s.cjk, 6, '汉字计数(标题2 + 你好世界4)');
  eq(s.words, 2, '西文按词计');
  eq(s.count, 8, '字数 = 汉字 + 西文词');
  eq(s.lines, 3, '行数');
  eq(s.charsNoSpace, 17, '非空白字符数');
  eq(md.stats('').count, 0, '空文档字数 0');
  eq(md.stats('').readMinutes, 0, '空文档阅读时长 0');
  ok(md.stats('你好'.repeat(300)).readMinutes >= 1, '阅读时长至少 1 分钟');

  eq(md.plainText('# 标题\n\n- 项 **粗** `x`'), '标题\n\n项 粗 x', '去掉标记保留文字');
  eq(md.plainText('```js\nconst a = 1;\n```'), ' \nconst a = 1;\n ', '代码围栏标记被抹掉');
});

/* ---------------------------------------------------------------- 汇总 */

const total = pass + failures.length;
if (failures.length) {
  console.error(`\n✗ 解析层：${pass}/${total} 通过，${failures.length} 个失败\n`);
  failures.forEach((f, idx) => console.error(`  ${idx + 1}) ${f}\n`));
  process.exit(1);
}
console.log(`✓ 解析层：${pass}/${total} 全部通过`);
