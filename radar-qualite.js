"use strict";

// 65535 est déjà « donnée absente » dans le radar Météo-France.
// Ne garder qu'une grille Uint16 en mémoire entre deux produits :
function masquerRadarSelonQualite(pluie, qualite) {
    if (!(pluie instanceof Uint16Array) ||
        !(qualite instanceof Uint8Array) ||
        pluie.length !== qualite.length) {
        throw new Error("Grilles radar/qualité incompatibles");
    }
    for (let i = 0; i < pluie.length; i++) {
        if (qualite[i] === 0 || qualite[i] === 255) {
            pluie[i] = 65535;
        }
    }
    return pluie;
}

module.exports = { masquerRadarSelonQualite };
