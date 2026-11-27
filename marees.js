const SITE = "la-rochelle-pallice";
const FUSEAU = "Europe/Paris";
const DELAI_REESSAI_MS = 15 * 60 * 1000;
const DATE_LOCALE = new Intl.DateTimeFormat("fr-FR", {
    timeZone: FUSEAU,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
});

function jourParis(instant) {
    const date = Object.fromEntries(
        DATE_LOCALE.formatToParts(instant).map(({ type, value }) => [type, value])
    );
    return `${date.year}-${date.month}-${date.day}`;
}

function decalerJour(jour, nombreDeJours) {
    const date = new Date(jour + "T00:00:00Z");
    date.setUTCDate(date.getUTCDate() + nombreDeJours);
    return date.toISOString().slice(0, 10);
}

async function appelerApi(ressource, cle, parametres) {
    const url = new URL(`https://api-maree.fr/${ressource}`);
    url.search = new URLSearchParams({ site: SITE, tz: FUSEAU, ...parametres });
    let reponse;
    try {
        reponse = await fetch(url, {
            headers: { accept: "application/json", authorization: `Bearer ${cle}` },
            redirect: "error",
            signal: AbortSignal.timeout(8000)
        });
    } catch {
        throw new Error("Connexion avec api-maree.fr impossible.");
    }
    if (!reponse.ok) {
        throw new Error(`api-maree.fr : HTTP ${reponse.status}`);
    }
    const contenu = await reponse.json().catch(() => null);
    if (!Array.isArray(contenu?.data)) {
        throw new Error("Réponse de marée invalide.");
    }
    return contenu.data;
}

async function chargerHauteurs(cle, hier, apresDemain) {
    const donnees = await appelerApi("water-levels", cle, {
        from: `${hier}T00:00`,
        to: `${apresDemain}T00:00`,
        step: "10"
    });
    const hauteurs = new Map();
    for (const mesure of donnees) {
        const { time, height } = mesure ?? {};
        if (typeof time === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(time) &&
            Number.isFinite(Date.parse(time)) && Number.isFinite(height)) {
            hauteurs.set(Date.parse(time), { time, height });
        }
    }
    if (hauteurs.size < 2) {
        throw new Error("Série de hauteurs de marée insuffisante.");
    }
    return [...hauteurs.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

async function chargerExtrema(cle, hier, demain) {
    const donnees = await appelerApi("tide-extrema", cle, { from: hier, to: demain });
    return donnees.flatMap(jour => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(jour?.date ?? "") || !Array.isArray(jour.extrema)) {
            return [];
        }
        return jour.extrema.flatMap(extremum => {
            const { time, type, height, coef } = extremum ?? {};
            if ((type !== "PM" && type !== "BM") ||
                !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time ?? "") || !Number.isFinite(height)) {
                return [];
            }
            return {
                date: jour.date, time, type, height,
                coef: Number.isFinite(coef) ? coef : undefined
            };
        });
    });
}

function obtenirDonnees(etat, charger, nom) {
    if (etat.donnees || Date.now() < etat.prochainEssai) {
        return etat.donnees;
    }
    etat.chargement ??= charger().then(donnees => {
        etat.donnees = donnees;
        return donnees;
    }).catch(erreur => {
        etat.prochainEssai = Date.now() + DELAI_REESSAI_MS;
        console.warn(`Marées ${nom} : ${erreur.message}`);
        return null;
    }).finally(() => {
        etat.chargement = null;
    });
    return etat.chargement;
}

function creerRouteMarees() {
    const cleHauteurs = process.env.API_MAREE_KEY?.trim();
    const cleExtrema = process.env.API_MAREE_EXTREMA_KEY?.trim() || cleHauteurs;
    let cache;

    return async (_req, res) => {
        res.set("Cache-Control", "no-store");
        if (!cleHauteurs) {
            return res.status(503).json({ erreur: "Le service de marée n’est pas configuré." });
        }

        const jour = jourParis(new Date());
        if (cache?.jour !== jour) {
            cache = { jour, hauteurs: {}, extrema: {} };
        }
        const hier = decalerJour(jour, -1);
        const demain = decalerJour(jour, 1);
        const apresDemain = decalerJour(jour, 2);
        const [hauteurs, extrema] = await Promise.all([
            obtenirDonnees(cache.hauteurs, () => chargerHauteurs(cleHauteurs, hier, apresDemain), "hauteurs"),
            obtenirDonnees(cache.extrema, () => chargerExtrema(cleExtrema, hier, demain), "pleines et basses mers")
        ]);

        if (!hauteurs) {
            return res.status(502).json({ erreur: "Les données de marée sont indisponibles." });
        }
        return res.json({ hauteurs, extrema: extrema ?? [] });
    };
}

module.exports = { creerRouteMarees };
