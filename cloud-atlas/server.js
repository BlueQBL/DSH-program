/* 云图 · 本地服务（零依赖）
 *
 * 用法：node server.js [端口]     默认 http://127.0.0.1:5240
 *
 * 它做两件事：
 *   1. 把当前目录当静态站点发出去（/、/css、/js）。
 *   2. 代理三个上游接口，顺带做缓存、超时和参数校验。
 *
 * 为什么不让浏览器直连上游：
 *   - 上游限流按调用方算。加一层内存缓存后，同一城市 10 分钟内只打一次上游，
 *     切来切去查收藏城市时不会把额度刷爆。
 *   - 上游偶尔抽风或变慢。这里统一超时、统一错误形状，前端只处理一种失败格式；
 *     上游彻底不通时还能退回过期的旧数据，天气停在一个小时前也比一片报错好。
 *   - 反向地理编码（根据定位反查地名）走的是第三方接口，服务端调用可以固定语言参数。
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { UPSTREAM, FORECAST_FIELDS, HOURS_PAST, HOURS_AHEAD, FORECAST_DAYS, MAX_SAVED, normalizePlace } = require('./js/core.js');
const geocode = require('./lib/geocode.js');

const ROOT = __dirname;
const BASE_PORT = Number(process.argv[2] || process.env.PORT || 5240);
// 显式绑定 127.0.0.1：只占 IPv4，避免与别的服务在 ::1 上的同端口监听互相遮蔽
const HOST = process.env.HOST || '127.0.0.1';

const UPSTREAM_TIMEOUT_MS = 9000;
const CACHE_TTL_MS = 10 * 60 * 1000;      // 观测数据 10 分钟内复用
const SEARCH_TTL_MS = 60 * 60 * 1000;     // 地名基本不变，缓存一小时（Photon 是公益服务，省着点用）
const STALE_TTL_MS = 6 * 60 * 60 * 1000;  // 最长容忍 6 小时前的旧数据兜底
const MAX_QUERY = 80;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ------------------------------------------------------------------ 内存缓存 */

const cache = new Map();

function cacheGet(key, ttl) {
  const hit = cache.get(key);
  if (!hit) return null;
  const age = Date.now() - hit.at;
  if (age <= ttl) return hit;
  return null;
}

/** 顺手清掉过期很久的条目。不设定时器，靠每次写入触发，进程退出时不留句柄。 */
function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 200) {
    const cutoff = Date.now() - STALE_TTL_MS;
    for (const [k, v] of cache) if (v.at < cutoff) cache.delete(k);
  }
}

/* ------------------------------------------------------------------ 工具函数 */

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function fail(res, status, message) {
  sendJson(res, status, { error: message });
}

/**
 * 解析坐标参数。
 *
 * 三件事必须在这里做掉，不能指望上游：
 *   - 空串会被 Number('') 变成 0，于是「没给坐标」就变成「几内亚湾的坐标」——
 *     用户点定位失败时，页面上就会一本正经地显示大西洋的天气。所以先判空。
 *   - 超范围（lat=91）上游不会报错，它会自己取模算到另一个地方去（实测 91 → 89.9）。
 *     宁可拒绝，也不要悄悄换一个地点。
 *   - 非数字一律 null。
 */
function parseCoord(raw, limit) {
  if (raw == null || String(raw).trim() === '') return null;
  const v = Number(raw);
  if (!Number.isFinite(v)) return null;
  if (v < -limit || v > limit) return null;
  return v;
}

/** 查询词只做长度与空白清理；中文/重音字符原样传给上游，不做转义。 */
function cleanQuery(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);
}

async function fetchJson(url, label) {
  const started = Date.now();
  const res = await fetch(url, {
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: { 'user-agent': 'cloud-atlas/1.0 (+local weather console)' },
  });
  if (!res.ok) {
    const err = new Error(`${label} 返回 ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  return { json, ms: Date.now() - started };
}

/**
 * 统一的上游调用 + 缓存。
 * fresh 命中直接返回；上游失败时如果有过期的旧数据，就带 stale 标记返回，
 * 让前端照常显示、只在角落里注明数据时间。
 */
async function cachedJson(key, label, buildUrl, res, transform) {
  const fresh = cacheGet(key, CACHE_TTL_MS);
  if (fresh) {
    sendJson(res, 200, { ok: true, cached: true, data: transform ? transform(fresh.value) : fresh.value });
    return;
  }

  try {
    const { json } = await fetchJson(buildUrl(), label);
    cacheSet(key, json);
    sendJson(res, 200, { ok: true, cached: false, data: transform ? transform(json) : json });
  } catch (err) {
    const stale = cacheGet(key, STALE_TTL_MS);
    if (stale) {
      sendJson(res, 200, {
        ok: true,
        cached: true,
        stale: true,
        data: transform ? transform(stale.value) : stale.value,
        warning: `${label}暂时不可用，显示的是缓存数据`,
      });
      return;
    }
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    fail(res, 502, timedOut ? `${label}响应超时，请稍后重试` : `${label}不可用：${err.message}`);
  }
}

/* -------------------------------------------------------------------- 接口 */

async function handleSearch(url, res) {
  const q = cleanQuery(url.searchParams.get('q'));
  if (!q) return fail(res, 400, '请提供要查询的地名');

  const limit = Number(url.searchParams.get('limit')) || 8;
  const key = `search:${q}:${limit}`;

  /* 地名检索要走两个上游（Photon + Open-Meteo），是这里最慢也最容易被限流的一环，
     所以缓存时间比天气数据更长：地名基本不变，而天气 10 分钟就得换。
     查不到的地名也缓存（结果为空数组），否则反复打同一个查不到的字会一直被限流。 */
  const cached = cacheGet(key, SEARCH_TTL_MS);
  if (cached) {
    sendJson(res, 200, Object.assign({ ok: true, cached: true }, cached.value));
    return;
  }

  try {
    const found = await geocode.search(q, limit);
    const payload = {
      data: { query: q, results: found.results },
      note: found.note || null,
      // 一个源挂了要如实告诉前端，别让用户以为"就是没有这个地方"
      partial: found.partial,
      degraded: found.degraded,
      sources: found.sources,
    };
    if (found.degraded) {
      return fail(res, 502, '地名服务暂时不可用，请稍后重试');
    }
    cacheSet(key, payload);
    sendJson(res, 200, Object.assign({ ok: true, cached: false }, payload));
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    fail(res, 502, timedOut ? '地名服务响应超时，请稍后重试' : `地名服务不可用：${err.message}`);
  }
}

async function handlePlace(url, res) {
  const lat = parseCoord(url.searchParams.get('lat'), 90);
  const lon = parseCoord(url.searchParams.get('lon'), 180);
  if (lat == null || lon == null) return fail(res, 400, '定位坐标无效');

  const key = `place:${lat.toFixed(3)},${lon.toFixed(3)}`;
  const build = () => {
    const u = new URL(UPSTREAM.reverse);
    u.searchParams.set('latitude', String(lat));
    u.searchParams.set('longitude', String(lon));
    u.searchParams.set('localityLanguage', 'zh');
    return u.toString();
  };

  await cachedJson(key, '定位反查', build, res, (json) => {
    const place = normalizePlace({
      latitude: lat,
      longitude: lon,
      city: json.city,
      locality: json.locality,
      principalSubdivision: json.principalSubdivision,
      countryName: json.countryName,
      countryCode: json.countryCode,
      // 反查接口不给海拔和时区，留 null；天气接口会补上真正的时区
    });
    // 反查失败时也返回一个坐标名，起码让用户知道定到了哪里
    return place || normalizePlace({ latitude: lat, longitude: lon, name: '我的位置' });
  });
}

async function handleForecast(url, res) {
  const lat = parseCoord(url.searchParams.get('lat'), 90);
  const lon = parseCoord(url.searchParams.get('lon'), 180);
  if (lat == null || lon == null) return fail(res, 400, '坐标无效');

  const key = `wx:${lat.toFixed(3)},${lon.toFixed(3)}`;
  const build = () => {
    const u = new URL(UPSTREAM.forecast);
    u.searchParams.set('latitude', lat.toFixed(4));
    u.searchParams.set('longitude', lon.toFixed(4));
    u.searchParams.set('current', FORECAST_FIELDS.current.join(','));
    u.searchParams.set('hourly', FORECAST_FIELDS.hourly.join(','));
    u.searchParams.set('daily', FORECAST_FIELDS.daily.join(','));
    u.searchParams.set('timezone', 'auto');   // 让上游按当地时区返回，前端不用自己算偏移
    u.searchParams.set('forecast_days', String(FORECAST_DAYS));
    u.searchParams.set('past_hours', String(HOURS_PAST));
    u.searchParams.set('forecast_hours', String(HOURS_AHEAD));
    u.searchParams.set('wind_speed_unit', 'kmh');
    return u.toString();
  };

  await cachedJson(key, '天气数据', build, res);
}

/* --------------------------------------------------------------- 静态文件 */

/**
 * 静态文件路径必须留在本目录里。
 *
 * 光比较字符串前缀是不够的：URL 解析器会把 /../ 规范化掉，
 * 于是 /../package.json 到这里已经是 /package.json 了；而 /js/../package.json
 * 也会被规范化成 /package.json。所以判断要基于「解析后的绝对路径」，
 * 用 path.relative 看它是否还需要往上走（以 .. 开头就是越界）。
 * 另外 Windows 上反斜杠也是分隔符，path.resolve 会把它当目录分隔处理，
 * 用 relative 判断同样能覆盖 %5C 这种编码绕过。
 */
function resolveStatic(pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel);
  const inside = path.relative(ROOT, file);
  if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return file;
}

function serveStatic(pathname, res) {
  const file = resolveStatic(pathname);

  if (!file) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('403 越界路径');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 找不到 ' + pathname);
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ 路由 */

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || HOST}`);
  } catch (e) {
    return fail(res, 400, '请求地址无法解析');
  }

  // 只支持 GET：这里没有任何写入接口，其余方法一律拒绝
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return fail(res, 405, '只支持 GET');
  }

  const route = url.pathname;
  const handler =
    route === '/api/search' ? handleSearch :
    route === '/api/place' ? handlePlace :
    route === '/api/forecast' ? handleForecast :
    null;

  if (handler) {
    Promise.resolve(handler(url, res)).catch((err) => {
      if (!res.headersSent) fail(res, 500, '服务端异常：' + err.message);
    });
    return;
  }

  if (route.startsWith('/api/')) return fail(res, 404, '没有这个接口');

  let pathname;
  try {
    pathname = decodeURIComponent(route);
  } catch (e) {
    return fail(res, 400, '请求路径无法解码');
  }
  serveStatic(pathname, res);
});

let port = BASE_PORT;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && port - BASE_PORT < 10) {
    console.warn(`端口 ${port} 已被占用，改用 ${port + 1}。`);
    port += 1;
    server.listen(port, HOST);
    return;
  }
  console.error('启动失败：' + err.message);
  process.exit(1);
});

server.listen(port, HOST, () => {
  console.log(`云图 · 天气台已启动：http://${HOST}:${port}/`);
  console.log(`最多收藏 ${MAX_SAVED} 个城市；天气数据缓存 ${CACHE_TTL_MS / 60000} 分钟。`);
  console.log('按 Ctrl+C 停止。');
});
