"use strict";

importScripts("arome-calcul-point.js");

const URL_ARCHIVE = "https://alexandreguilloux85.github.io/meteo-la-rochelle/arome-paquets-cache.json.gz";
const STOCKAGE = "meteo-lr-arome-paquets-v1";
const INTERVALLE = 30 * 60 * 1000;
let actif = null;
let restauration;
let verification;
let prochainControle = 0;
const stockage = self.caches ? caches.open(STOCKAGE).catch(() => null) : Promise.resolve(null);

async function preparer(blob, modification) {
    const flux = blob.stream().pipeThrough(new DecompressionStream("gzip"));
    const cache = await new Response(flux).json();
    const { zone, modele, previsions } = cache;
    if (cache.source !== "AROME 0.025 SP1 GRIB2 ecCodes - Render production" ||
        !Number.isFinite(Date.parse(modele)) || zone?.latMin !== 43.2 || zone.latMax !== 48.3 ||
        zone.lonMin !== -5 || zone.lonMax !== -0.3 || previsions?.length !== 51) {
        throw new Error("Archive AROME incompatible");
    }
    const valeursMeteo = new WeakMap();
    const heures = new Set();
    for (const p of previsions) {
        const h = p.seconde / 3600;
        if (!Number.isInteger(h) || h < 1 || h > 51 || heures.has(h)) {
            throw new Error("Échéance AROME absente ou dupliquée");
        }
        heures.add(h);
        for (const nom of ["U", "V", "RAFALE"]) {
            const champ = p[nom];
            const g = champ?.grille;
            if (!Number.isInteger(g?.Ni) || !Number.isInteger(g.Nj) || g.Ni < 2 || g.Nj < 2 ||
                !Number.isFinite(g.latitude_depart) || !Number.isFinite(g.longitude_depart) ||
                !Number.isFinite(g.resolution_latitude) || !Number.isFinite(g.resolution_longitude) ||
                !(g.resolution_latitude > 0 && g.resolution_longitude > 0) ||
                g.longitude_depart > zone.lonMin || g.latitude_depart < zone.latMax ||
                g.longitude_depart + (g.Ni - 1) * g.resolution_longitude < zone.lonMax ||
                g.latitude_depart - (g.Nj - 1) * g.resolution_latitude > zone.latMin ||
                !Array.isArray(champ.valeurs) || champ.valeurs.length !== g.Ni * g.Nj ||
                !champ.valeurs.every(Number.isFinite)) throw new Error("Grille AROME invalide : " + nom);
        }
        for (const nom of ["T2M_METEO", "NEBUL_METEO", "PRECIP_METEO"]) {
            const champ = p[nom];
            if (!champ) continue; // Les sauvegardes vent seul restent exploitables.
            const taille = champ.grille.Ni * champ.grille.Nj * 2;
            if (champ.encodage !== "zlib-base64-int16-v1" || !(taille > 0 && taille <= 400000)) {
                throw new Error("Grille météo incompatible : " + nom);
            }
            const octets = typeof Uint8Array.fromBase64 === "function"
                ? Uint8Array.fromBase64(champ.donnees) : Uint8Array.from(atob(champ.donnees), c => c.charCodeAt(0));
            const fluxChamp = new Blob([octets]).stream().pipeThrough(new DecompressionStream("deflate"));
            const brut = await new Response(fluxChamp).arrayBuffer();
            if (brut.byteLength !== taille) throw new Error("Grille météo incomplète : " + nom);
            valeursMeteo.set(champ, new DataView(brut));
        }
    }
    return { cache, valeursMeteo, taille: blob.size, modification, signature: await signatureGzip(blob.slice(-8)) };
}

async function signatureGzip(fin) {
    // La fin d'un gzip contient le CRC32 et la taille du contenu décompressé.
    const octets = new Uint8Array(await fin.arrayBuffer());
    return Array.from(octets, n => n.toString(16).padStart(2, "0")).join("");
}

async function restaurer() {
    const disque = await stockage;
    const copie = await disque?.match(URL_ARCHIVE);
    if (!copie || (actif && copie.headers.get("X-Signature") === actif.signature)) return;
    const candidat = await preparer(await copie.blob(), copie.headers.get("Last-Modified"));
    installer(candidat);
}

function installer(candidat) {
    if (actif && (Date.parse(candidat.cache.modele) < Date.parse(actif.cache.modele) ||
        (candidat.cache.modele === actif.cache.modele && candidat.cache.date < actif.cache.date))) return false;
    const changement = actif && actif.signature !== candidat.signature;
    actif = candidat;
    if (changement) self.postMessage({ type: "nouveau-modele" });
    return true;
}

function requete(options = {}) {
    return fetch(URL_ARCHIVE, { cache: "no-cache", signal: AbortSignal.timeout?.(60000), ...options });
}

async function actualiser() {
    // Un autre onglet a pu remplacer la copie pendant l'attente du verrou.
    await restaurer().catch(() => {});
    let reponse;
    if (actif) {
        const entete = await requete({ method: "HEAD" });
        if (!entete.ok) throw new Error("GitHub Pages : HTTP " + entete.status);
        const modification = entete.headers.get("Last-Modified");
        if (Number(entete.headers.get("Content-Length")) === actif.taille) {
            if (modification && modification === actif.modification) return;
            // Pages peut republier le même gzip, par exemple pour une mise à jour AROME-PI.
            const fin = await requete({ headers: { Range: `bytes=${actif.taille - 8}-${actif.taille - 1}` } });
            if (fin.status === 206 && await signatureGzip(await fin.blob()) === actif.signature) {
                actif.modification = modification;
                return;
            }
            if (fin.status === 200) reponse = fin; // Serveur ignorant la requête partielle.
        }
    }
    reponse ||= await requete();
    if (reponse.status !== 200) throw new Error("Archive GitHub Pages : HTTP " + reponse.status);
    const blob = await reponse.blob();
    if (blob.size > 16 * 1024 * 1024) throw new Error("Archive AROME trop volumineuse");
    const candidat = await preparer(blob, reponse.headers.get("Last-Modified"));
    if (!installer(candidat)) return;
    const entetes = { "X-Signature": candidat.signature };
    if (candidat.modification) entetes["Last-Modified"] = candidat.modification;
    try {
        const disque = await stockage;
        await disque?.put(URL_ARCHIVE, new Response(blob, { headers: entetes }));
    } catch (erreur) {
        console.warn("Cache AROME utilisable pour cette visite :", erreur.message);
    }
}

function verifier(forcer = false) {
    if (verification) return verification;
    if (!forcer && Date.now() < prochainControle) return Promise.resolve();
    prochainControle = Date.now() + INTERVALLE;
    verification = (navigator.locks
        ? navigator.locks.request(STOCKAGE, actualiser) : actualiser()
    ).catch(erreur => {
        prochainControle = Date.now() + 60000;
        throw erreur;
    }).finally(() => { verification = null; });
    return verification;
}

self.onmessage = async ({ data: { id, lat, lon, forcer } }) => {
    try {
        restauration ||= restaurer().catch(() => {});
        await restauration;
        if (actif) {
            void verifier(forcer).catch(e => console.warn("Copie AROME conservée :", e.message));
        } else {
            await verifier(forcer);
        }
        if (!actif) throw new Error("Archive AROME indisponible");
        const { cache, valeursMeteo } = actif;
        const resultat = calculerPrevisionsAromeNavigateur(cache, lat, lon);
        ajouterChampsMeteo(cache, resultat, lat, lon, champ => valeursMeteo.get(champ));
        self.postMessage({ id, resultat });
    } catch (erreur) {
        self.postMessage({ id, erreur: erreur.message });
    }
};

setInterval(() => {
    if (actif) void verifier(true).catch(e => console.warn("Copie AROME conservée :", e.message));
}, INTERVALLE);
