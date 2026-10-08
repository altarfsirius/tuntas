// Service Worker for Tuntas PWA (Multi-device offline shell & caching)
const CACHE_NAME = 'tuntas-cache-v1';
const SHELL_ASSETS = [
  './',
  'index.html',
  'manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(SHELL_ASSETS).catch((err) => {
        console.debug('ServiceWorker cache addAll error:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Always use network directly for Supabase DB/Auth/Functions and external live APIs
  if (
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('aladhan.com') ||
    url.hostname.includes('apiindonesia.id') ||
    url.hostname.includes('frankfurter.dev') ||
    url.hostname.includes('coinmarketcap.com') ||
    url.hostname.includes('gnews.io') ||
    url.hostname.includes('tradingeconomics.com') ||
    url.hostname.includes('tradingview.com') ||
    url.hostname.includes('office365.com') ||
    event.request.method !== 'GET'
  ) {
    return;
  }

  // Cache-first with network fallback for static fonts & CDN libraries
  if (
    url.hostname.includes('cdn.jsdelivr.net') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com')
  ) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) return cachedResponse;
        return fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        });
      })
    );
    return;
  }

  // Stale-while-revalidate for local HTML/manifest app shell
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return networkResponse;
      }).catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});
