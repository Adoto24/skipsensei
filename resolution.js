/* ============================================================
   resolution.js
   ------------------------------------------------------------
   Extracted from content.js (no behavior change) so the anime
   resolution cascade — French-title normalization, malId matching,
   the episode-count sanity check, and the absolute-episode-number
   math for multi-season franchises — can be unit tested directly.

   This is a PLAIN CLASSIC SCRIPT, not an ES module: Chrome MV3
   content scripts declared in manifest.json's "content_scripts"
   don't support "type": "module", so this relies on the same
   mechanism multiple content-script files have always used to share
   state — files listed in "js" all execute in one shared global
   scope, in order. manifest.json lists this file BEFORE content.js,
   so every top-level const/function declared here (storageGet,
   fetchAvecTimeout, resoudreMalIdEtEpisode, etc.) is directly
   callable from content.js exactly as if it were still declared
   in the same file — no namespace, no import, nothing to change
   at any call site.

   The module.exports guard at the bottom only fires under Node
   (i.e. in Vitest); "module" doesn't exist in a content script's
   world, so the browser never touches that branch.
   ============================================================ */

  const ANISKIP_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const FETCH_TIMEOUT_MS = 8000;
  const JIKAN_SEARCH_URL = "https://api.jikan.moe/v4/anime";
  const ANILIST_GRAPHQL_URL = "https://graphql.anilist.co"; // fallback when Jikan search is down

  // Manual last-resort overrides for titles that still fail automated
  // malId matching (see resoudreMalId) despite the AniList-first search +
  // French-article normalization — checked BEFORE any API call. Keyed by
  // the site's URL slug (voiranime.rip/{slug}/saison-x/episode-y/), NOT
  // by the displayed title, since the slug is stable regardless of how
  // the title gets scraped/mangled. Starts empty — fill in as bad matches
  // are found, e.g.:
  //   "some-slug-from-the-url": 12345,
  const OVERRIDES_MALID = {};

  const STORAGE_PREFIX_MALID = "asi-malid::"; // per series (shared across episodes)
  // Per MAL id -> that entry's TV "Sequel" MAL id (or null), via Jikan's
  // /relations endpoint. Used by resoudreMalIdEtEpisode (new) to walk from
  // a show's first-season malId to whichever season is actually playing.
  const STORAGE_PREFIX_SEQUEL_MALID = "asi-sequelmalid::";
  // Per nomSerieBase -> { comptes: { [numSaison]: nbEpisodes }, cachedAt }.
  // Scraped from the anime's own root page on voiranime.rip (new) — for
  // franchises with no per-season MAL split (see resoudreMalIdEtEpisode),
  // this is what lets the site's per-season episode number be converted
  // to MAL's absolute numbering.
  const STORAGE_PREFIX_SAISONS = "asi-saisons::";

  // ------------------------------------------------------------
  // Promise wrappers around chrome.storage.local, plus the
  // "extension context invalidated" guard they share.
  // ------------------------------------------------------------
  /**
   * True once the extension has been reloaded/uninstalled while this
   * content script instance is still alive on the page — chrome.runtime.id
   * becomes undefined at that point, and any chrome.storage call after
   * that throws "Extension context invalidated". There is no recovery
   * from inside this script; only a real page reload gets a fresh,
   * valid content script instance.
   */
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
   * Builds the list of search-query variants to try against Jikan/AniList
   * for a scraped (French) title (new), in order \u2014 stops at the first one
   * that yields a confident match (see resoudreMalId).
   *
   * 1) The title with a leading space-delimited French article ("le ",
   *    "la ", "les ", "un ", "une ") or apostrophed elision ("l'", "d'")
   *    stripped, plus punctuation cleanup. Safe and unambiguous: it only
   *    fires on those exact delimited prefixes, so "Dragon Ball" or "Log
   *    Horizon" pass through untouched.
   * 2) Only reached if (1) finds nothing: some French sites swallow the
   *    apostrophe of an elision entirely \u2014 voiranime.rip's own <title>
   *    renders "L'Attaque des Titans" as "LAttaque des Titans", gluing
   *    the "L" directly onto the next word with no separator left to
   *    detect. Confirmed live: searching AniList for "lattaque des
   *    titans" returns zero results, but "attaque des titans" (the
   *    leading "l" stripped) correctly top-ranks malId 16498 (Shingeki
   *    no Kyojin / Attack on Titan). This variant is deliberately tried
   *    SECOND, only as a fallback after (1) already failed: a title that
   *    genuinely starts with L/D ("Log Horizon", "Death Note", "Dragon
   *    Ball" \u2014 all confirmed live to resolve correctly on the first
   *    variant) always finds its real match on attempt 1 and never
   *    reaches this riskier attempt.
   */
  function genererVariantesRecherche(titre) {
    const nettoye = (titre || "")
      .replace(/^(l['\u2019]|le\s+|la\s+|les\s+|d['\u2019]|un\s+|une\s+)/i, "")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();

    const variantes = [nettoye];

    const correspondanceElisionCollee = nettoye.match(/^([ld])([a-z\u00e0\u00e2\u00e4\u00e9\u00e8\u00ea\u00eb\u00ef\u00ee\u00f4\u00f6\u00f9\u00fb\u00fc\u00ff\u0153].+)/i);
    if (correspondanceElisionCollee) {
      variantes.push(correspondanceElisionCollee[2]);
    }

    return variantes;
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
   * closest guess. Returns the raw matched item (not just its id) so
   * callers can also read its episode count for verifierCoherenceMalId.
   * `obtenirTitres` lets this be reused for both APIs, which don't share
   * a response shape.
   */
  function choisirMeilleureCorrespondance(resultats, nomSerie, obtenirTitres) {
    if (resultats.length === 0) return null;

    const cible = normaliserTitre(nomSerie);
    const titresDe = (item) => obtenirTitres(item).filter(Boolean).map(normaliserTitre);

    // Two passes: an exact title match anywhere in the results must win
    // over a mere substring match earlier in the (relevance-sorted) list
    // — e.g. searching "one piece" shouldn't lock onto "One Piece: Stampede"
    // just because it comes first and contains the target string.
    const exact = resultats.find((item) => titresDe(item).some((t) => t === cible));
    if (exact) return exact;

    const partiel = resultats.find((item) => titresDe(item).some((t) => t.includes(cible) || cible.includes(t)));
    if (partiel) return partiel;

    return resultats[0]; // closest guess: top search result
  }

  /** MAL id + episode count lookup via Jikan's search endpoint. */
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

  /**
   * MAL id + episode count lookup via AniList's GraphQL search (new
   * primary source, ahead of Jikan — see resoudreMalId). AniList's
   * community-submitted synonyms give it noticeably better coverage of
   * French/localized titles than MAL's own search, which only really
   * indexes English/romaji/Japanese titles: confirmed live, searching
   * Jikan or AniList for "L'Attaque des Titans" as scraped from
   * voiranime.rip returns nothing useful until the title is normalized
   * (see genererVariantesRecherche) — AniList's fuzzy ranking is also
   * what actually lands on the right entry once normalized, not just an
   * exact synonym match.
   */
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

  /**
   * Sanity-checks a resolved malId against metadata already scraped from
   * the site itself (new) — episode count. AniSkip lookups otherwise
   * apply a wrong-but-confident-looking match silently (the exact failure
   * mode this whole malId resolution has been fought against). Rejects
   * (returns null, logs a warning) only when the candidate's own episode
   * count is SMALLER than what the site lists for Saison 1 alone — e.g. a
   * search landing on a 1-episode movie/short instead of the real TV
   * series. Deliberately one-directional (never rejects for having MORE
   * episodes than Saison 1): a single continuous MAL entry spanning every
   * site season (One Piece-style — see resoudreMalIdEtEpisode) legitimately
   * has far more episodes than Saison 1 alone, and that shape must not be
   * flagged as wrong.
   */
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

  /**
   * Resolves a MyAnimeList ID for a series (new signature: also takes the
   * site's URL slug + root page URL, see resoudreMalIdEtEpisode). Order of
   * precedence:
   *  0) OVERRIDES_MALID, keyed by slug — checked before any network call.
   *  1) AniList search (better French-title/synonym coverage than Jikan
   *     — see resoudreMalIdViaAniList), tried across every search-query
   *     variant from genererVariantesRecherche.
   *  2) Jikan search, same variants, only if AniList found nothing.
   *  3) verifierCoherenceMalId as a last sanity gate on whatever matched.
   * Cached for 7 days under slug (falls back to nomSerieBase if the site
   * adapter has no slug concept — e.g. anime-sama.to). Returns null (and
   * caches that null) if nothing resolved or the sanity check rejected it.
   */
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

  /**
   * Single hop "this MAL id's TV sequel", via Jikan's /relations endpoint,
   * cached 7 days per malId (same TTL/shape pattern as resoudreAniDbId).
   * Confirmed live against Jikan: /v4/anime/40748/relations (Jujutsu
   * Kaisen) returns a relation entry with relation: "Sequel" and
   * entry: [{ mal_id: 51009, type: "anime", name: "Jujutsu Kaisen 2nd
   * Season" }] — filtering entry by type "anime" matters because a
   * relations list can also contain manga/other non-anime entries under
   * different relation types (e.g. "Adaptation").
   */
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

  /**
   * Scrapes per-season episode counts straight off an anime's own root
   * page on voiranime.rip (new) — e.g. ".../one-piece/" lists every
   * season as a "Saison N" link next to a ".season-meta" chip reading
   * "61 épisodes". Confirmed live for One Piece (12 saisons) and Jujutsu
   * Kaisen (3 saisons); the scraped per-season counts summed to the
   * page's own displayed total in both cases.
   *
   * Deliberately reads the WHOLE season list in one page fetch rather
   * than one page per season: a viewer who jumps straight to Saison 7
   * without ever visiting Saisons 1-6 still needs their episode counts
   * to compute an absolute episode number (see resoudreMalIdEtEpisode),
   * and this page already has all of them regardless of viewing order.
   */
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

  /**
   * Cached wrapper around scraperComptesEpisodesParSaison, per nomSerieBase.
   * Re-scrapes when the cache doesn't yet cover saisonRequise (the site
   * added a season since the last scrape) or has simply expired — same
   * 7-day TTL as the other rarely-changing per-series caches. Falls back
   * to a stale/incomplete cached value on scrape failure rather than
   * nothing, since a stale season list is still very likely correct for
   * every already-completed season.
   */
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

  /**
   * Resolves the (malId, episode) pair to actually query AniSkip/OAT with
   * for a given (nomSerieBase, saison, episodeSite) (new).
   *
   * Root cause this fixes: voiranime.rip resets its displayed episode
   * number to 1 at the start of every "Saison". Two different franchise
   * shapes need two different fixes:
   *  1) Shows where each site season is its OWN separate MAL entry (e.g.
   *     Jujutsu Kaisen Saison 2 = malId 51009, distinct from Saison 1's
   *     40748): resolved by walking (saison - 1) "Sequel" relations from
   *     the base malId — episodeSite is already correct as-is for that id.
   *  2) Shows with a SINGLE continuous MAL entry across every site season
   *     (confirmed live for One Piece: malId 21 the whole way, zero
   *     "Sequel" relations at all) — MAL/AniSkip's episode numbers there
   *     are absolute, so episodeSite needs converting: sum of every prior
   *     season's episode count (scraped off the site itself) + episodeSite.
   * Detection is automatic — case (2) is simply what happens when case
   * (1)'s Sequel walk fails to find a next entry.
   *
   * Returns { malId: null, episode: null } if neither approach resolves
   * cleanly. Deliberately never falls back to (malIdBase, episodeSite):
   * that combination is exactly the wrong-episode-under-the-wrong-id bug
   * this function exists to avoid reproducing.
   */
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
        // Une saison intermédiaire manque dans les compteurs scrapés : la
        // somme serait fausse (sous-estimée) — mieux vaut aucune donnée
        // qu'un décalage silencieux, même léger.
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
