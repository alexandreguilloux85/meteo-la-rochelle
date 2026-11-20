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


## Essai AROME par paquets GRIB2 (branche Test_fonction)

Le pilote sans publication utilise l'API **Paquet AROME**, grille `0.025°`,
paquet de surface **SP1** et le groupe d'échéances **00H06H**.
Le script `.github/scripts/arome_paquets_test.py` décode les GRIB2 multi-messages
avec **ecCodes**, extrait les vents U/V à 10 m et, si identifié, la vitesse des
rafales. Le fichier produit conserve le format JSON du cache navigateur.
La zone test couvre approximativement le littoral Atlantique de la Bretagne
sud au Pays basque : `lat 43.2…48.3, lon -5.0…-0.3`. Elle est
modifiable dans le workflow.

**Lancer le test :** GitHub → Actions → `Test AROME zone étendue - paquets GRIB2`
→ Run workflow → branche `Test_fonction`. Ce workflow existait déjà sous
`test-arome-zone-etendue.yml` et peut donc être sélectionné pour une autre
branche. Le résultat est sauvegardé comme artefact
`arome-paquets-grib2-test`, sans publication sur `arome-data` ni sur le site.

**Authentification du pilote GRIB2 :** priorité au secret
`METEO_AROME_PAQUETS_APPLICATION_ID` (chaîne issue de « Authorization: Basic … »
dans le portail Météo-France, permettant de renouveler automatiquement un
jeton OAuth2). Alternativement, `METEO_AROME_PAQUETS_TOKEN` contient un jeton
Bearer déjà généré (souvent temporaire) ou `METEO_AROME_PAQUETS_API_KEY` une
clé d'API. Le test refuse désormais de réutiliser implicitement `METEO_AROME_API_KEY` :
la clé WCS est distincte des identifiants dédiés à l'API Paquets AROME.
Le pilote ne mélange plus les en-têtes `apikey` et `Authorization: Bearer`
dans une même requête. Ne jamais exposer ces secrets dans les logs ou le site.

En cas de `HTTP 401`, vérifier l'abonnement API **Paquet AROME** et le
type de secret utilisé. Le test rapporte une erreur d'authentification claire
sans afficher le secret.

**Étapes de validation avant bascule :**
- confirmer les identifiants GRIB2 des trois paramètres et les six échéances ;
- vérifier l'orientation des grilles et les valeurs manquantes ;
- comparer le vent/les rafales à quelques points avec les résultats WCS ;
- étendre ensuite au groupe complet des 51 échéances, mesurer les tailles du
  JSON réduit et choisir le mode de publication/cache approprié.

Le site conserve pour l'instant le système AROME actuel : **aucune migration
automatique de la production** n'est effectuée.


## Tester les paquets AROME directement sur Render test

**Branche :** `Test_fonction`, service `station-meteo-lr-test` uniquement.
Le pilote est désactivé sur le service de production (et n'est pas utilisé
par GitHub Pages). Il ne modifie ni le cache WCS ni le fichier publié sur
`arome-data`. Aucune mise à jour automatique n'est activée pour ce pilote.

### Préparer Render test

Dans **Render → station-meteo-lr-test → Settings → Build & Deploy** :

- Branche : `Test_fonction`
- Runtime : **Node** (ne pas le changer).
- **Build Command :** `bash scripts/build-render-test.sh`
- **Start Command :** `npm start` (inchangé)

Le script de build exécute `npm ci` puis installe `numpy` et `eccodes`
dans `.arome-py/`, un dossier privé au service et ignoré par Git.

**Si le statut indique `ModuleNotFoundError: No module named 'numpy'` :**
le service a pu démarrer sans avoir installé les bibliothèques Python.
Dans Render test, vérifier que le **Build Command** est exactement
`bash scripts/build-render-test.sh`, puis lancer **Manual Deploy → Clear
build cache & deploy**. Les logs du *build*, avant le démarrage de Node,
doivent contenir `AROME ecCodes disponible`. Si ce message manque,
la commande de build de ce service n'a pas exécuté le script prévu.
Le pilote effectue maintenant le contrôle des imports Python *avant*
de télécharger le GRIB2, pour éviter des appels API inutiles.

Dans **Render → Environment**, définir :

- **`METEO_AROME_PAQUETS_API_KEY` (recommandé) :** clé API longue
  durée générée dans « Paquet AROME → Générer Token → API Key ».
  Copier uniquement la clé, sans `apikey:`, sans `Bearer` ni
  guillemets. Le module Render test envoie l'en-tête HTTP `apikey`
  à Météo-France pour le catalogue **et les téléchargements GRIB2**.
  La clé est utilisée prioritairement si plusieurs secrets existent.
- **Alternative** `METEO_AROME_PAQUETS_APPLICATION_ID` : identifiant
  Basic pour générer un jeton OAuth2 renouvelable.
- **Alternative** `METEO_AROME_PAQUETS_TOKEN` : jeton Bearer déjà
  généré, valable généralement une heure.
- `AROME_REFRESH_TOKEN` : **secret différent** servant à autoriser la
  commande manuelle sur Render. Réutiliser celui déjà configuré sur le
  service test pour la mise à jour WCS. Ne pas confondre avec le Bearer
  Météo-France.

Il n'est pas nécessaire de recopier le jeton dans GitHub Actions pour tester
sur Render. Ne jamais exposer ces secrets dans le navigateur ou les commits.

### Déclencher un test protégé

Depuis un terminal Linux/macOS, après avoir placé son propre
`AROME_REFRESH_TOKEN` dans la variable shell du même nom :

```bash
curl --fail-with-body -X POST \
  https://station-meteo-lr-test.onrender.com/api/arome/paquets/test/refresh \
  -H "Authorization: Bearer $AROME_REFRESH_TOKEN"
```

La réponse HTTP **202** confirme le lancement, **pas sa réussite**.
Surveiller le résultat sans secret :

- `https://station-meteo-lr-test.onrender.com/api/arome/paquets/test/status`
- `https://station-meteo-lr-test.onrender.com/api/arome/paquets/test/previsions?lat=46.178&lon=-1.193167`

Le premier endpoint affiche les étapes (`authentification`, `catalogue`,
`telechargement`, `decodage_grib2`, `termine` ou `echec`), le modèle,
le nombre d'échéances et les tailles GRIB2/JSON. Le second calcule les vents
au point demandé seulement après la réussite du test.

Le déclenchement est limité à une exécution à la fois et à une demande
toutes les quatre minutes. Un redémarrage de Render vide le cache de test
en mémoire, sans affecter le cache WCS.

**Rafales AROME :** Météo-France nomme la vitesse de rafale maximale
sur une heure à 10 m `FF_RAF(10m)`, en **m/s**. Le paquet SP1 de
la grille `0.025°` fournit aussi `U_RAF(10m)` et `V_RAF(10m)`.
Dans les GRIB2, ecCodes peut les exposer sous les noms `gust`,
`efg10` et `nfg10` ou d'autres alias. Le décodeur reconnaît
désormais également les codes GRIB2 de rafales. Il privilégie la
vitesse `FF_RAF` directe ; si elle manque mais que les deux composantes
existent, il calcule `sqrt(U_RAF² + V_RAF²)`. Les journaux signalent
les rafales directes, reconstituées et manquantes. **Relancer le test**
après déploiement pour vérifier le résultat sur les vrais GRIB2.

**Mode initial du prototype (toujours disponible) :** un paquet
`0.025° SP1 00H06H`, six échéances **H+1 à H+6**,
rectangle lat. 43.2–48.3 / lon. -5.0–-0.3, U/V et rafales.
Le mode Render test étendu ci-dessous permet désormais 1, 3 ou 9 groupes
(soit H+6, H+18 ou H+51). Le GRIB2 est téléchargé **en flux**
avec limite de 120 Mo, décodé par le script Python déjà validé dans
GitHub Actions, puis le fichier temporaire est effacé. Le cache de test
est indépendant : il faut comparer ses valeurs au WCS avant d'envisager
les neuf groupes jusqu'à H+51.


### Essai étendu H+1 à H+51 (neuf groupes GRIB2)

Le pilote Render test choisit **un seul réseau AROME complet** dans le
catalogue SP1, puis télécharge les neuf groupes disponibles **successivement**
(aucune requête parallèle) :

| Groupe | Prévisions exploitées |
| --- | --- |
| `00H06H` | H+1 à H+6 (H+0 ignoré) |
| `07H12H` | H+7 à H+12 |
| `13H18H` | H+13 à H+18 |
| `19H24H` | H+19 à H+24 |
| `25H30H` | H+25 à H+30 |
| `31H36H` | H+31 à H+36 |
| `37H42H` | H+37 à H+42 |
| `43H48H` | H+43 à H+48 |
| `49H51H` | H+49 à H+51 |

Pour contrôler progressivement le coût du traitement, la route accepte
`?groupes=1`, `?groupes=3` ou `?groupes=9` (9 par défaut).
Exemple, après connexion et configuration de `AROME_REFRESH_TOKEN` :

```bash
# Test de 18 échéances H+1 à H+18
curl -sS -i -X POST \
  "https://station-meteo-lr-test.onrender.com/api/arome/paquets/test/refresh?groupes=3" \
  -H "Authorization: Bearer ${AROME_REFRESH_TOKEN}"

# Test complet (à effectuer après le test de trois groupes)
curl -sS -i -X POST \
  "https://station-meteo-lr-test.onrender.com/api/arome/paquets/test/refresh?groupes=9" \
  -H "Authorization: Bearer ${AROME_REFRESH_TOKEN}"
```

Le statut expose `groupes_total`, `groupes_termines`,
`groupe_actuel`, `echeances_recuperees`, `taille_grib_mo`,
`taille_cache_mo`, `taille_cache_gzip_mo`, la compression et les
éventuelles erreurs. Chaque groupe U/V/FF_RAF est vérifié avant fusion.
Le cache précédent reste accessible si un téléchargement échoue ; le
nouveau cache n'est publié en mémoire qu'après validation de toutes les
échéances du test choisi.

**Mesure du poids du cache :** Render construit un cache JSON identique
à la structure utilisée par le site et calcule sa version gzip
(`Content-Encoding: gzip`). L'adresse ci-dessous permet d'inspecter le
cache compressé lorsque le traitement s'est terminé :

`https://station-meteo-lr-test.onrender.com/api/arome/paquets/test/cache`

Le navigateur gère automatiquement le gzip ; avec `curl`, utiliser
`curl --compressed` pour décoder cette réponse.

**Comparaison avec WCS :** la route suivante rapproche les vitesses,
rafales et directions au même point GPS **et à date de prévision
strictement identique** :

`https://station-meteo-lr-test.onrender.com/api/arome/paquets/test/comparaison?lat=46.178&lon=-1.193167`

Les résultats indiquent les modèles utilisés, les dates communes,
les écarts de vitesse en m/s et l'écart angulaire en degrés. Si les
deux caches n'ont aucune date commune, aucune comparaison numérique
n'est prétendue. Cette route lit le cache WCS existant sans déclencher
un téléchargement WCS ni le modifier.

**Sécurité et fonctionnement :** la mise à jour complète reste
**manuelle sur Render test**, sans remplacer l'AROME WCS du site,
sans publier vers GitHub Pages et sans modifier la branche `main`.
Pour l'automatisation toutes les trois heures, utiliser
`METEO_AROME_PAQUETS_API_KEY` (clé longue durée) **ou**
`METEO_AROME_PAQUETS_APPLICATION_ID` (OAuth2 renouvelable).
La clé API n'a pas besoin de renouvellement horaire.
