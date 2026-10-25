// Panneau de réglages contextuel (objet sélectionné ou outil actif)
import { state, on, emit, h, $, svgIcon, ICONS, findObject, STD_FONTS, registerCustomFont, toast, todayFr, clamp, hasVariant } from './core.js';
import { systemFontsSupported, systemFontsGranted, listSystemFonts, loadSystemFamily, isDesktop } from './systemfonts.js';
import { updateObject, removeObject, duplicateObject, copyToAllPages, startEditing, ocrPage, refreshTextLayers, insertTextAtCenter, setTool, fontFromGuess } from './tools.js';
import { sampleColors } from './textdetect.js';
import { addImageAsset } from './docs.js';
import { currentPageObj, renderObjects } from './viewer.js';
import { findRegions } from './pageimages.js';

const ins = $('#inspector');
const touch = matchMedia('(pointer: coarse)').matches;
/** Texte adapté : souris et clavier, ou écran tactile. */
const T = (mouse, finger) => touch ? finger : mouse;
let key = '';
const INK = ['#111111', '#ffffff', '#c2362f', '#2446c9', '#2f7d4f', '#e8772e'];
const HL = ['#ffe14d', '#8ef0a0', '#8fd3ff', '#ffa6d2'];

export function initInspector() {
  on('selection', () => render());
  on('tool', () => render());
  on('restored', () => render(true));
  on('object-updated', () => render(true));
  on('doc-closed', () => { key = ''; ins.hidden = true; });
  on('ocr-progress', p => {
    const el = ins.querySelector('[data-ocr-status]'); if (!el) return;
    el.textContent = p.done ? '' : (p.label || 'Préparation…');
  });
  $('#fontInput').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const id = await registerCustomFont(f.name.replace(/\.(ttf|otf)$/i, ''), new Uint8Array(await f.arrayBuffer()));
      if (fontPickHandler) { fontPickHandler(id); fontPickHandler = null; }
      else { const sel = state.selected && findObject(state.selected); if (sel && sel.obj.type === 'text') updateObject(sel.obj.id, { font: id }); }
      toast(`Police « ${state.fonts.get(id).name} » ajoutée.`);
    } catch (err) { console.error(err); toast('Cette police n\'a pas pu être chargée (formats acceptés : .ttf, .otf).', { error: true }); }
  });
}

function render(force) {
  const sel = state.selected && findObject(state.selected);
  const k = sel ? 'o:' + sel.obj.id : 't:' + state.tool;
  if (!force && k === key) return;
  key = k;
  let content = null;
  if (sel) content = objectPanel(sel.obj, sel.page);
  else content = toolPanel(state.tool);
  if (!content) { ins.hidden = true; ins.replaceChildren(); return; }
  const closer = h('button', { class: 'btn icon small insp-close', type: 'button', title: 'Masquer ce panneau', 'aria-label': 'Masquer ce panneau', onclick: () => { ins.hidden = true; } }, svgIcon(ICONS.close));
  ins.replaceChildren(closer, ...[].concat(content));
  ins.hidden = false;
  // téléphone : sans élément sélectionné, le panneau reste replié (une ligne) pour laisser voir le document
  const mobile = window.innerWidth < 860;
  ins.classList.toggle('peek', mobile && !sel);
  const title = ins.querySelector('h2');
  if (mobile && title) {
    title.setAttribute('role', 'button'); title.tabIndex = 0;
    title.onclick = () => ins.classList.toggle('peek');
  }
}

/* ------------------------------------------------ briques */
const field = (label, ...kids) => h('div', { class: 'field' }, h('span', { class: 'lbl' }, label), ...kids);
function seg(options, value, onPick, label) {
  const el = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
  for (const o of options) el.append(h('button', { type: 'button', 'aria-pressed': o.v === value, title: o.t || '', 'aria-label': o.t || o.l,
    onclick: e => { const me = e.currentTarget; el.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b === me)); onPick(o.v); } },
    o.i ? svgIcon(o.i) : o.l));
  return el;
}
function toggle(label, on, onChange, disabled) {
  return h('button', { type: 'button', 'aria-pressed': !!on, disabled, title: label, onclick: e => { const v = e.currentTarget.getAttribute('aria-pressed') !== 'true'; e.currentTarget.setAttribute('aria-pressed', v); onChange(v); } },
    label === 'Gras' ? h('b', {}, 'G') : h('i', { style: { fontFamily: 'Georgia, serif' } }, 'I'));
}
function swatches(colors, value, onPick) {
  const list = colors.includes(value) || !value ? colors : [...colors, value];
  const wrap = h('div', { class: 'swatches' });
  const pick = h('input', { type: 'color', value: value || '#000000', 'aria-label': 'Autre couleur' });
  pick.addEventListener('change', () => onPick(pick.value));
  for (const c of list) wrap.append(h('button', { class: 'swatch', type: 'button', style: { background: c }, title: c, 'aria-label': 'Couleur ' + c, 'aria-pressed': c === value, onclick: () => onPick(c) }));
  wrap.append(h('label', { class: 'swatch swatch-pick', title: 'Autre couleur' }, pick));
  return wrap;
}
function sizeInput(value, onChange, { min = 4, max = 200, step = 0.5, unit = 'pt' } = {}) {
  const inp = h('input', { class: 'input num', type: 'number', min, max, step, value, 'aria-label': 'Taille' });
  const bump = step >= 0.5 ? 1 : 0.1;
  const set = v => { v = clamp(Math.round(v * 100) / 100, min, max); inp.value = v; onChange(v); };
  inp.addEventListener('change', () => set(+inp.value || value));
  return h('div', { class: 'row' },
    h('button', { class: 'btn icon small outline', type: 'button', title: 'Plus petit', onclick: () => set(+inp.value - bump) }, svgIcon('<path d="M5 12h14"/>')),
    inp,
    h('button', { class: 'btn icon small outline', type: 'button', title: 'Plus grand', onclick: () => set(+inp.value + bump) }, svgIcon('<path d="M12 5v14M5 12h14"/>')),
    unit ? h('span', { class: 'help' }, unit) : null);
}
/* ---- choix de la police : recherche, aperçu, polices de l'ordinateur ---- */
const fontLabel = id => STD_FONTS[id] ? STD_FONTS[id].label : state.fonts.get(id)?.name || 'Police';
const fontCss = id => STD_FONTS[id] ? STD_FONTS[id].css : state.fonts.get(id) ? `"${state.fonts.get(id).family}"` : 'inherit';
let fontPickHandler = null;
function fontSelect(value, onChange) {
  const btn = h('button', { class: 'select font-btn', type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' },
    h('span', { class: 'font-btn-label', style: { fontFamily: fontCss(value) } }, fontLabel(value)), svgIcon('<path d="M6 9l6 6 6-6"/>'));
  const wrap = h('div', { class: 'font-picker' }, btn);
  let panel = null, sys = null;
  const close = () => { panel?.remove(); panel = null; btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', outside, true); };
  const outside = e => { if (!wrap.contains(e.target)) close(); };
  const choose = id => { close(); onChange(id); };
  btn.onclick = () => panel ? close() : open();
  function open() {
    const search = h('input', { class: 'input', type: 'search', placeholder: 'Rechercher une police', 'aria-label': 'Rechercher une police' });
    const list = h('div', { class: 'font-list', role: 'listbox' });
    panel = h('div', { class: 'font-panel' }, search, list,
      h('button', { class: 'btn small outline font-import', type: 'button', onclick: () => { close(); fontPickHandler = onChange; $('#fontInput').click(); } }, 'Importer une police (.ttf, .otf)…'));
    wrap.append(panel); btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    const row = (id, label, css, onPick, extra) => h('button', { class: 'font-row' + (id === value ? ' on' : ''), type: 'button', role: 'option', 'aria-selected': id === value, onclick: onPick || (() => choose(id)) },
      h('span', { style: { fontFamily: css } }, label), extra || null);
    const render = () => {
      const q = search.value.trim().toLowerCase();
      const match = n => !q || n.toLowerCase().includes(q);
      const frag = [];
      const std = Object.entries(STD_FONTS).filter(([, f]) => match(f.label));
      if (std.length) frag.push(h('div', { class: 'font-sec' }, 'Polices de base'), ...std.map(([k, f]) => row(k, f.label, f.css)));
      const used = [...state.fonts.values()].filter(f => match(f.name));
      if (used.length) frag.push(h('div', { class: 'font-sec' }, 'Déjà utilisées'), ...used.map(f => row(f.id, f.name, `"${f.family}"`)));
      if (sys) {
        const names = new Set(used.map(f => f.name));
        const all = sys.filter(f => match(f.name) && !names.has(f.name));
        frag.push(h('div', { class: 'font-sec' }, `Polices de l'ordinateur (${all.length})`));
        for (const f of all.slice(0, 200)) {
          const r = row(null, f.name, `"${f.name}", var(--font)`, async () => {
            r.disabled = true; r.append(h('span', { class: 'spinner' }));
            try { choose(await loadSystemFamily(f.name)); }
            catch (e) { console.error(e); r.disabled = false; r.querySelector('.spinner')?.remove(); toast(`La police « ${f.name} » n'a pas pu être chargée.`, { error: true }); }
          }, f.faces.length > 1 ? h('small', {}, f.faces.length + ' styles') : null);
          frag.push(r);
        }
        if (all.length > 200) frag.push(h('p', { class: 'help font-more' }, 'Tapez quelques lettres pour voir les autres polices.'));
      } else if (systemFontsSupported()) {
        frag.push(h('div', { class: 'font-sec' }, 'Polices de l\'ordinateur'),
          h('button', { class: 'btn small primary font-sys-btn', type: 'button', onclick: async e => {
            e.currentTarget.replaceChildren(h('span', { class: 'spinner' }), 'Recherche des polices…');
            try { sys = await listSystemFonts(); render(); }
            catch (err) { console.warn(err); toast('Accès aux polices refusé. Vous pouvez l\'autoriser dans les réglages du site (icône à gauche de l\'adresse).', { error: true, duration: 8000 }); render(); }
          } }, 'Afficher les polices de l\'ordinateur'));
      } else {
        frag.push(h('p', { class: 'help font-more' }, 'Pour utiliser les polices installées sur l\'ordinateur, ouvrez l\'outil dans l\'application Windows, ou dans Chrome ou Edge.'));
      }
      list.replaceChildren(...frag);
    };
    search.addEventListener('input', render);
    search.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); btn.focus(); }
      if (e.key === 'Enter') { e.preventDefault(); list.querySelector('.font-row:not([disabled])')?.click(); }
    });
    render();
    setTimeout(() => search.focus(), 20);
    if (systemFontsSupported()) systemFontsGranted().then(ok => { if (ok && panel) listSystemFonts().then(f => { sys = f; if (panel) render(); }).catch(() => {}); });
  }
  return wrap;
}
const actionBtn = (icon, label, fn, cls = '') => h('button', { class: 'btn ' + cls, type: 'button', onclick: fn }, svgIcon(icon), label);

/* ------------------------------------------------ objets */
function objectPanel(o, page) {
  const up = patch => updateObject(o.id, patch);
  const actions = h('div', { class: 'insp-actions' });
  const out = [];
  if (o.type === 'text') {
    out.push(h('h2', {}, o.origin === 'edit' ? 'Texte corrigé' : 'Texte'));
    if (o.origin === 'edit') out.push(h('p', { class: 'help' }, 'Le texte d\'origine est recouvert par un fond de la couleur détectée, puis réécrit.'));
    out.push(field('Police', fontSelect(o.font, v => up({ font: v }))));
    if (o.fontGuesses?.length) {
      const cur = STD_FONTS[o.font] ? STD_FONTS[o.font].label : state.fonts.get(o.font)?.name;
      out.push(field('Polices les plus ressemblantes', h('div', { class: 'guess-list' }, ...o.fontGuesses.map(g => {
        const b = h('button', { class: 'guess' + (g.name === cur ? ' on' : ''), type: 'button', title: 'Utiliser ' + g.name },
          h('span', { style: { fontFamily: `"${g.name}", var(--font)`, fontWeight: g.bold ? 700 : 400, fontStyle: g.italic ? 'italic' : 'normal' } }, g.name + (g.bold ? ' gras' : '') + (g.italic ? ' italique' : '')),
          h('small', {}, Math.round(g.score * 100) + ' %'));
        b.onclick = async () => {
          b.disabled = true;
          try { up(await fontFromGuess(g)); } catch (e) { toast(`La police « ${g.name} » n'a pas pu être chargée.`, { error: true }); b.disabled = false; }
        };
        return b;
      })), h('p', { class: 'help' }, 'Comparaison de l\'image du texte avec les polices de cet ordinateur.')));
    }
    const pdfName = o.pdfName;
    if (pdfName && STD_FONTS[o.font] && !/^(arial|helvetica|times|courier)/i.test(pdfName.replace(/^[A-Z]{6}\+/, '')))
      out.push(h('p', { class: 'help' }, `Police d'origine : ${pdfName.replace(/^[A-Z]{6}\+/, '')}. ` + (systemFontsSupported() ? 'Elle n\'a pas été trouvée sur cet ordinateur : choisissez-en une proche ou importez-la.' : 'Importez-la pour un rendu identique.')));
    out.push(field('Taille', sizeInput(o.size, v => up({ size: v }))));
    out.push(field('Style', h('div', { class: 'row' },
      h('div', { class: 'seg' }, toggle('Gras', o.bold, v => up({ bold: v }), !hasVariant(o.font, 'b') && !hasVariant(o.font, 'bi')), toggle('Italique', o.italic, v => up({ italic: v }), !hasVariant(o.font, 'i') && !hasVariant(o.font, 'bi'))),
      seg([{ v: 'left', i: ICONS.alignL, t: 'Aligner à gauche' }, { v: 'center', i: ICONS.alignC, t: 'Centrer' }, { v: 'right', i: ICONS.alignR, t: 'Aligner à droite' }], o.align, v => up({ align: v }), 'Alignement'))));
    out.push(field('Majuscules et minuscules', caseButtons(o),
      h('p', { class: 'help' }, 'S\'applique au texte sélectionné pendant l\'écriture, sinon à tout le texte. Raccourci : Maj+F3.')));
    out.push(field('Interligne', sizeInput(o.lineHeight, v => up({ lineHeight: v }), { min: 0.7, max: 3, step: 0.05, unit: '' })));
    out.push(field('Couleur du texte', swatches(INK, o.color, c => up({ color: c }))));
    if (o.cover) {
      out.push(field('Couleur du fond de masquage', swatches(['#ffffff'], o.cover.color, c => up({ cover: { ...o.cover, color: c } })),
        h('button', { class: 'btn small outline', type: 'button', onclick: async () => { const { bg } = await sampleColors(page, o.cover); up({ cover: { ...o.cover, color: bg } }); } }, svgIcon(ICONS.pipette), 'Reprendre la couleur du fond')));
    }
    actions.append(actionBtn(ICONS.font, 'Modifier le texte', () => startEditing(o.id)));
    actions.append(actionBtn(ICONS.copy, 'Dupliquer', () => duplicateObject(o.id)));
    if (o.origin === 'edit') actions.append(actionBtn(ICONS.restore, 'Rétablir le texte d\'origine', () => removeObject(o.id, true, { restore: true })));
    actions.append(actionBtn(ICONS.trash, o.origin === 'edit' ? 'Supprimer ce texte' : 'Supprimer', () => removeObject(o.id), 'danger'));
  } else if (o.type === 'image') {
    const sig = o.kind === 'signature', lifted = o.origin === 'lift';
    out.push(h('h2', {}, sig ? 'Signature' : lifted ? 'Image du document' : 'Image'));
    out.push(h('p', { class: 'help' }, T('Faites glisser pour déplacer, tirez un coin pour agrandir ou réduire. Suppr pour l\'effacer.', 'Faites glisser pour déplacer, tirez un coin pour agrandir ou réduire.')));
    if (lifted) out.push(h('p', { class: 'help' }, 'Son emplacement d\'origine est recouvert par la couleur du fond.'));
    if (!sig) {
      actions.append(actionBtn(ICONS.rotr, 'Pivoter d\'un quart de tour', () => rotateImage(o)));
      actions.append(actionBtn(ICONS.swap, 'Remplacer par une autre image…', () => replaceImage(o)));
    }
    actions.append(actionBtn(ICONS.copy, 'Dupliquer', () => duplicateObject(o.id)));
    actions.append(actionBtn(ICONS.pages, sig ? 'Parapher toutes les pages' : 'Copier sur toutes les pages', () => copyToAllPages(o.id)));
    if (lifted) actions.append(actionBtn(ICONS.restore, 'Remettre à sa place d\'origine', () => removeObject(o.id, true, { restore: true })));
    actions.append(actionBtn(ICONS.trash, lifted ? 'Supprimer l\'image' : 'Supprimer', () => removeObject(o.id), 'danger'));
  } else if (o.type === 'rect') {
    out.push(h('h2', {}, 'Zone masquée'));
    out.push(field('Couleur', swatches(['#ffffff', '#111111'], o.color, c => up({ color: c })),
      h('button', { class: 'btn small outline', type: 'button', onclick: async () => { const { bg } = await sampleColors(page, o); up({ color: bg }); } }, svgIcon(ICONS.pipette), 'Reprendre la couleur du fond')));
    actions.append(actionBtn(ICONS.trash, 'Supprimer', () => removeObject(o.id), 'danger'));
  } else if (o.type === 'highlight') {
    out.push(h('h2', {}, 'Surlignage'));
    out.push(field('Couleur', swatches(HL, o.color, c => up({ color: c }))));
    actions.append(actionBtn(ICONS.trash, 'Supprimer', () => removeObject(o.id), 'danger'));
  } else if (o.type === 'mark') {
    out.push(h('h2', {}, 'Coche'));
    out.push(field('Symbole', markSeg(o.mark, v => up({ mark: v }))));
    out.push(field('Taille', sizeInput(o.w, v => up({ x: o.x + (o.w - v) / 2, y: o.y + (o.h - v) / 2, w: v, h: v }), { min: 4, max: 60, step: 1 })));
    out.push(field('Couleur', swatches(INK, o.color, c => up({ color: c }))));
    actions.append(actionBtn(ICONS.copy, 'Dupliquer', () => duplicateObject(o.id)));
    actions.append(actionBtn(ICONS.trash, 'Supprimer', () => removeObject(o.id), 'danger'));
  }
  out.push(actions);
  return out;
}
/* ---- images : pivoter, remplacer ---- */
async function rotateImage(o) {
  const a = state.assets.get(o.asset); if (!a) return;
  const img = new Image(); img.src = a.dataUrl; await img.decode();
  const c = document.createElement('canvas'); c.width = img.naturalHeight; c.height = img.naturalWidth;
  const ctx = c.getContext('2d'); ctx.translate(c.width, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(img, 0, 0);
  const na = await addImageAsset(c.toDataURL(a.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.92));
  const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
  updateObject(o.id, { asset: na.id, w: o.h, h: o.w, x: cx - o.h / 2, y: cy - o.w / 2 });
}
function replaceImage(o) {
  const inp = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    try {
      const a = await addImageAsset(f);
      // la nouvelle image prend la place de l'ancienne, sans être déformée
      const s = Math.min(o.w / a.w, o.h / a.h), w = a.w * s, hh = a.h * s;
      updateObject(o.id, { asset: a.id, x: o.x + (o.w - w) / 2, y: o.y + (o.h - hh) / 2, w, h: hh });
    } catch { toast('Cette image n\'a pas pu être lue.', { error: true }); }
  };
  inp.click();
}

/* ---- majuscules / minuscules ---- */
export function transformCase(str, mode) {
  if (mode === 'upper') return str.toLocaleUpperCase('fr');
  if (mode === 'lower') return str.toLocaleLowerCase('fr');
  // « Première lettre en majuscule » : début du texte choisi et début de chaque phrase
  return str.toLocaleLowerCase('fr').replace(/(^[\s«"'(\-–—]*|[.!?…]\s+[«"'(]*|\n[\s«"'(\-–—•]*)(\p{L})/gu, (m, pre, ch) => pre + ch.toLocaleUpperCase('fr'));
}
function applyCase(o, mode) {
  const ta = state.editing === o.id ? document.querySelector('#pages textarea.editor') : null;
  if (ta) {
    let a = ta.selectionStart, b = ta.selectionEnd;
    if (a === b) { a = 0; b = ta.value.length; }
    const part = ta.value.slice(a, b);
    if (mode === 'cycle') mode = part === part.toLocaleUpperCase('fr') && part !== part.toLocaleLowerCase('fr') ? 'lower' : part === part.toLocaleLowerCase('fr') ? 'sentence' : 'upper';
    const out = transformCase(part, mode);
    ta.value = ta.value.slice(0, a) + out + ta.value.slice(b);
    ta.setSelectionRange(a, a + out.length);
    ta.dispatchEvent(new Event('input'));
    ta.focus();
  } else {
    if (mode === 'cycle') mode = o.text === o.text.toLocaleUpperCase('fr') ? 'lower' : o.text === o.text.toLocaleLowerCase('fr') ? 'sentence' : 'upper';
    updateObject(o.id, { text: transformCase(o.text, mode) });
  }
}
function caseButtons(o) {
  const b = (mode, label, title) => h('button', { type: 'button', title, 'aria-label': title,
    // ne pas quitter la zone de texte : la sélection en cours est conservée
    onmousedown: e => e.preventDefault(),
    onclick: () => applyCase(o, mode) }, label);
  return h('div', { class: 'seg case-seg', role: 'group', 'aria-label': 'Majuscules et minuscules' },
    b('upper', 'ABC', 'Tout en majuscules'), b('lower', 'abc', 'Tout en minuscules'), b('sentence', 'Abc', 'Première lettre en majuscule'));
}
on('cycle-case', () => { const f = state.editing && findObject(state.editing); if (f) applyCase(f.obj, 'cycle'); });

const markSeg = (value, fn) => seg([{ v: 'check', l: '✓', t: 'Coche' }, { v: 'cross', l: '✗', t: 'Croix' }, { v: 'dot', l: '●', t: 'Point' }], value, fn, 'Symbole');

/* ------------------------------------------------ outils */
function toolPanel(tool) {
  if (tool === 'select') {
    return [
      h('h2', {}, 'Sélection'),
      h('p', { class: 'help' }, T('Cliquez sur un élément ajouté (texte, signature, coche…) ou sur une image du document pour le sélectionner, puis faites-le glisser pour le déplacer.', 'Touchez un élément ajouté (texte, signature, coche…) ou une image du document pour le sélectionner, puis faites-le glisser pour le déplacer.')),
      h('p', { class: 'help' }, T('Double-cliquez sur un texte pour l\'écrire. Pour l\'image d\'une page entière (scan, photo), faites-la glisser ou double-cliquez dessus.', 'Touchez deux fois un texte pour l\'écrire. Deux doigts pour zoomer.')),
      h('p', { class: 'help' }, T('Suppr efface l\'élément sélectionné ; Ctrl+Z ou le bouton Annuler revient en arrière.', 'Le bouton Annuler, en haut, revient en arrière.')),
      h('div', { class: 'insp-actions' },
        actionBtn(ICONS.scan, 'Repérer les images de cette page', () => { const p = currentPageObj(); if (p) findRegions(p); }),
        h('p', { class: 'help' }, 'Logos, dessins, pictogrammes, QR codes… même dans un tract enregistré comme une seule image.')),
    ];
  }
  if (tool === 'edit') {
    return [
      h('h2', {}, 'Modifier le texte'),
      h('p', { class: 'help' }, T('Cliquez', 'Touchez') + ' un bloc entouré pour le corriger. Le nouveau texte reprend la taille, la couleur et une police proche de l\'original.'),
      field('Sélectionner par', seg([{ v: 'paragraph', l: 'Paragraphe' }, { v: 'line', l: 'Ligne' }], state.textMode, v => { state.textMode = v; refreshTextLayers(); }, 'Mode de sélection')),
      field('Texte non reconnu ?',
        h('p', { class: 'help' }, 'Pour un scan, une photo ou un texte vectorisé (export Canva, logo…), lancez la lecture automatique de la page affichée.'),
        h('button', { class: 'btn outline', type: 'button', onclick: () => { const p = currentPageObj(); if (p) ocrPage(p); } }, svgIcon(ICONS.scan), 'Lire le texte de cette page'),
        h('span', { class: 'help', 'data-ocr-status': '' })),
    ];
  }
  if (tool === 'text') {
    const d = state.textDefaults;
    return [
      h('h2', {}, 'Ajouter du texte'),
      h('p', { class: 'help' }, T('Cliquez', 'Touchez') + ' l\'endroit voulu et écrivez. Idéal pour remplir un formulaire qui n\'a pas de champs.'),
      field('Police', fontSelect(d.font, v => { d.font = v; render(true); })),
      field('Taille', sizeInput(d.size, v => d.size = v)),
      field('Couleur', swatches(INK, d.color, c => { d.color = c; render(true); })),
      h('div', { class: 'insp-actions' }, actionBtn(ICONS.calendar, 'Insérer la date du jour', () => insertTextAtCenter(todayFr()))),
    ];
  }
  if (tool === 'mark') {
    return [
      h('h2', {}, 'Cocher'),
      h('p', { class: 'help' }, T('Cliquez sur', 'Touchez') + ' chaque case à cocher. L\'outil reste actif tant que vous en avez besoin.'),
      field('Symbole', markSeg(state.markKind, v => state.markKind = v)),
      field('Taille', sizeInput(state.markSize || 12, v => state.markSize = v, { min: 4, max: 60, step: 1 })),
      field('Couleur', swatches(INK, state.markColor || '#111111', c => { state.markColor = c; render(true); })),
    ];
  }
  if (tool === 'sign') {
    return [
      h('h2', {}, 'Signer'),
      h('p', { class: 'help' }, state.pendingSignature ? T('Cliquez sur le document à l\'endroit où signer.', 'Touchez le document à l\'endroit où signer.') : 'Tracez, saisissez ou importez votre signature, puis placez-la sur le document.'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => emit('open-signature', {}) }, state.pendingSignature ? 'Changer de signature' : 'Créer ou choisir une signature'),
      h('p', { class: 'help' }, 'Il s\'agit d\'une signature visuelle, comme une signature scannée. Elle convient à la plupart des documents internes.'),
    ];
  }
  if (tool === 'mask') return [h('h2', {}, 'Masquer'), h('p', { class: 'help' }, 'Tracez un rectangle sur la zone à cacher. Sa couleur reprend celle du fond ; changez-la ensuite si besoin.'), h('p', { class: 'help' }, 'Attention : le masque cache le contenu à l\'œil, mais le texte reste présent dans le fichier (copier-coller, recherche). Pour une information confidentielle, utilisez le menu ⋮ puis « Télécharger un PDF aplati ».')];
  if (tool === 'highlight') return [h('h2', {}, 'Surligner'), h('p', { class: 'help' }, 'Tracez un rectangle sur le passage à mettre en évidence.')];
  return null;
}
