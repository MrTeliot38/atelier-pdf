// Copie l'application web dans ./app et prépare le lecteur de polices pour le processus principal
const fs = require('fs'), path = require('path');
const SRC = path.resolve(__dirname, '..', 'atelier-pdf'), DST = path.join(__dirname, 'app');
fs.rmSync(DST, { recursive: true, force: true });
const skip = new Set(['lancer-en-local.bat', 'LISEZ-MOI.md', 'sw.js', 'manifest.webmanifest']);
(function copy(s, d) {
  fs.mkdirSync(d, { recursive: true });
  for (const e of fs.readdirSync(s, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const a = path.join(s, e.name), b = path.join(d, e.name);
    e.isDirectory() ? copy(a, b) : fs.copyFileSync(a, b);
  }
})(SRC, DST);
const esm = fs.readFileSync(path.join(SRC, 'js', 'fontnames.js'), 'utf8');
const cjs = esm.replace(/^export (function|const) /gm, '$1 ') + '\nmodule.exports = { readFontFaces, facesFromBytes, extractFromCollection };\n';
fs.writeFileSync(path.join(__dirname, 'fontnames.cjs'), cjs);
console.log('Application copiée dans', DST);
