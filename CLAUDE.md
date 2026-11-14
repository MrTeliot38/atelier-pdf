# Atelier PDF — instructions pour Claude Code

Ce fichier est lu au début de chaque session. Il résume tout ce qu'il faut savoir pour travailler sur le projet.

## Le projet et son auteur

- **Atelier PDF** : outil libre et gratuit pour retoucher, remplir, signer, annoter, réorganiser et scanner des PDF. Projet personnel de Kevin, partagé librement. Ce n'est **pas** un outil CFDT : aucune marque, aucun logo, aucune mention syndicale.
- Kevin n'est pas développeur de métier : **répondre en français**, simplement, sans jargon inutile. Donner le résultat et ce qu'il doit faire, pas le récit des étapes.
- Dépôt public : `MrTeliot38/atelier-pdf` (licence MIT). Version actuelle : voir `atelier-pdf/js/main.js` (`const VERSION`).

## Règles absolues

1. **La clé de signature Android ne va JAMAIS dans le dépôt**, ni sur GitHub sous quelque forme que ce soit (ni fichier, ni secret GitHub Actions, ni mot de passe dans un script ou un commit). Elle vit sur le PC de Kevin, dans `%USERPROFILE%\Documents\Cle-Atelier-PDF\`, hors du dépôt (voir « Construire et publier »). Vérifier `git status` avant chaque commit : aucun `.jks`, `.keystore`, `.p12`, mot de passe, APK signé ou installateur.
2. **Aucune connexion Internet** dans l'application. Seule exception : la recherche de mises à jour (page des versions GitHub), uniquement à la demande de la personne ou une fois par semaine si elle l'a choisi. Pas de statistiques, pas de police ou de script chargés depuis un CDN, pas de télémétrie. La politique de sécurité (CSP de `index.html`) interdit toute connexion extérieure et ne doit pas être assouplie (ni `unsafe-eval`, ni domaines externes).
3. **Webcam bloquée dans l'application Windows** (le scanner part de photos existantes). Aucune permission accordée par Electron.
4. **Commits** signés de l'identité `MrTeliot38 <MrTeliot38@users.noreply.github.com>`. Ne jamais publier l'adresse e-mail personnelle de Kevin (vérifier `git config user.email` dans le dépôt et le régler sur l'adresse noreply si besoin).
5. **Documents de test personnels** (certificats, courriers, scans de Kevin) : uniquement dans un dossier temporaire hors du dépôt, jamais commités ni publiés.
6. Toute police ou bibliothèque ajoutée doit être libre, embarquée dans `atelier-pdf/vendor/`, avec sa licence dans `vendor/licenses/` et sa version dans `vendor/VERSIONS.txt`.

## Structure du dépôt

| Dossier | Contenu |
|---|---|
| `atelier-pdf/` | L'application web (cœur commun). Modules ES sans outil de construction : on modifie les fichiers et c'est tout. |
| `atelier-pdf-desktop/` | Application Windows (Electron 44). `prepare.js` copie l'application web dans `app/`. |
| `atelier-pdf-android/` | Application Android (Capacitor 8). `prepare.js` copie l'application web dans `www/`. Identifiant `fr.atelierpdf.app`. |
| `.github/workflows/android.yml` | Construit l'APK **non signé** à chaque envoi sur `main` et le dépose sur la branche `builds`. |

Branches : `main` (sources), `builds` (APK non signé + `apksigner.jar`, écrasée par le flux Android), `installateur-windows` (ancien moyen de transfert de l'installateur depuis le cloud ; inutile quand on construit sur le PC).

### Application web (`atelier-pdf/js/`)

- `main.js` : démarrage, `VERSION`. `core.js` : état global (`state`), événements (`on`), `registerFontFamily`, utilitaires `h()` / `toast()`.
- `viewer.js`, `tabs.js`, `pagesPanel.js`, `ui.js`, `ctxbar.js`, `inspector.js` (panneau de droite), `theme*.js`.
- `tools.js` : outils d'édition (Modifier le document, Remplir, Signer, Annoter, Caviarder…), dont `buildEditObject` et `fitOcrSize`.
- `textdetect.js`, `inpaint.js` (effacement du texte d'origine en reconstituant le fond), `pageimages.js`, `pageregions.js`, `formdetect.js`, `selectlayer.js`, `search.js`.
- Polices : `fontmatch.js` (reconnaissance sur image), `systemfonts.js` (polices installées), `fontnames.js` (lecture des noms dans les fichiers de police), `docfont.js` (polices du PDF).
- `scanner.js`, `scancore.js`, `scanworker.js` : scanner de documents. `print.js`, `export.js`, `compress.js`, `share.js`, `recents.js`, `docs.js`, `platform.js`.
- `updates.js` : fenêtre de mise à jour (Windows et Android seulement).
- Bibliothèques (`vendor/`) : pdf.js, pdf-lib, fontkit, tesseract.js (OCR français, hors ligne), JSZip, SortableJS.
- `sw.js` : service worker (mode hors ligne). Sa liste `CORE` doit contenir tout fichier ajouté à l'application ; son nom de cache `atelier-pdf-X.Y.Z` change à chaque version.

### Reconnaissance de police (`fontmatch.js`)

- `REF` : 23 familles fournies dans `vendor/fonts/ref/` (sous-ensembles TTF, 4 styles chacune), soit des clones libres de polices Microsoft (Arial→Liberation Sans, Times New Roman→Liberation Serif, Courier New→Liberation Mono, Verdana→DejaVu Sans, Tahoma→DejaVu Sans Condensed, Calibri→Carlito, Cambria→Caladea, Georgia→Gelasio, Segoe UI→Selawik, Century Gothic→TeX Gyre Adventor, Garamond→EB Garamond, Palatino→P052, Bookman→URW Bookman, Century Schoolbook→C059, Arial Narrow→Nimbus Sans Narrow, Comic Sans→Comic Neue, Franklin Gothic→Libre Franklin), soit des polices libres exactes (Open Sans, Roboto, Montserrat, Source Sans 3, Poppins, Raleway). Lato et Merriweather ont été retirées : elles faussaient les résultats Times/Calibri.
- Candidats = REF + polices importées + polices de l'ordinateur. Sur Windows, les polices que Chromium ne voit pas par leur nom (polices « cloud » d'Office comme Aptos, dans `%LOCALAPPDATA%\Microsoft\FontCache\*\CloudFonts`) sont chargées depuis leurs octets (`familyVariantBytes`).
- Recherche en 2 phases (borne de proportions sans dessin, puis score détaillé : corrélation des images floutées × proportion × pénalité d'épaisseur), avec élagage. Une police système doit battre les polices fournies d'une marge (0,03 ou 0,06 selon le nombre de lettres). Seuil `MATCH_THRESHOLD` = 0,3.
- Taille du texte des scans : `fitOcrSize` (dans `tools.js`) recalcule la taille d'après la largeur de chaque ligne redessinée avec la police retenue (médiane pondérée ; garde-fou entre 0,7 et 1,4 fois la taille OCR).

### Windows (`atelier-pdf-desktop/`)

- `main.js` : processus principal. Bloque toute requête réseau sauf la vérification de mise à jour (`UPDATE_REPO = 'MrTeliot38/atelier-pdf'`, hôtes github.com uniquement), IPC limités (lecture des polices avec liste blanche de dossiers, écriture uniquement là où la personne a choisi), impression, partage par PowerShell.
- `preload.js` : API `window.atelierDesktop`. `build/afterPack.js` : icône, informations de version et « fuses » de sécurité.
- **L'installateur officiel est `build/installer.nsi`** (NSIS écrit à la main : installation sans droits administrateur, mode « mise à jour » si déjà installé). Ce n'est pas l'installateur d'electron-builder.

### Android (`atelier-pdf-android/`)

- Code natif : `android/app/src/main/java/fr/atelierpdf/app/AtelierNativePlugin.java` (fichiers, partage, impression, lecteur par défaut, mise à jour intégrée `checkUpdate` / `installUpdate`) et `MainActivity.java`.
- Permissions : INTERNET (mise à jour uniquement), CAMERA, REQUEST_INSTALL_PACKAGES (installateur de mise à jour intégré). `targetSdk` 36. `versionCode` = majeur×10000 + mineur×100 + correctif, calculé depuis `package.json`.
- Mise à jour intégrée : lit `releases/latest` sur GitHub, prend le premier fichier `.apk`, vérifie son SHA-256 (empreinte GitHub `digest`, sinon ligne « APK : … » des notes de version).

## Changer de version (X.Y.Z)

Modifier **les 5 endroits**, avec le même numéro :
1. `atelier-pdf/js/main.js` : `const VERSION = 'X.Y.Z';`
2. `atelier-pdf/sw.js` : `const VERSION = 'atelier-pdf-X.Y.Z';`
3. `atelier-pdf-android/package.json` : `"version"`, puis `npm install --package-lock-only --ignore-scripts` dans ce dossier.
4. `atelier-pdf-desktop/package.json` : `"version"`, puis même commande dans ce dossier.
5. `atelier-pdf-desktop/build/installer.nsi` : `!define VERSION "X.Y.Z"`.

Correctif → Z+1 ; nouvelle fonction → Y+1.

## Tester

- **Web** : depuis `atelier-pdf/`, `python -m http.server 8080` (ou `lancer-en-local.bat`), puis http://localhost:8080/. Ouvrir `index.html` directement ne marche pas (modules ES).
- **Windows** : `cd atelier-pdf-desktop && npm install && npm start`.
- Tests automatisés possibles avec Playwright (non inclus dans le dépôt). Pour la reconnaissance de police, vérifier sur des scans réels **et** sur des pages de synthèse (texte connu dans des polices connues) : il ne faut perdre aucune des polices déjà reconnues.

## Construire et publier une version

1. Changer de version (ci-dessus), commiter sur `main` avec un message court en français (« X.Y.Z : résumé »), pousser.
2. **APK** : attendre la fin du flux GitHub « APK Android » (`gh run watch` ou onglet Actions), puis récupérer `Atelier-PDF-X.Y.Z-non-signe.apk` et `apksigner.jar` sur la branche `builds` (par exemple `git fetch origin builds` puis `git show origin/builds:<fichier> > <fichier>` dans un dossier hors du dépôt). Signer (Java 17+) :
   La clé est sur le PC de Kevin, **hors du dépôt**, dans `%USERPROFILE%\Documents\Cle-Atelier-PDF\` : `atelier-pdf.jks` (alias `atelierpdf`) et `mot-de-passe.txt` (une seule ligne : le mot de passe, le même pour le fichier et la clé). Kevin autorise Claude Code à s'en servir pour signer. Toujours passer le mot de passe par `file:` pour qu'il n'apparaisse jamais dans une commande ni dans la conversation :
   ```
   set CLE=%USERPROFILE%\Documents\Cle-Atelier-PDF
   java -jar apksigner.jar sign --ks "%CLE%\atelier-pdf.jks" --ks-key-alias atelierpdf --ks-pass "file:%CLE%\mot-de-passe.txt" --out Atelier-PDF-X.Y.Z.apk Atelier-PDF-X.Y.Z-non-signe.apk
   java -jar apksigner.jar verify --print-certs Atelier-PDF-X.Y.Z.apk
   ```
   (Sous PowerShell : `$CLE="$env:USERPROFILE\Documents\Cle-Atelier-PDF"` et `"$CLE\atelier-pdf.jks"`, `"file:$CLE\mot-de-passe.txt"`.) Ne jamais afficher, copier, déplacer ni modifier ces fichiers, ni les copier dans le dépôt. Le certificat doit afficher l'empreinte SHA-256 `59:5E:EE:5A:F3:45:03:EF:89:88:AE:A4:90:DD:A3:17:7C:52:69:84:8B:0A:05:9B:DD:D2:6C:10:1D:AC:7E:D5`. Sinon, ne rien publier. Si le dossier est introuvable, demander à Kevin où est la clé.
3. **Installateur Windows** (sur le PC, NSIS installé : `winget install NSIS.NSIS`) :
   ```
   cd atelier-pdf-desktop
   npm install
   node prepare.js
   npx electron-builder --win dir --x64
   makensis build\installer.nsi
   ```
   Résultat : `dist\Atelier-PDF-Setup-X.Y.Z.exe` (environ 110 Mo). Le tester (installation par-dessus la version précédente, puis lancement).
4. **Release GitHub** (`gh` installé et connecté : `winget install GitHub.cli` puis `gh auth login`) :
   ```
   gh release create vX.Y.Z Atelier-PDF-X.Y.Z.apk dist\Atelier-PDF-Setup-X.Y.Z.exe --target main --title "Atelier PDF X.Y.Z" --notes-file notes.md
   ```
   Notes de version en français, sur ce modèle :
   ```
   ## Nouveautés            (ou « ## Correctif »)
   - **Fonction** : explication courte, pour un utilisateur non technicien

   ## Télécharger
   - **Android** : `Atelier-PDF-X.Y.Z.apk` (s'installe par-dessus la version précédente)
   - **Windows** : `Atelier-PDF-Setup-X.Y.Z.exe` (si Windows affiche « Windows a protégé votre ordinateur » : « Informations complémentaires » › « Exécuter quand même »)

   Aucun document n'est envoyé sur Internet : tout reste sur votre appareil.

   ## Empreintes SHA-256
   - APK : `<sha256 de l'APK signé>`
   - EXE : `<sha256 de l'installateur>`
   ```
   (Sous PowerShell : `Get-FileHash <fichier> -Algorithm SHA256`.) Les noms de fichiers doivent rester `Atelier-PDF-X.Y.Z.apk` et `Atelier-PDF-Setup-X.Y.Z.exe` : la mise à jour intégrée cherche le premier `.apk` / `.exe` de la dernière release.
5. Supprimer ensuite les APK, installateurs et `notes.md` restés hors du dépôt s'ils ne servent plus.

## Statut Google / Android

- Le nom de package `fr.atelierpdf.app` est **enregistré et validé** dans l'Android Developer Console (compte « distribution complète », vérification des développeurs Android imposée par Google à partir de 2026-2027), avec la clé ci-dessus. Ne jamais changer de clé ni de nom de package.
- Play Protect peut encore signaler l'APK comme suspect, surtout à cause de l'installateur de mise à jour intégré (REQUEST_INSTALL_PACKAGES).
- **Play Store : pas encore lancé.** Il faudrait un compte Google Play Console séparé (25 $), un test fermé de 12 testeurs pendant 14 jours, une variante sans installateur intégré ni REQUEST_INSTALL_PACKAGES (le Play Store interdit l'auto-mise à jour), un `.aab` signé avec la même clé, une fiche (textes, icône, captures, politique de confidentialité, formulaire « sécurité des données », classification).

## Idées proposées, non décidées (demander à Kevin avant de faire)

- Retirer l'installateur de mise à jour intégré sur Android (moins d'alertes Play Protect, obligatoire pour le Play Store).
- Version Play Store (voir ci-dessus).
- Vérification automatique des mises à jour activée par défaut.
- Mode « Paragraphe » : conserver les retours à la ligne d'origine (aujourd'hui des lignes centrées, comme des horaires, fusionnent en un seul paragraphe).
- Signature de l'installateur Windows (SignPath Foundation gratuit pour le logiciel libre, Azure Artifact Signing, ou Microsoft Store) pour supprimer l'alerte SmartScreen.

## Pièges connus

- Oublier un fichier dans la liste `CORE` de `sw.js` : l'application web installée ne fonctionne plus hors ligne.
- Oublier de changer le nom de cache de `sw.js` : les personnes ne reçoivent pas la nouvelle version web.
- `electron-builder --win nsis` produit un autre installateur que le nôtre : toujours utiliser `build\installer.nsi`.
- Polices ajoutées à la reconnaissance : chaque nouvelle famille peut « voler » des résultats aux autres. Vérifier sur l'ensemble des tests avant de garder.
