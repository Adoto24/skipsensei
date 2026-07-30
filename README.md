# SkipSensei (extension Chrome — Manifest V3)

Extension pour anime-sama.to qui affiche un bouton flottant "Skip Intro"
sur les pages vidéo, et qui permet d'enregistrer/modifier les timings
d'intro par série via un popup.

## Pourquoi deux content scripts ?

Sur anime-sama.to, la vidéo n'est **pas** directement sur la page : elle
est chargée dans une `<iframe id="playerDF">` qui pointe vers un site
tiers différent selon le "Lecteur" choisi (Lecteur 1/2/3) :

- `vidmoly.to` / `vidmoly.biz`
- `video.sibnet.ru`
- `sendvid.com`

Un content script ne peut pas lire le contenu d'une iframe d'un **autre
domaine** (sécurité du navigateur : same-origin policy). Il faut donc
deux scripts séparés qui communiquent entre eux par `window.postMessage` :

```
anime-sama.to (page principale)          iframe (vidmoly / sibnet / sendvid)
┌─────────────────────────────┐          ┌───────────────────────────────┐
│ content.js                  │          │ player-frame.js               │
│ - lit document.title        │  postMessage  │ - trouve <video>         │
│ - affiche le bouton flottant│ ────────────► │ - fait video.currentTime │
│ - stocke/lit chrome.storage │ ◄──────────── │   = X, ou renvoie le     │
│                              │  postMessage  │   temps actuel          │
└─────────────────────────────┘          └───────────────────────────────┘
```

## Structure du projet

```
anime-skip-intro/
├── manifest.json     → déclare les DEUX content scripts (voir ci-dessous)
├── content.js        → tourne sur le site anime : bouton flottant + nom de série
├── content.css       → style du bouton flottant
├── player-frame.js   → tourne DANS l'iframe du lecteur : trouve/contrôle <video>
├── popup.html        → interface du popup (dashboard, stats, historique)
├── popup.js          → logique du popup (lecture/édition/suppression)
├── popup.css         → style du popup
├── icons/            → icônes de l'extension (16/32/48/128, générées, style accent)
└── README.md         → ce fichier
```

Dans `manifest.json`, remarque les deux blocs `content_scripts` :

1. Un bloc qui matche `anime-sama.to` → injecte `content.js` + `content.css`
   (comportement par défaut : uniquement dans la frame principale).
2. Un bloc qui matche les domaines des lecteurs (`vidmoly.biz`, etc.) avec
   `"all_frames": true` → injecte `player-frame.js` **dans l'iframe**, peu
   importe quel site l'a intégrée. Sans `all_frames: true`, Chrome
   n'injecterait ce script que si ces domaines étaient ouverts en tant que
   page principale d'un onglet, jamais à l'intérieur d'une iframe.

## Format du titre de page (déjà géré)

Sur anime-sama.to, le titre d'onglet ressemble à :

```
One Piece - Saga 1 (East Blue) | Anime-Sama - Streaming et catalogage d'animes et scans.
```

`extraireNomSerie()` dans `content.js` coupe sur le premier `" - "` et
récupère donc `"one piece"`. Ça fonctionne tel quel pour ce site.

## Charger l'extension en mode développeur

1. Ouvre Chrome et va sur `chrome://extensions/`.
2. Active **"Mode développeur"** en haut à droite.
3. Clique sur **"Charger l'extension non empaquetée"** (*Load unpacked*).
4. Sélectionne le dossier `anime-skip-intro` (celui qui contient
   `manifest.json`).
5. Va sur un épisode d'anime-sama.to : le bouton flottant doit apparaître
   en bas à droite une fois la vidéo chargée dans l'iframe.

## Recharger l'extension après une modification

À chaque modification de n'importe quel fichier, retourne sur
`chrome://extensions/` et clique sur l'icône de rechargement (🔄) de
l'extension. Pour `popup.html` / `popup.js`, il suffit de refermer/rouvrir
le popup.

## Fonctionnement du bouton flottant

- Aucun timing enregistré pour la série détectée → bouton
  **"🏁 Marquer fin d'intro"**. Un clic demande à l'iframe le temps actuel
  de la vidéo (via `postMessage`) et l'enregistre comme fin d'intro
  (`fin`) pour cette série, avec `debut: 0` par défaut.
- Un timing existe déjà → bouton **"⏭ Skip Intro"**. Un clic demande à
  l'iframe de faire `video.currentTime = timing.fin`.
- Le champ `debut` n'est pas modifiable depuis la page elle-même : il
  peut être ajusté manuellement depuis le popup si besoin.
- Si l'iframe ne répond pas sous 1,5 seconde (lecteur pas encore chargé,
  ou domaine non géré), une alerte invite à changer de lecteur.

## Si anime-sama.to ajoute/change un lecteur vidéo

Si un jour "Lecteur 4" charge un nouveau domaine non listé, il suffit
d'ajouter ce domaine au tableau `matches` du deuxième bloc
`content_scripts` dans `manifest.json`, puis de recharger l'extension.

## Limites connues / pistes d'amélioration

- Détection instantanée dans la plupart des cas (listener `change` sur le
  `<select>` d'épisode + `MutationObserver` débouncé sur l'apparition de
  l'iframe), avec le sondage toutes les 3 secondes gardé uniquement comme
  filet de sécurité en cas de changement non couvert par ces deux-là.
- Si un des lecteurs tiers imbrique lui-même une autre iframe interne,
  `player-frame.js` ne la traversera pas automatiquement (à vérifier au
  cas par cas si "Marquer fin d'intro" ne répond pas sur un lecteur donné).
- Auto-skip existe déjà (toggle dans le popup, exécuté par
  `player-frame.js`) et un bouton manuel "Skip Intro" reste disponible ;
  pas de raccourcis clavier pour l'instant.
