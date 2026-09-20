/* 流水账 · 本地静态服务器（零依赖）
 * 用法：node server.js [端口]
 *
 * 为什么需要它：PWA 的 Service Worker 和「装到主屏」都要求安全来源。
 * http://localhost 算安全来源，直接双击 index.html（file://）不算，
 * 那时页面照常能用、照样记账，只是离线缓存装不上。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const BASE_PORT = Number(process.argv[2] || process.env.PORT || 5190);
// 显式绑定 127.0.0.1：只占 IPv4，避免和别的服务在 ::1 的同端口互相遮蔽
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.csv': 'text/csv; charset=utf-8'
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel);

  // 不让 ../ 走出去
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('403 越界路径');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 找不到 ' + rel);
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-cache'
    };
    // Service Worker 必须能更新，绝不能被缓存按住
    if (rel === 'sw.js') headers['cache-control'] = 'no-store';
    res.writeHead(200, headers);
    res.end(data);
  });
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
  console.log(`流水账已启动：http://${HOST}:${port}/`);
  console.log('按 Ctrl+C 停止。');
});
