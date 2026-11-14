// Reconnaissance visuelle de la police d'un texte (scan, photo, ou police absente de l'appareil).
// Principe : on découpe l'image de plusieurs mots du texte, puis on redessine chacun de ces mots avec
// chaque police candidate, dans ses quatre styles (normal, gras, italique, gras italique). On compare
// les proportions, la forme des lettres et l'épaisseur des traits ; la police qui ressemble le plus,
// sur l'ensemble des mots, l'emporte.
// Candidates : les polices fournies avec l'application (même résultat sur Windows, Android et dans le
// navigateur), les polices importées, et toutes les polices installées sur l'ordinateur.
// Pour aller vite avec plusieurs centaines de polices, on calcule d'abord, sans rien dessiner, les
// proportions de chaque mot dans chaque police : c'est un plafond du score final. Les polices sont ensuite
// comparées en détail de la plus prometteuse à la moins prometteuse, et la recherche s'arrête dès
// qu'aucune des suivantes ne peut plus l'emporter. Aucune police n'est écartée au hasard.
import { state, on, pdfjsLib, clamp, registerFontFamily } from './core.js';
import { listSystemFonts, systemFontsSupported, systemFontsGranted, loadSystemFamily, familyVariantBytes, isDesktop } from './systemfonts.js';

/**
 * Familles fournies avec l'application (sous-ensembles latins, licences libres) :
 *  - équivalents libres des polices de Windows et d'Office (affichés « Équivalent (≈ Police) ») ;
 *  - polices libres très répandues dans les documents (exact : c'est la police elle-même).
 * Si la vraie police (name ou aka) est installée sur l'ordinateur, c'est elle qui est utilisée.
 */
export const REF = [
  { name: 'Arial', file: 'LiberationSans', std: 'helvetica', clone: 'Liberation Sans', aka: ['Helvetica'] },
  { name: 'Times New Roman', file: 'LiberationSerif', std: 'times', clone: 'Liberation Serif', aka: ['Times'] },
  { name: 'Courier New', file: 'LiberationMono', std: 'courier', clone: 'Liberation Mono', aka: ['Courier'] },
  { name: 'Verdana', file: 'DejaVuSans', clone: 'DejaVu Sans' },
  { name: 'Tahoma', file: 'DejaVuSansCondensed', clone: 'DejaVu Sans Condensed' },
  { name: 'Calibri', file: 'Carlito', clone: 'Carlito' },
  { name: 'Cambria', file: 'Caladea', clone: 'Caladea' },
  { name: 'Georgia', file: 'Gelasio', clone: 'Gelasio' },
  { name: 'Segoe UI', file: 'Selawik', clone: 'Selawik' },
  { name: 'Century Gothic', file: 'TeXGyreAdventor', clone: 'TeX Gyre Adventor' },
  { name: 'Garamond', file: 'EBGaramond', clone: 'EB Garamond' },
  { name: 'Palatino Linotype', file: 'P052', clone: 'P052', aka: ['Book Antiqua', 'Palatino'] },
  { name: 'Bookman Old Style', file: 'URWBookman', clone: 'URW Bookman' },
  { name: 'Century Schoolbook', file: 'C059', clone: 'C059' },
  { name: 'Arial Narrow', file: 'NimbusSansNarrow', clone: 'Nimbus Sans Narrow' },
  { name: 'Comic Sans MS', file: 'ComicNeue', clone: 'Comic Neue' },
  { name: 'Franklin Gothic Book', file: 'LibreFranklin', clone: 'Libre Franklin', aka: ['Franklin Gothic Medium'] },
  { name: 'Open Sans', file: 'OpenSans', exact: true },
  { name: 'Roboto', file: 'Roboto', exact: true },
  { name: 'Montserrat', file: 'Montserrat', exact: true },
  { name: 'Source Sans 3', file: 'SourceSans3', exact: true, aka: ['Source Sans Pro'] },
  { name: 'Poppins', file: 'Poppins', exact: true },
  { name: 'Raleway', file: 'Raleway', exact: true },
];
const VARIANTS = [['r', 400, 'normal'], ['b', 700, 'normal'], ['i', 400, 'italic'], ['bi', 700, 'italic']];
const refFamily = f => 'APref ' + f.file;
const refUrl = (f, vk) => new URL(`../vendor/fonts/ref/${f.file}-${vk}.ttf`, import.meta.url).href;
/** Nom affiché pour la police fournie : « Selawik (≈ Segoe UI) », ou le nom exact pour une police libre. */
export const refLabel = f => f.exact ? f.name : `${f.clone} (≈ ${f.name})`;
const refNames = f => [f.name, f.clone, ...(f.aka || [])].filter(Boolean).map(n => n.toLowerCase());
const REF_NAMES = new Set(REF.flatMap(refNames));

// polices de symboles, d'icônes ou d'écritures non latines : inutile de les essayer
const SKIP = /^ipa|^noto sans (cjk|mono cjk)|^wenquanyi|^droid sans fallback|symbol|wingdings|webdings|marlett|dings|emoji|mdl2|fluent|holomdl|ornament|bookshelf|outlook|mt extra|specialty|icons?$|barcode|code ?39|code ?128|cjk|gothic medium|mincho|ming|kai|song|hei|yahei|jhenghei|malgun|gulim|batang|dotum|meiryo|yu |nirmala|mangal|gautami|kartika|latha|raavi|shruti|tunga|vrinda|kalinga|leelawadee|iskoola|gadugi|ebrima|mongolian|myanmar|javanese|sinhala|tibetan|khmer|lao |thai|hebrew|arabic|urdu|devanagari|bengali|tamil|telugu|kannada|malayalam|gujarati|gurmukhi|ethiopic|georgian|armenian/i;

/* ---------- chargement des polices de référence (une fois) ---------- */
let refReady = null;
export function loadRefFonts() {
  if (!refReady) refReady = Promise.all(REF.flatMap(f => VARIANTS.map(async ([vk, weight, style]) => {
    const face = new FontFace(refFamily(f), `url("${refUrl(f, vk)}")`, { weight: String(weight), style });
    await face.load(); document.fonts.add(face);
  }))).catch(e => { refReady = null; throw e; });
  return refReady;
}

/* ---------- disponibilité réelle d'une police installée ---------- */
const probeCtx = document.createElement('canvas').getContext('2d');
const PROBE = 'mmmmmmmmmlliWwQqÉéàç0123';
const fallbackW = {};
for (const fb of ['monospace', 'serif', 'sans-serif']) { probeCtx.font = `40px ${fb}`; fallbackW[fb] = probeCtx.measureText(PROBE).width; }
const available = name => ['monospace', 'serif', 'sans-serif'].some(fb => { probeCtx.font = `40px "${name}", ${fb}`; return probeCtx.measureText(PROBE).width !== fallbackW[fb]; });

/** Polices de l'ordinateur (Windows, Chrome) : celles que l'affichage connaît par leur nom, et les autres
 *  (polices « cloud » d'Office comme Aptos) chargées depuis leurs fichiers. */
const MAX_BYTE_FAMILIES = 120;
let sysCache = null, sysLoading = null;
function systemCandidates() {
  if (sysCache) return Promise.resolve(sysCache);
  if (!sysLoading) sysLoading = (async () => {
    const out = [];
    if (systemFontsSupported() && await systemFontsGranted()) {
      try {
        const byBytes = [];
        for (const f of await listSystemFonts()) {
          if (SKIP.test(f.name) || REF_NAMES.has(f.name.toLowerCase())) continue;
          const bold = f.faces.some(x => !x.italic && x.weight >= 600), italic = f.faces.some(x => x.italic);
          const styles = VARIANTS.filter(([vk]) => vk === 'r' || (vk === 'b' && bold) || (vk === 'i' && italic) || (vk === 'bi' && bold && italic));
          if (available(f.name)) out.push({ name: f.name, css: f.name, styles, kind: 'sys' });
          else if (isDesktop() && byBytes.length < MAX_BYTE_FAMILIES) byBytes.push(f);
        }
        for (let i = 0; i < byBytes.length; i += 8) {
          await Promise.all(byBytes.slice(i, i + 8).map(async f => {
            const css = 'APsys ' + f.name, styles = [];
            for (const [vk, bytes] of Object.entries(await familyVariantBytes(f))) {
              const [, weight, style] = VARIANTS.find(v => v[0] === vk);
              try { const face = new FontFace(css, bytes, { weight: String(weight), style }); await face.load(); document.fonts.add(face); styles.push(VARIANTS.find(v => v[0] === vk)); } catch { /* police illisible */ }
            }
            if (styles.length) out.push({ name: f.name, css, styles, kind: 'sys' });
          }));
        }
      } catch (e) { console.warn('Polices de l\'ordinateur', e); }
    }
    sysCache = out;
    return out;
  })().finally(() => { sysLoading = null; });
  return sysLoading;
}

/** Toutes les candidates : polices fournies, polices importées, polices de l'ordinateur. */
let lastPool = 0;
async function candidates() {
  const list = REF.map(f => ({ name: f.name, std: f.std, ref: f, css: refFamily(f), styles: VARIANTS, kind: 'ref' }));
  for (const f of state.fonts.values()) {
    if (f.source !== 'import' || REF_NAMES.has(f.name.toLowerCase())) continue;
    const styles = VARIANTS.filter(([vk]) => f.variants[vk]);
    if (styles.length) list.push({ name: f.name, css: f.family, fontId: f.id, styles, kind: 'import' });
  }
  const all = list.concat(await systemCandidates());
  lastPool = all.length;
  return all;
}
// préparation en arrière-plan dès qu'un outil d'écriture est choisi : la première reconnaissance est plus rapide
on('tool', () => {
  if (state.tool !== 'edit' && state.tool !== 'fill') return;
  setTimeout(() => { loadRefFonts().catch(() => {}); systemCandidates().catch(() => {}); }, 400);
});

/** Nombre de polices comparées lors de la dernière reconnaissance. */
export const comparedFontCount = () => lastPool;

/* ---------- image d'une zone de la page ---------- */
async function cropRaster(page, rect, scale) {
  const W = Math.max(2, Math.ceil(rect.w * scale)), H = Math.max(2, Math.ceil(rect.h * scale));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  if (page.src) {
    const pdfPage = await state.sources.get(page.src).pdf.getPage(page.index + 1);
    const vp = pdfPage.getViewport({ scale, offsetX: -rect.x * scale, offsetY: -rect.y * scale });
    await pdfPage.render({ canvas: c, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS }).promise;
  } else {
    for (const o of page.objects) {
      if (o.type !== 'image') continue;
      const a = state.assets.get(o.asset); if (!a) continue;
      const img = new Image(); img.src = a.dataUrl; await img.decode();
      ctx.drawImage(img, (o.x - rect.x) * scale, (o.y - rect.y) * scale, o.w * scale, o.h * scale);
    }
  }
  return c;
}

/** Masque d'encre (noir sur blanc) recadré au plus juste ; ignore les petites taches isolées sur les bords. */
function inkMask(canvas) {
  const W = canvas.width, H = canvas.height;
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const lum = new Float32Array(W * H), hist = new Uint32Array(256);
  for (let i = 0; i < W * H; i++) { const l = 0.3 * d[i * 4] + 0.59 * d[i * 4 + 1] + 0.11 * d[i * 4 + 2]; lum[i] = l; hist[l | 0]++; }
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue; const wF = W * H - wB; if (!wF) break;
    sumB += i * hist[i]; const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; t = i; }
  }
  let edgeDark = 0, edgeN = 0;
  for (let x = 0; x < W; x++) for (const y of [0, H - 1]) { edgeN++; if (lum[y * W + x] < t) edgeDark++; }
  const darkInk = edgeDark < edgeN / 2;
  const ink = new Uint8Array(W * H);
  const colN = new Uint32Array(W), rowN = new Uint32Array(H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (darkInk ? lum[i] < t : lum[i] > t) { ink[i] = 1; colN[x]++; rowN[y]++; }
  }
  // cadrage : on écarte les lignes et colonnes de bord presque vides (poussières, bout de lettre voisine)
  const minC = Math.max(1, H * 0.04), minR = Math.max(1, W * 0.01);
  let x0 = 0, x1 = W - 1, y0 = 0, y1 = H - 1;
  while (x0 < W && colN[x0] < minC) x0++;
  while (x1 > x0 && colN[x1] < minC) x1--;
  while (y0 < H && rowN[y0] < minR) y0++;
  while (y1 > y0 && rowN[y1] < minR) y1--;
  if (x1 - x0 < 4 || y1 - y0 < 3) return null;
  const out = document.createElement('canvas'); out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  const o = out.getContext('2d'); const img = o.createImageData(out.width, out.height);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const v = ink[y * W + x] ? 0 : 255, j = ((y - y0) * out.width + (x - x0)) * 4;
    img.data[j] = img.data[j + 1] = img.data[j + 2] = v; img.data[j + 3] = 255;
  }
  o.putImageData(img, 0, 0);
  return out;
}

/* ---------- comparaison ---------- */
const GH = 32; // hauteur de comparaison (pixels)
const gridCanvas = document.createElement('canvas');
function grid(src, sx, sy, sw, sh, W, H) {
  gridCanvas.width = W; gridCanvas.height = H;
  const g = gridCanvas.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(src, sx, sy, sw, sh, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data, out = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = 1 - d[i * 4] / 255;
  return out;
}
/** Flou léger (boîte 3×3) : tolère un décalage d'un pixel entre le scan et le dessin. */
function blur(a, W, H) {
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= H) continue; for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= W) continue; s += a[yy * W + xx]; n++; } }
    out[y * W + x] = s / n;
  }
  return out;
}
/** Corrélation normalisée (−1…1). */
function ncc(a, b) {
  const n = a.length; let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}
const inkSum = a => { let s = 0; for (const v of a) s += v; return s; };

const renderCanvas = document.createElement('canvas');
renderCanvas.width = 1200; renderCanvas.height = 160;
/** Dessine un texte et renvoie sa boîte d'encre (pour la comparer au scan). */
function renderInk(text, css) {
  const ctx = renderCanvas.getContext('2d', { willReadFrequently: true });
  ctx.font = css;
  const m = ctx.measureText(text);
  const left = m.actualBoundingBoxLeft, right = m.actualBoundingBoxRight, asc = m.actualBoundingBoxAscent, desc = m.actualBoundingBoxDescent;
  const w = Math.ceil(left + right) + 4, hh = Math.ceil(asc + desc) + 4;
  if (w < 6 || hh < 6) return null;
  // la toile ne fait que grandir : la redimensionner à chaque mot coûte cher
  if (w > renderCanvas.width || hh > renderCanvas.height) { renderCanvas.width = Math.max(w, renderCanvas.width); renderCanvas.height = Math.max(hh, renderCanvas.height); }
  ctx.font = css; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, hh);
  ctx.fillStyle = '#000'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, left + 2, asc + 2);
  return { canvas: renderCanvas, sx: 2, sy: 2, sw: Math.max(1, left + right), sh: Math.max(1, asc + desc), aspect: (left + right) / Math.max(1, asc + desc) };
}

/* ---------- échantillons : mots bien lus ---------- */
const CLEAN = /^[\p{L}\p{N}'’.,;:!?()«»"\/&@-]+$/u;
function pickSamples(block) {
  const out = [];
  const words = [];
  for (const line of block.lines) for (const w of line.words || []) {
    const t = (w.text || '').trim();
    const signs = (t.match(/[\p{L}\p{N}]/gu) || []).length;
    if (!CLEAN.test(t) || signs < 2 || (w.conf ?? 100) < 55) continue;
    words.push({ text: t, rect: { x: w.x0 - 0.8, y: w.y0 - 0.8, w: w.x1 - w.x0 + 1.6, h: w.y1 - w.y0 + 1.6 }, size: line.size, n: signs });
  }
  // les mots les plus longs d'abord (plus de lettres = comparaison plus sûre), sans doublons
  const seen = new Set();
  for (const w of words.sort((a, b) => b.n - a.n)) {
    if (seen.has(w.text)) continue; seen.add(w.text);
    out.push(w); if (out.length >= 8) break;
  }
  // peu de mots (date, numéro) ou texte natif : la ligne la plus longue en entier
  if (out.length < 3) {
    const line = [...block.lines].sort((a, b) => b.text.length - a.text.length)[0];
    let text = line.text.trim(), w = line.w;
    if (text.length > 50) { const cut = text.lastIndexOf(' ', 50) > 20 ? text.lastIndexOf(' ', 50) : 50; w = line.w * cut / text.length; text = text.slice(0, cut); }
    if (text.replace(/\s/g, '').length >= 3) out.push({ text, rect: { x: line.x - 1, y: line.top - 1, w: w + 2, h: line.bottom - line.top + 2 }, size: line.size, n: text.length, approx: !line.words?.length });
  }
  return out;
}

const cache = new Map();

/**
 * Renvoie les polices les plus proches, de la meilleure à la moins bonne :
 * [{ name, std?, ref?, fontId?, css, kind, bold, italic, score }]  (score entre 0 et 1)
 */
export async function guessFont(page, block, { budgetMs = 2500 } = {}) {
  const imported = [...state.fonts.values()].filter(f => f.source === 'import').length;
  const key = (page.src ? page.src + '|' + page.index : page.id) + '|' + Math.round(block.x) + ',' + Math.round(block.top) + ',' + Math.round(block.w) + '|' + imported;
  if (cache.has(key)) return cache.get(key);
  try { await loadRefFonts(); } catch (e) { console.warn('Polices de référence indisponibles', e); }
  // images des mots, prêtes à comparer
  const refs = [];
  for (const s of pickSamples(block)) {
    const scale = clamp(56 / Math.max(s.rect.h, 3), 2, 10);
    const scan = inkMask(await cropRaster(page, s.rect, scale));
    if (!scan) continue;
    const aspect = scan.width / scan.height, W = clamp(Math.round(GH * aspect), 6, 700);
    const g = grid(scan, 0, 0, scan.width, scan.height, W, GH);
    refs.push({ text: s.text, aspect, W, g: blur(g, W, GH), ink: inkSum(g), weight: Math.sqrt(s.n), approx: s.approx, k: s.approx ? 2.5 : 3.5 });
  }
  if (!refs.length) return [];
  const t0 = performance.now();
  const cands = await candidates();
  const wsum = refs.reduce((t, r) => t + r.weight, 0);
  // peu de lettres (une date, un numéro) : beaucoup de polices se ressemblent, une police de l'ordinateur
  // doit alors ressembler nettement plus que les polices courantes pour l'emporter
  const letters = refs.reduce((t, r) => t + (r.text.match(/\p{L}/gu) || []).length, 0);
  const margin = letters >= 20 ? 0.03 : 0.06;

  // 1) plafond de chaque police et style : les proportions des mots, sans rien dessiner
  //    (le score final multiplie ce facteur de proportions par la forme et l'épaisseur, toutes deux ≤ 1)
  const ctx = renderCanvas.getContext('2d', { willReadFrequently: true });
  const vars = [];
  let tick = performance.now();
  for (const c of cands) {
    for (const [vk, weight, style] of c.styles) {
      const css = `${style} ${weight} 72px "${c.css}", sans-serif`;
      ctx.font = css;
      let ub = 0;
      const ubs = refs.map(r => {
        const m = ctx.measureText(r.text);
        const lr = Math.abs(Math.log(((m.actualBoundingBoxLeft + m.actualBoundingBoxRight) / Math.max(1, m.actualBoundingBoxAscent + m.actualBoundingBoxDescent)) / r.aspect));
        const u = lr < 0.45 ? Math.exp(-r.k * lr) * r.weight : 0;
        ub += u; return u;
      });
      if (ub > 0) vars.push({ c, vk, css, ub: ub / wsum, ubs });
    }
    if (performance.now() - tick > 40) { await new Promise(r => setTimeout(r, 0)); tick = performance.now(); }
  }
  vars.sort((a, b) => b.ub - a.ub);

  // 2) comparaison détaillée, de la plus prometteuse à la moins prometteuse.
  //    Une police fournie ou importée ne compte que si elle approche la meilleure d'entre elles ;
  //    une police de l'ordinateur, que si elle les dépasse nettement (voir plus bas).
  const results = [];
  let bestRef = 0, bestSys = 0, partial = false;
  const need = kind => kind === 'sys' ? Math.max(bestSys, bestRef + margin) : bestRef - 0.015;
  const MIN = 12; // toujours comparées en entier : de quoi proposer d'autres polices ressemblantes
  for (const [i, v] of vars.entries()) {
    const full = i < MIN;
    if (!full && v.ub < bestRef - 0.015) break;            // plus aucune ne peut compter
    if (!full && v.ub < need(v.c.kind)) continue;
    if (performance.now() - tick > 30) {
      await new Promise(r => setTimeout(r, 0)); tick = performance.now();
      if (!full && tick - t0 > budgetMs) { partial = true; break; }
    }
    let tot = 0, rest = v.ub * wsum, dropped = false;
    for (const [j, r] of refs.entries()) {
      rest -= v.ubs[j];
      if (v.ubs[j]) {
        const ren = renderInk(r.text, v.css);
        if (ren) {
          const lr = Math.abs(Math.log(ren.aspect / r.aspect));
          const g = grid(ren.canvas, ren.sx, ren.sy, ren.sw, ren.sh, r.W, GH);
          const shape = Math.max(0, ncc(blur(g, r.W, GH), r.g));
          // le scan épaissit les traits (encre, flou, seuillage) : seul un écart net d'épaisseur est pénalisé
          const li = Math.log(inkSum(g) / Math.max(1, r.ink));
          const thick = Math.exp(-2.2 * Math.max(0, Math.abs(li + 0.1) - 0.15));
          tot += shape * Math.exp(-r.k * lr) * thick * r.weight;
        }
      }
      // même parfaits, les mots restants ne suffiraient plus : inutile de continuer
      if (!full && (tot + rest) / wsum < need(v.c.kind)) { dropped = true; break; }
    }
    if (dropped) continue;
    const score = tot / wsum, c = v.c;
    results.push({ name: c.name, std: c.std, ref: c.ref ? c.ref.file : undefined, fontId: c.fontId, css: c.css, kind: c.kind, bold: v.vk.includes('b'), italic: v.vk.includes('i'), score });
    if (c.kind === 'sys') bestSys = Math.max(bestSys, score); else bestRef = Math.max(bestRef, score);
  }
  results.sort((a, b) => b.score - a.score);
  // une police de l'ordinateur ne l'emporte sur les polices fournies que si elle ressemble nettement plus
  if (results.length && results[0].kind === 'sys') {
    const alt = results.find(r => r.kind !== 'sys' && r.score >= results[0].score - margin);
    if (alt) { results.splice(results.indexOf(alt), 1); results.unshift(alt); }
  }
  // à ressemblance quasi égale, on préfère Arial / Times / Courier (rendu identique partout, fichier plus léger)
  if (results.length && !results[0].std) {
    const std = results.find(r => r.std && r.score >= results[0].score - 0.015);
    if (std) { results.splice(results.indexOf(std), 1); results.unshift(std); }
  }
  const seen = new Set(), out = [];
  for (const r of results) { if (seen.has(r.name)) continue; seen.add(r.name); out.push(r); if (out.length >= 5) break; }
  out.compared = cands.length;
  if (!partial) cache.set(key, out);
  return out;
}
export const MATCH_THRESHOLD = 0.3;

/* ---------- police utilisable pour une proposition ---------- */
const bundled = new Map();
/**
 * Police à utiliser pour une proposition : police PDF standard (Arial, Times, Courier), police importée,
 * sinon la vraie police si elle est installée (Windows), sinon son équivalent libre fourni avec l'application.
 */
export async function fontIdForGuess(g) {
  if (g.std) return g.std;
  if (g.fontId && state.fonts.has(g.fontId)) return g.fontId;
  const ref = REF.find(r => r.name === g.name);
  if (ref && systemFontsSupported() && await systemFontsGranted()) {
    try {
      const names = [ref.name, ...(ref.aka || [])].map(n => n.toLowerCase());
      const hit = (await listSystemFonts()).find(f => names.includes(f.name.toLowerCase()));
      if (hit) return await loadSystemFamily(hit.name);
    } catch { /* équivalent libre */ }
  }
  if (!ref) return loadSystemFamily(g.name);
  if (bundled.has(ref.file)) return bundled.get(ref.file);
  const variants = {};
  await Promise.all(VARIANTS.map(async ([vk]) => { variants[vk] = new Uint8Array(await (await fetch(refUrl(ref, vk))).arrayBuffer()); }));
  const id = await registerFontFamily(refLabel(ref), variants, 'bundled');
  bundled.set(ref.file, id);
  return id;
}

