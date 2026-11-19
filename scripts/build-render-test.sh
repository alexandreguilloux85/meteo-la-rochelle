#!/usr/bin/env bash
set -euo pipefail

# Pour le service station-meteo-lr-test uniquement.
# Sur le runtime Node Render, Python 3 et pip sont disponibles.
npm ci
python3 -m pip install --no-cache-dir --target .arome-py -r requirements-arome.txt

# Valider les imports en reprenant exactement le chemin utilisé au runtime.
PYTHONPATH=.arome-py python3 -c 'import numpy; import eccodes; print("AROME ecCodes disponible")'
python3 -m py_compile .github/scripts/arome_paquets_test.py
echo "AROME décodeur Python : syntaxe valide"
