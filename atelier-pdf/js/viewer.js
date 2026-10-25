// Affichage des pages, des objets ajoutés et des champs de formulaire
import { state, on, emit, h, $, clamp, pdfjsLib, layoutText, textBoxHeight, cssFamily, cssWeightStyle, ASC, undo, redo, svgIcon, ICONS, commit, pageById } from './core.js';

const pagesEl = $('#pages');
const mat = $('#mat');
const slots = new Map();          // pageId -> { slot, page, canvas, forms, text, objs, banner, key, task }
const near = new Set();           // pages proches de l'écran
let io;

/** Emplacement d'une page à l'écran, toujours relié à la version actuelle de la page
    (après Annuler / Rétablir, les pages sont recréées : l'affichage doit suivre). */
export const getSlot = id => {
  const s = slots.get(id);
  if (s) { const p = state.pages.find(x => x.id === id); if (p) s.page = p; }
  return s;
};
export const displaySize = p => (p.rot % 180 ? { w: p.h, h: p.w } : { w: p.w, h: p.h });

export function initViewer() {
  io = new IntersectionObserver(entries => {
    for (const e of entries) {
      const id = e.target.dataset.id;
      if (e.isIntersecting) { near.add(id); queueRender(id); emit('page-near', id); }
      else { near.delete(id); releaseCanvas(id); }
    }
  }, { root: mat, rootMargin: '900px 0px' });

  on('doc-opened', () => { document.body.classList.remove('is-empty'); clearAll(); fitWidth(true); syncSlots(); mat.scrollTop = 0; });
  on('doc-closed', clearAll);
  on('pages-changed', syncSlots);
  on('objects-changed', id => { if (id) renderObjects(id); else state.pages.forEach(p => renderObjects(p.id)); });
  on('forms-changed', () => state.pages.forEach(p => renderForms(p.id)));
  on('selection', () => { state.pages.forEach(p => renderObjects(p.id)); });

  let t = 0;
  mat.addEventListener('scroll', () => { if (!t) t = requestAnimationFrame(() => { t = 0; updateCurrent(); }); }, { passive: true });
  mat.addEventListener('wheel', e => {
    if (!(e.ctrlKey || e.metaKey) || !state.pages.length) return;
    e.preventDefault();
    setZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e);
  }, { passive: false });
  window.addEventListener('resize', () => { if (state.pages.length) updateCurrent(); });
  pinchZoom();
}

function clearAll() {
  for (const s of slots.values()) { s.task?.cancel(); io.unobserve(s.slot); }
  slots.clear(); near.clear(); pagesEl.replaceChildren();
}

/* ------------------------------------------------------------ zoom */
export function setZoom(z, anchorEvent) {
  const rect = mat.getBoundingClientRect();
  const ay = anchorEvent ? anchorEvent.clientY - rect.top : mat.clientHeight / 2;
  const ax = anchorEvent ? anchorEvent.clientX - rect.left : mat.clientWidth / 2;
  zoomAt(z, mat.scrollLeft + ax, mat.scrollTop + ay, ax, ay);
}
/** Change le zoom : le point (cx, cy) du contenu (zoom actuel) vient se placer en (vx, vy) dans la zone visible. */
function zoomAt(z, cx, cy, vx, vy) {
  z = clamp(Math.round(z * 100) / 100, 0.25, 4);
  if (z === state.zoom) return;
  const old = state.zoom;
  const docY = (cy - 28) / old, docX = cx / old;
  state.zoom = z;
  for (const s of slots.values()) { layoutSlot(s); s.key = ''; }
  state.pages.forEach(p => { renderObjects(p.id); renderForms(p.id); });
  mat.scrollTop = docY * z - vy + 28;
  mat.scrollLeft = docX * z - vx;
  for (const id of near) queueRender(id);
  emit('zoom');
}
export function fitWidth(initial) {
  if (!state.pages.length) return;
  const maxW = Math.max(...state.pages.map(p => displaySize(p).w));
  const insp = document.getElementById('inspector');
  const reserve = window.innerWidth >= 860 && insp.hidden ? insp.offsetWidth || 272 : 0;
  const avail = mat.clientWidth - reserve - (window.innerWidth < 860 ? 20 : 56);
  const z = clamp(avail / maxW, 0.25, initial ? 1.3 : 4);
  if (initial) { state.zoom = Math.round(z * 100) / 100; emit('zoom'); }
  else setZoom(z);
}

/**
 * Zoom à deux doigts : pendant le geste, la page est simplement agrandie à l'écran (fluide, sans calcul) ;
 * le document n'est redessiné net qu'au moment où les doigts se lèvent.
 */
function pinchZoom() {
  let g = null;
  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const mid = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
  mat.addEventListener('touchstart', e => {
    if (e.touches.length !== 2 || !state.pages.length) return;
    const [a, b] = e.touches, m = mid(a, b), r = mat.getBoundingClientRect();
    g = { d0: Math.max(10, dist(a, b)), m0: m, k: 1, dx: 0, dy: 0, r, ox: mat.scrollLeft + m.x - r.left, oy: mat.scrollTop + m.y - r.top };
    pagesEl.style.transformOrigin = `${g.ox}px ${g.oy}px`;
    pagesEl.style.willChange = 'transform';
    document.body.classList.add('pinching');
    emit('pinch-start');
  }, { passive: true });
  mat.addEventListener('touchmove', e => {
    if (!g) return;
    if (e.touches.length < 2) return;
    e.preventDefault();
    const [a, b] = e.touches, m = mid(a, b);
    g.k = clamp(dist(a, b) / g.d0, 0.25 / state.zoom, 4 / state.zoom);
    g.dx = m.x - g.m0.x; g.dy = m.y - g.m0.y;
    pagesEl.style.transform = `translate(${g.dx}px, ${g.dy}px) scale(${g.k})`;
  }, { passive: false });
  const end = e => {
    if (!g || e.touches.length >= 2) return;
    const { k, dx, dy, ox, oy, m0, r } = g; g = null;
    pagesEl.style.transform = ''; pagesEl.style.transformOrigin = ''; pagesEl.style.willChange = '';
    document.body.classList.remove('pinching');
    if (Math.abs(k - 1) > 0.02) zoomAt(state.zoom * k, ox, oy, m0.x + dx - r.left, m0.y + dy - r.top);
    else { mat.scrollLeft -= dx; mat.scrollTop -= dy; }
  };
  mat.addEventListener('touchend', end); mat.addEventListener('touchcancel', end);
}

/* ------------------------------------------------------------ pages */
function syncSlots() {
  const keep = new Set(state.pages.map(p => p.id));
  for (const [id, s] of slots) if (!keep.has(id)) { s.task?.cancel(); io.unobserve(s.slot); s.slot.remove(); slots.delete(id); near.delete(id); }
  state.pages.forEach((p, i) => {
    let s = slots.get(p.id);
    if (!s) s = createSlot(p);
    s.page = p;
    s.label.textContent = 'Page ' + (i + 1);
    if (pagesEl.children[i] !== s.slot) pagesEl.insertBefore(s.slot, pagesEl.children[i] || null);
    layoutSlot(s);
    renderObjects(p.id); renderForms(p.id);
  });
  updateCurrent();
}

function createSlot(p) {
  const canvas = h('canvas', { class: 'page-canvas' });
  const forms = h('div', { class: 'layer layer-forms' });
  const text = h('div', { class: 'layer layer-text' });
  const objs = h('div', { class: 'layer layer-objects' });
  const pageEl = h('div', { class: 'page', 'data-page': p.id }, canvas, forms, text, objs);
  const banner = h('div', { class: 'ocr-banner' });
  const label = h('div', { class: 'page-label' });
  const slot = h('div', { class: 'page-slot', 'data-id': p.id }, pageEl, banner, label);
  const s = { slot, pageEl, canvas, forms, text, objs, banner, label, page: p, key: '', task: null };
  slots.set(p.id, s);
  io.observe(slot);
  return s;
}

function layoutSlot(s) {
  const p = s.page, z = state.zoom, d = displaySize(p);
  s.slot.style.width = d.w * z + 'px';
  s.slot.style.height = d.h * z + 'px';
  s.pageEl.style.width = p.w * z + 'px';
  s.pageEl.style.height = p.h * z + 'px';
  s.pageEl.style.transform = `translate(-50%, -50%) rotate(${p.rot}deg)`;
  if (s.rot !== p.rot) { s.rot = p.rot; }
}

/* ------------------------------------------------------------ rendu */
const queue = [];
let rendering = 0;
function queueRender(id) { if (!queue.includes(id)) queue.push(id); pump(); }
async function pump() {
  if (rendering >= 2) return;
  const id = queue.shift(); if (!id) return;
  rendering++;
  try { await renderCanvas(id); } catch (e) { if (e?.name !== 'RenderingCancelledException') console.warn(e); }
  rendering--; pump();
}
async function renderCanvas(id) {
  const s = slots.get(id); if (!s || !near.has(id)) return;
  const p = s.page, dpr = Math.min(window.devicePixelRatio || 1, 2);
  const key = state.zoom + '|' + dpr + '|' + p.src + '|' + p.index;
  if (s.key === key) return;
  if (!p.src) { s.canvas.width = 1; s.canvas.height = 1; s.key = key; return; }
  const src = state.sources.get(p.src);
  const pdfPage = await src.pdf.getPage(p.index + 1);
  // au-delà de quelques millions de pixels, un téléphone n'affiche plus rien : on plafonne (l'image est étirée)
  const vp1 = pdfPage.getViewport({ scale: 1 });
  const maxPx = (matchMedia('(pointer: coarse)').matches ? 10e6 : 24e6);
  const scale = Math.min(state.zoom * dpr, Math.sqrt(maxPx / (vp1.width * vp1.height)));
  const vp = pdfPage.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  c.className = 'page-canvas';
  s.task?.cancel();
  s.task = pdfPage.render({ canvas: c, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS });
  await s.task.promise;
  s.task = null;
  if (!slots.has(id)) return;
  s.canvas.replaceWith(c); s.canvas = c; s.key = key; s.scale = scale;
  emit('page-rendered', id);
}
function releaseCanvas(id) {
  const s = slots.get(id); if (!s) return;
  s.task?.cancel(); s.task = null;
  s.canvas.width = 0; s.canvas.height = 0; s.key = '';
  const i = queue.indexOf(id); if (i >= 0) queue.splice(i, 1);
}

/** Canvas d'une page à une échelle minimale (rendu dédié si besoin). */
export async function pageCanvas(page, minScale = 2) {
  const s = slots.get(page.id);
  if (s && s.key && s.canvas.width > 1 && s.scale >= minScale) return { canvas: s.canvas, scale: s.scale };
  const c = document.createElement('canvas');
  if (!page.src) { c.width = Math.ceil(page.w * minScale); c.height = Math.ceil(page.h * minScale); const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); return { canvas: c, scale: minScale }; }
  const pdfPage = await state.sources.get(page.src).pdf.getPage(page.index + 1);
  const vp = pdfPage.getViewport({ scale: minScale });
  c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  await pdfPage.render({ canvas: c, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS }).promise;
  return { canvas: c, scale: minScale };
}

/* --------------------------------------------------- page courante */
function updateCurrent() {
  if (!state.pages.length) return;
  const r = mat.getBoundingClientRect(), y = r.top + r.height * 0.35;
  let best = null, bestD = Infinity;
  for (const s of slots.values()) {
    const b = s.slot.getBoundingClientRect();
    const d = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0;
    if (d < bestD) { bestD = d; best = s.page.id; }
  }
  if (best && best !== state.currentPage) { state.currentPage = best; emit('current-page', best); }
}
export function scrollToPage(id, smooth = true) {
  const s = slots.get(id); if (!s) return;
  mat.scrollTo({ top: s.slot.offsetTop - 20, behavior: smooth ? 'smooth' : 'auto' });
}

/* ------------------------------------------------- coordonnées */
/** Point (en pt, repère de la page non pivotée) sous le pointeur. */
export function pagePoint(e, pageId) {
  const s = getSlot(pageId); const p = s.page; const z = state.zoom;
  const b = s.slot.getBoundingClientRect();
  const dx = e.clientX - (b.left + b.width / 2), dy = e.clientY - (b.top + b.height / 2);
  const t = -p.rot * Math.PI / 180, c = Math.cos(t), sn = Math.sin(t);
  const lx = dx * c - dy * sn, ly = dx * sn + dy * c;
  return { x: lx / z + p.w / 2, y: ly / z + p.h / 2 };
}

/* ------------------------------------------------- objets */
const MARKS = {
  check: '<path d="M4 12.5l5.2 5.2L20.5 6" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>',
  cross: '<path d="M5 5l14 14M19 5L5 19" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/>',
  dot: '<circle cx="12" cy="12" r="6.5" fill="currentColor"/>',
};

export function renderObjects(pageId) {
  const s = getSlot(pageId); if (!s) return;
  const p = s.page, z = state.zoom;
  const frag = document.createDocumentFragment();
  const box = (el, r) => Object.assign(el.style, { left: r.x * z + 'px', top: r.y * z + 'px', width: r.w * z + 'px', height: r.h * z + 'px' });
  for (const o of p.objects) if (o.cover) {
    const c = h('div', { class: 'obj cover' }); box(c, o.cover);
    const patch = o.cover.img && state.assets.get(o.cover.img);
    // fond d'origine reconstitué (sans les lettres) ou, à défaut, couleur unie
    if (patch) { c.style.background = `${o.cover.color} url("${patch.dataUrl}") 0 0 / 100% 100% no-repeat`; }
    else c.style.background = o.cover.color;
    frag.append(c);
  }
  for (const o of p.objects) {
    if (o.type === 'erase') continue; // image du document supprimée : seul son recouvrement reste
    const el = h('div', { class: 'obj ' + (o.type === 'image' ? 'img' : o.type), 'data-id': o.id });
    if (o.type === 'text') {
      const { lines, widths } = layoutText(o);
      o.h = Math.max(textBoxHeight(o, lines.length), o.minH || 0);
      if (o.origin === 'edit') el.classList.add('is-edited-mark');
      if (state.editing === o.id) el.append(textEditor(o));
      else el.append(textSvg(o, lines, widths));
    } else if (o.type === 'image') {
      const a = state.assets.get(o.asset);
      el.append(h('img', { src: a?.dataUrl || '', alt: '', draggable: 'false' }));
    } else if (o.type === 'rect') {
      el.style.background = o.color;
    } else if (o.type === 'highlight') {
      el.style.background = o.color; el.style.opacity = o.opacity ?? 0.45;
    } else if (o.type === 'mark') {
      el.style.color = o.color;
      el.append(svgIcon(MARKS[o.mark] || MARKS.check));
    }
    box(el, o);
    if (state.selected === o.id && state.editing !== o.id) {
      el.classList.add('is-selected');
      const hs = o.type === 'text' ? ['w', 'e'] : ['nw', 'ne', 'sw', 'se'];
      for (const k of hs) el.append(h('span', { class: 'handle', 'data-h': k }));
    }
    frag.append(el);
  }
  s.objs.replaceChildren(frag);
  const ta = s.objs.querySelector('textarea.editor');
  if (ta) { autoGrow(ta); if (document.activeElement !== ta) { ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length); } }
}

function textSvg(o, lines, widths) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${o.w} ${o.h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.color = o.color;
  lines.forEach((ln, i) => {
    if (!ln) return;
    const t = document.createElementNS(NS, 'text');
    const x = o.align === 'center' ? (o.w - widths[i]) / 2 : o.align === 'right' ? o.w - widths[i] : 0;
    t.setAttribute('x', x); t.setAttribute('y', o.size * ASC + i * o.size * o.lineHeight);
    t.setAttribute('font-size', o.size);
    t.setAttribute('textLength', widths[i]); t.setAttribute('lengthAdjust', 'spacingAndGlyphs');
    t.style.fontFamily = cssFamily(o);
    const ws = cssWeightStyle(o);
    t.style.fontWeight = ws.weight;
    t.style.fontStyle = ws.style;
    t.setAttribute('xml:space', 'preserve');
    t.textContent = ln;
    svg.append(t);
  });
  return svg;
}

function textEditor(o) {
  const z = state.zoom;
  const ta = h('textarea', { class: 'editor', spellcheck: 'true', lang: 'fr', 'aria-label': 'Texte' });
  ta.value = o.text;
  Object.assign(ta.style, {
    width: o.w * z + 6 + 'px', minHeight: o.size * o.lineHeight * z + 6 + 'px',
    font: `${cssWeightStyle(o).style} ${cssWeightStyle(o).weight} ${o.size * z}px/${o.lineHeight} ${cssFamily(o)}`,
    color: o.color, textAlign: o.align,
  });
  ta.addEventListener('input', () => { o.text = ta.value; autoGrow(ta); emit('text-input', o.id); });
  const startValue = o.text;
  ta.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); ta.blur(); return; }
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    // Ctrl+Z dans un texte : annule d'abord la frappe ; quand il n'y a plus rien à annuler ici,
    // on sort de la zone de texte et on annule l'action précédente du document
    if (mod && (k === 'z' || k === 'y') && ta.value === startValue) {
      e.preventDefault(); ta.blur();
      setTimeout(() => (k === 'y' || e.shiftKey ? redo() : undo()), 0);
      return;
    }
    if (e.key === 'F3' && e.shiftKey) { e.preventDefault(); emit('cycle-case'); }
  });
  ta.addEventListener('blur', e => { if (ta.isConnected) emit('text-blur', { id: o.id, related: e.relatedTarget }); });
  ta.addEventListener('pointerdown', e => e.stopPropagation());
  return ta;
}
function autoGrow(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }

/* ------------------------------------------------- formulaires */
export function renderForms(pageId) {
  const s = getSlot(pageId); if (!s) return;
  const p = s.page, z = state.zoom;
  s.forms.replaceChildren();
  if (!p.src) return;
  const src = state.sources.get(p.src);
  for (const f of src.fields || []) {
    if (f.index !== p.index) continue;
    const r = f.rect;
    const pos = { left: r.x * z + 'px', top: r.y * z + 'px', width: r.w * z + 'px', height: r.h * z + 'px' };
    const v = state.formValues[f.key];
    let el;
    if (f.kind === 'text') {
      const fs = (f.fontSize || (f.multiline ? 10 : clamp(r.h * 0.68, 6, 12))) * z;
      el = f.multiline ? h('textarea', { class: 'ff' }) : h('input', { class: 'ff', type: 'text' });
      el.value = v ?? '';
      if (f.maxLen) el.maxLength = f.maxLen;
      if (f.comb && f.maxLen) { el.style.letterSpacing = (r.w / f.maxLen * z - fs * 0.6) + 'px'; el.style.paddingLeft = (r.w / f.maxLen * z - fs * 0.6) / 2 + 'px'; }
      el.style.fontSize = fs + 'px';
      el.style.textAlign = ['left', 'center', 'right'][f.align] || 'left';
      el.addEventListener('input', () => { state.formValues[f.key] = el.value; syncTwins(f.key, el); });
      el.addEventListener('change', () => commit());
    } else if (f.kind === 'checkbox' || f.kind === 'radio') {
      const on = f.kind === 'checkbox' ? !!v : (v != null && v === f.buttonValue);
      el = h('div', { class: 'ff-check' + (f.kind === 'radio' ? ' radio' : '') + (on ? ' on' : ''), role: f.kind, tabindex: 0, 'aria-checked': on, 'data-key': f.key, 'data-bv': f.buttonValue ?? '' },
        f.kind === 'radio' ? svgIcon('<circle cx="12" cy="12" r="6"/>') : svgIcon(ICONS.check));
      const toggle = () => {
        if (f.readOnly) return;
        if (f.kind === 'checkbox') state.formValues[f.key] = !state.formValues[f.key];
        else state.formValues[f.key] = state.formValues[f.key] === f.buttonValue ? null : f.buttonValue;
        updateChecks(f.key); commit();
      };
      el.addEventListener('click', toggle);
      el.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); } });
    } else if (f.kind === 'choice') {
      el = h('select', { class: 'ff' }, h('option', { value: '' }, ''), ...f.options.map(o => h('option', { value: o.exportValue }, o.displayValue)));
      el.value = v ?? '';
      el.style.fontSize = clamp(r.h * 0.6, 7, 12) * z + 'px';
      el.addEventListener('change', () => { state.formValues[f.key] = el.value; commit(); });
    } else if (f.kind === 'sig') {
      el = h('button', { class: 'ff-sig', type: 'button', title: 'Signer dans ce cadre' }, 'Signer ici');
      el.addEventListener('click', () => emit('sign-field', { pageId: p.id, rect: r }));
    }
    if (!el) continue;
    Object.assign(el.style, pos);
    el.dataset.key = f.key;
    if (f.readOnly && el.tagName !== 'DIV') el.disabled = true;
    el.title = f.name;
    s.forms.append(el);
  }
}
function syncTwins(key, from) {
  for (const s of slots.values()) for (const el of s.forms.querySelectorAll('.ff')) if (el !== from && el.dataset.key === key) el.value = from.value;
}
function updateChecks(key) {
  const v = state.formValues[key];
  for (const s of slots.values()) for (const el of s.forms.querySelectorAll('.ff-check')) {
    if (el.dataset.key !== key) continue;
    const on = el.classList.contains('radio') ? v === el.dataset.bv : !!v;
    el.classList.toggle('on', on); el.setAttribute('aria-checked', on);
  }
}

export { mat, pagesEl, slots };
export const pageOfElement = el => el.closest('.page')?.dataset.page;
export const isNear = id => near.has(id);
export const currentPageObj = () => pageById(state.currentPage) || state.pages[0];
