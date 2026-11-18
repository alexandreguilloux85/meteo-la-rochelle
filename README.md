# Météo La Rochelle

Site météo hébergé sur GitHub Pages. Render récupère directement les
observations de la station et l'image radar lorsqu'on ouvre la page ou utilise
les boutons d'actualisation. GitHub Actions télécharge les prévisions AROME et
les publie sur GitHub Pages.

## Actualisation des données

| Données | Fréquence | Source |
| --- | --- | --- |
| Observations de la station de La Rochelle | À l'ouverture, puis toutes les 6 minutes si la page est ouverte | API Météo-France appelée par Render |
| Radar | À l'ouverture, puis toutes les 10 minutes si la page est ouverte | Image générée par Render à partir de la mosaïque radar Météo-France |
| Prévisions AROME | 8 fois par jour, à `00:15`, `03:15`, `06:15`, `09:15`, `12:15`, `15:15`, `18:15` et `21:15` UTC | API WCS Météo-France |

Les contrôles périodiques dans le navigateur ne fonctionnent que tant que la
page reste ouverte. Les observations sont affichées dans l'ordre chronologique,
même si l'API renvoie les mesures les plus récentes en premier.

## Publication

Le workflow AROME publie son cache sur la branche `arome-data`. Le workflow
**Publish website** rassemble ce fichier avec `public/` et déploie l'ensemble
sur GitHub Pages. Les workflows de récupération observations et radar restent
déclenchables manuellement dans GitHub Actions, mais ne sont plus planifiés :
le site utilise directement Render pour ces deux sources.

Dans **Settings → Secrets and variables → Actions**, conserver les secrets
nécessaires aux téléchargements manuels et à AROME :

| Secret | Utilisation |
| --- | --- |
| `METEO_API_KEY` | Téléchargement manuel des observations |
| `METEO_RADAR_API_KEY` | Téléchargement manuel du radar |
| `METEO_AROME_API_KEY` | Téléchargement des prévisions AROME |

Dans **Settings → Pages**, sélectionner **GitHub Actions** comme source de
publication. Dans **Settings → Environments → github-pages**, autoriser la
branche `main` dans **Deployment branches and tags** ; sinon GitHub refusera le
déploiement même si le workflow se termine correctement.

## Déclenchement manuel depuis le site

Les boutons **Station de vent** et **Radar** appellent directement les API
Render et affichent les données retournées, sans lancer de workflow GitHub.
Le bouton **Prévisions AROME** demande à Render de déclencher le workflow GitHub
Actions; le jeton reste côté serveur et ne doit jamais être ajouté au site
statique. Les boutons sont publics : toute personne connaissant l'adresse peut
les appeler.

Configurer cette variable dans **Render → Environment** :

| Variable | Utilisation |
| --- | --- |
| `GITHUB_ACTIONS_TOKEN` | Jeton GitHub avec l'autorisation Actions: write sur ce dépôt |

Le service Render doit déployer la branche `main` et avoir les variables
`METEO_API_KEY` et `METEO_RADAR_API_KEY` configurées dans **Render → Environment**
pour les observations et le radar. Le déclenchement AROME refuse une nouvelle demande pendant qu'une
exécution est en attente/en cours et impose dix minutes entre deux lancements
manuels. La limite est vérifiée auprès de GitHub, elle reste donc active même
après la mise en veille ou le redémarrage de Render.

Le service Render gratuit peut être en veille : le premier appel peut alors
prendre du temps ou expirer pendant le réveil. Une fois le workflow AROME
terminé, le déploiement GitHub Pages se lance. Les prévisions AROME peuvent
prendre beaucoup plus longtemps que les observations ou le radar.
L'endpoint étant public, ces limites réduisent les déclenchements accidentels,
mais ne remplacent pas une authentification.

## Vérification manuelle

Dans l'onglet **Actions**, les observations et le radar peuvent toujours être
publiés manuellement avec **Publish weather observations** et **Publish radar
XYZ tiles**. Pour actualiser les prévisions, utiliser **Publish AROME cache**.
