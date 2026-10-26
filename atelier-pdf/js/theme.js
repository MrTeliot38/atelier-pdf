// Apparence : Automatique (comme l'appareil), Clair ou Sombre — menu ⋮.
import { $ } from './core.js';

const KEY = 'atelierpdf.theme';
const dark = matchMedia('(prefers-color-scheme: dark)');
const cap = window.Capacitor;
const native = cap?.Plugins?.AtelierNative;

export function getTheme() { try { const t = localStorage.getItem(KEY); return t === 'light' || t === 'dark' ? t : 'auto'; } catch { return 'auto'; } }
export const isDark = () => { const t = getTheme(); return t === 'dark' || (t === 'auto' && dark.matches); };

function apply() {
  const t = getTheme();
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  const d = isDark();
  // couleur de la barre du navigateur / de la fenêtre installée
  $('meta[name="theme-color"]')?.setAttribute('content', d ? '#222c28' : '#f4f6f5');
  // Android : icônes de la barre d'état et de navigation lisibles sur le fond choisi
  try { native?.setBarStyle?.({ light: !d })?.catch?.(() => {}); } catch {}
  // Windows : barre de titre et menus du système assortis
  try { window.atelierDesktop?.setTheme?.(t === 'auto' ? 'system' : t); } catch {}
  for (const b of document.querySelectorAll('[data-theme-set]')) b.setAttribute('aria-pressed', String(b.dataset.themeSet === t));
}

export function setTheme(t) {
  try { t === 'auto' ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, t); } catch {}
  apply();
}

export function initTheme() {
  for (const b of document.querySelectorAll('[data-theme-set]')) b.addEventListener('click', e => { e.stopPropagation(); setTheme(b.dataset.themeSet); });
  dark.addEventListener?.('change', apply);
  // Android peut remettre ses propres couleurs de barres au retour dans l'application
  document.addEventListener('visibilitychange', () => { if (!document.hidden) apply(); });
  apply();
}
