/* 历史天气的统计与趋势
 *
 * 为什么统计放在服务端：
 * 查五年历史原始数据是 1800 多天的日值，几十万个数字，全丢给浏览器再算，
 * 传输和解析都不划算，而且每次切换时间范围都要重来一遍。
 * 服务端算好"摘要 + 已对齐到合适粒度的序列"（月/日），前端只负责画。
 * 顺带一个好处：这些统计是纯函数，可以直接写测试。
 *
 * 所有统计都遵守一条：缺报的日子不参与计算，而不是当 0 处理。
 * 把缺报当 0 会让"平均降水量"整体偏低，而且低得看不出来。
 */
'use strict';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const pick = (list, key) => list.map((d) => num(d[key])).filter((v) => v != null);

const sum = (a) => (a.length ? a.reduce((x, y) => x + y, 0) : null);
const mean = (a) => (a.length ? sum(a) / a.length : null);
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

/** 天数差：两端都是 "YYYY-MM-DD"，用 UTC 解析避免时区把天数算错 */
function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

function monthOf(iso) {
  return iso.slice(0, 7);
}

/**
 * 把日值序列按粒度聚合。
 *   day   → 原样返回（最多 92 天的短期查询）
 *   month → 按月求均值/合计（长区间才画得下，也才看得出年际变化）
 */
function aggregate(daily, grain) {
  if (grain !== 'month') {
    return daily.map((d) => ({
      label: d.date,
      date: d.date,
      high: num(d.high),
      low: num(d.low),
      mean: num(d.mean != null ? d.mean : (num(d.high) != null && num(d.low) != null ? (d.high + d.low) / 2 : null)),
      precip: num(d.precip),
      code: num(d.code),
      sunshine: num(d.sunshine),
      days: 1,
    }));
  }

  const groups = new Map();
  for (const d of daily) {
    const key = monthOf(d.date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }

  const out = [];
  for (const [key, days] of groups) {
    const highs = pick(days, 'high');
    const lows = pick(days, 'low');
    const means = pick(days, 'mean');
    const precips = pick(days, 'precip');
    const suns = pick(days, 'sunshine');
    out.push({
      // 月标签用「2026-09」，图上再格式化成「26年9月」
      label: key,
      date: key,
      high: round1(mean(highs)),
      low: round1(mean(lows)),
      mean: round1(means.length ? mean(means) : (mean(highs) != null && mean(lows) != null ? (mean(highs) + mean(lows)) / 2 : null)),
      precip: round1(sum(precips)),
      // 月度天气码取出现最多的那个，代表这个月"主要是什麼天气"
      code: dominantCode(days),
      sunshine: suns.length ? Math.round(sum(suns) / 3600) : null,   // 秒 → 小时
      days: days.length,
    });
  }
  return out.sort((a, b) => (a.label < b.label ? -1 : 1));
}

/** 出现次数最多的天气码（按"性质"归类，不按具体数字：
    小雨/中雨/大雨都算雨天，否则一个月的码会很分散，取众数没有意义）。 */
function dominantCode(days) {
  const bucket = (code) => {
    if (code == null) return null;
    if (code === 0 || code === 1) return 'clear';
    if (code === 2 || code === 3) return 'cloud';
    if (code === 45 || code === 48) return 'fog';
    if (code >= 95) return 'storm';
    if (code >= 71 && code <= 86) return 'snow';
    if (code >= 51) return 'rain';
    return 'cloud';
  };
  const counts = new Map();
  for (const d of days) {
    const b = bucket(num(d.code));
    if (!b) continue;
    counts.set(b, (counts.get(b) || 0) + 1);
  }
  if (!counts.size) return null;
  const top = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0];
  // 代表性代码：每种性质给一个中间的码，画图标用
  const REP = { clear: 0, cloud: 2, fog: 45, storm: 95, snow: 71, rain: 61 };
  return REP[top] != null ? REP[top] : null;
}

/** 线性回归的斜率：给出"每 10 年变化多少"，这是谈趋势唯一有意义的单位。 */
function trendPerDecade(values) {
  const pts = [];
  values.forEach((v, i) => { if (v != null) pts.push([i, v]); });
  if (pts.length < 10) return null;

  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p[0], 0) / n;
  const my = pts.reduce((a, p) => a + p[1], 0) / n;
  let numr = 0;
  let den = 0;
  for (const [x, y] of pts) {
    numr += (x - mx) * (y - my);
    den += (x - mx) * (x - mx);
  }
  if (den === 0) return null;
  const perDay = numr / den;
  return perDay * 3650;   // 每天变化量 × 10 年
}

/**
 * 生成摘要。
 *
 * 除了均值极值这些"是什么"的数字，还给出三个"和往年比"的数字：
 * 距平（比常年偏暖/偏冷多少）、趋势（每十年变化多少）、以及雨日天数占比。
 * 单纯列平均值用户看不出这一年到底算不算热，必须有个参照。
 */
function summarize(daily, grain) {
  if (!daily || !daily.length) return null;

  const highs = pick(daily, 'high');
  const lows = pick(daily, 'low');
  const means = pick(daily, 'mean');
  const precips = pick(daily, 'precip');
  const winds = pick(daily, 'wind');
  const hums = pick(daily, 'humidity');
  const suns = pick(daily, 'sunshine');
  const uv = pick(daily, 'uvMax');

  const meanTemp = means.length ? mean(means) : (mean(highs) != null && mean(lows) != null ? (mean(highs) + mean(lows)) / 2 : null);

  // 极值要连日期一起给出，只说"最高 39.2°C"用户不知道是哪天
  const hottest = extremeDay(daily, 'high', 'max');
  const coldest = extremeDay(daily, 'low', 'min');
  const wettest = extremeDay(daily, 'precip', 'max');

  const rainDays = precips.filter((v) => v >= 0.1).length;
  const heavyDays = precips.filter((v) => v >= 10).length;

  /* 距平：把这段区间和它的"同期"比。
     月度数据没有可比的同期（一年就一个 9 月），所以只在日粒度下做——
     即用区间的日序列和随后同样长度的日序列比，作为"变化方向"的参考。
     这不是严格的气候态距平（那需要一个 30 年基准期），界面上要说清是"与前一段相比"。 */
  let anomaly = null;
  if (grain === 'day' && daily.length >= 10) {
    const half = Math.floor(daily.length / 2);
    const temp = (slice) => {
      const means2 = pick(slice, 'mean');
      return means2.length ? mean(means2) : mean(pick(slice, 'high'));
    };
    const first = temp(daily.slice(0, half));
    const second = temp(daily.slice(half));
    if (first != null && second != null) anomaly = round1(second - first);
  }

  return {
    days: daily.length,
    grain,
    startDate: daily[0].date,
    endDate: daily[daily.length - 1].date,
    meanTemp: round1(meanTemp),
    meanHigh: round1(mean(highs)),
    meanLow: round1(mean(lows)),
    maxTemp: round1(hottest ? hottest.value : null),
    maxTempDate: hottest ? hottest.date : null,
    minTemp: round1(coldest ? coldest.value : null),
    minTempDate: coldest ? coldest.date : null,
    totalPrecip: round1(sum(precips)),
    wettestDay: wettest ? round1(wettest.value) : null,
    wettestDate: wettest ? wettest.date : null,
    rainDays,
    heavyDays,
    rainRatio: daily.length ? round2(rainDays / daily.length) : null,
    meanWind: round1(mean(winds)),
    meanHumidity: round1(mean(hums)),
    totalSunshine: suns.length ? Math.round(sum(suns) / 3600) : null,
    meanUv: round1(mean(uv)),
    // 趋势用日序列算，粒度是月的时候点太少，算出来不可信
    trendPerDecade: grain === 'day' ? round1(trendPerDecade(daily.map((d) => num(d.mean != null ? d.mean : d.high)))) : null,
    halfAnomaly: anomaly,
  };
}

function extremeDay(daily, key, mode) {
  let best = null;
  for (const d of daily) {
    const v = num(d[key]);
    if (v == null) continue;
    if (!best || (mode === 'max' ? v > best.value : v < best.value)) best = { value: v, date: d.date };
  }
  return best;
}

/** 按天气性质统计天数占比，给出"这一年有多少天是晴/雨/阴"。 */
function composition(daily) {
  const buckets = { clear: 0, cloud: 0, rain: 0, snow: 0, fog: 0, storm: 0 };
  let total = 0;
  for (const d of daily) {
    const code = num(d.code);
    if (code == null) continue;
    total += 1;
    if (code === 0 || code === 1) buckets.clear += 1;
    else if (code === 2 || code === 3) buckets.cloud += 1;
    else if (code === 45 || code === 48) buckets.fog += 1;
    else if (code >= 95) buckets.storm += 1;
    else if (code >= 71 && code <= 86) buckets.snow += 1;
    else if (code >= 51) buckets.rain += 1;
    else buckets.cloud += 1;
  }
  const LABEL = { clear: '晴', cloud: '多云到阴', rain: '雨', snow: '雪', fog: '雾', storm: '雷暴' };
  const items = Object.keys(buckets)
    .filter((k) => buckets[k] > 0)
    .map((k) => ({ key: k, name: LABEL[k], days: buckets[k], ratio: total ? buckets[k] / total : 0 }))
    .sort((a, b) => b.days - a.days);
  return { total, items };
}

/**
 * 逐年对比：把每年的同月同日放在同一列。
 *
 * 这里刻意不用"年内第几天"来对齐。闰年（2024）在 3 月 1 日之前的年内序号
 * 比平年（2025）多 1，用序号对齐会让两年的季节错开一天——
 * 年初看着还齐，到 12 月就差了整整一格，叠在一起比较时会出现假的"变化"。
 * 用「月 + 日」当键就没有这个问题：3 月 1 日在哪一年都落在同一列。
 *
 * 索引 = (月 - 1) × 31 + (日 - 1)，最大 372。查表时按"月+日"找，不用管闰年。
 */
function yearOverYear(daily) {
  const years = new Map();
  for (const d of daily) {
    const y = d.date.slice(0, 4);
    if (!years.has(y)) years.set(y, { year: y, points: new Array(372).fill(null) });
    const idx = monthDayIndex(d.date);
    const v = num(d.mean != null ? d.mean : d.high);
    if (idx >= 0 && idx < 372) years.get(y).points[idx] = v;
  }
  return Array.from(years.values()).sort((a, b) => (a.year < b.year ? -1 : 1));
}

/** 「月-日」在年内数组里的下标：(月-1)×31 + (日-1)。不用 Date，避免时区把日期算错一天。 */
function monthDayIndex(iso) {
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  if (!m || !d) return -1;
  return (m - 1) * 31 + (d - 1);
}

/** 反向：给出下标对应的「月/日」，画图轴标签用 */
function indexToMonthDay(index) {
  const m = Math.floor(index / 31) + 1;
  const d = (index % 31) + 1;
  return `${m}/${d}`;
}

/**
 * 上游的 daily 是"列存"的（每个变量一个数组），这里转成"行存"（每一天一个对象）。
 * 两种输入都要认：
 *   - 上游原始形状：{ daily: { time: [...], temperature_2m_max: [...] } }
 *   - 已经规范化过的形状：{ daily: [{ date, high, low, ... }] }
 * 后者用于测试和"把规范化结果再喂进来"的场景。
 */
function toRows(raw) {
  const d = raw && raw.daily;
  if (!d) return [];
  if (Array.isArray(d)) return d.filter((x) => x && x.date);

  if (!Array.isArray(d.time)) return [];
  const g = (key, i) => (Array.isArray(d[key]) ? d[key][i] : undefined);
  return d.time.map((date, i) => ({
    date,
    high: num(g('temperature_2m_max', i)),
    low: num(g('temperature_2m_min', i)),
    mean: num(g('temperature_2m_mean', i)),
    code: num(g('weather_code', i)),
    precip: num(g('precipitation_sum', i)),
    rain: num(g('rain_sum', i)),
    snow: num(g('snowfall_sum', i)),
    hours: num(g('precipitation_hours', i)),
    wind: num(g('wind_speed_10m_max', i)),
    gust: num(g('wind_gusts_10m_max', i)),
    humidity: num(g('relative_humidity_2m_mean', i)),
    sunshine: num(g('sunshine_duration', i)),
    radiation: num(g('shortwave_radiation_sum', i)),
    uvMax: num(g('uv_index_max', i)),
  })).filter((row) => row.date);
}

/**
 * 主入口：把上游的原始日值整理成前端要的东西。
 * @param {object} raw 上游 archive 响应（或已规范化的 { daily: [...] }）
 * @param {'day'|'month'} grain
 */
function build(raw, grain) {
  const daily = toRows(raw);
  if (!daily.length) return null;

  return {
    grain,
    series: aggregate(daily, grain),
    summary: summarize(daily, grain),
    composition: composition(daily),
    years: daily.length > 400 ? yearOverYear(daily) : [],
    startDate: daily[0].date,
    endDate: daily[daily.length - 1].date,
  };
}

module.exports = {
  build, toRows, aggregate, summarize, composition, yearOverYear,
  trendPerDecade, daysBetween, dominantCode, monthDayIndex, indexToMonthDay,
};
