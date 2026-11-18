// Numéroter les pages : un petit texte ajouté sur chaque page (modifiable ensuite comme tout texte)
import { state, h, uid, commit, emit, toast, fmtPages } from './core.js';
import { modal } from './ui.js';

const FORMATS = [
  ['n', '1', (i) => `${i}`],
  ['page', 'Page 1', (i) => `Page ${i}`],
  ['slash', '1 / 12', (i, t) => `${i} / ${t}`],
  ['sur', 'Page 1 sur 12', (i, t) => `Page ${i} sur ${t}`],
  ['dash', '– 1 –', (i) => `– ${i} –`],
];
const PLACES = [['bc', 'En bas, au centre'], ['br', 'En bas, à droite'], ['bl', 'En bas, à gauche'], ['tc', 'En haut, au centre'], ['tr', 'En haut, à droite']];
const KEY = 'atelierpdf.numbering';

/** Ajoute (ou remplace) la numérotation. Les numéros déjà posés par cette fonction sont retirés avant. */
export function applyNumbering({ format = 'n', place = 'bc', start = 1, skipFirst = false, size = 10, onlyIds = null }) {
  const fmt = (FORMATS.find(f => f[0] === format) || FORMATS[0])[2];
  const targets = state.pages.filter(p => !onlyIds || onlyIds.has(p.id)).filter((p, i) => !(skipFirst && i === 0));
  // retire une numérotation précédente sur tout le document
  for (const p of state.pages) p.objects = p.objects.filter(o => !o.pageNum);
  const total = targets.length + start - 1;
  const margin = 28, w = 140, lh = 1.2;
  targets.forEach((p, k) => {
    // position dans le sens de lecture de la page (pages pivotées comprises)
    const rot = ((p.rot % 360) + 360) % 360, dw = rot % 180 ? p.h : p.w, dh = rot % 180 ? p.w : p.h;
    const align = place[1] === 'c' ? 'center' : place[1] === 'r' ? 'right' : 'left';
    let x = align === 'center' ? dw / 2 - w / 2 : align === 'right' ? dw - margin - w : margin;
    let y = place[0] === 'b' ? dh - margin - size * lh : margin - size * 0.3;
    // repère d'affichage → repère de la page non pivotée (le texte suit l'orientation de la page)
    if (rot === 90) [x, y] = [y, dw - x - w];
    else if (rot === 180) [x, y] = [dw - x - w, dh - y - size * lh];
    else if (rot === 270) [x, y] = [dh - y - size * lh, x];
    p.objects.push({ id: uid(), type: 'text', pageNum: true, x, y, w, h: size * lh, text: fmt(start + k, total),
      font: 'helvetica', size, color: '#333333', bold: false, italic: false, align, lineHeight: lh });
  });
  commit(); emit('objects-changed');
  return targets.length;
}
export function removeNumbering() {
  let n = 0;
  for (const p of state.pages) { const before = p.objects.length; p.objects = p.objects.filter(o => !o.pageNum); n += before - p.objects.length; }
  if (n) { commit(); emit('objects-changed'); }
  return n;
}

export function openNumberingDialog() {
  let saved = {}; try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
  const opt = { format: 'slash', place: 'bc', start: 1, skipFirst: false, size: 10, ...saved };
  const segOf = (list, key) => {
    const seg = h('div', { class: 'seg wrap', role: 'radiogroup' }, ...list.map(([v, l]) =>
      h('button', { type: 'button', 'aria-pressed': opt[key] === v, onclick: e => { opt[key] = v; seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b === e.currentTarget)); } }, l)));
    return seg;
  };
  const start = h('input', { class: 'input', type: 'number', min: 0, value: opt.start, style: { width: '90px' }, oninput: () => opt.start = Math.max(0, Math.floor(+start.value) || 0) });
  const size = h('select', { class: 'select', onchange: () => opt.size = +size.value }, ...[8, 9, 10, 11, 12, 14].map(s => h('option', { value: s, selected: s === opt.size }, s + ' pt')));
  const skip = h('input', { type: 'checkbox', checked: opt.skipFirst, onchange: () => opt.skipFirst = skip.checked });
  const sel = state.selectedPages.size;
  const onlySel = h('input', { type: 'checkbox', checked: false });
  const has = state.pages.some(p => p.objects.some(o => o.pageNum));
  const go = h('button', { class: 'btn primary' }, has ? 'Remplacer la numérotation' : 'Numéroter');
  go.onclick = () => {
    try { localStorage.setItem(KEY, JSON.stringify({ format: opt.format, place: opt.place, start: opt.start, skipFirst: opt.skipFirst, size: opt.size })); } catch {}
    const n = applyNumbering({ ...opt, onlyIds: onlySel.checked ? new Set(state.selectedPages) : null });
    m.close();
    toast(`${fmtPages(n)} numérotée${n > 1 ? 's' : ''}. Un numéro se modifie comme un texte ; Annuler (Ctrl+Z) retire tout.`, { duration: 7000 });
  };
  const m = modal({ title: 'Numéroter les pages', width: 560, body: [
    h('div', { class: 'opts' },
      h('label', {}, 'Format'), segOf(FORMATS.map(([v, l]) => [v, l]), 'format'),
      h('label', {}, 'Position'), segOf(PLACES, 'place'),
      h('label', {}, 'Premier numéro'), start,
      h('label', {}, 'Taille'), size),
    h('label', { class: 'check-row' }, skip, 'Ne pas numéroter la première page (page de garde)'),
    sel ? h('label', { class: 'check-row' }, onlySel, `Seulement les ${fmtPages(sel)} sélectionnée${sel > 1 ? 's' : ''}`) : null,
  ], foot: [
    has ? h('button', { class: 'btn outline danger', onclick: () => { const n = removeNumbering(); m.close(); toast(n ? 'Numérotation retirée.' : 'Aucune numérotation à retirer.'); } }, 'Retirer') : null,
    h('span', { class: 'grow' }), h('button', { class: 'btn outline', onclick: () => m.close() }, 'Annuler'), go] });
}
