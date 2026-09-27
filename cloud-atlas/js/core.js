/* 云图 · 核心逻辑（纯函数，不碰 DOM、不碰网络）
 *
 * 这个文件是「数据契约」的唯一出处：
 *   - 上游接口长什么样（UPSTREAM）
 *   - 上游返回怎么被压成前端要用的形状（normalizeForecast / normalizePlace）
 *   - WMO 天气码怎么变成中文和视觉基调（describeCode）
 *   - 单位换算（convertTemp / windIn / convertPressure）
 *   - 曲线与进度条的几何（pathFrom / xAt / nearestIndex）
 *
 * 为什么要单独拆出来：这些换算和几何判断最容易出错，又最不适合靠肉眼看页面来验证。
 * 拆成纯函数之后，test/core.test.js 用 node:test 直接跑，改一行就知道有没有踩坏别的东西。
 * 浏览器端用 <script> 引入后挂在 window.CloudCore 上（见文件末尾）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CloudCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------------------------------------------------------------- 上游接口 */

  const UPSTREAM = {
    geocode: 'https://geocoding-api.open-meteo.com/v1/search',
    reverse: 'https://api.bigdatacloud.net/data/reverse-geocode-client',
    forecast: 'https://api.open-meteo.com/v1/forecast',
  };

  /* 一次请求要拿到的东西都写在这里，server.js 直接引用，避免两处字段名漂移 */
  const FORECAST_FIELDS = {
    current: [
      'temperature_2m',
      'relative_humidity_2m',
      'apparent_temperature',
      'is_day',
      'precipitation',
      'weather_code',
      'wind_speed_10m',
      'wind_direction_10m',
      'surface_pressure',
    ],
    hourly: ['temperature_2m', 'weather_code', 'precipitation_probability', 'wind_speed_10m'],
    daily: [
      'weather_code',
      'temperature_2m_max',
      'temperature_2m_min',
      'sunrise',
      'sunset',
      'precipitation_probability_max',
      'precipitation_sum',
      'wind_speed_10m_max',
    ],
  };

  /* 请求的量程：过去 1 小时到未来 24 小时，够画一条「从此刻起」的曲线 */
  const HOURS_PAST = 1;
  const HOURS_AHEAD = 24;
  const FORECAST_DAYS = 7;

  /* ------------------------------------------------------------------ 天气码 */
  /* WMO 4677 天气码。tone 决定整个界面的色彩基调，day/night 变体由 sky() 处理。 */

  const CODES = {
    0: { label: '晴', tone: 'clear' },
    1: { label: '晴间多云', tone: 'fair' },
    2: { label: '多云', tone: 'cloud' },
    3: { label: '阴', tone: 'overcast' },
    45: { label: '有雾', tone: 'fog' },
    48: { label: '雾凇', tone: 'fog' },
    51: { label: '小毛毛雨', tone: 'drizzle' },
    53: { label: '毛毛雨', tone: 'drizzle' },
    55: { label: '密毛毛雨', tone: 'drizzle' },
    56: { label: '冻毛毛雨', tone: 'drizzle' },
    57: { label: '强冻毛毛雨', tone: 'drizzle' },
    61: { label: '小雨', tone: 'rain' },
    63: { label: '中雨', tone: 'rain' },
    65: { label: '大雨', tone: 'rain' },
    66: { label: '冻雨', tone: 'rain' },
    67: { label: '强冻雨', tone: 'rain' },
    71: { label: '小雪', tone: 'snow' },
    73: { label: '中雪', tone: 'snow' },
    75: { label: '大雪', tone: 'snow' },
    77: { label: '米雪', tone: 'snow' },
    80: { label: '阵雨', tone: 'rain' },
    81: { label: '中阵雨', tone: 'rain' },
    82: { label: '强阵雨', tone: 'rain' },
    85: { label: '阵雪', tone: 'snow' },
    86: { label: '强阵雪', tone: 'snow' },
    95: { label: '雷阵雨', tone: 'storm' },
    96: { label: '雷阵雨伴冰雹', tone: 'storm' },
    99: { label: '强雷阵雨伴冰雹', tone: 'storm' },
  };

  /** 未知码不编造天气，直接说「观测缺报」——界面照常渲染，只是没有结论。 */
  const UNKNOWN = { label: '观测缺报', tone: 'cloud' };

  function describeCode(code) {
    return CODES[code] || UNKNOWN;
  }

  /**
   * 把「天气码 + 昼夜」翻译成界面的调色基调。
   * 返回的 tone 会变成 <body data-tone="...">，CSS 里整套变量随之切换。
   *
   * isDay 必须显式判断 === true：上游漏给 is_day 时是 null 或 undefined，
   * 用真假判断会把白天当成夜里，整页配色就错了。
   */
  function sky(code, isDay) {
    const base = describeCode(code);
    const night = isDay !== true;
    if (night) {
      if (base.tone === 'storm') return 'storm-night';
      if (base.tone === 'rain' || base.tone === 'drizzle') return 'rain-night';
      if (base.tone === 'snow') return 'snow-night';
      return 'night';
    }
    return base.tone;
  }

  /* -------------------------------------------------------------------- 单位 */

  const round1 = (v) => Math.round(v * 10) / 10;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /**
   * 是不是一个能用的数字。
   *
   * 这里必须写 typeof 判断，不能直接用 isFinite：JS 里 isFinite(null) === true、
   * isFinite('') === true，上游缺字段时给的是 null，一旦放过去就会被当成 0，
   * 于是「湿度未知」显示成「湿度 0%」、「风向未知」显示成「北风」——
   * 界面照样渲染，但显示的是编出来的天气。这是本项目最不能接受的一类错误。
   */
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  /** 温度和体感用整度，风用 0.1 精度，气压用整百帕。显示层不再二次取整。 */
  function convertTemp(c, unit) {
    const v = num(c);
    if (v == null) return null;
    return Math.round(unit === 'f' ? v * 9 / 5 + 32 : v);
  }

  function windIn(kmh, unit) {
    const v = num(kmh);
    if (v == null) return null;
    const w = unit === 'f' ? v / 1.609344 : v;
    return round1(w) === Math.round(w) ? Math.round(w) : round1(w);
  }

  function windLabel(unit) {
    return unit === 'f' ? 'mph' : 'km/h';
  }

  function tempLabel(unit) {
    return unit === 'f' ? '°F' : '°C';
  }

  /** 气压统一用 hPa；英制下同时给出 inHg，因为英美气象习惯如此。 */
  function pressureIn(hpa, unit) {
    const v = num(hpa);
    if (v == null) return null;
    return unit === 'f' ? { value: round1(v * 0.02953), unit: 'inHg', alt: Math.round(v) + ' hPa' }
      : { value: Math.round(v), unit: 'hPa', alt: round1(v * 0.02953) + ' inHg' };
  }

  /* ------------------------------------------------------------ 风向与蒲福风 */

  const DIRS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];

  /** 风向取 8 方位，屏幕上配一个指北针同时给出角度，所以文字只给方位词。 */
  function windDir(deg) {
    const v = num(deg);
    if (v == null) return '—';
    const i = Math.round(((v % 360) + 360) % 360 / 45) % 8;
    return DIRS[i];
  }

  /* 蒲福风级的下界（km/h）。用下界而不是区间，是为了让「几级风」有唯一答案。 */
  const BEAUFORT = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];

  function beaufort(kmh) {
    const v = num(kmh);
    if (v == null) return null;
    let level = 0;
    for (let i = 0; i < BEAUFORT.length; i++) if (v >= BEAUFORT[i]) level = i + 1;
    return level;
  }

  const BEAUFORT_WORDS = ['无风', '软风', '轻风', '微风', '和风', '清风', '强风', '疾风', '大风', '烈风', '狂风', '暴风', '飓风'];

  function beaufortWord(level) {
    return level == null ? '—' : BEAUFORT_WORDS[level] || '飓风';
  }

  /* -------------------------------------------------------------- 规范化输入 */

  /** 地点：合并上游正向搜索结果与反向地理编码结果，字段名统一成 name/region/country。 */
  function normalizePlace(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const lat = num(raw.latitude);
    const lon = num(raw.longitude);
    if (lat == null || lon == null) return null;

    // 反向地理编码给的是 countryName / principalSubdivision / locality；
    // 正向搜索（Photon）给的是 name / admin1 / city；
    // 本地存储里存的是已经规范化过的 name / city / region / country。
    // 三个来源的键名都不一样，所以 region 这一项要认三种写法——
    // 只认 admin1 的话，从 localStorage 读回的收藏会丢掉省份。
    const name = raw.name || raw.locality || raw.city || null;
    const city = raw.city && raw.city !== name ? raw.city : null;
    const region = raw.region || raw.admin1 || raw.principalSubdivision || raw.principalSubdivisionCode || null;
    const country = raw.country || raw.countryName || null;

    return {
      id: raw.id != null ? String(raw.id) : `${lat.toFixed(3)},${lon.toFixed(3)}`,
      name: name || '未知地点',
      // 地级市。上游正查（Photon）会给，反查接口不给；保留下来是为了左栏和标题能显示到市级
      city: raw.city || null,
      region: region || null,
      country: country || null,
      countryCode: raw.country_code || raw.countryCode || null,
      latitude: lat,
      longitude: lon,
      elevation: num(raw.elevation),
      timezone: raw.timezone || null,
      population: num(raw.population),
    };
  }

  /**
   * 上游的 hourly 是整段数组，按当前时刻切出 24 小时窗口。
   * 缺报的小时整条丢弃——注意计数要按「已经收下的条数」算，
   * 不能按循环趟数算，否则丢掉一条就会少还一条，曲线画到 23 小时就断了。
   */
  function sliceHours(hourly, nowIso, count) {
    if (!hourly || !Array.isArray(hourly.time)) return [];
    const from = nowIso ? hourly.time.indexOf(nowIso) : 0;
    const start = from >= 0 ? from : firstIndexAtOrAfter(hourly.time, nowIso);
    const temps = Array.isArray(hourly.temperature_2m) ? hourly.temperature_2m : [];
    const out = [];
    for (let i = start; i < hourly.time.length && out.length < count; i++) {
      const t = num(temps[i]);
      if (t == null) continue;
      out.push({
        time: hourly.time[i],
        temp: t,
        code: num(hourly.weather_code ? hourly.weather_code[i] : null),
        pop: num(hourly.precipitation_probability ? hourly.precipitation_probability[i] : null),
        wind: num(hourly.wind_speed_10m ? hourly.wind_speed_10m[i] : null),
      });
    }
    return out;
  }

  function firstIndexAtOrAfter(times, iso) {
    if (!iso) return 0;
    for (let i = 0; i < times.length; i++) if (times[i] >= iso) return i;
    return 0;
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  /** 从上游 current.time（"2026-09-27T10:15"）取整点，用来对齐 hourly 的第一格。 */
  function toHourIso(iso) {
    if (typeof iso !== 'string' || iso.length < 13) return null;
    return iso.slice(0, 13) + ':00';
  }

  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  /** 只解析 "YYYY-MM-DD"，不经过 Date 时区转换——那会把日期算错一天。 */
  function parseDay(iso) {
    if (typeof iso !== 'string' || iso.length < 10) return null;
    const y = Number(iso.slice(0, 4));
    const m = Number(iso.slice(5, 7));
    const d = Number(iso.slice(8, 10));
    if (!y || !m || !d) return null;
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return { y, m, d, iso: iso.slice(0, 10), weekday: WEEKDAYS[dow], isWeekend: dow === 0 || dow === 6 };
  }

  function normalizeDaily(daily) {
    if (!daily || !Array.isArray(daily.time)) return [];
    return daily.time.map(function (iso, i) {
      const day = parseDay(iso) || { iso, weekday: '', isWeekend: false };
      return {
        date: day.iso,
        weekday: day.weekday,
        isWeekend: day.isWeekend,
        monthDay: `${Number(day.iso.slice(5, 7))}/${Number(day.iso.slice(8, 10))}`,
        code: num(daily.weather_code ? daily.weather_code[i] : null),
        high: num(daily.temperature_2m_max ? daily.temperature_2m_max[i] : null),
        low: num(daily.temperature_2m_min ? daily.temperature_2m_min[i] : null),
        sunrise: timeOf(daily.sunrise ? daily.sunrise[i] : null),
        sunset: timeOf(daily.sunset ? daily.sunset[i] : null),
        pop: num(daily.precipitation_probability_max ? daily.precipitation_probability_max[i] : null),
        precip: num(daily.precipitation_sum ? daily.precipitation_sum[i] : null),
        wind: num(daily.wind_speed_10m_max ? daily.wind_speed_10m_max[i] : null),
      };
    });
  }

  /** 从 "2026-09-27T05:50" 取 "05:50"。字段缺失时给 null 而不是 undefined——
      前者在模板里渲染成空，后者会渲染成字符串 "undefined" 出现在「日出」那一格。 */
  const timeOf = (iso) => (typeof iso === 'string' && iso.length >= 16 ? iso.slice(11, 16) : null);

  /** 上游响应 → 前端唯一认得的形状。字段缺失一律置 null，渲染层负责说「缺报」。 */
  function normalizeForecast(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const now = toHourIso(raw.current && raw.current.time);
    const daily = normalizeDaily(raw.daily);
    const today = daily[0] || null;

    return {
      latitude: num(raw.latitude),
      longitude: num(raw.longitude),
      elevation: num(raw.elevation),
      timezone: raw.timezone || null,
      utcOffsetSeconds: num(raw.utc_offset_seconds),
      observedAt: (raw.current && raw.current.time) || null,
      current: {
        temp: num(raw.current && raw.current.temperature_2m),
        feels: num(raw.current && raw.current.apparent_temperature),
        code: num(raw.current && raw.current.weather_code),
        isDay: raw.current && raw.current.is_day != null ? !!raw.current.is_day : true,
        humidity: num(raw.current && raw.current.relative_humidity_2m),
        wind: num(raw.current && raw.current.wind_speed_10m),
        windDir: num(raw.current && raw.current.wind_direction_10m),
        pressure: num(raw.current && raw.current.surface_pressure),
        precip: num(raw.current && raw.current.precipitation),
      },
      daily: daily,
      today: today ? { high: today.high, low: today.low, sunrise: today.sunrise, sunset: today.sunset } : null,
      hours: sliceHours(raw.hourly, now, HOURS_AHEAD),
    };
  }

  /* ------------------------------------------------------------------ 几何 */

  /** 曲线的 X 轴：整条曲线的总跨度固定为 count-1 段，与实际点数无关。 */
  function xAt(i, count, width) {
    if (count <= 1) return 0;
    return (i / (count - 1)) * width;
  }

  /**
   * 给定数值轴范围，把温度映射到 SVG 的 y（0 在顶部）。
   * span 为 0 时（所有小时同温）退化成中线，避免除零画出 NaN。
   */
  function yAt(v, min, max, height) {
    const span = max - min;
    if (!isFinite(span) || span <= 0) return height / 2;
    return height - ((v - min) / span) * height;
  }

  /** 曲线路径用 Catmull-Rom 转三次贝塞尔——折线太生硬，纯贝塞尔又不受控。 */
  function pathFrom(points) {
    if (!points.length) return '';
    if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
    let d = `M ${round2(points[0].x)} ${round2(points[0].y)}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i - 1] || points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] || p2;
      const t = 0.2; // 张力：0.2 保留一点手绘感，卷不过头
      const c1x = p1.x + (p2.x - p0.x) * t;
      const c1y = p1.y + (p2.y - p0.y) * t;
      const c2x = p2.x - (p3.x - p1.x) * t;
      const c2y = p2.y - (p3.y - p1.y) * t;
      d += ` C ${round2(c1x)} ${round2(c1y)}, ${round2(c2x)} ${round2(c2y)}, ${round2(p2.x)} ${round2(p2.y)}`;
    }
    return d;
  }

  const round2 = (v) => Math.round(v * 100) / 100;

  /** 曲线下方闭合出渐变区域。 */
  function areaFrom(points, baseline) {
    if (!points.length) return '';
    const line = pathFrom(points);
    const last = points[points.length - 1];
    return `${line} L ${round2(last.x)} ${round2(baseline)} L ${round2(points[0].x)} ${round2(baseline)} Z`;
  }

  /**
   * 让曲线不贴边：上下各留 pad，并把数值轴对齐到 2 度一格。
   * 返回的 min/max 会同时用于 7 日条带的公共轴，两处刻度因此可以互相比较。
   */
  function niceRange(values, pad) {
    const clean = values.filter((v) => typeof v === 'number' && isFinite(v));
    if (!clean.length) return { min: 0, max: 1 };
    let lo = Math.min.apply(null, clean);
    let hi = Math.max.apply(null, clean);
    const step = 2;
    lo = Math.floor((lo - (pad || 0)) / step) * step;
    hi = Math.ceil((hi + (pad || 0)) / step) * step;
    if (hi - lo < step * 2) hi = lo + step * 2; // 至少留两格，曲线才有起伏可看
    return { min: lo, max: hi };
  }

  /** 拖拽 / 键盘游标用：给定像素位置，找最近的数据点索引。 */
  function nearestIndex(x, count, width) {
    if (count <= 1) return 0;
    const clamped = clamp(x, 0, width);
    return Math.round((clamped / width) * (count - 1));
  }

  /** 温度刻度标签：步长按轴跨度选，保证 4–7 条刻度，不挤成一团。 */
  function ticks(min, max, target) {
    const want = target || 5;
    const raw = (max - min) / Math.max(1, want - 1);
    const steps = [1, 2, 5, 10, 20, 25, 50];
    const step = steps.find((s) => s >= raw) || 50;
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(v);
    return out;
  }

  /* ---------------------------------------------------------------- 收藏地点 */

  const MAX_SAVED = 12;

  /**
   * 收藏的排重规则：同经纬度（精确到 0.05°，约 5 公里）视为同一个地方。
   * 只按名字排重不行——「杭州」在浙江和四川甘孜都有。
   */
  function samePlace(a, b) {
    if (!a || !b) return false;
    return Math.abs(a.latitude - b.latitude) < 0.05 && Math.abs(a.longitude - b.longitude) < 0.05;
  }

  /** 新收藏排最前；重复的收藏只把它提到最前，不产生第二条。 */
  function addSaved(list, place) {
    if (!place) return list.slice();
    const rest = list.filter((p) => !samePlace(p, place));
    return [place].concat(rest).slice(0, MAX_SAVED);
  }

  function removeSaved(list, place) {
    return list.filter((p) => !samePlace(p, place));
  }

  function hasSaved(list, place) {
    return list.some((p) => samePlace(p, place));
  }

  /**
   * 读写 localStorage 都要防脏数据：用户可能手改过，也可能是旧版本留下的结构。
   * 任何解析失败都退回空列表，绝不让一条坏数据把整个页面打挂。
   */
  function parseSaved(raw) {
    if (!raw) return [];
    let data;
    try {
      data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      return [];
    }
    if (!Array.isArray(data)) return [];
    return data.map(normalizePlace).filter(Boolean).slice(0, MAX_SAVED);
  }

  function serializeSaved(list) {
    return JSON.stringify(list.map((p) => ({
      id: p.id,
      name: p.name,
      city: p.city,          // 地级市：中国的县名重名多，缺了它左栏就只能显示到省
      region: p.region,
      country: p.country,
      latitude: p.latitude,
      longitude: p.longitude,
      timezone: p.timezone,
    })));
  }

  /* ----------------------------------------------------------------- 报头文本 */

  /** 观测时间在本地时区显示，直接切字符串，不经过 Date——避免把上游时区算丢。 */
  function formatObserved(iso) {
    if (typeof iso !== 'string' || iso.length < 16) return '—';
    return `${iso.slice(5, 7)}/${iso.slice(8, 10)} ${iso.slice(11, 16)}`;
  }

  function formatDayHeading(dateIso) {
    const d = parseDay(dateIso);
    if (!d) return '—';
    return `${d.m}月${d.d}日 · ${d.weekday}`;
  }

  /** 「今天 / 明天 / 后天」比星期几更容易读，所以前三天用相对说法。 */
  function relativeDay(index, weekday) {
    if (index === 0) return '今天';
    if (index === 1) return '明天';
    if (index === 2) return '后天';
    return weekday || '—';
  }

  /**
   * 地点的一句话说明。
   *
   * 中国的县名重名很多，只写「山西省」不够用——「临县」和「临县北」要靠地级市区分。
   * 所以按「地级市 · 省 · 国家」拼，并且跳过与地点名重复的部分：
   * 查「吕梁」时地区名就是「吕梁市」，再写一遍只是啰嗦。
   */
  function placeLabel(place) {
    if (!place) return '—';
    const own = baseNameOf(place.name);
    const parts = [place.city, place.region, place.country]
      .filter((v) => v && baseNameOf(v) !== own);
    // 全被跳掉时至少留一个国家/地区，别返回空
    return parts.join(' · ') || place.country || '—';
  }

  /** 去掉行政区划后缀，只用于比较：吕梁市 / 吕梁 视为同一个。 */
  const ADMIN_SUFFIX = /(特别行政区|自治区|自治州|自治县|地区|盟|市辖区|新区|省|市|县|区|镇|乡|街道|村|旗)$/;
  function baseNameOf(v) {
    return String(v || '').trim().replace(ADMIN_SUFFIX, '');
  }

  /** 坐标读数按气象稿的写法固定到小数点后 2 位，保留 N/S、E/W。 */
  function formatCoords(lat, lon) {
    if (!isFinite(lat) || !isFinite(lon)) return '—';
    const ns = lat >= 0 ? 'N' : 'S';
    const ew = lon >= 0 ? 'E' : 'W';
    return `${Math.abs(lat).toFixed(2)}°${ns} ${Math.abs(lon).toFixed(2)}°${ew}`;
  }

  /** 「距今几小时」用于曲线上方的刻度带：+0h、+3h、+6h…… */
  function hourOffsetLabel(i) {
    return i === 0 ? '此刻' : `+${i}h`;
  }

  function hourOf(iso) {
    return typeof iso === 'string' && iso.length >= 13 ? Number(iso.slice(11, 13)) : null;
  }

  /** 白天 / 夜间 / 日出日落前后，决定曲线是高亮还是压暗。 */
  function isNightHour(iso, sunrise, sunset) {
    const h = hourOf(iso);
    if (h == null || !sunrise || !sunset) return false;
    const sr = Number(sunrise.slice(0, 2));
    const ss = Number(sunset.slice(0, 2));
    return h < sr || h >= ss;
  }

  /* --------------------------------------------------------------- 描述性文案 */

  /**
   * 一条观测结论。写法模仿值班记录：先说事实，再说结论，不寒暄、不感叹。
   * 只在真的有依据时才说——没有需要提醒的事就返回空字符串。
   */
  function observation(norm, unit) {
    if (!norm || !norm.current) return '';
    const c = norm.current;
    const parts = [];

    if (c.temp != null && norm.today && norm.today.high != null && norm.today.low != null) {
      const t = c.temp;
      if (t >= norm.today.high - 0.5) parts.push('气温已到今日最高');
      else if (t <= norm.today.low + 0.5) parts.push('气温已到今日最低');
      else if (t > norm.today.high - 2) parts.push('接近今日高温');
      else if (t < norm.today.low + 2) parts.push('接近今日低温');
    }

    if (c.feels != null && c.temp != null) {
      const d = c.feels - c.temp;
      if (d >= 3) parts.push(`体感偏热 ${Math.round(d)} 度`);
      else if (d <= -3) parts.push(`体感偏冷 ${Math.abs(Math.round(d))} 度`);
    }

    if (c.humidity != null && c.humidity >= 85) parts.push('空气接近饱和');
    else if (c.humidity != null && c.humidity <= 25) parts.push('空气干燥');

    const level = beaufort(c.wind);
    if (level != null && level >= 5) parts.push(`${beaufortWord(level)}，注意风力`);

    const rain = norm.hours.find((h) => h.pop != null && h.pop >= 60);
    if (rain) parts.push(`${hourOf(rain.time)} 点前后有降水可能`);

    return parts.slice(0, 3).join('；');
  }

  /**
   * 旁注那一行永远有内容。
   *
   * observation() 只在"有值得提醒的事"时才说话，但版面里那一行是固定存在的：
   * 留空会在读数下方出现一块空档，看起来像没加载出来。
   * 所以没有特别情况时，就报一条平稳的常规观测——日较差和风级是有信息量的，
   * 而且不制造"需要注意"的假警报。
   */
  function observationLine(norm, unit) {
    const notable = observation(norm, unit);
    if (notable) return notable;
    if (!norm || !norm.current) return '';

    const c = norm.current;
    const parts = [];
    if (norm.today && norm.today.high != null && norm.today.low != null) {
      parts.push(`今日日较差 ${Math.round(norm.today.high - norm.today.low)} 度`);
    }
    if (c.wind != null) {
      const level = beaufort(c.wind);
      parts.push(level == null ? '风力平稳' : `${level} 级${beaufortWord(level)}`);
    }
    const pops = norm.hours.map((h) => h.pop).filter((v) => v != null);
    if (pops.length) parts.push(`未来 24 小时降水概率最高 ${Math.round(Math.max.apply(null, pops))}%`);

    return parts.length ? `常规观测：${parts.join('；')}` : '';
  }

  return {
    UPSTREAM,
    FORECAST_FIELDS,
    HOURS_PAST,
    HOURS_AHEAD,
    FORECAST_DAYS,
    MAX_SAVED,
    CODES,
    describeCode,
    sky,
    convertTemp,
    windIn,
    windLabel,
    tempLabel,
    pressureIn,
    windDir,
    beaufort,
    beaufortWord,
    normalizePlace,
    normalizeForecast,
    normalizeDaily,
    sliceHours,
    toHourIso,
    parseDay,
    timeOf,
    formatObserved,
    formatDayHeading,
    relativeDay,
    placeLabel,
    baseNameOf,
    formatCoords,
    hourOffsetLabel,
    hourOf,
    isNightHour,
    observation,
    observationLine,
    xAt,
    yAt,
    pathFrom,
    areaFrom,
    niceRange,
    ticks,
    nearestIndex,
    samePlace,
    addSaved,
    removeSaved,
    hasSaved,
    parseSaved,
    serializeSaved,
    round1,
    clamp,
  };
});
