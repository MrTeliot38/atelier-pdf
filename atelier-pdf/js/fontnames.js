// Lecture des informations d'un fichier de police (.ttf, .otf, .ttc) sans bibliothèque :
// nom de famille, style, graisse, italique. Utilisé dans le navigateur et par l'application Windows.

const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const tag = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const SFNT = new Set([0x00010000, 0x4f54544f /* OTTO */, 0x74727565 /* true */]);

/** read(offset, length) -> Uint8Array ; renvoie la liste des polices du fichier. */
export function readFontFaces(read) {
  const head = read(0, 12);
  if (head.length < 12) return [];
  if (tag(head, 0) === 'ttcf') {
    const n = Math.min(u32(head, 8), 64);
    const offs = read(12, 4 * n);
    const out = [];
    for (let i = 0; i < n; i++) { const f = parseFace(read, u32(offs, 4 * i), i); if (f) out.push(f); }
    return out;
  }
  const f = parseFace(read, 0, 0);
  return f ? [f] : [];
}
export const facesFromBytes = bytes => readFontFaces((o, l) => bytes.subarray(o, o + l));

function parseFace(read, off, index) {
  const h = read(off, 12);
  if (h.length < 12 || !SFNT.has(u32(h, 0))) return null;
  const n = u16(h, 4);
  const dir = read(off + 12, 16 * n);
  const tables = {};
  for (let i = 0; i < n; i++) tables[tag(dir, i * 16)] = { offset: u32(dir, i * 16 + 8), length: u32(dir, i * 16 + 12) };
  if (!tables.name || !(tables.glyf || tables['CFF '] || tables.CFF2)) return null;
  const names = parseNames(read(tables.name.offset, tables.name.length));
  let weight = 400, italic = false, bold = false;
  if (tables['OS/2'] && tables['OS/2'].length >= 64) {
    const os2 = read(tables['OS/2'].offset, 64);
    weight = u16(os2, 4) || 400;
    const fsSel = u16(os2, 62);
    italic = !!(fsSel & 1); bold = !!(fsSel & 32);
  }
  const family = (names[16] || names[1] || '').trim();
  const style = (names[17] || names[2] || 'Regular').trim();
  if (!family) return null;
  if (/italic|oblique/i.test(style)) italic = true;
  if (bold && weight < 600) weight = 700;
  return { family, style, full: names[4] || family + ' ' + style, ps: names[6] || '', weight, italic, index, cff: !!(tables['CFF '] || tables.CFF2), variable: !!tables.fvar };
}

function parseNames(b) {
  const count = u16(b, 2), strOff = u16(b, 4);
  const best = {}, score = {};
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    if (r + 12 > b.length) break;
    const pid = u16(b, r), eid = u16(b, r + 2), lang = u16(b, r + 4), id = u16(b, r + 6), len = u16(b, r + 8), off = u16(b, r + 10);
    if (![1, 2, 4, 6, 16, 17].includes(id)) continue;
    let s = 0;
    if (pid === 3 && (eid === 1 || eid === 10)) s = lang === 0x409 ? 4 : lang === 0x40c ? 3.5 : 3;
    else if (pid === 0) s = 2;
    else if (pid === 1 && eid === 0 && lang === 0) s = 1;
    if (!s || (score[id] || 0) >= s) continue;
    const start = strOff + off;
    if (start + len > b.length) continue;
    let str = '';
    if (pid === 1) for (let k = 0; k < len; k++) str += String.fromCharCode(b[start + k]);
    else for (let k = 0; k + 1 < len; k += 2) str += String.fromCharCode(u16(b, start + k));
    best[id] = str.replace(/\0/g, ''); score[id] = s;
  }
  return best;
}

/** Extrait la police n° index d'une collection .ttc en fichier autonome (les PDF n'acceptent pas les collections). */
export function extractFromCollection(bytes, index) {
  if (tag(bytes, 0) !== 'ttcf') return bytes;
  const off = u32(bytes, 12 + 4 * index);
  const n = u16(bytes, off + 4);
  const recs = [];
  for (let i = 0; i < n; i++) {
    const r = off + 12 + i * 16;
    recs.push({ tag: bytes.subarray(r, r + 4), sum: bytes.subarray(r + 4, r + 8), offset: u32(bytes, r + 8), length: u32(bytes, r + 12) });
  }
  let size = 12 + 16 * n;
  for (const t of recs) size += (t.length + 3) & ~3;
  const out = new Uint8Array(size);
  out.set(bytes.subarray(off, off + 12), 0);
  let pos = 12 + 16 * n;
  recs.forEach((t, i) => {
    const r = 12 + i * 16;
    out.set(t.tag, r); out.set(t.sum, r + 4);
    out[r + 8] = pos >>> 24; out[r + 9] = (pos >>> 16) & 255; out[r + 10] = (pos >>> 8) & 255; out[r + 11] = pos & 255;
    out[r + 12] = t.length >>> 24; out[r + 13] = (t.length >>> 16) & 255; out[r + 14] = (t.length >>> 8) & 255; out[r + 15] = t.length & 255;
    out.set(bytes.subarray(t.offset, t.offset + t.length), pos);
    pos += (t.length + 3) & ~3;
  });
  return out;
}
