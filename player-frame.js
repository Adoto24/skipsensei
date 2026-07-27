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

const AUTO_SKIP_POLL_MS = 500;
// Small buffer so the seek doesn't keep re-triggering once we land
// right at (or past) the target time due to poll timing.
const AUTO_SKIP_EPSILON_S = 0.25;

setInterval(verifierAutoSkip, AUTO_SKIP_POLL_MS);

function verifierAutoSkip() {
  if (!autoSkipEnabled || skipDebut == null || skipFin == null) return;

  const video = document.querySelector("video");
  if (!video) return;

  const t = video.currentTime;
  if (t >= skipDebut && t < skipFin - AUTO_SKIP_EPSILON_S) {
    video.currentTime = skipFin;
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
    return;
  }

  const video = document.querySelector("video");
  if (!video) {
    console.warn("[Anime Skip Intro] Aucune balise <video> trouvée dans ce lecteur.");
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
});
