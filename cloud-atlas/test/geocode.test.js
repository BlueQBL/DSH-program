/* 地名检索测试
 *
 * 用法：node test/geocode.test.js
 *
 * 分两部分：
 *   1. 纯函数（合并、判重、排序、拆分、POI 判定）——不联网，必须全过；
 *   2. 联网用例——真的查地名库，锁定"县级地名查得到"这个已经修好的行为。
 *
 * 为什么第 2 部分值得写进测试：这一块的失败方式是"静默的"。
 * 上游地名库不会报错，它只是返回空数组或者返回另一个省的同名地点，
 * 前端于是显示"没有找到"或显示错的天气，而没有任何异常可看。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../lib/geocode.js');

let online = true;

/** 造一条内部形状的地点，用于纯函数测试 */
const P = (name, lat, lon, opts) => Object.assign({
  id: `${lat},${lon}`, name, city: null, region: null, country: null,
  latitude: lat, longitude: lon, kind: 'city', tier: 3, source: 'photon',
}, opts || {});

/* ------------------------------------------------------------------ 纯函数 */

test('省级前缀能识别全名与简称', () => {
  assert.deepEqual(G.splitProvince('山西临县'), { province: '山西', rest: '临县' });
  assert.deepEqual(G.splitProvince('山西省临县'), { province: '山西', rest: '临县' });
  // 三个字的省名不能被两个字的先匹配掉
  assert.deepEqual(G.splitProvince('黑龙江漠河'), { province: '黑龙江', rest: '漠河' });
  assert.deepEqual(G.splitProvince('内蒙古额济纳旗'), { province: '内蒙古', rest: '额济纳旗' });
  // 没有省级前缀、或前缀后没剩东西，都不算拆分成功
  assert.equal(G.splitProvince('临县'), null);
  assert.equal(G.splitProvince('吕梁临县'), null);
  assert.equal(G.splitProvince('山西省'), null);
});

test('省名归一：山西省 / 山西 / 内蒙古自治区 都归到简称', () => {
  assert.equal(G.resolveProvince('山西省'), '山西');
  assert.equal(G.resolveProvince('山西'), '山西');
  assert.equal(G.resolveProvince('内蒙古自治区'), '内蒙古');
  assert.equal(G.resolveProvince('北京市'), '北京');
  assert.equal(G.resolveProvince(''), '');
});

test('名称匹配分：完全一样 > 去掉后缀一样 > 包含 > 无关', () => {
  assert.equal(G.nameScore('临县', '临县'), 3);
  assert.equal(G.nameScore('临县', '临县北'), 1);
  assert.equal(G.nameScore('离石', '离石区'), 2);
  assert.equal(G.nameScore('临县', '吕梁市'), 0);
  assert.equal(G.nameScore('', '临县'), 0);
});

test('POI 与居民点的区分', () => {
  assert.equal(G.isSettlement(P('临县', 0, 0, { kind: 'city' })), true);
  assert.equal(G.isSettlement(P('临县', 0, 0, { kind: 'county' })), true);
  assert.equal(G.isSettlement(P('离石隧道', 0, 0, { kind: 'yes' })), false);
  assert.equal(G.isSettlement(P('岚县中学', 0, 0, { kind: 'school' })), false);
  assert.equal(G.isSettlement(P('某地', 0, 0, { kind: null })), true, '类型未知时不应被当成 POI 丢掉');
});

test('同名不同省：合并时按"去掉后缀的名字"分组，让更像正经地方的那条胜出', () => {
  /* 这是本项目遇到的最坑的问题。实测「吕梁」：
       Open-Meteo → 吕梁（河南许昌），名字完全匹配但省份是错的
       Photon     → 吕梁市（山西省），对的
     如果按坐标判重，两条坐标不同会被当成两个地方，错的那条还会因为
     "名字完全匹配"排在第一。所以必须按名字分组。 */
  const wrong = P('吕梁', 34.05, 114.17, { region: '河南', tier: 3, source: 'open-meteo' });
  const right = P('吕梁市', 37.69, 111.32, { region: '山西省', tier: 5, kind: 'region' });

  const out = G.merge([wrong, right], '吕梁');
  assert.equal(out.length, 1, '同名（去掉后缀后）应当合成一条');
  assert.equal(out[0].region, '山西省', '应当留下山西那条，而不是河南的同名地点');
});

test('同名同地：两个源的字段互相补齐', () => {
  // Photon 给行政区划，Open-Meteo 给时区和海拔
  const a = P('临县', 37.95, 110.99, { region: '山西省', city: '吕梁市', timezone: null });
  const b = P('临县', 37.951, 110.992, { region: null, timezone: 'Asia/Shanghai', elevation: 958, source: 'open-meteo' });

  const out = G.merge([a, b], '临县');
  assert.equal(out.length, 1, '坐标只差几百米，应当合并');
  assert.equal(out[0].timezone, 'Asia/Shanghai');
  assert.equal(out[0].elevation, 958);
  assert.equal(out[0].region, '山西省');
});

test('不同地方不会被误并', () => {
  const hz = P('杭州', 30.29, 120.16, { region: '浙江省' });
  const hzSc = P('杭州', 30.07, 102.20, { region: '四川省' });
  // 名字一样、坐标差几百公里：这里按名字分组会合成一条，这是有意的取舍——
  // 同名不同省时我们选更像正经地方的那条（杭州在浙江），而不是把两条都列出来。
  const out = G.merge([hz, hzSc], '杭州');
  assert.equal(out.length, 1);
  assert.equal(out[0].region, '浙江省', '应当优先保留人口/行政级别更高的那条');
});

test('组间排序：名称匹配为主，行政级别为辅', () => {
  const list = [
    P('临县北', 38.02, 111.01, { kind: 'station', tier: 1 }),   // 名字包含"临县"但是个车站
    P('临县', 37.95, 110.99, { tier: 5 }),
    P('吕梁市', 37.69, 111.32, { tier: 5 }),
  ];
  const out = G.merge(list, '临县');
  assert.equal(out[0].name, '临县', '完全匹配的排第一');
  assert.ok(out.findIndex((p) => p.name === '吕梁市') > 0, '完全无关的排最后');
});

test('Photon 的双语长名会截短成汉语部分，外文名不动', () => {
  // 内蒙古的很多地名会带上蒙古文，直接显示会把版面撑坏
  assert.equal(G.photonName('乌兰察布市 ᠤᠯᠠᠭᠠᠨᠴᠠᠪ'), '乌兰察布市');
  assert.equal(G.photonName('北京市'), '北京市');
  // 外文名里的空格是名字的一部分，截成「New」就是另一个地名了
  assert.equal(G.photonName('New York'), 'New York');
  assert.equal(G.photonName('Cape Town'), 'Cape Town');
  assert.equal(G.photonName('Sao Paulo'), 'Sao Paulo');
  assert.equal(G.photonName(''), '');
});

test('地方类型分档：市/省高于村镇，村镇高于 POI', () => {
  assert.ok(G.tierOf('PPLC') > G.tierOf('PPL'));
  assert.ok(G.tierOf(null, 'city') > G.tierOf(null, 'town'));
  assert.ok(G.tierOf(null, 'town') > G.tierOf(null, 'station'));
  assert.equal(G.tierOf(null, '不认识的类型'), 2, '不认识的类型给一个中性档位，不能是 0');
});

test('外文别名表覆盖常见世界城市，且都有对应的原名', () => {
  assert.equal(G.FOREIGN_ALIAS['雷克雅未克'], 'Reykjavik');
  assert.equal(G.FOREIGN_ALIAS['纽约'], 'New York');
  assert.equal(G.FOREIGN_ALIAS['东京'], 'Tokyo');
  for (const [zh, en] of Object.entries(G.FOREIGN_ALIAS)) {
    assert.ok(zh.length >= 2, `中文名 ${zh} 太短`);
    assert.match(en, /^[A-Za-z .'-]+$/, `${zh} 对应的原名 ${en} 不是外文`);
  }
});

/* ---------------------------------------------------------- 联网用例（可选） */

test('县级地名查得到——这是本次修复的核心', { skip: !online ? '没有网络，跳过' : false }, async () => {
  /* 山西吕梁一带的县级地名。修复前这些全是空的，而且吕梁还会给出河南/江苏的同名地点。 */
  const cases = [
    ['临县', '山西省'],
    ['离石', '山西省'],
    ['兴县', '山西省'],
    ['岚县', '山西省'],
    ['方山', '山西省'],
    ['中阳', '山西省'],
    ['交城', '山西省'],
    ['文水', '山西省'],
  ];

  const failures = [];
  for (const [q, expectRegion] of cases) {
    const r = await G.search(q, 5);
    const top = r.results[0];
    if (!top) {
      failures.push(`${q}：查不到`);
      continue;
    }
    const region = String(top.region || '');
    if (!region.includes('山西')) {
      failures.push(`${q}：查到的是「${top.name}·${region}」，不是山西`);
    }
    await new Promise((res) => setTimeout(res, 400));   // 别把公益服务打急
  }
  assert.deepEqual(failures, [], '县级地名应当都能查到山西的那个');
});

test('乡镇级地名也能查到', { skip: !online ? '没有网络，跳过' : false }, async () => {
  const r = await G.search('碛口', 5);
  assert.ok(r.results.length > 0, '碛口应当能查到（碛口镇）');
  assert.ok(r.results[0].name.includes('碛口'));
  assert.ok(String(r.results[0].region || '').includes('山西'));
});

test('「山西临县」这种带省份的写法查得到', { skip: !online ? '没有网络，跳过' : false }, async () => {
  const r = await G.search('山西临县', 5);
  assert.ok(r.results.length > 0, '带省份前缀不该查不到');
  assert.equal(r.results[0].name, '临县');
  assert.ok(String(r.results[0].region || '').includes('山西'));
  assert.ok(r.note, '走了兜底应当给出说明，好让界面告诉用户');
});

test('「吕梁临县」这种带地级市的写法查得到', { skip: !online ? '没有网络，跳过' : false }, async () => {
  const r = await G.search('吕梁临县', 5);
  assert.ok(r.results.length > 0, '带地级市前缀不该查不到');
  assert.equal(r.results[0].name, '临县');
  assert.ok(String(r.results[0].region || '').includes('山西'));
});

test('地级市本身查得到，并且是对的省', { skip: !online ? '没有网络，跳过' : false }, async () => {
  const r = await G.search('吕梁', 5);
  assert.ok(r.results.length > 0);
  assert.ok(String(r.results[0].region || '').includes('山西'),
    '吕梁必须落在山西省，不能是河南或江苏的同名地点');
});

test('外文译名会兜底到原名', { skip: !online ? '没有网络，跳过' : false }, async () => {
  const r = await G.search('雷克雅未克', 5);
  assert.ok(r.results.length > 0, '常见世界城市的译名应当能查到');
  assert.ok(r.note, '应当说明是按外文原名查到的');
  // 结果必须在冰岛，不能是德国那家同名服装店
  const top = r.results[0];
  assert.ok(/冰岛|Ísland/.test(String(top.country || '')) || /Reykjav/.test(top.name),
    `雷克雅未克查到了「${top.name}·${top.country}」`);
});

test('大城市照常工作，没有被新逻辑弄坏', { skip: !online ? '没有网络，跳过' : false }, async () => {
  for (const [q, region] of [['杭州', '浙江'], ['三亚', '海南'], ['北京', '北京']]) {
    const r = await G.search(q, 5);
    assert.ok(r.results.length > 0, `${q} 应当查得到`);
    assert.ok(String(r.results[0].region || '').includes(region),
      `${q} 的第一个结果应当是 ${region} 的，实际是 ${r.results[0].name}·${r.results[0].region}`);
    await new Promise((res) => setTimeout(res, 400));
  }
});

test('查不到的地名返回空结果而不是报错', { skip: !online ? '没有网络，跳过' : false }, async () => {
  const r = await G.search('zzz不存在的地名zzz', 5);
  assert.deepEqual(r.results, []);
  assert.equal(r.degraded, false, '查不到不等于服务不可用');
});

test('行政区划查询里 POI 排在后面', { skip: !online ? '没有网络，跳过' : false }, async () => {
  const r = await G.search('岚县', 8);
  const first = r.results.findIndex((p) => G.isSettlement(p));
  assert.equal(first, 0, '第一个结果必须是居民点，不能是「岚县中学」这类 POI');
});
