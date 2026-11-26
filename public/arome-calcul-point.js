"use strict";

function calculerPrevisionsAromeNavigateur(cache, latitude, longitude) {
    function interpoler(grille, valeurs, lat, lon) {
        const x =
            (lon - grille.longitude_depart) /
            grille.resolution_longitude;

        const y =
            (grille.latitude_depart - lat) /
            grille.resolution_latitude;

        if (
            x < 0 || y < 0 ||
            x > grille.Ni - 1 ||
            y > grille.Nj - 1
        ) {
            throw new Error("Point GPS hors de la grille AROME");
        }

        const i0 = Math.min(Math.floor(x), grille.Ni - 2);
        const j0 = Math.min(Math.floor(y), grille.Nj - 2);
        const tx = x - i0;
        const ty = y - j0;

        const v00 = valeurs[j0 * grille.Ni + i0];
        const v10 = valeurs[j0 * grille.Ni + i0 + 1];
        const v01 = valeurs[(j0 + 1) * grille.Ni + i0];
        const v11 = valeurs[(j0 + 1) * grille.Ni + i0 + 1];

        const haut = v00 * (1 - tx) + v10 * tx;
        const bas = v01 * (1 - tx) + v11 * tx;

        return haut * (1 - ty) + bas * ty;
    }

    const zone = cache.zone;

    if (
        latitude < zone.latMin ||
        latitude > zone.latMax ||
        longitude < zone.lonMin ||
        longitude > zone.lonMax
    ) {
        throw new Error(
            "Position hors de la zone du cache AROME"
        );
    }

    const dateModele = cache.modele.replace(
        /T(\d{2})\.(\d{2})\.(\d{2})Z$/,
        "T$1:$2:$3Z"
    );
    const dateInitialisation = new Date(dateModele);

    if (Number.isNaN(dateInitialisation.getTime())) {
        throw new Error("Date du modèle AROME invalide");
    }

    const previsions = [];
    const erreurs = [];

    for (let h = 1; h <= 51; h++) {
        const seconde = h * 3600;
        const donnees = cache.previsions.find(p => p.seconde === seconde);

        if (!donnees || !donnees.U || !donnees.V) {
            continue;
        }

        const echeance = "H+" + h;
        try {
            const u = interpoler(
                donnees.U.grille,
                donnees.U.valeurs,
                latitude,
                longitude
            );
            const v = interpoler(
                donnees.V.grille,
                donnees.V.valeurs,
                latitude,
                longitude
            );
            const vitesse = Math.sqrt(u * u + v * v);
            let rafale = null;

            if (donnees.RAFALE) {
                rafale = interpoler(
                    donnees.RAFALE.grille,
                    donnees.RAFALE.valeurs,
                    latitude,
                    longitude
                );
            }

            const direction = (
                Math.atan2(-u, -v) * 180 / Math.PI + 360
            ) % 360;
            const dateValide = new Date(
                dateInitialisation.getTime() + seconde * 1000
            );

            previsions.push({
                echeance,
                date: dateValide.toISOString(),
                vitesse: Number(vitesse.toFixed(2)),
                rafale: Number.isFinite(rafale)
                    ? Number(rafale.toFixed(2))
                    : null,
                direction: Number(direction.toFixed(1)),
                composante_U: Number(u.toFixed(3)),
                composante_V: Number(v.toFixed(3))
            });
        } catch (erreur) {
            erreurs.push({
                echeance,
                erreur: erreur.message
            });
        }
    }

    const erreursCache = Array.isArray(cache.erreurs)
        ? cache.erreurs
        : [];

    if (previsions.length === 0) {
        throw new Error("Aucune prévision exploitable dans le cache AROME");
    }

    return {
        succes: true,
        coordonnees: {
            latitude,
            longitude
        },
        modele: cache.modele,
        hauteur: "10 m",
        nombre_echeances: previsions.length,
        nombre_erreurs: erreursCache.length + erreurs.length,
        methode: "Interpolation bilinéaire locale des composantes U/V",
        cache: true,
        origine_cache: cache.origine_cache || "GitHub Pages",
        actualisation_en_cours: false,
        actualisation_statut: "non applicable",
        previsions,
        erreurs: [...erreursCache, ...erreurs]
    };
}

const NO_DATA = -32768;

function interpolerChampMeteo(champ, lat, lon, lireValeurs) {
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

    const valeurs = lireValeurs(champ);
    if (!valeurs) return null;

    const i = Math.min(Math.floor(x), Ni - 2);
    const j = Math.min(Math.floor(y), Nj - 2);
    const indices = [
        j * Ni + i, j * Ni + i + 1,
        (j + 1) * Ni + i, (j + 1) * Ni + i + 1
    ];
    const v = indices.map(index => valeurs.getInt16(index * 2, true));
    if (v.some(val => val === NO_DATA)) return null;
    const tx = x - i;
    const ty = y - j;
    return ((v[0] * (1 - tx) + v[1] * tx) * (1 - ty) +
        (v[2] * (1 - tx) + v[3] * tx) * ty) / 10;
}

function ajouterChampsMeteo(cache, resultat, lat, lon, lireValeurs) {
    if (!cache?.meteo_version || !Array.isArray(resultat?.previsions)) {
        return resultat;
    }
    const parSeconde = new Map(cache.previsions.map(p => [p.seconde, p]));

    for (const point of resultat.previsions) {
        const heure = Number(point.echeance?.replace("H+", ""));
        if (!Number.isInteger(heure) || heure < 1 || heure > 51) continue;
        const prevision = parSeconde.get(heure * 3600);
        if (!prevision) continue;

        const temperature = interpolerChampMeteo(prevision.T2M_METEO, lat, lon, lireValeurs);
        const nebulosite = interpolerChampMeteo(prevision.NEBUL_METEO, lat, lon, lireValeurs);
        const total = interpolerChampMeteo(prevision.PRECIP_METEO, lat, lon, lireValeurs);
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
                            precedent.PRECIP_METEO, lat, lon, lireValeurs
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

if (typeof module !== "undefined" && module.exports) {
    module.exports = { ajouterChampsMeteo, calculerPrevisionsAromeNavigateur };
}
