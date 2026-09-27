/* 云图 · 页面逻辑
 *
 * 分工：core.js 管数据换算，chart.js 管曲线几何，icons.js 管符号，
 * 这里只管「什么时候取数、取到之后往哪儿写、用户点了怎么办」。
 *
 * 取数路径全部走本机服务（server.js）的 /api/*，不直连上游：
 * 上游限流按调用方算，而这里一开机就要为左栏所有收藏城市各取一次数据，
 * 由服务端统一缓存 10 分钟后，切城市不会再打上游。
 */
(function () {
  'use strict';

  const C = window.CloudCore;
  const Icons = window.CloudIcons;
  const Chart = window.CloudChart;
  const Aqi = window.CloudAqi;
  const Alerts = window.CloudAlerts;

  /* ---------------------------------------------------------------- 存储键 */

  const STORE = {
    unit: 'cloud-atlas.unit',
    saved: 'cloud-atlas.saved',
    last: 'cloud-atlas.last',
    range: 'cloud-atlas.range',
    /* 对比清单换成了带版本号的键。
       换键的原因：旧版把"自动生成的默认清单"也写进了存储，于是
       "自动填的"和"用户亲手挑的"在存储里长得一模一样，事后无法分辨。
       结果就是——用户升级之后，旧版自动写进去的那份清单被当成他自己的选择读回来，
       新的默认值（只有当前城市）永远不生效。
       旧键不再是"有没有存过"的依据，只作为迁移的输入。 */
    compare: 'cloud-atlas.compare.v2',
    compareLegacy: 'cloud-atlas.compare',
  };

  const DEFAULT_PLACE = { name: '北京', region: '北京', country: '中国', latitude: 39.9042, longitude: 116.4074 };
  const REFRESH_MS = 10 * 60 * 1000;   // 与 server.js 的缓存时长对齐
  const DEFAULT_HINT = '输入地名开始查询，或点「定位」取当地天气';

  /* 对比图的配色序列。相邻两个必须能一眼分开，所以不用同色系的深浅，
     而是按色相轮转；顺序固定，这样同一个城市每次都是同一个颜色。 */
  const SERIES_COLORS = [
    '#e6a13c', '#5fb7d4', '#c58ae0', '#79c47a', '#e2795f',
    '#a8b7c4', '#d9c95a', '#6f9fe0', '#dd8ab0', '#8fd0b8',
    '#c9a06a', '#9aa7e0',
  ];

  /* 一次最多对比几个城市。
     不是随手定的数：对比图共用一根温度轴，线条越多越难分辨。
     5 条是这个配色序列加上图例标签还能"一眼对得上"的上限，
     再多就得靠逐个点图例来回试，那已经不叫对比了。 */
  const MAX_COMPARE = 5;

  /* 历史区间的预设。range 是"往前多少天"，null 表示用自定义起止。 */
  const RANGES = [
    { days: 30, label: '近 30 天' },
    { days: 92, label: '近 3 个月' },
    { days: 365, label: '近一年' },
    { days: 1095, label: '近三年' },
    { days: 1825, label: '近五年' },
  ];

  /* ------------------------------------------------------------------ 状态 */

  const state = {
    unit: 'c',
    place: null,
    forecast: null,
    hours: [],        // 当前曲线正在画的那 24 小时
    hoursDayIndex: 0, // 曲线对应 futureDaily 里的第几天
    saved: [],
    railWx: new Map(),   // 收藏城市的天气缓存：key = 地点 id
    railLoading: false,
    suggestions: [],
    activeSuggest: -1,
    searchSeq: 0,
    loadSeq: 0,
    cursor: null,
    week: [],
    air: null,          // js/aqi.js 的 fromCurrent 结果
    airSeries: [],      // 逐小时 AQI 序列（趋势用）
    alerts: [],
    compare: [],        // [{ place, fc, color, visible }] 已取到数据的城市
    picks: [],          // 用户选中的对比城市（Place[]），顺序即图例顺序
    picksTouched: false, // 用户是否手动改过对比清单
    picksReady: false,  // 默认值是否已经算过（本会话内只算一次）
    picksPending: false, // 上次算的默认值是在"当前城市未知"时算的，要重算
    legacyPicks: null,  // 旧格式存下来的清单，等收藏载入后再判断怎么处理
    compareSel: null,   // 对比区搜索的候选与高亮状态
    compareInflight: null,   // 正在途中的批量请求：{ sig, promise }
    rangeDays: 30,
    history: null,
    historyLoading: false,
  };

  /** 最近一次成功取数的时刻，用于判断从后台切回来时要不要补刷。 */
  let lastLoad = Date.now();
  let booted = false;

  /* ------------------------------------------------------------------ 快捷 */

  const $ = (id) => document.getElementById(id);
  const el = {
    body: document.body,
    sprite: document.querySelector('.wx-sprite'),
    form: $('seek-form'),
    input: $('seek-input'),
    list: $('seek-list'),
    hint: $('seek-hint'),
    locate: $('locate-btn'),
    notices: $('notices'),
    savedList: $('saved-list'),
    railCount: $('rail-count'),
    railNote: $('rail-empty'),
    historyMeta: $('history-meta'),
    placeName: $('place-name'),
    placeWhere: $('place-where'),
    obsTime: $('obs-time'),
    obsZone: $('obs-zone'),
    tempNow: $('temp-now'),
    tempUnit: $('temp-unit'),
    nowIcon: $('now-icon'),
    condNow: $('cond-now'),
    feelsNow: $('feels-now'),
    todayRange: $('today-range'),
    obsNote: $('obs-note'),
    acts: $('obs-acts'),
    humidity: $('m-humidity'),
    scaleHumidity: $('scale-humidity'),
    wind: $('m-wind'),
    windUnit: $('m-wind-unit'),
    windDir: $('m-wind-dir'),
    vane: $('vane'),
    needle: $('vane-needle'),
    pressure: $('m-pressure'),
    pressureUnit: $('m-pressure-unit'),
    pressureAlt: $('m-pressure-alt'),
    pop: $('m-pop'),
    precip: $('m-precip'),
    ribbonBand: $('ribbon-band'),
    ribbonDot: $('ribbon-dot'),
    ribbonLow: $('ribbon-low'),
    ribbonHigh: $('ribbon-high'),
    plotbox: $('plotbox'),
    curveAside: $('curve-aside'),
    rbTime: $('rb-time'),
    rbTemp: $('rb-temp'),
    rbCond: $('rb-cond'),
    rbPop: $('rb-pop'),
    weekScale: $('week-scale'),
    week: $('week'),
    daybox: $('daybox'),
    /* 预警 */
    alerts: $('alerts'),
    alertsList: $('alerts-list'),
    /* 空气质量 */
    aqi: $('m-aqi'),
    aqiLevel: $('m-aqi-level'),
    aqiDot: $('aqi-dot'),
    aqiPrimary: $('m-aqi-primary'),
    airDetail: $('air-detail'),
    airSummary: $('air-summary-text'),
    airAdvice: $('air-advice'),
    airList: $('air-list'),
    uv: $('m-uv'),
    uvWord: $('m-uv-word'),
    uvTip: $('m-uv-tip'),
    /* 多城市对比 */
    compare: $('compare'),
    compareChart: $('compare-chart'),
    compareTableWrap: $('compare-table-wrap'),
    compareTable: $('compare-table'),
    compareLegend: $('compare-legend'),
    compareAside: $('compare-aside'),
    cmpForm: $('cmp-form'),
    cmpInput: $('cmp-input'),
    cmpList: $('cmp-list'),
    cmpNote: $('cmp-note'),
    cmpChips: $('cmp-chips'),
    /* 历史 */
    history: $('history'),
    historyHint: $('history-hint'),
    historyStats: $('history-stats'),
    historyPlot: $('history-plot'),
    historyCap: $('history-cap'),
    historyCompose: $('history-compose'),
    historyReading: $('history-reading'),
    historyAside: $('history-aside'),
    historyRanges: $('history-ranges'),
    customRange: $('custom-range'),
    histStart: $('hist-start'),
    histEnd: $('hist-end'),
    histGo: $('hist-go'),
    historyCustom: $('history-custom'),
  };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  /**
   * 温度显示。
   *
   * 关键是「先换算、后取整」：如果先把摄氏取整成 31°C 再转华氏，会得到 88°F，
   * 而 31.0°C 实际是 87.8°F → 88，31.4°C 才是 89°F。
   * 用取整后的值去换算，误差最大能到将近 1 度，而且是系统性的：
   * 用户把单位切成华氏再切回来，看到的数字会不一致。所以换算一律用原始值。
   */
  const t = (c) => C.convertTemp(c, state.unit);
  const u = (kmh) => C.windIn(kmh, state.unit);
  const tUnit = () => C.tempLabel(state.unit);

  /* ------------------------------------------------------------------ 存储 */

  function readStore() {
    try {
      state.unit = localStorage.getItem(STORE.unit) === 'f' ? 'f' : 'c';
      state.saved = C.parseSaved(localStorage.getItem(STORE.saved));
      const last = localStorage.getItem(STORE.last);
      if (last) state.place = C.normalizePlace(JSON.parse(last));
    } catch (e) {
      // 隐私模式或数据损坏：不阻止使用，只是这一轮不记忆
      state.unit = 'c';
      state.saved = [];
    }
  }

  function persist(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) { /* 存不下就算了，收藏是便利功能，不是核心功能 */ }
  }

  function persistSaved() { persist(STORE.saved, C.serializeSaved(state.saved)); }

  /* ------------------------------------------------------------------ 网络 */

  async function api(path, params) {
    const qs = new URLSearchParams(params || {}).toString();
    let res;
    try {
      res = await fetch(path + (qs ? '?' + qs : ''), { headers: { accept: 'application/json' } });
    } catch (e) {
      /* fetch 只在网络层失败时抛异常（连不上、被中断）。
         这里必须转成一句人话：默认的 "Failed to fetch" 对用户没有意义。 */
      throw new Error('连不上本机服务，确认 node server.js 还在运行');
    }
    let body = null;
    try {
      body = await res.json();
    } catch (e) {
      throw new Error('服务返回了无法解析的内容');
    }
    if (!res.ok || body.error) throw new Error(body.error || `请求失败（${res.status}）`);
    return body;
  }

  /* ------------------------------------------------------------------ 提示 */

  /**
   * 页面顶部的一条横幅。同一类提示不重复堆叠——比如断网时每查一次都弹一条，
   * 会把版面顶下去，所以按 kind 去重，新的直接替换旧的。
   */
  function notice(text, kind, opts) {
    const kindCls = kind === 'error' ? 'notice--error' : kind === 'ok' ? 'notice--ok' : '';
    const key = (opts && opts.key) || kind || 'info';
    const old = el.notices.querySelector(`[data-key="${key}"]`);
    if (old) old.remove();

    const node = document.createElement('div');
    node.className = 'notice ' + kindCls;
    node.dataset.key = key;
    node.innerHTML = `<span>${text}</span>`
      + `<button class="notice__close" type="button" aria-label="关闭提示">×</button>`;
    node.querySelector('.notice__close').addEventListener('click', () => node.remove());
    el.notices.appendChild(node);
  }

  const clearNotice = (key) => {
    const old = el.notices.querySelector(`[data-key="${key}"]`);
    if (old) old.remove();
  };

  /**
   * 渲染阶段出错时的统一出口。
   *
   * 为什么要有一个：渲染代码里抛异常只会留下一个控制台报错，
   * 而用户在页面上看到的是"某一块永远停在加载中"——看不出是坏了还是慢。
   * 这里把原因写到对应区块的提示行上，同时留一份给自检探针读
   * （verify-probe 会把哪些错误报成测试失败，这样回归测试就能捕捉到）。
   */
  const jsErrors = [];

  function reportError(where, err) {
    const msg = (err && err.message) || String(err);
    jsErrors.push(`${where}: ${msg}`);
    if (where === '对比区') {
      el.cmpNote.dataset.tone = 'error';
      el.cmpNote.textContent = `对比区出错：${msg}`;
    } else if (where === '历史区') {
      el.historyHint.hidden = false;
      el.historyHint.textContent = `历史区出错：${msg}`;
    } else {
      notice(`<b>${esc(where)}出错</b>：${esc(msg)}`, 'error', { key: 'js' });
    }
  }

  // 暴露给自检探针：探针没法捕获异步异常，只能由页面自己记下来给它读
  window.__CLOUD_ERRORS__ = jsErrors;

  /* 对比清单的最小可编程入口，只给自检用。
     为什么要开这个口子：上限"最多 5 个"这条规则，靠界面点是验不充分的——
     收藏恰好只有 5 个时，数一数 chips 也是 5，看不出是上限生效还是凑巧。
     必须能主动往清单里塞第 6 个，才知道它会不会被拦住。 */
  window.__CLOUD_UI__ = {
    canAdd: (place) => addPickBlocker(place),
    addPick: (place) => addPick(place),
    pickCount: () => state.picks.length,
    maxCompare: MAX_COMPARE,
    resetPicks,
    // 探针报失败时要把这几个内部标志一起带上，否则只能看到"0 个城市"这种表象
    debug: () => ({
      picks: state.picks.length,
      touched: state.picksTouched,
      ready: state.picksReady,
      legacy: state.legacyPicks ? state.legacyPicks.length : null,
      place: state.place ? state.place.name : null,
    }),
  };

  /* ------------------------------------------------------------ 着色与标题 */

  /** 把天气码与昼夜落成 body 上的基调，整套配色随之切换。 */
  function paintTone(norm) {
    if (!norm || !norm.current) return;
    const tone = C.sky(norm.current.code, norm.current.isDay);
    if (el.body.dataset.tone !== tone) el.body.dataset.tone = tone;
  }

  /* ---------------------------------------------------------------- 渲染：预警 */

  /**
   * 预警条。
   *
   * 措辞上有一条硬要求：必须让人看清这是本地推算而不是官方预警。
   * 所以标题旁边固定带一句「非官方发布」，每条还给出推导依据（哪个要素到了多少）。
   * 把推算说成"预警发布"是不诚实的——真正的预警还包含发布机构对趋势和影响的判断。
   */
  function renderAlerts() {
    const list = state.alerts;
    if (!list.length) {
      el.alerts.hidden = true;
      el.alertsList.innerHTML = '';
      return;
    }
    el.alerts.hidden = false;
    el.alertsList.innerHTML = list.map((a) => `
      <li class="alert" style="--alert-color:${esc(a.color)}">
        <span class="alert__bar" aria-hidden="true"></span>
        <span class="alert__icon" aria-hidden="true">${alertGlyph(a.kind)}</span>
        <div class="alert__main">
          <p class="alert__headline"><em>${esc(a.kindName + a.levelLabel)}</em>${esc(a.headline)}</p>
          <p class="alert__detail">${esc(a.detail)}</p>
          <p class="alert__basis">依据：${esc(a.basis)}　${esc(a.evidence || '')}</p>
        </div>
      </li>`).join('');
  }

  /**
   * 预警类别的小符号。用简单几何图形而不是天气符号——
   * 天气符号表示的是"现在天上什么样"，预警表示的是"会有什么危险"，
   * 两者混用会让用户以为预警图标就是天气图标。
   */
  function alertGlyph(kind) {
    const g = {
      heat: '<circle cx="12" cy="9" r="4"/><line x1="12" y1="15" x2="12" y2="21"/><line x1="8" y1="18" x2="16" y2="18"/>',
      cold: '<line x1="12" y1="3" x2="12" y2="21"/><line x1="4" y1="8" x2="20" y2="16"/><line x1="20" y1="8" x2="4" y2="16"/>',
      wind: '<path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 13h15a3 3 0 1 1-3 3"/><path d="M3 18h7"/>',
      rain: '<path d="M5 10a5 5 0 0 1 9.6-2A4 4 0 0 1 18 16H6a3.5 3.5 0 0 1-1-6Z"/><line x1="8" y1="18" x2="7" y2="21"/><line x1="13" y1="18" x2="12" y2="21"/>',
      snow: '<line x1="12" y1="3" x2="12" y2="21"/><line x1="4.5" y1="7.5" x2="19.5" y2="16.5"/><line x1="19.5" y1="7.5" x2="4.5" y2="16.5"/>',
      storm: '<path d="M13 3 6 14h5l-1 7 8-11h-5l0-7Z"/>',
      fog: '<line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="14" x2="21" y2="14"/><line x1="6" y1="19" x2="18" y2="19"/>',
      haze: '<circle cx="7" cy="8" r="2"/><circle cx="15" cy="7" r="1.6"/><circle cx="11" cy="12" r="1.8"/><line x1="3" y1="17" x2="21" y2="17"/><line x1="3" y1="20" x2="21" y2="20"/>',
      uv: '<circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/>',
    };
    return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${g[kind] || g.fog}</svg>`;
  }

  /* ------------------------------------------------------------ 渲染：空气质量 */

  /**
   * 空气质量。
   *
   * 显示的是按中国国标（HJ 633—2012）算出来的 AQI，不是上游给的美国口径 us_aqi——
   * 同一份空气两个标准会给出不同的等级，给中国用户看必须用国内口径。
   * 界面上的措辞也据此写成「实时」：国标口径是 24 小时平均，而这里只有当前浓度，
   * 与官方日报会有出入，这一点在明细的脚注里说明。
   */
  function renderAir() {
    const air = state.air;
    if (!air) {
      // 拿不到就不显示数字，也不要留一个"0"，那会被读成"空气很好"
      el.aqi.textContent = '--';
      el.aqiLevel.textContent = '—';
      el.aqiPrimary.textContent = '暂无数据';
      el.aqiDot.style.left = '0%';
      el.airDetail.hidden = true;
      return;
    }

    el.aqi.textContent = String(air.aqi);
    el.aqiLevel.textContent = air.level.name;
    el.aqiPrimary.textContent = air.primary
      ? `首要污染物 ${air.primary}`
      : '无首要污染物';
    el.aqiDot.style.left = `calc(${(Aqi.positionOnScale(air.aqi) * 100).toFixed(2)}% - 1px)`;

    el.airDetail.hidden = false;
    el.airSummary.textContent = `空气质量明细 · ${air.level.name}（AQI ${air.aqi}）`;
    el.airAdvice.textContent = air.level.advice;
    el.airList.innerHTML = air.detail.map((d) => `
      <li class="air__item ${d.name === air.primary ? 'air__item--primary' : ''}">
        <p class="air__item-name">${esc(d.name)}${d.name === air.primary ? ' · 首要' : ''}</p>
        <p class="air__item-val">${esc(String(d.value))}<small>${esc(d.unit)}</small></p>
      </li>`).join('');

    renderUv();
  }

  /** 紫外线：指数 + 强度词 + 一句防护建议 */
  const UV_WORDS = [
    { max: 2, word: '最弱', tip: '无需特别防护' },
    { max: 5, word: '弱', tip: '正常外出即可' },
    { max: 7, word: '中等', tip: '正午遮阳，涂防晒' },
    { max: 10, word: '强', tip: '避免长时间暴晒' },
    { max: Infinity, word: '极强', tip: '尽量留在阴凉处' },
  ];

  function renderUv() {
    const raw = (state.air && state.air.uv) != null
      ? state.air.uv
      : (state.forecast && state.forecast.current ? state.forecast.current.uv : null);
    const todayMax = state.forecast && state.forecast.today ? state.forecast.today.uvMax : null;
    const value = raw != null ? raw : todayMax;

    if (value == null) {
      el.uv.textContent = '--';
      el.uvWord.textContent = '—';
      el.uvTip.textContent = '暂无数据';
      return;
    }
    const lv = UV_WORDS.find((u) => value <= u.max) || UV_WORDS[UV_WORDS.length - 1];
    el.uv.textContent = String(Math.round(value));
    el.uvWord.textContent = lv.word;
    // 同时给出今日峰值：紫外线的危害看的是峰值不是此刻
    el.uvTip.textContent = todayMax != null && Math.round(todayMax) !== Math.round(value)
      ? `${lv.tip} · 今日最高 ${Math.round(todayMax)}`
      : lv.tip;
  }

  /* ---------------------------------------------------------- 渲染：多城市对比 */

  /**
   * 对比清单的默认值：**只有当前城市**。
   *
   * 一开始这里默认装入收藏城市（最多 5 个），后来改掉了。原因是那个默认值本身
   * 变成了障碍：清单已经占满 5 个名额时，用户想加一个城市反而必须先删掉一个，
   * 而他那 5 个未必是想对比的。默认值应该是一个"起点"，不是一个"结论"。
   *
   * 现在的规则：
   *   - 有当前城市 → 清单里只放它。曲线上先画着它自己的 24 小时，
   *     剩下的名额空着，提示行告诉用户还能加几个；
   *   - 没有当前城市（页面还没取到数）→ 退回收藏里的第一个，
   *     总比空白强，用户也不会觉得功能没生效。
   *
   * 用户手动加过之后（picksTouched），这个默认值就再不生效了。
   */
  function defaultPicks() {
    if (state.place) return [state.place];
    return state.saved.slice(0, 1);
  }

  /** 收藏变化时调用：用户没动过对比清单就跟着收藏走，动过就不管。 */
  function syncCompareDefault() {
    /* 清单空着时总是回到默认值——即使之前被标记成"用户动过"。
       这种情况出现在用户把城市一个个删光之后：
       空清单会让对比区只剩一句引导，而用户下次打开时很可能期望看到当前城市。
       "空"和"我挑好了这几个"不是一回事，不该用同一个标志对待。 */
    if (!state.picks.length) {
      applyDefaultPicks();
      return;
    }
    /* 还没拿到当前城市时算出来的默认值是不可信的：那时 defaultPicks 只能退回
       "收藏里的第一个"，而启动流程里 boot() 就是在读存储时顺手算过一次。
       所以这个标记要跟着那段清单一起存下来，等当前城市到位后重算一遍——
       否则对比区会停在随便挑的一个收藏城市上，而页面显示的是另一个。 */
    if (state.picksPending) {
      applyDefaultPicks();
      return;
    }
    if (state.picksTouched) {
      renderCompare();
      return;
    }
    if (state.picksReady) {
      renderCompare();
      return;
    }
    applyDefaultPicks();
  }

  /** 按默认规则重算清单并渲染。 */
  function applyDefaultPicks() {
    state.picks = defaultPicks();
    // 只有真的拿到了当前城市，这份默认值才算数；否则下次还要重算
    state.picksReady = !!state.place && state.picks.length > 0;
    state.picksPending = !state.place;
    if (state.picks.length) state.picksTouched = false;
    persistPicks();
    loadCompare();
  }

  function persistPicks() {
    /* 存成一个带来源标记的对象，而不是裸数组。
       source 是关键：'default' 表示这份清单是程序按默认规则填的，
       'user' 表示用户亲手加过或删过。
       下次读的时候只认 'user'——这样"程序填的默认值"永远不会被误当成用户的选择。 */
    persist(STORE.compare, JSON.stringify({
      v: 2,
      source: state.picksTouched ? 'user' : 'default',
      places: JSON.parse(C.serializeSaved(state.picks)),
    }));
  }

  /**
   * 载入对比清单。返回 true 表示清单来自用户自己的选择。
   *
   * 两种情况都要处理：
   *   - 新版格式（带 source）：只有 source === 'user' 才认，否则让新默认值生效；
   *   - 旧版格式（裸数组）：无法直接判断是"用户挑的"还是"旧版默认填的"，
   *     所以交给 looksLikeOldDefault() 在收藏载入之后再判——这里只把它记下来。
   */
  function persistPicks() {
    /* 存成一个带来源标记的对象，而不是裸数组。
       source 是关键：'default' 表示这份清单是程序按默认规则填的，
       'user' 表示用户亲手加过或删过。
       下次读的时候只认 'user'——这样"程序填的默认值"永远不会被误当成用户的选择。
       pending 表示"这份默认值是在还没拿到当前城市时算的"，
       下次启动要重算，不能当真。 */
    persist(STORE.compare, JSON.stringify({
      v: 2,
      source: state.picksTouched ? 'user' : 'default',
      pending: !!state.picksPending,
      places: JSON.parse(C.serializeSaved(state.picks)),
    }));
  }

  function readPicks() {
    state.legacyPicks = null;

    const modern = localStorage.getItem(STORE.compare);
    if (modern) {
      let parsed = null;
      try { parsed = JSON.parse(modern); } catch (e) { parsed = null; }
      if (parsed && Array.isArray(parsed.places)) {
        /* 待重算的默认值不能直接认：它是在"当前城市未知"时算的，
           内容可能只是收藏里的第一个。标记成 pending，等当前城市到位后重算。 */
        if (parsed.pending) {
          state.picks = [];
          state.picksPending = true;
          state.picksReady = false;
          state.picksTouched = false;
          return false;
        }
        if (parsed.source === 'user') {
          state.picks = C.parseSaved(parsed.places).slice(0, MAX_COMPARE);
          state.picksTouched = true;
          state.picksReady = true;
          return true;
        }
        // source 是 default（或未知）：不认它，交给默认规则
        return false;
      }
    }

    const legacy = localStorage.getItem(STORE.compareLegacy);
    if (legacy != null) {
      const list = C.parseSaved(legacy);
      if (list.length) {
        state.legacyPicks = list.slice(0, MAX_COMPARE);
        return false;   // 待收藏载入后再判
      }
    }
    return false;
  }

  /**
   * 迁移判断：旧存的那份清单，到底是用户挑的，还是旧版默认填的？
   *
   * 判据是「有没有一个是收藏之外的城市」：
   *   - 旧版的默认清单 = 收藏城市的前 5 个 → 全部都在收藏里 → 是自动填的，丢掉；
   *   - 用户如果自己加过城市（旧版能搜非收藏城市），那份清单里必然有不在收藏里的 → 保留。
   *
   * 这个判据不完美：用户也可能主动只挑了收藏里的几个城市。但那种情况和
   * "旧版自动填的"在数据上完全一样、区分不了；而对绝大多数人来说，
   * 那份清单根本不是自己选的，留着它才是错的。所以这里选择丢掉。
   */
  function migrateLegacyPicks() {
    if (!state.legacyPicks || !state.legacyPicks.length) return;

    const savedIds = new Set(state.saved.map((p) => p.id));
    const allFromFavourites = state.legacyPicks.every((p) => savedIds.has(p.id));
    const legacy = state.legacyPicks;
    state.legacyPicks = null;

    if (allFromFavourites) {
      // 旧版自动填的：清掉，让新的默认值（只有当前城市）生效
      try {
        localStorage.removeItem(STORE.compareLegacy);
      } catch (e) { /* 清不掉也不影响本次运行 */ }
      state.picks = [];
      state.picksTouched = false;
      state.picksReady = false;
      return;
    }

    // 里面有收藏之外的城市，说明用户确实自己挑过，保留下来并升级成新格式
    state.picks = legacy;
    state.picksTouched = true;
    state.picksReady = true;
    persistPicks();
  }

  /**
   * 把对比清单还原成"用户从没动过"的状态。
   * 只给自检探针用：它跑完必须把环境恢复原样，否则下一次运行会读到
   * 它留下的状态（比如"用户把城市全删光了"）而误判成缺陷。
   */
  function resetPicks() {
    state.picks = defaultPicks();
    state.picksTouched = false;
    state.picksReady = !!state.place && state.picks.length > 0;
    state.picksPending = !state.place;
    state.legacyPicks = null;
    persistPicks();
    loadCompare();
  }

  /**
   * 能不能把这个城市加进对比。
   * 不能加时返回一句人话原因，能加时返回 null——把判断和文案放一起，
   * 免得界面上出现"加不进去但不说为什么"。
   */
  function addPickBlocker(place) {
    if (!place) return '这个城市没有有效坐标';
    if (state.picks.some((p) => C.samePlace(p, place))) return `${place.name} 已经在对比里了`;
    if (state.picks.length >= MAX_COMPARE) {
      return `最多对比 ${MAX_COMPARE} 个城市，先移除一个再加`;
    }
    return null;
  }

  function addPick(place) {
    const blocked = addPickBlocker(place);
    if (blocked) {
      el.cmpNote.textContent = blocked;
      return false;
    }
    state.picks = state.picks.concat([place]).slice(0, MAX_COMPARE);
    state.picksTouched = true;
    state.picksReady = true;
    persistPicks();
    loadCompare();
    return true;
  }

  function removePick(place) {
    state.picks = state.picks.filter((p) => !C.samePlace(p, place));
    state.picksTouched = true;
    state.picksReady = true;
    persistPicks();
    loadCompare();
  }

  async function loadCompare() {
    const cities = state.picks.slice(0, MAX_COMPARE);
    const picked = new Set(cities.map((p) => p.id));

    /* 缓存里只保留"还在清单里"的城市。
       注意判据是 picked 而不是 cities 之外的数据——哪怕一个城市刚从清单里删掉，
       它的数据也一并丢掉，这样再加回来时会重新取一次；
       服务端有缓存，代价很小，而留着一堆用不上的城市会让颜色分配越算越乱。 */
    state.compare = state.compare.filter((c) => picked.has(c.place.id));

    if (!cities.length) {
      renderCompare();
      return;
    }

    const have = new Set(state.compare.map((c) => c.place.id));
    const need = cities.filter((p) => !have.has(p.id));

    if (need.length) {
      /* 同一批城市只在途一次。
         启动流程里 refreshCompare 和 load 之后各会调一次 loadCompare，
         不去重的话会发两次批量请求，而且后发的那次先回到"加载中"状态，
         把已经画好的表和曲线又清掉——页面上表现为"图闪一下然后没了"，
         同时提示停在"正在取数…"，看起来像卡住了。 */
      const sig = need.map((p) => `${p.latitude.toFixed(3)},${p.longitude.toFixed(3)}`).sort().join(';');
      if (state.compareInflight && state.compareInflight.sig === sig) {
        await state.compareInflight.promise.catch(() => {});
      } else {
        const promise = (async () => {
          /* 一次请求取全部城市：上游支持逗号分隔的多组坐标。
             逐个请求的话 5 个城市就是 5 次调用，而且慢的那一个会拖住整张图。 */
          const body = await api('/api/batch', {
            lat: need.map((p) => p.latitude.toFixed(4)).join(','),
            lon: need.map((p) => p.longitude.toFixed(4)).join(','),
          });
          const arr = Array.isArray(body.data) ? body.data : [body.data];
          const added = [];
          need.forEach((place, i) => {
            const norm = C.normalizeForecast(arr[i]);
            if (norm) added.push({ place, fc: norm, visible: true });
          });
          /* 先全部算好再一次性写进 state.compare：
             逐个 push 再逐个渲染的话，中间会出现"三个城市有数据、第四个还在加载"的
             半成品状态，表格里的极值标注也会因为样本不全而跳来跳去。 */
          state.compare = state.compare.concat(added);
        })();

        state.compareInflight = { sig, promise };
        renderCompare();
        try {
          await promise;
        } catch (err) {
          reportError('对比区', err);
          return;
        } finally {
          state.compareInflight = null;
        }
      }
    }

    state.compare.sort(byPickOrder(cities));
    state.compare.forEach((c, i) => { c.color = SERIES_COLORS[i % SERIES_COLORS.length]; });
    renderCompare();
  }

  /** 按用户排定的顺序排序：同一个城市每次都是同一个颜色，图例顺序也不会跳。 */
  function byPickOrder(cities) {
    return (a, b) => cities.findIndex((p) => p.id === a.place.id) - cities.findIndex((p) => p.id === b.place.id);
  }

  function renderCompare() {
    const picks = state.picks.slice(0, MAX_COMPARE);
    renderPickChips(picks);

    const full = picks.length >= MAX_COMPARE;
    el.compareAside.textContent = picks.length === 0
      ? `还可以展示 ${MAX_COMPARE} 个城市`
      : `${picks.length} / ${MAX_COMPARE} 个城市`
        + (full ? ' · 已满' : ` · 还能加 ${MAX_COMPARE - picks.length} 个`);

    if (!picks.length) {
      el.compareChart.hidden = true;
      el.compareTableWrap.hidden = true;
      el.compareLegend.innerHTML = '';
      el.cmpNote.dataset.tone = 'hint';
      el.cmpNote.textContent = '用上面的搜索框加一个城市，就能在这里看它的 24 小时气温曲线。';
      return;
    }

    /* 数据还没到齐时，图和图例要么一起显示、要么一起不显示。
       之前只画了图例而没画曲线，会短暂出现"有城市名但图上一根线都没有"的状态——
       看起来就像图画坏了。宁可先给一句"正在取数"。 */
    if (!state.compare.length) {
      el.compareChart.hidden = true;
      el.compareTableWrap.hidden = true;
      el.compareLegend.innerHTML = '';
      el.cmpNote.dataset.tone = state.compareInflight ? 'hint' : 'error';
      el.cmpNote.textContent = state.compareInflight ? '正在取这些城市的预报…' : '这些城市还没有可用数据。';
      return;
    }

    setPickNote(picks);
    const visible = state.compare.filter((c) => c.visible);
    const unit = state.unit;

    /* 一个城市也画：用户要的就是"先看当前城市这条曲线"。
       此时它是基准线，后面加进来的城市都跟它比。 */
    el.compareChart.hidden = false;
    el.compareChart.innerHTML = visible.length
      ? Chart.compare(visible.map((c) => ({
        name: c.place.name,
        color: c.color,
        hours: c.fc.hours,
      })), {
        unit,
        // 只有一条线时不说"对比"，那会让人以为漏画了
        ariaLabel: visible.length > 1
          ? `${visible.length} 个城市的气温对比曲线`
          : `${visible[0].name} 未来 24 小时气温曲线`,
        emptyText: '被隐藏的城市之外没有可比较的数据',
      })
      : Chart.compare([], { emptyText: '所有城市都被隐藏了，点下面的图例恢复' });

    // 图例：点击隐藏/显示某个城市，用来排除离群值看清其余的线
    el.compareLegend.innerHTML = state.compare.map((c) => {
      const temp = c.fc.current ? t_(c.fc.current.temp) : null;
      return `<button class="compare__key" type="button" data-city="${esc(c.place.id)}"
        aria-pressed="${c.visible}">
        <span class="compare__swatch" style="background:${esc(c.color)}"></span>
        ${esc(c.place.name)}
        <span class="compare__key-temp">${temp == null ? '—' : temp + '°'}</span>
      </button>`;
    }).join('');

    /* 对照表必须两个城市以上才有意义：一行的表格没有"对照"，
       留着会让人以为少渲染了别的行。 */
    if (picks.length >= 2) {
      renderCompareTable(picks, unit);
    } else {
      el.compareTableWrap.hidden = true;
      el.compareTable.innerHTML = '';
    }
  }

  /** 已选城市的表现：一个个可以点掉的标签，顺序就是图例顺序。 */
  function renderPickChips(picks) {
    el.cmpChips.innerHTML = picks.map((p) => {
      const color = SERIES_COLORS[picks.indexOf(p) % SERIES_COLORS.length];
      return `<li>
        <span class="cmp-chip" style="--chip-color:${esc(color)}">
          <span class="cmp-chip__swatch" aria-hidden="true"></span>
          <span class="cmp-chip__name">${esc(p.name)}</span>
          <span class="cmp-chip__where">${esc(C.placeLabel(p))}</span>
          <button class="cmp-chip__drop" type="button" data-drop-pick="${esc(p.id)}"
                  aria-label="${esc(`把 ${p.name} 移出对比`)}" title="移出对比">✕</button>
        </span>
      </li>`;
    }).join('');
  }

  /** 还差几个、已经满了没有——这一行同时是 aria-live 的反馈区。 */
  function setPickNote(picks) {
    const left = MAX_COMPARE - picks.length;
    if (left === 0) {
      el.cmpNote.dataset.tone = 'full';
      el.cmpNote.textContent = `已经是对比上限 ${MAX_COMPARE} 个城市。想换一个，先移出一个。`;
      return;
    }
    el.cmpNote.dataset.tone = 'ok';
    // 只有一个城市时要说清"现在看的是它自己"，否则用户会以为对比没生效
    el.cmpNote.textContent = picks.length === 1
      ? `现在只展示 ${picks[0].name} 的曲线，还能再展示 ${left} 个城市。搜索结果或收藏里点城市名就能加进来。`
      : `还能再展示 ${left} 个城市。`;
  }

  /** 温度换算的简写，避免和模板里的局部变量 t 撞名 */
  function t_(c) { return C.convertTemp(c, state.unit); }

  /**
   * 指标对照表。
   *
   * 每列标出最好与最差：一屏十几个数字，没有标注的话用户要自己逐个比。
   * 比较方向按指标本身的意义定——气温没有好坏，但温差、降水概率、风速有可比性，
   * 所以只给"最大/最小"这类客观标注，不做主观好坏判断。
   */
  function renderCompareTable(cities, unit) {
    const rows = state.compare;
    if (!rows.length) {
      el.compareTableWrap.hidden = true;
      return;
    }
    el.compareTableWrap.hidden = false;

    const col = (get) => rows.map(get);
    const temps = col((c) => (c.fc.current ? c.fc.current.temp : null)).filter((v) => v != null);
    const highs = col((c) => (c.fc.daily[0] ? c.fc.daily[0].high : null)).filter((v) => v != null);
    const lows = col((c) => (c.fc.daily[0] ? c.fc.daily[0].low : null)).filter((v) => v != null);
    const hums = col((c) => (c.fc.current ? c.fc.current.humidity : null)).filter((v) => v != null);
    const winds = col((c) => (c.fc.current ? c.fc.current.wind : null)).filter((v) => v != null);
    const rains = col((c) => (c.fc.daily[0] ? c.fc.daily[0].precip : null)).filter((v) => v != null);

    const maxOf = (a) => (a.length ? Math.max.apply(null, a) : null);
    const minOf = (a) => (a.length ? Math.min.apply(null, a) : null);
    const isMax = (v, a) => v != null && a.length > 1 && v === maxOf(a);
    const isMin = (v, a) => v != null && a.length > 1 && v === minOf(a);

    const head = `<caption>今日观测与预报对照。橙色标注的是该列的最大值${unit === 'f' ? '（华氏）' : ''}。</caption>
      <thead><tr>
        <th scope="col">城市</th>
        <th scope="col">天气</th>
        <th scope="col">气温</th>
        <th scope="col">今日区间</th>
        <th scope="col">湿度</th>
        <th scope="col">风速</th>
        <th scope="col">降水量</th>
        <th scope="col">未来 7 天</th>
      </tr></thead>`;

    const body = rows.map((c) => {
      const cur = c.fc.current || {};
      const day = c.fc.daily[0] || {};
      const isCurrent = state.place && c.place.id === state.place.id;
      // 未来 7 天的迷你量程条：用这 7 天的温差自己归一化，只是"变化幅度"的示意
      const weekTemps = c.fc.daily.map((d) => d.high).filter((v) => v != null);
      const wMax = maxOf(weekTemps);
      const wMin = minOf(c.fc.daily.map((d) => d.low).filter((v) => v != null));

      return `<tr ${isCurrent ? 'aria-current="true"' : ''}>
        <th scope="row" class="city-cell">
          ${Icons.svg(cur.code, cur.isDay, { size: 22 })}
          <span>${esc(c.place.name)}<span class="compare__where">${esc(C.placeLabel(c.place))}</span></span>
        </th>
        <td>${esc(C.describeCode(cur.code).label)}</td>
        <td class="num ${isMax(cur.temp, temps) ? 'extreme' : ''}">${cur.temp == null ? '—' : t_(cur.temp) + '°'}</td>
        <td class="num">${day.low == null || day.high == null ? '—' : t_(day.low) + '° / ' + t_(day.high) + '°'}</td>
        <td class="num ${isMax(cur.humidity, hums) ? 'extreme' : ''}">${cur.humidity == null ? '—' : Math.round(cur.humidity) + '%'}</td>
        <td class="num ${isMax(cur.wind, winds) ? 'extreme' : ''}">${cur.wind == null ? '—' : u(cur.wind) + ' ' + C.windLabel(unit)}</td>
        <td class="num ${isMax(day.precip, rains) ? 'extreme' : ''}">${day.precip == null ? '—' : C.round1(day.precip) + ' mm'}</td>
        <td class="num">${wMax == null || wMin == null ? '—' : t_(wMin) + '° ~ ' + t_(wMax) + '°'}</td>
      </tr>`;
    }).join('');

    el.compareTable.innerHTML = head + '<tbody>' + body + '</tbody>';
  }

  /* ------------------------------------------------------------ 渲染：历史 */

  function rangeToDates(days) {
    const today = new Date();
    const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 2));
    const start = new Date(end.getTime() - days * 86400000);
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }

  async function loadHistory(range) {
    if (!state.place) return;
    const r = range && range.start ? range : rangeToDates(range && range.days ? range.days : state.rangeDays);

    state.historyLoading = true;
    el.historyHint.hidden = false;
    el.historyHint.textContent = '正在取历史数据…';
    el.historyStats.innerHTML = '';
    el.historyPlot.innerHTML = '';
    el.historyCompose.innerHTML = '';
    el.historyReading.innerHTML = '';
    el.historyCap.textContent = '';

    try {
      const body = await api('/api/archive', {
        lat: state.place.latitude,
        lon: state.place.longitude,
        start: r.start,
        end: r.end,
      });
      state.history = body.data;
      state.historyLoading = false;
      renderHistory();
    } catch (err) {
      state.historyLoading = false;
      state.history = null;
      el.historyHint.hidden = false;
      el.historyHint.textContent = `历史数据取不到：${err.message}`;
      el.historyAside.textContent = '取数失败';
    }
  }

  function renderHistory() {
    const h = state.history;
    if (!h || !h.summary) {
      el.historyHint.hidden = false;
      el.historyHint.textContent = '这段区间没有历史数据。换个时间范围试试。';
      return;
    }

    el.historyHint.hidden = true;
    el.historyAside.textContent = `${h.startDate} ~ ${h.endDate} · ${h.summary.days} 天`
      + (h.clamped ? ' · 已按数据可用范围截取' : '');

    const s = h.summary;
    const unit = state.unit;
    const stats = [
      ['平均气温', s.meanTemp == null ? '—' : t_(s.meanTemp) + '°', C.tempLabel(unit), s.meanHigh == null ? '' : `均高 ${t_(s.meanHigh)}° / 均低 ${t_(s.meanLow)}°`],
      ['最高气温', s.maxTemp == null ? '—' : t_(s.maxTemp) + '°', '', s.maxTempDate || ''],
      ['最低气温', s.minTemp == null ? '—' : t_(s.minTemp) + '°', '', s.minTempDate || ''],
      ['降水合计', s.totalPrecip == null ? '—' : String(C.round1(s.totalPrecip)), 'mm', s.rainDays == null ? '' : `雨日 ${s.rainDays} 天`],
      ['最多雨的一天', s.wettestDay == null ? '—' : String(C.round1(s.wettestDay)), 'mm', s.wettestDate || ''],
      ['日照合计', s.totalSunshine == null ? '—' : String(s.totalSunshine), 'h', s.meanUv == null ? '' : `均紫外线 ${Math.round(s.meanUv)}`],
    ];
    if (s.meanHumidity != null) stats.push(['平均湿度', String(Math.round(s.meanHumidity)), '%', s.meanWind == null ? '' : `均风速 ${u(s.meanWind)} ${C.windLabel(unit)}`]);

    el.historyStats.innerHTML = stats.map(([key, val, small, sub]) => `
      <div class="stat">
        <p class="stat__key">${esc(key)}</p>
        <p class="stat__val">${esc(val)}${small ? `<small>${esc(small)}</small>` : ''}</p>
        ${sub ? `<p class="stat__sub">${esc(sub)}</p>` : ''}
      </div>`).join('');

    el.historyCap.textContent = h.grain === 'month'
      ? '按月聚合：折线是月均温，浅色带是月内高低温范围，底部灰柱是月降水量'
      : '日值：折线是日均温，浅色带是当日高低温范围，底部灰柱是日降水量';

    el.historyPlot.innerHTML = Chart.historySeries(h.series, { unit, grain: h.grain });

    // 天气构成
    el.historyCompose.innerHTML = `
      <div class="compose__strip" aria-hidden="true">
        ${h.composition.items.map((x) => `<span class="compose__seg" style="flex:${x.days};background:${composeColor(x.key)}"></span>`).join('')}
      </div>
      ${h.composition.items.map((x) => `
        <li class="compose__item">
          <span class="compose__dot" style="background:${composeColor(x.key)}"></span>
          <span>${esc(x.name)}</span>
          <span class="compose__days">${x.days} 天</span>
          <span class="compose__pct">${Math.round(x.ratio * 100)}%</span>
        </li>`).join('')}`;

    el.historyReading.innerHTML = readings(h, unit).map((r) => `<li>${r}</li>`).join('');
  }

  const COMPOSE_COLORS = {
    clear: '#e0b74a', cloud: '#9aa7b4', rain: '#5fb7d4',
    snow: '#cfe0f0', fog: '#b9b3a0', storm: '#b79ae0',
  };
  const composeColor = (key) => COMPOSE_COLORS[key] || '#9aa7b4';

  /**
   * 把统计写成几句话。
   *
   * 这一块是"历史天气"真正有用的地方：光给一堆均值用户看不出什么，
   * 得把它和参照物比一比——和前半段比、和降水天数比、和紫外线峰值比。
   * 所以每条都是一句带数字的结论，而不是形容词。
   */
  function readings(h, unit) {
    const s = h.summary;
    const out = [];

    if (s.halfAnomaly != null) {
      const mag = Math.abs(s.halfAnomaly);
      // 幅度分三档说，避免"是不明显的的降温趋势"这种叠字，也别把 0.3 度说成趋势
      const word = mag >= 2 ? '明显' : mag >= 0.8 ? '一定' : '轻微';
      out.push(`这段区间的后半段比前半段平均${s.halfAnomaly > 0 ? '升' : '降'} <b>${mag.toFixed(1)}°</b>，`
        + `属于${word}的${s.halfAnomaly > 0 ? '回暖' : '降温'}。`);
    }

    if (s.rainRatio != null) {
      out.push(`${s.days} 天里有 <b>${s.rainDays}</b> 天出现降水（占 ${Math.round(s.rainRatio * 100)}%），`
        + `其中 <b>${s.heavyDays}</b> 天日降水量达到 10 mm 以上。`);
    }

    if (s.maxTemp != null && s.minTemp != null) {
      out.push(`气温区间 <b>${t_(s.minTemp)}° ~ ${t_(s.maxTemp)}°</b>，`
        + `日较差大约 ${Math.round((s.meanHigh != null && s.meanLow != null ? s.meanHigh - s.meanLow : 0))} 度。`);
    }

    if (s.totalPrecip != null && s.days) {
      const perDay = s.totalPrecip / s.days;
      out.push(`平均每天降水 <b>${C.round1(perDay)} mm</b>，`
        + `${s.wettestDate ? `最多的一天是 ${s.wettestDate}（${C.round1(s.wettestDay)} mm）` : ''}。`);
    }

    if (s.meanUv != null && s.meanUv >= 4) {
      out.push(`平均紫外线指数 <b>${Math.round(s.meanUv)}</b>，日照较强，户外注意防晒。`);
    }

    return out.slice(0, 5);
  }

  /* ---------------------------------------------------------------- 渲染：观测 */

  function renderObservation() {
    const norm = state.forecast;
    if (!norm) return;
    const cur = norm.current;

    el.placeName.textContent = state.place.name;
    el.placeWhere.textContent = [
      C.placeLabel(state.place),
      C.formatCoords(norm.latitude != null ? norm.latitude : state.place.latitude,
                     norm.longitude != null ? norm.longitude : state.place.longitude),
    ].filter(Boolean).join('  ·  ');

    el.obsTime.textContent = C.formatObserved(norm.observedAt);
    el.obsZone.textContent = norm.timezone || '当地时区';

    const temp = t(cur.temp);
    el.tempNow.textContent = temp == null ? '--' : String(temp);
    /* 原始摄氏值挂到 DOM 上。显示值是被取整过的，无法反推原始值，
       而「换算是否正确」只有拿原始值才算得准（31.0°C 是 88°F，不是 89）。
       交互自检读这个属性来核对，省得把浮点值藏在闭包里没法验证。 */
    el.tempNow.dataset.tempC = cur.temp == null ? '' : String(cur.temp);
    el.tempUnit.textContent = tUnit();

    // 主读数这个符号是整屏最大的一处天象，开动画；
    // 7 日条带里那一排小符号保持静态（见 renderWeek），一排都在动是干扰
    el.nowIcon.innerHTML = Icons.svg(cur.code, cur.isDay, { size: 38, animate: true });
    el.condNow.textContent = C.describeCode(cur.code).label;
    el.feelsNow.textContent = cur.feels == null ? '—' : t(cur.feels) + '°';
    el.todayRange.textContent = (norm.today && norm.today.high != null && norm.today.low != null)
      ? `${t(norm.today.low)}° / ${t(norm.today.high)}°` : '—';

    const note = C.observationLine(norm, state.unit);
    el.obsNote.textContent = note;

    /* --- 湿度 --- */
    el.humidity.textContent = cur.humidity == null ? '--' : String(Math.round(cur.humidity));
    el.scaleHumidity.querySelector('i').style.width = cur.humidity == null
      ? '0%' : Math.max(0, Math.min(100, cur.humidity)) + '%';

    /* --- 风：读数 + 指北针。风速是「风吹向哪里」的反方向，气象上的风向指来向，
           所以指针要指向风的来向：角度直接用上游给的风向角。 --- */
    const speed = u(cur.wind);
    el.wind.textContent = speed == null ? '--' : String(speed);
    el.windUnit.textContent = C.windLabel(state.unit);
    const level = C.beaufort(cur.wind);
    el.windDir.textContent = cur.windDir == null
      ? '—'
      : `${C.windDir(cur.windDir)} ${Math.round(cur.windDir)}°`
        + (level != null ? ` · ${level} 级 ${C.beaufortWord(level)}` : '');
    el.vane.setAttribute('aria-label', cur.windDir == null ? '风向未知' : `风向 ${C.windDir(cur.windDir)} ${Math.round(cur.windDir)} 度`);
    el.needle.style.transform = cur.windDir == null ? 'rotate(0deg)' : `rotate(${cur.windDir}deg)`;

    /* --- 气压 --- */
    const p = C.pressureIn(cur.pressure, state.unit);
    el.pressure.textContent = p ? String(p.value) : '--';
    el.pressureUnit.textContent = p ? p.unit : 'hPa';
    el.pressureAlt.textContent = p ? p.alt : '—';

    /* --- 今日降水概率：取 24 小时里的最大值，比取"此刻"更有参考价值 --- */
    const pops = norm.hours.map((h) => h.pop).filter((v) => v != null);
    const popMax = pops.length ? Math.max.apply(null, pops) : (norm.today ? norm.today.pop : null);
    el.pop.textContent = popMax == null ? '--' : String(Math.round(popMax));
    el.precip.textContent = cur.precip
      ? `当前有降水 ${C.round1(cur.precip)} mm`
      : '当前无降水';

    renderRibbon();
    renderAir();
  }

  /**
   * 今日量程条：把「当前气温」放在「今日低温→高温」这一段上。
   * 这是这一屏里唯一一个"把数字变成位置"的元素，看长度就知道今天走到哪儿了。
   */
  function renderRibbon() {
    const norm = state.forecast;
    const cur = norm && norm.current;
    const today = norm && norm.today;
    if (!cur || !today || today.low == null || today.high == null) return;

    const lo = Math.min(today.low, today.high);
    const hi = Math.max(today.low, today.high);
    const span = hi - lo;
    // 一天的温差可能不到 1 度，那时整条量程几乎重合，指针位置就没有信息量，
    // 用一个最小可视跨度兜住，至少还能看出指针在中间。
    const axisLo = lo - Math.max(1, span * 0.12);
    const axisHi = hi + Math.max(1, span * 0.12);
    const pos = (v) => Math.max(0, Math.min(100, ((v - axisLo) / (axisHi - axisLo)) * 100));

    el.ribbonBand.style.left = pos(lo) + '%';
    el.ribbonBand.style.width = Math.max(1.5, pos(hi) - pos(lo)) + '%';
    el.ribbonDot.style.left = `calc(${pos(cur.temp)}% - 1px)`;
    el.ribbonLow.textContent = t(lo) + '°';
    el.ribbonHigh.textContent = t(hi) + '°';
  }

  /* ---------------------------------------------------------------- 渲染：曲线 */

  /** 取某一天（0 = 今天）的 24 小时。今天用「从此刻起」的窗口，其余日子用该日 0–23 点。 */
  function hoursForDay(index) {
    const norm = state.forecast;
    if (!norm) return [];

    // 原始响应里的 hourly 全程都在，按日期切一段即可
    const raw = norm.rawHourly;
    if (!raw || !raw.time) return norm.hours || [];

    const day = norm.daily[index];
    if (!day) return [];

    if (index === 0) return norm.hours || [];

    const out = [];
    for (let i = 0; i < raw.time.length; i++) {
      if (!raw.time[i].startsWith(day.date)) continue;
      if (raw.temperature_2m[i] == null) continue;
      out.push({
        time: raw.time[i],
        temp: raw.temperature_2m[i],
        code: raw.weather_code ? raw.weather_code[i] : null,
        pop: raw.precipitation_probability ? raw.precipitation_probability[i] : null,
        wind: raw.wind_speed_10m ? raw.wind_speed_10m[i] : null,
      });
    }
    return out;
  }

  function renderCurve() {
    const norm = state.forecast;
    if (!norm) return;

    const day = norm.daily[state.hoursDayIndex];
    state.hours = hoursForDay(state.hoursDayIndex);

    const isToday = state.hoursDayIndex === 0;
    const label = day
      ? (isToday ? `今天 ${day.monthDay} ${day.weekday}` : `${day.monthDay} ${day.weekday} 全天`)
      : '';
    el.curveAside.textContent = label;

    el.plotbox.innerHTML = Chart.hourly({
      hours: state.hours,
      unit: state.unit,
      sunrise: day && day.sunrise,
      sunset: day && day.sunset,
      emptyText: isToday ? '这 24 小时没有观测数据' : '这一天没有逐小时数据',
    });

    const svg = el.plotbox.querySelector('svg');
    if (state.cursor) { state.cursor.destroy(); state.cursor = null; }
    if (svg) {
      state.cursor = Chart.attachCursor(svg, state.hours, {
        unit: state.unit,
        onRead: (i, h, silent) => {
          if (!silent) readout(i, h);
        },
      });
    }
    readout(0, state.hours[0]);
  }

  /** 曲线读数条：光标停在哪一小时，这四个槽就是哪一小时的数据。 */
  function readout(i, h) {
    if (!h) {
      el.rbTime.textContent = '—';
      el.rbTemp.textContent = '--';
      el.rbCond.textContent = '—';
      el.rbPop.textContent = '—';
      return;
    }
    const hour = C.hourOf(h.time);
    el.rbTime.textContent = state.hoursDayIndex === 0
      ? `${C.hourOffsetLabel(i)} · ${hour}:00`
      : `${hour}:00`;
    el.rbTemp.textContent = t(h.temp) + '°' + (state.unit === 'f' ? 'F' : 'C');
    el.rbCond.textContent = C.describeCode(h.code).label;
    el.rbPop.textContent = h.pop == null ? '降水概率 —' : `降水概率 ${Math.round(h.pop)}%`;
  }

  /* ---------------------------------------------------------------- 渲染：7 日 */

  /**
   * 7 日条带。关键在「同一把尺」：
   * 先把 7 天的高低温和当前气温一起求出整体上下限，再让每一行的长度按这个公共量程算。
   * 只有这样，跨行比长短才等于比温度——每行各自归一化会画出一张看着很热闹但没有比较意义的图。
   */
  function renderWeek() {
    const norm = state.forecast;
    if (!norm || !norm.daily.length) return;

    const days = norm.daily;
    const lows = days.map((d) => d.low).filter((v) => v != null);
    const highs = days.map((d) => d.high).filter((v) => v != null);
    const now = norm.current.temp;
    const lo = Math.min.apply(null, lows.concat(now != null ? [now] : []));
    const hi = Math.max.apply(null, highs.concat(now != null ? [now] : []));
    const pad = Math.max(1, (hi - lo) * 0.08);
    const axisLo = lo - pad;
    const axisHi = hi + pad;
    const pct = (v) => ((v - axisLo) / (axisHi - axisLo)) * 100;

    /* 顶部刻度：只在整度数位置画，免得出现 12.4° 这种刻度 */
    el.weekScale.innerHTML = C.ticks(axisLo, axisHi, 5).map((v) => (
      `<span class="week__grade" style="left:${pct(v).toFixed(2)}%">${t(v)}°</span>`
    )).join('');

    el.week.innerHTML = days.map((d, i) => {
      const left = d.low == null ? 0 : pct(d.low);
      const right = d.high == null ? 0 : pct(d.high);
      const width = Math.max(2, right - left);
      const isToday = i === 0;
      /* 展开态必须从 state.hoursDayIndex 现读，不能沿用上一次渲染留下的 DOM 节点：
         点某一天会重建整份列表，旧节点已经脱出文档，
         再拿它去改属性，改的是一个没人看见的副本——标签会一直停在"未展开"。
         这也是交互自检能抓到、肉眼看版面看不出的那类问题。 */
      const expanded = i === state.hoursDayIndex;
      return `<li>
        <button class="week__row ${d.isWeekend ? 'week__row--weekend' : ''}" type="button"
                data-day="${i}" ${isToday ? 'data-today' : ''} aria-expanded="${expanded}"
                title="${esc(`${d.date} 查看这一天的逐小时曲线`)}">
          <span class="week__grid">
            <span>
              <span class="week__day">${esc(C.relativeDay(i, d.weekday))}</span>
              <span class="week__date">${esc(d.monthDay)}</span>
            </span>
            <span class="week__icon">${Icons.svg(d.code, true, { size: 30, title: C.describeCode(d.code).label })}</span>
            <span class="week__cond">${esc(C.describeCode(d.code).label)}${d.pop != null && d.pop >= 30 ? ` · ${Math.round(d.pop)}%` : ''}</span>
            <span class="week__temp week__temp--low">${d.low == null ? '--' : t(d.low) + '°'}</span>
            <span class="week__bar"><i style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"></i></span>
            <span class="week__temp">${d.high == null ? '--' : t(d.high) + '°'}</span>
          </span>
        </button>
      </li>`;
    }).join('');

    renderDaybox();
  }

  /** 展开的那一天：把这一行的数据摊开，附日出日落与降水量。 */
  function renderDaybox() {
    const norm = state.forecast;
    const d = norm && norm.daily[state.hoursDayIndex];
    if (!d) {
      el.daybox.hidden = true;
      return;
    }
    el.daybox.hidden = false;

    const cells = [
      ['天气', C.describeCode(d.code).label, false],
      ['最高', d.high == null ? '—' : t(d.high) + '°' + (state.unit === 'f' ? 'F' : 'C'), true],
      ['最低', d.low == null ? '—' : t(d.low) + '°' + (state.unit === 'f' ? 'F' : 'C'), true],
      ['日较差', d.high == null || d.low == null ? '—' : Math.round(d.high - d.low) + '°', true],
      ['降水概率', d.pop == null ? '—' : Math.round(d.pop) + '%', true],
      ['降水量', d.precip == null ? '—' : C.round1(d.precip) + ' mm', true],
      ['最大风速', d.wind == null ? '—' : u(d.wind) + ' ' + C.windLabel(state.unit), true],
      ['日出 / 日落', `${d.sunrise || '—'} / ${d.sunset || '—'}`, true],
    ];

    el.daybox.innerHTML = `<div class="daybox__head">
        <h3 class="daybox__title">${esc(C.formatDayHeading(d.date))}</h3>
        <p class="panel__aside">上方曲线同时切换到这一天</p>
      </div>
      <div class="daybox__grid">
        ${cells.map(([k, v, mono]) => `<div class="daybox__cell">
            <p class="daybox__key">${esc(k)}</p>
            <p class="daybox__val">${esc(v)}</p>
          </div>`).join('')}
      </div>`;
  }

  /* ---------------------------------------------------------------- 渲染：左栏 */

  function renderRail() {
    el.railCount.textContent = String(state.saved.length);
    el.railNote.hidden = state.saved.length > 0;

    const currentId = state.place ? state.place.id : null;

    el.savedList.innerHTML = state.saved.map((p) => {
      const wx = state.railWx.get(p.id);
      const tempText = wx && wx.current && wx.current.temp != null
        ? t(wx.current.temp) + '°'
        : (wx === null ? '—' : '···');
      const cond = wx && wx.current ? C.describeCode(wx.current.code).label : '';
      const icon = wx && wx.current
        ? Icons.svg(wx.current.code, wx.current.isDay, { size: 22, title: cond })
        : '';
      return `<li class="rail__row">
        <button class="rail__item" type="button" data-place="${esc(p.id)}"
                aria-current="${p.id === currentId}" title="${esc(`${p.name} ${C.placeLabel(p)}`)}">
          <span class="rail__icon">${icon}</span>
          <span class="rail__text">
            <span class="rail__name">${esc(p.name)}</span>
            <span class="rail__sub">${esc(cond || p.region || p.country || '待观测')}</span>
          </span>
          <span class="rail__temp ${wx === null ? 'rail__temp--none' : ''}">${esc(tempText)}</span>
        </button>
        <!-- 移除按钮是 item 的兄弟节点，不是它的子节点：
             按钮里套按钮既是无效 HTML，点击行为在浏览器之间也不一致。
             它靠视觉上的叠放贴回行内右上角（见 .rail__drop 的绝对定位）。 -->
        <button class="rail__drop" type="button" data-drop="${esc(p.id)}"
                aria-label="${esc(`把 ${p.name} 从常用城市移除`)}" title="从常用城市移除">✕</button>
      </li>`;
    }).join('');

    el.historyMeta.innerHTML = state.place
      ? `当前观测<br>${esc(state.place.name)}<br>${esc(C.formatCoords(state.place.latitude, state.place.longitude))}`
      : '';
  }

  /** 收藏城市逐个补天气：先渲染骨架，再由这里填数字，避免整栏等最慢的那一个。 */
  function fillRailWx() {
    state.saved.forEach((p) => {
      if (state.railWx.has(p.id)) return;
      api('/api/forecast', { lat: p.latitude, lon: p.longitude })
        .then((body) => {
          const norm = C.normalizeForecast(body.data);
          if (!norm) return;
          state.railWx.set(p.id, norm);
          updateRailRow(p.id);
        })
        .catch(() => {
          // 单个城市取不到就留空，左栏不是主视图，不打断用户
          state.railWx.set(p.id, null);
          updateRailRow(p.id);
        });
    });
  }

  function updateRailRow(id) {
    const btn = el.savedList.querySelector(`[data-place="${CSS.escape(id)}"]`);
    if (!btn) return;
    const wx = state.railWx.get(id);
    const p = state.saved.find((x) => x.id === id);
    const tempEl = btn.querySelector('.rail__temp');
    const subEl = btn.querySelector('.rail__sub');

    if (!wx || !wx.current) {
      tempEl.textContent = '—';
      tempEl.classList.add('rail__temp--none');
      subEl.textContent = (p && (p.region || p.country)) || '暂不可用';
      return;
    }
    tempEl.classList.remove('rail__temp--none');
    tempEl.textContent = t(wx.current.temp) + '°';
    subEl.textContent = C.describeCode(wx.current.code).label;
  }

  /* ------------------------------------------------------------------ 加载 */

  /**
   * 取一个地点的完整观测。seq 用来丢弃过期响应：
   * 连续点两个城市时，先发的请求可能后到，不挡掉就会把界面刷回上一个城市。
   */
  async function load(place, opts) {
    const o = opts || {};
    const seq = ++state.loadSeq;
    lastLoad = Date.now();
    state.place = place;
    state.railWx.set(place.id, null);

    el.body.dataset.state = 'loading';
    el.placeName.textContent = place.name;
    el.placeWhere.textContent = '正在获取观测数据';
    el.obsTime.textContent = '—';
    el.obsZone.textContent = '—';
    renderRail();

    try {
      /* 天气和空气质量并行取：两者互不依赖，串行会白白多等一个往返。
         空气质量失败不影响天气显示——所以用 allSettled 而不是 all。 */
      const [wxRes, airRes] = await Promise.allSettled([
        api('/api/forecast', { lat: place.latitude, lon: place.longitude }),
        api('/api/air', { lat: place.latitude, lon: place.longitude }),
      ]);
      if (seq !== state.loadSeq) return;
      if (wxRes.status === 'rejected') throw wxRes.reason;

      const body = wxRes.value;
      const norm = C.normalizeForecast(body.data);
      if (!norm) throw new Error('观测数据格式不认识');

      // 预警推导要 CAPE 和能见度，normalizeForecast 已经把原始逐小时数组挂上了
      state.forecast = norm;
      state.hoursDayIndex = 0;
      state.railWx.set(place.id, norm);

      /* 空气质量：拿不到就是 null，界面显示「暂无数据」而不是 0。
         0 会被读成"空气极好"，那是在编结论。 */
      state.air = null;
      if (airRes.status === 'fulfilled') {
        const airData = airRes.value.data || {};
        const now = airData.current || {};
        state.air = Aqi.fromCurrent(now);
        if (state.air) state.air.uv = C.num(now.uv_index);
        state.airSeries = Aqi.trendFromHourly(airData.hourly || {});
      } else {
        state.airSeries = [];
      }

      // 预警：要用到刚算出的 AQI，所以必须在这之后
      state.alerts = Alerts.derive(norm, state.air);

      // 上游时区比地名库更可靠，用它补全地点信息
      state.place = Object.assign({}, place, {
        timezone: norm.timezone || place.timezone,
        name: place.name || '我的位置',
      });

      persist(STORE.last, JSON.stringify(state.place));
      paintTone(norm);
      renderAlerts();
      renderObservation();
      renderCurve();
      renderWeek();
      renderRail();
      renderCollectButton();
      fillRailWx();

      el.body.dataset.state = 'ready';
      verifyHook();

      /* 对比与历史是"次要视图"：主读数出来之后再取，避免拖慢首屏。
         各自失败只影响自己那一块——所以分开 catch，并且把原因说出来。
         早先这里是裸调用，任何一侧抛异常都会变成一个没人看见的 unhandled rejection，
         页面上只留下"正在取数…"不动，排查时毫无线索。 */
      // 用户没调过对比清单时，此时才知道"当前城市"，用它来定默认值
      if (!state.picksTouched && !state.picksReady) {
        state.picks = defaultPicks();
        if (state.picks.length) state.picksReady = true;
      }
      loadCompare().catch((e) => reportError('对比区', e));
      loadHistory().catch((e) => reportError('历史区', e));
      if (body.stale && body.warning) notice(esc(body.warning) + '。', 'error', { key: 'stale' });
      else clearNotice('stale');
    } catch (err) {
      if (seq !== state.loadSeq) return;
      /* 失败也必须离开 loading 态：否则占位符会一直挂着，
         用户看到的是"永远在读表"，而不知道已经失败了。 */
      el.body.dataset.state = 'error';
      // 预警和空气质量跟着这次取数一起作废，不能把上一个城市的结论留在屏幕上
      state.alerts = [];
      state.air = null;
      state.airSeries = [];
      renderAlerts();
      renderAir();
      verifyHook();
      notice(`<b>取不到 ${esc(place.name)} 的观测</b>：${esc(err.message)}。`
        + `<button class="notice__retry" type="button">重试</button>`, 'error', { key: 'load' });
      const retry = el.notices.querySelector('.notice__retry');
      if (retry) retry.addEventListener('click', () => load(place));
    }
  }

  /**
   * 版面自检钩子：只有页面带了 ?verify=1（也就是加载了 verify-probe.js）时才有东西。
   * 放在这里而不是用事件，是因为探针要量的正是"这一帧渲染出来的版面"，
   * 延后或合并都会量到错的时机。正常使用时这个调用是一次空操作。
   */
  function verifyHook() {
    if (typeof window.__CLOUD_VERIFY__ === 'function') window.__CLOUD_VERIFY__();
  }

  /**
   * 地名 → 地点列表。
   *
   * 检索本身全在服务端做：那边会同时查两个地名库、合并去重、按行政级别排序，
   * 查不到时还会依次尝试拆省级前缀、拆地级市前缀、换外文原名。
   * 前端只负责把 note 说明转达给用户——"为什么冒出来一个外文名字"这种事必须说清楚。
   */
  async function findPlace(q) {
    const body = await api('/api/search', { q });
    const hits = (body.data && body.data.results) || [];
    return { hits, note: body.note || null, partial: !!body.partial };
  }

  /** 把上次检索的说明挂到提示行上；没有说明就恢复成默认提示。 */
  function applySearchNote(note, count) {
    if (note) {
      el.hint.textContent = note;
      return;
    }
    el.hint.textContent = count ? `${count} 个地名` : DEFAULT_HINT;
  }

  /* ------------------------------------------------------------------ 检索 */

  function showSuggestions(items) {
    state.suggestions = items;
    state.activeSuggest = -1;

    if (!items.length) {
      el.list.hidden = true;
      el.input.setAttribute('aria-expanded', 'false');
      return;
    }

    el.list.innerHTML = items.map((p, i) => `
      <li class="seek__opt" role="option" id="seek-opt-${i}" data-index="${i}" aria-selected="false">
        <span class="seek__opt-name">${esc(p.name)}</span>
        <span class="seek__opt-region">${esc([p.region, p.country].filter(Boolean).join(' · ') || '—')}</span>
        <span class="seek__opt-coord">${esc(C.formatCoords(p.latitude, p.longitude))}</span>
      </li>`).join('');

    el.list.hidden = false;
    el.input.setAttribute('aria-expanded', 'true');
  }

  function highlightSuggestion(index) {
    const opts = Array.from(el.list.querySelectorAll('.seek__opt'));
    if (!opts.length) return;
    state.activeSuggest = (index + opts.length) % opts.length;
    opts.forEach((node, i) => node.setAttribute('aria-selected', String(i === state.activeSuggest)));
    const active = opts[state.activeSuggest];
    if (active) {
      el.input.setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView({ block: 'nearest' });
    }
  }

  function closeSuggestions() {
    el.list.hidden = true;
    el.list.innerHTML = '';
    el.input.setAttribute('aria-expanded', 'false');
    el.input.removeAttribute('aria-activedescendant');
    state.suggestions = [];
    state.activeSuggest = -1;
  }

  function choose(place) {
    closeSuggestions();
    el.input.value = '';
    el.hint.textContent = '';
    clearNotice('search');
    load(place);
    // 手机上好用：选完自动收键盘
    if (document.activeElement === el.input) el.input.blur();
  }

  /**
   * 边打边查。中文输入法在组合期间会连续触发 input 事件，
   * compositionstart/end 用来避免把「杭」这种中间态发出去查一次。
   */
  let composing = false;
  let debounce = null;

  async function runSearch(q) {
    const seq = ++state.searchSeq;
    el.hint.textContent = '查询中…';
    try {
      const found = await findPlace(q);
      if (seq !== state.searchSeq) return;
      if (!found.hits.length) {
        closeSuggestions();
        el.hint.textContent = `没有找到「${q}」。换个说法试试，比如加上省份（山西临县），或改用英文名。`;
        return;
      }
      applySearchNote(found.note, found.hits.length);
      showSuggestions(found.hits);
    } catch (err) {
      if (seq !== state.searchSeq) return;
      closeSuggestions();
      el.hint.textContent = '';
      notice(`<b>地名查询失败</b>：${esc(err.message)}`, 'error', { key: 'search' });
    }
  }

  el.input.addEventListener('compositionstart', () => { composing = true; });
  el.input.addEventListener('compositionend', () => {
    composing = false;
    const q = el.input.value.trim();
    if (q.length >= 1) runSearch(q);
  });

  el.input.addEventListener('input', () => {
    if (composing) return;
    const q = el.input.value.trim();
    clearTimeout(debounce);
    if (!q) {
      closeSuggestions();
      el.hint.textContent = '';
      return;
    }
    el.hint.textContent = '查询中…';
    debounce = setTimeout(() => runSearch(q), 320);
  });

  el.input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      if (el.list.hidden) return;
      highlightSuggestion(state.activeSuggest + (ev.key === 'ArrowDown' ? 1 : -1));
      ev.preventDefault();
      return;
    }
    if (ev.key === 'Enter' && state.activeSuggest >= 0 && !el.list.hidden) {
      choose(state.suggestions[state.activeSuggest]);
      ev.preventDefault();
      return;
    }
    if (ev.key === 'Escape') closeSuggestions();
  });

  el.list.addEventListener('mousedown', (ev) => {
    const opt = ev.target.closest('.seek__opt');
    if (!opt) return;
    ev.preventDefault(); // 别让输入框先失焦，否则 blur 会先把列表关掉
    choose(state.suggestions[Number(opt.dataset.index)]);
  });

  el.form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const q = el.input.value.trim();
    if (!q) {
      el.input.focus();
      return;
    }
    if (state.activeSuggest >= 0 && state.suggestions[state.activeSuggest]) {
      return choose(state.suggestions[state.activeSuggest]);
    }
    // 直接回车：若候选里恰好只有一条，就用它；否则把候选摆出来让用户选
    const seq = ++state.searchSeq;
    el.hint.textContent = '查询中…';
    try {
      const found = await findPlace(q);
      if (seq !== state.searchSeq) return;
      if (!found.hits.length) {
        closeSuggestions();
        el.hint.textContent = `没有找到「${q}」。换个说法试试，比如加上省份（山西临县），或改用英文名。`;
        return;
      }
      if (found.hits.length === 1) return choose(found.hits[0]);
      showSuggestions(found.hits);
      highlightSuggestion(0);
      el.hint.textContent = found.note || '多个同名地点，选一个';
    } catch (err) {
      el.hint.textContent = '';
      notice(`<b>地名查询失败</b>：${esc(err.message)}`, 'error', { key: 'search' });
    }
  });

  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('.seek')) closeSuggestions();
  });

  /* ------------------------------------------------------------------ 定位 */

  /**
   * 浏览器定位。三条失败路径分开说：拒绝授权、拿不到位置、超时。
   * 三种原因对应的下一步不一样，含糊地说"定位失败"等于没说。
   */
  function geolocate() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('这个浏览器不支持定位'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy }),
        (err) => {
          const map = {
            1: '定位权限被拒绝，可在浏览器地址栏的权限设置里重新允许',
            2: '暂时取不到位置信号',
            3: '定位超时',
          };
          const e = new Error(map[err.code] || '定位失败');
          e.code = err.code;
          reject(e);
        },
        { enableHighAccuracy: false, timeout: 12000, maximumAge: 5 * 60 * 1000 },
      );
    });
  }

  async function locateAndLoad(opts) {
    const o = opts || {};
    el.locate.disabled = true;
    try {
      const coords = await geolocate();
      const body = await api('/api/place', { lat: coords.latitude, lon: coords.longitude });
      const place = C.normalizePlace(Object.assign({}, body.data, {
        latitude: coords.latitude,
        longitude: coords.longitude,
      }));
      if (!place) throw new Error('定位反查没有得到地点');
      if (coords.accuracy) {
        el.placeWhere.dataset.accuracy = `定位精度约 ${Math.round(coords.accuracy)} 米`;
      }
      clearNotice('locate');
      await load(place);
    } catch (err) {
      if (o.silent) {
        // 首次自动定位失败不打扰用户：静默退到默认城市，只在提示里留一句
        el.hint.textContent = '未能定位，已显示默认城市';
      } else {
        notice(`<b>定位没有成功</b>：${esc(err.message)}。也可以直接在上方输入城市名。`, 'error', { key: 'locate' });
      }
      if (o.fallback) await load(C.normalizePlace(o.fallback));
    } finally {
      el.locate.disabled = false;
    }
  }

  el.locate.addEventListener('click', () => locateAndLoad());

  /* ------------------------------------------------------------ 单位切换 */

  function setUnit(unit) {
    if (unit === state.unit) return;
    state.unit = unit;
    persist(STORE.unit, unit);
    document.documentElement.dataset.unit = unit;
    el.body.setAttribute('data-unit', unit);
    document.querySelectorAll('[data-unit-set]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.unitSet === unit));
    });
    // 单位只影响显示，所以整屏重渲染即可，不用重新取数
    if (state.forecast) {
      renderAlerts();
      renderObservation();
      renderCurve();
      renderWeek();
      renderRail();
      renderCompare();
      renderHistory();
    }
  }

  document.querySelectorAll('[data-unit-set]').forEach((btn) => {
    btn.addEventListener('click', () => setUnit(btn.dataset.unitSet));
  });

  /* ---------------------------------------------------------- 左栏与 7 日交互 */

  el.savedList.addEventListener('click', (ev) => {
    const drop = ev.target.closest('[data-drop]');
    if (drop) {
      const id = drop.dataset.drop;
      const place = state.saved.find((p) => p.id === id);
      if (!place) return;
      state.saved = C.removeSaved(state.saved, place);
      state.railWx.delete(id);
      persistSaved();
      renderRail();
      renderCollectButton();
      refreshCompare();
      return;
    }
    const item = ev.target.closest('[data-place]');
    if (!item) return;
    const place = state.saved.find((p) => p.id === item.dataset.place);
    if (place) load(place);
  });

  el.week.addEventListener('click', (ev) => {
    const row = ev.target.closest('[data-day]');
    if (!row) return;
    const index = Number(row.dataset.day);
    const already = index === state.hoursDayIndex;
    state.hoursDayIndex = index;
    renderCurve();
    renderWeek();
    if (!already && window.matchMedia('(max-width: 980px)').matches) {
      el.plotbox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  /* -------------------------------------------------------- 对比区的城市搜索 */

  /**
   * 对比区自己的搜索。
   *
   * 和顶部那个搜索框是两套东西，刻意不共用：
   *   - 顶部搜索是"切换当前城市"，选中的城市会接管整个页面；
   *   - 这里搜索是"往对比清单里加一个"，当前城市不动。
   * 如果共用一个输入框，用户就没法区分"我要切到这里"和"我要把它加进对比"，
   * 而这两件事的后果完全相反——前者会把主读数换掉。
   */
  let cmpDebounce = null;
  let cmpSeq = 0;

  el.cmpInput.addEventListener('input', () => {
    const q = el.cmpInput.value.trim();
    clearTimeout(cmpDebounce);
    if (!q) {
      closePickSuggest();
      return;
    }
    cmpDebounce = setTimeout(() => runPickSearch(q), 320);
  });

  el.cmpInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      if (el.cmpList.hidden) return;
      highlightPickSuggest(state.compareSel.active + (ev.key === 'ArrowDown' ? 1 : -1));
      ev.preventDefault();
      return;
    }
    if (ev.key === 'Enter' && state.compareSel.active >= 0 && !el.cmpList.hidden) {
      addPick(state.compareSel.hits[state.compareSel.active]);
      el.cmpInput.value = '';
      closePickSuggest();
      ev.preventDefault();
      return;
    }
    if (ev.key === 'Escape') closePickSuggest();
  });

  el.cmpList.addEventListener('mousedown', (ev) => {
    const opt = ev.target.closest('.seek__opt');
    if (!opt) return;
    ev.preventDefault();   // 别让输入框先失焦，否则 blur 会把列表关掉
    /* 已经在对比里、或清单已满的候选是"看得见但不能选"的：
       光标已经写成 not-allowed，点击就不能再去尝试添加——
       否则用户点一下什么也没发生，只会以为是坏了。 */
    if (opt.classList.contains('seek__opt--blocked')) {
      el.cmpNote.dataset.tone = 'hint';
      el.cmpNote.textContent = opt.querySelector('.seek__opt-region').textContent.trim();
      return;
    }
    addPick(state.compareSel.hits[Number(opt.dataset.index)]);
    el.cmpInput.value = '';
    closePickSuggest();
  });

  el.cmpForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const q = el.cmpInput.value.trim();
    if (!q) {
      el.cmpInput.focus();
      return;
    }
    if (state.compareSel.active >= 0 && state.compareSel.hits[state.compareSel.active]) {
      addPick(state.compareSel.hits[state.compareSel.active]);
      el.cmpInput.value = '';
      closePickSuggest();
      return;
    }
    // 直接回车：只有一条候选就直接加，多条就摆出来让用户选
    const hits = await pickSearch(q);
    if (!hits.length) {
      el.cmpNote.dataset.tone = 'hint';
      el.cmpNote.textContent = `没有找到「${q}」。换个说法试试，比如加上省份。`;
      return;
    }
    if (hits.length === 1) {
      addPick(hits[0]);
      el.cmpInput.value = '';
      closePickSuggest();
      return;
    }
    showPickSuggest(hits);
    highlightPickSuggest(0);
  });

  async function pickSearch(q) {
    const seq = ++cmpSeq;
    const found = await findPlace(q);
    if (seq !== cmpSeq) return [];
    return found.hits;
  }

  async function runPickSearch(q) {
    el.cmpNote.dataset.tone = 'hint';
    el.cmpNote.textContent = '查询中…';
    try {
      const hits = await pickSearch(q);
      if (!hits.length) {
        closePickSuggest();
        el.cmpNote.textContent = `没有找到「${q}」。换个说法试试，比如加上省份。`;
        return;
      }
      showPickSuggest(hits);
      if (!state.compareSel.active || state.compareSel.active < 0) {
        el.cmpNote.textContent = `${hits.length} 个候选，选一个加入对比`;
      }
    } catch (err) {
      closePickSuggest();
      el.cmpNote.textContent = `地名查询失败：${err.message}`;
    }
  }

  function showPickSuggest(hits) {
    state.compareSel = { hits, active: -1 };
    el.cmpList.innerHTML = hits.map((p, i) => {
      const blocked = addPickBlocker(p);
      return `<li class="seek__opt ${blocked ? 'seek__opt--blocked' : ''}" role="option"
        id="cmp-opt-${i}" data-index="${i}" aria-selected="false" ${blocked ? 'aria-disabled="true"' : ''}>
        <span class="seek__opt-name">${esc(p.name)}</span>
        <span class="seek__opt-region">${esc(blocked || [p.city, p.region].filter(Boolean).join(' · ') || '—')}</span>
        <span class="seek__opt-coord">${esc(C.formatCoords(p.latitude, p.longitude))}</span>
      </li>`;
    }).join('');
    el.cmpList.hidden = false;
    el.cmpInput.setAttribute('aria-expanded', 'true');
  }

  /** 键盘高亮时跳过不能选的候选：方向键停在"已经在对比里"的条目上没有意义。 */
  function highlightPickSuggest(index) {
    const opts = Array.from(el.cmpList.querySelectorAll('.seek__opt'));
    if (!opts.length) return;
    const usable = opts.filter((n) => !n.classList.contains('seek__opt--blocked'));
    if (!usable.length) {
      state.compareSel.active = -1;
      opts.forEach((n) => n.setAttribute('aria-selected', 'false'));
      el.cmpInput.removeAttribute('aria-activedescendant');
      return;
    }
    const n = usable.length;
    const next = usable[((index % n) + n) % n];
    state.compareSel.active = Number(next.dataset.index);
    opts.forEach((node) => node.setAttribute('aria-selected', String(node === next)));
    el.cmpInput.setAttribute('aria-activedescendant', next.id);
    next.scrollIntoView({ block: 'nearest' });
  }

  function closePickSuggest() {
    el.cmpList.hidden = true;
    el.cmpList.innerHTML = '';
    el.cmpInput.setAttribute('aria-expanded', 'false');
    el.cmpInput.removeAttribute('aria-activedescendant');
    state.compareSel = { hits: [], active: -1 };
  }

  el.cmpChips.addEventListener('click', (ev) => {
    const drop = ev.target.closest('[data-drop-pick]');
    if (!drop) return;
    const place = state.picks.find((p) => p.id === drop.dataset.dropPick);
    if (place) removePick(place);
  });

  /* 点页面别处收起候选。只在搜索框有内容或有候选时才处理，
     避免每次点击都去碰 DOM。 */
  document.addEventListener('click', (ev) => {
    if (el.cmpList.hidden) return;
    if (!ev.target.closest('.cmp-seek')) closePickSuggest();
  });

  /* -------------------------------------------------------- 对比与历史的交互 */

  // 图例点击：隐藏/显示某个城市。排除离群值看清其余几条线时用得上。
  el.compareLegend.addEventListener('click', (ev) => {
    const key = ev.target.closest('[data-city]');
    if (!key) return;
    const c = state.compare.find((x) => x.place.id === key.dataset.city);
    if (!c) return;
    // 不允许把所有城市都关掉：一张空图没有任何意义，用户会以为坏了
    const visible = state.compare.filter((x) => x.visible);
    if (c.visible && visible.length <= 1) return;
    c.visible = !c.visible;
    renderCompare();
  });

  // 时间范围：预设按钮 + 自定义
  el.historyRanges.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-range]');
    if (!btn) return;
    const days = Number(btn.dataset.range);
    state.rangeDays = days;
    syncRangeButtons(days, null);
    loadHistory({ days });
  });

  function syncRangeButtons(days, custom) {
    el.historyRanges.querySelectorAll('[data-range]').forEach((b) => {
      b.setAttribute('aria-pressed', String(!custom && Number(b.dataset.range) === days));
    });
    el.historyCustom.setAttribute('aria-pressed', String(!!custom));
    el.customRange.hidden = !custom;
  }

  el.historyCustom.addEventListener('click', () => {
    if (!el.customRange.hidden) {
      syncRangeButtons(state.rangeDays, null);
      return;
    }
    const r = rangeToDates(state.rangeDays);
    el.histStart.value = r.start;
    el.histEnd.value = r.end;
    syncRangeButtons(state.rangeDays, true);
    el.histStart.focus();
  });

  el.histGo.addEventListener('click', () => {
    const start = el.histStart.value;
    const end = el.histEnd.value;
    if (!start || !end) {
      notice('请填写完整的开始和结束日期。', 'error', { key: 'hist' });
      return;
    }
    if (start > end) {
      notice('开始日期不能晚于结束日期。', 'error', { key: 'hist' });
      return;
    }
    clearNotice('hist');
    loadHistory({ start, end });
  });

  /* 收藏变化时对比区跟着变。
     但要分清两种情况：用户还没动过对比清单时，收藏就是它的默认值，跟着走；
     一旦他手动加过或删过，就以他的选择为准，不再被收藏动作覆盖——
     否则精心挑的那几个城市会被下一次收藏打乱，而用户不知道为什么。 */
  function refreshCompare() {
    syncCompareDefault();
  }

  /* 「当前城市是否已收藏」的按钮在 HTML 里就有（见 index.html），
     但只在拿到数据、知道这是哪个地方之后才显示——
     没数据时留下一个"收藏这个城市"的按钮，点了也不知道收藏谁。 */
  function renderCollectButton() {
    const btn = document.getElementById('collect-btn');
    if (!btn) return;
    if (!state.place) {
      btn.hidden = true;
      return;
    }
    btn.hidden = false;
    const saved = C.hasSaved(state.saved, state.place);
    btn.textContent = saved ? '已收藏，点击取消' : '收藏这个城市';
    btn.classList.toggle('collect--on', saved);
    btn.onclick = () => {
      state.saved = saved ? C.removeSaved(state.saved, state.place) : C.addSaved(state.saved, state.place);
      persistSaved();
      renderRail();
      fillRailWx();
      renderCollectButton();
      refreshCompare();
      notice(saved ? `已从常用城市移除 <b>${esc(state.place.name)}</b>` : `已收藏 <b>${esc(state.place.name)}</b>，下次在左侧一点就到`, 'ok', { key: 'collect' });
    };
  }

  /* ------------------------------------------------------------- 启动流程 */

  /**
   * URL 参数只用于开发和截图，不影响正常使用：
   *   ?city=杭州     直接查这个地名（跳过定位）
   *   ?lat=30.29&lon=120.16   直接按坐标取数
   *   ?unit=f        以华氏开局（仍然会写进本地存储）
   *   ?nolocate=1    跳过自动定位，直接用默认城市
   *   ?fav=杭州,伦敦  预置常用城市（只在还没有收藏时生效）
   * 有了它，验证版面和跑截图都不用先过一遍浏览器的定位授权弹窗，
   * 也能进到"左栏已经有几个城市"这种平时需要点几次才出现的状态。
   */
  function readParams() {
    const q = new URLSearchParams(location.search);
    const out = {};
    const lat = Number(q.get('lat'));
    const lon = Number(q.get('lon'));
    if (q.get('lat') != null && q.get('lon') != null && Number.isFinite(lat) && Number.isFinite(lon)) {
      out.coords = { lat, lon };
    }
    if (q.get('city')) out.city = q.get('city');
    if (q.get('unit') === 'f' || q.get('unit') === 'c') out.unit = q.get('unit');
    if (q.get('nolocate') === '1') out.noLocate = true;
    if (q.get('fav')) {
      out.fav = q.get('fav').split(',').map((s) => s.trim()).filter(Boolean).slice(0, C.MAX_SAVED);
    }
    return out;
  }

  /**
   * 预置常用城市：查地名 → 取各自的天气 → 填进左栏。
   * 并发限制为 3，是一次"小批量取数"的示例：服务端有缓存，但一下子发十几个请求
   * 仍然会让首屏的曲线等更久，所以这里主动排队。
   */
  async function seedFavourites(names) {
    const places = [];
    for (const name of names) {
      try {
        const found = await findPlace(name);
        if (found.hits.length) places.push(found.hits[0]);
      } catch (e) {
        // 单个地名查不到就跳过，不影响其它预置城市
      }
    }
    if (!places.length) return;

    state.saved = places.reduce((list, p) => C.addSaved(list, p), []);
    persistSaved();
    // 收藏这时才载入，旧格式对比清单的迁移判断只能放在这里
    migrateLegacyPicks();
    renderRail();
    refreshCompare();

    const queue = places.slice();
    const worker = async () => {
      while (queue.length) {
        const place = queue.shift();
        try {
          const body = await api('/api/forecast', { lat: place.latitude, lon: place.longitude });
          state.railWx.set(place.id, C.normalizeForecast(body.data));
        } catch (e) {
          state.railWx.set(place.id, null);
        }
        renderRail();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  function boot() {
    /* 符号表是所有天象图标的图案与裁切路径，注入一次即可。
       只取 DEFS 里的内容——外面那层 <svg> 外壳已经写在 index.html 里，
       这样没脚本时也不会在页面上留一块看不见但占位的空白。 */
    el.sprite.innerHTML = Icons.DEFS;

    readStore();
    readPicks();
    /* 迁移判断要放在这里，不能只放在 seedFavourites 里。
       收藏是从本地存储读出来的（readStore 已经读到 state.saved），
       所以此刻就具备判断条件；而 seedFavourites 只在带了 ?fav= 时才跑，
       普通冷启动根本不会经过它——早先就是这个原因让迁移在真实使用中没生效。 */
    migrateLegacyPicks();

    const params = readParams();
    if (params.unit) state.unit = params.unit;

    document.documentElement.dataset.unit = state.unit;
    el.body.setAttribute('data-unit', state.unit);
    document.querySelectorAll('[data-unit-set]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.unitSet === state.unit));
    });

    renderRail();
    fillRailWx();

    /* 时间范围按钮的初始选中态要在这里定下来。
       不在 HTML 里写 aria-pressed 是因为"哪个是默认范围"由 state.rangeDays 决定，
       两处各写一遍迟早会不一致——而且缺少这个属性时，
       读屏软件读到的是一个"状态未知"的按钮，用户不知道当前选的是哪一档。 */
    syncRangeButtons(state.rangeDays, null);
    const initRange = rangeToDates(state.rangeDays);
    el.histStart.value = initRange.start;
    el.histEnd.value = initRange.end;

    // 提示行先给一句用法，别留一条空白——空着的提示行看起来像"这里出错了但没说"
    el.hint.textContent = DEFAULT_HINT;

    /* 启动顺序只在这一处决定：
       预置常用城市（如果有）先落地，再去取主城市；两条都走完才挂可见性监听。
       写成一条 async 流程而不是并行两路，是因为它们都要写左栏——
       并行的结果是左栏先后渲染两次，中间那一帧会闪。 */
    bootSequence(params);

    function bootSequence(p) {
      const seeded = (p.fav && p.fav.length) ? seedFavourites(p.fav) : Promise.resolve();
      seeded.then(() => {
        // 参数优先于记忆和定位：调参时不该被上一次的访问记录打断
        if (p.coords) {
          return load(C.normalizePlace({ latitude: p.coords.lat, longitude: p.coords.lon, name: '指定坐标' }));
        }
        if (p.city) {
          /* 按参数查城市。查不到也必须有结果——否则页面会永远停在「读表中」，
             那比显示一个默认城市糟糕得多：用户以为程序坏了，而其实只是一次查询没命中。 */
          return findPlace(p.city)
            .then((found) => {
              if (found.hits.length) return load(found.hits[0]);
              notice(`<b>没有找到「${esc(p.city)}」</b>，已显示默认城市。换个说法试试，比如加上省份或改用英文名。`, 'error', { key: 'city' });
              return load(C.normalizePlace(DEFAULT_PLACE));
            })
            .catch((err) => {
              notice(`<b>查询失败</b>：${esc(err.message)}。已显示默认城市。`, 'error', { key: 'city' });
              return load(C.normalizePlace(DEFAULT_PLACE));
            });
        }
        if (p.noLocate) return load(C.normalizePlace(DEFAULT_PLACE));
        if (state.place) return load(state.place);
        // 第一次打开：先试着定位。定位要授权、可能弹窗，所以失败就安静地退到默认城市，
        // 不把权限弹窗的失败写成一屏红字。
        return locateAndLoad({ silent: true, fallback: DEFAULT_PLACE });
      }).then(() => {
        booted = true;
      });
    }

    // 页面从后台切回前台时，如果数据已经过期就自动补一次
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !state.place || !booted) return;
      if (Date.now() - lastLoad > REFRESH_MS) load(state.place);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
