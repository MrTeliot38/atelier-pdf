// Atelier PDF — état partagé, historique, polices, utilitaires
import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';

export const pdfjsLib = pdfjs;
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
export const PDFLib = window.PDFLib;
export const fontkit = window.fontkit;

export const PDFJS_OPTS = {
  cMapUrl: new URL('../vendor/pdfjs/cmaps/', import.meta.url).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('../vendor/pdfjs/standard_fonts/', import.meta.url).href,
  fontExtraProperties: true,
  isEvalSupported: false,
};

/* ------------------------------------------------------------------ état */
export const state = {
  docName: '',
  sources: new Map(),   // id -> { id, name, bytes, pdf (pdf.js), views[], raster:boolean, fields[] }
  pages: [],            // [{ id, src, index, w, h, rot, objects: [] }]
  assets: new Map(),    // id -> { id, dataUrl, mime, w, h }
  fonts: new Map(),     // polices importées : id -> { id, name, family, bytes }
  formValues: {},       // "src|nomDuChamp" -> valeur
  formOriginal: {},
  tool: 'select',
  selected: null,       // id d'objet sélectionné
  editing: null,        // id d'objet texte en cours de saisie
  selectedPages: new Set(),
  currentPage: null,
  zoom: 1,
  dirty: false,
  textMode: 'paragraph',
  markKind: 'check',
  // annotations : forme choisie, couleur, épaisseur, texte du tampon
  annot: { kind: 'arrow', color: '#c2362f', width: 2.5, stamp: 'LU ET APPROUVÉ' },
  pendingSignature: null, // { asset, w, h, target? }
  textDefaults: { font: 'helvetica', size: 11, color: '#111111', bold: false, italic: false, align: 'left', lineHeight: 1.2 },
};

/* ------------------------------------------------------------ événements */
const bus = new EventTarget();
export const on = (type, fn) => bus.addEventListener(type, e => fn(e.detail));
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));

/* -------------------------------------------------------------- outils */
let _n = 0;
export const uid = (p = 'o') => p + Date.now().toString(36) + (++_n).toString(36);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? (k.startsWith('aria-') ? 'true' : '') : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}
export const svgIcon = (inner, vb = '0 0 24 24') => {
  const t = document.createElement('template');
  t.innerHTML = `<svg viewBox="${vb}" aria-hidden="true">${inner}</svg>`;
  return t.content.firstChild;
};
export const ICONS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  rotl: '<path d="M4 4v6h6"/><path d="M4.5 10A8 8 0 1 1 6 16.5"/>',
  rotr: '<path d="M20 4v6h-6"/><path d="M19.5 10A8 8 0 1 0 18 16.5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  alignL: '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>',
  alignC: '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>',
  alignR: '<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>',
  restore: '<path d="M4 4v6h6"/><path d="M4.5 10A8 8 0 1 1 6 16.5"/>',
  swap: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 14l3-3 2 2 3-3"/><path d="M16 4v4h4"/>',
  pages: '<rect x="4" y="3" width="12" height="16" rx="1.5"/><path d="M8 21h11a1 1 0 0 0 1-1V7"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M8 9h8M8 12h8M8 15h5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  font: '<path d="M4 20L10 4h1l6 16M6.5 14h8"/><path d="M17 20h4"/>',
  pipette: '<path d="M14 4l6 6M17 3l4 4-3 3-4-4z"/><path d="M14 6l-9 9v4h4l9-9"/>',
};

export function fmtPages(n) { return n + (n > 1 ? ' pages' : ' page'); }
export function baseName(name) { return (name || 'document').replace(/\.(pdf|png|jpe?g|webp)$/i, ''); }

export function downloadBlob(blob, filename) {
  // application Android : Android demande où enregistrer ; renvoie une promesse (true si enregistré)
  if (window.__atelierSave) return window.__atelierSave(blob, filename);
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
export function rgbToHex(r, g, b) { return '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join(''); }
export function pdfColor(hex) { const { r, g, b } = hexToRgb(hex); return PDFLib.rgb(r / 255, g / 255, b / 255); }

/* --------------------------------------------------------- toasts */
export function toast(msg, opts = {}) {
  const root = $('#toasts');
  const el = h('div', { class: 'toast' + (opts.error ? ' error' : ''), role: opts.error ? 'alert' : 'status' }, h('span', {}, msg));
  if (opts.action) el.append(h('button', { onclick: () => { opts.action.fn(); el.remove(); } }, opts.action.label));
  root.append(el);
  setTimeout(() => el.remove(), opts.duration || (opts.action ? 6000 : 3200));
  return el;
}

/* --------------------------------------------------------- historique */
const undoStack = [], redoStack = [];
let current = null;
// la hauteur d'un texte se recalcule à l'affichage : elle ne doit pas créer d'étapes « fantômes » dans l'historique
function snapReplacer(key, value) { return key === 'h' && this && this.type === 'text' ? undefined : value; }
const snapshot = () => JSON.stringify({ pages: state.pages, formValues: state.formValues }, snapReplacer);

export function resetHistory() {
  undoStack.length = 0; redoStack.length = 0; current = snapshot(); state.dirty = false; emit('history');
}
export function commit() {
  const snap = snapshot();
  if (snap === current) return;
  if (current) undoStack.push(current);
  if (undoStack.length > 80) undoStack.shift();
  current = snap; redoStack.length = 0; state.dirty = true;
  emit('history');
}
function restore(snap) {
  const o = JSON.parse(snap);
  const prevOrder = state.pages.map(p => p.id + ':' + p.rot).join();
  state.pages = o.pages; state.formValues = o.formValues;
  current = snap;
  if (state.selected && !findObject(state.selected)) state.selected = null;
  state.editing = null;
  for (const id of [...state.selectedPages]) if (!state.pages.some(p => p.id === id)) state.selectedPages.delete(id);
  const order = state.pages.map(p => p.id + ':' + p.rot).join();
  emit(order === prevOrder ? 'objects-changed' : 'pages-changed');
  emit('forms-changed'); emit('selection'); emit('history'); emit('restored');
}
export function undo() { if (!undoStack.length) return; redoStack.push(current); restore(undoStack.pop()); state.dirty = true; }
export function redo() { if (!redoStack.length) return; undoStack.push(current); restore(redoStack.pop()); state.dirty = true; }
export const canUndo = () => undoStack.length > 0;
/** Onglets : chaque document garde son propre historique d'annulation. */
export function exportHistory() { return { undo: undoStack.slice(), redo: redoStack.slice(), current }; }
export function importHistory(hist) {
  undoStack.length = 0; redoStack.length = 0;
  if (hist) { undoStack.push(...hist.undo); redoStack.push(...hist.redo); current = hist.current; }
  else current = snapshot();
  emit('history');
}
export const canRedo = () => redoStack.length > 0;

/* --------------------------------------------------------- recherche */
export function findObject(id) {
  for (const p of state.pages) { const o = p.objects.find(x => x.id === id); if (o) return { page: p, obj: o }; }
  return null;
}
export const pageById = id => state.pages.find(p => p.id === id);

/* --------------------------------------------------------- polices
   Les polices standard PDF (Helvetica, Times, Courier) sont affichées avec
   leurs équivalents métriques (Arial, Times New Roman, Courier New) :
   le découpage des lignes est identique à l'écran et dans le PDF. */
export const STD_FONTS = {
  helvetica: { label: 'Arial', css: 'Arial, Helvetica, "Liberation Sans", "Arimo", sans-serif',
    v: { r: 'Helvetica', b: 'Helvetica-Bold', i: 'Helvetica-Oblique', bi: 'Helvetica-BoldOblique' } },
  times: { label: 'Times New Roman', css: '"Times New Roman", Times, "Liberation Serif", "Tinos", serif',
    v: { r: 'Times-Roman', b: 'Times-Bold', i: 'Times-Italic', bi: 'Times-BoldItalic' } },
  courier: { label: 'Courier New', css: '"Courier New", Courier, "Liberation Mono", "Cousine", monospace',
    v: { r: 'Courier', b: 'Courier-Bold', i: 'Courier-Oblique', bi: 'Courier-BoldOblique' } },
};
export const ASC = 0.78; // position de la ligne de base dans une ligne (fraction de la taille)

const metric = { doc: null, fonts: new Map(), charsets: new Map() };
export async function initFonts() {
  metric.doc = await PDFLib.PDFDocument.create();
  metric.doc.registerFontkit(fontkit);
  for (const [key, f] of Object.entries(STD_FONTS)) {
    for (const [vk, name] of Object.entries(f.v)) metric.fonts.set(key + ':' + vk, await metric.doc.embedFont(name));
  }
}
export const variantKey = o => (o.bold && o.italic) ? 'bi' : o.bold ? 'b' : o.italic ? 'i' : 'r';
const FALLBACK = { r: ['r', 'b', 'i', 'bi'], b: ['b', 'r'], i: ['i', 'r'], bi: ['bi', 'b', 'i', 'r'] };
/** Variante réellement disponible d'une police ajoutée (le gras ou l'italique peuvent manquer). */
export function customVariant(o) {
  const f = state.fonts.get(o.font); if (!f) return null;
  return FALLBACK[variantKey(o)].find(k => f.variants[k]) || Object.keys(f.variants)[0];
}
export function hasVariant(fontId, vk) {
  if (STD_FONTS[fontId]) return true;
  const f = state.fonts.get(fontId); return !!(f && f.variants[vk]);
}
export function metricFont(o) {
  if (STD_FONTS[o.font]) return metric.fonts.get(o.font + ':' + variantKey(o));
  const vk = customVariant(o);
  return (vk && metric.fonts.get('custom:' + o.font + ':' + vk)) || metric.fonts.get('helvetica:r');
}
export function cssFamily(o) {
  if (STD_FONTS[o.font]) return STD_FONTS[o.font].css;
  const f = state.fonts.get(o.font);
  return f ? `"${f.family}", Arial, sans-serif` : STD_FONTS.helvetica.css;
}
/** Graisse et style CSS cohérents avec la variante utilisée dans le PDF. */
export function cssWeightStyle(o) {
  if (STD_FONTS[o.font] || !state.fonts.get(o.font)) return { weight: o.bold ? 700 : 400, style: o.italic ? 'italic' : 'normal' };
  const vk = customVariant(o);
  return { weight: vk.includes('b') ? 700 : 400, style: vk.includes('i') ? 'italic' : 'normal' };
}
/** Enregistre une famille de polices : variants = { r, b, i, bi } (octets des fichiers). */
export async function registerFontFamily(name, variants, source = 'import') {
  const first = variants.r || variants.b || variants.i || variants.bi;
  const id = 'f' + Math.abs(hashBytes(first) ^ hashStr(name)).toString(36);
  if (state.fonts.has(id)) return id;
  const family = 'AtelierFont-' + id;
  const entry = { id, name, family, source, variants: {} };
  for (const [vk, bytes] of Object.entries(variants)) {
    if (!bytes) continue;
    let pf;
    try { pf = await metric.doc.embedFont(bytes, { subset: false }); }
    catch (e) { console.warn('Police illisible', name, vk, e); continue; }
    const face = new FontFace(family, bytes, { weight: vk.includes('b') ? '700' : '400', style: vk.includes('i') ? 'italic' : 'normal' });
    await face.load(); document.fonts.add(face);
    metric.fonts.set('custom:' + id + ':' + vk, pf);
    entry.variants[vk] = bytes;
  }
  if (!Object.keys(entry.variants).length) throw new Error('Police illisible');
  state.fonts.set(id, entry);
  return id;
}
export const registerCustomFont = (name, bytes) => registerFontFamily(name, { r: bytes }, 'import');
function hashStr(s) { let x = 0; for (const c of s) x = (x * 31 + c.charCodeAt(0)) | 0; return x; }
function hashBytes(bytes) {
  let hsh = 0; const step = Math.max(1, Math.floor(bytes.length / 4096));
  for (let i = 0; i < bytes.length; i += step) hsh = (hsh * 31 + bytes[i]) | 0;
  return hsh ^ bytes.length;
}

function charset(font) {
  let s = metric.charsets.get(font);
  if (!s) { s = new Set(font.getCharacterSet()); metric.charsets.set(font, s); }
  return s;
}
const SUBST = { ' ': ' ', ' ': ' ', ' ': ' ', '​': '', '﻿': '', '\t': '    ', '−': '-', '‐': '-', '‑': '-', '­': '' };
/** Remplace les caractères que la police ne sait pas dessiner. */
export function sanitize(text, font) {
  const cs = charset(font);
  let out = '';
  for (const ch of text) {
    if (ch === '\n') { out += ch; continue; }
    let c = ch;
    if (!cs.has(c.codePointAt(0))) c = SUBST[ch] ?? c;
    if (c && !cs.has(c.codePointAt(0))) {
      if (c === ' ') c = ' ';
      else c = c.normalize('NFD').replace(/[̀-ͯ]/g, '');
      if (!c || !cs.has(c.codePointAt(0))) c = c ? '?' : '';
    }
    out += c;
  }
  return out;
}

/** Découpe un texte en lignes selon la largeur de la boîte. */
export function layoutText(o) {
  const font = metricFont(o);
  const size = o.size, maxW = Math.max(4, o.w);
  const text = sanitize(o.text || '', font);
  const width = s => font.widthOfTextAtSize(s, size);
  const lines = [];
  for (const para of text.split('\n')) {
    if (para === '') { lines.push(''); continue; }
    const tokens = para.match(/\S+|\s+/g) || [];
    let line = '';
    for (const tok of tokens) {
      const test = line + tok;
      if (width(test.trimEnd()) <= maxW || line.trim() === '') {
        if (width(test.trimEnd()) > maxW && line.trim() === '' && /\S/.test(tok)) {
          // mot trop long : coupe caractère par caractère
          let part = line;
          for (const ch of tok) {
            if (width(part + ch) > maxW && part.trim()) { lines.push(part.trimEnd()); part = ''; }
            part += ch;
          }
          line = part;
        } else line = test;
      } else {
        lines.push(line.trimEnd());
        line = /\s/.test(tok[0]) ? '' : tok;
      }
    }
    lines.push(line.trimEnd());
  }
  return { lines, font, widths: lines.map(width) };
}
export function textBoxHeight(o, nLines) { return Math.max(1, nLines) * o.size * o.lineHeight; }

/* --------------------------------------------------------- matrices */
export const mul = (m1, m2) => [ // applique m2 puis m1
  m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
];
export function inv(m) {
  const d = m[0] * m[3] - m[1] * m[2];
  return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d];
}

/* --------------------------------------------------------- divers */
export function loadScript(src) {
  return new Promise((res, rej) => {
    const s = h('script', { src }); s.onload = res; s.onerror = () => rej(new Error('Chargement impossible : ' + src));
    document.head.append(s);
  });
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const raf = () => new Promise(r => requestAnimationFrame(r));
export function todayFr() { return new Date().toLocaleDateString('fr-FR'); }
