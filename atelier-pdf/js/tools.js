// Outils et interactions sur les pages : sélection, déplacement, texte, coches, masques, signatures
import { state, on, emit, h, $, uid, clamp, commit, undo, findObject, pageById, ASC, toast, svgIcon, ICONS, STD_FONTS } from './core.js';
import { getSlot, pagePoint, renderObjects, slots, pagesEl, mat, pageOfElement, isNear, currentPageObj, scrollToPage } from './viewer.js';
import { getBlocks, runOcr, sampleColors } from './textdetect.js';
import { matchSystemFont, loadSystemFamily } from './systemfonts.js';
import { guessFont, MATCH_THRESHOLD } from './fontmatch.js';
import { liftImage, renderImageLayer } from './pageimages.js';

const TOOL_HINTS = {
  select: 'Cliquez sur une image du document ou un élément ajouté pour le sélectionner et le déplacer ; double-cliquez sur un texte pour l\'écrire. Suppr pour l\'effacer, Ctrl+Z pour annuler.',
  edit: 'Survolez le document : chaque bloc de texte reconnu s\'entoure. Cliquez dessus pour le corriger.',
  text: 'Cliquez à l\'endroit où écrire.',
  sign: 'Créez ou choisissez une signature, puis cliquez à l\'endroit où signer.',
  mark: 'Cliquez sur une case pour la cocher. Choisissez ✓, ✗ ou ● dans le panneau.',
  mask: 'Tracez un rectangle pour cacher une zone. Sa couleur s\'adapte au fond.',
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
function onDown(e) {
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
  if (tb && state.tool === 'edit') { e.preventDefault(); return editBlock(page, tb._block, tb); }
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
    if (!full) return liftAndDrag(e, page, pim);
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
      else if (!fullHintShown) { fullHintShown = true; toast(matchMedia('(pointer: coarse)').matches ? 'Image de la page entière : faites-la glisser pour la déplacer, ou touchez-la deux fois pour la sélectionner.' : 'Image de la page entière : faites-la glisser pour la déplacer, ou double-cliquez pour la sélectionner.', { duration: 6000 }); }
    };
    const cleanup = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    return;
  }
  const p = pagePoint(e, pageId);
  switch (state.tool) {
    case 'text': e.preventDefault(); return addText(page, p);
    case 'mark': e.preventDefault(); return addMark(page, p);
    case 'sign':
      e.preventDefault();
      if (state.pendingSignature) return placeSignature(page, p);
      return emit('open-signature', {});
    case 'mask': case 'highlight': e.preventDefault(); return drawRect(e, page, p);
    default: if (state.selected) select(null);
  }
}

let lifting = false, fullHintShown = false;
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
  }, () => {
    if (moved) { commit(); renderObjects(page.id); emit('object-moved', id); return; }
    // outils Texte et Modifier : un clic écrit ; outil Sélection : un clic sélectionne, un double-clic écrit
    if (o.type === 'text' && (state.tool === 'text' || state.tool === 'edit')) startEditing(id);
  });
}

function startResize(e, page, id, hd) {
  const f = findObject(id); if (!f) return;
  const o = f.obj, orig = { ...o }, p0 = pagePoint(e, page.id), ratio = o.h / o.w;
  const keep = o.type === 'image' || o.type === 'mark';
  track(ev => {
    const p = pagePoint(ev, page.id), dx = p.x - p0.x, dy = p.y - p0.y;
    if (o.type === 'text') {
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
    if (state.tool === 'mask') {
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
  const r = { x: b.x, y: b.top, w: b.w, h: b.bottom - b.top };
  const [colors, sysFont] = await Promise.all([sampleColors(page, r), !b.ocr && STD_FONTS[b.font] ? matchSystemFont(b.pdfName) : null]);
  // police inconnue (scan, photo, ou police absente de l'ordinateur) : reconnaissance visuelle, sinon Arial
  let font = sysFont || b.font, bold = b.bold, italic = b.italic, guesses;
  const pdfBase = (b.pdfName || '').replace(/^[A-Z]{6}\+/, '').replace(/[^a-z]/gi, '');
  if (b.ocr || (!sysFont && STD_FONTS[b.font] && pdfBase && !STD_NAME.test(pdfBase))) {
    setHint('Recherche de la police la plus proche…');
    try {
      // la recherche ne doit jamais bloquer les clics suivants : 4 s maximum
      const all = await guessFont(page, b, { budgetMs: 2500 });
      guesses = all.slice(0, 3).map(g => ({ name: g.name, std: g.std, bold: g.bold, italic: g.italic, score: Math.round(g.score * 100) / 100 }));
      if (all[0] && all[0].score >= MATCH_THRESHOLD) {
        const f = await fontFromGuess(all[0]);
        font = f.font; if (b.ocr) { bold = f.bold; italic = f.italic; }
      } else if (b.ocr) { font = 'helvetica'; }
    } catch (e) { console.warn('Reconnaissance de la police', e); if (b.ocr) font = 'helvetica'; }
  }
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
  const o = {
    id: uid(), type: 'text', origin: 'edit', orig: b.text, pdfName: b.pdfName || undefined,
    x, y: b.base0 - b.size * ASC, w, h: b.bottom - b.top,
    text: b.text, size: Math.round(b.size * 10) / 10, font, bold, italic, fontGuesses: guesses,
    color: colors.fg, align: b.align, lineHeight: Math.round(b.lineHeight * 100) / 100,
    cover: { x: b.x - 1.5, y: b.top - 1.5, w: b.w + 3, h: b.bottom - b.top + 3, color: colors.bg },
  };
  // la zone cliquable couvre tout l'emplacement d'origine, même si le nouveau texte est plus court
  o.minH = b.bottom + 1.5 - o.y;
  page.objects.push(o);
  startEditing(o.id);
  renderTextLayer(page.id);
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
