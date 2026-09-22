'use strict';

/**
 * 公式层测试：TeX → MathML。纯函数，直接在 Node 里跑。
 * 运行：node test/mathml.test.js
 */

const assert = require('assert');
const math = require('../js/mathml.js');

let pass = 0;
const failures = [];

function eq(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected);
    pass += 1;
  } catch {
    failures.push(`${label}\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`);
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

const tex = (src, opts) => math.texToMathML(src, opts);

/** 标签必须配对且正确嵌套——生成器最容易在这里出错 */
function balance(html, label) {
  const stack = [];
  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|[^>"])*?)(\/?)>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const selfClosing = m[4] === '/';
    if (selfClosing) continue;
    if (!closing) { stack.push(name); continue; }
    const top = stack.pop();
    if (top !== name) {
      failures.push(`${label}\n    标签没配对：</${name}> 对上了 <${top || '空'}>`);
      return;
    }
  }
  if (stack.length) failures.push(`${label}\n    有没闭合的标签：${stack.join(', ')}`);
  else pass += 1;
}

/* ------------------------------------------------------------------ 基础 */

group('基本结构与转义', () => {
  const r = tex('x');
  ok(r.ok, '简单公式解析成功');
  has(r.html, '<math', '产出 math 根元素');
  has(r.html, 'display="inline"', '默认行内');
  has(r.html, '<mi>x</mi>', '字母变 mi');
  has(r.html, 'annotation encoding="application/x-tex"', '带 TeX 原文注解');

  eq(tex('x', { display: true }).html.indexOf('display="block"') > 0, true, '块级公式 display=block');

  const esc = tex('a<b');
  has(esc.html, '&lt;', '尖括号转义');
  lacks(esc.html, '<b>', '不能漏出真标签');

  const ann = tex('x^2');
  has(ann.html, '>x^2</annotation>', '注解里保留原始 TeX');

  eq(tex('').ok, true, '空公式不报错');
  has(tex('').html, '<mrow></mrow>', '空公式给个空行');
});

group('数字与标识符', () => {
  has(tex('42').html, '<mn>42</mn>', '整数');
  has(tex('3.14').html, '<mn>3.14</mn>', '小数连成一段');
  eq((tex('1,000').html.match(/<mn>/g) || []).length, 1, '千分位算同一个数');
  eq((tex('ab').html.match(/<mi>/g) || []).length, 2, '相邻字母是各自独立的变量');
  has(tex('\\pi r^2').html, '<mi>π</mi>', '希腊字母');
});

group('上下标', () => {
  has(tex('x^2').html, '<msup>', '上标');
  has(tex('x_i').html, '<msub>', '下标');
  has(tex('x_i^2').html, '<msubsup>', '同时有上下标');
  has(tex('x^{n+1}').html, '<mn>1</mn>', '上标里可以是一整组');
  has(tex('a_1^2').html, '<msubsup>', '先下标后上标');
  has(tex("f'").html, '′', '撇号变导数撇');
  has(tex('^2').html, '<msup>', '没有底数的上标也不报错');
});

group('分数与根号', () => {
  const frac = tex('\\frac{1}{2}').html;
  has(frac, '<mfrac>', '分数');
  has(frac, '<mn>1</mn><mn>2</mn>', '分子分母各就各位');

  has(tex('\\dfrac{a}{b}').html, '<mfrac>', '\\dfrac 当分数');
  has(tex('\\sqrt{2}').html, '<msqrt>', '平方根');
  const root = tex('\\sqrt[3]{x}').html;
  has(root, '<mroot>', 'n 次方根');
  has(root, '<mn>3</mn>', '根的次数在里面');
  has(tex('\\frac{\\sqrt{x}}{2}').html, '<mfrac><msqrt>', '嵌套结构');
});

group('大运算符与函数', () => {
  const sum = tex('\\sum_{i=1}^{n} i').html;
  has(sum, '<munderover>', '求和的上下限挂成上下');
  has(sum, '<mo', '求和号是运算符');
  has(sum, '∑', '求和号字符');
  has(sum, 'stretchy="true"', '大运算符可伸展');

  const lim = tex('\\lim_{x \\to 0} f(x)').html;
  has(lim, '<munder>', 'lim 的下限写在下面');
  has(lim, 'lim', 'lim 文字');
  has(lim, '→', '箭头');

  const sin = tex('\\sin x').html;
  has(sin, 'mathvariant="normal"', '函数名用正体');
  has(sin, '<mi mathvariant="normal">sin</mi>', 'sin 是正体 mi');

  const int = tex('\\int_0^1 f').html;
  has(int, '<munderover>', '定积分的上下限');
  has(int, '∫', '积分号');
});

group('括号、矩阵、分段', () => {
  const left = tex('\\left(\\frac{a}{b}\\right)').html;
  has(left, 'fence="true"', '可伸展括号');
  has(left, '(</mo>', '左括号');
  has(left, ')</mo>', '右括号');

  const pmat = tex('\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}').html;
  has(pmat, '<mtable>', '矩阵');
  eq((pmat.match(/<mtr>/g) || []).length, 2, '两行');
  eq((pmat.match(/<mtd/g) || []).length, 4, '四个格子');
  has(pmat, 'a</mi>', '格子里的内容');
  has(pmat, '(', 'pmatrix 带圆括号');

  const cases = tex('\\begin{cases}x & x>0\\\\-x & x\\le 0\\end{cases}').html;
  has(cases, '<mtable>', '分段函数');
  has(cases, '&gt;', '大于号转义');
  has(cases, '≤', '\\le 变 ≤');

  const bmat = tex('\\begin{bmatrix}1\\end{bmatrix}').html;
  has(bmat, '[', 'bmatrix 方括号');

  const unknownEnv = tex('\\begin{nope}a\\end{nope}');
  ok(unknownEnv.unknown.length > 0, '不认识的矩阵环境要记下来');
  has(unknownEnv.html, 'a</mi>', '但不吞内容');
});

group('重音与字体', () => {
  has(tex('\\hat{x}').html, '<mover accent="true">', '帽子');
  has(tex('\\bar{y}').html, '¯', '横杠');
  has(tex('\\vec{v}').html, '⃗', '向量箭头');
  has(tex('\\overline{AB}').html, '¯', '上划线');
  has(tex('\\underline{AB}').html, '<munder', '下划线');

  has(tex('\\mathbb{R}').html, 'mathvariant="double-struck"', '黑板粗体');
  has(tex('\\mathbf{v}').html, 'mathvariant="bold"', '粗体');
  has(tex('\\mathcal{L}').html, 'mathvariant="script"', '花体');
  has(tex('\\mathbf{\\frac{a}{b}}').html, '<mfrac>', '粗体分数结构还在');

  has(tex('\\text{中文 abc}').html, '<mtext>中文 abc</mtext>', '文字模式保留空格与中文');
  has(tex('\\text{a<b}').html, '&lt;', '文字模式也要转义');
});

group('间距与符号', () => {
  has(tex('a\\,b').html, '<mspace width="0.167em"/>', '细空格');
  has(tex('a\\quad b').html, '<mspace width="1em"/>', 'quad 空格');
  has(tex('\\infty').html, '∞', '无穷');
  has(tex('\\partial x').html, '∂', '偏导');
  has(tex('\\alpha\\beta\\gamma').html, 'α', '连着写也认');
  has(tex('\\{x\\}').html, '{', '花括号字面量');
  has(tex('\\%').html, '%', '百分号字面量');
  has(tex('\\angle ABC').html, '∠', '角');
});

group('不认识与写坏了的写法', () => {
  const unknown = tex('\\foobar x');
  ok(unknown.ok, '不认识的命令不算结构错误');
  eq(unknown.unknown, ['foobar'], '把不认识的命令列出来');
  has(unknown.html, 'class="tex-unknown"', '原样渲染并打标记');
  has(unknown.html, '\\foobar', '原文可见');
  has(unknown.html, 'x</mi>', '后面的内容照排');

  const unbalanced = tex('\\frac{1}{2');
  no(unbalanced.ok, '括号不配对要报错');
  ok(unbalanced.errors.length > 0, '给出错误说明');
  has(unbalanced.html, '<math', '仍然产出可显示的东西（调用方可以退回原文）');

  const extra = tex('x}');
  no(extra.ok, '多一个 } 也算错');

  const rightOnly = tex('a \\right)');
  no(rightOnly.ok, '孤零零的 \\right 报错');

  const badEnd = tex('\\begin{pmatrix}a');
  no(badEnd.ok, '矩阵没写 \\end 报错');
});

/* ------------------------------------------------ 一批真实公式的健壮性 */

group('真实公式样本：结构正确且标签配对', () => {
  const corpus = [
    'E = mc^2',
    '\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}',
    '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}',
    '\\int_{0}^{\\infty} e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}',
    '\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1',
    '\\left[ \\frac{\\partial^2}{\\partial x^2} + V(x) \\right] \\psi = E\\psi',
    'f(x) = \\begin{cases} 1 & x > 0 \\\\ 0 & x \\le 0 \\end{cases}',
    'A = \\begin{pmatrix} a_{11} & a_{12} \\\\ a_{21} & a_{22} \\end{pmatrix}',
    '\\forall \\epsilon > 0, \\exists \\delta > 0',
    '\\hat{H}\\psi = i\\hbar \\frac{\\partial \\psi}{\\partial t}',
    '\\mathbb{R}^n \\to \\mathbb{R}^m',
    'P(A \\mid B) = \\frac{P(B \\mid A) P(A)}{P(B)}',
    '\\vec{F} = m\\vec{a}',
    '\\sqrt[3]{\\frac{x+1}{x-1}}',
    '\\text{当 } x \\to 0 \\text{ 时}',
    '\\alpha_1 + \\beta_2^{3} - \\gamma',
    '\\operatorname{arg\\,max}_{x} f(x)',
    'x \\in \\mathbb{R}, \\quad x \\ne 0',
  ];

  corpus.forEach((src, idx) => {
    const r = tex(src);
    ok(r.ok, `第 ${idx + 1} 条能解析：${src.slice(0, 28)}`);
    eq(r.unknown, [], `第 ${idx + 1} 条没有不认识的命令`);
    balance(r.html, `第 ${idx + 1} 条标签配对：${src.slice(0, 28)}`);
  });
});

/* ---------------------------------------------------------------- 汇总 */

const total = pass + failures.length;
if (failures.length) {
  console.error(`\n✗ 公式层：${pass}/${total} 通过，${failures.length} 个失败\n`);
  failures.forEach((f, idx) => console.error(`  ${idx + 1}) ${f}\n`));
  process.exit(1);
}
console.log(`✓ 公式层：${pass}/${total} 全部通过`);
