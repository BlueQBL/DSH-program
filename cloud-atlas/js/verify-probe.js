/* 版面自检探针（只在 ?verify=1 时加载，正常使用不会请求它）
 *
 * 由 index.html 在 app.js 之前引入；app.js 每次渲染完成后调用 window.__CLOUD_VERIFY__()，
 * 这里就测量一次真实尺寸与对比度，结果写进 document.title，
 * 外面用无头浏览器 --dump-dom 把结果读回来。
 *
 * 为什么是"app 来调"而不是"探针自己等"：
 *   无头浏览器的 --virtual-time-budget 会把定时器快进，
 *   任何"等 100ms 再量"的轮询都可能在页面就绪前跑完或跑飞。
 *   由 app 在渲染完成的同一处回调，时序是确定的，完全不依赖时间。
 *
 * 为什么不用 iframe 从外面量：跨文档时序同样不可控。
 *
 * 检查项：
 *   1. 横向溢出、元素跑出视口
 *   2. 必须"有面积"的元素被压塌（曲线、读数、量程条、指北针……）
 *   3. 关键区块之间意外重叠
 *   4. 文字对比度（WCAG 2.1，正文 4.5:1、次要文字 3:1）
 *   5. 触控目标小于 24×24
 *   6. 数据真的渲染出来了（不是占位符、路径里没有 NaN、量程条不是一样长）
 */
(function () {
  'use strict';

  /**
   * 探针入口。
   *
   * 是异步的，因为"多城市对比"和"历史天气"这两块是在主读数渲染完之后才去取数的
   * （这样首屏不用等它们）。如果在主读数就绪的那一刻就测量，它们还在路上，
   * 量到的会是"正在取数"的中间状态——那是探针的测量时机不对，
   * 不是页面的问题。所以先等这两块落地，再开始测。
   *
   * 最多等 20 秒；即使超时也照测，measure 里会把"还没落地"如实报出来。
   */
  /**
   * 只跑一次。
   *
   * app.js 每次渲染完成都会调 verifyHook，而页面在启动阶段会渲染好几轮
   * （收藏栏补数据、对比区补数据、切换城市……）。不加这个闩的话，
   * 交互自检会并发跑好几遍——而后面的那一遍会看到前面那遍改过的页面状态
   * （比如它自己用搜索加进去的城市），于是"默认只有 1 个城市"这种断言
   * 会在第二轮里失败。那是探针自己污染了自己，不是页面的问题。
   */
  let started = false;

  async function run() {
    if (started) return;
    started = true;
    const cmpNote = () => document.querySelector('#cmp-note');
    const settled = () => {
      /* 对比区：清单里的城市数 = 图上的曲线数，才算数据真的到齐。
         只看"图显示了"不行——图可能是上一轮渲染留下的，而这一轮还在取数。

         "一个城市都没有"要单独判：那是"还没开始"和"确实空了"两种情况的共同表现，
         不能一律当成"就绪"。只有提示行明确说了原因（出错／没有可用数据／引导文案），
         才算真的定下来了。否则探针会在默认值还没算出来时就量一次，
         把"0 个城市"报成"默认值不对"——那是测量时机的问题，不是页面的问题。 */
      const chips = document.querySelectorAll('#cmp-chips .cmp-chip').length;
      const lines = document.querySelectorAll('.cmp-line').length;
      const note = (cmpNote() || {}).textContent || '';
      const compareReady = chips >= 2
        ? (chips === lines || /出错/.test(note))
        : chips === 1
          ? (/还能|上限|先移出/.test(note) || lines === 1)
          : /出错|没有可用数据|搜索框加/.test(note);

      const historyReady = document.querySelectorAll('#history-stats .stat').length > 0
        || /取不到|没有历史数据|出错/.test(document.querySelector('#history-hint').textContent);
      return compareReady && historyReady;
    };

    const deadline = Date.now() + 20000;
    while (!settled() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 120));
    }
    await measure();
  }

  window.__CLOUD_VERIFY__ = run;

  /**
   * 是 async 的：交互自检里有一段要等对比区的搜索出候选（要打地名服务），
   * 只能 await，不能靠固定 sleep 猜时间。
   */
  async function measure() {
    const out = { viewport: { w: innerWidth, h: innerHeight }, issues: [], metrics: {} };

    /* ------------------------------------------------------------ 颜色工具 */

    const parseColor = (value) => {
      const m = String(value).match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };

    const over = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    });

    const lum = (c) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };

    const ratio = (a, b) => {
      const l1 = lum(a);
      const l2 = lum(b);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };

    /**
     * 沿祖先链把半透明背景逐层叠起来，得到文字真正的底色。
     * 只看元素自身的 background-color 会算错：面板是半透明的，
     * 实际底色是 sky → 坐标纸 → 版心 → 面板一层层叠出来的。
     */
    const floorColor = (el) => {
      const chain = [];
      for (let n = el; n; n = n.parentElement) chain.push(n);
      chain.push(document.documentElement);
      let acc = null;
      for (let i = chain.length - 1; i >= 0; i--) {
        const c = parseColor(getComputedStyle(chain[i]).backgroundColor);
        if (!c || c.a === 0) continue;
        acc = acc === null ? c : over(acc, c);
        if (acc.a >= 0.999) break;
      }
      return acc || { r: 255, g: 255, b: 255, a: 1 };
    };

    const rgb = (c) => 'rgb(' + [c.r, c.g, c.b].map(Math.round).join(',') + ')';

    const sampleText = (sel, label, minRatio) => {
      const el = document.querySelector(sel);
      if (!el) { out.issues.push({ kind: 'missing', note: label + '（' + sel + '）不存在' }); return; }
      const text = (el.textContent || '').trim();
      if (!text) { out.issues.push({ kind: 'empty', note: label + ' 是空的' }); return; }
      const cs = getComputedStyle(el);
      const fg = parseColor(cs.color);
      if (!fg) return;
      const bg = floorColor(el);
      const r = ratio(over(fg, bg), bg);
      out.metrics[label] = { text: text.slice(0, 16), size: cs.fontSize, ratio: Math.round(r * 100) / 100, fg: cs.color, bg: rgb(bg) };
      if (r < minRatio) {
        out.issues.push({
          kind: 'contrast',
          note: label + ' 对比度 ' + r.toFixed(2) + ':1，低于 ' + minRatio + ':1',
          text: text.slice(0, 22),
          fg: cs.color,
          bg: rgb(bg),
        });
      }
    };

    /* -------------------------------------------------------- 1. 横向溢出 */

    const docW = document.documentElement.scrollWidth;
    if (docW > innerWidth + 1) {
      out.issues.push({ kind: 'overflow-x', note: '页面横向溢出 ' + (docW - innerWidth) + 'px（内容宽 ' + docW + '，视口 ' + innerWidth + '）' });
      document.querySelectorAll('body *').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && (r.right > innerWidth + 1 || r.left < -1)) {
          const cls = String(el.className || '').split(' ').filter(Boolean)[0] || '';
          out.issues.push({
            kind: 'outside-viewport',
            note: '<' + el.tagName.toLowerCase() + (cls ? ' class="' + cls + '"' : '') + '> 超出视口：left ' + Math.round(r.left) + ' right ' + Math.round(r.right),
          });
        }
      });
    }

    /* --------------------------------------------------- 2. 必须有面积的元素 */

    const mustHaveArea = [
      ['.chart', '气温曲线'],
      ['#plotbox', '曲线容器'],
      ['.readout__value', '大号气温读数'],
      ['.instr', '仪器读数区'],
      ['.week__row', '7 日第一行'],
      ['.week__bar i', '7 日量程条'],
      ['.ribbon__track', '今日量程条'],
      ['.ribbon__dot', '今日气温指针'],
      ['.vane svg', '风向指北针'],
      ['#now-icon svg', '当前天气符号'],
      ['.masthead', '报头'],
      ['#seek-input', '地名输入框'],
      ['#collect-btn', '收藏按钮'],
      ['.week__scale', '7 日刻度'],
    ];
    for (const [sel, label] of mustHaveArea) {
      const el = document.querySelector(sel);
      if (!el) { out.issues.push({ kind: 'missing', note: label + '（' + sel + '）不存在' }); continue; }
      const r = el.getBoundingClientRect();
      out.metrics[label] = { w: Math.round(r.width), h: Math.round(r.height) };
      if (r.width < 2 || r.height < 2) {
        out.issues.push({ kind: 'collapsed', note: label + ' 被压成 ' + Math.round(r.width) + '×' + Math.round(r.height) });
      }
    }

    /* ---------------------------------------------------------- 3. 区块重叠 */

    const rectOf = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.getBoundingClientRect() : null;
    };
    const pairs = [
      ['.obs__head', '.obs__body', '城市报头与观测区'],
      ['.readout', '.instr', '主读数与仪器区'],
      ['.readoutbar', '#plotbox', '曲线读数条与曲线'],
      ['#plotbox', '#week-panel', '曲线区与 7 日区'],
      ['.rail', '.plot', '左栏与主区'],
      ['.masthead', '.obs__head', '报头与城市名'],
      ['.readout__note', '#collect-btn', '观测结论与收藏按钮'],
    ];
    for (const [a, b, label] of pairs) {
      const ra = rectOf(a);
      const rb = rectOf(b);
      if (!ra || !rb) continue;
      const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      // 允许 3px 以内的相接：发丝线和边框会让两个矩形蹭到一起，那不是重叠
      if (ox > 3 && oy > 3) {
        out.issues.push({ kind: 'overlap', note: label + ' 重叠 ' + Math.round(ox) + '×' + Math.round(oy) + 'px' });
      }
    }

    /* ------------------------------------------------------------ 4. 对比度 */
    /* 只检查"任何情况下都该有内容"的元素。收藏栏还没收藏城市时本来就是空的、
       检索提示也可能被清空——那不是缺陷，所以不放进这一组，改为单独看结构。 */

    sampleText('.obs__place', '城市名', 4.5);
    sampleText('.readout__value', '气温读数', 4.5);
    sampleText('.readout__label', '天气状况', 4.5);
    sampleText('.readout__feels', '体感与今日范围', 3);
    sampleText('.readout__note', '观测结论', 3);
    sampleText('.instr__key', '仪器标签', 3);
    sampleText('.instr__val', '仪器读数', 4.5);
    sampleText('.instr__sub', '仪器副读数', 3);
    sampleText('.week__day', '7 日星期', 4.5);
    sampleText('.week__cond', '7 日天气文字', 3);
    sampleText('.week__temp', '7 日最高温', 4.5);
    sampleText('.week__temp--low', '7 日最低温', 3);
    sampleText('.panel__title', '区块标题', 4.5);
    sampleText('.panel__aside', '区块说明', 3);
    sampleText('.panel__foot', '区块脚注', 3);
    sampleText('.obs__where', '地点副标题', 3);
    sampleText('.obs__meta', '观测时间', 3);
    sampleText('#rb-time', '曲线读数时间', 4.5);
    sampleText('#rb-temp', '曲线读数气温', 4.5);
    sampleText('#rb-cond', '曲线读数天气', 3);
    sampleText('#rb-pop', '曲线读数降水', 3);
    sampleText('.colophon', '页脚', 3);
    sampleText('.eyebrow', '左栏小标题', 3);
    sampleText('.ribbon__keys span:nth-child(2)', '量程条说明', 3);
    sampleText('#collect-btn', '收藏按钮', 4.5);

    /* -------------------------------------------------------- 5. 触控目标 */

    for (const [sel, label] of [
      ['.unit-toggle__btn', '单位按钮'],
      ['.tool', '定位按钮'],
      ['.seek__go', '查询按钮'],
      ['.rail__drop', '移除收藏'],
      ['#collect-btn', '收藏按钮'],
    ]) {
      document.querySelectorAll(sel).forEach((el, i) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        if (r.height < 24 || r.width < 24) {
          out.issues.push({ kind: 'tap-target', note: label + (i ? ' #' + i : '') + ' 只有 ' + Math.round(r.width) + '×' + Math.round(r.height) });
        }
      });
    }

    /* ------------------------------------------------------------ 6. 有数据 */

    const tempText = ((document.querySelector('.readout__value') || {}).textContent || '').trim();
    out.metrics['气温文本'] = tempText;
    if (!/^-?\d+$/.test(tempText)) {
      out.issues.push({ kind: 'no-data', note: '气温读数不是数字：' + JSON.stringify(tempText) });
    }

    const lines = document.querySelectorAll('.chart .ch-line');
    out.metrics['曲线路径数'] = lines.length;
    if (!lines.length) {
      out.issues.push({ kind: 'no-data', note: '曲线没有画出路径' });
    } else {
      const d = lines[0].getAttribute('d') || '';
      if (/NaN|undefined|null/.test(d)) out.issues.push({ kind: 'nan-path', note: '曲线路径含无效坐标：' + d.slice(0, 90) });
      // 路径必须真的跨过绘图区，而不是缩在一个点里
      const box = lines[0].getBBox();
      out.metrics['曲线包围盒'] = { w: Math.round(box.width), h: Math.round(box.height) };
      if (box.width < 100) out.issues.push({ kind: 'flat-chart', note: '曲线横向只有 ' + Math.round(box.width) + ' 单位宽' });
    }

    const bars = document.querySelectorAll('.week__bar i');
    out.metrics['量程条数'] = bars.length;
    const widths = Array.from(bars).map((b) => parseFloat(b.style.width) || 0);
    // 必须真的有量程条才谈得上"刻度是否共用"——空集合上的 every() 恒为 true，
    // 不加长度判断会报出一条假问题。
    if (widths.length && widths.every((w) => w === widths[0])) {
      out.issues.push({ kind: 'same-scale', note: '7 天量程条长度完全相同（' + widths[0] + '%），说明没有用公共温度轴' });
    }
    if (widths.some((w) => w <= 0)) {
      out.issues.push({ kind: 'flat-bar', note: '有量程条宽度为 0' });
    }

    const rows = document.querySelectorAll('.week__row').length;
    out.metrics['7 日行数'] = rows;
    if (rows !== 7) out.issues.push({ kind: 'no-data', note: '7 日应有 7 行，实际 ' + rows });

    const railTemps = Array.from(document.querySelectorAll('.rail__temp')).map((n) => n.textContent.trim());
    out.metrics['收藏栏气温'] = railTemps;

    out.metrics['基调'] = document.body.dataset.tone || '(未设置)';
    out.metrics['状态'] = document.body.dataset.state || '(未设置)';
    out.metrics['底色'] = getComputedStyle(document.body).backgroundColor;
    out.metrics['字号'] = {
      城市名: getComputedStyle(document.querySelector('.obs__place')).fontSize,
      气温读数: getComputedStyle(document.querySelector('.readout__value')).fontSize,
      正文: getComputedStyle(document.body).fontSize,
    };

    if (out.metrics['状态'] !== 'ready') {
      out.issues.push({ kind: 'not-ready', note: '测量时页面状态是「' + out.metrics['状态'] + '」，不是就绪' });
    }

    /* ------------------------------------------------------ 7. 交互自检 */
    /* 只读版面看不出"点了没反应"或"切了单位但数字没变"这类问题。
       下面这段按顺序走一遍真实交互：拖动曲线光标、切到某一天、切换单位、收藏城市，
       每一步都读回它应该改变的那个值。全部同步点完再测量，最后统一汇报。 */

    const drill = [];
    const step = (what, ok, detail) => drill.push({ what, ok: !!ok, detail: detail == null ? '' : String(detail) });

    try {
      /* 7.1 曲线光标：点在第 12 格，读数应当落到对应小时 */
      const hit = document.querySelector('.ch-hit');
      const beforeTime = document.querySelector('#rb-time').textContent.trim();
      if (hit) {
        const box = hit.getBoundingClientRect();
        const x = box.left + box.width * 0.5;
        hit.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: box.top + 5, bubbles: true, pointerId: 1 }));
        hit.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: box.top + 5, bubbles: true, pointerId: 1 }));
        const afterTime = document.querySelector('#rb-time').textContent.trim();
        step('拖动曲线光标后读数跟着变', afterTime !== beforeTime, beforeTime + ' → ' + afterTime);
        step('光标线现身', !document.querySelector('.ch-cursor').hasAttribute('hidden'));
        // 键盘也要能逐小时走
        hit.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        const kbTime = document.querySelector('#rb-time').textContent.trim();
        step('方向键能逐小时移动', kbTime !== afterTime, afterTime + ' → ' + kbTime);
      } else {
        step('曲线命中区存在', false);
      }

      /* 7.2 切到第 3 天：曲线标题、日详情、行高亮三者要一起动。
             注意点击会重建整个 7 日列表，所以每次都要重新查询节点——
             拿着旧节点去读属性，读到的是已经脱出文档的副本。 */
      const rowsBefore = document.querySelectorAll('.week__row');
      const asideBefore = document.querySelector('#curve-aside').textContent.trim();
      if (rowsBefore.length === 7) {
        rowsBefore[3].click();
        const rowsAfter = document.querySelectorAll('.week__row');
        const asideAfter = document.querySelector('#curve-aside').textContent.trim();
        step('点第 4 天切换了曲线', asideAfter !== asideBefore, asideBefore + ' → ' + asideAfter);
        step('被点的那天标记为展开', rowsAfter[3].getAttribute('aria-expanded') === 'true',
          '第 4 天 aria-expanded=' + rowsAfter[3].getAttribute('aria-expanded'));
        step('其余日子没有跟着展开',
          rowsAfter[0].getAttribute('aria-expanded') === 'false');
        step('日详情出现', !document.querySelector('#daybox').hidden);
        const box = document.querySelector('#daybox');
        step('日详情有内容', box && box.textContent.trim().length > 10, box ? box.textContent.trim().slice(0, 30) : '');
        step('日详情里有日出日落', box && /日出|日落/.test(box.textContent));
        // 切回今天，保证后面的测量还是在今天的数据上
        document.querySelectorAll('.week__row')[0].click();
        const back = document.querySelector('#curve-aside').textContent.trim();
        step('切回今天之后曲线也跟着回来', back === asideBefore, back);
      } else {
        step('7 日有 7 行', false, rowsBefore.length);
      }

      /* 7.3 单位切换：气温、风速、气压、7 日数字都要跟着换算 */
      const tempEl = document.querySelector('.readout__value');
      const rawC = Number(tempEl.dataset.tempC);
      const tempC = tempEl.textContent.trim();
      const unitC = document.querySelector('#temp-unit').textContent.trim();
      const windC = document.querySelector('#m-wind').textContent.trim();
      const weekC = document.querySelector('.week__temp').textContent.trim();
      const fBtn = document.querySelector('[data-unit-set="f"]');
      if (fBtn) {
        fBtn.click();
        const tempF = document.querySelector('.readout__value').textContent.trim();
        const unitF = document.querySelector('#temp-unit').textContent.trim();
        const windF = document.querySelector('#m-wind').textContent.trim();
        const weekF = document.querySelector('.week__temp').textContent.trim();
        step('切到华氏后单位标签变了', unitC !== unitF, unitC + ' → ' + unitF);
        /* 用原始摄氏值核对换算，不能用显示值——显示值已经取整过，
           拿它去算会得出"应该 89 但显示 88"这种误判。 */
        step('切到华氏后读数按公式换算',
          Number(tempF) === Math.round(rawC * 9 / 5 + 32),
          rawC + '°C → ' + tempF + '°F（应为 ' + Math.round(rawC * 9 / 5 + 32) + '）');
        step('摄氏显示值也是原始值取整',
          Number(tempC) === Math.round(rawC), rawC + ' → ' + tempC);
        step('切到华氏后风速也跟着换', windC !== windF, windC + ' → ' + windF);
        step('切到华氏后 7 日数字也换', weekC !== weekF, weekC + ' → ' + weekF);
        step('华氏按钮高亮', fBtn.getAttribute('aria-pressed') === 'true');
        document.querySelector('[data-unit-set="c"]').click();
        const tempBack = document.querySelector('.readout__value').textContent.trim();
        step('切回摄氏后恢复原值', tempBack === tempC, tempBack);
      } else {
        step('存在华氏按钮', false);
      }

      /* 7.4 收藏：点一下应当出现在左栏，再点一下应当移除 */
      const collect = document.querySelector('#collect-btn');
      if (collect) {
        const railBefore = document.querySelectorAll('.rail__item').length;
        collect.click();
        const railAfter = document.querySelectorAll('.rail__item').length;
        step('点收藏后左栏多一个城市', railAfter === railBefore + 1, railBefore + ' → ' + railAfter);
        step('收藏按钮变成已收藏态', collect.classList.contains('collect--on'));
        const active = document.querySelector('.rail__item[aria-current="true"]');
        step('新收藏的城市被标为当前', !!active, active ? active.textContent.trim().slice(0, 12) : '');
        collect.click();
        step('再点一下取消收藏', document.querySelectorAll('.rail__item').length === railBefore);
      } else {
        step('收藏按钮存在', false);
      }

      /* 7.5 检索框接线：确认输入会触发查询流程。
             这里只查同步可见的部分（提示行、ARIA 状态），不等网络结果——
             探针是同步的，等异步会和 --virtual-time-budget 打架。
             检索本身的结果由 test/geocode.test.js 和 test/server.test.js 覆盖。 */
      const input = document.querySelector('#seek-input');
      if (input) {
        input.value = '临县';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        step('输入地名后提示行进入查询状态',
          /查询中/.test(document.querySelector('#seek-hint').textContent),
          document.querySelector('#seek-hint').textContent);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        step('Escape 能收起候选列表', document.querySelector('#seek-list').hidden === true);
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        step('检索输入框存在', false);
      }

      /* 7.6 定位按钮在没有权限时不该把页面搞崩：只检查它是可用的按钮 */
      const locate = document.querySelector('#locate-btn');
      step('定位按钮可用', !!locate && !locate.disabled);

      /* ---------------------------------------------------- 7.7 扩展功能 */

      /* 天象动画：主读数那个符号必须是开动画的版本，
         而 7 日条带里的小符号不能开——一排都在动是干扰而不是信息。 */
      const bigIcon = document.querySelector('#now-icon svg');
      step('主读数天气符号开了动画', !!bigIcon && bigIcon.classList.contains('wx-icon--animate'));
      const smallIcons = document.querySelectorAll('.week__icon svg');
      step('7 日符号保持静态',
        smallIcons.length > 0 && Array.prototype.every.call(smallIcons, (s) => !s.classList.contains('wx-icon--animate')),
        smallIcons.length + ' 个小符号');

      /* 空气质量：AQI 必须是数字，且和六级分类对得上 */
      const aqiText = document.querySelector('#m-aqi').textContent.trim();
      const aqiLevel = document.querySelector('#m-aqi-level').textContent.trim();
      if (/^\d+$/.test(aqiText)) {
        const aqiNum = Number(aqiText);
        step('空气质量给出了 AQI', aqiNum >= 0 && aqiNum <= 500, aqiText + ' ' + aqiLevel);
        const expectLevel = window.CloudAqi.levelOf(aqiNum);
        step('AQI 与六级分类一致', !!expectLevel && expectLevel.name === aqiLevel,
          aqiLevel + ' vs ' + (expectLevel && expectLevel.name));
        step('AQI 指针落在色带上', /%/.test(document.querySelector('#aqi-dot').style.left || ''),
          document.querySelector('#aqi-dot').style.left);
        step('空气质量明细列出污染物', document.querySelectorAll('.air__item').length >= 2,
          document.querySelectorAll('.air__item').length + ' 项');
        step('明细里标出了首要污染物',
          document.querySelectorAll('.air__item--primary').length <= 1);
      } else {
        // 拿不到空气质量时显示 "--" 是允许的，但必须明说没有数据
        step('拿不到空气质量时明确说暂无数据',
          aqiText === '--' && /暂无/.test(document.querySelector('#m-aqi-primary').textContent),
          aqiText + ' / ' + document.querySelector('#m-aqi-primary').textContent);
      }

      /* 紫外线 */
      const uvText = document.querySelector('#m-uv').textContent.trim();
      step('紫外线有读数或明确缺失', /^\d+$/.test(uvText) || uvText === '--', uvText);

      /* 预警：可能出现也可能不出现（看天气），两种状态都要自洽 */
      const alertsBox = document.querySelector('#alerts');
      const alertItems = document.querySelectorAll('.alert');
      if (alertItems.length) {
        step('有预警时预警条可见', !alertsBox.hidden);
        step('预警条写明非官方发布', /非官方发布/.test(alertsBox.textContent));
        step('每条预警都给出推导依据',
          Array.prototype.every.call(alertItems, (a) => /依据：/.test(a.textContent)));
        step('预警级别色条已着色',
          Array.prototype.every.call(alertItems, (a) => /--alert-color:\s*#/.test(a.getAttribute('style') || '')));
      } else {
        step('无预警时预警条隐藏', alertsBox.hidden);
      }

      /* 多城市对比。
       *
       * 这一段自己会改页面状态（加城市、删城市），所以顺序很关键：
       * 先量"默认长什么样"，再验交互。defaultSnapshot 就是为这个留的——
       * 不带快照的话，后面加进去的城市会把前面那条断言一起带偏。 */
      const cmpChips = () => document.querySelectorAll('#cmp-chips .cmp-chip').length;
      const cmpLines = () => document.querySelectorAll('.cmp-line').length;
      const chipNames = () => Array.prototype.map.call(
        document.querySelectorAll('.cmp-chip__name'), (n) => n.textContent.trim());

      const cmpInput = document.querySelector('#cmp-input');
      step('对比区有独立的城市搜索框', !!cmpInput && cmpInput.type === 'search');
      step('对比区搜索框与顶部搜索框是两个不同的输入框',
        cmpInput && cmpInput !== document.querySelector('#seek-input'));

      const chips = cmpChips();
      const chipsNow = () => Array.prototype.map.call(
        document.querySelectorAll('.cmp-chip__name'), (n) => n.textContent.trim());
      // 失败时要把内部状态一起报出来，否则只知道"0 个"，不知道是"清单空"还是"没渲染"
      const uiState = window.__CLOUD_UI__ || {};
      const stateInfo = uiState.debug
        ? JSON.stringify(uiState.debug())
        : '清单里 ' + (uiState.pickCount ? uiState.pickCount() : '?') + ' 个';
      /* 默认只放当前城市：图先画着它自己的曲线，名额留给用户主动加。
         默认塞满会让"想加一个城市"变成"必须先删一个"——那是把默认值当成了结论。 */
      step('对比清单默认只有 1 个城市', chips === 1, chips + ' 个：' + chipsNow().join('、') + '（' + stateInfo + '）');

      if (chips === 1) {
        const only = chipsNow()[0] || '';
        const here = document.querySelector('#place-name').textContent.trim();
        step('默认放的就是当前城市', only === here, `对比里是「${only}」，当前城市是「${here}」`);
        step('只有一个城市时也画出曲线', cmpLines() === 1, cmpLines() + ' 条');
        step('只有一个城市时隐藏对照表',
          document.querySelector('#compare-table-wrap').hidden,
          document.querySelector('#compare-table-wrap').hidden ? '已隐藏' : '仍显示');
        step('计数显示为 1 / 5',
          /1 \/ 5/.test(document.querySelector('#compare-aside').textContent),
          document.querySelector('#compare-aside').textContent.trim());
        step('提示行说明还能加几个',
          /还能/.test(document.querySelector('#cmp-note').textContent)
          || /还能加/.test(document.querySelector('#compare-aside').textContent),
          document.querySelector('#cmp-note').textContent.trim() + ' ｜ '
          + document.querySelector('#compare-aside').textContent.trim());
      } else if (chips >= 2) {
        step('对比图画出多条曲线', cmpLines() === chips, cmpLines() + ' 条 / ' + chips + ' 个城市');
        step('对比表列出了城市', document.querySelectorAll('.compare__table tbody tr').length === chips + 1,
          '含表头共 ' + document.querySelectorAll('.compare__table tbody tr').length + ' 行');
        // 上限要写在明处：用户得事先知道能比几个，而不是加第六个时才被拒
        const noteText = document.querySelector('#cmp-note').textContent;
        step('提示行写明了上限',
          /5|五/.test(noteText) || /5|五/.test(document.querySelector('#compare-aside').textContent),
          noteText.trim() + ' ｜ ' + document.querySelector('#compare-aside').textContent.trim());

        // 图例点击隐藏／恢复
        const keys = document.querySelectorAll('.compare__key');
        const beforeLines = cmpLines();
        keys[0].click();
        step('点图例能隐藏一个城市', cmpLines() === beforeLines - 1, beforeLines + ' → ' + cmpLines());
        document.querySelectorAll('.compare__key')[0].click();
        step('再点一下能恢复', cmpLines() === beforeLines, String(cmpLines()));
      }

      /* 搜索加入：直接驱动输入框，走的是用户真实路径。
         这一段要先确认清单没满——满了就加不进去，那是设计如此，不是缺陷。 */
      const beforeChips = cmpChips();
      cmpInput.value = '拉萨';
      cmpInput.dispatchEvent(new Event('input', { bubbles: true }));
      /* 输入是防抖的（320ms 后发请求），这里等结果出来。
         不能用固定 sleep 猜时间——地名服务可能慢，所以轮询到候选出现为止。 */
      const waitFor = async (fn, ms) => {
        const until = Date.now() + ms;
        while (Date.now() < until) {
          if (fn()) return true;
          await new Promise((r) => setTimeout(r, 100));
        }
        return false;
      };
      const appeared = await waitFor(() => !document.querySelector('#cmp-list').hidden
        && document.querySelectorAll('#cmp-list .seek__opt').length > 0, 12000);

      if (appeared) {
        const optCount = document.querySelectorAll('#cmp-list .seek__opt').length;
        const blockedCount = document.querySelectorAll('#cmp-list .seek__opt--blocked').length;
        step('对比区搜索能出候选', true, optCount + ' 个候选，其中 ' + blockedCount + ' 个已不可选');
        // 挑一个"没被挡住"的候选来加，否则点的是已经加过的那个
        const firstOpt = Array.prototype.find.call(
          document.querySelectorAll('#cmp-list .seek__opt'),
          (n) => !n.classList.contains('seek__opt--blocked'));
        if (!firstOpt) {
          step('有可加入的候选（未验到：候选都已在对比里）', true, '跳过');
        } else {
          const optName = firstOpt.querySelector('.seek__opt-name').textContent.trim();
          firstOpt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          await new Promise((r) => setTimeout(r, 60));
          step('选中候选后加进了对比清单', cmpChips() === beforeChips + 1,
            beforeChips + ' → ' + cmpChips() + `（点了「${optName}」，提示：${document.querySelector('#cmp-note').textContent.trim()}）`);
          step('加进来的正是候选里那个城市',
            Array.prototype.some.call(document.querySelectorAll('.cmp-chip__name'), (n) => n.textContent.trim() === optName),
            optName);
          step('新城市取到数据后画进了图',
            (await waitFor(() => cmpLines() === cmpChips(), 12000)) || cmpLines() === cmpChips(),
            cmpLines() + ' 条线 / ' + cmpChips() + ' 个城市');
          // 加到两个城市之后，对照表就该出现了
          step('加到 2 个城市后对照表出现',
            cmpChips() < 2 || !document.querySelector('#compare-table-wrap').hidden,
            cmpChips() + ' 个城市，表格' + (document.querySelector('#compare-table-wrap').hidden ? '仍隐藏' : '已显示'));
        }
      } else {
        // 地名服务没响应时不算失败，但要说清是没验到
        step('对比区搜索能出候选（未验到：地名服务无响应）', true, '跳过');
      }

      /* 移除：点标签上的叉，城市应当从清单里消失 */
      const afterAdd = cmpChips();
      const drop = document.querySelector('#cmp-chips [data-drop-pick]');
      if (drop) {
        drop.click();
        await new Promise((r) => setTimeout(r, 80));
        step('点叉能把城市移出对比', cmpChips() === afterAdd - 1, afterAdd + ' → ' + cmpChips());
      } else {
        step('已选城市带移除按钮', false);
      }

      /* 上限：把清单填到 40 个城市也没用，必须停在 5 个 */
      step('对比清单不超过 5 个', cmpChips() <= 5, cmpChips() + ' 个');

      /* 上限真的会拦住新增：直接从页面状态里读。
         光看 chips 数量不够——收藏恰好只有 5 个时，数量对并不能说明"上限生效了"。
         所以这里主动往清单里塞第 6 个，看它会不会被拦住。 */
      const ui = window.__CLOUD_UI__;
      if (ui && typeof ui.addPick === 'function') {
        /* 假城市之间必须隔得足够远。应用按经纬度判重（约 5 公里内算同一个地方，
           这是为了修"同名不同省"的问题），挨得太近会被当成同一个城市合并掉，
           于是循环永远填不满——那是判重逻辑对，不是上限没生效。 */
        const fakeCities = [];
        for (let i = 0; i < 8; i++) {
          fakeCities.push({
            id: 'probe-' + i,
            name: '探针城市' + i,
            latitude: 10 + i * 3,
            longitude: 100 + i * 3,
          });
        }

        for (const city of fakeCities) {
          if (ui.canAdd(city) !== null) break;
          ui.addPick(city);
          await new Promise((r) => setTimeout(r, 20));
        }

        step('强行加入会被上限拦住', cmpChips() === ui.maxCompare,
          '加到 ' + cmpChips() + ' 个就停了（上限 ' + ui.maxCompare + '）');
        step('拒绝时给出了原因',
          /上限|最多|先移出/.test(document.querySelector('#cmp-note').textContent),
          document.querySelector('#cmp-note').textContent.trim());

        /* 清理：把探针加的假城市移掉，否则后面的测量会带上它们。
           按 id 找，不按名字——名字里带"探针"只是巧合的命名，按 id 更可靠。 */
        for (const city of fakeCities) {
          const btn = document.querySelector(`#cmp-chips [data-drop-pick="${city.id}"]`);
          if (btn) {
            btn.click();
            await new Promise((r) => setTimeout(r, 20));
          }
        }

        /* 探针必须把对比清单还原成"用户从没动过"的状态。
           为什么非还原不可：截图/自检共用同一个 Chrome 用户目录，
           而清单存在 localStorage 里。探针如果留下"用户把城市全删光了 + touched"，
           下一次运行读到的就是这个状态——它看起来完全合法（用户确实可以删空），
           于是"默认只有 1 个城市"这条断言从第二次起一直失败。
           这已经不是页面 bug，是测试在污染自己的环境，所以清理要做到位。 */
        ui.resetPicks();
        try { localStorage.removeItem('cloud-atlas.compare.v2'); } catch (e) { /* 存不了就算了 */ }
        try { localStorage.removeItem('cloud-atlas.compare'); } catch (e) { /* 同上 */ }
        await new Promise((r) => setTimeout(r, 80));
        step('探针把清单还原成默认（不污染下次运行）',
          ui.pickCount() === 1, ui.pickCount() + ' 个');
      } else {
        step('对比清单可编程访问（用于验证上限）', false, '没找到 __CLOUD_UI__');
      }

      /* 历史：取到数据时统计格与曲线都要在，否则要有明确说明 */
      const histStats = document.querySelectorAll('#history-stats .stat').length;
      if (histStats) {
        step('历史区给出统计格', histStats >= 4, histStats + ' 格');
        step('历史曲线已画出', !!document.querySelector('#history-plot svg'));
        step('历史曲线含均值参考线', !!document.querySelector('.hist-bar-avg'));
        step('历史区给出天气构成', document.querySelectorAll('.compose__item').length >= 1);
        step('历史区给出文字结论', document.querySelectorAll('#history-reading li').length >= 1);
        step('历史说明标明了区间',
          /\d{4}-\d{2}-\d{2}/.test(document.querySelector('#history-aside').textContent),
          document.querySelector('#history-aside').textContent.trim());
      } else {
        step('历史区在取数中或失败时有说明',
          document.querySelector('#history-hint').textContent.trim().length > 0,
          document.querySelector('#history-hint').textContent.trim().slice(0, 30));
      }

      const rangeBtns = document.querySelectorAll('#history-ranges [data-range]');
      if (rangeBtns.length) {
        const pressed = Array.prototype.filter.call(rangeBtns, (b) => b.getAttribute('aria-pressed') === 'true').length;
        step('时间范围有且只有一个被选中', pressed === 1, pressed + ' 个选中');
      }
    } catch (err) {
      step('交互自检过程本身出错', false, err.message);
    }

    out.interactions = drill;
    for (const d of drill) {
      if (!d.ok) out.issues.push({ kind: 'interaction', note: '交互「' + d.what + '」不通过　' + d.detail });
    }

    /* app.js 会把渲染阶段的异常记在 window.__CLOUD_ERRORS__ 里。
       探针抓不到异步异常，所以只能读这份记录——
       没有这一步的话，"某个区块静默失败"在自检里是完全隐形的。 */
    const jsErrors = (window.__CLOUD_ERRORS__ || []).slice();
    out.metrics['页面异常'] = jsErrors.length;
    for (const e of jsErrors) out.issues.push({ kind: 'js-error', note: e });

    document.title = 'RESULT:' + JSON.stringify(out);
  }

  /* 入口挂在 window 上，由 app.js 在每次渲染完成后调用。
     挂函数而不是用事件：需要的是"那一处渲染之后的版面"，
     事件会被合并或延迟，测量就会落到错误的时机。
     这里挂的是异步的 run（它内部等扩展区块落地后再 measure），
     所以 app.js 那边不需要 await——结果是通过 document.title 交出去的。 */
})();
