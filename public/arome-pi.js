"use strict";

(() => {
    const hotesTest = ["station-meteo-lr-test.onrender.com", "localhost", "127.0.0.1", "[::1]"];
    const section = document.getElementById("arome-pi");
    if (!section || !hotesTest.includes(window.location.hostname)) return;

    const statut = document.getElementById("arome-pi-statut");
    const modele = document.getElementById("arome-pi-modele");
    const tableau = document.getElementById("arome-pi-tableau");
    const intervalleNormal = 5 * 60 * 1000;
    const intervallePendantCalcul = 30 * 1000;
    const instantParis = new Intl.DateTimeFormat("fr-FR", {
        timeZone: "Europe/Paris", day: "2-digit", month: "2-digit",
        hour: "2-digit", minute: "2-digit", timeZoneName: "short"
    });

    let selection = null;
    let minuteurRequete;
    let minuteurExpiration;
    let message = "Chargement des prévisions immédiates…";
    let previsionsAffichees = [];

    function mettreAJourAffichage(nouvellesPrevisions) {
        clearTimeout(minuteurExpiration);
        const maintenant = Date.now();
        const futures = (nouvellesPrevisions ?? previsionsAffichees)
            .filter(p => p.validite >= maintenant);
        if (nouvellesPrevisions || futures.length !== previsionsAffichees.length) {
            previsionsAffichees = futures;
            if (futures.length) window.afficherFriseVentArome(tableau, futures);
            else tableau.replaceChildren();
        }
        const prochaine = futures[0];
        tableau.hidden = !prochaine;
        if (prochaine) {
            minuteurExpiration = setTimeout(
                mettreAJourAffichage, prochaine.validite - maintenant + 1
            );
        }
        const texte = message || (prochaine ? "" : "Aucune échéance future disponible.");
        if (statut.textContent !== texte) statut.textContent = texte;
        statut.hidden = texte === "";
    }

    function viderTableau(nouveauMessage) {
        modele.hidden = true;
        message = nouveauMessage;
        mettreAJourAffichage([]);
    }

    function planifierActualisation() {
        clearTimeout(minuteurRequete);
        if (document.hidden || !selection || selection.horsZone || selection.requete) return;
        minuteurRequete = setTimeout(actualiser, Math.max(0, selection.prochaineRequete - Date.now()));
    }

    async function actualiser() {
        const point = selection;
        if (document.hidden || !point || point.requete) return;

        const controleur = new AbortController();
        point.requete = controleur;
        const limite = setTimeout(() => controleur.abort(), 12000);
        const parametres = new URLSearchParams({ lat: point.lat, lon: point.lon });
        let delaiRequete = intervalleNormal;
        let nouvellesPrevisions;
        try {
            const reponse = await fetch("/api/arome/pi/vent?" + parametres, {
                cache: "no-store",
                signal: controleur.signal
            });
            const resultat = await reponse.json();
            if (selection !== point) return;
            if (resultat.hors_zone) {
                point.horsZone = true;
                viderTableau("Hors de la zone AROME Prévision Immédiate.");
                return;
            }

            const calculEnCours = reponse.status === 202 || resultat.actualisation_en_cours;
            if (calculEnCours) delaiRequete = intervallePendantCalcul;
            const heureCycle = Date.parse(resultat.modele);
            if (reponse.ok && resultat.succes && Number.isFinite(heureCycle) &&
                Array.isArray(resultat.previsions)) {
                nouvellesPrevisions = resultat.previsions
                    .map(p => ({ ...p, validite: Date.parse(p.date) }))
                    .sort((a, b) => a.validite - b.validite);
                modele.textContent = "Cycle du " + instantParis.format(heureCycle);
                modele.hidden = false;
                message = calculEnCours
                    ? "Nouveau cycle en cours de chargement."
                    : resultat.actualisation_retardee ? "Le dernier cycle disponible est affiché." : "";
            } else {
                message = calculEnCours
                    ? "Les prévisions immédiates sont en cours de calcul."
                    : "Prévisions immédiates indisponibles pour le moment.";
            }
        } catch {
            if (selection === point) message = "Prévisions immédiates indisponibles pour le moment.";
        } finally {
            clearTimeout(limite);
            point.requete = null;
            if (selection === point) {
                point.prochaineRequete = Date.now() + delaiRequete;
                mettreAJourAffichage(nouvellesPrevisions);
                planifierActualisation();
            }
        }
    }

    function selectionnerPoint(lat, lon, { relire = false } = {}) {
        if (selection?.lat === lat && selection?.lon === lon) {
            if (relire) {
                selection.prochaineRequete = 0;
                planifierActualisation();
            }
            return;
        }
        selection?.requete?.abort();
        selection = { lat, lon, prochaineRequete: 0, requete: null, horsZone: false };
        viderTableau("Chargement des prévisions immédiates…");
        planifierActualisation();
    }

    section.hidden = false;
    window.selectionnerPointAromePi = selectionnerPoint;
    document.addEventListener("visibilitychange", () => {
        mettreAJourAffichage();
        planifierActualisation();
    });
})();
