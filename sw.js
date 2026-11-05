// Offline support: the app files are cached on the phone so it opens with no signal.
// Weather requests always go to the network; the app keeps its own copy of the last forecast.
const VERSION = 'v1.0.3-2026-11-04';
const CACHE = `fishing-${VERSION}`;
const SHELL = [
  './', './index.html', './css/app.css', './manifest.webmanifest', './version.txt',
  './js/app.js', './js/db.js', './js/lakes.js', './js/playbook.js', './js/suggest.js',
  './js/stats.js', './js/sun.js', './js/weather.js',
  './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' bypasses the browser's HTTP cache so an update never caches stale files
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || e.request.method !== 'GET') return; // NWS etc: straight to network
  // App files: network first (so updates always apply), but fall back to the cached copy
  // after 3 s or when offline, so the app still opens fast in a dead zone.
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const net = fetch(e.request, { cache: 'no-cache' }).then((r) => { if (r.ok) cache.put(e.request, r.clone()); return r; }).catch(() => null);
    const timeout = new Promise((res) => setTimeout(() => res(null), 3000));
    const first = await Promise.race([net, timeout]);
    if (first) return first;
    const hit = await cache.match(e.request, { ignoreSearch: true }) || (e.request.mode === 'navigate' ? await cache.match('./index.html') : null);
    if (hit) { e.waitUntil(net); return hit; }
    return (await net) || Response.error();
  }));
});
