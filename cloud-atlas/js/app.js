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

  /* ---------------------------------------------------------------- 存储键 */

  const STORE = {
    unit: 'cloud-atlas.unit',
    saved: 'cloud-atlas.saved',
    last: 'cloud-atlas.last',
  };

  const DEFAULT_PLACE = { name: '北京', region: '北京', country: '中国', latitude: 39.9042, longitude: 116.4074 };
  const REFRESH_MS = 10 * 60 * 1000;   // 与 server.js 的缓存时长对齐
  const DEFAULT_HINT = '输入地名开始查询，或点「定位」取当地天气';

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

  /* ------------------------------------------------------------ 着色与标题 */

  /** 把天气码与昼夜落成 body 上的基调，整套配色随之切换。 */
  function paintTone(norm) {
    if (!norm || !norm.current) return;
    const tone = C.sky(norm.current.code, norm.current.isDay);
    if (el.body.dataset.tone !== tone) el.body.dataset.tone = tone;
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

    el.nowIcon.innerHTML = Icons.svg(cur.code, cur.isDay, { size: 38 });
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
      const body = await api('/api/forecast', { lat: place.latitude, lon: place.longitude });
      if (seq !== state.loadSeq) return;

      const norm = C.normalizeForecast(body.data);
      if (!norm) throw new Error('观测数据格式不认识');

      // hourly 原始数组留给「切换到某一天」用，不能只留切片
      norm.rawHourly = body.data && body.data.hourly;

      state.forecast = norm;
      state.hoursDayIndex = 0;
      state.railWx.set(place.id, norm);

      // 上游时区比地名库更可靠，用它补全地点信息
      state.place = Object.assign({}, place, {
        timezone: norm.timezone || place.timezone,
        name: place.name || '我的位置',
      });

      persist(STORE.last, JSON.stringify(state.place));
      paintTone(norm);
      renderObservation();
      renderCurve();
      renderWeek();
      renderRail();
      renderCollectButton();
      fillRailWx();

      el.body.dataset.state = 'ready';
      verifyHook();

      if (body.stale && body.warning) notice(esc(body.warning) + '。', 'error', { key: 'stale' });
      else clearNotice('stale');
    } catch (err) {
      if (seq !== state.loadSeq) return;
      /* 失败也必须离开 loading 态：否则占位符会一直挂着，
         用户看到的是"永远在读表"，而不知道已经失败了。 */
      el.body.dataset.state = 'error';
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
      renderObservation();
      renderCurve();
      renderWeek();
      renderRail();
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

  /* 「当前城市是否已收藏」的按钮不在 HTML 里，而是跟着观测一起渲染出来的：
     它只在拿到数据、知道这是哪个地方之后才有意义。 */
  function renderCollectButton() {
    if (!state.place) return;
    const saved = C.hasSaved(state.saved, state.place);
    let btn = document.getElementById('collect-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'collect-btn';
      btn.type = 'button';
      btn.className = 'collect';
      el.acts.appendChild(btn);
    }
    btn.textContent = saved ? '已收藏，点击取消' : '收藏这个城市';
    btn.classList.toggle('collect--on', saved);
    btn.onclick = () => {
      state.saved = saved ? C.removeSaved(state.saved, state.place) : C.addSaved(state.saved, state.place);
      persistSaved();
      renderRail();
      fillRailWx();
      renderCollectButton();
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
    renderRail();

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

    const params = readParams();
    if (params.unit) state.unit = params.unit;

    document.documentElement.dataset.unit = state.unit;
    el.body.setAttribute('data-unit', state.unit);
    document.querySelectorAll('[data-unit-set]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.unitSet === state.unit));
    });

    renderRail();
    fillRailWx();

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
