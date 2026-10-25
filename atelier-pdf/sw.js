// Atelier PDF — fonctionnement hors connexion
// Changez VERSION à chaque mise en ligne d'une nouvelle version.
const VERSION = 'atelier-pdf-1.6.2';
const CORE = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/main.js', 'js/core.js', 'js/ui.js', 'js/docs.js', 'js/viewer.js', 'js/tools.js', 'js/textdetect.js',
  'js/inspector.js', 'js/signature.js', 'js/export.js', 'js/pagesPanel.js', 'js/fontnames.js', 'js/systemfonts.js', 'js/fontmatch.js', 'js/share.js', 'js/tabs.js', 'js/pageimages.js', 'js/pageregions.js', 'js/platform.js', 'js/scanner.js', 'js/scancore.js', 'js/scanworker.js', 'js/ctxbar.js', 'js/inpaint.js',
  'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs',
  'vendor/pdf-lib.min.js', 'vendor/fontkit.umd.min.js', 'vendor/jszip.min.js', 'vendor/Sortable.min.js',
  'fonts/atkinson-hyperlegible-latin-400-normal.woff2', 'fonts/atkinson-hyperlegible-latin-700-normal.woff2',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.open(VERSION).then(async cache => {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone()); // polices pdf.js, moteur de lecture (OCR)… mis en cache à la première utilisation
      return res;
    } catch (err) {
      if (req.mode === 'navigate') return cache.match('index.html');
      throw err;
    }
  }));
});
