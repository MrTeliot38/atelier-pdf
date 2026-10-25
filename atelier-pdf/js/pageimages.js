// Images contenues dans le PDF (photo convertie en PDF, scan, logo…) : repérage et « détachement »
// En mode Sélection, un clic sur une image du document la transforme en élément déplaçable,
// redimensionnable, remplaçable ou supprimable. L'emplacement d'origine est recouvert par la couleur du fond.
import { state, on, h, uid, clamp, pdfjsLib, mul, findObject, pageById, toast } from './core.js';
import { getSlot, slots, isNear, renderObjects } from './viewer.js';
import { getLines, sampleColors, hasOcr, runOcr } from './textdetect.js';
import { detectRegions, cachedRegions, cutRegion } from './pageregions.js';

const cache = new Map(); // "src|index" -> Promise<[images]>
const OPS = pdfjsLib.OPS;

/** Images placées sur une page PDF : [{ id, x, y, w, h, m, objId, inline, imgW, imgH }] (en points, repère de la page affichée). */
export function pageImages(page) {
  if (!page.src) return Promise.resolve([]);
  const key = page.src + '|' + page.index;
  if (!cache.has(key)) cache.set(key, scan(page).catch(e => { console.warn('Images de la page', e); return []; }));
  return cache.get(key);
}

async function scan(page) {
  const src = state.sources.get(page.src);
  const pdfPage = await src.pdf.getPage(page.index + 1);
  const ops = await pdfPage.getOperatorList();
  const vt = src.views[page.index].transform;
  const out = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const seen = new Map();
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i];
    switch (fn) {
      case OPS.save: stack.push(ctm); break;
      case OPS.restore: ctm = stack.pop() || [1, 0, 0, 1, 0, 0]; break;
      case OPS.transform: ctm = mul(ctm, args); break;
      case OPS.paintFormXObjectBegin: stack.push(ctm); if (args[0]) ctm = mul(ctm, args[0]); break;
      case OPS.paintFormXObjectEnd: ctm = stack.pop() || [1, 0, 0, 1, 0, 0]; break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject: {
        const m = mul(vt, ctm);
        const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        // limité à la page
        x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(page.w, x1); y1 = Math.min(page.h, y1);
        if (x1 - x0 < 6 || y1 - y0 < 6) break;
        const inline = fn === OPS.paintInlineImageXObject ? args[0] : null;
        const objId = inline ? null : args[0];
        const k = objId || 'inline' + i;
        seen.set(k, (seen.get(k) || 0) + 1);
        out.push({ id: page.src + '|' + page.index + '|' + i, x: x0, y: y0, w: x1 - x0, h: y1 - y0, fx: Math.min(...xs), fy: Math.min(...ys),
          fw: Math.max(...xs) - Math.min(...xs), fh: Math.max(...ys) - Math.min(...ys), m, objId, inline,
          imgW: inline ? inline.width : args[1], imgH: inline ? inline.height : args[2], pdfPage });
        break;
      }
    }
  }
  // une image de fond (presque toute la page) avec du texte posé dessus n'est pas proposée :
  // la détacher ferait disparaître ce texte
  const area = page.w * page.h;
  let lines = [];
  if (out.some(im => im.w * im.h > area * 0.6)) { try { lines = (await getLines(page)).lines.filter(l => !l.ocr); } catch {} }
  return out.filter(im => {
    if (im.w * im.h <= area * 0.6 || !lines.length) return true;
    return !lines.some(l => { const cx = l.x + l.w / 2, cy = (l.top + l.bottom) / 2; return cx > im.x && cx < im.x + im.w && cy > im.y && cy < im.y + im.h; });
  });
}

/* ------------------------------------------------ pixels de l'image */
function getObj(pdfPage, id) {
  const store = id.startsWith('g_') ? pdfPage.commonObjs : pdfPage.objs;
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('Image indisponible')), 8000);
    try {
      if (store.has(id)) { clearTimeout(t); res(store.get(id)); }
      else store.get(id, v => { clearTimeout(t); res(v); });
    } catch (e) { clearTimeout(t); rej(e); }
  });
}
function toDrawable(img) {
  if (!img) throw new Error('Image vide');
  if (img.bitmap) return img.bitmap;
  if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) return img;
  const { width: w, height: hh, data, kind } = img;
  const c = document.createElement('canvas'); c.width = w; c.height = hh;
  const ctx = c.getContext('2d'); const id = ctx.createImageData(w, hh); const d = id.data;
  if (kind === pdfjsLib.ImageKind.RGBA_32BPP) d.set(data.subarray(0, d.length));
  else if (kind === pdfjsLib.ImageKind.RGB_24BPP) {
    for (let i = 0, j = 0; j < d.length; i += 3, j += 4) { d[j] = data[i]; d[j + 1] = data[i + 1]; d[j + 2] = data[i + 2]; d[j + 3] = 255; }
  } else { // GRAYSCALE_1BPP : 1 bit par pixel, lignes complétées à l'octet
    const rowBytes = (w + 7) >> 3;
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
      const on = data[y * rowBytes + (x >> 3)] & (128 >> (x & 7)), j = (y * w + x) * 4;
      d[j] = d[j + 1] = d[j + 2] = on ? 255 : 0; d[j + 3] = 255;
    }
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

/** Dessine l'image telle qu'elle apparaît sur la page (rotation, miroir…) et renvoie une image (data URL). */
async function extract(im) {
  const raw = im.inline || await getObj(im.pdfPage, im.objId);
  const src = toDrawable(raw);
  const k = clamp(Math.max(im.imgW / im.fw, im.imgH / im.fh), 1, 5);
  let W = Math.max(1, Math.round(im.fw * k)), H = Math.max(1, Math.round(im.fh * k));
  const maxPx = 16e6;
  let kk = k;
  if (W * H > maxPx) { const r = Math.sqrt(maxPx / (W * H)); W = Math.round(W * r); H = Math.round(H * r); kk = k * r; }
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(kk, 0, 0, kk, -im.fx * kk, -im.fy * kk);
  ctx.transform(...im.m);
  ctx.transform(1, 0, 0, -1, 0, 1);
  ctx.drawImage(src, 0, 0, 1, 1);
  // transparence ? (PNG) sinon JPEG, plus léger pour les photos
  const d = ctx.getImageData(0, 0, W, H).data;
  let alpha = false;
  for (let i = 3; i < d.length; i += 4 * 7) if (d[i] < 250) { alpha = true; break; }
  const mime = alpha ? 'image/png' : 'image/jpeg';
  return { dataUrl: c.toDataURL(mime, 0.92), mime, w: W, h: H };
}

/** Transforme une image du document en élément modifiable ; renvoie l'objet créé. */
export async function liftImage(page, im) {
  if (im.region) {
    // zone repérée dans une page-image : découpe de la page, fond extérieur rendu transparent
    const { asset, rect, color } = await cutRegion(page, im);
    state.assets.set(asset.id, asset);
    const col = /^#(f[89a-f]){3}$/i.test(color) ? '#ffffff' : color;
    const o = { id: uid(), type: 'image', kind: 'image', origin: 'lift', asset: asset.id, ...rect,
      cover: { x: rect.x - 0.5, y: rect.y - 0.5, w: rect.w + 1, h: rect.h + 1, color: col }, orig: { ...rect, asset: asset.id } };
    page.objects.unshift(o);
    return o;
  }
  const pic = await extract(im);
  const asset = { id: uid('a'), ...pic };
  state.assets.set(asset.id, asset);
  const full = im.w * im.h >= page.w * page.h * 0.85;
  let color = full ? '#ffffff' : (await sampleColors(page, im)).bg;
  if (/^#(f[89a-f]){3}$/i.test(color)) color = '#ffffff'; // quasi blanc → blanc franc
  const m = 1.2; // marge : les bords lissés de l'image ne doivent pas dépasser
  const cover = { x: im.x - m, y: im.y - m, w: im.w + 2 * m, h: im.h + 2 * m, color };
  const o = { id: uid(), type: 'image', kind: 'image', origin: 'lift', asset: asset.id,
    x: im.fx, y: im.fy, w: im.fw, h: im.fh, cover, orig: { x: im.fx, y: im.fy, w: im.fw, h: im.fh, asset: asset.id } };
  // sous les éléments déjà ajoutés (textes corrigés, signatures…) : ils restent visibles et cliquables
  page.objects.unshift(o);
  return o;
}

/** Une image détachée mais ni déplacée ni modifiée n'a pas besoin d'exister : on la remet en place. */
export function isPristineLift(o) {
  return o && o.origin === 'lift' && o.type === 'image' && o.orig && o.asset === o.orig.asset &&
    Math.abs(o.x - o.orig.x) < 0.01 && Math.abs(o.y - o.orig.y) < 0.01 && Math.abs(o.w - o.orig.w) < 0.01 && Math.abs(o.h - o.orig.h) < 0.01;
}

/* ------------------------------------------------ calque des images (mode Sélection) */
const tokens = new Map();
export async function renderImageLayer(pageId) {
  const s = getSlot(pageId); if (!s) return;
  if (!s.imgs) { s.imgs = h('div', { class: 'layer layer-images' }); s.pageEl.insertBefore(s.imgs, s.forms); }
  if (state.tool !== 'select') { s.imgs.replaceChildren(); return; }
  const token = {}; tokens.set(pageId, token);
  let list = await pageImages(s.page);
  if (tokens.get(pageId) !== token || state.tool !== 'select') return;
  // page qui n'est qu'une image (tract aplati, scan) : on repère les dessins qu'elle contient
  const page = s.page;
  const fullImg = list.some(im => im.w * im.h >= page.w * page.h * 0.85);
  const wanted = fullImg || wantRegions.has(page.id);
  let regions = cachedRegions(page);
  const textKnown = hasOcr(page) || (await getLines(page)).kind === 'native';
  if (wanted && !regions && textKnown) {
    regions = await detectRegions(page, { exclude: list.filter(im => im.w * im.h < page.w * page.h * 0.85) });
    if (tokens.get(pageId) !== token || state.tool !== 'select') return;
  }
  if (regions) list = [...list, ...regions];
  showRegionBanner(s, page, wanted && !regions && !textKnown);
  const z = state.zoom;
  const covers = s.page.objects.filter(o => o.cover).map(o => o.cover);
  const frag = document.createDocumentFragment();
  for (const im of list) {
    if (covers.some(c => overlap(im, c) > 0.8)) continue;
    const full = !im.region && im.w * im.h >= s.page.w * s.page.h * 0.85;
    const el = h('div', { class: 'pimg' + (full ? ' full' : '') + (im.region ? ' region' : ''), title: full ? 'Image de la page entière : faites-la glisser ou double-cliquez pour la sélectionner' : 'Image du document : cliquez pour la sélectionner, la déplacer ou la supprimer' });
    Object.assign(el.style, { left: im.x * z + 'px', top: im.y * z + 'px', width: im.w * z + 'px', height: im.h * z + 'px' });
    el._img = im;
    frag.append(el);
  }
  s.imgs.replaceChildren(frag);
}
/* ---- repérage à la demande ---- */
const wantRegions = new Set();
function showRegionBanner(s, page, show) {
  if (!s.imgBanner) { s.imgBanner = h('div', { class: 'img-banner' }); s.slot.append(s.imgBanner); }
  s.imgBanner.classList.toggle('show', show && state.tool === 'select');
  if (!show || s.imgBanner.dataset.busy) return;
  s.imgBanner.replaceChildren(h('span', {}, 'Les images de cette page ne sont pas encore repérées.'),
    h('button', { class: 'btn small primary', onclick: () => findRegions(page) }, 'Repérer les images'));
}
/** Lit le texte si besoin, puis repère les images de la page (bouton du bandeau ou du panneau). */
export async function findRegions(page) {
  wantRegions.add(page.id);
  const s = getSlot(page.id);
  const status = h('span', {}, 'Lecture de la page…');
  if (s?.imgBanner) { s.imgBanner.dataset.busy = '1'; s.imgBanner.replaceChildren(h('span', { class: 'spinner' }), status); s.imgBanner.classList.add('show'); }
  try {
    if (!hasOcr(page) && (await getLines(page)).kind !== 'native') {
      await runOcr(page, m => {
        const pct = Math.round((m.progress || 0) * 100);
        status.textContent = m.status === 'refining' ? `Vérification… ${pct} %` : m.status === 'recognizing text' ? `Lecture de la page… ${pct} %` : 'Chargement du moteur de lecture…';
      });
    }
    status.textContent = 'Repérage des images…';
    const n = (await detectRegions(page)).length;
    toast(n ? `${n} image${n > 1 ? 's' : ''} repérée${n > 1 ? 's' : ''} : ${matchMedia('(pointer: coarse)').matches ? 'touchez une image pour la déplacer ou la supprimer.' : 'survolez la page, puis cliquez sur une image pour la déplacer ou la supprimer.'}` : 'Aucune image repérée sur cette page.', { duration: 7000 });
  } catch (e) { console.error(e); toast('Le repérage des images a échoué.', { error: true }); }
  if (s?.imgBanner) { delete s.imgBanner.dataset.busy; s.imgBanner.classList.remove('show'); }
  renderImageLayer(page.id);
}

function overlap(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), hh = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && hh > 0 ? (w * hh) / (a.w * a.h || 1) : 0;
}
export function refreshImageLayers() {
  for (const s of slots.values()) if (isNear(s.page.id) || state.tool !== 'select') renderImageLayer(s.page.id);
}

export function initPageImages() {
  on('tool', refreshImageLayers);
  on('zoom', refreshImageLayers);
  on('pages-changed', refreshImageLayers);
  on('objects-changed', refreshImageLayers);
  on('restored', refreshImageLayers);
  on('page-near', id => renderImageLayer(id));
  // une image détachée puis laissée telle quelle reprend sa place d'origine
  let last = null;
  on('selection', () => {
    if (last && last !== state.selected) {
      const f = findObject(last);
      if (f && isPristineLift(f.obj)) {
        f.page.objects.splice(f.page.objects.indexOf(f.obj), 1);
        renderObjects(f.page.id); renderImageLayer(f.page.id);
      }
    }
    last = state.selected;
  });
}
export { pageById };
