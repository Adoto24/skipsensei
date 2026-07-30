/* ============================================================
   player-frame.js
   ------------------------------------------------------------
   Ce script NE tourne PAS sur anime-sama.to : il tourne à
   l'intérieur de l'iframe du lecteur vidéo (vidmoly.biz,
   video.sibnet.ru, sendvid.com...), là où se trouve la vraie
   balise <video>. Voir manifest.json : ce script est déclaré
   dans un content_script séparé avec "all_frames": true et des
   "matches" sur ces domaines-là, pas sur anime-sama.to.

   Il écoute les messages envoyés par content.js (via
   window.postMessage) et agit directement sur la balise <video>.
   ============================================================ */

const CANAL = "anime-skip-intro";

// ------------------------------------------------------------
// Auto-skip state (new).
// English comments below for this new logic, as requested.
//
// content.js is the only script that knows the series name/episode
// (derived from the parent anime-sama.to page's title + episode
// selector) and the resolved AniSkip/manual timing. This iframe only
// has access to the <video> element itself, so it just receives the
// current skip window + the user's preference via "set-skip-data"
// messages and polls the video's playback position on its own.
// ------------------------------------------------------------
let skipDebut = null;
let skipFin = null;
let autoSkipEnabled = false;
let skipSerie = null;
let skipEpisode = null;
let skipMalId = null;
let skipSite = null;

const AUTO_SKIP_POLL_MS = 500;
// Small buffer so the seek doesn't keep re-triggering once we land
// right at (or past) the target time due to poll timing.
const AUTO_SKIP_EPSILON_S = 0.25;

// ------------------------------------------------------------
// Floating button (new — architectural change, see the note near
// "Floating button bridge" in content.js for the full rationale). This
// button used to be built by content.js on the parent page; it now lives
// here, in the same document as <video>, because:
// (a) positioning it relative to the video needs the video's own layout,
//     which only this document has direct access to, and
// (b) a cross-origin iframe's fullscreen only renders that iframe's own
//     subtree — a parent-page element can never appear "over" the video
//     once this iframe goes fullscreen, no matter how it's positioned.
// ------------------------------------------------------------
let boutonConteneurEl = null;
let boutonEl = null;
const videosAvecEcouteurs = new WeakSet(); // avoids attaching playing/timeupdate twice to the same <video>

// Only shown starting this long before the intro's start time, not for
// the entire video.
const BOUTON_MARGE_AVANT_DEBUT_S = 0.5;
// How long the button stays visible after a skip is confirmed resumed
// (see onProgressionLecture) before it's allowed to hide again.
const BOUTON_DELAI_GRACE_APRES_SKIP_MS = 3000;
// Netflix-style inset from the video's own bottom-right corner.
const BOUTON_MARGE_PX = 24;

// True from the moment a skip (auto or manual click) is triggered until
// video playback is actually confirmed resumed past the seek target (see
// onProgressionLecture): buffering after a seek can take a moment, so a
// plain "hide after N seconds from the click" timer would hide the button
// while the video is still stuck loading. Kept visible for
// BOUTON_DELAI_GRACE_APRES_SKIP_MS *after* that confirmation instead
// (boutonVisibleJusquA), not from the moment of the click itself.
let skipVenantDeSeProduire = false;
let seekCible = null;
let boutonVisibleJusquA = null;

// ------------------------------------------------------------
// Stats tracking (new). Every real auto-skip performed below is
// recorded here so the popup can show actual counts instead of
// placeholder numbers. Bucketed by year-month so "this month" in
// the popup means what it says instead of an all-time total.
// ------------------------------------------------------------
// Shared with content.js — keep these two in sync if renamed there.
const STORAGE_KEY_STATS = "asi-stats";
const STORAGE_KEY_HISTORY = "asi-history";
const HISTORIQUE_TAILLE_MAX = 20;
// Shared with content.js — new (popup Stats page). Same shapes as there,
// same enregistrerActiviteEtRecords logic duplicated below for the same
// reason storageGet/fetchAvecTimeout already are.
const STORAGE_KEY_ACTIVITY = "asi-activity";
const STORAGE_KEY_FAVORIS_SERIES = "asi-fav-series";
const STORAGE_KEY_FAVORIS_SITES = "asi-fav-sites";
const STORAGE_KEY_RECORD = "asi-record";
// Shared with content.js — same cache, same key prefix, same shape.
const STORAGE_PREFIX_POSTER = "asi-poster::";
const JIKAN_ANIME_URL = "https://api.jikan.moe/v4/anime";
const FETCH_TIMEOUT_MS = 8000;
// Shared with content.js's POSTER_ECHEC_TTL_MS — see assurerPosterEnCache
// below for why a failed lookup isn't cached as a permanent null.
const POSTER_ECHEC_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
function storageSet(items) {
  return new Promise((resolve) => chrome.storage.local.set(items, resolve));
}

/**
 * fetch() with a hard timeout, same as content.js's fetchAvecTimeout —
 * duplicated here since this file runs in a separate (cross-origin
 * player) content script context with no shared module to import from.
 */
async function fetchAvecTimeout(url, options = {}, delaiMs = FETCH_TIMEOUT_MS) {
  const controleur = new AbortController();
  const timeoutId = setTimeout(() => controleur.abort(), delaiMs);
  try {
    return await fetch(url, { ...options, signal: controleur.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Same poster cache as content.js's assurerPosterEnCache (see there for
 * the full rationale): looks up + caches a Jikan poster image URL for a
 * MAL id, never awaited by its caller so a slow/failed Jikan request
 * can't delay or block recording the auto-skip itself. A successful
 * lookup is permanent; a failed one is only skipped for POSTER_ECHEC_TTL_MS
 * so a transient Jikan rate-limit/network error gets retried later
 * instead of permanently blanking that anime's poster.
 */
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

/**
 * Same logic as content.js's enregistrerActiviteEtRecords (see there for
 * the full rationale) — duplicated here for the same reason storageGet/
 * fetchAvecTimeout already are: no shared module between the two content
 * scripts. Powers the popup's streaks, favorite series/site and true
 * all-time longest-skip, none of which auto-skips (the majority of real
 * skips) would otherwise contribute to.
 */
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

/**
 * Same recording content.js does for a manual "Skip Intro" click
 * (see its enregistrerSkip), but tagged declencheur: "auto" since
 * nothing was clicked here — the video crossed the intro window on
 * its own while auto-skip was on.
 */
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
  // recording above, which just completed.
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

/**
 * Shared by both trigger paths — auto-skip's own poll above and the
 * floating button's click handler (surClicBouton) below, itself reachable
 * either directly or via content.js's "trigger-skip" message (the S
 * keyboard shortcut). Kept as one function so both paths seek + record +
 * arm the post-skip visibility grace identically.
 */
function effectuerSkip(video, declencheur) {
  const t = video.currentTime;
  // Matches each trigger's pre-existing formula exactly (no behavior
  // change from before this button moved into this file): auto-skip
  // credits actual seconds skipped from wherever playback currently was;
  // a manual click credits the intro's full nominal duration, regardless
  // of where in the intro the user happened to click.
  const secondesGagnees = declencheur === "auto" ? skipFin - t : typeof skipDebut === "number" ? skipFin - skipDebut : 0;

  video.currentTime = skipFin;
  skipVenantDeSeProduire = true;
  seekCible = skipFin;

  if (declencheur === "auto") {
    enregistrerSkipAutomatique(secondesGagnees, skipSerie, skipEpisode, skipMalId, skipSite);
  } else {
    // Manual click: content.js already owns "clic" recording (its own
    // enregistrerSkip, unchanged) — just report the event back to it
    // instead of duplicating that bookkeeping here.
    window.parent.postMessage({ canal: CANAL, type: "skip-performed", secondesGagnees }, "*");
  }
}

/**
 * Confirms a skip actually resumed playback past its seek target (rather
 * than just starting a timer at click time) — buffering can otherwise
 * leave the video stuck for a few seconds right after the seek. Runs on
 * every "playing"/"timeupdate" tick but only does anything while a skip
 * is pending confirmation.
 */
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
  // Same look as the old on-page button (content.css, now removed) —
  // just injected here since this content_script has no "css" entry of
  // its own in manifest.json (see that file).
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

/** Runs the button's action for whatever mode currently applies — Skip
 * Intro when a timing is resolved, Mark Intro End otherwise. Called both
 * by the button's own click listener and by content.js's "trigger-skip"/
 * "trigger-mark" messages (the S/M keyboard shortcuts), so a shortcut
 * always does exactly what clicking the button would do right now. */
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

/** Lazily builds the floating button (once per iframe document) and
 * attaches the resumed-playback listeners to a newly-seen <video>. */
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

/** Netflix-style: fixed to the video's own bottom-right corner (not the
 * whole page), recomputed on every poll tick + resize + fullscreenchange
 * so it tracks the video through layout/fullscreen changes. */
function positionnerBouton(video) {
  if (!boutonConteneurEl) return;
  const rect = video.getBoundingClientRect();
  boutonConteneurEl.style.right = `${Math.max(0, window.innerWidth - rect.right + BOUTON_MARGE_PX)}px`;
  boutonConteneurEl.style.bottom = `${Math.max(0, window.innerHeight - rect.bottom + BOUTON_MARGE_PX)}px`;
}

/**
 * Re-parents the button into whichever element is actually fullscreen, so
 * it keeps rendering instead of disappearing the instant the video's
 * cross-origin iframe goes fullscreen (only the fullscreen element's own
 * subtree renders — see the architectural note in content.js). Falls back
 * to the video's normal parent once fullscreen exits.
 *
 * Some players call requestFullscreen() directly on the <video> element
 * itself rather than on a wrapping container (video.js and most other
 * player libraries fullscreen a wrapping div instead, specifically so
 * their own control bar keeps rendering — confirmed live for the sibnet
 * embed, which uses video.js). A bare <video> can only contain
 * <track>/<source> children per spec, so there is no way to inject our
 * button inside it — the button genuinely cannot render during
 * fullscreen on a player built that way. That's a real browser
 * limitation to report, not a bug to work around further.
 */
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

/** Skip Intro's own visibility window ([debut - 0.5, fin)), extended by
 * the post-skip grace period above. Mark Intro End has no such window —
 * there's no way to know in advance when the user will spot the intro
 * ending, so it stays visible the whole time, same as before this button
 * moved into this file. */
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

  // On ignore tout message qui ne vient pas de notre extension
  if (!donnees || donnees.canal !== CANAL) return;

  if (donnees.type === "set-skip-data") {
    // New message type: content.js pushes this on every polling tick.
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
    // The S/M keyboard shortcuts (content.js) — surClicBouton() decides
    // what to actually do based on this iframe's own current skipDebut/
    // skipFin, so both message types just re-run the button's own click
    // handler; see that function for why a single shared path is safe
    // even if content.js's gating and this iframe's state briefly disagree.
    surClicBouton();
    return;
  }

  if (donnees.type === "get-current-time") {
    // On répond directement à la fenêtre qui nous a envoyé le message
    // (event.source), pas à window.top, au cas où il y aurait plusieurs
    // niveaux d'iframes imbriquées.
    event.source.postMessage(
      { canal: CANAL, type: "current-time", time: video.currentTime },
      event.origin || "*"
    );
  }

  if (donnees.type === "get-duration") {
    // New: lets content.js send AniSkip the real episode length instead of
    // a placeholder 0 — see its use in resoudreTimingAniSkip. video.duration
    // is NaN before the video's metadata has loaded; sent as-is, content.js
    // is the one that decides what counts as "not usable yet".
    event.source.postMessage(
      { canal: CANAL, type: "duration", duration: video.duration },
      event.origin || "*"
    );
  }
});
