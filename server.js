
require("dotenv").config();

const express = require("express");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.METEO_API_KEY;
const RADAR_API_KEY = process.env.METEO_RADAR_API_KEY;

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
        const url =
            "https://public-api.meteofrance.fr/public/DPRadar/v1/mosaiques/METROPOLE/observations/LAME_D_EAU";

        const response = await fetch(url, {
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
        const catalogueUrl =
            "https://public-api.meteofrance.fr/public/DPRadar/v1/mosaiques/METROPOLE/observations/LAME_D_EAU";

        const catalogueResponse = await fetch(catalogueUrl, {
            headers: {
                apikey: RADAR_API_KEY,
                accept: "application/json"
            }
        });

        if (!catalogueResponse.ok) {
            throw new Error("Erreur catalogue : " + catalogueResponse.status);
        }

        const catalogue = await catalogueResponse.json();

        const produit = catalogue.links.find(link =>
            link.href.includes("maille=500")
        );

        if (!produit) {
            throw new Error("Produit radar 500 m introuvable");
        }

        const fichierResponse = await fetch(produit.href, {
            headers: {
                apikey: RADAR_API_KEY,
                accept: "*/*"
            }
        });

        if (!fichierResponse.ok) {
            throw new Error("Erreur téléchargement : " + fichierResponse.status);
        }

        const fichier = await fichierResponse.arrayBuffer();

        res.json({
            succes: true,
            format: produit.type,
            date: produit.validity_time,
            taille_octets: fichier.byteLength,
            taille_Mo: (fichier.byteLength / 1048576).toFixed(2)
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
        // Récupération du catalogue
        const catalogueUrl =
            "https://public-api.meteofrance.fr/public/DPRadar/v1/mosaiques/METROPOLE/observations/LAME_D_EAU";

        const catalogueResponse = await fetch(catalogueUrl, {
            headers: {
                apikey: RADAR_API_KEY,
                accept: "application/json"
            }
        });

        if (!catalogueResponse.ok) {
            throw new Error("Erreur catalogue : " + catalogueResponse.status);
        }

        const catalogue = await catalogueResponse.json();

        // Recherche du produit 500 m
        const produit = catalogue.links.find(link =>
            link.href.includes("maille=500")
        );

        if (!produit) {
            throw new Error("Produit radar 500 m introuvable");
        }

        // Téléchargement du fichier
        const response = await fetch(produit.href, {
            headers: {
                apikey: RADAR_API_KEY,
                accept: "*/*"
            }
        });

        if (!response.ok) {
            throw new Error("Erreur téléchargement : " + response.status);
        }

        const buffer = Buffer.from(await response.arrayBuffer());

        // Enregistrement temporaire
        fichierTemporaire = path.join(
            os.tmpdir(),
            "radar-meteofrance.h5"
        );

        await fs.writeFile(fichierTemporaire, buffer);

        // Chargement de h5wasm
        const h5wasm = await import("h5wasm/node");
        await h5wasm.ready;

        // Ouverture du fichier HDF5
        fichierHdf = new h5wasm.File(fichierTemporaire, "r");

        // Exploration de la structure HDF5
        const elements = [];

        function explorer(noeud, chemin = "/") {
            if (elements.length >= 300) return;

            let attributs = {};

            if (noeud.attrs) {
                for (const nom of Object.keys(noeud.attrs)) {
                    attributs[nom] = noeud.attrs[nom].value;
                }
            }

            // Dataset
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

            // Groupe
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

        res.json({
            succes: true,
            date: produit.validity_time,
            taille_Mo: (buffer.length / 1048576).toFixed(2),
            nombre_elements: elements.length,
            elements
        });

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
                console.error("Erreur fermeture HDF5 :", error.message);
            }
        }

        if (fichierTemporaire) {
            try {
                await fs.unlink(fichierTemporaire);
            } catch (error) {
                console.error("Erreur suppression temporaire :", error.message);
            }
        }
    }
});

// --------------------------------------------------
// DEMARRAGE SERVEUR
// --------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Application disponible sur le port ${PORT}`);
});

