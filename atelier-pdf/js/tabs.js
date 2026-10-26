// Onglets : plusieurs documents ouverts en même temps, et fusion de PDF
import { state, on, emit, h, $, uid, svgIcon, ICONS, toast, commit, resetHistory, exportHistory, importHistory, fmtPages } from './core.js';
import { ensureFormValues, releaseSources, closeDocument, loadFiles } from './docs.js';
import { confirmDialog, modal } from './ui.js';
import { mat, fitWidth } from './viewer.js';

const tabs = [];
let active = null;
const bar = $('#tabbar');

export const tabCount = () => tabs.length;
export const anyDirty = () => tabs.some(t => (t === active ? state.dirty : t.dirty));
const nameOf = t => (t === active ? state.docName : t.docName) || 'Document';
const pagesOf = t => (t === active ? state.pages : t.pages);

/** Range l'état du document affiché dans son onglet. */
function stash() {
  if (!active) return;
  Object.assign(active, {
    pages: state.pages, formValues: state.formValues, docName: state.docName, filePath: state.filePath, recentId: state.recentId, dirty: state.dirty,
    zoom: state.zoom, currentPage: state.currentPage, scrollTop: mat.scrollTop, scrollLeft: mat.scrollLeft,
    selectedPages: new Set(state.selectedPages), history: exportHistory(),
  });
}
/** Affiche un onglet déjà ouvert. */
function show(t) {
  if (state.editing) document.activeElement?.blur?.();
  active = t;
  Object.assign(state, { pages: t.pages, formValues: t.formValues, docName: t.docName, filePath: t.filePath, recentId: t.recentId, dirty: t.dirty,
    zoom: t.zoom, currentPage: t.currentPage, selected: null, editing: null });
  state.selectedPages = new Set(t.selectedPages);
  importHistory(t.history);
  state.dirty = t.dirty;
  emit('pages-changed'); emit('zoom'); emit('forms-changed'); emit('selection'); emit('history');
  requestAnimationFrame(() => { mat.scrollTop = t.scrollTop || 0; mat.scrollLeft = t.scrollLeft || 0; });
  emit('doc-switched', t.id);
  render();
}

/** Ouvre un document (résultat de loadFiles) dans un nouvel onglet. */
export function openTab(res, { quiet = false } = {}) {
  const prev = active;
  stash();
  const t = { id: uid('t'), pages: res.pages, docName: res.docName, filePath: res.filePath, dirty: false, formValues: ensureFormValues(res.pages, {}) };
  const at = prev ? tabs.indexOf(prev) + 1 : tabs.length;
  tabs.splice(at, 0, t);
  active = t;
  Object.assign(state, { pages: t.pages, formValues: t.formValues, docName: t.docName, filePath: t.filePath, recentId: null, selected: null, editing: null });
  state.selectedPages = new Set();
  emit('doc-opened');
  resetHistory();
  emit('doc-switched', t.id);
  render();
  if (prev && !quiet) {
    toast(`« ${t.docName} » est ouvert dans un nouvel onglet.`, {
      duration: 9000,
      action: { label: `Fusionner avec « ${prev.docName} »`, fn: () => mergeTabInto(t, prev) },
    });
  }
  return t;
}

export function switchTo(id) {
  const t = tabs.find(x => x.id === id);
  if (!t || t === active) return;
  stash(); show(t);
}
export function cycle(dir) {
  if (tabs.length < 2) return;
  const i = tabs.indexOf(active);
  switchTo(tabs[(i + dir + tabs.length) % tabs.length].id);
}

export async function closeTab(id = active?.id, { force = false } = {}) {
  const t = tabs.find(x => x.id === id); if (!t) return false;
  const dirty = t === active ? state.dirty : t.dirty;
  if (dirty && !force) {
    if (t !== active) { stash(); show(t); }
    const ok = await confirmDialog({ title: 'Fermer l\'onglet', text: `« ${nameOf(t)} » a des modifications non enregistrées. Elles seront perdues.`, ok: 'Fermer sans enregistrer', danger: true });
    if (!ok) return false;
  }
  if (tabs.length === 1) { tabs.length = 0; active = null; closeDocument(); render(); return true; }
  const i = tabs.indexOf(t);
  const wasActive = t === active;
  if (!wasActive) stash();
  tabs.splice(i, 1);
  releaseSources(tabs.flatMap(x => (x === active ? state.pages : x.pages)));
  if (wasActive) { active = null; show(tabs[Math.min(i, tabs.length - 1)]); }
  else render();
  return true;
}
on('doc-closed', () => { if (tabs.length) { tabs.length = 0; active = null; render(); } });

/* ------------------------------------------------ fusion */
function clonePages(pages) {
  return pages.map(p => {
    const c = JSON.parse(JSON.stringify(p));
    c.id = uid('p'); c.objects.forEach(o => o.id = uid());
    return c;
  });
}
function insertPages(newPages, where) {
  const cur = state.pages.findIndex(p => p.id === state.currentPage);
  const pos = where === 'start' ? 0 : where === 'after' && cur >= 0 ? cur + 1 : state.pages.length;
  state.pages.splice(pos, 0, ...newPages);
  ensureFormValues(newPages);
}
/** Ajoute les pages de l'onglet « from » à la fin de l'onglet « into », puis ferme « from ». */
export function mergeTabInto(from, into) {
  if (!tabs.includes(from) || !tabs.includes(into)) return;
  stash();
  if (active !== into) show(into);
  const pages = clonePages(from.pages);
  Object.assign(state.formValues, Object.fromEntries(Object.entries(from.formValues).filter(([k]) => !(k in state.formValues))));
  insertPages(pages, 'end');
  commit(); emit('pages-changed');
  tabs.splice(tabs.indexOf(from), 1);
  render();
  toast(`${fmtPages(pages.length)} de « ${from.docName} » ajoutée${pages.length > 1 ? 's' : ''} à la fin.`);
}

/** Fenêtre « Fusionner des PDF » : onglets ouverts et fichiers à ajouter au document affiché. */
export function openMergeDialog() {
  stash();
  const entries = tabs.filter(t => t !== active).map(t => ({ kind: 'tab', tab: t, label: t.docName, count: t.pages.length, on: true }));
  let where = 'end', closeMerged = true;
  const list = h('div', { class: 'merge-list' });
  const fileIn = h('input', { type: 'file', accept: 'application/pdf,.pdf,image/png,image/jpeg,image/webp', multiple: true, hidden: true });
  const go = h('button', { class: 'btn primary' }, 'Fusionner');
  const summary = h('span', { class: 'grow' });
  const renderList = () => {
    list.replaceChildren();
    if (!entries.length) list.append(h('p', { class: 'help', style: { margin: 0 } }, 'Aucun autre document ouvert. Ajoutez un ou plusieurs fichiers PDF ci-dessous.'));
    entries.forEach((e, i) => {
      const cb = h('input', { type: 'checkbox', checked: e.on, onchange: () => { e.on = cb.checked; sync(); } });
      const up = h('button', { class: 'btn icon small', type: 'button', title: 'Monter', disabled: i === 0, onclick: () => { [entries[i - 1], entries[i]] = [entries[i], entries[i - 1]]; renderList(); } }, svgIcon('<path d="M6 15l6-6 6 6"/>'));
      const down = h('button', { class: 'btn icon small', type: 'button', title: 'Descendre', disabled: i === entries.length - 1, onclick: () => { [entries[i + 1], entries[i]] = [entries[i], entries[i + 1]]; renderList(); } }, svgIcon('<path d="M6 9l6 6 6-6"/>'));
      list.append(h('div', { class: 'merge-row' },
        h('label', { class: 'check-row' }, cb, h('span', { class: 'merge-name' }, e.label), h('small', {}, fmtPages(e.count) + (e.kind === 'file' ? ' · fichier' : ' · onglet'))),
        h('span', { class: 'merge-move' }, up, down)));
    });
    sync();
  };
  const sync = () => {
    const sel = entries.filter(e => e.on);
    const n = sel.reduce((s, e) => s + e.count, 0);
    go.disabled = !sel.length;
    summary.textContent = sel.length ? `${fmtPages(n)} à ajouter à « ${state.docName} »` : 'Choisissez au moins un document';
  };
  fileIn.onchange = async () => {
    const files = [...fileIn.files]; fileIn.value = ''; if (!files.length) return;
    for (const f of files) {
      const res = await loadFiles([f]);
      if (res) entries.push({ kind: 'file', res, label: res.docName, count: res.pages.length, on: true });
    }
    renderList();
  };
  const whereSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Position' }, ...[['end', 'À la fin'], ['start', 'Au début'], ['after', 'Après la page affichée']].map(([v, l]) =>
    h('button', { type: 'button', 'aria-pressed': v === where, onclick: ev => { where = v; whereSeg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b === ev.currentTarget)); } }, l)));
  const closeCb = h('input', { type: 'checkbox', checked: true, onchange: () => closeMerged = closeCb.checked });
  go.onclick = () => {
    const sel = entries.filter(e => e.on);
    let added = [];
    for (const e of sel) {
      if (e.kind === 'tab') {
        added.push(...clonePages(e.tab.pages));
        for (const [k, v] of Object.entries(e.tab.formValues)) if (!(k in state.formValues)) state.formValues[k] = v;
      } else added.push(...e.res.pages);
    }
    insertPages(added, where);
    commit(); emit('pages-changed');
    if (closeMerged) for (const e of sel) if (e.kind === 'tab') tabs.splice(tabs.indexOf(e.tab), 1);
    releaseSources(tabs.flatMap(x => (x === active ? state.pages : x.pages)));
    render();
    m.close();
    toast(`Fusion terminée : ${fmtPages(added.length)} ajoutée${added.length > 1 ? 's' : ''}. Pensez à enregistrer.`);
  };
  const m = modal({ title: 'Fusionner des PDF', width: 560, body: [
    h('p', { class: 'help', style: { margin: 0 } }, `Les pages choisies sont ajoutées au document affiché, « ${state.docName} », dans l'ordre de la liste.`),
    list,
    h('div', {}, h('button', { class: 'btn small outline', type: 'button', onclick: () => fileIn.click() }, '+ Ajouter un fichier PDF…'), fileIn),
    h('div', { class: 'opts' }, h('label', {}, 'Position'), whereSeg),
    entries.some(e => e.kind === 'tab') ? h('label', { class: 'check-row' }, closeCb, 'Fermer les onglets fusionnés') : null,
  ], foot: [summary, h('button', { class: 'btn outline', onclick: () => m.close() }, 'Annuler'), go] });
  renderList();
}

/* ------------------------------------------------ barre d'onglets */
function render() {
  if (!bar) return;
  document.body.classList.toggle('has-tabs', tabs.length > 0);
  bar.replaceChildren(
    ...tabs.map(t => {
      const dirty = t === active ? state.dirty : t.dirty;
      const close = h('button', { class: 'tab-close', type: 'button', title: 'Fermer l\'onglet (Ctrl+W)', 'aria-label': 'Fermer ' + nameOf(t),
        onclick: e => { e.stopPropagation(); closeTab(t.id); } }, svgIcon(ICONS.close));
      const el = h('div', { class: 'tab' + (t === active ? ' on' : ''), role: 'tab', tabindex: 0, 'aria-selected': t === active, title: nameOf(t) + ' — ' + fmtPages(pagesOf(t).length),
        onclick: () => switchTo(t.id), onauxclick: e => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } },
        onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchTo(t.id); } } },
        ...[h('span', { class: 'tab-name' }, nameOf(t)), dirty ? h('span', { class: 'tab-dirty', title: 'Modifications non enregistrées' }) : null, close].filter(Boolean));
      return el;
    }),
    h('button', { class: 'tab-new', type: 'button', title: 'Ouvrir un autre PDF dans un nouvel onglet (Ctrl+O)', 'aria-label': 'Nouvel onglet', onclick: () => $('#fileInput').click() }, svgIcon('<path d="M12 5v14M5 12h14"/>')),
    ...(tabs.length > 1 ? [h('button', { class: 'btn small tab-merge', type: 'button', title: 'Réunir plusieurs PDF en un seul document', onclick: openMergeDialog }, svgIcon('<path d="M6 4v5a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3v5M18 4v5a3 3 0 0 1-3 3"/>'), 'Fusionner')] : []),
  );
  bar.querySelector('.tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
on('history', render);
on('saved', render);
on('pages-changed', () => { if (tabs.length) render(); });
export { render as renderTabs };
void fitWidth;
