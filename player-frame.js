// Runs inside the player iframe (vidmoly.biz, video.sibnet.ru,
// sendvid.com...), not on anime-sama.to itself — see manifest.json's
// separate content_script with "all_frames": true. Listens for messages
// from content.js and acts directly on the <video> element.

const CANAL = "anime-skip-intro";

// content.js knows the series/episode + resolved timing; this iframe only
// has the <video> element, so it receives the skip window + preference
// via "set-skip-data" and polls playback position on its own.
let skipDebut = null;
let skipFin = null;
let autoSkipEnabled = false;
let skipSerie = null;
let skipEpisode = null;
let skipMalId = null;
let skipSite = null;

const AUTO_SKIP_POLL_MS = 500;
// Small buffer so the seek doesn't keep re-triggering once landed right
// at (or past) the target time due to poll timing.
const AUTO_SKIP_EPSILON_S = 0.25;

// The floating button lives here (in the same document as <video>)
// rather than on the parent page: positioning relative to the video
// needs this document's own layout, and a cross-origin iframe's
// fullscreen only renders that iframe's own subtree — a parent-page
// element could never appear "over" the video once fullscreen.
let boutonConteneurEl = null;
let boutonEl = null;
const videosAvecEcouteurs = new WeakSet(); // avoids attaching playing/timeupdate twice to the same <video>

// Only shown starting this long before the intro's start time.
const BOUTON_MARGE_AVANT_DEBUT_S = 0.5;
// How long the button stays visible after a skip is confirmed resumed
// (see onProgressionLecture) before it's allowed to hide again.
const BOUTON_DELAI_GRACE_APRES_SKIP_MS = 3000;
// Netflix-style inset from the video's own bottom-right corner.
const BOUTON_MARGE_PX = 24;

// True from when a skip is triggered until playback is confirmed resumed
// past the seek target (see onProgressionLecture) — buffering can take a
// moment, so a plain timer-from-click would hide the button while the
// video is still loading. Kept visible for BOUTON_DELAI_GRACE_APRES_SKIP_MS
// after that confirmation instead.
let skipVenantDeSeProduire = false;
let seekCible = null;
let boutonVisibleJusquA = null;

// Shared with content.js — keep in sync if renamed there.
const STORAGE_KEY_STATS = "asi-stats";
const STORAGE_KEY_HISTORY = "asi-history";
const HISTORIQUE_TAILLE_MAX = 20;
const STORAGE_KEY_ACTIVITY = "asi-activity";
const STORAGE_KEY_FAVORIS_SERIES = "asi-fav-series";
const STORAGE_KEY_FAVORIS_SITES = "asi-fav-sites";
const STORAGE_KEY_RECORD = "asi-record";
const STORAGE_PREFIX_POSTER = "asi-poster::";
const JIKAN_ANIME_URL = "https://api.jikan.moe/v4/anime";
const FETCH_TIMEOUT_MS = 8000;
const POSTER_ECHEC_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
function storageSet(items) {
  return new Promise((resolve) => chrome.storage.local.set(items, resolve));
}

// Duplicated from content.js/resolution.js: this file runs in a separate
// content-script context with no shared module to import from.
async function fetchAvecTimeout(url, options = {}, delaiMs = FETCH_TIMEOUT_MS) {
  const controleur = new AbortController();
  const timeoutId = setTimeout(() => controleur.abort(), delaiMs);
  try {
    return await fetch(url, { ...options, signal: controleur.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// Same poster cache as content.js's assurerPosterEnCache: never awaited
// by its caller so a slow/failed Jikan request can't block recording the
// auto-skip. Successful lookups are permanent; failed ones expire after
// POSTER_ECHEC_TTL_MS.
async function assurerPosterEnCache(malId) {
  if (malId == null) return;

  const cle = `${STORAGE_PREFIX_POSTER}${malId}`;
  try {
    const cache = await storageGet([cle]);
    const entree = cache[cle];
    if (entree && (entree.url || Date.now() - entree.cachedAt < POSTER_ECHEC_TTL_MS)) {
      return; // a real url (permanent), or a recent-enough failure (still in cooldown)
    }

    let url = null;
    try {
      const reponse = await fetchAvecTimeout(`${JIKAN_ANIME_URL}/${malId}`);
      if (reponse.ok) {
        const donnees = await reponse.json();
        url = donnees?.data?.images?.jpg?.image_url || donnees?.data?.images?.jpg?.large_image_url || null;
      }
    } catch (erreur) {
      console.warn("[SkipSensei] Jikan poster fetch failed:", erreur.message);
    }

    await storageSet({ [cle]: { url, cachedAt: Date.now() } });
  } catch (erreur) {
    console.warn("[SkipSensei] Poster cache lookup failed:", erreur.message);
  }
}

function cleMoisActuel() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function cleJourActuel() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Same logic as content.js's enregistrerActiviteEtRecords, duplicated for
// the same reason storageGet/fetchAvecTimeout already are.
async function enregistrerActiviteEtRecords(nomSerie, episode, site, secondesGagnees, horodatage) {
  const secondes = Math.max(secondesGagnees, 0);
  const resultat = await storageGet([
    STORAGE_KEY_ACTIVITY,
    STORAGE_KEY_FAVORIS_SERIES,
    STORAGE_KEY_FAVORIS_SITES,
    STORAGE_KEY_RECORD,
  ]);

  const activite = resultat[STORAGE_KEY_ACTIVITY] || {};
  const jour = cleJourActuel();
  const activiteDuJour = activite[jour] || { skips: 0, secondesGagnees: 0 };
  activiteDuJour.skips += 1;
  activiteDuJour.secondesGagnees += secondes;
  activite[jour] = activiteDuJour;

  const favSeries = resultat[STORAGE_KEY_FAVORIS_SERIES] || {};
  if (nomSerie) favSeries[nomSerie] = (favSeries[nomSerie] || 0) + 1;

  const favSites = resultat[STORAGE_KEY_FAVORIS_SITES] || {};
  if (site) favSites[site] = (favSites[site] || 0) + 1;

  const recordActuel = resultat[STORAGE_KEY_RECORD] || null;
  const record =
    !recordActuel || secondes > recordActuel.secondes
      ? { secondes, serie: nomSerie || null, episode: episode ?? null, horodatage }
      : recordActuel;

  await storageSet({
    [STORAGE_KEY_ACTIVITY]: activite,
    [STORAGE_KEY_FAVORIS_SERIES]: favSeries,
    [STORAGE_KEY_FAVORIS_SITES]: favSites,
    [STORAGE_KEY_RECORD]: record,
  });
}

// Same recording content.js does for a manual click, tagged declencheur:
// "auto" since nothing was clicked — the video crossed the intro window
// on its own while auto-skip was on.
async function enregistrerSkipAutomatique(secondesGagnees, nomSerie, episode, malId, site) {
  const [statsResultat, historiqueResultat] = await Promise.all([
    storageGet([STORAGE_KEY_STATS]),
    storageGet([STORAGE_KEY_HISTORY]),
  ]);

  const stats = statsResultat[STORAGE_KEY_STATS] || {};
  const mois = cleMoisActuel();
  const statsDuMois = stats[mois] || { skips: 0, secondesGagnees: 0 };
  statsDuMois.skips += 1;
  statsDuMois.secondesGagnees += secondesGagnees;
  stats[mois] = statsDuMois;

  const horodatage = Date.now();
  const historique = historiqueResultat[STORAGE_KEY_HISTORY] || [];
  historique.unshift({
    serie: nomSerie || "série inconnue",
    episode,
    secondes: secondesGagnees,
    declencheur: "auto",
    horodatage,
    malId: malId ?? null,
    site: site ?? null,
  });

  await Promise.all([
    storageSet({ [STORAGE_KEY_STATS]: stats }),
    storageSet({ [STORAGE_KEY_HISTORY]: historique.slice(0, HISTORIQUE_TAILLE_MAX) }),
    enregistrerActiviteEtRecords(nomSerie, episode, site, secondesGagnees, horodatage),
  ]);

  // Fire-and-forget: never let a Jikan lookup delay or fail the skip
  // recording above.
  assurerPosterEnCache(malId);
}

function verifierAutoSkip() {
  if (!autoSkipEnabled || skipDebut == null || skipFin == null) return;

  const video = document.querySelector("video");
  if (!video) return;

  const t = video.currentTime;
  if (t >= skipDebut && t < skipFin - AUTO_SKIP_EPSILON_S) {
    effectuerSkip(video, "auto");
  }
}

// Shared by both trigger paths: the auto-skip poll above and the
// floating button's click handler (surClicBouton, reachable directly or
// via content.js's "trigger-skip" message / S shortcut).
function effectuerSkip(video, declencheur) {
  const t = video.currentTime;
  // Auto-skip credits actual seconds skipped from wherever playback
  // currently was; a manual click credits the intro's full nominal
  // duration regardless of where the user clicked.
  const secondesGagnees = declencheur === "auto" ? skipFin - t : typeof skipDebut === "number" ? skipFin - skipDebut : 0;

  video.currentTime = skipFin;
  skipVenantDeSeProduire = true;
  seekCible = skipFin;

  if (declencheur === "auto") {
    enregistrerSkipAutomatique(secondesGagnees, skipSerie, skipEpisode, skipMalId, skipSite);
  } else {
    // content.js already owns "clic" recording — just report the event
    // back to it.
    window.parent.postMessage({ canal: CANAL, type: "skip-performed", secondesGagnees }, "*");
  }
}

// Confirms a skip actually resumed playback past its seek target, rather
// than just starting a timer at click time — buffering can otherwise
// leave the video stuck for a few seconds right after the seek.
function onProgressionLecture() {
  if (!skipVenantDeSeProduire || seekCible == null) return;
  const video = document.querySelector("video");
  if (!video || video.paused) return;
  if (video.currentTime >= seekCible - AUTO_SKIP_EPSILON_S) {
    skipVenantDeSeProduire = false;
    boutonVisibleJusquA = Date.now() + BOUTON_DELAI_GRACE_APRES_SKIP_MS;
  }
}

function injecterStylesBouton() {
  if (document.getElementById("asi-style-bouton")) return;
  const style = document.createElement("style");
  style.id = "asi-style-bouton";
  style.textContent = `
    #asi-floating-container {
      position: fixed;
      z-index: 2147483647;
      animation: asi-fade-in 0.15s ease-out;
    }
    #asi-floating-button {
      background-color: #1e1e24;
      color: #ffffff;
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 9px;
      padding: 9px 14px;
      font-size: 14px;
      font-weight: bold;
      font-family: Arial, Helvetica, sans-serif;
      cursor: pointer;
      transition: transform 0.12s ease, background-color 0.12s ease;
    }
    #asi-floating-button:hover {
      background-color: #e61e1e;
      border-color: #e61e1e;
      transform: scale(1.02);
    }
    #asi-floating-button:active {
      transform: scale(0.98);
    }
    @keyframes asi-fade-in {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(style);
}

// Runs the button's action for whatever mode currently applies — Skip
// Intro when resolved, Mark Intro End otherwise. Called both by the
// button's own click listener and by content.js's "trigger-skip"/
// "trigger-mark" messages (S/M shortcuts).
function surClicBouton() {
  const video = document.querySelector("video");
  if (!video) return;

  const resolu = typeof skipDebut === "number" && typeof skipFin === "number";
  if (resolu) {
    effectuerSkip(video, "clic");
  } else {
    window.parent.postMessage({ canal: CANAL, type: "mark-intro-end", time: video.currentTime }, "*");
  }
}

function obtenirOuCreerBouton(video) {
  if (!boutonConteneurEl) {
    injecterStylesBouton();
    boutonConteneurEl = document.createElement("div");
    boutonConteneurEl.id = "asi-floating-container";
    boutonEl = document.createElement("button");
    boutonEl.id = "asi-floating-button";
    boutonEl.addEventListener("click", surClicBouton);
    boutonConteneurEl.appendChild(boutonEl);
    (video.parentElement || document.body).appendChild(boutonConteneurEl);
  }

  if (!videosAvecEcouteurs.has(video)) {
    video.addEventListener("playing", onProgressionLecture);
    video.addEventListener("timeupdate", onProgressionLecture);
    videosAvecEcouteurs.add(video);
  }

  return { conteneur: boutonConteneurEl, bouton: boutonEl };
}

// Netflix-style: fixed to the video's own bottom-right corner, recomputed
// on every poll tick + resize + fullscreenchange.
function positionnerBouton(video) {
  if (!boutonConteneurEl) return;
  const rect = video.getBoundingClientRect();
  boutonConteneurEl.style.right = `${Math.max(0, window.innerWidth - rect.right + BOUTON_MARGE_PX)}px`;
  boutonConteneurEl.style.bottom = `${Math.max(0, window.innerHeight - rect.bottom + BOUTON_MARGE_PX)}px`;
}

// Re-parents the button into whichever element is actually fullscreen, so
// it keeps rendering instead of disappearing once the video's cross-origin
// iframe goes fullscreen (only the fullscreen element's own subtree
// renders). Falls back to the video's normal parent once fullscreen exits.
//
// Some players (e.g. video.js, used by the sibnet embed) call
// requestFullscreen() directly on <video> rather than a wrapping
// container. A bare <video> can only contain <track>/<source> children,
// so the button genuinely cannot render during fullscreen there — a real
// browser limitation, not a bug to work around further.
function assurerBonParentPourFullscreen() {
  if (!boutonConteneurEl) return;
  const video = document.querySelector("video");
  const parentHorsPleinEcran = (video && video.parentElement) || document.body;
  const fsEl = document.fullscreenElement;

  if (!fsEl) {
    if (boutonConteneurEl.parentElement !== parentHorsPleinEcran) {
      parentHorsPleinEcran.appendChild(boutonConteneurEl);
    }
    return;
  }

  if (fsEl.tagName === "VIDEO") return; // structural limitation, see above

  if (!fsEl.contains(boutonConteneurEl)) {
    fsEl.appendChild(boutonConteneurEl);
  }
}

// Skip Intro's visibility window ([debut - 0.5, fin)), extended by the
// post-skip grace period. Mark Intro End stays visible the whole time —
// there's no way to know in advance when the user will spot the intro
// ending.
function calculerVisibiliteBouton(video) {
  const resolu = typeof skipDebut === "number" && typeof skipFin === "number";
  if (!resolu) return true;

  const t = video.currentTime;
  const dansLaFenetre = t >= skipDebut - BOUTON_MARGE_AVANT_DEBUT_S && t < skipFin;
  const enGraceApresSkip = skipVenantDeSeProduire || (boutonVisibleJusquA != null && Date.now() < boutonVisibleJusquA);
  return dansLaFenetre || enGraceApresSkip;
}

function mettreAJourBoutonFlottant() {
  const video = document.querySelector("video");
  if (!video) return;

  const { conteneur, bouton } = obtenirOuCreerBouton(video);
  const resolu = typeof skipDebut === "number" && typeof skipFin === "number";
  bouton.textContent = resolu ? "⏭ Skip Intro" : "🏁 Marquer fin d'intro";

  positionnerBouton(video);
  conteneur.style.display = calculerVisibiliteBouton(video) ? "block" : "none";
}

setInterval(() => {
  verifierAutoSkip();
  mettreAJourBoutonFlottant();
}, AUTO_SKIP_POLL_MS);

window.addEventListener("resize", () => {
  const video = document.querySelector("video");
  if (video) positionnerBouton(video);
});

document.addEventListener("fullscreenchange", () => {
  assurerBonParentPourFullscreen();
  const video = document.querySelector("video");
  if (video) positionnerBouton(video);
});

window.addEventListener("message", (event) => {
  const donnees = event.data;

  if (!donnees || donnees.canal !== CANAL) return; // pas un message de notre extension

  if (donnees.type === "set-skip-data") {
    skipDebut = donnees.debut;
    skipFin = donnees.fin;
    autoSkipEnabled = !!donnees.autoSkipEnabled;
    skipSerie = donnees.serie ?? null;
    skipEpisode = donnees.episode ?? null;
    skipMalId = donnees.malId ?? null;
    skipSite = donnees.site ?? null;
    return;
  }

  const video = document.querySelector("video");
  if (!video) {
    console.warn("[SkipSensei] Aucune balise <video> trouvée dans ce lecteur.");
    return;
  }

  if (donnees.type === "trigger-skip" || donnees.type === "trigger-mark") {
    // S/M shortcuts: re-run the button's own click handler, which decides
    // what to do based on this iframe's current skipDebut/skipFin.
    surClicBouton();
    return;
  }

  if (donnees.type === "get-current-time") {
    // Répond à event.source (pas window.top) au cas où il y aurait
    // plusieurs niveaux d'iframes imbriquées.
    event.source.postMessage(
      { canal: CANAL, type: "current-time", time: video.currentTime },
      event.origin || "*"
    );
  }

  if (donnees.type === "get-duration") {
    // Lets content.js send AniSkip the real episode length instead of a
    // placeholder 0. video.duration is NaN before metadata has loaded;
    // sent as-is, content.js decides what counts as usable.
    event.source.postMessage(
      { canal: CANAL, type: "duration", duration: video.duration },
      event.origin || "*"
    );
  }
});
