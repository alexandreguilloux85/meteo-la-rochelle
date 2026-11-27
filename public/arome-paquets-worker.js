"use strict";

importScripts("arome-calcul-point.js");

const URL_ARCHIVE = "https://alexandreguilloux85.github.io/meteo-la-rochelle/arome-paquets-cache.json.gz";
const STOCKAGE = "meteo-lr-arome-paquets-v1";
const VERSION_VERIFICATION = "2";
const INTERVALLE = 30 * 60 * 1000;
let actif = null;
let restauration;
let verification;
let verificationEchouee = false;
let prochainControle = 0;
let minuteur;
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
    candidat.aRevalider = copie.headers.get("X-Version-Verification") !== VERSION_VERIFICATION;
    installer(candidat);
}

function installer(candidat) {
    if (actif && (Date.parse(candidat.cache.modele) < Date.parse(actif.cache.modele) ||
        (candidat.cache.modele === actif.cache.modele && candidat.cache.date < actif.cache.date))) return false;
    actif = candidat;
    return true;
}

function requete(url, options = {}, delai = 60000) {
    return fetch(url, { cache: "no-store", signal: AbortSignal.timeout?.(delai), ...options });
}

async function sonderArchive() {
    const entete = await requete(URL_ARCHIVE, { method: "HEAD" }, 5000);
    if (!entete.ok || Number(entete.headers.get("Content-Length")) !== actif.taille) return {};

    const modification = entete.headers.get("Last-Modified");
    if (modification && modification === actif.modification) return { identique: true };

    // Une republication de la page peut embarquer le même gzip.
    const fin = await requete(URL_ARCHIVE, { headers: {
        Range: `bytes=${actif.taille - 8}-${actif.taille - 1}`
    } }, 5000);
    if (fin.status === 206 && await signatureGzip(await fin.blob()) === actif.signature) {
        actif.modification = modification;
        return { identique: true };
    }
    if (fin.status === 200) return { reponse: fin };
    return {};
}

async function actualiser(demande, sauvegarder = true) {
    await restaurer().catch(() => {});
    let reponse;
    if (actif && !actif.aRevalider && !demande.forcee) {
        const sondage = await sonderArchive().catch(() => null);
        if (!demande.forcee) {
            if (sondage?.identique) return;
            reponse = sondage?.reponse;
        }
    }
    if (!reponse) {
        const url = new URL(URL_ARCHIVE);
        if (demande.forcee || actif?.aRevalider) {
            url.searchParams.set("actualisation", String(Date.now()));
        }
        reponse = await requete(url);
    }
    if (reponse.status !== 200) throw new Error("Archive GitHub Pages : HTTP " + reponse.status);
    const blob = await reponse.blob();
    if (blob.size > 16 * 1024 * 1024) throw new Error("Archive AROME trop volumineuse");
    const candidat = await preparer(blob, reponse.headers.get("Last-Modified"));
    if (!installer(candidat) || !sauvegarder) return;
    const entetes = { "X-Signature": candidat.signature, "X-Version-Verification": VERSION_VERIFICATION };
    if (candidat.modification) entetes["Last-Modified"] = candidat.modification;
    try {
        const disque = await stockage;
        await disque?.put(URL_ARCHIVE, new Response(blob, { headers: entetes }));
    } catch (erreur) {
        console.warn("Cache AROME utilisable pour cette visite :", erreur.message);
    }
}

function signalerVerification(signaturePrecedente, echec) {
    const changement = (signaturePrecedente && signaturePrecedente !== actif?.signature) ||
        verificationEchouee !== echec;
    verificationEchouee = echec;
    if (changement && actif) self.postMessage({ type: "cache-actualise" });
}

function verifier(forcer = false) {
    if (verification) {
        if (forcer) verification.forcee = true;
        return verification.promesse;
    }
    if (!forcer && Date.now() < prochainControle) return Promise.resolve();
    clearTimeout(minuteur);
    prochainControle = Date.now() + INTERVALLE;
    const signaturePrecedente = actif?.signature;
    const demande = { forcee: forcer };
    // Un autre onglet peut retenir le verrou. La lecture réseau et le calcul
    // local restent possibles, mais seul l'onglet qui l'obtient écrit le cache.
    const chargement = navigator.locks
        ? navigator.locks.request(STOCKAGE, { ifAvailable: true }, verrou => actualiser(demande, Boolean(verrou)))
        : actualiser(demande);
    demande.promesse = chargement.then(() => {
        signalerVerification(signaturePrecedente, false);
    }).catch(erreur => {
        prochainControle = Date.now() + 60000;
        signalerVerification(signaturePrecedente, true);
        throw erreur;
    }).finally(() => {
        verification = null;
        if (actif) minuteur = setTimeout(verifierEnArrierePlan, Math.max(0, prochainControle - Date.now()));
    });
    verification = demande;
    return demande.promesse;
}

function verifierEnArrierePlan() {
    void verifier().catch(e => console.warn("Copie AROME conservée :", e.message));
}

self.onmessage = async ({ data: { id, lat, lon, forcer } }) => {
    try {
        restauration ||= restaurer().catch(() => {});
        await restauration;
        if (actif && !forcer) {
            verifierEnArrierePlan();
        } else {
            try {
                await verifier(forcer);
            } catch (erreur) {
                if (!actif) throw erreur;
                console.warn("Copie AROME conservée :", erreur.message);
            }
        }
        if (!actif) throw new Error("Archive AROME indisponible");
        const { cache, valeursMeteo } = actif;
        const resultat = calculerPrevisionsAromeNavigateur(cache, lat, lon);
        ajouterChampsMeteo(cache, resultat, lat, lon, champ => valeursMeteo.get(champ));
        if (verificationEchouee) resultat.actualisation_statut = "echec";
        self.postMessage({ id, resultat });
    } catch (erreur) {
        self.postMessage({ id, erreur: erreur.message });
    }
};
