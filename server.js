require("dotenv").config();

const express = require("express");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const proj4 = require("proj4");
const { PNG } = require("pngjs");

const app = express();
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

async function genererImageRadar() {
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
            [CENTRE_LON, CENTRE_LAT]
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

// Vérification légère pour maintenir Render actif
app.get("/api/keepalive", (req, res) => {
    res.status(200).send("OK");
});

// --------------------------------------------------
// CATALOGUE RADAR
// --------------------------------------------------

app.get("/api/radar/disponibilite", async (req, res) => {
    try {
        const response = await fetch(RADAR_CATALOGUE, {
            headers: {
                apikey: RADAR_API_KEY,
                accept: "application/json"
            }
        });

        const data = await response.text();

        if (!response.ok) {
            return res.status(response.status).send(data);
        }

        res.type("application/json").send(data);

    } catch (error) {
        console.error(error);
        res.status(502).json({ erreur: error.message });
    }
});

// --------------------------------------------------
// TEST TELECHARGEMENT DU PRODUIT RADAR
// --------------------------------------------------

app.get("/api/radar/test-produit", async (req, res) => {
    try {
        const produit = await obtenirProduitRadar();

        res.json({
            succes: true,
            date: produit.date,
            taille_octets: produit.buffer.length,
            taille_Mo: (
                produit.buffer.length / 1048576
            ).toFixed(2)
        });

    } catch (error) {
        console.error("Test radar :", error);

        res.status(502).json({
            succes: false,
            erreur: error.message
        });
    }
});

// --------------------------------------------------
// ANALYSE DU FICHIER HDF5
// --------------------------------------------------

app.get("/api/radar/analyse", async (req, res) => {
    let fichierTemporaire;
    let fichierHdf;

    try {
        const produit = await obtenirProduitRadar();

        fichierTemporaire = path.join(
            os.tmpdir(),
            "radar-" + crypto.randomUUID() + ".h5"
        );

        await fs.writeFile(fichierTemporaire, produit.buffer);

        const h5wasm = await import("h5wasm/node");
        await h5wasm.ready;

        fichierHdf = new h5wasm.File(fichierTemporaire, "r");

        const elements = [];

        function explorer(noeud, chemin = "/") {
            if (elements.length >= 300) return;

            let attributs = {};

            if (noeud.attrs) {
                for (const nom of Object.keys(noeud.attrs)) {
                    attributs[nom] = noeud.attrs[nom].value;
                }
            }

            if (noeud.metadata) {
                elements.push({
                    chemin,
                    type: "dataset",
                    dimensions: Array.from(noeud.shape || []),
                    dtype: noeud.dtype,
                    metadata: noeud.metadata,
                    attributs
                });

                return;
            }

            elements.push({
                chemin,
                type: "groupe",
                attributs
            });

            if (typeof noeud.keys === "function") {
                for (const nom of noeud.keys()) {
                    const enfant = noeud.get(nom);
                    const cheminEnfant =
                        chemin === "/" ? "/" + nom : chemin + "/" + nom;

                    explorer(enfant, cheminEnfant);

                    if (elements.length >= 300) break;
                }
            }
        }

        explorer(fichierHdf);

        res.json(convertirJSON({
            succes: true,
            date: produit.date,
            taille_Mo: (
                produit.buffer.length / 1048576
            ).toFixed(2),
            nombre_elements: elements.length,
            elements
        }));

    } catch (error) {
        console.error("Analyse HDF5 :", error);

        res.status(502).json({
            succes: false,
            erreur: error.message
        });

    } finally {
        if (fichierHdf) {
            try {
                fichierHdf.close();
            } catch (error) {
                console.error(error.message);
            }
        }

        if (fichierTemporaire) {
            try {
                await fs.unlink(fichierTemporaire);
            } catch (error) {
                console.error(error.message);
            }
        }
    }
});

// --------------------------------------------------
// IMAGE RADAR PNG
// --------------------------------------------------

app.get("/api/radar/image", async (req, res) => {
    try {
        console.log("Génération de l'image radar...");

        const resultat = await genererImageRadar();

        res.set({
            "Content-Type": "image/png",
            "Cache-Control": "no-store",
            "X-Radar-Date": resultat.date || "",
            "X-Radar-Bounds": JSON.stringify(resultat.bounds)
        });

        res.send(resultat.image);

        console.log("Image radar générée :", resultat.date);

    } catch (error) {
        console.error("Erreur image radar :", error);

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

const AROME_WCS_BASE =
    "https://public-api.meteofrance.fr/public/arome/1.0/wcs/" +
    "MF-NWP-HIGHRES-AROME-001-FRANCE-WCS";

app.get("/api/arome/capabilities", async (req, res) => {
    try {
        if (!AROME_API_KEY) {
            return res.status(500).json({
                succes: false,
                erreur: "Variable METEO_AROME_API_KEY absente dans Render"
            });
        }

        const url = new URL(AROME_WCS_BASE + "/GetCapabilities");
        url.searchParams.set("service", "WCS");
        url.searchParams.set("version", "2.0.1");
        url.searchParams.set("request", "GetCapabilities");
        url.searchParams.set("language", "eng");

        const response = await fetch(url, {
            headers: {
                apikey: AROME_API_KEY,
                accept: "application/xml, text/xml, */*"
            }
        });

        const xml = await response.text();

        if (!response.ok) {
            console.error(
                "AROME GetCapabilities :",
                response.status,
                xml.slice(0, 1000)
            );

            return res.status(response.status).json({
                succes: false,
                statut: response.status,
                erreur: "Météo-France a refusé la requête GetCapabilities",
                detail: xml.slice(0, 1200)
            });
        }

        const coverages = [];
        const blocs = xml.match(
            /<wcs:CoverageSummary[\s\S]*?<\/wcs:CoverageSummary>/g
        ) || [];

        for (const bloc of blocs) {
            const id = bloc.match(
                /<wcs:CoverageId>([\s\S]*?)<\/wcs:CoverageId>/
            );

            const titre = bloc.match(
                /<ows:Title>([\s\S]*?)<\/ows:Title>/
            );

            if (id) {
                const coverageId = id[1].trim();

                if (
                    /WIND|U_COMPONENT|V_COMPONENT/i.test(
                        coverageId + " " + (titre?.[1] || "")
                    )
                ) {
                    coverages.push({
                        id: coverageId,
                        titre: titre ? titre[1].trim() : ""
                    });
                }
            }
        }

        res.json({
            succes: true,
            nombre: coverages.length,
            coverages
        });

    } catch (error) {
        console.error("Erreur AROME GetCapabilities :", error);

        res.status(502).json({
            succes: false,
            erreur: error.message
        });
    }
});

// --------------------------------------------------
// AROME - DESCRIPTION DES DONNEES DE VENT
// --------------------------------------------------

app.get("/api/arome/description", async (req, res) => {
    try {
        if (!AROME_API_KEY) {
            return res.status(500).json({
                succes: false,
                erreur: "Variable METEO_AROME_API_KEY absente"
            });
        }

        // Récupération du catalogue
        const urlCatalogue = new URL(
            AROME_WCS_BASE + "/GetCapabilities"
        );

        urlCatalogue.searchParams.set("service", "WCS");
        urlCatalogue.searchParams.set("version", "2.0.1");
        urlCatalogue.searchParams.set("request", "GetCapabilities");
        urlCatalogue.searchParams.set("language", "eng");

        const reponseCatalogue = await fetch(urlCatalogue, {
            headers: {
                apikey: AROME_API_KEY,
                accept: "application/xml, text/xml, */*"
            }
        });

        if (!reponseCatalogue.ok) {
            throw new Error(
                "Erreur catalogue AROME : " + reponseCatalogue.status
            );
        }

        const xmlCatalogue = await reponseCatalogue.text();

        // Recherche des couvertures WIND_SPEED
        const ids = [
            ...xmlCatalogue.matchAll(
                /<wcs:CoverageId>([\s\S]*?)<\/wcs:CoverageId>/g
            )
        ].map(m => m[1].trim());

        const vents = ids.filter(id =>
            id.startsWith("WIND_SPEED__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___")
        );

        if (vents.length === 0) {
            throw new Error("Aucune couverture WIND_SPEED trouvée");
        }

        // La dernière couverture disponible
        const coverageId = vents[vents.length - 1];

        // Description de cette couverture
        const urlDescription = new URL(
            AROME_WCS_BASE + "/DescribeCoverage"
        );

        urlDescription.searchParams.set("service", "WCS");
        urlDescription.searchParams.set("version", "2.0.1");
        urlDescription.searchParams.set("request", "DescribeCoverage");
        urlDescription.searchParams.set("coverageID", coverageId);

        const reponseDescription = await fetch(urlDescription, {
            headers: {
                apikey: AROME_API_KEY,
                accept: "application/xml, text/xml, */*"
            }
        });

        const xmlDescription = await reponseDescription.text();

        if (!reponseDescription.ok) {
            throw new Error(
                "Erreur DescribeCoverage : " +
                reponseDescription.status +
                " - " + xmlDescription.slice(0, 1000)
            );
        }

        res.json({
            succes: true,
            coverageId,
            description: xmlDescription
        });

    } catch (error) {
        console.error("Erreur description AROME :", error);

        res.status(502).json({
            succes: false,
            erreur: error.message
        });
    }
});



// --------------------------------------------------
// AROME - CACHE SPATIAL DES PREVISIONS
// --------------------------------------------------

const AROME_CACHE_FILE = path.join(__dirname, "arome-cache.json");

let AROME_CACHE_ZONE = null;
let AROME_CACHE_CHARGEMENT = null;
let AROME_OPERATION_EN_COURS = false;

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

    await fs.rename(fichierTemporaire, AROME_CACHE_FILE);

    AROME_CACHE_ZONE = cache;

    console.log(
        "Cache AROME sauvegardé :",
        cache.modele,
        cache.previsions.length,
        "échéances"
    );
}

// --------------------------------------------------
// AROME - ROUTE DES PREVISIONS
// --------------------------------------------------

app.get("/api/arome/previsions", async (req, res) => {
    try {
        if (!AROME_API_KEY) {
            return res.status(500).json({
                succes: false,
                erreur: "Variable METEO_AROME_API_KEY absente dans Render"
            });
        }

        const lat = Number(req.query.lat ?? 46.178);
        const lon = Number(req.query.lon ?? -1.193167);

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

        // --------------------------------------------------
        // RECUPERATION DU MODELE AROME
        // --------------------------------------------------

        let modele = null;
        let coverageU = null;
        let coverageV = null;
        let erreurCatalogue = null;

        try {
            const urlCatalogue = new URL(
                AROME_WCS_BASE + "/GetCapabilities"
            );

            urlCatalogue.searchParams.set("service", "WCS");
            urlCatalogue.searchParams.set("version", "2.0.1");
            urlCatalogue.searchParams.set("request", "GetCapabilities");

            const reponseCatalogue = await fetch(urlCatalogue, {
                headers: {
                    apikey: AROME_API_KEY,
                    accept: "application/xml, text/xml, */*"
                }
            });

            if (!reponseCatalogue.ok) {
                throw new Error(
                    "Erreur catalogue AROME : " +
                    reponseCatalogue.status
                );
            }

            const xmlCatalogue = await reponseCatalogue.text();

            const ids = [
                ...xmlCatalogue.matchAll(
                    /<wcs:CoverageId>([\s\S]*?)<\/wcs:CoverageId>/g
                )
            ].map(m => m[1].trim());

            const prefixU =
                "U_COMPONENT_OF_WIND__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___";

            const prefixV =
                "V_COMPONENT_OF_WIND__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___";

            const modelesU = ids
                .filter(id => id.startsWith(prefixU))
                .sort();

            for (let i = modelesU.length - 1; i >= 0; i--) {
                const suffixe = modelesU[i].slice(prefixU.length);
                const idV = prefixV + suffixe;

                if (ids.includes(idV)) {
                    modele = suffixe;
                    coverageU = modelesU[i];
                    coverageV = idV;
                    break;
                }
            }

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

        // Si le modèle change et que le point est dans l'ancienne
        // zone, on conserve le centre de cette zone.
        let centreLat = lat;
        let centreLon = lon;

        if (!nouvelleZone && cache) {
            centreLat = cache.zone.centreLat;
            centreLon = cache.zone.centreLon;
        }

        const telechargementNecessaire =
            nouveauModele || nouvelleZone;

        // --------------------------------------------------
        // SI LE CACHE EST VALIDE : INTERPOLATION DIRECTE
        // --------------------------------------------------

        function interpoler(grille, valeurs, latitude, longitude) {
            const x =
                (longitude - grille.longitude_depart) /
                grille.resolution_longitude;

            const y =
                (grille.latitude_depart - latitude) /
                grille.resolution_latitude;

            if (
                x < 0 || y < 0 ||
                x > grille.Ni - 1 ||
                y > grille.Nj - 1
            ) {
                throw new Error(
                    "Point GPS hors de la grille AROME"
                );
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

        function calculerPrevisions(cache, latitude, longitude) {
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
                const donnees = cache.previsions.find(
                    p => p.seconde === seconde
                );

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

            return {
                succes: true,
                coordonnees: {
                    latitude,
                    longitude
                },
                modele: cache.modele,
                hauteur: "10 m",
                nombre_echeances: previsions.length,
                nombre_erreurs: cache.erreurs.length + erreurs.length,
                methode: "Interpolation bilinéaire des composantes U/V",
                previsions,
                erreurs: [...cache.erreurs, ...erreurs]
            };
        }

        // --------------------------------------------------
        // SECOURS : UTILISATION DU CACHE SI LE CATALOGUE EST HS
        // --------------------------------------------------

        if (!modele) {

            if (cache && pointDansZone) {

                console.warn(
                    "AROME : utilisation du cache malgré l'indisponibilité du catalogue"
                );

                const resultat = calculerPrevisions(
                    cache,
                    lat,
                    lon
                );

                return res.json({
                    ...resultat,
                    cache: true,
                    catalogue_indisponible: true
                });
            }

            throw erreurCatalogue || new Error(
                "Catalogue AROME indisponible et aucun cache utilisable pour ce point"
            );
        }

        if (!telechargementNecessaire) {
            const resultat = calculerPrevisions(cache, lat, lon);

            console.log(
                "AROME : utilisation du cache spatial",
                lat,
                lon
            );

            return res.json({
                ...resultat,
                cache: true
            });
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

            url.searchParams.append("subset", `time(${echeance})`);
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
                    `Erreur GRIB H+${echeance / 3600} : ` +
                    reponse.status + " " + detail.slice(0, 200)
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
        const taches = [];

        for (const seconde of echeances) {
            taches.push({
                seconde,
                parametre: "U",
                coverageId: coverageU
            });

            taches.push({
                seconde,
                parametre: "V",
                coverageId: coverageV
            });
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
                            V: null
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

            previsionsCache.push(donnees);
        }

        if (previsionsCache.length === 0) {
            throw new Error(
                "Aucune prévision exploitable. " +
                erreurs.slice(0, 3).map(e => e.erreur).join(" | ")
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

        const resultat = calculerPrevisions(
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
            cache: false
        });

    } catch (error) {
        console.error("Erreur prévisions AROME :", error);

        res.status(502).json({
            succes: false,
            erreur: error.message
        });
    }
});



app.get("/api/arome/test-grib", async (req, res) => {
    try {
        if (!AROME_API_KEY) {
            return res.status(500).json({
                succes: false,
                erreur: "Variable METEO_AROME_API_KEY absente"
            });
        }

        const lat = Number(req.query.lat ?? 46.178);
        const lon = Number(req.query.lon ?? -1.193167);

        if (
            !Number.isFinite(lat) ||
            !Number.isFinite(lon) ||
            lat < 37.5 || lat > 55.4 ||
            lon < -12 || lon > 16
        ) {
            return res.status(400).json({
                succes: false,
                erreur: "Coordonnées GPS invalides ou hors domaine AROME"
            });
        }

        // --------------------------------------------------
        // DECODAGE GRIB2 - PACKING SIMPLE 5.0
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
                nombre_points: s3.readUInt32BE(6),
                modele: s3.readUInt16BE(12),
                Ni: s3.readUInt32BE(30),
                Nj: s3.readUInt32BE(34),

                latitude_depart:
                    s3.readInt32BE(46) / 1000000,

                longitude_depart:
                    s3.readInt32BE(50) / 1000000,

                resolution_longitude:
                    s3.readUInt32BE(63) / 1000000,

                resolution_latitude:
                    s3.readUInt32BE(67) / 1000000,

                mode_balaye: s3[71]
            };

            if (grille.longitude_depart > 180) {
                grille.longitude_depart -= 360;
            }

            if (grille.modele !== 0 || grille.mode_balaye !== 0) {
                throw new Error(
                    "Type de grille ou mode de balayage non pris en charge"
                );
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

            function lireFacteurSigneMagnitude(valeur) {
                return (valeur & 0x8000)
                    ? -(valeur & 0x7FFF)
                    : valeur;
            }

            const facteurBinaire = lireFacteurSigneMagnitude(
                s5.readUInt16BE(15)
            );

            const facteurDecimal = lireFacteurSigneMagnitude(
                s5.readUInt16BE(17)
            );

            const bitsParValeur = s5[19];

            if (s6[5] !== 255) {
                throw new Error(
                    "Bitmap GRIB non pris en charge : " + s6[5]
                );
            }

            const donneesBrutes = s7.subarray(5);
            const valeurs = [];

            function lireBits(positionBit, nombreBits) {
                let resultat = 0;

                for (let b = 0; b < nombreBits; b++) {
                    const position = positionBit + b;
                    const indexOctet = Math.floor(position / 8);
                    const indexBit = 7 - (position % 8);

                    const bit =
                        (donneesBrutes[indexOctet] >> indexBit) & 1;

                    resultat = resultat * 2 + bit;
                }

                return resultat;
            }

            for (let i = 0; i < nombreValeurs; i++) {
                const entierCompacte = bitsParValeur === 0
                    ? 0
                    : lireBits(i * bitsParValeur, bitsParValeur);

                const valeur =
                    (
                        reference +
                        entierCompacte * Math.pow(2, facteurBinaire)
                    ) *
                    Math.pow(10, -facteurDecimal);

                valeurs.push(valeur);
            }

            if (valeurs.length !== grille.Ni * grille.Nj) {
                throw new Error(
                    "Nombre de valeurs incompatible avec la grille"
                );
            }

            const points = [];

            for (let j = 0; j < grille.Nj; j++) {
                for (let i = 0; i < grille.Ni; i++) {
                    const index = j * grille.Ni + i;

                    points.push({
                        latitude:
                            grille.latitude_depart -
                            j * grille.resolution_latitude,

                        longitude:
                            grille.longitude_depart +
                            i * grille.resolution_longitude,

                        valeur: valeurs[index]
                    });
                }
            }

            return {
                grille,
                valeurs,
                points,
                compression: {
                    reference,
                    facteur_binaire: facteurBinaire,
                    facteur_decimal: facteurDecimal,
                    bits_par_valeur: bitsParValeur
                }
            };
        }

        // --------------------------------------------------
        // INTERPOLATION BILINEAIRE
        // --------------------------------------------------

        function interpolerGrille(grille, valeurs, lat, lon) {
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
                throw new Error(
                    "Le point GPS demandé est hors de la grille AROME"
                );
            }

            // Indices des quatre points entourant la position
            const i0 = Math.min(Math.floor(x), grille.Ni - 2);
            const j0 = Math.min(Math.floor(y), grille.Nj - 2);

            const i1 = i0 + 1;
            const j1 = j0 + 1;

            // Distances relatives dans la maille
            const tx = x - i0;
            const ty = y - j0;

            function valeur(i, j) {
                return valeurs[j * grille.Ni + i];
            }

            const v00 = valeur(i0, j0);
            const v10 = valeur(i1, j0);
            const v01 = valeur(i0, j1);
            const v11 = valeur(i1, j1);

            // Interpolation horizontale puis verticale
            const haut = v00 * (1 - tx) + v10 * tx;
            const bas = v01 * (1 - tx) + v11 * tx;

            const resultat = haut * (1 - ty) + bas * ty;

            return {
                valeur: resultat,
                indices: {
                    i0, i1, j0, j1
                },
                poids: {
                    haut_gauche: (1 - tx) * (1 - ty),
                    haut_droite: tx * (1 - ty),
                    bas_gauche: (1 - tx) * ty,
                    bas_droite: tx * ty
                }
            };
        }

        // --------------------------------------------------
        // RECUPERATION DU CATALOGUE AROME
        // --------------------------------------------------

        const urlCatalogue = new URL(
            AROME_WCS_BASE + "/GetCapabilities"
        );

        urlCatalogue.searchParams.set("service", "WCS");
        urlCatalogue.searchParams.set("version", "2.0.1");
        urlCatalogue.searchParams.set("request", "GetCapabilities");

        const reponseCatalogue = await fetch(urlCatalogue, {
            headers: {
                apikey: AROME_API_KEY,
                accept: "application/xml, text/xml, */*"
            }
        });

        if (!reponseCatalogue.ok) {
            throw new Error(
                "Erreur catalogue AROME : " +
                reponseCatalogue.status
            );
        }

        const xmlCatalogue = await reponseCatalogue.text();

        const ids = [
            ...xmlCatalogue.matchAll(
                /<wcs:CoverageId>([\s\S]*?)<\/wcs:CoverageId>/g
            )
        ].map(m => m[1].trim());

        const prefixes = {
            vitesse:
                "WIND_SPEED__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___",

            U:
                "U_COMPONENT_OF_WIND__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___",

            V:
                "V_COMPONENT_OF_WIND__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___"
        };

        const vents = ids
            .filter(id => id.startsWith(prefixes.vitesse))
            .sort();

        let modele = null;
        let coverageIds = null;

        for (let i = vents.length - 1; i >= 0; i--) {
            const suffixe = vents[i].slice(prefixes.vitesse.length);

            const idU = prefixes.U + suffixe;
            const idV = prefixes.V + suffixe;

            if (ids.includes(idU) && ids.includes(idV)) {
                modele = suffixe;

                coverageIds = {
                    vitesse: vents[i],
                    U: idU,
                    V: idV
                };

                break;
            }
        }

        if (!modele) {
            throw new Error(
                "Aucun modèle AROME commun aux trois paramètres"
            );
        }

        // --------------------------------------------------
        // TELECHARGEMENT DES TROIS FICHIERS GRIB
        // --------------------------------------------------

        const marge = 0.02;

        const latMin = (lat - marge).toFixed(5);
        const latMax = (lat + marge).toFixed(5);
        const lonMin = (lon - marge).toFixed(5);
        const lonMax = (lon + marge).toFixed(5);

        async function telechargerGrib(coverageId, echeance) {

            let derniereErreur;

            for (let tentative = 1; tentative <= 3; tentative++) {

                try {

                    const url = new URL(
                        AROME_WCS_BASE + "/GetCoverage"
                    );

                    url.searchParams.set("service", "WCS");
                    url.searchParams.set("version", "2.0.1");
                    url.searchParams.set("request", "GetCoverage");
                    url.searchParams.set("coverageId", coverageId);

                    url.searchParams.append("subset", `time(${echeance})`);
                    url.searchParams.append("subset", "height(10)");

                    url.searchParams.append(
                        "subset",
                        `lat(${latMin},${latMax})`
                    );

                    url.searchParams.append(
                        "subset",
                        `long(${lonMin},${lonMax})`
                    );

                    url.searchParams.set("format", "application/wmo-grib");

                    const reponse = await fetch(url, {
                        headers: {
                            apikey: AROME_API_KEY,
                            accept: "application/octet-stream"
                        },
                        signal: AbortSignal.timeout(30000)
                    });

                    if (!reponse.ok) {

                        const detail = await reponse.text();

                        // Une échéance inexistante ne doit pas être retentée
                        if (reponse.status === 404) {
                            throw new Error(
                                `GRIB H+${echeance / 3600} indisponible (404)`
                            );
                        }

                        throw new Error(
                            `Erreur GRIB H+${echeance / 3600} : ` +
                            reponse.status + " " + detail.slice(0, 200)
                        );
                    }

                    const buffer = Buffer.from(
                        await reponse.arrayBuffer()
                    );

                    return decoderGrib(buffer);

                } catch (error) {

                    derniereErreur = error;

                    if (error.message.includes("(404)")) {
                        throw error;
                    }

                    if (tentative < 3) {
                        await new Promise(resolve =>
                            setTimeout(resolve, tentative * 1000)
                        );
                    }
                }
            }

            throw derniereErreur;
        }

        const gribVitesse = await telechargerGrib(
            coverageIds.vitesse
        );

        const gribU = await telechargerGrib(
            coverageIds.U
        );

        const gribV = await telechargerGrib(
            coverageIds.V
        );

        // --------------------------------------------------
        // VERIFICATION DES GRILLES
        // --------------------------------------------------

        function memeGrille(a, b) {
            return (
                a.Ni === b.Ni &&
                a.Nj === b.Nj &&
                Math.abs(
                    a.latitude_depart - b.latitude_depart
                ) < 0.000001 &&
                Math.abs(
                    a.longitude_depart - b.longitude_depart
                ) < 0.000001 &&
                Math.abs(
                    a.resolution_latitude - b.resolution_latitude
                ) < 0.000001 &&
                Math.abs(
                    a.resolution_longitude - b.resolution_longitude
                ) < 0.000001
            );
        }

        if (
            !memeGrille(gribVitesse.grille, gribU.grille) ||
            !memeGrille(gribVitesse.grille, gribV.grille)
        ) {
            throw new Error(
                "Les grilles des trois paramètres sont différentes"
            );
        }

        // --------------------------------------------------
        // INTERPOLATION AU POINT GPS DEMANDE
        // --------------------------------------------------

        const interpolationU = interpolerGrille(
            gribU.grille,
            gribU.valeurs,
            lat,
            lon
        );

        const interpolationV = interpolerGrille(
            gribV.grille,
            gribV.valeurs,
            lat,
            lon
        );

        const interpolationVitesse = interpolerGrille(
            gribVitesse.grille,
            gribVitesse.valeurs,
            lat,
            lon
        );

        const u = interpolationU.valeur;
        const v = interpolationV.valeur;

        const vitesseUV = Math.sqrt(u * u + v * v);

        // Direction météorologique : direction d'où vient le vent
        const direction =
            (
                Math.atan2(-u, -v) * 180 / Math.PI + 360
            ) % 360;

        // --------------------------------------------------
        // POINTS DE GRILLE POUR VERIFICATION
        // --------------------------------------------------

        const points = [];

        for (let i = 0; i < gribVitesse.points.length; i++) {
            const composanteU = gribU.valeurs[i];
            const composanteV = gribV.valeurs[i];

            const vitesseUVPoint = Math.sqrt(
                composanteU * composanteU +
                composanteV * composanteV
            );

            const directionPoint =
                (
                    Math.atan2(-composanteU, -composanteV) *
                    180 / Math.PI + 360
                ) % 360;

            points.push({
                latitude: gribVitesse.points[i].latitude,
                longitude: gribVitesse.points[i].longitude,

                vitesse_arome: Number(
                    gribVitesse.valeurs[i].toFixed(3)
                ),

                vitesse_UV: Number(
                    vitesseUVPoint.toFixed(3)
                ),

                composante_U: Number(composanteU.toFixed(3)),
                composante_V: Number(composanteV.toFixed(3)),

                direction: Number(directionPoint.toFixed(1))
            });
        }

        // --------------------------------------------------
        // REPONSE
        // --------------------------------------------------

        res.json({
            succes: true,

            coordonnees_demandees: {
                latitude: lat,
                longitude: lon
            },

            modele,
            echeance: "H+1",
            hauteur: "10 m",

            interpolation: {
                methode: "bilineaire",

                vitesse: Number(vitesseUV.toFixed(3)),
                vitesse_arome: Number(
                    interpolationVitesse.valeur.toFixed(3)
                ),

                composante_U: Number(u.toFixed(3)),
                composante_V: Number(v.toFixed(3)),

                direction: Number(direction.toFixed(1)),

                quatre_points_utilises: {
                    haut_gauche: interpolationU.indices,
                    poids: interpolationU.poids
                }
            },

            grille: {
                Ni: gribVitesse.grille.Ni,
                Nj: gribVitesse.grille.Nj,
                nombre_points: points.length,

                latitude_depart:
                    gribVitesse.grille.latitude_depart,

                longitude_depart:
                    gribVitesse.grille.longitude_depart,

                resolution_latitude:
                    gribVitesse.grille.resolution_latitude,

                resolution_longitude:
                    gribVitesse.grille.resolution_longitude
            },

            compression: gribVitesse.compression,

            points
        });

    } catch (error) {
        console.error("Erreur décodage GRIB AROME :", error);

        res.status(502).json({
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
