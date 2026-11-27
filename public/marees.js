(() => {
    "use strict";

    const FUSEAU = "Europe/Paris";
    const SEUIL = 4.5;
    const MINUTE = 60 * 1000;
    const HEURE = 60 * MINUTE;
    const PAS_HAUTEURS = 10 * MINUTE;
    const DELAI_ACTUALISATION = 15 * MINUTE;
    const DELAI_NOUVEL_ESSAI = 2 * MINUTE;
    const BLEU = "#1677b8";
    const ROUGE = "#b82034";
    const formatJour = new Intl.DateTimeFormat("fr-FR", {
        timeZone: FUSEAU, year: "numeric", month: "2-digit", day: "2-digit"
    });
    const formatHeure = new Intl.DateTimeFormat("fr-FR", {
        timeZone: FUSEAU, hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    });
    const formatDate = new Intl.DateTimeFormat("fr-FR", {
        timeZone: FUSEAU, weekday: "short", day: "numeric", month: "short"
    });
    const formatHauteur = new Intl.NumberFormat("fr-FR", {
        minimumFractionDigits: 2, maximumFractionDigits: 2
    });
    const texteHauteur = hauteur => `${formatHauteur.format(hauteur)} m`;

    function jourParis(instant) {
        const parts = Object.fromEntries(formatJour.formatToParts(instant).map(({ type, value }) => [type, value]));
        return `${parts.year}-${parts.month}-${parts.day}`;
    }

    function heureArrondie(instant) {
        return Math.round(instant / MINUTE) * MINUTE;
    }

    function interpolerHauteur(points, instant) {
        const droite = points.findIndex(point => point.x >= instant);
        if (droite < 0) return null;
        const fin = points[droite];
        if (fin.x === instant) return fin.y;
        const debut = points[droite - 1];
        if (!debut || fin.x - debut.x > PAS_HAUTEURS) return null;
        return debut.y + (fin.y - debut.y) * (instant - debut.x) / (fin.x - debut.x);
    }

    function normaliserMarees(donnees) {
        const valeurs = new Map();
        const decalages = new Set();
        for (const { time, height } of donnees.hauteurs ?? []) {
            const instant = Date.parse(time);
            const decalage = typeof time === "string" && time.match(/(?:[+-]\d{2}:\d{2}|Z)$/)?.[0];
            if (!decalage || !Number.isFinite(instant) || !Number.isFinite(height)) continue;
            valeurs.set(instant, height);
            decalages.add(decalage);
        }
        const points = Array.from(valeurs, ([x, y]) => ({ x, y })).sort((a, b) => a.x - b.x);

        const extrema = [];
        for (const { date, time, type, height, coef } of donnees.extrema ?? []) {
            if (!["PM", "BM"].includes(type) || !Number.isFinite(height)) continue;
            const candidats = Array.from(decalages, decalage => Date.parse(`${date}T${time}:00${decalage}`))
                .filter(instant => Number.isFinite(instant) &&
                    jourParis(instant) === date && formatHeure.format(instant) === time)
                .map(x => {
                    const estimee = interpolerHauteur(points, x);
                    return { x, ecart: estimee === null ? Infinity : Math.abs(estimee - height) };
                })
                .sort((a, b) => a.ecart - b.ecart);
            // À l'heure d'hiver, départager les deux heures locales à partir de la courbe.
            if (candidats.length) extrema.push({ x: candidats[0].x, y: height, type, coef });
        }
        extrema.sort((a, b) => a.x - b.x);
        return { points, extrema };
    }

    function calculerFranchissements(points) {
        const franchissements = [];
        let precedent = null;
        let horsSeuil = null;
        let debutAuSeuil = null;
        for (const point of points) {
            if (precedent && point.x - precedent.x > PAS_HAUTEURS) {
                horsSeuil = null;
                debutAuSeuil = null;
            }
            precedent = point;
            if (point.y === SEUIL) {
                debutAuSeuil ??= point.x;
                continue;
            }
            const monte = point.y > SEUIL;
            if (horsSeuil && monte !== (horsSeuil.y > SEUIL)) {
                const x = debutAuSeuil ?? (horsSeuil.x + (point.x - horsSeuil.x) *
                    (SEUIL - horsSeuil.y) / (point.y - horsSeuil.y));
                franchissements.push({ x, monte });
            }
            horsSeuil = point;
            debutAuSeuil = null;
        }
        return franchissements;
    }

    function calculerCycle({ points, extrema }, instant) {
        if (instant < points[0].x || instant > points.at(-1).x) return null;
        const bassesMers = extrema.filter(point => point.type === "BM").map(point => point.x);
        const minima = points.filter((point, index) => {
            const avant = points[index - 1];
            const apres = points[index + 1];
            return avant && apres && point.x - avant.x <= PAS_HAUTEURS &&
                apres.x - point.x <= PAS_HAUTEURS && point.y < avant.y && point.y <= apres.y &&
                !bassesMers.some(x => Math.abs(point.x - x) <= 2 * PAS_HAUTEURS);
        });
        const bornes = bassesMers.concat(minima.map(point => point.x)).sort((a, b) => a - b);
        const debut = bornes.findLast(x => x <= instant) ?? Math.max(points[0].x, instant - 6 * HEURE);
        const fin = bornes.find(x => x > instant) ?? Math.min(points.at(-1).x, instant + 6 * HEURE);
        const visibles = points.filter(point => point.x >= debut && point.x <= fin);
        for (const x of [debut, fin]) {
            if (visibles.some(point => point.x === x)) continue;
            const y = interpolerHauteur(points, x);
            if (y === null) continue;
            if (x === debut) visibles.unshift({ x, y });
            else visibles.push({ x, y });
        }
        if (visibles.length < 2) return null;
        return {
            debut,
            fin,
            points: visibles,
            extrema: extrema.filter(point => point.x >= debut && point.x <= fin),
            franchissements: calculerFranchissements(visibles),
            actuel: { x: instant, y: interpolerHauteur(points, instant) }
        };
    }

    function dessinerEtiquette(ctx, zone, x, y, texte, couleur, fond) {
        const hauteur = 19;
        ctx.font = "bold 11px Arial, sans-serif";
        const largeur = ctx.measureText(texte).width + 10;
        const gauche = Math.max(zone.left, Math.min(x - largeur / 2, zone.right - largeur));
        const haut = Math.max(zone.top, Math.min(y, zone.bottom - hauteur));
        ctx.fillStyle = fond;
        ctx.fillRect(gauche, haut, largeur, hauteur);
        ctx.fillStyle = couleur;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(texte, gauche + largeur / 2, haut + hauteur / 2);
    }

    function creerGraphique(canvas, lireCycle) {
        const cycleInitial = lireCycle();
        const reperes = {
            id: "reperesMaree",
            beforeDraw({ ctx, chartArea, scales: { y } }) {
                const hauteur = lireCycle()?.actuel.y;
                if (!chartArea || !Number.isFinite(hauteur)) return;
                const { left, right, top, bottom } = chartArea;
                const surface = y.getPixelForValue(hauteur);
                const zero = y.getPixelForValue(0);
                const haut = Math.max(top, Math.min(surface, zero));
                ctx.save();
                ctx.fillStyle = "#d6eafb";
                ctx.fillRect(left, haut, right - left, Math.min(bottom, Math.max(surface, zero)) - haut);
                ctx.restore();
            },
            beforeDatasetsDraw({ ctx, chartArea: { left, right, top, bottom }, scales: { x, y } }) {
                const cycle = lireCycle();
                if (!cycle) return;
                const seuil = y.getPixelForValue(SEUIL);
                const present = x.getPixelForValue(cycle.actuel.x);
                ctx.save();
                ctx.strokeStyle = ROUGE;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(left, seuil);
                ctx.lineTo(right, seuil);
                ctx.stroke();

                ctx.strokeStyle = BLEU;
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.moveTo(present, top);
                ctx.lineTo(present, bottom);
                ctx.stroke();
                ctx.restore();
            },
            afterDatasetsDraw({ ctx, chartArea, scales: { x, y } }) {
                const cycle = lireCycle();
                if (!cycle) return;
                const { actuel, franchissements } = cycle;
                const seuil = y.getPixelForValue(SEUIL);
                ctx.save();
                dessinerEtiquette(ctx, chartArea, chartArea.right, seuil - 9, texteHauteur(SEUIL), "#fff", ROUGE);
                for (const { x: temps, monte } of franchissements) {
                    const abscisse = x.getPixelForValue(temps);
                    ctx.fillStyle = ROUGE;
                    ctx.beginPath();
                    ctx.arc(abscisse, seuil, 3.5, 0, 2 * Math.PI);
                    ctx.fill();
                    dessinerEtiquette(ctx, chartArea, abscisse, seuil + (monte ? -27 : 8),
                        formatHeure.format(heureArrondie(temps)), "#56360b", "#ffebb0");
                }
                const present = x.getPixelForValue(actuel.x);
                if (actuel.y !== null) {
                    ctx.fillStyle = BLEU;
                    ctx.strokeStyle = "#fff";
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.arc(present, y.getPixelForValue(actuel.y), 5, 0, 2 * Math.PI);
                    ctx.fill();
                    ctx.stroke();
                }
                dessinerEtiquette(ctx, { ...chartArea, top: 0, bottom: chartArea.top }, present,
                    chartArea.top - 21, "Maintenant", "#fff", BLEU);
                ctx.restore();
            }
        };

        return new window.Chart(canvas, {
            type: "line",
            data: {
                datasets: [{
                    label: "Hauteur d’eau prévue",
                    data: cycleInitial.points,
                    borderColor: BLEU,
                    borderWidth: 2.5,
                    spanGaps: PAS_HAUTEURS,
                    pointRadius: 0,
                    pointHoverRadius: 4
                }]
            },
            options: {
                parsing: false,
                animation: false,
                maintainAspectRatio: false,
                layout: { padding: { top: 26, right: 4 } },
                interaction: { mode: "nearest", axis: "x", intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        displayColors: false,
                        callbacks: {
                            title: ([{ raw }]) => `${formatDate.format(raw.x)} · ${formatHeure.format(raw.x)}`,
                            label: ({ raw }) => texteHauteur(raw.y)
                        }
                    }
                },
                scales: {
                    x: {
                        type: "linear",
                        min: cycleInitial.debut,
                        max: cycleInitial.fin,
                        afterBuildTicks(echelle) {
                            const ticks = [];
                            for (let value = Math.ceil(echelle.min / HEURE) * HEURE; value <= echelle.max; value += HEURE) {
                                ticks.push({ value });
                            }
                            echelle.ticks = ticks;
                        },
                        ticks: { callback: value => formatHeure.format(value), maxTicksLimit: 8, maxRotation: 0 }
                    },
                    y: {
                        suggestedMin: 0,
                        suggestedMax: Math.ceil(SEUIL + 0.5),
                        ticks: { stepSize: 1, callback: value => `${value} m` }
                    }
                }
            },
            plugins: [reperes]
        });
    }

    function ajouterHoraire(liste, libelle, instant, jour, details = "") {
        const item = document.createElement("li");
        const titre = document.createElement("span");
        const heure = document.createElement("time");
        titre.textContent = libelle;
        heure.dateTime = new Date(instant).toISOString();
        heure.textContent = (jourParis(instant) === jour ? "" : `${formatDate.format(instant)} · `) + formatHeure.format(instant);
        item.append(titre, " ", heure, details);
        liste.append(item);
    }

    window.initialiserMarees = function initialiserMarees(url) {
        const canvas = document.getElementById("graphMaree");
        if (!canvas) return;
        const hauteur = document.getElementById("mareeActuelle");
        const heure = document.getElementById("mareeHeure");
        const statut = document.getElementById("mareeStatut");
        const details = document.getElementById("mareeDetails");
        const listeFranchissements = document.getElementById("mareeFranchissements");
        const listeExtrema = document.getElementById("mareeExtrema");
        let donnees = null;
        let cycle = null;
        let graphique = null;
        let jourDemande;
        let derniereDemande = -Infinity;
        let chargement = false;
        let echec = false;

        function afficher(message) {
            if (statut.textContent !== message) statut.textContent = message;
        }

        function actualiserAffichage(instant, jour) {
            cycle = donnees && calculerCycle(donnees, instant);
            const hauteurActuelle = cycle?.actuel.y ?? null;
            hauteur.textContent = hauteurActuelle === null ? "—" : texteHauteur(hauteurActuelle);
            heure.hidden = hauteurActuelle === null;
            if (hauteurActuelle === null) {
                heure.textContent = "";
                heure.removeAttribute("datetime");
            } else {
                heure.textContent = `À ${formatHeure.format(instant)}`;
                heure.dateTime = new Date(instant).toISOString();
            }
            details.hidden = !cycle;
            if (!cycle) {
                afficher(echec ? "Prévisions de marée indisponibles." :
                    donnees ? "Aucune prévision de marée pour cette heure." : "Chargement des prévisions de marée…");
                return;
            }
            if (!window.Chart) afficher("Le graphique de marée est indisponible.");
            else if (hauteurActuelle === null) afficher("Hauteur prévue indisponible à cette heure.");
            else if (echec) afficher("Actualisation indisponible. Dernières prévisions affichées.");
            else afficher("");

            listeFranchissements.replaceChildren();
            for (const { x, monte } of cycle.franchissements) {
                ajouterHoraire(listeFranchissements, monte ? "À la montée" : "À la descente", heureArrondie(x), jour);
            }
            if (!cycle.franchissements.length) {
                const item = document.createElement("li");
                item.textContent = "Aucun franchissement calculé sur la période affichée.";
                listeFranchissements.append(item);
            }
            listeExtrema.replaceChildren();
            for (const { x, y, type, coef } of cycle.extrema) {
                const libelle = type === "PM" ? "Pleine mer" : "Basse mer";
                const coefficient = Number.isFinite(coef) ? ` · coef. ${coef}` : "";
                ajouterHoraire(listeExtrema, libelle, x, jour, ` · ${texteHauteur(y)}${coefficient}`);
            }
            if (!cycle.extrema.length) {
                const item = document.createElement("li");
                item.textContent = "Horaires de pleine et basse mer indisponibles.";
                listeExtrema.append(item);
            }

            if (!window.Chart) return;
            if (!graphique) {
                graphique = creerGraphique(canvas, () => cycle);
                return;
            }
            graphique.data.datasets[0].data = cycle.points;
            graphique.options.scales.x.min = cycle.debut;
            graphique.options.scales.x.max = cycle.fin;
            graphique.update("none");
        }

        async function actualiser() {
            const instant = Date.now();
            const jour = jourParis(instant);
            actualiserAffichage(instant, jour);
            const delai = echec ? DELAI_NOUVEL_ESSAI : DELAI_ACTUALISATION;
            if (chargement || (jourDemande === jour && instant - derniereDemande < delai)) return;
            chargement = true;
            derniereDemande = instant;
            jourDemande = jour;
            try {
                const reponse = await fetch(url, { signal: AbortSignal.timeout?.(30000) });
                if (!reponse.ok) throw new Error("Prévisions de marée indisponibles.");
                const nouvelles = normaliserMarees(await reponse.json());
                if (nouvelles.points.length < 2) throw new Error("Prévisions de marée incomplètes.");
                donnees = nouvelles;
                echec = false;
            } catch {
                echec = true;
            } finally {
                chargement = false;
            }
            const nouveau = Date.now();
            actualiserAffichage(nouveau, jourParis(nouveau));
        }

        actualiser();
        setInterval(actualiser, MINUTE);
        document.addEventListener("visibilitychange", () => {
            if (!document.hidden) actualiser();
        });
    };
})();
