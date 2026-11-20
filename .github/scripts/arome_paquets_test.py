#!/usr/bin/env python3
"""Essai isolé : paquet GRIB2 AROME 0.025 SP1 -> cache local restreint."""
import base64
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import time
import zlib
from urllib.error import HTTPError
from urllib.parse import urlparse, parse_qs, urlencode
from urllib.request import Request, urlopen

import numpy as np
from eccodes import (
    codes_get, codes_get_values, codes_grib_new_from_file, codes_release,
    codes_definition_path, codes_set_definitions_path
)

# Définir en priorité les tables officielles Météo-France (installées au
# build Render test), tout en conservant les tables standard ecCodes.
# Le test GitHub Actions reste compatible sans le dossier optionnel.
DEFINITIONS_METEO_FRANCE = (
    Path(__file__).resolve().parents[2] / ".meteo-eccodes" / "definitions"
)
if (DEFINITIONS_METEO_FRANCE / "grib2").is_dir():
    definitions_standard = codes_definition_path()
    chemins = [str(DEFINITIONS_METEO_FRANCE)]
    chemins.extend(
        chemin for chemin in str(definitions_standard).split(os.pathsep)
        if chemin and chemin != str(DEFINITIONS_METEO_FRANCE)
    )
    codes_set_definitions_path(os.pathsep.join(chemins))
    os.environ["ECCODES_DEFINITION_PATH"] = os.pathsep.join(chemins)
    print("Définitions ecCodes Météo-France actives :", chemins[0], flush=True)
else:
    print("Définitions Météo-France absentes : ecCodes standard", flush=True)

ROOT = "https://public-api.meteofrance.fr/previnum/DPPaquetAROME/v1"
URL = ROOT + "/models/AROME/grids/0.025/packages/SP1"
# Clé API et jeton OAuth2 sont deux types d'identifiants différents.
API_KEY = os.getenv("METEO_AROME_PAQUETS_API_KEY")
TOKEN = os.getenv("METEO_AROME_PAQUETS_TOKEN")
APPLICATION_ID = os.getenv("METEO_AROME_PAQUETS_APPLICATION_ID")
OAUTH_TOKEN = None
BBOX = tuple(map(float, os.getenv("AROME_BBOX", "43.2,48.3,-5.0,-0.3").split(",")))
OUT = Path(os.getenv("AROME_OUTPUT", "arome-paquets-test"))
HEURE_DEBUT = int(os.getenv("AROME_HEURE_DEBUT", "1"))
HEURE_FIN = int(os.getenv("AROME_HEURE_FIN", "6"))
OUT.mkdir(parents=True, exist_ok=True)


def oauth_token():
    """Créer un vrai jeton temporaire depuis l'identifiant d'application."""
    global OAUTH_TOKEN
    if OAUTH_TOKEN:
        return OAUTH_TOKEN
    appid = APPLICATION_ID.removeprefix("Basic ").strip()
    request = Request(
        "https://portail-api.meteofrance.fr/token",
        data=urlencode({"grant_type": "client_credentials"}).encode(),
        headers={
            "Authorization": "Basic " + appid,
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json"
        },
        method="POST"
    )
    try:
        with urlopen(request, timeout=40) as response:
            body = json.load(response)
        OAUTH_TOKEN = body["access_token"]
        print("Jeton OAuth2 récupéré automatiquement.")
        return OAUTH_TOKEN
    except HTTPError as error:
        raise RuntimeError(
            "Échec OAuth2 HTTP " + str(error.code) +
            " : vérifier METEO_AROME_PAQUETS_APPLICATION_ID (secret Basic du portail)."
        ) from None


def nettoyer_token_bearer(secret):
    """Accepter les copies cURL sans révéler le secret dans les journaux."""
    token = secret.strip()
    if token.lower().startswith("authorization:"):
        token = token.split(":", 1)[1].strip()
    if token.lower().startswith("bearer "):
        token = token.split(None, 1)[1].strip()
    token = token.strip().strip(chr(39) + chr(34)).strip()
    if not token or any(char.isspace() for char in token):
        raise RuntimeError(
            "Jeton Bearer mal copié : valeur vide ou espaces/retours à la ligne internes. "
            "Copier uniquement le jeton après 'Authorization: Bearer'."
        )

    # Le jeton renvoyé par l'API est un JWT à trois segments.
    # Une ponctuation ajoutée à la fin de la copie crée un 3e point.
    # Ne jamais afficher le jeton, même partiellement.
    if token.startswith("eyJ") and token.count(".") != 2:
        raise RuntimeError(
            "Jeton JWT mal copié : deux points séparateurs attendus, "
            + str(token.count(".")) + " reçus. "
            "Vérifier l'absence de ponctuation après la signature."
        )
    if token.count(".") == 2:
        try:
            segment = token.split(".")[1]
            donnees = base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))
            expiration = json.loads(donnees).get("exp")
        except (ValueError, UnicodeError):
            expiration = None
        if isinstance(expiration, (int, float)):
            restant = int(expiration - time.time())
            print(
                "Expiration du jeton JWT :",
                datetime.fromtimestamp(expiration, tz=timezone.utc).isoformat(),
                "| temps restant :", restant // 60, "minutes"
            )
            if restant < 60:
                raise RuntimeError(
                    "Jeton Bearer déjà expiré ou expirant dans moins d'une minute. "
                    "Générer un nouveau jeton sur le portail Météo-France."
                )
    else:
        print("Jeton opaque : expiration impossible à vérifier localement.")
    return token


def identifiants():
    """Utiliser uniquement un secret dédié aux paquets AROME.

    Ne jamais réutiliser implicitement la clé WCS METEO_AROME_API_KEY.
    """
    if APPLICATION_ID:
        print("Authentification : METEO_AROME_PAQUETS_APPLICATION_ID (OAuth2)")
        return [("OAuth2 Bearer", "Authorization", "Bearer " + oauth_token())]
    if TOKEN:
        print("Authentification : METEO_AROME_PAQUETS_TOKEN (Bearer)")
        return [("Bearer", "Authorization", "Bearer " + nettoyer_token_bearer(TOKEN))]
    if API_KEY:
        print("Authentification : METEO_AROME_PAQUETS_API_KEY")
        key = API_KEY.strip()
        if key.lower().startswith("bearer "):
            return [("Bearer", "Authorization", "Bearer " + nettoyer_token_bearer(key))]
        return [("API key", "apikey", key)]
    raise RuntimeError(
        "Aucun identifiant Paquet AROME configuré. Définir "
        "METEO_AROME_PAQUETS_APPLICATION_ID (OAuth2 recommandé), "
        "METEO_AROME_PAQUETS_TOKEN ou METEO_AROME_PAQUETS_API_KEY. "
        "La clé WCS METEO_AROME_API_KEY n'est pas utilisée."
    )


def read(url, dest=None):
    if urlparse(url).hostname != "public-api.meteofrance.fr":
        raise ValueError("URL inattendue, domaine Météo-France requis")
    modes = identifiants()
    for position, (nom, entete, valeur) in enumerate(modes):
        headers = {
            entete: valeur, "Accept": "*/*",
            "User-Agent": "meteo-la-rochelle-paquets-test/1"
        }
        req = Request(url, headers=headers)
        try:
            with urlopen(req, timeout=120) as res:
                print("Authentification acceptée :", nom)
                if dest is None:
                    return json.loads(res.read(5 * 1024 * 1024))
                with dest.open("wb") as f:
                    size = 0
                    while chunk := res.read(1024 * 1024):
                        size += len(chunk)
                        if size > 180 * 1024 * 1024:
                            raise ValueError("GRIB2 supérieur à 180 Mo : arrêt du test")
                        f.write(chunk)
                    return size
        except HTTPError as error:
            if error.code == 401 and position < len(modes) - 1:
                print("HTTP 401 avec", nom, ": essai de l'autre mode.")
                continue
            if error.code == 401:
                raise RuntimeError(
                    "Météo-France refuse l'authentification (HTTP 401). "
                    "Vérifier l'identifiant Paquet AROME sélectionné dans le log, "
                    "sa validité et l'abonnement à cette API. "
                    "Pour un traitement automatique, utiliser "
                    "METEO_AROME_PAQUETS_APPLICATION_ID (OAuth2)."
                ) from None
            if error.code == 403:
                raise RuntimeError(
                    "Météo-France refuse l'accès (HTTP 403) : "
                    "vérifier l'abonnement à l'API Paquet AROME."
                ) from None
            raise RuntimeError(
                "Erreur HTTP " + str(error.code) + " lors du catalogue/téléchargement AROME."
            ) from None


def choisir():
    # Tester d'abord la route identique à celle qui a réussi en cURL.
    print("Catalogue AROME étape 1/4 : grilles")
    grilles = read(ROOT + "/models/AROME/grids")
    if not any(
        urlparse(lien.get("href", "")).path.endswith("/grids/0.025")
        for lien in grilles.get("links", [])
    ):
        raise ValueError("Grille AROME 0.025 absente du catalogue")

    print("Catalogue AROME étape 2/4 : paquets")
    paquets = read(ROOT + "/models/AROME/grids/0.025/packages")
    if not any(
        urlparse(lien.get("href", "")).path.endswith("/packages/SP1")
        for lien in paquets.get("links", [])
    ):
        raise ValueError("Paquet SP1 absent de la grille 0.025")

    print("Catalogue AROME étape 3/4 : réseaux SP1")
    runs = []
    for lien in read(URL).get("links", []):
        href = lien.get("href", "")
        reference = parse_qs(urlparse(href).query).get("referencetime", [None])[0]
        if reference:
            runs.append((reference, href))
    if not runs:
        raise ValueError("Aucun réseau AROME disponible dans SP1")

    print("Catalogue AROME étape 4/4 : échéances")
    for reference, href in sorted(runs, reverse=True):
        # L'API renvoie des liens sans /v1 même lorsqu'on appelle /v1.
        # Utiliser la route documentée et uniquement la référence du réseau.
        url = URL + "?" + urlencode({"referencetime": reference})
        for item in read(url).get("links", []):
            link = item.get("href", "")
            groupe = item.get("time") or parse_qs(urlparse(link).query).get("time", [None])[0]
            if groupe == "00H06H" and "grib2" in link.lower():
                # Le lien donné par le catalogue peut omettre /v1.
                # Reconstruire l'URL conforme à la documentation.
                params = parse_qs(urlparse(link).query)
                params["referencetime"] = [reference]
                params["time"] = ["00H06H"]
                params["format"] = ["grib2"]
                telechargement = URL + "/productARO?" + urlencode(params, doseq=True)
                return reference, telechargement
    raise ValueError("Aucun paquet SP1 00H06H GRIB2 trouvé dans les réseaux disponibles")


def prop(gid, name, default=None):
    try:
        return codes_get(gid, name)
    except Exception:
        return default


def classification(gid):
    """Identifier les vents existants et les trois champs SP1 météo optionnels.

    FF_RAF(10m) peut être 'gust' plutôt que '10fg'. Les codes GRIB2
    0.2.22/23/24 décrivent respectivement vitesse / U / V des rafales.
    """
    level = prop(gid, "level")
    typ = str(prop(gid, "typeOfLevel", "")).lower()
    short = str(prop(gid, "shortName", "")).lower()
    name = str(prop(gid, "name", "")).lower()
    discipline = prop(gid, "discipline")
    categorie = prop(gid, "parameterCategory")
    numero = prop(gid, "parameterNumber")

    # GRIB2 OMM : 0.0.0 température, 0.6.1 nébulosité totale,
    # 0.1.8 précipitations totales. Se limiter à T(2m) pour la température.
    if typ in ("heightaboveground", "hauteur") and level == 2 and (
        (discipline, categorie, numero) == (0, 0, 0) or
        short in ("2t", "t2m")
    ):
        return "T2M_METEO"
    if (discipline, categorie, numero) == (0, 6, 1) or (
        short in ("tcc", "nebul") or "total cloud cover" in name
    ):
        return "NEBUL_METEO"
    if (discipline, categorie, numero) == (0, 1, 8) or (
        short in ("tp", "precip") or "total precipitation" in name
    ):
        return "PRECIP_METEO"

    if level != 10 or typ not in ("heightaboveground", "hauteur"):
        return None

    # Les codes WMO sont indépendants de la version des tables de noms ecCodes.
    if discipline == 0 and categorie == 2:
        if numero == 22:
            return "RAFALE"
        if numero == 23:
            return "U_RAF"
        if numero == 24:
            return "V_RAF"

    if short in ("gust", "10fg", "fg10", "i10fg", "max_i10fg",
                 "ff_raf", "ff_raf(10m)") or (
        ("gust" in name or "rafale" in name) and
        not any(x in name for x in (
            "eastward", "northward", "u-component", "v-component",
            "zonal", "meridional"
        ))
    ):
        return "RAFALE"

    if short in ("efg10", "10efg", "max_efg10", "u_raf", "u_raf(10m)") or (
        ("gust" in name or "rafale" in name) and
        any(x in name for x in ("eastward", "u-component", "zonal"))
    ):
        return "U_RAF"
    if short in ("nfg10", "10nfg", "max_nfg10", "v_raf", "v_raf(10m)") or (
        ("gust" in name or "rafale" in name) and
        any(x in name for x in ("northward", "v-component", "meridional"))
    ):
        return "V_RAF"

    if short in ("10u", "u10", "u") or prop(gid, "paramId") == 165 or re.search(r"\bu.component\b", name):
        return "U"
    if short in ("10v", "v10", "v") or prop(gid, "paramId") == 166 or re.search(r"\bv.component\b", name):
        return "V"
    return None


# Champs météo intégralement facultatifs : format compact, sans changer
# la structure ni l'interpolation des grilles U, V et RAFALE existantes.
# Les octets sont des int16 little-endian avec facteur 10, -32768 = absent.
def encoder_meteo(gid, code, local, grille):
    unites = str(prop(gid, "units", "")).strip().lower()
    valeurs = np.array(local, dtype=np.float64, copy=True)
    if code == "T2M_METEO":
        if unites in ("k", "kelvin", "degrees k") or "kelvin" in unites:
            valeurs -= 273.15
        elif unites not in ("c", "°c", "degree celsius", "degc"):
            raise ValueError("Unité T2M inconnue : " + unites)
        valide = np.isfinite(valeurs) & (valeurs >= -100) & (valeurs <= 70)
    elif code == "NEBUL_METEO":
        if unites in ("1", "fraction", "0-1", "(0 - 1)"):
            valeurs *= 100
        elif unites in ("okta", "oktas", "octa", "octas"):
            valeurs *= 12.5
        elif unites in ("%", "percent", "percentage"):
            pass
        elif unites in ("unknown", "~", "", "undefined", "none"):
            # Si le champ a déjà été identifié comme NEBUL par son code
            # GRIB2, estimer l'échelle uniquement si son unité est inconnue.
            finies = valeurs[np.isfinite(valeurs) & (np.abs(valeurs) < 1e10)]
            if finies.size == 0:
                raise ValueError("NEBUL sans données valides")
            vmax = float(np.max(finies))
            if vmax <= 1.01:
                valeurs *= 100
                print("NEBUL local : fraction 0..1 convertie en %")
            elif vmax <= 8.01 and np.all(np.abs(finies - np.rint(finies)) < 0.01):
                # Niveaux entiers 0..8 : octas météorologiques.
                valeurs *= 12.5
                print("NEBUL local : 0..8 octas convertis en %")
            elif vmax <= 100.01:
                print("NEBUL local : valeurs 0..100 conservées en %")
            else:
                raise ValueError("Plage NEBUL inconnue : " + str(vmax))
        else:
            raise ValueError("Unité NEBUL inconnue : " + unites)
        valide = np.isfinite(valeurs) & (valeurs >= 0) & (valeurs <= 100.01)
    elif code == "PRECIP_METEO":
        if unites in ("m", "metre", "meter"):
            valeurs *= 1000.0
        elif unites not in ("kg m**-2", "kg m-2", "kg/m2", "mm", "kg m^-2"):
            raise ValueError("Unité PRECIP inconnue : " + unites)
        valide = np.isfinite(valeurs) & (valeurs >= -0.05) & (valeurs <= 2000)
    else:
        raise ValueError("Paramètre météo non supporté : " + code)
    # Masquer les missing values AROME au lieu de les convertir en météo.
    entier = np.full(valeurs.shape, -32768, dtype="<i2")
    if np.any(valide):
        entier[valide] = np.rint(np.maximum(valeurs[valide], 0)
            * 10).astype("<i2") if code == "PRECIP_METEO" else (
            np.rint(valeurs[valide] * 10).astype("<i2")
        )
    compresse = zlib.compress(entier.tobytes(order="C"), level=6)
    champ = {
        "grille": grille, "encodage": "zlib-base64-int16-v1",
        "donnees": base64.b64encode(compresse).decode("ascii")
    }
    if code == "PRECIP_METEO":
        debut = prop(gid, "startStep", None)
        try:
            champ["debut_cumul"] = int(debut) if debut is not None else None
        except (TypeError, ValueError):
            champ["debut_cumul"] = None
    return champ


def decoupe(gid):
    if prop(gid, "gridType") != "regular_ll":
        raise ValueError("Grille non régulière : " + str(prop(gid, "gridType")))
    if any(prop(gid, x, 0) for x in ("iScansNegatively", "jScansPositively", "alternativeRowScanning")):
        raise ValueError("Sens de balayage non géré")
    ni, nj = int(prop(gid, "Ni")), int(prop(gid, "Nj"))
    lat0 = float(prop(gid, "latitudeOfFirstGridPointInDegrees"))
    lon0 = float(prop(gid, "longitudeOfFirstGridPointInDegrees"))
    if lon0 > 180:
        lon0 -= 360
    dx = float(prop(gid, "iDirectionIncrementInDegrees"))
    dy = float(prop(gid, "jDirectionIncrementInDegrees"))
    if not (dx > 0 and dy > 0):
        raise ValueError("Résolution GRIB2 invalide")
    latmin, latmax, lonmin, lonmax = BBOX
    i0 = max(0, math.floor((lonmin - lon0) / dx) - 1)
    i1 = min(ni, math.ceil((lonmax - lon0) / dx) + 2)
    j0 = max(0, math.floor((lat0 - latmax) / dy) - 1)
    j1 = min(nj, math.ceil((lat0 - latmin) / dy) + 2)
    if i1 - i0 < 2 or j1 - j0 < 2:
        raise ValueError("Zone hors grille")
    grid = {
        "Ni": i1-i0, "Nj": j1-j0,
        "latitude_depart": round(lat0 - j0*dy, 7),
        "longitude_depart": round(lon0 + i0*dx, 7),
        "resolution_latitude": round(dy, 7),
        "resolution_longitude": round(dx, 7)
    }
    return (j0, j1, i0, i1), grid, (nj, ni)


def convertir(grib, run):
    forecast = {}
    descriptions = set()
    reference_grid = None
    count = 0
    with grib.open("rb") as stream:
        while gid := codes_grib_new_from_file(stream):
            try:
                count += 1
                code = classification(gid)
                hour = int(prop(gid, "endStep", -1))
                descriptions.add((
                    str(prop(gid, "shortName")), str(prop(gid, "name")),
                    str(prop(gid, "typeOfLevel")), str(prop(gid, "level")),
                    str(prop(gid, "stepRange")), str(code)
                ))
                if code is None or not HEURE_DEBUT <= hour <= HEURE_FIN:
                    continue
                optionnel = code in ("T2M_METEO", "NEBUL_METEO", "PRECIP_METEO")
                if optionnel:
                    # Le nouveau décodage doit rester une extension facultative.
                    # Même une grille météo illisible ne bloque pas U/V/RAFALE.
                    try:
                        bounds, grid, dims = decoupe(gid)
                        data = np.asarray(codes_get_values(gid), dtype=np.float64)
                        if data.size != dims[0] * dims[1]:
                            raise ValueError("Dimensions de grille météo invalides")
                        j0, j1, i0, i1 = bounds
                        local = data.reshape(*dims)[j0:j1, i0:i1]
                        champ = encoder_meteo(gid, code, local, grid)
                        step = forecast.setdefault(hour, {"seconde": hour*3600})
                        if code not in step:
                            step[code] = champ
                    except Exception as erreur:
                        print("Champ météo facultatif ignoré :",
                              code, "H+" + str(hour), str(erreur))
                    continue

                # Traitement éprouvé du vent : inchangé.
                bounds, grid, dims = decoupe(gid)
                if reference_grid and grid != reference_grid:
                    raise ValueError("Grille différente des autres champs")
                reference_grid = grid
                data = np.asarray(codes_get_values(gid), dtype=np.float64)
                if data.size != dims[0] * dims[1]:
                    raise ValueError("Dimensions du champ GRIB2 incohérentes")
                j0, j1, i0, i1 = bounds
                local = data.reshape(*dims)[j0:j1, i0:i1]
                if not np.isfinite(local).all() or np.any(np.abs(local) > 1e20):
                    raise ValueError("Valeurs absentes dans la zone : " + code)
                step = forecast.setdefault(hour, {"seconde": hour*3600})
                if code in step:
                    raise ValueError("Champ répété : " + code + " H+" + str(hour))
                step[code] = {"grille": grid, "valeurs": np.round(local, 2).ravel().tolist()}
            finally:
                codes_release(gid)
    print("Nombre de messages GRIB2 :", count)
    for desc in sorted(descriptions):
        print("Champ :", desc)
    print("Grille réduite :", reference_grid, "| échéances H+", HEURE_DEBUT, "à H+", HEURE_FIN)
    print("Champs météo compressés par paramètre :", {
        code: sum(code in p for p in forecast.values())
        for code in ("T2M_METEO", "NEBUL_METEO", "PRECIP_METEO")
    })
    rafales_directes = 0
    rafales_reconstruites = 0
    for hour in range(HEURE_DEBUT, HEURE_FIN + 1):
        step = forecast.get(hour, {})
        if "U" not in step or "V" not in step:
            raise ValueError("H+" + str(hour) + " : composantes U/V manquantes")

        if "RAFALE" in step:
            # FF_RAF(10m) est déjà une vitesse maximale en m/s.
            rafales_directes += 1
        elif "U_RAF" in step and "V_RAF" in step:
            # D'après Météo-France, FF_RAF = hypot(U_RAF, V_RAF).
            # Reconstruire uniquement si le champ FF_RAF direct est absent.
            u, v = step["U_RAF"], step["V_RAF"]
            if u["grille"] != v["grille"]:
                raise ValueError("Grilles U_RAF/V_RAF différentes H+" + str(hour))
            module = np.hypot(
                np.asarray(u["valeurs"], dtype=np.float64),
                np.asarray(v["valeurs"], dtype=np.float64)
            )
            step["RAFALE"] = {
                "grille": u["grille"],
                "valeurs": np.round(module, 2).tolist()
            }
            rafales_reconstruites += 1
        else:
            print("Avertissement : FF_RAF et composantes U_RAF/V_RAF absentes H+" + str(hour))
        # Ne pas conserver les composantes intermédiaires dans le JSON.
        step.pop("U_RAF", None)
        step.pop("V_RAF", None)
    print(
        "Rafales : FF_RAF directes =", rafales_directes,
        "| reconstruites avec U_RAF/V_RAF =", rafales_reconstruites,
        "| absentes =", HEURE_FIN - HEURE_DEBUT + 1 - rafales_directes - rafales_reconstruites
    )

    latmin, latmax, lonmin, lonmax = BBOX
    cache = {
        "modele": run,
        "date": int(time.time()*1000),
        "source": "AROME 0.025 SP1 GRIB2 ecCodes - essai",
        "zone": {
            "centreLat": (latmin+latmax)/2, "centreLon": (lonmin+lonmax)/2,
            "latMin": latmin, "latMax": latmax,
            "lonMin": lonmin, "lonMax": lonmax
        },
        "previsions": [forecast[h] for h in sorted(forecast)],
        "erreurs": []
    }
    path = OUT / "arome-cache-paquets-test.json"
    path.write_text(json.dumps(cache, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    print("Cache test généré :", path, round(path.stat().st_size/1048576, 2), "Mo")


def main():
    if len(BBOX) != 4 or not (BBOX[0] < BBOX[1] and BBOX[2] < BBOX[3]):
        raise ValueError("AROME_BBOX attendu : latMin,latMax,lonMin,lonMax")
    if not (1 <= HEURE_DEBUT <= HEURE_FIN <= 51):
        raise ValueError("AROME_HEURE_DEBUT/FIN invalides : attendu H+1 à H+51")
    # Mode Render test : le serveur Node a déjà téléchargé le fichier GRIB2.
    # Le script ne contacte alors pas Météo-France et ne manipule aucun secret.
    chemin_local = os.getenv("AROME_GRIB_LOCAL")
    if chemin_local:
        run = os.getenv("AROME_MODELE_LOCAL")
        if not run:
            raise ValueError("AROME_MODELE_LOCAL manquant")
        file = Path(chemin_local)
        if not file.is_file() or file.stat().st_size < 16:
            raise ValueError("Fichier GRIB2 local absent ou vide")
        print("AROME décodage local :", run, "zone :", BBOX)
        convertir(file, run)
        return

    run, url = choisir()
    print("AROME réseau :", run, "zone :", BBOX)
    file = OUT / "temporaire-sp1.grib2"
    print("Téléchargement d'un seul paquet SP1 00H06H :",
          round(read(url, file)/1048576, 2), "Mo")
    try:
        convertir(file, run)
    finally:
        file.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
