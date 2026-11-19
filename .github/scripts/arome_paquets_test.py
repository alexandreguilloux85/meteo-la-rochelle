#!/usr/bin/env python3
"""Essai isolé : paquet GRIB2 AROME 0.025 SP1 -> cache local restreint."""
import json
import math
import os
from pathlib import Path
import re
import time
from urllib.parse import urlparse, parse_qs
from urllib.request import Request, urlopen

import numpy as np
from eccodes import codes_get, codes_get_values, codes_grib_new_from_file, codes_release

ROOT = "https://public-api.meteofrance.fr/previnum/DPPaquetAROME/v1"
URL = ROOT + "/models/AROME/grids/0.025/packages/SP1"
KEY = os.getenv("METEO_AROME_PAQUETS_API_KEY") or os.getenv("METEO_AROME_API_KEY")
BBOX = tuple(map(float, os.getenv("AROME_BBOX", "43.2,48.3,-5.0,-0.3").split(",")))
OUT = Path("arome-paquets-test")
OUT.mkdir(exist_ok=True)


def read(url, dest=None):
    if urlparse(url).hostname != "public-api.meteofrance.fr":
        raise ValueError("URL inattendue, domaine Météo-France requis")
    if not KEY:
        raise ValueError("Secret METEO_AROME_PAQUETS_API_KEY ou METEO_AROME_API_KEY absent")
    token = KEY.removeprefix("Bearer ").strip()
    req = Request(url, headers={
        "apikey": token, "Authorization": "Bearer " + token,
        "Accept": "*/*", "User-Agent": "meteo-la-rochelle-paquets-test/1"
    })
    with urlopen(req, timeout=120) as res:
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


def choisir():
    runs = []
    for link in read(URL).get("links", []):
        url = link.get("href", "")
        run = parse_qs(urlparse(url).query).get("referencetime", [None])[0]
        if run:
            runs.append((run, url))
    for run, link in sorted(runs, reverse=True):
        for element in read(link).get("links", []):
            href = element.get("href", "")
            group = element.get("time") or parse_qs(urlparse(href).query).get("time", [None])[0]
            if group == "00H06H" and "grib2" in href.lower():
                return run, href
    raise ValueError("Aucun paquet SP1 00H06H trouvé dans le catalogue")


def prop(gid, name, default=None):
    try:
        return codes_get(gid, name)
    except Exception:
        return default


def classification(gid):
    level = prop(gid, "level")
    typ = str(prop(gid, "typeOfLevel", ""))
    if level != 10 or typ != "heightAboveGround":
        return None
    short = str(prop(gid, "shortName", "")).lower()
    name = str(prop(gid, "name", "")).lower()
    if "gust" in name or "rafale" in name or "raf" in short or "gust" in short:
        return "RAFALE" if ("speed" in name or "vitesse" in name or short in ("10fg","fg10","ff_raf")) else None
    if short in ("10u","u10","u") or prop(gid, "paramId") == 165 or re.search(r"\bu.component\b", name):
        return "U"
    if short in ("10v","v10","v") or prop(gid, "paramId") == 166 or re.search(r"\bv.component\b", name):
        return "V"
    return None


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
                if code is None or not 1 <= hour <= 6:
                    continue
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
    print("Grille réduite :", reference_grid)
    for hour in range(1, 7):
        if "U" not in forecast.get(hour, {}) or "V" not in forecast.get(hour, {}):
            raise ValueError("H+" + str(hour) + " : composantes U/V manquantes")
        if "RAFALE" not in forecast[hour]:
            print("Avertissement : rafale absente H+" + str(hour))

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
