// Repérage des images DANS une page qui n'est elle-même qu'une image (tract exporté « aplati », scan, photo).
// Principe : on rend la page à 1 pixel par point, on retire le fond et les lignes de texte (connues par la
// lecture du texte), puis on regroupe les pixels restants proches en « régions » : logos, illustrations,
// pictogrammes, QR codes… Chaque région peut ensuite être découpée et déplacée comme une image.
import { state, uid, clamp } from './core.js';
import { getLines, pageRaster, sampleColors } from './textdetect.js';

const cache = new Map();
export const regionKey = p => (p.src ? 'r|' + p.src + '|' + p.index : 'r|' + p.id);
export const cachedRegions = page => cache.get(regionKey(page));
export function forgetRegions(page) { cache.delete(regionKey(page)); }

const q = (r, g, b) => (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4);

/** Régions graphiques de la page : [{ x, y, w, h, region: true }] en points. */
export async function detectRegions(page, { exclude = [] } = {}) {
  const key = regionKey(page);
  if (cache.has(key)) return cache.get(key);
  const { lines } = await getLines(page);
  const W = Math.ceil(page.w), H = Math.ceil(page.h);
  const { canvas } = await pageRaster(page, 2);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, W, H);
  const px = ctx.getImageData(0, 0, W, H).data;

  // fond = couleur la plus fréquente
  const hist = new Map();
  for (let i = 0; i < px.length; i += 4 * 3) { const k = q(px[i], px[i + 1], px[i + 2]); hist.set(k, (hist.get(k) || 0) + 1); }
  const bgk = [...hist].sort((a, b) => b[1] - a[1])[0][0];
  const bg = [((bgk >> 8) & 15) * 16 + 8, ((bgk >> 4) & 15) * 16 + 8, (bgk & 15) * 16 + 8];

  // zones de texte : exclues de l'analyse (ni « dessin », ni fond)
  const T = new Uint8Array(W * H);
  for (const l of lines) {
    const x0 = clamp(Math.floor(l.x - 1), 0, W), x1 = clamp(Math.ceil(l.x + l.w + 1), 0, W);
    const y0 = clamp(Math.floor(l.top - 1), 0, H), y1 = clamp(Math.ceil(l.bottom + 1), 0, H);
    for (let y = y0; y < y1; y++) T.fill(1, y * W + x0, y * W + x1);
  }
  // pixels « dessinés » : assez différents du fond, hors texte
  const M = new Uint8Array(W * H);
  for (let i = 0, j = 0; j < W * H; i += 4, j++) {
    if (T[j]) continue;
    const d = Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]);
    if (d > 60) M[j] = 1;
  }
  // dilatation (rayon 3 pt) pour réunir les morceaux d'un même dessin
  const r = 3, S = new Int32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += M[y * W + x]; S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row; } }
  const D = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const xa = Math.max(0, x - r), xb = Math.min(W, x + r + 1), ya = Math.max(0, y - r), yb = Math.min(H, y + r + 1);
    if (S[yb * (W + 1) + xb] - S[ya * (W + 1) + xb] - S[yb * (W + 1) + xa] + S[ya * (W + 1) + xa] > 0) D[y * W + x] = 1;
  }
  // composantes connexes
  const lab = new Int32Array(W * H);
  const comps = [];
  const stack = new Int32Array(W * H);
  let n = 0;
  for (let s0 = 0; s0 < W * H; s0++) {
    if (!D[s0] || lab[s0]) continue;
    n++;
    let top = 0; stack[top++] = s0; lab[s0] = n;
    let x0 = W, y0 = H, x1 = -1, y1 = -1, count = 0;
    const colors = new Map();
    while (top) {
      const i = stack[--top], x = i % W, y = (i / W) | 0;
      if (M[i]) {
        count++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        const k = q(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]); colors.set(k, (colors.get(k) || 0) + 1);
      }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const k2 = yy * W + xx;
        if (D[k2] && !lab[k2]) { lab[k2] = n; stack[top++] = k2; }
      }
    }
    if (x1 < 0) continue;
    comps.push({ id: n, x0, y0, x1, y1, count, dom: Math.max(...colors.values()) / count });
  }
  // plus grand élément d'un seul tenant (avant dilatation) dans chaque région : une liste à puces n'est faite
  // que de petites marques séparées, alors qu'un logo ou un dessin contient un tracé continu important
  const subMax = new Float64Array(n + 1);
  const lab2 = new Uint8Array(W * H);
  for (let s0 = 0; s0 < W * H; s0++) {
    if (!M[s0] || lab2[s0]) continue;
    let top = 0; stack[top++] = s0; lab2[s0] = 1;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    while (top) {
      const i = stack[--top], x = i % W, y = (i / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const k2 = yy * W + xx;
        if (M[k2] && !lab2[k2]) { lab2[k2] = 1; stack[top++] = k2; }
      }
    }
    const reg = lab[s0];
    const a = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (a > subMax[reg]) subMax[reg] = a;
  }
  const pageArea = W * H;
  const out = [];
  for (const k of comps) {
    const id = k.id;
    const w = k.x1 - k.x0 + 1, h = k.y1 - k.y0 + 1, area = w * h;
    if (w < 14 || h < 14 || area < 400 || Math.min(w, h) < 8) continue;          // trop petit : puce, trait, ponctuation
    if (area > pageArea * 0.6) continue;                                          // presque toute la page : c'est le fond
    let tArea = 0;
    for (let y = k.y0; y <= k.y1; y++) for (let x = k.x0; x <= k.x1; x++) tArea += T[y * W + x];
    const free = Math.max(1, area - tArea);
    const fill = k.count / free;
    const icon = area < 4000 && subMax[id] >= area * 0.8;                          // petit pictogramme au tracé continu
    if (tArea > area * 0.35 && !icon) continue;                                   // surtout du texte (cadre, bandeau titré)
    if (fill < 0.12) continue;                                                    // cadre ou filet : contour sans contenu
    if (fill > 0.8 && k.dom > 0.85 && area > 4000) continue;                      // grand aplat uni : bandeau, fond de bloc
    if (w / h > 4.5 || h / w > 4.5) continue;                                     // bande allongée : ligne de tableau, bandeau, filet
    if (subMax[id] < area * 0.08) continue;                                       // seulement de petites marques : puces, cases à cocher
    const rr = { x: k.x0 - 1, y: k.y0 - 1, w: w + 2, h: h + 2, region: true };
    if (exclude.some(e => ov(rr, e) > 0.5)) continue;
    out.push(rr);
  }
  out.sort((a, b) => b.w * b.h - a.w * a.h);
  const res = out.slice(0, 40);
  cache.set(key, res);
  return res;
}
function ov(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), hh = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && hh > 0 ? (w * hh) / (a.w * a.h || 1) : 0;
}

/** Découpe une région de la page en image ; le fond qui touche les bords devient transparent. */
export async function cutRegion(page, reg) {
  const scale = 3.5;
  const { canvas, scale: s } = await pageRaster(page, scale);
  const pad = 1.5;
  const x = Math.max(0, reg.x - pad), y = Math.max(0, reg.y - pad);
  const w = Math.min(page.w - x, reg.w + 2 * pad), h = Math.min(page.h - y, reg.h + 2 * pad);
  const W = Math.round(w * s), H = Math.round(h * s);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, x * s, y * s, w * s, h * s, 0, 0, W, H);
  const img = ctx.getImageData(0, 0, W, H), d = img.data;
  // couleur du fond autour du dessin = couleur la plus fréquente sur le bord de la découpe
  const hist = new Map();
  const edge = i => { const k = q(d[i], d[i + 1], d[i + 2]); hist.set(k, (hist.get(k) || 0) + 1); };
  for (let xx = 0; xx < W; xx++) { edge(xx * 4); edge(((H - 1) * W + xx) * 4); }
  for (let yy = 0; yy < H; yy++) { edge((yy * W) * 4); edge((yy * W + W - 1) * 4); }
  const bgk = [...hist].sort((a, b) => b[1] - a[1])[0][0];
  const bg = [((bgk >> 8) & 15) * 16 + 8, ((bgk >> 4) & 15) * 16 + 8, (bgk & 15) * 16 + 8];
  // remplissage depuis les bords : seul le fond « extérieur » devient transparent (les blancs intérieurs restent)
  const dist = i => Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]);
  const seen = new Uint8Array(W * H), st = [];
  const push = (xx, yy) => { const j = yy * W + xx; if (!seen[j] && dist(j * 4) < 70) { seen[j] = 1; st.push(j); } };
  for (let xx = 0; xx < W; xx++) { push(xx, 0); push(xx, H - 1); }
  for (let yy = 0; yy < H; yy++) { push(0, yy); push(W - 1, yy); }
  while (st.length) {
    const j = st.pop(), xx = j % W, yy = (j / W) | 0;
    if (xx > 0) push(xx - 1, yy); if (xx < W - 1) push(xx + 1, yy); if (yy > 0) push(xx, yy - 1); if (yy < H - 1) push(xx, yy + 1);
  }
  let transparent = 0;
  for (let j = 0; j < W * H; j++) if (seen[j]) {
    const dd = dist(j * 4);
    d[j * 4 + 3] = dd < 35 ? 0 : Math.round(255 * (dd - 35) / 35); // bord adouci
    transparent++;
  }
  ctx.putImageData(img, 0, 0);
  const mime = transparent ? 'image/png' : 'image/jpeg';
  const color = (await sampleColors(page, reg)).bg;
  return { asset: { id: uid('a'), dataUrl: c.toDataURL(mime, 0.92), mime, w: W, h: H }, rect: { x, y, w, h }, color };
}
export { state };
