/* 水尺 · 本地静态服务器（零依赖）
 * 用法：node server.js [端口]
 * 说明：桌面通知需要安全来源，http://localhost 满足条件；
 *      直接双击 index.html 打开时（file://）通知可能不可用，
 *      页面横幅、提示音与标题提醒仍然有效。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const BASE_PORT = Number(process.argv[2] || process.env.PORT || 5180);
// 显式绑定 127.0.0.1：只占用 IPv4，避免与别的服务在 ::1 上的同端口监听互相遮蔽
const HOST = process.env.HOST || '127.0.0.1';

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

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel);

  if (!file.startsWith(ROOT)) {
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
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
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
  console.log(`水尺已启动：http://${HOST}:${port}/`);
  console.log('按 Ctrl+C 停止。');
});
