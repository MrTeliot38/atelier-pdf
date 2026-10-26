// Chargement des PDF et des images, création des pages
import { state, pdfjsLib, PDFJS_OPTS, PDFLib, uid, emit, commit, resetHistory, toast, baseName } from './core.js';
import { promptDialog } from './ui.js';

const A4 = [595.28, 841.89];

async function readFile(file) { return new Uint8Array(await file.arrayBuffer()); }

/** Charge un PDF comme « source » et renvoie la liste de nouvelles pages. */
export async function loadPdfSource(bytes, name) {
  let password;
  let pdf, task;
  for (;;) {
    try {
      task = pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes.slice(), password });
      pdf = await task.promise;
      break;
    } catch (e) {
      if (e && e.name === 'PasswordException') {
        password = await promptDialog({ title: 'Document protégé', label: `« ${name} » est protégé par un mot de passe.`, type: 'password', ok: 'Ouvrir' });
        if (password == null) throw new Error('cancelled');
        continue;
      }
      throw e;
    }
  }
  const id = uid('s');
  const views = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    views.push({ w: vp.width, h: vp.height, transform: vp.transform, rotate: page.rotate });
  }
  // pdf-lib saura-t-il réécrire ce fichier ? Sinon on passera par une image.
  let raster = !!password;
  if (!raster) {
    try { await PDFLib.PDFDocument.load(bytes, { updateMetadata: false }); }
    catch (e) { raster = true; }
  }
  const src = { id, name, bytes, pdf, task, views, raster, fields: null };
  state.sources.set(id, src);
  await loadFormFields(src);
  if (raster) toast('Ce PDF est protégé ou inhabituel : l\'export se fera en haute résolution image.', { duration: 6000 });
  return views.map((v, i) => ({ id: uid('p'), src: id, index: i, w: v.w, h: v.h, rot: 0, objects: [] }));
}

async function loadFormFields(src) {
  src.fields = [];
  for (let i = 0; i < src.views.length; i++) {
    const page = await src.pdf.getPage(i + 1);
    let annots = [];
    try { annots = await page.getAnnotations({ intent: 'display' }); } catch {}
    const vp = page.getViewport({ scale: 1 });
    for (const a of annots) {
      if (a.subtype !== 'Widget' || !a.fieldName || a.hidden) continue;
      const kind = a.fieldType === 'Tx' ? 'text'
        : a.fieldType === 'Btn' ? (a.pushButton ? null : a.radioButton ? 'radio' : 'checkbox')
        : a.fieldType === 'Ch' ? 'choice' : a.fieldType === 'Sig' ? 'sig' : null;
      if (!kind) continue;
      const t = vp.transform, P = (x, y) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
      const [ax, ay] = P(a.rect[0], a.rect[1]), [bx, by] = P(a.rect[2], a.rect[3]);
      const rect = { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
      const key = src.id + '|' + a.fieldName;
      const f = { key, index: i, kind, rect, name: a.fieldName, readOnly: !!a.readOnly, multiline: !!a.multiLine, maxLen: a.maxLen || 0,
        exportValue: a.exportValue, buttonValue: a.buttonValue, options: a.options || [], comb: !!a.comb, align: a.textAlignment || 0,
        fontSize: a.defaultAppearanceData?.fontSize || 0 };
      if (!(key in state.formOriginal)) {
        let v = a.fieldValue;
        if (kind === 'checkbox') v = v != null && v !== 'Off' && (a.exportValue ? v === a.exportValue : true);
        if (kind === 'radio') v = (v && v !== 'Off') ? v : null;
        if (kind === 'choice' && Array.isArray(v)) v = v[0] ?? '';
        if (kind === 'text') v = v ?? '';
        state.formOriginal[key] = v;
      }
      src.fields.push(f);
    }
  }
}

/** Convertit une image en page (taille A4 portrait ou paysage). */
export async function imageToPage(file) {
  const asset = await addImageAsset(file);
  const landscape = asset.w > asset.h;
  const [W, H] = landscape ? [A4[1], A4[0]] : A4;
  const s = Math.min(W / asset.w, H / asset.h);
  const w = asset.w * s, hh = asset.h * s;
  return { id: uid('p'), src: null, index: null, w: W, h: H, rot: 0,
    objects: [{ id: uid('o'), type: 'image', kind: 'image', asset: asset.id, x: (W - w) / 2, y: (H - hh) / 2, w, h: hh }] };
}

export function blankPage(ref) {
  const [w, hh] = ref ? [ref.w, ref.h] : A4;
  return { id: uid('p'), src: null, index: null, w, h: hh, rot: 0, objects: [] };
}

/** Enregistre une image (fichier ou dataURL) ; les images non JPEG/PNG sont converties. */
export async function addImageAsset(fileOrUrl, opts = {}) {
  let url = typeof fileOrUrl === 'string' ? fileOrUrl : await new Promise((res, rej) => {
    const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(fileOrUrl);
  });
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Image illisible')); i.src = url; });
  let mime = /^data:(image\/[a-z+]+)/.exec(url)?.[1] || 'image/png';
  // réduit les très grandes photos, convertit WebP/GIF en JPEG/PNG
  const maxSide = opts.maxSide || 3000;
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  if (scale < 1 || !/image\/(png|jpeg)/.test(mime)) {
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    const ctx = c.getContext('2d');
    const keepAlpha = mime === 'image/png' || mime === 'image/webp' || mime === 'image/gif';
    if (!keepAlpha) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
    ctx.drawImage(img, 0, 0, c.width, c.height);
    mime = keepAlpha ? 'image/png' : 'image/jpeg';
    url = c.toDataURL(mime, 0.9);
  }
  const id = uid('a');
  const asset = { id, dataUrl: url, mime, w: img.naturalWidth * scale, h: img.naturalHeight * scale };
  state.assets.set(id, asset);
  return asset;
}

/** Valeurs de formulaire manquantes pour ces pages (reprises de l'original). */
export function ensureFormValues(pages, values = state.formValues) {
  const srcs = new Set(pages.map(p => p.src).filter(Boolean));
  for (const [k, v] of Object.entries(state.formOriginal)) if (srcs.has(k.split('|')[0]) && !(k in values)) values[k] = v;
  return values;
}

/** Lit des fichiers (PDF, images) et renvoie les pages, sans toucher au document affiché. */
export async function loadFiles(files) {
  const pages = [];
  let firstName = '';
  for (const file of files) {
    try {
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
      const isImg = /^image\/(png|jpeg|webp|gif)$/.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name);
      if (isPdf) pages.push(...await loadPdfSource(await readFile(file), file.name));
      else if (isImg) pages.push(await imageToPage(file));
      else { toast(`« ${file.name} » n'est ni un PDF ni une image.`, { error: true }); continue; }
      if (!firstName) firstName = file.name;
    } catch (e) {
      if (e.message === 'cancelled') continue;
      console.error(e);
      toast(`Impossible d'ouvrir « ${file.name} » : fichier endommagé ou format non pris en charge.`, { error: true });
    }
  }
  if (!pages.length) return null;
  const d = window.atelierDesktop, f0 = files[0];
  return {
    pages,
    docName: files.length > 1 ? baseName(firstName) + '-assemblé' : baseName(firstName),
    // application Windows : chemin du fichier d'origine, pour « Enregistrer »
    filePath: (files.length === 1 && /\.pdf$/i.test(f0.name) && (f0.__path || d?.pathFor?.(f0))) || null,
  };
}

/** Ouvre des fichiers : dans un nouvel onglet (par défaut) ou ajoutés au document affiché. */
export async function openFiles(files, { mode = 'tab', at = null, quiet = false } = {}) {
  const res = await loadFiles(files);
  if (!res) return false;
  if (mode === 'append') {
    const pos = at == null ? state.pages.length : at;
    state.pages.splice(pos, 0, ...res.pages);
    ensureFormValues(res.pages);
    emit('pages-changed');
    commit();
    toast(`${res.pages.length} page${res.pages.length > 1 ? 's ajoutées' : ' ajoutée'}.`);
  } else {
    const { openTab } = await import('./tabs.js');
    openTab(res, { quiet });
  }
  return res.pages;
}

/** Libère les fichiers qui ne servent plus à aucun onglet. */
export function releaseSources(keepPages) {
  const used = new Set(keepPages.map(p => p.src).filter(Boolean));
  state.sources.forEach((s, id) => {
    if (used.has(id)) return;
    s.task?.destroy(); state.sources.delete(id);
    for (const k of Object.keys(state.formOriginal)) if (k.startsWith(id + '|')) delete state.formOriginal[k];
  });
}

export function closeDocument() {
  state.sources.forEach(s => s.task?.destroy());
  state.sources.clear(); state.pages = []; state.assets.clear(); state.formValues = {}; state.formOriginal = {};
  state.selected = null; state.editing = null; state.selectedPages.clear(); state.docName = ''; state.filePath = null; state.recentId = null;
  emit('doc-closed'); resetHistory();
}
