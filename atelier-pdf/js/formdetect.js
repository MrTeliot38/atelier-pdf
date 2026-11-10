// Repérage automatique des zones à remplir d'un document sans champs de formulaire :
// cases à cocher (petits carrés vides) et lignes à compléter (traits pleins ou pointillés
// avec de la place libre juste au-dessus). Tout se fait sur l'image de la page, sur l'appareil.
import { pageRaster } from './textdetect.js';

const cache = new Map();
export const fieldsKey = p => (p.src ? 'f|' + p.src + '|' + p.index : 'f|' + p.id);
export const cachedFields = page => cache.get(fieldsKey(page));

/** → { boxes: [{x,y,w,h}], lines: [{x,y,w,free}] } en points (y = position du trait, free = hauteur libre au-dessus) */
export async function detectFields(page) {
  const key = fieldsKey(page);
  if (cache.has(key)) return cache.get(key);
  const p = (async () => {
    try { return analyse(await pageRaster(page, 2)); }
    catch (e) { console.warn('Repérage des champs', e); return { boxes: [], lines: [] }; }
  })();
  cache.set(key, p);
  const r = await p; cache.set(key, r);
  return r;
}

function analyse({ canvas, scale: s }) {
  const W = canvas.width, H = canvas.height;
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const D = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < D.length; i++, j += 4) D[i] = (d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114) < 150 && d[j + 3] > 100 ? 1 : 0;
  // nombre de pixels sombres cumulés par colonne : « y a-t-il de l'encre entre deux lignes ? » en temps constant
  const C = new Uint32Array(W * (H + 1));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) C[(y + 1) * W + x] = C[y * W + x] + D[y * W + x];
  const ink = (x, y0, y1) => (C[Math.min(H, Math.max(0, y1)) * W + x] - C[Math.min(H, Math.max(0, y0)) * W + x]);
  const pt = v => v * s; // points → pixels

  /* ---------- cases à cocher : petits carrés vides, isolés ---------- */
  const boxes = [];
  const lab = new Uint8Array(W * H), stack = new Int32Array(W * H > 4e6 ? 4e6 : W * H);
  const minB = pt(5.5), maxB = pt(24);
  for (let y0 = 0; y0 < H; y0++) for (let x0 = 0; x0 < W; x0++) {
    const i0 = y0 * W + x0;
    if (!D[i0] || lab[i0]) continue;
    let sp = 0, n = 0, ax = x0, bx = x0, ay = y0, by = y0, big = false;
    stack[sp++] = i0; lab[i0] = 1;
    while (sp) {
      const i = stack[--sp], x = i % W, y = (i - x) / W; n++;
      if (x < ax) ax = x; if (x > bx) bx = x; if (y < ay) ay = y; if (y > by) by = y;
      if (bx - ax > maxB || by - ay > maxB) big = true;
      if (x > 0 && D[i - 1] && !lab[i - 1]) { lab[i - 1] = 1; if (sp < stack.length) stack[sp++] = i - 1; }
      if (x < W - 1 && D[i + 1] && !lab[i + 1]) { lab[i + 1] = 1; if (sp < stack.length) stack[sp++] = i + 1; }
      if (y > 0 && D[i - W] && !lab[i - W]) { lab[i - W] = 1; if (sp < stack.length) stack[sp++] = i - W; }
      if (y < H - 1 && D[i + W] && !lab[i + W]) { lab[i + W] = 1; if (sp < stack.length) stack[sp++] = i + W; }
    }
    if (big) continue;
    const w = bx - ax + 1, hh = by - ay + 1;
    if (w < minB || hh < minB || w / hh < 0.8 || w / hh > 1.25) continue;
    // les quatre bords sont des traits droits presque complets (un « O » ou un « D » n'y arrivent pas)
    const t = Math.max(2, Math.round(Math.min(w, hh) * 0.12));
    let top = 0, bot = 0, left = 0, right = 0;
    for (let x = ax; x <= bx; x++) { if (ink(x, ay, ay + t)) top++; if (ink(x, by - t + 1, by + 1)) bot++; }
    for (let y = ay; y <= by; y++) {
      let l = 0, r = 0;
      for (let k = 0; k < t; k++) { l |= D[y * W + ax + k]; r |= D[y * W + bx - k]; }
      left += l; right += r;
    }
    if (top < w * 0.85 || bot < w * 0.85 || left < hh * 0.85 || right < hh * 0.85) continue;
    // coins d'équerre (une lettre comme « D » a des coins arrondis)
    const corner = (cx, cy) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = cx + dx, y = cy + dy; if (x >= ax && x <= bx && y >= ay && y <= by && D[y * W + x]) return true; } return false; };
    if (!corner(ax, ay) || !corner(bx, ay) || !corner(ax, by) || !corner(bx, by)) continue;
    // intérieur vide (une case déjà cochée ou noircie n'est pas proposée)
    const m = Math.round(Math.min(w, hh) * 0.28);
    let inner = 0, area = 0;
    for (let x = ax + m; x <= bx - m; x++) { inner += ink(x, ay + m, by - m + 1); area += by - m + 1 - (ay + m); }
    if (area <= 0 || inner / area > 0.04) continue;
    boxes.push({ x: ax / s, y: ay / s, w: w / s, h: hh / s });
  }

  /* ---------- lignes à compléter : trait fin (plein ou pointillé) avec de la place libre au-dessus ---------- */
  const up0 = Math.round(pt(5)), up1 = Math.round(pt(1.4)); // bande examinée au-dessus du trait
  const gap = Math.round(pt(4)), minLen = pt(15);
  const groups = [];
  let active = [];
  for (let y = up0; y < H; y++) {
    const runs = [];
    let x = 0;
    while (x < W) {
      // pixel « de ligne » : sombre, et rien d'écrit juste au-dessus
      if (!(D[y * W + x] && !ink(x, y - up0, y - up1))) { x++; continue; }
      let a = x, b = x, n = 1, hole = 0;
      for (x++; x < W; x++) {
        if (D[y * W + x] && !ink(x, y - up0, y - up1)) { b = x; n++; hole = 0; }
        else if (D[y * W + x] || ink(x, y - up0, y - up1) || ++hole > gap) break; // de l'encre au-dessus arrête la zone
      }
      // court (« ____ ») : trait plein exigé, sinon le haut d'un mot en petites lettres y ressemblerait
      if (b - a >= minLen && n >= (b - a) * (b - a < pt(30) ? 0.9 : 0.12)) runs.push({ a, b });
      x = b + 1;
    }
    const next = [];
    for (const r of runs) {
      const g = active.find(g => g.y1 === y - 1 && Math.min(g.b, r.b) - Math.max(g.a, r.a) >= Math.max(g.b - g.a, r.b - r.a) * 0.7);
      if (g) { g.y1 = y; g.a = Math.min(g.a, r.a); g.b = Math.max(g.b, r.b); next.push(g); }
      else { const ng = { a: r.a, b: r.b, y0: y, y1: y }; groups.push(ng); next.push(ng); }
    }
    active = next;
  }
  const lines = [];
  const maxT = pt(3), down = Math.round(pt(9));
  for (const g of groups) {
    if (g.y1 - g.y0 + 1 > maxT) continue;
    const len = g.b - g.a + 1;
    // bord supérieur d'un aplat ou d'une image : il y a de l'encre partout juste dessous
    // rien juste en dessous : sinon c'est le haut d'un aplat, d'une image ou d'une ligne de texte
    const b0 = g.y1 + Math.round(pt(2)), b1 = g.y1 + Math.round(pt(4.5));
    let under = 0, cols = 0; for (let x = g.a + 4; x <= g.b - 4; x += 2) { cols++; if (ink(x, b0, b1)) under++; }
    if (cols && under > cols * 0.12) continue;
    // bord supérieur d'un cadre ou d'un tableau : des traits verticaux descendent à ses extrémités, aucun ne monte
    const vert = (xx, y0, y1) => { for (let k = -3; k <= 3; k++) { const x = xx + k; if (x >= 0 && x < W && ink(x, y0, y1) >= (y1 - y0) * 0.9) return true; } return false; };
    const downV = vert(g.a, g.y1 + 1, g.y1 + 1 + down) || vert(g.b, g.y1 + 1, g.y1 + 1 + down);
    const upV = vert(g.a, g.y0 - down, g.y0) || vert(g.b, g.y0 - down, g.y0);
    if (downV && !upV) continue;
    // hauteur libre au-dessus (pour choisir la taille du texte)
    const maxFree = Math.round(pt(26));
    let free = maxFree;
    const xs = []; for (let x = g.a + 3; x <= g.b - 3; x += 3) xs.push(x);
    for (let k = up0; k <= maxFree; k++) { if (xs.some(x => g.y0 - k >= 0 && D[(g.y0 - k) * W + x])) { free = k; break; } if (g.y0 - k < 0) { free = k; break; } }
    if (free < pt(8.5)) continue; // pas la place d'écrire (cellule déjà remplie, texte tout proche)
    lines.push({ x: g.a / s, y: g.y0 / s, w: len / s, free: free / s });
  }
  lines.sort((a, b) => Math.abs(a.y - b.y) < 4 ? a.x - b.x : a.y - b.y);
  return { boxes, lines };
}
