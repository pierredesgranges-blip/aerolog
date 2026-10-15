/* AeroLog — service worker : coquille hors-ligne, cache des données consultées, partage de fichiers Android */
const VERSION = 'aerolog-1.2.0';
const SHELL = ['/', '/index.html', '/app.js', '/style.css', '/favicon.svg', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/vendor/maplibre/maplibre-gl.js', '/vendor/maplibre/maplibre-gl.css'];
const SHARE_CACHE = 'aerolog-share';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== SHARE_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Fichier KML/CSV partagé depuis une autre app Android (Web Share Target)
async function handleShare(request) {
  const form = await request.formData();
  const file = form.getAll('track').find(f => f && typeof f === 'object' && f.size);
  if (file) {
    const cache = await caches.open(SHARE_CACHE);
    await cache.put('/shared-track', new Response(file, { headers: { 'X-Filename': encodeURIComponent(file.name || 'trace.kml') } }));
  }
  return Response.redirect('/?share=1#/new', 303);
}

// Réseau d'abord (données toujours fraîches), cache en secours hors connexion
async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(request);
    if (res.ok && request.method === 'GET') cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (hit) return hit;
    if (request.mode === 'navigate') return cache.match('/index.html');
    throw err;
  }
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // tuiles et logos : laissés au navigateur
  if (url.pathname === '/share-target' && e.request.method === 'POST') { e.respondWith(handleShare(e.request)); return; }
  if (e.request.method !== 'GET') return;
  // Exports et fichiers lourds : jamais mis en cache
  if (/^\/api\/(export|track)/.test(url.pathname)) return;
  e.respondWith(networkFirst(e.request));
});
