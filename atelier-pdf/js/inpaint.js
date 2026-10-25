// Effacement d'un texte en conservant le fond : seuls les pixels des lettres sont remplacés,
// reconstitués à partir de ce qui les entoure (aplat, dégradé, motif ou photo).
import { state, uid, clamp } from './core.js';
import { pageRaster } from './textdetect.js';

const hex = c => { const m = /^#?([0-9a-f]{6})$/i.exec(c || ''); const n = m ? parseInt(m[1], 16) : 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const dist = (r, g, b, c) => Math.abs(r - c[0]) + Math.abs(g - c[1]) + Math.abs(b - c[2]);

/**
 * Image qui remplace la zone `rect` (points) : le fond d'origine sans les lettres.
 * fg / bg : couleur du texte et couleur dominante du fond (#rrggbb). Renvoie l'identifiant de l'image, ou null.
 */
export async function textErasePatch(page, rect, fg, bg) {
  try {
    const want = clamp(Math.sqrt(1.4e6 / Math.max(1, rect.w * rect.h)), 1.5, 3);
    const { canvas, scale: s } = await pageRaster(page, want);
    const pad = 4; // marge de contexte autour de la zone (points)
    const X0 = clamp(Math.floor((rect.x - pad) * s), 0, canvas.width - 1), Y0 = clamp(Math.floor((rect.y - pad) * s), 0, canvas.height - 1);
    const X1 = clamp(Math.ceil((rect.x + rect.w + pad) * s), X0 + 1, canvas.width), Y1 = clamp(Math.ceil((rect.y + rect.h + pad) * s), Y0 + 1, canvas.height);
    const W = X1 - X0, H = Y1 - Y0;
    const src = canvas.getContext('2d', { willReadFrequently: true }).getImageData(X0, Y0, W, H);
    const d = src.data;
    // zone à traiter (en pixels du découpage)
    const rx0 = Math.max(0, Math.floor(rect.x * s) - X0), ry0 = Math.max(0, Math.floor(rect.y * s) - Y0);
    const rx1 = Math.min(W, Math.ceil((rect.x + rect.w) * s) - X0), ry1 = Math.min(H, Math.ceil((rect.y + rect.h) * s) - Y0);
    const F = hex(fg), B = hex(bg);
    const gap = dist(F[0], F[1], F[2], B);
    // 1. pixels « encre » : plus proches de la couleur du texte que du fond
    // (calculé aussi dans la marge : un accent ou une lettre qui dépasse de la zone ne doit pas « déteindre »)
    const mx0 = 1, my0 = 1, mx1 = W - 1, my1 = H - 1;
    let mask = new Uint8Array(W * H);
    for (let y = my0; y < my1; y++) for (let x = mx0; x < mx1; x++) {
      const i = (y * W + x) * 4;
      const df = dist(d[i], d[i + 1], d[i + 2], F), db = dist(d[i], d[i + 1], d[i + 2], B);
      // proche de la couleur du texte, ou nettement différent du fond (bords adoucis des lettres, scan bruité)
      mask[y * W + x] = gap < 60 ? 1 : (df < gap * 0.75 || db > Math.max(20, gap * 0.07) ? 1 : 0);
    }
    // 2. on élargit un peu (bords adoucis des lettres)
    const r = Math.max(3, Math.round(s * 2));
    const grown = new Uint8Array(W * H);
    for (let y = my0; y < my1; y++) for (let x = mx0; x < mx1; x++) {
      if (!mask[y * W + x]) continue;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= mx0 && yy >= my0 && xx < mx1 && yy < my1) grown[yy * W + xx] = 1;
      }
    }
    mask = grown;
    // 3. reconstitution : chaque pixel masqué prend la moyenne du fond visible autour de lui
    //    (fenêtre qui s'agrandit jusqu'à trouver assez de fond ; les abords immédiats des lettres,
    //    souvent teintés par le scan ou la compression, sont ignorés)
    const ring = r + 1;
    const K = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let ok = !mask[y * W + x];
      for (let dy = -ring; ok && dy <= ring; dy += ring) for (let dx = -ring; dx <= ring; dx += ring) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < W && yy < H && mask[yy * W + xx]) { ok = false; break; }
      }
      K[y * W + x] = ok ? 1 : 0;
    }
    // sommes cumulées (fond seulement) pour des moyennes sur fenêtre en temps constant
    const W1 = W + 1;
    const SN = new Float64Array(W1 * (H + 1)), SR = new Float64Array(W1 * (H + 1)), SG = new Float64Array(W1 * (H + 1)), SB = new Float64Array(W1 * (H + 1));
    for (let y = 0; y < H; y++) {
      let n = 0, rr = 0, gg = 0, bb = 0;
      for (let x = 0; x < W; x++) {
        const k = y * W + x, i = k * 4;
        if (K[k]) { n++; rr += d[i]; gg += d[i + 1]; bb += d[i + 2]; }
        const o = (y + 1) * W1 + x + 1, u = y * W1 + x + 1;
        SN[o] = SN[u] + n; SR[o] = SR[u] + rr; SG[o] = SG[u] + gg; SB[o] = SB[u] + bb;
      }
    }
    const box = (S, x0, y0, x1, y1) => S[y1 * W1 + x1] - S[y0 * W1 + x1] - S[y1 * W1 + x0] + S[y0 * W1 + x0];
    const base = Math.max(4, Math.round(s * 2.5));
    const out8 = new Uint8ClampedArray(d.length); out8.set(d);
    for (let y = my0; y < my1; y++) for (let x = mx0; x < mx1; x++) {
      if (!mask[y * W + x]) continue;
      for (let R = base; ; R *= 2) {
        const x0 = Math.max(0, x - R), y0 = Math.max(0, y - R), x1 = Math.min(W, x + R + 1), y1 = Math.min(H, y + R + 1);
        const n = box(SN, x0, y0, x1, y1);
        if (n >= 12 || R > Math.max(W, H)) {
          const i = (y * W + x) * 4;
          if (n) { out8[i] = box(SR, x0, y0, x1, y1) / n; out8[i + 1] = box(SG, x0, y0, x1, y1) / n; out8[i + 2] = box(SB, x0, y0, x1, y1) / n; }
          else { out8[i] = B[0]; out8[i + 1] = B[1]; out8[i + 2] = B[2]; }
          out8[i + 3] = 255;
          break;
        }
      }
    }
    d.set(out8);
    // 5. image de la zone seule
    const out = document.createElement('canvas');
    out.width = Math.max(1, rx1 - rx0); out.height = Math.max(1, ry1 - ry0);
    const octx = out.getContext('2d');
    octx.putImageData(src, -rx0, -ry0, rx0, ry0, out.width, out.height);
    const asset = { id: uid('a'), dataUrl: out.toDataURL('image/png'), mime: 'image/png', w: out.width, h: out.height, patch: true };
    state.assets.set(asset.id, asset);
    // la zone exacte couverte par l'image (alignée sur les pixels)
    return { img: asset.id, x: (X0 + rx0) / s, y: (Y0 + ry0) / s, w: out.width / s, h: out.height / s };
  } catch (e) {
    console.warn('Effacement du texte', e);
    return null;
  }
}
