require("dotenv").config();

const express = require("express");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const proj4 = require("proj4");
const { PNG } = require("pngjs");

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

// Centre de la carte : La Rochelle
const CENTRE_LAT = 46.178;
const CENTRE_LON = -1.193167;

// Rayon de la zone radar
const RAYON_RADAR = 25000;

// Taille de l'image PNG
const IMAGE_TAILLE = 512;

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

async function obtenirProduitRadar() {
    const catalogueResponse = await fetch(RADAR_CATALOGUE, {
        headers: {
            apikey: RADAR_API_KEY,
            accept: "application/json"
        }
    });

    if (!catalogueResponse.ok) {
        throw new Error(
            "Erreur catalogue radar : " + catalogueResponse.status
        );
    }

    const catalogue = await catalogueResponse.json();

    const produit = catalogue.links.find(link =>
        link.href.includes("maille=500")
    );

    if (!produit) {
        throw new Error("Produit radar 500 m introuvable");
    }

    const response = await fetch(produit.href, {
        headers: {
            apikey: RADAR_API_KEY,
            accept: "*/*"
        }
    });

    if (!response.ok) {
        throw new Error(
            "Erreur téléchargement radar : " + response.status
        );
    }

    return {
        buffer: Buffer.from(await response.arrayBuffer()),
        date: produit.validity_time
    };
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
// GENERATION DE L'IMAGE RADAR
// --------------------------------------------------

async function genererImageRadar(
    centreLat = 46.178,
    centreLon = -1.193167
) {
    let fichierHdf;
    let fichierTemporaire;

    try {
        // Téléchargement de la dernière mosaïque
        const produit = await obtenirProduitRadar();

        fichierTemporaire = path.join(
            os.tmpdir(),
            "radar-" + crypto.randomUUID() + ".h5"
        );

        await fs.writeFile(fichierTemporaire, produit.buffer);

        // Lecture HDF5
        const h5wasm = await import("h5wasm/node");
        await h5wasm.ready;

        fichierHdf = new h5wasm.File(fichierTemporaire, "r");

        // Données radar
        const datasetPluie = fichierHdf.get(
            "/dataset1/data1/data"
        );

        const datasetQualite = fichierHdf.get(
            "/dataset1/data1/quality1/data"
        );

        const valeursPluie = datasetPluie.value;
        const valeursQualite = datasetQualite.value;

        const hauteur = datasetPluie.shape[0];
        const largeur = datasetPluie.shape[1];

        // Métadonnées géographiques
        const where = fichierHdf.get("/where");

        const xScale = valeurAttribut(where, "xscale");
        const yScale = valeurAttribut(where, "yscale");

        const longitudeLL = valeurAttribut(where, "LL_lon");
        const latitudeLL = valeurAttribut(where, "LL_lat");

        // Projection radar Météo-France
        const definitionProjection =
            "+proj=stere +lat_0=90 +lon_0=0 +lat_ts=45 " +
            "+ellps=WGS84 +x_0=619652.07 +y_0=5262818.34 " +
            "+datum=WGS84 +units=m +no_defs";

        proj4.defs("RADAR_METEO", definitionProjection);

        const projection = "RADAR_METEO";

        // Origine de la grille : coin inférieur gauche
        const origine = proj4(
            "EPSG:4326",
            projection,
            [longitudeLL, latitudeLL]
        );

        const origineX = origine[0];
        const origineY = origine[1];

        // Centre de La Rochelle dans la projection radar
        const centre = proj4(
            "EPSG:4326",
            projection,
            [centreLon, centreLat]
        );

        const centreX = centre[0];
        const centreY = centre[1];

        // Carré de 50 km autour du centre
        const minX = centreX - RAYON_RADAR;
        const maxX = centreX + RAYON_RADAR;
        const minY = centreY - RAYON_RADAR;
        const maxY = centreY + RAYON_RADAR;

        // Conversion des quatre coins en coordonnées géographiques
        const coins = [
            proj4(projection, "EPSG:4326", [minX, minY]),
            proj4(projection, "EPSG:4326", [maxX, minY]),
            proj4(projection, "EPSG:4326", [minX, maxY]),
            proj4(projection, "EPSG:4326", [maxX, maxY])
        ];

        const longitudes = coins.map(point => point[0]);
        const latitudes = coins.map(point => point[1]);

        const ouest = Math.min(...longitudes);
        const est = Math.max(...longitudes);
        const sud = Math.min(...latitudes);
        const nord = Math.max(...latitudes);

        // Création du PNG transparent
        const png = new PNG({
            width: IMAGE_TAILLE,
            height: IMAGE_TAILLE
        });

        // Parcours de chaque pixel de l'image
        for (let py = 0; py < IMAGE_TAILLE; py++) {
            for (let px = 0; px < IMAGE_TAILLE; px++) {

                const longitude =
                    ouest + (px + 0.5) / IMAGE_TAILLE * (est - ouest);

                const latitude =
                    nord - (py + 0.5) / IMAGE_TAILLE * (nord - sud);

                // Coordonnées dans la projection radar
                const coord = proj4(
                    "EPSG:4326",
                    projection,
                    [longitude, latitude]
                );

                const x = coord[0];
                const y = coord[1];

                // Découpage circulaire de 25 km
                const distance = Math.hypot(
                    x - centreX,
                    y - centreY
                );

                const indexPNG = (py * IMAGE_TAILLE + px) * 4;

                if (distance > RAYON_RADAR) {
                    continue;
                }

                // Conversion coordonnées -> pixel source
                const colonne = Math.floor(
                    (x - origineX) / xScale
                );

                const ligne = Math.floor(
                    (origineY + hauteur * yScale - y) / yScale
                );

                // Vérification des limites
                if (
                    colonne < 0 ||
                    colonne >= largeur ||
                    ligne < 0 ||
                    ligne >= hauteur
                ) {
                    continue;
                }

                const indexSource = ligne * largeur + colonne;

                const valeurBrute = valeursPluie[indexSource];
                const qualite = valeursQualite[indexSource];

                // Valeurs manquantes ou non exploitables
                if (
                    valeurBrute === 65535 ||
                    valeurBrute === 65534 ||
                    qualite === 255 ||
                    qualite <= 0
                ) {
                    continue;
                }

                // Conversion en mm / 5 minutes
                const pluie = valeurBrute * 0.01;

                const couleur = couleurRadar(pluie);

                png.data[indexPNG] = couleur[0];
                png.data[indexPNG + 1] = couleur[1];
                png.data[indexPNG + 2] = couleur[2];
                png.data[indexPNG + 3] = couleur[3];
            }
        }

        return {
            image: PNG.sync.write(png),
            date: produit.date,
            bounds: {
                sud,
                ouest,
                nord,
                est
            }
        };

    } finally {
        if (fichierHdf) {
            try {
                fichierHdf.close();
            } catch (error) {
                console.error("Fermeture HDF5 :", error.message);
            }
        }

        if (fichierTemporaire) {
            try {
                await fs.unlink(fichierTemporaire);
            } catch (error) {
                console.error("Suppression temporaire :", error.message);
            }
        }
    }
}

// --------------------------------------------------
// FICHIERS PUBLICS
// --------------------------------------------------

app.use(express.static("public"));

// --------------------------------------------------
// OBSERVATIONS METEO
// --------------------------------------------------

app.get("/api/observations", async (req, res) => {
    try {
        const url = new URL(
            "https://public-api.meteofrance.fr/public/DPPaquetObs/v2/paquet/infrahoraire-6m"
        );

        url.searchParams.set("id_station", "17300009");
        url.searchParams.set("format", "json");

        const response = await fetch(url, {
            headers: {
                accept: "*/*",
                apikey: API_KEY
            }
        });

        const data = await response.text();

        if (!response.ok) {
            console.error("Erreur Météo-France :", response.status, data);
            return res.status(response.status).send(data);
        }

        const observations = JSON.parse(data);

        console.log("Nombre de relevés :", observations.length);

        res.json(observations);

    } catch (error) {
        console.error(error);
        res.status(502).json({ error: error.message });
    }
});

// --------------------------------------------------
// Reveil du serveur (depuis nas)
// --------------------------------------------------

// --------------------------------------------------
// DECLENCHEMENT A LA DEMANDE DES MISES A JOUR METEO
// --------------------------------------------------

const GITHUB_ACTIONS_TOKEN = process.env.GITHUB_ACTIONS_TOKEN;
const GITHUB_REPOSITORY = "alexandreguilloux85/meteo-la-rochelle";
const GITHUB_BRANCH = "main";
const DELAI_MINIMUM_ACTUALISATION_METEO = 10 * 60 * 1000;
const DECLENCHEMENTS_WORKFLOWS = Object.freeze({
    arome: "publish-arome-cache.yml"
});
const declenchementsWorkflowsEnCours = new Set();

app.post("/api/workflows/:workflow", async (req, res) => {
    res.set("Cache-Control", "no-store");

    if (req.get("origin") !== "https://alexandreguilloux85.github.io") {
        return res.status(403).json({
            succes: false,
            erreur: "Origine non autorisée"
        });
    }

    if (!Object.hasOwn(DECLENCHEMENTS_WORKFLOWS, req.params.workflow)) {
        return res.status(404).json({
            succes: false,
            erreur: "Workflow inconnu"
        });
    }
    const fichierWorkflow = DECLENCHEMENTS_WORKFLOWS[req.params.workflow];

    if (!GITHUB_ACTIONS_TOKEN) {
        return res.status(503).json({
            succes: false,
            erreur: "Variable GITHUB_ACTIONS_TOKEN absente dans Render"
        });
    }

    if (declenchementsWorkflowsEnCours.has(fichierWorkflow)) {
        return res.status(409).json({
            succes: false,
            erreur: "Ce workflow est déjà en cours de déclenchement."
        });
    }

    declenchementsWorkflowsEnCours.add(fichierWorkflow);

    try {
        const workflowUrl =
            `https://api.github.com/repos/${GITHUB_REPOSITORY}` +
            `/actions/workflows/${fichierWorkflow}`;
        const runsResponse = await fetch(
            `${workflowUrl}/runs?branch=${GITHUB_BRANCH}&per_page=20`,
            {
                headers: {
                    "Accept": "application/vnd.github+json",
                    "Authorization": `Bearer ${GITHUB_ACTIONS_TOKEN}`,
                    "X-GitHub-Api-Version": "2022-11-28"
                }
            }
        );

        if (!runsResponse.ok) {
            console.error(
                `Vérification des exécutions ${fichierWorkflow} impossible : HTTP ${runsResponse.status}`
            );
            return res.status(502).json({
                succes: false,
                erreur: "Impossible de vérifier l'état du workflow sur GitHub."
            });
        }

        const runsResult = await runsResponse.json();
        const runs = Array.isArray(runsResult.workflow_runs)
            ? runsResult.workflow_runs
            : [];
        const runActive = runs.find(run =>
            run.status === "queued" || run.status === "in_progress"
        );

        if (runActive) {
            return res.status(409).json({
                succes: false,
                erreur: "Ce workflow est déjà en attente ou en cours sur GitHub."
            });
        }

        const derniereDemande = runs.find(run =>
            run.event === "workflow_dispatch"
        );
        const ageDerniereDemande = derniereDemande
            ? Date.now() - new Date(derniereDemande.created_at).getTime()
            : Number.POSITIVE_INFINITY;

        if (ageDerniereDemande < DELAI_MINIMUM_ACTUALISATION_METEO) {
            const prochainDeclenchement = new Date(
                new Date(derniereDemande.created_at).getTime() +
                    DELAI_MINIMUM_ACTUALISATION_METEO
            );
            return res.status(429).json({
                succes: false,
                erreur: "Ce workflow a été demandé récemment. Réessaie dans quelques minutes.",
                prochain_declenchement_possible: prochainDeclenchement.toISOString()
            });
        }

        const url = `https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/${fichierWorkflow}/dispatches`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Accept": "application/vnd.github+json",
                "Authorization": `Bearer ${GITHUB_ACTIONS_TOKEN}`,
                "X-GitHub-Api-Version": "2022-11-28",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ ref: GITHUB_BRANCH })
        });

        if (response.status !== 204) {
            console.error(
                `Échec du déclenchement ${fichierWorkflow} : HTTP ${response.status}`
            );
            return res.status(502).json({
                succes: false,
                erreur: `GitHub n'a pas accepté le déclenchement (${response.status}).`
            });
        }

        return res.status(202).json({
            succes: true,
            message: "Workflow déclenché.",
            workflow: fichierWorkflow
        });
    } catch (error) {
        console.error(`Erreur déclenchement ${fichierWorkflow} :`, error);
        return res.status(502).json({
            succes: false,
            erreur: "Impossible de joindre GitHub pour déclencher le workflow."
        });
    } finally {
        declenchementsWorkflowsEnCours.delete(fichierWorkflow);
    }
});

app.get("/api/refresh-weather", (req, res) => {
    return res.status(410).json({
        succes: false,
        erreur: "Utilise un bouton d'actualisation du site."
    });
});

// Vérification légère pour maintenir Render actif
app.get("/api/keepalive", (req, res) => {
    res.status(200).send("OK");
});





// --------------------------------------------------
// IMAGE RADAR PNG
// --------------------------------------------------

app.get("/api/radar/image", async (req, res) => {

    const lat = Number(
        req.query.lat ?? CENTRE_LAT
    );

    const lon = Number(
        req.query.lon ?? CENTRE_LON
    );

    try {

        console.log(
            "Génération radar",
            lat,
            lon
        );

        const resultat =
            await genererImageRadar(
                lat,
                lon
            );

        res.set({
            "Content-Type": "image/png",
            "Cache-Control": "no-store",
            "X-Radar-Date": resultat.date || "",
            "X-Radar-Bounds":
                JSON.stringify(
                    resultat.bounds
                )
        });

        res.send(
            resultat.image
        );

    } catch (error) {

        console.error(
            "Erreur image radar :",
            error
        );

        res.status(502).json({
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
    const fichierTemporaire = AROME_CACHE_FILE + ".tmp";

    await fs.writeFile(
        fichierTemporaire,
        JSON.stringify(cache)
    );

    await fs.rename(
        fichierTemporaire,
        AROME_CACHE_FILE
    );

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

function demarrerActualisationArome(lat, lon) {
    if (AROME_REFRESH_PROMISE) return;

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

            if (
                !reponse.ok ||
                !resultat.succes ||
                !resultat.modele ||
                resultat.catalogue_indisponible ||
                resultat.ancien_modele
            ) {
                throw new Error(
                    resultat.erreur ||
                    "Echec de la vérification du catalogue AROME"
                );
            }

            AROME_REFRESH_STATE = {
                status: "complete",
                modele: resultat.modele,
                erreur: null
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
}

function verifierAromeEnArrierePlan(lat, lon) {
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

    try {
        const lat = Number(req.query.lat ?? 46.178);
        const lon = Number(req.query.lon ?? -1.193167);
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

        const pointDansZone = cache &&
            lat >= cache.zone.latMin &&
            lat <= cache.zone.latMax &&
            lon >= cache.zone.lonMin &&
            lon <= cache.zone.lonMax;

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

        const nouveauModele = !cache || cache.modele !== modele;
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

        if (previsionsCache.length < echeancesMinimum) {
            const erreurCompleteness =
                `Cache AROME incomplet : ${previsionsCache.length}/` +
                `${echeances.length} échéances valides, ` +
                `${echeancesMinimum} minimum requis`;

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
            modele,
            date: Date.now(),
            zone,
            previsions: previsionsCache,
            erreurs
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
            actualisation_incomplete:
                previsionsCache.length < AROME_ECHEANCES_ATTENDUES,
            echeances_nouveau_modele: previsionsCache.length,
            echeances_minimum: echeancesMinimum
        });

    } catch (error) {
        console.error("Erreur prévisions AROME :", error);

        res.status(502).json({
            succes: false,
            erreur: error.message
        });
    }
});

app.post("/api/arome/cache/refresh", async (req, res) => {
    if (!verifierJetonActualisation(req, res)) return;

    demarrerActualisationArome(46.178, -1.193167);

    return res.status(202).json(AROME_REFRESH_STATE);
});

app.get("/api/arome/cache/status", (req, res) => {
    if (!verifierJetonActualisation(req, res)) return;

    return res.json(AROME_REFRESH_STATE);
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


// --------------------------------------------------
// DEMARRAGE SERVEUR
// --------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Application disponible sur le port ${PORT}`);
});
