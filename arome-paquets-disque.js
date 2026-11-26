"use strict";

const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createInterface } = require("node:readline");
const { pipeline } = require("node:stream/promises");
const { ajouterMeteoAuxPrevisions } = require("./arome-meteo-point-test");

// Le gzip est transmis tel quel à la sauvegarde GitHub. L'API de secours
// peut lire une échéance à la fois sans remettre toute la grille en mémoire.
async function preparerCacheDisque(cache, gzip) {
    const { previsions, ...meta } = cache;
    const dossier = await fs.mkdtemp(path.join(os.tmpdir(), "arome-cycle-"));
    const archive = path.join(dossier, "cache.gz");
    const heures = path.join(dossier, "heures.ndjson");
    try {
        await fs.writeFile(archive, gzip);
        const sortie = await fs.open(heures, "w");
        try {
            for (const p of [...previsions].sort((a, b) => a.seconde - b.seconde)) {
                await sortie.writeFile(JSON.stringify(p) + "\n");
            }
        } finally {
            await sortie.close();
        }
    } catch (erreur) {
        await fs.rm(dossier, { recursive: true, force: true });
        throw erreur;
    }
    const nombreEcheances = previsions.length;
    return ouvrirCacheDisque(meta, nombreEcheances, gzip.length, dossier, archive, heures);
}

function ouvrirCacheDisque(meta, nombreEcheances, tailleGzip, dossier, archive, heures) {
    let lecteurs = 0;
    let retire = false;
    function nettoyer() {
        if (retire && !lecteurs) {
            void fs.rm(dossier, { recursive: true, force: true })
                .catch(e => console.warn("Nettoyage du cycle AROME :", e.message));
        }
    }
    async function lire(operation) {
        lecteurs++;
        try {
            return await operation();
        } finally {
            lecteurs--;
            nettoyer();
        }
    }
    return {
        ...meta, nombreEcheances, tailleGzip,
        retirer() { retire = true; nettoyer(); },
        envoyerGzip(res) {
            return lire(() => pipeline(createReadStream(archive), res));
        },
        calculerPoint(calculer, lat, lon, avecMeteo = true) {
            return lire(async () => {
                const resultat = calculer({ ...meta, previsions: [] }, lat, lon);
                const flux = createReadStream(heures, { encoding: "utf8" });
                const lignes = createInterface({ input: flux, crlfDelay: Infinity });
                let precedente;
                try {
                    for await (const ligne of lignes) {
                        const p = JSON.parse(ligne);
                        const tranche = { ...meta, erreurs: [], previsions: [p] };
                        const bilan = calculer(tranche, lat, lon);
                        if (avecMeteo) {
                            // La pluie horaire peut nécessiter le cumul de l'heure précédente.
                            if (precedente) tranche.previsions.unshift(precedente);
                            ajouterMeteoAuxPrevisions(tranche, bilan, lat, lon);
                            precedente = p;
                        }
                        resultat.previsions.push(...bilan.previsions);
                        resultat.erreurs.push(...bilan.erreurs);
                    }
                } finally {
                    lignes.close();
                    flux.destroy();
                }
                resultat.nombre_echeances = resultat.previsions.length;
                resultat.nombre_erreurs = resultat.erreurs.length;
                return resultat;
            });
        }
    };
}

module.exports = { preparerCacheDisque };
