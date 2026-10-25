# Atelier PDF

Outil libre et gratuit pour retoucher, remplir, signer, réorganiser et partager des PDF — sans rien envoyer sur Internet.

| Dossier | Contenu |
|---|---|
| `atelier-pdf/` | L'application web (installable depuis Chrome / Edge, fonctionne hors ligne). C'est le cœur commun à toutes les versions. |
| `atelier-pdf-desktop/` | La version Windows (Electron) et son installateur. |
| `atelier-pdf-android/` | La version Android (Capacitor) : scanner de documents, ouverture des PDF reçus, partage. |

## Version Android

L'APK est construit automatiquement par GitHub (onglet **Actions**, flux « APK Android ») avec les outils officiels d'Android, à chaque modification. Le résultat, aligné mais non signé, est déposé sur la branche `builds`.

La signature se fait ensuite hors de GitHub avec la clé de l'application : cette clé ne doit **jamais** être déposée dans ce dépôt public. Les mises à jour d'Android doivent être signées avec la même clé pour s'installer par-dessus la version précédente.

Signer un APK (Java 17 ou plus) :

```
java -jar apksigner.jar sign --ks atelier-pdf.jks --out Atelier-PDF.apk Atelier-PDF-x.y.z-non-signe.apk
java -jar apksigner.jar verify --print-certs Atelier-PDF.apk
```

## Confidentialité

Aucune version ne se connecte à Internet : les documents restent sur l'appareil.
