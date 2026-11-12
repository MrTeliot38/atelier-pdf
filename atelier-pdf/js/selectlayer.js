// Mode Sélection (lecture) : le texte du document se sélectionne et se copie (appui long au doigt,
// glisser à la souris), et les liens du document s'ouvrent d'un clic.
import { state, on, h, toast, pdfjsLib } from './core.js';
import { slots, scrollToPage } from './viewer.js';

const cap = window.Capacitor;
const native = cap?.isNativePlatform?.() && cap.getPlatform?.() === 'android' ? cap.Plugins?.AtelierNative : null;
const SAFE = /^(https?:|mailto:|tel:)/i;
const near = new Set();
const done = new Map(); // id de page -> clé du rendu (source|index|nombre d'objets masquants)

const active = () => state.tool === 'select';

/* ------------------------------------------------ ouverture d'un lien */
export function openLink(url) {
  if (!SAFE.test(url)) return;
  if (native?.openLink) { native.openLink({ url }).catch(() => toast('Aucune application pour ouvrir ce lien.', { error: true })); return; }
  // Windows : la fenêtre transmet le lien au navigateur ; navigateur web : nouvel onglet
  const a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  document.body.append(a); a.click(); a.remove();
}

async function goTo(src, dest) {
  try {
    const pdf = src.pdf;
    const d = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(d)) return;
    const idx = typeof d[0] === 'number' ? d[0] : await pdf.getPageIndex(d[0]);
    const p = state.pages.find(x => x.src === src.id && x.index === idx);
    if (p) scrollToPage(p.id); else toast('Cette page n\'est plus dans le document.');
  } catch { /* destination invalide */ }
}

/* ------------------------------------------------ zones masquées (texte corrigé, caviardé, masqué) */
function hiddenZones(page) {
  const z = [];
  for (const o of page.objects) {
    if (o.cover) z.push(o.cover);
    if (o.type === 'redact' || o.type === 'rect') z.push(o);
  }
  return z;
}
const inZones = (zones, x, y) => zones.some(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);

/* ------------------------------------------------ adresses écrites en clair dans le texte */
const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"'()]+[^\s<>"'().,;:!?]|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/gi;
function textLinks(items, vp) {
  const out = [];
  for (const it of items) {
    if (!it.str || !it.width) continue;
    URL_RE.lastIndex = 0;
    let m;
    while ((m = URL_RE.exec(it.str))) {
      const raw = m[1];
      const url = /@/.test(raw) && !/^(https?:|www\.)/i.test(raw) ? 'mailto:' + raw : /^www\./i.test(raw) ? 'https://' + raw : raw;
      // position approchée : proportionnelle au nombre de caractères
      const n = it.str.length, t = it.transform;
      const x0 = t[4] + it.width * (m.index / n), x1 = t[4] + it.width * ((m.index + raw.length) / n);
      const hgt = it.height || Math.hypot(t[2], t[3]) || 10;
      const [ax, ay] = vp.convertToViewportPoint(x0, t[5] - hgt * 0.22), [bx, by] = vp.convertToViewportPoint(x1, t[5] + hgt * 0.9);
      out.push({ url, x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) });
    }
  }
  return out;
}

/* ------------------------------------------------ calque d'une page */
async function build(id) {
  const s = slots.get(id); if (!s) return;
  const page = s.page;
  let layer = s.pageEl.querySelector(':scope > .sel-layer');
  if (!active() || !page.src) { layer?.remove(); done.delete(id); return; }
  const zones = hiddenZones(page);
  const key = page.src + '|' + page.index + '|' + JSON.stringify(zones.map(r => [r.x | 0, r.y | 0, r.w | 0, r.h | 0]));
  setScale(s);
  if (layer && done.get(id) === key) return;
  done.set(id, key);
  const src = state.sources.get(page.src);
  const pdfPage = await src.pdf.getPage(page.index + 1);
  const vp = pdfPage.getViewport({ scale: 1 });
  const text = h('div', { class: 'textLayer' });
  const links = h('div', { class: 'link-layer' });
  const fresh = h('div', { class: 'layer sel-layer' }, text, links);
  // texte sélectionnable (calque transparent de pdf.js, aligné sur le rendu)
  let items = [];
  try {
    const content = await pdfPage.getTextContent();
    items = content.items;
    const tl = new pdfjsLib.TextLayer({ textContentSource: content, container: text, viewport: vp });
    await tl.render();
    // un texte corrigé ou caviardé ne doit plus pouvoir être copié
    if (zones.length) for (const sp of text.querySelectorAll('span')) {
      const l = parseFloat(sp.style.left), t = parseFloat(sp.style.top);
      if (!isNaN(l) && !isNaN(t) && inZones(zones, l / 100 * vp.width + 1, t / 100 * vp.height + 2)) sp.remove();
    }
  } catch (e) { console.warn('Texte sélectionnable', e); }
  if (done.get(id) !== key || !active()) return;
  // liens du document (annotations) + adresses écrites en clair
  const rects = [];
  try {
    for (const a of await pdfPage.getAnnotations({ intent: 'display' })) {
      if (a.subtype !== 'Link' || (!a.url && !a.unsafeUrl && a.dest == null)) continue;
      const [ax, ay] = vp.convertToViewportPoint(a.rect[0], a.rect[1]), [bx, by] = vp.convertToViewportPoint(a.rect[2], a.rect[3]);
      const url = a.url || (a.unsafeUrl && SAFE.test(a.unsafeUrl) ? a.unsafeUrl : null);
      if (!url && a.dest == null) continue;
      rects.push({ url, dest: a.dest, x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) });
    }
  } catch { /* annotations illisibles */ }
  for (const t of textLinks(items, vp)) {
    const cx = t.x + t.w / 2, cy = t.y + t.h / 2;
    if (!rects.some(r => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h)) rects.push(t);
  }
  for (const r of rects) {
    if (r.w < 2 || r.h < 2 || inZones(zones, r.x + r.w / 2, r.y + r.h / 2)) continue;
    const label = r.url ? r.url.replace(/^mailto:/i, '') : 'Aller à la page';
    const el = h('a', { class: 'pdf-link', href: r.url || '#', title: label, 'aria-label': 'Lien : ' + label, rel: 'noopener noreferrer' });
    Object.assign(el.style, { left: r.x / vp.width * 100 + '%', top: r.y / vp.height * 100 + '%', width: r.w / vp.width * 100 + '%', height: r.h / vp.height * 100 + '%' });
    // pas d'ouverture si le doigt (ou la souris) a glissé : c'était une sélection de texte
    let down = null;
    el.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
    el.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 8) return;
      if (r.url) openLink(r.url); else goTo(src, r.dest);
    });
    links.append(el);
  }
  layer = s.pageEl.querySelector(':scope > .sel-layer');
  if (layer) layer.replaceWith(fresh); else s.pageEl.append(fresh);
}
function setScale(s) {
  const z = state.zoom;
  s.pageEl.style.setProperty('--scale-factor', z);
  s.pageEl.style.setProperty('--total-scale-factor', z);
}

function refreshAll() {
  for (const id of near) build(id);
  if (!active()) for (const s of slots.values()) { s.pageEl.querySelector(':scope > .sel-layer')?.remove(); done.delete(s.page.id); }
}

export function initSelectLayer() {
  on('page-near', id => { near.add(id); build(id); });
  on('tool', refreshAll);
  on('zoom', () => { for (const s of slots.values()) setScale(s); });
  on('pages-changed', () => { for (const id of [...near]) if (!slots.has(id)) near.delete(id); refreshAll(); });
  on('objects-changed', id => { if (id && near.has(id)) build(id); else refreshAll(); });
  on('doc-closed', () => { near.clear(); done.clear(); });
  // Ctrl+C sans sélection : rien ; avec : copie du texte sélectionné (comportement du navigateur)
}
