# Architecture météo sans workflows planifiés

## Objectif

Aucun workflow GitHub Actions planifié n'est nécessaire pour actualiser les données.
Le seul workflow automatique nécessaire est `Publish website`, déclenché par
une modification du site sur `main` ou par une demande de déploiement envoyée
par Render après publication d'un nouveau cache AROME.

## Circulation des données

- **Radar** : Render récupère la mosaïque Météo-France, la conserve en mémoire et
  sert `/api/radar/metadata` et `/api/radar/tiles/{z}/{x}/{y}.png` aux navigateurs.
  Le cache des PNG et celui des coordonnées géographiques sont limités en taille.
  Aucune publication de tuiles sur GitHub n'est requise.
- **Observations** : `/api/observations` garde les mesures pendant cinq minutes
  sur Render et conserve le dernier résultat si l'API Météo-France échoue.
  Le navigateur possède son propre cache de secours.
- **AROME** : le serveur Render consulte le WCS (temporairement, avant migration
  envisagée vers DPPaquetAROME), télécharge et décode les échéances puis ne
  valide que **51 échéances avec U, V et rafales**. Le dernier cache complet
  reste accessible depuis `arome-data` et GitHub Pages.
- **NAS** : `GET /api/keepalive` répond immédiatement et vérifie les données
  sans attente de leur téléchargement. Un verrou évite les opérations AROME
  simultanées.

## Configuration obligatoire sur Render

Sur **le service Render réellement utilisé par GitHub Pages** :

- `METEO_API_KEY` : observations (DPPaquetObs).
- `METEO_RADAR_API_KEY` : radar (DPRadar).
- `METEO_AROME_API_KEY` : AROME (WCS pour l'instant).
- `GITHUB_DATA_TOKEN` : jeton GitHub à portée **limitée au dépôt
  `alexandreguilloux85/meteo-la-rochelle`**, autorisation **Contents: read/write**.
  Ne jamais placer le jeton dans `public/` ou dans le code du dépôt.
  Le serveur accepte aussi l'ancienne variable `GITHUB_ACTIONS_TOKEN`,
  si elle possède les autorisations de lecture et écriture des contenus.

Après validation du modèle AROME, Render écrit `arome-cache.json` à la racine
de la branche `arome-data` par l'API GitHub Contents, puis envoie
`repository_dispatch` avec l'événement `arome-cache-updated`.
Seul le workflow `Publish website` est déclenché pour assembler les fichiers
publics et le cache AROME. Aucun cron GitHub n'est nécessaire.

**Important :** au moment de cette migration, le frontend hébergé par GitHub
Pages utilise encore le backend `https://station-meteo-lr-test.onrender.com`.
Vérifier que le NAS réveille précisément ce service, ou décider explicitement
de basculer le frontend vers le service de production. Les deux services Render
gratuits ne doivent pas être maintenus inutilement éveillés en permanence.

## Vérifications

1. `GET https://station-meteo-lr-test.onrender.com/api/meteo/status` :
   `arome.publication_configuree` doit être `true`; les dates de vérification
   et du produit radar doivent se renseigner après un appel keepalive réussi.
2. `GET /api/radar/metadata` et
   `GET /api/radar/tiles/{z}/{x}/{y}.png` doivent répondre avec des tuiles
   PNG valides pour les coordonnées existantes.
3. `GET /api/observations` doit retourner un tableau JSON de mesures.
4. Après détection d'un nouveau modèle complet, vérifier le commit de
   `arome-data`, puis un déclenchement `repository_dispatch` de
   `Publish website` et la nouvelle date du fichier
   `https://alexandreguilloux85.github.io/meteo-la-rochelle/arome-cache.json`.

Le statut ne divulgue pas les clés API ni le jeton GitHub. Si
`publication_configuree` vaut `false`, aucune nouvelle prévision ne sera
publiée sur GitHub Pages, même si le serveur parvient à la calculer.

Les anciens workflows radar et AROME restent disponibles uniquement en
`workflow_dispatch` pour des diagnostics ou un dépannage manuel, sans
`schedule`.

## Limites et repli

Render gratuit utilise un stockage éphémère : après un redémarrage,
le radar est reconstruit depuis Météo-France et AROME peut relire le dernier
cache publié sur Pages. Une vérification ou un calcul peuvent échouer :
dans ce cas, conserver le dernier jeu valide ; ne jamais publier un AROME partiel.

L'API DPPaquetAROME est la prochaine évolution envisagée. Elle ne fait pas
partie de cette migration.
