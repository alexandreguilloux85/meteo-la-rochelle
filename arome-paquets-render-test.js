"use strict";

// Essai isolé AROME SP1 / GRIB2 sur Render test.
// Aucun accès au cache WCS de production ni publication automatique.
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { gzipSync, gunzipSync } = require("node:zlib");
const crypto = require("node:crypto");

const ROOT = "https://public-api.meteofrance.fr/previnum/DPPaquetAROME/v1";
const SP1 = ROOT + "/models/AROME/grids/0.025/packages/SP1";
const ZONE = { latMin: 43.2, latMax: 48.3, lonMin: -5.0, lonMax: -0.3 };
const MAX_GRIB_OCTETS = 120 * 1024 * 1024;
const MAX_JSON_OCTETS = 45 * 1024 * 1024;
const MIN_INTERVALLE_TEST = 4 * 60 * 1000;
const INTERVALLE_AUTO = 3 * 60 * 60 * 1000;
const RETRY_AUTO = 20 * 60 * 1000;
const CONTROLE_AUTO = 2 * 60 * 1000;
const CACHE_PAGES_URL =
    "https://alexandreguilloux85.github.io/meteo-la-rochelle/arome-paquets-cache.json.gz";
const GITHUB_DISPATCH_URL =
    "https://api.github.com/repos/alexandreguilloux85/meteo-la-rochelle/dispatches";
const MAX_CACHE_GZIP_OCTETS = 16 * 1024 * 1024;
let OAUTH_CACHE = null;
// La nomenclature officielle regroupe H+0..H+51 en neuf paquets.
// H+0 est volontairement ignoré pour conserver les 51 colonnes du site.
const GROUPES = Object.freeze([
    { code: "00H06H", debut: 1, fin: 6 },
    { code: "07H12H", debut: 7, fin: 12 },
    { code: "13H18H", debut: 13, fin: 18 },
    { code: "19H24H", debut: 19, fin: 24 },
    { code: "25H30H", debut: 25, fin: 30 },
    { code: "31H36H", debut: 31, fin: 36 },
    { code: "37H42H", debut: 37, fin: 42 },
    { code: "43H48H", debut: 43, fin: 48 },
    { code: "49H51H", debut: 49, fin: 51 }
]);

function arrondiMo(octets) {
    return Math.round(octets / 1048576 * 100) / 100;
}

function verifierURLAPI(url) {
    const verifiee = new URL(url);
    if (verifiee.origin !== "https://public-api.meteofrance.fr") {
        throw new Error("URL de catalogue AROME non autorisée");
    }
    return verifiee;
}

async function authentificationPaquets() {
    // Priorité à la clé API longue durée si elle est configurée.
    // Le portail API Météo-France attend le champ HTTP 'apikey',
    // et non 'Authorization: Bearer', dans ce mode.
    const cleApi = process.env.METEO_AROME_PAQUETS_API_KEY?.trim();
    if (cleApi) {
        if (/\s/.test(cleApi) || /^(?:Bearer\s+|Basic\s+|Authorization:)/i.test(cleApi)) {
            throw new Error(
                "METEO_AROME_PAQUETS_API_KEY invalide : copier uniquement la clé API, " +
                "sans préfixe Bearer/Basic ni espaces"
            );
        }
        return { mode: "apikey", headers: { apikey: cleApi } };
    }

    const identifiant = process.env.METEO_AROME_PAQUETS_APPLICATION_ID?.trim();
    if (identifiant) {
        // Réutiliser un Bearer tant qu'il reste au moins deux minutes de validité.
        if (OAUTH_CACHE && OAUTH_CACHE.expireLe - Date.now() > 120000) {
            return {
                mode: "oauth2",
                headers: { Authorization: "Bearer " + OAUTH_CACHE.jeton }
            };
        }
        const reponse = await fetch("https://portail-api.meteofrance.fr/token", {
            method: "POST",
            redirect: "error",
            headers: {
                Authorization: "Basic " + identifiant.replace(/^Basic\s+/i, ""),
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/json"
            },
            body: "grant_type=client_credentials",
            signal: AbortSignal.timeout(30000)
        });
        if (!reponse.ok) {
            throw new Error("Échec du renouvellement OAuth2 AROME : HTTP " + reponse.status);
        }
        const donnees = await reponse.json();
        if (!donnees.access_token) throw new Error("Réponse OAuth2 sans access_token");
        const duree = Number(donnees.expires_in);
        OAUTH_CACHE = {
            jeton: donnees.access_token,
            expireLe: Date.now() +
                (Number.isFinite(duree) && duree > 0 ? duree : 3600) * 1000
        };
        return {
            mode: "oauth2",
            headers: { Authorization: "Bearer " + OAUTH_CACHE.jeton }
        };
    }

    const secret = process.env.METEO_AROME_PAQUETS_TOKEN?.trim();
    if (!secret) {
        throw new Error(
            "Configurer METEO_AROME_PAQUETS_API_KEY (recommandé), " +
            "METEO_AROME_PAQUETS_APPLICATION_ID ou METEO_AROME_PAQUETS_TOKEN sur Render test"
        );
    }
    const jeton = secret.replace(/^Authorization:\s*/i, "")
        .replace(/^Bearer\s+/i, "").replace(/^['"]|['"]$/g, "").trim();
    if (!jeton || /\s/.test(jeton)) {
        throw new Error("METEO_AROME_PAQUETS_TOKEN mal copié");
    }
    return {
        mode: "bearer",
        headers: { Authorization: "Bearer " + jeton }
    };
}

async function requeteMeteo(url, authentification, timeout = 30000) {
    const urlVerifiee = verifierURLAPI(url);
    const reponse = await fetch(urlVerifiee, {
        redirect: "error",
        headers: {
            ...authentification.headers,
            Accept: "*/*"
        },
        cache: "no-store",
        signal: AbortSignal.timeout(timeout)
    });
    if (!reponse.ok) {
        const code = reponse.status;
        if (code === 401) {
            throw new Error(authentification.mode === "apikey"
                ? "Clé API Paquet AROME refusée (401) : vérifier la clé et son abonnement"
                : "Jeton Paquet AROME refusé (401) : expiré ou invalide");
        }
        if (code === 403) {
            throw new Error("Accès Paquet AROME interdit (403) : vérifier l'abonnement");
        }
        throw new Error("API Paquet AROME HTTP " + code);
    }
    return reponse;
}

async function catalogue(url, jeton) {
    const reponse = await requeteMeteo(url, jeton);
    const texte = await reponse.text();
    if (texte.length > 5 * 1024 * 1024) throw new Error("Catalogue trop volumineux");
    const donnees = JSON.parse(texte);
    if (!Array.isArray(donnees.links)) throw new Error("Catalogue Paquet AROME invalide");
    return donnees;
}

async function selectionnerReseauComplet(jeton, groupes, etape) {
    etape("catalogue");
    const description = await catalogue(SP1, jeton);
    const reseaux = [...new Set(description.links.map(lien => {
        const href = lien.href || "";
        const reference = new URL(href, SP1).searchParams.get("referencetime");
        return reference && !Number.isNaN(Date.parse(reference))
            ? reference : null;
    }).filter(Boolean))].sort().reverse();

    if (!reseaux.length) throw new Error("Aucun réseau disponible dans le paquet SP1");
    etape("recherche_echeances");

    const diagnostics = [];
    for (const reference of reseaux.slice(0, 8)) {
        const url = SP1 + "?" + new URLSearchParams({ referencetime: reference });
        const disponibilites = await catalogue(url, jeton);
        const heuresDisponibles = new Set(
            disponibilites.links.filter(lien => {
                const href = lien.href || "";
                const params = new URL(href, SP1).searchParams;
                const format = params.get("format") || "";
                return format.toLowerCase() === "grib2" ||
                    /grib2/i.test(lien.title || "");
            }).map(lien => lien.time ||
                new URL(lien.href || "", SP1).searchParams.get("time"))
              .filter(Boolean)
        );
        const manquants = groupes.filter(g => !heuresDisponibles.has(g.code));
        if (!manquants.length) {
            return {
                modele: reference,
                groupes: groupes.map(g => ({
                    ...g,
                    url: SP1 + "/productARO?" + new URLSearchParams({
                        referencetime: reference,
                        time: g.code,
                        format: "grib2"
                    })
                }))
            };
        }
        diagnostics.push(reference + " : manque " + manquants.map(g => g.code).join(","));
    }
    throw new Error(
        "Aucun réseau AROME avec les " + groupes.length +
        " groupes demandés. " + diagnostics.slice(0, 3).join(" | ")
    );
}

async function telechargerGrib(url, jeton, fichier) {
    const reponse = await requeteMeteo(url, jeton, 150000);
    if (!reponse.body) throw new Error("Réponse GRIB2 sans contenu");
    let octets = 0;
    const sortie = await fs.open(fichier, "w");
    try {
        for await (const bloc of reponse.body) {
            octets += bloc.length;
            if (octets > MAX_GRIB_OCTETS) {
                throw new Error("Paquet GRIB2 supérieur à 120 Mo : test arrêté");
            }
            let position = 0;
            while (position < bloc.length) {
                const { bytesWritten } = await sortie.write(
                    bloc, position, bloc.length - position
                );
                if (bytesWritten <= 0) {
                    throw new Error("Écriture GRIB2 interrompue");
                }
                position += bytesWritten;
            }
        }
    } finally {
        await sortie.close();
    }
    if (octets < 20) throw new Error("Paquet GRIB2 vide");
    const handle = await fs.open(fichier, "r");
    try {
        const debut = Buffer.alloc(4);
        const fin = Buffer.alloc(4);
        await handle.read(debut, 0, 4, 0);
        await handle.read(fin, 0, 4, octets - 4);
        if (debut.toString("ascii") !== "GRIB" ||
            fin.toString("ascii") !== "7777") {
            throw new Error("Téléchargement incomplet ou fichier non GRIB2");
        }
    } finally {
        await handle.close();
    }
    return octets;
}

function verifierDependancesPython() {
    // Vérifier avant tout téléchargement que le Python du runtime retrouve
    // les mêmes modules que ceux installés par le script de build Render test.
    return new Promise((resolve, reject) => {
        const pythonPath = path.join(__dirname, ".arome-py");
        const execution = spawn(
            process.env.AROME_PAQUETS_PYTHON || "python3",
            ["-c", "import numpy; import eccodes"],
            {
                cwd: __dirname,
                env: {
                    ...process.env,
                    PYTHONPATH: pythonPath +
                        (process.env.PYTHONPATH
                            ? path.delimiter + process.env.PYTHONPATH : "")
                },
                stdio: ["ignore", "ignore", "pipe"]
            }
        );
        let erreur = "";
        execution.stderr.on("data", bloc => {
            erreur = (erreur + bloc.toString()).slice(-1200);
        });
        let termine = false;
        const limite = setTimeout(() => {
            execution.kill("SIGKILL");
        }, 20000);
        function finir(echec, resultat) {
            if (termine) return;
            termine = true;
            clearTimeout(limite);
            if (echec) reject(resultat);
            else resolve();
        }
        execution.on("error", e => finir(true, new Error(
            "Impossible de lancer Python sur Render test : " + e.message
        )));
        execution.on("close", code => {
            if (code === 0) return finir(false);
            finir(true, new Error(
                "Dépendances Python AROME indisponibles sur Render test. " +
                "Vérifier Build Command = bash scripts/build-render-test.sh " +
                "puis redéployer (Clear build cache si nécessaire). " +
                (erreur || "Import NumPy/ecCodes impossible").slice(-500)
            ));
        });
    });
}

function decoderAvecPython(fichier, dossier, modele, groupe) {
    return new Promise((resolve, reject) => {
        const interpreter = process.env.AROME_PAQUETS_PYTHON || "python3";
        const pythonPath = path.join(__dirname, ".arome-py");
        const execution = spawn(
            interpreter,
            [path.join(__dirname, ".github/scripts/arome_paquets_test.py")],
            {
                cwd: __dirname,
                env: {
                    ...process.env,
                    AROME_GRIB_LOCAL: fichier,
                    AROME_MODELE_LOCAL: modele,
                    AROME_OUTPUT: dossier,
                    AROME_HEURE_DEBUT: String(groupe.debut),
                    AROME_HEURE_FIN: String(groupe.fin),
                    AROME_BBOX: [
                        ZONE.latMin, ZONE.latMax, ZONE.lonMin, ZONE.lonMax
                    ].join(","),
                    PYTHONPATH: pythonPath +
                        (process.env.PYTHONPATH
                            ? path.delimiter + process.env.PYTHONPATH : "")
                },
                stdio: ["ignore", "pipe", "pipe"]
            }
        );

        let sortie = "";
        let erreur = "";
        const tronquer = (ancien, bloc) => (ancien + bloc).slice(-10000);
        execution.stdout.on("data", morceau => {
            sortie = tronquer(sortie, morceau.toString());
        });
        execution.stderr.on("data", morceau => {
            erreur = tronquer(erreur, morceau.toString());
        });

        const limite = setTimeout(() => {
            execution.kill("SIGKILL");
        }, 180000);
        let termine = false;
        function finir(echec, resultat) {
            if (termine) return;
            termine = true;
            clearTimeout(limite);
            if (echec) reject(resultat);
            else resolve(resultat);
        }
        execution.on("error", e => finir(true, new Error(
            "Python indisponible sur Render : " + e.message
        )));
        execution.on("close", code => {
            if (code !== 0) {
                finir(true, new Error(
                    "Décodage ecCodes impossible (code " + code + "). " +
                    (erreur || sortie).slice(-1200) +
                    " · vérifier l'installation Python/ecCodes"
                ));
            } else {
                console.log("AROME Paquets Render test :", sortie.slice(-1800));
                finir(false, sortie);
            }
        });
    });
}

function validerCacheAromePaquets(cache, calculerPrevisionsArome) {
    if (!cache || !Array.isArray(cache.previsions) ||
        cache.previsions.length !== 51 || typeof cache.modele !== "string") {
        throw new Error("Sauvegarde AROME Paquets incomplète (51 échéances requises)");
    }
    const z = cache.zone || {};
    if (z.latMin !== ZONE.latMin || z.latMax !== ZONE.latMax ||
        z.lonMin !== ZONE.lonMin || z.lonMax !== ZONE.lonMax) {
        throw new Error("Sauvegarde AROME Paquets : zone incompatible");
    }
    const heures = new Set();
    for (const prevision of cache.previsions) {
        const heure = prevision?.seconde / 3600;
        if (!Number.isInteger(heure) || heure < 1 || heure > 51 ||
            heures.has(heure)) {
            throw new Error("Sauvegarde AROME Paquets : échéance invalide ou doublon");
        }
        heures.add(heure);
        for (const parametre of ["U", "V", "RAFALE"]) {
            const champ = prevision[parametre];
            const grille = champ?.grille;
            if (!Number.isInteger(grille?.Ni) || !Number.isInteger(grille?.Nj) ||
                !Array.isArray(champ.valeurs) ||
                champ.valeurs.length !== grille.Ni * grille.Nj) {
                throw new Error("Sauvegarde AROME Paquets : " + parametre +
                    " incomplet à H+" + heure);
            }
        }
    }
    if (calculerPrevisionsArome(cache, 46.178, -1.193167).previsions.length !== 51) {
        throw new Error("Sauvegarde AROME Paquets : interpolation incomplète");
    }
}

function installerTestAromePaquets(app, {
    verifierJetonActualisation, calculerPrevisionsArome, chargerCacheArome
}) {
    // Jamais sur le service de production : ni téléchargement, ni publication.
    if (process.env.RENDER_EXTERNAL_HOSTNAME !== "station-meteo-lr-test.onrender.com" &&
        process.env.AROME_PAQUETS_TEST_ENABLED !== "1") {
        return;
    }

    let cacheTest = null;
    let cacheCompresse = null;
    let enCours = false;
    let dernierDemarrage = 0;
    let derniereReussite = 0;
    let prochainEssai = 0;
    let restaurationTerminee = false;
    let restaurationPages = "non_demarre";
    let erreurRestauration = null;
    let publicationGitHub = "non_demarre";
    let erreurPublication = null;
    const actualisationAutoActive =
        process.env.AROME_PAQUETS_AUTO_REFRESH !== "0";
    let etat = {
        statut: "non_demarre",
        etape: null,
        modele: null,
        erreur: null
    };

    app.get("/api/arome/paquets/test/status", (_req, res) => {
        res.set("Cache-Control", "no-store");
        res.json({
            ...etat,
            en_cours: enCours,
            cache_disponible: Boolean(cacheTest),
            modele_cache_disponible: cacheTest?.modele || null,
            restauration_pages: restaurationPages,
            erreur_restauration_pages: erreurRestauration,
            publication_github: publicationGitHub,
            erreur_publication_github: erreurPublication,
            actualisation_automatique: actualisationAutoActive,
            intervalle_actualisation_heures: 3,
            derniere_actualisation_reussie: derniereReussite
                ? new Date(derniereReussite).toISOString() : null,
            prochaine_tentative: prochainEssai
                ? new Date(prochainEssai).toISOString() : null
        });
    });

    app.get("/api/arome/paquets/test/previsions", (req, res) => {
        res.set("Cache-Control", "no-store");
        if (!cacheTest) {
            verifierActualisationAutomatique();
            return res.status(503).json({
                succes: false,
                erreur: "Aucun cache de paquets AROME validé sur Render test",
                actualisation_en_cours: enCours
            });
        }
        const lat = Number(req.query.lat ?? 46.178);
        const lon = Number(req.query.lon ?? -1.193167);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
            lat < ZONE.latMin || lat > ZONE.latMax ||
            lon < ZONE.lonMin || lon > ZONE.lonMax) {
            return res.status(400).json({
                succes: false, erreur: "Point hors de la zone du cache Paquets AROME"
            });
        }
        try {
            const resultat = calculerPrevisionsArome(cacheTest, lat, lon);
            return res.json({
                ...resultat,
                cache: true,
                origine_cache: "Paquets AROME Render test",
                actualisation_en_cours: enCours,
                actualisation_statut: etat.statut,
                modele_cache: cacheTest.modele
            });
        } catch (e) {
            return res.status(422).json({ succes: false, erreur: e.message });
        }
    });

    // Cache complet téléchargeable par le navigateur, compressé à la source.
    // Cache-Control court pour limiter les réponses lourdes répétées.
    app.get("/api/arome/paquets/test/cache", (_req, res) => {
        if (!cacheCompresse) {
            return res.status(503).json({
                succes: false,
                erreur: "Cache des paquets AROME indisponible"
            });
        }
        res.set({
            "Content-Type": "application/json; charset=utf-8",
            "Content-Encoding": "gzip",
            "Cache-Control": "public, max-age=60",
            "Vary": "Accept-Encoding"
        });
        return res.send(cacheCompresse);
    });

    // Comparaison indépendante et sans déclenchement du WCS.
    // Comparer les mêmes dates valides, même si les réseaux sont différents.
    app.get("/api/arome/paquets/test/comparaison", async (req, res) => {
        res.set("Cache-Control", "no-store");
        if (!cacheTest) return res.status(503).json({
            succes: false, erreur: "Cache Paquets AROME absent"
        });
        const lat = Number(req.query.lat ?? 46.178);
        const lon = Number(req.query.lon ?? -1.193167);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
            lat < ZONE.latMin || lat > ZONE.latMax ||
            lon < ZONE.lonMin || lon > ZONE.lonMax) {
            return res.status(400).json({
                succes: false, erreur: "Coordonnées hors zone Paquets AROME"
            });
        }
        try {
            const cacheWcs = await chargerCacheArome();
            if (!cacheWcs?.previsions?.length) {
                return res.status(503).json({
                    succes: false, erreur: "Cache WCS indisponible"
                });
            }
            const paquets = calculerPrevisionsArome(cacheTest, lat, lon);
            const wcs = calculerPrevisionsArome(cacheWcs, lat, lon);
            const donneesWcs = new Map(wcs.previsions.map(p => [p.date, p]));
            const comparaisons = paquets.previsions
                .filter(p => donneesWcs.has(p.date))
                .map(p => {
                    const ref = donneesWcs.get(p.date);
                    return {
                        date: p.date,
                        echeance_paquets: p.echeance,
                        vitesse_paquets_ms: p.vitesse,
                        vitesse_wcs_ms: ref.vitesse,
                        ecart_vitesse_ms: Number((p.vitesse - ref.vitesse).toFixed(2)),
                        rafale_paquets_ms: p.rafale,
                        rafale_wcs_ms: ref.rafale,
                        ecart_rafale_ms: p.rafale == null || ref.rafale == null
                            ? null
                            : Number((p.rafale - ref.rafale).toFixed(2)),
                        ecart_direction_deg: Number(
                            (Math.abs(((p.direction - ref.direction + 540) % 360) - 180))
                                .toFixed(1)
                        )
                    };
                });
            const ecarts = comparaisons.map(p => Math.abs(p.ecart_vitesse_ms));
            const moyenne = ecarts.length
                ? ecarts.reduce((a, b) => a + b, 0) / ecarts.length : null;
            return res.json({
                succes: true,
                latitude: lat, longitude: lon,
                modele_paquets: cacheTest.modele,
                modele_wcs: cacheWcs.modele,
                nombre_dates_communes: comparaisons.length,
                avertissement: comparaisons.length
                    ? null : "Aucune date de prévision commune entre ces caches",
                ecart_moyen_absolu_vitesse_ms: moyenne == null ? null
                    : Number(moyenne.toFixed(2)),
                ecart_max_absolu_vitesse_ms: ecarts.length
                    ? Math.max(...ecarts) : null,
                comparaisons
            });
        } catch (e) {
            return res.status(422).json({ succes: false, erreur: e.message });
        }
    });

    async function restaurerCachePages() {
        restaurationPages = "en_cours";
        try {
            const url = new URL(CACHE_PAGES_URL);
            url.searchParams.set("t", String(Date.now()));
            const reponse = await fetch(url, {
                redirect: "error",
                cache: "no-store",
                headers: { Accept: "application/octet-stream" },
                signal: AbortSignal.timeout(45000)
            });
            if (!reponse.ok) {
                throw new Error("GitHub Pages HTTP " + reponse.status);
            }
            const longueur = Number(reponse.headers.get("content-length"));
            if (longueur > MAX_JSON_OCTETS) {
                throw new Error("Sauvegarde Pages trop volumineuse");
            }
            const telecharge = Buffer.from(await reponse.arrayBuffer());
            if (telecharge.length < 1000 ||
                telecharge.length > MAX_JSON_OCTETS) {
                throw new Error("Sauvegarde Pages absente ou trop volumineuse");
            }

            // Certains serveurs décompressent automatiquement HTTP gzip.
            // Accepter le vrai .gz ET le JSON déjà décompressé par fetch().
            let compresse;
            let texte;
            if (telecharge[0] === 0x1f && telecharge[1] === 0x8b) {
                if (telecharge.length > MAX_CACHE_GZIP_OCTETS) {
                    throw new Error("Cache gzip Pages trop volumineux");
                }
                compresse = telecharge;
                texte = gunzipSync(compresse, {
                    maxOutputLength: MAX_JSON_OCTETS
                }).toString("utf8");
            } else {
                if (!telecharge.toString("utf8", 0, 32).trimStart().startsWith("{")) {
                    throw new Error("Sauvegarde Pages : format non reconnu");
                }
                texte = telecharge.toString("utf8");
                compresse = gzipSync(telecharge, { level: 6 });
            }
            const restaure = JSON.parse(texte);
            validerCacheAromePaquets(restaure, calculerPrevisionsArome);

            // Aucun cache actif n'est écrasé par une restauration plus ancienne.
            if (!cacheTest) {
                cacheTest = restaure;
                cacheCompresse = compresse;
                const dateCache = Number(restaure.date);
                derniereReussite = Number.isFinite(dateCache) &&
                    dateCache > 0 && dateCache <= Date.now()
                    ? dateCache : 0;
                prochainEssai = derniereReussite
                    ? derniereReussite + INTERVALLE_AUTO : 0;
                etat = {
                    statut: "restaure",
                    etape: "restauration_pages",
                    modele: restaure.modele,
                    erreur: null,
                    origine_actualisation: "GitHub Pages",
                    groupes_total: 9,
                    groupes_termines: 9,
                    echeances_uv: 51,
                    echeances_rafale: 51,
                    taille_cache_gzip_mo: arrondiMo(compresse.length),
                    dernier_test: new Date().toISOString()
                };
            }
            restaurationPages = "reussie";
            erreurRestauration = null;
            console.log(
                "AROME Paquets : sauvegarde GitHub Pages restaurée",
                restaure.modele, arrondiMo(compresse.length), "Mo"
            );
        } catch (e) {
            restaurationPages = "indisponible";
            erreurRestauration = e.message;
            console.warn("AROME Paquets : pas de restauration Pages :", e.message);
        } finally {
            restaurationTerminee = true;
            verifierActualisationAutomatique();
        }
    }

    async function signalerSauvegardeGitHub(cache, compresse) {
        const jeton = (process.env.GITHUB_PAQUETS_PUBLISH_TOKEN ||
            process.env.GITHUB_DATA_TOKEN || "").trim();
        if (!jeton) {
            publicationGitHub = "non_configuree";
            erreurPublication = "Configurer GITHUB_PAQUETS_PUBLISH_TOKEN sur Render test";
            return;
        }
        publicationGitHub = "envoi";
        erreurPublication = null;
        try {
            const sha256 = crypto.createHash("sha256")
                .update(compresse).digest("hex");
            const reponse = await fetch(GITHUB_DISPATCH_URL, {
                method: "POST",
                redirect: "error",
                headers: {
                    Authorization: "Bearer " + jeton,
                    Accept: "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                    "Content-Type": "application/json",
                    "User-Agent": "meteo-la-rochelle-arome-paquets"
                },
                body: JSON.stringify({
                    event_type: "arome-paquets-cache-ready",
                    client_payload: { modele: cache.modele, sha256 }
                }),
                signal: AbortSignal.timeout(30000)
            });
            if (!reponse.ok) {
                throw new Error("GitHub dispatch HTTP " + reponse.status);
            }
            // Le dispatch accepté ne signifie pas que Pages a déjà été déployé.
            publicationGitHub = "demande_envoyee";
            console.log("AROME Paquets : sauvegarde demandée à GitHub Actions");
        } catch (e) {
            publicationGitHub = "echec";
            erreurPublication = e.message;
            console.warn("AROME Paquets : sauvegarde GitHub non envoyée :", e.message);
        }
    }

    async function executer(groupesDemandes) {
        let dossier;
        try {
            etat = { ...etat, etape: "verification_python" };
            await verifierDependancesPython();
            etat = { ...etat, etape: "authentification" };
            const authentification = await authentificationPaquets();
            console.log("AROME Paquets Render test : mode auth", authentification.mode);
            etat = { ...etat, authentification: authentification.mode };
            const produit = await selectionnerReseauComplet(
                authentification, groupesDemandes,
                etape => { etat = { ...etat, etape }; }
            );

            dossier = await fs.mkdtemp(path.join(os.tmpdir(), "arome-paquets-"));
            const parHeure = new Map();
            let grilleCommune = null;
            let nombreOctetsGrib = 0;
            const debut = Date.now();

            for (const [index, groupe] of produit.groupes.entries()) {
                const dossierGroupe = path.join(dossier, "groupe-" + groupe.debut);
                await fs.mkdir(dossierGroupe);
                const fichier = path.join(dossierGroupe, "sp1.grib2");
                etat = {
                    ...etat,
                    etape: "telechargement",
                    modele: produit.modele,
                    groupe_actuel: groupe.code,
                    groupes_termines: index
                };
                // Avec un secret Basic, renouveler le Bearer au début de chaque
                // groupe (utile si le traitement total approche 1 heure).
                const authentificationCourante = authentification.mode === "oauth2"
                    ? await authentificationPaquets() : authentification;
                const tailleGrib = await telechargerGrib(
                    groupe.url, authentificationCourante, fichier
                );
                nombreOctetsGrib += tailleGrib;

                etat = { ...etat, etape: "decodage_grib2" };
                await decoderAvecPython(fichier, dossierGroupe, produit.modele, groupe);
                await fs.unlink(fichier);
                const cheminJson = path.join(dossierGroupe, "arome-cache-paquets-test.json");
                const tailleJson = (await fs.stat(cheminJson)).size;
                if (tailleJson > MAX_JSON_OCTETS) {
                    throw new Error("Groupe " + groupe.code + " : JSON trop volumineux");
                }
                const resultat = JSON.parse(await fs.readFile(cheminJson, "utf8"));
                if (resultat.modele !== produit.modele) {
                    throw new Error("Mélange de réseaux détecté : " + groupe.code);
                }
                const attendues = groupe.fin - groupe.debut + 1;
                if (!Array.isArray(resultat.previsions) ||
                    resultat.previsions.length !== attendues) {
                    throw new Error(
                        groupe.code + " incomplet : " +
                        (resultat.previsions?.length ?? 0) + "/" + attendues
                    );
                }
                for (const prevision of resultat.previsions) {
                    const heure = prevision.seconde / 3600;
                    if (!Number.isInteger(heure) ||
                        heure < groupe.debut || heure > groupe.fin ||
                        !prevision.U || !prevision.V || !prevision.RAFALE) {
                        throw new Error(
                            groupe.code + " : U/V/FF_RAF absents H+" + heure
                        );
                    }
                    const grille = JSON.stringify(prevision.U.grille);
                    if (grille !== JSON.stringify(prevision.V.grille) ||
                        grille !== JSON.stringify(prevision.RAFALE.grille) ||
                        (grilleCommune && grille !== grilleCommune)) {
                        throw new Error(
                            "Grilles U/V/FF_RAF différentes H+" + heure
                        );
                    }
                    grilleCommune = grille;
                    if (parHeure.has(heure)) {
                        throw new Error("Doublon échéance H+" + heure);
                    }
                    parHeure.set(heure, prevision);
                }
                await fs.rm(dossierGroupe, { recursive: true, force: true });
                etat = {
                    ...etat,
                    etape: "groupe_valide",
                    groupes_termines: index + 1,
                    echeances_recuperees: parHeure.size,
                    taille_grib_mo: arrondiMo(nombreOctetsGrib)
                };
                console.log(
                    "AROME Paquets Render test :", groupe.code,
                    "validé,", parHeure.size, "échéances"
                );
            }

            const heureMax = groupesDemandes.at(-1).fin;
            const previsions = [];
            for (let h = 1; h <= heureMax; h++) {
                if (!parHeure.has(h)) {
                    throw new Error("Échéance H+" + h + " manquante après fusion");
                }
                previsions.push(parHeure.get(h));
            }
            const cache = {
                modele: produit.modele,
                date: Date.now(),
                source: "AROME 0.025 SP1 GRIB2 ecCodes - Render test",
                zone: { ...ZONE, centreLat: (ZONE.latMin + ZONE.latMax) / 2,
                    centreLon: (ZONE.lonMin + ZONE.lonMax) / 2 },
                previsions,
                erreurs: []
            };
            const point = calculerPrevisionsArome(cache, 46.178, -1.193167);
            if (point.previsions.length !== heureMax) {
                throw new Error("Interpolation incomplète à La Rochelle");
            }
            etat = { ...etat, etape: "compression_cache" };
            const texte = JSON.stringify(cache);
            const tailleJson = Buffer.byteLength(texte);
            if (tailleJson > MAX_JSON_OCTETS) {
                throw new Error(
                    "Cache JSON " + arrondiMo(tailleJson) +
                    " Mo supérieur à 45 Mo : publication test refusée"
                );
            }
            const gzip = gzipSync(Buffer.from(texte), { level: 6 });
            // Publication atomique des deux objets uniquement après validation.
            cacheTest = cache;
            cacheCompresse = gzip;
            derniereReussite = Date.now();
            prochainEssai = derniereReussite + INTERVALLE_AUTO;
            etat = {
                statut: "termine",
                etape: "termine",
                modele: produit.modele,
                erreur: null,
                authentification: authentification.mode,
                zone: cache.zone,
                grille: cache.previsions[0].U.grille,
                groupes_total: groupesDemandes.length,
                groupes_termines: groupesDemandes.length,
                groupe_actuel: null,
                echeances_uv: cache.previsions.length,
                echeances_rafale: cache.previsions.filter(p => p.RAFALE).length,
                taille_grib_mo: arrondiMo(nombreOctetsGrib),
                taille_cache_mo: arrondiMo(tailleJson),
                taille_cache_gzip_mo: arrondiMo(gzip.length),
                reduction_gzip_pourcent: Math.round(
                    100 * (1 - gzip.length / tailleJson)
                ),
                duree_secondes: Math.round((Date.now() - debut) / 1000),
                dernier_test: new Date().toISOString()
            };
            // Ne jamais ralentir les prévisions au point pendant la sauvegarde.
            // Seul un cache complet H+51 est publiable vers GitHub Pages.
            if (heureMax === 51) {
                void signalerSauvegardeGitHub(cache, gzip);
            }
        } catch (e) {
            console.error("AROME Paquets Render test :", e.message);
            prochainEssai = Date.now() + RETRY_AUTO;
            etat = {
                ...etat,
                statut: "echec",
                erreur: e.message,
                dernier_test: new Date().toISOString()
            };
        } finally {
            if (dossier) {
                await fs.rm(dossier, { recursive: true, force: true })
                    .catch(e => console.warn("Nettoyage test AROME :", e.message));
            }
            enCours = false;
        }
    }

    function lancerActualisationPaquets(groupesDemandes, origine) {
        if (enCours) return false;
        enCours = true;
        dernierDemarrage = Date.now();
        etat = {
            statut: "en_cours",
            etape: "verification_python",
            modele: null,
            erreur: null,
            origine_actualisation: origine,
            groupes_total: groupesDemandes.length,
            groupes_termines: 0,
            groupe_actuel: null,
            echeances_recuperees: 0
        };
        void executer(groupesDemandes);
        return true;
    }

    function verifierActualisationAutomatique() {
        if (!restaurationTerminee ||
            !actualisationAutoActive || enCours ||
            Date.now() < prochainEssai ||
            Date.now() - dernierDemarrage < MIN_INTERVALLE_TEST) {
            return false;
        }
        // Une actualisation toutes les 3 h tant que Render est éveillé.
        // Si l'instance s'endort, le prochain démarrage relance le contrôle.
        if (!cacheTest || !derniereReussite ||
            Date.now() - derniereReussite >= INTERVALLE_AUTO) {
            return lancerActualisationPaquets(GROUPES, "automatique");
        }
        return false;
    }

    app.post("/api/arome/paquets/test/refresh", (req, res) => {
        if (!verifierJetonActualisation(req, res)) return;
        res.set("Cache-Control", "no-store");
        const nombreGroupes = Number(req.query.groupes ?? 9);
        if (![1, 3, 9].includes(nombreGroupes)) {
            return res.status(400).json({
                succes: false, erreur: "groupes doit valoir 1, 3 ou 9"
            });
        }
        if (!restaurationTerminee) {
            return res.status(409).json({
                succes: false, erreur: "Restauration du cache Pages en cours"
            });
        }
        if (enCours) {
            return res.status(409).json({
                succes: false, erreur: "Test AROME déjà en cours", ...etat
            });
        }
        if (Date.now() - dernierDemarrage < MIN_INTERVALLE_TEST) {
            return res.status(429).json({
                succes: false,
                erreur: "Attendre quatre minutes entre deux tests Paquets AROME"
            });
        }
        lancerActualisationPaquets(GROUPES.slice(0, nombreGroupes), "manuelle");
        return res.status(202).json({ succes: true, ...etat });
    });

    // Au démarrage, restaurer le cache existant AVANT de lancer l'éventuel
    // téléchargement des neuf paquets, sans bloquer la mise en route HTTP.
    setImmediate(() => { void restaurerCachePages(); });

    if (actualisationAutoActive) {
        // Les timers sont suspendus quand Render gratuit est en veille.
        // La restauration et le contrôle reprennent au prochain réveil.
        const horloge = setInterval(
            verifierActualisationAutomatique, CONTROLE_AUTO
        );
        horloge.unref?.();
    }

}

module.exports = { installerTestAromePaquets };
