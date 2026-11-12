
require("dotenv").config();

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.METEO_API_KEY;
const RADAR_API_KEY = process.env.METEO_RADAR_API_KEY;

app.use(express.static("public"));

// ----------------------------------
// OBSERVATIONS METEO
// ----------------------------------

app.get("/api/observations", async (req, res) => {
    try {
        const url = new URL(
            "https://public-api.meteofrance.fr/public/DPPaquetObs/v2/paquet/infrahoraire-6m"
        );

        url.searchParams.set("id_station", "17300009");
        url.searchParams.set("format", "json");

        const response = await fetch(url, {
            headers: {
                "accept": "*/*",
                "apikey": API_KEY
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

// ----------------------------------
// RADAR METEO-FRANCE
// ----------------------------------

app.get("/api/radar/disponibilite", async (req, res) => {
    try {
        if (!RADAR_API_KEY) {
            return res.status(500).json({
                error: "Clé API radar manquante : METEO_RADAR_API_KEY"
            });
        }

        const url =
            "https://public-api.meteofrance.fr/public/DPRadar/v1/mosaiques/METROPOLE/observations/LAME_D_EAU";

        const response = await fetch(url, {
            headers: {
                "accept": "application/json",
                "apikey": RADAR_API_KEY
            }
        });

        const data = await response.text();

        if (!response.ok) {
            console.error("Erreur API Radar :", response.status, data);
            return res.status(response.status).send(data);
        }

        const catalogue = JSON.parse(data);

        console.log("Catalogue radar récupéré");

        res.json(catalogue);

    } catch (error) {
        console.error("Erreur radar :", error);
        res.status(502).json({ error: error.message });
    }
});

// ----------------------------------
// DEMARRAGE SERVEUR
// ----------------------------------
// DEBUT TEST
app.get("/api/radar/test-produit", async (req, res) => {
    try {
        const catalogueUrl =
            "https://public-api.meteofrance.fr/public/DPRadar/v1/mosaiques/METROPOLE/observations/LAME_D_EAU";

        const catalogueResponse = await fetch(catalogueUrl, {
            headers: {
                "apikey": RADAR_API_KEY,
                "accept": "application/json"
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
                "apikey": RADAR_API_KEY,
                "accept": "*/*"
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
/// FIN TEST 
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Application disponible sur http://localhost:${PORT}`);
});
