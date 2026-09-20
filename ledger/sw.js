/* 流水账 · Service Worker
   把应用外壳缓存下来，断网也能打开、也能记账。
   数据本来就在 localStorage 里，跟这个缓存无关，清缓存不会丢账。 */

var VERSION = 'ledger-v1';
var SHELL = [
  './',
  'index.html',
  'styles.css',
  'store.js',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (cache) {
      // 单个文件 404 不该让整次安装失败，逐个加
      return Promise.all(SHELL.map(function (url) {
        return cache.add(new Request(url, { cache: 'reload' })).catch(function () { /* 缺就缺 */ });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === VERSION ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;

  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  // 页面导航：先走网络拿最新的，断网就回缓存的首页
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(VERSION).then(function (c) { c.put('index.html', copy); });
        return res;
      }).catch(function () {
        return caches.match('index.html').then(function (hit) {
          return hit || caches.match('./');
        });
      })
    );
    return;
  }

  // 静态资源：先给缓存（秒开），后台悄悄更新下一次的版本
  e.respondWith(
    caches.match(req).then(function (hit) {
      var fresh = fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(VERSION).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || fresh;
    })
  );
});

self.addEventListener('message', function (e) {
  if (e.data === 'skip-waiting') self.skipWaiting();
});
