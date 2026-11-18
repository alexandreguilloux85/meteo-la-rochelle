# Météo La Rochelle

Site météo hébergé sur GitHub Pages. Render récupère directement les
observations de la station et sert à la demande les tuiles radar couvrant la
France entière. GitHub Actions télécharge les prévisions AROME et les publie
sur GitHub Pages.

## Actualisation des données

| Données | Fréquence | Source |
| --- | --- | --- |
| Observations de la station de La Rochelle | À l'ouverture, puis toutes les 6 minutes si la page est ouverte | API Météo-France appelée par Render |
| Radar | Vérifié à l'ouverture, puis toutes les 10 minutes si la page est ouverte | Tuiles XYZ nationales générées à la demande par Render |
| Prévisions AROME | 8 fois par jour, à `00:15`, `03:15`, `06:15`, `09:15`, `12:15`, `15:15`, `18:15` et `21:15` UTC | API WCS Météo-France |

Les contrôles périodiques dans le navigateur ne fonctionnent que tant que la
page reste ouverte. Les observations sont affichées dans l'ordre chronologique,
même si l'API renvoie les mesures les plus récentes en premier.

## Publication

Le workflow AROME publie son cache sur la branche `arome-data`. Le workflow
**Publish website** rassemble ce fichier avec `public/` et déploie l'ensemble
sur GitHub Pages. Les observations et le radar sont servis directement par
Render et ne lancent aucun workflow GitHub. Render garde le produit radar en
cache côté serveur et calcule les tuiles XYZ nationales à la demande. Les URLs
des tuiles incluent l'heure du produit pour permettre leur mise en cache côté
navigateur.

Dans **Settings → Secrets and variables → Actions**, configurer le secret :

| Secret | Utilisation |
| --- | --- |
| `METEO_AROME_API_KEY` | Téléchargement des prévisions AROME |

Dans **Settings → Pages**, sélectionner **GitHub Actions** comme source de
publication. Dans **Settings → Environments → github-pages**, autoriser la
branche `main` dans **Deployment branches and tags** ; sinon GitHub refusera le
déploiement même si le workflow se termine correctement.

## Déclenchement manuel depuis le site

Les boutons **Station de vent** et **Radar** appellent directement les API
Render; le bouton Radar vérifie le dernier produit national et recharge ses
tuiles, sans workflow GitHub. Le bouton **Prévisions AROME** demande à Render
de déclencher le workflow GitHub Actions; le jeton reste côté serveur et ne
doit jamais être ajouté au site statique. Les boutons sont publics : toute
personne connaissant l'adresse peut les appeler.

Dans **Render → Environment**, configurer les variables suivantes :

| Variable | Utilisation |
| --- | --- |
| `METEO_API_KEY` | Appels Météo-France pour les observations |
| `METEO_RADAR_API_KEY` | Téléchargement de la mosaïque radar |
| `GITHUB_ACTIONS_TOKEN` | Jeton GitHub avec l'autorisation Actions: write, utilisé uniquement pour AROME |

Le service Render doit déployer la branche `main`. Le déclenchement AROME refuse
une nouvelle demande tant qu'une exécution est en attente ou en cours et impose
un délai de dix minutes entre deux lancements manuels. Cette limite est vérifiée
auprès de GitHub et reste donc active même après la mise en veille ou le
redémarrage de Render.

Après un redémarrage de Render, le premier affichage du radar peut prendre plus
de temps, car le produit doit être téléchargé et lu. Les tuiles consultées sont
ensuite mises en cache côté serveur. Une fois le workflow AROME terminé, le
déploiement GitHub Pages se lance. L'endpoint de déclenchement AROME est public :
les limites réduisent les déclenchements accidentels, mais ne remplacent pas
une authentification.

## Vérification manuelle

Dans l'onglet **Actions**, lancer au besoin **Publish AROME cache**. Les
observations et les tuiles radar ne nécessitent plus de workflow GitHub.
