// Reconnaissance visuelle de la police d'un texte (scan, photo, ou police absente de l'ordinateur).
// Principe : on découpe l'image d'un extrait du texte, puis on redessine ce même extrait avec chaque
// police installée (normal, gras, italique). La police dont le dessin se superpose le mieux l'emporte.
import { state, pdfjsLib, clamp } from './core.js';
import { listSystemFonts, systemFontsSupported, systemFontsGranted } from './systemfonts.js';

const BASE = [
  { name: 'Arial', std: 'helvetica', bold: true, italic: true },
  { name: 'Times New Roman', std: 'times', bold: true, italic: true },
  { name: 'Courier New', std: 'courier', bold: true, italic: true },
];
// polices de symboles, d'icônes ou d'écritures non latines : inutile de les essayer
const SKIP = /symbol|wingdings|webdings|marlett|dings|emoji|mdl2|fluent|holomdl|ornament|bookshelf|outlook|mt extra|specialty|icons?$|barcode|code ?39|code ?128|cjk|gothic medium|mincho|ming|kai|song|hei|yahei|jhenghei|malgun|gulim|batang|dotum|meiryo|yu |nirmala|mangal|gautami|kartika|latha|raavi|shruti|tunga|vrinda|kalinga|leelawadee|iskoola|gadugi|ebrima|mongolian|myanmar|javanese|sinhala|tibetan|khmer|lao |thai|hebrew|arabic|urdu|devanagari|bengali|tamil|telugu|kannada|malayalam|gujarati|gurmukhi|ethiopic|georgian|armenian/i;

/* ---------- disponibilité réelle d'une police (sans retomber sur une police de secours) ---------- */
const probeCtx = document.createElement('canvas').getContext('2d');
const PROBE = 'mmmmmmmmmlliWwQqÉéàç0123';
const fallbackW = {};
for (const fb of ['monospace', 'serif', 'sans-serif']) { probeCtx.font = `40px ${fb}`; fallbackW[fb] = probeCtx.measureText(PROBE).width; }
function available(name) {
  // une police absente (ou sans lettres latines) donne exactement les largeurs des polices de secours
  return ['monospace', 'serif', 'sans-serif'].some(fb => { probeCtx.font = `40px "${name}", ${fb}`; return probeCtx.measureText(PROBE).width !== fallbackW[fb]; });
}

let candCache = null;
async function candidates() {
  if (candCache) return candCache;
  const list = BASE.filter(b => available(b.name));
  let fams = [];
  if (systemFontsSupported() && await systemFontsGranted()) { try { fams = await listSystemFonts(); } catch {} }
  for (const f of fams) {
    if (SKIP.test(f.name) || BASE.some(b => b.name === f.name) || !available(f.name)) continue;
    list.push({ name: f.name, bold: f.faces.some(x => !x.italic && x.weight >= 600), italic: f.faces.some(x => x.italic) });
  }
  if (fams.length) candCache = list;
  return list;
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

/** Masque d'encre (noir sur blanc) recadré au plus juste. */
function inkMask(canvas) {
  const W = canvas.width, H = canvas.height;
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const lum = new Float32Array(W * H), hist = new Uint32Array(256);
  for (let i = 0; i < W * H; i++) { const l = 0.3 * d[i * 4] + 0.59 * d[i * 4 + 1] + 0.11 * d[i * 4 + 2]; lum[i] = l; hist[l | 0]++; }
  // seuil d'Otsu
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue; const wF = W * H - wB; if (!wF) break;
    sumB += i * hist[i]; const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; t = i; }
  }
  // le fond est la couleur majoritaire sur les bords
  let edgeDark = 0, edgeN = 0;
  for (let x = 0; x < W; x++) for (const y of [0, H - 1]) { edgeN++; if (lum[y * W + x] < t) edgeDark++; }
  const darkInk = edgeDark < edgeN / 2;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  const ink = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, on = darkInk ? lum[i] < t : lum[i] > t;
    if (on) { ink[i] = 1; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0 || x1 - x0 < 4 || y1 - y0 < 3) return null;
  const out = document.createElement('canvas'); out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  const o = out.getContext('2d'); const img = o.createImageData(out.width, out.height);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const v = ink[y * W + x] ? 0 : 255, j = ((y - y0) * out.width + (x - x0)) * 4;
    img.data[j] = img.data[j + 1] = img.data[j + 2] = v; img.data[j + 3] = 255;
  }
  o.putImageData(img, 0, 0);
  return out;
}

/** Échantillonne une zone en « taux d'encre » sur une grille W×H. */
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

const renderCanvas = document.createElement('canvas');
function renderText(text, css) {
  const ctx = renderCanvas.getContext('2d', { willReadFrequently: true });
  ctx.font = css;
  const m = ctx.measureText(text);
  const left = m.actualBoundingBoxLeft, right = m.actualBoundingBoxRight, asc = m.actualBoundingBoxAscent, desc = m.actualBoundingBoxDescent;
  const w = Math.ceil(left + right) + 4, hh = Math.ceil(asc + desc) + 4;
  if (w < 4 || hh < 4) return null;
  renderCanvas.width = w; renderCanvas.height = hh;
  ctx.font = css; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, hh);
  ctx.fillStyle = '#000'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, left + 2, asc + 2);
  return { canvas: renderCanvas, sx: 2, sy: 2, sw: Math.max(1, left + right), sh: Math.max(1, asc + desc) };
}
function inkAspect(text, css) {
  probeCtx.font = css;
  const m = probeCtx.measureText(text);
  const h = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  return h > 0 ? (m.actualBoundingBoxLeft + m.actualBoundingBoxRight) / h : 0;
}

/** Extrait représentatif : mots « propres » consécutifs, ~30 caractères. */
function pickSample(block) {
  const line = [...block.lines].sort((a, b) => b.text.length - a.text.length)[0];
  if (line.words && line.words.length) {
    const clean = w => /^[\p{L}\p{N}'’.,;:!?()«»"-]+$/u.test(w.text) && /[\p{L}\p{N}]/u.test(w.text);
    let best = [], cur = [];
    for (const w of line.words) {
      if (clean(w)) { cur.push(w); if (cur.map(x => x.text).join(' ').length > 48) cur.shift(); }
      else cur = [];
      if (cur.map(x => x.text).join(' ').length > best.map(x => x.text).join(' ').length) best = [...cur];
    }
    if (best.length) {
      const x0 = Math.min(...best.map(w => w.x0)), x1 = Math.max(...best.map(w => w.x1));
      const y0 = Math.min(...best.map(w => w.y0)), y1 = Math.max(...best.map(w => w.y1));
      return { text: best.map(w => w.text).join(' '), rect: { x: x0 - 1, y: y0 - 1, w: x1 - x0 + 2, h: y1 - y0 + 2 }, size: line.size };
    }
  }
  // texte natif : la ligne entière (limitée à ~45 caractères en coupant la zone au prorata)
  let text = line.text.trim(), w = line.w;
  if (text.length > 50) { const cut = text.lastIndexOf(' ', 50) > 20 ? text.lastIndexOf(' ', 50) : 50; w = line.w * cut / text.length; text = text.slice(0, cut); }
  return { text, rect: { x: line.x - 1, y: line.top - 1, w: w + 2, h: line.bottom - line.top + 2 }, size: line.size, approx: true };
}

const cache = new Map();

/**
 * Renvoie les polices les plus proches, de la meilleure à la moins bonne :
 * [{ name, std?, bold, italic, score }]  (score entre 0 et 1)
 */
export async function guessFont(page, block, { budgetMs = 2500 } = {}) {
  const key = (page.src ? page.src + '|' + page.index : page.id) + '|' + Math.round(block.x) + ',' + Math.round(block.top);
  if (cache.has(key)) return cache.get(key);
  const sample = pickSample(block);
  if (!sample.text || sample.text.length < 3) return [];
  const scale = clamp(48 / Math.max(sample.rect.h, 4), 2, 8);
  const scan = inkMask(await cropRaster(page, sample.rect, scale));
  if (!scan) return [];
  const H = 28, aspect = scan.width / scan.height, W = clamp(Math.round(H * aspect), 8, 900);
  const ref = grid(scan, 0, 0, scan.width, scan.height, W, H);
  const cands = await candidates();
  const styles = c => [[400, 'normal', false, false], ...(c.bold ? [[700, 'normal', true, false]] : []), ...(c.italic ? [[400, 'italic', false, true]] : [])];
  const results = [];
  // les polices de base d'abord, puis les autres ; on rend la main régulièrement pour ne pas figer l'écran
  const t0 = performance.now();
  let k = 0, partial = false;
  for (const c of cands) {
    if (++k % 12 === 0) {
      await new Promise(r => setTimeout(r, 0));
      if (performance.now() - t0 > budgetMs) { partial = true; break; }
    }
    for (const [weight, style, bold, italic] of styles(c)) {
      const css = `${style} ${weight} 64px "${c.name}", sans-serif`;
      const a = inkAspect(sample.text, css);
      if (!a) continue;
      const ratio = a / aspect;
      if (Math.abs(Math.log(ratio)) > (sample.approx ? 0.3 : 0.22)) continue; // proportions trop différentes
      const r = renderText(sample.text, css); if (!r) continue;
      const g = grid(r.canvas, r.sx, r.sy, r.sw, r.sh, W, H);
      let inter = 0, uni = 0;
      for (let i = 0; i < g.length; i++) { inter += Math.min(g[i], ref[i]); uni += Math.max(g[i], ref[i]); }
      const score = (uni ? inter / uni : 0) * Math.exp(-2.5 * Math.abs(Math.log(ratio)));
      results.push({ name: c.name, std: c.std, bold, italic, score });
    }
  }
  // une seule entrée par famille (son meilleur style)
  results.sort((a, b) => b.score - a.score);
  // à ressemblance quasi égale, on préfère Arial / Times / Courier (rendu identique partout, fichier plus léger)
  if (results.length && !results[0].std) {
    const std = results.find(r => r.std && r.score >= results[0].score - 0.05);
    if (std) { results.splice(results.indexOf(std), 1); results.unshift(std); }
  }
  const seen = new Set(), out = [];
  for (const r of results) { if (seen.has(r.name)) continue; seen.add(r.name); out.push(r); if (out.length >= 5) break; }
  if (!partial) cache.set(key, out);
  return out;
}
export const MATCH_THRESHOLD = 0.42;
