// Runs on the anime site's main page (not inside the cross-origin player
// iframe — vidmoly.biz, video.sibnet.ru, sendvid.com, etc). Communicates
// with player-frame.js (which runs inside that iframe) via postMessage,
// since a cross-origin iframe's <video> isn't directly accessible here.

if (window.__animeSkipIntroInjected) {
  console.log("[SkipSensei] Script déjà présent, on ne relance pas.");
} else {
  window.__animeSkipIntroInjected = true;

  const CANAL = "anime-skip-intro";

  const RACCOURCIS_CLAVIER = {
    s: "skip-intro",
    m: "marquer-fin",
    a: "toggle-auto-skip",
  };

  // Safety-net poll; most changes are caught immediately by the
  // "change"/MutationObserver listeners further down.
  const INTERVALLE_VERIFICATION_MS = 3000;
  const DELAI_REPONSE_IFRAME_MS = 1500;

  // Known third-party player domains (see manifest.json's second
  // content_scripts entry) — preferred over the first iframe found on the
  // page, which could be an ad.
  const DOMAINES_LECTEUR_CONNUS = [
    "vidmoly",
    "sibnet",
    "sendvid",
    "ansembed",
    "smoothpre",
    "oneupload",
    "embed4me",
    "movearnpre",
    "uqload",
    "minochinos",
    "myvi",
    "vk.com",
    "vkvideo",
  ];

  // ANISKIP_CACHE_TTL_MS, FETCH_TIMEOUT_MS, JIKAN_SEARCH_URL, ANILIST_GRAPHQL_URL
  // and OVERRIDES_MALID live in resolution.js (shared global scope, loaded
  // before this file — see that file's header).
  const ANISKIP_BASE_URL = "https://api.aniskip.com/v2/skip-times";

  // Open Anime Timestamps: second auto-detection source, tried after
  // AniSkip. Static JSON dataset on GitHub keyed by AniDB id
  // (relations.yuna.moe converts our MAL id to AniDB). Only records the
  // opening's start, not its end, so the end is approximated with
  // OAT_DUREE_OP_DEFAUT_S — less precise than AniSkip, hence tried second.
  const RELATIONS_YUNA_URL = "https://relations.yuna.moe/api/ids";
  const OPEN_ANIME_TIMESTAMPS_URL =
    "https://raw.githubusercontent.com/jonbarrow/open-anime-timestamps/master/timestamps.json";
  const OAT_DUREE_OP_DEFAUT_S = 90; // typical anime OP length
  const STORAGE_KEY_OAT_CACHE = "asi-oat-cache"; // ~2MB dataset, cached instead of refetched every episode

  const STORAGE_PREFIX_TIMING = "asi-timing::"; // per series+episode
  // STORAGE_PREFIX_MALID, STORAGE_PREFIX_SEQUEL_MALID and
  // STORAGE_PREFIX_SAISONS live in resolution.js.
  const STORAGE_KEY_SETTINGS = "asi-settings";
  // Shared with player-frame.js — keep in sync if renamed there.
  const STORAGE_KEY_STATS = "asi-stats"; // { "YYYY-MM": { skips, secondesGagnees } }
  const STORAGE_KEY_HISTORY = "asi-history"; // [{ serie, episode, secondes, declencheur, horodatage, malId, site }, ...]
  const HISTORIQUE_TAILLE_MAX = 20;
  const STORAGE_KEY_ACTIVITY = "asi-activity"; // { "YYYY-MM-DD": { skips, secondesGagnees } }
  const STORAGE_KEY_FAVORIS_SERIES = "asi-fav-series"; // { [serie]: skipCount }
  const STORAGE_KEY_FAVORIS_SITES = "asi-fav-sites"; // { [site]: skipCount }
  const STORAGE_KEY_RECORD = "asi-record"; // { secondes, serie, episode, horodatage } — longest single skip ever

  const STORAGE_PREFIX_ANIDBID = "asi-anidbid::"; // per MAL id -> AniDB id
  const STORAGE_PREFIX_POSTER = "asi-poster::"; // per MAL id -> { url, cachedAt }
  // A failed Jikan poster lookup is retried after this TTL rather than
  // cached as a permanent null; a successful lookup has no TTL.
  const POSTER_ECHEC_TTL_MS = 24 * 60 * 60 * 1000; // 24h

  // Tracks AniSkip attempts per (série, épisode) so the poll loop doesn't
  // hammer the API. `definitif: true` means AniSkip confirmed no data
  // (404 / found: false) — no point retrying this session. `definitif:
  // false` means the attempt itself failed (network/timeout/5xx) and is
  // retried after COOLDOWN_APRES_ECHEC_MS.
  const COOLDOWN_APRES_ECHEC_MS = 60 * 1000;
  const tentativesEffectuees = new Map(); // cle -> { dernierEssai, definitif }

  function tentativeEncoreValide(cle) {
    const entree = tentativesEffectuees.get(cle);
    if (!entree) return true;
    if (entree.definitif) return false;
    return Date.now() - entree.dernierEssai > COOLDOWN_APRES_ECHEC_MS;
  }

  // Auto-detected results are kept in memory only — AniSkip/OAT already
  // persist that data, so only manual overrides go to chrome.storage.local.
  const cacheTimingAutoEnMemoire = new Map();

  // Fetched at most once per page session; also persisted to
  // chrome.storage.local across page loads (see obtenirDatasetOpenAnimeTimestamps).
  let datasetOpenAnimeTimestampsEnMemoire = null;

  let serieActuelle = null;
  let nomSerieBaseActuelle = null;
  let saisonActuelle = null;
  let episodeActuel = null;
  let timingActuel = null;

  // contexteValide, avertirContexteInvalide, storageGet and storageSet
  // live in resolution.js (shared global scope).

  function cleMoisActuel() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  function cleJourActuel() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // Powers Stats beyond the month-bucketed totals: daily activity
  // (streaks, 7-day chart), favorite series/site, and the all-time
  // longest single skip. Called alongside the STATS/HISTORY writes in
  // enregistrerSkip (here) and enregistrerSkipAutomatique (player-frame.js).
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

  // Records one real skip: this month's counter + a new HISTORY entry
  // (capped to HISTORIQUE_TAILLE_MAX). Called here on a "Skip Intro"
  // click (declencheur "clic"), and from player-frame.js when auto-skip
  // fires (declencheur "auto").
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

    // Fire-and-forget: a slow/failed Jikan lookup must not delay the skip
    // recording above.
    assurerPosterEnCache(malId);
  }

  // Looks up + caches a poster image URL for a MAL id, for the popup's
  // "Recently Skipped" thumbnails. A successful lookup is cached forever;
  // a failed one only for POSTER_ECHEC_TTL_MS so a transient rate-limit
  // doesn't permanently blank the poster. Never awaited by its caller.
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
      // Purely cosmetic failure; storageGet/storageSet already warn via
      // avertirContexteInvalide() if the extension was reloaded mid-flight.
    }
  }

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
    // Qualify the identity by season (beyond the 1st): cleTiming, the
    // memory cache and the history must distinguish "Saison 2 Ép. 5" from
    // "Saison 1 Ép. 5".
    const nomSerie = saison > 1 ? `${nomSerieBase} (saison ${saison})` : nomSerieBase;
    const memeContexte = nomSerie === serieActuelle && episode === episodeActuel;
    nomSerieBaseActuelle = nomSerieBase;
    saisonActuelle = saison;

    // Re-resolve when the episode changed, or when still stuck on the
    // manual fallback and a retry is due (so a recovered AniSkip is
    // picked up mid-session).
    const doitReessayer = !timingActuel && tentativeEncoreValide(cleTiming(nomSerie, episode));

    if (!memeContexte || doitReessayer) {
      serieActuelle = nomSerie;
      episodeActuel = episode;
      timingActuel = await resoudreEtAfficher(iframe, nomSerie, nomSerieBase, saison, episode, obtenirUrlRacine);
    }

    // Always re-push the current timing + auto-skip setting, even when
    // nothing changed, so a setting toggled from the popup takes effect
    // within one polling interval.
    const parametres = await storageGet([STORAGE_KEY_SETTINGS]);
    const autoSkipEnabled = parametres[STORAGE_KEY_SETTINGS]?.autoSkipEnabled ?? true;
    envoyerDonneesAutoSkip(iframe, nomSerie, episode, timingActuel, autoSkipEnabled);
  }

  // Per-site adapters: each site has its own page structure, so
  // extracting the series name + episode is the only site-specific part
  // of this script. Keyed by location.hostname; manifest.json's
  // content_script "matches" controls which hosts this script runs on.

  // anime-sama.to: the episode number lives in neither document.title nor
  // the URL (single-page app; switching episodes via
  // <select id="selectEpisodes"> changes neither). That select's selected
  // option (e.g. "Episode 5") is the only reliable source. Title looks
  // like: "One Piece - Saga 1 (East Blue) | Anime-Sama - ...".
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

  // voiranime.rip: traditional multi-page site, one full page load per
  // episode. Title/URL example:
  // title = "One Piece Saison 1 Épisode 8 en streaming VF et VOSTFR | Voiranime"
  // url   = "https://voiranime.rip/one-piece/saison-1/episode-8/?lang=vostfr"
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

  // voiranime.rip resets its episode numbering at 1 for every season,
  // while MAL/AniSkip's episode numbers for a single-MAL-entry franchise
  // are absolute — see resoudreMalIdEtEpisode for why the season matters.
  function extraireSaisonVoiranime() {
    const correspondanceTitre = document.title.match(/Saison\s+(\d+)/i);
    if (correspondanceTitre) return parseInt(correspondanceTitre[1], 10);

    const correspondanceUrl = location.pathname.match(/saison-(\d+)/i);
    if (correspondanceUrl) return parseInt(correspondanceUrl[1], 10);

    return 1; // pas de "Saison" détectée : une seule saison
  }

  // The anime's own root page (e.g. ".../one-piece/" from
  // ".../one-piece/saison-7/episode-3/"), used by
  // scraperComptesEpisodesParSaison to read per-season episode counts.
  function extraireUrlRacineVoiranime() {
    const segments = location.pathname.split("/").filter(Boolean);
    return segments.length > 0 ? `${location.origin}/${segments[0]}/` : null;
  }

  // VF/VOSTFR, read from the site's own "?lang=vostfr" query param. Null
  // (not a placeholder) when absent, so the popup can omit the language
  // row entirely.
  function extraireLangueVoiranime() {
    const lang = new URLSearchParams(location.search).get("lang");
    return lang ? lang.toUpperCase() : null;
  }

  // Last-resort fallback shared by every adapter: look for
  // "episode 12" / "épisode 12" / "ep 12" in the title or URL.
  function extraireEpisodeParRegexGenerique() {
    const source = `${document.title} ${location.href}`;
    const correspondance = source.match(/(?:episode|épisode|ep)\s*\.?\s*(\d+)/i);
    return correspondance ? parseInt(correspondance[1], 10) : null;
  }

  const ADAPTATEURS_SITE = {
    "anime-sama.to": {
      nomSite: "Anime-Sama",
      extraireNomSerie: extraireNomSerieAnimeSama,
      extraireEpisode: extraireEpisodeAnimeSama,
      extraireSaison: () => 1, // pas de notion de "Saison" distincte sur ce site
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

  function obtenirAdaptateur() {
    return ADAPTATEURS_SITE[location.hostname] || ADAPTATEURS_SITE["anime-sama.to"];
  }

  // anime-sama.to gives the player iframe id "playerDF"; otherwise prefer
  // a known player domain (DOMAINES_LECTEUR_CONNUS) over the first iframe
  // on the page, which on an ad-supported site could be an ad slot.
  function trouverIframeLecteur() {
    const parId = document.querySelector("iframe#playerDF");
    if (parId) return parId;

    const iframes = Array.from(document.querySelectorAll("iframe"));
    const connu = iframes.find((f) => DOMAINES_LECTEUR_CONNUS.some((d) => (f.src || "").includes(d)));
    if (connu) return connu;

    return iframes[0] || null;
  }

  function cleTiming(nomSerie, episode) {
    return `${STORAGE_PREFIX_TIMING}${nomSerie}::${episode ?? "?"}`;
  }

  // normaliserTitre, genererVariantesRecherche, fetchAvecTimeout,
  // choisirMeilleureCorrespondance, resoudreMalIdViaJikan,
  // resoudreMalIdViaAniList, verifierCoherenceMalId, resoudreMalId,
  // resoudreSequelMalId, scraperComptesEpisodesParSaison,
  // obtenirComptesEpisodesParSaison and resoudreMalIdEtEpisode live in
  // resolution.js (shared global scope).

  // AniSkip lookup for a MAL id + episode — first source tried in the
  // auto-detection cascade. Returns { timing, definitif }: `timing` is
  // null when AniSkip has nothing usable; `definitif` says whether that's
  // a confirmed answer (true) or the attempt itself failed and should be
  // retried later (false).
  //
  // `episodeLength` (seconds, or 0 if unknown) is required by AniSkip's
  // API to rescale stored timestamps to this release's runtime — passing
  // a placeholder 0 has been observed to 500 on entries that need it.
  async function resoudreTimingAniSkip(malId, episode, episodeLength) {
    try {
      const url = `${ANISKIP_BASE_URL}/${malId}/${episode}?types=op&types=ed&episodeLength=${episodeLength.toFixed(3)}`;
      const reponse = await fetchAvecTimeout(url);

      if (reponse.status === 404) {
        return { timing: null, definitif: true }; // AniSkip confirmed: no data for this episode
      }
      if (!reponse.ok) {
        console.warn(`[SkipSensei] AniSkip returned ${reponse.status} for MAL id ${malId} ép. ${episode}.`);
        return { timing: null, definitif: false }; // likely transient (e.g. AniSkip 5xx outage)
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

      // NOTE: results also carry their own r.episodeLength; in principle a
      // mismatch against the real episodeLength sent above means
      // startTime/endTime should be shifted. A client-side correction
      // along those lines caused wrong/near-zero auto-skip timestamps and
      // was reverted — using the raw values until this can be verified
      // against real (non-minified) AniSkip source.
      return {
        timing: {
          debut: opening.interval.startTime,
          fin: opening.interval.endTime,
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

  // Converts a MAL id to an AniDB id via relations.yuna.moe, cached 7 days.
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

  // Fetches the Open Anime Timestamps dataset once per page session,
  // cached in chrome.storage.local for ANISKIP_CACHE_TTL_MS (static file,
  // no need to redownload ~2MB every episode).
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

  // Open Anime Timestamps lookup — second source, only reached when
  // AniSkip has nothing. Same { timing, definitif } contract. This
  // dataset only records the opening's start, so `fin` is an estimate
  // (start + OAT_DUREE_OP_DEFAUT_S).
  async function resoudreTimingOpenAnimeTimestamps(malId, episode) {
    const aniDbId = await resoudreAniDbId(malId);
    if (aniDbId == null) {
      return { timing: null, definitif: false }; // treat as retryable, not a confirmed dead end
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

  // Runs the auto-detection cascade: AniSkip first, Open Anime Timestamps
  // second, stopping at the first source that returns a timing.
  // `definitif` is true only when every attempted source gave a confirmed
  // "no data" answer.
  async function resoudreTimingAuto(nomSerieBase, saison, episodeSite, episodeLength, obtenirUrlRacine) {
    // "serie-inconnue" is extraireNomSerieAnimeSama()'s fallback when the
    // title is empty (page still loading) — retryable, not a confirmed
    // dead end.
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

  // Resolves the timing for (nomSerie, episode), preferring in order:
  // 1) a saved manual override, 2) an AniSkip/OAT result already resolved
  // this page session (memory only), 3) a fresh auto-detection lookup —
  // falling back to the manual-marking UI when none apply.
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

  // Saves a manually-marked intro end time — a permanent override.
  // Called from the "mark-intro-end" message below, sent by
  // player-frame.js's own button.
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
      // No explicit re-render needed: this storageSet triggers the
      // chrome.storage.onChanged listener further down, which re-runs
      // verifierPageEtMettreAJourUI.
    } catch (erreur) {
      if (contexteValide()) console.error("[SkipSensei] Échec de l'enregistrement du timing :", erreur);
    }
  }

  /**
   * Envoie un message à l'iframe du lecteur et attend sa réponse, via
   * window.postMessage (seul moyen de communiquer entre deux frames de
   * domaines différents).
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

      // "*" comme origine cible car le domaine du lecteur change selon le
      // site tiers utilisé ; aucune donnée sensible dans ce message.
      iframe.contentWindow.postMessage({ canal: CANAL, ...message }, "*");
    });
  }

  // Real duration of the video in the player iframe, for AniSkip's
  // episodeLength param. Falls back to 0 if the iframe doesn't answer in
  // time or metadata hasn't loaded yet.
  async function obtenirDureeVideo(iframe) {
    try {
      const reponse = await envoyerMessageAuLecteur(iframe, { type: "get-duration" }, "duration");
      return Number.isFinite(reponse.duration) && reponse.duration > 0 ? reponse.duration : 0;
    } catch {
      return 0;
    }
  }

  // Sends the current skip window + auto-skip preference to the player
  // iframe on every polling tick, so a popup-toggled setting is picked up
  // within one interval.
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
        site: obtenirAdaptateur().nomSite || null,
      },
      "*"
    );
  }

  // Floating button bridge: the Netflix-style button is rendered by
  // player-frame.js inside the player iframe's own document (a button on
  // the parent page can't appear "over" the video once the cross-origin
  // iframe goes fullscreen). content.js still owns resolving the timing
  // and recording skips/manual marks — the button just reports the user's
  // action back here.
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

  // Popup <-> content script bridge (chrome.runtime.onMessage, distinct
  // from the postMessage channel above): lets popup.js ask for this
  // script's in-memory state.
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
      langue: adaptateur.extraireLangue ? adaptateur.extraireLangue() : null,
    };

    const timingResolu =
      timingActuel && typeof timingActuel.debut === "number" && typeof timingActuel.fin === "number";
    const iframe = timingResolu ? trouverIframeLecteur() : null;

    if (!iframe) {
      sendResponse({ ...reponseBase, enCoursDeSkip: false });
      return;
    }

    // Best-effort live "Skipping…" state for the popup, asking the player
    // iframe for its actual playback position.
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

  function lancerVerification() {
    verifierPageEtMettreAJourUI().catch((erreur) => {
      if (!contexteValide()) return; // already warned
      console.error("[SkipSensei] Erreur inattendue dans verifierPageEtMettreAJourUI :", erreur);
    });
  }

  // Started last, on purpose: everything above is just declarations —
  // starting the interval before ADAPTATEURS_SITE is declared crashes
  // with "Cannot access before initialization" on pages where the player
  // iframe is already present at document_idle.
  setInterval(lancerVerification, INTERVALLE_VERIFICATION_MS);
  lancerVerification();

  // Faster detection: the poll above is now just a safety net.
  // - capturing "change" listener: anime-sama.to's episode <select> fires
  //   a native "change" event without touching the DOM tree, so a
  //   MutationObserver alone wouldn't see it.
  // - debounced MutationObserver: catches the player <iframe> being
  //   inserted/swapped (SPA nav on anime-sama.to, initial load on
  //   voiranime.rip). Debounced since ad scripts tend to churn the DOM.
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

  // Keyboard shortcuts: S / M / A (see RACCOURCIS_CLAVIER above). Reuse
  // the same code paths as their on-page/popup equivalents instead of
  // duplicating logic — S/M message player-frame.js's own button handler,
  // A writes STORAGE_KEY_SETTINGS the same way the popup's toggle does.
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

  // React immediately when the saved timing for the episode on screen is
  // deleted/edited from the popup's "Timings enregistrés" list — otherwise
  // the in-memory state here wouldn't notice until a full page reload.
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
