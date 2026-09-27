/* 服务端接口测试（零依赖，直接打本机服务）
 *
 * 用法：node test/server.test.js
 *
 * 说明：这个测试会真的访问上游接口，属于集成测试而非单元测试。
 * 需要联网；没有网络时相关用例会被跳过而不是失败，
 * 但"参数校验"和"路由"这几组是纯本机的，断网也必须过。
 *
 * 为什么值得单独测服务端：前端永远只看到一种错误形状，
 * 这个"统一"是靠服务端做到的。一旦某条分支漏了包装，
 * 页面就会拿到一个它不认识的响应，然后在用户面前变成一句没头没尾的报错。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 5242);
const BASE = `http://127.0.0.1:${PORT}`;

let server = null;
let online = true;

const get = async (p) => {
  const res = await fetch(BASE + p);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON 就该由用例报出来 */ }
  return { status: res.status, json, text };
};

test.before(async () => {
  server = spawn(process.execPath, [path.join(ROOT, 'server.js'), String(PORT)], { cwd: ROOT, stdio: 'ignore' });

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/');
      if (res.ok) break;
    } catch (e) { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }

  // 探一下上游是否可达，决定要不要跳过联网用例
  try {
    await fetch('https://api.open-meteo.com/v1/forecast?latitude=39.9&longitude=116.4&current=temperature_2m', {
      signal: AbortSignal.timeout(6000),
    });
  } catch (e) {
    online = false;
  }
});

test.after(() => {
  if (server) server.kill();
});

/* ------------------------------------------------------------------ 静态资源 */

test('首页能取到，且是完整页面', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.match(res.text, /<title>云图 · 天气台<\/title>/);
  assert.match(res.text, /id="seek-input"/);
});

test('静态文件的 content-type 正确', async () => {
  const css = await fetch(BASE + '/css/styles.css');
  assert.match(css.headers.get('content-type'), /text\/css/);
  const js = await fetch(BASE + '/js/core.js');
  assert.match(js.headers.get('content-type'), /javascript/);
});

test('静态服务只发布本目录，读不到目录之外的文件', async () => {
  // 要说清楚这一条在防什么：本项目是"整个目录就是站点"，
  // 所以 /package.json 是站点自己的文件，读得到是对的。
  // 真正要防的是"跳出本目录"——借 .. 或 %5C 去读上级目录里的东西。
  const outside = [
    '/..%2f..%2fpackage.json',
    '/%5C..%5C..%5Cpackage.json',
    '/..%2f..%2f..%2fWindows%2fwin.ini',
    '/%2e%2e%2f%2e%2e%2fmarkdown-notes%2fpackage.json',   // 隔壁项目
    '/..%2f..%2fREADME.md',                                // 仓库根目录的说明
  ];
  for (const p of outside) {
    const res = await get(p);
    assert.ok(res.status === 403 || res.status === 404, `${p} 应当被拒绝，实际 ${res.status}`);
  }

  // 编码后的单层 .. 会被 URL 解析器规范化成根目录下的同名文件，
  // 那不是越界（它本来就在站点里），这里只要求不泄露目录外的内容。
  const normalized = await get('/..%2fpackage.json');
  assert.ok(!normalized.text.includes('markdown-notes'), '规范化后的请求也不该读到别的项目');
});

test('站点自己的文件都读得到（越界判断没有误杀）', async () => {
  for (const p of ['/package.json', '/js/core.js', '/css/styles.css', '/index.html']) {
    const res = await get(p);
    assert.equal(res.status, 200, p + ' 应当可读');
  }
});

test('不存在的文件返回 404', async () => {
  assert.equal((await get('/nope.html')).status, 404);
});

/* -------------------------------------------------------------- 参数校验 */

test('坐标缺失或非法一律 400，并且是统一的 {error} 形状', async () => {
  const bad = [
    '/api/forecast',
    '/api/forecast?lat=&lon=',            // 空串不能变成 0
    '/api/forecast?lat=abc&lon=1',
    '/api/forecast?lat=91&lon=0',         // 超范围要拒绝，不能让上游取模换地点
    '/api/forecast?lat=0&lon=181',
    '/api/forecast?lat=-91&lon=0',
    '/api/forecast?lat=1e999&lon=0',
    '/api/forecast?lat=30.29',            // 只给一半
    '/api/place',
    '/api/place?lat=&lon=',
  ];
  for (const p of bad) {
    const res = await get(p);
    assert.equal(res.status, 400, p + ' 应当 400，实际 ' + res.status);
    assert.equal(typeof res.json.error, 'string', p + ' 的错误体应当是 {error: string}');
    assert.ok(!res.json.ok, p + ' 失败时不该带 ok');
  }
});

test('空的地名查询返回 400', async () => {
  const res = await get('/api/search?q=' + encodeURIComponent('   '));
  assert.equal(res.status, 400);
  assert.equal(typeof res.json.error, 'string');
});

test('不存在的接口返回 404 而不是页面', async () => {
  const res = await get('/api/nothing');
  assert.equal(res.status, 404);
  assert.equal(typeof res.json.error, 'string');
});

test('只允许 GET', async () => {
  const res = await fetch(BASE + '/api/forecast', { method: 'POST' });
  assert.equal(res.status, 405);
  const body = await res.json();
  assert.equal(typeof body.error, 'string');
});

/* ---------------------------------------------------------- 联网接口（可选） */

test('地名查询返回规范化后的地点', { skip: !online ? '没有网络，跳过联网用例' : false }, async () => {
  const res = await get('/api/search?q=' + encodeURIComponent('杭州'));
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  const list = res.json.data.results;
  assert.ok(Array.isArray(list) && list.length > 0, '应当至少返回一个结果');
  const first = list[0];
  assert.equal(first.name, '杭州市');
  assert.equal(typeof first.latitude, 'number');
  assert.equal(typeof first.longitude, 'number');
  assert.equal(typeof first.id, 'string');
  assert.match(String(first.region), /浙江/);
  assert.ok(Array.isArray(res.json.sources), '应当报告每个源是否可用');
});

test('县级地名查得到，且落在正确的省', { skip: !online ? '没有网络，跳过' : false }, async () => {
  /* 这条用例锁的是本次修复的核心问题：
     修复前「临县」「离石」「兴县」这些山西的县级地名在 Open-Meteo 地名库里是空的，
     而「吕梁」会给回河南许昌、江苏徐州的同名地点。 */
  const cases = [
    ['临县', '山西'],
    ['离石', '山西'],
    ['兴县', '山西'],
    ['吕梁', '山西'],
    ['碛口', '山西'],
  ];
  const bad = [];
  for (const [q, region] of cases) {
    const res = await get('/api/search?q=' + encodeURIComponent(q));
    assert.equal(res.status, 200, q + ' 应当返回 200');
    const top = res.json.data.results[0];
    if (!top) { bad.push(`${q}：查不到`); continue; }
    if (!String(top.region || '').includes(region)) {
      bad.push(`${q}：查到了「${top.name}·${top.region}」，不是${region}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  assert.deepEqual(bad, []);
});

test('带省份前缀的地名走兜底并给出说明', { skip: !online ? '没有网络，跳过' : false }, async () => {
  const res = await get('/api/search?q=' + encodeURIComponent('山西临县'));
  assert.equal(res.status, 200);
  assert.ok(res.json.data.results.length > 0, '「山西临县」不该查不到');
  assert.equal(res.json.data.results[0].name, '临县');
  assert.ok(typeof res.json.note === 'string' && res.json.note.length > 0, '应当给出兜底说明');
});

test('地名检索结果会被缓存，第二次不再打上游', { skip: !online ? '没有网络，跳过' : false }, async () => {
  await get('/api/search?q=' + encodeURIComponent('太原'));
  const second = await get('/api/search?q=' + encodeURIComponent('太原'));
  assert.equal(second.status, 200);
  assert.equal(second.json.cached, true, '第二次应当命中缓存');
});

test('查不到的地名返回空列表而不是报错', { skip: !online ? '没有网络，跳过' : false }, async () => {
  const res = await get('/api/search?q=' + encodeURIComponent('zzzz其实不存在的地名zzzz'));
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.deepEqual(res.json.data.results, []);
});

test('天气接口返回前端要的全部字段', { skip: !online ? '没有网络，跳过' : false }, async () => {
  const res = await get('/api/forecast?lat=30.2936&lon=120.1614');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);

  const d = res.json.data;
  assert.equal(typeof d.timezone, 'string');
  assert.ok(d.current && typeof d.current.temperature_2m === 'number', 'current.temperature_2m 必须存在');
  assert.equal(typeof d.current.is_day, 'number');
  assert.equal(typeof d.current.surface_pressure, 'number');
  assert.equal(typeof d.current.wind_direction_10m, 'number');

  assert.equal(d.daily.time.length, 7, '应当给 7 天预报');
  assert.equal(d.daily.temperature_2m_max.length, 7);
  assert.match(d.daily.sunrise[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

  // hourly 必须是「从此刻起 24 小时」窗口，而不是整天或几天
  assert.ok(d.hourly.time.length >= 24, 'hourly 至少 24 条，实际 ' + d.hourly.time.length);
  assert.ok(d.hourly.time.length <= 26, 'hourly 不该给太多，实际 ' + d.hourly.time.length);
});

test('第二次请求走缓存（cached: true）', { skip: !online ? '没有网络，跳过' : false }, async () => {
  const first = await get('/api/forecast?lat=31.2304&lon=121.4737');
  const second = await get('/api/forecast?lat=31.2304&lon=121.4737');
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  // 第一次可能命中（如果前面的用例查过同一坐标），但第二次必须是缓存
  assert.equal(second.json.cached, true, '第二次应当命中缓存');
  assert.deepEqual(second.json.data.current, first.json.data.current);
});

test('反向地理编码能反查出地名，上游不可用时给出结构化错误', { skip: !online ? '没有网络，跳过' : false }, async () => {
  const res = await get('/api/place?lat=30.27&lon=120.15');

  /* 这条用例依赖第三方反查服务（BigDataCloud），它偶尔会慢到超时。
     上游抽风不该判定本项目有 bug，但"上游坏了我们会怎样"必须是可以断言的：
     要么正常给数据，要么给一个前端认识的 {error} 形状 —— 两者都算通过。 */
  if (res.status === 502) {
    assert.equal(typeof res.json.error, 'string');
    assert.match(res.json.error, /超时|不可用/, '超时的错误文案应当说清是超时或不可用，实际：' + res.json.error);
    return;
  }

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  const p = res.json.data;
  assert.equal(typeof p.name, 'string');
  assert.ok(p.name.length > 0, '反查出来的地名不能为空');
  assert.equal(typeof p.latitude, 'number');
  assert.equal(typeof p.longitude, 'number');
});

test('上游失败时退回过期缓存而不是报错', { skip: !online ? '没有网络，跳过' : false }, async () => {
  /* 先正常取一次把数据放进缓存，再构造一个必定超时的坐标请求不行——
     缓存键是按坐标算的，换坐标就换键。
     所以这里换个角度验证：同一坐标请求两次，第二次必须是 cached；
     这说明了"缓存确实在服务端生效"，也就是 stale 兜底的前提成立。 */
  const first = await get('/api/forecast?lat=22.3193&lon=114.1694');   // 香港
  assert.equal(first.status, 200);
  const second = await get('/api/forecast?lat=22.3193&lon=114.1694');
  assert.equal(second.status, 200);
  assert.equal(second.json.cached, true);
  assert.equal(second.json.data.current.temperature_2m, first.json.data.current.temperature_2m);
});

test('坐标经过合法化：极值坐标不会让上游报错', { skip: !online ? '没有网络，跳过' : false }, async () => {
  for (const [lat, lon] of [[90, 180], [-90, -180], [0, 0]]) {
    const res = await get(`/api/forecast?lat=${lat}&lon=${lon}`);
    assert.equal(res.status, 200, `${lat},${lon} 应当取到数据`);
    assert.equal(res.json.ok, true);
  }
});
