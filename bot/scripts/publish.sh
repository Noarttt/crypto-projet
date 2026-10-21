#!/usr/bin/env bash
# Publie le bilan et le journal compressé sur la branche « bot-data » du dépôt GitHub.
# Nécessite une clé de déploiement avec accès en écriture (voir README).
set -euo pipefail

BOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$BOT_DIR/.." && pwd)"
DATA_DIR="${DATA_DIR:-$BOT_DIR/data}"
PUB_DIR="$DATA_DIR/publish"
BRANCH="bot-data"

cd "$BOT_DIR"
node scripts/summary.js

REMOTE_URL="$(git -C "$REPO_DIR" remote get-url origin)"
if [ ! -d "$PUB_DIR/.git" ]; then
  if git ls-remote --exit-code --heads "$REMOTE_URL" "$BRANCH" >/dev/null 2>&1; then
    git clone --quiet --depth 1 --branch "$BRANCH" --single-branch "$REMOTE_URL" "$PUB_DIR"
  else
    mkdir -p "$PUB_DIR"
    git -C "$PUB_DIR" init --quiet
    git -C "$PUB_DIR" checkout --quiet --orphan "$BRANCH"
    git -C "$PUB_DIR" remote add origin "$REMOTE_URL"
  fi
fi

git -C "$PUB_DIR" config user.name "defi-bot"
git -C "$PUB_DIR" config user.email "defi-bot@users.noreply.github.com"
git -C "$PUB_DIR" pull --quiet --ff-only origin "$BRANCH" 2>/dev/null || true

mkdir -p "$PUB_DIR/summary" "$PUB_DIR/journal"
cp "$DATA_DIR/summary/latest.md" "$DATA_DIR/summary/latest.json" "$PUB_DIR/summary/"
cp "$DATA_DIR/summary/latest.json" "$PUB_DIR/summary/$(date -u +%F).json"
for f in "$DATA_DIR"/journal/*.jsonl; do
  [ -e "$f" ] || continue
  gzip -c "$f" > "$PUB_DIR/journal/$(basename "$f").gz"
done

cat > "$PUB_DIR/README.md" <<'EOF'
# Données du bot DeFi (phase 1 – enregistrement)

Branche publiée automatiquement par le bot. Aucune clé ni donnée de wallet ici.

- `summary/latest.md` : dernier bilan lisible
- `summary/latest.json` et `summary/AAAA-MM-JJ.json` : bilans chiffrés
- `journal/*.jsonl.gz` : journal brut, une ligne JSON par événement
EOF

git -C "$PUB_DIR" add -A
if git -C "$PUB_DIR" diff --cached --quiet; then
  echo "Rien de nouveau à publier."
  exit 0
fi
git -C "$PUB_DIR" commit --quiet -m "Données du bot $(date -u +'%F %H:%M') UTC"
git -C "$PUB_DIR" push --quiet origin "$BRANCH"
echo "Publié sur la branche $BRANCH."
