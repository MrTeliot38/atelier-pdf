// Rechercher dans le document : texte du PDF, texte lu sur les scans, textes ajoutés ou corrigés.
// Sans tenir compte des majuscules ni des accents (« evenement » trouve « Événement »).
import { state, on, emit, h, $, svgIcon, ICONS, toast, layoutText, ASC, commit, findObject, pageById } from './core.js';
import { getLines, hasOcr, runOcr, makeBlock } from './textdetect.js';
import { buildEditObject, refreshTextLayers } from './tools.js';
import { slots, getSlot } from './viewer.js';

const IC = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  swap: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
};

/* ------------------------------------------------ normalisation */
const PUNCT = { '’': "'", '‘': "'", 'ʼ': "'", '´': "'", '`': "'", '“': '"', '”': '"', '«': '"', '»': '"', '–': '-', '—': '-', '‑': '-', ' ': ' ', ' ': ' ' };
/** Texte comparable + correspondance vers les positions d'origine. */
function fold(str, exact) {
  let out = '';
  const map = [];
  for (let i = 0; i < str.length; i++) {
    let c = PUNCT[str[i]] || str[i];
    if (!exact) c = c.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    if (c === 'œ') c = 'oe'; else if (c === 'æ') c = 'ae';
    for (const ch of c) { out += ch; map.push(i); }
  }
  map.push(str.length);
  return { out, map };
}

/* ------------------------------------------------ index du document */
// une « ligne » : { text, pageId, top, bottom, xAt(i) } — xAt donne l'abscisse du caractère i
async function pageLines(page) {
  const res = [];
  // zones recouvertes (texte corrigé, effacé) ou caviardées : leur texte n'existe plus
  const covers = [...page.objects.filter(o => o.cover).map(o => o.cover), ...page.objects.filter(o => o.type === 'redact')];
  const hidden = l => covers.some(c => {
    const cx = l.x + l.w / 2, cy = (l.top + l.bottom) / 2;
    return cx >= c.x && cx <= c.x + c.w && cy >= c.y && cy <= c.y + c.h;
  });
  let kind = 'none';
  try {
    const r = await getLines(page);
    kind = r.kind;
    for (const l of r.lines) {
      if (hidden(l)) continue; // texte d'origine remplacé ou effacé (ligne entière)
      if (l.ocr && l.words && l.words.length) {
        // texte lu sur un scan : position de chaque mot ; l'espace prend la fin du mot précédent
        let text = '';
        const xs = [];
        l.words.forEach((w, wi) => {
          if (wi) { text += ' '; xs.push(l.words[wi - 1].x1); }
          const n = w.text.length;
          for (let k = 0; k < n; k++) xs.push(w.x0 + (w.x1 - w.x0) * k / n);
          text += w.text;
        });
        xs.push(l.words[l.words.length - 1].x1);
        res.push({ text, top: l.top, bottom: l.bottom, xAt: i => xs[Math.min(i, xs.length - 1)], line: l });
      } else if (l.cx && l.cx.length === l.text.length + 1) {
        res.push({ text: l.text, top: l.top, bottom: l.bottom, xAt: i => l.cx[i], line: l });
      } else {
        const n = Math.max(1, l.text.length);
        res.push({ text: l.text, top: l.top, bottom: l.bottom, xAt: i => l.x + l.w * i / n, line: l });
      }
    }
  } catch (e) { console.warn('Recherche', e); }
  // textes ajoutés ou corrigés dans Atelier PDF
  for (const o of page.objects) {
    if (o.type !== 'text' || !o.text) continue;
    try {
      const { lines, widths } = layoutText(o);
      lines.forEach((ln, i) => {
        if (!ln) return;
        const w = widths[i], x0 = o.align === 'center' ? o.x + (o.w - w) / 2 : o.align === 'right' ? o.x + o.w - w : o.x;
        const base = o.y + o.size * ASC + i * o.size * o.lineHeight;
        const n = Math.max(1, ln.length);
        res.push({ text: ln, top: base - o.size * ASC, bottom: base + o.size * 0.25, xAt: k => x0 + w * k / n, obj: o.id });
      });
    } catch {}
  }
  const added = page.objects.some(o => o.type === 'text' && o.text);
  return { lines: res, noText: kind === 'none' && !added && !!page.src, covers };
}

/* ------------------------------------------------ recherche */
const S = { open: false, query: '', exact: false, hits: [], cur: -1, noText: [], token: 0, ocrBusy: false, replacing: false };
let ui = null;

function hitsIn(lines, pageId, q, covers = []) {
  const out = [];
  for (const l of lines) {
    const f = fold(l.text, S.exact);
    let from = 0, at;
    while ((at = f.out.indexOf(q, from)) >= 0) {
      const i0 = f.map[at], i1 = f.map[at + q.length];
      const x0 = l.xAt(i0), x1 = l.xAt(i1);
      const pad = (l.bottom - l.top) * 0.08;
      // mot du PDF déjà remplacé (recouvert) : il n'existe plus
      if (!l.obj) {
        const cx = (x0 + x1) / 2, cy = (l.top + l.bottom) / 2;
        if (covers.some(c => cx >= c.x && cx <= c.x + c.w && cy >= c.y && cy <= c.y + c.h)) { from = at + Math.max(1, q.length); continue; }
      }
      out.push({ pageId, x: Math.min(x0, x1) - 0.5, y: l.top - pad, w: Math.max(2, Math.abs(x1 - x0) + 1), h: l.bottom - l.top + pad * 2,
        before: l.text.slice(Math.max(0, i0 - 30), i0), match: l.text.slice(i0, i1), after: l.text.slice(i1, i1 + 40),
        i0, i1, text: l.text, line: l.line, obj: l.obj, xAt: l.xAt });
      from = at + Math.max(1, q.length);
    }
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

async function run(keepPosition) {
  const token = ++S.token;
  const raw = S.query;
  const q = fold(raw.trim().replace(/\s+/g, ' '), S.exact).out;
  if (!q) { S.hits = []; S.cur = -1; S.noText = []; paint(); updateUI(); return; }
  ui.count.textContent = '…';
  const hits = [], noText = [];
  for (const page of state.pages) {
    const { lines, noText: nt, covers } = await pageLines(page);
    if (token !== S.token) return;
    if (nt) noText.push(page);
    hits.push(...hitsIn(lines, page.id, q, covers));
  }
  const seen = new Map();
  for (const x of hits) if (x.obj) { const k = seen.get(x.obj) || 0; x.ord = k; seen.set(x.obj, k + 1); }
  const prev = S.hits[S.cur];
  S.hits = hits; S.noText = noText;
  if (keepPosition && prev) {
    const k = hits.findIndex(x => x.pageId === prev.pageId && Math.abs(x.y - prev.y) < 2 && Math.abs(x.x - prev.x) < 2);
    S.cur = k >= 0 ? k : Math.min(S.cur, hits.length - 1);
  } else {
    // premier résultat à partir de la page affichée
    const ci = state.pages.findIndex(p => p.id === state.currentPage);
    const order = id => state.pages.findIndex(p => p.id === id);
    const k = hits.findIndex(x => order(x.pageId) >= ci);
    S.cur = hits.length ? (k >= 0 ? k : 0) : -1;
  }
  paint(); updateUI();
  if (!keepPosition && S.cur >= 0) reveal();
}

/* ------------------------------------------------ surlignage sur les pages */
function paint() {
  for (const [id, s] of slots) {
    let layer = s.pageEl.querySelector('.layer-search');
    const mine = S.open ? S.hits.map((x, i) => [x, i]).filter(([x]) => x.pageId === id) : [];
    if (!mine.length) { layer?.remove(); continue; }
    if (!layer) { layer = h('div', { class: 'layer layer-search', 'aria-hidden': 'true' }); s.pageEl.append(layer); }
    const z = state.zoom;
    layer.replaceChildren(...mine.map(([x, i]) => h('div', { class: 'search-hit' + (i === S.cur ? ' cur' : ''), 'data-i': i,
      style: { left: x.x * z + 'px', top: x.y * z + 'px', width: x.w * z + 'px', height: x.h * z + 'px' } })));
  }
}
function reveal() {
  const x = S.hits[S.cur]; if (!x) return;
  const s = getSlot(x.pageId); if (!s) return;
  paint();
  const el = s.pageEl.querySelector(`.search-hit[data-i="${S.cur}"]`);
  el?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
}
function go(d) {
  if (!S.hits.length) return;
  S.cur = (S.cur + d + S.hits.length) % S.hits.length;
  reveal(); updateUI();
}

/* ------------------------------------------------ remplacer */
/** Reprend la casse du texte trouvé : « TRACT » → « AFFICHE », « Tract » → « Affiche ». */
function matchCase(found, rep) {
  const letters = found.replace(/[^\p{L}]/gu, '');
  if (letters.length > 1 && letters === letters.toUpperCase() && rep === rep.toLowerCase()) return rep.toUpperCase();
  if (letters && letters[0] === letters[0].toUpperCase() && letters.slice(1) === letters.slice(1).toLowerCase() && rep && rep[0] === rep[0].toLowerCase())
    return rep[0].toUpperCase() + rep.slice(1);
  return rep;
}
function replaceIn(text, spans, rep) {
  // de la fin vers le début : les positions précédentes restent valables
  for (const [i0, i1] of [...spans].sort((a, b) => b[0] - a[0])) text = text.slice(0, i0) + matchCase(text.slice(i0, i1), rep) + text.slice(i1);
  return text;
}
async function replaceHits(list, rep) {
  if (!list.length || S.replacing) return 0;
  S.replacing = true;
  const q = fold(S.query.trim().replace(/\s+/g, ' '), S.exact).out;
  const groups = new Map();
  for (const x of list) {
    const key = x.obj ? 'o:' + x.obj : x.line;
    if (!groups.has(key)) groups.set(key, { x, items: [] });
    groups.get(key).items.push(x);
  }
  const label = h('span', {}, 'Remplacement…');
  ui.note.hidden = false; ui.note.replaceChildren(h('span', { class: 'spinner' }), label);
  const fontCache = new Map();
  let done = 0, k = 0;
  try {
    for (const [key, g] of groups) {
      k++; label.textContent = `Remplacement… ${k} / ${groups.size}`;
      const page = pageById(g.x.pageId); if (!page) continue;
      if (g.x.obj) {
        // texte déjà ajouté ou corrigé : on modifie directement son contenu
        const f = findObject(g.x.obj); if (!f) continue;
        const o = f.obj, fo = fold(o.text, S.exact), occ = [];
        let from = 0, at;
        while ((at = fo.out.indexOf(q, from)) >= 0) { occ.push([fo.map[at], fo.map[at + q.length]]); from = at + Math.max(1, q.length); }
        const want = new Set(g.items.map(x => x.ord));
        const spans = occ.filter((_, i) => want.has(i));
        if (!spans.length) continue;
        o.text = replaceIn(o.text, spans, rep);
        if (o.origin === 'edit') o.styled = true;
        done += spans.length;
      } else {
        // texte du PDF : seule la fin de la ligne, à partir du mot trouvé, est recréée à l'identique
        // (police, taille, couleur, fond) ; le début de la ligne (pictogramme, libellé en gras…) reste intact
        const L = g.x.line, T = g.x.text;
        let st = Math.min(...g.items.map(x => x.i0));
        while (st > 0 && T[st - 1] !== ' ') st--;
        const sx = st ? g.x.xAt(st) : L.x;
        // remplacement de longueur proche (date, chiffre, nom) : seul le mot change, la suite de la ligne
        // (et son style, par exemple du gras) reste intacte ; sinon on recrée jusqu'à la fin de la ligne
        let en = Math.max(...g.items.map(x => x.i1));
        while (en < T.length && T[en] !== ' ') en++;
        const lenOld = g.items.reduce((a, x) => a + x.i1 - x.i0, 0), lenNew = rep.length * g.items.length;
        const wordOnly = en < T.length && Math.abs(lenNew - lenOld) <= Math.max(1, lenOld * 0.15);
        const end = wordOnly ? en : T.length;
        const ex = end < T.length ? g.x.xAt(end) : L.x + L.w;
        const sub = { ...L, x: sx, w: Math.max(4, ex - sx), text: T.slice(st, end) };
        if (L.words) sub.words = L.words.filter(w => w.x1 > sx + 0.5 && w.x0 < ex - 0.5);
        const b = makeBlock([sub]);
        const o = await buildEditObject(page, b, { budgetMs: L.ocr ? 1400 : 900, fontCache: L.ocr ? null : fontCache, fontBlock: makeBlock([L]) });
        const full = replaceIn(T, g.items.map(x => [x.i0, x.i1]), rep);
        o.text = full.slice(st, full.length - (T.length - end));
        if (wordOnly) { o.w = sub.w + 4; }
        o.styled = true;
        // le nouveau texte tient sur une ligne : zone élargie, et décalée vers la gauche si elle dépasse la page
        try {
          const { widths } = layoutText({ ...o, w: 1e5 });
          const need = Math.max(...widths) + 3;
          if (need > o.w) { o.w = need; if (o.x + o.w > page.w - 4) o.x = Math.max(4, page.w - 4 - o.w); }
        } catch {}
        page.objects.push(o);
        done += g.items.length;
      }
    }
  } catch (e) { console.error(e); toast('Le remplacement a été interrompu : ' + (e.message || e), { error: true }); }
  if (done) { commit(); emit('objects-changed'); refreshTextLayers(); }
  S.replacing = false;
  ui.note.hidden = true;
  return done;
}

/* ------------------------------------------------ barre de recherche */
function buildUI() {
  const input = h('input', { class: 'input search-input', type: 'search', placeholder: 'Rechercher dans le document', 'aria-label': 'Rechercher dans le document', spellcheck: 'false', enterkeyhint: 'search' });
  const count = h('span', { class: 'search-count', 'aria-live': 'polite' });
  const prev = h('button', { class: 'btn icon small', type: 'button', title: 'Résultat précédent (Maj+Entrée)', 'aria-label': 'Résultat précédent', onclick: () => go(-1) }, svgIcon(IC.up));
  const next = h('button', { class: 'btn icon small', type: 'button', title: 'Résultat suivant (Entrée)', 'aria-label': 'Résultat suivant', onclick: () => go(1) }, svgIcon(IC.down));
  const exact = h('button', { class: 'btn small search-exact', type: 'button', title: 'Respecter les majuscules et les accents', 'aria-pressed': 'false', onclick: () => {
    S.exact = !S.exact; exact.setAttribute('aria-pressed', S.exact); run();
  } }, 'Aa');
  const listBtn = h('button', { class: 'btn icon small', type: 'button', title: 'Afficher la liste des résultats', 'aria-label': 'Liste des résultats', 'aria-pressed': 'false', onclick: () => {
    const on = listBtn.getAttribute('aria-pressed') !== 'true'; listBtn.setAttribute('aria-pressed', on); list.hidden = !on; updateUI();
  } }, svgIcon(IC.list));
  const close = h('button', { class: 'btn icon small', type: 'button', title: 'Fermer la recherche (Échap)', 'aria-label': 'Fermer la recherche', onclick: closeSearch }, svgIcon(ICONS.close));
  const repInput = h('input', { class: 'input search-input', type: 'text', placeholder: 'Remplacer par…', 'aria-label': 'Remplacer par', spellcheck: 'true', lang: 'fr' });
  const repOne = h('button', { class: 'btn small outline', type: 'button', title: 'Remplacer ce résultat puis passer au suivant', onclick: async () => {
    const x = S.hits[S.cur]; if (!x) return;
    const n = await replaceHits([x], repInput.value);
    if (n) { await run(true); toast('Remplacé.', { duration: 1800 }); if (S.cur >= 0) reveal(); }
  } }, 'Remplacer');
  const repAll = h('button', { class: 'btn small primary', type: 'button', title: 'Remplacer tous les résultats', onclick: async () => {
    const all = S.hits.slice();
    if (!all.length) return;
    const n = await replaceHits(all, repInput.value);
    if (n) { await run(true); toast(`${n} remplacement${n > 1 ? 's' : ''} effectué${n > 1 ? 's' : ''}. Annuler les retire tous d'un coup.`, { duration: 6000 }); }
  } }, 'Tout remplacer');
  repInput.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); repOne.click(); } if (e.key === 'Escape') { e.preventDefault(); closeSearch(); } });
  const repRow = h('div', { class: 'search-row search-rep', hidden: true }, h('span', { class: 'search-rep-ico' }, svgIcon(IC.swap)), repInput, repOne, repAll);
  const repToggle = h('button', { class: 'btn icon small', type: 'button', title: 'Remplacer', 'aria-label': 'Remplacer', 'aria-pressed': 'false', onclick: () => {
    const on = repToggle.getAttribute('aria-pressed') !== 'true'; repToggle.setAttribute('aria-pressed', on); repRow.hidden = !on; if (on) repInput.focus();
  } }, svgIcon(IC.swap));
  const list = h('div', { class: 'search-list', role: 'listbox', 'aria-label': 'Résultats', hidden: true });
  const note = h('div', { class: 'search-note', hidden: true });
  const bar = h('div', { class: 'searchbar', role: 'search', hidden: true },
    h('div', { class: 'search-row' }, svgIcon(IC.search), input, count, exact, prev, next, listBtn, repToggle, close), repRow, note, list);
  let t = 0;
  input.addEventListener('input', () => { S.query = input.value; clearTimeout(t); t = setTimeout(() => run(), 180); });
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); if (S.token && fold(input.value.trim(), S.exact).out !== fold(S.query.trim(), S.exact).out) { S.query = input.value; run(); } else go(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
    if (e.key === 'F3') { e.preventDefault(); go(e.shiftKey ? -1 : 1); }
  });
  $('.workspace').append(bar);
  return { bar, input, count, prev, next, list, listBtn, note, repOne, repAll, repToggle, repRow, repInput };
}

function updateUI() {
  if (!ui) return;
  const n = S.hits.length;
  ui.count.textContent = !S.query.trim() ? '' : n ? `${S.cur + 1} / ${n}` : 'Aucun résultat';
  ui.count.classList.toggle('none', !!S.query.trim() && !n);
  ui.prev.disabled = ui.next.disabled = n < 2;
  ui.repOne.disabled = ui.repAll.disabled = !n || S.replacing;
  // pages scannées pas encore lues : la recherche ne peut pas y trouver de texte
  const nt = S.noText.filter(p => !hasOcr(p));
  if (S.query.trim() && nt.length && !S.ocrBusy) {
    ui.note.hidden = false;
    ui.note.replaceChildren(h('span', {}, nt.length === state.pages.length ? 'Ce document est une image (scan) : son texte n\'a pas encore été lu.' : `${nt.length} page${nt.length > 1 ? 's' : ''} scannée${nt.length > 1 ? 's' : ''} sans texte lisible.`),
      h('button', { class: 'btn small primary', type: 'button', onclick: () => readScans(nt) }, 'Lire le texte'));
  } else if (!S.ocrBusy) ui.note.hidden = true;
  if (!ui.list.hidden) {
    const order = id => state.pages.findIndex(p => p.id === id) + 1;
    ui.list.replaceChildren(...S.hits.slice(0, 300).map((x, i) => h('button', { type: 'button', class: 'search-item' + (i === S.cur ? ' cur' : ''), role: 'option', 'aria-selected': i === S.cur,
      onclick: () => { S.cur = i; reveal(); updateUI(); } },
      h('small', {}, 'p. ' + order(x.pageId)), h('span', {}, (x.before.length >= 30 ? '…' : '') + x.before, h('mark', {}, x.match), x.after))));
    if (!S.hits.length) ui.list.replaceChildren(h('p', { class: 'help', style: { margin: '6px 10px' } }, S.query.trim() ? 'Aucun résultat.' : 'Saisissez un mot ou une expression.'));
    ui.list.querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
  }
}

async function readScans(pages) {
  S.ocrBusy = true;
  ui.note.hidden = false;
  const label = h('span', {}, 'Lecture du texte…');
  ui.note.replaceChildren(h('span', { class: 'spinner' }), label);
  let k = 0;
  for (const p of pages) {
    k++;
    try {
      await runOcr(p, m => { label.textContent = `Lecture du texte${pages.length > 1 ? ` (page ${k} sur ${pages.length})` : ''}… ${Math.round((m.progress || 0) * 100)} %`; });
    } catch (e) { console.error(e); toast('La lecture du texte a échoué.', { error: true }); break; }
  }
  S.ocrBusy = false;
  await run();
  ui.input.focus({ preventScroll: true });
}

export function openSearch(replace = false) {
  if (!state.pages.length) return;
  if (!ui) ui = buildUI();
  S.open = true;
  ui.bar.hidden = false;
  document.body.classList.add('searching');
  // texte sélectionné à l'écran : proposé comme recherche
  const sel = String(window.getSelection?.() || '').trim();
  if (sel && sel.length < 80) { ui.input.value = sel; S.query = sel; }
  if (replace && ui.repToggle.getAttribute('aria-pressed') !== 'true') ui.repToggle.click();
  ui.input.focus(); ui.input.select();
  if (S.query.trim()) run(true);
}
export function closeSearch() {
  if (!ui) return;
  S.open = false; S.token++;
  ui.bar.hidden = true;
  document.body.classList.remove('searching');
  paint();
}
export const isSearchOpen = () => S.open;
export const searchStep = d => { if (S.open) go(d); };

export function initSearch() {
  on('zoom', () => S.open && paint());
  on('pages-changed', () => S.open && run(true));
  on('doc-switched', () => { if (S.open) run(); });
  on('doc-closed', () => closeSearch());
  let t = 0;
  on('history', () => { if (S.open && S.query.trim()) { clearTimeout(t); t = setTimeout(() => run(true), 400); } });
  on('page-rendered', () => S.open && paint());
}
