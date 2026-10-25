// Atelier PDF — point d'entrée : barre d'outils, fichiers, raccourcis, application installable
import { state, on, emit, h, $, $$, initFonts, undo, redo, canUndo, canRedo, findObject, toast, fmtPages } from './core.js';
import { initViewer, setZoom, fitWidth, scrollToPage } from './viewer.js';
import { initTools, setTool, removeObject, nudge, flushNudge, duplicateObject, armSignature, placeImage, placeSignatureInRect, select } from './tools.js';
import { initPagesPanel, insertBlankPage, insertionIndex, clearPageSelection } from './pagesPanel.js';
import { initInspector } from './inspector.js';
import { openFiles, closeDocument, addImageAsset, imageToPage } from './docs.js';
import { closeTab, cycle, openMergeDialog, anyDirty, tabCount } from './tabs.js';
import { initPageImages } from './pageimages.js';
import { openSignatureDialog } from './signature.js';
import { downloadPdf, downloadFlattened, openPrintDialog, openImageDialog } from './export.js';
import { savePdf, openShareDialog } from './share.js';
import { modal, confirmDialog, isModalOpen } from './ui.js';
import { commit } from './core.js';

const VERSION = '1.5.0';
const desktop = window.atelierDesktop;
if (desktop) document.body.classList.add('is-desktop');
const isMobile = () => window.innerWidth < 860;

await initFonts();
initViewer();
initTools();
initPagesPanel();
initInspector();
initPageImages();
setTool('select');

// premier lancement après une mise à jour
try {
  const prev = localStorage.getItem('atelierpdf.version');
  if (prev && prev !== VERSION) setTimeout(() => toast(`Atelier PDF a été mis à jour : version ${VERSION}.`, { duration: 6000 }), 800);
  localStorage.setItem('atelierpdf.version', VERSION);
} catch {}

/* ------------------------------------------------ ouverture */
const fileInput = $('#fileInput');
const askOpen = () => fileInput.click();
$('#btnOpen').onclick = askOpen;
$('#btnOpenWelcome').onclick = askOpen;
fileInput.onchange = () => { const f = [...fileInput.files]; fileInput.value = ''; if (f.length) handleFiles(f); };

/** Chaque PDF s'ouvre dans son propre onglet ; plusieurs images choisies ensemble forment un seul document. */
async function handleFiles(files) {
  const pdfs = files.filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  const others = files.filter(f => !pdfs.includes(f));
  const groups = [...pdfs.map(f => [f]), ...(others.length ? [others] : [])];
  const busy = toast('Ouverture…', { duration: 60000 });
  const quiet = groups.length > 1;
  let opened = 0;
  try { for (const g of groups) if (await openFiles(g, { quiet })) opened++; } finally { busy.remove(); }
  if (quiet && opened > 1) toast(`${opened} documents ouverts, chacun dans son onglet.`, { duration: 9000, action: { label: 'Les fusionner', fn: openMergeDialog } });
}

on('doc-opened', () => {
  document.body.classList.remove('is-empty');
  updateDocName();
  setTool('select');
  if (isMobile()) document.body.classList.remove('sidebar-open');
});
on('doc-closed', () => { document.body.classList.add('is-empty'); updateDocName(); });
on('pages-changed', updateDocName);
on('saved', updateDocName);
on('doc-switched', updateDocName);
function updateDocName() {
  const el = $('#docName');
  el.replaceChildren(h('b', {}, state.docName || ''), state.pages.length ? '  ' + fmtPages(state.pages.length) : '');
  el.title = state.docName;
  document.title = state.docName ? state.docName + ' — Atelier PDF' : 'Atelier PDF';
}

// glisser-déposer n'importe où
let dragDepth = 0;
window.addEventListener('dragenter', e => { if (![...e.dataTransfer.types].includes('Files')) return; dragDepth++; $('#dropOverlay').hidden = false; $('#dropzone').classList.add('drag'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true; $('#dropzone').classList.remove('drag'); } });
window.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
window.addEventListener('drop', e => {
  if (!e.dataTransfer.files.length) return;
  e.preventDefault(); dragDepth = 0; $('#dropOverlay').hidden = true; $('#dropzone').classList.remove('drag');
  handleFiles([...e.dataTransfer.files]);
});

// fichiers partagés vers l'application installée (Windows/Chrome : « Ouvrir avec »)
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async params => {
    if (!params.files?.length) return;
    const files = await Promise.all(params.files.map(f => f.getFile()));
    handleFiles(files);
  });
}

/* ------------------------------------------------ ajout de pages */
const addMenu = $('#addMenu');
$('#btnAddPages').onclick = e => { e.stopPropagation(); toggleMenu(addMenu); };
addMenu.addEventListener('click', e => {
  const b = e.target.closest('[data-add]'); if (!b) return;
  addMenu.hidden = true;
  if (b.dataset.add === 'blank') insertBlankPage();
  if (b.dataset.add === 'pdf') $('#pdfInsertInput').click();
  if (b.dataset.add === 'image') { imageMode = 'page'; $('#imageInput').click(); }
});
$('#pdfInsertInput').onchange = async e => {
  const f = [...e.target.files]; e.target.value = ''; if (!f.length) return;
  await openFiles(f, { mode: 'append', at: insertionIndex() });
};
let imageMode = 'object';
$('#imageInput').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    if (imageMode === 'page') {
      const p = await imageToPage(f);
      state.pages.splice(insertionIndex(), 0, p); commit(); emit('pages-changed'); setTimeout(() => scrollToPage(p.id), 60);
    } else {
      const a = await addImageAsset(f); placeImage(a.id);
    }
  } catch (err) { toast('Cette image n\'a pas pu être lue.', { error: true }); }
  imageMode = 'object';
};

/* ------------------------------------------------ outils */
$('#toolstrip').addEventListener('click', e => {
  const b = e.target.closest('[data-tool]'); if (!b) return;
  const t = b.dataset.tool;
  if (t === 'image') { imageMode = 'object'; $('#imageInput').click(); return; }
  setTool(t);
  if (t === 'sign') startSigning();
});
on('tool', t => $$('#toolstrip [data-tool]').forEach(b => b.setAttribute('aria-pressed', b.dataset.tool === t)));
on('open-signature', () => startSigning());
on('sign-field', async ({ pageId, rect }) => {
  const asset = await openSignatureDialog();
  if (asset) placeSignatureInRect(pageId, rect, asset);
});
async function startSigning() {
  const asset = await openSignatureDialog();
  if (asset) armSignature(asset);
  else if (!state.pendingSignature) setTool('select');
}

/* ------------------------------------------------ barre du haut */
// une série de déplacements au clavier en attente d'enregistrement est validée avant d'annuler
const flushPending = () => flushNudge();
$('#btnUndo').onclick = () => { flushPending(); undo(); };
$('#btnRedo').onclick = redo;
on('history', () => { $('#btnUndo').disabled = !canUndo(); $('#btnRedo').disabled = !canRedo(); });
$('#btnZoomIn').onclick = () => setZoom(state.zoom * 1.2);
$('#btnZoomOut').onclick = () => setZoom(state.zoom / 1.2);
$('#btnZoomFit').onclick = () => fitWidth();
on('zoom', () => $('#btnZoomFit').textContent = Math.round(state.zoom * 100) + ' %');
$('#btnDownload').onclick = () => desktop ? savePdf() : downloadPdf();
$('#btnShare').onclick = openShareDialog;
$('#btnPrint').onclick = openPrintDialog;
$('#btnImages').onclick = openImageDialog;
$('#btnToggleSidebar').onclick = () => {
  if (isMobile()) document.body.classList.toggle('sidebar-open');
  else document.body.classList.toggle('sidebar-hidden');
  $('#btnToggleSidebar').setAttribute('aria-pressed', isMobile() ? document.body.classList.contains('sidebar-open') : !document.body.classList.contains('sidebar-hidden'));
};
$('#thumbs').addEventListener('click', () => { if (isMobile()) document.body.classList.remove('sidebar-open'); });
const updateIndicator = () => {
  const i = state.pages.findIndex(p => p.id === state.currentPage);
  $('#pageIndicator').textContent = i >= 0 ? `Page ${i + 1} sur ${state.pages.length}` : '';
};
on('current-page', updateIndicator);
on('pages-changed', updateIndicator);

const mainMenu = $('#mainMenu');
$('#btnMenu').onclick = e => { e.stopPropagation(); toggleMenu(mainMenu); };
mainMenu.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  mainMenu.hidden = true;
  const act = b.dataset.act;
  if (act === 'install') installApp();
  if (act === 'flat') downloadFlattened();
  if (act === 'saveas') savePdf(true);
  if (act === 'newwin') desktop?.newWindow();
  if (act === 'default') defaultReaderDialog();
  if (act === 'close') closeTab();
  if (act === 'merge') openMergeDialog();
  if (act === 'help') showHelp();
  if (act === 'about') showAbout();
});
function toggleMenu(m) {
  const open = m.hidden;
  $$('.menu').forEach(x => x.hidden = true);
  m.hidden = !open;
  if (open) m.querySelector('button:not([hidden])')?.focus();
}
document.addEventListener('pointerdown', e => { if (!e.target.closest('.menu, #btnMenu, #btnAddPages')) $$('.menu').forEach(x => x.hidden = true); });

/* ------------------------------------------------ raccourcis */
const TOOL_KEYS = { v: 'select', e: 'edit', t: 'text', s: 'sign', c: 'mark', m: 'mask', h: 'highlight' };
document.addEventListener('keydown', e => {
  if (isModalOpen()) return;
  const inField = e.target.closest?.('input, textarea, select, [contenteditable]');
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'o') { e.preventDefault(); return askOpen(); }
  if (!state.pages.length) return;
  if (mod && k === 's') { e.preventDefault(); return desktop ? savePdf(e.shiftKey) : downloadPdf(); }
  if (mod && k === 'p') { e.preventDefault(); return openPrintDialog(); }
  if (mod && k === 'w') { e.preventDefault(); return closeTab(); }
  if (mod && e.key === 'Tab') { e.preventDefault(); return cycle(e.shiftKey ? -1 : 1); }
  if (mod && e.key === 'PageDown') { e.preventDefault(); return cycle(1); }
  if (mod && e.key === 'PageUp') { e.preventDefault(); return cycle(-1); }
  if (mod && (k === '=' || k === '+')) { e.preventDefault(); return setZoom(state.zoom * 1.2); }
  if (mod && k === '-') { e.preventDefault(); return setZoom(state.zoom / 1.2); }
  if (mod && k === '0') { e.preventDefault(); return fitWidth(); }
  // curseur dans une case du panneau de droite (taille, police…) : Ctrl+Z annule l'action du document
  if (inField && mod && (k === 'z' || k === 'y') && e.target.closest('#inspector, #toolstrip, .topbar')) {
    e.preventDefault(); e.target.blur();
    return (k === 'y' || e.shiftKey) ? redo() : undo();
  }
  if (inField) return;
  if (mod && k === 'z') { e.preventDefault(); flushPending(); return e.shiftKey ? redo() : undo(); }
  if (mod && k === 'y') { e.preventDefault(); flushPending(); return redo(); }
  if (mod && k === 'd' && state.selected) { e.preventDefault(); return duplicateObject(state.selected); }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected) { e.preventDefault(); return removeObject(state.selected); }
  if (e.key === 'Delete' && !state.selected && !state.selectedPages.size) {
    return toast('Aucun élément sélectionné : cliquez d\'abord sur l\'élément à supprimer (outil Sélection).');
  }
  if (e.key === 'Escape') {
    if (state.pendingSignature) { state.pendingSignature = null; return setTool('select'); }
    if (state.selected) return select(null);
    if (state.selectedPages.size) return clearPageSelection();
    if (state.tool !== 'select') return setTool('select');
  }
  if (state.selected && e.key.startsWith('Arrow')) {
    e.preventDefault();
    const s = e.shiftKey ? 10 : 1;
    return nudge(e.key === 'ArrowLeft' ? -s : e.key === 'ArrowRight' ? s : 0, e.key === 'ArrowUp' ? -s : e.key === 'ArrowDown' ? s : 0);
  }
  if (!mod && !e.altKey && TOOL_KEYS[k]) { setTool(TOOL_KEYS[k]); if (TOOL_KEYS[k] === 'sign') startSigning(); }
});

if (desktop) {
  // application Windows : la fenêtre demande confirmation elle-même avant de se fermer
  const syncDirty = () => desktop.setDirty(anyDirty());
  on('history', syncDirty); on('doc-switched', syncDirty); on('saved', syncDirty);
  on('doc-closed', () => desktop.setDirty(false));
  on('doc-opened', () => desktop.setHasDoc(true));
  on('doc-closed', () => desktop.setHasDoc(false));
  desktop.onOpenFile(f => {
    const file = new File([f.data], f.name, { type: /\.pdf$/i.test(f.name) ? 'application/pdf' : '' });
    file.__path = f.path;
    handleFiles([file]);
  });
  // libellés propres à l'application
  $('#btnDownload .lbl').textContent = 'Enregistrer';
  $('#btnDownload').title = 'Enregistrer le PDF (Ctrl+S)';
  $('[data-act="flat"]').textContent = 'Enregistrer un PDF aplati (sans texte caché)…';
  for (const el of $$('.desktop-only')) el.hidden = false;
  refreshDefaultStatus();
  window.addEventListener('focus', refreshDefaultStatus);
} else {
  window.addEventListener('beforeunload', e => { if (anyDirty()) { e.preventDefault(); e.returnValue = ''; } });
}

/* ------------------------------------------------ lecteur PDF par défaut (Windows) */
var isDefaultReader = false;
async function refreshDefaultStatus() {
  if (!desktop) return;
  try { const st = await desktop.defaultStatus(); isDefaultReader = !!(st.supported && st.isDefault); if (!st.supported) return; }
  catch { return; }
  const item = $('[data-act="default"]');
  item.textContent = isDefaultReader ? '✓ Lecteur PDF par défaut' : 'Définir comme lecteur PDF par défaut…';
  $('#defaultHint').hidden = isDefaultReader;
}
document.querySelector('[data-act-default]')?.addEventListener('click', () => defaultReaderDialog());
function defaultReaderDialog() {
  const m = modal({ title: 'Lecteur PDF par défaut', width: 520, body: h('div', { class: 'prose' },
    h('p', {}, isDefaultReader ? 'Atelier PDF ouvre déjà vos PDF par défaut.' : 'Windows ne permet pas à un logiciel de se choisir lui-même : le réglage se fait dans Windows, en un clic.'),
    h('p', {}, h('b', {}, 'Dans la fenêtre qui va s\'ouvrir : '), 'cliquez sur « Définir par défaut » en haut (Windows 11), ou sur la ligne « .pdf » puis choisissez Atelier PDF.'),
    h('p', { class: 'help' }, 'Autre méthode : clic droit sur un PDF › Ouvrir avec › Choisir une autre application › Atelier PDF › Toujours.')),
    foot: [h('button', { class: 'btn outline', onclick: () => m.close() }, 'Fermer'),
      h('button', { class: 'btn primary', onclick: () => { desktop.openDefaultSettings(); m.close(); } }, 'Ouvrir les réglages de Windows')] });
}

/* ------------------------------------------------ aide */
function showHelp() {
  const keys = [
    ['Ctrl + O', 'Ouvrir un PDF ou une image'], ['Ctrl + S', desktop ? 'Enregistrer (Ctrl + Maj + S : enregistrer sous)' : 'Télécharger le PDF modifié'], ['Ctrl + P', 'Choisir les pages et imprimer'],
    ['Ctrl + Z / Ctrl + Y', 'Annuler / rétablir'], ['Ctrl + Tab', 'Onglet suivant (Ctrl + W : fermer l\'onglet)'], ['Suppr', 'Effacer l\'élément sélectionné'], ['Flèches', 'Déplacer l\'élément (Maj : plus vite)'],
    ['Ctrl + D', 'Dupliquer l\'élément'], ['Ctrl + molette', 'Zoomer'], ['Échap', 'Désélectionner'],
    ['V E T S C M H', 'Sélection, Modifier le texte, Texte, Signer, Cocher, Masquer, Surligner'],
  ];
  modal({ title: 'Aide', width: 600, body: [
    h('div', { class: 'prose' },
      h('p', {}, h('b', {}, 'Corriger un texte : '), 'choisissez « Modifier le texte », puis cliquez sur le paragraphe. Pour un scan ou une photo, cliquez sur « Lire le texte de cette page ».'),
      h('p', {}, h('b', {}, 'Remplir un formulaire : '), 'les champs prévus dans le PDF apparaissent en bleu clair. Sinon, utilisez « Ajouter du texte » et « Cocher ».'),
      h('p', {}, h('b', {}, 'Pages : '), 'faites glisser les miniatures pour les réordonner ; cochez-les pour les pivoter, dupliquer, supprimer ou les télécharger seules.')),
    h('dl', { class: 'kbd-list' }, ...keys.flatMap(([a, b]) => [h('dt', {}, h('kbd', {}, a)), h('dd', {}, b)])),
  ] });
}
function showAbout() {
  modal({ title: 'À propos d\'Atelier PDF', width: 520, body: h('div', { class: 'prose' },
    h('p', {}, 'Outil libre et gratuit pour retoucher, remplir, signer et réorganiser des PDF.'),
    h('p', {}, 'Tout se passe dans votre navigateur : vos documents ne sont jamais envoyés sur un serveur. Une fois installé, l\'outil fonctionne aussi sans connexion.'),
    h('p', { class: 'help' }, `Version ${VERSION}${desktop ? ' pour Windows' : ''}. Construit avec pdf.js et Tesseract.js (Apache 2.0), pdf-lib, JSZip et SortableJS (MIT), police Atkinson Hyperlegible (OFL).`)) });
}

/* ------------------------------------------------ application installable */
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; mainMenu.querySelector('[data-act="install"]').hidden = false; });
async function installApp() {
  if (!installEvt) return;
  installEvt.prompt();
  await installEvt.userChoice; installEvt = null;
  mainMenu.querySelector('[data-act="install"]').hidden = true;
}
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller)
          toast('Une nouvelle version est disponible.', { action: { label: 'Recharger', fn: () => location.reload() }, duration: 12000 });
      });
    });
  }).catch(err => console.warn('Service worker', err));
}

window.__atelier = { state, findObject }; // utile pour le débogage
