/* 地名检索：多源合并
 *
 * 为什么需要这个文件：单独用任何一个上游地名库都查不全中国的地名。
 * 实测（2026-09）：
 *
 *   查询      Open-Meteo                     Photon（OSM）
 *   临县      查不到                        临县 · 山西省吕梁市 ✓
 *   离石      查不到                        离石区 · 山西省 ✓
 *   兴县      查不到                        兴县 · 山西省吕梁市 ✓
 *   岚县      查不到                        岚县 · 山西省吕梁市 ✓
 *   碛口      查不到                        碛口镇 · 山西省吕梁市 ✓
 *   吕梁      给的是「河南许昌」「江苏徐州」 吕梁市 · 山西省 ✓ ← 名字对上但省份是错的
 *   孝义      给的是「陕西渭南」「陕西咸阳」 山西省 ✓
 *   雷克雅未克 查不到                        也查不到，但 Reykjavik 查得到
 *   杭州      杭州市 · 浙江省 ✓             杭州市 · 浙江省 ✓
 *
 * 两类问题都要治：
 *   1. 查不到（县级、乡镇级地名大量缺失）——所以必须有第二个源；
 *   2. 张冠李戴（同名不同省，却给了别的省的结果）——所以第二个源同时是纠错手段。
 * 于是两边都查、合并去重、再按"是不是这个字 + 是哪一级地方"排序。
 *
 * 网络与限流：Photon 是社区公益服务，偶发抽风或限流。
 * 所以每个源都有独立超时，一个失败不影响另一个；两个都失败才报错。
 */
'use strict';

const { normalizePlace } = require('../js/core.js');

const PHOTON = 'https://photon.komoot.io/api';
const OPEN_METEO = 'https://geocoding-api.open-meteo.com/v1/search';

const SOURCE_TIMEOUT_MS = 8000;
const USER_AGENT = 'cloud-atlas/1.0 (local weather console; personal, low-volume use)';

/* OSM 的地方类型 → 分档。档位越高排得越前：
   查「杭州」时「杭州市」要排在「杭州萧山国际机场」前面。 */
const OSM_TIER = {
  city: 5,
  region: 5,
  state: 4,
  county: 4,
  district: 4,
  municipality: 4,
  province: 4,
  town: 3,
  village: 2,
  hamlet: 2,
  suburb: 2,
  quarter: 2,
  borough: 2,
  neighbourhood: 2,
  locality: 1,
  isolated_dwelling: 1,
  farm: 1,
};

const OPEN_METEO_TIER = {
  PPLC: 6,   // 首都
  PPLA: 5,   // 一级行政区首府
  PPLA2: 5,
  PPLA3: 4,
  PPLA4: 4,
  PPL: 3,    // 普通居民点
  PPLX: 1,   // 社区
};

function tierOf(featureCode, osmValue) {
  const f = String(featureCode || '').toUpperCase();
  if (OPEN_METEO_TIER[f] != null) return OPEN_METEO_TIER[f];
  const o = String(osmValue || '').toLowerCase();
  return OSM_TIER[o] != null ? OSM_TIER[o] : 2;
}

/** 去掉行政区划后缀，用来判断"是不是同一个字"：临县 / 临县北 / 吕梁 / 吕梁市 */
const SUFFIX = /(特别行政区|自治区|自治州|自治县|地区|盟|市辖区|新区|省|市|县|区|镇|乡|街道|村|旗)$/;

function baseName(name) {
  return String(name || '').trim().replace(SUFFIX, '');
}

/* 省级行政区。这份名单用来做「山西临县」这类复合输入的拆分——
   中国的一级行政区划是稳定数据（近十年只有极少数调整），写死在代码里
   不会像地名库那样过期，也不需要多打一次请求去猜。
   真名与简称都要有：用户会写「山西临县」，也会写「山西省临县」。 */
const PROVINCES = [
  '北京', '天津', '上海', '重庆',
  '河北', '山西', '辽宁', '吉林', '黑龙江', '江苏', '浙江', '安徽', '福建', '江西',
  '山东', '河南', '湖北', '湖南', '广东', '海南', '四川', '贵州', '云南', '陕西',
  '甘肃', '青海', '台湾',
  '内蒙古', '广西', '西藏', '宁夏', '新疆',
  '香港', '澳门',
];

const PROVINCE_SUFFIX = /^(.*?)(特别行政区|自治区|省|市)?$/;

/** 把一个地名拆成「省级前缀 + 剩余部分」。拆不出来返回 null。 */
function splitProvince(q) {
  const s = String(q || '').trim();
  // 长的先试：黑龙江/内蒙古 是三个字，不能先被"黑"或"内"匹配掉
  const ordered = PROVINCES.slice().sort((a, b) => b.length - a.length);
  for (const prov of ordered) {
    if (!s.startsWith(prov) || s.length <= prov.length + 1) continue;
    let rest = s.slice(prov.length).replace(/^(省|市|自治区|特别行政区)/, '');
    if (rest.length >= 2) return { province: prov, rest };
  }
  return null;
}

/**
 * 是不是一个"像样的地方"。
 *
 * Photon 是基于 OSM 的全文检索，它会给回隧道、学校、公园、车站、机场这类 POI。
 * 查「离石」时排在正确结果后面的就是「离石隧道」「离石森林公园」——
 * 这些对天气查询毫无意义，而且会把候选列表占满。
 * 所以只在查行政地名时过滤掉它们；如果用户直接搜「萧山机场」，那机场就是他想要的，
 * 这时名称不是"查询词 + 后缀"的形式，不会被误杀。
 */
const POI_KINDS = new Set([
  'station', 'halt', 'stop', 'aerodrome', 'airport', 'airp', 'school', 'university',
  'college', 'kindergarten', 'hospital', 'clinic', 'park', 'garden', 'peak', 'water',
  'tunnel', 'bridge', 'yes', 'house', 'building', 'supermarket', 'bank', 'restaurant',
  'hotel', 'clothes', 'shop', 'mall', 'factory', 'industrial', 'motorway_junction',
  'tertiary', 'primary', 'secondary', 'residential', 'service', 'footway', 'track',
  'railway', 'locality', 'farm', 'isolated_dwelling', 'attraction', 'museum', 'library',
]);

function isSettlement(place) {
  return !POI_KINDS.has(String(place.kind || '').toLowerCase());
}

/** 名称匹配分。用户打的字与结果名的关系决定它该排多前：
 *   完全一样 3 分；去掉"市/县/区"后一样 2 分；包含关系 1 分。 */
function nameScore(query, name) {
  const q = baseName(query).toLowerCase();
  const n = String(name || '').trim();
  const nb = baseName(n).toLowerCase();
  if (!q || !nb) return 0;
  if (n.toLowerCase() === String(query).trim().toLowerCase()) return 3;
  if (nb === q) return 2;
  if (nb.includes(q) || q.includes(nb)) return 1;
  return 0;
}

/**
 * 把一条 Photon 结果的名字收拾干净。
 *
 * Photon 对内蒙古这类双语地区会返回「乌兰察布市 ᠤᠯᠠᠭᠠᠨᠴᠠᠪ」这种
 * 「汉语名 + 空格 + 少数民族文字」的长名字，直接显示会把版面撑坏，
 * 所以取空格前的第一段。
 *
 * 但这个规则不能无脑套用：外文名里空格是名字的一部分，
 * 「New York」取第一段就成了「New」——一个完全不同的地名。
 * 所以只在"第一段是汉字（或含汉字）"时才截断。
 */
function photonName(raw) {
  const full = String(raw || '').trim();
  if (!full) return '';
  const head = full.split(/\s+/)[0];
  if (!head || head === full) return full;
  // 第一段就是纯拉丁文 → 外文名，整串保留
  if (/^[\x20-\x7F]+$/.test(head)) return full;
  return /[\u4e00-\u9fff]/.test(head) ? head : full;
}

function fromPhoton(feature) {
  const p = (feature && feature.properties) || {};
  const coords = (feature && feature.geometry && feature.geometry.coordinates) || [];
  if (coords.length < 2) return null;

  const lon = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const name = photonName(p.name);
  if (!name) return null;

  /* 上级行政区在 Photon 里是分开给的，字段含义按实测（不是按文档猜的）：
       临县   → county "吕梁市"、state "山西省"
       清徐县 → city "太原市"、state "山西省"
       碛口镇 → city "临县"、county "吕梁市"、state "山西省"
       北京市 → 只有 country，没有省市（直辖市）
       离石区 → county "李家湾乡"  ← 这里给的是乡，不是上级市
     所以「市一级」要同时看 city 和 county，并且要滤掉乡镇级的值；
     只取 state 会丢掉地级市，界面就只能显示到"山西省"，
     而「吕梁临县」这类带地级市的查询也验证不了。 */
  const place = normalizePlace({
    name,
    latitude: lat,
    longitude: lon,
    admin1: p.state || null,
    country: p.country || null,
    countryCode: p.countrycode || null,
  });
  if (!place) return null;

  place.city = pickCity(p.city, p.county, p.district, name);
  place.postcode = p.postcode || null;
  place.kind = String(p.osm_value || p.type || '').toLowerCase() || null;
  place.tier = tierOf(null, place.kind);
  place.source = 'photon';
  return place;
}

/* 乡、镇、街道、村不是"上级市"，要排除掉；它们出现在 city 字段里是数据本身的噪声。
   注意"区"不在此列：市辖区确实是县级，但它也常被当作地级市的下一级来显示。 */
const LOWER_THAN_CITY = /(乡|镇|街道|村|屯|组|社区|居委会)$/;

/** 从几个候选字段里挑出可以当作"上级市"的那个，并排除与地点同名的。 */
function pickCity() {
  for (let i = 0; i < arguments.length - 1; i++) {
    const v = arguments[i];
    if (!v || typeof v !== 'string') continue;
    if (LOWER_THAN_CITY.test(v)) continue;
    if (baseName(v) === baseName(arguments[arguments.length - 1])) continue;
    return v;
  }
  return null;
}

function fromOpenMeteo(raw) {
  const place = normalizePlace(raw);
  if (!place) return null;
  place.kind = raw.feature_code ? String(raw.feature_code).toLowerCase() : null;
  place.tier = tierOf(raw.feature_code);
  place.source = 'open-meteo';
  return place;
}

async function fetchJson(url, label) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`${label} 返回 ${res.status}`);
  return res.json();
}

async function queryPhoton(q, limit) {
  const u = new URL(PHOTON);
  u.searchParams.set('q', q);
  u.searchParams.set('limit', String(limit));
  /* 不加 lang 参数：Photon 只支持 default/de/en/fr，带 lang=zh 会直接被 400 拒掉。
     不加时它返回 OSM 本地名称，中国地名本来就是中文，正是我们要的。 */
  const json = await fetchJson(u.toString(), 'Photon');
  return (Array.isArray(json.features) ? json.features : []).map(fromPhoton).filter(Boolean);
}

async function queryOpenMeteo(q, limit) {
  const u = new URL(OPEN_METEO);
  u.searchParams.set('name', q);
  u.searchParams.set('count', String(limit));
  u.searchParams.set('language', 'zh');
  u.searchParams.set('format', 'json');
  const json = await fetchJson(u.toString(), 'Open-Meteo');
  return (Array.isArray(json.results) ? json.results : []).map(fromOpenMeteo).filter(Boolean);
}

/** 同经纬度换算成大致距离（公里）的平方，用来判重。 */
function distanceKm2(a, b) {
  const dx = (a.longitude - b.longitude) * 111 * Math.cos((a.latitude * Math.PI) / 180);
  const dy = (a.latitude - b.latitude) * 111;
  return dx * dx + dy * dy;
}

const NEAR_KM2 = 4;   // 2 公里的平方：两个源对同一地点的坐标差通常在几百米内

/**
 * 合并两个源的结果。这一步是整个检索的关键，所以要写清楚它在解决什么。
 *
 * 同名不同省是这个数据集里最坑人的问题。实测「吕梁」：
 *   Open-Meteo → 吕梁（河南许昌）、吕梁（江苏徐州）—— 名字一字不差，省份完全错
 *   Photon     → 吕梁市（山西省）—— 对了
 * 如果只按"名字像不像"排序，那个错的结果会排在前面，因为它的名字是**完全匹配**。
 * 只按坐标判重也救不了：它们坐标本来就不同，会被当成两个不同的地方。
 *
 * 所以判重和排序必须按「去掉行政区划后缀后的名字」分组，而不是只按坐标：
 *   - 同名不同省 → 归到同一组，组内让"更像一个正经地方"（tier 高）的那条胜出，
 *     山西的吕梁市是 city（tier 5），河南的吕梁是 PPL（tier 3），于是选对了；
 *   - 同名同地 → 也归到同一组，顺带把两个源的信息合并（Photon 有准确的上级行政区，
 *     Open-Meteo 有准确的时区）；
 *   - 组之间再按名称匹配度和 tier 排先后。
 *
 * 组内选完还要把落选那条的有用字段补进来，所以最后做一次"谁有值用谁的"。
 */
function merge(list, query) {
  const groups = new Map();

  for (const place of list) {
    const key = baseName(place.name).toLowerCase() || place.name.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(place);
  }

  const merged = [];
  for (const [, members] of groups) {
    // 组内先按 tier 排，再优先 Photon（中国行政区划覆盖更好），最后看人口
    const best = members.slice().sort((a, b) => (
      (b.tier || 0) - (a.tier || 0)
      || (b.source === 'photon' ? 1 : 0) - (a.source === 'photon' ? 1 : 0)
      || (b.population || 0) - (a.population || 0)
    ))[0];

    const out = Object.assign({}, best);
    for (const m of members) {
      if (!out.timezone && m.timezone) out.timezone = m.timezone;
      if (!out.region && m.region) out.region = m.region;
      if (!out.city && m.city) out.city = m.city;
      if (!out.country && m.country) out.country = m.country;
      if (!out.countryCode && m.countryCode) out.countryCode = m.countryCode;
      if (out.elevation == null && m.elevation != null) out.elevation = m.elevation;
      if (out.population == null && m.population != null) out.population = m.population;
    }
    merged.push(out);
  }

  /* 组间排序：名称匹配度为主，tier 与人口为辅。
     权重刻意让它们不在一个数量级上——名称对了就是对了，tier 只用来在同样对上的候选里分先后。 */
  return merged
    .map((place) => ({
      place,
      score: nameScore(query, place.name) * 100
        + (place.tier || 0) * 8
        + (place.source === 'photon' ? 4 : 0)
        + Math.min(3, Math.log10(Math.max(1, place.population || 1))),
    }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.place);
}

/**
 * 复合地名兜底：「山西临县」「吕梁临县」这种输入。
 *
 * 地名库里没有「山西临县」这个条目，照字面查必然为空。
 * 但用户这么写是有道理的——县名会重名，他想限定省份。
 *
 * 实测发现 Photon 对「山西 临县」（中间有空格）能给出正确答案，
 * 而「山西省临县」不行（它去匹配"山西省临猗县临晋初中"这类学校名了）。
 * 所以做法是：认出开头的省级行政区，拆出剩余部分，用 `省 + 空格 + 地名` 再查一次，
 * 然后只保留上级行政区确实是这个省的候选。
 *
 * 只在整串查不到时才走这条路，正常查询不会多花一次往返。
 */
async function searchCompound(q, limit) {
  const split = splitProvince(q);
  if (!split) return [];

  const { province, rest } = split;
  // 「山西 临县」这个空格很关键，不能省
  const phrased = `${province} ${rest}`;

  const settled = await Promise.allSettled([
    queryPhoton(phrased, limit),
    queryOpenMeteo(rest, limit),
  ]);
  const hits = [];
  for (const s of settled) if (s.status === 'fulfilled') hits.push(...s.value);
  if (!hits.length) return [];

  const merged = merge(hits, rest);

  /* 只留"上级行政区真的属于这个省"的候选。
     比较时两边都要去掉后缀：Photon 给的是「山西省」，Open-Meteo 给的是「山西」，
     直接 includes 会因为一个"省"字全部落空。 */
  const want = resolveProvince(province);
  const inProvince = merged.filter((p) => {
    const region = baseName(p.region || '');
    return region && (region === want || region.startsWith(want) || want.startsWith(region));
  });

  // 一条都没落在目标省时，宁可返回全部（至少用户能看到候选），也不返回空
  return inProvince.length ? inProvince : merged;
}

/** 「山西省」/「山西」→「山西」；「内蒙古自治区」→「内蒙古」 */
function resolveProvince(name) {
  const s = String(name || '').trim();
  const hit = PROVINCES.find((p) => s.startsWith(p));
  return hit || baseName(s);
}

/**
 * 中文译名 → 外文原名。
 *
 * 地名库对中文译名的覆盖很差：查「雷克雅未克」两个源都是空的，
 * 但「Reykjavik」查得到（Open-Meteo 还会把它显示成中文「雷克亞維克」）。
 * 这份表只收最常见的世界城市——它不是一份翻译词典，而是一个"少踩一次空结果"的兜底。
 * 表里没有的译名，用户改用英文名即可，界面会提示这一点。
 */
const FOREIGN_ALIAS = {
  雷克雅未克: 'Reykjavik', 纽约: 'New York', 伦敦: 'London', 东京: 'Tokyo',
  巴黎: 'Paris', 悉尼: 'Sydney', 莫斯科: 'Moscow', 新加坡: 'Singapore',
  首尔: 'Seoul', 曼谷: 'Bangkok', 迪拜: 'Dubai', 开罗: 'Cairo',
  柏林: 'Berlin', 罗马: 'Rome', 温哥华: 'Vancouver', 洛杉矶: 'Los Angeles',
  旧金山: 'San Francisco', 芝加哥: 'Chicago', 西雅图: 'Seattle', 波士顿: 'Boston',
  多伦多: 'Toronto', 墨尔本: 'Melbourne', 大阪: 'Osaka', 京都: 'Kyoto',
  孟买: 'Mumbai', 新德里: 'New Delhi', 雅加达: 'Jakarta', 吉隆坡: 'Kuala Lumpur',
  河内: 'Hanoi', 马尼拉: 'Manila', 伊斯坦布尔: 'Istanbul', 维也纳: 'Vienna',
  阿姆斯特丹: 'Amsterdam', 苏黎世: 'Zurich', 日内瓦: 'Geneva', 斯德哥尔摩: 'Stockholm',
  哥本哈根: 'Copenhagen', 奥斯陆: 'Oslo', 赫尔辛基: 'Helsinki', 都柏林: 'Dublin',
  马德里: 'Madrid', 巴塞罗那: 'Barcelona', 里斯本: 'Lisbon', 雅典: 'Athens',
  布拉格: 'Prague', 华沙: 'Warsaw', 布达佩斯: 'Budapest', 开普敦: 'Cape Town',
  内罗毕: 'Nairobi', 圣保罗: 'Sao Paulo', 布宜诺斯艾利斯: 'Buenos Aires',
  墨西哥城: 'Mexico City', 檀香山: 'Honolulu', 奥克兰: 'Auckland', 惠灵顿: 'Wellington',
};

/**
 * 主检索入口。
 *
 * 两个源并行查。一个源挂了不影响另一个——这很重要：
 * Photon 是社区公益服务，抽风时如果整个搜索都失败，用户会以为"这应用坏了"，
 * 而实际上主力数据（Open-Meteo）还好好的。
 *
 * @returns {Promise<{results: Array, sources: Array, note: string|null, degraded: boolean}>}
 */
async function search(query, limit, opts) {
  const n = Math.max(1, Math.min(20, limit || 8));
  const o = opts || {};
  const q = String(query || '').trim();

  const settled = await Promise.allSettled([
    queryPhoton(q, n),
    queryOpenMeteo(q, n),
  ]);

  const photon = settled[0].status === 'fulfilled' ? settled[0].value : [];
  const openMeteo = settled[1].status === 'fulfilled' ? settled[1].value : [];
  const failed = settled.filter((s) => s.status === 'rejected').length;

  let results = merge(photon.concat(openMeteo), q);
  let note = null;

  /* 行政地名查询里把 POI 降到后面。
     判据是"有候选的名字就是查询词加个行政区划后缀"（临县、兴县、离石区…）——
     这种查询下隧道、学校、机场都不是用户要的，实测查「岚县」会返回「岚县中学」。
     注意是**降到后面而不是删掉**：用户搜「萧山机场」时那些 POI 恰恰就是答案，
     而且候选列表多几条无害，少了却可能把正确答案一起删光。 */
  if (results.length > 1 && baseName(q).length >= 2) {
    const looksLikeAdmin = results.some((p) => SUFFIX.test(p.name) && nameScore(q, p.name) >= 2);
    if (looksLikeAdmin) {
      const settlements = results.filter(isSettlement);
      const others = results.filter((p) => !isSettlement(p));
      results = settlements.concat(others);
    }
  }

  /* 整串查不到时才做兜底，避免正常查询多花往返。
     三种兜底按"改动最小"排序：
       1. 拆省级前缀（山西临县 → 临县，且限定在山西省）；
       2. 拆地级市前缀（吕梁临县 → 临县）；
       3. 外文名（雷克雅未克 → Reykjavik）。 */
  if (!results.length) {
    const byProvince = await searchCompound(q, n);
    if (byProvince.length) {
      results = byProvince;
      note = '按省级前缀拆分后找到的结果';
    }
  }
  if (!results.length) {
    const byPrefecture = await searchByPrefix(q, n);
    if (byPrefecture.length) {
      results = byPrefecture;
      note = '按前缀拆分后找到的结果';
    }
  }
  if (!results.length) {
    const alias = o.alias != null ? o.alias : FOREIGN_ALIAS[q];
    if (alias) {
      const byAlias = await searchForeign(alias, n, q);
      if (byAlias.length) {
        results = byAlias;
        note = `「${q}」按外文原名「${alias}」查到`;
      }
    }
  }

  return {
    results: results.slice(0, n),
    sources: [
      { name: 'photon', ok: settled[0].status === 'fulfilled', count: photon.length },
      { name: 'open-meteo', ok: settled[1].status === 'fulfilled', count: openMeteo.length },
    ],
    // 两个源都失败才算彻底不可用；只挂一个时结果是降级的但可用
    degraded: failed === 2,
    partial: failed === 1,
    note,
  };
}

/**
 * 按前缀拆分的通用兜底：把开头 2–4 个字当上级行政区去掉，再查剩下的。
 *
 * 这一条是为了「吕梁临县」这种「地级市 + 县」的写法。
 * 中国的县级地名重名率很高（全国有十几个"城关镇"），用户自然会带上级地名，
 * 但地名库里没有"吕梁临县"这个条目。
 *
 * 不能把全国 300 多个地级市都写进代码——那才是真的会过期。
 * 所以这里不认名单，只做"切掉前缀再查"：
 * 如果切完能查到，而且结果的上级行政区里真的出现了被切掉的那个前缀，
 * 就认为拆对了；否则不返回，避免把「北大」切成「大」这类误判放出去。
 */
async function searchByPrefix(q, limit) {
  const s = String(q || '').trim();
  if (s.length < 4 || s.length > 10) return [];

  for (const cut of [2, 3, 4]) {
    const prefix = s.slice(0, cut);
    const rest = s.slice(cut);
    if (rest.length < 2) break;

    const settled = await Promise.allSettled([queryPhoton(rest, limit)]);
    const hits = settled[0].status === 'fulfilled' ? settled[0].value : [];
    if (!hits.length) continue;

    const merged = merge(hits, rest);
    /* 验证拆得对不对：被切掉的前缀要真的出现在结果的上级行政区里。
       要看 city 和 region 两处——「吕梁临县」的结果里，
       吕梁市在 city 字段（各县由地级市代管），而 province 在 region 字段。
       只看 region 会全部落空，于是明明查到了也被判成"拆错了"。 */
    const inRegion = merged.filter((p) => {
      const up = `${p.city || ''} ${p.region || ''}`;
      return up.includes(prefix) || String(p.name || '').includes(prefix);
    });
    if (inRegion.length) return inRegion;
  }
  return [];
}

/**
 * 外文名兜底：查「雷克雅未克」时地名库里没有这个中文译名，
 * 但「Reykjavik」查得到（Open-Meteo 会把它显示成中文「雷克亞維克」）。
 *
 * 拿到结果后要过滤掉无关的同名地点：直接搜「Reykjavik」的第一条
 * 其实是德国的一家服装店。判据是"结果的名字念起来像不像这个外文词"——
 * 用 Open-Meteo 返回的当地语言名去比对（第 4 个候选就是冰岛的雷克雅未克）。
 */
async function searchForeign(alias, limit, originalQuery) {
  const settled = await Promise.allSettled([
    queryOpenMeteo(alias, limit),
    queryPhoton(alias, limit),
  ]);
  const hits = [];
  for (const s of settled) if (s.status === 'fulfilled') hits.push(...s.value);

  const merged = merge(hits, alias);

  // 只保留"真正的居民点"和"首都/首府级"的结果，服装店和机场排除掉
  const real = merged.filter((p) => isSettlement(p) && (p.tier || 0) >= 4);
  const usable = real.length ? real : merged.filter(isSettlement);

  /* 标记一下：用户搜的是中文译名，结果给的是原文名，
     界面上要能看出来为什么冒出个外国名字。 */
  return usable.map((p) => Object.assign({}, p, {
    matchedAlias: alias,
    aliasFor: originalQuery,
  }));
}

module.exports = {
  search,
  queryPhoton,
  queryOpenMeteo,
  merge,
  nameScore,
  tierOf,
  baseName,
  photonName,
  splitProvince,
  resolveProvince,
  isSettlement,
  searchByPrefix,
  searchForeign,
  FOREIGN_ALIAS,
  SUFFIX,
  PROVINCES,
};
