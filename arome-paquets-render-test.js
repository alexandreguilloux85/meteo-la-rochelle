"use strict";

// Cache AROME SP1 / GRIB2 sur les services Render.
// La sauvegarde GRIB2 est indépendante de la publication du cache WCS.
const fs = require("node:fs/promises");
const fsSystem = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { preparerCacheDisque } = require("./arome-paquets-disque");
const { essayerDemarrer, traitementEnCours } = require("./traitement-lourd");
const { compresserCacheArome } = require("./arome-cache-stream");
const { lireSauvegardeArome, jetonSauvegardeArome, signalerSauvegardeArome } =
    require("./arome-cache-pages");

const ROOT = "https://public-api.meteofrance.fr/previnum/DPPaquetAROME/v1";
const SP1 = ROOT + "/models/AROME/grids/0.025/packages/SP1";
const ZONE = { latMin: 43.2, latMax: 48.3, lonMin: -5.0, lonMax: -0.3 };
const MAX_GRIB_OCTETS = 120 * 1024 * 1024;
const MAX_JSON_OCTETS = 45 * 1024 * 1024;
const MIN_INTERVALLE_TEST = 4 * 60 * 1000;
const INTERVALLE_CONTROLE_CATALOGUE = 30 * 60 * 1000;
const RETRY_AUTO = 20 * 60 * 1000;
const CONTROLE_AUTO = 2 * 60 * 1000;
const TTL_DIAGNOSTIC_CATALOGUE = 5 * 60 * 1000;
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
            "METEO_AROME_PAQUETS_APPLICATION_ID ou METEO_AROME_PAQUETS_TOKEN sur Render"
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
    // les mêmes modules que ceux installés par le script de build Render.
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
            "Impossible de lancer Python sur Render : " + e.message
        )));
        execution.on("close", code => {
            if (code === 0) return finir(false);
            finir(true, new Error(
                "Dépendances Python AROME indisponibles sur Render. " +
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
                console.log("AROME Paquets ecCodes :", sortie.slice(-1800));
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
    const nomHote = process.env.RENDER_EXTERNAL_HOSTNAME;
    const serviceTest = nomHote === "station-meteo-lr-test.onrender.com";
    const serviceProduction = nomHote === "station-meteo-lr.onrender.com";
    if (!serviceTest && process.env.AROME_PAQUETS_TEST_ENABLED !== "1") {
        return { actif: false, estCacheDisponible: () => false };
    }
    const origineCache = serviceProduction
        ? "Paquets AROME Render production" : "Paquets AROME Render test";
    const sourceCache = "AROME 0.025 SP1 GRIB2 ecCodes - " +
        (serviceProduction ? "Render production" : "Render test");
    const brancheSauvegarde = serviceProduction ? "arome-paquets-data"
        : serviceTest ? "arome-paquets-test-data" : null;

    let cacheTest = null;
    let enCours = false;
    let dernierDemarrage = 0;
    let derniereReussite = 0;
    let prochainEssai = 0;
    let controleAutoEnCours = false;
    let dernierControleCatalogue = 0;
    let modeleCataloguePlusRecent = null;
    let erreurControleCatalogue = null;
    let restaurationTerminee = !brancheSauvegarde;
    let restaurationGitHub = brancheSauvegarde ? "non_demarre" : "non_configuree";
    let erreurRestauration = null;
    let publicationGitHub = "non_demarre";
    let erreurPublication = null;
    let diagnosticCatalogue = null;
    let diagnosticCatalogueExpire = 0;
    let diagnosticCatalogueEnCours = null;
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
            stockage_cache: cacheTest ? "disque_temporaire" : null,
            traitement_lourd: traitementEnCours(),
            modele_cache_disponible: cacheTest?.modele || null,
            source_cache: cacheTest?.source || null,
            meteo_version: cacheTest?.meteo_version || 0,
            champs_meteo: cacheTest?.champs_meteo || null,
            definitions_meteofrance_installees: fsSystem.existsSync(
                path.join(__dirname, "vendor", "meteofrance", "definitions", "grib2")
            ),
            branche_sauvegarde: brancheSauvegarde,
            restauration_pages: restaurationGitHub,
            erreur_restauration_pages: erreurRestauration,
            publication_github: publicationGitHub,
            erreur_publication_github: erreurPublication,
            actualisation_automatique: actualisationAutoActive,
            intervalle_controle_catalogue_minutes: 30,
            controle_catalogue_en_cours: controleAutoEnCours,
            dernier_controle_catalogue: dernierControleCatalogue
                ? new Date(dernierControleCatalogue).toISOString() : null,
            modele_catalogue_plus_recent: modeleCataloguePlusRecent,
            erreur_controle_catalogue: erreurControleCatalogue,
            derniere_actualisation_reussie: derniereReussite
                ? new Date(derniereReussite).toISOString() : null,
            prochaine_tentative: prochainEssai
                ? new Date(prochainEssai).toISOString() : null
        });
    });

    // Diagnostic du catalogue SP1 : métadonnées uniquement, sans téléchargement
    // des paquets GRIB2 ni changement du cache ou du calcul au point cliqué.
    // Reproduit strictement les critères de selectionnerReseauComplet().
    async function lireDiagnosticCatalogue() {
        const authentification = await authentificationPaquets();
        const description = await catalogue(SP1, authentification);
        const reseaux = [...new Set(description.links.map(lien => {
            const reference = new URL(lien.href || "", SP1)
                .searchParams.get("referencetime");
            return reference && !Number.isNaN(Date.parse(reference))
                ? reference : null;
        }).filter(Boolean))].sort().reverse();

        const resultats = [];
        for (const reference of reseaux.slice(0, 8)) {
            try {
                const url = SP1 + "?" +
                    new URLSearchParams({ referencetime: reference });
                const disponibilites = await catalogue(url, authentification);
                const heuresDisponibles = new Set(
                    disponibilites.links.filter(lien => {
                        const params = new URL(lien.href || "", SP1).searchParams;
                        const format = params.get("format") || "";
                        return format.toLowerCase() === "grib2" ||
                            /grib2/i.test(lien.title || "");
                    }).map(lien => lien.time ||
                        new URL(lien.href || "", SP1).searchParams.get("time"))
                      .filter(Boolean)
                );
                const presents = GROUPES.filter(g =>
                    heuresDisponibles.has(g.code)).map(g => g.code);
                const manquants = GROUPES.filter(g =>
                    !heuresDisponibles.has(g.code)).map(g => g.code);
                resultats.push({
                    modele: reference,
                    nombre_groupes: presents.length,
                    groupes_disponibles: presents,
                    groupes_manquants: manquants,
                    complet_h1_h51: manquants.length === 0
                });
            } catch (e) {
                // Une erreur sur un réseau ne masque pas les autres.
                resultats.push({
                    modele: reference,
                    nombre_groupes: null,
                    groupes_disponibles: [],
                    groupes_manquants: [],
                    complet_h1_h51: false,
                    erreur: e.message
                });
            }
        }
        const premierComplet = resultats.find(r => r.complet_h1_h51);
        return {
            source: "Météo-France DPPaquetAROME SP1 0.025",
            date_verification: new Date().toISOString(),
            reseaux_annonces: reseaux.length,
            reseaux_examines: resultats.length,
            groupes_requis: GROUPES.map(g => g.code),
            premier_modele_complet: premierComplet?.modele || null,
            reseaux: resultats
        };
    }

    app.get("/api/arome/paquets/test/catalogue", async (_req, res) => {
        res.set("Cache-Control", "no-store");
        try {
            if (!diagnosticCatalogue ||
                Date.now() >= diagnosticCatalogueExpire) {
                if (!diagnosticCatalogueEnCours) {
                    diagnosticCatalogueEnCours = lireDiagnosticCatalogue();
                }
                try {
                    const nouveau = await diagnosticCatalogueEnCours;
                    diagnosticCatalogue = nouveau;
                    diagnosticCatalogueExpire =
                        Date.now() + TTL_DIAGNOSTIC_CATALOGUE;
                } finally {
                    diagnosticCatalogueEnCours = null;
                }
            }
            return res.json({
                succes: true,
                ...diagnosticCatalogue,
                modele_cache_actif: cacheTest?.modele || null,
                actualisation_en_cours: enCours,
                duree_cache_diagnostic_secondes: TTL_DIAGNOSTIC_CATALOGUE / 1000
            });
        } catch (e) {
            return res.status(502).json({
                succes: false,
                erreur: "Diagnostic du catalogue AROME indisponible : " + e.message
            });
        }
    });

    app.get("/api/arome/paquets/test/previsions", async (req, res) => {
        res.set("Cache-Control", "no-store");
        if (!cacheTest) {
            verifierActualisationAutomatique();
            return res.status(503).json({
                succes: false,
                erreur: "Aucun cache de paquets AROME validé sur ce service Render",
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
            const resultat = await cacheTest.calculerPoint(calculerPrevisionsArome, lat, lon);
            return res.json({
                ...resultat,
                cache: true,
                origine_cache: origineCache,
                actualisation_en_cours: enCours,
                actualisation_statut: etat.statut,
                modele_cache: resultat.modele
            });
        } catch (e) {
            return res.status(422).json({ succes: false, erreur: e.message });
        }
    });

    // Cache complet téléchargé par le workflow de sauvegarde, compressé à la source.
    // Cache-Control court pour limiter les réponses lourdes répétées.
    app.get("/api/arome/paquets/test/cache", async (req, res) => {
        if (!cacheTest) {
            return res.status(503).json({
                succes: false,
                erreur: "Cache des paquets AROME indisponible"
            });
        }
        res.set({
            "Content-Type": "application/json; charset=utf-8",
            "Content-Encoding": "gzip",
            "Content-Length": String(cacheTest.tailleGzip),
            "Cache-Control": "public, max-age=60",
            "Vary": "Accept-Encoding"
        });
        if (req.method === "HEAD") return res.end();
        await cacheTest.envoyerGzip(res);
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
            const paquets = await cacheTest.calculerPoint(calculerPrevisionsArome, lat, lon, false);
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
                modele_paquets: paquets.modele,
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

    async function restaurerCacheGitHub() {
        // Ne pas décompresser ~12 Mo gzip / ~40 Mo JSON pendant un radar
        // national ou un décodage AROME en cours sur la même instance.
        const libererRestauration = essayerDemarrer("restauration-grib2");
        if (!libererRestauration) {
            const rappel = setTimeout(() => {
                void restaurerCacheGitHub();
            }, 2000);
            rappel.unref?.();
            return;
        }
        restaurationGitHub = "en_cours";
        try {
            const { cache: restaure, compresse } = await lireSauvegardeArome(
                brancheSauvegarde, "arome-paquets-cache.json.gz",
                MAX_JSON_OCTETS, MAX_CACHE_GZIP_OCTETS
            );
            if (restaure?.source !== sourceCache) {
                throw new Error("Source du cache AROME Paquets incompatible avec le service Render");
            }
            validerCacheAromePaquets(restaure, calculerPrevisionsArome);

            // Aucun cache actif n'est écrasé par une restauration plus ancienne.
            if (!cacheTest) {
                cacheTest = await preparerCacheDisque(restaure, compresse);
                const dateCache = Number(restaure.date);
                derniereReussite = Number.isFinite(dateCache) &&
                    dateCache > 0 && dateCache <= Date.now()
                    ? dateCache : 0;
                // Contrôler le catalogue dès le démarrage, même si le cache
                // restauré est récent : le nouveau modèle peut être disponible.
                prochainEssai = 0;
                etat = {
                    statut: "restaure",
                    etape: "restauration_pages",
                    modele: restaure.modele,
                    erreur: null,
                    origine_actualisation: "GitHub " + brancheSauvegarde,
                    groupes_total: 9,
                    groupes_termines: 9,
                    echeances_uv: 51,
                    echeances_rafale: 51,
                    taille_cache_gzip_mo: arrondiMo(compresse.length),
                    dernier_test: new Date().toISOString()
                };
            }
            restaurationGitHub = "reussie";
            erreurRestauration = null;
            console.log(
                "AROME Paquets : sauvegarde GitHub restaurée",
                brancheSauvegarde, restaure.modele, arrondiMo(compresse.length), "Mo"
            );
        } catch (e) {
            restaurationGitHub = "indisponible";
            erreurRestauration = e.message;
            console.warn("AROME Paquets : restauration GitHub indisponible :", brancheSauvegarde, e.message);
        } finally {
            restaurationTerminee = true;
            libererRestauration();
            verifierActualisationAutomatique();
        }
    }

    async function signalerSauvegardeGitHub(modele, compresse) {
        if (!serviceTest && !serviceProduction) return;

        const jeton = jetonSauvegardeArome();
        if (!jeton) {
            publicationGitHub = "non_configuree";
            erreurPublication = "Configurer GITHUB_PAQUETS_PUBLISH_TOKEN sur Render";
            return;
        }
        publicationGitHub = "envoi";
        erreurPublication = null;
        try {
            await signalerSauvegardeArome(jeton, {
                evenement: serviceProduction
                    ? "arome-paquets-production-cache-ready" : "arome-paquets-cache-ready",
                modele,
                compresse,
                userAgent: "meteo-la-rochelle-arome-paquets"
            });
            // Le dispatch accepté ne signifie pas que la sauvegarde est déjà publiée.
            publicationGitHub = "demande_envoyee";
            console.log("AROME Paquets : sauvegarde demandée à GitHub Actions");
        } catch (e) {
            publicationGitHub = "echec";
            erreurPublication = e.message;
            console.warn("AROME Paquets : sauvegarde GitHub non envoyée :", e.message);
        }
    }

    async function executer(groupesDemandes, produitSelectionne = null, libererGrib) {
        let dossier;
        try {
            etat = { ...etat, etape: "verification_python" };
            await verifierDependancesPython();
            etat = { ...etat, etape: "authentification" };
            const authentification = await authentificationPaquets();
            console.log(origineCache + " : mode auth", authentification.mode);
            etat = { ...etat, authentification: authentification.mode };
            // Le contrôle automatique a déjà choisi un réseau complet :
            // éviter de relire le catalogue et de changer de modèle en route.
            const produit = produitSelectionne || await selectionnerReseauComplet(
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
                    origineCache + " :", groupe.code,
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
            const champsMeteo = Object.fromEntries(
                ["T2M_METEO", "NEBUL_METEO", "PRECIP_METEO"].map(nom => [
                    nom, previsions.filter(p => Boolean(p[nom])).length
                ])
            );
            console.log("AROME Paquets : champs météo facultatifs :", champsMeteo);
            const cache = {
                meteo_version: 2,
                champs_meteo: champsMeteo,
                modele: produit.modele,
                date: Date.now(),
                source: sourceCache,
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
            let resultatCompression;
            try {
                resultatCompression = await compresserCacheArome(
                    cache, MAX_JSON_OCTETS, MAX_CACHE_GZIP_OCTETS
                );
            } catch (erreur) {
                if (erreur.code !== "CACHE_TROP_GRAND") throw erreur;
                // Si la météo dépasse la limite, préserver le vent en secours.
                console.warn("AROME Paquets : météo compacte trop volumineuse ; " +
                    "retour au cache vent uniquement");
                for (const p of cache.previsions) {
                    delete p.T2M_METEO;
                    delete p.NEBUL_METEO;
                    delete p.PRECIP_METEO;
                }
                cache.champs_meteo = {
                    T2M_METEO: 0, NEBUL_METEO: 0, PRECIP_METEO: 0
                };
                resultatCompression = await compresserCacheArome(
                    cache, MAX_JSON_OCTETS, MAX_CACHE_GZIP_OCTETS
                );
            }
            const { gzip, tailleJson } = resultatCompression;
            // Les requêtes déjà engagées terminent leur lecture sur l'ancien cycle.
            const nouveau = await preparerCacheDisque(cache, gzip);
            const precedent = cacheTest;
            cacheTest = nouveau;
            precedent?.retirer();
            derniereReussite = Date.now();
            prochainEssai = derniereReussite + INTERVALLE_CONTROLE_CATALOGUE;
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
                void signalerSauvegardeGitHub(cache.modele, gzip);
            }
        } catch (e) {
            console.error(origineCache + " :", e.message);
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
            libererGrib?.();
        }
    }

    function lancerActualisationPaquets(groupesDemandes, origine, produitSelectionne = null) {
        if (enCours) return false;
        const libererGrib = essayerDemarrer("arome-grib2");
        if (!libererGrib) {
            // Un radar ou un WCS est actif : réessayer plus vite que le
            // contrôle catalogue périodique, sans lancer de second décodeur.
            prochainEssai = Date.now() + 60 * 1000;
            console.log("AROME Paquets : décodage différé, " +
                (traitementEnCours()?.nom || "traitement lourd en cours"));
            return false;
        }
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
        void executer(groupesDemandes, produitSelectionne, libererGrib);
        return true;
    }

    function verifierActualisationAutomatique() {
        if (!restaurationTerminee || !actualisationAutoActive ||
            enCours || controleAutoEnCours ||
            Date.now() < prochainEssai ||
            Date.now() - dernierDemarrage < MIN_INTERVALLE_TEST) {
            return false;
        }

        // Un contrôle toutes les 30 min des métadonnées du catalogue.
        // Ne télécharger les neuf GRIB2 que si le modèle complet est plus
        // récent que le cache actif (ou si le cache est absent/incomplet).
        controleAutoEnCours = true;
        prochainEssai = Date.now() + INTERVALLE_CONTROLE_CATALOGUE;
        void (async () => {
            try {
                const authentification = await authentificationPaquets();
                const produit = await selectionnerReseauComplet(
                    authentification, GROUPES, () => {}
                );
                dernierControleCatalogue = Date.now();
                modeleCataloguePlusRecent = produit.modele;
                erreurControleCatalogue = null;
                const cacheComplet = cacheTest?.nombreEcheances === 51;
                // Première reconstruction après la mise à jour : restaurer
                // l'ancien cache de vent, puis l'enrichir sans attendre un
                // changement de réseau. Les cycles suivants restent à 30 min.
                const nouveauModele = !cacheComplet ||
                    Number(cacheTest?.meteo_version || 0) < 2 ||
                    Date.parse(produit.modele) > Date.parse(cacheTest.modele);

                if (nouveauModele) {
                    console.log(
                        "AROME Paquets : nouveau modèle complet disponible",
                        produit.modele, "(cache :", cacheTest?.modele || "absent", ")"
                    );
                    lancerActualisationPaquets(GROUPES, "automatique", produit);
                } else {
                    console.log(
                        "AROME Paquets : catalogue vérifié, cache déjà à jour",
                        cacheTest.modele
                    );
                }
            } catch (e) {
                dernierControleCatalogue = Date.now();
                erreurControleCatalogue = e.message;
                prochainEssai = Date.now() + RETRY_AUTO;
                console.warn(
                    "AROME Paquets : échec du contrôle du catalogue :",
                    e.message
                );
            } finally {
                controleAutoEnCours = false;
            }
        })();
        return true;
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
        if (serviceProduction && nombreGroupes !== GROUPES.length) {
            return res.status(400).json({
                succes: false, erreur: "La production requiert les 9 groupes AROME"
            });
        }
        if (!restaurationTerminee) {
            return res.status(409).json({
                succes: false, erreur: "Restauration de la sauvegarde GitHub en cours"
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
        const lance = lancerActualisationPaquets(
            GROUPES.slice(0, nombreGroupes), "manuelle"
        );
        if (!lance) {
            return res.status(409).json({
                succes: false,
                erreur: "Téléchargement GRIB2 différé : traitement lourd actif",
                traitement_lourd: traitementEnCours()
            });
        }
        return res.status(202).json({ succes: true, ...etat });
    });

    // Au démarrage, restaurer le cache existant AVANT de lancer l'éventuel
    // téléchargement des neuf paquets, sans bloquer la mise en route HTTP.
    setImmediate(() => {
        if (brancheSauvegarde) {
            void restaurerCacheGitHub();
        } else {
            verifierActualisationAutomatique();
        }
    });

    if (actualisationAutoActive) {
        // Les timers sont suspendus quand Render gratuit est en veille.
        // La restauration et le contrôle reprennent au prochain réveil.
        const horloge = setInterval(
            verifierActualisationAutomatique, CONTROLE_AUTO
        );
        horloge.unref?.();
    }

    return { actif: true, estCacheDisponible: () => Boolean(cacheTest) };
}

module.exports = { installerTestAromePaquets };
