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

  function measure() {
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
    } catch (err) {
      step('交互自检过程本身出错', false, err.message);
    }

    out.interactions = drill;
    for (const d of drill) {
      if (!d.ok) out.issues.push({ kind: 'interaction', note: '交互「' + d.what + '」不通过　' + d.detail });
    }

    document.title = 'RESULT:' + JSON.stringify(out);
  }

  /* app.js 每次渲染完成后调用这里。
     挂成全局函数而不是用事件：需要的是"此刻的版面"，
     事件会被合并或延迟，测量就会落到错误的时机。 */
  window.__CLOUD_VERIFY__ = measure;
})();
