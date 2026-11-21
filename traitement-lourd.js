"use strict";

// Verrou partagé par les traitements lourds d'une même instance Render.
// Un traitement concurrent n'est pas lancé : les caches déjà disponibles
// restent consultables et le prochain contrôle pourra réessayer.
let traitement = null;

function essayerDemarrer(nom) {
    if (traitement) return null;
    const identifiant = Symbol(nom);
    traitement = { nom, identifiant, debut: Date.now() };
    let libere = false;
    return function liberer() {
        if (libere) return;
        libere = true;
        if (traitement?.identifiant === identifiant) traitement = null;
    };
}

function traitementEnCours() {
    return traitement ? {
        nom: traitement.nom,
        depuis: new Date(traitement.debut).toISOString()
    } : null;
}

module.exports = { essayerDemarrer, traitementEnCours };
