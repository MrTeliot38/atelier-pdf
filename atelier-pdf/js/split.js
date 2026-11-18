// Diviser un PDF en plusieurs fichiers, en une seule fois : toutes les N pages, ou selon des plages
import { state, h, toast, fmtPages, downloadBlob, savedToast, PDFLib } from './core.js';
import { modal } from './ui.js';
import { buildPdf } from './export.js';

/** « 1-3, 5, 8-10 » → [[0,1,2],[4],[7,8,9]] (indices de pages). Renvoie { groups } ou { error }. */
export function parseRanges(text, n) {
  const groups = [];
  for (const raw of String(text).split(/[,;]+/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^(\d+)?\s*[-–à]\s*(\d+)?$/.exec(part) || /^(\d+)$/.exec(part);
    if (!m) return { error: `« ${part} » n'est pas compris. Exemple : 1-3, 5, 8-10` };
    let a, b;
    if (m.length === 2) a = b = +m[1];
    else { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : n; }
    if (a < 1 || b < 1 || a > n || b > n) return { error: `La page ${Math.max(a, b) > n ? Math.max(a, b) : Math.min(a, b)} n'existe pas (le document a ${fmtPages(n)}).` };
    const g = [];
    if (a <= b) for (let i = a; i <= b; i++) g.push(i - 1);
    else for (let i = a; i >= b; i--) g.push(i - 1); // « 5-3 » : pages dans l'ordre inverse
    groups.push(g);
  }
  return groups.length ? { groups } : { error: 'Indiquez au moins une page.' };
}

/** Pages groupées par paquets de « size ». */
export const chunk = (n, size) => Array.from({ length: Math.ceil(n / size) }, (_, k) => Array.from({ length: Math.min(size, n - k * size) }, (_, i) => k * size + i));

/** Plages des pages cochées, regroupées quand elles se suivent : « 2-4, 7 ». */
function selectionRanges() {
  const nums = state.pages.map((p, i) => state.selectedPages.has(p.id) ? i + 1 : 0).filter(Boolean);
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i; while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(i === j ? `${nums[i]}` : `${nums[i]}-${nums[j]}`); i = j;
  }
  return out.join(', ');
}

const label = g => {
  const a = g[0] + 1, b = g[g.length - 1] + 1;
  if (g.length === 1) return `p${a}`;
  const consecutive = g.every((x, i) => i === 0 || Math.abs(x - g[i - 1]) === 1);
  return consecutive ? `p${a}-${b}` : `p${a}-etc`;
};
const fileNameFor = (prefix, g, k, total) => `${prefix}-${String(k + 1).padStart(String(total).length, '0')}-${label(g)}.pdf`;

export function openSplitDialog() {
  const n = state.pages.length;
  if (n < 2) { toast('Ce document n\'a qu\'une page : il n\'y a rien à diviser.'); return; }
  const fromSel = state.selectedPages.size ? selectionRanges() : '';
  let mode = fromSel ? 'ranges' : 'every';
  const every = h('input', { class: 'input', type: 'number', min: 1, max: n, value: 1, style: { width: '90px' }, 'aria-label': 'Nombre de pages par fichier' });
  const ranges = h('input', { class: 'input', placeholder: 'ex. 1-3, 4-6, 9', value: fromSel || '', style: { flex: 1 }, 'aria-label': 'Plages de pages' });
  const prefix = h('input', { class: 'input', value: state.docName || 'document', style: { flex: 1 }, 'aria-label': 'Début du nom des fichiers' });
  const rowEvery = h('div', { class: 'row' }, 'Un fichier toutes les', every, 'page(s)');
  const rowRanges = h('div', { class: 'row' }, ranges);
  const helpRanges = h('p', { class: 'help', style: { margin: '4px 0 0' } }, 'Chaque plage séparée par une virgule devient un fichier. « 1-3, 4-6, 9 » donne 3 fichiers.');
  const preview = h('div', { class: 'split-preview' });
  const summary = h('span', { class: 'grow' });
  const bar = h('div', { class: 'progress', hidden: true }, h('div'));
  const desktop = window.atelierDesktop;
  const go = h('button', { class: 'btn primary' }, desktop?.saveMany ? 'Choisir le dossier et enregistrer' : 'Diviser');
  const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Méthode' }, ...[['every', 'Toutes les N pages'], ['ranges', 'Selon des plages']].map(([v, l]) =>
    h('button', { type: 'button', 'aria-pressed': v === mode, onclick: e => { mode = v; seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b === e.currentTarget)); sync(); } }, l)));

  let groups = [];
  const sync = () => {
    rowEvery.hidden = mode !== 'every'; rowRanges.hidden = helpRanges.hidden = mode !== 'ranges';
    let err = '';
    if (mode === 'every') {
      const k = Math.max(1, Math.min(n, Math.floor(+every.value) || 1));
      groups = chunk(n, k);
    } else {
      const r = parseRanges(ranges.value, n);
      groups = r.groups || []; err = r.error || '';
    }
    const pre = (prefix.value.trim() || 'document').replace(/[<>:"/\\|?*]/g, '_');
    preview.replaceChildren(...(err ? [h('p', { class: 'error-text' }, err)] :
      groups.slice(0, 12).map((g, k) => h('div', { class: 'split-row' }, h('b', {}, fileNameFor(pre, g, k, groups.length)), h('small', {}, fmtPages(g.length)))))
      , ...(!err && groups.length > 12 ? [h('p', { class: 'help', style: { margin: '4px 0 0' } }, `… et ${groups.length - 12} autre(s) fichier(s).`)] : []));
    go.disabled = !!err || !groups.length;
    summary.textContent = err ? '' : `${groups.length} fichier${groups.length > 1 ? 's' : ''} PDF` + (!desktop?.saveMany && groups.length > 1 ? ' — archive .zip' : '');
  };
  every.oninput = sync; ranges.oninput = sync; prefix.oninput = sync;

  go.onclick = async () => {
    go.disabled = true; bar.hidden = false;
    const progress = p => { bar.firstChild.style.width = Math.round(p * 100) + '%'; };
    try {
      const pre = (prefix.value.trim() || 'document').replace(/[<>:"/\\|?*]/g, '_');
      const files = await splitPdf(groups, pre, progress);
      if (desktop?.saveMany) {
        const r = await desktop.saveMany(files.map(f => ({ name: f.name, bytes: f.bytes })), state.filePath);
        if (!r) { go.disabled = false; bar.hidden = true; return; }
        m.close();
        toast(`${r.files.length} PDF enregistrés.`, { duration: 8000, action: { label: 'Afficher le dossier', fn: () => desktop.reveal(r.files[0]) } });
        return;
      }
      let saved;
      if (files.length === 1) saved = await downloadBlob(new Blob([files[0].bytes], { type: 'application/pdf' }), files[0].name);
      else {
        const zip = new window.JSZip();
        for (const f of files) zip.file(f.name, f.bytes);
        saved = await downloadBlob(await zip.generateAsync({ type: 'blob' }), `${pre}-divisé.zip`);
      }
      m.close();
      if (saved !== false) savedToast(files.length > 1 ? `${files.length} PDF enregistrés dans une archive .zip.` : 'PDF enregistré.');
    } catch (e) {
      console.error(e); toast('La division a échoué : ' + (e.message || e), { error: true, duration: 8000 });
      go.disabled = false; bar.hidden = true;
    }
  };

  const m = modal({ title: 'Diviser le PDF', width: 560, body: [
    h('p', { class: 'help', style: { margin: 0 } }, `« ${state.docName} » (${fmtPages(n)}) est découpé en plusieurs fichiers PDF, avec toutes vos modifications. Le document ouvert ne change pas.`),
    h('div', { class: 'opts' },
      h('label', {}, 'Méthode'), seg,
      h('label', {}, 'Pages'), h('div', {}, rowEvery, rowRanges, helpRanges),
      h('label', {}, 'Nom des fichiers'), h('div', { class: 'row' }, prefix)),
    preview, bar,
  ], foot: [summary, h('button', { class: 'btn outline', onclick: () => m.close() }, 'Annuler'), go] });
  sync();
}

/** Fabrique un PDF par groupe de pages : le document complet n'est construit qu'une fois, puis découpé. */
export async function splitPdf(groups, prefix, progress = () => {}) {
  const ids = state.pages.map(p => p.id);
  const full = await PDFLib.PDFDocument.load(await buildPdf(ids, p => progress(p * 0.4)));
  // les champs de formulaire remplis sont figés dans chaque fichier (sinon ils seraient perdus en route)
  try { const f = full.getForm(); if (f.getFields().length) f.flatten(); } catch (e) { console.warn('Formulaire', e); }
  const files = [];
  for (let k = 0; k < groups.length; k++) {
    const doc = await PDFLib.PDFDocument.create();
    for (const pg of await doc.copyPages(full, groups[k])) doc.addPage(pg);
    doc.setProducer('Atelier PDF'); doc.setTitle(`${prefix} (${fmtPages(groups[k].length)})`);
    files.push({ name: fileNameFor(prefix, groups[k], k, groups.length), bytes: await doc.save({ useObjectStreams: true }) });
    progress(0.4 + 0.6 * (k + 1) / groups.length);
  }
  return files;
}
