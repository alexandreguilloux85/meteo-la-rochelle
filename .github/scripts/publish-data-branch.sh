#!/usr/bin/env bash
set -euo pipefail

branch="${1:?Usage: publish-data-branch.sh BRANCH SOURCE_DIRECTORY}"
source_dir="${2:?Usage: publish-data-branch.sh BRANCH SOURCE_DIRECTORY}"

if [[ ! -d "$source_dir" ]]; then
  echo "Répertoire de données introuvable : $source_dir" >&2
  exit 1
fi

source_dir="$(cd "$source_dir" && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

# Sauvegarder les données avant de changer de branche.
cp -a "$source_dir"/. "$tmp_dir"/

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  git fetch origin "$branch"
  git checkout -B "$branch" FETCH_HEAD
else
  git checkout --orphan "$branch"
fi

# La branche ne contient que les données produites par ce workflow.
git rm -rf --ignore-unmatch .
git clean -fdx
cp -a "$tmp_dir"/. .
git add -A

if git diff --cached --quiet; then
  echo "Aucune modification des données à publier sur $branch."
  exit 0
fi

git commit -m "Update $branch data"
git push origin "HEAD:$branch"
echo "Données publiées sur la branche $branch."
