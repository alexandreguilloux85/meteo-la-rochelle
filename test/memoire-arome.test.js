"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { gunzipSync } = require("node:zlib");
const { essayerDemarrer, traitementEnCours } = require("../traitement-lourd");
const { compresserCacheArome } = require("../arome-cache-stream");
const { masquerRadarSelonQualite } = require("../radar-qualite");

test("un seul traitement lourd à la fois, déverrouillage idempotent", () => {
    assert.equal(traitementEnCours(), null);
    const libererRadar = essayerDemarrer("radar");
    assert.equal(typeof libererRadar, "function");
    assert.equal(essayerDemarrer("arome-grib2"), null);
    assert.equal(traitementEnCours().nom, "radar");
    libererRadar();
    libererRadar();
    assert.equal(traitementEnCours(), null);
    const libererGrib = essayerDemarrer("arome-grib2");
    assert.equal(typeof libererGrib, "function");
    assert.equal(essayerDemarrer("arome-wcs"), null);
    libererGrib();
    assert.equal(traitementEnCours(), null);
});

test("gzip en flux : JSON valide, métadonnées et 51 échéances conservées", async () => {
    const cache = {
        meteo_version: 2, champs_meteo: { T2M_METEO: 51, NEBUL_METEO: 51 },
        modele: "2026-11-21T06:00:00Z",
        date: 1234567, zone: { latMin: 43.2, latMax: 48.3 },
        previsions: Array.from({ length: 51 }, (_, i) => ({
            seconde: (i + 1) * 3600,
            U: { grille: { Ni: 191, Nj: 207 }, valeurs: [1, 2, 3] },
            RAFALE: { valeurs: [2, 5, 7] },
            T2M_METEO: { compact: "AAECAw==" },
            note: "été – côte Atlantique"
        }))
    };
    const { gzip, tailleJson } = await compresserCacheArome(
        cache, 4 * 1024 * 1024, 1 * 1024 * 1024
    );
    const decoded = gunzipSync(gzip).toString("utf8");
    assert.deepEqual(JSON.parse(decoded), cache);
    assert.equal(tailleJson, Buffer.byteLength(decoded));
    assert.equal(cache.previsions.length, 51);
    assert.ok(gzip.length < tailleJson);
});

test("taille JSON excessive : erreur contrôlée et aucune mutation du cache", async () => {
    const cache = { modele: "x", previsions: [{ data: "longue chaîne" }] };
    await assert.rejects(
        compresserCacheArome(cache, 15, 10000),
        err => err.code === "CACHE_TROP_GRAND"
    );
    assert.equal(cache.previsions[0].data, "longue chaîne");
});

test("limite de taille gzip appliquée", async () => {
    const cache = {
        previsions: Array.from({ length: 80 }, (_, i) => ({
            n: i, data: "surcharge-" + i
        }))
    };
    await assert.rejects(
        compresserCacheArome(cache, 100000, 8),
        err => err.code === "CACHE_TROP_GRAND"
    );
});

test("masque radar : mêmes pixels valides, qualité invalide transparente", () => {
    const pluie = new Uint16Array([0, 1, 255, 512, 1024, 65534, 65535]);
    const qualite = new Uint8Array([1, 0, 200, 255, 2, 3, 4]);
    const avant = new Uint16Array(pluie);
    const valideAvant = avant.map((valeur, i) =>
        (valeur === 65535 || valeur === 65534 ||
        qualite[i] === 0 || qualite[i] === 255) ? 0 : valeur
    );
    masquerRadarSelonQualite(pluie, qualite);
    const valideApres = pluie.map(v => (v === 65535 || v === 65534) ? 0 : v);
    assert.deepEqual(valideApres, valideAvant);
    assert.deepEqual(pluie, new Uint16Array([0, 65535, 255, 65535, 1024, 65534, 65535]));
    assert.throws(() => masquerRadarSelonQualite(pluie, new Uint8Array(2)));
});
