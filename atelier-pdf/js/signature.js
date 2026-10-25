// Création de signatures : tracer, saisir au clavier, importer une image
import { h, svgIcon, ICONS, toast } from './core.js';
import { modal } from './ui.js';
import { addImageAsset } from './docs.js';

const STORE = 'atelierpdf.signatures';
const loadSaved = () => { try { return JSON.parse(localStorage.getItem(STORE) || '[]'); } catch { return []; } };
const saveSaved = list => { try { localStorage.setItem(STORE, JSON.stringify(list.slice(0, 6))); } catch {} };

const INKS = [{ c: '#111111', n: 'Noir' }, { c: '#1d3fa8', n: 'Bleu' }];
const SCRIPTS = [
  { n: 'Manuscrite', f: '"Segoe Script", "Snell Roundhand", "Apple Chancery", "URW Chancery L", cursive', s: 1 },
  { n: 'Élégante', f: '"Brush Script MT", "Lucida Handwriting", "Bradley Hand", cursive', s: 1.15 },
  { n: 'Classique', f: 'Georgia, "Times New Roman", serif', s: 1, style: 'italic' },
];

/** Ouvre la fenêtre de signature. Résout avec l'id d'image (asset) ou null. */
export function openSignatureDialog() {
  return new Promise(resolve => {
    let ink = INKS[0].c, current = 'draw', typedStyle = 0, importedUrl = null, removeBg = true;
    const saved = loadSaved();

    /* --- tracer --- */
    const canvas = h('canvas');
    const pad = h('div', { class: 'sigpad-wrap' }, canvas, h('div', { class: 'baseline' }), h('div', { class: 'placeholder' }, 'Signez ici avec la souris, le doigt ou un stylet'));
    const strokes = []; let stroke = null;
    const ctx = canvas.getContext('2d');
    const resize = () => {
      const r = pad.getBoundingClientRect(), d = window.devicePixelRatio || 1;
      canvas.width = r.width * d; canvas.height = r.height * d; ctx.setTransform(d, 0, 0, d, 0, 0); redraw();
    };
    const redraw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = ink; ctx.fillStyle = ink; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const s of strokes) drawStroke(ctx, s);
      pad.querySelector('.placeholder').style.display = strokes.length ? 'none' : '';
    };
    canvas.addEventListener('pointerdown', e => {
      e.preventDefault(); canvas.setPointerCapture(e.pointerId);
      const r = canvas.getBoundingClientRect();
      stroke = [[e.clientX - r.left, e.clientY - r.top, e.pressure || 0.5]]; strokes.push(stroke); redraw();
    });
    canvas.addEventListener('pointermove', e => {
      if (!stroke) return;
      const r = canvas.getBoundingClientRect();
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of evs) stroke.push([ev.clientX - r.left, ev.clientY - r.top, ev.pressure || 0.5]);
      redraw();
    });
    const endStroke = () => { stroke = null; };
    canvas.addEventListener('pointerup', endStroke); canvas.addEventListener('pointercancel', endStroke);

    const inkPick = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Couleur de l\'encre' },
      ...INKS.map(i => h('button', { class: 'swatch', type: 'button', title: i.n, 'aria-label': i.n, style: { background: i.c }, 'aria-pressed': i.c === ink, onclick: e => {
        ink = i.c; inkPick.querySelectorAll('.swatch').forEach(b => b.setAttribute('aria-pressed', b === e.currentTarget)); redraw(); renderTyped(); } })));
    const drawPanel = h('div', { class: 'field' }, pad,
      h('div', { class: 'row', style: { justifyContent: 'space-between' } }, inkPick,
        h('button', { class: 'btn small outline', type: 'button', onclick: () => { strokes.length = 0; redraw(); } }, 'Effacer')));

    /* --- saisir --- */
    const nameInput = h('input', { class: 'input', placeholder: 'Votre nom', 'aria-label': 'Nom', style: { width: '100%' } });
    const typedGrid = h('div', { class: 'sig-typed' });
    const renderTyped = () => {
      typedGrid.replaceChildren(...SCRIPTS.map((s, i) => h('button', { type: 'button', 'aria-pressed': i === typedStyle,
        style: { fontFamily: s.f, fontStyle: s.style || 'normal', color: ink, fontSize: 26 * s.s + 'px' },
        onclick: () => { typedStyle = i; renderTyped(); } }, nameInput.value || 'Votre nom')));
    };
    nameInput.addEventListener('input', renderTyped);
    const typePanel = h('div', { class: 'field' }, nameInput, typedGrid);

    /* --- importer --- */
    const fileIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
    const preview = h('div', { class: 'import-preview' }, h('span', { class: 'help' }, 'Photo ou scan de votre signature sur fond clair'));
    const bgToggle = h('input', { type: 'checkbox', checked: true });
    const showImport = async () => {
      if (!importedUrl) return;
      const url = removeBg ? await knockOutWhite(importedUrl) : importedUrl;
      preview.replaceChildren(h('img', { src: url, alt: 'Aperçu' }));
    };
    bgToggle.onchange = () => { removeBg = bgToggle.checked; showImport(); };
    fileIn.onchange = () => {
      const f = fileIn.files[0]; if (!f) return;
      const r = new FileReader(); r.onload = () => { importedUrl = r.result; showImport(); }; r.readAsDataURL(f);
    };
    const importPanel = h('div', { class: 'field' }, preview,
      h('div', { class: 'row', style: { justifyContent: 'space-between' } },
        h('label', { class: 'check-row' }, bgToggle, 'Rendre le fond transparent'),
        h('button', { class: 'btn small outline', type: 'button', onclick: () => fileIn.click() }, 'Choisir une image…')), fileIn);

    /* --- mes signatures --- */
    const savedWrap = h('div', { class: 'field' });
    const renderSaved = () => {
      savedWrap.replaceChildren();
      if (!saved.length) return;
      savedWrap.append(h('span', { class: 'lbl' }, 'Mes signatures enregistrées sur cet appareil'),
        h('div', { class: 'saved-sigs' }, ...saved.map((url, i) => h('div', { class: 'saved-sig', role: 'button', tabindex: 0, title: 'Utiliser cette signature',
          onclick: () => finish(url, false), onkeydown: e => { if (e.key === 'Enter') finish(url, false); } },
          h('img', { src: url, alt: 'Signature enregistrée' }),
          h('button', { class: 'x', type: 'button', title: 'Supprimer', 'aria-label': 'Supprimer cette signature', onclick: e => { e.stopPropagation(); saved.splice(i, 1); saveSaved(saved); renderSaved(); } }, svgIcon(ICONS.close))))));
    };

    const panels = { draw: drawPanel, type: typePanel, import: importPanel };
    const tabs = h('div', { class: 'tabs', role: 'tablist' }, ...[['draw', 'Tracer'], ['type', 'Saisir'], ['import', 'Importer']].map(([k, l]) =>
      h('button', { role: 'tab', type: 'button', 'aria-selected': k === current, 'data-k': k, onclick: () => showTab(k) }, l)));
    const panelHost = h('div');
    const showTab = k => {
      current = k;
      tabs.querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', b.dataset.k === k));
      panelHost.replaceChildren(panels[k]);
      if (k === 'draw') requestAnimationFrame(resize);
      if (k === 'type') { renderTyped(); setTimeout(() => nameInput.focus(), 20); }
    };
    const remember = h('input', { type: 'checkbox' });

    const finish = async (url, store) => {
      if (store && remember.checked) { saved.unshift(url); saveSaved(saved); }
      const a = await addImageAsset(url, { maxSide: 1600 });
      done = true; m.close(a.id);
    };
    const validate = async () => {
      let url = null;
      if (current === 'draw') {
        if (!strokes.length) return toast('Tracez votre signature dans le cadre.');
        url = strokesToPng(strokes, ink);
      } else if (current === 'type') {
        if (!nameInput.value.trim()) { nameInput.focus(); return toast('Saisissez votre nom.'); }
        url = await typedToPng(nameInput.value.trim(), SCRIPTS[typedStyle], ink);
      } else {
        if (!importedUrl) return toast('Choisissez d\'abord une image.');
        url = await trimPng(removeBg ? await knockOutWhite(importedUrl) : importedUrl);
      }
      finish(url, true);
    };
    let done = false;
    const m = modal({
      title: 'Signer', width: 600,
      body: [savedWrap, tabs, panelHost],
      foot: [h('label', { class: 'check-row grow' }, remember, 'Mémoriser sur cet appareil'),
        h('button', { class: 'btn outline', onclick: () => m.close(null) }, 'Annuler'),
        h('button', { class: 'btn primary', onclick: validate }, 'Utiliser cette signature')],
      onClose: r => resolve(done ? r : null),
    });
    renderSaved();
    showTab('draw');
    window.addEventListener('resize', resize, { once: true });
  });
}

/* ---- rendu des tracés, lissés, avec une épaisseur liée à la vitesse ---- */
function drawStroke(ctx, s, scale = 1, ox = 0, oy = 0) {
  if (s.length === 1) { ctx.beginPath(); ctx.arc((s[0][0] - ox) * scale, (s[0][1] - oy) * scale, 1.4 * scale, 0, Math.PI * 2); ctx.fill(); return; }
  for (let i = 1; i < s.length; i++) {
    const [x0, y0] = s[i - 1], [x1, y1] = s[i];
    const v = Math.hypot(x1 - x0, y1 - y0);
    ctx.lineWidth = Math.max(1.3, 3.1 - v * 0.09) * scale;
    ctx.beginPath();
    const pm = i > 1 ? [(s[i - 2][0] + x0) / 2, (s[i - 2][1] + y0) / 2] : [x0, y0];
    ctx.moveTo((pm[0] - ox) * scale, (pm[1] - oy) * scale);
    ctx.quadraticCurveTo((x0 - ox) * scale, (y0 - oy) * scale, ((x0 + x1) / 2 - ox) * scale, ((y0 + y1) / 2 - oy) * scale);
    ctx.stroke();
  }
}
function strokesToPng(strokes, ink) {
  const pts = strokes.flat();
  const minX = Math.min(...pts.map(p => p[0])) - 6, minY = Math.min(...pts.map(p => p[1])) - 6;
  const maxX = Math.max(...pts.map(p => p[0])) + 6, maxY = Math.max(...pts.map(p => p[1])) + 6;
  const scale = 3;
  const c = document.createElement('canvas');
  c.width = Math.ceil((maxX - minX) * scale); c.height = Math.ceil((maxY - minY) * scale);
  const x = c.getContext('2d');
  x.strokeStyle = ink; x.fillStyle = ink; x.lineCap = 'round'; x.lineJoin = 'round';
  for (const s of strokes) drawStroke(x, s, scale, minX, minY);
  return c.toDataURL('image/png');
}
async function typedToPng(text, script, ink) {
  try { await document.fonts.load(`64px ${script.f}`); } catch {}
  const c = document.createElement('canvas'); const x = c.getContext('2d');
  const font = `${script.style || 'normal'} ${Math.round(110 * script.s)}px ${script.f}`;
  x.font = font;
  const w = x.measureText(text).width;
  c.width = Math.ceil(w + 60); c.height = Math.round(200 * script.s);
  x.font = font; x.fillStyle = ink; x.textBaseline = 'middle';
  x.fillText(text, 30, c.height / 2);
  return trimPng(c.toDataURL('image/png'));
}
async function loadImg(url) { const i = new Image(); i.src = url; await i.decode(); return i; }
/** Fond clair → transparent ; légère accentuation de l'encre. */
async function knockOutWhite(url) {
  const img = await loadImg(url);
  const s = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
  const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0, c.width, c.height);
  const d = x.getImageData(0, 0, c.width, c.height), p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    const l = 0.3 * p[i] + 0.59 * p[i + 1] + 0.11 * p[i + 2];
    const a = l > 200 ? 0 : l < 120 ? 255 : Math.round(255 * (200 - l) / 80);
    p[i + 3] = Math.min(p[i + 3], a);
  }
  x.putImageData(d, 0, 0);
  return trimPng(c.toDataURL('image/png'));
}
async function trimPng(url) {
  const img = await loadImg(url);
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0);
  const { data, width, height } = x.getImageData(0, 0, c.width, c.height);
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let xx = 0; xx < width; xx++) if (data[(y * width + xx) * 4 + 3] > 16) {
    if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return url;
  const pad = 8;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
  const o = document.createElement('canvas'); o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
  o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
  return o.toDataURL('image/png');
}
