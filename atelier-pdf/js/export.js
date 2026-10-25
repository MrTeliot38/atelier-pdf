// Fabrication du PDF final, impression des pages choisies, export en images
import { state, PDFLib, fontkit, pdfjsLib, PDFJS_OPTS, h, toast, downloadBlob, layoutText, ASC, pdfColor, mul, inv, sanitize, sleep, fmtPages, STD_FONTS, customVariant, variantKey } from './core.js';
import { modal, pagePicker, summaryText } from './ui.js';
import { facesFromBytes } from './fontnames.js';
import { thumbFor } from './pagesPanel.js';

const { PDFDocument, degrees, StandardFonts, pushGraphicsState, popGraphicsState, concatTransformationMatrix, BlendMode,
  PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList } = PDFLib;

/** Construit le PDF final pour les pages demandées (toutes par défaut). */
export async function buildPdf(pageIds = null, onProgress) {
  const pages = pageIds ? pageIds.map(id => state.pages.find(p => p.id === id)) : state.pages;
  const usedSrc = [...new Set(pages.filter(p => p.src).map(p => p.src))];

  // 1. sources : formulaires remplis
  const srcDocs = new Map();
  for (const sid of usedSrc) {
    const src = state.sources.get(sid);
    if (src.raster) { srcDocs.set(sid, null); continue; }
    const doc = await PDFDocument.load(src.bytes, { updateMetadata: false });
    fillForm(doc, src);
    srcDocs.set(sid, doc);
  }

  // 2. le document de sortie : on garde l'original tel quel s'il n'a pas été réorganisé
  const only = usedSrc.length === 1 ? usedSrc[0] : null;
  const identity = only && srcDocs.get(only) && !pageIds && pages.length === srcDocs.get(only).getPageCount()
    && pages.every((p, i) => p.src === only && p.index === i);
  let out;
  const outPages = [];
  if (identity) {
    out = srcDocs.get(only);
    out.getPages().forEach(pg => outPages.push(pg));
  } else {
    for (const [sid, doc] of srcDocs) if (doc) flattenForm(doc);
    out = await PDFDocument.create();
    const copied = new Map(); // "src|index" -> nombre de copies déjà utilisées
    // copie groupée par source pour partager polices et images
    const firstCopies = new Map();
    for (const sid of usedSrc) {
      const doc = srcDocs.get(sid); if (!doc) continue;
      const idx = [...new Set(pages.filter(p => p.src === sid).map(p => p.index))];
      const cps = await out.copyPages(doc, idx);
      idx.forEach((ix, k) => firstCopies.set(sid + '|' + ix, cps[k]));
    }
    for (const p of pages) {
      let pg;
      if (!p.src) pg = out.addPage([p.w, p.h]);
      else if (!srcDocs.get(p.src)) pg = await rasterPage(out, p);
      else {
        const key = p.src + '|' + p.index;
        const used = copied.get(key) || 0;
        pg = used === 0 ? firstCopies.get(key) : (await out.copyPages(srcDocs.get(p.src), [p.index]))[0];
        copied.set(key, used + 1);
        out.addPage(pg);
      }
      outPages.push(pg);
    }
  }
  out.registerFontkit(fontkit);

  // 3. rotation + objets ajoutés
  const fontCache = new Map(), imgCache = new Map();
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i], pg = outPages[i];
    const view = p.src && srcDocs.get(p.src) ? state.sources.get(p.src).views[p.index] : null;
    const intrinsic = view ? view.rotate : 0;
    if (p.rot || (view && pg.getRotation().angle !== intrinsic)) pg.setRotation(degrees((intrinsic + p.rot) % 360));
    if (p.objects.length) await drawObjects(out, pg, p, view, fontCache, imgCache);
    onProgress && onProgress((i + 1) / pages.length);
  }
  out.setProducer('Atelier PDF');
  out.setModificationDate(new Date());
  return out.save({ useObjectStreams: true });
}

function fillForm(doc, src) {
  if (!src.fields?.length) return;
  let form; try { form = doc.getForm(); } catch { return; }
  const done = new Set();
  for (const f of src.fields) {
    if (done.has(f.key)) continue; done.add(f.key);
    const v = state.formValues[f.key], o = state.formOriginal[f.key];
    if (JSON.stringify(v) === JSON.stringify(o)) continue;
    try {
      const field = form.getFieldMaybe(f.name); if (!field) continue;
      if (field instanceof PDFTextField) {
        let t = v || '';
        try { field.setText(t); } catch { field.setText(t.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e\n]/g, '?')); }
      } else if (field instanceof PDFCheckBox) v ? field.check() : field.uncheck();
      else if (field instanceof PDFRadioGroup) { if (v) field.select(v); else field.clear(); }
      else if (field instanceof PDFDropdown || field instanceof PDFOptionList) { if (v) field.select(v); else field.clear(); }
    } catch (e) { console.warn('Champ non rempli', f.name, e); }
  }
  try { form.updateFieldAppearances(); } catch (e) { console.warn(e); }
}
function flattenForm(doc) {
  try { const form = doc.getForm(); if (form.getFields().length) form.flatten({ updateFieldAppearances: false }); }
  catch (e) { console.warn('Aplatissement impossible', e); }
}

async function rasterPage(out, p) {
  const src = state.sources.get(p.src);
  const pdfPage = await src.pdf.getPage(p.index + 1);
  const vp = pdfPage.getViewport({ scale: 200 / 72 });
  const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  await pdfPage.render({ canvas: c, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
  const jpg = await out.embedJpg(await (await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9))).arrayBuffer());
  const pg = out.addPage([p.w, p.h]);
  pg.drawImage(jpg, { x: 0, y: 0, width: p.w, height: p.h });
  return pg;
}

async function getFont(out, o, cache) {
  const custom = !STD_FONTS[o.font] && state.fonts.get(o.font);
  const vk = custom ? customVariant(o) : variantKey(o);
  const key = (custom ? o.font : STD_FONTS[o.font] ? o.font : 'helvetica') + ':' + vk;
  if (!cache.has(key)) {
    let f;
    if (custom) {
      const bytes = custom.variants[vk];
      // sous-ensemble pour les polices TrueType ; police complète pour les OpenType CFF et variables (plus fiable)
      const info = facesFromBytes(bytes)[0];
      f = await out.embedFont(bytes, { subset: !(info && (info.cff || info.variable)) });
    } else f = await out.embedFont((STD_FONTS[o.font] || STD_FONTS.helvetica).v[vk]);
    cache.set(key, f);
  }
  return cache.get(key);
}
async function getImage(out, assetId, cache) {
  if (!cache.has(assetId)) {
    const a = state.assets.get(assetId);
    const bytes = Uint8Array.from(atob(a.dataUrl.split(',')[1]), c => c.charCodeAt(0));
    cache.set(assetId, a.mime === 'image/jpeg' ? await out.embedJpg(bytes) : await out.embedPng(bytes));
  }
  return cache.get(assetId);
}

async function drawObjects(out, pg, p, view, fontCache, imgCache) {
  const H = p.h;
  // repère « vue » (origine en haut à gauche, en points) -> repère PDF de la page
  const F = [1, 0, 0, -1, 0, H];
  const V = view ? view.transform : [1, 0, 0, -1, 0, H];
  const M = mul(inv(V), F);
  pg.pushOperators(pushGraphicsState(), concatTransformationMatrix(...M));
  const L = (r) => ({ x: r.x, y: H - r.y - r.h, width: r.w, height: r.h });
  for (const o of p.objects) if (o.cover) pg.drawRectangle({ ...L(o.cover), color: pdfColor(o.cover.color), borderWidth: 0 });
  for (const o of p.objects) {
    if (o.type === 'text') {
      const font = await getFont(out, o, fontCache);
      const { lines, widths } = layoutText(o);
      lines.forEach((ln, i) => {
        if (!ln) return;
        const x = o.align === 'center' ? o.x + (o.w - widths[i]) / 2 : o.align === 'right' ? o.x + o.w - widths[i] : o.x;
        const base = o.y + o.size * ASC + i * o.size * o.lineHeight;
        pg.drawText(sanitize(ln, font), { x, y: H - base, size: o.size, font, color: pdfColor(o.color) });
      });
    } else if (o.type === 'image') {
      const img = await getImage(out, o.asset, imgCache);
      pg.drawImage(img, L(o));
    } else if (o.type === 'rect') {
      pg.drawRectangle({ ...L(o), color: pdfColor(o.color), borderWidth: 0 });
    } else if (o.type === 'highlight') {
      pg.drawRectangle({ ...L(o), color: pdfColor(o.color), opacity: o.opacity ?? 0.45, borderWidth: 0, blendMode: BlendMode.Multiply });
    } else if (o.type === 'mark') {
      const s = o.w / 24, P = (x, y) => ({ x: o.x + x * s, y: H - (o.y + y * s) });
      const color = pdfColor(o.color), thickness = 3.2 * s;
      if (o.mark === 'cross') {
        pg.drawLine({ start: P(5, 5), end: P(19, 19), thickness, color, lineCap: PDFLib.LineCapStyle.Round });
        pg.drawLine({ start: P(19, 5), end: P(5, 19), thickness, color, lineCap: PDFLib.LineCapStyle.Round });
      } else if (o.mark === 'dot') {
        pg.drawCircle({ ...P(12, 12), size: 6.5 * s, color, borderWidth: 0 });
      } else {
        pg.drawLine({ start: P(4, 12.5), end: P(9.2, 17.7), thickness, color, lineCap: PDFLib.LineCapStyle.Round });
        pg.drawLine({ start: P(9.2, 17.7), end: P(20.5, 6), thickness, color, lineCap: PDFLib.LineCapStyle.Round });
      }
    }
  }
  pg.pushOperators(popGraphicsState());
}

/* ------------------------------------------------ téléchargement */
const fileName = suffix => `${state.docName || 'document'}${suffix}.pdf`;

export async function downloadPdf(pageIds = null, suffix = '-modifié') {
  const t = toast('Préparation du PDF…', { duration: 60000 });
  try {
    const bytes = await buildPdf(pageIds);
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), fileName(suffix));
    t.remove();
    toast(window.atelierDesktop ? 'PDF enregistré.' : 'PDF enregistré dans vos téléchargements.');
    state.dirty = false;
  } catch (e) {
    console.error(e); t.remove();
    toast('L\'enregistrement a échoué : ' + (e.message || e), { error: true, duration: 8000 });
  }
}

/** PDF « aplati » : chaque page devient une image. Rien de ce qui a été masqué
    ou corrigé ne reste lisible ni copiable dans le fichier. */
/** PDF « aplati » : chaque page devient une image (rien de masqué ou corrigé ne reste lisible). */
export async function buildFlatPdf() {
  const bytes = await buildPdf();
  const task = pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes });
  const pdf = await task.promise;
  const out = await PDFDocument.create();
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 200 / 72 });
    const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvas: c, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
    const jpg = await out.embedJpg(await (await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9))).arrayBuffer());
    out.addPage([vp1.width, vp1.height]).drawImage(jpg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    c.width = c.height = 0;
  }
  task.destroy();
  out.setProducer('Atelier PDF');
  return out.save();
}
export async function downloadFlattened() {
  const t = toast('Préparation du PDF aplati…', { duration: 120000 });
  try {
    const bytes = await buildFlatPdf();
    const d = window.atelierDesktop;
    if (d) {
      const p = await d.saveAs(fileName('-aplati'), bytes, state.filePath);
      t.remove(); if (p) toast('PDF aplati enregistré : le texte n\'y est plus sélectionnable.');
      return;
    }
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), fileName('-aplati'));
    t.remove(); toast('PDF aplati enregistré : le texte n\'y est plus sélectionnable.');
  } catch (e) { console.error(e); t.remove(); toast('L\'export a échoué : ' + e.message, { error: true }); }
}

/* ------------------------------------------------ impression */
export function openPrintDialog() {
  const n = state.pages.length;
  const sel = state.selectedPages.size ? state.pages.map((p, i) => state.selectedPages.has(p.id) ? i + 1 : 0).filter(Boolean) : Array.from({ length: n }, (_, i) => i + 1);
  const summary = h('span', { class: 'grow' });
  const printBtn = h('button', { class: 'btn primary' }, 'Imprimer');
  const picker = pagePicker({ thumbFor, initial: sel, onChange: s => { summary.textContent = summaryText(s.size); printBtn.disabled = !s.size; } });
  const m = modal({ title: 'Imprimer', width: 720,
    body: [h('p', { class: 'help', style: { margin: 0 } }, 'Cliquez sur les pages pour les inclure ou les retirer, ou saisissez une plage. Les modifications sont imprimées avec le document.'), picker.el],
    foot: [summary, h('button', { class: 'btn outline', onclick: () => m.close() }, 'Annuler'), printBtn] });
  summary.textContent = summaryText(picker.get().length);
  printBtn.onclick = async () => {
    const nums = picker.get(); if (!nums.length) return;
    printBtn.disabled = true; printBtn.replaceChildren(h('span', { class: 'spinner' }), 'Préparation…');
    try {
      const bytes = await buildPdf(nums.map(i => state.pages[i - 1].id));
      m.close();
      await printBytes(bytes);
    } catch (e) {
      console.error(e); toast('Impossible de préparer l\'impression : ' + e.message, { error: true });
      printBtn.disabled = false; printBtn.textContent = 'Imprimer';
    }
  };
}

/** Application Windows : impression à partir d'images des pages (300 ppp), via la fenêtre d'impression du système. */
async function printViaImages(bytes) {
  const task = pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes });
  const pdf = await task.promise;
  const imgs = [];
  const dpi = pdf.numPages > 40 ? 150 : 300;
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp1 = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: dpi / 72 });
    const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvas: c, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
    const url = URL.createObjectURL(await new Promise(r => c.toBlob(r, 'image/png')));
    imgs.push({ url, w: vp1.width, h: vp1.height });
    c.width = c.height = 0;
  }
  task.destroy();
  const frame = h('iframe', { style: { position: 'fixed', right: '0', bottom: '0', width: '1px', height: '1px', border: '0', opacity: '0' }, title: 'impression' });
  document.body.append(frame);
  const doc = frame.contentDocument;
  const sizes = [...new Set(imgs.map(i => `${Math.round(i.w)}x${Math.round(i.h)}`))];
  doc.open();
  doc.write(`<!doctype html><html><head><style>
    html,body{margin:0;padding:0} img{display:block;page-break-after:always;break-after:page}
    ${sizes.map((s, k) => { const [w, hh] = s.split('x'); return `@page p${k}{size:${w}pt ${hh}pt;margin:0} .p${k}{page:p${k};width:${w}pt;height:${hh}pt}`; }).join('\n')}
  </style></head><body>${imgs.map(i => `<img class="p${sizes.indexOf(`${Math.round(i.w)}x${Math.round(i.h)}`)}" src="${i.url}">`).join('')}</body></html>`);
  doc.close();
  await Promise.all([...doc.images].map(im => im.decode().catch(() => {})));
  frame.contentWindow.focus();
  frame.contentWindow.print();
  setTimeout(() => { frame.remove(); imgs.forEach(i => URL.revokeObjectURL(i.url)); }, 60_000);
}

async function printBytes(bytes) {
  if (window.atelierDesktop) return printViaImages(bytes);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const frame = h('iframe', { style: { position: 'fixed', right: '0', bottom: '0', width: '1px', height: '1px', border: '0', opacity: '0' }, title: 'impression' });
  document.body.append(frame);
  const fallback = () => toast('Si la fenêtre d\'impression ne s\'ouvre pas, ouvrez le PDF puis imprimez-le.', { action: { label: 'Ouvrir le PDF', fn: () => window.open(url, '_blank') }, duration: 10000 });
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS) { frame.remove(); window.open(url, '_blank'); return; }
  frame.onload = async () => {
    await sleep(400);
    try { frame.contentWindow.focus(); frame.contentWindow.print(); }
    catch { fallback(); }
  };
  frame.src = url;
  setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 10 * 60_000);
}

/* ------------------------------------------------ images */
export function openImageDialog() {
  const n = state.pages.length;
  const sel = state.selectedPages.size ? state.pages.map((p, i) => state.selectedPages.has(p.id) ? i + 1 : 0).filter(Boolean) : Array.from({ length: n }, (_, i) => i + 1);
  let fmt = 'png';
  const summary = h('span', { class: 'grow' });
  const go = h('button', { class: 'btn primary' }, 'Exporter');
  const quality = h('input', { type: 'range', min: 50, max: 100, value: 88, 'aria-label': 'Qualité JPG' });
  const qVal = h('span', { style: { minWidth: '3ch', fontVariantNumeric: 'tabular-nums' } }, '88');
  quality.oninput = () => qVal.textContent = quality.value;
  const qRow = h('div', { class: 'row', hidden: true }, quality, qVal);
  const qLabel = h('label', { hidden: true }, 'Qualité');
  const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Format' }, ...[['png', 'PNG'], ['jpg', 'JPG']].map(([k, l]) =>
    h('button', { type: 'button', 'aria-pressed': k === fmt, onclick: e => { fmt = k; seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b === e.currentTarget)); qRow.hidden = qLabel.hidden = k !== 'jpg'; } }, l)));
  const dpi = h('select', { class: 'select' },
    h('option', { value: 96 }, 'Écran (96 ppp)'), h('option', { value: 150, selected: true }, 'Standard (150 ppp)'), h('option', { value: 300 }, 'Impression (300 ppp)'));
  const bar = h('div', { class: 'progress', hidden: true }, h('div'));
  const picker = pagePicker({ thumbFor, initial: sel, onChange: s => { summary.textContent = summaryText(s.size) + (s.size > 1 ? ' — archive .zip' : ''); go.disabled = !s.size; } });
  const m = modal({ title: 'Exporter en images', width: 720,
    body: [h('div', { class: 'opts' }, h('label', {}, 'Format'), h('div', { class: 'row' }, seg, h('span', { class: 'help' }, 'PNG : net, idéal pour le texte. JPG : plus léger, idéal pour les photos.')),
      h('label', {}, 'Résolution'), dpi, qLabel, qRow), picker.el, bar],
    foot: [summary, h('button', { class: 'btn outline', onclick: () => m.close() }, 'Annuler'), go] });
  summary.textContent = summaryText(picker.get().length) + (picker.get().length > 1 ? ' — archive .zip' : '');
  go.onclick = async () => {
    const nums = picker.get(); if (!nums.length) return;
    go.disabled = true; bar.hidden = false;
    try {
      await exportImages(nums, fmt, +dpi.value, +quality.value / 100, p => bar.firstChild.style.width = Math.round(p * 100) + '%');
      m.close();
    } catch (e) { console.error(e); toast('L\'export a échoué : ' + e.message, { error: true }); go.disabled = false; }
  };
}

async function exportImages(nums, fmt, dpi, q, progress) {
  const ids = nums.map(i => state.pages[i - 1].id);
  const bytes = await buildPdf(ids, p => progress(p * 0.2));
  const task = pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes });
  const pdf = await task.promise;
  const mime = fmt === 'jpg' ? 'image/jpeg' : 'image/png';
  const files = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    let scale = dpi / 72;
    const vp0 = page.getViewport({ scale });
    const maxPx = 14_000_000; // garde-fou mémoire (téléphones)
    if (vp0.width * vp0.height > maxPx) scale *= Math.sqrt(maxPx / (vp0.width * vp0.height));
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvas: c, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE, background: '#ffffff' }).promise;
    const blob = await new Promise(r => c.toBlob(r, mime, q));
    files.push({ name: `${state.docName || 'document'}-page-${String(nums[i - 1]).padStart(2, '0')}.${fmt}`, blob });
    c.width = c.height = 0;
    progress(0.2 + 0.75 * i / pdf.numPages);
  }
  task.destroy();
  if (files.length === 1) downloadBlob(files[0].blob, files[0].name);
  else {
    const zip = new window.JSZip();
    for (const f of files) zip.file(f.name, f.blob);
    downloadBlob(await zip.generateAsync({ type: 'blob' }), `${state.docName || 'document'}-images.zip`);
  }
  progress(1);
  toast(files.length === 1 ? 'Image enregistrée.' : `${fmtPages(files.length)} exportées dans une archive .zip.`);
}
