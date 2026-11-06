// Impression avec aperçu : choix des pages, pages par feuille, livret, format du papier,
// orientation, mise à l'échelle, marges, en-tête et pied de page ; dans l'application Windows,
// imprimante, copies, recto verso et couleur.
import { state, h, $, toast, PDFLib, pdfjsLib, PDFJS_OPTS, downloadBlob } from './core.js';
import { modal, parseRange } from './ui.js';
import { buildPdf, printBytes, fileName } from './export.js';

const { PDFDocument, StandardFonts, degrees, rgb, pushGraphicsState, popGraphicsState, rectangle, clip, endPath } = PDFLib;
const desktop = window.atelierDesktop;
const MM = 72 / 25.4;
const PAPERS = {
  A4: { label: 'A4', w: 595.28, h: 841.89 },
  A3: { label: 'A3', w: 841.89, h: 1190.55 },
  A5: { label: 'A5', w: 419.53, h: 595.28 },
  Letter: { label: 'Lettre US', w: 612, h: 792 },
  Legal: { label: 'Légal US', w: 612, h: 1008 },
};
const MARGINS = { none: 0, narrow: 5 * MM, normal: 10 * MM, wide: 20 * MM };
const NUPS = [1, 2, 4, 6, 9, 16];
const KEY = 'atelierpdf.print';
const DEFAULTS = { nup: 1, order: 'h', border: false, paper: 'A4', orientation: 'auto', scale: 'fit', custom: 100, margins: 'narrow', hf: false, duplex: 'simplex', color: true, collate: true, printer: '' };

function loadOpts() {
  let o = {};
  try { o = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
  return { ...DEFAULTS, ...o, pages: 'all', range: '', subset: 'all', reverse: false, copies: 1 };
}
function saveOpts(o) {
  const keep = {}; for (const k of Object.keys(DEFAULTS)) keep[k] = o[k];
  try { localStorage.setItem(KEY, JSON.stringify(keep)); } catch {}
}

/* ------------------------------------------------ mise en page (indépendante du rendu) */
/** Liste des pages à imprimer (indices 0…n-1 du PDF exporté), ou un message d'erreur. */
function pageList(o, n, info) {
  let nums;
  if (o.pages === 'current') nums = [info.current + 1];
  else if (o.pages === 'selection') nums = info.selection.slice();
  else if (o.pages === 'custom') {
    if (!o.range.trim()) return { error: 'Indiquez les pages à imprimer, par exemple 1-3, 6.' };
    const set = parseRange(o.range, n);
    nums = set ? [...set].sort((a, b) => a - b) : null;
    if (!nums || !nums.length) return { error: `Pages non reconnues. Exemple : 1-3, 6 (le document a ${n} page${n > 1 ? 's' : ''}).` };
  } else nums = Array.from({ length: n }, (_, i) => i + 1);
  if (o.subset === 'odd') nums = nums.filter(x => x % 2 === 1);
  if (o.subset === 'even') nums = nums.filter(x => x % 2 === 0);
  if (o.reverse) nums.reverse();
  if (!nums.length) return { error: 'Aucune page ne correspond à ce choix.' };
  return { list: nums.map(x => x - 1) };
}

/**
 * Feuilles à imprimer : [{ w, h, cells: [{ page, x, y, w, h, s }] , label }]
 * (coordonnées en points, origine en haut à gauche de la feuille)
 */
function layout(o, list, sizes) {
  const paper = PAPERS[o.paper] || PAPERS.A4;
  const m = MARGINS[o.margins] ?? 0;
  const band = o.hf ? 16 : 0;
  const booklet = o.nup === 'booklet';
  const n = booklet ? 2 : o.nup;
  const gap = n > 1 ? (booklet ? 0 : 8) : 0;
  let pages = list.slice();
  if (booklet) {
    while (pages.length % 4) pages.push(null);
    const N = pages.length, sides = [];
    for (let i = 0; i < N / 4; i++) {
      sides.push([pages[N - 1 - 2 * i], pages[2 * i]]);
      sides.push([pages[2 * i + 1], pages[N - 2 - 2 * i]]);
    }
    pages = sides.flat();
  }
  const ref = sizes[list[0]] || { w: 595, h: 842 };
  // orientation et grille : celles qui donnent les pages les plus grandes
  const grids = [];
  for (let c = 1; c <= n; c++) if (n % c === 0) grids.push([c, n / c]);
  const fitFor = (W, H, c, r, pw, ph) => {
    const cw = (W - 2 * m - gap * (c - 1)) / c, ch = (H - 2 * m - 2 * band - gap * (r - 1)) / r;
    return Math.min(cw / pw, ch / ph);
  };
  const choose = (pw, ph) => {
    const ors = booklet ? ['landscape'] : o.orientation === 'auto' ? ['portrait', 'landscape'] : [o.orientation];
    let best = null;
    for (const or of ors) {
      const W = or === 'landscape' ? paper.h : paper.w, H = or === 'landscape' ? paper.w : paper.h;
      for (const [c, r] of (booklet ? [[2, 1]] : grids)) {
        const f = fitFor(W, H, c, r, pw, ph);
        if (!best || f > best.f + 1e-6) best = { W, H, c, r, f };
      }
    }
    return best;
  };
  const fixed = n > 1 ? choose(ref.w, ref.h) : null;
  const sheets = [];
  for (let k = 0; k < pages.length; k += n) {
    const group = pages.slice(k, k + n);
    const g = fixed || choose(...(group[0] != null ? [sizes[group[0]].w, sizes[group[0]].h] : [ref.w, ref.h]));
    const { W, H, c, r } = g;
    const cw = (W - 2 * m - gap * (c - 1)) / c, ch = (H - 2 * m - 2 * band - gap * (r - 1)) / r;
    const cells = [];
    group.forEach((p, j) => {
      const col = o.order === 'v' && !booklet ? Math.floor(j / r) : j % c;
      const row = o.order === 'v' && !booklet ? j % r : Math.floor(j / c);
      const cx = m + col * (cw + gap), cy = m + band + row * (ch + gap);
      if (p == null) { cells.push({ page: null, cx, cy, cw, ch }); return; }
      const { w: pw, h: ph } = sizes[p];
      const fit = Math.min(cw / pw, ch / ph);
      const s = o.scale === 'actual' ? 1 : o.scale === 'shrink' ? Math.min(1, fit) : o.scale === 'custom' ? Math.max(0.1, Math.min(4, (o.custom || 100) / 100)) : fit;
      let x = cx + (cw - pw * s) / 2, y = cy + (ch - ph * s) / 2;
      // livret : les deux pages se touchent au pli
      if (booklet) x = j === 0 ? cx + cw - pw * s : cx;
      cells.push({ page: p, x, y, w: pw * s, h: ph * s, s, cx, cy, cw, ch });
    });
    sheets.push({ w: W, h: H, cells });
  }
  return { sheets, booklet };
}

/* ------------------------------------------------ rendu d'une feuille (aperçu et impression Windows) */
function sheetText(o, k, total) {
  const d = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  return { left: state.docName || 'document', right: d, center: `${k + 1} / ${total}` };
}
async function renderSheet(pdf, sheet, S, o, k, total, cache) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sheet.w * S)); c.height = Math.max(1, Math.round(sheet.h * S));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  for (const cell of sheet.cells) {
    if (cell.page == null) continue;
    const scale = cell.s * S;
    const key = cell.page + '@' + scale.toFixed(4);
    let img = cache?.get(key);
    if (!img) {
      const page = await pdf.getPage(cell.page + 1);
      const vp = page.getViewport({ scale });
      img = document.createElement('canvas');
      img.width = Math.max(1, Math.ceil(vp.width)); img.height = Math.max(1, Math.ceil(vp.height));
      const ic = img.getContext('2d'); ic.fillStyle = '#fff'; ic.fillRect(0, 0, img.width, img.height);
      await page.render({ canvas: img, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
      if (cache) { cache.set(key, img); if (cache.size > 48) cache.delete(cache.keys().next().value); }
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(cell.cx * S, cell.cy * S, cell.cw * S, cell.ch * S); ctx.clip();
    if (!o.color) ctx.filter = 'grayscale(1)';
    ctx.drawImage(img, cell.x * S, cell.y * S, cell.w * S, cell.h * S);
    ctx.restore();
    if (o.border && o.nup !== 1 && o.nup !== 'booklet') {
      ctx.strokeStyle = '#7a7a7a'; ctx.lineWidth = Math.max(1, 0.6 * S);
      ctx.strokeRect(Math.max(cell.x, cell.cx) * S, Math.max(cell.y, cell.cy) * S, Math.min(cell.w, cell.cw) * S, Math.min(cell.h, cell.ch) * S);
    }
  }
  if (o.hf) {
    const t = sheetText(o, k, total), m = Math.max(MARGINS[o.margins] ?? 0, 6 * MM);
    ctx.fillStyle = '#444'; ctx.font = `${8.5 * S}px Helvetica, Arial, sans-serif`; ctx.textBaseline = 'alphabetic';
    const top = (MARGINS[o.margins] || 0) + 11, bottom = sheet.h - (MARGINS[o.margins] || 0) - 4;
    ctx.textAlign = 'left'; ctx.fillText(t.left, m * S, top * S, (sheet.w / 2 - m) * S);
    ctx.textAlign = 'right'; ctx.fillText(t.right, (sheet.w - m) * S, top * S);
    ctx.textAlign = 'center'; ctx.fillText(t.center, sheet.w / 2 * S, bottom * S);
  }
  return c;
}

/* ------------------------------------------------ PDF mis en page (enregistrer, Android, navigateur) */
const winAnsi = (font, s) => [...s].map(ch => { try { font.encodeText(ch); return ch; } catch { return '?'; } }).join('');
async function composePdf(bytes, lay, o) {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  // une seule page par feuille, aucune mise à l'échelle : le PDF d'origine suffit
  const trivial = !o.hf && lay.sheets.every(sh => sh.cells.length === 1 && sh.cells[0].page != null && Math.abs(sh.cells[0].s - 1) < 1e-3 && Math.abs(sh.cells[0].x) < 0.5 && Math.abs(sh.cells[0].y) < 0.5);
  const out = await PDFDocument.create();
  if (trivial) {
    const copied = await out.copyPages(src, lay.sheets.map(sh => sh.cells[0].page));
    copied.forEach(p => out.addPage(p));
  } else {
    const emb = new Map();
    const font = o.hf ? await out.embedFont(StandardFonts.Helvetica) : null;
    for (const [k, sh] of lay.sheets.entries()) {
      const page = out.addPage([sh.w, sh.h]);
      for (const cell of sh.cells) {
        if (cell.page == null) continue;
        let e = emb.get(cell.page);
        if (!e) {
          const sp = src.getPage(cell.page), cb = sp.getCropBox();
          e = { xo: await out.embedPage(sp, { left: cb.x, bottom: cb.y, right: cb.x + cb.width, top: cb.y + cb.height }), w: cb.width, h: cb.height, r: ((sp.getRotation().angle % 360) + 360) % 360 };
          emb.set(cell.page, e);
        }
        const s = cell.s, tx = cell.x, ty = sh.h - cell.y - cell.h; // bas gauche de la page posée (repère PDF)
        let x = tx, y = ty, rot = 0;
        if (e.r === 90) { y = ty + e.w * s; rot = -90; }
        else if (e.r === 180) { x = tx + e.w * s; y = ty + e.h * s; rot = 180; }
        else if (e.r === 270) { x = tx + e.h * s; rot = 90; }
        page.pushOperators(pushGraphicsState(), rectangle(cell.cx, sh.h - cell.cy - cell.ch, cell.cw, cell.ch), clip(), endPath());
        page.drawPage(e.xo, { x, y, xScale: s, yScale: s, rotate: degrees(rot) });
        page.pushOperators(popGraphicsState());
        if (o.border && o.nup !== 1 && o.nup !== 'booklet') {
          const bx = Math.max(cell.x, cell.cx), by = Math.max(cell.y, cell.cy), bw = Math.min(cell.w, cell.cw), bh = Math.min(cell.h, cell.ch);
          page.drawRectangle({ x: bx, y: sh.h - by - bh, width: bw, height: bh, borderColor: rgb(0.48, 0.48, 0.48), borderWidth: 0.6 });
        }
      }
      if (font) {
        const t = sheetText(o, k, lay.sheets.length), mm = MARGINS[o.margins] || 0, m = Math.max(mm, 6 * MM), size = 8.5, col = rgb(0.27, 0.27, 0.27);
        let left = winAnsi(font, t.left);
        if (font.widthOfTextAtSize(left, size) > sh.w / 2 - m) {
          while (left.length > 4 && font.widthOfTextAtSize(left + '...', size) > sh.w / 2 - m) left = left.slice(0, -1);
          left += '...';
        }
        const right = winAnsi(font, t.right), center = winAnsi(font, t.center);
        page.drawText(left, { x: m, y: sh.h - mm - 11, size, font, color: col });
        page.drawText(right, { x: sh.w - m - font.widthOfTextAtSize(right, size), y: sh.h - mm - 11, size, font, color: col });
        page.drawText(center, { x: (sh.w - font.widthOfTextAtSize(center, size)) / 2, y: mm + 4, size, font, color: col });
      }
    }
  }
  out.setTitle(state.docName || 'document'); out.setProducer('Atelier PDF');
  return out.save();
}

/* ------------------------------------------------ boîte de dialogue */
export async function openPrintDialog() {
  if (!state.pages.length) return;
  const o = loadOpts();
  const n = state.pages.length;
  const info = {
    current: Math.max(0, state.pages.findIndex(p => p.id === state.currentPage)),
    selection: state.pages.map((p, i) => state.selectedPages.has(p.id) ? i + 1 : 0).filter(Boolean),
  };
  if (info.selection.length && info.selection.length < n) o.pages = 'selection';

  // ---------- éléments
  const canvasBox = h('div', { class: 'pv-stage' }, h('div', { class: 'pv-wait' }, h('span', { class: 'spinner' }), 'Préparation de l\'aperçu…'));
  const navLabel = h('span', { class: 'pv-count' }, '');
  const prev = h('button', { class: 'btn icon', type: 'button', title: 'Feuille précédente', 'aria-label': 'Feuille précédente' }, '‹');
  const next = h('button', { class: 'btn icon', type: 'button', title: 'Feuille suivante', 'aria-label': 'Feuille suivante' }, '›');
  const preview = h('div', { class: 'pv' }, canvasBox, h('div', { class: 'pv-nav' }, prev, navLabel, next));
  const err = h('p', { class: 'pv-err', hidden: true });

  const sel = (key, options, onchange) => {
    const s = h('select', { class: 'select' }, ...options.map(([v, l]) => h('option', { value: String(v) }, l)));
    s.value = String(o[key]);
    s.onchange = () => { o[key] = /^\d+$/.test(s.value) && key !== 'printer' ? +s.value : s.value; onchange?.(); update(); };
    return s;
  };
  const seg = (key, options) => {
    const box = h('div', { class: 'seg pv-seg', role: 'group' });
    const sync = () => box.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(String(o[key]) === b.dataset.v)));
    for (const [v, l, title] of options) box.append(h('button', { type: 'button', 'data-v': String(v), title: title || l, onclick: () => { o[key] = v; sync(); update(); } }, l));
    sync();
    return box;
  };
  const check = (key, label) => {
    const cb = h('input', { type: 'checkbox' }); cb.checked = !!o[key];
    cb.onchange = () => { o[key] = cb.checked; update(); };
    return h('label', { class: 'check-row' }, cb, label);
  };
  const row = (label, ...ctl) => h('div', { class: 'pv-row' }, h('span', { class: 'pv-lbl' }, label), h('div', { class: 'pv-ctl' }, ...ctl));

  // pages
  const pageOpts = [['all', `Toutes les pages (${n})`], ['current', `Page affichée (${info.current + 1})`]];
  if (info.selection.length) pageOpts.push(['selection', `Pages sélectionnées (${info.selection.length})`]);
  pageOpts.push(['custom', 'Personnalisées…']);
  const range = h('input', { class: 'input', placeholder: 'ex. 1-3, 6', 'aria-label': 'Pages à imprimer', value: '' });
  range.oninput = () => { o.range = range.value; update(); };
  const pagesSel = sel('pages', pageOpts, () => { range.hidden = o.pages !== 'custom'; if (o.pages === 'custom') setTimeout(() => range.focus(), 0); });
  range.hidden = o.pages !== 'custom';

  // mise en page
  const nupSel = sel('nup', [...NUPS.map(v => [v, v === 1 ? '1 page par feuille' : `${v} pages par feuille`]), ['booklet', 'Livret (pliage en deux)']]);
  const orderSeg = seg('order', [['h', 'Z  →', 'De gauche à droite, puis ligne suivante'], ['v', 'N  ↓', 'De haut en bas, puis colonne suivante']]);
  const borderChk = check('border', 'Bordure autour de chaque page');
  const orientSeg = seg('orientation', [['auto', 'Auto'], ['portrait', 'Portrait'], ['landscape', 'Paysage']]);
  const paperSel = sel('paper', Object.entries(PAPERS).map(([k, v]) => [k, v.label]));
  const customPct = h('input', { class: 'input num', type: 'number', min: 10, max: 400, step: 5, value: o.custom, 'aria-label': 'Échelle en pourcentage' });
  customPct.oninput = () => { o.custom = Math.max(10, Math.min(400, +customPct.value || 100)); update(); };
  const scaleSel = sel('scale', [['fit', 'Ajuster à la feuille'], ['shrink', 'Réduire seulement si nécessaire'], ['actual', 'Taille réelle (100 %)'], ['custom', 'Personnalisée']]);
  const pct = h('span', { class: 'pv-inline' }, customPct, ' %');
  const marginSel = sel('margins', [['none', 'Aucune'], ['narrow', 'Étroites (5 mm)'], ['normal', 'Normales (10 mm)'], ['wide', 'Larges (20 mm)']]);
  const hfChk = check('hf', 'En-tête et pied de page (nom, date, numéro)');

  // imprimante (Windows)
  let printerSel = null, copies = null, collate = null, duplexSel = null, colorSeg = null;
  const parts = [];
  if (desktop) {
    printerSel = h('select', { class: 'select' }, h('option', { value: '' }, 'Recherche des imprimantes…'));
    desktop.printers().then(list => {
      printerSel.replaceChildren(...(list.length ? list : [{ name: '', displayName: 'Aucune imprimante trouvée' }]).map(p => h('option', { value: p.name }, p.displayName + (p.isDefault ? ' (par défaut)' : ''))));
      const def = list.find(p => p.name === o.printer) || list.find(p => p.isDefault) || list[0];
      if (def) { printerSel.value = def.name; o.printer = def.name; }
      printBtn.disabled = !list.length || !!err.textContent;
    }).catch(() => printerSel.replaceChildren(h('option', { value: '' }, 'Imprimantes indisponibles')));
    printerSel.onchange = () => { o.printer = printerSel.value; };
    copies = h('input', { class: 'input num', type: 'number', min: 1, max: 999, value: 1, 'aria-label': 'Nombre de copies' });
    copies.oninput = () => { o.copies = Math.max(1, Math.min(999, Math.round(+copies.value || 1))); summaryUpdate(); };
    collate = check('collate', 'Assembler');
    duplexSel = sel('duplex', [['simplex', 'Recto seul'], ['longEdge', 'Recto verso, retourner sur le bord long'], ['shortEdge', 'Recto verso, retourner sur le bord court']]);
    colorSeg = seg('color', [[true, 'Couleur'], [false, 'Noir et blanc']]);
    parts.push(h('section', { class: 'pv-sec' }, h('h3', {}, 'Imprimante'),
      printerSel, row('Copies', copies, collate), row('Recto verso', duplexSel), row('Couleur', colorSeg)));
  }
  parts.push(h('section', { class: 'pv-sec' }, h('h3', {}, 'Pages'),
    pagesSel, range,
    row('Inclure', sel('subset', [['all', 'Toutes'], ['odd', 'Impaires seulement'], ['even', 'Paires seulement']])),
    check('reverse', 'Ordre inverse (dernière page d\'abord)')));
  const orderRow = row('Ordre', orderSeg);
  const orientRow = row('Orientation', orientSeg);
  const bookletHelp = h('p', { class: 'help pv-help' }, '');
  parts.push(h('section', { class: 'pv-sec' }, h('h3', {}, 'Mise en page'),
    row('Pages', nupSel), orderRow, borderChk, bookletHelp, orientRow, row('Papier', paperSel), row('Taille', scaleSel, pct), row('Marges', marginSel), hfChk));
  const side = h('div', { class: 'pv-side' }, ...parts);

  const summary = h('span', { class: 'grow' });
  const pdfBtn = h('button', { class: 'btn outline', type: 'button', title: 'Enregistrer cette mise en page dans un nouveau PDF' }, 'Enregistrer en PDF');
  const sysBtn = desktop ? h('button', { class: 'btn outline', type: 'button', title: 'Réglages propres à l\'imprimante (bac, qualité…) dans la fenêtre de Windows' }, 'Réglages Windows…') : null;
  const printBtn = h('button', { class: 'btn primary', type: 'button' }, 'Imprimer');
  const m = modal({ title: 'Imprimer', width: 1120, body: h('div', { class: 'pv-wrap' }, h('div', { class: 'pv-main' }, preview, err), side),
    foot: [summary, pdfBtn, sysBtn, h('button', { class: 'btn outline', type: 'button', onclick: () => m.close() }, 'Annuler'), printBtn].filter(Boolean),
    onClose: () => { closed = true; task?.destroy(); cache.clear(); window.removeEventListener('resize', onResize); } });
  m.el.classList.add('modal-print');

  // ---------- document exporté (avec toutes les modifications)
  let closed = false, task = null, pdf = null, bytes = null, sizes = [];
  const cache = new Map();
  try {
    bytes = await buildPdf(null);
    if (closed) return;
    task = pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes.slice() });
    pdf = await task.promise;
    for (let i = 1; i <= pdf.numPages; i++) { const vp = (await pdf.getPage(i)).getViewport({ scale: 1 }); sizes.push({ w: vp.width, h: vp.height }); }
  } catch (e) {
    console.error(e);
    canvasBox.replaceChildren(h('div', { class: 'pv-wait' }, 'Impossible de préparer l\'impression : ' + e.message));
    return;
  }

  let lay = null, cur = 0, drawSeq = 0;
  function summaryUpdate() {
    if (!lay) { summary.textContent = ''; return; }
    const pages = lay.sheets.reduce((t, s) => t + s.cells.filter(c => c.page != null).length, 0);
    const sides = lay.sheets.length;
    const duplex = lay.booklet || (desktop && o.duplex !== 'simplex');
    const paper = duplex ? Math.ceil(sides / 2) : sides;
    let t = `${pages} page${pages > 1 ? 's' : ''} · ${paper} feuille${paper > 1 ? 's' : ''}`;
    if (desktop && o.copies > 1) t += ` × ${o.copies} copies`;
    summary.textContent = t;
  }
  function update() {
    nupSel.value = String(o.nup); paperSel.value = o.paper;
    const multi = o.nup !== 1 && o.nup !== 'booklet';
    orderRow.hidden = !multi; borderChk.hidden = !multi;
    orientRow.hidden = o.nup === 'booklet';
    pct.hidden = o.scale !== 'custom';
    bookletHelp.hidden = o.nup !== 'booklet';
    bookletHelp.textContent = desktop
      ? 'Livret : impression recto verso (bord court) automatique. Pliez ensuite la pile en deux et agrafez au pli.'
      : 'Livret : imprimez en recto verso, retournement sur le bord court, puis pliez la pile en deux.';
    if (duplexSel) { duplexSel.disabled = o.nup === 'booklet'; if (o.nup === 'booklet') duplexSel.value = 'shortEdge'; else duplexSel.value = o.duplex; }
    const pl = pageList(o, n, info);
    err.hidden = !pl.error; err.textContent = pl.error || '';
    printBtn.disabled = pdfBtn.disabled = !!pl.error;
    if (sysBtn) sysBtn.disabled = !!pl.error;
    if (pl.error) { lay = null; summaryUpdate(); return; }
    lay = layout(o, pl.list, sizes);
    cur = Math.min(cur, lay.sheets.length - 1);
    summaryUpdate();
    saveOpts(o);
    draw();
  }
  async function draw() {
    if (!lay) return;
    const seq = ++drawSeq;
    const sh = lay.sheets[cur];
    navLabel.textContent = `Feuille ${cur + 1} sur ${lay.sheets.length}` + (lay.booklet ? (cur % 2 ? ' (verso)' : ' (recto)') : '');
    prev.disabled = cur === 0; next.disabled = cur >= lay.sheets.length - 1;
    const box = canvasBox.getBoundingClientRect();
    const avW = Math.max(120, box.width - 24), avH = Math.max(160, box.height - 24);
    const fit = Math.min(avW / sh.w, avH / sh.h);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const c = await renderSheet(pdf, sh, fit * dpr, o, cur, lay.sheets.length, cache);
    if (seq !== drawSeq || closed) return;
    c.className = 'pv-sheet';
    c.style.width = Math.round(sh.w * fit) + 'px'; c.style.height = Math.round(sh.h * fit) + 'px';
    canvasBox.replaceChildren(c);
  }
  prev.onclick = () => { if (cur > 0) { cur--; draw(); } };
  next.onclick = () => { if (lay && cur < lay.sheets.length - 1) { cur++; draw(); } };
  m.el.addEventListener('keydown', e => {
    if (e.target.matches('input, select')) return;
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); prev.click(); }
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); next.click(); }
  });
  let rt = 0; const onResize = () => { clearTimeout(rt); rt = setTimeout(draw, 120); };
  window.addEventListener('resize', onResize);
  // balayage sur l'aperçu (téléphone)
  let sx = null;
  canvasBox.addEventListener('pointerdown', e => { sx = e.clientX; });
  canvasBox.addEventListener('pointerup', e => { if (sx == null) return; const dx = e.clientX - sx; sx = null; if (Math.abs(dx) > 40) (dx < 0 ? next : prev).click(); });

  const busy = (btn, label) => { const old = [...btn.childNodes]; btn.disabled = true; btn.replaceChildren(h('span', { class: 'spinner' }), label); return () => { btn.disabled = false; btn.replaceChildren(...old); }; };

  pdfBtn.onclick = async () => {
    if (!lay) return;
    const done = busy(pdfBtn, 'Préparation…');
    try {
      const out = await composePdf(bytes, lay, o);
      const name = fileName('-impression');
      if (desktop) { const p = await desktop.saveAs(name, out, state.filePath); if (p) toast('PDF enregistré.'); }
      else if (await downloadBlob(new Blob([out], { type: 'application/pdf' }), name) !== false) toast('PDF enregistré.');
    } catch (e) { console.error(e); toast('Enregistrement impossible : ' + e.message, { error: true }); }
    done();
  };

  const doPrint = async system => {
    if (!lay) return;
    if (!desktop) {
      const done = busy(printBtn, 'Préparation…');
      try { const out = await composePdf(bytes, lay, o); m.close(); await printBytes(out); }
      catch (e) { console.error(e); toast('Impossible de préparer l\'impression : ' + e.message, { error: true }); done(); }
      return;
    }
    // Windows : feuilles rendues en images haute définition, imprimées sans repasser par un PDF
    const btn = system ? sysBtn : printBtn;
    const done = busy(btn, 'Préparation…');
    let job = null;
    try {
      const total = lay.sheets.length;
      const dpi = total > 80 ? 150 : total > 30 ? 200 : 300;
      job = await desktop.printBegin();
      const paper = PAPERS[o.paper] || PAPERS.A4;
      for (let k = 0; k < total; k++) {
        if (closed && !system) break;
        btn.lastChild.textContent = `Préparation ${k + 1}/${total}…`;
        let c = await renderSheet(pdf, lay.sheets[k], dpi / 72, o, k, total, null);
        // feuille en paysage : tournée pour tenir sur le papier en portrait
        if (c.width > c.height) {
          const r = document.createElement('canvas'); r.width = c.height; r.height = c.width;
          const rc = r.getContext('2d'); rc.translate(0, r.height); rc.rotate(-Math.PI / 2); rc.drawImage(c, 0, 0);
          c.width = c.height = 0; c = r;
        }
        const blob = await new Promise(res => c.toBlob(res, 'image/png'));
        c.width = c.height = 0;
        await desktop.printSheet(job, k, new Uint8Array(await blob.arrayBuffer()));
      }
      btn.lastChild.textContent = 'Envoi à l\'imprimante…';
      const landscapeSheets = lay.sheets.filter(s => s.w > s.h).length > lay.sheets.length / 2;
      let duplex = lay.booklet ? 'shortEdge' : o.duplex;
      // documents en paysage : « bord long » du point de vue du lecteur = bord court du papier
      if (!lay.booklet && landscapeSheets && duplex !== 'simplex') duplex = duplex === 'longEdge' ? 'shortEdge' : 'longEdge';
      const r = await desktop.printRun(job, { count: total, paper: { w: paper.w, h: paper.h }, deviceName: o.printer, copies: o.copies, collate: o.collate, duplex, color: o.color, system });
      job = null;
      if (r?.success) { m.close(); toast(system ? 'Impression lancée.' : `Impression envoyée à ${printerSel?.selectedOptions[0]?.textContent || 'l\'imprimante'}.`); }
      else if (r?.reason && !/cancel/i.test(r.reason)) toast('L\'impression a échoué : ' + r.reason, { error: true });
    } catch (e) { console.error(e); toast('Impossible d\'imprimer : ' + e.message, { error: true }); }
    finally { if (job) desktop.printCancel(job).catch(() => {}); }
    if (!closed) done();
  };
  printBtn.onclick = () => doPrint(false);
  if (sysBtn) sysBtn.onclick = () => doPrint(true);

  update();
}
