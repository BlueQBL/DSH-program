'use strict';

/**
 * 零依赖静态服务：只负责把 todo-app 目录发出去，没有任何接口。
 * 所有数据都存在浏览器 LocalStorage 里，这个服务换成任意静态托管也一样能跑。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 5210);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

// 测试目录不对外提供
const DENY = new Set(['test', 'node_modules', '.git']);

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Bad Request');
  }

  if (pathname === '/') pathname = '/index.html';

  const segments = pathname.split('/').filter(Boolean);
  if (segments.some((s) => DENY.has(s) || s.startsWith('.'))) {
    return send(res, 403, 'Forbidden');
  }

  if (req.method === 'POST' && pathname === '/metrics') {
    // 仅用于无头浏览器验收：把页面量到的布局数据打到 stdout
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 20000) req.destroy();
    });
    req.on('end', () => {
      console.log('METRICS ' + body);
      send(res, 200, 'ok');
    });
    return;
  }

  const target = path.join(ROOT, pathname);
  if (!target.startsWith(ROOT)) return send(res, 403, 'Forbidden');

  fs.readFile(target, (err, data) => {
    if (err) return send(res, 404, 'Not Found');
    send(res, 200, data, MIME[path.extname(target).toLowerCase()] || 'application/octet-stream');
  });
});

if (require.main === module) {
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`端口 ${PORT} 已被占用：换一个端口再试，例如 PORT=5211 node server.js`);
    } else {
      console.error('启动失败：' + err.message);
    }
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log(`案头待办已启动 → http://${HOST}:${PORT}`);
  });
}

module.exports = server;
