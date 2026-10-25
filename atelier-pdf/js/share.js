// Enregistrement (application Windows) et partage par e-mail / WhatsApp
import { state, emit, h, toast, svgIcon, downloadBlob } from './core.js';
import { modal } from './ui.js';
import { buildPdf, buildFlatPdf, downloadPdf } from './export.js';
import { canShareFiles, shareBlob, isAndroidApp } from './platform.js';

const desktop = window.atelierDesktop;
const baseOf = p => p.split(/[\\/]/).pop().replace(/\.pdf$/i, '');

/* ------------------------------------------------ enregistrer */
/** Application Windows : « Enregistrer » réécrit le fichier ouvert ; « Enregistrer sous » demande où. */
export async function savePdf(as = false) {
  if (!desktop) return downloadPdf();
  const t = toast('Enregistrement…', { duration: 60000 });
  try {
    const bytes = await buildPdf();
    let p = state.filePath;
    if (as || !p) {
      t.remove();
      p = await desktop.saveAs((state.docName || 'document') + '.pdf', bytes, state.filePath);
      if (!p) return;
    } else {
      await desktop.save(p, bytes);
      t.remove();
    }
    state.filePath = p;
    state.docName = baseOf(p);
    state.dirty = false;
    emit('history'); emit('saved');
    toast(`Enregistré dans « ${baseOf(p)}.pdf ».`, { action: { label: 'Afficher', fn: () => desktop.reveal(p) } });
  } catch (e) {
    console.error(e); t.remove();
    toast('Impossible d\'enregistrer ce fichier : il est peut-être ouvert dans un autre logiciel ou en lecture seule. Essayez « Enregistrer sous ».', { error: true, duration: 9000 });
  }
}

/* ------------------------------------------------ partager */
const ICON = {
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  whatsapp: '<path d="M4 20l1.3-3.9A8 8 0 1 1 8 19z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.5-2-1-1 .8a4 4 0 0 1-2-2l.8-1-1-2z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 19h16"/>',
};


export function openShareDialog() {
  let flat = false;
  const name = h('input', { class: 'input', value: (state.docName || 'document') + '.pdf', 'aria-label': 'Nom du fichier', style: { width: '100%' } });
  const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Version' }, ...[[false, 'PDF'], [true, 'PDF aplati']].map(([v, l]) =>
    h('button', { type: 'button', 'aria-pressed': v === flat, onclick: e => { flat = v; seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b === e.currentTarget)); } }, l)));
  const status = h('p', { class: 'help', style: { margin: 0, minHeight: '1.4em' } });
  const sys = canShareFiles();

  const fileName = () => { let n = name.value.trim() || 'document.pdf'; if (!/\.pdf$/i.test(n)) n += '.pdf'; return n.replace(/[\\/:*?"<>|]+/g, '-'); };
  const subject = () => fileName().replace(/\.pdf$/i, '');
  const body = () => `Bonjour,\r\n\r\nVeuillez trouver ci-joint le document « ${subject()} ».\r\n\r\nBien cordialement,\r\n`;
  const bytes = () => flat ? buildFlatPdf() : buildPdf();

  let busy = false;
  const run = (label, fn) => async () => {
    if (busy) return; busy = true;
    status.replaceChildren(h('span', { class: 'spinner', style: { display: 'inline-block', verticalAlign: 'middle', marginRight: '8px' } }), label);
    try { await fn(); m.close(); }
    catch (e) { if (e?.name !== 'AbortError') { console.error(e); status.textContent = 'Le partage n\'a pas abouti : ' + (e.message || e); } else status.textContent = ''; }
    busy = false;
  };

  const systemShare = async () => {
    await shareBlob(new Blob([await bytes()], { type: 'application/pdf' }), fileName(), subject());
  };

  const actions = [];
  if (desktop) {
    actions.push(['mail', 'E-mail', 'Ouvre un nouveau message avec le PDF en pièce jointe.', run('Préparation du message…', async () => {
      const p = await desktop.sharePrepare(fileName(), await bytes());
      const r = await desktop.shareMail(p, subject(), body());
      if (!r.ok) {
        await desktop.shareMailFallback(p, subject(), body());
        toast('Votre messagerie s\'ouvre sans pièce jointe automatique : collez le PDF dans le message (Ctrl+V) ou glissez-le depuis le dossier qui vient de s\'ouvrir.', { duration: 14000 });
      } else toast('Votre messagerie s\'ouvre avec le PDF en pièce jointe.');
    })]);
    actions.push(['whatsapp', 'WhatsApp', 'Copie le PDF et ouvre WhatsApp : choisissez la conversation, puis collez (Ctrl+V).', run('Préparation…', async () => {
      const p = await desktop.sharePrepare(fileName(), await bytes());
      const r = await desktop.shareWhatsapp(p);
      if (r.copied) toast(`PDF copié. Dans WhatsApp${r.app ? '' : ' Web'}, ouvrez la conversation puis collez avec Ctrl+V.`, { duration: 12000 });
      else { await desktop.reveal(p); toast('Dans WhatsApp, cliquez sur le trombone et choisissez le PDF dans le dossier qui vient de s\'ouvrir.', { duration: 12000 }); }
    })]);
    actions.push(['copy', 'Copier le fichier', 'À coller ensuite dans n\'importe quel message, Teams, un dossier…', run('Copie…', async () => {
      const p = await desktop.sharePrepare(fileName(), await bytes());
      if (await desktop.copyFile(p)) toast('PDF copié : collez-le où vous voulez avec Ctrl+V.');
      else { await desktop.reveal(p); toast('Le PDF est prêt dans le dossier qui vient de s\'ouvrir.'); }
    })]);
  } else {
    if (sys) actions.push(['share', 'Partager…', 'E-mail, WhatsApp, Messages et les autres applications de l\'appareil.', run('Préparation…', systemShare)]);
    if (isAndroidApp) actions.push(['download', 'Enregistrer sur le téléphone', 'Choisissez le dossier : Téléchargements, Documents, Drive…', run('Préparation…', async () => {
      if (await downloadBlob(new Blob([await bytes()], { type: 'application/pdf' }), fileName())) toast('PDF enregistré.');
    })]);
    actions.push(['mail', 'E-mail', sys ? 'Choisissez votre messagerie dans la liste.' : 'Télécharge le PDF et ouvre un nouveau message : joignez-y le fichier.', run('Préparation…', async () => {
      if (sys) return systemShare();
      downloadBlob(new Blob([await bytes()], { type: 'application/pdf' }), fileName());
      location.href = `mailto:?subject=${encodeURIComponent(subject())}&body=${encodeURIComponent(body())}`;
      toast('Le PDF est dans vos téléchargements : joignez-le au message qui s\'ouvre.', { duration: 10000 });
    })]);
    actions.push(['whatsapp', 'WhatsApp', sys ? 'Choisissez WhatsApp dans la liste.' : 'Télécharge le PDF et ouvre WhatsApp Web : joignez-le avec le trombone.', run('Préparation…', async () => {
      if (sys) return systemShare();
      downloadBlob(new Blob([await bytes()], { type: 'application/pdf' }), fileName());
      window.open('https://web.whatsapp.com/', '_blank', 'noopener');
      toast('Le PDF est dans vos téléchargements : dans WhatsApp, cliquez sur le trombone pour le joindre.', { duration: 10000 });
    })]);
  }

  const list = h('div', { class: 'share-list' }, ...actions.map(([icon, title, desc, fn]) =>
    h('button', { class: 'share-opt share-' + icon, type: 'button', onclick: fn },
      h('span', { class: 'share-ico' }, svgIcon(ICON[icon])),
      h('span', { class: 'share-txt' }, h('b', {}, title), h('small', {}, desc)))));

  const m = modal({ title: 'Partager', width: 520, body: [
    h('div', { class: 'opts' }, h('label', {}, 'Nom'), name, h('label', {}, 'Version'),
      h('div', { class: 'row' }, seg, h('span', { class: 'help' }, 'Aplati : chaque page en image, rien de masqué n\'est récupérable.'))),
    list, status,
  ] });
}
