// Mises à jour des applications Windows et Android : vérification sur la page des versions
// publiées (GitHub), seulement quand on le demande (ou une fois par semaine si on l'a choisi).
import { h, toast } from './core.js';
import { anyDirty } from './tabs.js';
import { modal } from './ui.js';

const desktop = window.atelierDesktop;
const cap = window.Capacitor;
const native = cap?.isNativePlatform?.() && cap.getPlatform?.() === 'android' ? cap.Plugins?.AtelierNative : null;
export const updatesAvailable = !!(desktop?.updateCheck || native);

const AUTO_KEY = 'atelierpdf.updates.auto', LAST_KEY = 'atelierpdf.updates.last';
const ls = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };
const clean = e => String(e?.message || e || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const mo = n => (n / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' Mo';

const api = {
  check: () => desktop ? desktop.updateCheck() : native.checkUpdate(),
  install: () => desktop ? desktop.updateInstall() : native.installUpdate(),
  page: url => desktop ? desktop.updateOpenPage() : native.openUrl({ url }),
  onProgress: cb => {
    if (desktop) return desktop.onUpdateProgress(cb);
    let handle = null; native.addListener('updateProgress', cb).then?.(x => { handle = x; });
    return () => handle?.remove?.();
  },
};

/** Notes de version (Markdown simple) en éléments, sans HTML venant de l'extérieur. */
function notesEl(md) {
  const box = h('div', { class: 'upd-notes' });
  let list = null;
  const inline = t => {
    const out = []; const re = /\*\*([^*]+)\*\*|`([^`]+)`/g; let i = 0, m;
    while ((m = re.exec(t))) { if (m.index > i) out.push(t.slice(i, m.index)); out.push(m[1] ? h('b', {}, m[1]) : h('code', {}, m[2])); i = re.lastIndex; }
    if (i < t.length) out.push(t.slice(i));
    return out;
  };
  for (const raw of String(md || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { list = null; continue; }
    // les empreintes techniques n'intéressent pas l'utilisateur ici
    if (/^#+\s*empreintes/i.test(line) || /[0-9a-f]{64}/i.test(line)) { list = null; continue; }
    const hd = /^#+\s*(.*)$/.exec(line);
    if (hd) { box.append(h('h4', {}, ...inline(hd[1]))); list = null; continue; }
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (li) { if (!list) { list = h('ul'); box.append(list); } list.append(h('li', {}, ...inline(li[1]))); continue; }
    box.append(h('p', {}, ...inline(line))); list = null;
  }
  return box;
}

export function openUpdateDialog(prefetched) {
  if (!updatesAvailable) return;
  const body = h('div', { class: 'upd' });
  const foot = h('div', { class: 'row', style: { justifyContent: 'flex-end', width: '100%', gap: '8px', flexWrap: 'wrap' } });
  const auto = h('input', { type: 'checkbox' }); auto.checked = ls.get(AUTO_KEY) === '1';
  auto.onchange = () => ls.set(AUTO_KEY, auto.checked ? '1' : null);
  const autoRow = h('label', { class: 'check-row upd-auto' }, auto, 'Vérifier automatiquement une fois par semaine');
  const privacy = h('p', { class: 'help upd-privacy' }, 'La vérification consulte la page des versions d\'Atelier PDF sur GitHub. Aucun document ni information personnelle n\'est envoyé.');
  let m = null, off = null, rel = null;

  const show = (...nodes) => { body.replaceChildren(...nodes, autoRow, privacy); };
  const btn = (label, fn, cls = 'outline') => h('button', { class: 'btn ' + cls, type: 'button', onclick: fn }, label);

  const checking = () => {
    show(h('p', { class: 'upd-status' }, h('span', { class: 'spinner' }), 'Recherche de la dernière version…'));
    foot.replaceChildren(btn('Fermer', () => m.close()));
  };
  const failed = (msg, what = 'La vérification', retry = run) => {
    show(h('p', { class: 'upd-status err' }, what + ' n\'a pas abouti : ' + msg));
    foot.replaceChildren(btn('Fermer', () => m.close()), btn('Réessayer', retry, 'primary'));
  };
  const result = r => {
    rel = r;
    ls.set(LAST_KEY, String(Date.now()));
    if (!r.latest) {
      show(h('p', { class: 'upd-status' }, 'Aucune version n\'est encore publiée.'));
      foot.replaceChildren(btn('Fermer', () => m.close(), 'primary'));
    } else if (!r.newer) {
      show(h('p', { class: 'upd-status ok' }, '✓ Atelier PDF est à jour', h('small', {}, `Version ${r.current}`)));
      foot.replaceChildren(btn('Notes de version', () => api.page(r.page)), btn('Fermer', () => m.close(), 'primary'));
    } else {
      show(
        h('p', { class: 'upd-status new' }, `Atelier PDF ${r.latest} est disponible`, h('small', {}, `Vous utilisez la version ${r.current}` + (r.size ? ` · téléchargement de ${mo(r.size)}` : ''))),
        notesEl(r.notes));
      foot.replaceChildren(btn('Plus tard', () => m.close()),
        r.installable ? btn('Télécharger et installer', install, 'primary') : btn('Ouvrir la page', () => api.page(r.page), 'primary'));
    }
  };
  async function run() {
    checking();
    try { result(await api.check()); } catch (e) { failed(clean(e)); }
  }
  async function install() {
    if (desktop && anyDirty()) {
      const go = await new Promise(res => {
        const c = modal({ title: 'Modifications non enregistrées', width: 460, body: h('p', {}, 'Atelier PDF va se fermer pour installer la mise à jour. Enregistrez d\'abord vos documents si besoin : Windows vous le proposera aussi à la fermeture.'),
          foot: [btn('Annuler', () => c.close(false)), btn('Continuer', () => c.close(true), 'primary')], onClose: v => res(!!v) });
      });
      if (!go) return;
    }
    const bar = h('div', { class: 'upd-bar' }, h('i'));
    const label = h('small', {}, 'Téléchargement…');
    show(h('p', { class: 'upd-status' }, `Téléchargement d'Atelier PDF ${rel.latest}`, label), bar);
    foot.replaceChildren(btn('Fermer', () => m.close()));
    off = api.onProgress(p => {
      const t = p.total || rel.size || 0;
      bar.firstChild.style.width = t ? Math.min(100, p.got / t * 100).toFixed(1) + '%' : '30%';
      label.textContent = p.done ? 'Vérification terminée' : t ? `${mo(p.got)} sur ${mo(t)}` : mo(p.got);
    });
    try {
      const r = await api.install();
      off?.(); off = null;
      if (desktop) {
        show(h('p', { class: 'upd-status ok' }, 'Installation en cours…', h('small', {}, 'Atelier PDF va se fermer ; l\'installateur le relancera une fois la mise à jour faite.')));
        foot.replaceChildren();
      } else if (r?.needPermission) {
        show(h('p', { class: 'upd-status' }, 'Autorisation nécessaire', h('small', {}, 'Android a ouvert ses réglages : activez « Autoriser cette source » pour Atelier PDF, revenez ici, puis touchez « Installer ».')));
        foot.replaceChildren(btn('Plus tard', () => m.close()), btn('Installer', install, 'primary'));
      } else {
        show(h('p', { class: 'upd-status ok' }, 'Mise à jour téléchargée et vérifiée', h('small', {}, 'Confirmez l\'installation dans la fenêtre d\'Android. Vos réglages et fichiers récents sont conservés.')));
        foot.replaceChildren(btn('Fermer', () => m.close()), btn('Relancer l\'installation', install, 'primary'));
      }
    } catch (e) {
      off?.(); off = null;
      failed(clean(e), 'L\'installation', install);
    }
  }

  m = modal({ title: 'Mises à jour', width: 520, body, foot: [foot], onClose: () => off?.() });
  if (prefetched) result(prefetched); else run();
}

/** Au démarrage : vérification discrète si l'option est cochée et la dernière date de plus d'une semaine. */
export function initUpdates() {
  for (const el of document.querySelectorAll('[data-act="updates"]')) el.hidden = !updatesAvailable;
  if (!updatesAvailable || ls.get(AUTO_KEY) !== '1') return;
  const last = +ls.get(LAST_KEY) || 0;
  if (Date.now() - last < 7 * 864e5) return;
  setTimeout(async () => {
    try {
      const r = await api.check();
      ls.set(LAST_KEY, String(Date.now()));
      if (r.newer) toast(`Atelier PDF ${r.latest} est disponible.`, { duration: 15000, action: { label: 'Voir', fn: () => openUpdateDialog(r) } });
    } catch { /* hors ligne : on réessaiera au prochain démarrage */ }
  }, 4000);
}
