// Scanner de documents — calculs purs (utilisés par la page et par le travailleur d'arrière-plan) :
// repérage de la feuille, redressement de la perspective, amélioration de l'image.
// Aucun accès au DOM : ce module fonctionne aussi dans un Worker.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ------------------------------------------------------------ repérage de la feuille */

function grayOf(data, n) {
  const g = new Uint8Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++) g[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  return g;
}
function blur(src, w, h, r) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h), d = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let s = 0; const o = y * w;
    for (let x = -r; x <= r; x++) s += src[o + clamp(x, 0, w - 1)];
    for (let x = 0; x < w; x++) { tmp[o + x] = s / d; s += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)]; }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[clamp(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) { out[y * w + x] = s / d; s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; }
  }
  return out;
}
function otsu(g) {
  const hist = new Float64Array(256);
  for (let i = 0; i < g.length; i++) hist[g[i]]++;
  const n = g.length; let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; t = i; }
  }
  return t;
}
function morph(m, w, h, grow) {
  // érosion (grow=false) ou dilatation (grow=true) 3×3
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = grow ? 0 : 1;
    for (let dy = -1; dy <= 1 && (grow ? !v : v); dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      const p = xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : m[yy * w + xx];
      if (grow && p) { v = 1; break; }
      if (!grow && !p) { v = 0; break; }
    }
    out[y * w + x] = v;
  }
  return out;
}
const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
function hull(pts) {
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}
export function polyArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; }
  return Math.abs(a) / 2;
}
/** Plus grand quadrilatère dont les sommets sont pris parmi ceux du polygone convexe. */
function maxQuad(hp) {
  let p = hp;
  if (p.length > 64) { const step = p.length / 64; p = Array.from({ length: 64 }, (_, i) => hp[Math.floor(i * step)]); }
  const n = p.length;
  if (n < 4) return null;
  let best = -1, res = null;
  const tri = (a, b, c) => Math.abs(cross(a, b, c));
  for (let i = 0; i < n; i++) for (let k = i + 2; k < n; k++) {
    if (i === 0 && k === n - 1) continue;
    let bj = -1, aj = -1;
    for (let j = i + 1; j < k; j++) { const a = tri(p[i], p[j], p[k]); if (a > aj) { aj = a; bj = j; } }
    let bl = -1, al = -1;
    for (let l = k + 1; l < i + n; l++) { const ll = l % n; const a = tri(p[k], p[ll], p[i]); if (a > al) { al = a; bl = ll; } }
    if (bj < 0 || bl < 0) continue;
    if (aj + al > best) { best = aj + al; res = [p[i], p[bj], p[k], p[bl]]; }
  }
  return res;
}
/** Remet les coins dans l'ordre : haut-gauche, haut-droite, bas-droite, bas-gauche. */
export function orderCorners(q) {
  const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
  const byAngle = [...q].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  // angle croissant depuis -π : haut-gauche en premier dans un repère où y descend
  let start = 0, bestS = Infinity;
  byAngle.forEach((p, i) => { const s = p[0] + p[1]; if (s < bestS) { bestS = s; start = i; } });
  return [0, 1, 2, 3].map(i => byAngle[(start + i) % 4]);
}

function largestQuad(m, w, h) {
  const n = w * h;
  m = morph(morph(m, w, h, false), w, h, false);
  m = morph(morph(m, w, h, true), w, h, true);
  const lab = new Int32Array(n), stack = new Int32Array(n);
  let bestId = 0, bestScore = 0, bestArea = 0, id = 0;
  const cx = w / 2, cy = h / 2;
  for (let s = 0; s < n; s++) {
    if (!m[s] || lab[s]) continue;
    id++; let top = 0, area = 0, center = 0; stack[top++] = s; lab[s] = id;
    while (top) {
      const i = stack[--top]; area++;
      const x = i % w, y = (i / w) | 0;
      if (Math.abs(x - cx) < w * 0.15 && Math.abs(y - cy) < h * 0.15) center++;
      if (x > 0 && m[i - 1] && !lab[i - 1]) { lab[i - 1] = id; stack[top++] = i - 1; }
      if (x < w - 1 && m[i + 1] && !lab[i + 1]) { lab[i + 1] = id; stack[top++] = i + 1; }
      if (i >= w && m[i - w] && !lab[i - w]) { lab[i - w] = id; stack[top++] = i - w; }
      if (i < n - w && m[i + w] && !lab[i + w]) { lab[i + w] = id; stack[top++] = i + w; }
    }
    const sc = area * (1 + center / (n * 0.09));   // la feuille est en général au centre de la photo
    if (sc > bestScore) { bestScore = sc; bestId = id; bestArea = area; }
  }
  if (bestArea < n * 0.1 || bestArea > n * 0.97) return null;
  const pts = [];
  for (let y = 0; y < h; y++) {
    let a = -1, b = -1;
    for (let x = 0; x < w; x++) if (lab[y * w + x] === bestId) { if (a < 0) a = x; b = x; }
    if (a >= 0) { pts.push([a, y]); if (b !== a) pts.push([b + 1, y]); }
  }
  const hp = hull(pts);
  const hArea = polyArea(hp);
  if (bestArea / hArea < 0.5) return null;
  const q = maxQuad(hp);
  if (!q) return null;
  const qa = polyArea(q);
  if (qa < n * 0.1 || qa / hArea < 0.78) return null;
  return orderCorners(q);
}
function sobel(g, w, h) {
  const G = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1];
    const gy = g[i + w - 1] + 2 * g[i + w] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - w] - g[i - w + 1];
    G[i] = Math.hypot(gx, gy) / 4;
  }
  return G;
}
/** Netteté du bord entre deux coins : la feuille a des bords francs, pas une zone de texte. */
function sideScore(G, w, h, a, b) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
  let s = 0; const N = 40;
  for (let k = 1; k < N; k++) {
    const t = k / N, x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
    let best = 0;
    for (let d = -2; d <= 2; d++) {
      const xx = Math.round(x + nx * d), yy = Math.round(y + ny * d);
      if (xx < 1 || yy < 1 || xx >= w - 1 || yy >= h - 1) continue;
      const v = G[yy * w + xx]; if (v > best) best = v;
    }
    s += best;
  }
  return s / (N - 1);
}
function quadScore(G, w, h, q) {
  const s = [0, 1, 2, 3].map(i => sideScore(G, w, h, q[i], q[(i + 1) % 4]));
  return { mean: (s[0] + s[1] + s[2] + s[3]) / 4, min: Math.min(...s) };
}
/** Ajuste chaque coin (± 4 px) pour coller au mieux aux bords francs. */
function refine(G, w, h, q) {
  q = q.map(p => [...p]);
  for (let pass = 0; pass < 3; pass++) {
    for (let c = 0; c < 4; c++) {
      const prev = q[(c + 3) % 4], next = q[(c + 1) % 4];
      let best = sideScore(G, w, h, prev, q[c]) + sideScore(G, w, h, q[c], next), bp = q[c];
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        if (!dx && !dy) continue;
        const p = [clamp(q[c][0] + dx, 0, w), clamp(q[c][1] + dy, 0, h)];
        const v = sideScore(G, w, h, prev, p) + sideScore(G, w, h, p, next);
        if (v > best) { best = v; bp = p; }
      }
      q[c] = bp;
    }
  }
  return q;
}

/**
 * Cherche la feuille dans une petite image (≈ 400 px). Renvoie 4 coins normalisés (0..1) ou null.
 * Deux hypothèses sont essayées — « la feuille est plus claire que le fond » et « la feuille diffère du
 * fond visible sur les bords de la photo » — puis la meilleure est retenue d'après la netteté de ses bords.
 */
export function detectQuad(data, w, h, debug) {
  const n = w * h;
  const g = blur(grayOf(data, n), w, h, 2);
  const G = sobel(g, w, h);
  const cands = [];
  // 1. zones claires
  const t = otsu(g);
  const m1 = new Uint8Array(n);
  for (let i = 0; i < n; i++) m1[i] = g[i] > t ? 1 : 0;
  cands.push(largestQuad(m1, w, h));
  // 2. tout ce qui ne ressemble pas au fond (couleurs présentes sur le pourtour de la photo)
  const bin = new Uint16Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++) bin[j] = (data[i] >> 5) << 6 | (data[i + 1] >> 5) << 3 | (data[i + 2] >> 5);
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  const cnt = new Uint32Array(512); let tot = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x >= band && x < w - band && y >= band && y < h - band) continue;
    cnt[bin[y * w + x]]++; tot++;
  }
  const bgBin = new Uint8Array(512);
  for (let b = 0; b < 512; b++) if (cnt[b] > tot * 0.01) {
    const r = b >> 6, gg = (b >> 3) & 7, bb = b & 7;
    for (let dr = -1; dr <= 1; dr++) for (let dg = -1; dg <= 1; dg++) for (let db = -1; db <= 1; db++) {
      const R = r + dr, Gq = gg + dg, B = bb + db;
      if (R < 0 || Gq < 0 || B < 0 || R > 7 || Gq > 7 || B > 7) continue;
      if (Math.abs(dr) + Math.abs(dg) + Math.abs(db) <= 1) bgBin[R << 6 | Gq << 3 | B] = 1;
    }
  }
  const m2 = new Uint8Array(n);
  for (let j = 0; j < n; j++) m2[j] = bgBin[bin[j]] ? 0 : 1;
  cands.push(largestQuad(m2, w, h));
  const info = [];
  for (const c of cands) {
    if (!c) { info.push(null); continue; }
    const q = refine(G, w, h, c);
    info.push({ q, sc: quadScore(G, w, h, q), area: polyArea(q) });
  }
  if (debug) debug.cands = info;
  const ok = info.filter(Boolean);
  const top = Math.max(0, ...ok.map(c => c.sc.mean));
  // un bandeau sombre en haut de la feuille crée un bord net À L'INTÉRIEUR de la feuille :
  // parmi les contours bien nets, on garde le plus grand
  const strong = ok.filter(c => c.sc.min >= 15 && c.sc.mean >= top * 0.6).sort((x, y) => y.area - x.area);
  let best = strong[0]?.q;
  if (!best) { const weak = ok.filter(c => c.sc.min >= 8).sort((x, y) => y.sc.mean - x.sc.mean); best = weak[0]?.q; }
  if (!best) return null;
  return best.map(([x, y]) => [clamp(x / w, 0, 1), clamp(y / h, 0, 1)]);
}

/* ------------------------------------------------------------ redressement */

/** Matrice qui envoie le rectangle (0,0)-(W,H) sur le quadrilatère q (coins en pixels, ordre HG, HD, BD, BG). */
export function homography(W, H, q) {
  const src = [[0, 0], [W, 0], [W, H], [0, H]];
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = q[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  // élimination de Gauss
  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}

/** Taille naturelle (en pixels source) de la feuille redressée. */
export function quadSize(q) {
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  return { w: (d(q[0], q[1]) + d(q[3], q[2])) / 2, h: (d(q[0], q[3]) + d(q[1], q[2])) / 2 };
}

/** Redresse : src (RGBA sw×sh) → nouvelle image W×H, échantillonnage bilinéaire. */
export function warp(src, sw, sh, q, W, H) {
  const out = new Uint8ClampedArray(W * H * 4);
  const [a, b, c, d, e, f, g, hh] = homography(W, H, q);
  let o = 0;
  for (let y = 0; y < H; y++) {
    const yy = y + 0.5;
    for (let x = 0; x < W; x++, o += 4) {
      const xx = x + 0.5;
      const den = g * xx + hh * yy + 1;
      let u = (a * xx + b * yy + c) / den - 0.5, v = (d * xx + e * yy + f) / den - 0.5;
      if (u < 0) u = 0; else if (u > sw - 1.001) u = sw - 1.001;
      if (v < 0) v = 0; else if (v > sh - 1.001) v = sh - 1.001;
      const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      out[o] = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
      out[o + 1] = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
      out[o + 2] = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
      out[o + 3] = 255;
    }
  }
  return out;
}

/* ------------------------------------------------------------ amélioration */

/**
 * Éclairage du papier estimé par blocs : la teinte claire dominante de chaque bloc, en ignorant les
 * blocs sombres (photos, bandeaux), complétée par voisinage puis lissée. Sert à effacer les ombres.
 */
function paperLight(Y, W, H) {
  const bs = Math.max(8, Math.round(Math.max(W, H) / 48));
  const gw = Math.ceil(W / bs), gh = Math.ceil(H / bs);
  const v = new Float32Array(gw * gh);
  const hist = new Uint32Array(256);
  for (let by = 0; by < gh; by++) for (let bx = 0; bx < gw; bx++) {
    hist.fill(0);
    const x0 = bx * bs, y0 = by * bs, x1 = Math.min(W, x0 + bs), y1 = Math.min(H, y0 + bs);
    let cnt = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { hist[Y[y * W + x]]++; cnt++; }
    let acc = 0, k = 255; const lim = cnt * 0.08;
    while (k > 0 && acc + hist[k] < lim) acc += hist[k--];
    v[by * gw + bx] = k;
  }
  const sorted = Array.from(v).sort((a, b) => a - b);
  const ref = sorted[Math.floor(sorted.length * 0.9)] || 255;
  const ok = new Uint8Array(gw * gh);
  for (let i = 0; i < v.length; i++) ok[i] = v[i] > ref * 0.55 ? 1 : 0;
  // blocs sans papier : valeur des voisins
  for (let pass = 0; pass < 80; pass++) {
    let changed = 0; const nv = v.slice(), nok = ok.slice();
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const i = y * gw + x; if (ok[i]) continue;
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
        const j = yy * gw + xx; if (ok[j]) { s += v[j]; c++; }
      }
      if (c) { nv[i] = s / c; nok[i] = 1; changed++; }
    }
    v.set(nv); ok.set(nok);
    if (!changed) break;
  }
  for (let i = 0; i < v.length; i++) if (!ok[i]) v[i] = ref;
  // lissage
  for (let pass = 0; pass < 3; pass++) {
    const nv = new Float32Array(v.length);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
        s += v[yy * gw + xx]; c++;
      }
      nv[y * gw + x] = s / c;
    }
    v.set(nv);
  }
  return { v, gw, gh, bs };
}

/**
 * Filtres : 'color' (photo d'origine), 'doc' (papier blanchi, ombres effacées, couleurs gardées),
 * 'gray' (niveaux de gris nets), 'bw' (noir et blanc, idéal pour du texte).
 */
export function enhance(px, W, H, mode) {
  if (mode === 'color') return px;
  const n = W * H;
  const Y = new Uint8Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++) Y[j] = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
  const { v, gw, gh, bs } = paperLight(Y, W, H);
  const LO = mode === 'bw' ? 0 : 28, HI = mode === 'bw' ? 255 : 228, k = 255 / (HI - LO);
  for (let y = 0; y < H; y++) {
    const gy = clamp((y + 0.5) / bs - 0.5, 0, gh - 1), y0 = gy | 0, y1 = Math.min(gh - 1, y0 + 1), fy = gy - y0;
    for (let x = 0; x < W; x++) {
      const gx = clamp((x + 0.5) / bs - 0.5, 0, gw - 1), x0 = gx | 0, x1 = Math.min(gw - 1, x0 + 1), fx = gx - x0;
      const bg = (v[y0 * gw + x0] * (1 - fx) + v[y0 * gw + x1] * fx) * (1 - fy) + (v[y1 * gw + x0] * (1 - fx) + v[y1 * gw + x1] * fx) * fy;
      const s = Math.min(3, 245 / Math.max(bg, 24));
      const j = y * W + x, i = j * 4;
      if (mode === 'doc') {
        let r = px[i] * s, g = px[i + 1] * s, b = px[i + 2] * s;
        const l = (r * 77 + g * 150 + b * 29) / 256;
        // couleurs un peu plus franches
        r = l + (r - l) * 1.18; g = l + (g - l) * 1.18; b = l + (b - l) * 1.18;
        px[i] = (r - LO) * k; px[i + 1] = (g - LO) * k; px[i + 2] = (b - LO) * k;
      } else if (mode === 'gray') {
        const l = (Y[j] * s - LO) * k;
        px[i] = px[i + 1] = px[i + 2] = l;
      } else {
        const l = Y[j] * s, T = 200;
        const o = clamp((l - (T - 16)) / 32, 0, 1) * 255;
        px[i] = px[i + 1] = px[i + 2] = o;
      }
    }
  }
  return px;
}

/* ------------------------------------------------------------ qualités du PDF */
export const QUALITIES = {
  low: { label: 'Faible', long: 1240, q: 0.5, dpi: '≈ 150 ppp', hint: 'Fichier léger : WhatsApp, e-mail.' },
  medium: { label: 'Moyenne', long: 1754, q: 0.7, dpi: '≈ 200 ppp', hint: 'Bon compromis : lecture à l\'écran et impression courante.' },
  high: { label: 'Élevée', long: 2480, q: 0.88, dpi: '≈ 300 ppp', hint: 'Impression soignée et archivage.' },
};

/** Format de la page PDF (points) : A4 si la feuille en a les proportions. */
export function pdfPageSize(w, h) {
  const A4W = 595.28, A4H = 841.89;
  const a = w / h;
  if (a <= 1) {
    const ph = A4W / a;
    return Math.abs(ph / A4H - 1) < 0.06 ? [A4W, A4H] : [A4W, ph];
  }
  const pw = A4W * a;
  return Math.abs(pw / A4H - 1) < 0.06 ? [A4H, A4W] : [pw, A4W];
}
