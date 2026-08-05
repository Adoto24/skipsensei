// Popup UI. Keys below are shared with content.js/player-frame.js — keep
// them in sync if renamed there.

const STORAGE_KEY_SETTINGS = "asi-settings"; // { autoSkipEnabled }
const STORAGE_KEY_STATS = "asi-stats"; // { "YYYY-MM": { skips, secondesGagnees } }
const STORAGE_KEY_HISTORY = "asi-history"; // [{ serie, episode, secondes, declencheur, horodatage, malId, site }, ...]
const STORAGE_KEY_THEME = "asi-theme"; // popup-only preference, not shared
const STORAGE_PREFIX_TIMING = "asi-timing::"; // "asi-timing::<serie>::<episode>" — manual overrides only
const STORAGE_PREFIX_POSTER = "asi-poster::"; // "asi-poster::<malId>" -> { url, cachedAt }
const STORAGE_KEY_ACTIVITY = "asi-activity"; // { "YYYY-MM-DD": { skips, secondesGagnees } }
const STORAGE_KEY_FAVORIS_SERIES = "asi-fav-series"; // { [serie]: skipCount }
const STORAGE_KEY_FAVORIS_SITES = "asi-fav-sites"; // { [site]: skipCount }
const STORAGE_KEY_RECORD = "asi-record"; // { secondes, serie, episode, horodatage }
// Cleared by Settings > Advanced > "Clear resolution cache" — everything
// cached en route to a malId, excluding asi-timing:: (real user overrides)
// and the stats/activity keys above (cleared by "Reset statistics").
const STORAGE_PREFIX_MALID = "asi-malid::";
const STORAGE_PREFIX_SEQUEL_MALID = "asi-sequelmalid::";
const STORAGE_PREFIX_SAISONS = "asi-saisons::";
const STORAGE_PREFIX_ANIDBID = "asi-anidbid::";

// The sites content.js's ADAPTATEURS_SITE supports (see manifest.json's
// first content_scripts "matches").
const SITES_SUPPORTES = [
  { hostname: "anime-sama.to", nomSite: "Anime-Sama" },
  { hostname: "voiranime.rip", nomSite: "VoirAnime" },
];

// Updated by rafraichirEtatVivant() every ~3s while the popup is open.
let dernierStatutConnu = "offline";
let dernierReponseConnue = null;

// Each init*() is independent: one throwing must not stop the others
// (including their own addEventListener calls) from running.
const INITIALISATEURS = [
  initVersionDisplay,
  initRipple,
  initDetailPanels,
  initAutoSkipToggles,
  initThemeToggles,
  initStaticTabs,
  initBottomNav,
  initLiveState,
  initHistoryCard,
  initStatsPage,
  initSkipToastWatcher,
];

document.addEventListener("DOMContentLoaded", () => {
  for (const initialiser of INITIALISATEURS) {
    try {
      initialiser();
    } catch (erreur) {
      console.error(`[SkipSensei] Échec de "${initialiser.name}":`, erreur);
    }
  }
});

// ------------------------------------------------------------
// Formatting helpers, reused across dashboard/history/stats.
// ------------------------------------------------------------

function cleMoisActuel() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function cleJourActuel() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formaterDureeGagnee(secondesTotal) {
  const totalMinutes = Math.round(secondesTotal / 60);
  const heures = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return heures > 0 ? `${heures}h ${minutes}m` : `${minutes}m`;
}

function formaterSecondesGagnees(secondes) {
  const total = Math.round(secondes);
  const minutes = Math.floor(total / 60);
  const reste = total % 60;
  return minutes > 0 ? `+${minutes}m ${reste}s` : `+${reste}s`;
}

function formaterTimingMinutesSecondes(secondesTotal) {
  const total = Math.max(0, Math.round(secondesTotal));
  const minutes = Math.floor(total / 60);
  const secondes = total % 60;
  return `${minutes}:${String(secondes).padStart(2, "0")}`;
}

function formaterTempsRelatif(horodatage) {
  if (!horodatage) return "";
  const diffMin = Math.floor((Date.now() - horodatage) / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffJ = Math.floor(diffH / 24);
  if (diffJ === 1) return "Yesterday";
  if (diffJ < 7) return `${diffJ}d ago`;
  const d = new Date(horodatage);
  const mois = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${mois[d.getMonth()]} ${d.getDate()}`;
}

// lastIndexOf rather than split("::") so a series name that happens to
// contain "::" doesn't get split in the wrong place.
function analyserCleTiming(cle) {
  const reste = cle.slice(STORAGE_PREFIX_TIMING.length);
  const indexSeparateur = reste.lastIndexOf("::");
  if (indexSeparateur === -1) return { serie: reste, episode: null };
  return {
    serie: reste.slice(0, indexSeparateur),
    episode: reste.slice(indexSeparateur + 2),
  };
}

// Read from manifest.json rather than hardcoded, to avoid drifting out of
// sync with the real version.
function initVersionDisplay() {
  const version = chrome.runtime.getManifest().version;
  const pill = document.getElementById("version-pill");
  const settingsValue = document.getElementById("settings-version-value");
  if (pill) pill.textContent = `v${version}`;
  if (settingsValue) settingsValue.textContent = version;
}

// ------------------------------------------------------------
// Toast
// ------------------------------------------------------------
let toastTimeoutId = null;

function afficherToast(titre, sousTitre = null, { icone = "ph-fill ph-check-circle" } = {}) {
  const toast = document.getElementById("toast");
  const titleEl = document.getElementById("toast-title");
  const subtitleEl = document.getElementById("toast-subtitle");
  const iconEl = document.getElementById("toast-icon");
  if (!toast || !titleEl || !subtitleEl || !iconEl) return;

  titleEl.textContent = titre;
  subtitleEl.hidden = !sousTitre;
  if (sousTitre) subtitleEl.textContent = sousTitre;
  iconEl.className = `${icone} toast-icon`;

  toast.hidden = false;
  // Force layout so the transition replays even if a toast is already showing.
  void toast.offsetWidth;
  toast.classList.add("is-visible");

  clearTimeout(toastTimeoutId);
  toastTimeoutId = setTimeout(
    () => {
      toast.classList.remove("is-visible");
      setTimeout(() => {
        toast.hidden = true;
      }, 150);
    },
    sousTitre ? 2600 : 1800
  );
}

// ------------------------------------------------------------
// Shared full-panel swap for Settings and Manual Timings: opening either
// hides every dashboard/stats view-panel + the bottom nav, and only one
// detail panel is ever open at a time.
// ------------------------------------------------------------

// #popup-content is shared by every tab/detail panel, so switching panels
// needs an explicit scroll reset instead of relying on each panel's own
// clamped scroll position.
function remonterPopupContent() {
  document.getElementById("popup-content")?.scrollTo({ top: 0 });
}

function creerPanneauDetail(panelEl, { onOpen } = {}) {
  const viewPanels = document.querySelectorAll(".view-panel");
  const bottomNav = document.querySelector(".bottom-nav");

  function ouvrir() {
    document.querySelectorAll(".view-detail").forEach((autre) => {
      if (autre !== panelEl) autre.hidden = true;
    });
    panelEl.hidden = false;
    viewPanels.forEach((vp) => (vp.hidden = true));
    if (bottomNav) bottomNav.hidden = true;
    remonterPopupContent();
    onOpen?.();
  }

  function fermer() {
    panelEl.hidden = true;
    const navActif = document.querySelector(".nav-item.is-active");
    const cible = navActif?.dataset.nav || "dashboard";
    viewPanels.forEach((vp) => (vp.hidden = vp.dataset.viewPanel !== cible));
    if (bottomNav) bottomNav.hidden = false;
    remonterPopupContent();
  }

  return { ouvrir, fermer };
}

// Wires Manual Timings, Keyboard Shortcuts and Support as detail panels.
// Settings keeps its own copy of the support card in its About section
// (#settings-about); this button is a shortcut to the dedicated view.
function initDetailPanels() {
  const timingsPanelEl = document.getElementById("manual-timings-panel");
  const shortcutsPanelEl = document.getElementById("shortcuts-panel");
  const supportPanelEl = document.getElementById("support-panel");
  if (!timingsPanelEl) return;

  const supportBtn = document.getElementById("btn-support");
  const closeSupportBtn = document.getElementById("btn-close-support");
  const tabManualTimings = document.getElementById("tab-manual-timings");
  const closeTimingsBtn = document.getElementById("btn-close-manual-timings");
  const tabShortcuts = document.getElementById("tab-shortcuts");
  const closeShortcutsBtn = document.getElementById("btn-close-shortcuts");

  const { recharger: rechargerTimings } = initSavedTimingsList();
  initAdvancedActions();

  const timings = creerPanneauDetail(timingsPanelEl, { onOpen: rechargerTimings });
  const shortcuts = shortcutsPanelEl ? creerPanneauDetail(shortcutsPanelEl) : null;
  const support = supportPanelEl ? creerPanneauDetail(supportPanelEl) : null;

  supportBtn?.addEventListener("click", () => support?.ouvrir());
  closeSupportBtn?.addEventListener("click", () => support?.fermer());

  tabManualTimings?.addEventListener("click", () => timings.ouvrir());
  closeTimingsBtn?.addEventListener("click", () => timings.fermer());

  tabShortcuts?.addEventListener("click", () => shortcuts?.ouvrir());
  closeShortcutsBtn?.addEventListener("click", () => shortcuts?.fermer());
}

// Lists every manually-saved intro timing with a delete button per entry.
// Deleting one here is picked up immediately by any open tab on that
// episode via content.js's chrome.storage.onChanged listener.
function initSavedTimingsList() {
  const listEl = document.getElementById("saved-timings-list");
  const emptyEl = document.getElementById("saved-timings-empty");
  if (!listEl || !emptyEl) return { recharger: () => {} };

  function recharger() {
    chrome.storage.local.get(null, (tout) => {
      const entrees = Object.entries(tout)
        .filter(([cle]) => cle.startsWith(STORAGE_PREFIX_TIMING))
        .map(([cle, valeur]) => ({ cle, ...analyserCleTiming(cle), valeur }))
        .filter((e) => typeof e.valeur?.fin === "number")
        .sort((a, b) => a.serie.localeCompare(b.serie));

      listEl.innerHTML = "";

      if (entrees.length === 0) {
        listEl.hidden = true;
        emptyEl.hidden = false;
        return;
      }

      listEl.hidden = false;
      emptyEl.hidden = true;

      entrees.forEach(({ cle, serie, episode, valeur }) => {
        // textContent throughout: `serie` comes from document.title on
        // the anime site, untrusted as far as this popup is concerned.
        const li = document.createElement("li");
        li.className = "timing-item";

        const info = document.createElement("div");
        info.className = "timing-info";
        const nom = document.createElement("p");
        nom.className = "timing-name";
        nom.textContent = serie || "Unknown series";
        const detail = document.createElement("p");
        detail.className = "timing-detail";
        detail.textContent = `Episode ${episode ?? "?"} — intro ends at ${formaterTimingMinutesSecondes(valeur.fin)}`;
        info.append(nom, detail);

        const supprimerBtn = document.createElement("button");
        supprimerBtn.className = "icon-btn timing-delete";
        supprimerBtn.setAttribute("aria-label", `Delete the timing for ${serie} episode ${episode ?? "?"}`);
        supprimerBtn.title = "Delete this timing";
        const icone = document.createElement("i");
        icone.className = "ph ph-trash";
        supprimerBtn.appendChild(icone);
        supprimerBtn.addEventListener("click", () => {
          chrome.storage.local.remove([cle], () => {
            recharger();
            afficherToast("Timing deleted");
          });
        });

        li.append(info, supprimerBtn);
        listEl.appendChild(li);
      });
    });
  }

  recharger();
  return { recharger };
}

// Settings > Advanced: reset-stats and clear-resolution-cache.
function initAdvancedActions() {
  const resetBtn = document.getElementById("btn-reset-stats");
  const clearCacheBtn = document.getElementById("btn-clear-cache");

  resetBtn?.addEventListener("click", () => {
    chrome.storage.local.remove(
      [
        STORAGE_KEY_STATS,
        STORAGE_KEY_HISTORY,
        STORAGE_KEY_ACTIVITY,
        STORAGE_KEY_FAVORIS_SERIES,
        STORAGE_KEY_FAVORIS_SITES,
        STORAGE_KEY_RECORD,
      ],
      () => {
        initHistoryCard();
        initStatsPage();
        afficherToast("Statistics reset");
      }
    );
  });

  clearCacheBtn?.addEventListener("click", () => {
    const prefixes = [
      STORAGE_PREFIX_MALID,
      STORAGE_PREFIX_SEQUEL_MALID,
      STORAGE_PREFIX_SAISONS,
      STORAGE_PREFIX_ANIDBID,
      STORAGE_PREFIX_POSTER,
    ];
    chrome.storage.local.get(null, (tout) => {
      const cles = Object.keys(tout).filter((cle) => prefixes.some((prefixe) => cle.startsWith(prefixe)));
      if (cles.length === 0) {
        afficherToast("Cache already empty");
        return;
      }
      chrome.storage.local.remove(cles, () => {
        afficherToast("Resolution cache cleared", `${cles.length} entr${cles.length === 1 ? "y" : "ies"} removed`);
      });
    });
  });
}

// Settings > Supported Sites: the two real sites, with a live dot for
// whether the active tab is on one of them right now.
function initSupportedSitesList() {
  const listEl = document.getElementById("settings-site-list");
  if (!listEl) return;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    let hostnameActif = null;
    try {
      hostnameActif = tabs[0]?.url ? new URL(tabs[0].url).hostname : null;
    } catch {
      hostnameActif = null;
    }

    listEl.innerHTML = "";
    SITES_SUPPORTES.forEach(({ hostname, nomSite }) => {
      const correspond = hostnameActif === hostname || (hostnameActif?.endsWith(`.${hostname}`) ?? false);

      const li = document.createElement("li");
      li.className = "site-item";
      const dot = document.createElement("span");
      dot.className = "status-dot" + (correspond ? " is-ready" : "");
      const nom = document.createElement("span");
      nom.className = "site-item-name";
      nom.textContent = nomSite;
      const statut = document.createElement("span");
      statut.className = "site-item-status";
      statut.textContent = correspond ? "Active tab" : hostname;
      li.append(dot, nom, statut);
      listEl.appendChild(li);
    });
  });
}

// Settings > Detection: static cascade order (always shown) + a dynamic
// "last match" line from the active tab's resolved timing, when there is one.
function mettreAJourDetectionSettings(reponse) {
  const wrap = document.getElementById("detection-last-match");
  const texte = document.getElementById("detection-last-match-text");
  if (!wrap || !texte) return;

  const source = reponse?.timing?.source;
  if (!source || !reponse?.serieBase) {
    wrap.hidden = true;
    return;
  }

  const libelles = { aniskip: "AniSkip", "open-anime-timestamps": "Open Anime Timestamps", manual: "your manual mark" };
  texte.textContent = `"${reponse.serieBase}" resolved via ${libelles[source] || source}`;
  wrap.hidden = false;
}

// The one real Auto Skip Intro toggle, mirrored between the Dashboard
// hero card and Settings > Playback — both read/write the same
// chrome.storage.local["asi-settings"] key content.js's own toggle uses.
function initAutoSkipToggles() {
  const toggles = [document.getElementById("toggle-autoskip"), document.getElementById("toggle-autoskip-settings")].filter(
    Boolean
  );
  if (toggles.length === 0) return;

  function appliquerEtat(actif) {
    toggles.forEach((toggle) => {
      toggle.classList.toggle("is-on", actif);
      toggle.setAttribute("aria-checked", String(actif));
    });
    mettreAJourAutoskipSubtitle(dernierStatutConnu);
  }

  chrome.storage.local.get([STORAGE_KEY_SETTINGS], (resultat) => {
    appliquerEtat(resultat[STORAGE_KEY_SETTINGS]?.autoSkipEnabled ?? true);
  });

  toggles.forEach((toggle) => {
    toggle.addEventListener("click", () => {
      const nouvelEtat = !toggle.classList.contains("is-on");
      appliquerEtat(nouvelEtat);
      chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: { autoSkipEnabled: nouvelEtat } });
    });
  });

  // Picks up the "A" keyboard shortcut (content.js) toggling the same key
  // while the popup happens to be open.
  chrome.storage.onChanged.addListener((changements, zone) => {
    if (zone !== "local" || !changements[STORAGE_KEY_SETTINGS]) return;
    appliquerEtat(changements[STORAGE_KEY_SETTINGS].newValue?.autoSkipEnabled ?? true);
  });
}

// Light/dark theme toggle: swaps a body class (flips popup.css's CSS
// custom properties), persisted across popup opens. Mirrored between the
// header icon button and Settings > Appearance, same as Auto Skip Intro.
function initThemeToggles() {
  const bouton = document.getElementById("btn-theme");
  const icone = bouton?.querySelector("i");
  const toggleSettings = document.getElementById("toggle-theme-settings");
  if (!bouton && !toggleSettings) return;

  function appliquerTheme(theme) {
    const clair = theme === "light";
    document.body.classList.toggle("theme-light", clair);
    if (icone) {
      icone.classList.toggle("ph-moon", !clair);
      icone.classList.toggle("ph-sun", clair);
    }
    if (toggleSettings) {
      // "on" for this switch means Dark Mode is active, matching its label.
      toggleSettings.classList.toggle("is-on", !clair);
      toggleSettings.setAttribute("aria-checked", String(!clair));
    }
  }

  chrome.storage.local.get([STORAGE_KEY_THEME], (resultat) => {
    appliquerTheme(resultat[STORAGE_KEY_THEME] || "dark");
  });

  function basculer() {
    const themeActuel = document.body.classList.contains("theme-light") ? "light" : "dark";
    const nouveauTheme = themeActuel === "light" ? "dark" : "light";
    appliquerTheme(nouveauTheme);
    chrome.storage.local.set({ [STORAGE_KEY_THEME]: nouveauTheme });
  }

  bouton?.addEventListener("click", basculer);
  toggleSettings?.addEventListener("click", basculer);
}

// ------------------------------------------------------------
// Live state: Currently Watching + the Auto Skip Intro card's subtitle
// both come from one chrome.tabs.sendMessage round-trip to content.js's
// "asi-get-state" handler, refreshed on a timer while the popup is open.
// ------------------------------------------------------------

function interrogerContentScript() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabActif = tabs[0];
      if (chrome.runtime.lastError || !tabActif?.id) {
        resolve(null);
        return;
      }
      chrome.tabs.sendMessage(tabActif.id, { type: "asi-get-state" }, (reponse) => {
        // Must read lastError here or Chrome logs an "Unchecked
        // runtime.lastError" whenever no content script is listening on
        // this tab (unsupported site, or still loading).
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(reponse || null);
      });
    });
  });
}

// Reduces a raw asi-get-state response to one of 4 states, each backed by
// a real signal from content.js:
// - "offline": no content script answered, or one did but hasn't
//   detected a series/episode yet.
// - "scanning": series/episode known, timing not resolved yet.
// - "ready": timing resolved (AniSkip/OAT/manual).
// - "skipping": content.js's own current-time check says playback is
//   inside the skip window.
function deriverStatut(reponse) {
  if (!reponse || !reponse.serieBase || reponse.episode == null) return "offline";
  if (reponse.enCoursDeSkip) return "skipping";
  if (reponse.timing?.debut != null && reponse.timing?.fin != null) return "ready";
  return "scanning";
}

function mettreAJourWatchCard(reponse, statut) {
  const skeleton = document.getElementById("watch-skeleton");
  const empty = document.getElementById("watch-empty");
  const content = document.getElementById("watch-content");
  if (!skeleton || !empty || !content) return;

  skeleton.hidden = true;

  const detecte = statut !== "offline";
  empty.hidden = detecte;
  content.hidden = !detecte;
  if (!detecte) return;

  const titleEl = document.getElementById("watch-title");
  if (titleEl) titleEl.textContent = reponse.serieBase || "Unknown series";

  const episodeEl = document.getElementById("watch-episode");
  if (episodeEl) {
    episodeEl.textContent =
      Number.isFinite(reponse.saison) && reponse.saison > 1
        ? `Season ${reponse.saison} · Episode ${reponse.episode}`
        : `Episode ${reponse.episode}`;
  }

  const siteEl = document.getElementById("watch-site");
  if (siteEl) {
    siteEl.hidden = !reponse.site;
    if (reponse.site) siteEl.textContent = reponse.site;
  }

  const langEl = document.getElementById("watch-language");
  if (langEl) {
    langEl.hidden = !reponse.langue;
    if (reponse.langue) langEl.textContent = reponse.langue;
  }

  const timingEl = document.getElementById("watch-timing");
  const timingRangeEl = document.getElementById("watch-timing-range");
  const timingResolu = reponse.timing?.debut != null && reponse.timing?.fin != null;
  if (timingEl) timingEl.hidden = !timingResolu;
  if (timingRangeEl && timingResolu) {
    timingRangeEl.textContent = `${formaterTimingMinutesSecondes(reponse.timing.debut)} → ${formaterTimingMinutesSecondes(reponse.timing.fin)}`;
  }

  const dot = document.getElementById("watch-status-dot");
  const label = document.getElementById("watch-status-label");
  const classes = { scanning: " is-scanning", ready: " is-ready", skipping: " is-skipping" };
  const libelles = { scanning: "Scanning", ready: "Ready to Skip", skipping: "Skipping…" };
  if (dot) dot.className = "status-dot" + (classes[statut] || "");
  if (label) label.textContent = libelles[statut] || "—";
}

function mettreAJourAutoskipSubtitle(statut) {
  const toggle = document.getElementById("toggle-autoskip");
  const dot = document.getElementById("autoskip-status-dot");
  const label = document.getElementById("autoskip-subtitle-text");
  if (!toggle || !dot || !label) return;

  if (!toggle.classList.contains("is-on")) {
    dot.className = "status-dot";
    label.textContent = "Disabled";
    return;
  }

  const classes = { offline: "", scanning: " is-scanning", ready: " is-ready", skipping: " is-skipping" };
  const libelles = { offline: "Enabled", scanning: "Watching…", ready: "Ready", skipping: "Skipping…" };
  dot.className = "status-dot" + (classes[statut] || "");
  label.textContent = libelles[statut] || "Enabled";
}

async function rafraichirEtatVivant() {
  const reponse = await interrogerContentScript();
  const statut = deriverStatut(reponse);
  dernierStatutConnu = statut;
  dernierReponseConnue = reponse;

  mettreAJourWatchCard(reponse, statut);
  mettreAJourAutoskipSubtitle(statut);
  // No-op unless Settings is currently open.
  mettreAJourDetectionSettings(reponse);
}

// Popup-open-only polling, mirroring content.js's own safety-net
// interval — cleared once the popup is no longer visible.
function initLiveState() {
  rafraichirEtatVivant();
  const intervalId = setInterval(rafraichirEtatVivant, 3000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearInterval(intervalId);
  });
}

// ------------------------------------------------------------
// Recently Skipped
// ------------------------------------------------------------

// Uses textContent throughout rather than innerHTML: `serie`/`site` come
// from document.title/the page, untrusted input as far as this popup is
// concerned.
function construireElementHistorique(entree, posters) {
  const li = document.createElement("li");
  li.className = "history-item";

  const thumb = document.createElement("div");
  thumb.className = "thumb thumb-generic";

  // entree.malId or posters[...] may be missing (older entry, or the
  // fire-and-forget Jikan lookup hasn't finished) — falls through to the
  // generic placeholder background below.
  const posterEntry = entree.malId != null ? posters[`${STORAGE_PREFIX_POSTER}${entree.malId}`] : null;
  if (posterEntry?.url) {
    thumb.classList.remove("thumb-generic");
    thumb.style.backgroundImage = `url("${posterEntry.url}")`;
  }

  const info = document.createElement("div");
  info.className = "history-info";
  const nom = document.createElement("p");
  nom.className = "history-name";
  nom.textContent = entree.serie || "Unknown series";

  const meta = document.createElement("p");
  meta.className = "history-meta";
  const episodeSpan = document.createElement("span");
  episodeSpan.textContent = entree.episode != null ? `Ep. ${entree.episode}` : "Unknown episode";
  meta.appendChild(episodeSpan);
  if (entree.site) {
    const sep = document.createElement("span");
    sep.className = "dot-sep";
    sep.textContent = "·";
    const siteSpan = document.createElement("span");
    siteSpan.textContent = entree.site;
    meta.append(sep, siteSpan);
  }
  info.append(nom, meta);

  const saved = document.createElement("div");
  saved.className = "history-saved";
  const savedValue = document.createElement("span");
  savedValue.className = "history-saved-value";
  const savedText = document.createElement("span");
  savedText.textContent = formaterSecondesGagnees(entree.secondes || 0);
  const checkIcon = document.createElement("i");
  checkIcon.className = "ph-fill ph-check-circle";
  savedValue.append(savedText, checkIcon);
  const savedTime = document.createElement("span");
  savedTime.className = "history-saved-time";
  savedTime.textContent = formaterTempsRelatif(entree.horodatage);
  saved.append(savedValue, savedTime);

  li.append(thumb, info, saved);
  return li;
}

function initHistoryCard() {
  const listEl = document.getElementById("history-list");
  const emptyEl = document.getElementById("history-empty");
  if (!listEl || !emptyEl) return;

  chrome.storage.local.get([STORAGE_KEY_HISTORY], (resultat) => {
    const historique = resultat[STORAGE_KEY_HISTORY] || [];

    if (historique.length === 0) {
      listEl.hidden = true;
      emptyEl.hidden = false;
      return;
    }

    listEl.hidden = false;
    emptyEl.hidden = true;

    // One batched read for every malId instead of one storage call per row.
    const clesPoster = [
      ...new Set(historique.filter((e) => e.malId != null).map((e) => `${STORAGE_PREFIX_POSTER}${e.malId}`)),
    ];

    chrome.storage.local.get(clesPoster, (posters) => {
      listEl.innerHTML = "";
      historique.forEach((entree) => listEl.appendChild(construireElementHistorique(entree, posters)));
    });
  });
}

// ------------------------------------------------------------
// Stats page
// ------------------------------------------------------------

function sommeStats(stats) {
  let skips = 0;
  let secondes = 0;
  let meilleurMoisSkips = 0;
  Object.values(stats).forEach((moisData) => {
    skips += moisData.skips || 0;
    secondes += moisData.secondesGagnees || 0;
    meilleurMoisSkips = Math.max(meilleurMoisSkips, moisData.skips || 0);
  });
  return { skips, secondes, meilleurMoisSkips };
}

// Local-midnight day key, same format as cleJourActuel — `new
// Date("YYYY-MM-DD")` parses as UTC and can land on the wrong calendar
// day near a timezone boundary, so streak math always goes through this.
function analyserCleJour(cle) {
  const [y, m, d] = cle.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function calculerStreaks(activite) {
  const jours = Object.keys(activite)
    .filter((j) => (activite[j]?.skips || 0) > 0)
    .sort();
  if (jours.length === 0) return { actuel: 0, record: 0 };

  const joursSet = new Set(jours);
  const MS_JOUR = 24 * 60 * 60 * 1000;

  // Current streak: walk backward from today (or yesterday if today has
  // no activity yet — the streak isn't "broken" until a full day passes
  // with nothing skipped).
  let curseur = new Date();
  curseur.setHours(0, 0, 0, 0);
  if (!joursSet.has(cleJourActuel())) curseur = new Date(curseur.getTime() - MS_JOUR);
  let actuel = 0;
  while (joursSet.has(`${curseur.getFullYear()}-${String(curseur.getMonth() + 1).padStart(2, "0")}-${String(curseur.getDate()).padStart(2, "0")}`)) {
    actuel += 1;
    curseur = new Date(curseur.getTime() - MS_JOUR);
  }

  // Longest streak ever: longest run of calendar-consecutive days.
  let record = 1;
  let courant = 1;
  for (let i = 1; i < jours.length; i++) {
    const diffJours = Math.round((analyserCleJour(jours[i]) - analyserCleJour(jours[i - 1])) / MS_JOUR);
    courant = diffJours === 1 ? courant + 1 : 1;
    record = Math.max(record, courant);
  }

  return { actuel, record };
}

function animerCompteur(el, versValeur, formater, duree = 700) {
  if (!el) return;
  const debutTs = performance.now();
  function etape(ts) {
    const progres = Math.min(1, (ts - debutTs) / duree);
    const ease = 1 - Math.pow(1 - progres, 3);
    el.textContent = formater(Math.round(versValeur * ease));
    if (progres < 1) requestAnimationFrame(etape);
  }
  requestAnimationFrame(etape);
}

function meilleurEntree(map) {
  let meilleurNom = null;
  let meilleurCompte = 0;
  Object.entries(map).forEach(([nom, compte]) => {
    if (compte > meilleurCompte) {
      meilleurNom = nom;
      meilleurCompte = compte;
    }
  });
  return meilleurNom ? { nom: meilleurNom, compte: meilleurCompte } : null;
}

// One bar-chart column per entree = { valeur, label, accent, title }.
function construireBarChart(conteneurId, entrees) {
  const conteneur = document.getElementById(conteneurId);
  if (!conteneur) return;

  const maxValeur = Math.max(1, ...entrees.map((e) => e.valeur));
  conteneur.innerHTML = "";

  entrees.forEach((e) => {
    const col = document.createElement("div");
    col.className = "bar-chart-col" + (e.accent ? " is-today" : "");
    col.title = e.title || "";

    const track = document.createElement("div");
    track.className = "bar-chart-track";
    const fill = document.createElement("div");
    fill.className = "bar-chart-fill";
    track.appendChild(fill);

    const label = document.createElement("span");
    label.className = "bar-chart-label";
    label.textContent = e.label;

    col.append(track, label);
    conteneur.appendChild(col);

    // Animate in on next frame so the CSS transition actually plays.
    requestAnimationFrame(() => {
      fill.style.height = `${Math.max(3, Math.round((e.valeur / maxValeur) * 100))}%`;
    });
  });
}

function renderWeekChart(activite) {
  const jours = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const entrees = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const cle = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const donnees = activite[cle] || { skips: 0 };
    entrees.push({
      valeur: donnees.skips,
      label: jours[d.getDay()],
      accent: i === 0,
      title: `${donnees.skips} skip${donnees.skips === 1 ? "" : "s"}`,
    });
  }
  construireBarChart("chart-week", entrees);
}

function renderMonthChart(stats) {
  const noms = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const entrees = [];
  const base = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
    const cle = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const donnees = stats[cle] || { skips: 0 };
    entrees.push({
      valeur: donnees.skips,
      label: noms[d.getMonth()],
      accent: i === 0,
      title: `${donnees.skips} skip${donnees.skips === 1 ? "" : "s"}`,
    });
  }
  construireBarChart("chart-months", entrees);
}

// Renders the Stats page. Every tile shows "—" + an explanatory tooltip
// instead of a bare "0" when there's genuinely no data yet.
async function initStatsPage() {
  const introsEl = document.getElementById("stat-intros-skipped");
  const savedEl = document.getElementById("stat-time-saved");
  if (!introsEl || !savedEl) return;

  const resultat = await new Promise((resolve) =>
    chrome.storage.local.get(
      [STORAGE_KEY_STATS, STORAGE_KEY_ACTIVITY, STORAGE_KEY_FAVORIS_SERIES, STORAGE_KEY_FAVORIS_SITES, STORAGE_KEY_RECORD],
      resolve
    )
  );

  const stats = resultat[STORAGE_KEY_STATS] || {};
  const activite = resultat[STORAGE_KEY_ACTIVITY] || {};
  const favSeries = resultat[STORAGE_KEY_FAVORIS_SERIES] || {};
  const favSites = resultat[STORAGE_KEY_FAVORIS_SITES] || {};
  const record = resultat[STORAGE_KEY_RECORD] || null;

  const { skips, secondes, meilleurMoisSkips } = sommeStats(stats);

  animerCompteur(introsEl, skips, (v) => String(v));
  animerCompteur(savedEl, Math.round(secondes / 60), (v) => formaterDureeGagnee(v * 60));

  const moisActuelSkips = stats[cleMoisActuel()]?.skips || 0;
  const ringPct = meilleurMoisSkips > 0 ? Math.min(100, Math.round((moisActuelSkips / meilleurMoisSkips) * 100)) : 0;
  const ring = document.getElementById("stats-ring");
  const ringValue = document.getElementById("stats-ring-value");
  if (ring) ring.style.setProperty("--ring-pct", String(ringPct));
  if (ringValue) ringValue.textContent = `${ringPct}%`;

  const avgEl = document.getElementById("tile-avg-length-value");
  if (avgEl) avgEl.textContent = skips > 0 ? formaterTimingMinutesSecondes(secondes / skips) : "—";
  const avgTile = document.getElementById("tile-avg-length");
  if (avgTile) avgTile.title = skips > 0 ? `Averaged over ${skips} skip${skips === 1 ? "" : "s"}` : "Skip your first intro to see this";

  const longestTile = document.getElementById("tile-longest");
  const longestEl = document.getElementById("tile-longest-value");
  if (longestEl) longestEl.textContent = record ? formaterTimingMinutesSecondes(record.secondes) : "—";
  if (longestTile) {
    longestTile.title = record
      ? `${record.serie || "Unknown series"}${record.episode != null ? ` — Ep. ${record.episode}` : ""}`
      : "Skip your first intro to set a record";
  }

  const favAnime = meilleurEntree(favSeries);
  const favAnimeTile = document.getElementById("tile-fav-anime");
  const favAnimeEl = document.getElementById("tile-fav-anime-value");
  if (favAnimeEl) favAnimeEl.textContent = favAnime ? favAnime.nom : "—";
  if (favAnimeTile) favAnimeTile.title = favAnime ? `${favAnime.compte} skip${favAnime.compte === 1 ? "" : "s"}` : "Not enough data yet";

  const favSite = meilleurEntree(favSites);
  const favSiteTile = document.getElementById("tile-fav-site");
  const favSiteEl = document.getElementById("tile-fav-site-value");
  if (favSiteEl) favSiteEl.textContent = favSite ? favSite.nom : "—";
  if (favSiteTile) favSiteTile.title = favSite ? `${favSite.compte} skip${favSite.compte === 1 ? "" : "s"}` : "Not enough data yet";

  const { actuel: streakActuel, record: streakRecord } = calculerStreaks(activite);
  const streakEl = document.getElementById("tile-streak-value");
  if (streakEl) streakEl.textContent = streakActuel > 0 ? `${streakActuel} day${streakActuel === 1 ? "" : "s"}` : "—";
  const streakTile = document.getElementById("tile-streak");
  if (streakTile) streakTile.title = streakActuel > 0 ? "Keep it going!" : "Start your streak today";

  const bestStreakEl = document.getElementById("tile-best-streak-value");
  if (bestStreakEl) bestStreakEl.textContent = streakRecord > 0 ? `${streakRecord} day${streakRecord === 1 ? "" : "s"}` : "—";

  renderWeekChart(activite);
  renderMonthChart(stats);

  const todayChip = document.getElementById("today-chip");
  const todayChipText = document.getElementById("today-chip-text");
  if (todayChip && todayChipText) {
    const aujourdHui = activite[cleJourActuel()];
    if (aujourdHui && aujourdHui.secondesGagnees > 0) {
      todayChipText.textContent = `+${formaterDureeGagnee(aujourdHui.secondesGagnees)} today`;
      todayChip.hidden = false;
    } else {
      todayChip.hidden = true;
    }
  }
}

// ------------------------------------------------------------
// Quick Actions: Contribute has no real destination yet (see README) —
// labeled "Soon" and just toasts on click. Shortcuts and Manual Timings
// open real panels, wired in initDetailPanels above.
// ------------------------------------------------------------
function initStaticTabs() {
  document.querySelectorAll('.action-tab[data-tab="contribute"]').forEach((tab) => {
    tab.addEventListener("click", () => {
      afficherToast("Contributing — coming soon");
    });
  });
}

// Switches the active bottom-nav destination ("dashboard" | "stats" |
// "settings"), shared by the nav-item click handlers and the header heart
// button. Re-renders Stats/Settings' live bits on every visit.
function basculerVersOnglet(nomNav) {
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("is-active", item.dataset.nav === nomNav);
  });
  document.querySelectorAll(".view-panel").forEach((panel) => {
    panel.hidden = panel.dataset.viewPanel !== nomNav;
  });
  remonterPopupContent();

  if (nomNav === "stats") initStatsPage();
  if (nomNav === "settings") {
    initSupportedSitesList();
    mettreAJourDetectionSettings(dernierReponseConnue);
  }
}

function initBottomNav() {
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.addEventListener("click", () => basculerVersOnglet(item.dataset.nav));
  });
}

// Live toast on real skip while the popup happens to be open — an
// auto-skip that happened while the popup was closed just shows up in
// Recently Skipped on next open.
function initSkipToastWatcher() {
  let dernierHorodatageConnu = null;

  chrome.storage.local.get([STORAGE_KEY_HISTORY], (resultat) => {
    dernierHorodatageConnu = (resultat[STORAGE_KEY_HISTORY] || [])[0]?.horodatage ?? null;
  });

  chrome.storage.onChanged.addListener((changements, zone) => {
    if (zone !== "local" || !changements[STORAGE_KEY_HISTORY]) return;

    const nouvelle = changements[STORAGE_KEY_HISTORY].newValue || [];
    const plusRecent = nouvelle[0];
    if (!plusRecent || plusRecent.horodatage === dernierHorodatageConnu) return;
    dernierHorodatageConnu = plusRecent.horodatage;

    afficherToast("Intro Skipped", `Saved ${formaterSecondesGagnees(plusRecent.secondes || 0).replace("+", "")}`);
    initHistoryCard();
    initStatsPage();
  });
}

// One delegated listener instead of one per button.
function initRipple() {
  document.addEventListener("click", (event) => {
    const cible = event.target.closest(".icon-btn, .action-tab, .btn-settings-action");
    if (!cible) return;

    const rect = cible.getBoundingClientRect();
    const taille = Math.max(rect.width, rect.height);
    const span = document.createElement("span");
    span.className = "ripple";
    span.style.width = `${taille}px`;
    span.style.height = `${taille}px`;
    span.style.left = `${event.clientX - rect.left - taille / 2}px`;
    span.style.top = `${event.clientY - rect.top - taille / 2}px`;
    cible.appendChild(span);
    span.addEventListener("animationend", () => span.remove());
  });
}
