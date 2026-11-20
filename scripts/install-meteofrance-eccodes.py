#!/usr/bin/env python3
"""Installer au build les definitions ecCodes officielles Météo-France.

La source est la ressource « Définition des gribs sauf les modèles de vague
en grib2 » du jeu de données public Météo-France sur data.gouv.fr.
Aucun GRIB2 de prévision n'est téléchargé ici.
"""
import argparse
import hashlib
import io
import json
import shutil
import tarfile
import tempfile
import time
import unicodedata
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse
from urllib.request import Request, urlopen

DATASET_ID = "67eb8c7c30daf1fd537258de"
DATASET_API = f"https://www.data.gouv.fr/api/1/datasets/{DATASET_ID}/"
RACINE = Path(__file__).resolve().parents[1]
DESTINATION = RACINE / ".meteo-eccodes" / "definitions"
VENDOR = RACINE / "vendor" / "meteofrance" / "eccodes-definitions.tar.gz"
DEFINITIONS_VERSIONNEES = RACINE / "vendor" / "meteofrance" / "definitions"
MANIFESTE = RACINE / "vendor" / "meteofrance" / "manifest.json"
MAX_ARCHIVE = 4 * 1024 * 1024
MAX_UNCOMPRESSED = 50 * 1024 * 1024
MAX_FILES = 10000


def telecharger(url, maximum):
    parsed = urlparse(url)
    if parsed.scheme != "https" or not (
        parsed.hostname == "data.gouv.fr" or
        (parsed.hostname or "").endswith(".data.gouv.fr")
    ):
        raise ValueError("Source externe non autorisée : " + parsed.netloc)
    demande = Request(url, headers={
        "Accept": "application/json, application/gzip, application/octet-stream",
        "User-Agent": "Meteo-La-Rochelle/1.0 (definitions-ecCodes)"
    })
    # Deux nouvelles tentatives sur une panne réseau temporaire de data.gouv.
    for tentative in range(3):
        try:
            with urlopen(demande, timeout=45) as reponse:
                fin = urlparse(reponse.geturl())
                if fin.scheme != "https" or not (
                    fin.hostname == "data.gouv.fr" or
                    (fin.hostname or "").endswith(".data.gouv.fr")
                ):
                    raise ValueError("Redirection du téléchargement non autorisée")
                corps = reponse.read(maximum + 1)
            if len(corps) > maximum or not corps:
                raise ValueError("Réponse trop volumineuse ou vide")
            return corps
        except (OSError, TimeoutError) as erreur:
            if tentative == 2:
                raise
            print("Ressource data.gouv indisponible, nouvelle tentative :", erreur)
            time.sleep(2 ** tentative)


def nettoyer(s):
    return "".join(
        c for c in unicodedata.normalize("NFKD", str(s)).lower()
        if not unicodedata.combining(c)
    )


def choisir_ressource(resources):
    candidats = []
    for ressource in resources:
        titre = nettoyer(ressource.get("title", ""))
        if "grib" in titre and "sauf" in titre and "vague" in titre:
            candidats.append(ressource)
    if not candidats:
        raise ValueError(
            "Ressource GRIB2 hors modèles de vagues introuvable : "
            "ne pas installer les tables GRIB de vagues"
        )
    candidats.sort(key=lambda r: str(r.get("last_modified") or ""), reverse=True)
    return candidats[0]


def extraire(archive, repertoire):
    if not archive.startswith(b"\x1f\x8b"):
        raise ValueError("L'archive officielle n'est pas un tar.gz")
    total = 0
    nombre = 0
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        for membre in tar:
            chemin = PurePosixPath(membre.name)
            if chemin.is_absolute() or ".." in chemin.parts:
                raise ValueError("Chemin dangereux dans l'archive")
            if membre.isdir():
                continue
            if not membre.isfile():
                raise ValueError("Type de fichier interdit dans les définitions")
            total += membre.size
            nombre += 1
            if membre.size > MAX_UNCOMPRESSED or total > MAX_UNCOMPRESSED or nombre > MAX_FILES:
                raise ValueError("Définitions trop volumineuses")
            dest = repertoire.joinpath(*chemin.parts)
            dest.parent.mkdir(parents=True, exist_ok=True)
            source = tar.extractfile(membre)
            if source is None:
                raise ValueError("Entrée tar impossible à lire")
            with source, dest.open("wb") as sortie:
                shutil.copyfileobj(source, sortie, length=1024 * 1024)

    # La racine transmise à ECCODES_DEFINITION_PATH contient « grib2/ ».
    candidates = [
        p.parent for p in repertoire.rglob("grib2")
        if p.is_dir() and any(f.is_file() for f in p.rglob("*"))
    ]
    if not candidates:
        raise ValueError("Archive sans arborescence ecCodes grib2/")
    candidates.sort(key=lambda p: (len(p.parts), str(p)))
    return candidates[0], nombre


def empreinte_definitions(racine):
    """SHA256 reproductible des noms et contenus des fichiers officiels extraits."""
    fichiers = sorted(p for p in racine.rglob("*") if p.is_file())
    if not fichiers or len(fichiers) > MAX_FILES:
        raise ValueError("Nombre de fichiers de définition invalide")
    sha = hashlib.sha256()
    for fichier in fichiers:
        relative = fichier.relative_to(racine).as_posix().encode("utf-8")
        contenu = fichier.read_bytes()
        sha.update(len(relative).to_bytes(4, "big"))
        sha.update(relative)
        sha.update(len(contenu).to_bytes(8, "big"))
        sha.update(contenu)
    return sha.hexdigest(), len(fichiers)


def actualiser_archive_versionnee():
    """Téléchargement ponctuel via GitHub Actions : archive + 106 fichiers extraits."""
    metadonnees = json.loads(telecharger(DATASET_API, 1024 * 1024))
    ressource = choisir_ressource(metadonnees.get("resources", []))
    rid = ressource.get("id")
    if not rid:
        raise ValueError("Ressource sans ID")
    url = "https://www.data.gouv.fr/api/1/datasets/r/" + rid
    archive = telecharger(url, MAX_ARCHIVE)
    with tempfile.TemporaryDirectory(prefix="verification-grib2-") as temporaire:
        source, nombre = extraire(archive, Path(temporaire))
        fichiers_sha, nombre_extraits = empreinte_definitions(source)
        VENDOR.parent.mkdir(parents=True, exist_ok=True)
        if DEFINITIONS_VERSIONNEES.exists():
            shutil.rmtree(DEFINITIONS_VERSIONNEES)
        shutil.copytree(source, DEFINITIONS_VERSIONNEES)
    sha = hashlib.sha256(archive).hexdigest()
    infos = {
        "source": url,
        "jeu_de_donnees": "https://www.data.gouv.fr/datasets/" + DATASET_ID,
        "titre": ressource.get("title"),
        "ressource_id": rid,
        "date_publication": ressource.get("last_modified"),
        "sha256": sha,
        "sha256_definitions": fichiers_sha,
        "fichiers_extraits": nombre_extraits,
        "licence": "Licence Ouverte / Open Licence version 2.0",
        "producteur": "Météo-France"
    }
    VENDOR.write_bytes(archive)
    MANIFESTE.write_text(
        json.dumps(infos, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print("Fichiers ecCodes officiels copiés dans le dépôt :", DEFINITIONS_VERSIONNEES, flush=True)
    print("Archive conservée :", VENDOR, "SHA256 :", sha, flush=True)
    print("Dossiers vérifiés :", nombre_extraits, "fichiers / archive :", nombre, flush=True)


def installer_localement():
    """Build Render : valider les fichiers Git, sans ouvrir le tar.gz ni le réseau."""
    if not MANIFESTE.is_file() or not (DEFINITIONS_VERSIONNEES / "grib2").is_dir():
        raise FileNotFoundError(
            "Définitions ecCodes versionnées absentes. Exécuter le workflow "
            "'Copier definitions ecCodes Meteo-France' sur Test_fonction."
        )
    manifest = json.loads(MANIFESTE.read_text(encoding="utf-8"))
    if not all(x in nettoyer(manifest.get("titre", ""))
               for x in ("grib", "sauf", "vague")):
        raise ValueError("Manifest non conforme aux définitions hors vagues")
    fichiers_sha, nombre = empreinte_definitions(DEFINITIONS_VERSIONNEES)
    if manifest.get("sha256_definitions") != fichiers_sha:
        raise ValueError("Les fichiers ecCodes extraits ont changé : SHA256 incorrect")
    if manifest.get("fichiers_extraits") != nombre:
        raise ValueError("Nombre de fichiers ecCodes incorrect")
    print("Définitions ecCodes Météo-France disponibles directement dans Git :", DEFINITIONS_VERSIONNEES, flush=True)
    print("AUCUN téléchargement ni décompression ; SHA256 des fichiers vérifié :", fichiers_sha, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--update-vendor", action="store_true",
        help="Télécharger une fois les définitions officielles et versionner les fichiers extraits"
    )
    args = parser.parse_args()
    if args.update_vendor:
        actualiser_archive_versionnee()
    else:
        installer_localement()
