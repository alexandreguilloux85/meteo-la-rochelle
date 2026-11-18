# Météo La Rochelle

Site météo hébergé sur GitHub Pages. GitHub Actions télécharge les données
auprès de Météo-France, les publie sur des branches de données, puis redéploie
le site. Render sert uniquement d'intermédiaire pour les boutons de
téléchargement manuel.

## Actualisation des données

| Données | Fréquence | Source |
| --- | --- | --- |
| Observations de la station de La Rochelle | Toutes les 6 minutes (`*/6`) | API Météo-France, observations infra-horaires |
| Radar | Toutes les 10 minutes (`*/10`) | Mosaïque radar Météo-France, tuiles XYZ |
| Prévisions AROME | 8 fois par jour, à `00:15`, `03:15`, `06:15`, `09:15`, `12:15`, `15:15`, `18:15` et `21:15` UTC | API WCS Météo-France |

GitHub peut toutefois retarder ou ignorer une exécution planifiée en période de
forte charge.

À l'ouverture ou au rechargement de la page, le navigateur vérifie les dernières
observations et les métadonnées radar publiées. Il vérifie ensuite les
observations toutes les 6 minutes et le radar toutes les 10 minutes. Les
observations sont affichées dans l'ordre chronologique, même si l'API renvoie
les mesures les plus récentes en premier.

## Publication

Les workflows publient leurs résultats sur les branches `observations-data`,
`radar-data` et `arome-data`. Le workflow **Publish website** rassemble ces
fichiers avec `public/` et déploie l'ensemble sur GitHub Pages. Le dépôt utilise
`main` comme branche par défaut : les tâches planifiées et le déploiement Pages
partent de cette branche.

Dans **Settings → Secrets and variables → Actions**, configurer les secrets
suivants :

| Secret | Utilisation |
| --- | --- |
| `METEO_API_KEY` | Téléchargement des observations |
| `METEO_RADAR_API_KEY` | Téléchargement du radar |
| `METEO_AROME_API_KEY` | Téléchargement des prévisions AROME |

Dans **Settings → Pages**, sélectionner **GitHub Actions** comme source de
publication. Dans **Settings → Environments → github-pages**, autoriser la
branche `main` dans **Deployment branches and tags** ; sinon GitHub refusera le
déploiement même si le workflow se termine correctement.

## Déclenchement manuel depuis le site

Les boutons d'actualisation appellent le service Render, qui déclenche le
workflow GitHub Actions sélectionné, sans code à saisir. Le jeton GitHub reste
côté serveur et ne doit jamais être ajouté au site statique. Ces boutons sont
publics : toute personne connaissant l'adresse peut les appeler.

Configurer cette variable dans **Render → Environment** :

| Variable | Utilisation |
| --- | --- |
| `GITHUB_ACTIONS_TOKEN` | Jeton GitHub avec l'autorisation Actions: write sur ce dépôt |

Le service Render doit déployer la branche `main` pour inclure cet endpoint.
Chaque workflow refuse une nouvelle demande pendant qu'une exécution est en
attente/en cours et impose dix minutes entre deux lancements manuels. La limite
est vérifiée auprès de GitHub, elle reste donc active même après la mise en
veille ou le redémarrage de Render.

Le service Render gratuit peut être en veille : le premier appel peut alors
prendre du temps ou expirer pendant le réveil. Une fois le workflow déclenché,
le déploiement GitHub Pages se lance après sa réussite. Les prévisions AROME
peuvent prendre beaucoup plus longtemps que les observations ou le radar.
L'endpoint étant public, ces limites réduisent les déclenchements accidentels,
mais ne remplacent pas une authentification.

## Vérification manuelle

Dans l'onglet **Actions**, lancer au besoin **Publish weather observations** ou
**Publish radar XYZ tiles** avec **Run workflow**. Vérifier ensuite que
l'exécution et le déploiement **Publish website** se terminent avec succès.
