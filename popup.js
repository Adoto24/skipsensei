/* ============================================================
   popup.js
   ------------------------------------------------------------
   Popup UI for the SkipSensei extension. Keys below are shared with
   content.js/player-frame.js — keep them in sync if renamed there.
   ============================================================ */

// Same key + shape as content.js's STORAGE_KEY_SETTINGS: { autoSkipEnabled }
const STORAGE_KEY_SETTINGS = "asi-settings";
// Same key + shape as player-frame.js's STORAGE_KEY_STATS: { "YYYY-MM": { skips, secondesGagnees } }
const STORAGE_KEY_STATS = "asi-stats";
// Same key + shape as content.js's STORAGE_KEY_HISTORY: [{ serie, episode, secondes, declencheur, horodatage, malId, site }, ...]
const STORAGE_KEY_HISTORY = "asi-history";
// Popup-only preference (dark/light look), not shared with content.js.
const STORAGE_KEY_THEME = "asi-theme";
// Same prefix as content.js's STORAGE_PREFIX_TIMING: "asi-timing::<serie>::<episode>".
// Only manual overrides are ever stored under this prefix — auto-detected
// (AniSkip/OAT) timings are kept in memory only, see content.js.
const STORAGE_PREFIX_TIMING = "asi-timing::";
// Same prefix + shape as content.js's/player-frame.js's STORAGE_PREFIX_POSTER:
// "asi-poster::<malId>" -> { url: string|null, cachedAt }.
const STORAGE_PREFIX_POSTER = "asi-poster::";
// Same keys/shapes as content.js's/player-frame.js's enregistrerActiviteEtRecords.
const STORAGE_KEY_ACTIVITY = "asi-activity"; // { "YYYY-MM-DD": { skips, secondesGagnees } }
const STORAGE_KEY_FAVORIS_SERIES = "asi-fav-series"; // { [serie]: skipCount }
const STORAGE_KEY_FAVORIS_SITES = "asi-fav-sites"; // { [site]: skipCount }
const STORAGE_KEY_RECORD = "asi-record"; // { secondes, serie, episode, horodatage }
// Resolution-cache prefixes cleared by Settings > Advanced > "Clear resolution
// cache" — everything content.js/resolution.js caches en route to a malId,
// EXCLUDING asi-timing:: (manual overrides — a real user action, not a cache)
// and the stats/activity keys above (cleared separately by "Reset statistics").
const STORAGE_PREFIX_MALID = "asi-malid::";
const STORAGE_PREFIX_SEQUEL_MALID = "asi-sequelmalid::";
const STORAGE_PREFIX_SAISONS = "asi-saisons::";
const STORAGE_PREFIX_ANIDBID = "asi-anidbid::";

// The only two sites content.js's ADAPTATEURS_SITE actually supports (see
// manifest.json's first content_scripts "matches") — same nomSite branding
// strings as there. Duplicated rather than imported for the same reason
// every other shared constant in this file is: no module system links this
// popup to content.js.
const SITES_SUPPORTES = [
  { hostname: "anime-sama.to", nomSite: "Anime-Sama" },
  { hostname: "voiranime.rip", nomSite: "VoirAnime" },
];

// Updated by rafraichirEtatVivant() every ~3s while the popup is open;
// read by anything that wants "the last thing we heard from the active
// tab's content script" without forcing a fresh round-trip (autoskip
// toggle clicks, opening Settings' Detection section).
let dernierStatutConnu = "offline";
let dernierReponseConnue = null;

// Every init*() below is independent: a DOM element missing or a
// chrome.* API misbehaving in one must not stop the others from
// running. Without this isolation, one thrown error partway through
// this list silently skips every init call after it — including their
// addEventListener calls — which looks exactly like "nothing responds
// to clicks" for whichever feature happened to be listed later.
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
// Formatting helpers, reused across the dashboard/history/stats views.
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

/** Short "2m ago" / "3h ago" / "Yesterday" / "Jul 28" style relative time. */
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

/**
 * Splits a "asi-timing::<serie>::<episode>" key back into its parts.
 * lastIndexOf rather than a plain split("::") so a series name that
 * happens to contain "::" itself (unlikely, but not impossible) doesn't
 * get split in the wrong place — the episode is always the last segment.
 */
function analyserCleTiming(cle) {
  const reste = cle.slice(STORAGE_PREFIX_TIMING.length);
  const indexSeparateur = reste.lastIndexOf("::");
  if (indexSeparateur === -1) return { serie: reste, episode: null };
  return {
    serie: reste.slice(0, indexSeparateur),
    episode: reste.slice(indexSeparateur + 2),
  };
}

/**
 * Reads the version straight from manifest.json (chrome.runtime.getManifest)
 * instead of hardcoding it in popup.html — that copy had already drifted
 * out of sync with manifest.json's real version once before this fix.
 */
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

/**
 * Brief visible feedback. `titre` alone still works exactly as before
 * (every pre-existing call site). `sousTitre` adds a second line, for
 * cases like the "Intro Skipped / Saved 1m 28s" toast fired by
 * initSkipToastWatcher below.
 */
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
  // Force layout so the opacity/transform transition replays even if
  // a toast is already showing when a second click comes in.
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
// Shared "full-panel swap" mechanism for Settings and Manual Timings:
// opening either hides every dashboard/stats view-panel and the bottom
// nav (so nothing duplicates what the detail panel itself shows), and
// only one detail panel is ever open at a time.
// ------------------------------------------------------------
/**
 * Scrolls #popup-content back to the top. Needed because every tab/detail
 * panel shares that one scroll container (see popup.css .popup-content) —
 * without this, switching from a tab scrolled halfway down to a shorter
 * one would land already scrolled (clamped to that panel's own max), not
 * at its top.
 */
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

/**
 * Wires Manual Timings, Keyboard Shortcuts and Support as the three detail
 * panels, the last opened by the header heart button as its own full-panel
 * view instead of jumping into the Settings tab. Settings keeps its own
 * copy of the same support-card in its About section (#settings-about) —
 * this button is now a shortcut to a dedicated view, not a replacement
 * for it. Settings itself is no longer a detail-panel overlay — it's a
 * real bottom-nav destination, see initBottomNav/basculerVersOnglet.
 */
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

/**
 * Lists every manually-saved intro timing (chrome.storage.local keys
 * prefixed "asi-timing::") with a delete button per entry. Lives in its
 * own Manual Timings quick-action panel (moved out of Settings, which was
 * otherwise just duplicating this one list).
 *
 * A manual timing permanently overrides the auto-detected (AniSkip/Open
 * Anime Timestamps) one for that exact episode — see resoudreEtAfficher in
 * content.js. Deleting an entry here is picked up immediately by any open
 * tab on that episode via content.js's chrome.storage.onChanged listener —
 * no page reload needed.
 */
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
        // textContent throughout: `serie` comes from document.title on the
        // anime site (see content.js adapters), untrusted as far as this
        // popup is concerned — same reasoning as construireElementHistorique.
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

/** Settings > Advanced: reset-stats (now also clearing the new tracking
 * keys) and the new "clear resolution cache" troubleshooting action. */
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

/** Settings > Supported Sites: the two real sites, with a live dot for
 * whether the active tab is on one of them right now. */
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

/** Settings > Detection: static cascade order (always shown) + a dynamic
 * "last match" line sourced from the active tab's resolved timing, when
 * there is one. */
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

/**
 * The one real Auto Skip Intro toggle — mirrored between the Dashboard
 * hero card and Settings > Playback (same chrome.storage.local["asi-settings"]
 * key content.js's on-page toggle also reads, so every surface always
 * agrees). Both toggle elements are driven from one read/write here.
 */
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

  // New: pick up the "A" keyboard shortcut (content.js) toggling the same
  // storage key while the popup happens to be open at the same time —
  // without this, the popup's own toggle would silently disagree with the
  // page's until the popup was closed and reopened.
  chrome.storage.onChanged.addListener((changements, zone) => {
    if (zone !== "local" || !changements[STORAGE_KEY_SETTINGS]) return;
    appliquerEtat(changements[STORAGE_KEY_SETTINGS].newValue?.autoSkipEnabled ?? true);
  });
}

/**
 * Real light/dark theme toggle: swaps a body class (which flips the CSS
 * custom properties in popup.css), persisted so it's remembered next time
 * the popup opens. Mirrored between the header icon button and the
 * Settings > Appearance toggle switch, same as Auto Skip Intro above.
 */
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
// Live state: Currently Watching + the Auto Skip Intro card's status
// subtitle both come from the exact same chrome.tabs.sendMessage
// round-trip to content.js's "asi-get-state" handler, refreshed on a
// timer while the popup stays open — one request feeding two render
// targets, not two separate polls.
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
        // runtime.lastError" — happens whenever no content script is
        // listening on this tab (unsupported site, or still loading).
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(reponse || null);
      });
    });
  });
}

/**
 * Reduces a raw asi-get-state response to one of 4 states, every one of
 * them backed by a real signal from content.js — never fabricated:
 * - "offline": no content script answered (unsupported site), OR one did
 *   but hasn't detected a series/episode yet (folded together since
 *   there's nothing meaningful to render for either case).
 * - "scanning": series/episode known, timing not resolved yet.
 * - "ready": timing resolved (AniSkip/OAT/manual).
 * - "skipping": content.js's own best-effort current-time check (see its
 *   asi-get-state handler) says playback is inside the skip window.
 */
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
  // Only actually touches the DOM if Settings is currently open — a no-op
  // (element hidden, but still cheap) otherwise.
  mettreAJourDetectionSettings(reponse);
}

/** Popup-open-only polling, mirroring content.js's own 3s safety-net
 * interval — cleared once the popup is no longer visible so nothing
 * keeps ticking after it's closed. */
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

/**
 * Builds one <li> for the "Recently Skipped" list. Uses textContent
 * throughout rather than innerHTML: `serie`/`site` come from document.title/
 * the page (see content.js adapters), untrusted input as far as this popup
 * is concerned.
 */
function construireElementHistorique(entree, posters) {
  const li = document.createElement("li");
  li.className = "history-item";

  const thumb = document.createElement("div");
  thumb.className = "thumb thumb-generic";

  // entree.malId is missing on history entries recorded before poster
  // support was added, and posters[...] may not exist yet either (Jikan
  // lookup is fire-and-forget and may not have finished) — both cases
  // fall through to the existing generic placeholder background below.
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

/**
 * Reads the real skip history (written by content.js on a "Skip Intro"
 * click and by player-frame.js on a fully automatic skip) and renders it.
 * The card itself is capped to a few rows tall (see .history-list in
 * popup.css) and scrolls internally for the rest.
 */
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

    // One batched read for every malId in this list instead of one
    // storage call per row.
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

/** Local-midnight day key, same format as content.js's cleJourActuel — a
 * plain `new Date("YYYY-MM-DD")` parses as UTC and can land on the wrong
 * calendar day near a timezone boundary, so streak math always goes
 * through this instead. */
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
  // with nothing skipped, same convention as most habit trackers).
  let curseur = new Date();
  curseur.setHours(0, 0, 0, 0);
  if (!joursSet.has(cleJourActuel())) curseur = new Date(curseur.getTime() - MS_JOUR);
  let actuel = 0;
  while (joursSet.has(`${curseur.getFullYear()}-${String(curseur.getMonth() + 1).padStart(2, "0")}-${String(curseur.getDate()).padStart(2, "0")}`)) {
    actuel += 1;
    curseur = new Date(curseur.getTime() - MS_JOUR);
  }

  // Longest streak ever: scan the sorted day list for the longest run of
  // calendar-consecutive days.
  let record = 1;
  let courant = 1;
  for (let i = 1; i < jours.length; i++) {
    const diffJours = Math.round((analyserCleJour(jours[i]) - analyserCleJour(jours[i - 1])) / MS_JOUR);
    courant = diffJours === 1 ? courant + 1 : 1;
    record = Math.max(record, courant);
  }

  return { actuel, record };
}

/** rAF-driven count-up, eased out — used for the Stats hero counters. */
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

/** One bar-chart column per entree = { valeur, label, accent, title }. */
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

    // Animate in on next frame rather than setting the final height
    // immediately, so the transition (popup.css) actually plays.
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

/**
 * Renders the whole Stats page from asi-stats (existing, month-bucketed)
 * plus the new asi-activity/asi-fav-series/asi-fav-sites/asi-record keys
 * (see enregistrerActiviteEtRecords in content.js/player-frame.js).
 * Every tile shows "—" + an explanatory tooltip instead of a bare "0"
 * when there's genuinely no data yet.
 */
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

  // "Time Saved Today" chip on Recently Skipped's header — same
  // asi-activity data, cheap enough to refresh alongside the rest of
  // this page's read.
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
// Quick Actions: Contribute has no real destination yet (see README for
// what's actually implemented) — labeled "Soon" on the tab itself
// (popup.html) and a toast on click. Shortcuts and Manual Timings both
// open a real panel now, wired in initDetailPanels below.
// ------------------------------------------------------------
function initStaticTabs() {
  document.querySelectorAll('.action-tab[data-tab="contribute"]').forEach((tab) => {
    tab.addEventListener("click", () => {
      afficherToast("Contributing — coming soon");
    });
  });
}

/**
 * Switches the active bottom-nav destination to `nomNav` ("dashboard" |
 * "stats" | "settings") — shared by the nav-item click handlers below and
 * by the header heart button (initDetailPanels), which jumps straight to
 * the Settings tab instead of opening it as a separate overlay. Re-renders
 * Stats/Settings' live bits on every visit (cheap local reads) so they
 * feel fresh rather than replaying stale data from when the popup opened.
 */
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

/** Bottom navigation: Dashboard / Stats / Settings, see basculerVersOnglet. */
function initBottomNav() {
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.addEventListener("click", () => basculerVersOnglet(item.dataset.nav));
  });
}

/**
 * Live toast on real skip, while the popup happens to be open — the
 * popup unloads entirely when closed, so this can never fire for an
 * auto-skip that happened in the background; the next popup open just
 * shows it in Recently Skipped instead, which is expected.
 */
function initSkipToastWatcher() {
  let dernierHorodatageConnu = null;

  chrome.storage.local.get([STORAGE_KEY_HISTORY], (resultat) => {
    dernierHorodatageConnu = (resultat[STORAGE_KEY_HISTORY] || [])[0]?.horodatage ?? null;
  });

  chrome.storage.onChanged.addListener((changements, zone) => {
    if (zone !== "local" || !changements[STORAGE_KEY_HISTORY]) return;

    const nouvelle = changements[STORAGE_KEY_HISTORY].newValue || [];
    const plusRecent = nouvelle[0];
    // No newest entry (a reset), or the newest entry is one we've already
    // shown a toast for (this popup's own reset/reload triggered the
    // change): nothing new to celebrate.
    if (!plusRecent || plusRecent.horodatage === dernierHorodatageConnu) return;
    dernierHorodatageConnu = plusRecent.horodatage;

    afficherToast("Intro Skipped", `Saved ${formaterSecondesGagnees(plusRecent.secondes || 0).replace("+", "")}`);
    initHistoryCard();
    initStatsPage();
  });
}

// ------------------------------------------------------------
// Ripple: one delegated listener instead of one per button, for every
// icon button / quick-action tab / settings action (all three are
// `position: relative; overflow: hidden` in popup.css already).
// ------------------------------------------------------------
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
