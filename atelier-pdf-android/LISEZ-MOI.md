# Atelier PDF — application Android

Ce dossier fabrique l'APK Android à partir de l'application web du dossier voisin `atelier-pdf` (Capacitor).

## Ce que l'application Android ajoute

- **Scanner de documents** : photographier une ou plusieurs feuilles. Les bords sont repérés automatiquement, la perspective est redressée et le papier blanchi (ombres effacées). Chaque page peut être recadrée (coins déplaçables avec loupe), tournée, retirée ou réordonnée. Rendus : Couleur, Document, Gris, Noir et blanc.
- **Qualité du PDF** au choix : faible (≈ 150 ppp, idéal WhatsApp et e-mail), moyenne (≈ 200 ppp) ou élevée (≈ 300 ppp), avec le poids estimé.
- **Partager** le PDF (WhatsApp, e-mail, Drive, Messages…) par le menu de partage d'Android, l'**enregistrer** dans le dossier de son choix, ou l'**ouvrir dans l'éditeur** pour le modifier, le signer, l'annoter.
- **Ouvrir avec Atelier PDF** depuis Fichiers, Gmail, WhatsApp… et **Partager vers Atelier PDF** (un PDF s'ouvre dans l'éditeur, des photos ouvrent le scanner).
- **Lecteur PDF par défaut** : menu ⋮ › « Lecteur PDF par défaut… » (ou le lien de l'écran d'accueil). Android ne laisse pas une application se désigner elle-même : l'écran indique quelle application ouvre actuellement les PDF, ouvre ses réglages pour « Effacer les préférences par défaut », puis ouvre un PDF d'essai où il suffit de choisir Atelier PDF et « Toujours ».
- **Imprimer** par le service d'impression d'Android.
- **Fichiers récents** sur l'écran d'accueil : les derniers PDF ouverts (depuis Fichiers, Gmail, WhatsApp…) se rouvrent d'un geste, même si l'original n'est plus accessible. Copie gardée dans l'espace privé de l'application uniquement.
- Toutes les fonctions de l'éditeur : corriger le texte (y compris des scans), rechercher et remplacer, remplir, signer, annoter, caviarder, réduire la taille, réorganiser les pages, exporter en images.

## Confidentialité et sécurité

- Aucune donnée n'est envoyée sur Internet : la politique de sécurité de la page interdit toute connexion extérieure.
- Permissions : appareil photo (demandé à la première utilisation du scanner). Aucune permission de stockage : Android demande à chaque fois où enregistrer.
- Sauvegarde automatique Android désactivée (`allowBackup=false`).

## Construire

La construction se fait automatiquement sur GitHub (flux « APK Android ») : voir le `README.md` à la racine du dépôt.

Sur un ordinateur avec Node.js 22, Java 21 et le SDK Android :

```
npm ci
node prepare.js
npx cap sync android
cd android && ./gradlew assembleRelease
```

L'APK obtenu n'est pas signé ; il faut le signer avec la clé de l'application (voir `README.md`). **Gardez précieusement la clé et son mot de passe** : sans eux, impossible de publier une mise à jour qui s'installe par-dessus la version existante.
