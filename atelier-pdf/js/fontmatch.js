// Reconnaissance visuelle de la police d'un texte (scan, photo, ou police absente de l'appareil).
// Principe : on découpe l'image de plusieurs mots du texte, puis on redessine chacun de ces mots avec
// chaque police candidate, dans ses quatre styles (normal, gras, italique, gras italique). On compare
// les proportions, la forme des lettres et l'épaisseur des traits ; la police qui ressemble le plus,
// sur l'ensemble des mots, l'emporte.
// Les polices de référence sont fournies avec l'application : la reconnaissance donne le même résultat
// sur Windows, sur Android et dans le navigateur.
import { state, pdfjsLib, clamp, registerFontFamily } from './core.js';
import { listSystemFonts, systemFontsSupported, systemFontsGranted, loadSystemFamily } from './systemfonts.js';

/** Familles de référence : nom courant, fichiers fournis (équivalents libres), police PDF standard éventuelle. */
export const REF = [
  { name: 'Arial', file: 'LiberationSans', std: 'helvetica', clone: 'Liberation Sans' },
  { name: 'Times New Roman', file: 'LiberationSerif', std: 'times', clone: 'Liberation Serif' },
  { name: 'Courier New', file: 'LiberationMono', std: 'courier', clone: 'Liberation Mono' },
  { name: 'Verdana', file: 'DejaVuSans', clone: 'DejaVu Sans' },
  { name: 'Tahoma', file: 'DejaVuSansCondensed', clone: 'DejaVu Sans Condensed' },
  { name: 'Calibri', file: 'Carlito', clone: 'Carlito' },
  { name: 'Cambria', file: 'Caladea', clone: 'Caladea' },
  { name: 'Georgia', file: 'Gelasio', clone: 'Gelasio' },
];
const VARIANTS = [['r', 400, 'normal'], ['b', 700, 'normal'], ['i', 400, 'italic'], ['bi', 700, 'italic']];
const refFamily = f => 'APref ' + f.file;
const refUrl = (f, vk) => new URL(`../vendor/fonts/ref/${f.file}-${vk}.ttf`, import.meta.url).href;

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

/** Candidats : les familles de référence, puis les autres polices de l'ordinateur (Windows, Chrome). */
let sysCache = null;
async function candidates() {
  const list = REF.map(f => ({ name: f.name, std: f.std, ref: f, css: refFamily(f), styles: VARIANTS }));
  if (!sysCache) {
    sysCache = [];
    if (systemFontsSupported() && await systemFontsGranted()) {
      try {
        for (const f of await listSystemFonts()) {
          if (SKIP.test(f.name) || REF.some(r => r.name === f.name || r.clone === f.name) || !available(f.name)) continue;
          const bold = f.faces.some(x => !x.italic && x.weight >= 600), italic = f.faces.some(x => x.italic);
          sysCache.push({ name: f.name, css: f.name, styles: VARIANTS.filter(([vk]) => vk === 'r' || (vk === 'b' && bold) || (vk === 'i' && italic) || (vk === 'bi' && bold && italic)) });
        }
      } catch { /* liste indisponible */ }
    }
  }
  return list.concat(sysCache);
}

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
/** Dessine un texte et renvoie sa boîte d'encre (pour la comparer au scan). */
function renderInk(text, css) {
  const ctx = renderCanvas.getContext('2d', { willReadFrequently: true });
  ctx.font = css;
  const m = ctx.measureText(text);
  const left = m.actualBoundingBoxLeft, right = m.actualBoundingBoxRight, asc = m.actualBoundingBoxAscent, desc = m.actualBoundingBoxDescent;
  const w = Math.ceil(left + right) + 4, hh = Math.ceil(asc + desc) + 4;
  if (w < 6 || hh < 6) return null;
  renderCanvas.width = w; renderCanvas.height = hh;
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
 * [{ name, std?, ref?, bold, italic, score }]  (score entre 0 et 1)
 */
export async function guessFont(page, block, { budgetMs = 2500 } = {}) {
  const key = (page.src ? page.src + '|' + page.index : page.id) + '|' + Math.round(block.x) + ',' + Math.round(block.top) + ',' + Math.round(block.w);
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
    refs.push({ text: s.text, aspect, W, g: blur(g, W, GH), ink: inkSum(g), weight: Math.sqrt(s.n), approx: s.approx });
  }
  if (!refs.length) return [];
  const cands = await candidates();
  const results = [];
  const t0 = performance.now();
  let partial = false;
  for (const [k, c] of cands.entries()) {
    if (k && k % 6 === 0) {
      await new Promise(r => setTimeout(r, 0));
      if (k >= REF.length && performance.now() - t0 > budgetMs) { partial = true; break; }
    }
    for (const [vk, weight, style] of c.styles) {
      const css = `${style} ${weight} 72px "${c.css}", sans-serif`;
      let tot = 0, wsum = 0;
      for (const r of refs) {
        const ren = renderInk(r.text, css);
        let s = 0;
        if (ren) {
          const ratio = ren.aspect / r.aspect, lr = Math.abs(Math.log(ratio));
          if (lr < 0.45) {
            const g = grid(ren.canvas, ren.sx, ren.sy, ren.sw, ren.sh, r.W, GH);
            const shape = Math.max(0, ncc(blur(g, r.W, GH), r.g));
            // le scan épaissit un peu les traits : seul un écart net d'épaisseur est pénalisé
            const li = Math.log(inkSum(g) / Math.max(1, r.ink));
            const thick = Math.exp(-2.2 * Math.max(0, Math.abs(li + 0.06) - 0.08));
            s = shape * Math.exp(-(r.approx ? 2.5 : 3.5) * lr) * thick;
          }
        }
        tot += s * r.weight; wsum += r.weight;
      }
      results.push({ name: c.name, std: c.std, ref: c.ref ? c.ref.file : undefined, bold: vk.includes('b'), italic: vk.includes('i'), score: wsum ? tot / wsum : 0 });
    }
  }
  results.sort((a, b) => b.score - a.score);
  // une police de l'ordinateur ne l'emporte sur les polices courantes que si elle ressemble nettement plus
  // (sur quelques chiffres, beaucoup de polices se ressemblent)
  if (results.length && !results[0].ref) {
    const ref = results.find(r => r.ref && r.score >= results[0].score - 0.06);
    if (ref) { results.splice(results.indexOf(ref), 1); results.unshift(ref); }
  }
  // à ressemblance quasi égale, on préfère Arial / Times / Courier (rendu identique partout, fichier plus léger)
  if (results.length && !results[0].std) {
    const std = results.find(r => r.std && r.score >= results[0].score - 0.015);
    if (std) { results.splice(results.indexOf(std), 1); results.unshift(std); }
  }
  const seen = new Set(), out = [];
  for (const r of results) { if (seen.has(r.name)) continue; seen.add(r.name); out.push(r); if (out.length >= 5) break; }
  if (!partial) cache.set(key, out);
  return out;
}
export const MATCH_THRESHOLD = 0.3;

/* ---------- police utilisable pour une proposition ---------- */
const bundled = new Map();
/**
 * Police à utiliser pour une proposition : police PDF standard (Arial, Times, Courier), sinon la vraie police
 * si elle est installée (Windows), sinon son équivalent libre fourni avec l'application.
 */
export async function fontIdForGuess(g) {
  if (g.std) return g.std;
  const ref = REF.find(r => r.name === g.name);
  if (ref && systemFontsSupported() && await systemFontsGranted()) {
    try { if ((await listSystemFonts()).some(f => f.name === g.name)) return await loadSystemFamily(g.name); } catch { /* équivalent libre */ }
  }
  if (!ref) return loadSystemFamily(g.name);
  if (bundled.has(ref.file)) return bundled.get(ref.file);
  const variants = {};
  await Promise.all(VARIANTS.map(async ([vk]) => { variants[vk] = new Uint8Array(await (await fetch(refUrl(ref, vk))).arrayBuffer()); }));
  const id = await registerFontFamily(`${ref.clone} (≈ ${ref.name})`, variants, 'bundled');
  bundled.set(ref.file, id);
  return id;
}
