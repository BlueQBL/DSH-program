/* 校样 · 本地静态服务器（零依赖）
 * 用法：node server.js [端口]
 * 说明：整个应用是纯静态的，直接双击 index.html 也能用；
 *      但用 http:// 打开更稳妥——剪贴板 API、LocalStorage 在某些
 *      浏览器里对 file:// 有额外限制。默认端口 5220（仓库里各项目端口不重样）。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const BASE_PORT = Number(process.argv[2] || process.env.PORT || 5220);
// 显式绑定 127.0.0.1：只占 IPv4，避免与别的服务在 ::1 上同端口互相遮蔽
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
};

const MOUNT = '/__probe-report/';
const REPORT_LIMIT = 4 * 1024 * 1024;

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);

  /* 开发用：探针把报告 POST 到这里，落成 .screens/<名字>.json。
     为什么不走 localStorage：探针跑完是被 kill 掉的，Chrome 还没把
     localStorage 刷到磁盘，报告就丢了（踩过这个坑，白白怀疑了半天自己的代码）。 */
  if (url.indexOf(MOUNT) === 0) {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('只接受 POST');
      return;
    }
    const name = url.slice(MOUNT.length).replace(/[^\w.-]/g, '') || 'report';
    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) return;
      body += chunk;
      if (body.length > REPORT_LIMIT) {
        tooBig = true;
        res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('报告太大了');
      }
    });
    req.on('end', () => {
      if (tooBig) return;
      const dir = path.join(ROOT, '.screens');
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, name + '.json'), body, 'utf8');
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('写不进报告：' + err.message);
        return;
      }
      res.writeHead(204).end();
    });
    return;
  }

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
  console.log(`校样已启动：http://${HOST}:${port}/`);
  console.log('按 Ctrl+C 停止。');
});
