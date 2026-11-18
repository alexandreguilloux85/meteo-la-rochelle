# Météo La Rochelle

Site météo statique hébergé sur GitHub Pages. GitHub Actions télécharge les
données auprès de Météo-France, les publie sur des branches de données, puis
redéploie le site. Aucun serveur backend n'est nécessaire.

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
`Test_fonction` comme branche par défaut, nécessaire au déclenchement des
workflows planifiés.

Dans **Settings → Secrets and variables → Actions**, configurer les secrets
suivants :

| Secret | Utilisation |
| --- | --- |
| `METEO_API_KEY` | Téléchargement des observations |
| `METEO_RADAR_API_KEY` | Téléchargement du radar |
| `METEO_AROME_API_KEY` | Téléchargement des prévisions AROME |

Dans **Settings → Pages**, sélectionner **GitHub Actions** comme source de
publication.

## Vérification manuelle

Dans l'onglet **Actions**, lancer au besoin **Publish weather observations** ou
**Publish radar XYZ tiles** avec **Run workflow**. Vérifier ensuite que
l'exécution et le déploiement **Publish website** se terminent avec succès.
