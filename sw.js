/* ============================================================
 * sw.js — Service Worker
 * ホーム画面に追加したあと、通信が無くても起動できるようにする。
 *
 * ★ JS/CSS/HTML を更新したら、下の VERSION を必ず上げること。
 *   上げないと、すでに追加した人の端末で古いファイルが使われ続ける。
 *   （index.html の ?v= と合わせて上げる運用にしている）
 * ============================================================ */
var VERSION = 'vbt-17';
var CACHE = 'vbt-cache-' + VERSION;

/* クエリ（?v=）を外した素のURLで持っておき、
 * 取り出すときに ignoreSearch で拾う。番号を変えても取りこぼさない。 */
var ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/kinematics.js',
  'js/tracker.js',
  'js/charts.js',
  'js/storage.js',
  'js/app.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-180.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // cache:'reload' でブラウザのHTTPキャッシュを迂回し、必ず新しい実体を取る
      return Promise.all(ASSETS.map(function (url) {
        return fetch(new Request(url, { cache: 'reload' }))
          .then(function (res) { if (res.ok) return cache.put(url, res); })
          .catch(function () { /* 1つ失敗しても導入は続ける */ });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;

  // 画面遷移はネットワーク優先。つながらないときだけキャッシュのindexを返す。
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put('index.html', copy); });
        return res;
      }).catch(function () {
        return caches.match('index.html', { ignoreSearch: true });
      })
    );
    return;
  }

  // それ以外はキャッシュ優先。無ければ取りに行き、取れたら次回のために保存する。
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      });
    })
  );
});
