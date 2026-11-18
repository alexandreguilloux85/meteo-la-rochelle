let graphiqueVent = null;
let graphiqueDirection = null;
let graphiquePression = null;
let graphiqueTemperature = null;

// --------------------------------------------------
// RADAR METEO-FRANCE - CARTE LEAFLET
// --------------------------------------------------

let carteRadar = null;
let coucheRadar = null;
let cercle5Nm = null;
let cercle15Nm = null;
let etiquette5Nm = null;
let etiquette15Nm = null;
let axeNordSud = null;
let axeEstOuest = null;

const URL_RADAR_TUILES = "https://alexandreguilloux85.github.io/meteo-la-rochelle/radar-xyz";
const URL_SERVEUR_RENDER = "https://station-meteo-lr-test.onrender.com";
// --------------------------------------------------
// PREVISIONS AROME
// --------------------------------------------------

let marqueurPrevisions = null;
let numeroRequetePrevisions = 0;

const positionParDefaut = {
    lat: 46.178,
    lon: -1.193167
};

let positionCourante =
    JSON.parse(
        localStorage.getItem("positionArome")
    ) || positionParDefaut;

let centreRadarActuel = {
    lat: positionCourante.lat,
    lon: positionCourante.lon
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

function reconstruireRadarGraphique(
    centreLat,
    centreLon
) {

    const couleurRadar = "#ff9999";
    const rayonRadar = 15 * 1852;

    centreRadarActuel = {
        lat: centreLat,
        lon: centreLon
    };

    if (etiquette5Nm) {
        carteRadar.removeLayer(etiquette5Nm);
    }

    if (etiquette15Nm) {
        carteRadar.removeLayer(etiquette15Nm);
    }

    if (cercle5Nm) {
        carteRadar.removeLayer(
            cercle5Nm
        );
    }

    if (cercle15Nm) {
        carteRadar.removeLayer(
            cercle15Nm
        );
    }

    if (axeNordSud) {
        carteRadar.removeLayer(
            axeNordSud
        );
    }

    if (axeEstOuest) {
        carteRadar.removeLayer(
            axeEstOuest
        );
    }

    etiquette5Nm =
        creerEtiquette(
            centreLat,
            centreLon,
            5 * 1852,
            "5 nm",
            couleurRadar
        );

    etiquette15Nm =
        creerEtiquette(
            centreLat,
            centreLon,
            rayonRadar,
            "15 nm",
            couleurRadar
        );

    cercle5Nm = L.circle(
        [centreLat, centreLon],
        {
            radius: 5 * 1852,
            color: couleurRadar,
            weight: 2,
            opacity: 0.9,
            dashArray: "6, 6",
            fill: false
        }
    ).addTo(carteRadar);

    cercle15Nm = L.circle(
        [centreLat, centreLon],
        {
            radius: rayonRadar,
            color: couleurRadar,
            weight: 2,
            opacity: 0.9,
            dashArray: "6, 6",
            fill: false
        }
    ).addTo(carteRadar);

    const nord =
        destinationGeographique(
            centreLat,
            centreLon,
            rayonRadar,
            0
        );

    const sud =
        destinationGeographique(
            centreLat,
            centreLon,
            rayonRadar,
            180
        );

    axeNordSud =
        L.polyline(
            [nord, sud],
            {
                color: couleurRadar,
                weight: 1.5,
                opacity: 0.75,
                dashArray: "5, 8"
            }
        ).addTo(carteRadar);

    const est =
        destinationGeographique(
            centreLat,
            centreLon,
            rayonRadar,
            90
        );

    const ouest =
        destinationGeographique(
            centreLat,
            centreLon,
            rayonRadar,
            270
        );

    axeEstOuest =
        L.polyline(
            [est, ouest],
            {
                color: couleurRadar,
                weight: 1.5,
                opacity: 0.75,
                dashArray: "5, 8"
            }
        ).addTo(carteRadar);
        function creerEtiquette(
            centreLat,
            centreLon,
            distance,
            texte,
            couleur
        ) {

            const position =
                destinationGeographique(
                    centreLat,
                    centreLon,
                    distance,
                    0
                );

            const icone = L.divIcon({
                className: "radar-label",
                html: `
                    <div class="radar-label-inner">
                        ${texte}
                    </div>
                `,
                iconSize: [60, 20],
                iconAnchor: [0, 10]
            });

            return L.marker(
                position,
                {
                    icon: icone,
                    interactive: false
                }
            ).addTo(carteRadar);
        }
}


// --------------------------------------------------
// INITIALISATION DE LA CARTE RADAR
// --------------------------------------------------

function initialiserCarteRadar() {

    const couleurRadar = "#ff9999";
    const centreLat =
        positionCourante.lat;

    const centreLon =
        positionCourante.lon;
    const rayonRadar = 15 * 1852;

    carteRadar = L.map("carteRadar", {
        maxZoom: 12
    }).setView(
        [centreLat, centreLon],
        9
    );

    // Couche réservée à l'image radar
    carteRadar.createPane("radarImagePane");
    carteRadar.getPane("radarImagePane").style.zIndex = 350;

    // Fond de carte actuel
    L.tileLayer("https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png?key=cb1_57wq_1_07826fc0a0495a659d44fac5", {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19
    }).addTo(carteRadar);

        reconstruireRadarGraphique(
            centreLat,
            centreLon
        );

    // --------------------------------------------------
    // MARQUEUR DE POSITION DES PREVISIONS AROME
    // --------------------------------------------------

    marqueurPrevisions = L.circleMarker(
        [positionCourante.lat, positionCourante.lon],
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
    carteRadar.on(
        "click",
        async function(e) {

            const lat =
                e.latlng.lat;

            const lon =
                e.latlng.lng;

            positionCourante = {
                lat,
                lon
            };

            localStorage.setItem(
                "positionArome",
                JSON.stringify(
                    positionCourante
                )
            );

            marqueurPrevisions.setLatLng(
                [lat, lon]
            );

            // Le radar couvre toute la France : seul le centre des repères change.
            reconstruireRadarGraphique(
                lat,
                lon
            );

            await chargerPrevisionsArome(
                lat,
                lon
            );
        }
    );

    // Chargement initial des prévisions à La Rochelle
    chargerPrevisionsArome(
        positionCourante.lat,
        positionCourante.lon
    );

    // Chargement radar
    chargerRadar();

    // Actualisation toutes les 10 minutes
    setInterval(chargerRadar, 10 * 60 * 1000);
}

// --------------------------------------------------
// Palette de couleur pour la vitesse du vent
// --------------------------------------------------

function couleurVent(vitesse) {

    const couleurs = [
        { v: 0,  c: [245, 245, 245] },
        { v: 5,  c: [245, 245, 245] },
        { v: 8,  c: [0, 190, 245] },
        { v: 11, c: [0, 220, 160] },
        { v: 15, c: [65, 225, 0] },
        { v: 18, c: [210, 215, 0] },
        { v: 20, c: [255, 170, 0] },
        { v: 25, c: [255, 100, 45] },
        { v: 30, c: [255, 45, 85] },
        { v: 35, c: [245, 15, 145] },
        { v: 40, c: [220, 0, 150] }
    ];

    if (vitesse <= couleurs[0].v) {
        return `rgb(${couleurs[0].c.join(",")})`;
    }

    for (let i = 0; i < couleurs.length - 1; i++) {

        const a = couleurs[i];
        const b = couleurs[i + 1];

        if (vitesse <= b.v) {

            const t = (vitesse - a.v) / (b.v - a.v);

            const r = Math.round(a.c[0] + t * (b.c[0] - a.c[0]));
            const g = Math.round(a.c[1] + t * (b.c[1] - a.c[1]));
            const bl = Math.round(a.c[2] + t * (b.c[2] - a.c[2]));

            return `rgb(${r},${g},${bl})`;
        }
    }

    return `rgb(${couleurs[couleurs.length - 1].c.join(",")})`;
}


// --------------------------------------------------
// CACHE AROME ET INTERPOLATION LOCALE DANS LE NAVIGATEUR
// --------------------------------------------------

const URL_OBSERVATIONS_PAGES =
    "https://alexandreguilloux85.github.io/meteo-la-rochelle/observations.json";

const URL_CACHE_AROME =
    "https://alexandreguilloux85.github.io/meteo-la-rochelle/arome-cache.json";

let cacheAromeNavigateur = null;
let chargementCacheAromeNavigateur = null;

async function chargerCacheAromeNavigateur() {
    if (cacheAromeNavigateur) {
        return cacheAromeNavigateur;
    }

    if (!chargementCacheAromeNavigateur) {
        chargementCacheAromeNavigateur = (async () => {
            const reponse = await fetch(URL_CACHE_AROME, {
                cache: "no-store"
            });

            if (!reponse.ok) {
                throw new Error(
                    "Impossible de charger le cache AROME : HTTP " +
                    reponse.status
                );
            }

            const cache = await reponse.json();

            if (
                !cache ||
                typeof cache.modele !== "string" ||
                !cache.zone ||
                !Array.isArray(cache.previsions)
            ) {
                throw new Error("Le fichier de cache AROME est invalide");
            }

            cacheAromeNavigateur = cache;
            return cache;
        })();
    }

    try {
        return await chargementCacheAromeNavigateur;
    } catch (erreur) {
        chargementCacheAromeNavigateur = null;
        throw erreur;
    }
}

function calculerPrevisionsAromeNavigateur(cache, latitude, longitude) {
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

    const zone = cache.zone;

    if (
        latitude < zone.latMin ||
        latitude > zone.latMax ||
        longitude < zone.lonMin ||
        longitude > zone.lonMax
    ) {
        throw new Error(
            "Position hors de la zone AROME disponible (15 × 15 km autour de La Rochelle)"
        );
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
        } catch (erreur) {
            erreurs.push({
                echeance: "H+" + h,
                erreur: erreur.message
            });
        }
    }

    const erreursCache = Array.isArray(cache.erreurs)
        ? cache.erreurs
        : [];

    if (previsions.length === 0) {
        throw new Error("Aucune prévision exploitable dans le cache AROME");
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
        nombre_erreurs: erreursCache.length + erreurs.length,
        methode: "Interpolation bilinéaire locale des composantes U/V",
        cache: true,
        origine_cache: "GitHub Pages",
        actualisation_en_cours: false,
        actualisation_statut: "non applicable",
        previsions,
        erreurs: [...erreursCache, ...erreurs]
    };
}

// --------------------------------------------------
// CHARGEMENT DES PREVISIONS AROME
// --------------------------------------------------


async function chargerPrevisionsArome(lat, lon, options = {}) {

    const statut = document.getElementById("previsionsMiseAJour");
    const tableau = document.getElementById("tableauPrevisions");
    const entete = document.getElementById("entetePrevisions");

    const numeroRequete = ++numeroRequetePrevisions;
    const tentativesActualisation = options.tentativesActualisation || 0;

    if (!options.silencieux) {
        statut.textContent = "Récupération des prévisions AROME...";

        tableau.innerHTML = `
            <tr><td colspan="2">Chargement des prévisions...</td></tr>
        `;
    }

    try {

        const cache = await chargerCacheAromeNavigateur();
        const resultat = calculerPrevisionsAromeNavigateur(
            cache,
            lat,
            lon
        );

        console.log("Prévisions AROME calculées dans le navigateur", resultat);

        if (!Array.isArray(resultat.previsions) ||
            resultat.previsions.length === 0) {
            throw new Error("Aucune prévision disponible");
        }

        if (numeroRequete !== numeroRequetePrevisions) return;
        if (!resultat.previsions) {

            console.error(resultat);

            throw new Error(
                "Pas de tableau previsions"
            );
        }
        const previsions = resultat.previsions;

        // ------------------------------------------
        // CONSTRUCTION DES EN-TETES JOUR ET HEURE
        // ------------------------------------------

        let groupesJours = [];

        previsions.forEach((p, index) => {

            const date = new Date(p.date);

            const jourCle = date.toLocaleDateString("fr-FR", {
                timeZone: "Europe/Paris",
                day: "2-digit",
                month: "2-digit",
                year: "numeric"
            });

            const heure = date.toLocaleTimeString("fr-FR", {
                timeZone: "Europe/Paris",
                hour: "2-digit",
                minute: "2-digit"
            });

            let dernierGroupe = groupesJours[groupesJours.length - 1];

            if (!dernierGroupe || dernierGroupe.cle !== jourCle) {

                const nomJour = date.toLocaleDateString("fr-FR", {
                    timeZone: "Europe/Paris",
                    weekday: "long",
                    day: "2-digit"
                });

                groupesJours.push({
                    cle: jourCle,
                    nom: nomJour.charAt(0).toUpperCase()
                        + nomJour.slice(1),
                    heures: []
                });

                dernierGroupe = groupesJours[groupesJours.length - 1];
            }

            dernierGroupe.heures.push({
                index: index,
                heure: heure
            });

        });

        // Première ligne : les jours
        let ligneJours = `
            <tr>
                <th rowspan="2" class="colonne-parametre"></th>
        `;

        groupesJours.forEach((groupe, index) => {

            ligneJours += `
                <th colspan="${groupe.heures.length}"
                    class="jour-prevision${index > 0 ? " separateur-jour" : ""}">
                    ${groupe.nom}
                </th>
            `;

        });

        ligneJours += `</tr>`;

        // Deuxième ligne : les heures
        let ligneHeures = `<tr>`;
        groupesJours.forEach((groupe, groupeIndex) => {

            groupe.heures.forEach((element, heureIndex) => {

                ligneHeures += `
                    <th class="heure-prevision${
                        groupeIndex > 0 && heureIndex === 0
                            ? " separateur-jour"
                            : ""
                    }">
                        ${element.heure}
                    </th>
                `;

            });

        });

        ligneHeures += `</tr>`;

        entete.innerHTML = ligneJours + ligneHeures;
        const separateursJours = new Set(
            groupesJours.slice(1).map(groupe => groupe.heures[0].index)
        );

        // ------------------------------------------
        // LIGNE VITESSE DU VENT
        // ------------------------------------------

        let ligneVent = `
            <tr>
                <td class="cellule-parametre">Vent (kt)</td>
        `;

        previsions.forEach((p, index) => {

            const vitesseKt = Number(p.vitesse) * 1.94384;

            const vitesseTexte = Number.isFinite(vitesseKt)
                ? vitesseKt.toFixed(0)
                : "--";

            const couleur = Number.isFinite(vitesseKt)
                ? couleurVent(vitesseKt)
                : "#dce3eb";

            ligneVent += `
                <td class="cellule-vent${
                    separateursJours.has(index) ? " separateur-jour" : ""
                }"
                    style="background-color: ${couleur}">
                    ${vitesseTexte}
                </td>
            `;

        });

        ligneVent += `</tr>`;

        // ------------------------------------------
        // LIGNE RAFALES
        // ------------------------------------------

        let ligneRafales = `
            <tr>
                <td class="cellule-parametre">Rafales (kt)</td>
        `;

        previsions.forEach((p, index) => {
            const rafaleMs = p.rafale == null
                ? NaN
                : Number(p.rafale);

            const rafaleKt = Number.isFinite(rafaleMs)
                ? rafaleMs * 1.94384
                : NaN;

            const rafaleTexte = Number.isFinite(rafaleKt)
                ? rafaleKt.toFixed(0)
                : "--";

            const couleur = Number.isFinite(rafaleKt)
                ? couleurVent(rafaleKt)
                : "#dce3eb";

            ligneRafales += `
                <td class="cellule-vent cellule-rafale${
                    separateursJours.has(index) ? " separateur-jour" : ""
                }"
                    style="background-color: ${couleur}">
                    ${rafaleTexte}
                </td>
            `;
        });

        ligneRafales += `</tr>`;

        // ------------------------------------------
        // LIGNE DIRECTION DU VENT
        // ------------------------------------------

        let ligneDirection = `
            <tr>
                <td class="cellule-parametre">Direction</td>
        `;

        previsions.forEach((p, index) => {

            const direction = Number(p.direction);

            if (Number.isFinite(direction)) {

                const directionCardinale = directionTexte(direction);

                ligneDirection += `
                    <td class="cellule-direction${
                        separateursJours.has(index) ? " separateur-jour" : ""
                    }">
                        <span class="fleche-prevision"
                            style="transform: rotate(${direction + 180}deg)">
                            ↑
                        </span>
                        <div>${direction.toFixed(0)}°</div>
                        <div>${directionCardinale}</div>
                    </td>
                `;

            } else {
                ligneDirection += `
                    <td class="cellule-direction${
                        separateursJours.has(index) ? " separateur-jour" : ""
                    }">--</td>
                `;
            }

        });

        ligneDirection += `</tr>`;

        // Affichage du tableau
        tableau.innerHTML = ligneVent +ligneRafales + ligneDirection;

        // ------------------------------------------
        // INFORMATIONS DU MODELE
        // ------------------------------------------

        const modele = resultat.modele
            ? String(resultat.modele)
                .replace("T", " ")
                .replace("Z", " UTC")
            : "--";

        let origine = "Téléchargement de nouveaux GRIB";

        if (resultat.cache === true) {
            origine = resultat.origine_cache === "GitHub Pages"
                ? "Prévisions depuis le cache GitHub Pages"
                : "Prévisions depuis le cache local";
        }

        let statutActualisation = "";

        if (resultat.actualisation_statut === "failed") {
            statutActualisation = " · vérification échouée, cache conservé";
        } else if (resultat.catalogue_indisponible) {
            statutActualisation =
                " · catalogue indisponible, cache conservé";
        }

        statut.textContent =
            origine + " · " +
            previsions.length + " échéances · Modèle du " + modele +
            (resultat.actualisation_incomplete
                ? " · actualisation incomplète"
                : "") +
            (resultat.actualisation_en_cours
                ? " · vérification des nouveautés en arrière-plan"
                : "") +
            statutActualisation;

        //console.log("Prévisions AROME chargées :", resultat);
        console.log("Nombre de prévisions :", resultat.previsions.length);
        console.log("Erreurs de téléchargement AROME :");
        console.table(resultat.erreurs || []);

    } catch (erreur) {

        if (numeroRequete !== numeroRequetePrevisions) return;

        console.error("Erreur prévisions AROME :", erreur);

        statut.textContent = options.silencieux
            ? "Anciennes prévisions conservées · vérification impossible"
            : "Prévisions indisponibles";

        if (options.silencieux) return;

        entete.innerHTML = `
            <tr><th>Prévisions AROME</th></tr>
        `;

        tableau.innerHTML = `
            <tr>
                <td colspan="2">Erreur : ${erreur.message}</td>
            </tr>
        `;
    }
}


// --------------------------------------------------
// CHARGEMENT DE L'IMAGE RADAR
// --------------------------------------------------

async function appliquerMetadataRadar(metadata) {
    if (!metadata || !metadata.date || metadata.zoom_max !== 9 || metadata.tile_size !== 256) {
        throw new Error("Métadonnées des tuiles radar invalides");
    }

    const dateRadar = metadata.date;
    if (dateRadarAffichee === dateRadar && coucheRadar) return;

    const urlTuiles = URL_RADAR_TUILES +
        "/{z}/{x}/{y}.png?v=" + encodeURIComponent(dateRadar);

    if (!coucheRadar) {
        coucheRadar = L.tileLayer(urlTuiles, {
            minZoom: 4,
            maxNativeZoom: 9,
            maxZoom: 12,
            tileSize: 256,
            opacity: 0.95,
            tms: false,
            errorTileUrl: "",
            pane: "radarImagePane",
            updateWhenIdle: true,
            keepBuffer: 2
        }).addTo(carteRadar);
    } else if (coucheRadar.options && coucheRadar.options._url !== urlTuiles) {
        coucheRadar.setUrl(urlTuiles);
    }

    dateRadarAffichee = dateRadar;
    const date = new Date(dateRadar);
    document.getElementById("radarMiseAJour").textContent =
        "Radar : " + date.toLocaleString("fr-FR", {
            day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
        });
}

let chargementRadarEnCours = false;
let dateRadarAffichee = null;

async function chargerRadar() {
    if (chargementRadarEnCours) return;
    chargementRadarEnCours = true;
    const statut = document.getElementById("radarMiseAJour");

    try {
        const cache = lireCacheLocal(CLE_CACHE_RADAR);
        if (cache && cache.date) {
            await appliquerMetadataRadar(cache);
        }

        const reponse = await fetch(URL_RADAR_TUILES + "/metadata.json", {
            cache: "no-cache"
        });
        if (!reponse.ok) throw new Error("Métadonnées radar : HTTP " + reponse.status);

        const metadata = await reponse.json();
        if (!metadata.date || metadata.zoom_max !== 9 || metadata.tile_size !== 256) {
            throw new Error("Métadonnées des tuiles radar invalides");
        }

        if (!cache || cache.date !== metadata.date) {
            ecrireCacheLocal(CLE_CACHE_RADAR, metadata);
            await appliquerMetadataRadar(metadata);
            console.log("Nouveau produit radar chargé :", metadata.date);
        } else {
            console.log("Radar inchangé :", metadata.date);
        }
    } catch (erreur) {
        console.error("Erreur chargement radar XYZ :", erreur);
        if (!lireCacheLocal(CLE_CACHE_RADAR)) {
            statut.textContent = "Radar indisponible · aucune image en cache";
        }
    } finally {
        chargementRadarEnCours = false;
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

const CLE_CACHE_OBSERVATIONS = "meteo_observations_v1";
const CLE_CACHE_RADAR = "meteo_radar_metadata_v1";

function lireCacheLocal(cle) {
    try {
        const valeur = localStorage.getItem(cle);
        return valeur ? JSON.parse(valeur) : null;
    } catch (erreur) {
        console.warn("Cache local illisible :", cle, erreur);
        return null;
    }
}

function ecrireCacheLocal(cle, valeur) {
    try {
        localStorage.setItem(cle, JSON.stringify(valeur));
    } catch (erreur) {
        console.warn("Impossible d'enregistrer le cache local :", cle, erreur);
    }
}

function normaliserObservations(resultat) {
    const lignes = Array.isArray(resultat)
        ? resultat
        : resultat.features || resultat.data || [];

    return lignes.map(item => {
        const d = item.properties || item;
        return {
            date: d.validity_time,
            ff: d.ff == null ? null : Number(d.ff),
            raf10: d.raf10 == null ? null : Number(d.raf10),
            dd: d.dd == null ? null : Number(d.dd),
            pmer: d.pmer == null ? null : Number(d.pmer),
            t: d.t == null ? null : Number(d.t)
        };
    }).filter(d =>
        d.date &&
        Number.isFinite(new Date(d.date).getTime()) &&
        Number.isFinite(d.ff)
    ).sort((a, b) => new Date(a.date) - new Date(b.date));
}

function afficherDonnees(donnees) {
    if (!Array.isArray(donnees) || donnees.length === 0) return;

    const dernier = donnees[donnees.length - 1];

    document.getElementById("ventActuel").textContent =
        noeuds(dernier.ff).toFixed(1);
    document.getElementById("rafaleActuelle").textContent =
        Number.isFinite(dernier.raf10) ? noeuds(dernier.raf10).toFixed(1) : "--";

    if (Number.isFinite(dernier.dd)) {
        document.getElementById("directionActuelle").textContent =
            dernier.dd.toFixed(0) + "°";
        document.getElementById("directionCardinale").textContent =
            directionTexte(dernier.dd);
        document.getElementById("flecheDirection").style.transform =
            "rotate(" + (dernier.dd + 180) + "deg)";
    } else {
        document.getElementById("directionActuelle").textContent = "--°";
        document.getElementById("directionCardinale").textContent = "--";
    }

    document.getElementById("pressionActuelle").textContent =
        Number.isFinite(dernier.pmer) ? (dernier.pmer / 100).toFixed(1) : "----";

    const limite = Date.now() - 24 * 60 * 60 * 1000;
    const donnees24h = donnees.filter(d => {
        const temps = new Date(d.date).getTime();
        return temps >= limite && temps <= Date.now();
    });

    if (donnees24h.length === 0) {
        console.warn("Aucune donnée météo disponible sur les dernières 24 h.");
        return;
    }

    creerGraphiques(donnees24h);

    document.getElementById("tableau").innerHTML = donnees24h
        .slice().reverse().slice(0, 30).map(d => `
            <tr>
                <td>${new Date(d.date).toLocaleString("fr-FR")}</td>
                <td>${noeuds(d.ff).toFixed(1)}</td>
                <td>${Number.isFinite(d.raf10) ? noeuds(d.raf10).toFixed(1) : "--"}</td>
                <td>${Number.isFinite(d.dd) ? d.dd.toFixed(0) + "° " + directionTexte(d.dd) : "--"}</td>
                <td>${Number.isFinite(d.pmer) ? (d.pmer / 100).toFixed(1) : "--"}</td>
                <td>${Number.isFinite(d.t) ? (d.t - 273.15).toFixed(1) : "--"}</td>
            </tr>
        `).join("");

    document.getElementById("miseAJour").textContent =
        "Dernier relevé : " + new Date(dernier.date).toLocaleString("fr-FR");
}

let chargementObservationsEnCours = false;

async function chargerDonnees() {
    if (chargementObservationsEnCours) return;
    chargementObservationsEnCours = true;

    // Afficher immédiatement les dernières observations sauvegardées localement.
    const cacheInitial = lireCacheLocal(CLE_CACHE_OBSERVATIONS);
    if (cacheInitial && Array.isArray(cacheInitial.donnees) && cacheInitial.donnees.length) {
        afficherDonnees(cacheInitial.donnees);
    }

    try {
        const reponse = await fetch(URL_OBSERVATIONS_PAGES, {
            cache: "no-cache"
        });
        if (!reponse.ok) throw new Error("Erreur HTTP : " + reponse.status);

        const nouvellesDonnees = normaliserObservations(await reponse.json());
        if (nouvellesDonnees.length === 0) {
            throw new Error("Aucune donnée météo exploitable");
        }

        const cache = lireCacheLocal(CLE_CACHE_OBSERVATIONS);
        const anciennesDonnees = cache && Array.isArray(cache.donnees)
            ? cache.donnees
            : [];
        const ancienneDate = anciennesDonnees.length
            ? new Date(anciennesDonnees[anciennesDonnees.length - 1].date).getTime()
            : 0;
        const nouvelleDate = new Date(nouvellesDonnees[nouvellesDonnees.length - 1].date).getTime();

        if (nouvelleDate > ancienneDate || anciennesDonnees.length === 0) {
            ecrireCacheLocal(CLE_CACHE_OBSERVATIONS, {
                dateDernierReleve: nouvellesDonnees[nouvellesDonnees.length - 1].date,
                donnees: nouvellesDonnees
            });
            afficherDonnees(nouvellesDonnees);
            console.log("Nouveaux relevés météo chargés :", nouvellesDonnees.length);
        } else {
            console.log("Relevés météo inchangés : cache local conservé.");
        }
    } catch (erreur) {
        console.error("Vérification des relevés météo impossible :", erreur);
        const cache = lireCacheLocal(CLE_CACHE_OBSERVATIONS);
        if (!cache || !Array.isArray(cache.donnees) || cache.donnees.length === 0) {
            document.getElementById("miseAJour").textContent =
                "Relevés indisponibles · aucune donnée en cache";
        }
    } finally {
        chargementObservationsEnCours = false;
    }
}

function distanceMetres(
    lat1,
    lon1,
    lat2,
    lon2
) {
    const R = 6371000;

    const dLat =
        (lat2 - lat1) *
        Math.PI / 180;

    const dLon =
        (lon2 - lon1) *
        Math.PI / 180;

    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) *
        Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;

    return (
        2 *
        R *
        Math.atan2(
            Math.sqrt(a),
            Math.sqrt(1 - a)
        )
    );
}


// --------------------------------------------------
// DEMARRAGE
// --------------------------------------------------
async function declencherWorkflowDepuisInterface(workflow, bouton) {
    const champJeton = document.getElementById("workflowTriggerToken");
    const statut = document.getElementById("workflowTriggerStatus");
    const jeton = champJeton.value.trim();

    if (!jeton) {
        statut.textContent = "Saisis le code d'accès Render.";
        champJeton.focus();
        return;
    }

    bouton.disabled = true;
    statut.textContent = "Connexion à Render…";

    try {
        const reponse = await fetch(
            `${URL_SERVEUR_RENDER}/api/workflows/${encodeURIComponent(workflow)}`,
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${jeton}`
                },
                cache: "no-store"
            }
        );
        const resultat = await reponse.json();

        if (!reponse.ok) {
            throw new Error(resultat.erreur || `Erreur HTTP ${reponse.status}`);
        }

        statut.textContent =
            "Demande envoyée. Les données apparaîtront après le téléchargement et la publication du site.";
    } catch (erreur) {
        console.error("Déclenchement du workflow impossible :", erreur);
        statut.textContent = erreur.message ||
            "Impossible de contacter Render. Le service peut être en veille.";
    } finally {
        bouton.disabled = false;
    }
}

document.querySelectorAll("[data-workflow]").forEach(bouton => {
    bouton.addEventListener("click", () => {
        declencherWorkflowDepuisInterface(bouton.dataset.workflow, bouton);
    });
});

function demarrerApplication() {
    // Afficher la carte et les données en cache sans attendre le serveur.
    initialiserCarteRadar();
    chargerDonnees();

    // Les mises à jour sont automatisées par GitHub Actions.
}

demarrerApplication();

// Actualisation météo toutes les 6 minutes
setInterval(chargerDonnees, 6 * 60 * 1000);
