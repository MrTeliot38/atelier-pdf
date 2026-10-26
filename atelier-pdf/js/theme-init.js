// Applique le thème choisi (Clair / Sombre) avant l'affichage de la page, pour éviter un flash.
(function () {
  try {
    var t = localStorage.getItem('atelierpdf.theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* stockage indisponible : thème de l'appareil */ }
})();
