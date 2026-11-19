"use strict";

// Essai isolé AROME SP1 / GRIB2 sur Render test.
// Aucun accès au cache WCS de production ni publication automatique.
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = "https://public-api.meteofrance.fr/previnum/DPPaquetAROME/v1";
const SP1 = ROOT + "/models/AROME/grids/0.025/packages/SP1";
const ZONE = { latMin: 43.2, latMax: 48.3, lonMin: -5.0, lonMax: -0.3 };
const MAX_GRIB_OCTETS = 120 * 1024 * 1024;
const MAX_JSON_OCTETS = 45 * 1024 * 1024;
const MIN_INTERVALLE_TEST = 4 * 60 * 1000;

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

async function jetonPaquets() {
    const identifiant = process.env.METEO_AROME_PAQUETS_APPLICATION_ID?.trim();
    if (identifiant) {
        // Un identifiant Basic durable permet d'obtenir un jeton Bearer frais.
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
        return donnees.access_token;
    }

    const secret = process.env.METEO_AROME_PAQUETS_TOKEN?.trim();
    if (!secret) {
        throw new Error(
            "Configurer METEO_AROME_PAQUETS_APPLICATION_ID (recommandé) " +
            "ou METEO_AROME_PAQUETS_TOKEN sur Render test"
        );
    }
    const jeton = secret.replace(/^Authorization:\s*/i, "")
        .replace(/^Bearer\s+/i, "").replace(/^['"]|['"]$/g, "").trim();
    if (!jeton || /\s/.test(jeton)) {
        throw new Error("METEO_AROME_PAQUETS_TOKEN mal copié");
    }
    return jeton;
}

async function requeteMeteo(url, jeton, timeout = 30000) {
    const urlVerifiee = verifierURLAPI(url);
    const reponse = await fetch(urlVerifiee, {
        redirect: "error",
        headers: {
            Authorization: "Bearer " + jeton,
            Accept: "*/*"
        },
        cache: "no-store",
        signal: AbortSignal.timeout(timeout)
    });
    if (!reponse.ok) {
        const code = reponse.status;
        if (code === 401) throw new Error("Jeton Paquet AROME refusé (401) : expiré ou invalide");
        if (code === 403) throw new Error("Accès Paquet AROME interdit (403) : vérifier l'abonnement");
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

async function dernierPaquet(jeton, etape) {
    etape("catalogue");
    const description = await catalogue(SP1, jeton);
    const reseaux = description.links.map(lien => {
        const href = lien.href || "";
        const reference = new URL(href, SP1).searchParams.get("referencetime");
        return reference && !Number.isNaN(Date.parse(reference))
            ? reference : null;
    }).filter(Boolean).sort().reverse();

    if (!reseaux.length) throw new Error("Aucun réseau disponible dans le paquet SP1");
    etape("recherche_echeances");

    for (const reference of reseaux.slice(0, 5)) {
        const url = SP1 + "?" + new URLSearchParams({ referencetime: reference });
        const disponibilites = await catalogue(url, jeton);
        const present = disponibilites.links.some(lien => {
            const href = lien.href || "";
            return (lien.time === "00H06H" ||
                new URL(href, SP1).searchParams.get("time") === "00H06H") &&
                (/format=grib2/i.test(href) || /grib2/i.test(lien.title || ""));
        });
        if (present) {
            return {
                modele: reference,
                url: SP1 + "/productARO?" +
                    new URLSearchParams({
                        referencetime: reference,
                        time: "00H06H",
                        format: "grib2"
                    })
            };
        }
    }
    throw new Error("Aucun produit SP1 00H06H GRIB2 disponible dans les réseaux récents");
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
            await sortie.write(bloc);
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

function decoderAvecPython(fichier, dossier, modele) {
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

function installerTestAromePaquets(app, { verifierJetonActualisation, calculerPrevisionsArome }) {
    // Jamais sur le service de production : ni téléchargement, ni publication.
    if (process.env.RENDER_EXTERNAL_HOSTNAME !== "station-meteo-lr-test.onrender.com" &&
        process.env.AROME_PAQUETS_TEST_ENABLED !== "1") {
        return;
    }

    let cacheTest = null;
    let enCours = false;
    let dernierDemarrage = 0;
    let etat = {
        statut: "non_demarre",
        etape: null,
        modele: null,
        erreur: null
    };

    app.get("/api/arome/paquets/test/status", (_req, res) => {
        res.set("Cache-Control", "no-store");
        res.json({ ...etat, en_cours: enCours, cache_disponible: Boolean(cacheTest) });
    });

    app.get("/api/arome/paquets/test/previsions", (req, res) => {
        res.set("Cache-Control", "no-store");
        if (!cacheTest) {
            return res.status(503).json({
                succes: false,
                erreur: "Aucun cache de paquets AROME validé sur Render test"
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
            return res.json({ ...resultat, origine_cache: "Paquets AROME Render test" });
        } catch (e) {
            return res.status(422).json({ succes: false, erreur: e.message });
        }
    });

    async function executer() {
        let dossier;
        try {
            const jeton = await jetonPaquets();
            const produit = await dernierPaquet(jeton, etape => {
                etat = { ...etat, etape };
            });
            etat = { ...etat, etape: "telechargement", modele: produit.modele };
            dossier = await fs.mkdtemp(path.join(os.tmpdir(), "arome-paquets-"));
            const fichier = path.join(dossier, "sp1.grib2");
            const tailleGrib = await telechargerGrib(produit.url, jeton, fichier);

            etat = { ...etat, etape: "decodage_grib2" };
            await decoderAvecPython(fichier, dossier, produit.modele);
            const cheminJson = path.join(dossier, "arome-cache-paquets-test.json");
            const tailleJson = (await fs.stat(cheminJson)).size;
            if (tailleJson > MAX_JSON_OCTETS) {
                throw new Error("Cache JSON supérieur à 45 Mo : test arrêté");
            }
            const cache = JSON.parse(await fs.readFile(cheminJson, "utf8"));
            if (!Array.isArray(cache.previsions) ||
                cache.previsions.length !== 6 ||
                cache.previsions.some(p => !p.U || !p.V)) {
                throw new Error("Cache incomplet : 6 échéances U/V attendues");
            }
            const point = calculerPrevisionsArome(cache, 46.178, -1.193167);
            if (point.previsions.length !== 6) {
                throw new Error("Interpolation incomplète à La Rochelle");
            }
            cacheTest = cache;
            etat = {
                statut: "termine",
                etape: "termine",
                modele: produit.modele,
                erreur: null,
                zone: cache.zone,
                grille: cache.previsions[0].U.grille,
                echeances_uv: cache.previsions.length,
                echeances_rafale: cache.previsions.filter(p => p.RAFALE).length,
                taille_grib_mo: arrondiMo(tailleGrib),
                taille_cache_mo: arrondiMo(tailleJson),
                dernier_test: new Date().toISOString()
            };
        } catch (e) {
            console.error("AROME Paquets Render test :", e.message);
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

    app.post("/api/arome/paquets/test/refresh", (req, res) => {
        if (!verifierJetonActualisation(req, res)) return;
        res.set("Cache-Control", "no-store");
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
        enCours = true;
        dernierDemarrage = Date.now();
        etat = { statut: "en_cours", etape: "authentification", modele: null, erreur: null };
        void executer();
        return res.status(202).json({ succes: true, ...etat });
    });
}

module.exports = { installerTestAromePaquets };
