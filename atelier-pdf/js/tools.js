// Outils et interactions sur les pages : sélection, déplacement, texte, coches, masques, signatures
import { state, on, emit, h, $, uid, clamp, commit, undo, findObject, pageById, ASC, toast, svgIcon, ICONS, STD_FONTS } from './core.js';
import { getSlot, pagePoint, renderObjects, slots, pagesEl, mat, pageOfElement, isNear, currentPageObj, scrollToPage, shapeSvg } from './viewer.js';
import { getBlocks, runOcr, sampleColors, looksBold } from './textdetect.js';
import { matchSystemFont, loadSystemFamily } from './systemfonts.js';
import { guessFont, MATCH_THRESHOLD } from './fontmatch.js';
import { liftImage, renderImageLayer, findRegions } from './pageimages.js';
import { textErasePatch } from './inpaint.js';

const TOOL_HINTS = {
  select: 'Cliquez sur une image du document ou un élément ajouté pour le sélectionner et le déplacer ; double-cliquez sur un texte pour l\'écrire. Suppr pour l\'effacer, Ctrl+Z pour annuler.',
  edit: 'Survolez le document : chaque bloc de texte reconnu s\'entoure. Cliquez dessus pour le corriger.',
  text: 'Cliquez à l\'endroit où écrire.',
  sign: 'Créez ou choisissez une signature, puis cliquez à l\'endroit où signer.',
  mark: 'Cliquez sur une case pour la cocher. Choisissez ✓, ✗ ou ● dans le panneau.',
  mask: 'Tracez un rectangle pour cacher une zone. Sa couleur s\'adapte au fond.',
  redact: 'Tracez un rectangle sur l\'information à effacer définitivement.',
  annot: 'Tracez une flèche, un trait ou une forme ; cliquez pour une note ou un tampon.',
  highlight: 'Tracez un rectangle pour surligner.',
};

export function setTool(t) {
  if (state.editing) document.activeElement?.blur?.();
  state.tool = t;
  if (t !== 'sign') state.pendingSignature = null;
  for (const c of [...document.body.classList]) if (c.startsWith('tool-')) document.body.classList.remove(c);
  document.body.classList.add('tool-' + t);
  document.body.classList.toggle('sign-armed', !!state.pendingSignature);
  emit('tool', t);
  setHint(TOOL_HINTS[t] || '');
  refreshTextLayers();
}
export function setHint(t) { const el = $('#hint'); if (el) el.textContent = t; }

export function initTools() {
  pagesEl.addEventListener('pointerdown', onDown);
  pagesEl.addEventListener('dblclick', e => {
    if (Date.now() - lastDoubleTap < 700) return;
    const el = e.target.closest('.obj.text'); if (el) return startEditing(el.dataset.id);
    // double-clic sur l'image d'une page entière : elle devient sélectionnable
    const pim = e.target.closest('.pimg');
    if (pim && state.tool === 'select') {
      const pageId = pageOfElement(pim);
      liftAndDrag({ clientX: e.clientX, clientY: e.clientY }, pageById(pageId), pim, true);
    }
  });
  on('page-near', id => { if (state.tool === 'edit') renderTextLayer(id); });
  on('zoom', refreshTextLayers);
  on('pages-changed', refreshTextLayers);
  on('objects-changed', () => { if (state.tool === 'edit') refreshTextLayers(); });
  on('text-blur', stopEditing);
}

export function select(id) { state.selected = id; emit('selection'); }

/* ------------------------------------------------ calque de texte */
const tokens = new Map();
export function refreshTextLayers() {
  for (const s of slots.values()) {
    if (state.tool === 'edit' && isNear(s.page.id)) renderTextLayer(s.page.id);
    else if (state.tool !== 'edit') { s.text.replaceChildren(); s.banner.classList.remove('show'); }
  }
}
async function renderTextLayer(pageId) {
  const s = getSlot(pageId); if (!s) return;
  const token = {}; tokens.set(pageId, token);
  let res;
  try { res = await getBlocks(s.page); } catch (e) { console.warn(e); return; }
  if (tokens.get(pageId) !== token || state.tool !== 'edit') return;
  const { blocks, kind } = res;
  const z = state.zoom, page = s.page;
  const covers = page.objects.filter(o => o.cover).map(o => o.cover);
  const frag = document.createDocumentFragment();
  for (const b of blocks) {
    const r = { x: b.x, y: b.top, w: b.w, h: b.bottom - b.top };
    if (covers.some(c => overlapRatio(r, c) > 0.5)) continue;
    const el = h('div', { class: 'tblock', title: 'Cliquer pour modifier ce texte' });
    Object.assign(el.style, { left: (r.x - 1.5) * z + 'px', top: (r.y - 1.5) * z + 'px', width: (r.w + 3) * z + 'px', height: (r.h + 3) * z + 'px' });
    el._block = b;
    frag.append(el);
  }
  s.text.replaceChildren(frag);
  s.banner.replaceChildren();
  if (kind === 'none') {
    s.banner.append(h('span', {}, 'Aucun texte reconnu sur cette page (scan ou image).'),
      h('button', { class: 'btn small primary', onclick: () => ocrPage(page) }, 'Reconnaître le texte'));
    s.banner.classList.add('show');
  } else s.banner.classList.remove('show');
}
function overlapRatio(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), hh = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && hh > 0 ? (w * hh) / (a.w * a.h || 1) : 0;
}

export async function ocrPage(page) {
  const s = getSlot(page.id);
  const status = h('span', {}, 'Préparation de la reconnaissance…');
  if (s) { s.banner.replaceChildren(h('span', { class: 'spinner' }), status); s.banner.classList.add('show'); }
  if (state.tool !== 'edit') setTool('edit');
  if (s) s.banner.classList.add('show');
  emit('ocr-progress', { page: page.id, progress: 0 });
  let refining = false;
  try {
    await runOcr(page, m => {
      const pct = Math.round((m.progress || 0) * 100);
      if (m.status === 'recognizing text' && refining) return;
      if (m.status === 'refining') refining = true;
      const label = m.status === 'refining' ? `Vérification des passages difficiles… ${pct} %` : m.status === 'recognizing text' ? `Lecture du texte… ${pct} %` : 'Chargement du moteur de lecture (première fois uniquement)…';
      status.textContent = label;
      emit('ocr-progress', { page: page.id, progress: m.progress, label });
    });
    toast(matchMedia('(pointer: coarse)').matches ? 'Texte reconnu : touchez un bloc pour le modifier.' : 'Texte reconnu : cliquez sur un bloc pour le modifier.');
  } catch (e) {
    console.error(e);
    toast('La reconnaissance du texte a échoué. Vérifiez votre connexion pour le premier chargement, puis réessayez.', { error: true, duration: 7000 });
  }
  emit('ocr-progress', { page: page.id, done: true });
  renderTextLayer(page.id);
}

/* ------------------------------------------------ pointeur */
// Écran tactile : un doigt qui glisse fait défiler le document ; seul un « toucher » (doigt posé puis levé
// presque au même endroit) ajoute un texte, une coche ou une signature.
let lastTap = null, lastDoubleTap = 0, swallowTouchEnd = 0;
// après un toucher traité, le navigateur simule des clics de souris qui retireraient le curseur
// de la zone de texte qu'on vient d'ouvrir : on les supprime
window.addEventListener('touchend', ev => { if (swallowTouchEnd && Date.now() - swallowTouchEnd < 400) { swallowTouchEnd = 0; if (ev.cancelable) ev.preventDefault(); } }, { capture: true, passive: false });
function waitTap(e, fn) {
  const x0 = e.clientX, y0 = e.clientY, id = e.pointerId;
  let moved = false;
  const mv = ev => { if (ev.pointerId === id && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 12) moved = true; };
  const done = ev => {
    if (ev.pointerId !== id) return;
    window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', done); window.removeEventListener('pointercancel', done);
    if (ev.type === 'pointerup' && !moved && !document.body.classList.contains('pinching')) { swallowTouchEnd = Date.now(); fn(ev); }
  };
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', done); window.addEventListener('pointercancel', done);
}
/** Vrai si ce toucher suit de près un autre au même endroit (double toucher). */
function isDoubleTap(ev, key) {
  const now = Date.now();
  const dbl = lastTap && lastTap.key === key && now - lastTap.t < 380 && Math.hypot(ev.clientX - lastTap.x, ev.clientY - lastTap.y) < 30;
  lastTap = dbl ? null : { key, t: now, x: ev.clientX, y: ev.clientY };
  if (dbl) lastDoubleTap = now;
  return dbl;
}

function onDown(e) {
  const touch = e.pointerType === 'touch';
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const pageId = pageOfElement(e.target); if (!pageId) return;
  const page = pageById(pageId);
  if (e.target.closest('.ff, .ff-check, .ff-sig, .ocr-banner, textarea.editor')) return;
  // un clic sur le document reprend le clavier (Suppr, flèches, Ctrl+Z…), même si une case du panneau avait le curseur
  const ae = document.activeElement;
  if (state.editing || (ae && ae !== document.body && ae.matches('input, select, textarea, button, [contenteditable]'))) ae.blur();
  mat.focus({ preventScroll: true });
  const handle = e.target.closest('.handle');
  const objEl = e.target.closest('.obj:not(.cover)');
  if (handle && objEl) { e.preventDefault(); return startResize(e, page, objEl.dataset.id, handle.dataset.h); }
  if (objEl && !(state.tool === 'sign' && state.pendingSignature)) { e.preventDefault(); return startMove(e, page, objEl.dataset.id); }
  const tb = e.target.closest('.tblock');
  if (tb && state.tool === 'edit') {
    if (touch) return waitTap(e, () => editBlock(page, tb._block, tb));
    e.preventDefault(); return editBlock(page, tb._block, tb);
  }
  const pim = e.target.closest('.pimg');
  if (pim && state.tool === 'select') {
    e.preventDefault();
    // image de toute la page (scan, photo convertie) : un simple clic ne la prend pas,
    // il faut la faire glisser ou double-cliquer dessus
    const full = pim._img.w * pim._img.h >= page.w * page.h * 0.85;
    // un clic dans une zone corrigée ou effacée ne doit jamais attraper l'image de la page
    const pt = pagePoint(e, pageId);
    if (page.objects.some(o => o.cover && pt.x >= o.cover.x && pt.x <= o.cover.x + o.cover.w && pt.y >= o.cover.y && pt.y <= o.cover.y + o.cover.h && !(o.origin === 'lift' && full))) {
      if (state.selected) select(null);
      return;
    }
    if (!full && !touch) return liftAndDrag(e, page, pim);
    if (touch) {
      // au doigt, glisser fait défiler : une image du document se prend par un double toucher
      return waitTap(e, ev => {
        if (isDoubleTap(ev, 'pim:' + pageId)) liftAndDrag({ clientX: ev.clientX, clientY: ev.clientY }, page, pim, true);
        else if (state.selected) select(null);
        else fullPageHint(page);
      });
    }
    const x0 = e.clientX, y0 = e.clientY;
    let started = false;
    const mv = ev => {
      if (started || Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
      started = true; cleanup(); liftAndDrag(e, page, pim);
    };
    const up = () => {
      cleanup();
      if (started) return;
      if (state.selected) select(null);
      else fullPageHint(page);
    };
    const cleanup = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    return;
  }
  const p = pagePoint(e, pageId);
  if (touch && state.tool === 'annot' && (state.annot.kind === 'note' || state.annot.kind === 'stamp')) return waitTap(e, () => addAnnotAt(page, p));
  if (touch && (state.tool === 'text' || state.tool === 'mark' || state.tool === 'sign')) {
    return waitTap(e, () => {
      if (state.tool === 'text') addText(page, p);
      else if (state.tool === 'mark') addMark(page, p);
      else if (state.pendingSignature) placeSignature(page, p);
      else emit('open-signature', {});
    });
  }
  if (touch && state.tool === 'select') return waitTap(e, () => { if (state.selected) select(null); });
  switch (state.tool) {
    case 'text': e.preventDefault(); return addText(page, p);
    case 'mark': e.preventDefault(); return addMark(page, p);
    case 'sign':
      e.preventDefault();
      if (state.pendingSignature) return placeSignature(page, p);
      return emit('open-signature', {});
    case 'mask': case 'highlight': case 'redact': e.preventDefault(); return drawRect(e, page, p);
    case 'annot':
      e.preventDefault();
      if (state.annot.kind === 'note' || state.annot.kind === 'stamp') return addAnnotAt(page, p);
      return drawShape(e, page, p);
    default: if (state.selected) select(null);
  }
}

let lifting = false, fullHintShown = false;
/** Une seule fois : comment prendre l'image de la page entière, et proposition de repérer les images qu'elle contient. */
function fullPageHint(page) {
  if (fullHintShown) return;
  fullHintShown = true;
  const touch = matchMedia('(pointer: coarse)').matches;
  toast(touch ? 'Cette page est une seule image. Pour déplacer un logo ou une illustration, repérez d\'abord les images.' : 'Cette page est une seule image (scan, export). Pour déplacer un logo ou une illustration, repérez d\'abord les images.',
    { duration: 9000, action: { label: 'Repérer les images', fn: () => findRegions(page) } });
}
async function liftAndDrag(e, page, pim, selectOnly = false) {
  if (lifting) return;
  lifting = true;
  pim.classList.add('is-busy');
  let released = selectOnly;
  const onUp = () => { released = true; };
  window.addEventListener('pointerup', onUp, { once: true });
  window.addEventListener('pointercancel', onUp, { once: true });
  try {
    const o = await liftImage(page, pim._img);
    renderObjects(page.id);
    renderImageLayer(page.id);
    // bouton encore enfoncé : on enchaîne directement sur le déplacement ; sinon simple sélection
    if (released) select(o.id); else startMove(e, page, o.id);
  } catch (err) {
    console.error(err);
    toast('Cette image ne peut pas être détachée du document.', { error: true });
  } finally {
    lifting = false; pim.classList.remove('is-busy');
    window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp);
  }
}

function objElement(pageId, id) { return getSlot(pageId)?.objs.querySelector(`[data-id="${id}"]`); }

function track(onMove, onUp) {
  const mv = ev => onMove(ev);
  const up = ev => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); onUp(ev); };
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
}

function startMove(e, page, id) {
  const f = findObject(id); if (!f) return;
  const o = f.obj;
  const wasSelected = state.selected === id;
  if (!wasSelected) select(id);
  const p0 = pagePoint(e, page.id), ox = o.x, oy = o.y;
  let moved = false;
  const el = objElement(page.id, id);
  track(ev => {
    const p = pagePoint(ev, page.id), dx = p.x - p0.x, dy = p.y - p0.y;
    if (!moved && Math.hypot(dx, dy) * state.zoom < 4) return;
    moved = true;
    o.x = clamp(ox + dx, -o.w * 0.8, page.w - o.w * 0.2);
    o.y = clamp(oy + dy, -o.h * 0.8, page.h - o.h * 0.2);
    if (el) { el.style.left = o.x * state.zoom + 'px'; el.style.top = o.y * state.zoom + 'px'; }
  }, ev => {
    if (moved) { commit(); renderObjects(page.id); emit('object-moved', id); return; }
    // outils Texte et Modifier : un clic écrit ; outil Sélection : un clic sélectionne, un double-clic écrit
    if (o.type === 'text' && (state.tool === 'text' || state.tool === 'edit')) startEditing(id);
    else if (o.type === 'text' && e.pointerType === 'touch' && isDoubleTap(ev, 'obj:' + id)) startEditing(id);
  });
}

function startResize(e, page, id, hd) {
  const f = findObject(id); if (!f) return;
  const o = f.obj, orig = { ...o }, p0 = pagePoint(e, page.id), ratio = o.h / o.w;
  const keep = o.type === 'image' || o.type === 'mark' || o.type === 'stamp';
  track(ev => {
    const p = pagePoint(ev, page.id), dx = p.x - p0.x, dy = p.y - p0.y;
    if (hd === 'p1' || hd === 'p2') {
      // trait ou flèche : on déplace l'extrémité saisie
      let a = { x: orig.x + (orig.fx ? orig.w : 0), y: orig.y + (orig.fy ? orig.h : 0) };
      let b = { x: orig.x + (orig.fx ? 0 : orig.w), y: orig.y + (orig.fy ? 0 : orig.h) };
      if (hd === 'p1') a = { x: a.x + dx, y: a.y + dy }; else b = { x: b.x + dx, y: b.y + dy };
      Object.assign(o, { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y), fx: b.x < a.x, fy: b.y < a.y });
    } else if (o.type === 'text') {
      if (hd === 'e') o.w = Math.max(12, orig.w + dx);
      else { const nx = Math.min(orig.x + dx, orig.x + orig.w - 12); o.w = orig.w + (orig.x - nx); o.x = nx; }
    } else if (keep) {
      const w = Math.max(6, hd.includes('w') ? orig.w - dx : orig.w + dx);
      o.w = w; o.h = w * ratio;
      o.x = hd.includes('w') ? orig.x + orig.w - w : orig.x;
      o.y = hd.includes('n') ? orig.y + orig.h - o.h : orig.y;
    } else {
      let x1 = orig.x, y1 = orig.y, x2 = orig.x + orig.w, y2 = orig.y + orig.h;
      if (hd.includes('w')) x1 += dx; else x2 += dx;
      if (hd.includes('n')) y1 += dy; else y2 += dy;
      o.x = Math.min(x1, x2); o.y = Math.min(y1, y2); o.w = Math.max(2, Math.abs(x2 - x1)); o.h = Math.max(2, Math.abs(y2 - y1));
    }
    renderObjects(page.id);
  }, () => { commit(); renderObjects(page.id); emit('selection'); });
}

/* ------------------------------------------------ annotations */
/** Flèche, trait, rectangle ou cercle tracé à la souris ou au doigt. Un simple clic pose une forme par défaut. */
function drawShape(e, page, p0) {
  const s = getSlot(page.id), z = state.zoom, A = state.annot;
  if (state.selected) select(null);
  const ghost = h('div', { class: 'obj shape ghost-shape' });
  s.objs.append(ghost);
  let p1 = { ...p0 };
  const build = (a, b) => {
    const line = A.kind === 'arrow' || A.kind === 'line';
    return { id: uid(), type: 'shape', shape: A.kind, color: A.color, width: A.width,
      x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.max(line ? 0 : 2, Math.abs(b.x - a.x)), h: Math.max(line ? 0 : 2, Math.abs(b.y - a.y)),
      fx: b.x < a.x, fy: b.y < a.y };
  };
  track(ev => {
    p1 = pagePoint(ev, page.id);
    const o = build(p0, p1);
    ghost.replaceChildren(shapeSvg(o, z));
    Object.assign(ghost.style, { left: o.x * z + 'px', top: o.y * z + 'px', width: o.w * z + 'px', height: o.h * z + 'px' });
  }, () => {
    ghost.remove();
    let o = build(p0, p1);
    if (Math.hypot(p1.x - p0.x, p1.y - p0.y) < 6) {
      // simple clic : forme de taille standard
      const d = { arrow: [70, 0], line: [70, 0], rect: [90, 50], ellipse: [70, 70] }[A.kind] || [70, 40];
      o = build(p0, { x: p0.x + d[0], y: p0.y + d[1] });
    }
    page.objects.push(o);
    // l'outil reste prêt pour la forme suivante ; la forme se règle ensuite avec l'outil Sélection
    commit(); renderObjects(page.id);
  });
}
/** Note (post-it) ou tampon posé à l'endroit cliqué. */
function addAnnotAt(page, p) {
  const A = state.annot;
  if (A.kind === 'stamp') {
    const text = A.stamp, hh = 27;
    const c = document.createElement('canvas').getContext('2d'); c.font = `bold ${hh * 0.48}px Helvetica, Arial, sans-serif`;
    const w = Math.max(40, c.measureText(text).width + hh * 0.95);
    const o = { id: uid(), type: 'stamp', text, color: A.color, x: clamp(p.x - w / 2, 0, page.w - w), y: clamp(p.y - hh / 2, 0, page.h - hh), w, h: hh };
    page.objects.push(o); commit(); renderObjects(page.id);
    return;
  }
  const o = { id: uid(), type: 'text', x: p.x, y: p.y, w: 150, h: 14, text: '', ...state.textDefaults, size: 11, color: '#111111', bg: '#fff3a0', note: true };
  page.objects.push(o);
  startEditing(o.id);
}

function drawRect(e, page, p0) {
  const s = getSlot(page.id), z = state.zoom;
  const ghost = h('div', { class: 'ghost-rect' });
  s.objs.append(ghost);
  let r = { x: p0.x, y: p0.y, w: 0, h: 0 };
  track(ev => {
    const p = pagePoint(ev, page.id);
    r = { x: Math.min(p.x, p0.x), y: Math.min(p.y, p0.y), w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y) };
    Object.assign(ghost.style, { left: r.x * z + 'px', top: r.y * z + 'px', width: r.w * z + 'px', height: r.h * z + 'px' });
  }, async () => {
    ghost.remove();
    if (r.w < 3 || r.h < 3) { if (state.selected) select(null); return; }
    let o;
    if (state.tool === 'redact') o = { id: uid(), type: 'redact', ...r, color: '#000000' };
    else if (state.tool === 'mask') {
      const { bg } = await sampleColors(page, r);
      o = { id: uid(), type: 'rect', ...r, color: bg };
    } else o = { id: uid(), type: 'highlight', ...r, color: '#ffe14d', opacity: 0.45 };
    page.objects.push(o);
    commit(); select(o.id);
  });
}

/* ------------------------------------------------ créations */
function addText(page, p) {
  const d = state.textDefaults;
  const w = clamp(page.w - p.x - 12, 40, 240);
  const o = { id: uid(), type: 'text', x: p.x, y: p.y - d.size * 0.65, w, h: d.size * d.lineHeight, text: '', ...d };
  page.objects.push(o);
  startEditing(o.id);
}
export function insertTextAtCenter(text) {
  const page = currentPageObj(); if (!page) return;
  const d = state.textDefaults;
  const o = { id: uid(), type: 'text', x: page.w / 2 - 60, y: page.h / 3, w: 160, h: d.size * d.lineHeight, text, ...d };
  page.objects.push(o); commit(); select(o.id);
  scrollIntoViewObj(page);
}
function addMark(page, p) {
  const size = state.markSize || 12;
  const o = { id: uid(), type: 'mark', mark: state.markKind, x: p.x - size / 2, y: p.y - size / 2, w: size, h: size, color: state.markColor || '#111111' };
  page.objects.push(o); commit(); select(o.id);
}

export function armSignature(asset) {
  const a = state.assets.get(asset);
  const w = 150, hh = w * a.h / a.w;
  state.pendingSignature = { asset, w, h: Math.min(hh, 70) === hh ? hh : 70, ratio: a.h / a.w };
  if (state.tool !== 'sign') setTool('sign'); else { document.body.classList.add('sign-armed'); }
  document.body.classList.add('sign-armed');
  setHint('Cliquez à l\'endroit où placer la signature. Échap pour annuler.');
  toast(matchMedia('(pointer: coarse)').matches ? 'Touchez le document à l\'endroit où signer.' : 'Cliquez sur le document à l\'endroit où signer.');
}
function placeSignature(page, p) {
  const ps = state.pendingSignature;
  let w = 150, hh = w * ps.ratio;
  if (hh > 70) { hh = 70; w = hh / ps.ratio; }
  const o = { id: uid(), type: 'image', kind: 'signature', asset: ps.asset, x: p.x - w / 2, y: p.y - hh / 2, w, h: hh };
  page.objects.push(o);
  state.pendingSignature = null;
  commit();
  setTool('select');
  select(o.id);
}
export function placeSignatureInRect(pageId, rect, asset) {
  const page = pageById(pageId); const a = state.assets.get(asset);
  const ratio = a.h / a.w;
  let w = rect.w * 0.96, hh = w * ratio;
  if (hh > rect.h * 0.96) { hh = rect.h * 0.96; w = hh / ratio; }
  const o = { id: uid(), type: 'image', kind: 'signature', asset, x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - hh) / 2, w, h: hh };
  page.objects.push(o); commit(); setTool('select'); select(o.id);
}
export function placeImage(asset) {
  const page = currentPageObj(); if (!page) return;
  const a = state.assets.get(asset);
  const maxW = page.w * 0.5, maxH = page.h * 0.4;
  const s = Math.min(maxW / a.w, maxH / a.h, 1);
  const w = a.w * s, hh = a.h * s;
  const o = { id: uid(), type: 'image', kind: 'image', asset, x: (page.w - w) / 2, y: (page.h - hh) / 3, w, h: hh };
  page.objects.push(o); commit(); setTool('select'); select(o.id);
  scrollIntoViewObj(page);
}
function scrollIntoViewObj(page) { if (!isNear(page.id)) scrollToPage(page.id); }

/** Police à utiliser pour une proposition de la reconnaissance visuelle. */
export async function fontFromGuess(g) {
  if (g.std) return { font: g.std, bold: g.bold, italic: g.italic };
  return { font: await loadSystemFamily(g.name), bold: g.bold, italic: g.italic };
}
const STD_NAME = /^(arial|helvetica|times|timesnewroman|courier|couriernew)/i;

let editBusy = false;
async function editBlock(page, b, el) {
  if (editBusy) return;
  editBusy = true;
  el?.classList.add('is-busy');
  try { await doEditBlock(page, b); }
  finally { editBusy = false; el?.classList.remove('is-busy'); setHint(TOOL_HINTS[state.tool] || ''); }
}
async function doEditBlock(page, b) {
  const o = await buildEditObject(page, b);
  page.objects.push(o);
  startEditing(o.id);
  renderTextLayer(page.id);
}
/**
 * Prépare la correction d'un bloc de texte du PDF : objet texte de même apparence (police, taille,
 * couleur, alignement) et effacement de l'ancien texte en conservant le fond. Ne l'ajoute pas à la page.
 * fontCache : réutilise la police reconnue pour des lignes semblables (remplacements en série).
 */
export async function buildEditObject(page, b, { budgetMs = 2500, fontCache = null, fontBlock = null } = {}) {
  const r = { x: b.x, y: b.top, w: b.w, h: b.bottom - b.top };
  const [colors, sysFont] = await Promise.all([sampleColors(page, r), !b.ocr && STD_FONTS[b.font] ? matchSystemFont(b.pdfName) : null]);
  // l'ancien texte est effacé en conservant le fond (couleur, dégradé, photo) — calculé pendant la recherche de police
  // un peu plus haut que les lettres : les accents des majuscules (É, À…) dépassent souvent du cadre lu
  const up = Math.max(1.5, Math.min(b.size * 0.22, 6));
  const coverRect = { x: b.x - 1.5, y: b.top - up, w: b.w + 3, h: b.bottom - b.top + 1.5 + up };
  const patchP = textErasePatch(page, coverRect, colors.fg, colors.bg);
  // police inconnue (scan, photo, ou police absente de l'ordinateur) : reconnaissance visuelle, sinon Arial
  let font = sysFont || b.font, bold = b.bold, italic = b.italic, guesses;
  const pdfBase = (b.pdfName || '').replace(/^[A-Z]{6}\+/, '').replace(/[^a-z]/gi, '');
  const fkey = (b.pdfName || (b.ocr ? 'ocr' : b.font)) + '|' + Math.round(b.size) + '|' + !!b.bold;
  if (fontCache && fontCache.has(fkey)) ({ font, bold, italic, guesses } = fontCache.get(fkey));
  else if (b.ocr || (!sysFont && STD_FONTS[b.font] && pdfBase && !STD_NAME.test(pdfBase))) {
    setHint('Recherche de la police la plus proche…');
    try {
      // la recherche ne doit jamais bloquer les clics suivants : 4 s maximum
      // peu de lettres (un nombre, une date) : la police se reconnaît sur la ligne entière
      const all = await guessFont(page, fontBlock || b, { budgetMs });
      guesses = all.slice(0, 3).map(g => ({ name: g.name, std: g.std, bold: g.bold, italic: g.italic, score: Math.round(g.score * 100) / 100 }));
      if (all[0] && all[0].score >= MATCH_THRESHOLD) {
        const f = await fontFromGuess(all[0]);
        font = f.font; if (b.ocr) { bold = f.bold; italic = f.italic; }
      } else if (b.ocr) { font = 'helvetica'; }
    } catch (e) { console.warn('Reconnaissance de la police', e); if (b.ocr) font = 'helvetica'; }
  }
  // scan : le gras se voit à l'épaisseur des traits (plus sûr que la comparaison de polices sur quelques lettres)
  if (b.ocr) { const bb = await looksBold(page, r, colors.fg, b.size); if (bb != null) bold = bb; }
  // une ligne seule (titre, date…) peut s'allonger jusqu'à la marge au lieu de passer à la ligne
  let x, w;
  if (b.lines.length === 1) {
    const m = 14, cx = b.x + b.w / 2;
    if (b.align === 'center') { const half = Math.max(b.w / 2 + 2, Math.min(cx - m, page.w - m - cx)); x = cx - half; w = half * 2; }
    else if (b.align === 'right') { x = Math.min(b.x, m); w = b.x + b.w + 2 - x; }
    else { x = b.x; w = Math.max(b.w + 2, page.w - m - b.x); }
  } else {
    const extra = b.w * 0.03 + 2;
    x = b.x; w = b.w + extra;
  }
  const patch = await patchP;
  const o = {
    id: uid(), type: 'text', origin: 'edit', orig: b.text, pdfName: b.pdfName || undefined,
    x, y: b.base0 - b.size * ASC, w, h: b.bottom - b.top,
    text: b.text, size: Math.round(b.size * 10) / 10, font, bold, italic, fontGuesses: guesses,
    color: colors.fg, align: b.align, lineHeight: Math.round(b.lineHeight * 100) / 100,
    cover: patch ? { ...patch, color: colors.bg } : { ...coverRect, color: colors.bg },
  };
  // la zone cliquable couvre tout l'emplacement d'origine, même si le nouveau texte est plus court
  o.minH = b.bottom + 1.5 - o.y;
  if (fontCache && !fontCache.has(fkey)) fontCache.set(fkey, { font, bold, italic, guesses });
  return o;
}

/* ------------------------------------------------ édition de texte */
export function startEditing(id) {
  const f = findObject(id); if (!f || f.obj.type !== 'text') return;
  state.editing = id; state.selected = id;
  emit('selection');
}
function stopEditing({ id, related }) {
  if (state.editing !== id) return;
  state.editing = null;
  const f = findObject(id);
  if (f) {
    const o = f.obj;
    const toInspector = related && related.closest && related.closest('#inspector');
    if (!o.text.trim() && !o.cover && !toInspector) removeObject(id, false);
    else if (!o.text.trim() && o.origin === 'edit' && !toInspector) removeObject(id, false); // texte vidé : la zone reste effacée
    else if (o.origin === 'edit' && o.text === o.orig && !o.styled && !toInspector) removeObject(id, false, { restore: true });
  }
  commit();
  emit('selection');
  if (state.tool === 'edit') refreshTextLayers();
}

/** Supprime un élément. Pour une image du document : elle disparaît (son emplacement reste recouvert),
    sauf avec { restore: true } qui la remet à sa place d'origine. */
export function removeObject(id, doCommit = true, { restore = false } = {}) {
  const f = findObject(id); if (!f) return;
  const o = f.obj, origin = o.origin;
  // image du document ou texte corrigé : Suppr efface la zone ; « Rétablir » remet l'original
  const erase = (o.origin === 'lift' || o.origin === 'edit') && !restore;
  if (erase) { for (const k of Object.keys(o)) if (!['id', 'cover'].includes(k)) delete o[k]; o.type = 'erase'; }
  else f.page.objects.splice(f.page.objects.indexOf(o), 1);
  if (state.selected === id) state.selected = null;
  if (state.editing === id) state.editing = null;
  if (doCommit) {
    commit(); emit('selection'); emit('objects-changed', f.page.id); if (state.tool === 'edit') refreshTextLayers();
    const label = erase ? (origin === 'edit' ? 'Texte supprimé.' : 'Image supprimée.')
      : restore ? (origin === 'edit' ? 'Texte d\'origine rétabli.' : 'Image remise à sa place d\'origine.') : 'Élément supprimé.';
    toast(label, { action: { label: 'Annuler', fn: () => undo() } });
  }
}
export function updateObject(id, patch) {
  const f = findObject(id); if (!f) return;
  Object.assign(f.obj, patch);
  if (f.obj.type === 'text') f.obj.styled = true;
  commit(); renderObjects(f.page.id); emit('object-updated', id);
}
let nudgeTimer = 0;
export function nudge(dx, dy) {
  const f = findObject(state.selected); if (!f) return;
  f.obj.x += dx; f.obj.y += dy; renderObjects(f.page.id);
  // une série d'appuis sur les flèches = une seule étape d'annulation
  clearTimeout(nudgeTimer); nudgeTimer = setTimeout(flushNudge, 500);
}
/** Valide tout de suite un déplacement au clavier en attente (avant d'annuler, par exemple). */
export function flushNudge() { if (nudgeTimer) { clearTimeout(nudgeTimer); nudgeTimer = 0; commit(); } }
export function copyToAllPages(id) {
  const f = findObject(id); if (!f) return;
  let n = 0;
  for (const p of state.pages) {
    if (p === f.page) continue;
    const c = JSON.parse(JSON.stringify(f.obj)); c.id = uid();
    if (c.x + c.w > p.w) c.x = Math.max(0, p.w - c.w);
    if (c.y + c.h > p.h) c.y = Math.max(0, p.h - c.h);
    delete c.cover; delete c.origin; delete c.orig;
    p.objects.push(c); n++;
  }
  commit(); emit('objects-changed');
  toast(n ? `Copié sur ${n} autre${n > 1 ? 's' : ''} page${n > 1 ? 's' : ''}.` : 'Le document n\'a qu\'une page.');
}
export function duplicateObject(id) {
  const f = findObject(id); if (!f) return;
  const c = JSON.parse(JSON.stringify(f.obj)); c.id = uid(); c.x += 12; c.y += 12; delete c.cover; delete c.origin; delete c.orig;
  f.page.objects.push(c); commit(); select(c.id);
}
export function bringFront(id) {
  const f = findObject(id); if (!f) return;
  f.page.objects.splice(f.page.objects.indexOf(f.obj), 1); f.page.objects.push(f.obj); commit(); renderObjects(f.page.id);
}
