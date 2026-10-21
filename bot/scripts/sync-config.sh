#!/usr/bin/env bash
# Récupère la dernière version du dépôt (config.json validée comprise). Le bot relit config.json toute seule.
# Les changements de code ne sont pris en compte qu'au redémarrage du service.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
git -C "$REPO_DIR" pull --quiet --ff-only
