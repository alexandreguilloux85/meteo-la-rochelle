# Météo La Rochelle

Site météo hébergé sur GitHub Pages. Render récupère directement les
observations de la station et sert à la demande les tuiles radar couvrant la
France entière. Sur la branche `Test_fonction`, le navigateur calcule les
51 prévisions horaires au point sélectionné à partir du cycle publié sur GitHub Pages.
GitHub Actions sauvegarde les caches et publie le site sur GitHub Pages.

| Branche | Site | Service de données |
| --- | --- | --- |
| `main` | GitHub Pages et station-meteo-LR | `station-meteo-lr.onrender.com` |
| `Test_fonction` | station-meteo-LR-test | `station-meteo-lr-test.onrender.com` |

Chaque service Render prépare les cycles AROME et restaure sa propre sauvegarde.
GitHub Pages déploie `main` et publie le cycle GRIB2 validé de production.
L’interface de test peut lire cette archive depuis son propre domaine.

## Actualisation des données

| Données | Fréquence | Source |
| --- | --- | --- |
| Observations de la station de La Rochelle | À l'ouverture, puis toutes les 6 minutes si la page est ouverte | API Météo-France appelée par Render |
| Marée de La Rochelle-Pallice | Hauteur prévue recalculée chaque minute à partir des prévisions en cache | api-maree.fr appelée par Render |
| Radar | Vérifié à l'ouverture, puis toutes les 10 minutes si la page est ouverte | Tuiles XYZ nationales générées à la demande par Render |
| Prévisions AROME | Catalogue vérifié toutes les 30 minutes quand le service GRIB2 est actif | Paquets AROME de Météo-France sur Render, cache WCS en secours |

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
tuiles. Le bouton **Prévisions AROME** relit les prévisions au point choisi
et vérifie si un nouveau cycle GRIB2 est disponible. Le serveur
vérifie le catalogue AROME selon son propre cycle automatique.

Dans **Render → Environment**, configurer les variables suivantes :

| Variable | Utilisation |
| --- | --- |
| `METEO_API_KEY` | Appels Météo-France pour les observations |
| `METEO_RADAR_API_KEY` | Téléchargement de la mosaïque radar |
| `API_MAREE_KEY` | Accès à api-maree.fr pour la carte de marée sur `station-meteo-lr-test` |
| `API_MAREE_EXTREMA_KEY` | Facultative. Clé dédiée aux heures de pleine et basse mer si elles nécessitent une autre clé |
| `GITHUB_ACTIONS_TOKEN` | Jeton GitHub avec l'autorisation Actions: write, utilisé uniquement pour AROME |

Après un redémarrage de Render, le premier affichage du radar peut prendre plus
de temps, car le produit doit être téléchargé et lu. Les tuiles consultées sont
ensuite mises en cache côté serveur.

## Vérification manuelle

Dans l'onglet **Actions**, lancer au besoin **Publish AROME cache**. Les
observations et les tuiles radar ne nécessitent plus de workflow GitHub.


## Activer le GRIB2 en production

Chaque site Render propose une API de calcul au point sélectionné.
La frise de `Test_fonction` utilise cette API en secours. GitHub Pages
utilise `station-meteo-lr.onrender.com` pour les appels serveur. Si le
GRIB2 est indisponible ou si le clic est hors de sa zone, l'interface demande
le WCS au même service Render. Le cache WCS publié sur GitHub Pages permet
encore d'afficher le vent dans sa zone si Render ne peut pas répondre.
Une zone WCS calculée sur Render à la suite d'un clic peut servir localement.
La sauvegarde WCS publiée reste limitée aux caches qui couvrent La Rochelle.

Après un redémarrage, chaque service restaure sa sauvegarde GRIB2 depuis sa
branche de données GitHub, puis vérifie le catalogue. Un contrôle
réussi est renouvelé après 30 minutes et un modèle complet plus récent
déclenche le téléchargement des neuf groupes.

1. Après la fusion sur `main`, ouvrir **Render → station-meteo-lr → Settings**.
   Garder la branche `main` et le runtime Node. Configurer le **Build Command**
   `bash scripts/build-render-test.sh` et le **Start Command** `npm start`.
2. Dans **Environment**, ajouter `METEO_AROME_PAQUETS_API_KEY` et
   `AROME_PAQUETS_TEST_ENABLED=1`. Laisser l'actualisation automatique active
   (`AROME_PAQUETS_AUTO_REFRESH` absent ou différent de `0`), puis déployer.
   Les reconstructions manuelles sont protégées par `AROME_REFRESH_TOKEN` et
   utilisent les neuf groupes en production.
3. Vérifier le [statut GRIB2 de production](https://station-meteo-lr.onrender.com/api/arome/paquets/test/status).
   Attendre `cache_disponible: true`, `meteo_version: 2` ou une version
   supérieure, et `51` pour chacun des trois `champs_meteo`. Vérifier la
   frise de GitHub Pages sur un point dans la zone GRIB2, comme La Rochelle.
4. Pour sauvegarder les cycles, configurer `GITHUB_PAQUETS_PUBLISH_TOKEN`
   ou réutiliser `GITHUB_DATA_TOKEN` avec **Contents: Read and write**.
   Dans **Actions**, le workflow **Save AROME Paquets cache** permet de choisir
   le service dont le cycle doit être sauvegardé.

### Éviter les dépassements mémoire Render (512 Mio)

Le WCS n'est **pas supprimé** : son ancien cache et la route
`/api/arome/previsions` restent disponibles en secours, notamment si
GRIB2 est indisponible ou si le point demandé est hors de sa zone.
Toutefois, lorsque le pilote GRIB2 est activé
(`AROME_PAQUETS_TEST_ENABLED=1` ou service Render test),
les rafraîchissements **automatiques WCS** sont suspendus : ils ne doivent
plus doubler les traitements GRIB2 au démarrage ou sur keepalive.

Un verrou mémoire partagé `traitement-lourd.js` garantit qu'un seul
traitement lourd s'exécute à la fois **par instance Render** :
- renouvellement de la mosaïque radar nationale (ancien radar conservé
  pendant le téléchargement GRIB2) ;
- décodage des neuf paquets GRIB2 et compression du cache ;
- restauration et téléchargement WCS de secours lorsqu'aucun cache ne répond
  au point ;
- restauration initiale du gros cache gzip GRIB2 ;
- restauration, téléchargement et décodage des champs AROME-PI, ainsi que
  compression du cache du cycle complet.

Si le verrou est occupé, les caches déjà présents restent consultables.
AROME-PI libère le verrou partagé entre deux champs et le reprend pour
compresser le cycle. Les autres traitements peuvent démarrer pendant les pauses.
Le radar retourne son produit en cache et le contrôle GRIB2 est reporté
(au prochain passage, au plus tôt après une minute). Un appel manuel à
`/api/arome/paquets/test/refresh` retourne HTTP 409 s'il ne peut pas
démarrer. Le statut `/api/meteo/status` et le statut GRIB2 exposent
`traitement_lourd`, avec le nom de l'opération active.

La nouvelle compression du cache GRIB2 utilise un flux JSON heure par
heure vers gzip, au lieu de construire un grand `JSON.stringify(cache)`
puis une copie `Buffer.from`. Les mêmes limites de taille (45 Mo JSON,
16 Mo gzip) et le repli vent seul sont conservés. Cela réduit les pics
mémoire sans changer les 51 prévisions ni les icônes météo.

Aucune variable Render supplémentaire n'est nécessaire. Le WCS ne doit
pas être désactivé côté secrets : garder `METEO_AROME_API_KEY` pour un
éventuel repli. Cette coordination limite les pics mais n'offre pas une
garantie absolue de maintien sous 512 Mio : surveiller les mesures après
déploiement.

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

## Tester les paquets AROME directement sur Render test

**Branche :** `Test_fonction`, service `station-meteo-lr-test`.
Le service conserve son cycle validé sur disque temporaire pour servir l’API
de secours et le gzip de publication. La sauvegarde GRIB2 utilise
la branche `arome-paquets-test-data`. Les mises à jour automatiques du catalogue
sont actives par défaut.

### Préparer Render test

Dans **Render → station-meteo-lr-test → Settings → Build & Deploy** :

- Branche : `Test_fonction`
- Runtime : **Node** (ne pas le changer).
- **Build Command :** `bash scripts/build-render-test.sh`
- **Start Command :** `npm start` (inchangé)

Le script de build exécute `npm ci` puis installe `numpy` et `eccodes`
dans `.arome-py/`, un dossier privé au service et ignoré par Git.

**Tables officielles ecCodes Météo-France, conservées dans Git :**
l'archive officielle « Définition des gribs sauf les modèles de vague en
grib2 » a été téléchargée une seule fois par le workflow
[Copier definitions ecCodes Meteo-France dans Test_fonction](https://github.com/alexandreguilloux85/meteo-la-rochelle/actions/workflows/vendor-meteofrance-eccodes.yml)
et ajoutée directement à la branche `Test_fonction`.

Les définitions officielles sont maintenant **directement versionnées
sous forme de 106 fichiers déjà extraits**, aux côtés de l'archive originale :
- `vendor/meteofrance/definitions/` : fichiers de définition ecCodes GRIB1
  et GRIB2 prêts à être utilisés directement ;
- `vendor/meteofrance/eccodes-definitions.tar.gz` : archive officielle,
  conservée à titre de référence (516 951 octets) ;
- `vendor/meteofrance/manifest.json` : URL officielle, date de publication,
  SHA-256 de l'archive et **SHA-256 collectif des 106 fichiers**, attribution.

**Render n'a plus besoin de contacter data.gouv.fr, ni d'ouvrir ou décompresser
l'archive lors de chaque build.** Le script
`scripts/install-meteofrance-eccodes.py` vérifie uniquement le SHA-256
des fichiers déjà extraits. Le décodeur utilise directement
`vendor/meteofrance/definitions/`, placé **avant** le chemin standard ecCodes
dans `ECCODES_DEFINITION_PATH`. Les définitions standard restent en secours
et aucune copie dans un répertoire temporaire n'est nécessaire.

Pour mettre à jour volontairement la copie de l'archive, relancer le workflow
GitHub Actions de copie, qui effectue `--update-vendor` puis commit l'archive
et le manifeste. Le build Render reste complètement indépendant de la
disponibilité de data.gouv.fr. Source : [jeu de données officiel Météo-France](https://www.data.gouv.fr/datasets/definition-des-gribs-de-meteo-france),
**Licence Ouverte / Open Licence 2.0** (Météo-France, mise à jour du
30 janvier 2026). Si les fichiers extraits sont manquants ou corrompus, le nouveau
build échoue explicitement, sans activer des définitions non vérifiées.
Aucune variable d'environnement supplémentaire n'est nécessaire sur Render.

Le statut public `/api/arome/paquets/test/status` indique
`definitions_meteofrance_installees: true` lorsque les fichiers sont bien
présents sur le service déployé. Ce contrôle ne prouve pas à lui seul que
le champ `NEBUL` est décodé : il faut également contrôler
`champs_meteo.NEBUL_METEO` **après la construction d'un nouveau cache**.
Le décodeur n'attribue **jamais** un champ `unknown` à `NEBUL` sans code
ou nom GRIB2 explicitement reconnu.

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
toutes les quatre minutes. À chaque redémarrage, Render restaure le dernier
cycle sauvegardé depuis la branche de données du service.

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
Le cache précédent reste accessible si un téléchargement échoue. Le nouveau
cycle le remplace après validation de toutes les échéances du test choisi.

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

### Frise AROME au point cliqué sur le site de test

À la première ouverture, le navigateur télécharge le gzip du cycle de production
publié sur GitHub Pages. Il le garde dans le stockage du site et interpole les
51 heures dans un Web Worker. Un clic déplace la prévision. Un F5 reprend la
copie locale pendant que le navigateur vérifie la version en arrière-plan.
Le bouton **Prévisions AROME** et un contrôle toutes les 30 minutes permettent
de récupérer une nouvelle archive. Une mise à jour incomplète conserve le cycle
précédent. Si le navigateur a effacé les données du site, il retélécharge le gzip.

Si le calcul local est indisponible, le site essaie le cache propre à Render test
via `/api/arome/paquets/test/previsions`, puis le WCS. Render test sauvegarde
ses propres cycles dans `arome-paquets-test-data`.

**Actualisation automatique (Render test) :** à chaque démarrage, Render
restaure d'abord le cache depuis sa branche GitHub, puis vérifie le **catalogue
Météo-France**. Ensuite, le catalogue est contrôlé toutes les **30 minutes**
(surveillance par minuteur toutes les 2 minutes lorsque le serveur est
éveillé). Un nouveau cycle de **9 paquets** n'est téléchargé que lorsqu'un
**modèle plus récent avec les 9 groupes complets** est annoncé. Si le modèle
est identique, aucun GRIB2 n'est retéléchargé. En cas d'échec de contrôle
ou de téléchargement, un nouvel essai intervient au plus tôt 20 minutes
après ; **le dernier cache valide reste utilisable**. En veille, le service
gratuit n'exécute pas de tâche ; le contrôle reprend au réveil.

Le diagnostic `/api/arome/paquets/test/catalogue` donne les huit derniers
réseaux, les groupes manquants et le modèle complet le plus récent.
`/api/arome/paquets/test/status` expose désormais
`intervalle_controle_catalogue_minutes`, `dernier_controle_catalogue`,
`modele_catalogue_plus_recent`, `erreur_controle_catalogue` et
`prochaine_tentative`. Le téléchargement et la sauvegarde se déclenchent
lorsqu’un nouveau modèle complet est disponible.

La clé longue durée `METEO_AROME_PAQUETS_API_KEY` (ou l'identifiant
OAuth2 `METEO_AROME_PAQUETS_APPLICATION_ID`) doit être configurée dans
Render test. Pour désactiver l'automatisation durant un diagnostic,
définir `AROME_PAQUETS_AUTO_REFRESH=0`. Le POST de test avec
`AROME_REFRESH_TOKEN` reste disponible.

Les clés Météo-France sont configurées dans les services Render.

### Tableau de vent AROME Prévision Immédiate

Les deux tableaux suivent le même point choisi sur la carte. Le tableau
AROME-PI reprend la mise en forme de la frise. Chaque colonne affiche le vent
à 10 m, sa direction d'origine et la rafale maximale sur les 15 minutes
qui se terminent à l'échéance. La frise AROME-PI est vide en dehors
du rectangle 46,075°–46,300° N et 1,600°–1,050° O, qui englobe l'île de Ré,
La Rochelle et Aytré. Le serveur récupère 24 échéances de +15 min à +6 h
sur la grille AROME-PI à 0,025°. Il vérifie le nouveau cycle à partir de
la 35e minute, espace les téléchargements et conserve le dernier cycle
complet en cas de retard.

Sur chaque service Render, définir `METEO_AROME_PI_API_KEY` avec sa clé
autorisée pour [AROME Prévision Immédiate](https://portail-api.meteofrance.fr/web/fr/api/AROME-PI).
La route `GET /api/arome/pi/vent?lat=46.178&lon=-1.193167` donne les
prévisions au point ou l’état du premier chargement. GitHub Pages appelle
cette route sur `station-meteo-lr.onrender.com`. Le bouton **Prévisions AROME**
relit les deux frises.

Après validation de chaque cycle, Render signale le modèle et le SHA256 du
gzip à GitHub Actions avec `GITHUB_PAQUETS_PUBLISH_TOKEN` ou
`GITHUB_DATA_TOKEN`. Les branches de sauvegarde sont
`arome-pi-production-data` en production et `arome-pi-data` en test.
Chaque service relit la sienne au démarrage. GitHub Pages ne publie que le
gzip de production. Un cycle expiré est ignoré.

`GET /api/arome/pi/status` donne l'origine du cache et l'état de restauration
et de publication. `GET /api/arome/pi/cache` fournit le gzip du cycle actif
au workflow de sauvegarde.

## Sauvegardes du cache AROME GRIB2

Le même gzip sert à la restauration du service et au calcul des 51 prévisions
dans le navigateur de test. La copie locale du navigateur est propre à chaque
site et à chaque profil.

### Sauvegarde

Après validation d’un cycle complet de **neuf groupes (H+1 à H+51)**,
le workflow [Save AROME Paquets cache](https://github.com/alexandreguilloux85/meteo-la-rochelle/blob/main/.github/workflows/publish-arome-paquets-cache.yml)
télécharge le gzip depuis le service qui l’a signalé. Il vérifie sa
provenance, le SHA256, le modèle et les **51 échéances U/V/FF_RAF**.
La production sauvegarde sur `arome-paquets-data`, et le test sur
`arome-paquets-test-data`. Seul un cycle de production déclenche la
publication du gzip sur GitHub Pages.

Le fichier est disponible après publication à :
`https://alexandreguilloux85.github.io/meteo-la-rochelle/arome-paquets-cache.json.gz`

### Autorisation GitHub sur Render

Ajouter **`GITHUB_PAQUETS_PUBLISH_TOKEN`** dans
**Environment** sur chaque service Render : token GitHub finement limité au dépôt
`alexandreguilloux85/meteo-la-rochelle` avec la permission
**Contents: Read and write** (pour `repository_dispatch`).
Si `GITHUB_DATA_TOKEN` est déjà présent sur ce service avec les mêmes
permissions, il est utilisé comme solution de repli. Ne pas mettre
de token GitHub dans le JavaScript navigateur ni dans GitHub Pages.

Le statut public `/api/arome/paquets/test/status` expose
`publication_github` : `non_configuree`, `envoi`,
`demande_envoyee` ou `echec`.
`demande_envoyee` signifie seulement que GitHub a accepté le signal :
le résultat de la sauvegarde apparaît dans GitHub Actions.

### Restauration

À chaque redémarrage, Render charge le gzip depuis sa branche de sauvegarde
et contrôle la provenance, la zone, les 51 échéances
et l'interpolation. Sur le service de test, il conserve le gzip et une copie
organisée par échéance sur son disque temporaire. Le statut indique alors
`restauration_pages: reussie` et `stockage_cache: disque_temporaire`. Si le modèle est ancien,
le traitement des neuf paquets redémarre en arrière-plan, **sans retirer
le dernier cache restauré**. Si la sauvegarde est inaccessible ou le gzip
invalide, Render utilise l'actualisation automatique actuelle et le WCS
reste disponible en secours.

Aucune suppression manuelle n'est nécessaire pour les fichiers **actifs** :
un nouveau déploiement de Pages remplace le précédent. Chaque branche de
sauvegarde contient un seul commit et un seul fichier gzip à chaque mise à
jour. La réécriture de la branche ne purge pas
instantanément les objets Git inaccessibles ou les anciens artefacts
GitHub Actions, dont la conservation dépend de GitHub.

**Déploiement :** les deux workflows sont sur la branche `main` car
les événements `repository_dispatch` GitHub sont pris en compte sur
la branche par défaut.


## Frise météo AROME

La frise est le tableau des prévisions horaires AROME. Les fichiers
`public/frise-meteo.js` et `public/frise-meteo.css` en assurent
l'affichage indépendant : ils utilisent les **prévisions au point déjà
chargées** par `public/app.js`, sans nouvelle requête météo ni téléchargement
GRIB2 supplémentaire. Le calcul d'interpolation, le contenu du cache et
la restauration GitHub Pages ne sont **pas modifiés**.

### Règles des icônes météo (seuils propres au site)

| Priorité | Critère à l'heure H | Icône de jour | Icône de nuit |
| --- | --- | --- | --- |
| 1 | Précipitation horaire **≥ 0,2 mm** | Nuage + pluie | Nuage + pluie |
| 2 | Précipitation **< 0,2 mm** et nébulosité **< 25 %** | Soleil | Lune |
| 3 | Précipitation **< 0,2 mm** et nébulosité **≥ 25 % et < 65 %** | Soleil + nuage | Lune + nuage |
| 4 | Précipitation **< 0,2 mm** et nébulosité **≥ 65 %** | Nuage | Nuage |
| Secours | Précipitation ou nébulosité absente / invalide | — (inconnu) | — (inconnu) |

- La priorité est donnée à la pluie dès **0,2 mm sur l'heure**, quelle que
  soit la nébulosité. Au-dessous de cette limite, la couverture nuageuse
  détermine l'icône.
- Les limites de nuages sont **25 %** et **65 %** ; l'égalité appartient
  à la catégorie supérieure.
- La période jour/nuit est déterminée à partir de la date UTC de prévision
  et des coordonnées GPS choisies. Le seuil de hauteur apparente du Soleil
  est **−0,833°** (horizon apparent approximatif).
- Ces seuils sont des **choix d'affichage pour Météo La Rochelle** : ils ne
  constituent pas une transcription de seuils officiels Windy.
- Les icônes sont des **SVG originaux intégrés localement**, sans lien
  avec les fichiers d'images hébergés par Windy.

### Données nécessaires et compatibilité

Le décodage de **la prochaine récupération complète de neuf GRIB2**
sur Render test conserve maintenant, en complément des données de vent, les
grilles `T2M_METEO` (température à 2 m), `NEBUL_METEO` (nébulosité totale)
et `PRECIP_METEO` (précipitations cumulées) lorsqu'elles sont présentes.
Ces champs météo sont encodés avec des entiers signés sur 16 bits, à la
précision de 0,1 unité, puis compressés par `zlib` et encodés en Base64.
Les `missing values` AROME sont conservées comme valeurs absentes.
Le cache wind `U`, `V`, `RAFALE` et son interpolation existante ne changent pas.

L'API `/api/arome/paquets/test/previsions?lat=…&lon=…` fournit désormais
`temperature` (°C), `nebulosite` (%) et `precipitation` (mm pendant
l'heure écoulée) **uniquement pour le point GPS demandé**, en plus de
toutes les variables de vent antérieures. La pluie est obtenue soit
directement si le GRIB cumule sur H−1 à H, soit par différence des cumuls
0→H et 0→H−1. Si la période d'accumulation ou une valeur est inconnue,
la précipitation reste `null`, pas zéro.

### Actualisation et protection du fonctionnement existant

Les **anciens caches** publiés sur GitHub Pages restent restaurables ; la
frise utilise alors `—` pour les valeurs météo absentes et continue
d'afficher le vent. Au premier contrôle du catalogue suivant le nouveau
déploiement, Render reconstruira une fois le cache enrichi, **même si le
modèle complet disponible n'a pas changé**. La mise à niveau de
`meteo_version: 1` vers `2` déclenche aussi cette reconstruction.
Les contrôles suivants restent
à 30 minutes avec téléchargement uniquement lorsqu'un nouveau modèle
complet est disponible.

Le cache enrichi contient désormais `meteo_version: 2` (version intégrant
les définitions ecCodes officielles Météo-France) et le nombre de champs
par échéance dans `champs_meteo`. Le statut
`/api/arome/paquets/test/status` expose ces valeurs : **51 pour chaque
champ** signifie que les données SP1 ont été décodées pour les 51 heures.
Les encodages sont facultatifs, et si la taille totale dépasse les limites
existantes (45 Mo JSON ou 16 Mo gzip), le traitement garde le **cache de
vent seul** plutôt que de casser l'enregistrement sur GitHub Pages.
Le navigateur reçoit seulement les prévisions calculées au point demandé.

Pour afficher correctement les icônes, il faut donc disposer d'un cache
publié avec ses champs météo : faire seulement F5 avec un **ancien** cache
ne suffit pas.

Le vent et les rafales restent immédiatement exploitables : mêmes vitesses
en nœuds que précédemment, avec la palette `couleurVentWindy()` interpolée,
bornée à **`#F4F4F4` pour ≤ 5 kt** et **`#FF0097` pour ≥ 38 kt**.
Les couleurs de cellules sont interpolées entre les heures afin d'obtenir
le dégradé de type frise. La direction reprend l'orientation de flèche déjà
validée ; elle est dessinée par un SVG d'épaisseur 2,7 px.
Les heures sont affichées au format `11h`, sans minutes ni secondes, et
un trait horizontal de 2 px sépare les jours des heures.
