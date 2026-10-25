// Polices installées sur l'ordinateur
//  - application Windows : lecture directe des dossiers de polices (aucune autorisation à donner)
//  - navigateur Chrome / Edge : API « Local Font Access » (le navigateur demande l'autorisation une fois)
import { state, registerFontFamily } from './core.js';
import { facesFromBytes, extractFromCollection } from './fontnames.js';

const desktop = window.atelierDesktop;
let families = null;          // [{ name, faces: [...] }]
let loading = null;
const loaded = new Map();     // nom de famille -> id de police

export const systemFontsSupported = () => !!desktop || 'queryLocalFonts' in window;
export const isDesktop = () => !!desktop;

/** Autorisation déjà donnée ? (toujours vrai dans l'application Windows) */
export async function systemFontsGranted() {
  if (desktop) return true;
  if (!('queryLocalFonts' in window)) return false;
  try { return (await navigator.permissions.query({ name: 'local-fonts' })).state === 'granted'; } catch { return false; }
}

const weightOf = style => {
  const s = style.toLowerCase();
  if (/thin|hairline/.test(s)) return 100; if (/extra ?light|ultra ?light/.test(s)) return 200; if (/light/.test(s)) return 300;
  if (/medium/.test(s)) return 500; if (/semi ?bold|demi/.test(s)) return 600; if (/extra ?bold|ultra ?bold/.test(s)) return 800;
  if (/black|heavy/.test(s)) return 900; if (/bold/.test(s)) return 700; return 400;
};

/** Liste des familles de polices installées, triées par nom. */
export function listSystemFonts() {
  if (families) return Promise.resolve(families);
  if (loading) return loading;
  loading = (async () => {
    let faces;
    if (desktop) faces = await desktop.listFonts();
    else {
      const data = await window.queryLocalFonts();
      faces = data.map(f => ({ family: f.family, style: f.style, full: f.fullName, ps: f.postscriptName, weight: weightOf(f.style), italic: /italic|oblique/i.test(f.style), ref: f }));
    }
    const map = new Map();
    for (const f of faces) {
      if (!f.family || f.family.startsWith('@') || f.family.startsWith('.')) continue;
      if (!map.has(f.family)) map.set(f.family, []);
      map.get(f.family).push(f);
    }
    families = [...map].map(([name, fs]) => ({ name, faces: fs })).sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
    return families;
  })().catch(e => { loading = null; throw e; });
  return loading;
}

/** Choisit regular / gras / italique / gras italique dans une famille. */
function pickVariants(faces) {
  const best = (italic, target) => {
    const c = faces.filter(f => !!f.italic === italic);
    if (!c.length) return null;
    return c.reduce((a, b) => Math.abs(b.weight - target) < Math.abs(a.weight - target) ? b : a);
  };
  const r = best(false, 400) || best(true, 400);
  const b = best(false, 700), i = best(true, 400), bi = best(true, 700);
  const out = { r };
  if (b && b !== r && b.weight >= 600) out.b = b;
  if (i && i !== r && i.weight < 600) out.i = i;
  if (bi && bi !== i && bi.weight >= 600) out.bi = bi;
  return out;
}

async function faceBytes(face) {
  let bytes;
  if (desktop) bytes = new Uint8Array(await desktop.readFont(face.path));
  else bytes = new Uint8Array(await (await face.ref.blob()).arrayBuffer());
  if (bytes[0] === 0x74 && bytes[1] === 0x74 && bytes[2] === 0x63 && bytes[3] === 0x66) { // collection .ttc
    let index = face.index ?? 0;
    if (!desktop) { const all = facesFromBytes(bytes); const m = all.find(f => f.ps === face.ps); index = m ? m.index : 0; }
    bytes = extractFromCollection(bytes, index);
  }
  return bytes;
}

/** Charge une famille installée et la rend utilisable ; renvoie l'id de police. */
export async function loadSystemFamily(name) {
  if (loaded.has(name)) return loaded.get(name);
  const fam = (await listSystemFonts()).find(f => f.name === name);
  if (!fam) throw new Error('Police introuvable : ' + name);
  const picks = pickVariants(fam.faces);
  const variants = {};
  for (const [vk, face] of Object.entries(picks)) {
    try { variants[vk] = await faceBytes(face); } catch (e) { console.warn(e); }
  }
  const id = await registerFontFamily(name, variants, 'system');
  loaded.set(name, id);
  return id;
}

/** Cherche sur l'ordinateur la police utilisée dans le PDF (ex. « ABCDEF+Montserrat-Bold » → Montserrat). */
export async function matchSystemFont(pdfName) {
  if (!pdfName || !systemFontsSupported() || !(await systemFontsGranted())) return null;
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const raw = pdfName.replace(/^[A-Z]{6}\+/, '');
  const base = norm(raw.split(/[-,]/)[0].replace(/(MT|PS|Std|Pro|LT)$/,''));
  if (!base || base.length < 3) return null;
  let fams;
  try { fams = await listSystemFonts(); } catch { return null; }
  const full = norm(raw);
  let hit = fams.find(f => f.faces.some(x => norm(x.ps || '') === full));
  if (!hit) hit = fams.find(f => norm(f.name) === base);
  if (!hit) hit = fams.find(f => base.startsWith(norm(f.name)) && norm(f.name).length >= 4);
  if (!hit) return null;
  // Les polices standard PDF restent prioritaires pour Arial/Helvetica/Times/Courier (rendu identique, fichier plus léger)
  if (/^(arial|helvetica|times|timesnewroman|courier|couriernew)$/.test(norm(hit.name))) return null;
  try { return await loadSystemFamily(hit.name); } catch { return null; }
}

export const fontLoadedFor = name => loaded.get(name);
export { state };
