# Atelier PDF

Outil libre et gratuit pour retoucher, remplir, signer et réorganiser des PDF, directement dans le navigateur.
Tout le traitement se fait sur l'appareil de la personne : aucun document n'est envoyé sur un serveur.

## Ce que fait l'outil

- **Modifier le texte existant** : cliquez sur un paragraphe (ou une ligne) pour le corriger. Le nouveau texte reprend la taille, la couleur, l'alignement et une police proche de l'original ; le texte d'origine est recouvert par un fond de la couleur détectée.
- **Scans et photos** : bouton « Lire le texte de cette page » (reconnaissance de caractères en français, sans connexion une fois chargée). Fonctionne aussi pour les textes vectorisés (exports Canva, logos).
- **Remplir** : les champs de formulaire du PDF sont remplissables directement. Pour les PDF sans champs : « Ajouter du texte », « Cocher », date du jour.
- **Signer** : signature tracée (souris, doigt, stylet), saisie au clavier ou importée (fond rendu transparent). Possibilité de la mémoriser sur l'appareil et de parapher toutes les pages.
- **Polices de l'ordinateur** : le choix de police propose, avec recherche et aperçu, les polices installées (dans Chrome et Edge, après autorisation ; directement dans l'application Windows). Lors d'une correction, la police d'origine est retrouvée automatiquement si elle est installée. Pour un scan ou une photo, l'outil compare l'image du texte à toutes les polices de l'ordinateur (normal, gras, italique) et prend la plus ressemblante ; les trois plus proches sont proposées dans le panneau de droite. Si aucune ne ressemble assez : Arial.
- **Images du document** : en mode Sélection, cliquez sur une image du PDF (photo, logo, document photographié converti en PDF) pour la déplacer, l'agrandir, la pivoter, la remplacer ou la supprimer (Suppr). « Remettre à sa place d'origine » annule tout.
- **Images dans une page « tout image »** (tract exporté en image, scan, photo) : l'outil repère automatiquement les logos, illustrations, pictogrammes et QR codes contenus dans la page (bouton « Repérer les images » si besoin, après lecture du texte). Chacun peut alors être déplacé, agrandi ou supprimé séparément ; son fond est rendu transparent.
- **Onglets** : chaque PDF ouvert s'affiche dans son propre onglet (Ctrl+Tab pour passer de l'un à l'autre, Ctrl+W pour fermer). Chaque onglet garde son historique d'annulation.
- **Fusionner** : bouton « Fusionner » de la barre d'onglets (ou menu ⋮) pour réunir plusieurs PDF en un seul, dans l'ordre voulu, au début, à la fin ou après la page affichée.
- **Masquer, surligner, insérer une image.**
- **Pages** : réordonner par glisser-déposer, pivoter, dupliquer, supprimer, ajouter une page blanche, les pages d'un autre PDF ou une photo ; télécharger une sélection de pages seule.
- **Imprimer** en choisissant les pages (clic sur les miniatures ou saisie « 1-3, 6 »).
- **Exporter en PNG ou JPG** (une image par page, archive .zip si plusieurs).
- **Partager** : par e-mail ou WhatsApp (sur téléphone et dans Chrome / Edge, via le partage de l'appareil ; sinon le PDF est téléchargé et la messagerie s'ouvre).
- **PDF aplati** (menu ⋮) : chaque page devient une image ; rien de masqué ou corrigé ne reste lisible dans le fichier.

## Bon à savoir

- Une image du document déplacée ou supprimée laisse à sa place un fond de la couleur environnante (blanc pour une photo pleine page). Sur un fond dégradé ou photographique, ce rectangle peut se voir.
- Une correction de texte recouvre l'ancien texte : il reste présent dans le fichier (recherche, copier-coller). Pour un document confidentiel, utilisez le PDF aplati.
- Si la police d'origine n'est pas installée sur l'ordinateur, l'outil prend la plus proche (Arial/Helvetica, Times, Courier) ; vous pouvez aussi importer le fichier de police (.ttf ou .otf).
- Une application Windows à installer existe aussi (dossier `atelier-pdf-desktop`).
- La signature est une signature visuelle (équivalent d'une signature scannée), pas une signature électronique certifiée.
- Après réorganisation des pages, les champs de formulaire sont figés dans le PDF final (ils restent modifiables si l'ordre des pages n'a pas changé).

## Mettre l'outil en ligne

Le dossier est un site statique : il suffit de le déposer tel quel chez un hébergeur. Pour qu'on puisse l'installer comme une application, l'adresse doit être en **https**.

**Le plus simple — Netlify Drop (gratuit)**
1. Aller sur https://app.netlify.com/drop
2. Glisser le dossier `atelier-pdf` entier dans la page.
3. Netlify donne une adresse en https, à renommer dans les réglages du site.

**Sur votre propre hébergement** (par exemple un sous-dossier d'un site WordPress) : envoyer le dossier par FTP, par exemple dans `/atelier-pdf/`. L'outil sera alors disponible à `https://votre-site.fr/atelier-pdf/`.

**GitHub Pages** : créer un dépôt, y déposer le contenu du dossier, puis activer Pages dans les réglages.

## Tester sur votre ordinateur

Double-cliquer sur `lancer-en-local.bat` (Python doit être installé). Le navigateur s'ouvre sur http://localhost:8080/.
Ouvrir directement `index.html` par double-clic ne fonctionne pas : les navigateurs bloquent alors les modules nécessaires.

## Publier une nouvelle version

Après toute modification des fichiers, changer le numéro dans la première ligne de `sw.js` (`atelier-pdf-1.0.0` → `atelier-pdf-1.0.1`). Les personnes qui ont installé l'outil verront « Une nouvelle version est disponible ».

## Composants libres utilisés

pdf.js et Tesseract.js (Apache 2.0), pdf-lib, fontkit, JSZip et SortableJS (MIT), police Atkinson Hyperlegible (SIL OFL). Licences dans `vendor/licenses/`, versions dans `vendor/VERSIONS.txt`.
