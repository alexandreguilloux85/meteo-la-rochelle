"use strict";

const { setTimeout: attendre } = require("node:timers/promises");
const { decoderGrib } = require("./arome-grib2");
const { essayerDemarrer } = require("./traitement-lourd");
const { compresserCacheArome } = require("./arome-cache-stream");
const { lireSauvegardeArome, jetonSauvegardeArome, signalerSauvegardeArome } =
    require("./arome-cache-pages");

const WCS = "https://public-api.meteofrance.fr/public/aromepi/1.0/wcs/" +
    "MF-NWP-HIGHRES-AROMEPI-0025-FRANCE-WCS";
const HEURE_MS = 60 * 60 * 1000;
const DELAI_PUBLICATION_MS = 35 * 60 * 1000;
const DELAI_REESSAI_MS = 4 * 60 * 1000;
const INTERVALLE_WCS_MS = 1500;
const PAS_SECONDES = 15 * 60;
const HORIZON_SECONDES = 6 * 3600;
const MAX_GRIB_OCTETS = 512 * 1024;
const MAX_POINTS_PAR_CHAMP = 1024;
const MAX_JSON_OCTETS = 1024 * 1024;
const MAX_CACHE_GZIP_OCTETS = 512 * 1024;
const ZONE = { latMin: 46.075, latMax: 46.300, lonMin: -1.600, lonMax: -1.050 };
const MAILLE = 0.025;
const NIVEAU = "__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___";
const COUVERTURES = {
    U: "U_COMPONENT_OF_WIND" + NIVEAU,
    V: "V_COMPONENT_OF_WIND" + NIVEAU,
    RAFALE: "WIND_SPEED_GUST_15MIN" + NIVEAU
};

function choisirCycle(xml, modeleAttendu, modeleEnCache, maintenant) {
    const ids = new Set(Array.from(
        xml.matchAll(/<(?:[\w-]+:)?CoverageId>\s*([^<]+?)\s*<\/(?:[\w-]+:)?CoverageId>/g),
        match => match[1]
    ));

    for (let heure = modeleAttendu; heure > modeleEnCache &&
        heure + HORIZON_SECONDES * 1000 > maintenant; heure -= HEURE_MS) {
        const modele = new Date(heure).toISOString().replace(".000Z", "Z");
        const suffixe = modele.replaceAll(":", ".");
        const U = COUVERTURES.U + suffixe;
        const V = COUVERTURES.V + suffixe;
        const rafale = COUVERTURES.RAFALE + suffixe;
        const RAFALE = ids.has(rafale + "_PT15M") ? rafale + "_PT15M" : rafale;
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

function validerCacheAromePi(cache) {
    const dateModele = Date.parse(cache?.modele);
    if (typeof cache?.modele !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/.test(cache.modele) ||
        !Number.isFinite(dateModele) || dateModele > Date.now() ||
        !Object.entries(ZONE).every(([cle, valeur]) => cache.zone?.[cle] === valeur) ||
        !Array.isArray(cache.previsions) || cache.previsions.length !== HORIZON_SECONDES / PAS_SECONDES) {
        throw new Error("Cache AROME-PI invalide : modèle, zone ou nombre d’échéances.");
    }
    for (const [index, prevision] of cache.previsions.entries()) {
        if (prevision?.seconde !== (index + 1) * PAS_SECONDES) {
            throw new Error("Échéances AROME-PI manquantes ou désordonnées.");
        }
        for (const champ of Object.keys(COUVERTURES)) {
            const { grille, valeurs } = prevision[champ] || {};
            if (!grille || grille.modele !== 0 || grille.mode_balaye !== 0 ||
                !Number.isInteger(grille.Ni) || !Number.isInteger(grille.Nj) ||
                grille.Ni < 2 || grille.Nj < 2 || !couvreZone(grille) ||
                !Array.isArray(valeurs) || valeurs.length !== grille.Ni * grille.Nj ||
                !valeurs.every(v => Number.isFinite(v) && (champ !== "RAFALE" || v >= 0))) {
                throw new Error(`Cache AROME-PI : grille ${champ} invalide à ${prevision.seconde} s.`);
            }
        }
    }
}

function installerAromePiVent(app, { apiKey, calculerPrevisionsArome, service }) {
    const production = service === "production";
    const branche = production ? "arome-pi-production-data" : service === "test" ? "arome-pi-data" : null;
    const source = service ? "Render " + service : null;
    let cache = null;
    let cacheCompresse = null;
    let origineCache = null;
    let actualisationEnCours = false;
    let prochainEssai = 0;
    let erreurActualisation = null;
    let restaurationTerminee = !branche;
    let restaurationSauvegarde = "non_demarre";
    let erreurRestauration = null;
    let publicationGithub = "non_demarre";
    let erreurPublication = null;

    function cacheDisponible() {
        return Boolean(cache && Date.parse(cache.modele) + HORIZON_SECONDES * 1000 > Date.now());
    }

    async function restaurerSauvegarde() {
        const liberer = essayerDemarrer("restauration-arome-pi");
        if (!liberer) {
            setTimeout(() => { void restaurerSauvegarde(); }, 2000).unref();
            return;
        }
        restaurationSauvegarde = "en_cours";
        try {
            const { cache: restaure, compresse } = await lireSauvegardeArome(
                branche, "arome-pi-cache.json.gz", MAX_JSON_OCTETS, MAX_CACHE_GZIP_OCTETS, 1
            );
            validerCacheAromePi(restaure);
            // Les sauvegardes historiques de cette branche étaient produites uniquement par Render test.
            if (restaure.source !== source && (production || restaure.source != null)) {
                throw new Error("Source de la sauvegarde AROME-PI inattendue.");
            }
            if (Date.parse(restaure.modele) + HORIZON_SECONDES * 1000 <= Date.now()) {
                restaurationSauvegarde = "expiree";
                return;
            }
            cache = restaure;
            cacheCompresse = compresse;
            origineCache = "GitHub (" + branche + ")";
            restaurationSauvegarde = "reussie";
            console.log("AROME-PI : sauvegarde GitHub restaurée", cache.modele);
        } catch (erreur) {
            restaurationSauvegarde = "indisponible";
            erreurRestauration = erreur.message;
            console.warn("AROME-PI : pas de restauration GitHub :", erreur.message);
        } finally {
            restaurationTerminee = true;
            liberer();
            verifierCycle();
        }
    }

    async function signalerSauvegardeGitHub(cycle, compresse) {
        const jeton = jetonSauvegardeArome();
        if (!jeton) {
            publicationGithub = "non_configuree";
            erreurPublication = "Configurer GITHUB_PAQUETS_PUBLISH_TOKEN sur Render";
            return;
        }
        publicationGithub = "envoi";
        erreurPublication = null;
        try {
            await signalerSauvegardeArome(jeton, {
                evenement: production ? "arome-pi-production-cache-ready" : "arome-pi-cache-ready",
                modele: cycle.modele,
                compresse,
                userAgent: "meteo-la-rochelle-arome-pi"
            });
            publicationGithub = "demande_envoyee";
        } catch (erreur) {
            publicationGithub = "echec";
            erreurPublication = erreur.message;
            console.warn("AROME-PI : sauvegarde GitHub non envoyée :", erreur.message);
        }
    }

    async function attendreVerrouPi(signal) {
        signal.throwIfAborted();
        let liberer = essayerDemarrer("arome-pi-vent");
        while (!liberer) {
            await attendre(INTERVALLE_WCS_MS, undefined, { signal });
            liberer = essayerDemarrer("arome-pi-vent");
        }
        return liberer;
    }

    async function lireWcs(operation, parametres, signal) {
        const url = new URL(WCS + "/" + operation);
        url.searchParams.set("service", "WCS");
        url.searchParams.set("version", "2.0.1");
        for (const [nom, valeur] of parametres) url.searchParams.append(nom, valeur);
        const liberer = await attendreVerrouPi(signal);
        try {
            const reponse = await fetch(url, {
                headers: { apikey: apiKey },
                signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)])
            });
            if (!reponse.ok) {
                await reponse.body?.cancel().catch(() => {});
                if (reponse.status === 401 || (operation === "GetCapabilities" && reponse.status === 403)) {
                    throw new Error("La clé API du serveur doit être autorisée pour AROME Prévision Immédiate.");
                }
                throw new Error(`Météo-France ${operation} : HTTP ${reponse.status}.`);
            }
            if (operation === "GetCapabilities") return await reponse.text();
            if (!reponse.body) throw new Error("Réponse GRIB2 AROME-PI sans contenu.");
            let octets = 0;
            const blocs = [];
            for await (const bloc of reponse.body) {
                octets += bloc.length;
                if (octets > MAX_GRIB_OCTETS) throw new Error("Champ AROME-PI trop volumineux pour la zone.");
                blocs.push(bloc);
            }
            const donnees = decoderGrib(Buffer.concat(blocs, octets), MAX_POINTS_PAR_CHAMP);
            if (!couvreZone(donnees.grille) || !donnees.valeurs.every(Number.isFinite)) {
                throw new Error("Grille AROME-PI incomplète pour la zone.");
            }
            return donnees;
        } finally {
            liberer();
        }
    }

    async function chargerCycle(modeleAttendu, maintenant) {
        const signal = AbortSignal.timeout(5 * 60_000);
        const catalogue = await lireWcs("GetCapabilities", [["language", "fre"]], signal);
        const cycle = choisirCycle(catalogue, modeleAttendu,
            cache ? Date.parse(cache.modele) : 0, maintenant);
        if (!cycle) throw new Error("Le dernier cycle AROME-PI est en attente de publication.");

        const dateModele = Date.parse(cycle.modele);
        const previsions = [];
        for (let seconde = PAS_SECONDES; seconde <= HORIZON_SECONDES; seconde += PAS_SECONDES) {
            const date = new Date(dateModele + seconde * 1000).toISOString().replace(".000Z", "Z");
            const champs = { seconde };
            for (const [champ, couverture] of Object.entries(cycle.couvertures)) {
                // Espacer les 72 téléchargements sans immobiliser le verrou entre deux champs.
                await attendre(INTERVALLE_WCS_MS, undefined, { signal });
                champs[champ] = await lireWcs("GetCoverage", [
                    ["coverageid", couverture],
                    ["subset", `time(${date})`],
                    ["subset", "height(10)"],
                    ["subset", `lat(${(ZONE.latMin - MAILLE).toFixed(3)},${(ZONE.latMax + MAILLE).toFixed(3)})`],
                    ["subset", `long(${(ZONE.lonMin - MAILLE).toFixed(3)},${(ZONE.lonMax + MAILLE).toFixed(3)})`],
                    ["format", "application/wmo-grib"]
                ], signal);
            }
            previsions.push(champs);
        }

        const resultat = { modele: cycle.modele, date: Date.now(), source, zone: { ...ZONE }, previsions };
        const liberer = await attendreVerrouPi(signal);
        try {
            validerCacheAromePi(resultat);
            const { gzip } = await compresserCacheArome(resultat, MAX_JSON_OCTETS, MAX_CACHE_GZIP_OCTETS);
            return { resultat, gzip };
        } finally {
            liberer();
        }
    }

    function verifierCycle() {
        const maintenant = Date.now();
        const modeleAttendu = Math.floor((maintenant - DELAI_PUBLICATION_MS) / HEURE_MS) * HEURE_MS;
        if (!apiKey || !restaurationTerminee || actualisationEnCours || maintenant < prochainEssai ||
            (cache && Date.parse(cache.modele) >= modeleAttendu)) return modeleAttendu;

        actualisationEnCours = true;
        void chargerCycle(modeleAttendu, maintenant).then(({ resultat, gzip }) => {
            cache = resultat;
            cacheCompresse = gzip;
            origineCache = "Météo-France";
            erreurActualisation = null;
            if (branche) void signalerSauvegardeGitHub(resultat, gzip);
        }).catch(erreur => {
            erreurActualisation = erreur.message;
            console.warn("Actualisation du vent AROME-PI :", erreur.message);
        }).finally(() => {
            prochainEssai = Date.now() + DELAI_REESSAI_MS;
            actualisationEnCours = false;
        });
        return modeleAttendu;
    }

    app.get("/api/arome/pi/status", (_req, res) => {
        res.set("Cache-Control", "no-store");
        res.json({
            modele: cache?.modele || null,
            api_configuree: Boolean(apiKey),
            cache_disponible: cacheDisponible(),
            origine_cache: origineCache,
            source_cache: cache ? source : null,
            taille_cache_gzip_octets: cacheCompresse?.length || 0,
            actualisation_en_cours: actualisationEnCours,
            erreur_actualisation: erreurActualisation,
            restauration_sauvegarde: restaurationSauvegarde,
            restauration_pages: restaurationSauvegarde,
            erreur_restauration_pages: erreurRestauration,
            publication_github: publicationGithub,
            erreur_publication_github: erreurPublication
        });
    });

    app.get("/api/arome/pi/cache", (_req, res) => {
        res.set("Cache-Control", "no-store");
        if (!cacheDisponible() || !cacheCompresse) {
            return res.status(503).json({ succes: false, erreur: "Cache AROME-PI indisponible." });
        }
        return res.type("application/gzip").send(cacheCompresse);
    });

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
        if (cacheDisponible()) {
            const resultat = calculerPrevisionsArome(cache, lat, lon, {
                pasSecondes: PAS_SECONDES, horizonSecondes: HORIZON_SECONDES
            });
            if (resultat.previsions.length !== HORIZON_SECONDES / PAS_SECONDES || resultat.previsions.some(p =>
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
        const chargementEnCours = !restaurationTerminee || actualisationEnCours;
        return res.status(chargementEnCours ? 202 : 503).json({
            succes: false,
            actualisation_en_cours: chargementEnCours,
            erreur: apiKey
                ? (erreurActualisation || "En attente du premier cycle AROME-PI.")
                : "Clé API Météo-France AROME-PI manquante côté serveur."
        });
    });

    if (apiKey) setInterval(verifierCycle, 60_000).unref();
    if (branche) setImmediate(() => { void restaurerSauvegarde(); });
    else verifierCycle();
}

module.exports = { installerAromePiVent };
