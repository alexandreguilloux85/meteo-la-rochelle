#!/usr/bin/env bash
set -euo pipefail

# Pour le service station-meteo-lr-test uniquement.
# Sur le runtime Node Render, Python 3 et pip sont disponibles.
npm ci
python3 -m pip install --no-cache-dir --target .arome-py -r requirements-arome.txt

# Installer les tables GRIB2 Météo-France depuis leur jeu de données officiel
# (hors modèle de vagues). Une erreur de récupération stoppe ce déploiement
# plutôt que de publier une version qui prétend avoir les définitions.
python3 scripts/install-meteofrance-eccodes.py

# Valider les imports et la configuration effective ecCodes avant le lancement.
PYTHONPATH=.arome-py python3 -c 'import numpy; import eccodes; print("AROME ecCodes disponible")'
PYTHONPATH=.arome-py python3 -c 'import sys; sys.path.insert(0, ".github/scripts"); import arome_paquets_test; from eccodes import codes_definition_path; assert ".meteo-eccodes/definitions" in codes_definition_path(); print("AROME définitions Météo-France actives :", codes_definition_path())'
python3 -m py_compile .github/scripts/arome_paquets_test.py scripts/install-meteofrance-eccodes.py
echo "AROME décodeur Python et définitions Météo-France : validés"
