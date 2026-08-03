# SkipSensei (extension Chrome — Manifest V3)

Extension pour anime-sama.to qui affiche un bouton flottant "Skip Intro"
sur les pages vidéo, et qui permet d'enregistrer/modifier les timings
d'intro par série via un popup.

## Pourquoi deux content scripts ?

Sur anime-sama.to, la vidéo n'est **pas** directement sur la page : elle
est chargée dans une `<iframe id="playerDF">` qui pointe vers un site
tiers différent selon le "Lecteur" choisi (Lecteur 1 à 5 selon les
épisodes). Domaines observés sur anime-sama.to (VOSTFR et VF, plusieurs
dizaines de séries) :

- `vidmoly.to` / `vidmoly.biz`
- `video.sibnet.ru`
- `sendvid.com`
- `ansembed.net`
- `smoothpre.com`
- `oneupload.to`
- `lpayer.embed4me.com`
- `movearnpre.com`
- `uqload.is`
- `minochinos.com`
- `www.myvi.top` / `www.myvi.tv`
- `vk.com` / `vkvideo.ru` (chemin `/video_ext.php` seulement)

Les trois premiers (vidmoly/sibnet/sendvid) sont les lecteurs "principaux"
les plus fréquents ; les suivants apparaissent surtout comme lecteur de
repli sur des épisodes ponctuels où le lecteur principal est indisponible
— d'où l'intérêt de tous les couvrir plutôt que seulement les 3 les plus
visibles.

Un content script ne peut pas lire le contenu d'une iframe d'un **autre
domaine** (sécurité du navigateur : same-origin policy). Il faut donc
deux scripts séparés qui communiquent entre eux par `window.postMessage` :

```
anime-sama.to (page principale)          iframe (vidmoly / sibnet / sendvid)
┌─────────────────────────────┐          ┌───────────────────────────────┐
│ content.js                  │          │ player-frame.js               │
│ - lit document.title        │  postMessage  │ - trouve <video>         │
│ - résout le timing AniSkip  │ ────────────► │ - affiche + positionne   │
│ - stocke/lit chrome.storage │ ◄──────────── │   le bouton flottant sur │
│                              │  postMessage  │   la vidéo, gère clics   │
└─────────────────────────────┘          └───────────────────────────────┘
```

Le bouton flottant lui-même vit dans `player-frame.js`, pas `content.js` :
un élément ajouté sur la page principale ne peut de toute façon pas
apparaître "par-dessus" la vidéo une fois que l'iframe (cross-origin) passe
en plein écran — seul le sous-arbre de l'élément plein écran est rendu.

## Structure du projet

```
anime-skip-intro/
├── manifest.json     → déclare les DEUX content scripts (voir ci-dessous)
├── content.js        → tourne sur le site anime : résolution du timing + nom de série
├── player-frame.js   → tourne DANS l'iframe du lecteur : trouve/contrôle <video> + bouton flottant
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

Le bouton est construit et positionné par `player-frame.js`, ancré en bas
à droite de la balise `<video>` elle-même (style Netflix), pas de la page
entière. `content.js` continue de résoudre le timing et lui envoie via
`postMessage` (`set-skip-data`) ; le bouton lui répond de la même façon
(`skip-performed` / `mark-intro-end`) pour que `content.js` enregistre les
stats/l'historique.

- Aucun timing enregistré pour la série détectée → bouton
  **"🏁 Marquer fin d'intro"**, toujours visible. Un clic lit
  `video.currentTime` directement (même document) et l'envoie à
  `content.js`, qui l'enregistre comme fin d'intro (`fin`) pour cette
  série, avec `debut: 0` par défaut.
- Un timing existe déjà → bouton **"⏭ Skip Intro"**, visible seulement de
  0,5s avant le début de l'intro jusqu'à sa fin (plus quelques secondes
  après un skip, le temps que la lecture reprenne réellement). Un clic
  fait `video.currentTime = timing.fin` directement.
- Le champ `debut` n'est pas modifiable depuis la page elle-même : il
  peut être ajusté manuellement depuis le popup si besoin.
- En plein écran, le bouton n'apparaît que si le lecteur met en plein
  écran un conteneur autour de la vidéo (cas de video.js, confirmé sur
  sibnet) et non la balise `<video>` elle-même directement — dans ce
  second cas, aucun élément ne peut être injecté dedans, limitation du
  navigateur et non un bug de l'extension.

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
  `player-frame.js`) et un bouton manuel "Skip Intro" reste disponible.
  Raccourcis clavier sur la page (S / M / A) — voir `RACCOURCIS_CLAVIER`
  dans `content.js`.
