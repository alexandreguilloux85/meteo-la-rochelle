"use strict";

(() => {
    const hotesTest = ["station-meteo-lr-test.onrender.com", "localhost", "127.0.0.1", "[::1]"];
    const hotesPublics = ["alexandreguilloux85.github.io", "station-meteo-lr.onrender.com"];
    const hote = window.location.hostname;
    const apiLocale = hotesTest.includes(hote);
    const section = document.getElementById("arome-pi");
    if (!section || (!apiLocale && !hotesPublics.includes(hote))) return;

    const statut = document.getElementById("arome-pi-statut");
    const modele = document.getElementById("arome-pi-modele");
    const tableau = document.getElementById("arome-pi-tableau");
    const intervalleNormal = 5 * 60 * 1000;
    const intervallePendantCalcul = 30 * 1000;
    const pasSecondes = 15 * 60;
    const nombreEcheances = 24;
    const horizonSecondes = nombreEcheances * pasSecondes;
    const urlCachePages = "https://alexandreguilloux85.github.io/meteo-la-rochelle/arome-pi-cache.json.gz";
    const zone = { latMin: 46.075, latMax: 46.300, lonMin: -1.600, lonMax: -1.050 };
    const instantParis = new Intl.DateTimeFormat("fr-FR", {
        timeZone: "Europe/Paris", day: "2-digit", month: "2-digit",
        hour: "2-digit", minute: "2-digit", timeZoneName: "short"
    });

    let selection = null;
    let minuteurRequete;
    let minuteurExpiration;
    let message = "Chargement des prévisions immédiates…";
    let previsionsAffichees = [];
    let cachePages;
    let chargementCachePages;
    let prochaineLecturePages = 0;

    function cacheDisponible(cache) {
        const cycle = Date.parse(cache?.modele);
        const maintenant = Date.now();
        return cycle <= maintenant && cycle + horizonSecondes * 1000 > maintenant;
    }

    async function lireCachePages(relire) {
        if (!relire && cacheDisponible(cachePages) && Date.now() < prochaineLecturePages) {
            return cachePages;
        }
        if (!chargementCachePages) {
            const controleur = new AbortController();
            const limite = setTimeout(() => controleur.abort(), 12000);
            chargementCachePages = (async () => {
                const reponse = await fetch(urlCachePages, {
                    cache: "no-cache", signal: controleur.signal
                });
                if (!reponse.ok) throw new Error("Cache AROME-PI indisponible.");
                const octets = new Uint8Array(await reponse.arrayBuffer());
                const gzip = octets[0] === 0x1f && octets[1] === 0x8b;
                if (octets.length > (gzip ? 512 : 1024) * 1024) {
                    throw new Error("Cache AROME-PI trop volumineux.");
                }
                const contenu = gzip
                    ? new Blob([octets]).stream().pipeThrough(new DecompressionStream("gzip"))
                    : octets;
                const cache = await new Response(contenu).json();
                if (!cacheDisponible(cache) ||
                    !Object.entries(zone).every(([cle, valeur]) => cache.zone?.[cle] === valeur) ||
                    !Array.isArray(cache.previsions) || cache.previsions.length !== nombreEcheances ||
                    !cache.previsions.every((p, i) => p?.seconde === (i + 1) * pasSecondes &&
                        p.U && p.V && p.RAFALE)) {
                    throw new Error("Cache AROME-PI invalide ou expiré.");
                }
                if (!cachePages || Date.parse(cache.modele) >= Date.parse(cachePages.modele)) {
                    cachePages = cache;
                }
                prochaineLecturePages = Date.now() + intervalleNormal;
                return cachePages;
            })().catch(erreur => {
                if (!cacheDisponible(cachePages)) throw erreur;
                prochaineLecturePages = Date.now() + intervallePendantCalcul;
                return cachePages;
            }).finally(() => {
                clearTimeout(limite);
                chargementCachePages = null;
            });
        }
        return chargementCachePages;
    }

    async function lirePrevisionsPages({ lat, lon }, relire) {
        if (lat < zone.latMin || lat > zone.latMax || lon < zone.lonMin || lon > zone.lonMax) {
            return { hors_zone: true };
        }
        const cache = await lireCachePages(relire);
        const { previsions } = calculerPrevisionsAromeNavigateur(cache, lat, lon, {
            pasSecondes, horizonSecondes
        });
        if (previsions.length !== nombreEcheances || previsions.some(p =>
            !Number.isFinite(p.vitesse) || !Number.isFinite(p.direction) ||
            !Number.isFinite(p.rafale) || p.rafale < 0)) {
            throw new Error("Prévisions AROME-PI incomplètes.");
        }
        return {
            succes: true,
            modele: cache.modele,
            previsions: previsions.map(p => ({
                ...p, direction: p.vitesse === 0 ? null : p.direction % 360
            }))
        };
    }

    async function lirePrevisionsApi({ lat, lon }, controleur) {
        const limite = setTimeout(() => controleur.abort(), 12000);
        try {
            const parametres = new URLSearchParams({ lat, lon });
            const reponse = await fetch("/api/arome/pi/vent?" + parametres, {
                cache: "no-store", signal: controleur.signal
            });
            const resultat = await reponse.json();
            return {
                ...resultat,
                succes: reponse.ok && resultat.succes,
                actualisation_en_cours: reponse.status === 202 || resultat.actualisation_en_cours
            };
        } finally {
            clearTimeout(limite);
        }
    }

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
        const relire = point.relire;
        point.relire = false;
        let delaiRequete = intervalleNormal;
        let nouvellesPrevisions;
        try {
            const resultat = apiLocale
                ? await lirePrevisionsApi(point, controleur)
                : await lirePrevisionsPages(point, relire);
            if (selection !== point) return;
            if (resultat.hors_zone) {
                point.horsZone = true;
                viderTableau("Hors de la zone AROME Prévision Immédiate.");
                return;
            }

            const calculEnCours = resultat.actualisation_en_cours;
            if (calculEnCours) delaiRequete = intervallePendantCalcul;
            const heureCycle = Date.parse(resultat.modele);
            if (resultat.succes && Number.isFinite(heureCycle) &&
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
            point.requete = null;
            if (selection === point) {
                point.prochaineRequete = point.relire ? 0 : Date.now() + delaiRequete;
                mettreAJourAffichage(nouvellesPrevisions);
                planifierActualisation();
            }
        }
    }

    function selectionnerPoint(lat, lon, { relire = false } = {}) {
        if (selection?.lat === lat && selection?.lon === lon) {
            if (relire) {
                selection.relire = true;
                selection.prochaineRequete = 0;
                planifierActualisation();
            }
            return;
        }
        selection?.requete?.abort();
        selection = { lat, lon, relire, prochaineRequete: 0, requete: null, horsZone: false };
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
