// Fichiers récents sur l'écran d'accueil.
// Navigateur et Android : une copie des derniers PDF ouverts est gardée sur l'appareil (IndexedDB),
// jamais envoyée ailleurs. Application Windows : seuls les chemins sont retenus (par l'application),
// plus une petite miniature.
import { state, h, $, toast, on, emit, pdfjsLib, PDFJS_OPTS, svgIcon, ICONS } from './core.js';
import { modal, confirmDialog } from './ui.js';

const desktop = window.atelierDesktop;
const MAX = 8, PER_FILE = 60e6, TOTAL = 200e6;
const OFF_KEY = 'atelierpdf.recents.off';

let opener = null; // (File) => ouvre le fichier comme s'il venait d'être choisi
export const recentsEnabled = () => { try { return localStorage.getItem(OFF_KEY) !== '1'; } catch { return true; } };

/* ------------------------------------------------ stockage */
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('atelier-pdf-recents', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('files', { keyPath: 'id' });   // navigateur / Android : le fichier lui-même
      r.result.createObjectStore('thumbs', { keyPath: 'key' }); // Windows : miniature par chemin
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }).catch(e => { dbp = null; throw e; });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode), s = t.objectStore(store);
    let out; const r = fn(s);
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out);
    t.onerror = t.onabort = () => rej(t.error);
  });
}
const getAll = store => tx(store, 'readonly', s => s.getAll()).catch(() => []);

/* ------------------------------------------------ miniatures */
async function thumbOf(pdf) {
  const page = await pdf.getPage(1);
  const vp0 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: 168 / Math.max(vp0.width, vp0.height) });
  const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvas: c, viewport: vp }).promise;
  return c.toDataURL('image/jpeg', 0.72);
}
async function thumbFromBytes(bytes) {
  let task;
  try { task = pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes.slice() }); return await thumbOf(await task.promise); }
  catch { return null; }
  finally { task?.destroy(); }
}
/** Miniature du document affiché (première page du fichier d'origine). */
async function currentThumb() {
  const p = state.pages[0], src = p && state.sources.get(p.src);
  if (!src?.pdf || p.index !== 0) return null;
  try { return await thumbOf(src.pdf); } catch { return null; }
}

/* ------------------------------------------------ liste */
async function list() {
  if (desktop) {
    const [items, thumbs] = await Promise.all([desktop.recentList().catch(() => []), getAll('thumbs')]);
    const tm = new Map(thumbs.map(t => [t.key, t.thumb]));
    return items.map(r => ({ id: r.path, path: r.path, name: r.name, at: r.at, missing: !r.exists, thumb: tm.get(r.path) || null }));
  }
  const all = await getAll('files');
  return all.map(({ blob, ...r }) => r).sort((a, b) => b.at - a.at);
}

/** Navigateur / Android : mémorise le PDF qui vient d'être ouvert. Renvoie son identifiant. */
async function remember(file) {
  if (desktop || !recentsEnabled() || !file || file.size > PER_FILE) return null;
  try {
    const all = await getAll('files');
    const same = all.find(r => r.name === file.name && r.size === file.size);
    const id = same?.id || 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const blob = file.slice(0, file.size, 'application/pdf');
    const entry = { id, name: file.name, size: file.size, at: Date.now(), thumb: same?.thumb || null, blob };
    await tx('files', 'readwrite', s => s.put(entry));
    await prune();
    return id;
  } catch (e) { console.warn('Fichiers récents', e); return null; }
}
async function prune() {
  const all = (await getAll('files')).sort((a, b) => b.at - a.at);
  let total = 0; const drop = [];
  all.forEach((r, i) => { total += r.size || 0; if (i >= MAX || total > TOTAL) drop.push(r.id); });
  if (drop.length) await tx('files', 'readwrite', s => { drop.forEach(id => s.delete(id)); });
}
async function setThumb(id, thumb) {
  if (!thumb) return;
  if (desktop) return tx('thumbs', 'readwrite', s => s.put({ key: id, thumb, at: Date.now() })).catch(() => {});
  const r = await tx('files', 'readonly', s => s.get(id)).catch(() => null);
  if (r) await tx('files', 'readwrite', s => s.put({ ...r, thumb })).catch(() => {});
}

async function remove(item) {
  if (desktop) { await desktop.recentRemove(item.path).catch(() => {}); await tx('thumbs', 'readwrite', s => s.delete(item.path)).catch(() => {}); }
  else await tx('files', 'readwrite', s => s.delete(item.id)).catch(() => {});
  refresh();
}
async function clearAll() {
  if (desktop) await desktop.recentClear().catch(() => {});
  await tx('files', 'readwrite', s => s.clear()).catch(() => {});
  await tx('thumbs', 'readwrite', s => s.clear()).catch(() => {});
  refresh();
}

async function open(item) {
  if (desktop) {
    if (item.missing || !(await desktop.recentOpen(item.path).catch(() => false))) {
      toast(`« ${item.name} » est introuvable : il a peut-être été déplacé, renommé ou supprimé.`, { error: true, duration: 8000, action: { label: 'Retirer de la liste', fn: () => remove(item) } });
      refresh();
    }
    return;
  }
  const r = await tx('files', 'readonly', s => s.get(item.id)).catch(() => null);
  if (!r?.blob) { toast('Ce fichier n\'est plus disponible.', { error: true }); return remove(item); }
  const file = new File([r.blob], r.name, { type: 'application/pdf' });
  file.__recentId = r.id;
  opener(file);
}

/* ------------------------------------------------ affichage */
const DOC_ICON = '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>';
function when(t) {
  const d = Date.now() - t, min = 60e3;
  if (d < min) return 'à l\'instant';
  if (d < 60 * min) return `il y a ${Math.round(d / min)} min`;
  const day = new Date(t), today = new Date();
  if (day.toDateString() === today.toDateString()) return 'aujourd\'hui à ' + day.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const y = new Date(today); y.setDate(today.getDate() - 1);
  if (day.toDateString() === y.toDateString()) return 'hier à ' + day.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return day.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: day.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
const size = n => n >= 1e6 ? (n / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' Mo' : Math.max(1, Math.round(n / 1e3)) + ' Ko';
const folderOf = p => { const sep = p.includes('\\') ? '\\' : '/', parts = p.split(sep); parts.pop(); const f = parts.join(sep); return f.length > 46 ? '…' + f.slice(-45) : f; };

function itemEl(r, after) {
  const meta = desktop ? (r.missing ? 'Introuvable' : folderOf(r.path)) : size(r.size);
  const row = h('li', { class: 'recent' + (r.missing ? ' missing' : '') },
    h('button', { class: 'recent-open', type: 'button', title: desktop ? r.path : r.name, onclick: () => { after?.(); open(r); } },
      r.thumb ? h('img', { class: 'recent-thumb', src: r.thumb, alt: '' }) : h('span', { class: 'recent-thumb none' }, svgIcon(DOC_ICON)),
      h('span', { class: 'recent-text' },
        h('b', {}, r.name.replace(/\.pdf$/i, '')),
        h('small', {}, when(r.at) + ' · ' + meta))),
    h('button', { class: 'btn icon recent-x', type: 'button', title: 'Retirer de la liste', 'aria-label': `Retirer « ${r.name} » de la liste`, onclick: () => remove(r) }, svgIcon(ICONS.close)));
  return row;
}

async function renderWelcome() {
  const box = $('#recents'); if (!box) return;
  const items = recentsEnabled() || desktop ? await list() : [];
  const card = $('#dropzone');
  box.hidden = !items.length;
  card.classList.toggle('has-recents', items.length > 0);
  if (!items.length) return;
  const max = matchMedia('(max-width: 600px)').matches ? 4 : 5;
  const ul = box.querySelector('.recent-list');
  ul.replaceChildren(...items.slice(0, max).map(r => itemEl(r)));
  box.querySelector('[data-recents-all]').hidden = items.length <= max;
}
let refreshTimer = 0;
export function refresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { renderWelcome(); emit('recents-changed'); }, 30);
}

/** Fenêtre « Fichiers récents » (menu ⋮), utile quand un document est déjà ouvert. */
export async function openRecentsDialog() {
  const ul = h('ul', { class: 'recent-list in-dialog' });
  const empty = h('p', { class: 'help', hidden: true }, 'Aucun fichier récent pour le moment.');
  let m;
  const fill = async () => {
    const items = await list();
    ul.replaceChildren(...items.map(r => itemEl(r, () => m.close())));
    empty.hidden = items.length > 0;
    clearBtn.disabled = !items.length;
  };
  const clearBtn = h('button', { class: 'btn', type: 'button', onclick: async () => {
    if (await confirmDialog({ title: 'Effacer la liste ?', text: desktop ? 'Les fichiers eux-mêmes ne sont pas supprimés.' : 'Les copies gardées sur cet appareil sont supprimées. Vos fichiers d\'origine ne sont pas touchés.', ok: 'Effacer' })) { await clearAll(); fill(); }
  } }, 'Effacer la liste');
  const body = [ul, empty];
  if (!desktop) {
    const cb = h('input', { type: 'checkbox', checked: recentsEnabled(), onchange: async () => {
      try { cb.checked ? localStorage.removeItem(OFF_KEY) : localStorage.setItem(OFF_KEY, '1'); } catch {}
      if (!cb.checked) { await clearAll(); fill(); }
    } });
    body.push(h('label', { class: 'check-row', style: { marginTop: '14px' } }, cb, ' Garder une copie des derniers PDF ouverts sur cet appareil'),
      h('p', { class: 'help', style: { margin: '4px 0 0' } }, `Les ${MAX} derniers au plus, rien n'est envoyé sur internet.`));
  }
  m = modal({ title: 'Fichiers récents', width: 520, body: h('div', {}, ...body), foot: [clearBtn, h('button', { class: 'btn primary', type: 'button', onclick: () => m.close() }, 'Fermer')] });
  fill();
}

/* ------------------------------------------------ branchements */
/**
 * openFile : fonction d'ouverture de l'application (celle utilisée pour un fichier choisi).
 * Renvoie onOpened(file) à appeler après l'ouverture réussie d'un PDF (navigateur / Android).
 */
export function initRecents(openFile) {
  opener = openFile;
  const box = $('#recents');
  box.querySelector('[data-recents-all]').onclick = () => openRecentsDialog();
  box.querySelector('[data-recents-clear]').onclick = async () => {
    if (await confirmDialog({ title: 'Effacer la liste ?', text: desktop ? 'Les fichiers eux-mêmes ne sont pas supprimés.' : 'Les copies gardées sur cet appareil sont supprimées. Vos fichiers d\'origine ne sont pas touchés.', ok: 'Effacer' })) clearAll();
  };
  on('doc-closed', refresh);
  if (desktop) {
    // la liste est tenue par l'application ; ici on ajoute seulement la miniature
    const thumbIfNeeded = async () => {
      const p = state.filePath; if (!p) return;
      const have = await tx('thumbs', 'readonly', s => s.get(p)).catch(() => null);
      if (!have) setThumb(p, await currentThumb());
    };
    on('doc-opened', () => setTimeout(thumbIfNeeded, 600));
    on('saved', () => setTimeout(thumbIfNeeded, 300));
    window.addEventListener('focus', () => { if (document.body.classList.contains('is-empty')) refresh(); });
  } else {
    // nouvelle version enregistrée : elle remplace la copie gardée
    on('pdf-saved', async ({ bytes, name }) => {
      const id = state.recentId; if (!id || !recentsEnabled() || bytes.length > PER_FILE) return;
      const r = await tx('files', 'readonly', s => s.get(id)).catch(() => null); if (!r) return;
      const blob = new Blob([bytes], { type: 'application/pdf' });
      await tx('files', 'readwrite', s => s.put({ ...r, name, size: blob.size, at: Date.now(), blob })).catch(() => {});
      setThumb(id, await thumbFromBytes(bytes));
      prune().catch(() => {});
    });
  }
  refresh();
  return async file => {
    if (desktop) return;
    let id = null, have = null;
    if (file.__recentId) {
      // rouvert depuis la liste : il remonte en tête
      have = await tx('files', 'readonly', s => s.get(file.__recentId)).catch(() => null);
      if (have) { id = have.id; await tx('files', 'readwrite', s => s.put({ ...have, at: Date.now() })).catch(() => {}); }
    }
    if (!id) { id = await remember(file); have = id && await tx('files', 'readonly', s => s.get(id)).catch(() => null); }
    if (!id) return;
    state.recentId = id;
    if (have && !have.thumb) setThumb(id, await currentThumb());
  };
}
