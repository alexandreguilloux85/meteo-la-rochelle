
let graphiqueVent = null;
let graphiqueDirection = null;

// Conversion m/s vers noeuds
function noeuds(valeur) {
    return valeur * 1.94384;
}

// Conversion degrés vers points cardinaux
function directionTexte(degres) {
    const directions = [
        "N", "NE", "E", "SE",
        "S", "SO", "O", "NO"
    ];

    return directions[Math.round(degres / 45) % 8];
}

// Création des graphiques
function creerGraphiques(donnees) {

    const labels = donnees.map(d =>
        new Date(d.date).toLocaleTimeString("fr-FR", {
            hour: "2-digit",
            minute: "2-digit"
        })
    );

    const vent = donnees.map(d => noeuds(d.ff));

    const rafales = donnees.map(d =>
        Number.isFinite(d.raf10) ? noeuds(d.raf10) : null
    );

    const direction = donnees.map(d => d.dd);

    // Suppression des anciens graphiques
    if (graphiqueVent) graphiqueVent.destroy();
    if (graphiqueDirection) graphiqueDirection.destroy();

    // Graphique vitesse du vent et rafales
    graphiqueVent = new Chart(
        document.getElementById("graphVent"),
        {
            type: "line",

            data: {
                labels: labels,

                datasets: [
                    {
                        label: "Vent moyen",
                        data: vent,
                        borderColor: "#1677b8",
                        backgroundColor: "#1677b820",
                        fill: true,
                        tension: 0.3,
                        pointRadius: 2,
                        pointHoverRadius: 6
                    },
                    {
                        label: "Rafales",
                        data: rafales,
                        borderColor: "#e67e22",
                        backgroundColor: "#e67e2220",
                        fill: false,
                        tension: 0.3,
                        pointRadius: 2,
                        pointHoverRadius: 6,
                        spanGaps: false
                    }
                ]
            },

            options: {
                responsive: true,
                maintainAspectRatio: false,

                interaction: {
                    mode: "index",
                    intersect: false
                },

                plugins: {
                    tooltip: {
                        enabled: true,
                        callbacks: {
                            title: function(items) {
                                return "Heure : " + items[0].label;
                            },
                            label: function(item) {
                                if (item.parsed.y === null) {
                                    return item.dataset.label + " : --";
                                }

                                return item.dataset.label + " : " +
                                    item.parsed.y.toFixed(1) + " kt";
                            }
                        }
                    },
                    legend: {
                        display: true,
                        position: "top"
                    }
                },

                scales: {
                    x: {
                        title: {
                            display: true,
                            text: "Heure"
                        }
                    },

                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: "Vitesse (nœuds)"
                        }
                    }
                }
            }
        }
    );

    // Graphique direction du vent
    graphiqueDirection = new Chart(
        document.getElementById("graphDirection"),
        {
            type: "line",

            data: {
                labels: labels,

                datasets: [
                    {
                        label: "Direction du vent",
                        data: direction,
                        borderColor: "#27ae60",
                        backgroundColor: "#27ae6020",
                        fill: false,
                        tension: 0.2,
                        pointRadius: 2,
                        pointHoverRadius: 6
                    }
                ]
            },

            options: {
                responsive: true,
                maintainAspectRatio: false,

                interaction: {
                    mode: "index",
                    intersect: false
                },

                plugins: {
                    tooltip: {
                        callbacks: {
                            label: function(item) {
                                return "Direction : " +
                                    item.parsed.y + "°";
                            }
                        }
                    }
                },

                scales: {
                    x: {
                        title: {
                            display: true,
                            text: "Heure"
                        }
                    },

                    y: {
                        min: 0,
                        max: 360,
                        title: {
                            display: true,
                            text: "Direction (°)"
                        }
                    }
                }
            }
        }
    );
}

// Mise à jour de la flèche
function afficherDirection(degres) {

    const fleche = document.getElementById("flecheDirection");
    const texte = document.getElementById("texteDirection");

    if (!Number.isFinite(degres)) {
        texte.textContent = "--";
        return;
    }

    // La direction météo indique d'où vient le vent.
    // On ajoute 180° pour pointer dans le sens où il souffle.
    const directionSouffle = (degres + 180) % 360;

    fleche.style.transform =
        `rotate(${directionSouffle}deg)`;

    texte.textContent =
        "Souffle vers " + directionTexte(directionSouffle);
}

// Chargement des données météo
async function chargerDonnees() {

    try {

        const reponse = await fetch("/api/observations");

        if (!reponse.ok) {
            throw new Error("Erreur API : " + reponse.status);
        }

        const resultat = await reponse.json();

        // Récupération des relevés
        const lignes = Array.isArray(resultat)
            ? resultat
            : resultat.features || resultat.data || [];

        if (!Array.isArray(lignes) || lignes.length === 0) {
            throw new Error("Aucun relevé trouvé dans la réponse API");
        }

        // Extraction des données
        const donnees = lignes
            .map(item => {

                const d = item.properties || item;

                return {
                    date: d.validity_time,
                    ff: d.ff == null ? null : Number(d.ff),
                    raf10: d.raf10 == null ? null : Number(d.raf10),
                    dd: d.dd == null ? null : Number(d.dd)
                };

            })
            .filter(d =>
                d.date &&
                Number.isFinite(new Date(d.date).getTime()) &&
                Number.isFinite(d.ff)
            )
            .sort((a, b) =>
                new Date(a.date) - new Date(b.date)
            );

        if (donnees.length === 0) {
            throw new Error("Aucune donnée météo exploitable");
        }

        // Dernier relevé
        const dernier = donnees[donnees.length - 1];

        // Affichage du vent moyen
        document.getElementById("ventActuel").textContent =
            noeuds(dernier.ff).toFixed(1) + " kt";

        // Affichage des rafales
        document.getElementById("rafaleActuelle").textContent =
            Number.isFinite(dernier.raf10)
                ? noeuds(dernier.raf10).toFixed(1) + " kt"
                : "-- kt";

        // Affichage de la direction
        if (Number.isFinite(dernier.dd)) {

            document.getElementById("directionActuelle").textContent =
                dernier.dd.toFixed(0) + "° " +
                directionTexte(dernier.dd);

            afficherDirection(dernier.dd);
        }

        // Filtrage des dernières 24 heures
        const maintenant = Date.now();
        const limite = maintenant - 24 * 60 * 60 * 1000;

        const donnees24h = donnees.filter(d => {
            const temps = new Date(d.date).getTime();
            return temps >= limite && temps <= maintenant;
        });

        if (donnees24h.length === 0) {
            throw new Error("Aucune donnée disponible sur les dernières 24 h");
        }

        // Mise à jour des graphiques
        creerGraphiques(donnees24h);

        // Mise à jour du tableau
        const tableau = document.getElementById("tableau");

        tableau.innerHTML = donnees
            .slice()
            .reverse()
            .map(d => `
                <tr>
                    <td>${new Date(d.date).toLocaleString("fr-FR")}</td>
                    <td>${noeuds(d.ff).toFixed(1)}</td>
                    <td>
                        ${Number.isFinite(d.raf10)
                            ? noeuds(d.raf10).toFixed(1)
                            : "--"}
                    </td>
                    <td>
                        ${Number.isFinite(d.dd)
                            ? d.dd.toFixed(0) + "° " + directionTexte(d.dd)
                            : "--"}
                    </td>
                </tr>
            `)
            .join("");

        // Date du dernier relevé
        document.getElementById("miseAJour").textContent =
            "Dernier relevé : " +
            new Date(dernier.date).toLocaleString("fr-FR");

        console.log("Nombre de relevés :", donnees.length);
        console.log("Relevés sur 24 h :", donnees24h.length);
        console.log("Dernière rafale (m/s) :", dernier.raf10);

    } catch (erreur) {

        console.error(erreur);

        document.getElementById("miseAJour").textContent =
            "Erreur : " + erreur.message;
    }
}

// Premier chargement
chargerDonnees();

// Actualisation automatique toutes les 6 minutes
setInterval(chargerDonnees, 6 * 60 * 1000);
