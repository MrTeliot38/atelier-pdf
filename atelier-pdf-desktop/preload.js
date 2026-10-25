// Pont minimal et sûr entre la fenêtre et l'application
const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('atelierDesktop', {
  platform: process.platform,
  listFonts: () => ipcRenderer.invoke('fonts:list'),
  readFont: p => ipcRenderer.invoke('fonts:read', p),
  setDirty: d => ipcRenderer.send('dirty', !!d),
  setHasDoc: d => ipcRenderer.send('has-doc', !!d),
  newWindow: () => ipcRenderer.send('new-window'),
  openPaths: paths => ipcRenderer.send('open-paths', paths),
  onOpenFile: cb => { ipcRenderer.on('open-file', (_e, f) => cb(f)); ipcRenderer.send('renderer-ready'); },
  // chemin réel d'un fichier glissé ou choisi : on le signale pour que « Enregistrer » puisse le réécrire
  pathFor: file => { try { const p = webUtils.getPathForFile(file) || null; if (p) ipcRenderer.send('allow-path', p); return p; } catch { return null; } },
  save: (p, bytes) => ipcRenderer.invoke('file:save', p, bytes),
  saveAs: (name, bytes, current) => ipcRenderer.invoke('file:saveAs', name, bytes, current),
  reveal: p => ipcRenderer.invoke('file:reveal', p),
  sharePrepare: (name, bytes) => ipcRenderer.invoke('share:prepare', name, bytes),
  shareMail: (p, subject, body) => ipcRenderer.invoke('share:mail', p, subject, body),
  shareMailFallback: (p, subject, body) => ipcRenderer.invoke('share:mailFallback', p, subject, body),
  shareWhatsapp: p => ipcRenderer.invoke('share:whatsapp', p),
  copyFile: p => ipcRenderer.invoke('share:copy', p),
  defaultStatus: () => ipcRenderer.invoke('defaults:status'),
  openDefaultSettings: () => ipcRenderer.invoke('defaults:open'),
});
