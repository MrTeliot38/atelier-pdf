// Atelier PDF — application de bureau (Windows)
// La même application web est servie depuis le dossier « app » par un protocole interne app://,
// avec en plus : polices installées, ouverture des PDF par double-clic (une fenêtre par document),
// enregistrement sur le fichier d'origine, partage par e-mail / WhatsApp, réglage « lecteur par défaut ».
const { app, BrowserWindow, protocol, ipcMain, dialog, shell, Menu, session, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

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

/* ---------------- impression avec aperçu ---------------- */
// Le rendu des feuilles (aperçu, pages par feuille…) est fait par la fenêtre ; ici, on reçoit les feuilles
// en images, puis on les imprime depuis une fenêtre invisible, sans repasser par la fenêtre de Windows.
const printJobs = new Map(); // id -> { dir, owner }
const PRINT_SES = 'atelier-print';
ipcMain.handle('print:printers', guard(async e => {
  const list = await e.sender.getPrintersAsync();
  return list.map(p => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault }));
}));
ipcMain.handle('print:begin', guard(async e => {
  const id = crypto.randomBytes(12).toString('hex');
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'atelier-impression-'));
  printJobs.set(id, { dir, owner: e.sender.id }); printDirs.add(dir);
  return id;
}));
const jobOf = (e, id) => { const j = printJobs.get(id); if (!j || j.owner !== e.sender.id) throw new Error('Impression inconnue'); return j; };
ipcMain.handle('print:sheet', guard(async (e, id, i, bytes) => {
  const j = jobOf(e, id);
  if (!Number.isInteger(i) || i < 0 || i > 5000 || !(bytes instanceof Uint8Array) || bytes.length > 80e6) throw new Error('Feuille refusée');
  // PNG uniquement
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) throw new Error('Feuille refusée');
  await fs.promises.writeFile(path.join(j.dir, `f${i}.png`), bytes);
  return true;
}));
const printDirs = new Set();
// fichiers d'impression oubliés (application fermée pendant l'impression…)
function purgeOldPrintDirs() {
  fs.promises.readdir(os.tmpdir()).then(names => names.filter(n => n.startsWith('atelier-impression-')).forEach(n => {
    const d = path.join(os.tmpdir(), n);
    fs.promises.stat(d).then(st => { if (Date.now() - st.mtimeMs > 3600e3) fs.promises.rm(d, { recursive: true, force: true }); }).catch(() => {});
  })).catch(() => {});
}
app.on('will-quit', () => { for (const d of printDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function endPrintJob(id) {
  const j = printJobs.get(id); if (!j) return;
  printJobs.delete(id);
  // laisse le temps au spouleur de Windows de lire les fichiers
  setTimeout(() => fs.promises.rm(j.dir, { recursive: true, force: true }).then(() => printDirs.delete(j.dir)).catch(() => {}), 120000);
}
ipcMain.handle('print:cancel', guard(async (e, id) => { jobOf(e, id); endPrintJob(id); return true; }));
ipcMain.handle('print:run', guard(async (e, id, o) => {
  const j = jobOf(e, id);
  const count = Math.max(1, Math.min(5000, Math.floor(+o?.count || 0)));
  const pw = Math.max(100, Math.min(3000, +o?.paper?.w || 595.28)), ph = Math.max(100, Math.min(3000, +o?.paper?.h || 841.89));
  const printers = await e.sender.getPrintersAsync();
  const deviceName = printers.some(p => p.name === o?.deviceName) ? o.deviceName : undefined;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${pw}pt ${ph}pt; margin: 0 }
    html, body { margin: 0; padding: 0 }
    img { display: block; width: ${pw}pt; height: ${ph}pt; break-after: page; page-break-after: always }
    img:last-child { break-after: auto; page-break-after: auto }
  </style></head><body>${Array.from({ length: count }, (_, i) => `<img src="f${i}.png">`).join('')}</body></html>`;
  const file = path.join(j.dir, 'impression.html');
  await fs.promises.writeFile(file, html);
  const owner = BrowserWindow.fromWebContents(e.sender);
  const pwin = new BrowserWindow({ show: false, parent: owner || undefined, webPreferences: { partition: PRINT_SES, sandbox: true, contextIsolation: true, javascript: false } });
  try {
    await pwin.loadFile(file);
    const micron = v => Math.round(v / 72 * 25400);
    const opts = {
      silent: !o?.system, printBackground: true, deviceName,
      copies: Math.max(1, Math.min(999, Math.floor(+o?.copies || 1))), collate: o?.collate !== false,
      duplexMode: ['simplex', 'shortEdge', 'longEdge'].includes(o?.duplex) ? o.duplex : 'simplex',
      color: o?.color !== false, landscape: false,
      margins: { marginType: 'none' }, pageSize: { width: micron(pw), height: micron(ph) },
    };
    return await new Promise(res => pwin.webContents.print(opts, (success, reason) => res({ success, reason: success ? '' : String(reason || '') })));
  } finally {
    setTimeout(() => { if (!pwin.isDestroyed()) pwin.destroy(); }, 1500);
    endPrintJob(id);
  }
}));

/* ---------------- mises à jour (seulement à la demande) ---------------- */
// Seul accès à internet de l'application : la page des versions publiées sur GitHub,
// depuis une session à part (les fenêtres, elles, restent coupées d'internet).
const UPDATE_REPO = 'MrTeliot38/atelier-pdf';
const updSes = () => session.fromPartition('atelier-updates');
const verParts = v => String(v || '').replace(/^v/i, '').split(/[.-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
const newerThan = (a, b) => { const x = verParts(a), y = verParts(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
const okHost = u => { try { const h = new URL(u).hostname; return new URL(u).protocol === 'https:' && (h === 'github.com' || h.endsWith('.github.com') || h.endsWith('.githubusercontent.com')); } catch { return false; } };
async function latestRelease() {
  const r = await updSes().fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
    headers: { 'User-Agent': 'Atelier-PDF/' + app.getVersion(), Accept: 'application/vnd.github+json' }, cache: 'no-store',
  });
  if (r.status === 404) return { latest: null };
  if (r.status === 403 || r.status === 429) throw new Error('GitHub limite le nombre de vérifications : réessayez dans une heure.');
  if (!r.ok) throw new Error('GitHub a répondu ' + r.status);
  const j = await r.json();
  const a = (j.assets || []).find(x => /\.exe$/i.test(x.name || ''));
  const notes = String(j.body || '').slice(0, 10000);
  let sha = /^sha256:([0-9a-f]{64})$/i.exec(a?.digest || '')?.[1];
  if (!sha && a) sha = /(?:EXE|\.exe)[^\n]*?([0-9a-f]{64})/i.exec(notes)?.[1];
  return {
    latest: String(j.tag_name || '').replace(/^v/i, ''), name: j.name || '', notes, page: okHost(j.html_url) ? j.html_url : `https://github.com/${UPDATE_REPO}/releases/latest`,
    asset: a && okHost(a.browser_download_url) ? { name: path.basename(a.name).replace(/[^\w.-]/g, '_'), size: a.size || 0, url: a.browser_download_url, sha: sha ? sha.toLowerCase() : null } : null,
  };
}
let lastRelease = null, updating = false;
ipcMain.handle('update:check', guard(async () => {
  lastRelease = await latestRelease();
  const current = app.getVersion();
  return { current, latest: lastRelease.latest, newer: !!lastRelease.latest && newerThan(lastRelease.latest, current), notes: lastRelease.notes, page: lastRelease.page,
    size: lastRelease.asset?.size || 0, installable: !!lastRelease.asset };
}));
ipcMain.handle('update:open-page', guard(async () => { shell.openExternal(lastRelease?.page || `https://github.com/${UPDATE_REPO}/releases/latest`); return true; }));
ipcMain.handle('update:install', guard(async e => {
  if (updating) throw new Error('Téléchargement déjà en cours');
  const rel = lastRelease || await latestRelease();
  if (!rel.asset || !newerThan(rel.latest, app.getVersion())) throw new Error('Aucune mise à jour à installer');
  if (!rel.asset.sha) throw new Error('Empreinte de contrôle absente de la version publiée : installation refusée par sécurité.');
  updating = true;
  const dir = path.join(os.tmpdir(), 'atelier-pdf-maj');
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, rel.asset.name);
  try {
    const res = await updSes().fetch(rel.asset.url, { headers: { 'User-Agent': 'Atelier-PDF/' + app.getVersion() }, cache: 'no-store' });
    if (!res.ok || (res.url && !okHost(res.url))) throw new Error('Téléchargement refusé (' + res.status + ')');
    const total = +res.headers.get('content-length') || rel.asset.size || 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(file);
    const reader = res.body.getReader();
    let got = 0, lastSent = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value); got += value.length;
      if (!out.write(value)) await new Promise(r => out.once('drain', r));
      if (got > 600e6) throw new Error('Fichier trop volumineux');
      if (Date.now() - lastSent > 150) { lastSent = Date.now(); if (!e.sender.isDestroyed()) e.sender.send('update:progress', { got, total }); }
    }
    await new Promise((r, j) => out.end(err => err ? j(err) : r()));
    if (hash.digest('hex') !== rel.asset.sha) throw new Error('Le fichier téléchargé ne correspond pas à l\'empreinte publiée : installation annulée.');
    const head = Buffer.alloc(2); const fd = await fs.promises.open(file, 'r'); await fd.read(head, 0, 2, 0); await fd.close();
    if (head.toString('latin1') !== 'MZ') throw new Error('Fichier d\'installation invalide');
    if (!e.sender.isDestroyed()) e.sender.send('update:progress', { got, total: got, done: true });
    // l'installateur attend que l'application soit fermée, puis la relance
    const { spawn } = require('child_process');
    const child = spawn(file, [], { detached: true, stdio: 'ignore' });
    await new Promise((res, rej) => { child.once('spawn', res); child.once('error', rej); });
    child.unref();
    setTimeout(() => app.quit(), 600);
    return true;
  } catch (err) {
    fs.promises.rm(file, { force: true }).catch(() => {});
    throw err;
  } finally { updating = false; }
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
  purgeOldPrintDirs();
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
  // fenêtre d'impression : uniquement ses propres fichiers temporaires
  session.fromPartition(PRINT_SES).webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^file:/i.test(d.url) || !d.url.includes('atelier-impression-') }));
  session.defaultSession.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({ title: 'Enregistrer', defaultPath: path.join(app.getPath('documents'), item.getFilename()) });
  });
  Menu.setApplicationMenu(null);
  createWindow();
  if (firstFiles.length) openFromSystem(firstFiles);
});
app.on('window-all-closed', () => app.quit());
