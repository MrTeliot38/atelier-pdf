// Barre d'action contextuelle (écrans tactiles) : toujours un moyen visible de terminer ce qu'on fait.
//  - saisie en cours        → « Terminé »
//  - élément sélectionné    → « Supprimer » et « OK »
//  - outil actif            → rappel de l'outil et « ✕ » pour revenir à la navigation
// + boutons de zoom flottants.
import { state, on, h, $, svgIcon, ICONS, findObject } from './core.js';
import { setTool, select, removeObject } from './tools.js';
import { setZoom, fitWidth } from './viewer.js';

const TOOLS = {
  edit: ['Modifier le texte', 'Touchez un bloc de texte pour le corriger'],
  text: ['Ajouter du texte', 'Touchez l\'endroit où écrire'],
  mark: ['Cocher', 'Touchez chaque case à cocher'],
  sign: ['Signer', 'Touchez l\'endroit où signer'],
  mask: ['Masquer', 'Tracez un rectangle avec le doigt'],
  highlight: ['Surligner', 'Tracez un rectangle avec le doigt'],
};
const TYPE = { text: 'Texte', image: 'Image', mark: 'Coche', rect: 'Masque', highlight: 'Surlignage', erase: 'Zone effacée' };
const IC = {
  done: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
};

export const touchUI = () => matchMedia('(pointer: coarse)').matches || window.innerWidth < 860;

export function initCtxBar() {
  const bar = h('div', { class: 'ctxbar', role: 'toolbar', 'aria-label': 'Action en cours', hidden: true });
  // le texte en cours de saisie ne doit pas perdre le curseur avant que le bouton ait réagi
  bar.addEventListener('pointerdown', e => e.preventDefault());
  const zoom = h('div', { class: 'zoomfab', role: 'group', 'aria-label': 'Zoom' },
    h('button', { type: 'button', title: 'Zoomer', 'aria-label': 'Zoomer', onclick: () => setZoom(state.zoom * 1.25) }, svgIcon(IC.plus)),
    h('button', { type: 'button', class: 'zoomfab-val', title: 'Ajuster à la largeur', 'aria-label': 'Ajuster à la largeur', onclick: () => fitWidth() }, '100 %'),
    h('button', { type: 'button', title: 'Dézoomer', 'aria-label': 'Dézoomer', onclick: () => setZoom(state.zoom / 1.25) }, svgIcon(IC.minus)));
  // bande placée entre les onglets et le document : elle ne recouvre jamais le texte en cours de saisie
  $('.workspace').before(bar);
  $('.workspace').append(zoom);
  on('zoom', () => { zoom.querySelector('.zoomfab-val').textContent = Math.round(state.zoom * 100) + ' %'; });

  const render = () => {
    if (!state.pages.length || !touchUI()) { bar.hidden = true; return; }
    const kids = [];
    if (state.editing) {
      kids.push(h('span', { class: 'ctx-label' }, h('b', {}, 'Saisie en cours')),
        h('button', { class: 'btn primary', type: 'button', onclick: finishTyping }, svgIcon(IC.done), 'Terminé'));
    } else if (state.selected) {
      const f = findObject(state.selected);
      kids.push(h('span', { class: 'ctx-label' }, h('b', {}, (f && TYPE[f.obj.type]) || 'Élément'), h('small', {}, 'sélectionné')),
        h('button', { class: 'btn ctx-del', type: 'button', title: 'Supprimer', 'aria-label': 'Supprimer l\'élément', onclick: () => removeObject(state.selected) }, svgIcon(ICONS.trash)),
        h('button', { class: 'btn primary', type: 'button', onclick: () => select(null) }, svgIcon(IC.done), 'OK'));
    } else if (TOOLS[state.tool]) {
      const [t, hint] = TOOLS[state.tool];
      kids.push(h('span', { class: 'ctx-label' }, h('b', {}, t), h('small', {}, hint)),
        h('button', { class: 'btn ctx-close', type: 'button', title: 'Fermer l\'outil et revenir à la navigation', 'aria-label': 'Fermer l\'outil ' + t, onclick: () => { select(null); setTool('select'); } }, svgIcon(ICONS.close)));
    }
    bar.replaceChildren(...kids);
    bar.hidden = !kids.length;
  };
  // saisie au doigt : le clavier prend la moitié de l'écran ; on libère la place (barre d'outils, réglages)
  // et on fait défiler pour garder la ligne en cours bien visible au-dessus du clavier
  let typing = false;
  const syncTyping = () => {
    const now = !!state.editing && touchUI();
    document.body.classList.toggle('typing', now);
    if (now && !typing) [60, 350, 700].forEach(t => setTimeout(keepEditorVisible, t));
    typing = now;
  };
  on('selection', syncTyping);
  window.visualViewport?.addEventListener('resize', () => { if (typing) keepEditorVisible(); });
  window.addEventListener('resize', () => { if (typing) setTimeout(keepEditorVisible, 50); });
  on('text-input', () => { if (typing) keepEditorVisible(true); });
  on('selection', render); on('tool', render); on('doc-opened', render); on('doc-closed', render); on('doc-switched', render); on('history', render);
  window.addEventListener('resize', render);
  render();
}

/** Termine la saisie : le texte est validé, le clavier se ferme. */
function finishTyping() {
  const ta = document.querySelector('textarea.editor');
  if (ta) ta.blur();
  if (state.editing) state.editing = null;
  select(null);
}

/** Fait défiler le document pour que la zone de saisie reste visible au-dessus du clavier. */
export function keepEditorVisible(soft) {
  const ta = document.querySelector('textarea.editor'), mat = document.getElementById('mat');
  if (!ta || !mat) return;
  const m = mat.getBoundingClientRect(), r = ta.getBoundingClientRect();
  const vv = window.visualViewport;
  const bottom = Math.min(m.bottom, vv ? vv.offsetTop + vv.height : innerHeight) - 12;
  const top = m.top + 8, avail = bottom - top;
  if (avail <= 40) return;
  if (r.height <= avail * 0.7) {
    // zone courte : placée dans le tiers supérieur de l'espace visible
    if (!soft || r.top < top || r.bottom > bottom) mat.scrollTop += r.top - (top + (avail - r.height) * 0.3);
  } else if (!soft || r.bottom > bottom) {
    // zone haute : on garde sa fin (là où l'on écrit) au-dessus du clavier
    mat.scrollTop += r.bottom - bottom + 20;
  }
  if (r.left < m.left + 4 || r.right > m.right - 4) mat.scrollLeft += r.left - m.left - 12;
}
