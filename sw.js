// Cache-first service worker so the app opens with no signal — which is where
// you tend to be when working on a scooter.

const CACHE = 'scoot-unlock-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './profiles/mi4lite-gen2.json',
  './profiles/m365.json',
  './src/util.js',
  './src/ble/transport.js',
  './src/ble/mock-esc.js',
  './src/proto/aes.js',
  './src/proto/frame.js',
  './src/proto/registers.js',
  './src/proto/session.js',
  './src/core/scooter.js',
  './src/core/discovery.js',
  './src/core/tuning.js',
  './src/ui/app.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((hit) => hit ?? fetch(event.request))
  );
});
