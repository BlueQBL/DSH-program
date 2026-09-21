/**
 * 冒烟测试用的浏览器探针（开发用，不属于站点）
 *
 * 这个文件只被 smoke-test.js 读取并注入到临时站点副本里，
 * 在真实浏览器里跑一遍"切语言 + 发留言 + 读统计"，把结果塞进 <title>。
 * 写成独立文件是因为把它塞成一行字符串太容易出错。
 */
(function () {
  var OUT = 'UP::';

  function snapshot() {
    var out = {};
    out.l1 = document.querySelector('.hero__name') ? document.querySelector('.hero__name').textContent.trim() : '';
    out.l2 = document.querySelector('.hero__role') ? document.querySelector('.hero__role').textContent.replace(/\s+/g, ' ').trim() : '';
    out.l3 = document.querySelector('[data-i18n="about.title"]') ? document.querySelector('[data-i18n="about.title"]').textContent.trim() : '';
    out.l4 = document.querySelector('.card__title') ? document.querySelector('.card__title').textContent.trim() : '';
    out.l5 = document.querySelector('[data-gb-submit]') ? document.querySelector('[data-gb-submit]').textContent.trim() : '';
    out.l6 = document.querySelector('[data-i18n="foot.note"]') ? document.querySelector('[data-i18n="foot.note"]').textContent.trim() : '';
    out.l7 = document.querySelector('[data-i18n="about.fWhereV"]') ? document.querySelector('[data-i18n="about.fWhereV"]').textContent.trim() : '';
    out.l8 = document.querySelector('[data-stats-label]') ? document.querySelector('[data-stats-label]').textContent.trim() : '';
    out.docLang = document.documentElement.getAttribute('lang');
    out.saved = null;
    try { out.saved = localStorage.getItem('portfolio.lang'); } catch (e) { out.saved = 'ERR'; }

    // 切换语言之后，"项目和联系板块还在不在"必须单独验 ——
    // 之前只比对了卡片标题的文字，而标题在隐藏的卡片里照样读得到，
    // 所以"切完语言那两个区一片空白"这个 bug 溜过去了。
    out.vis = visibilitySnapshot();
    return out;
  }

  /** 项目和联系区的真实可见性：透明或没高度都算它不见了 */
  function visibilitySnapshot() {
    function look(sel) {
      var el = document.querySelector(sel);
      if (!el) return { found: false };
      var cs = getComputedStyle(el);
      var r = el.getBoundingClientRect();
      return {
        found: true,
        opacity: Number(cs.opacity),
        h: Math.round(r.height),
        shown: el.getAttribute('data-shown') === 'true',
        hasReveal: el.hasAttribute('data-reveal'),
        text: el.textContent.replace(/\s+/g, ' ').trim().slice(0, 26),
      };
    }
    function all(sel) {
      var list = Array.prototype.slice.call(document.querySelectorAll(sel));
      var visible = 0;
      list.forEach(function (el) {
        var cs = getComputedStyle(el);
        if (Number(cs.opacity) > 0.9 && el.getBoundingClientRect().height > 20) visible++;
      });
      return { total: list.length, visible: visible };
    }
    return {
      cards: all('.cards .card'),
      links: all('[data-links] .link'),
      card0: look('.cards .card'),
      link0: look('[data-links] .link'),
      sections: all('section.section'),
    };
  }

  function then2(fn) { return fn(); }

  /** 结果统一放这里，finish() 与 catch 都能拿到 */
  var out = {};
  window.__probeOut = out;
  window.__gbTrace = [];

  function flush() {
    document.title = OUT + encodeURIComponent(JSON.stringify(out));
  }

  /** 轮询等待条件成立，比固定 sleep 稳（HTTP 往返时间不确定） */
  function waitFor(fn, timeout, done) {
    var t0 = Date.now();
    (function tick() {
      var okNow = false;
      try { okNow = !!fn(); } catch (e) { okNow = false; }
      if (okNow || Date.now() - t0 > timeout) return done(okNow, Date.now() - t0);
      setTimeout(tick, 100);
    })();
  }

  /** 把 #gb 里的可见状态快照下来 */
  function gbSnapshot(out) {
    out.gbStatus = document.querySelector('[data-gb-status]').textContent.trim();
    out.gbStatusKind = document.querySelector('[data-gb-status]').getAttribute('data-kind');
    out.gbTotal = document.querySelector('[data-gb-total]').textContent.trim();
    out.items = document.querySelectorAll('[data-gb-list] .gb-item').length;
    out.first = document.querySelector('[data-gb-list] .gb-item__text')
      ? document.querySelector('[data-gb-list] .gb-item__text').textContent.trim() : '';
    out.firstName = document.querySelector('[data-gb-list] .gb-item__name')
      ? document.querySelector('[data-gb-list] .gb-item__name').textContent.trim() : '';
    out.avatarInitial = document.querySelector('[data-gb-list] .gb-item__avatar')
      ? document.querySelector('[data-gb-list] .gb-item__avatar').textContent.trim() : '';
    out.gbTextCleared = document.querySelector('[data-gb-text]').value === '';
  }

  window.addEventListener('load', function () {
    setTimeout(function () {
      try {
        out.stats = {
          hidden: document.querySelector('[data-stats]').hidden,
          views: document.querySelector('[data-stats-views]').textContent.trim(),
          today: document.querySelector('[data-stats-today]').textContent.trim(),
          uv: document.querySelector('[data-stats-uv]').textContent.trim(),
          bars: document.querySelectorAll('[data-stats-trend] .trend__bar').length,
          since: document.querySelector('[data-stats-since]').textContent.trim(),
        };
        out.gbBoardHidden = document.querySelector('[data-gb]').hidden;
        out.gbBoardShown = !out.gbBoardHidden;

        var textField = document.querySelector('[data-gb-text]');
        var nameField = document.querySelector('[data-gb-name]');
        var form = document.querySelector('[data-gb-form]');

        textField.value = 'Hello from the automated smoke test.';
        nameField.value = 'Smoke Bot';

        // 状态提示是"一闪而过"的：后面再发一条测限速时它会先被清空再换成错误文案。
        // 所以录下每一次变动，最后按顺序回看，而不是只在某一刻读一次。
        var log = [];
        out.dbgLog = log;
        new MutationObserver(function (records) {
          records.forEach(function () {
            var s = document.querySelector('[data-gb-status]');
            log.push((s.getAttribute('data-kind') || '-') + ':' + (s.textContent || '').slice(0, 16));
          });
        }).observe(document.querySelector('[data-gb-status]'), {
          childList: true, characterData: true, subtree: true, attributes: true,
        });

        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

        // 等留言真的出现在列表里，而不是死等一个固定毫秒数
        waitFor(function () {
          return document.querySelectorAll('[data-gb-list] .gb-item').length >= 1;
        }, 6000, function (arrived) {
          out.gbFirstArrived = arrived;
          gbSnapshot(out);
          // 第一次成功的提示单独记一份，下面触发限速时会把它覆盖掉
          out.gbFirstStatus = out.gbStatus;
          out.gbFirstKind = out.gbStatusKind;

          // 蜜罐：真人看不见它。这里用裁剪盒的实际尺寸判断 ——
          // checkVisibility() 不看 clip/clip-path，所以那个信号在这没用。
          var honeypot = document.querySelector('[data-gb-website]');
          if (honeypot) {
            var hpStyle = getComputedStyle(honeypot);
            var box = honeypot.parentElement;
            var boxStyle = getComputedStyle(box);
            out.honeypotSize = Math.round(honeypot.getBoundingClientRect().width) + 'x' +
              Math.round(honeypot.getBoundingClientRect().height);
            out.honeypotOffset = honeypot.offsetWidth + 'x' + honeypot.offsetHeight;
            out.honeypotTabIndex = honeypot.getAttribute('tabindex');
            out.honeypotBoxOffset = box.offsetWidth + 'x' + box.offsetHeight;
            out.honeypotClip = boxStyle.clipPath;
            out.honeypotOpacity = hpStyle.opacity;
            out.honeypotPointer = boxStyle.pointerEvents;
            out.honeypotPos = boxStyle.position;
            // 判定：裁剪盒 + 透明 + 不可点 + 不能被 Tab 聚焦 = 真人拿不到
            out.honeypotHidden = /inset\(\s*50%/.test(boxStyle.clipPath) &&
              parseFloat(boxStyle.opacity) === 0 &&
              boxStyle.pointerEvents === 'none' &&
              honeypot.getAttribute('tabindex') === '-1';
          } else {
            out.honeypotHidden = null;
          }

          // 紧接着再发一条：应该被服务端限速，前端要把 429 翻成一句人话
          textField.value = 'Second message immediately after the first one.';
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

          waitFor(function () {
            var s = document.querySelector('[data-gb-status]');
            return s.getAttribute('data-kind') === 'error' && s.textContent.trim().length > 0;
          }, 6000, function () {
            out.gbRateStatus = document.querySelector('[data-gb-status]').textContent.trim();
            out.gbRateKind = document.querySelector('[data-gb-status]').getAttribute('data-kind');
            out.gbRateItems = document.querySelectorAll('[data-gb-list] .gb-item').length;

            finish();
          });
        });
      } catch (e) {
        out.fatal = String(e && e.stack ? e.stack.split('\n')[0] : e);
        flush();
      }
    }, 900);
  });

  /** 语言来回切一遍，看中英文文案是否都正确 */
  function finish() {
    document.querySelector('[data-lang-toggle]').click();
    waitFor(function () { return document.documentElement.getAttribute('lang') === 'en'; }, 3000, function () {
      out.en = snapshot();
      document.querySelector('[data-lang-toggle]').click();
      waitFor(function () { return document.documentElement.getAttribute('lang') === 'zh-CN'; }, 3000, function () {
        out.zh = snapshot();
        op('POST', '/api/visit', { visitorId: 'smoke-probe-visitor-2' }).then(function (after) {
          out.statsAfter = after && after.stats ? after.stats : null;
          flush();
        }).catch(function (e) {
          out.statsAfter = null;
          out.err = String(e);
          flush();
        });
      });
    });
  }

  function op(method, url, body) {
    return fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) { return r.json().catch(function () { return {}; }); });
  }
})();
