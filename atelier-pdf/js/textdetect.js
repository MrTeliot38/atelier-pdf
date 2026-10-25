// Reconnaissance du texte : texte natif du PDF (pdf.js) ou OCR (Tesseract) pour les scans
import { state, pdfjsLib, loadScript, clamp, rgbToHex } from './core.js';
import { pageCanvas } from './viewer.js';

const nativeCache = new Map();  // "src|index" -> lines
const ocrCache = new Map();     // clé page -> lines

const nativeKey = p => p.src ? p.src + '|' + p.index : null;
const ocrKey = p => p.src ? 'o|' + p.src + '|' + p.index : 'o|' + p.id;

export const hasOcr = p => ocrCache.has(ocrKey(p));

/* ------------------------------------------------ polices */
export function mapFont(name = '', family = '', flags = {}) {
  const n = name.replace(/^[A-Z]{6}\+/, '');
  const bold = !!flags.bold || !!flags.black || /bold|black|heavy|semibold|demi|extrabold|ultra|[-_ ]bd\b/i.test(n);
  const italic = !!flags.italic || /italic|oblique|[-_ ]it\b|ital/i.test(n);
  const lower = (n + ' ' + family).toLowerCase();
  let font = 'helvetica';
  if (/courier|mono|consol|menlo|typewriter/.test(lower)) font = 'courier';
  else if ((/times|garamond|georgia|minion|cambria|baskerville|palatino|caslon|bodoni|book ?antiqua|serif/.test(n.toLowerCase()) && !/sans/i.test(n)) || family === 'serif') font = 'times';
  // police importée par l'utilisateur dont le nom correspond ?
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const base = norm(n.split(/[-,]/)[0]);
  for (const f of state.fonts.values()) {
    const fn = norm(f.name.replace(/\.(ttf|otf)$/i, ''));
    if (base && fn && (fn === base || fn.startsWith(base) || base.startsWith(fn))) return { font: f.id, bold, italic, pdfName: n };
  }
  return { font, bold, italic, pdfName: n };
}

/* ------------------------------------------------ texte natif */
async function nativeLines(page) {
  const key = nativeKey(page);
  if (!key) return [];
  if (nativeCache.has(key)) return nativeCache.get(key);
  const src = state.sources.get(page.src);
  const pdfPage = await src.pdf.getPage(page.index + 1);
  const tc = await pdfPage.getTextContent();
  const vp = pdfPage.getViewport({ scale: 1 });
  try { await pdfPage.getOperatorList(); } catch {}
  const fontInfo = new Map();
  const info = fn => {
    if (fontInfo.has(fn)) return fontInfo.get(fn);
    let fi = { name: '', bold: false, italic: false, black: false };
    try { if (pdfPage.commonObjs.has(fn)) { const f = pdfPage.commonObjs.get(fn); fi = { name: f.name || f.fallbackName || '', bold: !!f.bold, italic: !!f.italic, black: !!f.black }; } } catch {}
    fontInfo.set(fn, fi); return fi;
  };
  const items = [];
  for (const it of tc.items) {
    if (!it.str || !it.transform) continue;
    const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
    if (Math.abs(Math.atan2(tx[1], tx[0])) > 0.02 || tx[0] < 0) continue; // texte incliné ou retourné
    const size = Math.hypot(tx[2], tx[3]);
    const style = tc.styles[it.fontName] || {};
    if (size < 2 || style.vertical) continue;
    items.push({ x: tx[4], base: tx[5], w: it.width, size, str: it.str, fontName: it.fontName, family: style.fontFamily || '', ascent: style.ascent || 0.8 });
  }
  const lines = groupItemsIntoLines(items).map(L => {
    const fi = info(L.fontName);
    const f = mapFont(fi.name, L.family, fi);
    return { ...L, ...f };
  });
  nativeCache.set(key, lines);
  return lines;
}

function groupItemsIntoLines(items) {
  items.sort((a, b) => a.base - b.base || a.x - b.x);
  const lines = [];
  for (const it of items) {
    let target = null;
    for (let k = lines.length - 1; k >= 0 && k >= lines.length - 30; k--) {
      const L = lines[k];
      const s = Math.max(L.size, it.size);
      if (Math.abs(L.base - it.base) > 0.4 * Math.min(L.size, it.size)) continue;
      const gapR = it.x - L.x1, gapL = L.x0 - (it.x + it.w);
      if ((gapR > -0.6 * s && gapR < 1.7 * s) || (gapL > -0.6 * s && gapL < 1.7 * s)) { target = L; break; }
    }
    if (!target) lines.push({ items: [it], base: it.base, size: it.size, x0: it.x, x1: it.x + it.w });
    else { target.items.push(it); target.x0 = Math.min(target.x0, it.x); target.x1 = Math.max(target.x1, it.x + it.w); }
  }
  const out = [];
  for (const L of lines) {
    L.items.sort((a, b) => a.x - b.x);
    let text = '', prevEnd = null;
    const weight = new Map(), sizeW = new Map();
    for (const it of L.items) {
      if (prevEnd != null) {
        const gap = it.x - prevEnd;
        if (gap > 0.17 * it.size && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' ';
      }
      text += it.str;
      prevEnd = it.x + it.w;
      const n = it.str.trim().length;
      weight.set(it.fontName, (weight.get(it.fontName) || 0) + n);
      const sk = Math.round(it.size * 4) / 4;
      sizeW.set(sk, (sizeW.get(sk) || 0) + n);
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const fontName = [...weight].sort((a, b) => b[1] - a[1])[0][0];
    const main = L.items.find(i => i.fontName === fontName);
    const size = [...sizeW].sort((a, b) => b[1] - a[1])[0][0];
    // ligne de base de la police dominante (les exposants ne doivent pas la décaler)
    const base = main.base;
    out.push({ x: L.x0, w: L.x1 - L.x0, base, size, top: base - size * Math.min(0.95, Math.max(0.7, main.ascent)), bottom: base + size * 0.24,
      text, fontName, family: main.family });
  }
  return out;
}

/* ------------------------------------------------ OCR */
let workerPromise = null;
let progressCb = null;
const abs = rel => new URL(rel, import.meta.url).href;

async function getWorker() {
  if (!window.Tesseract) await loadScript(abs('../vendor/ocr/tesseract.min.js'));
  if (!workerPromise) {
    workerPromise = window.Tesseract.createWorker('fra', 1, {
      workerPath: abs('../vendor/ocr/worker.min.js'),
      corePath: abs('../vendor/ocr/core/'),
      langPath: abs('../vendor/ocr/lang'),
      logger: m => progressCb && progressCb(m),
    }).catch(e => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

/** Image de la page (PDF d'origine ou photo insérée) à l'échelle demandée. */
export async function pageRaster(page, scale) {
  if (page.src) return pageCanvas(page, scale);
  const c = document.createElement('canvas');
  c.width = Math.ceil(page.w * scale); c.height = Math.ceil(page.h * scale);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  for (const o of page.objects) {
    if (o.type !== 'image') continue;
    const a = state.assets.get(o.asset); if (!a) continue;
    const img = new Image(); img.src = a.dataUrl; await img.decode();
    ctx.drawImage(img, o.x * scale, o.y * scale, o.w * scale, o.h * scale);
  }
  return { canvas: c, scale };
}

export async function runOcr(page, onProgress) {
  progressCb = onProgress;
  const worker = await getWorker();
  const scale = clamp(3400 / Math.max(page.w, page.h), 2, 5);
  const { canvas } = await pageRaster(page, scale);
  onProgress && onProgress({ status: 'recognizing text', progress: 0 });
  const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
  const lines = [];
  let para = 0;
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) {
    para++;
    for (const l of p.lines || []) {
      const text = (l.text || '').replace(/\s+/g, ' ').trim();
      if (!text || (l.confidence ?? 100) < 35) continue;
      const signs = (text.match(/[\p{L}\p{N}]/gu) || []).length;
      if (signs < 2 || signs / text.replace(/\s/g, '').length < 0.5) continue; // traits, taches, bordures
      const bb = l.bbox;
      const bl = l.baseline && l.baseline.has_baseline !== false ? (l.baseline.y0 + l.baseline.y1) / 2 : bb.y1 - (bb.y1 - bb.y0) * 0.2;
      const capH = Math.max(1, bl - bb.y0);
      const hasAsc = /[A-Z0-9bdfhklt'ÀÂÉÈÊËÎÏÔÙÛÇ]/.test(text);
      const sizePx = hasAsc ? capH / 0.76 : capH / 0.53;
      const size = sizePx / scale;
      const base = bl / scale;
      const words = (l.words || []).filter(w => w.text && w.text.trim() && w.bbox)
        .map(w => ({ text: w.text.trim(), conf: w.confidence, x0: w.bbox.x0 / scale, y0: w.bbox.y0 / scale, x1: w.bbox.x1 / scale, y1: w.bbox.y1 / scale }));
      // une « ligne » de l'OCR peut traverser plusieurs colonnes : on la coupe aux grands espaces
      const segs = [];
      for (const w of words) {
        const cur = segs[segs.length - 1];
        if (cur && w.x0 - cur[cur.length - 1].x1 < Math.max(size * 2.2, 14)) cur.push(w); else segs.push([w]);
      }
      if (!segs.length) segs.push(null);
      for (const seg of segs) {
        const x0 = seg ? Math.min(...seg.map(w => w.x0)) : bb.x0 / scale, x1 = seg ? Math.max(...seg.map(w => w.x1)) : bb.x1 / scale;
        const top = seg ? Math.min(...seg.map(w => w.y0)) : bb.y0 / scale, bot = seg ? Math.max(...seg.map(w => w.y1)) : bb.y1 / scale;
        const segText = seg ? seg.map(w => w.text).join(' ') : text;
        if ((segText.match(/[\p{L}\p{N}]/gu) || []).length < 2) continue;
        // morceau d'une ligne coupée entre colonnes : sa propre ligne de base et sa propre taille
        let sBase = base, sSize = size, sAsc = hasAsc;
        if (seg && segs.length > 1) {
          const flat = seg.filter(w => !/[gjpqyçµ,;()]/.test(w.text));
          const ys = (flat.length ? flat : seg).map(w => w.y1).sort((a, b) => a - b);
          sBase = flat.length ? ys[Math.floor(ys.length / 2)] : ys[Math.floor(ys.length / 2)] - (bot - top) * 0.2;
          sAsc = /[A-Z0-9bdfhklt'ÀÂÉÈÊËÎÏÔÙÛÇ]/.test(segText);
          sSize = Math.max(2, sBase - top) / (sAsc ? 0.76 : 0.53);
        }
        const conf = seg && seg.length ? Math.min(...seg.map(w => w.conf ?? 100)) : (l.confidence ?? 100);
        lines.push({ x: x0, w: x1 - x0, base: sBase, size: sSize, top, bottom: Math.max(bot, sBase + sSize * 0.22),
          text: segText, font: 'helvetica', bold: false, italic: false, para, ocr: true, words: seg || [],
          refine: segs.length > 1 || conf < 62, conf, asc: sAsc });
      }
    }
  }
  // 2e passe : les morceaux coupés entre deux colonnes ou peu sûrs sont relus seuls, en mode « une ligne »
  const todo = lines.filter(L => L.refine).slice(0, 45);
  if (todo.length) {
    try {
      await worker.setParameters({ tessedit_pageseg_mode: '7' });
      let i = 0;
      for (const L of todo) {
        onProgress && onProgress({ status: 'refining', progress: ++i / todo.length });
        const pad = L.size * 0.35;
        const rect = { left: Math.max(0, Math.floor((L.x - pad) * scale)), top: Math.max(0, Math.floor((L.top - pad) * scale)) };
        rect.width = Math.min(canvas.width - rect.left, Math.ceil((L.w + 2 * pad) * scale));
        rect.height = Math.min(canvas.height - rect.top, Math.ceil((L.bottom - L.top + 2 * pad) * scale));
        if (rect.width < 8 || rect.height < 8) continue;
        const { data: d } = await worker.recognize(canvas, { rectangle: rect }, { text: true, blocks: true });
        const text = (d.text || '').replace(/\s+/g, ' ').trim();
        if (!text || (d.confidence ?? 0) <= L.conf) continue;
        L.text = text; L.conf = d.confidence;
        const ws = (d.blocks || []).flatMap(b => b.paragraphs || []).flatMap(p => p.lines || []).flatMap(l => l.words || []);
        if (ws.length) L.words = ws.filter(w => w.text && w.text.trim() && w.bbox).map(w => ({ text: w.text.trim(), conf: w.confidence,
          x0: (w.bbox.x0) / scale, y0: (w.bbox.y0) / scale, x1: (w.bbox.x1) / scale, y1: (w.bbox.y1) / scale }));
        // taille recalculée d'après le texte relu
        L.asc = /[A-Z0-9bdfhklt'ÀÂÉÈÊËÎÏÔÙÛÇ]/.test(L.text);
        if (L.words.length) {
          const top2 = Math.min(...L.words.map(w => w.y0));
          if (L.base - top2 > 1) { L.size = (L.base - top2) / (L.asc ? 0.76 : 0.53); L.top = top2; }
        }
      }
    } catch (e) { console.warn('Relecture OCR', e); }
    finally { try { await worker.setParameters({ tessedit_pageseg_mode: '3' }); } catch {} }
  }
  progressCb = null;
  // lectures trop incertaines (dessins, pictogrammes, QR codes…) : écartées
  const kept = lines.filter(L => (L.conf ?? 100) >= 50 || (L.text.match(/\p{L}{4,}/gu) || []).length >= 2 && (L.conf ?? 100) >= 40);
  ocrCache.set(ocrKey(page), kept);
  return kept;
}

/* ------------------------------------------------ blocs éditables */
export async function getLines(page) {
  const o = ocrCache.get(ocrKey(page));
  if (o) return { lines: o, kind: 'ocr' };
  const n = await nativeLines(page);
  return { lines: n, kind: n.length ? 'native' : 'none' };
}

export async function getBlocks(page) {
  const { lines, kind } = await getLines(page);
  const blocks = state.textMode === 'line' ? lines.map(l => makeBlock([l])) : groupParagraphs(lines, kind === 'ocr');
  return { blocks, kind };
}

function groupParagraphs(lines, ocr) {
  const sorted = [...lines].sort((a, b) => a.top - b.top || a.x - b.x);
  const groups = [];
  for (const L of sorted) {
    let best = null, bestD = Infinity;
    for (const g of groups) {
      const last = g[g.length - 1];
      if (ocr) {
        // l'OCR regroupe parfois un titre et le texte : on vérifie aussi la taille
        // taille estimée moins sûre pour une ligne sans majuscules ni lettres hautes
        const tol = last.asc === false || L.asc === false ? 0.3 : 0.12;
        if (last.para !== L.para || Math.abs(last.size - L.size) > tol * last.size) continue;
      } else {
        if (Math.abs(last.size - L.size) > 0.12 * last.size) continue;
        if (last.bold !== L.bold || last.font !== L.font) continue;
      }
      const d = L.base - last.base;
      if (d < 0.6 * L.size || d > (ocr ? 2.2 : 1.95) * Math.max(L.size, last.size)) continue;
      if (g.length > 1) { const prev = g[g.length - 1].base - g[g.length - 2].base; if (Math.abs(d - prev) > 0.3 * L.size) continue; }
      const x0 = Math.min(...g.map(l => l.x)), x1 = Math.max(...g.map(l => l.x + l.w));
      const overlap = Math.min(x1, L.x + L.w) - Math.max(x0, L.x);
      if (overlap < Math.min(L.w, x1 - x0) * 0.3) continue;
      if (d < bestD) { bestD = d; best = g; }
    }
    if (best) best.push(L); else groups.push([L]);
  }
  return groups.map(makeBlock);
}

function makeBlock(lines) {
  const first = lines[0];
  const x0 = Math.min(...lines.map(l => l.x)), x1 = Math.max(...lines.map(l => l.x + l.w));
  const top = Math.min(...lines.map(l => l.top)), bottom = Math.max(...lines.map(l => l.bottom));
  let text = '';
  const blockW = x1 - x0;
  const BULLET = /^([•·▪▫●○◦■□✓✔➢➤►▶→\-–—*]|\d{1,2}[.)]|[a-z][.)])\s/;
  lines.forEach((l, i) => {
    if (i === 0) { text = l.text; return; }
    const prev = lines[i - 1];
    // retour à la ligne conservé : puce, ligne précédente nettement plus courte, ou fin de phrase courte
    const hard = BULLET.test(l.text) || (prev.x + prev.w < x0 + blockW * 0.72 && lines.length > 1);
    if (hard) text += '\n' + l.text;
    else if (/[a-zàâäéèêëîïôöùûüç]-$/.test(text) && /^[a-zàâäéèêëîïôöùûüç]/.test(l.text)) text = text.slice(0, -1) + l.text;
    else text += ' ' + l.text;
  });
  const gaps = lines.slice(1).map((l, i) => l.base - lines[i].base).sort((a, b) => a - b);
  const lh = gaps.length ? clamp(gaps[Math.floor(gaps.length / 2)] / first.size, 0.8, 2.5) : 1.2;
  let align = 'left';
  if (lines.length > 1) {
    const tol = first.size * 0.6;
    const lefts = lines.map(l => l.x), rights = lines.map(l => l.x + l.w), mids = lines.map(l => l.x + l.w / 2);
    const spread = a => Math.max(...a) - Math.min(...a);
    if (spread(lefts) > tol) align = spread(mids) <= tol ? 'center' : spread(rights) <= tol ? 'right' : 'left';
  }
  return { x: x0, w: x1 - x0, top, bottom, base0: first.base, size: first.size, lineHeight: lh, align, text, lines,
    font: first.font, bold: first.bold, italic: first.italic, pdfName: first.pdfName || '', ocr: !!first.ocr };
}

/* ------------------------------------------------ couleurs */
export async function sampleColors(page, rect) {
  try {
    const { canvas, scale } = await pageRaster(page, 2);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const pad = 3;
    const x0 = clamp(Math.floor((rect.x - pad) * scale), 0, canvas.width - 1), y0 = clamp(Math.floor((rect.y - pad) * scale), 0, canvas.height - 1);
    const x1 = clamp(Math.ceil((rect.x + rect.w + pad) * scale), x0 + 1, canvas.width), y1 = clamp(Math.ceil((rect.y + rect.h + pad) * scale), y0 + 1, canvas.height);
    const W = x1 - x0, H = y1 - y0;
    const d = ctx.getImageData(x0, y0, W, H).data;
    const ring = Math.max(2, Math.round(pad * scale * 0.6));
    const counts = new Map();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (x >= ring && x < W - ring && y >= ring && y < H - ring) continue;
      const i = (y * W + x) * 4;
      const k = (d[i] >> 3) << 10 | (d[i + 1] >> 3) << 5 | (d[i + 2] >> 3);
      const c = counts.get(k) || [0, 0, 0, 0]; c[0]++; c[1] += d[i]; c[2] += d[i + 1]; c[3] += d[i + 2]; counts.set(k, c);
    }
    let bg = [255, 255, 255];
    if (counts.size) { const c = [...counts.values()].sort((a, b) => b[0] - a[0])[0]; bg = [c[1] / c[0], c[2] / c[0], c[3] / c[0]]; }
    // encre : pixels intérieurs les plus éloignés du fond
    const ins = [];
    let maxD = 0;
    for (let y = ring; y < H - ring; y++) for (let x = ring; x < W - ring; x++) {
      const i = (y * W + x) * 4;
      const dist = Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]);
      if (dist > 40) { ins.push([dist, d[i], d[i + 1], d[i + 2]]); if (dist > maxD) maxD = dist; }
    }
    let fg = bg[0] + bg[1] + bg[2] > 384 ? [17, 17, 17] : [255, 255, 255];
    const strong = ins.filter(p => p[0] >= maxD * 0.7);
    if (strong.length) fg = [0, 1, 2].map(j => strong.reduce((s, p) => s + p[j + 1], 0) / strong.length);
    return { bg: rgbToHex(...bg), fg: rgbToHex(...fg) };
  } catch (e) {
    console.warn(e);
    return { bg: '#ffffff', fg: '#111111' };
  }
}

export function clearTextCaches() { nativeCache.clear(); ocrCache.clear(); }
