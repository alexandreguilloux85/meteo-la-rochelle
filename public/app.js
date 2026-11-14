let graphiqueVent = null;
let graphiqueDirection = null;
let graphiquePression = null;
let graphiqueTemperature = null;

// --------------------------------------------------
// RADAR METEO-FRANCE - CARTE LEAFLET
// --------------------------------------------------

let carteRadar = null;
let coucheRadar = null;
let urlImageRadar = null;

// --------------------------------------------------
// PREVISIONS AROME
// --------------------------------------------------

let marqueurPrevisions = null;
let numeroRequetePrevisions = 0;

const positionInitiale = {
    lat: 46.178,
    lon: -1.193167
};

function destinationGeographique(lat, lon, distance, azimut) {

    const R = 6371000;
    const angle = azimut * Math.PI / 180;
    const lat1 = lat * Math.PI / 180;
    const lon1 = lon * Math.PI / 180;

    const lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(distance / R) +
        Math.cos(lat1) * Math.sin(distance / R) * Math.cos(angle)
    );

    const lon2 = lon1 + Math.atan2(
        Math.sin(angle) * Math.sin(distance / R) * Math.cos(lat1),
        Math.cos(distance / R) - Math.sin(lat1) * Math.sin(lat2)
    );

    return [
        lat2 * 180 / Math.PI,
        lon2 * 180 / Math.PI
    ];
}

// --------------------------------------------------
// MASQUE SOMBRE EN DEHORS DU CERCLE RADAR
// --------------------------------------------------

function ajouterMasqueRadar(centreLat, centreLon, rayonRadar) {

    let masqueRadar = null;

    function actualiserMasque() {

        if (masqueRadar) {
            carteRadar.removeLayer(masqueRadar);
        }

        const limites = carteRadar.getBounds();

        // Rectangle extérieur avec une marge
        const sud = Math.max(-89, limites.getSouth() - 20);
        const nord = Math.min(89, limites.getNorth() + 20);
        const ouest = Math.max(-180, limites.getWest() - 20);
        const est = Math.min(180, limites.getEast() + 20);

        const rectangle = [
            [sud, ouest],
            [nord, ouest],
            [nord, est],
            [sud, est]
        ];

        // Contour circulaire de 15 milles nautiques
        const cercle = [];

        for (let angle = 0; angle <= 360; angle += 2) {
            cercle.push(
                destinationGeographique(
                    centreLat,
                    centreLon,
                    rayonRadar,
                    angle
                )
            );
        }

        // Polygone avec un trou circulaire transparent
        masqueRadar = L.polygon(
            [rectangle, cercle],
            {
                pane: "radarMaskPane",
                stroke: false,
                fillColor: "#172333",
                fillOpacity: 0.25,
                fillRule: "evenodd",
                interactive: false
            }
        ).addTo(carteRadar);
    }

    // Création initiale
    actualiserMasque();

    // Mise à jour lorsque la carte est déplacée ou zoomée
    carteRadar.on("moveend", actualiserMasque);
}

// --------------------------------------------------
// INITIALISATION DE LA CARTE RADAR
// --------------------------------------------------

function initialiserCarteRadar() {

    const couleurRadar = "#ff9999";
    const centreLat = 46.178;
    const centreLon = -1.193167;
    const rayonRadar = 15 * 1852;

    carteRadar = L.map("carteRadar").setView(
        [centreLat, centreLon],
        9
    );

    // Couche réservée à l'image radar
    carteRadar.createPane("radarImagePane");
    carteRadar.getPane("radarImagePane").style.zIndex = 350;

    // Couche du masque sombre, au-dessus du radar
    // mais en dessous des cercles et des axes
    carteRadar.createPane("radarMaskPane");
    carteRadar.getPane("radarMaskPane").style.zIndex = 375;

    // Fond de carte actuel
    L.tileLayer("https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png?key=cb1_57wq_1_07826fc0a0495a659d44fac5", {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19
    }).addTo(carteRadar);

    // --------------------------------------------------
    // MASQUE SOMBRE A L'EXTERIEUR DU CERCLE DE 15 NM
    // --------------------------------------------------

    ajouterMasqueRadar(
        centreLat,
        centreLon,
        rayonRadar
    );

    // --------------------------------------------------
    // CERCLE 5 MILLES NAUTIQUES
    // --------------------------------------------------

    L.circle([centreLat, centreLon], {
        radius: 5 * 1852,
        color: couleurRadar,
        weight: 2,
        opacity: 0.9,
        dashArray: "6, 6",
        fill: false
    }).addTo(carteRadar);

    // --------------------------------------------------
    // CERCLE 15 MILLES NAUTIQUES
    // --------------------------------------------------

    L.circle([centreLat, centreLon], {
        radius: rayonRadar,
        color: couleurRadar,
        weight: 2,
        opacity: 0.9,
        dashArray: "6, 6",
        fill: false
    }).addTo(carteRadar);

    // --------------------------------------------------
    // ETIQUETTES DES DISTANCES
    // --------------------------------------------------

    function ajouterEtiquette(distance, texte, couleur) {

        const position = destinationGeographique(
            centreLat,
            centreLon,
            distance,
            0
        );

        const icone = L.divIcon({
            className: "",
            html: `
                <div style="
                    background: rgba(15, 30, 45, 0.90);
                    color: ${couleur};
                    border: 1px solid ${couleur};
                    border-radius: 4px;
                    padding: 2px 4px;
                    font-family: Arial, sans-serif;
                    font-size: 10px;
                    font-weight: bold;
                    white-space: nowrap;
                    box-shadow: 0 1px 5px rgba(0,0,0,0.4);
                ">
                    ${texte}
                </div>
            `,
            iconSize: [45, 18],
            iconAnchor: [-5, 11]
        });

        L.marker(position, {
            icon: icone,
            interactive: false
        }).addTo(carteRadar);
    }

    ajouterEtiquette(5 * 1852, "5 nm", couleurRadar);
    ajouterEtiquette(rayonRadar, "15nm", couleurRadar);

    // --------------------------------------------------
    // AXE VERTICAL NORD-SUD
    // --------------------------------------------------

    const nord = destinationGeographique(
        centreLat, centreLon, rayonRadar, 0
    );

    const sud = destinationGeographique(
        centreLat, centreLon, rayonRadar, 180
    );

    L.polyline([nord, sud], {
        color: couleurRadar,
        weight: 1.5,
        opacity: 0.75,
        dashArray: "5, 8"
    }).addTo(carteRadar);

    // --------------------------------------------------
    // AXE HORIZONTAL EST-OUEST
    // --------------------------------------------------

    const est = destinationGeographique(
        centreLat, centreLon, rayonRadar, 90
    );

    const ouest = destinationGeographique(
        centreLat, centreLon, rayonRadar, 270
    );

    L.polyline([est, ouest], {
        color: couleurRadar,
        weight: 1.5,
        opacity: 0.75,
        dashArray: "5, 8"
    }).addTo(carteRadar);

    // --------------------------------------------------
    // MARQUEUR DE POSITION DES PREVISIONS AROME
    // --------------------------------------------------

    marqueurPrevisions = L.circleMarker(
        [positionInitiale.lat, positionInitiale.lon],
        {
            radius: 7,
            color: "#ffffff",
            weight: 2,
            fillColor: "#00bfff",
            fillOpacity: 1
        }
    ).addTo(carteRadar);

    marqueurPrevisions.bindTooltip(
        "Position des prévisions AROME",
        {
            direction: "top",
            offset: [0, -8]
        }
    );

    // Clic sur la carte : déplacement du marqueur
    carteRadar.on("click", function(e) {

        const lat = e.latlng.lat;
        const lon = e.latlng.lng;

        marqueurPrevisions.setLatLng([lat, lon]);

        chargerPrevisionsArome(lat, lon);
    });

    // Chargement initial des prévisions à La Rochelle
    chargerPrevisionsArome(
        positionInitiale.lat,
        positionInitiale.lon
    );

    // Chargement radar
    chargerRadar();

    // Actualisation toutes les 5 minutes
    setInterval(chargerRadar, 5 * 60 * 1000);
}

// --------------------------------------------------
// CHARGEMENT DES PREVISIONS AROME
// --------------------------------------------------

async function chargerPrevisionsArome(lat, lon) {

    const statut = document.getElementById("previsionsMiseAJour");
    const tableau = document.getElementById("tableauPrevisions");

    // Identifiant pour ignorer les réponses anciennes
    // si plusieurs clics sont effectués rapidement.
    const numeroRequete = ++numeroRequetePrevisions;

    statut.textContent = "Calcul des prévisions AROME...";

    tableau.innerHTML = `
        <tr>
            <td colspan="4">Chargement des prévisions...</td>
        </tr>
    `;

    try {

        const url =
            "/api/arome/previsions?lat=" +
            encodeURIComponent(lat) +
            "&lon=" +
            encodeURIComponent(lon);

        const reponse = await fetch(url);

        if (!reponse.ok) {
            throw new Error("Erreur API : " + reponse.status);
        }

        const resultat = await reponse.json();

        if (!resultat.succes) {
            throw new Error("L'API AROME n'a pas pu calculer les prévisions");
        }

        if (!Array.isArray(resultat.previsions) ||
            resultat.previsions.length === 0) {
            throw new Error("Aucune prévision disponible");
        }

        // Une requête plus récente a été lancée entre-temps.
        if (numeroRequete !== numeroRequetePrevisions) {
            return;
        }

        const previsions = resultat.previsions;

        // Création du tableau
        tableau.innerHTML = previsions.map(p => {

            const date = new Date(p.date);

            const dateTexte = date.toLocaleString("fr-FR", {
                timeZone: "Europe/Paris",
                day: "2-digit",
                month: "2-digit",
                hour: "2-digit",
                minute: "2-digit"
            });

            const vitesseKt = Number(p.vitesse) * 1.94384;

            const vitesseTexte = Number.isFinite(vitesseKt)
                ? vitesseKt.toFixed(1)
                : "--";

            const direction = Number(p.direction);

            const directionTexteValeur = Number.isFinite(direction)
                ? direction.toFixed(0) + "° " + directionTexte(direction)
                : "--";

            return `
                <tr>
                    <td>${dateTexte}</td>
                    <td>${p.echeance || "--"}</td>
                    <td>${vitesseTexte}</td>
                    <td>${directionTexteValeur}</td>
                </tr>
            `;

        }).join("");

        const modele = resultat.modele
            ? new Date(resultat.modele).toLocaleString("fr-FR", {
                timeZone: "Europe/Paris",
                day: "2-digit",
                month: "2-digit",
                hour: "2-digit",
                minute: "2-digit"
            })
            : "--";

        statut.textContent =
            previsions.length +
            " échéances · Modèle du " +
            modele;

        console.log(
            "Prévisions AROME chargées :",
            previsions.length,
            "échéances pour",
            lat,
            lon
        );

    } catch (erreur) {

        if (numeroRequete !== numeroRequetePrevisions) {
            return;
        }

        console.error("Erreur prévisions AROME :", erreur);

        statut.textContent = "Prévisions indisponibles";

        tableau.innerHTML = `
            <tr>
                <td colspan="4">Erreur : ${erreur.message}</td>
            </tr>
        `;
    }
}

// --------------------------------------------------
// CHARGEMENT DE L'IMAGE RADAR
// --------------------------------------------------

async function chargerRadar() {

    const statut = document.getElementById("radarMiseAJour");

    try {

        statut.textContent = "Actualisation du radar...";

        const reponse = await fetch(
            "/api/radar/image?t=" + Date.now()
        );

        if (!reponse.ok) {
            throw new Error("Erreur radar : " + reponse.status);
        }

        // Récupération des coordonnées géographiques
        const boundsTexte = reponse.headers.get("X-Radar-Bounds");

        if (!boundsTexte) {
            throw new Error("Coordonnées radar absentes");
        }

        const bounds = JSON.parse(boundsTexte);

        const limites = [
            [bounds.sud, bounds.ouest],
            [bounds.nord, bounds.est]
        ];

        // Récupération de la date du produit
        const dateRadar = reponse.headers.get("X-Radar-Date");

        // Image PNG
        const blob = await reponse.blob();
        const nouvelleUrl = URL.createObjectURL(blob);

        // Suppression de l'ancienne image
        if (coucheRadar) {
            carteRadar.removeLayer(coucheRadar);
        }

        if (urlImageRadar) {
            URL.revokeObjectURL(urlImageRadar);
        }

        urlImageRadar = nouvelleUrl;

        // Affichage de l'image radar
        coucheRadar = L.imageOverlay(
            urlImageRadar,
            limites,
            {
                opacity: 0.95,
                interactive: false,
                pane: "radarImagePane"
            }
        );

        coucheRadar.addTo(carteRadar);

        // Mise à jour de l'affichage de la date
        if (dateRadar) {

            const date = new Date(dateRadar);

            statut.textContent =
                "Radar : " +
                date.toLocaleString("fr-FR", {
                    day: "2-digit",
                    month: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit"
                });

        } else {
            statut.textContent = "Radar actualisé";
        }

        console.log("Radar actualisé :", dateRadar);

    } catch (erreur) {

        console.error("Erreur chargement radar :", erreur);

        statut.textContent = "Radar indisponible";
    }
}

// --------------------------------------------------
// CONVERSION DES UNITES
// --------------------------------------------------

// Conversion m/s vers noeuds
function noeuds(valeur) {
    return valeur * 1.94384;
}

// Conversion kelvins vers degrés Celsius
function celsius(valeur) {
    return valeur - 273.15;
}

// Conversion de la direction en points cardinaux
function directionTexte(degres) {

    const directions = [
        "N", "NE", "E", "SE",
        "S", "SO", "O", "NO"
    ];

    return directions[Math.round(degres / 45) % 8];
}

// --------------------------------------------------
// OPTIONS COMMUNES DES GRAPHIQUES
// --------------------------------------------------

function optionsGraphique(titreAxe, unite) {

    return {
        responsive: true,
        maintainAspectRatio: false,

        interaction: {
            mode: "index",
            intersect: false
        },

        plugins: {
            legend: {
                position: "top"
            },

            tooltip: {
                enabled: true,
                backgroundColor: "#14283f",
                titleColor: "#ffffff",
                bodyColor: "#ffffff",
                borderColor: "#49627d",
                borderWidth: 1,
                padding: 12,
                displayColors: true,

                callbacks: {
                    label: function(context) {
                        return context.dataset.label + " : " +
                            context.parsed.y.toFixed(1) + " " + unite;
                    }
                }
            }
        },

        scales: {
            x: {
                grid: {
                    color: "#edf1f5"
                },

                ticks: {
                    maxTicksLimit: 8
                },

                title: {
                    display: true,
                    text: "Heure"
                }
            },

            y: {
                beginAtZero: titreAxe !== "Pression" &&
                    titreAxe !== "Température",

                title: {
                    display: true,
                    text: titreAxe
                },

                grid: {
                    color: "#edf1f5"
                }
            }
        }
    };
}

// --------------------------------------------------
// CREATION DES QUATRE GRAPHIQUES
// --------------------------------------------------

function creerGraphiques(donnees) {

    const labels = donnees.map(d =>
        new Date(d.date).toLocaleTimeString("fr-FR", {
            hour: "2-digit",
            minute: "2-digit"
        })
    );

    const vent = donnees.map(d => noeuds(d.ff));

    const rafales = donnees.map(d =>
        Number.isFinite(d.raf10) ? noeuds(d.raf10) : null
    );

    const direction = donnees.map(d => d.dd);

    const pression = donnees.map(d =>
        Number.isFinite(d.pmer) ? d.pmer / 100 : null
    );

    // Température en degrés Celsius
    const temperature = donnees.map(d =>
        Number.isFinite(d.t) ? celsius(d.t) : null
    );

    // Détruire les anciens graphiques
    if (graphiqueVent) graphiqueVent.destroy();
    if (graphiqueDirection) graphiqueDirection.destroy();
    if (graphiquePression) graphiquePression.destroy();
    if (graphiqueTemperature) graphiqueTemperature.destroy();

    // Graphique vent moyen et rafales
    graphiqueVent = new Chart(
        document.getElementById("graphVent"),
        {
            type: "line",

            data: {
                labels: labels,

                datasets: [
                    {
                        label: "Vent moyen",
                        data: vent,
                        borderColor: "#1685c8",
                        backgroundColor: "#1685c820",
                        fill: true,
                        tension: 0.25,
                        pointRadius: 1,
                        pointHoverRadius: 6,
                        pointHitRadius: 12
                    },

                    {
                        label: "Rafales",
                        data: rafales,
                        borderColor: "#e67e22",
                        backgroundColor: "#e67e2220",
                        fill: false,
                        tension: 0.25,
                        pointRadius: 1,
                        pointHoverRadius: 6,
                        pointHitRadius: 12
                    }
                ]
            },

            options: optionsGraphique("Vitesse", "kt")
        }
    );

    // Graphique direction
    graphiqueDirection = new Chart(
        document.getElementById("graphDirection"),
        {
            type: "line",

            data: {
                labels: labels,

                datasets: [
                    {
                        label: "Direction du vent",
                        data: direction,
                        borderColor: "#27ae60",
                        backgroundColor: "#27ae6020",
                        fill: false,
                        tension: 0.2,
                        pointRadius: 2,
                        pointHoverRadius: 6,
                        pointHitRadius: 12
                    }
                ]
            },

            options: {
                ...optionsGraphique("Direction", "°"),

                scales: {
                    x: {
                        grid: {
                            color: "#edf1f5"
                        },
                        ticks: {
                            maxTicksLimit: 8
                        },
                        title: {
                            display: true,
                            text: "Heure"
                        }
                    },

                    y: {
                        min: 0,
                        max: 360,
                        ticks: {
                            stepSize: 45
                        },
                        title: {
                            display: true,
                            text: "Direction (°)"
                        },
                        grid: {
                            color: "#edf1f5"
                        }
                    }
                }
            }
        }
    );

    // Graphique pression
    graphiquePression = new Chart(
        document.getElementById("graphPression"),
        {
            type: "line",

            data: {
                labels: labels,

                datasets: [
                    {
                        label: "Pression atmosphérique",
                        data: pression,
                        borderColor: "#8e44ad",
                        backgroundColor: "#8e44ad20",
                        fill: true,
                        tension: 0.25,
                        pointRadius: 1,
                        pointHoverRadius: 6,
                        pointHitRadius: 12
                    }
                ]
            },

            options: optionsGraphique("Pression", "hPa")
        }
    );

    // Graphique température
    graphiqueTemperature = new Chart(
        document.getElementById("graphTemperature"),
        {
            type: "line",

            data: {
                labels: labels,

                datasets: [
                    {
                        label: "Température",
                        data: temperature,
                        borderColor: "#e74c3c",
                        backgroundColor: "#e74c3c20",
                        fill: true,
                        tension: 0.25,
                        pointRadius: 1,
                        pointHoverRadius: 6,
                        pointHitRadius: 12
                    }
                ]
            },

            options: optionsGraphique("Température", "°C")
        }
    );
}

// --------------------------------------------------
// CHARGEMENT DES DONNEES METEO
// --------------------------------------------------

async function chargerDonnees() {

    try {

        const reponse = await fetch("/api/observations");

        if (!reponse.ok) {
            throw new Error("Erreur API : " + reponse.status);
        }

        const resultat = await reponse.json();

        const lignes = Array.isArray(resultat)
            ? resultat
            : resultat.features || resultat.data || [];

        if (!Array.isArray(lignes) || lignes.length === 0) {
            throw new Error("Aucun relevé trouvé dans la réponse API");
        }

        // Extraction des données
        const donnees = lignes
            .map(item => {

                const d = item.properties || item;

                return {
                    date: d.validity_time,
                    ff: d.ff == null ? null : Number(d.ff),
                    raf10: d.raf10 == null ? null : Number(d.raf10),
                    dd: d.dd == null ? null : Number(d.dd),
                    pmer: d.pmer == null ? null : Number(d.pmer),
                    t: d.t == null ? null : Number(d.t)
                };

            })
            .filter(d =>
                d.date &&
                Number.isFinite(new Date(d.date).getTime()) &&
                Number.isFinite(d.ff)
            )
            .sort((a, b) =>
                new Date(a.date) - new Date(b.date)
            );

        if (donnees.length === 0) {
            throw new Error("Aucune donnée météo exploitable");
        }

        // Dernière valeur disponible
        const dernier = donnees[donnees.length - 1];

        // Vent moyen
        document.getElementById("ventActuel").textContent =
            noeuds(dernier.ff).toFixed(1);

        // Rafales
        document.getElementById("rafaleActuelle").textContent =
            Number.isFinite(dernier.raf10)
                ? noeuds(dernier.raf10).toFixed(1)
                : "--";

        // Direction du vent
        if (Number.isFinite(dernier.dd)) {

            document.getElementById("directionActuelle").textContent =
                dernier.dd.toFixed(0) + "°";

            document.getElementById("directionCardinale").textContent =
                directionTexte(dernier.dd);

            // La flèche indique le sens dans lequel le vent souffle.
            document.getElementById("flecheDirection").style.transform =
                "rotate(" + (dernier.dd + 180) + "deg)";

        } else {

            document.getElementById("directionActuelle").textContent = "--°";
            document.getElementById("directionCardinale").textContent = "--";
        }

        // Pression : pmer est en Pa, conversion en hPa
        document.getElementById("pressionActuelle").textContent =
            Number.isFinite(dernier.pmer)
                ? (dernier.pmer / 100).toFixed(1)
                : "----";

        // Dernières 24 heures
        const maintenant = Date.now();
        const limite = maintenant - 24 * 60 * 60 * 1000;

        const donnees24h = donnees.filter(d => {
            const temps = new Date(d.date).getTime();
            return temps >= limite && temps <= maintenant;
        });

        if (donnees24h.length === 0) {
            throw new Error("Aucune donnée disponible sur les dernières 24 h");
        }

        // Création des graphiques
        creerGraphiques(donnees24h);

        // Tableau historique : 30 dernières mesures
        const tableau = document.getElementById("tableau");

        tableau.innerHTML = donnees24h
            .slice()
            .reverse()
            .slice(0, 30)
            .map(d => `
                <tr>
                    <td>${new Date(d.date).toLocaleString("fr-FR")}</td>

                    <td>${noeuds(d.ff).toFixed(1)}</td>

                    <td>
                        ${Number.isFinite(d.raf10)
                            ? noeuds(d.raf10).toFixed(1)
                            : "--"}
                    </td>

                    <td>
                        ${Number.isFinite(d.dd)
                            ? d.dd.toFixed(0) + "° " + directionTexte(d.dd)
                            : "--"}
                    </td>

                    <td>
                        ${Number.isFinite(d.pmer)
                            ? (d.pmer / 100).toFixed(1)
                            : "--"}
                    </td>

                    <td>
                        ${Number.isFinite(d.t)
                            ? (d.t - 273.15).toFixed(1)
                            : "--"}
                    </td>
                </tr>
            `)
            .join("");

        // Date du dernier relevé
        document.getElementById("miseAJour").textContent =
            "Dernier relevé : " +
            new Date(dernier.date).toLocaleString("fr-FR");

        console.log("Nombre de relevés :", donnees.length);
        console.log("Relevés sur 24 h :", donnees24h.length);

    } catch (erreur) {

        console.error(erreur);

        document.getElementById("miseAJour").textContent =
            "Erreur : " + erreur.message;
    }
}

// --------------------------------------------------
// DEMARRAGE
// --------------------------------------------------

initialiserCarteRadar();

chargerDonnees();

// Actualisation météo toutes les 6 minutes
setInterval(chargerDonnees, 6 * 60 * 1000);