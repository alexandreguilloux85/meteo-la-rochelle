let graphiqueVent = null;
let graphiqueDirection = null;
let graphiqueVentPolaire = null;
let graphiquePression = null;
let graphiquePrecipitations = null;
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

const HOTE_PAGES = "alexandreguilloux85.github.io";
const URL_RENDER_PRODUCTION = "https://station-meteo-lr.onrender.com";
const URL_SERVEUR_RENDER = window.location.hostname === HOTE_PAGES
    ? URL_RENDER_PRODUCTION : window.location.origin;
const URL_OBSERVATIONS_RENDER = URL_SERVEUR_RENDER + "/api/observations";
const URL_RADAR_TUILES = URL_SERVEUR_RENDER + "/api/radar/tiles";
const URL_RADAR_METADATA = URL_SERVEUR_RENDER + "/api/radar/metadata";
// --------------------------------------------------
// PREVISIONS AROME
// --------------------------------------------------

let marqueurPrevisions = null;
let flecheVentStation = null;
let derniereMesureVentStation = null;
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



// Flèche vers la cible AROME : déplacement théorique en 10 min
// à la vitesse du vent moyen mesurée à la station (ff en m/s).
// dd est la provenance météorologique du vent : la flèche pointe
// donc dans le sens opposé, vers la cible.
function actualiserFlecheVentStation() {
    if (!carteRadar) return;

    if (flecheVentStation) {
        carteRadar.removeLayer(flecheVentStation);
        flecheVentStation = null;
    }

    const mesure = derniereMesureVentStation;
    if (!mesure || !Number.isFinite(mesure.ff) ||
        !Number.isFinite(mesure.dd) || mesure.ff <= 0) return;

    const distance = mesure.ff * 600; // 10 minutes en secondes
    const directionProvenance = ((mesure.dd % 360) + 360) % 360;
    const cible = [positionCourante.lat, positionCourante.lon];
    const depart = destinationGeographique(
        cible[0], cible[1], distance, directionProvenance
    );

    // Pointe sur la cible, branches remontant vers le vent d'origine.
    const longueurPointe = Math.min(distance * 0.18, 900);
    const aileGauche = destinationGeographique(
        cible[0], cible[1], longueurPointe, directionProvenance - 24
    );
    const aileDroite = destinationGeographique(
        cible[0], cible[1], longueurPointe, directionProvenance + 24
    );

    flecheVentStation = L.layerGroup([
        L.polyline([depart, cible], {
            color: "#123f70", weight: 4, opacity: 0.92,
            interactive: false
        }),
        L.polyline([aileGauche, cible, aileDroite], {
            color: "#123f70", weight: 4, opacity: 0.92,
            lineCap: "round", lineJoin: "round", interactive: false
        })
    ]).addTo(carteRadar);
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

    // Limites de la zone du cache AROME GRIB2.
    // Un pane dédié maintient le tracé au-dessus des tuiles radar.
    // Le rectangle ne doit pas intercepter les clics destinés aux prévisions.
    carteRadar.createPane("contourZoneGribPane");
    const paneGrib = carteRadar.getPane("contourZoneGribPane");
    paneGrib.style.zIndex = 425;
    paneGrib.style.pointerEvents = "none";

    L.rectangle(ZONE_AROME_GRIB, {
        pane: "contourZoneGribPane",
        color: "#000000",
        weight: 2,
        opacity: 1,
        dashArray: "4, 7",
        lineCap: "round",
        fill: false,
        interactive: false
    }).addTo(carteRadar);

    reconstruireRadarGraphique(centreLat, centreLon);

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

    actualiserFlecheVentStation();

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
        function(e) {

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
            actualiserFlecheVentStation();

            // Le radar couvre toute la France : seul le centre des repères change.
            reconstruireRadarGraphique(
                lat,
                lon
            );

            chargerPrevisionsAuPoint(positionCourante);
        }
    );

    // Le marqueur, la frise AROME et la prévision immédiate partagent le même point.
    chargerPrevisionsAuPoint(positionCourante);

    // Chargement radar
    chargerRadar();

    // Les tuiles nationales sont republiées toutes les 10 minutes par Actions.
    setInterval(chargerRadar, 10 * 60 * 1000);
}

function chargerPrevisionsAuPoint({ lat, lon }, options) {
    window.selectionnerPointAromePi?.(lat, lon, options);
    return chargerPrevisionsArome(lat, lon, options);
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
// PALETTE WINDY POUR LA FUTURE FRISE AROME
// --------------------------------------------------

// Couleurs relevées dans les deux extraits Windy fournis : vent et rafales.
// Vitesse en nœuds. En dehors de [5, 38] kt, conserver la couleur limite.
const PALETTE_VENT_WINDY = [
    { kt: 5,  hex: "#F4F4F4" },
    { kt: 7,  hex: "#73DDFA" },
    { kt: 8,  hex: "#13CCFE" },
    { kt: 9,  hex: "#00D3DE" },
    { kt: 10, hex: "#00E96E" },
    { kt: 11, hex: "#00EC36" },
    { kt: 12, hex: "#00E90B" },
    { kt: 15, hex: "#4DE200" },
    { kt: 18, hex: "#C6C100" },
    { kt: 20, hex: "#FFAB00" },
    { kt: 22, hex: "#FF9205" },
    { kt: 25, hex: "#FF7713" },
    { kt: 30, hex: "#FF394E" },
    { kt: 35, hex: "#FF0C89" },
    { kt: 38, hex: "#FF0097" }
];

// Retourne une couleur CSS #RRGGBB. null signifie vitesse indisponible.
// Ne change pas le tableau existant : il utilise toujours couleurVent().
function couleurVentWindy(vitesseKt) {
    if (!Number.isFinite(vitesseKt)) return null;

    const palette = PALETTE_VENT_WINDY;
    if (vitesseKt <= palette[0].kt) return palette[0].hex;
    if (vitesseKt >= palette[palette.length - 1].kt) {
        return palette[palette.length - 1].hex;
    }

    for (let i = 1; i < palette.length; i++) {
        const bas = palette[i - 1];
        const haut = palette[i];
        if (vitesseKt > haut.kt) continue;

        const fraction = (vitesseKt - bas.kt) / (haut.kt - bas.kt);
        const composantes = [1, 3, 5].map(index => {
            const debut = parseInt(bas.hex.slice(index, index + 2), 16);
            const fin = parseInt(haut.hex.slice(index, index + 2), 16);
            return Math.round(debut + fraction * (fin - debut))
                .toString(16).padStart(2, "0");
        });
        return "#" + composantes.join("").toUpperCase();
    }

    return palette[palette.length - 1].hex;
}

// --------------------------------------------------
// CACHE AROME ET INTERPOLATION LOCALE DANS LE NAVIGATEUR
// --------------------------------------------------

const ZONE_AROME_GRIB = [[43.2, -5.0], [48.3, -0.3]];
// Le serveur au point et le WCS restent disponibles en secours.
const URL_PREVISIONS_PAQUETS_POINT =
    URL_SERVEUR_RENDER + "/api/arome/paquets/test/previsions";
const URL_STATUT_PAQUETS = URL_SERVEUR_RENDER + "/api/arome/paquets/test/status";
const URL_PREVISIONS_WCS_POINT =
    URL_SERVEUR_RENDER + "/api/arome/previsions";
const URL_CACHE_AROME = URL_SERVEUR_RENDER === URL_RENDER_PRODUCTION
    ? "https://alexandreguilloux85.github.io/meteo-la-rochelle/arome-cache.json"
    : URL_SERVEUR_RENDER + "/api/arome/cache/public";

let cacheAromeNavigateur = null;
let chargementCacheAromeNavigateur = null;
let workerPaquets = null;
let numeroPointLocal = 0;
const pointsLocauxEnAttente = new Map();

function pointDansPaquets(lat, lon) {
    const [[sud, ouest], [nord, est]] = ZONE_AROME_GRIB;
    return lat >= sud && lat <= nord && lon >= ouest && lon <= est;
}

function obtenirPointLocal(lat, lon, forcer) {
    if (!workerPaquets) {
        workerPaquets = new Worker(new URL("arome-paquets-worker.js", document.baseURI));
        workerPaquets.onmessage = ({ data }) => {
            if (data.type === "nouveau-modele") {
                const p = positionCourante;
                if (pointDansPaquets(p.lat, p.lon)) {
                    void chargerPrevisionsArome(p.lat, p.lon, { silencieux: true });
                }
                return;
            }
            const demande = pointsLocauxEnAttente.get(data.id);
            if (!demande) return;
            pointsLocauxEnAttente.delete(data.id);
            if (data.erreur) demande.reject(new Error(data.erreur));
            else demande.resolve(data.resultat);
        };
        workerPaquets.onerror = () => {
            workerPaquets.terminate();
            workerPaquets = null;
            for (const demande of pointsLocauxEnAttente.values()) {
                demande.reject(new Error("Calcul local AROME indisponible"));
            }
            pointsLocauxEnAttente.clear();
        };
    }
    return new Promise((resolve, reject) => {
        const id = ++numeroPointLocal;
        pointsLocauxEnAttente.set(id, { resolve, reject });
        workerPaquets.postMessage({ id, lat, lon, forcer });
    });
}

async function chargerCacheAromeNavigateur() {
    if (cacheAromeNavigateur) {
        return cacheAromeNavigateur;
    }

    if (!chargementCacheAromeNavigateur) {
        chargementCacheAromeNavigateur = (async () => {
            const reponse = await fetch(URL_CACHE_AROME, {
                cache: "no-store",
                signal: AbortSignal.timeout?.(10000)
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

// --------------------------------------------------
// PREVISIONS AROME AU POINT CLIQUE
// --------------------------------------------------

async function obtenirPrevisionsAromeAuPoint(url, lat, lon) {
    const adresse = new URL(url);
    adresse.searchParams.set("lat", String(lat));
    adresse.searchParams.set("lon", String(lon));

    const reponse = await fetch(adresse, {
        cache: "no-store",
        signal: AbortSignal.timeout?.(25000)
    });
    if (!reponse.ok) {
        let detail;
        try {
            detail = (await reponse.json()).erreur;
        } catch (_erreur) {
            detail = null;
        }
        throw new Error(detail || "HTTP " + reponse.status);
    }
    const resultat = await reponse.json();
    if (!resultat.succes || !Array.isArray(resultat.previsions) ||
        resultat.previsions.length === 0) {
        throw new Error(resultat.erreur || "Réponse AROME au point invalide");
    }
    return resultat;
}

async function obtenirPrevisionsAromePourAffichage(lat, lon, forcer = false) {
    if (pointDansPaquets(lat, lon)) {
        try {
            const resultat = await obtenirPointLocal(lat, lon, forcer);
            return { resultat, source: "local" };
        } catch (erreurLocale) {
            console.warn("Cache GitHub Pages indisponible pour ce point :", erreurLocale.message);
        }
        try {
            const resultat = await obtenirPrevisionsAromeAuPoint(
                URL_PREVISIONS_PAQUETS_POINT, lat, lon
            );
            return { resultat, source: "GRIB2" };
        } catch (erreurPaquets) {
            console.warn(
                "AROME Paquets au point indisponible ; WCS de secours :",
                erreurPaquets.message
            );
        }
    }

    try {
        const resultat = await obtenirPrevisionsAromeAuPoint(
            URL_PREVISIONS_WCS_POINT, lat, lon
        );
        return { resultat, source: "WCS" };
    } catch (erreurWcs) {
        console.warn("AROME WCS sur Render indisponible, lecture du cache de secours", erreurWcs.message);
    }

    const cache = await chargerCacheAromeNavigateur();
    const resultat = calculerPrevisionsAromeNavigateur(cache, lat, lon);
    return { resultat, source: "WCS" };
}

// --------------------------------------------------
// CHARGEMENT DES PREVISIONS AROME
// --------------------------------------------------


async function chargerPrevisionsArome(lat, lon, options = {}) {

    const statut = document.getElementById("previsionsMiseAJour");
    const frise = document.getElementById("frise-meteo");
    const noteFrise = document.getElementById("frise-meteo-note");

    const numeroRequete = ++numeroRequetePrevisions;

    if (!options.silencieux) {
        statut.textContent = "Récupération des prévisions AROME...";

        if (frise) {
            frise.textContent = "Chargement de la frise...";
        }
        if (noteFrise) noteFrise.textContent = "";
    }

    try {

        const { resultat, source } = await obtenirPrevisionsAromePourAffichage(lat, lon, options.relire);

        console.log("Prévisions AROME au point sélectionné", resultat);

        if (numeroRequete !== numeroRequetePrevisions) return;
        const previsions = resultat.previsions;
        window.afficherFriseMeteoArome?.(previsions, lat, lon);

        // ------------------------------------------
        // INFORMATIONS DU MODELE
        // ------------------------------------------

        const modele = resultat.modele
            ? String(resultat.modele)
                .replace("T", " ")
                .replace("Z", " UTC")
            : "--";

        const origine = {
            local: "AROME calculé sur cet appareil · Cache GitHub Pages",
            GRIB2: "Prévisions AROME GRIB2 depuis Render (secours)",
            WCS: "Prévisions WCS de secours au point sélectionné"
        }[source];

        let statutActualisation = "";

        if (resultat.actualisation_statut === "echec" ||
            resultat.actualisation_statut === "failed") {
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
        return source;

    } catch (erreur) {

        if (numeroRequete !== numeroRequetePrevisions) return;

        console.error("Erreur prévisions AROME :", erreur);

        statut.textContent = options.silencieux
            ? "Anciennes prévisions conservées · vérification impossible"
            : "Prévisions indisponibles";

        if (options.silencieux) return;

        if (frise) frise.textContent = "Erreur : " + erreur.message;
        if (noteFrise) noteFrise.textContent = "";
    }
}


// --------------------------------------------------
// CHARGEMENT DE L'IMAGE RADAR
// --------------------------------------------------

let dateRadarAffichee = null;

async function appliquerMetadataRadar(metadata) {
    if (
        !metadata ||
        !metadata.date ||
        metadata.zoom_min !== 4 ||
        metadata.zoom_max !== 9 ||
        metadata.tile_size !== 256
    ) {
        throw new Error("Métadonnées des tuiles radar invalides");
    }

    const dateRadar = metadata.date;
    if (dateRadarAffichee === dateRadar && coucheRadar) return;

    const urlTuiles =
        URL_RADAR_TUILES +
        "/{z}/{x}/{y}.png?v=" +
        encodeURIComponent(dateRadar);

    if (!coucheRadar) {
        coucheRadar = L.tileLayer(urlTuiles, {
            minZoom: metadata.zoom_min,
            maxNativeZoom: metadata.zoom_max,
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

let promesseChargementRadar = null;

async function chargerRadar(forcerVerification = false) {
    // Le bouton manuel doit vérifier Météo-France même si le
    // chargement automatique d'un radar est encore en cours.
    if (promesseChargementRadar) {
        if (!forcerVerification) return false;
        await promesseChargementRadar;
    }

    const promesse = chargerRadarInterne(forcerVerification);
    promesseChargementRadar = promesse;
    try {
        return await promesse;
    } finally {
        if (promesseChargementRadar === promesse) {
            promesseChargementRadar = null;
        }
    }
}

async function chargerRadarInterne(forcerVerification) {
    const statut = document.getElementById("radarMiseAJour");

    try {
        const cache = lireCacheLocal(CLE_CACHE_RADAR);
        if (cache && cache.date) {
            await appliquerMetadataRadar(cache);
        }

        const urlMetadata = new URL(
            URL_RADAR_METADATA
        );
        if (forcerVerification) {
            urlMetadata.searchParams.set("refresh", "1");
        }

        const reponse = await fetch(urlMetadata, {
            cache: "no-store"
        });
        if (!reponse.ok) {
            const detail = await reponse.json().catch(() => null);
            throw new Error(
                detail?.erreur || "Métadonnées radar : HTTP " + reponse.status
            );
        }

        const metadata = await reponse.json();
        if (
            !metadata.date ||
            metadata.zoom_min !== 4 ||
            metadata.zoom_max !== 9 ||
            metadata.tile_size !== 256
        ) {
            throw new Error("Métadonnées des tuiles radar invalides");
        }

        const dateAncienRadar = cache?.date
            ? new Date(cache.date).getTime()
            : -Infinity;
        const dateDernierRadar = new Date(metadata.date).getTime();
        const nouveauRadar = dateDernierRadar > dateAncienRadar;

        if (!cache || cache.date !== metadata.date) {
            ecrireCacheLocal(CLE_CACHE_RADAR, metadata);
            await appliquerMetadataRadar(metadata);
            console.log("Produit radar mis à jour :", metadata.date);
        } else {
            console.log("Radar inchangé :", metadata.date);
        }
        return {
            nouveauRadar,
            dateDernierRadar: metadata.date
        };
    } catch (erreur) {
        console.error("Erreur chargement radar XYZ :", erreur);
        if (!lireCacheLocal(CLE_CACHE_RADAR)) {
            statut.textContent = "Radar indisponible · aucune image en cache";
        }
        return { echec: true, erreur: erreur.message };
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
// CREATION DES GRAPHIQUES
// --------------------------------------------------

// rr_per : cumul mesuré en mm sur 6 minutes, converti en mm/h à l’affichage.
function intensitePrecipitations(rrPer) {
    return Number.isFinite(rrPer) && rrPer >= 0 ? rrPer * 10 : null;
}

const COULEURS_TEMPS_VENT = [
    [35, 91, 175],
    [109, 55, 161],
    [181, 53, 91],
    [205, 98, 7]
];

const formatDateVentPolaire = new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
});

function couleurTempsVent(fraction) {
    const position = fraction * (COULEURS_TEMPS_VENT.length - 1);
    const indice = Math.min(Math.floor(position), COULEURS_TEMPS_VENT.length - 2);
    const progression = position - indice;
    const debut = COULEURS_TEMPS_VENT[indice];
    const fin = COULEURS_TEMPS_VENT[indice + 1];
    const couleur = debut.map((canal, i) => Math.round(canal + progression * (fin[i] - canal)));
    return `rgb(${couleur.join(", ")})`;
}

function actualiserLegendeTempsVent(premierTemps, dernierTemps) {
    const legende = document.getElementById("legendeTempsVent");
    legende.hidden = premierTemps >= dernierTemps;
    if (legende.hidden) return;

    legende.querySelector(".degrade-temps-vent").style.backgroundImage =
        `linear-gradient(90deg, ${COULEURS_TEMPS_VENT.map(couleur => `rgb(${couleur.join(", ")})`).join(", ")})`;

    const dates = legende.querySelectorAll("time");
    for (const [i, temps] of [premierTemps, dernierTemps].entries()) {
        dates[i].dateTime = new Date(temps).toISOString();
        dates[i].textContent = formatDateVentPolaire.format(temps);
    }
}

function creerGraphiquePolaireVent(donnees) {
    const points = [];
    let vitesseMax = 0;
    let premierTemps = Infinity;
    let dernierTemps = -Infinity;

    for (const { ff, dd, date } of donnees) {
        if (!Number.isFinite(ff) || ff < 0 || !Number.isFinite(dd) || dd < 0 || dd > 360) {
            continue;
        }

        const temps = new Date(date).getTime();
        if (!Number.isFinite(temps)) continue;

        const vitesse = noeuds(ff);
        const direction = dd % 360;
        const angle = direction * Math.PI / 180;
        points.push({
            x: vitesse * Math.sin(angle),
            y: vitesse * Math.cos(angle),
            vitesse,
            direction,
            temps
        });
        vitesseMax = Math.max(vitesse, vitesseMax);
        premierTemps = Math.min(premierTemps, temps);
        dernierTemps = Math.max(dernierTemps, temps);
    }

    actualiserLegendeTempsVent(premierTemps, dernierTemps);
    const duree = dernierTemps - premierTemps;
    const couleurs = points.map(({ temps }) =>
        couleurTempsVent(duree > 0 ? (temps - premierTemps) / duree : 1)
    );

    const pas = Math.max(5, Math.ceil(vitesseMax / 25) * 5);
    const rayonMax = Math.max(2, Math.ceil(vitesseMax / pas)) * pas;
    const echelle = { display: false, min: -rayonMax, max: rayonMax };
    const options = optionsGraphique("Vitesse", "kt");

    return new Chart(document.getElementById("graphVentPolaire"), {
        type: "scatter",
        data: {
            datasets: [{
                data: points,
                showLine: false,
                pointRadius: 3,
                pointHoverRadius: 5,
                pointHitRadius: 7,
                pointBorderWidth: 0,
                pointBackgroundColor: couleurs
            }]
        },
        options: {
            ...options,
            animation: false,
            layout: { padding: 28 },
            interaction: { mode: "nearest", intersect: true },
            scales: { x: { ...echelle }, y: { ...echelle } },
            plugins: {
                legend: { display: false },
                tooltip: {
                    ...options.plugins.tooltip,
                    displayColors: false,
                    callbacks: {
                        title: ([{ raw }]) => formatDateVentPolaire.format(raw.temps),
                        label: ({ raw }) => [
                            `Vent moyen : ${raw.vitesse.toFixed(1)} kt`,
                            `Provenance : ${raw.direction}° (${directionTexte(raw.direction)})`
                        ]
                    }
                }
            }
        },
        plugins: [{
            id: "grillePolaireVent",
            beforeDatasetsDraw({ ctx, scales: { x, y } }) {
                const centreX = x.getPixelForValue(0);
                const centreY = y.getPixelForValue(0);
                const rayon = x.getPixelForValue(rayonMax) - centreX;

                ctx.save();
                ctx.strokeStyle = "#d8e2ec";
                ctx.fillStyle = "#49627d";
                ctx.font = "12px Arial";
                ctx.textBaseline = "middle";
                ctx.textAlign = "center";

                for (let i = 0; i < 8; i++) {
                    const angle = i * Math.PI / 4;
                    const dx = Math.sin(angle);
                    const dy = -Math.cos(angle);
                    ctx.beginPath();
                    ctx.moveTo(centreX, centreY);
                    ctx.lineTo(centreX + rayon * dx, centreY + rayon * dy);
                    ctx.stroke();
                    ctx.fillText(directionTexte(i * 45),
                        centreX + (rayon + 14) * dx, centreY + (rayon + 14) * dy);
                }

                ctx.textAlign = "left";
                for (let vitesse = pas; vitesse <= rayonMax; vitesse += pas) {
                    const rayonGraduation = rayon * vitesse / rayonMax;
                    ctx.beginPath();
                    ctx.arc(centreX, centreY, rayonGraduation, 0, 2 * Math.PI);
                    ctx.stroke();
                    ctx.fillText(String(vitesse), centreX + 5, centreY - rayonGraduation + 8);
                }
                ctx.restore();
            }
        }]
    });
}

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

    const precipitations = donnees.map(d => intensitePrecipitations(d.rr_per));

    // Température en degrés Celsius
    const temperature = donnees.map(d =>
        Number.isFinite(d.t) ? celsius(d.t) : null
    );

    // Détruire les anciens graphiques
    if (graphiqueVent) graphiqueVent.destroy();
    if (graphiqueDirection) graphiqueDirection.destroy();
    if (graphiqueVentPolaire) graphiqueVentPolaire.destroy();
    if (graphiquePression) graphiquePression.destroy();
    if (graphiquePrecipitations) graphiquePrecipitations.destroy();
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

    graphiqueVentPolaire = creerGraphiquePolaireVent(donnees);

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

    // Graphique précipitations (intensité moyenne sur 6 minutes, en mm/h)
    const optionsPrecipitations = optionsGraphique("Précipitations (mm/h)", "mm/h");
    optionsPrecipitations.scales.y.suggestedMax = 1;
    graphiquePrecipitations = new Chart(
        document.getElementById("graphPrecipitations"),
        {
            type: "bar",
            data: {
                labels: labels,
                datasets: [{
                    label: "Intensité des précipitations",
                    data: precipitations,
                    backgroundColor: "#1685c8",
                    borderWidth: 0
                }]
            },
            options: optionsPrecipitations
        }
    );
    const statutPrecipitations = document.getElementById("statutPrecipitations");
    const nombreValides = precipitations.filter(Number.isFinite).length;
    statutPrecipitations.textContent = donnees.length === 0
        ? "En attente des relevés."
        : nombreValides === 0
            ? "Aucune mesure de précipitations disponible pour cette station."
            : nombreValides < donnees.length
                ? "Certaines mesures de précipitations sont indisponibles."
                : "";

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
const STATION_OBSERVATIONS_PAR_DEFAUT = "17300009";
const selecteurStation = document.getElementById("stationObservations");

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
            rr_per: d.rr_per == null || String(d.rr_per).trim() === "" ? null : Number(d.rr_per),
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
    derniereMesureVentStation = dernier;
    actualiserFlecheVentStation();

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
                <td>${intensitePrecipitations(d.rr_per)?.toFixed(1) ?? "--"}</td>
                <td>${Number.isFinite(d.t) ? (d.t - 273.15).toFixed(1) : "--"}</td>
            </tr>
        `).join("");

    document.getElementById("miseAJour").textContent =
        "Dernier relevé : " + new Date(dernier.date).toLocaleString("fr-FR");
}

const chargementsObservations = new Map();

async function chargerDonnees(forcerVerification = false) {
    const idStation = selecteurStation.value;
    const cleCache = idStation === STATION_OBSERVATIONS_PAR_DEFAUT
        ? CLE_CACHE_OBSERVATIONS : `${CLE_CACHE_OBSERVATIONS}_${idStation}`;

    // Afficher immédiatement les dernières observations sauvegardées localement.
    const cacheInitial = lireCacheLocal(cleCache);
    if (cacheInitial && Array.isArray(cacheInitial.donnees) && cacheInitial.donnees.length) {
        afficherDonnees(cacheInitial.donnees);
    }

    const chargementEnCours = chargementsObservations.get(idStation);
    // Si un chargement automatique est en cours, attendre sa fin
    // avant de lancer le contrôle manuel sans cache.
    if (chargementEnCours) {
        if (!forcerVerification) return false;
        await chargementEnCours;
        if (idStation !== selecteurStation.value) return false;
    }

    const promesse = chargerDonneesInterne(idStation, cleCache, forcerVerification);
    chargementsObservations.set(idStation, promesse);
    try {
        return await promesse;
    } finally {
        if (chargementsObservations.get(idStation) === promesse) {
            chargementsObservations.delete(idStation);
        }
    }
}

async function chargerDonneesInterne(idStation, cleCache, forcerVerification) {
    try {
        const urlObservations = new URL(URL_OBSERVATIONS_RENDER);
        urlObservations.searchParams.set("id_station", idStation);
        if (forcerVerification) urlObservations.searchParams.set("refresh", "1");
        const reponse = await fetch(urlObservations, {
            cache: "no-store"
        });
        if (!reponse.ok) {
            const detail = await reponse.json().catch(() => null);
            throw new Error(
                detail?.erreur || "Render observations : HTTP " + reponse.status
            );
        }

        const nouvellesDonnees = normaliserObservations(await reponse.json());
        if (nouvellesDonnees.length === 0) {
            throw new Error("Aucune donnée météo exploitable");
        }

        const cache = lireCacheLocal(cleCache);
        const anciennesDonnees = cache && Array.isArray(cache.donnees)
            ? cache.donnees
            : [];

        // Toujours prendre en compte le paquet fraîchement reçu.
        // Une mesure peut être corrigée par Météo-France sans changer validity_time.
        const donneesModifiees =
            JSON.stringify(nouvellesDonnees) !== JSON.stringify(anciennesDonnees);
        const dernierReleve = nouvellesDonnees[nouvellesDonnees.length - 1];
        const dateAncienReleve = anciennesDonnees.length
            ? new Date(anciennesDonnees[anciennesDonnees.length - 1].date).getTime()
            : -Infinity;
        const nouveauReleve =
            new Date(dernierReleve.date).getTime() > dateAncienReleve;

        ecrireCacheLocal(cleCache, {
            dateDernierReleve: dernierReleve.date,
            donnees: nouvellesDonnees
        });
        if (idStation === selecteurStation.value) afficherDonnees(nouvellesDonnees);

        if (anciennesDonnees.length === 0) {
            console.log(
                "Premiers relevés météo chargés depuis Render :",
                nouvellesDonnees.length,
                "· dernier relevé :",
                new Date(dernierReleve.date).toLocaleString("fr-FR")
            );
        } else if (donneesModifiees) {
            console.log(
                "Données météo actualisées depuis Render :",
                nouvellesDonnees.length,
                "relevés · dernier relevé :",
                new Date(dernierReleve.date).toLocaleString("fr-FR")
            );
        } else {
            console.log(
                "Données météo vérifiées auprès de Render : aucune modification détectée · dernier relevé :",
                new Date(dernierReleve.date).toLocaleString("fr-FR")
            );
        }
        return {
            nouveauReleve,
            donneesModifiees,
            dateDernierReleve: dernierReleve.date
        };
    } catch (erreur) {
        console.error("Vérification des relevés météo via Render impossible :", erreur);
        const cache = lireCacheLocal(cleCache);
        if (idStation === selecteurStation.value &&
            (!Array.isArray(cache?.donnees) || cache.donnees.length === 0)) {
            document.getElementById("miseAJour").textContent =
                "Relevés indisponibles · aucune donnée en cache";
        }
        return { echec: true, erreur: erreur.message };
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
async function actualiserDepuisInterface(action, bouton) {
    const statut = document.getElementById("workflowTriggerStatus");
    const idStation = selecteurStation.value;

    bouton.disabled = true;
    statut.dataset.action = action;
    statut.textContent = "Actualisation en cours…";

    try {
        if (action === "observations" || action === "radar") {
            const actualisationReussie = action === "observations"
                ? await chargerDonnees(true)
                : await chargerRadar(true);
            if (action === "observations" && idStation !== selecteurStation.value) return;
            if (!actualisationReussie || actualisationReussie.echec) {
                throw new Error(
                    actualisationReussie?.erreur ||
                    (action === "observations"
                        ? "La récupération des observations a échoué."
                        : "La récupération du radar a échoué. Consultez le statut du radar.")
                );
            }
            if (action === "observations") {
                const heureReleve = new Date(actualisationReussie.dateDernierReleve)
                    .toLocaleTimeString("fr-FR", {
                        timeZone: "Europe/Paris",
                        hour: "2-digit",
                        minute: "2-digit"
                    }).replace(":", "h");

                if (actualisationReussie.nouveauReleve) {
                    statut.textContent = "Nouvelles mesures reçues : " + heureReleve;
                } else if (actualisationReussie.donneesModifiees) {
                    statut.textContent = "Mesures corrigées : dernier relevé " + heureReleve;
                } else {
                    statut.textContent =
                        "Météo-France ne fournit pas de nouvelle mesure (dernier relevé : " +
                        heureReleve + ")";
                }
            } else {
                const heureRadar = new Date(actualisationReussie.dateDernierRadar)
                    .toLocaleTimeString("fr-FR", {
                        timeZone: "Europe/Paris",
                        hour: "2-digit",
                        minute: "2-digit"
                    }).replace(":", "h");

                statut.textContent = actualisationReussie.nouveauRadar
                    ? "Nouveau radar disponible : " + heureRadar
                    : "Météo-France ne fournit pas de nouveau radar (dernier radar : " +
                      heureRadar + ")";
            }
            return;
        }

        const point = positionCourante;
        const source = await chargerPrevisionsAuPoint(point, { relire: true });
        if (point !== positionCourante) {
            statut.textContent = "Le point de prévision a changé.";
            return;
        }

        if (!source) {
            statut.textContent = "Prévisions AROME indisponibles pour ce point.";
            return;
        }
        if (source === "local") {
            statut.textContent = "Prévisions calculées sur cet appareil. Vérification du modèle publié sur GitHub Pages.";
            return;
        }

        const etatPaquets = await fetch(URL_STATUT_PAQUETS, {
            cache: "no-store", signal: AbortSignal.timeout?.(10000)
        }).then(reponse => reponse.ok ? reponse.json() : null).catch(() => null);
        if (point !== positionCourante) {
            statut.textContent = "Le point de prévision a changé.";
            return;
        }
        const actualisationEnCours = etatPaquets?.en_cours
            ? "AROME GRIB2 : actualisation en cours (" +
                (etatPaquets.groupes_termines || 0) + "/" +
                (etatPaquets.groupes_total || 9) + " paquets)."
            : "";
        if (source === "WCS") {
            statut.textContent = "Prévisions WCS de secours affichées." +
                (actualisationEnCours ? " " + actualisationEnCours : "");
            return;
        }

        const intervalle = etatPaquets?.intervalle_controle_catalogue_minutes;
        const verificationCatalogue = etatPaquets?.actualisation_automatique &&
            Number.isFinite(intervalle) && intervalle > 0
            ? ` Vérification du catalogue toutes les ${intervalle} min.` : "";
        statut.textContent = actualisationEnCours ||
            "Prévisions actualisées depuis le cache GRIB2 Render." + verificationCatalogue;
    } catch (erreur) {
        console.error("Actualisation demandée impossible :", erreur);
        statut.textContent = erreur.message ||
            "Impossible de contacter Render. Le service peut être en veille.";
    } finally {
        bouton.disabled = false;
    }
}

document.querySelectorAll("[data-refresh]").forEach(bouton => {
    bouton.addEventListener("click", () => {
        actualiserDepuisInterface(bouton.dataset.refresh, bouton);
    });
});

selecteurStation.addEventListener("change", () => {
    document.querySelectorAll("[data-id-station]").forEach(element => {
        element.textContent = selecteurStation.value;
    });
    const statut = document.getElementById("workflowTriggerStatus");
    if (statut.dataset.action === "observations") statut.textContent = "";

    // Effacer les mesures de la station précédente pendant le chargement.
    document.getElementById("miseAJour").textContent = "Chargement des données...";
    document.getElementById("ventActuel").textContent = "--";
    document.getElementById("rafaleActuelle").textContent = "--";
    document.getElementById("directionActuelle").textContent = "--°";
    document.getElementById("directionCardinale").textContent = "--";
    document.getElementById("flecheDirection").style.transform = "";
    document.getElementById("pressionActuelle").textContent = "----";
    document.getElementById("tableau").innerHTML =
        '<tr><td colspan="7">Aucun relevé à afficher</td></tr>';
    derniereMesureVentStation = null;
    actualiserFlecheVentStation();
    creerGraphiques([]);
    chargerDonnees();
});

function demarrerApplication() {
    // Afficher la carte et les données en cache sans attendre le serveur.
    initialiserCarteRadar();
    chargerDonnees();

    // Les observations et le radar sont récupérés directement depuis Render.
}

demarrerApplication();

// Actualisation météo toutes les 6 minutes
setInterval(chargerDonnees, 6 * 60 * 1000);
