// 오프라인용 서비스 워커. 앱 파일을 바꿔 배포할 때는 VERSION 을 올린다 (안 올리면 기존 캐시가 계속 쓰인다).
const VERSION = 'v4';
const CACHE = `retouch-${VERSION}`;
const FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'adjustments.js',
  'parser.js',
  'renderer.js',
  'imageio.js',
  'icc-p3.js',
  'store.js',
  'dial.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('retouch-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 캐시 우선. 페이지 이동(공유 링크 #p=… 포함)은 index.html 로.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('index.html').then((r) => r || fetch(req)));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((r) => r || fetch(req)));
});
