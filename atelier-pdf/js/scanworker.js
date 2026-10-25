// Travailleur d'arrière-plan du scanner : les calculs lourds (redressement, filtres, compression)
// ne bloquent pas l'écran.
import { detectQuad, warp, enhance, quadSize } from './scancore.js';

const DETECT_SIZE = 420;

async function decode(blob, maxLong) {
  let bmp = await createImageBitmap(blob);
  const long = Math.max(bmp.width, bmp.height);
  if (maxLong && long > maxLong) {
    const s = maxLong / long, w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
    const small = await createImageBitmap(bmp, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
    bmp.close(); bmp = small;
  }
  return bmp;
}
function pixels(bmp) {
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height);
}

async function detect({ blob }) {
  const full = await createImageBitmap(blob);
  const W = full.width, H = full.height;
  const s = DETECT_SIZE / Math.max(W, H);
  const small = await createImageBitmap(full, { resizeWidth: Math.round(W * s), resizeHeight: Math.round(H * s), resizeQuality: 'medium' });
  full.close();
  const img = pixels(small); small.close();
  return { quad: detectQuad(img.data, img.width, img.height), w: W, h: H };
}

/**
 * Produit l'image finale d'une page : redressée, tournée, filtrée, compressée.
 * quad : coins normalisés ; maxLong : plus grand côté voulu (pixels) ; q : qualité JPEG.
 */
async function render({ blob, srcW, srcH, quad, rot = 0, filter = 'doc', maxLong = 1600, q = 0.85 }) {
  const qs = quadSize(quad.map(([x, y]) => [x * srcW, y * srcH]));
  const natLong = Math.max(qs.w, qs.h);
  const outScale = Math.min(1, maxLong / natLong);
  // la photo est décodée un peu plus grande que le résultat (netteté), jamais plus que nécessaire
  const decodeLong = Math.min(Math.max(srcW, srcH), Math.ceil(Math.max(srcW, srcH) * outScale * 1.4));
  const bmp = await decode(blob, decodeLong);
  const sw = bmp.width, sh = bmp.height;
  const src = pixels(bmp); bmp.close();
  const sq = quad.map(([x, y]) => [x * sw, y * sh]);
  const W = Math.max(8, Math.round(qs.w * outScale)), H = Math.max(8, Math.round(qs.h * outScale));
  const out = enhance(warp(src.data, sw, sh, sq, W, H), W, H, filter);
  let canvas = new OffscreenCanvas(W, H);
  canvas.getContext('2d').putImageData(new ImageData(out, W, H), 0, 0);
  if (rot % 360) {
    const r = ((rot % 360) + 360) % 360, sideways = r === 90 || r === 270;
    const c2 = new OffscreenCanvas(sideways ? H : W, sideways ? W : H);
    const ctx = c2.getContext('2d');
    ctx.translate(c2.width / 2, c2.height / 2); ctx.rotate(r * Math.PI / 180); ctx.drawImage(canvas, -W / 2, -H / 2);
    canvas = c2;
  }
  const res = await canvas.convertToBlob({ type: 'image/jpeg', quality: q });
  return { blob: res, w: canvas.width, h: canvas.height };
}

self.onmessage = async e => {
  const { id, cmd, args } = e.data;
  try {
    const result = cmd === 'detect' ? await detect(args) : await render(args);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
