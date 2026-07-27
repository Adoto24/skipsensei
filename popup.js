/* ============================================================
   popup.js
   ------------------------------------------------------------
   Ce script tourne dans le contexte du popup (pas dans la page
   du site). Il a accès à toutes les API chrome.* normalement,
   ici on utilise juste chrome.storage.local pour lire/modifier/
   supprimer les timings enregistrés par content.js, et pour
   lire/écrire le réglage "saut automatique".
   ============================================================ */

// Keys used in chrome.storage.local (kept in sync with content.js):
// - "asi-timing::<serie>::<episode>" -> { debut, fin, source: "manual" }
//   (AniSkip results are resolved fresh each session and never written
//   here — only manual overrides persist, so this is the only kind of
//   entry the list below will ever show)
// - "asi-malid::<serie>"             -> MAL id cache (not shown here)
// - "asi-settings"                  -> { autoSkipEnabled }
const PREFIXE_TIMING = "asi-timing::";
const CLE_PARAMETRES = "asi-settings";

const conteneurListe = document.getElementById("liste-series");
const messageVide = document.getElementById("message-vide");
const caseAutoSkip = document.getElementById("case-auto-skip");

// Au chargement du popup, on affiche tout de suite la liste actuelle
document.addEventListener("DOMContentLoaded", () => {
  chargerParametres();
  chargerEtAfficherListe();
});

/**
 * Charge le réglage "saut automatique" (activé par défaut) et
 * initialise la case à cocher correspondante.
 */
function chargerParametres() {
  chrome.storage.local.get([CLE_PARAMETRES], (resultat) => {
    const parametres = resultat[CLE_PARAMETRES] || { autoSkipEnabled: true };
    caseAutoSkip.checked = parametres.autoSkipEnabled !== false;
  });
}

caseAutoSkip.addEventListener("change", () => {
  const nouveauxParametres = { autoSkipEnabled: caseAutoSkip.checked };
  chrome.storage.local.set({ [CLE_PARAMETRES]: nouveauxParametres }, () => {
    console.log(
      `[Anime Skip Intro] Saut automatique ${caseAutoSkip.checked ? "activé" : "désactivé"}.`
    );
  });
});

/**
 * Récupère toutes les données de chrome.storage.local et construit
 * une "carte" par (série, épisode) trouvé. Ignore les clés qui ne
 * sont pas des timings (cache d'ID MyAnimeList, réglages...).
 */
function chargerEtAfficherListe() {
  chrome.storage.local.get(null, (toutesLesDonnees) => {
    conteneurListe.innerHTML = "";

    const clesTimings = Object.keys(toutesLesDonnees).filter((cle) =>
      cle.startsWith(PREFIXE_TIMING)
    );

    if (clesTimings.length === 0) {
      messageVide.style.display = "block";
      return;
    }

    messageVide.style.display = "none";

    clesTimings.forEach((cle) => {
      const timing = toutesLesDonnees[cle];
      const { nomSerie, episode } = decomposerCle(cle);
      const carte = creerCarteSerie(cle, nomSerie, episode, timing);
      conteneurListe.appendChild(carte);
    });
  });
}

/**
 * Découpe une clé "asi-timing::<serie>::<episode>" en ses parties.
 */
function decomposerCle(cle) {
  const sansPrefixe = cle.slice(PREFIXE_TIMING.length);
  const indexSeparateur = sansPrefixe.lastIndexOf("::");

  if (indexSeparateur === -1) {
    return { nomSerie: sansPrefixe, episode: null };
  }

  return {
    nomSerie: sansPrefixe.slice(0, indexSeparateur),
    episode: sansPrefixe.slice(indexSeparateur + 2),
  };
}

/**
 * Construit le DOM d'une carte pour une série+épisode donné : nom,
 * badge de provenance (AniSkip auto / manuel), champs "début" et
 * "fin" éditables, bouton sauvegarder et bouton supprimer.
 */
function creerCarteSerie(cle, nomSerie, episode, timing) {
  const carte = document.createElement("div");
  carte.className = "carte-serie";

  // --- Nom de la série + épisode ---
  const titre = document.createElement("div");
  titre.className = "nom-serie";
  const suffixeEpisode = episode && episode !== "?" ? ` — Ép. ${episode}` : "";
  titre.textContent = `${nomSerie}${suffixeEpisode}`;
  carte.appendChild(titre);

  // --- Badge de provenance (AniSkip auto vs marquage manuel) ---
  const badge = document.createElement("div");
  // AniSkip results are never persisted (see content.js), so anything
  // listed here is necessarily a manual override.
  badge.className = "badge-source";
  badge.textContent = "✋ Marquage manuel";
  carte.appendChild(badge);

  // --- Champ "début" ---
  const labelDebut = document.createElement("label");
  labelDebut.textContent = "Début de l'intro (secondes)";
  const inputDebut = document.createElement("input");
  inputDebut.type = "number";
  inputDebut.step = "0.1";
  inputDebut.value = timing?.debut ?? 0;
  labelDebut.appendChild(inputDebut);
  carte.appendChild(labelDebut);

  // --- Champ "fin" ---
  const labelFin = document.createElement("label");
  labelFin.textContent = "Fin de l'intro (secondes)";
  const inputFin = document.createElement("input");
  inputFin.type = "number";
  inputFin.step = "0.1";
  inputFin.value = timing?.fin ?? 0;
  labelFin.appendChild(inputFin);
  carte.appendChild(labelFin);

  // --- Boutons d'action ---
  const actions = document.createElement("div");
  actions.className = "actions-serie";

  const boutonSauvegarder = document.createElement("button");
  boutonSauvegarder.className = "bouton-sauvegarder";
  boutonSauvegarder.textContent = "💾 Sauvegarder";
  boutonSauvegarder.addEventListener("click", () => {
    // Une modification depuis le popup est traitée comme un override
    // manuel : elle ne sera plus jamais écrasée automatiquement par
    // une future résolution AniSkip pour cette même clé.
    const nouveauTiming = {
      debut: parseFloat(inputDebut.value) || 0,
      fin: parseFloat(inputFin.value) || 0,
      source: "manual",
    };

    chrome.storage.local.set({ [cle]: nouveauTiming }, () => {
      console.log(`[Anime Skip Intro] "${cle}" mis à jour :`, nouveauTiming);
      chargerEtAfficherListe(); // pour rafraîchir le badge de provenance
    });
  });

  const boutonSupprimer = document.createElement("button");
  boutonSupprimer.className = "bouton-supprimer";
  boutonSupprimer.textContent = "🗑 Supprimer";
  boutonSupprimer.addEventListener("click", () => {
    chrome.storage.local.remove(cle, () => {
      console.log(`[Anime Skip Intro] "${cle}" supprimé.`);
      chargerEtAfficherListe(); // on rafraîchit la liste après suppression
    });
  });

  actions.appendChild(boutonSauvegarder);
  actions.appendChild(boutonSupprimer);
  carte.appendChild(actions);

  return carte;
}
