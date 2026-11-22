"use strict";

const { decoderGrib } = require("./arome-grib2");
const { essayerDemarrer } = require("./traitement-lourd");

const WCS = "https://public-api.meteofrance.fr/public/aromepi/1.0/wcs/" +
    "MF-NWP-HIGHRES-AROMEPI-0025-FRANCE-WCS";
const HEURE_MS = 60 * 60 * 1000;
const DELAI_PUBLICATION_MS = 35 * 60 * 1000;
const DELAI_REESSAI_MS = 4 * 60 * 1000;
const ECHEANCES = [1, 2, 3, 4, 5, 6];
const ZONE = { latMin: 46.075, latMax: 46.300, lonMin: -1.600, lonMax: -1.050 };
const MAILLE = 0.025;
const NIVEAU = "__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___";
const COUVERTURES = {
    U: "U_COMPONENT_OF_WIND" + NIVEAU,
    V: "V_COMPONENT_OF_WIND" + NIVEAU,
    RAFALE: "WIND_SPEED_GUST" + NIVEAU
};

function choisirCycle(xml, modeleAttendu, modeleEnCache, maintenant) {
    const ids = new Set(Array.from(
        xml.matchAll(/<(?:[\w-]+:)?CoverageId>\s*([^<]+?)\s*<\/(?:[\w-]+:)?CoverageId>/g),
        match => match[1]
    ));

    for (let heure = modeleAttendu; heure > modeleEnCache &&
        heure + ECHEANCES.length * HEURE_MS > maintenant; heure -= HEURE_MS) {
        const modele = new Date(heure).toISOString().replace(".000Z", "Z");
        const suffixe = modele.replaceAll(":", ".");
        const U = COUVERTURES.U + suffixe;
        const V = COUVERTURES.V + suffixe;
        const rafale = COUVERTURES.RAFALE + suffixe;
        const RAFALE = ids.has(rafale + "_PT1H") ? rafale + "_PT1H" : rafale;
        if (ids.has(U) && ids.has(V) && ids.has(RAFALE)) {
            return { modele, couvertures: { U, V, RAFALE } };
        }
    }
    return null;
}

function couvreZone(grille) {
    const nord = grille.latitude_depart;
    const ouest = grille.longitude_depart;
    const sud = nord - (grille.Nj - 1) * grille.resolution_latitude;
    const est = ouest + (grille.Ni - 1) * grille.resolution_longitude;
    return grille.resolution_latitude === MAILLE && grille.resolution_longitude === MAILLE &&
        sud < ZONE.latMin && nord > ZONE.latMax && ouest < ZONE.lonMin && est > ZONE.lonMax;
}

function installerAromePiVent(app, { apiKey, calculerPrevisionsArome }) {
    let cache = null;
    let actualisationEnCours = false;
    let prochainEssai = 0;
    let erreurActualisation = null;

    async function lireWcs(operation, parametres, signal) {
        const url = new URL(WCS + "/" + operation);
        url.searchParams.set("service", "WCS");
        url.searchParams.set("version", "2.0.1");
        for (const [nom, valeur] of parametres) url.searchParams.append(nom, valeur);
        const reponse = await fetch(url, { headers: { apikey: apiKey }, signal });
        if (!reponse.ok) {
            if (reponse.status === 401 || (operation === "GetCapabilities" && reponse.status === 403)) {
                throw new Error("La clé API du serveur doit être autorisée pour AROME Prévision Immédiate.");
            }
            throw new Error(`Météo-France ${operation} : HTTP ${reponse.status}.`);
        }
        return reponse;
    }

    async function chargerCycle(modeleAttendu, maintenant) {
        const signal = AbortSignal.timeout(45_000);
        const catalogue = await lireWcs("GetCapabilities", [["language", "fre"]], signal);
        const cycle = choisirCycle(await catalogue.text(), modeleAttendu,
            cache ? Date.parse(cache.modele) : 0, maintenant);
        if (!cycle) throw new Error("Le dernier cycle AROME-PI est en attente de publication.");

        const dateModele = Date.parse(cycle.modele);
        const previsions = [];
        for (const heure of ECHEANCES) {
            const date = new Date(dateModele + heure * HEURE_MS).toISOString().replace(".000Z", "Z");
            const champs = { seconde: heure * 3600 };
            for (const [champ, couverture] of Object.entries(cycle.couvertures)) {
                const reponse = await lireWcs("GetCoverage", [
                    ["coverageid", couverture],
                    ["subset", `time(${date})`],
                    ["subset", "height(10)"],
                    ["subset", `lat(${(ZONE.latMin - MAILLE).toFixed(3)},${(ZONE.latMax + MAILLE).toFixed(3)})`],
                    ["subset", `long(${(ZONE.lonMin - MAILLE).toFixed(3)},${(ZONE.lonMax + MAILLE).toFixed(3)})`],
                    ["format", "application/wmo-grib"]
                ], signal);
                const buffer = Buffer.from(await reponse.arrayBuffer());
                if (buffer.length > 512 * 1024) throw new Error("Champ AROME-PI trop volumineux pour la zone.");
                const donnees = decoderGrib(buffer);
                if (!couvreZone(donnees.grille) || !donnees.valeurs.every(Number.isFinite)) {
                    throw new Error("Grille AROME-PI incomplète pour la zone.");
                }
                champs[champ] = donnees;
            }
            previsions.push(champs);
        }

        return { modele: cycle.modele, previsions };
    }

    function verifierCycle() {
        const maintenant = Date.now();
        const modeleAttendu = Math.floor((maintenant - DELAI_PUBLICATION_MS) / HEURE_MS) * HEURE_MS;
        if (!apiKey || actualisationEnCours || maintenant < prochainEssai ||
            (cache && Date.parse(cache.modele) >= modeleAttendu)) return modeleAttendu;

        const liberer = essayerDemarrer("arome-pi-vent");
        if (!liberer) return modeleAttendu;

        actualisationEnCours = true;
        void chargerCycle(modeleAttendu, maintenant).then(resultat => {
            cache = resultat;
            erreurActualisation = null;
        }).catch(erreur => {
            erreurActualisation = erreur.message;
            console.warn("Actualisation du vent AROME-PI :", erreur.message);
        }).finally(() => {
            prochainEssai = Date.now() + DELAI_REESSAI_MS;
            actualisationEnCours = false;
            liberer();
        });
        return modeleAttendu;
    }

    app.get("/api/arome/pi/vent", (req, res) => {
        res.set("Cache-Control", "no-store");
        const { lat: latitude, lon: longitude } = req.query;
        const lat = typeof latitude === "string" && latitude.trim() ? Number(latitude) : NaN;
        const lon = typeof longitude === "string" && longitude.trim() ? Number(longitude) : NaN;
        if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) {
            return res.status(400).json({ succes: false, erreur: "Coordonnées GPS invalides." });
        }
        if (lat < ZONE.latMin || lat > ZONE.latMax || lon < ZONE.lonMin || lon > ZONE.lonMax) {
            return res.json({ succes: true, hors_zone: true, previsions: [] });
        }

        const modeleAttendu = verifierCycle();
        if (cache && Date.parse(cache.modele) + ECHEANCES.length * HEURE_MS > Date.now()) {
            const resultat = calculerPrevisionsArome(cache, lat, lon);
            if (resultat.previsions.length !== ECHEANCES.length || resultat.previsions.some(p =>
                !Number.isFinite(p.vitesse) || !Number.isFinite(p.direction) ||
                !Number.isFinite(p.rafale) || p.rafale < 0)) {
                return res.status(502).json({ succes: false, erreur: "Prévisions incomplètes à ce point." });
            }
            return res.json({
                succes: true,
                modele: cache.modele,
                previsions: resultat.previsions.map(({ date, vitesse, rafale, direction }) => ({
                    date, vitesse, rafale, direction: vitesse === 0 ? null : direction % 360
                })),
                actualisation_en_cours: actualisationEnCours,
                actualisation_retardee: Date.parse(cache.modele) < modeleAttendu
            });
        }
        return res.status(actualisationEnCours ? 202 : 503).json({
            succes: false,
            actualisation_en_cours: actualisationEnCours,
            erreur: apiKey
                ? (erreurActualisation || "En attente du premier cycle AROME-PI.")
                : "Clé API Météo-France AROME-PI manquante côté serveur."
        });
    });

    if (apiKey) {
        setInterval(verifierCycle, 60_000).unref();
        verifierCycle();
    }
}

module.exports = { installerAromePiVent };
