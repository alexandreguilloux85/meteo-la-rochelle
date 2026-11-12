
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
// DEMARRAGE SERVEUR
// --------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Application disponible sur le port ${PORT}`);
});

