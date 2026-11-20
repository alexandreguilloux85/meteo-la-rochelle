"use strict";

// Frise indépendante du calcul et du cache AROME.
// Les champs optionnels temperature (°C), nebulosite (%) et precipitation
// (mm/h) ne sont PAS inventés : si absents, la météo affiche « -- ».
(function () {
    function nombreOuNull(valeur) {
        if (valeur === null || valeur === undefined || valeur === "") return null;
        const v = Number(valeur);
        return Number.isFinite(v) ? v : null;
    }

    function etatDuCiel(prevision) {
        const precip = nombreOuNull(prevision.precipitation);
        const nuages = nombreOuNull(prevision.nebulosite);
        if (precip !== null && precip >= 0.2) return "pluie";
        if (precip === null || nuages === null) return null;
        if (nuages < 25) return "clair";
        if (nuages < 65) return "eclaircies";
        return "couvert";
    }

    // Hauteur astronomique du Soleil au point demandé ; -0,833° = horizon
    // apparent corrigé pour la réfraction atmosphérique et le disque solaire.
    function estJour(date, latDeg, lonDeg) {
        if (!Number.isFinite(date.getTime()) ||
            !Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return true;
        const rad = Math.PI / 180;
        const n = date.getTime() / 86400000 + 2440587.5 - 2451545;
        const m = (357.5291 + 0.98560028 * n) * rad;
        const l = (280.459 + 0.98564736 * n) * rad +
            (1.915 * Math.sin(m) + 0.020 * Math.sin(2 * m)) * rad;
        const ob = (23.439 - 0.00000036 * n) * rad;
        const asc = Math.atan2(Math.cos(ob) * Math.sin(l), Math.cos(l));
        const dec = Math.asin(Math.sin(ob) * Math.sin(l));
        const sideral = (280.46061837 + 360.98564736629 * n) * rad;
        const angle = sideral + lonDeg * rad - asc;
        const lat = latDeg * rad;
        const hauteur = Math.asin(Math.sin(lat) * Math.sin(dec) +
            Math.cos(lat) * Math.cos(dec) * Math.cos(angle));
        return hauteur >= -0.833 * rad;
    }

    function iconeMeteo(typ, jour) {
        if (!typ) return '<span class="frise-icone-vide" title="Ciel indisponible">—</span>';

        const labels = {
            clair: jour ? "Soleil" : "Nuit claire",
            eclaircies: jour ? "Éclaircies" : "Éclaircies nocturnes",
            couvert: "Ciel couvert",
            pluie: "Pluie"
        };
        const astre = jour
            ? '<g stroke="#E8A120" stroke-width="1.6" stroke-linecap="round" fill="none">' +
              '<circle cx="13" cy="12" r="5.2" fill="#FFCC48"/>' +
              '<path d="M13 1v4 M13 19v4 M2 12h4 M20 12h4 M5.2 4.2l3 3 M18 18l3 3 M20.8 4.2l-3 3 M8 18l-3 3"/>' +
              '</g>'
            : '<path d="M18 2a10 10 0 1 0 10 16.5A10 10 0 0 1 18 2Z" fill="#B4CBE9" stroke="#7896C3" stroke-width="1"/>';
        const nuage = '<path d="M9 30h19c5.7 0 8-3.9 7.6-7.6-.3-3.1-2.5-5.3-5.6-5.6-.9-4.7-5-7.3-9.1-6.1-3.3.9-5.5 3.1-6.2 6.5-5.2-1.4-9.8 2.2-9.8 6.7C4.9 27.5 6.4 30 9 30Z" fill="#DCE5EE" stroke="#879BAF" stroke-width="1.5" stroke-linejoin="round"/>';
        const pluie = '<g stroke="#238ED2" stroke-width="2.3" stroke-linecap="round">' +
            '<path d="M12 33l-2 4 M21 33l-2 4 M30 33l-2 4"/></g>';

        let forme;
        if (typ === "clair") forme = '<g transform="translate(7 7)">' + astre + '</g>';
        else if (typ === "eclaircies") {
            forme = '<g transform="translate(1 0)">' + astre + '</g>' + nuage;
        } else if (typ === "pluie") forme = nuage + pluie;
        else forme = nuage;

        return '<svg class="frise-icone" viewBox="0 0 42 42" width="32" height="32" role="img" aria-label="' +
            labels[typ] + '" title="' + labels[typ] + '" xmlns="http://www.w3.org/2000/svg">' +
            forme + '</svg>';
    }

    function couleurNoeuds(kt) {
        return Number.isFinite(kt) && typeof window.couleurVentWindy === "function"
            ? window.couleurVentWindy(kt) : null;
    }

    function couleurCellule(liste, index) {
        const valeur = liste[index];
        const milieu = couleurNoeuds(valeur);
        if (!milieu) return "background-color:#E8EDF3";
        const avant = Number.isFinite(liste[index - 1])
            ? couleurNoeuds((liste[index - 1] + valeur) / 2) : milieu;
        const apres = Number.isFinite(liste[index + 1])
            ? couleurNoeuds((liste[index + 1] + valeur) / 2) : milieu;
        return "background:linear-gradient(to right," + avant + "," +
            milieu + "," + apres + ")";
    }

    function afficherFriseMeteoArome(previsions, lat, lon) {
        const conteneur = document.getElementById("frise-meteo");
        const note = document.getElementById("frise-meteo-note");
        if (!conteneur || !Array.isArray(previsions) || !previsions.length) return;

        const donnees = previsions.map(p => {
            const date = new Date(p.date);
            const vitesse = nombreOuNull(p.vitesse);
            const rafale = nombreOuNull(p.rafale);
            return {
                date,
                dateJour: date.toLocaleDateString("fr-FR", {
                    timeZone: "Europe/Paris", weekday: "short",
                    day: "2-digit", month: "2-digit"
                }),
                cleJour: date.toLocaleDateString("en-CA", {
                    timeZone: "Europe/Paris", year: "numeric",
                    month: "2-digit", day: "2-digit"
                }),
                heure: date.toLocaleTimeString("fr-FR", {
                    timeZone: "Europe/Paris", hour: "2-digit", hourCycle: "h23"
                }).match(/\d{1,2}/)?.[0].padStart(2, "0") + "h",
                ciel: etatDuCiel(p),
                temperature: nombreOuNull(p.temperature),
                precipitation: nombreOuNull(p.precipitation),
                vent: vitesse === null ? null : vitesse * 1.94384,
                rafale: rafale === null ? null : rafale * 1.94384,
                direction: nombreOuNull(p.direction)
            };
        });

        const groupes = [];
        donnees.forEach((d, i) => {
            if (!groupes.length || groupes[groupes.length - 1].cle !== d.cleJour) {
                groupes.push({ cle: d.cleJour, jour: d.dateJour, nombre: 0, debut: i });
            }
            groupes[groupes.length - 1].nombre++;
        });
        const separateurs = new Set(groupes.slice(1).map(g => g.debut));
        const col = (valeur, index, style, classe) =>
            '<td class="' + (classe || "") +
            (separateurs.has(index) ? ' frise-separateur' : '') +
            '"' + (style ? ' style="' + style + '"' : '') + '>' + valeur + '</td>';
        let html = '<table class="table-frise"><thead><tr><th rowspan="2" class="frise-libelle">Prévisions</th>';
        groupes.forEach((g, i) => {
            html += '<th colspan="' + g.nombre + '"' +
                (i ? ' class="frise-separateur"' : '') + '>' + g.jour + '</th>';
        });
        html += '</tr><tr>';
        donnees.forEach((d, i) => {
            html += '<th' + (separateurs.has(i) ? ' class="frise-separateur"' : '') +
                '>' + d.heure + '</th>';
        });
        html += '</tr></thead><tbody>';

        const ligne = (label, valeurs, classe) => {
            html += '<tr><th scope="row" class="frise-libelle">' + label + '</th>';
            valeurs.forEach((v, i) => {
                html += col(v.contenu, i, v.style || "", classe || "");
            });
            html += '</tr>';
        };
        const affichage = (v, decimales = 0) =>
            v === null ? "—" : v.toFixed(decimales);

        ligne("Ciel", donnees.map(d => ({
            contenu: iconeMeteo(d.ciel, estJour(d.date, lat, lon))
        })), "frise-cellule-icone");
        ligne("Temp. (°C)", donnees.map(d => ({
            contenu: affichage(d.temperature)
        })));
        ligne("Pluie (mm/h)", donnees.map(d => ({
            contenu: affichage(d.precipitation, 1)
        })));

        for (const [titre, champ] of [["Vent (kt)", "vent"], ["Rafales (kt)", "rafale"]]) {
            const valeurs = donnees.map(d => d[champ]);
            ligne(titre, donnees.map((d, i) => ({
                contenu: affichage(d[champ]),
                style: couleurCellule(valeurs, i)
            })), "frise-cellule-vent");
        }
        ligne("Direction", donnees.map(d => ({
            contenu: d.direction === null ? "—" :
                '<span class="frise-fleche" style="transform:rotate(' +
                (d.direction + 180) + 'deg)">' +
                '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">' +
                '<path d="M12 21V4 M6 10l6-6 6 6" fill="none" stroke="currentColor" ' +
                'stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"/>' +
                '</svg></span>' +
                '<span class="frise-degres">' + d.direction.toFixed(0) + '°</span>'
        })));
        html += '</tbody></table>';
        conteneur.innerHTML = html;

        const champsComplets = donnees.every(d =>
            d.temperature !== null && d.precipitation !== null && d.ciel !== null
        );
        if (note) {
            note.textContent = champsComplets
                ? "Icônes calculées à partir des précipitations et de la nébulosité AROME."
                : "Température, pluie et ciel non disponibles dans le cache AROME actuel. " +
                  "Les vents restent affichés ; aucune météo n'est inventée.";
        }
    }

    window.afficherFriseMeteoArome = afficherFriseMeteoArome;
})();