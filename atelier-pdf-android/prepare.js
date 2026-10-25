// Copie l'application web (dossier voisin « atelier-pdf ») dans « www », le dossier embarqué dans l'APK.
const fs = require('fs'), path = require('path');
const SRC = path.join(__dirname, '..', 'atelier-pdf');
const DST = path.join(__dirname, 'www');
const SKIP = new Set(['LISEZ-MOI.md', 'lancer-en-local.bat', 'sw.js']);
fs.rmSync(DST, { recursive: true, force: true });
(function copy(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copy(s, d); else fs.copyFileSync(s, d);
  }
})(SRC, DST);
console.log('Application web copiée dans www/');
