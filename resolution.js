// The anime resolution cascade — title normalization, malId matching,
// episode-count sanity check, and absolute-episode-number math for
// multi-season franchises — split out of content.js so it can be unit
// tested directly.
//
// Plain classic script, not an ES module: MV3 content scripts don't
// support "type": "module". manifest.json lists this file before
// content.js, so everything declared here (storageGet, fetchAvecTimeout,
// resoudreMalIdEtEpisode, etc.) executes in the same shared global scope
// and is directly callable from content.js.
//
// The module.exports guard at the bottom only fires under Node (Vitest);
// "module" doesn't exist in a content script's world.

  const ANISKIP_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const FETCH_TIMEOUT_MS = 8000;
  const JIKAN_SEARCH_URL = "https://api.jikan.moe/v4/anime";
  const ANILIST_GRAPHQL_URL = "https://graphql.anilist.co"; // fallback when Jikan search is down

  // Manual last-resort overrides for titles that still fail automated
  // malId matching, checked before any API call. Keyed by the site's URL
  // slug (voiranime.rip/{slug}/saison-x/episode-y/), not the displayed
  // title, since the slug is stable. Starts empty — fill in as bad
  // matches are found, e.g.:
  //   "some-slug-from-the-url": 12345,
  const OVERRIDES_MALID = {};

  const STORAGE_PREFIX_MALID = "asi-malid::"; // per series (shared across episodes)
  // Per MAL id -> that entry's TV "Sequel" MAL id (or null), via Jikan's
  // /relations endpoint — walks from a show's first-season malId to
  // whichever season is actually playing.
  const STORAGE_PREFIX_SEQUEL_MALID = "asi-sequelmalid::";
  // Per nomSerieBase -> { comptes: { [numSaison]: nbEpisodes }, cachedAt },
  // scraped from the anime's own root page on voiranime.rip — lets a
  // site's per-season episode number convert to MAL's absolute numbering
  // for franchises with no per-season MAL split.
  const STORAGE_PREFIX_SAISONS = "asi-saisons::";

  // chrome.storage.local promise wrappers + the "extension context
  // invalidated" guard they share.

  // True once the extension is reloaded/uninstalled while this content
  // script instance is still alive — chrome.runtime.id becomes undefined,
  // and any chrome.storage call afterward throws. Only a page reload
  // recovers.
  function contexteValide() {
    return typeof chrome !== "undefined" && !!chrome.runtime?.id;
  }

  let avertissementContexteAffiche = false;
  function avertirContexteInvalide() {
    if (avertissementContexteAffiche) return;
    avertissementContexteAffiche = true;
    console.warn(
      "[SkipSensei] Extension rechargée : rafraîchis cette page (F5) pour que SkipSensei refonctionne."
    );
  }

  function storageGet(keys) {
    if (!contexteValide()) {
      avertirContexteInvalide();
      return Promise.reject(new Error("Extension context invalidated"));
    }
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.get(keys, resolve);
      } catch (erreur) {
        avertirContexteInvalide();
        reject(erreur);
      }
    });
  }
  function storageSet(items) {
    if (!contexteValide()) {
      avertirContexteInvalide();
      return Promise.reject(new Error("Extension context invalidated"));
    }
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set(items, resolve);
      } catch (erreur) {
        avertirContexteInvalide();
        reject(erreur);
      }
    });
  }

  // Strips accents, lowercases, collapses whitespace — for matching the
  // extracted series name against search results regardless of
  // case/accents.
  function normaliserTitre(texte) {
    return (texte || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  // Builds search-query variants to try against Jikan/AniList for a
  // scraped French title, in order — stops at the first that yields a
  // confident match (see resoudreMalId).
  //
  // 1) Leading French article ("le "/"la "/"les "/"un "/"une ") or elision
  //    ("l'"/"d'") stripped, plus punctuation cleanup. Only fires on those
  //    exact delimited prefixes, so e.g. "Dragon Ball" passes through
  //    untouched.
  // 2) Fallback only reached if (1) finds nothing: some French sites
  //    swallow the apostrophe of an elision entirely — voiranime.rip
  //    renders "L'Attaque des Titans" as "LAttaque des Titans". Confirmed
  //    live: searching "lattaque des titans" returns nothing, but
  //    "attaque des titans" (leading "l" stripped) correctly matches
  //    malId 16498 (Attack on Titan). Tried second so a title that
  //    genuinely starts with L/D ("Log Horizon", "Death Note") always
  //    resolves on attempt 1 first.
  function genererVariantesRecherche(titre) {
    const nettoye = (titre || "")
      .replace(/^(l['’]|le\s+|la\s+|les\s+|d['’]|un\s+|une\s+)/i, "")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();

    const variantes = [nettoye];

    const correspondanceElisionCollee = nettoye.match(/^([ld])([a-zàâäéèêëïîôöùûüÿœ].+)/i);
    if (correspondanceElisionCollee) {
      variantes.push(correspondanceElisionCollee[2]);
    }

    return variantes;
  }

  // fetch() with a hard timeout so a slow/dead API never blocks the rest
  // of the extension — callers treat a timeout/error like "no data".
  async function fetchAvecTimeout(url, options = {}, delaiMs = FETCH_TIMEOUT_MS) {
    const controleur = new AbortController();
    const timeoutId = setTimeout(() => controleur.abort(), delaiMs);
    try {
      return await fetch(url, { ...options, signal: controleur.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Picks the result whose title best matches the series name
  // (case/accent-insensitive). Jikan/AniList already rank by relevance,
  // so absent a title match we take the first result. Returns the raw
  // item (not just its id) so callers can read its episode count for
  // verifierCoherenceMalId. `obtenirTitres` lets this be reused for both
  // APIs' differing response shapes.
  function choisirMeilleureCorrespondance(resultats, nomSerie, obtenirTitres) {
    if (resultats.length === 0) return null;

    const cible = normaliserTitre(nomSerie);
    const titresDe = (item) => obtenirTitres(item).filter(Boolean).map(normaliserTitre);

    // Exact match anywhere must win over a mere substring match earlier
    // in the (relevance-sorted) list — e.g. "one piece" shouldn't lock
    // onto "One Piece: Stampede" just because it comes first.
    const exact = resultats.find((item) => titresDe(item).some((t) => t === cible));
    if (exact) return exact;

    const partiel = resultats.find((item) => titresDe(item).some((t) => t.includes(cible) || cible.includes(t)));
    if (partiel) return partiel;

    return resultats[0]; // closest guess: top search result
  }

  async function resoudreMalIdViaJikan(nomSerie) {
    try {
      const url = `${JIKAN_SEARCH_URL}?q=${encodeURIComponent(nomSerie)}&limit=5`;
      const reponse = await fetchAvecTimeout(url);
      if (!reponse.ok) return null;

      const donnees = await reponse.json();
      const resultats = Array.isArray(donnees?.data) ? donnees.data : [];
      const candidat = choisirMeilleureCorrespondance(resultats, nomSerie, (a) => [
        a.title,
        a.title_english,
        a.title_japanese,
        ...(Array.isArray(a.titles) ? a.titles.map((t) => t.title) : []),
      ]);
      return candidat ? { malId: candidat.mal_id, episodes: candidat.episodes ?? null } : null;
    } catch (erreur) {
      console.warn("[SkipSensei] Jikan search failed:", erreur.message);
      return null;
    }
  }

  // AniList search, tried first (see resoudreMalId): its community
  // synonyms give noticeably better coverage of French/localized titles
  // than MAL's own search, which mostly indexes English/romaji/Japanese —
  // confirmed live, "L'Attaque des Titans" as scraped from voiranime.rip
  // returns nothing on either API until normalized (see
  // genererVariantesRecherche), and AniList's fuzzy ranking is what lands
  // on the right entry once it is.
  async function resoudreMalIdViaAniList(nomSerie) {
    const requete = `query ($s: String) { Page(perPage: 5) { media(search: $s, type: ANIME) { idMal episodes title { romaji english native } synonyms } } }`;

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

      const candidat = choisirMeilleureCorrespondance(resultats, nomSerie, (m) => [
        m.title?.romaji,
        m.title?.english,
        m.title?.native,
        ...(Array.isArray(m.synonyms) ? m.synonyms : []),
      ]);
      return candidat ? { malId: candidat.idMal, episodes: candidat.episodes ?? null } : null;
    } catch (erreur) {
      console.warn("[SkipSensei] AniList search failed:", erreur.message);
      return null;
    }
  }

  // Sanity-checks a resolved malId against the site's own scraped episode
  // count, to catch a wrong-but-confident match (e.g. landing on a
  // 1-episode movie instead of the real TV series). Only rejects when the
  // candidate has FEWER episodes than the site lists for Saison 1 alone —
  // never for having more, since a single continuous MAL entry spanning
  // every site season (One Piece-style) legitimately has far more.
  async function verifierCoherenceMalId(malId, episodesCandidat, urlRacine, nomSerieBase) {
    if (episodesCandidat == null || !urlRacine) return malId; // rien à comparer

    let comptes;
    try {
      comptes = await obtenirComptesEpisodesParSaison(nomSerieBase, urlRacine, 1);
    } catch {
      return malId;
    }
    const compteSaison1 = comptes?.[1];
    if (!Number.isFinite(compteSaison1)) return malId;

    if (episodesCandidat < compteSaison1) {
      console.warn(
        `[SkipSensei] malId ${malId} rejeté pour "${nomSerieBase}" : la fiche trouvée n'a que ${episodesCandidat} ` +
          `épisode(s), mais le site en liste ${compteSaison1} pour la seule Saison 1 — correspondance probablement fausse.`
      );
      return null;
    }
    return malId;
  }

  // Resolves a MyAnimeList ID for a series, in order of precedence:
  //  0) OVERRIDES_MALID, keyed by slug.
  //  1) AniList search across every genererVariantesRecherche variant.
  //  2) Jikan search, same variants, only if AniList found nothing.
  //  3) verifierCoherenceMalId as a sanity gate on the match.
  // Cached 7 days under slug (falls back to nomSerieBase when the site
  // adapter has no slug — e.g. anime-sama.to). Caches and returns null if
  // nothing resolved or the sanity check rejected it.
  async function resoudreMalId(nomSerieBase, slug, urlRacine) {
    const cle = `${STORAGE_PREFIX_MALID}${slug || nomSerieBase}`;
    const cache = await storageGet([cle]);
    const entree = cache[cle];
    if (entree && Date.now() - entree.cachedAt < ANISKIP_CACHE_TTL_MS) {
      return entree.malId; // may legitimately be null (previous lookup failed/rejected)
    }

    if (slug && OVERRIDES_MALID[slug] != null) {
      const malId = OVERRIDES_MALID[slug];
      await storageSet({ [cle]: { malId, cachedAt: Date.now() } });
      return malId;
    }

    const variantes = genererVariantesRecherche(nomSerieBase);

    let candidat = null;
    for (const variante of variantes) {
      candidat = await resoudreMalIdViaAniList(variante);
      if (candidat) break;
    }
    if (!candidat) {
      for (const variante of variantes) {
        candidat = await resoudreMalIdViaJikan(variante);
        if (candidat) break;
      }
    }

    let malId = candidat?.malId ?? null;
    if (malId != null) {
      malId = await verifierCoherenceMalId(malId, candidat.episodes, urlRacine, nomSerieBase);
    }

    await storageSet({ [cle]: { malId, cachedAt: Date.now() } });
    return malId;
  }

  // Single hop "this MAL id's TV sequel" via Jikan's /relations endpoint,
  // cached 7 days per malId. Filters entry by type "anime" since a
  // relations list can also contain manga/other non-anime entries under
  // different relation types (e.g. "Adaptation").
  async function resoudreSequelMalId(malId) {
    const cle = `${STORAGE_PREFIX_SEQUEL_MALID}${malId}`;
    const cache = await storageGet([cle]);
    const entree = cache[cle];
    if (entree && Date.now() - entree.cachedAt < ANISKIP_CACHE_TTL_MS) {
      return entree.sequelMalId; // may legitimately be null (no sequel / lookup failed)
    }

    let sequelMalId = null;
    try {
      const reponse = await fetchAvecTimeout(`${JIKAN_SEARCH_URL}/${malId}/relations`);
      if (reponse.ok) {
        const donnees = await reponse.json();
        const relationSuite = (donnees?.data || []).find((r) => r.relation === "Sequel");
        const entreeAnime = relationSuite?.entry?.find((e) => e.type === "anime");
        sequelMalId = entreeAnime?.mal_id ?? null;
      }
    } catch (erreur) {
      console.warn("[SkipSensei] Jikan relations lookup failed:", erreur.message);
    }

    await storageSet({ [cle]: { sequelMalId, cachedAt: Date.now() } });
    return sequelMalId;
  }

  // Scrapes per-season episode counts off an anime's own root page on
  // voiranime.rip — e.g. ".../one-piece/" lists each "Saison N" next to a
  // ".season-meta" chip reading "61 épisodes". Reads the whole season
  // list in one fetch (not one page per season) since a viewer jumping
  // straight to Saison 7 still needs every prior season's count to
  // compute an absolute episode number (see resoudreMalIdEtEpisode).
  async function scraperComptesEpisodesParSaison(urlRacine) {
    const reponse = await fetchAvecTimeout(urlRacine);
    if (!reponse.ok) throw new Error(`HTTP ${reponse.status}`);
    const html = await reponse.text();
    const doc = new DOMParser().parseFromString(html, "text/html");

    const comptes = {};
    doc.querySelectorAll(".season-meta").forEach((chip) => {
      const lien =
        chip.closest("a") ||
        chip.parentElement?.querySelector('a[href*="saison-"]') ||
        chip.closest("div")?.querySelector('a[href*="saison-"]');
      const correspondanceSaison = lien?.href.match(/saison-(\d+)/i);
      const correspondanceEpisodes = chip.querySelector("span")?.textContent.match(/(\d+)/);
      if (correspondanceSaison && correspondanceEpisodes) {
        comptes[parseInt(correspondanceSaison[1], 10)] = parseInt(correspondanceEpisodes[1], 10);
      }
    });
    return comptes;
  }

  // Cached wrapper around scraperComptesEpisodesParSaison, per
  // nomSerieBase, 7-day TTL. Re-scrapes when the cache doesn't yet cover
  // saisonRequise or has expired. Falls back to a stale/incomplete cached
  // value on scrape failure rather than nothing, since already-completed
  // seasons are still very likely correct.
  async function obtenirComptesEpisodesParSaison(nomSerieBase, urlRacine, saisonRequise) {
    const cle = `${STORAGE_PREFIX_SAISONS}${nomSerieBase}`;
    const cache = await storageGet([cle]);
    const entree = cache[cle];
    const connaitLaSaison = entree && Number.isFinite(entree.comptes?.[saisonRequise]);
    const encoreValide = entree && Date.now() - entree.cachedAt < ANISKIP_CACHE_TTL_MS;

    if (connaitLaSaison && encoreValide) {
      return entree.comptes;
    }

    try {
      const comptes = await scraperComptesEpisodesParSaison(urlRacine);
      if (Object.keys(comptes).length > 0) {
        await storageSet({ [cle]: { comptes, cachedAt: Date.now() } });
        return comptes;
      }
    } catch (erreur) {
      console.warn("[SkipSensei] Scrape des compteurs par saison a échoué:", erreur.message);
    }

    return entree?.comptes || null;
  }

  // Resolves the (malId, episode) pair to actually query AniSkip/OAT
  // with, for a given (nomSerieBase, saison, episodeSite).
  //
  // Root cause: voiranime.rip resets its displayed episode number to 1 at
  // the start of every "Saison". Two franchise shapes need two fixes:
  //  1) Each site season is its own MAL entry (e.g. Jujutsu Kaisen Saison
  //     2 = malId 51009, distinct from Saison 1's 40748): walk
  //     (saison - 1) "Sequel" relations from the base malId — episodeSite
  //     is already correct as-is.
  //  2) A single continuous MAL entry across every site season (confirmed
  //     live for One Piece: malId 21 throughout, zero Sequel relations):
  //     MAL/AniSkip's episode numbers are absolute, so episodeSite needs
  //     the sum of every prior season's scraped episode count added in.
  // Detection is automatic — case (2) is what happens when case (1)'s
  // Sequel walk fails to find a next entry. Never falls back to
  // (malIdBase, episodeSite): that pairing is exactly the
  // wrong-episode-under-the-wrong-id bug this function avoids.
  async function resoudreMalIdEtEpisode(nomSerieBase, saison, episodeSite, obtenirUrlRacine) {
    const urlRacine = obtenirUrlRacine ? obtenirUrlRacine() : null;
    const slug = urlRacine ? urlRacine.replace(/\/$/, "").split("/").pop() : null;

    const malIdBase = await resoudreMalId(nomSerieBase, slug, urlRacine);
    if (malIdBase == null) {
      return { malId: null, episode: null };
    }
    if (!Number.isFinite(saison) || saison <= 1) {
      return { malId: malIdBase, episode: episodeSite };
    }

    let malIdCourant = malIdBase;
    let echecSequel = false;
    for (let i = 1; i < saison; i++) {
      malIdCourant = await resoudreSequelMalId(malIdCourant);
      if (malIdCourant == null) {
        echecSequel = true;
        break;
      }
    }
    if (!echecSequel) {
      return { malId: malIdCourant, episode: episodeSite };
    }

    // Repli : franchise à fiche MAL unique et continue (style One Piece).
    if (!urlRacine || episodeSite == null) {
      return { malId: null, episode: null };
    }

    const comptes = await obtenirComptesEpisodesParSaison(nomSerieBase, urlRacine, saison);
    if (!comptes) {
      return { malId: null, episode: null };
    }

    let episodeAbsolu = episodeSite;
    for (let s = 1; s < saison; s++) {
      const compteSaison = comptes[s];
      if (!Number.isFinite(compteSaison)) {
        // Une saison intermédiaire manque dans les compteurs scrapés :
        // mieux vaut aucune donnée qu'un décalage silencieux.
        return { malId: null, episode: null };
      }
      episodeAbsolu += compteSaison;
    }

    return { malId: malIdBase, episode: episodeAbsolu };
  }

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    // constants (exported for test setup, e.g. building cache keys)
    ANISKIP_CACHE_TTL_MS,
    STORAGE_PREFIX_MALID,
    STORAGE_PREFIX_SEQUEL_MALID,
    STORAGE_PREFIX_SAISONS,
    OVERRIDES_MALID,
    // storage/fetch primitives (mocked in tests)
    contexteValide,
    storageGet,
    storageSet,
    fetchAvecTimeout,
    // resolution cascade
    normaliserTitre,
    genererVariantesRecherche,
    choisirMeilleureCorrespondance,
    resoudreMalIdViaJikan,
    resoudreMalIdViaAniList,
    verifierCoherenceMalId,
    resoudreMalId,
    resoudreSequelMalId,
    scraperComptesEpisodesParSaison,
    obtenirComptesEpisodesParSaison,
    resoudreMalIdEtEpisode,
  };
}
