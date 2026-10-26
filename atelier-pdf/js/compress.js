// Réduire la taille d'un PDF : les images trop grandes sont réduites et recompressées, le texte reste du
// texte (sélectionnable, net à l'impression). En option : toutes les pages converties en images.
import { state, h, toast, PDFLib, pdfjsLib, PDFJS_OPTS, downloadBlob } from './core.js';
import { modal } from './ui.js';
import { buildPdf } from './export.js';
import { canShareFiles, shareBlob, isAndroidApp, saveBlob } from './platform.js';

const LEVELS = {
  light: { label: 'Légère', dpi: 200, q: 0.85, hint: 'Qualité d\'impression conservée.' },
  medium: { label: 'Moyenne', dpi: 150, q: 0.72, hint: 'Bon compromis pour l\'e-mail.' },
  strong: { label: 'Forte', dpi: 110, q: 0.55, hint: 'Le plus léger : WhatsApp, lecture à l\'écran.' },
};
const fmt = b => b < 1024 * 1024 ? Math.max(1, Math.round(b / 1024)) + ' Ko' : (b / 1024 / 1024).toFixed(1).replace('.', ',') + ' Mo';
const { PDFName, PDFNumber, PDFRawStream, PDFDict, PDFArray, PDFRef, decodePDFRawStream } = PDFLib;

const RAW_FILTERS = new Set(['FlateDecode', 'ASCII85Decode', 'ASCIIHexDecode', 'LZWDecode', 'RunLengthDecode']);
const nameOf = (dict, key) => { const v = dict.get(PDFName.of(key)); return v instanceof PDFName ? v.asString().slice(1) : null; };
function filters(dict) {
  const f = dict.get(PDFName.of('Filter'));
  if (f instanceof PDFName) return [f.asString().slice(1)];
  if (f instanceof PDFArray) return f.asArray().map(x => x instanceof PDFName ? x.asString().slice(1) : '?');
  return [];
}
/** Nombre de composantes de couleur (1 gris, 3 RVB), ou 0 si l'espace de couleur n'est pas pris en charge. */
function components(ctx, dict) {
  let cs = dict.get(PDFName.of('ColorSpace'));
  if (cs instanceof PDFRef) cs = ctx.lookup(cs);
  if (cs instanceof PDFName) { const n = cs.asString(); return n === '/DeviceRGB' ? 3 : n === '/DeviceGray' ? 1 : 0; }
  if (cs instanceof PDFArray && cs.size() === 2) {
    const kind = cs.get(0);
    if (kind instanceof PDFName && kind.asString() === '/ICCBased') {
      let icc = cs.get(1); if (icc instanceof PDFRef) icc = ctx.lookup(icc);
      const n = icc?.dict?.get(PDFName.of('N'));
      const v = n instanceof PDFNumber ? n.asNumber() : 0;
      return v === 3 || v === 1 ? v : 0;
    }
  }
  return 0;
}

async function toJpeg(source, w, h, maxPx, q) {
  const s = Math.min(1, maxPx / Math.max(w, h));
  const W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
  x.imageSmoothingQuality = 'high';
  x.drawImage(source, 0, 0, W, H);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q));
  c.width = c.height = 0;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), w: W, h: H };
}

/** Recompresse les images d'un PDF (le reste du document est inchangé). */
export async function optimizeImages(bytes, { dpi, q }, onProgress) {
  const doc = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  let maxSide = 0;
  for (const p of doc.getPages()) { const { width, height } = p.getSize(); maxSide = Math.max(maxSide, width, height); }
  const maxPx = Math.ceil(maxSide / 72 * dpi);
  const images = ctx.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && nameOf(o.dict, 'Subtype') === 'Image');
  let done = 0, changed = 0;
  for (const [ref, img] of images) {
    done++; onProgress?.(done / images.length);
    const d = img.dict;
    if (d.get(PDFName.of('ImageMask')) || d.get(PDFName.of('Decode')) || d.get(PDFName.of('Mask'))) continue;
    const bpc = d.get(PDFName.of('BitsPerComponent')), w = d.get(PDFName.of('Width')), hh = d.get(PDFName.of('Height'));
    if (!(w instanceof PDFNumber) || !(hh instanceof PDFNumber)) continue;
    const W = w.asNumber(), H = hh.asNumber();
    const n = components(ctx, d);
    if (!n || W * H < 40000) continue; // très petites images : rien à gagner
    const f = filters(d);
    let source = null;
    try {
      if (f.length === 1 && f[0] === 'DCTDecode') {
        source = await createImageBitmap(new Blob([img.contents], { type: 'image/jpeg' }));
      } else if (f.length && f.every(x => RAW_FILTERS.has(x)) && bpc instanceof PDFNumber && bpc.asNumber() === 8 && !d.get(PDFName.of('DecodeParms'))) {
        const raw = decodePDFRawStream(img).decode();
        if (raw.length < W * H * n) continue;
        const data = new Uint8ClampedArray(W * H * 4);
        for (let i = 0, j = 0; i < W * H; i++, j += n) {
          data[i * 4] = raw[j]; data[i * 4 + 1] = raw[j + (n === 3 ? 1 : 0)]; data[i * 4 + 2] = raw[j + (n === 3 ? 2 : 0)]; data[i * 4 + 3] = 255;
        }
        source = await createImageBitmap(new ImageData(data, W, H));
      } else continue;
      const out = await toJpeg(source, W, H, maxPx, q);
      source.close?.();
      if (out.bytes.length >= img.contents.length * 0.9) continue; // pas assez de gain : on garde l'original
      const nd = ctx.obj({ Type: 'XObject', Subtype: 'Image', Width: out.w, Height: out.h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode', Length: out.bytes.length });
      for (const k of ['SMask', 'Interpolate', 'Intent', 'OC']) { const v = d.get(PDFName.of(k)); if (v) nd.set(PDFName.of(k), v); }
      ctx.assign(ref, PDFRawStream.of(nd, out.bytes));
      changed++;
    } catch (e) { console.warn('Image non optimisée', e); }
  }
  // métadonnées inutiles retirées (vignettes intégrées)
  for (const p of doc.getPages()) p.node.delete(PDFName.of('Thumb'));
  return { bytes: await doc.save({ useObjectStreams: true }), changed, total: images.length };
}

/** Toutes les pages deviennent des images JPEG (le plus léger pour un document très illustré). */
export async function pagesAsImages(bytes, { dpi, q }, onProgress) {
  const task = pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes.slice() });
  const pdf = await task.promise;
  const out = await PDFLib.PDFDocument.create();
  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress?.(i / pdf.numPages);
    const page = await pdf.getPage(i);
    const vp1 = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: dpi / 72 });
    const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    await page.render({ canvas: c, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
    const jpg = await out.embedJpg(await (await new Promise(r => c.toBlob(r, 'image/jpeg', q))).arrayBuffer());
    out.addPage([vp1.width, vp1.height]).drawImage(jpg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    c.width = c.height = 0;
  }
  task.destroy();
  out.setProducer('Atelier PDF');
  return out.save({ useObjectStreams: true });
}

/* ------------------------------------------------ fenêtre « Réduire la taille » */
export function openCompressDialog() {
  let level = 'medium', asImages = false, original = null, result = null, busy = false;
  const before = h('b', {}, '…');
  const seg = h('div', { class: 'compress-levels', role: 'radiogroup', 'aria-label': 'Niveau de réduction' });
  const draw = () => seg.replaceChildren(...Object.entries(LEVELS).map(([k, L]) => h('button', { type: 'button', class: 'compress-level', role: 'radio', 'aria-checked': k === level,
    onclick: () => { level = k; result = null; draw(); showResult(); } }, h('b', {}, L.label), h('small', {}, L.hint))));
  draw();
  const imgBox = h('input', { type: 'checkbox', onchange: e => { asImages = e.target.checked; result = null; showResult(); } });
  const status = h('div', { class: 'compress-result' });
  const go = h('button', { class: 'btn primary', type: 'button' }, 'Réduire');
  const fname = () => `${state.docName || 'document'}-allégé.pdf`;

  const saveBtn = h('button', { class: 'btn outline', type: 'button', hidden: true, onclick: async () => {
    const blob = new Blob([result], { type: 'application/pdf' });
    try {
      if (window.atelierDesktop) { const p = await window.atelierDesktop.saveAs(fname(), result, state.filePath); if (p) toast('PDF allégé enregistré.'); }
      else if (isAndroidApp) { if (await saveBlob(blob, fname())) toast('PDF allégé enregistré.'); }
      else { downloadBlob(blob, fname()); toast('PDF allégé téléchargé.'); }
    } catch (e) { toast('Enregistrement impossible : ' + (e.message || e), { error: true }); }
  } }, window.atelierDesktop || isAndroidApp ? 'Enregistrer…' : 'Télécharger');
  const shareBtn = h('button', { class: 'btn outline', type: 'button', hidden: true, onclick: async () => {
    try { await shareBlob(new Blob([result], { type: 'application/pdf' }), fname(), state.docName || 'Document'); }
    catch (e) { if (e?.name !== 'AbortError') toast('Partage impossible.', { error: true }); }
  } }, 'Partager');

  function showResult() {
    saveBtn.hidden = shareBtn.hidden = !result;
    go.hidden = !!result;
    if (!result) { status.replaceChildren(); return; }
    const gain = Math.round((1 - result.length / original.length) * 100);
    status.replaceChildren(gain > 2
      ? h('p', {}, 'Nouveau poids : ', h('b', {}, fmt(result.length)), ` (−${gain} %)`)
      : h('p', {}, 'Ce document est déjà bien optimisé : ', h('b', {}, fmt(result.length)), '. ',
        asImages ? '' : level !== 'strong' ? 'Essayez « Forte » ou la conversion en images.' : 'La conversion en images peut encore l\'alléger s\'il contient beaucoup d\'illustrations.'));
    shareBtn.hidden = !result || !canShareFiles();
  }
  go.onclick = async () => {
    if (busy) return; busy = true;
    const bar = h('div', {});
    status.replaceChildren(h('p', { class: 'help' }, 'Réduction en cours…'), h('div', { class: 'progress' }, bar));
    go.disabled = true;
    try {
      if (!original) original = await buildPdf();
      const L = LEVELS[level], prog = p => { bar.style.width = Math.round(p * 100) + '%'; };
      result = asImages ? await pagesAsImages(original, L, prog) : (await optimizeImages(original, L, prog)).bytes;
      if (result.length > original.length) result = original;
    } catch (e) { console.error(e); status.replaceChildren(h('p', { class: 'help', style: { color: 'var(--danger)' } }, 'La réduction a échoué : ' + (e.message || e))); result = null; }
    busy = false; go.disabled = false;
    showResult();
  };
  modal({ title: 'Réduire la taille du PDF', width: 560, body: [
    h('p', { style: { margin: 0 } }, 'Poids actuel : ', before),
    seg,
    h('label', { class: 'check-row' }, imgBox, h('span', {}, 'Convertir les pages en images', h('br'), h('small', { class: 'help' }, 'Plus léger pour un document très illustré ; le texte ne sera plus sélectionnable.'))),
    status,
  ], foot: [h('span', { class: 'grow' }), shareBtn, saveBtn, go] });
  buildPdf().then(b => { original = b; before.textContent = fmt(b.length); }).catch(() => { before.textContent = '?'; });
}
