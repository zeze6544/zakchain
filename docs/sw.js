// ZAK Miner offline service worker. Only caches ZAK Miner's own files, same-origin GET requests only.
// It never hashes anything and never starts mining: mining still only runs after the player presses Start.
const CACHE = 'zakminer-site-v1';
const PAGE = 'play.html';
const ASSETS = ["play.html", "style.css", "play.css", "favicon.svg", "js/game.js", "js/miner-worker.js", "js/sha256.js", "manifest.webmanifest", "icons/zakminer-192.png", "icons/zakminer-512.png", "icons/zakminer-maskable-512.png", "icons/apple-touch-icon.png"];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('zakminer-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;           // leave other sites alone
  if (r.mode === 'navigate') {                                              // page: network first, cached copy offline
    e.respondWith(fetch(r).then(res => { if (res.ok) { const c = res.clone(); caches.open(CACHE).then(k => k.put(PAGE, c)); } return res; })
      .catch(() => caches.match(PAGE, { ignoreSearch: true })));
    return;
  }
  e.respondWith(caches.match(r, { ignoreSearch: true }).then(hit => {     // assets: cache first, refresh in background
    const net = fetch(r).then(res => { if (res.ok) { const c = res.clone(); caches.open(CACHE).then(k => k.put(r, c)); } return res; }).catch(() => hit);
    return hit || net;
  }));
});
