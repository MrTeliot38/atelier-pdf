# Atelier PDF — application Windows

Ce dossier fabrique l'installateur Windows (`Atelier-PDF-Setup-x.y.z.exe`) à partir de l'application web située dans le dossier voisin `atelier-pdf`.

## Ce que l'application Windows ajoute

- Installation classique : raccourci sur le Bureau et dans le menu Démarrer, désinstallation depuis les Paramètres Windows.
- **Mises à jour** : lancer le nouvel installateur sur un ordinateur où Atelier PDF est déjà installé fait une mise à jour (une seule fenêtre « Mettre à jour », même dossier, réglages et raccourcis conservés, relance automatique). Une seule ligne « Atelier PDF » reste dans les applications installées.
- **Polices de l'ordinateur** : toutes les polices installées (C:\Windows\Fonts et polices installées pour l'utilisateur) sont proposées dans le choix de police, avec aperçu, recherche et variantes gras / italique. Quand vous corrigez un texte, l'application retrouve automatiquement la police d'origine si elle est installée.
- **Lecteur PDF par défaut** : Atelier PDF est inscrit dans « Applications par défaut » de Windows. Le menu ⋮ › « Définir comme lecteur PDF par défaut… » ouvre directement la bonne page (Windows ne permet pas à un logiciel de se choisir lui-même). Chaque PDF ouvert par double-clic s'ouvre dans un nouvel onglet de la fenêtre déjà ouverte (« Nouvelle fenêtre » reste disponible dans le menu ⋮).
- **Enregistrer** (Ctrl+S) réécrit le fichier d'origine ; **Enregistrer sous** (Ctrl+Maj+S) en fait une copie.
- **Partager** : e-mail avec le PDF en pièce jointe (Outlook classique, Thunderbird… ; avec les autres messageries, le PDF est copié pour être collé), WhatsApp (le PDF est copié et WhatsApp s'ouvre : choisir la conversation puis Ctrl+V), ou simple copie du fichier.
- Confirmation avant de fermer si des modifications ne sont pas enregistrées.
- **Scanner** à partir de photos de documents (prises avec un téléphone) : redressées et nettoyées comme un scan. La webcam n'est pas utilisée.
- Fonctionne entièrement sans connexion.

## Sécurité

- Installation pour l'utilisateur courant uniquement, **sans droits administrateur** : rien n'est écrit dans C:\Program Files, dans les réglages système ni dans les services Windows. Pas de tâche planifiée, pas de démarrage automatique, pas de mise à jour en arrière-plan. La désinstallation retire le dossier et toutes les clés de registre créées.
- **Aucune connexion réseau** : l'application bloque toute requête vers Internet (les documents ne quittent jamais l'ordinateur). Seuls les liens cliqués volontairement (https, e-mail) s'ouvrent dans le navigateur.
- Electron 44 (version maintenue), page isolée du système (`contextIsolation`, `sandbox`), politique de sécurité du contenu stricte, aucune permission accordée (caméra, micro, position…).
- Le processus principal n'accepte d'ordres que de la page de l'application, et n'écrit un fichier que là où la personne l'a ouvert ou choisi (« Enregistrer sous »).
- Verrous intégrés à l'exécutable (« fuses ») : il ne peut pas servir d'interpréteur Node.js, ignore NODE_OPTIONS et le débogage en ligne de commande, et ne charge que sa propre archive.
- L'envoi par e-mail passe par une commande PowerShell transmise directement (sans script temporaire ni contournement de la stratégie d'exécution).

## Avertissement de Windows (SmartScreen)

L'installateur n'est pas signé numériquement : Windows affiche « Windows a protégé votre ordinateur ». Cliquer sur **Informations complémentaires**, puis **Exécuter quand même**.

Pour l'éviter **sur un ordinateur** : avant de lancer le fichier téléchargé, clic droit › Propriétés › cocher **Débloquer** › OK.

Pour le supprimer **pour tout le monde**, il faut signer l'installateur :
- **Azure Artifact Signing** (Microsoft) : environ 10 $ par mois ; dans l'Union européenne, réservé aux organisations (une association ou un syndicat déclaré peut convenir), pas aux particuliers.
- **SignPath Foundation** : signature gratuite pour les logiciels libres publiés avec leur code source (licence libre, dépôt public, construction automatisée).
- **Microsoft Store** : inscription gratuite pour les développeurs individuels ; l'application installée depuis le Store n'affiche pas l'avertissement.

Dans tous les cas, la réputation SmartScreen s'acquiert avec le nombre de téléchargements : un nouvel installateur peut encore être signalé pendant quelques jours après sa sortie.

## Refaire l'installateur après une modification

Sur un PC Windows avec Node.js installé (https://nodejs.org, version LTS) :

```
cd atelier-pdf-desktop
npm install
npm run dist
```

L'installateur apparaît dans `dist\`. Pour essayer sans installer : `npm start`.
Pensez à augmenter le numéro `version` dans `package.json` à chaque nouvelle version.
