"use strict";

const { Readable, Writable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { createGzip } = require("node:zlib");

function depassement(message) {
    const erreur = new Error(message);
    erreur.code = "CACHE_TROP_GRAND";
    return erreur;
}

// Sérialiser une échéance à la fois : évite le gros JSON.stringify(cache)
// et son Buffer.from() en mémoire en plus des grilles et de l'ancien cache.
// Le gzip produit reste strictement un document JSON valide.
async function compresserCacheArome(cache, maxJson, maxGzip) {
    if (!cache || !Array.isArray(cache.previsions)) {
        throw new Error("Cache AROME invalide pour la compression");
    }
    const { previsions, ...metadonnees } = cache;
    let tailleJson = 0;
    let tailleGzip = 0;
    const morceauxGzip = [];

    function compter(chaine) {
        tailleJson += Buffer.byteLength(chaine, "utf8");
        if (tailleJson > maxJson) {
            throw depassement("JSON AROME supérieur à la limite mémoire/Pages");
        }
        return chaine;
    }

    function* morceauxJson() {
        const entete = JSON.stringify(metadonnees);
        yield compter(entete.slice(0, -1) +
            (Object.keys(metadonnees).length ? "," : "") + '"previsions":[');
        for (let i = 0; i < previsions.length; i++) {
            yield compter((i ? "," : "") + JSON.stringify(previsions[i]));
        }
        yield compter("]}");
    }

    await pipeline(
        Readable.from(morceauxJson()),
        createGzip({ level: 6 }),
        new Writable({
            write(morceau, _encodage, terminer) {
                tailleGzip += morceau.length;
                if (tailleGzip > maxGzip) {
                    return terminer(depassement("Gzip AROME supérieur à la limite Pages"));
                }
                morceauxGzip.push(morceau);
                terminer();
            }
        })
    );

    return { gzip: Buffer.concat(morceauxGzip, tailleGzip), tailleJson };
}

module.exports = { compresserCacheArome };
