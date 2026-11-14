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
// AROME - TEST TELECHARGEMENT GRIB AU POINT GPS
// --------------------------------------------------

app.get("/api/arome/test-grib", async (req, res) => {
    try {
        if (!AROME_API_KEY) {
            return res.status(500).json({
                succes: false,
                erreur: "Variable METEO_AROME_API_KEY absente"
            });
        }

        // Coordonnées par défaut : station La Rochelle
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

        // Petite zone autour du point demandé
        const marge = 0.02;

        const latMin = (lat - marge).toFixed(5);
        const latMax = (lat + marge).toFixed(5);
        const lonMin = (lon - marge).toFixed(5);
        const lonMax = (lon + marge).toFixed(5);

        // Récupération du catalogue AROME
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
                "Erreur catalogue AROME : " + reponseCatalogue.status
            );
        }

        const xmlCatalogue = await reponseCatalogue.text();

        // Recherche des couvertures de vitesse du vent
        const ids = [
            ...xmlCatalogue.matchAll(
                /<wcs:CoverageId>([\s\S]*?)<\/wcs:CoverageId>/g
            )
        ].map(m => m[1].trim());

        const vents = ids.filter(id =>
            id.startsWith(
                "WIND_SPEED__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___"
            )
        );

        if (vents.length === 0) {
            throw new Error("Aucune couverture WIND_SPEED disponible");
        }

        // Sélection du dernier modèle disponible
        const coverageId = vents[vents.length - 1];

        // Téléchargement GRIB :
        // +1 heure après le début du modèle
        // hauteur 10 m
        // petite zone autour du point GPS

        const urlGrib = new URL(
            AROME_WCS_BASE + "/GetCoverage"
        );

        urlGrib.searchParams.set("service", "WCS");
        urlGrib.searchParams.set("version", "2.0.1");
        urlGrib.searchParams.set("request", "GetCoverage");
        urlGrib.searchParams.set("coverageId", coverageId);

        urlGrib.searchParams.append("subset", "time(3600)");
        urlGrib.searchParams.append("subset", "height(10)");
        urlGrib.searchParams.append(
            "subset",
            `lat(${latMin},${latMax})`
        );
        urlGrib.searchParams.append(
            "subset",
            `long(${lonMin},${lonMax})`
        );

        urlGrib.searchParams.set(
            "format",
            "application/wmo-grib"
        );

        console.log("Téléchargement GRIB AROME :", urlGrib.toString());

        const reponseGrib = await fetch(urlGrib, {
            headers: {
                apikey: AROME_API_KEY,
                accept: "application/octet-stream"
            }
        });

        const buffer = Buffer.from(
            await reponseGrib.arrayBuffer()
        );

        const typeContenu =
            reponseGrib.headers.get("content-type") || "";

        // Si Météo-France renvoie une erreur XML
        if (!reponseGrib.ok) {
            return res.status(reponseGrib.status).json({
                succes: false,
                statut: reponseGrib.status,
                type: typeContenu,
                detail: buffer.toString("utf8").slice(0, 2000)
            });
        }

        // Vérification de la signature GRIB
        const signature = buffer
            .subarray(0, 4)
            .toString("ascii");
        
        // Analyse des sections GRIB2
        const sections = [];
        let offset = 16;
        
        while (offset < buffer.length - 4) {
            const longueur = buffer.readUInt32BE(offset);
            const numero = buffer[offset + 4];
        
            if (
                longueur < 5 ||
                offset + longueur > buffer.length
            ) {
                break;
            }
        
            sections.push({
                numero,
                longueur
            });
        
            offset += longueur;
        
            if (numero === 7) {
                break;
            }
        }
        
        const finGrib = buffer
            .subarray(buffer.length - 4)
            .toString("ascii");
        
        // Informations détaillées sur la grille GRIB2
        let grille = null;
        let donnees = null;
        
        let position = 16;
        let donneesBrutes = null;
        
        while (position < buffer.length - 4) {
            const longueur = buffer.readUInt32BE(position);
            const numero = buffer[position + 4];
        
        if (numero === 3) {
            grille = {
                nombre_points: buffer.readUInt32BE(position + 6),
                modele_grille: buffer.readUInt16BE(position + 12),
        
                Ni: buffer.readUInt32BE(position + 30),
                Nj: buffer.readUInt32BE(position + 34),
        
                latitude_depart:
                    buffer.readInt32BE(position + 46) / 1000000,
        
                longitude_depart:
                    buffer.readInt32BE(position + 50) / 1000000,
        
                latitude_arrivee:
                    buffer.readInt32BE(position + 55) / 1000000,
        
                longitude_arrivee:
                    buffer.readInt32BE(position + 59) / 1000000,
        
                resolution_longitude:
                    buffer.readUInt32BE(position + 63) / 1000000,
        
                resolution_latitude:
                    buffer.readUInt32BE(position + 67) / 1000000,
        
                mode_balaye: buffer[position + 71]
            };
        }
        
        if (numero === 5) {
            donnees = {
                nombre_valeurs: buffer.readUInt32BE(position + 5),
                modele_compression: buffer.readUInt16BE(position + 9),
        
                valeur_reference:
                    buffer.readFloatBE(position + 11),
        
                facteur_binaire:
                    buffer.readInt16BE(position + 15),
        
                facteur_decimal:
                    buffer.readInt16BE(position + 17),
        
                bits_par_valeur:
                    buffer[position + 19]
            };
        }
    
        if (numero === 7) {
    donneesBrutes = buffer
        .subarray(position + 5, position + longueur)
        .toString("hex");
        }
        
            position += longueur;
        }

        
        res.json({
            succes: true,
            coverageId,
            coordonnees: {
                latitude: lat,
                longitude: lon
            },
            zone: {
                latitude: [Number(latMin), Number(latMax)],
                longitude: [Number(lonMin), Number(lonMax)]
            },
            echeance: "H+1",
            hauteur: "10 m",
            format: typeContenu,
            signature,
            taille_octets: buffer.length,
            taille_Ko: (buffer.length / 1024).toFixed(2),
            fichier_grib_valide: signature === "GRIB",
            debut_fichier_hex: buffer
                .subarray(0, 24)
                .toString("hex"),
            sections,
            fin_grib: finGrib,
            grille,
            donnees,
            donneesBrutes
        });

    } catch (error) {
        console.error("Erreur test GRIB AROME :", error);

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
