// Atelier PDF — application de bureau (Windows)
// La même application web est servie depuis le dossier « app » par un protocole interne app://,
// avec en plus : polices installées, ouverture des PDF par double-clic (une fenêtre par document),
// enregistrement sur le fichier d'origine, partage par e-mail / WhatsApp, réglage « lecteur par défaut ».
const { app, BrowserWindow, protocol, ipcMain, dialog, shell, Menu, session, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_DIR = path.join(__dirname, 'app');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.gz': 'application/gzip',
};

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

if (!app.requestSingleInstanceLock()) { app.quit(); }

/* ---------------- sécurité ---------------- */
// Seule la fenêtre de l'application (app://atelier) peut parler au processus principal.
const trusted = e => { try { const u = new URL(e.senderFrame?.url || ''); return u.protocol === 'app:' && u.host === 'atelier'; } catch { return false; } };
const guard = fn => (e, ...a) => { if (!trusted(e)) throw new Error('Origine refusée'); return fn(e, ...a); };
const guardOn = fn => (e, ...a) => { if (trusted(e)) fn(e, ...a); };
// Fichiers que l'application a le droit de réécrire : ceux que la personne a ouverts ou choisis.
const allowedPaths = new Set();
const allow = p => { if (typeof p === 'string' && p) allowedPaths.add(path.resolve(p)); };
const isAllowed = p => typeof p === 'string' && allowedPaths.has(path.resolve(p));
const okFile = p => typeof p === 'string' && /\.(pdf|png|jpe?g|webp)$/i.test(p) && fs.existsSync(p);

/* ---------------- apparence (Automatique / Clair / Sombre) ---------------- */
// gardée par l'application pour que la barre de titre soit dans le bon thème dès l'ouverture
const themeFile = () => path.join(app.getPath('userData'), 'theme.json');
function loadTheme() {
  try { const t = JSON.parse(fs.readFileSync(themeFile(), 'utf8')).theme; if (['system', 'light', 'dark'].includes(t)) nativeTheme.themeSource = t; } catch {}
}
ipcMain.on('theme:set', guardOn((_e, t) => {
  if (!['system', 'light', 'dark'].includes(t) || nativeTheme.themeSource === t) return;
  nativeTheme.themeSource = t;
  fs.promises.writeFile(themeFile(), JSON.stringify({ theme: t })).catch(() => {});
}));

/* ---------------- fichiers récents ---------------- */
// Liste gardée dans le dossier de l'application (chemins seulement, jamais de copie des documents)
const RECENT_MAX = 12;
const recentFile = () => path.join(app.getPath('userData'), 'recents.json');
let recents = null;
function loadRecents() {
  if (recents) return recents;
  try { recents = JSON.parse(fs.readFileSync(recentFile(), 'utf8')).filter(r => r && typeof r.path === 'string'); } catch { recents = []; }
  return recents;
}
function saveRecents() { fs.promises.writeFile(recentFile(), JSON.stringify(recents)).catch(() => {}); }
function addRecent(p) {
  if (typeof p !== 'string' || !/\.pdf$/i.test(p)) return;
  const full = path.resolve(p);
  loadRecents();
  recents = [{ path: full, name: path.basename(full), at: Date.now() }, ...recents.filter(r => path.resolve(r.path) !== full)].slice(0, RECENT_MAX);
  saveRecents();
}

/* ---------------- fenêtres : une par document ---------------- */
const wins = new Map(); // webContents.id -> { win, ready, queue: [], dirty, hasDoc }
const fileArgs = argv => argv.slice(1).filter(a => !a.startsWith('-') && /\.(pdf|png|jpe?g|webp)$/i.test(a) && fs.existsSync(a));
const firstFiles = fileArgs(process.argv);

function infoOf(sender) { return wins.get(sender.id); }
function sendFile(info, p) {
  allow(p); addRecent(p);
  if (!info.ready) { info.queue.push(p); return; }
  fs.promises.readFile(p).then(data => info.win.webContents.send('open-file', { name: path.basename(p), path: p, data })).catch(() => {});
  info.hasDoc = true;
}
/** Ouvre des fichiers venant de Windows (double-clic, « Ouvrir avec ») dans un onglet de la dernière fenêtre utilisée. */
let lastFocused = null;
function openFromSystem(files) {
  const info = wins.get(lastFocused) || [...wins.values()].pop() || createWindow();
  for (const f of files) sendFile(info, f);
  const w = info.win; if (w.isMinimized()) w.restore(); w.show(); w.focus();
}
app.on('second-instance', (_e, argv) => {
  const files = fileArgs(argv);
  if (files.length) openFromSystem(files);
  else { const w = BrowserWindow.getFocusedWindow() || [...wins.values()][0]?.win; if (w) { if (w.isMinimized()) w.restore(); w.focus(); } else createWindow(); }
});

function createWindow() {
  const first = wins.size === 0;
  const last = BrowserWindow.getFocusedWindow();
  const win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 820, minHeight: 560, show: false,
    ...(last && !first ? { x: last.getBounds().x + 32, y: last.getBounds().y + 32 } : {}),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c2723' : '#2b3a34', title: 'Atelier PDF', icon: path.join(__dirname, 'app', 'icons', 'icon-512.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: true },
  });
  const info = { win, ready: false, queue: [], dirty: false, hasDoc: false };
  const id = win.webContents.id;
  wins.set(id, info);
  win.once('ready-to-show', () => { if (first) win.maximize(); win.show(); });
  win.loadURL('app://atelier/index.html');

  // liens externes dans le navigateur par défaut
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https|mailto):/i.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    if (url.startsWith('blob:')) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, title: 'Atelier PDF' } };
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://atelier/')) { e.preventDefault(); if (/^(https|mailto):/i.test(url)) shell.openExternal(url); } });
  win.webContents.on('will-attach-webview', e => e.preventDefault());

  win.on('close', e => {
    if (!info.dirty) return;
    const r = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: ['Fermer sans enregistrer', 'Annuler'], defaultId: 1, cancelId: 1,
      title: 'Atelier PDF', message: 'Des documents ont des modifications non enregistrées.', detail: 'Repérez les onglets marqués d\'un point jaune et utilisez « Enregistrer » (Ctrl+S) pour les conserver.',
    });
    if (r === 1) e.preventDefault();
  });
  win.on('focus', () => { lastFocused = id; });
  win.on('closed', () => { wins.delete(id); if (lastFocused === id) lastFocused = null; });
  lastFocused = id;
  return info;
}

/* ---------------- polices installées ---------------- */
let fontIndex = null;
async function fontDirs() {
  const dirs = [];
  if (process.platform === 'win32') {
    dirs.push(path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'));
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
  } else if (process.platform === 'darwin') {
    dirs.push('/System/Library/Fonts', '/Library/Fonts', path.join(app.getPath('home'), 'Library', 'Fonts'));
  } else {
    dirs.push('/usr/share/fonts', '/usr/local/share/fonts', path.join(app.getPath('home'), '.fonts'), path.join(app.getPath('home'), '.local', 'share', 'fonts'));
  }
  return dirs.filter(d => fs.existsSync(d));
}
async function walk(dir, out, depth = 0) {
  let entries = [];
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 4) await walk(p, out, depth + 1);
    else if (/\.(ttf|otf|ttc)$/i.test(e.name)) out.push(p);
  }
}
async function listFonts() {
  if (fontIndex) return fontIndex.faces;
  const { readFontFaces } = require('./fontnames.cjs');
  const cacheFile = path.join(app.getPath('userData'), 'polices.json');
  let cache = {};
  try { cache = JSON.parse(await fs.promises.readFile(cacheFile, 'utf8')); } catch {}
  const files = [];
  for (const d of await fontDirs()) await walk(d, files);
  const faces = [], next = {};
  for (const file of files) {
    let st; try { st = await fs.promises.stat(file); } catch { continue; }
    const key = file + '|' + st.size + '|' + st.mtimeMs;
    let list = cache[key];
    if (!list) {
      list = [];
      let fd;
      try {
        fd = fs.openSync(file, 'r');
        const read = (offset, length) => { const b = Buffer.alloc(Math.max(0, Math.min(length, st.size - offset))); if (b.length) fs.readSync(fd, b, 0, b.length, offset); return new Uint8Array(b.buffer, b.byteOffset, b.length); };
        list = readFontFaces(read).map(f => ({ ...f, path: file }));
      } catch { list = []; }
      finally { if (fd) fs.closeSync(fd); }
    }
    next[key] = list;
    faces.push(...list);
  }
  fs.promises.writeFile(cacheFile, JSON.stringify(next)).catch(() => {});
  fontIndex = { faces, paths: new Set(files) };
  return faces;
}

ipcMain.handle('fonts:list', guard(() => listFonts()));
ipcMain.handle('fonts:read', guard(async (_e, p) => {
  if (!fontIndex || !fontIndex.paths.has(p)) throw new Error('Police inconnue');
  return fs.promises.readFile(p);
}));
ipcMain.on('dirty', guardOn((e, d) => { const i = infoOf(e.sender); if (i) i.dirty = !!d; }));
ipcMain.on('has-doc', guardOn((e, d) => { const i = infoOf(e.sender); if (i) i.hasDoc = !!d; }));
ipcMain.on('renderer-ready', guardOn(e => { const i = infoOf(e.sender); if (!i) return; i.ready = true; i.queue.splice(0).forEach(p => sendFile(i, p)); }));
ipcMain.on('allow-path', guardOn((_e, p) => { if (okFile(p)) { allow(p); addRecent(p); } }));
ipcMain.handle('recent:list', guard(async () => loadRecents().map(r => ({ ...r, exists: fs.existsSync(r.path) }))));
ipcMain.handle('recent:open', guard(async (_e, p) => {
  const r = loadRecents().find(x => x.path === p);
  if (!r || !okFile(r.path) || !fs.existsSync(r.path)) return false;
  const info = wins.get(_e.sender.id);
  if (info) sendFile(info, r.path); else openFromSystem([r.path]);
  return true;
}));
ipcMain.handle('recent:remove', guard(async (_e, p) => { recents = loadRecents().filter(x => x.path !== p); saveRecents(); return true; }));
ipcMain.handle('recent:clear', guard(async () => { recents = []; saveRecents(); return true; }));
ipcMain.on('new-window', guardOn(() => createWindow()));
ipcMain.on('open-paths', guardOn((_e, paths) => openFromSystem((Array.isArray(paths) ? paths : []).filter(okFile))));

/* ---------------- enregistrement ---------------- */
const winOf = e => BrowserWindow.fromWebContents(e.sender);
ipcMain.handle('file:save', guard(async (_e, p, bytes) => {
  if (!isAllowed(p) || !/\.pdf$/i.test(p)) throw new Error('Emplacement non autorisé : utilisez « Enregistrer sous ».');
  await fs.promises.writeFile(p, Buffer.from(bytes)); return p;
}));
ipcMain.handle('file:saveAs', guard(async (e, name, bytes, current) => {
  const r = await dialog.showSaveDialog(winOf(e), {
    title: 'Enregistrer sous', buttonLabel: 'Enregistrer',
    defaultPath: current ? path.join(path.dirname(current), name) : path.join(app.getPath('documents'), name),
    filters: [{ name: 'Document PDF', extensions: ['pdf'] }],
  });
  if (r.canceled || !r.filePath) return null;
  const out = /\.pdf$/i.test(r.filePath) ? r.filePath : r.filePath + '.pdf';
  await fs.promises.writeFile(out, Buffer.from(bytes));
  allow(out); addRecent(out);
  return out;
}));
ipcMain.handle('file:reveal', guard((_e, p) => { if ((isAllowed(p) || inShareDir(p)) && fs.existsSync(p)) shell.showItemInFolder(p); }));

/* ---------------- partage ---------------- */
const shareDir = () => path.join(app.getPath('temp'), 'Atelier PDF');
// vrai seulement pour un fichier PDF placé par l'application dans son dossier de partage
const inShareDir = p => { if (typeof p !== 'string') return false; const r = path.relative(shareDir(), path.resolve(p)); return !!r && !r.startsWith('..') && !path.isAbsolute(r) && !r.includes(path.sep) && /\.pdf$/i.test(r); };
ipcMain.handle('share:prepare', guard(async (_e, name, bytes) => {
  await fs.promises.mkdir(shareDir(), { recursive: true });
  const safe = String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-').replace(/^\.+/, '').trim().slice(0, 150) || 'document.pdf';
  const p = path.join(shareDir(), /\.pdf$/i.test(safe) ? safe : safe + '.pdf');
  await fs.promises.writeFile(p, Buffer.from(bytes));
  return p;
}));
function run(cmd, args, timeout = 0) {
  return new Promise(resolve => {
    const { execFile } = require('child_process');
    const child = execFile(cmd, args, { windowsHide: true, timeout }, (err, stdout) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: String(stdout || '') }));
    child.on('error', () => resolve({ code: -1, stdout: '' }));
  });
}
const psQuote = s => "'" + String(s).replace(/'/g, "''") + "'";
/** Copie le fichier dans le presse-papiers (comme « Copier » dans l'Explorateur). */
async function copyFileToClipboard(p) {
  if (process.platform !== 'win32') return false;
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', `Set-Clipboard -LiteralPath ${psQuote(p)}`], 15000);
  return r.code === 0;
}
ipcMain.handle('share:copy', guard((_e, p) => inShareDir(p) ? copyFileToClipboard(p) : false));

// E-mail avec pièce jointe via la messagerie par défaut (Simple MAPI : Outlook classique, Thunderbird…)
const MAPI_CS = `
using System; using System.Runtime.InteropServices;
public static class AtelierMapi {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public class FileDesc { public int reserved; public int flags; public int position = -1; public string path; public string name; public IntPtr type; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public class Message { public int reserved; public string subject; public string noteText; public string messageType; public string dateReceived; public string conversationID; public int flags; public IntPtr originator; public int recipCount; public IntPtr recips; public int fileCount; public IntPtr files; }
  [DllImport("MAPI32.DLL", CharSet = CharSet.Unicode)] static extern int MAPISendMailW(IntPtr session, IntPtr hwnd, Message msg, int flags, int reserved);
  public static int Send(string path, string name, string subject, string body) {
    var f = new FileDesc(); f.path = path; f.name = name;
    IntPtr pf = Marshal.AllocHGlobal(Marshal.SizeOf(f)); Marshal.StructureToPtr(f, pf, false);
    var m = new Message(); m.subject = subject; m.noteText = body; m.fileCount = 1; m.files = pf;
    try { return MAPISendMailW(IntPtr.Zero, IntPtr.Zero, m, 0x1 | 0x8, 0); }
    catch { return 99; }
    finally { Marshal.FreeHGlobal(pf); }
  }
}`;
ipcMain.handle('share:mail', guard(async (_e, p, subject, body) => {
  if (!inShareDir(p)) return { ok: false };
  if (process.platform !== 'win32') return { ok: false };
  const script = `Add-Type -TypeDefinition @"\n${MAPI_CS}\n"@\n$r = [AtelierMapi]::Send(${psQuote(p)}, ${psQuote(path.basename(p))}, ${psQuote(String(subject || '').slice(0, 500))}, ${psQuote(String(body || '').slice(0, 5000))})\nWrite-Output "MAPI:$r"`;
  // Commande transmise directement (encodée), sans fichier de script ni contournement de la stratégie d'exécution.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  // MAPI ouvre la fenêtre de rédaction ; la commande se termine quand elle est envoyée ou fermée.
  const done = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded]);
  const quick = await Promise.race([done, new Promise(r => setTimeout(() => r(null), 6000))]);
  if (quick === null) return { ok: true };            // la messagerie est ouverte
  const m = /MAPI:(\d+)/.exec(quick.stdout);
  const code = m ? +m[1] : -1;
  if (code === 0 || code === 1) return { ok: true };   // envoyé ou annulé par la personne
  return { ok: false, code };                          // pas de messagerie compatible
}));
ipcMain.handle('share:mailFallback', guard(async (_e, p, subject, body) => {
  if (!inShareDir(p)) return false;
  await copyFileToClipboard(p);
  shell.showItemInFolder(p);
  await shell.openExternal(`mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`).catch(() => {});
  return true;
}));
ipcMain.handle('share:whatsapp', guard(async (_e, p) => {
  if (!inShareDir(p)) return { copied: false, app: false };
  const copied = await copyFileToClipboard(p);
  let app = false;
  if (process.platform === 'win32') {
    const r = await run('reg', ['query', 'HKCR\\whatsapp'], 5000);
    app = r.code === 0;
  }
  if (app) await shell.openExternal('whatsapp://').catch(() => { app = false; });
  if (!app) await shell.openExternal('https://web.whatsapp.com/');
  return { copied, app };
}));

/* ---------------- lecteur PDF par défaut ---------------- */
const PROGID = 'AtelierPDF.Document';
ipcMain.handle('defaults:status', guard(async () => {
  if (process.platform !== 'win32') return { supported: false };
  const r = await run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.pdf\\UserChoice', '/v', 'ProgId'], 5000);
  return { supported: true, isDefault: r.stdout.includes(PROGID) };
}));
ipcMain.handle('defaults:open', guard(async () => {
  try { await shell.openExternal('ms-settings:defaultapps?registeredAppUser=' + encodeURIComponent('Atelier PDF')); }
  catch { await shell.openExternal('ms-settings:defaultapps').catch(() => {}); }
  return true;
}));

/* ---------------- démarrage ---------------- */
app.whenReady().then(() => {
  loadTheme();
  protocol.handle('app', async req => {
    const u = new URL(req.url);
    if (u.host !== 'atelier') return new Response('Interdit', { status: 403 });
    let rel; try { rel = decodeURIComponent(u.pathname); } catch { return new Response('Interdit', { status: 403 }); }
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.resolve(APP_DIR, '.' + rel);
    const inside = path.relative(APP_DIR, file);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return new Response('Interdit', { status: 403 });
    try {
      const data = await fs.promises.readFile(file);
      return new Response(data, { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
    } catch { return new Response('Introuvable', { status: 404 }); }
  });
  // l'API web des polices locales reste désactivée : l'application les lit directement
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');
  // aucune requête réseau sortante : l'application fonctionne entièrement hors ligne
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(app|blob|data|devtools):/i.test(d.url) }));
  session.defaultSession.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({ title: 'Enregistrer', defaultPath: path.join(app.getPath('documents'), item.getFilename()) });
  });
  Menu.setApplicationMenu(null);
  createWindow();
  if (firstFiles.length) openFromSystem(firstFiles);
});
app.on('window-all-closed', () => app.quit());
