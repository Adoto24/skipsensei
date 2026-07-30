import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import resolution from "../resolution.js";

const {
  normaliserTitre,
  genererVariantesRecherche,
  choisirMeilleureCorrespondance,
  verifierCoherenceMalId,
  resoudreMalIdEtEpisode,
  STORAGE_PREFIX_MALID,
  STORAGE_PREFIX_SEQUEL_MALID,
  STORAGE_PREFIX_SAISONS,
} = resolution;

/**
 * Minimal chrome.storage.local mock: an in-memory object, read/written the
 * same way the real API is (get([key], cb) -> cb({ [key]: value }) only for
 * keys that exist; set({ [key]: value }, cb) -> cb()).
 */
function installChromeMock(store) {
  globalThis.chrome = {
    runtime: { id: "test-extension-id" },
    storage: {
      local: {
        get(keys, cb) {
          const keyList = Array.isArray(keys) ? keys : [keys];
          const resultat = {};
          for (const cle of keyList) {
            if (cle in store) resultat[cle] = store[cle];
          }
          cb(resultat);
        },
        set(items, cb) {
          Object.assign(store, items);
          cb();
        },
      },
    },
  };
}

let store;
beforeEach(() => {
  store = {};
  installChromeMock(store);
  // Any test relying on real network is a bug in the test, not the code
  // under test: fail loudly instead of letting a request escape to the
  // internet.
  globalThis.fetch = vi.fn(() => {
    throw new Error("fetch() should not be called in these tests — mock chrome.storage.local instead");
  });
});
afterEach(() => {
  delete globalThis.chrome;
  delete globalThis.fetch;
  vi.restoreAllMocks();
});

describe("genererVariantesRecherche", () => {
  it("strips a space-delimited French article ('Le ')", () => {
    expect(genererVariantesRecherche("Le Voyage de Chihiro")).toEqual(["Voyage de Chihiro"]);
  });

  it("strips a space-delimited French article ('La ')", () => {
    expect(genererVariantesRecherche("La Boum")[0]).toBe("Boum");
  });

  it("strips a space-delimited French article ('Les ')", () => {
    expect(genererVariantesRecherche("Les Douze Royaumes")[0]).toBe("Douze Royaumes");
  });

  it("strips a real apostrophe elision ('L'')", () => {
    const variantes = genererVariantesRecherche("L'Attaque des Titans");
    expect(variantes[0]).toBe("Attaque des Titans");
  });

  it("strips a real apostrophe elision ('D'')", () => {
    const variantes = genererVariantesRecherche("D'Artagnan et les Trois Mousquetaires");
    expect(variantes[0]).toBe("Artagnan et les Trois Mousquetaires");
  });

  it("offers a second variant for a glued elision ('LAttaque des Titans')", () => {
    const variantes = genererVariantesRecherche("LAttaque des Titans");
    // Primary variant is the title as-is (nothing space/apostrophe-delimited
    // to strip); the fallback variant is what actually resolves on AniList.
    expect(variantes[0]).toBe("LAttaque des Titans");
    expect(variantes).toContain("Attaque des Titans");
  });

  it("does not strip 'Log Horizon' (legitimately starts with L)", () => {
    expect(genererVariantesRecherche("Log Horizon")[0]).toBe("Log Horizon");
  });

  it("does not strip 'Death Note' (legitimately starts with D)", () => {
    expect(genererVariantesRecherche("Death Note")[0]).toBe("Death Note");
  });

  it("does not strip 'Dragon Ball' (legitimately starts with D)", () => {
    expect(genererVariantesRecherche("Dragon Ball")[0]).toBe("Dragon Ball");
  });

  it("leaves a title with no article untouched", () => {
    expect(genererVariantesRecherche("One Piece")).toEqual(["One Piece"]);
  });
});

describe("choisirMeilleureCorrespondance", () => {
  const obtenirTitres = (item) => [item.title];

  it("prefers an exact match over an earlier partial/substring match", () => {
    const resultats = [{ title: "One Piece: Stampede" }, { title: "One Piece" }];
    const choisi = choisirMeilleureCorrespondance(resultats, "One Piece", obtenirTitres);
    expect(choisi).toBe(resultats[1]);
  });

  it("falls back to the first result when nothing matches", () => {
    const resultats = [{ title: "Foo" }, { title: "Bar" }];
    const choisi = choisirMeilleureCorrespondance(resultats, "Baz", obtenirTitres);
    expect(choisi).toBe(resultats[0]);
  });

  it("returns null for an empty results array", () => {
    expect(choisirMeilleureCorrespondance([], "Anything", obtenirTitres)).toBeNull();
  });
});

describe("normaliserTitre", () => {
  it("strips accents, lowercases and collapses whitespace", () => {
    expect(normaliserTitre("Café   de  Paris")).toBe("cafe de paris");
  });

  it("trims leading/trailing whitespace", () => {
    expect(normaliserTitre("  Épée  ")).toBe("epee");
  });

  it("handles null/undefined input as an empty string", () => {
    expect(normaliserTitre(null)).toBe("");
    expect(normaliserTitre(undefined)).toBe("");
  });
});

describe("verifierCoherenceMalId", () => {
  const urlRacine = "https://voiranime.rip/one-piece/";
  const nomSerieBase = "one piece";

  function cacherComptesSaisons(comptes) {
    store[`${STORAGE_PREFIX_SAISONS}${nomSerieBase}`] = { comptes, cachedAt: Date.now() };
  }

  it("rejects a candidate whose episode count is smaller than the site's Saison 1 count", async () => {
    cacherComptesSaisons({ 1: 50 });
    const resultat = await verifierCoherenceMalId(999, 1, urlRacine, nomSerieBase);
    expect(resultat).toBeNull();
  });

  it("does not reject a candidate with MORE episodes than Saison 1 (One Piece case)", async () => {
    cacherComptesSaisons({ 1: 61 });
    const resultat = await verifierCoherenceMalId(21, 1000, urlRacine, nomSerieBase);
    expect(resultat).toBe(21);
  });

  it("passes through when there's nothing to compare against", async () => {
    const resultat = await verifierCoherenceMalId(21, null, urlRacine, nomSerieBase);
    expect(resultat).toBe(21);
  });
});

describe("resoudreMalIdEtEpisode — absolute episode number math", () => {
  const nomSerieBase = "one piece";
  const urlRacine = "https://voiranime.rip/one-piece/";
  const malIdBase = 21;
  const obtenirUrlRacine = () => urlRacine;
  const slug = "one-piece";

  function cacherMalIdBase() {
    store[`${STORAGE_PREFIX_MALID}${slug}`] = { malId: malIdBase, cachedAt: Date.now() };
  }
  function cacherAucuneSuite() {
    // Every "Sequel" hop the walk would take resolves to null, forcing the
    // One-Piece-style continuous-numbering fallback path.
    store[`${STORAGE_PREFIX_SEQUEL_MALID}${malIdBase}`] = { sequelMalId: null, cachedAt: Date.now() };
  }
  function cacherComptesSaisons(comptes) {
    store[`${STORAGE_PREFIX_SAISONS}${nomSerieBase}`] = { comptes, cachedAt: Date.now() };
  }

  it("computes the correct absolute episode number across prior seasons", async () => {
    cacherMalIdBase();
    cacherAucuneSuite();
    cacherComptesSaisons({ 1: 61, 2: 39, 3: 45 });

    const resultat = await resoudreMalIdEtEpisode(nomSerieBase, 3, 5, obtenirUrlRacine);

    expect(resultat).toEqual({ malId: malIdBase, episode: 61 + 39 + 5 });
  });

  it("returns { malId: null, episode: null } when an intermediate season's count is missing", async () => {
    cacherMalIdBase();
    cacherAucuneSuite();
    // Saison 2's count is missing even though Saison 3 (the requested one)
    // is present — obtenirComptesEpisodesParSaison's cache is considered
    // "complete enough" here, so the gap must be caught by the summation
    // itself, not by the cache-freshness check.
    cacherComptesSaisons({ 1: 61, 3: 45 });

    const resultat = await resoudreMalIdEtEpisode(nomSerieBase, 3, 5, obtenirUrlRacine);

    expect(resultat).toEqual({ malId: null, episode: null });
  });

  it("returns the site episode as-is when the season is its own separate MAL entry", async () => {
    cacherMalIdBase();
    // Saison 2 = a distinct MAL sequel entry; the Sequel walk succeeds.
    store[`${STORAGE_PREFIX_SEQUEL_MALID}${malIdBase}`] = { sequelMalId: 51009, cachedAt: Date.now() };

    const resultat = await resoudreMalIdEtEpisode(nomSerieBase, 2, 5, obtenirUrlRacine);

    expect(resultat).toEqual({ malId: 51009, episode: 5 });
  });
});
