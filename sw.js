/* Service worker: pozwala aplikacji działać bez internetu (np. w sklepie bez zasięgu).
   Trzyma kopię plików aplikacji. NIE ma dostępu do Twoich danych i niczego nie wysyła. */
const WERSJA_CACHE = 'budzet-mobile-v1.0.0';
const PLIKI = [
  './', './index.html', './style.css', './app.js', './manifest.webmanifest',
  './lib/qrcode.js', './lib/jsQR.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(WERSJA_CACHE).then((c) => c.addAll(PLIKI)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((klucze) => Promise.all(klucze.filter((k) => k !== WERSJA_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Najpierw kopia lokalna (działa offline), w tle pobranie świeżej wersji na następny raz.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.open(WERSJA_CACHE).then(async (cache) => {
      const zCache = await cache.match(req, { ignoreSearch: true });
      const zSieci = fetch(req).then((odp) => {
        if (odp && odp.ok) cache.put(req, odp.clone());
        return odp;
      }).catch(() => null);
      return zCache || (await zSieci) || new Response('Offline', { status: 503 });
    }),
  );
});
