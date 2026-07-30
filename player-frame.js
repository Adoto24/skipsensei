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
 * MAL id, once per malId, never awaited by its caller so a slow/failed
 * Jikan request can't delay or block recording the auto-skip itself.
 */
async function assurerPosterEnCache(malId) {
  if (malId == null) return;

  const cle = `${STORAGE_PREFIX_POSTER}${malId}`;
  try {
    const cache = await storageGet([cle]);
    if (cle in cache) return; // already looked up, success or confirmed failure

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

setInterval(verifierAutoSkip, AUTO_SKIP_POLL_MS);

function verifierAutoSkip() {
  if (!autoSkipEnabled || skipDebut == null || skipFin == null) return;

  const video = document.querySelector("video");
  if (!video) return;

  const t = video.currentTime;
  if (t >= skipDebut && t < skipFin - AUTO_SKIP_EPSILON_S) {
    const secondesGagnees = skipFin - t;
    video.currentTime = skipFin;
    enregistrerSkipAutomatique(secondesGagnees, skipSerie, skipEpisode, skipMalId, skipSite);
  }
}

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

  if (donnees.type === "seek") {
    video.currentTime = donnees.time;
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
