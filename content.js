/* ============================================================
   content.js
   ------------------------------------------------------------
   Ce script tourne sur la page principale du site anime (PAS
   dans l'iframe du lecteur vidéo, qui est un domaine différent
   comme vidmoly.biz, video.sibnet.ru ou sendvid.com).

   Multi-site (new): seule l'extraction du nom de série + numéro
   d'épisode change d'un site à l'autre (chaque site a son propre
   format de titre/URL/sélecteurs) — voir ADAPTATEURS_SITE un peu
   plus bas. Tout le reste (résolution AniSkip, cache, panneau UI,
   auto-skip, communication avec l'iframe) est partagé et identique
   quel que soit le site.

   Son rôle :
   - via l'adaptateur du site courant, trouver le nom de la série
     et le numéro d'épisode
   - essayer de résoudre automatiquement les timings d'intro/ending,
     en cascade : AniSkip d'abord, puis Open Anime Timestamps
     (Jikan/AniList pour trouver l'ID MyAnimeList, relations.yuna.moe
     pour le convertir en ID AniDB), avec repli sur le marquage manuel
     si aucune des deux sources n'a rien
   - afficher/gérer le panneau flottant
   - communiquer avec player-frame.js (qui tourne DANS l'iframe)
     via window.postMessage, puisqu'on ne peut pas accéder
     directement au <video> d'un domaine différent.
   ============================================================ */

if (window.__animeSkipIntroInjected) {
  console.log("[SkipSensei] Script déjà présent, on ne relance pas.");
} else {
  window.__animeSkipIntroInjected = true;

  // Préfixe utilisé pour reconnaître nos propres messages postMessage
  // (et ignorer tous les autres messages qui pourraient circuler sur la page).
  const CANAL = "anime-skip-intro";

  // Keyboard shortcuts (new) — see gestionnaireClavier near the bottom of
  // this file. Plain letter keys, no modifier: kept in one place so they're
  // easy to change later. Case-insensitive (event.key lower-cased before
  // lookup), so Shift+<key> also works.
  const RACCOURCIS_CLAVIER = {
    s: "skip-intro",
    m: "marquer-fin",
    a: "toggle-auto-skip",
  };

  // Safety-net poll only now (see the "change" listener + MutationObserver
  // set up at the bottom of this file): most iframe/episode changes are
  // caught immediately, so this just guards against anything that slips
  // through (e.g. a site update that changes how episodes are switched).
  const INTERVALLE_VERIFICATION_MS = 3000;
  const DELAI_REPONSE_IFRAME_MS = 1500;

  // Domaines des lecteurs vidéo tiers connus (voir manifest.json, deuxième
  // content_scripts). Utilisé pour préférer un iframe reconnu plutôt que le
  // premier iframe trouvé sur la page, qui pourrait être une pub.
  const DOMAINES_LECTEUR_CONNUS = ["vidmoly", "sibnet", "sendvid"];

  // ------------------------------------------------------------
  // AniSkip integration (new).
  // English comments below, as requested, for this new logic.
  // ------------------------------------------------------------
  // ANISKIP_CACHE_TTL_MS, FETCH_TIMEOUT_MS, JIKAN_SEARCH_URL and
  // ANILIST_GRAPHQL_URL now live in resolution.js (see that file's header
  // comment for why it's a plain shared-scope script, not an import).
  const ANISKIP_BASE_URL = "https://api.aniskip.com/v2/skip-times";

  // OVERRIDES_MALID moved to resolution.js (used only by resoudreMalId there).

  // ------------------------------------------------------------
  // Open Anime Timestamps (new, second auto-detection source, tried
  // after AniSkip). Unlike AniSkip it's not an API but a static JSON
  // dataset on GitHub, keyed by AniDB id — relations.yuna.moe converts
  // the MAL id we already have into an AniDB id. It also only records
  // where the opening *starts*, never where it ends, so the end is
  // approximated with OAT_DUREE_OP_DEFAUT_S; less precise than AniSkip,
  // which is why this is tried second, not first.
  // ------------------------------------------------------------
  const RELATIONS_YUNA_URL = "https://relations.yuna.moe/api/ids";
  const OPEN_ANIME_TIMESTAMPS_URL =
    "https://raw.githubusercontent.com/jonbarrow/open-anime-timestamps/master/timestamps.json";
  const OAT_DUREE_OP_DEFAUT_S = 90; // typical anime OP length
  const STORAGE_KEY_OAT_CACHE = "asi-oat-cache"; // the ~2MB dataset, cached instead of refetched every episode

  const STORAGE_PREFIX_TIMING = "asi-timing::"; // per series+episode
  // STORAGE_PREFIX_MALID, STORAGE_PREFIX_SEQUEL_MALID and
  // STORAGE_PREFIX_SAISONS moved to resolution.js (used only there).
  const STORAGE_KEY_SETTINGS = "asi-settings";
  // Shared with player-frame.js — keep these two in sync if renamed there.
  const STORAGE_KEY_STATS = "asi-stats"; // { "YYYY-MM": { skips, secondesGagnees } }
  const STORAGE_KEY_HISTORY = "asi-history"; // [{ serie, episode, secondes, declencheur, horodatage, malId, site }, ...]
  const HISTORIQUE_TAILLE_MAX = 20;
  // Shared with player-frame.js — new (popup Stats page). Written by
  // enregistrerActiviteEtRecords, one call per real skip (manual or auto),
  // alongside the STATS/HISTORY writes above.
  const STORAGE_KEY_ACTIVITY = "asi-activity"; // { "YYYY-MM-DD": { skips, secondesGagnees } }
  const STORAGE_KEY_FAVORIS_SERIES = "asi-fav-series"; // { [serie]: skipCount }
  const STORAGE_KEY_FAVORIS_SITES = "asi-fav-sites"; // { [site]: skipCount }
  const STORAGE_KEY_RECORD = "asi-record"; // { secondes, serie, episode, horodatage } — longest single skip ever

  // Bug fix (see resoudreAniDbId/assurerPosterEnCache below): both of these
  // were referenced already but never actually declared anywhere content.js
  // could see them, which threw a ReferenceError the moment either function
  // ran — resoudreAniDbId every time AniSkip had no data (breaking the Open
  // Anime Timestamps fallback entirely for that episode) and
  // assurerPosterEnCache on every manual "Skip Intro" click (the actual
  // cause of Recently Skipped's missing posters for clicked, non-auto
  // skips — see enregistrerSkip). player-frame.js has its own valid copy of
  // STORAGE_PREFIX_POSTER (separate document/scope, the iframe), which is
  // why auto-skip-recorded posters were unaffected.
  const STORAGE_PREFIX_ANIDBID = "asi-anidbid::"; // per MAL id -> AniDB id
  const STORAGE_PREFIX_POSTER = "asi-poster::"; // per MAL id -> { url, cachedAt }
  // A failed Jikan poster lookup (rate-limit, timeout, network error) is
  // retried after this TTL instead of being cached as a permanent null —
  // see assurerPosterEnCache. A *successful* lookup has no TTL: Jikan's
  // poster URL for a given anime doesn't change, so it's cached forever.
  const POSTER_ECHEC_TTL_MS = 24 * 60 * 60 * 1000; // 24h

  // Tracks AniSkip attempts per (série, épisode) key so the polling loop
  // (every 2s) doesn't hammer the API. Two kinds of "no result" are
  // treated differently:
  // - definitif: true  -> AniSkip actually answered "no skip data for
  //   this episode" (404, or found: false). Confirmed absence, no point
  //   retrying until a full page reload.
  // - definitif: false -> the attempt itself failed (network error,
  //   timeout, 5xx from AniSkip). That's very likely transient (e.g. the
  //   outage observed live while building this: AniSkip returning 500 for
  //   every request for a while) — retried automatically after
  //   COOLDOWN_APRES_ECHEC_MS instead of giving up for the whole session,
  //   so auto-detection recovers on its own once the API comes back.
  const COOLDOWN_APRES_ECHEC_MS = 60 * 1000;
  const tentativesEffectuees = new Map(); // cle -> { dernierEssai, definitif }

  function tentativeEncoreValide(cle) {
    const entree = tentativesEffectuees.get(cle);
    if (!entree) return true;
    if (entree.definitif) return false;
    return Date.now() - entree.dernierEssai > COOLDOWN_APRES_ECHEC_MS;
  }

  // Auto-detected results (AniSkip or Open Anime Timestamps) are resolved
  // fresh and kept only in memory (new) — we no longer persist them to
  // chrome.storage.local. Those sources already have that data, so
  // there's no point duplicating it on disk; only manual overrides
  // (which neither source has) get saved. This also keeps the popup's
  // "séries enregistrées" list limited to entries the user actually
  // marked themselves.
  const cacheTimingAutoEnMemoire = new Map();

  // The Open Anime Timestamps dataset (~2MB) fetched at most once per
  // page session, kept here so a second episode on the same page (SPA
  // navigation) doesn't refetch it — obtenirDatasetOpenAnimeTimestamps()
  // also persists it to chrome.storage.local across page loads.
  let datasetOpenAnimeTimestampsEnMemoire = null;

  let serieActuelle = null;
  let nomSerieBaseActuelle = null;
  let saisonActuelle = null;
  let episodeActuel = null;
  let timingActuel = null;

  // ------------------------------------------------------------
  // contexteValide, avertirContexteInvalide, storageGet and storageSet
  // moved to resolution.js (shared global scope, see that file's header
  // comment) so the resolution cascade there can be unit tested with
  // chrome.storage.local/fetch mocked. Every call site below is
  // unchanged: those names still resolve, exactly as before.
  // ------------------------------------------------------------

  function cleMoisActuel() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  function cleJourActuel() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  /**
   * Powers the popup's Stats page beyond the plain month/history totals:
   * daily activity (streaks + the 7-day chart + "time saved today", none
   * of which are derivable from the month-bucketed STORAGE_KEY_STATS),
   * favorite series/site (skip counts aren't tracked per-series/site
   * anywhere else), and the true all-time longest single skip (scanning
   * STORAGE_KEY_HISTORY for a max would be wrong once a longer skip ages
   * out past HISTORIQUE_TAILLE_MAX). One batched read + one batched write
   * for all four keys, called alongside the STATS/HISTORY writes in
   * enregistrerSkip (here) and enregistrerSkipAutomatique (player-frame.js
   * — duplicated there for the same reason storageGet/fetchAvecTimeout
   * already are: no shared module between the two content scripts).
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
   * Records one real skip (this month's counter in STORAGE_KEY_STATS +
   * a new entry at the top of STORAGE_KEY_HISTORY, capped to the most
   * recent HISTORIQUE_TAILLE_MAX). Called from here when the user clicks
   * "Skip Intro" (declencheur "clic"), and from player-frame.js when
   * auto-skip fires on its own (declencheur "auto") — both are real
   * skips and both count, per the requested behavior.
   */
  async function enregistrerSkip(nomSerie, episode, secondesGagnees, declencheur, malId, site) {
    const [statsResultat, historiqueResultat] = await Promise.all([
      storageGet([STORAGE_KEY_STATS]),
      storageGet([STORAGE_KEY_HISTORY]),
    ]);

    const stats = statsResultat[STORAGE_KEY_STATS] || {};
    const mois = cleMoisActuel();
    const statsDuMois = stats[mois] || { skips: 0, secondesGagnees: 0 };
    statsDuMois.skips += 1;
    statsDuMois.secondesGagnees += Math.max(secondesGagnees, 0);
    stats[mois] = statsDuMois;

    const horodatage = Date.now();
    const historique = historiqueResultat[STORAGE_KEY_HISTORY] || [];
    historique.unshift({
      serie: nomSerie,
      episode,
      secondes: Math.max(secondesGagnees, 0),
      declencheur,
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

  /**
   * Looks up and caches a poster image URL for a MAL id (new), so the
   * popup's "Recently Skipped" list can show real cover art. A successful
   * lookup is cached permanently — Jikan's poster URL for a given anime
   * doesn't change. A *failed* lookup (network error, timeout, Jikan
   * rate-limit, non-ok response) is cached too, but only for
   * POSTER_ECHEC_TTL_MS: without that, a single transient failure the
   * first time a given malId was ever looked up (e.g. Jikan's 60/min rate
   * limit during a binge session) would permanently blank that anime's
   * poster for every future skip, with no automatic recovery. Never
   * awaited by its caller: a slow or failing Jikan request must never
   * block/delay recording the skip itself, only the popup thumbnail is
   * affected.
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
        const reponse = await fetchAvecTimeout(`${JIKAN_SEARCH_URL}/${malId}`);
        if (reponse.ok) {
          const donnees = await reponse.json();
          url = donnees?.data?.images?.jpg?.image_url || donnees?.data?.images?.jpg?.large_image_url || null;
        }
      } catch (erreur) {
        console.warn("[SkipSensei] Jikan poster fetch failed:", erreur.message);
      }

      await storageSet({ [cle]: { url, cachedAt: Date.now() } });
    } catch {
      // storageGet/storageSet already warn via avertirContexteInvalide() if
      // the extension was reloaded mid-flight; a missing poster is purely
      // cosmetic, nothing else to do here.
    }
  }

  /**
   * Vérifie si l'iframe du lecteur est présente sur la page, extrait
   * le nom de la série + l'épisode, résout le timing (AniSkip ou
   * manuel) et met à jour le bouton + l'iframe.
   */
  async function verifierPageEtMettreAJourUI() {
    const iframe = trouverIframeLecteur();

    if (!iframe) {
      serieActuelle = null;
      nomSerieBaseActuelle = null;
      saisonActuelle = null;
      episodeActuel = null;
      timingActuel = null;
      return;
    }

    const adaptateur = obtenirAdaptateur();
    const nomSerieBase = adaptateur.extraireNomSerie();
    const saison = adaptateur.extraireSaison ? adaptateur.extraireSaison() : 1;
    const episode = adaptateur.extraireEpisode();
    const obtenirUrlRacine = adaptateur.extraireUrlRacine || null;
    // Identité qualifiée par la saison (au-delà de la 1ère) : cleTiming,
    // le cache mémoire et l'historique doivent distinguer "Saison 2 Ép. 5"
    // de "Saison 1 Ép. 5" — sinon un timing manuel ou en cache pour l'un
    // s'appliquerait par erreur à l'autre (même bug que celui corrigé côté
    // malId dans resoudreMalIdEtEpisode, juste côté cache local).
    const nomSerie = saison > 1 ? `${nomSerieBase} (saison ${saison})` : nomSerieBase;
    const memeContexte = nomSerie === serieActuelle && episode === episodeActuel;
    nomSerieBaseActuelle = nomSerieBase;
    saisonActuelle = saison;

    // Re-resolve when the episode changed, but also when we're still
    // stuck on the manual fallback (timingActuel null) and a retry is
    // now due — otherwise a stuck episode would never pick up AniSkip
    // recovering mid-session, even past the cooldown.
    const doitReessayer = !timingActuel && tentativeEncoreValide(cleTiming(nomSerie, episode));

    if (!memeContexte || doitReessayer) {
      serieActuelle = nomSerie;
      episodeActuel = episode;
      timingActuel = await resoudreEtAfficher(iframe, nomSerie, nomSerieBase, saison, episode, obtenirUrlRacine);
    }

    // Always re-push the current timing + auto-skip setting to the player
    // iframe, even when nothing changed, so toggling the setting from the
    // popup (or from the on-page switch) takes effect within one polling
    // interval.
    const parametres = await storageGet([STORAGE_KEY_SETTINGS]);
    const autoSkipEnabled = parametres[STORAGE_KEY_SETTINGS]?.autoSkipEnabled ?? true;
    envoyerDonneesAutoSkip(iframe, nomSerie, episode, timingActuel, autoSkipEnabled);
  }

  // ------------------------------------------------------------
  // Per-site adapters (new). Each site has its own page structure, so
  // extracting the series name + episode number is the only part of
  // this script that needs a site-specific implementation. Keyed by
  // location.hostname; manifest.json's content_script "matches" is what
  // actually controls which hosts this script runs on at all.
  // ------------------------------------------------------------

  /**
   * anime-sama.to
   *
   * IMPORTANT (discovered while testing live): the episode number is
   * present NEITHER in document.title NOR in the URL — the site is a
   * single-page app, and switching episodes via the
   * <select id="selectEpisodes"> dropdown changes neither. That select's
   * selected option (e.g. "Episode 5") is the only reliable source.
   * Title looks like: "One Piece - Saga 1 (East Blue) | Anime-Sama - ...".
   */
  function extraireNomSerieAnimeSama() {
    const titrePage = document.title;
    if (!titrePage) return "serie-inconnue";

    const separateurs = [" - ", " | ", " – "];
    let nom = titrePage;

    for (const sep of separateurs) {
      if (nom.includes(sep)) {
        nom = nom.split(sep)[0];
        break;
      }
    }

    return nom.trim().toLowerCase();
  }

  function extraireEpisodeAnimeSama() {
    const select = document.querySelector("#selectEpisodes");
    if (select && select.selectedIndex >= 0) {
      const texte = select.options[select.selectedIndex]?.textContent || "";
      const correspondance = texte.match(/(\d+)/);
      if (correspondance) return parseInt(correspondance[1], 10);
    }

    return extraireEpisodeParRegexGenerique();
  }

  /**
   * voiranime.rip
   *
   * Unlike anime-sama.to, this is a traditional multi-page site: each
   * episode is its own full page load, and both the title and the URL
   * reliably contain the series name + episode number. Confirmed live:
   * title = "One Piece Saison 1 Épisode 8 en streaming VF et VOSTFR | Voiranime"
   * url   = "https://voiranime.rip/one-piece/saison-1/episode-8/?lang=vostfr"
   */
  function extraireNomSerieVoiranime() {
    const correspondance = document.title.match(/^(.*?)\s+Saison\s+\d+/i);
    const nom = correspondance ? correspondance[1] : document.title;
    return nom.trim().toLowerCase();
  }

  function extraireEpisodeVoiranime() {
    const correspondanceTitre = document.title.match(/épisode\s+(\d+)/i);
    if (correspondanceTitre) return parseInt(correspondanceTitre[1], 10);

    const correspondanceUrl = location.pathname.match(/episode-(\d+)/i);
    if (correspondanceUrl) return parseInt(correspondanceUrl[1], 10);

    return extraireEpisodeParRegexGenerique();
  }

  /**
   * voiranime.rip (new): the "Saison N" that extraireNomSerieVoiranime()
   * strips out of the title. Needed because the site resets its episode
   * numbering at 1 for every season, while on MAL/AniSkip's side each
   * season past the first is its own separate entry with its own episode
   * count — see resoudreMalIdEtEpisode for why this matters. Confirmed
   * live: title "Jujutsu Kaisen Saison 2 Épisode 5 en streaming..." and
   * URL ".../jujutsu-kaisen-1/saison-2/episode-5/" both carry it.
   */
  function extraireSaisonVoiranime() {
    const correspondanceTitre = document.title.match(/Saison\s+(\d+)/i);
    if (correspondanceTitre) return parseInt(correspondanceTitre[1], 10);

    const correspondanceUrl = location.pathname.match(/saison-(\d+)/i);
    if (correspondanceUrl) return parseInt(correspondanceUrl[1], 10);

    return 1; // pas de "Saison" détectée : une seule saison, comportement inchangé
  }

  /**
   * voiranime.rip (new): the anime's own root page (e.g.
   * ".../one-piece/" from ".../one-piece/saison-7/episode-3/"), used by
   * scraperComptesEpisodesParSaison to read the per-season episode counts
   * directly off the site — see resoudreMalIdEtEpisode. Derived from the
   * URL path's first segment rather than nomSerie, since the URL slug
   * ("one-piece") is stable and unambiguous, unlike a title-derived name.
   */
  function extraireUrlRacineVoiranime() {
    const segments = location.pathname.split("/").filter(Boolean);
    return segments.length > 0 ? `${location.origin}/${segments[0]}/` : null;
  }

  /**
   * voiranime.rip (new): VF/VOSTFR, read straight off the site's own
   * "?lang=vostfr" query param (confirmed live, see extraireEpisodeVoiranime's
   * doc comment for a full example URL) — a real signal the site already
   * exposes, not a guess. Returns null (not "unknown"/placeholder) when the
   * param is absent, so the popup's Currently Watching card can just omit
   * the language row entirely rather than show a made-up value. No
   * equivalent exists for anime-sama.to, so that adapter has no
   * extraireLangue at all.
   */
  function extraireLangueVoiranime() {
    const lang = new URLSearchParams(location.search).get("lang");
    return lang ? lang.toUpperCase() : null;
  }

  /**
   * Last-resort fallback shared by every adapter: look for
   * "episode 12" / "épisode 12" / "ep 12" in the title or URL. Useful if
   * a site's more specific extraction above doesn't match (title format
   * changed, page still loading, etc).
   */
  function extraireEpisodeParRegexGenerique() {
    const source = `${document.title} ${location.href}`;
    const correspondance = source.match(/(?:episode|épisode|ep)\s*\.?\s*(\d+)/i);
    return correspondance ? parseInt(correspondance[1], 10) : null;
  }

  const ADAPTATEURS_SITE = {
    "anime-sama.to": {
      // Site's own branding, used as-is (not translated) for the popup's
      // "Currently Watching ... on <site>" display.
      nomSite: "Anime-Sama",
      extraireNomSerie: extraireNomSerieAnimeSama,
      extraireEpisode: extraireEpisodeAnimeSama,
      // Pas de notion de "Saison" distincte sur ce site (voir le
      // commentaire de extraireEpisodeAnimeSama) : toujours 1, donc
      // resoudreMalIdEtEpisode se comporte exactement comme avant.
      extraireSaison: () => 1,
    },
    "voiranime.rip": {
      nomSite: "VoirAnime",
      extraireNomSerie: extraireNomSerieVoiranime,
      extraireEpisode: extraireEpisodeVoiranime,
      extraireSaison: extraireSaisonVoiranime,
      extraireUrlRacine: extraireUrlRacineVoiranime,
      extraireLangue: extraireLangueVoiranime,
    },
  };

  /** Picks the adapter for the current site, defaulting to anime-sama.to's. */
  function obtenirAdaptateur() {
    return ADAPTATEURS_SITE[location.hostname] || ADAPTATEURS_SITE["anime-sama.to"];
  }

  /**
   * Finds the video player iframe on the page. anime-sama.to gives it the
   * id "playerDF"; failing that, prefer an iframe whose src matches a
   * known player domain (see DOMAINES_LECTEUR_CONNUS) over blindly taking
   * the first iframe on the page, which on an ad-supported site like
   * voiranime.rip is as likely to be an ad slot as the actual player.
   * Still falls back to the first iframe found so a new/unlisted player
   * domain doesn't silently stop working.
   */
  function trouverIframeLecteur() {
    const parId = document.querySelector("iframe#playerDF");
    if (parId) return parId;

    const iframes = Array.from(document.querySelectorAll("iframe"));
    const connu = iframes.find((f) => DOMAINES_LECTEUR_CONNUS.some((d) => (f.src || "").includes(d)));
    if (connu) return connu;

    return iframes[0] || null;
  }

  /** Builds the chrome.storage.local key for a given series + episode. */
  function cleTiming(nomSerie, episode) {
    return `${STORAGE_PREFIX_TIMING}${nomSerie}::${episode ?? "?"}`;
  }

  // normaliserTitre, genererVariantesRecherche, fetchAvecTimeout,
  // choisirMeilleureCorrespondance, resoudreMalIdViaJikan,
  // resoudreMalIdViaAniList, verifierCoherenceMalId, resoudreMalId,
  // resoudreSequelMalId, scraperComptesEpisodesParSaison,
  // obtenirComptesEpisodesParSaison and resoudreMalIdEtEpisode all moved
  // to resolution.js (see that file's header comment) so the anime
  // resolution cascade can be unit tested. Every call site below is
  // unchanged: those names still resolve via the shared global scope.

  /**
   * AniSkip lookup for a MAL id + episode — first source tried in the
   * auto-detection cascade (see resoudreTimingAuto).
   *
   * Returns { timing, definitif }. `timing` is null when AniSkip has
   * nothing usable (no match, 404, empty results). `definitif` tells
   * the caller whether that "nothing" is AniSkip's confirmed answer
   * (true — no point asking again this session) or the attempt itself
   * failed (false — network error/timeout/5xx, likely transient,
   * worth retrying later).
   *
   * @param {number} episodeLength Real duration (seconds) of the video
   *   currently loaded in the player iframe, or 0 if unavailable (video
   *   not loaded yet). AniSkip requires this param and — per the
   *   official extension's own source — uses it to rescale the stored
   *   timestamps to match this exact release's runtime; passing a
   *   placeholder 0 (as this used to do) forces that rescale against a
   *   nonsensical value and has been observed to 500 on entries that
   *   need it, where the official extension (which always sends the
   *   real duration) succeeds on the identical request.
   */
  async function resoudreTimingAniSkip(malId, episode, episodeLength) {
    try {
      const url = `${ANISKIP_BASE_URL}/${malId}/${episode}?types=op&types=ed&episodeLength=${episodeLength.toFixed(3)}`;
      const reponse = await fetchAvecTimeout(url);

      if (reponse.status === 404) {
        return { timing: null, definitif: true }; // AniSkip confirmed: no data for this episode
      }
      if (!reponse.ok) {
        // Distinct from "no data for this episode" (404): the API itself
        // is erroring (e.g. observed live: a 500 outage affecting every
        // request regardless of anime/episode). Logged so this is
        // diagnosable from the page's console instead of silently falling
        // back to manual marking with no trace of why. Retryable: this
        // kind of failure is very likely transient.
        console.warn(`[SkipSensei] AniSkip returned ${reponse.status} for MAL id ${malId} ép. ${episode}.`);
        return { timing: null, definitif: false };
      }

      const donnees = await reponse.json();
      if (!donnees.found || !Array.isArray(donnees.results) || donnees.results.length === 0) {
        return { timing: null, definitif: true }; // AniSkip answered, just has nothing for this episode
      }

      const opening = donnees.results.find((r) => r.skipType === "op");
      if (!opening) {
        return { timing: null, definitif: true }; // we only auto-skip the opening ("skip intro")
      }

      const ending = donnees.results.find((r) => r.skipType === "ed");

      // NOTE: results also carry their own r.episodeLength (the runtime of
      // whatever release the timestamp was originally submitted from), and
      // in principle a mismatch against the real `episodeLength` sent above
      // means startTime/endTime should be shifted by the difference. A
      // client-side correction along those lines was tried here and pulled
      // back out: reverse-engineered from AniSkip's *minified* production
      // bundle, it caused auto-skip to fire on wrong/near-zero timestamps
      // with no user action — worse than not correcting at all. Using the
      // raw values below, as before, until this can be verified against
      // real (non-minified) source or documented behavior.
      return {
        timing: {
          debut: opening.interval.startTime,
          fin: opening.interval.endTime,
          // Ending timestamps are stored for completeness / possible future
          // use, but auto-skip currently only acts on the opening interval,
          // matching the extension's existing "skip intro" scope.
          debutEd: ending ? ending.interval.startTime : null,
          finEd: ending ? ending.interval.endTime : null,
          source: "aniskip",
          cachedAt: Date.now(),
        },
        definitif: true,
      };
    } catch (erreur) {
      console.warn("[SkipSensei] AniSkip request failed:", erreur.message);
      return { timing: null, definitif: false }; // network error/timeout — retryable
    }
  }

  /**
   * Converts a MAL id to an AniDB id via relations.yuna.moe, cached for
   * 7 days per series (same TTL/shape pattern as resoudreMalId).
   */
  async function resoudreAniDbId(malId) {
    const cle = `${STORAGE_PREFIX_ANIDBID}${malId}`;
    const cache = await storageGet([cle]);
    const entree = cache[cle];
    if (entree && Date.now() - entree.cachedAt < ANISKIP_CACHE_TTL_MS) {
      return entree.aniDbId; // may legitimately be null (previous lookup failed)
    }

    let aniDbId = null;
    try {
      const url = `${RELATIONS_YUNA_URL}?source=myanimelist&id=${malId}`;
      const reponse = await fetchAvecTimeout(url);
      if (reponse.ok) {
        const donnees = await reponse.json();
        aniDbId = typeof donnees?.anidb === "number" ? donnees.anidb : null;
      }
    } catch (erreur) {
      console.warn("[SkipSensei] relations.yuna.moe request failed:", erreur.message);
    }

    await storageSet({ [cle]: { aniDbId, cachedAt: Date.now() } });
    return aniDbId;
  }

  /**
   * Fetches the Open Anime Timestamps dataset (once per page session,
   * cached across sessions in chrome.storage.local for ANISKIP_CACHE_TTL_MS
   * — it's a static file that's rarely updated, no need to redownload
   * ~2MB on every episode).
   */
  async function obtenirDatasetOpenAnimeTimestamps() {
    if (datasetOpenAnimeTimestampsEnMemoire) return datasetOpenAnimeTimestampsEnMemoire;

    const cache = await storageGet([STORAGE_KEY_OAT_CACHE]);
    const entree = cache[STORAGE_KEY_OAT_CACHE];
    if (entree && Date.now() - entree.cachedAt < ANISKIP_CACHE_TTL_MS) {
      datasetOpenAnimeTimestampsEnMemoire = entree.data;
      return datasetOpenAnimeTimestampsEnMemoire;
    }

    const reponse = await fetchAvecTimeout(OPEN_ANIME_TIMESTAMPS_URL);
    if (!reponse.ok) throw new Error(`HTTP ${reponse.status}`);
    const donnees = await reponse.json();

    datasetOpenAnimeTimestampsEnMemoire = donnees;
    await storageSet({ [STORAGE_KEY_OAT_CACHE]: { data: donnees, cachedAt: Date.now() } });
    return donnees;
  }

  /**
   * Open Anime Timestamps lookup — second source tried, only reached
   * when AniSkip has nothing. Same { timing, definitif } contract as
   * resoudreTimingAniSkip. Unlike AniSkip, this dataset only records
   * where the opening *starts* (no end time), so `fin` here is an
   * estimate (start + OAT_DUREE_OP_DEFAUT_S) — noticeably less precise
   * than AniSkip's measured interval.
   */
  async function resoudreTimingOpenAnimeTimestamps(malId, episode) {
    const aniDbId = await resoudreAniDbId(malId);
    if (aniDbId == null) {
      // relations.yuna.moe not resolving isn't necessarily "no mapping
      // exists" — treat as retryable rather than a confirmed dead end.
      return { timing: null, definitif: false };
    }

    let dataset;
    try {
      dataset = await obtenirDatasetOpenAnimeTimestamps();
    } catch (erreur) {
      console.warn("[SkipSensei] Open Anime Timestamps fetch failed:", erreur.message);
      return { timing: null, definitif: false };
    }

    const entrees = dataset[String(aniDbId)];
    if (!Array.isArray(entrees)) {
      return { timing: null, definitif: true }; // dataset loaded fine, this AniDB id just isn't in it
    }

    const entree = entrees.find((e) => e.episode_number === episode);
    if (!entree || typeof entree.opening_start !== "number" || entree.opening_start < 0) {
      return { timing: null, definitif: true }; // dataset loaded fine, nothing usable for this episode
    }

    return {
      timing: {
        debut: entree.opening_start,
        fin: entree.opening_start + OAT_DUREE_OP_DEFAUT_S,
        source: "open-anime-timestamps",
        cachedAt: Date.now(),
      },
      definitif: true,
    };
  }

  /**
   * Runs the auto-detection cascade for (nomSerie, episode): AniSkip
   * first, Open Anime Timestamps second, stopping at the first source
   * that returns a timing. Logs which source answered (or didn't) at
   * each step. Returns { timing, definitif } — definitif is true only
   * when EVERY attempted source gave a confirmed "no data" answer; a
   * single transient failure keeps the whole attempt retryable.
   */
  async function resoudreTimingAuto(nomSerieBase, saison, episodeSite, episodeLength, obtenirUrlRacine) {
    // "serie-inconnue" is extraireNomSerieAnimeSama()'s fallback when
    // document.title is empty (page still loading, most likely) — no point
    // spending a Jikan/AniList search on a name we know can't match.
    // definitif: false so it's retried once the title actually loads,
    // instead of being marked as a confirmed dead end for the session.
    if (!nomSerieBase || nomSerieBase === "serie-inconnue") {
      return { timing: null, definitif: false };
    }

    const { malId, episode } = await resoudreMalIdEtEpisode(nomSerieBase, saison, episodeSite, obtenirUrlRacine);
    if (!malId || episode == null) {
      console.log(
        `[SkipSensei] Source: aucune — pas d'ID MyAnimeList/épisode résolu pour "${nomSerieBase}" (saison ${saison}, ép. site ${episodeSite}).`
      );
      return { timing: null, definitif: false };
    }
    const suffixeEpisode = episode === episodeSite ? `ép. ${episode}` : `ép. site ${episodeSite} -> ép. absolu ${episode}`;

    const resultatAniSkip = await resoudreTimingAniSkip(malId, episode, episodeLength);
    if (resultatAniSkip.timing) {
      resultatAniSkip.timing.malId = malId; // carried through to enregistrerSkip/envoyerDonneesAutoSkip
      console.log(`[SkipSensei] Source: AniSkip — timing trouvé pour "${nomSerieBase}" saison ${saison} ${suffixeEpisode}.`);
      return resultatAniSkip;
    }
    console.log(
      `[SkipSensei] Source: AniSkip — rien pour "${nomSerieBase}" saison ${saison} ${suffixeEpisode} ` +
        `(${resultatAniSkip.definitif ? "aucune donnée" : "échec temporaire"}), essai suivant...`
    );

    const resultatOAT = await resoudreTimingOpenAnimeTimestamps(malId, episode);
    if (resultatOAT.timing) {
      resultatOAT.timing.malId = malId; // carried through to enregistrerSkip/envoyerDonneesAutoSkip
      console.log(`[SkipSensei] Source: Open Anime Timestamps — timing trouvé pour "${nomSerieBase}" saison ${saison} ${suffixeEpisode}.`);
      return resultatOAT;
    }
    console.log(
      `[SkipSensei] Source: Open Anime Timestamps — rien pour "${nomSerieBase}" saison ${saison} ${suffixeEpisode} ` +
        `(${resultatOAT.definitif ? "aucune donnée" : "échec temporaire"}).`
    );
    console.log(`[SkipSensei] Aucune source automatique — repli sur le marquage manuel pour "${nomSerieBase}" saison ${saison} ${suffixeEpisode}.`);

    return {
      timing: null,
      definitif: resultatAniSkip.definitif && resultatOAT.definitif,
    };
  }

  /**
   * Resolves the timing for (nomSerie, episode) — preferring, in order:
   * 1) a manual entry already saved for this exact episode in
   *    chrome.storage.local (never overwritten automatically — it's a
   *    permanent user override, and the only kind of entry we persist),
   * 2) an AniSkip result already resolved earlier this page session
   *    (in-memory only — never written to chrome.storage.local, since
   *    that data already lives in AniSkip's own database),
   * 3) a fresh AniSkip lookup (kept in memory on success, not saved),
   * and finally falls back to the manual-marking UI when none of the
   * above produced usable data.
   */
  async function resoudreEtAfficher(iframe, nomSerie, nomSerieBase, saison, episode, obtenirUrlRacine) {
    const cle = cleTiming(nomSerie, episode);

    const cache = await storageGet([cle]);
    const manuel = cache[cle];
    if (manuel && manuel.source === "manual" && typeof manuel.fin === "number") {
      return manuel;
    }

    let timing = cacheTimingAutoEnMemoire.get(cle) || null;

    if (!timing && episode != null && tentativeEncoreValide(cle)) {
      const episodeLength = await obtenirDureeVideo(iframe);
      const resultat = await resoudreTimingAuto(nomSerieBase, saison, episode, episodeLength, obtenirUrlRacine);
      timing = resultat.timing;
      tentativesEffectuees.set(cle, { dernierEssai: Date.now(), definitif: resultat.definitif });
      if (timing) cacheTimingAutoEnMemoire.set(cle, timing);
    }

    return timing && typeof timing.fin === "number" ? timing : null;
  }

  /**
   * Saves a manually-marked intro end time for (nomSerie, episode) — same
   * shape/semantics as before (see resoudreEtAfficher's "manual" branch):
   * a permanent override, `debut` preserved from any prior manual entry
   * (defaults to 0 the first time). Called from the "mark-intro-end"
   * message below, sent by player-frame.js's own button (moved there —
   * see the architectural note on that button's message handlers further
   * down) instead of a click handler content.js used to own directly.
   */
  async function enregistrerTimingManuel(nomSerie, episode, time) {
    if (!contexteValide()) {
      avertirContexteInvalide();
      alert("L'extension a été mise à jour. Rafraîchis cette page (F5) pour continuer à l'utiliser.");
      return;
    }

    const cle = cleTiming(nomSerie, episode);
    try {
      const cache = await storageGet([cle]);
      const ancienTiming = cache[cle] || { debut: 0 };

      const nouveauTiming = {
        debut: ancienTiming.debut ?? 0,
        fin: time,
        source: "manual",
      };

      await storageSet({ [cle]: nouveauTiming });
      console.log(`[SkipSensei] Timing enregistré pour "${nomSerie}" (ép. ${episode}) :`, nouveauTiming);
      timingActuel = nouveauTiming;
      // No explicit re-render call needed: this storageSet triggers the
      // chrome.storage.onChanged listener at the bottom of this file
      // (matching cleTiming(serieActuelle, episodeActuel)), which re-runs
      // verifierPageEtMettreAJourUI and pushes the updated timing to
      // player-frame.js via the normal envoyerDonneesAutoSkip poll tick —
      // same path a popup-side edit already used.
    } catch (erreur) {
      // contexteValide() was true a few lines up but the extension could
      // have been reloaded in the meantime (message → await → reload
      // race); storageGet/storageSet already logged the clear message via
      // avertirContexteInvalide() in that case.
      if (contexteValide()) console.error("[SkipSensei] Échec de l'enregistrement du timing :", erreur);
    }
  }

  /**
   * Envoie un message à l'iframe du lecteur et attend sa réponse.
   * C'est nécessaire car la vraie balise <video> vit dans l'iframe,
   * pas sur cette page. On utilise window.postMessage car c'est le
   * seul moyen autorisé de communiquer entre deux frames de domaines
   * différents (sécurité du navigateur oblige).
   *
   * @param {HTMLIFrameElement} iframe
   * @param {object} message - doit contenir { canal: CANAL, type: ... }
   * @param {string} typeReponseAttendu - le "type" du message de réponse
   * @returns {Promise<object>} le message de réponse reçu de l'iframe
   */
  function envoyerMessageAuLecteur(iframe, message, typeReponseAttendu) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        window.removeEventListener("message", ecouteur);
        reject(new Error("Pas de réponse du lecteur vidéo (délai dépassé)."));
      }, DELAI_REPONSE_IFRAME_MS);

      function ecouteur(event) {
        const donnees = event.data;
        if (!donnees || donnees.canal !== CANAL || donnees.type !== typeReponseAttendu) {
          return; // pas un message qui nous concerne
        }
        clearTimeout(timeoutId);
        window.removeEventListener("message", ecouteur);
        resolve(donnees);
      }

      window.addEventListener("message", ecouteur);

      // On envoie le message à l'iframe. "*" comme origine cible car le
      // domaine du lecteur change selon le site tiers utilisé (vidmoly,
      // sibnet, sendvid...) — le message ne contient aucune donnée
      // sensible (juste un timestamp), donc ce n'est pas un problème.
      iframe.contentWindow.postMessage({ canal: CANAL, ...message }, "*");
    });
  }

  /**
   * Real duration (seconds) of the video currently loaded in the player
   * iframe, for the AniSkip request's `episodeLength` param — see
   * resoudreTimingAniSkip for why this matters. Falls back to 0 ("unknown"
   * to AniSkip) if the iframe doesn't answer in time or the video's
   * metadata hasn't loaded yet (video.duration is NaN at that point):
   * failing to get a real duration should degrade the request, not block
   * auto-detection entirely.
   */
  async function obtenirDureeVideo(iframe) {
    try {
      const reponse = await envoyerMessageAuLecteur(iframe, { type: "get-duration" }, "duration");
      return Number.isFinite(reponse.duration) && reponse.duration > 0 ? reponse.duration : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Sends the current skip window + the user's auto-skip preference to
   * the player iframe (new). player-frame.js keeps watching video
   * playback and seeks past the intro on its own when enabled. Sent on
   * every polling tick (including when unchanged) so a setting toggled
   * from the popup is picked up within one interval.
   */
  function envoyerDonneesAutoSkip(iframe, nomSerie, episode, timing, autoSkipEnabled) {
    iframe.contentWindow.postMessage(
      {
        canal: CANAL,
        type: "set-skip-data",
        serie: nomSerie,
        episode,
        debut: timing?.debut ?? null,
        fin: timing?.fin ?? null,
        malId: timing?.malId ?? null,
        autoSkipEnabled: !!autoSkipEnabled,
        // New: so player-frame.js can tag its own auto-skip history/stats
        // entries with the site, the same way enregistrerSkip already does
        // for manual clicks — see enregistrerActiviteEtRecords.
        site: obtenirAdaptateur().nomSite || null,
      },
      "*"
    );
  }

  // ------------------------------------------------------------
  // Floating button bridge (new — architectural change). The Netflix-style
  // floating button is now rendered by player-frame.js INSIDE the player
  // iframe's own document, not by this script on the parent page: a
  // button appended to document.body here physically cannot appear "over"
  // the video once that video's cross-origin iframe goes fullscreen (only
  // the fullscreen element's own subtree renders), and Netflix-style
  // positioning relative to the video needs the video's own layout anyway.
  // content.js still owns resolving the timing (via envoyerDonneesAutoSkip
  // above) and recording "clic" skips/manual marks (enregistrerSkip /
  // enregistrerTimingManuel) — the button in the iframe just reports the
  // user's action back here for that bookkeeping, via this listener.
  // ------------------------------------------------------------
  window.addEventListener("message", (event) => {
    const donnees = event.data;
    if (!donnees || donnees.canal !== CANAL) return;

    if (donnees.type === "skip-performed") {
      enregistrerSkip(
        serieActuelle,
        episodeActuel,
        donnees.secondesGagnees,
        "clic",
        timingActuel?.malId,
        obtenirAdaptateur().nomSite || null
      );
      return;
    }

    if (donnees.type === "mark-intro-end") {
      enregistrerTimingManuel(serieActuelle, episodeActuel, donnees.time);
      return;
    }
  });

  // ------------------------------------------------------------
  // Popup <-> content script bridge (new). This is a completely
  // different channel from the postMessage one above (which talks to
  // the cross-origin player iframe): chrome.runtime.onMessage is how
  // popup.js, running in the extension popup, asks this script for
  // its current state (serieActuelle/episodeActuel/timingActuel are
  // otherwise only kept in memory here, never in chrome.storage).
  // ------------------------------------------------------------
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "asi-get-state") return; // not for us

    const adaptateur = obtenirAdaptateur();
    const reponseBase = {
      serie: serieActuelle,
      serieBase: nomSerieBaseActuelle,
      saison: saisonActuelle,
      episode: episodeActuel,
      timing: timingActuel,
      site: adaptateur.nomSite || null,
      // New: real signal when the site exposes one (voiranime.rip's own
      // VF/VOSTFR query param) — null, never a guess, when it doesn't.
      langue: adaptateur.extraireLangue ? adaptateur.extraireLangue() : null,
    };

    const timingResolu =
      timingActuel && typeof timingActuel.debut === "number" && typeof timingActuel.fin === "number";
    const iframe = timingResolu ? trouverIframeLecteur() : null;

    if (!iframe) {
      // Nothing to skip yet (or no timing resolved): answer synchronously,
      // same as before this change — no added latency for the common case.
      sendResponse({ ...reponseBase, enCoursDeSkip: false });
      return;
    }

    // New: best-effort live "Skipping…" state for the popup's Dashboard,
    // asking the player iframe for its actual current playback position —
    // same request player-frame.js already answers for obtenirDureeVideo's
    // sibling ("get-duration"), just never called from here until now.
    // A slow/absent answer just means we can't tell (falls back to "not
    // skipping" rather than blocking the popup on iframe latency).
    envoyerMessageAuLecteur(iframe, { type: "get-current-time" }, "current-time")
      .then((reponseIframe) => {
        const t = reponseIframe.time;
        const enCoursDeSkip = Number.isFinite(t) && t >= timingActuel.debut && t < timingActuel.fin;
        sendResponse({ ...reponseBase, enCoursDeSkip });
      })
      .catch(() => {
        sendResponse({ ...reponseBase, enCoursDeSkip: false });
      });

    return true; // keep the message channel open for the async sendResponse above
  });

  /**
   * verifierPageEtMettreAJourUI is async; calling it without awaiting
   * (required here — setInterval can't await) leaves a rejected promise
   * unhandled if it throws, which is exactly what error 3 looked like
   * in the console. contexteValide() already logs a clear message for
   * the "extension reloaded" case via storageGet/storageSet; anything
   * else still gets logged instead of silently vanishing.
   */
  function lancerVerification() {
    verifierPageEtMettreAJourUI().catch((erreur) => {
      if (!contexteValide()) return; // already warned
      console.error("[SkipSensei] Erreur inattendue dans verifierPageEtMettreAJourUI :", erreur);
    });
  }

  // Kicked off last, on purpose: this is the only thing in the module
  // that actually runs code synchronously (everything above this line
  // is just declarations). Starting it before every const/function it
  // transitively depends on (ADAPTATEURS_SITE in particular) has been
  // declared caused a "Cannot access before initialization" crash on
  // page loads where the player iframe was already present at
  // document_idle — see obtenirAdaptateur().
  setInterval(lancerVerification, INTERVALLE_VERIFICATION_MS);
  lancerVerification();

  // ------------------------------------------------------------
  // Faster detection (new). The poll above is now just a safety net —
  // most changes are caught immediately by:
  // - a capturing "change" listener: anime-sama.to's episode <select>
  //   (see extraireEpisodeAnimeSama) fires a native "change" event the
  //   instant the user picks a new episode, but never touches the DOM
  //   tree, so a MutationObserver alone would never see it.
  // - a debounced MutationObserver: catches the player <iframe> being
  //   inserted/swapped, whether that's an SPA navigation on
  //   anime-sama.to or the initial page load on voiranime.rip. Debounced
  //   because streaming sites tend to have ad scripts churning the DOM
  //   continuously; running the full check on every single mutation
  //   would be wasteful.
  // ------------------------------------------------------------
  let minuteurDebounceMutation = null;
  function surMutationDom() {
    clearTimeout(minuteurDebounceMutation);
    minuteurDebounceMutation = setTimeout(lancerVerification, 200);
  }

  document.addEventListener("change", lancerVerification, true);

  new MutationObserver(surMutationDom).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // ------------------------------------------------------------
  // Keyboard shortcuts (new): S / M / A, see RACCOURCIS_CLAVIER at the
  // top of this file. Deliberately reuse the exact same code paths as
  // their on-page/popup equivalents instead of duplicating the logic:
  // - S/M ask player-frame.js to run the exact same click handler its own
  //   floating button uses (the button now lives inside the player
  //   iframe — see the architectural note near envoyerDonneesAutoSkip —
  //   so triggering it from here means posting a message, not calling
  //   .click() on a local element).
  // - A writes STORAGE_KEY_SETTINGS the same way the popup's toggle does,
  //   so every surface (popup, player-frame.js auto-skip loop) picks up
  //   the change exactly as if the popup toggle had been clicked.
  // ------------------------------------------------------------
  function cibleEstEditable(cible) {
    if (!cible) return false;
    const tag = cible.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || cible.isContentEditable === true;
  }

  async function basculerAutoSkipDepuisRaccourci() {
    const parametres = await storageGet([STORAGE_KEY_SETTINGS]);
    const actif = parametres[STORAGE_KEY_SETTINGS]?.autoSkipEnabled ?? true;
    await storageSet({ [STORAGE_KEY_SETTINGS]: { autoSkipEnabled: !actif } });
  }

  function gestionnaireClavier(event) {
    // Only active while a supported site's player iframe is actually on
    // screen — trouverIframeLecteur() returning null means there's
    // nothing to act on.
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (cibleEstEditable(event.target)) return;

    const iframe = trouverIframeLecteur();
    if (!iframe) return;

    const action = RACCOURCIS_CLAVIER[event.key?.toLowerCase()];
    if (!action) return;

    const timingResolu = timingActuel && typeof timingActuel.fin === "number";

    if (action === "skip-intro") {
      if (timingResolu) iframe.contentWindow.postMessage({ canal: CANAL, type: "trigger-skip" }, "*");
    } else if (action === "marquer-fin") {
      if (!timingResolu) iframe.contentWindow.postMessage({ canal: CANAL, type: "trigger-mark" }, "*");
    } else if (action === "toggle-auto-skip") {
      basculerAutoSkipDepuisRaccourci();
    }
  }

  document.addEventListener("keydown", gestionnaireClavier);

  // ------------------------------------------------------------
  // React immediately when the saved timing for the episode currently
  // on screen is deleted or edited from the popup's "Timings enregistrés"
  // list (new — see popup.js initSavedTimingsList). Without this, a
  // manual entry removed from the popup would keep being used here until
  // a full page reload: timingActuel/cacheTimingAutoEnMemoire/
  // tentativesEffectuees are all in-memory and nothing previously told
  // this script that chrome.storage had changed out from under it.
  // ------------------------------------------------------------
  chrome.storage.onChanged.addListener((changements, zone) => {
    if (zone !== "local") return;
    const cle = cleTiming(serieActuelle, episodeActuel);
    if (!(cle in changements)) return;

    cacheTimingAutoEnMemoire.delete(cle);
    tentativesEffectuees.delete(cle);
    timingActuel = null;
    lancerVerification();
  });
}
