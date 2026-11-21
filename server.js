require("dotenv").config();

const express = require("express");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const proj4 = require("proj4");
const { PNG } = require("pngjs");
const { essayerDemarrer, traitementEnCours } = require("./traitement-lourd");
const { masquerRadarSelonQualite } = require("./radar-qualite");

const app = express();

// Autoriser l'interface GitHub Pages à appeler les API hébergées sur Render.
app.use((req, res, next) => {
    const origineAutorisee =
        "https://alexandreguilloux85.github.io";

    if (req.headers.origin === origineAutorisee) {
        res.setHeader("Access-Control-Allow-Origin", origineAutorisee);
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Authorization");
        res.setHeader(
            "Access-Control-Expose-Headers",
            "X-Radar-Bounds, X-Radar-Date"
        );
        res.vary("Origin");
    }

    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }

    next();
});

const PORT = process.env.PORT || 3000;

const API_KEY = process.env.METEO_API_KEY;
const RADAR_API_KEY = process.env.METEO_RADAR_API_KEY;

const RADAR_CATALOGUE =
    "https://public-api.meteofrance.fr/public/DPRadar/v1/mosaiques/METROPOLE/observations/LAME_D_EAU";

const RADAR_TILE_SIZE = 256;
const RADAR_ZOOM_MIN = 4;
const RADAR_ZOOM_MAX = 9;
const RADAR_CATALOGUE_TTL_MS = 4 * 60 * 1000;
const RADAR_TILE_CACHE_MAX = 96;
const RADAR_WEB_MERCATOR_LIMIT = 20037508.342789244;

proj4.defs(
    "RADAR_METEO",
    "+proj=stere +lat_0=90 +lon_0=0 +lat_ts=45 " +
    "+ellps=WGS84 +x_0=619652.07 +y_0=5262818.34 " +
    "+datum=WGS84 +units=m +no_defs"
);

let radarProduitCache = null;
let radarProduitEnChargement = null;
const radarTuilesCache = new Map();
const radarTuilesEnChargement = new Map();

// --------------------------------------------------
// OUTILS
// --------------------------------------------------

function convertirJSON(valeur) {
    if (typeof valeur === "bigint") {
        return valeur.toString();
    }

    if (ArrayBuffer.isView(valeur)) {
        return Array.from(valeur, convertirJSON);
    }

    if (Array.isArray(valeur)) {
        return valeur.map(convertirJSON);
    }

    if (valeur && typeof valeur === "object") {
        const resultat = {};

        for (const [cle, element] of Object.entries(valeur)) {
            resultat[cle] = convertirJSON(element);
        }

        return resultat;
    }

    return valeur;
}

function valeurAttribut(groupe, nom) {
    const attribut = groupe.attrs[nom];

    if (!attribut) {
        throw new Error("Attribut HDF5 manquant : " + nom);
    }

    return Number(attribut.value);
}

async function obtenirProduitRadar({ forcerVerification = false } = {}) {
    if (!RADAR_API_KEY) {
        throw new Error("La variable METEO_RADAR_API_KEY est absente dans Render.");
    }

    if (
        radarProduitCache &&
        !forcerVerification &&
        Date.now() - radarProduitCache.verifieLe < RADAR_CATALOGUE_TTL_MS
    ) {
        return radarProduitCache;
    }

    if (!radarProduitEnChargement) {
        const libererRadar = essayerDemarrer("radar-national");
        if (!libererRadar) {
            // Ne pas perdre le radar à l'écran pendant un décodage AROME.
            if (radarProduitCache) return radarProduitCache;
            throw new Error("Chargement radar différé : " +
                (traitementEnCours()?.nom || "autre traitement en cours"));
        }
        radarProduitEnChargement = (async () => {
          try {
            const catalogueResponse = await fetch(RADAR_CATALOGUE, {
                headers: {
                    apikey: RADAR_API_KEY,
                    accept: "application/json"
                },
                signal: AbortSignal.timeout(30000)
            });

            if (!catalogueResponse.ok) {
                throw new Error(
                    "Erreur catalogue radar : " + catalogueResponse.status
                );
            }

            const catalogue = await catalogueResponse.json();
            const produit = Array.isArray(catalogue.links)
                ? catalogue.links.find(link =>
                    link.href?.includes("maille=500")
                )
                : null;

            if (!produit?.href || !produit.validity_time) {
                throw new Error("Produit radar 500 m introuvable");
            }

            if (radarProduitCache?.date === produit.validity_time) {
                radarProduitCache.verifieLe = Date.now();
                return radarProduitCache;
            }

            const response = await fetch(produit.href, {
                headers: {
                    apikey: RADAR_API_KEY,
                    accept: "*/*"
                },
                signal: AbortSignal.timeout(60000)
            });

            if (!response.ok) {
                throw new Error(
                    "Erreur téléchargement radar : " + response.status
                );
            }

            const fichierTemporaire = path.join(
                os.tmpdir(),
                "radar-" + crypto.randomUUID() + ".h5"
            );
            let fichierHdf;

            try {
                await fs.writeFile(
                    fichierTemporaire,
                    Buffer.from(await response.arrayBuffer())
                );

                const h5wasm = await import("h5wasm/node");
                await h5wasm.ready;
                fichierHdf = new h5wasm.File(fichierTemporaire, "r");

                const datasetPluie = fichierHdf.get("/dataset1/data1/data");
                const datasetQualite = fichierHdf.get(
                    "/dataset1/data1/quality1/data"
                );
                const hauteur = datasetPluie.shape[0];
                const largeur = datasetPluie.shape[1];
                const pluie = new Uint16Array(datasetPluie.value);
                const qualite = new Uint8Array(datasetQualite.value);
                const where = fichierHdf.get("/where");
                const xScale = valeurAttribut(where, "xscale");
                const yScale = valeurAttribut(where, "yscale");
                const origine = proj4(
                    "EPSG:4326",
                    "RADAR_METEO",
                    [
                        valeurAttribut(where, "LL_lon"),
                        valeurAttribut(where, "LL_lat")
                    ]
                );

                if (
                    !Number.isInteger(hauteur) ||
                    !Number.isInteger(largeur) ||
                    hauteur <= 0 ||
                    largeur <= 0 ||
                    pluie.length < hauteur * largeur ||
                    qualite.length < hauteur * largeur ||
                    !Number.isFinite(xScale) ||
                    !Number.isFinite(yScale) ||
                    xScale <= 0 ||
                    yScale <= 0 ||
                    !origine.every(Number.isFinite)
                ) {
                    throw new Error("Grille du produit radar invalide.");
                }

                // Fusionner le masque qualité dans la grille de pluie.
                // 65535 est déjà une valeur non affichable : le rendu PNG
                // reste inchangé et évite de conserver ~12 Mio de qualité.
                masquerRadarSelonQualite(pluie, qualite);

                const nouveauProduit = {
                    date: produit.validity_time,
                    pluie,
                    hauteur,
                    largeur,
                    xScale,
                    yScale,
                    origineX: origine[0],
                    origineY: origine[1],
                    verifieLe: Date.now()
                };

                radarProduitCache = nouveauProduit;
                radarTuilesCache.clear();
                console.log("Produit radar Render chargé :", nouveauProduit.date);
                return nouveauProduit;
            } finally {
                if (fichierHdf) {
                    try {
                        fichierHdf.close();
                    } catch (error) {
                        console.error("Fermeture HDF5 radar :", error);
                    }
                }
                try {
                    await fs.unlink(fichierTemporaire);
                } catch (error) {
                    if (error.code !== "ENOENT") {
                        console.error("Suppression du fichier radar temporaire :", error);
                    }
                }
            }
          } finally {
            libererRadar();
          }
        })();
    }

    try {
        return await radarProduitEnChargement;
    } finally {
        radarProduitEnChargement = null;
    }
}

// --------------------------------------------------
// PALETTE RADAR
// Valeurs en mm / 5 minutes
// --------------------------------------------------

function couleurRadar(pluie) {
    if (pluie <= 0) {
        return [0, 0, 0, 0];
    }

    if (pluie < 0.1) {
        return [150, 210, 255, 180];
    }

    if (pluie < 0.5) {
        return [25, 100, 220, 210];
    }

    if (pluie < 1) {
        return [30, 180, 100, 220];
    }

    if (pluie < 2) {
        return [255, 230, 30, 230];
    }

    if (pluie < 5) {
        return [255, 140, 20, 240];
    }

    return [220, 25, 35, 245];
}

// --------------------------------------------------
// GENERATION DES TUILES RADAR XYZ
// --------------------------------------------------

// Les indices géographiques d'une tuile ne changent pas à chaque produit radar.
// ~8 Mio au maximum : 32 correspondances de 256 x 256 indices (Int32).
const RADAR_COORDONNEES_CACHE_MAX = 32;
const radarCoordonneesCache = new Map();

function indicesTuileRadar(produit, zoom, tuileX, tuileY) {
    const cle = [
        produit.largeur, produit.hauteur, produit.xScale, produit.yScale,
        produit.origineX, produit.origineY, zoom, tuileX, tuileY
    ].join("/");
    const dejaCalcules = radarCoordonneesCache.get(cle);
    if (dejaCalcules) return dejaCalcules;

    const indices = new Int32Array(RADAR_TILE_SIZE * RADAR_TILE_SIZE);
    indices.fill(-1);

    const pas = zoom <= 5 ? 4 : zoom <= 7 ? 8 : 16;
    const noeudsParAxe = RADAR_TILE_SIZE / pas + 1;
    const points = noeudsParAxe * noeudsParAxe;
    const projX = new Float64Array(points);
    const projY = new Float64Array(points);
    const nombreTuiles = 2 ** zoom;
    const tailleMondeTuile = 2 * RADAR_WEB_MERCATOR_LIMIT / nombreTuiles;
    const metresParPixel = tailleMondeTuile / RADAR_TILE_SIZE;

    // Une transformation proj4 par nœud au lieu d'une par pixel.
    for (let ligneNoeud = 0; ligneNoeud < noeudsParAxe; ligneNoeud++) {
        const py = ligneNoeud * pas;
        const webY = RADAR_WEB_MERCATOR_LIMIT -
            (tuileY * RADAR_TILE_SIZE + py + 0.5) * metresParPixel;
        const latitude = Math.atan(Math.sinh(webY / 6378137)) * 180 / Math.PI;

        for (let colonneNoeud = 0; colonneNoeud < noeudsParAxe; colonneNoeud++) {
            const px = colonneNoeud * pas;
            const longitude =
                (tuileX * RADAR_TILE_SIZE + px + 0.5) /
                (nombreTuiles * RADAR_TILE_SIZE) * 360 - 180;
            const [x, y] = proj4(
                "EPSG:4326", "RADAR_METEO", [longitude, latitude]
            );
            const index = ligneNoeud * noeudsParAxe + colonneNoeud;
            projX[index] = x;
            projY[index] = y;
        }
    }

    // Interpolation bilinéaire des coordonnées source, précision
    // suffisante par rapport à la taille d'un pixel radar de 500 m.
    for (let py = 0; py < RADAR_TILE_SIZE; py++) {
        const ligneCellule = Math.floor(py / pas);
        const fy = (py % pas) / pas;
        const debutLigne = ligneCellule * noeudsParAxe;
        const debutLigneSuivante = debutLigne + noeudsParAxe;

        for (let px = 0; px < RADAR_TILE_SIZE; px++) {
            const colonneCellule = Math.floor(px / pas);
            const fx = (px % pas) / pas;
            const hg = debutLigne + colonneCellule;
            const bg = debutLigneSuivante + colonneCellule;

            const xHaut = projX[hg] + fx * (projX[hg + 1] - projX[hg]);
            const xBas = projX[bg] + fx * (projX[bg + 1] - projX[bg]);
            const yHaut = projY[hg] + fx * (projY[hg + 1] - projY[hg]);
            const yBas = projY[bg] + fx * (projY[bg + 1] - projY[bg]);
            const x = xHaut + fy * (xBas - xHaut);
            const y = yHaut + fy * (yBas - yHaut);

            const colonne = Math.floor((x - produit.origineX) / produit.xScale);
            const ligne = Math.floor(
                (produit.origineY + produit.hauteur * produit.yScale - y) /
                produit.yScale
            );
            if (
                Number.isFinite(colonne) && Number.isFinite(ligne) &&
                colonne >= 0 && colonne < produit.largeur &&
                ligne >= 0 && ligne < produit.hauteur
            ) {
                indices[py * RADAR_TILE_SIZE + px] =
                    ligne * produit.largeur + colonne;
            }
        }
    }

    radarCoordonneesCache.set(cle, indices);
    while (radarCoordonneesCache.size > RADAR_COORDONNEES_CACHE_MAX) {
        radarCoordonneesCache.delete(radarCoordonneesCache.keys().next().value);
    }
    return indices;
}

function genererTuileRadar(produit, zoom, tuileX, tuileY) {
    const png = new PNG({ width: RADAR_TILE_SIZE, height: RADAR_TILE_SIZE });
    const indices = indicesTuileRadar(produit, zoom, tuileX, tuileY);

    for (let pixel = 0; pixel < indices.length; pixel++) {
        const indexSource = indices[pixel];
        if (indexSource < 0) continue;
        const valeurBrute = produit.pluie[indexSource];
        // Les pixels de mauvaise qualité ont été masqués dans pluie.
        if (valeurBrute === 65535 || valeurBrute === 65534) {
            continue;
        }
        const couleur = couleurRadar(valeurBrute * 0.01);
        const indexPNG = pixel * 4;
        png.data[indexPNG] = couleur[0];
        png.data[indexPNG + 1] = couleur[1];
        png.data[indexPNG + 2] = couleur[2];
        png.data[indexPNG + 3] = couleur[3];
    }
    return PNG.sync.write(png);
}

async function obtenirTuileRadar(produit, zoom, tuileX, tuileY) {
    const cle = `${produit.date}/${zoom}/${tuileX}/${tuileY}`;
    if (radarTuilesCache.has(cle)) {
        return radarTuilesCache.get(cle);
    }

    if (!radarTuilesEnChargement.has(cle)) {
        radarTuilesEnChargement.set(
            cle,
            Promise.resolve().then(() =>
                genererTuileRadar(produit, zoom, tuileX, tuileY)
            )
        );
    }

    try {
        const image = await radarTuilesEnChargement.get(cle);
        radarTuilesCache.set(cle, image);
        while (radarTuilesCache.size > RADAR_TILE_CACHE_MAX) {
            radarTuilesCache.delete(radarTuilesCache.keys().next().value);
        }
        return image;
    } finally {
        radarTuilesEnChargement.delete(cle);
    }
}

// --------------------------------------------------
// FICHIERS PUBLICS
// --------------------------------------------------

app.use(express.static("public"));

// --------------------------------------------------
// OBSERVATIONS METEO : dernier paquet conservé en mémoire entre deux contrôles.
const OBSERVATIONS_TTL_MS = 5 * 60 * 1000;
let observationsCache = null;
let observationsChargement = null;

async function obtenirObservations({ forcerVerification = false } = {}) {
    if (!forcerVerification && observationsCache &&
        Date.now() - observationsCache.verifieLe < OBSERVATIONS_TTL_MS) {
        return observationsCache.donnees;
    }
    if (!observationsChargement) {
        observationsChargement = (async () => {
            const url = new URL(
                "https://public-api.meteofrance.fr/public/DPPaquetObs/v2/paquet/infrahoraire-6m"
            );
            url.searchParams.set("id_station", "17300009");
            url.searchParams.set("format", "json");
            const reponse = await fetch(url, {
                headers: { accept: "*/*", apikey: API_KEY, "cache-control": "no-cache" },
                cache: "no-store",
                signal: AbortSignal.timeout(30000)
            });
            if (!reponse.ok) {
                throw new Error("Météo-France observations : HTTP " + reponse.status);
            }
            const donnees = await reponse.json();
            if (!Array.isArray(donnees)) {
                throw new Error("Format des relevés météo invalide.");
            }
            observationsCache = { donnees, verifieLe: Date.now() };
            return donnees;
        })();
    }
    try {
        return await observationsChargement;
    } catch (erreur) {
        if (!forcerVerification && observationsCache) {
            console.warn("Observations indisponibles : ancien cache conservé", erreur.message);
            return observationsCache.donnees;
        }
        throw erreur;
    } finally {
        observationsChargement = null;
    }
}

app.get("/api/observations", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
        // Le bouton station contourne le TTL et impose une requête Météo-France.
        // En mode refresh, un échec ne doit jamais paraître être une vérification réussie.
        const forcerVerification = req.query.refresh === "1";
        return res.json(await obtenirObservations({ forcerVerification }));
    } catch (erreur) {
        console.error("Erreur observations :", erreur);
        return res.status(502).json({ erreur: erreur.message });
    }
});

// --------------------------------------------------
// // Reveil du serveur (depuis nas)
// --------------------------------------------------

// --------------------------------------------------
// Publication des données sur GitHub : les Actions ne servent qu'au déploiement.
const GITHUB_ACTIONS_TOKEN = process.env.GITHUB_ACTIONS_TOKEN;
const GITHUB_REPOSITORY = "alexandreguilloux85/meteo-la-rochelle";
let derniereDemandeManuelleArome = 0;

// Le bouton AROME demande une vérification sur Render, sans workflow de calcul.
app.post("/api/refresh-arome", (req, res) => {
    res.set("Cache-Control", "no-store");
    const origine = req.get("origin");
    const hostnameRender = process.env.RENDER_EXTERNAL_HOSTNAME;
    const origineLocale = hostnameRender
        ? "https://" + hostnameRender : null;
    const origineGitHubPages = "https://alexandreguilloux85.github.io";
    // Éviter req.protocol derrière le proxy HTTPS de Render. GitHub Pages
    // ne peut demander une actualisation que sur le service de production.
    const origineAutorisee = origine === origineLocale ||
        (AROME_PUBLICATION_GITHUB_AUTORISEE &&
            origine === origineGitHubPages);
    if (!origineAutorisee) {
        return res.status(403).json({ erreur: "Origine non autorisée" });
    }
    const maintenant = Date.now();
    if (maintenant - derniereDemandeManuelleArome < 15 * 60 * 1000) {
        return res.status(429).json({
            erreur: "Vérification AROME déjà demandée récemment."
        });
    }
    derniereDemandeManuelleArome = maintenant;
    if (pilotePaquets?.actif) {
        return res.status(200).json({
            succes: true,
            message: "AROME GRIB2 actif : le WCS reste en secours ; " +
                "la vérification automatique des paquets reste prioritaire."
        });
    }
    demarrerActualisationArome(46.178, -1.193167);
    return res.status(202).json({
        succes: true,
        message: "Vérification AROME WCS lancée sur Render."
    });
});

app.get("/api/refresh-weather", (req, res) => {
    return res.status(410).json({
        succes: false,
        erreur: "Utilise un bouton d'actualisation du site."
    });
});

// Répondre immédiatement au NAS, puis vérifier les caches sans bloquer HTTP.
let dernierControleKeepalive = 0;
app.get("/api/keepalive", (req, res) => {
    res.status(200).send("OK");
    if (Date.now() - dernierControleKeepalive < 4 * 60 * 1000) return;
    dernierControleKeepalive = Date.now();

    setImmediate(() => {
        void obtenirObservations().catch(erreur =>
            console.warn("Keepalive observations :", erreur.message)
        );
        // Éviter de cumuler le chargement de la mosaïque et des GRIB AROME.
        void (async () => {
            try {
                await obtenirProduitRadar();
            } catch (erreur) {
                console.warn("Keepalive radar :", erreur.message);
            } finally {
                try {
                    verifierAromeEnArrierePlan(46.178, -1.193167);
                } catch (erreur) {
                    console.warn("Keepalive AROME :", erreur.message);
                }
            }
        })();
    });
});





// --------------------------------------------------
// TUILES RADAR NATIONALES
// --------------------------------------------------

app.get("/api/radar/metadata", async (req, res) => {
    res.set("Cache-Control", "no-store");

    try {
        const produit = await obtenirProduitRadar({
            forcerVerification: req.query.refresh === "1"
        });
        return res.json({
            date: produit.date,
            tile_size: RADAR_TILE_SIZE,
            zoom_min: RADAR_ZOOM_MIN,
            zoom_max: RADAR_ZOOM_MAX,
            crs: "EPSG:3857",
            tile_url_template: "/api/radar/tiles/{z}/{x}/{y}.png"
        });
    } catch (error) {
        console.error("Erreur métadonnées radar :", error);
        return res.status(502).json({
            succes: false,
            erreur: error.message
        });
    }
});

app.get("/api/radar/tiles/:zoom/:x/:y.png", async (req, res) => {
    const zoom = Number(req.params.zoom);
    const tuileX = Number(req.params.x);
    const tuileY = Number(req.params.y);
    const nombreTuiles = 2 ** zoom;

    if (
        !Number.isInteger(zoom) ||
        zoom < RADAR_ZOOM_MIN ||
        zoom > RADAR_ZOOM_MAX ||
        !Number.isInteger(tuileX) ||
        !Number.isInteger(tuileY) ||
        tuileX < 0 ||
        tuileY < 0 ||
        tuileX >= nombreTuiles ||
        tuileY >= nombreTuiles
    ) {
        return res.status(400).json({
            succes: false,
            erreur: "Coordonnées de tuile radar invalides."
        });
    }

    try {
        const produit =
            radarProduitCache && req.query.v === radarProduitCache.date
                ? radarProduitCache
                : await obtenirProduitRadar();
        const image = await obtenirTuileRadar(produit, zoom, tuileX, tuileY);
        res.set({
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=86400, immutable"
        });
        return res.send(image);
    } catch (error) {
        console.error("Erreur génération tuile radar :", error);
        return res.status(502).json({
            succes: false,
            erreur: error.message
        });
    }
});

// --------------------------------------------------
// AROME - TEST DU CATALOGUE WCS
// --------------------------------------------------


const AROME_API_KEY = process.env.METEO_AROME_API_KEY;
const AROME_REFRESH_TOKEN = process.env.AROME_REFRESH_TOKEN;
const AROME_CACHE_URL =
    process.env.AROME_CACHE_URL ||
    "https://alexandreguilloux85.github.io/meteo-la-rochelle/arome-cache.json";

const AROME_WCS_BASE =
    "https://public-api.meteofrance.fr/public/arome/1.0/wcs/" +
    "MF-NWP-HIGHRES-AROME-001-FRANCE-WCS";
const AROME_ECHEANCES_ATTENDUES = 51;
const AROME_ECHEANCES_MINIMUM = 1;
const AROME_ECHEANCES_MINIMUM_PUBLICATION = 24;
const AROME_ECHEANCES_INITIALES_OBLIGATOIRES = 6;
const POINT_AROME_LA_ROCHELLE = { lat: 46.178, lon: -1.193167 };

// Les deux branches partagent ce même serveur. Seul le service Render
// de production est autorisé à modifier la branche de données GitHub.
// RENDER_EXTERNAL_HOSTNAME est fourni automatiquement par Render.
const AROME_PUBLICATION_GITHUB_AUTORISEE =
    process.env.RENDER_EXTERNAL_HOSTNAME === "station-meteo-lr.onrender.com";

function normaliserModeleArome(modele) {
    if (typeof modele !== "string") return modele;
    return modele.replace(/T(\d{2})\.(\d{2})\.(\d{2})Z$/, "T$1:$2:$3Z");
}

function pointDansZoneArome(zone, lat, lon) {
    return Boolean(zone &&
        lat >= zone.latMin && lat <= zone.latMax &&
        lon >= zone.lonMin && lon <= zone.lonMax);
}

function evaluerCacheArome(cache) {
    const heures = new Set();
    let rafales = 0;
    for (const p of (Array.isArray(cache?.previsions) ? cache.previsions : [])) {
        const sec = p?.seconde;
        if (
            Number.isInteger(sec) &&
            sec >= 3600 && sec <= AROME_ECHEANCES_ATTENDUES * 3600 &&
            sec % 3600 === 0 &&
            p.U?.grille && p.U?.valeurs && p.V?.grille && p.V?.valeurs
        ) {
            heures.add(sec / 3600);
            if (p.RAFALE?.grille && p.RAFALE?.valeurs) rafales++;
        }
    }
    const premieresDisponibles = Array.from(
        { length: AROME_ECHEANCES_INITIALES_OBLIGATOIRES },
        (_, i) => i + 1
    ).every(h => heures.has(h));
    return {
        valide: heures.size >= AROME_ECHEANCES_MINIMUM_PUBLICATION &&
            premieresDisponibles,
        nombre_echeances: heures.size,
        nombre_rafales: rafales,
        heures_initiales_valides: premieresDisponibles,
        minimum_publication: AROME_ECHEANCES_MINIMUM_PUBLICATION
    };
}

function signatureCacheArome(cache) {
    return JSON.stringify({
        modele: normaliserModeleArome(cache.modele),
        zone: cache.zone,
        disponible: cache.previsions.map(p => [
            p.seconde, Boolean(p.U), Boolean(p.V), Boolean(p.RAFALE)
        ])
    });
}


// --------------------------------------------------
// AROME - CACHE SPATIAL DES PREVISIONS
// --------------------------------------------------

const AROME_CACHE_FILE = path.join(__dirname, "arome-cache.json");

let AROME_CACHE_ZONE = null;
let AROME_CACHE_CHARGEMENT = null;
let AROME_OPERATION_EN_COURS = false;
let AROME_REFRESH_PROMISE = null;
let AROME_DERNIERE_VERIFICATION = 0;
let AROME_REFRESH_STATE = {
    status: "idle",
    modele: null,
    erreur: null
};
let AROME_CACHE_SOURCE = null;
let AROME_CATALOGUE_CACHE = null;
let AROME_CATALOGUE_DATE = 0;

function verifierJetonActualisation(req, res) {
    if (!AROME_REFRESH_TOKEN) {
        res.status(503).json({
            succes: false,
            erreur: "Variable AROME_REFRESH_TOKEN absente dans Render"
        });
        return false;
    }

    const authorization = req.get("authorization") || "";
    const tokenFourni = authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : "";
    const tokenAttendu = Buffer.from(AROME_REFRESH_TOKEN);
    const tokenRecu = Buffer.from(tokenFourni);

    if (
        tokenRecu.length !== tokenAttendu.length ||
        !crypto.timingSafeEqual(tokenRecu, tokenAttendu)
    ) {
        res.status(401).json({
            succes: false,
            erreur: "Authentification requise"
        });
        return false;
    }

    return true;
}

// Paquets GRIB2 actifs sur Render test et sur les services activés explicitement.
// Le cache GRIB2 utilise une sauvegarde distincte du WCS.
const pilotePaquets = require("./arome-paquets-render-test").installerTestAromePaquets(app, {
    verifierJetonActualisation,
    calculerPrevisionsArome,
    chargerCacheArome
});

// Chargement du cache depuis le disque Render
async function chargerCacheArome() {
    if (AROME_CACHE_ZONE) return AROME_CACHE_ZONE;

    if (AROME_CACHE_CHARGEMENT) {
        return AROME_CACHE_CHARGEMENT;
    }

    AROME_CACHE_CHARGEMENT = (async () => {
        try {
            const contenu = await fs.readFile(AROME_CACHE_FILE, "utf8");
            AROME_CACHE_ZONE = JSON.parse(contenu);
            AROME_CACHE_SOURCE = "Render";

            console.log(
                "Cache AROME chargé :",
                AROME_CACHE_ZONE.modele,
                AROME_CACHE_ZONE.previsions?.length,
                "échéances"
            );

        } catch (error) {
            if (error.code !== "ENOENT") {
                console.error("Erreur lecture cache AROME :", error);
            }

            AROME_CACHE_ZONE = null;
        }

        if (!AROME_CACHE_ZONE && AROME_CACHE_URL) {
            try {
                const url = new URL(AROME_CACHE_URL);
                url.searchParams.set("t", Date.now());

                const reponse = await fetch(url, {
                    headers: {
                        accept: "application/json",
                        "cache-control": "no-cache"
                    }
                });

                if (!reponse.ok) {
                    throw new Error(
                        "Erreur cache Pages : " + reponse.status
                    );
                }

                const cache = await reponse.json();

                if (
                    !cache ||
                    typeof cache.modele !== "string" ||
                    !cache.zone ||
                    !Array.isArray(cache.previsions)
                ) {
                    throw new Error("Format de cache AROME invalide");
                }

                AROME_CACHE_ZONE = cache;
                AROME_CACHE_SOURCE = "GitHub Pages";

                console.log(
                    "Cache AROME chargé depuis GitHub Pages :",
                    cache.modele,
                    cache.previsions.length,
                    "échéances"
                );
            } catch (error) {
                console.error(
                    "Erreur chargement du cache AROME depuis GitHub Pages :",
                    error
                );
            }
        }

        return AROME_CACHE_ZONE;
    })();

    try {
        return await AROME_CACHE_CHARGEMENT;
    } finally {
        AROME_CACHE_CHARGEMENT = null;
    }
}

// Sauvegarde du cache sur le disque Render
async function sauvegarderCacheArome(cache) {
    const fichierTemporaire = `${AROME_CACHE_FILE}.${crypto.randomUUID()}.tmp`;
    try {
        await fs.writeFile(fichierTemporaire, JSON.stringify(cache));
        await fs.rename(fichierTemporaire, AROME_CACHE_FILE);
    } catch (erreur) {
        await fs.rm(fichierTemporaire, { force: true }).catch(() => {});
        throw erreur;
    }

    AROME_CACHE_ZONE = cache;
    AROME_CACHE_SOURCE = "Render";

    // Affichage de la taille du cache dans les logs Render
    const informationsFichier = await fs.stat(AROME_CACHE_FILE);
    const tailleMo = informationsFichier.size / 1024 / 1024;

    console.log(
        "Cache AROME sauvegardé :",
        cache.modele,
        cache.previsions.length,
        "échéances",
        tailleMo.toFixed(2),
        "Mo"
    );
}

function calculerPrevisionsArome(cache, latitude, longitude) {
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
                echeance: "H+" + h,
                date: dateValide.toISOString(),
                vitesse: Number(vitesse.toFixed(2)),
                rafale: Number.isFinite(rafale)
                    ? Number(rafale.toFixed(2))
                    : null,
                direction: Number(direction.toFixed(1)),
                composante_U: Number(u.toFixed(3)),
                composante_V: Number(v.toFixed(3))
            });
        } catch (error) {
            erreurs.push({
                echeance: "H+" + h,
                erreur: error.message
            });
        }
    }

    const erreursCache = Array.isArray(cache.erreurs)
        ? cache.erreurs
        : [];

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
        methode: "Interpolation bilinéaire des composantes U/V",
        previsions,
        erreurs: [...erreursCache, ...erreurs]
    };
}

// Publication persistante du modèle sur la branche de données GitHub.
// Un repository_dispatch déclenche uniquement le déploiement GitHub Pages.
let dernierModeleAromePublie = null;
let derniereSignatureAromePubliee = null;
async function publierCacheAromeSurGithub(cache) {
    const bilan = evaluerCacheArome(cache);
    if (!cache?.modele || !bilan.valide) {
        throw new Error(
            "Publication refusée : " + bilan.nombre_echeances +
            " échéances U/V (minimum " + bilan.minimum_publication +
            ", H+1 à H+6 obligatoires)."
        );
    }
    if (!AROME_PUBLICATION_GITHUB_AUTORISEE) {
        console.log("AROME test : cache validé, publication GitHub désactivée.");
        return false;
    }
    const { lat, lon } = POINT_AROME_LA_ROCHELLE;
    if (!pointDansZoneArome(cache.zone, lat, lon)) {
        console.log("AROME WCS : zone hors La Rochelle conservée sur Render.");
        return false;
    }
    const signature = signatureCacheArome(cache);
    if (derniereSignatureAromePubliee === signature) return true;

    const token = process.env.GITHUB_DATA_TOKEN || GITHUB_ACTIONS_TOKEN;
    if (!token) {
        throw new Error("Publication AROME : configurer GITHUB_DATA_TOKEN sur Render.");
    }
    const entetes = {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + token,
        "X-GitHub-Api-Version": "2022-11-28"
    };
    const fichierUrl =
        "https://api.github.com/repos/" + GITHUB_REPOSITORY +
        "/contents/arome-cache.json";
    const verification = await fetch(fichierUrl + "?ref=arome-data", {
        headers: entetes,
        signal: AbortSignal.timeout(30000)
    });
    if (verification.status !== 404 && !verification.ok) {
        throw new Error("Lecture GitHub AROME : HTTP " + verification.status);
    }
    if (verification.status === 404) {
        throw new Error("Branche arome-data absente : publication impossible.");
    }
    const ancien = await verification.json();
    const json = JSON.stringify(cache);
    const octets = Buffer.from(json);
    const empreinte = crypto.createHash("sha1")
        .update("blob " + octets.length + "\0").update(octets).digest("hex");
    if (empreinte !== ancien.sha) {
        const publication = await fetch(fichierUrl, {
            method: "PUT",
            headers: { ...entetes, "Content-Type": "application/json" },
            body: JSON.stringify({
                message: "Update AROME data from Render: " + cache.modele,
                branch: "arome-data",
                sha: ancien.sha,
                content: octets.toString("base64")
            }),
            signal: AbortSignal.timeout(120000)
        });
        if (!publication.ok) {
            const detail = await publication.text();
            throw new Error(
                "Écriture GitHub AROME : HTTP " + publication.status +
                " " + detail.slice(0, 180)
            );
        }
    }
    // Uniquement un workflow de publication du site, jamais un workflow planifié.
    const declenchement = await fetch(
        "https://api.github.com/repos/" + GITHUB_REPOSITORY + "/dispatches", {
            method: "POST",
            headers: { ...entetes, "Content-Type": "application/json" },
            body: JSON.stringify({
                event_type: "arome-cache-updated",
                client_payload: { modele: cache.modele }
            }),
            signal: AbortSignal.timeout(30000)
        }
    );
    if (declenchement.status !== 204) {
        throw new Error(
            "Déploiement Pages non déclenché : HTTP " + declenchement.status
        );
    }
    dernierModeleAromePublie = cache.modele;
    derniereSignatureAromePubliee = signature;
    console.log(
        "AROME publié sur GitHub :", cache.modele,
        bilan.nombre_echeances + " échéances U/V,",
        bilan.nombre_rafales + " rafales"
    );
    return true;
}

function demarrerActualisationArome(lat, lon) {
    // Quand le pilote GRIB2 est actif, ne pas recalculer périodiquement
    // le même modèle via WCS. Le cache WCS reste lisible en secours.
    if (pilotePaquets?.actif) {
        AROME_REFRESH_STATE = {
            status: "standby",
            modele: AROME_CACHE_ZONE?.modele || null,
            erreur: null,
            detail: "WCS en secours ; actualisation GRIB2 prioritaire"
        };
        return false;
    }
    if (AROME_REFRESH_PROMISE) return false;

    AROME_REFRESH_STATE = {
        status: "running",
        modele: null,
        erreur: null
    };

    const url = new URL(
        "/api/arome/previsions",
        `http://127.0.0.1:${PORT}`
    );
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lon));
    url.searchParams.set("refresh", "1");

    AROME_REFRESH_PROMISE = (async () => {
        try {
            const reponse = await fetch(url);
            const resultat = await reponse.json();

            if (!reponse.ok || !resultat.succes) {
                throw new Error(
                    resultat.erreur || "API AROME : HTTP " + reponse.status
                );
            }
            if (resultat.catalogue_indisponible) {
                AROME_REFRESH_STATE = {
                    status: "degraded",
                    modele: resultat.modele || null,
                    erreur: "Catalogue WCS indisponible : ancien cache conservé."
                };
                return;
            }
            if (resultat.ancien_modele) {
                const details = (resultat.erreurs_telechargement || [])
                    .slice(0, 3)
                    .map(e => [e.parametre, e.echeance, e.erreur]
                        .filter(Boolean).join(" : "))
                    .join(" | ");
                AROME_REFRESH_STATE = {
                    status: "degraded",
                    modele: resultat.modele || null,
                    erreur:
                        "Nouveau modèle incomplet (" +
                        (resultat.echeances_nouveau_modele ?? "?") +
                        "/51 échéances U/V), ancien conservé." +
                        (details ? " " + details : "")
                };
                return;
            }
            if (!resultat.modele) {
                throw new Error("Réponse AROME sans identifiant de modèle.");
            }

            const cacheActualise = await chargerCacheArome();
            if (
                !cacheActualise ||
                normaliserModeleArome(cacheActualise.modele) !==
                    normaliserModeleArome(resultat.modele)
            ) {
                throw new Error("Cache AROME actualisé introuvable.");
            }
            const publicationActive = await publierCacheAromeSurGithub(cacheActualise);
            const bilan = evaluerCacheArome(cacheActualise);
            AROME_REFRESH_STATE = {
                status: publicationActive ? "complete" :
                    (AROME_PUBLICATION_GITHUB_AUTORISEE ? "local" : "test"),
                modele: resultat.modele,
                erreur: null,
                echeances: bilan.nombre_echeances,
                rafales: bilan.nombre_rafales
            };
        } catch (error) {
            console.error("Erreur actualisation AROME en arrière-plan :", error);

            AROME_REFRESH_STATE = {
                status: "failed",
                modele: null,
                erreur: error.message
            };
        } finally {
            AROME_REFRESH_PROMISE = null;
        }
    })();
    return true;
}

function verifierAromeEnArrierePlan(lat, lon) {
    if (pilotePaquets?.actif || traitementEnCours()) return false;
    const maintenant = Date.now();
    const intervalleVerification = 15 * 60 * 1000;

    if (
        AROME_REFRESH_PROMISE ||
        maintenant - AROME_DERNIERE_VERIFICATION < intervalleVerification
    ) {
        return false;
    }

    AROME_DERNIERE_VERIFICATION = maintenant;
    demarrerActualisationArome(lat, lon);
    return true;
}

// -------------------------------------------------
// Gestion de erreur
// -------------------------------------------------
async function obtenirCatalogueArome() {

    const maintenant = Date.now();

    if (
        AROME_CATALOGUE_CACHE &&
        maintenant - AROME_CATALOGUE_DATE <
        5 * 60 * 1000
    ) {
        return AROME_CATALOGUE_CACHE;
    }

    console.log(
        "AROME : téléchargement catalogue"
    );

    const urlCatalogue =
        new URL(
            AROME_WCS_BASE +
            "/GetCapabilities"
        );

    urlCatalogue.searchParams.set(
        "service",
        "WCS"
    );

    urlCatalogue.searchParams.set(
        "version",
        "2.0.1"
    );

    urlCatalogue.searchParams.set(
        "request",
        "GetCapabilities"
    );

    const reponseCatalogue =
        await fetch(
            urlCatalogue,
            {
                headers: {
                    apikey:
                        AROME_API_KEY,
                    accept:
                        "application/xml, text/xml, */*"
                }
            }
        );

    if (!reponseCatalogue.ok) {

        throw new Error(
            "Erreur catalogue AROME : "
            + reponseCatalogue.status
        );
    }

    const xmlCatalogue =
        await reponseCatalogue.text();

    AROME_CATALOGUE_CACHE =
        xmlCatalogue;

    AROME_CATALOGUE_DATE =
        maintenant;

    return xmlCatalogue;
}


// --------------------------------------------------
// AROME - ROUTE DES PREVISIONS
// --------------------------------------------------

app.get("/api/arome/previsions", async (req, res) => {
    res.set("Cache-Control", "no-store");
    let libererWcs = null;

    try {
        const lat = Number(req.query.lat ?? POINT_AROME_LA_ROCHELLE.lat);
        const lon = Number(req.query.lon ?? POINT_AROME_LA_ROCHELLE.lon);
        const forceIncompleteRefresh = req.query.refresh === "1";

        if (
            !Number.isFinite(lat) ||
            !Number.isFinite(lon) ||
            lat < 37.5 || lat > 55.4 ||
            lon < -12 || lon > 16
        ) {
            return res.status(400).json({
                succes: false,
                erreur: "Coordonnées GPS invalides"
            });
        }
        // --------------------------------------------------
        // CHARGEMENT DU CACHE AVANT TOUTE REQUETE API
        // --------------------------------------------------

        let cache = await chargerCacheArome();

        const pointDansZone = pointDansZoneArome(cache?.zone, lat, lon);

        if (
            !forceIncompleteRefresh &&
            cache &&
            pointDansZone &&
            Array.isArray(cache.previsions) &&
            cache.previsions.length > 0
        ) {
            const resultat = calculerPrevisionsArome(cache, lat, lon);

            if (resultat.previsions.length > 0) {
                const verificationEnArrierePlan =
                    verifierAromeEnArrierePlan(
                        cache.zone.centreLat,
                        cache.zone.centreLon
                    );

                console.log(
                    "AROME : réponse immédiate depuis le cache",
                    AROME_CACHE_SOURCE,
                    "vérification en arrière-plan :",
                    verificationEnArrierePlan ||
                    Boolean(AROME_REFRESH_PROMISE)
                );

                return res.json({
                    ...resultat,
                    cache: true,
                    origine_cache: AROME_CACHE_SOURCE || "Render",
                    verification_en_arriere_plan:
                        verificationEnArrierePlan ||
                        Boolean(AROME_REFRESH_PROMISE),
                    actualisation_en_cours:
                        Boolean(AROME_REFRESH_PROMISE),
                    actualisation_statut: AROME_REFRESH_STATE.status,
                    erreur_actualisation:
                        AROME_REFRESH_STATE.status === "failed"
                            ? AROME_REFRESH_STATE.erreur
                            : null
                });
            }
        }

        // Si GRIB2 dispose de prévisions, le WCS reste une lecture de secours,
        // pas un second téléchargement déclenché par refresh=1.
        if (pilotePaquets?.estCacheDisponible() && cache && pointDansZone) {
            return res.json({
                ...calculerPrevisionsArome(cache, lat, lon),
                cache: true, origine_cache: AROME_CACHE_SOURCE || "Render",
                wcs_secours: true
            });
        }
        libererWcs = essayerDemarrer("arome-wcs");
        if (!libererWcs) {
            // Interdire les téléchargements lourds simultanés ; le cache
            // ancien reste lisible même pour une requête de rafraîchissement.
            if (cache && pointDansZone) {
                return res.json({
                    ...calculerPrevisionsArome(cache, lat, lon),
                    cache: true, actualisation_differee: true,
                    origine_cache: AROME_CACHE_SOURCE || "Render"
                });
            }
            return res.status(503).json({
                succes: false, erreur: "Calcul WCS différé : " +
                    (traitementEnCours()?.nom || "traitement lourd déjà actif")
            });
        }

        if (!AROME_API_KEY) {
            return res.status(500).json({
                succes: false,
                erreur: "Variable METEO_AROME_API_KEY absente dans Render"
            });
        }

        // --------------------------------------------------
        // RECUPERATION DU MODELE AROME
        // --------------------------------------------------

        let modele = null;
        let coverageU = null;
        let coverageV = null;
        let coverageRafale = null;
        let erreurCatalogue = null;

        try {
            const xmlCatalogue =
                await obtenirCatalogueArome();

            const ids = [
                ...xmlCatalogue.matchAll(
                    /<wcs:CoverageId>([\s\S]*?)<\/wcs:CoverageId>/g
                )
            ].map(m => m[1].trim());

            const prefixU =
                "U_COMPONENT_OF_WIND__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___";

            const prefixV =
                "V_COMPONENT_OF_WIND__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___";

            const prefixRafale =
                "WIND_SPEED_GUST__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___";

            const modelesU = ids
                .filter(id => id.startsWith(prefixU))
                .sort();

            for (let i = modelesU.length - 1; i >= 0; i--) {
                const suffixe = modelesU[i].slice(prefixU.length);
                const idV = prefixV + suffixe;
                const idRafale = prefixRafale + suffixe;

                if (ids.includes(idV)) {
                    modele = suffixe;
                    coverageU = modelesU[i];
                    coverageV = idV;
                    coverageRafale = ids.includes(idRafale)
                        ? idRafale
                        : null;
                    break;
                }
            }
            
            console.log("AROME modèle :", modele);
            console.log("AROME composante U :", coverageU);
            console.log("AROME composante V :", coverageV);
            console.log("AROME rafales :", coverageRafale);

            if (!modele) {
                throw new Error(
                    "Aucun modèle AROME commun aux composantes U et V"
                );
            }

        } catch (error) {
            erreurCatalogue = error;

            console.warn(
                "AROME : catalogue indisponible, vérification du cache",
                error.message
            );
        }


        // --------------------------------------------------
        // CHARGEMENT DU CACHE
        // --------------------------------------------------

        const nouveauModele = !cache ||
            normaliserModeleArome(cache.modele) !== normaliserModeleArome(modele);
        const nouvelleZone = !pointDansZone;
        const cacheAvecRafalesManquantes = Boolean(
            coverageRafale &&
            cache &&
            Array.isArray(cache.previsions) &&
            cache.previsions.some(p => !p?.RAFALE)
        );
        const echeancesMinimum = AROME_ECHEANCES_MINIMUM;
        const cacheIncomplet =
            !cache ||
            !Array.isArray(cache.previsions) ||
            cache.previsions.length < AROME_ECHEANCES_ATTENDUES;

        // Si le modèle change et que le point est dans l'ancienne
        // zone, on conserve le centre de cette zone.
        let centreLat = lat;
        let centreLon = lon;

        if (!nouvelleZone && cache) {
            centreLat = cache.zone.centreLat;
            centreLon = cache.zone.centreLon;
        }

        const telechargementNecessaire =
            nouveauModele ||
            nouvelleZone ||
            cacheAvecRafalesManquantes ||
            (forceIncompleteRefresh && cacheIncomplet);

        // --------------------------------------------------
        // SECOURS : UTILISATION DU CACHE SI LE CATALOGUE EST HS
        // --------------------------------------------------

        if (!modele) {

            if (cache && pointDansZone) {

                console.warn(
                    "AROME : utilisation du cache malgré l'indisponibilité du catalogue"
                );

                const resultat = calculerPrevisionsArome(
                    cache,
                    lat,
                    lon
                );

                return res.json({
                    ...resultat,
                    cache: true,
                    catalogue_indisponible: true,
                    origine_cache: AROME_CACHE_SOURCE || "Render"
                });
            }
            if (cache) {

                console.warn(
                    "AROME : utilisation du cache existant"
                );

                const resultat =
                    calculerPrevisionsArome(
                        cache,
                        lat,
                        lon
                    );

                return res.json({
                    ...resultat,
                    cache: true,
                    catalogue_indisponible: true,
                    origine_cache: AROME_CACHE_SOURCE || "Render"
                });
            }
            throw erreurCatalogue || new Error(
                "Catalogue AROME indisponible et aucun cache utilisable pour ce point"
            );
        }

        if (!telechargementNecessaire) {
            const resultat = calculerPrevisionsArome(cache, lat, lon);

            console.log(
                "AROME : utilisation du cache spatial",
                lat,
                lon
            );

            return res.json({
                ...resultat,
                cache: true,
                origine_cache: AROME_CACHE_SOURCE || "Render"
            });
        }

        const dateInitialisationModele = new Date(
            modele.replace(
                /T(\d{2})\.(\d{2})\.(\d{2})Z$/,
                "T$1:$2:$3Z"
            )
        );

        if (Number.isNaN(dateInitialisationModele.getTime())) {
            throw new Error("Date du modèle AROME invalide");
        }

        // --------------------------------------------------
        // TELECHARGEMENT D'UNE NOUVELLE ZONE
        // --------------------------------------------------

        // Zone AROME de 15 x 15 km
        const tailleZoneKm = 15;
        const kmParDegre = 111.32;

        const ecartLatitude = (tailleZoneKm / 2) / kmParDegre;

        const ecartLongitude =
            ecartLatitude / Math.cos(centreLat * Math.PI / 180);

        const zone = {
            centreLat,
            centreLon,
            latMin: centreLat - ecartLatitude,
            latMax: centreLat + ecartLatitude,
            lonMin: centreLon - ecartLongitude,
            lonMax: centreLon + ecartLongitude
        };

        console.log(
            "AROME : téléchargement nouvelle zone",
            zone,
            "Modèle :",
            modele
        );

        // --------------------------------------------------
        // DECODAGE GRIB2
        // --------------------------------------------------

        function decoderGrib(buffer) {
            if (
                buffer.subarray(0, 4).toString("ascii") !== "GRIB" ||
                buffer[7] !== 2 ||
                buffer.subarray(buffer.length - 4).toString("ascii") !== "7777"
            ) {
                throw new Error("Fichier GRIB2 invalide");
            }

            const sections = {};
            let offset = 16;

            while (offset < buffer.length - 4) {
                const longueur = buffer.readUInt32BE(offset);
                const numero = buffer[offset + 4];

                if (
                    longueur < 5 ||
                    offset + longueur > buffer.length - 4
                ) {
                    throw new Error("Section GRIB invalide");
                }

                sections[numero] = buffer.subarray(
                    offset,
                    offset + longueur
                );

                offset += longueur;
            }

            const s3 = sections[3];
            const s5 = sections[5];
            const s6 = sections[6];
            const s7 = sections[7];

            if (!s3 || !s5 || !s6 || !s7) {
                throw new Error("Section GRIB manquante");
            }

            const grille = {
                modele: s3.readUInt16BE(12),
                Ni: s3.readUInt32BE(30),
                Nj: s3.readUInt32BE(34),
                latitude_depart: s3.readInt32BE(46) / 1000000,
                longitude_depart: s3.readInt32BE(50) / 1000000,
                resolution_longitude: s3.readUInt32BE(63) / 1000000,
                resolution_latitude: s3.readUInt32BE(67) / 1000000,
                mode_balaye: s3[71]
            };

            if (grille.longitude_depart > 180) {
                grille.longitude_depart -= 360;
            }

            if (grille.modele !== 0 || grille.mode_balaye !== 0) {
                throw new Error("Grille GRIB non prise en charge");
            }

            const nombreValeurs = s5.readUInt32BE(5);
            const modeleCompression = s5.readUInt16BE(9);

            if (modeleCompression !== 0) {
                throw new Error(
                    "Compression GRIB non prise en charge : " +
                    modeleCompression
                );
            }

            const reference = s5.readFloatBE(11);

            function facteurSigneMagnitude(valeur) {
                return (valeur & 0x8000)
                    ? -(valeur & 0x7FFF)
                    : valeur;
            }

            const facteurBinaire = facteurSigneMagnitude(
                s5.readUInt16BE(15)
            );

            const facteurDecimal = facteurSigneMagnitude(
                s5.readUInt16BE(17)
            );

            const bitsParValeur = s5[19];

            if (s6[5] !== 255) {
                throw new Error("Bitmap GRIB non pris en charge");
            }

            const donnees = s7.subarray(5);
            const valeurs = [];

            function lireBits(positionBit, nombreBits) {
                let resultat = 0;

                for (let b = 0; b < nombreBits; b++) {
                    const position = positionBit + b;
                    const indexOctet = Math.floor(position / 8);
                    const indexBit = 7 - (position % 8);

                    const bit =
                        (donnees[indexOctet] >> indexBit) & 1;

                    resultat = resultat * 2 + bit;
                }

                return resultat;
            }

            for (let i = 0; i < nombreValeurs; i++) {
                const entier = bitsParValeur === 0
                    ? 0
                    : lireBits(i * bitsParValeur, bitsParValeur);

                valeurs.push(
                    (
                        reference +
                        entier * Math.pow(2, facteurBinaire)
                    ) * Math.pow(10, -facteurDecimal)
                );
            }

            if (valeurs.length !== grille.Ni * grille.Nj) {
                throw new Error(
                    "Nombre de valeurs incompatible avec la grille"
                );
            }

            return { grille, valeurs };
        }

        // --------------------------------------------------
        // TELECHARGEMENT D'UNE ECHEANCE
        // --------------------------------------------------

        async function telechargerGrib(coverageId, echeance) {
            const url = new URL(
                AROME_WCS_BASE + "/GetCoverage"
            );

            url.searchParams.set("service", "WCS");
            url.searchParams.set("version", "2.0.1");
            url.searchParams.set("request", "GetCoverage");
            url.searchParams.set("coverageId", coverageId);

            const dateEcheance = new Date(
                dateInitialisationModele.getTime() + echeance * 1000
            ).toISOString().replace(".000Z", "Z");

            url.searchParams.append("subset", `time(${dateEcheance})`);
            url.searchParams.append("subset", "height(10)");
            url.searchParams.append(
                "subset",
                `lat(${zone.latMin.toFixed(5)},${zone.latMax.toFixed(5)})`
            );
            url.searchParams.append(
                "subset",
                `long(${zone.lonMin.toFixed(5)},${zone.lonMax.toFixed(5)})`
            );

            url.searchParams.set("format", "application/wmo-grib");

            const reponse = await fetch(url, {
                headers: {
                    apikey: AROME_API_KEY,
                    accept: "application/octet-stream"
                }
            });

            if (!reponse.ok) {
                const detail = await reponse.text();
            
                throw new Error(
                    `Erreur GRIB ${coverageId} ` +
                    `H+${echeance / 3600} : ` +
                    `${reponse.status} ` +
                    detail.slice(0, 500)
                );
            }

            const buffer = Buffer.from(
                await reponse.arrayBuffer()
            );

            return decoderGrib(buffer);
        }

        // --------------------------------------------------
        // TELECHARGEMENT DES 51 ECHEANCES
        // --------------------------------------------------

        const echeances = [];

        for (let h = 1; h <= 51; h++) {
            echeances.push(h * 3600);
        }

        const donneesPrevisions = new Map();

        if (
            !nouveauModele &&
            !nouvelleZone &&
            Array.isArray(cache.previsions)
        ) {
            for (const donnees of cache.previsions) {
                if (donnees && Number.isInteger(donnees.seconde)) {
                    donneesPrevisions.set(donnees.seconde, { ...donnees });
                }
            }
        }

        const taches = [];

        for (const seconde of echeances) {
            const donnees = donneesPrevisions.get(seconde);

            if (!donnees?.U) {
                taches.push({
                    seconde,
                    parametre: "U",
                    coverageId: coverageU
                });
            }

            if (!donnees?.V) {
                taches.push({
                    seconde,
                    parametre: "V",
                    coverageId: coverageV
                });
            }

            if (coverageRafale && !donnees?.RAFALE) {
                taches.push({
                    seconde,
                    parametre: "RAFALE",
                    coverageId: coverageRafale
                });
            }
        }

        let indexTache = 0;
        const erreurs = [];

        async function travailleur() {
            while (true) {
                const index = indexTache++;

                if (index >= taches.length) return;

                const tache = taches[index];

                try {
                    const resultat = await telechargerGrib(
                        tache.coverageId,
                        tache.seconde
                    );

                    const cle = tache.seconde;

                    if (!donneesPrevisions.has(cle)) {
                        donneesPrevisions.set(cle, {
                            seconde: cle,
                            U: null,
                            V: null,
                            RAFALE: null
                        });
                    }

                    donneesPrevisions.get(cle)[tache.parametre] = resultat;

                } catch (error) {
                    erreurs.push({
                        echeance: "H+" + tache.seconde / 3600,
                        parametre: tache.parametre,
                        erreur: error.message
                    });
                }
            }
        }

        await Promise.all(
            Array.from({ length: 2 }, () => travailleur())
        );

        // --------------------------------------------------
        // VERIFICATION DES GRILLES U ET V
        // --------------------------------------------------

        const previsionsCache = [];

        for (const seconde of echeances) {
            const donnees = donneesPrevisions.get(seconde);

            if (!donnees || !donnees.U || !donnees.V) {
                continue;
            }

            const gU = donnees.U.grille;
            const gV = donnees.V.grille;

            if (
                gU.Ni !== gV.Ni ||
                gU.Nj !== gV.Nj ||
                Math.abs(
                    gU.latitude_depart - gV.latitude_depart
                ) > 0.000001 ||
                Math.abs(
                    gU.longitude_depart - gV.longitude_depart
                ) > 0.000001
            ) {
                erreurs.push({
                    echeance: "H+" + seconde / 3600,
                    erreur: "Les grilles U et V sont différentes"
                });

                continue;
            }

            if (donnees.RAFALE) {
                const gRafale = donnees.RAFALE.grille;

                if (
                    gU.Ni !== gRafale.Ni ||
                    gU.Nj !== gRafale.Nj ||
                    Math.abs(
                        gU.latitude_depart - gRafale.latitude_depart
                    ) > 0.000001 ||
                    Math.abs(
                        gU.longitude_depart - gRafale.longitude_depart
                    ) > 0.000001
                ) {
                    erreurs.push({
                        echeance: "H+" + seconde / 3600,
                        parametre: "RAFALE",
                        erreur: "La grille de rafales diffère de la grille U/V"
                    });

                    donnees.RAFALE = null;
                }
            }

            previsionsCache.push(donnees);
        }

        // Exiger le vent U/V : les rafales et les échéances lointaines sont facultatives.
        const bilanNouveauModele = evaluerCacheArome({ previsions: previsionsCache });
        if (!bilanNouveauModele.valide) {
            const erreurCompleteness =
                `Cache AROME insuffisant : ${bilanNouveauModele.nombre_echeances}/` +
                `${echeances.length} échéances U/V (` +
                `minimum ${AROME_ECHEANCES_MINIMUM_PUBLICATION}, ` +
                `H+1 à H+6 obligatoires). ` +
                `${bilanNouveauModele.nombre_rafales} rafales disponibles.`;

            console.error(
                "AROME :",
                erreurCompleteness,
                erreurs.slice(0, 3)
            );

            if (cache && pointDansZone) {
                console.warn(
                    "AROME : conservation de l'ancien cache après " +
                    "échec de validation du nouveau modèle"
                );
        
                const resultatSecours = calculerPrevisionsArome(
                    cache,
                    lat,
                    lon
                );
        
                return res.json({
                    ...resultatSecours,
                    cache: true,
                    ancien_modele: true,
                    nouveau_modele_indisponible: modele,
                    actualisation_incomplete: true,
                    echeances_nouveau_modele: previsionsCache.length,
                    echeances_minimum: echeancesMinimum,
                    erreurs_telechargement: erreurs,
                    origine_cache: AROME_CACHE_SOURCE || "Render"
                });
            }
        
            throw new Error(
                erreurCompleteness + ". " +
                erreurs
                    .slice(0, 3)
                    .map(e =>
                        `${e.parametre || "?"} ${e.echeance} : ${e.erreur}`
                    )
                    .join(" | ")
            );
        }

        // --------------------------------------------------
        // ENREGISTREMENT DU NOUVEAU CACHE
        // --------------------------------------------------

        const nouveauCache = {
            modele: normaliserModeleArome(modele),
            date: Date.now(),
            zone,
            previsions: previsionsCache,
            erreurs,
            actualisation_incomplete:
                bilanNouveauModele.nombre_echeances < AROME_ECHEANCES_ATTENDUES ||
                bilanNouveauModele.nombre_rafales < bilanNouveauModele.nombre_echeances
        };

        await sauvegarderCacheArome(nouveauCache);

        // --------------------------------------------------
        // CALCUL POUR LE POINT DEMANDE
        // --------------------------------------------------

        const resultat = calculerPrevisionsArome(
            nouveauCache,
            lat,
            lon
        );

        console.log(
            "AROME :",
            resultat.nombre_echeances,
            "échéances disponibles sur",
            lat,
            lon
        );

        res.json({
            ...resultat,
            cache: false,
            actualisation_incomplete: nouveauCache.actualisation_incomplete,
            echeances_nouveau_modele: bilanNouveauModele.nombre_echeances,
            rafales_nouveau_modele: bilanNouveauModele.nombre_rafales,
            echeances_minimum: AROME_ECHEANCES_MINIMUM_PUBLICATION
        });

    } catch (error) {
        console.error("Erreur prévisions AROME :", error);

        res.status(502).json({
            succes: false,
            erreur: error.message
        });
    } finally {
        libererWcs?.();
    }
});

app.post("/api/arome/cache/refresh", async (req, res) => {
    if (!verifierJetonActualisation(req, res)) return;

    const lance = demarrerActualisationArome(46.178, -1.193167);
    return res.status(lance ? 202 : 200).json(AROME_REFRESH_STATE);
});

app.get("/api/arome/cache/status", (req, res) => {
    if (!verifierJetonActualisation(req, res)) return;

    return res.json(AROME_REFRESH_STATE);
});

app.get("/api/arome/cache/public", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
        const cache = await chargerCacheArome();
        if (
            !cache ||
            typeof cache.modele !== "string" ||
            !cache.zone ||
            !Array.isArray(cache.previsions) ||
            !cache.previsions.some(p => p?.U && p?.V)
        ) {
            return res.status(503).json({
                succes: false,
                erreur: "Aucun cache AROME exploitable."
            });
        }
        return res.json({
            ...cache,
            origine_cache: AROME_CACHE_SOURCE === "Render"
                ? "Render test" : "GitHub Pages"
        });
    } catch (error) {
        console.error("Erreur lecture publique du cache AROME :", error);
        return res.status(502).json({
            succes: false,
            erreur: "Cache AROME indisponible."
        });
    }
});

app.get("/api/arome/cache/export", async (req, res) => {
    if (!verifierJetonActualisation(req, res)) return;

    try {
        const cache = await chargerCacheArome();

        if (!cache) {
            return res.status(404).json({
                succes: false,
                erreur: "Aucun cache AROME disponible"
            });
        }

        const nombreEcheances = Array.isArray(cache.previsions)
            ? cache.previsions.length
            : 0;

        if (
            typeof cache.modele !== "string" ||
            !cache.zone ||
            nombreEcheances < AROME_ECHEANCES_MINIMUM
        ) {
            return res.status(503).json({
                succes: false,
                erreur:
                    `Cache AROME incomplet : ${nombreEcheances}/` +
                    `${AROME_ECHEANCES_ATTENDUES} échéances valides; ` +
                    `${AROME_ECHEANCES_MINIMUM} minimum requis`
            });
        }

        res.set("Cache-Control", "no-store");
        return res.json(cache);
    } catch (error) {
        console.error("Erreur export du cache AROME :", error);

        return res.status(502).json({
            succes: false,
            erreur: error.message
        });
    }
});


// État non sensible des caches : utile pour contrôler Render et le NAS.
app.get("/api/meteo/status", (req, res) => {
    res.set("Cache-Control", "no-store");
    return res.json({
        traitement_lourd: traitementEnCours(),
        memoire_node_mio: {
            rss: Math.round(process.memoryUsage().rss / 1048576),
            heap: Math.round(process.memoryUsage().heapUsed / 1048576)
        },
        keepalive: dernierControleKeepalive
            ? new Date(dernierControleKeepalive).toISOString() : null,
        radar: {
            date: radarProduitCache?.date || null,
            tuiles_en_cache: radarTuilesCache.size
        },
        observations: {
            en_cache: Boolean(observationsCache),
            derniere_verification: observationsCache
                ? new Date(observationsCache.verifieLe).toISOString() : null
        },
        arome: {
            modele: AROME_CACHE_ZONE?.modele || null,
            publication_configuree: Boolean(
                process.env.GITHUB_DATA_TOKEN || GITHUB_ACTIONS_TOKEN
            ),
            dernier_modele_publie: dernierModeleAromePublie,
            publication_active: AROME_PUBLICATION_GITHUB_AUTORISEE,
            echeances_cache: AROME_CACHE_ZONE
                ? evaluerCacheArome(AROME_CACHE_ZONE).nombre_echeances : null,
            rafales_cache: AROME_CACHE_ZONE
                ? evaluerCacheArome(AROME_CACHE_ZONE).nombre_rafales : null,
            actualisation: AROME_REFRESH_STATE.status,
            derniere_erreur: AROME_REFRESH_STATE.erreur,
            echeances_actualisation: AROME_REFRESH_STATE.echeances || null
        }
    });
});

// --------------------------------------------------
// DEMARRAGE SERVEUR
// --------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Application disponible sur le port ${PORT}`);
});
