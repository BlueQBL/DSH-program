/**
 * 个人作品集 · 静态服务器
 *
 * 这个站点是纯静态的：直接双击 index.html 也能看，
 * 只有两件事需要 http 来源 ——
 *   1. ES 模块之外的普通脚本其实不需要，但剪贴板 API（复制邮箱）在 file:// 下会被浏览器拒绝；
 *   2. 手机在同一局域网里打不开 file://，用这个服务器就能直接扫码看。
 *
 * 零依赖，只用 Node 内置模块。
 *   node server.js             → http://localhost:5200
 *   node server.js 8080        → 换端口
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const url = require('node:url');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 5200);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-cache', ...headers });
  res.end(body);
}

/** 请求处理器 */
async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.parse(req.url).pathname || '/');
  } catch {
    return send(res, 400, 'Bad Request');
  }

  if (pathname.endsWith('/')) pathname += 'index.html';

  // 目录穿越防护：解析后必须仍在 ROOT 内
  const filePath = path.resolve(ROOT, '.' + pathname);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    return send(res, 403, 'Forbidden');
  }

  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      return send(res, 301, '', { Location: pathname + '/' });
    }

    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });

    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      return send(res, 404, '404 Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    console.error('[portfolio] 读取失败:', filePath, err.message);
    return send(res, 500, 'Internal Server Error', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
}

/** 供冒烟测试等复用：拿到一个还没 listen 的服务器 */
function createServer() {
  return http.createServer(handler);
}

module.exports = { createServer, handler, MIME, ROOT };

// 直接 `node server.js` 时才真的监听端口
if (require.main === module) {
  const portArg = Number(process.argv[2]);
  const port = Number.isFinite(portArg) && portArg > 0 ? portArg : PORT;

  createServer()
    .listen(port, HOST, () => {
      console.log(`个人作品集已启动：http://localhost:${port}/`);
      console.log('（Ctrl+C 停止）');
    })
    .on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`端口 ${port} 已被占用，换一个：node server.js 5201`);
      } else {
        console.error('启动失败:', err.message);
      }
      process.exit(1);
    });
}
