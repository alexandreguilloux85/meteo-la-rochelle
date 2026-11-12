
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

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Application disponible sur http://localhost:${PORT}`);
});
