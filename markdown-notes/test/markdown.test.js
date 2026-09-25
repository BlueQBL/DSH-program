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
  eq(md.render('# 标题'), '<h1 id="sec-1" data-line="1" data-end="1">标题</h1>', '一级标题');
  eq(md.render('### 三级'), '<h3 id="sec-1" data-line="1" data-end="1">三级</h3>', '三级标题');
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
  has(doc, '<h1 id="sec-1" data-line="1"', '标题行号');
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

/* ------------------------------------------------------------ 风格（flavor） */

group('风格：严格 CommonMark', () => {
  const strict = { flavor: 'commonmark' };

  lacks(md.render('- [ ] 任务', strict), 'md-check', '严格模式没有任务清单');
  has(md.render('- [ ] 任务', strict), '[ ] 任务', '但原文照样看得见');

  lacks(md.render('~~删~~', strict), '<del>', '严格模式没有删除线');
  has(md.render('~~删~~', strict), '~~删~~', '删除线标记原样保留');

  lacks(md.render('| a | b |\n| - | - |\n| 1 | 2 |', strict), '<table>', '严格模式没有表格');

  lacks(md.render('#标题', strict), '<h1', '严格模式要求井号后有空格');
  has(md.render('# 标题', strict), '<h1', '有空格就是标题');

  lacks(md.render('见 https://a.dev', strict), '<a ', '严格模式不做裸链接');
  has(md.render('<https://a.dev>', strict), '<a ', '尖括号自动链接属于核心语法，保留');

  lacks(md.render('正文[^1]\n\n[^1]: 注解', strict), 'fn-ref', '严格模式没有脚注');
  has(md.render('正文[^1]\n\n[^1]: 注解', strict), '[^1]: 注解', '脚注定义当普通文字显示，不吞内容');

  lacks(md.render('公式 $x^2$ 在这里', strict), '<math', '严格模式没有公式');

  has(md.render('**粗** 和 `代码`', strict), '<strong>', '核心强调语法不受影响');
});

group('风格：GitHub 风格（默认）', () => {
  ok(md.render('- [x] 好').indexOf('md-check') >= 0, '默认有任务清单');
  ok(md.render('~~删~~').indexOf('<del>') >= 0, '默认有删除线');
  ok(md.render('| a |\n| - |\n| 1 |').indexOf('<table>') >= 0, '默认有表格');
  ok(md.render('正文[^1]\n\n[^1]: 注').indexOf('fn-ref') >= 0, '默认有脚注');
  ok(md.render('$x$').indexOf('<math') >= 0, '默认有公式');
  eq(md.DEFAULT_FLAVOR, 'gfm', '默认风格是 GitHub 风格');
  ok(md.flavors().length >= 5, '风格列表至少五种');
  eq(md.flavors().map((f) => f.value), ['gfm', 'commonmark', 'paper', 'chinese', 'extended'], '风格顺序');
  eq(md.flavors().map((f) => f.label),
    ['GitHub 风格', '标准风格', '论文风格', '中文写作', '全扩展'], '风格用大家熟悉的名字');
  lacks(md.render('# 标题'), 'sec-num', '默认不给标题编号');
});

group('风格：论文风格', () => {
  const paper = { flavor: 'paper' };

  // 标题自动编号：1 / 1.1 / 1.1.1，同级递增、下级归零
  const doc = ['# 方法', '', '## 数据', '', '### 细节', '', '## 实验', '', '# 结论'].join('\n');
  const html = md.render(doc, paper);
  const nums = (html.match(/<span class="sec-num">[\d.]+<\/span>/g) || [])
    .map((s) => /<span class="sec-num">([\d.]+)<\/span>/.exec(s)[1]);
  eq(nums, ['1', '1.1', '1.1.1', '1.2', '2'], '章节号按层级递增、下级归零、同级继续');

  // 图片自动编号 + 图注
  const withImages = { flavor: 'paper', resolveImage: (src) => 'blob:' + src };
  const figs = md.render('看图：\n\n![架构图](a.png)\n\n![第二张](b.png)\n', withImages);
  eq((figs.match(/class="md-figure"/g) || []).length, 2, '两张独立成段的图都排成图');
  has(figs, '<figcaption>图 1　架构图</figcaption>', '第一张图带编号和图注');
  has(figs, '<figcaption>图 2　第二张</figcaption>', '第二张图编号递增');
  has(figs, 'data-line="3"', '图也带行号（光标联动要用）');

  has(md.render('![](c.png)\n', withImages), '<figcaption>图 1</figcaption>', '没有说明文字时只写编号');
  lacks(md.render('句子里的 ![小图](d.png) 不算图。\n', withImages), 'md-figure', '行内的图不排成图注');
  has(md.render('句子里的 ![小图](d.png) 不算图。\n', withImages), '<img', '但仍然正常显示');
  lacks(md.render('![缺图](x.png)\n', paper), 'md-figure', '找不到的图不当成图注');

  // 论文风格该有的有、该没有的没有
  has(md.render('正文[^a]\n\n[^a]: 注', paper), 'fn-ref', '脚注还在');
  has(md.render('E = $mc^2$', paper), '<math', '公式还在');
  has(md.render('| a |\n| - |\n| 1 |', paper), '<table>', '表格还在');
  has(md.render('H~2~O', paper), '<sub', '上下标还在');
  lacks(md.render('- [ ] 待办', paper), 'md-check', '论文风格不要任务清单');
  lacks(md.render('~~删~~', paper), '<del>', '论文风格不要删除线');

  lacks(md.render(doc, { flavor: 'gfm' }), 'sec-num', 'GitHub 风格不编号');
  lacks(md.render('![图](a.png)', { flavor: 'gfm', resolveImage: () => 'blob:x' }), 'md-figure',
    'GitHub 风格不排图注');
});

group('风格：中文写作', () => {
  const cn = { flavor: 'chinese' };

  has(md.render('用React写代码', cn), '用<span class="cjk-gap"></span>React', '中英挨着时补空隙');
  lacks(md.render('用React写代码', { flavor: 'gfm' }), 'cjk-gap', '通用风格不补');
  eq(md.render('用 React 写代码', cn), md.render('用 React 写代码', { flavor: 'gfm' }),
    '本来就写了空格的地方不再重复加');
  has(md.render('第3章', cn), 'cjk-gap', '中文与数字挨着也补');
  lacks(md.render('`用React写`', cn).split('<code')[1].split('</code>')[0], 'cjk-gap', '代码里不插空隙');
  has(md.render('用React写代码', cn), 'React', '文字本身没被破坏');

  has(md.render('第一行\n第二行', cn), '<br>', '单换行即换行');
  lacks(md.render('第一行\n第二行', { flavor: 'gfm' }), '<br>', '通用风格把单换行当空格');
});

group('风格：全扩展', () => {
  const ext = { flavor: 'extended' };

  has(md.render('==重点==', ext), '<mark class="md-mark">重点</mark>', '高亮');
  lacks(md.render('==重点==', { flavor: 'gfm' }), '<mark', '通用风格没有高亮');

  has(md.render('H~2~O', ext), '<sub class="md-sub">2</sub>', '下标');
  has(md.render('x^2^', ext), '<sup class="md-sup">2</sup>', '上标');
  has(md.render('~~删~~ x~1~', ext), '<del>', '删除线与下标能共存');
  has(md.render('a~i~ + b', ext), '<sub class="md-sub">i</sub>', '字母下标');
  lacks(md.render('5~10个', ext), '<sub', '数值区间不会被当成下标');
  has(md.render('5~10个', ext), '5~10个', '数值区间原样保留');

  const dl = md.render('术语\n: 解释内容', ext);
  has(dl, '<dl class="md-dl"', '定义列表');
  has(dl, '<dt>术语</dt>', '定义项');
  has(dl, '<dd data-line="2"', '定义内容带行号');
  lacks(md.render('术语\n: 解释内容', { flavor: 'gfm' }), '<dl', '通用风格没有定义列表');
});

/* ---------------------------------------------------------------- 脚注 */

group('脚注', () => {
  const html = md.render('第一处[^a] 和第二处[^b]\n\n[^a]: 甲注\n[^b]: 乙注');

  has(html, '<section class="md-footnotes"', '脚注区');
  has(html, '<div class="md-footnotes__label">脚注</div>', '脚注标题不是标题元素（不污染大纲）');
  lacks(html, '<h2', '脚注标题不能用 heading');
  has(html, 'id="fnref-a"', '正文里的引用锚点');
  has(html, 'id="fn-a"', '脚注条目锚点');
  has(html, '>1</a>', '第一条编号是 1');
  has(html, '>2</a>', '第二条编号是 2');
  has(html, 'class="fn-back"', '回到正文的回跳链接');
  has(html, 'data-line="3"', '脚注区记住定义所在行（光标联动要用）');

  // 编号按"引用的先后"给，不是按定义的先后
  const order = md.render('先引乙[^b] 再引甲[^a]\n\n[^a]: 甲\n[^b]: 乙');
  has(order, 'id="fnref-b"', '先出现的引用');
  has(order, 'href="#fn-b" data-footnote="b">1<', '先引用的编号是 1');

  // 定义不能漏进正文
  lacks(html, '[^a]: 甲注', '定义行不会当成正文显示');
  eq((html.match(/<p data-line/g) || []).length, 1, '正文只有一个段落');

  const unused = md.render('正文\n\n[^x]: 没人引用我');
  has(unused, 'is-unused', '没被引用的定义也排出来');
  has(unused, '未引用', '并标出来');
  has(unused, '没人引用我', '内容不丢');

  const missing = md.render('正文[^没有]');
  has(missing, 'is-missing', '引用不存在的脚注要标出来');
  lacks(missing, 'md-footnotes', '没有定义就不排脚注区');

  const multi = md.render('正文[^m]\n\n[^m]: 第一段\n\n    第二段');
  eq((multi.match(/<p /g) || []).length, 3, '多段脚注：正文一段 + 脚注两段');
  has(multi, '第二段', '第二段内容在');

  const onlyDefs = md.render('[^only]: 只有定义');
  has(onlyDefs, 'md-footnotes', '只有定义也能渲染出脚注区');

  // 脚注里的行内语法照样解析
  has(md.render('正文[^s]\n\n[^s]: 带 **粗体** 的注'), '<strong>粗体</strong>', '脚注内容支持行内语法');
});

/* ---------------------------------------------------------------- 公式 */

group('数学公式', () => {
  const inline = md.render('质能方程 $E = mc^2$ 很重要');
  has(inline, '<math', '行内公式渲染成 MathML');
  has(inline, 'display="inline"', '行内模式');
  has(inline, '<msup>', '上标结构');
  has(inline, '很重要', '公式前后的文字都在');
  has(inline, 'application/x-tex', '带 TeX 注解，方便再编辑');

  const display = md.render('$$\n\\frac{a}{b}\n$$');
  has(display, 'class="md-math md-math--block"', '块级公式');
  has(display, 'display="block"', '块级模式');
  has(display, '<mfrac>', '分数结构');
  has(display, 'data-line="1" data-end="3"', '块级公式带行号区间');

  const oneLine = md.render('$$x^2$$');
  has(oneLine, 'md-math--block', '同一行的 $$ 也是块级');

  // 别把价格当公式
  lacks(md.render('这件 $5 那件 $6'), '<math', '美元符号不误判成公式');
  lacks(md.render('价格 $5.00'), '<math', '单个美元符号不误判');
  has(md.render('价格 \\$5'), '$5', '转义的美元符号显示成 $5');
  lacks(md.render('价格 \\$5 和 \\$6'), '<math', '转义后更不该误判');

  // 代码里的 $ 不算公式
  has(md.render('`$x$`'), '<code class="md-code">$x$</code>', '行内代码里的 $ 不算公式');
  lacks(md.render('`$x$`'), '<math', '行内代码里的 $ 不算公式（不产生 math）');
  lacks(md.render('```bash\necho $HOME\n```'), '<math', '代码块里的 $ 不算公式');

  // 写坏了要退回原文，不能装作渲染成功
  const bad = md.render('$$\n\\frac{1}{2\n$$');
  has(bad, 'md-math-bad', '解析失败的公式有醒目标记');
  has(bad, '\\frac{1}{2', '并把原文显示出来');

  const unknown = md.render('$\\foobar x$');
  has(unknown, 'data-unknown="foobar"', '没认出来的命令记在属性上');

  lacks(md.render('$x$', { flavor: 'commonmark' }), '<math', '严格风格没有公式');
  ok(md.mathAvailable, '公式模块已接入');
});

/* ------------------------------------------------------------ 图片与图库 */

group('图片与图库解析', () => {
  const gallery = { '照片.png': 'blob:local-1', '子目录/图.png': 'blob:local-2' };

  const found = md.render('![假期](照片.png)', {
    resolveImage: (src) => gallery[src] || null,
  });
  has(found, 'src="blob:local-1"', '图库里的图用本地地址');
  has(found, 'data-src="照片.png"', '原文路径记在 data-src 上');
  has(found, 'alt="假期"', 'alt 保留');

  const inFolder = md.render('![](子目录/图.png)', { resolveImage: (src) => gallery[src] || null });
  has(inFolder, 'src="blob:local-2"', '带目录的路径也能命中');

  const missingImg = md.render('![缺失](没有的图.png)', { resolveImage: () => null });
  has(missingImg, 'class="md-img-missing"', '找不到就渲染成明确的缺失占位');
  has(missingImg, '没有的图.png', '把文件名显示出来');
  has(missingImg, '图库里没有这张图', '并说明原因');

  const external = md.render('![远程](https://a.dev/x.png)');
  has(external, 'src="https://a.dev/x.png"', '外链图片直接用');
  has(external, 'referrerpolicy="no-referrer"', '外链不带 referrer');

  const dataUrl = md.render('![内联](data:image/png;base64,AAAA)');
  has(dataUrl, 'src="data:image/png;base64,AAAA"', 'data:image 允许');

  lacks(md.render('![坏](javascript:alert(1))'), '<img', '图片不认 javascript:');

  const calls = [];
  md.render('![a](https://a.dev/x.png) ![b](本地.png)', {
    resolveImage: (src) => { calls.push(src); return null; },
  });
  eq(calls, ['本地.png'], '绝对地址不查图库，只有相对路径才查');

  lacks(md.render('![x](某图.png)'), '<img', '没有图库回调时不假装有图');
});

/* ------------------------------------------------------------ 标题锚点 */

group('标题锚点（目录导航要用）', () => {
  const doc = md.render('# 一\n\n## 二\n\n### 三\n\n#### 四\n\n##### 五\n\n###### 六');
  ['sec-1', 'sec-2', 'sec-3', 'sec-4', 'sec-5', 'sec-6'].forEach((id, idx) => {
    has(doc, 'id="' + id + '"', `第 ${idx + 1} 个标题有锚点`);
  });

  const custom = md.render('## 安装说明 {#install}');
  has(custom, 'id="install"', '自定义锚点生效');
  has(custom, '>安装说明<', '锚点标记不出现在标题文字里');
  lacks(custom, '{#install}', '锚点标记被剥掉');

  const dup = md.render('## 甲 {#same}\n\n## 乙 {#same}');
  has(dup, 'id="same"', '第一个用原锚点');
  has(dup, 'id="same-2"', '重复的自动改名');

  const strict = md.render('## 标题 {#x}', { flavor: 'commonmark' });
  lacks(strict, 'id="x"', '严格风格不认自定义锚点');
  has(strict, '{#x}', '那就当普通文字显示');

  const bad = md.render('## 标题 {#不合法!}');
  lacks(bad, 'id="不合法', '锚点只允许字母数字连字符，避免注入属性');

  const link = md.render('跳到[安装](#install)');
  has(link, 'href="#install"', '站内锚点链接');
  lacks(link, 'target="_blank"', '站内锚点不要新开标签页');
  has(md.render('[外链](https://a.dev)'), 'target="_blank"', '外链才新开标签页');
});

/* -------------------------------------------------- 整篇被围栏包住 */

group('识别"整篇被一层围栏包住"', () => {
  const a = md.detectWrappingFence('```md\n# 标题\n\n正文\n```');
  ok(a, '三反引号包住能认出来');
  eq(a.fence, '```', '记住围栏符号');
  eq(a.info, 'md', '记住语言标注');
  eq(a.inner, '# 标题\n\n正文', '取出里面的原文');

  eq(md.detectWrappingFence('~~~\n内容\n~~~').fence, '~~~', '波浪号围栏');
  eq(md.detectWrappingFence('```\n内容\n```\n').inner, '内容', '结尾有换行也算');
  eq(md.detectWrappingFence('````\n里面的 ``` 不算一层\n````').fence, '````', '四个反引号时里面三个不算内层');

  eq(md.detectWrappingFence('```md\n没收口'), null, '没闭合不算');
  eq(md.detectWrappingFence('普通正文而已'), null, '没围栏不算');
  eq(md.detectWrappingFence('```md\n内容\n```\n\n后面还有一段'), null, '围栏后面还有内容就不算"整篇"');
  eq(md.detectWrappingFence(''), null, '空正文不算');
  eq(md.detectWrappingFence(null), null, 'null 不算');
  eq(md.detectWrappingFence('```\n```js\nconst a = 1;\n```\n```'), null, '里面还套着同长度的围栏就不拆');

  // 拆出来之后应该是能正常排版的
  const wrapped = md.detectWrappingFence('```md\n# 标题\n\n- 列表\n```');
  const rendered = md.render(wrapped.inner);
  has(rendered, '<h1', '拆出来的内容能当标题渲染');
  has(rendered, '<ul', '拆出来的内容能当列表渲染');
  lacks(rendered, 'md-codeblock', '拆出来后不再是代码块');
});

/* ---------------------------------------------------------------- 汇总 */

const total = pass + failures.length;
if (failures.length) {
  console.error(`\n✗ 解析层：${pass}/${total} 通过，${failures.length} 个失败\n`);
  failures.forEach((f, idx) => console.error(`  ${idx + 1}) ${f}\n`));
  process.exit(1);
}
console.log(`✓ 解析层：${pass}/${total} 全部通过`);
