// Ce qui diffère entre le navigateur, l'application Windows et l'application Android :
// enregistrer, partager, imprimer, recevoir des fichiers d'autres applications, bouton Retour.
const cap = window.Capacitor;
export const isAndroidApp = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform() && cap.getPlatform?.() === 'android');
export const isDesktopApp = !!window.atelierDesktop;
export const isTouch = matchMedia('(pointer: coarse)').matches;

let native = null;
if (isAndroidApp) {
  try { native = cap.registerPlugin ? cap.registerPlugin('AtelierNative') : cap.Plugins.AtelierNative; } catch { native = cap.Plugins?.AtelierNative; }
  document.documentElement.classList.add('is-android');
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
const mimeOf = name => /\.pdf$/i.test(name) ? 'application/pdf' : /\.zip$/i.test(name) ? 'application/zip' : /\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : 'application/octet-stream';

/** Android : Android demande où enregistrer (Téléchargements, Drive…). Renvoie true si enregistré. */
export async function saveBlob(blob, name) {
  if (!native) return false;
  const r = await native.saveAs({ name, mime: blob.type || mimeOf(name), data: await blobToBase64(blob) });
  return !!(r && r.saved);
}

export function canShareFiles() {
  if (native) return true;
  try { return !!navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.pdf', { type: 'application/pdf' })] }); }
  catch { return false; }
}
/** Ouvre le menu de partage de l'appareil (WhatsApp, e-mail, Drive…). */
export async function shareBlob(blob, name, title) {
  if (native) return native.share({ name, mime: blob.type || mimeOf(name), title: title || name, data: await blobToBase64(blob) });
  const file = new File([blob], name, { type: blob.type || mimeOf(name) });
  return navigator.share({ files: [file], title: title || name });
}
export async function printPdf(bytes, name) {
  return native.print({ name, data: await blobToBase64(new Blob([bytes], { type: 'application/pdf' })) });
}
export const canNativePrint = () => !!native;

/** Fichiers reçus d'autres applications (« Ouvrir avec », « Partager vers »). */
export function onIncomingFiles(cb) {
  if (!native) return;
  const pull = async () => {
    try {
      const r = await native.getPendingFiles();
      const files = (r && r.files || []).map(f => {
        const bin = atob(f.data), u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        return new File([u8], f.name, { type: f.mime });
      });
      if (files.length) cb(files);
    } catch (e) { console.error(e); }
  };
  native.addListener('filesPending', pull);
  pull();
}

/** Bouton Retour d'Android : chaque écran s'y abonne ; le plus récent passe en premier. */
const backHandlers = [];
export function pushBack(fn) { backHandlers.push(fn); return () => { const i = backHandlers.lastIndexOf(fn); if (i >= 0) backHandlers.splice(i, 1); }; }
export function initBackButton(fallback) {
  if (!native) return;
  native.addListener('backButton', async () => {
    for (let i = backHandlers.length - 1; i >= 0; i--) if (await backHandlers[i]()) return;
    if (await fallback()) return;
    native.exitApp();
  });
}

/* ---------------- lecteur PDF par défaut (Android) ---------------- */
export const TEST_PDF_NAME = 'Atelier PDF - lecteur par defaut.pdf';
export async function defaultPdfStatus() {
  try { return await native.defaultPdfStatus(); } catch { return { isDefault: false, hasOther: false }; }
}
export const openAppSettings = pkg => native.openAppSettings({ package: pkg });
export async function openTestPdf(bytes) {
  return native.openTestPdf({ name: TEST_PDF_NAME, data: await blobToBase64(new Blob([bytes], { type: 'application/pdf' })) });
}
