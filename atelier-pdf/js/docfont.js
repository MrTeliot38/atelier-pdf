// Police du document pour un texte ajouté (Remplir, Texte) : celle du texte le plus proche,
// reconnue sur l'image pour un scan. Le texte ajouté se fond ainsi dans la page.
import { state, findObject, STD_FONTS } from './core.js';
import { getLines, hasOcr, runOcr, makeBlock } from './textdetect.js';
import { guessFont, MATCH_THRESHOLD, fontIdForGuess } from './fontmatch.js';
import { matchSystemFont } from './systemfonts.js';

const STD_NAME = /^(arial|helvetica|times|timesnewroman|courier|couriernew)/i;
const pending = new Map(); // page -> promesse de lecture du texte (scan)

/** Lignes de texte de la page ; pour un scan, la lecture est lancée une seule fois, en arrière-plan. */
async function pageLines(page) {
  const r = await getLines(page);
  if (r.kind !== 'none' || !page.src) return r;
  const key = page.src + '|' + page.index;
  if (!pending.has(key)) pending.set(key, runOcr(page, () => {}).catch(() => {}));
  await pending.get(key);
  return hasOcr(page) ? getLines(page) : r;
}

/** Ligne la plus proche du point (même rangée à gauche d'abord, puis au-dessus, puis en dessous). */
function nearest(lines, x, y) {
  let best = null, bd = Infinity;
  for (const l of lines) {
    if (!l.text || l.text.replace(/\s/g, '').length < 3) continue;
    const s = l.size || 10;
    const sameRow = y >= l.top - s * 0.6 && y <= l.bottom + s * 0.6;
    const dx = x < l.x ? l.x - x : x > l.x + l.w ? x - (l.x + l.w) : 0;
    const dy = sameRow ? 0 : y < l.top ? l.top - y : y - l.bottom;
    // la rangée compte plus que la distance horizontale ; une ligne au-dessus avant une ligne au-dessous
    const d = dy * 3 + dx * (sameRow ? 0.4 : 1) + (y < l.top ? s * 2 : 0);
    if (d < bd) { bd = d; best = l; }
  }
  return best;
}

async function styleOf(page, line) {
  const b = makeBlock([line]);
  if (!b.ocr && STD_FONTS[b.font]) {
    const base = (b.pdfName || '').replace(/^[A-Z]{6}\+/, '').replace(/[^a-z]/gi, '');
    if (!base || STD_NAME.test(base)) return { font: b.font, italic: !!b.italic };
    const sys = await matchSystemFont(b.pdfName);
    if (sys) return { font: sys, italic: !!b.italic };
  }
  const g = (await guessFont(page, b, { budgetMs: 2500 }))[0];
  if (!g || g.score < MATCH_THRESHOLD) return null;
  return { font: await fontIdForGuess(g), italic: g.italic };
}

/**
 * Donne au texte ajouté `id` la police du texte voisin (famille et italique ; le gras n'est pas repris,
 * une étiquette « Nom : » en gras ne doit pas mettre en gras ce qu'on écrit). Sans effet si l'on a déjà
 * choisi une police soi-même entre-temps.
 */
export async function adoptDocumentFont(page, id, x, y, apply) {
  if (!state.autoFont) return;
  try {
    const { lines } = await pageLines(page);
    if (!lines?.length) return;
    const line = nearest(lines, x, y);
    if (!line) return;
    const st = await styleOf(page, line);
    const f = findObject(id);
    if (!st || !f || f.obj.fontManual || f.obj.font !== state.textDefaults.font) return;
    apply({ font: st.font, italic: st.italic, autoFont: true });
  } catch (e) { console.warn('Police du document', e); }
}
