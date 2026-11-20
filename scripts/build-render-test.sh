#!/usr/bin/env bash
set -euo pipefail

# Pour les services Render qui décodent les paquets AROME GRIB2.
# Sur le runtime Node Render, Python 3 et pip sont disponibles.
npm ci
python3 -m pip install --no-cache-dir --target .arome-py -r requirements-arome.txt

# Valider les 106 fichiers de définition ecCodes déjà extraits dans Git.
# AUCUN téléchargement ni aucune décompression d'archive sur Render ;
# leur SHA256 collectif est vérifié avant de démarrer le décodeur.
python3 scripts/install-meteofrance-eccodes.py

# Valider les imports et la configuration effective ecCodes avant le lancement.
PYTHONPATH=.arome-py python3 -c 'import numpy; import eccodes; print("AROME ecCodes disponible")'
PYTHONPATH=.arome-py python3 -c 'import sys; sys.path.insert(0, ".github/scripts"); import arome_paquets_test; from eccodes import codes_definition_path; assert "vendor/meteofrance/definitions" in codes_definition_path(); print("AROME définitions Météo-France actives :", codes_definition_path())'
python3 -m py_compile .github/scripts/arome_paquets_test.py scripts/install-meteofrance-eccodes.py
echo "AROME décodeur Python et définitions Météo-France : validés"
