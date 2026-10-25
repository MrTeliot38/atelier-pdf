// Panneau des pages : miniatures, réorganisation, rotation, suppression, ajout
import { state, on, emit, h, $, svgIcon, ICONS, commit, uid, pdfjsLib, toast, fmtPages, pageById } from './core.js';
import { scrollToPage } from './viewer.js';
import { blankPage } from './docs.js';
import { confirmDialog } from './ui.js';

const list = $('#thumbs');
const thumbCache = new Map(); // "src|index" -> canvas (rendu source)
let sortable = null;
let lastClicked = null;

export function initPagesPanel() {
  sortable = new window.Sortable(list, {
    animation: 150, delay: 120, delayOnTouchOnly: true, ghostClass: 'sortable-ghost', chosenClass: 'sortable-chosen',
    onEnd: ev => {
      if (ev.oldIndex === ev.newIndex) return;
      const moving = state.pages[ev.oldIndex];
      const multi = state.selectedPages.has(moving.id) && state.selectedPages.size > 1;
      if (multi) {
        // déplace toutes les pages cochées ensemble, à l'endroit où l'on a lâché
        const tmp = [...state.pages]; tmp.splice(ev.oldIndex, 1); tmp.splice(ev.newIndex, 0, moving);
        const group = state.pages.filter(p => state.selectedPages.has(p.id));
        state.pages = tmp.flatMap(p => p === moving ? group : state.selectedPages.has(p.id) ? [] : [p]);
      } else {
        const [p] = state.pages.splice(ev.oldIndex, 1);
        state.pages.splice(ev.newIndex, 0, p);
      }
      commit(); emit('pages-changed');
    },
  });
  on('doc-opened', render); on('doc-closed', () => { list.replaceChildren(); thumbCache.clear(); });
  on('pages-changed', render); on('objects-changed', updateBadges); on('history', updateBadges);
  // les miniatures suivent les modifications (images déplacées, zones recouvertes…)
  let thumbTimer = 0;
  on('history', () => { clearTimeout(thumbTimer); thumbTimer = setTimeout(refreshThumbs, 400); });
  on('current-page', id => { list.querySelectorAll('.thumb').forEach(t => t.classList.toggle('is-current', t.dataset.id === id)); const el = list.querySelector(`[data-id="${id}"]`); el && el.scrollIntoView({ block: 'nearest' }); });

  $('#selBar').addEventListener('click', e => { const b = e.target.closest('[data-sel]'); if (b) selectionAction(b.dataset.sel); });
}

function render() {
  const frag = document.createDocumentFragment();
  state.pages.forEach((p, i) => frag.append(thumbItem(p, i)));
  list.replaceChildren(frag);
  $('#pageCount').textContent = fmtPages(state.pages.length);
  for (const id of [...state.selectedPages]) if (!pageById(id)) state.selectedPages.delete(id);
  updateSelection();
}

function thumbItem(p, i) {
  const check = h('button', { class: 'thumb-check', type: 'button', title: 'Sélectionner', 'aria-label': 'Sélectionner la page ' + (i + 1) }, svgIcon(ICONS.check));
  const canvasHost = h('div', { class: 'thumb-box' }, check);
  const li = h('li', { class: 'thumb' + (state.selectedPages.has(p.id) ? ' is-selected' : '') + (state.currentPage === p.id ? ' is-current' : ''), 'data-id': p.id },
    canvasHost,
    h('div', { class: 'thumb-actions' },
      h('button', { type: 'button', title: 'Pivoter à droite', 'aria-label': 'Pivoter la page ' + (i + 1), onclick: e => { e.stopPropagation(); rotatePages([p.id], 90); } }, svgIcon(ICONS.rotr)),
      h('button', { type: 'button', class: 'danger', title: 'Supprimer la page', 'aria-label': 'Supprimer la page ' + (i + 1), onclick: e => { e.stopPropagation(); deletePages([p.id]); } }, svgIcon(ICONS.trash))),
    h('span', { class: 'thumb-num' }, i + 1));
  const c = thumbFor(p.id, 124, 160);
  canvasHost.append(c);
  if (p.objects.length) canvasHost.append(h('span', { class: 'thumb-badge', title: 'Page modifiée' }));
  check.addEventListener('click', e => { e.stopPropagation(); toggleSelect(p.id, e.shiftKey); });
  li.addEventListener('click', e => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) return toggleSelect(p.id, e.shiftKey);
    scrollToPage(p.id);
  });
  return li;
}

function refreshThumbs() {
  for (const li of list.querySelectorAll('.thumb')) {
    const p = pageById(li.dataset.id); if (!p) continue;
    const old = li.querySelector('.thumb-box canvas');
    const key = JSON.stringify(p.objects.map(o => [o.type, o.asset, o.cover, Math.round(o.x || 0), Math.round(o.y || 0), Math.round(o.w || 0)]));
    if (li._key === key) continue;
    li._key = key;
    if (old) old.replaceWith(thumbFor(p.id, 124, 160));
  }
}
function updateBadges() {
  for (const li of list.querySelectorAll('.thumb')) {
    const p = pageById(li.dataset.id); if (!p) continue;
    const box = li.querySelector('.thumb-box'); const b = box.querySelector('.thumb-badge');
    if (p.objects.length && !b) box.append(h('span', { class: 'thumb-badge', title: 'Page modifiée' }));
    if (!p.objects.length && b) b.remove();
  }
}

/** Miniature (canvas) d'une page, pivotée selon la page. */
export function thumbFor(pageId, maxW, maxH) {
  const p = pageById(pageId);
  const out = document.createElement('canvas');
  const rot = p.rot % 360, swap = rot % 180 !== 0;
  const dw = swap ? p.h : p.w, dh = swap ? p.w : p.h;
  const s = Math.min(maxW / dw, maxH / dh);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  out.width = Math.round(dw * s * dpr); out.height = Math.round(dh * s * dpr);
  out.style.width = Math.round(dw * s) + 'px'; out.style.height = Math.round(dh * s) + 'px';
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height);
  const paint = (srcCanvas) => {
    const w = p.w * s * dpr, hh = p.h * s * dpr;
    const inPage = fn => { ctx.save(); ctx.translate(out.width / 2, out.height / 2); ctx.rotate(rot * Math.PI / 180); fn(); ctx.restore(); };
    if (srcCanvas) inPage(() => ctx.drawImage(srcCanvas, -w / 2, -hh / 2, w, hh));
    // zones recouvertes (texte corrigé, image du document déplacée ou supprimée)
    inPage(() => { for (const o of p.objects) if (o.cover) { ctx.fillStyle = o.cover.color; ctx.fillRect(-w / 2 + o.cover.x * s * dpr, -hh / 2 + o.cover.y * s * dpr, o.cover.w * s * dpr, o.cover.h * s * dpr); } });
    // aperçu des images ajoutées (pages créées à partir d'une photo, signatures)
    for (const o of p.objects) if (o.type === 'image') {
      const a = state.assets.get(o.asset); if (!a) continue;
      const img = new Image(); img.src = a.dataUrl;
      const draw = () => inPage(() => ctx.drawImage(img, -w / 2 + o.x * s * dpr, -hh / 2 + o.y * s * dpr, o.w * s * dpr, o.h * s * dpr));
      img.complete ? draw() : img.onload = draw;
    }
  };
  if (!p.src) paint(null);
  else {
    const key = p.src + '|' + p.index;
    const cached = thumbCache.get(key);
    if (cached instanceof HTMLCanvasElement) paint(cached);
    else {
      const job = cached || renderThumb(p); thumbCache.set(key, job);
      job.then(c => { thumbCache.set(key, c); paint(c); }).catch(() => {});
    }
  }
  return out;
}
const thumbQueue = []; let thumbBusy = false;
function renderThumb(p) {
  return new Promise((res, rej) => { thumbQueue.push({ p, res, rej }); pumpThumbs(); });
}
async function pumpThumbs() {
  if (thumbBusy) return; const job = thumbQueue.shift(); if (!job) return;
  thumbBusy = true;
  try {
    const src = state.sources.get(job.p.src);
    const page = await src.pdf.getPage(job.p.index + 1);
    const vp0 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 320 / Math.max(vp0.width, vp0.height) });
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    await page.render({ canvas: c, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
    job.res(c);
  } catch (e) { job.rej(e); }
  thumbBusy = false; pumpThumbs();
}

/* ------------------------------------------------ sélection */
function toggleSelect(id, range) {
  if (range && lastClicked) {
    const a = state.pages.findIndex(p => p.id === lastClicked), b = state.pages.findIndex(p => p.id === id);
    const [s, e] = a < b ? [a, b] : [b, a];
    for (let i = s; i <= e; i++) state.selectedPages.add(state.pages[i].id);
  } else state.selectedPages.has(id) ? state.selectedPages.delete(id) : state.selectedPages.add(id);
  lastClicked = id;
  updateSelection();
}
export function clearPageSelection() { state.selectedPages.clear(); updateSelection(); }
function updateSelection() {
  const n = state.selectedPages.size;
  list.querySelectorAll('.thumb').forEach(t => t.classList.toggle('is-selected', state.selectedPages.has(t.dataset.id)));
  $('#selBar').hidden = !n;
  $('#selCount').textContent = n ? `${fmtPages(n)} sélectionnée${n > 1 ? 's' : ''}` : '';
  document.body.classList.toggle('has-page-selection', n > 0);
}

async function selectionAction(act) {
  const ids = state.pages.filter(p => state.selectedPages.has(p.id)).map(p => p.id);
  if (act === 'clear') return clearPageSelection();
  if (!ids.length) return;
  if (act === 'rotl') rotatePages(ids, -90);
  if (act === 'rotr') rotatePages(ids, 90);
  if (act === 'dup') duplicatePages(ids);
  if (act === 'del') deletePages(ids);
  if (act === 'extract') { const { downloadPdf } = await import('./export.js'); downloadPdf(ids, '-extrait'); }
}

/* ------------------------------------------------ opérations */
export function rotatePages(ids, delta) {
  for (const id of ids) { const p = pageById(id); p.rot = ((p.rot + delta) % 360 + 360) % 360; }
  commit(); emit('pages-changed');
}
export async function deletePages(ids) {
  if (ids.length >= state.pages.length) { toast('Un document doit garder au moins une page.', { error: true }); return; }
  if (ids.length > 1) {
    const ok = await confirmDialog({ title: 'Supprimer des pages', text: `Supprimer ${fmtPages(ids.length)} ? Vous pourrez annuler avec le bouton Annuler.`, ok: 'Supprimer', danger: true });
    if (!ok) return;
  }
  state.pages = state.pages.filter(p => !ids.includes(p.id));
  ids.forEach(id => state.selectedPages.delete(id));
  if (ids.includes(state.selected)) state.selected = null;
  commit(); emit('pages-changed');
  toast(ids.length > 1 ? `${fmtPages(ids.length)} supprimées.` : 'Page supprimée.', { action: { label: 'Annuler', fn: () => import('./core.js').then(m => m.undo()) } });
}
export function duplicatePages(ids) {
  let last = -1;
  for (const id of ids) {
    const i = state.pages.findIndex(p => p.id === id);
    const copy = JSON.parse(JSON.stringify(state.pages[i]));
    copy.id = uid('p'); copy.objects.forEach(o => o.id = uid());
    state.pages.splice(i + 1, 0, copy); last = i + 1;
  }
  commit(); emit('pages-changed');
  toast(ids.length > 1 ? `${fmtPages(ids.length)} dupliquées.` : 'Page dupliquée.');
}
export function insertBlankPage() {
  const ref = state.pages.find(p => p.id === state.currentPage) || state.pages[state.pages.length - 1];
  const at = insertionIndex();
  const p = blankPage(ref ? { w: ref.rot % 180 ? ref.h : ref.w, h: ref.rot % 180 ? ref.w : ref.h } : null);
  state.pages.splice(at, 0, p);
  commit(); emit('pages-changed');
  setTimeout(() => scrollToPage(p.id), 60);
}
/** Position d'insertion : après la dernière page cochée, sinon après la page affichée. */
export function insertionIndex() {
  if (state.selectedPages.size) {
    let last = -1; state.pages.forEach((p, i) => { if (state.selectedPages.has(p.id)) last = i; }); return last + 1;
  }
  const i = state.pages.findIndex(p => p.id === state.currentPage);
  return i >= 0 ? i + 1 : state.pages.length;
}
