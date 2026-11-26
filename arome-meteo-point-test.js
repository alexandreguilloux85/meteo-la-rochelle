"use strict";

const { inflateSync } = require("node:zlib");
const { ajouterChampsMeteo } = require("./public/arome-calcul-point");
const valeursDecodees = new WeakMap();

function lireValeurs(champ) {
    if (valeursDecodees.has(champ)) return valeursDecodees.get(champ);
    const taille = champ.grille.Ni * champ.grille.Nj * 2;
    try {
        const octets = inflateSync(Buffer.from(champ.donnees, "base64"), { maxOutputLength: taille });
        if (octets.length !== taille) return null;
        const valeurs = new DataView(octets.buffer, octets.byteOffset, taille);
        valeursDecodees.set(champ, valeurs);
        return valeurs;
    } catch {
        return null;
    }
}

function ajouterMeteoAuxPrevisions(cache, resultat, lat, lon) {
    return ajouterChampsMeteo(cache, resultat, lat, lon, lireValeurs);
}

module.exports = { ajouterMeteoAuxPrevisions };
