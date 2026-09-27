/* 空气质量指数（中国标准）
 *
 * 为什么不用上游直接给的 us_aqi：
 * Open-Meteo 的空气质量接口确实会返回一个 AQI，但那是美国 EPA 的口径。
 * 它和中国的《环境空气质量指数（AQI）技术规定》HJ 633—2012 不是一回事——
 * 同样的空气，美标可能报 124「对敏感人群不健康」，而国标可能报 95「良」。
 * 给中国用户看天气应用，「良」和「轻度污染」这种分级必须按国内口径，
 * 否则用户按美国分级采取措施就是被误导了。所以这里从原始浓度自己算。
 *
 * 计算过程（HJ 633—2012）：
 *   1. 每种污染物按 24 小时平均浓度（臭氧用 8 小时滑动平均、一氧化碳用 24 小时平均）
 *      查分段线性表，得到该污染物的 IAQI；
 *   2. 取所有 IAQI 的最大值作为 AQI；
 *   3. IAQI 最大的那种污染物就是「首要污染物」（AQI ≤ 50 时不报首要污染物）。
 *
 * 浓度单位统一用 μg/m³，一氧化碳是 mg/m³（国标就是按 mg/m³ 定的表）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CloudAqi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* IAQI 的分级断点，六级对应「优 / 良 / 轻度 / 中度 / 重度 / 严重」。
     注意 IAQI 的断点对每种污染物都一样，变的是浓度断点。 */
  const IAQI_BREAKS = [0, 50, 100, 150, 200, 300, 400, 500];

  /* 各污染物的浓度断点（HJ 633—2012 表 1） */
  const LIMITS = {
    // 二氧化硫 SO2，24 小时平均，μg/m³
    so2_24h: [0, 50, 150, 475, 800, 1600, 2100, 2620],
    // 二氧化氮 NO2，24 小时平均，μg/m³
    no2_24h: [0, 40, 80, 180, 280, 565, 750, 940],
    // 可吸入颗粒物 PM10，24 小时平均，μg/m³
    pm10_24h: [0, 50, 150, 250, 350, 420, 500, 600],
    // 细颗粒物 PM2.5，24 小时平均，μg/m³
    pm25_24h: [0, 35, 75, 115, 150, 250, 350, 500],
    // 一氧化碳 CO，24 小时平均，mg/m³
    co_24h: [0, 2, 4, 14, 24, 36, 48, 60],
    // 臭氧 O3，8 小时滑动平均，μg/m³
    o3_8h: [0, 100, 160, 215, 265, 800, 1000, 1200],
    // 臭氧 O3，1 小时平均，μg/m³（8 小时值缺报时的替代口径）
    o3_1h: [0, 160, 200, 300, 400, 800, 1000, 1200],
  };

  /* 六级分类：名称、色值、健康提示。
     配色沿用国标与国内常见发布口径（绿黄橙红紫褐），所以用户一眼能对上新闻里的说法。 */
  const LEVELS = [
    { max: 50, name: '优', key: 'excellent', color: '#00b050', advice: '空气很好，适合户外活动。' },
    { max: 100, name: '良', key: 'good', color: '#d4c400', advice: '可以正常户外活动。' },
    { max: 150, name: '轻度污染', key: 'light', color: '#ff8a00', advice: '儿童、老人和心脏病、肺病患者应减少长时间户外活动。' },
    { max: 200, name: '中度污染', key: 'moderate', color: '#e02020', advice: '敏感人群应避免户外活动，一般人群适量减少。' },
    { max: 300, name: '重度污染', key: 'heavy', color: '#99004c', advice: '建议留在室内，关闭门窗，外出戴口罩。' },
    { max: Infinity, name: '严重污染', key: 'severe', color: '#7e0023', advice: '尽量留在室内，避免户外活动。' },
  ];

  /* 首要污染物的中文名与界面上用的短名 */
  const POLLUTANTS = {
    pm25_24h: { name: 'PM2.5', unit: 'μg/m³' },
    pm10_24h: { name: 'PM10', unit: 'μg/m³' },
    so2_24h: { name: 'SO₂', unit: 'μg/m³' },
    no2_24h: { name: 'NO₂', unit: 'μg/m³' },
    co_24h: { name: 'CO', unit: 'mg/m³' },
    o3_8h: { name: 'O₃', unit: 'μg/m³' },
    o3_1h: { name: 'O₃(1h)', unit: 'μg/m³' },
  };

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  /**
   * 分段线性插值：给定浓度，查出 IAQI。
   * 超出最高断点时按国标仍然报 500（不再外推），因为这已经是最高级别。
   */
  function iaqi(value, breaks) {
    if (!isNum(value) || value < 0) return null;
    for (let i = 1; i < breaks.length; i++) {
      if (value <= breaks[i]) {
        const cLo = breaks[i - 1];
        const cHi = breaks[i];
        const iLo = IAQI_BREAKS[i - 1];
        const iHi = IAQI_BREAKS[i];
        if (cHi === cLo) return iHi;
        return Math.round(iLo + ((iHi - iLo) / (cHi - cLo)) * (value - cLo));
      }
    }
    return 500;
  }

  /** 一段小时序列的滑动平均：window 小时为一个窗口，返回每个位置上的均值（不足窗口时为 null）。 */
  function rollingMean(values, window) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (isNum(v)) {
        sum += v;
        count += 1;
      }
      if (i >= window) {
        const drop = values[i - window];
        if (isNum(drop)) {
          sum -= drop;
          count -= 1;
        }
      }
      if (i >= window - 1 && count > 0) out[i] = sum / count;
    }
    return out;
  }

  /**
   * 从「当前的原始浓度」算 AQI。
   *
   * 现实限制要说清楚：国标的口径是 24 小时平均，而这个应用只拿到当前一小时的浓度，
   * 也没有历史小时数据去凑够 24 小时。所以这里用的是「实时浓度按 24 小时表查算」，
   * 也就是常见的"实时 AQI"口径——它和官方日报会有出入，
   * 尤其当浓度正处于快速升降过程时。界面上的措辞因此写「实时」而不是「今日」。
   *
   * @param {{pm2_5?:number, pm10?:number, nitrogen_dioxide?:number, sulphur_dioxide?:number, ozone?:number, carbon_monoxide?:number}} c
   *        carbon_monoxide 单位是 μg/m³（上游给的就是），这里换算成 mg/m³ 再查表
   */
  function fromCurrent(c) {
    if (!c || typeof c !== 'object') return null;

    const raw = {
      pm25_24h: isNum(c.pm2_5) ? c.pm2_5 : null,
      pm10_24h: isNum(c.pm10) ? c.pm10 : null,
      no2_24h: isNum(c.nitrogen_dioxide) ? c.nitrogen_dioxide : null,
      so2_24h: isNum(c.sulphur_dioxide) ? c.sulphur_dioxide : null,
      // 上游的 CO 单位是 μg/m³，国标表是 mg/m³
      co_24h: isNum(c.carbon_monoxide) ? c.carbon_monoxide / 1000 : null,
      o3_8h: isNum(c.ozone) ? c.ozone : null,
    };

    const detail = [];
    let aqi = null;
    let primary = null;

    for (const key of Object.keys(LIMITS)) {
      const value = raw[key];
      if (value == null) continue;
      const score = iaqi(value, LIMITS[key]);
      if (score == null) continue;
      detail.push({
        key,
        name: POLLUTANTS[key].name,
        unit: POLLUTANTS[key].unit,
        value: Math.round(value * 10) / 10,
        iaqi: score,
      });
      if (aqi == null || score > aqi) {
        aqi = score;
        primary = key;
      }
      // 臭氧同时有 8 小时和 1 小时两张表，8 小时表在正常浓度下更严格，
      // 这里只用 8 小时口径，避免同一个污染物把明细撑成两条
      if (key === 'o3_8h') break;
    }

    if (aqi == null) return null;

    const level = levelOf(aqi);
    // AQI ≤ 50 时国标不报首要污染物（空气够好，报出来只会让人误解）
    const primaryInfo = aqi > 50 && primary ? POLLUTANTS[primary] : null;

    detail.sort((a, b) => b.iaqi - a.iaqi);
    return {
      aqi,
      level,
      primary: primaryInfo ? primaryInfo.name : null,
      primaryKey: aqi > 50 ? primary : null,
      detail,
    };
  }

  function levelOf(aqi) {
    if (!isNum(aqi)) return null;
    for (const lv of LEVELS) if (aqi <= lv.max) return { name: lv.name, key: lv.key, color: lv.color, advice: lv.advice };
    return null;
  }

  /**
   * 空气质量的趋势：把逐小时 PM2.5 用 24 小时滑动平均转成 IAQI 序列。
   * 这才是接近国标日报口径的做法，所以历史/趋势图用这个而不是实时值。
   * 数据不足 24 小时时退化为"用实时浓度"，并标出 reliable:false，
   * 让界面能说明"这段趋势是估算的"。
   */
  function trendFromHourly(hourly) {
    if (!hourly || !Array.isArray(hourly.time)) return [];
    const pm25 = rollingMean(hourly.pm2_5 || [], 24);
    const pm10 = rollingMean(hourly.pm10 || [], 24);
    const out = [];
    for (let i = 0; i < hourly.time.length; i++) {
      const v25 = pm25[i] != null ? pm25[i] : (hourly.pm2_5 ? hourly.pm2_5[i] : null);
      const v10 = pm10[i] != null ? pm10[i] : (hourly.pm10 ? hourly.pm10[i] : null);
      const score = i25(v25, v10);
      if (score == null) continue;
      out.push({ time: hourly.time[i], aqi: score, reliable: pm25[i] != null });
    }
    return out;
  }

  /** 只有颗粒物时的简化 IAQI（趋势图用，避免每次都跑整套六项） */
  function i25(pm25, pm10) {
    const a = iaqi(pm25, LIMITS.pm25_24h);
    const b = iaqi(pm10, LIMITS.pm10_24h);
    if (a == null && b == null) return null;
    return Math.max(a == null ? 0 : a, b == null ? 0 : b);
  }

  /** 一个数值在六级色带上的位置（0–1），用于把数字画成一条刻度。 */
  function positionOnScale(aqi) {
    if (!isNum(aqi)) return null;
    return Math.min(1, Math.max(0, aqi / 500));
  }

  const SCALE_STOPS = [
    { at: 0, label: '0' },
    { at: 50 / 500, label: '50' },
    { at: 100 / 500, label: '100' },
    { at: 150 / 500, label: '150' },
    { at: 200 / 500, label: '200' },
    { at: 300 / 500, label: '300' },
    { at: 1, label: '500' },
  ];

  return {
    LIMITS,
    LEVELS,
    POLLUTANTS,
    IAQI_BREAKS,
    SCALE_STOPS,
    iaqi,
    levelOf,
    fromCurrent,
    rollingMean,
    trendFromHourly,
    positionOnScale,
  };
});
