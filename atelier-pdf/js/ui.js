// Fenêtres modales et sélecteur de pages réutilisable
import { h, $, svgIcon, ICONS, state, fmtPages } from './core.js';

let openCount = 0;
export function modal({ title, body, foot, width = 560, onClose, dismissable = true }) {
  const root = $('#modalRoot');
  const prevFocus = document.activeElement;
  const closeBtn = h('button', { class: 'btn icon', title: 'Fermer', 'aria-label': 'Fermer' }, svgIcon(ICONS.close));
  const dlg = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, style: { '--mw': width + 'px' } },
    h('div', { class: 'modal-head' }, h('h2', {}, title), closeBtn),
    h('div', { class: 'modal-body' }, body),
    foot ? h('div', { class: 'modal-foot' }, foot) : null);
  const back = h('div', { class: 'backdrop' }, dlg);
  let closed = false;
  const close = (result) => {
    if (closed) return; closed = true;
    back.remove(); openCount--;
    document.removeEventListener('keydown', onKey, true);
    onClose && onClose(result);
    prevFocus && prevFocus.focus && prevFocus.focus({ preventScroll: true });
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissable) { e.stopPropagation(); close(); }
    if (e.key === 'Tab') { // garde le focus dans la fenêtre
      const f = [...dlg.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(x => !x.disabled && x.offsetParent);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  };
  closeBtn.onclick = () => dismissable && close();
  back.addEventListener('pointerdown', e => { if (e.target === back && dismissable) close(); });
  document.addEventListener('keydown', onKey, true);
  root.append(back); openCount++;
  setTimeout(() => (dlg.querySelector('[autofocus]') || dlg.querySelector('.modal-foot .btn.primary') || closeBtn).focus(), 30);
  return { el: dlg, close };
}
export const isModalOpen = () => openCount > 0;

export function confirmDialog({ title, text, ok = 'Confirmer', cancel = 'Annuler', danger = false, extra }) {
  return new Promise(resolve => {
    let result = null;
    const buttons = [];
    if (extra) buttons.push(h('button', { class: 'btn outline', onclick: () => { result = extra.value; m.close(result); } }, extra.label));
    buttons.unshift(h('span', { class: 'grow' }));
    buttons.push(h('button', { class: 'btn outline', onclick: () => m.close(null) }, cancel));
    buttons.push(h('button', { class: 'btn ' + (danger ? 'danger-fill' : 'primary'), onclick: () => { result = true; m.close(true); } }, ok));
    const m = modal({ title, body: h('p', { style: { margin: 0 } }, text), foot: buttons, width: 460, onClose: r => resolve(r ?? result) });
  });
}

export function promptDialog({ title, label, type = 'text', ok = 'Valider' }) {
  return new Promise(resolve => {
    const input = h('input', { class: 'input', type, autofocus: true, style: { width: '100%' } });
    const form = h('form', { onsubmit: e => { e.preventDefault(); m.close(input.value); } },
      h('div', { class: 'field' }, h('label', {}, label), input));
    const m = modal({ title, body: form, width: 420,
      foot: [h('button', { class: 'btn outline', onclick: () => m.close(null) }, 'Annuler'),
             h('button', { class: 'btn primary', onclick: () => m.close(input.value) }, ok)],
      onClose: r => resolve(r ?? null) });
  });
}

/* ------------------------------------------------------------------
   Sélecteur de pages : grille de miniatures + saisie « 1-3, 6 »
   ------------------------------------------------------------------ */
export function parseRange(str, n) {
  const set = new Set();
  for (const part of str.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d+)?\s*-\s*(\d+)?$/.exec(part);
    if (m) {
      let a = m[1] ? +m[1] : 1, b = m[2] ? +m[2] : n;
      if (a > b) [a, b] = [b, a];
      for (let i = Math.max(1, a); i <= Math.min(n, b); i++) set.add(i);
    } else if (/^\d+$/.test(part)) { const i = +part; if (i >= 1 && i <= n) set.add(i); }
    else return null;
  }
  return set;
}
export function formatRange(nums) {
  const a = [...nums].sort((x, y) => x - y), out = [];
  for (let i = 0; i < a.length; i++) {
    let j = i; while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++;
    out.push(j > i + 1 ? `${a[i]}-${a[j]}` : j === i + 1 ? `${a[i]}, ${a[j]}` : `${a[i]}`);
    i = j;
  }
  return out.join(', ');
}

/** thumbFor(pageId, maxW, maxH) -> canvas  ; initial: Set de numéros (1..n) */
export function pagePicker({ thumbFor, initial, onChange }) {
  const n = state.pages.length;
  let sel = new Set(initial);
  const range = h('input', { class: 'input picker-range', placeholder: 'ex. 1-3, 6', 'aria-label': 'Pages à inclure' });
  const grid = h('div', { class: 'picker-grid', role: 'group', 'aria-label': 'Pages' });
  const items = state.pages.map((p, i) => {
    const num = i + 1;
    const el = h('div', { class: 'pick', role: 'checkbox', tabindex: 0, 'aria-label': 'Page ' + num },
      h('span', { class: 'tick' }, svgIcon(ICONS.check)), thumbFor(p.id, 92, 120), h('span', { class: 'num' }, 'Page ' + num));
    const toggle = () => { sel.has(num) ? sel.delete(num) : sel.add(num); sync(true); };
    el.onclick = toggle;
    el.onkeydown = e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); } };
    grid.append(el);
    return el;
  });
  const sync = (updateRange) => {
    items.forEach((el, i) => { const on = sel.has(i + 1); el.classList.toggle('on', on); el.setAttribute('aria-checked', on); });
    if (updateRange) { range.value = sel.size === n ? '' : formatRange(sel); range.classList.remove('bad'); }
    onChange && onChange(sel);
  };
  range.addEventListener('input', () => {
    const v = range.value.trim();
    const r = v ? parseRange(v, n) : new Set(Array.from({ length: n }, (_, i) => i + 1));
    range.style.borderColor = r ? '' : 'var(--danger)';
    if (r) { sel = r; sync(false); }
  });
  const quick = (label, fn) => h('button', { class: 'btn small outline', type: 'button', onclick: () => { sel = new Set(Array.from({ length: n }, (_, i) => i + 1).filter(fn)); sync(true); } }, label);
  const curIdx = state.pages.findIndex(p => p.id === state.currentPage) + 1;
  const tools = h('div', { class: 'picker-tools' }, range,
    quick('Toutes', () => true), quick('Aucune', () => false),
    quick('Impaires', i => i % 2 === 1), quick('Paires', i => i % 2 === 0),
    curIdx ? quick('Page affichée', i => i === curIdx) : null);
  sync(true);
  return { el: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, tools, grid), get: () => [...sel].sort((a, b) => a - b) };
}

export function summaryText(n) { return n ? fmtPages(n) + ' sélectionnée' + (n > 1 ? 's' : '') : 'Aucune page sélectionnée'; }
