"use strict";

// Ajout exclusivement côté Render test des paramètres météo au résultat
// ponctuel AROME ; n'altère pas l'interpolation de U/V/rafales.
const { inflateSync } = require("node:zlib");
const DECODE = new WeakMap();
const NO_DATA = -32768;

function interpolerChampMeteo(champ, lat, lon) {
    if (!champ || champ.encodage !== "zlib-base64-int16-v1" ||
        typeof champ.donnees !== "string") return null;

    const grille = champ.grille;
    const { Ni, Nj } = grille || {};
    if (!Number.isInteger(Ni) || !Number.isInteger(Nj) ||
        Ni < 2 || Nj < 2 || Ni * Nj > 200000 ||
        !Number.isFinite(grille.latitude_depart) ||
        !Number.isFinite(grille.longitude_depart) ||
        !Number.isFinite(grille.resolution_longitude) ||
        !Number.isFinite(grille.resolution_latitude) ||
        grille.resolution_latitude <= 0 || grille.resolution_longitude <= 0) {
        return null;
    }

    const x = (lon - grille.longitude_depart) / grille.resolution_longitude;
    const y = (grille.latitude_depart - lat) / grille.resolution_latitude;
    if (!Number.isFinite(x) || !Number.isFinite(y) ||
        x < 0 || y < 0 || x > Ni - 1 || y > Nj - 1) return null;

    let valeurs = DECODE.get(champ);
    if (!valeurs) {
        try {
            valeurs = inflateSync(Buffer.from(champ.donnees, "base64"), {
                maxOutputLength: Ni * Nj * 2
            });
            if (valeurs.length !== Ni * Nj * 2) return null;
            DECODE.set(champ, valeurs);
        } catch (_erreur) {
            // La météo est facultative : ne jamais interrompre la prévision du vent.
            return null;
        }
    }

    const i = Math.min(Math.floor(x), Ni - 2);
    const j = Math.min(Math.floor(y), Nj - 2);
    const indices = [
        j * Ni + i, j * Ni + i + 1,
        (j + 1) * Ni + i, (j + 1) * Ni + i + 1
    ];
    const v = indices.map(index => valeurs.readInt16LE(index * 2));
    if (v.some(val => val === NO_DATA)) return null;
    const tx = x - i;
    const ty = y - j;
    return ((v[0] * (1 - tx) + v[1] * tx) * (1 - ty) +
        (v[2] * (1 - tx) + v[3] * tx) * ty) / 10;
}

function ajouterMeteoAuxPrevisions(cache, resultat, lat, lon) {
    if (!cache?.meteo_version || !Array.isArray(resultat?.previsions)) {
        return resultat;
    }
    const parSeconde = new Map(cache.previsions.map(p => [p.seconde, p]));

    for (const point of resultat.previsions) {
        const heure = Number(point.echeance?.replace("H+", ""));
        if (!Number.isInteger(heure) || heure < 1 || heure > 51) continue;
        const prevision = parSeconde.get(heure * 3600);
        if (!prevision) continue;

        const temperature = interpolerChampMeteo(prevision.T2M_METEO, lat, lon);
        const nebulosite = interpolerChampMeteo(prevision.NEBUL_METEO, lat, lon);
        const total = interpolerChampMeteo(prevision.PRECIP_METEO, lat, lon);
        let pluie = null;

        if (total !== null) {
            const debut = prevision.PRECIP_METEO?.debut_cumul;
            if (debut === heure - 1) {
                pluie = total;
            } else if (debut === 0) {
                if (heure === 1) {
                    pluie = total;
                } else {
                    const precedent = parSeconde.get((heure - 1) * 3600);
                    if (precedent?.PRECIP_METEO?.debut_cumul === 0) {
                        const cumulPrecedent = interpolerChampMeteo(
                            precedent.PRECIP_METEO, lat, lon
                        );
                        if (cumulPrecedent !== null) {
                            pluie = total - cumulPrecedent;
                        }
                    }
                }
            }
        }

        point.temperature = temperature === null
            ? null : Number(temperature.toFixed(1));
        point.nebulosite = nebulosite === null
            ? null : Math.round(Math.max(0, Math.min(100, nebulosite)));
        // Ne pas convertir une accumulation inconnue en « pluie nulle ».
        point.precipitation = pluie === null || pluie < -0.15
            ? null : Number(Math.max(0, pluie).toFixed(1));
    }

    return resultat;
}

module.exports = { ajouterMeteoAuxPrevisions };