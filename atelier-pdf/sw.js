// Atelier PDF — fonctionnement hors connexion
// Changez VERSION à chaque mise en ligne d'une nouvelle version.
const VERSION = 'atelier-pdf-1.13.0';
const CORE = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/main.js', 'js/core.js', 'js/ui.js', 'js/docs.js', 'js/viewer.js', 'js/tools.js', 'js/textdetect.js',
  'js/inspector.js', 'js/signature.js', 'js/export.js', 'js/pagesPanel.js', 'js/fontnames.js', 'js/systemfonts.js', 'js/fontmatch.js', 'js/share.js', 'js/tabs.js', 'js/pageimages.js', 'js/pageregions.js', 'js/platform.js', 'js/scanner.js', 'js/scancore.js', 'js/scanworker.js', 'js/ctxbar.js', 'js/inpaint.js', 'js/search.js', 'js/compress.js', 'js/recents.js', 'js/theme.js', 'js/print.js', 'js/updates.js', 'js/formdetect.js', 'js/selectlayer.js', 'js/docfont.js',
  'vendor/fonts/ref/C059-b.ttf', 'vendor/fonts/ref/C059-bi.ttf', 'vendor/fonts/ref/C059-i.ttf', 'vendor/fonts/ref/C059-r.ttf', 'vendor/fonts/ref/Caladea-b.ttf', 'vendor/fonts/ref/Caladea-bi.ttf', 'vendor/fonts/ref/Caladea-i.ttf', 'vendor/fonts/ref/Caladea-r.ttf', 'vendor/fonts/ref/Carlito-b.ttf', 'vendor/fonts/ref/Carlito-bi.ttf', 'vendor/fonts/ref/Carlito-i.ttf', 'vendor/fonts/ref/Carlito-r.ttf', 'vendor/fonts/ref/ComicNeue-b.ttf', 'vendor/fonts/ref/ComicNeue-bi.ttf', 'vendor/fonts/ref/ComicNeue-i.ttf', 'vendor/fonts/ref/ComicNeue-r.ttf', 'vendor/fonts/ref/DejaVuSans-b.ttf', 'vendor/fonts/ref/DejaVuSans-bi.ttf', 'vendor/fonts/ref/DejaVuSans-i.ttf', 'vendor/fonts/ref/DejaVuSans-r.ttf', 'vendor/fonts/ref/DejaVuSansCondensed-b.ttf', 'vendor/fonts/ref/DejaVuSansCondensed-bi.ttf', 'vendor/fonts/ref/DejaVuSansCondensed-i.ttf', 'vendor/fonts/ref/DejaVuSansCondensed-r.ttf', 'vendor/fonts/ref/EBGaramond-b.ttf', 'vendor/fonts/ref/EBGaramond-bi.ttf', 'vendor/fonts/ref/EBGaramond-i.ttf', 'vendor/fonts/ref/EBGaramond-r.ttf', 'vendor/fonts/ref/Gelasio-b.ttf', 'vendor/fonts/ref/Gelasio-bi.ttf', 'vendor/fonts/ref/Gelasio-i.ttf', 'vendor/fonts/ref/Gelasio-r.ttf', 'vendor/fonts/ref/LiberationMono-b.ttf', 'vendor/fonts/ref/LiberationMono-bi.ttf', 'vendor/fonts/ref/LiberationMono-i.ttf', 'vendor/fonts/ref/LiberationMono-r.ttf', 'vendor/fonts/ref/LiberationSans-b.ttf', 'vendor/fonts/ref/LiberationSans-bi.ttf', 'vendor/fonts/ref/LiberationSans-i.ttf', 'vendor/fonts/ref/LiberationSans-r.ttf', 'vendor/fonts/ref/LiberationSerif-b.ttf', 'vendor/fonts/ref/LiberationSerif-bi.ttf', 'vendor/fonts/ref/LiberationSerif-i.ttf', 'vendor/fonts/ref/LiberationSerif-r.ttf', 'vendor/fonts/ref/LibreFranklin-b.ttf', 'vendor/fonts/ref/LibreFranklin-bi.ttf', 'vendor/fonts/ref/LibreFranklin-i.ttf', 'vendor/fonts/ref/LibreFranklin-r.ttf', 'vendor/fonts/ref/Montserrat-b.ttf', 'vendor/fonts/ref/Montserrat-bi.ttf', 'vendor/fonts/ref/Montserrat-i.ttf', 'vendor/fonts/ref/Montserrat-r.ttf', 'vendor/fonts/ref/NimbusSansNarrow-b.ttf', 'vendor/fonts/ref/NimbusSansNarrow-bi.ttf', 'vendor/fonts/ref/NimbusSansNarrow-i.ttf', 'vendor/fonts/ref/NimbusSansNarrow-r.ttf', 'vendor/fonts/ref/OpenSans-b.ttf', 'vendor/fonts/ref/OpenSans-bi.ttf', 'vendor/fonts/ref/OpenSans-i.ttf', 'vendor/fonts/ref/OpenSans-r.ttf', 'vendor/fonts/ref/P052-b.ttf', 'vendor/fonts/ref/P052-bi.ttf', 'vendor/fonts/ref/P052-i.ttf', 'vendor/fonts/ref/P052-r.ttf', 'vendor/fonts/ref/Poppins-b.ttf', 'vendor/fonts/ref/Poppins-bi.ttf', 'vendor/fonts/ref/Poppins-i.ttf', 'vendor/fonts/ref/Poppins-r.ttf', 'vendor/fonts/ref/Raleway-b.ttf', 'vendor/fonts/ref/Raleway-bi.ttf', 'vendor/fonts/ref/Raleway-i.ttf', 'vendor/fonts/ref/Raleway-r.ttf', 'vendor/fonts/ref/Roboto-b.ttf', 'vendor/fonts/ref/Roboto-bi.ttf', 'vendor/fonts/ref/Roboto-i.ttf', 'vendor/fonts/ref/Roboto-r.ttf', 'vendor/fonts/ref/Selawik-b.ttf', 'vendor/fonts/ref/Selawik-bi.ttf', 'vendor/fonts/ref/Selawik-i.ttf', 'vendor/fonts/ref/Selawik-r.ttf', 'vendor/fonts/ref/SourceSans3-b.ttf', 'vendor/fonts/ref/SourceSans3-bi.ttf', 'vendor/fonts/ref/SourceSans3-i.ttf', 'vendor/fonts/ref/SourceSans3-r.ttf', 'vendor/fonts/ref/TeXGyreAdventor-b.ttf', 'vendor/fonts/ref/TeXGyreAdventor-bi.ttf', 'vendor/fonts/ref/TeXGyreAdventor-i.ttf', 'vendor/fonts/ref/TeXGyreAdventor-r.ttf', 'vendor/fonts/ref/URWBookman-b.ttf', 'vendor/fonts/ref/URWBookman-bi.ttf', 'vendor/fonts/ref/URWBookman-i.ttf', 'vendor/fonts/ref/URWBookman-r.ttf', 'js/theme-init.js',
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
