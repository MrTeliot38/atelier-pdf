// Scanner de documents : photographier une ou plusieurs feuilles, les redresser et les nettoyer,
// en faire un PDF (qualité faible, moyenne ou élevée), puis le partager.
import { h, toast, svgIcon, ICONS, PDFLib, downloadBlob } from './core.js';
import { detectQuad, QUALITIES, pdfPageSize } from './scancore.js';
import { isAndroidApp, saveBlob, shareBlob, canShareFiles, pushBack } from './platform.js';
import { confirmDialog } from './ui.js';

const I = {
  camera: '<path d="M4 8a2 2 0 0 1 2-2h2l1.5-2h5L16 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.5"/>',
  gallery: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  flash: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  next: '<path d="M9 5l7 7-7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M2 6h14a2 2 0 0 1 2 2v14"/>',
  auto: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M9 12l2 2 4-4"/>',
  full: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 9h16M9 4v16" stroke-opacity=".35"/>',
  share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/>',
  save: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 19h16"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
};
const FILTERS = [['color', 'Couleur'], ['doc', 'Document'], ['gray', 'Gris'], ['bw', 'Noir et blanc']];
const FULL = [[0, 0], [1, 0], [1, 1], [0, 1]];
const fmtSize = b => b < 1024 * 1024 ? Math.max(1, Math.round(b / 1024)) + ' Ko' : (b / 1024 / 1024).toFixed(1).replace('.', ',') + ' Mo';
const uid = () => Math.random().toString(36).slice(2, 10);

/* ------------------------------------------------------------ travailleur d'arrière-plan */
let worker = null, wid = 0, chain = Promise.resolve();
const pend = new Map();
function work(cmd, args) {
  if (!worker) {
    worker = new Worker(new URL('./scanworker.js', import.meta.url), { type: 'module' });
    worker.onmessage = e => { const p = pend.get(e.data.id); if (!p) return; pend.delete(e.data.id); e.data.error ? p.rej(new Error(e.data.error)) : p.res(e.data.result); };
  }
  // une tâche à la fois : la mémoire d'un téléphone est limitée
  const job = chain.then(() => new Promise((res, rej) => { const id = ++wid; pend.set(id, { res, rej }); worker.postMessage({ id, cmd, args }); }));
  chain = job.catch(() => {});
  return job;
}

/* ------------------------------------------------------------ séance de scan */
let S = null;

/**
 * Ouvre le scanner.
 * mode 'new' : crée un PDF à partager / enregistrer / modifier ; mode 'append' : ajoute les pages au document ouvert.
 * onEdit(file) : ouvrir le PDF dans l'éditeur ; onAppend(file) : ajouter les pages au document.
 */
export function openScanner({ mode = 'new', onEdit, onAppend, files } = {}) {
  if (S) return;
  const root = h('div', { class: 'scanner', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Scanner un document' });
  document.body.append(root);
  document.body.classList.add('scanning');
  S = { root, mode, onEdit, onAppend, pages: [], filter: 'doc', quality: 'medium', view: null, stream: null, result: null, exported: false, cleanup: [] };
  S.cleanup.push(pushBack(() => document.querySelector('.backdrop') ? false : back()));
  const kb = e => { if (e.key === 'Escape' && !document.querySelector('.backdrop')) { e.stopPropagation(); back(); } };
  document.addEventListener('keydown', kb, true);
  S.cleanup.push(() => document.removeEventListener('keydown', kb, true));
  if (files?.length) { addFiles(files); showReview(); }
  else showCamera();
}
export const isScannerOpen = () => !!S;

async function closeScanner(force) {
  if (!S) return;
  if (!force && S.pages.length && !S.exported) {
    const ok = await confirmDialog({ title: 'Abandonner ce scan ?', text: `${S.pages.length} page${S.pages.length > 1 ? 's' : ''} photographiée${S.pages.length > 1 ? 's' : ''} seront perdue${S.pages.length > 1 ? 's' : ''}.`, ok: 'Abandonner', danger: true });
    if (!ok) return;
  }
  stopCamera();
  S.pages.forEach(p => p.thumb && URL.revokeObjectURL(p.thumb));
  S.cleanup.forEach(f => f());
  S.root.remove();
  document.body.classList.remove('scanning');
  S = null;
}
/** Bouton Retour / Échap : revient à l'écran précédent. */
function back() {
  if (!S) return false;
  const v = S.view;
  if (v === 'editor') showReview();
  else if (v === 'quality') showReview();
  else if (v === 'busy') return true;
  else if (v === 'done') { S.exported = true; closeScanner(true); }
  else if (v === 'review') { if (S.pages.length) showCamera(); else closeScanner(); }
  else closeScanner();
  return true;
}

function frame(view, { title, left, right, body, foot, cls = '' }) {
  S.view = view;
  const head = h('header', { class: 'scan-head' },
    left || h('button', { class: 'scan-iconbtn', type: 'button', title: 'Fermer', 'aria-label': 'Fermer le scanner', onclick: () => closeScanner() }, svgIcon(ICONS.close)),
    h('h2', {}, title || ''), h('div', { class: 'scan-head-r' }, right || []));
  const el = h('div', { class: 'scan-view scan-' + view + ' ' + cls }, head, body, foot ? h('footer', { class: 'scan-foot' }, foot) : null);
  S.root.replaceChildren(el);
  return el;
}
const iconBtn = (icon, label, onclick, extra = {}) => h('button', { class: 'scan-iconbtn', type: 'button', title: label, 'aria-label': label, onclick, ...extra }, svgIcon(icon));
const btn = (label, onclick, cls = 'outline', icon) => h('button', { class: 'btn ' + cls, type: 'button', onclick }, icon ? svgIcon(icon) : null, label);

/* ------------------------------------------------------------ pages */
function addFiles(files) {
  for (const f of files) if (/^image\//.test(f.type) || /\.(jpe?g|png|webp|heic)$/i.test(f.name || '')) addPage(f);
}
function addPage(blob) {
  const p = { id: uid(), blob, w: 0, h: 0, quad: null, auto: false, rot: 0, filter: null, thumb: null, ready: false, failed: false };
  S.pages.push(p);
  prepare(p);
  return p;
}
async function prepare(p) {
  try {
    const d = await work('detect', { blob: p.blob });
    p.w = d.w; p.h = d.h; p.quad = d.quad || FULL; p.auto = !!d.quad;
    await refreshThumb(p);
    p.ready = true;
  } catch (e) { console.error(e); p.failed = true; }
  onPagesChanged();
}
const filterOf = p => p.filter || S.filter;
async function refreshThumb(p) {
  const r = await work('render', { blob: p.blob, srcW: p.w, srcH: p.h, quad: p.quad, rot: p.rot, filter: filterOf(p), maxLong: 520, q: 0.8 });
  if (!S) return;
  if (p.thumb) URL.revokeObjectURL(p.thumb);
  p.thumb = URL.createObjectURL(r.blob);
  p.tw = r.w; p.th = r.h;
}
function onPagesChanged() {
  if (!S) return;
  S.result = null; S.exported = false;
  if (S.view === 'camera') updateCamCounter();
  if (S.view === 'review') renderGrid();
}

/* ------------------------------------------------------------ appareil photo */
let camTimer = 0;
function stopCamera() {
  cancelAnimationFrame(camTimer); camTimer = 0;
  if (S?.stream) { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; }
}
async function showCamera() {
  const video = h('video', { class: 'scan-video', autoplay: true, muted: true, playsinline: true });
  video.muted = true; video.setAttribute('playsinline', '');
  const overlay = h('canvas', { class: 'scan-overlay' });
  const hint = h('p', { class: 'scan-hint' }, 'Préparation de l\'appareil photo…');
  const stage = h('div', { class: 'scan-stage' }, video, overlay, hint);
  const flashFx = h('div', { class: 'scan-flash' });
  const torchBtn = iconBtn(I.flash, 'Lampe', null, { hidden: true, 'aria-pressed': 'false' });
  const shutter = h('button', { class: 'scan-shutter', type: 'button', title: 'Prendre la photo', 'aria-label': 'Prendre la photo' }, h('span'));
  const stack = h('button', { class: 'scan-stack', type: 'button', title: 'Voir les pages', 'aria-label': 'Voir les pages', onclick: () => S.pages.length && showReview() });
  const doneBtn = h('button', { class: 'btn primary scan-done', type: 'button', onclick: () => S.pages.length && showReview() }, 'Terminer', svgIcon(I.next));
  const gallery = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  const capture = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  const onPick = e => { const f = [...e.target.files]; e.target.value = ''; if (!f.length) return; addFiles(f); updateCamCounter(); };
  gallery.onchange = onPick; capture.onchange = onPick;
  frame('camera', {
    title: 'Scanner',
    right: [torchBtn, iconBtn(I.gallery, 'Importer des photos', () => gallery.click())],
    body: [stage, flashFx, gallery, capture],
    foot: [stack, shutter, doneBtn],
  });
  S.cam = { video, overlay, hint, stack, doneBtn, shutter, capture };
  updateCamCounter();

  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('nocam');
    S.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } } });
    if (!S || S.view !== 'camera') { S?.stream?.getTracks().forEach(t => t.stop()); return; }
    video.srcObject = S.stream;
    await video.play().catch(() => {});
    const track = S.stream.getVideoTracks()[0];
    try { track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {}); } catch {}
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps.torch) {
      torchBtn.hidden = false;
      torchBtn.onclick = async () => {
        const on = torchBtn.getAttribute('aria-pressed') !== 'true';
        try { await track.applyConstraints({ advanced: [{ torch: on }] }); torchBtn.setAttribute('aria-pressed', on); } catch {}
      };
    }
    hint.textContent = 'Posez la feuille bien à plat, sur un fond qui contraste.';
    shutter.onclick = () => shoot(flashFx);
    liveDetect();
  } catch (e) {
    console.warn('Appareil photo', e);
    if (!S || S.view !== 'camera') return;
    stage.classList.add('nocam');
    hint.replaceChildren(
      h('b', {}, e.name === 'NotAllowedError' ? 'L\'accès à l\'appareil photo a été refusé.' : 'L\'appareil photo n\'est pas disponible ici.'),
      h('span', {}, e.name === 'NotAllowedError' ? 'Autorisez-le dans les réglages, ou utilisez les boutons ci-dessous.' : 'Vous pouvez prendre la photo avec l\'appareil photo du téléphone ou choisir des photos existantes.'),
      h('span', { class: 'row', style: { justifyContent: 'center', marginTop: '10px' } },
        btn('Prendre une photo', () => capture.click(), 'primary', I.camera), btn('Choisir des photos', () => gallery.click(), 'outline', I.gallery)));
    shutter.onclick = () => capture.click();
  }
}
function updateCamCounter() {
  if (!S?.cam) return;
  const n = S.pages.length, last = S.pages[n - 1];
  S.cam.stack.replaceChildren(...[
    last?.thumb ? h('img', { src: last.thumb, alt: '' }) : n ? h('span', { class: 'spinner' }) : svgIcon(I.doc),
    n ? h('b', {}, String(n)) : null].filter(Boolean));
  S.cam.stack.disabled = !n;
  S.cam.doneBtn.disabled = !n;
}

/** Repérage de la feuille en direct, plusieurs fois par seconde. */
function liveDetect() {
  const { video, overlay, hint } = S.cam;
  const small = document.createElement('canvas');
  const sctx = small.getContext('2d', { willReadFrequently: true });
  let last = 0, smooth = null, seen = 0;
  const loop = t => {
    if (!S || S.view !== 'camera' || !S.stream) return;
    camTimer = requestAnimationFrame(loop);
    if (t - last < 140 || !video.videoWidth) return;
    last = t;
    const vw = video.videoWidth, vh = video.videoHeight, s = 300 / Math.max(vw, vh);
    small.width = Math.round(vw * s); small.height = Math.round(vh * s);
    sctx.drawImage(video, 0, 0, small.width, small.height);
    let q = null;
    try { q = detectQuad(sctx.getImageData(0, 0, small.width, small.height).data, small.width, small.height); } catch {}
    if (q) { smooth = smooth ? smooth.map((p, i) => [p[0] * 0.5 + q[i][0] * 0.5, p[1] * 0.5 + q[i][1] * 0.5]) : q; seen = Math.min(seen + 1, 4); }
    else { seen = Math.max(seen - 1, 0); if (!seen) smooth = null; }
    // affichage : la vidéo est entière à l'écran (contain)
    const r = overlay.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    overlay.width = Math.round(r.width * dpr); overlay.height = Math.round(r.height * dpr);
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const k = Math.min(r.width / vw, r.height / vh), ox = (r.width - vw * k) / 2, oy = (r.height - vh * k) / 2;
    if (smooth && seen >= 2) {
      ctx.save(); ctx.scale(dpr, dpr);
      ctx.beginPath();
      smooth.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo'](ox + x * vw * k, oy + y * vh * k));
      ctx.closePath();
      ctx.fillStyle = 'rgba(70,110,255,.18)'; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = '#7d97ff'; ctx.lineJoin = 'round'; ctx.stroke();
      ctx.restore();
      hint.textContent = 'Feuille repérée : appuyez sur le déclencheur.';
      hint.classList.add('ok');
    } else {
      hint.textContent = 'Posez la feuille bien à plat, sur un fond qui contraste.';
      hint.classList.remove('ok');
    }
  };
  camTimer = requestAnimationFrame(loop);
}

async function grabFrame(video) {
  const c = document.createElement('canvas');
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  return new Promise(res => c.toBlob(res, 'image/jpeg', 0.93));
}
/** Photo en pleine définition quand l'appareil le permet, sinon l'image de l'aperçu. */
async function grabPhoto(video) {
  const track = S.stream?.getVideoTracks()[0];
  if (track && 'ImageCapture' in window) {
    try {
      const ic = new ImageCapture(track);
      const blob = await Promise.race([ic.takePhoto(), new Promise((_, rej) => setTimeout(() => rej(new Error('délai')), 5000))]);
      if (blob && blob.size > 20000) {
        // contrôle de l'orientation : la photo doit avoir le même sens que l'aperçu
        const bmp = await createImageBitmap(blob);
        const same = (bmp.width >= bmp.height) === (video.videoWidth >= video.videoHeight);
        const bigger = Math.max(bmp.width, bmp.height) > Math.max(video.videoWidth, video.videoHeight);
        bmp.close();
        if (same && bigger) return blob;
      }
    } catch (e) { console.warn('takePhoto', e); }
  }
  return grabFrame(video);
}
let shooting = false;
async function shoot(flashFx) {
  if (shooting || !S?.cam) return;
  shooting = true;
  const { video, shutter } = S.cam;
  shutter.classList.add('busy');
  flashFx.classList.remove('go'); void flashFx.offsetWidth; flashFx.classList.add('go');
  try {
    const blob = await grabPhoto(video);
    if (blob && S) { addPage(blob); updateCamCounter(); navigator.vibrate?.(30); }
  } catch (e) { console.error(e); toast('La photo n\'a pas pu être prise.', { error: true }); }
  shutter.classList.remove('busy');
  shooting = false;
}

/* ------------------------------------------------------------ vos pages */
function showReview() {
  stopCamera();
  const grid = h('div', { class: 'scan-grid' });
  const seg = h('div', { class: 'seg scan-filters', role: 'radiogroup', 'aria-label': 'Rendu des pages' });
  for (const [v, l] of FILTERS) seg.append(h('button', { type: 'button', 'aria-pressed': S.filter === v, onclick: e => {
    S.filter = v; S.pages.forEach(p => { p.filter = null; });
    seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b === e.currentTarget));
    S.pages.forEach(p => { p.ready = false; refreshThumb(p).then(() => { p.ready = true; onPagesChanged(); }); });
    renderGrid();
  } }, l));
  const gallery = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: e => { const f = [...e.target.files]; e.target.value = ''; addFiles(f); renderGrid(); } });
  const create = btn(S.mode === 'append' ? 'Ajouter au document' : 'Créer le PDF', () => S.pages.length && showQuality(), 'primary big', I.doc);
  frame('review', {
    title: '',
    left: iconBtn(I.back, 'Reprendre des photos', () => showCamera()),
    right: [iconBtn(I.gallery, 'Importer des photos', () => gallery.click()), iconBtn(ICONS.close, 'Fermer le scanner', () => closeScanner())],
    body: [h('div', { class: 'scan-review-tools' }, h('span', { class: 'lbl' }, 'Rendu'), seg), grid, gallery,
      h('p', { class: 'scan-tip' }, 'Touchez une page pour la recadrer ou la tourner. Maintenez-la pour changer l\'ordre.')],
    foot: [btn('Ajouter des pages', () => showCamera(), 'outline', I.camera), create],
  });
  S.grid = grid; S.createBtn = create;
  renderGrid();
  if (window.Sortable) Sortable.create(grid, {
    animation: 150, delay: 200, delayOnTouchOnly: true, filter: '.scan-card-del', preventOnFilter: false,
    onEnd: () => { const order = [...grid.children].map(c => c.dataset.id); S.pages.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)); renderGrid(); },
  });
}
function renderGrid() {
  if (!S?.grid) return;
  const title = S.root.querySelector('.scan-head h2');
  if (title) title.textContent = S.pages.length ? `${S.pages.length} page${S.pages.length > 1 ? 's' : ''}` : 'Aucune page';
  S.grid.replaceChildren(...S.pages.map((p, i) => h('div', { class: 'scan-card' + (p.ready ? '' : ' busy'), 'data-id': p.id, role: 'button', tabindex: 0, 'aria-label': `Page ${i + 1} : recadrer`,
    onclick: e => { if (!e.target.closest('.scan-card-del') && p.ready) showEditor(p); },
    onkeydown: e => { if ((e.key === 'Enter' || e.key === ' ') && p.ready) { e.preventDefault(); showEditor(p); } } },
    h('div', { class: 'scan-card-img' }, p.thumb ? h('img', { src: p.thumb, alt: '' }) : null, !p.ready ? h('span', { class: 'spinner' }) : null,
      p.failed ? h('span', { class: 'scan-card-err' }, 'Image illisible') : null),
    h('span', { class: 'scan-card-num' }, String(i + 1)),
    p.ready && !p.auto ? h('span', { class: 'scan-card-warn', title: 'Bords de la feuille non trouvés : touchez pour recadrer' }, svgIcon(I.crop)) : null,
    h('button', { class: 'scan-card-del', type: 'button', title: 'Retirer cette page', 'aria-label': `Retirer la page ${i + 1}`, onclick: () => removePage(p) }, svgIcon(ICONS.trash)))));
  if (S.createBtn) S.createBtn.disabled = !S.pages.length || S.pages.some(p => !p.ready && !p.failed);
}
function removePage(p) {
  const i = S.pages.indexOf(p); if (i < 0) return;
  S.pages.splice(i, 1);
  toast('Page retirée.', { action: { label: 'Annuler', fn: () => { if (!S) return; S.pages.splice(i, 0, p); onPagesChanged(); renderGrid(); } } });
  onPagesChanged();
  if (S.view === 'editor') showReview();
}

/* ------------------------------------------------------------ recadrage d'une page */
function showEditor(p) {
  const img = h('img', { class: 'scan-edit-img', alt: '', draggable: 'false' });
  const url = URL.createObjectURL(p.blob);
  img.src = url;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'scan-edit-svg');
  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  const shade = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shade.setAttribute('class', 'shade'); poly.setAttribute('class', 'quad');
  svg.append(shade, poly);
  const handles = [0, 1, 2, 3].map(i => h('div', { class: 'scan-handle', 'data-i': i, role: 'slider', 'aria-label': ['Coin haut gauche', 'Coin haut droit', 'Coin bas droit', 'Coin bas gauche'][i], tabindex: 0 }));
  const loupe = h('canvas', { class: 'scan-loupe', width: 240, height: 240, hidden: true });
  const box = h('div', { class: 'scan-edit-box' }, img, svg, ...handles, loupe);
  const stage = h('div', { class: 'scan-edit-stage' }, box);
  let quad = p.quad.map(c => [...c]), rot = p.rot, filter = p.filter;
  const rotLabel = h('span', { class: 'scan-rot' });
  const preview = h('div', { class: 'scan-preview', hidden: true });

  const place = () => {
    const W = box.clientWidth, H = box.clientHeight;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const pts = quad.map(([x, y]) => [x * W, y * H]);
    poly.setAttribute('points', pts.map(p => p.join(',')).join(' '));
    shade.setAttribute('d', `M0 0H${W}V${H}H0Z M${pts.map(p => p.join(' ')).join(' L')}Z`);
    handles.forEach((el, i) => { el.style.left = pts[i][0] + 'px'; el.style.top = pts[i][1] + 'px'; });
    rotLabel.textContent = rot % 360 ? `Tournée de ${((rot % 360) + 360) % 360}°` : '';
  };
  const fit = () => {
    if (!img.naturalWidth) return;
    const sr = stage.getBoundingClientRect(), a = img.naturalWidth / img.naturalHeight;
    let w = sr.width - 40, hh = w / a;
    if (hh > sr.height - 40) { hh = sr.height - 40; w = hh * a; }
    box.style.width = w + 'px'; box.style.height = hh + 'px';
    place();
  };
  img.onload = fit;
  const ro = new ResizeObserver(fit); ro.observe(stage);

  // déplacement des coins (souris, doigt, clavier) avec loupe
  const drawLoupe = (i) => {
    const W = box.clientWidth, H = box.clientHeight, [x, y] = quad[i];
    const ctx = loupe.getContext('2d'), z = 3, nw = img.naturalWidth, nh = img.naturalHeight;
    const sw = 240 / z * nw / W, sh = 240 / z * nh / H;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 240, 240);
    ctx.drawImage(img, x * nw - sw / 2, y * nh - sh / 2, sw, sh, 0, 0, 240, 240);
    ctx.strokeStyle = '#7d97ff'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(120, 96); ctx.lineTo(120, 144); ctx.moveTo(96, 120); ctx.lineTo(144, 120); ctx.stroke();
    // la loupe s'écarte du doigt
    loupe.style.left = (x * W < W / 2 ? x * W + 40 : x * W - 160) + 'px';
    loupe.style.top = Math.max(0, y * H - 170) + 'px';
  };
  handles.forEach((el, i) => {
    el.addEventListener('pointerdown', e => {
      e.preventDefault(); el.setPointerCapture(e.pointerId); el.classList.add('drag'); loupe.hidden = false;
      const r = box.getBoundingClientRect(), start = [...quad[i]], sx = e.clientX, sy = e.clientY;
      const move = ev => {
        quad[i] = [Math.min(1, Math.max(0, start[0] + (ev.clientX - sx) / r.width)), Math.min(1, Math.max(0, start[1] + (ev.clientY - sy) / r.height))];
        place(); drawLoupe(i);
      };
      const up = () => { el.classList.remove('drag'); loupe.hidden = true; el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
      drawLoupe(i);
    });
    el.addEventListener('keydown', e => {
      const d = e.shiftKey ? 0.02 : 0.004;
      const m = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] }[e.key];
      if (!m) return;
      e.preventDefault(); quad[i] = [Math.min(1, Math.max(0, quad[i][0] + m[0])), Math.min(1, Math.max(0, quad[i][1] + m[1]))]; place();
    });
  });

  const seg = h('div', { class: 'seg scan-filters', role: 'radiogroup', 'aria-label': 'Rendu de cette page' });
  for (const [v, l] of FILTERS) seg.append(h('button', { type: 'button', 'aria-pressed': (filter || S.filter) === v, onclick: e => { filter = v; seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b === e.currentTarget)); if (!preview.hidden) showPreview(); } }, l));

  let previewUrl = null, previewJob = 0;
  const showPreview = async () => {
    const job = ++previewJob;
    preview.hidden = false;
    preview.replaceChildren(h('span', { class: 'spinner' }));
    const r = await work('render', { blob: p.blob, srcW: p.w, srcH: p.h, quad, rot, filter: filter || S.filter, maxLong: 1400, q: 0.85 });
    if (job !== previewJob || !S) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(r.blob);
    preview.replaceChildren(h('img', { src: previewUrl, alt: 'Aperçu de la page' }), btn('Retour au recadrage', () => { preview.hidden = true; }, 'outline scan-preview-close'));
  };
  const redetect = async () => {
    const d = await work('detect', { blob: p.blob });
    if (d.quad) { quad = d.quad; place(); toast('Bords de la feuille retrouvés.'); }
    else toast('Les bords de la feuille n\'ont pas été trouvés : placez les coins à la main.');
  };
  const idx = S.pages.indexOf(p) + 1;
  frame('editor', {
    title: `Page ${idx}`,
    left: iconBtn(I.back, 'Retour aux pages', () => showReview()),
    right: [iconBtn(ICONS.trash, 'Retirer cette page', () => removePage(p))],
    body: [stage, preview,
      h('div', { class: 'scan-edit-tools' },
        btn('Auto', redetect, 'ghost', I.auto), btn('Page entière', () => { quad = FULL.map(c => [...c]); place(); }, 'ghost', I.full),
        btn('Tourner', () => { rot = (rot + 270) % 360; place(); if (!preview.hidden) showPreview(); }, 'ghost', ICONS.rotl),
        btn('Tourner', () => { rot = (rot + 90) % 360; place(); if (!preview.hidden) showPreview(); }, 'ghost', ICONS.rotr),
        btn('Aperçu', showPreview, 'ghost', I.eye)),
      h('div', { class: 'scan-edit-row' }, seg, rotLabel)],
    foot: [btn('Annuler', () => showReview(), 'outline'), btn('Valider', async () => {
      p.quad = quad; p.rot = rot; p.filter = filter && filter !== S.filter ? filter : null; p.auto = true; p.ready = false;
      showReview();
      await refreshThumb(p); p.ready = true; onPagesChanged();
    }, 'primary')],
  });
  S.cleanup.push(() => { ro.disconnect(); URL.revokeObjectURL(url); if (previewUrl) URL.revokeObjectURL(previewUrl); });
  const stop = () => { ro.disconnect(); };
  const obs = new MutationObserver(() => { if (!box.isConnected) { stop(); obs.disconnect(); URL.revokeObjectURL(url); } });
  obs.observe(S.root, { childList: true });
}

/* ------------------------------------------------------------ qualité */
function showQuality() {
  const est = {};
  const cards = Object.entries(QUALITIES).map(([k, q]) => {
    const size = h('span', { class: 'scan-q-size' }, h('span', { class: 'spinner' }));
    const card = h('button', { class: 'scan-q', type: 'button', role: 'radio', 'aria-checked': S.quality === k, onclick: () => {
      S.quality = k; cards.forEach(c => c.el.setAttribute('aria-checked', c.k === k));
    } },
      h('span', { class: 'scan-q-dot' }),
      h('span', { class: 'scan-q-txt' }, h('b', {}, q.label), h('small', {}, q.hint), h('small', { class: 'dim' }, q.dpi)),
      size);
    return { k, el: card, size };
  });
  const isAppend = S.mode === 'append';
  frame('quality', {
    title: 'Qualité du PDF',
    left: iconBtn(I.back, 'Retour aux pages', () => showReview()),
    body: [h('p', { class: 'scan-lead' }, `${S.pages.length} page${S.pages.length > 1 ? 's' : ''} · choisissez le poids du fichier.`),
      h('div', { class: 'scan-qlist', role: 'radiogroup', 'aria-label': 'Qualité' }, cards.map(c => c.el))],
    foot: [btn(isAppend ? 'Ajouter les pages' : 'Créer le PDF', () => generate(), 'primary big', I.doc)],
  });
  // estimation : une page d'essai dans chaque qualité, multipliée par le nombre de pages
  (async () => {
    const sample = S.pages.find(p => p.ready);
    if (!sample) return;
    for (const c of cards) {
      try {
        const q = QUALITIES[c.k];
        const r = await work('render', { blob: sample.blob, srcW: sample.w, srcH: sample.h, quad: sample.quad, rot: sample.rot, filter: filterOf(sample), maxLong: q.long, q: q.q });
        if (!S || S.view !== 'quality') return;
        est[c.k] = r.blob.size * S.pages.length + 2000;
        c.size.textContent = '≈ ' + fmtSize(est[c.k]);
      } catch { c.size.textContent = ''; }
    }
  })();
}

/* ------------------------------------------------------------ fabrication du PDF */
const defaultName = () => {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `Scan ${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}h${p(d.getMinutes())}`;
};
async function generate() {
  const pages = S.pages.filter(p => p.ready);
  if (!pages.length) return;
  const q = QUALITIES[S.quality];
  const bar = h('div', {});
  const label = h('p', { class: 'scan-lead' }, 'Préparation…');
  frame('busy', { title: 'Création du PDF', left: h('span'), body: [h('div', { class: 'scan-busy' }, h('span', { class: 'spinner big' }), label, h('div', { class: 'progress' }, bar))] });
  try {
    const doc = await PDFLib.PDFDocument.create();
    const name = S.name || defaultName();
    doc.setTitle(name); doc.setProducer('Atelier PDF'); doc.setCreator('Atelier PDF — scanner'); doc.setCreationDate(new Date());
    for (let i = 0; i < pages.length; i++) {
      label.textContent = `Page ${i + 1} sur ${pages.length}…`;
      bar.style.width = Math.round(i / pages.length * 100) + '%';
      const p = pages[i];
      const r = await work('render', { blob: p.blob, srcW: p.w, srcH: p.h, quad: p.quad, rot: p.rot, filter: filterOf(p), maxLong: q.long, q: q.q });
      const img = await doc.embedJpg(new Uint8Array(await r.blob.arrayBuffer()));
      const [pw, ph] = pdfPageSize(r.w, r.h);
      doc.addPage([pw, ph]).drawImage(img, { x: 0, y: 0, width: pw, height: ph });
    }
    bar.style.width = '100%';
    const bytes = await doc.save();
    if (!S) return;
    S.result = { bytes, name, pages: pages.length, quality: S.quality };
    if (S.mode === 'append') {
      const file = new File([bytes], name + '.pdf', { type: 'application/pdf' });
      S.exported = true;
      const cb = S.onAppend;
      await closeScanner(true);
      cb && cb(file);
      return;
    }
    showDone();
  } catch (e) {
    console.error(e);
    toast('Le PDF n\'a pas pu être créé : ' + (e.message || e), { error: true, duration: 8000 });
    if (S) showQuality();
  }
}

/* ------------------------------------------------------------ PDF prêt : partager */
function showDone() {
  const R = S.result;
  const name = h('input', { class: 'input scan-name', value: R.name, 'aria-label': 'Nom du document', spellcheck: 'false' });
  const fileName = () => ((name.value.trim() || R.name).replace(/[\\/:*?"<>|]+/g, '-').replace(/\.pdf$/i, '')) + '.pdf';
  name.addEventListener('change', () => { S.name = name.value.trim() || R.name; });
  const blob = () => new Blob([R.bytes], { type: 'application/pdf' });
  const first = S.pages.find(p => p.thumb);
  const share = canShareFiles();
  const actions = [];
  if (share) actions.push(h('button', { class: 'scan-act primary', type: 'button', onclick: async () => {
    try { await shareBlob(blob(), fileName(), fileName().replace(/\.pdf$/i, '')); S.exported = true; }
    catch (e) { if (e?.name !== 'AbortError') toast('Le partage n\'a pas abouti.', { error: true }); }
  } }, svgIcon(I.share), h('span', {}, h('b', {}, 'Partager'), h('small', {}, 'WhatsApp, e-mail, Drive, Messages…'))));
  actions.push(h('button', { class: 'scan-act' + (share ? '' : ' primary'), type: 'button', onclick: async () => {
    try {
      if (isAndroidApp) { if (await saveBlob(blob(), fileName())) { S.exported = true; toast('PDF enregistré.'); } }
      else { downloadBlob(blob(), fileName()); S.exported = true; toast('PDF téléchargé.'); }
    } catch (e) { console.error(e); toast('L\'enregistrement n\'a pas abouti.', { error: true }); }
  } }, svgIcon(I.save), h('span', {}, h('b', {}, isAndroidApp ? 'Enregistrer sur le téléphone' : 'Télécharger'), h('small', {}, isAndroidApp ? 'Choisissez le dossier : Téléchargements, Documents, Drive…' : 'Dans le dossier des téléchargements'))));
  if (S.onEdit) actions.push(h('button', { class: 'scan-act', type: 'button', onclick: async () => {
    const file = new File([R.bytes], fileName(), { type: 'application/pdf' });
    const cb = S.onEdit; S.exported = true;
    await closeScanner(true);
    cb(file);
  } }, svgIcon(I.edit), h('span', {}, h('b', {}, 'Modifier, signer, annoter'), h('small', {}, 'Ouvre le PDF dans Atelier PDF'))));

  frame('done', {
    title: 'PDF prêt',
    right: [],
    body: h('div', { class: 'scan-done-body' },
      h('div', { class: 'scan-done-top' },
        first ? h('img', { class: 'scan-done-thumb', src: first.thumb, alt: '' }) : null,
        h('div', { class: 'scan-done-info' },
          h('label', { class: 'lbl' }, 'Nom du document'), name,
          h('p', { class: 'help' }, `${R.pages} page${R.pages > 1 ? 's' : ''} · ${fmtSize(R.bytes.length)} · qualité ${QUALITIES[R.quality].label.toLowerCase()}`))),
      h('div', { class: 'scan-acts' }, actions),
      h('div', { class: 'row scan-done-more' },
        btn('Changer la qualité', () => showQuality(), 'ghost'),
        btn('Nouveau scan', async () => {
          if (!S.exported) { const ok = await confirmDialog({ title: 'Nouveau scan', text: 'Ce PDF n\'a été ni partagé ni enregistré. Commencer un nouveau scan quand même ?', ok: 'Nouveau scan' }); if (!ok) return; }
          S.pages.forEach(p => p.thumb && URL.revokeObjectURL(p.thumb));
          S.pages = []; S.result = null; S.name = null; S.exported = false; showCamera();
        }, 'ghost', I.camera))),
  });
}
