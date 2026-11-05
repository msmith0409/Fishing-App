// Offline support: the app files are cached on the phone so it opens with no signal.
// Weather requests always go to the network; the app keeps its own copy of the last forecast.
const VERSION = 'v1.1.0-2026-11-05';
const CACHE = `fishing-${VERSION}`;
const SHELL = [
  './', './index.html', './css/app.css', './manifest.webmanifest', './version.txt',
  './js/app.js', './js/db.js', './js/lakes.js', './js/playbook.js', './js/suggest.js',
  './js/stats.js', './js/sun.js', './js/weather.js', './js/geo.js', './js/map.js', './js/attractors.js',
  './vendor/leaflet/leaflet.js', './vendor/leaflet/leaflet.css',
  './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' bypasses the browser's HTTP cache so an update never caches stale files
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

// Map tiles you've looked at are kept (separately from app files, so updates don't wipe them) so the map
// works offline. Only tiles you actually view are stored: no bulk downloading, per the tile providers' rules.
const TILE_CACHE = 'fishing-tiles';
const TILE_HOSTS = ['tile.openstreetmap.org', 'server.arcgisonline.com'];
const TILE_MAX = 4000; // about 60-100 MB at most
const TILE_REFRESH_MS = 30 * 86400000; // re-fetch tiles older than 30 days when online

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== TILE_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

let tilePuts = 0;
async function trimTiles() {
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  if (keys.length > TILE_MAX) await Promise.all(keys.slice(0, keys.length - TILE_MAX).map((k) => cache.delete(k)));
}

async function tile(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req);
  const fresh = hit && Date.now() - Number(hit.headers.get('x-cached-at') || 0) < TILE_REFRESH_MS;
  if (hit && (fresh || !self.navigator.onLine)) return hit;
  try {
    const r = await fetch(req);
    if (r.ok && r.type === 'cors') {
      // stamp when we stored it, so old tiles get refreshed eventually
      const body = await r.clone().blob();
      const h = new Headers(r.headers); h.set('x-cached-at', String(Date.now()));
      await cache.put(req, new Response(body, { status: 200, headers: h }));
      if (++tilePuts % 100 === 0) trimTiles();
    }
    return r;
  } catch (err) {
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'GET' && TILE_HOSTS.includes(url.hostname)) { e.respondWith(tile(e.request)); return; }
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
