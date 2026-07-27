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
   - essayer de résoudre automatiquement les timings d'intro/ending
     via AniSkip (Jikan/AniList pour trouver l'ID MyAnimeList, puis
     AniSkip pour les timestamps), avec repli sur le marquage manuel
   - afficher/gérer le panneau flottant
   - communiquer avec player-frame.js (qui tourne DANS l'iframe)
     via window.postMessage, puisqu'on ne peut pas accéder
     directement au <video> d'un domaine différent.
   ============================================================ */

if (window.__animeSkipIntroInjected) {
  console.log("[Anime Skip Intro] Script déjà présent, on ne relance pas.");
} else {
  window.__animeSkipIntroInjected = true;

  // Préfixe utilisé pour reconnaître nos propres messages postMessage
  // (et ignorer tous les autres messages qui pourraient circuler sur la page).
  const CANAL = "anime-skip-intro";

  const INTERVALLE_VERIFICATION_MS = 2000;
  const DELAI_REPONSE_IFRAME_MS = 1500;

  // ------------------------------------------------------------
  // AniSkip integration (new).
  // English comments below, as requested, for this new logic.
  // ------------------------------------------------------------
  const ANISKIP_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const FETCH_TIMEOUT_MS = 8000;
  const JIKAN_SEARCH_URL = "https://api.jikan.moe/v4/anime";
  const ANISKIP_BASE_URL = "https://api.aniskip.com/v2/skip-times";
  const ANILIST_GRAPHQL_URL = "https://graphql.anilist.co"; // fallback when Jikan search is down

  const STORAGE_PREFIX_TIMING = "asi-timing::"; // per series+episode
  const STORAGE_PREFIX_MALID = "asi-malid::"; // per series (shared across episodes)
  const STORAGE_KEY_SETTINGS = "asi-settings";

  // Keys already attempted against AniSkip during this page load. Prevents
  // hammering the API every polling tick when a lookup fails or the show
  // isn't found — we only try once per key per page load; a full reload
  // (or the 7-day cache expiring) allows a fresh attempt.
  const tentativesEffectuees = new Set();

  // AniSkip results are resolved fresh and kept only in memory (new) — we
  // no longer persist them to chrome.storage.local. The site already has
  // that data, so there's no point duplicating it on disk; only manual
  // overrides (which AniSkip doesn't have) get saved. This also keeps the
  // popup's "séries enregistrées" list limited to entries the user
  // actually marked themselves.
  const cacheAniSkipEnMemoire = new Map();

  let boutonActuel = null;
  let toggleAutoSkipElement = null;
  let serieActuelle = null;
  let episodeActuel = null;
  let timingActuel = null;

  setInterval(verifierPageEtMettreAJourUI, INTERVALLE_VERIFICATION_MS);
  verifierPageEtMettreAJourUI();

  // ------------------------------------------------------------
  // Promise wrappers around chrome.storage.local (new). The original
  // code used the callback style directly; async/await reads better
  // for the AniSkip resolution flow below.
  // ------------------------------------------------------------
  function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }
  function storageSet(items) {
    return new Promise((resolve) => chrome.storage.local.set(items, resolve));
  }

  /**
   * Vérifie si l'iframe du lecteur est présente sur la page, extrait
   * le nom de la série + l'épisode, résout le timing (AniSkip ou
   * manuel) et met à jour le bouton + l'iframe.
   */
  async function verifierPageEtMettreAJourUI() {
    // anime-sama.to donne l'id "playerDF" à l'iframe du lecteur.
    const iframe = document.querySelector("iframe#playerDF") || document.querySelector("iframe");

    if (!iframe) {
      retirerBouton();
      serieActuelle = null;
      episodeActuel = null;
      timingActuel = null;
      return;
    }

    const adaptateur = obtenirAdaptateur();
    const nomSerie = adaptateur.extraireNomSerie();
    const episode = adaptateur.extraireEpisode();
    const contexteInchange = nomSerie === serieActuelle && episode === episodeActuel && boutonActuel;

    if (!contexteInchange) {
      serieActuelle = nomSerie;
      episodeActuel = episode;
      timingActuel = await resoudreEtAfficher(iframe, nomSerie, episode);
    }

    // Always re-push the current timing + auto-skip setting to the player
    // iframe, even when nothing changed, so toggling the setting from the
    // popup (or from the on-page switch) takes effect within one polling
    // interval.
    const parametres = await storageGet([STORAGE_KEY_SETTINGS]);
    const autoSkipEnabled = parametres[STORAGE_KEY_SETTINGS]?.autoSkipEnabled ?? true;
    if (toggleAutoSkipElement) toggleAutoSkipElement.checked = autoSkipEnabled;
    envoyerDonneesAutoSkip(iframe, timingActuel, autoSkipEnabled);
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
      extraireNomSerie: extraireNomSerieAnimeSama,
      extraireEpisode: extraireEpisodeAnimeSama,
    },
    "voiranime.rip": {
      extraireNomSerie: extraireNomSerieVoiranime,
      extraireEpisode: extraireEpisodeVoiranime,
    },
  };

  /** Picks the adapter for the current site, defaulting to anime-sama.to's. */
  function obtenirAdaptateur() {
    return ADAPTATEURS_SITE[location.hostname] || ADAPTATEURS_SITE["anime-sama.to"];
  }

  /** Builds the chrome.storage.local key for a given series + episode. */
  function cleTiming(nomSerie, episode) {
    return `${STORAGE_PREFIX_TIMING}${nomSerie}::${episode ?? "?"}`;
  }

  /**
   * Normalizes a title for comparison: strips accents, lowercases,
   * collapses whitespace. Used to match the extracted series name
   * against Jikan search results regardless of case/accents.
   */
  function normaliserTitre(texte) {
    return (texte || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * fetch() with a hard timeout so a slow or dead API never blocks the
   * rest of the extension — callers treat a timeout/error the same as
   * "no data available" and fall back to manual marking.
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
   * Picks the result whose title best matches the extracted series name
   * (case/accent-insensitive, simple equals/includes check). Both Jikan
   * and AniList already rank their search results by relevance, so if no
   * title looks like a match we simply take the first result as the
   * closest guess. `obtenirTitres`/`obtenirId` let this be reused for
   * both APIs, which don't share a response shape.
   */
  function choisirMeilleureCorrespondance(resultats, nomSerie, obtenirId, obtenirTitres) {
    if (resultats.length === 0) return null;

    const cible = normaliserTitre(nomSerie);
    const titresDe = (item) => obtenirTitres(item).filter(Boolean).map(normaliserTitre);

    // Two passes: an exact title match anywhere in the results must win
    // over a mere substring match earlier in the (relevance-sorted) list
    // — e.g. searching "one piece" shouldn't lock onto "One Piece: Stampede"
    // just because it comes first and contains the target string.
    const exact = resultats.find((item) => titresDe(item).some((t) => t === cible));
    if (exact) return obtenirId(exact);

    const partiel = resultats.find((item) => titresDe(item).some((t) => t.includes(cible) || cible.includes(t)));
    if (partiel) return obtenirId(partiel);

    return obtenirId(resultats[0]); // closest guess: top search result
  }

  /** MAL id lookup via Jikan's search endpoint (the API requested originally). */
  async function resoudreMalIdViaJikan(nomSerie) {
    try {
      const url = `${JIKAN_SEARCH_URL}?q=${encodeURIComponent(nomSerie)}&limit=5`;
      const reponse = await fetchAvecTimeout(url);
      if (!reponse.ok) return null;

      const donnees = await reponse.json();
      const resultats = Array.isArray(donnees?.data) ? donnees.data : [];
      return choisirMeilleureCorrespondance(resultats, nomSerie, (a) => a.mal_id, (a) => [
        a.title,
        a.title_english,
        a.title_japanese,
        ...(Array.isArray(a.titles) ? a.titles.map((t) => t.title) : []),
      ]);
    } catch (erreur) {
      console.warn("[Anime Skip Intro] Jikan search failed:", erreur.message);
      return null;
    }
  }

  /**
   * MAL id lookup via AniList's GraphQL search (fallback, new). Jikan's
   * search endpoint proxies MyAnimeList directly and is known to time out
   * even when the rest of Jikan is healthy — observed live while building
   * this feature: search calls returned 504 for several minutes straight
   * while direct-by-id lookups on that same API kept working fine.
   * AniList exposes the MyAnimeList id as `idMal`, so it's a drop-in
   * alternative source for the same piece of data.
   */
  async function resoudreMalIdViaAniList(nomSerie) {
    const requete = `query ($s: String) { Page(perPage: 5) { media(search: $s, type: ANIME) { idMal title { romaji english native } synonyms } } }`;

    try {
      const reponse = await fetchAvecTimeout(ANILIST_GRAPHQL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: requete, variables: { s: nomSerie } }),
      });
      if (!reponse.ok) return null;

      const donnees = await reponse.json();
      const resultats = (donnees?.data?.Page?.media || []).filter((m) => m.idMal != null);
      if (resultats.length === 0) return null;

      return choisirMeilleureCorrespondance(resultats, nomSerie, (m) => m.idMal, (m) => [
        m.title?.romaji,
        m.title?.english,
        m.title?.native,
        ...(Array.isArray(m.synonyms) ? m.synonyms : []),
      ]);
    } catch (erreur) {
      console.warn("[Anime Skip Intro] AniList fallback search failed:", erreur.message);
      return null;
    }
  }

  /**
   * Resolves a MyAnimeList ID for a series name: tries Jikan first (as
   * originally requested), falls back to AniList if Jikan's search
   * endpoint fails or times out. Cached for 7 days under a series-only
   * key (shared across all episodes of the same show, so we don't
   * re-query either API on every episode). Returns null (and caches that
   * null) if neither source found a usable match.
   */
  async function resoudreMalId(nomSerie) {
    const cle = `${STORAGE_PREFIX_MALID}${nomSerie}`;
    const cache = await storageGet([cle]);
    const entree = cache[cle];
    if (entree && Date.now() - entree.cachedAt < ANISKIP_CACHE_TTL_MS) {
      return entree.malId; // may legitimately be null (previous lookup failed)
    }

    let malId = await resoudreMalIdViaJikan(nomSerie);
    if (malId == null) {
      malId = await resoudreMalIdViaAniList(nomSerie);
    }

    await storageSet({ [cle]: { malId, cachedAt: Date.now() } });
    return malId;
  }

  /**
   * Full AniSkip resolution flow: series name -> MAL id (via Jikan) ->
   * opening/ending skip times (via AniSkip) for the given episode.
   *
   * Returns a timing object or null. null means "AniSkip has nothing
   * usable for this episode" (no MAL match, 404, empty results, network
   * error, timeout...) — the caller falls back to manual marking in
   * every one of those cases, per the requested behavior.
   */
  async function resoudreTimingAniSkip(nomSerie, episode) {
    const malId = await resoudreMalId(nomSerie);
    if (!malId) return null;

    try {
      // AniSkip requires an `episodeLength` query param (returns 400
      // without it). We don't know the real episode length from this
      // page (it lives in the cross-origin video iframe), so we pass 0,
      // which AniSkip accepts as "unknown" — confirmed against the live
      // API while building this feature.
      const url = `${ANISKIP_BASE_URL}/${malId}/${episode}?types=op&types=ed&episodeLength=0`;
      const reponse = await fetchAvecTimeout(url);

      if (reponse.status === 404) return null; // no skip times for this episode
      if (!reponse.ok) return null;

      const donnees = await reponse.json();
      if (!donnees.found || !Array.isArray(donnees.results) || donnees.results.length === 0) {
        return null;
      }

      const opening = donnees.results.find((r) => r.skipType === "op");
      if (!opening) return null; // we only auto-skip the opening ("skip intro")

      const ending = donnees.results.find((r) => r.skipType === "ed");

      return {
        debut: opening.interval.startTime,
        fin: opening.interval.endTime,
        // Ending timestamps are stored for completeness / possible future
        // use, but auto-skip currently only acts on the opening interval,
        // matching the extension's existing "skip intro" scope.
        debutEd: ending ? ending.interval.startTime : null,
        finEd: ending ? ending.interval.endTime : null,
        source: "aniskip",
        cachedAt: Date.now(),
      };
    } catch (erreur) {
      console.warn("[Anime Skip Intro] AniSkip request failed:", erreur.message);
      return null;
    }
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
  async function resoudreEtAfficher(iframe, nomSerie, episode) {
    const cle = cleTiming(nomSerie, episode);

    const cache = await storageGet([cle]);
    const manuel = cache[cle];
    if (manuel && manuel.source === "manual" && typeof manuel.fin === "number") {
      afficherPanneau(iframe, nomSerie, episode, manuel);
      return manuel;
    }

    let timing = cacheAniSkipEnMemoire.get(cle) || null;

    if (!timing && episode != null && !tentativesEffectuees.has(cle)) {
      tentativesEffectuees.add(cle);
      timing = await resoudreTimingAniSkip(nomSerie, episode);
      if (timing) cacheAniSkipEnMemoire.set(cle, timing);
    }

    afficherPanneau(iframe, nomSerie, episode, timing);
    return timing && typeof timing.fin === "number" ? timing : null;
  }

  function retirerBouton() {
    const conteneur = document.getElementById("asi-floating-container");
    if (conteneur) conteneur.remove();
    boutonActuel = null;
    toggleAutoSkipElement = null;
  }

  /**
   * Builds the on-page floating panel (redesigned, new): a small card with
   * the detected series/episode + source badge, an auto-skip on/off
   * switch (so this setting no longer requires opening the popup), and
   * the action button — "Skip Intro" when timing data is available, or
   * "Marquer fin d'intro" as the manual fallback otherwise.
   */
  function afficherPanneau(iframe, nomSerie, episode, timing) {
    retirerBouton();

    const conteneur = document.createElement("div");
    conteneur.id = "asi-floating-container";

    // --- Header: series/episode + source badge ---
    const entete = document.createElement("div");
    entete.id = "asi-panel-header";

    const titre = document.createElement("span");
    titre.id = "asi-panel-title";
    const episodeTxt = episode != null ? `Ép. ${episode}` : "épisode inconnu";
    titre.textContent = `${nomSerie} — ${episodeTxt}`;
    entete.appendChild(titre);

    if (timing?.source) {
      const badge = document.createElement("span");
      badge.id = "asi-panel-badge";
      badge.classList.add(timing.source === "aniskip" ? "asi-badge-auto" : "asi-badge-manual");
      badge.textContent = timing.source === "aniskip" ? "🤖 Auto" : "✋ Manuel";
      entete.appendChild(badge);
    }

    conteneur.appendChild(entete);

    // --- Auto-skip on/off switch (new) ---
    const ligneToggle = document.createElement("label");
    ligneToggle.id = "asi-toggle-row";

    const interrupteur = document.createElement("input");
    interrupteur.type = "checkbox";
    interrupteur.id = "asi-toggle-autoskip";

    const curseur = document.createElement("span");
    curseur.id = "asi-toggle-slider";

    const texteToggle = document.createElement("span");
    texteToggle.id = "asi-toggle-label";
    texteToggle.textContent = "Saut automatique";

    ligneToggle.appendChild(interrupteur);
    ligneToggle.appendChild(curseur);
    ligneToggle.appendChild(texteToggle);
    conteneur.appendChild(ligneToggle);

    toggleAutoSkipElement = interrupteur;
    storageGet([STORAGE_KEY_SETTINGS]).then((resultat) => {
      interrupteur.checked = resultat[STORAGE_KEY_SETTINGS]?.autoSkipEnabled ?? true;
    });
    interrupteur.addEventListener("change", () => {
      // Shares the same storage key as the popup's checkbox, so both stay
      // in sync (the popup reflects this change next time it's opened,
      // and this switch picks up popup changes on the next polling tick).
      storageSet({ [STORAGE_KEY_SETTINGS]: { autoSkipEnabled: interrupteur.checked } });
    });

    // --- Action button: Skip Intro (AniSkip/manual data available) or
    //     Marquer fin d'intro (manual-marking fallback) ---
    const bouton = document.createElement("button");
    bouton.id = "asi-floating-button";
    conteneur.appendChild(bouton);

    document.body.appendChild(conteneur);
    boutonActuel = bouton;

    if (timing && typeof timing.fin === "number") {
      bouton.textContent = "⏭ Skip Intro";
      bouton.addEventListener("click", () => {
        iframe.contentWindow.postMessage({ canal: CANAL, type: "seek", time: timing.fin }, "*");
      });
    } else {
      bouton.textContent = "🏁 Marquer fin d'intro";
      bouton.addEventListener("click", async () => {
        let reponse;
        try {
          reponse = await envoyerMessageAuLecteur(iframe, { type: "get-current-time" }, "current-time");
        } catch (erreur) {
          console.warn("[Anime Skip Intro]", erreur.message);
          alert(
            "Impossible de récupérer le temps de la vidéo. " +
            "Essaie de changer de lecteur (Lecteur 1/2/3) ou attends que la vidéo soit bien chargée."
          );
          return;
        }

        const cle = cleTiming(nomSerie, episode);
        const cache = await storageGet([cle]);
        const ancienTiming = cache[cle] || { debut: 0 };

        const nouveauTiming = {
          debut: ancienTiming.debut ?? 0,
          fin: reponse.time,
          source: "manual",
        };

        await storageSet({ [cle]: nouveauTiming });
        console.log(
          `[Anime Skip Intro] Timing enregistré pour "${nomSerie}" (ép. ${episode}) :`,
          nouveauTiming
        );
        timingActuel = nouveauTiming;
        afficherPanneau(iframe, nomSerie, episode, nouveauTiming);
      });
    }

    return bouton;
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
   * Sends the current skip window + the user's auto-skip preference to
   * the player iframe (new). player-frame.js keeps watching video
   * playback and seeks past the intro on its own when enabled. Sent on
   * every polling tick (including when unchanged) so a setting toggled
   * from the popup is picked up within one interval.
   */
  function envoyerDonneesAutoSkip(iframe, timing, autoSkipEnabled) {
    iframe.contentWindow.postMessage(
      {
        canal: CANAL,
        type: "set-skip-data",
        debut: timing?.debut ?? null,
        fin: timing?.fin ?? null,
        autoSkipEnabled: !!autoSkipEnabled,
      },
      "*"
    );
  }

}
