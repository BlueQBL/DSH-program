/*!
 * 校样 · TeX 子集 → MathML（mathml.js）
 *
 * 为什么不用 KaTeX：它是 100KB 级的依赖 + 一套字体文件，而这个应用是零依赖、
 * 离线可用的。现代浏览器（Chrome 109+ / Safari / Firefox）都原生渲染 MathML Core，
 * 所以只要把 TeX 翻译成 MathML，公式就能排版出来，还能被读屏软件念出来，
 * 复制出去的文本也不会变成一堆路径。
 *
 * 覆盖范围（够写技术笔记）：
 *   分数 \frac、根号 \sqrt[n]、上下标 ^ _、大运算符 \sum \int \lim（带上下限）、
 *   希腊字母、常用运算符与箭头、\left(...\right)、矩阵与分段函数 \begin{pmatrix}、
 *   重音 \hat \bar \vec、字体 \text \mathrm \mathbf \mathbb \mathcal、间距 \, \; \quad。
 * 不覆盖：宏定义、\newcommand、复杂对齐环境、化学式等。遇到不认识的东西
 * 不会静默吃掉——原样渲染出来并记进 unknown，由调用方决定怎么提示。
 *
 * 纯函数，浏览器挂到 window.MDMath，Node 走 module.exports。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MDMath = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function esc(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ------------------------------------------------------------ 符号表 */

  const GREEK = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
    zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
    lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ',
    varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ',
    varphi: 'ϕ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
    Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  };

  /** 运算符与关系符：都进 <mo>，让 MathML 自己按运算符字典给间距 */
  const OPS = {
    times: '×', div: '÷', cdot: '⋅', pm: '±', mp: '∓', ast: '∗', star: '⋆',
    circ: '∘', bullet: '∙', oplus: '⊕', otimes: '⊗', le: '≤', leq: '≤',
    ge: '≥', geq: '≥', ne: '≠', neq: '≠', equiv: '≡', approx: '≈', sim: '∼',
    simeq: '≃', cong: '≅', propto: '∝', lt: '<', gt: '>', ll: '≪', gg: '≫',
    in: '∈', notin: '∉', ni: '∋', subset: '⊂', supset: '⊃', subseteq: '⊆',
    supseteq: '⊇', cup: '∪', cap: '∩', setminus: '∖', emptyset: '∅',
    varnothing: '∅', forall: '∀', exists: '∃', nexists: '∄', neg: '¬',
    land: '∧', lor: '∨', therefore: '∴', because: '∵', infty: '∞',
    partial: '∂', nabla: '∇', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ',
    aleph: 'ℵ', wp: '℘', angle: '∠', perp: '⊥', parallel: '∥',
    to: '→', gets: '←', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔',
    Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', mapsto: '↦',
    uparrow: '↑', downarrow: '↓', longrightarrow: '⟶', longleftarrow: '⟵',
    ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱', dots: '…',
    quad: ' ', qquad: '  ', ' ': ' ', ',': ' ', ';': ' ', ':': ' ', '!': '',
    '{': '{', '}': '}', '%': '%', '&': '&', '#': '#', '$': '$', '_': '_',
    backslash: '\\', vert: '|', Vert: '‖', lvert: '|', rvert: '|',
    lVert: '‖', rVert: '‖', langle: '⟨', rangle: '⟩', lfloor: '⌊',
    rfloor: '⌋', lceil: '⌈', rceil: '⌉', prime: '′', backprime: '‵',
    mid: '∣', nmid: '∤', colon: ':', models: '⊨', vdash: '⊢', dashv: '⊣',
    top: '⊤', bot: '⊥', triangle: '△', square: '□', diamond: '⋄',
    dagger: '†', ddagger: '‡', surd: '√', smile: '⌣', frown: '⌢',
    asymp: '≍', doteq: '≐', propto: '∝', prec: '≺', succ: '≻',
    lbrace: '{', rbrace: '}', lbrack: '[', rbrack: ']', lparen: '(',
    rparen: ')', arrowvert: '|',
  };

  /** 大运算符：上下标要挂成上下限 */
  const BIG = {
    sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭',
    oint: '∮', bigcup: '⋃', bigcap: '⋂', bigoplus: '⨁', bigotimes: '⨂',
    bigodot: '⨀', bigvee: '⋁', bigwedge: '⋀', bigsqcup: '⨆',
  };

  /** 正体函数名（\sin x 里 sin 不能歪着） */
  const FUNCS = [
    'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
    'sinh', 'cosh', 'tanh', 'coth', 'log', 'ln', 'lg', 'exp', 'det', 'dim',
    'ker', 'hom', 'arg', 'deg', 'gcd', 'lcm', 'Pr', 'mod', 'bmod',
  ];

  /** 带上下限的算子（\lim_{x\to0} 要写成上下而不是右下） */
  const LIMIT_OPS = { lim: 'lim', max: 'max', min: 'min', sup: 'sup', inf: 'inf', limsup: 'lim sup', liminf: 'lim inf', det: 'det', gcd: 'gcd' };

  /** 重音 */
  const ACCENTS = {
    hat: '^', widehat: '^', bar: '¯', overline: '¯', vec: '⃗',
    dot: '˙', ddot: '¨', tilde: '~', widetilde: '~', check: 'ˇ',
    breve: '˘', acute: '´', grave: '`', mathring: '˚',
  };

  const UNDER = { underline: '_' };

  /** 字体变体 */
  const VARIANTS = {
    mathrm: 'normal', text: 'normal', operatorname: 'normal', textrm: 'normal',
    mathbf: 'bold', textbf: 'bold', bm: 'bold',
    mathit: 'italic', textit: 'italic',
    mathbb: 'double-struck', mathcal: 'script', mathfrak: 'fraktur',
    mathsf: 'sans-serif', textsf: 'sans-serif',
    mathtt: 'monospace', texttt: 'monospace',
  };

  const SPACES = { ',': '0.167em', ':': '0.222em', ';': '0.278em', '!': '-0.167em', ' ': '0.333em', quad: '1em', qquad: '2em', enspace: '0.5em', thinspace: '0.167em' };

  const ENVIRONMENTS = {
    matrix: { fence: null, align: 'center' },
    pmatrix: { fence: ['(', ')'], align: 'center' },
    bmatrix: { fence: ['[', ']'], align: 'center' },
    Bmatrix: { fence: ['{', '}'], align: 'center' },
    vmatrix: { fence: ['|', '|'], align: 'center' },
    Vmatrix: { fence: ['‖', '‖'], align: 'center' },
    cases: { fence: ['{', ''], align: 'left' },
    array: { fence: null, align: 'center' },
    aligned: { fence: null, align: 'right' },
    align: { fence: null, align: 'right' },
    gathered: { fence: null, align: 'center' },
    split: { fence: null, align: 'right' },
  };

  const OPERATOR_CHARS = '+-=<>*/()[]|!?;:.,';

  /* -------------------------------------------------------------- 词法 */

  function tokenize(src) {
    const out = [];
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\') {
        const next = src[i + 1];
        if (next === undefined) { out.push({ t: 'cmd', v: '' }); i += 1; continue; }
        if (/[A-Za-z]/.test(next)) {
          let j = i + 1;
          while (j < src.length && /[A-Za-z]/.test(src[j])) j += 1;
          out.push({ t: 'cmd', v: src.slice(i + 1, j) });
          i = j;
          continue;
        }
        if (next === '\\') { out.push({ t: 'rowbreak' }); i += 2; continue; }
        out.push({ t: 'cmd', v: next });
        i += 2;
        continue;
      }
      if (ch === '{') { out.push({ t: 'open' }); i += 1; continue; }
      if (ch === '}') { out.push({ t: 'close' }); i += 1; continue; }
      if (ch === '^') { out.push({ t: 'sup' }); i += 1; continue; }
      if (ch === '_') { out.push({ t: 'sub' }); i += 1; continue; }
      if (ch === '&') { out.push({ t: 'cell' }); i += 1; continue; }
      if (ch === '~') { out.push({ t: 'char', v: '\u00A0' }); i += 1; continue; }
      if (/\s/.test(ch)) {
        // 数学模式里空白不排版，但 \text{...} 里要保留，所以照样记下来
        let j = i;
        while (j < src.length && /\s/.test(src[j])) j += 1;
        out.push({ t: 'space' });
        i = j;
        continue;
      }
      out.push({ t: 'char', v: ch });
      i += 1;
    }
    return out;
  }

  /* -------------------------------------------------------------- 语法 */

  function Parser(tokens) {
    this.tokens = tokens;
    this.i = 0;
    this.unknown = [];
    this.errors = [];
    this.textDepth = 0; // >0 表示正在 \text{} 里，空白要留着
  }

  Parser.prototype.peek = function (offset) {
    return this.tokens[this.i + (offset || 0)];
  };

  Parser.prototype.next = function () {
    return this.tokens[this.i++];
  };

  Parser.prototype.eof = function () {
    return this.i >= this.tokens.length;
  };

  Parser.prototype.fail = function (message) {
    if (this.errors.indexOf(message) < 0) this.errors.push(message);
  };

  Parser.prototype.noteUnknown = function (name) {
    if (this.unknown.indexOf(name) < 0) this.unknown.push(name);
    return { k: 'unknown', tex: '\\' + name };
  };

  /** 读一组参数（{...} 或单个原子） */
  Parser.prototype.parseArg = function () {
    if (this.eof()) {
      this.fail('公式在这里就结束了，缺一个参数');
      return { k: 'row', children: [] };
    }
    const tok = this.peek();
    if (tok.t === 'open') {
      this.next();
      const row = this.parseRow({ close: true });
      if (this.peek() && this.peek().t === 'close') this.next();
      else this.fail('有一个 { 没有配上 }');
      return row;
    }
    return this.parseAtom() || { k: 'row', children: [] };
  };

  /** 读可选参数 [n]（\sqrt[3]{x}） */
  Parser.prototype.parseOptional = function () {
    if (this.eof() || this.peek().t !== 'char' || this.peek().v !== '[') return null;
    const save = this.i;
    this.next();
    const row = this.parseRow({ bracket: true });
    if (this.peek() && this.peek().t === 'char' && this.peek().v === ']') {
      this.next();
      return row;
    }
    this.i = save; // 不是可选参数，退回去当普通字符
    return null;
  };

  Parser.prototype.readGroupText = function () {
    // 读 {name}，用于 \begin{...} \end{...}，返回纯文本
    if (!this.peek() || this.peek().t !== 'open') { this.fail('这里应该有个 { '); return ''; }
    this.next();
    let text = '';
    while (!this.eof() && this.peek().t !== 'close') {
      const tok = this.next();
      text += tok.v === undefined ? '' : tok.v;
    }
    if (this.peek() && this.peek().t === 'close') this.next();
    return text.trim();
  };

  Parser.prototype.readDelim = function () {
    if (this.eof()) return '';
    const tok = this.peek();
    if (tok.t === 'char') { this.next(); return tok.v === '.' ? '' : tok.v; }
    if (tok.t === 'cmd') {
      this.next();
      const mapped = OPS[tok.v];
      if (mapped !== undefined) return mapped;
      if (tok.v === '.') return '';
      return tok.v;
    }
    if (tok.t === 'open') { this.next(); return '{'; }
    if (tok.t === 'close') { this.next(); return '}'; }
    return '';
  };

  Parser.prototype.parseRow = function (stops) {
    const stop = stops || {};
    const nodes = [];

    while (!this.eof()) {
      const tok = this.peek();

      if (stop.close && tok.t === 'close') break;
      if (stop.bracket && tok.t === 'char' && tok.v === ']') break;
      if (stop.cell && tok.t === 'cell') break;
      if (stop.rowbreak && tok.t === 'rowbreak') break;
      if ((stop.right || stop.end) && tok.t === 'cmd' && tok.v === 'right') break;
      if ((stop.right || stop.end) && tok.t === 'cmd' && tok.v === 'end') break;

      // 上下标：挂到前一个原子上
      if (tok.t === 'sup' || tok.t === 'sub') {
        this.next();
        const arg = this.parseArg();
        const base = nodes.length ? nodes.pop() : { k: 'row', children: [] };
        const key = tok.t === 'sup' ? 'sup' : 'sub';
        if (base[key]) {
          // 同一个原子挂两次同向脚本：包一层，别丢内容
          nodes.push(base);
          const wrapped = { k: 'row', children: [base] };
          wrapped[key] = arg;
          nodes.pop();
          nodes.push(wrapped);
        } else {
          base[key] = arg;
          nodes.push(base);
        }
        continue;
      }

      // 数字整段收进来（3.14 是一个 <mn>），在 parseAtom 里做，上标参数也走同一条路

      // 撇号：作为上一项的导数撇号
      if (tok.t === 'char' && (tok.v === "'" || tok.v === '′')) {
        this.next();
        const base = nodes.length ? nodes.pop() : { k: 'row', children: [] };
        const prev = base.sup || null;
        const marks = { k: 'row', children: [{ k: 'op', v: '′' }] };
        base.sup = prev ? { k: 'row', children: [prev, marks] } : marks;
        nodes.push(base);
        continue;
      }

      if (tok.t === 'rowbreak') { this.next(); continue; } // 顶层换行：忽略
      if (tok.t === 'cell') { this.next(); continue; }
      if (tok.t === 'space') {
        this.next();
        if (this.textDepth > 0) nodes.push({ k: 'space', width: null, literal: true });
        continue;
      }
      if (tok.t === 'close') { this.next(); this.fail('多出来一个 }'); continue; }

      const atom = this.parseAtom();
      if (atom) nodes.push(atom);
    }

    return { k: 'row', children: nodes };
  };

  Parser.prototype.parseAtom = function () {
    const tok = this.next();
    if (!tok) return null;

    if (tok.t === 'open') {
      const row = this.parseRow({ close: true });
      if (this.peek() && this.peek().t === 'close') this.next();
      else this.fail('有一个 { 没有配上 }');
      return row;
    }

    if (tok.t === 'cmd') return this.parseCommand(tok.v);

    if (tok.t === 'char') {
      const ch = tok.v;
      // 数字：连着的小数点、千分位一起收进同一个 <mn>
      if (/[0-9]/.test(ch)) {
        let text = ch;
        while (!this.eof()) {
          const cur = this.peek();
          if (cur.t !== 'char') break;
          if (/[0-9]/.test(cur.v)) { text += cur.v; this.next(); continue; }
          if (cur.v === '.' || cur.v === ',') {
            const after = this.peek(1);
            if (after && after.t === 'char' && /[0-9]/.test(after.v)) { text += cur.v; this.next(); continue; }
          }
          break;
        }
        return { k: 'num', v: text };
      }
      if (/[A-Za-z]/.test(ch)) return { k: 'ident', v: ch };
      if (OPERATOR_CHARS.indexOf(ch) >= 0) return { k: 'op', v: ch };
      return { k: 'ident', v: ch }; // 中文、其它符号：当标识符排
    }

    return null;
  };

  Parser.prototype.parseCommand = function (name) {
    /* 结构类 --------------------------------------------------------- */
    if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'cfrac') {
      const num = this.parseArg();
      const den = this.parseArg();
      return { k: 'frac', num: num, den: den };
    }

    if (name === 'sqrt') {
      const index = this.parseOptional();
      const base = this.parseArg();
      return index ? { k: 'root', base: base, index: index } : { k: 'sqrt', base: base };
    }

    if (name === 'left') {
      const open = this.readDelim();
      const inner = this.parseRow({ right: true });
      let close = '';
      if (this.peek() && this.peek().t === 'cmd' && this.peek().v === 'right') {
        this.next();
        close = this.readDelim();
      } else {
        this.fail('有一个 \\left 没有配上 \\right');
      }
      return { k: 'fenced', open: open, close: close, child: inner };
    }

    if (name === 'right') {
      this.fail('多出来一个 \\right');
      return null;
    }

    if (name === 'begin') {
      return this.parseEnvironment();
    }

    if (name === 'end') {
      this.readGroupText();
      this.fail('多出来一个 \\end');
      return null;
    }

    if (ACCENTS[name]) {
      const base = this.parseArg();
      return { k: 'over', mark: ACCENTS[name], base: base, accent: true };
    }

    if (UNDER[name]) {
      const base = this.parseArg();
      return { k: 'under', mark: UNDER[name], base: base };
    }

    if (name === 'overset' || name === 'stackrel') {
      const top = this.parseArg();
      const base = this.parseArg();
      return { k: 'over', mark: null, over: top, base: base };
    }

    if (name === 'underset') {
      const bottom = this.parseArg();
      const base = this.parseArg();
      return { k: 'under', mark: null, under: bottom, base: base };
    }

    if (name === 'binom') {
      const top = this.parseArg();
      const bottom = this.parseArg();
      return { k: 'fenced', open: '(', close: ')', child: { k: 'frac', num: top, den: bottom, noBar: true } };
    }

    if (VARIANTS[name]) {
      const variant = VARIANTS[name];
      const isText = name === 'text' || name === 'textrm' || name === 'textbf' ||
        name === 'textit' || name === 'texttt' || name === 'textsf' || name === 'operatorname';
      if (isText) {
        this.textDepth += 1;
        const row = this.parseArg();
        this.textDepth -= 1;
        return { k: 'text', row: row, variant: variant };
      }
      const arg = this.parseArg();
      applyVariant(arg, variant);
      return arg;
    }

    if (name === 'limits' || name === 'nolimits' || name === 'displaystyle' || name === 'textstyle' || name === 'scriptstyle' || name === 'scriptscriptstyle' || name === 'displaystyle') {
      return null; // 排版提示，MathML 里由结构自己决定
    }

    if (name === 'phantom' || name === 'hspace' || name === 'vspace' || name === 'kern' || name === 'mkern') {
      this.parseArg();
      return { k: 'space', width: '0.5em' };
    }

    if (name === 'not') {
      const arg = this.parseArg();
      return { k: 'row', children: [{ k: 'op', v: '\u0338' }, arg] };
    }

    if (name === 'pmod' || name === 'bmod') {
      const arg = name === 'pmod' ? this.parseArg() : null;
      const inner = { k: 'row', children: [{ k: 'text', row: { k: 'row', children: [{ k: 'ident', v: 'mod' }] }, variant: 'normal' }] };
      return arg
        ? { k: 'fenced', open: '(', close: ')', child: { k: 'row', children: [inner, { k: 'space', width: '0.278em' }, arg] } }
        : inner;
    }

    /* 符号类 --------------------------------------------------------- */
    if (BIG[name] !== undefined) {
      return { k: 'op', v: BIG[name], big: true };
    }

    if (LIMIT_OPS[name] !== undefined) {
      return { k: 'op', v: LIMIT_OPS[name], limits: true, func: true };
    }

    if (FUNCS.indexOf(name) >= 0) {
      return { k: 'func', v: name };
    }

    if (GREEK[name] !== undefined) {
      return { k: 'ident', v: GREEK[name] };
    }

    if (SPACES[name] !== undefined) {
      return { k: 'space', width: SPACES[name] };
    }

    if (OPS[name] !== undefined) {
      const v = OPS[name];
      if (v === '') return null;
      if (v === ' ') return { k: 'space', width: '0.333em' };
      return { k: 'op', v: v };
    }

    return this.noteUnknown(name);
  };

  Parser.prototype.parseEnvironment = function () {
    const env = this.readGroupText();
    const config = ENVIRONMENTS[env];
    if (!config) {
      this.noteUnknown('begin{' + env + '}');
      // 不认识的矩阵环境：按普通内容读下去，别把里面的东西吞掉
      const inner = this.parseRow({ end: true });
      this.skipEnd();
      return inner;
    }

    const rows = [];
    let cells = [];
    let guard = 0;

    while (!this.eof() && guard < 2000) {
      guard += 1;
      const cellNodes = this.parseRow({ cell: true, rowbreak: true, end: true });
      cells.push(cellNodes);

      const tok = this.peek();
      if (tok && tok.t === 'cell') { this.next(); continue; }
      if (tok && tok.t === 'rowbreak') { this.next(); rows.push(cells); cells = []; continue; }
      break;
    }
    if (cells.length) rows.push(cells);
    this.skipEnd();

    return { k: 'table', env: env, rows: rows, config: config };
  };

  Parser.prototype.skipEnd = function () {
    if (this.peek() && this.peek().t === 'cmd' && this.peek().v === 'end') {
      this.next();
      this.readGroupText();
      return true;
    }
    this.fail('有一个 \\begin 没有配上 \\end');
    return false;
  };

  /** 字体变体：递归打到 token 上（MathML Core 认 token 上的 mathvariant） */
  function applyVariant(node, variant) {
    if (!node || typeof node !== 'object') return;
    if (node.k === 'ident' || node.k === 'num' || node.k === 'op' || node.k === 'func') {
      node.variant = variant;
      return;
    }
    if (node.k === 'text') { node.variant = variant; return; }
    if (node.children) node.children.forEach((child) => applyVariant(child, variant));
    if (node.num) applyVariant(node.num, variant);
    if (node.den) applyVariant(node.den, variant);
    if (node.base) applyVariant(node.base, variant);
    if (node.index) applyVariant(node.index, variant);
    if (node.child) applyVariant(node.child, variant);
    if (node.mark && typeof node.mark === 'object') applyVariant(node.mark, variant);
    if (node.over) applyVariant(node.over, variant);
    if (node.under) applyVariant(node.under, variant);
    if (node.sup) applyVariant(node.sup, variant);
    if (node.sub) applyVariant(node.sub, variant);
    if (node.rows) node.rows.forEach((row) => row.forEach((cell) => applyVariant(cell, variant)));
  }

  /* ------------------------------------------------------------ 生成 */

  function token(node, tag, extra) {
    const variant = node && node.variant && node.variant !== 'italic' ? ' mathvariant="' + node.variant + '"' : '';
    return '<' + tag + variant + (extra || '') + '>' + esc(node.v) + '</' + tag + '>';
  }

  /** 只有上下标是"包在外面"的，所以先出核心，再按脚本包一层 */
  function toMathML(node) {
    if (!node) return '';
    return wrapScripts(node, coreMathML(node));
  }

  function wrapScripts(node, core) {
    const base = core || '<mrow></mrow>';
    if (node.sub && node.sup) {
      return (node.big || node.limits ? '<munderover>' : '<msubsup>') + base +
        toMathML(node.sub) + toMathML(node.sup) +
        (node.big || node.limits ? '</munderover>' : '</msubsup>');
    }
    if (node.sub) {
      return node.big || node.limits
        ? '<munder>' + base + toMathML(node.sub) + '</munder>'
        : '<msub>' + base + toMathML(node.sub) + '</msub>';
    }
    if (node.sup) {
      return node.big || node.limits
        ? '<mover>' + base + toMathML(node.sup) + '</mover>'
        : '<msup>' + base + toMathML(node.sup) + '</msup>';
    }
    return base;
  }

  function coreMathML(node) {
    switch (node.k) {
      case 'num': return token(node, 'mn');
      case 'ident': return token(node, 'mi');
      case 'op': {
        const stretchy = node.big ? ' stretchy="true"' : '';
        const movable = node.big || node.limits ? ' movablelimits="true"' : '';
        return token(node, 'mo', stretchy + movable);
      }
      case 'func': return token(node, 'mi', ' mathvariant="normal"');
      case 'space': return node.literal
        ? '<mtext> </mtext>'
        : '<mspace width="' + node.width + '"/>';
      case 'unknown':
        return '<mtext class="tex-unknown" data-tex="' + esc(node.tex) + '">' + esc(node.tex) + '</mtext>';
      case 'text': {
        const variant = node.variant && node.variant !== 'normal' ? ' mathvariant="' + node.variant + '"' : '';
        return '<mtext' + variant + '>' + esc(plainText(node.row)) + '</mtext>';
      }
      case 'frac':
        return '<mfrac' + (node.noBar ? ' linethickness="0"' : '') + '>' + toMathML(node.num) + toMathML(node.den) + '</mfrac>';
      case 'sqrt': return '<msqrt>' + rowOf(node.base) + '</msqrt>';
      case 'root': return '<mroot>' + rowOf(node.base) + rowOf(node.index) + '</mroot>';
      case 'over': {
        const mark = node.over ? toMathML(node.over) : '<mo accent="true">' + esc(node.mark) + '</mo>';
        return '<mover accent="true">' + rowOf(node.base) + mark + '</mover>';
      }
      case 'under': {
        const mark = node.under ? toMathML(node.under) : '<mo accentunder="true" stretchy="true">' + esc(node.mark) + '</mo>';
        return '<munder accentunder="true">' + rowOf(node.base) + mark + '</munder>';
      }
      case 'fenced': {
        const open = node.open ? '<mo stretchy="true" fence="true">' + esc(node.open) + '</mo>' : '';
        const close = node.close ? '<mo stretchy="true" fence="true">' + esc(node.close) + '</mo>' : '';
        return '<mrow>' + open + toMathML(node.child) + close + '</mrow>';
      }
      case 'table': {
        const config = node.config || ENVIRONMENTS.matrix;
        const rows = node.rows.map((cells) => {
          const tds = cells.map((cell) => {
            const align = config.align ? ' columnalign="' + config.align + '"' : '';
            return '<mtd' + align + '>' + toMathML(cell) + '</mtd>';
          }).join('');
          return '<mtr>' + tds + '</mtr>';
        }).join('');
        const table = '<mtable>' + rows + '</mtable>';
        if (!config.fence) return table;
        const open = config.fence[0] ? '<mo stretchy="true" fence="true">' + esc(config.fence[0]) + '</mo>' : '';
        const close = config.fence[1] ? '<mo stretchy="true" fence="true">' + esc(config.fence[1]) + '</mo>' : '';
        return '<mrow>' + open + table + close + '</mrow>';
      }
      case 'row':
      default: {
        // 只有一个孩子的组不必再套一层 mrow，MathML 的每个槽位本来就只放一个元素
        const kids = node.children || [];
        if (kids.length === 1) return toMathML(kids[0]);
        return '<mrow>' + kids.map(toMathML).join('') + '</mrow>';
      }
    }
  }

  /** msqrt/mroot 之类的参数位置要一个元素，不能直接塞文本 */
  function rowOf(node) {
    if (!node) return '<mrow></mrow>';
    const html = toMathML(node);
    return html || '<mrow></mrow>';
  }

  /** 取一段结构的纯文本（\text{...} 用） */
  function plainText(node) {
    if (!node) return '';
    if (typeof node.v === 'string' && (node.k === 'ident' || node.k === 'num' || node.k === 'op' || node.k === 'func')) return node.v;
    if (node.k === 'space') return ' ';
    if (node.k === 'unknown') return node.tex;
    if (node.k === 'text') return plainText(node.row);
    if (node.children) return node.children.map(plainText).join('');
    if (node.base) return plainText(node.base);
    return '';
  }

  /* ------------------------------------------------------------ 对外 */

  /**
   * TeX → MathML
   * @returns {{ok:boolean, html:string, unknown:string[], errors:string[]}}
   *   ok=false 表示有结构性错误（括号不配对之类），调用方应该退回显示原始 TeX；
   *   unknown 里是没认出来的命令，调用方可以据此提示"有 N 处写法没渲染出来"。
   */
  function texToMathML(tex, options) {
    const opts = options || {};
    const src = String(tex == null ? '' : tex);
    const parser = new Parser(tokenize(src));
    const tree = parser.parseRow({});
    const body = toMathML(tree);
    const display = opts.display ? 'block' : 'inline';

    const html =
      '<math xmlns="http://www.w3.org/1998/Math/MathML" display="' + display + '"' +
      (opts.className ? ' class="' + esc(opts.className) + '"' : '') + '>' +
      '<semantics>' + (body || '<mrow></mrow>') +
      '<annotation encoding="application/x-tex">' + esc(src) + '</annotation>' +
      '</semantics></math>';

    return {
      ok: parser.errors.length === 0,
      html: html,
      unknown: parser.unknown,
      errors: parser.errors,
    };
  }

  return {
    texToMathML: texToMathML,
    tokenize: tokenize,
    symbols: { greek: GREEK, ops: OPS, big: BIG, funcs: FUNCS, environments: ENVIRONMENTS },
  };
});
