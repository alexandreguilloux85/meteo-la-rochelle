"use strict";

(() => {
    const hotesTest = ["station-meteo-lr-test.onrender.com", "localhost", "127.0.0.1", "[::1]"];
    const section = document.getElementById("arome-pi");
    if (!section || !hotesTest.includes(window.location.hostname)) return;

    const statut = document.getElementById("arome-pi-statut");
    const modele = document.getElementById("arome-pi-modele");
    const tableau = document.getElementById("arome-pi-tableau");
    const corps = tableau.querySelector("tbody");
    const intervalleNormal = 5 * 60 * 1000;
    const intervallePendantCalcul = 30 * 1000;
    const optionsParis = { timeZone: "Europe/Paris" };
    const heureParis = new Intl.DateTimeFormat("fr-FR", {
        ...optionsParis, hour: "2-digit", minute: "2-digit"
    });
    const jourParis = new Intl.DateTimeFormat("fr-FR", {
        ...optionsParis, day: "2-digit", month: "2-digit"
    });
    const instantParis = new Intl.DateTimeFormat("fr-FR", {
        ...optionsParis, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
        timeZoneName: "short"
    });

    let selection = null;
    let minuteurRequete;
    let minuteurExpiration;
    let message = "Chargement des prévisions immédiates…";

    function element(balise, texte, classe) {
        const noeud = document.createElement(balise);
        if (texte) noeud.textContent = texte;
        if (classe) noeud.className = classe;
        return noeud;
    }

    function valeurEnNoeuds(vitesse, libelle) {
        const noeuds = Number.isFinite(vitesse) ? vitesse * 1.94384 : null;
        const valeur = noeuds === null ? "—" : Math.round(noeuds).toString();
        const noeud = element("span", valeur, "arome-pi-vitesse");
        noeud.title = libelle + (noeuds === null ? " indisponible" : " " + valeur + " kt");
        noeud.style.backgroundColor = window.couleurVentWindy?.(noeuds) || "";
        return noeud;
    }

    function celluleVent(vitesse, libelle) {
        const cellule = element("td");
        cellule.append(valeurEnNoeuds(vitesse, libelle));
        return cellule;
    }

    function afficher(resultat, heureCycle) {
        const maintenant = Date.now();
        const previsions = resultat.previsions
            .map(p => ({ ...p, validite: Date.parse(p.date) }))
            .filter(p => p.validite >= maintenant)
            .sort((a, b) => a.validite - b.validite);
        const fragment = document.createDocumentFragment();
        for (const { validite, date, vitesse, rafale, direction } of previsions) {
            const ligne = element("tr");
            ligne.dataset.validite = validite;
            const cellule = element("th");
            cellule.scope = "row";
            const heure = element("time", heureParis.format(validite));
            heure.dateTime = date;
            heure.title = instantParis.format(validite);
            heure.append(element("span", jourParis.format(validite), "arome-pi-detail"));
            cellule.append(heure);
            const directionTexte = Number.isFinite(direction)
                ? [window.directionTexte?.(direction), Math.round(direction) % 360 + "°"].filter(Boolean).join(" ")
                : "—";
            ligne.append(
                cellule,
                celluleVent(vitesse, "Vent moyen"),
                celluleVent(rafale, "Rafales"),
                element("td", directionTexte)
            );
            fragment.append(ligne);
        }
        corps.replaceChildren(fragment);
        modele.textContent = "Cycle du " + instantParis.format(heureCycle);
        modele.hidden = false;
    }

    function mettreAJourAffichage() {
        clearTimeout(minuteurExpiration);
        const maintenant = Date.now();
        for (const ligne of [...corps.rows]) {
            if (Number(ligne.dataset.validite) < maintenant) ligne.remove();
        }
        const prochaine = corps.rows[0];
        tableau.hidden = !prochaine;
        if (prochaine) {
            minuteurExpiration = setTimeout(
                mettreAJourAffichage, Number(prochaine.dataset.validite) - maintenant + 1
            );
        }
        const texte = message || (prochaine ? "" : "Aucune échéance future disponible.");
        if (statut.textContent !== texte) statut.textContent = texte;
        statut.hidden = texte === "";
    }

    function viderTableau(nouveauMessage) {
        corps.replaceChildren();
        modele.hidden = true;
        message = nouveauMessage;
        mettreAJourAffichage();
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
                afficher(resultat, heureCycle);
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
                mettreAJourAffichage();
                planifierActualisation();
            }
        }
    }

    function selectionnerPoint(lat, lon) {
        if (selection?.lat === lat && selection?.lon === lon) return;
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
