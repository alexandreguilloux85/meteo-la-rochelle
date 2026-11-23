"use strict";

const { createHash } = require("node:crypto");
const { gzipSync, gunzipSync } = require("node:zlib");

const URL_CACHE_GITHUB = "https://raw.githubusercontent.com/alexandreguilloux85/meteo-la-rochelle/refs/heads/";
const URL_DISPATCH = "https://api.github.com/repos/alexandreguilloux85/meteo-la-rochelle/dispatches";

async function lireSauvegardeArome(branche, fichier, maxJson, maxGzip, minOctets = 1000) {
    const url = new URL(branche + "/" + fichier, URL_CACHE_GITHUB);
    url.searchParams.set("t", String(Date.now()));
    const reponse = await fetch(url, {
        redirect: "error",
        cache: "no-store",
        headers: { Accept: "application/octet-stream" },
        signal: AbortSignal.timeout(45000)
    });
    if (!reponse.ok) throw new Error("Sauvegarde GitHub : HTTP " + reponse.status);
    if (Number(reponse.headers.get("content-length")) > maxJson) {
        throw new Error("Sauvegarde GitHub trop volumineuse");
    }
    const telecharge = Buffer.from(await reponse.arrayBuffer());
    if (telecharge.length < minOctets || telecharge.length > maxJson) {
        throw new Error("Sauvegarde GitHub absente ou trop volumineuse");
    }

    // Certains intermédiaires HTTP renvoient le JSON déjà décompressé.
    if (telecharge[0] === 0x1f && telecharge[1] === 0x8b) {
        if (telecharge.length > maxGzip) throw new Error("Cache gzip GitHub trop volumineux");
        const texte = gunzipSync(telecharge, { maxOutputLength: maxJson }).toString("utf8");
        return { cache: JSON.parse(texte), compresse: telecharge };
    }
    if (!telecharge.toString("utf8", 0, 32).trimStart().startsWith("{")) {
        throw new Error("Sauvegarde GitHub : format non reconnu");
    }
    const compresse = gzipSync(telecharge, { level: 6 });
    if (compresse.length > maxGzip) throw new Error("Cache gzip GitHub trop volumineux");
    return { cache: JSON.parse(telecharge.toString("utf8")), compresse };
}

function jetonSauvegardeArome() {
    return (process.env.GITHUB_PAQUETS_PUBLISH_TOKEN || process.env.GITHUB_DATA_TOKEN || "").trim();
}

async function signalerSauvegardeArome(jeton, { evenement, modele, compresse, userAgent }) {
    const sha256 = createHash("sha256").update(compresse).digest("hex");
    const reponse = await fetch(URL_DISPATCH, {
        method: "POST",
        redirect: "error",
        headers: {
            Authorization: "Bearer " + jeton,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": userAgent
        },
        body: JSON.stringify({ event_type: evenement, client_payload: { modele, sha256 } }),
        signal: AbortSignal.timeout(30000)
    });
    if (!reponse.ok) throw new Error("GitHub dispatch HTTP " + reponse.status);
}

module.exports = { lireSauvegardeArome, jetonSauvegardeArome, signalerSauvegardeArome };
