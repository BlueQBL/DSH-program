/* 天气预警推导
 *
 * 先说清楚这是什么、不是什么：
 *
 *   这不是中国气象局发布的官方预警，本应用也拿不到官方预警的免费接口
 *   （官方渠道需要注册 Key，第三方聚合服务同样要 Key）。
 *   这里是按国内气象预警的**公开分级标准**，对 Open-Meteo 的预报数据做阈值判断，
 *   得出「按标准衡量，这里的天气达到了某级预警的量级」。
 *
 * 所以界面上必须写明「本地推算 · 非官方发布」，并给出推导依据。
 * 把它说成"预警发布"是不诚实的：真正的预警还包含发布机构对趋势、范围和影响的综合判断，
 * 阈值判断做不到这些，它也判断不了台风路径、地质灾害这类本地数据之外的成因。
 *
 * 阈值来源是各类气象灾害预警信号的分级标准（台风、暴雨、暴雪、寒潮、大风、
 * 高温、大雾、霾、道路结冰、雷电、紫外线等）。这里选的是可以只靠"未来若干小时的
 * 常规气象要素"判断的那几类，判不了的（台风、地质灾害）直接不做，
 * 而不是硬凑一个看起来热闹的假预警。
 */
(function (root, factory) {
  const C = (typeof module === 'object' && module.exports)
    ? require('./core.js')
    : (root && root.CloudCore) || null;
  const api = factory(C);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CloudAlerts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';

  /* 级别从轻到重。国标用蓝/黄/橙/红四色，这里照搬，
     顺序也照搬——排序时用 rank，显示时用 label/color。 */
  const LEVELS = {
    blue: { rank: 1, label: '蓝色', color: '#3d7fd6', word: '注意' },
    yellow: { rank: 2, label: '黄色', color: '#d8b23a', word: '警惕' },
    orange: { rank: 3, label: '橙色', color: '#e07b2c', word: '严重' },
    red: { rank: 4, label: '红色', color: '#cf4a3f', word: '特别严重' },
  };

  const KINDS = {
    heat: { name: '高温', icon: 'heat', basis: '日最高气温' },
    cold: { name: '寒潮', icon: 'cold', basis: '过程降温幅度与最低气温' },
    wind: { name: '大风', icon: 'wind', basis: '阵风风力（蒲福风级）' },
    rain: { name: '暴雨', icon: 'rain', basis: '累计降水量' },
    snow: { name: '暴雪', icon: 'snow', basis: '累计降雪量' },
    storm: { name: '雷电', icon: 'storm', basis: '对流有效位能与天气码' },
    fog: { name: '大雾', icon: 'fog', basis: '能见度' },
    haze: { name: '霾', icon: 'haze', basis: '空气质量指数' },
    uv: { name: '紫外线', icon: 'uv', basis: '紫外线指数' },
  };

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  /** km/h → 蒲福风级。大风预警是按"几级风"发布的，所以必须换算成风级再比。 */
  function beaufort(kmh) {
    const v = num(kmh);
    if (v == null) return null;
    const breaks = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
    let level = 0;
    for (let i = 0; i < breaks.length; i++) if (v >= breaks[i]) level = i + 1;
    return level;
  }

  /** 取未来 N 小时（含当前）的一段，用来判断"未来 24 小时里会不会达到某种量级" */
  function window(hours, key, limit) {
    if (!Array.isArray(hours)) return [];
    const out = [];
    for (let i = 0; i < Math.min(hours.length, limit || 24); i++) {
      const v = hours[i] && num(hours[i][key]);
      if (v != null) out.push(v);
    }
    return out;
  }

  const maxOf = (arr) => (arr.length ? Math.max.apply(null, arr) : null);
  const minOf = (arr) => (arr.length ? Math.min.apply(null, arr) : null);
  const sumOf = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) : null);

  const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

  function make(kind, level, headline, detail, evidence) {
    return {
      kind,
      kindName: KINDS[kind].name,
      level,
      levelLabel: LEVELS[level].label,
      rank: LEVELS[level].rank,
      color: LEVELS[level].color,
      headline,
      detail,
      basis: KINDS[kind].basis,
      evidence: evidence || null,
    };
  }

  /**
   * 从一份已经规范化过的预报推导预警。
   *
   * @param {object} fc  normalizeForecast 的结果（额外带 rawDaily / rawHours 更好）
   * @param {object} [aq] 空气质量结果（js/aqi.js 的 fromCurrent 输出），可选
   * @returns {Array} 按严重程度从高到低排序的预警列表；没有达到量级时返回空数组
   */
  function derive(fc, aq) {
    const out = [];
    if (!fc || !fc.daily || !fc.daily.length) return out;

    const today = fc.daily[0] || {};
    const tomorrow = fc.daily[1] || {};
    const d3 = fc.daily[2] || {};

    /* ---- 高温 ---- */
    const highs = fc.daily.map((d) => num(d.high)).filter((v) => v != null);
    const peakHigh = maxOf(highs);
    const daysOver37 = highs.filter((v) => v >= 37).length;
    const daysOver35 = highs.filter((v) => v >= 35).length;
    if (peakHigh != null) {
      if (peakHigh >= 40) {
        out.push(make('heat', 'red', `最高气温将达 ${Math.round(peakHigh)}°C`,
          `未来 7 天里有 ${daysOver37} 天气温达到 37°C 以上，最高 ${Math.round(peakHigh)}°C。`,
          `日最高气温 ${Math.round(peakHigh)}°C ≥ 40°C`));
      } else if (peakHigh >= 37) {
        out.push(make('heat', 'orange', `最高气温将达 ${Math.round(peakHigh)}°C`,
          '高温时段尽量减少户外活动，注意补水和防暑。',
          `日最高气温 ${Math.round(peakHigh)}°C ≥ 37°C`));
      } else if (peakHigh >= 35) {
        out.push(make('heat', 'yellow', `连续高温，最高 ${Math.round(peakHigh)}°C`,
          daysOver35 >= 3 ? `未来 7 天有 ${daysOver35} 天达到 35°C 以上。` : '午后减少暴晒，多补水。',
          `日最高气温 ${Math.round(peakHigh)}°C ≥ 35°C`));
      }
    }

    /* ---- 寒潮 / 低温 ----
       国标的寒潮看"48 小时降温 ≥ 8°C 且最低气温 ≤ 4°C"这类组合。
       这里用日最高气温的落差近似过程降温，并同时要求确实冷，
       避免在夏天因为一次普通降温就报寒潮。 */
    if (today.high != null && d3.high != null) {
      const drop = today.high - d3.high;
      const coldest = minOf(fc.daily.slice(0, 4).map((d) => num(d.low)).filter((v) => v != null));
      if (drop >= 8 && coldest != null && coldest <= 4) {
        const level = drop >= 14 || coldest <= -6 ? 'orange' : 'blue';
        out.push(make('cold', level, `${Math.round(drop)}°C 降温，最低 ${Math.round(coldest)}°C`,
          '气温下降明显，注意添衣防寒，关注对农作物和管道的影响。',
          `3 日内最高气温下降 ${Math.round(drop)}°C，最低气温 ${Math.round(coldest)}°C`));
      }
    }

    /* ---- 大风 ----
       国标大风预警按风力等级：8 级起步，10 级以上是橙色/红色。
       当前风速报的是 10 米平均风，预警看的是阵风，所以优先用阵风数据。 */
    const gusts = fc.daily.map((d) => num(d.gust)).filter((v) => v != null);
    const peakGust = maxOf(gusts) != null ? maxOf(gusts) : num(fc.current && fc.current.wind);
    const gustLevel = beaufort(peakGust);
    if (gustLevel != null && gustLevel >= 8) {
      const level = gustLevel >= 11 ? 'red' : gustLevel >= 10 ? 'orange' : gustLevel >= 9 ? 'yellow' : 'blue';
      out.push(make('wind', level, `阵风可达 ${gustLevel} 级`,
        '远离广告牌、临时搭建物和高空作业区，海上作业注意安全。',
        `最大阵风 ${Math.round(peakGust)} km/h，约 ${gustLevel} 级`));
    }

    /* ---- 暴雨 ----
       按日累计降水量分级（24 小时口径）。 */
    const precip = fc.daily.map((d) => num(d.precip)).filter((v) => v != null);
    const peakRain = maxOf(precip);
    if (peakRain != null && peakRain >= 25) {
      const level = peakRain >= 100 ? 'red' : peakRain >= 50 ? 'orange' : 'yellow';
      out.push(make('rain', level, `单日降水量可达 ${round1(peakRain)} mm`,
        '注意低洼路段积水和山洪风险，减少前往山区河谷。',
        `7 日内最大日降水量 ${round1(peakRain)} mm`));
    }

    /* ---- 暴雪 ---- */
    const snowSum = fc.daily.map((d) => num(d.snow)).filter((v) => v != null);
    const peakSnow = maxOf(snowSum);
    if (peakSnow != null && peakSnow >= 5) {
      // 上游的降雪量单位是 cm，10 cm 以上按暴雪量级处理
      const level = peakSnow >= 20 ? 'orange' : peakSnow >= 10 ? 'yellow' : 'blue';
      out.push(make('snow', level, `单日降雪可达 ${round1(peakSnow)} cm`,
        '路面易结冰打滑，注意行车安全与航班动态。',
        `7 日内最大日降雪量 ${round1(peakSnow)} cm`));
    }

    /* ---- 雷电 ----
       用两个依据：对流有效位能（CAPE）反映大气的对流潜势，
       以及 WMO 天气码里明确的雷暴码。CAPE 高但天气码没报雷暴时只给蓝色。 */
    const capes = window(fc.rawHours, 'cape', 24);
    const peakCape = maxOf(capes);
    const hasThunderCode = fc.daily.slice(0, 3).some((d) => num(d.code) != null && num(d.code) >= 95);
    if (hasThunderCode || (peakCape != null && peakCape >= 1000)) {
      const level = hasThunderCode && peakCape != null && peakCape >= 2500 ? 'orange'
        : hasThunderCode ? 'yellow' : 'blue';
      out.push(make('storm', level, hasThunderCode ? '有雷阵雨' : '对流潜势较强',
        '雷雨时避免在大树、电线杆和空旷地带停留，及时收好阳台物品。',
        hasThunderCode ? '天气码预报有雷暴'
          : `对流有效位能可达 ${Math.round(peakCape)} J/kg`));
    }

    /* ---- 大雾 ----
       按能见度分级：500 m 以下橙色，200 m 以下红色。 */
    const vis = window(fc.rawHours, 'visibility', 24).filter((v) => v != null);
    const minVis = minOf(vis);
    if (minVis != null && minVis < 500) {
      const level = minVis < 200 ? 'red' : 'orange';
      out.push(make('fog', level, `能见度低至 ${Math.round(minVis)} 米`,
        '行车开启雾灯、降低车速、保持车距，高速可能临时封闭。',
        `未来 24 小时最低能见度 ${Math.round(minVis)} 米`));
    } else if (fc.daily[0] && (fc.daily[0].code === 45 || fc.daily[0].code === 48)) {
      out.push(make('fog', 'yellow', '有雾',
        '能见度下降，出行注意慢行。',
        '天气码预报有雾'));
    }

    /* ---- 霾 / 空气重污染 ----
       这一条要有空气质量数据才报，没有就不报——不猜。 */
    if (aq && aq.aqi != null && aq.aqi > 200) {
      const level = aq.aqi > 300 ? 'red' : 'orange';
      out.push(make('haze', level, `${aq.level.name}（AQI ${aq.aqi}）`,
        aq.level.advice,
        `空气质量指数 ${aq.aqi}，首要污染物 ${aq.primary || '—'}`));
    }

    /* ---- 紫外线 ----
       紫外线预警按指数分级，10 以上为"很强"，国内通常到 10 才提示。 */
    const uvMax = maxOf(fc.daily.slice(0, 3).map((d) => num(d.uvMax)).filter((v) => v != null));
    if (uvMax != null && uvMax >= 8) {
      const level = uvMax >= 11 ? 'orange' : uvMax >= 10 ? 'yellow' : 'blue';
      out.push(make('uv', level, `紫外线指数可达 ${Math.round(uvMax)}`,
        '正午前后避免直晒，做好防晒（帽子、墨镜、防晒霜）。',
        `未来 3 天最大紫外线指数 ${Math.round(uvMax)}`));
    }

    // 严重的排前面；同级按类别固定顺序，保证界面稳定不跳动
    return out.sort((a, b) => b.rank - a.rank || orderOf(a.kind) - orderOf(b.kind));
  }

  const ORDER = ['heat', 'cold', 'wind', 'rain', 'snow', 'storm', 'fog', 'haze', 'uv'];
  const orderOf = (kind) => {
    const i = ORDER.indexOf(kind);
    return i < 0 ? ORDER.length : i;
  };

  /** 最高级别，用于在标题上决定用哪个颜色。 */
  function worst(list) {
    if (!list || !list.length) return null;
    return list.slice().sort((a, b) => b.rank - a.rank)[0];
  }

  /** 一句话总结，给折叠状态的标题用。 */
  function summary(list) {
    if (!list || !list.length) return '未来 7 天没有达到预警量级的天气';
    const w = worst(list);
    const others = list.length - 1;
    return `${w.kindName}${w.levelLabel}${others ? ` 等 ${list.length} 项` : ''}`;
  }

  return { derive, worst, summary, beaufort, LEVELS, KINDS, ORDER };
});
